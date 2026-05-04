import type { RunState, Task, TaskStatus } from './types.js';

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
   *
   * Returns undefined when nothing in this pass is currently eligible.
   */
  next(): Task | undefined {
    const targetStatus: TaskStatus =
      this.state.currentPass === 1 ? 'pending' : 'deferred';

    return this.state.tasks.find(
      (t) => t.status === targetStatus && this.dependenciesSatisfied(t)
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
}
