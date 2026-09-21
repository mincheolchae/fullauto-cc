import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  paths,
  ensureFullautoDir,
  saveState,
  loadState,
  saveConfigSnapshot,
  loadUserConfig,
  logPathFor,
  ensureParent,
} from '../src/persistence.js';
import { RunState } from '../src/types.js';
import { makeTmpDir, cleanup } from './helpers/tmp.js';
import { makeAttempt, makeState, makeTask } from './helpers/fixtures.js';

let dir: string;

beforeEach(async () => {
  dir = await makeTmpDir('fullauto-persist-');
});
afterEach(async () => {
  await cleanup(dir);
});

describe('paths / ensureFullautoDir / logPathFor', () => {
  it('lays out .fullauto/{state.json,config.json,logs} under the project dir', () => {
    const p = paths(dir);
    expect(p.root).toBe(dir);
    expect(p.fullautoDir).toBe(join(dir, '.fullauto'));
    expect(p.statePath).toBe(join(dir, '.fullauto', 'state.json'));
    expect(p.configPath).toBe(join(dir, '.fullauto', 'config.json'));
    expect(p.logsDir).toBe(join(dir, '.fullauto', 'logs'));
  });

  it('ensureFullautoDir creates the dir and logs dir (idempotent)', async () => {
    const p = await ensureFullautoDir(dir);
    expect((await stat(p.fullautoDir)).isDirectory()).toBe(true);
    expect((await stat(p.logsDir)).isDirectory()).toBe(true);
    await expect(ensureFullautoDir(dir)).resolves.toEqual(p);
  });

  it('logPathFor names logs by task id and attempt number', () => {
    expect(logPathFor(dir, 'T001', 1)).toBe(join(dir, '.fullauto', 'logs', 'T001-attempt1.log'));
    expect(logPathFor(dir, 'ENHANCE-all', 3)).toBe(
      join(dir, '.fullauto', 'logs', 'ENHANCE-all-attempt3.log')
    );
  });

  it('ensureParent creates the parent directory of a file path', async () => {
    const target = join(dir, 'a', 'b', 'c.log');
    await ensureParent(target);
    expect((await stat(join(dir, 'a', 'b'))).isDirectory()).toBe(true);
  });
});

describe('saveState / loadState', () => {
  it('loadState returns null when no state file exists', async () => {
    expect(await loadState(dir)).toBeNull();
  });

  it('round-trips a state through disk, preserving attempts and defaults', async () => {
    const state = makeState(
      [
        makeTask('T001', {
          status: 'deferred',
          attempts: [
            makeAttempt(1, {
              finishedAt: '2026-01-01T00:00:01.000Z',
              subagentExitCode: 0,
              subagentLogPath: '/tmp/x.log',
              deferReason: 'gate_failed',
              deferDetail: 'Gate "test" failed (exit 1).\n\n```\nboom\n```',
              gateResults: [
                {
                  name: 'test',
                  passed: false,
                  command: 'npm test',
                  exitCode: 1,
                  output: 'boom',
                  durationMs: 12,
                },
              ],
            }),
          ],
        }),
        makeTask('T002', { dependencies: ['T001'], feature: 'US1' }),
      ],
      { currentPass: 2, passSnapshots: [{ pass: 1, unresolvedIds: ['T001', 'T002'] }] }
    );

    await saveState(dir, state);
    const loaded = await loadState(dir);
    expect(loaded).toEqual(state);
    // The loaded object is a fresh parse — not the same reference.
    expect(loaded).not.toBe(state);
  });

  it('creates .fullauto/ on demand and writes atomically (no .tmp left behind)', async () => {
    const state = makeState([makeTask('T001')]);
    await saveState(dir, state);
    const entries = await readdir(join(dir, '.fullauto'));
    expect(entries).toContain('state.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);

    const raw = await readFile(paths(dir).statePath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    // Pretty-printed (2-space) so state.json diffs are human-reviewable.
    expect(raw).toMatch(/^\{\n {2}"startedAt": /);
  });

  it('overwrites a previous state on subsequent saves', async () => {
    await saveState(dir, makeState([makeTask('T001')]));
    await saveState(dir, makeState([makeTask('T001', { status: 'done' })], { currentPass: 3 }));
    const loaded = await loadState(dir);
    expect(loaded?.currentPass).toBe(3);
    expect(loaded?.tasks[0].status).toBe('done');
  });

  it('a stale state.json.tmp from a crashed save is ignored by loadState and replaced by the next save', async () => {
    const p = paths(dir);
    await mkdir(p.fullautoDir, { recursive: true });
    await writeFile(`${p.statePath}.tmp`, '{"half": tru', 'utf-8');
    expect(await loadState(dir)).toBeNull();

    await saveState(dir, makeState([makeTask('T001')]));
    const entries = await readdir(p.fullautoDir);
    expect(entries).toEqual(['state.json']);
  });

  it('throws a clear error on corrupted (non-JSON) state', async () => {
    const p = await ensureFullautoDir(dir);
    await writeFile(p.statePath, '{ "startedAt": "x", tasks: [', 'utf-8');
    await expect(loadState(dir)).rejects.toThrow(/state\.json is corrupted \(invalid JSON\)/);
  });

  it('throws a schema-mismatch error when the JSON does not match RunState', async () => {
    const p = await ensureFullautoDir(dir);
    await writeFile(p.statePath, JSON.stringify({ version: 99, todo: [] }), 'utf-8');
    await expect(loadState(dir)).rejects.toThrow(/state\.json schema mismatch/);
  });

  it('schema-mismatch error carries zod details (field path) to help the user', async () => {
    const p = await ensureFullautoDir(dir);
    const bad = { ...makeState([makeTask('T001')]), currentPass: 'two' };
    await writeFile(p.statePath, JSON.stringify(bad), 'utf-8');
    await expect(loadState(dir)).rejects.toThrow(/currentPass/);
  });

  it('fills defaults for optional fields missing from an older state file (forward compat)', async () => {
    const p = await ensureFullautoDir(dir);
    const minimal = {
      startedAt: '2026-01-01T00:00:00.000Z',
      tasks: [{ id: 'T001', title: 'a', body: 'a' }],
      config: {},
    };
    await writeFile(p.statePath, JSON.stringify(minimal), 'utf-8');
    const loaded = await loadState(dir);
    expect(loaded).toEqual(RunState.parse(minimal));
    expect(loaded?.currentPass).toBe(1);
    expect(loaded?.passSnapshots).toEqual([]);
    expect(loaded?.placeholderEnvs).toEqual([]);
    expect(loaded?.tasks[0].status).toBe('pending');
    expect(loaded?.tasks[0].attempts).toEqual([]);
    expect(loaded?.tasks[0].kind).toBe('user');
    expect(loaded?.commandStartedAt).toBeUndefined();
  });
});

describe('saveConfigSnapshot / loadUserConfig', () => {
  it('loadUserConfig returns null when no config.json exists', async () => {
    expect(await loadUserConfig(dir)).toBeNull();
  });

  it('returns the raw parsed JSON (unknown keys intact — parsing is the caller\'s job)', async () => {
    const p = await ensureFullautoDir(dir);
    await writeFile(
      p.configPath,
      JSON.stringify({ maxPasses: 2, gates: [{ name: 'x', command: 'true' }], audit: { enabled: false }, bogus: 1 }),
      'utf-8'
    );
    expect(await loadUserConfig(dir)).toEqual({
      maxPasses: 2,
      gates: [{ name: 'x', command: 'true' }],
      audit: { enabled: false },
      bogus: 1,
    });
  });

  it('throws a clear error on corrupted config.json', async () => {
    const p = await ensureFullautoDir(dir);
    await writeFile(p.configPath, '{ nope', 'utf-8');
    await expect(loadUserConfig(dir)).rejects.toThrow(/config\.json is corrupted/);
  });

  it('saveConfigSnapshot writes config.json that loadUserConfig reads back', async () => {
    await saveConfigSnapshot(dir, { maxPasses: 7, gates: [] });
    expect(await loadUserConfig(dir)).toEqual({ maxPasses: 7, gates: [] });
  });
});
