import type { Task, GateResult, RunState } from './types.js';
import { summarizeGates } from './runner/gates.js';
import type { Prerequisite } from './parsers/speckit.js';
import { sanitizeForTerminal } from './protected-env.js';

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

/**
 * Output line from a managed background service. Tagged with the service
 * name so concurrent services (convex + next dev + …) stay readable.
 *
 * Defense-in-depth: services.ts already strips C0/C1 from each piped line,
 * but if a service emits the `[exit code=…]` style markers we generate
 * ourselves (or a future caller wires this up directly), we still want to
 * neutralize anything embedded inside.
 */
export function printServiceLine(serviceName: string, line: string): void {
  const safe = sanitizeForTerminal(line).replace(/\s+$/, '');
  if (!safe) return;
  process.stdout.write(
    color('dim', `  ⎯ ${color('magenta', serviceName)} ${color('dim', safe)}\n`)
  );
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:mm:ss KST`. The locale is fixed
 * to `en-CA` because its date format is the ISO-style `YYYY-MM-DD` we want;
 * `Asia/Seoul` pins the wall-clock to KST regardless of the host's timezone
 * so a CI runner in UTC and the user's laptop print identical timestamps.
 */
function formatKst(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
  return `${date} ${time} KST`;
}

/**
 * Render a millisecond duration as a compact human-readable string. Pass
 * negative or NaN through as `-` so a missing finishedAt doesn't render as
 * a misleading huge negative number.
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms) || ms < 0) return '-';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m ${sec}s`;
}

/**
 * Sum the wall-clock spent on every attempt of a task. Includes retried
 * attempts so the per-task figure reflects how much time the orchestrator
 * actually invested (not just the last successful run). Skips attempts
 * missing `finishedAt` (typically the in-flight one at crash time).
 */
function taskTotalMs(task: Task): number | undefined {
  let total = 0;
  let counted = 0;
  for (const a of task.attempts) {
    if (!a.finishedAt) continue;
    const dt = new Date(a.finishedAt).getTime() - new Date(a.startedAt).getTime();
    if (Number.isFinite(dt) && dt >= 0) {
      total += dt;
      counted += 1;
    }
  }
  return counted === 0 ? undefined : total;
}

function printTimingReport(state: RunState): void {
  console.log('');
  console.log(color('bold', '=== Timing (KST) ==='));

  // Total wall-clock: command-issued → now. Falls back to startedAt for
  // older state files (or `run` mode, where they're equal).
  const commandStart = state.commandStartedAt ?? state.startedAt;
  const now = new Date().toISOString();
  const totalMs =
    new Date(now).getTime() - new Date(commandStart).getTime();
  console.log(
    `  ${color('cyan', 'Command started')}: ${formatKst(commandStart)}`
  );
  console.log(`  ${color('cyan', 'Reported at')}    : ${formatKst(now)}`);
  console.log(
    `  ${color('cyan', 'Total elapsed')}  : ${color('bold', formatDuration(totalMs))}`
  );

  // Plan stage (auto mode only — runs the planner subagent before the
  // orchestrator boots).
  if (state.planStartedAt && state.planFinishedAt) {
    const planMs =
      new Date(state.planFinishedAt).getTime() -
      new Date(state.planStartedAt).getTime();
    console.log('');
    console.log(`  ${color('magenta', 'Plan stage')}`);
    console.log(`    started : ${formatKst(state.planStartedAt)}`);
    console.log(`    finished: ${formatKst(state.planFinishedAt)}`);
    console.log(
      `    duration: ${color('bold', formatDuration(planMs))}`
    );
  }

  // Per-task durations. Skip tasks that never ran (no attempts) — they
  // wouldn't carry useful timing and would clutter the report.
  const ranTasks = state.tasks.filter((t) => t.attempts.length > 0);
  if (ranTasks.length > 0) {
    console.log('');
    console.log(`  ${color('magenta', 'Per-task duration')}`);
    const idWidth = Math.max(...ranTasks.map((t) => t.id.length));
    for (const t of ranTasks) {
      const ms = taskTotalMs(t);
      const dur = formatDuration(ms);
      const attemptTag =
        t.attempts.length > 1 ? ` ${color('dim', `(${t.attempts.length} attempts)`)}` : '';
      const statusColor: keyof typeof c =
        t.status === 'done'
          ? 'green'
          : t.status === 'failed'
          ? 'red'
          : t.status === 'deferred'
          ? 'yellow'
          : 'dim';
      const status = color(statusColor, t.status.padEnd(8));
      const id = t.id.padEnd(idWidth);
      const title =
        t.title.length > 60 ? `${t.title.slice(0, 57)}...` : t.title;
      console.log(
        `    ${color('cyan', id)}  ${status}  ${dur.padStart(10)}  ${color('dim', title)}${attemptTag}`
      );
    }
  }
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
  printTimingReport(state);
}

/**
 * Surface env vars that `auto` mode seeded with placeholder values during
 * the run. Re-checks `process.env` AT REPORT TIME so vars the user fixed
 * mid-run (between `fullauto auto` startup and `runOrchestrator` exit) are
 * shown as "now set — placeholder no longer in effect" instead of being
 * misreported as still-fake. Without this re-check the report lies for
 * any var the user fixed by exporting in their shell after kickoff.
 */
function printPlaceholderEnvs(names: string[]): void {
  if (names.length === 0) return;
  const stillMissing: string[] = [];
  const nowSet: string[] = [];
  for (const n of names) {
    const v = process.env[n];
    if (v && !v.startsWith('FULLAUTO_PLACEHOLDER_')) {
      nowSet.push(n);
    } else {
      stillMissing.push(n);
    }
  }
  console.log('');
  if (stillMissing.length > 0) {
    console.log(
      color(
        'yellow',
        `  ⚠ Placeholder env vars used during this run (replace with real values before going live):`
      )
    );
    for (const n of stillMissing) {
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
  if (nowSet.length > 0) {
    if (stillMissing.length > 0) console.log('');
    console.log(
      color(
        'green',
        `  ✓ Placeholder env vars that you have since set in your shell (subagents may have seen the placeholder for early tasks):`
      )
    );
    for (const n of nowSet) {
      console.log(`    • ${color('cyan', n)}`);
    }
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
