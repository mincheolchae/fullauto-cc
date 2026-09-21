import { describe, expect, it } from 'vitest';
import { checkVerifyEvidence, hasVerifyLoopResult, parseVerifyLoopResult } from '../../src/audit/verify-evidence.js';
import { cls } from './_helpers.js';

const withDepth = (verifyDepth: 'gates' | 'light' | 'full' | undefined, subagentStdout: string) => ({ verifyDepth, subagentStdout, classification: cls() });

describe('parseVerifyLoopResult', () => {
  it('parses the LAST result line, tolerating markdown, spacing and missing fields', () => {
    expect(parseVerifyLoopResult('VERIFY_LOOP_RESULT: depth=light cycles=1 block=0 warn=2\nlater\n**VERIFY_LOOP_RESULT: depth=full cycles=2 block=1 warn=0**\n')).toEqual({
      depth: 'full',
      cycles: 2,
      block: 1,
      warn: 0,
    });
    expect(parseVerifyLoopResult('  `VERIFY_LOOP_RESULT: depth=gates`  ')).toEqual({ depth: 'gates', cycles: undefined, block: undefined, warn: undefined });
    expect(parseVerifyLoopResult('VERIFY_LOOP_RESULT: depth=deep cycles=1')).toBeUndefined(); // not a known depth
    expect(parseVerifyLoopResult('VERIFY_LOOP_RESULT: cycles=1 block=0')).toBeUndefined(); // depth is mandatory
    expect(parseVerifyLoopResult('the skill ends with VERIFY_LOOP_RESULT: depth=... (see docs)')).toBeUndefined(); // prose, not a line
    expect(parseVerifyLoopResult('')).toBeUndefined();
    expect(hasVerifyLoopResult('done\nVERIFY_LOOP_RESULT: depth=light cycles=1 block=0 warn=0\n')).toBe(true);
    expect(hasVerifyLoopResult('done')).toBe(false);
  });
});

describe('checkVerifyEvidence', () => {
  const ok = 'Implemented.\nVERIFY_LOOP_RESULT: depth=light cycles=1 block=0 warn=1\nFULLAUTO_WIRING:\n- a -> b\n';

  it('is silent when the depth is unknown, gates, or there is no transcript', () => {
    expect(checkVerifyEvidence(withDepth(undefined, 'no line here'))).toEqual([]);
    expect(checkVerifyEvidence(withDepth('gates', 'no line here'))).toEqual([]);
    expect(checkVerifyEvidence(withDepth('full', ''))).toEqual([]);
    expect(checkVerifyEvidence(withDepth('full', '   \n'))).toEqual([]);
  });

  it('BLOCKs a light/full task whose transcript has no VERIFY_LOOP_RESULT line', () => {
    const f = checkVerifyEvidence(withDepth('light', 'Implemented everything, ran the review loop, all good.\nFULLAUTO_TDD: red=1 green=2\n'));
    expect(f).toEqual([expect.objectContaining({ check: 'verify-evidence', severity: 'block' })]);
    expect(f[0].message).toContain('verify-loop was required (depth=light) but no VERIFY_LOOP_RESULT line was emitted');
    expect(f[0].message).toContain('run /verify-loop depth=light');
    expect(checkVerifyEvidence(withDepth('full', 'done'))[0].message).toContain('depth=full');
  });

  it('accepts a line at the required depth or deeper', () => {
    expect(checkVerifyEvidence(withDepth('light', ok))).toEqual([]);
    expect(checkVerifyEvidence(withDepth('light', ok.replace('depth=light', 'depth=full')))).toEqual([]);
    expect(checkVerifyEvidence(withDepth('full', ok.replace('depth=light', 'depth=full')))).toEqual([]);
  });

  it('BLOCKs when the loop ran at a lower depth than required (gates < light < full)', () => {
    const f = checkVerifyEvidence(withDepth('full', ok));
    expect(f).toEqual([expect.objectContaining({ check: 'verify-evidence', severity: 'block' })]);
    expect(f[0].message).toContain('verify-loop ran at depth=light but depth=full was required');
    const g = checkVerifyEvidence(withDepth('light', ok.replace('depth=light', 'depth=gates')));
    expect(g[0].message).toContain('ran at depth=gates but depth=light was required');
  });

  it('WARNs when the loop ended with unresolved BLOCKs (block>0), on top of any depth BLOCK', () => {
    const f = checkVerifyEvidence(withDepth('light', ok.replace('block=0', 'block=2')));
    expect(f).toEqual([expect.objectContaining({ check: 'verify-evidence', severity: 'warn' })]);
    expect(f[0].message).toMatch(/2 unresolved BLOCK\(s\).*DEFER/);
    const both = checkVerifyEvidence(withDepth('full', ok.replace('block=0', 'block=1')));
    expect(both.map((x) => x.severity)).toEqual(['block', 'warn']);
    expect(checkVerifyEvidence(withDepth('light', ok.replace(' block=0', '')))).toEqual([]); // missing block= is not >0
  });
});
