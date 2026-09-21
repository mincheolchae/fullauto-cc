import { describe, it, expect } from 'vitest';
import { TaskQueue } from '../src/queue.js';
import { makeAttempt, makeState, makeTask } from './helpers/fixtures.js';

const finished = (pass: number) =>
  makeAttempt(pass, { finishedAt: new Date().toISOString() });

describe('TaskQueue.next — pass-aware eligibility', () => {
  it('pass 1 picks the first pending task in array order and ignores deferred ones', () => {
    const state = makeState([
      makeTask('T001', { status: 'deferred' }),
      makeTask('T002'),
      makeTask('T003'),
    ]);
    const q = new TaskQueue(state);
    expect(q.next()?.id).toBe('T002');
  });

  it('pass >= 2 picks only deferred tasks, never pending ones', () => {
    const state = makeState(
      [makeTask('T001'), makeTask('T002', { status: 'deferred' })],
      { currentPass: 2 }
    );
    const q = new TaskQueue(state);
    expect(q.next()?.id).toBe('T002');

    state.tasks[1].status = 'done';
    // T001 is still pending but invisible in pass 2 — the orchestrator's
    // maybeAdvancePass promotes such stragglers to deferred.
    expect(q.next()).toBeUndefined();
  });

  it('skips in_progress / done / failed tasks in either pass', () => {
    const state = makeState([
      makeTask('T001', { status: 'in_progress' }),
      makeTask('T002', { status: 'done' }),
      makeTask('T003', { status: 'failed' }),
    ]);
    const q = new TaskQueue(state);
    expect(q.next()).toBeUndefined();
    state.currentPass = 2;
    expect(q.next()).toBeUndefined();
  });

  it('returns undefined when nothing is eligible', () => {
    const q = new TaskQueue(makeState([makeTask('T001', { status: 'done' })]));
    expect(q.next()).toBeUndefined();
  });
});

describe('TaskQueue.next — dependency gating', () => {
  it('holds a task back until every dependency is done', () => {
    const state = makeState([
      makeTask('T002', { dependencies: ['T001'] }),
      makeTask('T001'),
    ]);
    const q = new TaskQueue(state);
    // T002 is first in array order but blocked; T001 is the eligible one.
    expect(q.next()?.id).toBe('T001');
    expect(q.dependenciesSatisfied(state.tasks[0])).toBe(false);

    q.setStatus('T001', 'done');
    expect(q.next()?.id).toBe('T002');
  });

  it('a deferred dependency does not satisfy the dependent', () => {
    const state = makeState(
      [
        makeTask('T001', { status: 'deferred' }),
        makeTask('T002', { status: 'deferred', dependencies: ['T001'] }),
      ],
      { currentPass: 2 }
    );
    const q = new TaskQueue(state);
    expect(q.next()?.id).toBe('T001');
    expect(q.dependenciesSatisfied(state.tasks[1])).toBe(false);
  });

  it('treats unknown dependency IDs as satisfied (parser may have stripped IDs)', () => {
    const state = makeState([makeTask('T001', { dependencies: ['T999'] })]);
    const q = new TaskQueue(state);
    expect(q.dependenciesSatisfied(state.tasks[0])).toBe(true);
    expect(q.next()?.id).toBe('T001');
  });

  it('requires ALL dependencies, mixing known-done, known-pending and unknown', () => {
    const state = makeState([
      makeTask('T001', { status: 'done' }),
      makeTask('T002'),
      makeTask('T003', { dependencies: ['T001', 'T002', 'T999'] }),
    ]);
    const q = new TaskQueue(state);
    expect(q.dependenciesSatisfied(state.tasks[2])).toBe(false);
    state.tasks[1].status = 'done';
    expect(q.dependenciesSatisfied(state.tasks[2])).toBe(true);
  });
});

describe('TaskQueue.next — one completed attempt per pass', () => {
  it('excludes a deferred task that already has a finished attempt in the current pass', () => {
    const state = makeState(
      [makeTask('T001', { status: 'deferred', attempts: [finished(2)] })],
      { currentPass: 2 }
    );
    const q = new TaskQueue(state);
    expect(q.next()).toBeUndefined();
  });

  it('a finished attempt from an EARLIER pass does not block eligibility', () => {
    const state = makeState(
      [makeTask('T001', { status: 'deferred', attempts: [finished(1)] })],
      { currentPass: 2 }
    );
    expect(new TaskQueue(state).next()?.id).toBe('T001');
  });

  it('an unfinished (crashed) attempt in the current pass keeps the task eligible — resume case', () => {
    const state = makeState([
      makeTask('T001', { attempts: [makeAttempt(1)] }), // no finishedAt
    ]);
    expect(new TaskQueue(state).next()?.id).toBe('T001');
  });

  it('bounds the inner loop: after each task gets one finished attempt, next() drains to undefined', () => {
    const state = makeState(
      [
        makeTask('T001', { status: 'deferred' }),
        makeTask('T002', { status: 'deferred' }),
      ],
      { currentPass: 2 }
    );
    const q = new TaskQueue(state);
    const seen: string[] = [];
    let t = q.next();
    let guard = 0;
    while (t && guard++ < 10) {
      seen.push(t.id);
      // Simulate a gate failure: task stays deferred but the attempt is finished.
      t.attempts.push(finished(2));
      t = q.next();
    }
    expect(seen).toEqual(['T001', 'T002']);
    expect(t).toBeUndefined();
  });
});

describe('TaskQueue — unresolvedIds / isComplete / unresolvedTasks', () => {
  it('unresolvedIds lists pending and deferred only', () => {
    const state = makeState([
      makeTask('T001'),
      makeTask('T002', { status: 'deferred' }),
      makeTask('T003', { status: 'done' }),
      makeTask('T004', { status: 'failed' }),
      makeTask('T005', { status: 'in_progress' }),
    ]);
    const q = new TaskQueue(state);
    // NOTE: in_progress is not counted as unresolved by the queue; the CLI
    // resets in_progress → pending on resume before the queue sees it.
    expect(q.unresolvedIds()).toEqual(['T001', 'T002']);
    expect(q.isComplete()).toBe(false);
    expect(q.unresolvedTasks().map((t) => t.id)).toEqual(['T002', 'T004']);
  });

  it('isComplete is true only when every task is done or failed', () => {
    const state = makeState([
      makeTask('T001', { status: 'done' }),
      makeTask('T002', { status: 'failed' }),
    ]);
    expect(new TaskQueue(state).isComplete()).toBe(true);
    state.tasks[1].status = 'deferred';
    expect(new TaskQueue(state).isComplete()).toBe(false);
  });

  it('byId / setStatus', () => {
    const state = makeState([makeTask('T001')]);
    const q = new TaskQueue(state);
    expect(q.byId('T001')?.id).toBe('T001');
    expect(q.byId('nope')).toBeUndefined();
    q.setStatus('T001', 'done');
    expect(state.tasks[0].status).toBe('done');
    expect(() => q.setStatus('T404', 'done')).toThrow(/No such task: T404/);
    expect(q.tasks).toBe(state.tasks);
  });
});

describe('TaskQueue — pass snapshots and no-progress detection', () => {
  it('noProgressInCurrentPass is false when no snapshot exists for the pass', () => {
    const state = makeState([makeTask('T001', { status: 'deferred' })], {
      currentPass: 2,
    });
    expect(new TaskQueue(state).noProgressInCurrentPass()).toBe(false);
  });

  it('is true when the unresolved set matches the pass-start snapshot exactly', () => {
    const state = makeState(
      [
        makeTask('T001', { status: 'deferred' }),
        makeTask('T002', { status: 'deferred' }),
      ],
      { currentPass: 2 }
    );
    const q = new TaskQueue(state);
    q.snapshotPassStart();
    expect(q.noProgressInCurrentPass()).toBe(true);

    q.setStatus('T001', 'done');
    expect(q.noProgressInCurrentPass()).toBe(false);
  });

  it('is false when the set has the same size but different members', () => {
    const state = makeState(
      [
        makeTask('T001', { status: 'deferred' }),
        makeTask('T002', { status: 'done' }),
      ],
      {
        currentPass: 2,
        passSnapshots: [{ pass: 2, unresolvedIds: ['T002'] }],
      }
    );
    expect(new TaskQueue(state).noProgressInCurrentPass()).toBe(false);
  });

  it('snapshotPassStart is idempotent — a resumed run keeps the original baseline', () => {
    const state = makeState([makeTask('T001'), makeTask('T002')]);
    const q = new TaskQueue(state);
    q.snapshotPassStart();
    expect(state.passSnapshots).toEqual([
      { pass: 1, unresolvedIds: ['T001', 'T002'] },
    ]);

    // Work happens, then the process "crashes" and resumes: re-snapshotting
    // must NOT overwrite the pass-1 baseline.
    q.setStatus('T001', 'done');
    q.snapshotPassStart();
    expect(state.passSnapshots).toEqual([
      { pass: 1, unresolvedIds: ['T001', 'T002'] },
    ]);
    expect(q.noProgressInCurrentPass()).toBe(false);
  });

  it('startNextPass increments currentPass and snapshots the new pass', () => {
    const state = makeState([
      makeTask('T001', { status: 'deferred' }),
      makeTask('T002', { status: 'done' }),
    ]);
    const q = new TaskQueue(state);
    q.snapshotPassStart();
    q.startNextPass();
    expect(state.currentPass).toBe(2);
    expect(state.passSnapshots).toEqual([
      { pass: 1, unresolvedIds: ['T001'] },
      { pass: 2, unresolvedIds: ['T001'] },
    ]);
    // Deferred task is now eligible again.
    expect(q.next()?.id).toBe('T001');
  });
});

describe('TaskQueue.detectCycles', () => {
  it('returns [] for an acyclic graph (including a diamond)', () => {
    const state = makeState([
      makeTask('T001'),
      makeTask('T002', { dependencies: ['T001'] }),
      makeTask('T003', { dependencies: ['T001'] }),
      makeTask('T004', { dependencies: ['T002', 'T003'] }),
    ]);
    expect(new TaskQueue(state).detectCycles()).toEqual([]);
  });

  it('reports a two-node cycle once with a readable path', () => {
    const state = makeState([
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T002', { dependencies: ['T001'] }),
    ]);
    expect(new TaskQueue(state).detectCycles()).toEqual(['T001 → T002 → T001']);
  });

  it('reports a self-dependency', () => {
    const state = makeState([makeTask('T001', { dependencies: ['T001'] })]);
    expect(new TaskQueue(state).detectCycles()).toEqual(['T001 → T001']);
  });

  it('reports each independent cycle and ignores unknown dependency IDs', () => {
    const state = makeState([
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T002', { dependencies: ['T003'] }),
      makeTask('T003', { dependencies: ['T001', 'T999'] }),
      makeTask('T010', { dependencies: ['T011'] }),
      makeTask('T011', { dependencies: ['T010'] }),
      makeTask('T020'),
    ]);
    const cycles = new TaskQueue(state).detectCycles();
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toBe('T001 → T002 → T003 → T001');
    expect(cycles[1]).toBe('T010 → T011 → T010');
  });
});
