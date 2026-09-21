import { mkdir, readFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawnClaudeWithBackoff } from './runner/claude.js';
import { DEFAULT_RATE_LIMIT_BACKOFF } from './runner/rate-limit.js';

/**
 * Product-brief context handed to the planner when `.fullauto/product.md`
 * exists (written by `fullauto evolve`, or by hand). `round` + `maxTasks`
 * are set only by the evolve loop and switch on the round-selection rules
 * and the `<!-- fullauto:round=… -->` header requirement.
 */
export interface PlannerProductContext {
  /** Extracted, capped brief text (see `extractProductContext`). */
  context: string;
  /** Absolute path of product.md, so the planner can read the full file if a section was clipped. */
  productPath: string;
  /** Evolve round number; absent for `fullauto plan` / `auto`. */
  round?: number;
  /** Cap on tasks for the round (evolve only). */
  maxTasks?: number;
}

export interface PlannerOptions {
  description: string;
  projectDir: string;
  /** Absolute path where the planner should write tasks.md. */
  outputPath: string;
  timeoutSec?: number;
  /**
   * Path (relative to projectDir) to an MCP config file. Forwarded to the
   * planner subagent via `--mcp-config` after the same vetting the
   * implementer subagent uses, so the planner can introspect e.g. Convex
   * schema or Supabase tables when decomposing the request. Same path
   * source as `RunConfig.mcpConfigPath`.
   */
  mcpConfigPath?: string;
  /** Streaming callback for stdout/stderr. */
  onOutput?: (chunk: string) => void;
  /** Product brief context (present when `.fullauto/product.md` exists). */
  productContext?: PlannerProductContext;
  /** Transcript log path; omitted = no log file (the `plan` / `auto` commands stream to stderr instead). */
  logPath?: string;
  /** Fired once per rate-limit backoff cycle (src/runner/rate-limit.ts) — lets the caller print progress on a long unattended wait. */
  onRateLimit?: (info: { attempt: number; waitMs: number; resetHint?: string }) => void;
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
  outputPath: string,
  productContext?: PlannerProductContext
): string {
  const round = productContext?.round;
  const taskCountRule =
    round !== undefined && productContext?.maxTasks
      ? `- At most ${productContext.maxTasks} tasks in total for this round (tests + implementation included). If the selected backlog items need more, select fewer items — never slice an item.`
      : `- Aim for 3–20 tasks total. If you need more, the request is probably too big for one auto-run; fold related steps into a single task.`;
  const firstLineRule =
    round !== undefined
      ? `The first line of the file must be the round header \`<!-- fullauto:round=${round} items=F001,F004 -->\` (see "Product context"); the task list follows it.`
      : `The parser expects the first line to start with \`- [ ]\` (or a \`## Feature:\` heading).`;
  return [
    `# Task Decomposition Job`,
    ``,
    `You are decomposing a user's work request into discrete, single-task implementation units. A full-auto orchestrator will then execute each task one-by-one in fresh subagent contexts. Each task must be small enough that a subagent with no prior context can complete it in roughly 30 minutes.`,
    ``,
    `## User request`,
    ``,
    description,
    ...(productContext ? [``, ...productContextSection(productContext)] : []),
    ``,
    `## Your job`,
    ``,
    `1. If helpful, briefly read the project files in your current working directory to understand the codebase shape (existing files, language, conventions). Don't go deep — you are NOT implementing anything. **Cap initial exploration at roughly 10 file reads and 3 directory listings** — you need a vibe of the stack and conventions, not a full audit. If MCP servers are wired up (Convex / Supabase / etc.), use them sparingly to introspect external schemas instead of guessing from source files.`,
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
    `- Every \`(depends on T###)\` must reference a task ID that ALSO appears in this list. Dangling refs leave the orchestrator's queue with permanently-blocked tasks; the validator will reject your output.`,
    `- Skip "research", "explore", "decide", "plan" tasks — make those calls NOW yourself, then write concrete tasks.`,
    taskCountRule,
    `- Indented sub-bullets under a task line are allowed and become part of the task body (specifications, acceptance criteria, file paths). Use them when one line isn't enough.`,
    ``,
    `## Feature grouping (when the request spans multiple distinct features)`,
    ``,
    `If the user request covers more than one independently-deliverable feature (e.g. "build a chat app with rooms AND a profile page" → two features; "add rate limiting to /users" → one feature), split tasks under \`## Feature: <name>\` h2 headings. Tasks following a heading belong to that feature until the next heading.`,
    ``,
    `Example shape:`,
    ``,
    `   ## Feature: Auth flow`,
    `   - [ ] T001 ...`,
    `   - [ ] T002 ... (depends on T001)`,
    ``,
    `   ## Feature: Chat rooms`,
    `   - [ ] T003 ...`,
    `   - [ ] T004 ... (depends on T003)`,
    ``,
    `Why this matters: when \`--vibe-enhance\` is on, a researcher pass runs after EACH feature group completes. Without headings, every task lands in one implicit group and the enhance pass fires only once at the end of the run — losing the per-feature trend-check granularity.`,
    ``,
    `Single-feature requests don't need headings. When in doubt, omit them — extraneous headings just create noise.`,
    ``,
    `## Test coverage — TDD pairing (REQUIRED)`,
    ``,
    `The orchestrator verifies tasks deterministically: gates (typecheck/test/lint) plus a post-task audit that diffs the tree, checks that new code is actually wired in, and checks that tests were not skipped, weakened or deleted. Your task list must be shaped so those checks have something to bite on.`,
    ``,
    `For EVERY task that adds testable runtime behavior — a new endpoint, API handler, service / business-logic function, database mutation, CLI command, or non-trivial pure function — emit a RED/GREEN pair, in this order:`,
    `1. A test task FIRST, marked \`- tdd: red\` and \`- level: unit|integration|e2e\`. The implementer writes ONLY the tests (plus stubs so typecheck passes) and the orchestrator EXPECTS them to fail. The red task MUST carry \`- wired by: T###\` naming the task that first imports its stub from production code — normally the green task; when a later task is the real consumer, point at that one.`,
    `2. The implementation task, \`(depends on T-test)\`, marked \`- tests: T-test\`. The orchestrator hashes the red tests, forbids the implementer from editing them, and requires them to pass.`,
    ``,
    `Level rules:`,
    `- Pure function / business logic → \`- level: unit\` (happy path + at least one edge case).`,
    `- Anything touching a database, filesystem, queue, framework wiring → \`- level: integration\` (exercise the real unit, not a mock of it; verify side-effects with a follow-up read).`,
    `- Every public HTTP endpoint, CLI command, or core user journey → \`- level: integration\` or \`- level: e2e\` that exercises the REAL entry point (supertest/fetch against the app, the CLI binary, or the project's existing e2e runner) — not a unit test of the handler in isolation.`,
    `- Convex/Supabase function task → an integration test OR a \`convex-fn\` / \`http\` gate (mention it in the task body so the user knows to add it to .fullauto/config.json).`,
    ``,
    `Skip the pairing ONLY for tasks with no testable runtime behavior, and say so with a marker:`,
    `- Config / scaffold tasks (\`create directory structure\`, \`add dependency\`, \`set up CI workflow\`): \`- kind: config\`.`,
    `- Test-runner setup (vitest/jest/pytest config, test script in package.json): \`- kind: config\` + \`- touches-config: adds test runner\` — without the second marker the audit BLOCKS any task that edits test/lint/typecheck config.`,
    `- UI styling / theming, documentation-only tasks: \`- no test: <reason>\`.`,
    `If a task must edit PRE-EXISTING tests (a refactor that changes a public signature), add \`- modifies-tests: <reason>\`; otherwise the audit treats a shrinking test file as cheating.`,
    ``,
    `If the project has no test runner yet (no \`test\` script in package.json, no pytest.ini / pyproject.toml test config, no go test or cargo test conventions visible in the codebase), include a setup task EARLY in the list that adds one (\`- kind: config\` + \`- touches-config: adds test runner\`) — otherwise your test tasks will produce files that the orchestrator's test gate doesn't actually run, defeating the whole point.`,
    ``,
    `## Wiring (REQUIRED)`,
    ``,
    `Every task that creates a module / component / route / handler must either wire it into production code in the SAME task (say where in the task body: "mounted in src/app.ts", "rendered by app/page.tsx") or carry \`- wired by: T###\` naming the later task that will. The audit BLOCKS a task that leaves a new file unreferenced by production code, and BLOCKS the \`wired by\` task if the artifact is still orphaned when it finishes. No task may end with unreferenced code.`,
    ``,
    `## Risk (recommended)`,
    ``,
    `Add \`- risk: high\` to tasks touching auth / sessions / tokens, payments / billing, database schema or migrations, permissions / roles, secrets / crypto, file upload, middleware, admin or destructive operations, public API surface. High-risk tasks get a full multi-reviewer /verify-loop; everything else gets a lighter (cheaper) review. The orchestrator also infers risk from keywords, so this marker mostly matters when the title is bland ("update handler") but the blast radius is not.`,
    ``,
    `## Markers reference`,
    ``,
    `Sub-bullets the orchestrator parses (one per line, under the task line; anything else in the body is free text):`,
    `   - kind: test|impl|config|docs`,
    `   - risk: low|medium|high`,
    `   - tdd: red|green|none`,
    `   - level: unit|integration|e2e`,
    `   - tests: T###          (impl task → its red test task)`,
    `   - no test: <reason>`,
    `   - touches-config: <reason>`,
    `   - modifies-tests: <reason>`,
    `   - wired by: T###`,
    ``,
    `Example shape (a config task, then one red/green pair for an endpoint):`,
    ``,
    `   - [ ] T001 Set up vitest with a test script in package.json`,
    `     - kind: config`,
    `     - touches-config: adds test runner`,
    `     - no test: scaffolding only`,
    `   - [ ] T002 Write failing integration test for POST /login in tests/login.test.ts (depends on T001)`,
    `     - tdd: red`,
    `     - level: integration`,
    `     - wired by: T003`,
    `     - exercise the real HTTP entry point with supertest: 200 + { token } on valid credentials, 401 on bad password`,
    `     - (a stub src/routes/login.ts that throws 'not implemented' is fine here; T003 wires it)`,
    `   - [ ] T003 Implement POST /login handler in src/routes/login.ts and mount it in src/app.ts (depends on T002)`,
    `     - tests: T002`,
    `     - risk: high`,
    `   - [ ] T004 Create LoginForm component in src/components/LoginForm.tsx (depends on T003)`,
    `     - wired by: T005`,
    `     - no test: presentational; covered by the page e2e in T006`,
    `   - [ ] T005 Render LoginForm on app/login/page.tsx (depends on T004)`,
    `     - no test: page composition; covered by T006`,
    `   - [ ] T006 Add e2e test for the login journey in e2e/login.spec.ts (depends on T005)`,
    `     - level: e2e`,
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
    `The Write tool result is your only deliverable. Stdout commentary is ignored by the orchestrator. Do not wrap the task list in markdown code fences. Do not add a preamble or trailing prose inside the file — ${firstLineRule} Never write a refusal, a question, or a clarification request as the file contents — make the call and produce the task list.`,
  ].join('\n');
}

/**
 * `## Product context` — the brief inlined (capped by `extractProductContext`)
 * plus the rules that keep a plan consistent with it. With `round` set
 * (evolve), the round-selection rules and the header requirement are added:
 * the orchestrator parses `<!-- fullauto:round=<r> items=… -->` to record
 * which backlog ids the round covers.
 */
export function productContextSection(pc: PlannerProductContext): string[] {
  const lines = [
    `## Product context`,
    ``,
    `The project has a product brief at ${pc.productPath} — the source of truth for who the product is for, what is in scope, and what was already decided. The relevant parts are inlined below; read the full file only if you need a section that was clipped.`,
    ``,
    pc.context,
    ``,
    `Rules for staying consistent with the brief:`,
    `- Every task must serve the brief's target users and core value and respect its Principles & constraints — non-goals are off-limits.`,
    `- Prefer Backlog items over inventing new scope; keep Decisions as they are (do not re-decide the stack, auth model, persistence or hosting).`,
    `- Group the tasks of each backlog item under \`## Feature: <F00x> <feature title>\` (e.g. \`## Feature: F003 Share a note by link\`) so the run reports and the assessor can map tasks back to features.`,
  ];
  if (pc.round !== undefined) {
    const max = pc.maxTasks ?? 12;
    lines.push(
      ``,
      `### Round ${pc.round} selection rules (evolve mode)`,
      `- This is round ${pc.round} of an autonomous product-evolution loop. Walk the Backlog in order and select items until the next one would push the round past ${max} tasks in total. Select at least one item.`,
      `- Skip items whose Feature map status is \`done\` or \`rejected\`; a \`deferred\` item may be re-selected when its blocker is gone (say so in a sub-bullet).`,
      `- Every selected item must be FULLY usable when its tasks finish: UI (when the product has one) + logic + wiring + tests + empty / loading / error states. No half-features — if an item does not fit whole, take fewer items, never a slice of one.`,
      `- Write the round header as the FIRST line of the file, listing exactly the selected ids:`,
      ``,
      `   <!-- fullauto:round=${pc.round} items=F001,F004 -->`,
      ``,
      `- Depth before breadth: polish and harden what exists (the items the assessor marked \`next\`, P1 fixes) before adding new surface.`
    );
  }
  return lines;
}

export async function runPlanner(opts: PlannerOptions): Promise<PlannerResult> {
  const { description, projectDir, outputPath, timeoutSec = 900, mcpConfigPath, onOutput } =
    opts;
  await mkdir(dirname(outputPath), { recursive: true });
  const prompt = buildPlannerPrompt(description, outputPath, opts.productContext);
  const res = await spawnClaudeWithBackoff(
    {
      prompt,
      projectDir,
      timeoutSec,
      mcpConfigPath,
      onOutput,
      logPath: opts.logPath,
      logHeader: opts.logPath ? [`# Planner transcript → ${outputPath}`] : undefined,
    },
    DEFAULT_RATE_LIMIT_BACKOFF,
    opts.onRateLimit
  );
  return { outputPath, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs };
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
