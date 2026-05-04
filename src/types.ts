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

export const Task = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  dependencies: z.array(z.string()).default([]),
  status: TaskStatus.default('pending'),
  attempts: z.array(TaskAttempt).default([]),
});
export type Task = z.infer<typeof Task>;

export const RunConfig = z.object({
  /** Max passes through the queue before escalating to user (default: 2). */
  maxPasses: z.number().int().positive().default(2),
  /** Per-task subagent timeout in seconds (default: 1800 = 30min). */
  subagentTimeoutSec: z.number().int().positive().default(1800),
  /** Whether to instruct the implementer subagent to invoke /review-loop. */
  useReviewLoop: z.boolean().default(true),
  /** Verification gates run after each task. */
  gates: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        /** Optional working dir override (defaults to project root). */
        cwd: z.string().optional(),
        /** Skip gate if this command fails (e.g. detect missing tsconfig). */
        skipIf: z.string().optional(),
      })
    )
    .default([]),
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
