import { describe, expect, it } from 'vitest';
import { checkGateIntegrity, packageJsonGateDiff, pyprojectGateDiff } from '../../src/audit/gate-integrity.js';
import type { ChangedFile, TaskDiff } from '../../src/audit/types.js';
import { cls } from './_helpers.js';

function cfg(path: string, over: Partial<ChangedFile>): ChangedFile {
  return { path, kind: 'modified', isTest: false, isCode: false, isGateConfig: true, ...over };
}
const diff = (...files: ChangedFile[]): TaskDiff => ({ files, headMoved: false });

describe('packageJsonGateDiff', () => {
  const base = { name: 'x', version: '1.0.0', scripts: { test: 'vitest run', build: 'tsc', dev: 'tsc -w' }, dependencies: { zod: '1' } };
  it('ignores changes outside the gate keys', () => {
    const after = { ...base, version: '1.1.0', scripts: { ...base.scripts, dev: 'tsx watch' }, dependencies: { zod: '2', commander: '1' } };
    expect(packageJsonGateDiff(JSON.stringify(base), JSON.stringify(after)).changed).toBe(false);
  });
  it('detects gate script and jest/vitest key changes', () => {
    const r = packageJsonGateDiff(JSON.stringify(base), JSON.stringify({ ...base, scripts: { ...base.scripts, test: 'vitest run --passWithNoTests' } }));
    expect(r.changed).toBe(true);
    expect(r.detail).toContain('scripts.test: "vitest run" → "vitest run --passWithNoTests"');
    expect(packageJsonGateDiff(JSON.stringify(base), JSON.stringify({ ...base, scripts: { build: 'tsc', dev: 'x' } })).detail).toContain('scripts.test: "vitest run" → null');
    expect(packageJsonGateDiff(JSON.stringify(base), JSON.stringify({ ...base, jest: { testPathIgnorePatterns: ['x'] } })).detail).toContain('jest config changed');
    expect(packageJsonGateDiff(JSON.stringify(base), JSON.stringify({ ...base, scripts: { ...base.scripts, 'test:e2e': 'playwright test' } })).changed).toBe(true);
  });
  it('flags an unparseable after', () => {
    expect(packageJsonGateDiff(JSON.stringify(base), '{ nope').changed).toBe(true);
  });
});

describe('pyprojectGateDiff', () => {
  const before = '[project]\nname = "x"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n\n[tool.ruff]\nline-length = 100\n';
  it('ignores non-gate sections but catches pytest/ruff changes', () => {
    expect(pyprojectGateDiff(before, before.replace('name = "x"', 'name = "y"\nversion = "2"')).changed).toBe(false);
    const r = pyprojectGateDiff(before, before.replace('testpaths = ["tests"]', 'testpaths = ["tests/unit"]'));
    expect(r).toEqual({ changed: true, detail: 'gate sections changed: [tool.pytest.ini_options]' });
  });
});

describe('checkGateIntegrity', () => {
  it('BLOCKs a modified gate config, INFO when the task allows it', () => {
    const f = cfg('vitest.config.ts', { before: "test: { include: ['test/**'] }", after: "test: { include: ['test/unit/**'] }" });
    expect(checkGateIntegrity(diff(f), cls())).toEqual([expect.objectContaining({ check: 'gate-integrity', severity: 'block', path: 'vitest.config.ts' })]);
    expect(checkGateIntegrity(diff(f), cls({ allowsConfigChange: true }))).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(checkGateIntegrity(diff(f), cls({ kind: 'config' }))).toEqual([expect.objectContaining({ severity: 'info' })]);
    // pure lint config has no structural parser: any change is a BLOCK
    const lint = cfg('.eslintrc.cjs', { before: 'a', after: 'b' });
    expect(checkGateIntegrity(diff(lint), cls())).toEqual([expect.objectContaining({ severity: 'block', path: '.eslintrc.cjs' })]);
  });

  it('BLOCKs deletion, WARNs on a new config file', () => {
    expect(checkGateIntegrity(diff(cfg('jest.config.js', { kind: 'deleted', before: 'x' })), cls())).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(checkGateIntegrity(diff(cfg('vitest.config.ts', { kind: 'added', after: 'x' })), cls())).toEqual([expect.objectContaining({ severity: 'warn' })]);
  });

  it('package.json: only the gate keys count', () => {
    const before = JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: {} });
    const depsOnly = cfg('package.json', { before, after: JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { zod: '3' } }) });
    expect(checkGateIntegrity(diff(depsOnly), cls())).toEqual([]);
    const testChanged = cfg('package.json', { before, after: JSON.stringify({ scripts: { test: 'echo ok' }, dependencies: {} }) });
    const findings = checkGateIntegrity(diff(testChanged), cls());
    expect(findings).toEqual([expect.objectContaining({ severity: 'block', path: 'package.json' })]);
    expect(findings[0].message).toContain('scripts.test');
  });

  it('ignores identical content and non-gate files', () => {
    expect(checkGateIntegrity(diff(cfg('tsconfig.json', { before: 'x', after: 'x' })), cls())).toEqual([]);
    expect(checkGateIntegrity(diff(cfg('src/a.ts', { before: 'x', after: 'y', isGateConfig: false })), cls())).toEqual([]);
  });
});

describe('structural diffs (reviewer scenarios)', () => {
  it('tsconfig: JSONC parses; paths/jsx/lib are soft, strictness/include/exclude are hard', async () => {
    const { parseJsonc, tsconfigGateDiff, runnerConfigGateDiff } = await import('../../src/audit/gate-integrity.js');
    expect(parseJsonc('{\n  // c\n  "a": [1, 2,], /* d */ "b": "x//y",\n}')).toEqual({ a: [1, 2], b: 'x//y' });
    const base = '{ "compilerOptions": { "strict": true, "jsx": "preserve" }, "include": ["src"] }';
    expect(tsconfigGateDiff(base, base.replace('"jsx": "preserve"', '"jsx": "react-jsx", "paths": { "@/*": ["./src/*"] }, "lib": ["dom"], "types": ["node"]'))).toMatchObject({ changed: true, soft: true });
    const hard = tsconfigGateDiff(base, base.replace('"strict": true', '"strict": false'));
    expect(hard.changed).toBe(true);
    expect(hard.soft).toBeFalsy();
    expect(tsconfigGateDiff(base, base.replace('"include": ["src"]', '"include": ["src"], "exclude": ["src/legacy"]')).detail).toContain('exclude');
    expect(tsconfigGateDiff(base, base.replace('"strict": true', '"strict": true, "skipLibCheck": true')).detail).toContain('skipLibCheck');
    expect(tsconfigGateDiff(base, base)).toMatchObject({ changed: false });
    expect(tsconfigGateDiff(base, '{ nope')).toMatchObject({ changed: true });

    const cfg = "export default defineConfig({\n  plugins: [],\n  test: {\n    include: ['test/**/*.test.ts'],\n    environment: 'node',\n  },\n});\n";
    expect(runnerConfigGateDiff(cfg, cfg.replace('plugins: []', 'plugins: [react()], resolve: { alias: { "@": "/src" } }'))).toMatchObject({ changed: true, soft: true });
    expect(runnerConfigGateDiff(cfg, cfg.replace("environment: 'node'", "environment: 'jsdom'"))).toMatchObject({ changed: true, soft: true });
    expect(runnerConfigGateDiff(cfg, cfg.replace("include: ['test/**/*.test.ts']", "include: ['test/unit/**']")).soft).toBeFalsy();
    expect(runnerConfigGateDiff(cfg, cfg.replace('plugins: [],', 'plugins: [],\n  test: { passWithNoTests: true },')).soft).toBeFalsy();
    expect(runnerConfigGateDiff(undefined, cfg)).toMatchObject({ changed: true });
  });

  it('CI workflows never BLOCK; Makefile depends on whether a gate invokes make', () => {
    const ci = cfg('.github/workflows/ci.yml', { before: 'a', after: 'b' });
    expect(checkGateIntegrity(diff(ci), cls())).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(checkGateIntegrity(diff(cfg('.github/workflows/ci.yml', { kind: 'deleted', before: 'a' })), cls())).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(checkGateIntegrity(diff(cfg('.github/workflows/ci.yml', { kind: 'added', after: 'a' })), cls())).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(checkGateIntegrity(diff(ci), cls({ kind: 'config' }))).toEqual([expect.objectContaining({ severity: 'info' })]);
    const mk = cfg('Makefile', { before: 'test:\n\tvitest', after: 'test:\n\ttrue' });
    expect(checkGateIntegrity(diff(mk), cls(), { gateCommands: ['npm test', 'tsc --noEmit'] })).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(checkGateIntegrity(diff(mk), cls(), { gateCommands: ['make test'] })).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(checkGateIntegrity(diff(mk), cls(), { gateCommands: ['cd api && make -j test'] })).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(checkGateIntegrity(diff(mk), cls())).toEqual([expect.objectContaining({ severity: 'block' })]); // unknown gates: status quo
  });
});

describe('checkGateIntegrity — generated paths', () => {
  it('ignores a package.json / config under node_modules or dist', () => {
    const d = {
      headMoved: false,
      files: [
        { path: 'node_modules/pkg/package.json', kind: 'modified' as const, before: '{"scripts":{"test":"a"}}', after: '{"scripts":{"test":"b"}}', isTest: false, isCode: false, isGateConfig: true },
        { path: 'dist/vitest.config.ts', kind: 'added' as const, after: 'export default {};', isTest: false, isCode: true, isGateConfig: true },
      ],
    };
    expect(checkGateIntegrity(d, cls())).toEqual([]);
  });
});
