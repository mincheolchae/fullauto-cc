import { spawn, ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { ServiceDef } from './types.js';
import { isProtectedEnvName, sanitizeForTerminal } from './protected-env.js';

export interface ServiceHandle {
  def: ServiceDef;
  child: ChildProcess;
  ready: boolean;
  /** Tail of recent stdout/stderr lines, surfaced when readyProbe times out
   * so the user gets a real diagnostic instead of just the probe text. */
  recentLog: string[];
  externallyManaged: boolean;
}

export type ServiceLogSink = (serviceName: string, line: string) => void;

/**
 * Manages the lifecycle of background services declared in
 * `RunConfig.services`. Services start once at run begin, become ready
 * when their `readyProbe` exits 0, optionally export env from dotenv
 * files (so gates see the right CONVEX_URL etc.), and stop at run end.
 *
 * Failure to become ready is fatal — without a healthy service, gates
 * that depend on it would silently produce garbage results.
 */
export class ServiceManager {
  private handles: ServiceHandle[] = [];

  constructor(
    private readonly projectDir: string,
    private readonly services: ServiceDef[]
  ) {}

  get isEmpty(): boolean {
    return this.services.length === 0;
  }

  async startAll(onLog: ServiceLogSink): Promise<void> {
    if (this.services.length === 0) return;
    // Sequential start so a downstream service can read the previous
    // service's envFiles via its `readyProbe`. (Previously we Promise.all'd
    // all readyProbes then sourced envFiles afterwards, which deadlocked
    // any service whose readyProbe needed env from another service's file.)
    for (const def of this.services) {
      // PRE-SPAWN PROBE: if readyProbe already exits 0, the service is
      // already running (user pre-launched in another terminal, e.g. did
      // `npx convex dev` interactively first to handle the login flow
      // that wouldn't work under stdio:'ignore'). Skip the spawn entirely
      // so we don't fork a duplicate process — but still source envFiles
      // so subsequent gates / subagents see the values.
      if (def.readyProbe) {
        const cwd = def.cwd
          ? resolvePath(this.projectDir, def.cwd)
          : this.projectDir;
        if (await this.runProbe(def.readyProbe, cwd)) {
          onLog(def.name, '[already ready — using externally-managed process]');
          this.handles.push({
            def,
            child: null as unknown as ChildProcess,
            ready: true,
            recentLog: [],
            externallyManaged: true,
          });
          for (const f of def.envFiles) {
            await this.sourceEnvFile(resolvePath(this.projectDir, f), def.name, onLog);
          }
          continue;
        }
      }
      const handle = this.spawnOne(def, onLog);
      this.handles.push(handle);
      await this.waitReady(handle, onLog);
      for (const f of handle.def.envFiles) {
        await this.sourceEnvFile(resolvePath(this.projectDir, f), handle.def.name, onLog);
      }
    }
  }

  /**
   * Verify every started service is still alive. Called by the orchestrator
   * before each task so a `convex dev` that crashed silently mid-run causes
   * an explicit abort instead of an endless cascade of "connection refused"
   * gate failures that look like task bugs.
   *
   * Externally-managed handles (where the user pre-launched the process
   * themselves) are skipped — we can't introspect them, so we trust them
   * to stay alive. A gate that hits the dead service will fail naturally.
   */
  assertAllAlive(): void {
    for (const h of this.handles) {
      if (h.externallyManaged) continue;
      if (h.child.exitCode !== null || h.child.signalCode !== null) {
        throw new Error(
          `Service "${h.def.name}" died (exit code ${h.child.exitCode}, signal ${h.child.signalCode ?? 'none'}). The run cannot continue — its dependent gates would all fail with connection errors.`
        );
      }
    }
  }

  private spawnOne(def: ServiceDef, onLog: ServiceLogSink): ServiceHandle {
    const cwd = def.cwd ? resolvePath(this.projectDir, def.cwd) : this.projectDir;
    const env = mergeEnvSafely(process.env, def.env, (name) =>
      onLog(def.name, `[refused to override sensitive env var "${name}" via service.env]`)
    );
    const child = spawn(def.command, {
      cwd,
      shell: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const handle: ServiceHandle = {
      def,
      child,
      ready: false,
      recentLog: [],
      externallyManaged: false,
    };

    const RECENT_LOG_CAP = 30;
    const pipe = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf-8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line) {
            const safe = sanitizeLogLine(line);
            handle.recentLog.push(safe);
            if (handle.recentLog.length > RECENT_LOG_CAP) handle.recentLog.shift();
            onLog(def.name, safe);
          }
        }
      });
      stream.on('end', () => {
        if (buf) {
          const safe = sanitizeLogLine(buf);
          handle.recentLog.push(safe);
          if (handle.recentLog.length > RECENT_LOG_CAP) handle.recentLog.shift();
          onLog(def.name, safe);
        }
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on('exit', (code, signal) => {
      onLog(def.name, `[exit code=${code} signal=${signal ?? 'none'}]`);
    });
    child.on('error', (err) => {
      onLog(def.name, `[spawn error: ${err.message}]`);
    });
    return handle;
  }

  private async waitReady(h: ServiceHandle, onLog: ServiceLogSink): Promise<void> {
    if (!h.def.readyProbe) {
      // No probe: trust immediate readiness. This is risky for any service
      // that needs warmup, so callers should almost always set one.
      h.ready = true;
      onLog(h.def.name, '[ready (no probe)]');
      return;
    }
    const startedAt = Date.now();
    const timeoutMs = h.def.readyTimeoutSec * 1000;
    const cwd = h.def.cwd
      ? resolvePath(this.projectDir, h.def.cwd)
      : this.projectDir;
    while (Date.now() - startedAt < timeoutMs) {
      if (h.child.exitCode !== null) {
        throw new Error(
          this.buildStartupErrorMessage(
            h,
            `exited early (code ${h.child.exitCode})`
          )
        );
      }
      const ok = await this.runProbe(h.def.readyProbe, cwd, 10_000);
      if (ok) {
        h.ready = true;
        onLog(
          h.def.name,
          `[ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`
        );
        return;
      }
      await delay(1000);
    }
    throw new Error(
      this.buildStartupErrorMessage(
        h,
        `did not become ready within ${h.def.readyTimeoutSec}s (probe: ${h.def.readyProbe})`
      )
    );
  }

  /**
   * Compose a service-startup error that includes the last 10 log lines so
   * the user can see WHY the service failed (interactive-login prompt that
   * couldn't be answered, port already in use, missing config file, etc.)
   * instead of just the probe text — which is rarely the actual cause.
   */
  private buildStartupErrorMessage(h: ServiceHandle, summary: string): string {
    const tail = h.recentLog.slice(-10).join('\n');
    const tailBlock = tail
      ? `\n--- last log lines from "${h.def.name}" ---\n${tail}\n--- end log ---`
      : `\n(no log output captured from "${h.def.name}" — the process may have produced no stdout/stderr before the probe timed out)`;
    return `Service "${h.def.name}" ${summary}.${tailBlock}`;
  }

  private runProbe(command: string, cwd: string, timeoutMs = 30_000): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: process.env,
        stdio: 'ignore',
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        resolve(false);
      }, timeoutMs);
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private async sourceEnvFile(
    path: string,
    serviceName: string,
    onLog: ServiceLogSink
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch {
      onLog(serviceName, `[envFile not found: ${path}]`);
      return;
    }
    let exported = 0;
    let refused = 0;
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(
        /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
      );
      if (!m) continue;
      const name = m[1];
      let val = m[2];

      // Standard dotenv semantics:
      //   KEY=value           → "value"
      //   KEY=value # comment → "value"          (inline comment stripped)
      //   KEY="x # y"         → "x # y"          (quoted: # is literal)
      //   KEY='x # y'         → "x # y"          (quoted: # is literal)
      //   KEY=val#nospace     → "val#nospace"    (# without leading whitespace is literal)
      //
      // The previous parser took the whole line after `=` as the value
      // (with only trailing-whitespace trim), which polluted env vars
      // written by tools that use trailing comments — e.g. `npx convex
      // dev` writes `CONVEX_DEPLOYMENT=dev:foo-123 # team: x, project: y`
      // and the comment leaked into Convex CLI's deployment-name parser
      // through process.env, producing 400 InvalidDeploymentName.
      const isQuoted =
        val.length >= 2 && (val.startsWith('"') || val.startsWith("'"));
      if (isQuoted) {
        const quote = val[0];
        const closeIdx = val.indexOf(quote, 1);
        if (closeIdx >= 0) {
          val = val.slice(1, closeIdx);
        } else {
          // Unterminated quote — degrade gracefully: drop the opening
          // quote and trim trailing whitespace. Skipping the line would
          // silently lose env vars on hand-edited files; better to
          // surface a slightly off value than to drop it.
          val = val.slice(1).trimEnd();
        }
      } else {
        const commentAt = val.search(/\s#/);
        if (commentAt >= 0) val = val.slice(0, commentAt);
        val = val.trimEnd();
      }

      if (isProtectedEnvName(name)) {
        onLog(
          serviceName,
          `[refused to source sensitive env var "${name}" from ${path}]`
        );
        refused += 1;
        continue;
      }
      process.env[name] = val;
      exported += 1;
    }
    onLog(
      serviceName,
      `[sourced ${exported} var(s) from ${path}${refused ? ` (${refused} refused)` : ''}]`
    );
  }

  async stopAll(onLog: ServiceLogSink = () => {}): Promise<void> {
    if (this.handles.length === 0) return;
    await Promise.all(
      this.handles.map((h) => this.stopOne(h, onLog).catch(() => {}))
    );
    this.handles = [];
  }

  private async stopOne(h: ServiceHandle, onLog: ServiceLogSink): Promise<void> {
    // Externally-managed: we didn't spawn it, we don't kill it. The user
    // owns its lifecycle (and would be unhappy if `fullauto run` killed
    // their dev server in another terminal).
    if (h.externallyManaged) {
      onLog(h.def.name, '[released — externally-managed process left running]');
      return;
    }
    if (h.def.shutdownCommand) {
      await this.runProbe(h.def.shutdownCommand, this.projectDir);
    }
    if (h.child.exitCode === null) {
      h.child.kill('SIGTERM');
      const exited = await waitForExit(h.child, 3000);
      if (!exited) {
        h.child.kill('SIGKILL');
        await waitForExit(h.child, 1000);
      }
    }
    onLog(h.def.name, '[stopped]');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}


function mergeEnvSafely(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string> | undefined,
  onRefused: (name: string) => void
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base };
  if (!overlay) return merged;
  for (const [k, v] of Object.entries(overlay)) {
    if (isProtectedEnvName(k)) {
      onRefused(k);
      continue;
    }
    merged[k] = v;
  }
  return merged;
}

// Local alias kept for readability at the call sites — the underlying
// implementation lives in protected-env.ts and is shared with reporter.ts.
const sanitizeLogLine = sanitizeForTerminal;

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
