import type { GateResult, RunState, Task, TaskAttempt, TaskStatus } from './types.js';

/**
 * Parses the `Gate "<name>" failed (exit <code>)` header every `gate_failed`
 * deferDetail starts with (the ONE call site is orchestrator.ts's
 * `settleDefer('gate_failed', ...)` in the gate-failure branch of
 * `processOneTask`).
 */
const GATE_FAILURE_HEADER_RE = /^Gate "([^"]+)" failed \(exit (-?\d+)\)/;

/**
 * The specific gate `evaluateGates` reported as the cause of a `gate_failed`
 * defer, re-identified from the attempt's own `deferDetail` header rather
 * than scanning `gateResults` for any `passed: false` entry — more than one
 * configured gate can fail raw in the same attempt (e.g. typecheck AND
 * test), and `evaluateGates` reports only the first non-quarantined one;
 * that is the one whose output actually reached the subagent as the retry
 * hint, so it is the one worth comparing across attempts.
 */
function reportedFailedGate(attempt: TaskAttempt): GateResult | undefined {
  if (attempt.deferReason !== 'gate_failed' || !attempt.deferDetail) return undefined;
  const m = GATE_FAILURE_HEADER_RE.exec(attempt.deferDetail);
  if (!m) return undefined;
  const [, name, exitCodeStr] = m;
  return attempt.gateResults.find((g) => g.name === name && g.exitCode === Number(exitCodeStr));
}

/**
 * Run-to-run noise that must not make two identical failures look different:
 * durations ("in 1.42s", "Duration 121.08s", "(35ms)"), ISO timestamps and
 * wall-clock times. Counts ("3 failed") are deliberately kept — a changing
 * count is progress.
 */
function normalizeNoise(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds)\b/g, '<dur>');
}

/**
 * What a deterministic failure "looks like" — equal signatures on two
 * consecutive real attempts mean the retry changed nothing. `undefined` for
 * failure kinds where a repeat is plausibly flaky or environmental
 * (`rate_limited`, a non-timeout `subagent_error`) or carries no signal.
 *
 *  - `gate_failed`: failing gate + exit code + normalized output.
 *  - `audit_failed`: the sorted BLOCK set (check, path, message).
 *  - `verify_loop_blocks_remaining`: the sorted `unmet:` bullets plus the
 *    `last-attempt:` fix tried — the same gap, the same fix, twice.
 *  - `tdd_red_expected`: the test counts plus the set of files touched.
 *  - `subagent_error` that timed out: a timeout is deterministic cost —
 *    the same prompt under the same limit is the same 60 minutes.
 */
function failureSignature(attempt: TaskAttempt): string | undefined {
  const detail = attempt.deferDetail ?? '';
  switch (attempt.deferReason) {
    case 'gate_failed': {
      const g = reportedFailedGate(attempt);
      return g ? `gate|${g.name}|${g.exitCode}|${normalizeNoise(g.output)}` : undefined;
    }
    case 'audit_failed': {
      const blocks = (attempt.audit?.findings ?? [])
        .filter((f) => f.severity === 'block')
        .map((f) => `${f.check}|${f.path ?? ''}|${f.message}`)
        .sort();
      return blocks.length > 0 ? `audit|${blocks.join('\n')}` : undefined;
    }
    case 'verify_loop_blocks_remaining': {
      // `unmet:` bullets are often coarse requirement lines, so the fix the
      // attempt tried (`last-attempt:`) is part of the identity: a different
      // attempt against the same bullet is still progress. No `unmet:` at all
      // (a generic cause) carries no signal.
      const unmet = [...detail.matchAll(/\bunmet:\s*([^|]+)/g)].map((m) => m[1].trim()).sort();
      if (unmet.length === 0) return undefined;
      const tried = [...detail.matchAll(/\blast-attempt:\s*([^|]+)/g)].map((m) => m[1].trim());
      return `verify|${unmet.join('\n')}|${tried.join('\n')}`;
    }
    case 'tdd_red_expected': {
      // The message is a constant; what distinguishes two attempts is what
      // they wrote and what the test gate then said.
      const touched = (attempt.touched ?? []).map((t) => t.path).sort();
      if (touched.length === 0) return undefined;
      return `red|${attempt.tdd?.passed ?? ''}|${attempt.tdd?.failing ?? ''}|${touched.join('\n')}`;
    }
    case 'subagent_error':
      return /^Subagent timed out\b/.test(detail) ? 'timeout' : undefined;
    default:
      return undefined;
  }
}

/** Attempts that actually ran a subagent (not the orchestrator's "still pending at pass end" placeholders). */
function realCompletedAttempts(task: Task): TaskAttempt[] {
  const floor = task.baselineResetAtAttempt ?? 0;
  return task.attempts.filter(
    (a, i) => i >= floor && a.finishedAt !== undefined && a.deferReason !== 'depends_on_unfinished_task'
  );
}

/**
 * True when the task's two most recent real COMPLETED attempts (within the
 * `baselineResetAtAttempt` window — a `fullauto retry` resets the streak,
 * since a human intervened between them) failed in the SAME deterministic
 * way (`failureSignature`): the same gate with the same output, the same
 * audit BLOCKs, the same unmet requirement bullets, or a timeout twice.
 * Two independent real attempts — the second one given the first one's
 * failure as prior-attempt context in its own prompt — that still produce an
 * IDENTICAL failure are strong evidence a further identical-cost retry will
 * not converge either.
 *
 * Why this exists: `maxPasses`'s doc comment (types.ts) reasons that "the
 * no-progress guard makes the extra pass nearly free when nothing's
 * converging" — true for a run that is stuck AS A WHOLE, but not for a
 * single task stuck this way while every OTHER task keeps converging:
 * `noProgressInCurrentPass` only compares the pass-wide unresolved id SET,
 * so it never notices one task riding along for a full-cost subagent spawn
 * (a high-risk one is an implementer plus a whole reviewer set) every
 * remaining pass on an outcome the last two attempts already proved will
 * not change. `next()` uses this to stop offering the task up for another
 * attempt; it stays `deferred` and is promoted to `failed` by the normal
 * end-of-run "still unresolved" sweep, same as any task that exhausts
 * `maxPasses` — this only moves that point earlier once the evidence is
 * unambiguous, and only for the one task. Placeholder attempts do not count
 * and do not break the streak. (The name predates the non-gate signatures.)
 */
export function stuckOnIdenticalGateFailure(task: Task): boolean {
  const completed = realCompletedAttempts(task);
  if (completed.length < 2) return false;
  const last = failureSignature(completed[completed.length - 1]);
  const prev = failureSignature(completed[completed.length - 2]);
  return last !== undefined && last === prev;
}

/**
 * Optional synthetic passes get fewer real attempts than user tasks: an
 * ENHANCE pass is a "nice to have" research subagent that spawns its own
 * nested reviewers, so a failed one is not worth `maxPasses` retries; a
 * VERIFY pass is a real review of the group, so it gets one retry.
 */
const SYNTHETIC_MAX_ATTEMPTS: Partial<Record<Task['kind'], number>> = { enhance: 1, verify: 2 };

export function syntheticAttemptsExhausted(task: Task): boolean {
  const cap = SYNTHETIC_MAX_ATTEMPTS[task.kind];
  return cap !== undefined && realCompletedAttempts(task).length >= cap;
}

export class TaskQueue {
  constructor(private readonly state: RunState) {}

  get tasks(): Task[] {
    return this.state.tasks;
  }

  byId(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  /**
   * Pick the next task to work on in the current pass.
   *
   * Eligibility:
   *  - Pass 1: status === 'pending' AND all dependencies are 'done'.
   *  - Pass >= 2: status === 'deferred' AND all dependencies are 'done'.
   *  - AND: no COMPLETED attempt in the current pass.
   *
   * The "no completed attempt in current pass" filter is what keeps the
   * inner loop bounded. In pass 1 it's redundant (a `pending` task
   * transitions to `done`/`deferred` after processOneTask, so the status
   * filter alone excludes it), but in pass >= 2 it is load-bearing: a task
   * that fails its gate stays `deferred`, so without this filter `next()`
   * would keep returning the same deferred task forever and the
   * end-of-pass no-progress / maxPasses guards would be unreachable. Each
   * task gets at most one COMPLETED attempt per pass; cross-pass retries
   * are how the orchestrator handles transient failures.
   *
   * "Completed" = `finishedAt` is set. An attempt that crashed mid-flight
   * (resume case: `in_progress → pending` reset by cli.ts) has no
   * `finishedAt`, so the task remains eligible — exactly what we want on
   * resume.
   *
   * Also excludes a task whose last two attempts failed in the exact same
   * deterministic way (`stuckOnIdenticalGateFailure`) and a synthetic
   * enhance / verify task past its small attempt cap
   * (`syntheticAttemptsExhausted`) — see those functions' doc comments.
   * It stays `deferred`, just never offered again; the end-of-run sweep
   * promotes it to `failed` like any other task that runs out of passes.
   *
   * Returns undefined when nothing in this pass is currently eligible.
   */
  next(): Task | undefined {
    const targetStatus: TaskStatus =
      this.state.currentPass === 1 ? 'pending' : 'deferred';
    const currentPass = this.state.currentPass;

    return this.state.tasks.find(
      (t) =>
        t.status === targetStatus &&
        this.dependenciesSatisfied(t) &&
        !t.attempts.some(
          (a) => a.passNumber === currentPass && a.finishedAt !== undefined
        ) &&
        !stuckOnIdenticalGateFailure(t) &&
        !syntheticAttemptsExhausted(t)
    );
  }

  /**
   * Tasks that are still unresolved at the END of the current pass.
   * Used to detect lack of progress between passes.
   */
  unresolvedIds(): string[] {
    return this.state.tasks
      .filter((t) => t.status === 'pending' || t.status === 'deferred')
      .map((t) => t.id);
  }

  /** All tasks have terminal status (done | failed). */
  isComplete(): boolean {
    return this.state.tasks.every(
      (t) => t.status === 'done' || t.status === 'failed'
    );
  }

  /**
   * Compare current unresolved set against the snapshot taken at the START of
   * this pass. If nothing moved, the pass made no progress.
   */
  noProgressInCurrentPass(): boolean {
    const snapshot = this.state.passSnapshots.find(
      (s) => s.pass === this.state.currentPass
    );
    if (!snapshot) return false;

    const current = new Set(this.unresolvedIds());
    const previous = new Set(snapshot.unresolvedIds);

    if (current.size !== previous.size) return false;
    for (const id of current) {
      if (!previous.has(id)) return false;
    }
    return true;
  }

  /**
   * Capture the unresolved-IDs snapshot for the start of the current pass.
   *
   * Idempotent — if a snapshot already exists for this pass, leave it alone.
   * This is critical for resume semantics: re-snapshotting on resume would
   * discard the original baseline and break `noProgressInCurrentPass`.
   */
  snapshotPassStart(): void {
    const existing = this.state.passSnapshots.find(
      (s) => s.pass === this.state.currentPass
    );
    if (existing) return;
    this.state.passSnapshots.push({
      pass: this.state.currentPass,
      unresolvedIds: this.unresolvedIds(),
    });
  }

  /** Advance to the next pass; deferred tasks become eligible again. */
  startNextPass(): void {
    this.state.currentPass += 1;
    this.snapshotPassStart();
  }

  setStatus(id: string, status: TaskStatus): void {
    const task = this.byId(id);
    if (!task) throw new Error(`No such task: ${id}`);
    task.status = status;
  }

  /** Convenience: deferred & failed tasks for the final report. */
  unresolvedTasks(): Task[] {
    return this.state.tasks.filter(
      (t) => t.status === 'deferred' || t.status === 'failed'
    );
  }

  dependenciesSatisfied(task: Task): boolean {
    return task.dependencies.every((depId) => {
      const dep = this.byId(depId);
      // Unknown dependency = treat as satisfied (parser may have stripped IDs).
      // Better to attempt than to deadlock.
      return !dep || dep.status === 'done';
    });
  }

  /**
   * Detect cycles in the dependency graph using iterative DFS.
   * Returns one representative cycle path string per cycle found, e.g.
   * "T001 → T003 → T001". Empty array = no cycles.
   */
  detectCycles(): string[] {
    const visited = new Set<string>();
    const cycles: string[] = [];

    const dfs = (id: string, stack: string[], onStack: Set<string>): void => {
      if (onStack.has(id)) {
        const start = stack.indexOf(id);
        cycles.push([...stack.slice(start), id].join(' → '));
        return;
      }
      if (visited.has(id)) return;
      visited.add(id);
      onStack.add(id);
      stack.push(id);
      const task = this.byId(id);
      if (task) {
        for (const depId of task.dependencies) {
          dfs(depId, stack, onStack);
        }
      }
      stack.pop();
      onStack.delete(id);
    };

    for (const task of this.state.tasks) {
      dfs(task.id, [], new Set());
    }
    return cycles;
  }
}
