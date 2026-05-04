import { spawn } from 'node:child_process';
import { mkdir, readFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface PlannerOptions {
  description: string;
  projectDir: string;
  /** Absolute path where the planner should write tasks.md. */
  outputPath: string;
  timeoutSec?: number;
  /** Streaming callback for stdout/stderr. */
  onOutput?: (chunk: string) => void;
}

export interface PlannerResult {
  outputPath: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

/**
 * The planner asks the subagent to write the tasks file directly via its Write
 * tool, then we read it back. We deliberately do NOT parse the subagent's
 * stdout for the task list — the file is the contract. This keeps the planner
 * symmetric with the implementer (verdict-via-side-effect, not via marker).
 */
export function buildPlannerPrompt(
  description: string,
  outputPath: string
): string {
  return [
    `# Task Decomposition Job`,
    ``,
    `You are decomposing a user's work request into discrete, single-task implementation units. A full-auto orchestrator will then execute each task one-by-one in fresh subagent contexts. Each task must be small enough that a subagent with no prior context can complete it in roughly 30 minutes.`,
    ``,
    `## User request`,
    ``,
    description,
    ``,
    `## Your job`,
    ``,
    `1. If helpful, briefly read the project files in your current working directory to understand the codebase shape (existing files, language, conventions). Don't go deep — you are NOT implementing anything.`,
    `2. Use the Write tool to create the file at this exact absolute path:`,
    ``,
    `   ${outputPath}`,
    ``,
    `   File contents must be a markdown checkbox list, one task per line, in this EXACT shape:`,
    ``,
    `   - [ ] T001 <one-line, actionable task description>`,
    `   - [ ] T002 <next task> (depends on T001)`,
    `   - [ ] T003 <next task> (depends on T001, T002)`,
    ``,
    `## Rules for the task list`,
    `- Each task = one verb + one concrete artifact (file, function, endpoint, schema, test). NOT abstract or exploratory.`,
    `- Order tasks topologically. Declare every real dependency with \`(depends on T###)\`. Independent tasks need no annotation.`,
    `- Skip "research", "explore", "decide", "plan" tasks — make those calls NOW yourself, then write concrete tasks.`,
    `- Aim for 3–20 tasks total. If you need more, the request is probably too big for one auto-run; fold related steps into a single task.`,
    `- Indented sub-bullets under a task line are allowed and become part of the task body (specifications, acceptance criteria, file paths). Use them when one line isn't enough.`,
    ``,
    `## If the request is genuinely ambiguous`,
    ``,
    `If you cannot break this down without more information from the user, write the file with this single line as its entire content:`,
    ``,
    `   AMBIGUOUS: <one specific question the user must answer>`,
    ``,
    `The orchestrator detects that marker and surfaces the question — do not guess.`,
    ``,
    `## Output protocol`,
    ``,
    `The Write tool result is your only deliverable. Stdout commentary is ignored by the orchestrator. Do not wrap the task list in markdown code fences. Do not add a preamble or trailing prose inside the file — the parser expects the first line to start with \`- [ ]\` or with \`AMBIGUOUS:\`.`,
  ].join('\n');
}

const AMBIGUOUS_MARKER = /^\s*AMBIGUOUS:\s*(.+?)\s*$/im;

export async function runPlanner(opts: PlannerOptions): Promise<PlannerResult> {
  const { description, projectDir, outputPath, timeoutSec = 900, onOutput } =
    opts;
  await mkdir(dirname(outputPath), { recursive: true });
  const prompt = buildPlannerPrompt(description, outputPath);
  const startedAt = Date.now();

  return new Promise<PlannerResult>((resolve) => {
    const child = spawn(
      'claude',
      ['-p', prompt, '--permission-mode', 'acceptEdits'],
      {
        cwd: projectDir,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutSec * 1000);

    child.stdout.on('data', (d: Buffer) => onOutput?.(d.toString('utf-8')));
    child.stderr.on('data', (d: Buffer) => onOutput?.(d.toString('utf-8')));

    const finalize = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        outputPath,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', () => finalize(-1));
    child.on('close', (code) => finalize(code ?? -1));
  });
}

export interface PlannerOutputCheck {
  exists: boolean;
  /** If the planner wrote an AMBIGUOUS line, the question after the colon. */
  ambiguous?: string;
  /** Raw file contents if the file exists. */
  content?: string;
}

export async function checkPlannerOutput(
  outputPath: string
): Promise<PlannerOutputCheck> {
  try {
    await access(outputPath);
  } catch {
    return { exists: false };
  }
  const content = await readFile(outputPath, 'utf-8');
  const ambiguous = content.match(AMBIGUOUS_MARKER);
  if (ambiguous) {
    return { exists: true, ambiguous: ambiguous[1].trim(), content };
  }
  return { exists: true, content };
}
