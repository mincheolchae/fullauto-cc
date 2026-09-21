/**
 * Working-tree snapshot: HEAD sha + fingerprints of every dirty path.
 *
 * Built from `git status --porcelain=v1 -z -uall --no-renames`, so cost is
 * proportional to the number of dirty files, not the repo size. Paths are
 * made relative to `projectDir` (which may be a sub-directory of the repo).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git, headSha, isGitRepo } from './git.js';
import { GENERATED_DIRS, isCodeFile, isGateConfigFile, isGeneratedPath, isTestFile } from './patterns.js';
import type { FileFingerprint, TreeSnapshot } from './types.js';

/** Files larger than this are fingerprinted by size only (`size:<n>`). */
export const HASH_SIZE_LIMIT = 5 * 1024 * 1024;
/** Per-file cap for contents kept in the snapshot. */
export const CONTENT_SIZE_LIMIT = 512 * 1024;
/**
 * Total budget for retained contents per snapshot. Test + gate-config files
 * are stored first (the spec requires them); code files are stored with
 * whatever budget remains so `diffSnapshots` can see the *real* pre-task
 * text of files a previous (uncommitted) task already touched instead of
 * falling back to the stale HEAD version.
 */
export const CONTENT_TOTAL_BUDGET = 48 * 1024 * 1024;

export const DELETED_HASH = 'deleted';
/**
 * The path exists (stat succeeded) but its content could not be read (mode
 * 000, EIO...). Distinct from `deleted` so an unreadable test file is never
 * reported as a deleted one; `diffSnapshots` skips content checks for it.
 */
export const UNREADABLE_HASH = 'unreadable';

/**
 * Pathspecs that keep `git status` from walking generated / vendored trees
 * in a project that has no `.gitignore` yet (right after a greenfield setup
 * task `node_modules/` alone is tens of thousands of untracked entries).
 */
function generatedExcludes(): string[] {
  const out: string[] = [];
  for (const dir of GENERATED_DIRS) out.push(`:(exclude,glob)**/${dir}/**`, `:(exclude)${dir}/`);
  return out;
}

export function emptySnapshot(gitRepo = false): TreeSnapshot {
  return {
    takenAt: new Date().toISOString(),
    headSha: null,
    dirty: new Map(),
    contents: new Map(),
    gitRepo,
  };
}

export async function sha1File(absPath: string, size?: number): Promise<string> {
  const n = size ?? (await stat(absPath)).size;
  if (n > HASH_SIZE_LIMIT) return `size:${n}`;
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    const s = createReadStream(absPath);
    s.on('error', reject);
    s.on('data', (chunk) => h.update(chunk));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function sha1String(content: string): string {
  return createHash('sha1').update(content, 'utf-8').digest('hex');
}

interface StatusEntry {
  status: string; // XY
  path: string; // relative to projectDir
}

/**
 * Parse `-z` porcelain v1 output. With `--no-renames` every entry is
 * `XY<space><path>\0`; paths are repo-root-relative so `prefix` (from
 * `git rev-parse --show-prefix`) is stripped and entries outside it dropped.
 */
export function parsePorcelainZ(raw: string, prefix = ''): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const entry of raw.split('\0')) {
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    let path = entry.slice(3);
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    if (!path) continue;
    out.push({ status, path });
  }
  return out;
}

export async function takeSnapshot(projectDir: string): Promise<TreeSnapshot> {
  if (!(await isGitRepo(projectDir))) return emptySnapshot(false);

  const snap = emptySnapshot(true);
  snap.headSha = await headSha(projectDir);

  const prefixRes = await git(projectDir, ['rev-parse', '--show-prefix']);
  const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : '';

  const statusRes = await git(projectDir, [
    'status', '--porcelain=v1', '-z', '-uall', '--no-renames', '--', '.', ...generatedExcludes(),
  ]);
  if (statusRes.code !== 0) return snap;

  const entries = parsePorcelainZ(statusRes.stdout, prefix);
  let budget = CONTENT_TOTAL_BUDGET;
  const deferredCode: Array<{ path: string; size: number }> = [];

  for (const { status, path } of entries) {
    // Belt and braces with the pathspec above (older git ignores `:(exclude,glob)`):
    // generated / vendored / orchestrator-state paths are never part of a task's diff.
    if (isGeneratedPath(path)) continue;
    const abs = join(projectDir, path);
    let fp: FileFingerprint;
    let size = 0;
    let exists = true;
    try {
      // lstat: a symlink is skipped outright rather than followed (it may
      // point outside the repo; its target is not this task's artifact).
      const st = await lstat(abs);
      if (st.isSymbolicLink() || !st.isFile()) continue; // symlink / submodule / dir entry
      size = st.size;
      let hash: string;
      try {
        hash = await sha1File(abs, size);
      } catch {
        hash = UNREADABLE_HASH;
      }
      fp = { path, hash, size, status };
    } catch {
      exists = false;
      fp = { path, hash: DELETED_HASH, size: 0, status };
    }
    snap.dirty.set(path, fp);
    if (!exists || fp.hash === UNREADABLE_HASH || size > CONTENT_SIZE_LIMIT) continue;
    if (isTestFile(path) || isGateConfigFile(path)) {
      try {
        snap.contents.set(path, await readFile(abs, 'utf-8'));
        budget -= size;
      } catch { /* unreadable: skip */ }
    } else if (isCodeFile(path)) {
      deferredCode.push({ path, size });
    }
  }

  for (const { path, size } of deferredCode) {
    if (budget - size < 0) break;
    try {
      snap.contents.set(path, await readFile(join(projectDir, path), 'utf-8'));
      budget -= size;
    } catch { /* skip */ }
  }

  return snap;
}

/**
 * Synthetic "before" snapshot representing the clean tree at `ref` (default
 * HEAD). Used by `fullauto audit [--base <ref>]`: diffing it against a real
 * `takeSnapshot()` yields every change between `ref` and the working tree.
 */
export async function takeBaseSnapshot(projectDir: string, ref = 'HEAD'): Promise<TreeSnapshot> {
  if (!(await isGitRepo(projectDir))) return emptySnapshot(false);
  const snap = emptySnapshot(true);
  const r = await git(projectDir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  snap.headSha = r.code === 0 ? r.stdout.trim() : null;
  return snap;
}
