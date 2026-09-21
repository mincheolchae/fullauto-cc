import { describe, it, expect } from 'vitest';
import {
  GATE_SUMMARY_MAX_BYTES,
  GATE_SUMMARY_TAIL_LINES,
  evaluateGates,
  summarizeGateOutput,
} from '../src/runner/gates.js';
import type { GateResult } from '../src/types.js';
import type { RedTestRecord, TaskClassification, TestCounts } from '../src/audit/types.js';

describe('summarizeGateOutput', () => {
  it('returns short output verbatim', () => {
    expect(summarizeGateOutput('boom-output\n')).toEqual({ text: 'boom-output', omitted: 0 });
  });

  it('keeps every verdict / error line plus the tail, with omission markers in between', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) lines.push(`ok ${i} - passes`);
    lines[9] = 'not ok 10 - login rejects bad password';
    lines[40] = "  AssertionError: expected 401 to be 200";
    lines[41] = 'src/x.ts(3,1): error TS2322: nope';
    lines[60] = 'FAIL src/__tests__/x.test.ts';
    const s = summarizeGateOutput(lines.join('\n'));
    const out = s.text.split('\n');
    expect(out[0]).toBe('… (9 lines omitted)');
    expect(out[1]).toBe('not ok 10 - login rejects bad password');
    expect(out).toContain("  AssertionError: expected 401 to be 200");
    expect(out).toContain('src/x.ts(3,1): error TS2322: nope');
    expect(out).toContain('FAIL src/__tests__/x.test.ts');
    // The tail is the last 15 lines, contiguous.
    expect(out.slice(-GATE_SUMMARY_TAIL_LINES)).toEqual(lines.slice(-GATE_SUMMARY_TAIL_LINES));
    expect(s.omitted).toBe(100 - 4 - GATE_SUMMARY_TAIL_LINES);
    expect(out.filter((l) => l.startsWith('… (')).length).toBeGreaterThanOrEqual(3);
  });

  it('stays under the byte cap by dropping the EARLIEST matched lines first, keeping the tail', () => {
    const lines: string[] = [];
    for (let i = 0; i < 2000; i++) lines.push(`not ok ${i} - ${'x'.repeat(40)}`);
    for (let i = 0; i < 15; i++) lines.push(`# summary ${i}`);
    const s = summarizeGateOutput(lines.join('\n'));
    expect(Buffer.byteLength(s.text, 'utf-8')).toBeLessThanOrEqual(GATE_SUMMARY_MAX_BYTES);
    expect(s.text.endsWith('# summary 14')).toBe(true);
    expect(s.text).toContain('not ok 1999 -'); // latest failures survive
    expect(s.text).not.toContain('not ok 0 -'); // earliest dropped
    expect(s.omitted).toBeGreaterThan(1500);
  });

  it('truncates a single enormous line from the front', () => {
    const s = summarizeGateOutput('not ok 1 - ' + 'y'.repeat(20_000));
    expect(Buffer.byteLength(s.text, 'utf-8')).toBeLessThanOrEqual(GATE_SUMMARY_MAX_BYTES + 32);
    expect(s.text.startsWith('… (truncated)')).toBe(true);
    expect(s.text.endsWith('y')).toBe(true);
  });
});

// ---------- partial quarantine ----------

const VITEST_TWO_FILES = `
 ❯ tests/login.test.ts (3 tests | 2 failed) 12ms
 ❯ tests/cart.test.ts (2 tests | 1 failed) 3ms

 Test Files  2 failed (2)
      Tests  3 failed | 2 passed (5)
`;

function parse(output: string): TestCounts {
  const failingFiles = [...output.matchAll(/❯ (\S+) \(/g)].map((m) => m[1]);
  return { runner: 'vitest', passed: 2, failed: 3, skipped: 0, failingFiles };
}

const cls: TaskClassification = {
  kind: 'impl', risk: 'medium', tdd: 'none', redTaskIds: [], greenTaskIds: [], allowsConfigChange: false, allowsTestEdits: false, rationale: [],
};
const gate = (name: string, passed: boolean, output: string): GateResult => ({ name, passed, command: name, exitCode: passed ? 0 : 1, output, durationMs: 1, role: 'test' });
const red = (taskId: string, path: string): RedTestRecord => ({ taskId, files: [{ path, hash: 'h', size: 1 }], failing: 1, recordedAt: 't' });

describe('evaluateGates — partial quarantine', () => {
  it('names the quarantined files of a gate that still really failed', () => {
    const t = gate('test', false, VITEST_TWO_FILES);
    const r = evaluateGates([t], { classification: cls, redTests: [red('T001', 'tests/login.test.ts')], parseTestOutput: parse });
    expect(r.passed).toBe(false);
    expect(r.failedGate).toBe(t);
    expect(r.partialQuarantine).toEqual(['tests/login.test.ts']);
  });

  it('is absent when nothing was quarantined', () => {
    const t = gate('test', false, VITEST_TWO_FILES);
    const r = evaluateGates([t], { classification: cls, redTests: [], parseTestOutput: parse });
    expect(r.partialQuarantine).toBeUndefined();
  });
});
