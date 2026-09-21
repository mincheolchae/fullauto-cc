/**
 * FULLAUTO_WIRING manifest: the implementer's own claims about where each
 * new artifact is consumed. Parsed from the LAST block in stdout:
 *
 *   FULLAUTO_WIRING:
 *   - src/components/Foo.tsx -> src/app/page.tsx:12
 *   - src/lib/pricing.ts#calculatePrice -> src/routes/checkout.ts
 *   - src/lib/legacy.ts -> (entrypoint: next.js route file)
 *
 * Each claim is verified against the working tree: the consumer must exist
 * and must mention the artifact's basename (sans extension) or the symbol.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { basenameSansExt, extensionOf, isEntrypoint, isTestFile, normalizePath, stripExt } from './patterns.js';
import { escapeRegExp, fileReferencesModule, readCapped } from './refs.js';

/**
 * Languages where a class nothing names explicitly is still wired by the
 * framework (annotation / DI container discovery). A note like
 * `(entrypoint: Spring @Service, component-scanned)` on such a file is
 * accepted as INFO even though no entrypoint PATH pattern matches — the
 * orphan check already only WARNs there and asks for exactly this note.
 */
const DISCOVERY_WIRED_EXTENSIONS = new Set(['java', 'kt', 'cs', 'swift', 'php']);
const DISCOVERY_NOTE_RE = /\b(?:annotation|annotated|component[- ]?scan|autowir|di\b|dependency[- ]injection|container|reflection|discover|attribute|service provider|@\w+)/i;

/**
 * Consumer paths come from untrusted subagent stdout. A claim like
 * `- x -> ../../../../etc/hosts` must never make the audit read outside
 * `projectDir`: reject absolute paths, `..` escapes and symlinks that
 * resolve elsewhere. Returns the safe absolute path, or undefined.
 */
function resolveInsideProject(projectDir: string, rel: string): string | undefined {
  if (!rel || rel.includes('\0')) return undefined;
  const root = resolve(projectDir);
  // An absolute path is fine when it points inside the project (subagents often print them).
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const relToRoot = relative(root, abs);
  if (!relToRoot || relToRoot.startsWith('..') || isAbsolute(relToRoot)) return undefined;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs); // throws when the path does not exist — the caller reports that separately
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return undefined;
  } catch {
    /* missing file: lexical containment already holds */
  }
  return abs;
}
import type { AuditFinding, TaskClassification, TaskDiff, WiringClaim } from './types.js';

const HEADER_RE = /^\s*(?:`{0,3})?FULLAUTO_WIRING:?\s*(?:`{0,3})?\s*$/;

/** True when stdout contains a FULLAUTO_WIRING header (even if the block is empty). */
export function hasWiringBlock(stdout: string): boolean {
  return (stdout ?? '').split('\n').some((l) => HEADER_RE.test(l));
}

function cleanToken(s: string): string {
  return s.trim().replace(/^[`'"]+|[`'",;]+$/g, '').trim();
}

export function parseWiringClaims(stdout: string): WiringClaim[] {
  const lines = (stdout ?? '').replace(/\r/g, '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (HEADER_RE.test(lines[i])) start = i;
  if (start < 0) return [];

  const claims: WiringClaim[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      // allow a single blank line inside the block, stop at a second one
      if (i + 1 < lines.length && /^\s*[-*]\s+/.test(lines[i + 1])) continue;
      break;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet) break;
    const claim = parseClaimLine(bullet[1]);
    if (claim) claims.push(claim);
  }
  return claims;
}

export function parseClaimLine(text: string): WiringClaim | undefined {
  const m = /^(.*?)\s*(?:->|→|=>)\s*(.*)$/.exec(text.trim());
  if (!m) return undefined;
  const left = cleanToken(m[1]);
  const right = cleanToken(m[2]);
  if (!left) return undefined;

  const hash = left.indexOf('#');
  const artifactPath = normalizePath(hash >= 0 ? left.slice(0, hash) : left);
  const symbol = hash >= 0 ? left.slice(hash + 1).trim() || undefined : undefined;
  const claim: WiringClaim = { artifactPath };
  if (symbol) claim.symbol = symbol;

  const note = /^\((.*)\)$/.exec(right);
  if (note || !right) {
    claim.note = note ? note[1].trim() : '';
    return claim;
  }
  // A model sometimes bundles two consumers for the same artifact into one
  // line ("package.json:6 (\"main\") and package.json:7 (\"exports\")" —
  // observed live, real subagent, wiring a module through both package.json
  // fields at once). We only model ONE consumer per claim; without this,
  // the trailing-note regex below happily swallows the whole compound
  // string as a single "path", which never resolves and produces a false
  // orphan BLOCK on correctly-wired code. Split on a TOP-LEVEL " and "
  // (paren-depth 0, so a legitimate note like "(imported and used in the
  // header)" is left alone) and verify only the first clause — confirming
  // one real consumer is enough; the rest is folded into the note so it's
  // still visible to a human reading the finding.
  const andClauses = splitTopLevelAnd(right);
  const firstRight = andClauses[0];
  const extraClauseNote =
    andClauses.length > 1 ? ` (+ also: ${andClauses.slice(1).join(' and ')})` : '';

  // `src/b.ts:12 (via priceOther)` / `src/b.ts — imported at top`: keep the path, remember the remark.
  let target = firstRight;
  const trailing = /^(.*?)\s+(?:\((.*)\)|[—–-]\s+(.*))$/.exec(firstRight);
  if (trailing) {
    target = cleanToken(trailing[1]);
    claim.note = (trailing[2] ?? trailing[3] ?? '').trim();
  }
  const loc = /^(.*?)(?::(\d+))?(?:[:-]\d+)?$/.exec(target);
  if (loc) {
    claim.consumerPath = consumerPathOf(cleanToken(loc[1]));
    if (loc[2]) claim.consumerLine = Number(loc[2]);
  }
  if (extraClauseNote) claim.note = ((claim.note ?? '') + extraClauseNote).trim();
  return claim;
}

/**
 * Split `s` on a top-level " and " — one whose position sits at paren-depth
 * 0 — leaving any " and " that occurs INSIDE a still-open `(...)` (e.g. a
 * note like "imported and used in the header") untouched. Always returns at
 * least one element (`s` itself when there is no top-level split point).
 */
function splitTopLevelAnd(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const re = /\(|\)|\band\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      // Matched the word "and" at depth 0 — only a real separator when
      // surrounded by whitespace (not part of a longer identifier, which
      // \b already guarantees, and not glued to punctuation like "&and").
      const before = s.slice(0, m.index);
      const after = s.slice(m.index + m[0].length);
      if (/\s$/.test(before) && /^\s/.test(after)) {
        parts.push(s.slice(start, m.index).trim());
        start = m.index + m[0].length;
      }
    }
  }
  parts.push(s.slice(start).trim());
  return parts.filter((p) => p.length > 0).length > 0 ? parts.filter((p) => p.length > 0) : [s];
}

/** Like `normalizePath` but keeps a leading `/` (absolute paths are judged against projectDir later). */
function consumerPathOf(p: string): string {
  const abs = p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  const n = normalizePath(p);
  return abs ? `/${n}` : n;
}

export async function checkWiringClaims(
  claims: WiringClaim[],
  diff: TaskDiff,
  projectDir: string,
  cls?: Pick<TaskClassification, 'kind' | 'wiredBy'>,
  stdout?: string
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  for (const claim of claims) {
    // Test files are consumed by the test runner, not production code — the orphan
    // check already exempts them entirely. A model that dutifully lists a test file
    // here (trying to be thorough) has no production consumer to point at, so it
    // improvises `(entrypoint: ...)`; verifying that against the entrypoint pattern
    // list (meant for production files) produces a false BLOCK. Skip verification
    // of any claim about a test file — no BLOCK, no WARN, no INFO needed.
    if (isTestFile(claim.artifactPath)) continue;
    if (!claim.consumerPath) {
      // `(wired by T###)` is informational here (enforced later via pendingWiring);
      // `(entrypoint: ...)` is a verifiable claim: the path must match an entrypoint
      // pattern, otherwise "entrypoint" is just a word that dodges the orphan check.
      const wiredBy = /wired\s+by:?\s+(T\d+)/i.exec(claim.note ?? '');
      if (wiredBy) {
        findings.push({
          check: 'wiring-manifest',
          severity: 'info',
          path: claim.artifactPath,
          message: `${claim.artifactPath} wiring deferred to ${wiredBy[1]} per FULLAUTO_WIRING${cls?.wiredBy && cls.wiredBy !== wiredBy[1] ? ` (task body says \`wired by: ${cls.wiredBy}\`)` : ''}`,
        });
        continue;
      }
      const entry = /^entry[- ]?point\b:?\s*(.*)$/i.exec(claim.note ?? '');
      if (entry && !isEntrypoint(claim.artifactPath)) {
        const discovery = DISCOVERY_WIRED_EXTENSIONS.has(extensionOf(claim.artifactPath)) && DISCOVERY_NOTE_RE.test(entry[1]);
        findings.push({
          check: 'wiring-manifest',
          severity: discovery ? 'info' : 'block',
          path: claim.artifactPath,
          message: discovery
            ? `${claim.artifactPath} declared framework-discovered (${entry[1].trim() || 'no detail'}) — accepted for a DI/annotation-wired language; not verifiable by the audit`
            : `FULLAUTO_WIRING claims ${claim.artifactPath} is an entrypoint (${entry[1].trim() || 'no reason given'}) but ${claim.artifactPath} does not match any entrypoint pattern (Next/Remix/SvelteKit/Nuxt route files, middleware, bin/, scripts/, migrations, convex/, *.config.*, cmd/, main.go, manage.py ...) — wire it from production code, or use \`- wired by: T###\` in the task body if a later task does`,
        });
      }
      continue;
    }
    const abs = resolveInsideProject(projectDir, claim.consumerPath);
    if (!abs) {
      findings.push({
        check: 'wiring-manifest',
        severity: 'block',
        path: claim.artifactPath,
        message: `FULLAUTO_WIRING claims ${claim.artifactPath} -> ${claim.consumerPath} but the consumer path escapes the project — name a repo-relative production file`,
      });
      continue;
    }
    const consumer = normalizePath(relative(resolve(projectDir), abs));
    if (consumer === claim.artifactPath) {
      findings.push({
        check: 'wiring-manifest',
        severity: 'block',
        path: claim.artifactPath,
        message: `FULLAUTO_WIRING claims ${claim.artifactPath} is consumed by itself — name the production file that imports it`,
      });
      continue;
    }
    const content = await readCapped(abs);
    if (content === undefined) {
      findings.push({
        check: 'wiring-manifest',
        severity: 'block',
        path: consumer,
        message: `FULLAUTO_WIRING claims ${claim.artifactPath} -> ${consumer} but ${consumer} does not exist`,
      });
      continue;
    }
    // A claim that names a symbol is about that symbol: the consumer must use it
    // (a barrel may sit between them, so the module import itself is not required).
    // A module-level claim must resolve as a real import of THAT module — a
    // same-basename mention (`'../other/pricing'` for `src/lib/pricing.ts`) is not wiring;
    // a full-path mention is accepted for config-style references (`entry: './src/worker.ts'`).
    let referenced: boolean;
    if (claim.symbol) {
      referenced = new RegExp(`(^|[^\\w$])${escapeRegExp(claim.symbol)}(?![\\w$])`).test(content);
    } else {
      referenced =
        fileReferencesModule(content, consumer, claim.artifactPath, projectDir) ||
        content.includes(stripExt(claim.artifactPath)) ||
        content.includes(claim.artifactPath);
    }
    if (!referenced) {
      findings.push({
        check: 'wiring-manifest',
        severity: 'block',
        path: consumer,
        line: claim.consumerLine,
        message: claim.symbol
          ? `FULLAUTO_WIRING claims ${consumer} consumes ${claim.artifactPath}#${claim.symbol} but ${consumer} does not reference ${claim.symbol}`
          : `FULLAUTO_WIRING claims ${consumer} consumes ${claim.artifactPath} but ${consumer} does not import it (a different module named ${basenameSansExt(claim.artifactPath)} does not count) — import it there, or name the symbol (\`${claim.artifactPath}#<symbol>\`) if it arrives through a barrel`,
      });
    }
  }

  const addedCode = diff.files.filter((f) => f.kind === 'added' && f.isCode && !f.isTest && !isEntrypoint(f.path));
  const declared = stdout !== undefined ? hasWiringBlock(stdout) : claims.length > 0;
  if (cls?.kind === 'impl' && addedCode.length > 0 && !declared && !cls.wiredBy) {
    // No implementer output at all (`fullauto audit` manual mode) ⇒ nothing to demand; INFO only.
    const manual = stdout === undefined || stdout.trim() === '';
    findings.push({
      check: 'wiring-manifest',
      severity: manual ? 'info' : 'warn',
      message: manual
        ? `no implementer output to verify wiring claims for ${addedCode.length} added code file(s) (${addedCode.slice(0, 3).map((f) => f.path).join(', ')}); relying on the orphan check`
        : `no FULLAUTO_WIRING block in the implementer output although ${addedCode.length} code file(s) were added (${addedCode.slice(0, 3).map((f) => f.path).join(', ')}) — end the message with the wiring manifest`,
    });
  }

  return findings;
}
