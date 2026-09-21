/**
 * End-to-end TDD red/green flow against a real temp git project with a real
 * `node --test` runner (TAP reporter, so failures are attributed to files).
 * See test/e2e/audit-flow.e2e.test.ts for the fixture conventions.
 *
 *   (a) red task → done (not deferred), red set recorded, gate note says
 *       "expected failure"; an unrelated impl task passes with the red test
 *       quarantined; the green task turns it green and retires the record
 *   (b) green task that edits the red test file → audit_failed / tdd-green
 *   (c) red task whose tests pass immediately → tdd_red_expected (with and
 *       without the audit)
 *   (d) a red task retried after an unrelated gate failure still records its
 *       test file (the retry diff spans every attempt)
 *   (e) classification regressions behind (a): a red task's stub is implied
 *       `wired by` its green task; `- tests:` resolves a red-by-marker task
 *       even when its kind was misclassified
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOrchestrator } from '../../src/orchestrator.js';
import { ensureFullautoDir, loadState, saveState } from '../../src/persistence.js';
import { classifyTask } from '../../src/task-class.js';
import type { RunState, Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, cleanup } from '../helpers/tmp.js';
import { makeConfig, makeState, makeTask } from '../helpers/fixtures.js';

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;

const TEST_SCRIPT = "node --test --test-reporter=tap 'test/*.test.mjs'";
const PACKAGE_JSON = JSON.stringify(
  { name: 'tdd-fixture', version: '1.0.0', private: true, type: 'module', scripts: { test: TEST_SCRIPT } },
  null,
  2
);
const BASELINE_FILES: Record<string, string> = {
  '.gitignore': '.fullauto/\n',
  'package.json': `${PACKAGE_JSON}\n`,
  'README.md': '# tdd fixture\n',
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

/** Single-line ESM sources (the fake writes whole lines). */
const MUL_TEST =
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { mul } from '../src/mul.mjs'; test('mul', () => { assert.equal(mul(2, 3), 6); });";
const MUL_STUB = "export function mul() { throw new Error('not implemented'); }";
const MUL_IMPL = 'export function mul(a, b) { return a * b; }';
const BYE_TEST =
  "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { bye } from '../src/bye.mjs'; test('bye', () => { assert.equal(bye(), 'bye'); });";

/** Red task: failing test + a stub that only the test references. */
const redTask = (id: string, extra: string[] = []) =>
  makeTask(id, {
    title: 'Write failing tests for mul',
    body: [
      'Write failing tests for mul',
      '- tdd: red',
      '- level: unit',
      `FAKE: append test/mul.test.mjs ${MUL_TEST}`,
      `FAKE: append src/mul.mjs ${MUL_STUB}`,
      ...extra,
      'FAKE: echo FULLAUTO_TDD: red=1 green=0',
    ].join('\n'),
  });

/** Green task: implements mul in the stub and wires it into the entrypoint. */
const greenTask = (id: string, redId: string, extra: string[] = []) =>
  makeTask(id, {
    title: 'Implement mul',
    body: [
      'Implement mul',
      `- tests: ${redId}`,
      `FAKE: writeln src/mul.mjs ${MUL_IMPL}`,
      "FAKE: append src/index.mjs export { mul } from './mul.mjs';",
      ...extra,
      'FAKE: echo FULLAUTO_TDD: red=0 green=1',
      'FAKE: echo FULLAUTO_WIRING:',
      'FAKE: echo - src/mul.mjs#mul -> src/index.mjs',
    ].join('\n'),
    dependencies: [redId],
  });

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
const blocks = (t: Task, idx = 0) => (t.attempts[idx].audit?.findings ?? []).filter((f) => f.severity === 'block');

describe('(a) red → quarantine → green', () => {
  it('red task is done with a red set; an unrelated task passes with the red test quarantined; the green task retires the record', async () => {
    // Array order puts the unrelated task between red and green so it runs
    // while the red test is still failing.
    const result = await runFresh(
      [
        redTask('T001'),
        makeTask('T003', {
          title: 'Add bye helper',
          body: [
            'Add bye helper',
            "FAKE: append src/bye.mjs export const bye = () => 'bye';",
            "FAKE: append src/index.mjs export { bye } from './bye.mjs';",
            `FAKE: append test/bye.test.mjs ${BYE_TEST}`,
            'FAKE: echo FULLAUTO_WIRING:',
            'FAKE: echo - src/bye.mjs#bye -> src/index.mjs',
          ].join('\n'),
        }),
        greenTask('T002', 'T001'),
      ],
      { maxPasses: 2 }
    );

    expect(result.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T001', 'done'],
      ['T003', 'done'],
      ['T002', 'done'],
    ]);
    expect(result.currentPass).toBe(1);
    expect(await fake.marks()).toEqual([]);

    // --- red ---
    const red = byId(result, 'T001').attempts[0];
    expect(red.deferReason).toBeUndefined();
    expect(red.classification).toMatchObject({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'], wiredBy: 'T002' });
    expect(red.classification?.rationale).toContain('wired by T002 (implied: the sole green task wires this red task\'s stubs)');
    // The raw gate FAILED (that is the point) but the effective verdict was rewritten.
    expect(red.gateResults[0]).toMatchObject({ name: 'test', passed: false, role: 'test' });
    expect(red.gateResults[0].note).toContain('expected failure (TDD red): test/mul.test.mjs');
    expect(red.tdd).toEqual({ phase: 'red', failing: 1, passed: 1 });
    expect(red.audit?.blocked).toBe(false);
    // The stub is accepted as orphan-for-now, owed by the green task.
    expect(red.audit?.findings.some((f) => f.check === 'orphan-code' && f.severity === 'info' && f.path === 'src/mul.mjs')).toBe(true);

    // --- unrelated task under quarantine ---
    const mid = byId(result, 'T003').attempts[0];
    expect(mid.deferReason).toBeUndefined();
    expect(mid.classification).toMatchObject({ kind: 'impl', tdd: 'none' });
    expect(mid.gateResults[0].passed).toBe(false);
    expect(mid.gateResults[0].note).toBe('quarantined red tests: test/mul.test.mjs');
    expect(mid.audit?.blocked).toBe(false);
    // Test-count check: 1 (baseline) → 2 passing, the red test is not counted as passing.
    expect(mid.audit?.testCounts).toMatchObject({ passed: 2, failed: 1, failingFiles: ['test/mul.test.mjs'] });

    // --- green ---
    const green = byId(result, 'T002').attempts[0];
    expect(green.deferReason).toBeUndefined();
    expect(green.classification).toMatchObject({ kind: 'impl', tdd: 'green', redTaskIds: ['T001'] });
    expect(green.gateResults[0]).toMatchObject({ passed: true });
    expect(green.gateResults[0].note).toBeUndefined();
    expect(green.audit?.blocked).toBe(false);
    expect(green.audit?.findings.some((f) => f.check === 'tdd-green' && f.severity !== 'info')).toBe(false);
    expect(green.audit?.findings.some((f) => f.check === 'pending-wiring' && f.severity === 'block')).toBe(false);
    expect(green.tdd).toEqual({ phase: 'green', failing: 0, passed: 3 });

    // Run-level state: red set retired, stub wiring promise fulfilled, baseline advanced.
    expect(result.redTests).toEqual([]);
    expect(result.pendingWiring).toEqual([]);
    expect(result.testBaseline).toMatchObject({ runner: 'node-test', passed: 3, failed: 0 });
    expect((await loadState(projectDir))?.redTests).toEqual([]);

    // Prompts: the green task was told which file is its contract and what it owes.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('## TDD protocol (RED phase — machine-checked)');
    expect(prompts[0]).toContain('expected to be wired by its green task T002');
    expect(prompts[2]).toContain('## TDD protocol (GREEN phase — machine-checked)');
    expect(prompts[2]).toContain('- test/mul.test.mjs (written by T001)');
    expect(prompts[2]).toContain('### Artifacts from earlier tasks that THIS task must wire');
    expect(prompts[2]).toContain('- src/mul.mjs (created by T001)');
  });

  it('intermediate state after the red task alone: redTests holds the fingerprinted file and the promise is pending', async () => {
    const result = await runFresh([redTask('T001'), greenTask('T002', 'T001', ['FAKE: defer because not yet'])]);
    expect(byId(result, 'T001').status).toBe('done');
    expect(result.redTests).toHaveLength(1);
    const rec = result.redTests[0];
    expect(rec.taskId).toBe('T001');
    expect(rec.failing).toBe(1);
    expect(rec.files.map((f) => f.path)).toEqual(['test/mul.test.mjs']);
    expect(rec.files[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.pendingWiring).toEqual([{ artifactPath: 'src/mul.mjs', createdBy: 'T001', wiredBy: 'T002' }]);
    // The green task deferred itself, so the red set is still open at run end.
    expect(byId(result, 'T002').status).toBe('failed');
    expect(result.redTests).toHaveLength(1);
  });
});

describe('(b) green task tampering with the contract', () => {
  it('modifying the red test file → audit_failed with a tdd-green tampering BLOCK', async () => {
    const result = await runFresh(
      [redTask('T001'), greenTask('T002', 'T001', ['FAKE: append test/mul.test.mjs // loosened'])],
      { maxPasses: 1 }
    );
    const green = byId(result, 'T002');
    expect(green.attempts[0].deferReason).toBe('audit_failed');
    // Gates were green (mul is implemented) — only the hash check catches it.
    expect(green.attempts[0].gateResults[0].passed).toBe(true);
    const tamper = blocks(green).find((f) => f.check === 'tdd-green');
    expect(tamper?.path).toBe('test/mul.test.mjs');
    expect(tamper?.message).toContain('test tampering');
    expect(tamper?.message).toContain('FULLAUTO_TEST_CHANGE');
    expect(green.attempts[0].deferDetail).toContain('tdd-green');
    // The red set is NOT retired by a blocked green attempt.
    expect(result.redTests.map((r) => r.taskId)).toEqual(['T001']);
  });

  it('the same edit declared with FULLAUTO_TEST_CHANGE is downgraded to WARN → done', async () => {
    const result = await runFresh(
      [
        redTask('T001'),
        greenTask('T002', 'T001', [
          'FAKE: append test/mul.test.mjs // loosened',
          'FAKE: echo FULLAUTO_TEST_CHANGE: test/mul.test.mjs — the expected value was wrong',
        ]),
      ],
      { maxPasses: 1 }
    );
    const green = byId(result, 'T002');
    expect(green.status).toBe('done');
    const notice = green.attempts[0].audit?.findings.find((f) => f.check === 'tdd-green');
    expect(notice?.severity).toBe('warn');
    expect(notice?.message).toContain('the expected value was wrong');
    expect(result.redTests).toEqual([]);
  });
});

describe('(c) red task whose tests pass immediately', () => {
  const passingRed = makeTask('T001', {
    title: 'Write failing tests for add',
    body: [
      'Write failing tests for add',
      '- tdd: red',
      "FAKE: append test/add2.test.mjs import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.mjs'; test('add again', () => { assert.equal(add(2, 2), 4); });",
    ].join('\n'),
  });

  it('with the audit on: tdd_red_expected, carrying the tdd-red finding, no red set recorded', async () => {
    const result = await runFresh([passingRed]);
    const t = byId(result, 'T001');
    const a = t.attempts[0];
    expect(a.gateResults[0].passed).toBe(true);
    expect(a.deferReason).toBe('tdd_red_expected');
    expect(a.deferDetail).toMatch(/^This is a TDD red task but the test gate PASSED/);
    expect(a.audit?.blocked).toBe(true);
    expect(blocks(t).some((f) => f.check === 'tdd-red')).toBe(true);
    expect(a.deferDetail).toContain('[BLOCK] tdd-red');
    expect(result.redTests).toEqual([]);
    expect(t.status).toBe('failed');
  });

  it('with the audit off: still tdd_red_expected (the orchestrator backstop), same message', async () => {
    const result = await runFresh([passingRed], { audit: { enabled: false } });
    const a = byId(result, 'T001').attempts[0];
    expect(a.deferReason).toBe('tdd_red_expected');
    expect(a.deferDetail).toMatch(/^This is a TDD red task but the test gate PASSED/);
    expect(a.audit?.findings).toEqual([]);
    expect(result.redTests).toEqual([]);
  });

  it('with the audit off, a genuinely failing red task still records its red set from the real diff', async () => {
    const result = await runFresh([redTask('T001')], { audit: { enabled: false } });
    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(result.redTests.map((r) => [r.taskId, r.files.map((f) => f.path)])).toEqual([['T001', ['test/mul.test.mjs']]]);
  });
});

describe('(d) retried red task keeps its test file in the diff', () => {
  it('pass 1 fails an unrelated gate, pass 2 writes nothing — the red set still fingerprints test/mul.test.mjs', async () => {
    const result = await runFresh(
      [
        makeTask('T001', {
          title: 'Write failing tests for mul',
          body: [
            'Write failing tests for mul',
            '- tdd: red',
            `FAKE: once t001-test append test/mul.test.mjs ${MUL_TEST}`,
            `FAKE: once t001-stub append src/mul.mjs ${MUL_STUB}`,
          ].join('\n'),
        }),
        greenTask('T002', 'T001', ['FAKE: defer because later']),
      ],
      {
        maxPasses: 3,
        // The overlay of the previous attempt's touched files is what keeps
        // the red set complete here; it only matters while that attempt's
        // changes are still in the tree, so rollback-on-defer is off.
        rollbackOnDefer: false,
        gates: [
          // Fails exactly once (first invocation), then passes.
          { name: 'lint', command: 'test -f .lint-ok || { touch .lint-ok; exit 1; }' },
          TEST_GATE,
        ],
      }
    );
    const t = byId(result, 'T001');
    expect(t.status).toBe('done');
    expect(t.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'gate_failed'],
      [2, undefined],
    ]);
    // Pass 1 recorded what the task touched; the pass-2 subagent was a no-op.
    expect(t.attempts[0].touched?.map((f) => f.path).sort()).toEqual(['.lint-ok', 'src/mul.mjs', 'test/mul.test.mjs']);
    const log2 = await readFile(t.attempts[1].subagentLogPath!, 'utf-8');
    expect(log2).toContain('once(t001-test) already consumed');
    // ...yet the pass-2 audit still saw the test file as this task's, so the
    // red set is complete and no "red task added no test file" BLOCK fired.
    expect(t.attempts[1].audit?.blocked).toBe(false);
    expect(t.attempts[1].audit?.changed).toMatchObject({ added: 3 });
    expect(result.redTests.map((r) => [r.taskId, r.files.map((f) => f.path)])).toEqual([['T001', ['test/mul.test.mjs']]]);
    expect(result.pendingWiring).toEqual([{ artifactPath: 'src/mul.mjs', createdBy: 'T001', wiredBy: 'T002' }]);
    expect(existsSync(join(projectDir, 'test/mul.test.mjs'))).toBe(true);
  });
});

describe('(e) classification regressions', () => {
  it('a red task with a paired green task is implied `wired by` that green task; an explicit marker still wins', () => {
    const red = makeTask('T001', { title: 'Tests for mul', body: 'Tests for mul\n- tdd: red' });
    const green = makeTask('T002', { title: 'Implement mul', body: 'Implement mul\n- tests: T001', dependencies: ['T001'] });
    const cls = classifyTask(red, [red, green]);
    expect(cls).toMatchObject({ tdd: 'red', greenTaskIds: ['T002'], wiredBy: 'T002' });

    // An explicit marker must name an existing, still-open task; T009 is
    // one, so it overrides the implied green-task target.
    const explicit = makeTask('T001', { title: 'Tests for mul', body: 'Tests for mul\n- tdd: red\n- wired by: T009' });
    const wirer = makeTask('T009', { title: 'Mount mul in the CLI', body: 'Mount mul in the CLI', dependencies: ['T002'] });
    expect(classifyTask(explicit, [explicit, green, wirer]).wiredBy).toBe('T009');
    // ...and is ignored (with a rationale note) when the named task does not
    // exist — the explicit marker also suppresses the implied green-task
    // fallback, so this task has to wire its own stub.
    const dangling = classifyTask(explicit, [explicit, green]);
    expect(dangling.wiredBy).toBeUndefined();
    expect(dangling.rationale).toContain('wired by: T009 ignored — no such task; wire the artifact in this task');

    // No green task → nobody will wire a stub → no implied promise.
    const lonely = makeTask('T001', { title: 'Tests for mul', body: 'Tests for mul\n- tdd: red' });
    expect(classifyTask(lonely, [lonely]).wiredBy).toBeUndefined();
  });

  it('`- tests: T###` pointing at a red-by-marker task resolves even when that task was heuristically classed as config', () => {
    // "Set up ..." trips the config heuristic; the `- tdd: red` marker still makes it a red task.
    const red = makeTask('T001', { title: 'Set up failing contract tests for mul', body: 'Set up failing contract tests for mul\n- tdd: red' });
    const green = makeTask('T002', { title: 'Implement mul', body: 'Implement mul\n- tests: T001', dependencies: ['T001'] });
    expect(classifyTask(red, [red, green])).toMatchObject({ kind: 'config', tdd: 'red' });
    expect(classifyTask(green, [red, green])).toMatchObject({ kind: 'impl', tdd: 'green', redTaskIds: ['T001'] });
  });
});
