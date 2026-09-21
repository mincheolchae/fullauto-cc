import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePorcelainZ, takeBaseSnapshot, takeSnapshot } from '../../src/audit/snapshot.js';
import { makeRepo, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

describe('takeSnapshot', () => {
  it('returns an empty non-git snapshot for a plain directory', async () => {
    const repo = makeRepo({ 'a.ts': 'x' }, { git: false });
    repos.push(repo);
    const snap = await takeSnapshot(repo.dir);
    expect(snap.headSha).toBeNull();
    expect(snap.gitRepo).toBe(false);
    expect(snap.dirty.size).toBe(0);
    expect(snap.contents.size).toBe(0);
  });

  it('records HEAD and no dirty files for a clean repo', async () => {
    const repo = makeRepo({ 'src/a.ts': 'export const a = 1;\n' });
    repos.push(repo);
    const snap = await takeSnapshot(repo.dir);
    expect(snap.gitRepo).toBe(true);
    expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.dirty.size).toBe(0);
  });

  it('handles an unborn branch (git init without commits)', async () => {
    const repo = makeRepo({ 'src/a.ts': 'x' }, { commit: false });
    repos.push(repo);
    const snap = await takeSnapshot(repo.dir);
    expect(snap.gitRepo).toBe(true);
    expect(snap.headSha).toBeNull();
    expect(snap.dirty.get('src/a.ts')?.status).toBe('??');
  });

  it('fingerprints untracked / modified / deleted files and keeps test + gate-config contents', async () => {
    const repo = makeRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/gone.ts': 'bye',
      'package.json': '{"scripts":{"test":"vitest run"}}',
      'test/a.test.ts': 'it("x", () => expect(1).toBe(1));',
    });
    repos.push(repo);
    repo.write('src/a.ts', 'export const a = 2;\n');
    repo.write('src/new/deep/b.ts', 'export const b = 1;\n');
    repo.write('package.json', '{"scripts":{"test":"vitest run --passWithNoTests"}}');
    repo.write('test/a.test.ts', 'it.skip("x", () => {});');
    repo.rm('src/gone.ts');

    const snap = await takeSnapshot(repo.dir);
    expect([...snap.dirty.keys()].sort()).toEqual(['package.json', 'src/a.ts', 'src/gone.ts', 'src/new/deep/b.ts', 'test/a.test.ts']);
    expect(snap.dirty.get('src/new/deep/b.ts')?.status).toBe('??');
    expect(snap.dirty.get('src/a.ts')?.status).toBe(' M');
    expect(snap.dirty.get('src/a.ts')?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.dirty.get('src/gone.ts')).toMatchObject({ hash: 'deleted', size: 0 });
    expect(snap.contents.get('package.json')).toContain('passWithNoTests');
    expect(snap.contents.get('test/a.test.ts')).toContain('it.skip');
    // dirty code files are retained too (budget permitting) so diffs see the real pre-task text
    expect(snap.contents.get('src/a.ts')).toBe('export const a = 2;\n');
  });

  it('uses a size-only fingerprint for files over 5MB', async () => {
    const repo = makeRepo({ 'README.md': 'x' });
    repos.push(repo);
    const big = join(repo.dir, 'big.bin');
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    const snap = await takeSnapshot(repo.dir);
    expect(snap.dirty.get('big.bin')?.hash).toBe(`size:${5 * 1024 * 1024 + 1}`);
    expect(snap.contents.has('big.bin')).toBe(false);
  });

  it('makes paths relative to a sub-directory of the repo', async () => {
    const repo = makeRepo({ 'packages/web/src/a.ts': 'x', 'packages/api/src/b.ts': 'y' });
    repos.push(repo);
    repo.write('packages/web/src/new.ts', 'n');
    repo.write('packages/api/src/other.ts', 'o');
    const snap = await takeSnapshot(join(repo.dir, 'packages/web'));
    expect([...snap.dirty.keys()]).toEqual(['src/new.ts']);
  });
});

describe('parsePorcelainZ', () => {
  it('parses XY status + path entries and strips a prefix', () => {
    const raw = '?? a.ts\0 M src/b.ts\0D  c.ts\0';
    expect(parsePorcelainZ(raw)).toEqual([
      { status: '??', path: 'a.ts' },
      { status: ' M', path: 'src/b.ts' },
      { status: 'D ', path: 'c.ts' },
    ]);
    expect(parsePorcelainZ('?? web/x.ts\0?? api/y.ts\0', 'web/')).toEqual([{ status: '??', path: 'x.ts' }]);
  });
});

describe('takeBaseSnapshot', () => {
  it('resolves a ref to a clean synthetic snapshot', async () => {
    const repo = makeRepo({ 'a.ts': '1' });
    repos.push(repo);
    const first = repo.git('rev-parse', 'HEAD').trim();
    repo.write('a.ts', '2');
    repo.commit('second');
    const base = await takeBaseSnapshot(repo.dir, 'HEAD~1');
    expect(base.headSha).toBe(first);
    expect(base.dirty.size).toBe(0);
    expect(base.gitRepo).toBe(true);
    const bad = await takeBaseSnapshot(repo.dir, 'no-such-ref');
    expect(bad.headSha).toBeNull();
  });
});

describe('takeSnapshot — generated paths, symlinks, unreadable files', () => {
  it('never lists node_modules / dist / coverage / .fullauto entries, even without a .gitignore', async () => {
    const repo = makeRepo({ 'README.md': 'x' });
    repos.push(repo);
    repo.write('node_modules/x/test/a.test.js', "it('a', () => {});");
    repo.write('packages/web/node_modules/y/index.js', '1');
    repo.write('dist/app.js', '1');
    repo.write('coverage/index.html', '1');
    repo.write('.fullauto/state.json', '{}');
    repo.write('src/real.ts', 'export const r = 1;\n');
    const snap = await takeSnapshot(repo.dir);
    expect([...snap.dirty.keys()]).toEqual(['src/real.ts']);
  });

  it('skips symlinks instead of following them, and records an unreadable file as `unreadable` (not deleted)', async () => {
    const repo = makeRepo({ 'README.md': 'x' });
    repos.push(repo);
    const fs = await import('node:fs');
    fs.symlinkSync('/etc/hosts', join(repo.dir, 'src-link.ts'));
    repo.write('test/secret.test.ts', "it('s', () => { expect(1).toBe(1); });\n");
    fs.chmodSync(join(repo.dir, 'test/secret.test.ts'), 0o000);
    try {
      const snap = await takeSnapshot(repo.dir);
      expect(snap.dirty.has('src-link.ts')).toBe(false);
      const fp = snap.dirty.get('test/secret.test.ts');
      // root can read anything; only assert the distinction when the read actually failed
      if (fp?.hash === 'unreadable') {
        expect(fp).toMatchObject({ hash: 'unreadable', status: '??' });
        expect(snap.contents.has('test/secret.test.ts')).toBe(false);
        const { diffSnapshots } = await import('../../src/audit/diff.js');
        const diff = await diffSnapshots({ ...snap, dirty: new Map(), contents: new Map() }, snap, repo.dir);
        expect(diff.files.find((f) => f.path === 'test/secret.test.ts')).toMatchObject({ kind: 'added', after: undefined });
      } else {
        expect(fp?.hash).toMatch(/^[0-9a-f]{40}$/);
      }
    } finally {
      fs.chmodSync(join(repo.dir, 'test/secret.test.ts'), 0o644);
    }
  });
});
