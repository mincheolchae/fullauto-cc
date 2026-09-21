/**
 * Shared contracts for the deterministic post-task audit layer.
 *
 * The audit runs in the orchestrator AFTER the implementer subagent exits
 * and AFTER the project gates ran. It is the machine-checkable complement
 * to /verify-loop's LLM review: it cannot be argued with, cannot be
 * prompt-injected, and catches the two failure modes that gates + review
 * structurally miss —
 *   (1) hallucinated integration: a component / module / route was created
 *       but nothing in production code imports, renders, mounts, or calls it
 *       (orphan code that "passes" because nothing exercises it), and
 *   (2) test cheating: gates go green because tests were skipped, weakened,
 *       deleted, tautological, or the gate config itself was edited.
 *
 * Every check is a pure function over a before/after snapshot of the
 * working tree plus the subagent's stdout, so each one is unit-testable
 * with fixtures.
 */

import type { GateResult, Task } from '../types.js';

/** Which class of work a task is — drives verification depth and TDD semantics. */
export type TaskKindClass = 'impl' | 'test' | 'config' | 'docs' | 'enhance';
export type TaskRisk = 'low' | 'medium' | 'high';
/**
 * `red`   — a test-only task whose tests are EXPECTED to fail (no impl yet).
 * `green` — an impl task that must make a prior red task's tests pass.
 * `none`  — no cross-task TDD pairing (single-task TDD is prompt-enforced).
 */
export type TddPhase = 'red' | 'green' | 'none';

export interface TaskClassification {
  kind: TaskKindClass;
  risk: TaskRisk;
  tdd: TddPhase;
  /** For `green`: the red task IDs whose tests this task must turn green. */
  redTaskIds: string[];
  /** For `red`: the impl task IDs that will turn these tests green (informational). */
  greenTaskIds: string[];
  /** Task explicitly allows editing gate/test-runner config (`- touches-config: <why>`). */
  allowsConfigChange: boolean;
  /** Task explicitly allows modifying pre-existing tests (`- modifies-tests: <why>`). */
  allowsTestEdits: boolean;
  /** Task body says a later task wires this artifact in (`- wired by: T###`). */
  wiredBy?: string;
  /** Task body says tests live elsewhere (`- tests: T###` / `- tested by: T###`). */
  testsDelegatedTo?: string;
  /** Task body opted out of tests (`- no test: <reason>`). */
  noTestReason?: string;
  /** Human-readable trail of how kind/risk were decided (marker vs heuristic). */
  rationale: string[];
}

/** Verification depth handed to the implementer subagent / verify-loop. */
export type VerifyDepth = 'gates' | 'light' | 'full';

/** Snapshot of one file's content identity. */
export interface FileFingerprint {
  path: string;
  /** sha1 of content; `size:<n>` for files over the hash limit; `deleted` when the path is gone. */
  hash: string;
  size: number;
  /** Porcelain `XY` status code at snapshot time (`??` untracked, ` M`, ` D`, `A ` ...). Optional; set by `takeSnapshot`. */
  status?: string;
}

/**
 * Working-tree snapshot taken immediately before / after a task. Built from
 * `git status --porcelain -z -uall` (dirty + untracked paths) plus HEAD, so
 * it is cheap even in large repos: only dirty files get hashed.
 */
export interface TreeSnapshot {
  takenAt: string;
  headSha: string | null;
  /** Dirty (modified / added / untracked) paths at snapshot time → fingerprint. */
  dirty: Map<string, FileFingerprint>;
  /**
   * Contents of files that the audit needs to diff textually later (gate
   * config files, test files that were dirty). Capped per file; absent when
   * the file was clean at HEAD (use `git show HEAD:path` instead).
   */
  contents: Map<string, string>;
  /**
   * True when `projectDir` is inside a git work tree. Absent/false ⇒ the
   * audit no-ops with a single INFO finding. Optional; set by `takeSnapshot`.
   */
  gitRepo?: boolean;
}

export type ChangeKind = 'added' | 'modified' | 'deleted';

export interface ChangedFile {
  path: string;
  kind: ChangeKind;
  /** Content before the task (from snapshot or HEAD); undefined for `added`. */
  before?: string;
  /** Content after the task; undefined for `deleted`. */
  after?: string;
  isTest: boolean;
  isCode: boolean;
  isGateConfig: boolean;
}

/** Diff between two snapshots, resolved to file contents. */
export interface TaskDiff {
  files: ChangedFile[];
  /** True when HEAD moved during the task (subagent committed). */
  headMoved: boolean;
}

export type AuditSeverity = 'block' | 'warn' | 'info';

export type AuditCheck =
  | 'orphan-code'
  | 'unused-export'
  | 'wiring-manifest'
  | 'test-integrity'
  | 'gate-integrity'
  | 'test-count'
  | 'tdd-red'
  | 'tdd-green'
  | 'pending-wiring'
  /** `VERIFY_LOOP_RESULT:` evidence vs the verify depth the task was given. */
  | 'verify-evidence'
  /** Audit infrastructure itself (snapshot diff failed, check crashed) — never about the task's code. */
  | 'audit';

export interface AuditFinding {
  check: AuditCheck;
  severity: AuditSeverity;
  /** One-line, actionable — this text is fed back into the next-pass prompt. */
  message: string;
  /** Repo-relative path the finding anchors to, if any. */
  path?: string;
  line?: number;
}

export interface AuditResult {
  findings: AuditFinding[];
  /** True when at least one finding is `block`. */
  blocked: boolean;
  /** Parsed test counts from the test gate output, if a parser recognized it. */
  testCounts?: TestCounts;
  /** Snapshot diff summary for the report. */
  changed: { added: number; modified: number; deleted: number };
}

/** Parsed summary of a test-runner run. */
export interface TestCounts {
  runner: 'vitest' | 'jest' | 'mocha' | 'node-test' | 'pytest' | 'go' | 'cargo' | 'playwright' | 'cypress' | 'unknown';
  passed: number;
  failed: number;
  skipped: number;
  /** Repo-relative test file paths (or go packages / cargo test names) that had failures. */
  failingFiles: string[];
}

/** A red (expected-failing) test set kept in state until its green task lands. */
export interface RedTestRecord {
  taskId: string;
  /** Test files written by the red task, with their hashes at red time. */
  files: FileFingerprint[];
  /** Number of failing tests observed at red time. */
  failing: number;
  recordedAt: string;
}

/** Artifact created by task A whose wiring is promised by task B (`- wired by: B`). */
export interface PendingWiring {
  artifactPath: string;
  createdBy: string;
  wiredBy: string;
}

/** Everything the audit needs — orchestrator assembles this per attempt. */
export interface AuditInput {
  projectDir: string;
  task: Task;
  classification: TaskClassification;
  before: TreeSnapshot;
  after: TreeSnapshot;
  gateResults: GateResult[];
  /** Raw subagent stdout (for FULLAUTO_WIRING / FULLAUTO_TDD / VERIFY_LOOP_RESULT lines). */
  subagentStdout: string;
  /**
   * Verify depth the implementer was told to run (`depthFor`). `light` / `full`
   * make a `VERIFY_LOOP_RESULT:` line mandatory in `subagentStdout`
   * (`verify-evidence` check); undefined ⇒ unknown ⇒ the check is skipped.
   */
  verifyDepth?: VerifyDepth;
  /** Baseline test counts from the last successful task, if any. */
  testBaseline?: TestCounts;
  /** Red test sets currently quarantined (expected failing). */
  redTests: RedTestRecord[];
  /** Wiring promises still open. */
  pendingWiring: PendingWiring[];
  /** Per-check toggles from config. */
  options: AuditOptions;
}

export interface AuditOptions {
  enabled: boolean;
  orphanCheck: boolean;
  unusedExportCheck: boolean;
  wiringManifest: boolean;
  testIntegrity: boolean;
  gateIntegrity: boolean;
  testCount: boolean;
  tdd: boolean;
  /** `verify-evidence` check (VERIFY_LOOP_RESULT line vs required depth). Absent ⇒ enabled. */
  verifyEvidence?: boolean;
}

export const DEFAULT_AUDIT_OPTIONS: AuditOptions = {
  enabled: true,
  orphanCheck: true,
  unusedExportCheck: true,
  wiringManifest: true,
  testIntegrity: true,
  gateIntegrity: true,
  testCount: true,
  tdd: true,
};

/**
 * Wiring claim parsed from the subagent's `FULLAUTO_WIRING:` block:
 *
 *   FULLAUTO_WIRING:
 *   - src/components/Foo.tsx -> src/app/page.tsx:12
 *   - src/lib/pricing.ts#calculatePrice -> src/routes/checkout.ts
 *   - src/lib/legacy.ts -> (entrypoint: next.js route file)
 */
export interface WiringClaim {
  artifactPath: string;
  symbol?: string;
  consumerPath?: string;
  consumerLine?: number;
  /** Free-text justification when there is no consumer (entrypoint etc.). */
  note?: string;
}
