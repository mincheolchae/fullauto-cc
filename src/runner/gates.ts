import { spawn } from 'node:child_process';
import { inferGateRole } from '../types.js';
import type { Gate, GateResult, RunConfig, ShellGate } from '../types.js';
import type { RedTestRecord, TaskClassification, TestCounts } from '../audit/types.js';
import { failureMatchesFiles } from '../audit/test-output.js';
import { runHttpGate } from './gates/http.js';
import { runConvexFnGate } from './gates/convex-fn.js';
import { detachedSpawnOptions, terminateProcessGroup, track } from './process-group.js';

interface RunCommandResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

// Per-gate cap (default 30min). Raised from 10min under accuracy > speed:
// monorepo `tsc --build` cold-build, full jest/vitest with coverage, and
// e2e suites (playwright/cypress) routinely sit in the 10–25min band. A
// 10min cap killed healthy runs mid-test, then the next pass repeated the
// timeout — pure churn. Cost worry is "runaway gate burns 30min" but real
// gates terminate when the work ends; 30min only fires on actually stuck
// processes. Users who know their suite is fast can shrink it per-gate via
// the `timeoutSec` field on the gate.
const DEFAULT_SHELL_TIMEOUT_SEC = 1800;

function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // `shell: true` means `sh -c <command>` forks the real runner; spawning
    // the gate as its own process group lets the timeout (and a Ctrl-C, see
    // process-group.ts) kill the runner too, not just the shell.
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...detachedSpawnOptions(),
    });
    track(child);

    const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB — prevents OOM on runaway output
    let bufferBytes = 0;
    const buffer: string[] = [];
    const collect = (d: Buffer) => {
      const s = d.toString('utf-8');
      buffer.push(s);
      bufferBytes += s.length;
      // Keep only the most-recent 2MB so `slice(-8000)` still sees the tail.
      while (bufferBytes > MAX_BUFFER_BYTES && buffer.length > 1) {
        bufferBytes -= buffer.shift()!.length;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      sigkillTimer = terminateProcessGroup(child, 3000);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearTimeout(sigkillTimer);
      resolve({
        exitCode: -1,
        output: `${buffer.join('')}\n[gate-runner] spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(sigkillTimer);
      resolve({
        exitCode: code ?? -1,
        output: buffer.join(''),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runShellGate(
  gate: ShellGate,
  projectDir: string
): Promise<GateResult> {
  const cwd = gate.cwd ?? projectDir;
  const timeoutSec = gate.timeoutSec ?? DEFAULT_SHELL_TIMEOUT_SEC;

  if (gate.skipIf) {
    const probe = await runCommand(gate.skipIf, cwd, 30);
    if (probe.exitCode === 0) {
      return {
        name: gate.name,
        passed: true,
        command: gate.command,
        exitCode: 0,
        output: `[skipped: skipIf check exited 0 — ${gate.skipIf}]`,
        durationMs: probe.durationMs,
        skipped: true,
      };
    }
  }

  const r = await runCommand(gate.command, cwd, timeoutSec);
  return {
    name: gate.name,
    passed: r.exitCode === 0,
    command: gate.command,
    exitCode: r.exitCode,
    // Cap visible output at ~32KB tail. Jest snapshot diffs, pytest assertion
    // dumps, tsc multi-error reports, and lint runs routinely exceed 8KB —
    // the prior cap clipped the actual failure off the bottom and left only
    // setup noise. The full 2MB upstream buffer is still enforced; this is
    // just the slice that ships into state.json (and thus into the next-pass
    // implementer prompt via deferDetail). 32KB is the accuracy/cost knee.
    output: r.output.slice(-32_000),
    durationMs: r.durationMs,
  };
}

async function runOneGate(
  gate: Gate,
  projectDir: string
): Promise<GateResult> {
  switch (gate.type) {
    case 'shell':
      return runShellGate(gate, projectDir);
    case 'http':
      return runHttpGate(gate);
    case 'convex-fn':
      return runConvexFnGate(gate, projectDir);
  }
}

export async function runGates(
  config: RunConfig,
  projectDir: string
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of config.gates) {
    const r = await runOneGate(gate, projectDir);
    // Stamp the role once here so evaluateGates / the audit / the reporter
    // all agree on which result is "the test gate" without each re-guessing
    // from the name. Http/convex gates have no `role` field and infer from
    // name alone.
    results.push({ ...r, role: inferGateRole(gate) });
  }
  return results;
}

export function summarizeGates(gates: GateResult[]): string {
  if (gates.length === 0) return '(no gates configured)';
  return gates
    .map((g) => {
      // `~` marks a raw failure whose effective verdict was rewritten by
      // evaluateGates (quarantined red tests / expected TDD red failure) so
      // a "✗ test" next to "DONE" doesn't read as a contradiction.
      const mark = g.passed ? '✓' : g.note ? '~' : '✗';
      const skipped = g.skipped ? ', skipped' : '';
      return `${mark} ${g.name} (exit ${g.exitCode}, ${g.durationMs}ms${skipped})`;
    })
    .join(', ');
}

// ---------- gate output summary ----------

/** Lines worth keeping from a failed gate's output: runner verdicts, assertion / compiler errors. */
export const GATE_SUMMARY_MATCH = /not ok|FAIL|Error|error TS|✗|assert|panic|Traceback/;
/** The tail always kept — a runner's summary block lives there. */
export const GATE_SUMMARY_TAIL_LINES = 15;
/** Cap on the summary that lands in deferDetail (and thus in the retry prompt + the report). */
export const GATE_SUMMARY_MAX_BYTES = 8 * 1024;

export interface GateOutputSummary {
  text: string;
  /** Lines of the original output that are not in `text`. */
  omitted: number;
}

/**
 * Condense a failed gate's output for deferDetail: every line matching
 * `GATE_SUMMARY_MATCH` plus the last `GATE_SUMMARY_TAIL_LINES` lines, in
 * original order with `… (n lines omitted)` markers between the runs, capped
 * at `GATE_SUMMARY_MAX_BYTES` by dropping the EARLIEST matched lines first
 * (the tail and the latest failures matter most). The full output stays in
 * the gate log file and in `gateResults[].output`.
 */
export function summarizeGateOutput(output: string, maxBytes = GATE_SUMMARY_MAX_BYTES): GateOutputSummary {
  const lines = output.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
  const tailStart = Math.max(0, lines.length - GATE_SUMMARY_TAIL_LINES);
  const matched: number[] = [];
  for (let i = 0; i < tailStart; i++) if (GATE_SUMMARY_MATCH.test(lines[i])) matched.push(i);

  const render = (kept: number[]): string => {
    const out: string[] = [];
    let prev = -1;
    for (const i of kept) {
      if (i > prev + 1) out.push(`… (${i - prev - 1} line${i - prev - 1 === 1 ? '' : 's'} omitted)`);
      out.push(lines[i]);
      prev = i;
    }
    return out.join('\n');
  };
  const tail = Array.from({ length: lines.length - tailStart }, (_, k) => tailStart + k);
  let head = matched;
  let text = render([...head, ...tail]);
  while (Buffer.byteLength(text, 'utf-8') > maxBytes && head.length > 0) {
    head = head.slice(1);
    text = render([...head, ...tail]);
  }
  if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
    // A single enormous line (minified stack, snapshot dump): keep its end.
    const buf = Buffer.from(text, 'utf-8');
    text = `… (truncated)\n${buf.subarray(buf.length - maxBytes).toString('utf-8')}`;
  }
  return { text, omitted: lines.length - head.length - tail.length };
}

// ---------- quarantine-aware evaluation ----------

export interface GateEvalContext {
  classification: TaskClassification;
  /** Red sets currently in state (expected-failing test files). */
  redTests: RedTestRecord[];
  /** Runner-output parser (src/audit/test-output.ts) — injected for testability. */
  parseTestOutput: (output: string) => TestCounts;
}

export interface GateEvaluation {
  /** Effective verdict: every gate passed, possibly after quarantine. */
  passed: boolean;
  /** First gate that really failed (undefined when `passed`). */
  failedGate?: GateResult;
  /** Human-readable note when a test-gate failure was quarantined. */
  quarantineNote?: string;
  /**
   * When `failedGate` is a test gate: the failing files that ARE quarantined
   * red sets (some, but not all, of its failures). The implementer must be
   * told those are expected and not theirs to fix.
   */
  partialQuarantine?: string[];
  /** Parsed counts from the test-role gate, when one ran and was recognized. */
  testCounts?: TestCounts;
  /**
   * For TDD red tasks only: `true` when the test gate failed with at least
   * one non-quarantined failure (the expected red outcome), `false` when a
   * test gate ran and passed (tests don't exercise unimplemented behavior),
   * `undefined` when no test gate actually ran (skipped / not configured).
   */
  redTestGateFailed?: boolean;
}

/**
 * Evaluate raw gate results in the light of the task's TDD phase.
 *
 * A failed gate with role `test` is treated as PASSED-WITH-QUARANTINE when the
 * parser attributed every failure to a file written by a red task that is
 * still waiting for its green task — those failures are the design, not a
 * regression. The quarantine set excludes the current green task's own red
 * sets (its whole job is to make those pass) and never includes the current
 * red task's files (they don't exist in state yet). When the parser cannot
 * attribute failures (unknown runner, or failed>0 with no file list) the
 * failure is real — an unattributable failure must never be excused.
 *
 * For a red task the test gate failing is the SUCCESS path: it is recorded
 * as `redTestGateFailed` rather than as `failedGate`. Every other gate
 * (typecheck / lint / build) must still pass.
 *
 * Mutates `note` on the affected GateResult so state.json shows why a raw
 * failure did not defer the task.
 */
export function evaluateGates(results: GateResult[], ctx: GateEvalContext): GateEvaluation {
  const { classification: cls } = ctx;
  const quarantineable = cls.tdd === 'green'
    ? ctx.redTests.filter((r) => !cls.redTaskIds.includes(r.taskId))
    : ctx.redTests;
  const quarantinePaths = quarantineable.flatMap((r) => r.files.map((f) => f.path));

  let testCounts: TestCounts | undefined;
  let redTestGateFailed: boolean | undefined;
  const notes: string[] = [];

  const noteText = () => (notes.length ? notes.join('; ') : undefined);

  for (const r of results) {
    const role = r.role ?? inferGateRole(r);
    // e2e gates get the same quarantine treatment (a red set may be an e2e
    // spec) but only the unit/integration `test` gate feeds the baseline
    // counts — mixing two runners' totals would make the test-count check
    // meaningless.
    if (role !== 'test' && role !== 'e2e') {
      if (!r.passed) return { passed: false, failedGate: r, quarantineNote: noteText(), testCounts, redTestGateFailed };
      continue;
    }
    if (r.skipped) continue;
    const counts = ctx.parseTestOutput(r.output);
    if (role === 'test' && counts.runner !== 'unknown') testCounts = counts;
    if (r.passed) {
      if (cls.tdd === 'red' && redTestGateFailed === undefined) redTestGateFailed = false;
      continue;
    }

    const attributable = counts.runner !== 'unknown' && counts.failingFiles.length > 0;
    const quarantined = attributable
      ? counts.failingFiles.filter((f) => failureMatchesFiles(f, quarantinePaths, counts.runner))
      : [];
    const allQuarantined = attributable && quarantined.length === counts.failingFiles.length;

    if (allQuarantined) {
      r.note = `quarantined red tests: ${quarantined.join(', ')}`;
      notes.push(`${r.name}: ${r.note}`);
      if (cls.tdd === 'red' && redTestGateFailed === undefined) redTestGateFailed = false;
      continue;
    }
    if (cls.tdd === 'red') {
      // Expected: the red task's own tests are failing. Anything the
      // audit's tdd-red check needs (are the failures in files THIS task
      // added?) is decided there; here we only refuse to defer.
      const own = attributable
        ? counts.failingFiles.filter((f) => !quarantined.includes(f))
        : [];
      r.note = own.length
        ? `expected failure (TDD red): ${own.join(', ')}`
        : `expected failure (TDD red): ${counts.failed || 'unattributed'} failing`;
      notes.push(`${r.name}: ${r.note}`);
      redTestGateFailed = true;
      continue;
    }
    return {
      passed: false,
      failedGate: r,
      quarantineNote: noteText(),
      testCounts,
      redTestGateFailed,
      partialQuarantine: quarantined.length ? quarantined : undefined,
    };
  }

  return { passed: true, quarantineNote: noteText(), testCounts, redTestGateFailed };
}

export function allGatesPassed(gates: GateResult[]): boolean {
  return gates.every((g) => g.passed);
}

export function firstFailedGate(gates: GateResult[]): GateResult | undefined {
  return gates.find((g) => !g.passed);
}
