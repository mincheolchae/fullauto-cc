import type { Task, GateResult, RunState, TaskAttempt } from './types.js';
import type { AuditFinding } from './audit/types.js';
import type { EvolveRound, EvolveState } from './product.js';
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

export function printTaskStart(task: Task, attemptNum: number, classification?: string): void {
  const tag = attemptNum > 1 ? color('yellow', `[retry #${attemptNum}]`) : '';
  console.log('');
  console.log(`${color('cyan', `▶ ${task.id}`)} ${task.title} ${tag}`);
  if (classification) console.log(color('dim', `    ${classification}`));
}

/** `BLOCK / WARN` counts of an attempt's audit, or undefined when no audit ran. */
function auditCounts(attempt: TaskAttempt | undefined): { block: number; warn: number } | undefined {
  if (!attempt?.audit) return undefined;
  let block = 0;
  let warn = 0;
  for (const f of attempt.audit.findings) {
    if (f.severity === 'block') block += 1;
    else if (f.severity === 'warn') warn += 1;
  }
  return { block, warn };
}

/**
 * Compact per-attempt verification summary for the task line:
 * `depth: light, tdd: red, audit: 0 BLOCK / 2 WARN`. Every part is optional
 * so old state files (no classification / audit) render as before.
 */
function attemptMeta(attempt: TaskAttempt | undefined): string {
  if (!attempt) return '';
  const parts: string[] = [];
  if (attempt.verifyDepth) parts.push(`depth: ${attempt.verifyDepth}`);
  const phase = attempt.tdd?.phase ?? attempt.classification?.tdd;
  if (phase && phase !== 'none') parts.push(`tdd: ${phase}`);
  const counts = auditCounts(attempt);
  if (counts) {
    const text = `audit: ${counts.block} BLOCK / ${counts.warn} WARN`;
    parts.push(counts.block ? color('red', text) : counts.warn ? color('yellow', text) : text);
  }
  return parts.join(', ');
}

export function printTaskDone(
  task: Task,
  gates: GateResult[],
  durationMs: number,
  attempt?: TaskAttempt
): void {
  const meta = attemptMeta(attempt);
  console.log(
    `  ${color('green', '✓ DONE')}  ${task.id}  (${(durationMs / 1000).toFixed(1)}s${meta ? `, ${meta}` : ''}, gates: ${summarizeGates(gates)})`
  );
}

export function printTaskDeferred(
  task: Task,
  reason: string,
  gates: GateResult[],
  attempt?: TaskAttempt
): void {
  const meta = attemptMeta(attempt);
  // `reason` may be verbatim subagent stdout (DEFER marker text) or gate
  // output — strip control characters so neither can drive the terminal.
  console.log(
    `  ${color('yellow', '⏸ DEFER')} ${task.id}  reason: ${sanitizeForTerminal(reason)}` +
      (meta ? `  (${meta})` : '') +
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
 * Printed live each time a subagent spawn backs off after a rate-limit /
 * usage-cap signal (src/runner/rate-limit.ts). A long unattended run can
 * spend real wall-clock time waiting here; without this line it just looks
 * hung.
 */
export function printRateLimitBackoff(attempt: number, waitMs: number, resetHint?: string): void {
  console.log(
    `  ${color('yellow', '⏳ rate-limited')} — backing off ${(waitMs / 1000).toFixed(0)}s before retry #${attempt}${resetHint ? ` ${color('dim', `(CLI says: ${sanitizeForTerminal(resetHint)})`)}` : ''}`
  );
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
export function formatKst(iso: string): string {
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

/** Every task terminal — the run is over, so its clock stopped at the last attempt. */
export function isRunFinished(state: RunState): boolean {
  return state.tasks.every((t) => t.status === 'done' || t.status === 'failed');
}

/** The latest `finishedAt` across all attempts, or undefined when nothing finished. */
export function lastFinishedAt(state: RunState): string | undefined {
  let last: string | undefined;
  for (const t of state.tasks) {
    for (const a of t.attempts) {
      if (a.finishedAt && (!last || a.finishedAt > last)) last = a.finishedAt;
    }
  }
  return last;
}

function printTimingReport(state: RunState): void {
  console.log('');
  console.log(color('bold', '=== Timing (KST) ==='));

  // Total wall-clock: command-issued → the run's end. For a finished run
  // that is the last attempt's finishedAt, not "now" — `fullauto status` a
  // day later must not report a 24h run. Falls back to startedAt for older
  // state files (or `run` mode, where they're equal).
  const commandStart = state.commandStartedAt ?? state.startedAt;
  const finished = isRunFinished(state) ? lastFinishedAt(state) : undefined;
  const end = finished ?? new Date().toISOString();
  const totalMs = new Date(end).getTime() - new Date(commandStart).getTime();
  console.log(
    `  ${color('cyan', 'Command started')}: ${formatKst(commandStart)}`
  );
  console.log(`  ${color('cyan', finished ? 'Finished at' : 'Reported at')}    : ${formatKst(end)}`);
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
      const meta = attemptMeta(lastRealAttempt(t));
      console.log(
        `    ${color('cyan', id)}  ${status}  ${dur.padStart(10)}  ${color('dim', title)}${attemptTag}` +
          (meta ? `\n${' '.repeat(idWidth + 6)}${color('dim', meta)}` : '')
      );
    }
  }
}

/**
 * The last attempt that actually spawned a subagent. The orchestrator
 * appends SYNTHETIC attempts — "promoted to failed at exit", "pass ended
 * with the task still pending" — that carry no log, no audit and no gate
 * results; picking those would make a failed task lose its `log:` line
 * and its WARNs in the report.
 */
export function lastRealAttempt(task: Task): TaskAttempt | undefined {
  for (let i = task.attempts.length - 1; i >= 0; i--) {
    const a = task.attempts[i];
    if (a.subagentLogPath !== undefined) return a;
  }
  return task.attempts[task.attempts.length - 1];
}

/** Last real attempt of each task that ran, paired with the task — for audit/TDD sections. */
function lastAttempts(state: RunState): Array<{ task: Task; attempt: TaskAttempt }> {
  const out: Array<{ task: Task; attempt: TaskAttempt }> = [];
  for (const t of state.tasks) {
    const last = lastRealAttempt(t);
    if (last) out.push({ task: t, attempt: last });
  }
  return out;
}

/** First line of a defer detail, capped, for the one-line-per-attempt history. */
function firstLine(text: string | undefined, cap = 160): string {
  if (!text) return '';
  const line = text.replace(/^Promoted to failed after orchestrator exit:\s*/, '').split('\n')[0].trim();
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line;
}

/**
 * One line per attempt of an unresolved task: `pass N: <reason> — <first
 * line of detail>`. The synthetic end-of-run attempt is folded into the
 * status line above it (its detail only re-labels the last real signal).
 */
function attemptHistoryLines(task: Task): string[] {
  const lines: string[] = [];
  for (const a of task.attempts) {
    const synthetic = a.subagentLogPath === undefined && a.deferDetail?.startsWith('Promoted to failed after orchestrator exit');
    if (synthetic) continue;
    const reason = a.deferReason ?? (a.finishedAt ? 'done' : 'in progress');
    const detail = sanitizeForTerminal(firstLine(a.deferDetail));
    const rolled =
      a.rollback && a.rollback.files > 0
        ? a.rollback.failed > 0
          ? color('red', ` [rollback PARTIAL: ${a.rollback.failed} path(s) still broken — ${a.rollback.patchPath ?? `${a.rollback.files} file(s)`}]`)
          : color('dim', ` [rolled back: ${a.rollback.patchPath ?? `${a.rollback.files} file(s)`}]`)
        : '';
    lines.push(`      pass ${a.passNumber}: ${reason}${detail ? ` — ${detail}` : ''}${rolled}`);
  }
  return lines;
}

function formatFinding(f: AuditFinding): string {
  // Paths come from `git status` / the subagent's wiring claims — same
  // untrusted surface as the message, so they get the same scrubbing.
  const where = f.path ? ` ${color('cyan', sanitizeForTerminal(f.path))}${f.line ? `:${f.line}` : ''}` : '';
  return `[${f.check}]${where} — ${sanitizeForTerminal(f.message)}`;
}

/**
 * Audit WARNs never block a task, so they only reach a human here. Listed
 * per task from its LAST attempt (earlier attempts' warnings were either
 * fixed or superseded). `tdd-green` warnings are FULLAUTO_TEST_CHANGE
 * notices and get their own section below, so they are excluded here.
 */
function printAuditWarnings(state: RunState): void {
  const rows: Array<{ id: string; f: AuditFinding }> = [];
  for (const { task, attempt } of lastAttempts(state)) {
    for (const f of attempt.audit?.findings ?? []) {
      if (f.severity !== 'warn') continue;
      if (f.check === 'tdd-green') continue;
      rows.push({ id: task.id, f });
    }
  }
  if (rows.length === 0) return;
  console.log('');
  console.log(color('bold', '=== Audit findings (WARN) needing human review ==='));
  for (const { id, f } of rows) {
    console.log(`  • ${color('cyan', id)} ${formatFinding(f)}`);
  }
}

/**
 * Red sets still in state at run end: a red task succeeded but its green
 * task never did (deferred/failed, or the planner never paired one). These
 * tests are still failing in the tree and were quarantined for every later
 * task — the user must know the suite is not actually green.
 */
function printRedTestsNeverGreen(state: RunState): void {
  const red = state.redTests ?? [];
  if (red.length === 0) return;
  console.log('');
  console.log(color('yellow', '=== TDD red tests never turned green ==='));
  for (const r of red) {
    const greenIds = state.tasks
      .filter((t) => {
        const cls = t.attempts[t.attempts.length - 1]?.classification;
        return cls?.tdd === 'green' && cls.redTaskIds.includes(r.taskId);
      })
      .map((t) => `${t.id} [${t.status}]`);
    const files = r.files.map((f) => sanitizeForTerminal(f.path)).join(', ') || '(no files recorded)';
    console.log(
      `  • ${color('cyan', sanitizeForTerminal(r.taskId))} — ${r.failing} failing test(s) in ${files}` +
        (greenIds.length ? `\n      green task(s): ${greenIds.join(', ')}` : `\n      no green task found for this red set`)
    );
  }
  console.log(
    color('dim', `    These tests are still failing in the working tree; the test gate treated them as expected failures. Finish the green task or revert the red tests.`)
  );
}

/**
 * A green task that edited its contract test and declared it with
 * `FULLAUTO_TEST_CHANGE: <file> — <reason>` is downgraded from BLOCK to
 * WARN by the audit. That is a deliberate escape hatch, so every use is
 * surfaced for the human to confirm the test really was wrong.
 */
function printTestChangeNotices(state: RunState): void {
  const rows: Array<{ id: string; f: AuditFinding }> = [];
  for (const { task, attempt } of lastAttempts(state)) {
    for (const f of attempt.audit?.findings ?? []) {
      if (f.check === 'tdd-green' && f.severity === 'warn') rows.push({ id: task.id, f });
    }
  }
  if (rows.length === 0) return;
  console.log('');
  console.log(color('yellow', '=== FULLAUTO_TEST_CHANGE notices (contract tests edited by green tasks) ==='));
  for (const { id, f } of rows) {
    console.log(`  • ${color('cyan', id)} ${formatFinding(f)}`);
  }
}

/**
 * Wiring promises (`- wired by: T###`) still open at run end: the artifact
 * was accepted as orphan-for-now on the strength of a later task wiring it,
 * and that task never did (it failed, never ran, or does not exist). These
 * files are unreachable production code until someone wires them.
 */
function printPendingWiring(state: RunState): void {
  const pending = state.pendingWiring ?? [];
  if (pending.length === 0) return;
  console.log('');
  console.log(color('yellow', '=== Wiring promises never fulfilled ==='));
  for (const p of pending) {
    const wirer = state.tasks.find((t) => t.id === p.wiredBy);
    const status = wirer ? `${p.wiredBy} [${wirer.status}]` : `${p.wiredBy} (no such task)`;
    console.log(
      `  • ${color('cyan', sanitizeForTerminal(p.artifactPath))} — created by ${sanitizeForTerminal(p.createdBy)}, to be wired by ${sanitizeForTerminal(status)}`
    );
  }
  console.log(
    color('dim', `    Nothing in production code imports, renders or mounts these files yet. Wire them in (or delete them) before shipping.`)
  );
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
      const real = lastRealAttempt(t);
      const last = t.attempts[t.attempts.length - 1];
      const reason = last?.deferReason ?? (t.status === 'failed' ? 'failed' : 'pending');
      const history = attemptHistoryLines(t);
      const warns = (real?.audit?.findings ?? []).filter((f) => f.severity === 'warn');
      console.log(
        `    • ${color('cyan', t.id)} [${t.status}] ${sanitizeForTerminal(t.title)}` +
          `\n      reason: ${reason}${history.length === 0 && last?.deferDetail ? ` — ${sanitizeForTerminal(firstLine(last.deferDetail))}` : ''}` +
          (history.length ? `\n${history.join('\n')}` : '') +
          (real?.subagentLogPath ? `\n      log: ${real.subagentLogPath}` : '') +
          (warns.length ? `\n      warn: ${warns.map((f) => formatFinding(f)).join('\n            ')}` : '')
      );
    }
  }

  printPreflightWarnings(state.preflightWarnings ?? []);
  printAuditWarnings(state);
  printRedTestsNeverGreen(state);
  printPendingWiring(state);
  printTestChangeNotices(state);
  printPlaceholderEnvs(state.placeholderEnvs ?? []);
  printRateLimitSummary(state);
  printTimingReport(state);
  printNextStep(state);
}

/**
 * Aggregate rate-limit backoff across the whole run (src/runner/rate-limit.ts).
 * Silent when it never happened — most runs never see this line.
 */
function printRateLimitSummary(state: RunState): void {
  const hits = state.rateLimitHits ?? 0;
  if (hits === 0) return;
  console.log('');
  console.log(
    color('yellow', `  ⏳ rate-limited ${hits} time(s), waited ${((state.rateLimitWaitMs ?? 0) / 1000).toFixed(0)}s total`)
  );
}

/**
 * The last line says what to do now. A failed task is usually fixed by hand
 * (a missing credential, a wrong assumption in tasks.md) and then retried —
 * `fullauto retry` re-queues exactly those tasks with one more pass.
 */
function printNextStep(state: RunState): void {
  console.log('');
  const failed = state.tasks.filter((t) => t.status === 'failed').map((t) => t.id);
  const inFlight = state.tasks.some((t) => t.status === 'in_progress' || t.status === 'pending' || t.status === 'deferred');
  if (failed.length > 0) {
    const cmd = failed.length <= 3 ? `fullauto retry ${failed.join(' ')}` : `fullauto retry`;
    console.log(
      `  ${color('bold', 'Next:')} \`${cmd}\` to re-run the ${failed.length} failed task(s) after fixing the cause, or edit tasks.md and \`fullauto run --force\` to start over.`
    );
  } else if (inFlight) {
    console.log(`  ${color('bold', 'Next:')} \`fullauto resume\` to continue the unfinished run.`);
  } else {
    console.log(`  ${color('bold', 'Next:')} review the changes (\`git diff\`, the WARN sections above) and commit.`);
  }
}

/**
 * Run-start preflight warnings are easy to scroll past on a long run, so
 * the final report repeats them: a run whose test gate never executed a
 * test is "green" for the wrong reason.
 */
function printPreflightWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log('');
  console.log(color('yellow', '=== Preflight warnings (from run start) ==='));
  for (const w of warnings) console.log(`  • ${sanitizeForTerminal(w)}`);
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

// ---------- fullauto evolve ----------

export function printEvolveRoundStart(round: number, maxRounds: number, stage: string): void {
  console.log('');
  console.log(color('bold', `=== Evolve round ${round}/${maxRounds} — stage: ${stage} ===`));
}

/** Verdict word colored by what it means for the loop. */
function verdictLabel(verdict: EvolveRound['verdict']): string {
  if (verdict === 'ship') return color('green', 'ship');
  if (verdict === 'stop') return color('red', 'stop');
  if (verdict === 'continue') return color('yellow', 'continue');
  return color('dim', '(no verdict)');
}

export function printEvolveRoundEnd(rec: EvolveRound): void {
  const dur =
    rec.finishedAt !== undefined
      ? formatDuration(new Date(rec.finishedAt).getTime() - new Date(rec.startedAt).getTime())
      : '-';
  console.log('');
  console.log(
    color('bold', `=== Evolve round ${rec.round} finished ===`) +
      `  ${color('green', `done: ${rec.tasksDone}`)}  ${color('red', `failed: ${rec.tasksFailed}`)}` +
      `  score: ${rec.score ?? '?'}  verdict: ${verdictLabel(rec.verdict)}  (${dur})`
  );
  if (rec.backlogItems.length) console.log(`  items: ${rec.backlogItems.map(sanitizeForTerminal).join(', ')}`);
  if (rec.nextItems.length) console.log(`  next : ${rec.nextItems.map(sanitizeForTerminal).join(', ')}`);
  if (rec.reason) console.log(color('dim', `  ${sanitizeForTerminal(rec.reason)}`));
}

export interface EvolveReportExtras {
  productPath: string;
  roundsDir: string;
  /** Backlog lines still open in product.md (top N, already formatted). */
  backlogRemaining: string[];
}

const OUTCOME_TEXT: Record<NonNullable<EvolveState['outcome']>, string> = {
  ship: 'ship — the assessor judged the MVP loop complete',
  stop: 'stop — blocked by something outside autonomy (see Decisions in product.md)',
  max_rounds: 'round cap reached',
  time_budget: 'time budget exceeded (resume with `fullauto evolve` to continue)',
  no_progress: 'no progress — the last round finished zero tasks',
  stalled: 'stalled — two rounds in a row picked the same next items and no feature reached done',
  aborted: 'aborted — a stage failed hard (see the error above)',
};

export function printEvolveReport(state: EvolveState, extras: EvolveReportExtras): void {
  console.log('');
  console.log(color('bold', '=== Evolve Report ==='));
  console.log(`  ${color('cyan', 'Concept')}: ${sanitizeForTerminal(state.concept)}`);
  console.log(`  ${color('cyan', 'Rounds ')}: ${state.rounds.length} of max ${state.maxRounds} (≤ ${state.maxTasksPerRound} tasks each)`);
  const outcome = state.outcome ? OUTCOME_TEXT[state.outcome] : 'in progress';
  const outcomeColor: keyof typeof c =
    state.outcome === 'ship' ? 'green' : state.outcome === 'max_rounds' || state.outcome === 'time_budget' ? 'yellow' : state.outcome ? 'red' : 'dim';
  console.log(`  ${color('cyan', 'Outcome')}: ${color(outcomeColor, outcome)}`);
  if (state.outcomeDetail) console.log(color('dim', `           ${sanitizeForTerminal(state.outcomeDetail)}`));

  if (state.rounds.length) {
    console.log('');
    console.log(`  ${color('magenta', 'Per round')}`);
    for (const r of state.rounds) {
      const items = r.backlogItems.length ? r.backlogItems.map(sanitizeForTerminal).join(',') : '-';
      const score = r.score !== undefined ? String(r.score).padStart(3) : '  ?';
      console.log(
        `    ${color('cyan', `round ${r.round}`)}  stage: ${r.stage.padEnd(6)}  ` +
          `${color('green', `done ${String(r.tasksDone).padStart(2)}`)}  ${color('red', `failed ${String(r.tasksFailed).padStart(2)}`)}  ` +
          `score ${score}  verdict: ${verdictLabel(r.verdict)}  items: ${items}`
      );
    }
  }

  const done = state.rounds.reduce((n, r) => n + r.tasksDone, 0);
  const failed = state.rounds.reduce((n, r) => n + r.tasksFailed, 0);
  console.log('');
  console.log(`  ${color('cyan', 'Tasks  ')}: ${color('green', `done ${done}`)}  ${color('red', `failed ${failed}`)}`);

  if (extras.backlogRemaining.length) {
    console.log('');
    console.log(`  ${color('magenta', 'Backlog remaining')} (top ${extras.backlogRemaining.length})`);
    for (const line of extras.backlogRemaining) console.log(`    • ${sanitizeForTerminal(line)}`);
  } else {
    console.log('');
    console.log(color('dim', '  Backlog: nothing open in product.md.'));
  }

  printPlaceholderEnvs(state.placeholderEnvs ?? []);

  console.log('');
  console.log(`  ${color('cyan', 'Product brief')}: ${extras.productPath}`);
  console.log(`  ${color('cyan', 'Round archives')}: ${extras.roundsDir}/<r>/ (tasks.md, state.json, logs/)`);
  console.log('');
  console.log(color('bold', '=== Timing (KST) ==='));
  const finishedAt = state.finishedAt ?? new Date().toISOString();
  console.log(`  ${color('cyan', 'Started ')}: ${formatKst(state.startedAt)}`);
  console.log(`  ${color('cyan', 'Finished')}: ${formatKst(finishedAt)}`);
  console.log(
    `  ${color('cyan', 'Elapsed ')}: ${color('bold', formatDuration(new Date(finishedAt).getTime() - new Date(state.startedAt).getTime()))}`
  );
  for (const r of state.rounds) {
    if (!r.finishedAt) continue;
    console.log(
      `    round ${r.round}: ${formatDuration(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())}`
    );
  }
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
