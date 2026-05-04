import type { Task, GateResult, RunState } from './types.js';
import { summarizeGates } from './runner/gates.js';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function color(name: keyof typeof c, s: string): string {
  return process.stdout.isTTY ? `${c[name]}${s}${c.reset}` : s;
}

export function printPassStart(
  pass: number,
  readyCount: number,
  blockedCount: number
): void {
  console.log('');
  const blockedSuffix =
    blockedCount > 0 ? `, ${blockedCount} blocked by deps` : '';
  console.log(
    color(
      'bold',
      `=== Pass ${pass} — ${readyCount} ready task(s)${blockedSuffix} ===`
    )
  );
}

export function printTaskStart(task: Task, attemptNum: number): void {
  const tag = attemptNum > 1 ? color('yellow', `[retry #${attemptNum}]`) : '';
  console.log('');
  console.log(`${color('cyan', `▶ ${task.id}`)} ${task.title} ${tag}`);
}

export function printTaskDone(task: Task, gates: GateResult[], durationMs: number): void {
  console.log(
    `  ${color('green', '✓ DONE')}  ${task.id}  (${(durationMs / 1000).toFixed(1)}s, gates: ${summarizeGates(gates)})`
  );
}

export function printTaskDeferred(task: Task, reason: string, gates: GateResult[]): void {
  console.log(
    `  ${color('yellow', '⏸ DEFER')} ${task.id}  reason: ${reason}` +
      (gates.length ? `  (gates: ${summarizeGates(gates)})` : '')
  );
}

export function printTaskFailed(task: Task, reason: string): void {
  console.log(`  ${color('red', '✗ FAIL')}  ${task.id}  ${reason}`);
}

export function printSubagentStreamLine(line: string): void {
  // Indent and dim subagent output so it's visually subordinate.
  process.stdout.write(color('dim', `    │ ${line.replace(/\s+$/, '')}\n`));
}

export function printFinalReport(state: RunState): void {
  console.log('');
  console.log(color('bold', '=== Final Report ==='));
  const counts = { done: 0, deferred: 0, failed: 0, pending: 0, in_progress: 0 };
  for (const t of state.tasks) counts[t.status] += 1;

  console.log(
    `  ${color('green', `done: ${counts.done}`)}` +
      `  ${color('yellow', `deferred: ${counts.deferred}`)}` +
      `  ${color('red', `failed: ${counts.failed}`)}` +
      `  ${color('dim', `pending: ${counts.pending}`)}`
  );

  const unresolved = state.tasks.filter(
    (t) => t.status === 'deferred' || t.status === 'failed' || t.status === 'pending'
  );
  if (unresolved.length === 0) {
    console.log(color('green', '\n  ✓ All tasks complete.'));
    return;
  }

  console.log('');
  console.log(color('yellow', '  Unresolved tasks (need user attention):'));
  for (const t of unresolved) {
    const last = t.attempts[t.attempts.length - 1];
    const reason =
      last?.deferReason ?? (t.status === 'failed' ? 'failed' : 'pending');
    const detail = last?.deferDetail ?? '';
    console.log(
      `    • ${color('cyan', t.id)} [${t.status}] ${t.title}` +
        `\n      reason: ${reason}${detail ? ` — ${detail}` : ''}` +
        (last?.subagentLogPath ? `\n      log: ${last.subagentLogPath}` : '')
    );
  }
}

export function printNoProgressBail(): void {
  console.log('');
  console.log(
    color('red', '⚠ Pass made no progress — terminating to avoid infinite loop.')
  );
}

export function printResume(stateFile: string): void {
  console.log(color('dim', `Resumed from ${stateFile}`));
}

export function printInfo(msg: string): void {
  console.log(color('blue', `ℹ ${msg}`));
}

export function printWarn(msg: string): void {
  console.log(color('yellow', `⚠ ${msg}`));
}

export function printError(msg: string): void {
  console.log(color('red', `✗ ${msg}`));
}
