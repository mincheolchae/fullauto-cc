/**
 * Backend presets for `fullauto init --backend <name>`.
 *
 * Each preset is a STARTING POINT — its services/gates/MCP wiring is what
 * a typical user with that stack would want as a first draft. Real
 * deployments will need editing (CLI versions, env var names, additional
 * gates). The init command surfaces the requiredEnv list so the user
 * knows what to configure before running.
 */

export interface RequiredEnv {
  name: string;
  /** One-line human description: what it is, where to obtain it. */
  description: string;
  /** True if the run cannot meaningfully proceed without it. */
  required?: boolean;
}

export interface BackendPreset {
  /** Internal id used by --backend. */
  id: string;
  /** Short human label shown at init time. */
  label: string;
  /** One-line description, shown at init time. */
  description: string;
  /** Env vars the user MUST configure. Printed as a checklist. */
  requiredEnv: RequiredEnv[];
  /** Builds the .fullauto/config.json content. */
  buildConfig(): Record<string, unknown>;
  /** Builds the .fullauto/mcp.json content, or null to skip. */
  buildMcp(): Record<string, unknown> | null;
  /** Optional `.env.example` body to scaffold — null to skip. */
  buildEnvExample(): string | null;
  /**
   * Free-form post-init guidance shown to the user. Multi-line OK.
   * Mention next steps the preset can't auto-perform (e.g. "run `convex
   * dev` once to create a deployment").
   */
  postInitGuidance(): string;
}

export const DEFAULT_PRESET = 'convex';

const COMMON_GATES = [
  {
    type: 'shell',
    name: 'typecheck',
    command: 'npm run typecheck --if-present',
    skipIf: 'test ! -f package.json',
  },
  {
    type: 'shell',
    name: 'test',
    command: 'npm test --if-present -- --passWithNoTests',
    skipIf: 'test ! -f package.json',
  },
  {
    type: 'shell',
    name: 'lint',
    command: 'npm run lint --if-present',
    skipIf: 'test ! -f package.json',
  },
];

const BASE_CONFIG_SHELL_ONLY: Record<string, unknown> = {
  maxPasses: 2,
  subagentTimeoutSec: 1800,
  useReviewLoop: true,
  services: [],
  gates: COMMON_GATES,
};

// ---------- none ----------

const NONE: BackendPreset = {
  id: 'none',
  label: 'No backend',
  description:
    'Frontend-only or static project. Just typecheck/test/lint gates, no services, no backend probes.',
  requiredEnv: [],
  buildConfig: () => BASE_CONFIG_SHELL_ONLY,
  buildMcp: () => null,
  buildEnvExample: () => null,
  postInitGuidance: () =>
    'No backend services configured. Add `services` and HTTP/convex-fn gates later by editing .fullauto/config.json — see README "백엔드별 셋업".',
};

// ---------- convex ----------

const CONVEX: BackendPreset = {
  id: 'convex',
  label: 'Convex',
  description:
    'Convex backend with `npx convex dev` as a managed service. Ships HTTP + convex-fn example gates and the Convex MCP for subagents.',
  requiredEnv: [
    {
      name: 'CONVEX_DEPLOY_KEY',
      description:
        '(production deploys only) From dashboard.convex.dev → Project → Settings → Deploy Key. NOT needed for local dev — `convex dev` uses interactive login on first run.',
    },
  ],
  buildConfig: () => ({
    maxPasses: 2,
    subagentTimeoutSec: 1800,
    useReviewLoop: true,
    mcpConfigPath: '.fullauto/mcp.json',
    services: [
      {
        name: 'convex',
        command: 'npx convex dev',
        readyProbe: 'test -f .env.local && grep -qE "(NEXT_PUBLIC_)?CONVEX_URL" .env.local',
        readyTimeoutSec: 90,
        envFiles: ['.env.local'],
      },
    ],
    gates: [
      ...COMMON_GATES,
      {
        type: 'shell',
        name: 'convex-codegen',
        command: 'npx convex codegen',
        skipIf: 'test ! -d convex',
      },
      // Example convex-fn gate — REPLACE with a real query/mutation from
      // your convex/ directory. The convex-fn gate auto-resolves the
      // deployment URL across CONVEX_URL / NEXT_PUBLIC_CONVEX_URL /
      // VITE_CONVEX_URL so it works regardless of which framework wrote
      // .env.local. (We deliberately do NOT ship a default http gate
      // hard-coded to a single env var name — it would silently fail on
      // Next.js stacks where only the NEXT_PUBLIC_ form is set.)
      {
        type: 'convex-fn',
        name: 'example-query',
        fn: 'health:ping',
        kind: 'query',
        args: {},
      },
    ],
  }),
  buildMcp: () => ({
    mcpServers: {
      convex: {
        // Adjust to your installed version — e.g. `npx -y convex@1.18.0 mcp start`.
        command: 'npx',
        args: ['-y', 'convex@latest', 'mcp', 'start'],
      },
    },
  }),
  buildEnvExample: () => null, // convex dev writes .env.local automatically
  postInitGuidance: () =>
    [
      'Convex preset wired up. Next:',
      '  1. Run `npx convex dev` once interactively — it will prompt to login + create a dev deployment, then write CONVEX_URL to .env.local.',
      '  2. Replace `health:ping` in the example gate with a real query/mutation from your convex/ directory.',
      '  3. Verify the MCP entry in .fullauto/mcp.json matches your installed convex version.',
    ].join('\n'),
};

// ---------- supabase ----------

const SUPABASE: BackendPreset = {
  id: 'supabase',
  label: 'Supabase (local)',
  description:
    'Supabase local stack via `npx supabase start` (Postgres + GoTrue + PostgREST + Storage). HTTP gates probe the REST endpoint.',
  requiredEnv: [
    {
      name: 'SUPABASE_ACCESS_TOKEN',
      description:
        'Personal Access Token from supabase.com/dashboard → Account → Access Tokens. Required for the Supabase MCP server (subagent will fail to call any MCP tool without this).',
      required: true,
    },
    {
      name: 'NEXT_PUBLIC_SUPABASE_URL',
      description:
        'Local API URL. After `supabase start`, run `supabase status` and copy the `API URL` value (typically http://127.0.0.1:54321).',
      required: true,
    },
    {
      name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      description:
        'Local anon key. From `supabase status` output (`anon key`). Use the SERVICE_ROLE_KEY only for server-side admin tasks.',
      required: true,
    },
  ],
  buildConfig: () => ({
    maxPasses: 2,
    subagentTimeoutSec: 1800,
    useReviewLoop: true,
    mcpConfigPath: '.fullauto/mcp.json',
    services: [
      {
        name: 'supabase',
        // `supabase start` is idempotent — already-running stack is a no-op.
        command: 'npx supabase start',
        // GoTrue's /health is publicly accessible (no apikey required), so
        // a successful response actually means "stack is up". PostgREST's
        // root requires apikey and would 401 even on a healthy stack,
        // making `curl -f` exit non-zero.
        readyProbe:
          'curl -fs http://127.0.0.1:54321/auth/v1/health -o /dev/null',
        readyTimeoutSec: 180,
        envFiles: ['.env.local', '.env'],
      },
    ],
    gates: [
      ...COMMON_GATES,
      {
        type: 'shell',
        name: 'supabase-db-lint',
        command: 'npx supabase db lint',
        skipIf: 'test ! -d supabase',
      },
      {
        type: 'http',
        name: 'rest-up',
        url: '${NEXT_PUBLIC_SUPABASE_URL}/rest/v1/',
        headers: { apikey: '${NEXT_PUBLIC_SUPABASE_ANON_KEY}' },
        expectStatus: [200, 401, 404],
      },
      {
        type: 'http',
        name: 'auth-health',
        url: '${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/health',
        headers: { apikey: '${NEXT_PUBLIC_SUPABASE_ANON_KEY}' },
        expectStatus: [200],
      },
    ],
  }),
  buildMcp: () => ({
    mcpServers: {
      supabase: {
        // Verify against your installed version. Some setups use
        // `@supabase/mcp-server-supabase` instead — check the docs.
        command: 'npx',
        args: ['-y', '@supabase/mcp-server-supabase@latest'],
        env: {
          // `${...}` placeholders are expanded at WRITE time by the init
          // command (see expandMcpEnvPlaceholders in cli.ts) — the actual
          // mcp.json on disk contains the real token. Claude CLI does not
          // interpolate MCP env values at spawn time.
          SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}',
        },
      },
    },
  }),
  buildEnvExample: () =>
    [
      '# Local Supabase stack — values come from `npx supabase status`',
      'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY=',
      '# SUPABASE_SERVICE_ROLE_KEY is admin-only — do NOT ship to client',
      'SUPABASE_SERVICE_ROLE_KEY=',
      '',
      '# MCP server auth (Personal Access Token from dashboard)',
      'SUPABASE_ACCESS_TOKEN=',
      '',
    ].join('\n'),
  postInitGuidance: () =>
    [
      'Supabase preset wired up. Next:',
      '  1. Run `npx supabase init` if you haven\'t already (creates supabase/ directory).',
      '  2. Run `npx supabase start` once to verify Docker containers come up.',
      '  3. Run `npx supabase status` and paste API URL + anon key into .env.local (.env.example was scaffolded for you).',
      '  4. Get a Personal Access Token from supabase.com/dashboard → Account → Access Tokens for SUPABASE_ACCESS_TOKEN (MCP).',
      '  5. Verify the MCP entry in .fullauto/mcp.json matches your installed supabase MCP version.',
    ].join('\n'),
};

// ---------- firebase ----------

const FIREBASE: BackendPreset = {
  id: 'firebase',
  label: 'Firebase (Emulator Suite)',
  description:
    'Firebase Local Emulator Suite (auth + firestore + functions). HTTP gate probes the emulator UI.',
  requiredEnv: [
    {
      name: 'FIREBASE_PROJECT_ID',
      description:
        'Your Firebase project id (from console.firebase.google.com). Used by the emulator config and SDK init.',
      required: true,
    },
    {
      name: 'GOOGLE_APPLICATION_CREDENTIALS',
      description:
        '(production / admin SDK) Path to a service-account JSON. NOT needed for local emulator — only for prod deploys or admin-SDK tests against real Firebase.',
    },
  ],
  buildConfig: () => ({
    maxPasses: 2,
    subagentTimeoutSec: 1800,
    useReviewLoop: true,
    services: [
      {
        name: 'firebase-emulators',
        // Adjust the --only list to the emulators your project uses.
        command:
          'npx firebase emulators:start --only auth,firestore,functions --project ${FIREBASE_PROJECT_ID:-demo-project}',
        // Emulator UI on :4000 comes up last; if it answers we're ready.
        readyProbe: 'curl -fs http://127.0.0.1:4000 -o /dev/null',
        readyTimeoutSec: 180,
        envFiles: [],
      },
    ],
    gates: [
      ...COMMON_GATES,
      {
        type: 'http',
        name: 'firestore-emulator-up',
        url: 'http://127.0.0.1:8080',
        expectStatus: [200, 400, 404],
      },
      {
        type: 'http',
        name: 'auth-emulator-up',
        url: 'http://127.0.0.1:9099',
        expectStatus: [200, 400, 404],
      },
    ],
  }),
  // No first-class Firebase MCP at the time of writing. Skip rather than
  // ship a placeholder that would always fail to spawn.
  buildMcp: () => null,
  buildEnvExample: () =>
    [
      '# Firebase project id (console.firebase.google.com)',
      'FIREBASE_PROJECT_ID=demo-project',
      '',
      '# (Optional) for admin-SDK / production tests:',
      '# GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/serviceAccountKey.json',
      '',
    ].join('\n'),
  postInitGuidance: () =>
    [
      'Firebase preset wired up. Next:',
      '  1. Run `npx firebase init emulators` if you haven\'t already.',
      '  2. Set FIREBASE_PROJECT_ID in .env.local (.env.example was scaffolded).',
      '  3. Run `npx firebase emulators:start` once to verify ports 4000/8080/9099 are free.',
      '  4. The preset does NOT register a Firebase MCP — there is no first-class one yet. Add `mcpConfigPath` manually if you have a community MCP installed.',
    ].join('\n'),
};

// ---------- rest (generic HTTP backend) ----------

const REST: BackendPreset = {
  id: 'rest',
  label: 'Generic REST/HTTP backend',
  description:
    'Your own dev server (Express / Fastify / FastAPI / etc.) — preset assumes `npm run dev` and a /health endpoint. Edit to taste.',
  requiredEnv: [
    {
      name: 'API_BASE_URL',
      description:
        'Base URL of your dev server. Defaults to http://localhost:3000 in the example gate.',
    },
  ],
  buildConfig: () => ({
    maxPasses: 2,
    subagentTimeoutSec: 1800,
    useReviewLoop: true,
    services: [
      {
        name: 'backend',
        command: 'npm run dev',
        // EDIT this readyProbe to your actual health endpoint.
        readyProbe: 'curl -fs ${API_BASE_URL:-http://localhost:3000}/health -o /dev/null',
        readyTimeoutSec: 60,
        envFiles: ['.env.local', '.env'],
      },
    ],
    gates: [
      ...COMMON_GATES,
      {
        type: 'http',
        name: 'health',
        url: '${API_BASE_URL:-http://localhost:3000}/health',
        expectStatus: 200,
      },
    ],
  }),
  buildMcp: () => null,
  buildEnvExample: () =>
    [
      'API_BASE_URL=http://localhost:3000',
      '# Add any auth tokens / DB URLs / 3rd-party API keys your backend needs',
      '',
    ].join('\n'),
  postInitGuidance: () =>
    [
      'Generic REST preset wired up. EDIT before running:',
      '  1. Replace `npm run dev` in services[0].command with whatever starts your backend.',
      '  2. Replace the readyProbe / health gate URL with a real endpoint that returns 200 when ready.',
      '  3. Add domain-specific HTTP gates (e.g. `GET /api/users` returning 200, POST signup returning 201).',
      '  4. Set API_BASE_URL in .env.local (.env.example was scaffolded).',
    ].join('\n'),
};

export const PRESETS: Record<string, BackendPreset> = {
  none: NONE,
  convex: CONVEX,
  supabase: SUPABASE,
  firebase: FIREBASE,
  rest: REST,
};

export const PRESET_IDS = Object.keys(PRESETS);

/**
 * Heuristic auto-detect: scan dependencies in package.json for known
 * backend SDKs and suggest the matching preset. Returns null if nothing
 * recognized or package.json missing — caller renders a hint, doesn't act.
 */
export async function detectPresetFromPackageJson(
  projectDir: string
): Promise<string | null> {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  let pkg: Record<string, unknown>;
  try {
    const raw = await readFile(resolve(projectDir, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }
  const deps = {
    ...((pkg.dependencies as Record<string, string>) ?? {}),
    ...((pkg.devDependencies as Record<string, string>) ?? {}),
  };
  if (deps.convex) return 'convex';
  if (deps['@supabase/supabase-js'] || deps.supabase) return 'supabase';
  if (deps.firebase || deps['firebase-admin']) return 'firebase';
  return null;
}
