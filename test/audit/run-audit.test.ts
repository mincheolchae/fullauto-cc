import { afterEach, describe, expect, it } from 'vitest';
import { renderFindings, runAudit, sortFindings, takeSnapshot } from '../../src/audit/index.js';
import type { AuditFinding } from '../../src/audit/types.js';
import { auditInput, cls, gate, makeRepo, VITEST_PASS_4, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const BASELINE = {
  'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } }, null, 2) + '\n',
  'src/index.ts': "import { App } from './app';\nexport { App };\n",
  'src/app.tsx': 'export const App = () => null;\n',
  'test/app.test.ts': "import { App } from '../src/app';\nit('renders', () => { expect(App()).toBeNull(); });\n",
};

describe('runAudit (integration)', () => {
  it('BLOCKs an unwired component, a new .skip test and an edited package.json test script', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);

    // --- simulated task ---
    repo.write('src/components/Foo.tsx', "export function Foo() {\n  return <div>foo</div>;\n}\n");
    repo.write('test/foo.test.ts', "import { Foo } from '../src/components/Foo';\nit.skip('renders foo', () => { expect(Foo()).toBeTruthy(); });\n");
    repo.write('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run --passWithNoTests', typecheck: 'tsc --noEmit' } }, null, 2) + '\n');

    const after = await takeSnapshot(repo.dir);
    const input = auditInput(repo.dir, before, after, {
      classification: cls({ kind: 'impl' }),
      gateResults: [gate({ name: 'typecheck', passed: true }), gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
      testBaseline: { runner: 'vitest', passed: 1, failed: 0, skipped: 0, failingFiles: [] },
      subagentStdout: 'Implemented Foo.\nFULLAUTO_WIRING:\n- src/components/Foo.tsx -> src/app.tsx\n',
    });
    const result = await runAudit(input);

    expect(result.blocked).toBe(true);
    expect(result.changed).toEqual({ added: 2, modified: 1, deleted: 0 });
    expect(result.testCounts).toMatchObject({ runner: 'vitest', passed: 4 });

    const blocks = result.findings.filter((f) => f.severity === 'block');
    const byCheck = (check: string) => blocks.filter((f) => f.check === check);
    expect(byCheck('orphan-code').map((f) => f.path)).toEqual(['src/components/Foo.tsx']);
    expect(byCheck('orphan-code')[0].message).toMatch(/only referenced from tests/);
    expect(byCheck('test-integrity').map((f) => f.path).sort()).toEqual(['package.json', 'test/foo.test.ts']);
    expect(byCheck('test-integrity').find((f) => f.path === 'test/foo.test.ts')?.message).toMatch(/skip\/only\/todo/);
    expect(byCheck('gate-integrity')).toEqual([expect.objectContaining({ path: 'package.json' })]);
    expect(byCheck('gate-integrity')[0].message).toContain('scripts.test');
    // the wiring claim named a consumer that does not reference Foo
    expect(byCheck('wiring-manifest')).toEqual([expect.objectContaining({ path: 'src/app.tsx' })]);
    // no duplicate orphan-code for Foo from the unused-export check
    expect(result.findings.filter((f) => f.check === 'orphan-code' && f.path === 'src/components/Foo.tsx')).toHaveLength(1);

    // sorted block → warn → info
    const order = result.findings.map((f) => f.severity);
    const firstWarn = order.indexOf('warn');
    const firstInfo = order.indexOf('info');
    expect(order.lastIndexOf('block')).toBeLessThan(firstWarn === -1 ? Infinity : firstWarn);
    if (firstWarn >= 0 && firstInfo >= 0) expect(order.lastIndexOf('warn')).toBeLessThan(firstInfo);

    const rendered = renderFindings(result.findings);
    expect(rendered.split('\n')[0]).toMatch(/^- \[BLOCK\] /);
    expect(rendered).toContain('[BLOCK] orphan-code src/components/Foo.tsx');
    expect(rendered).toContain('[BLOCK] gate-integrity package.json');
    expect(rendered).toMatch(/\[BLOCK\] test-integrity test\/foo\.test\.ts:2 —/);
  });

  it('passes a well-wired task with a new test and correct manifest', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/components/Foo.tsx', 'export function Foo() {\n  return <div>foo</div>;\n}\n');
    repo.write('src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => <Foo />;\n");
    repo.write('test/foo.test.ts', "import { Foo } from '../src/components/Foo';\nit('renders foo', () => { expect(Foo()).toBeTruthy(); });\n");
    const after = await takeSnapshot(repo.dir);
    const result = await runAudit(
      auditInput(repo.dir, before, after, {
        gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4.replace('4 passed (4)', '2 passed (2)') })],
        testBaseline: { runner: 'vitest', passed: 1, failed: 0, skipped: 0, failingFiles: [] },
        subagentStdout: 'FULLAUTO_TDD: red=1 green=2\nFULLAUTO_WIRING:\n- src/components/Foo.tsx#Foo -> src/app.tsx:1\n',
      })
    );
    expect(result.findings.filter((f) => f.severity !== 'info')).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(result.changed).toEqual({ added: 2, modified: 1, deleted: 0 });
  });

  it('records and resolves pending wiring across two tasks', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const b1 = await takeSnapshot(repo.dir);
    repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
    repo.write('test/pricing.test.ts', "import { quote } from '../src/lib/pricing';\nit('q', () => { expect(quote()).toBe(1); });\n");
    const a1 = await takeSnapshot(repo.dir);
    const r1 = await runAudit(
      auditInput(repo.dir, b1, a1, {
        classification: cls({ wiredBy: 'T002' }),
        gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
        testBaseline: { runner: 'vitest', passed: 1, failed: 0, skipped: 0, failingFiles: [] },
      })
    );
    expect(r1.blocked).toBe(false);
    expect(r1.newPendingWiring).toEqual([{ artifactPath: 'src/lib/pricing.ts', createdBy: 'T001', wiredBy: 'T002' }]);

    // T002 forgets to wire → BLOCK pending-wiring
    const b2 = a1;
    repo.write('src/other.ts', 'export const other = 1;\n');
    repo.write('src/index.ts', "import { App } from './app';\nimport { other } from './other';\nexport { App, other };\n");
    const a2 = await takeSnapshot(repo.dir);
    const t2 = { ...auditInput(repo.dir, b2, a2, { pendingWiring: r1.newPendingWiring, classification: cls({ noTestReason: 'wiring only' }) }), task: { ...auditInput(repo.dir, b2, a2).task, id: 'T002' } };
    const r2 = await runAudit(t2);
    expect(r2.findings.filter((f) => f.severity === 'block')).toEqual([expect.objectContaining({ check: 'pending-wiring', path: 'src/lib/pricing.ts' })]);

    // T002 retry wires it → resolved
    repo.write('src/index.ts', "import { App } from './app';\nimport { other } from './other';\nimport { quote } from './lib/pricing';\nexport { App, other, quote };\n");
    const a3 = await takeSnapshot(repo.dir);
    const r3 = await runAudit({ ...t2, after: a3 });
    expect(r3.blocked).toBe(false);
    expect(r3.resolvedPendingWiring).toEqual(r1.newPendingWiring);
  });

  it('no-ops with one INFO outside a git repository, and when disabled', async () => {
    const dir = makeRepo({ 'src/a.ts': '' }, { git: false });
    repos.push(dir);
    const before = await takeSnapshot(dir.dir);
    dir.write('src/components/Foo.tsx', 'export const Foo = () => null;\n');
    const after = await takeSnapshot(dir.dir);
    const result = await runAudit(auditInput(dir.dir, before, after));
    expect(result.findings).toEqual([{ check: 'audit', severity: 'info', message: 'audit skipped: not a git repository' }]);
    expect(result.blocked).toBe(false);
    expect(result.changed).toEqual({ added: 0, modified: 0, deleted: 0 });

    const disabled = await runAudit(auditInput(dir.dir, before, after, {}, { enabled: false }));
    expect(disabled.findings).toEqual([]);
  });

  it('respects per-check toggles', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/components/Foo.tsx', 'export const Foo = () => null;\n');
    repo.write('test/app.test.ts', "it.skip('renders', () => {});\n");
    const after = await takeSnapshot(repo.dir);
    const result = await runAudit(
      auditInput(repo.dir, before, after, { classification: cls({ noTestReason: 'n/a' }) }, { orphanCheck: false, unusedExportCheck: false, testIntegrity: false, wiringManifest: false })
    );
    expect(result.findings.filter((f) => f.severity === 'block')).toEqual([]);
  });
});

describe('runAudit — reviewer countermeasures', () => {
  it('a synthetic enhance / verify pass with an EMPTY diff yields no findings at all', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    const after = await takeSnapshot(repo.dir);
    for (const stdout of ['', 'Reviewed the feature; nothing to change.\n']) {
      const result = await runAudit(
        auditInput(repo.dir, before, after, {
          classification: cls({ kind: 'enhance', tdd: 'none' }),
          verifyDepth: 'light',
          subagentStdout: stdout,
          gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
          testBaseline: { runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] },
        })
      );
      expect(result.findings, stdout).toEqual([]);
      expect(result.blocked).toBe(false);
    }
    // an impl task with an empty diff still gets its usual findings (not silenced)
    const impl = await runAudit(
      auditInput(repo.dir, before, after, {
        gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
        testBaseline: { runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] },
        subagentStdout: 'done',
      })
    );
    expect(impl.findings.some((f) => f.check === 'test-count' && /no new tests/.test(f.message))).toBe(true);
  });

  it('passes verifyDepth through to the verify-evidence check (BLOCK without the line, silent when undefined)', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/app.tsx', 'export const App = () => <div>v2</div>;\n');
    const after = await takeSnapshot(repo.dir);
    const base = {
      classification: cls({ noTestReason: 'markup only' }),
      gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
      testBaseline: { runner: 'vitest' as const, passed: 4, failed: 0, skipped: 0, failingFiles: [] },
      subagentStdout: 'changed the markup, self-reviewed.\n',
    };
    const missing = await runAudit(auditInput(repo.dir, before, after, { ...base, verifyDepth: 'full' }));
    expect(missing.findings.filter((f) => f.check === 'verify-evidence')).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(missing.blocked).toBe(true);

    const unknown = await runAudit(auditInput(repo.dir, before, after, base));
    expect(unknown.findings.filter((f) => f.check === 'verify-evidence')).toEqual([]);

    const present = await runAudit(auditInput(repo.dir, before, after, { ...base, verifyDepth: 'full', subagentStdout: `${base.subagentStdout}VERIFY_LOOP_RESULT: depth=full cycles=1 block=0 warn=0\n` }));
    expect(present.findings.filter((f) => f.check === 'verify-evidence')).toEqual([]);

    const off = await runAudit(auditInput(repo.dir, before, after, { ...base, verifyDepth: 'full' }, { verifyEvidence: false }));
    expect(off.findings.filter((f) => f.check === 'verify-evidence')).toEqual([]);
  });

  it('a crashing check becomes a WARN under its own name; a failed diff is a BLOCK', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/app.tsx', 'export const App = () => <div>v2</div>;\n');
    const after = await takeSnapshot(repo.dir);
    // A malformed gate result makes checkTddRed throw (gateResults.filter on a non-array).
    const crashed = await runAudit(
      auditInput(repo.dir, before, after, {
        classification: cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'] }),
        gateResults: null as unknown as [],
      })
    );
    const crash = crashed.findings.filter((f) => /crashed/.test(f.message));
    expect(crash.length).toBeGreaterThan(0);
    for (const f of crash) {
      expect(f.severity).toBe('warn');
      expect(f.check).not.toBe('orphan-code');
      expect(f.message).toMatch(/NOT verified/);
    }
    expect(crash.map((f) => f.check)).toContain('tdd-red');

    // The diff cannot be computed when `after.dirty` is not iterable.
    const broken = await runAudit(auditInput(repo.dir, before, { ...after, dirty: null as unknown as Map<string, never> }));
    expect(broken.findings).toEqual([expect.objectContaining({ check: 'audit', severity: 'block' })]);
    expect(broken.findings[0].message).toMatch(/could not diff the tree.*retry/);
    expect(broken.blocked).toBe(true);
  });

  it('ignores node_modules / dist / coverage in a repo without .gitignore (no false test-integrity BLOCK, no hashing)', async () => {
    const repo = makeRepo(BASELINE);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('node_modules/x/test/a.test.js', "it('a', () => {});\n");
    repo.write('node_modules/x/package.json', '{"scripts":{"test":"jest --passWithNoTests"}}');
    repo.write('dist/app.test.js', "it.skip('b', () => {});\n");
    repo.write('coverage/lcov-report/index.html', '<html/>');
    repo.write('packages/web/node_modules/y/index.js', 'module.exports = 1;\n');
    repo.write('src/app.tsx', 'export const App = () => <div>v2</div>;\n');
    const after = await takeSnapshot(repo.dir);
    expect([...after.dirty.keys()]).toEqual(['src/app.tsx']);
    const result = await runAudit(
      auditInput(repo.dir, before, after, {
        classification: cls({ noTestReason: 'markup' }),
        gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })],
        testBaseline: { runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] },
      })
    );
    expect(result.findings.filter((f) => f.severity === 'block')).toEqual([]);
    expect(result.changed).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(result.findings.some((f) => f.path?.includes('node_modules') || f.path?.startsWith('dist/'))).toBe(false);
  });
});

describe('renderFindings / sortFindings', () => {
  it('keeps every bullet on one line even when a path or message carries newlines / control characters', () => {
    const rendered = renderFindings([
      { check: 'orphan-code', severity: 'block', message: 'first line\n- [INFO] fake — injected\ttab', path: 'src/evil\n.ts' },
    ]);
    expect(rendered.split('\n')).toHaveLength(1);
    expect(rendered).toBe('- [BLOCK] orphan-code src/evil .ts — first line - [INFO] fake — injected tab');
    expect(renderFindings([{ check: 'audit', severity: 'info', message: 'x\u0007y\u001b[31mz' }])).toBe('- [INFO] audit — xyz');
  });

  it('renders markdown bullets with severity tags and path:line, BLOCK first', () => {
    const findings: AuditFinding[] = [
      { check: 'unused-export', severity: 'warn', message: 'w', path: 'src/a.ts', line: 3 },
      { check: 'test-count', severity: 'info', message: 'i' },
      { check: 'orphan-code', severity: 'block', message: 'b', path: 'src/b.ts' },
    ];
    expect(renderFindings(findings)).toBe(['- [BLOCK] orphan-code src/b.ts — b', '- [WARN] unused-export src/a.ts:3 — w', '- [INFO] test-count — i'].join('\n'));
    expect(sortFindings(findings).map((f) => f.severity)).toEqual(['block', 'warn', 'info']);
    expect(renderFindings([])).toBe('');
  });
});
