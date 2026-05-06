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
    `## Test coverage (REQUIRED)`,
    ``,
    `For every task that adds testable runtime behavior — a new endpoint, API handler, service / business-logic function, database mutation, or non-trivial pure function — the task list MUST include a paired test task that exercises that behavior at the runtime level. This is the mechanism by which the orchestrator's verification gate (typecheck/test/lint) actually catches broken behavior — without these test tasks, the gate only catches type/syntax errors and the "feature works" claim is unverified.`,
    ``,
    `Pairing rules:`,
    `- API / endpoint task → integration test task that hits the endpoint with realistic input and asserts response status + body shape.`,
    `- Service / business-logic task → unit OR integration test calling the function with realistic input and asserting output (and side-effects, if any).`,
    `- Database mutation task → test that performs the mutation and verifies the resulting state via a follow-up read.`,
    `- Pure function task → unit test for happy path + at least one edge case.`,
    `- Convex/Supabase function task → either an integration test OR a \`convex-fn\` / \`http\` gate (mention it in the task body so the user knows to add it to .fullauto/config.json).`,
    ``,
    `Order: TDD-style is preferred — write the test task FIRST and have the implementation task \`(depends on T###)\` it. The implementation subagent will then read its dependency's test as the contract to satisfy. After-the-fact tests are also acceptable when TDD doesn't fit (e.g., refactors of working code) — pick whichever makes the test task's purpose clearer.`,
    ``,
    `When you split tests into a separate task, add a sub-bullet \`- tests: T###\` to the IMPLEMENTATION task pointing at the test task. This is a delegation hint — the implementation subagent has a fallback rule that auto-writes tests inline when no test task is visible, and the sub-bullet is what tells it "tests live elsewhere, focus on implementation." Without this hint you may end up with duplicate test files (one from the test task, one from the implementer's fallback).`,
    ``,
    `Skip the test-pairing ONLY for:`,
    `- Pure config / scaffolding tasks (\`create directory structure\`, \`add dependency to package.json\`, \`set up CI workflow file\`).`,
    `- UI styling / theming where automated assertion is impractical.`,
    `- Documentation-only tasks.`,
    ``,
    `When you skip test-pairing, add a sub-bullet \`- no test: <reason>\` so the user can see your judgment was deliberate, not an oversight.`,
    ``,
    `If the project has no test runner yet (no \`test\` script in package.json, no pytest.ini / pyproject.toml test config, no go test or cargo test conventions visible in the codebase), include a setup task EARLY in the list that adds one — otherwise your test tasks will produce files that the orchestrator's test gate doesn't actually run, defeating the whole point.`,
    ``,
    `## Manual prerequisites section (REQUIRED)`,
    ``,
    `After the task list, append a "Manual Prerequisites" section listing every action that requires the HUMAN USER (not the subagent) before or during the run — things the orchestrator cannot do autonomously: setting environment variables, providing API keys, logging into a CLI (vercel/gcloud/aws), authorizing OAuth, activating billing accounts, purchasing domains, opening firewall rules, creating cloud resources that need a real account, etc.`,
    ``,
    `Use this EXACT shape (the marker line is required — the orchestrator parses it):`,
    ``,
    `   ## Manual Prerequisites`,
    `   <!-- fullauto:prerequisites -->`,
    `   - [ENV] STRIPE_SECRET_KEY — Stripe live secret key for payment processing`,
    `   - [ENV] DATABASE_URL — Postgres connection string`,
    `   - [AUTH] Run \`vercel login\` to authenticate the Vercel CLI`,
    `   - [ACCOUNT] Activate billing on the OpenAI organization`,
    `   - [OTHER] Purchase the production domain and point its DNS to Vercel`,
    ``,
    `Kind tags:`,
    `- \`[ENV]\` — environment variable. The IDENTIFIER (uppercased token before the em dash) MUST be the exact variable name; the orchestrator checks \`process.env\` and warns the user about missing ones.`,
    `- \`[AUTH]\` — interactive CLI login or OAuth handshake.`,
    `- \`[ACCOUNT]\` — billing/quota/account-tier action on a third-party service.`,
    `- \`[OTHER]\` — any other manual action that doesn't fit the above.`,
    ``,
    `If there are GENUINELY no manual prerequisites (e.g. a self-contained refactor), still write the section with one line: \`- [OTHER] None — fully self-contained.\`. Never omit the section.`,
    ``,
    `## Resolving ambiguity autonomously (REQUIRED)`,
    ``,
    `fullauto is unattended. There is NO mechanism to ask the user a follow-up question — the user has already gone away. If something in the request is underspecified, you MUST resolve it yourself and proceed. Refusing to decompose is not an option.`,
    ``,
    `Resolve in this order:`,
    `1. **Project signal** — read \`README.md\`, \`CLAUDE.md\`, \`package.json\` / \`pyproject.toml\` / \`Cargo.toml\` / \`go.mod\` / equivalent, and skim a few representative source files. The existing stack, conventions, and recent direction are the strongest signal of what the user wants.`,
    `2. **Recent direction** — \`git log --oneline -20\` (if a git repo is detectable) tells you what the team has been investing in. Match that energy.`,
    `3. **Domain conventions** — fall back to the de-facto standard for this kind of project (e.g., for a Next.js app: App Router + Server Components; for a Python async API: pydantic + httpx; for a React form: react-hook-form-style patterns). Lean toward what a competent engineer in this stack would do *today* (current best practices), not what was conventional 3 years ago.`,
    `4. **Reasonable default** — if all else is silent, pick the most defensible default and move on. Document the choice in the Assumptions section below.`,
    ``,
    `Treat every "the user didn't say X" moment as a decision YOU make, not a question. Make the call, capture the assumption, keep moving.`,
    ``,
    `## Assumptions section (REQUIRED when you made non-obvious calls)`,
    ``,
    `If you resolved any underspecified part of the request via the rules above, append an Assumptions section after Manual Prerequisites so the user can review your judgment after the run. Use this exact shape:`,
    ``,
    `   ## Assumptions`,
    `   <!-- fullauto:assumptions -->`,
    `   - <one-line decision> — <one-line reasoning grounded in project signal / domain convention>`,
    ``,
    `Examples:`,
    `   - Used Postgres (not MySQL) — \`pg\` already in package.json and recent migrations target Postgres.`,
    `   - Chose JWT over session cookies for the auth task — project is a stateless API with no existing session store.`,
    `   - Added \`zod\` for request validation — already used in src/lib/validators/ for adjacent endpoints.`,
    ``,
    `If everything in the request was explicit and you genuinely had no ambiguity to resolve, omit the section.`,
    ``,
    `## Output protocol`,
    ``,
    `The Write tool result is your only deliverable. Stdout commentary is ignored by the orchestrator. Do not wrap the task list in markdown code fences. Do not add a preamble or trailing prose inside the file — the parser expects the first line to start with \`- [ ]\`. Never write a refusal, a question, or a clarification request as the file contents — make the call and produce the task list.`,
  ].join('\n');
}

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
  return { exists: true, content };
}
