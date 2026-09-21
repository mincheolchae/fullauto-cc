import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/audit/diff.js';
import { takeBaseSnapshot, takeSnapshot } from '../../src/audit/snapshot.js';
import { makeRepo, type TempRepo } from './_helpers.js';
import { makeGitCallCounter } from '../helpers/tmp.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

function byPath(diff: Awaited<ReturnType<typeof diffSnapshots>>) {
  return Object.fromEntries(diff.files.map((f) => [f.path, f]));
}

describe('diffSnapshots', () => {
  it('classifies added / modified / deleted with before text from HEAD', async () => {
    const repo = makeRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/gone.ts': 'bye\n',
      'test/a.test.ts': 'it("a", () => { expect(1).toBe(1); });\n',
      'package.json': '{"name":"x"}',
    });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);

    repo.write('src/a.ts', 'export const a = 2;\n');
    repo.write('src/components/Foo.tsx', 'export function Foo() { return null; }\n');
    repo.rm('src/gone.ts');
    repo.write('test/a.test.ts', 'it.skip("a", () => {});\n');
    const after = await takeSnapshot(repo.dir);

    const diff = await diffSnapshots(before, after, repo.dir);
    expect(diff.headMoved).toBe(false);
    const f = byPath(diff);
    expect(Object.keys(f).sort()).toEqual(['src/a.ts', 'src/components/Foo.tsx', 'src/gone.ts', 'test/a.test.ts']);
    expect(f['src/a.ts']).toMatchObject({ kind: 'modified', before: 'export const a = 1;\n', after: 'export const a = 2;\n', isCode: true, isTest: false });
    expect(f['src/components/Foo.tsx']).toMatchObject({ kind: 'added', before: undefined, isCode: true });
    expect(f['src/gone.ts']).toMatchObject({ kind: 'deleted', before: 'bye\n', after: undefined });
    expect(f['test/a.test.ts']).toMatchObject({ kind: 'modified', isTest: true, before: 'it("a", () => { expect(1).toBe(1); });\n' });
  });

  it('is empty when nothing changed and ignores dirty files with the same hash', async () => {
    const repo = makeRepo({ 'src/a.ts': '1' });
    repos.push(repo);
    repo.write('src/a.ts', 'dirty-before');
    const before = await takeSnapshot(repo.dir);
    const after = await takeSnapshot(repo.dir);
    expect((await diffSnapshots(before, after, repo.dir)).files).toEqual([]);
  });

  it('uses the captured pre-task text (not HEAD) for a file that was already dirty', async () => {
    const repo = makeRepo({ 'src/a.ts': 'head\n' });
    repos.push(repo);
    repo.write('src/a.ts', 'prev-task\n');
    const before = await takeSnapshot(repo.dir);
    repo.write('src/a.ts', 'this-task\n');
    const after = await takeSnapshot(repo.dir);
    const f = byPath(await diffSnapshots(before, after, repo.dir));
    expect(f['src/a.ts']).toMatchObject({ kind: 'modified', before: 'prev-task\n', after: 'this-task\n' });
  });

  it('treats a previously-untracked file that got modified as modified, and one that was removed as deleted', async () => {
    const repo = makeRepo({ 'README.md': 'x' });
    repos.push(repo);
    repo.write('src/new.ts', 'v1');
    repo.write('src/tmp.ts', 'tmp');
    const before = await takeSnapshot(repo.dir);
    repo.write('src/new.ts', 'v2');
    repo.rm('src/tmp.ts');
    const after = await takeSnapshot(repo.dir);
    const f = byPath(await diffSnapshots(before, after, repo.dir));
    expect(f['src/new.ts']).toMatchObject({ kind: 'modified', before: 'v1', after: 'v2' });
    expect(f['src/tmp.ts']).toMatchObject({ kind: 'deleted', before: 'tmp' });
  });

  it('detects a revert to HEAD as a modification back to the HEAD text', async () => {
    const repo = makeRepo({ 'src/a.ts': 'head\n' });
    repos.push(repo);
    repo.write('src/a.ts', 'changed\n');
    const before = await takeSnapshot(repo.dir);
    repo.git('checkout', '--', 'src/a.ts');
    const after = await takeSnapshot(repo.dir);
    const f = byPath(await diffSnapshots(before, after, repo.dir));
    expect(f['src/a.ts']).toMatchObject({ kind: 'modified', before: 'changed\n', after: 'head\n' });
  });

  it('folds in committed changes when HEAD moved during the task', async () => {
    const repo = makeRepo({ 'src/a.ts': 'a1\n', 'src/b.ts': 'b1\n' });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/a.ts', 'a2\n');
    repo.write('src/c.ts', 'c1\n');
    repo.rm('src/b.ts');
    repo.commit('task commit');
    repo.write('src/d.ts', 'd1\n'); // left uncommitted
    const after = await takeSnapshot(repo.dir);
    const diff = await diffSnapshots(before, after, repo.dir);
    expect(diff.headMoved).toBe(true);
    const f = byPath(diff);
    expect(f['src/a.ts']).toMatchObject({ kind: 'modified', before: 'a1\n', after: 'a2\n' });
    expect(f['src/b.ts']).toMatchObject({ kind: 'deleted', before: 'b1\n' });
    expect(f['src/c.ts']).toMatchObject({ kind: 'added', after: 'c1\n' });
    expect(f['src/d.ts']).toMatchObject({ kind: 'added', after: 'd1\n' });
  });

  it('handles the first commit on an unborn branch', async () => {
    const repo = makeRepo({}, { commit: false });
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    repo.write('src/a.ts', 'a\n');
    repo.commit('first');
    const after = await takeSnapshot(repo.dir);
    const diff = await diffSnapshots(before, after, repo.dir);
    expect(diff.headMoved).toBe(true);
    expect(byPath(diff)['src/a.ts']).toMatchObject({ kind: 'added', after: 'a\n' });
  });

  it('diffs a base ref against the working tree (fullauto audit --base)', async () => {
    const repo = makeRepo({ 'src/a.ts': 'a1\n' });
    repos.push(repo);
    repo.write('src/a.ts', 'a2\n');
    repo.commit('second');
    repo.write('src/b.ts', 'b\n');
    const base = await takeBaseSnapshot(repo.dir, 'HEAD~1');
    const after = await takeSnapshot(repo.dir);
    const f = byPath(await diffSnapshots(base, after, repo.dir));
    expect(f['src/a.ts']).toMatchObject({ kind: 'modified', before: 'a1\n', after: 'a2\n' });
    expect(f['src/b.ts']).toMatchObject({ kind: 'added' });
  });
});

/**
 * Perf finding (fullauto-cc runtime-efficiency review): `readBefore`'s
 * fallback for a path not captured in `before.contents` (a clean-at-HEAD
 * file the task then modified — routine for a task that edits pre-existing
 * files, not just adds new ones) spawned one `git show <sha>:<path>`
 * PROCESS per file. A task touching hundreds of pre-existing files paid
 * full process-start cost (~7ms measured) that many times over, sequentially,
 * inside the diff loop. `showAtBatch` fetches every such path's pre-task
 * text in ONE `git cat-file --batch` process instead (measured ~19x faster
 * for 50 paths: ~350ms of separate `git show` spawns vs ~18ms batched).
 */
describe('diffSnapshots batches pre-task text lookups into one git process', () => {
  const N = 40;

  function repoWithNCleanFiles(): TempRepo {
    const files: Record<string, string> = {};
    for (let i = 0; i < N; i++) files[`src/f${i}.ts`] = `export const v = ${i};\n`;
    return makeRepo(files);
  }

  it('produces the same before/after text as the (formerly) one-spawn-per-file path', async () => {
    const repo = repoWithNCleanFiles();
    repos.push(repo);
    const before = await takeSnapshot(repo.dir); // nothing dirty: none of the N files is in before.contents
    for (let i = 0; i < N; i++) repo.write(`src/f${i}.ts`, `export const v = ${i + 1000};\n`);
    const after = await takeSnapshot(repo.dir);

    const diff = await diffSnapshots(before, after, repo.dir);
    const f = byPath(diff);
    expect(Object.keys(f)).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      expect(f[`src/f${i}.ts`]).toMatchObject({
        kind: 'modified',
        before: `export const v = ${i};\n`,
        after: `export const v = ${i + 1000};\n`,
      });
    }
  });

  it('spawns exactly one `cat-file` process for N changed pre-existing files, not N `show` processes', async () => {
    const repo = repoWithNCleanFiles();
    repos.push(repo);
    const before = await takeSnapshot(repo.dir);
    for (let i = 0; i < N; i++) repo.write(`src/f${i}.ts`, `export const v = ${i + 1000};\n`);
    const after = await takeSnapshot(repo.dir);

    const counter = await makeGitCallCounter();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`;
      await diffSnapshots(before, after, repo.dir);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(await counter.callsFor('show')).toEqual([]);
    expect((await counter.callsFor('cat-file')).length).toBe(1);
    await counter.cleanup();
  });

  it('is measurably faster than the naive one-`git show`-per-file baseline for the same N paths', async () => {
    const repo = repoWithNCleanFiles();
    repos.push(repo);
    const headSha = repo.git('rev-parse', 'HEAD').trim();
    const paths = Array.from({ length: N }, (_, i) => `src/f${i}.ts`);

    const t0 = performance.now();
    for (const p of paths) repo.git('show', `${headSha}:./${p}`);
    const naiveMs = performance.now() - t0;

    const { showAtBatch } = await import('../../src/audit/git.js');
    const t1 = performance.now();
    const batched = await showAtBatch(repo.dir, headSha, paths);
    const batchedMs = performance.now() - t1;

    expect(batched.size).toBe(N);
    // Generous margin (this only needs to prove the fix, not pin an exact
    // ratio): eliminating N-1 process spawns should easily halve the time.
    expect(batchedMs).toBeLessThan(naiveMs / 2);
  });
});

describe('showAtBatch (src/audit/git.ts)', () => {
  it('returns content for existing paths and omits missing ones, matching git show byte-for-byte', async () => {
    const repo = makeRepo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'line one\nline two (한글 테스트)\n' });
    repos.push(repo);
    const headSha = repo.git('rev-parse', 'HEAD').trim();
    const { showAtBatch } = await import('../../src/audit/git.js');
    const out = await showAtBatch(repo.dir, headSha, ['a.ts', 'b.ts', 'does-not-exist.ts']);
    expect(out.get('a.ts')).toBe('export const a = 1;\n');
    expect(out.get('b.ts')).toBe('line one\nline two (한글 테스트)\n');
    expect(out.has('does-not-exist.ts')).toBe(false);
  });

  it('is empty for an empty path list (no git process needed)', async () => {
    const repo = makeRepo({ 'a.ts': 'x\n' });
    repos.push(repo);
    const { showAtBatch } = await import('../../src/audit/git.js');
    const counter = await makeGitCallCounter();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`;
      const out = await showAtBatch(repo.dir, 'HEAD', []);
      expect(out.size).toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
    expect(await counter.calls()).toEqual([]);
    await counter.cleanup();
  });
});
