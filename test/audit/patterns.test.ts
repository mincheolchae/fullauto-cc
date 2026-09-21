import { describe, expect, it } from 'vitest';
import { isCodeFile, isEntrypoint, isGateConfigFile, isTestFile } from '../../src/audit/patterns.js';

describe('isTestFile', () => {
  it.each([
    'test/foo.test.ts',
    'src/__tests__/foo.ts',
    'src/foo.spec.tsx',
    'src/foo.e2e.ts',
    'src/Button.stories.tsx',
    'e2e/login.ts',
    'cypress/support/index.js',
    'pkg/handler_test.go',
    'tests/test_x.py',
    'app/test_models.py',
    'app/models_test.py',
    'conftest.py',
    'spec/models/user_spec.rb',
    'tests/integration.rs',
    'src/__snapshots__/a.snap',
  ])('matches %s', (p) => expect(isTestFile(p)).toBe(true));

  it.each(['src/index.ts', 'src/testing-utils.ts', 'src/contest.ts', 'lib/latest.py', 'src/main.rs', 'src/protest/x.ts'])(
    'does not match %s',
    (p) => expect(isTestFile(p)).toBe(false)
  );
});

describe('isCodeFile', () => {
  it('accepts the CODE_EXT list', () => {
    for (const p of ['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.py', 'a.go', 'a.rs', 'a.java', 'a.kt', 'a.rb', 'a.php', 'a.cs', 'a.swift', 'a.vue', 'a.svelte', 'a.astro']) {
      expect(isCodeFile(`src/${p}`), p).toBe(true);
    }
  });
  it('rejects non-code', () => {
    for (const p of ['README.md', 'a.json', 'a.css', 'a.html', 'Makefile', 'a.yml', 'a']) expect(isCodeFile(p), p).toBe(false);
  });
});

describe('isGateConfigFile', () => {
  it.each([
    'package.json',
    'packages/web/package.json',
    'vitest.config.ts',
    'vite.config.mts',
    'jest.config.js',
    '.mocharc.yml',
    '.mocharc',
    'babel.config.cjs',
    'tsconfig.json',
    'tsconfig.build.json',
    '.eslintrc.cjs',
    '.eslintrc',
    'eslint.config.mjs',
    'biome.json',
    'biome.jsonc',
    'pytest.ini',
    'pyproject.toml',
    'setup.cfg',
    'tox.ini',
    'Makefile',
    'playwright.config.ts',
    'cypress.config.js',
    '.fullauto/config.json',
    '.fullauto/mcp.json',
    '.github/workflows/ci.yml',
  ])('matches %s', (p) => expect(isGateConfigFile(p)).toBe(true));

  it('skips go.mod and Cargo.toml (dependency manifests) and ordinary files', () => {
    for (const p of ['go.mod', 'Cargo.toml', 'src/index.ts', 'package-lock.json', 'src/config.json', 'README.md']) {
      expect(isGateConfigFile(p), p).toBe(false);
    }
  });
});

describe('isEntrypoint', () => {
  it.each([
    'app/page.tsx',
    'src/app/dashboard/page.tsx',
    'app/api/users/route.ts',
    'src/app/(auth)/login/layout.tsx',
    'app/not-found.tsx',
    'pages/index.tsx',
    'pages/api/hello.ts',
    'middleware.ts',
    'src/instrumentation.ts',
    'src/proxy.js',
    'index.ts',
    'src/index.ts',
    'src/cli.ts',
    'src/audit/index.ts',
    'server.js',
    'bin/run.js',
    'scripts/migrate.ts',
    'script/setup.sh',
    'prisma/migrations/20240101_init/migration.sql',
    'db/migrations/001.ts',
    'supabase/migrations/1.sql',
    'convex/users.ts',
    'src/types.d.ts',
    'vite.config.ts',
    'src/__mocks__/fs.ts',
    'stories/Button.tsx',
    'main.go',
    'cmd/server/main.go',
    'app/__init__.py',
    'manage.py',
    'config/wsgi.py',
    'config/asgi.py',
    'app/management/commands/seed.py',
    'src/main.rs',
    'src/lib.rs',
    'src/net/mod.rs',
    'build.rs',
    'app/routes/users.$id.tsx',
    'src/routes/about/+page.svelte',
    'src/routes/api/+server.ts',
    'src/hooks.server.ts',
    'composables/useAuth.ts',
    'layouts/default.vue',
    'server/api/hello.ts',
    'app/sitemap.ts',
    'api/hello.ts',
    'supabase/functions/hello/index.ts',
    'shop/models.py',
    'shop/admin.py',
    'config/settings/prod.py',
  ])('exempts %s', (p) => expect(isEntrypoint(p)).toBe(true));

  it.each([
    'src/components/Foo.tsx',
    'src/lib/pricing.ts',
    'src/features/auth/hooks/index.ts', // index deeper than 2 levels is NOT exempt
    'src/features/auth/server.ts',
    'app/components/Button.tsx',
    'app/utils.ts',
    'src/routes/users.ts',
    'pkg/handler.go',
    'app/views.py',
    'src/net/tcp.rs',
    'src/components/UserCard.vue',
    'src/api/client.ts',
  ])('does not exempt %s', (p) => expect(isEntrypoint(p)).toBe(false));
});
