import { z } from 'zod';
import type {
  AuditCheck,
  AuditResult,
  PendingWiring,
  RedTestRecord,
  TaskClassification,
  TestCounts,
  VerifyDepth,
} from './audit/types.js';

export const TaskStatus = z.enum([
  'pending',
  'in_progress',
  'done',
  'deferred',
  'failed',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const DeferReason = z.enum([
  'verify_loop_blocks_remaining',
  'gate_failed',
  'subagent_error',
  'depends_on_unfinished_task',
  'unknown',
  /** Post-task deterministic audit (src/audit) raised at least one BLOCK. */
  'audit_failed',
  /**
   * A TDD red task's test gate PASSED. Red tasks must leave failing tests
   * behind (that is the whole point of the phase); a green gate means the
   * tests do not exercise unimplemented behavior, so the task is retried
   * with that hint rather than recorded as a bogus red set.
   */
  'tdd_red_expected',
  /**
   * The subagent spawn kept failing with a rate-limit / usage-cap signal
   * (src/runner/rate-limit.ts) through every backoff retry up to
   * `rateLimitMaxRetries`. Distinguished from `subagent_error` so the final
   * report and a human skimming deferred tasks can tell "genuinely broke"
   * from "API was saturated, try again later" apart at a glance.
   */
  'rate_limited',
]);
export type DeferReason = z.infer<typeof DeferReason>;

/**
 * What a gate is FOR. The orchestrator needs to know which gate is the test
 * runner so it can (a) quarantine expected-failing TDD red tests and (b)
 * parse test counts from its output. Explicit `role` on the gate config
 * wins; otherwise `inferGateRole` guesses from the gate name.
 */
export const GateRole = z.enum(['typecheck', 'test', 'lint', 'build', 'e2e', 'other']);
export type GateRole = z.infer<typeof GateRole>;

/**
 * Guess a gate's role from its explicit `role` field, falling back to the
 * name. Order matters: `e2e` is checked before `test` because e2e gates are
 * commonly named `e2e-test` / `playwright-tests`, and `typecheck` is checked
 * after `test` only via the `type|tsc` tokens which never collide with
 * test-runner names.
 */
export function inferGateRole(gate: { name: string; role?: GateRole | undefined }): GateRole {
  if (gate.role) return gate.role;
  const n = gate.name.toLowerCase();
  if (/e2e|playwright|cypress/.test(n)) return 'e2e';
  if (/test|spec|vitest|jest|pytest/.test(n)) return 'test';
  if (/type|tsc/.test(n)) return 'typecheck';
  if (/lint|eslint|ruff|clippy|vet/.test(n)) return 'lint';
  if (/build/.test(n)) return 'build';
  return 'other';
}

export const GateResult = z.object({
  name: z.string(),
  /**
   * Raw verdict of the command (exit 0). Deliberately NOT rewritten when a
   * failure is quarantined — `evaluateGates` in runner/gates.ts computes the
   * effective verdict and records the reasoning in `note`, so state.json
   * keeps the truth of what the command actually did.
   */
  passed: z.boolean(),
  command: z.string(),
  exitCode: z.number(),
  output: z.string(),
  durationMs: z.number(),
  /** Stamped by `runGates` so downstream consumers don't re-infer from name. */
  role: GateRole.optional(),
  /** True when a `skipIf` probe short-circuited the gate (output is a stub). */
  skipped: z.boolean().optional(),
  /**
   * Human-readable annotation added by `evaluateGates` — e.g. "quarantined
   * red tests: tests/login.test.ts" or "expected failure (TDD red)". Present
   * only when the effective verdict differs from `passed`.
   */
  note: z.string().optional(),
});
export type GateResult = z.infer<typeof GateResult>;

// ---------- audit / TDD shapes persisted in state.json ----------
//
// The canonical TS interfaces live in src/audit/types.ts (the shared
// contract). These zod mirrors exist ONLY so state.json round-trips through
// RunState.parse. Enum-like string fields use z.custom<string-union> rather
// than z.enum on purpose: if the audit layer grows a new check name or test
// runner, an older orchestrator must still LOAD the state file rather than
// crash with "schema mismatch" — the unknown value is harmless to every
// consumer here (reporter only prints it).

const AuditCheckSchema = z.custom<AuditCheck>((v) => typeof v === 'string');

export const TestCountsSchema: z.ZodType<TestCounts> = z.object({
  runner: z.custom<TestCounts['runner']>((v) => typeof v === 'string'),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  failingFiles: z.array(z.string()),
});

export const AuditFindingSchema = z.object({
  check: AuditCheckSchema,
  severity: z.enum(['block', 'warn', 'info']),
  message: z.string(),
  path: z.string().optional(),
  line: z.number().optional(),
});

export const AuditResultSchema: z.ZodType<AuditResult> = z.object({
  findings: z.array(AuditFindingSchema),
  blocked: z.boolean(),
  testCounts: TestCountsSchema.optional(),
  changed: z.object({
    added: z.number(),
    modified: z.number(),
    deleted: z.number(),
  }),
});

export const TaskClassificationSchema: z.ZodType<TaskClassification> = z.object({
  kind: z.enum(['impl', 'test', 'config', 'docs', 'enhance']),
  risk: z.enum(['low', 'medium', 'high']),
  tdd: z.enum(['red', 'green', 'none']),
  redTaskIds: z.array(z.string()),
  greenTaskIds: z.array(z.string()),
  allowsConfigChange: z.boolean(),
  allowsTestEdits: z.boolean(),
  wiredBy: z.string().optional(),
  testsDelegatedTo: z.string().optional(),
  noTestReason: z.string().optional(),
  rationale: z.array(z.string()),
});

export const VerifyDepthSchema: z.ZodType<VerifyDepth> = z.enum(['gates', 'light', 'full']);

const FileFingerprintSchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number(),
  status: z.string().optional(),
});

export const RedTestRecordSchema: z.ZodType<RedTestRecord> = z.object({
  taskId: z.string(),
  files: z.array(FileFingerprintSchema),
  failing: z.number(),
  recordedAt: z.string(),
});

export const PendingWiringSchema: z.ZodType<PendingWiring> = z.object({
  artifactPath: z.string(),
  createdBy: z.string(),
  wiredBy: z.string(),
});

/**
 * A file this task changed in an earlier attempt, with its PRE-TASK identity.
 * Persisted so a retried attempt is audited against the task's original
 * baseline instead of against the previous attempt's leftovers: without it,
 * an orphan / `.skip` / tampered gate config that the retry simply does not
 * touch would vanish from the diff and pass. `beforeHash` is only set when
 * the file was already dirty before the task's first attempt (otherwise the
 * pre-task content is what HEAD holds). `beforeContent` is kept for test /
 * gate-config files only, capped, so the integrity checks can still diff
 * text on the retry.
 */
export const TouchedFile = z.object({
  path: z.string(),
  beforeHash: z.string().optional(),
  beforeSize: z.number().optional(),
  beforeStatus: z.string().optional(),
  beforeContent: z.string().optional(),
});
export type TouchedFile = z.infer<typeof TouchedFile>;

/** Per-attempt TDD evidence: which phase ran and what the test gate showed. */
export const TddAttemptInfo = z.object({
  phase: z.enum(['red', 'green', 'none']),
  /** Failing test count observed (red: expected > 0). */
  failing: z.number().optional(),
  /** Passing test count observed (green / single-task: expected > baseline). */
  passed: z.number().optional(),
});
export type TddAttemptInfo = z.infer<typeof TddAttemptInfo>;

export const AttemptBaseline = z.object({
  headSha: z.string().nullable(),
  dirty: z.array(FileFingerprintSchema),
  /**
   * Tree object of the working tree captured before the subagent ran
   * (see src/rollback.ts). What a deferred attempt is rolled back to;
   * absent when `rollbackOnDefer` is off or the tree is not a git repo.
   */
  treeSha: z.string().optional(),
});
export type AttemptBaseline = z.infer<typeof AttemptBaseline>;

/** What rollback-on-defer did to the working tree after a deferred attempt. */
export const RollbackInfo = z.object({
  /** `.fullauto/logs/<id>-attempt<n>.patch` — the attempt's diff, for the retry to re-apply. */
  patchPath: z.string().optional(),
  /** Paths that differed from the pre-task tree. */
  files: z.number().int().nonnegative(),
  /** Restored from the baseline tree (modified / deleted by the attempt). */
  restored: z.number().int().nonnegative(),
  /** Created by the attempt and removed. */
  deleted: z.number().int().nonnegative(),
  /**
   * Paths that SHOULD have been restored but weren't (e.g. permission
   * denied) — see `RollbackResult.failed` in src/rollback.ts. Non-zero means
   * this is only a PARTIAL rollback: the tree still carries some of the
   * deferred attempt's damage into the next task. `.default(0)` so old
   * state.json files (written before this field existed) still load.
   */
  failed: z.number().int().nonnegative().default(0),
});
export type RollbackInfo = z.infer<typeof RollbackInfo>;

export const EnhanceAttemptInfo = z.object({
  applied: z.number().int().nonnegative(),
  optional: z.number().int().nonnegative(),
  promote: z.array(z.string()).default([]),
});
export type EnhanceAttemptInfo = z.infer<typeof EnhanceAttemptInfo>;

export const TaskAttempt = z.object({
  passNumber: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  subagentExitCode: z.number().optional(),
  subagentLogPath: z.string().optional(),
  gateResults: z.array(GateResult).default([]),
  deferReason: DeferReason.optional(),
  deferDetail: z.string().optional(),
  /** How the orchestrator classified the task for this attempt (see task-class.ts). */
  classification: TaskClassificationSchema.optional(),
  /** Verification depth handed to the implementer (gates | light | full). */
  verifyDepth: VerifyDepthSchema.optional(),
  /** Post-task deterministic audit result (findings + counts). */
  audit: AuditResultSchema.optional(),
  tdd: TddAttemptInfo.optional(),
  /**
   * Cumulative list of files this task has changed across ALL its attempts
   * so far (see `TouchedFile`). Only recorded on deferred attempts — a task
   * that reached `done` is never retried, so its list has no consumer.
   */
  touched: z.array(TouchedFile).optional(),
  /**
   * Pre-task tree identity (HEAD + dirty-file fingerprints, no contents),
   * persisted BEFORE the subagent spawns. A crash mid-subagent leaves an
   * attempt with a baseline and no `finishedAt`; the retry diffs that
   * baseline against the tree so whatever the crashed attempt left behind
   * (an orphan, a `.skip`, an edited gate config) is still in its diff.
   */
  baseline: AttemptBaseline.optional(),
  /** What an enhance pass reported (`FULLAUTO_ENHANCE:` line) — budget accounting + promote ids for /product-assess. */
  enhance: EnhanceAttemptInfo.optional(),
  /** Set on a deferred attempt whose working-tree changes were rolled back (config `rollbackOnDefer`). */
  rollback: RollbackInfo.optional(),
});
export type TaskAttempt = z.infer<typeof TaskAttempt>;

/**
 * `user` = parsed from tasks.md (or written by planner).
 * `enhance` = synthetic /vibe-enhance pass injected after a feature group.
 * `verify` = synthetic `VERIFY-<feature>` task injected after a feature
 *            group when `verifyMode === 'feature'`: per-task verification
 *            drops to gates-only and one full /verify-loop runs over the
 *            group's combined diff instead.
 */
export const TaskKind = z.enum(['user', 'enhance', 'verify']);
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
  /**
   * Set by `fullauto retry` / `resume --retry-failed` (src/run-flow.ts
   * `requeueFailedTasks`) to `attempts.length` at the moment a failed task
   * is re-queued. `orchestrator.ts`'s `originalHeadSha` / `resolvePriorTouched`
   * treat this as a boundary: attempts BEFORE it are history only (kept for
   * the report) and never consulted as the "original" baseline for the
   * tree-diff audit. Without this, a `retry` invoked in a SEPARATE, LATER
   * process (after the user fixed the failure cause and committed the fix)
   * would keep comparing against the pre-fix baseline from the original
   * failed run, and the audit would BLOCK the retry on the user's own fix as
   * if this attempt had made the change. Absent (undefined) for a task that
   * was never retried this way — a same-process pass-to-pass retry (normal
   * `resume` after a crash) must keep using the task's true first-attempt
   * baseline, which is why this is a distinct field rather than reusing
   * `attempts.length` implicitly.
   */
  baselineResetAtAttempt: z.number().int().nonnegative().optional(),
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
  /** Per-gate timeout override in seconds; default 1800 (30 min). */
  timeoutSec: z.number().int().positive().optional(),
  /**
   * What this gate checks. Only `test` (and `e2e`) change orchestrator
   * behavior: their failures can be quarantined for TDD red sets and their
   * output is parsed for test counts. Omit to infer from the name.
   */
  role: GateRole.optional(),
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
  /**
   * Per-request timeout in seconds (default: 60).
   *
   * Default raised from 15 → 60 under accuracy > speed: cold-start
   * serverless (Vercel/Cloudflare Workers, ~5–15s), Next.js dev first-hit
   * compile (often 30s+), and Spring/Rails initial routing scan all
   * routinely exceed 15s. A timeout here defers the task — pure accuracy
   * loss for a budget that costs nothing on healthy services.
   */
  timeoutSec: z.number().int().positive().default(60),
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
  /**
   * Per-call timeout in seconds (default: 60).
   *
   * Default raised from 30 → 60 under accuracy > speed: Convex actions can
   * legitimately run up to 60s on the platform side (queries/mutations are
   * capped lower at ~10s server-side). A 30s default forced action gates
   * to defer at the halfway point, then the next pass timed out the same
   * way — pure waste with no signal. 60s matches the HttpGate default and
   * the platform's own action ceiling, so a timeout here means a real
   * platform-level failure rather than a client-side budget shortfall.
   */
  timeoutSec: z.number().int().positive().default(60),
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

export const VerifyMode = z.enum(['adaptive', 'full', 'gates-only', 'feature']);
export type VerifyMode = z.infer<typeof VerifyMode>;
export const VERIFY_MODES = VerifyMode.options;

/**
 * Per-check toggles for the deterministic post-task audit. Everything is on
 * by default — each check is cheap (git status + grep) and the whole point
 * of the layer is that it cannot be argued with. Turn a check off only when
 * the project structurally can't satisfy it (e.g. `orphanCheck: false` in a
 * plugin-style repo where modules are discovered by filename).
 */
export const AuditConfig = z.object({
  enabled: z.boolean().default(true),
  orphanCheck: z.boolean().default(true),
  unusedExportCheck: z.boolean().default(true),
  wiringManifest: z.boolean().default(true),
  testIntegrity: z.boolean().default(true),
  gateIntegrity: z.boolean().default(true),
  testCount: z.boolean().default(true),
  tdd: z.boolean().default(true),
});
export type AuditConfig = z.infer<typeof AuditConfig>;

export const RunConfig = z.object({
  /**
   * Max passes through the queue before escalating to user (default: 4).
   *
   * Each pass re-attempts whatever's still deferred. The orchestrator
   * also exits early via `noProgressInCurrentPass` when a pass starts
   * and ends with the same unresolved set, so this value caps the
   * convergence budget without forcing wasted work — `4` covers up to
   * three-level dependency-chain retries plus one stochastic-flake retry.
   * Default raised from 3 → 4 under the accuracy > speed > cost priority:
   * the no-progress guard makes the extra pass nearly free when nothing's
   * converging, and gives an extra retry to deeper dep chains that ARE
   * converging slowly.
   *
   * That "nearly free" reasoning is whole-run: it does not by itself cover
   * a single task stuck while every OTHER task keeps converging, since
   * `noProgressInCurrentPass` only compares the pass-wide unresolved set —
   * a stuck task would otherwise ride along for a full-cost subagent spawn
   * every remaining pass. `queue.ts`'s `stuckOnIdenticalGateFailure` covers
   * exactly that gap: once a task's last two attempts fail the SAME gate
   * with byte-identical output, `next()` stops offering it a further
   * attempt (it still ends up `failed` at the same point it otherwise
   * would have) rather than spending `maxPasses` on an outcome the last
   * two real attempts already proved will not change. This does not
   * shrink `maxPasses` itself — it only skips attempts that would be
   * provably identical in cost and outcome to one already made.
   */
  maxPasses: z.number().int().positive().default(4),
  /**
   * Per-task subagent timeout in seconds (default: 3600 = 60min).
   *
   * Default raised from 1800 (30min) under the accuracy > speed > cost
   * priority: a high-risk task at `full` depth (implementation + up to
   * `verifyMaxCycles` review cycles of four reviewer subagents + gates)
   * routinely approaches 30min, and timeout-defer means the next pass
   * starts from scratch — pure waste. 60min lets harder tasks finish on
   * the first attempt rather than churn across passes.
   */
  subagentTimeoutSec: z.number().int().positive().default(3600),
  /**
   * Planner subagent timeout in seconds (default: 900 = 15min).
   *
   * The planner explores the project and writes the task list. Generous
   * default because for large repos the project-vibe scan can take a few
   * minutes before any task is emitted. CLI flag (`--plan-timeout` /
   * `--timeout`) overrides this when set.
   */
  plannerTimeoutSec: z.number().int().positive().default(900),
  /**
   * Timeout for `fullauto evolve`'s shape and assess stages, in seconds.
   * Unset (default) derives from `plannerTimeoutSec`: `max(plannerTimeoutSec
   * * 2, 1800)` — see `resolveEvolveStageTimeoutSec` in run-flow.ts. These
   * two stages are NOT plain task-decomposition planning: `/product-shape`
   * benchmarks peers over WebSearch, and `/product-assess` reads
   * state.json + tasks.md + the changed code and scores five dimensions
   * before rewriting product.md — both routinely need more wall-clock than
   * the plain planner call `plannerTimeoutSec` was tuned for. Discovered
   * live: an evolve run using the shared `plannerTimeoutSec` timed out the
   * assess stage on both of its two attempts (real subagent behavior, not
   * hypothetical — see the `EvolveAbort` message in `assessStage`), which
   * burns a whole `claude -p` invocation per attempt on a GUARANTEED
   * timeout — real cost, not just wasted time. The plan stage keeps using
   * `plannerTimeoutSec` directly; it stays close in shape to the ordinary
   * planner. Set this explicitly to override the derived default (e.g. a
   * very large product.md that makes even the derived default too tight).
   */
  evolveStageTimeoutSec: z.number().int().positive().optional(),
  /**
   * Whether to instruct the implementer subagent to invoke /verify-loop.
   * Kept for back-compat; `false` is treated as `verifyMode: 'gates-only'`
   * (see `effectiveVerifyMode` in task-class.ts).
   */
  useVerifyLoop: z.boolean().default(true),
  /**
   * How much LLM review each task gets on top of the deterministic gates +
   * audit. `adaptive` (default) picks per task from its classification:
   * config/docs/test/low-risk → gates only; medium → light (2 reviewers);
   * high risk (auth/payments/schema/…) → full (4 reviewers); synthetic
   * enhance/verify passes → light. `full` forces
   * full on every task (old behavior, most expensive). `gates-only` never
   * invokes /verify-loop. `feature` runs gates-only per task and one full
   * /verify-loop over the combined diff when a feature group completes.
   */
  verifyMode: VerifyMode.default('adaptive'),
  /**
   * Max /verify-loop cycles per task (default: 2). Was hardcoded to 3 in the
   * skill; 2 keeps the fix→re-review budget bounded now that the audit
   * catches the deterministic failure modes before reviewers see the diff.
   */
  verifyMaxCycles: z.number().int().positive().default(2),
  /** Per-check toggles for the post-task deterministic audit (src/audit). */
  audit: AuditConfig.default({}),
  /**
   * When a task is deferred for ANY reason (gate failure, audit BLOCK, DEFER
   * marker, subagent error / timeout), restore every path it touched to the
   * pre-task tree and save its diff as `.fullauto/logs/<id>-attempt<n>.patch`
   * for the retry to re-apply. Default on: without it one broken task's
   * damage fails every later task's gates through no fault of their own.
   * Needs a git work tree (skipped with one warning otherwise).
   */
  rollbackOnDefer: z.boolean().default(true),
  /**
   * Whether `resume` (and `retry` / `auto` resuming existing state) also
   * rolls back a crashed / signal-interrupted attempt's tree changes before
   * re-queuing it — the same treatment `rollbackOnDefer` gives an ordinary
   * deferred attempt (see cli.ts `resetInterrupted`). Optional so it can
   * mirror `rollbackOnDefer` by default (undefined) while still letting a
   * user disable JUST this resume-time rollback (keep defer-rollback, but
   * inspect a crash by hand) without touching `rollbackOnDefer` itself.
   */
  rollbackOnResume: z.boolean().optional(),
  /**
   * If true, the orchestrator injects a synthetic `enhance` task after each
   * feature group's user tasks complete. That task spawns a Claude subagent
   * which invokes the /vibe-enhance skill — a fresh researcher subagent
   * compares the just-completed work against latest trends and applies any
   * scoped FIT-BREAK / ENHANCE additions, then routes them through
   * /verify-loop. Failed enhance tasks defer like any other task.
   *
   * No h2 headings in tasks.md = one implicit feature spanning the whole run,
   * so this gives a single end-of-run pass for the auto-mode case where the
   * planner doesn't write headings.
   */
  vibeEnhance: z.boolean().default(false),
  /**
   * How many additions ALL the run's /vibe-enhance passes may apply in
   * total (default 3). Each pass is told the remaining budget; the skill
   * reports `FULLAUTO_ENHANCE: applied=<n> …` and the orchestrator
   * decrements. Bounds scope creep on long unattended runs.
   */
  enhanceBudget: z.number().int().nonnegative().default(3),
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
  /**
   * Backoff before the FIRST retry of a `claude -p` spawn that failed with a
   * rate-limit / usage-cap signal (src/runner/rate-limit.ts). Doubles each
   * consecutive hit, capped at `rateLimitMaxBackoffSec`. A plain number (not
   * int-only) so tests can drive it in milliseconds-scale fractions of a
   * second instead of waiting out real backoff windows.
   */
  rateLimitBaseBackoffSec: z.number().positive().default(30),
  /**
   * Ceiling on any single rate-limit backoff wait (default 900 = 15min).
   * Without a cap, exponential growth from `rateLimitBaseBackoffSec` would
   * make a long-saturated API push a single retry out to hours.
   */
  rateLimitMaxBackoffSec: z.number().positive().default(900),
  /**
   * Consecutive rate-limit hits a single subagent spawn will back off and
   * retry (WITHIN the same task attempt / pass — see runner/claude.ts
   * `spawnClaudeWithBackoff`) before giving up and deferring the task with
   * `DeferReason: 'rate_limited'`. At the default backoff schedule this is
   * roughly 1.5h of patient waiting before a still-saturated API defers to
   * the next pass, rather than an unattended run hanging forever on one task.
   * When the CLI's error names an exact reset time (`resetHintSleepMs` in
   * runner/rate-limit.ts, e.g. "resets 5:50pm (Asia/Seoul)"), a retry sleeps
   * close to that reset instead of the blind exponential schedule — capped
   * at 6h so a misparsed clock time cannot turn one retry into most of a
   * day — which can make an individual wait longer than the ~1.5h figure
   * above but avoids the many blind, wastefully-spaced retries that figure
   * otherwise implies for a session hit early in a long reset window.
   */
  rateLimitMaxRetries: z.number().int().nonnegative().default(10),
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
  /**
   * When the user's `/fullauto` invocation actually started. For `auto`
   * mode this is captured BEFORE planning — so the final report's "total
   * elapsed" reflects plan + run, not just run. For `run` mode (no plan
   * stage) this equals `startedAt`. Optional for back-compat with state
   * files written before this field existed.
   */
  commandStartedAt: z.string().optional(),
  /** ISO time the planner subagent started (auto mode only). */
  planStartedAt: z.string().optional(),
  /** ISO time the planner subagent finished (auto mode only). */
  planFinishedAt: z.string().optional(),
  /**
   * Test counts parsed from the test gate of the last SUCCESSFUL task. The
   * audit's test-count check compares each task against this so a task
   * that deletes tests (passed count drops) or an impl task that adds none
   * (passed count flat) is caught deterministically.
   */
  testBaseline: TestCountsSchema.optional(),
  /**
   * TDD red sets currently quarantined: tests written by a red task that
   * are EXPECTED to fail until the paired green task lands. The test gate
   * treats failures confined to these files as pass-with-quarantine for
   * every other task. Entries are removed when their green task succeeds;
   * anything left at run end is reported as "never turned green".
   */
  redTests: z.array(RedTestRecordSchema).default([]),
  /**
   * Artifacts created by task A whose wiring was promised by task B
   * (`- wired by: B`). The audit re-checks each one when B runs and BLOCKS
   * B if the artifact is still unreferenced.
   */
  pendingWiring: z.array(PendingWiringSchema).default([]),
  /** Remaining vibe-enhance additions for this run; initialized from `config.enhanceBudget` by the orchestrator. */
  enhanceBudgetRemaining: z.number().int().nonnegative().optional(),
  /**
   * sha1 of `.fullauto/config.json` and the MCP config at run start. Both
   * files are gitignored, so the tree-diff audit cannot see a subagent
   * editing them; the orchestrator re-hashes after every task instead and
   * BLOCKs the task on a change (config: restored from the snapshot below).
   */
  configFingerprints: z
    .object({
      configJson: z.string().optional(),
      mcpJson: z.string().optional(),
    })
    .optional(),
  /** Run-start preflight warnings (e.g. "no test gate would run") repeated in the final report. */
  preflightWarnings: z.array(z.string()).default([]),
  /**
   * Passes granted by `fullauto retry` on top of `config.maxPasses`. Kept in
   * state (not in the config snapshot) so a later resume, which re-adopts
   * the live config.json, does not silently take the extra pass away.
   */
  extraPasses: z.number().int().nonnegative().default(0),
  /**
   * Run-wide rate-limit accounting (src/runner/rate-limit.ts): every
   * backoff-and-retry cycle any subagent spawn went through, summed across
   * the whole run. Surfaced in the final report as "rate-limited N time(s),
   * waited Ts total" so a long unattended run's time isn't silently spent
   * waiting out the API without the user knowing why it took so long.
   */
  rateLimitHits: z.number().int().nonnegative().default(0),
  rateLimitWaitMs: z.number().int().nonnegative().default(0),
});
export type RunState = z.infer<typeof RunState>;
