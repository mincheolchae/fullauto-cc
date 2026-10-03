import { RunConfig, RunState, Task } from '../../src/types.js';
import type { TaskAttempt, TaskStatus } from '../../src/types.js';

/**
 * Build a Task through the zod schema so every field the orchestrator
 * expects (attempts, kind, status defaults) is populated even when other
 * workstreams add new defaulted fields.
 */
export function makeTask(
  id: string,
  overrides: Partial<{
    title: string;
    body: string;
    dependencies: string[];
    status: TaskStatus;
    attempts: TaskAttempt[];
    feature: string | undefined;
    kind: 'user' | 'enhance';
    /** `fullauto retry`'s baseline-reset boundary (src/run-flow.ts requeueFailedTasks). */
    baselineResetAtAttempt: number;
  }> = {}
): Task {
  return Task.parse({
    id,
    title: overrides.title ?? `Task ${id}`,
    body: overrides.body ?? overrides.title ?? `Task ${id}`,
    dependencies: overrides.dependencies ?? [],
    status: overrides.status ?? 'pending',
    attempts: overrides.attempts ?? [],
    feature: overrides.feature,
    kind: overrides.kind ?? 'user',
    baselineResetAtAttempt: overrides.baselineResetAtAttempt,
  });
}

export function makeAttempt(
  passNumber: number,
  overrides: Partial<TaskAttempt> = {}
): TaskAttempt {
  return {
    passNumber,
    startedAt: new Date().toISOString(),
    gateResults: [],
    ...overrides,
  };
}

/** Parse a RunConfig from a loose object (unknown keys are stripped by zod). */
export function makeConfig(overrides: Record<string, unknown> = {}): RunConfig {
  return RunConfig.parse({
    maxPasses: 2,
    subagentTimeoutSec: 60,
    useVerifyLoop: false,
    // Fixtures use gates with one-shot side effects (fail once, then pass); a baseline run would consume them.
    baselineCheck: 'off',
    gates: [{ name: 'ok', command: 'true' }],
    // Deterministic post-task audit (workstream A1/A2). Unknown to older
    // schemas — zod strips it, so this is harmless until the key lands.
    audit: { enabled: false },
    ...overrides,
  });
}

/** Build a RunState through the schema so defaulted fields are present. */
export function makeState(
  tasks: Task[],
  overrides: Partial<{
    currentPass: number;
    config: RunConfig;
    passSnapshots: { pass: number; unresolvedIds: string[] }[];
    commandStartedAt: string;
    startedAt: string;
  }> = {}
): RunState {
  const startedAt = overrides.startedAt ?? new Date().toISOString();
  return RunState.parse({
    startedAt,
    currentPass: overrides.currentPass ?? 1,
    tasks,
    config: overrides.config ?? makeConfig(),
    passSnapshots: overrides.passSnapshots ?? [],
    placeholderEnvs: [],
    commandStartedAt: overrides.commandStartedAt ?? startedAt,
  });
}
