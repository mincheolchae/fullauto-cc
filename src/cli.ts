#!/usr/bin/env node
import { Command } from 'commander';
import { dirname, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  loadPrerequisitesFromFile,
  loadTasksFromFile,
} from './parsers/speckit.js';
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
  loadUserConfig,
  saveConfigSnapshot,
  saveState,
  paths,
} from './persistence.js';
import { RunConfig, RunState } from './types.js';
import { runOrchestrator } from './orchestrator.js';
import { runPlanner, checkPlannerOutput } from './planner.js';
import {
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


/**
 * Idempotently ensure `entry` is present in the project's .gitignore. Creates
 * the file if missing. Returns true if a write happened (entry added), false
 * if it was already present.
 */
async function ensureGitignoreEntry(
  projectDir: string,
  entry: string
): Promise<boolean> {
  const path = resolve(projectDir, '.gitignore');
  const { readFile, writeFile } = await import('node:fs/promises');
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

program
  .command('run')
  .argument('<tasks-file>', 'Path to tasks.md (e.g. speckit /speckit.tasks output)')
  .description('Parse tasks file and start the orchestrator from a fresh state.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .option(
    '-f, --force',
    'Overwrite existing state.json (otherwise refuses if a run is in progress)',
    false
  )
  .option('-y, --yes', 'Skip the manual-prerequisites confirmation prompt', false)
  .option(
    '--strict-prereqs',
    'In non-interactive mode, abort if any [ENV] prerequisite is unset',
    false
  )
  .option(
    '--vibe-enhance',
    'After each feature group finishes, run a /vibe-enhance pass — researcher subagent compares against latest trends and applies scoped additions, then routes them through /review-loop. Feature groups are auto-detected from [USx] labels (Speckit format) or `## ` h2 headings (hand-written). No grouping = one pass at the end.',
    false
  )
  .action(
    async (
      tasksFile: string,
      opts: {
        dir: string;
        verbose: boolean;
        force: boolean;
        yes: boolean;
        strictPrereqs: boolean;
        vibeEnhance: boolean;
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
        if (opts.yes || opts.strictPrereqs) {
          printWarn(
            `--yes / --strict-prereqs only apply to a fresh run — ignored on resume.`
          );
        }
        if (opts.vibeEnhance) {
          printWarn(
            `--vibe-enhance ignored on resume — the original run's setting persists in state.json.`
          );
        }
        await reconcileConfigOnResume(projectDir, existing);
        for (const t of existing.tasks) {
          if (t.status === 'in_progress') t.status = 'pending';
        }
        await runOrchestrator({ projectDir, state: existing, verbose: opts.verbose });
        return;
      }

      await startFreshRun({
        projectDir,
        tasksPath: resolve(tasksFile),
        verbose: opts.verbose,
        yes: opts.yes,
        strictPrereqs: opts.strictPrereqs,
        vibeEnhance: opts.vibeEnhance,
      });
    }
  );

/**
 * On resume, prefer the live `.fullauto/config.json` over the snapshot saved
 * inside `state.json`. This lets the user edit gates / timeouts / passes
 * after a crash without having to discard state. If the file changed, log
 * the diff so the user knows their edits took effect.
 */
async function reconcileConfigOnResume(
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

/**
 * Common path for "fresh run from a tasks.md file": load the tasks, validate
 * the config has gates, init state, persist, and start the orchestrator.
 * Used by both `fullauto run` and `fullauto auto`.
 *
 * Returns false if startup was aborted (e.g. empty gates), true if the run
 * actually started.
 */
async function startFreshRun(args: {
  projectDir: string;
  tasksPath: string;
  verbose: boolean;
  yes?: boolean;
  strictPrereqs?: boolean;
  /**
   * `auto` mode is non-interactive by design: instead of prompting the user
   * to fix missing env vars, we surface the checklist, seed placeholder
   * values for any unset [ENV] items, and report them at run end.
   */
  autoMode?: boolean;
  /** CLI-level override for config.vibeEnhance. When true, force-enable. */
  vibeEnhance?: boolean;
}): Promise<boolean> {
  const { projectDir, tasksPath, verbose, autoMode } = args;
  const tasks = await loadTasksFromFile(tasksPath);

  const userConfig = (await loadUserConfig(projectDir)) ?? {};
  const config = RunConfig.parse(userConfig);
  // CLI flag forces vibeEnhance on for this run. We deliberately don't
  // implement a way to force it OFF from the CLI — config.json is the place
  // for that. (If users want it permanently on, set it in config.json and
  // skip the flag.)
  if (args.vibeEnhance) config.vibeEnhance = true;

  // An empty gates list silently makes every task auto-pass (allGatesPassed
  // returns true on []), defeating the whole verification design.
  if (config.gates.length === 0) {
    printError(
      `Refusing to run: config has no verification gates. Without gates, every task is auto-passed without any check. Run \`fullauto init\` to write the default gate config, or add at least one gate to .fullauto/config.json.`
    );
    process.exitCode = 2;
    return false;
  }

  printInfo(
    `Loaded ${tasks.length} task(s) from ${tasksPath}. Project: ${projectDir}`
  );

  // In `run` mode (interactive by intent): surface prereqs and ask the user
  // to confirm. In `auto` mode (non-interactive by intent): surface them
  // as an FYI but proceed unconditionally, seeding placeholder values for
  // missing env vars so subagents can still execute.
  let placeholderEnvs: string[] = [];
  if (autoMode) {
    placeholderEnvs = await collectPlaceholderEnvs(tasksPath);
  } else {
    const proceed = await surfacePrerequisites(tasksPath, {
      skipConfirm: args.yes ?? false,
      strict: args.strictPrereqs ?? false,
    });
    if (!proceed) return false;
  }

  const state: RunState = {
    startedAt: new Date().toISOString(),
    currentPass: 1,
    tasks,
    config,
    passSnapshots: [],
    placeholderEnvs,
  };
  await saveState(projectDir, state);

  await runOrchestrator({ projectDir, state, verbose });
  return true;
}

/**
 * In `auto` mode: print the prereq checklist for visibility, then return the
 * subset of [ENV] entries with valid POSIX names whose value is unset. The
 * orchestrator seeds those into spawned subagents as FULLAUTO_PLACEHOLDER_<N>
 * and reports them at run end so the user knows what to replace.
 */
async function collectPlaceholderEnvs(tasksPath: string): Promise<string[]> {
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
    'Planner timeout in seconds (default: 900 = 15min)',
    (v) => parseInt(v, 10),
    900
  )
  .action(
    async (
      descriptionParts: string[],
      opts: { dir: string; output: string; timeout: number }
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
      const tasksPath = await runPlanFlow({
        projectDir,
        description,
        outputPath,
        timeoutSec: opts.timeout,
      });
      if (tasksPath) {
        const prereqs = await loadPrerequisitesFromFile(tasksPath);
        printPrerequisites(prereqs);
      }
    }
  );

/**
 * Returns the path of the planner-written tasks file on success, or null if
 * the planner failed / produced AMBIGUOUS / wrote nothing. Caller decides
 * whether to chain into a run.
 */
async function runPlanFlow(args: {
  projectDir: string;
  description: string;
  outputPath: string;
  timeoutSec: number;
}): Promise<string | null> {
  const { projectDir, description, outputPath, timeoutSec } = args;
  printInfo(
    `Planning: "${description.length > 100 ? description.slice(0, 97) + '...' : description}"`
  );
  printInfo(`Output: ${outputPath}`);

  const result = await runPlanner({
    description,
    projectDir,
    outputPath,
    timeoutSec,
    // Planner output is usually short; let it through to stdout so the user
    // can see what the subagent is doing without needing --verbose.
    onOutput: (chunk) => process.stderr.write(chunk),
  });

  if (result.timedOut) {
    printError(`Planner timed out after ${timeoutSec}s.`);
    process.exitCode = 1;
    return null;
  }
  if (result.exitCode !== 0) {
    printError(`Planner exited with code ${result.exitCode}.`);
    process.exitCode = 1;
    return null;
  }

  const check = await checkPlannerOutput(outputPath);
  if (!check.exists) {
    printError(
      `Planner exited 0 but did not create ${outputPath}. The subagent likely ignored the Write instruction — try a more specific description, or run \`fullauto plan\` and paste the output manually.`
    );
    process.exitCode = 1;
    return null;
  }
  if (check.ambiguous) {
    printWarn(`Planner needs clarification: ${check.ambiguous}`);
    printInfo(
      `Re-run \`fullauto plan\` with a more detailed description, or edit ${outputPath} manually before \`fullauto run\`.`
    );
    return null;
  }

  printInfo(`Wrote tasks file: ${outputPath}`);
  return outputPath;
}

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
    'Planner timeout in seconds (default: 900)',
    (v) => parseInt(v, 10),
    900
  )
  .option(
    '--vibe-enhance',
    'After all planned tasks finish, run a /vibe-enhance pass — fresh researcher subagent looks for trend-based additions beyond what was specified, applies scoped ones, and routes them through /review-loop.',
    false
  )
  .action(
    async (
      descriptionParts: string[],
      opts: {
        dir: string;
        verbose: boolean;
        force: boolean;
        output: string;
        planTimeout: number;
        vibeEnhance: boolean;
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
        for (const t of existing.tasks) {
          if (t.status === 'in_progress') t.status = 'pending';
        }
        await runOrchestrator({
          projectDir,
          state: existing,
          verbose: opts.verbose,
        });
        return;
      }

      const description = descriptionParts.join(' ').trim();
      if (!description) {
        printError('Description is empty.');
        process.exitCode = 2;
        return;
      }
      const outputPath = resolve(projectDir, opts.output);

      const tasksPath = await runPlanFlow({
        projectDir,
        description,
        outputPath,
        timeoutSec: opts.planTimeout,
      });
      if (!tasksPath) return; // planner failed or AMBIGUOUS — exit codes set inside

      printInfo(`Plan accepted — handing off to orchestrator.`);
      await startFreshRun({
        projectDir,
        tasksPath,
        verbose: opts.verbose,
        autoMode: true,
        vibeEnhance: opts.vibeEnhance,
      });
    }
  );

program
  .command('resume')
  .description('Resume an in-progress run from .fullauto/state.json.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .option('-v, --verbose', 'Stream subagent output to stdout', false)
  .action(async (opts: { dir: string; verbose: boolean }) => {
    const projectDir = resolve(opts.dir);
    const state = await loadState(projectDir);
    if (!state) {
      printError(`No state found at ${paths(projectDir).statePath}. Run \`fullauto run <file>\` first.`);
      process.exitCode = 2;
      return;
    }
    // If a task was caught mid-flight (in_progress), reset it back to pending so
    // it gets re-attempted in the next pass.
    for (const t of state.tasks) {
      if (t.status === 'in_progress') t.status = 'pending';
    }
    await reconcileConfigOnResume(projectDir, state);
    printResume(paths(projectDir).statePath);
    await runOrchestrator({ projectDir, state, verbose: opts.verbose });
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
    printInfo(`Started: ${state.startedAt}, current pass: ${state.currentPass}`);
    printFinalReport(state);
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

/**
 * Read tasks file, surface its Manual Prerequisites section, optionally
 * prompt the user to confirm. Returns true if the caller should proceed.
 *
 * Behavior:
 *  - No prereqs in the file → silent passthrough, returns true.
 *  - Prereqs present + interactive (TTY) + !skipConfirm → prompt [Y/n].
 *  - Prereqs present + non-TTY → print and proceed (so CI / piped use isn't
 *    silently blocked). User can opt into hard-stop with --strict-prereqs.
 *  - skipConfirm (--yes) → print and proceed regardless.
 */
async function surfacePrerequisites(
  tasksPath: string,
  opts: { skipConfirm: boolean; strict: boolean }
): Promise<boolean> {
  const prereqs = await loadPrerequisitesFromFile(tasksPath);
  if (prereqs.length === 0) return true;

  const { missingEnvCount } = printPrerequisites(prereqs);

  if (opts.skipConfirm) {
    if (missingEnvCount > 0) {
      printWarn(
        `Proceeding despite ${missingEnvCount} unset env var(s) (--yes).`
      );
    }
    return true;
  }

  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
  if (!isInteractive) {
    if (opts.strict && missingEnvCount > 0) {
      printError(
        `--strict-prereqs and ${missingEnvCount} unset env var(s) — refusing to start.`
      );
      process.exitCode = 2;
      return false;
    }
    printInfo(
      `Non-interactive shell detected — continuing without confirmation.`
    );
    return true;
  }

  const answer = await prompt(
    missingEnvCount > 0
      ? `\nContinue anyway? Missing env vars will likely fail at runtime. [y/N] `
      : `\nContinue with the run? [Y/n] `
  );
  const defaultYes = missingEnvCount === 0;
  const proceed = defaultYes
    ? !/^n(o)?$/i.test(answer.trim())
    : /^y(es)?$/i.test(answer.trim());
  if (!proceed) {
    printInfo(`Aborted by user. No state changes were made.`);
    return false;
  }
  return true;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
