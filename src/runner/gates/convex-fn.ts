import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import type { ConvexFnGate, GateResult } from '../../types.js';
import { interpolateEnv, matchShape } from './shared.js';

/**
 * Call a Convex function (`query`, `mutation`, or `action`) against the
 * deployment URL in `process.env.CONVEX_URL` (or `gate.url`) and verify the
 * return shape. Uses the project's own `convex/browser` ConvexHttpClient via
 * `createRequire(<projectDir>/package.json)` so we don't ship `convex` as a
 * dependency of this CLI — the user's project already has it.
 *
 * The `fn` field accepts both `module:export` (Convex idiom) and
 * `module.export` (dot syntax); both are normalized to colon form which is
 * what `ConvexHttpClient.{query,mutation,action}` accepts as a string ref.
 */
/**
 * Try CONVEX_URL first, then framework-prefixed variants `convex dev`
 * commonly writes (`NEXT_PUBLIC_CONVEX_URL` for Next.js, `VITE_CONVEX_URL`
 * for Vite). Without this, the convex-default `--convex` init silently
 * fails on the most common stack (Next.js) because the bare CONVEX_URL is
 * never set.
 */
const CONVEX_URL_ENV_NAMES = [
  'CONVEX_URL',
  'NEXT_PUBLIC_CONVEX_URL',
  'VITE_CONVEX_URL',
];

function pickConvexUrl(): string {
  for (const name of CONVEX_URL_ENV_NAMES) {
    const v = process.env[name];
    if (v) return v.trim();
  }
  return '';
}

export async function runConvexFnGate(
  gate: ConvexFnGate,
  projectDir: string
): Promise<GateResult> {
  const startedAt = Date.now();
  const url = (gate.url ? interpolateEnv(gate.url) : pickConvexUrl()).trim();
  const command = `convex.${gate.kind}(${gate.fn})`;

  if (!url) {
    return failed(
      gate,
      command,
      startedAt,
      `[convex-fn] No deployment URL — set one of [${CONVEX_URL_ENV_NAMES.join(', ')}] via a service envFile, or pass \`url\` explicitly on the gate.`
    );
  }

  const fnRef = normalizeFnRef(gate.fn);
  if (fnRef instanceof Error) {
    return failed(gate, command, startedAt, `[convex-fn] ${fnRef.message}`);
  }

  let ConvexHttpClient: new (url: string) => ConvexClient;
  try {
    const req = createRequire(resolvePath(projectDir, 'package.json'));
    const mod = req('convex/browser') as { ConvexHttpClient: new (u: string) => ConvexClient };
    ConvexHttpClient = mod.ConvexHttpClient;
  } catch (err) {
    return failed(
      gate,
      command,
      startedAt,
      `[convex-fn] Could not resolve "convex/browser" from ${projectDir}. Install convex in the target project (npm i convex). Underlying error: ${(err as Error).message}`
    );
  }

  const client = new ConvexHttpClient(url);

  // ConvexHttpClient (as of convex 1.x) does not accept an AbortSignal on
  // query/mutation/action, so a true cancel of the in-flight HTTP call
  // isn't available. We do the next best thing: race against an explicit
  // setTimeout we ALWAYS clear, so the event loop isn't held for the full
  // timeoutSec when the call wins, and the late-rejection of the timeout
  // promise is a no-op for the already-settled race. (`unref` keeps the
  // process eligible to exit even if some path skips the clear.)
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`timed out after ${gate.timeoutSec}s`)),
      gate.timeoutSec * 1000
    );
    timeoutId.unref?.();
  });
  let result: unknown;
  try {
    result = await Promise.race([
      callMethod(client, gate.kind, fnRef, gate.args),
      timeoutPromise,
    ]);
  } catch (err) {
    return failed(
      gate,
      command,
      startedAt,
      `[convex-fn] ${gate.kind} ${fnRef} threw: ${(err as Error).message}`
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const shapeOk = matchShape(result, gate.expect?.shape);
  const passed = shapeOk;
  const output = [
    `${gate.kind} ${fnRef}(${JSON.stringify(gate.args)}) →`,
    shapeOk ? null : `Shape mismatch. Expected: ${JSON.stringify(gate.expect?.shape)}`,
    '--- result (first 4KB) ---',
    safeJson(result).slice(0, 4096),
  ]
    .filter(Boolean)
    .join('\n');

  return {
    name: gate.name,
    passed,
    command,
    exitCode: passed ? 0 : 1,
    output,
    durationMs: Date.now() - startedAt,
  };
}

interface ConvexClient {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
}

function callMethod(
  client: ConvexClient,
  kind: 'query' | 'mutation' | 'action',
  fnRef: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return client[kind](fnRef, args);
}

/**
 * Normalize function refs to Convex's string form `path/to/module:export`.
 *
 * Supported inputs:
 *  - `users:list`            → unchanged
 *  - `users.list`            → `users:list` (single dot = top-level module)
 *  - `admin/users:list`      → unchanged (nested directory, colon already)
 *
 * Rejected inputs (returned as Error so the caller can surface a clear
 * message instead of letting Convex fail with `module not found`):
 *  - `admin.users.list`      — ambiguous: could be `admin:users.list` OR
 *                              `admin/users:list`. The user must be explicit;
 *                              we recommend slash-form for nested directories.
 */
function normalizeFnRef(fn: string): string | Error {
  if (fn.includes(':')) {
    const colonCount = (fn.match(/:/g) ?? []).length;
    if (colonCount > 1) {
      return new Error(
        `Function ref "${fn}" has more than one colon. Use exactly one colon between module path and export name, e.g. \`admin/users:list\`.`
      );
    }
    // Reject leading/trailing-colon shapes like `:list` or `users:`.
    const [modulePath, exportName] = fn.split(':');
    if (!modulePath || !exportName) {
      return new Error(
        `Function ref "${fn}" has an empty module path or export name. Use \`module:export\` (or nested \`admin/users:list\`).`
      );
    }
    return fn;
  }
  const dotCount = (fn.match(/\./g) ?? []).length;
  if (dotCount === 0) {
    return new Error(
      `Function ref "${fn}" has no separator. Use \`module:export\` (or \`module.export\` for top-level files; nested directories require slash form like \`admin/users:list\`).`
    );
  }
  if (dotCount > 1) {
    return new Error(
      `Function ref "${fn}" is ambiguous (multiple dots). Use slash for directories and a single colon or dot for the export, e.g. \`admin/users:list\`.`
    );
  }
  const idx = fn.lastIndexOf('.');
  return `${fn.slice(0, idx)}:${fn.slice(idx + 1)}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function failed(
  gate: ConvexFnGate,
  command: string,
  startedAt: number,
  output: string
): GateResult {
  return {
    name: gate.name,
    passed: false,
    command,
    exitCode: 1,
    output,
    durationMs: Date.now() - startedAt,
  };
}
