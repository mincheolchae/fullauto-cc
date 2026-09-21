/**
 * Test-integrity check: catches the ways a subagent can turn a red gate
 * green without doing the work — deleting tests, skipping/focusing them,
 * writing assertion-less or tautological tests, weakening existing ones,
 * or swallowing errors.
 *
 * Every rule is a count delta between `before` and `after` text, so a
 * pre-existing `.skip` never blocks a task that did not touch it.
 */
import { isGeneratedPath } from './patterns.js';
import type { AuditFinding, ChangedFile, TaskClassification, TaskDiff } from './types.js';

/**
 * The orchestrator seeds missing env vars as `FULLAUTO_PLACEHOLDER_<NAME>`
 * so subagents can run; production code that tests for the sentinel
 * (`if (key.startsWith('FULLAUTO_PLACEHOLDER_')) return fakeResponse`) makes
 * the gates pass on a code path that never exists in real deployments.
 */
export const PLACEHOLDER_SENTINEL = 'FULLAUTO_PLACEHOLDER_';

/** A comparison / predicate / conditional on the same line (or the line before/after) as the sentinel. */
const BRANCH_CONTEXT_RE =
  /\b(?:if|elif|elsif|unless|case|when|switch|while|until)\b|[=!]==?(?!=)|\.(?:startsWith|startswith|StartsWith|endsWith|includes|contains|Contains|test|match|matches|indexOf|search|equals|equalsIgnoreCase|some|every|find)\s*\(|\bHasPrefix\b|\bHasSuffix\b|\bstrings\.Contains\b|\bre\.(?:match|search)\b|\?[^.:?]|&&|\|\||\bnot\s+in\b|\sin\s+\w/;
/** A string literal longer than this that mentions the sentinel is prose (a prompt / report line), not a comparison operand. */
const PROSE_STRING_LENGTH = 48;

/**
 * Lines (1-based) where production code BRANCHES on the placeholder sentinel:
 * the sentinel sits in a short string literal (or bare) and a comparison /
 * predicate / conditional appears within one line of it. Comments and
 * prose-length strings that merely mention the sentinel (the orchestrator's
 * own prompts and reports) never count, nor does constructing the value
 * (`\`FULLAUTO_PLACEHOLDER_${name}\``) without comparing against it.
 */
function placeholderBranchLines(text: string, path: string): number[] {
  const out: number[] = [];
  if (!text.includes(PLACEHOLDER_SENTINEL)) return out;
  const noComments = stripComments(text, path);
  const lines = noComments.split('\n');
  const codeOnly = sanitizeSource(noComments, path).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(PLACEHOLDER_SENTINEL)) continue;
    // Every occurrence must be in a short literal (or bare identifier); one prose string disqualifies only itself.
    let operand = false;
    for (const m of line.matchAll(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
      if (m[0].includes(PLACEHOLDER_SENTINEL) && m[0].length <= PROSE_STRING_LENGTH) operand = true;
    }
    if (!operand && !/['"`][^'"`]*FULLAUTO_PLACEHOLDER_/.test(line) && /(^|[^\w'"`])FULLAUTO_PLACEHOLDER_/.test(line)) operand = true; // bare / template-free
    if (!operand) continue;
    const window = [codeOnly[i - 1] ?? '', codeOnly[i] ?? '', codeOnly[i + 1] ?? ''].join('\n');
    if (BRANCH_CONTEXT_RE.test(window)) out.push(i + 1);
  }
  return out;
}

/** Blank comments only (strings untouched, newlines kept) — for checks that must see string operands. */
function stripComments(text: string, path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const re = ext === 'py' || ext === 'rb' ? PY_NOISE_RE : JS_NOISE_RE;
  return text.replace(re, (m) => {
    const q = m[0];
    if (q === "'" || q === '"' || q === '`') return m; // keep strings
    return m.replace(/[^\n]/g, ' ');
  });
}

export const SKIP_MARKER_PATTERNS: RegExp[] = [
  // Unconditional: `.skip('name'`, `.only(`, `.todo(`, `test.fixme('name'`, bare `test.skip()` / `.skip(true`.
  // A skip whose first argument is an expression (`test.skip(({ browserName }) => ..., 'why')`,
  // `test.skip(process.platform === 'win32')`) is a platform/browser condition → CONDITIONAL_SKIP_PATTERNS (WARN).
  /(?<!this)\.(only|todo)\s*\(/g,
  /(?<!this)\.(skip|fixme)\s*\(\s*(?:['"`]|\)|true\b|1\b)/g,
  /\btest\.fail\s*\(\s*(?:['"`]|\)|true\b)/g, // playwright expected-failure marker
  /\b(xit|xdescribe|xtest|fit|fdescribe|xcontext)\s*\(/g,
  /@pytest\.mark\.(skip|skipif|xfail)\b/g,
  /\bpytest\.(skip|xfail)\s*\(/g,
  /\bunittest\.(skip|skipIf|skipUnless|expectedFailure)\b/g,
  /\bt\.(Skip|Skipf|SkipNow)\s*\(/g,
  /#\[ignore(?:\s*=\s*"[^"]*")?\]/g,
  /@Ignore\b/g,
  /@Disabled\b/g,
  /--passWithNoTests\b/g,
  /\bpending\s*\(\s*['"]/g, // mocha/rspec `pending("...")`
  /\b(xit|xdescribe|xcontext|xspecify)\s+['"]/g, // rspec
];

/** Conditional skips: legitimate for platform/browser gating, still worth a WARN when newly introduced. */
export const CONDITIONAL_SKIP_PATTERNS: RegExp[] = [
  /\bthis\.skip\s*\(/g, // mocha runtime skip
  /(?<!this)\.(?:skip|fixme)\s*\(\s*(?!['"`)]|true\b|1\b)\S/g, // playwright `test.skip(cond, why)`
  /\.(?:skipIf|runIf)\s*\(/g, // vitest
];

export const TEST_BLOCK_PATTERNS: RegExp[] = [
  /\b(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|todo|fails|runIf|skipIf)(?:\([^)]*\))?)*\s*\(/g,
  /\b(?:it|test|specify)(?:\.(?:only|skip|concurrent))?\.each\s*`/g, // tagged-template table form
  /^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm,
  /\bfunc\s+Test\w*\s*\(/g,
  /#\[(?:tokio::)?test(?:\([^)]*\))?\]/g,
  /^\s*@Test\b/gm,
  /^\s*(?:it|specify|scenario)\s+['"]/gm, // rspec
];

export const ASSERTION_PATTERNS: RegExp[] = [
  /\bexpect\w*\s*\(/g, // expect( expectTypeOf( expectAsync( ; supertest `.expect(`
  /\b[Aa]ssert\w*\b(?!!)/g, // python/js/java asserts, C# `Assert.`, testify `assert.`; rust `assert!` macros are counted below
  /\.[Ss]hould\b/g, // chai `.should`, FluentAssertions `.Should()`
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\brequire\.[A-Z]\w*\s*\(/g, // testify `require.Equal(t, ...)` (capitalized ⇒ never node's require.resolve)
  /\b(?:assert_eq|assert_ne|assert|debug_assert|panic)!\s*\(/g,
  /\bshould_panic\b/g,
  /\.unwrap\s*\(/g,
  /\b(?:strictEqual|deepStrictEqual|deepEqual|notEqual|ok|throws|rejects|doesNotThrow|match|fail)\s*\(/g,
  /\.(?:to|not)\.(?:be|eq|equal|have|include|exist|throw)\b/g,
  /\bself\.assert\w*\s*\(/g,
  /\bsnapshot\s*\(/g,
  /\bpytest\.(?:raises|warns|approx)\s*\(/g, // `with pytest.raises(X):` is the assertion
  /\b(?:getBy|getAllBy|findBy|findAllBy)[A-Z]\w*\s*\(/g, // Testing Library queries throw when absent
  /\bXCT\w+\s*\(/g, // XCTest
  /\b(?:verify|verifyNoMoreInteractions|verifyNoInteractions|verifyZeroInteractions)\s*\(/g, // Mockito / jest-mock-extended
  /\.(?:must|wont)_\w+\b/g, // minitest spec
];

/** Each tautology form appears exactly once so a single `expect(1).toBe(1)` counts as one, not two. */
export const TAUTOLOGY_PATTERNS: RegExp[] = [
  /expect\(\s*(true|false|1|0|null|undefined|"[^"]*"|'[^']*')\s*\)\.(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)/g,
  /expect\(\s*true\s*\)\.toBeTruthy\(\)/g,
  /expect\(\s*false\s*\)\.toBeFalsy\(\)/g,
  /\bassert\s+True\b/g,
  /\bassert\s+(\w+)\s*==\s*\1\b/g,
  /\bassert!\(\s*true\s*\)/g,
  /\bassert_eq!\(\s*(\d+|true|false)\s*,\s*\1\s*\)/g,
  /\bassert\.(?:ok|strictEqual|equal)\(\s*(true|1)\s*(?:,\s*\1\s*)?\)/g,
];

export const SWALLOW_PATTERNS: RegExp[] = [
  /\.catch\(\s*(?:\([^)]*\)|\w*)\s*=>\s*\{\s*\}\s*\)/g,
  /\.catch\(\s*(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{\s*\}\s*\)/g,
  /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
  /\bexcept(?:\s+\w+(?:\s+as\s+\w+)?)?\s*:\s*(?:pass|\.\.\.)\s*$/gm,
];

const JS_NOISE_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const PY_NOISE_RE = /'''[\s\S]*?'''|\"\"\"[\s\S]*?\"\"\"|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|#[^\n]*/g;

/**
 * Blank out string-literal contents and comments (keeping newlines so line
 * numbers survive). Real skip markers / assertions live in code, never
 * inside strings, so this removes fixture-in-a-string and commented-out
 * false positives without hiding anything real.
 */
export function sanitizeSource(text: string, path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const re = ext === 'py' || ext === 'rb' ? PY_NOISE_RE : JS_NOISE_RE;
  return text.replace(re, (m) => {
    const keepQuote = m[0] === "'" || m[0] === '"' || m[0] === '`';
    const nl = m.replace(/[^\n]/g, '');
    return keepQuote ? `${m[0]}${nl}${m[0]}` : nl;
  });
}

export function countMatches(text: string, patterns: RegExp[]): number {
  let n = 0;
  for (const re of patterns) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
}

const EACH_CALL_RE = /\b(it|test|describe|specify)(?:\.(?:only|skip|concurrent))?\.each\s*([(`])/g;
const SCAN_LIMIT = 400 * 1024;

/** Index of the bracket closing the one at `open`, or -1. Sanitized text has no string contents, so nesting is reliable. */
function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  const end = Math.min(text.length, open + SCAN_LIMIT);
  for (let i = open; i < end; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Number of top-level elements in the array literal starting at `open` (`[`). */
function arrayRows(text: string, open: number): number {
  const close = matchBracket(text, open);
  if (close < 0) return 1;
  const inner = text.slice(open + 1, close).trim();
  if (!inner) return 0;
  let depth = 0;
  let rows = 1;
  for (const c of inner) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) rows++;
  }
  if (/,\s*$/.test(inner)) rows--; // trailing comma
  return Math.max(1, rows);
}

/** Rows of the table passed to `.each(...)` / `.each\`...\``, resolving a plain identifier to its array literal. */
function tableRows(text: string, argStart: number, opener: string): number {
  if (opener === '`') {
    const close = text.indexOf('`', argStart + 1);
    if (close < 0) return 1;
    const newlines = (text.slice(argStart + 1, close).match(/\n/g) ?? []).length;
    return Math.max(1, newlines - 2); // opening line + header line
  }
  const close = matchBracket(text, argStart);
  if (close < 0) return 1;
  const arg = text.slice(argStart + 1, close).trim();
  if (arg.startsWith('[')) return arrayRows(text, argStart + 1 + text.slice(argStart + 1).indexOf('['));
  const id = /^([A-Za-z_$][\w$]*)$/.exec(arg);
  if (id) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${id[1]}\\b[^=\\n]*=\\s*\\[`).exec(text);
    if (decl) return arrayRows(text, decl.index + decl[0].length - 1);
  }
  return 1;
}

/**
 * Extra blocks / assertions contributed by `.each` tables beyond the single
 * call site the regexes count: a table with N rows runs its body N times, so
 * a refactor of N tests into one `it.each` keeps the same weight.
 */
export function eachWeights(text: string): { blocks: number; assertions: number } {
  let blocks = 0;
  let assertions = 0;
  EACH_CALL_RE.lastIndex = 0;
  for (const m of text.matchAll(EACH_CALL_RE)) {
    const argStart = m.index! + m[0].length - 1;
    const rows = tableRows(text, argStart, m[2]);
    if (rows <= 1) continue;
    // The generated-test call follows the table: `.each(table)(name, fn)`.
    const tableEnd = m[2] === '`' ? text.indexOf('`', argStart + 1) : matchBracket(text, argStart);
    if (tableEnd < 0) continue;
    const callOpen = text.indexOf('(', tableEnd + 1);
    if (callOpen < 0 || /\S/.test(text.slice(tableEnd + 1, callOpen))) continue;
    const callClose = matchBracket(text, callOpen);
    if (callClose < 0) continue;
    const body = text.slice(callOpen, callClose + 1);
    const innerBlocks = m[1] === 'describe' ? countMatches(body, TEST_BLOCK_PATTERNS) : 1;
    blocks += (rows - 1) * innerBlocks;
    assertions += (rows - 1) * countMatches(body, ASSERTION_PATTERNS);
  }
  return { blocks, assertions };
}

export function countTestBlocks(text: string): number {
  return countMatches(text, TEST_BLOCK_PATTERNS) + eachWeights(text).blocks;
}

export function countAssertions(text: string): number {
  return countMatches(text, ASSERTION_PATTERNS) + eachWeights(text).assertions;
}

/**
 * Name → own assertion count for functions DECLARED in `text` (brace-bodied
 * `function name(...) { ... }` / `const name = (...) => { ... }` / `const
 * name = function(...) { ... }` only — a concise-body arrow with no braces
 * is not resolved; a pragmatic scope limit, not a correctness requirement
 * for the refactor shape this exists to recognize: extracting DUPLICATED
 * inline assertions out of several `it(...)` blocks into one shared helper).
 * Used to resolve ONE level of indirection — see `blockReachableAssertions`.
 */
const HELPER_DECL_RE =
  /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\s*\([^)]*\)|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)\s*\{/g;

function localHelperAssertions(text: string): Map<string, number> {
  const helpers = new Map<string, number>();
  HELPER_DECL_RE.lastIndex = 0;
  for (const m of text.matchAll(HELPER_DECL_RE)) {
    const name = m[1] ?? m[2];
    if (!name) continue;
    const openBrace = m.index! + m[0].length - 1; // the match always ends at the opening "{"
    const close = matchBracket(text, openBrace);
    if (close < 0) continue;
    helpers.set(name, countAssertions(text.slice(openBrace, close + 1)));
  }
  return helpers;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One test block's reachable assertions: its own direct assertion-pattern
 * matches, plus — for each same-file helper it calls — that helper's own
 * assertion count (one level deep; a helper calling another helper does not
 * chain further). A block that calls a known helper twice is credited
 * twice, matching how many times the helper's assertions actually run.
 */
function blockReachableAssertions(body: string, helpers: Map<string, number>): number {
  let total = countAssertions(body);
  for (const [name, n] of helpers) {
    if (n === 0) continue;
    const calls = body.match(new RegExp(`\\b${escapeForRegex(name)}\\s*\\(`, 'g'));
    if (calls) total += calls.length * n;
  }
  return total;
}

/**
 * Sum of `blockReachableAssertions` over every test block in `text` — the
 * file-wide reachable total. Includes the SAME `.each`-table row bonus
 * `countAssertions` applies (`eachWeights`): a table with N rows runs its
 * callback body N times, so consolidating N individual tests into one
 * `it.each(...)` must not look like a drop just because the literal
 * callback text (and any same-file helper it calls) now appears once.
 */
function reachableAssertionsTotal(text: string, helpers: Map<string, number>): number {
  let total = eachWeights(text).assertions;
  for (const { body } of testBlockBodies(text)) total += blockReachableAssertions(body, helpers);
  return total;
}

/* ------------------------------------------------ existence-only tests */

const IDENT = '[A-Za-z_$][\\w$.]*';
/**
 * Assertion forms that only prove a thing EXISTS or has a type — never that
 * it behaves. Each regex captures the subject (group 1). The block is
 * "existence-only" when every assertion in it is one of these AND the
 * subject is an imported binding (`expect(quote).toBeDefined()` after
 * `import { quote }`) or a `typeof` check; `expect(result).toBeNull()` on a
 * local computed value is a (weak) behavioral assertion and never counts.
 */
const TRIVIAL_ASSERTION_PATTERNS: RegExp[] = [
  new RegExp(`\\bexpect\\(\\s*(${IDENT})\\s*\\)\\s*(?:\\.not)?\\.(?:toBeDefined|toBeTruthy|toBeUndefined|toBeNull|toBeFalsy|toExist|toBeFunction|toBeObject)\\s*\\(`, 'g'),
  new RegExp(`\\bexpect\\(\\s*(${IDENT})\\s*\\)\\s*(?:\\.not)?\\.toBeInstanceOf\\(\\s*(?:Function|Object)\\s*\\)`, 'g'),
  new RegExp(`\\bexpect\\(\\s*(${IDENT})\\s*\\)\\s*(?:\\.not)?\\.toBeTypeOf\\s*\\(`, 'g'),
  new RegExp(`\\bexpect\\(\\s*(${IDENT})\\s*\\)\\.(?:to|not)\\.(?:exist|be\\.(?:ok|a|an|undefined|null|function))\\b`, 'g'), // chai
  new RegExp(`\\bassert(?:\\.(?:ok|isOk|isDefined|isNotNull|isFunction|isNotUndefined|exists|notStrictEqual|notEqual))?\\(\\s*(${IDENT})\\s*(?:,\\s*(?:undefined|null))?\\s*(?:,\\s*['"][^'"]*['"])?\\s*\\)`, 'g'),
  new RegExp(`\\bassert\\s+callable\\(\\s*(${IDENT})\\s*\\)`, 'g'), // python
  new RegExp(`\\bassert\\s+(${IDENT})\\s+is\\s+not\\s+None\\b`, 'g'),
  new RegExp(`\\bassert\\s+(${IDENT})\\s*$`, 'gm'),
  new RegExp(`\\bassert\\s+(?:hasattr|isinstance)\\(\\s*(${IDENT})\\s*,`, 'g'),
  new RegExp(`\\bassert(?:True|NotNull|IsNotNull)\\(\\s*(${IDENT})\\s*(?:!=\\s*null\\s*)?\\)`, 'g'), // java / c#
];

/** `typeof x === 'function'` style checks are existence checks whatever `x` is. */
const TYPEOF_ASSERTION_PATTERNS: RegExp[] = [
  new RegExp(`\\bexpect\\(\\s*typeof\\s+${IDENT}\\s*(?:===?\\s*['"][^'"]*['"]\\s*)?\\)\\s*(?:\\.not)?\\.(?:toBe|toEqual|toStrictEqual|toBeTruthy|toBeDefined)\\s*\\(`, 'g'),
  new RegExp(`\\bexpect\\(\\s*${IDENT}\\s*(?:!==?|===?)\\s*(?:undefined|null)\\s*\\)\\s*(?:\\.not)?\\.(?:toBe|toEqual|toBeTruthy)\\s*\\(`, 'g'),
  new RegExp(`\\bassert\\.(?:strictEqual|equal)\\(\\s*typeof\\s+${IDENT}\\s*,`, 'g'),
  new RegExp(`\\bassert\\s+(?:isinstance|callable)\\(\\s*${IDENT}\\s*[,)]`, 'g'),
];

/** Names bound by the file's import / require / python import statements (sanitized text: specs are blank). */
function importedNamesOf(text: string): Set<string> {
  const names = new Set<string>();
  const add = (clause: string) => {
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.add(ns[1]);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const local = (part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop() ?? '').trim();
        if (/^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
      }
    }
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(head)) names.add(head);
  };
  for (const m of text.matchAll(/\bimport\s+(?:type\s+)?([^'"`;]*?)\s*from\s*['"`]/g)) add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+([^=;]+?)\s*=\s*(?:await\s+)?(?:require|import)\s*\(/g)) add(m[1].replace(/:\s*[^,}]+/g, ''));
  for (const m of text.matchAll(/^\s*from\s+\S+\s+import\s+(.+)$/gm)) {
    for (const part of m[1].replace(/[()\\]/g, '').split(',')) {
      const local = (part.trim().split(/\s+as\s+/).pop() ?? '').trim();
      if (/^[A-Za-z_]\w*$/.test(local)) names.add(local);
    }
  }
  for (const m of text.matchAll(/^\s*import\s+([^'"\n]+)$/gm)) {
    for (const part of m[1].split(',')) {
      const local = (part.trim().split(/\s+as\s+/).pop() ?? '').trim().split('.')[0];
      if (/^[A-Za-z_]\w*$/.test(local)) names.add(local);
    }
  }
  return names;
}

const BLOCK_OPEN_RE = /\b(?:it|test|specify)(?:\.(?:each|concurrent|only|skip|todo|fails|runIf|skipIf)(?:\([^)]*\))?)*\s*\(|^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm;

/** Body text of each JS `it(`/`test(` call (up to its closing paren) or python `def test_` (until the next top-level line). */
function testBlockBodies(text: string): Array<{ body: string; index: number }> {
  const out: Array<{ body: string; index: number }> = [];
  BLOCK_OPEN_RE.lastIndex = 0;
  for (const m of text.matchAll(BLOCK_OPEN_RE)) {
    const start = m.index ?? 0;
    if (/def\s+test_/.test(m[0])) {
      const rest = text.slice(start + m[0].length);
      const next = /\n(?=\S)/.exec(rest); // next non-indented line ends the function
      out.push({ body: rest.slice(0, next ? next.index : rest.length), index: start });
      continue;
    }
    const open = start + m[0].length - 1;
    const close = matchBracket(text, open);
    out.push({ body: text.slice(open, close < 0 ? Math.min(text.length, open + SCAN_LIMIT) : close + 1), index: start });
  }
  return out;
}

/** Blank every trivial assertion whose subject is imported (plus every typeof form); what remains are the behavioral assertions. */
function stripTrivialAssertions(body: string, imported: Set<string>): { stripped: string; removed: number } {
  let removed = 0;
  let stripped = body;
  for (const re of TYPEOF_ASSERTION_PATTERNS) {
    re.lastIndex = 0;
    stripped = stripped.replace(re, (m) => {
      removed++;
      return ' '.repeat(m.length);
    });
  }
  for (const re of TRIVIAL_ASSERTION_PATTERNS) {
    re.lastIndex = 0;
    stripped = stripped.replace(re, (m, subject: string) => {
      const root = subject.split('.')[0];
      if (!imported.has(root)) return m;
      removed++;
      return ' '.repeat(m.length);
    });
  }
  return { stripped, removed };
}

/** Indexes (start offsets) of test blocks whose assertions are all existence-only, in sanitized `text`. */
function trivialBlockOffsets(text: string): number[] {
  const imported = importedNamesOf(text);
  const out: number[] = [];
  for (const { body, index } of testBlockBodies(text)) {
    if (countMatches(body, ASSERTION_PATTERNS) === 0) continue; // the assertion-less rule owns these
    const { stripped, removed } = stripTrivialAssertions(body, imported);
    if (removed > 0 && countMatches(stripped, ASSERTION_PATTERNS) === 0) out.push(index);
  }
  return out;
}

/**
 * Number of test blocks whose assertions are ALL existence / type checks on
 * imported symbols (`expect(fn).toBeDefined()`, `expect(Foo).toBeTruthy()`,
 * `typeof fn === 'function'`, `assert.ok(fn)`, `toBeInstanceOf(Function)`).
 * Such a block passes as soon as the symbol is exported — it proves nothing
 * about behavior, so the test-count check does not count it as a new test.
 * Blocks with zero assertions are not counted (the assertion-less rule owns
 * those). Pass sanitized source.
 */
export function countTrivialTestBlocks(text: string): number {
  return trivialBlockOffsets(text).length;
}

/** Line of the first existence-only block in `after` whose opening line is not already in `before`. */
function firstTrivialBlockLine(before: string, after: string): number | undefined {
  const beforeLines = new Set(before.split('\n').map((l) => l.trim()));
  const afterLines = after.split('\n');
  let fallback: number | undefined;
  for (const offset of trivialBlockOffsets(after)) {
    const line = after.slice(0, offset).split('\n').length;
    fallback ??= line;
    if (!beforeLines.has(afterLines[line - 1]?.trim() ?? '')) return line;
  }
  return fallback;
}

function firstLineMatching(text: string, patterns: RegExp[]): number | undefined {
  let best: number | undefined;
  for (const re of patterns) {
    const single = new RegExp(re.source, re.flags.replace('g', ''));
    const m = single.exec(text);
    if (m && m.index !== undefined) {
      const line = text.slice(0, m.index).split('\n').length;
      if (best === undefined || line < best) best = line;
    }
  }
  return best;
}

function firstNewLine(before: string, after: string, patterns: RegExp[]): number | undefined {
  // Prefer a line whose text does not appear in `before`.
  const beforeLines = new Set(before.split('\n').map((l) => l.trim()));
  const afterLines = after.split('\n');
  for (let i = 0; i < afterLines.length; i++) {
    const line = afterLines[i];
    if (beforeLines.has(line.trim())) continue;
    if (patterns.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(line))) return i + 1;
  }
  return firstLineMatching(after, patterns);
}

/** Lines that carry content (not `});`, `}`, `]` …) — boilerplate would make unrelated files look alike. */
function contentLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => (l.match(/\w/g) ?? []).length >= 3);
}

/** Fraction of `a`'s content lines that also occur in `b` (order-insensitive). */
function lineOverlap(a: string, b: string): number {
  const linesA = contentLines(a);
  if (linesA.length === 0) return 0;
  const setB = new Set(contentLines(b));
  let hit = 0;
  for (const l of linesA) if (setB.has(l)) hit++;
  return hit / linesA.length;
}

const RENAME_OVERLAP = 0.6;

/**
 * Pair deleted test files with added ones that carry (most of) the same
 * lines: `git status --no-renames` reports a move as D + ??, and a moved
 * test is not a deleted test — it is compared as a modification instead.
 */
function pairRenamedTests(diff: TaskDiff): Map<string, ChangedFile> {
  const pairs = new Map<string, ChangedFile>();
  const added = diff.files.filter((f) => f.isTest && f.kind === 'added' && f.after !== undefined);
  const taken = new Set<string>();
  for (const del of diff.files) {
    if (!del.isTest || del.kind !== 'deleted' || del.before === undefined || !del.before.trim()) continue;
    let best: ChangedFile | undefined;
    let bestScore = 0;
    for (const add of added) {
      if (taken.has(add.path)) continue;
      const score = lineOverlap(del.before, add.after!);
      if (score > bestScore) {
        bestScore = score;
        best = add;
      }
    }
    if (best && bestScore >= RENAME_OVERLAP) {
      pairs.set(del.path, best);
      taken.add(best.path);
    }
  }
  return pairs;
}

export function checkTestIntegrity(diff: TaskDiff, cls: TaskClassification): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const allowsEdits = cls.allowsTestEdits;
  const renamed = pairRenamedTests(diff);
  const renameTargets = new Set([...renamed.values()].map((f) => f.path));

  for (const raw of diff.files) {
    let file = raw;
    if (isGeneratedPath(file.path)) continue; // node_modules/ dist/ coverage/ in a repo without .gitignore
    const isTest = file.isTest;

    // Production code that branches on the placeholder sentinel passes the
    // gates through a path that only exists inside the orchestrator's sandbox.
    if (!isTest && file.isCode && file.kind !== 'deleted' && file.after !== undefined) {
      const after = placeholderBranchLines(file.after, file.path);
      const before = placeholderBranchLines(file.before ?? '', file.path);
      if (after.length > before.length) {
        findings.push({
          check: 'test-integrity',
          severity: 'block',
          path: file.path,
          line: after[0],
          message: `${file.path}:${after[0]} compares against ${PLACEHOLDER_SENTINEL} — production code branches on the placeholder sentinel — use a fake/adapter (inject a client interface and pass a test double) instead of special-casing the orchestrator's synthetic env value`,
        });
      }
    }

    // --passWithNoTests can be smuggled through gate config (package.json scripts, CI, runner config).
    if (!isTest && file.isGateConfig && file.kind !== 'deleted') {
      const delta = countMatches(file.after ?? '', [/--passWithNoTests\b/g]) - countMatches(file.before ?? '', [/--passWithNoTests\b/g]);
      if (delta > 0) {
        findings.push({
          check: 'test-integrity',
          severity: 'block',
          path: file.path,
          line: firstNewLine(file.before ?? '', file.after ?? '', [/--passWithNoTests\b/g]),
          message: `${file.path} introduces --passWithNoTests — remove it; a gate that passes with zero tests is not a gate`,
        });
      }
    }

    if (!isTest) continue;
    if (renameTargets.has(file.path)) continue; // handled through its deleted counterpart below

    if (file.kind === 'deleted') {
      const target = renamed.get(file.path);
      if (!target) {
        findings.push({
          check: 'test-integrity',
          severity: allowsEdits ? 'info' : 'block',
          path: file.path,
          message: allowsEdits
            ? `test file ${file.path} deleted (allowed by \`modifies-tests\`)`
            : `test file ${file.path} was deleted — restore it; if the test is obsolete the task must say \`- modifies-tests: <reason>\``,
        });
        continue;
      }
      findings.push({
        check: 'test-integrity',
        severity: 'info',
        path: target.path,
        message: `test file ${file.path} moved to ${target.path} (content carried over); compared as a modification`,
      });
      file = { ...target, kind: 'modified', before: file.before };
    }

    if (file.after === undefined) continue; // unreadable

    if (!file.isCode) {
      // Fixture / snapshot data under a test directory: nothing to count, but
      // an impl task rewriting expected values is exactly how a snapshot gets "updated" to match a bug.
      if (file.kind === 'modified' && cls.kind !== 'test' && !allowsEdits && file.before !== file.after) {
        findings.push({
          check: 'test-integrity',
          severity: 'warn',
          path: file.path,
          message: `test fixture ${file.path} modified in a non-test task — verify the expected data was not changed to match broken behavior; add \`- modifies-tests: <reason>\` if intentional`,
        });
      }
      continue;
    }

    const before = sanitizeSource(file.before ?? '', file.path);
    const after = sanitizeSource(file.after, file.path);

    checkMarkers(file, before, after, findings);
    checkAssertions(file, before, after, findings);
    checkTautologies(file, before, after, findings);
    checkTrivial(file, before, after, findings);
    checkSwallowed(file, before, after, findings);

    if (file.kind === 'modified' && cls.kind !== 'test' && !allowsEdits && file.before !== file.after) {
      const blocksBefore = countTestBlocks(before);
      const blocksAfter = countTestBlocks(after);
      const assertsBefore = countAssertions(before);
      const assertsAfter = countAssertions(after);
      // Reachable assertions (direct + one-level-deep same-file helper
      // calls) is the primary weakened-test signal, not the raw per-block /
      // file-wide regex counts above: extracting repeated inline assertions
      // into a shared helper (`expectValidUser(user)` called from 3 tests
      // instead of duplicating 4 assertions in each) is a legitimate
      // refactor that drops both the block count AND the raw text-scan
      // assertion count — moving them out of `it(...)` bodies into a
      // function defined once — without reducing what actually gets
      // exercised. `assertsBefore/assertsAfter` above stay for the
      // non-blocking messages below; they were never a reliable BLOCK
      // signal on their own.
      const helpersBefore = localHelperAssertions(before);
      const helpersAfter = localHelperAssertions(after);
      const reachableBefore = reachableAssertionsTotal(before, helpersBefore);
      const reachableAfter = reachableAssertionsTotal(after, helpersAfter);
      // Even when the FILE total holds, one individual test block silently
      // losing every assertion (while unrelated ones elsewhere gained some)
      // is still a real coverage loss for that specific test — a hard BLOCK
      // regardless of the file-wide totals.
      const hollowedOut =
        blocksBefore > 0 &&
        testBlockBodies(after).some(({ body }) => blockReachableAssertions(body, helpersAfter) === 0);
      if (reachableAfter < reachableBefore || hollowedOut) {
        findings.push({
          check: 'test-integrity',
          severity: 'block',
          path: file.path,
          message:
            reachableAfter < reachableBefore
              ? `weakened test: ${file.path} lost reachable assertions (direct + same-file helper calls) going from ${reachableBefore} to ${reachableAfter} across ${blocksBefore}→${blocksAfter} test block(s) — restore them; only a task marked \`- modifies-tests: <reason>\` may reduce coverage`
              : `weakened test: ${file.path} has a test block with zero reachable assertions (direct + same-file helper calls) after this change, even though the file's total held — restore its coverage; only a task marked \`- modifies-tests: <reason>\` may reduce coverage`,
        });
      } else if (blocksBefore === 0 && blocksAfter === 0) {
        findings.push({
          check: 'test-integrity',
          severity: 'info',
          path: file.path,
          message: `test helper ${file.path} modified in a non-test task (no test blocks) — fine if the change only adds fixtures/helpers`,
        });
      } else {
        findings.push({
          check: 'test-integrity',
          severity: 'warn',
          path: file.path,
          message: `modified existing test ${file.path} in a non-test task (${blocksBefore}→${blocksAfter} blocks, ${assertsBefore}→${assertsAfter} assertions) — verify the change was necessary; add \`- modifies-tests: <reason>\` if intentional`,
        });
      }
    }
  }

  return findings;
}

function checkMarkers(file: ChangedFile, before: string, after: string, findings: AuditFinding[]): void {
  const delta = countMatches(after, SKIP_MARKER_PATTERNS) - countMatches(before, SKIP_MARKER_PATTERNS);
  if (delta > 0) {
    findings.push({
      check: 'test-integrity',
      severity: 'block',
      path: file.path,
      line: firstNewLine(before, after, SKIP_MARKER_PATTERNS),
      message: `${file.path} introduces ${delta} new skip/only/todo marker(s) (.skip/.only/.todo/xit/@pytest.mark.skip/t.Skip/#[ignore]...) — remove them; tests must run and pass`,
    });
  }
  const conditional = countMatches(after, CONDITIONAL_SKIP_PATTERNS) - countMatches(before, CONDITIONAL_SKIP_PATTERNS);
  if (conditional > 0) {
    findings.push({
      check: 'test-integrity',
      severity: 'warn',
      path: file.path,
      line: firstNewLine(before, after, CONDITIONAL_SKIP_PATTERNS),
      message: `${file.path} introduces ${conditional} conditional skip(s) (test.skip(cond, why) / skipIf / this.skip()) — acceptable for platform/browser gating only; make sure the condition is false in the gate environment so the test actually runs`,
    });
  }
}

function checkAssertions(file: ChangedFile, before: string, after: string, findings: AuditFinding[]): void {
  const blocks = countTestBlocks(after);
  const asserts = countAssertions(after);
  if (blocks > 0 && asserts === 0) {
    // Only block when this task made it so (added file, or removed the last assertion).
    const beforeHadAssertions = countAssertions(before) > 0;
    if (file.kind === 'added' || beforeHadAssertions || countTestBlocks(before) === 0) {
      findings.push({
        check: 'test-integrity',
        severity: 'block',
        path: file.path,
        line: firstLineMatching(after, TEST_BLOCK_PATTERNS),
        message: `${file.path} has ${blocks} test block(s) but no assertions — a test that cannot fail verifies nothing; assert on observable behavior`,
      });
    }
  }
}

function checkTautologies(file: ChangedFile, before: string, after: string, findings: AuditFinding[]): void {
  const delta = countMatches(after, TAUTOLOGY_PATTERNS) - countMatches(before, TAUTOLOGY_PATTERNS);
  if (delta > 0) {
    findings.push({
      check: 'test-integrity',
      severity: 'block',
      path: file.path,
      line: firstNewLine(before, after, TAUTOLOGY_PATTERNS),
      message: `${file.path} introduces ${delta} tautological assertion(s) (e.g. expect(true).toBe(true), assert True) — assert on the code under test instead`,
    });
  }
}

function checkTrivial(file: ChangedFile, before: string, after: string, findings: AuditFinding[]): void {
  const delta = countTrivialTestBlocks(after) - countTrivialTestBlocks(before);
  if (delta > 0) {
    findings.push({
      check: 'test-integrity',
      severity: 'warn',
      path: file.path,
      line: firstTrivialBlockLine(before, after),
      message: `existence-only test: ${file.path} adds ${delta} test block(s) whose only assertions check that something is defined / truthy / a function (toBeDefined, toBeTruthy, typeof x === 'function', assert.ok(fn)) — such a test passes as soon as the symbol exists; call it and assert on the result (these blocks do not count as new tests)`,
    });
  }
}

/**
 * Trivial (existence-only) test blocks this task ADDED across its test files:
 * the test-count check subtracts them from the "new tests" credit.
 */
export function trivialTestBlocksAdded(diff: TaskDiff): number {
  let n = 0;
  for (const f of diff.files) {
    if (!f.isTest || !f.isCode || f.kind === 'deleted' || f.after === undefined || isGeneratedPath(f.path)) continue;
    const delta = countTrivialTestBlocks(sanitizeSource(f.after, f.path)) - countTrivialTestBlocks(sanitizeSource(f.before ?? '', f.path));
    if (delta > 0) n += delta;
  }
  return n;
}

function checkSwallowed(file: ChangedFile, before: string, after: string, findings: AuditFinding[]): void {
  const delta = countMatches(after, SWALLOW_PATTERNS) - countMatches(before, SWALLOW_PATTERNS);
  if (delta > 0) {
    findings.push({
      check: 'test-integrity',
      severity: 'warn',
      path: file.path,
      line: firstNewLine(before, after, SWALLOW_PATTERNS),
      message: `${file.path} introduces ${delta} empty catch / .catch(() => {}) — swallowing errors in tests hides failures; assert on the rejection instead`,
    });
  }
}
