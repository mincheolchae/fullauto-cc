/**
 * Parse the summary of a test-runner run into `TestCounts`.
 *
 * Recognizes vitest, jest, mocha, node:test, pytest, go test, cargo test and
 * playwright (list / dot reporters; e2e red sets are quarantined through it).
 * Detection is by the runner's *summary* signature (most specific first), so
 * a jest run that mentions "vitest" in a test name still parses as jest.
 * Unknown output → `runner: 'unknown'`, zero counts, no failing files —
 * callers must treat that as "cannot attribute", never as "all green".
 */
import type { TestCounts } from './types.js';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface ParseOptions {
  /** When set, absolute failing-file paths under it are made relative. */
  projectDir?: string;
}

/* ------------------------------------------------- shared path helpers */

/**
 * Canonical repo-relative POSIX form of a path: backslashes → `/`, no
 * leading `./` or `/`, collapsed `//`. The ONE normalizer shared by the audit
 * checks (`patterns.ts` re-exports it) and by the orchestrator's gate
 * evaluation, so a red-test path recorded by one side always compares equal
 * to a failing-file path parsed by the other.
 */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/\/{2,}/g, '/');
  if (out.startsWith('/')) out = out.slice(1);
  return out;
}

function stripRsExt(p: string): string {
  return p.replace(/\.rs$/, '');
}

/**
 * Does one failing-file entry from `parseTestOutput` attribute to `file`?
 *
 * vitest / jest / pytest / playwright / mocha / node:test report file paths:
 * repo-relative usually, but jest inside a monorepo package and pytest run
 * from a sub-directory print paths relative to THEIR root, so "one is a
 * `/`-bounded suffix of the other" is the tolerant equality. go reports the
 * package path (`example.com/mod/pkg/auth`) → match on the file's directory;
 * cargo reports the test path (`tests::auth::login`) → match when the file's
 * module name appears as a segment, or when every path segment appears in
 * order among the `::` segments (`tests/auth.rs` ↔ `tests::auth::login`).
 *
 * Shared by the orchestrator's quarantine logic (`evaluateGates`) and the
 * audit's tdd-red / tdd-green checks so both sides attribute identically.
 */
export function failureMatchesFile(entry: string, file: string, runner: TestCounts['runner']): boolean {
  const e = normalizePath(entry);
  const f = normalizePath(file);
  if (!e || !f) return false;
  if (e === f || e.endsWith(`/${f}`) || f.endsWith(`/${e}`)) return true;
  if (runner === 'go') {
    // entry is a package path; the test file lives in that package directory
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    return dir === '.' ? !e.includes('/') : e === dir || e.endsWith(`/${dir}`);
  }
  if (runner === 'cargo') {
    const mod = stripRsExt(f).split('/').pop() ?? '';
    if (mod && (e === mod || e.startsWith(`${mod}::`) || e.includes(`::${mod}::`) || e.endsWith(`::${mod}`))) return true;
    const segs = e.split('::').filter(Boolean);
    const pathSegs = stripRsExt(f).split('/').filter(Boolean);
    let i = 0;
    for (const s of segs) if (s === pathSegs[i]) i += 1;
    return pathSegs.length > 0 && i === pathSegs.length;
  }
  return false;
}

/** `failureMatchesFile` against a list: true when the entry attributes to any of `files`. */
export function failureMatchesFiles(entry: string, files: string[], runner: TestCounts['runner']): boolean {
  return files.some((f) => failureMatchesFile(entry, f, runner));
}

function unknown(): TestCounts {
  return { runner: 'unknown', passed: 0, failed: 0, skipped: 0, failingFiles: [] };
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

function relativize(p: string, projectDir?: string): string {
  let out = p.replace(/\\/g, '/').replace(/^file:\/\//, '');
  if (projectDir) {
    const root = projectDir.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
    if (out.startsWith(root)) out = out.slice(root.length);
  }
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

const TEST_PATH_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs)$/;

export function parseTestOutput(output: string, opts: ParseOptions = {}): TestCounts {
  const text = stripAnsi(output ?? '');
  if (!text.trim()) return unknown();
  const lines = text.split('\n');

  return (
    parseJest(lines, opts) ??
    parseVitest(lines, opts) ??
    parsePytest(lines, opts) ??
    parseCargo(lines) ??
    parseNodeTest(lines, opts) ??
    parseGo(lines) ??
    parsePlaywright(lines, opts) ??
    parseCypress(lines, opts) ??
    parseMocha(lines, opts) ??
    unknown()
  );
}

/* ---------------------------------------------------------------- jest */

function parseJest(lines: string[], opts: ParseOptions): TestCounts | undefined {
  let summary: string | undefined;
  for (const l of lines) {
    const m = /^\s*Tests:\s+(.+)$/.exec(l);
    if (m) summary = m[1];
  }
  if (!summary) return undefined;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const m of summary.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)/g)) {
    const n = Number(m[1]);
    if (m[2] === 'passed') counts.passed += n;
    else if (m[2] === 'failed') counts.failed += n;
    else counts.skipped += n;
  }
  const failingFiles: string[] = [];
  for (const l of lines) {
    const m = /^\s*FAIL\s+(\S+)/.exec(l);
    if (m && TEST_PATH_EXT.test(m[1])) failingFiles.push(relativize(m[1], opts.projectDir));
    const summ = /^\s*●\s+(\S+)\s+›/.exec(l);
    if (summ && TEST_PATH_EXT.test(summ[1])) failingFiles.push(relativize(summ[1], opts.projectDir));
  }
  return { runner: 'jest', ...counts, failingFiles: uniq(failingFiles) };
}

/* -------------------------------------------------------------- vitest */

function parseVitest(lines: string[], opts: ParseOptions): TestCounts | undefined {
  let summary: string | undefined;
  let sawVitestMarker = false;
  for (const l of lines) {
    if (/^\s*RUN\s+v\d/.test(l) || /^\s*Test Files\s+\d/.test(l)) sawVitestMarker = true;
    const m = /^\s*Tests\s+(\d+.*?)\s*(?:\(\d+\))?\s*$/.exec(l);
    if (m) summary = m[1];
  }
  if (!summary) {
    // "Test Files  1 failed (1)" with no "Tests" line happens when a file fails to load.
    if (!sawVitestMarker) return undefined;
    summary = '';
  }
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const m of summary.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending)/g)) {
    const n = Number(m[1]);
    if (m[2] === 'passed') counts.passed += n;
    else if (m[2] === 'failed') counts.failed += n;
    else counts.skipped += n;
  }
  const failingFiles: string[] = [];
  for (const l of lines) {
    // " ❯ test/x.test.ts (3 tests | 1 failed)"  /  " ❯ test/x.test.ts (0 test)" (load error)
    let m = /^\s*[❯×✖]\s+(\S+?)\s+\((\d+)\s+tests?(?:\s*\|\s*(.*?))?\)/.exec(l);
    if (m && TEST_PATH_EXT.test(m[1]) && (/failed/.test(m[3] ?? '') || m[2] === '0')) {
      failingFiles.push(relativize(m[1], opts.projectDir));
      continue;
    }
    // " FAIL  test/x.test.ts > suite > name"  /  " FAIL  test/x.test.ts [ test/x.test.ts ]"
    m = /^\s*FAIL\s+(\S+?)(?:\s+>|\s+\[|\s*$)/.exec(l);
    if (m && TEST_PATH_EXT.test(m[1])) {
      failingFiles.push(relativize(m[1], opts.projectDir));
      continue;
    }
    // Test-file-level load failure summary: "Test Files  1 failed" plus
    // "Error: ... " lines are not attributable; leave them out.
  }
  // If the summary had no "Tests" line but files failed to load, count the file failures.
  if (summary === '' && counts.failed === 0) {
    for (const l of lines) {
      const m = /^\s*Test Files\s+(\d+)\s+failed/.exec(l);
      if (m) counts.failed = Number(m[1]);
    }
  }
  return { runner: 'vitest', ...counts, failingFiles: uniq(failingFiles) };
}

/* -------------------------------------------------------------- pytest */

function parsePytest(lines: string[], opts: ParseOptions): TestCounts | undefined {
  let summary: string | undefined;
  for (const l of lines) {
    const m = /^=+\s+(.*?\b(?:passed|failed|error|errors|skipped|xfailed|xpassed|deselected|no tests ran)\b.*?)\s+in\s+[\d.]+s\b.*=+\s*$/.exec(l);
    if (m) summary = m[1];
  }
  if (!summary) return undefined;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const m of summary.matchAll(/(\d+)\s+(passed|failed|errors?|skipped|xfailed|xpassed|deselected)/g)) {
    const n = Number(m[1]);
    const k = m[2];
    if (k === 'passed' || k === 'xpassed') counts.passed += n;
    else if (k === 'failed' || k.startsWith('error')) counts.failed += n;
    else if (k === 'skipped' || k === 'xfailed') counts.skipped += n;
  }
  const failingFiles: string[] = [];
  for (const l of lines) {
    const m = /^\s*(?:FAILED|ERROR)\s+(\S+?)(?:::|\s|$)/.exec(l);
    if (m && /\.py$/.test(m[1])) failingFiles.push(relativize(m[1], opts.projectDir));
  }
  if (failingFiles.length === 0 && counts.failed > 0) {
    // Fall back to the progress lines: "tests/test_x.py .F.." (F/E present).
    for (const l of lines) {
      const m = /^(\S+\.py)\s+([.FEsxX]+)\s*(?:\[\s*\d+%\])?\s*$/.exec(l);
      if (m && /[FE]/.test(m[2])) failingFiles.push(relativize(m[1], opts.projectDir));
    }
  }
  return { runner: 'pytest', ...counts, failingFiles: uniq(failingFiles) };
}

/* --------------------------------------------------------------- cargo */

function parseCargo(lines: string[]): TestCounts | undefined {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let seen = false;
  for (const l of lines) {
    const m = /^\s*test result:\s+(?:ok|FAILED)\.\s+(.*)$/.exec(l);
    if (!m) continue;
    seen = true;
    for (const c of m[1].matchAll(/(\d+)\s+(passed|failed|ignored|filtered out|measured)/g)) {
      const n = Number(c[1]);
      if (c[2] === 'passed') counts.passed += n;
      else if (c[2] === 'failed') counts.failed += n;
      else if (c[2] === 'ignored') counts.skipped += n;
    }
  }
  if (!seen) return undefined;
  const failingFiles: string[] = [];
  for (const l of lines) {
    const m = /^\s*test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/.exec(l);
    if (m) failingFiles.push(m[1]);
  }
  return { runner: 'cargo', ...counts, failingFiles: uniq(failingFiles) };
}

/* ------------------------------------------------------------------ go */

function parseGo(lines: string[]): TestCounts | undefined {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let okPkgs = 0;
  const failPkgs: string[] = [];
  let seen = false;
  for (const l of lines) {
    let m = /^\s*--- (PASS|FAIL|SKIP):\s+(\S+)/.exec(l);
    if (m) {
      seen = true;
      if (m[1] === 'PASS') pass++;
      else if (m[1] === 'FAIL') fail++;
      else skip++;
      continue;
    }
    m = /^ok\s+(\S+)\s+(?:\(cached\)|[\d.]+s)/.exec(l);
    if (m) {
      seen = true;
      okPkgs++;
      continue;
    }
    m = /^FAIL\s+(\S+)(?:\s+\[.*\]|\s+[\d.]+s)?\s*$/.exec(l);
    if (m) {
      seen = true;
      failPkgs.push(m[1]);
      continue;
    }
    if (/^(PASS|FAIL)\s*$/.test(l) || /^\?\s+\S+\s+\[no test files\]/.test(l)) seen = true;
  }
  if (!seen) return undefined;
  // Without -v there are no "--- PASS" lines; fall back to package counts.
  const passed = pass > 0 ? pass : okPkgs;
  const failed = fail > 0 ? fail : failPkgs.length;
  return { runner: 'go', passed, failed, skipped: skip, failingFiles: uniq(failPkgs) };
}

/* ----------------------------------------------------------- node:test */

function parseNodeTest(lines: string[], opts: ParseOptions): TestCounts | undefined {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let seen = false;
  for (const l of lines) {
    const m = /^\s*(?:#|ℹ)\s+(pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/.exec(l);
    if (!m) continue;
    seen = true;
    const n = Number(m[2]);
    if (m[1] === 'pass') counts.passed = n;
    else if (m[1] === 'fail' || m[1] === 'cancelled') counts.failed += n;
    else counts.skipped += n;
  }
  if (!seen) return undefined;
  const failingFiles: string[] = [];
  for (const l of lines) {
    // TAP: "not ok 1 - /abs/test/x.test.js"   spec reporter: "✖ /abs/test/x.test.js (12ms)"
    const m = /^\s*(?:not ok\s+\d+\s+-\s+|✖\s+)(\S+)/.exec(l);
    if (m && TEST_PATH_EXT.test(m[1])) failingFiles.push(relativize(m[1], opts.projectDir));
    // TAP:  "location: '/abs/test/x.test.mjs:3:1'"
    // spec (Node ≥ 20 default reporter, also when piped): "test at test/x.test.mjs:3:1" under "✖ failing tests:"
    const loc = /^\s*(?:test at|location|at):?\s+'?(\S+?\.(?:[cm]?[jt]sx?)):\d+/.exec(l);
    if (loc) failingFiles.push(relativize(loc[1], opts.projectDir));
  }
  return { runner: 'node-test', ...counts, failingFiles: uniq(failingFiles) };
}

/* ---------------------------------------------------------- playwright */

/**
 * Playwright list/dot reporter:
 *   "Running 3 tests using 1 worker"
 *   "  ✘  2 [chromium] › tests/login.spec.ts:5:1 › login fails (800ms)"
 *   "  1) [chromium] › tests/login.spec.ts:5:1 › login fails ────"
 *   "  1 failed" / "  1 flaky" / "  2 skipped" / "  3 passed (2.3s)" / "  1 did not run"
 */
function parsePlaywright(lines: string[], opts: ParseOptions): TestCounts | undefined {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let seenRun = false;
  let seenSummary = false;
  for (const l of lines) {
    if (/^\s*Running\s+\d+\s+tests?\s+using\s+\d+\s+workers?/.test(l)) seenRun = true;
    const m = /^\s*(\d+)\s+(passed|failed|flaky|skipped|did not run|interrupted)\b/.exec(l);
    if (!m) continue;
    seenSummary = true;
    const n = Number(m[1]);
    if (m[2] === 'passed' || m[2] === 'flaky') counts.passed += n;
    else if (m[2] === 'failed' || m[2] === 'interrupted') counts.failed += n;
    else counts.skipped += n;
  }
  if (!seenSummary || !(seenRun || lines.some((l) => /›\s+\S+\.(?:spec|test)\.[cm]?[jt]sx?:\d+:\d+\s+›/.test(l)))) return undefined;
  const failingFiles: string[] = [];
  for (const l of lines) {
    // "✘  2 [chromium] › tests/x.spec.ts:5:1 › name" or "1) [chromium] › tests/x.spec.ts:5:1 › name" (project tag optional)
    const m = /^\s*(?:✘|×|✖|\d+\))\s+(?:\d+\s+)?(?:\[[^\]]*\]\s+›\s+)?(\S+?):\d+:\d+\s+›/.exec(l);
    if (m && TEST_PATH_EXT.test(m[1])) failingFiles.push(relativize(m[1], opts.projectDir));
  }
  return { runner: 'playwright', ...counts, failingFiles: uniq(failingFiles) };
}

/* ------------------------------------------------------------- cypress */

/**
 * `cypress run`, default terminal ("spec") reporter. Built from Cypress's
 * documented / widely-mirrored CI output format — this sandbox has no
 * working Electron runtime to execute a real `cypress run` against (the
 * downloaded Cypress.app's framework symlinks come through flattened /
 * broken here), so unlike the other parsers in this file this one was NOT
 * verified against live output. Flagged rather than silently guessed; if a
 * real capture ever surfaces a mismatch, this comment is where to look.
 *
 * Per spec file, Cypress prints ordinary mocha-style progress ("N passing" /
 * "N failing" — why this must be tried BEFORE `parseMocha` in the OR-chain,
 * or a cypress run would misparse as bare mocha) followed by a bordered
 * "(Results)" box:
 *
 *   Running:  cypress/e2e/login.cy.js                                    (1 of 2)
 *   ...
 *     1 passing (1s)
 *     1 failing
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ Tests:        2                                                │
 *   │ Passing:      1                                                │
 *   │ Failing:      1                                                │
 *   │ Pending:      0                                                │
 *   │ Skipped:      0                                                │
 *   │ Spec Ran:     cypress/e2e/login.cy.js                          │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * then, after every spec, a final aggregate table with one ✔/✖ row per
 * spec plus a totals row. Summing the per-spec boxes (Passing/Failing/
 * Pending/Skipped) is simpler and more robust than parsing that table's
 * column-positioned totals, and gives the same numbers.
 */
function parseCypress(lines: string[], opts: ParseOptions): TestCounts | undefined {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let sawPassing = false;
  let sawFailing = false;
  const failingFiles: string[] = [];
  let currentSpec: string | undefined;
  // `Failing: N` for the box currently open, not yet attributed to a spec —
  // attribution happens at `Spec Ran:` (preferred) or when the box closes.
  let pendingFailing: number | undefined;

  const closeBox = (specPath: string | undefined): void => {
    if (pendingFailing !== undefined && pendingFailing > 0 && specPath) {
      failingFiles.push(relativize(specPath, opts.projectDir));
    }
    pendingFailing = undefined;
  };

  for (const l of lines) {
    const running = /^\s*Running:\s+(\S+)/.exec(l);
    if (running) {
      closeBox(currentSpec); // in case a previous box never got a "Spec Ran:" line
      currentSpec = running[1];
      continue;
    }
    const passing = /^\s*(?:│\s*)?Passing:\s+(\d+)\s*│?\s*$/.exec(l);
    if (passing) {
      counts.passed += Number(passing[1]);
      sawPassing = true;
      continue;
    }
    const failing = /^\s*(?:│\s*)?Failing:\s+(\d+)\s*│?\s*$/.exec(l);
    if (failing) {
      counts.failed += Number(failing[1]);
      pendingFailing = Number(failing[1]);
      sawFailing = true;
      continue;
    }
    const pending = /^\s*(?:│\s*)?Pending:\s+(\d+)\s*│?\s*$/.exec(l);
    if (pending) {
      counts.skipped += Number(pending[1]);
      continue;
    }
    const skipped = /^\s*(?:│\s*)?Skipped:\s+(\d+)\s*│?\s*$/.exec(l);
    if (skipped) {
      counts.skipped += Number(skipped[1]);
      continue;
    }
    const specRan = /^\s*(?:│\s*)?Spec Ran:\s+(\S+)/.exec(l);
    if (specRan) {
      closeBox(specRan[1]);
      continue;
    }
  }
  closeBox(currentSpec); // the last box, if it never printed "Spec Ran:"
  if (!sawPassing || !sawFailing) return undefined;
  return { runner: 'cypress', ...counts, failingFiles: uniq(failingFiles) };
}

/* --------------------------------------------------------------- mocha */

function parseMocha(lines: string[], opts: ParseOptions): TestCounts | undefined {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  let seen = false;
  for (const l of lines) {
    let m = /^\s*(\d+)\s+passing\b/.exec(l);
    if (m) { counts.passed = Number(m[1]); seen = true; continue; }
    m = /^\s*(\d+)\s+failing\b/.exec(l);
    if (m) { counts.failed = Number(m[1]); seen = true; continue; }
    m = /^\s*(\d+)\s+pending\b/.exec(l);
    if (m) { counts.skipped = Number(m[1]); seen = true; continue; }
  }
  if (!seen) return undefined;
  const failingFiles: string[] = [];
  if (counts.failed > 0) {
    // Stack frames after the "N failing" header: "at Context.<anonymous> (test/x.test.js:12:5)"
    for (const l of lines) {
      const m = /\(?((?:[\w@.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?)):\d+:\d+\)?\s*$/.exec(l);
      if (m && /^\s*at\s/.test(l) && !/node_modules/.test(m[1]) && /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\./.test(m[1])) {
        failingFiles.push(relativize(m[1], opts.projectDir));
      }
    }
  }
  return { runner: 'mocha', ...counts, failingFiles: uniq(failingFiles) };
}
