/**
 * "Does it survive a real unattended run" scenarios against the SHIPPED CLI
 * (`dist/cli.js` compiled once into a temp dir), not the in-process
 * orchestrator. The project under test is a tiny Node ESM HTTP app with a
 * real `node --test` gate; the fake `claude` (test/helpers/fake-claude.ts)
 * is driven by column-0 `FAKE:` lines in a speckit-style tasks.md.
 *
 *   (a) speckit tasks.md end to end: [USx] labels, [P], marker sub-bullets,
 *       a red/green pair, a `- wired by:` pair, config + docs tasks and a
 *       cheating `.skip` task → every task terminal, the cheat is blocked by
 *       the audit AND rolled back (patch saved), exit 1, state.json / logs /
 *       .gitignore are in place, `status` re-renders, `audit --json` sees a
 *       clean tree; then `fullauto retry T007` re-runs it to done (exit 0)
 *   (b) SIGTERM to the CLI's process group mid-task → exit 143, the
 *       on-disk state holds the task in_progress with its unfinished
 *       attempt (`interrupted by signal`) + pre-task baseline;
 *       `.fullauto/config.json` edited in between (a failing gate added,
 *       then removed) is picked up by `resume`, which converges
 *   (c) TDD red quarantine while sibling tasks run; a sibling that breaks a
 *       pre-existing test is deferred with gate_failed, its damage is
 *       rolled back so the green task still completes, the retry prompt
 *       points at the patch; with `rollbackOnDefer: false` the damage
 *       cascades (documented)
 *   (d) plan mistakes: `- tests:` pointing at a nonexistent task is
 *       rejected by the validator; a red task with no green partner,
 *       `- wired by:` a task that already finished, cyclic wiring
 *       promises, a task deleting a test file → the run ends with clear
 *       reasons, report sections and exit 1
 *   (e) SIGTERM to the CLI pid ONLY (a supervisor kill, V2's crash.sh): the
 *       subagent's whole process group dies within the grace period, the
 *       attempt is marked interrupted, `resume` finishes the run
 *   (f) `fullauto audit` in a plain directory: "Audit skipped", exit 0
 *
 * Budget: the whole file runs in well under 60s (one gate, ~0.3s/attempt).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { RunState, Task } from '../../src/types.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, makeTmpDir, cleanup, git } from '../helpers/tmp.js';

const execFileAsync = promisify(execFile);

let fake: FakeClaude;
let distDir: string;
let cli: string;
let projectDir: string;

/** A single, cheap test gate (no npm wrapper) so each attempt costs ~0.3s. */
const TEST_GATE = {
  type: 'shell',
  name: 'test',
  role: 'test',
  command: "node --test --test-reporter=tap 'test/**/*.test.mjs'",
};

const APP_MJS = [
  "import http from 'node:http';",
  "import { createRouter } from './router.mjs';",
  "import { registerUserRoutes, sendJson } from './routes/users.mjs';",
  '',
  'export function createApp() {',
  '  const router = createRouter();',
  "  router.get('/health', (req, res) => sendJson(res, 200, { ok: true }));",
  '  registerUserRoutes(router);',
  '  const server = http.createServer((req, res) => {',
  "    const m = router.match(req.method ?? 'GET', req.url ?? '/');",
  "    if (!m) return sendJson(res, 404, { error: 'no route' });",
  '    return m.handler(req, res, m.params);',
  '  });',
  '  return { server, router };',
  '}',
  '',
  'export function listen(port = 0) {',
  '  const { server } = createApp();',
  '  return new Promise((resolve) => {',
  "    server.listen(port, '127.0.0.1', () => {",
  '      const addr = server.address();',
  "      const p = typeof addr === 'object' && addr ? addr.port : port;",
  "      resolve({ url: 'http://127.0.0.1:' + p, close: () => new Promise((r) => server.close(() => r(undefined))) });",
  '    });',
  '  });',
  '}',
  '',
].join('\n');

const ROUTER_MJS = [
  'export function createRouter() {',
  '  const routes = [];',
  '  const api = {',
  '    add(method, path, handler) { routes.push({ method, path, handler }); return api; },',
  "    get(path, handler) { return api.add('GET', path, handler); },",
  "    post(path, handler) { return api.add('POST', path, handler); },",
  '    match(method, url) {',
  "      const path = url.split('?')[0];",
  '      for (const r of routes) {',
  '        if (r.method !== method) continue;',
  '        const params = matchPath(r.path, path);',
  '        if (params) return { handler: r.handler, params };',
  '      }',
  '      return null;',
  '    },',
  '  };',
  '  return api;',
  '}',
  '',
  'export function matchPath(pattern, path) {',
  "  const a = pattern.split('/').filter(Boolean);",
  "  const b = path.split('/').filter(Boolean);",
  '  if (a.length !== b.length) return null;',
  '  const params = {};',
  '  for (let i = 0; i < a.length; i++) {',
  "    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);",
  '    else if (a[i] !== b[i]) return null;',
  '  }',
  '  return params;',
  '}',
  '',
].join('\n');

const USERS_ROUTE_MJS = [
  "import { USERS } from '../store/users.mjs';",
  '',
  'export function registerUserRoutes(router) {',
  "  router.get('/users/:id', (req, res, params) => {",
  '    const user = USERS.find((u) => u.id === params.id);',
  "    if (!user) return sendJson(res, 404, { error: 'not found' });",
  '    return sendJson(res, 200, user);',
  '  });',
  '}',
  '',
  'export function sendJson(res, status, body) {',
  "  res.writeHead(status, { 'content-type': 'application/json' });",
  '  res.end(JSON.stringify(body));',
  '}',
  '',
].join('\n');

const BASELINE_FILES: Record<string, string> = {
  '.gitignore': '.fullauto/\n',
  'package.json': JSON.stringify({ name: 'users-api-sample', version: '0.1.0', private: true, type: 'module' }, null, 2) + '\n',
  'README.md': '# users-api-sample\n',
  'src/app.mjs': APP_MJS,
  'src/router.mjs': ROUTER_MJS,
  'src/routes/users.mjs': USERS_ROUTE_MJS,
  'src/store/users.mjs': "export const USERS = [\n  { id: '1', name: 'Ada' },\n  { id: '2', name: 'Linus' },\n];\n",
  'test/router.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { createRouter, matchPath } from '../src/router.mjs';",
    "test('matchPath extracts params', () => {",
    "  assert.deepEqual(matchPath('/users/:id', '/users/42'), { id: '42' });",
    "  assert.equal(matchPath('/users/:id', '/posts/42'), null);",
    '});',
    "test('router matches method + path', () => {",
    "  const r = createRouter().get('/a', () => 'A').post('/a', () => 'B');",
    "  assert.equal(r.match('GET', '/a?x=1').handler(), 'A');",
    "  assert.equal(r.match('DELETE', '/a'), null);",
    '});',
    '',
  ].join('\n'),
  'test/users.test.mjs': [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { listen } from '../src/app.mjs';",
    "test('GET /users/:id returns the user', async () => {",
    '  const app = await listen();',
    '  try {',
    "    const res = await fetch(app.url + '/users/1');",
    '    assert.equal(res.status, 200);',
    "    assert.deepEqual(await res.json(), { id: '1', name: 'Ada' });",
    '  } finally {',
    '    await app.close();',
    '  }',
    '});',
    '',
  ].join('\n'),
};

/** One-line ESM sources: the fake writes whole lines, so every file is a single line. */
const T = "import { test } from 'node:test'; import assert from 'node:assert/strict';";
const LIST_TEST = `${T} import { listen } from '../src/app.mjs'; test('GET /users lists users', async () => { const app = await listen(); try { const res = await fetch(app.url + '/users'); assert.equal(res.status, 200); assert.equal((await res.json()).length, 2); } finally { await app.close(); } });`;
const USERS_WITH_LIST =
  "import { USERS } from '../store/users.mjs'; export function registerUserRoutes(router) { router.get('/users', (req, res) => sendJson(res, 200, USERS)); router.get('/users/:id', (req, res, params) => { const user = USERS.find((u) => u.id === params.id); if (!user) return sendJson(res, 404, { error: 'not found' }); return sendJson(res, 200, user); }); } export function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }";
const USERS_WITH_CREATE =
  "import { USERS } from '../store/users.mjs'; import { validateUser } from '../validate.mjs'; export function registerUserRoutes(router) { router.get('/users', (req, res) => sendJson(res, 200, USERS)); router.get('/users/:id', (req, res, params) => { const user = USERS.find((u) => u.id === params.id); if (!user) return sendJson(res, 404, { error: 'not found' }); return sendJson(res, 200, user); }); router.post('/users', async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const v = validateUser(JSON.parse(raw || '{}')); if (!v.ok) return sendJson(res, 400, { error: v.error }); const user = { id: String(USERS.length + 1), ...v.value }; USERS.push(user); return sendJson(res, 201, user); }); } export function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }";
const CREATE_TEST = `${T} import { listen } from '../src/app.mjs'; test('POST /users validates and creates', async () => { const app = await listen(); try { const bad = await fetch(app.url + '/users', { method: 'POST', body: '{}' }); assert.equal(bad.status, 400); const ok = await fetch(app.url + '/users', { method: 'POST', body: JSON.stringify({ name: 'Grace' }) }); assert.equal(ok.status, 201); } finally { await app.close(); } });`;
const SKIPPED_TEST = `${T} test.skip('DELETE /users/:id', () => { assert.equal(1, 1); });`;

const SPECKIT_TASKS = `# Tasks: Users API

## Phase 1: Setup (Shared Infrastructure)

- [ ] T001 [P] Configure editor settings (.editorconfig)
  - kind: config
  - no test: config only
FAKE: append .editorconfig root = true

- [ ] T002 [P] Document the users API endpoints in README.md
  - kind: docs
FAKE: append README.md ## API

## Phase 2: User Story 1 - List users (Priority: P1)

- [ ] T003 [US1] Write failing integration test for GET /users in test/users-list.test.mjs
  - tdd: red
  - level: integration
FAKE: append test/users-list.test.mjs ${LIST_TEST}
FAKE: echo FULLAUTO_TDD: red=1 green=0

- [ ] T004 [US1] Implement GET /users in src/routes/users.mjs (depends on T003)
  - tests: T003
FAKE: writeln src/routes/users.mjs ${USERS_WITH_LIST}
FAKE: echo FULLAUTO_TDD: red=0 green=1

## Phase 3: User Story 2 - Create user (Priority: P2)

- [ ] T005 [P] [US2] Add user payload validation helper in src/validate.mjs
  - wired by: T006
  - no test: covered by T006
FAKE: writeln src/validate.mjs export function validateUser(body) { if (!body || typeof body.name !== 'string') return { ok: false, error: 'name required' }; return { ok: true, value: { name: body.name } }; }
FAKE: echo FULLAUTO_WIRING:
FAKE: echo - src/validate.mjs -> (wired by T006)

- [ ] T006 [US2] Implement POST /users with validation in src/routes/users.mjs (depends on T005)
FAKE: writeln src/routes/users.mjs ${USERS_WITH_CREATE}
FAKE: append test/users-create.test.mjs ${CREATE_TEST}
FAKE: echo FULLAUTO_TDD: red=1 green=1
FAKE: echo FULLAUTO_WIRING:
FAKE: echo - src/validate.mjs#validateUser -> src/routes/users.mjs

## Phase 4: User Story 3 - Delete user (Priority: P3)

- [ ] T007 [US3] Implement DELETE /users/:id with a test (the fake cheats with .skip)
FAKE: append src/routes/users.mjs export function registerDeleteRoute(router) { router.add('DELETE', '/users/:id', (req, res, params) => { USERS.splice(USERS.findIndex((u) => u.id === params.id), 1); return sendJson(res, 204, {}); }); }
FAKE: append test/users-delete.test.mjs ${SKIPPED_TEST}
FAKE: echo FULLAUTO_TDD: red=1 green=1
`;

beforeAll(async () => {
  fake = await makeFakeClaude();
  // Compile the real CLI once (~2s) into a scratch dist, resolving deps
  // through the repo's node_modules (same recipe as audit-flow (f)).
  distDir = await makeTmpDir('fullauto-dist-');
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  try {
    execFileSync('npx', ['tsc', '--outDir', distDir], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // tsc still emits on type errors (noEmitOnError is off); `npm run
    // typecheck` owns type errors, this file owns runtime behavior.
  }
  await symlink(join(repoRoot, 'node_modules'), join(distDir, 'node_modules'), 'dir');
  cli = join(distDir, 'cli.js');
  if (!existsSync(cli)) throw new Error(`tsc did not emit ${cli}`);
}, 60_000);

afterAll(async () => {
  await fake.dispose();
  await cleanup(distDir);
});

beforeEach(async () => {
  await fake.reset();
  projectDir = await makeGitRepo(BASELINE_FILES);
});

afterEach(async () => {
  await cleanup(projectDir);
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  const config = {
    maxPasses: 2,
    subagentTimeoutSec: 60,
    useVerifyLoop: false,
    verifyMode: 'adaptive',
    audit: { enabled: true },
    gates: [TEST_GATE],
    ...overrides,
  };
  await execFileAsync('mkdir', ['-p', join(projectDir, '.fullauto')]);
  await writeFile(join(projectDir, '.fullauto', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

async function writeTasks(name: string, content: string): Promise<string> {
  const p = join(projectDir, name);
  await writeFile(p, content, 'utf-8');
  return p;
}

const cliEnv = () => ({ ...process.env, ...fake.env });

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const r = await execFileAsync(process.execPath, [cli, ...args, '--dir', projectDir], { env: cliEnv(), maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * Start the CLI in its own process group so a SIGTERM to the group takes
 * the fake `claude` (and its `sleep`) down with it — what Ctrl-C does in a
 * terminal. Returns the child and a live stdout buffer to poll.
 */
function startCli(args: string[]): { child: ChildProcess; out: { text: string }; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [cli, ...args, '--dir', projectDir], {
    env: cliEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const out = { text: '' };
  child.stdout!.on('data', (d: Buffer) => { out.text += d.toString('utf-8'); });
  child.stderr!.on('data', (d: Buffer) => { out.text += d.toString('utf-8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function killGroup(child: ChildProcess, exited: Promise<number | null>): Promise<void> {
  try {
    process.kill(-child.pid!, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await exited;
}

/** The subagent pid (= its process-group id) the transcript header records. */
async function subagentPidFromLog(logPath: string): Promise<number | undefined> {
  if (!existsSync(logPath)) return undefined;
  const m = /^# Subagent pid: (\d+)$/m.exec(await readFile(logPath, 'utf-8'));
  return m ? Number(m[1]) : undefined;
}

/** Pids still alive in process group `pgid` (empty when the group is gone). */
async function processGroupMembers(pgid: number): Promise<string[]> {
  try {
    const r = await execFileAsync('pgrep', ['-g', String(pgid)]);
    return r.stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function loadStateFile(): Promise<RunState> {
  return JSON.parse(await readFile(join(projectDir, '.fullauto', 'state.json'), 'utf-8')) as RunState;
}

const byId = (state: RunState, id: string): Task => {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`missing task ${id}`);
  return t;
};

const findings = (t: Task, idx = 0) => t.attempts[idx]?.audit?.findings ?? [];

describe('(a) real CLI on a speckit-style tasks.md', () => {
  it('runs every task to a terminal state, blocks + rolls back the .skip cheat (exit 1), status/audit see a clean tree, and `retry` finishes it', async () => {
    await writeConfig({ maxPasses: 1 });
    // The second invocation of T007 (the `fullauto retry` below) is honest:
    // it replaces the cheat with a real test and leaves production code as
    // T006 left it.
    const HONEST_TEST = `${T} import { listen } from '../src/app.mjs'; test('GET /users/:id 404s for unknown ids', async () => { const app = await listen(); try { const res = await fetch(app.url + '/users/999'); assert.equal(res.status, 404); } finally { await app.close(); } });`;
    const tasksPath = await writeTasks(
      'tasks.md',
      SPECKIT_TASKS +
        `FAKE: nth t007 2 writeln test/users-delete.test.mjs ${HONEST_TEST}\n` +
        `FAKE: nth t007 2 writeln src/routes/users.mjs ${USERS_WITH_CREATE}\n`
    );

    const r = await runCli(['run', tasksPath]);
    // One task failed → exit 1 (0 only when every task is done).
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Loaded 7 task(s)');

    let state = await loadStateFile();
    expect(state.tasks.map((t) => [t.id, t.feature, t.status])).toEqual([
      ['T001', undefined, 'done'],
      ['T002', undefined, 'done'],
      ['T003', 'US1', 'done'],
      ['T004', 'US1', 'done'],
      ['T005', 'US2', 'done'],
      ['T006', 'US2', 'done'],
      ['T007', 'US3', 'failed'],
    ]);
    expect(state.tasks.every((t) => t.status === 'done' || t.status === 'failed')).toBe(true);

    // Classification came from the marker sub-bullets, not the heuristics.
    expect(byId(state, 'T001').attempts[0].classification).toMatchObject({ kind: 'config', risk: 'low', tdd: 'none' });
    expect(byId(state, 'T002').attempts[0].classification).toMatchObject({ kind: 'docs' });
    expect(byId(state, 'T003').attempts[0].classification).toMatchObject({ kind: 'test', tdd: 'red', greenTaskIds: ['T004'] });
    expect(byId(state, 'T004').attempts[0].classification).toMatchObject({ kind: 'impl', tdd: 'green', redTaskIds: ['T003'] });
    expect(byId(state, 'T005').attempts[0].classification).toMatchObject({ wiredBy: 'T006' });

    // Red task: the raw test gate failed but the effective verdict was rewritten.
    const red = byId(state, 'T003').attempts[0];
    expect(red.gateResults[0]).toMatchObject({ name: 'test', passed: false });
    expect(red.gateResults[0].note).toContain('expected failure (TDD red): test/users-list.test.mjs');
    // Green retired the red set; the wired-by promise was kept.
    expect(state.redTests).toEqual([]);
    expect(state.pendingWiring).toEqual([]);
    expect(findings(byId(state, 'T005')).some((f) => f.check === 'orphan-code' && f.severity === 'info' && f.path === 'src/validate.mjs')).toBe(true);
    expect(findings(byId(state, 'T006')).some((f) => f.severity === 'block')).toBe(false);
    expect(state.testBaseline).toMatchObject({ runner: 'node-test', passed: 5, failed: 0 });

    // The cheat: a new .skip marker is a test-integrity BLOCK and the count did not grow.
    const cheat = byId(state, 'T007');
    expect(cheat.attempts[0].deferReason).toBe('audit_failed');
    expect(findings(cheat).some((f) => f.check === 'test-integrity' && f.severity === 'block' && f.path === 'test/users-delete.test.mjs')).toBe(true);
    expect(findings(cheat).some((f) => f.check === 'test-count' && f.severity === 'block')).toBe(true);
    expect(cheat.attempts[cheat.attempts.length - 1].deferDetail).toMatch(/^Promoted to failed after orchestrator exit/);
    // ...and rolled back: the appended route + the skipped test are gone from
    // the tree, the diff is saved as a patch, the attempt records it.
    const patchPath = join(projectDir, '.fullauto', 'logs', 'T007-attempt1.patch');
    expect(cheat.attempts[0].rollback).toMatchObject({ patchPath, files: 2, restored: 1, deleted: 1 });
    expect(existsSync(join(projectDir, 'test', 'users-delete.test.mjs'))).toBe(false);
    expect(await readFile(join(projectDir, 'src', 'routes', 'users.mjs'), 'utf-8')).toBe(`${USERS_WITH_CREATE}\n`);
    const patch = await readFile(patchPath, 'utf-8');
    expect(patch).toContain('+++ b/test/users-delete.test.mjs');
    expect(patch).toContain("test.skip('DELETE /users/:id'");
    expect(patch).toContain('+export function registerDeleteRoute');
    expect(r.stdout).toContain('T007: rolled back attempt 1 — 1 file(s) restored, 1 removed');

    // Artifacts on disk: a transcript per attempt, and `.fullauto/` ignored.
    for (const t of state.tasks) {
      const log = t.attempts[0].subagentLogPath!;
      expect(existsSync(log)).toBe(true);
      expect(await readFile(log, 'utf-8')).toContain(`# Subagent transcript for ${t.id}`);
    }
    expect(git(['check-ignore', '.fullauto/state.json'], projectDir).trim()).toBe('.fullauto/state.json');
    expect(await fake.prompts()).toHaveLength(7);

    // The final report names the failure, lists the attempt history (real
    // attempt + its log, not the synthetic promotion) and ends with the
    // next step.
    expect(r.stdout).toContain('done: 6');
    expect(r.stdout).toContain('failed: 1');
    expect(r.stdout).toContain('T007 [failed]');
    expect(r.stdout).toMatch(/pass 1: audit_failed — Post-task audit BLOCKED this attempt \(\d+ BLOCK/);
    expect(r.stdout).toContain(`log: ${cheat.attempts[0].subagentLogPath}`);
    expect(r.stdout).toContain('Next: `fullauto retry T007`');
    expect(r.stdout).toContain('Finished at');

    // `status` re-renders without running anything (Started in KST); `audit
    // --json` sees a clean tree because the cheat was rolled back.
    const status = await runCli(['status']);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/Started: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST, current pass: 2/);
    expect(status.stdout).toContain('T007 [failed]');
    expect(await fake.prompts()).toHaveLength(7);

    const audit = await runCli(['audit', '--json']);
    expect(audit.code).toBe(0);
    const json = JSON.parse(audit.stdout) as { blocked: boolean; findings: Array<{ check: string; path?: string; severity: string }> };
    expect(json.blocked).toBe(false);
    expect(json.findings.some((f) => f.path === 'test/users-delete.test.mjs')).toBe(false);

    // `fullauto retry T007`: failed → deferred, one more pass on top of
    // maxPasses (history kept: the retry is pass 3), the honest second
    // attempt passes, exit 0. Its prompt carried the rollback notice.
    const retry = await runCli(['retry', 'T007']);
    expect(retry.code).toBe(0);
    expect(retry.stdout).toContain('Retrying T007: re-queued as deferred in pass 3 (pass budget now 3)');
    expect(retry.stdout).toContain('All tasks complete');
    state = await loadStateFile();
    expect(state.currentPass).toBe(3);
    expect(state.extraPasses).toBe(2);
    const fixed = byId(state, 'T007');
    expect(fixed.status).toBe('done');
    expect(fixed.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'audit_failed'],
      [2, 'audit_failed'], // synthetic promotion at the end of run 1
      [3, undefined],
    ]);
    expect(fixed.attempts[2].audit?.blocked).toBe(false);
    expect(state.testBaseline).toMatchObject({ passed: 6 });
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(8);
    expect(prompts[7]).toContain("Your previous attempt's changes were rolled back (2 file(s): 1 restored, 1 removed)");
    expect(prompts[7]).toContain(`git apply ${patchPath}`);
    // Nothing left to retry → exit 0 without spawning anything.
    const again = await runCli(['retry']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('No failed tasks to retry');
    expect(await fake.prompts()).toHaveLength(8);
  });
});

describe('(b) SIGTERM mid-task, config edited between runs, resume converges', () => {
  it('persists the interrupted task as in_progress with its baseline, picks up gate edits on resume, and finishes', async () => {
    await writeConfig({ maxPasses: 3 });
    const tasksPath = await writeTasks(
      'tasks.md',
      [
        '# Tasks: crash',
        '',
        '- [ ] T001 [US1] Document the health endpoint in README.md',
        '  - kind: docs',
        'FAKE: append README.md ## GET /health',
        '',
        '- [ ] T002 [US1] Add greeting helper in src/greet.mjs wired into the app',
        'FAKE: sleep 3',
        "FAKE: writeln src/greet.mjs export const greet = (n) => 'hi ' + n;",
        // Every deferred attempt is rolled back, so each attempt appends the
        // import exactly once into a clean app.mjs (the interrupted attempts
        // never get past the sleep).
        "FAKE: append src/app.mjs import { greet } from './greet.mjs'; export const banner = greet('users');",
        `FAKE: writeln test/greet.test.mjs ${T} import { greet } from '../src/greet.mjs'; test('greet', () => { assert.equal(greet('x'), 'hi x'); });`,
        'FAKE: echo FULLAUTO_TDD: red=1 green=1',
        'FAKE: echo FULLAUTO_WIRING:',
        'FAKE: echo - src/greet.mjs#greet -> src/app.mjs',
        '',
      ].join('\n')
    );

    // Run 1: interrupt while T002's subagent is sleeping.
    const run1 = startCli(['run', tasksPath]);
    await waitFor(() => /▶ T002/.test(run1.out.text));
    await new Promise((r) => setTimeout(r, 500));
    await killGroup(run1.child, run1.exited);
    expect(await run1.exited).toBe(143);
    expect(run1.out.text).toContain('Interrupted by SIGTERM during T002 (attempt 1)');

    let state = await loadStateFile();
    expect(byId(state, 'T001').status).toBe('done');
    // The in-flight attempt is persisted BEFORE the subagent spawns: on disk
    // the task is in_progress with one unfinished attempt carrying the
    // pre-task baseline (HEAD + dirty fingerprints + the rollback tree) the
    // retry diffs against, the log path, and the interrupt annotation.
    const crashed = byId(state, 'T002');
    expect(crashed.status).toBe('in_progress');
    expect(crashed.attempts).toHaveLength(1);
    expect(crashed.attempts[0].finishedAt).toBeUndefined();
    expect(crashed.attempts[0].deferDetail).toBe('interrupted by signal (SIGTERM)');
    expect(crashed.attempts[0].baseline).toBeDefined();
    expect(typeof crashed.attempts[0].baseline?.headSha).toBe('string');
    expect(crashed.attempts[0].baseline?.treeSha).toMatch(/^[0-9a-f]{40}$/);
    const crashedLog = join(projectDir, '.fullauto', 'logs', 'T002-attempt1.log');
    expect(crashed.attempts[0].subagentLogPath).toBe(crashedLog);
    expect(existsSync(crashedLog)).toBe(true);
    expect(await readFile(crashedLog, 'utf-8')).toMatch(/# === EXIT \d+ \(INTERRUPTED by SIGTERM/);

    // Edit config between runs: add a gate that always fails.
    const configPath = join(projectDir, '.fullauto', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf-8')) as { gates: unknown[] };
    config.gates.push({ type: 'shell', name: 'extra-check', role: 'other', command: 'echo extra-check says no; false' });
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    // Run 2: resume picks the edit up; T002's retry (#2 — the crashed
    // attempt counts) defers on the new gate; interrupt the pass-2 retry (#3).
    const run2 = startCli(['resume']);
    await waitFor(() => /retry #3/.test(run2.out.text));
    await new Promise((r) => setTimeout(r, 500));
    await killGroup(run2.child, run2.exited);
    expect(await run2.exited).toBe(143);
    expect(run2.out.text).toContain('Detected edits in .fullauto/config.json');
    expect(run2.out.text).toContain('Gate "extra-check" failed');
    // The gate-failed attempt was rolled back: greet.mjs is gone until the
    // next attempt writes it again.
    expect(run2.out.text).toContain('T002: rolled back attempt 2');
    expect(existsSync(join(projectDir, 'src', 'greet.mjs'))).toBe(false);

    state = await loadStateFile();
    expect(state.currentPass).toBe(2);
    expect(byId(state, 'T002').status).toBe('in_progress');
    expect(byId(state, 'T002').attempts.map((a) => [a.passNumber, a.deferReason, a.finishedAt !== undefined])).toEqual([
      [1, undefined, false], // run-1 crash
      [1, 'gate_failed', true],
      [2, undefined, false], // run-2 crash mid-retry
    ]);
    expect(byId(state, 'T002').attempts[1].gateResults.map((g) => [g.name, g.passed])).toEqual([
      ['test', true],
      ['extra-check', false],
    ]);

    // Remove the gate again → resume converges.
    config.gates = config.gates.filter((g) => (g as { name: string }).name !== 'extra-check');
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

    const run3 = await runCli(['resume']);
    expect(run3.code).toBe(0);
    expect(run3.stdout).toContain('Detected edits in .fullauto/config.json');
    expect(run3.stdout).toContain('All tasks complete');

    state = await loadStateFile();
    expect(state.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    const t2 = byId(state, 'T002');
    expect(t2.attempts.map((a) => [a.passNumber, a.deferReason, a.finishedAt !== undefined])).toEqual([
      [1, undefined, false],
      [1, 'gate_failed', true],
      // The run-2 crash is re-queued in the same pass and annotated with the
      // last real reason (not closed — a finished attempt in the current pass
      // would make the queue skip the task).
      [2, 'gate_failed', false],
      [2, undefined, true],
    ]);
    expect(t2.attempts[3].audit?.blocked).toBe(false);
    expect(t2.attempts[1].rollback?.files).toBe(3);
    expect(existsSync(join(projectDir, 'src', 'greet.mjs'))).toBe(true);
    // Exactly one import line — no double append across the retries.
    const app = await readFile(join(projectDir, 'src', 'app.mjs'), 'utf-8');
    expect(app.split("import { greet } from './greet.mjs'").length - 1).toBe(1);
  }, 60_000);
});

describe('(b2) SIGTERM crash leaves a stray file; resume rolls it back before the retry (round 3, item 2)', () => {
  it("the interrupted attempt's write survives the crash on disk; resume removes it and saves a .patch BEFORE the retry runs", async () => {
    await writeConfig({ maxPasses: 2 });
    // `once` stamps persist across invocations of the same fake process
    // (the state dir survives a SIGTERM): both directives fire on attempt 1
    // (write, THEN sleep — so the crash happens with the file already on
    // disk), and both are already-consumed no-ops on attempt 2, so the
    // retry writes nothing and does not sleep. Whether `src/orphan.ts`
    // exists once the run finishes is therefore ENTIRELY down to whether
    // resume rolled the crash's stray write back before spawning the retry.
    const tasksPath = await writeTasks(
      'tasks.md',
      [
        '# Tasks: crash-rollback',
        '',
        '- [ ] T001 [US1] Add an orphan module',
        'FAKE: once crash-write write src/orphan.ts',
        'FAKE: once crash-sleep sleep 3',
        '',
      ].join('\n')
    );
    const orphanPath = join(projectDir, 'src', 'orphan.ts');

    // Run 1: interrupt while T001's subagent is sleeping, well after the
    // write directive (which runs first) already landed on disk.
    const run1 = startCli(['run', tasksPath]);
    await waitFor(() => /▶ T001/.test(run1.out.text));
    await new Promise((r) => setTimeout(r, 500));
    await killGroup(run1.child, run1.exited);
    expect(await run1.exited).toBe(143);
    expect(existsSync(orphanPath)).toBe(true); // the crash's stray write survived it

    let state = await loadStateFile();
    const crashed = byId(state, 'T001');
    expect(crashed.status).toBe('in_progress');
    expect(crashed.attempts).toHaveLength(1);
    expect(crashed.attempts[0].finishedAt).toBeUndefined();
    expect(crashed.attempts[0].baseline?.treeSha).toMatch(/^[0-9a-f]{40}$/);

    // Resume: rollback-on-resume must clean the orphan file BEFORE the
    // retry's subagent is spawned; the retry itself does nothing (its
    // `once` directives are already consumed), so nothing can recreate it.
    const run2 = await runCli(['resume']);
    expect(run2.code).toBe(0);
    expect(run2.stdout).toContain('T001: rolled back the interrupted attempt 1');

    state = await loadStateFile();
    const t1 = byId(state, 'T001');
    expect(t1.status).toBe('done');
    expect(existsSync(orphanPath)).toBe(false); // no leftover orphan going into the retry
    const patchPath = join(projectDir, '.fullauto', 'logs', 'T001-attempt1.patch');
    expect(existsSync(patchPath)).toBe(true); // the crash's diff was not silently lost
    expect(t1.attempts[0].rollback).toEqual({ patchPath, files: 1, restored: 0, deleted: 1, failed: 0 });
  }, 30_000);
});

describe('(c) TDD red quarantine with siblings; a sibling that breaks existing tests', () => {
  const NAME_TEST = `${T} import { listen } from '../src/app.mjs'; test('GET /users/:id/name', async () => { const app = await listen(); try { const res = await fetch(app.url + '/users/1/name'); assert.equal(res.status, 200); } finally { await app.close(); } });`;
  const BROKEN_ROUTER =
    "export function createRouter() { const routes = []; const api = { add(method, path, handler) { routes.push({ method, path, handler }); return api; }, get(path, handler) { return api.add('GET', path, handler); }, post(path, handler) { return api.add('POST', path, handler); }, match(method, url) { const path = url.split('?')[0]; for (const r of routes) { if (r.method !== method) continue; const params = matchPath(r.path, path); if (params) return { handler: r.handler, params }; } return null; } }; return api; } export function matchPath(pattern, path) { const a = pattern.split('/').filter(Boolean); const b = path.split('/').filter(Boolean); if (a.length !== b.length) return null; const params = {}; for (let i = 0; i < a.length; i++) { if (a[i].startsWith(':')) params[a[i].slice(1)] = Number(b[i]); else if (a[i] !== b[i]) return null; } return params; }";
  const QUARANTINE_TASKS = [
    '# Tasks: quarantine',
    '',
    '- [ ] T001 [US1] Write failing integration test for GET /users/:id/name in test/users-name.test.mjs',
    '  - tdd: red',
    `FAKE: append test/users-name.test.mjs ${NAME_TEST}`,
    '',
    '- [ ] T002 [P] [US1] Add slug helper in src/util/slug.mjs and use it in the app',
    "FAKE: writeln src/util/slug.mjs export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
    "FAKE: append src/app.mjs import { slug } from './util/slug.mjs'; export const appSlug = slug('Users API');",
    `FAKE: writeln test/slug.test.mjs ${T} import { slug } from '../src/util/slug.mjs'; test('slug', () => { assert.equal(slug('Hello World'), 'hello-world'); });`,
    '',
    '- [ ] T003 [P] [US1] Coerce numeric route params in src/router.mjs (this fake version breaks pre-existing tests)',
    `FAKE: writeln src/router.mjs ${BROKEN_ROUTER}`,
    `FAKE: writeln test/router-num.test.mjs ${T} import { matchPath } from '../src/router.mjs'; test('numeric params', () => { assert.deepEqual(matchPath('/u/:id', '/u/7'), { id: 7 }); });`,
    '',
    '- [ ] T004 [US1] Implement GET /users/:id/name in src/routes/users.mjs (depends on T001)',
    '  - tests: T001',
    // Keeps the pre-existing /users/:id route (V2's quarantine fixture) so the
    // only failing test while T004 runs is T001's red one.
    "FAKE: writeln src/routes/users.mjs import { USERS } from '../store/users.mjs'; export function registerUserRoutes(router) { router.get('/users/:id/name', (req, res, params) => { const user = USERS.find((u) => u.id === params.id); if (!user) return sendJson(res, 404, { error: 'not found' }); return sendJson(res, 200, { name: user.name }); }); router.get('/users/:id', (req, res, params) => { const user = USERS.find((u) => u.id === params.id); if (!user) return sendJson(res, 404, { error: 'not found' }); return sendJson(res, 200, user); }); } export function sendJson(res, status, body) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }",
    'FAKE: echo FULLAUTO_TDD: red=0 green=1',
    '',
  ].join('\n');

  it('rolls the breaking task back so the green task completes; the breaker fails with a summarized gate output and a patch pointer', async () => {
    await writeConfig({ maxPasses: 2 });
    const tasksPath = await writeTasks('tasks.md', QUARANTINE_TASKS);

    const r = await runCli(['run', tasksPath]);
    expect(r.code).toBe(1);
    const state = await loadStateFile();
    expect(state.tasks.map((t) => [t.id, t.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'done'],
      ['T003', 'failed'],
      ['T004', 'done'],
    ]);

    // The sibling ran with the red test quarantined: raw gate failed, verdict rewritten.
    const sib = byId(state, 'T002').attempts[0];
    expect(sib.gateResults[0]).toMatchObject({ passed: false, note: 'quarantined red tests: test/users-name.test.mjs' });
    expect(sib.audit?.blocked).toBe(false);

    // The breaking task is a real failure: its failing files are not all
    // quarantined. deferDetail carries the SUMMARY (verdict lines + tail),
    // a pointer to the full gate log, and names the quarantined red file as
    // not-yours-to-fix.
    const breaker = byId(state, 'T003');
    const first = breaker.attempts[0];
    expect(first.deferReason).toBe('gate_failed');
    expect(first.deferDetail).toContain('not ok');
    expect(first.deferDetail).toContain('matchPath extracts params');
    const gateLog = join(projectDir, '.fullauto', 'logs', 'T003-attempt1-gate-test.log');
    expect(first.deferDetail).toContain(`full output: ${gateLog}`);
    expect(existsSync(gateLog)).toBe(true);
    expect(await readFile(gateLog, 'utf-8')).toContain('# Gate "test" — exit 1');
    expect(first.deferDetail).toContain('These failures are EXPECTED red tests owned by other tasks — do not touch them: test/users-name.test.mjs');
    expect(Buffer.byteLength(first.deferDetail!, 'utf-8')).toBeLessThan(9 * 1024);

    // Its damage was rolled back (router.mjs restored, the new test removed,
    // the diff saved), so T004 turned the red set green and nothing is
    // reported as never-green.
    const patchPath = join(projectDir, '.fullauto', 'logs', 'T003-attempt1.patch');
    expect(first.rollback).toMatchObject({ patchPath, files: 2, restored: 1, deleted: 1 });
    expect(await readFile(join(projectDir, 'src', 'router.mjs'), 'utf-8')).toBe(ROUTER_MJS);
    expect(existsSync(join(projectDir, 'test', 'router-num.test.mjs'))).toBe(false);
    expect(await readFile(patchPath, 'utf-8')).toContain('Number(b[i])');
    expect(state.redTests).toEqual([]);
    expect(r.stdout).not.toContain('=== TDD red tests never turned green ===');
    expect(byId(state, 'T004').attempts[0].gateResults[0].passed).toBe(true);

    // Pass 2 retried T003 (the fake breaks it again) with the patch pointer in
    // its prompt; then no-progress bail → failed.
    expect(breaker.attempts.map((a) => [a.passNumber, a.deferReason])).toEqual([
      [1, 'gate_failed'],
      [2, 'gate_failed'],
      [2, 'gate_failed'],
    ]);
    expect(breaker.attempts[1].rollback?.patchPath).toBe(join(projectDir, '.fullauto', 'logs', 'T003-attempt2.patch'));
    const prompts = await fake.prompts();
    const retryPrompt = prompts.find((p) => p.includes('## Task ID: T003') && p.includes('Prior attempt context'));
    expect(retryPrompt).toBeDefined();
    expect(retryPrompt).toContain("Your previous attempt's changes were rolled back (2 file(s): 1 restored, 1 removed)");
    expect(retryPrompt).toContain(`git apply ${patchPath}`);
    expect(retryPrompt).toContain('matchPath extracts params');
    expect(r.stdout).toContain('Pass made no progress');
    // The report shows both real attempts and the log of the last one.
    expect(r.stdout).toMatch(/pass 1: gate_failed — Gate "test" failed \(exit 1\)/);
    expect(r.stdout).toMatch(/pass 2: gate_failed — Gate "test" failed \(exit 1\)/);
    expect(r.stdout).toContain(`log: ${breaker.attempts[1].subagentLogPath}`);
  });

  it('with rollbackOnDefer: false the damage cascades — documents what the rollback prevents', async () => {
    await writeConfig({ maxPasses: 2, rollbackOnDefer: false });
    const tasksPath = await writeTasks('tasks.md', QUARANTINE_TASKS);

    const r = await runCli(['run', tasksPath]);
    expect(r.code).toBe(1);
    const state = await loadStateFile();
    expect(byId(state, 'T003').status).toBe('failed');
    expect(byId(state, 'T003').attempts[0].rollback).toBeUndefined();
    // The broken router stays in the shared tree, so the green task cannot
    // turn the red set green either; the run still ends (no-progress bail)
    // with the red set reported instead of looping.
    expect(byId(state, 'T004').status).toBe('failed');
    expect(state.redTests.map((x) => x.taskId)).toEqual(['T001']);
    expect(r.stdout).toContain('Pass made no progress');
    expect(r.stdout).toContain('=== TDD red tests never turned green ===');
    expect(r.stdout).toContain('T001 — 1 failing test(s) in test/users-name.test.mjs');
    expect(r.stdout).not.toContain('rolled back attempt');
  });
});

describe('(d) plan mistakes that could deadlock or loop', () => {
  const EDGE_TASKS = (testsMarker: string) =>
    [
      '# Tasks: edge cases',
      '',
      '- [ ] T001 [US1] Implement GET /ping in src/app.mjs',
      ...(testsMarker ? [testsMarker] : []),
      "FAKE: append src/app.mjs export const ping = () => 'pong';",
      '',
      '- [ ] T002 [US2] Write failing test for GET /users/:id/email in test/users-email.test.mjs',
      '  - tdd: red',
      `FAKE: append test/users-email.test.mjs ${T} import { listen } from '../src/app.mjs'; test('GET /users/:id/email', async () => { const app = await listen(); try { const res = await fetch(app.url + '/users/1/email'); assert.equal(res.status, 200); } finally { await app.close(); } });`,
      '',
      '- [ ] T003 [US3] Document the ping endpoint in README.md',
      '  - kind: docs',
      'FAKE: append README.md ## GET /ping',
      '',
      '- [ ] T004 [US3] Add src/util/fmt.mjs formatting helper (depends on T003)',
      '  - wired by: T003',
      '  - no test: pure helper',
      'FAKE: writeln src/util/fmt.mjs export const fmt = (n) => n.toFixed(2);',
      '',
      '- [ ] T005 [US4] Add src/util/a.mjs',
      '  - wired by: T006',
      '  - no test: helper',
      'FAKE: writeln src/util/a.mjs export const a = 1;',
      '',
      '- [ ] T006 [US4] Add src/util/b.mjs (depends on T005)',
      '  - wired by: T005',
      '  - no test: helper',
      'FAKE: writeln src/util/b.mjs export const b = 2;',
      '',
      '- [ ] T007 [US5] Simplify router tests (empties test/router.test.mjs)',
      '  - no test: cleanup',
      'FAKE: writeln test/router.test.mjs // emptied',
      '',
    ].join('\n');

  it('a `- tests:` marker naming a task that is not in the list is rejected by the validator before anything runs', async () => {
    await writeConfig({ maxPasses: 2 });
    const tasksPath = await writeTasks('tasks.md', EDGE_TASKS('  - tests: T999'));
    const r = await runCli(['run', tasksPath]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('Tasks file failed validation (1 error(s))');
    expect(r.stdout + r.stderr).toContain('Task T001 says `- tests: T999` but T999 is not in the task list');
    expect(existsSync(join(projectDir, '.fullauto', 'state.json'))).toBe(false);
    expect(await fake.prompts()).toHaveLength(0);
  });

  it('ends with clear reasons: red without green, wired-by a done task, cyclic wiring, deleted test; exit 1', async () => {
    await writeConfig({ maxPasses: 2 });
    const tasksPath = await writeTasks('tasks.md', EDGE_TASKS(''));

    const r = await runCli(['run', tasksPath]);
    expect(r.code).toBe(1);
    // `wired by` pointing at a task that appears EARLIER is a validator warning (the run proceeds).
    expect(r.stdout).toContain('Task T004 says `- wired by: T003` but T003 appears earlier in the file');
    expect(r.stdout).toContain('Task T006 says `- wired by: T005` but T005 appears earlier in the file');
    const state = await loadStateFile();
    expect(state.tasks.every((t) => t.status === 'done' || t.status === 'failed')).toBe(true);
    expect(r.stdout).toContain('Pass made no progress');

    // T001: a plain behavior task; first task → no baseline to compare against.
    const t1 = byId(state, 'T001');
    expect(t1.status).toBe('done');
    expect(t1.attempts[0].classification).toMatchObject({ kind: 'impl', tdd: 'none' });
    expect(t1.attempts[0].classification?.testsDelegatedTo).toBeUndefined();

    // Red with no green partner: done, quarantined for everyone after it, reported at the end.
    expect(byId(state, 'T002').status).toBe('done');
    expect(byId(state, 'T003').attempts[0].gateResults[0].note).toBe('quarantined red tests: test/users-email.test.mjs');
    expect(state.redTests.map((x) => x.taskId)).toEqual(['T002']);
    expect(r.stdout).toContain('no green task found for this red set');

    // `- wired by:` a task that already finished: the marker is ignored, so
    // T004 has to wire fmt.mjs itself — it does not → orphan-code BLOCK on
    // both attempts, no promise is ever recorded.
    const t4 = byId(state, 'T004');
    expect(t4.status).toBe('failed');
    expect(t4.attempts[0].classification?.wiredBy).toBeUndefined();
    expect(t4.attempts[0].classification?.rationale).toContain('wired by: T003 ignored — that task is already done; wire the artifact in this task');
    expect(t4.attempts[0].deferReason).toBe('audit_failed');
    expect(findings(t4).some((f) => f.check === 'orphan-code' && f.severity === 'block' && f.path === 'src/util/fmt.mjs')).toBe(true);
    expect(findings(t4, 1).some((f) => f.check === 'orphan-code' && f.severity === 'block' && f.path === 'src/util/fmt.mjs')).toBe(true);
    expect(r.stdout).not.toContain('src/util/fmt.mjs — created by T004');

    // Cyclic promises: T005 done with a pending promise; T006 (whose own
    // `wired by: T005` is ignored — T005 is done) is blocked for not keeping
    // T005's promise AND for its own orphan.
    expect(byId(state, 'T005').status).toBe('done');
    const t6 = byId(state, 'T006');
    expect(t6.status).toBe('failed');
    expect(t6.attempts[0].classification?.rationale).toContain('wired by: T005 ignored — that task is already done; wire the artifact in this task');
    expect(t6.attempts[0].deferReason).toBe('audit_failed');
    expect(findings(t6).some((f) => f.check === 'pending-wiring' && f.severity === 'block' && f.path === 'src/util/a.mjs')).toBe(true);
    expect(findings(t6).some((f) => f.check === 'orphan-code' && f.severity === 'block' && f.path === 'src/util/b.mjs')).toBe(true);
    expect(state.pendingWiring.map((p) => p.artifactPath)).toEqual(['src/util/a.mjs']);
    expect(r.stdout).toContain('=== Wiring promises never fulfilled ===');
    expect(r.stdout).toContain('src/util/a.mjs — created by T005, to be wired by T006 [failed]');

    // Emptying a pre-existing test file: weakened test + count decrease, both
    // BLOCK; the rollback restored the file and the retry emptied it again.
    const t7 = byId(state, 'T007');
    expect(t7.status).toBe('failed');
    expect(t7.attempts[0].deferReason).toBe('audit_failed');
    expect(findings(t7).some((f) => f.check === 'test-integrity' && f.severity === 'block' && f.path === 'test/router.test.mjs')).toBe(true);
    expect(findings(t7).some((f) => f.check === 'test-count' && f.severity === 'block')).toBe(true);
    expect(findings(t7, 1).some((f) => f.check === 'test-integrity' && f.severity === 'block')).toBe(true);
    expect(t7.attempts[1].rollback?.files).toBe(1);
    expect(await readFile(join(projectDir, 'test', 'router.test.mjs'), 'utf-8')).toBe(BASELINE_FILES['test/router.test.mjs']);
    expect(r.stdout).toContain('Next: `fullauto retry T004 T006 T007`');
  });
});

describe('(e) SIGTERM to the CLI pid only — the subagent process group must die too', () => {
  it('kills the whole subagent group within the grace period, marks the attempt interrupted (exit 143), and resume finishes the run', async () => {
    await writeConfig({ maxPasses: 2 });
    const tasksPath = await writeTasks(
      'tasks.md',
      [
        '# Tasks: supervisor kill',
        '',
        '- [ ] T001 [US1] Document the health endpoint in README.md',
        '  - kind: docs',
        'FAKE: append README.md ## GET /health',
        '',
        '- [ ] T002 [US1] Add greeting helper in src/greet.mjs wired into the app',
        // Only the first invocation sleeps; the resumed attempt runs straight through.
        'FAKE: once t002-sleep sleep 40',
        "FAKE: writeln src/greet.mjs export const greet = (n) => 'hi ' + n;",
        "FAKE: append src/app.mjs import { greet } from './greet.mjs'; export const banner = greet('users');",
        `FAKE: writeln test/greet.test.mjs ${T} import { greet } from '../src/greet.mjs'; test('greet', () => { assert.equal(greet('x'), 'hi x'); });`,
        'FAKE: echo FULLAUTO_TDD: red=1 green=1',
        'FAKE: echo FULLAUTO_WIRING:',
        'FAKE: echo - src/greet.mjs#greet -> src/app.mjs',
        '',
      ].join('\n')
    );

    const run = startCli(['run', tasksPath]);
    const log = join(projectDir, '.fullauto', 'logs', 'T002-attempt1.log');
    let pid: number | undefined;
    await waitFor(() => /▶ T002/.test(run.out.text));
    await waitFor(() => {
      // The header is written synchronously after spawn; poll until it is flushed.
      void subagentPidFromLog(log).then((p) => { pid = p; });
      return pid !== undefined;
    });
    await new Promise((r) => setTimeout(r, 500));
    // The fake (bash) and its `sleep` are alive in the subagent's own group.
    expect((await processGroupMembers(pid!)).length).toBeGreaterThanOrEqual(2);

    // A supervisor kill: SIGTERM to the CLI process alone, not to its group.
    const killedAt = Date.now();
    run.child.kill('SIGTERM');
    expect(await run.exited).toBe(143);
    await waitFor(() => false, 0).catch(() => undefined);
    let members = await processGroupMembers(pid!);
    while (members.length > 0 && Date.now() - killedAt < 6_000) {
      await new Promise((r) => setTimeout(r, 100));
      members = await processGroupMembers(pid!);
    }
    expect(members).toEqual([]);
    expect(Date.now() - killedAt).toBeLessThan(6_000);
    expect(run.out.text).toContain('SIGTERM received — stopping the running subagent and saving state');
    expect(run.out.text).toContain('Interrupted by SIGTERM during T002 (attempt 1)');

    const state = await loadStateFile();
    const t2 = byId(state, 'T002');
    expect(t2.status).toBe('in_progress');
    expect(t2.attempts).toHaveLength(1);
    expect(t2.attempts[0].finishedAt).toBeUndefined();
    expect(t2.attempts[0].deferDetail).toBe('interrupted by signal (SIGTERM)');
    expect(t2.attempts[0].subagentLogPath).toBe(log);
    expect(await readFile(log, 'utf-8')).toContain('INTERRUPTED by SIGTERM');

    const resumed = await runCli(['resume']);
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('All tasks complete');
    const final = await loadStateFile();
    expect(final.tasks.map((t) => t.status)).toEqual(['done', 'done']);
    expect(byId(final, 'T002').attempts.map((a) => [a.passNumber, a.finishedAt !== undefined])).toEqual([
      [1, false],
      [1, true],
    ]);
  }, 60_000);
});

describe('(f) `fullauto audit` outside a git repository', () => {
  it('prints "Audit skipped" and exits 0 (plain and --json)', async () => {
    const plain = await makeTmpDir('fullauto-nongit-');
    try {
      await writeFile(join(plain, 'index.mjs'), 'export const x = 1;\n', 'utf-8');
      const text = await execFileAsync(process.execPath, [cli, 'audit', '--dir', plain], { env: cliEnv() });
      expect(text.stdout).toContain('Audit skipped: not a git repository');
      const json = await execFileAsync(process.execPath, [cli, 'audit', '--json', '--dir', plain], { env: cliEnv() });
      expect(JSON.parse(json.stdout)).toMatchObject({ skipped: 'not a git repository', blocked: false, findings: [] });
    } finally {
      await cleanup(plain);
    }
  });
});
