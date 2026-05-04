import { spawn } from 'node:child_process';
import type { GateResult, RunConfig } from '../types.js';

interface RunCommandResult {
  exitCode: number;
  output: string;
  durationMs: number;
}

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

    const buffer: string[] = [];
    const collect = (d: Buffer) => buffer.push(d.toString('utf-8'));
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000);
    }, timeoutSec * 1000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        exitCode: -1,
        output: `${buffer.join('')}\n[gate-runner] spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        exitCode: code ?? -1,
        output: buffer.join(''),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const GATE_TIMEOUT_SEC = 600; // 10min cap per gate

export async function runGates(
  config: RunConfig,
  projectDir: string
): Promise<GateResult[]> {
  const results: GateResult[] = [];

  for (const gate of config.gates) {
    const cwd = gate.cwd ?? projectDir;

    if (gate.skipIf) {
      const probe = await runCommand(gate.skipIf, cwd, 30);
      if (probe.exitCode === 0) {
        results.push({
          name: gate.name,
          passed: true,
          command: gate.command,
          exitCode: 0,
          output: `[skipped: skipIf check exited 0 — ${gate.skipIf}]`,
          durationMs: probe.durationMs,
        });
        continue;
      }
    }

    const r = await runCommand(gate.command, cwd, GATE_TIMEOUT_SEC);
    results.push({
      name: gate.name,
      passed: r.exitCode === 0,
      command: gate.command,
      exitCode: r.exitCode,
      output: r.output.slice(-8000), // cap log size
      durationMs: r.durationMs,
    });
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
