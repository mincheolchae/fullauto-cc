/**
 * End-to-end audit-flow tests: the orchestrator + the deterministic post-task
 * audit against a REAL temp git project with a REAL test runner.
 *
 * The project is a tiny `node --test` package (`npm test` → node:test with the
 * TAP reporter, which `parseTestOutput` attributes to files via `location:`).
 * A fake `claude` on PATH (test/helpers/fake-claude.ts) is driven by `FAKE:`
 * directives in each task body, so every scenario below is a deterministic
 * replay of a specific implementer behavior:
 *
 *   (a) orphan module → audit_failed / orphan-code → wired on pass 2 → done;
 *       and the negative: an untouched orphan stays blocked on pass 2
 *   (b) new `.skip` / `.todo` → audit_failed / test-integrity
 *   (c) package.json scripts.test edit → gate-integrity BLOCK; allowed with
 *       `- touches-config:`
 *   (d) wired module + real passing test → done, no BLOCK, baseline grows
 *   (e) the pass-2 prompt carries pass-1 audit findings verbatim
 *   (f) `fullauto audit` CLI exit codes and `--base`
 *   (g) audit/TDD state survives save → load → resume
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, loadState, saveState } from '../../src/persistence.js';
import type { RunState, Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, makeTmpDir, cleanup, git } from '../helpers/tmp.js';
import { makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;

/** `npm test` runs node:test with the TAP reporter so failures carry `location:` lines. */
const TEST_SCRIPT = "node --test --test-reporter=tap 'test/*.test.mjs'";

const PACKAGE_JSON = JSON.stringify(
  { name: 'audit-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: TEST_SCRIPT } },
  null,
  2
);

const BASELINE_FILES: Record<string, string> = {
  // `fullauto init` / `run` gitignore `.fullauto/` so state.json (which quotes
  // every task body and finding) is never searched as a code reference.
  '.gitignore': '.fullauto/\n',
  'package.json': `${PACKAGE_JSON}\n`,
  'README.md': '# audit fixture\n',
  'src/index.mjs': "export { add } from './add.mjs';\n",
  'src/add.mjs': 'export function add(a, b) {\n  return a + b;\n}\n',
  'test/add.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from '../src/add.mjs';",
    "test('add', () => {",
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'),
};

const TEST_GATE = { name: 'test', command: 'npm test --silent', role: 'test' };

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
  projectDir = await makeGitRepo(BASELINE_FILES);
});

afterEach(async () => {
  await cleanup(projectDir);
});

async function runFresh(tasks: Task[], cfg: Record<string, unknown> = {}): Promise<RunState> {
  const state = makeState(tasks, {
    config: makeConfig({ audit: { enabled: true }, gates: [TEST_GATE], maxPasses: 1, ...cfg }),
  });
  await ensureFullautoDir(projectDir);
  await saveState(projectDir, state);
  return runOrchestrator({ projectDir, state, verbose: false });
}

const byId = (state: RunState, id: string): Task => {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
};

const blocks = (t: Task, attemptIdx = 0) =>
  (t.attempts[attemptIdx].audit?.findings ?? []).filter((f) => f.severity === 'block');

/** A single-line ESM test file body (the fake writes whole lines). */
const mulTestLine =
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { mul } from '../src/mul.mjs'; test('mul', () => { assert.equal(mul(2, 3), 6); });";

describe('(a) orphan code is blocked until it is wired', () => {
  it('pass 1: unreferenced src/components/Foo.mjs → audit_failed with orphan-code; pass 2 wires it → done', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Create Foo component',
          body: [
            'Create Foo component',
            '- no test: fixture',
            // Pass 1 writes Foo and (deliberately) leaves it unreferenced by
            // overwriting index.mjs AFTER the import was appended. The `once`
            // stamp means pass 2 keeps the appended import → Foo is wired.
            'FAKE: write src/components/Foo.mjs',
            "FAKE: append src/index.mjs import './components/Foo.mjs';",
            'FAKE: once t001-unwire write src/index.mjs',
          ].join('\n'),
        }),
      ],
      { maxPasses: 3 }
    );

    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(t.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'audit_failed'],
      [2, undefined],
    ]);

    const first = t.attempts[0];
    expect(first.gateResults[0]).toMatchObject({ name: 'test', passed: true, role: 'test' });
    expect(first.audit?.blocked).toBe(true);
    const orphan = blocks(t).find((f) => f.check === 'orphan-code');
    expect(orphan?.path).toBe('src/components/Foo.mjs');
    expect(first.deferDetail).toContain('orphan-code');
    expect(first.deferDetail).toContain('src/components/Foo.mjs');
    expect(first.deferDetail).toMatch(/^Post-task audit BLOCKED/);

    const second = t.attempts[1];
    expect(second.audit?.blocked).toBe(false);
    expect(blocks(t, 1)).toEqual([]);
    expect(await readFile(join(projectDir, 'src/index.mjs'), 'utf-8')).toContain("import './components/Foo.mjs'");
  });

  it('negative: an orphan left untouched on pass 2 is STILL blocked (audit diffs against the task baseline, not the previous attempt)', async () => {
    // rollbackOnDefer off: this test is about the touched-file overlay that
    // keeps a retry honest when the previous attempt's changes are still in
    // the tree (rollback disabled, or unavailable). With rollback on, the
    // orphan would be removed after pass 1 — see the rollback scenarios.
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Create Foo component',
          body: ['Create Foo component', '- no test: fixture', 'FAKE: once t001-write write src/components/Foo.mjs'].join('\n'),
        }),
      ],
      { maxPasses: 2, rollbackOnDefer: false }
    );
    const t = byId(result, 'T001');
    expect(t.status).toBe('failed');
    // Pass 2's subagent changed nothing (the `once` stamp was consumed), yet
    // the orphan is re-detected instead of silently passing.
    expect(t.attempts.slice(0, 2).map((a) => a.deferReason)).toEqual(['audit_failed', 'audit_failed']);
    expect(blocks(t, 1).some((f) => f.check === 'orphan-code' && f.path === 'src/components/Foo.mjs')).toBe(true);
    // The retry baseline is persisted on the deferred attempt (Foo was clean-absent pre-task: no beforeHash).
    expect(t.attempts[0].touched).toEqual([{ path: 'src/components/Foo.mjs' }]);
    expect(t.attempts[1].touched).toEqual([{ path: 'src/components/Foo.mjs' }]);
  });

  it('a file left dirty by an EARLIER task is rewound to that task\'s version, not HEAD, when the retry is diffed', async () => {
    const result = await runFresh(
      [
        // T001 leaves src/index.mjs dirty (uncommitted) with an extra export line.
        makeTask('T001', {
          title: 'Update README',
          body: ['Update README', 'FAKE: append README.md more', "FAKE: append src/index.mjs export const fromT001 = 1;"].join('\n'),
        }),
        // T002 modifies index.mjs again AND leaves an orphan; pass 2 is a no-op.
        makeTask('T002', {
          title: 'Create Foo component',
          body: [
            'Create Foo component',
            '- no test: fixture',
            'FAKE: once t002-foo write src/components/Foo.mjs',
            'FAKE: once t002-idx append src/index.mjs export const fromT002 = 2;',
          ].join('\n'),
          dependencies: ['T001'],
        }),
      ],
      // Overlay machinery under test (see the negative case above).
      { maxPasses: 2, rollbackOnDefer: false }
    );
    const t2 = byId(result, 'T002');
    expect(t2.attempts.slice(0, 2).map((a) => a.deferReason)).toEqual(['audit_failed', 'audit_failed']);
    const idx = t2.attempts[0].touched?.find((f) => f.path === 'src/index.mjs');
    // index.mjs was dirty before T002 (T001's edit) → its pre-task fingerprint is kept.
    expect(idx?.beforeHash).toMatch(/^[0-9a-f]{40}$/);
    expect(idx?.beforeStatus).toBe(' M');
    // The pass-2 diff still attributes exactly T002's changes: Foo added, index.mjs modified.
    expect(t2.attempts[1].audit?.changed).toEqual({ added: 1, modified: 1, deleted: 0 });
    expect(blocks(t2, 1).some((f) => f.check === 'orphan-code' && f.path === 'src/components/Foo.mjs')).toBe(true);
    // T001's own change is not blamed on T002 (no test-integrity / gate-integrity noise on index.mjs).
    expect(blocks(t2, 1).every((f) => f.path === 'src/components/Foo.mjs')).toBe(true);
  });
});

describe('(b) test integrity', () => {
  it('a new test file with .skip / .todo is audit_failed with test-integrity', async () => {
    const result = await runFresh([
      makeTask('T001', {
        title: 'Add skipped tests',
        body: [
          'Add skipped tests',
          '- kind: test',
          "FAKE: append test/skipped.test.mjs import { test } from 'node:test'; import assert from 'node:assert/strict'; test.skip('later', () => { assert.ok(true); }); test.todo('todo');",
        ].join('\n'),
      }),
    ]);
    const t = byId(result, 'T001');
    expect(t.attempts[0].deferReason).toBe('audit_failed');
    // The gate itself is green (skipped tests do not fail) — only the audit catches it.
    expect(t.attempts[0].gateResults[0].passed).toBe(true);
    const integrity = blocks(t).filter((f) => f.check === 'test-integrity');
    expect(integrity.length).toBeGreaterThan(0);
    expect(integrity.some((f) => /skip\/only\/todo/.test(f.message) && f.path === 'test/skipped.test.mjs')).toBe(true);
    expect(t.attempts[0].deferDetail).toContain('test-integrity');
  });
});

describe('(c) gate integrity', () => {
  const tamperedPkg = JSON.stringify({ name: 'audit-fixture', type: 'module', scripts: { test: 'echo tampered' } });

  it('editing package.json scripts.test → gate-integrity BLOCK', async () => {
    const result = await runFresh([
      makeTask('T001', {
        title: 'Speed up the test script',
        body: ['Speed up the test script', '- kind: impl', `FAKE: writeln package.json ${tamperedPkg}`].join('\n'),
      }),
    ]);
    const t = byId(result, 'T001');
    expect(t.attempts[0].deferReason).toBe('audit_failed');
    const gi = blocks(t).find((f) => f.check === 'gate-integrity');
    expect(gi?.path).toBe('package.json');
    expect(gi?.message).toContain('scripts.test');
    expect(gi?.message).toContain('echo tampered');
  });

  it('the same edit with `- touches-config: <reason>` is allowed (INFO) → done', async () => {
    const result = await runFresh([
      makeTask('T001', {
        title: 'Speed up the test script',
        body: ['Speed up the test script', '- kind: impl', '- touches-config: switching test runner', `FAKE: writeln package.json ${tamperedPkg}`].join('\n'),
      }),
    ]);
    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(t.attempts[0].deferReason).toBeUndefined();
    expect(blocks(t)).toEqual([]);
    const gi = t.attempts[0].audit?.findings.find((f) => f.check === 'gate-integrity');
    expect(gi?.severity).toBe('info');
    expect(gi?.message).toContain('touches-config');
  });
});

describe('(d) a properly wired module with a real passing test', () => {
  it('impl task → done, no BLOCK, testBaseline.passed increases', async () => {
    const result = await runFresh(
      [
        // Docs task first: establishes the test baseline (1 passing) without
        // being a behavior task itself.
        makeTask('T001', {
          title: 'Update README',
          body: ['Update README', 'FAKE: append README.md more docs'].join('\n'),
        }),
        makeTask('T002', {
          title: 'Add mul helper',
          body: [
            'Add mul helper',
            'FAKE: append src/mul.mjs export function mul(a, b) { return a * b; }',
            "FAKE: append src/index.mjs export { mul } from './mul.mjs';",
            `FAKE: append test/mul.test.mjs ${mulTestLine}`,
            'FAKE: echo FULLAUTO_TDD: red=1 green=1',
            'FAKE: echo FULLAUTO_WIRING:',
            'FAKE: echo - src/mul.mjs#mul -> src/index.mjs',
          ].join('\n'),
          dependencies: ['T001'],
        }),
      ],
      { maxPasses: 2 }
    );

    expect(result.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    const t1 = byId(result, 'T001');
    expect(t1.attempts[0].classification?.kind).toBe('docs');
    expect(t1.attempts[0].audit?.testCounts).toMatchObject({ runner: 'node-test', passed: 1, failed: 0 });

    const t2 = byId(result, 'T002');
    const a = t2.attempts[0];
    expect(a.classification).toMatchObject({ kind: 'impl', tdd: 'none' });
    expect(a.audit?.blocked).toBe(false);
    expect(blocks(t2)).toEqual([]);
    // No wiring-manifest complaint either: the claim was verified against src/index.mjs.
    expect(a.audit?.findings.some((f) => f.check === 'wiring-manifest')).toBe(false);
    expect(a.audit?.findings.some((f) => f.check === 'orphan-code')).toBe(false);
    expect(a.audit?.testCounts).toMatchObject({ runner: 'node-test', passed: 2, failed: 0 });
    expect(a.tdd).toEqual({ phase: 'none', failing: 0, passed: 2 });
    expect(result.testBaseline).toMatchObject({ runner: 'node-test', passed: 2 });

    // Persisted state carries the baseline and the audit result.
    const persisted = await loadState(projectDir);
    expect(persisted?.testBaseline).toMatchObject({ passed: 2 });
    expect(persisted?.tasks[1].attempts[0].audit?.blocked).toBe(false);
  });

  it('a behavior task that adds NO test is blocked by the test-count check once a baseline exists', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Update README', body: 'Update README\nFAKE: append README.md more' }),
        makeTask('T002', {
          title: 'Add mul helper',
          body: [
            'Add mul helper',
            'FAKE: append src/mul.mjs export function mul(a, b) { return a * b; }',
            "FAKE: append src/index.mjs export { mul } from './mul.mjs';",
          ].join('\n'),
          dependencies: ['T001'],
        }),
      ],
      { maxPasses: 1 }
    );
    const t2 = byId(result, 'T002');
    expect(t2.attempts[0].deferReason).toBe('audit_failed');
    expect(blocks(t2).some((f) => f.check === 'test-count' && /no new tests/.test(f.message))).toBe(true);
  });
});

describe('(e) prior-attempt prompt carries the audit findings', () => {
  it('the pass-2 prompt contains the pass-1 findings text and the prior-attempt header', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Create Foo component',
          body: [
            'Create Foo component',
            '- no test: fixture',
            'FAKE: write src/components/Foo.mjs',
            "FAKE: append src/index.mjs import './components/Foo.mjs';",
            'FAKE: once t001-unwire write src/index.mjs',
          ].join('\n'),
        }),
      ],
      { maxPasses: 2 }
    );
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toContain('Prior attempt context');
    expect(prompts[1]).toContain('## Prior attempt context (this task was deferred in pass 1)');
    expect(prompts[1]).toContain('Post-task audit BLOCKED this attempt');
    expect(prompts[1]).toMatch(/- \[BLOCK\] orphan-code src\/components\/Foo\.mjs/);
    // The whole pass-1 defer signal (rendered findings included) is carried verbatim.
    const detail = byId(result, 'T001').attempts[0].deferDetail!;
    expect(detail).toContain('[BLOCK] orphan-code');
    expect(prompts[1]).toContain(detail);
    // ...and exactly once: findings already inside deferDetail are not rendered a second time.
    expect(prompts[1].split('[BLOCK] orphan-code src/components/Foo.mjs').length - 1).toBe(1);
    // And the depth instruction for a gates-depth task is the explicit opt-out.
    expect(prompts[1]).toContain('Do NOT invoke /verify-loop');
  });
});

describe('(f) `fullauto audit` CLI', () => {
  let distDir: string;
  let cli: string;

  beforeAll(async () => {
    // Compile the real CLI once (~2s) so the test exercises the shipped
    // entrypoint. The scratch dist sits outside the repo, so point module
    // resolution at the repo's node_modules for `commander` / `zod`.
    distDir = await makeTmpDir('fullauto-dist-');
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    execFileSync('npx', ['tsc', '--outDir', distDir], { cwd: repoRoot, stdio: 'ignore' });
    await symlink(join(repoRoot, 'node_modules'), join(distDir, 'node_modules'), 'dir');
    cli = join(distDir, 'cli.js');
  }, 60_000);

  afterAll(async () => {
    await cleanup(distDir);
  });

  async function audit(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const r = await execFileAsync(process.execPath, [cli, 'audit', '--dir', projectDir, ...args], { env: process.env });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  it('clean tree → exit 0, no findings', async () => {
    const r = await audit(['--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ base: 'HEAD', blocked: false, changed: { added: 0, modified: 0, deleted: 0 } });
  });

  it('an orphan in the working tree → exit 1 with an orphan-code BLOCK', async () => {
    await execFileAsync('bash', ['-c', "mkdir -p src/components && printf 'export function Foo() {}\\n' > src/components/Foo.mjs"], { cwd: projectDir });
    const r = await audit(['--json']);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout);
    expect(json.blocked).toBe(true);
    expect(json.findings.some((f: { check: string; path?: string; severity: string }) => f.check === 'orphan-code' && f.path === 'src/components/Foo.mjs' && f.severity === 'block')).toBe(true);

    const text = await audit([]);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('[BLOCK] orphan-code src/components/Foo.mjs');
    expect(text.stdout).toMatch(/Audit BLOCKED: 1 BLOCK/);
  });

  it('--base <ref> audits committed changes since that ref; a bad ref → exit 2', async () => {
    // Commit an orphan so HEAD is clean but HEAD~1..HEAD contains it.
    await execFileAsync('bash', ['-c', "mkdir -p src/components && printf 'export function Foo() {}\\n' > src/components/Foo.mjs"], { cwd: projectDir });
    git(['add', '-A'], projectDir);
    git(['commit', '-q', '-m', 'add orphan'], projectDir);

    const head = await audit(['--json']);
    expect(head.code).toBe(0);
    expect(JSON.parse(head.stdout).changed).toEqual({ added: 0, modified: 0, deleted: 0 });

    const base = await audit(['--base', 'HEAD~1', '--json']);
    expect(base.code).toBe(1);
    const json = JSON.parse(base.stdout);
    expect(json.base).toBe('HEAD~1');
    expect(json.changed.added).toBe(1);
    expect(json.findings.some((f: { check: string; path?: string }) => f.check === 'orphan-code' && f.path === 'src/components/Foo.mjs')).toBe(true);

    const bad = await audit(['--base', 'no-such-ref']);
    expect(bad.code).toBe(2);
    expect(bad.stdout + bad.stderr).toContain('does not resolve');
  });
});

describe('(g) audit / TDD state round-trips through resume', () => {
  it('redTests, pendingWiring and testBaseline survive save → load and a resumed run keeps using them', async () => {
    // Run 1: red task records a red set; T002 (impl, `wired by: T003`) leaves a pending promise.
    const first = await runFresh(
      [
        makeTask('T001', {
          title: 'Write failing tests for mul',
          body: ['Write failing tests for mul', '- tdd: red', `FAKE: append test/mul.test.mjs ${mulTestLine}`].join('\n'),
        }),
        makeTask('T002', {
          title: 'Add farewell helper',
          body: [
            'Add farewell helper',
            '- no test: fixture',
            '- wired by: T003',
            "FAKE: append src/bye.mjs export const bye = () => 'bye';",
          ].join('\n'),
        }),
        makeTask('T003', {
          title: 'Wire farewell helper',
          body: ['Wire farewell helper', '- no test: fixture', 'FAKE: defer because not yet'].join('\n'),
          dependencies: ['T002'],
        }),
      ],
      { maxPasses: 1 }
    );
    expect(byId(first, 'T001').status).toBe('done');
    expect(byId(first, 'T002').status).toBe('done');
    expect(first.redTests.map((r) => [r.taskId, r.files.map((f) => f.path)])).toEqual([['T001', ['test/mul.test.mjs']]]);
    expect(first.pendingWiring).toEqual([{ artifactPath: 'src/bye.mjs', createdBy: 'T002', wiredBy: 'T003' }]);
    expect(first.testBaseline).toMatchObject({ runner: 'node-test', passed: 1 });

    const persisted = await loadState(projectDir);
    expect(persisted?.redTests).toEqual(first.redTests);
    expect(persisted?.pendingWiring).toEqual(first.pendingWiring);
    expect(persisted?.testBaseline).toEqual(first.testBaseline);

    // Resume with T003 re-opened: it now wires bye.mjs, so the pending promise
    // is resolved; the red set (still failing) stays quarantined for it.
    persisted!.config.maxPasses = 3;
    persisted!.currentPass = 3;
    const t3 = persisted!.tasks.find((t) => t.id === 'T003')!;
    t3.status = 'deferred';
    t3.body = ['Wire farewell helper', '- no test: fixture', "FAKE: append src/index.mjs export { bye } from './bye.mjs';"].join('\n');
    await saveState(projectDir, persisted!);
    await fake.reset();
    const resumed = await runOrchestrator({ projectDir, state: persisted!, verbose: false });
    const t3r = byId(resumed, 'T003');
    expect(t3r.status).toBe('done');
    const last = t3r.attempts[t3r.attempts.length - 1];
    expect(last.gateResults[0].note).toContain('quarantined red tests: test/mul.test.mjs');
    expect(resumed.pendingWiring).toEqual([]);
    expect(resumed.redTests.map((r) => r.taskId)).toEqual(['T001']);
    expect(existsSync(join(projectDir, '.fullauto', 'state.json'))).toBe(true);
  });
});

describe('(h) verify-evidence: the depth the implementer was told is enforced by the audit', () => {
  const impl = (extra: string[]) =>
    makeTask('T001', {
      title: 'Add mul helper',
      body: [
        'Add mul helper',
        'FAKE: append src/mul.mjs export function mul(a, b) { return a * b; }',
        "FAKE: append src/index.mjs export { mul } from './mul.mjs';",
        `FAKE: append test/mul.test.mjs ${mulTestLine}`,
        'FAKE: echo FULLAUTO_TDD: red=1 green=1',
        'FAKE: echo FULLAUTO_WIRING:',
        'FAKE: echo - src/mul.mjs#mul -> src/index.mjs',
        ...extra,
      ].join('\n'),
    });
  const full = { useVerifyLoop: true, verifyMode: 'full', testCount: false };

  it('depth=full with no VERIFY_LOOP_RESULT line → audit_failed with a verify-evidence BLOCK', async () => {
    const result = await runFresh([impl([])], { ...full, audit: { enabled: true, testCount: false } });
    const t = byId(result, 'T001');
    expect(t.attempts[0].verifyDepth).toBe('full');
    expect(t.attempts[0].deferReason).toBe('audit_failed');
    const ev = blocks(t).find((f) => f.check === 'verify-evidence');
    expect(ev?.message).toContain('verify-loop was required (depth=full) but no VERIFY_LOOP_RESULT line was emitted');
    expect(t.attempts[0].deferDetail).toContain('verify-evidence');
  });

  it('the receipt at the required depth passes; a lower depth is blocked', async () => {
    const ok = await runFresh([impl(['FAKE: echo VERIFY_LOOP_RESULT: depth=full cycles=1 block=0 warn=0'])], { ...full, audit: { enabled: true, testCount: false } });
    expect(byId(ok, 'T001').status).toBe('done');
    expect(byId(ok, 'T001').attempts[0].audit?.findings.some((f) => f.check === 'verify-evidence')).toBe(false);
    await fake.reset();
    await cleanup(projectDir);
    projectDir = await makeGitRepo(BASELINE_FILES);
    const low = await runFresh([impl(['FAKE: echo VERIFY_LOOP_RESULT: depth=light cycles=1 block=0 warn=0'])], { ...full, audit: { enabled: true, testCount: false } });
    expect(byId(low, 'T001').attempts[0].deferReason).toBe('audit_failed');
    expect(blocks(byId(low, 'T001')).some((f) => f.check === 'verify-evidence' && /depth=light but depth=full was required/.test(f.message))).toBe(true);
  });

  it('depth=gates never asks for a receipt', async () => {
    const result = await runFresh([impl([])], { audit: { enabled: true, testCount: false } });
    expect(byId(result, 'T001').status).toBe('done');
  });
});

describe('(i) `- tests: T###` naming a task that is not in the run (hand-edited state bypasses the validator)', () => {
  it('the delegation is ignored with a rationale note and the task is held to the behavior-task rule', async () => {
    const result = await runFresh(
      [
        makeTask('T001', { title: 'Update README', body: 'Update README\nFAKE: append README.md more' }),
        makeTask('T002', {
          title: 'Add mul helper',
          body: [
            'Add mul helper',
            '- tests: T999',
            'FAKE: append src/mul.mjs export function mul(a, b) { return a * b; }',
            "FAKE: append src/index.mjs export { mul } from './mul.mjs';",
          ].join('\n'),
          dependencies: ['T001'],
        }),
      ],
      { maxPasses: 1 }
    );
    const t2 = byId(result, 'T002');
    const cls = t2.attempts[0].classification!;
    expect(cls.testsDelegatedTo).toBeUndefined();
    expect(cls.rationale).toContain('tests: T999 ignored — no such task; this task must carry its own tests');
    expect(t2.attempts[0].deferReason).toBe('audit_failed');
    expect(blocks(t2).some((f) => f.check === 'test-count' && /no new tests/.test(f.message))).toBe(true);
    // The prompt told the implementer to write its own tests, not to rely on T999.
    const prompts = await fake.prompts();
    expect(prompts[1]).toContain('## TDD protocol (single-task — evidence required)');
    expect(prompts[1]).not.toContain('Tests for this task live in T999');
  });
});
