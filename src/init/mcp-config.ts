/**
 * Walk an MCP config tree and replace `${VAR}` (and `${VAR:-fallback}`)
 * placeholders inside the `env` block of every server entry with the
 * actual values from `process.env`.
 *
 * WHY at write time, not at spawn time: Claude CLI does not interpolate
 * `${...}` in MCP `env` values. If we wrote the literal `${SUPABASE_ACCESS_TOKEN}`
 * to mcp.json, the spawned MCP server would receive the literal string and
 * every authenticated call would 401. Expanding here means the on-disk
 * mcp.json contains the real token, so caller should chmod 0o600.
 *
 * Only `env` values are walked — top-level `command`/`args`/server names
 * are passed through verbatim to avoid surprising rewrites of literal
 * strings the user wrote intentionally.
 */
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function expandMcpEnvPlaceholders(mcpJson: unknown): {
  expanded: unknown;
  missing: string[];
} {
  const missing: string[] = [];
  function expandValue(s: string, contextKey: string): string {
    return s.replace(PLACEHOLDER, (_, name, fallback) => {
      const v = process.env[name];
      if (v !== undefined && v !== '') return v;
      if (fallback !== undefined) return fallback;
      missing.push(`${contextKey}.${name}`);
      return '';
    });
  }
  // Deep-clone so we don't mutate the preset constant.
  const cloned = JSON.parse(JSON.stringify(mcpJson)) as {
    mcpServers?: Record<string, { env?: Record<string, string> }>;
  };
  if (cloned && cloned.mcpServers) {
    for (const [serverName, server] of Object.entries(cloned.mcpServers)) {
      if (server && typeof server.env === 'object' && server.env) {
        for (const [k, v] of Object.entries(server.env)) {
          if (typeof v === 'string') {
            server.env[k] = expandValue(v, `${serverName}.env.${k}`);
          }
        }
      }
    }
  }
  return { expanded: cloned, missing };
}
