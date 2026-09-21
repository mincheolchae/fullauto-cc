/**
 * Cross-verification of the audit heuristics against realistic project
 * shapes. Every scenario runs the full `runAudit` on a temp git repo and
 * asserts on BLOCK / WARN presence — a false BLOCK deadlocks an unattended
 * run, so "no BLOCK" assertions here are as important as the positive ones.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runAudit, takeSnapshot } from '../../src/audit/index.js';
import type { AuditFinding, AuditInput } from '../../src/audit/types.js';
import { auditInput, cls, gate, makeRepo, VITEST_PASS_4, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const blocks = (f: AuditFinding[]) => f.filter((x) => x.severity === 'block');
const warns = (f: AuditFinding[]) => f.filter((x) => x.severity === 'warn');

async function scenario(baseline: Record<string, string>, mutate: (repo: TempRepo) => void, over: Partial<AuditInput> = {}) {
  const repo = makeRepo(baseline);
  repos.push(repo);
  const before = await takeSnapshot(repo.dir);
  mutate(repo);
  const after = await takeSnapshot(repo.dir);
  return runAudit(auditInput(repo.dir, before, after, over));
}

const PKG = JSON.stringify({ name: 'x', scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' }, dependencies: { next: '15' } }, null, 2);
const TDD = 'FULLAUTO_TDD: red=1 green=2\n';
const withTests = { gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })], testBaseline: { runner: 'vitest' as const, passed: 1, failed: 0, skipped: 0, failingFiles: [] } };

describe('1. Next.js App Router', () => {
  it('route / page / layout / middleware / shadcn alias / barrel / css module / d.ts / next.config → no findings above INFO', async () => {
    const res = await scenario(
      {
        'package.json': PKG,
        'app/layout.tsx': 'export default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n',
        'app/page.tsx': 'export default function Home() { return <main/>; }\n',
        'components/index.ts': "export { Button } from './ui/button';\n",
        'components/ui/button.tsx': 'export function Button() { return <button/>; }\n',
        'test/app.test.tsx': "import Home from '../app/page';\nit('x', () => { expect(Home()).toBeTruthy(); });\n",
      },
      (repo) => {
        repo.write('app/api/users/route.ts', 'export async function GET() { return Response.json([]); }\n');
        repo.write(
          'app/(group)/dashboard/page.tsx',
          "import { Button } from '@/components/ui/button';\nimport { Card } from '@/components';\nimport styles from './page.module.css';\nexport default function Dashboard() { return <div className={styles.x}><Button/><Card/></div>; }\n"
        );
        repo.write('app/(group)/dashboard/page.module.css', '.x { color: red }\n');
        repo.write('middleware.ts', "import { NextResponse } from 'next/server';\nexport function middleware() { return NextResponse.next(); }\n");
        repo.write('components/ui/card.tsx', 'export function Card() { return <div/>; }\n');
        repo.write('components/index.ts', "export { Button } from './ui/button';\nexport { Card } from './ui/card';\n");
        repo.write('types/global.d.ts', 'declare module "*.module.css";\n');
        repo.write('next.config.mjs', 'export default { reactStrictMode: true };\n');
        repo.write('test/dashboard.test.tsx', "import Dashboard from '../app/(group)/dashboard/page';\nit('d', () => { expect(Dashboard()).toBeTruthy(); });\n");
      },
      { ...withTests, subagentStdout: `${TDD}FULLAUTO_WIRING:\n- components/ui/card.tsx#Card -> app/(group)/dashboard/page.tsx:2\n- app/api/users/route.ts -> (entrypoint: next.js route)\n` }
    );
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('a new component consumed only through a barrel resolves; one imported only by a test is BLOCKed', async () => {
    const base = {
      'package.json': PKG,
      'app/page.tsx': "import { Button } from '@/components';\nexport default function Home() { return <Button/>; }\n",
      'components/index.ts': "export { Button } from './ui/button';\n",
      'components/ui/button.tsx': 'export function Button() { return <button/>; }\n',
    };
    const ok = await scenario(
      base,
      (repo) => {
        repo.write('components/ui/badge.tsx', 'export function Badge() { return <span/>; }\n');
        repo.write('components/index.ts', "export { Button } from './ui/button';\nexport { Badge } from './ui/badge';\n");
        repo.write('app/page.tsx', "import { Button, Badge } from '@/components';\nexport default function Home() { return <><Button/><Badge/></>; }\n");
      },
      { classification: cls({ noTestReason: 'ui' }), subagentStdout: 'FULLAUTO_WIRING:\n- components/ui/badge.tsx#Badge -> app/page.tsx:1\n' }
    );
    expect(blocks(ok.findings)).toEqual([]);

    const bad = await scenario(
      base,
      (repo) => {
        repo.write('components/ui/badge.tsx', 'export function Badge() { return <span/>; }\n');
        repo.write('test/badge.test.tsx', "import { Badge } from '../components/ui/badge';\nit('b', () => { expect(Badge()).toBeTruthy(); });\n");
      },
      { classification: cls({ noTestReason: 'ui' }) }
    );
    expect(blocks(bad.findings)).toEqual([expect.objectContaining({ check: 'orphan-code', path: 'components/ui/badge.tsx' })]);
    expect(blocks(bad.findings)[0].message).toMatch(/only referenced from tests/);
  });

  it('a sub-component rendered by its sibling in the same file is wired through it', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'app/page.tsx': 'export default function Home() { return <main/>; }\n' },
      (repo) => {
        repo.write('components/panel.tsx', 'export function PanelHeader() { return <h1/>; }\nexport function Panel() { return <div><PanelHeader/></div>; }\n');
        repo.write('app/page.tsx', "import { Panel } from '@/components/panel';\nexport default function Home() { return <Panel/>; }\n");
      },
      { classification: cls({ noTestReason: 'ui' }) }
    );
    expect(blocks(res.findings)).toEqual([]);
  });

  it('React Router framework files, Astro content config and Rails convention dirs are entrypoints', async () => {
    const res = await scenario(
      { 'README.md': '' },
      (repo) => {
        repo.write('app/root.tsx', 'export default function Root() { return null; }\n');
        repo.write('app/routes.ts', 'export default [];\n');
        repo.write('app/entry.client.tsx', 'hydrateRoot();\n');
        repo.write('src/content/config.ts', 'export const collections = {};\n');
        repo.write('app/helpers/users_helper.rb', 'module UsersHelper; end\n');
        repo.write('db/migrate/20240101_create_users.rb', 'class CreateUsers < ActiveRecord::Migration[7.0]; end\n');
        repo.write('lib/tasks/seed.rake', 'task :seed\n');
        repo.write('config/initializers/cors.rb', 'Rails.application.config.x = 1\n');
      },
      { classification: cls({ noTestReason: 'x' }) }
    );
    expect(blocks(res.findings)).toEqual([]);
  });
});

describe('2. Express + vitest', () => {
  it('router mounted in app.ts, service used by the router, utils reached only via import() / require → clean', async () => {
    const res = await scenario(
      {
        'package.json': PKG,
        'src/index.ts': "import { app } from './app';\napp.listen(3000);\n",
        'src/app.ts': "import express from 'express';\nexport const app = express();\n",
        'test/api.e2e.test.ts': "import request from 'supertest';\nimport { app } from '../src/app';\nit('GET /', async () => { await request(app).get('/').expect(200); });\n",
      },
      (repo) => {
        repo.write('src/routes/users.ts', "import { Router } from 'express';\nimport { price } from '../services/pricing';\nexport const usersRouter = Router();\nusersRouter.get('/', (req, res) => res.json({ p: price(1) }));\n");
        repo.write('src/services/pricing.ts', 'export function price(n: number) { return n * 2; }\n');
        repo.write('src/lib/utils.ts', 'export function slug(s: string) { return s.toLowerCase(); }\n');
        repo.write('src/lib/legacy.cjs', 'module.exports = { legacy: () => 1 };\n');
        repo.write(
          'src/app.ts',
          "import express from 'express';\nimport { usersRouter } from './routes/users';\nexport const app = express();\napp.use('/users', usersRouter);\napp.get('/slug', async (req, res) => { const { slug } = await import('./lib/utils'); const { legacy } = require('./lib/legacy.cjs'); res.send(slug('X') + legacy()); });\n"
        );
        repo.write('test/users.test.ts', "import request from 'supertest';\nimport { app } from '../src/app';\nit('GET /users', async () => { const r = await request(app).get('/users'); expect(r.body.p).toBe(2); });\n");
      },
      { ...withTests, subagentStdout: `${TDD}FULLAUTO_WIRING:\n- src/routes/users.ts#usersRouter -> src/app.ts:2\n- src/services/pricing.ts#price -> src/routes/users.ts:2\n- src/lib/utils.ts#slug -> src/app.ts:5\n` }
    );
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('a workspace package (symlinked into node_modules) is a wiring target, a real dependency is not', async () => {
    const res = await scenario(
      {
        'package.json': JSON.stringify({ name: 'mono', workspaces: ['packages/*', 'apps/*'], scripts: { test: 'vitest run' } }),
        'packages/ui/package.json': '{"name":"@acme/ui","main":"src/index.ts"}',
        'packages/ui/src/index.ts': 'export {};\n',
        'apps/web/app/page.tsx': 'export default function P() { return null; }\n',
        'node_modules/zod/index.js': 'module.exports = {};\n',
      },
      (repo) => {
        repo.git('config', 'core.quotepath', 'true');
        repo.write('node_modules/@acme/.keep', '');
        require('node:fs').symlinkSync('../../packages/ui', require('node:path').join(repo.dir, 'node_modules/@acme/ui'));
        repo.write('packages/ui/src/button.tsx', 'export function Button() { return <button/>; }\n');
        repo.write('packages/ui/src/index.ts', "export { Button } from './button';\n");
        repo.write('apps/web/app/page.tsx', "import { Button } from '@acme/ui';\nimport { z } from 'zod';\nexport default function P() { z; return <Button/>; }\n");
        repo.write('apps/web/lib/zod.ts', 'export const z = 1;\n'); // a local module named like a real package is NOT what `from "zod"` resolves to
      },
      { classification: cls({ noTestReason: 'x' }) }
    );
    expect(blocks(res.findings).map((f) => f.path)).toEqual(['apps/web/lib/zod.ts']);
  });
});

describe('3. FastAPI + pytest', () => {
  it('router included via app.include_router, service imported relatively and absolutely, tests / alembic / conftest → clean', async () => {
    const res = await scenario(
      {
        'pyproject.toml': '[project]\nname = "x"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        'app/__init__.py': '',
        'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n',
        'tests/conftest.py': 'import pytest\n',
      },
      (repo) => {
        repo.write('app/routers/__init__.py', '');
        repo.write('app/routers/users.py', "from fastapi import APIRouter\nfrom ..services import pricing\nrouter = APIRouter()\n@router.get('/')\ndef list_users():\n    return pricing.quote(1)\n");
        repo.write('app/services/__init__.py', '');
        repo.write('app/services/pricing.py', 'def quote(n):\n    return n * 2\n');
        repo.write('app/services/tax.py', 'def tax(n):\n    return n * 0.1\n');
        repo.write('app/main.py', "from fastapi import FastAPI\nfrom app.routers import users\nfrom app.services.tax import tax\napp = FastAPI()\napp.include_router(users.router, prefix='/users')\n");
        repo.write('tests/test_users.py', "from fastapi.testclient import TestClient\nfrom app.main import app\n\ndef test_list_users():\n    c = TestClient(app)\n    assert c.get('/users/').status_code == 200\n\ndef test_raises():\n    with pytest.raises(ValueError):\n        quote('x')\n");
        repo.write('tests/conftest.py', 'import pytest\n\n@pytest.fixture\ndef client():\n    from app.main import app\n    return app\n');
        repo.write('alembic/versions/0001_init.py', "revision = '0001'\ndef upgrade():\n    pass\n");
        repo.write('shop/tests.py', 'from django.test import TestCase\nclass T(TestCase):\n    def test_x(self):\n        self.assertTrue(True)\n');
      },
      {
        gateResults: [gate({ name: 'pytest', passed: true, output: '============ 3 passed in 0.12s ============' })],
        testBaseline: { runner: 'pytest', passed: 1, failed: 0, skipped: 0, failingFiles: [] },
        subagentStdout: `${TDD}FULLAUTO_WIRING:\n- app/routers/users.py#router -> app/main.py:5\n- app/services/pricing.py#quote -> app/routers/users.py:6\n`,
      }
    );
    expect(blocks(res.findings)).toEqual([]);
    expect(warns(res.findings)).toEqual([]);
    // conftest.py changed by an impl task is a helper edit, surfaced as INFO only
    expect(res.findings.find((f) => f.path === 'tests/conftest.py')).toMatchObject({ severity: 'info' });
  });
});

describe('4/5. Convex and Go', () => {
  it('convex functions (name-addressed), _generated and Go packages produce no findings', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'go.mod': 'module x\n', 'convex/schema.ts': 'export default defineSchema({});\n' },
      (repo) => {
        repo.write('convex/users.ts', "import { query } from './_generated/server';\nexport const list = query({ handler: async () => [] });\n");
        repo.write('convex/schema.ts', 'export default defineSchema({ users: defineTable({}) });\n');
        repo.write('convex/_generated/api.d.ts', 'export declare const api: any;\n');
        repo.write('convex/_generated/server.js', 'export const query = (x) => x;\n');
        repo.write('internal/foo/foo.go', 'package foo\nfunc Foo() int { return 1 }\n');
        repo.write('internal/foo/foo_test.go', 'package foo\nimport "testing"\nfunc TestFoo(t *testing.T) { if Foo() != 1 { t.Errorf("x") } }\n');
        repo.write('go.mod', 'module x\ngo 1.22\n');
      },
      { classification: cls({ noTestReason: 'x' }), subagentStdout: 'FULLAUTO_WIRING:\n- convex/users.ts -> (entrypoint: convex function)\n' }
    );
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });
});

describe('6. Gate config', () => {
  const noTest = { classification: cls({ noTestReason: 'x' }) };
  it('config task: adding vitest.config.ts and a tsconfig paths alias is allowed', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "strict": true, },\n}\n' },
      (repo) => {
        repo.write('vitest.config.ts', "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n");
        repo.write('tsconfig.json', '{\n  "compilerOptions": { "strict": true, "paths": { "@/*": ["./src/*"] } }\n}\n');
      },
      { classification: cls({ kind: 'config' }) }
    );
    expect(res.findings.filter((f) => f.severity !== 'info')).toEqual([]);
  });

  it('impl task: tsconfig paths / jsx / lib edits WARN, strictness or include/exclude edits BLOCK', async () => {
    const base = { 'package.json': PKG, 'src/a.ts': '', 'tsconfig.json': '{ "compilerOptions": { "strict": true, "jsx": "preserve" }, "include": ["src"] }' };
    const soft = await scenario(base, (repo) => repo.write('tsconfig.json', '{ "compilerOptions": { "strict": true, "jsx": "react-jsx", "paths": { "@/*": ["./*"] }, "lib": ["dom"] }, "include": ["src"] }'), noTest);
    expect(blocks(soft.findings)).toEqual([]);
    expect(warns(soft.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: 'tsconfig.json' })]);
    expect(warns(soft.findings)[0].message).toContain('compilerOptions.jsx');

    const hard = await scenario(base, (repo) => repo.write('tsconfig.json', '{ "compilerOptions": { "strict": false, "jsx": "preserve" }, "include": ["src"], "exclude": ["src/legacy"] }'), noTest);
    expect(blocks(hard.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: 'tsconfig.json' })]);
    expect(blocks(hard.findings)[0].message).toMatch(/compilerOptions\.strict/);
    expect(blocks(hard.findings)[0].message).toMatch(/exclude/);
  });

  it('impl task: package.json dependencies-only edit is silent; scripts.test edit BLOCKs', async () => {
    const deps = await scenario({ 'package.json': PKG, 'src/a.ts': '' }, (repo) => repo.write('package.json', PKG.replace('"next": "15"', '"next": "15", "zod": "3"')), noTest);
    expect(deps.findings.filter((f) => f.check === 'gate-integrity')).toEqual([]);
    const script = await scenario({ 'package.json': PKG, 'src/a.ts': '' }, (repo) => repo.write('package.json', PKG.replace('vitest run', 'vitest run --reporter=dot')), noTest);
    expect(blocks(script.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: 'package.json' })]);
  });

  it('impl task: vitest.config plugin/alias edit WARNs, include/exclude edit BLOCKs', async () => {
    const cfg = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  plugins: [],\n  test: { include: ['test/**/*.test.ts'] },\n});\n";
    const base = { 'package.json': PKG, 'src/a.ts': '', 'vitest.config.ts': cfg };
    const soft = await scenario(base, (repo) => repo.write('vitest.config.ts', cfg.replace('plugins: [],', "plugins: [react()],\n  resolve: { alias: { '@': '/src' } },")), noTest);
    expect(blocks(soft.findings)).toEqual([]);
    expect(warns(soft.findings).some((f) => f.check === 'gate-integrity' && /none touching test scoping/.test(f.message))).toBe(true);
    const hard = await scenario(base, (repo) => repo.write('vitest.config.ts', cfg.replace("include: ['test/**/*.test.ts']", "include: ['test/unit/**/*.test.ts'], passWithNoTests: true")), noTest);
    expect(blocks(hard.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: 'vitest.config.ts' })]);
    expect(blocks(hard.findings)[0].message).toMatch(/test-scoping lines changed/);
  });

  it('impl task: a CI workflow change is WARN (not a gate the orchestrator runs); Makefile BLOCKs only when a gate uses make', async () => {
    const ci = await scenario({ 'package.json': PKG, '.github/workflows/ci.yml': 'on: push\njobs: {}\n', 'src/a.ts': '' }, (repo) => repo.write('.github/workflows/ci.yml', 'on: [push, pull_request]\njobs: {}\n'), noTest);
    expect(blocks(ci.findings)).toEqual([]);
    expect(warns(ci.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: '.github/workflows/ci.yml' })]);

    const mkBase = { 'package.json': PKG, Makefile: 'test:\n\tvitest run\n', 'src/a.ts': '' };
    const noMake = await scenario(mkBase, (repo) => repo.write('Makefile', 'test:\n\tvitest run\nmigrate:\n\tnpx prisma migrate\n'), { ...noTest, gateResults: [gate({ name: 'test', command: 'npm test' })] });
    expect(blocks(noMake.findings)).toEqual([]);
    expect(warns(noMake.findings)).toEqual([expect.objectContaining({ path: 'Makefile' })]);
    const usesMake = await scenario(mkBase, (repo) => repo.write('Makefile', 'test:\n\ttrue\n'), { ...noTest, gateResults: [gate({ name: 'test', command: 'make test' })] });
    expect(blocks(usesMake.findings)).toEqual([expect.objectContaining({ path: 'Makefile' })]);
    // manual `fullauto audit` (no gate results): status quo, BLOCK
    const manual = await scenario(mkBase, (repo) => repo.write('Makefile', 'test:\n\ttrue\n'), noTest);
    expect(blocks(manual.findings)).toEqual([expect.objectContaining({ path: 'Makefile' })]);
  });

  it('impl task adding a vitest.config.ts without a marker is a WARN, never a BLOCK', async () => {
    const res = await scenario({ 'package.json': PKG, 'src/a.ts': '' }, (repo) => repo.write('vitest.config.ts', 'export default {};\n'), noTest);
    expect(blocks(res.findings)).toEqual([]);
    expect(warns(res.findings)).toEqual([expect.objectContaining({ check: 'gate-integrity', path: 'vitest.config.ts' })]);
  });
});

describe('8/9. test-count with diff and wiring claims end-to-end', () => {
  it('behavior task that changed only docs/tests with no new passing test → WARN, not BLOCK', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'src/a.ts': 'export const a = 1;\n', 'README.md': '' },
      (repo) => repo.write('README.md', '# changed\n'),
      { gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })], testBaseline: { runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] } }
    );
    expect(blocks(res.findings)).toEqual([]);
    expect(warns(res.findings).some((f) => f.check === 'test-count' && /no new tests/.test(f.message))).toBe(true);
  });

  it('behavior task that changed production code with no new passing test → BLOCK (unchanged)', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'src/a.ts': 'export const a = 1;\n', 'src/index.ts': "import { a } from './a';\na;\n" },
      (repo) => repo.write('src/a.ts', 'export const a = 2;\n'),
      { gateResults: [gate({ name: 'test', passed: true, output: VITEST_PASS_4 })], testBaseline: { runner: 'vitest', passed: 4, failed: 0, skipped: 0, failingFiles: [] } }
    );
    expect(blocks(res.findings)).toEqual([expect.objectContaining({ check: 'test-count' })]);
  });

  it('wiring claim: alias import satisfies a symbol claim; a same-basename different module does not satisfy a module claim', async () => {
    const res = await scenario(
      {
        'package.json': PKG,
        'src/app/page.tsx': 'export default function P() { return null; }\n',
        'src/other/pricing.ts': 'export function priceOther() {}\n',
        'src/routes/checkout.ts': "import { priceOther } from '../other/pricing';\npriceOther();\n",
      },
      (repo) => {
        repo.write('src/components/ui/button.tsx', 'export function Button() { return null; }\n');
        repo.write('src/app/page.tsx', "import { Button } from '@/components/ui/button';\nexport default function P() { return <Button/>; }\n");
        repo.write('src/lib/pricing.ts', 'export function price() {}\n');
        repo.write('src/routes/checkout.ts', "import { priceOther } from '../other/pricing';\nimport { price } from '@/lib/pricing';\npriceOther(); price();\n");
      },
      {
        classification: cls({ noTestReason: 'x' }),
        subagentStdout: [
          'FULLAUTO_WIRING:',
          '- src/components/ui/button.tsx#Button -> src/app/page.tsx:1',
          '- src/lib/pricing.ts -> src/routes/checkout.ts:2 (via alias)',
          '- src/lib/pricing.ts#price -> src/routes/checkout.ts — imported at top',
          '- src/lib/legacy.ts -> (wired by T005)',
        ].join('\n'),
      }
    );
    expect(blocks(res.findings)).toEqual([]);
    // Now the same module-level claim against a consumer that only imports the OTHER pricing module.
    const bad = await scenario(
      { 'package.json': PKG, 'src/other/pricing.ts': 'export function priceOther() {}\n', 'src/routes/checkout.ts': "import { priceOther } from '../other/pricing';\npriceOther();\n", 'src/index.ts': "import './lib/pricing';\n" },
      (repo) => repo.write('src/lib/pricing.ts', 'export function price() {}\n'),
      { classification: cls({ noTestReason: 'x' }), subagentStdout: 'FULLAUTO_WIRING:\n- src/lib/pricing.ts -> src/routes/checkout.ts\n' }
    );
    expect(blocks(bad.findings)).toEqual([expect.objectContaining({ check: 'wiring-manifest', path: 'src/routes/checkout.ts' })]);
    expect(blocks(bad.findings)[0].message).toMatch(/does not import it/);
  });
});

describe('10. unused-export noise', () => {
  it('same-file usage counts as used; constants / schemas / enums are INFO; a truly unused function is WARN; orphaned files get no per-symbol noise', async () => {
    const res = await scenario(
      { 'package.json': PKG, 'src/app.ts': "import { a } from './lib/a';\na();\n", 'src/lib/a.ts': 'export const a = () => 1;\n' },
      (repo) => {
        repo.write(
          'src/lib/a.ts',
          "import { z } from 'zod';\nexport const a = () => helper();\nexport const helper = () => 1;\nexport const DEFAULT_LIMIT = 10;\nexport const userSchema = z.object({ n: z.number() });\nexport type User = z.infer<typeof userSchema>;\nexport function b() { return DEFAULT_LIMIT; }\nexport enum Color { Red }\nexport const orderSchema = z.object({});\nexport const MAX = 3;\n"
        );
        repo.write('src/lib/b.ts', 'export const unusedB = () => 3;\nexport const fromB = () => 2;\n');
        repo.write('src/app.ts', "import { a, b } from './lib/a';\nimport { fromB } from './lib/b';\na(); b(); fromB();\n");
        repo.write('src/lib/orphan.ts', 'export const x = 1;\nexport function y() {}\n');
      },
      { classification: cls({ noTestReason: 'x' }) }
    );
    const byPath = (p: string) => res.findings.filter((f) => f.path === p);
    expect(byPath('src/lib/a.ts')).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'info' })]);
    expect(byPath('src/lib/a.ts')[0].message).toMatch(/Color, orderSchema, MAX/);
    expect(byPath('src/lib/b.ts')).toEqual([expect.objectContaining({ check: 'unused-export', severity: 'warn' })]);
    expect(byPath('src/lib/b.ts')[0].message).toContain('unusedB');
    expect(byPath('src/lib/orphan.ts')).toEqual([expect.objectContaining({ check: 'orphan-code', severity: 'block' })]);
  });
});

describe('11. performance and path safety', () => {
  it('audits a ~3000-file repo with 11 added modules in well under 5s', async () => {
    const files: Record<string, string> = { 'package.json': PKG };
    for (let i = 0; i < 3000; i++) {
      files[`src/mod${i % 60}/file${i}.ts`] = `import { f${(i + 1) % 3000} } from '../mod${(i + 1) % 60}/file${(i + 1) % 3000}';\nexport function f${i}() { return f${(i + 1) % 3000}(); }\nexport const C${i} = ${i};\n// ${'x'.repeat(200)}\n`;
    }
    const repo = makeRepo(files);
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    for (let j = 0; j < 10; j++) {
      repo.write(`src/new/svc${j}.ts`, `export function svc${j}() { return 1; }\nexport function helper${j}() { return svc${j}(); }\nexport const LIMIT_${j} = 1;\n`);
      if (j < 8) repo.write(`src/mod${j}/file${j}.ts`, `${files[`src/mod${j}/file${j}.ts`]}import { svc${j} } from '../new/svc${j}';\nsvc${j}();\n`);
    }
    repo.write('src/components/Panel.tsx', 'export function Panel() { return <div/>; }\n');
    repo.write('src/mod20/file20.ts', `${files['src/mod20/file20.ts']}import { Panel } from '../components/Panel';\nPanel;\n`);
    const after = await takeSnapshot(repo.dir);
    const t0 = Date.now();
    const res = await runAudit(auditInput(repo.dir, before, after, { classification: cls({ noTestReason: 'perf' }), subagentStdout: 'FULLAUTO_WIRING:\n- src/new/svc0.ts#svc0 -> src/mod0/file0.ts\n' }));
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5000);
    expect(blocks(res.findings).map((f) => f.path).sort()).toEqual(['src/new/svc8.ts', 'src/new/svc9.ts']);
  });

  it('consumers with spaces, unicode, $ and backticks in their path are found (core.quotepath=true) and never reach a shell', async () => {
    const repo = makeRepo({ 'package.json': PKG, 'src/index.ts': '' });
    repos.push(repo);
    repo.git('config', 'core.quotepath', 'true');
    const before = await takeSnapshot(repo.dir);
    repo.write('src/lib/pricing.ts', 'export const quote = () => 1;\n');
    repo.write('src/lib/tax.ts', 'export const tax = () => 1;\n');
    repo.write('src/lib/fee.ts', 'export const fee = () => 1;\n');
    repo.write('src/pages/café menu.ts', "import { quote } from '../lib/pricing';\nquote();\n");
    repo.write('src/pages/$price`d`.ts', "import { tax } from '../lib/tax';\ntax();\n");
    repo.write("src/pages/it's (v2).ts", "import { fee } from '../lib/fee';\nfee();\n");
    const after = await takeSnapshot(repo.dir);
    const res = await runAudit(auditInput(repo.dir, before, after, { classification: cls({ noTestReason: 'x' }) }));
    expect(blocks(res.findings)).toEqual([]);
  });
});
