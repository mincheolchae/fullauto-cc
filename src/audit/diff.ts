/**
 * Resolve two snapshots into a list of changed files with before/after text.
 *
 * Rules (see DESIGN §6):
 *  - in `after.dirty` but not `before.dirty`   → added (untracked) / modified (tracked) / deleted
 *  - same path, different hash                  → modified (or deleted / re-added)
 *  - in `before.dirty` but not `after.dirty`    → deleted, or reverted / committed (check disk)
 *  - HEAD moved                                 → also fold in `git diff --name-status before..after`
 *
 * `before` text: `before.contents` when captured, else `git show <before.headSha>:path`.
 * `after` text: the file on disk.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { git, showAt } from './git.js';
import { isCodeFile, isGateConfigFile, isGeneratedPath, isTestFile } from './patterns.js';
import { DELETED_HASH, sha1File } from './snapshot.js';
import type { ChangedFile, ChangeKind, TreeSnapshot, TaskDiff } from './types.js';

const READ_LIMIT = 2 * 1024 * 1024;

async function readAfter(projectDir: string, path: string): Promise<string | undefined> {
  const abs = join(projectDir, path);
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > READ_LIMIT) return undefined;
    return await readFile(abs, 'utf-8');
  } catch {
    return undefined;
  }
}

async function exists(projectDir: string, path: string): Promise<boolean> {
  try {
    return (await stat(join(projectDir, path))).isFile();
  } catch {
    return false;
  }
}

async function readBefore(before: TreeSnapshot, projectDir: string, path: string): Promise<string | undefined> {
  const captured = before.contents.get(path);
  if (captured !== undefined) return captured;
  if (!before.headSha) return undefined;
  const text = await showAt(projectDir, before.headSha, path);
  return text === '' ? undefined : text;
}

function isUntracked(status: string | undefined): boolean {
  return status === '??';
}

function classify(path: string, kind: ChangeKind, before?: string, after?: string): ChangedFile {
  return {
    path,
    kind,
    before,
    after,
    isTest: isTestFile(path),
    isCode: isCodeFile(path),
    isGateConfig: isGateConfigFile(path),
  };
}

export async function diffSnapshots(before: TreeSnapshot, after: TreeSnapshot, projectDir: string): Promise<TaskDiff> {
  const headMoved = before.headSha !== after.headSha;
  const files: ChangedFile[] = [];
  const seen = new Set<string>();

  const push = (f: ChangedFile) => {
    if (seen.has(f.path)) return;
    seen.add(f.path);
    // Generated / vendored / orchestrator-state paths (a snapshot taken by an
    // older build, or a committed `dist/`) are never a task's artifacts.
    if (isGeneratedPath(f.path)) return;
    files.push(f);
  };

  // 1. Paths dirty after the task.
  for (const [path, fpAfter] of after.dirty) {
    const fpBefore = before.dirty.get(path);
    const gone = fpAfter.hash === DELETED_HASH;

    if (!fpBefore) {
      if (gone) {
        push(classify(path, 'deleted', await readBefore(before, projectDir, path), undefined));
      } else if (isUntracked(fpAfter.status) || fpAfter.status?.[0] === 'A') {
        push(classify(path, 'added', undefined, await readAfter(projectDir, path)));
      } else {
        push(classify(path, 'modified', await readBefore(before, projectDir, path), await readAfter(projectDir, path)));
      }
      continue;
    }

    if (fpBefore.hash === fpAfter.hash) continue; // unchanged dirty file

    if (gone) {
      push(classify(path, 'deleted', await readBefore(before, projectDir, path), undefined));
    } else if (fpBefore.hash === DELETED_HASH) {
      push(classify(path, 'added', undefined, await readAfter(projectDir, path)));
    } else {
      push(classify(path, 'modified', await readBefore(before, projectDir, path), await readAfter(projectDir, path)));
    }
  }

  // 2. Paths that were dirty before but are clean now: deleted, reverted or committed.
  for (const [path, fpBefore] of before.dirty) {
    if (after.dirty.has(path)) continue;
    const onDisk = await exists(projectDir, path);
    if (!onDisk) {
      if (fpBefore.hash === DELETED_HASH) continue; // already gone before; nothing new
      push(classify(path, 'deleted', await readBefore(before, projectDir, path), undefined));
      continue;
    }
    // Exists and clean w.r.t. after.headSha: content may still differ from before.
    let nowHash: string;
    try {
      nowHash = await sha1File(join(projectDir, path));
    } catch {
      continue;
    }
    if (nowHash === fpBefore.hash) continue;
    if (fpBefore.hash === DELETED_HASH) {
      push(classify(path, 'added', undefined, await readAfter(projectDir, path)));
    } else {
      push(classify(path, 'modified', await readBefore(before, projectDir, path), await readAfter(projectDir, path)));
    }
  }

  // 3. HEAD moved: fold in committed changes not already covered.
  if (headMoved && after.headSha) {
    const entries = await committedChanges(projectDir, before.headSha, after.headSha);
    for (const { kind, path } of entries) {
      if (seen.has(path)) continue;
      if (kind === 'added') {
        // Was it dirty-untracked before (already existed on disk)? Then it was only committed, not created.
        const fpBefore = before.dirty.get(path);
        if (fpBefore && fpBefore.hash !== DELETED_HASH) continue;
        push(classify(path, 'added', undefined, await readAfter(projectDir, path)));
      } else if (kind === 'deleted') {
        if (await exists(projectDir, path)) continue; // re-created in the working tree
        push(classify(path, 'deleted', await readBefore(before, projectDir, path), undefined));
      } else {
        push(classify(path, 'modified', await readBefore(before, projectDir, path), await readAfter(projectDir, path)));
      }
    }
  }

  return { files, headMoved };
}

async function committedChanges(
  projectDir: string,
  fromSha: string | null,
  toSha: string
): Promise<Array<{ kind: ChangeKind; path: string }>> {
  const out: Array<{ kind: ChangeKind; path: string }> = [];
  if (!fromSha) {
    // Unborn → first commit: everything in `toSha` is new.
    const r = await git(projectDir, ['ls-tree', '-r', '-z', '--name-only', toSha, '--', '.']);
    if (r.code !== 0) return out;
    const prefixRes = await git(projectDir, ['rev-parse', '--show-prefix']);
    const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : '';
    for (const p of r.stdout.split('\0')) {
      if (!p) continue;
      const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
      if (rel) out.push({ kind: 'added', path: rel });
    }
    return out;
  }
  const r = await git(projectDir, ['diff', '--name-status', '-z', '--no-renames', '--relative', fromSha, toSha, '--', '.']);
  if (r.code !== 0) return out;
  const parts = r.stdout.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const path = parts[i + 1];
    if (!status || !path) continue;
    const kind: ChangeKind = status[0] === 'A' ? 'added' : status[0] === 'D' ? 'deleted' : 'modified';
    out.push({ kind, path });
  }
  return out;
}
