/**
 * End-to-end `fullauto evolve` loop against a temp git project with the
 * fake `claude` (test/helpers/fake-claude.ts). The prompts the loop authors
 * itself (shape / plan / assess) carry no `FAKE:` lines, so each is driven
 * by a script file keyed on its H1 (`fake.script(h1, …)`); task prompts are
 * driven by directives in the tasks.md the "planner" copies into place.
 *
 *   (a) two rounds then `ship`: archives, product context in the planner
 *       prompt, round summary in the assess prompt, evolve-state on disk
 *   (b) `--rounds 1` with a `continue` verdict stops on the round cap
 *   (c) a round whose tasks all fail stops with `no_progress`
 *   (d) resume at the assess stage after a simulated crash runs ONLY assess
 *   (e) invalid product.md → one retry carrying the errors → abort (exit 1),
 *       then a resume re-runs the shape stage and completes
 *   (f) `--time-budget` exceeded between stages stops before assess; the
 *       resume (fresh budget) finishes the round
 *   (g) a pre-existing valid product.md skips the shape stage; `--force
 *       --reshape` backs it up, wipes the round archives and re-shapes
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runEvolve, type EvolveOptions } from '../../src/evolve.js';
import { ASSESS_PROMPT_TITLE, SHAPE_PROMPT_TITLE } from '../../src/evolve-prompts.js';
import { loadEvolveState, saveEvolveState } from '../../src/product.js';
import { loadState, paths, saveConfigSnapshot } from '../../src/persistence.js';
import { makeFakeClaude, type FakeClaude } from '../helpers/fake-claude.js';
import { makeGitRepo, makeTmpDir, cleanup } from '../helpers/tmp.js';
import { BRIEF_AFTER_ROUND_1, VALID_BRIEF } from '../helpers/product-fixture.js';

const PLAN_TITLE = '# Task Decomposition Job';

let fake: FakeClaude;
let restoreEnv: () => void;
let projectDir: string;
let fixtures: string;

beforeAll(async () => {
  fake = await makeFakeClaude();
  restoreEnv = fake.install();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  // The plan / shape / assess stages stream the fake's chatter to stderr.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(async () => {
  restoreEnv();
  await fake.dispose();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await fake.reset();
  projectDir = await makeGitRepo({ 'README.md': '# evolve fixture\n', 'src/index.ts': 'export {};\n' });
  fixtures = await makeTmpDir('evolve-fx-');
  await saveConfigSnapshot(projectDir, {
    maxPasses: 2,
    subagentTimeoutSec: 60,
    useVerifyLoop: false,
    gates: [{ name: 'ok', command: 'true' }],
    audit: { enabled: false },
  });
});

afterEach(async () => {
  await cleanup(projectDir);
  await cleanup(fixtures);
});

const PREREQS = '\n## Manual Prerequisites\n<!-- fullauto:prerequisites -->\n- [OTHER] None — fully self-contained.\n';

const TASKS_R1 = [
  '<!-- fullauto:round=1 items=F001,F002 -->',
  '## Feature: F001 Create and edit a note',
  '- [ ] T001 Create the note module',
  'FAKE: write src/note.ts',
  'FAKE: mark r1-T001',
  '## Feature: F002 Search notes',
  '- [ ] T002 Create the search module',
  'FAKE: write src/search.ts',
  'FAKE: mark r1-T002',
  PREREQS,
].join('\n');

const TASKS_R2 = [
  '<!-- fullauto:round=2 items=F003 -->',
  '## Feature: F003 Tags',
  '- [ ] T003 Create the tags module',
  'FAKE: write src/tags.ts',
  'FAKE: mark r2-T003',
  PREREQS,
].join('\n');

async function fixture(name: string, content: string): Promise<string> {
  const p = join(fixtures, name);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, content, 'utf-8');
  return p;
}

/** The standard happy-path scripts: a valid brief, two rounds of tasks, continue then ship. */
async function installHappyScripts(): Promise<void> {
  const brief = await fixture('product.md', VALID_BRIEF);
  const briefR1 = await fixture('product-r1.md', BRIEF_AFTER_ROUND_1);
  const r1 = await fixture('tasks-r1.md', TASKS_R1);
  const r2 = await fixture('tasks-r2.md', TASKS_R2);
  await fake.script(SHAPE_PROMPT_TITLE, `FAKE: copyfile ${brief} .fullauto/product.md`);
  await fake.script(
    PLAN_TITLE,
    [`FAKE: nth plan 1 copyfile ${r1} .fullauto/rounds/1/tasks.md`, `FAKE: nth plan 2 copyfile ${r2} .fullauto/rounds/2/tasks.md`].join('\n')
  );
  await fake.script(
    ASSESS_PROMPT_TITLE,
    [
      `FAKE: nth assess 1 copyfile ${briefR1} .fullauto/product.md`,
      'FAKE: nth assess 1 echo FULLAUTO_ASSESS: verdict=continue score=50 next=F003 reason=core loop works; tags missing',
      'FAKE: nth assess 2 echo FULLAUTO_ASSESS: verdict=ship score=90 next=none reason=all planned features usable',
    ].join('\n')
  );
}

function evolve(over: Partial<EvolveOptions> = {}) {
  return runEvolve({
    projectDir,
    concept: 'a tiny notes app',
    vibeEnhance: false,
    ux: false,
    force: false,
    reshape: false,
    verbose: false,
    ...over,
  });
}

const h1 = (prompt: string): string => prompt.split('\n')[0];

describe('(a) two rounds then ship', () => {
  it('shapes, plans, runs and assesses twice, archives round 1, and records everything in evolve-state.json', async () => {
    await installHappyScripts();
    const { state, exitCode } = await evolve({ rounds: 3 });

    expect(exitCode).toBe(0);
    expect(state.outcome).toBe('ship');
    expect(state.outcomeDetail).toBe('all planned features usable');
    expect(state.round).toBe(2);
    expect(state.rounds.map((r) => [r.round, r.stage, r.verdict, r.score, r.tasksDone, r.tasksFailed])).toEqual([
      [1, 'done', 'continue', 50, 2, 0],
      [2, 'done', 'ship', 90, 1, 0],
    ]);
    expect(state.rounds[0].backlogItems).toEqual(['F001', 'F002']);
    expect(state.rounds[0].nextItems).toEqual(['F003']);
    expect(state.rounds[0].featuresDone).toEqual(['F001', 'F002']); // read back from the assessor's rewrite
    expect(state.rounds[1].backlogItems).toEqual(['F003']);
    expect(state.rounds[1].runStartedAt).toBeDefined();
    expect(state.finishedAt).toBeDefined();

    // Subagent sequence: shape, plan 1, T001, T002, assess 1, plan 2, T003, assess 2.
    const prompts = await fake.prompts();
    expect(prompts.map(h1)).toEqual([
      SHAPE_PROMPT_TITLE,
      PLAN_TITLE,
      '# Single-Task Implementation Job',
      '# Single-Task Implementation Job',
      ASSESS_PROMPT_TITLE,
      PLAN_TITLE,
      '# Single-Task Implementation Job',
      ASSESS_PROMPT_TITLE,
    ]);
    expect(await fake.marks()).toEqual(['r1-T001', 'r1-T002', 'r2-T003']);

    // The shape prompt carries the concept and the exact output path.
    const p = paths(projectDir);
    expect(prompts[0]).toContain('a tiny notes app');
    expect(prompts[0]).toContain(p.productPath);
    // The planner gets the product context + round rules + the assessor's next focus.
    expect(prompts[1]).toContain('## Product context');
    expect(prompts[1]).toContain('### Round 1 selection rules (evolve mode)');
    expect(prompts[1]).toContain('<!-- fullauto:round=1 items=F001,F004 -->');
    expect(prompts[1]).toContain('- [P1] F001 Create and edit a note');
    expect(prompts[1]).toContain('At most 12 tasks in total');
    expect(prompts[5]).toContain('### Round 2 selection rules');
    expect(prompts[5]).toContain('- F001 [done] Create and edit a note');
    expect(prompts[5]).toContain('the assessor asked for F003 next');
    // The assess prompt carries the round summary built from state.json.
    expect(prompts[4]).toContain('Round 1: 2 planned task(s) — 2 done, 0 failed, 0 unfinished');
    expect(prompts[4]).toContain('- T001 [done] {F001 Create and edit a note} Create the note module');
    expect(prompts[4]).toContain(`- Orchestrator state of the round (task statuses, defer reasons, audit findings, TDD records): ${p.statePath}`);
    expect(prompts[4]).toContain(join(p.roundsDir, '1', 'tasks.md'));
    expect(prompts[4]).toContain('UX walkthrough is OFF');

    // Round 1 artifacts were archived before round 2 started; round 2's run is the live state.json.
    const r1 = join(p.roundsDir, '1');
    expect(existsSync(join(r1, 'tasks.md'))).toBe(true);
    expect(existsSync(join(r1, 'state.json'))).toBe(true);
    expect(existsSync(join(r1, 'logs', 'T001-attempt1.log'))).toBe(true);
    expect(existsSync(join(r1, 'logs', 'evolve-shape-attempt1.log'))).toBe(true);
    expect(existsSync(join(r1, 'plan-attempt1.log'))).toBe(true);
    expect(existsSync(join(r1, 'assess-attempt1.log'))).toBe(true);
    expect(existsSync(join(r1, 'product.pre-assess.md'))).toBe(true);
    const archived = JSON.parse(await readFile(join(r1, 'state.json'), 'utf-8')) as { tasks: Array<{ id: string; status: string }> };
    expect(archived.tasks.map((t) => [t.id, t.status])).toEqual([['T001', 'done'], ['T002', 'done']]);
    const live = await loadState(projectDir);
    expect(live?.tasks.map((t) => [t.id, t.status])).toEqual([['T003', 'done']]);
    expect(existsSync(join(p.logsDir, 'T003-attempt1.log'))).toBe(true);
    expect(existsSync(join(p.logsDir, 'T001-attempt1.log'))).toBe(false);

    // product.md is the assessor's version; evolve-state.json is persisted.
    expect(await readFile(p.productPath, 'utf-8')).toBe(BRIEF_AFTER_ROUND_1);
    expect(await loadEvolveState(projectDir)).toEqual(state);
    expect(existsSync(join(projectDir, 'src', 'tags.ts'))).toBe(true);
  }, 60_000);
});

describe('(b) round cap', () => {
  it('stops with max_rounds after one round when the verdict is continue', async () => {
    await installHappyScripts();
    const { state, exitCode } = await evolve({ rounds: 1 });
    expect(exitCode).toBe(0);
    expect(state.outcome).toBe('max_rounds');
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].verdict).toBe('continue');
    expect((await fake.prompts()).map(h1)).toEqual([
      SHAPE_PROMPT_TITLE,
      PLAN_TITLE,
      '# Single-Task Implementation Job',
      '# Single-Task Implementation Job',
      ASSESS_PROMPT_TITLE,
    ]);
    // A second invocation with the same cap has nothing to do and does not spawn anything.
    await fake.reset();
    const again = await evolve({ concept: undefined, rounds: 1 });
    expect(again.exitCode).toBe(0);
    expect(again.state.outcome).toBe('max_rounds');
    expect(await fake.prompts()).toEqual([]);
  }, 60_000);
});

describe('(c) no progress', () => {
  it('a round whose tasks all fail stops with no_progress (exit 1) after assessing it', async () => {
    await installHappyScripts();
    const failing = await fixture(
      'tasks-fail.md',
      [
        '<!-- fullauto:round=1 items=F001 -->',
        '- [ ] T001 Needs a credential',
        'FAKE: defer because no credential',
        '- [ ] T002 Also stuck',
        'FAKE: defer because no credential',
        PREREQS,
      ].join('\n')
    );
    await fake.script(PLAN_TITLE, `FAKE: copyfile ${failing} .fullauto/rounds/1/tasks.md`);
    await saveConfigSnapshot(projectDir, {
      maxPasses: 1,
      subagentTimeoutSec: 60,
      useVerifyLoop: false,
      gates: [{ name: 'ok', command: 'true' }],
      audit: { enabled: false },
    });
    const { state, exitCode } = await evolve({ rounds: 3 });
    expect(exitCode).toBe(1);
    expect(state.outcome).toBe('no_progress');
    expect(state.outcomeDetail).toMatch(/round 1 finished 0 tasks \(2 failed\)/);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0]).toMatchObject({ stage: 'done', tasksDone: 0, tasksFailed: 2, verdict: 'continue' });
    const prompts = await fake.prompts();
    expect(prompts.map(h1).filter((t) => t === ASSESS_PROMPT_TITLE)).toHaveLength(1);
    expect(prompts[prompts.length - 1]).toContain('- T001 [failed] Needs a credential — verify_loop_blocks_remaining: no credential');
  }, 60_000);
});

describe('(d) resume at the assess stage', () => {
  it('after a crash between run and assess, resume runs ONLY the assess stage and finishes', async () => {
    await installHappyScripts();
    const first = await evolve({ rounds: 1 });
    expect(first.state.outcome).toBe('max_rounds');

    // Simulate a crash after the run stage: the round is recorded at
    // `assess` with no verdict, and no outcome was written.
    const crashed = first.state;
    crashed.rounds[0].stage = 'assess';
    delete crashed.rounds[0].verdict;
    delete crashed.rounds[0].score;
    delete crashed.rounds[0].finishedAt;
    crashed.rounds[0].nextItems = [];
    delete crashed.outcome;
    delete crashed.outcomeDetail;
    delete crashed.finishedAt;
    await saveEvolveState(projectDir, crashed);
    await writeFile(paths(projectDir).productPath, VALID_BRIEF, 'utf-8');

    await fake.reset();
    await fake.script(ASSESS_PROMPT_TITLE, 'FAKE: echo FULLAUTO_ASSESS: verdict=ship score=85 next=none reason=resumed fine');

    const resumed = await evolve({ concept: undefined });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.state.outcome).toBe('ship');
    expect(resumed.state.rounds).toHaveLength(1);
    expect(resumed.state.rounds[0]).toMatchObject({ stage: 'done', verdict: 'ship', score: 85, tasksDone: 2 });
    // Only the assess subagent ran: no shape, no plan, no task re-execution.
    expect((await fake.prompts()).map(h1)).toEqual([ASSESS_PROMPT_TITLE]);
    expect(await fake.marks()).toEqual([]);
    expect((await loadState(projectDir))?.tasks.map((t) => t.status)).toEqual(['done', 'done']);
  }, 60_000);
});

describe('(e) invalid product.md', () => {
  it('retries the shape stage once with the validation errors, then aborts with exit 1; a resume re-shapes', async () => {
    const missingBacklog = VALID_BRIEF.replace(/## Backlog\n[\s\S]*?\n\n/, '');
    const badRow = VALID_BRIEF.replace('| F002 | Search notes | planned | 1 | |', '| F002 | Search notes | shipped | 1 | |');
    const bad1 = await fixture('bad1.md', missingBacklog);
    const bad2 = await fixture('bad2.md', badRow);
    await fake.script(
      SHAPE_PROMPT_TITLE,
      [`FAKE: nth shape 1 copyfile ${bad1} .fullauto/product.md`, `FAKE: nth shape 2 copyfile ${bad2} .fullauto/product.md`].join('\n')
    );

    const { state, exitCode } = await evolve({ rounds: 1 });
    expect(exitCode).toBe(1);
    expect(state.outcome).toBe('aborted');
    expect(state.outcomeDetail).toMatch(/still invalid after one retry/);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].stage).toBe('shape');

    const prompts = await fake.prompts();
    expect(prompts.map(h1)).toEqual([SHAPE_PROMPT_TITLE, SHAPE_PROMPT_TITLE]);
    expect(prompts[0]).not.toContain('## Previous attempt was rejected');
    expect(prompts[1]).toContain('## Previous attempt was rejected');
    expect(prompts[1]).toContain('- Missing required section `## Backlog` (h2, exact title).');
    // The second bad brief is what is left on disk (the loop never accepted one).
    expect(await readFile(paths(projectDir).productPath, 'utf-8')).toBe(badRow);
    expect((await loadEvolveState(projectDir))?.outcome).toBe('aborted');

    // Resume: the round is still at `shape`; with a good brief the loop completes.
    await fake.reset();
    await installHappyScripts();
    const resumed = await evolve({ concept: undefined });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.state.outcome).toBe('max_rounds');
    expect((await fake.prompts()).map(h1)[0]).toBe(SHAPE_PROMPT_TITLE);
    expect(resumed.state.rounds[0]).toMatchObject({ round: 1, stage: 'done', tasksDone: 2, verdict: 'continue' });
  }, 60_000);
});

describe('(e2) assessor process failure (real regression — live smoke test)', () => {
  it('assessor failing twice (timeout/nonzero exit, zero output) aborts instead of fabricating a "continue" verdict', async () => {
    // Reproduces exactly what a real `/product-assess` subagent did against
    // a too-tight timeout during manual smoke-testing: `claude -p` exits
    // nonzero (stand-in for a timeout — the fake can't sleep past a real
    // process timeout, but the orchestrator treats both identically) with
    // NO stdout at all, twice in a row. Before this fix, `assessStage` fell
    // through the retry loop with no throw, `parseAssessVerdict('')`
    // silently defaulted to verdict=continue, and the round "succeeded"
    // with zero real judgment and product.md left completely untouched.
    await installHappyScripts();
    await fake.script(ASSESS_PROMPT_TITLE, 'FAKE: exit 1');

    const { state, exitCode } = await evolve({ rounds: 1 });

    expect(exitCode).toBe(1);
    expect(state.outcome).toBe('aborted');
    expect(state.outcomeDetail).toMatch(/[Aa]ssessor failed twice for round 1/);
    expect(state.rounds).toHaveLength(1);
    expect(state.rounds[0].stage).toBe('assess');
    // No fabricated verdict — the round record must NOT look assessed.
    expect(state.rounds[0].verdict).toBeUndefined();
    // product.md must be exactly what shape wrote — untouched by assess,
    // not silently reverted-from-garbage.
    expect(await readFile(paths(projectDir).productPath, 'utf-8')).toBe(VALID_BRIEF);

    const prompts = await fake.prompts();
    expect(prompts.map(h1).filter((t) => t === ASSESS_PROMPT_TITLE)).toHaveLength(2);

    // Resume: still at the assess stage; a working assessor completes it.
    await fake.reset();
    await fake.script(ASSESS_PROMPT_TITLE, 'FAKE: echo FULLAUTO_ASSESS: verdict=ship score=91 next=none reason=recovered');
    const resumed = await evolve({ concept: undefined });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.state.outcome).toBe('ship');
    expect(resumed.state.rounds[0]).toMatchObject({ stage: 'done', verdict: 'ship', score: 91 });
  }, 60_000);
});

describe('(f) time budget', () => {
  it('stops between stages once the per-invocation budget is spent; the resume finishes the round', async () => {
    await installHappyScripts();
    const slow = await fixture(
      'tasks-slow.md',
      ['<!-- fullauto:round=1 items=F001 -->', '- [ ] T001 Slow module', 'FAKE: sleep 2', 'FAKE: write src/slow.ts', PREREQS].join('\n')
    );
    await fake.script(PLAN_TITLE, `FAKE: copyfile ${slow} .fullauto/rounds/1/tasks.md`);

    const { state, exitCode } = await evolve({ rounds: 1, timeBudgetSec: 1 });
    expect(exitCode).toBe(0);
    expect(state.outcome).toBe('time_budget');
    expect(state.outcomeDetail).toMatch(/time budget of 1s exceeded before the assess stage of round 1/);
    expect(state.rounds[0]).toMatchObject({ stage: 'assess', tasksDone: 1 });
    expect((await fake.prompts()).map(h1)).toEqual([SHAPE_PROMPT_TITLE, PLAN_TITLE, '# Single-Task Implementation Job']);

    // Resume gets a fresh budget: the assess stage runs first thing.
    await fake.reset();
    await fake.script(ASSESS_PROMPT_TITLE, 'FAKE: echo FULLAUTO_ASSESS: verdict=ship score=88 next=none reason=done');
    const resumed = await evolve({ concept: undefined, timeBudgetSec: 1 });
    expect(resumed.state.outcome).toBe('ship');
    expect((await fake.prompts()).map(h1)).toEqual([ASSESS_PROMPT_TITLE]);
  }, 60_000);
});

describe('(g) existing product.md, --force --reshape', () => {
  it('skips shaping when a valid brief exists; --force --reshape backs it up and re-shapes', async () => {
    await installHappyScripts();
    // This round's assessor only emits a verdict (no rewrite), so the brief
    // on disk stays the hand-written one until --reshape backs it up.
    await fake.script(ASSESS_PROMPT_TITLE, 'FAKE: echo FULLAUTO_ASSESS: verdict=continue score=40 next=F003 reason=keep going');
    const p = paths(projectDir);
    await mkdir(p.fullautoDir, { recursive: true });
    const handWritten = VALID_BRIEF.replace('# Product: Notes', '# Product: Hand-written notes');
    await writeFile(p.productPath, handWritten, 'utf-8');

    const first = await evolve({ rounds: 1 });
    expect(first.state.outcome).toBe('max_rounds');
    expect(first.state.rounds[0].stage).toBe('done');
    const prompts = await fake.prompts();
    expect(prompts.map(h1)[0]).toBe(PLAN_TITLE); // no shape stage
    expect(prompts[0]).toContain('# Product: Hand-written notes');
    expect(existsSync(join(p.roundsDir, '1', 'tasks.md'))).toBe(true);

    // Start over with a fresh brief: the old one is kept as product.prev.md,
    // the archives go, and the shape stage writes the fixture brief.
    await fake.reset();
    await installHappyScripts();
    const again = await evolve({ rounds: 1, force: true, reshape: true });
    expect(again.exitCode).toBe(0);
    expect(again.state.round).toBe(1);
    expect((await fake.prompts()).map(h1)[0]).toBe(SHAPE_PROMPT_TITLE);
    expect(await readFile(join(p.fullautoDir, 'product.prev.md'), 'utf-8')).toBe(handWritten);
    expect(await readFile(p.productPath, 'utf-8')).toBe(BRIEF_AFTER_ROUND_1);
    expect(existsSync(join(p.roundsDir, 'pre-evolve-'))).toBe(false);

    // An INVALID pre-existing brief aborts before spending a planner call.
    await fake.reset();
    await installHappyScripts();
    await writeFile(p.productPath, VALID_BRIEF.replace('## Backlog', '## Wishlist'), 'utf-8');
    const bad = await evolve({ rounds: 1, force: true });
    expect(bad.exitCode).toBe(1);
    expect(bad.state.outcome).toBe('aborted');
    expect(bad.state.outcomeDetail).toContain('exists but failed validation');
    expect(bad.state.outcomeDetail).toContain('Missing required section `## Backlog`');
    expect(await fake.prompts()).toEqual([]);
  }, 60_000);
});

describe('(h) what round N learned reaches round N+1', () => {
  it('failed-task reasons go to the next planner; the enhance budget is carried, not reset', async () => {
    const brief = await fixture('product.md', VALID_BRIEF);
    const briefR1 = await fixture('product-r1.md', BRIEF_AFTER_ROUND_1);
    const r1 = await fixture(
      'tasks-r1-fail.md',
      [
        '<!-- fullauto:round=1 items=F001,F002 -->',
        '## Feature: F001 Create and edit a note',
        '- [ ] T001 Create the note module',
        'FAKE: write src/note.ts',
        '## Feature: F002 Search notes',
        '- [ ] T002 Create the search module',
        'FAKE: defer because the search index service is unreachable',
        PREREQS,
      ].join('\n')
    );
    const r2 = await fixture('tasks-r2.md', TASKS_R2);
    await fake.script(SHAPE_PROMPT_TITLE, `FAKE: copyfile ${brief} .fullauto/product.md`);
    await fake.script(
      PLAN_TITLE,
      [`FAKE: nth plan 1 copyfile ${r1} .fullauto/rounds/1/tasks.md`, `FAKE: nth plan 2 copyfile ${r2} .fullauto/rounds/2/tasks.md`].join('\n')
    );
    // Every enhance pass applies 2 additions: with a budget of 3, round 1's pass leaves 1 for round 2.
    await fake.script('# vibe-enhance pass', 'FAKE: echo FULLAUTO_ENHANCE: applied=2 optional=0 promote=none');
    await fake.script(
      ASSESS_PROMPT_TITLE,
      [
        `FAKE: nth assess 1 copyfile ${briefR1} .fullauto/product.md`,
        'FAKE: nth assess 1 echo FULLAUTO_ASSESS: verdict=continue score=40 next=F003 reason=search blocked',
        'FAKE: nth assess 2 echo FULLAUTO_ASSESS: verdict=ship score=90 next=none reason=done',
      ].join('\n')
    );

    const { state } = await evolve({ rounds: 3, vibeEnhance: true });

    expect(state.rounds[0].tasksDone).toBe(1);
    expect(state.rounds[0].tasksFailed).toBe(1);
    expect(state.rounds[0].failureNotes).toHaveLength(1);
    expect(state.rounds[0].failureNotes[0]).toMatch(/^T002 "Create the search module" — .*: .*unreachable/);

    const prompts = await fake.prompts();
    const plan2 = prompts.filter((p) => h1(p) === PLAN_TITLE)[1];
    expect(plan2).toContain('FAILED last round');
    expect(plan2).toContain('T002 "Create the search module"');
    expect(plan2).toContain('unreachable');

    // Round 1 spent 2 of the 3-addition budget; round 2's enhance pass is told 1 is left.
    const enhancePrompts = prompts.filter((p) => h1(p) === '# vibe-enhance pass');
    expect(enhancePrompts.length).toBeGreaterThanOrEqual(2);
    expect(enhancePrompts[0]).toContain('budget=3');
    expect(enhancePrompts[enhancePrompts.length - 1]).toContain('budget=1');
    expect(state.enhanceBudgetRemaining).toBe(0); // round 2's pass applied 2 more, clamped at 0
  }, 90_000);
});
