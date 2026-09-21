import { PRODUCT_MARKER, PRODUCT_REQUIRED_SECTIONS } from './product.js';

/**
 * Prompts for the two judgment stages of `fullauto evolve`. Each is a thin
 * driver: the subagent's whole job is to invoke a named skill
 * (/product-shape, /product-assess) with exact file paths. The format rules
 * are restated here anyway — the skill file is the authority, but a subagent
 * that cannot find the skill (not installed, wrong plugin dir) must still
 * produce something the orchestrator can validate instead of asking.
 *
 * The H1 of each prompt is exported: the test harness keys its fake claude
 * scripts on it, and it must stay stable for that reason.
 */
export const SHAPE_PROMPT_TITLE = '# Product shaping job';
export const ASSESS_PROMPT_TITLE = '# Product assessment job';

/** The exact machine line the assessor must end with. */
export const ASSESS_LINE_FORMAT =
  'FULLAUTO_ASSESS: verdict=<continue|ship|stop> score=<0-100> next=<comma-separated F ids or none> reason=<one line>';

/** The product.md skeleton, restated so a subagent without the skill still writes the right shape. */
export function productFormatSection(): string[] {
  return [
    `## Required product.md format`,
    `Markdown, h2 sections with these EXACT titles, in this order (the orchestrator validates them and rejects the file otherwise):`,
    ``,
    `   # Product: <name>`,
    `   ${PRODUCT_MARKER}`,
    ...PRODUCT_REQUIRED_SECTIONS.map((s) => `   ## ${s}`),
    ``,
    `- \`## Concept\` — the user's words, verbatim.`,
    `- \`## Target users & core value\` — who it is for and the one thing they get.`,
    `- \`## Category & benchmarks\` — category id from the playbook + 3–5 peer products and what ALL of them have.`,
    `- \`## Principles & constraints\` — stack, non-goals, quality bar (tests, a11y, responsive, empty/error states), what NOT to build.`,
    `- \`## Feature map\` — a markdown table \`| id | feature | status | round | note |\`; ids F001, F002, …; status is one of planned|in-progress|done|deferred|rejected. At least one row.`,
    `- \`## Decisions\` — bullets \`- <decision> — <rationale/source>\`; every ambiguity you resolved goes here.`,
    `- \`## Backlog\` — ORDERED bullets \`- [P1] F00x <feature> — impact:H|M|L effort:S|M|L — <why now>\`; at least one item; every id must have a Feature map row.`,
    `- \`## Round log\` — per round \`### Round N — <date>\` with shipped / assessment score / next focus (may be empty before round 1).`,
  ];
}

export interface ShapePromptOptions {
  /** Validation errors from the previous attempt — appended so the retry fixes exactly those. */
  priorErrors?: string[];
  /** Absolute project directory (for orientation only; the subagent's cwd is already there). */
  projectDir?: string;
}

/**
 * Stage 0 — write the brief. The concept is the only input; everything
 * else the skill infers from project signal, the category playbook and a
 * benchmark scan. The prompt never lets the subagent ask: unattended runs
 * have nobody to answer.
 */
export function buildShapePrompt(concept: string, productPath: string, opts: ShapePromptOptions = {}): string {
  const retry = opts.priorErrors?.length
    ? [
        ``,
        `## Previous attempt was rejected`,
        `The file you wrote at ${productPath} failed validation. Rewrite it so that EVERY item below is fixed (keep everything else that was good):`,
        ...opts.priorErrors.map((e) => `- ${e}`),
      ]
    : [];
  return [
    SHAPE_PROMPT_TITLE,
    ``,
    `You are running inside a full-auto orchestrator (\`fullauto evolve\`) that turns a short concept into a usable product over several unattended rounds. Your single job in this stage is to produce the product brief that every later round plans from.`,
    ``,
    `## Concept`,
    concept,
    ``,
    `## What to do`,
    `1. Invoke the \`/product-shape\` skill with the concept above and let it drive: absorb the project signal in the current directory (README / manifests / git log — cap the exploration), classify the category with the shared playbook, benchmark 3–5 peer products, and decide the MVP.`,
    `2. Write the brief with the Write tool to this exact absolute path (create parent directories as needed):`,
    ``,
    `   ${productPath}`,
    ``,
    `3. If the \`/product-shape\` skill is not available, do the same work yourself following the format below — do not stop, do not ask where the skill is.`,
    ``,
    ...productFormatSection(),
    ``,
    `## Rules`,
    `- The round-1 backlog items must form ONE complete usable loop (onboard → core action → visible result); later items add depth (polish, UX, robustness) before breadth. Every backlog item has impact and effort. Cap the backlog at ~25 items.`,
    `- Prefer boring, proven stack choices that match the project signal; record each choice in Decisions with its source.`,
    `- Write for a solo vibe-coder: small, shippable increments. Do not invent work — every item cites a reason (playbook table-stakes, a peer benchmark, the concept itself).`,
    `- NEVER ask a question or request clarification. There is no one to answer. Resolve ambiguity by project signal → category convention → sensible default, and record the decision.`,
    `- The Write tool result is your only deliverable; stdout is ignored except for errors.`,
    ...retry,
  ].join('\n');
}

export interface AssessPromptOptions {
  /** The round's tasks.md (so the assessor can see what was planned vs. what finished). */
  tasksPath?: string;
  round?: number;
}

/**
 * Stage 3 — judge the round and rewrite the brief. The orchestrator parses
 * only the LAST `FULLAUTO_ASSESS:` line; the brief is re-validated after
 * the subagent exits and restored from a backup if it was broken.
 */
export function buildAssessPrompt(
  productPath: string,
  roundSummary: string,
  statePath: string,
  uxFlag: boolean,
  opts: AssessPromptOptions = {}
): string {
  const roundLabel = opts.round !== undefined ? `round ${opts.round}` : 'this round';
  const uxLine = uxFlag
    ? `UX walkthrough is ON for this run: when the project is runnable (web dev script or configured services, API endpoints, or a CLI), invoke \`/ux-walkthrough\` on the core journeys and fold its findings into the score, the backlog (UX defects become P1 fixes) and the round log. Stop any server you started.`
    : `UX walkthrough is OFF for this run: do not start servers or browsers; verify usability with a code-level journey trace (entry → core action → visible result) instead.`;
  return [
    ASSESS_PROMPT_TITLE,
    ``,
    `You are running inside a full-auto orchestrator (\`fullauto evolve\`). ${capitalize(roundLabel)} just finished executing. Your single job is to assess the product as it stands now, update the product brief, and emit a machine-readable verdict that decides whether another round runs.`,
    ``,
    `## Inputs (exact paths)`,
    `- Product brief (read AND rewrite in place): ${productPath}`,
    `- Orchestrator state of the round (task statuses, defer reasons, audit findings, TDD records): ${statePath}`,
    ...(opts.tasksPath ? [`- The round's task list: ${opts.tasksPath}`] : []),
    `- The code in the current working directory. Enhance passes (ENHANCE-* tasks in the state file) record what they applied and which backlog ids they asked to PROMOTE on their attempt (\`enhance\` field) — read it there, not from a log file.`,
    ``,
    `## Round summary (from the orchestrator)`,
    roundSummary,
    ``,
    `## What to do`,
    `1. Invoke the \`/product-assess\` skill and let it drive: reconcile the Feature map from the round result (a feature is \`done\` only when ALL its tasks are done and gates were green; otherwise \`deferred\` with the reason), verify usability rather than mere existence, score 0–100 across completeness / usability / robustness / polish / release readiness with one line of evidence each, re-prioritize the Backlog, and append the Round log entry.`,
    `2. ${uxLine}`,
    `3. Rewrite ${productPath} in place. Keep every required section and the exact table / bullet formats — the orchestrator validates the file after you exit and REVERTS your rewrite if it is malformed, which would make the next round re-plan from stale data.`,
    `4. If the \`/product-assess\` skill is not available, do the same work yourself following the rules below — do not stop, do not ask.`,
    ``,
    ...productFormatSection(),
    ``,
    `## Verdict rules`,
    `- \`ship\` — the MVP loop works end-to-end, no P1 gaps remain, and score ≥ 80.`,
    `- \`stop\` — progress is blocked by something outside autonomy (real credentials, a paid service, a product decision that materially changes scope). Record it in Decisions as "needs human: …".`,
    `- \`continue\` — otherwise. \`next=\` names the backlog ids the next round should take first (or \`none\`).`,
    `- Never re-add a \`rejected\` feature; demote breadth items while any core journey is broken; promote observed UX defects to P1 fixes; cap the backlog at 25.`,
    ``,
    `## Output protocol`,
    `NEVER ask a question or request clarification — there is no one to answer; decide and record the decision. Do not run \`git commit\`. The LAST line of your final message must be exactly this machine line (one line, no code fence, no trailing prose):`,
    ``,
    `   ${ASSESS_LINE_FORMAT}`,
    ``,
    `Example: \`FULLAUTO_ASSESS: verdict=continue score=62 next=F004,F007 reason=core loop works; sharing and empty states missing\``,
  ].join('\n');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
