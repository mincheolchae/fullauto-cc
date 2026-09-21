import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureTree, rollbackToTree } from '../src/rollback.js';
import { makeGitRepo, makeTmpDir, writeFiles, cleanup, git } from './helpers/tmp.js';

let repo: string;

beforeEach(async () => {
  repo = await makeGitRepo({
    '.gitignore': '.fullauto/\nbuild/\n',
    'src/a.txt': 'one\n',
    'src/b.txt': 'keep\n',
    'src/gone.txt': 'to be deleted\n',
  });
  // Pre-task dirt: an unstaged edit, a staged edit, an untracked file, and
  // ignored + orchestrator-state files that must never be part of a tree.
  await writeFiles(repo, {
    'src/b.txt': 'keep\ndirty-pre\n',
    'src/untracked-pre.txt': 'untracked-pre\n',
    'build/out.js': 'ignored\n',
    '.fullauto/state.json': '{"state":true}\n',
  });
  await writeFile(join(repo, 'src', 'a.txt'), 'one\nstaged\n', 'utf-8');
  git(['add', 'src/a.txt'], repo);
});

afterEach(async () => {
  await cleanup(repo);
});

describe('captureTree', () => {
  it('returns a tree of tracked + untracked files honouring .gitignore, excluding .fullauto, without touching the index', async () => {
    const indexBefore = git(['diff', '--cached', '--name-only'], repo);
    const tree = await captureTree(repo);
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    const listed = git(['ls-tree', '-r', '--name-only', tree!], repo).trim().split('\n').sort();
    expect(listed).toEqual(['.gitignore', 'src/a.txt', 'src/b.txt', 'src/gone.txt', 'src/untracked-pre.txt']);
    // Working-tree content, not HEAD's.
    expect(git(['show', `${tree}:src/b.txt`], repo)).toBe('keep\ndirty-pre\n');
    // The user's real index is exactly as before (a.txt still staged, nothing else).
    expect(git(['diff', '--cached', '--name-only'], repo)).toBe(indexBefore);
    expect(indexBefore.trim()).toBe('src/a.txt');
    // No temp index left behind.
    const leftovers = (await import('node:fs/promises')).readdir(join(repo, '.fullauto'));
    expect((await leftovers).filter((f) => f.startsWith('tmp-index'))).toEqual([]);
  });

  it('is null outside a git work tree', async () => {
    const plain = await makeTmpDir('rollback-nongit-');
    try {
      await writeFile(join(plain, 'x.txt'), 'x\n', 'utf-8');
      expect(await captureTree(plain)).toBeNull();
    } finally {
      await cleanup(plain);
    }
  });

  it('works on an unborn branch (no HEAD yet)', async () => {
    const fresh = await makeTmpDir('rollback-unborn-');
    try {
      git(['init', '-q', '-b', 'main'], fresh);
      await writeFile(join(fresh, 'x.txt'), 'x\n', 'utf-8');
      const tree = await captureTree(fresh);
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(git(['ls-tree', '-r', '--name-only', tree!], fresh).trim()).toBe('x.txt');
    } finally {
      await cleanup(fresh);
    }
  });
});

describe('rollbackToTree', () => {
  it('saves the diff as a patch and restores modified / deleted / added / mode-changed / untracked-at-baseline paths', async () => {
    const baseline = (await captureTree(repo))!;
    const patchPath = join(repo, '.fullauto', 'logs', 'T001-attempt1.patch');

    // The "attempt": modify tracked + untracked-at-baseline files, delete
    // one, add files in a new directory, flip a mode.
    await writeFiles(repo, {
      'src/a.txt': 'two\n',
      'src/untracked-pre.txt': 'changed by the task\n',
      'src/new/deep/n.txt': 'new\n',
      'build/out.js': 'ignored change\n',
    });
    await rm(join(repo, 'src', 'gone.txt'));
    await chmod(join(repo, 'src', 'b.txt'), 0o755);

    const res = await rollbackToTree(repo, baseline, patchPath);
    expect(res).not.toBeNull();
    expect(res!.files).toBe(5);
    expect(res!.restored.sort()).toEqual(['src/a.txt', 'src/b.txt', 'src/gone.txt', 'src/untracked-pre.txt']);
    expect(res!.deleted).toEqual(['src/new/deep/n.txt']);
    expect(res!.patchPath).toBe(patchPath);

    // Tree is back to the baseline (working-tree content at capture time).
    expect(await readFile(join(repo, 'src', 'a.txt'), 'utf-8')).toBe('one\nstaged\n');
    expect(await readFile(join(repo, 'src', 'b.txt'), 'utf-8')).toBe('keep\ndirty-pre\n');
    expect((await stat(join(repo, 'src', 'b.txt'))).mode & 0o111).toBe(0);
    expect(await readFile(join(repo, 'src', 'gone.txt'), 'utf-8')).toBe('to be deleted\n');
    expect(await readFile(join(repo, 'src', 'untracked-pre.txt'), 'utf-8')).toBe('untracked-pre\n');
    expect(existsSync(join(repo, 'src', 'new'))).toBe(false); // empty dirs pruned
    // Ignored files are outside the rollback's scope.
    expect(await readFile(join(repo, 'build', 'out.js'), 'utf-8')).toBe('ignored change\n');
    // The user's index is untouched (a.txt is still the staged version).
    expect(git(['diff', '--cached', '--name-only'], repo).trim()).toBe('src/a.txt');

    // The patch re-applies the attempt exactly.
    const patch = await readFile(patchPath, 'utf-8');
    expect(patch).toContain('--- a/src/a.txt');
    expect(patch).toContain('+two');
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('+++ b/src/new/deep/n.txt');
    expect(patch).toContain('deleted file mode 100644');
    expect(patch).toContain('old mode 100644\nnew mode 100755');
    git(['apply', patchPath], repo);
    expect(await readFile(join(repo, 'src', 'a.txt'), 'utf-8')).toBe('two\n');
    expect(await readFile(join(repo, 'src', 'new', 'deep', 'n.txt'), 'utf-8')).toBe('new\n');
    expect(existsSync(join(repo, 'src', 'gone.txt'))).toBe(false);
    expect((await stat(join(repo, 'src', 'b.txt'))).mode & 0o111).not.toBe(0);
  });

  it('a partial restore failure (permission denied on one path) is reported in `failed`, not silently folded into "0 restored" (round 3, item 2 follow-up)', async () => {
    // Non-root only: root ignores the write-permission bit this repro
    // depends on (unlink on a 555 directory would just succeed), which
    // would make the assertions below false-fail on a root test runner.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    await mkdir(join(repo, 'src', 'locked'), { recursive: true });
    await writeFile(join(repo, 'src', 'locked', 'f.txt'), 'orig\n', 'utf-8');
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', 'add locked dir'], repo);
    const baseline = (await captureTree(repo))!;
    const patchPath = join(repo, '.fullauto', 'logs', 'T001-attempt1.patch');

    // The "attempt": changes a normal file AND a file inside a directory
    // that then loses its write bit before rollback runs — `checkout-index`
    // cannot unlink-and-recreate a file in a directory it cannot write to,
    // so this ONE path fails while everything else restores fine.
    await writeFiles(repo, { 'src/a.txt': 'two\n', 'src/locked/f.txt': 'changed\n' });
    await chmod(join(repo, 'src', 'locked'), 0o555);
    try {
      const res = await rollbackToTree(repo, baseline, patchPath);
      expect(res).not.toBeNull();
      expect(res!.restored).toEqual(['src/a.txt']);
      expect(res!.failed).toEqual(['src/locked/f.txt']);
      // The tree really is only partially rolled back — the un-restorable
      // path still carries the attempt's change, exactly what `failed`
      // exists to make visible instead of misreporting a clean rollback.
      expect(await readFile(join(repo, 'src', 'a.txt'), 'utf-8')).toBe('one\nstaged\n');
      expect(await readFile(join(repo, 'src', 'locked', 'f.txt'), 'utf-8')).toBe('changed\n');
    } finally {
      // Restore write access so afterEach's cleanup() can rm() the tree.
      await chmod(join(repo, 'src', 'locked'), 0o755);
    }
  });

  it('reports zero files and writes no patch when nothing changed', async () => {
    const baseline = (await captureTree(repo))!;
    const patchPath = join(repo, '.fullauto', 'logs', 'T001-attempt1.patch');
    const res = await rollbackToTree(repo, baseline, patchPath);
    expect(res).toEqual({ files: 0, restored: [], deleted: [], failed: [] });
    expect(existsSync(patchPath)).toBe(false);
  });

  it('a change that only touched an ignored path is not a change', async () => {
    const baseline = (await captureTree(repo))!;
    await mkdir(join(repo, 'build'), { recursive: true });
    await writeFile(join(repo, 'build', 'other.js'), 'x\n', 'utf-8');
    const res = await rollbackToTree(repo, baseline, join(repo, '.fullauto', 'logs', 'p.patch'));
    expect(res?.files).toBe(0);
  });

  it('returns null (and changes nothing) outside a git repo', async () => {
    const plain = await makeTmpDir('rollback-nongit-');
    try {
      await writeFile(join(plain, 'x.txt'), 'x\n', 'utf-8');
      expect(await rollbackToTree(plain, '0'.repeat(40), join(plain, 'p.patch'))).toBeNull();
      expect(await readFile(join(plain, 'x.txt'), 'utf-8')).toBe('x\n');
    } finally {
      await cleanup(plain);
    }
  });
});
