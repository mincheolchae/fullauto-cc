import { mkdtemp, mkdir, rm, writeFile, readFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Create a fresh temp directory under `os.tmpdir()`. The returned path is
 * realpath-resolved so macOS `/var` → `/private/var` symlinks don't trip
 * path-equality assertions against what `git` / `realpath()` report.
 */
export async function makeTmpDir(prefix = 'fullauto-test-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return realpath(dir);
}

/** Write `files` (repo-relative path → content) under `root`, creating parents. */
export async function writeFiles(
  root: string,
  files: Record<string, string>
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
}

export function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Keep the fixture hermetic: no user hooks / templates / signing.
      GIT_TEMPLATE_DIR: '',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

/**
 * `git init` a temp dir, write `files`, and commit them as the baseline so
 * snapshot / diff / audit code sees a clean tree with a HEAD. user.email and
 * user.name are configured LOCALLY (repo scope) so the commit works on CI
 * boxes with no global git identity.
 */
export async function makeGitRepo(
  files: Record<string, string> = {}
): Promise<string> {
  const dir = await makeTmpDir('fullauto-git-');
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'fullauto-test@example.com'], dir);
  git(['config', 'user.name', 'fullauto test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'core.hooksPath', '/dev/null'], dir);
  const seed = Object.keys(files).length
    ? files
    : { 'README.md': '# fixture\n' };
  await writeFiles(dir, seed);
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'baseline'], dir);
  return dir;
}

/** Remove a temp dir created by `makeTmpDir` / `makeGitRepo`. Safe on missing paths. */
export async function cleanup(dir: string | undefined): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}

export interface GitCallCounter {
  /** Prepend to PATH (e.g. `PATH: counter.pathPrefix + ':' + process.env.PATH`) for the code under test to pick up the shim. */
  pathPrefix: string;
  /** Every logged invocation's argv (joined with spaces, one per call, in order). */
  calls: () => Promise<string[]>;
  /** Calls whose first argument is `subcommand` (e.g. `'status'`, `'show'`, `'cat-file'`). */
  callsFor: (subcommand: string) => Promise<string[]>;
  cleanup: () => Promise<void>;
}

/**
 * A `git` shim, on its own directory, that logs every invocation's argv to
 * a file before delegating to the real `git` on PATH — lets a test assert
 * exactly how many git PROCESSES a call spawned. Subprocess spawn cost
 * (tens of ms, independent of how little work the command itself does) is
 * the whole point of the batching fixes this covers: prepend
 * `pathPrefix` to `process.env.PATH` (and restore it afterwards) so
 * `execFile('git', ...)` resolves the shim instead of the real binary.
 */
export async function makeGitCallCounter(): Promise<GitCallCounter> {
  const dir = await makeTmpDir('fullauto-git-shim-');
  const log = join(dir, 'calls.log');
  await writeFile(log, '', 'utf-8');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim().split('\n')[0];
  const shimPath = join(dir, 'git');
  await writeFile(
    shimPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${realGit}" "$@"\n`,
    'utf-8'
  );
  await chmod(shimPath, 0o755);
  const calls = async (): Promise<string[]> => (await readFile(log, 'utf-8')).split('\n').filter(Boolean);
  return {
    pathPrefix: dir,
    calls,
    callsFor: async (subcommand: string) => (await calls()).filter((c) => c === subcommand || c.startsWith(`${subcommand} `)),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
