/**
 * Path classifiers shared by every audit check.
 *
 * All matchers take a repo-relative POSIX path (forward slashes, no leading
 * `./`). They are deliberately regex-only so they are cheap and trivially
 * unit-testable; anything needing file contents lives in the check modules.
 */

import { normalizePath } from './test-output.js';

const TEST_FILE_PATTERNS: RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright|__snapshots__)\//,
  // Test-support directories: anything living here is reachable from tests only by design
  // (MSW handlers, fixtures, factories, Angular `testing/` modules, `__fixtures__`, `__mocks__`).
  /(^|\/)(__mocks__|mocks|__fixtures__|fixtures|testing|test-utils|test_utils|testutils|test-helpers|test_helpers)\//,
  /\.(test|spec|e2e|stories|story|fixture|fixtures|mock|mocks|stub)\.[cm]?[jt]sx?$/,
  // Well-known test bootstrap / helper modules that live outside test dirs (CRA, RTL, vitest/jest setup files).
  /(^|\/)(setupTests|setup-tests|test-utils|testUtils|test-helpers|testHelpers|vitest\.setup|jest\.setup|test\.setup)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)tests?\.py$/, // Django default `app/tests.py`
  /(^|\/)conftest\.py$/,
  /_spec\.rb$/,
  /(^|\/)tests?\/.*\.rs$/,
];

export const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'swift',
  'vue', 'svelte', 'astro',
]);

/** Extensions that resolve through JS-style `import ... from` / `require()`. */
export const JS_LIKE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro']);

const GATE_CONFIG_PATTERNS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)vitest\.config\.[^/]+$/,
  /(^|\/)vitest\.workspace\.[^/]+$/,
  /(^|\/)vite\.config\.[^/]+$/,
  /(^|\/)jest\.config\.[^/]+$/,
  /(^|\/)\.mocharc[^/]*$/,
  /(^|\/)babel\.config\.[^/]+$/,
  /(^|\/)\.babelrc[^/]*$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.eslintrc[^/]*$/,
  /(^|\/)eslint\.config\.[^/]+$/,
  /(^|\/)biome\.json[^/]*$/,
  /(^|\/)pytest\.ini$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)setup\.cfg$/,
  /(^|\/)tox\.ini$/,
  /(^|\/)Makefile$/,
  /(^|\/)playwright\.config\.[^/]+$/,
  /(^|\/)cypress\.config\.[^/]+$/,
  /(^|\/)\.fullauto\/config\.json$/,
  /(^|\/)\.fullauto\/mcp\.json$/,
  /(^|\/)\.github\/workflows\/[^/]+$/,
];

/** Listed in the spec as gate-config but explicitly skipped (dependency manifests). */
const GATE_CONFIG_SKIP: RegExp[] = [/(^|\/)go\.mod$/, /(^|\/)Cargo\.toml$/];

const ENTRYPOINT_PATTERNS: RegExp[] = [
  /(^|\/)app\/(?:.*\/)?(page|layout|route|loading|error|not-found|template|default|middleware|proxy)\.[jt]sx?$/,
  /(^|\/)pages\//,
  /(^|\/)(middleware|instrumentation|proxy)\.[jt]s$/,
  /(^|\/)bin\//,
  /(^|\/)scripts?\//,
  /(^|\/)(migrations?|alembic\/versions|prisma\/migrations|supabase\/migrations)\//,
  /(^|\/)convex\//,
  /\.d\.ts$/,
  /\.config\.[cm]?[jt]s$/,
  /(^|\/)__mocks__\//,
  /(^|\/)(stories|storybook)\//,
  /(^|\/)main\.go$/,
  /(^|\/)cmd\//,
  /(^|\/)__init__\.py$/,
  /(^|\/)manage\.py$/,
  /(^|\/)wsgi\.py$/,
  /(^|\/)asgi\.py$/,
  /(^|\/)management\/commands\//,
  /(^|\/)src\/(main|lib)\.rs$/,
  /(^|\/)mod\.rs$/,
  /(^|\/)build\.rs$/,
  // Framework file-based discovery (no explicit import exists by design):
  /(^|\/)app\/routes\//, // Remix / React Router file routes
  /(^|\/)routes\/.*\+(page|layout|server|error)(\.server)?\.(ts|js|svelte)$/, // SvelteKit
  /(^|\/)src\/hooks\.(server|client)\.[jt]s$/, // SvelteKit hooks
  /(^|\/)(layouts|plugins|composables|middleware)\/[^/]+\.(vue|[jt]s)$/, // Nuxt auto-discovery
  /(^|\/)server\/(api|routes|middleware|plugins)\//, // Nuxt / Nitro server routes
  /(^|\/)app\/(?:.*\/)?(actions|opengraph-image|twitter-image|sitemap|robots|manifest|icon|apple-icon)\.[jt]sx?$/, // Next.js special files
  /^api\/.*\.[jt]s$/, // Vercel serverless functions
  /(^|\/)(netlify|supabase)\/functions\//, // Netlify / Supabase edge functions
  /(^|\/)functions\/(src\/)?index\.[jt]s$/, // Firebase functions entry
  /(^|\/)(models|admin|apps|tasks|settings|celery|signals)\.py$/, // Django / Celery autodiscovery
  /(^|\/)settings\/[^/]+\.py$/, // Django split settings
  /(^|\/)app\/(root|routes|entry\.client|entry\.server)\.[jt]sx?$/, // React Router v7 / Remix framework files
  /(^|\/)(content\/config|content\.config)\.[jt]s$/, // Astro content collections
  /(^|\/)app\/(helpers|views|channels)\//, // Rails autoloaded / convention-wired
  /(^|\/)(config\/initializers|db\/migrate|lib\/tasks)\//, // Rails boot-time discovery
  /(^|\/)\.storybook\//,
];

/**
 * Directories whose contents are generated, vendored or orchestrator state:
 * never audited as artifacts and never searched as consumers.
 */
export const GENERATED_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage',
  'target', 'vendor', 'venv', '.venv', '__pycache__', '.cache', '.turbo', '.output', '.fullauto',
]);

/** True when any path segment is a generated / vendored / state directory. */
export function isGeneratedPath(path: string): boolean {
  const parts = normalizePath(path).split('/');
  return parts.slice(0, -1).some((seg) => GENERATED_DIRS.has(seg));
}

/** `index|main|cli|server|app.<js-ext>` is only exempt when shallow (≤ 2 directory levels). */
const SHALLOW_ENTRYPOINT = /(^|\/)(index|main|cli|server|app)\.[cm]?[jt]sx?$/;

/** Re-exported from `test-output.ts` (the single shared normalizer; see there). */
export { normalizePath } from './test-output.js';

export function extensionOf(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Basename without its (last) extension: `src/a/Foo.test.tsx` → `Foo.test`. */
export function basenameSansExt(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Path without its extension: `src/a/Foo.tsx` → `src/a/Foo`. */
export function stripExt(p: string): string {
  const slash = p.lastIndexOf('/');
  const dot = p.lastIndexOf('.');
  return dot > slash + 1 ? p.slice(0, dot) : p;
}

export function isTestFile(path: string): boolean {
  const p = normalizePath(path);
  return TEST_FILE_PATTERNS.some((re) => re.test(p));
}

export function isCodeFile(path: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(normalizePath(path)));
}

export function isJsLike(path: string): boolean {
  return JS_LIKE_EXTENSIONS.has(extensionOf(normalizePath(path)));
}

export function isGateConfigFile(path: string): boolean {
  const p = normalizePath(path);
  if (GATE_CONFIG_SKIP.some((re) => re.test(p))) return false;
  return GATE_CONFIG_PATTERNS.some((re) => re.test(p));
}

export function isEntrypoint(path: string): boolean {
  const p = normalizePath(path);
  if (ENTRYPOINT_PATTERNS.some((re) => re.test(p))) return true;
  if (SHALLOW_ENTRYPOINT.test(p)) {
    const depth = p.split('/').length - 1; // number of directory levels
    if (depth <= 2) return true;
  }
  return false;
}
