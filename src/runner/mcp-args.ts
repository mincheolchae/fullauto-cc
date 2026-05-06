import { access, realpath } from 'node:fs/promises';
import { resolve as resolvePath, sep as pathSep } from 'node:path';

/**
 * Check that `child` is strictly under `parent`. Uses platform-native
 * separator so the same check works on POSIX and Windows. Both inputs
 * should already be absolute paths normalized via `resolve`/`realpath`.
 */
function isInside(child: string, parent: string): boolean {
  if (child === parent) return false; // disallow the project root itself
  const normalized = parent.endsWith(pathSep) ? parent : parent + pathSep;
  return child.startsWith(normalized);
}

/**
 * Resolve `config.mcpConfigPath` to a vetted absolute path and return the
 * `claude` CLI args (`--mcp-config <path>`) that opt into it. Skip silently
 * when the file is missing OR escapes the project root.
 *
 * The user controls `config.json` so this isn't privilege escalation, but a
 * `../../../etc/passwd` (or a symlink-from-inside pointing outside) would
 * leak absolute filesystem layout to whatever sink `claude` logs to.
 *
 * Containment is checked twice with the right pair on each side:
 *   1. LEXICAL: `..` segments after `resolve` must stay within the lexical
 *      project root. (Both sides lexical so macOS /var → /private/var
 *      symlink-traversal doesn't false-reject.)
 *   2. REAL:    after `realpath`, the file's actual on-disk location must
 *      stay within the project's real root, defeating any symlink whose
 *      target leaves the tree.
 *
 * Shared by the implementer subagent (`runSubagent`) and the planner
 * subagent (`runPlanner`) so both see the same MCP entries — letting the
 * planner introspect e.g. Convex schema while decomposing the request.
 */
export async function resolveMcpArgs(
  projectDir: string,
  mcpConfigPath: string | undefined
): Promise<string[]> {
  if (!mcpConfigPath) return [];
  const lexicalProject = resolvePath(projectDir);
  const realProject = await realpath(projectDir).catch(() => lexicalProject);
  const lexicalAbs = resolvePath(projectDir, mcpConfigPath);
  if (!isInside(lexicalAbs, lexicalProject)) return [];
  try {
    await access(lexicalAbs);
  } catch {
    // Missing file is non-fatal: many projects haven't opted in.
    return [];
  }
  const realAbs = await realpath(lexicalAbs).catch(() => lexicalAbs);
  if (!isInside(realAbs, realProject)) return [];
  return ['--mcp-config', realAbs];
}
