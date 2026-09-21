import { afterEach, describe, expect, it } from 'vitest';
import { diffSnapshots } from '../../src/audit/diff.js';
import { takeBaseSnapshot, takeSnapshot } from '../../src/audit/snapshot.js';
import { makeRepo, type TempRepo } from './_helpers.js';

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
