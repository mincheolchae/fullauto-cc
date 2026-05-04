import { z } from 'zod';

export const TaskStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'deferred',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const DeferReason = z.enum([
  'review_loop_blocks_remaining',
  'gate_failed',
  'subagent_error',
  'depends_on_unfinished_task',
  'unknown',
]);
export type DeferReason = z.infer<typeof DeferReason>;

export const GateResult = z.object({
  name: z.string(),
  passed: z.boolean(),
  command: z.string(),
  exitCode: z.number(),
  output: z.string(),
  durationMs: z.number(),
});
export type GateResult = z.infer<typeof GateResult>;

export const TaskAttempt = z.object({
  passNumber: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  subagentExitCode: z.number().optional(),
  subagentLogPath: z.string().optional(),
  gateResults: z.array(GateResult).default([]),
  deferReason: DeferReason.optional(),
  deferDetail: z.string().optional(),
});
export type TaskAttempt = z.infer<typeof TaskAttempt>;

export const TaskKind = z.enum(['user', 'enhance']);
export type TaskKind = z.infer<typeof TaskKind>;

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  dependencies: z.array(z.string()).default([]),
  status: TaskStatus.default('pending'),
  attempts: z.array(TaskAttempt).default([]),
  /**
   * Feature group key. Source depends on tasks.md format (auto-detected by
   * the parser):
   *   - Speckit format (any task line carries a `[USx]` label) → feature is
   *     the story id, e.g. `"US1"`. Tasks without a label (Setup /
   *     Foundational / Polish phases) get `feature: undefined`.
   *   - Hand-written format (no `[USx]` labels anywhere) → feature is the
   *     most recent `## ` h2 heading text.
   * Tasks with `feature: undefined` form one implicit group; vibe-enhance
   * fires once for that group at the end.
   */
  feature: z.string().optional(),
  /**
   * `user` = parsed from tasks.md (or written by planner). `enhance` =
   * synthetic task injected by the orchestrator to run a /vibe-enhance pass
   * after a feature group completes. Distinguished so the runner can use a
   * different prompt and reports can label them.
   */
  kind: TaskKind.default('user'),
});
export type Task = z.infer<typeof Task>;

/**
 * A long-running background process the orchestrator boots before the first
 * task and tears down at run end (e.g. `npx convex dev`, `next dev`, an
 * iOS simulator). Gates can probe these services via http / convex-fn.
 */
export const ServiceDef = z.object({
  name: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  /** Extra env vars to merge on top of process.env for THIS service only. */
  env: z.record(z.string()).optional(),
  /**
   * Shell command that exits 0 when the service is ready. Polled every 1s
   * until it succeeds or readyTimeoutSec elapses (after which startup fails).
   * Omit to mark "ready immediately after spawn" (rare).
   */
  readyProbe: z.string().optional(),
  readyTimeoutSec: z.number().int().positive().default(60),
  /** Optional explicit cleanup command. If absent, SIGTERM is sent. */
  shutdownCommand: z.string().optional(),
  /**
   * After ready, parse these dotenv-style files and merge their values into
   * `process.env` so subsequent gates / subagents see them. `convex dev`
   * writes `CONVEX_URL` to `.env.local` — list it here to surface that var.
   */
  envFiles: z.array(z.string()).default([]),
});
export type ServiceDef = z.infer<typeof ServiceDef>;

const ShellGate = z.object({
  type: z.literal('shell').default('shell'),
  name: z.string(),
  command: z.string(),
  cwd: z.string().optional(),
  skipIf: z.string().optional(),
  /** Per-gate timeout override; default 600s (10 min). */
  timeoutSec: z.number().int().positive().optional(),
});
export type ShellGate = z.infer<typeof ShellGate>;

const HttpGate = z.object({
  type: z.literal('http'),
  name: z.string(),
  /** May contain `${ENV_VAR}` placeholders interpolated from process.env. */
  url: z.string(),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
    .default('GET'),
  headers: z.record(z.string()).default({}),
  body: z.string().optional(),
  /** Default: any 2xx counts as pass. */
  expectStatus: z.union([z.number(), z.array(z.number())]).optional(),
  /** Substring that must appear in the response body for pass. */
  expectBodyContains: z.string().optional(),
  /**
   * Parse the response body as JSON and partial-deep-match against this
   * shape. Same matcher used by `convex-fn` — see `matchShape` in
   * `runner/gates/shared.ts`. JSON parse failure is a gate failure.
   */
  expectJson: z.record(z.unknown()).optional(),
  /**
   * Response headers that must be present (case-insensitive). Each value
   * is a substring match. Useful for `content-type: application/json`,
   * CORS, or `www-authenticate` checks.
   */
  expectHeaders: z.record(z.string()).optional(),
  timeoutSec: z.number().int().positive().default(15),
});
export type HttpGate = z.infer<typeof HttpGate>;

const ConvexFnGate = z.object({
  type: z.literal('convex-fn'),
  name: z.string(),
  /**
   * Function reference in `module:export` (or `module.export`) form, e.g.
   * `users:create` or `notes.list`. Resolved through the project's
   * `convex/browser` ConvexHttpClient.
   */
  fn: z.string(),
  kind: z.enum(['query', 'mutation', 'action']).default('query'),
  args: z.record(z.unknown()).default({}),
  /**
   * Partial deep-match shape against the function's return value. Only
   * supports primitives + nested objects + array `length`. If absent, any
   * non-throwing return counts as pass.
   */
  expect: z
    .object({
      shape: z.record(z.unknown()).optional(),
    })
    .optional(),
  /**
   * Override the deployment URL. Defaults to `process.env.CONVEX_URL`
   * (which `convex dev` writes to `.env.local`).
   */
  url: z.string().optional(),
  timeoutSec: z.number().int().positive().default(30),
});
export type ConvexFnGate = z.infer<typeof ConvexFnGate>;

/**
 * Gate union. `type` is mandatory for new gates but legacy shell gates
 * (no `type` field) parse as ShellGate via the literal default.
 */
export const Gate = z.preprocess(
  (v) => {
    if (typeof v === 'object' && v !== null && !('type' in v)) {
      return { ...v, type: 'shell' };
    }
    return v;
  },
  z.discriminatedUnion('type', [ShellGate, HttpGate, ConvexFnGate])
);
export type Gate = z.infer<typeof Gate>;

export const RunConfig = z.object({
  /** Max passes through the queue before escalating to user (default: 2). */
  maxPasses: z.number().int().positive().default(2),
  /** Per-task subagent timeout in seconds (default: 1800 = 30min). */
  subagentTimeoutSec: z.number().int().positive().default(1800),
  /** Whether to instruct the implementer subagent to invoke /review-loop. */
  useReviewLoop: z.boolean().default(true),
  /**
   * If true, the orchestrator injects a synthetic `enhance` task after each
   * feature group's user tasks complete. That task spawns a Claude subagent
   * which invokes the /vibe-enhance skill — a fresh researcher subagent
   * compares the just-completed work against latest trends and applies any
   * scoped FIT-BREAK / ENHANCE additions, then routes them through
   * /review-loop. Failed enhance tasks defer like any other task.
   *
   * No h2 headings in tasks.md = one implicit feature spanning the whole run,
   * so this gives a single end-of-run pass for the auto-mode case where the
   * planner doesn't write headings.
   */
  vibeEnhance: z.boolean().default(false),
  /**
   * Background services started once at run begin and stopped at run end.
   * Read-after-ready env files (e.g. .env.local) merge into process.env so
   * downstream gates see the right CONVEX_URL etc.
   */
  services: z.array(ServiceDef).default([]),
  /** Verification gates run after each task. */
  gates: z.array(Gate).default([]),
  /**
   * Path (relative to project root) to an MCP config file passed to every
   * implementer subagent via `claude --mcp-config`. Use this to wire in the
   * Convex MCP so the subagent can introspect schema and call functions.
   */
  mcpConfigPath: z.string().optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;

export const RunState = z.object({
  startedAt: z.string(),
  currentPass: z.number().int().nonnegative().default(1),
  tasks: z.array(Task),
  config: RunConfig,
  /** Snapshot of pending+deferred IDs at start of each pass — for no-progress detection. */
  passSnapshots: z
    .array(z.object({ pass: z.number(), unresolvedIds: z.array(z.string()) }))
    .default([]),
  /**
   * Names of env vars that `auto` mode seeded with placeholder values
   * (because the user's shell didn't have them). Subagents see
   * `FULLAUTO_PLACEHOLDER_<NAME>` for each. Surfaced in the final report
   * so the user knows what to replace before going live.
   */
  placeholderEnvs: z.array(z.string()).default([]),
});
export type RunState = z.infer<typeof RunState>;
