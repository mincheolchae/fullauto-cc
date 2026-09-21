# Category playbooks (shared reference — not a skill)

Cited by `/product-shape` (category + benchmarks + MVP shaping) and `/vibe-enhance` (convention axis); `/product-assess` scores against the anchors in its own table and reads the category only through the brief. Stack-agnostic on purpose: every item is a capability a user can observe, not a library. When a category says "search", the project decides whether that is SQL `LIKE`, a full-text index, or a hosted service — the playbook only says the user expects it.

How to use: pick the closest 1–2 categories (primary + optional secondary). Walk the primary's **Table-stakes** as a checklist; every missing item is a candidate. The **Universal baseline** applies to every category and is not repeated below.

## Index

| id | one-line definition | typical stacks |
|---|---|---|
| `saas-dashboard` | Logged-in web app where a team manages records and reads metrics | Next.js / Remix / SvelteKit / Rails / Django + Postgres |
| `marketplace` | Two-sided platform matching supply (sellers, hosts, providers) with demand | Next.js / Rails / Laravel + Postgres + Stripe Connect-style payouts |
| `social-community` | Users post, follow, react, and discuss; the feed is the product | Next.js / Phoenix / Django + Postgres + Redis |
| `content-cms-blog` | Publishing platform: authors write, readers read; SEO matters | Astro / Next.js / Hugo / Ghost / WordPress + Markdown or headless CMS |
| `e-commerce` | Catalog → cart → checkout → order for physical or digital goods | Next.js / Shopify Hydrogen / Medusa / Rails + Stripe |
| `productivity-tool` | Personal or small-team tool for capturing and organizing work (todo, notes, habits, calendar) | Next.js / Vite + React / SwiftUI / Flutter + SQLite / Postgres |
| `chat-messaging` | Real-time conversations between users, in channels or DMs | Next.js / Phoenix / Node + WebSocket or Convex / Supabase Realtime |
| `api-backend-service` | Headless service exposing an HTTP / gRPC / GraphQL API to other programs | Express / Fastify / Hono / FastAPI / Go net/http / Rails API / Spring |
| `cli-dev-tool` | Command-line tool or library for developers | Node + commander / Go + cobra / Rust + clap / Python + click |
| `mobile-app` | Native or cross-platform app installed from a store | SwiftUI / Kotlin Compose / React Native / Flutter / Expo |
| `data-pipeline` | Scheduled or streaming jobs that ingest, transform, and load data | Python + Airflow / dbt / Node workers / Go + queues / Spark |
| `ai-assistant-app` | LLM-backed product: chat, copilot, generation, or agent over the user's data | Next.js + AI SDK / FastAPI + provider SDK / RAG over Postgres-pgvector |
| `portfolio-landing` | Public marketing or personal site whose job is to convert or inform | Astro / Next.js / Hugo / plain HTML + Tailwind, static hosting |

## Universal baseline (applies to every category)

- README: what it is, run locally in ≤ 5 commands, env var table, one screenshot or demo command
- `.env.example` listing every env var the code reads (placeholders, no secrets)
- CI workflow that runs the project's gates (typecheck / test / lint) on push
- A deploy path that exists in the repo (Dockerfile, `vercel.json`, `fly.toml`, Procfile, or a documented static build) — not just "deploy somewhere"
- One error-reporting seam (`reportError(err, ctx)` or equivalent) called from every top-level handler / error boundary; logs to console until a monitoring SDK is wired
- Health / version endpoint or `--version` flag
- Every data view has loading, empty, and error states; every form has validation feedback next to the field
- Every core journey has at least one test through the real entry point (HTTP / CLI binary / browser)
- Keyboard-operable, labelled controls; visible focus; text contrast ≥ 4.5:1
- Responsive at 390×844 (phone) and 1280×800 (laptop); no horizontal scroll
- LICENSE file when the repo is public

## saas-dashboard

**Definition:** a logged-in web app where a team manages records (customers, projects, tickets, whatever the domain is) and reads metrics about them.
**Typical stacks:** Next.js / Remix / SvelteKit / Rails / Django; Postgres; session or OAuth auth.

**Table-stakes**
- Sign-up, sign-in, sign-out, password reset (or magic link), email verification
- Workspace / organization with member invites and at least owner vs member roles
- Primary record list: search, filter, sort, pagination (or infinite scroll), bulk select
- Record detail with edit, delete (confirm), and an activity / change history
- Dashboard home with 3–6 KPIs and a time-range selector
- Settings: profile, workspace name, members, notifications, API keys or integrations page (even if it lists one)
- In-app notifications or an activity feed; email for the 2–3 events that matter (invite, assignment, digest)
- Export the primary record list to CSV
- Onboarding checklist or empty-state wizard on first login
- Audit log for destructive and permission changes
- Billing page when the product is paid (plan, usage, invoices); otherwise a "Free during beta" placeholder
- Product analytics events for sign-up, activation (first record created), core action, churn signals

**UX must-haves**
- First login lands on a guided empty state that creates the first record in ≤ 3 clicks
- Optimistic updates or instant feedback (toast + row update) on every mutation
- Keyboard shortcut for the primary create action and a command palette or global search
- Sticky filters (URL-encoded) so a filtered view can be shared
- Tables collapse to cards on phones

**Trust / safety**
- Role checks server-side on every mutation, not only hidden buttons
- Rate-limited auth endpoints; session invalidation on password change
- Soft delete with undo window for the primary record
- Data export and account deletion paths exist (privacy request readiness)

**Success signal (< 5 min):** a new user signs up, creates a workspace, adds the first record, sees it in the list and on the dashboard, invites a teammate.

**Common mistakes**
- Dashboard built before the record CRUD it summarizes
- Filters that reset on navigation; no pagination until the table is slow
- Roles enforced in the UI only
- Empty states that say "No data" instead of offering the create action

## marketplace

**Definition:** a two-sided platform where supply (sellers, hosts, providers) lists offerings and demand (buyers) discovers, books or buys them; the platform mediates trust and money.
**Typical stacks:** Next.js / Rails / Laravel; Postgres; Stripe Connect-style split payments; object storage for images.

**Table-stakes**
- Two roles from one account (buyer by default, "become a seller" upgrade) with separate dashboards
- Listing create / edit with images, price, availability, and a draft → published state
- Search with category, price range, location or date filters; sorted results; map view when location matters
- Listing detail with gallery, price breakdown, seller profile, reviews, and one clear call to action
- Booking / order flow with confirmation page and email to both sides
- Messaging between buyer and seller scoped to a listing or order
- Reviews and ratings gated on a completed transaction
- Seller earnings view and payout status; buyer order history
- Favorites / wishlist
- Admin view: approve listings, resolve disputes, refund
- Cancellation and refund policy surfaced before payment

**UX must-haves**
- Seller can publish a first listing in ≤ 5 minutes with inline validation and image preview
- Buyer can go from search to confirmed order without creating an account until payment
- Availability and price shown on the result card, not only on the detail page
- Status timeline on every order (requested → confirmed → completed)

**Trust / safety**
- Payments through a provider that holds funds until fulfillment; never store card data
- Seller identity verification hook (even manual) before first payout
- Report listing / user; block user in messaging
- Escrow-style dispute state that freezes payout

**Success signal (< 5 min):** a seller publishes a listing with a photo; a buyer finds it via search, books it, and both see the order and can message each other.

**Common mistakes**
- Building the buyer side only; sellers get a form and nothing else
- Search without filters or with filters that do not reflect the listing schema
- Reviews open to anyone (fake reviews from day one)
- Payout logic invented in-house instead of the provider's split-payment primitive

## social-community

**Definition:** users create posts, follow each other, react and comment; the feed and the notification loop are the product.
**Typical stacks:** Next.js / Phoenix LiveView / Django; Postgres; Redis or a realtime service for fanout.

**Table-stakes**
- Public profile with avatar, bio, post list, follower and following counts
- Post composer with text, image upload, and a draft-safe submit (no double post)
- Home feed (following) and a discover / trending feed; pagination or infinite scroll
- Reactions (like at minimum) and threaded or flat comments
- Follow / unfollow with counts updating immediately
- Notifications: new follower, reply, mention; unread badge; mark all read
- Search for users and posts
- Report post / user; block and mute
- Edit and delete own posts; edited indicator
- Share link to a post that renders a preview (Open Graph meta) when logged out
- Settings: privacy (public / followers-only), notification preferences, account deletion

**UX must-haves**
- Composer reachable from every screen (floating action or header button)
- New-content indicator ("N new posts") instead of the feed jumping
- Optimistic like / follow with rollback on failure
- Empty feed shows suggested accounts to follow, not a blank page

**Trust / safety**
- Rate limits on posting, following and DMs; new-account throttles
- Moderation queue for reports with a hide / remove action
- Content-type and size validation on uploads; strip EXIF location data
- Privacy setting enforced in every query path, including search and OG previews

**Success signal (< 5 min):** sign up, follow two suggested accounts, post with an image, see it on the profile and feed, get a notification when someone reacts.

**Common mistakes**
- Feed before profiles and posting (nothing to feed)
- Notifications added last, so the retention loop never exists
- Block / report missing at launch
- Unbounded feed queries (no pagination, no index on `created_at`)

## content-cms-blog

**Definition:** a publishing platform where authors write and manage content and readers consume it; discoverability (SEO) and reading experience carry the product.
**Typical stacks:** Astro / Next.js / Hugo / Eleventy with Markdown or MDX; Ghost / WordPress / headless CMS (Sanity, Contentful, Payload).

**Table-stakes**
- Post model with title, slug, body (Markdown / rich text), excerpt, cover image, tags, publish date, draft / published / scheduled status
- Author pages and multi-author support
- Listing pages: home, per-tag, per-author, archive; pagination
- Full-text search across published posts
- RSS / Atom feed and sitemap.xml
- SEO meta: title, description, canonical, Open Graph and Twitter cards, JSON-LD Article
- Reading experience: table of contents for long posts, code highlighting, responsive images, estimated read time
- Related posts and previous / next navigation
- Newsletter signup or subscribe hook
- Comments (native or embedded) or an explicit "no comments" decision
- Editor with preview, autosave, and image upload
- 404 page with search and recent posts

**UX must-haves**
- Post page reaches Largest Contentful Paint quickly: static or cached render, images sized and lazy-loaded
- Dark mode following system preference
- Tag and author links on every post card
- Draft preview links for authors

**Trust / safety**
- Sanitize rendered HTML from any rich-text or Markdown source
- Scheduled publishing runs on the server, not on the author's browser
- Spam protection on comments and newsletter forms
- Backups or export of all posts to Markdown

**Success signal (< 5 min):** an author writes a post with an image and a tag, publishes it, and it appears on the home page, in the tag page, in the RSS feed, and with a correct social preview.

**Common mistakes**
- No slugs or slugs that change when the title is edited (broken links)
- SEO meta added to the home page only
- Search implemented by loading every post client-side
- Draft posts leaking through tag pages, feeds, or search

## e-commerce

**Definition:** a store: catalog → product detail → cart → checkout → order, for physical or digital goods.
**Typical stacks:** Next.js / Shopify Hydrogen / Medusa / Rails; Postgres; Stripe or a regional payment provider; object storage for product images.

**Table-stakes**
- Product catalog with categories, variants (size / color), stock levels, images, and price with currency
- Product listing with search, category filter, price sort, and pagination
- Product detail with gallery, variant picker that reflects stock, add to cart with quantity
- Persistent cart (guest and logged-in), quantity edit, remove, subtotal
- Checkout: address, shipping method, payment via the provider's hosted or embedded form, order summary
- Order confirmation page and email; order history in the account
- Discount codes; tax and shipping calculation (or a documented flat rule)
- Inventory decrement on order and restock on cancellation
- Admin: product CRUD, order list with status transitions, refund
- Returns / cancellation path and policy page
- Wishlist; recently viewed
- Analytics events: view product, add to cart, begin checkout, purchase

**UX must-haves**
- Cart drawer with instant feedback on add; cart count in the header
- Guest checkout by default; account creation offered after purchase
- Shipping cost visible before the payment step
- Out-of-stock variants disabled with a "notify me" hook

**Trust / safety**
- Never touch raw card data; verify payment webhooks by signature; idempotency keys on order creation
- Server-side price and stock validation at checkout (never trust the cart payload)
- Order status machine with allowed transitions only
- Privacy and terms pages linked from checkout

**Success signal (< 5 min):** a visitor searches, picks a variant, adds to cart, checks out as a guest with a test card, and receives an order number and email; the admin sees the order and stock decreased.

**Common mistakes**
- Cart stored only in memory (lost on refresh)
- Prices recomputed from the client payload
- Webhook handled without signature verification or without idempotency
- Catalog before checkout — a store you cannot buy from is a brochure

## productivity-tool

**Definition:** a personal or small-team tool for capturing and organizing work: tasks, notes, habits, bookmarks, time, calendar.
**Typical stacks:** Next.js / Vite + React / SvelteKit; SwiftUI / Flutter for native; SQLite (local-first) or Postgres; optional sync.

**Table-stakes**
- Capture in one action from anywhere in the app (quick-add box, global shortcut)
- Primary item with title, notes, status, due date or schedule, tags or project
- Views: today / upcoming / all; per-project or per-tag; completed archive
- Edit inline, reorder by drag or keyboard, complete with one action, undo
- Search across items
- Recurring items or streaks when the domain is time-based (habits, routines)
- Reminders / notifications (in-app, push or email) with a quiet-hours setting
- Sync across devices when there is an account; offline-tolerant writes when local-first
- Import from CSV or a competitor's export; export to CSV / JSON / Markdown
- Sharing or collaboration for team tools: shared project, assignment, comments
- Settings: theme, start of week, time zone, notification preferences
- Keyboard shortcuts with a discoverable cheat sheet

**UX must-haves**
- Empty state seeds a sample project or first item to complete
- Zero-latency interactions: optimistic writes, no spinner for local operations
- Progress feedback (streak, completed count, weekly summary) that makes returning rewarding
- Works one-handed on a phone: bottom-reachable primary action

**Trust / safety**
- Data export in an open format; account deletion wipes server data
- Conflict handling on sync (last-write-wins with visible "updated elsewhere", or merge)
- Reminders never fire for deleted items

**Success signal (< 5 min):** add three items, complete one, see it move to done and the streak / progress update, reopen the app on a phone-sized viewport and see the same state.

**Common mistakes**
- Building settings and themes before the capture → complete → progress loop works
- No undo on complete or delete
- Habit or task views that do not respect the user's time zone (streak breaks at UTC midnight)
- Sync added late as a separate system instead of designed into the data model

## chat-messaging

**Definition:** real-time conversations between users in channels, groups, or DMs.
**Typical stacks:** Next.js / Phoenix / Node + WebSocket; Convex, Supabase Realtime, Ably or Pusher; Postgres with per-conversation indexes.

**Table-stakes**
- Conversation list sorted by last activity with unread counts and last-message preview
- Message thread with pagination backwards (load older), grouped by day, sender and timestamp
- Send text with Enter, newline with Shift+Enter; edit and delete own messages
- Real-time delivery to other participants; optimistic send with pending / failed states and retry
- Typing indicator and online presence (or a deliberate "no presence" decision)
- Read receipts or at least "seen" for DMs
- Mentions with notification; reactions on messages
- File and image attachments with preview and size limits
- Search messages across conversations
- Create group / channel, invite and remove members, leave
- Push / desktop notifications with per-conversation mute
- Reconnect with backoff; messages sent while offline are queued and delivered in order

**UX must-haves**
- Scroll pinned to bottom on new messages only when the user is already at the bottom; "new messages" jump button otherwise
- Unread divider line on open
- Draft preserved per conversation
- Link previews and basic Markdown

**Trust / safety**
- Server-side membership check on every read and write to a conversation
- Rate limits on send and invite; message size caps
- Report message / user; block user (blocked users cannot DM)
- Attachment type validation and virus-scan hook

**Success signal (< 5 min):** two users in two browser sessions open a DM, exchange messages that appear without refresh, see typing and unread state, and one edits a message the other sees updated.

**Common mistakes**
- Polling every second instead of a realtime channel, or realtime without a fallback and reconnect
- Messages ordered by client clock (out of order after reconnect)
- Membership checked on the UI only; channel ids guessable and readable
- Attachments served from a public bucket without ownership checks

## api-backend-service

**Definition:** a headless service other programs call over HTTP, gRPC or GraphQL; developers are the users.
**Typical stacks:** Express / Fastify / Hono / NestJS; FastAPI / Django REST; Go net/http / chi; Rails API; Spring Boot; Postgres or a managed store.

**Table-stakes**
- Consistent error envelope (`{ error: { code, message, details? } }` or the framework's standard) with correct status codes (400 / 401 / 403 / 404 / 409 / 422 / 429 / 500)
- Request validation at the boundary with field-level error messages
- Authentication (API key or bearer token) and per-resource authorization
- Pagination on every list endpoint (cursor or page + limit with a max)
- Filtering and sorting on the primary list endpoint
- Rate limiting with `429` and `Retry-After`; idempotency keys on non-idempotent POSTs that create money or side effects
- OpenAPI / schema document generated from code and served at a known path
- Health (`/healthz`) and readiness endpoints; version in a header or endpoint
- Structured request logging with a request id echoed in responses
- CORS configured explicitly; security headers
- Database migrations tracked in the repo and run on deploy
- Integration tests through the HTTP layer for every endpoint (happy path + 2 error paths)
- Webhooks (when the service emits events) with signature, retry, and a documented payload
- Changelog or versioned routes when consumers exist

**UX must-haves (developer experience)**
- `curl` example per endpoint in the README or docs
- Error messages say what to fix, not just "invalid"
- Sensible defaults: list returns 20 items sorted newest first
- Quickstart: get a key, make one call, in ≤ 3 steps

**Trust / safety**
- Secrets from env only; never logged; key rotation path
- Parameterized queries; body size limits; timeouts on outbound calls
- Auth failures return the same shape for "not found" and "forbidden" when leaking existence matters

**Success signal (< 5 min):** a developer reads the README, obtains a key, creates a resource with curl, lists it with pagination, and gets a helpful 400 for a bad payload.

**Common mistakes**
- Errors as `200 { ok: false }` or as raw stack traces
- Lists without pagination until production falls over
- Validation in the handler only for the happy path; missing `404` on unknown ids
- Schema drift: OpenAPI written by hand and never updated

## cli-dev-tool

**Definition:** a command-line tool, or a library with a CLI entry, that developers run locally or in CI.
**Typical stacks:** Node + commander / yargs; Go + cobra; Rust + clap; Python + click / typer; distributed via npm / Homebrew / cargo / pip / GitHub releases.

**Table-stakes**
- `--help` on the root and every subcommand, with one example per command; `--version`
- Clear exit codes: 0 success, 1 failure, 2 usage error; errors to stderr, data to stdout
- `--json` (or `--format`) output for anything a script would consume; stable field names
- Non-interactive by default when stdin is not a TTY or `--yes` / `CI` is set; never hang on a prompt in CI
- Config discovery: flags > env vars > config file > defaults, documented in that order
- `--dry-run` for anything destructive; `--verbose` / `--quiet`
- Colored output that respects `NO_COLOR` and non-TTY
- Fast startup (no network on `--help`); offline-tolerant where possible
- Install path documented for each platform and a one-line upgrade command
- Shell completion for at least one shell, or a documented decision not to
- Useful error messages with a suggested fix ("run `tool init` first")
- Tests that spawn the real binary and assert on exit code + stdout for every documented command
- Changelog and semantic versioning; release automation

**UX must-haves (developer experience)**
- The README's first example works verbatim on a fresh machine
- Progress indication for anything over ~2 seconds; a summary line at the end
- Consistent verb-noun or noun-verb command shape across subcommands
- Diff-style or table output that aligns in a terminal

**Trust / safety**
- Never write outside the working directory or declared paths without a flag
- No telemetry without explicit opt-in; secrets never echoed in logs
- Confirm before destructive operations when interactive

**Success signal (< 5 min):** install, run `--help`, run the main command on a sample input, get readable output and a `--json` variant, and see a helpful error on bad input.

**Common mistakes**
- Prompts that block CI; interactive-only flows
- Mixing logs and data on stdout so piping breaks
- `--help` that lists flags but shows no example
- Global installs or writes to the home directory as a side effect

## mobile-app

**Definition:** a native or cross-platform app installed from an app store, used in short sessions with intermittent connectivity.
**Typical stacks:** SwiftUI / UIKit; Kotlin + Jetpack Compose; React Native + Expo; Flutter; backend via REST / GraphQL / Supabase / Firebase.

**Table-stakes**
- Onboarding of ≤ 3 screens with skip, then a functional home screen
- Sign in with the platform's native option (Apple / Google) plus email; account deletion in-app (store requirement)
- Core data list and detail with pull-to-refresh, empty and error states, and cached last-known data offline
- Create / edit flows that survive backgrounding (draft persisted)
- Push notifications with an in-app toggle and a deep link into the relevant screen
- Settings: account, notifications, appearance, about (version, licenses), privacy policy and terms links
- Dark mode and Dynamic Type / font scaling support
- Accessibility labels on every tappable element; VoiceOver / TalkBack navigable
- Handles no-network gracefully (banner, queued writes) and slow network (skeletons, timeouts)
- Crash reporting and analytics seam
- App icon, splash screen, store screenshots, and a privacy manifest / data-safety declaration
- Version check or forced-update hook
- Release pipeline to TestFlight / internal testing track

**UX must-haves**
- Primary action reachable by thumb (bottom bar or floating button)
- Native navigation patterns (back gesture, tab bar) rather than web-style
- Instant local feedback: optimistic updates, haptics on success where the platform expects it
- Keyboard avoidance on every form; correct keyboard types (email, number)

**Trust / safety**
- Tokens in the platform keychain / keystore, not in plain storage
- Certificate pinning or at least TLS-only; no secrets in the bundle
- Permission prompts explained in context before the system dialog

**Success signal (< 5 min):** install a debug build, sign in, create the first item, kill the app, reopen and see it persisted, toggle airplane mode and still see the list.

**Common mistakes**
- Web layout habits: tiny tap targets, hover-only affordances
- Network calls with no timeout and no offline state
- Sign in with email only (store review rejection when third-party login exists)
- No account deletion path

## data-pipeline

**Definition:** scheduled or streaming jobs that ingest data from sources, transform it, and load it somewhere consumers read from; correctness and observability are the product.
**Typical stacks:** Python + Airflow / Dagster / Prefect; dbt + warehouse; Node or Go workers on a queue; Spark / Flink for scale.

**Table-stakes**
- Each job is idempotent: re-running for the same window produces the same result (upsert by natural key, partition overwrite)
- Incremental loads with a watermark / checkpoint; backfill command for a date range
- Schema contracts for inputs and outputs (typed models, validated on read); schema-change detection
- Retries with exponential backoff; dead-letter or quarantine for poison records with a reason
- Run metadata: started / finished, rows in / out / rejected, duration, per-run id; queryable history
- Alerts on failure and on "no data arrived" (freshness SLA), not only on exceptions
- Data-quality checks (row count bounds, null rate, uniqueness on keys) that fail the run or flag it
- Dry-run / sample mode that processes N rows and prints them
- Configuration by environment (dev / staging / prod targets) without code changes
- Secrets from a manager or env; no credentials in DAG code
- Local run in one command with a fixture dataset; unit tests for transforms; an end-to-end test on the fixture
- Lineage or at least a documented source → target map per job
- Cost / volume guardrails (max rows, max runtime) with a clear failure

**UX must-haves (operator experience)**
- One status page or command showing the last run of every job, with a link to logs
- Logs that state the window processed and the counts, in one line per stage
- Backfill and rerun are explicit commands with a confirmation of the range
- Failures name the record or partition that broke, not just the exception

**Trust / safety**
- PII columns identified and masked or hashed downstream
- Least-privilege credentials per source and target
- Deletes never cascade from a partial source read (guard against empty-source wipes)

**Success signal (< 5 min):** run the pipeline locally on the fixture, see counts and a success line, re-run and see no duplicates, break one record and see it land in quarantine with a reason.

**Common mistakes**
- Non-idempotent loads (duplicates on retry)
- Failures only visible in the scheduler UI; no freshness alert when the source silently stops
- Transforms tested only against production data
- A single giant job instead of stages with checkpoints

## ai-assistant-app

**Definition:** an LLM-backed product where the user chats, generates, or delegates over their own data; latency, grounding, and trust boundaries define the experience.
**Typical stacks:** Next.js + AI SDK / FastAPI + provider SDK; RAG over Postgres-pgvector or a vector store; streaming over SSE / WebSocket.

**Table-stakes**
- Streaming responses with a stop button; visible "thinking" / tool-running state
- Conversation history: list, rename, delete, search; new conversation always one click away
- Grounding: answers cite the source (document, URL, record) when retrieved context is used
- Tool / action calls shown as steps with inputs and results, and a confirmation for side-effecting actions
- Regenerate, edit-and-resend, copy, and feedback (thumbs up / down with an optional reason) on every response
- Attach files or connect a data source; show what the assistant can see
- Model / provider abstraction with configurable model, temperature and max tokens on the server
- Rate limiting and per-user usage quotas; cost per conversation logged
- Prompt versioning and an eval set (≥ 20 cases) that runs in CI or on demand
- Error states: provider outage, context too long, refusal — each with a recovery action
- Graceful degradation when a tool or retrieval fails (answer without it and say so)
- Export conversation (Markdown / JSON); delete all data
- Latency budget: first token < 2 s on a warm path, and a skeleton before that

**UX must-haves**
- Empty state with 3–5 concrete example prompts that work on the user's data
- Markdown rendering with code blocks and copy; tables render as tables
- Composer supports multi-line, paste of long text, and Enter-to-send with Shift+Enter newline
- Sources and steps collapsible, not inline noise

**Trust / safety**
- Prompt-injection defenses: retrieved content and tool output are data, never instructions; allow-list of tools per user role
- Per-user data isolation in retrieval (tenant filter in every query); no cross-user cache hits
- PII and secret redaction before logging prompts; retention policy on transcripts
- Human confirmation for irreversible actions (send, pay, delete); provider content-safety hooks

**Success signal (< 5 min):** upload or connect a small dataset, ask a question, watch a streamed answer with a citation, click the citation, give feedback, find the conversation again by name.

**Common mistakes**
- No streaming (10-second blank wait), no stop button
- Retrieval without tenant filtering; injected instructions in documents obeyed
- No eval set, so prompt edits silently regress
- Chat UI with no history or no way to attach the user's data

## portfolio-landing

**Definition:** a public marketing or personal site whose job is to inform and convert (sign up, contact, hire, download).
**Typical stacks:** Astro / Next.js / Hugo / Eleventy / plain HTML + Tailwind; static hosting with a form backend.

**Table-stakes**
- Hero with a one-sentence value proposition, one primary call to action, and one secondary
- Sections that answer: what is it, who is it for, how it works (3 steps), proof (logos, testimonials, numbers, screenshots), pricing or "how to get it", FAQ, final CTA
- Contact or signup form that works (spam-protected, success and error states, email or webhook delivery)
- Navigation with anchor links, sticky header, and a footer with legal, social, and contact links
- SEO: unique title and description per page, Open Graph and Twitter cards, canonical URL, sitemap.xml, robots.txt, structured data for the organization or person
- Performance: static output, optimized images (modern formats, explicit sizes), fonts subset and preloaded, Lighthouse performance ≥ 90 on mobile
- Analytics with a privacy-respecting default; conversion events on the CTA and form submit
- Custom 404 page; favicon set and web manifest
- Blog or changelog hook when the product will publish updates
- For portfolios: project cards with problem / role / outcome, a resume or CV download, and a clear "available for" line
- Dark mode following system preference
- Legal: privacy policy and terms when a form collects data

**UX must-haves**
- Above-the-fold answers "what and for whom" in under 5 seconds without scrolling
- One CTA style used consistently; buttons look like buttons
- Every image has alt text; contrast passes; headings in order
- Phone layout designed first: no tiny text, tappable links, no layout shift

**Trust / safety**
- Form backend validates and rate-limits; no secrets in client code
- Testimonials and numbers real or clearly labelled as examples
- No third-party scripts before consent where consent laws apply

**Success signal (< 5 min):** a visitor on a phone understands the offer, scrolls proof, submits the form, sees a success message, and the owner receives it; the page shares with a correct preview card.

**Common mistakes**
- Hero that describes features instead of the outcome
- Form that posts nowhere or fails silently
- One giant image blocking first paint
- Missing OG meta, so every share is a blank card
