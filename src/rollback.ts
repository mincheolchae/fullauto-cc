/**
 * Rollback-on-defer: undo a deferred attempt's working-tree changes so the
 * damage never cascades into the next task.
 *
 * Why: a task that breaks `src/router.mjs` is deferred with `gate_failed`
 * (correct) — but without this, the broken file stays in the shared tree and
 * every later task fails the same gate through no fault of its own, pass
 * after pass. With it, the failing attempt's diff is saved as a patch (so
 * the retry can re-apply the parts that were right) and every touched path
 * is restored to the pre-task state.
 *
 * How, without touching the user's index: a TEMPORARY index file
 * (`GIT_INDEX_FILE`) is filled from HEAD, overlaid with the working tree
 * (`git add -A`, which honours .gitignore) and written out as a tree object.
 * Two such trees — captured before the subagent runs and at defer time —
 * give an exact `git diff` (new files included, unlike a plain
 * `git diff <tree>` against the work tree) and an exact restore list. The
 * restore itself goes through the same temp-index trick
 * (`read-tree` + `checkout-index`) so file modes and symlinks come back
 * intact. `.fullauto/` and generated dirs are excluded from both trees: the
 * orchestrator's own state must never be "rolled back".
 */
import { execFile } from 'node:child_process';
import { rm, unlink, rmdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GENERATED_DIRS } from './audit/patterns.js';
import { paths } from './persistence.js';
import { detachedSpawnOptions, track } from './runner/process-group.js';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `git` with an optional env overlay (the audit's wrapper has none, and
 * GIT_INDEX_FILE is the whole point here).
 *
 * `detached` + `track()`: same reason every OTHER spawn in the codebase is
 * detached (see runner/process-group.ts) — a SIGTERM shutdown mid-restore
 * must reach this child instead of the hard-exit watchdog killing the CLI
 * process out from under it. An untracked `checkout-index` that outlives the
 * CLI can keep mutating the working tree after the process is "gone" and
 * race a subsequent `fullauto resume` on the same repo.
 */
function gitEnv(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf-8',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...env },
          windowsHide: true,
          ...detachedSpawnOptions(),
        },
        (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') {
            resolvePromise({ code: -1, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}\n${err.message}` });
            return;
          }
          resolvePromise({ code: err ? Number((err as NodeJS.ErrnoException).code) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      );
      track(child);
    } catch (e) {
      resolvePromise({ code: -1, stdout: '', stderr: (e as Error).message });
      return;
    }
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

/** Pathspecs that keep orchestrator state and generated trees out of the captured tree. */
function excludePathspecs(): string[] {
  return [...GENERATED_DIRS].map((dir) => `:(exclude,glob)**/${dir}/**`);
}

let tmpIndexSeq = 0;

/** A fresh temp index path under `.fullauto/`; the caller removes it. */
function tmpIndexPath(projectDir: string): string {
  tmpIndexSeq += 1;
  return join(paths(projectDir).fullautoDir, `tmp-index-${process.pid}-${tmpIndexSeq}`);
}

/**
 * Above this many paths, `dirtyPaths` (see `KnownRepoState`) falls back to
 * the blind `add -A -- .` instead of listing them all as CLI args — well
 * past any realistic per-task dirty set, just a guard against pathological
 * resume states and OS argv-length limits.
 */
const MAX_SELECTIVE_ADD_PATHS = 4000;

/**
 * Facts about the repo the caller already established (typically from the
 * `TreeSnapshot` it just took), so `captureTree` doesn't re-derive them with
 * its own `rev-parse` round trips — or re-discover the same dirty set with
 * its own full-tree walk. All optional: pass what you have.
 */
export interface KnownRepoState {
  /** From `TreeSnapshot.gitRepo`. Omit / `undefined` ⇒ `captureTree` checks itself. */
  insideWorkTree?: boolean;
  /** From `TreeSnapshot.headSha` (`null` ⇒ unborn branch). Omit ⇒ `captureTree` checks itself. */
  headSha?: string | null;
  /**
   * Exact paths that differ from HEAD (e.g. `[...snapshot.dirty.keys()]`
   * from a `TreeSnapshot` of the SAME directory, taken with nothing in
   * between). Every OTHER path is, by construction, identical to what
   * `read-tree HEAD` just seeded the temp index with, so `git add` only
   * needs to (re-)stage these — passed as explicit pathspecs instead of
   * `add -A -- .`, which walks and stat's the ENTIRE working tree to
   * rediscover a dirty set the caller already has. `add -A` still handles
   * a path that no longer exists as a removal, so deletions need no special
   * case. Measured on a 3,000-tracked-file / 200-dirty-file repo: `add -A
   * -- .` ~150–250ms vs `add -A -- <200 paths>` ~35ms — the walk scales
   * with repo size, not with how much actually changed. An empty array
   * (nothing dirty) skips the `add` spawn entirely.
   */
  dirtyPaths?: string[];
}

/**
 * Tree object for the working tree as it is now (tracked + untracked,
 * .gitignore honoured, orchestrator state excluded). Null when the
 * directory is not a git work tree or git failed; never throws.
 *
 * `known`: when the caller just took a `TreeSnapshot` of the same
 * directory (nothing in between could have changed repo-ness, HEAD, or
 * what's dirty), pass its `gitRepo` / `headSha` / `dirty` here to skip
 * `captureTree` re-deriving each of them itself — cuts a captureTree call
 * from 5 git spawns to 3, and (with `dirtyPaths`) makes the remaining `add`
 * spawn scale with the dirty set instead of the whole repo (see
 * `src/orchestrator.ts`, which calls this right after `takeSnapshot`).
 */
export async function captureTree(projectDir: string, known?: KnownRepoState): Promise<string | null> {
  const index = tmpIndexPath(projectDir);
  const env = { GIT_INDEX_FILE: index };
  try {
    await mkdir(dirname(index), { recursive: true });
    await rm(index, { force: true });
    let headExists: boolean;
    if (known?.insideWorkTree !== undefined) {
      if (!known.insideWorkTree) return null;
      headExists = known.headSha !== undefined ? known.headSha !== null : (await gitEnv(projectDir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    } else {
      const inside = await gitEnv(projectDir, ['rev-parse', '--is-inside-work-tree']);
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null;
      headExists = (await gitEnv(projectDir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    }
    // Seed from HEAD so files outside `projectDir` (a sub-directory run) and
    // unchanged tracked files are in the tree; an unborn branch has no HEAD
    // and the index simply starts empty.
    if (headExists) {
      const rt = await gitEnv(projectDir, ['read-tree', 'HEAD'], env);
      if (rt.code !== 0) return null;
    }
    const dirtyPaths = known?.dirtyPaths;
    const useDirtyPaths = dirtyPaths !== undefined && dirtyPaths.length <= MAX_SELECTIVE_ADD_PATHS;
    // Nothing dirty (an empty `dirtyPaths`): `read-tree HEAD` alone is
    // already the right tree — skip the `add` spawn entirely.
    if (!useDirtyPaths || dirtyPaths!.length > 0) {
      const targets = useDirtyPaths ? dirtyPaths! : ['.'];
      const add = await gitEnv(projectDir, ['add', '-A', '--', ...targets, ...excludePathspecs()], env);
      if (add.code !== 0) return null;
    }
    const wt = await gitEnv(projectDir, ['write-tree'], env);
    if (wt.code !== 0) return null;
    const sha = wt.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true }).catch(() => undefined);
  }
}

export interface RollbackResult {
  /** Paths that differed between the baseline tree and the tree at defer time. */
  files: number;
  /** Paths restored from the baseline tree (modified / deleted / mode-changed). */
  restored: string[];
  /** Paths that did not exist at baseline and were removed. */
  deleted: string[];
  /**
   * Paths that were SUPPOSED to be restored (present in `restore`) but
   * weren't — a permission error, a locked file, etc. Non-empty means the
   * tree is only PARTIALLY rolled back: the caller must warn loudly instead
   * of reporting a clean rollback, since one of these paths is still
   * carrying the deferred attempt's broken content into the next task.
   */
  failed: string[];
  /** Where the attempt's diff was written (only when `files > 0`). */
  patchPath?: string;
}

/**
 * Save the diff between `baselineTree` and the working tree to `patchPath`,
 * then restore every differing path to its baseline state. Returns null
 * when git failed before anything was changed; a partially failed restore
 * still returns what it managed (the caller reports the counts).
 */
export async function rollbackToTree(projectDir: string, baselineTree: string, patchPath: string): Promise<RollbackResult | null> {
  const afterTree = await captureTree(projectDir);
  if (!afterTree) return null;
  const result: RollbackResult = { files: 0, restored: [], deleted: [], failed: [] };
  if (afterTree === baselineTree) return result;

  // `--relative` makes the restore list cwd-relative (a sub-directory run);
  // the patch keeps repo-root paths so `git apply` works from anywhere.
  const status = await gitEnv(projectDir, ['diff', '--name-status', '-z', '--no-renames', '--relative', baselineTree, afterTree, '--', '.']);
  if (status.code !== 0) return null;
  const parts = status.stdout.split('\0');
  const added: string[] = [];
  const restore: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kind = parts[i];
    const path = parts[i + 1];
    if (!kind || !path) continue;
    if (kind[0] === 'A') added.push(path);
    else restore.push(path);
  }
  result.files = added.length + restore.length;
  if (result.files === 0) return result;

  const patch = await gitEnv(projectDir, ['diff', '--binary', '--no-renames', baselineTree, afterTree, '--', '.']);
  if (patch.code === 0) {
    try {
      await mkdir(dirname(patchPath), { recursive: true });
      await writeFile(patchPath, patch.stdout, 'utf-8');
      result.patchPath = patchPath;
    } catch {
      // The patch is a convenience for the retry; the restore below still
      // matters more than keeping it.
    }
  }

  // Restore modified / deleted paths from the baseline tree through a temp
  // index (modes and symlinks included), never through the user's index.
  if (restore.length > 0) {
    const index = tmpIndexPath(projectDir);
    const env = { GIT_INDEX_FILE: index };
    try {
      await rm(index, { force: true });
      const rt = await gitEnv(projectDir, ['read-tree', baselineTree], env);
      if (rt.code !== 0) {
        // Nothing could be restored — every path stays broken.
        result.failed = [...restore];
      } else {
        const co = await gitEnv(projectDir, ['checkout-index', '-f', '-z', '--stdin'], env, restore.join('\0') + '\0');
        if (co.code === 0) {
          result.restored = restore;
        } else {
          // Partial failure (e.g. a permission-denied path): the batch exit
          // code alone cannot tell us WHICH paths actually landed, and the
          // other paths in the batch typically DO restore fine (checkout-index
          // keeps going past one bad entry) — retry one path at a time so
          // `restored` / `failed` reflect what really happened instead of
          // reporting "0 restored" when most of the tree came back clean.
          for (const path of restore) {
            const one = await gitEnv(projectDir, ['checkout-index', '-f', '-z', '--stdin'], env, `${path}\0`);
            if (one.code === 0) result.restored.push(path);
            else result.failed.push(path);
          }
        }
      }
    } finally {
      await rm(index, { force: true }).catch(() => undefined);
    }
  }

  // New files: delete, then prune the directories the attempt created.
  const root = resolve(projectDir);
  for (const path of added) {
    const abs = resolve(root, path);
    if (!abs.startsWith(root + '/') && abs !== root) continue; // defensive: never leave the project
    try {
      await unlink(abs);
      result.deleted.push(path);
    } catch {
      continue;
    }
    let dir = dirname(abs);
    while (dir.startsWith(root + '/')) {
      try {
        await rmdir(dir);
      } catch {
        break; // not empty (or gone): stop climbing
      }
      dir = dirname(dir);
    }
  }
  return result;
}
