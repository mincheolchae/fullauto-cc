---
name: product-shape
description: Turns a one-line concept into a durable product brief at `.fullauto/product.md` — users, category + peer benchmarks, principles, feature map, recorded decisions, and a prioritized backlog whose round-1 items form one complete usable loop. Never asks; ambiguity is resolved project signal → convention → default and recorded. TRIGGER — "기획", "제품 기획", "브리프", "PRD", "MVP 정의", "백로그 만들어", "product brief", "shape the product", "flesh out this idea", `/product-shape`, or a `fullauto evolve` shape prompt. SKIP when product.md exists without "reshape" / `--force` (use /product-assess).
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - WebSearch
  - WebFetch
  - Skill
  - Bash(git log*)
  - Bash(git status*)
  - Bash(ls*)
  - Bash(cat*)
  - Bash(find*)
  - Bash(mkdir *)
  - Bash(date *)
  - Bash(test *)
---

# /product-shape — Concept → product brief (`.fullauto/product.md`)

A concept is one sentence; a product is a loop a user can complete. This skill writes the document that turns one into the other and that every later round of `fullauto evolve` reads, updates, and is judged against. The brief is **product memory**: decisions are made once, written down with their source, and never re-asked. The output is a file in an exact format — `fullauto evolve` validates it (`validateProductBrief`) and aborts the run if it is malformed, so the template below is a contract, not a suggestion.

## Arguments

```
/product-shape <concept text> [out=<path>] [reshape]
```

| Arg | Default | Meaning |
|---|---|---|
| `<concept text>` | required | The user's concept, one line to one paragraph. Copied verbatim into `## Concept`. |
| `out` | `.fullauto/product.md` | Where to write the brief. The `fullauto evolve` shape prompt passes an absolute path — use it verbatim. |
| `reshape` | off | Overwrite an existing brief. Also implied when the prompt says `--force`, or when it carries a `## Validation errors` block from a previous attempt (fix exactly those errors, keep everything else). |

If `out` already exists and `reshape` is not implied: print `product-shape: <path> exists — use /product-assess to update it, or pass reshape` and stop. Do not touch the file.

## Never ask (resolution order)

`fullauto evolve` is unattended and there is no channel back to the user. Every "the user did not say X" is a decision you make now and record. Resolve in this order, stop at the first that answers:

1. **Project signal** — existing code, manifests, README / CLAUDE.md, `.fullauto/config.json`, `.env.example`. What the repo already does wins over everything.
2. **Recent direction** — `git log --oneline -30`: what the last commits invested in (a migration to X, a new module, a rename) tells you where the project is heading.
3. **Category convention** — the primary category's playbook (`_shared/playbooks.md`, see Step B) and what the benchmarked peers all do.
4. **Default** — the boring, proven choice with the fewest moving parts for a solo vibe-coder: SQLite locally / Postgres when a Postgres client is already present; session or magic-link auth over OAuth; the framework's own router / fetcher; static or single-service hosting; English UI strings with a single locale file.

A decision that genuinely cannot be made autonomously (a paid service, credentials, a legal or business call that changes scope) still gets a runnable placeholder — a stub mailer that logs, SQLite instead of a managed DB, a feature flag defaulting off — and is recorded with source `needs human`. Never write a question into the brief.

**Decisions format** (one bullet each, under `## Decisions`):

```
- <decision> — <source>: <rationale>
```

`<source>` is exactly one of `project signal (<file or path>)`, `recent direction (<commit sha or theme>)`, `convention (<playbook id> | <peer name>)`, `default`, `needs human (<what a person must provide>)`. Minimum set every brief records, even when obvious: product name, stack (language / framework / db), auth model, persistence, hosting / deploy target, default locale, test runner.

## Step A — Absorb project signal (≤ 12 reads)

Greenfield (empty dir or only a README): read what exists and move on. Brownfield: read in this order and stop at 12 files —

1. `README.md`, `CLAUDE.md` / `AGENTS.md`
2. Manifest: `package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `Gemfile` / `composer.json` / `pubspec.yaml`
3. `.fullauto/config.json` (gates, services — tells you what is runnable), `.env.example`
4. `git log --oneline -30` (one Bash call) and `git status --short`
5. The top-level directory listing plus the routes / pages / commands directory, to enumerate what already exists
6. One representative source file from the core domain (the model or the main handler)

Produce two internal lists before Step B: **exists already** (features the repo implements — these become `done` rows in the feature map with round `0` and note `pre-existing`) and **stack facts** (framework, db, auth lib, test runner, deploy config present or absent).

## Step B — Classify the category

Open the shared playbook: `_shared/playbooks.md` next to this skill's directory (`~/.claude/skills/_shared/playbooks.md` when installed per the README, `skills/_shared/playbooks.md` inside the fullauto-cc repo; try both, never ask). If neither exists, pick the category id from this list — `saas-dashboard`, `marketplace`, `social-community`, `content-cms-blog`, `e-commerce`, `productivity-tool`, `chat-messaging`, `api-backend-service`, `cli-dev-tool`, `mobile-app`, `data-pipeline`, `ai-assistant-app`, `portfolio-landing` — use the Step C peer intersection as the table-stakes list, and record `- Playbook unavailable — default: table-stakes from peer intersection only` under `## Decisions`. Pick the **primary** category by the answer to "what does the user do most of the time in this product?" — not by the stack. Add a **secondary** category only when ≥ 3 of its table-stakes items apply and are not in the primary's list (e.g. an `ai-assistant-app` that is also a `saas-dashboard`). Never more than two. Walk the primary's Table-stakes, UX must-haves, Trust / safety, and Common mistakes now: every table-stakes item is a candidate feature; every common mistake becomes a non-goal or a principle.

## Step C — Benchmark scan (WebSearch, ≤ 5 queries)

Find 3–5 peer products the target user would compare this to. Queries: `<category> app for <target user>`, `best <domain> tools 2026`, `<peer name> features`. For each peer note the URL and its visible feature list (pricing / features page, docs). Then:

- **All of them have** = the intersection (aim for 6–12 items). These are table-stakes and are cross-checked against the playbook list; an item in both is P1 or P2 depending on the MVP rule below.
- **Worth having** = 1–2 differentiators that at least one peer has and that directly serve the core value. Cite which peer.

No web access, or fewer than 3 usable peers after 5 queries → write `Benchmark source: playbook only (no web)` and use the playbook table-stakes as the intersection. Do not fabricate peers or URLs.

Brownfield only: when the repo already has a runnable surface, invoke `/vibe-enhance mode=pre` (candidates only, applies nothing) and merge its candidate list into the backlog as P2 / P3 items with `impact` and `effort` from its scores. Greenfield: skip — Step B already covered the checklist.

## Step D — Write the brief (exact template)

Write the file with `Write` (create the parent directory first). The template is exact: the `# Product:` line first, the marker line second, all eight `##` sections in this order with these titles, nothing else at h2 level.

```markdown
# Product: <name>
<!-- fullauto:product v1 -->

## Concept
<the user's words, verbatim — no paraphrase, no expansion>

## Target users & core value
- Primary user: <role + situation, one line>
- Secondary user: <role, or "none">
- Job to be done: <what they are trying to accomplish, in their words>
- Core value: <the one outcome that must work; if it fails nothing else matters>
- Not for: <who this deliberately does not serve>

## Category & benchmarks
- Category: `<playbook id>` (secondary: `<playbook id>` | none)
- Peers: <Name> (<url>); <Name> (<url>); <Name> (<url>)
- All of them have: <item>; <item>; <item>; <item>; <item>; <item>
- Worth having: <item> — <peer, why it serves the core value>; <item> — <peer, why>
- Benchmark source: web (<YYYY-MM-DD>) | playbook only (no web)

## Principles & constraints
- Stack: <language / framework / db / hosting, one line>
- Quality bar: tests through the real entry point for every core journey; loading / empty / error states on every data view; labels, focus, contrast on every form; responsive at 390×844 and 1280×800; README + .env.example + CI green
- Scope rule: depth before breadth — polish and harden the shipped loop before adding new surface
- Non-goals: <one per line, at least two>
- Constraints: <platform / legal / performance / budget, or "none known">

## Feature map
| id | feature | status | round | note |
|---|---|---|---|---|
| F001 | <feature> | planned | 1 | <what "done" looks like, one line> |
| F002 | <feature> | planned | 1 | <...> |
| F003 | <feature> | planned | 2 | <...> |
| F004 | <feature> | planned | - | <...> |

## Decisions
- <decision> — <source>: <rationale>

## Backlog
- [P1] F001 <feature> — impact:H effort:M — <why now>
- [P1] F002 <feature> — impact:H effort:S — <why now>
- [P2] F003 <feature> — impact:M effort:M — <why now>
- [P3] F004 <feature> — impact:L effort:L — <why now>

## Round log
### Round 0 — <YYYY-MM-DD>
- shaped: <n> features, MVP = F001–F00k, category `<id>`
- next focus: F001, F002, ...
```

**Feature map rules.** `id` = `F` + three digits, unique, ascending, never reused (a rejected feature keeps its id). `feature` ≤ 8 words, a user-visible capability ("Daily check-in with streak"), not a task ("add checkin table"). `status` ∈ `planned | in-progress | done | deferred | rejected`. `round` = the round it is scheduled for (integer) or `-` when unscheduled; pre-existing features are `done` with round `0`. `note` = what done looks like — `/product-assess` uses it as the acceptance line. Cells never contain `|`.

**Backlog grammar** (one line per open feature; the validator rejects anything else):

```
- [P1] F001 <feature> — impact:H effort:M — <why now>
```

`[P1|P2|P3]` priority · `F###` an id from the feature map · `<feature>` identical to the feature-map cell · ` — ` (space, em dash, space) · `impact:H|M|L` · space · `effort:S|M|L` · ` — ` · `<why now>` one clause. Order: P1 block first, then P2, then P3; inside a block by impact descending, then effort ascending. Every feature-map row with status `planned` or `deferred` has exactly one backlog line; `done` and `rejected` rows have none (the only exception is a row `/product-assess` parked — `round` `-`, note starting `parked:` — which has no line until the cap frees up). Cap 25 lines, minimum 1.

- `impact` H = the core value is not delivered or the user is blocked without it · M = peers all have it (table-stakes) but the loop works without it · L = differentiator or nice-to-have.
- `effort` S = one task (≤ 1 subagent hour) · M = 2–3 tasks · L = 4+ tasks. Split an L into two features when a natural seam exists; the planner cannot fit two L items in one round.
- `P1` = in the MVP loop or a defect that breaks it · `P2` = depth: robustness, UX states, table-stakes that complete an existing surface · `P3` = breadth: new surface, differentiators.

**MVP rule (round 1).** The features with `round = 1` are the smallest set that lets a brand-new user complete **onboard → core action → visible result**: arrive (and sign in only if the core value needs identity) → do the one thing the concept promises → see it persisted and rendered / returned so it is still there after a refresh or a second run. Name which feature covers each of the three legs in the Round 0 log line. 3–6 features; assume ~2 tasks per feature (red test + impl) plus 1–2 setup tasks, so the round fits `maxTasksPerRound` (default 12). Persistence is always part of round 1 (a result that vanishes is not a visible result). Auth is round 1 only when the core action is meaningless without identity (teams, per-user data across devices); otherwise it is P2. Round 2 is depth on the same loop (empty / error states, reminders, mobile pass, table-stakes that complete the surface); breadth starts at round 3 at the earliest.

**Principles** always carry the quality bar line as written above (the evolve pipeline enforces it), the scope rule, and at least two non-goals taken from the playbook's Common mistakes or from peer features that do not serve the core value.

## Worked mini-example

Concept: `habit tracker for remote teams`. Step A: empty repo. Step B: primary `productivity-tool`, secondary `saas-dashboard` (workspace, members, team view). Step C: Habitify, Streaks, Loop Habit Tracker, Habitica — all have habit with schedule, daily check-in, streak, reminders, history view; differentiator worth having: team accountability board (Habitica parties). Decisions include `- Auth by email magic link, no passwords — convention (productivity-tool; Habitify, Todoist): team identity needs sign-in and magic links avoid password-reset scope`. Backlog excerpt:

```
- [P1] F001 Sign in by magic link & team workspace with invite link — impact:H effort:M — identity is the "team" in the concept; onboard leg
- [P1] F002 Create a habit with a schedule (daily / weekdays / custom days) — impact:H effort:M — the core object; nothing to check in without it
- [P1] F003 Daily check-in with personal streak — impact:H effort:M — the core action and its visible result; closes the loop
- [P1] F004 Team board: who checked in today — impact:H effort:S — the remote-team payoff; why this beats a personal app
- [P2] F005 Reminder email at the member's local time — impact:M effort:M — all four peers have reminders; needs the time zone setting from F001
- [P2] F006 Empty, loading, error states and a 390×844 layout pass on every view — impact:M effort:S — quality bar; assess flags gaps as P1 defects otherwise
```

Round 0 log: `- shaped: 9 features, MVP = F001–F004 (onboard F001, core action F003, visible result F003 + F004), category productivity-tool`.

## Pre-write validation checklist

Run every item against the text you are about to write; fix, do not write and hope. The orchestrator validates the file and gives you one retry.

1. Line 1 is `# Product: <name>`; line 2 is exactly `<!-- fullauto:product v1 -->`.
2. Exactly these eight `##` headings, in this order, spelled exactly: `Concept`, `Target users & core value`, `Category & benchmarks`, `Principles & constraints`, `Feature map`, `Decisions`, `Backlog`, `Round log`. No other `##` lines. Every section non-empty.
3. Feature map: header row exactly `| id | feature | status | round | note |`, then `|---|---|---|---|---|`, then rows with five cells; ids `F` + 3 digits, unique, ascending from F001; status in the enum; round integer or `-`; at least one row with round `1` and status `planned` (greenfield) or a `done` round-`0` row plus planned rows (brownfield).
4. Every backlog line matches `^- \[P[123]\] F\d{3} .+ — impact:[HML] effort:[SML] — .+$`; its id exists in the feature map with status `planned` or `deferred`; its feature text equals the map cell; P1 lines before P2 before P3; 1–25 lines; no duplicate ids.
5. Round-1 set is a complete loop: the Round 0 log names the onboard, core action, and visible result features, and persistence is inside the set.
6. Decisions: ≥ 7 bullets in the `- <decision> — <source>: <rationale>` shape covering name, stack, auth, persistence, hosting, locale, test runner; every `<source>` from the allowed list.
7. Principles contain the quality bar line, the scope rule, ≥ 2 non-goals.
8. Concept is verbatim from the invocation.
9. No question marks addressed to the user, no "TBD", no decorative emojis, no `|` inside table cells.
10. Round log has the `### Round 0 — <YYYY-MM-DD>` entry (today's date via `date +%F`).

## Output

The file is the deliverable. After writing, print a ≤ 10-line summary (name, category, peers, MVP features with the three legs, decision count, backlog count) and end with this line:

```
PRODUCT_SHAPE: path=<out> category=<id> features=<n> backlog=<n> mvp=<F001,F002,...>
```

No code fences around the file contents in your message, no questions, no "let me know if". If a `## Validation errors` block was in the prompt, list each error and the line you changed for it above the summary.

## Rules

- **Concept is sacred.** Copy it verbatim; interpret it in Target users, never by rewriting it.
- **Small, shippable increments.** The reader is a solo vibe-coder and an unattended planner; a feature that needs a week is two features.
- **Boring stack wins.** Match the project signal; on greenfield pick the mainstream option for the category (playbook "typical stacks") and record it as `default`.
- **Every backlog item has a reason** (`<why now>`): playbook table-stakes, a peer benchmark, a core-value dependency, or a quality-bar gap. No reason, no item.
- **≤ 25 backlog items, ≤ 12 file reads, ≤ 5 web queries.** Budgets are caps, not targets.
- **Brownfield respects what exists.** Never propose replacing a library or framework the repo already uses; record pre-existing features as `done` round `0`.
- **No decorative emojis; English body**, product copy in the product's decided locale.
