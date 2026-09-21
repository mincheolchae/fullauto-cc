/**
 * Task classification — decides, per task, what kind of work it is, how
 * risky it is, and whether it is one half of a TDD red/green pair. Pure
 * function over the task list so it is unit-testable and re-runnable on
 * resume without touching disk.
 *
 * Why this exists: /verify-loop on every task (3 cycles x 4 reviewers) was
 * the single biggest cost in a run, and most of that spend went to tasks
 * where LLM review adds no signal (config, docs, a test-only task whose
 * "review" is the test itself). The classification lets `depthFor` route
 * only medium/high-risk implementation work to reviewers, while every task
 * still goes through the deterministic gates + audit.
 *
 * Explicit sub-bullet markers in the task body ALWAYS win over heuristics.
 * Heuristics are a fallback for hand-written / speckit task lists that
 * carry no markers; each decision leaves a line in `rationale` so a user
 * reading the report can see why a task got `full` review (or didn't).
 */

import type { RunConfig, Task, VerifyMode } from './types.js';
import type {
  TaskClassification,
  TaskKindClass,
  TaskRisk,
  TddPhase,
  VerifyDepth,
} from './audit/types.js';

// ---------- markers ----------

/**
 * One marker per line, `- ` bullet prefix, indented at most two spaces (or
 * one tab): a task's own sub-bullets (speckit indents them two spaces; the
 * parser trims the first body line to zero). Anything nested deeper is body
 * text — e.g. the user-task bodies the orchestrator indents by two more
 * spaces into a synthetic ENHANCE- / VERIFY- task body, which must never
 * hand that task a `tdd: red` or a `touches-config:` allowance it did not
 * earn. The key set is closed so a stray "- note: ..." bullet is never
 * mistaken for a marker.
 */
const MARKER_LINE =
  /^(?: {0,2}|\t)[-*+]\s+(kind|risk|tdd|tests|tested by|no test|touches-config|modifies-tests|wired by|level)\s*:\s*(.*?)\s*$/i;

export interface TaskMarkers {
  kind?: TaskKindClass;
  risk?: TaskRisk;
  tdd?: TddPhase;
  /** Canonicalized task IDs from `- tests:` / `- tested by:` (first is primary). */
  tests: string[];
  noTestReason?: string;
  touchesConfig?: string;
  modifiesTests?: string;
  wiredBy?: string;
  /** `- level: unit|integration|e2e` — informational, forwarded to prompts. */
  level?: string;
  /** Marker lines that had an unrecognized value; surfaced in rationale. */
  ignored: string[];
}

const KIND_VALUES = new Set<TaskKindClass>(['test', 'impl', 'config', 'docs']);
const RISK_VALUES = new Set<TaskRisk>(['low', 'medium', 'high']);
const TDD_VALUES = new Set<TddPhase>(['red', 'green', 'none']);

/**
 * Normalize every task-ID surface form (`T3`, `T003`, `3`, `T1000`) into the
 * same canonical shape the tasks.md parser uses, so a marker like
 * `- tests: T3` still resolves to the task the parser stored as `T003`.
 */
export function canonicalTaskId(raw: string): string | undefined {
  const m = raw.trim().match(/^T?(\d+)$/i);
  if (!m) return undefined;
  return `T${m[1].padStart(3, '0')}`;
}

function extractTaskIds(value: string): string[] {
  const ids: string[] = [];
  for (const tok of value.split(/[\s,&]+|\band\b/i)) {
    const id = tok && canonicalTaskId(tok);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function parseTaskMarkers(body: string): TaskMarkers {
  const markers: TaskMarkers = { tests: [], ignored: [] };
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(MARKER_LINE);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    const lower = value.toLowerCase();
    switch (key) {
      case 'kind':
        if (KIND_VALUES.has(lower as TaskKindClass)) markers.kind = lower as TaskKindClass;
        else markers.ignored.push(`kind: ${value}`);
        break;
      case 'risk':
        if (RISK_VALUES.has(lower as TaskRisk)) markers.risk = lower as TaskRisk;
        else markers.ignored.push(`risk: ${value}`);
        break;
      case 'tdd':
        if (TDD_VALUES.has(lower as TddPhase)) markers.tdd = lower as TddPhase;
        else markers.ignored.push(`tdd: ${value}`);
        break;
      case 'tests':
      case 'tested by': {
        const ids = extractTaskIds(value);
        if (ids.length === 0) markers.ignored.push(`${key}: ${value}`);
        for (const id of ids) if (!markers.tests.includes(id)) markers.tests.push(id);
        break;
      }
      case 'no test':
        markers.noTestReason = value || 'no reason given';
        break;
      case 'touches-config':
        markers.touchesConfig = value || 'no reason given';
        break;
      case 'modifies-tests':
        markers.modifiesTests = value || 'no reason given';
        break;
      case 'wired by': {
        const id = extractTaskIds(value)[0];
        if (id) markers.wiredBy = id;
        else markers.ignored.push(`wired by: ${value}`);
        break;
      }
      case 'level':
        markers.level = lower;
        break;
    }
  }
  return markers;
}

/** Body text with marker lines removed, so `- tests: T003` never trips the test heuristic. */
function heuristicText(task: Task): { title: string; body: string } {
  const body = task.body
    .split(/\r?\n/)
    .filter((l) => !MARKER_LINE.test(l))
    .join('\n');
  // The parser stores `body = title` when a task has no sub-bullets; don't
  // let that duplicate count as an independent body signal.
  return { title: task.title, body: body.trim() === task.title.trim() ? '' : body };
}

// ---------- kind heuristics ----------

const TEST_RE = /\b(?:unit|integration|contract|e2e|end-to-end)?\s*tests?\b|\bspec\b|\.test\.|\.spec\.|_test\./i;
const NOT_TEST_RE = /\b(?:set ?up|configure|install|runner|framework|scaffold)\b/i;
// "Implement X with tests" / "… including unit tests" describes an impl task
// that carries its own tests, not a test task. Without this, every
// single-task-TDD impl task would be classified `test` and skip review.
//
// The optional verb group ("add"/"write"/"create"/"include" …) is required
// for the single most common real-world phrasing of a paired task: "Add a
// pure function X … and add a unit test in test/x.test.ts covering …". This
// project's own test-pairing policy (README §6, the planner prompt) tells
// every author — human or planner — to name the paired test file by path
// inside the SAME sentence that describes the production deliverable, so
// without the verb group a bare filename mention (or the word "test" that
// almost always accompanies it) misfires the test-kind branch on properly
// authored impl tasks — discovered by hand-writing exactly this task while
// smoke-testing against a real subagent, not a hypothetical.
const TESTS_AS_ADDON_RE =
  /\b(?:with|and|plus|including|incl\.?)\s+(?:(?:add|adding|write|writing|create|creating|include|including)\s+)?(?:its\s+|the\s+|a\s+|one\s+|some\s+)?(?:unit\s+|integration\s+|e2e\s+|end-to-end\s+|contract\s+)?tests?\b/i;
const CONFIG_RE = /\b(?:set ?up|configure|install|scaffold|initiali[sz]e|bootstrap|add dependenc(?:y|ies)|ci workflow|gitignore|dockerfile|lint(?:ing)? config|tsconfig)\b/i;
const DOCS_RE = /\b(?:docs?|documentation|readme|changelog|comment)\b/i;
const CODEY_RE = /\b(?:endpoint|function|class|component|route|model|schema|migration)\b/i;
// A title that opens with an action verb is describing what to BUILD; the
// body is then acceptance criteria and "tests pass" in it is not a signal
// that the task itself is a test task.
const IMPL_VERB_RE = /^\s*(?:implement|add|create|build|wire|write|refactor|extend|update|migrate|expose|introduce|integrate|support|handle)\b/i;

function firstMatch(re: RegExp, text: string): string | undefined {
  const m = text.match(re);
  return m ? m[0].trim() : undefined;
}

interface KindDecision {
  kind: TaskKindClass;
  rationale: string;
}

/**
 * Kind only — used both for the task under classification and, without
 * recursion, for the OTHER tasks whose kind decides red/green pairing.
 */
export function classifyKind(task: Task): KindDecision {
  if (task.kind === 'enhance') return { kind: 'enhance', rationale: 'kind=enhance (synthetic vibe-enhance task)' };
  // A VERIFY-<feature> task changes code only to fix review findings, like an
  // enhance pass; classing it `enhance` keeps the audit's "impl must add
  // tests" rule from firing on a verification sweep.
  if (task.kind === 'verify') return { kind: 'enhance', rationale: 'kind=enhance (synthetic verify task)' };

  const markers = parseTaskMarkers(task.body);
  if (markers.kind) return { kind: markers.kind, rationale: `kind=${markers.kind} (marker)` };

  const { title, body } = heuristicText(task);
  const titleHasVerb = IMPL_VERB_RE.test(title);
  // Body only contributes when the title is verb-less ("Login endpoint" +
  // body "write a contract test hitting POST /login").
  const scope = titleHasVerb ? title : `${title}\n${body}`;

  const testHit = firstMatch(TEST_RE, scope);
  if (testHit && !NOT_TEST_RE.test(scope) && !TESTS_AS_ADDON_RE.test(title)) {
    // `- tests: T###` / `- no test:` describe an impl task by definition.
    if (markers.tests.length > 0) {
      return { kind: 'impl', rationale: `kind=impl (tests delegated to ${markers.tests.join(', ')})` };
    }
    if (markers.noTestReason !== undefined) {
      return { kind: 'impl', rationale: 'kind=impl (`no test` marker present)' };
    }
    return { kind: 'test', rationale: `kind=test (heuristic: matched "${testHit}")` };
  }
  const configHit = firstMatch(CONFIG_RE, scope);
  if (configHit) return { kind: 'config', rationale: `kind=config (heuristic: matched "${configHit}")` };
  const docsHit = firstMatch(DOCS_RE, scope);
  if (docsHit && !CODEY_RE.test(scope)) {
    return { kind: 'docs', rationale: `kind=docs (heuristic: matched "${docsHit}")` };
  }
  return { kind: 'impl', rationale: 'kind=impl (default)' };
}

// ---------- risk heuristics ----------

const HIGH_RISK_RE =
  /\b(?:auth|login|logout|password|token|session|oauth|jwt|payment|billing|stripe|checkout|webhook|migration|schema|permission|rbac|role|secret|crypto|encrypt|upload|middleware|security|admin|delete|destroy|public api|rate.?limit)\b/i;
const LOW_RISK_TITLE_RE = /\b(?:rename|typo|comment|style|css|theme|format|lint fix)\b/i;

function classifyRisk(task: Task, kind: TaskKindClass, markers: TaskMarkers): { risk: TaskRisk; rationale: string } {
  if (markers.risk) return { risk: markers.risk, rationale: `risk=${markers.risk} (marker)` };
  const { title, body } = heuristicText(task);
  const highHit = firstMatch(HIGH_RISK_RE, `${title}\n${body}`);
  if (highHit) return { risk: 'high', rationale: `risk=high (heuristic: matched "${highHit}")` };
  if (kind === 'config' || kind === 'docs') {
    return { risk: 'low', rationale: `risk=low (heuristic: kind=${kind})` };
  }
  const lowHit = firstMatch(LOW_RISK_TITLE_RE, title);
  if (lowHit) return { risk: 'low', rationale: `risk=low (heuristic: title matched "${lowHit}")` };
  return { risk: 'medium', rationale: 'risk=medium (default)' };
}

// ---------- TDD pairing ----------

/**
 * Is `testTask` a red task? Marker wins; otherwise it is red when some impl
 * task depends on it or points at it via `- tests:`. Kind-only lookups on
 * the other tasks keep this non-recursive.
 */
function redPairing(testTask: Task, allTasks: Task[]): { red: boolean; greenIds: string[]; why: string } {
  const greenIds: string[] = [];
  for (const other of allTasks) {
    if (other.id === testTask.id) continue;
    const otherMarkers = parseTaskMarkers(other.body);
    const pointsHere = otherMarkers.tests.includes(testTask.id);
    const dependsHere = other.dependencies.includes(testTask.id) && classifyKind(other).kind === 'impl';
    if (pointsHere || dependsHere) greenIds.push(other.id);
  }
  const marker = parseTaskMarkers(testTask.body).tdd;
  if (marker === 'red') return { red: true, greenIds, why: 'tdd=red (marker)' };
  if (marker !== undefined) return { red: false, greenIds, why: `tdd=${marker} (marker)` };
  if (greenIds.length > 0) {
    return { red: true, greenIds, why: `tdd=red (paired: ${greenIds.join(', ')} will turn these tests green)` };
  }
  return { red: false, greenIds, why: 'tdd=none (test task not paired with an impl task)' };
}

/**
 * Is `other` a red task from the point of view of an impl task that points
 * at it? A test task is red per `redPairing`; any other kind is red only
 * when its body says `- tdd: red` (mirrors the marker branch at the end of
 * `classifyTdd`, so an impl task's `- tests: T###` still resolves when the
 * test task was heuristically classed as config/docs).
 */
function isRedTask(other: Task, allTasks: Task[]): boolean {
  if (classifyKind(other).kind === 'test') return redPairing(other, allTasks).red;
  return parseTaskMarkers(other.body).tdd === 'red';
}

function classifyTdd(
  task: Task,
  kind: TaskKindClass,
  markers: TaskMarkers,
  allTasks: Task[]
): { tdd: TddPhase; redTaskIds: string[]; greenTaskIds: string[]; rationale: string } {
  if (kind === 'test') {
    const p = redPairing(task, allTasks);
    return { tdd: p.red ? 'red' : 'none', redTaskIds: [], greenTaskIds: p.greenIds, rationale: p.why };
  }
  if (kind === 'impl') {
    // Red tasks this impl task must turn green: explicit `- tests:` targets
    // plus any dependency that is a red test task.
    const redIds: string[] = [];
    const candidates = [...markers.tests, ...task.dependencies];
    for (const id of candidates) {
      if (redIds.includes(id)) continue;
      const other = allTasks.find((t) => t.id === id);
      if (!other || other.id === task.id) continue;
      if (isRedTask(other, allTasks)) redIds.push(id);
    }
    if (markers.tdd === 'green') {
      return { tdd: 'green', redTaskIds: redIds, greenTaskIds: [], rationale: 'tdd=green (marker)' };
    }
    if (markers.tdd !== undefined) {
      return { tdd: markers.tdd, redTaskIds: [], greenTaskIds: [], rationale: `tdd=${markers.tdd} (marker)` };
    }
    if (redIds.length > 0) {
      const via = markers.tests.some((id) => redIds.includes(id)) ? 'tests delegated to' : 'depends on';
      return { tdd: 'green', redTaskIds: redIds, greenTaskIds: [], rationale: `tdd=green (${via} red task ${redIds.join(', ')})` };
    }
    return { tdd: 'none', redTaskIds: [], greenTaskIds: [], rationale: 'tdd=none (single-task TDD, prompt-enforced)' };
  }
  if (markers.tdd && markers.tdd !== 'none') {
    return { tdd: markers.tdd, redTaskIds: [], greenTaskIds: [], rationale: `tdd=${markers.tdd} (marker on ${kind} task)` };
  }
  return { tdd: 'none', redTaskIds: [], greenTaskIds: [], rationale: `tdd=none (kind=${kind})` };
}

// ---------- public API ----------

/** Does `id` name a task that can still act (exists and is not finished)? */
function isOpenTask(id: string, allTasks: Task[]): { exists: boolean; open: boolean; status?: Task['status'] } {
  const t = allTasks.find((x) => x.id === id);
  if (!t) return { exists: false, open: false };
  return { exists: true, open: t.status !== 'done' && t.status !== 'failed', status: t.status };
}

export function classifyTask(task: Task, allTasks: Task[]): TaskClassification {
  // Synthetic ENHANCE- / VERIFY- tasks carry the user tasks' bodies as
  // context, not as instructions: no marker in there is theirs. They are
  // always an `enhance` pass — medium risk, no TDD phase, no allowances.
  if (task.kind === 'enhance' || task.kind === 'verify') {
    return {
      kind: 'enhance',
      risk: 'medium',
      tdd: 'none',
      redTaskIds: [],
      greenTaskIds: [],
      allowsConfigChange: false,
      allowsTestEdits: false,
      rationale: [
        classifyKind(task).rationale,
        'risk=medium (synthetic task: markers in the embedded task bodies are context, not instructions)',
        'tdd=none (synthetic task)',
      ],
    };
  }

  const markers = parseTaskMarkers(task.body);
  const rationale: string[] = [];

  // A delegation to a task that does not exist delegates to nobody: drop it
  // so the task is held to the normal "behavior task adds tests" rule.
  const missingTests = markers.tests.filter((id) => !allTasks.some((t) => t.id === id));
  for (const id of missingTests) rationale.push(`tests: ${id} ignored — no such task; this task must carry its own tests`);
  markers.tests = markers.tests.filter((id) => !missingTests.includes(id));

  const kindDecision = classifyKind(task);
  rationale.push(kindDecision.rationale);
  const kind = kindDecision.kind;

  const riskDecision = classifyRisk(task, kind, markers);
  rationale.push(riskDecision.rationale);

  const tddDecision = classifyTdd(task, kind, markers, allTasks);
  rationale.push(tddDecision.rationale);

  if (markers.tests.length > 0) rationale.push(`tests delegated to ${markers.tests.join(', ')} (marker)`);
  if (markers.noTestReason !== undefined) rationale.push(`no test: ${markers.noTestReason} (marker)`);
  if (markers.touchesConfig !== undefined) rationale.push(`touches-config: ${markers.touchesConfig} (marker)`);
  if (markers.modifiesTests !== undefined) rationale.push(`modifies-tests: ${markers.modifiesTests} (marker)`);

  // A red task is told to write "tests + minimal stubs so typecheck passes".
  // Such a stub is, by construction, referenced only from the new tests —
  // exactly what the orphan check blocks. The task that turns the tests
  // green is the one that implements AND wires the stub, so it is the
  // implied `wired by` target; the audit then records the stub as a pending
  // wiring promise and blocks the green task if it stays unreferenced.
  //
  // An explicit `- wired by:` marker always wins (the planner now emits one).
  // Without it: a sole green task is the obvious target; when SEVERAL impl
  // tasks depend on the red task (service + route + consumer, all tested by
  // one contract), the LAST one in file order is chosen — the consumer that
  // actually mounts / calls the stub is written after the services it uses,
  // and picking the first would hold the wrong task to the promise.
  //
  // A promise only counts when the promised task can still keep it: a
  // `wired by:` target that does not exist, or is already done / failed,
  // would leave the artifact unwired forever, so the marker is ignored and
  // this task has to wire the artifact itself.
  let wiredBy: string | undefined;
  if (markers.wiredBy) {
    const target = isOpenTask(markers.wiredBy, allTasks);
    if (!target.exists) rationale.push(`wired by: ${markers.wiredBy} ignored — no such task; wire the artifact in this task`);
    else if (!target.open) rationale.push(`wired by: ${markers.wiredBy} ignored — that task is already ${target.status}; wire the artifact in this task`);
    else {
      wiredBy = markers.wiredBy;
      rationale.push(`wired by ${wiredBy} (marker)`);
    }
  }
  if (!wiredBy && tddDecision.tdd === 'red' && !markers.wiredBy) {
    const open = tddDecision.greenTaskIds.filter((id) => isOpenTask(id, allTasks).open);
    if (open.length === 1) {
      wiredBy = open[0];
      rationale.push(`wired by ${wiredBy} (implied: the sole green task wires this red task's stubs)`);
    } else if (open.length > 1) {
      wiredBy = open[open.length - 1];
      rationale.push(
        `wired by ${wiredBy} (implied: last of ${open.length} green tasks ${open.join(', ')} in file order — the consumer usually lands after the service; add \`- wired by: T###\` to override)`
      );
    }
  }
  for (const ig of markers.ignored) rationale.push(`ignored unrecognized marker "${ig}"`);

  return {
    kind,
    risk: riskDecision.risk,
    tdd: tddDecision.tdd,
    redTaskIds: tddDecision.redTaskIds,
    greenTaskIds: tddDecision.greenTaskIds,
    allowsConfigChange: markers.touchesConfig !== undefined,
    allowsTestEdits: markers.modifiesTests !== undefined,
    wiredBy,
    testsDelegatedTo: markers.tests[0],
    noTestReason: markers.noTestReason,
    rationale,
  };
}

/**
 * `useVerifyLoop: false` predates `verifyMode`; honor it as the strongest
 * "no LLM review" signal so old configs keep their meaning.
 */
export function effectiveVerifyMode(
  config: Pick<RunConfig, 'verifyMode' | 'useVerifyLoop'>
): VerifyMode {
  if (config.useVerifyLoop === false) return 'gates-only';
  return config.verifyMode ?? 'adaptive';
}

export function depthFor(
  cls: TaskClassification,
  config: Pick<RunConfig, 'verifyMode' | 'useVerifyLoop'>
): VerifyDepth {
  const mode = effectiveVerifyMode(config);
  if (mode === 'gates-only') return 'gates';
  if (mode === 'full') return 'full';
  // `feature`: per-task depth is gates; the synthetic VERIFY-<feature> task
  // injected at group end carries the full review (see orchestrator).
  if (mode === 'feature') return 'gates';
  // adaptive
  if (cls.kind === 'config' || cls.kind === 'docs' || cls.kind === 'test') return 'gates';
  if (cls.kind === 'enhance') return 'light';
  if (cls.risk === 'low') return 'gates';
  if (cls.risk === 'high') return 'full';
  return 'light';
}

/** One-line summary for logs / reports: `impl · high · green(T003)`. */
export function describeClassification(cls: TaskClassification): string {
  const tdd =
    cls.tdd === 'green' && cls.redTaskIds.length
      ? `green(${cls.redTaskIds.join(',')})`
      : cls.tdd === 'red' && cls.greenTaskIds.length
      ? `red(→${cls.greenTaskIds.join(',')})`
      : cls.tdd;
  return `${cls.kind} · ${cls.risk} · tdd=${tdd}`;
}
