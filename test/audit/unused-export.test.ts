import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/audit/diff.js';
import { takeSnapshot } from '../../src/audit/snapshot.js';
import { checkUnusedExports, extractExports, isPascalCase } from '../../src/audit/unused-export.js';
import type { TaskDiff } from '../../src/audit/types.js';
import { cls, makeRepo, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

async function taskDiff(repo: TempRepo, mutate: () => void): Promise<TaskDiff> {
  const before = await takeSnapshot(repo.dir);
  mutate();
  const after = await takeSnapshot(repo.dir);
  return diffSnapshots(before, after, repo.dir);
}

describe('extractExports', () => {
  it('extracts declarations, lists, defaults and CJS, flagging type-only', () => {
    const src = [
      'export function a() {}',
      'export async function b() {}',
      'export const c = 1, d = 2;',
      'export let e = 1;',
      'export class F {}',
      'export enum G {}',
      'export type T = 1;',
      'export interface I {}',
      'export { h, i as j, type K };',
      'export type { L } from "./l";',
      'export default function M() {}',
      'export const { n, o: p } = obj;',
      'exports.q = 1;',
      'module.exports = { r, s: 1 };',
    ].join('\n');
    const syms = extractExports(src);
    const names = syms.filter((s) => !s.typeOnly).map((s) => s.name).sort();
    expect(names).toEqual(['F', 'G', 'M', 'a', 'b', 'c', 'default', 'e', 'h', 'j', 'n', 'p', 'q', 'r', 's'].sort());
    expect(syms.filter((s) => s.typeOnly).map((s) => s.name).sort()).toEqual(['I', 'K', 'L', 'T']);
    expect(syms.find((s) => s.name === 'F')?.line).toBe(5);
  });

  it('isPascalCase', () => {
    expect(isPascalCase('Foo')).toBe(true);
    expect(isPascalCase('FooBar2')).toBe(true);
    expect(isPascalCase('useFoo')).toBe(false);
    expect(isPascalCase('API_URL')).toBe(false);
    expect(isPascalCase('URL')).toBe(false);
  });
});

describe('checkUnusedExports', () => {
  it('BLOCKs a PascalCase component in .tsx that is neither rendered nor imported', async () => {
    const repo = makeRepo({ 'src/app.tsx': 'export const App = () => null;\n' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\n'));
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings).toEqual([
      expect.objectContaining({ check: 'orphan-code', severity: 'block', path: 'src/components/Foo.tsx', line: 1 }),
    ]);
    expect(findings[0].message).toMatch(/never rendered \(<Foo\)/);
  });

  it('passes a component that is rendered, and one that is imported (multi-line) by production code', async () => {
    const repo = makeRepo({ 'src/app.tsx': 'export const App = () => null;\n', 'src/routes.tsx': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\nexport function Bar() { return null; }\n');
      repo.write('src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => <Foo />;\n");
      repo.write('src/routes.tsx', "import {\n  Bar,\n} from './components/Foo';\nexport const routes = [{ element: Bar }];\n");
    });
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
  });

  it('does not accept a test-only render of a component', async () => {
    const repo = makeRepo({ 'src/app.tsx': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/components/Foo.tsx', 'export const Foo = () => <div/>;\n');
      repo.write('src/components/Foo.test.tsx', "import { Foo } from './Foo';\nit('r', () => { expect(<Foo/>).toBeTruthy(); });\n");
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'block', path: 'src/components/Foo.tsx' })]);
  });

  it('WARNs on a new non-component export nobody references; skips types/interfaces and framework names', async () => {
    const repo = makeRepo({ 'src/lib/pricing.ts': 'export const quote = () => 1;\n', 'src/app.ts': "import { quote } from './lib/pricing';\nquote();\n" });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write(
        'src/lib/pricing.ts',
        'export const quote = () => 1;\nexport const tax = () => 2;\nexport type Money = number;\nexport interface Line { n: number }\nexport const config = {};\n'
      );
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'warn', path: 'src/lib/pricing.ts', line: 2 })]);
    expect(findings[0].message).toContain('tax');
  });

  it('says so when a new export is only referenced from tests, and collapses many per file', async () => {
    const repo = makeRepo({ 'src/lib/pricing.ts': 'export const quote = () => 1;\n', 'src/app.ts': "import { quote } from './lib/pricing';\nquote();\n" });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\nexport const tax = () => 2;\n');
      repo.write('test/pricing.test.ts', "import { tax } from '../src/lib/pricing';\nit('t', () => { expect(tax()).toBe(2); });\n");
      repo.write('src/lib/many.ts', ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `export const ${n} = 1;`).join('\n') + '\n');
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings.find((f) => f.path === 'src/lib/pricing.ts')?.message).toMatch(/tax .* only referenced from tests/);
    const many = findings.filter((f) => f.path === 'src/lib/many.ts');
    expect(many).toHaveLength(1);
    expect(many[0].message).toMatch(/7 new exports .* \(a, b, c, d, e, f, g\)/);
  });

  it('only flags symbols that are NEW in this task (pre-existing unused exports are ignored)', async () => {
    const repo = makeRepo({ 'src/lib/pricing.ts': 'export const old = 1;\n', 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => repo.write('src/lib/pricing.ts', 'export const old = 1;\nexport const used = 2;\n'));
    repo.write('src/app.ts', "import { used } from './lib/pricing';\nused;\n");
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
  });

  it('skips entrypoints, test files, .d.ts and non-JS languages', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('app/dashboard/page.tsx', 'export default function Page() { return null; }\nexport const metadata = {};\n');
      repo.write('src/index.ts', 'export const publicApi = 1;\n');
      repo.write('src/types.d.ts', 'export declare const x: number;\n');
      repo.write('test/helpers.ts', 'export const helper = 1;\n');
      repo.write('app/models.py', 'def x(): pass\n');
    });
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
  });

  it('downgrades the component BLOCK to INFO when the task defers wiring', async () => {
    const repo = makeRepo({ 'src/app.tsx': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => repo.write('src/components/Foo.tsx', 'export const Foo = () => <div/>;\n'));
    const findings = await checkUnusedExports(diff, repo.dir, cls({ wiredBy: 'T009' }));
    expect(findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'info' })]);
  });
});

describe('checkUnusedExports — noise reduction', () => {
  it('a symbol its own file uses is not reported; constants / schemas / enums are one INFO; the default export is named after its function', async () => {
    const repo = makeRepo({ 'src/lib/a.ts': 'export const a = () => 1;\n', 'src/app.ts': "import { a } from './lib/a';\na();\n", 'src/lib/legacy.tsx': 'export const legacy = 1;\n' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/a.ts', "import { z } from 'zod';\nexport const a = () => helper();\nexport const helper = () => 1;\nexport const LIMIT = 10;\nexport const userSchema = z.object({});\nexport enum Color { Red }\nexport const b = 2;\n");
      repo.write('src/lib/legacy.tsx', 'export const legacy = 1;\nexport default function Legacy() { return null; }\n');
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    const a = findings.filter((f) => f.path === 'src/lib/a.ts');
    expect(a.map((f) => [f.severity, f.check])).toEqual([
      ['warn', 'unused-export'],
      ['info', 'unused-export'],
    ]);
    expect(a[0].message).toContain('export b ');
    expect(a[1].message).toMatch(/LIMIT, userSchema, Color/);
    const legacy = findings.find((f) => f.path === 'src/lib/legacy.tsx');
    expect(legacy).toMatchObject({ check: 'orphan-code', severity: 'block' });
    expect(legacy?.message).toMatch(/Legacy/);
    expect(legacy?.message).not.toMatch(/<default/);
  });

  it('`const a = 1; export { a }` is NOT own-file usage; `export default Foo` is not either', async () => {
    const { usedWithinOwnFile, isDataExport } = await import('../../src/audit/unused-export.js');
    expect(usedWithinOwnFile('const a = 1;\nexport { a };\n', 'a', 'x.ts')).toBe(false);
    expect(usedWithinOwnFile('export function Foo() {}\nexport default Foo;\n', 'Foo', 'x.tsx')).toBe(false);
    expect(usedWithinOwnFile('export function Foo() {}\nexport function Bar() { return <Foo/>; }\n', 'Foo', 'x.tsx')).toBe(true);
    expect(usedWithinOwnFile("export const a = 1; // a is great\nconst s = 'a';\n", 'a', 'x.ts')).toBe(false);
    expect(isDataExport('MAX_RETRIES', '')).toBe(true);
    expect(isDataExport('userSchema', '')).toBe(true);
    expect(isDataExport('shape', 'export const shape = v.object({});')).toBe(true);
    expect(isDataExport('Color', 'export enum Color { Red }')).toBe(true);
    expect(isDataExport('fetchUsers', 'export const fetchUsers = () => 1;')).toBe(false);
    expect(isDataExport('X', '')).toBe(false); // single letter is not a constant
  });
});

describe('checkUnusedExports — import is not use (reviewer countermeasure)', () => {
  it('BLOCKs a component that production code only IMPORTS (no render / createElement / call / prop value)', async () => {
    const repo = makeRepo({ 'src/app.tsx': 'export const App = () => null;\n' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\n');
      // the grep-satisfying cheat: import it, never use it
      repo.write('src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => <div />;\n");
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'block', path: 'src/components/Foo.tsx', line: 1 })]);
    expect(findings[0].message).toMatch(/component Foo .* is imported by src\/app\.tsx but never rendered \(<Foo\)/);
    // wiring deferred → INFO, not BLOCK
    expect(await checkUnusedExports(diff, repo.dir, cls({ wiredBy: 'T009' }))).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'info' })]);
  });

  it('accepts every real use form: render, namespaced render, createElement, call, prop value, route table, HOC argument, page re-export', async () => {
    const uses: Array<[string, string]> = [
      ['src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => <Foo />;\n"],
      ['src/app.tsx', "import * as C from './components/Foo';\nexport const App = () => <C.Foo />;\n"],
      ['src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => React.createElement(Foo, null);\n"],
      ['src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => Foo({});\n"],
      ['src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = () => <Route component={Foo} />;\n"],
      ['src/routes.tsx', "import { Foo } from './components/Foo';\nexport const routes = [{ path: '/', Component: Foo }];\n"],
      ['src/app.tsx', "import { Foo } from './components/Foo';\nexport const App = withAuth(Foo);\n"],
      ['app/foo/page.tsx', "export { Foo as default } from '../../src/components/Foo';\n"],
    ];
    for (const [consumer, content] of uses) {
      const repo = makeRepo({ 'src/app.tsx': '', 'src/routes.tsx': '' });
      repos.push(repo);
      const diff = await taskDiff(repo, () => {
        repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\n');
        repo.write(consumer, content);
      });
      expect(await checkUnusedExports(diff, repo.dir), content).toEqual([]);
    }
  });

  it('a (non-entrypoint) barrel that only re-exports the component is not a use; a consumer rendering it through the barrel is', async () => {
    const repo = makeRepo({ 'src/app.tsx': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/ui/widgets/Foo.tsx', 'export function Foo() { return <div/>; }\n');
      repo.write('src/ui/widgets/index.ts', "import { Foo } from './Foo';\nexport { Foo };\n");
    });
    const only = await checkUnusedExports(diff, repo.dir);
    expect(only).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'block', path: 'src/ui/widgets/Foo.tsx' })]);
    expect(only[0].message).toContain('imported by src/ui/widgets/index.ts');
    repo.write('src/app.tsx', "import { Foo } from './ui/widgets';\nexport const App = () => <Foo />;\n");
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
    // a shallow `src/<dir>/index.ts` is an entrypoint by the path patterns: its re-export is a public API and counts
    const diff2 = await taskDiff(repo, () => {
      repo.write('src/components/Bar.tsx', 'export function Bar() { return null; }\n');
      repo.write('src/components/index.ts', "export { Bar } from './Bar';\n");
    });
    expect(await checkUnusedExports(diff2, repo.dir)).toEqual([]);
  });

  it('WARNs on a plain export that is imported but never used in the importer; namespace use and real use pass', async () => {
    const repo = makeRepo({ 'src/lib/pricing.ts': 'export const quote = () => 1;\n', 'src/app.ts': "import { quote } from './lib/pricing';\nquote();\n" });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\nexport const tax = () => 2;\n');
      repo.write('src/app.ts', "import { quote, tax } from './lib/pricing';\nquote();\n");
    });
    const f = await checkUnusedExports(diff, repo.dir);
    expect(f).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'warn', path: 'src/lib/pricing.ts', line: 2 })]);
    expect(f[0].message).toMatch(/export tax .* is imported by src\/app\.ts but never used there/);

    repo.write('src/app.ts', "import * as P from './lib/pricing';\nP.quote(); P.tax();\n");
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
    repo.write('src/app.ts', "import { quote, tax } from './lib/pricing';\nquote(); tax();\n");
    expect(await checkUnusedExports(diff, repo.dir)).toEqual([]);
    // a comment / string mention is not a reference either
    repo.write('src/app.ts', "import { quote } from './lib/pricing';\n// tax is computed elsewhere: 'tax'\nquote();\n");
    const mention = await checkUnusedExports(diff, repo.dir);
    expect(mention).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'warn' })]);
    expect(mention[0].message).toMatch(/not referenced by any other production file/);
  });

  it('runs ONE reference search per task (symbols of several files batched) and still attributes per file', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/a.ts', 'export const alpha = () => 1;\n');
      repo.write('src/lib/b.ts', 'export const beta = () => 2;\nexport const gamma = () => 3;\n');
      repo.write('src/app.ts', "import { alpha } from './lib/a';\nimport { beta } from './lib/b';\nalpha(); beta();\n");
    });
    const findings = await checkUnusedExports(diff, repo.dir);
    expect(findings).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'warn', path: 'src/lib/b.ts' })]);
    expect(findings[0].message).toContain('gamma');
    // `alpha` / `beta` are used by app.ts; neither file is blamed for the other's symbols
    expect(findings.some((f) => f.path === 'src/lib/a.ts')).toBe(false);
  });
});
