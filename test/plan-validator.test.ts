import { describe, it, expect } from 'vitest';
import { validatePlanShape } from '../src/plan-validator.js';
import { makeTask } from './helpers/fixtures.js';

describe('validatePlanShape — ok path', () => {
  it('accepts a well-formed plan with resolvable dependencies', () => {
    const res = validatePlanShape([
      makeTask('T001'),
      makeTask('T002', { dependencies: ['T001'] }),
      makeTask('T003', { dependencies: ['T001', 'T002'] }),
    ]);
    expect(res).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('accepts a single task with no dependencies', () => {
    expect(validatePlanShape([makeTask('T001')]).ok).toBe(true);
  });

  it('rejects an empty task list', () => {
    const res = validatePlanShape([]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(['Task list is empty.']);
  });
});

describe('validatePlanShape — duplicate IDs', () => {
  it('flags each duplicated ID once with its occurrence count', () => {
    const res = validatePlanShape([
      makeTask('T001'),
      makeTask('T001'),
      makeTask('T002'),
      makeTask('T002'),
      makeTask('T002'),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([
      'Duplicate task ID "T001" appears 2 times.',
      'Duplicate task ID "T002" appears 3 times.',
    ]);
  });
});

describe('validatePlanShape — dangling dependencies', () => {
  it('flags a dependency on an ID that is not in the list', () => {
    const res = validatePlanShape([
      makeTask('T001'),
      makeTask('T002', { dependencies: ['T999'] }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/^Task T002 depends on "T999" which is not in the task list/);
  });

  it('flags every dangling dep separately, in task order', () => {
    const res = validatePlanShape([
      makeTask('T001', { dependencies: ['T900', 'T901'] }),
      makeTask('T002', { dependencies: ['T900'] }),
    ]);
    expect(res.errors.map((e) => e.match(/^Task (T\d+) depends on "(T\d+)"/)?.slice(1))).toEqual([
      ['T001', 'T900'],
      ['T001', 'T901'],
      ['T002', 'T900'],
    ]);
  });

  it('does not report a cycle through a dangling dep (no noise on top of the dangling error)', () => {
    const res = validatePlanShape([
      makeTask('T001', { dependencies: ['T999'] }),
    ]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).not.toMatch(/cycle/i);
  });
});

describe('validatePlanShape — cycles', () => {
  it('reports a two-node cycle', () => {
    const res = validatePlanShape([
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T002', { dependencies: ['T001'] }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(['Dependency cycle: T001 → T002 → T001.']);
  });

  it('reports a self-dependency as a cycle', () => {
    const res = validatePlanShape([makeTask('T001', { dependencies: ['T001'] })]);
    expect(res.errors).toEqual(['Dependency cycle: T001 → T001.']);
  });

  it('reports a three-node cycle exactly once regardless of task order (rotations dedup)', () => {
    const a = makeTask('T001', { dependencies: ['T002'] });
    const b = makeTask('T002', { dependencies: ['T003'] });
    const c = makeTask('T003', { dependencies: ['T001'] });
    const orders = [
      [a, b, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    for (const order of orders) {
      const res = validatePlanShape(order);
      const cycleErrors = res.errors.filter((e) => e.startsWith('Dependency cycle:'));
      expect(cycleErrors, `order ${order.map((t) => t.id).join(',')}`).toHaveLength(1);
      // Every member appears in the single reported path.
      for (const id of ['T001', 'T002', 'T003']) {
        expect(cycleErrors[0]).toContain(id);
      }
    }
  });

  it('a cycle reached from an outside task is still reported once', () => {
    const res = validatePlanShape([
      makeTask('T000', { dependencies: ['T001'] }),
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T002', { dependencies: ['T001'] }),
      makeTask('T003', { dependencies: ['T002'] }),
    ]);
    const cycleErrors = res.errors.filter((e) => e.startsWith('Dependency cycle:'));
    expect(cycleErrors).toHaveLength(1);
    expect(cycleErrors[0]).toBe('Dependency cycle: T001 → T002 → T001.');
  });

  it('reports two independent cycles as two errors', () => {
    const res = validatePlanShape([
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T002', { dependencies: ['T001'] }),
      makeTask('T003', { dependencies: ['T004'] }),
      makeTask('T004', { dependencies: ['T003'] }),
    ]);
    expect(res.errors).toEqual([
      'Dependency cycle: T001 → T002 → T001.',
      'Dependency cycle: T003 → T004 → T003.',
    ]);
  });
});

describe('validatePlanShape — combined', () => {
  it('accumulates duplicate, dangling and cycle errors in that order', () => {
    const res = validatePlanShape([
      makeTask('T001'),
      makeTask('T001'),
      makeTask('T002', { dependencies: ['T003', 'T777'] }),
      makeTask('T003', { dependencies: ['T002'] }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(3);
    expect(res.errors[0]).toMatch(/^Duplicate task ID "T001" appears 2 times/);
    expect(res.errors[1]).toMatch(/^Task T002 depends on "T777"/);
    expect(res.errors[2]).toBe('Dependency cycle: T002 → T003 → T002.');
    expect(res.warnings).toEqual([]);
  });

  it('cycle detection for a duplicated ID sees only the LAST occurrence (documented quirk)', () => {
    // findCycles builds a Map keyed by id, so the last duplicate shadows the
    // earlier ones for cycle purposes. The plan is already rejected on the
    // duplicate, so this is harmless — but the queue uses first-wins, so a
    // cycle through the first occurrence is not reported here.
    const res = validatePlanShape([
      makeTask('T001', { dependencies: ['T002'] }),
      makeTask('T001'),
      makeTask('T002', { dependencies: ['T001'] }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual(['Duplicate task ID "T001" appears 2 times.']);
  });
});

describe('validatePlanShape — marker references', () => {
  const body = (lines: string[]) => lines.join('\n');

  it('`- tests:` / `- tested by:` naming a task outside the list is an error (ids are canonicalized)', () => {
    const res = validatePlanShape([
      makeTask('T001', { body: body(['Implement ping', '- tests: T999']) }),
      makeTask('T002', { body: body(['Implement pong', '- tested by: T3']) }),
      makeTask('T003', { body: body(['Tests for pong', '- tdd: red']) }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([
      expect.stringMatching(/^Task T001 says `- tests: T999` but T999 is not in the task list/),
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('`- wired by:` naming a task outside the list, or itself, is an error', () => {
    const res = validatePlanShape([
      makeTask('T001', { body: body(['Add helper', '- wired by: T404']) }),
      makeTask('T002', { body: body(['Add helper', '- wired by: T002']) }),
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors).toEqual([
      expect.stringMatching(/^Task T001 says `- wired by: T404` but T404 is not in the task list/),
      expect.stringMatching(/^Task T002 says `- wired by: T002` \(itself\)/),
    ]);
  });

  it('`- wired by:` naming a task that appears EARLIER in the file is a warning, later is fine', () => {
    const res = validatePlanShape([
      makeTask('T001', { body: body(['Wire things', 'depends on nothing']) }),
      makeTask('T002', { body: body(['Add helper', '- wired by: T001']) }),
      makeTask('T003', { body: body(['Add other helper', '- wired by: T004']) }),
      makeTask('T004', { body: body(['Wire other helper']), dependencies: ['T003'] }),
    ]);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([
      expect.stringMatching(/^Task T002 says `- wired by: T001` but T001 appears earlier in the file/),
    ]);
  });

  it('markers nested deeper than a task sub-bullet (embedded bodies) are not references', () => {
    const res = validatePlanShape([
      makeTask('T001', { body: body(['Enhance pass', '    - tests: T999', '    - wired by: T998']) }),
    ]);
    expect(res.ok).toBe(true);
  });
});
