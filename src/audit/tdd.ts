/**
 * Cross-task TDD checks (DESIGN §5).
 *
 * Red task: must add/modify test files, the test gate must FAIL, and the
 * failures must be attributable to this task's test files.
 *
 * Green task: the red task's test files are the contract — hash must be
 * unchanged (or the implementer declared `FULLAUTO_TEST_CHANGE: <file> — <reason>`
 * which downgrades to WARN), none may be deleted, none may still fail.
 */
import { join } from 'node:path';
import { inferGateRole } from '../types.js';
import { extensionOf, normalizePath } from './patterns.js';
import { sha1File, sha1String } from './snapshot.js';
import { failureMatchesFiles, parseTestOutput } from './test-output.js';
import { countAssertions, countTestBlocks, sanitizeSource } from './test-integrity.js';
import type { GateResult } from '../types.js';
import type { AuditFinding, AuditInput, FileFingerprint, RedTestRecord, TaskDiff, TestCounts, TreeSnapshot } from './types.js';

/** The shared attribution matcher lives in `test-output.ts`; kept here as a re-export for existing importers. */
export { failureMatchesFile, failureMatchesFiles } from './test-output.js';

type GateLike = GateResult & { role?: GateResult['role']; note?: string };

/**
 * Locate the unit/integration test gate. Same rule as the orchestrator's
 * `evaluateGates`: explicit `role` wins, else `inferGateRole` on the name —
 * ONE source of truth, so a gate the orchestrator treats as `test` (and
 * quarantines / feeds the baseline from) is the one the TDD checks read.
 */
export function findTestGate(gates: GateResult[]): GateLike | undefined {
  return findByRole(gates, 'test');
}

/** Locate the e2e gate (playwright / cypress): explicit `role: 'e2e'`, else `inferGateRole`. */
export function findE2eGate(gates: GateResult[]): GateLike | undefined {
  return findByRole(gates, 'e2e');
}

/** An explicitly labelled gate beats one whose role is only inferred from its name. */
function findByRole(gates: GateResult[], role: 'test' | 'e2e'): GateLike | undefined {
  const list = (gates as GateLike[]).filter((g) => g && typeof g.name === 'string');
  return list.find((g) => g.role === role) ?? list.find((g) => !g.role && inferGateRole(g) === role);
}

function taskTestFiles(diff: TaskDiff): string[] {
  return diff.files.filter((f) => f.isTest && f.isCode && f.kind !== 'deleted').map((f) => normalizePath(f.path));
}

/**
 * Is every failure of `counts` attributable to a red set OTHER than this
 * task's (i.e. the orchestrator quarantined the gate)? Decided from the
 * structured `failingFiles` first; the gate's free-text `note` is only a
 * fallback for runners whose output could not be attributed.
 */
function isQuarantined(gate: GateLike, counts: TestCounts, otherRedFiles: string[]): boolean {
  if (counts.runner !== 'unknown' && counts.failingFiles.length > 0) {
    return counts.failingFiles.every((ff) => failureMatchesFiles(ff, otherRedFiles, counts.runner));
  }
  return typeof gate.note === 'string' && /quarantin/i.test(gate.note);
}

export function checkTddRed(input: AuditInput, diff: TaskDiff, counts: TestCounts | undefined): AuditFinding[] {
  const cls = input.classification;
  if (cls.tdd !== 'red') return [];
  const findings: AuditFinding[] = [];

  const testFiles = taskTestFiles(diff);
  if (testFiles.length === 0) {
    findings.push({
      check: 'tdd-red',
      severity: 'block',
      message: 'red task added no test file — a red task must write failing tests (a file matched by the test-file patterns: *.test.*, tests/, test_*.py, *_test.go ...)',
    });
  }

  // A red task may write unit tests OR e2e specs (`- level: e2e`): either the
  // test-role gate or the e2e-role gate failing on this task's files is the red state.
  const testGate = findTestGate(input.gateResults);
  const e2eGate = findE2eGate(input.gateResults);
  const gates = [testGate, e2eGate].filter((g): g is GateLike => !!g && g !== undefined);
  const unique = gates.filter((g, i) => gates.indexOf(g) === i);
  if (unique.length === 0) {
    findings.push({
      check: 'tdd-red',
      severity: 'info',
      message: 'no test gate configured (name matching /test|spec|vitest|jest|pytest/ or role=test, or an e2e gate) — cannot confirm the red phase; add a test gate to .fullauto/config.json',
    });
    return findings;
  }

  // Red sets of OTHER tasks: failures attributable only to those are the
  // orchestrator's quarantine, not this task's red state.
  const otherRedFiles = (input.redTests ?? []).filter((r) => r.taskId !== input.task.id).flatMap((r) => r.files.map((f) => normalizePath(f.path)));
  interface RedGate { gate: GateLike; counts: TestCounts; quarantined: boolean; failing: boolean }
  const states: RedGate[] = unique.map((gate) => {
    const parsed = gate === testGate && counts ? counts : parseTestOutput(gate.output, { projectDir: input.projectDir });
    const quarantined = !gate.passed && isQuarantined(gate, parsed, otherRedFiles);
    return { gate, counts: parsed, quarantined, failing: !gate.passed && !quarantined };
  });

  const failing = states.filter((s) => s.failing);
  if (failing.length === 0) {
    const names = unique.map((g) => `"${g.name}"`).join(' / ');
    findings.push({
      check: 'tdd-red',
      severity: 'block',
      message: `red task's test gate ${names} PASSED — the new tests do not exercise unimplemented behavior. Either the implementation already exists (mark the task \`- tdd: none\`) or the tests are tautological / never run; make them fail against the current code`,
    });
    return findings;
  }

  // The red state is proven by any failing gate whose failures are attributable to this task's files.
  const attributedBy = failing.find((s) => s.counts.runner !== 'unknown' && s.counts.failed > 0 && (testFiles.length === 0 || s.counts.failingFiles.some((ff) => failureMatchesFiles(ff, testFiles, s.counts.runner))));
  if (attributedBy) return findings;

  const zeroFailed = failing.filter((s) => s.counts.runner !== 'unknown' && s.counts.failed === 0);
  const unknown = failing.filter((s) => s.counts.runner === 'unknown');
  const misattributed = failing.filter((s) => s.counts.runner !== 'unknown' && s.counts.failed > 0 && s.counts.failingFiles.length > 0);
  const unattributable = failing.filter((s) => s.counts.runner !== 'unknown' && s.counts.failed > 0 && s.counts.failingFiles.length === 0);

  if (misattributed.length > 0 && testFiles.length > 0) {
    const s = misattributed[0];
    findings.push({
      check: 'tdd-red',
      severity: 'block',
      message: `red task: failing tests (${s.counts.failingFiles.slice(0, 5).join(', ')}) are not in this task's test files (${testFiles.slice(0, 5).join(', ')}) — the failure must come from the tests this task wrote; fix or quarantine unrelated failures first`,
    });
    return findings;
  }
  if (unattributable.length > 0) {
    // The runner reported failures but no file list (e.g. a load error): red is plausible, not proven.
    findings.push({
      check: 'tdd-red',
      severity: 'info',
      message: `red task: gate "${unattributable[0].gate.name}" reported ${unattributable[0].counts.failed} failing test(s) without file attribution; could not confirm they come from ${testFiles.join(', ') || 'this task'}`,
    });
    return findings;
  }
  if (zeroFailed.length > 0 && unknown.length === 0) {
    const s = zeroFailed[0];
    // vitest/jest report a test file that FAILED TO LOAD (import of a missing
    // stub) as `failed=0` with the file in `failingFiles`: 0 tests ran, so the
    // assertions never executed — that is not a red state, it is a broken one.
    const notLoaded = s.counts.failingFiles.filter((ff) => failureMatchesFiles(ff, testFiles, s.counts.runner));
    if (notLoaded.length > 0) {
      findings.push({
        check: 'tdd-red',
        severity: 'block',
        path: notLoaded[0],
        message: `red task: ${notLoaded.join(', ')} failed to load (0 tests ran) — add the minimal stub (exported signature that throws "not implemented") so the assertions execute and fail`,
      });
      return findings;
    }
    findings.push({
      check: 'tdd-red',
      severity: 'block',
      message: `red task: test gate "${s.gate.name}" reported 0 failing tests (${s.counts.runner}: ${s.counts.passed} passed) — the red tests must actually fail; the gate failure came from something else (see gate output)`,
    });
    return findings;
  }
  if (unknown.length > 0 && testFiles.length > 0) {
    findings.push({
      check: 'tdd-red',
      severity: 'info',
      message: `red task: gate "${unknown[0].gate.name}" failed but the runner output was not recognized; could not attribute failures to ${testFiles.join(', ')}`,
    });
  }

  return findings;
}

/**
 * Parse the implementer's `FULLAUTO_TDD: red=<n> green=<n>` evidence line.
 * The LAST matching line wins (the loop may print interim ones); tolerant
 * of surrounding whitespace, bold/backtick markdown and `red = 3` spacing.
 * Returns undefined when no line is present.
 */
export function parseTddEvidence(stdout: string): { red: number; green: number } | undefined {
  let found: { red: number; green: number } | undefined;
  for (const raw of (stdout ?? '').replace(/\r/g, '').split('\n')) {
    // Strip bold / code markdown (`**FULLAUTO_TDD: red=1 green=2**`) without touching the underscore in the tag itself.
    const line = raw.replace(/[*`]|(?<![A-Za-z])__|__(?![A-Za-z])/g, ' ').trim();
    const m = /FULLAUTO_TDD\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const red = /\bred\s*=\s*(\d+)/i.exec(m[1]);
    const green = /\bgreen\s*=\s*(\d+)/i.exec(m[1]);
    if (!red && !green) continue;
    found = { red: red ? Number(red[1]) : 0, green: green ? Number(green[1]) : 0 };
  }
  return found;
}

/**
 * Non-blocking surfacing of the TDD evidence line (DESIGN §7): a behavior
 * task that ends without it skipped the red→green protocol (WARN); a red
 * task claiming `red=0` / a green task claiming `green=0` contradicts its own
 * phase (INFO — the gate + tdd-red/tdd-green checks already decide).
 */
export function checkTddEvidence(cls: AuditInput['classification'], stdout: string): AuditFinding[] {
  const text = stdout ?? '';
  if (!text.trim()) return [];
  const evidence = parseTddEvidence(text);
  const behavior = cls.kind === 'impl' && cls.tdd === 'none' && !cls.testsDelegatedTo && !cls.noTestReason;
  if (!evidence) {
    if (!behavior) return [];
    return [
      {
        check: 'test-count',
        severity: 'warn',
        message: 'no FULLAUTO_TDD evidence line in the subagent output — end the message with `FULLAUTO_TDD: red=<n failing before impl> green=<n passing after impl>` (the red count is proof the test was run before the implementation)',
      },
    ];
  }
  if (cls.tdd === 'red' && evidence.red === 0) {
    return [{ check: 'test-count', severity: 'info', message: `FULLAUTO_TDD reports red=0 for a red task (line: red=${evidence.red} green=${evidence.green}) — the tests are expected to fail at this phase` }];
  }
  if (cls.tdd === 'green' && evidence.green === 0) {
    return [{ check: 'test-count', severity: 'info', message: `FULLAUTO_TDD reports green=0 for a green task (line: red=${evidence.red} green=${evidence.green}) — the red tests are expected to pass now` }];
  }
  if (behavior && evidence.red === 0) {
    return [{ check: 'test-count', severity: 'info', message: `FULLAUTO_TDD reports red=0 (line: red=${evidence.red} green=${evidence.green}) — the new tests were not observed failing before the implementation` }];
  }
  return [];
}

/** Parse `FULLAUTO_TEST_CHANGE: <file> — <reason>` lines (also accepts `-`, `--`, `:` separators). */
export function parseTestChangeNotices(stdout: string): Array<{ file: string; reason: string }> {
  const out: Array<{ file: string; reason: string }> = [];
  for (const line of (stdout ?? '').split('\n')) {
    const m = /FULLAUTO_TEST_CHANGE:\s*`?([^\s`—:]+(?::\d+)?)`?\s*(?:—|–|--|-|:)\s*(.*)$/.exec(line);
    if (m) out.push({ file: normalizePath(m[1].replace(/:\d+$/, '')), reason: m[2].trim() });
  }
  return out;
}

/** More declared red-file changes than this in ONE green task is rewriting the contract, not fixing it. */
export const MAX_TEST_CHANGES_PER_GREEN_TASK = 2;

/**
 * Did a red file lose test blocks / assertions between the red snapshot and
 * now? Compared on the task diff's `before` / `after` text (the before text is
 * the red-time content: dirty test files are retained in the snapshot, or
 * read from HEAD when the red task committed). Returns a short description,
 * or undefined when the change is neutral / additive or cannot be compared.
 */
function weakenedRedFile(file: TaskDiff['files'][number] | undefined, path: string): string | undefined {
  if (!file || file.before === undefined || file.after === undefined) return undefined;
  const before = sanitizeSource(file.before, path);
  const after = sanitizeSource(file.after, path);
  const blocksBefore = countTestBlocks(before);
  const blocksAfter = countTestBlocks(after);
  const assertsBefore = countAssertions(before);
  const assertsAfter = countAssertions(after);
  if (blocksAfter < blocksBefore || assertsAfter < assertsBefore) {
    return `${blocksBefore}→${blocksAfter} test blocks, ${assertsBefore}→${assertsAfter} assertions`;
  }
  return undefined;
}

async function currentHash(input: AuditInput, path: string): Promise<string | undefined> {
  const fp = input.after.dirty.get(path);
  if (fp) return fp.hash;
  try {
    return await sha1File(join(input.projectDir, path));
  } catch {
    return undefined;
  }
}

export async function checkTddGreen(input: AuditInput, diff: TaskDiff, counts: TestCounts | undefined): Promise<AuditFinding[]> {
  const cls = input.classification;
  if (cls.tdd !== 'green') return [];
  const findings: AuditFinding[] = [];

  let ids = cls.redTaskIds;
  if (ids.length === 0) ids = input.task.dependencies.filter((d) => input.redTests.some((r) => r.taskId === d));
  const records = input.redTests.filter((r) => ids.includes(r.taskId));
  if (records.length === 0) {
    findings.push({
      check: 'tdd-green',
      severity: 'info',
      message: `green task: no red test records found for ${ids.length ? ids.join(', ') : 'any dependency'} — nothing to verify against (the red task may not have run yet or already turned green)`,
    });
    return findings;
  }

  const notices = parseTestChangeNotices(input.subagentStdout);
  const noticeFor = (path: string) =>
    notices.find((n) => n.file === path || path.endsWith(`/${n.file}`) || n.file.endsWith(`/${path}`) || n.file === path.split('/').pop());

  const deletedPaths = new Set(diff.files.filter((f) => f.kind === 'deleted').map((f) => normalizePath(f.path)));
  const diffByPath = new Map(diff.files.map((f) => [normalizePath(f.path), f] as const));
  const redFiles: string[] = [];

  // First pass: which red files changed at all (hash) — the count decides
  // whether FULLAUTO_TEST_CHANGE can excuse any of them.
  interface RedFileState { rec: RedTestRecord; path: string; original: string; hash: string | undefined }
  const states: RedFileState[] = [];
  for (const rec of records) {
    for (const file of rec.files) {
      const path = normalizePath(file.path);
      redFiles.push(path);
      const hash = deletedPaths.has(path) ? undefined : await currentHash(input, path);
      states.push({ rec, path, original: file.hash, hash });
    }
  }
  const modified = states.filter((s) => s.hash !== undefined && s.hash !== s.original);
  const tooMany = modified.length > MAX_TEST_CHANGES_PER_GREEN_TASK;

  for (const { rec, path, original, hash } of states) {
    if (hash === undefined) {
      findings.push({
        check: 'tdd-green',
        severity: 'block',
        path,
        message: `red test file ${path} (written by ${rec.taskId}) was deleted — restore it; the red tests are the contract this task must satisfy`,
      });
      continue;
    }
    if (hash === original) continue;

    const notice = noticeFor(path);
    if (!notice) {
      findings.push({
        check: 'tdd-green',
        severity: 'block',
        path,
        message: `test tampering: ${path} written by ${rec.taskId} was modified — revert it; if the test was wrong, fix it and emit \`FULLAUTO_TEST_CHANGE: ${path} — <reason>\``,
      });
      continue;
    }
    if (tooMany) {
      findings.push({
        check: 'tdd-green',
        severity: 'block',
        path,
        message: `FULLAUTO_TEST_CHANGE abuse: ${modified.length} red test files changed in one green task (limit ${MAX_TEST_CHANGES_PER_GREEN_TASK}) — a contract that needs this many corrections is being rewritten, not fixed; revert ${path} (reason given: ${notice.reason || '(none)'})`,
      });
      continue;
    }
    // A declared change is only excusable when it did not weaken the contract:
    // the file must keep every test block and assertion it had at red time.
    const weakened = weakenedRedFile(diffByPath.get(path), path);
    if (weakened) {
      findings.push({
        check: 'tdd-green',
        severity: 'block',
        path,
        message: `FULLAUTO_TEST_CHANGE rejected for ${path} (written by ${rec.taskId}): the change weakened the test (${weakened}) — a declared fix may correct an expectation, never drop blocks or assertions; restore them (reason given: ${notice.reason || '(none)'})`,
      });
      continue;
    }
    findings.push({
      check: 'tdd-green',
      severity: 'warn',
      path,
      message: `red test file ${path} (written by ${rec.taskId}) was modified with FULLAUTO_TEST_CHANGE — reason: ${notice.reason || '(none given)'} — flagged for human review`,
    });
  }

  const gate = findTestGate(input.gateResults);
  const gateCounts = counts ?? (gate ? parseTestOutput(gate.output) : undefined);
  if (gateCounts && gateCounts.failingFiles.length > 0) {
    const still = gateCounts.failingFiles.filter((ff) => failureMatchesFiles(ff, redFiles, gateCounts.runner));
    if (still.length > 0) {
      findings.push({
        check: 'tdd-green',
        severity: 'block',
        path: still[0],
        message: `red tests still failing: ${still.slice(0, 5).join(', ')} — the green task must make ${ids.join(', ')}'s tests pass`,
      });
    }
  } else if (gate && !gate.passed && redFiles.length > 0 && (!gateCounts || gateCounts.runner === 'unknown')) {
    findings.push({
      check: 'tdd-green',
      severity: 'block',
      message: `test gate "${gate.name}" failed and the runner output could not be attributed — the red tests from ${ids.join(', ')} must pass`,
    });
  }

  return findings;
}

/**
 * Fingerprints of the test files this (red) task added or modified. When the
 * `after` snapshot is given its on-disk hashes are reused (exactly what a
 * later `takeSnapshot` will compute); otherwise the text is hashed.
 */
export function buildRedTestRecord(taskId: string, diff: TaskDiff, failing = 0, after?: TreeSnapshot): RedTestRecord {
  const files: FileFingerprint[] = [];
  for (const f of diff.files) {
    if (!f.isTest || !f.isCode || f.kind === 'deleted' || f.after === undefined) continue;
    if (!extensionOf(f.path)) continue;
    const path = normalizePath(f.path);
    const fp = after?.dirty.get(path);
    files.push(fp ? { path, hash: fp.hash, size: fp.size } : { path, hash: sha1String(f.after), size: Buffer.byteLength(f.after, 'utf-8') });
  }
  return { taskId, files, failing, recordedAt: new Date().toISOString() };
}
