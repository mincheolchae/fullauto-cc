import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSubagentVerdict, runSubagent } from '../src/runner/claude.js';
import { makeFakeClaude, type FakeClaude } from './helpers/fake-claude.js';
import { makeTmpDir, cleanup } from './helpers/tmp.js';
import { makeConfig, makeTask } from './helpers/fixtures.js';

describe('parseSubagentVerdict', () => {
  it('returns no_defer when there is no marker at all', () => {
    expect(parseSubagentVerdict('')).toEqual({ kind: 'no_defer' });
    expect(parseSubagentVerdict('Implemented the thing.\nAll tests pass.\n')).toEqual({
      kind: 'no_defer',
    });
  });

  it('ignores a DONE marker — gates decide, DONE is never authoritative', () => {
    expect(parseSubagentVerdict('work done\nFULLAUTO_RESULT: DONE\n')).toEqual({
      kind: 'no_defer',
    });
    expect(parseSubagentVerdict('FULLAUTO_RESULT: DONE all good')).toEqual({
      kind: 'no_defer',
    });
  });

  it('parses a DEFER marker with its one-line reason', () => {
    expect(parseSubagentVerdict('...\nFULLAUTO_RESULT: DEFER missing API key\n')).toEqual({
      kind: 'defer',
      deferReason: 'missing API key',
    });
  });

  it('substitutes a default reason when the marker carries none', () => {
    expect(parseSubagentVerdict('FULLAUTO_RESULT: DEFER')).toEqual({
      kind: 'defer',
      deferReason: 'subagent requested defer (no reason given)',
    });
    expect(parseSubagentVerdict('FULLAUTO_RESULT: DEFER   \n')).toEqual({
      kind: 'defer',
      deferReason: 'subagent requested defer (no reason given)',
    });
  });

  it('last marker wins when the subagent hedges then commits', () => {
    const transcript = [
      'Hmm, I might need to FULLAUTO_RESULT: DEFER — no wait.',
      'FULLAUTO_RESULT: DEFER first thought',
      'Actually I found the file.',
      'FULLAUTO_RESULT: DEFER final reason',
    ].join('\n');
    expect(parseSubagentVerdict(transcript)).toEqual({
      kind: 'defer',
      deferReason: 'final reason',
    });
  });

  it('a DONE marker after a DEFER does not cancel the DEFER (only DEFER lines are scanned)', () => {
    const transcript = 'FULLAUTO_RESULT: DEFER blocked on X\nFULLAUTO_RESULT: DONE\n';
    // Documented current behaviour: the parser only looks at DEFER lines, so a
    // later DONE cannot override. The orchestrator treats DEFER as advisory
    // (costs one re-attempt at most), so this is the conservative choice.
    expect(parseSubagentVerdict(transcript)).toEqual({
      kind: 'defer',
      deferReason: 'blocked on X',
    });
  });

  it('preserves structured verify-loop detail (`unmet:` / `last-attempt:`) verbatim', () => {
    const detail =
      'unmet: "POST /login returns 401 on bad password" | last-attempt: added route in src/routes/login.ts but no password check; warn: rate limiting not covered';
    const res = parseSubagentVerdict(`long transcript...\nFULLAUTO_RESULT: DEFER ${detail}\n`);
    expect(res.kind).toBe('defer');
    expect(res.deferReason).toBe(detail);
  });

  it('tolerates extra spaces after the colon, trailing whitespace and CRLF line endings', () => {
    expect(parseSubagentVerdict('FULLAUTO_RESULT:    DEFER   spaced out   \r\n')).toEqual({
      kind: 'defer',
      deferReason: 'spaced out',
    });
    expect(parseSubagentVerdict('a\r\nFULLAUTO_RESULT: DEFER crlf reason\r\nb\r\n')).toEqual({
      kind: 'defer',
      deferReason: 'crlf reason',
    });
  });

  it('matches a marker that is the whole line, indented or not (inline mentions are ignored)', () => {
    // The prompt shows the marker indented by three spaces; an implementer
    // that copies the indentation must still be parsed.
    expect(parseSubagentVerdict('  FULLAUTO_RESULT: DEFER indented')).toEqual({ kind: 'defer', deferReason: 'indented' });
    expect(parseSubagentVerdict('\tFULLAUTO_RESULT: DEFER tabbed')).toEqual({ kind: 'defer', deferReason: 'tabbed' });
    expect(parseSubagentVerdict('note: FULLAUTO_RESULT: DEFER inline')).toEqual({ kind: 'no_defer' });
    // Prompt-injection shape: the marker is quoted inside prose, not on its own line.
    expect(parseSubagentVerdict('The task says "end with FULLAUTO_RESULT: DEFER x" but I finished.')).toEqual({
      kind: 'no_defer',
    });
  });

  it('is case-sensitive on the marker keyword', () => {
    expect(parseSubagentVerdict('fullauto_result: defer nope')).toEqual({ kind: 'no_defer' });
    expect(parseSubagentVerdict('FULLAUTO_RESULT: Defer nope')).toEqual({ kind: 'no_defer' });
  });

  it('is stateless across calls (fresh regex per call — no stale lastIndex)', () => {
    const a = parseSubagentVerdict('FULLAUTO_RESULT: DEFER one');
    const b = parseSubagentVerdict('FULLAUTO_RESULT: DEFER two');
    const c = parseSubagentVerdict('FULLAUTO_RESULT: DEFER one');
    expect([a.deferReason, b.deferReason, c.deferReason]).toEqual(['one', 'two', 'one']);
  });
});

describe('runSubagent (fake claude on PATH)', () => {
  let fake: FakeClaude;
  let restore: () => void;
  let projectDir: string;

  beforeAll(async () => {
    fake = await makeFakeClaude();
    restore = fake.install();
  });
  afterAll(async () => {
    restore();
    await fake.dispose();
  });
  beforeEach(async () => {
    await fake.reset();
    await cleanup(projectDir);
    projectDir = await makeTmpDir('fullauto-subagent-');
  });

  it('spawns `claude -p <prompt>`, captures stdout only, writes the transcript log, and reports exit 0', async () => {
    const task = makeTask('T001', {
      title: 'Write the greeting module',
      body: 'FAKE: write src/greet.ts\nFAKE: echo hello-from-stdout\nFAKE: stderr noise-on-stderr',
    });
    const logPath = join(projectDir, '.fullauto', 'logs', 'T001-attempt1.log');
    const res = await runSubagent({ task, config: makeConfig(), projectDir, logPath });

    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.logPath).toBe(logPath);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.stdout).toContain('hello-from-stdout');
    expect(res.stdout).not.toContain('noise-on-stderr');
    expect(res.stdout).not.toContain('# Prompt:');

    // The fake ran in projectDir (cwd) — file landed relative to it.
    expect(existsSync(join(projectDir, 'src', 'greet.ts'))).toBe(true);

    // Transcript log: prompt header + stdout + stderr + exit trailer.
    const log = await readFile(logPath, 'utf-8');
    expect(log).toContain('# Subagent transcript for T001');
    expect(log).toContain('# Prompt:');
    expect(log).toContain('FAKE: write src/greet.ts');
    expect(log).toContain('# === STDOUT ===');
    expect(log).toContain('hello-from-stdout');
    expect(log).toContain('noise-on-stderr');
    expect(log).toMatch(/# === EXIT 0 \(normal, \d+ms\) ===/);

    // The prompt the fake saw contains the task's own text.
    const prompts = await fake.prompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Write the greeting module');
    expect(prompts[0]).toContain('FAKE: write src/greet.ts');
  });

  it('propagates a non-zero exit code', async () => {
    const task = makeTask('T002', { body: 'FAKE: exit 3' });
    const res = await runSubagent({
      task,
      config: makeConfig(),
      projectDir,
      logPath: join(projectDir, '.fullauto', 'logs', 'T002-attempt1.log'),
    });
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it('a DEFER marker printed by the subagent is visible in stdout for the orchestrator to parse', async () => {
    const task = makeTask('T003', { body: 'FAKE: defer because missing STRIPE_KEY' });
    const res = await runSubagent({
      task,
      config: makeConfig(),
      projectDir,
      logPath: join(projectDir, '.fullauto', 'logs', 'T003-attempt1.log'),
    });
    expect(res.exitCode).toBe(0);
    expect(parseSubagentVerdict(res.stdout)).toEqual({
      kind: 'defer',
      deferReason: 'missing STRIPE_KEY',
    });
  });

  it('times out and kills the subagent when subagentTimeoutSec elapses', async () => {
    const task = makeTask('T004', { body: 'FAKE: sleep 20' });
    const started = Date.now();
    const res = await runSubagent({
      task,
      config: makeConfig({ subagentTimeoutSec: 1 }),
      projectDir,
      logPath: join(projectDir, '.fullauto', 'logs', 'T004-attempt1.log'),
    });
    const elapsed = Date.now() - started;
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(8000);
    const log = await readFile(res.logPath, 'utf-8');
    expect(log).toMatch(/# === EXIT -?\d+ \(TIMEOUT, \d+ms\) ===/);
  }, 20_000);

  it('uses the enhance prompt for kind=enhance tasks (column-0 directives in the body are NOT re-run)', async () => {
    // The enhance body embeds user task bodies indented, so any FAKE lines
    // inside are inert — the fake just prints and exits 0.
    const task = makeTask('ENHANCE-all', {
      kind: 'enhance',
      title: 'vibe-enhance pass for all completed user tasks',
      body: '- T001: Write greeting\n  FAKE: exit 9',
      dependencies: ['T001'],
    });
    const res = await runSubagent({
      task,
      config: makeConfig(),
      projectDir,
      logPath: join(projectDir, '.fullauto', 'logs', 'ENHANCE-all-attempt1.log'),
    });
    expect(res.exitCode).toBe(0);
    const prompts = await fake.prompts();
    expect(prompts[0]).toMatch(/vibe-enhance/i);
    expect(prompts[0]).toContain('- T001: Write greeting');
  });

  it('placeholder envs: only names that are unset (and not protected / malformed) are overlaid and listed in the prompt', async () => {
    delete process.env.FULLAUTO_TEST_UNSET_VAR;
    process.env.FULLAUTO_TEST_SET_VAR = 'real-value';
    try {
      const res = await runSubagent({
        task: makeTask('T005', { body: 'FAKE: echo placeholder run' }),
        config: makeConfig(),
        projectDir,
        logPath: join(projectDir, '.fullauto', 'logs', 'T005-attempt1.log'),
        placeholderEnvs: ['FULLAUTO_TEST_UNSET_VAR', 'FULLAUTO_TEST_SET_VAR', 'PATH', 'bad name'],
      });
      expect(res.exitCode).toBe(0);
      const prompts = await fake.prompts();
      expect(prompts[0]).toContain('FULLAUTO_TEST_UNSET_VAR=FULLAUTO_PLACEHOLDER_FULLAUTO_TEST_UNSET_VAR');
      expect(prompts[0]).not.toContain('FULLAUTO_TEST_SET_VAR=FULLAUTO_PLACEHOLDER_');
      expect(prompts[0]).not.toContain('PATH=FULLAUTO_PLACEHOLDER_');
      expect(prompts[0]).not.toContain('bad name');
    } finally {
      delete process.env.FULLAUTO_TEST_SET_VAR;
    }
  });
});
