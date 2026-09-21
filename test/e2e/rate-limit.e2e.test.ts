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
import { ensureFullautoDir, saveState } from '../../src/persistence.js';
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

  it('still rate-limited after exhausting retries defers with DeferReason "rate_limited", not "subagent_error"', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Always saturated',
          body: 'FAKE: rate-limit',
        }),
      ],
      { maxPasses: 1, rateLimitMaxRetries: 2 }
    );

    const t = result.tasks[0];
    expect(t.status).toBe('failed'); // promoted to failed at maxPasses exhaustion, same as any deferred task
    // attempts[0] is the real subagent attempt; the orchestrator appends a
    // synthetic "promoted to failed" attempt once maxPasses is exhausted.
    expect(t.attempts).toHaveLength(2);
    expect(t.attempts[0].deferReason).toBe('rate_limited');
    expect(t.attempts[0].deferDetail).toMatch(/still rate-limited after 3 consecutive hit/);

    expect(result.rateLimitHits).toBe(3); // 2 retries + the final exhausted attempt
    expect(result.rateLimitWaitMs).toBeGreaterThan(0);
  }, 20_000);
});
