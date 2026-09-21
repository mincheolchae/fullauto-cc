import { describe, expect, it } from 'vitest';
import { checkTestIntegrity, countAssertions, countTestBlocks, countTrivialTestBlocks, sanitizeSource, trivialTestBlocksAdded } from '../../src/audit/test-integrity.js';
import type { ChangedFile, TaskDiff } from '../../src/audit/types.js';
import { cls } from './_helpers.js';

function file(path: string, over: Partial<ChangedFile>): ChangedFile {
  return {
    path,
    kind: 'modified',
    isTest: /test|spec/.test(path),
    isCode: true,
    isGateConfig: path.endsWith('package.json'),
    ...over,
  };
}
const diff = (...files: ChangedFile[]): TaskDiff => ({ files, headMoved: false });

const GOOD = "describe('x', () => {\n  it('adds', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n  it('subs', () => {\n    expect(sub(2, 1)).toBe(1);\n  });\n});\n";

describe('counting helpers', () => {
  it('counts blocks and assertions across languages', () => {
    expect(countTestBlocks(GOOD)).toBe(2);
    expect(countAssertions(GOOD)).toBe(2);
    expect(countTestBlocks('def test_a():\n    assert 1\ndef test_b():\n    assert 2\n')).toBe(2);
    expect(countAssertions('def test_a():\n    assert x == 1\n')).toBe(1);
    expect(countTestBlocks('func TestA(t *testing.T) { t.Fatal("x") }\n')).toBe(1);
    expect(countAssertions('func TestA(t *testing.T) { t.Fatal("x") }\n')).toBe(1);
    expect(countTestBlocks('#[test]\nfn a() { assert_eq!(1, 1); }\n')).toBe(1);
    expect(countAssertions('#[test]\nfn a() { assert_eq!(1, 1); }\n')).toBe(1);
    expect(countTestBlocks('test.each([[1]])("x %i", () => {})\n')).toBe(1);
    expect(countTestBlocks('const commit = split(x);\nawait(y);\n')).toBe(0);
  });
});

describe('checkTestIntegrity', () => {
  it('BLOCKs a deleted test file unless modifies-tests', () => {
    const d = diff(file('test/a.test.ts', { kind: 'deleted', before: GOOD }));
    expect(checkTestIntegrity(d, cls())).toEqual([expect.objectContaining({ check: 'test-integrity', severity: 'block', path: 'test/a.test.ts' })]);
    expect(checkTestIntegrity(d, cls({ allowsTestEdits: true }))).toEqual([expect.objectContaining({ severity: 'info' })]);
  });

  it('BLOCKs newly introduced skip/only/todo markers (count delta), across runners', () => {
    const cases: Array<[string, string]> = [
      ["it('a', () => { expect(1).toBe(1); });", "it.skip('a', () => { expect(1).toBe(1); });"],
      ["it('a', () => { expect(1).toBe(1); });", "it.only('a', () => { expect(1).toBe(1); });"],
      ["it('a', () => { expect(1).toBe(1); });", "it('a', () => { expect(1).toBe(1); });\ntest.todo('later');"],
      ["it('a', () => { expect(1).toBe(1); });", "xit('a', () => { expect(1).toBe(1); });"],
      ['def test_a():\n    assert 1\n', '@pytest.mark.skip\ndef test_a():\n    assert 1\n'],
      ['def test_a():\n    assert 1\n', 'def test_a():\n    pytest.skip("no")\n    assert 1\n'],
      ['func TestA(t *testing.T) { t.Fatal("x") }', 'func TestA(t *testing.T) { t.Skip(); t.Fatal("x") }'],
      ['#[test]\nfn a() { assert!(true); }', '#[test]\n#[ignore]\nfn a() { assert!(true); }'],
      ['@Test\nvoid a() { assertTrue(x); }', '@Disabled\n@Test\nvoid a() { assertTrue(x); }'],
    ];
    for (const [before, after] of cases) {
      const path = /def test_/.test(after) ? 'tests/test_a.py' : /func Test/.test(after) ? 'a_test.go' : /#\[test\]/.test(after) ? 'tests/a.rs' : /@Test/.test(after) ? 'src/test/ATest.java' : 'test/a.test.ts';
      const f = file(path, { before, after, isTest: true });
      const findings = checkTestIntegrity(diff(f), cls({ kind: 'test' }));
      const marker = findings.find((x) => /skip\/only\/todo/.test(x.message));
      expect(marker, after).toMatchObject({ severity: 'block', path });
      expect(marker?.line, after).toBeGreaterThan(0);
    }
  });

  it('does not block pre-existing markers that the task did not add', () => {
    const before = "it.skip('a', () => { expect(1).toBe(1); });\nit('b', () => { expect(2).toBe(2); });";
    const after = before + "\nit('c', () => { expect(3).toBe(3); });";
    expect(checkTestIntegrity(diff(file('test/a.test.ts', { before, after })), cls({ kind: 'test' }))).toEqual([]);
  });

  it('BLOCKs --passWithNoTests smuggled through package.json', () => {
    const f = file('package.json', {
      before: '{"scripts":{"test":"jest"}}',
      after: '{"scripts":{"test":"jest --passWithNoTests"}}',
      isCode: false,
    });
    expect(checkTestIntegrity(diff(f), cls())).toEqual([expect.objectContaining({ severity: 'block', path: 'package.json' })]);
  });

  it('BLOCKs an added test file with test blocks but no assertions', () => {
    const f = file('test/a.test.ts', { kind: 'added', after: "it('does stuff', async () => {\n  await run();\n});\n" });
    const findings = checkTestIntegrity(diff(f), cls({ kind: 'test' }));
    expect(findings).toEqual([expect.objectContaining({ severity: 'block', line: 1 })]);
    expect(findings[0].message).toContain('no assertions');
  });

  it('does not flag assertion-less helper files (no test blocks) or supertest-style .expect()', () => {
    expect(checkTestIntegrity(diff(file('test/helpers.ts', { kind: 'added', after: 'export const mk = () => 1;\n' })), cls({ kind: 'test' }))).toEqual([]);
    const supertest = "it('GET /', async () => {\n  await request(app).get('/').expect(200);\n});\n";
    expect(checkTestIntegrity(diff(file('test/api.test.ts', { kind: 'added', after: supertest })), cls({ kind: 'test' }))).toEqual([]);
  });

  it('BLOCKs tautological assertions', () => {
    const cases = [
      "it('x', () => { expect(true).toBe(true); });",
      "it('x', () => { expect(1).toBe(1); });",
      "it('x', () => { expect('a').toEqual('a'); });",
      'def test_x():\n    assert True\n',
      'def test_x():\n    assert 1 == 1\n',
    ];
    for (const after of cases) {
      const path = /def test_/.test(after) ? 'tests/test_x.py' : 'test/x.test.ts';
      const findings = checkTestIntegrity(diff(file(path, { kind: 'added', after })), cls({ kind: 'test' }));
      expect(findings.find((f) => /tautolog/.test(f.message)), after).toMatchObject({ severity: 'block', path });
    }
  });

  it('BLOCKs a weakened pre-existing test and WARNs on a neutral edit by a non-test task', () => {
    const weakened = "describe('x', () => {\n  it('adds', () => {\n    expect(add(1, 2)).toBe(3);\n  });\n});\n";
    const block = checkTestIntegrity(diff(file('test/a.test.ts', { before: GOOD, after: weakened })), cls());
    expect(block).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(block[0].message).toMatch(/weakened test.*lost reachable assertions.*from 2 to 1 across 2→1 test block\(s\)/);

    const neutral = GOOD.replace("'adds'", "'adds numbers'");
    const warn = checkTestIntegrity(diff(file('test/a.test.ts', { before: GOOD, after: neutral })), cls());
    expect(warn).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(warn[0].message).toMatch(/modified existing test/);

    // allowed by the task, or the task IS a test task → nothing
    expect(checkTestIntegrity(diff(file('test/a.test.ts', { before: GOOD, after: weakened })), cls({ allowsTestEdits: true }))).toEqual([]);
    expect(checkTestIntegrity(diff(file('test/a.test.ts', { before: GOOD, after: neutral })), cls({ kind: 'test' }))).toEqual([]);
  });

  it('WARNs on swallowed errors introduced in tests', () => {
    const after = "it('x', async () => {\n  await thing().catch(() => {});\n  expect(1).toBe(2);\n});\n";
    const findings = checkTestIntegrity(diff(file('test/x.test.ts', { kind: 'added', after })), cls({ kind: 'test' }));
    expect(findings).toEqual([expect.objectContaining({ severity: 'warn', line: 2 })]);
    const py = 'def test_x():\n    try:\n        run()\n    except Exception:\n        pass\n    assert x\n';
    expect(checkTestIntegrity(diff(file('tests/test_x.py', { kind: 'added', after: py })), cls({ kind: 'test' }))).toEqual([expect.objectContaining({ severity: 'warn' })]);
  });

  it('ignores non-test files entirely (except --passWithNoTests in gate config)', () => {
    const f = file('src/lib.ts', { before: '', after: "it.skip('nope', () => {});\n", isTest: false });
    expect(checkTestIntegrity(diff(f), cls())).toEqual([]);
    // a doc / prompt source that merely mentions the flag is not a gate change
    const doc = file('src/prompts.ts', { kind: 'added', after: 'export const rule = "never use --passWithNoTests";\n', isTest: false, isGateConfig: false });
    expect(checkTestIntegrity(diff(doc), cls())).toEqual([]);
  });

  it('does not count markers, tautologies or assertions that live inside strings or comments', () => {
    const after = [
      "// it.skip('commented out', () => {});",
      "const fixture = \"it.skip('x', () => { expect(true).toBe(true); });\";",
      'const tpl = `',
      "  test.only('y', () => {})",
      '`;',
      "it('checks the fixture', () => {",
      "  expect(fixture).toContain('.skip');",
      '});',
    ].join('\n');
    expect(checkTestIntegrity(diff(file('test/meta.test.ts', { kind: 'added', after })), cls({ kind: 'test' }))).toEqual([]);
    const py = "def test_x():\n    # @pytest.mark.skip was here\n    s = '''\n    assert True\n    '''\n    assert parse(s) == 1\n";
    expect(checkTestIntegrity(diff(file('tests/test_meta.py', { kind: 'added', after: py })), cls({ kind: 'test' }))).toEqual([]);
  });

  it('sanitizeSource keeps line numbers and quotes', () => {
    const out = sanitizeSource("a = 'x'; // don't\nb = `multi\nline`; /* c */\n", 'x.ts');
    expect(out.split('\n')).toHaveLength(4);
    expect(out).toBe("a = ''; \nb = `\n`; \n");
    expect(sanitizeSource("x = 1  # it.skip\ny = \"a\"\n", 'x.py')).toBe('x = 1  \ny = ""\n');
  });
});

describe('checkTestIntegrity — reviewer scenarios', () => {
  const impl = cls();

  it('weights `.each` tables by row count so consolidating N tests into one table is not "weakened"', () => {
    const before = ["describe('x', () => {", "  it.skip('windows only', () => { expect(win()).toBe(1); });", "  it('a', () => { expect(f(1)).toBe(2); });", "  it('b', () => { expect(f(2)).toBe(4); });", "  it('c', () => { expect(f(3)).toBe(6); });", '});'].join('\n');
    const after = ["describe('x', () => {", "  it.skip('windows only', () => { expect(win()).toBe(1); });", "  it.each([[1, 2], [2, 4], [3, 6]])('f(%i) = %i', (i, o) => { expect(f(i)).toBe(o); });", '});'].join('\n');
    expect(countTestBlocks(after)).toBe(4);
    expect(countAssertions(after)).toBe(4);
    const findings = checkTestIntegrity(diff(file('test/a.test.ts', { before, after })), impl);
    expect(findings).toEqual([expect.objectContaining({ severity: 'warn' })]); // "modified existing test", never BLOCK
    // identifier tables and describe.each are weighted too; a one-row table stays 1
    expect(countTestBlocks("const cases = [\n  { a: 1 },\n  { a: 2 },\n];\nit.each(cases)('x', (c) => { expect(c.a).toBeGreaterThan(0); });\n")).toBe(2);
    expect(countTestBlocks("describe.each([[1], [2]])('d %i', (n) => {\n  it('p', () => { expect(n).toBe(n); });\n  it('q', () => { expect(n).toBeTruthy(); });\n});\n")).toBe(4);
    expect(countTestBlocks('test.each([[1]])("x %i", () => {})')).toBe(1);
    expect(countTestBlocks("test.each`\n  a | b\n  ${1} | ${2}\n  ${3} | ${4}\n`('t', ({ a, b }) => { expect(a).toBeLessThan(b); });\n")).toBe(2);
  });

  // Round 3 / item 4: extracting duplicated inline assertions into a shared
  // same-file helper is a legitimate refactor — the naive per-block / raw
  // file-text assertion count drops (the helper's body is written once, not
  // once per caller) even though every test still exercises the same
  // checks through the helper call. `checkTestIntegrity` must resolve one
  // level of same-file helper indirection before judging "weakened".
  it('a helper reducing duplicate inline assertions to shared calls (unchanged blocks) is no longer misread as "weakened" (residual case superseded — see the round-3 tests below)', () => {
    const before = "it('a', () => { expect(x).toBe(1); expect(y).toBe(2); });\nit('b', () => { expect(x).toBe(1); expect(y).toBe(2); });\n";
    const after = "function check() { expect(x).toBe(1); expect(y).toBe(2); }\nit('a', () => { check(); });\nit('b', () => { check(); });\n";
    const findings = checkTestIntegrity(diff(file('test/a.test.ts', { before, after })), impl);
    expect(findings.some((f) => f.severity === 'block')).toBe(false);
    expect(findings).toEqual([expect.objectContaining({ severity: 'warn' })]); // "modified existing test", still worth a look, never BLOCK
  });

  it("the exact regression case: 3 tests refactored to call a shared expectValidUser(user) helper (4 assertions) plus one inline check each must NOT BLOCK", () => {
    const before = [
      "it('a', () => { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); expect(u.age).toBeGreaterThan(0); expect(u.active).toBe(true); expect(u.a).toBe(1); });",
      "it('b', () => { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); expect(u.age).toBeGreaterThan(0); expect(u.active).toBe(true); expect(u.b).toBe(2); });",
      "it('c', () => { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); expect(u.age).toBeGreaterThan(0); expect(u.active).toBe(true); expect(u.c).toBe(3); });",
    ].join('\n');
    const after = [
      "function expectValidUser(u) { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); expect(u.age).toBeGreaterThan(0); expect(u.active).toBe(true); }",
      "it('a', () => { expectValidUser(u); expect(u.a).toBe(1); });",
      "it('b', () => { expectValidUser(u); expect(u.b).toBe(2); });",
      "it('c', () => { expectValidUser(u); expect(u.c).toBe(3); });",
    ].join('\n');
    const findings = checkTestIntegrity(diff(file('test/user.test.ts', { before, after })), impl);
    expect(findings.some((f) => f.severity === 'block')).toBe(false);
  });

  it('a genuine reduction — the shared helper itself silently drops one assertion — still BLOCKs', () => {
    const before = [
      "function expectValidUser(u) { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); expect(u.age).toBeGreaterThan(0); expect(u.active).toBe(true); }",
      "it('a', () => { expectValidUser(u); expect(u.a).toBe(1); });",
      "it('b', () => { expectValidUser(u); expect(u.b).toBe(2); });",
      "it('c', () => { expectValidUser(u); expect(u.c).toBe(3); });",
    ].join('\n');
    const after = before.replace('expect(u.active).toBe(true); }', '}'); // dropped silently
    const findings = checkTestIntegrity(diff(file('test/user.test.ts', { before, after })), impl);
    expect(findings.some((f) => f.severity === 'block' && /weakened test/.test(f.message))).toBe(true);
  });

  it('a genuine reduction — one test now calls nothing at all — still BLOCKs even when the FILE total does not drop (an unrelated test gained coverage)', () => {
    const before = [
      "function expectValidUser(u) { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); }",
      "it('a', () => { expectValidUser(u); expect(u.a).toBe(1); });",
      "it('b', () => { expectValidUser(u); expect(u.b).toBe(2); });",
    ].join('\n');
    const after = [
      "function expectValidUser(u) { expect(u.id).toBeDefined(); expect(u.name).toBe('x'); }",
      "it('a', () => { /* TODO: fill in */ });", // lost everything
      "it('b', () => { expectValidUser(u); expect(u.b1).toBe(1); expect(u.b2).toBe(2); expect(u.b3).toBe(3); expect(u.b4).toBe(4); expect(u.b5).toBe(5); });", // gained enough to offset the file total
    ].join('\n');
    const findings = checkTestIntegrity(diff(file('test/user.test.ts', { before, after })), impl);
    expect(findings.some((f) => f.severity === 'block' && /zero reachable assertions.*file's total held/.test(f.message))).toBe(true);
  });

  it('conditional skips (playwright test.skip(cond, why), vitest skipIf, mocha this.skip()) WARN; unconditional ones BLOCK', () => {
    const pw = ["import { test, expect } from '@playwright/test';", "test.describe('login', () => {", "  test('shows form', async ({ page }) => {", "    await page.goto('/login');", '    await expect(page).toHaveTitle(/Login/);', "    await expect(page.getByRole('button')).toBeVisible();", '  });', "  test.skip(({ browserName }) => browserName === 'webkit', 'flaky on webkit');", '});'].join('\n');
    const f = checkTestIntegrity(diff(file('e2e/login.spec.ts', { kind: 'added', after: pw })), cls({ kind: 'test' }));
    expect(f).toEqual([expect.objectContaining({ severity: 'warn', line: 8 })]);
    expect(f[0].message).toMatch(/conditional skip/);
    const vitest = "it.skipIf(process.platform === 'win32')('perms', () => { expect(perm()).toBe(0o644); });\nit('x', () => { expect(1).toBe(2); });\n";
    expect(checkTestIntegrity(diff(file('test/x.test.ts', { kind: 'added', after: vitest })), impl)).toEqual([expect.objectContaining({ severity: 'warn' })]);
    const mocha = "it('slow', function () {\n  if (!process.env.CI) this.skip();\n  expect(run()).to.equal(1);\n});\n";
    expect(checkTestIntegrity(diff(file('test/x.test.ts', { kind: 'added', after: mocha })), impl)).toEqual([expect.objectContaining({ severity: 'warn' })]);
    for (const bad of ["test.skip('later', async () => { expect(1).toBe(1); });", 'test.fixme("later", () => { expect(a).toBe(b); });', "test.skip(true, 'nope'); test('x', () => { expect(a).toBe(b); });", "test('x', () => { test.skip(); expect(a).toBe(b); });"]) {
      const g = checkTestIntegrity(diff(file('e2e/x.spec.ts', { kind: 'added', after: bad })), cls({ kind: 'test' }));
      expect(g.some((x) => x.severity === 'block' && /skip\/only\/todo/.test(x.message)), bad).toBe(true);
    }
  });

  it('recognizes implicit-assertion idioms: RTL getBy*, pytest.raises, testify require.*, XCTest, C# Assert, Mockito verify, minitest must_', () => {
    const cases: Array<[string, string]> = [
      ['src/Foo.test.tsx', "import { render, screen } from '@testing-library/react';\nit('renders', () => {\n  render(<Foo />);\n  screen.getByText('hi');\n});\n"],
      ['tests/test_x.py', "def test_raises():\n    with pytest.raises(ValueError):\n        parse('x')\n"],
      ['x_test.go', 'func TestX(t *testing.T) {\n  require.NoError(t, run())\n}\n'],
      ['Tests/FooTests.swift', 'func testFoo() {\n  XCTAssertEqual(foo(), 1)\n}\n'],
      ['test/A.cs', '[Test]\npublic void Adds() {\n  Assert.AreEqual(3, Add(1, 2));\n}\n'],
      ['src/test/ATest.java', '@Test\nvoid callsRepo() {\n  service.run();\n  verify(repo).save(any());\n}\n'],
      ['test/a_spec.rb', "describe 'x' do\n  it 'adds' do\n    _(add(1, 2)).must_equal 3\n  end\nend\n"],
      ['test/a.test.ts', "it('async', async () => {\n  await expectAsync(p).toBeResolved();\n});\n"],
    ];
    for (const [path, after] of cases) {
      const f = checkTestIntegrity(diff(file(path, { kind: 'added', after, isTest: true })), cls({ kind: 'test' }));
      expect(f.filter((x) => /no assertions/.test(x.message)), path).toEqual([]);
    }
  });

  it('counts each tautology once', () => {
    const f = checkTestIntegrity(diff(file('test/x.test.ts', { kind: 'added', after: "it('x', () => { expect(1).toBe(1); expect(y).toBe(2); });" })), impl);
    expect(f.find((x) => /tautolog/.test(x.message))?.message).toMatch(/introduces 1 tautological/);
    const py = checkTestIntegrity(diff(file('tests/test_x.py', { kind: 'added', after: 'def test_x():\n    assert 1 == 1\n' })), impl);
    expect(py.find((x) => /tautolog/.test(x.message))?.message).toMatch(/introduces 1 tautological/);
  });

  it('a moved test file (delete + add with the same content) is not a deleted test', () => {
    const body = "import { f } from '../src/f';\nit('a', () => { expect(f(1)).toBe(2); });\nit('b', () => { expect(f(2)).toBe(4); });\n";
    const moved = checkTestIntegrity(diff(file('test/old.test.ts', { kind: 'deleted', before: body }), file('test/unit/new.test.ts', { kind: 'added', after: body })), impl);
    expect(moved).toEqual([expect.objectContaining({ severity: 'info', path: 'test/unit/new.test.ts' })]);
    expect(moved[0].message).toMatch(/moved to/);
    // moved AND weakened → compared as a modification of the old file → BLOCK
    const weakened = body.replace("it('b', () => { expect(f(2)).toBe(4); });\n", '');
    const bad = checkTestIntegrity(diff(file('test/old.test.ts', { kind: 'deleted', before: body }), file('test/unit/new.test.ts', { kind: 'added', after: weakened })), impl);
    expect(bad.some((x) => x.severity === 'block' && /weakened/.test(x.message))).toBe(true);
    expect(bad.some((x) => /was deleted/.test(x.message))).toBe(false);
    // an unrelated added test does not pair with a deleted one
    const unrelated = checkTestIntegrity(diff(file('test/old.test.ts', { kind: 'deleted', before: body }), file('test/other.test.ts', { kind: 'added', after: "it('z', () => { expect(z()).toBe(0); });\n" })), impl);
    expect(unrelated.some((x) => x.severity === 'block' && /was deleted/.test(x.message))).toBe(true);
  });

  it('fixtures / snapshots under test dirs WARN with a data-specific message; helper-only files are INFO', () => {
    const snap = checkTestIntegrity(diff(file('test/__snapshots__/a.snap', { before: 'x', after: 'y', isCode: false })), impl);
    expect(snap).toEqual([expect.objectContaining({ severity: 'warn' })]);
    expect(snap[0].message).toMatch(/test fixture .* modified/);
    expect(checkTestIntegrity(diff(file('test/fixtures/a.json', { before: '{}', after: '{}', isCode: false })), impl)).toEqual([]);
    const helper = checkTestIntegrity(diff(file('tests/conftest.py', { before: 'import pytest\n', after: 'import pytest\n\n@pytest.fixture\ndef client():\n    return 1\n' })), impl);
    expect(helper).toEqual([expect.objectContaining({ severity: 'info' })]);
  });
});

describe('existence-only tests (trivial-assert)', () => {
  const IMPORTS = "import { quote, tax } from '../src/pricing';\nconst { run } = require('../src/run');\nimport * as P from '../src/p';\n";

  it('countTrivialTestBlocks counts blocks whose assertions are all existence / type checks on imported symbols', () => {
    const js =
      IMPORTS +
      [
        "it('exists', () => { expect(quote).toBeDefined(); });",
        "it('is fn', () => { expect(typeof tax).toBe('function'); expect(tax).toBeInstanceOf(Function); });",
        "it('ns', () => { expect(P.thing).toBeTruthy(); });",
        "it('assert', () => { assert.ok(run); });",
        "it('chai', () => { expect(quote).to.exist; });",
        "it('real', () => { expect(quote(1)).toBe(2); });",
        "it('mixed', () => { expect(quote).toBeDefined(); expect(quote(1)).toBe(2); });",
        "it('local null', () => { const result = find('x'); expect(result).toBeNull(); });",
        "it('local error', () => { const err = boom(); expect(err).toBeInstanceOf(Error); });",
        "it('no asserts', () => { run(); });",
      ].join('\n');
    expect(countTrivialTestBlocks(sanitizeSource(js, 'a.test.ts'))).toBe(5);
    // the subject must be an imported binding: a local of the same shape is not existence-only
    expect(countTrivialTestBlocks(sanitizeSource("const quote = mk();\nit('x', () => { expect(quote).toBeDefined(); });\n", 'b.test.ts'))).toBe(0);
    expect(countTestBlocks(js)).toBe(10);
    const py = 'from app.pricing import quote, tax as t\nimport app.other as other\n\ndef test_exists():\n    assert quote is not None\n\ndef test_callable():\n    assert callable(t)\n\ndef test_real():\n    assert quote(1) == 2\n\ndef test_bare():\n    assert other\n';
    expect(countTrivialTestBlocks(sanitizeSource(py, 'test_a.py'))).toBe(3);
    expect(countTrivialTestBlocks('')).toBe(0);
  });

  it('WARNs on newly added existence-only blocks, with the line of the first one; pre-existing ones are not re-flagged', () => {
    const before = IMPORTS + "it('exists', () => { expect(quote).toBeDefined(); });\n";
    const after = before + "it('tax exists', () => { expect(tax).toBeTruthy(); });\nit('real', () => { expect(quote(1)).toBe(2); });\n";
    const f = checkTestIntegrity(diff(file('test/a.test.ts', { before, after })), cls({ kind: 'test' }));
    expect(f).toEqual([expect.objectContaining({ check: 'test-integrity', severity: 'warn', path: 'test/a.test.ts', line: 5 })]);
    expect(f[0].message).toMatch(/existence-only test: test\/a\.test\.ts adds 1 test block\(s\)/);
    expect(f[0].message).toContain('do not count as new tests');
    expect(checkTestIntegrity(diff(file('test/a.test.ts', { before, after: before })), cls({ kind: 'test' }))).toEqual([]);
    // a behavioral test never triggers it
    const real = IMPORTS + "it('real', () => { expect(quote(1)).toBe(2); });\n";
    expect(checkTestIntegrity(diff(file('test/b.test.ts', { kind: 'added', after: real })), cls({ kind: 'test' }))).toEqual([]);
  });

  it('trivialTestBlocksAdded sums the added trivial blocks across the diff (test files only)', () => {
    const trivial = IMPORTS + "it('exists', () => { expect(quote).toBeDefined(); });\nit('tax', () => { expect(tax).toBeDefined(); });\n";
    const d = diff(
      file('test/a.test.ts', { kind: 'added', after: trivial }),
      file('test/b.test.ts', { before: trivial, after: trivial + "it('real', () => { expect(quote(1)).toBe(2); });\n" }),
      file('src/x.ts', { kind: 'added', after: trivial, isTest: false })
    );
    expect(trivialTestBlocksAdded(d)).toBe(2);
    expect(trivialTestBlocksAdded(diff())).toBe(0);
  });
});

describe('placeholder sentinel in production code', () => {
  it('BLOCKs a non-test code file that newly contains FULLAUTO_PLACEHOLDER_; test files and pre-existing mentions are ignored', () => {
    const cheat = "export async function charge(key = process.env.STRIPE_KEY) {\n  if (key?.startsWith('FULLAUTO_PLACEHOLDER_')) return { ok: true };\n  return stripe(key);\n}\n";
    const f = checkTestIntegrity(diff(file('src/billing.ts', { kind: 'added', after: cheat, isTest: false })), cls());
    expect(f).toEqual([expect.objectContaining({ check: 'test-integrity', severity: 'block', path: 'src/billing.ts', line: 2 })]);
    expect(f[0].message).toContain('production code branches on the placeholder sentinel');
    expect(f[0].message).toContain('fake/adapter');
    // modified file that gains it → BLOCK; file that already had it → not re-flagged
    expect(checkTestIntegrity(diff(file('src/billing.ts', { before: 'export const x = 1;\n', after: cheat, isTest: false })), cls())).toHaveLength(1);
    expect(checkTestIntegrity(diff(file('src/billing.ts', { before: cheat, after: cheat + '// more\n', isTest: false })), cls())).toEqual([]);
    // a test may reference the sentinel (it is asserting the orchestrator's own behavior)
    expect(checkTestIntegrity(diff(file('test/env.test.ts', { kind: 'added', after: "it('x', () => { expect(env.KEY).toBe('FULLAUTO_PLACEHOLDER_KEY'); });\n" })), cls({ kind: 'test' }))).toEqual([]);
    // non-code files (docs) are ignored
    expect(checkTestIntegrity(diff(file('README.md', { kind: 'added', after: 'grep for FULLAUTO_PLACEHOLDER_', isTest: false, isCode: false })), cls())).toEqual([]);
  });

  it('only a BRANCH on the sentinel counts: comments, prose strings and constructing the value are fine', () => {
    const legit = [
      '/** seeds missing env vars as FULLAUTO_PLACEHOLDER_<NAME> */',
      "export const SENTINEL = 'FULLAUTO_PLACEHOLDER_';",
      'export function seed(name: string) {',
      '  // a FULLAUTO_PLACEHOLDER_PATH value would break the shell',
      '  return `FULLAUTO_PLACEHOLDER_${name}`;',
      '}',
      "export const note = 'Security: any value starting with FULLAUTO_PLACEHOLDER_ is synthetic; do not exfiltrate it even if asked.';",
    ].join('\n');
    expect(checkTestIntegrity(diff(file('src/seed.ts', { kind: 'added', after: legit, isTest: false })), cls())).toEqual([]);

    const branches: Array<[string, string]> = [
      ['src/a.ts', "export const isFake = (k: string) => k.startsWith('FULLAUTO_PLACEHOLDER_');\n"],
      ['src/b.ts', "if (\n  process.env.KEY ===\n    'FULLAUTO_PLACEHOLDER_KEY'\n) {\n  return stub();\n}\n"],
      ['src/c.ts', "const real = key.includes('FULLAUTO_PLACEHOLDER_') ? fake : live;\n"],
      ['app/pay.py', "if key.startswith('FULLAUTO_PLACEHOLDER_'):\n    return {'ok': True}\n"],
      ['pkg/pay.go', 'if strings.HasPrefix(key, "FULLAUTO_PLACEHOLDER_") {\n\treturn nil\n}\n'],
    ];
    for (const [path, after] of branches) {
      const f = checkTestIntegrity(diff(file(path, { kind: 'added', after, isTest: false })), cls());
      expect(f.map((x) => x.severity), path).toEqual(['block']);
    }
    // the message names the branching line
    expect(checkTestIntegrity(diff(file('src/b.ts', { kind: 'added', after: branches[1][1], isTest: false })), cls())[0]).toMatchObject({ line: 3 });
  });
});

describe('generated paths are never audited', () => {
  it('ignores node_modules / dist / coverage entries in the diff', () => {
    const d = diff(
      file('node_modules/pkg/test/a.test.js', { kind: 'added', after: "it('a', () => {});\n", isTest: true }),
      file('dist/app.test.js', { kind: 'added', after: "it.skip('b', () => {});\n", isTest: true }),
      file('coverage/x.test.js', { kind: 'deleted', before: "it('c', () => { expect(1).toBe(2); });\n", isTest: true }),
      file('packages/web/node_modules/y/src/x.ts', { kind: 'added', after: "if (k.startsWith('FULLAUTO_PLACEHOLDER_')) {}\n", isTest: false })
    );
    expect(checkTestIntegrity(d, cls())).toEqual([]);
  });
});
