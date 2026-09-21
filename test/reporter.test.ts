import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatKst, isRunFinished, lastFinishedAt, lastRealAttempt, printFinalReport } from '../src/reporter.js';
import { makeAttempt, makeState, makeTask } from './helpers/fixtures.js';

let lines: string[];

beforeEach(() => {
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (iso: string) => new Date(iso).toISOString();

describe('lastRealAttempt / isRunFinished / lastFinishedAt', () => {
  it('skips synthetic attempts (no subagent log) and falls back to the last attempt', () => {
    const real = makeAttempt(1, { finishedAt: at('2026-09-20T01:00:00Z'), subagentLogPath: '/l/1.log', deferReason: 'audit_failed', deferDetail: 'x' });
    const synthetic = makeAttempt(2, { finishedAt: at('2026-09-20T01:00:05Z'), deferReason: 'audit_failed', deferDetail: 'Promoted to failed after orchestrator exit: x' });
    // makeTask runs the attempts through zod, so compare by value.
    expect(lastRealAttempt(makeTask('T001', { attempts: [real, synthetic] }))).toEqual(real);
    expect(lastRealAttempt(makeTask('T002', { attempts: [synthetic] }))).toEqual(synthetic);
    expect(lastRealAttempt(makeTask('T003'))).toBeUndefined();
  });

  it('a run is finished when every task is terminal; the clock stops at the last finishedAt', () => {
    const s = makeState([
      makeTask('T001', { status: 'done', attempts: [makeAttempt(1, { finishedAt: at('2026-09-20T01:00:00Z'), subagentLogPath: '/l/1.log' })] }),
      makeTask('T002', { status: 'failed', attempts: [makeAttempt(1, { finishedAt: at('2026-09-20T01:02:00Z'), subagentLogPath: '/l/2.log' }), makeAttempt(2, { finishedAt: at('2026-09-20T01:02:03Z') })] }),
    ]);
    expect(isRunFinished(s)).toBe(true);
    expect(lastFinishedAt(s)).toBe(at('2026-09-20T01:02:03Z'));
    s.tasks[1].status = 'deferred';
    expect(isRunFinished(s)).toBe(false);
  });

  it('formatKst pins the wall clock to Asia/Seoul', () => {
    expect(formatKst('2026-09-20T00:00:00.000Z')).toBe('2026-09-20 09:00:00 KST');
    expect(formatKst('garbage')).toBe('garbage');
  });
});

describe('printFinalReport', () => {
  it('lists one line per real attempt, the last real attempt\'s log + WARNs, finished-run timing and the retry hint', () => {
    const state = makeState(
      [
        makeTask('T001', { title: 'Docs', status: 'done', attempts: [makeAttempt(1, { startedAt: at('2026-09-20T00:00:00Z'), finishedAt: at('2026-09-20T00:00:10Z'), subagentLogPath: '/l/T001-attempt1.log' })] }),
        makeTask('T007', {
          title: 'Delete route',
          status: 'failed',
          attempts: [
            makeAttempt(1, {
              startedAt: at('2026-09-20T00:00:10Z'),
              finishedAt: at('2026-09-20T00:00:20Z'),
              subagentLogPath: '/l/T007-attempt1.log',
              deferReason: 'gate_failed',
              deferDetail: 'Gate "test" failed (exit 1). Captured output below\n\n```\nnot ok 1\n```',
              rollback: { patchPath: '/l/T007-attempt1.patch', files: 2, restored: 1, deleted: 1 },
            }),
            makeAttempt(2, {
              startedAt: at('2026-09-20T00:00:20Z'),
              finishedAt: at('2026-09-20T00:00:40Z'),
              subagentLogPath: '/l/T007-attempt2.log',
              deferReason: 'audit_failed',
              deferDetail: 'Post-task audit BLOCKED this attempt (1 BLOCK / 1 WARN). Findings:\n- [BLOCK] orphan-code src/x.ts — orphan',
              audit: { findings: [{ check: 'orphan-code', severity: 'block', message: 'orphan', path: 'src/x.ts' }, { check: 'unused-export', severity: 'warn', message: 'unused thing', path: 'src/y.ts' }], blocked: true, changed: { added: 1, modified: 0, deleted: 0 } },
            }),
            makeAttempt(2, { startedAt: at('2026-09-20T00:00:40Z'), finishedAt: at('2026-09-20T00:00:41Z'), deferReason: 'audit_failed', deferDetail: 'Promoted to failed after orchestrator exit: Post-task audit BLOCKED this attempt (1 BLOCK / 1 WARN). Findings:\n- [BLOCK] ...' }),
          ],
        }),
      ],
      { commandStartedAt: at('2026-09-20T00:00:00Z'), startedAt: at('2026-09-20T00:00:00Z') }
    );
    printFinalReport(state);
    const out = lines.join('\n');
    expect(out).toContain('T007 [failed] Delete route');
    expect(out).toContain('reason: audit_failed');
    expect(out).toContain('pass 1: gate_failed — Gate "test" failed (exit 1). Captured output below [rolled back: /l/T007-attempt1.patch]');
    expect(out).toContain('pass 2: audit_failed — Post-task audit BLOCKED this attempt (1 BLOCK / 1 WARN). Findings:');
    // The synthetic promotion is not a line of its own and the full fenced output is not dumped.
    expect(out.split('pass 2:').length - 1).toBe(1);
    expect(out).not.toContain('not ok 1');
    expect(out).toContain('log: /l/T007-attempt2.log');
    expect(out).toContain('warn: [unused-export] src/y.ts — unused thing');
    expect(out).toContain('• T007 [unused-export] src/y.ts — unused thing');
    // Finished run: the clock stopped at the last finishedAt (41s), not now.
    expect(out).toContain('Finished at    : 2026-09-20 09:00:41 KST');
    expect(out).toContain('Total elapsed  : 41s');
    expect(out).not.toContain('Reported at');
    expect(out).toContain('Next: `fullauto retry T007` to re-run the 1 failed task(s)');
  });

  it('an all-done run points at reviewing the diff; an unfinished one at resume', () => {
    printFinalReport(makeState([makeTask('T001', { status: 'done', attempts: [makeAttempt(1, { finishedAt: new Date().toISOString(), subagentLogPath: '/l/1.log' })] })]));
    expect(lines.join('\n')).toContain('Next: review the changes');
    lines = [];
    printFinalReport(makeState([makeTask('T001', { status: 'in_progress', attempts: [makeAttempt(1, { subagentLogPath: '/l/1.log' })] })]));
    const out = lines.join('\n');
    expect(out).toContain('Reported at');
    expect(out).toContain('Next: `fullauto resume`');
  });

  it('prints the aggregate rate-limit line only when the run hit one', () => {
    const state = makeState([makeTask('T001', { status: 'done', attempts: [makeAttempt(1, { finishedAt: new Date().toISOString() })] })]);
    printFinalReport(state);
    expect(lines.join('\n')).not.toContain('rate-limited');

    lines = [];
    printFinalReport({ ...state, rateLimitHits: 3, rateLimitWaitMs: 12_345 });
    expect(lines.join('\n')).toContain('rate-limited 3 time(s), waited 12s total');
  });
});
