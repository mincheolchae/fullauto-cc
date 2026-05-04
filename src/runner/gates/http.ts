import type { GateResult, HttpGate } from '../../types.js';
import { interpolateEnv, matchShape } from './shared.js';

/**
 * Probe an HTTP endpoint. Pass criteria:
 *  - status matches `expectStatus` (or any 2xx if unset)
 *  - response body contains `expectBodyContains` (if set)
 *
 * Failures include the status, headers (a few), and a clipped body so the
 * implementer subagent can see what the server actually returned without
 * us having to surface a separate diagnostic gate.
 */
export async function runHttpGate(gate: HttpGate): Promise<GateResult> {
  const url = interpolateEnv(gate.url);
  const startedAt = Date.now();
  const command = `${gate.method} ${url}`;

  if (!url || !/^https?:\/\//i.test(url)) {
    return {
      name: gate.name,
      passed: false,
      command,
      exitCode: 1,
      output: `[http gate] URL did not interpolate to a valid http(s) URL: "${url}"`,
      durationMs: Date.now() - startedAt,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), gate.timeoutSec * 1000);

  // Interpolate env vars in headers + body too — without this, a Supabase
  // gate with `headers: { apikey: '${SUPABASE_ANON_KEY}' }` would ship the
  // literal `${...}` text and get rejected with 401.
  const interpolatedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(gate.headers)) {
    interpolatedHeaders[k] = interpolateEnv(v);
  }
  const interpolatedBody = gate.body ? interpolateEnv(gate.body) : undefined;

  try {
    const res = await fetch(url, {
      method: gate.method,
      headers: interpolatedHeaders,
      body: interpolatedBody,
      signal: controller.signal,
    });
    const body = await res.text().catch(() => '<failed to read body>');
    const statusOk = matchStatus(res.status, gate.expectStatus);
    const bodyOk =
      !gate.expectBodyContains || body.includes(gate.expectBodyContains);

    const reasons: string[] = [];
    if (!statusOk) {
      reasons.push(
        `status ${res.status} not in ${formatExpectedStatus(gate.expectStatus)}`
      );
    }
    if (!bodyOk) {
      reasons.push(`body missing substring "${gate.expectBodyContains}"`);
    }

    // Header assertions (case-insensitive substring match).
    let headersOk = true;
    if (gate.expectHeaders) {
      for (const [name, expected] of Object.entries(gate.expectHeaders)) {
        const actual = res.headers.get(name);
        if (actual === null || !actual.includes(expected)) {
          headersOk = false;
          reasons.push(
            `header "${name}" expected to contain "${expected}", got ${actual === null ? 'no header' : `"${actual}"`}`
          );
        }
      }
    }

    // JSON shape assertion (reuses the matchShape matcher from shared.ts).
    let jsonOk = true;
    if (gate.expectJson) {
      try {
        const parsed = JSON.parse(body);
        if (!matchShape(parsed, gate.expectJson)) {
          jsonOk = false;
          reasons.push(
            `JSON shape mismatch (expected ${JSON.stringify(gate.expectJson)})`
          );
        }
      } catch (e) {
        jsonOk = false;
        reasons.push(
          `expectJson set but body is not valid JSON: ${(e as Error).message}`
        );
      }
    }

    const passed = statusOk && bodyOk && headersOk && jsonOk;

    // Surface a wider set of headers than the previous two — auth/CORS/
    // content negotiation are the typical reasons a "real-API" probe is
    // diagnosed off the headers.
    const headerSummary = formatHeaders(res.headers);

    const output = [
      `HTTP ${res.status} ${res.statusText}`,
      headerSummary,
      reasons.length ? `Failed checks: ${reasons.join('; ')}` : null,
      '--- body (first 4KB) ---',
      body.slice(0, 4096),
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
  } catch (err) {
    const message =
      (err as Error).name === 'AbortError'
        ? `request timed out after ${gate.timeoutSec}s`
        : (err as Error).message;
    return {
      name: gate.name,
      passed: false,
      command,
      exitCode: 1,
      output: `[http gate] ${message}`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

function matchStatus(actual: number, expected?: number | number[]): boolean {
  if (expected === undefined) return actual >= 200 && actual < 300;
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function formatExpectedStatus(expected?: number | number[]): string {
  if (expected === undefined) return '2xx';
  if (Array.isArray(expected)) return `[${expected.join(', ')}]`;
  return String(expected);
}

/**
 * Surface a useful subset of response headers in the gate output. Includes
 * common diagnosis families (content/auth/CORS/rate-limit/request-id)
 * plus everything starting with `x-`. Cap the output so a header-spammy
 * server can't drown the body.
 */
function formatHeaders(headers: Headers): string {
  const interesting = new Set([
    'content-type',
    'content-length',
    'cache-control',
    'www-authenticate',
    'authorization',
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'retry-after',
    'x-request-id',
  ]);
  const lines: string[] = [];
  let total = 0;
  let suppressed = 0;
  headers.forEach((value, key) => {
    if (!(interesting.has(key) || key.startsWith('x-'))) return;
    const line = `${key}: ${value}`;
    if (total + line.length > 1024) {
      suppressed += 1;
      return;
    }
    total += line.length + 1;
    lines.push(line);
  });
  if (suppressed > 0) {
    lines.push(`[${suppressed} header(s) omitted by 1KB cap]`);
  }
  return lines.join('\n');
}
