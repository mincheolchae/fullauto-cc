import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  loadPrerequisitesFromFile,
  loadTasksFromFile,
} from './parsers/speckit.js';
import {
  loadUserConfig,
  patchPathFor,
  saveState,
  paths,
} from './persistence.js';
import { RunConfig, type RunState, type Task, type VerifyMode } from './types.js';
import { passLimit, runOrchestrator } from './orchestrator.js';
import { throwIfInterrupted } from './runner/process-group.js';
import { rollbackToTree } from './rollback.js';
import { canonicalTaskId } from './task-class.js';
import { isGitRepo } from './audit/git.js';
import { runPlanner, checkPlannerOutput, type PlannerProductContext } from './planner.js';
import { validatePlanShape } from './plan-validator.js';
import { extractProductContext, loadProductBrief, validateProductBrief } from './product.js';
import {
  printError,
  printInfo,
  printPrerequisites,
  printRateLimitBackoff,
  printWarn,
} from './reporter.js';

/**
 * The "plan → fresh run" building blocks shared by `fullauto run`, `auto`
 * and `evolve`. They live outside cli.ts because that module parses argv
 * on import; `evolve.ts` must be importable by tests without doing so.
 *
 * None of these set `process.exitCode` — they report what happened (null /
 * false) and the CLI command decides the exit code, so a caller that
 * retries a failed stage (evolve) does not have to undo a stale code.
 */

/**
 * Process exit code for a finished run: 0 only when every task is done.
 * Failed / still-unresolved tasks make the run a failure for CI and for
 * anyone chaining `fullauto run && deploy`. The evolve loop never goes
 * through this — it reads the run state directly and keeps its own codes.
 */
export function exitCodeForRun(state: RunState | null): number {
  if (!state) return 2;
  return state.tasks.every((t) => t.status === 'done') ? 0 : 1;
}

export interface RetryPlan {
  /** Failed tasks flipped back to `deferred`, in file order. */
  requeued: string[];
  /** Named tasks that exist but are not `failed` (nothing to retry). */
  skipped: string[];
  /** Named ids that are not in the run. */
  missing: string[];
}

/**
 * `fullauto retry [ids...]`: flip failed tasks back to `deferred` and open
 * one more pass for them. The pass history is kept (the retry runs as pass
 * N+1, never as a reset to pass 1); when that pass lies beyond
 * `maxPasses` the budget is extended exactly far enough to run it,
 * recorded in `state.extraPasses` so a later resume (which re-adopts the
 * live config.json) cannot take it away again. A failed task that never
 * ran because a retried task was its unfinished dependency is re-queued
 * along with it — retrying T007 without the T008 that only ever waited on
 * it would leave T008 failed for no reason.
 */
export function requeueFailedTasks(state: RunState, ids: string[] = []): RetryPlan {
  const plan: RetryPlan = { requeued: [], skipped: [], missing: [] };
  const byId = new Map(state.tasks.map((t) => [t.id, t] as const));
  const wanted = new Set<string>();
  if (ids.length === 0) {
    for (const t of state.tasks) if (t.status === 'failed') wanted.add(t.id);
  } else {
    for (const raw of ids) {
      const id = byId.has(raw) ? raw : (canonicalTaskId(raw) ?? raw);
      const t = byId.get(id);
      if (!t) plan.missing.push(raw);
      else if (t.status !== 'failed') plan.skipped.push(id);
      else wanted.add(id);
    }
  }
  if (plan.missing.length > 0) return plan;

  // Transitively pull in failed dependents whose only failures were
  // `depends_on_unfinished_task` (they were never actually attempted).
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of state.tasks) {
      if (t.status !== 'failed' || wanted.has(t.id)) continue;
      if (!t.dependencies.some((d) => wanted.has(d))) continue;
      const neverRan = t.attempts.every((a) => a.subagentLogPath === undefined && a.deferReason === 'depends_on_unfinished_task');
      if (!neverRan) continue;
      wanted.add(t.id);
      grew = true;
    }
  }

  for (const t of state.tasks) {
    if (!wanted.has(t.id)) continue;
    t.status = 'deferred';
    // Mark the boundary BEFORE the retry's new attempt: orchestrator.ts's
    // `originalHeadSha` / `resolvePriorTouched` only look at attempts from
    // here forward, so the retry establishes a wholly fresh baseline (the
    // tree as it is RIGHT NOW — including whatever the user fixed and
    // committed between the original failed run and this retry) instead of
    // comparing against the stale pre-fix baseline from attempt 1.
    t.baselineResetAtAttempt = t.attempts.length;
    plan.requeued.push(t.id);
  }
  if (plan.requeued.length > 0) {
    state.currentPass += 1;
    state.extraPasses = Math.max(state.extraPasses ?? 0, state.currentPass - state.config.maxPasses);
  }
  return plan;
}

/** Pass budget after a retry, for the CLI's info line. */
export function retryPassLimit(state: RunState): number {
  return passLimit(state);
}

/**
 * A task caught mid-flight (in_progress) — crashed, or interrupted by a
 * signal — goes back to pending so it is re-attempted; the unfinished
 * attempt stays on record (see orchestrator `requeueResumedPendingTasks`).
 * Shared by `fullauto run`/`auto`/`resume`/`retry` (cli.ts) and evolve's
 * own run-stage resume (evolve.ts `runStage`) — both reconcile a state.json
 * that may have an in-flight attempt from a crash or Ctrl-C.
 *
 * Round 3 / item 2: the crashed attempt's tree changes are ALSO rolled back
 * here, the same way `rollbackOnDefer` rolls back a deferred attempt. The
 * previous behavior — leave a crashed attempt's partial edits in the tree
 * "in case the user wants to inspect them" — contradicts genuinely
 * unattended automation: in practice nobody inspects it, and the next
 * attempt just retries on top of a half-written / orphaned file the
 * crashed attempt left behind (the same cascading-failure shape
 * rollback-on-defer already fixes for ordinary defers). The diff is still
 * saved as a `.patch` first, so nothing is silently lost — the user can
 * recover it by hand, they just aren't blocking the automation on it.
 *
 * Opt-out: `rollbackOnDefer: false` disables rollback everywhere (unchanged
 * behavior); `rollbackOnResume: false` disables ONLY this resume-time
 * rollback while defer-rollback stays on, for a user who specifically wants
 * to inspect a crashed attempt without giving up rollback-on-defer.
 */
export async function resetInterrupted(projectDir: string, state: RunState): Promise<void> {
  const rollbackOnResume = state.config.rollbackOnResume ?? state.config.rollbackOnDefer;
  for (const t of state.tasks) {
    if (t.status !== 'in_progress') continue;
    t.status = 'pending';
    if (!rollbackOnResume) continue;
    const attemptNum = t.attempts.length;
    const attempt = t.attempts[attemptNum - 1];
    const treeSha = attempt?.baseline?.treeSha;
    if (!treeSha) continue; // rollbackOnDefer was off / not a git repo when this attempt started
    const patchPath = patchPathFor(projectDir, t.id, attemptNum);
    const res = await rollbackToTree(projectDir, treeSha, patchPath);
    if (!res) {
      printWarn(`${t.id}: rollback of the interrupted attempt ${attemptNum} failed (git error) — its changes stay in the tree.`);
      continue;
    }
    attempt.rollback = { patchPath: res.patchPath, files: res.files, restored: res.restored.length, deleted: res.deleted.length, failed: res.failed.length };
    if (res.failed.length > 0) {
      printWarn(
        `${t.id}: rollback of the interrupted attempt ${attemptNum} only PARTIALLY restored the tree — ${res.failed.length} path(s) could not be restored and still carry this attempt's changes: ${res.failed.join(', ')}.`
      );
    } else if (res.files > 0) {
      printInfo(
        `${t.id}: rolled back the interrupted attempt ${attemptNum} — ${res.restored.length} file(s) restored, ${res.deleted.length} removed; diff saved at ${res.patchPath ?? '(patch not written)'}.`
      );
    }
  }
}

/**
 * Idempotently ensure `entry` is present in the project's .gitignore. Creates
 * the file if missing. Returns true if a write happened (entry added), false
 * if it was already present.
 */
export async function ensureGitignoreEntry(
  projectDir: string,
  entry: string
): Promise<boolean> {
  const path = resolve(projectDir, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(path, 'utf-8');
  } catch {
    // .gitignore doesn't exist; we'll create it
  }
  const lines = existing.split(/\r?\n/);
  const normalizedEntry = entry.trim();
  // Match exact line OR line with the same path but stripped trailing slash —
  // both `.fullauto` and `.fullauto/` mean the same thing in .gitignore.
  const alreadyPresent = lines.some((l) => {
    const t = l.trim();
    return (
      t === normalizedEntry ||
      t === normalizedEntry.replace(/\/$/, '') ||
      t === `${normalizedEntry.replace(/\/$/, '')}/`
    );
  });
  if (alreadyPresent) return false;
  const newline = existing.endsWith('\n') || existing === '' ? '' : '\n';
  await writeFile(path, `${existing}${newline}${normalizedEntry}\n`, 'utf-8');
  return true;
}

/**
 * `.fullauto/state.json` quotes every task body and every audit finding —
 * including the paths of files the audit just called orphaned. The audit's
 * reference search covers untracked files, so unless `.fullauto/` is
 * ignored, state.json itself would count as a "production reference" for
 * any path it mentions and the orphan check would pass on the retry.
 * `fullauto init` adds the entry; `run` / `auto` / `resume` / `evolve`
 * repeat it for projects that skipped init (the config is optional) — only
 * inside a git work tree, where the audit actually runs.
 */
export async function ensureRunStateIgnored(projectDir: string): Promise<void> {
  if (!(await isGitRepo(projectDir))) return;
  if (await ensureGitignoreEntry(projectDir, '.fullauto/')) {
    printInfo('Added `.fullauto/` to .gitignore (keeps run state out of the audit\'s reference search).');
  }
}

/**
 * `--verify` is a per-invocation override, safe to apply on resume too:
 * unlike --vibe-enhance it only changes how DEEP each remaining task is
 * reviewed, never which tasks exist. On resume the user typically wants
 * exactly this ("the run is churning on reviews — finish it gates-only").
 */
export function applyVerifyOverride(config: RunConfig, mode: VerifyMode | undefined): void {
  if (!mode) return;
  if (config.verifyMode !== mode) {
    printInfo(`--verify ${mode}: overriding config.verifyMode (${config.verifyMode}) for this run.`);
  }
  config.verifyMode = mode;
  // `useVerifyLoop: false` would silently win over an explicit --verify
  // full/adaptive (see effectiveVerifyMode); the CLI flag is the stronger
  // signal, so lift the legacy switch when the user asked for review.
  if (mode !== 'gates-only' && config.useVerifyLoop === false) {
    printWarn(`config.useVerifyLoop is false but --verify ${mode} was given — enabling verify-loop for this run.`);
    config.useVerifyLoop = true;
  }
}

/**
 * On resume, prefer the live `.fullauto/config.json` over the snapshot saved
 * inside `state.json`. This lets the user edit gates / timeouts / passes
 * after a crash without having to discard state. If the file changed, log
 * the diff so the user knows their edits took effect.
 */
export async function reconcileConfigOnResume(
  projectDir: string,
  state: RunState
): Promise<void> {
  const liveRaw = await loadUserConfig(projectDir);
  if (!liveRaw) return;
  let live: ReturnType<typeof RunConfig.parse>;
  try {
    live = RunConfig.parse(liveRaw);
  } catch {
    printWarn(
      `.fullauto/config.json failed to parse on resume — keeping snapshotted config from state.json.`
    );
    return;
  }
  const snapshotJson = JSON.stringify(state.config);
  const liveJson = JSON.stringify(live);
  if (snapshotJson === liveJson) return;
  state.config = live;
  printInfo(`Detected edits in .fullauto/config.json — using updated config.`);
}

export interface FreshRunArgs {
  projectDir: string;
  tasksPath: string;
  verbose: boolean;
  strictPrereqs?: boolean;
  /**
   * `auto` mode seeds placeholder values for unset [ENV] items so subagents
   * can still spawn and the run is reported at end; `run` mode just warns
   * about missing env vars and proceeds. Neither mode prompts the user.
   */
  autoMode?: boolean;
  /** CLI-level override for config.vibeEnhance. When true, force-enable. */
  vibeEnhance?: boolean;
  /** CLI-level override for config.verifyMode (`--verify`). */
  verifyMode?: VerifyMode;
  /** Remaining run-wide enhance budget carried over from earlier evolve rounds (default: `config.enhanceBudget`). */
  enhanceBudgetRemaining?: number;
  /**
   * Timing fields for the final report. Captured by the caller so `auto`
   * mode can include the planner stage in the total wall-clock. When
   * omitted (e.g. `run` mode), the orchestrator's startedAt covers the
   * full elapsed window.
   */
  commandStartedAt?: string;
  planStartedAt?: string;
  planFinishedAt?: string;
}

/**
 * Common path for "fresh run from a tasks.md file": load the tasks, validate
 * the config has gates, init state, persist, and start the orchestrator.
 * Used by `fullauto run`, `fullauto auto` and every `fullauto evolve` round.
 *
 * Returns the final run state, or null if startup was aborted (invalid
 * tasks file, empty gates, `--strict-prereqs` with unset env vars).
 */
export async function startFreshRun(args: FreshRunArgs): Promise<RunState | null> {
  const { projectDir, tasksPath, verbose, autoMode } = args;
  const tasks = await loadTasksFromFile(tasksPath);

  // Validate the parsed task list BEFORE the orchestrator inherits it.
  // This catches dangling deps / cycles / duplicate IDs in hand-written
  // tasks.md and speckit output too — `runPlanFlow` already validates
  // its own planner output, but `fullauto run <file>` came in here
  // direct without going through that path. Without this, queue.ts:131's
  // "unknown deps treated as satisfied" fallback and orchestrator.ts:60-65's
  // cycle-warn-and-proceed silently let the bad plan execute.
  const validation = validatePlanShape(tasks);
  if (!validation.ok) {
    printError(
      `Tasks file failed validation (${validation.errors.length} error(s)):`
    );
    for (const e of validation.errors) console.error(`    • ${e}`);
    console.error(
      `  Tasks file: ${tasksPath}\n  Edit it to resolve the issues, then re-run.`
    );
    return null;
  }
  for (const w of validation.warnings) printWarn(w);

  const userConfig = (await loadUserConfig(projectDir)) ?? {};
  const config = RunConfig.parse(userConfig);
  // CLI flag forces vibeEnhance on for this run. We deliberately don't
  // implement a way to force it OFF from the CLI — config.json is the place
  // for that. (If users want it permanently on, set it in config.json and
  // skip the flag.)
  if (args.vibeEnhance) config.vibeEnhance = true;
  applyVerifyOverride(config, args.verifyMode);

  // An empty gates list silently makes every task auto-pass (allGatesPassed
  // returns true on []), defeating the whole verification design.
  if (config.gates.length === 0) {
    printError(
      `Refusing to run: config has no verification gates. Without gates, every task is auto-passed without any check. Run \`fullauto init\` to write the default gate config, or add at least one gate to .fullauto/config.json.`
    );
    return null;
  }

  printInfo(
    `Loaded ${tasks.length} task(s) from ${tasksPath}. Project: ${projectDir}`
  );

  await ensureRunStateIgnored(projectDir);

  // Surface manual prerequisites then proceed without prompting. `auto` mode
  // additionally seeds placeholder env values so subagents can still spawn
  // even when real credentials aren't set; `run` mode only refuses to start
  // when --strict-prereqs is set AND a [ENV] prereq is unset.
  let placeholderEnvs: string[] = [];
  if (autoMode) {
    placeholderEnvs = await collectPlaceholderEnvs(tasksPath);
  } else {
    const proceed = await surfacePrerequisites(tasksPath, {
      strict: args.strictPrereqs ?? false,
    });
    if (!proceed) return null;
  }

  const startedAt = new Date().toISOString();
  const state: RunState = {
    startedAt,
    currentPass: 1,
    tasks,
    config,
    passSnapshots: [],
    placeholderEnvs,
    commandStartedAt: args.commandStartedAt ?? startedAt,
    planStartedAt: args.planStartedAt,
    planFinishedAt: args.planFinishedAt,
    redTests: [],
    pendingWiring: [],
    preflightWarnings: [],
    extraPasses: 0,
    rateLimitHits: 0,
    rateLimitWaitMs: 0,
    ...(args.enhanceBudgetRemaining !== undefined ? { enhanceBudgetRemaining: args.enhanceBudgetRemaining } : {}),
  };
  await saveState(projectDir, state);

  return runOrchestrator({ projectDir, state, verbose });
}

/**
 * In `auto` mode: print the prereq checklist for visibility, then return the
 * subset of [ENV] entries with valid POSIX names whose value is unset. The
 * orchestrator seeds those into spawned subagents as FULLAUTO_PLACEHOLDER_<N>
 * and reports them at run end so the user knows what to replace.
 */
export async function collectPlaceholderEnvs(tasksPath: string): Promise<string[]> {
  const prereqs = await loadPrerequisitesFromFile(tasksPath);
  if (prereqs.length === 0) return [];
  printPrerequisites(prereqs);
  const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const missing = prereqs
    .filter(
      (p) =>
        p.kind === 'ENV' &&
        ENV_NAME.test(p.identifier) &&
        !process.env[p.identifier]
    )
    .map((p) => p.identifier);
  if (missing.length > 0) {
    printInfo(
      `auto mode: seeding ${missing.length} placeholder env var(s) for subagents — will be reported at run end for replacement.`
    );
  }
  return missing;
}

/**
 * Read tasks file, surface its Manual Prerequisites section, then proceed
 * without prompting. The orchestrator never asks the user "continue?" —
 * the design choice is that runs go through unattended so CI / pipelines
 * / overnight runs don't deadlock at a TTY-only prompt.
 *
 * Behavior:
 *  - No prereqs in the file → silent passthrough, returns true.
 *  - Prereqs present → print the checklist, then return true (proceed).
 *  - `--strict-prereqs` AND missing [ENV] items → return false (refuse to
 *    start). This is the only way the call ever returns false.
 *
 * Missing env vars during the run will surface as gate failures or
 * subagent errors, which the orchestrator's normal defer/retry loop
 * handles. `auto` mode additionally seeds placeholder values and reports
 * them at run end.
 */
export async function surfacePrerequisites(
  tasksPath: string,
  opts: { strict: boolean }
): Promise<boolean> {
  const prereqs = await loadPrerequisitesFromFile(tasksPath);
  if (prereqs.length === 0) return true;

  const { missingEnvCount } = printPrerequisites(prereqs);

  if (opts.strict && missingEnvCount > 0) {
    printError(
      `--strict-prereqs and ${missingEnvCount} unset env var(s) — refusing to start.`
    );
    return false;
  }

  if (missingEnvCount > 0) {
    printWarn(
      `Proceeding with ${missingEnvCount} unset env var(s) — they will likely surface as gate failures.`
    );
  }
  return true;
}

/**
 * Resolve the planner timeout from (a) explicit CLI flag, falling back to
 * (b) `.fullauto/config.json`'s `plannerTimeoutSec`, then (c) the schema
 * default (900s). The CLI flag wins when present so users can ad-hoc bump
 * a tight planner without permanently editing config.
 *
 * Loads config via the user-config path so the same precedence applies to
 * `plan` (which never touches RunConfig defaults) and `auto` (which does).
 * If the file is missing or unparseable, falls through silently — the
 * planner is independent of orchestrator gating.
 */
export async function resolvePlannerTimeoutSec(
  projectDir: string,
  cliFlag: number | undefined
): Promise<number> {
  if (cliFlag !== undefined) return cliFlag;
  const raw = await loadUserConfig(projectDir);
  if (raw) {
    const parsed = RunConfig.safeParse(raw);
    if (parsed.success) return parsed.data.plannerTimeoutSec;
  }
  // Fall back to the schema default.
  return RunConfig.parse({}).plannerTimeoutSec;
}

/**
 * Floor under the derived `evolveStageTimeoutSec` default, regardless of how
 * small `plannerTimeoutSec` is configured — see the field's doc comment in
 * types.ts for why shape/assess need more room than the plain planner.
 */
export const EVOLVE_STAGE_TIMEOUT_FLOOR_SEC = 1800;

/**
 * Resolve the timeout for evolve's shape and assess stages: explicit
 * `config.evolveStageTimeoutSec` when set, else derived from the
 * already-resolved planner timeout as `max(plannerTimeoutSec * 2,
 * EVOLVE_STAGE_TIMEOUT_FLOOR_SEC)`. Kept as a plain function over
 * `plannerTimeoutSec` (not re-reading config.json's `plannerTimeoutSec`
 * itself) so callers that already resolved it (e.g. `runEvolve`, which also
 * needs it for the CLI-flag precedence `resolvePlannerTimeoutSec` applies)
 * do not pay for a second file read just to recompute the same value.
 */
export async function resolveEvolveStageTimeoutSec(
  projectDir: string,
  plannerTimeoutSec: number
): Promise<number> {
  const raw = await loadUserConfig(projectDir);
  if (raw) {
    const parsed = RunConfig.safeParse(raw);
    if (parsed.success && parsed.data.evolveStageTimeoutSec !== undefined) {
      return parsed.data.evolveStageTimeoutSec;
    }
  }
  return Math.max(plannerTimeoutSec * 2, EVOLVE_STAGE_TIMEOUT_FLOOR_SEC);
}

/** `config.mcpConfigPath` from the user config, when the file parses. */
export async function resolveMcpConfigPath(projectDir: string): Promise<string | undefined> {
  const userConfigRaw = await loadUserConfig(projectDir);
  if (!userConfigRaw) return undefined;
  const parsed = RunConfig.safeParse(userConfigRaw);
  return parsed.success ? parsed.data.mcpConfigPath : undefined;
}

/**
 * Product context for the planner when `.fullauto/product.md` exists: a
 * manual `fullauto auto` / `plan` after an evolve run then plans against
 * the same brief the rounds used. An invalid brief is skipped with a
 * warning rather than inlined — a half-broken brief would mislead the
 * planner more than no brief. `round` / `maxTasks` are added by evolve.
 */
export async function loadPlannerProductContext(
  projectDir: string,
  extra: Pick<PlannerProductContext, 'round' | 'maxTasks'> = {}
): Promise<PlannerProductContext | undefined> {
  const source = await loadProductBrief(projectDir);
  if (source === null) return undefined;
  const productPath = paths(projectDir).productPath;
  const validation = validateProductBrief(source);
  if (!validation.ok) {
    printWarn(
      `${productPath} failed validation (${validation.errors.length} error(s)) — the planner runs WITHOUT product context. Fix the file or run \`fullauto evolve --force --reshape "<concept>"\`. First error: ${validation.errors[0]}`
    );
    return undefined;
  }
  return { context: extractProductContext(source), productPath, ...extra };
}

export interface PlanFlowArgs {
  projectDir: string;
  description: string;
  outputPath: string;
  timeoutSec: number;
  productContext?: PlannerProductContext;
  logPath?: string;
}

export interface PlanFlowResult {
  tasksPath: string;
  tasks: Task[];
  planStartedAt: string;
  planFinishedAt: string;
}

/**
 * Returns the planner-written tasks file (parsed + validated) on success,
 * or null if the planner failed or wrote nothing. Caller decides whether to
 * chain into a run and what exit code that failure gets.
 *
 * The ISO timestamps mark when the planner subagent started and finished.
 * Pass them into `startFreshRun` so the final report can show the plan
 * stage's wall-clock alongside per-task and total durations.
 */
export async function runPlanFlow(args: PlanFlowArgs): Promise<PlanFlowResult | null> {
  const { projectDir, description, outputPath, timeoutSec } = args;
  printInfo(
    `Planning: "${description.length > 100 ? description.slice(0, 97) + '...' : description}"`
  );
  printInfo(`Output: ${outputPath}`);
  if (args.productContext) {
    printInfo(`Product brief: ${args.productContext.productPath}${args.productContext.round !== undefined ? ` (round ${args.productContext.round})` : ''}`);
  }

  // Forward `mcpConfigPath` from the user config so the planner sees the same
  // MCP servers (Convex / Supabase / etc.) as the implementer subagents. Lets
  // the planner introspect external schemas while decomposing — without this
  // it's limited to whatever lives in source files.
  const mcpConfigPath = await resolveMcpConfigPath(projectDir);

  const planStartedAt = new Date().toISOString();
  const result = await runPlanner({
    description,
    projectDir,
    outputPath,
    timeoutSec,
    mcpConfigPath,
    productContext: args.productContext,
    logPath: args.logPath,
    // Planner output is usually short; let it through to stdout so the user
    // can see what the subagent is doing without needing --verbose.
    onOutput: (chunk) => process.stderr.write(chunk),
    onRateLimit: ({ attempt, waitMs, resetHint }) => printRateLimitBackoff(attempt, waitMs, resetHint),
  });
  const planFinishedAt = new Date().toISOString();
  // A Ctrl-C kills the planner too; report the interrupt, not "exited 143".
  throwIfInterrupted();

  if (result.timedOut) {
    printError(`Planner timed out after ${timeoutSec}s.`);
    return null;
  }
  if (result.exitCode !== 0) {
    printError(`Planner exited with code ${result.exitCode}.`);
    return null;
  }

  const check = await checkPlannerOutput(outputPath);
  if (!check.exists) {
    printError(
      `Planner exited 0 but did not create ${outputPath}. The subagent likely ignored the Write instruction — try a more specific description, or run \`fullauto plan\` and paste the output manually.`
    );
    return null;
  }

  // Validate the shape BEFORE the orchestrator inherits it. The queue's
  // dangling-dep fallback ("treat unknown deps as satisfied") and the
  // orchestrator's cycle-warn-then-proceed are too forgiving for this
  // surface — a malformed plan slips through and runs to completion with
  // wrong work. Fail fast so the user sees the issue while the original
  // request is still in their head.
  let parsedTasks: Task[];
  try {
    parsedTasks = await loadTasksFromFile(outputPath);
  } catch (err) {
    printError(
      `Planner output failed to parse: ${(err as Error).message}\n  Tasks file: ${outputPath}`
    );
    return null;
  }
  const validation = validatePlanShape(parsedTasks);
  if (!validation.ok) {
    printError(
      `Planner output failed validation (${validation.errors.length} error(s)):`
    );
    for (const e of validation.errors) console.error(`    • ${e}`);
    console.error(
      `  Tasks file: ${outputPath}\n  Edit it manually and re-run \`fullauto run\`, or re-issue the plan command with a sharper description.`
    );
    return null;
  }
  for (const w of validation.warnings) printWarn(w);

  printInfo(`Wrote tasks file: ${outputPath} (${parsedTasks.length} task(s) validated).`);
  return { tasksPath: outputPath, tasks: parsedTasks, planStartedAt, planFinishedAt };
}
