import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditInput, AuditOptions, TaskClassification, TreeSnapshot } from '../../src/audit/types.js';
import { DEFAULT_AUDIT_OPTIONS } from '../../src/audit/types.js';
import type { GateResult, Task } from '../../src/types.js';

export interface TempRepo {
  dir: string;
  write(path: string, content: string): void;
  rm(path: string): void;
  git(...args: string[]): string;
  commit(message?: string): string;
  cleanup(): void;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'audit-test',
  GIT_AUTHOR_EMAIL: 'audit@test.local',
  GIT_COMMITTER_NAME: 'audit-test',
  GIT_COMMITTER_EMAIL: 'audit@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
  HOME: tmpdir(),
};

/** Create a temp dir (optionally `git init` + commit `files` as the baseline). */
export function makeRepo(files: Record<string, string> = {}, opts: { git?: boolean; commit?: boolean } = {}): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'fullauto-audit-'));
  const useGit = opts.git ?? true;
  const repo: TempRepo = {
    dir,
    write(path, content) {
      const abs = join(dir, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    rm(path) {
      rmSync(join(dir, path), { force: true, recursive: true });
    },
    git(...args) {
      return execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
    commit(message = 'commit') {
      repo.git('add', '-A');
      repo.git('commit', '-q', '--allow-empty', '-m', message);
      return repo.git('rev-parse', 'HEAD').trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const [p, c] of Object.entries(files)) repo.write(p, c);
  if (useGit) {
    repo.git('init', '-q');
    repo.git('config', 'commit.gpgsign', 'false');
    if (opts.commit ?? true) repo.commit('baseline');
  }
  return repo;
}

export function cls(over: Partial<TaskClassification> = {}): TaskClassification {
  return {
    kind: 'impl',
    risk: 'medium',
    tdd: 'none',
    redTaskIds: [],
    greenTaskIds: [],
    allowsConfigChange: false,
    allowsTestEdits: false,
    rationale: [],
    ...over,
  };
}

export function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T001',
    title: 'Implement thing',
    body: '',
    dependencies: [],
    status: 'pending',
    attempts: [],
    kind: 'user',
    ...over,
  };
}

export function gate(over: Partial<GateResult> & Record<string, unknown> = {}): GateResult {
  return {
    name: 'test',
    passed: true,
    command: 'npm test',
    exitCode: 0,
    output: '',
    durationMs: 1,
    ...over,
  } as GateResult;
}

export function auditInput(
  projectDir: string,
  before: TreeSnapshot,
  after: TreeSnapshot,
  over: Partial<AuditInput> = {},
  options: Partial<AuditOptions> = {}
): AuditInput {
  return {
    projectDir,
    task: task(),
    classification: cls(),
    before,
    after,
    gateResults: [],
    subagentStdout: '',
    redTests: [],
    pendingWiring: [],
    options: { ...DEFAULT_AUDIT_OPTIONS, ...options },
    ...over,
  };
}

export const VITEST_PASS_4 = [
  ' RUN  v5.0.1 /tmp/proj',
  '',
  ' ✓ test/a.test.ts (4 tests) 12ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  4 passed (4)',
  '   Start at  10:00:00',
  '   Duration  300ms',
].join('\n');

export const VITEST_FAIL_1_OF_4 = [
  ' RUN  v5.0.1 /tmp/proj',
  '',
  ' ❯ test/x.test.ts (3 tests | 1 failed) 20ms',
  ' ✓ test/y.test.ts (1 test) 3ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/x.test.ts > suite > name',
  'AssertionError: expected 1 to be 2',
  '',
  ' Test Files  1 failed | 1 passed (2)',
  '      Tests  3 passed | 1 failed (4)',
  '   Start at  10:00:00',
  '   Duration  300ms',
].join('\n');
