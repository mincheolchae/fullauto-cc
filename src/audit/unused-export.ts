/**
 * Unused-export check (TS/JS only): every NEW exported symbol in an added or
 * modified production file must be referenced by some other production file.
 *
 *  - React component rule: a PascalCase export from `.tsx`/`.jsx` must be
 *    USED by production code — rendered (`<Name`), created
 *    (`createElement(Name`), called, passed as a value (`component={Name}`,
 *    `{ element: Name }`, `withX(Name)`) or re-exported from a framework
 *    entrypoint (`app/page.tsx`). An `import { Name }` that is never used
 *    again in that file is not wiring: it is the cheapest way to satisfy a
 *    grep, so it is BLOCK `orphan-code` "imported but never rendered".
 *  - Any other export that is only imported, never used → WARN
 *    `unused-export`; unreferenced → WARN; constants (UPPER_SNAKE), schemas
 *    (`*Schema`, zod/yup/valibot initializers) and enums → INFO, since they
 *    are routinely exported for tests / types and are never "behavior".
 *  - A symbol that its own file uses (helper called by another export) is
 *    not reported: exporting it is at most a style issue.
 *  - `type` / `interface` exports and framework-consumed names are skipped.
 *
 * One `git grep` per task (every new symbol of every file), not one per file.
 */
import { extensionOf, isEntrypoint, isGeneratedPath, isJsLike, isTestFile, normalizePath } from './patterns.js';
import { escapeRegExp, findFilesMentioningAny, findModuleReferences, readCached, sanitizeForUse, usedBeyondImport, type ContentCache } from './refs.js';
import { sanitizeSource } from './test-integrity.js';
import type { AuditFinding, AuditSeverity, TaskClassification, TaskDiff } from './types.js';

/** Names consumed by frameworks/bundlers rather than by project imports. */
const FRAMEWORK_EXPORTS = new Set([
  'default', 'config', 'metadata', 'generateMetadata', 'generateStaticParams', 'generateViewport', 'viewport',
  'dynamic', 'dynamicParams', 'revalidate', 'runtime', 'preferredRegion', 'maxDuration', 'fetchCache',
  'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'getInitialProps',
  'loader', 'clientLoader', 'action', 'clientAction', 'meta', 'links', 'handle', 'headers', 'shouldRevalidate',
  'ErrorBoundary', 'HydrateFallback',
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS',
  'handler', 'load', 'prerender', 'ssr', 'csr', 'trailingSlash', 'middleware', 'register', 'onRequest',
  'up', 'down', 'schema', 'plugin', 'setup', 'main', 'activate', 'deactivate',
]);

const CONTENT_LIMIT = 512 * 1024;

export interface ExportedSymbol {
  name: string;
  /** `type` | `interface` are extracted but flagged so callers can skip them. */
  typeOnly: boolean;
  line: number;
}

/** Extract exported symbol names from JS/TS source text (regex-level, comment-naive). */
export function extractExports(content: string): ExportedSymbol[] {
  const out: ExportedSymbol[] = [];
  const lineOf = (index: number) => content.slice(0, index).split('\n').length;
  const push = (name: string, typeOnly: boolean, index: number) => {
    if (!name) return;
    out.push({ name, typeOnly, line: lineOf(index) });
  };

  for (const m of content.matchAll(
    /^\s*export\s+(?:declare\s+)?(?:(async)\s+)?(?:(abstract)\s+)?(function\*?|const|let|var|class|enum|type|interface|namespace)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    push(m[4], m[3] === 'type' || m[3] === 'interface', m.index ?? 0);
  }
  for (const m of content.matchAll(/^\s*export\s+(?:const|let|var)\s+\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop()?.trim().split(/[=\s]/)[0] ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(name)) push(name, false, m.index ?? 0);
    }
  }
  for (const m of content.matchAll(/^\s*export\s+(type\s+)?\{([^}]*)\}/gm)) {
    const groupTypeOnly = !!m[1];
    for (const part of m[2].split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const typeOnly = groupTypeOnly || /^type\s/.test(trimmed);
      const seg = trimmed.replace(/^type\s+/, '');
      const name = (seg.split(/\s+as\s+/).pop() ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) push(name, typeOnly, m.index ?? 0);
    }
  }
  for (const m of content.matchAll(/^\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    push(m[1], false, m.index ?? 0);
    push('default', false, m.index ?? 0);
  }
  if (/^\s*export\s+default\b/m.test(content) && !out.some((s) => s.name === 'default')) {
    const m = /^\s*export\s+default\b/m.exec(content);
    push('default', false, m?.index ?? 0);
  }
  // CommonJS
  for (const m of content.matchAll(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm)) push(m[1], false, m.index ?? 0);
  for (const m of content.matchAll(/^\s*module\.exports\s*=\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) push(name, false, m.index ?? 0);
    }
  }
  return out;
}

export function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

const SCHEMA_INIT_RE = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:z|zod|yup|Yup|v|Joi|joi|t|S|Schema|Type)\.[A-Za-z]/gm;

/**
 * Exports that are data, not behavior: UPPER_SNAKE constants, `*Schema` /
 * zod-style declarations and enums. Unused ones are INFO, never WARN.
 */
export function isDataExport(name: string, content: string): boolean {
  if (/^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1) return true;
  if (/(Schema|Shape|Enum)$/.test(name)) return true;
  if (new RegExp(`^\\s*export\\s+(?:const\\s+)?enum\\s+${escapeRegExp(name)}\\b`, 'm').test(content)) return true;
  for (const m of content.matchAll(SCHEMA_INIT_RE)) if (m[1] === name) return true;
  return false;
}

const EXPORT_LIST_RE = /^\s*export\s+(?:type\s+)?\{[^}]*\}(?:\s*from\s*['"][^'"]*['"])?\s*;?/gm;
const CJS_EXPORT_RE = /^\s*module\.exports\s*=\s*\{[^}]*\}\s*;?/gm;
const EXPORT_DEFAULT_ID_RE = /^\s*export\s+default\s+[A-Za-z_$][\w$]*\s*;?\s*$/gm;

/**
 * Does `content` (the exporting file itself) use `name` beyond declaring
 * and exporting it? Export lists are stripped first so `const a = 1;
 * export { a }` is not mistaken for a use.
 */
export function usedWithinOwnFile(content: string, name: string, path: string): boolean {
  const body = sanitizeSource(content, path).replace(EXPORT_LIST_RE, '').replace(CJS_EXPORT_RE, '').replace(EXPORT_DEFAULT_ID_RE, '');
  const re = new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g');
  let n = 0;
  for (const _ of body.matchAll(re)) if (++n >= 2) return true;
  return false;
}

function importsSymbol(content: string, name: string): boolean {
  const n = escapeRegExp(name);
  return (
    new RegExp(`\\bimport\\s+(?:type\\s+)?(?:${n}\\b|\\*\\s+as\\s+${n}\\b|[^;]{0,400}?\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from)`).test(content) ||
    new RegExp(`\\{[^}]*\\b${n}\\b[^}]*\\}\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(`).test(content) ||
    new RegExp(`\\bconst\\s+${n}\\s*=\\s*(?:await\\s+)?(?:require|import)\\s*\\(`).test(content) ||
    new RegExp(`\\b${n}\\s*=\\s*(?:React\\.)?lazy\\s*\\(`).test(content) ||
    new RegExp(`\\bexport\\s+\\{[^}]*\\b${n}\\b[^}]*\\}\\s*from`).test(content)
  );
}

function rendersComponent(content: string, name: string): boolean {
  const n = escapeRegExp(name);
  return (
    new RegExp(`<(?:[\\w$]+\\.)*${n}(?:[\\s/>.]|$)`, 'm').test(content) ||
    new RegExp(`(?:React\\.)?createElement\\(\\s*${n}\\b`).test(content) ||
    new RegExp(`\\b(?:component|element|Component)\\s*[:=]\\s*${n}\\b`).test(content)
  );
}

/** `export { Foo } from`, `export { Foo as default }`, `export default Foo` — a barrel or a framework page forwarding the symbol. */
function reExportsSymbol(content: string, name: string): boolean {
  const n = escapeRegExp(name);
  return (
    new RegExp(`\\bexport\\s+\\{[^}]*\\b${n}\\b[^}]*\\}`).test(content) ||
    new RegExp(`\\bexport\\s+default\\s+${n}\\s*;?\\s*$`, 'm').test(content)
  );
}

/**
 * Is a PascalCase component actually USED in `content`, beyond being
 * imported? Any occurrence outside import / require / re-export statements
 * counts (render, createElement, call, prop value, route table entry, HOC
 * argument); a re-export counts only from a framework entrypoint, whose
 * default export the framework itself renders.
 */
export function usesComponent(content: string, name: string, consumerPath: string): boolean {
  const clean = sanitizeForUse(content, consumerPath);
  if (rendersComponent(clean, name)) return true;
  if (usedBeyondImport(clean.replace(EXPORT_LIST_RE, '').replace(EXPORT_DEFAULT_ID_RE, ''), name)) return true;
  return isEntrypoint(consumerPath) && reExportsSymbol(clean, name);
}

interface Candidate {
  file: TaskDiff['files'][number];
  path: string;
  newSymbols: ExportedSymbol[];
}

export async function checkUnusedExports(
  diff: TaskDiff,
  projectDir: string,
  cls?: Pick<TaskClassification, 'wiredBy'>
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const cache: ContentCache = new Map();

  // Pass 1: collect every file's NEW exported symbols.
  const candidates: Candidate[] = [];
  for (const file of diff.files) {
    if (file.kind === 'deleted' || !file.isCode || file.isTest || !isJsLike(file.path)) continue;
    const path = normalizePath(file.path);
    if (isEntrypoint(path) || isGeneratedPath(path) || /\.d\.ts$/.test(path)) continue;
    if (file.after === undefined || file.after.length > CONTENT_LIMIT) continue;
    if (file.kind === 'modified' && file.before === undefined) continue; // cannot tell what is new

    const beforeNames = new Set(file.kind === 'added' ? [] : extractExports(file.before ?? '').map((s) => s.name));
    const newSymbols = extractExports(file.after).filter((s) => !s.typeOnly && !beforeNames.has(s.name));
    if (newSymbols.length === 0) continue;
    cache.set(path, file.after);
    candidates.push({ file, path, newSymbols });
  }
  if (candidates.length === 0) return findings;

  // ONE git grep for every new symbol of every file in the task; each file
  // drops itself from its own symbols' hits below.
  const allNames = [...new Set(candidates.flatMap((c) => c.newSymbols.map((s) => s.name)).filter((n) => n !== 'default' && !FRAMEWORK_EXPORTS.has(n)))];
  const hitsByName = await findFilesMentioningAny(projectDir, allNames, { word: true, codeOnly: true }, cache);

  for (const { file, path, newSymbols } of candidates) {
    const ext = extensionOf(path);
    const componentFile = ext === 'tsx' || ext === 'jsx';
    let moduleRefs: Awaited<ReturnType<typeof findModuleReferences>> | undefined;
    const seen = new Set<string>();
    const fileUnused: Array<{ sym: ExportedSymbol; testOnly: boolean; data: boolean }> = [];
    const importOnly: Array<{ sym: ExportedSymbol; importers: string[] }> = [];

    for (const sym of newSymbols) {
      if (seen.has(sym.name)) continue;
      seen.add(sym.name);
      if (FRAMEWORK_EXPORTS.has(sym.name) && sym.name !== 'default') continue;

      if (sym.name === 'default') {
        moduleRefs ??= await findModuleReferences(projectDir, path, cache);
        if (moduleRefs.production.length > 0) continue;
        if (file.kind === 'added') continue; // the orphan check owns module-level wiring of added files
        // `export default function Foo` also registered `Foo` at the same line: name the finding after it.
        const named = newSymbols.find((o) => o.name !== 'default' && o.line === sym.line);
        findings.push(unusedFinding(path, named ?? sym, componentFile, cls?.wiredBy, 'default export'));
        continue;
      }

      const allHits = (hitsByName.get(sym.name) ?? []).filter((h) => h !== path);
      const hits = allHits.filter((h) => !isTestFile(h));
      const testHits = allHits.filter((h) => isTestFile(h));

      if (componentFile && isPascalCase(sym.name)) {
        let wired = false;
        const importers: string[] = [];
        for (const hit of hits) {
          const content = await readCached(projectDir, hit, cache);
          if (!content) continue;
          if (usesComponent(content, sym.name, hit)) {
            wired = true;
            break;
          }
          if (importsSymbol(content, sym.name)) importers.push(hit);
        }
        if (!wired && importers.length === 0) {
          moduleRefs ??= await findModuleReferences(projectDir, path, cache);
          // A file-level production import (`import * as C from './Foo'` + `<C.Foo/>`, matched by the word grep) still counts.
          if (moduleRefs.production.length > 0 && hits.length > 0) wired = true;
        }
        // A component rendered by another component in the same file (e.g. `PanelHeader` inside `Panel`) is wired through it.
        if (!wired && usedWithinOwnFile(file.after!, sym.name, path)) wired = true;
        if (wired) continue;
        findings.push(importers.length > 0 ? importedNeverRenderedFinding(path, sym, importers, cls?.wiredBy) : unusedFinding(path, sym, true, cls?.wiredBy, 'component'));
        continue;
      }

      if (hits.length > 0) {
        // Mentioned somewhere — but is it USED there? `import { tax } from './pricing'`
        // with no further `tax` is a grep-satisfying no-op, not a consumer; a
        // mention inside a comment or string is not a reference at all.
        let used = false;
        const importers: string[] = [];
        for (const hit of hits) {
          const content = await readCached(projectDir, hit, cache);
          if (!content) continue;
          const clean = sanitizeForUse(content, hit);
          if (usedBeyondImport(clean.replace(EXPORT_LIST_RE, '').replace(EXPORT_DEFAULT_ID_RE, ''), sym.name) || (isEntrypoint(hit) && reExportsSymbol(clean, sym.name))) {
            used = true;
            break;
          }
          if (importsSymbol(clean, sym.name)) importers.push(hit);
        }
        if (used) continue;
        if (usedWithinOwnFile(file.after!, sym.name, path)) continue;
        if (importers.length > 0) {
          importOnly.push({ sym, importers });
          continue;
        }
        // Only comment / string mentions: fall through as unreferenced.
      }
      if (usedWithinOwnFile(file.after!, sym.name, path)) continue;
      fileUnused.push({ sym, testOnly: testHits.length > 0, data: isDataExport(sym.name, file.after!) });
    }

    for (const { sym, importers } of importOnly) {
      findings.push({
        check: 'unused-export',
        severity: 'warn',
        path,
        line: sym.line,
        message: `export ${sym.name} in ${path} is imported by ${importers.slice(0, 3).join(', ')} but never used there (the import is the only occurrence) — call/use it, or drop the import and the export if it is internal`,
      });
    }

    const behavior = fileUnused.filter((u) => !u.data);
    const data = fileUnused.filter((u) => u.data);
    if (behavior.length > MAX_PER_FILE) {
      findings.push({
        check: 'unused-export',
        severity: 'warn',
        path,
        line: behavior[0].sym.line,
        message: `${behavior.length} new exports in ${path} are not referenced by any other production file (${behavior
          .slice(0, 8)
          .map((u) => u.sym.name)
          .join(', ')}${behavior.length > 8 ? ', ...' : ''}) — wire them in or drop the exports if they are internal`,
      });
    } else {
      for (const u of behavior) findings.push(unusedFinding(path, u.sym, false, cls?.wiredBy, u.testOnly ? 'test-only export' : 'export'));
    }
    if (data.length > 0) {
      findings.push({
        check: 'unused-export',
        severity: 'info',
        path,
        line: data[0].sym.line,
        message: `${data.length} new constant/schema/enum export(s) in ${path} not referenced by other production code (${data
          .slice(0, 8)
          .map((u) => u.sym.name)
          .join(', ')}${data.length > 8 ? ', ...' : ''})`,
      });
    }
  }

  return findings;
}

/** Above this many unused exports in one file, collapse into a single finding to keep the prompt readable. */
const MAX_PER_FILE = 5;

function importedNeverRenderedFinding(path: string, sym: ExportedSymbol, importers: string[], wiredBy: string | undefined): AuditFinding {
  const where = importers.slice(0, 3).join(', ');
  return {
    check: 'orphan-code',
    severity: wiredBy ? 'info' : 'block',
    path,
    line: sym.line,
    message: wiredBy
      ? `component ${sym.name} in ${path} is imported by ${where} but not rendered yet (wiring deferred to ${wiredBy})`
      : `component ${sym.name} in ${path} is imported by ${where} but never rendered (<${sym.name}), created, called or passed as a component there — an unused import is not wiring; render it from the page/route/parent that needs it`,
  };
}

function unusedFinding(
  path: string,
  sym: ExportedSymbol,
  component: boolean,
  wiredBy: string | undefined,
  what: string
): AuditFinding {
  if (component) {
    const severity: AuditSeverity = wiredBy ? 'info' : 'block';
    return {
      check: 'orphan-code',
      severity,
      path,
      line: sym.line,
      message: wiredBy
        ? `${what} ${sym.name} in ${path} is not rendered or imported by production code yet (wiring deferred to ${wiredBy})`
        : `${what} ${sym.name} in ${path} is exported but never rendered (<${sym.name}) or imported by production code — render it from the page/route/parent that needs it`,
    };
  }
  return {
    check: 'unused-export',
    severity: 'warn',
    path,
    line: sym.line,
    message:
      what === 'test-only export'
        ? `export ${sym.name} in ${path} is only referenced from tests — wire it into production code (the behavior it implements is not reachable), or drop the export if it is a test helper`
        : `${what} ${sym.name} in ${path} is not referenced by any other production file — use it, or drop the export if it is internal`,
  };
}
