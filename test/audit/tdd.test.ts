import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/audit/diff.js';
import { takeSnapshot } from '../../src/audit/snapshot.js';
import { buildRedTestRecord, checkTddGreen, checkTddRed, failureMatchesFiles, findTestGate, parseTestChangeNotices } from '../../src/audit/tdd.js';
import { parseTestOutput } from '../../src/audit/test-output.js';
import { isTestFile } from '../../src/audit/patterns.js';
import type { TaskDiff } from '../../src/audit/types.js';
import { auditInput, cls, gate, makeRepo, task, VITEST_FAIL_1_OF_4, VITEST_PASS_4, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const emptySnap = () => ({ takenAt: '', headSha: null, dirty: new Map(), contents: new Map(), gitRepo: true });

function diffWith(files: Array<{ path: string; kind?: 'added' | 'modified' | 'deleted'; after?: string }>): TaskDiff {
  return {
    headMoved: false,
    files: files.map((f) => ({
      path: f.path,
      kind: f.kind ?? 'added',
      after: f.after ?? '',
      isTest: /test/.test(f.path) || isTestFile(f.path),
      isCode: true,
      isGateConfig: false,
    })),
  };
}

describe('findTestGate', () => {
  it('prefers role=test, then the name heuristic, skipping e2e gates', () => {
    const gates = [gate({ name: 'typecheck' }), gate({ name: 'e2e-playwright' }), gate({ name: 'unit tests' }), gate({ name: 'x', role: 'test' })];
    expect(findTestGate(gates)?.name).toBe('x');
    expect(findTestGate(gates.slice(0, 3))?.name).toBe('unit tests');
    expect(findTestGate([gate({ name: 'lint' })])).toBeUndefined();
    expect(findTestGate([gate({ name: 'pytest' })])?.name).toBe('pytest');
  });
});

describe('failureMatchesFiles', () => {
  it('matches paths, go packages and cargo test names', () => {
    expect(failureMatchesFiles('test/x.test.ts', ['test/x.test.ts'], 'vitest')).toBe(true);
    expect(failureMatchesFiles('./test/x.test.ts', ['test/x.test.ts'], 'vitest')).toBe(true);
    expect(failureMatchesFiles('test/y.test.ts', ['test/x.test.ts'], 'vitest')).toBe(false);
    expect(failureMatchesFiles('github.com/acme/app/pkg/pricing', ['pkg/pricing/quote_test.go'], 'go')).toBe(true);
    expect(failureMatchesFiles('github.com/acme/app/pkg/other', ['pkg/pricing/quote_test.go'], 'go')).toBe(false);
    expect(failureMatchesFiles('tests::pricing::quotes', ['tests/pricing.rs'], 'cargo')).toBe(true);
    expect(failureMatchesFiles('pricing::tests::a', ['src/pricing.rs'], 'cargo')).toBe(true);
    expect(failureMatchesFiles('billing::tests::a', ['src/pricing.rs'], 'cargo')).toBe(false);
  });
});

describe('checkTddRed', () => {
  const red = cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'] });

  it('is a no-op for non-red tasks', () => {
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: cls() });
    expect(checkTddRed(input, diffWith([]), undefined)).toEqual([]);
  });

  it('BLOCKs when no test file was added', () => {
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: false, output: VITEST_FAIL_1_OF_4 })] });
    const f = checkTddRed(input, diffWith([{ path: 'src/stub.ts' }]), parseTestOutput(VITEST_FAIL_1_OF_4));
    expect(f.map((x) => x.severity)).toEqual(['block']);
    expect(f[0].message).toContain('no test file');
  });

  it('BLOCKs when the test gate passed', () => {
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: true, output: VITEST_PASS_4 })] });
    const f = checkTddRed(input, diffWith([{ path: 'test/x.test.ts' }]), parseTestOutput(VITEST_PASS_4));
    expect(f).toEqual([expect.objectContaining({ check: 'tdd-red', severity: 'block' })]);
    expect(f[0].message).toMatch(/PASSED.*tdd: none.*tautological/s);
  });

  it('BLOCKs when the failures are not in this task\'s test files', () => {
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: false, output: VITEST_FAIL_1_OF_4 })] });
    const f = checkTddRed(input, diffWith([{ path: 'test/other.test.ts' }]), parseTestOutput(VITEST_FAIL_1_OF_4));
    expect(f).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(f[0].message).toContain('test/x.test.ts');
  });

  it('passes a proper red run and INFOs when there is no test gate / unknown runner', () => {
    const ok = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: false, output: VITEST_FAIL_1_OF_4 })] });
    expect(checkTddRed(ok, diffWith([{ path: 'test/x.test.ts' }]), parseTestOutput(VITEST_FAIL_1_OF_4))).toEqual([]);

    const noGate = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ name: 'typecheck' })] });
    expect(checkTddRed(noGate, diffWith([{ path: 'test/x.test.ts' }]), undefined)).toEqual([expect.objectContaining({ severity: 'info' })]);

    const unknown = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: false, output: 'boom' })] });
    expect(checkTddRed(unknown, diffWith([{ path: 'test/x.test.ts' }]), parseTestOutput('boom'))).toEqual([expect.objectContaining({ severity: 'info' })]);
  });
});

describe('parseTestChangeNotices', () => {
  it('accepts em-dash, hyphen and colon separators', () => {
    expect(parseTestChangeNotices('FULLAUTO_TEST_CHANGE: test/x.test.ts — expected value was wrong\nFULLAUTO_TEST_CHANGE: `test/y.test.ts` - flaky timer\nFULLAUTO_TEST_CHANGE: test/z.test.ts: typo')).toEqual([
      { file: 'test/x.test.ts', reason: 'expected value was wrong' },
      { file: 'test/y.test.ts', reason: 'flaky timer' },
      { file: 'test/z.test.ts', reason: 'typo' },
    ]);
  });
});

describe('checkTddGreen + buildRedTestRecord', () => {
  const green = cls({ kind: 'impl', tdd: 'green', redTaskIds: ['T001'] });

  it('passes when the red files are untouched and now pass', async () => {
    const repo = makeRepo({ 'src/a.ts': '' });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('test/x.test.ts', "it('x', () => expect(add(1,1)).toBe(2));\n");
    const afterRed = await takeSnapshot(repo.dir);
    const record = buildRedTestRecord('T001', await diffSnapshots(before, afterRed, repo.dir), 1, afterRed);
    expect(record.files).toEqual([expect.objectContaining({ path: 'test/x.test.ts', hash: afterRed.dirty.get('test/x.test.ts')!.hash })]);
    expect(record.failing).toBe(1);

    repo.write('src/a.ts', 'export const add = (a: number, b: number) => a + b;\n');
    const afterGreen = await takeSnapshot(repo.dir);
    const input = auditInput(repo.dir, afterRed, afterGreen, {
      classification: green,
      redTests: [record],
      gateResults: [gate({ passed: true, output: VITEST_PASS_4 })],
    });
    const diff = await diffSnapshots(afterRed, afterGreen, repo.dir);
    expect(await checkTddGreen(input, diff, parseTestOutput(VITEST_PASS_4))).toEqual([]);
  });

  it('BLOCKs tampering, downgrades to WARN with FULLAUTO_TEST_CHANGE, BLOCKs deletion and still-failing', async () => {
    const repo = makeRepo({ 'src/a.ts': '' });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('test/x.test.ts', "it('x', () => expect(add(1,1)).toBe(2));\n");
    repo.write('test/y.test.ts', "it('y', () => expect(add(2,2)).toBe(4));\n");
    repo.write('test/z.test.ts', "it('z', () => expect(add(3,3)).toBe(6));\n");
    const afterRed = await takeSnapshot(repo.dir);
    const record = buildRedTestRecord('T001', await diffSnapshots(before, afterRed, repo.dir), 3);

    repo.write('test/x.test.ts', "it('x', () => expect(add(1,1)).toBe(3));\n"); // tampered
    repo.write('test/y.test.ts', "it('y', () => expect(add(2,2)).toBe(5));\n"); // declared change
    repo.rm('test/z.test.ts'); // deleted
    const afterGreen = await takeSnapshot(repo.dir);
    const diff = await diffSnapshots(afterRed, afterGreen, repo.dir);
    const failOut = VITEST_FAIL_1_OF_4; // failing file: test/x.test.ts
    const input = auditInput(repo.dir, afterRed, afterGreen, {
      classification: green,
      redTests: [record],
      subagentStdout: 'done\nFULLAUTO_TEST_CHANGE: test/y.test.ts — the expected sum was wrong in the red task\n',
      gateResults: [gate({ passed: false, output: failOut })],
    });
    const findings = await checkTddGreen(input, diff, parseTestOutput(failOut));
    const find = (re: RegExp) => findings.find((f) => re.test(f.message));
    expect(find(/test tampering/)).toMatchObject({ severity: 'block', path: 'test/x.test.ts' });
    expect(find(/test tampering/)?.message).toMatch(/T001.*FULLAUTO_TEST_CHANGE: test\/x\.test\.ts/);
    expect(find(/FULLAUTO_TEST_CHANGE — reason/)).toMatchObject({ severity: 'warn', path: 'test/y.test.ts' });
    expect(find(/FULLAUTO_TEST_CHANGE — reason/)?.message).toContain('the expected sum was wrong');
    expect(find(/deleted/)).toMatchObject({ severity: 'block', path: 'test/z.test.ts' });
    expect(find(/still failing/)).toMatchObject({ severity: 'block', path: 'test/x.test.ts' });
    expect(findings).toHaveLength(4);
  });

  it('INFOs when no red records exist and falls back to task dependencies for ids', async () => {
    const input = auditInput('/p', emptySnap(), emptySnap(), {
      classification: cls({ kind: 'impl', tdd: 'green', redTaskIds: [] }),
      task: task({ dependencies: ['T001'] }),
      redTests: [],
    });
    expect(await checkTddGreen(input, diffWith([]), undefined)).toEqual([expect.objectContaining({ check: 'tdd-green', severity: 'info' })]);
    expect(await checkTddGreen({ ...input, classification: cls() }, diffWith([]), undefined)).toEqual([]);
  });
});

describe('checkTddRed with an e2e gate (`- level: e2e` red tasks)', () => {
  const red = cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'] });
  const PW_FAIL = [
    'Running 2 tests using 1 worker',
    '',
    '  ✓  1 [chromium] › e2e/home.spec.ts:3:5 › has title (1.2s)',
    '  ✘  2 [chromium] › e2e/login.spec.ts:5:1 › login works (800ms)',
    '',
    '  1) [chromium] › e2e/login.spec.ts:5:1 › login works ────────',
    '',
    '    Error: expect(received).toBe(expected)',
    '',
    '  1 failed',
    '    [chromium] › e2e/login.spec.ts:5:1 › login works ────',
    '  1 passed (2.3s)',
  ].join('\n');

  it('accepts a red task whose e2e-role gate failed on its own spec while the unit gate passed', () => {
    const gates = [gate({ name: 'test', role: 'test', passed: true, output: VITEST_PASS_4 }), gate({ name: 'e2e', role: 'e2e', passed: false, exitCode: 1, output: PW_FAIL })];
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: gates });
    const counts = parseTestOutput(VITEST_PASS_4);
    expect(checkTddRed(input, diffWith([{ path: 'e2e/login.spec.ts' }]), counts)).toEqual([]);
  });

  it('still BLOCKs when both the unit and the e2e gate passed', () => {
    const gates = [gate({ name: 'test', role: 'test', passed: true, output: VITEST_PASS_4 }), gate({ name: 'e2e', role: 'e2e', passed: true, output: PW_FAIL.replace('1 failed', '0 failed') })];
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: gates });
    const f = checkTddRed(input, diffWith([{ path: 'e2e/login.spec.ts' }]), parseTestOutput(VITEST_PASS_4));
    expect(f).toEqual([expect.objectContaining({ check: 'tdd-red', severity: 'block' })]);
    expect(f[0].message).toMatch(/PASSED/);
  });

  it('BLOCKs when the e2e failure is in a spec this task did not write', () => {
    const gates = [gate({ name: 'e2e', role: 'e2e', passed: false, exitCode: 1, output: PW_FAIL })];
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: gates });
    const f = checkTddRed(input, diffWith([{ path: 'e2e/checkout.spec.ts' }]), undefined);
    expect(f).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(f[0].message).toMatch(/not in this task's test files/);
  });

  it('reports failures without file attribution as INFO (red plausible, not proven) instead of blocking', () => {
    const out = ' RUN  v5.0.1 /p\n\n Test Files  1 failed (1)\n      Tests  2 passed | 1 failed (3)\n';
    const gates = [gate({ name: 'test', role: 'test', passed: false, exitCode: 1, output: out })];
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: gates });
    const f = checkTddRed(input, diffWith([{ path: 'test/x.test.ts' }]), parseTestOutput(out));
    expect(f).toEqual([expect.objectContaining({ severity: 'info' })]);
  });
});

describe('parseTddEvidence / checkTddEvidence', () => {
  it('parses the last FULLAUTO_TDD line, tolerating markdown and spacing', async () => {
    const { parseTddEvidence, checkTddEvidence } = await import('../../src/audit/tdd.js');
    expect(parseTddEvidence('FULLAUTO_TDD: red=2 green=0\nlater\n**FULLAUTO_TDD: red = 2 green = 5**\n')).toEqual({ red: 2, green: 5 });
    expect(parseTddEvidence('  `FULLAUTO_TDD: green=3`  ')).toEqual({ red: 0, green: 3 });
    expect(parseTddEvidence('no evidence here')).toBeUndefined();
    expect(parseTddEvidence('')).toBeUndefined();

    const behavior = cls();
    expect(checkTddEvidence(behavior, 'FULLAUTO_WIRING:\n- a -> b\n')).toEqual([expect.objectContaining({ check: 'test-count', severity: 'warn' })]);
    expect(checkTddEvidence(behavior, 'FULLAUTO_TDD: red=1 green=1')).toEqual([]);
    expect(checkTddEvidence(behavior, '')).toEqual([]); // manual audit: nothing to demand
    expect(checkTddEvidence(cls({ noTestReason: 'x' }), 'done')).toEqual([]);
    expect(checkTddEvidence(cls({ testsDelegatedTo: 'T003' }), 'done')).toEqual([]);
    expect(checkTddEvidence(cls({ kind: 'config' }), 'done')).toEqual([]);
    expect(checkTddEvidence(cls({ kind: 'test', tdd: 'red' }), 'FULLAUTO_TDD: red=0 green=0')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(checkTddEvidence(cls({ tdd: 'green', redTaskIds: ['T001'] }), 'FULLAUTO_TDD: red=0 green=0')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(checkTddEvidence(cls({ tdd: 'green', redTaskIds: ['T001'] }), 'FULLAUTO_TDD: red=0 green=4')).toEqual([]);
  });
});

describe('tdd — reviewer countermeasures', () => {
  const green = cls({ kind: 'impl', tdd: 'green', redTaskIds: ['T001'] });

  it('FULLAUTO_TEST_CHANGE only downgrades to WARN when the red file was not weakened; a weakened file stays BLOCK', async () => {
    const repo = makeRepo({ 'src/a.ts': '' });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    const body = "it('x', () => { expect(add(1,1)).toBe(2); });\nit('y', () => { expect(add(2,2)).toBe(4); expect(add(0,0)).toBe(0); });\n";
    repo.write('test/x.test.ts', body);
    repo.write('test/y.test.ts', body);
    repo.write('test/z.test.ts', body);
    const afterRed = await takeSnapshot(repo.dir);
    const record = buildRedTestRecord('T001', await diffSnapshots(before, afterRed, repo.dir), 6, afterRed);

    repo.write('test/x.test.ts', body.replace('toBe(2)', 'toBe(3)')); // corrected expectation, same shape → WARN
    repo.write('test/y.test.ts', "it('x', () => { expect(add(1,1)).toBe(2); });\n"); // dropped a block + 2 assertions → BLOCK
    const afterGreen = await takeSnapshot(repo.dir);
    const diff = await diffSnapshots(afterRed, afterGreen, repo.dir);
    const input = auditInput(repo.dir, afterRed, afterGreen, {
      classification: green,
      redTests: [record],
      subagentStdout: ['FULLAUTO_TEST_CHANGE: test/x.test.ts — expected sum was wrong', 'FULLAUTO_TEST_CHANGE: test/y.test.ts — simplified', 'FULLAUTO_TEST_CHANGE: test/z.test.ts — flaky'].join('\n'),
      gateResults: [gate({ passed: true, output: VITEST_PASS_4 })],
    });
    const findings = await checkTddGreen(input, diff, parseTestOutput(VITEST_PASS_4));
    const byPath = (p: string) => findings.find((f) => f.path === p);
    expect(byPath('test/x.test.ts')).toMatchObject({ severity: 'warn' });
    expect(byPath('test/x.test.ts')?.message).toContain('expected sum was wrong');
    expect(byPath('test/y.test.ts')).toMatchObject({ severity: 'block' });
    expect(byPath('test/y.test.ts')?.message).toMatch(/FULLAUTO_TEST_CHANGE rejected .* weakened the test \(2→1 test blocks, 3→1 assertions\)/);
    expect(findings).toHaveLength(2);

    // dropping a single assertion (blocks unchanged) is also weakening
    repo.write('test/x.test.ts', body);
    repo.write('test/y.test.ts', body);
    repo.write('test/z.test.ts', body.replace("expect(add(0,0)).toBe(0); ", ''));
    const afterZ = await takeSnapshot(repo.dir);
    const z = await checkTddGreen({ ...input, after: afterZ }, await diffSnapshots(afterRed, afterZ, repo.dir), parseTestOutput(VITEST_PASS_4));
    expect(z).toEqual([expect.objectContaining({ severity: 'block', path: 'test/z.test.ts' })]);
    expect(z[0].message).toMatch(/2→2 test blocks, 3→2 assertions/);
  });

  it('more than 2 declared red-file changes in one green task BLOCK regardless of their content', async () => {
    const repo = makeRepo({ 'src/a.ts': '' });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    const files = ['a', 'b', 'c'];
    for (const n of files) repo.write(`test/${n}.test.ts`, `it('${n}', () => { expect(f()).toBe(1); });\n`);
    const afterRed = await takeSnapshot(repo.dir);
    const record = buildRedTestRecord('T001', await diffSnapshots(before, afterRed, repo.dir), 3, afterRed);
    for (const n of files) repo.write(`test/${n}.test.ts`, `it('${n}', () => { expect(f()).toBe(2); });\n`); // neutral edits, all declared
    const afterGreen = await takeSnapshot(repo.dir);
    const diff = await diffSnapshots(afterRed, afterGreen, repo.dir);
    const notices = files.map((n) => `FULLAUTO_TEST_CHANGE: test/${n}.test.ts — fixed expectation`).join('\n');
    const input = auditInput(repo.dir, afterRed, afterGreen, { classification: green, redTests: [record], subagentStdout: notices, gateResults: [gate({ passed: true, output: VITEST_PASS_4 })] });
    const findings = await checkTddGreen(input, diff, parseTestOutput(VITEST_PASS_4));
    expect(findings.map((f) => f.severity)).toEqual(['block', 'block', 'block']);
    expect(findings[0].message).toMatch(/FULLAUTO_TEST_CHANGE abuse: 3 red test files changed in one green task \(limit 2\)/);
    // exactly two neutral, declared changes are still WARN
    repo.write('test/c.test.ts', "it('c', () => { expect(f()).toBe(1); });\n");
    const afterTwo = await takeSnapshot(repo.dir);
    const two = await checkTddGreen({ ...input, after: afterTwo }, await diffSnapshots(afterRed, afterTwo, repo.dir), parseTestOutput(VITEST_PASS_4));
    expect(two.map((f) => f.severity)).toEqual(['warn', 'warn']);
  });

  it('red task: a test file that failed to LOAD (0 tests ran) gets a stub-specific BLOCK, not "came from something else"', () => {
    const out = [' RUN  v5.0.1 /p', '', ' ❯ test/x.test.ts (0 test)', ' ✓ test/y.test.ts (1 test) 3ms', '', ' FAIL  test/x.test.ts [ test/x.test.ts ]', "Error: Failed to resolve import '../src/pricing'", '', ' Test Files  1 failed | 1 passed (2)', '      Tests  1 passed (1)'].join('\n');
    const counts = parseTestOutput(out);
    expect(counts).toMatchObject({ runner: 'vitest', failed: 0, failingFiles: ['test/x.test.ts'] });
    const red = cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'] });
    const input = auditInput('/p', emptySnap(), emptySnap(), { classification: red, gateResults: [gate({ passed: false, output: out })] });
    const f = checkTddRed(input, diffWith([{ path: 'test/x.test.ts' }]), counts);
    expect(f).toEqual([expect.objectContaining({ check: 'tdd-red', severity: 'block', path: 'test/x.test.ts' })]);
    expect(f[0].message).toMatch(/test\/x\.test\.ts failed to load \(0 tests ran\) — add the minimal stub/);
    // the generic message remains for a 0-failure gate whose failing file is someone else's
    const other = checkTddRed(input, diffWith([{ path: 'test/other.test.ts' }]), counts);
    expect(other[0].message).toMatch(/came from something else/);
  });

  it('findTestGate / findE2eGate use inferGateRole (single source of truth) with explicit role winning', () => {
    expect(findTestGate([gate({ name: 'mocha' })])).toBeUndefined(); // `mocha` is `other` for the orchestrator too
    expect(findTestGate([gate({ name: 'mocha', role: 'test' })])?.name).toBe('mocha');
    expect(findTestGate([gate({ name: 'go test' })])?.name).toBe('go test');
    expect(findTestGate([gate({ name: 'jest', role: 'other' })])).toBeUndefined(); // explicit role is never second-guessed
    expect(findTestGate([gate({ name: 'e2e tests' }), gate({ name: 'unit' , role: 'test' })])?.name).toBe('unit');
  });

  it('red task: quarantine is decided from failingFiles membership in OTHER red sets, not from the note text', () => {
    const red = cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'] });
    const otherRed = { taskId: 'T000', files: [{ path: 'test/x.test.ts', hash: 'h', size: 1 }], failing: 1, recordedAt: '' };
    // the only failure is T000's quarantined red file → for THIS task the gate is effectively green → BLOCK "PASSED"
    const quarantined = auditInput('/p', emptySnap(), emptySnap(), { classification: red, redTests: [otherRed], gateResults: [gate({ passed: false, output: VITEST_FAIL_1_OF_4 })] });
    const f = checkTddRed(quarantined, diffWith([{ path: 'test/new.test.ts' }]), parseTestOutput(VITEST_FAIL_1_OF_4));
    expect(f).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(f[0].message).toMatch(/PASSED/);
    // a note claiming quarantine does not override attributable failures in this task's own file
    const noted = auditInput('/p', emptySnap(), emptySnap(), { classification: red, redTests: [], gateResults: [gate({ passed: false, output: VITEST_FAIL_1_OF_4, note: 'quarantined red tests: test/x.test.ts' })] });
    expect(checkTddRed(noted, diffWith([{ path: 'test/x.test.ts' }]), parseTestOutput(VITEST_FAIL_1_OF_4))).toEqual([]);
  });
});
