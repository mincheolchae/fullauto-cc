import { describe, it, expect } from 'vitest';
import { exitCodeForRun, requeueFailedTasks } from '../src/run-flow.js';
import { passLimit } from '../src/orchestrator.js';
import { makeAttempt, makeConfig, makeState, makeTask } from './helpers/fixtures.js';

const finished = (pass: number, reason: 'gate_failed' | 'depends_on_unfinished_task', log = true) =>
  makeAttempt(pass, {
    finishedAt: new Date().toISOString(),
    deferReason: reason,
    deferDetail: reason,
    ...(log ? { subagentLogPath: `/tmp/${pass}.log` } : {}),
  });

function failedRun() {
  return makeState(
    [
      makeTask('T001', { status: 'done', attempts: [makeAttempt(1, { finishedAt: new Date().toISOString(), subagentLogPath: '/tmp/a.log' })] }),
      makeTask('T002', { status: 'failed', attempts: [finished(1, 'gate_failed'), finished(2, 'gate_failed'), finished(2, 'gate_failed', false)] }),
      // Never ran: only ever waited on T002.
      makeTask('T003', { status: 'failed', dependencies: ['T002'], attempts: [finished(1, 'depends_on_unfinished_task', false), finished(2, 'depends_on_unfinished_task', false)] }),
      // Ran and failed on its own; depends on T002 too.
      makeTask('T004', { status: 'failed', dependencies: ['T002'], attempts: [finished(2, 'gate_failed')] }),
    ],
    { currentPass: 3, config: makeConfig({ maxPasses: 2 }) }
  );
}

describe('exitCodeForRun', () => {
  it('0 only when every task is done; 1 otherwise; 2 for an aborted start', () => {
    expect(exitCodeForRun(makeState([makeTask('T001', { status: 'done' })]))).toBe(0);
    expect(exitCodeForRun(makeState([makeTask('T001', { status: 'done' }), makeTask('T002', { status: 'failed' })]))).toBe(1);
    expect(exitCodeForRun(makeState([makeTask('T001', { status: 'deferred' })]))).toBe(1);
    expect(exitCodeForRun(null)).toBe(2);
  });
});

describe('requeueFailedTasks', () => {
  it('no ids: every failed task → deferred, a new pass is opened, the pass budget covers it', () => {
    const state = failedRun();
    const plan = requeueFailedTasks(state);
    expect(plan).toEqual({ requeued: ['T002', 'T003', 'T004'], skipped: [], missing: [] });
    expect(state.tasks.map((t) => t.status)).toEqual(['done', 'deferred', 'deferred', 'deferred']);
    expect(state.currentPass).toBe(4);
    expect(passLimit(state)).toBe(4);
    expect(state.extraPasses).toBe(2);
    // History is kept: no attempt was removed.
    expect(state.tasks[1].attempts).toHaveLength(3);
  });

  it('explicit ids (canonicalized): only those, plus failed dependents that never ran', () => {
    const state = failedRun();
    const plan = requeueFailedTasks(state, ['T2']);
    expect(plan.requeued).toEqual(['T002', 'T003']);
    expect(state.tasks.map((t) => t.status)).toEqual(['done', 'deferred', 'deferred', 'failed']);
  });

  it('a task that is not failed is skipped; an unknown id aborts the plan without touching state', () => {
    const state = failedRun();
    expect(requeueFailedTasks(state, ['T001', 'T004'])).toEqual({ requeued: ['T004'], skipped: ['T001'], missing: [] });
    const untouched = failedRun();
    const plan = requeueFailedTasks(untouched, ['T002', 'T777']);
    expect(plan.missing).toEqual(['T777']);
    expect(plan.requeued).toEqual([]);
    expect(untouched.tasks[1].status).toBe('failed');
    expect(untouched.currentPass).toBe(3);
  });

  it('marks baselineResetAtAttempt at the CURRENT attempt count for every requeued task (round 3, item 1.6)', () => {
    const state = failedRun();
    // T002 already has 3 attempts, T003 has 2, T004 has 1.
    requeueFailedTasks(state);
    expect(state.tasks[1].baselineResetAtAttempt).toBe(3);
    expect(state.tasks[2].baselineResetAtAttempt).toBe(2);
    expect(state.tasks[3].baselineResetAtAttempt).toBe(1);
    // A task that was never requeued (done, or skipped) is untouched.
    expect(state.tasks[0].baselineResetAtAttempt).toBeUndefined();
  });

  it('does not extend the budget when the retry pass is still within maxPasses', () => {
    const state = failedRun();
    state.config.maxPasses = 6;
    requeueFailedTasks(state, ['T004']);
    expect(state.currentPass).toBe(4);
    expect(state.extraPasses).toBe(0);
    expect(passLimit(state)).toBe(6);
  });
});
