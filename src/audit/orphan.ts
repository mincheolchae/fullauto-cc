/**
 * Orphan-code check: every ADDED code file must be imported AND USED by
 * production code, unless it is an entrypoint (framework-discovered) or the
 * task body explicitly delegates wiring to a later task (`- wired by: T###`).
 *
 * "Used" (JS/TS consumers): at least one production importer references an
 * imported binding beyond the import statement itself. `import { quote }
 * from './pricing'` with no further `quote` satisfies a grep, not the
 * product — that is BLOCK "imported but never used". A bare side-effect
 * import (`import './pricing'`) of a code file is WARN unless the module
 * visibly registers itself (custom element, event listener, plugin
 * install, global assignment), in which case the import IS the use.
 * Re-exports (`export * from`) and dynamic imports count as use. Other
 * languages keep the import-level rule.
 *
 * Also re-verifies `PendingWiring` promises whose `wiredBy` is this task.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JS_LIKE_EXTENSIONS, extensionOf, isEntrypoint, isGeneratedPath, normalizePath } from './patterns.js';
import { findModuleReferences, findModuleReferencesMany, importedBindings, readCached, sanitizeForUse, usedBeyondImport, type ContentCache } from './refs.js';
import type { AuditFinding, PendingWiring, TaskClassification, TaskDiff } from './types.js';

export interface OrphanCheckResult {
  findings: AuditFinding[];
  newPending: PendingWiring[];
  resolvedPending: PendingWiring[];
}

/** Languages whose wiring is package-level (no per-file import) — skipped. */
const PACKAGE_WIRED_EXTENSIONS = new Set(['go']);
/**
 * Languages where annotation / DI container discovery (Spring, ASP.NET,
 * Laravel providers, SwiftUI) routinely wires a class nothing names
 * explicitly. An unreferenced file is suspicious but not proof → WARN.
 */
const DISCOVERY_WIRED_EXTENSIONS = new Set(['java', 'kt', 'cs', 'swift', 'php']);

/** A module whose top level does one of these is consumed by being loaded: a side-effect import is its wiring. */
const SELF_REGISTERING_RE =
  /\b(?:customElements\.define|addEventListener|removeEventListener|process\.on|register\w*|\.use|\.install|\.plugin|\.mount|\.listen|\.subscribe|\.hook|defineCustomElement|app\.(?:get|post|put|patch|delete|route)|router\.(?:get|post|put|patch|delete|use))\s*\(|\b(?:globalThis|window|global|self)\.[\w$]+\s*=|\bObject\.(?:assign|defineProperty)\(\s*(?:globalThis|window|global)\b|\bpolyfill\b/;

export type ConsumerUse =
  | { kind: 'used'; consumer: string }
  | { kind: 'import-only'; consumer: string; names: string[] }
  | { kind: 'side-effect'; consumer: string };

/**
 * How does a JS-like production `consumer` relate to `target`? `used` when an
 * imported binding occurs beyond the import line (or the import is dynamic /
 * a re-export / not parseable → benefit of the doubt); `import-only` when
 * every binding is unused; `side-effect` for a bare `import './x'`.
 */
export async function classifyConsumerUse(projectDir: string, consumer: string, target: string, cache: ContentCache): Promise<ConsumerUse> {
  if (!JS_LIKE_EXTENSIONS.has(extensionOf(consumer)) || !JS_LIKE_EXTENSIONS.has(extensionOf(target))) return { kind: 'used', consumer };
  const content = await readCached(projectDir, consumer, cache);
  if (content === undefined) return { kind: 'used', consumer };
  const bindings = importedBindings(content, consumer, target, projectDir);
  if (!bindings) return { kind: 'used', consumer }; // wired some other way (template tag, glob): not this rule's business
  if (bindings.dynamic || bindings.reExport) return { kind: 'used', consumer };
  if (bindings.names.length > 0) {
    const clean = sanitizeForUse(content, consumer);
    if (bindings.names.some((n) => usedBeyondImport(clean, n))) return { kind: 'used', consumer };
    return { kind: 'import-only', consumer, names: bindings.names };
  }
  return bindings.sideEffectOnly ? { kind: 'side-effect', consumer } : { kind: 'used', consumer };
}

export async function checkOrphans(
  diff: TaskDiff,
  projectDir: string,
  cls: TaskClassification,
  pendingWiring: PendingWiring[],
  taskId = ''
): Promise<OrphanCheckResult> {
  const findings: AuditFinding[] = [];
  const newPending: PendingWiring[] = [];
  const resolvedPending: PendingWiring[] = [];

  const added = diff.files.filter(
    (f) =>
      f.kind === 'added' &&
      f.isCode &&
      !f.isTest &&
      !isEntrypoint(f.path) &&
      !isGeneratedPath(f.path) &&
      !PACKAGE_WIRED_EXTENSIONS.has(extensionOf(f.path))
  );
  const cache: ContentCache = new Map();
  // One candidate search for every added file (a single git grep on big repos).
  const refsByPath = await findModuleReferencesMany(projectDir, added.map((f) => f.path), cache);

  for (const file of added) {
    const path = normalizePath(file.path);
    const refs = refsByPath.get(path) ?? { production: [], test: [] };
    if (refs.production.length > 0) {
      const uses = await Promise.all(refs.production.map((c) => classifyConsumerUse(projectDir, c, path, cache)));
      if (uses.some((u) => u.kind === 'used')) continue;
      const importOnly = uses.filter((u): u is Extract<ConsumerUse, { kind: 'import-only' }> => u.kind === 'import-only');
      const sideEffect = uses.filter((u) => u.kind === 'side-effect');
      if (importOnly.length > 0) {
        const first = importOnly[0];
        findings.push({
          check: 'orphan-code',
          severity: cls.wiredBy ? 'info' : 'block',
          path,
          message: cls.wiredBy
            ? `${path} is imported by ${importOnly.map((u) => u.consumer).slice(0, 3).join(', ')} but no imported binding is used there yet (wiring deferred to ${cls.wiredBy})`
            : `${path} is imported but never used in ${first.consumer} (${first.names.slice(0, 4).join(', ')} bound by the import statement and never referenced again) — an unused import is not wiring; call/render/register it there, or add \`- wired by: T###\` if a later task does`,
        });
        continue;
      }
      if (sideEffect.length > 0) {
        const selfRegisters = SELF_REGISTERING_RE.test(sanitizeForUse(file.after ?? '', path));
        findings.push({
          check: 'orphan-code',
          severity: selfRegisters ? 'info' : 'warn',
          path,
          message: selfRegisters
            ? `${path} is loaded for side effects by ${sideEffect[0].consumer} and registers itself at module load (accepted as wiring)`
            : `${path} is only imported for side effects (\`import '${path}'\`) by ${sideEffect.map((u) => u.consumer).slice(0, 3).join(', ')} and nothing in it visibly registers itself — import a binding and use it, or make the module register on load (customElements.define / addEventListener / plugin install)`,
        });
        continue;
      }
      continue;
    }

    if (cls.wiredBy) {
      // Wiring is promised by a later task: record the promise, never block here
      // (test-only references are fine at this point — the red/green pair often lands first).
      findings.push({
        check: 'orphan-code',
        severity: 'info',
        path,
        message: `${path} is not referenced by production code yet; wiring deferred to ${cls.wiredBy} (pending-wiring recorded)`,
      });
      newPending.push({ artifactPath: path, createdBy: taskId, wiredBy: cls.wiredBy });
      continue;
    }

    if (refs.test.length > 0) {
      // A test task that adds a module only tests reach has written a test
      // helper in a production path — a smell, not hallucinated integration.
      const testTask = cls.kind === 'test';
      findings.push({
        check: 'orphan-code',
        severity: testTask ? 'warn' : 'block',
        path,
        message: testTask
          ? `${path} is only referenced from tests (${refs.test.slice(0, 3).join(', ')}) — if it is a test helper move it under a test directory; if it is production code a later impl task must wire it in`
          : `${path} is only referenced from tests (${refs.test.slice(0, 3).join(', ')}) — import/render/mount it from production code, or add \`- wired by: T###\` to the task if a later task wires it`,
      });
      continue;
    }

    const discovery = DISCOVERY_WIRED_EXTENSIONS.has(extensionOf(path));
    findings.push({
      check: 'orphan-code',
      severity: discovery ? 'warn' : 'block',
      path,
      message: discovery
        ? `${path} is not referenced by any production code (no import / usage of ${path.slice(path.lastIndexOf('/') + 1)} found) — if it is discovered by annotations/DI, say so in FULLAUTO_WIRING; otherwise wire it in`
        : `${path} is not imported, rendered, or mounted by any production code — wire it in (import + use it from the module/route/page that needs it) or add \`- wired by: T###\` to the task`,
    });
  }

  for (const pending of pendingWiring) {
    if (!taskId || pending.wiredBy !== taskId) continue;
    const path = normalizePath(pending.artifactPath);
    if (!existsSync(join(projectDir, path))) {
      resolvedPending.push(pending);
      findings.push({
        check: 'pending-wiring',
        severity: 'info',
        path,
        message: `${path} (created by ${pending.createdBy}) no longer exists; pending wiring promise dropped`,
      });
      continue;
    }
    const refs = await findModuleReferences(projectDir, path, cache);
    if (refs.production.length > 0) {
      const uses = await Promise.all(refs.production.map((c) => classifyConsumerUse(projectDir, c, path, cache)));
      if (uses.some((u) => u.kind !== 'import-only')) {
        resolvedPending.push(pending);
        continue;
      }
      const first = uses[0] as Extract<ConsumerUse, { kind: 'import-only' }>;
      findings.push({
        check: 'pending-wiring',
        severity: 'block',
        path,
        message: `${path} (created by ${pending.createdBy}, \`wired by: ${taskId}\`) is imported by ${first.consumer} but no imported binding (${first.names.slice(0, 4).join(', ')}) is used there — an unused import is not wiring; call/render/register it`,
      });
      continue;
    }
    findings.push({
      check: 'pending-wiring',
      severity: 'block',
      path,
      message: `${path} was created by ${pending.createdBy} with \`wired by: ${taskId}\` but this task did not wire it — import/render/mount it from production code${refs.test.length ? ` (only test references found: ${refs.test.slice(0, 3).join(', ')})` : ''}`,
    });
  }

  return { findings, newPending, resolvedPending };
}
