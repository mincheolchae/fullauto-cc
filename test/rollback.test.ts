import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureTree, rollbackToTree } from '../src/rollback.js';
import { makeGitRepo, makeTmpDir, writeFiles, cleanup, git, makeGitCallCounter, type GitCallCounter } from './helpers/tmp.js';

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

/**
 * Perf finding (fullauto-cc runtime-efficiency review): `captureTree` did
 * `rev-parse --is-inside-work-tree` + `rev-parse --verify -q HEAD` on EVERY
 * call, even though its one real caller (`src/orchestrator.ts`) had just
 * taken a `TreeSnapshot` and already knows both answers — those two spawns
 * were re-asking a question the caller could already answer, on every task
 * attempt (`rollbackOnDefer` defaults to on). Passing `known` skips them.
 */
describe('captureTree(dir, known) skips its own rev-parse calls when the caller already knows the repo state', () => {
  let counter: GitCallCounter;
  let originalPath: string | undefined;
  let headSha: string;

  beforeEach(async () => {
    // Real git, real PATH — computed BEFORE the shim goes on so this setup
    // call itself is never counted as one of captureTree's own spawns.
    headSha = git(['rev-parse', 'HEAD'], repo).trim();
    counter = await makeGitCallCounter();
    originalPath = process.env.PATH;
    process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await counter.cleanup();
  });

  it('produces the exact same tree sha as the unknown-state path (behavior unchanged)', async () => {
    const withoutKnown = await captureTree(repo);
    const withKnown = await captureTree(repo, { insideWorkTree: true, headSha });
    expect(withKnown).toMatch(/^[0-9a-f]{40}$/);
    expect(withKnown).toBe(withoutKnown);
  });

  it('baseline (no `known`): 5 git spawns, including both rev-parse calls', async () => {
    await captureTree(repo);
    expect((await counter.callsFor('rev-parse')).length).toBe(2);
    expect((await counter.calls()).length).toBe(5);
  });

  it('with `known`: 3 git spawns — zero rev-parse calls, read-tree/add/write-tree unchanged', async () => {
    await captureTree(repo, { insideWorkTree: true, headSha });
    expect(await counter.callsFor('rev-parse')).toEqual([]);
    expect((await counter.callsFor('read-tree')).length).toBe(1);
    expect((await counter.callsFor('add')).length).toBe(1);
    expect((await counter.callsFor('write-tree')).length).toBe(1);
    expect((await counter.calls()).length).toBe(3);
  });

  it('`insideWorkTree: false` still bails out null without spawning read-tree/add/write-tree', async () => {
    expect(await captureTree(repo, { insideWorkTree: false })).toBeNull();
    expect(await counter.calls()).toEqual([]);
  });

  it('an unborn branch (`headSha: null`) still starts the tree empty instead of trying read-tree HEAD', async () => {
    const fresh = await makeTmpDir('rollback-unborn-known-');
    try {
      git(['init', '-q', '-b', 'main'], fresh);
      await writeFile(join(fresh, 'x.txt'), 'x\n', 'utf-8');
      const tree = await captureTree(fresh, { insideWorkTree: true, headSha: null });
      expect(tree).toMatch(/^[0-9a-f]{40}$/);
      expect(git(['ls-tree', '-r', '--name-only', tree!], fresh).trim()).toBe('x.txt');
      expect(await counter.callsFor('rev-parse')).toEqual([]);
      expect(await counter.callsFor('read-tree')).toEqual([]); // no HEAD to seed from
    } finally {
      await cleanup(fresh);
    }
  });
});

/**
 * Perf finding (fullauto-cc runtime-efficiency review), rollback.ts §6: the
 * captured tree is built by seeding a temp index from HEAD then running
 * `git add -A -- .`, which STATS AND RE-HASHES EVERY TRACKED FILE in the
 * repo to rediscover what changed — even though the caller (`takeSnapshot`,
 * called immediately before) already knows exactly which paths are dirty.
 * Measured on a synthetic 3,000-tracked-file repo with 200 dirty: `add -A
 * -- .` ~150–250ms vs `add -A -- <the 200 dirty paths>` ~35ms. `dirtyPaths`
 * makes `captureTree` use the caller's already-known dirty set instead of
 * re-discovering it via a full working-tree walk.
 */
describe('captureTree(dir, { dirtyPaths }) narrows `add` to the known-dirty set instead of walking the whole tree', () => {
  let counter: GitCallCounter;
  let originalPath: string | undefined;
  let headSha: string;
  let dirtyPaths: string[];

  beforeEach(async () => {
    headSha = git(['rev-parse', 'HEAD'], repo).trim();
    // The exact dirty set `takeSnapshot` would report for this fixture
    // (tracked-modified, staged-modified, untracked — `build/` and
    // `.fullauto/` are gitignored and excluded, same as takeSnapshot).
    dirtyPaths = ['src/a.txt', 'src/b.txt', 'src/untracked-pre.txt'];
    counter = await makeGitCallCounter();
    originalPath = process.env.PATH;
    process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`;
  });

  afterEach(async () => {
    process.env.PATH = originalPath;
    await counter.cleanup();
  });

  it('produces the exact same tree sha as a full `add -A -- .` (behavior unchanged)', async () => {
    const full = await captureTree(repo, { insideWorkTree: true, headSha });
    const narrowed = await captureTree(repo, { insideWorkTree: true, headSha, dirtyPaths });
    expect(narrowed).toMatch(/^[0-9a-f]{40}$/);
    expect(narrowed).toBe(full);
  });

  it('still stages a deletion named in `dirtyPaths` (git add -A removes, not just modifies/adds)', async () => {
    await rm(join(repo, 'src', 'gone.txt'));
    const full = await captureTree(repo, { insideWorkTree: true, headSha });
    const narrowed = await captureTree(repo, { insideWorkTree: true, headSha, dirtyPaths: [...dirtyPaths, 'src/gone.txt'] });
    expect(narrowed).toBe(full);
    expect(git(['ls-tree', '-r', '--name-only', narrowed!], repo).trim().split('\n')).not.toContain('src/gone.txt');
  });

  it('an empty `dirtyPaths` (nothing dirty) skips the `add` spawn entirely — read-tree HEAD alone is already right', async () => {
    process.env.PATH = originalPath; // real git for fixture setup (`makeGitRepo` itself runs `git add -A`)
    const clean = await makeGitRepo({ 'x.txt': 'x\n' });
    const cleanHeadSha = git(['rev-parse', 'HEAD'], clean).trim();
    const expectedTree = git(['rev-parse', `${cleanHeadSha}^{tree}`], clean).trim();
    process.env.PATH = `${counter.pathPrefix}:${originalPath ?? ''}`; // shim back on for the call under test
    try {
      const tree = await captureTree(clean, { insideWorkTree: true, headSha: cleanHeadSha, dirtyPaths: [] });
      expect(tree).toBe(expectedTree);
      expect(await counter.callsFor('add')).toEqual([]);
    } finally {
      await cleanup(clean);
    }
  });

  it('uses `dirtyPaths` as explicit `add` targets instead of `.`', async () => {
    await captureTree(repo, { insideWorkTree: true, headSha, dirtyPaths });
    const addCalls = await counter.callsFor('add');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).not.toContain(' -- . ');
    for (const p of dirtyPaths) expect(addCalls[0]).toContain(p);
  });

  it('is measurably faster than a blind `add -A -- .` on a repo with many tracked files', async () => {
    process.env.PATH = originalPath; // real git for the fixture build (not counted / not shimmed)
    const big = await makeTmpDir('rollback-big-repo-');
    try {
      git(['init', '-q', '-b', 'main'], big);
      const files: Record<string, string> = {};
      for (let i = 0; i < 1500; i++) files[`src/dir${i % 30}/f${i}.ts`] = `export const v = ${i};\n`;
      await writeFiles(big, files);
      git(['add', '-A'], big);
      git(['commit', '-q', '-m', 'baseline'], big);
      // Dirty a small subset — the realistic case `dirtyPaths` targets.
      const dirty: string[] = [];
      for (let i = 0; i < 60; i++) {
        const p = `src/dir${i % 30}/f${i}.ts`;
        await writeFile(join(big, p), `export const v = ${i + 1000};\n`, 'utf-8');
        dirty.push(p);
      }
      const bigHeadSha = git(['rev-parse', 'HEAD'], big).trim();

      const t0 = performance.now();
      const full = await captureTree(big, { insideWorkTree: true, headSha: bigHeadSha });
      const fullMs = performance.now() - t0;

      const t1 = performance.now();
      const narrowed = await captureTree(big, { insideWorkTree: true, headSha: bigHeadSha, dirtyPaths: dirty });
      const narrowedMs = performance.now() - t1;

      expect(narrowed).toBe(full);
      // Generous margin: proves the fix, doesn't pin an exact ratio.
      expect(narrowedMs).toBeLessThan(fullMs / 1.5);
    } finally {
      await cleanup(big);
    }
  }, 20_000);
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
