import { describe, it, expect, afterEach } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  InterruptedError,
  SHUTDOWN_EXIT_CODES,
  detachedSpawnOptions,
  installSignalHandlers,
  interruptibleSleep,
  killProcessGroup,
  requestShutdown,
  resetShutdown,
  shutdownSignal,
  terminateProcessGroup,
  throwIfInterrupted,
  track,
} from '../src/runner/process-group.js';

const execFileAsync = promisify(execFile);

/** Pids alive in process group `pgid`. */
async function groupMembers(pgid: number): Promise<string[]> {
  try {
    return (await execFileAsync('pgrep', ['-g', String(pgid)])).stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

afterEach(() => resetShutdown());

describe('shutdown flag', () => {
  it('exit codes follow the shell convention and the error carries them', () => {
    expect(SHUTDOWN_EXIT_CODES).toEqual({ SIGINT: 130, SIGTERM: 143 });
    expect(new InterruptedError('SIGINT').exitCode).toBe(130);
    expect(new InterruptedError('SIGTERM').exitCode).toBe(143);
    expect(new InterruptedError('SIGTERM').message).toBe('interrupted by SIGTERM');
  });

  it('throwIfInterrupted is a no-op until a shutdown was requested, then raises with the first signal', () => {
    expect(() => throwIfInterrupted()).not.toThrow();
    expect(shutdownSignal()).toBeUndefined();
    requestShutdown('SIGTERM');
    requestShutdown('SIGINT'); // second signal does not overwrite the first
    expect(shutdownSignal()).toBe('SIGTERM');
    expect(() => throwIfInterrupted()).toThrow(InterruptedError);
    try {
      throwIfInterrupted();
    } catch (e) {
      expect((e as InterruptedError).signal).toBe('SIGTERM');
      expect((e as InterruptedError).exitCode).toBe(143);
    }
    resetShutdown();
    expect(() => throwIfInterrupted()).not.toThrow();
  });

  it('installSignalHandlers registers SIGINT/SIGTERM listeners and the uninstaller removes exactly them', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const uninstall = installSignalHandlers();
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    uninstall();
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
  });
});

describe('interruptibleSleep', () => {
  it('resolves after roughly `ms` when never interrupted', async () => {
    const start = Date.now();
    await interruptibleSleep(120, 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it('rejects with InterruptedError as soon as a shutdown signal lands mid-sleep, well before `ms` elapses', async () => {
    const start = Date.now();
    const sleeping = interruptibleSleep(5000, 20);
    setTimeout(() => requestShutdown('SIGTERM'), 50);
    await expect(sleeping).rejects.toBeInstanceOf(InterruptedError);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('throws immediately when already shut down before the sleep starts', async () => {
    requestShutdown('SIGINT');
    await expect(interruptibleSleep(5000)).rejects.toBeInstanceOf(InterruptedError);
  });
});

describe('process groups', () => {
  it('a detached child leads its own group; killing the group takes its grandchildren with it', async () => {
    // bash → sleep: the classic "kill the shell, the sleep survives" shape.
    const child = spawn('bash', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', ...detachedSpawnOptions() });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    // Give bash a moment to fork the sleep.
    expect(await waitFor(async () => (await groupMembers(pid)).length >= 2, 3000)).toBe(true);

    killProcessGroup(child, 'SIGTERM');
    await exited;
    expect(await waitFor(async () => (await groupMembers(pid)).length === 0, 3000)).toBe(true);
  });

  it('terminateProcessGroup escalates to SIGKILL after the grace period when SIGTERM is ignored', async () => {
    const child = spawn('bash', ['-c', "trap '' TERM; sleep 30 & wait"], { stdio: 'ignore', ...detachedSpawnOptions() });
    const pid = child.pid!;
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code, signal) => resolve(signal === 'SIGKILL' ? 9 : code)));
    expect(await waitFor(async () => (await groupMembers(pid)).length >= 2, 3000)).toBe(true);

    const timer = terminateProcessGroup(child, 300);
    expect(await exited).toBe(9);
    clearTimeout(timer);
    expect(await waitFor(async () => (await groupMembers(pid)).length === 0, 3000)).toBe(true);
  });

  it('requestShutdown reaches every tracked child and untracks it on exit; killProcessGroup on a dead child is silent', async () => {
    const child = spawn('bash', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', ...detachedSpawnOptions() });
    track(child);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(await waitFor(async () => (await groupMembers(child.pid!)).length >= 2, 3000)).toBe(true);
    requestShutdown('SIGINT');
    await exited;
    expect(await waitFor(async () => (await groupMembers(child.pid!)).length === 0, 3000)).toBe(true);
    expect(() => killProcessGroup(child, 'SIGTERM')).not.toThrow();
    expect(shutdownSignal()).toBe('SIGINT');
  });
});
