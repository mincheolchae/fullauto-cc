import { describe, it, expect } from 'vitest';
import { evaluateGates, summarizeGates } from '../src/runner/gates.js';
import { inferGateRole, type GateResult } from '../src/types.js';
import type { RedTestRecord, TaskClassification, TestCounts } from '../src/audit/types.js';

// ---------- fixtures ----------
//
// Realistic runner tails. The parser below is a deliberately small,
// test-local stand-in for src/audit/test-output.ts: evaluateGates receives
// the parser through its context, so this suite stays independent of the
// audit layer's own parsing tests while still exercising real-looking text.

const VITEST_FAIL = `
 ❯ tests/login.test.ts (3 tests | 2 failed) 12ms
   × POST /login returns a token
   × POST /login rejects a bad password
 ✓ tests/pricing.test.ts (4 tests) 5ms

 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 5 passed (7)
   Start at  10:00:00
   Duration  400ms
`;

const VITEST_FAIL_TWO_FILES = `
 ❯ tests/login.test.ts (3 tests | 2 failed) 12ms
 ❯ tests/cart.test.ts (2 tests | 1 failed) 3ms

 Test Files  2 failed (2)
      Tests  3 failed | 2 passed (5)
`;

const VITEST_PASS = `
 ✓ tests/login.test.ts (3 tests) 12ms
 ✓ tests/pricing.test.ts (4 tests) 5ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
`;

const JEST_FAIL = `
FAIL src/__tests__/checkout.test.ts
  ● checkout › charges the card

    expect(received).toBe(expected)

PASS src/__tests__/cart.test.ts

Tests:       1 failed, 6 passed, 7 total
Test Suites: 1 failed, 1 passed, 2 total
`;

const PYTEST_FAIL = `
FAILED tests/test_login.py::test_returns_token - AssertionError
FAILED tests/test_login.py::test_bad_password - NotImplementedError
================== 2 failed, 9 passed, 1 skipped in 0.42s ==================
`;

const UNKNOWN_OUTPUT = `Error: Cannot find module 'vitest'\n    at Module._resolveFilename`;

/** Minimal vitest / jest / pytest summary parser for fixtures above. */
function fixtureParser(output: string): TestCounts {
  const failingFiles: string[] = [];
  let m: RegExpMatchArray | null;
  if ((m = output.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/))) {
    for (const line of output.split('\n')) {
      const f = line.match(/^\s*❯\s+(\S+)\s+\(\d+ tests? \| \d+ failed\)/);
      if (f) failingFiles.push(f[1]);
    }
    return { runner: 'vitest', failed: Number(m[1] ?? 0), passed: Number(m[2]), skipped: 0, failingFiles };
  }
  if ((m = output.match(/Tests:\s+(?:(\d+) failed, )?(\d+) passed/))) {
    for (const line of output.split('\n')) {
      const f = line.match(/^FAIL\s+(\S+)/);
      if (f) failingFiles.push(f[1]);
    }
    return { runner: 'jest', failed: Number(m[1] ?? 0), passed: Number(m[2]), skipped: 0, failingFiles };
  }
  if ((m = output.match(/=+ (?:(\d+) failed, )?(\d+) passed(?:, (\d+) skipped)? in/))) {
    for (const line of output.split('\n')) {
      const f = line.match(/^FAILED\s+([^:\s]+)::/);
      if (f && !failingFiles.includes(f[1])) failingFiles.push(f[1]);
    }
    return { runner: 'pytest', failed: Number(m[1] ?? 0), passed: Number(m[2]), skipped: Number(m[3] ?? 0), failingFiles };
  }
  return { runner: 'unknown', passed: 0, failed: 0, skipped: 0, failingFiles: [] };
}

function gate(name: string, passed: boolean, output = '', extra: Partial<GateResult> = {}): GateResult {
  return {
    name,
    passed,
    command: `npm run ${name}`,
    exitCode: passed ? 0 : 1,
    output,
    durationMs: 10,
    role: inferGateRole({ name }),
    ...extra,
  };
}

function cls(over: Partial<TaskClassification> = {}): TaskClassification {
  return {
    kind: 'impl',
    risk: 'medium',
    tdd: 'none',
    redTaskIds: [],
    greenTaskIds: [],
    allowsConfigChange: false,
    allowsTestEdits: false,
    rationale: [],
    ...over,
  };
}

function red(taskId: string, ...paths: string[]): RedTestRecord {
  return {
    taskId,
    files: paths.map((p) => ({ path: p, hash: 'abc', size: 1 })),
    failing: paths.length,
    recordedAt: new Date().toISOString(),
  };
}

const ctx = (over: { classification?: TaskClassification; redTests?: RedTestRecord[] } = {}) => ({
  classification: over.classification ?? cls(),
  redTests: over.redTests ?? [],
  parseTestOutput: fixtureParser,
});

// ---------- tests ----------

describe('inferGateRole', () => {
  it('prefers an explicit role, otherwise guesses from the name', () => {
    expect(inferGateRole({ name: 'anything', role: 'e2e' })).toBe('e2e');
    expect(inferGateRole({ name: 'typecheck' })).toBe('typecheck');
    expect(inferGateRole({ name: 'test' })).toBe('test');
    expect(inferGateRole({ name: 'unit-tests' })).toBe('test');
    expect(inferGateRole({ name: 'playwright-tests' })).toBe('e2e');
    expect(inferGateRole({ name: 'eslint' })).toBe('lint');
    expect(inferGateRole({ name: 'build' })).toBe('build');
    expect(inferGateRole({ name: 'convex-codegen' })).toBe('other');
    expect(inferGateRole({ name: 'health' })).toBe('other');
  });
});

describe('evaluateGates — plain tasks', () => {
  it('all gates passed → passed, with parsed counts from the test gate', () => {
    const r = evaluateGates([gate('typecheck', true), gate('test', true, VITEST_PASS)], ctx());
    expect(r.passed).toBe(true);
    expect(r.failedGate).toBeUndefined();
    expect(r.testCounts).toMatchObject({ runner: 'vitest', passed: 7, failed: 0 });
  });

  it('a failed non-test gate is a real failure regardless of red sets', () => {
    const tc = gate('typecheck', false, 'src/x.ts(3,1): error TS2322');
    const r = evaluateGates([tc, gate('test', true, VITEST_PASS)], ctx({ redTests: [red('T001', 'tests/login.test.ts')] }));
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(tc);
  });

  it('failed test gate with no red sets → real failure', () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([t], ctx());
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(t);
    expect(t.note).toBeUndefined();
  });

  it('quarantines a vitest failure confined to a red set and annotates the gate', () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([gate('typecheck', true), t], ctx({ redTests: [red('T001', 'tests/login.test.ts')] }));
    expect(r.passed).toBe(true);
    expect(r.quarantineNote).toContain('tests/login.test.ts');
    expect(t.note).toBe('quarantined red tests: tests/login.test.ts');
    expect(t.passed).toBe(false); // raw verdict is preserved
    expect(summarizeGates([t])).toContain('~ test');
  });

  it('does NOT quarantine when any failing file is outside the red sets', () => {
    const t = gate('test', false, VITEST_FAIL_TWO_FILES);
    const r = evaluateGates([t], ctx({ redTests: [red('T001', 'tests/login.test.ts')] }));
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(t);
    expect(t.note).toBeUndefined();
  });

  it('quarantines jest and pytest failures using their file syntax', () => {
    const j = gate('test', false, JEST_FAIL);
    expect(evaluateGates([j], ctx({ redTests: [red('T009', 'src/__tests__/checkout.test.ts')] })).passed).toBe(true);
    const p = gate('pytest', false, PYTEST_FAIL);
    const r = evaluateGates([p], ctx({ redTests: [red('T002', 'tests/test_login.py')] }));
    expect(r.passed).toBe(true);
    expect(r.testCounts).toMatchObject({ runner: 'pytest', failed: 2, passed: 9, skipped: 1 });
  });

  it('tolerates path prefix differences (monorepo / absolute) with a `/` boundary', () => {
    const t = gate('test', false, VITEST_FAIL);
    // red set recorded repo-relative from a package sub-dir
    expect(evaluateGates([t], ctx({ redTests: [red('T001', 'packages/api/tests/login.test.ts')] })).passed).toBe(true);
    // but a mere suffix without a boundary is not a match
    const t2 = gate('test', false, VITEST_FAIL);
    expect(evaluateGates([t2], ctx({ redTests: [red('T001', 'xlogin.test.ts')] })).passed).toBe(false);
  });

  it('unattributable failures (unknown runner) are never excused', () => {
    const t = gate('test', false, UNKNOWN_OUTPUT);
    const r = evaluateGates([t], ctx({ redTests: [red('T001', 'tests/login.test.ts')] }));
    expect(r.passed).toBe(false);
    expect(r.testCounts).toBeUndefined();
  });

  it('a skipped test gate contributes nothing', () => {
    const t = gate('test', true, '[skipped: skipIf check exited 0]', { skipped: true });
    const r = evaluateGates([t], ctx({ classification: cls({ tdd: 'red' }) }));
    expect(r.passed).toBe(true);
    expect(r.testCounts).toBeUndefined();
    expect(r.redTestGateFailed).toBeUndefined();
  });

  it('stops at the first real failure and still reports quarantine notes gathered so far', () => {
    const t = gate('test', false, VITEST_FAIL);
    const e2e = gate('e2e', false, 'Error: page crashed');
    const r = evaluateGates([t, e2e], ctx({ redTests: [red('T001', 'tests/login.test.ts')] }));
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(e2e);
    expect(r.quarantineNote).toContain('tests/login.test.ts');
  });
});

describe('evaluateGates — TDD red task', () => {
  it('a failing test gate is the success path, annotated as expected failure', () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([gate('typecheck', true), t], ctx({ classification: cls({ kind: 'test', tdd: 'red' }) }));
    expect(r.passed).toBe(true);
    expect(r.redTestGateFailed).toBe(true);
    expect(t.note).toMatch(/^expected failure \(TDD red\): tests\/login\.test\.ts/);
  });

  it('a passing test gate flags redTestGateFailed=false (tests exercise nothing)', () => {
    const r = evaluateGates([gate('test', true, VITEST_PASS)], ctx({ classification: cls({ kind: 'test', tdd: 'red' }) }));
    expect(r.passed).toBe(true);
    expect(r.redTestGateFailed).toBe(false);
  });

  it('failures that all belong to OTHER red sets do not count as this task going red', () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([t], ctx({
      classification: cls({ kind: 'test', tdd: 'red' }),
      redTests: [red('T000', 'tests/login.test.ts')],
    }));
    expect(r.passed).toBe(true);
    expect(r.redTestGateFailed).toBe(false);
    expect(t.note).toContain('quarantined');
  });

  it('other gates must still pass for a red task', () => {
    const lint = gate('lint', false, 'x.ts: unused var');
    const r = evaluateGates([lint, gate('test', false, VITEST_FAIL)], ctx({ classification: cls({ kind: 'test', tdd: 'red' }) }));
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(lint);
  });

  it('an unattributable failure on a red task still counts as the expected red', () => {
    const t = gate('test', false, 'some runner nobody parses: 1 error');
    const r = evaluateGates([t], ctx({ classification: cls({ kind: 'test', tdd: 'red' }) }));
    expect(r.passed).toBe(true);
    expect(r.redTestGateFailed).toBe(true);
    expect(t.note).toContain('unattributed');
  });
});

describe('evaluateGates — TDD green task', () => {
  it("its OWN red set is not quarantined — those tests must pass now", () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([t], ctx({
      classification: cls({ tdd: 'green', redTaskIds: ['T001'] }),
      redTests: [red('T001', 'tests/login.test.ts')],
    }));
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(t);
  });

  it("OTHER tasks' red sets are still quarantined for a green task", () => {
    const t = gate('test', false, VITEST_FAIL);
    const r = evaluateGates([t], ctx({
      classification: cls({ tdd: 'green', redTaskIds: ['T005'] }),
      redTests: [red('T001', 'tests/login.test.ts'), red('T005', 'tests/cart.test.ts')],
    }));
    expect(r.passed).toBe(true);
    expect(t.note).toContain('tests/login.test.ts');
  });
});
