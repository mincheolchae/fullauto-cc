import { describe, expect, it } from 'vitest';
import { checkTestCount } from '../../src/audit/test-count.js';
import type { TestCounts } from '../../src/audit/types.js';
import { cls } from './_helpers.js';

const counts = (over: Partial<TestCounts> = {}): TestCounts => ({ runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [], ...over });

describe('checkTestCount', () => {
  it('INFO when counts are missing or the runner is unknown', () => {
    expect(checkTestCount(undefined, counts(), cls())).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(checkTestCount(counts({ runner: 'unknown' }), counts(), cls())).toEqual([expect.objectContaining({ severity: 'info' })]);
  });

  it('INFO (plus a WARN for zero tests on a behavior task) without a baseline', () => {
    expect(checkTestCount(counts({ passed: 5 }), undefined, cls())).toEqual([expect.objectContaining({ severity: 'info' })]);
    const zero = checkTestCount(counts({ passed: 0 }), undefined, cls());
    expect(zero.map((f) => f.severity)).toEqual(['info', 'warn']);
    expect(checkTestCount(counts({ passed: 0 }), undefined, cls({ kind: 'config' }))).toHaveLength(1);
  });

  it('BLOCKs a decreased pass count unless modifies-tests', () => {
    const f = checkTestCount(counts({ passed: 3 }), counts({ passed: 4 }), cls({ kind: 'test' }));
    expect(f).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(f[0].message).toContain('4 → 3');
    expect(checkTestCount(counts({ passed: 3 }), counts({ passed: 4 }), cls({ kind: 'test', allowsTestEdits: true }))).toEqual([expect.objectContaining({ severity: 'info' })]);
  });

  it('BLOCKs a behavior task that added no passing tests; exempts delegated / no-test / tdd tasks', () => {
    const same = counts({ passed: 4 });
    const block = checkTestCount(same, same, cls());
    expect(block).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(block[0].message).toContain('no new tests for behavior task');
    expect(checkTestCount(counts({ passed: 5 }), same, cls())).toEqual([]);
    expect(checkTestCount(same, same, cls({ testsDelegatedTo: 'T002' }))).toEqual([]);
    expect(checkTestCount(same, same, cls({ noTestReason: 'pure refactor' }))).toEqual([]);
    expect(checkTestCount(same, same, cls({ tdd: 'green', redTaskIds: ['T001'] }))).toEqual([]);
    expect(checkTestCount(same, same, cls({ kind: 'config' }))).toEqual([]);
    expect(checkTestCount(same, same, cls({ kind: 'docs' }))).toEqual([]);
  });

  it('WARNs when skipped increased', () => {
    const f = checkTestCount(counts({ passed: 5, skipped: 2 }), counts({ passed: 4, skipped: 0 }), cls());
    expect(f).toEqual([expect.objectContaining({ severity: 'warn' })]);
  });
});

describe('checkTestCount with the task diff', () => {
  const same = counts({ passed: 4 });
  const codeDiff = { headMoved: false, files: [{ path: 'src/a.ts', kind: 'modified' as const, isTest: false, isCode: true, isGateConfig: false }] };
  const docsDiff = { headMoved: false, files: [{ path: 'README.md', kind: 'modified' as const, isTest: false, isCode: false, isGateConfig: false }, { path: 'test/a.test.ts', kind: 'modified' as const, isTest: true, isCode: true, isGateConfig: false }] };
  it('BLOCKs only when the behavior task changed production code; WARNs otherwise; legacy callers without a diff keep the BLOCK', () => {
    expect(checkTestCount(same, same, cls(), codeDiff)).toEqual([expect.objectContaining({ severity: 'block' })]);
    const warn = checkTestCount(same, same, cls(), docsDiff);
    expect(warn).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(warn[0].message).toMatch(/changed no production code/);
    expect(checkTestCount(same, same, cls())).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(checkTestCount(same, same, cls({ noTestReason: 'refactor' }), codeDiff)).toEqual([]);
  });
});

describe('checkTestCount — existence-only blocks do not count as new tests', () => {
  const base = counts({ passed: 4 });
  const codeDiff = { headMoved: false, files: [{ path: 'src/a.ts', kind: 'modified' as const, isTest: false, isCode: true, isGateConfig: false }] };
  it('BLOCKs when the only new passing tests are trivial blocks; passes once a real test is added on top', () => {
    const f = checkTestCount(counts({ passed: 6 }), base, cls(), codeDiff, 2);
    expect(f).toEqual([expect.objectContaining({ check: 'test-count', severity: 'block' })]);
    expect(f[0].message).toMatch(/2 new passing test\(s\).*2 added block\(s\) are existence-only/);
    expect(checkTestCount(counts({ passed: 7 }), base, cls(), codeDiff, 2)).toEqual([]);
    expect(checkTestCount(counts({ passed: 6 }), base, cls(), codeDiff, 0)).toEqual([]);
    expect(checkTestCount(counts({ passed: 6 }), base, cls(), codeDiff)).toEqual([]); // default 0
    // exemptions still apply
    expect(checkTestCount(counts({ passed: 6 }), base, cls({ noTestReason: 'x' }), codeDiff, 2)).toEqual([]);
  });
});
