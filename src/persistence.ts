import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RunState } from './types.js';

const FULLAUTO_DIR = '.fullauto';
const STATE_FILE = 'state.json';
const CONFIG_FILE = 'config.json';
const LOGS_DIR = 'logs';

export interface PathLayout {
  root: string;
  fullautoDir: string;
  statePath: string;
  configPath: string;
  logsDir: string;
}

export function paths(projectDir: string): PathLayout {
  const fullautoDir = join(projectDir, FULLAUTO_DIR);
  return {
    root: projectDir,
    fullautoDir,
    statePath: join(fullautoDir, STATE_FILE),
    configPath: join(fullautoDir, CONFIG_FILE),
    logsDir: join(fullautoDir, LOGS_DIR),
  };
}

export async function ensureFullautoDir(projectDir: string): Promise<PathLayout> {
  const p = paths(projectDir);
  await mkdir(p.fullautoDir, { recursive: true });
  await mkdir(p.logsDir, { recursive: true });
  return p;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function saveState(
  projectDir: string,
  state: RunState
): Promise<void> {
  const p = paths(projectDir);
  await mkdir(p.fullautoDir, { recursive: true });
  // Write to temp + rename for atomicity (avoid half-written state on crash).
  const tmp = `${p.statePath}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, p.statePath);
}

export async function loadState(projectDir: string): Promise<RunState | null> {
  const p = paths(projectDir);
  if (!(await fileExists(p.statePath))) return null;
  const raw = await readFile(p.statePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `state.json is corrupted (invalid JSON). Remove .fullauto/ and re-run to start fresh, or restore from a backup.`
    );
  }
  try {
    return RunState.parse(parsed);
  } catch (err) {
    throw new Error(
      `state.json schema mismatch — the file may be from an older version. Remove .fullauto/ and re-run to start fresh.\nDetails: ${(err as Error).message}`
    );
  }
}

export async function saveConfigSnapshot(
  projectDir: string,
  config: unknown
): Promise<void> {
  const p = paths(projectDir);
  await mkdir(p.fullautoDir, { recursive: true });
  await writeFile(p.configPath, JSON.stringify(config, null, 2), 'utf-8');
}

export async function loadUserConfig(
  projectDir: string
): Promise<unknown | null> {
  const p = paths(projectDir);
  if (!(await fileExists(p.configPath))) return null;
  const raw = await readFile(p.configPath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `config.json is corrupted (invalid JSON). Remove .fullauto/config.json and re-run \`fullauto init\`.`
    );
  }
}

export function logPathFor(projectDir: string, taskId: string, attempt: number): string {
  const p = paths(projectDir);
  return join(p.logsDir, `${taskId}-attempt${attempt}.log`);
}

export async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
