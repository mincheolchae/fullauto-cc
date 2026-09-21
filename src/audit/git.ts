/**
 * Thin `git` wrapper used by the audit layer. Always `execFile` (no shell),
 * always `cwd = projectDir`, never throws for "expected" non-zero exits
 * (callers inspect `code`).
 */
import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export function git(cwd: string, args: string[], opts: { input?: string; maxBuffer?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        'git',
        args,
        {
          cwd,
          maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
          encoding: 'utf-8',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') {
            // spawn failure (git missing) or maxBuffer exceeded
            resolve({ code: -1, stdout: String(stdout ?? ''), stderr: `${String(stderr ?? '')}\n${err.message}` });
            return;
          }
          const code = err ? Number((err as NodeJS.ErrnoException).code) : 0;
          resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      );
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message });
      return;
    }
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}

/** `git rev-parse --is-inside-work-tree` prints `true` ⇒ inside a work tree (not a bare repo / .git dir). */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout.trim() === 'true';
}

/** HEAD sha, or null for an unborn branch / not a repo. */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Content of `path` (relative to cwd) at `ref`; '' when missing. */
export async function showAt(cwd: string, ref: string, path: string): Promise<string> {
  // `ref:./path` makes the path relative to cwd rather than the repo root.
  const r = await git(cwd, ['show', `${ref}:./${path}`]);
  return r.code === 0 ? r.stdout : '';
}
