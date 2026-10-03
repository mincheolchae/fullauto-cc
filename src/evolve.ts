import { access, copyFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureFullautoDir, loadState, paths, roundDirFor } from './persistence.js';
import {
  EvolveState,
  type EvolveOutcome,
  type EvolveRound,
  loadEvolveState,
  parseAssessVerdict,
  parseProductBrief,
  parseRoundHeader,
  saveEvolveState,
  validateProductBrief,
  extractProductContext,
} from './product.js';
import { buildAssessPrompt, buildShapePrompt } from './evolve-prompts.js';
import { spawnClaudeWithBackoff } from './runner/claude.js';
import { DEFAULT_RATE_LIMIT_BACKOFF } from './runner/rate-limit.js';
import { InterruptedError, RateLimitPausedError, throwIfInterrupted } from './runner/process-group.js';
import { runOrchestrator } from './orchestrator.js';
import {
  applyVerifyOverride,
  ensureRunStateIgnored,
  reconcileConfigOnResume,
  resetInterrupted,
  resolveEvolveStageTimeoutSec,
  resolveMcpConfigPath,
  resolvePlannerTimeoutSec,
  runPlanFlow,
  startFreshRun,
} from './run-flow.js';
import type { RunState, VerifyMode } from './types.js';
import {
  printError,
  printEvolveReport,
  printEvolveRoundEnd,
  printEvolveRoundStart,
  printInfo,
  printRateLimitBackoff,
  printWarn,
} from './reporter.js';

/**
 * `fullauto evolve` — concept → product over bounded, unattended rounds.
 *
 *   shape (once)  → product.md via /product-shape, validated (one retry)
 *   round r:
 *     plan        → planner with the product context → rounds/<r>/tasks.md
 *     run         → the normal fresh-run path (gates + audit + verify)
 *     assess      → /product-assess rewrites product.md, emits FULLAUTO_ASSESS
 *   guards        → ship / stop / round cap / time budget / no progress / stall
 *
 * Every stage boundary is persisted in evolve-state.json so a crash resumes
 * at the recorded stage; the run stage itself resumes through state.json
 * exactly like `fullauto run`.
 */

export const EVOLVE_DEFAULTS = {
  maxRounds: 3,
  maxTasksPerRound: 12,
} as const;

/** Backlog lines shown in the final report. */
const REPORT_BACKLOG_TOP = 10;
/** Cap on the per-task lines in the assess round summary. */
const SUMMARY_TASK_LINES = 60;
const SUMMARY_DETAIL_CHARS = 200;

export interface EvolveOptions {
  projectDir: string;
  /** The product concept. Omit to resume from evolve-state.json. */
  concept?: string;
  /** Explicit CLI values; undefined = not given (defaults on a fresh start, kept as-is on resume). */
  rounds?: number;
  maxTasksPerRound?: number;
  timeBudgetSec?: number;
  vibeEnhance: boolean;
  ux: boolean;
  verifyMode?: VerifyMode;
  force: boolean;
  reshape: boolean;
  verbose: boolean;
}

export interface EvolveResult {
  state: EvolveState;
  exitCode: number;
}

/** Outcome → process exit code. Bounded-and-finished is success; needs-a-human is 1. */
function exitCodeFor(outcome: EvolveOutcome | undefined): number {
  switch (outcome) {
    case 'ship':
    case 'max_rounds':
    case 'time_budget':
      return 0;
    default:
      return 1;
  }
}

/** Thrown by a stage to abort the loop with a recorded reason (never for control flow inside a stage). */
class EvolveAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvolveAbort';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runEvolve(opts: EvolveOptions): Promise<EvolveResult> {
  const { projectDir } = opts;
  const p = await ensureFullautoDir(projectDir);
  const invocationStartedAt = Date.now();

  const state = await prepareState(opts);
  if (state === null) {
    // prepareState already printed why (no concept and nothing to resume, or
    // an already-finished evolve with nothing left to extend).
    const existing = await loadEvolveState(projectDir);
    return { state: existing ?? emptyState(opts), exitCode: existing ? exitCodeFor(existing.outcome) : 2 };
  }

  // Per-invocation budget: "give it 6 hours tonight" must mean 6 hours from
  // now, also when the loop is resumed tomorrow.
  const budgetSec = state.timeBudgetSec;
  const budgetExceeded = (): boolean =>
    budgetSec !== undefined && Date.now() - invocationStartedAt >= budgetSec * 1000;

  const plannerTimeoutSec = await resolvePlannerTimeoutSec(projectDir, undefined);
  // shape / assess do materially more work per call than the plain planner
  // (WebSearch benchmarking, reading state.json + tasks.md + the changed
  // code, a five-dimension score, rewriting product.md) — see
  // `evolveStageTimeoutSec`'s doc comment in types.ts.
  const evolveStageTimeoutSec = await resolveEvolveStageTimeoutSec(projectDir, plannerTimeoutSec);
  const mcpConfigPath = await resolveMcpConfigPath(projectDir);
  const stageCtx: StageContext = { projectDir, opts, plannerTimeoutSec, evolveStageTimeoutSec, mcpConfigPath };

  let outcome: EvolveOutcome | undefined;
  let outcomeDetail: string | undefined;
  const finish = (o: EvolveOutcome, detail?: string): void => {
    outcome = o;
    outcomeDetail = detail;
  };

  try {
    // Pick up where the previous invocation stopped: an unfinished round
    // continues at its recorded stage; a finished one is re-judged by the
    // guards (a crash between "round done" and "next round created" must not
    // skip them) before the next round is opened.
    let rec = state.rounds[state.rounds.length - 1];
    if (rec && rec.stage === 'done') {
      const stop = evaluateGuards(state, rec);
      if (stop) finish(stop.outcome, stop.detail);
      else rec = await openRound(state, projectDir);
    } else if (!rec) {
      rec = await openRound(state, projectDir);
    }

    while (outcome === undefined) {
      if (budgetExceeded()) {
        finish('time_budget', `time budget of ${budgetSec}s exceeded before the ${rec.stage} stage of round ${rec.round}`);
        break;
      }
      printEvolveRoundStart(rec.round, state.maxRounds, rec.stage);

      if (rec.stage === 'shape') {
        await shapeStage(stageCtx, state);
        rec.stage = 'plan';
        await saveEvolveState(projectDir, state);
        continue;
      }
      if (rec.stage === 'plan') {
        await planStage(stageCtx, state, rec);
        rec.stage = 'run';
        await saveEvolveState(projectDir, state);
        continue;
      }
      if (rec.stage === 'run') {
        await runStage(stageCtx, state, rec);
        rec.stage = 'assess';
        await saveEvolveState(projectDir, state);
        continue;
      }
      if (rec.stage === 'assess') {
        await assessStage(stageCtx, state, rec);
        rec.stage = 'done';
        rec.finishedAt = new Date().toISOString();
        await saveEvolveState(projectDir, state);
        printEvolveRoundEnd(rec);
        const stop = evaluateGuards(state, rec);
        if (stop) {
          finish(stop.outcome, stop.detail);
          break;
        }
        rec = await openRound(state, projectDir);
        continue;
      }
      // 'done' cannot reach here (handled above); defensive.
      rec = await openRound(state, projectDir);
    }
  } catch (err) {
    if (err instanceof InterruptedError) {
      // Ctrl-C / SIGTERM: the stage that was running is still recorded as
      // in progress (the run stage resumes through state.json like
      // `fullauto run` does), so a plain `fullauto evolve` picks it up. Not
      // an outcome — nothing about the product was decided.
      await saveEvolveState(projectDir, state);
      printWarn(
        err instanceof RateLimitPausedError
          ? `Evolve paused during round ${state.round} (API still rate-limited) — resume with \`fullauto evolve\` once the usage window resets.`
          : `Evolve interrupted by ${err.signal} during round ${state.round} — resume with \`fullauto evolve\`.`
      );
      throw err;
    }
    if (err instanceof EvolveAbort) {
      printError(err.message);
      finish('aborted', err.message);
    } else {
      // Anything else (a thrown orchestrator error, I/O failure) is recorded
      // so the report and a later resume know what happened, then re-thrown
      // for the CLI's top-level handler.
      finish('aborted', (err as Error).message);
      state.outcome = 'aborted';
      state.outcomeDetail = (err as Error).message;
      await saveEvolveState(projectDir, state);
      throw err;
    }
  }

  state.outcome = outcome;
  state.outcomeDetail = outcomeDetail;
  state.finishedAt = new Date().toISOString();
  await saveEvolveState(projectDir, state);
  printEvolveReport(state, {
    productPath: p.productPath,
    roundsDir: p.roundsDir,
    backlogRemaining: await backlogRemaining(projectDir),
  });
  return { state, exitCode: exitCodeFor(outcome) };
}

// ---------- state preparation ----------

function emptyState(opts: EvolveOptions): EvolveState {
  return EvolveState.parse({
    concept: opts.concept ?? '',
    startedAt: new Date().toISOString(),
    maxRounds: opts.rounds ?? EVOLVE_DEFAULTS.maxRounds,
    maxTasksPerRound: opts.maxTasksPerRound ?? EVOLVE_DEFAULTS.maxTasksPerRound,
  });
}

/**
 * Fresh start vs. resume, `--force` / `--reshape` handling, CLI overrides on
 * resume. Returns null when there is nothing to do (message printed).
 */
async function prepareState(opts: EvolveOptions): Promise<EvolveState | null> {
  const { projectDir } = opts;
  const p = paths(projectDir);
  let reshape = opts.reshape;
  let force = opts.force;
  if (reshape && !force) {
    printWarn('--reshape implies --force (the current evolve state is discarded along with product.md).');
    force = true;
  }

  const existing = await loadEvolveState(projectDir);

  if (existing && !force) {
    if (opts.concept) {
      printWarn(`Existing evolve state found — resuming it; the concept argument is ignored. Use --force to start over.`);
    } else {
      printInfo(`Resuming evolve from ${p.evolveStatePath} (round ${existing.round}, stage ${existing.rounds[existing.rounds.length - 1]?.stage ?? 'plan'}).`);
    }
    // Bounds may be extended on resume; a smaller --rounds than what already
    // ran is honored by the round-cap guard (it stops before the next round).
    if (opts.rounds !== undefined && opts.rounds !== existing.maxRounds) {
      printInfo(`--rounds ${opts.rounds}: was ${existing.maxRounds}.`);
      existing.maxRounds = opts.rounds;
    }
    if (opts.maxTasksPerRound !== undefined) existing.maxTasksPerRound = opts.maxTasksPerRound;
    if (opts.timeBudgetSec !== undefined) existing.timeBudgetSec = opts.timeBudgetSec;
    if (opts.vibeEnhance && !existing.options.vibeEnhance) {
      printInfo('--vibe-enhance: enabled for the remaining rounds.');
      existing.options.vibeEnhance = true;
    }
    if (opts.ux && !existing.options.ux) {
      printInfo('--ux: enabled for the remaining rounds.');
      existing.options.ux = true;
    }
    if (opts.verifyMode) existing.options.verifyMode = opts.verifyMode;

    if (existing.outcome) {
      // A finished evolve resumes only when something can actually change:
      // the last round never completed (`aborted` / `time_budget` mid-stage),
      // or a bound was the stopper and there is now room for another round.
      // A verdict-based stop (ship / stop) or a guard on the work itself
      // (no_progress / stalled) would fire again unchanged — say so instead
      // of spawning nothing.
      const last = existing.rounds[existing.rounds.length - 1];
      const unfinished = last !== undefined && last.stage !== 'done';
      const verdictStop = ['ship', 'stop', 'no_progress', 'stalled'].includes(existing.outcome);
      const noRoom = existing.round >= existing.maxRounds;
      if (!unfinished && (verdictStop || noRoom)) {
        printInfo(
          verdictStop
            ? `This evolve already finished (${existing.outcome}) after ${existing.round} round(s) — that verdict stands. Use --force to start over (product.md is kept).`
            : `This evolve already finished (${existing.outcome}) after ${existing.round} round(s). Pass --rounds <n> greater than ${existing.round} to continue, or --force to start over.`
        );
        printEvolveReport(existing, { productPath: p.productPath, roundsDir: p.roundsDir, backlogRemaining: await backlogRemaining(projectDir) });
        return null;
      }
      printInfo(`Continuing a finished evolve (${existing.outcome}).`);
      existing.outcome = undefined;
      existing.outcomeDetail = undefined;
      existing.finishedAt = undefined;
    }
    await saveEvolveState(projectDir, existing);
    return existing;
  }

  if (!opts.concept) {
    printError(
      existing
        ? `--force needs a concept: fullauto evolve --force "<concept>".`
        : `Nothing to resume (no ${p.evolveStatePath}). Pass a concept: fullauto evolve "<concept>".`
    );
    return null;
  }

  if (existing) {
    printWarn(`--force: discarding ${p.evolveStatePath} and the round archives under ${p.roundsDir}.`);
    await rm(p.evolveStatePath, { force: true });
    await rm(p.roundsDir, { recursive: true, force: true });
  }
  if (reshape && (await exists(p.productPath))) {
    const backup = join(p.fullautoDir, 'product.prev.md');
    await copyFile(p.productPath, backup);
    await rm(p.productPath, { force: true });
    printWarn(`--reshape: previous product.md backed up to ${backup}; the shaping stage will write a new one.`);
  }

  // A state.json left by an earlier `fullauto run` / `auto` is not part of
  // this evolve. Archive it (never delete: it may hold an unfinished run the
  // user wants back) so the round-1 run starts clean.
  if (await exists(p.statePath)) {
    const archive = join(p.roundsDir, `pre-evolve-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    await archiveRunArtifacts(projectDir, archive);
    printWarn(`Found a previous run's state.json — archived it to ${archive} so the evolve rounds start clean.`);
  }

  const state = EvolveState.parse({
    concept: opts.concept,
    startedAt: new Date().toISOString(),
    maxRounds: opts.rounds ?? EVOLVE_DEFAULTS.maxRounds,
    maxTasksPerRound: opts.maxTasksPerRound ?? EVOLVE_DEFAULTS.maxTasksPerRound,
    timeBudgetSec: opts.timeBudgetSec,
    options: { vibeEnhance: opts.vibeEnhance, ux: opts.ux, verifyMode: opts.verifyMode },
  });
  await saveEvolveState(projectDir, state);
  printInfo(`Evolve: "${opts.concept}" — up to ${state.maxRounds} round(s), ≤ ${state.maxTasksPerRound} tasks each.`);
  return state;
}

/**
 * Open round r = state.round + 1. Round 1 starts at `shape` when there is
 * no brief yet; every other round starts at `plan`.
 */
async function openRound(state: EvolveState, projectDir: string): Promise<EvolveRound> {
  const round = state.round + 1;
  const p = paths(projectDir);
  const needShape = round === 1 && !(await exists(p.productPath));
  if (round === 1 && !needShape) {
    // An existing brief (hand-written, or kept across --force) must be
    // usable before a single planner call is spent on it.
    const validation = validateProductBrief(await readFile(p.productPath, 'utf-8'));
    if (!validation.ok) {
      throw new EvolveAbort(
        `${p.productPath} exists but failed validation:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\nFix it, or run \`fullauto evolve --force --reshape "<concept>"\` to have it rewritten.`
      );
    }
    for (const w of validation.warnings) printWarn(`product.md: ${w}`);
    printInfo(`Using existing product brief: ${p.productPath}`);
  }
  const rec: EvolveRound = {
    round,
    stage: needShape ? 'shape' : 'plan',
    tasksPath: join(roundDirFor(projectDir, round), 'tasks.md'),
    startedAt: new Date().toISOString(),
    tasksDone: 0,
    tasksFailed: 0,
    backlogItems: [],
    failureNotes: [],
    nextItems: [],
    featuresDone: [],
  };
  state.round = round;
  state.rounds.push(rec);
  await saveEvolveState(projectDir, state);
  return rec;
}

// ---------- stages ----------

interface StageContext {
  projectDir: string;
  opts: EvolveOptions;
  /** Used by the plan stage — it stays close in shape to the ordinary task planner. */
  plannerTimeoutSec: number;
  /** Used by the shape and assess stages — see `evolveStageTimeoutSec` in types.ts. */
  evolveStageTimeoutSec: number;
  mcpConfigPath: string | undefined;
}

function stageLogPath(projectDir: string, name: string): string {
  return join(paths(projectDir).logsDir, `evolve-${name}.log`);
}

/**
 * Stage 0: write product.md. The subagent gets ONE retry with the
 * validation errors appended; a second bad brief aborts the loop — planning
 * rounds against a malformed brief would waste every later stage.
 */
async function shapeStage(ctx: StageContext, state: EvolveState): Promise<void> {
  const { projectDir } = ctx;
  const p = paths(projectDir);
  let priorErrors: string[] | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    printInfo(`Shaping the product brief${attempt > 1 ? ' (retry with validation errors)' : ''}: ${p.productPath}`);
    const prompt = buildShapePrompt(state.concept, p.productPath, { priorErrors, projectDir });
    const res = await spawnClaudeWithBackoff(
      {
        prompt,
        projectDir,
        timeoutSec: ctx.evolveStageTimeoutSec,
        mcpConfigPath: ctx.mcpConfigPath,
        logPath: stageLogPath(projectDir, `shape-attempt${attempt}`),
        logHeader: [`# Evolve shape stage (attempt ${attempt})`],
        onOutput: (chunk) => process.stderr.write(chunk),
      },
      DEFAULT_RATE_LIMIT_BACKOFF,
      ({ attempt: n, waitMs, resetHint }) => printRateLimitBackoff(n, waitMs, resetHint)
    );
    throwIfInterrupted();
    const errors: string[] = [];
    if (res.timedOut) errors.push(`The previous shaping subagent timed out after ${ctx.evolveStageTimeoutSec}s — write the file first, explore less.`);
    else if (res.exitCode !== 0) errors.push(`The previous shaping subagent exited with code ${res.exitCode} before the file was accepted.`);
    if (!(await exists(p.productPath))) {
      errors.push(`No file was written at ${p.productPath} — use the Write tool with that exact absolute path.`);
    } else {
      const validation = validateProductBrief(await readFile(p.productPath, 'utf-8'));
      errors.push(...validation.errors);
      if (validation.ok) {
        for (const w of validation.warnings) printWarn(`product.md: ${w}`);
        printInfo(`Product brief accepted (${validation.brief.featureMap.length} feature(s), ${validation.brief.backlog.length} backlog item(s)).`);
        return;
      }
    }
    printWarn(`product.md rejected (${errors.length} error(s)):\n${errors.map((e) => `    - ${e}`).join('\n')}`);
    priorErrors = errors;
  }
  throw new EvolveAbort(
    `Product brief at ${p.productPath} is still invalid after one retry — aborting. Fix the file by hand and resume with \`fullauto evolve\`, or start over with --force --reshape.`
  );
}

/**
 * Stage 1: plan the round against the product context. One retry on a
 * planner failure — evolve runs are long and unattended, and a transient
 * planner failure must not end the night.
 */
async function planStage(ctx: StageContext, state: EvolveState, rec: EvolveRound): Promise<void> {
  const { projectDir } = ctx;
  const p = paths(projectDir);
  const source = await readFile(p.productPath, 'utf-8');
  const productContext = {
    context: extractProductContext(source),
    productPath: p.productPath,
    round: rec.round,
    maxTasks: state.maxTasksPerRound,
  };
  await mkdir(roundDirFor(projectDir, rec.round), { recursive: true });
  const description = roundDescription(state, rec.round);

  let result = null;
  for (let attempt = 1; attempt <= 2 && !result; attempt++) {
    if (attempt > 1) printWarn(`Planner failed for round ${rec.round} — retrying once.`);
    result = await runPlanFlow({
      projectDir,
      description,
      outputPath: rec.tasksPath,
      timeoutSec: ctx.plannerTimeoutSec,
      productContext,
      logPath: join(roundDirFor(projectDir, rec.round), `plan-attempt${attempt}.log`),
    });
  }
  if (!result) {
    throw new EvolveAbort(`Planner failed twice for round ${rec.round} — aborting. Resume with \`fullauto evolve\` to retry the plan stage.`);
  }

  const header = parseRoundHeader(await readFile(rec.tasksPath, 'utf-8'));
  if (!header) {
    printWarn(`${rec.tasksPath} has no \`<!-- fullauto:round=${rec.round} items=… -->\` header — the round's backlog ids are unknown to the report.`);
    rec.backlogItems = [];
  } else {
    if (header.round !== rec.round) printWarn(`Round header says round ${header.round}, expected ${rec.round} — using the file anyway.`);
    rec.backlogItems = header.items;
  }
  const userTasks = result.tasks.length;
  if (userTasks > state.maxTasksPerRound) {
    printWarn(`Round ${rec.round} plan has ${userTasks} tasks, above --max-tasks-per-round ${state.maxTasksPerRound}; running it as planned.`);
  }
  printInfo(`Round ${rec.round} plan: ${userTasks} task(s)${rec.backlogItems.length ? ` covering ${rec.backlogItems.join(', ')}` : ''}.`);
}

/** `T003 "title" — first line of why its last attempt failed`, capped; what the next round's planner needs to avoid repeating it. */
export function failureNote(t: RunState['tasks'][number]): string {
  const real = [...t.attempts].reverse().find((a) => a.deferDetail && !a.deferDetail.startsWith('Promoted to failed'));
  const why = (real?.deferDetail ?? 'never reached a terminal state').split('\n').find((l) => l.trim()) ?? '';
  return `${t.id} "${t.title.slice(0, 80)}" — ${real?.deferReason ?? 'unknown'}: ${why.trim().slice(0, 160)}`;
}

/** The planner's "User request" for a round: the concept plus what this round is. */
function roundDescription(state: EvolveState, round: number): string {
  const prev = state.rounds.filter((r) => r.round < round && r.stage === 'done');
  const last = prev[prev.length - 1];
  const lastLine = last
    ? ` Round ${last.round} finished with ${last.tasksDone} done / ${last.tasksFailed} failed${last.score !== undefined ? `, assessment score ${last.score}` : ''}${last.nextItems.length ? `; the assessor asked for ${last.nextItems.join(', ')} next` : ''}.`
    : '';
  const failed = last?.failureNotes?.length
    ? ` These tasks FAILED last round — do not re-plan them the same way; split them smaller, change the approach, or plan around the blocker: ${last.failureNotes.join(' | ')}.`
    : '';
  return (
    `Evolve the product described by this concept: "${state.concept}". ` +
    `This is round ${round} of at most ${state.maxRounds}: select the next backlog items from the product brief (see "Product context") and decompose them into tasks that leave each selected item fully usable.${lastLine}${failed}`
  );
}

/**
 * Stage 2: execute the round through the normal fresh-run path. On resume
 * with a run already started, `state.json` is resumed exactly like
 * `fullauto run` does. The previous round's `state.json` + logs are
 * archived into its round directory first so the two never mix.
 */
async function runStage(ctx: StageContext, state: EvolveState, rec: EvolveRound): Promise<void> {
  const { projectDir, opts } = ctx;
  const p = paths(projectDir);
  let runState: RunState | null;

  const existingRun = rec.runStartedAt !== undefined ? await loadState(projectDir) : null;
  if (existingRun) {
    printInfo(`Round ${rec.round}: resuming the interrupted run from ${p.statePath}.`);
    await reconcileConfigOnResume(projectDir, existingRun);
    applyVerifyOverride(existingRun.config, state.options.verifyMode);
    await ensureRunStateIgnored(projectDir);
    await resetInterrupted(projectDir, existingRun);
    runState = await runOrchestrator({ projectDir, state: existingRun, verbose: opts.verbose });
  } else {
    if (rec.round > 1) await archivePreviousRound(projectDir, rec.round - 1);
    else if (await exists(p.statePath)) {
      // Round 1 with a stray state.json (a crash before `runStartedAt` was
      // persisted): it belongs to nobody we can name, so park it.
      await archiveRunArtifacts(projectDir, join(p.roundsDir, `pre-evolve-${Date.now()}`));
    }
    rec.runStartedAt = new Date().toISOString();
    await saveEvolveState(projectDir, state);
    runState = await startFreshRun({
      projectDir,
      tasksPath: rec.tasksPath,
      verbose: opts.verbose,
      autoMode: true,
      vibeEnhance: state.options.vibeEnhance,
      verifyMode: state.options.verifyMode,
      enhanceBudgetRemaining: state.enhanceBudgetRemaining,
      commandStartedAt: rec.startedAt,
    });
    if (!runState) {
      throw new EvolveAbort(`Round ${rec.round}: the run could not start (see the error above) — aborting.`);
    }
  }

  const user = runState.tasks.filter((t) => t.kind === 'user');
  rec.tasksDone = user.filter((t) => t.status === 'done').length;
  rec.tasksFailed = user.filter((t) => t.status === 'failed').length;
  rec.failureNotes = user.filter((t) => t.status === 'failed').map(failureNote);
  // The enhance budget is run-wide ("bounds scope creep on long unattended
  // runs"): carry what is left into the next round's fresh run.
  if (runState.enhanceBudgetRemaining !== undefined) state.enhanceBudgetRemaining = runState.enhanceBudgetRemaining;
  for (const name of runState.placeholderEnvs ?? []) {
    if (!state.placeholderEnvs.includes(name)) state.placeholderEnvs.push(name);
  }
}

/**
 * Stage 3: judge the round. The brief is backed up first; if the assessor
 * breaks it (or times out mid-write) the backup is restored so the next
 * round plans from the last good version. One retry on a subagent failure;
 * a missing verdict is `continue` with a warning, never a stop.
 */
async function assessStage(ctx: StageContext, state: EvolveState, rec: EvolveRound): Promise<void> {
  const { projectDir } = ctx;
  const p = paths(projectDir);
  const roundDir = roundDirFor(projectDir, rec.round);
  await mkdir(roundDir, { recursive: true });
  const backup = join(roundDir, 'product.pre-assess.md');
  await copyFile(p.productPath, backup);

  const runState = await loadState(projectDir).catch(() => null);
  const roundSummary = runState ? buildRoundSummary(rec, runState) : `(state.json for round ${rec.round} could not be read — assess from the code and ${rec.tasksPath})`;
  const prompt = buildAssessPrompt(p.productPath, roundSummary, p.statePath, state.options.ux, {
    tasksPath: rec.tasksPath,
    round: rec.round,
  });

  let stdout = '';
  let processFailed = false;
  // A retry of a TIMED-OUT assessor with the same prompt and the same limit is
  // a guaranteed second timeout (a whole `claude -p` run for nothing), so the
  // retry after a timeout gets double the room; a plain crash retries as-is.
  let timeoutSec = ctx.evolveStageTimeoutSec;
  for (let attempt = 1; attempt <= 2; attempt++) {
    printInfo(`Assessing round ${rec.round}${attempt > 1 ? ' (retry)' : ''}.`);
    const res = await spawnClaudeWithBackoff(
      {
        prompt,
        projectDir,
        timeoutSec,
        mcpConfigPath: ctx.mcpConfigPath,
        logPath: join(roundDir, `assess-attempt${attempt}.log`),
        logHeader: [`# Evolve assess stage — round ${rec.round} (attempt ${attempt})`],
        onOutput: (chunk) => process.stderr.write(chunk),
      },
      DEFAULT_RATE_LIMIT_BACKOFF,
      ({ attempt: n, waitMs, resetHint }) => printRateLimitBackoff(n, waitMs, resetHint)
    );
    throwIfInterrupted();
    stdout = res.stdout;
    processFailed = res.timedOut || res.exitCode !== 0;
    if (!processFailed) break;
    printWarn(`Assessor ${res.timedOut ? `timed out after ${timeoutSec}s` : `exited with code ${res.exitCode}`}.`);
    if (res.timedOut) timeoutSec *= 2;
    await restoreIfBroken(p.productPath, backup);
  }

  // Unlike a successful run that just forgot the exact FULLAUTO_ASSESS line
  // (a reasonable LLM-formatting slip — parseAssessVerdict's lenient
  // continue-with-warning fallback below covers that), a PROCESS failure on
  // both attempts (timeout / nonzero exit) means the assessor never actually
  // read the round, scored anything, or updated product.md at all — real
  // subagent behavior observed live during smoke-testing (150s timeouts,
  // zero stdout both times). Silently falling through to a fabricated
  // "continue" here is worse than aborting: the loop looks healthy while
  // burning rounds with zero real judgment and no distinguishing signal in
  // state.outcome. Mirror shapeStage/planStage and abort instead.
  if (processFailed) {
    throw new EvolveAbort(
      `Assessor failed twice for round ${rec.round} (timeout or nonzero exit, no output) — aborting rather than continuing with a fabricated verdict. Raise evolveStageTimeoutSec in .fullauto/config.json (currently ${ctx.evolveStageTimeoutSec}s; product-assess reads the round state, the code, and rewrites product.md — it needs more room than a plain planner call) and resume with \`fullauto evolve\`.`
    );
  }

  const verdict = parseAssessVerdict(stdout);
  for (const w of verdict.warnings) printWarn(w);
  rec.verdict = verdict.verdict;
  rec.score = verdict.score;
  rec.nextItems = verdict.next;
  rec.reason = verdict.reason;

  // A broken rewrite must not poison the next round.
  const restored = await restoreIfBroken(p.productPath, backup);
  const brief = parseProductBrief(await readFile(p.productPath, 'utf-8'));
  rec.featuresDone = brief.featureMap.filter((f) => f.status === 'done').map((f) => f.id);
  if (!restored) {
    printInfo(`product.md updated: ${rec.featuresDone.length} feature(s) done, ${brief.backlog.length} backlog item(s) open.`);
  }
}

/** Restore product.md from `backup` when it is missing or invalid; returns true when restored. */
async function restoreIfBroken(productPath: string, backup: string): Promise<boolean> {
  let broken: string;
  if (!(await exists(productPath))) {
    broken = 'the file is missing';
  } else {
    const validation = validateProductBrief(await readFile(productPath, 'utf-8'));
    if (validation.ok) return false;
    broken = `${validation.errors.length} validation error(s): ${validation.errors[0]}`;
  }
  await copyFile(backup, productPath);
  printWarn(`product.md after assess is unusable (${broken}) — restored the pre-assess copy from ${backup}. The assessor's updates for this round were dropped.`);
  return true;
}

// ---------- guards ----------

/**
 * Loop guards, checked after every assessed round. Order matters: a `ship`
 * on the last allowed round is still a ship, and "no progress" is more
 * useful than "round cap" when both hold.
 */
export function evaluateGuards(state: EvolveState, rec: EvolveRound): { outcome: EvolveOutcome; detail: string } | null {
  if (rec.verdict === 'ship') return { outcome: 'ship', detail: rec.reason ?? `round ${rec.round} assessed as shippable` };
  if (rec.verdict === 'stop') return { outcome: 'stop', detail: rec.reason ?? `round ${rec.round} assessor asked to stop` };
  if (rec.tasksDone === 0) {
    return { outcome: 'no_progress', detail: `round ${rec.round} finished 0 tasks (${rec.tasksFailed} failed) — check the round's final report and logs under ${rec.tasksPath.replace(/tasks\.md$/, '')}` };
  }
  const prev = state.rounds.find((r) => r.round === rec.round - 1 && r.stage === 'done');
  if (prev && sameSet(prev.nextItems, rec.nextItems) && rec.nextItems.length > 0) {
    const newlyDone = rec.featuresDone.filter((id) => !prev.featuresDone.includes(id));
    if (newlyDone.length === 0) {
      return { outcome: 'stalled', detail: `rounds ${prev.round} and ${rec.round} both picked ${rec.nextItems.join(', ')} as next and no feature reached done in between` };
    }
  }
  if (rec.round >= state.maxRounds) return { outcome: 'max_rounds', detail: `${state.maxRounds} round(s) completed` };
  return null;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

// ---------- helpers ----------

/**
 * What the assessor gets from the orchestrator: per-task outcome with the
 * defer reason (first line, capped), plus the run-level signals that only
 * state.json knows (audit WARNs, red tests never green, placeholders).
 */
export function buildRoundSummary(rec: EvolveRound, run: RunState): string {
  const lines: string[] = [];
  const user = run.tasks.filter((t) => t.kind === 'user');
  const counts = { done: 0, failed: 0, deferred: 0, pending: 0, in_progress: 0 };
  for (const t of user) counts[t.status] += 1;
  lines.push(
    `Round ${rec.round}: ${user.length} planned task(s) — ${counts.done} done, ${counts.failed} failed, ${counts.deferred + counts.pending} unfinished; passes used: ${run.currentPass}.`
  );
  if (rec.backlogItems.length) lines.push(`Backlog items this round covered: ${rec.backlogItems.join(', ')}.`);
  const synthetic = run.tasks.filter((t) => t.kind !== 'user');
  if (synthetic.length) {
    lines.push(`Synthetic passes: ${synthetic.map((t) => `${t.id} [${t.status}]`).join(', ')}.`);
  }
  const promoted = run.tasks.flatMap((t) => t.attempts.flatMap((a) => a.enhance?.promote ?? []));
  if (promoted.length) lines.push(`Backlog ids the enhance passes asked to PROMOTE: ${[...new Set(promoted)].join(', ')}.`);
  lines.push('');
  lines.push('Per task:');
  for (const t of run.tasks.slice(0, SUMMARY_TASK_LINES)) {
    const last = t.attempts[t.attempts.length - 1];
    const feature = t.feature ? ` {${t.feature}}` : '';
    let line = `- ${t.id} [${t.status}]${feature} ${t.title}`;
    if (t.status !== 'done' && last?.deferReason) {
      // The synthetic end-of-run attempt only re-labels the last real signal.
      const detail = (last.deferDetail ?? '').replace(/^Promoted to failed after orchestrator exit:\s*/, '').split('\n')[0].trim();
      line += ` — ${last.deferReason}${detail ? `: ${detail.length > SUMMARY_DETAIL_CHARS ? `${detail.slice(0, SUMMARY_DETAIL_CHARS)}…` : detail}` : ''}`;
    }
    const warns = last?.audit?.findings.filter((f) => f.severity === 'warn').length ?? 0;
    if (t.status === 'done' && warns) line += ` (audit: ${warns} WARN)`;
    lines.push(line);
  }
  if (run.tasks.length > SUMMARY_TASK_LINES) lines.push(`…and ${run.tasks.length - SUMMARY_TASK_LINES} more (see state.json)`);
  if ((run.redTests ?? []).length) {
    lines.push('');
    lines.push(`TDD red sets never turned green: ${run.redTests.map((r) => r.taskId).join(', ')} — the test suite is NOT fully green.`);
  }
  if ((run.pendingWiring ?? []).length) {
    lines.push(`Wiring promises never fulfilled: ${run.pendingWiring.map((w) => w.artifactPath).join(', ')}.`);
  }
  if ((run.placeholderEnvs ?? []).length) {
    lines.push(`Placeholder env vars used (no real credentials): ${run.placeholderEnvs.join(', ')}.`);
  }
  return lines.join('\n');
}

/** Move state.json + logs/ into `dest` (idempotent: only what exists moves). */
async function archiveRunArtifacts(projectDir: string, dest: string): Promise<void> {
  const p = paths(projectDir);
  await mkdir(dest, { recursive: true });
  if (await exists(p.statePath)) {
    await rename(p.statePath, join(dest, 'state.json'));
  }
  if (await exists(p.logsDir)) {
    const destLogs = join(dest, 'logs');
    await mkdir(destLogs, { recursive: true });
    for (const name of await readdir(p.logsDir)) {
      await rename(join(p.logsDir, name), join(destLogs, name));
    }
  }
  await mkdir(p.logsDir, { recursive: true });
}

/**
 * The previous round's run is done with; park its state.json + logs in
 * its round directory (with `tasks.md` and the assess transcript) so the
 * next fresh run starts from a clean `.fullauto/`.
 */
async function archivePreviousRound(projectDir: string, round: number): Promise<void> {
  const dest = roundDirFor(projectDir, round);
  await archiveRunArtifacts(projectDir, dest);
  printInfo(`Archived round ${round} state + logs to ${dest}.`);
}

/** Backlog lines still open in product.md (features not done/rejected), for the final report. */
async function backlogRemaining(projectDir: string): Promise<string[]> {
  const p = paths(projectDir);
  if (!(await exists(p.productPath))) return [];
  const brief = parseProductBrief(await readFile(p.productPath, 'utf-8'));
  const closed = new Set(brief.featureMap.filter((f) => f.status === 'done' || f.status === 'rejected').map((f) => f.id));
  return brief.backlog
    .filter((b) => !closed.has(b.id))
    .slice(0, REPORT_BACKLOG_TOP)
    .map((b) => b.raw.replace(/^[-*+]\s+/, ''));
}
