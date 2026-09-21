import { describe, it, expect } from 'vitest';
import { enforceWiringPromises, passLimit } from '../src/orchestrator.js';
import type { AuditRunResult } from '../src/audit/index.js';
import { makeConfig, makeState, makeTask } from './helpers/fixtures.js';

function audit(newPending: AuditRunResult['newPendingWiring']): AuditRunResult {
  return {
    findings: [{ check: 'orphan-code', severity: 'info', message: 'accepted as orphan-for-now', path: 'src/a.ts' }],
    blocked: false,
    changed: { added: 1, modified: 0, deleted: 0 },
    diff: { files: [], headMoved: false },
    newPendingWiring: newPending,
    resolvedPendingWiring: [],
  };
}

describe('enforceWiringPromises (runtime backstop for `- wired by:`)', () => {
  const state = makeState([
    makeTask('T001', { status: 'done' }),
    makeTask('T002', { status: 'failed' }),
    makeTask('T003', { status: 'pending' }),
  ]);

  it('BLOCKs a promise naming a done / failed / missing task and drops it; keeps one naming an open task', () => {
    const a = audit([
      { artifactPath: 'src/a.ts', createdBy: 'T009', wiredBy: 'T001' },
      { artifactPath: 'src/b.ts', createdBy: 'T009', wiredBy: 'T002' },
      { artifactPath: 'src/c.ts', createdBy: 'T009', wiredBy: 'T404' },
      { artifactPath: 'src/d.ts', createdBy: 'T009', wiredBy: 'T003' },
    ]);
    enforceWiringPromises(a, state);
    expect(a.blocked).toBe(true);
    expect(a.newPendingWiring).toEqual([{ artifactPath: 'src/d.ts', createdBy: 'T009', wiredBy: 'T003' }]);
    const blocks = a.findings.filter((f) => f.check === 'pending-wiring' && f.severity === 'block');
    expect(blocks.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']); // sorted BLOCK first
    expect(blocks[0].message).toContain('T001 already finished (done)');
    expect(blocks[1].message).toContain('T002 already finished (failed)');
    expect(blocks[2].message).toContain('no task T404 exists');
    expect(a.findings[0].severity).toBe('block');
  });

  it('leaves a clean audit alone', () => {
    const a = audit([{ artifactPath: 'src/d.ts', createdBy: 'T009', wiredBy: 'T003' }]);
    enforceWiringPromises(a, state);
    expect(a.blocked).toBe(false);
    expect(a.findings).toHaveLength(1);
    const none = audit([]);
    enforceWiringPromises(none, state);
    expect(none.blocked).toBe(false);
  });
});

describe('passLimit', () => {
  it('is maxPasses plus the passes granted by retry', () => {
    const s = makeState([makeTask('T001')], { config: makeConfig({ maxPasses: 3 }) });
    expect(passLimit(s)).toBe(3);
    s.extraPasses = 2;
    expect(passLimit(s)).toBe(5);
  });
});
