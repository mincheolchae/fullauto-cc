/**
 * Reference search shared by the orphan and unused-export checks.
 *
 * `findFilesMentioningAny` lists candidate files via `git grep -I -l --untracked`
 * (falls back to a manual walk when git grep is unavailable), and the
 * `*ReferencesModule` helpers confirm that a candidate actually *imports*
 * the artifact — a bare textual mention (comment, string, unrelated
 * identifier) is never enough to count as wiring. `importedBindings` then
 * tells the orphan check WHICH names a consumer imported, so an import that
 * is never used can be told apart from real wiring.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { git } from './git.js';
import {
  CODE_EXTENSIONS,
  GENERATED_DIRS,
  JS_LIKE_EXTENSIONS,
  basenameSansExt,
  extensionOf,
  isCodeFile,
  isTestFile,
  normalizePath,
  stripExt,
} from './patterns.js';

/** Non-code files that can still wire a module (framework/manifests/CI). */
const REFERENCE_ONLY_EXTENSIONS = new Set(['html', 'htm', 'json', 'yml', 'yaml', 'toml']);
/** Template files that reference code by constant / tag name (Rails views, Vue-less HTML templates). */
const TEMPLATE_EXTENSIONS = new Set(['erb', 'haml', 'slim']);

const SEARCH_EXTENSIONS = [...CODE_EXTENSIONS, ...REFERENCE_ONLY_EXTENSIONS, ...TEMPLATE_EXTENSIONS];
const WALK_SKIP = GENERATED_DIRS;
const FILE_READ_LIMIT = 1024 * 1024;

export interface FindOptions {
  /** Interpret `needle` as a fixed string (default) or a regex. */
  regex?: boolean;
  /** `-w`: match only at word boundaries. */
  word?: boolean;
  /** Repo-relative paths to exclude (the artifact itself). */
  exclude?: string[];
  /** Restrict to code files only (default: code + reference-only). */
  codeOnly?: boolean;
  /**
   * When a needle's candidate list is wider than this, a second git grep
   * keeps only files where the needle sits on an import-shaped line
   * (`import|export|require|from|use|mod|include ... needle`). A 1–2 char
   * basename (`a.ts`, `db.ts`) or a generic one (`index`, `utils`, `types`)
   * otherwise matches nearly every file in the repo and each one would be
   * read and parsed. Non-code candidates (json/yaml/html manifests, templates)
   * are always kept: they reference modules by path, not by import.
   * Default 40; 0 disables.
   */
  narrowAbove?: number;
  /**
   * Only these needles may be narrowed (default: all). Callers pass the
   * needles whose wiring is import-shaped (JS/TS module basenames, Rust
   * modules); a Ruby constant, a Vue tag or a Python dotted string is used
   * on ordinary lines and must never be filtered this way.
   */
  narrowNeedles?: Set<string>;
}

const DEFAULT_NARROW_ABOVE = 40;
/** Import-shaped line prefix (any language the audit knows) for the narrowing grep. */
// POSIX ERE (git grep -E): `.` never crosses a line, and `\n` inside brackets would be literal.
const IMPORT_LINE_RE = '(import|export|require|from|use|mod|include|include_once|require_once|require_relative|load).*';

/**
 * Per-file content cache for one audit pass. Files are read at most once
 * no matter how many needles / targets are checked against them.
 */
export type ContentCache = Map<string, string | undefined>;

export async function readCached(projectDir: string, relPath: string, cache?: ContentCache): Promise<string | undefined> {
  if (!cache) return readCapped(join(projectDir, relPath));
  if (cache.has(relPath)) return cache.get(relPath);
  const content = await readCapped(join(projectDir, relPath));
  cache.set(relPath, content);
  return content;
}

function needleMatcher(needle: string, opts: FindOptions): (content: string) => boolean {
  if (opts.regex) {
    const re = new RegExp(opts.word ? `\\b(?:${needle})\\b` : needle);
    return (c) => re.test(c);
  }
  if (opts.word) {
    // git grep -w semantics: the match must not be adjacent to a word character.
    const re = new RegExp(`(^|[^\\w])${escapeRegExp(needle)}(?![\\w])`);
    return (c) => re.test(c);
  }
  return (c) => c.includes(needle);
}

/**
 * Batched form of `findFilesMentioning`: ONE `git grep` for every needle
 * (a single process on large repos instead of one per symbol), then the
 * candidate superset is read once and attributed per needle locally.
 *
 * Output is `-z` (NUL separated, paths verbatim) — without it git octal-
 * escapes non-ASCII paths under the default `core.quotepath=true`, which
 * silently dropped every consumer with a unicode file name.
 */
export async function findFilesMentioningAny(
  projectDir: string,
  needles: string[],
  opts: FindOptions = {},
  cache?: ContentCache
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(needles.filter((n) => n))];
  for (const n of unique) out.set(n, []);
  if (unique.length === 0) return out;

  const exts = opts.codeOnly ? [...CODE_EXTENSIONS] : SEARCH_EXTENSIONS;
  const exclude = new Set((opts.exclude ?? []).map(normalizePath));

  const args = ['grep', '-I', '-l', '-z', '--untracked', '--no-color'];
  if (opts.word) args.push('-w');
  args.push(opts.regex ? '-E' : '-F');
  for (const n of unique) args.push('-e', n);
  args.push('--');
  for (const e of exts) args.push(`*.${e}`);
  for (const x of exclude) args.push(`:(exclude)${x}`);
  // `--untracked` also lists un-ignored build output, vendored deps and the
  // orchestrator's own `.fullauto/state.json` (whose audit findings mention
  // every artifact path and would "wire" an orphan through a JSON manifest match).
  for (const dir of WALK_SKIP) args.push(`:(exclude,glob)**/${dir}/**`, `:(exclude)${dir}/`);

  let candidates: string[];
  const r = await git(projectDir, args);
  const viaGit = r.code === 0 || r.code === 1;
  if (viaGit) {
    candidates = r.stdout
      .split('\0')
      .map((l) => normalizePath(l))
      .filter((l) => l && !exclude.has(l));
  } else {
    candidates = await walkFiles(projectDir, exts, exclude);
  }
  candidates.sort();

  const narrowAbove = opts.narrowAbove ?? DEFAULT_NARROW_ABOVE;
  const narrowable = (n: string) => narrowAbove > 0 && viaGit && (!opts.narrowNeedles || opts.narrowNeedles.has(n));
  if (unique.length === 1 && r.code === 0) {
    // Single needle straight from git: no local re-check needed.
    out.set(unique[0], narrowable(unique[0]) && candidates.length > narrowAbove ? await narrowToImportLines(projectDir, unique[0], candidates, opts, exts) : candidates);
    return out;
  }
  const matchers = unique.map((n) => [n, needleMatcher(n, opts)] as const);
  for (const cand of candidates) {
    const content = await readCached(projectDir, cand, cache);
    if (content === undefined) continue;
    for (const [n, matches] of matchers) if (matches(content)) out.get(n)!.push(cand);
  }
  for (const n of unique) {
    const list = out.get(n)!;
    if (narrowable(n) && list.length > narrowAbove) out.set(n, await narrowToImportLines(projectDir, n, list, opts, exts));
  }
  return out;
}

/**
 * Second-stage filter for a too-wide candidate list: keep the code files in
 * which `needle` appears on an import-shaped line (one `git grep -E`), plus
 * every non-code candidate (manifests / templates reference by path). The
 * word boundary is part of the regex (`-w` on a line-shaped pattern is not
 * reliable: git grep does not shrink a match to satisfy it). When git grep
 * is unavailable the list is returned untouched.
 */
async function narrowToImportLines(projectDir: string, needle: string, candidates: string[], opts: FindOptions, exts: string[]): Promise<string[]> {
  const codeCands = candidates.filter((c) => isCodeFile(c));
  if (codeCands.length === 0) return candidates;
  const body = opts.regex ? `(${needle})` : escapeRegExp(needle);
  const pattern = `${IMPORT_LINE_RE}(^|[^A-Za-z0-9_$])${body}([^A-Za-z0-9_$]|$)`;
  const args = ['grep', '-I', '-l', '-z', '--untracked', '--no-color', '-E', '-e', pattern, '--'];
  for (const e of exts) args.push(`*.${e}`);
  for (const dir of WALK_SKIP) args.push(`:(exclude,glob)**/${dir}/**`, `:(exclude)${dir}/`);
  const r = await git(projectDir, args);
  if (r.code !== 0 && r.code !== 1) return candidates;
  const keep = new Set(r.stdout.split('\0').map((l) => normalizePath(l)).filter(Boolean));
  return candidates.filter((c) => !isCodeFile(c) || keep.has(c));
}

/* ------------------------------------------------ imported bindings (JS) */

export interface ImportedBindings {
  /** Local names bound by the import (`{ a, b as c }` → a, c; default / namespace alias). */
  names: string[];
  /** `import './x'` / `require('./x')` as a bare statement: no binding at all. */
  sideEffectOnly: boolean;
  /** `export { a } from './x'` / `export * from './x'`: forwarded, never used here. */
  reExport: boolean;
  /** `import('./x')` / `import.meta.glob(...)` / `lazy(() => import('./x'))`: the expression IS the use. */
  dynamic: boolean;
}

const STATIC_IMPORT_RE = /\bimport\s+(?:type\s+)?([^'"`;]*?)\s*from\s*['"`]([^'"`\n]+)['"`]/g;
const BARE_IMPORT_RE = /(^|[;\n])\s*import\s*['"`]([^'"`\n]+)['"`]/g;
const REEXPORT_RE = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"`]([^'"`\n]+)['"`]/g;
const REQUIRE_RE = /(?:(?:const|let|var)\s+([^=]+?)\s*=\s*)?(?:await\s+)?require\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"`]([^'"`\n]+)['"`]/g;

function bindingNames(clause: string): string[] {
  const names: string[] = [];
  const c = clause.trim();
  if (!c) return names;
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(c);
  if (ns) names.push(ns[1]);
  const braces = /\{([^}]*)\}/.exec(c);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const seg = part.trim().replace(/^type\s+/, '');
      if (!seg) continue;
      const local = (seg.split(/\s+as\s+/).pop() ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
  }
  const head = c.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
  const def = /^([A-Za-z_$][\w$]*)$/.exec(head);
  if (def) names.push(def[1]);
  return names;
}

/**
 * Which local names does `content` (JS-like, at `importerPath`) bind from
 * `targetPath`? Every import / require statement that resolves to the target
 * contributes; the flags say whether any of them were side-effect-only,
 * re-exports or dynamic. Returns undefined when no statement resolves.
 */
export function importedBindings(content: string, importerPath: string, targetPath: string, projectDir: string): ImportedBindings | undefined {
  const out: ImportedBindings = { names: [], sideEffectOnly: false, reExport: false, dynamic: false };
  let any = false;
  const hits = (spec: string) => specResolvesTo(spec, importerPath, targetPath, projectDir);
  for (const m of content.matchAll(STATIC_IMPORT_RE)) {
    if (!hits(m[2])) continue;
    any = true;
    out.names.push(...bindingNames(m[1]));
  }
  for (const m of content.matchAll(BARE_IMPORT_RE)) {
    if (!hits(m[2])) continue;
    any = true;
    out.sideEffectOnly = true;
  }
  for (const m of content.matchAll(REEXPORT_RE)) {
    if (!hits(m[1])) continue;
    any = true;
    out.reExport = true;
  }
  for (const m of content.matchAll(REQUIRE_RE)) {
    if (!hits(m[2])) continue;
    any = true;
    if (m[1]) out.names.push(...bindingNames(m[1].replace(/:\s*[A-Za-z_$][\w$.<>\[\]|&, ]*/g, '')));
    else out.sideEffectOnly = true;
  }
  for (const m of content.matchAll(DYNAMIC_RE)) {
    if (!hits(m[1])) continue;
    any = true;
    out.dynamic = true;
  }
  for (const g of importGlobsOf(content)) {
    if (globMatchesTarget(g, importerPath, targetPath)) {
      any = true;
      out.dynamic = true;
    }
  }
  if (!any) return undefined;
  out.names = [...new Set(out.names)];
  return out;
}

const IMPORT_STATEMENT_RE = /^[ \t]*import\s+(?:type\s+)?[^;'"`]*?from\s*['"`][^'"`\n]*['"`]\s*;?|^[ \t]*import\s*['"`][^'"`\n]*['"`]\s*;?|^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"`][^'"`\n]*['"`]\s*;?|^[ \t]*(?:const|let|var)\s+[^=]+?=\s*(?:await\s+)?require\s*\([^)]*\)\s*;?/gm;

const LEADING_BLOCK_COMMENT_RE = /^[ \t]*\/\*[\s\S]*?\*\//gm;
const LINE_NOISE_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`|\/\/[^\n]*|\/\*[^\n]*?\*\//g;
const PY_LEADING_DOCSTRING_RE = /^[ \t]*(?:'''[\s\S]*?'''|\"\"\"[\s\S]*?\"\"\")/gm;
const PY_LINE_NOISE_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g;

/**
 * Blank string contents and comments WITHOUT ever letting a quote span
 * lines. `sanitizeSource` (test-integrity) lets a template literal run
 * across lines, which is right for test files but turns a regex literal
 * containing a stray backtick (`/['"\`]/`) into a "template" that swallows
 * the rest of the module — and a use check on that text would call a
 * heavily-used import unused. Here a string is confined to its line, block
 * comments are only stripped when they start a line (doc comments), and
 * newlines are preserved so line numbers survive. Lenient by design: the
 * result feeds checks whose positive outcome BLOCKs.
 */
export function sanitizeForUse(text: string, path: string): string {
  const ext = extensionOf(path);
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  // Keep the quote delimiters so `from ''` still reads as an import statement.
  const blankString = (m: string) => {
    const q = m[0];
    if (q === '`') return blankTemplate(m);
    return q === "'" || q === '"' ? `${q}${m.slice(1, -1).replace(/[^\n]/g, ' ')}${q}` : blank(m);
  };
  if (ext === 'py' || ext === 'rb') return text.replace(PY_LEADING_DOCSTRING_RE, blank).replace(PY_LINE_NOISE_RE, blankString);
  return text.replace(LEADING_BLOCK_COMMENT_RE, blank).replace(LINE_NOISE_RE, blankString);
}

/** Blank a template literal's text but keep its `${...}` interpolations — they are code (`\`${describe(x)}\``). */
function blankTemplate(m: string): string {
  let out = '`';
  let i = 1;
  const end = m.length - 1;
  while (i < end) {
    if (m[i] === '$' && m[i + 1] === '{') {
      let depth = 0;
      let j = i + 1;
      for (; j < end; j++) {
        if (m[j] === '{') depth++;
        else if (m[j] === '}' && --depth === 0) break;
      }
      out += m.slice(i, j + 1);
      i = j + 1;
    } else {
      out += m[i] === '\n' ? '\n' : ' ';
      i++;
    }
  }
  return out + '`';
}

/**
 * `content` with every import / require / re-export statement blanked out
 * (newlines kept) so a name's remaining occurrences are real uses.
 */
export function stripImportStatements(content: string): string {
  return content.replace(IMPORT_STATEMENT_RE, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Does `name` occur in `content` outside of import / require / re-export
 * statements? A `.name` member access counts too (`ns.name` after
 * `import * as ns`) — leniency is the right default for a heuristic whose
 * positive result BLOCKs. Pass content sanitized with `sanitizeForUse`
 * (strings / comments blanked line-locally).
 */
export function usedBeyondImport(content: string, name: string): boolean {
  const body = stripImportStatements(content);
  return new RegExp(`(^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`).test(body);
}

/** Every searchable file under `projectDir` (fallback when git grep is unavailable). */
async function walkFiles(projectDir: string, exts: string[], exclude: Set<string>): Promise<string[]> {
  const extSet = new Set(exts);
  const hits: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    let entries;
    try {
      entries = await readdir(join(projectDir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!WALK_SKIP.has(ent.name)) stack.push(relPath);
        continue;
      }
      if (!ent.isFile() || !extSet.has(extensionOf(relPath)) || exclude.has(relPath)) continue;
      hits.push(relPath);
    }
  }
  return hits;
}

export async function readCapped(absPath: string, limit = FILE_READ_LIMIT): Promise<string | undefined> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > limit) return undefined;
    return await readFile(absPath, 'utf-8');
  } catch {
    return undefined;
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------- JS/TS */

const JS_SPEC_RES: RegExp[] = [
  /\bfrom\s*['"`]([^'"`\n]+)['"`]/g,
  /\bimport\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?['"`]([^'"`\n]+)['"`]/g,
  /\bimport\s+['"`]([^'"`\n]+)['"`]/g,
  /\brequire\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
  /\brequire\.resolve\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g,
];
const GLOB_RE = /import\.meta\.glob(?:Eager)?\s*\(\s*(\[[^\]]*\]|['"`][^'"`\n]+['"`])/g;

/** All module specifiers imported/required by a JS-like source text. */
function importSpecsOf(content: string): string[] {
  const specs: string[] = [];
  for (const re of JS_SPEC_RES) {
    re.lastIndex = 0;
    for (const m of content.matchAll(re)) specs.push(m[1].trim());
  }
  return specs;
}

function importGlobsOf(content: string): string[] {
  const globs: string[] = [];
  for (const m of content.matchAll(GLOB_RE)) {
    for (const g of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) globs.push(g[1]);
  }
  return globs;
}

function targetVariants(targetPath: string): string[] {
  const noExt = stripExt(targetPath);
  const variants = [noExt];
  if (basenameSansExt(targetPath) === 'index') {
    const dir = posix.dirname(noExt);
    if (dir && dir !== '.') variants.push(dir);
  }
  return variants;
}

function stripSpecExt(spec: string): { spec: string; ext: string } {
  // Strip `?query` / `#fragment` suffixes, but keep a leading `#` (Node subpath imports).
  const clean = spec.replace(/(?!^)[?#].*$/, '');
  const ext = extensionOf(clean);
  if (ext && (JS_LIKE_EXTENSIONS.has(ext) || ext === 'ts' || ext === 'tsx')) {
    return { spec: stripExt(clean), ext };
  }
  return { spec: clean, ext };
}

type NodeModuleKind = 'none' | 'package' | 'workspace';
const nodeModuleCache = new Map<string, NodeModuleKind>();

/**
 * Is `pkg` (e.g. `zod`, `@acme/ui`) installed under a node_modules up to 4
 * levels above `projectDir`? A symlinked entry is a workspace package
 * (pnpm/npm/yarn workspaces link `packages/ui` → `node_modules/@acme/ui`),
 * whose files live in this repo and can therefore be the wiring target.
 */
function nodeModuleKind(projectDir: string, pkg: string): NodeModuleKind {
  const key = `${projectDir}\0${pkg}`;
  const cached = nodeModuleCache.get(key);
  if (cached !== undefined) return cached;
  let found: NodeModuleKind = 'none';
  let dir = projectDir;
  for (let i = 0; i < 4; i++) {
    const abs = join(dir, 'node_modules', pkg);
    if (existsSync(abs)) {
      try {
        found = lstatSync(abs).isSymbolicLink() ? 'workspace' : 'package';
      } catch {
        found = 'package';
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (nodeModuleCache.size > 5000) nodeModuleCache.clear();
  nodeModuleCache.set(key, found);
  return found;
}

/** Does `spec` (as written in `importerPath`) resolve to `targetPath`? */
export function specResolvesTo(spec: string, importerPath: string, targetPath: string, projectDir: string): boolean {
  const target = normalizePath(targetPath);
  const variants = targetVariants(target);
  const { spec: s, ext } = stripSpecExt(spec.trim());
  if (!s) return false;
  // Non-code extension (css/json/svg): only an exact path match counts.
  if (ext && !JS_LIKE_EXTENSIONS.has(ext) && ext !== 'ts' && ext !== 'tsx' && !CODE_EXTENSIONS.has(ext)) {
    return posix.normalize(posix.join(posix.dirname(normalizePath(importerPath)), s)) === target;
  }

  if (s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..') {
    const resolved = normalizePath(posix.normalize(posix.join(posix.dirname(normalizePath(importerPath)), s)));
    return variants.includes(resolved);
  }
  if (s.startsWith('/')) {
    // Vite-style root-absolute import.
    const rest = s.slice(1);
    return variants.some((v) => v === rest || v === `src/${rest}`);
  }

  const suffixMatch = (rest: string) =>
    !!rest && variants.some((v) => v === rest || v === `src/${rest}` || v.endsWith(`/${rest}`));

  const aliasSingle = /^([@~#$])\/(.+)$/.exec(s); // @/x  ~/x  #/x  $/x
  if (aliasSingle) return suffixMatch(aliasSingle[2]);
  const aliasDouble = /^~~\/(.+)$/.exec(s);
  if (aliasDouble) return suffixMatch(aliasDouble[1]);

  const segs = s.split('/');
  const pkgName = s.startsWith('@') && segs.length > 1 ? `${segs[0]}/${segs[1]}` : segs[0];
  const kind = nodeModuleKind(projectDir, pkgName);
  if (kind === 'package') return false; // real dependency
  if (kind === 'workspace') {
    // `@acme/ui` → the linked package's entry (index / src/index); `@acme/ui/button` → its subpath.
    const rest = s.slice(pkgName.length + 1);
    if (!rest) return variants.some((v) => /(^|\/)(src\/)?index$/.test(v));
    return suffixMatch(rest);
  }

  const scoped = /^([@~#$])([\w.-]+)(?:\/(.+))?$/.exec(s); // @app/x  #utils  $lib/x
  if (scoped) {
    const rest = scoped[3] ?? scoped[2];
    return suffixMatch(rest);
  }
  return suffixMatch(s); // baseUrl-style: src/x, components/Foo, utils
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`);
}

function globMatchesTarget(glob: string, importerPath: string, targetPath: string): boolean {
  const target = normalizePath(targetPath);
  const base = glob.startsWith('/') ? glob.slice(1) : posix.join(posix.dirname(normalizePath(importerPath)), glob);
  return globToRegExp(normalizePath(posix.normalize(base))).test(target);
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
}

/** True when the JS-like `content` (at `importerPath`) imports `targetPath`. */
function jsReferencesModule(content: string, importerPath: string, targetPath: string, projectDir: string): boolean {
  for (const spec of importSpecsOf(content)) {
    if (specResolvesTo(spec, importerPath, targetPath, projectDir)) return true;
  }
  for (const g of importGlobsOf(content)) {
    if (globMatchesTarget(g, importerPath, targetPath)) return true;
  }
  // Vue / Nuxt / Svelte auto-registered components: a template tag is the wiring.
  const tExt = extensionOf(targetPath);
  const iExt = extensionOf(importerPath);
  if ((tExt === 'vue' || tExt === 'svelte') && (iExt === 'vue' || iExt === 'svelte' || iExt === 'astro')) {
    const name = basenameSansExt(targetPath);
    if (new RegExp(`<(?:${escapeRegExp(name)}|${escapeRegExp(kebab(name))})(?:[\\s/>]|$)`, 'm').test(content)) return true;
  }
  return false;
}

/* ------------------------------------------------------------- Python */

function pyModulePath(path: string): string {
  let p = stripExt(normalizePath(path));
  p = p.replace(/^(src|lib|app)\//, '');
  return p.replace(/\//g, '.');
}

/** True when python `content` (at `importerPath`) imports `targetPath`. */
export function pyReferencesModule(content: string, importerPath: string, targetPath: string): boolean {
  const mod = pyModulePath(targetPath); // pkg.sub.foo
  const modAlt = stripExt(normalizePath(targetPath)).replace(/\//g, '.'); // with src/ prefix kept
  const importerPkg = posix.dirname(normalizePath(importerPath)).replace(/\//g, '.');
  const matches = (ref: string): boolean => {
    let r = ref;
    if (r.startsWith('.')) {
      const dots = r.match(/^\.+/)![0].length;
      const rest = r.slice(dots);
      const parts = importerPkg === '.' ? [] : importerPkg.split('.');
      const base = parts.slice(0, Math.max(0, parts.length - (dots - 1))).join('.');
      r = base && rest ? `${base}.${rest}` : base || rest;
      if (!r) return false;
    }
    return r === mod || r === modAlt || mod.endsWith(`.${r}`) || modAlt.endsWith(`.${r}`) || r.endsWith(`.${mod}`);
  };
  // Dotted module path in a string literal: include('app.urls'), 'app.tasks.run', ROOT_URLCONF = 'cfg.urls'
  for (const m of content.matchAll(/['"]([A-Za-z_][\w.]*)['"]/g)) {
    if (m[1].includes('.') && (m[1] === mod || m[1] === modAlt || m[1].startsWith(`${mod}.`) || m[1].endsWith(`.${mod}`))) return true;
  }
  for (const line of content.split('\n')) {
    let m = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(line);
    if (m) {
      const base = m[1];
      if (matches(base)) return true;
      const names = m[2].replace(/[()\\]/g, '').split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const n of names) if (matches(`${base}${base.endsWith('.') ? '' : '.'}${n}`)) return true;
      continue;
    }
    m = /^\s*import\s+(.+)$/.exec(line);
    if (m) {
      const names = m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const n of names) if (matches(n)) return true;
    }
  }
  return false;
}

/* --------------------------------------------------------------- Rust */

export function rustReferencesModule(content: string, targetPath: string): boolean {
  const name = basenameSansExt(targetPath);
  if (name === 'mod' || name === 'main' || name === 'lib') return false;
  const modDecl = new RegExp(`(^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${escapeRegExp(name)}\\s*;`);
  const useDecl = new RegExp(`\\b(?:crate|super|self)(?:::\\w+)*::${escapeRegExp(name)}\\b`);
  return modDecl.test(content) || useDecl.test(content);
}

/* --------------------------------------------------------------- Ruby */

function camelize(s: string): string {
  return s.split(/[_-]/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('');
}

function rubyReferencesModule(content: string, importerPath: string, targetPath: string): boolean {
  const target = stripExt(normalizePath(targetPath));
  const name = basenameSansExt(targetPath);
  for (const m of content.matchAll(/\brequire(_relative)?\s*\(?\s*['"]([^'"\n]+)['"]/g)) {
    const spec = stripExt(m[2]);
    if (m[1]) {
      const resolved = normalizePath(posix.normalize(posix.join(posix.dirname(normalizePath(importerPath)), spec)));
      if (resolved === target) return true;
    } else if (target === spec || target.endsWith(`/${spec}`)) return true;
  }
  const constant = camelize(name);
  if (new RegExp(`\\b${escapeRegExp(constant)}\\b`).test(content)) return true;
  // Rails: a controller is wired by config/routes.rb through its resource name,
  // never by constant (`resources :users`, `get 'users/:id', to: 'users#show'`).
  const ctrl = /^(.+)_controller$/.exec(name);
  if (ctrl && /(^|\/)routes(\/[^/]+)?\.rb$/.test(normalizePath(importerPath))) {
    const resource = ctrl[1].replace(/^.*\//, '');
    const singular = resource.replace(/s$/, '');
    const re = new RegExp(
      `\\bresources?\\s+:${escapeRegExp(resource)}\\b|\\bresource\\s+:${escapeRegExp(singular)}\\b|['"]${escapeRegExp(resource)}#|\\bcontroller:\\s*['":]${escapeRegExp(resource)}\\b|\\bnamespace\\s+:${escapeRegExp(resource)}\\b`
    );
    if (re.test(content)) return true;
  }
  return false;
}

/* ------------------------------------------------- Java / Kotlin / PHP / C# / Swift */

function classLikeReferencesModule(content: string, importerPath: string, targetPath: string): boolean {
  const name = basenameSansExt(targetPath);
  const ext = extensionOf(targetPath);
  const word = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  if (ext === 'java' || ext === 'kt') {
    if (new RegExp(`\\bimport\\s+[\\w.]*\\.${escapeRegExp(name)}\\b`).test(content)) return true;
    // Same package ⇒ no import needed.
    return posix.dirname(normalizePath(importerPath)) === posix.dirname(normalizePath(targetPath)) && word.test(content);
  }
  if (ext === 'php') {
    return (
      new RegExp(`\\buse\\s+[\\w\\\\]*\\\\${escapeRegExp(name)}\\b`).test(content) ||
      new RegExp(`\\b(?:new\\s+${escapeRegExp(name)}\\b|${escapeRegExp(name)}::)`).test(content) ||
      new RegExp(`\\b(?:require|include)(?:_once)?\\b[^\\n]*${escapeRegExp(name)}\\.php`).test(content)
    );
  }
  return word.test(content); // cs / swift: module-scoped, class name usage is the wiring
}

/* ------------------------------------------------ reference-only files */

function manifestReferencesModule(content: string, targetPath: string): boolean {
  const target = normalizePath(targetPath);
  const noExt = stripExt(target);
  return content.includes(target) || content.includes(noExt);
}

/**
 * Language-aware "does this file actually import/wire `targetPath`?".
 * `importerPath` is repo-relative; `content` is its text.
 */
export function fileReferencesModule(
  content: string,
  importerPath: string,
  targetPath: string,
  projectDir: string
): boolean {
  const tExt = extensionOf(targetPath);
  const iExt = extensionOf(importerPath);
  if (REFERENCE_ONLY_EXTENSIONS.has(iExt)) return manifestReferencesModule(content, targetPath);
  if (TEMPLATE_EXTENSIONS.has(iExt)) {
    // Rails views reference helpers / models by constant; JS-like targets need a real import.
    return tExt === 'rb' ? rubyReferencesModule(content, importerPath, targetPath) : false;
  }
  if (JS_LIKE_EXTENSIONS.has(tExt)) return JS_LIKE_EXTENSIONS.has(iExt) && jsReferencesModule(content, importerPath, targetPath, projectDir);
  if (tExt === 'py') return iExt === 'py' && pyReferencesModule(content, importerPath, targetPath);
  if (tExt === 'rs') return iExt === 'rs' && rustReferencesModule(content, targetPath);
  if (tExt === 'rb') return iExt === 'rb' && rubyReferencesModule(content, importerPath, targetPath);
  return classLikeReferencesModule(content, importerPath, targetPath);
}

export interface ModuleReferences {
  production: string[];
  test: string[];
}

/**
 * Find files that import `targetPath`, split into production vs test-only.
 * Searches for the module's basename (and directory name for index files),
 * then confirms each candidate with a language-aware import check.
 */
export async function findModuleReferences(projectDir: string, targetPath: string, cache?: ContentCache): Promise<ModuleReferences> {
  const all = await findModuleReferencesMany(projectDir, [targetPath], cache);
  return all.get(normalizePath(targetPath)) ?? { production: [], test: [] };
}

/** Textual needles whose presence a file must have to possibly import `target`. */
function needlesFor(target: string): string[] {
  const base = basenameSansExt(target);
  const needles = new Set<string>([base]);
  if (base === 'index') {
    const dir = posix.basename(posix.dirname(target));
    if (dir && dir !== '.') needles.add(dir);
  }
  const ext = extensionOf(target);
  if (ext === 'rb') {
    needles.add(camelize(base));
    const ctrl = /^(.+)_controller$/.exec(base);
    if (ctrl) needles.add(ctrl[1]);
  }
  if (ext === 'vue' || ext === 'svelte') needles.add(kebab(base));
  return [...needles].filter(Boolean);
}

/**
 * `findModuleReferences` for several targets with ONE candidate search
 * (a single `git grep` with every needle) and one read per candidate file.
 */
export async function findModuleReferencesMany(
  projectDir: string,
  targetPaths: string[],
  cache: ContentCache = new Map()
): Promise<Map<string, ModuleReferences>> {
  const out = new Map<string, ModuleReferences>();
  const targets = [...new Set(targetPaths.map(normalizePath))];
  if (targets.length === 0) return out;
  const needlesByTarget = new Map(targets.map((t) => [t, needlesFor(t)] as const));
  const allNeedles = [...new Set([...needlesByTarget.values()].flat())];
  // Needles whose wiring is always an import-shaped line (safe to narrow when
  // the candidate list explodes): JS/TS modules and Rust modules. Vue/Svelte
  // (template tags), Ruby (constants), Python (dotted strings) are not.
  const narrowNeedles = new Set<string>();
  for (const [t, needles] of needlesByTarget) {
    const ext = extensionOf(t);
    if (ext === 'rs' || (JS_LIKE_EXTENSIONS.has(ext) && ext !== 'vue' && ext !== 'svelte' && ext !== 'astro')) for (const n of needles) narrowNeedles.add(n);
  }
  // No `exclude`: a new module imported by ANOTHER new module in the same task is
  // wired (each target only skips itself below).
  const byNeedle = await findFilesMentioningAny(projectDir, allNeedles, { narrowNeedles }, cache);

  for (const target of targets) {
    const refs: ModuleReferences = { production: [], test: [] };
    const candidates = new Set<string>();
    for (const n of needlesByTarget.get(target) ?? []) for (const f of byNeedle.get(n) ?? []) candidates.add(f);
    for (const cand of [...candidates].sort()) {
      if (cand === target) continue;
      const content = await readCached(projectDir, cand, cache);
      if (content === undefined) continue;
      if (!fileReferencesModule(content, cand, target, projectDir)) continue;
      if (isTestFile(cand)) refs.test.push(cand);
      else if (isCodeFile(cand) || REFERENCE_ONLY_EXTENSIONS.has(extensionOf(cand)) || TEMPLATE_EXTENSIONS.has(extensionOf(cand))) refs.production.push(cand);
    }
    out.set(target, refs);
  }
  return out;
}
