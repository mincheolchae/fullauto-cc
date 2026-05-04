import type { Task, GateResult, RunState } from './types.js';
import { summarizeGates } from './runner/gates.js';
import type { Prerequisite } from './parsers/speckit.js';

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
  } else {
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

  printPlaceholderEnvs(state.placeholderEnvs ?? []);
}

/**
 * Surface env vars that `auto` mode seeded with placeholder values during
 * the run. These are the ones the user MUST replace before going live.
 */
function printPlaceholderEnvs(names: string[]): void {
  if (names.length === 0) return;
  console.log('');
  console.log(
    color(
      'yellow',
      `  ⚠ Placeholder env vars used during this run (replace with real values before going live):`
    )
  );
  for (const n of names) {
    console.log(
      `    • ${color('cyan', n)}  ${color('dim', `(subagents saw: FULLAUTO_PLACEHOLDER_${n})`)}`
    );
  }
  console.log(
    color(
      'dim',
      `    Grep for \`FULLAUTO_PLACEHOLDER_\` in the project to find any code that fell back to the placeholder value.`
    )
  );
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

/**
 * Strip C0/C1 control characters from prereq fields before they hit the
 * terminal. Without this, a malicious tasks.md (fully user-controlled in
 * `run` mode) can embed ANSI CSI / OSC sequences or carriage returns that
 * overwrite earlier "✓ set" status, hide unset markers, or set the terminal
 * title. Keep tab so legitimate whitespace survives.
 */
function sanitizeForTerminal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * A valid POSIX-style env var name. Anything else printed in an [ENV] slot
 * is almost certainly a parser-fallback artifact (planner emitted an unusual
 * separator), and `process.env[that-string]` would always return undefined,
 * giving the user a misleading "✗ NOT SET" with no explanation.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Show the manual-prerequisites checklist surfaced by the planner. ENV
 * variables are cross-checked against `process.env` so the user knows
 * concretely which ones are still missing right now.
 */
export function printPrerequisites(prereqs: Prerequisite[]): {
  missingEnvCount: number;
} {
  if (prereqs.length === 0) {
    console.log('');
    console.log(
      color('dim', '  (planner reported no manual prerequisites)')
    );
    return { missingEnvCount: 0 };
  }

  console.log('');
  console.log(
    color('bold', '=== Manual Prerequisites — please review before run ===')
  );

  let missingEnvCount = 0;
  for (const p of prereqs) {
    const tag = color('magenta', `[${p.kind}]`);
    const safeId = sanitizeForTerminal(p.identifier);
    const safeDesc = sanitizeForTerminal(p.description);
    let line = '';
    if (p.kind === 'ENV') {
      if (!ENV_NAME.test(safeId)) {
        // Don't probe process.env with a malformed key; show the user that
        // the planner produced an unusable line instead of a misleading
        // "NOT SET" verdict that they can't act on.
        const status = color('yellow', '⚠ malformed');
        const desc = safeDesc ? ` — ${safeDesc}` : '';
        line = `  ${tag} ${color('cyan', safeId || '(empty)')}${desc}  ${status}`;
      } else {
        const present = !!process.env[safeId];
        if (!present) missingEnvCount += 1;
        const status = present
          ? color('green', '✓ set')
          : color('red', '✗ NOT SET');
        const desc = safeDesc ? ` — ${safeDesc}` : '';
        line = `  ${tag} ${color('cyan', safeId)}${desc}  ${status}`;
      }
    } else {
      const head = safeId
        ? `${color('cyan', safeId)} — ${safeDesc}`
        : safeDesc;
      line = `  ${tag} ${head}`;
    }
    console.log(line);
  }

  if (missingEnvCount > 0) {
    console.log('');
    console.log(
      color(
        'yellow',
        `  ⚠ ${missingEnvCount} environment variable(s) not currently set in this shell.`
      )
    );
    console.log(
      color(
        'dim',
        `    Tasks that read them at runtime will fail. Export them, or arrange for the implementer subagent to read them from a .env file the project already loads.`
      )
    );
  }
  return { missingEnvCount };
}
