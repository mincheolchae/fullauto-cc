/**
 * Replace placeholders in a string with values from `process.env`. Supports:
 *   ${VAR}              — value of process.env.VAR (or empty if unset)
 *   ${VAR:-fallback}    — value of VAR, or the literal `fallback` if VAR is
 *                         unset/empty. Same shape as POSIX shell parameter
 *                         expansion. Fallback may NOT itself contain `${...}`
 *                         (no recursive expansion — keep the grammar simple).
 *
 * Missing vars without a fallback resolve to empty string; callers should
 * validate the resulting URL / header / etc. Used uniformly by every gate
 * type that reads user-authored strings (URLs, headers, bodies).
 */
export function interpolateEnv(s: string): string {
  return s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name, fallback) => {
      const v = process.env[name];
      if (v !== undefined && v !== '') return v;
      return fallback ?? '';
    }
  );
}

/**
 * Partial deep match used by gates that compare a function return value
 * against an `expect.shape`. Behavior:
 *  - `undefined` expected → always pass.
 *  - primitives → strict `===`.
 *  - arrays → check the SAME LENGTH and each index recursively. (No
 *    contains/prefix variant; if you want length-only assertion against an
 *    array, use the `length` key on an object shape.)
 *  - objects → every key in `expected` must exist in `actual` and match
 *    recursively. Keys in `actual` that aren't in `expected` are ignored
 *    (partial match).
 *  - special `length` key — matches `actual.length` ONLY when `actual` is
 *    an array or string. We deliberately do NOT hijack `length` on plain
 *    objects, so a domain object like `{ length: "5cm" }` can be matched
 *    on its `length` field as a normal value.
 */
export function matchShape(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null;
  if (typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (actual.length !== expected.length) return false;
    return expected.every((v, i) => matchShape(actual[i], v));
  }
  // String actual only exposes `length` introspectably — any other key in
  // `expected` is unmatchable, so fail loudly instead of silently passing.
  if (typeof actual === 'string') {
    for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
      if (k !== 'length') return false;
      if (!matchShape(actual.length, v)) return false;
    }
    return true;
  }
  if (typeof actual !== 'object' || actual === null) return false;
  for (const [k, v] of Object.entries(expected as Record<string, unknown>)) {
    if (k === 'length' && Array.isArray(actual)) {
      if (!matchShape(actual.length, v)) return false;
      continue;
    }
    if (!matchShape((actual as Record<string, unknown>)[k], v)) return false;
  }
  return true;
}
