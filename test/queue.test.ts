import { describe, it, expect } from 'vitest';
import { TaskQueue, stuckOnIdenticalGateFailure, syntheticAttemptsExhausted } from '../src/queue.js';
import { makeAttempt, makeState, makeTask } from './helpers/fixtures.js';
import type { GateResult } from '../src/types.js';

const finished = (pass: number) =>
  makeAttempt(pass, { finishedAt: new Date().toISOString() });

/** A `gate_failed` completed attempt shaped exactly like orchestrator.ts's `settleDefer` call leaves it. */
function gateFailedAttempt(
  pass: number,
  gateName: string,
  exitCode: number,
  output: string,
  extraGates: GateResult[] = []
): ReturnType<typeof makeAttempt> {
  const failed: GateResult = { name: gateName, passed: false, command: 'x', exitCode, output, durationMs: 1 };
  return makeAttempt(pass, {
    finishedAt: new Date().toISOString(),
    deferReason: 'gate_failed',
    deferDetail: `Gate "${gateName}" failed (exit ${exitCode}). Captured output below (full output: /tmp/x.log)\n\n\`\`\`\n${output}\n\`\`\``,
    gateResults: [...extraGates, failed],
  });
}

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

describe('stuckOnIdenticalGateFailure', () => {
  it('false with fewer than two completed attempts', () => {
    expect(stuckOnIdenticalGateFailure(makeTask('T001', { attempts: [] }))).toBe(false);
    expect(
      stuckOnIdenticalGateFailure(makeTask('T001', { attempts: [gateFailedAttempt(1, 'test', 1, 'boom')] }))
    ).toBe(false);
  });

  it('true when the last two attempts failed the same gate with byte-identical output', () => {
    const task = makeTask('T001', {
      attempts: [gateFailedAttempt(1, 'test', 1, 'AssertionError: x !== y\n  at foo.test.ts:12'), gateFailedAttempt(2, 'test', 1, 'AssertionError: x !== y\n  at foo.test.ts:12')],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(true);
  });

  it('false when the output differs even slightly — the subagent may be converging', () => {
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'AssertionError: x !== y\n  at foo.test.ts:12'),
        gateFailedAttempt(2, 'test', 1, 'AssertionError: x !== z\n  at foo.test.ts:14'), // different failure
      ],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(false);
  });

  it('false when the failing gate name differs between attempts', () => {
    const task = makeTask('T001', {
      attempts: [gateFailedAttempt(1, 'typecheck', 2, 'same text'), gateFailedAttempt(2, 'test', 1, 'same text')],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(false);
  });

  it('false when something other than a repeat gate failure sits between (rate limit / subagent error breaks the streak)', () => {
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'same output'),
        makeAttempt(2, { finishedAt: new Date().toISOString(), deferReason: 'rate_limited', deferDetail: 'still rate-limited' }),
        gateFailedAttempt(3, 'test', 1, 'same output'),
      ],
    });
    // Only the LAST TWO completed attempts matter — rate_limited, then gate_failed.
    expect(stuckOnIdenticalGateFailure(task)).toBe(false);
  });

  it('only compares the gate `evaluateGates` actually reported, not any raw-failed gate in gateResults', () => {
    // Both attempts also carry a raw-failed lint gate that was NOT the
    // reported cause (e.g. a pre-existing failure the audit ignores) —
    // it must not be picked up as "the" failure being compared.
    const otherRawFailure: GateResult = { name: 'lint', passed: false, command: 'x', exitCode: 1, output: 'unrelated pre-existing lint noise', durationMs: 1 };
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'same output', [otherRawFailure]),
        gateFailedAttempt(2, 'test', 1, 'same output', [otherRawFailure]),
      ],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(true);
  });

  it('a fullauto retry (baselineResetAtAttempt) resets the streak — the pre-retry attempts are not consulted', () => {
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'same output'),
        gateFailedAttempt(2, 'test', 1, 'same output'), // would be stuck without the reset
        gateFailedAttempt(3, 'test', 1, 'same output'), // only one completed attempt since the reset
      ],
      baselineResetAtAttempt: 2,
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(false);
  });
});

describe('stuckOnIdenticalGateFailure — beyond byte-identical gate output', () => {
  const done = new Date().toISOString();
  const withReason = (pass: number, reason: NonNullable<ReturnType<typeof makeAttempt>['deferReason']>, deferDetail: string, extra: object = {}) =>
    makeAttempt(pass, { finishedAt: done, deferReason: reason, deferDetail, ...extra });
  const auditAttempt = (pass: number, messages: string[]) =>
    withReason(pass, 'audit_failed', 'blocked', {
      audit: {
        blocked: true,
        changed: { added: 0, modified: 0, deleted: 0 },
        findings: messages.map((message) => ({ check: 'orphan-code', severity: 'block', path: 'src/a.ts', message })),
      },
    });

  it('gate output that differs only in timings / timestamps is still the same failure', () => {
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'FAIL a.test.ts > x (35ms)\n Duration  1.42s\n at 2026-10-02T11:00:01.123Z'),
        gateFailedAttempt(2, 'test', 1, 'FAIL a.test.ts > x (41ms)\n Duration  1.98s\n at 2026-10-02T11:07:44.900Z'),
      ],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(true);
  });

  it('a changing failure COUNT is progress, not noise', () => {
    const task = makeTask('T001', {
      attempts: [gateFailedAttempt(1, 'test', 1, 'Tests  5 failed | 10 passed'), gateFailedAttempt(2, 'test', 1, 'Tests  3 failed | 12 passed')],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(false);
  });

  it('same audit BLOCK set twice (order-insensitive) is stuck; a different set is not', () => {
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [auditAttempt(1, ['a', 'b']), auditAttempt(2, ['b', 'a'])] }))).toBe(true);
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [auditAttempt(1, ['a', 'b']), auditAttempt(2, ['a'])] }))).toBe(false);
  });

  it('same unmet bullets AND same attempted fix twice is stuck; a different fix, a shrinking list, or no unmet is not', () => {
    const v = (pass: number, detail: string) => withReason(pass, 'verify_loop_blocks_remaining', detail);
    const same = makeTask('T', { attempts: [v(1, 'cause | unmet: POST /x | unmet: GET /y | last-attempt: added guard'), v(2, 'other | unmet: GET /y | unmet: POST /x | last-attempt: added guard')] });
    expect(stuckOnIdenticalGateFailure(same)).toBe(true);
    const newFix = makeTask('T', { attempts: [v(1, 'c | unmet: POST /x | last-attempt: added guard'), v(2, 'c | unmet: POST /x | last-attempt: rewrote handler')] });
    expect(stuckOnIdenticalGateFailure(newFix)).toBe(false);
    const shrinking = makeTask('T', { attempts: [v(1, 'c | unmet: POST /x | unmet: GET /y'), v(2, 'c | unmet: GET /y')] });
    expect(stuckOnIdenticalGateFailure(shrinking)).toBe(false);
    const generic = makeTask('T', { attempts: [v(1, 'BLOCKs remain after 2 cycles'), v(2, 'BLOCKs remain after 2 cycles')] });
    expect(stuckOnIdenticalGateFailure(generic)).toBe(false);
  });

  it('tdd_red_expected: same files + same counts twice is stuck; different files written is not', () => {
    const r = (pass: number, files: string[], passed: number) =>
      withReason(pass, 'tdd_red_expected', 'red expected', { touched: files.map((path) => ({ path })), tdd: { phase: 'red', passed } });
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [r(1, ['test/a.test.ts'], 4), r(2, ['test/a.test.ts'], 4)] }))).toBe(true);
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [r(1, ['test/a.test.ts'], 4), r(2, ['test/a.test.ts', 'test/b.test.ts'], 4)] }))).toBe(false);
  });

  it('two timeouts in a row are stuck; two plain subagent crashes are not (may be transient)', () => {
    const t = (pass: number) => withReason(pass, 'subagent_error', 'Subagent timed out after 3600s');
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [t(1), t(2)] }))).toBe(true);
    const c = (pass: number) => withReason(pass, 'subagent_error', 'Subagent exited with code 1');
    expect(stuckOnIdenticalGateFailure(makeTask('T', { attempts: [c(1), c(2)] }))).toBe(false);
  });

  it('a depends_on_unfinished_task placeholder between two identical failures does not hide the streak', () => {
    const task = makeTask('T001', {
      attempts: [
        gateFailedAttempt(1, 'test', 1, 'same'),
        withReason(1, 'depends_on_unfinished_task', 'Pass 1 ended with task still pending'),
        gateFailedAttempt(2, 'test', 1, 'same'),
      ],
    });
    expect(stuckOnIdenticalGateFailure(task)).toBe(true);
  });
});

describe('synthetic task attempt caps', () => {
  const done = new Date().toISOString();
  const failedAttempt = (pass: number) => makeAttempt(pass, { finishedAt: done, deferReason: 'gate_failed', deferDetail: 'x' });

  it('an ENHANCE task gets one real attempt, a VERIFY task two, a user task no cap', () => {
    expect(syntheticAttemptsExhausted(makeTask('E', { kind: 'enhance', attempts: [] }))).toBe(false);
    expect(syntheticAttemptsExhausted(makeTask('E', { kind: 'enhance', attempts: [failedAttempt(1)] }))).toBe(true);
    expect(syntheticAttemptsExhausted(makeTask('V', { kind: 'verify', attempts: [failedAttempt(1)] }))).toBe(false);
    expect(syntheticAttemptsExhausted(makeTask('V', { kind: 'verify', attempts: [failedAttempt(1), failedAttempt(2)] }))).toBe(true);
    expect(syntheticAttemptsExhausted(makeTask('T', { attempts: [failedAttempt(1), failedAttempt(2), failedAttempt(3)] }))).toBe(false);
  });

  it('next() stops offering an exhausted enhance task but still serves other deferred tasks', () => {
    const state = makeState(
      [makeTask('E', { kind: 'enhance', status: 'deferred', attempts: [failedAttempt(1)] }), makeTask('T002', { status: 'deferred' })],
      { currentPass: 2 }
    );
    expect(new TaskQueue(state).next()?.id).toBe('T002');
  });
});

describe('TaskQueue.next — excludes a task stuck on an identical gate failure', () => {
  it('is skipped by next() but stays deferred, letting other ready tasks through', () => {
    const state = makeState(
      [
        makeTask('T001', {
          status: 'deferred',
          attempts: [gateFailedAttempt(1, 'test', 1, 'same output'), gateFailedAttempt(2, 'test', 1, 'same output')],
        }),
        makeTask('T002', { status: 'deferred' }),
      ],
      { currentPass: 3 }
    );
    const q = new TaskQueue(state);
    expect(q.next()?.id).toBe('T002'); // T001 never offered again
    expect(state.tasks[0].status).toBe('deferred'); // next() does not itself change status
  });

  it('a task with only ONE gate_failed attempt so far is still offered (needs two to trip)', () => {
    const state = makeState(
      [makeTask('T001', { status: 'deferred', attempts: [gateFailedAttempt(1, 'test', 1, 'x')] })],
      { currentPass: 2 }
    );
    expect(new TaskQueue(state).next()?.id).toBe('T001');
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
