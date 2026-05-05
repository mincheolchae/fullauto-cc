import { spawn } from 'node:child_process';
import type { Gate, GateResult, RunConfig, ShellGate } from '../types.js';
import { runHttpGate } from './gates/http.js';
import { runConvexFnGate } from './gates/convex-fn.js';

interface RunCommandResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

const DEFAULT_SHELL_TIMEOUT_SEC = 600; // 10min cap per gate

function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2MB — prevents OOM on runaway output
    let bufferBytes = 0;
    const buffer: string[] = [];
    const collect = (d: Buffer) => {
      const s = d.toString('utf-8');
      buffer.push(s);
      bufferBytes += s.length;
      // Keep only the most-recent 2MB so `slice(-8000)` still sees the tail.
      while (bufferBytes > MAX_BUFFER_BYTES && buffer.length > 1) {
        bufferBytes -= buffer.shift()!.length;
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      sigkillTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      clearTimeout(sigkillTimer);
      resolve({
        exitCode: -1,
        output: `${buffer.join('')}\n[gate-runner] spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(sigkillTimer);
      resolve({
        exitCode: code ?? -1,
        output: buffer.join(''),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

async function runShellGate(
  gate: ShellGate,
  projectDir: string
): Promise<GateResult> {
  const cwd = gate.cwd ?? projectDir;
  const timeoutSec = gate.timeoutSec ?? DEFAULT_SHELL_TIMEOUT_SEC;

  if (gate.skipIf) {
    const probe = await runCommand(gate.skipIf, cwd, 30);
    if (probe.exitCode === 0) {
      return {
        name: gate.name,
        passed: true,
        command: gate.command,
        exitCode: 0,
        output: `[skipped: skipIf check exited 0 — ${gate.skipIf}]`,
        durationMs: probe.durationMs,
      };
    }
  }

  const r = await runCommand(gate.command, cwd, timeoutSec);
  return {
    name: gate.name,
    passed: r.exitCode === 0,
    command: gate.command,
    exitCode: r.exitCode,
    output: r.output.slice(-8000), // cap log size
    durationMs: r.durationMs,
  };
}

async function runOneGate(
  gate: Gate,
  projectDir: string
): Promise<GateResult> {
  switch (gate.type) {
    case 'shell':
      return runShellGate(gate, projectDir);
    case 'http':
      return runHttpGate(gate);
    case 'convex-fn':
      return runConvexFnGate(gate, projectDir);
  }
}

export async function runGates(
  config: RunConfig,
  projectDir: string
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of config.gates) {
    results.push(await runOneGate(gate, projectDir));
  }
  return results;
}

export function summarizeGates(gates: GateResult[]): string {
  if (gates.length === 0) return '(no gates configured)';
  return gates
    .map((g) => `${g.passed ? '✓' : '✗'} ${g.name} (exit ${g.exitCode}, ${g.durationMs}ms)`)
    .join(', ');
}

export function allGatesPassed(gates: GateResult[]): boolean {
  return gates.every((g) => g.passed);
}

export function firstFailedGate(gates: GateResult[]): GateResult | undefined {
  return gates.find((g) => !g.passed);
}
