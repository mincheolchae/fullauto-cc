import { describe, it, expect } from 'vitest';
import { RunConfig, RunState, Gate, GateResult, TaskAttempt, VERIFY_MODES } from '../src/types.js';
import { PRESETS } from '../src/init/presets.js';
import { DEFAULT_AUDIT_OPTIONS } from '../src/audit/types.js';

describe('RunConfig — new fields and defaults', () => {
  it('defaults verifyMode=adaptive, verifyMaxCycles=2, audit all-on', () => {
    const c = RunConfig.parse({});
    expect(c.verifyMode).toBe('adaptive');
    expect(c.verifyMaxCycles).toBe(2);
    expect(c.useVerifyLoop).toBe(true);
    expect(c.audit).toEqual(DEFAULT_AUDIT_OPTIONS);
  });

  it('accepts every verify mode and rejects unknown ones', () => {
    for (const m of VERIFY_MODES) expect(RunConfig.parse({ verifyMode: m }).verifyMode).toBe(m);
    expect(() => RunConfig.parse({ verifyMode: 'yolo' })).toThrow();
    expect(() => RunConfig.parse({ verifyMaxCycles: 0 })).toThrow();
  });

  it('audit toggles can be partially specified', () => {
    const c = RunConfig.parse({ audit: { orphanCheck: false } });
    expect(c.audit.orphanCheck).toBe(false);
    expect(c.audit.testIntegrity).toBe(true);
  });

  it('evolveStageTimeoutSec is unset by default (derived at call time, see run-flow.ts) and accepts an explicit override', () => {
    expect(RunConfig.parse({}).evolveStageTimeoutSec).toBeUndefined();
    expect(RunConfig.parse({ evolveStageTimeoutSec: 2400 }).evolveStageTimeoutSec).toBe(2400);
    expect(() => RunConfig.parse({ evolveStageTimeoutSec: 0 })).toThrow();
    expect(() => RunConfig.parse({ evolveStageTimeoutSec: -1 })).toThrow();
  });

  it('an old config.json (no new keys, legacy gates without type/role) still parses', () => {
    const legacy = {
      maxPasses: 3,
      useVerifyLoop: false,
      gates: [{ name: 'test', command: 'npm test' }],
    };
    const c = RunConfig.parse(legacy);
    expect(c.useVerifyLoop).toBe(false);
    expect(c.verifyMode).toBe('adaptive');
    expect(c.gates[0]).toMatchObject({ type: 'shell', name: 'test' });
    expect((c.gates[0] as { role?: string }).role).toBeUndefined();
  });

  it('ShellGate accepts role and rejects unknown roles', () => {
    expect(Gate.parse({ type: 'shell', name: 'x', command: 'y', role: 'e2e' })).toMatchObject({ role: 'e2e' });
    expect(() => Gate.parse({ type: 'shell', name: 'x', command: 'y', role: 'smoke' })).toThrow();
  });
});

describe('GateResult / TaskAttempt — optional additions', () => {
  it('GateResult accepts role/skipped/note and tolerates their absence', () => {
    const base = { name: 'test', passed: false, command: 'npm test', exitCode: 1, output: '', durationMs: 1 };
    expect(GateResult.parse(base)).toEqual(base);
    expect(GateResult.parse({ ...base, role: 'test', skipped: false, note: 'quarantined' })).toMatchObject({
      note: 'quarantined',
    });
  });

  it('TaskAttempt round-trips classification/verifyDepth/audit/tdd and accepts new defer reasons', () => {
    const attempt = {
      passNumber: 1,
      startedAt: 'now',
      finishedAt: 'now',
      gateResults: [],
      deferReason: 'audit_failed',
      deferDetail: 'x',
      classification: {
        kind: 'impl',
        risk: 'high',
        tdd: 'green',
        redTaskIds: ['T001'],
        greenTaskIds: [],
        allowsConfigChange: false,
        allowsTestEdits: false,
        testsDelegatedTo: 'T001',
        rationale: ['kind=impl (default)'],
      },
      verifyDepth: 'full',
      audit: {
        findings: [{ check: 'orphan-code', severity: 'block', message: 'nothing imports it', path: 'src/x.ts' }],
        blocked: true,
        testCounts: { runner: 'vitest', passed: 3, failed: 1, skipped: 0, failingFiles: ['tests/a.test.ts'] },
        changed: { added: 1, modified: 0, deleted: 0 },
      },
      tdd: { phase: 'green', failing: 1, passed: 3 },
    };
    const parsed = TaskAttempt.parse(attempt);
    expect(parsed).toEqual(attempt);
    expect(TaskAttempt.parse({ ...attempt, deferReason: 'tdd_red_expected' }).deferReason).toBe('tdd_red_expected');
  });

  it('tolerates audit check names / runners this version does not know (forward-compat)', () => {
    const parsed = TaskAttempt.parse({
      passNumber: 1,
      startedAt: 'now',
      audit: {
        findings: [{ check: 'some-future-check', severity: 'warn', message: 'm' }],
        blocked: false,
        testCounts: { runner: 'bun', passed: 1, failed: 0, skipped: 0, failingFiles: [] },
        changed: { added: 0, modified: 0, deleted: 0 },
      },
    });
    expect(parsed.audit?.findings[0].check).toBe('some-future-check');
  });
});

describe('RunState — back-compat and new collections', () => {
  const oldState = {
    startedAt: '2025-01-01T00:00:00.000Z',
    currentPass: 2,
    tasks: [
      {
        id: 'T001',
        title: 'x',
        body: 'x',
        dependencies: [],
        status: 'done',
        attempts: [
          {
            passNumber: 1,
            startedAt: 'a',
            finishedAt: 'b',
            gateResults: [{ name: 'test', passed: true, command: 'npm test', exitCode: 0, output: '', durationMs: 5 }],
          },
        ],
      },
    ],
    config: { gates: [{ name: 'test', command: 'npm test' }] },
    passSnapshots: [],
  };

  it('parses a pre-audit state.json with defaults for redTests/pendingWiring/testBaseline', () => {
    const s = RunState.parse(oldState);
    expect(s.redTests).toEqual([]);
    expect(s.pendingWiring).toEqual([]);
    expect(s.testBaseline).toBeUndefined();
    expect(s.tasks[0].kind).toBe('user');
    expect(s.config.verifyMode).toBe('adaptive');
  });

  it('round-trips redTests / pendingWiring / testBaseline', () => {
    const s = RunState.parse({
      ...oldState,
      testBaseline: { runner: 'vitest', passed: 7, failed: 0, skipped: 0, failingFiles: [] },
      redTests: [{ taskId: 'T002', files: [{ path: 'tests/a.test.ts', hash: 'h', size: 3 }], failing: 2, recordedAt: 'r' }],
      pendingWiring: [{ artifactPath: 'src/c.tsx', createdBy: 'T003', wiredBy: 'T004' }],
    });
    expect(s.redTests[0].files[0].path).toBe('tests/a.test.ts');
    expect(s.pendingWiring[0].wiredBy).toBe('T004');
    expect(s.testBaseline?.passed).toBe(7);
    // JSON round trip (what saveState/loadState do)
    expect(RunState.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('accepts the synthetic `verify` task kind', () => {
    const s = RunState.parse({
      ...oldState,
      tasks: [...oldState.tasks, { id: 'VERIFY-all', title: 'v', body: '', dependencies: ['T001'], kind: 'verify' }],
    });
    expect(s.tasks[1].kind).toBe('verify');
  });
});

describe('presets — gate roles', () => {
  it('every preset ships typecheck/test/lint with roles plus an e2e gate, and parses as RunConfig', () => {
    for (const preset of Object.values(PRESETS)) {
      const cfg = RunConfig.parse(preset.buildConfig());
      const byName = new Map(cfg.gates.map((g) => [g.name, g]));
      expect(byName.get('typecheck'), preset.id).toMatchObject({ role: 'typecheck' });
      expect(byName.get('test'), preset.id).toMatchObject({ role: 'test', command: 'npm test --if-present' });
      expect(byName.get('lint'), preset.id).toMatchObject({ role: 'lint' });
      expect(byName.get('e2e'), preset.id).toMatchObject({
        type: 'shell',
        role: 'e2e',
        command: 'npm run test:e2e --if-present',
        skipIf: 'test ! -f package.json',
      });
      // Presets stay lean: verify/audit knobs come from schema defaults.
      expect(preset.buildConfig()).not.toHaveProperty('verifyMode');
      expect(preset.buildConfig()).not.toHaveProperty('audit');
    }
  });
});
