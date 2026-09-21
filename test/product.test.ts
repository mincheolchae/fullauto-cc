import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  EvolveState,
  PRODUCT_REQUIRED_SECTIONS,
  extractProductContext,
  loadEvolveState,
  parseAssessVerdict,
  parseProductBrief,
  parseRoundHeader,
  saveEvolveState,
  validateProductBrief,
} from '../src/product.js';
import { paths } from '../src/persistence.js';
import { makeTmpDir, cleanup } from './helpers/tmp.js';

import { VALID_BRIEF } from './helpers/product-fixture.js';

describe('validateProductBrief', () => {
  it('accepts the reference brief and parses the feature map + backlog', () => {
    const v = validateProductBrief(VALID_BRIEF);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(v.brief.name).toBe('Notes');
    expect(v.brief.hasMarker).toBe(true);
    expect(v.brief.featureMap.map((f) => [f.id, f.status, f.round])).toEqual([
      ['F001', 'planned', '1'],
      ['F002', 'planned', '1'],
      ['F003', 'planned', ''],
      ['F004', 'rejected', ''],
    ]);
    expect(v.brief.featureMap[2].note).toBe('later');
    expect(v.brief.backlog.map((b) => [b.priority, b.id, b.impact, b.effort])).toEqual([
      ['P1', 'F001', 'H', 'M'],
      ['P1', 'F002', 'H', 'S'],
      ['P2', 'F003', 'M', 'M'],
    ]);
    expect(v.brief.backlog[0].feature).toBe('Create and edit a note');
    expect(v.brief.backlog[0].why).toBe('the core loop');
    expect(v.warnings).toEqual([]);
  });

  it('reports each missing required section by its exact h2 title', () => {
    const withoutDecisions = VALID_BRIEF.replace('## Decisions\n- SQLite over Postgres — single user, zero ops.\n\n', '');
    const v = validateProductBrief(withoutDecisions);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['Missing required section `## Decisions` (h2, exact title).']);

    const empty = validateProductBrief('');
    expect(empty.ok).toBe(false);
    expect(empty.errors).toEqual(['product.md is empty.']);

    const prose = validateProductBrief('# Product: X\njust prose');
    expect(prose.errors.filter((e) => e.startsWith('Missing required section'))).toHaveLength(PRODUCT_REQUIRED_SECTIONS.length);
  });

  it('matches section titles case-insensitively with collapsed whitespace, and does not open sections inside code fences', () => {
    const relaxed = VALID_BRIEF.replace('## Target users & core value', '##   target USERS  &  core value');
    expect(validateProductBrief(relaxed).ok).toBe(true);
    const fenced = VALID_BRIEF.replace('## Round log\n', '## Round log\n```\n## Not a section\n```\n');
    const v = validateProductBrief(fenced);
    expect(v.ok).toBe(true);
    expect(Object.keys(v.brief.extraSections)).toEqual([]);
  });

  it('rejects a malformed feature-map row (bad id / bad status) and duplicates, citing the row', () => {
    const badStatus = VALID_BRIEF.replace('| F002 | Search notes | planned | 1 | |', '| F002 | Search notes | shipped | 1 | |');
    const v1 = validateProductBrief(badStatus);
    expect(v1.ok).toBe(false);
    expect(v1.errors).toHaveLength(1);
    expect(v1.errors[0]).toMatch(/Feature map row at line \d+ is malformed: status "shipped" must be one of planned\|in-progress\|done\|deferred\|rejected — row: \| F002/);

    const badId = VALID_BRIEF.replace('| F003 | Tags | planned | | later |', '| 3 | Tags | planned | | later |');
    expect(validateProductBrief(badId).errors[0]).toMatch(/id "3" must look like F001/);

    const dup = VALID_BRIEF.replace('| F003 | Tags | planned | | later |', '| F001 | Tags | planned | | later |');
    expect(validateProductBrief(dup).errors).toEqual(['Feature map has duplicate id F001 (line 21).']);
  });

  it('rejects an empty feature map and tolerates a header-less table with a warning', () => {
    const noRows = VALID_BRIEF.replace(/\| F00\d \|[^\n]*\n/g, '');
    const v = validateProductBrief(noRows);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['Feature map has no rows — expected a markdown table `| id | feature | status | round | note |` with at least one F### row.']);

    const noHeader = VALID_BRIEF.replace('| id | feature | status | round | note |\n|----|---------|--------|-------|------|\n', '');
    const v2 = validateProductBrief(noHeader);
    expect(v2.ok).toBe(true);
    expect(v2.brief.featureMap).toHaveLength(4);
    expect(v2.warnings.some((w) => w.includes('no header row'))).toBe(true);
  });

  it('rejects an empty backlog; bullets without a feature id are warnings, unknown ids are warnings', () => {
    const empty = VALID_BRIEF.replace(/- \[P\d\] F00\d[^\n]*\n/g, '');
    const v = validateProductBrief(empty);
    expect(v.ok).toBe(false);
    expect(v.errors).toEqual(['Backlog has no items — expected ordered bullets `- [P1] F001 <feature> — impact:H|M|L effort:S|M|L — <why now>` (at least one).']);

    const loose = VALID_BRIEF.replace('- [P2] F003 Tags — impact:M effort:M — after the loop works', '- polish the header\n- F009 Mystery feature');
    const v2 = validateProductBrief(loose);
    expect(v2.ok).toBe(true);
    expect(v2.brief.backlog.map((b) => b.id)).toEqual(['F001', 'F002', 'F009']);
    expect(v2.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Backlog bullet at line \d+ names no feature id/),
      expect.stringMatching(/Backlog item F009 .*has no \[P#\] priority tag/),
      expect.stringMatching(/Backlog item F009 .*missing impact/),
      'Backlog item F009 has no row in the Feature map.',
    ]));
  });

  it('warns (never errors) on a missing title / marker and on duplicate sections', () => {
    const noTitle = VALID_BRIEF.replace('# Product: Notes\n<!-- fullauto:product v1 -->\n', '');
    const v = validateProductBrief(noTitle);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual(expect.arrayContaining([
      'Missing `# Product: <name>` title line.',
      'Missing marker line `<!-- fullauto:product v1 -->` under the title.',
    ]));
    const dup = `${VALID_BRIEF}\n## Decisions\n- later thought\n`;
    const v2 = validateProductBrief(dup);
    expect(v2.ok).toBe(true);
    expect(v2.warnings).toContain('Section "decisions" appears more than once — only the first is used.');
    expect(v2.brief.sections.Decisions).toBe('- SQLite over Postgres — single user, zero ops.');
  });
});

describe('extractProductContext', () => {
  it('inlines concept, users, principles, decisions, feature map and the backlog top N', () => {
    const ctx = extractProductContext(VALID_BRIEF);
    expect(ctx).toContain('# Product: Notes');
    expect(ctx).toContain('## Concept\nA tiny note-taking app');
    expect(ctx).toContain('## Target users & core value');
    expect(ctx).toContain('## Principles & constraints');
    expect(ctx).toContain('## Decisions');
    expect(ctx).toContain('- F001 [planned] Create and edit a note (round 1)');
    expect(ctx).toContain('- F004 [rejected] Share by link (non-goal)');
    expect(ctx).toContain('## Backlog (top 3, in priority order)');
    expect(ctx).toContain('- [P1] F001 Create and edit a note — impact:H effort:M — the core loop');
    expect(ctx).not.toContain('## Round log');
  });

  it('caps the backlog at backlogTop and the whole block at maxChars', () => {
    const many = VALID_BRIEF.replace(
      '## Round log',
      Array.from({ length: 30 }, (_, i) => `- [P3] F${String(100 + i)} Extra ${i} — impact:L effort:L — filler`).join('\n') + '\n\n## Round log'
    );
    // Those bullets sit under Backlog because the replace happened before the heading.
    const ctx = extractProductContext(many, { backlogTop: 5 });
    expect(ctx).toContain('## Backlog (top 5, in priority order)');
    expect(ctx).toContain('…(28 more backlog items in product.md)');
    const small = extractProductContext(VALID_BRIEF, { maxChars: 300 });
    expect(small.length).toBeLessThanOrEqual(300);
    expect(small.endsWith('…(truncated)')).toBe(true);
    expect(extractProductContext(VALID_BRIEF).length).toBeLessThanOrEqual(6000);
  });

  it('is lenient: a brief with missing sections still yields what exists', () => {
    const ctx = extractProductContext('# Product: X\n## Concept\nhello\n');
    expect(ctx).toBe('# Product: X\n\n## Concept\nhello');
    expect(parseProductBrief('').featureMap).toEqual([]);
  });
});

describe('parseRoundHeader', () => {
  it('reads round + items from the header comment wherever it sits', () => {
    expect(parseRoundHeader('<!-- fullauto:round=2 items=F001,F004 -->\n- [ ] T001 x')).toEqual({ round: 2, items: ['F001', 'F004'] });
    expect(parseRoundHeader('\n# Round plan\n<!--fullauto:round=10 items=f003 , F007-->\n')).toEqual({ round: 10, items: ['F003', 'F007'] });
    expect(parseRoundHeader('<!-- fullauto:round=1 items=none -->')).toEqual({ round: 1, items: [] });
    expect(parseRoundHeader('<!-- fullauto:round=1 items= -->')).toEqual({ round: 1, items: [] });
  });

  it('returns null when absent or malformed', () => {
    expect(parseRoundHeader('- [ ] T001 x')).toBeNull();
    expect(parseRoundHeader('<!-- fullauto:round=x items=F001 -->')).toBeNull();
    expect(parseRoundHeader('<!-- fullauto:prerequisites -->')).toBeNull();
  });
});

describe('parseAssessVerdict', () => {
  it('parses every field; last line wins', () => {
    const out = [
      'Thinking about the format: FULLAUTO_ASSESS: verdict=stop score=0 next=none reason=draft',
      'FULLAUTO_ASSESS: verdict=continue score=55 next=F002 reason=first pass',
      '  FULLAUTO_ASSESS: verdict=ship score=91 next=none reason=core loop works; polish done',
    ].join('\n');
    const v = parseAssessVerdict(out);
    expect(v).toEqual({
      verdict: 'ship',
      score: 91,
      next: [],
      reason: 'core loop works; polish done',
      found: true,
      warnings: [],
    });
    const c = parseAssessVerdict('FULLAUTO_ASSESS: verdict=continue score=40 next=F003, f001 reason=needs search and tags');
    expect(c.verdict).toBe('continue');
    expect(c.next).toEqual(['F003', 'F001']);
    expect(c.reason).toBe('needs search and tags');
  });

  it('missing line → continue with unknown score and a warning', () => {
    const v = parseAssessVerdict('no verdict here\nFULLAUTO_RESULT: DEFER nope');
    expect(v.verdict).toBe('continue');
    expect(v.score).toBeUndefined();
    expect(v.next).toEqual([]);
    expect(v.found).toBe(false);
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatch(/no FULLAUTO_ASSESS line/);
  });

  it('unknown verdict word / bad score degrade to continue with warnings, never throw', () => {
    const v = parseAssessVerdict('FULLAUTO_ASSESS: verdict=maybe score=abc next=F001');
    expect(v.verdict).toBe('continue');
    expect(v.score).toBeUndefined();
    expect(v.next).toEqual(['F001']);
    expect(v.found).toBe(true);
    expect(v.warnings).toEqual([
      'FULLAUTO_ASSESS verdict "maybe" is not one of continue|ship|stop — treating as continue',
      'FULLAUTO_ASSESS score "abc" is not a number in 0–100 — ignored',
    ]);
    expect(parseAssessVerdict('FULLAUTO_ASSESS: verdict=ship').warnings).toEqual(['FULLAUTO_ASSESS line has no score= field']);
    expect(parseAssessVerdict('FULLAUTO_ASSESS: verdict=ship score=150 next=none').score).toBeUndefined();
  });
});

describe('EvolveState', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir('evolve-state-');
  });
  afterEach(async () => {
    await cleanup(dir);
  });

  it('round-trips through save/load with defaults filled in', async () => {
    const state = EvolveState.parse({
      concept: 'notes app',
      startedAt: '2026-09-21T00:00:00.000Z',
      maxRounds: 3,
      maxTasksPerRound: 12,
      rounds: [
        {
          round: 1,
          stage: 'assess',
          tasksPath: '/p/.fullauto/rounds/1/tasks.md',
          startedAt: '2026-09-21T00:00:01.000Z',
          runStartedAt: '2026-09-21T00:00:02.000Z',
          tasksDone: 3,
          tasksFailed: 1,
          backlogItems: ['F001', 'F002'],
        },
      ],
      options: { vibeEnhance: true },
    });
    expect(state.round).toBe(0);
    expect(state.placeholderEnvs).toEqual([]);
    expect(state.options).toEqual({ vibeEnhance: true, ux: false });
    expect(state.rounds[0].nextItems).toEqual([]);
    expect(state.rounds[0].featuresDone).toEqual([]);

    await saveEvolveState(dir, state);
    const raw = JSON.parse(await readFile(paths(dir).evolveStatePath, 'utf-8'));
    expect(raw.concept).toBe('notes app');
    const loaded = await loadEvolveState(dir);
    expect(loaded).toEqual(state);
    expect(await loadEvolveState(join(dir, 'nowhere'))).toBeNull();
  });

  it('rejects invalid shapes with a readable error', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const p = paths(dir);
    await mkdir(p.fullautoDir, { recursive: true });
    await writeFile(p.evolveStatePath, '{not json', 'utf-8');
    await expect(loadEvolveState(dir)).rejects.toThrow(/corrupted/);
    await writeFile(p.evolveStatePath, JSON.stringify({ concept: 'x', startedAt: 'y', maxRounds: 0, maxTasksPerRound: 1 }), 'utf-8');
    await expect(loadEvolveState(dir)).rejects.toThrow(/schema mismatch/);
    expect(() => EvolveState.parse({ concept: 'x', startedAt: 'y', maxRounds: 1, maxTasksPerRound: 1, rounds: [{ round: 1, stage: 'nope', tasksPath: '', startedAt: '' }] })).toThrow();
  });
});
