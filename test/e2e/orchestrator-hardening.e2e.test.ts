/**
 * Orchestrator hardening (reviewer round V1/V3) against a temp git project
 * with the fake `claude`:
 *
 *   (a) the in-flight attempt (with its pre-task baseline + log path) is on
 *       disk WHILE the subagent runs — a real crash leaves it for the resume
 *   (b) a retry after a crashed attempt is audited against that attempt's
 *       baseline: an orphan the crashed attempt left behind still BLOCKs
 *   (c) `overlayTouched` rewinds HEAD to the first attempt's baseline so a
 *       commit made by an earlier attempt stays in the diff
 *   (d) `.fullauto/config.json` edited during a task → audit_failed with a
 *       gate-integrity BLOCK, the file is restored from the snapshot, and the
 *       next task passes
 *   (e) enhance passes get the remaining budget, their FULLAUTO_ENHANCE line
 *       decrements it and the promote ids land on the attempt
 *   (f) preflight warns when no test gate would run, and the warning is
 *       persisted for the final report
 *   (g) rollback-on-defer outside a git repository: one WARN per run, the
 *       tree is left alone, nothing crashes
 *   (h) a shutdown signal mid-subagent (flag set in-process): the attempt is
 *       annotated `interrupted by signal`, left unfinished, state is saved,
 *       and the orchestrator rejects with the signal's exit code
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrchestrator, overlayTouched, preflightWarnings } from '../../src/orchestrator.js';
import { ensureFullautoDir, loadState, saveConfigSnapshot, saveState } from '../../src/persistence.js';
import { InterruptedError, requestShutdown, resetShutdown } from '../../src/runner/process-group.js';
import { requeueFailedTasks } from '../../src/run-flow.js';
import { RunConfig, type RunState, type Task } from '../../src/types.js';
import type { TreeSnapshot } from '../../src/audit/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, makeTmpDir, cleanup, git, writeFiles } from '../helpers/tmp.js';
import { makeAttempt, makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

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
    'README.md': '# hardening fixture\n',
    'src/index.ts': 'export {};\n',
  });
});

afterEach(async () => {
  await cleanup(projectDir);
});

async function runFresh(tasks: Task[], cfg: Record<string, unknown> = {}): Promise<RunState> {
  const state = makeState(tasks, { config: makeConfig(cfg) });
  await ensureFullautoDir(projectDir);
  await saveState(projectDir, state);
  return runOrchestrator({ projectDir, state, verbose: false });
}

const byId = (state: RunState, id: string): Task => {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
};

describe('(a) in-flight attempt is persisted before the subagent runs', () => {
  it('state.json shows the task in_progress with baseline + log path while the fake sleeps', async () => {
    const running = runFresh([makeTask('T001', { title: 'Slow', body: 'FAKE: sleep 2\nFAKE: write src/slow.ts' })], { maxPasses: 1, subagentTimeoutSec: 10 });
    await new Promise((r) => setTimeout(r, 900));
    const mid = await loadState(projectDir);
    const t = mid!.tasks[0];
    expect(t.status).toBe('in_progress');
    expect(t.attempts).toHaveLength(1);
    expect(t.attempts[0].finishedAt).toBeUndefined();
    expect(t.attempts[0].baseline).toBeDefined();
    expect(t.attempts[0].baseline!.headSha).toBe(git(['rev-parse', 'HEAD'], projectDir).trim());
    expect(t.attempts[0].baseline!.dirty).toEqual([]);
    expect(t.attempts[0].subagentLogPath).toMatch(/T001-attempt1\.log$/);
    // The run-level bookkeeping was persisted at start too.
    expect(mid!.enhanceBudgetRemaining).toBe(3);
    expect(mid!.configFingerprints).toEqual({});

    const done = await running;
    expect(done.tasks[0].status).toBe('done');
    // finishedAt is stamped after gates + audit, so it is at least the subagent's duration later.
    const a = done.tasks[0].attempts[0];
    expect(new Date(a.finishedAt!).getTime() - new Date(a.startedAt).getTime()).toBeGreaterThanOrEqual(2000);
  }, 20_000);
});

describe('(b) retry after a crash is audited against the crashed attempt\'s baseline', () => {
  it('an orphan file left by the crashed attempt BLOCKs the retry even though the retry touched nothing', async () => {
    // Crashed attempt: baseline = clean tree at HEAD; then it wrote an orphan
    // and the process died before anything else was recorded.
    const headSha = git(['rev-parse', 'HEAD'], projectDir).trim();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(projectDir, 'src', 'orphan.ts'), 'export const orphan = 1;\n', 'utf-8');
    const crashed = makeState(
      [
        makeTask('T001', {
          title: 'Add helper module',
          body: 'FAKE: mark retry',
          status: 'in_progress',
          attempts: [makeAttempt(1, { baseline: { headSha, dirty: [] }, subagentLogPath: join(projectDir, '.fullauto/logs/T001-attempt1.log') })],
        }),
      ],
      { config: makeConfig({ maxPasses: 1, audit: { enabled: true, testCount: false } }) }
    );
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, crashed);
    // cli.ts resume: in_progress → pending.
    crashed.tasks[0].status = 'pending';
    const result = await runOrchestrator({ projectDir, state: crashed, verbose: false });

    const t = byId(result, 'T001');
    const retry = t.attempts[1];
    expect(retry.subagentLogPath).toMatch(/T001-attempt2\.log$/);
    expect(retry.deferReason).toBe('audit_failed');
    expect(retry.audit?.findings.some((f) => f.check === 'orphan-code' && f.severity === 'block' && f.path === 'src/orphan.ts')).toBe(true);
    // The rebuilt touched list names the orphan so a third attempt keeps seeing it.
    expect(retry.touched?.map((x) => x.path)).toContain('src/orphan.ts');
    expect(await fake.marks()).toEqual(['retry']);
  }, 20_000);

  it('the same tree with NO crashed baseline treats the orphan as pre-existing dirt (documents what the rebuild fixes)', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(projectDir, 'src', 'orphan.ts'), 'export const orphan = 1;\n', 'utf-8');
    const result = await runFresh([makeTask('T001', { title: 'Add helper module', body: 'FAKE: mark x' })], {
      maxPasses: 1,
      audit: { enabled: true, testCount: false },
    });
    expect(byId(result, 'T001').status).toBe('done');
  }, 20_000);
});

describe('(c) overlayTouched rewinds HEAD to the original baseline', () => {
  it('replaces headSha when an origin is given and differs; leaves the snapshot alone otherwise', () => {
    const snap: TreeSnapshot = { takenAt: 't', headSha: 'new', dirty: new Map(), contents: new Map(), gitRepo: true };
    expect(overlayTouched(snap, [], 'orig').headSha).toBe('orig');
    expect(overlayTouched(snap, [], null).headSha).toBeNull();
    expect(overlayTouched(snap, [], 'new')).toBe(snap);
    expect(overlayTouched(snap, [])).toBe(snap);
    const withTouched = overlayTouched(snap, [{ path: 'src/x.ts', beforeHash: 'h', beforeSize: 1 }], 'orig');
    expect(withTouched.headSha).toBe('orig');
    expect(withTouched.dirty.get('src/x.ts')).toMatchObject({ hash: 'h' });
  });
});

describe('(d) config-file integrity', () => {
  it('a task that edits .fullauto/config.json is BLOCKed, the file is restored, and the next task passes', async () => {
    await saveConfigSnapshot(projectDir, { gates: [{ name: 'ok', command: 'true' }], audit: { enabled: false } });
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Sneaky', body: 'FAKE: writeln .fullauto/config.json {"gates":[]}' }),
        makeTask('T002', { title: 'Honest', body: 'FAKE: write src/honest.ts' }),
      ],
      { maxPasses: 1 }
    );
    expect(result.configFingerprints?.configJson).toBeDefined();

    const sneaky = byId(result, 'T001');
    expect(sneaky.status).toBe('failed');
    expect(sneaky.attempts[0].deferReason).toBe('audit_failed');
    expect(sneaky.attempts[0].gateResults).toEqual([]); // no gate time spent on a tampered config
    const finding = sneaky.attempts[0].audit?.findings[0];
    expect(finding).toMatchObject({ check: 'gate-integrity', severity: 'block' });
    expect(finding?.message).toContain('`.fullauto/config.json` was modified during the task');
    expect(sneaky.attempts[0].deferDetail).toContain('config.json');

    // Restored from the run's config snapshot (defaults filled in), not left as `{"gates":[]}`.
    const restored = RunConfig.parse(JSON.parse(await readFile(join(projectDir, '.fullauto', 'config.json'), 'utf-8')));
    expect(restored.gates.map((g) => g.name)).toEqual(['ok']);
    expect(byId(result, 'T002').status).toBe('done');
  }, 20_000);
});

describe('(e) enhance budget', () => {
  it('passes the remaining budget to each enhance pass and decrements it from FULLAUTO_ENHANCE', async () => {
    await fake.script('# vibe-enhance pass', 'FAKE: echo FULLAUTO_ENHANCE: applied=1 optional=2 promote=F003,F007');
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Login', body: 'FAKE: write src/login.ts', feature: 'US1' }),
        makeTask('T002', { title: 'Profile', body: 'FAKE: write src/profile.ts', feature: 'US2' }),
      ],
      { maxPasses: 2, vibeEnhance: true, enhanceBudget: 2 }
    );
    expect(result.tasks.map((t) => t.id)).toEqual(['T001', 'ENHANCE-us1', 'T002', 'ENHANCE-us2']);
    expect(result.enhanceBudgetRemaining).toBe(0);
    expect(byId(result, 'ENHANCE-us1').attempts[0].enhance).toEqual({ applied: 1, optional: 2, promote: ['F003', 'F007'] });
    const prompts = await fake.prompts();
    expect(prompts[1]).toContain('invoke it with `budget=2`');
    expect(prompts[3]).toContain('invoke it with `budget=1`');
    // A third pass would be told the budget is gone.
    expect(prompts[3]).not.toContain('budget=0');
  }, 20_000);

  it('an enhance attempt that is deferred AND rolled back adds nothing, so it does not eat the budget', async () => {
    await fake.script('# vibe-enhance pass', 'FAKE: write src/enh.ts\nFAKE: echo FULLAUTO_ENHANCE: applied=2 optional=0 promote=none\nFAKE: defer because blocks remain');
    const result = await runFresh([makeTask('T001', { title: 'X', body: 'FAKE: write src/x.ts' })], { maxPasses: 1, vibeEnhance: true, enhanceBudget: 3 });
    const enh = byId(result, 'ENHANCE-all');
    expect(enh.attempts[0].rollback?.deleted).toBe(1);
    expect(enh.attempts[0].enhance?.applied).toBe(2);
    expect(result.enhanceBudgetRemaining).toBe(3);
  }, 20_000);

  it('...but when the additions could NOT be rolled back (rollbackOnDefer: false) they stay in the tree and are charged', async () => {
    await fake.script('# vibe-enhance pass', 'FAKE: write src/enh.ts\nFAKE: echo FULLAUTO_ENHANCE: applied=2 optional=0 promote=none\nFAKE: defer because blocks remain');
    const result = await runFresh([makeTask('T001', { title: 'X', body: 'FAKE: write src/x.ts' })], { maxPasses: 1, vibeEnhance: true, enhanceBudget: 3, rollbackOnDefer: false });
    expect(result.enhanceBudgetRemaining).toBe(1);
  }, 20_000);

  it('does not go negative and leaves the budget alone when the line is missing', async () => {
    const result = await runFresh([makeTask('T001', { title: 'X', body: 'FAKE: write src/x.ts' })], { maxPasses: 2, vibeEnhance: true, enhanceBudget: 1 });
    expect(result.enhanceBudgetRemaining).toBe(1);
    expect(byId(result, 'ENHANCE-all').attempts[0].enhance).toBeUndefined();
  }, 20_000);
});

describe('(f) preflight: tests never run', () => {
  const state = (gates: unknown[], tasks: Task[]) => makeState(tasks, { config: makeConfig({ gates }) });
  const impl = [makeTask('T001', { title: 'Implement POST /users handler in src/users.ts' })];

  it('warns when no test-role gate exists and impl tasks are present', () => {
    expect(preflightWarnings(state([{ name: 'typecheck', command: 'tsc' }], impl))).toEqual([
      expect.stringMatching(/^tests never run: no gate with a test role is configured/),
    ]);
    expect(preflightWarnings(state([{ name: 'test', command: 'npm test' }], impl))).toEqual([]);
    // Docs-only runs have nothing to test.
    expect(preflightWarnings(state([{ name: 'typecheck', command: 'tsc' }], [makeTask('T001', { title: 'Update README docs' })]))).toEqual([]);
  });

  it('warns on `--if-present` with no test script; not when the script exists', () => {
    const s = state([{ name: 'test', command: 'npm test --if-present' }], impl);
    expect(preflightWarnings(s, { scripts: { build: 'tsc' } })).toEqual([
      expect.stringMatching(/gate "test" uses `--if-present` and package.json has no `test` script/),
    ]);
    expect(preflightWarnings(s, { scripts: { test: 'vitest run' } })).toEqual([]);
    expect(preflightWarnings(s)).toEqual([]); // no package.json → cannot tell
  });

  it('persists the warning in state for the final report', async () => {
    const result = await runFresh([makeTask('T001', { title: 'Implement greet in src/greet.ts', body: 'FAKE: write src/greet.ts' })], { maxPasses: 1 });
    expect(result.preflightWarnings).toHaveLength(1);
    expect((await loadState(projectDir))?.preflightWarnings).toEqual(result.preflightWarnings);
  }, 20_000);
});

describe('(g) rollback-on-defer without git', () => {
  it('warns once per run, leaves the partial changes in place, and the run still terminates', async () => {
    const plain = await makeTmpDir('fullauto-nongit-');
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    try {
      const state = makeState(
        [
          makeTask('T001', { title: 'Write a', body: 'FAKE: write src/a.ts' }),
          makeTask('T002', { title: 'Write b', body: 'FAKE: write src/b.ts' }),
        ],
        { config: makeConfig({ maxPasses: 2, gates: [{ name: 'always-fails', command: 'echo nope; false' }] }) }
      );
      await ensureFullautoDir(plain);
      await saveState(plain, state);
      const result = await runOrchestrator({ projectDir: plain, state, verbose: false });
      expect(result.tasks.map((t) => t.status)).toEqual(['failed', 'failed']);
      // Four deferred attempts, ONE warning.
      const warns = logs.filter((l) => l.includes('rollbackOnDefer is on but this is not a git repository'));
      expect(warns).toHaveLength(1);
      expect(result.tasks.flatMap((t) => t.attempts).every((a) => a.rollback === undefined)).toBe(true);
      expect(result.tasks[0].attempts[0].baseline?.treeSha).toBeUndefined();
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(plain, 'src', 'a.ts'))).toBe(true);
    } finally {
      vi.mocked(console.log).mockImplementation(() => {});
      await cleanup(plain);
    }
  }, 20_000);
});

describe('(h) shutdown signal mid-subagent (in-process)', () => {
  afterEach(() => resetShutdown());

  it('kills the subagent, annotates the in-flight attempt, saves state and rejects with exit code 130 / 143', async () => {
    const state = makeState(
      [
        makeTask('T001', { title: 'Fast', body: 'FAKE: write src/fast.ts' }),
        makeTask('T002', { title: 'Slow', body: 'FAKE: sleep 30\nFAKE: write src/slow.ts' }),
        makeTask('T003', { title: 'Never', body: 'FAKE: mark never' }),
      ],
      { config: makeConfig({ maxPasses: 2, subagentTimeoutSec: 60 }) }
    );
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, state);
    const running = runOrchestrator({ projectDir, state, verbose: false });
    // Wait until T002's subagent is on disk as in-flight, then "press Ctrl-C".
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      const mid = await loadState(projectDir);
      if (mid?.tasks[1].status === 'in_progress' && mid.tasks[1].attempts[0]?.subagentLogPath) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    const killedAt = Date.now();
    requestShutdown('SIGINT');
    await expect(running).rejects.toBeInstanceOf(InterruptedError);
    await running.catch((e: InterruptedError) => {
      expect(e.signal).toBe('SIGINT');
      expect(e.exitCode).toBe(130);
    });
    // The fake's trap made it exit promptly — well inside the SIGKILL grace period.
    expect(Date.now() - killedAt).toBeLessThan(5000);

    const saved = (await loadState(projectDir))!;
    expect(saved.tasks.map((t) => t.status)).toEqual(['done', 'in_progress', 'pending']);
    const slow = saved.tasks[1].attempts[0];
    expect(slow.finishedAt).toBeUndefined();
    expect(slow.deferDetail).toBe('interrupted by signal (SIGINT)');
    expect(slow.deferReason).toBeUndefined();
    expect(slow.subagentExitCode).toBeUndefined();
    expect(await fake.marks()).toEqual([]); // T003 never started
    expect(await readFile(slow.subagentLogPath!, 'utf-8')).toContain('INTERRUPTED by SIGINT');

    // The flag is process-wide: a resume in the same process would refuse to
    // start until it is cleared (the CLI exits instead).
    resetShutdown();
    for (const t of saved.tasks) if (t.status === 'in_progress') t.status = 'pending';
    // The retry would sleep again; make it instant.
    saved.tasks[1].body = 'FAKE: write src/slow.ts';
    const resumed = await runOrchestrator({ projectDir, state: saved, verbose: false });
    expect(resumed.tasks.map((t) => t.status)).toEqual(['done', 'done', 'done']);
    expect(resumed.tasks[1].attempts.map((a) => [a.passNumber, a.finishedAt !== undefined])).toEqual([[1, false], [1, true]]);
  }, 30_000);
});

describe('(i) `fullauto retry` establishes a fresh baseline, not the original failed run\'s (round 3, item 1.6)', () => {
  it('the user fixing + committing the real cause between runs is not mistaken for THIS attempt changing gate config', async () => {
    // Real cause: a genuinely broken test script — the gate fails for a
    // reason that has nothing to do with what the subagent does.
    await writeFiles(projectDir, {
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(1)"' } }, null, 2) + '\n',
    });
    git(['add', '-A'], projectDir);
    git(['commit', '-q', '-m', 'broken test script'], projectDir);

    // Nothing to wire / no new code file — isolates the regression to the
    // gate-integrity check, not orphan-code or wiring-manifest noise.
    const state = makeState([makeTask('T001', { title: 'Add feature', body: 'FAKE: mark ran' })], {
      config: makeConfig({ maxPasses: 1, gates: [{ name: 'test', command: 'npm test' }], audit: { enabled: true, testCount: false } }),
    });
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, state);
    const first = await runOrchestrator({ projectDir, state, verbose: false });
    expect(first.tasks[0].status).toBe('failed');
    expect(first.tasks[0].attempts[0].deferReason).toBe('gate_failed');

    // The user fixes the underlying cause OUTSIDE the orchestrator, exactly
    // as `fullauto retry`'s own description tells them to ("after you fixed
    // the cause"), and commits it — nothing is running at this point.
    await writeFiles(projectDir, {
      'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n',
    });
    git(['add', '-A'], projectDir);
    git(['commit', '-q', '-m', 'fix test script'], projectDir);

    // attempts[0] = the real subagent attempt; the orchestrator appended a
    // synthetic "promoted to failed" attempt at maxPasses exhaustion.
    expect(first.tasks[0].attempts).toHaveLength(2);
    const plan = requeueFailedTasks(first);
    expect(plan.requeued).toEqual(['T001']);
    // The retry boundary is recorded ahead of the new attempt.
    expect(first.tasks[0].baselineResetAtAttempt).toBe(2);
    await saveState(projectDir, first);

    const retried = await runOrchestrator({ projectDir, state: first, verbose: false });
    expect(retried.tasks[0].status).toBe('done');
    const retryAttempt = retried.tasks[0].attempts[2];
    // The user's own fix must never be reported as THIS attempt having
    // changed gate configuration.
    expect(retryAttempt.audit?.findings.filter((f) => f.check === 'gate-integrity')).toEqual([]);
  }, 20_000);
});
