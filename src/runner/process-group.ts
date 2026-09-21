/**
 * Child-process groups + the run-level shutdown flag.
 *
 * Every process the orchestrator spawns (the implementer / planner / evolve
 * subagents, the shell gates) is started `detached` so it leads its OWN
 * process group. That is what makes it killable as a unit: `claude` forks
 * bash, bash forks `sleep` / `node` / `vitest`; killing only the direct
 * child leaves the grandchildren running — and, after a Ctrl-C, a real
 * Claude keeps editing the tree while `fullauto resume` spawns a second one.
 *
 * The flip side of `detached` is that a terminal Ctrl-C no longer reaches
 * the children (they are outside the terminal's foreground group), so the
 * CLI must forward it: `installSignalHandlers` marks the run as shutting
 * down and SIGTERMs every active group (SIGKILL after `KILL_GRACE_MS`). The
 * orchestrator then notices the flag at its next checkpoint
 * (`throwIfInterrupted`), annotates the in-flight attempt, saves state and
 * exits 130 / 143. Keeping the handler to "flag + kill" and letting the
 * orchestrator do the bookkeeping at a checkpoint is what makes this
 * race-free: the handler never writes state.json concurrently with the run
 * loop.
 */
import type { ChildProcess } from 'node:child_process';

export const KILL_GRACE_MS = 5000;

/** Signals the CLI turns into an orderly stop; exit codes follow the shell convention (128 + signal number). */
export const SHUTDOWN_EXIT_CODES: Record<'SIGINT' | 'SIGTERM', number> = { SIGINT: 130, SIGTERM: 143 };
export type ShutdownSignal = keyof typeof SHUTDOWN_EXIT_CODES;

const active = new Set<ChildProcess>();
let shutdown: ShutdownSignal | undefined;

/** Thrown by `throwIfInterrupted` once a shutdown signal was received. */
export class InterruptedError extends Error {
  readonly exitCode: number;
  constructor(readonly signal: ShutdownSignal) {
    super(`interrupted by ${signal}`);
    this.name = 'InterruptedError';
    this.exitCode = SHUTDOWN_EXIT_CODES[signal];
  }
}

/** Spawn options that give the child its own process group (POSIX) — Windows has no groups to kill, so it is a no-op there. */
export function detachedSpawnOptions(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

/** Track a running child so a shutdown signal can reach it; untracked automatically on exit. */
export function track(child: ChildProcess): void {
  if (child.pid === undefined) return;
  active.add(child);
  child.once('exit', () => active.delete(child));
  child.once('error', () => active.delete(child));
}

/**
 * Deliver `signal` to the child's whole process group (`kill(-pgid)`).
 * Falls back to the child itself when the group is gone or on Windows.
 * ESRCH (already dead) is silent: the caller only wants it gone.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader (spawned without `detached`) or already reaped.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/** SIGTERM the group now and SIGKILL whatever is still alive after the grace period. Returns the timer so the caller can cancel it on exit. */
export function terminateProcessGroup(child: ChildProcess, graceMs = KILL_GRACE_MS): ReturnType<typeof setTimeout> {
  killProcessGroup(child, 'SIGTERM');
  const timer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), graceMs);
  // Never keep the event loop alive just to deliver a SIGKILL to something
  // that has already exited.
  timer.unref();
  return timer;
}

/** Every process group the run currently has in flight (subagents, gates). */
export function killActiveProcessGroups(signal: NodeJS.Signals): number {
  let n = 0;
  for (const child of active) {
    killProcessGroup(child, signal);
    n += 1;
  }
  return n;
}

/** The shutdown signal received so far, if any. */
export function shutdownSignal(): ShutdownSignal | undefined {
  return shutdown;
}

/**
 * Mark the run as shutting down and stop every active child. Idempotent
 * for the same signal; a second call (the user pressed Ctrl-C twice) turns
 * into SIGKILL so a stuck child cannot hold the exit hostage.
 */
export function requestShutdown(signal: ShutdownSignal): void {
  if (shutdown !== undefined) {
    killActiveProcessGroups('SIGKILL');
    return;
  }
  shutdown = signal;
  killActiveProcessGroups('SIGTERM');
  setTimeout(() => killActiveProcessGroups('SIGKILL'), KILL_GRACE_MS).unref();
}

/** Test hook: forget a previous shutdown so the next run starts clean. */
export function resetShutdown(): void {
  shutdown = undefined;
}

/** Orchestrator checkpoint: raise once a shutdown signal was received. */
export function throwIfInterrupted(): void {
  if (shutdown !== undefined) throw new InterruptedError(shutdown);
}

/**
 * Sleep for `ms`, polling `throwIfInterrupted` every `pollMs`. Rate-limit
 * backoff can wait up to `RunConfig.rateLimitMaxBackoffSec` (minutes); a
 * bare `setTimeout` for that long would swallow Ctrl-C/SIGTERM until it
 * fires, leaving a "stuck" unattended run that ignores the shutdown signal
 * entirely. Polling keeps the wait interruptible at fine granularity while
 * still resolving promptly once `ms` elapses.
 */
export async function interruptibleSleep(ms: number, pollMs = 200): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    throwIfInterrupted();
    const remaining = end - Date.now();
    await new Promise<void>((r) => setTimeout(r, Math.min(pollMs, remaining)));
  }
  throwIfInterrupted();
}

/**
 * Install the CLI's SIGINT / SIGTERM handlers. Returns the uninstaller so a
 * caller that embeds the run (tests, the evolve loop) can leave the host
 * process's own handling untouched afterwards. The hard-exit watchdog is
 * the backstop for a run interrupted outside any checkpoint (e.g. while a
 * background service is still starting): the in-flight attempt was
 * persisted before its subagent spawned, so state.json is resume-safe even
 * on that path.
 */
export function installSignalHandlers(opts: { onSignal?: (signal: ShutdownSignal) => void; watchdogMs?: number } = {}): () => void {
  const watchdogMs = opts.watchdogMs ?? 30_000;
  const handler = (signal: ShutdownSignal): void => {
    const first = shutdown === undefined;
    requestShutdown(signal);
    if (!first) {
      process.exit(SHUTDOWN_EXIT_CODES[signal]);
    }
    opts.onSignal?.(signal);
    setTimeout(() => process.exit(SHUTDOWN_EXIT_CODES[signal]), watchdogMs).unref();
  };
  const onInt = () => handler('SIGINT');
  const onTerm = () => handler('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return () => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
}
