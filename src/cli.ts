#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { loadTasksFromFile } from './parsers/speckit.js';
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
  .description('Initialize .fullauto/ in the current directory with a default config.')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', process.cwd())
  .action(async (opts: { dir: string }) => {
    const projectDir = resolve(opts.dir);
    await ensureFullautoDir(projectDir);

    const p = paths(projectDir);
    if (await fileExists(p.configPath)) {
      printWarn(`Config already exists: ${p.configPath} — leaving in place.`);
      return;
    }

    const defaultConfig = {
      maxPasses: 2,
      subagentTimeoutSec: 1800,
      useReviewLoop: true,
      gates: [
        {
          name: 'typecheck',
          command: 'npm run typecheck --if-present',
          skipIf: 'test ! -f package.json',
        },
        {
          name: 'test',
          command: 'npm test --if-present -- --passWithNoTests',
          skipIf: 'test ! -f package.json',
        },
        {
          name: 'lint',
          command: 'npm run lint --if-present',
          skipIf: 'test ! -f package.json',
        },
      ],
    };
    await saveConfigSnapshot(projectDir, defaultConfig);
    printInfo(`Wrote default config: ${p.configPath}`);
    printInfo(`Edit it before running. Logs and state will live in: ${p.fullautoDir}`);
  });

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
  .action(
    async (
      tasksFile: string,
      opts: { dir: string; verbose: boolean; force: boolean }
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
      });
    }
  );

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
}): Promise<boolean> {
  const { projectDir, tasksPath, verbose } = args;
  const tasks = await loadTasksFromFile(tasksPath);

  const userConfig = (await loadUserConfig(projectDir)) ?? {};
  const config = RunConfig.parse(userConfig);

  // An empty gates list silently makes every task auto-pass (allGatesPassed
  // returns true on []), defeating the whole verification design.
  if (config.gates.length === 0) {
    printError(
      `Refusing to run: config has no verification gates. Without gates, every task is auto-passed without any check. Run \`fullauto init\` to write the default gate config, or add at least one gate to .fullauto/config.json.`
    );
    process.exitCode = 2;
    return false;
  }

  const state: RunState = {
    startedAt: new Date().toISOString(),
    currentPass: 1,
    tasks,
    config,
    passSnapshots: [],
  };
  await saveState(projectDir, state);

  printInfo(
    `Loaded ${tasks.length} task(s) from ${tasksPath}. Project: ${projectDir}`
  );
  await runOrchestrator({ projectDir, state, verbose });
  return true;
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
      await runPlanFlow({
        projectDir,
        description,
        outputPath,
        timeoutSec: opts.timeout,
      });
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
    'Plan + run in one shot: decompose the description into tasks.md, then execute the orchestrator on it.'
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
  .action(
    async (
      descriptionParts: string[],
      opts: {
        dir: string;
        verbose: boolean;
        force: boolean;
        output: string;
        planTimeout: number;
      }
    ) => {
      const projectDir = resolve(opts.dir);
      await ensureFullautoDir(projectDir);

      const existing = await loadState(projectDir);
      if (existing && !opts.force) {
        printInfo(
          `Existing state found — resuming previous run (description ignored). Use --force to discard and re-plan from scratch.`
        );
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

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
