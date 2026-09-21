---
name: wiring-audit
description: Finds orphan code — files, exports, components, routes, handlers created but never imported, rendered, mounted, or registered by production code — and reports or fixes it. Runs `fullauto audit [--base <ref>]` when the CLI is on PATH; otherwise walks `git diff` by hand, finds a production consumer per artifact with `git grep`, prints `artifact | consumer | status`; knows framework entrypoint exemptions. TRIGGER — "wiring", "와이어링", "연결됐나", "orphan", "고아 코드", "dead code", "안 쓰이는 파일", "unused export", "not rendered", `/wiring-audit`, a fullauto `orphan-code` defer. SKIP for doc-only changes.
user-invocable: true
allowed-tools:
  - Bash(fullauto:*)
  - Bash(command -v *)
  - Bash(git status*)
  - Bash(git diff*)
  - Bash(git log*)
  - Bash(git grep*)
  - Bash(git ls-files*)
  - Bash(git show*)
  - Bash(git rev-parse*)
  - Bash(npm *)
  - Bash(npx *)
  - Bash(pnpm *)
  - Bash(yarn *)
  - Bash(pytest*)
  - Bash(go *)
  - Bash(cargo *)
  - Bash(make *)
  - Bash(ls *)
  - Bash(cat *)
  - Bash(test *)
  - Read
  - Edit
  - Write
  - Grep
---

# /wiring-audit — Is the new code actually connected?

Gates and reviewers verify that code is *correct*; this skill verifies it is *reachable*: every added file, export, component, route, handler, env read, and migration needs a production consumer or a documented reason not to. Orphan code is the signature of hallucinated completion.

## Arguments

```
/wiring-audit [base=<git-ref>] [fix|report] [free text: which change to audit]
```

`base` — ref to compare against the working tree (default `HEAD`; `base=main` audits a branch). `fix` (default inside fullauto, or when asked) wires the orphans and re-runs; `report` (default manually) prints the table only.

## Step 1 — Prefer the deterministic tool

```bash
command -v fullauto >/dev/null 2>&1 && fullauto audit --base <ref>     # add --dir <path> / --json as needed
```

It diffs the base ref against the working tree and runs the tree-based checks — `orphan-code`, `unused-export`, `test-integrity`, `gate-integrity` (respecting the `audit` toggles in `.fullauto/config.json`); checks needing a transcript, gate output, or run state (`wiring-manifest`, `test-count`, `tdd-red` / `tdd-green`, `pending-wiring`) run only inside the orchestrator. Findings print BLOCK → WARN → INFO as `- [BLOCK] <check> <path>[:line] — <message>`, exit 1 on any BLOCK. When it runs, go to Step 4. Binary missing → say `fullauto not on PATH — manual audit`, do Steps 2–3, never install it.

## Step 2 — Manual: enumerate artifacts

```bash
git diff --name-status <base> -- .          # tracked changes
git ls-files --others --exclude-standard    # untracked (new) files
```

Artifacts = added files, plus modified files that gained an `export` (compare `git show <base>:<path>`). Ignore test files (`test/`, `tests/`, `__tests__/`, `e2e/`, `*.test.*`, `*.spec.*`, `*.stories.*`, `*_test.go`, `test_*.py`), non-code, and the **entrypoint exemptions** — framework-addressed files no one imports:

| Pattern | Why exempt |
|---|---|
| Next.js `app/**/(page\|layout\|route\|loading\|error\|not-found\|template\|default\|middleware\|proxy).*` + special files (`actions`, `sitemap`, `robots`, `manifest`, `icon`, `opengraph-image`); `pages/**` | resolved by path |
| `middleware.*`, `instrumentation.*`, `proxy.*`; `index\|main\|cli\|server\|app.*` at depth ≤ 2; `bin/**`, `scripts/**` | hooks and process entry points |
| `migrations/**`, `alembic/versions/**`, `prisma/migrations/**`, `supabase/migrations/**` | run by the migration tool |
| `convex/**`; root `api/**`; `netlify/functions/**`, `supabase/functions/**`, Firebase `functions/index.*` | name- / path-addressed functions |
| `*.d.ts`, `*.config.*`, `__mocks__/**`, `stories/**`, `storybook/**` | loaded by tooling |
| Remix `app/routes/**`; SvelteKit `routes/**/+page\|+layout\|+server\|+error.*`, `src/hooks.*`; Nuxt `layouts\|plugins\|composables\|middleware/*`, `server/api\|routes\|middleware\|plugins/**` | file routing / auto-discovery |
| `main.go`, `cmd/**`; `__init__.py`, `manage.py`, `wsgi.py`, `asgi.py`, `management/commands/**`, Django `models\|admin\|apps\|tasks\|settings\|celery\|signals.py`, `settings/*.py`; `src/main.rs`, `src/lib.rs`, `mod.rs`, `build.rs` | language / framework entry points |

Go files are skipped (package-level wiring). Java / Kotlin / C# / Swift / PHP files with no reference are WARN, not BLOCK — DI / annotation discovery wires classes nothing names.

## Step 3 — Manual: find the consumer

Search production code (code extensions only, excluding the artifact and test paths):

```bash
git grep -n -I --untracked -e '<basename>' -- ':!<artifact>' ':!test/**' ':!**/*.test.*' ':!**/*.spec.*'
git grep -n -w --untracked -e '<ExportedName>' -- ':!<artifact>' ':!test/**' ':!**/*.test.*'
```

A hit counts only when the line does the right thing: module → `import` / `require` / `from x import` / `use crate::` / `mod x;`; component (PascalCase in `.tsx/.jsx/.vue/.svelte`) → rendered `<Name` or passed to a router (an import alone is not enough); route / handler / listener / job / CLI subcommand → registered (`app.use(`, `router.get(`, decorator, route table, `program.command(`); env var / flag → branched on or passed on; migration → a model / schema / query changed to match; plain export → referenced by name in production.

| status | meaning | severity |
|---|---|---|
| `wired` | production consumer found and exercises the artifact | ok |
| `entrypoint` | matches an exemption above | INFO |
| `deferred` | task body / PR says `- wired by: T###` | INFO — note the owner |
| `tests-only` | only test files reference it | **BLOCK** |
| `imported-not-used` | imported / defined but never rendered / registered / called | **BLOCK** |
| `orphan` | no reference at all | **BLOCK** |
| `unused-export` | file is wired but a new non-component export has no reference | WARN |

## Step 4 — Report

```
## wiring-audit (base=<ref>, <n> artifacts)

| artifact | consumer | status |
|---|---|---|
| src/components/UserCard.tsx#UserCard | — | BLOCK orphan (exported, never rendered) |
| src/routes/users.ts | src/app.ts:42 (`app.use('/users', usersRouter)`) | wired |
| src/lib/flags.ts#isBetaEnabled | src/lib/flags.ts:9 (read, never branched on) | BLOCK imported-not-used |
| src/services/mailer.ts | (`- wired by: T014`) | deferred |

BLOCK <n> / WARN <n> / ok <n>
```

BLOCKs first; per BLOCK one recommendation — where the consumer should live (`render <UserCard /> in app/users/page.tsx`) or "delete — nothing needs it". If `fullauto audit` ran, keep its finding text verbatim in the status column and list `test-integrity` / `gate-integrity` findings under **Other audit findings**.

## Step 5 — Fix or report

**`fix` mode:** wire each BLOCK where its requirements imply — import + render, register the route, branch on the flag — following the sibling pattern. Delete only a genuinely unnecessary artifact and say why. Never "fix" an orphan with a fake import, a comment, a test-only import, or a bogus `(entrypoint: …)` claim — `fullauto audit` checks the consumer references real code and `/verify-loop` checks it is executed. Re-run until BLOCK is 0, then run the gates once (`npm test` / `pytest` / `go test ./...` / `cargo test` / `make test`). Inside a fullauto task end with the updated manifest:

```
FULLAUTO_WIRING:
- <artifact>[#symbol] -> <consumer file>[:line]
- <artifact> -> (entrypoint: <pattern it matches>)
- <artifact> -> (wired by T###)
```

`(wired by T###)` is valid only when the task body says `- wired by: T###`. No comments inside the block — a trailing `# …` becomes part of the consumer path.

**`report` mode:** print the table and recommendations, change nothing.

## Notes

- With `base=HEAD`, uncommitted work from several fullauto tasks shows up together; say which task owns each BLOCK.
- `- wired by: T###` is a promise, not an exemption: fullauto BLOCKs T### with `pending-wiring` if it finishes without the consumer.
- Reachability only, not correctness — pair with `/verify-loop`.
