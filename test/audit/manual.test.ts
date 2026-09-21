import { afterEach, describe, expect, it } from 'vitest';
import { runManualAudit } from '../../src/audit/manual.js';
import { makeRepo, type TempRepo } from './_helpers.js';
import { makeTmpDir } from '../helpers/tmp.js';
import { cleanup } from '../helpers/tmp.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('runManualAudit', () => {
  it('status "not-git-repo" for a plain directory, no error', async () => {
    const dir = await makeTmpDir('manual-audit-nongit-');
    try {
      const outcome = await runManualAudit(dir);
      expect(outcome).toEqual({ status: 'not-git-repo' });
    } finally {
      await cleanup(dir);
    }
  });

  it('status "base-not-found" when --base does not resolve to a commit', async () => {
    const repo = makeRepo({ 'README.md': '# x\n' });
    repos.push(repo);
    const outcome = await runManualAudit(repo.dir, 'not-a-real-ref');
    expect(outcome).toEqual({ status: 'base-not-found', base: 'not-a-real-ref' });
  });

  it('diffs the working tree against HEAD by default and reports a clean tree as unblocked', async () => {
    const repo = makeRepo({ 'README.md': '# x\n', 'src/index.ts': 'export {};\n' });
    repos.push(repo);
    const outcome = await runManualAudit(repo.dir);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.base).toBe('HEAD');
    expect(outcome.result.blocked).toBe(false);
    expect(outcome.result.findings).toEqual([]);
    expect(outcome.before.headSha).toBe(outcome.after.headSha);
  });

  it('flags an uncommitted orphan file the same way the orchestrator\'s own audit would', async () => {
    const repo = makeRepo({ 'README.md': '# x\n', 'src/index.ts': 'export {};\n' });
    repos.push(repo);
    repo.write('src/orphan.ts', 'export function orphan() { return 1; }\n');
    const outcome = await runManualAudit(repo.dir);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.result.blocked).toBe(true);
    expect(outcome.result.findings.some((f) => f.check === 'orphan-code' && f.path === 'src/orphan.ts')).toBe(true);
    expect(outcome.result.changed).toEqual({ added: 1, modified: 0, deleted: 0 });
  });

  it('accepts an explicit --base ref, diffing from an older commit forward', async () => {
    const repo = makeRepo({ 'README.md': '# x\n' });
    repos.push(repo);
    const firstSha = repo.git('rev-parse', 'HEAD').trim();
    repo.write('src/new.ts', 'export function used() { return 1; }\n');
    repo.write('src/app.ts', "import { used } from './new.js';\nused();\n");
    repo.commit('add new.ts wired from app.ts');
    const outcome = await runManualAudit(repo.dir, firstSha);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.base).toBe(firstSha);
    // Wired from src/app.ts in the SAME commit → not an orphan.
    expect(outcome.result.findings.some((f) => f.check === 'orphan-code')).toBe(false);
    expect(outcome.result.changed.added).toBeGreaterThanOrEqual(2);
  });

  it('forces wiringManifest and testCount off regardless of project config (no subagent transcript to check them against)', async () => {
    const repo = makeRepo({
      'README.md': '# x\n',
      '.fullauto/config.json': JSON.stringify({ audit: { wiringManifest: true, testCount: true } }),
    });
    repos.push(repo);
    repo.write('src/orphan.ts', 'export function orphan() { return 1; }\n');
    const outcome = await runManualAudit(repo.dir);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    // A manual invocation has no FULLAUTO_WIRING block / gate output to
    // check those against — only orphan-code (and friends) can fire.
    expect(outcome.result.findings.every((f) => f.check !== 'wiring-manifest' && f.check !== 'test-count')).toBe(true);
  });
});
