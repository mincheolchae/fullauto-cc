import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  runGates,
  allGatesPassed,
  firstFailedGate,
  summarizeGates,
} from '../src/runner/gates.js';
import type { GateResult } from '../src/types.js';
import { makeTmpDir, cleanup } from './helpers/tmp.js';
import { makeConfig } from './helpers/fixtures.js';

let dir: string;

beforeAll(async () => {
  dir = await makeTmpDir('fullauto-gates-');
  await mkdir(join(dir, 'sub'), { recursive: true });
});
afterAll(async () => {
  await cleanup(dir);
});

const gatesOf = (gates: unknown[]) => makeConfig({ gates });

describe('runGates — shell gates', () => {
  it('a gate whose command exits 0 passes and captures stdout', async () => {
    const res = await runGates(gatesOf([{ name: 'ok', command: 'echo hello-gate' }]), dir);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({
      name: 'ok',
      passed: true,
      command: 'echo hello-gate',
      exitCode: 0,
    });
    expect(res[0].output).toContain('hello-gate');
    expect(res[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('a non-zero exit fails the gate and records the exit code plus stderr', async () => {
    const res = await runGates(
      gatesOf([{ name: 'bad', command: 'echo to-stderr 1>&2; exit 7' }]),
      dir
    );
    expect(res[0].passed).toBe(false);
    expect(res[0].exitCode).toBe(7);
    expect(res[0].output).toContain('to-stderr');
  });

  it('an unknown command is a failed gate (shell exit 127), not a thrown error', async () => {
    const res = await runGates(
      gatesOf([{ name: 'missing', command: 'definitely-not-a-real-command-xyz' }]),
      dir
    );
    expect(res[0].passed).toBe(false);
    expect(res[0].exitCode).toBe(127);
  });

  it('runs gates sequentially in config order and keeps going after a failure', async () => {
    const res = await runGates(
      gatesOf([
        { name: 'first', command: 'true' },
        { name: 'second', command: 'false' },
        { name: 'third', command: 'true' },
      ]),
      dir
    );
    expect(res.map((g) => [g.name, g.passed])).toEqual([
      ['first', true],
      ['second', false],
      ['third', true],
    ]);
    expect(allGatesPassed(res)).toBe(false);
    expect(firstFailedGate(res)?.name).toBe('second');
  });

  it('legacy gates without a `type` field parse as shell gates', async () => {
    const cfg = gatesOf([{ name: 'legacy', command: 'true' }]);
    expect(cfg.gates[0].type).toBe('shell');
    const res = await runGates(cfg, dir);
    expect(res[0].passed).toBe(true);
  });

  it('honours `cwd` (relative to nothing — absolute path) for the gate command', async () => {
    const sub = join(dir, 'sub');
    const res = await runGates(gatesOf([{ name: 'pwd', command: 'pwd', cwd: sub }]), dir);
    expect(res[0].output.trim()).toBe(sub);
  });

  it('defaults cwd to the project dir', async () => {
    const res = await runGates(gatesOf([{ name: 'pwd', command: 'pwd' }]), dir);
    expect(res[0].output.trim()).toBe(dir);
  });
});

describe('runGates — skipIf semantics', () => {
  it('skipIf exiting 0 skips the gate and reports it as passed with a [skipped] note', async () => {
    const res = await runGates(
      gatesOf([{ name: 'skippable', command: 'exit 1', skipIf: 'true' }]),
      dir
    );
    expect(res[0]).toMatchObject({ name: 'skippable', passed: true, exitCode: 0, command: 'exit 1' });
    expect(res[0].output).toMatch(/^\[skipped: skipIf check exited 0 — true\]$/);
  });

  it('skipIf exiting non-zero runs the gate normally', async () => {
    const res = await runGates(
      gatesOf([{ name: 'not-skipped', command: 'echo ran; exit 1', skipIf: 'false' }]),
      dir
    );
    expect(res[0].passed).toBe(false);
    expect(res[0].exitCode).toBe(1);
    expect(res[0].output).toContain('ran');
  });

  it('skipIf probe runs in the gate cwd (e.g. "test -f" against a marker file)', async () => {
    const res = await runGates(
      gatesOf([
        { name: 'no-marker', command: 'echo executed', skipIf: 'test -f nope.marker' },
        { name: 'has-sub', command: 'echo executed', skipIf: 'test -d sub' },
      ]),
      dir
    );
    expect(res[0].output).toContain('executed');
    expect(res[1].output).toMatch(/^\[skipped/);
  });
});

describe('runGates — timeout', () => {
  it('kills a command that exceeds timeoutSec and reports a non-zero exit', async () => {
    const started = Date.now();
    const res = await runGates(
      gatesOf([{ name: 'slow', command: 'sleep 5', timeoutSec: 1 }]),
      dir
    );
    const elapsed = Date.now() - started;
    expect(res[0].passed).toBe(false);
    // Killed by signal → node reports code null → runner maps to -1.
    expect(res[0].exitCode).toBe(-1);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    // Must not wait for the full 5s sleep (SIGTERM at 1s, SIGKILL fallback at +3s).
    expect(elapsed).toBeLessThan(4800);
  }, 15_000);
});

describe('runGates — output tail cap', () => {
  it('keeps at most ~32KB and preserves the TAIL of the output', async () => {
    // 40KB of filler + a sentinel at the very end.
    const cmd = `node -e "process.stdout.write('A'.repeat(40000) + 'TAIL-SENTINEL')"`;
    const res = await runGates(gatesOf([{ name: 'chatty', command: cmd }]), dir);
    expect(res[0].passed).toBe(true);
    expect(res[0].output.length).toBeLessThanOrEqual(32_000);
    expect(res[0].output.length).toBeGreaterThan(30_000);
    expect(res[0].output.endsWith('TAIL-SENTINEL')).toBe(true);
  });

  it('interleaves stdout and stderr in arrival order and caps the combined tail', async () => {
    const cmd = `node -e "process.stderr.write('E'.repeat(20000)); process.stdout.write('O'.repeat(20000)); process.stderr.write('LAST')"`;
    const res = await runGates(gatesOf([{ name: 'mixed', command: cmd }]), dir);
    expect(res[0].output.length).toBeLessThanOrEqual(32_000);
    expect(res[0].output.endsWith('LAST')).toBe(true);
    expect(res[0].output).toContain('O'.repeat(20000));
  });
});

describe('gate result helpers', () => {
  const mk = (over: Partial<GateResult>): GateResult => ({
    name: 'g',
    passed: true,
    command: 'true',
    exitCode: 0,
    output: '',
    durationMs: 5,
    ...over,
  });

  it('allGatesPassed is vacuously true for no gates', () => {
    expect(allGatesPassed([])).toBe(true);
    expect(firstFailedGate([])).toBeUndefined();
  });

  it('firstFailedGate returns the first failing result in order', () => {
    const gates = [
      mk({ name: 'a' }),
      mk({ name: 'b', passed: false, exitCode: 1 }),
      mk({ name: 'c', passed: false, exitCode: 2 }),
    ];
    expect(allGatesPassed(gates)).toBe(false);
    expect(firstFailedGate(gates)?.name).toBe('b');
  });

  it('summarizeGates renders ✓/✗ with exit code and duration, or a placeholder for none', () => {
    expect(summarizeGates([])).toBe('(no gates configured)');
    expect(
      summarizeGates([
        mk({ name: 'typecheck', durationMs: 120 }),
        mk({ name: 'test', passed: false, exitCode: 1, durationMs: 3400 }),
      ])
    ).toBe('✓ typecheck (exit 0, 120ms), ✗ test (exit 1, 3400ms)');
  });
});
