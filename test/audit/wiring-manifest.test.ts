import { afterEach, describe, expect, it } from 'vitest';
import { checkWiringClaims, hasWiringBlock, parseClaimLine, parseWiringClaims } from '../../src/audit/wiring-manifest.js';
import type { TaskDiff } from '../../src/audit/types.js';
import { cls, makeRepo, type TempRepo } from './_helpers.js';

const repos: TempRepo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const emptyDiff: TaskDiff = { files: [], headMoved: false };
const addedDiff = (path: string): TaskDiff => ({
  files: [{ path, kind: 'added', after: '', isCode: true, isTest: false, isGateConfig: false }],
  headMoved: false,
});

describe('parseWiringClaims', () => {
  it('parses the LAST block with path#symbol -> consumer:line and note forms', () => {
    const stdout = [
      'thinking...',
      'FULLAUTO_WIRING:',
      '- src/old.ts -> src/nope.ts',
      '',
      'Done. Final manifest:',
      'FULLAUTO_WIRING:',
      '- src/components/Foo.tsx -> src/app/page.tsx:12',
      '- `src/lib/pricing.ts#calculatePrice` -> src/routes/checkout.ts',
      '- src/lib/legacy.ts -> (entrypoint: next.js route file)',
      '* src/lib/x.ts → src/y.ts:3:4',
      '',
      'Some trailing prose that is not a claim',
    ].join('\n');
    expect(parseWiringClaims(stdout)).toEqual([
      { artifactPath: 'src/components/Foo.tsx', consumerPath: 'src/app/page.tsx', consumerLine: 12 },
      { artifactPath: 'src/lib/pricing.ts', symbol: 'calculatePrice', consumerPath: 'src/routes/checkout.ts' },
      { artifactPath: 'src/lib/legacy.ts', note: 'entrypoint: next.js route file' },
      { artifactPath: 'src/lib/x.ts', consumerPath: 'src/y.ts', consumerLine: 3 },
    ]);
  });

  it('returns [] without a block, tolerates fenced headers', () => {
    expect(parseWiringClaims('no manifest here')).toEqual([]);
    expect(hasWiringBlock('no manifest here')).toBe(false);
    expect(hasWiringBlock('```\nFULLAUTO_WIRING:\n```')).toBe(true);
    expect(parseWiringClaims('FULLAUTO_WIRING:\n')).toEqual([]);
    expect(parseClaimLine('garbage without arrow')).toBeUndefined();
  });
});

describe('checkWiringClaims', () => {
  it('BLOCKs when the consumer is missing or does not reference the artifact / symbol', async () => {
    const repo = makeRepo({ 'src/app.ts': "import { quote } from './lib/pricing';\n", 'src/other.ts': 'const x = 1;\n' });
    repos.push(repo);
    const claims = parseWiringClaims(
      [
        'FULLAUTO_WIRING:',
        '- src/lib/pricing.ts -> src/app.ts',
        '- src/lib/pricing.ts#tax -> src/app.ts',
        '- src/lib/pricing.ts -> src/other.ts',
        '- src/lib/pricing.ts -> src/missing.ts',
        '- src/lib/pricing.ts -> src/lib/pricing.ts',
        '- scripts/seed.ts -> (entrypoint: run by npm script)',
      ].join('\n')
    );
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls());
    expect(findings.map((f) => [f.severity, f.path])).toEqual([
      ['block', 'src/app.ts'],
      ['block', 'src/other.ts'],
      ['block', 'src/missing.ts'],
      ['block', 'src/lib/pricing.ts'],
    ]);
    expect(findings[0].message).toContain('does not reference tax');
    expect(findings[2].message).toContain('does not exist');
  });

  it('accepts a claim when the consumer references the symbol', async () => {
    const repo = makeRepo({ 'src/app.ts': "import { quote } from './lib/pricing';\nquote();\n" });
    repos.push(repo);
    const claims = parseWiringClaims('FULLAUTO_WIRING:\n- src/lib/pricing.ts#quote -> src/app.ts:1\n');
    expect(await checkWiringClaims(claims, emptyDiff, repo.dir, cls())).toEqual([]);
  });

  it('treats `(wired by T###)` notes as INFO, never BLOCK', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const claims = parseWiringClaims('FULLAUTO_WIRING:\n- src/lib/pricing.ts -> (wired by T007)\n- scripts/cron.ts -> (entrypoint: cron)\n');
    const same = await checkWiringClaims(claims, addedDiff('src/lib/pricing.ts'), repo.dir, cls({ wiredBy: 'T007' }), 'x');
    expect(same).toEqual([expect.objectContaining({ severity: 'info', path: 'src/lib/pricing.ts' })]);
    const unset = await checkWiringClaims(claims, addedDiff('src/lib/pricing.ts'), repo.dir, cls(), 'x');
    expect(unset.filter((f) => f.severity === 'block')).toEqual([]);
    expect(unset.find((f) => f.path === 'src/lib/pricing.ts')?.message).toContain('deferred to T007');
  });

  it('WARNs when an impl task adds code but emits no manifest (INFO in manual mode; not for config tasks, entrypoints or wired-by)', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const warn = await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls(), 'no block');
    expect(warn).toEqual([expect.objectContaining({ check: 'wiring-manifest', severity: 'warn' })]);
    const manual = await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls(), '');
    expect(manual).toEqual([expect.objectContaining({ check: 'wiring-manifest', severity: 'info' })]);
    expect(await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls(), '   \n')).toEqual([expect.objectContaining({ severity: 'info' })]);
    expect(await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls({ kind: 'config' }), '')).toEqual([]);
    expect(await checkWiringClaims([], addedDiff('app/page.tsx'), repo.dir, cls(), '')).toEqual([]);
    expect(await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls({ wiredBy: 'T009' }), '')).toEqual([]);
    expect(await checkWiringClaims([], addedDiff('src/lib/pricing.ts'), repo.dir, cls(), 'FULLAUTO_WIRING:\n')).toEqual([]);
  });
});

describe('claim parsing robustness and consumer path safety', () => {
  it('keeps the consumer path when a trailing note / reason follows it', () => {
    expect(parseClaimLine('src/lib/pricing.ts -> src/routes/checkout.ts:2 (via alias)')).toEqual({
      artifactPath: 'src/lib/pricing.ts',
      consumerPath: 'src/routes/checkout.ts',
      consumerLine: 2,
      note: 'via alias',
    });
    expect(parseClaimLine('src/lib/pricing.ts#price -> src/routes/checkout.ts — imported at top')).toMatchObject({ symbol: 'price', consumerPath: 'src/routes/checkout.ts', note: 'imported at top' });
    expect(parseClaimLine('src/a.ts -> src/b.ts:10-14')).toMatchObject({ consumerPath: 'src/b.ts', consumerLine: 10 });
  });

  it('a compound "X (note) and Y (note)" consumer resolves the first clause, not the whole garbled string (real regression: real subagent wired through both package.json main and exports)', () => {
    const claim = parseClaimLine(
      'src/convert.js -> package.json:6 ("main") and package.json:7 ("exports")'
    );
    expect(claim).toMatchObject({
      artifactPath: 'src/convert.js',
      consumerPath: 'package.json',
      consumerLine: 6,
    });
    expect(claim?.note).toContain('also');
  });

  it('does NOT split "and" that is part of a note, not a second consumer', () => {
    // The whole right-hand side is one parenthetical — handled by the
    // whole-string-note branch before compound splitting ever runs.
    expect(parseClaimLine('src/app.tsx -> (imported and used in the header)')).toEqual({
      artifactPath: 'src/app.tsx',
      note: 'imported and used in the header',
    });
  });

  it('BLOCKs a consumer path that escapes the project (never reads outside projectDir)', async () => {
    const repo = makeRepo({ 'src/app.ts': "import { quote } from './lib/pricing';\n" });
    repos.push(repo);
    const claims = parseWiringClaims(['FULLAUTO_WIRING:', '- src/lib/pricing.ts -> ../../../../etc/hosts', '- src/lib/pricing.ts -> /etc/hosts', '- src/lib/pricing.ts -> src/../../outside.ts'].join('\n'));
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x');
    expect(findings).toHaveLength(3);
    for (const f of findings) {
      expect(f.severity).toBe('block');
      expect(f.message).toMatch(/escapes the project/);
    }
    // an absolute path INSIDE the project is simply relativized
    const inside = await checkWiringClaims(parseWiringClaims(`FULLAUTO_WIRING:\n- src/lib/pricing.ts -> ${repo.dir}/src/app.ts\n`), emptyDiff, repo.dir, cls(), 'x');
    expect(inside).toEqual([]);
    // a symlink inside the repo that points outside is rejected too
    const fs = await import('node:fs');
    fs.symlinkSync('/etc/hosts', `${repo.dir}/src/link.ts`);
    const viaLink = await checkWiringClaims(parseWiringClaims('FULLAUTO_WIRING:\n- src/lib/pricing.ts -> src/link.ts\n'), emptyDiff, repo.dir, cls(), 'x');
    expect(viaLink).toEqual([expect.objectContaining({ severity: 'block' })]);
    expect(viaLink[0].message).toMatch(/escapes the project/);
  });

  it('accepts a module-level claim through an alias import and a config-style full-path mention', async () => {
    const repo = makeRepo({
      'src/app.ts': "import { quote } from '@/lib/pricing';\nquote();\n",
      'webpack.config.js': "module.exports = { entry: './src/worker.ts' };\n",
      'src/worker.ts': '',
      'src/lib/pricing.ts': '',
    });
    repos.push(repo);
    const claims = parseWiringClaims('FULLAUTO_WIRING:\n- src/lib/pricing.ts -> src/app.ts\n- src/worker.ts -> webpack.config.js\n');
    expect(await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x')).toEqual([]);
  });
});

describe('entrypoint claims are verified against the entrypoint patterns', () => {
  it('BLOCKs `(entrypoint: ...)` on a path that matches no entrypoint pattern; accepts real entrypoints', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const claims = parseWiringClaims(
      [
        'FULLAUTO_WIRING:',
        '- src/lib/pricing.ts -> (entrypoint: loaded lazily by the framework)',
        '- src/components/Foo.tsx -> (entry point)',
        '- app/dashboard/page.tsx -> (entrypoint: next.js route file)',
        '- scripts/seed.ts -> (entrypoint: npm run seed)',
        '- src/middleware.ts -> (entrypoint: next middleware)',
        '- convex/users.ts -> (entrypoint: convex function)',
        '- cmd/server/main.go -> (entrypoint: go binary)',
        '- src/lib/legacy.ts -> (kept for reference)',
      ].join('\n')
    );
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x');
    expect(findings.map((f) => [f.severity, f.path])).toEqual([
      ['block', 'src/lib/pricing.ts'],
      ['block', 'src/components/Foo.tsx'],
    ]);
    expect(findings[0].message).toMatch(/claims src\/lib\/pricing\.ts is an entrypoint \(loaded lazily by the framework\) but .* does not match any entrypoint pattern/);
    expect(findings[0].message).toContain('`- wired by: T###`');
  });

  it('does not verify a test file claiming to be an entrypoint — no finding at all (real regression: node:test discovers it, not production code)', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const claims = parseWiringClaims(
      ['FULLAUTO_WIRING:', '- test/currency.test.mjs -> (entrypoint: test file, discovered by the node:test runner)'].join('\n')
    );
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x');
    expect(findings).toEqual([]);
  });

  it('accepts a DI / annotation discovery note on a DI-wired language as INFO, but not on TS', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const claims = parseWiringClaims(
      [
        'FULLAUTO_WIRING:',
        '- src/main/java/app/FooService.java -> (entrypoint: Spring @Service, component-scanned)',
        '- app/Services/Billing.php -> (entrypoint: registered in the DI container)',
        '- src/lib/foo.ts -> (entrypoint: picked up by DI container)',
      ].join('\n')
    );
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x');
    expect(findings.map((f) => [f.severity, f.path])).toEqual([
      ['info', 'src/main/java/app/FooService.java'],
      ['info', 'app/Services/Billing.php'],
      ['block', 'src/lib/foo.ts'],
    ]);
  });

  it('`(wired by T###)` stays INFO whatever the path', async () => {
    const repo = makeRepo({ 'README.md': '' });
    repos.push(repo);
    const claims = parseWiringClaims('FULLAUTO_WIRING:\n- src/lib/pricing.ts -> (wired by T007)\n');
    const findings = await checkWiringClaims(claims, emptyDiff, repo.dir, cls(), 'x');
    expect(findings).toEqual([expect.objectContaining({ severity: 'info', path: 'src/lib/pricing.ts' })]);
  });
});
