/**
 * End-to-end orchestrator tests.
 *
 * A fake `claude` executable (test/helpers/fake-claude.ts) is put first on
 * PATH; each task body carries `FAKE:` directives that drive it (write a
 * file, print a DEFER marker, exit non-zero, ...). The project is a real
 * temp git repo so snapshot / audit code paths see a normal tree.
 *
 * Assumptions that other workstreams could invalidate (listed in the report):
 *   - `config.audit.enabled = false` disables the post-task audit; without
 *     it the orphan-code check would BLOCK every `FAKE: write` task because
 *     nothing imports the written file.
 *   - `useVerifyLoop: false` / default verifyMode keep the run free of
 *     synthetic VERIFY-* tasks (only ENHANCE-* is expected in test (f)).
 *   - Gate names avoid `test` / `e2e` so no gate is classified as a test
 *     runner (quarantine logic never engages).
 *   - Prompt-content assertions are loose: task body text and the prior
 *     attempt's deferDetail are the only things asserted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, loadState, logPathFor, saveState } from '../../src/persistence.js';
import { RunState, type Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, cleanup } from '../helpers/tmp.js';
import { makeAttempt, makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;
const COMMAND_STARTED_AT = '2026-09-20T00:00:00.000Z';

beforeAll(async () => {
  fake = await makeFakeClaude();
  restoreEnv = fake.install();
  // The reporter is chatty; keep the vitest output readable.
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
  projectDir = await makeGitRepo({ 'README.md': '# e2e fixture\n', 'src/index.ts': 'export {};\n' });
});

afterEach(async () => {
  await cleanup(projectDir);
});

/** Persist a fresh state (as cli.ts startFreshRun does) and run the orchestrator on it. */
async function runFresh(tasks: Task[], cfg: Record<string, unknown> = {}): Promise<RunState> {
  const state = makeState(tasks, { config: makeConfig(cfg), commandStartedAt: COMMAND_STARTED_AT });
  await ensureFullautoDir(projectDir);
  await saveState(projectDir, state);
  return runOrchestrator({ projectDir, state, verbose: false });
}

/** Mirror cli.ts resume: load state.json, reset in_progress → pending, run. */
async function resumeFromDisk(): Promise<RunState> {
  const state = await loadState(projectDir);
  if (!state) throw new Error('no state to resume');
  for (const t of state.tasks) {
    if (t.status === 'in_progress') t.status = 'pending';
  }
  return runOrchestrator({ projectDir, state, verbose: false });
}

const byId = (state: RunState, id: string): Task => {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
};

describe('(a) happy path — two tasks, passing gate', () => {
  it('runs both tasks to done in pass 1, persists state, writes logs, keeps commandStartedAt', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Create greeting module', body: 'FAKE: write src/greet.ts\nFAKE: mark T001' }),
        makeTask('T002', { title: 'Create farewell module', body: 'FAKE: write src/bye.ts\nFAKE: mark T002' }),
      ],
      { maxPasses: 2 }
    );

    expect(result.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(result.currentPass).toBe(1);
    expect(result.passSnapshots).toEqual([{ pass: 1, unresolvedIds: ['T001', 'T002'] }]);

    for (const id of ['T001', 'T002']) {
      const t = byId(result, id);
      expect(t.attempts).toHaveLength(1);
      const a = t.attempts[0];
      expect(a.passNumber).toBe(1);
      expect(a.finishedAt).toBeDefined();
      expect(a.subagentExitCode).toBe(0);
      expect(a.deferReason).toBeUndefined();
      expect(a.gateResults).toHaveLength(1);
      expect(a.gateResults[0]).toMatchObject({ name: 'ok', passed: true, exitCode: 0 });
      expect(a.subagentLogPath).toBe(logPathFor(projectDir, id, 1));
      expect(existsSync(a.subagentLogPath!)).toBe(true);
      const log = await readFile(a.subagentLogPath!, 'utf-8');
      expect(log).toContain(`# Subagent transcript for ${id}`);
      expect(log).toContain('fake-claude: finished');
    }

    // The fake actually did the work in the project dir, in order.
    expect(existsSync(join(projectDir, 'src', 'greet.ts'))).toBe(true);
    expect(existsSync(join(projectDir, 'src', 'bye.ts'))).toBe(true);
    expect(await fake.marks()).toEqual(['T001', 'T002']);

    // Persisted state is the schema projection of the returned state (the
    // in-memory audit result may carry extra fields that zod strips) and
    // keeps the caller's timing.
    const persisted = await loadState(projectDir);
    expect(persisted).toEqual(RunState.parse(result));
    expect(persisted?.commandStartedAt).toBe(COMMAND_STARTED_AT);
    expect(persisted?.startedAt).toBeDefined();

    // The implementer prompt carried the task text through to the subagent.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Create greeting module');
    expect(prompts[1]).toContain('Create farewell module');
  });
});

describe('(b) subagent DEFER marker', () => {
  it('defers with verify_loop_blocks_remaining + the reason, skips gates, and is promoted to failed at run end (maxPasses 1)', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Needs a key', body: 'FAKE: defer because missing key' })],
      { maxPasses: 1 }
    );

    const t = byId(result, 'T001');
    expect(t.status).toBe('failed');
    expect(t.attempts).toHaveLength(2);

    const real = t.attempts[0];
    expect(real.passNumber).toBe(1);
    expect(real.subagentExitCode).toBe(0);
    expect(real.deferReason).toBe('verify_loop_blocks_remaining');
    expect(real.deferDetail).toBe('missing key');
    // Gates are skipped when the subagent already said it is not done.
    expect(real.gateResults).toEqual([]);

    const promoted = t.attempts[1];
    expect(promoted.deferReason).toBe('verify_loop_blocks_remaining');
    expect(promoted.deferDetail).toBe('Promoted to failed after orchestrator exit: missing key');
    expect(promoted.finishedAt).toBeDefined();

    // Pass advanced once, then maxPasses stopped the loop.
    expect(result.currentPass).toBe(2);
    expect((await loadState(projectDir))?.tasks[0].status).toBe('failed');
  });

  it('a task deferred in pass 1 is retried in pass 2 with the prior defer reason in its prompt', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Flaky prerequisite',
          body: 'FAKE: once t001-defer defer because missing key\nFAKE: write src/flaky.ts',
        }),
      ],
      { maxPasses: 3 }
    );

    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(t.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'verify_loop_blocks_remaining'],
      [2, undefined],
    ]);
    expect(result.currentPass).toBe(2);
    expect(result.passSnapshots).toEqual([
      { pass: 1, unresolvedIds: ['T001'] },
      { pass: 2, unresolvedIds: ['T001'] },
    ]);

    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(existsSync(logPathFor(projectDir, 'T001', 2))).toBe(true);

    // The pass-2 prompt carries the pass-1 deferDetail ("missing key") in a
    // "Prior attempt context" block: buildSubagentPrompt looks at the
    // previous FINISHED attempt, not the in-flight one pushed before spawn.
    const occurrences = (text: string) => text.split('missing key').length - 1;
    expect(occurrences(prompts[0])).toBe(1); // body only
    expect(occurrences(prompts[1])).toBeGreaterThanOrEqual(2); // body + prior-attempt block
    expect(prompts[1]).toContain('## Prior attempt context (this task was deferred in pass 1)');
  });
});

describe('(c) gate failure', () => {
  it('defers with gate_failed (fenced output in deferDetail), retries once, then no-progress bails before maxPasses', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Write a module', body: 'FAKE: write src/mod.ts' })],
      {
        maxPasses: 4,
        gates: [{ name: 'always-fails', command: 'echo boom-output; false' }],
      }
    );

    const t = byId(result, 'T001');
    expect(t.status).toBe('failed');
    expect(t.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'gate_failed'],
      [2, 'gate_failed'],
      [2, 'gate_failed'], // synthetic "promoted to failed" attempt
    ]);

    const first = t.attempts[0];
    expect(first.subagentExitCode).toBe(0);
    expect(first.gateResults).toHaveLength(1);
    expect(first.gateResults[0]).toMatchObject({ name: 'always-fails', passed: false, exitCode: 1 });
    expect(first.gateResults[0].output).toContain('boom-output');
    expect(first.deferDetail).toContain('Gate "always-fails" failed (exit 1)');
    expect(first.deferDetail).toMatch(/```\nboom-output\n```/);

    expect(t.attempts[2].deferDetail).toMatch(/^Promoted to failed after orchestrator exit: Gate "always-fails" failed/);

    // Pass 2 made no progress → bail; we never burned passes 3 and 4.
    expect(result.currentPass).toBe(2);
    expect(result.passSnapshots).toEqual([
      { pass: 1, unresolvedIds: ['T001'] },
      { pass: 2, unresolvedIds: ['T001'] },
    ]);

    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(2);
    // The pass-2 implementer sees the captured gate output ("boom-output" /
    // `always-fails`) via the prior-attempt block.
    expect(prompts[1]).toContain('boom-output');
    expect(prompts[1]).toContain('always-fails');
  });

  it('a gate that fails once then passes lets the task converge in pass 2', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Write a module', body: 'FAKE: write src/mod.ts' })],
      {
        maxPasses: 3,
        // Fails on its first run, passes from the second. The marker lives
        // OUTSIDE the project tree (the fake's state dir): a marker inside it
        // would be rolled back together with the deferred attempt.
        gates: [{ name: 'needs-marker', command: 'test -f "$FAKE_CLAUDE_STATE_DIR/fixed" || { touch "$FAKE_CLAUDE_STATE_DIR/fixed"; exit 1; }' }],
      }
    );
    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(t.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'gate_failed'],
      [2, undefined],
    ]);
    expect(result.currentPass).toBe(2);
  });
});

describe('(d) dependency ordering', () => {
  it('runs T001 before T002 even though T002 is listed first', async () => {
    const result = await runFresh(
      [
        makeTask('T002', {
          title: 'Consume the module',
          body: 'FAKE: require src/base.ts\nFAKE: mark T002',
          dependencies: ['T001'],
        }),
        makeTask('T001', { title: 'Create the module', body: 'FAKE: write src/base.ts\nFAKE: mark T001' }),
      ],
      { maxPasses: 2 }
    );
    expect(result.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T002', 'done'],
      ['T001', 'done'],
    ]);
    expect(await fake.marks()).toEqual(['T001', 'T002']);
    expect(result.currentPass).toBe(1);
  });

  it('a dependent blocked in pass 1 is promoted to deferred (depends_on_unfinished_task) and runs after its dep succeeds in pass 2', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Create the module (fails once)',
          body: 'FAKE: once t001-boom exit 3\nFAKE: write src/base.ts',
        }),
        makeTask('T002', {
          title: 'Consume the module',
          body: 'FAKE: require src/base.ts\nFAKE: mark T002',
          dependencies: ['T001'],
        }),
      ],
      { maxPasses: 3 }
    );

    expect(result.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(result.currentPass).toBe(2);

    const t1 = byId(result, 'T001');
    expect(t1.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'subagent_error'],
      [2, undefined],
    ]);

    const t2 = byId(result, 'T002');
    expect(t2.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'depends_on_unfinished_task'],
      [2, undefined],
    ]);
    expect(t2.attempts[0].deferDetail).toBe(
      'Pass 1 ended with task still pending (dependencies: T001)'
    );
    // The synthetic attempt never spawned a subagent.
    expect(t2.attempts[0].subagentLogPath).toBeUndefined();
    expect(await fake.prompts()).toHaveLength(3);
    expect(await fake.marks()).toEqual(['T002']);
  });
});

describe('(e) subagent errors and resume', () => {
  it('a non-zero subagent exit defers with subagent_error and is promoted to failed at run end', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Crashy', body: 'FAKE: write src/x.ts\nFAKE: exit 3' })],
      { maxPasses: 1 }
    );
    const t = byId(result, 'T001');
    expect(t.status).toBe('failed');
    expect(t.attempts[0]).toMatchObject({
      passNumber: 1,
      subagentExitCode: 3,
      deferReason: 'subagent_error',
      deferDetail: 'Subagent exited with code 3',
      gateResults: [],
    });
    expect(t.attempts[1].deferReason).toBe('subagent_error');
    expect(t.attempts[1].deferDetail).toContain('Subagent exited with code 3');
  });

  it('a subagent timeout defers with subagent_error mentioning the timeout', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Hangs', body: 'FAKE: sleep 20' })],
      { maxPasses: 1, subagentTimeoutSec: 1 }
    );
    const t = byId(result, 'T001');
    expect(t.status).toBe('failed');
    expect(t.attempts[0].deferReason).toBe('subagent_error');
    expect(t.attempts[0].deferDetail).toBe('Subagent timed out after 1s');
  }, 20_000);

  it('resume in pass 1: an in_progress task with an unfinished attempt is reset to pending and re-attempted; the crashed attempt is kept', async () => {
    // Run 1: the subagent blew up (exit 3) — observe the subagent_error defer.
    const first = await runFresh(
      [
        makeTask('T001', { title: 'Create a', body: 'FAKE: once t001-boom exit 3\nFAKE: write src/a.ts' }),
        makeTask('T002', { title: 'Create b', body: 'FAKE: write src/b.ts' }),
      ],
      { maxPasses: 1 }
    );
    expect(byId(first, 'T001').status).toBe('failed');
    expect(byId(first, 'T001').attempts[0].deferReason).toBe('subagent_error');
    expect(byId(first, 'T002').status).toBe('done');

    // Simulate a crash mid-flight on a fresh run of the same plan: state.json
    // holds T001 in_progress with an attempt that never finished (pass 1)
    // and T002 still pending — the shape cli.ts's resume path handles.
    const crashed = makeState(
      [
        makeTask('T001', {
          title: 'Create a',
          body: 'FAKE: write src/a.ts',
          status: 'in_progress',
          attempts: [makeAttempt(1, { subagentLogPath: logPathFor(projectDir, 'T001', 1) })],
        }),
        makeTask('T002', { title: 'Create b', body: 'FAKE: write src/b.ts' }),
      ],
      {
        config: makeConfig({ maxPasses: 2 }),
        passSnapshots: [{ pass: 1, unresolvedIds: ['T001', 'T002'] }],
        commandStartedAt: COMMAND_STARTED_AT,
      }
    );
    await saveState(projectDir, crashed);
    await fake.reset();

    const resumed = await resumeFromDisk();
    expect(resumed.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(resumed.currentPass).toBe(1);
    // Original pass-1 snapshot survives (snapshotPassStart is idempotent).
    expect(resumed.passSnapshots).toEqual([{ pass: 1, unresolvedIds: ['T001', 'T002'] }]);

    const t1 = byId(resumed, 'T001');
    expect(t1.attempts).toHaveLength(2);
    expect(t1.attempts[0].finishedAt).toBeUndefined(); // forensic record of the crash
    expect(t1.attempts[1]).toMatchObject({ passNumber: 1, subagentExitCode: 0 });
    expect(t1.attempts[1].finishedAt).toBeDefined();
    expect(t1.attempts[1].subagentLogPath).toBe(logPathFor(projectDir, 'T001', 2));
    expect(existsSync(logPathFor(projectDir, 'T001', 2))).toBe(true);
    expect(resumed.commandStartedAt).toBe(COMMAND_STARTED_AT);
    expect(await fake.prompts()).toHaveLength(2);
  });

  it('resume at pass >= 2: the reset pending task is promoted to deferred at pass end and retried in the next pass', async () => {
    const crashed = makeState(
      [
        makeTask('T001', {
          title: 'Create a',
          body: 'FAKE: write src/a.ts',
          status: 'in_progress',
          attempts: [
            makeAttempt(1, { finishedAt: new Date().toISOString(), deferReason: 'gate_failed', deferDetail: 'Gate "g" failed (exit 1).' }),
            makeAttempt(2), // crashed mid-retry
          ],
        }),
        makeTask('T002', {
          title: 'Create b',
          body: 'FAKE: write src/b.ts',
          status: 'deferred',
          attempts: [makeAttempt(1, { finishedAt: new Date().toISOString(), deferReason: 'gate_failed', deferDetail: 'Gate "g" failed (exit 1).' })],
        }),
      ],
      {
        currentPass: 2,
        config: makeConfig({ maxPasses: 4 }),
        passSnapshots: [
          { pass: 1, unresolvedIds: ['T001', 'T002'] },
          { pass: 2, unresolvedIds: ['T001', 'T002'] },
        ],
      }
    );
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, crashed);

    const resumed = await resumeFromDisk();
    expect(resumed.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(resumed.currentPass).toBe(3);

    const t1 = byId(resumed, 'T001');
    expect(t1.attempts.map((a) => [a.passNumber, a.deferReason, a.finishedAt !== undefined])).toEqual([
      [1, 'gate_failed', true],
      [2, undefined, false], // crashed attempt preserved
      [2, 'depends_on_unfinished_task', true], // pending → deferred promotion at end of pass 2
      [3, undefined, true],
    ]);
    const t2 = byId(resumed, 'T002');
    expect(t2.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'gate_failed'],
      [2, undefined],
    ]);
  });

  it('resume at pass >= 2 when the crashed task is the ONLY unresolved one: it is re-queued and retried in the same pass', async () => {
    // After cli.ts resets in_progress → pending, the orchestrator re-queues
    // the task as `deferred` at the top of the pass (annotating the
    // interrupted attempt with the last real defer reason) so the retry
    // happens in pass N instead of the no-progress guard bailing on it.
    const crashed = makeState(
      [
        makeTask('T001', {
          title: 'Create a',
          body: 'FAKE: write src/a.ts',
          status: 'in_progress',
          attempts: [
            makeAttempt(1, { finishedAt: new Date().toISOString(), deferReason: 'gate_failed', deferDetail: 'Gate "g" failed (exit 1).' }),
            makeAttempt(2),
          ],
        }),
        makeTask('T002', { title: 'Create b', body: 'FAKE: write src/b.ts', status: 'done', attempts: [makeAttempt(1, { finishedAt: new Date().toISOString() })] }),
      ],
      {
        currentPass: 2,
        config: makeConfig({ maxPasses: 4 }),
        passSnapshots: [
          { pass: 1, unresolvedIds: ['T001', 'T002'] },
          { pass: 2, unresolvedIds: ['T001'] },
        ],
      }
    );
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, crashed);

    const resumed = await resumeFromDisk();
    const t1 = byId(resumed, 'T001');
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(1);
    expect(t1.status).toBe('done');
    expect(resumed.currentPass).toBe(2);
    expect(t1.attempts.map((a) => [a.passNumber, a.deferReason, a.finishedAt !== undefined])).toEqual([
      [1, 'gate_failed', true],
      // The interrupted attempt is kept open (a finished attempt in the
      // current pass would make the queue skip the task) and annotated with
      // the last REAL reason, not 'unknown'.
      [2, 'gate_failed', false],
      [2, undefined, true],
    ]);
    expect(t1.attempts[1].deferDetail).toMatch(/^Interrupted mid-task/);
    expect(t1.attempts[1].deferDetail).toContain('Gate "g" failed (exit 1).');
    // The retry prompt still shows the pass-1 gate failure via the carried signal.
    expect(prompts[0]).toContain('Gate "g" failed (exit 1).');
  });
});

describe('(f) vibe-enhance injection', () => {
  it('injects one ENHANCE-all task after the implicit group completes and runs it to done', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Create greeting module', body: 'FAKE: write src/greet.ts' }),
        makeTask('T002', { title: 'Create farewell module', body: 'FAKE: write src/bye.ts' }),
      ],
      { maxPasses: 2, vibeEnhance: true }
    );

    expect(result.tasks.map((t) => [t.id, t.kind, t.status])).toEqual([
      ['T001', 'user', 'done'],
      ['T002', 'user', 'done'],
      ['ENHANCE-all', 'enhance', 'done'],
    ]);
    const enhance = byId(result, 'ENHANCE-all');
    expect(enhance.dependencies).toEqual(['T001', 'T002']);
    expect(enhance.feature).toBeUndefined();
    expect(enhance.body).toContain('- T001: Create greeting module');
    expect(enhance.body).toContain('- T002: Create farewell module');
    expect(enhance.attempts).toHaveLength(1);
    expect(enhance.attempts[0].gateResults[0]).toMatchObject({ name: 'ok', passed: true });
    expect(existsSync(logPathFor(projectDir, 'ENHANCE-all', 1))).toBe(true);

    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toMatch(/vibe-enhance/i);
    expect(prompts[2]).toContain('Create greeting module');

    // Persisted, so a resume would not re-inject.
    const persisted = await loadState(projectDir);
    expect(persisted?.tasks.filter((t) => t.kind === 'enhance')).toHaveLength(1);
  });

  it('injects one enhance task per feature group, right after that group\'s last task', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Login form', body: 'FAKE: mark T001', feature: 'US1' }),
        makeTask('T002', { title: 'Login API', body: 'FAKE: mark T002', feature: 'US1' }),
        makeTask('T003', { title: 'Profile page', body: 'FAKE: mark T003', feature: 'US2' }),
      ],
      { maxPasses: 2, vibeEnhance: true }
    );
    expect(result.tasks.map((t) => t.id)).toEqual(['T001', 'T002', 'ENHANCE-us1', 'T003', 'ENHANCE-us2']);
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true);
    expect(byId(result, 'ENHANCE-us1').feature).toBe('US1');
    expect(byId(result, 'ENHANCE-us1').dependencies).toEqual(['T001', 'T002']);
    expect(byId(result, 'ENHANCE-us2').dependencies).toEqual(['T003']);

    // Execution order: the US1 enhance pass ran BEFORE T003 started.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(5);
    expect(prompts[2]).toMatch(/vibe-enhance/i);
    expect(prompts[3]).toContain('Profile page');
    expect(prompts[4]).toMatch(/vibe-enhance/i);
  });

  it('does not inject when a sibling in the group failed', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Good', body: 'FAKE: write src/good.ts' }),
        makeTask('T002', { title: 'Bad', body: 'FAKE: defer because nope' }),
      ],
      { maxPasses: 1, vibeEnhance: true }
    );
    expect(result.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'failed'],
    ]);
    expect(result.tasks.some((t) => t.kind === 'enhance')).toBe(false);
  });

  it('ENHANCE-<feature> depends on VERIFY-<feature> when both are injected (verifyMode feature + vibeEnhance)', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Login form', body: 'FAKE: mark T001', feature: 'US1' }),
        makeTask('T002', { title: 'Profile page', body: 'FAKE: mark T002', feature: 'US2' }),
      ],
      { maxPasses: 2, vibeEnhance: true, useVerifyLoop: true, verifyMode: 'feature' }
    );
    expect(result.tasks.map((t) => t.id)).toEqual(['T001', 'VERIFY-us1', 'ENHANCE-us1', 'T002', 'VERIFY-us2', 'ENHANCE-us2']);
    expect(result.tasks.every((t) => t.status === 'done')).toBe(true);
    expect(byId(result, 'ENHANCE-us1').dependencies).toEqual(['T001', 'VERIFY-us1']);
    expect(byId(result, 'ENHANCE-us2').dependencies).toEqual(['T002', 'VERIFY-us2']);
    expect(byId(result, 'VERIFY-us1').dependencies).toEqual(['T001']);
    const prompts = await fake.prompts();
    expect(prompts[1]).toContain('# Feature verification pass');
    expect(prompts[2]).toMatch(/vibe-enhance/i);
  });

  it('a deferred VERIFY-<feature> holds its ENHANCE-<feature> back (dependency, not just ordering)', async () => {
    await fake.script('# Feature verification pass', 'FAKE: defer because reviewers found a BLOCK');
    const result = await runFresh(
      [makeTask('T001', { title: 'Login form', body: 'FAKE: mark T001', feature: 'US1' })],
      { maxPasses: 1, vibeEnhance: true, useVerifyLoop: true, verifyMode: 'feature' }
    );
    expect(byId(result, 'VERIFY-us1').status).toBe('failed');
    const enhance = byId(result, 'ENHANCE-us1');
    expect(enhance.status).toBe('failed');
    expect(enhance.attempts.every((a) => a.subagentLogPath === undefined)).toBe(true); // never spawned
    expect(enhance.attempts[0].deferReason).toBe('depends_on_unfinished_task');
    expect((await fake.prompts()).length).toBe(2);
  });

  it('is disabled by default (vibeEnhance false → no synthetic tasks)', async () => {
    const result = await runFresh([makeTask('T001', { body: 'FAKE: write src/x.ts' })], { maxPasses: 1 });
    expect(result.tasks.map((t) => t.id)).toEqual(['T001']);
  });

  it('enhanceBudget=0: the enhance task completes done with no subagent spawn at all', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Create greeting module', body: 'FAKE: write src/greet.ts' })],
      { maxPasses: 1, vibeEnhance: true, enhanceBudget: 0 }
    );
    const enhance = byId(result, 'ENHANCE-all');
    expect(enhance.status).toBe('done');
    expect(enhance.attempts).toHaveLength(1);
    // No subagent was ever spawned for it: no log path, no gate results.
    expect(enhance.attempts[0].subagentLogPath).toBeUndefined();
    expect(enhance.attempts[0].gateResults).toEqual([]);
    expect(enhance.attempts[0].enhance).toEqual({ applied: 0, optional: 0, promote: [] });
    expect(existsSync(logPathFor(projectDir, 'ENHANCE-all', 1))).toBe(false);

    // Only T001's prompt was ever sent to `claude` — one spawn total for the run.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(1);
  });

  it('budget exhausted by an earlier group\'s applied additions: a later group\'s enhance task is skipped without spawning', async () => {
    // Every vibe-enhance prompt shares the same H1, so this script fires for
    // any invocation — the point of the test is that it must fire AT MOST
    // ONCE (for ENHANCE-us1); if the budget check regresses and ENHANCE-us2
    // is spawned too, it would ALSO report applied=1 and the prompt count /
    // log-path assertions below would catch it.
    await fake.script('# vibe-enhance pass', 'FAKE: echo FULLAUTO_ENHANCE: applied=1 optional=0 promote=none');
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Login form', body: 'FAKE: mark T001', feature: 'US1' }),
        makeTask('T002', { title: 'Profile page', body: 'FAKE: mark T002', feature: 'US2' }),
      ],
      { maxPasses: 2, vibeEnhance: true, enhanceBudget: 1 }
    );
    expect(result.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T001', 'done'],
      ['ENHANCE-us1', 'done'],
      ['T002', 'done'],
      ['ENHANCE-us2', 'done'],
    ]);
    expect(result.enhanceBudgetRemaining).toBe(0);

    const first = byId(result, 'ENHANCE-us1');
    expect(first.attempts[0].subagentLogPath).toBeDefined();
    expect(first.attempts[0].enhance).toEqual({ applied: 1, optional: 0, promote: [] });

    const second = byId(result, 'ENHANCE-us2');
    expect(second.attempts).toHaveLength(1);
    expect(second.attempts[0].subagentLogPath).toBeUndefined(); // never spawned
    expect(second.attempts[0].enhance).toEqual({ applied: 0, optional: 0, promote: [] });
    expect(existsSync(logPathFor(projectDir, 'ENHANCE-us2', 1))).toBe(false);

    // T001, T002, ENHANCE-us1 — ENHANCE-us2 never reached `claude` at all.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(3);
  });
});

describe('(g) stuck-task detection (identical gate failure)', () => {
  it('a task whose configured gate fails identically every attempt gets exactly 2 real spawns, then fails — not the full maxPasses worth', async () => {
    const result = await runFresh(
      [makeTask('T001', { title: 'Always broken', body: 'FAKE: mark T001' })],
      { maxPasses: 4, gates: [{ name: 'always-fails', command: 'echo boom && exit 1' }] }
    );
    const t1 = byId(result, 'T001');
    expect(t1.status).toBe('failed');
    // Only the two attempts that ESTABLISHED the identical-failure streak
    // actually spawned a subagent; queue.next() stops offering the task
    // once stuckOnIdenticalGateFailure trips, so a 3rd/4th identical-cost
    // spawn (up to maxPasses=4) never happens.
    const realSpawns = t1.attempts.filter((a) => a.subagentLogPath !== undefined);
    expect(realSpawns).toHaveLength(2);
    expect(realSpawns.every((a) => a.deferReason === 'gate_failed')).toBe(true);
    const marks = await fake.marks();
    expect(marks.filter((m) => m === 'T001')).toHaveLength(2); // the real `claude` binary itself ran exactly twice
  });
});
