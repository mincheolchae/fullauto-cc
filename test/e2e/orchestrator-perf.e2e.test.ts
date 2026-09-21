/**
 * Runtime-efficiency regression: resuming a crashed attempt used to take
 * TWO working-tree snapshots (`git status --porcelain` + a re-hash of every
 * dirty file) back to back for the identical, unchanged tree — one inside
 * `resolvePriorTouched` to rebuild the crashed attempt's touched-file list,
 * then another, redundant one immediately after in `processOneTask` to
 * build `before`. Nothing runs between the two calls, so the second one
 * could only ever reproduce the first. `resolvePriorTouched` now hands its
 * snapshot back so `processOneTask` reuses it instead of re-asking git the
 * same question (src/orchestrator.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, saveState } from '../../src/persistence.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, cleanup, git, makeGitCallCounter, type GitCallCounter } from '../helpers/tmp.js';
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
    'README.md': '# perf fixture\n',
    'src/index.ts': 'export {};\n',
  });
});

afterEach(async () => {
  await cleanup(projectDir);
});

/** Prepend the git-call-counter shim to PATH (in front of the fake-claude bin dir already there) for the duration of `run`. */
async function withGitCallCounter<T>(run: (counter: GitCallCounter) => Promise<T>): Promise<T> {
  const counter = await makeGitCallCounter();
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`;
    return await run(counter);
  } finally {
    process.env.PATH = originalPath;
    await counter.cleanup();
  }
}

describe('crash-resume reuses one working-tree snapshot instead of taking a redundant second one', () => {
  it('a resumed attempt with a crashed baseline takes exactly 2 `git status` snapshots (before + after), not 3', async () => {
    // Same "crashed attempt" shape as orchestrator-hardening.e2e.test.ts (b):
    // baseline persisted, no `touched` list (the process died before it got
    // that far) — resolvePriorTouched has to rebuild `touched` by diffing
    // the baseline against the tree as it is now, which is where the
    // formerly-redundant extra snapshot lived.
    const headSha = git(['rev-parse', 'HEAD'], projectDir).trim();
    await writeFile(join(projectDir, 'src', 'orphan.ts'), 'export const orphan = 1;\n', 'utf-8');
    const crashed = makeState(
      [
        makeTask('T001', {
          title: 'Add helper module',
          body: 'FAKE: mark done',
          status: 'in_progress',
          attempts: [makeAttempt(1, { baseline: { headSha, dirty: [] }, subagentLogPath: join(projectDir, '.fullauto/logs/T001-attempt1.log') })],
        }),
      ],
      { config: makeConfig({ maxPasses: 1, audit: { enabled: false } }) }
    );
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, crashed);
    crashed.tasks[0].status = 'pending'; // cli.ts resume: in_progress → pending

    const result = await withGitCallCounter((counter) =>
      runOrchestrator({ projectDir, state: crashed, verbose: false }).then(async (r) => {
        const statusCalls = await counter.callsFor('status');
        expect(statusCalls.length).toBe(2);
        return r;
      })
    );

    const t = result.tasks.find((x) => x.id === 'T001')!;
    expect(t.status).toBe('done');
    expect(t.attempts).toHaveLength(2); // the crashed attempt + this resumed one
  }, 20_000);

  it('baseline for comparison: a normal (non-crashed) attempt also takes exactly 2 snapshots', async () => {
    const state = makeState([makeTask('T001', { title: 'Write a file', body: 'FAKE: write src/a.ts\nFAKE: mark done' })], {
      config: makeConfig({ maxPasses: 1, audit: { enabled: false } }),
    });
    await ensureFullautoDir(projectDir);
    await saveState(projectDir, state);

    await withGitCallCounter(async (counter) => {
      const result = await runOrchestrator({ projectDir, state, verbose: false });
      expect(result.tasks[0].status).toBe('done');
      expect((await counter.callsFor('status')).length).toBe(2);
    });
  }, 20_000);
});
