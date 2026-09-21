/**
 * Gate-integrity check: the files that define what the gates *are* (test
 * runner config, package.json scripts, tsconfig, lint config, CI) must not
 * change during a task unless the task explicitly says so
 * (`- touches-config: <why>`) or is itself a config task.
 *
 * Structural comparisons keep legitimate edits from deadlocking a task:
 *  - package.json: only `scripts.{test,typecheck,lint,build,test:e2e}` and
 *    the top-level `jest` / `vitest` keys matter (dependencies never do).
 *  - pyproject.toml: only the `[tool.*]` gate sections.
 *  - tsconfig*.json (JSONC): `include/exclude/files/extends/references` and
 *    the strictness compilerOptions BLOCK; `paths`, `jsx`, `lib`, `types`,
 *    `target` … only WARN (they cannot make a failing typecheck pass).
 *  - vite/vitest/jest/mocha/playwright/cypress config (code): changed lines that
 *    touch test scoping (`include`, `exclude`, `testMatch`, `passWithNoTests`,
 *    `setupFiles`, `bail`, `retry` …) BLOCK; a new plugin or alias only WARNs.
 *  - `.github/workflows/*`: never a gate the orchestrator runs → WARN.
 *  - Makefile: BLOCK only when a gate command invokes `make` (when known).
 */
import { isGeneratedPath } from './patterns.js';
import type { AuditFinding, ChangedFile, TaskClassification, TaskDiff } from './types.js';

export const PACKAGE_JSON_SCRIPT_KEYS = ['test', 'typecheck', 'lint', 'build', 'test:e2e'] as const;
export const PACKAGE_JSON_TOP_KEYS = ['jest', 'vitest'] as const;

const PYPROJECT_GATE_SECTIONS = /^tool\.(pytest|ruff|mypy|pyright|coverage|black|isort|flake8|pylint)(\.|$)/;

/** tsconfig keys whose change can widen/narrow what `tsc` checks or how strictly. */
const TSCONFIG_GATE_TOP = new Set(['include', 'exclude', 'files', 'extends', 'references']);
const TSCONFIG_GATE_OPTIONS = new Set([
  'strict', 'noImplicitAny', 'strictNullChecks', 'strictFunctionTypes', 'strictBindCallApply', 'strictPropertyInitialization',
  'noImplicitThis', 'alwaysStrict', 'useUnknownInCatchVariables', 'noUnusedLocals', 'noUnusedParameters', 'noImplicitReturns',
  'noFallthroughCasesInSwitch', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'noImplicitOverride',
  'noPropertyAccessFromIndexSignature', 'skipLibCheck', 'checkJs', 'allowJs', 'allowUnreachableCode', 'allowUnusedLabels',
  'noEmitOnError', 'suppressImplicitAnyIndexErrors', 'suppressExcessPropertyErrors', 'isolatedModules', 'rootDir', 'rootDirs',
]);

/** Runner-config keys that scope or soften what a test / e2e gate executes. */
const RUNNER_SCOPE_RE =
  /\b(include|exclude|testMatch|testRegex|testPathIgnorePatterns|modulePathIgnorePatterns|roots|dir|root|passWithNoTests|bail|retry|retries|allowOnly|forbidOnly|setupFiles|setupFilesAfterEach|setupFilesAfterEnv|globalSetup|globalTeardown|testNamePattern|testDir|testIgnore|specPattern|excludeSpecPattern|grep|grepInvert|maxFailures|dangerouslyIgnoreUnhandledErrors|typecheck|thresholds|coverageThreshold|projects|workspace|ignore|spec|only|skip|silent|forceExit)\b/;

interface GateRelevantChange {
  changed: boolean;
  detail: string;
  /** `true` when the change is outside the gate-relevant keys (WARN instead of BLOCK). */
  soft?: boolean;
}

/** Strip line and block comments plus trailing commas so tsconfig / biome JSONC parses. */
export function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

export function tsconfigGateDiff(beforeText: string | undefined, afterText: string | undefined): GateRelevantChange {
  let before: Record<string, unknown> | undefined;
  let after: Record<string, unknown> | undefined;
  try {
    before = beforeText ? (parseJsonc(beforeText) as Record<string, unknown>) : undefined;
  } catch {
    before = undefined;
  }
  try {
    after = afterText ? (parseJsonc(afterText) as Record<string, unknown>) : undefined;
  } catch {
    return { changed: true, detail: 'tsconfig no longer parses as JSON' };
  }
  if (!after) return { changed: true, detail: 'tsconfig is empty' };
  if (!before) return { changed: false, detail: 'previous tsconfig unavailable' };

  const hard: string[] = [];
  const soft: string[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (k === 'compilerOptions') continue;
    if (stable(before[k]) !== stable(after[k])) (TSCONFIG_GATE_TOP.has(k) ? hard : soft).push(k);
  }
  const bOpts = (before.compilerOptions ?? {}) as Record<string, unknown>;
  const aOpts = (after.compilerOptions ?? {}) as Record<string, unknown>;
  for (const k of new Set([...Object.keys(bOpts), ...Object.keys(aOpts)])) {
    if (stable(bOpts[k]) !== stable(aOpts[k])) (TSCONFIG_GATE_OPTIONS.has(k) ? hard : soft).push(`compilerOptions.${k}`);
  }
  if (hard.length) return { changed: true, detail: `gate-relevant keys changed: ${hard.join(', ')}${soft.length ? ` (also: ${soft.join(', ')})` : ''}` };
  if (soft.length) return { changed: true, soft: true, detail: `non-gate keys changed: ${soft.join(', ')}` };
  return { changed: false, detail: '' };
}

/** Lines present on one side only (order-insensitive, trimmed). */
function changedLines(before: string, after: string): string[] {
  const b = new Set(before.split('\n').map((l) => l.trim()));
  const a = new Set(after.split('\n').map((l) => l.trim()));
  const out: string[] = [];
  for (const l of a) if (l && !b.has(l)) out.push(l);
  for (const l of b) if (l && !a.has(l)) out.push(l);
  return out;
}

/** Runner config written as code (vitest/vite/jest/mocha/playwright/cypress): gate-relevant when a changed line touches test scoping. */
export function runnerConfigGateDiff(beforeText: string | undefined, afterText: string | undefined): GateRelevantChange {
  if (beforeText === undefined || afterText === undefined) return { changed: true, detail: 'content changed' };
  if (beforeText === afterText) return { changed: false, detail: '' };
  const lines = changedLines(beforeText, afterText);
  const scoped = lines.filter((l) => RUNNER_SCOPE_RE.test(l));
  if (scoped.length) return { changed: true, detail: `test-scoping lines changed: ${scoped.slice(0, 3).map((l) => JSON.stringify(l.slice(0, 80))).join(', ')}` };
  return { changed: true, soft: true, detail: `${lines.length} line(s) changed, none touching test scoping (plugins/alias/env only)` };
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (val as Record<string, unknown>)[k];
        return acc;
      }, {});
    }
    return val;
  });
}

export function packageJsonGateDiff(beforeText: string | undefined, afterText: string | undefined): GateRelevantChange {
  let before: Record<string, unknown> | undefined;
  let after: Record<string, unknown> | undefined;
  try {
    before = beforeText ? (JSON.parse(beforeText) as Record<string, unknown>) : undefined;
  } catch {
    before = undefined;
  }
  try {
    after = afterText ? (JSON.parse(afterText) as Record<string, unknown>) : undefined;
  } catch {
    return { changed: true, detail: 'package.json no longer parses as JSON' };
  }
  if (!after) return { changed: true, detail: 'package.json is empty' };
  if (!before) return { changed: false, detail: 'previous package.json unavailable' };

  const diffs: string[] = [];
  const bScripts = (before.scripts ?? {}) as Record<string, unknown>;
  const aScripts = (after.scripts ?? {}) as Record<string, unknown>;
  for (const k of PACKAGE_JSON_SCRIPT_KEYS) {
    if (stable(bScripts[k]) !== stable(aScripts[k])) {
      diffs.push(`scripts.${k}: ${JSON.stringify(bScripts[k] ?? null)} → ${JSON.stringify(aScripts[k] ?? null)}`);
    }
  }
  for (const k of PACKAGE_JSON_TOP_KEYS) {
    if (stable(before[k]) !== stable(after[k])) diffs.push(`${k} config changed`);
  }
  return { changed: diffs.length > 0, detail: diffs.join('; ') };
}

function tomlSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = '';
  const buf: string[] = [];
  const flush = () => {
    if (current) out.set(current, buf.join('\n').trim());
    buf.length = 0;
  };
  for (const line of text.split('\n')) {
    const m = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

export function pyprojectGateDiff(beforeText: string | undefined, afterText: string | undefined): GateRelevantChange {
  if (beforeText === undefined) return { changed: false, detail: 'previous pyproject.toml unavailable' };
  const b = tomlSections(beforeText);
  const a = tomlSections(afterText ?? '');
  const keys = new Set([...b.keys(), ...a.keys()].filter((k) => PYPROJECT_GATE_SECTIONS.test(k)));
  const diffs: string[] = [];
  for (const k of keys) if ((b.get(k) ?? '') !== (a.get(k) ?? '')) diffs.push(`[${k}]`);
  return { changed: diffs.length > 0, detail: diffs.length ? `gate sections changed: ${diffs.join(', ')}` : '' };
}

const RUNNER_CODE_CONFIG = /^(vitest|vite|jest|playwright|cypress)\.config\.[^/]+$|^vitest\.workspace\.[^/]+$|^\.mocharc/;

function gateRelevantChange(file: ChangedFile): GateRelevantChange {
  const base = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (file.before !== undefined && file.after !== undefined && file.before === file.after) {
    return { changed: false, detail: '' };
  }
  if (base === 'package.json') return packageJsonGateDiff(file.before, file.after);
  if (base === 'pyproject.toml') return pyprojectGateDiff(file.before, file.after);
  if (/^tsconfig[^/]*\.json$/.test(base)) return tsconfigGateDiff(file.before, file.after);
  if (RUNNER_CODE_CONFIG.test(base)) return runnerConfigGateDiff(file.before, file.after);
  return { changed: true, detail: 'content changed' };
}

export interface GateIntegrityOptions {
  /** The gate commands the orchestrator runs (`GateResult.command`); lets Makefile changes be judged by whether any gate uses `make`. */
  gateCommands?: string[];
}

/** CI workflows are never executed by the orchestrator: a change cannot turn a gate green. */
function isCiWorkflow(path: string): boolean {
  return /(^|\/)\.github\/workflows\/[^/]+$/.test(path);
}

function isMakefile(path: string): boolean {
  return /(^|\/)Makefile$/.test(path);
}

export function checkGateIntegrity(diff: TaskDiff, cls: TaskClassification, opts: GateIntegrityOptions = {}): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const allowed = cls.allowsConfigChange || cls.kind === 'config';
  const gateUsesMake = opts.gateCommands === undefined ? true : opts.gateCommands.some((c) => /(^|[\s;&|])make(\s|$)/.test(c));

  for (const file of diff.files) {
    if (!file.isGateConfig || isGeneratedPath(file.path)) continue; // node_modules/pkg/package.json is not a gate
    // Files that cannot influence the orchestrator's gates: one severity notch down, never BLOCK.
    const advisory = isCiWorkflow(file.path) || (isMakefile(file.path) && !gateUsesMake);
    const hardSeverity = allowed ? 'info' : advisory ? 'warn' : 'block';
    const why = isCiWorkflow(file.path) ? 'CI workflow — not run by the orchestrator gates' : 'no gate command invokes make';

    if (file.kind === 'deleted') {
      findings.push({
        check: 'gate-integrity',
        severity: hardSeverity,
        path: file.path,
        message: allowed
          ? `gate config ${file.path} deleted (allowed: ${cls.kind === 'config' ? 'config task' : 'touches-config'})`
          : advisory
            ? `${file.path} was deleted by a non-config task (${why}) — verify this was intended; mark the task \`- touches-config: <reason>\` if so`
            : `gate config ${file.path} was deleted — restore it; only a task marked \`- touches-config: <reason>\` may change gate configuration`,
      });
      continue;
    }

    if (file.kind === 'added') {
      findings.push({
        check: 'gate-integrity',
        severity: allowed ? 'info' : advisory ? 'info' : 'warn',
        path: file.path,
        message: allowed
          ? `gate config ${file.path} added (allowed)`
          : advisory
            ? `${file.path} added by a non-config task (${why})`
            : `new gate config file ${file.path} added — make sure it does not narrow what the gates run (include/exclude/testMatch); mark the task \`- touches-config: <reason>\` if intentional`,
      });
      continue;
    }

    const change = gateRelevantChange(file);
    if (!change.changed) continue;
    if (change.soft && !allowed) {
      findings.push({
        check: 'gate-integrity',
        severity: 'warn',
        path: file.path,
        message: `gate config ${file.path} changed outside its gate-relevant keys (${change.detail}) — acceptable for aliases/plugins/targets; mark the task \`- touches-config: <reason>\` if the change was intended`,
      });
      continue;
    }
    findings.push({
      check: 'gate-integrity',
      severity: hardSeverity,
      path: file.path,
      message: allowed
        ? `gate config ${file.path} changed (${change.detail}) — allowed by ${cls.kind === 'config' ? 'config task' : 'touches-config'}`
        : advisory
          ? `${file.path} changed by a non-config task (${change.detail}; ${why}) — verify this was intended; mark the task \`- touches-config: <reason>\` if so`
          : `gate config ${file.path} changed (${change.detail}) — revert it; gates must be defined by the project, not by the task. Add \`- touches-config: <reason>\` to the task only if the change is genuinely required`,
    });
  }

  return findings;
}
