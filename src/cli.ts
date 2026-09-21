#!/usr/bin/env node
import { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { loadPrerequisitesFromFile } from './parsers/speckit.js';
import {
  DEFAULT_PRESET,
  PRESETS,
  PRESET_IDS,
  detectPresetFromPackageJson,
  type BackendPreset,
} from './init/presets.js';
import { expandMcpEnvPlaceholders } from './init/mcp-config.js';
import {
  ensureFullautoDir,
  loadState,
  saveConfigSnapshot,
  saveState,
  paths,
} from './persistence.js';
import { VERIFY_MODES, type VerifyMode } from './types.js';
import { runOrchestrator } from './orchestrator.js';
import { InterruptedError, installSignalHandlers } from './runner/process-group.js';
import { renderFindings } from './audit/index.js';
import { runManualAudit } from './audit/manual.js';
import {
  applyVerifyOverride,
  ensureGitignoreEntry,
  ensureRunStateIgnored,
  exitCodeForRun,
  loadPlannerProductContext,
  reconcileConfigOnResume,
  requeueFailedTasks,
  resetInterrupted,
  resolvePlannerTimeoutSec,
  retryPassLimit,
  runPlanFlow,
  startFreshRun,
} from './run-flow.js';
import { runEvolve, EVOLVE_DEFAULTS } from './evolve.js';
import {
  formatKst,
  printError,
  printFinalReport,
  printInfo,
  printPrerequisites,
  printResume,
  printWarn,
} from './reporter.js';

const program = new Command();
program
  .name('fullauto')
  .description(
    'Full-auto orchestrator for Claude Code: sequential single-task execution with verification gates and self-correcting review loop.'
  )
  .version('0.1.0');

program
  .command('init')
  .description(
    `Initialize .fullauto/ with a backend preset. Default: ${DEFAULT_PRESET}. Available presets: ${PRESET_IDS.join(', ')}.`
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option(
    '--backend <preset>',
    `Backend preset: ${PRESET_IDS.join(' | ')} (default: ${DEFAULT_PRESET}).`,
    DEFAULT_PRESET
  )
  .option(
    '--convex',
    'Alias for `--backend convex` (back-compat with earlier versions).',
    false
  )
  .action(
    async function (
      this: Command,
      opts: {
        dir: string;
        backend: string;
        convex: boolean;
      }
    ) {
      const projectDir = resolve(opts.dir);
      await ensureFullautoDir(projectDir);

      // `--convex` alias overrides --backend explicitly. Warn if the user
      // passed both (one says no backend, the other forces convex).
      if (opts.convex && this.getOptionValueSource('backend') === 'cli') {
        printWarn(
          `Both --convex and --backend ${opts.backend} given; --convex wins. Drop one to silence this.`
        );
      }
      const requestedId = opts.convex ? 'convex' : opts.backend;
      const preset: BackendPreset | undefined = PRESETS[requestedId];
      if (!preset) {
        printError(
          `Unknown backend preset "${requestedId}". Choose one of: ${PRESET_IDS.join(', ')}.`
        );
        process.exitCode = 2;
        return;
      }

      const p = paths(projectDir);

      // Auto-detect hint: only when the user accepted the default preset
      // implicitly (no --backend, no --convex). An explicit choice means
      // they already know what they want — don't second-guess.
      const backendIsExplicit =
        this.getOptionValueSource('backend') === 'cli' || opts.convex;
      if (!backendIsExplicit) {
        const detected = await detectPresetFromPackageJson(projectDir);
        if (detected && detected !== preset.id) {
          printInfo(
            `Tip: detected "${detected}" SDK in package.json — consider \`fullauto init --backend ${detected}\` (currently using default "${preset.id}").`
          );
        }
      }

      printInfo(`Preset: ${preset.label} — ${preset.description}`);

      // 1. Write config.json (only if absent).
      const configExisted = await fileExists(p.configPath);
      if (configExisted) {
        printWarn(`Config already exists: ${p.configPath} — leaving in place.`);
      } else {
        await saveConfigSnapshot(projectDir, preset.buildConfig());
        printInfo(`Wrote default config: ${p.configPath}`);
      }

      // 2. Write mcp.json (only if preset specifies one and file absent).
      const mcpJson = preset.buildMcp();
      if (mcpJson) {
        const mcpPath = resolve(projectDir, '.fullauto/mcp.json');
        if (!(await fileExists(mcpPath))) {
          // Expand `${VAR}` placeholders in MCP env values at WRITE time —
          // Claude CLI does NOT interpolate MCP env at spawn time, so the
          // literal `${SUPABASE_ACCESS_TOKEN}` would be passed to the MCP
          // server and auth would fail with no clear error.
          const { expanded, missing } = expandMcpEnvPlaceholders(mcpJson);
          // Resulting file may contain a real access token → tighten perms.
          await writeJsonFile(mcpPath, expanded, { mode: 0o600 });
          printInfo(`Wrote MCP config: ${mcpPath}`);
          if (missing.length > 0) {
            printWarn(
              `MCP env placeholders had no value at init time and were left empty: ${missing.join(', ')}. Set them in your shell and re-run \`fullauto init --backend ${preset.id}\` (after deleting ${mcpPath}) to bake the values in.`
            );
          }
          printWarn(
            `MCP entry uses "@latest" placeholders — verify the command/version against your installed MCP server before running. Open ${mcpPath} to confirm.`
          );
        }
      }

      // 3. Scaffold .env.example (only if preset specifies and file absent).
      const envExample = preset.buildEnvExample();
      if (envExample) {
        const envExamplePath = resolve(projectDir, '.env.example');
        if (!(await fileExists(envExamplePath))) {
          const { writeFile } = await import('node:fs/promises');
          await writeFile(envExamplePath, envExample, 'utf-8');
          printInfo(`Scaffolded .env.example — copy to .env.local and fill in values.`);
        }
      }

      // 4. Surface required env vars as a checklist the user can act on.
      printRequiredEnv(preset);

      // 4b. Surface non-env manual prereqs (interactive logins, account
      //     setup, etc.) using the same structured printer the planner
      //     output goes through. These are blocking actions the
      //     orchestrator can't do unattended — without surfacing them
      //     here, a first run on a clean machine would silently hang on
      //     a login prompt until the service readyTimeout fires.
      if (preset.manualPrereqs && preset.manualPrereqs.length > 0) {
        printPrerequisites(preset.manualPrereqs);
      }

      // 5. Print preset-specific guidance (which CLIs to run, etc).
      console.log('');
      for (const line of preset.postInitGuidance().split('\n')) {
        console.log(`  ${line}`);
      }

      // 6. Catch the "init basic → init --backend convex" trap.
      if (configExisted && preset.id !== 'none') {
        printWarn(
          `Existing config.json was kept as-is. To wire in this preset's services + mcpConfigPath + example gates, either delete ${p.configPath} and re-run, or manually merge the missing keys.`
        );
      }

      printInfo(
        `Logs and state will live in: ${p.fullautoDir}. Edit the config before running.`
      );

      const ignoreAdded = await ensureGitignoreEntry(projectDir, '.fullauto/');
      if (ignoreAdded) {
        printInfo(`Added \`.fullauto/\` to .gitignore.`);
      }
    }
  );

function printRequiredEnv(preset: BackendPreset): void {
  if (preset.requiredEnv.length === 0) return;
  console.log('');
  console.log(
    `Required env vars for the "${preset.label}" preset (set in .env.local or shell):`
  );
  for (const e of preset.requiredEnv) {
    const tag = e.required ? '[REQUIRED]' : '[optional]';
    console.log(`  ${tag} ${e.name} — ${e.description}`);
  }
}

async function writeJsonFile(
  absPath: string,
  value: unknown,
  opts: { mode?: number } = {}
): Promise<void> {
  const { writeFile, mkdir, chmod } = await import('node:fs/promises');
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  if (opts.mode !== undefined) {
    try {
      await chmod(absPath, opts.mode);
    } catch {
      // chmod can fail on Windows / unusual filesystems; the JSON is
      // already written and the rest of the init flow doesn't depend on
      // the mode change succeeding.
    }
  }
}


const VERIFY_OPTION_HELP =
  `Verification depth policy, overrides config.verifyMode: ${VERIFY_MODES.join(' | ')}. ` +
  `adaptive (default) = per-task depth from classification (config/docs/test/low-risk → gates only, medium → light, high-risk → full); ` +
  `full = /verify-loop depth=full on every task; gates-only = never invoke /verify-loop; ` +
  `feature = gates-only per task + one full /verify-loop over each feature group's combined diff.`;

/** commander argParser: reject anything outside the enum with a readable error. */
function parseVerifyMode(value: string): VerifyMode {
  const v = value.trim().toLowerCase();
  if ((VERIFY_MODES as readonly string[]).includes(v)) return v as VerifyMode;
  throw new Error(`--verify must be one of: ${VERIFY_MODES.join(', ')} (got "${value}")`);
}

/** commander argParser for positive-integer flags (`--rounds 3`), with a readable error. */
function parsePositiveInt(flag: string): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${flag} must be a positive integer (got "${value}")`);
    }
    return n;
  };
}

program
  .command('run')
  .argument('<tasks-file>', 'Path to tasks.md (e.g. speckit /speckit-tasks output)')
  .description('Parse tasks file and start the orchestrator from a fresh state.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .option(
    '-f, --force',
    'Overwrite existing state.json (otherwise refuses if a run is in progress)',
    false
  )
  .option(
    '--strict-prereqs',
    'Abort if any [ENV] prerequisite is unset (otherwise: warn and proceed)',
    false
  )
  .option(
    '--vibe-enhance',
    'After each feature group finishes, run a /vibe-enhance pass — researcher subagent compares against latest trends and applies scoped additions, then routes them through /verify-loop. Feature groups are auto-detected from [USx] labels (Speckit format) or `## ` h2 headings (hand-written). No grouping = one pass at the end.',
    false
  )
  .option('--verify <mode>', VERIFY_OPTION_HELP, parseVerifyMode)
  .action(
    async (
      tasksFile: string,
      opts: {
        dir: string;
        verbose: boolean;
        force: boolean;
        strictPrereqs: boolean;
        vibeEnhance: boolean;
        verify?: VerifyMode;
      }
    ) => {
      const projectDir = resolve(opts.dir);
      await ensureFullautoDir(projectDir);

      const existing = await loadState(projectDir);
      if (existing && !opts.force) {
        // State present and user didn't ask to discard — resume.
        // (The slash command relies on this auto-resume behavior so re-issuing
        // /fullauto after a crash doesn't dead-end.)
        printInfo(
          `Existing state found — resuming. Use --force to discard and start fresh.`
        );
        if (opts.strictPrereqs) {
          printWarn(
            `--strict-prereqs only applies to a fresh run — ignored on resume.`
          );
        }
        if (opts.vibeEnhance) {
          printWarn(
            `--vibe-enhance ignored on resume — the original run's setting persists in state.json.`
          );
        }
        await reconcileConfigOnResume(projectDir, existing);
        applyVerifyOverride(existing.config, opts.verify);
        await ensureRunStateIgnored(projectDir);
        await resetInterrupted(projectDir, existing);
        const resumed = await runOrchestrator({ projectDir, state: existing, verbose: opts.verbose });
        process.exitCode = exitCodeForRun(resumed);
        return;
      }

      const started = await startFreshRun({
        projectDir,
        tasksPath: resolve(tasksFile),
        verbose: opts.verbose,
        strictPrereqs: opts.strictPrereqs,
        vibeEnhance: opts.vibeEnhance,
        verifyMode: opts.verify,
      });
      process.exitCode = exitCodeForRun(started);
    }
  );

program
  .command('plan')
  .argument(
    '<description...>',
    'Natural-language description of what you want built (quote it, or pass as multiple words)'
  )
  .description(
    'Use Claude to decompose a description into a tasks.md file. Does NOT execute — pair with `fullauto run` or use `fullauto auto` for one-shot.'
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option(
    '-o, --output <path>',
    'Output path for the generated tasks file (default: .fullauto/auto-tasks.md, relative to project dir)',
    '.fullauto/auto-tasks.md'
  )
  .option(
    '--timeout <sec>',
    'Planner timeout in seconds. Overrides config.plannerTimeoutSec; falls back to that, then 900s.',
    (v) => parseInt(v, 10)
  )
  .action(
    async (
      descriptionParts: string[],
      opts: { dir: string; output: string; timeout?: number }
    ) => {
      const projectDir = resolve(opts.dir);
      await ensureFullautoDir(projectDir);
      const outputPath = resolve(projectDir, opts.output);
      const description = descriptionParts.join(' ').trim();
      if (!description) {
        printError('Description is empty.');
        process.exitCode = 2;
        return;
      }
      const planResult = await runPlanFlow({
        projectDir,
        description,
        outputPath,
        timeoutSec: await resolvePlannerTimeoutSec(projectDir, opts.timeout),
        productContext: await loadPlannerProductContext(projectDir),
      });
      if (!planResult) {
        process.exitCode = 1;
        return;
      }
      const prereqs = await loadPrerequisitesFromFile(planResult.tasksPath);
      printPrerequisites(prereqs);
    }
  );

program
  .command('auto')
  .argument(
    '<description...>',
    'Natural-language description of what you want built'
  )
  .description(
    'Plan + run in one shot: decompose the description into tasks.md, then execute the orchestrator non-interactively. Missing [ENV] prerequisites are seeded with placeholder values and reported at run end.'
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .option(
    '-f, --force',
    'Overwrite existing state.json (otherwise refuses if a run is in progress)',
    false
  )
  .option(
    '-o, --output <path>',
    'Output path for the generated tasks file',
    '.fullauto/auto-tasks.md'
  )
  .option(
    '--plan-timeout <sec>',
    'Planner timeout in seconds. Overrides config.plannerTimeoutSec; falls back to that, then 900s.',
    (v) => parseInt(v, 10)
  )
  .option(
    '--vibe-enhance',
    'After all planned tasks finish, run a /vibe-enhance pass — fresh researcher subagent looks for trend-based additions beyond what was specified, applies scoped ones, and routes them through /verify-loop.',
    false
  )
  .option('--verify <mode>', VERIFY_OPTION_HELP, parseVerifyMode)
  .action(
    async (
      descriptionParts: string[],
      opts: {
        dir: string;
        verbose: boolean;
        force: boolean;
        output: string;
        planTimeout?: number;
        vibeEnhance: boolean;
        verify?: VerifyMode;
      }
    ) => {
      const projectDir = resolve(opts.dir);
      await ensureFullautoDir(projectDir);

      const existing = await loadState(projectDir);
      if (existing && !opts.force) {
        printInfo(
          `Existing state found — resuming previous run (description ignored). Use --force to discard and re-plan from scratch.`
        );
        if (opts.vibeEnhance) {
          printWarn(
            `--vibe-enhance ignored on resume — the original run's setting persists in state.json.`
          );
        }
        await reconcileConfigOnResume(projectDir, existing);
        applyVerifyOverride(existing.config, opts.verify);
        await ensureRunStateIgnored(projectDir);
        await resetInterrupted(projectDir, existing);
        const resumed = await runOrchestrator({
          projectDir,
          state: existing,
          verbose: opts.verbose,
        });
        process.exitCode = exitCodeForRun(resumed);
        return;
      }

      const description = descriptionParts.join(' ').trim();
      if (!description) {
        printError('Description is empty.');
        process.exitCode = 2;
        return;
      }
      const outputPath = resolve(projectDir, opts.output);

      const commandStartedAt = new Date().toISOString();
      const planResult = await runPlanFlow({
        projectDir,
        description,
        outputPath,
        timeoutSec: await resolvePlannerTimeoutSec(projectDir, opts.planTimeout),
        productContext: await loadPlannerProductContext(projectDir),
      });
      if (!planResult) {
        process.exitCode = 1; // planner failed — reasons were printed inside
        return;
      }

      printInfo(`Plan accepted — handing off to orchestrator.`);
      const started = await startFreshRun({
        projectDir,
        tasksPath: planResult.tasksPath,
        verbose: opts.verbose,
        autoMode: true,
        vibeEnhance: opts.vibeEnhance,
        verifyMode: opts.verify,
        commandStartedAt,
        planStartedAt: planResult.planStartedAt,
        planFinishedAt: planResult.planFinishedAt,
      });
      process.exitCode = exitCodeForRun(started);
    }
  );

program
  .command('evolve')
  .argument(
    '[concept...]',
    'Short product concept in your words (omit it to resume an in-progress evolve from .fullauto/evolve-state.json)'
  )
  .description(
    'Concept → product, unattended: shape a product brief (/product-shape), then loop plan → run → assess (/product-assess) for up to --rounds rounds. Every round is a normal fullauto run (gates + audit + verify), archived under .fullauto/rounds/<r>/. Stops on a ship/stop verdict, the round cap, the time budget, or a round with no progress.'
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .option('--rounds <n>', `Maximum number of rounds (default: ${EVOLVE_DEFAULTS.maxRounds}). On resume, a larger value extends a finished evolve.`, parsePositiveInt('--rounds'))
  .option('--max-tasks-per-round <n>', `Task cap the planner must respect per round (default: ${EVOLVE_DEFAULTS.maxTasksPerRound}).`, parsePositiveInt('--max-tasks-per-round'))
  .option('--time-budget <sec>', 'Wall-clock budget for THIS invocation in seconds; checked between stages (a resume gets a fresh budget).', parsePositiveInt('--time-budget'))
  .option('--vibe-enhance', 'Run a /vibe-enhance pass after each feature group in every round (grounded in the product brief).', false)
  .option('--ux', 'Let /product-assess run /ux-walkthrough (browser / API / CLI journeys) when the project is runnable.', false)
  .option('--verify <mode>', VERIFY_OPTION_HELP, parseVerifyMode)
  .option('-f, --force', 'Discard an existing evolve-state.json and round archives and start over (product.md is kept unless --reshape).', false)
  .option('--reshape', 'With --force: also discard product.md (backed up to product.prev.md) and re-run the shaping stage.', false)
  .action(
    async function (
      this: Command,
      conceptParts: string[],
      opts: {
        dir: string;
        verbose: boolean;
        rounds?: number;
        maxTasksPerRound?: number;
        timeBudget?: number;
        vibeEnhance: boolean;
        ux: boolean;
        verify?: VerifyMode;
        force: boolean;
        reshape: boolean;
      }
    ) {
      const projectDir = resolve(opts.dir);
      const concept = conceptParts.join(' ').trim();
      const result = await runEvolve({
        projectDir,
        concept: concept || undefined,
        rounds: opts.rounds,
        maxTasksPerRound: opts.maxTasksPerRound,
        timeBudgetSec: opts.timeBudget,
        vibeEnhance: opts.vibeEnhance,
        ux: opts.ux,
        verifyMode: opts.verify,
        force: opts.force,
        reshape: opts.reshape,
        verbose: opts.verbose,
      });
      process.exitCode = result.exitCode;
    }
  );

program
  .command('resume')
  .description('Resume an in-progress run from .fullauto/state.json.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .option('--retry-failed', 'Also re-queue every failed task (alias for `fullauto retry` with no ids).', false)
  .action(async (opts: { dir: string; verbose: boolean; retryFailed: boolean }) => {
    const projectDir = resolve(opts.dir);
    const state = await loadState(projectDir);
    if (!state) {
      printError(`No state found at ${paths(projectDir).statePath}. Run \`fullauto run <file>\` first.`);
      process.exitCode = 2;
      return;
    }
    await resetInterrupted(projectDir, state);
    await reconcileConfigOnResume(projectDir, state);
    await ensureRunStateIgnored(projectDir);
    if (opts.retryFailed) {
      const plan = requeueFailedTasks(state);
      if (plan.requeued.length === 0) printInfo('--retry-failed: no failed tasks to re-queue.');
      else printInfo(`--retry-failed: re-queued ${plan.requeued.join(', ')} as deferred in pass ${state.currentPass} (pass budget now ${retryPassLimit(state)}).`);
      await saveState(projectDir, state);
    }
    printResume(paths(projectDir).statePath);
    const result = await runOrchestrator({ projectDir, state, verbose: opts.verbose });
    process.exitCode = exitCodeForRun(result);
  });

program
  .command('retry')
  .argument('[ids...]', 'Task ids to retry (default: every failed task). Failed tasks that only waited on a retried dependency are re-queued with it.')
  .description(
    'Re-run failed tasks after you fixed the cause: flips them from failed back to deferred, opens one more pass on top of maxPasses (pass history is kept), then resumes the run. Exit 0 when every task is done afterwards, 1 otherwise.'
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .action(async (ids: string[], opts: { dir: string; verbose: boolean }) => {
    const projectDir = resolve(opts.dir);
    const state = await loadState(projectDir);
    if (!state) {
      printError(`No state found at ${paths(projectDir).statePath}. Run \`fullauto run <file>\` first.`);
      process.exitCode = 2;
      return;
    }
    await resetInterrupted(projectDir, state);
    await reconcileConfigOnResume(projectDir, state);
    await ensureRunStateIgnored(projectDir);
    const plan = requeueFailedTasks(state, ids);
    if (plan.missing.length > 0) {
      printError(`No such task(s) in this run: ${plan.missing.join(', ')}. Known ids: ${state.tasks.map((t) => t.id).join(', ')}.`);
      process.exitCode = 2;
      return;
    }
    if (plan.skipped.length > 0) {
      printWarn(`Not failed, left as is: ${plan.skipped.map((id) => `${id} [${state.tasks.find((t) => t.id === id)?.status}]`).join(', ')}.`);
    }
    if (plan.requeued.length === 0) {
      printInfo('No failed tasks to retry.');
      process.exitCode = exitCodeForRun(state);
      return;
    }
    printInfo(`Retrying ${plan.requeued.join(', ')}: re-queued as deferred in pass ${state.currentPass} (pass budget now ${retryPassLimit(state)}).`);
    await saveState(projectDir, state);
    printResume(paths(projectDir).statePath);
    const result = await runOrchestrator({ projectDir, state, verbose: opts.verbose });
    process.exitCode = exitCodeForRun(result);
  });

program
  .command('status')
  .description('Show current state without running anything.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .action(async (opts: { dir: string }) => {
    const projectDir = resolve(opts.dir);
    const state = await loadState(projectDir);
    if (!state) {
      printError(`No state found at ${paths(projectDir).statePath}.`);
      process.exitCode = 2;
      return;
    }
    printInfo(`Started: ${formatKst(state.startedAt)}, current pass: ${state.currentPass}`);
    printFinalReport(state);
  });

program
  .command('audit')
  .description(
    'Run the deterministic post-task audit over the working tree: orphan code (created but never imported/rendered/mounted), unused exports, test integrity (skip/only, weakened or deleted tests, tautologies) and gate-config integrity. Compares against HEAD (or --base). Exit 1 when any BLOCK is found. This is what the /wiring-audit skill and /verify-loop call as a pre-check.'
  )
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('--base <git-ref>', 'Git ref to diff against instead of HEAD (e.g. main, HEAD~3, a sha)')
  .option('--json', 'Print the result as JSON instead of a bullet list', false)
  .action(async (opts: { dir: string; base?: string; json: boolean }) => {
    const projectDir = resolve(opts.dir);
    const outcome = await runManualAudit(projectDir, opts.base);

    if (outcome.status === 'not-git-repo') {
      // Nothing to diff against: the audit is a tree diff. Not an error —
      // /verify-loop calls this as a pre-check and must keep going.
      if (opts.json) console.log(JSON.stringify({ skipped: 'not a git repository', blocked: false, findings: [] }, null, 2));
      else printInfo('Audit skipped: not a git repository.');
      return;
    }
    if (outcome.status === 'base-not-found') {
      printError(`--base "${outcome.base}" does not resolve to a commit in ${projectDir}.`);
      process.exitCode = 2;
      return;
    }
    const { base, before, after, result } = outcome;

    const blocks = result.findings.filter((f) => f.severity === 'block').length;
    const warns = result.findings.filter((f) => f.severity === 'warn').length;
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            base,
            baseSha: before.headSha,
            headSha: after.headSha,
            blocked: result.blocked,
            counts: { block: blocks, warn: warns, info: result.findings.length - blocks - warns },
            changed: result.changed,
            findings: result.findings,
          },
          null,
          2
        )
      );
    } else {
      printInfo(
        `Audit: ${result.changed.added} added / ${result.changed.modified} modified / ${result.changed.deleted} deleted vs ${base}${before.headSha ? ` (${before.headSha.slice(0, 7)})` : ''}.`
      );
      if (result.findings.length === 0) {
        console.log(`  (no findings)`);
      } else {
        console.log(renderFindings(result.findings));
      }
      if (result.blocked) {
        printError(`Audit BLOCKED: ${blocks} BLOCK / ${warns} WARN.`);
      } else {
        printInfo(`Audit passed: 0 BLOCK / ${warns} WARN.`);
      }
    }
    if (result.blocked) process.exitCode = 1;
  });

program
  .command('report')
  .description('Print the final report (alias for `status`).')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .action(async (opts: { dir: string }) => {
    const projectDir = resolve(opts.dir);
    const state = await loadState(projectDir);
    if (!state) {
      printError(`No state found.`);
      process.exitCode = 2;
      return;
    }
    printFinalReport(state);
  });

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Ctrl-C / SIGTERM: stop the running subagent's whole process group, let
// the orchestrator save state at its next checkpoint, exit 130 / 143. A
// second signal forces the exit (see runner/process-group.ts).
installSignalHandlers({
  onSignal: (signal) => {
    process.stderr.write(`\n[fullauto] ${signal} received — stopping the running subagent and saving state (press again to force).\n`);
  },
});

program.parseAsync(process.argv).then(
  () => {
    // Commander resolves after the action; process.exitCode carries the verdict.
  },
  (err) => {
    if (err instanceof InterruptedError) {
      process.exit(err.exitCode);
    }
    printError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
