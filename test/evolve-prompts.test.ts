import { describe, it, expect } from 'vitest';
import {
  ASSESS_LINE_FORMAT,
  ASSESS_PROMPT_TITLE,
  SHAPE_PROMPT_TITLE,
  buildAssessPrompt,
  buildShapePrompt,
} from '../src/evolve-prompts.js';
import { PRODUCT_REQUIRED_SECTIONS } from '../src/product.js';

const PRODUCT = '/proj/.fullauto/product.md';
const STATE = '/proj/.fullauto/state.json';

describe('buildShapePrompt', () => {
  const p = buildShapePrompt('a tiny notes app', PRODUCT);

  it('starts with the stable H1, names the skill, gives the exact output path, and forbids questions', () => {
    expect(p.split('\n')[0]).toBe(SHAPE_PROMPT_TITLE);
    expect(p).toContain('Invoke the `/product-shape` skill');
    expect(p).toContain(`   ${PRODUCT}`);
    expect(p).toContain('## Concept\na tiny notes app');
    expect(p).toContain('NEVER ask a question or request clarification');
    expect(p).toContain('If the `/product-shape` skill is not available, do the same work yourself');
  });

  it('restates every required product.md section, the marker, and the table / bullet formats', () => {
    expect(p).toContain('## Required product.md format');
    expect(p).toContain('<!-- fullauto:product v1 -->');
    for (const s of PRODUCT_REQUIRED_SECTIONS) expect(p, s).toContain(`   ## ${s}`);
    expect(p).toContain('`| id | feature | status | round | note |`');
    expect(p).toContain('planned|in-progress|done|deferred|rejected');
    expect(p).toContain('`- [P1] F00x <feature> — impact:H|M|L effort:S|M|L — <why now>`');
    expect(p).toContain('ONE complete usable loop');
    expect(p).toContain('Cap the backlog at ~25 items');
  });

  it('appends the previous attempt\'s validation errors on retry', () => {
    expect(p).not.toContain('## Previous attempt was rejected');
    const retry = buildShapePrompt('x', PRODUCT, { priorErrors: ['Missing required section `## Backlog` (h2, exact title).', 'Feature map has no rows'] });
    expect(retry).toContain('## Previous attempt was rejected');
    expect(retry).toContain('- Missing required section `## Backlog` (h2, exact title).');
    expect(retry).toContain('- Feature map has no rows');
    expect(retry).toContain(`The file you wrote at ${PRODUCT} failed validation`);
  });
});

describe('buildAssessPrompt', () => {
  const summary = 'Round 2: 4 planned task(s) — 3 done, 1 failed\n- T001 [done] Create note';
  const p = buildAssessPrompt(PRODUCT, summary, STATE, false, { tasksPath: '/proj/.fullauto/rounds/2/tasks.md', round: 2 });

  it('starts with the stable H1, names the skill, lists every input path, and embeds the round summary', () => {
    expect(p.split('\n')[0]).toBe(ASSESS_PROMPT_TITLE);
    expect(p).toContain('Invoke the `/product-assess` skill');
    expect(p).toContain(`- Product brief (read AND rewrite in place): ${PRODUCT}`);
    expect(p).toContain(`- Orchestrator state of the round (task statuses, defer reasons, audit findings, TDD records): ${STATE}`);
    expect(p).toContain("- The round's task list: /proj/.fullauto/rounds/2/tasks.md");
    expect(p).toContain('Round 2 just finished executing');
    expect(p).toContain('## Round summary (from the orchestrator)\n' + summary);
    expect(p).not.toContain('enhance-log');
    expect(p).toContain('which backlog ids they asked to PROMOTE on their attempt (`enhance` field)');
  });

  it('restates the FULLAUTO_ASSESS line format exactly, as the LAST line, plus the verdict rules', () => {
    expect(p).toContain(`   ${ASSESS_LINE_FORMAT}`);
    expect(ASSESS_LINE_FORMAT).toBe('FULLAUTO_ASSESS: verdict=<continue|ship|stop> score=<0-100> next=<comma-separated F ids or none> reason=<one line>');
    expect(p).toContain('The LAST line of your final message must be exactly this machine line');
    expect(p).toContain('`ship` — the MVP loop works end-to-end, no P1 gaps remain, and score ≥ 80.');
    expect(p).toContain('`stop` — progress is blocked by something outside autonomy');
    expect(p).toContain('Never re-add a `rejected` feature');
    expect(p).toContain('NEVER ask a question or request clarification');
  });

  it('restates the product.md sections and warns that a malformed rewrite is reverted', () => {
    for (const s of PRODUCT_REQUIRED_SECTIONS) expect(p, s).toContain(`   ## ${s}`);
    expect(p).toContain('REVERTS your rewrite if it is malformed');
  });

  it('switches the UX walkthrough instruction on the flag', () => {
    expect(p).toContain('UX walkthrough is OFF for this run');
    expect(p).not.toContain('invoke `/ux-walkthrough`');
    const ux = buildAssessPrompt(PRODUCT, summary, STATE, true);
    expect(ux).toContain('UX walkthrough is ON for this run');
    expect(ux).toContain('invoke `/ux-walkthrough`');
    expect(ux).toContain('Stop any server you started');
    expect(ux).toContain('This round just finished executing');
  });
});
