import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/audit/diff.js';
import { checkOrphans } from '../../src/audit/orphan.js';
import { findModuleReferences, pyReferencesModule, rustReferencesModule, specResolvesTo } from '../../src/audit/refs.js';
import { takeSnapshot } from '../../src/audit/snapshot.js';
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

describe('specResolvesTo', () => {
  const root = '/nonexistent-project';
  it('resolves relative specifiers (with or without extension, .js → .ts)', () => {
    expect(specResolvesTo('./components/Foo', 'src/app.tsx', 'src/components/Foo.tsx', root)).toBe(true);
    expect(specResolvesTo('./Foo.js', 'src/components/index.ts', 'src/components/Foo.ts', root)).toBe(true);
    expect(specResolvesTo('../lib/pricing', 'src/routes/checkout.ts', 'src/lib/pricing.ts', root)).toBe(true);
    expect(specResolvesTo('./Foo', 'src/other/page.tsx', 'src/components/Foo.tsx', root)).toBe(false);
    expect(specResolvesTo('./Foo.css', 'src/components/Bar.tsx', 'src/components/Foo.tsx', root)).toBe(false);
  });
  it('resolves directory index imports', () => {
    expect(specResolvesTo('./auth', 'src/app.ts', 'src/auth/index.ts', root)).toBe(true);
    expect(specResolvesTo('./auth/index.js', 'src/app.ts', 'src/auth/index.ts', root)).toBe(true);
  });
  it('resolves alias and baseUrl forms', () => {
    expect(specResolvesTo('@/components/Foo', 'src/app/page.tsx', 'src/components/Foo.tsx', root)).toBe(true);
    expect(specResolvesTo('~/lib/x', 'app/routes/a.tsx', 'app/lib/x.ts', root)).toBe(true);
    expect(specResolvesTo('src/lib/x', 'src/a.ts', 'src/lib/x.ts', root)).toBe(true);
    expect(specResolvesTo('$lib/x', 'src/routes/+page.svelte', 'src/lib/x.ts', root)).toBe(true);
    expect(specResolvesTo('#utils', 'src/a.ts', 'src/utils.ts', root)).toBe(true);
    expect(specResolvesTo('@app/components/Foo', 'src/a.ts', 'src/components/Foo.tsx', root)).toBe(true);
  });
  it('rejects real packages', () => {
    // this repo has node_modules/vitest
    expect(specResolvesTo('vitest', 'src/a.ts', 'src/vitest.ts', process.cwd())).toBe(false);
    expect(specResolvesTo('zod/lib', 'src/a.ts', 'src/zod/lib.ts', process.cwd())).toBe(false);
  });
});

describe('language reference helpers', () => {
  it('python: absolute, relative and from-package imports', () => {
    expect(pyReferencesModule('from app.services.pricing import quote\n', 'app/api.py', 'app/services/pricing.py')).toBe(true);
    expect(pyReferencesModule('from .pricing import quote\n', 'app/services/api.py', 'app/services/pricing.py')).toBe(true);
    expect(pyReferencesModule('from . import pricing\n', 'app/services/api.py', 'app/services/pricing.py')).toBe(true);
    expect(pyReferencesModule('import app.services.pricing as p\n', 'main.py', 'app/services/pricing.py')).toBe(true);
    expect(pyReferencesModule('from services.pricing import quote\n', 'src/app/api.py', 'src/services/pricing.py')).toBe(true);
    expect(pyReferencesModule('# pricing is mentioned\nx = pricing()\n', 'app/api.py', 'app/services/pricing.py')).toBe(false);
    expect(pyReferencesModule('from app.services.billing import quote\n', 'app/api.py', 'app/services/pricing.py')).toBe(false);
  });
  it('rust: mod declarations and crate paths', () => {
    expect(rustReferencesModule('pub mod tcp;\n', 'src/net/tcp.rs')).toBe(true);
    expect(rustReferencesModule('use crate::net::tcp::Conn;\n', 'src/net/tcp.rs')).toBe(true);
    expect(rustReferencesModule('// tcp\nfn x() {}\n', 'src/net/tcp.rs')).toBe(false);
  });
});

describe('checkOrphans', () => {
  it('BLOCKs an added component nothing imports', async () => {
    const repo = makeRepo({ 'src/app.tsx': 'export const App = () => null;\n' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\n'));
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ check: 'orphan-code', severity: 'block', path: 'src/components/Foo.tsx' });
    expect(res.findings[0].message).toMatch(/not imported, rendered, or mounted/);
    expect(res.newPending).toEqual([]);
  });

  it('passes when production code imports the new module (multi-line import, alias, dynamic import)', async () => {
    const repo = makeRepo({ 'src/app.tsx': 'export const App = () => null;\n', 'src/routes.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/components/Foo.tsx', 'export function Foo() { return <div/>; }\n');
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      repo.write('src/lib/lazy.ts', 'export default 1;\n');
      repo.write('src/app.tsx', "import {\n  Foo,\n} from './components/Foo';\nimport { quote } from '@/lib/pricing';\nexport const App = () => <Foo total={quote()} />;\n");
      repo.write('src/routes.ts', "export const load = () => import('./lib/lazy.js');\n");
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([]);
  });

  it('BLOCKs a module only referenced from tests', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      repo.write('test/pricing.test.ts', "import { quote } from '../src/lib/pricing';\nit('q', () => expect(quote()).toBe(1));\n");
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ severity: 'block', path: 'src/lib/pricing.ts' });
    expect(res.findings[0].message).toMatch(/only referenced from tests \(test\/pricing\.test\.ts\)/);
  });

  it('does not count a textual mention that is not an import', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      repo.write('src/app.ts', '// TODO: wire pricing later\nconst pricing = 1;\n');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings[0]).toMatchObject({ severity: 'block', path: 'src/lib/pricing.ts' });
  });

  it('exempts entrypoints, test files, go files and non-code', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('app/dashboard/page.tsx', 'export default function Page() { return null; }\n');
      repo.write('src/index.ts', 'export {};\n');
      repo.write('scripts/seed.ts', 'console.log(1);\n');
      repo.write('test/x.test.ts', 'it("x", () => expect(1).toBe(1));\n');
      repo.write('pkg/handler.go', 'package pkg\n');
      repo.write('docs/guide.md', '# hi\n');
      repo.write('convex/users.ts', 'export const list = 1;\n');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([]);
  });

  it('records a pending wiring promise (INFO) when the task says `wired by`', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n'));
    const res = await checkOrphans(diff, repo.dir, cls({ wiredBy: 'T005' }), [], 'T003');
    expect(res.findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'info', path: 'src/lib/pricing.ts' })]);
    expect(res.newPending).toEqual([{ artifactPath: 'src/lib/pricing.ts', createdBy: 'T003', wiredBy: 'T005' }]);
  });

  it('re-checks pending wiring owned by this task: resolves when wired, BLOCKs when not', async () => {
    const repo = makeRepo({ 'src/app.ts': '', 'src/lib/pricing.ts': 'export const quote = () => 1;\n', 'src/lib/tax.ts': 'export const tax = 1;\n' });
    repos.push(repo);
    const pending = [
      { artifactPath: 'src/lib/pricing.ts', createdBy: 'T003', wiredBy: 'T005' },
      { artifactPath: 'src/lib/tax.ts', createdBy: 'T003', wiredBy: 'T005' },
      { artifactPath: 'src/lib/other.ts', createdBy: 'T002', wiredBy: 'T009' },
    ];
    const diff = await taskDiff(repo, () => repo.write('src/app.ts', "import { quote } from './lib/pricing';\nquote();\n"));
    const res = await checkOrphans(diff, repo.dir, cls(), pending, 'T005');
    expect(res.resolvedPending).toEqual([pending[0]]);
    expect(res.findings).toEqual([expect.objectContaining({ check: 'pending-wiring', severity: 'block', path: 'src/lib/tax.ts' })]);
    expect(res.findings[0].message).toContain('wired by: T005');
  });

  it('handles python, rust and ruby wiring', async () => {
    const repo = makeRepo({ 'app/__init__.py': '', 'app/api.py': '', 'src/main.rs': 'fn main() {}\n', 'lib/app.rb': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('app/services/pricing.py', 'def quote(): return 1\n');
      repo.write('app/services/orphan.py', 'def x(): return 1\n');
      repo.write('app/api.py', 'from app.services.pricing import quote\n');
      repo.write('src/net.rs', 'pub fn x() {}\n');
      repo.write('src/main.rs', 'mod net;\nfn main() { net::x(); }\n');
      repo.write('lib/user_profile.rb', 'class UserProfile; end\n');
      repo.write('lib/app.rb', "require_relative 'user_profile'\n");
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings.map((f) => f.path)).toEqual(['app/services/orphan.py']);
  });

  it('accepts Vue template tags and python dotted-string references; WARNs (not BLOCKs) for DI-discovered languages', async () => {
    const repo = makeRepo({ 'src/App.vue': '<template><div/></template>\n', 'config/urls.py': '', 'src/main/java/app/Main.java': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/components/UserCard.vue', '<template><p/></template>\n');
      repo.write('src/App.vue', '<template><user-card /></template>\n');
      repo.write('app/urls.py', 'urlpatterns = []\n');
      repo.write('config/urls.py', "from django.urls import include, path\nurlpatterns = [path('app/', include('app.urls'))]\n");
      repo.write('src/main/java/app/FooService.java', '@Service public class FooService {}\n');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([expect.objectContaining({ severity: 'warn', path: 'src/main/java/app/FooService.java' })]);
  });

  it('exempts framework-discovered files (Remix routes, SvelteKit, Nuxt server, Django models)', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('app/routes/users.$id.tsx', 'export default function U() { return null; }\n');
      repo.write('src/routes/about/+page.svelte', '<h1/>\n');
      repo.write('src/routes/api/+server.ts', 'export const GET = () => new Response();\n');
      repo.write('server/api/hello.ts', 'export default defineEventHandler(() => "hi");\n');
      repo.write('shop/models.py', 'class Item: pass\n');
      repo.write('api/hello.ts', 'export default (req, res) => res.end();\n');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([]);
  });

  it('falls back to a manual walk when git grep is unavailable (non-git dir)', async () => {
    const repo = makeRepo({ 'src/app.ts': "import { quote } from './lib/pricing';\n" }, { git: false });
    repos.push(repo);
    repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
    repo.write('node_modules/pkg/index.js', "require('./lib/pricing')\n");
    const refs = await findModuleReferences(repo.dir, 'src/lib/pricing.ts');
    expect(refs.production).toEqual(['src/app.ts']);
  });
});

describe('checkOrphans — reviewer scenarios', () => {
  it('ignores the orchestrator state file, build output and vendored deps as "consumers"', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      // Un-ignored .fullauto/state.json mentioning the artifact (the audit's own findings) must not wire it.
      repo.write('.fullauto/state.json', JSON.stringify({ findings: [{ path: 'src/lib/pricing.ts', message: 'src/lib/pricing.ts is not imported' }] }));
      repo.write('dist/app.js', "require('./lib/pricing');\n");
      repo.write('packages/x/node_modules/dep/index.js', "require('src/lib/pricing');\n");
      repo.write('vendor/thing.json', '{"entry":"src/lib/pricing.ts"}');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([expect.objectContaining({ severity: 'block', path: 'src/lib/pricing.ts' })]);
  });

  it('a test task adding a production-path helper only tests use is WARN, not BLOCK', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/test-support/factory.ts', 'export const mk = () => 1;\n');
      repo.write('test/a.test.ts', "import { mk } from '../src/test-support/factory';\nit('x', () => expect(mk()).toBe(1));\n");
    });
    const res = await checkOrphans(diff, repo.dir, cls({ kind: 'test' }), [], 'T001');
    expect(res.findings).toEqual([expect.objectContaining({ severity: 'warn', path: 'src/test-support/factory.ts' })]);
    // conventional test-support locations are exempt outright
    const diff2 = await taskDiff(repo, () => {
      repo.write('src/mocks/handlers.ts', 'export const handlers = [];\n');
      repo.write('src/setupTests.ts', "import './mocks/handlers';\n");
      repo.write('src/test-utils.tsx', 'export const render = () => null;\n');
      repo.write('shop/tests.py', 'def test_x():\n    assert 1\n');
    });
    expect((await checkOrphans(diff2, repo.dir, cls({ kind: 'test' }), [], 'T001')).findings).toEqual([]);
  });

  it('an implied `wiredBy` (paired red task → its green task) records pending wiring exactly like the explicit marker', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = (): number => { throw new Error("todo"); };\n');
      repo.write('test/pricing.test.ts', "import { quote } from '../src/lib/pricing';\nit('q', () => expect(quote()).toBe(1));\n");
    });
    // task-class sets wiredBy = greenTaskIds[0] for a paired red task (no `- wired by:` in the body)
    const implied = cls({ kind: 'test', tdd: 'red', greenTaskIds: ['T002'], wiredBy: 'T002' });
    const res = await checkOrphans(diff, repo.dir, implied, [], 'T001');
    expect(res.findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'info', path: 'src/lib/pricing.ts' })]);
    expect(res.newPending).toEqual([{ artifactPath: 'src/lib/pricing.ts', createdBy: 'T001', wiredBy: 'T002' }]);
    // and the green task is then held to it
    const later = await checkOrphans({ files: [], headMoved: false }, repo.dir, cls({ tdd: 'green', redTaskIds: ['T001'] }), res.newPending, 'T002');
    expect(later.findings).toEqual([expect.objectContaining({ check: 'pending-wiring', severity: 'block', path: 'src/lib/pricing.ts' })]);
  });

  it('new modules that import each other within the same task count as wired', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
      repo.write('src/lib/b.ts', 'export const b = () => 1;\n');
      repo.write('src/app.ts', "import { a } from './lib/a';\na();\n");
    });
    expect((await checkOrphans(diff, repo.dir, cls(), [], 'T001')).findings).toEqual([]);
  });

  it('Rails: a controller is wired by config/routes.rb, a model by a view template', async () => {
    const repo = makeRepo({ 'config/routes.rb': 'Rails.application.routes.draw do\nend\n', 'app/views/home/index.html.erb': '<h1>hi</h1>\n' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('app/controllers/users_controller.rb', 'class UsersController < ApplicationController; end\n');
      repo.write('app/controllers/orphans_controller.rb', 'class OrphansController < ApplicationController; end\n');
      repo.write('app/models/invoice.rb', 'class Invoice < ApplicationRecord; end\n');
      repo.write('config/routes.rb', "Rails.application.routes.draw do\n  resources :users\nend\n");
      repo.write('app/views/home/index.html.erb', '<h1><%= Invoice.count %></h1>\n');
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings.map((f) => f.path)).toEqual(['app/controllers/orphans_controller.rb']);
  });
});

describe('checkOrphans — import is not use (reviewer countermeasure)', () => {
  it('BLOCKs a module whose only production importer never uses any imported binding', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\nexport const tax = () => 2;\n');
      repo.write('src/app.ts', "import { quote, tax } from './lib/pricing';\nexport const run = () => 1;\n");
    });
    const res = await checkOrphans(diff, repo.dir, cls(), [], 'T001');
    expect(res.findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'block', path: 'src/lib/pricing.ts' })]);
    expect(res.findings[0].message).toMatch(/imported but never used in src\/app\.ts \(quote, tax bound by the import statement/);
    // with `wired by` the same situation is INFO + a pending promise
    const deferred = await checkOrphans(diff, repo.dir, cls({ wiredBy: 'T004' }), [], 'T001');
    expect(deferred.findings).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(deferred.findings[0].message).toContain('wiring deferred to T004');
  });

  it('accepts a binding used beyond the import: named, default, namespace, require destructuring, re-export, dynamic import', async () => {
    const cases: Array<[string, string]> = [
      ['src/app.ts', "import { quote } from './lib/pricing';\nexport const total = () => quote();\n"],
      ['src/app.ts', "import pricing from './lib/pricing';\nexport const total = () => pricing.quote();\n"],
      ['src/app.ts', "import * as P from './lib/pricing';\nexport const total = () => P.quote();\n"],
      ['src/app.ts', "const { quote } = require('./lib/pricing');\nmodule.exports = () => quote();\n"],
      ['src/lib/deep/index.ts', "export * from '../pricing';\n"],
      ['src/app.ts', "export const load = () => import('./lib/pricing');\n"],
      ['src/app.ts', "import {\n  quote,\n  type Money,\n} from './lib/pricing';\nexport const total = (): Money => quote();\n"],
    ];
    for (const [consumer, content] of cases) {
      // the consumer pre-exists (committed) so only pricing.ts is the artifact under audit
      const repo = makeRepo({ 'src/app.ts': '', [consumer]: '' });
      repos.push(repo);
      const diff = await taskDiff(repo, () => {
        repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\nexport type Money = number;\nexport default { quote };\n');
        repo.write(consumer, content);
      });
      expect((await checkOrphans(diff, repo.dir, cls(), [], 'T001')).findings, content).toEqual([]);
    }
  });

  it('one importer that uses it is enough even when another only imports it', async () => {
    const repo = makeRepo({ 'src/app.ts': '', 'src/other.ts': '' });
    repos.push(repo);
    const diff = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      repo.write('src/other.ts', "import { quote } from './lib/pricing';\n");
      repo.write('src/app.ts', "import { quote } from './lib/pricing';\nexport const total = () => quote();\n");
    });
    expect((await checkOrphans(diff, repo.dir, cls(), [], 'T001')).findings).toEqual([]);
  });

  it('a side-effect import of a code file is WARN unless the module registers itself at load', async () => {
    const repo = makeRepo({ 'src/app.ts': '' });
    repos.push(repo);
    const silent = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
      repo.write('src/app.ts', "import './lib/pricing';\nexport const run = () => 1;\n");
    });
    const warn = await checkOrphans(silent, repo.dir, cls(), [], 'T001');
    expect(warn.findings).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'warn', path: 'src/lib/pricing.ts' })]);
    expect(warn.findings[0].message).toMatch(/only imported for side effects .* nothing in it visibly registers itself/);

    const registering = await taskDiff(repo, () => {
      repo.write('src/lib/pricing.ts', "export class PriceTag extends HTMLElement {}\ncustomElements.define('price-tag', PriceTag);\n");
    });
    const info = await checkOrphans({ ...registering, files: registering.files.map((f) => ({ ...f, kind: 'added' as const })) }, repo.dir, cls(), [], 'T001');
    expect(info.findings).toEqual([expect.objectContaining({ severity: 'info', path: 'src/lib/pricing.ts' })]);
    expect(info.findings[0].message).toMatch(/registers itself at module load/);
  });

  it('pending-wiring re-check applies the same rule: an unused import does not fulfil the promise', async () => {
    const repo = makeRepo({ 'src/app.ts': '', 'src/lib/pricing.ts': 'export const quote = () => 1;\n' });
    repos.push(repo);
    const pending = [{ artifactPath: 'src/lib/pricing.ts', createdBy: 'T003', wiredBy: 'T005' }];
    const diff = await taskDiff(repo, () => repo.write('src/app.ts', "import { quote } from './lib/pricing';\nexport const run = () => 1;\n"));
    const res = await checkOrphans(diff, repo.dir, cls(), pending, 'T005');
    expect(res.resolvedPending).toEqual([]);
    expect(res.findings).toEqual([expect.objectContaining({ check: 'pending-wiring', severity: 'block', path: 'src/lib/pricing.ts' })]);
    expect(res.findings[0].message).toMatch(/imported by src\/app\.ts but no imported binding \(quote\) is used there/);
    repo.write('src/app.ts', "import { quote } from './lib/pricing';\nexport const run = () => quote();\n");
    const fixed = await checkOrphans(diff, repo.dir, cls(), pending, 'T005');
    expect(fixed.resolvedPending).toEqual(pending);
    expect(fixed.findings).toEqual([]);
  });
});

describe('refs helpers — import bindings, use detection, candidate narrowing', () => {
  it('importedBindings extracts local names and flags side-effect / re-export / dynamic forms', async () => {
    const { importedBindings, usedBeyondImport, stripImportStatements } = await import('../../src/audit/refs.js');
    const root = '/nonexistent';
    expect(importedBindings("import { a, b as c } from './x';\nimport D, * as ns from './x';\n", 'src/app.ts', 'src/x.ts', root)).toEqual({
      names: ['a', 'c', 'ns', 'D'],
      sideEffectOnly: false,
      reExport: false,
      dynamic: false,
    });
    expect(importedBindings("import './x';\n", 'src/app.ts', 'src/x.ts', root)).toMatchObject({ names: [], sideEffectOnly: true });
    expect(importedBindings("export { a } from './x';\n", 'src/app.ts', 'src/x.ts', root)).toMatchObject({ reExport: true });
    expect(importedBindings("const p = import('./x');\n", 'src/app.ts', 'src/x.ts', root)).toMatchObject({ dynamic: true });
    expect(importedBindings("const { a }: { a: number } = require('./x');\n", 'src/app.ts', 'src/x.ts', root)).toMatchObject({ names: ['a'] });
    expect(importedBindings("import { a } from './y';\n", 'src/app.ts', 'src/x.ts', root)).toBeUndefined();

    const src = "import { a, b } from './x';\nimport './side';\nexport { z } from './z';\nconst q = require('./q');\nconsole.log(a);\n";
    expect(stripImportStatements(src).split('\n')).toHaveLength(src.split('\n').length);
    expect(usedBeyondImport(src, 'a')).toBe(true);
    expect(usedBeyondImport(src, 'b')).toBe(false);
    expect(usedBeyondImport(src, 'q')).toBe(false);
    expect(usedBeyondImport('import * as ns from "./x";\nns.a();\n', 'ns')).toBe(true);
    expect(usedBeyondImport('import { a } from "./x";\nconst ab = 1;\n', 'a')).toBe(false);
  });

  it('narrows a too-wide candidate list to files with an import-shaped mention (short / generic basenames)', async () => {
    const { findFilesMentioningAny, findModuleReferences } = await import('../../src/audit/refs.js');
    const files: Record<string, string> = { 'src/lib/db.ts': 'export const db = 1;\n', 'src/app.ts': "import { db } from './lib/db';\nexport const run = () => db;\n" };
    // 60 files mention `db` on ordinary lines (comments / identifiers), none import the module
    for (let i = 0; i < 60; i++) files[`src/noise/n${i}.ts`] = `// db is popular\nconst db${i} = 1; export const v${i} = db${i};\nconst db = ${i};\n`;
    files['src/config/settings.json'] = '{"entry": "src/lib/db.ts"}';
    const repo = makeRepo(files);
    repos.push(repo);
    const narrowed = await findFilesMentioningAny(repo.dir, ['db'], { narrowAbove: 40, narrowNeedles: new Set(['db']) });
    const list = narrowed.get('db')!;
    expect(list).toContain('src/app.ts');
    expect(list).toContain('src/config/settings.json'); // non-code candidates are always kept
    expect(list.some((f) => f.startsWith('src/noise/'))).toBe(false);
    // not narrowable (Ruby constants / Vue tags style) → untouched
    const wide = await findFilesMentioningAny(repo.dir, ['db'], { narrowAbove: 40, narrowNeedles: new Set() });
    expect(wide.get('db')!.length).toBeGreaterThan(40);
    // end to end: the module is still found wired through src/app.ts
    expect((await findModuleReferences(repo.dir, 'src/lib/db.ts')).production).toEqual(['src/app.ts', 'src/config/settings.json']);
  });
});

describe('sanitizeForUse', () => {
  it('keeps template interpolations, confines strings to a line, and survives regex literals with stray quotes', async () => {
    const { sanitizeForUse, usedBeyondImport } = await import('../../src/audit/refs.js');
    const src = [
      "import { describe, other } from './x';",
      "const re = /['\"`]/g; // a regex with a stray backtick",
      'const label = `${describe(cls)} · depth=${depth}`;',
      "const s = 'other in a string';",
      '/** other in a doc comment */',
      'function f() {',
      '  return 1; // other in a line comment',
      '}',
    ].join('\n');
    const clean = sanitizeForUse(src, 'src/a.ts');
    expect(clean.split('\n')).toHaveLength(src.split('\n').length);
    expect(usedBeyondImport(clean, 'describe')).toBe(true); // used inside `${...}`
    expect(usedBeyondImport(clean, 'other')).toBe(false); // only in a string / comments
    expect(clean).toMatch(/from ' +';/); // quote delimiters survive so the import is still recognizable
  });
});
