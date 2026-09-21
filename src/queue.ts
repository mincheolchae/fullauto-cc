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
 * True when the task's two most recent COMPLETED attempts (within the
 * `baselineResetAtAttempt` window — a `fullauto retry` resets the streak,
 * since a human intervened between them) both deferred on the exact same
 * gate failure: same gate name, same exit code, the same captured output
 * byte-for-byte. Two independent real attempts — the second one given the
 * first one's failure as prior-attempt context in its own prompt — that
 * still produce IDENTICAL gate output is strong evidence a further
 * identical-cost retry will not converge either.
 *
 * Why this exists: `maxPasses`'s doc comment (types.ts) reasons that "the
 * no-progress guard makes the extra pass nearly free when nothing's
 * converging" — true for a run that is stuck AS A WHOLE, but not for a
 * single task stuck this way while every OTHER task keeps converging:
 * `noProgressInCurrentPass` only compares the pass-wide unresolved id SET,
 * so it never notices one task riding along for a full-cost subagent spawn
 * every remaining pass up to `maxPasses` on an outcome the last two
 * attempts already proved will not change. `next()` uses this to stop
 * offering the task up for another attempt; it stays `deferred` and is
 * promoted to `failed` by the normal end-of-run "still unresolved" sweep,
 * same as any task that exhausts `maxPasses` — this only moves that point
 * earlier once the evidence is unambiguous, and only for the one task.
 */
export function stuckOnIdenticalGateFailure(task: Task): boolean {
  const floor = task.baselineResetAtAttempt ?? 0;
  const completed = task.attempts.filter((a, i) => i >= floor && a.finishedAt !== undefined);
  if (completed.length < 2) return false;
  const last = completed[completed.length - 1];
  const prev = completed[completed.length - 2];
  const lastGate = reportedFailedGate(last);
  const prevGate = reportedFailedGate(prev);
  if (!lastGate || !prevGate) return false;
  return (
    lastGate.name === prevGate.name &&
    lastGate.exitCode === prevGate.exitCode &&
    lastGate.output === prevGate.output
  );
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
   * Also excludes a task whose last two attempts failed on the exact same
   * gate (`stuckOnIdenticalGateFailure`) — see that function's doc comment.
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
        !stuckOnIdenticalGateFailure(t)
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
