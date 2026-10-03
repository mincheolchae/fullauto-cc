/**
 * Gate baseline pre-flight: a gate that is already red on the untouched tree
 * must stop a fresh run BEFORE any implementer spawn (every task would fail
 * it identically), and must not fire on resume or for gates that may
 * legitimately probe something the run is about to build.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, saveState } from '../../src/persistence.js';
import type { RunState, Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, cleanup } from '../helpers/tmp.js';
import { makeAttempt, makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;
let warnings: string[];

beforeAll(async () => {
  fake = await makeFakeClaude();
  restoreEnv = fake.install();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  restoreEnv();
  await fake.dispose();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await fake.reset();
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void warnings.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  projectDir = await makeGitRepo({ '.gitignore': '.fullauto/\n', 'README.md': '# baseline\n', 'src/index.ts': 'export {};\n' });
});

afterEach(async () => {
  await cleanup(projectDir);
});

async function run(tasks: Task[], cfg: Record<string, unknown>): Promise<RunState> {
  const state = makeState(tasks, { config: makeConfig({ baselineCheck: 'abort', ...cfg }) });
  await ensureFullautoDir(projectDir);
  await saveState(projectDir, state);
  return runOrchestrator({ projectDir, state, verbose: false });
}

const task = () => makeTask('T001', { title: 'Add helper', body: 'FAKE: write src/helper.ts' });
const red = { name: 'typecheck', role: 'typecheck', command: 'echo "error TS2304: Cannot find name x" ; exit 2' };
const green = { name: 'test', role: 'test', command: 'true' };

describe('gate baseline', () => {
  it('a red shell typecheck gate aborts a fresh run before any subagent is spawned', async () => {
    await expect(run([task()], { gates: [green, red] })).rejects.toThrow(/Baseline gate check failed[\s\S]*typecheck[\s\S]*TS2304/);
    expect(await fake.prompts()).toHaveLength(0);
  });

  it('baselineCheck: warn reports the red gate and still runs', async () => {
    const state = await run([task()], { gates: [red], baselineCheck: 'warn', maxPasses: 1 });
    expect(warnings.join('\n')).toMatch(/already red before any task ran/);
    expect(await fake.prompts()).toHaveLength(1);
    expect(state.tasks[0].attempts[0].deferReason).toBe('gate_failed');
  });

  it('baselineCheck: off does not run the gates up front', async () => {
    const state = await run([task()], { gates: [{ name: 'once', role: 'lint', command: 'test -f .fullauto/seen || { mkdir -p .fullauto; touch .fullauto/seen; exit 1; }' }], baselineCheck: 'off', maxPasses: 2 });
    // The one-shot gate failed on the task's own run (first execution), not at baseline.
    expect(state.tasks[0].attempts[0].deferReason).toBe('gate_failed');
    expect(state.tasks[0].status).toBe('done');
  });

  it('http / e2e style gates only warn: they may probe something the run is about to build', async () => {
    const state = await run([task()], {
      gates: [{ name: 'e2e', role: 'e2e', command: 'exit 1' }, green],
      maxPasses: 1,
    });
    expect(warnings.join('\n')).toMatch(/already red/);
    expect(await fake.prompts()).toHaveLength(1);
    expect(state.tasks[0].attempts[0].deferReason).toBe('gate_failed');
  });

  it('is skipped when the run already started (resume): a task with an attempt means the tree is not untouched', async () => {
    const started = makeTask('T001', { title: 'Add helper', body: 'FAKE: write src/helper.ts', attempts: [makeAttempt(1, { finishedAt: new Date().toISOString(), deferReason: 'gate_failed', deferDetail: 'x' })], status: 'deferred' });
    const state = makeState([started], { currentPass: 2, config: makeConfig({ baselineCheck: 'abort', gates: [red], maxPasses: 3 }) });
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, state);
    await expect(runOrchestrator({ projectDir, state, verbose: false })).resolves.toBeDefined();
    expect(await fake.prompts()).toHaveLength(1);
  });

  it('a green baseline is silent and the run proceeds normally', async () => {
    const state = await run([task()], { gates: [green] });
    expect(state.tasks[0].status).toBe('done');
    expect(warnings.join('\n')).not.toMatch(/already red/);
  });
});
