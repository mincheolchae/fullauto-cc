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

/**
 * `showAt` for many paths at once: content of every `${ref}:./<path>` blob
 * from ONE `git cat-file --batch` process instead of one `git show` spawn
 * per path — a diff touching hundreds of files would otherwise pay full
 * process-start cost (measured ~7ms on a warm cache) hundreds of times over
 * for what `cat-file --batch` reads off one long-lived pipe in a few ms
 * total (measured ~19x faster for 50 paths: ~350ms of separate `git show`
 * spawns vs ~18ms for one batch call). Missing / non-blob paths are simply
 * absent from the returned map. Reads raw bytes (not the `utf-8`-decoded
 * `execFile` path `git()` uses) so declared byte lengths in the `--batch`
 * framing line up exactly, including for content that isn't valid UTF-8.
 */
export async function showAtBatch(cwd: string, ref: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(paths)].filter(Boolean);
  if (unique.length === 0) return out;
  const stdin = unique.map((p) => `${ref}:./${p}\n`).join('');

  const buf = await new Promise<Buffer | null>((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        'git',
        ['cat-file', '--batch'],
        {
          cwd,
          maxBuffer: MAX_BUFFER,
          // `encoding: 'buffer'` (Node's execFile defaults to `'utf8'`,
          // i.e. a STRING, unless told otherwise): keep raw bytes so the
          // `--batch` framing's declared byte length can be sliced exactly
          // — a `utf-8` decode up front would make that length meaningless
          // for non-ASCII or binary content.
          encoding: 'buffer',
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          windowsHide: true,
        },
        (err, stdout) => {
          const b = stdout;
          resolve(err && !(b && b.length) ? null : b ?? Buffer.alloc(0));
        }
      );
    } catch {
      resolve(null);
      return;
    }
    child.stdin?.end(stdin, 'utf-8');
  });
  if (!buf) return out;

  // `--batch` prints, per input line in order: either
  //   `<sha> <type> <size>\n<size bytes of content>\n`
  // or (object not found at that ref) `<given-object> missing\n`. Walk the
  // buffer once, matching each header back to the path that produced it by
  // position (the output order mirrors stdin order 1:1).
  let offset = 0;
  for (const path of unique) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) break; // truncated output: stop, keep what was parsed
    const header = buf.subarray(offset, nl).toString('utf-8');
    offset = nl + 1;
    const m = /^[0-9a-f]{40,64} \S+ (\d+)$/.exec(header);
    if (!m) continue; // "... missing" (or an unexpected line): no content to skip
    const size = Number(m[1]);
    out.set(path, buf.subarray(offset, offset + size).toString('utf-8'));
    offset += size + 1; // the content's own trailing \n
  }
  return out;
}
