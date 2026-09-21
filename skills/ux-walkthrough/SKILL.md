---
name: ux-walkthrough
description: Drives the product like a first-time user — web via Playwright MCP or a local `npx playwright` script, API via curl, CLI via `--help` and sample runs — through the core journeys and reports empty/loading/error states, feedback, dead ends, 404s, mobile 390×844, console errors and a11y basics as a findings table + ready-to-paste task lines, ending with `UX_WALKTHROUGH:`. TRIGGER — "써보고", "사용자 입장에서", "UX 점검", "동선 확인", "모바일에서", "walk through the app", "try it as a user", "click through", "ux check", `/ux-walkthrough`, or a call from /product-assess or /vibe-enhance. SKIP for pure libraries.
user-invocable: true
allowed-tools:
  - mcp__playwright__*
  - Bash(npx playwright*)
  - Bash(curl *)
  - Bash(npm run *)
  - Bash(pnpm run *)
  - Bash(yarn *)
  - Bash(node *)
  - Bash(python *)
  - Bash(go run *)
  - Bash(cargo run *)
  - Bash(kill *)
  - Bash(lsof *)
  - Bash(command -v *)
  - Bash(test *)
  - Bash(ls*)
  - Bash(cat*)
  - Bash(mkdir *)
  - Bash(date *)
  - Bash(sleep *)
  - Bash(git status*)
  - Bash(git ls-files*)
  - Read
  - Write
  - Grep
  - Glob
---

# /ux-walkthrough — Try the product as a first-time user

Gates prove the code compiles and tests pass; reviewers prove it is correct; the audit proves it is wired. None of them prove that a person can arrive, do the one thing the product promises, and see the result. This skill does that: it drives the real surface, records what a user would see, and turns every gap into a task line the planner can consume. It is read-only on the project — the only files it writes live under `.fullauto/ux/`.

## Arguments

```
/ux-walkthrough [surface=auto|web|api|cli] [url=<base url>] [journeys=<n>] [scope=<F id | route | feature label>] [mobile=on|off] [out=<dir>]
```

| Arg | Default | Meaning |
|---|---|---|
| `surface` | `auto` | Force a surface, or detect (Step 1). |
| `url` | detected | Base URL of an already-running server. When given, do not start anything. |
| `journeys` | `4` | Max journeys to walk (core loop first). |
| `scope` | all | Restrict journeys to those that touch this feature id, route, or label (`/vibe-enhance` passes the just-built feature). The MVP loop is still walked once when it overlaps. |
| `mobile` | `on` | Re-walk the primary journey at 390×844. |
| `out` | `.fullauto/ux/<YYYYMMDD-HHMMSS>/` | Screenshot and log directory (`date +%Y%m%d-%H%M%S`). |

## Step 0 — Pick the journeys

1. If `.fullauto/product.md` exists: the journeys are the feature-map rows with status `done` or `in-progress`, plus the round-1 MVP loop as journey 1 (onboard → core action → visible result, from the Round log). Read each row's `note` — it is the acceptance line for that journey.
2. Otherwise infer: the entry route (`/`), then each top-level route / page / command in the order a new user meets them (sign-up before dashboard, create before list). Cap at `journeys`.
3. Write the list before touching anything: `J1 <name>: <step> → <step> → <expected result>`. Every finding cites a `J<n>/<step>`.

## Step 1 — Detect the runnable surface

Check in this order and take the first hit (or all that apply when `surface=auto` and the project has both a web app and an API):

| Signal | Surface | How to reach it |
|---|---|---|
| `url=` given | as given | use it, start nothing |
| `.fullauto/config.json` `services[]` with a `readyProbe` | web / api | probe the port with `curl -sf`; if it answers, the orchestrator is running it — use it, do not start or stop it |
| `package.json` script `dev` (else `start`, `preview`) with a web framework dep (`next`, `react`, `vue`, `svelte`, `astro`, `nuxt`, `remix`, `vite`, `express` + views) | web | Step 2 |
| `openapi.*` / `swagger.*`, or a routes directory (`routes/`, `app/api/`, `api/`, `pages/api/`, `src/routes`, `urls.py`, `router.go`) and a `dev` / `start` script or `main.py` / `main.go` | api | Step 2, then curl |
| `package.json` `bin`, `pyproject` `[project.scripts]`, `cmd/` + `main.go`, `src/main.rs` with `clap` | cli | build once if needed (`npm run build` when `bin` points into `dist/`), then run the entry directly |
| none of the above | none | print the no-op line (Step 7) and stop |

Record the detected surface and the exact command / URL / binary in the report.

## Step 2 — Start what you need (and remember it)

Only when nothing is already listening:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN            # occupied before you start = not yours, never kill it
```

Start the dev server with the `Bash` tool in the background (`run_in_background`), capture its PID, take the port from the server's own output (fallback: the framework default — Next / Rails 3000, Vite 5173, Astro 4321, Django / uvicorn 8000, Express as configured), and poll `curl -sf <url>` every 2 s for up to 60 s (90 s for a Next.js first compile). Write `<out>/server.log` from the process output. If it never answers: record `P1 J0/start: dev server did not become ready in 60 s — <last log lines>` as the only finding, stop the process, and go to Step 7 — a product that does not start has no UX to walk.

Anything you start you stop (Step 6). Keep a line `started: pid=<n> port=<n> cmd=<cmd>` in your notes — it is the teardown list.

## Step 3 — Web walk

**Driver preference.** (1) Playwright MCP tools if `mcp__playwright__browser_navigate` is callable: use `browser_navigate`, `browser_snapshot` (accessibility tree — this is how you "see"), `browser_click`, `browser_type`, `browser_fill_form`, `browser_press_key`, `browser_wait_for`, `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_resize`, `browser_evaluate` (a11y probes only), and `browser_close` at the end. (2) Otherwise, if Playwright is installed locally (`test -x node_modules/.bin/playwright` or `@playwright/test` in `node_modules`), write one throwaway script to `<out>/walk.mjs` that performs the same steps, saves screenshots, and prints a JSON array of `{journey, step, observed}` lines; run it with `npx playwright` / `node`. Never install Playwright or browsers here — not globally, not as a dependency; an assess step is the wrong place to grow the project. (3) Neither available → HTTP-level walk: `curl -s -o /dev/null -w '%{http_code}'` on every route from Step 0, `curl -s <url> | grep -c '<title>'`, and check that HTML for the entry route contains a root element and no "Application error" / stack trace text. Record `INFO: browser walkthrough unavailable (no Playwright MCP, playwright not installed) — HTTP-level checks only` as the first row and skip the checklist items that need a browser.

**Journey checklist — at every step of every journey, record observed vs expected:**

| Check | How | Finding when |
|---|---|---|
| Arrival | navigate; snapshot | blank page, spinner > 5 s, unstyled HTML, error boundary, or no obvious primary action |
| Empty state | first visit of every list / board / feed with no data | "No data" with no create action; a table header with no rows and no message; a crash on empty arrays |
| Loading state | throttle nothing — just observe first paint vs data paint | layout jumps > one row height; content flashes from empty to full without a skeleton or spinner on data views that take > 300 ms |
| Core action | perform the create / submit / check-in / send with a value prefixed `uxwalk-<timestamp>` | action not possible, silently ignored, or result not visible afterwards |
| Feedback | after every mutation | no toast / inline confirmation / row update within 1 s; button does not disable during submit (double submit possible) |
| Validation and error state | submit empty; submit an invalid value (bad email, 300-char title, negative number); when an API is involved, request a non-existent id | no message; message not next to the field; generic "Something went wrong" with no recovery; unhandled promise rejection in console |
| Persistence | reload the page (`browser_navigate` to the same URL) after the core action | the created item is gone |
| Dead ends | every link and button on the visited pages | 404, unlinked back navigation, a page with no way to the primary action, a modal that cannot be closed by Escape |
| 404 route | navigate to `/this-route-does-not-exist-<ts>` | framework default error page, 200 with blank content, or a 500 |
| Console | `browser_console_messages` after each journey | any `error` level entry, hydration mismatch, failed network request on the core path |
| Mobile | `browser_resize` 390 844, re-walk J1 | horizontal scroll, overlapping controls, tap targets < 40 px, primary action off-screen, text < 14 px |
| A11y basics | snapshot: every `textbox` / `combobox` / `checkbox` has a name; every `button` / `link` has a name; every `img` has alt; headings start at h1 and do not skip; press Tab through the primary form — focus visible and in reading order; if `axe-core` exists in `node_modules`, inject it via `browser_evaluate` and read `violations[].id` for contrast | any unnamed control, missing alt on content images, skipped heading level, invisible focus, axe `serious` / `critical` violation |

Take a screenshot at journey start, after the core action, on every finding, and at the mobile re-walk: `<out>/J<n>-<step>-<slug>.png`. Do not screenshot every click — 6–15 images per walkthrough is the norm.

**Auth in the way.** If the entry route redirects to sign-in: use test credentials from `.env.example` / `README` / a seed script when documented; otherwise go through sign-up with `uxwalk-<ts>@example.com`. Magic-link or OAuth-only sign-in with no local bypass → record `P2 J1/sign-in: no local sign-in path for automated walkthroughs — add a seed user or dev bypass` and continue with whatever is public.

**Clean up what you created** when a delete path exists (delete the `uxwalk-` items at the end of the journey). If none exists, say so under INFO — that is itself a finding for most categories.

## Step 4 — API walk

Enumerate endpoints from the OpenAPI document (preferred) or the route files. For each endpoint, up to 12: one happy-path call with a valid body, then two error paths — `400 / 422` (invalid body: wrong type, missing required field), and `401` when the API has auth (no token) else `404` (unknown id). Use `curl -s -w '\n%{http_code}' -H 'content-type: application/json'`.

Check and record: status code matches the documented / conventional one; response is JSON with a consistent envelope across endpoints (`{ error: { code, message } }` or the framework's standard — mixed shapes is a P2); list endpoints paginate (`limit` / `cursor` or `page`); unknown route returns JSON 404, not HTML; a 5xx anywhere is P1; error bodies never contain stack traces (P1 when they do); `content-type` is set. Health endpoint answers 200. Save each request / response pair to `<out>/api.log`.

## Step 5 — CLI walk

Run in a temp directory under `<out>/cli-tmp/` so nothing lands in the repo. `--help` on the root and every subcommand listed there; `--version`. For each documented command run the README example verbatim, then one wrong invocation (missing required arg, non-existent file). Record: exit code 0 on success and non-zero on error; errors on stderr with a suggested fix; data on stdout; `--json` when documented parses; no prompt blocks when stdin is not a TTY (run with `< /dev/null`); `--help` shows at least one example per command; startup < 2 s for `--help`. Save transcripts to `<out>/cli.log`.

## Severity

| Severity | Definition |
|---|---|
| **P1** | The core loop cannot be completed, data is lost, a 5xx / crash / unhandled error appears on the core path, the server does not start, a persisted result disappears on reload |
| **P2** | The journey completes but degraded: missing feedback, error with no recovery, empty state with no action, dead end, mobile layout broken, console error off the core path, missing or inconsistent error shape, unnamed form control on the core form |
| **P3** | Cosmetic and copy: alignment, wording, minor a11y outside the core form, missing polish a peer would have |

When unsure between two levels, pick the lower severity and say why in `observed`.

## Step 6 — Stop what you started

For every `started:` line: `kill <pid>`; wait 2 s; `lsof -nP -iTCP:<port> -sTCP:LISTEN` must be empty, else `kill -9 <pid>`. Close the browser (`mcp__playwright__browser_close`). Never kill a process you did not start — a port that was busy before Step 2 belongs to the orchestrator or the user. Confirm in the report: `stopped: pid=<n> (port <n> free)` or `nothing started`.

## Step 7 — Report

```
## ux-walkthrough — <surface> (<n> journeys, <n> findings)

surface: web · url: http://localhost:3000 · driver: playwright-mcp | playwright-script | http-only · screenshots: .fullauto/ux/<ts>/
journeys: J1 <name> ✓ | J2 <name> ✗ (P1 at step 3) | J3 <name> ✓

| severity | journey/step | observed | expected | fix (as a task line) |
|---|---|---|---|---|
| P1 | J2/check-in submit | POST /api/checkins → 500, toast never shows; console: TypeError in checkin.ts:42 | 201 + streak counter increments | Fix POST /api/checkins 500 on second check-in of the day (`src/routes/checkins.ts`) |
| P2 | J1/habits list (empty) | "No habits" text only | empty state with a "Create your first habit" button | Add empty-state CTA to `app/habits/page.tsx` |
| P3 | J1/mobile | habit title wraps under the checkbox at 390 px | title and checkbox on one row | Fix habit row layout below 400 px |

### Tasks (paste into tasks.md; renumber)

- [ ] T901 Fix POST /api/checkins returning 500 on the second check-in of the same day in `src/routes/checkins.ts`
  - risk: medium
  - level: e2e
  - journey: J2/check-in submit — observed 500 + console TypeError; expected 201 and the streak counter to increment
  - re-walk acceptance: two check-ins on the same habit and day → second returns 409 with `{ error: { code: "already_checked_in" } }`, UI shows "Already done today"
- [ ] T902 Add an empty-state call to action on the habits list in `app/habits/page.tsx`
  - risk: low
  - level: e2e
  - journey: J1/habits list — observed text-only empty state; expected a "Create your first habit" button that opens the create form
  - no test: presentational; covered by the J1 e2e re-walk in the next round

### INFO
- browser walkthrough driver: playwright-mcp
- created and deleted: 2 habits (`uxwalk-<ts>-*`)
- stopped: pid=48213 (port 3000 free)

UX_WALKTHROUGH: surface=web journeys=3 findings=3 p1=1 p2=1 p3=1 screenshots=.fullauto/ux/20260921-104512/
```

Task-line rules: ids `T9xx` so they cannot collide with planner ids (the consumer renumbers); one finding per task; title = verb + observed defect + file or route; `- risk:` from the verify-loop keyword list (`high` for auth / payments / schema / delete paths, else `medium` for behavior, `low` for layout / copy); `- level:` `e2e` for anything a user sees, `integration` for API shape, `unit` only for pure logic; a `- journey:` line quoting observed and expected; a `- re-walk acceptance:` line stating what the next walkthrough must observe; `- no test: <reason>` only for pure layout / copy fixes. P1 findings first.

**No-op** (nothing runnable, or `surface=none`): print exactly one line and nothing else —

```
UX_WALKTHROUGH: surface=none journeys=0 findings=0 p1=0 p2=0 p3=0 screenshots=none — nothing runnable (<reason: no dev script / no routes / no bin>)
```

The `UX_WALKTHROUGH:` line is always the last line of the output; `/product-assess` and `/vibe-enhance` read it.

## Rules

- **Observe, do not fix.** This skill changes nothing in the project. Fixes are task lines; the planner or the caller applies them.
- **Real surface only.** Never simulate a walkthrough from reading the code when a server can run. If it cannot run, say so in the first row and downgrade to HTTP-level or code-level checks explicitly.
- **Stop what you started, keep what you found.** Servers and browsers are torn down; screenshots and logs under `<out>` stay.
- **Prefix everything you create with `uxwalk-<ts>`** and delete it when the product offers a delete path.
- **Budget:** ≤ `journeys` journeys, ≤ 12 API endpoints, ≤ 15 screenshots, ≤ 10 minutes of wall-clock including server start. Report what you covered and what you skipped.
- **Every finding has a journey/step, an observed, an expected, and a fix.** A finding without all four is a note, not a finding — put it under INFO.
- **No decorative emojis;** functional glyphs (✓ ✗) are fine.
