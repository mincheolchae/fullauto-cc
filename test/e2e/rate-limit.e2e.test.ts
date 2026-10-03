/**
 * Rate-limit-aware backoff (round 3, item 1) against a temp git project with
 * the fake `claude`. Proves the concrete failure mode this exists to fix:
 * without backoff, a rate-limited subagent gets deferred to the NEXT pass
 * with zero delay, hammering the API again immediately until `maxPasses` is
 * exhausted. With it, the retry happens WITHIN the same task attempt (same
 * pass), so a task that is rate-limited once and then succeeds finishes in
 * ONE orchestrator pass with ONE recorded attempt.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, loadState, saveState } from '../../src/persistence.js';
import { resetInterrupted } from '../../src/run-flow.js';
import { RateLimitPausedError, RATE_LIMIT_PAUSE_EXIT_CODE } from '../../src/runner/process-group.js';
import type { RunState, Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, cleanup } from '../helpers/tmp.js';
import { makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;

beforeAll(async () => {
  fake = await makeFakeClaude();
  restoreEnv = fake.install();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(async () => {
  restoreEnv();
  await fake.dispose();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await fake.reset();
  projectDir = await makeGitRepo({
    '.gitignore': '.fullauto/\n',
    'README.md': '# rate-limit fixture\n',
    'src/index.ts': 'export {};\n',
  });
});

afterEach(async () => {
  await cleanup(projectDir);
});

async function runFresh(tasks: Task[], cfg: Record<string, unknown> = {}): Promise<RunState> {
  const state = makeState(tasks, {
    config: makeConfig({
      // Real defaults are 30s / 900s — tiny here so the test doesn't wait
      // out real backoff windows while still exercising the same code path.
      rateLimitBaseBackoffSec: 0.03,
      rateLimitMaxBackoffSec: 0.05,
      rateLimitMaxRetries: 5,
      ...cfg,
    }),
  });
  await ensureFullautoDir(projectDir);
  await saveState(projectDir, state);
  return runOrchestrator({ projectDir, state, verbose: false });
}

describe('rate-limit backoff', () => {
  it('a rate-limited attempt backs off and retries WITHIN the same pass, then succeeds: one attempt, one pass, no defer', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Add helper module',
          // First invocation of THIS task is rate-limited (nth counts per
          // task, not per suite); the retry — same prompt, same attempt —
          // is a fresh invocation that no longer matches nth=1 and so just
          // writes the file and exits 0.
          body: 'FAKE: nth ratelimited 1 rate-limit\nFAKE: write src/helper.ts',
        }),
      ],
      { maxPasses: 1 }
    );

    const t = result.tasks[0];
    expect(t.status).toBe('done');
    // Exactly one orchestrator-level attempt: the retry happened INSIDE
    // runSubagent, not by deferring to a second pass / second attempt.
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0].deferReason).toBeUndefined();

    expect(result.rateLimitHits).toBe(1);
    expect(result.rateLimitWaitMs).toBeGreaterThan(0);
  }, 20_000);

  it('still rate-limited after exhausting retries PAUSES the run (exit 75), leaving the attempt unfinished so resume is free', async () => {
    const tasks = [
      // The first 3 invocations (1 + rateLimitMaxRetries=2) are rate-limited; the 4th — after resume — works.
      makeTask('T001', {
        title: 'Saturated then fine',
        body: 'FAKE: nth rl 1 rate-limit\nFAKE: nth rl 2 rate-limit\nFAKE: nth rl 3 rate-limit\nFAKE: write src/a.ts',
      }),
      makeTask('T002', { title: 'Second task', body: 'FAKE: write src/b.ts' }),
    ];
    const err = await runFresh(tasks, { maxPasses: 2, rateLimitMaxRetries: 2 }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(RateLimitPausedError);
    expect((err as RateLimitPausedError).exitCode).toBe(RATE_LIMIT_PAUSE_EXIT_CODE);

    const saved = (await loadState(projectDir))!;
    const t1 = saved.tasks.find((t) => t.id === 'T001')!;
    const t2 = saved.tasks.find((t) => t.id === 'T002')!;
    // Same shape as an interruption: in-flight, no finishedAt, no pass consumed.
    expect(t1.status).toBe('in_progress');
    expect(t1.attempts).toHaveLength(1);
    expect(t1.attempts[0].finishedAt).toBeUndefined();
    expect(saved.currentPass).toBe(1);
    // The circuit breaker: the second task never burned its own backoff budget.
    expect(t2.status).toBe('pending');
    expect(t2.attempts).toHaveLength(0);
    expect(saved.rateLimitHits).toBe(3);

    // Resume: the saturated window is over (4th invocation) — both tasks finish in pass 1.
    await resetInterrupted(projectDir, saved);
    const resumed = await runOrchestrator({ projectDir, state: saved, verbose: false });
    expect(resumed.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(resumed.currentPass).toBe(1);
  }, 30_000);

  it('a task that pauses the run a second time is deferred instead (a false-positive rate-limit match cannot pause forever)', async () => {
    const tasks = [makeTask('T001', { title: 'Always looks saturated', body: 'FAKE: rate-limit' })];
    const first = await runFresh(tasks, { maxPasses: 2, rateLimitMaxRetries: 1 }).then(() => undefined, (e: unknown) => e);
    expect(first).toBeInstanceOf(RateLimitPausedError);

    const saved = (await loadState(projectDir))!;
    await resetInterrupted(projectDir, saved);
    const resumed = await runOrchestrator({ projectDir, state: saved, verbose: false });
    const t = resumed.tasks[0];
    expect(t.attempts.some((a) => a.deferReason === 'rate_limited')).toBe(true);
    expect(t.status).toBe('failed');
  }, 30_000);

  it('a pause during pass 2 resumes IN pass 2 even while other deferred tasks are eligible (no pass charged, not failed)', async () => {
    const tasks = [
      makeTask('T001', { title: 'Needs two passes', body: 'FAKE: once t1 defer because first-pass\nFAKE: nth rl 2 rate-limit\nFAKE: write src/a.ts' }),
      makeTask('T002', { title: 'Also needs two passes', body: 'FAKE: once t2 defer because first-pass\nFAKE: write src/b.ts' }),
    ];
    // Pass 1: both fail once. Pass 2: T001 is rate-limited (2nd invocation of key rl) -> pause.
    const err = await runFresh(tasks, { maxPasses: 2, rateLimitMaxRetries: 0 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitPausedError);
    const saved = (await loadState(projectDir))!;
    expect(saved.currentPass).toBe(2);

    await resetInterrupted(projectDir, saved);
    const resumed = await runOrchestrator({ projectDir, state: saved, verbose: false });
    expect(resumed.currentPass).toBe(2); // maxPasses is 2: it was retried in pass 2, not pushed past the limit
    expect(resumed.tasks.map((t) => t.status)).toEqual(['done', 'done']);
  }, 30_000);

  it('a TIMED-OUT spawn whose transcript mentions rate limiting is not retried as a rate limit', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Add rate limiting middleware',
          // The task is about rate limiting, so the (killed) subagent's output quotes a 429.
          body: 'FAKE: stderr API Error: 429 rate_limit_error resets in 2 hours\nFAKE: sleep 30',
        }),
      ],
      { maxPasses: 1, subagentTimeoutSec: 1 }
    );
    const t = result.tasks[0];
    expect(result.rateLimitHits).toBe(0);
    expect(t.attempts[0].deferReason).toBe('subagent_error');
    expect(t.attempts[0].deferDetail).toMatch(/timed out/);
  }, 20_000);
});
