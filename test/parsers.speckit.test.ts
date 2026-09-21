import { describe, it, expect } from 'vitest';
import { parseTasksMarkdown, extractPrerequisites } from '../src/parsers/speckit.js';

describe('parseTasksMarkdown', () => {
  it('parses speckit 1.0.x task lines with [P] and [USx] labels', () => {
    const src = [
      '## Phase 1: Setup',
      '- [ ] T001 Create project structure',
      '- [ ] T002 [P] Configure linting',
      '',
      '## Phase 3: User Story 1 - Auth (Priority: P1)',
      '- [ ] T003 [P] [US1] Contract test for POST /login in tests/contract/login.test.ts',
      '- [ ] T004 [US1] Implement POST /login in src/routes/login.ts (depends on T003)',
      '  - response shape: { token }',
    ].join('\n');
    const tasks = parseTasksMarkdown(src);
    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002', 'T003', 'T004']);
    expect(tasks[1].title).toBe('Configure linting');
    expect(tasks[2].feature).toBe('US1');
    expect(tasks[0].feature).toBeUndefined();
    expect(tasks[3].dependencies).toEqual(['T003']);
    expect(tasks[3].body).toContain('response shape');
  });

  it('accepts task ids longer than three digits', () => {
    const tasks = parseTasksMarkdown('- [ ] T1000 Big id\n- [ ] T1001 Next (depends on T1000)');
    expect(tasks.map((t) => t.id)).toEqual(['T1000', 'T1001']);
    expect(tasks[1].dependencies).toEqual(['T1000']);
  });

  it('uses h2 headings as feature boundaries in hand-written mode', () => {
    const tasks = parseTasksMarkdown('## Feature: Auth\n- [ ] T001 a\n## Profile\n- [ ] T002 b');
    expect(tasks[0].feature).toBe('Auth');
    expect(tasks[1].feature).toBe('Profile');
  });

  it('strips the Manual Prerequisites section from the task list', () => {
    const src = '- [ ] T001 a\n\n## Manual Prerequisites\n<!-- fullauto:prerequisites -->\n- [ENV] FOO — bar';
    expect(parseTasksMarkdown(src)).toHaveLength(1);
    expect(extractPrerequisites(src)).toEqual([{ kind: 'ENV', identifier: 'FOO', description: 'bar' }]);
  });
});

describe('parseTasksMarkdown — line shapes and ID canonicalization', () => {
  it('accepts checked boxes, colon separators and `* ` / `+ ` bullets', () => {
    const tasks = parseTasksMarkdown(
      ['- [x] T001: Already done upstream', '* [ ] T002 Star bullet', '+ [ ] T003 - Plus bullet'].join('\n')
    );
    expect(tasks.map((t) => [t.id, t.title])).toEqual([
      ['T001', 'Already done upstream'],
      ['T002', 'Star bullet'],
      ['T003', 'Plus bullet'],
    ]);
    // Checkbox state is NOT imported — every parsed task starts pending.
    expect(tasks.every((t) => t.status === 'pending')).toBe(true);
  });

  it('canonicalizes numbered forms (`1.`, `(1)`, `T1`, `T01`) to T### and resolves deps against them', () => {
    const tasks = parseTasksMarkdown(
      ['1. First numbered', '(2) Paren numbered (depends on 1)', '- [ ] T3 Short id (depends on T01, 2)'].join('\n')
    );
    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002', 'T003']);
    expect(tasks[1].dependencies).toEqual(['T001']);
    expect(tasks[2].dependencies).toEqual(['T001', 'T002']);
  });

  it('auto-assigns IDs to unlabeled checkbox tasks without colliding with explicit IDs', () => {
    const tasks = parseTasksMarkdown(
      ['- [ ] No id here', '- [ ] T001 Explicit one', '- [ ] Another without id', '- [ ] T003 Explicit three'].join('\n')
    );
    expect(tasks.map((t) => t.id)).toEqual(['T002', 'T001', 'T004', 'T003']);
  });

  it('ignores prose, headings, and indented bullets that are not task lines', () => {
    const src = [
      '# Tasks for the widget',
      'Some intro paragraph that should not become a task.',
      '- plain bullet without checkbox or id',
      '- [ ] T001 Real task',
      '  - [ ] indented checkbox is body, not a task',
      'Trailing prose becomes body too.',
    ].join('\n');
    const tasks = parseTasksMarkdown(src);
    expect(tasks).toHaveLength(1);
    // Body is trimmed as a whole: the first line loses its indent, later lines keep theirs.
    expect(tasks[0].body).toBe('- [ ] indented checkbox is body, not a task\nTrailing prose becomes body too.');
  });

  it('folds sub-bullets and blank lines into the body, trims trailing blanks, and falls back to the title', () => {
    const src = ['- [ ] T001 Has body', '  - acceptance: works', '', '  - file: src/x.ts', '', '', '- [ ] T002 No body'].join('\n');
    const tasks = parseTasksMarkdown(src);
    expect(tasks[0].body).toBe('- acceptance: works\n\n  - file: src/x.ts');
    expect(tasks[1].body).toBe('No body');
  });

  it('handles CRLF line endings', () => {
    const tasks = parseTasksMarkdown('- [ ] T001 One\r\n  - detail\r\n- [ ] T002 Two (depends on T001)\r\n');
    expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
    expect(tasks[0].body).toBe('- detail');
    expect(tasks[1].dependencies).toEqual(['T001']);
  });

  it('returns [] for empty or task-less input', () => {
    expect(parseTasksMarkdown('')).toEqual([]);
    expect(parseTasksMarkdown('# Heading\n\nJust prose.\n')).toEqual([]);
  });
});

describe('parseTasksMarkdown — dependency extraction', () => {
  it('supports the `[depends: ...]` bracket form and strips it from the title', () => {
    const tasks = parseTasksMarkdown('- [ ] T001 a\n- [ ] T002 b\n- [ ] T003 Wire it up [depends: T001, T002]');
    expect(tasks[2].title).toBe('Wire it up');
    expect(tasks[2].dependencies).toEqual(['T001', 'T002']);
  });

  it('splits on commas, whitespace, "and" and "&", and is case-insensitive', () => {
    const tasks = parseTasksMarkdown('- [ ] T009 x (Depends On T1 and t2, T3 & 4 T5)');
    expect(tasks[0].dependencies).toEqual(['T001', 'T002', 'T003', 'T004', 'T005']);
    expect(tasks[0].title).toBe('x');
  });

  it('ignores tokens that merely contain digits (no dangling `T003` from `step3`)', () => {
    const tasks = parseTasksMarkdown('- [ ] T001 x (depends on step3 finished, T002)');
    expect(tasks[0].dependencies).toEqual(['T002']);
  });

  it('a task with no annotation has no dependencies and an untouched title', () => {
    const tasks = parseTasksMarkdown('- [ ] T001 Plain (with parens) title');
    expect(tasks[0].dependencies).toEqual([]);
    expect(tasks[0].title).toBe('Plain (with parens) title');
  });
});

describe('parseTasksMarkdown — feature grouping', () => {
  it('Speckit mode: [USx] label is the feature (case-insensitive), [P] is stripped, h2 headings are ignored', () => {
    const src = [
      '## Phase 2: Foundational',
      '- [ ] T001 [P] Setup db',
      '## Phase 3: User Story 2 - Profile',
      '- [ ] T002 [p] [us2] Profile page',
      '- [ ] T003 [US2][P] Profile API (depends on T001)',
    ].join('\n');
    const tasks = parseTasksMarkdown(src);
    expect(tasks[0].feature).toBeUndefined();
    expect(tasks[0].title).toBe('Setup db');
    expect(tasks[1].feature).toBe('US2');
    expect(tasks[1].title).toBe('Profile page');
    expect(tasks[2].feature).toBe('US2');
    expect(tasks[2].title).toBe('Profile API');
    expect(tasks[2].dependencies).toEqual(['T001']);
  });

  it('hand-written mode: tasks before the first h2 have no feature; `## Feature:` prefix is optional', () => {
    const src = ['- [ ] T001 pre', '## Feature: Auth', '- [ ] T002 a', '##   Billing  ', '- [ ] T003 b', '### h3 does not switch', '- [ ] T004 c'].join('\n');
    const tasks = parseTasksMarkdown(src);
    expect(tasks.map((t) => t.feature)).toEqual([undefined, 'Auth', 'Billing', 'Billing']);
  });

  it('an h2 heading closes the current task body', () => {
    const tasks = parseTasksMarkdown('## A\n- [ ] T001 a\n  - detail\n## B\n- [ ] T002 b');
    expect(tasks[0].body).toBe('- detail');
    expect(tasks[1].feature).toBe('B');
  });

  it('every parsed task is kind=user', () => {
    const tasks = parseTasksMarkdown('- [ ] T001 a\n- [ ] T002 b');
    expect(tasks.every((t) => t.kind === 'user')).toBe(true);
  });
});

describe('prerequisites section', () => {
  it('cuts the task list at `## Manual Prerequisites` even without the marker comment', () => {
    const src = '- [ ] T001 a\n\n## Manual Prerequisites\n- [ENV] API_KEY — for the client\n- [ ] T999 not a task';
    expect(parseTasksMarkdown(src).map((t) => t.id)).toEqual(['T001']);
  });

  it('cuts at the bare `<!-- fullauto:prerequisites -->` marker as well', () => {
    const src = '- [ ] T001 a\n<!-- fullauto:prerequisites -->\n- [ ] T002 swallowed';
    expect(parseTasksMarkdown(src).map((t) => t.id)).toEqual(['T001']);
  });

  it('extractPrerequisites returns [] when there is no section', () => {
    expect(extractPrerequisites('- [ ] T001 a')).toEqual([]);
  });

  it('parses each kind, splits identifier/description on em-dash, en-dash or spaced hyphen', () => {
    const src = [
      '- [ ] T001 a',
      '## Manual Prerequisites',
      '- [ENV] STRIPE_KEY — Stripe secret',
      '- [AUTH] gh auth login – needed for PR creation',
      '- [ACCOUNT] Vercel - create a team',
      '- [OTHER] Enable the beta flag in the dashboard',
      '- [env] lowercase_kind',
      '- free-form note that is not a prereq',
    ].join('\n');
    expect(extractPrerequisites(src)).toEqual([
      { kind: 'ENV', identifier: 'STRIPE_KEY', description: 'Stripe secret' },
      { kind: 'AUTH', identifier: 'gh auth login', description: 'needed for PR creation' },
      { kind: 'ACCOUNT', identifier: 'Vercel', description: 'create a team' },
      { kind: 'OTHER', identifier: '', description: 'Enable the beta flag in the dashboard' },
      { kind: 'ENV', identifier: 'lowercase_kind', description: '' },
    ]);
  });

  it('drops the planner\'s "None" sentinel but keeps descriptions that merely start with "None"', () => {
    const src = [
      '## Manual Prerequisites',
      '- [OTHER] None',
      '- [ENV] None.',
      '- [OTHER] None of the existing services support webhooks — set one up',
    ].join('\n');
    expect(extractPrerequisites(src)).toEqual([
      {
        kind: 'OTHER',
        identifier: 'None of the existing services support webhooks',
        description: 'set one up',
      },
    ]);
  });

  it('stops at the next markdown header of any depth', () => {
    const src = ['## Manual Prerequisites', '- [ENV] A — a', '### Notes', '- [ENV] B — should be ignored'].join('\n');
    expect(extractPrerequisites(src).map((p) => p.identifier)).toEqual(['A']);
  });
});

describe('loadTasksFromFile', () => {
  it('reads a file and throws a helpful error when no tasks parse', async () => {
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadTasksFromFile } = await import('../src/parsers/speckit.js');
    const dir = await mkdtemp(join(tmpdir(), 'fullauto-speckit-'));
    try {
      const good = join(dir, 'tasks.md');
      await writeFile(good, '- [ ] T001 a\n- [ ] T002 b (depends on T001)\n', 'utf-8');
      const tasks = await loadTasksFromFile(good);
      expect(tasks.map((t) => t.id)).toEqual(['T001', 'T002']);

      const empty = join(dir, 'empty.md');
      await writeFile(empty, '# nothing here\n', 'utf-8');
      await expect(loadTasksFromFile(empty)).rejects.toThrow(/No tasks parsed from .*empty\.md/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
