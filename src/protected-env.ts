/**
 * Env-var names whose values shape program-loader, TLS-trust, package-fetch,
 * git-transport, or auth behavior. Centralized so every code path that
 * builds a child-process env (spawned services, sourced envFiles,
 * placeholder overlay for subagents) applies the same denylist policy.
 *
 * Threat model: the user controls config.json and any envFile path listed
 * there, but the CONTENT of envFiles can be influenced by external systems
 * (a `convex dev` writing `.env.local` after talking to the Convex
 * deployment, a clone of someone else's `.env` checked in by mistake, etc).
 * Refusing these names defeats the most common stealth-execution vectors:
 *   - PATH / LD_PRELOAD / DYLD_*  → load attacker code on next exec
 *   - NODE_OPTIONS / NODE_PATH    → inject `--require evil.js` into Node
 *   - NODE_EXTRA_CA_CERTS / NODE_TLS_REJECT_UNAUTHORIZED → MITM HTTPS
 *   - npm_config_*                → redirect npm install / install hooks
 *   - GIT_SSH_COMMAND / GIT_*     → run attacker code on next git push/fetch
 *   - SSH_AUTH_SOCK / SSH_ASKPASS → hijack ssh agent / auth prompts
 */
const PROTECTED_ENV_NAMES = new Set([
  // Program loaders and shell startup
  'PATH',
  'CDPATH',
  'IFS',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'SHELL',
  'HOME',
  // Node — runtime hooks and TLS trust
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // Python / Perl
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PERL5OPT',
  // Dynamic linker (Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // Dynamic linker (macOS)
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  // Package managers — registry redirection / install hooks
  'COREPACK_HOME',
  'COREPACK_NPM_REGISTRY',
  'BUN_INSTALL',
  // Git transport — most common path for stealth code execution
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_PROXY_COMMAND',
  // SSH / sudo auth flows
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
  'SUDO_ASKPASS',
]);

/**
 * Strip C0/C1 control characters from any string about to hit a TTY.
 * Used by service log piping, prereq display, and the service-line printer
 * — three formerly-duplicated implementations that drift independently.
 *
 * Strips:
 *   0x00-0x08 (NUL..BS, includes BEL 0x07 — OSC terminator)
 *   0x0b-0x1f (VT, FF, CR 0x0d, ESC 0x1b — kills ANSI/CSI/OSC introducers)
 *   0x7f       (DEL)
 *   0x80-0x9f  (C1 set — raw 8-bit CSI/OSC)
 * Preserves: 0x09 TAB, 0x0a LF (we operate per-line so LF isn't an
 * overwrite vector here anyway).
 */
export function sanitizeForTerminal(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function isProtectedEnvName(name: string): boolean {
  // Prefix families: catch every LD_*/DYLD_* + the npm_config_* family
  // (npm reads any var matching this prefix as a config override, including
  // the dangerous `npm_config_node_options` re-enabling NODE_OPTIONS via
  // the npm wrapper, plus `npm_config_registry`/`cafile` for install hijack).
  if (name.startsWith('LD_') || name.startsWith('DYLD_')) return true;
  if (name.startsWith('npm_config_')) return true;
  return PROTECTED_ENV_NAMES.has(name);
}
