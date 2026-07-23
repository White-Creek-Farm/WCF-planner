# WCF Planner

Farm-management web app for White Creek Farm. React/Vite single-page app,
Supabase backend, Netlify production deploy from GitHub `main`.

This file is the durable project map: current state, architecture, roadmap, and
load-bearing contracts. Workflow, roles, gates, and relay format live in
[HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-07-23.
Runtime/source changes covered by this map include DR groundwork commit
`b2c3826` and Broiler median hotfix `2cf332e`; this docs wrap accompanies their
approved fast-forward push to `origin/main`. Migration `190` is PROD-applied and
the resulting `wcf_backup` role is activated and verified read-only. Migrations
through `190` are represented in source.
Shipped history lives in `git log` and `archive/SESSION_LOG.md`; durable behavior
lives in the Load-Bearing Contracts below; migration/live state lives in Current
State and Backend And Data State. Do not re-enumerate the changelog in this header.
Production URL: https://wcfplanner.com.
Netlify auto-deploys from GitHub `main`.

---

## Start Here

1. Read [HO.md](HO.md) for workflow, roles, gates, relay format, and
   parallel-worktree rules.
2. Read this file's Current State, Build Queue, and the relevant contracts.
3. Run `git status --short`, `git worktree list`, and inspect recent `git log`
   before planning or editing.
4. Inspect the source/test/migration files in scope before changing anything.

Default session model: Codex plans/reviews, CC builds/validates, Ronnie approves
commit/push/PROD gates. Ronnie may explicitly assign Codex build work; otherwise
CC is the primary builder.

---

## Project Map Governance

This file is a docs-as-code project map, not a session log, scratchpad, or
append-only changelog.

Rules for editing this file:

- Build Queue is the only home for outstanding build/design work. Do not hide
  "future", "needs", "still needs", "TODO", or "TBD" work in later sections.
- Contract sections describe current architecture, standards, and guard rails.
  If a contract is aspirational rather than true, move the work to Build Queue
  and state the current guard/inventory honestly.
- Current State summarizes what is true now, including active local worktree risk
  when it matters. Recent Shipped Checkpoints summarize work merged to
  `origin/main`.
- Inventory counts, migration state, test names, and owner lists must match the
  source/static guards at the time of edit. Prefer pointing to the guard as the
  source of truth instead of duplicating fragile counts.
- Every Build Queue item should state class (`DEFECT`, `DECISION`, `ENH`),
  scope, success criteria, validation/guard target, and any migration/PROD gate
  once it is promoted into an active lane.
- Remove or reconcile stale text instead of appending corrections nearby.
- Normal build/hotfix lanes must not edit this file unless Ronnie explicitly
  requests docs, wrap, or a named `PROJECT.md` change.

Design/function invariants that govern cross-surface behavior live in
`## Global Decisions (Constitution)` and `## Design System`.

---

## Current State

- Active main state: the approved fast-forward push publishes DR groundwork
  `b2c3826`, Broiler median hotfix `2cf332e`, and this docs-only wrap as three
  separate commits. The Playwright reliability work remains isolated on
  `feature/test-playwright-reliability` in CC#2's separate worktree.
- Broiler weigh-ins: 4- and 6-week records now use one shared calculation
  contract for average and median. The main weigh-in table places `Median
  weight` immediately after `Avg weight`, the record header places median after
  average, and Broiler CSV exports include the median column. Focused proof is
  8/8; the complete DB-free suite passed 7,828 tests across 328 files, with
  format, lint, build, and whitespace checks green.
- Disaster recovery: the private Backblaze B2 primary bucket
  `wcf-planner-dr-primary-2026` and Cloudflare R2 secondary bucket
  `wcf-planner-dr-secondary-2026` exist. B2 uses SSE-B2, Object Lock, a two-day
  governance default, and a bucket-scoped writer with only `listBuckets`,
  `writeFiles`, and `writeFileRetentions`. R2 is private in Western North
  America with 2-day global, 35-day `db/daily/`, 365-day `db/monthly/`, and
  35-day `storage/` lock rules. Provider credentials, the Supabase Storage S3
  source credential, the PROD database backup-reader DSN, and the age private
  identity are stored as separate WCF Planner items in 1Password; the age
  private identity also has an offline emergency copy. Temporary credentials
  and local plaintext credential/dump artifacts were removed.
- DR database identity: migration `190` is PROD-applied. `wcf_backup` can log in,
  has `BYPASSRLS` plus only `pg_read_all_data`, and has no superuser, database
  creation, role creation, replication, or application-write authority. A real
  login dump completed with 133/133 `public`/`auth`/`storage` table-data entries;
  a populated RLS read matched postgres at 826/826 rows, and a write probe failed
  closed. Its DSN exists only in 1Password under `WCF Planner — PROD database
  backup reader`; it has not been added to GitHub.
- DR automation: commit `b2c3826` contains a streaming `pg_dump -> age`
  runner, incremental Storage inventory/body transfer to both providers,
  manifests/checksums, B2 per-object minimum immutability, R2 timestamped keys,
  read-only provider preflight, fail-closed orchestration, behavioral/static
  guards, migration `190`, and a `workflow_dispatch`-only workflow whose schedule
  remains commented. No provider preflight, backup upload, immutable generation,
  or isolated restore has run. The B2/R2 upload compatibility and B2's two-step
  Storage-object retention call therefore remain unproven runtime facts.
- GitHub DR containment: Environment `dr-backup` exists, is restricted to
  `main`, and requires Ronnie's approval with self-review permitted. Environment
  variables are complete (7/7); Environment secrets are still 0/7 and are the
  explicit first action next session. Repository ruleset
  `protect-main-destructive` blocks deletion and non-fast-forward updates to
  `main` for everyone while preserving ordinary fast-forward pushes, existing
  CI, and Netlify deployment behavior. The source is safe to publish because the
  manual-only job cannot receive missing secrets; do not run its workflow until
  all seven Environment secrets are present and verified by name.
- Shared TEST/Playwright reliability: branch
  `feature/test-playwright-reliability` contains boot-readiness commits
  `61e9bed`/`6cbdd9c` and fixture-budget Package A commit `e5b9ab3`; none is
  merged to `main`. Centralized application-navigation readiness eliminated the
  observed cold-boot failures, and Package A reduced hot fixture setup stages
  about 45%; the original `animalTransferScenario` and
  `cattleForecastScenario` setup timeouts did not recur in run `29936691088`.
  CI is still not repeatably green: that run passed shard 1 at 284/284 but shard
  2 had four rotating failures (one TEST TRUNCATE lock timeout, one IndexedDB
  hang, and two post-ready Task Center render races). Cross-run analysis refuted
  late-file accumulation and instead found cold-start and 11–16.5-minute failure
  bands, including three unrelated failures within one minute in run 29936691088.
  Instrumented run `29954947453` confirmed 4 vCPU/~16 GB, at least ~12.8 GB
  memory available, and ample disk; memory and disk pressure are ruled out.
  Failures correlated with cold-start work or 1-minute CPU load spikes around
  3.6–3.7 on four cores. The TEST TRUNCATE timeout did not recur, so its blocker
  remained unobserved; the sanitized diagnostic is now pushed at `8a8bff7` and
  remains armed for a future occurrence. Keep two shards. The next fix is one
  automatic worker-scoped Vite/browser warm-up with its own fixture timeout,
  followed by measurement; do not add shards or restart processes because both
  would multiply the proven cold-start regime. A billed 8-vCPU runner is the
  fallback only if steady-state CPU-spike failures remain after warm-up. No
  merge, Package B isolation change, timeout inflation, or Pasture work is
  approved. Worker warm-up commit `722ba1f` is pushed on the feature branch: one
  logged-out `/` navigation primes the app's fully static import graph, and a
  disposable IndexedDB open/close primes the browser path without touching the
  real offline queue. Focused coverage is 44/44. Measured dispatch `30002663288`
  is queued behind nightly run `29999814082`; its result is still pending.

- Production deploy: Netlify auto-deploys from the GitHub organization repo
  `White-Creek-Farm/WCF-planner`, branch `main` (`npm run build`, publish `dist`,
  Functions `netlify/functions`). Runtime code is merged through `2cf332e`;
  Netlify reported the wrap commit `9860a08` published and `ready` at
  2026-07-20 21:43 UTC, directly confirming the organization-repo linkage and
  current build settings. Later docs-only commits may advance the displayed
  deploy ref without changing runtime behavior.
- Supabase live high-water: all repository migrations through `166`, `170`-`183`,
  `185`-`190` are reported PROD-applied; numbers `167`-`169` are intentionally
  unused and `184` is reserved/not present. Migration `189`'s PROD apply was
  reported and behaviorally verified in the newsletter lane, but this wrap did
  not independently query the PROD database because no PROD DB URL is exposed
  in the current shell.
  `rapid-processor` is currently deployed to PROD v32. The normal
  `processing-asana-sync` build is restored and deployed to PROD v16 after the
  temporary audit-only v15. A direct 2026-07-20 Supabase CLI check found current
  PROD versions `tasks-cron` v7, `tasks-summary` v9, and `newsletter-harvest`
  v7. The repository's default Supabase link is TEST, not PROD; its directly
  observed versions were `rapid-processor` v7, `processing-asana-sync` v3,
  `tasks-cron` v6, `tasks-summary` v3, and `newsletter-harvest` v2.
- Newsletter live state: Autopilot + direction-first redesign + fact fixes +
  archive-link gating + the UX polish and editorial-steering passes are merged.
  Migration `189` adds the saved writing/voice example used by AI drafts. The
  steering pass adds the writing-example editor, honest AI/template/unknown
  helper states, required-style-save blocking before Write/Revise, and a
  non-destructive revision path. The earlier polish pass adds
  debounced/autosaved admin direction, prevents local direction clobbering during
  refreshes, clarifies AI-vs-template/gather/fact workflow states, relabels
  newsletter runs, and brings the public reader into the WCF branded email
  family. Migrations `146`/`151`/`153`/`189` are reported PROD-applied;
  `newsletter-harvest` is deployed (PROD v7 / TEST v2, directly checked on
  2026-07-20); `NEWSLETTER_AI_API_KEY` is a PROD-only Edge
  Function secret (TEST intentionally unset); the monthly cron is off. The
  public archive is link-gated by a rotating `?key=`. See the Monthly Newsletter
  contract for behavior and the newsletter Build Queue item for the open first-issue /
  writing-example/PROD-AI-smoke work. (Deploy version, secret presence, PROD migration apply,
  and published-issue/token counts are live state — see the live-verification
  note in the Supabase Migrations section.)
- Pasture Map live state: the pasture migrations `116`, `127`-`132`, `135`-`137`,
  `139`-`141`, `143`, `147`-`150`, `152`, `155`, `158`, `180`, and `181` are
  PROD-applied.
  Migration `158` fixes boundary-touch false resting/occupied states by requiring
  positive-area overlap for overlap impacts and read derivation; FP4C1/FP4E2
  re-read baseline while FP4D1 rests and FP4E1 is occupied. Migration `180`
  makes direct move destinations/departures authoritative for occupancy, rest
  start, and last grazed while keeping geometric overlap advisory; PROD
  verification showed FP4D2 resting from Jul 3, FP4D3 resting from Jun 30, and
  FP4E3 occupied. Migration `181` adds owner/management rename and color editing
  for saved measurements. Tracks/Lines and saved measurements now have wide
  transparent click targets; saved measurements open a management modal for
  rename, color, and delete. The readiness threshold remains 60 rest days.
  Migration `150`'s
  `NOTIFY pgrst` line is text-only for future/fresh-env applies and was NOT
  re-applied to PROD (the function body was already live/verified). `/pasture-map`
  is an installable PWA hub; the service-worker cache version is
  `2026-06-30-pasture-pwa-v1`. Light has pasture farm-team-level Map/Field access
  (migration `139`). On mobile Field, the three-action toolbar labels are now
  `Walk paddock`, `Draw temp paddock`, and `Measure`; `77c3c57` prevents the
  generic 900px mobile layout from positioning that toolbar below the phone
  viewport. See the Pasture Map contract for UI/behavior rules.
- Migration `143` remains deployed as a benign unused helper; no UI calls it.
- Production legacy import: `Processing Events - ALL.xlsx` upserted 69 rows into
  `production_legacy_events` on PROD by stable `source_key` (frozen historical
  count).
- Processing Calendar schema is PROD-applied through `188`. `ASANA_ACCESS_TOKEN`
  remains set on PROD, and `asana_sync_enabled` remains true pending Build Queue
  item 4's explicit final-cutover decision. Operational users can upload one or
  many attachments by picker or drag/drop; physical/tombstone deletion is
  admin-only and fail-safe. The comments-only `processing-asana-comments-hourly`
  schedule runs at minute 7 through Vault/pg_net, is pinned to `sync_comments`,
  and has repeatedly returned HTTP 200 with zero duplicate inserts.
- Processing planner integration is shipped end-to-end. Migrations `175`-`177`
  rekeyed planner rows to immutable batch/trip identity, made planned Pig trips
  first-class Processing records, backfilled phase/ordinal/status/template step
  identity, normalized option lists, removed Processing subtask dates, widened
  notification checks, and added completion/workflow integration. PROD
  post-apply verification found 27/27 Broiler planner rows rekeyed, all 8 Pig
  rows source-phased, every active template step carrying a stable id, and the
  first reconcile under the new engine restamped 27 Broiler / 16 Cattle / 1 Sheep
  / 8 Pig rows with 0 removed and 0 retired. Brett Post name-only Processing
  assignments were silently corrected to Accounting and Isabel Hermann
  assignments to Isabel; post-check found 0 name-only remnants and 0
  notifications emitted.
- Processing artifacts already imported: 1,104 recursive Asana subtasks
  (798 complete / 306 open; 557 assigned; 537 with due dates; 380 with start
  dates), preserving imported completion state and local ownership rules.
  Processing has 130 imported Asana conversation items. Ronnie's Jul 15 C-26-04
  main-card comment was imported with its original author/timestamp; the first
  comments-only run inserted it and the immediate and hourly repeats inserted
  zero. Imported `@mention` text may remain plain text and does not require
  retroactive profile mapping, highlighting, or notification; newly written
  Planner comments retain native working mentions. Conversation
  fidelity imported 8 comment-media files (about 20.4 MB). The ordinary
  attachment backfill indexed all 68 enumerable Asana GIDs. A guarded PROD
  cleanup later tombstoned all 55 copies of the stray Broiler workbook and
  removed the 54 remaining Storage objects (C-26-04 was already tombstoned),
  leaving 13 live ordinary Asana attachments plus one native upload untouched.
  The post-cleanup v16 dry run remains idempotent at 68 already-known GIDs / 0
  new. B-26-04 is the representative conversation proof:
  9 subtasks (8 complete / 1 open) and Brian Naide's two JPG posts are present.
  Three deleted Asana cards linked to dismissed placeholders consistently 404
  and remain explicit source skips. Ronnie decided on 2026-07-17 that the
  roughly 16,855 historical Asana system-story rows will not be imported. They
  are intentionally out of scope and must not be backfilled without a new
  explicit decision.
- The stray workbook root cause is closed. Ronnie removed
  `Broiler Inventory Batch #GOF-B-23-05.xlsx` from the sole Asana task template,
  `WCF Add New Batch` (`1205492705980299`). A complete read-only post-edit audit
  found `mentions_workbook: false`, zero candidates, and 1/1 templates examined.
  `processing-asana-sync` was then restored from clean main as PROD v16; its
  attachment dry run and the next hourly comments cron were healthy. Historical
  task copies may remain in Asana, but their preserved tombstone GIDs prevent
  reimport into Planner.
- Processing UI is simplified and live. The former Admin/maintenance,
  reconciliation, historical-import controls, status/processor filters, Show
  archived checkbox, stale sort label, and per-section Add milestone rows are
  removed. Admins get a direct **Templates** button; the global **+ Add
  milestone** button remains at the top. Templates are local-only and contain
  inline Tasks/Fields editing plus Customer/Processor choice management. Customer
  and Processor are settings-backed single selects. Parent-record Assignee and
  the six retired fields (Farm, Planned Processing Date, Actual/Planned Time on
  Farm, Product Pickup Date, and Time Remaining) are absent from defaults and
  drawer. Checklist-step assignees remain supported. The four active template v2
  rows have 11/10/10/10 fields and preserve their 8/16/11/16-item checklists; v1
  rows remain inactive for history.
- Processing checklist completion is an optimistic in-place mutation: checking
  or unchecking a step never reloads the drawer or schedule. The drawer silently
  reconciles server-owned completion blockers, and the schedule row receives
  confirmed subtask counts only, including when different toggles overlap and
  one fails. Broiler Source details no longer repeat the editable Processor or
  Customer fields. Processor/Customer option-list add, rename, deactivate,
  reactivate, and undo actions autosave after a 500 ms debounce; every modal or
  surface exit flushes pending edits, and a failed flush keeps the editor open.
- Processing migration `178` and its client lane repaired legacy Pig
  `liveWeights` reads, synchronize Processing titles when source batch names
  change across programs, and make Processor, Customer, and checklist-assignee
  selections quiet in-place saves. The schedule renders Sheep before Pig, and
  Pig renders Batch before Trip. Migration `179` hardens the remaining
  unschedule/delete lifecycle functions with batch-first locking, deterministic
  animal locks, and status revalidation under the lock.
- Processing now shows four independent selected-year completed-animal totals
  (Broilers, Cattle, Lambs, Pigs) instead of a meaningless cross-species head
  count. Program chips and section batch labels exclude milestones. Cattle
  planned batches are consolidated into one planned section and expose their
  projected tag/weight rosters; the batch page and Processing drawer show the
  same per-animal age at the exact planned processing date.
- Migration `188` and its client lane add guarded cattle/sheep live and hanging
  totals plus actual-Pig hanging weight to Processing source projection. The
  drawer shows Total live weight, Hanging weight, and Carcass yield for cattle,
  sheep, and Pig when valid source data exists; malformed/non-positive values
  fail closed to `Not recorded`. Pig roster rows retain canonical Boar/Gilt sex,
  while the redundant standalone Sex and Trip source rows are absent. Pig drawer
  titles use `<batch> · <trip>` without a `Pig Trip` prefix.
- Cattle forecast batch sequencing skips zero-cow months. Migration `182` is
  PROD-applied and the live schedule was reconciled: empty August no longer
  consumes a label, September is `C-26-05`, and later populated months continue
  sequentially.
- Processing status labels are normalized to `Planned` / `In Process` / `Complete`
  via `src/lib/processingStatusDisplay.js` (display-only; stored values are
  unchanged). See the Processing Calendar contract for the mapping and the
  pig-specific zero-head exception.
- Animals on Farm is live without a misleading combined Total. Canonical Layer
  housing matching removes the sibling double count: current PROD evidence is
  631 hens (156 Eggmobile 2 / 293 Layer Schooner / 115 Eggmobile 3 / 67
  Retirement Home), with the oldest contributing evidence dated 2026-04-10.
  The Home tile intentionally shows only the five program totals; its explanatory
  freshness/help sentence was removed. The dedicated Animal History page retains
  the full latest-recorded-not-verified explanation, oldest contributing date,
  and any undated-contributor warning.
  Each species uses its own readable small-multiple scale. PR #87's exact lane
  browser spec passed in CI and Netlify bundle markers were confirmed live.
  Migration `187` supplies the three approved evidence-backed historical Layer
  retirement dates: Eggmobile #2 - 2023 and Layer Schooner - 2023 retired
  2026-01-28; Retirement Home - 2023 retired 2024-06-27.
- CP5 public webform island styling (`ceb7dcf`) is shipped in the static HTML
  shells (`index.html`, `dailys.html`, `equipment.html`, `pasture-map.html`).
  It updates the public `#webform-container` fallback/island form tokens and
  radii. The public `/dailys` and `/equipment` hubs now use a simplified header:
  no wheat icon or helper copy, a larger `WCF Planner` title, and that title
  links back to the main planner page.
- Cattle Herds and nutrition current state: `/cattle/herds` defaults to grouped,
  collapsible herd tiles when no filters/search/non-default sort are active. Any
  active filter/search/non-default sort switches to one flat matched-results
  table. The `Sold` herd filter is sold-only and flat (no Processed/Deceased/Sold
  section headers). `Last Activity` sort/column uses the cattle animal Activity
  stream and shows date/time; the record-page Herd dropdown routes through the
  audited transfer RPC. The cattle nutrition dashboard now calculates `DM lb/day`
  from true dry matter (as-fed pounds less feed-line moisture); CP and NFC are
  computed from the nutrition snapshot percentages against that dry matter. The
  obsolete standalone cattle nutrition audit HTML is intentionally removed from
  the repository; application code and tests are the maintained source of truth.
- Home materials-needed hotfix: clearing one material in an equipment service
  interval preserves service-interval grouping/order, so later interval materials
  no longer jump to the bottom and look deleted.
- Mutation audit current state: PR1 (`0b424cb`) routes the sheep record-page
  Flock dropdown through `transfer_sheep_animal`; PR2A (`efe9483`) adds
  best-effort Activity emits across live cattle, pig, weigh-in/webform,
  equipment, and processing-attach surfaces; PR2B (`d169757`) adds the remaining
  summary emits and the dedicated `equipment.fuel_bill` Activity entity via
  migration `154`. Migration `170` now routes cattle/sheep detach workflows
  through audited atomic RPCs and safely admits program-authorized `farm_team`;
  migration `171` routes UsersModal profile mutations through admin-only audited
  RPCs and gives `rapid-processor` v29 the guarded Auth hard-delete handler.
  Accounts retained by farm-record foreign keys still cannot be hard-deleted and
  must be deactivated. The shipped UsersModal mutation lock serializes row and
  global mutations and prevents backdrop/X close-and-reopen bypass while a
  request is active. Real TEST Edge proof covered unauthenticated 401,
  non-admin 403, retained-FK 409, successful delete, idempotent retry, crash
  reconciliation, terminal audit rows, and cleanup; the focused browser proof
  passed 4/4. Migration `183` and `rapid-processor` PROD v31 now add audited
  profile creation, reset-request and truthful reset-delivery terminal events,
  one-terminal-per-request enforcement, a service-role-only HMAC throttle, and
  a fail-closed report-email role gate. The PROD smoke created one linked
  `profile.reset_requested` -> `profile.reset_send_succeeded` pair, delivered
  one real reset email to the owner's inbox, and left the account usable. The
  public flow remains enumeration-safe and stores no raw email/IP in the
  throttle table. The user-management lane is shipped; no gate remains.
  Historical Asana system-story Activity will not be backfilled, per Ronnie's
  2026-07-17 decision.
- Home Weather now renders one stable collapsed button on first paint instead of
  appearing after the dashboard. Loading, ready, and unavailable states reuse
  that node; loading clicks are inert, retry/refresh are single-flight, the
  initial request remains cacheable, and a failed refresh retains the last valid
  forecast. Focused browser proof passed 5/5.
- `tasks-cron` Edge Function is active in PROD: recurring + system-task generation
  with batch/group entity labels, plus To Do approval/originator notifications.
- Broiler derived-data drift lane is closed and verified in PROD.
- Dependency hardening is complete: Vite/Vitest/plugin-react majors upgraded,
  SheetJS pinned to the patched 0.20.3 tarball, Node pinned to 22 for Netlify, and
  `npm audit` is 0 on the hardened lockfile.
- Client Errors checkpoint: the existing admin-only, fail-closed Client Errors
  panel is relocated from the header hamburger to the Admin tab row. The
  standalone `/admin/client-errors` route remains as a backward-compatible deep
  link and does not duplicate the global Header. Focused static proof passed
  27/27 and the leased browser proof passed 4/4 during this wrap. The future
  final order is `Deleted` -> `Site & Recovery` -> `Client Errors`.
- Disaster recovery and shared-TEST reliability are active lanes; their
  exact current facts and next gates are stated at the top of Current State and
  in Build Queue items 1 and 2. Do not rely on older session reports for bucket,
  key, migration, workflow, or CI status. All service login identifiers use
  `ronnie@whitecreek.farm`; credentials live in the shared 1Password Business
  vault `WCF Planner`. The Anthropic API remains a documented personal-account
  dependency to transfer later.
- CI policy remains fail closed. PR #89 classifies changes into DB-free,
  focused, or full browser coverage; high-risk, unknown, nightly, and manual
  runs select full coverage. Direct main pushes retain normal risk
  classification. The current reliability branch evidence is not merge-ready;
  see Build Queue item 2 rather than treating rotating timeouts as ignorable.
- Git/workstation handoff: the approved main push contains three separate
  commits: DR groundwork `b2c3826`, Broiler median hotfix `2cf332e`, and this
  docs wrap. CC#2's active reliability worktree is on
  `feature/test-playwright-reliability` at pushed warm-up commit `722ba1f`;
  measured run `30002663288` is pending. Preserve
  the intentional `archive/ui-cleanup-wip-2026-06-17` tag because it is the only
  unique snapshot of that abandoned WIP.

### Recent Shipped Checkpoints

Per-PR shipped history is not maintained here. For what shipped and when, read
`git log` (every checkpoint hash resolves there) and `archive/SESSION_LOG.md`.
Durable behavior lives in the Load-Bearing Contracts below; current migration and
live state lives in Current State and Backend And Data State.

Most recent shipped checkpoints after PR #89 are `7a0f013` (early Equipment
service), `7134798` (cattle planned-batch consolidation), `c062513` (Processing
program totals), `df588fd` (Pig trip sex), `23647d2` (numeric service-interval
order), `74b04d1` (fueling logo home link), `f6e1948` (Home help-copy removal),
`ce41c39` (projected cattle ages), `15903bb` (carcass yield + PROD migration
`188`), `d1e0e33` (concise Pig drawer identity), `07027c0` (Pig drawer lifecycle
proof), `06f04f6` (newsletter editorial steering + migration `189` source),
`f61fb64` (mobile temp-paddock label), `77c3c57` (mobile Field toolbar kept
inside the viewport), `68872cb` (Client Errors moved to Admin), and `2cf332e`
(Broiler median in list, record header, and export). The cattle schedule remains
reconciled with September `C-26-05`. The only unique abandoned UI WIP remains
preserved at tag `archive/ui-cleanup-wip-2026-06-17` (`f316ed8`).

---

## Build Queue

Treat these as product lanes, not hotfixes, unless Ronnie says otherwise.
This is the canonical home for outstanding build/design work.

Next-session routing: item 1 starts with Ronnie adding the seven already-stored
1Password values as GitHub `dr-backup` Environment secrets. Then run the
read-only preflight, separately approve the first immutable backup, and prove an
isolated restore before building the Site & Recovery Admin tab. Item 2 resumes
from pushed warm-up commit `722ba1f` after measured run `30002663288` reports;
keep two shards and retain telemetry for the measured rerun.
Newsletter item 3
needs Ronnie's writing example and a controlled PROD AI probe before the first
issue. Item 4 remains a later operational cutover decision. Item 5 removes
Processing Center tasks from the Task Center list without deleting their source
records or disrupting Processing workflows.

1. Full disaster recovery + Site & Recovery Admin tab
   - Status: PROVIDERS AND CREDENTIAL CUSTODY CONFIGURED; BACKUP ROLE PROD-ACTIVE
     AND READ-ONLY VERIFIED; AUTOMATION SOURCE PUSHED TO MAIN; GITHUB
     VARIABLES/PROTECTIONS COMPLETE; 0/7 GITHUB SECRETS; NO PREFLIGHT, BACKUP,
     RESTORE PROOF, OR UI BUILD YET.
   - Class: `RELIABILITY`/`SECURITY`/`DATA-OPERATION`/`ENH`.
   - Locked architecture:
     - Supabase Pro is the production database/Auth/Storage platform and first
       provider recovery layer. GitHub owns code history; Netlify hosts and
       deploys the site. Neither code history nor Netlify is a data backup.
     - Backblaze B2 is the primary independent backup and Cloudflare R2 is the
       second independent backup. Both receive hourly encrypted logical database
       dumps and exact-path Storage copies with manifests/checksums.
     - Initial physical retention is deliberately indefinite: the narrow B2
       writer has no delete or governance-bypass capability and no lifecycle
       rule removes generations. The former 48-hourly/35-daily/12-monthly caps
       are not enforced and must not be claimed. Minimum immutability is 2 days
       for hourly database generations, 35 days for daily and Storage objects,
       and 365 days for monthly database generations. Database packages are
       encrypted client-side before upload; Storage copies stay private and
       provider-encrypted.
     - B2 uses a private bucket, SSE-B2, Object Lock with a two-day default, and
       longer per-object retention for daily/monthly/storage generations. R2
       uses timestamped unique keys and bucket locks; do not design around S3
       versioning because R2 does not provide it.
     - The database encryption key lives in 1Password plus one offline emergency
       copy. No password, token, MFA seed, recovery code, or encryption key may
       enter Git, the app UI, logs, backup manifests, or an AI prompt.
   - Current implementation: B2/R2 buckets, provider writers, lock policies,
     Supabase Storage S3 source access, the age keypair, and the read-only PROD
     database role exist. Commit `b2c3826` adds the streaming backup
     runner, workflow, inventories, manifests, retention mapping, preflight, and
     extensive behavioral/static safety tests and is published on `main`.
     GitHub Environment `dr-backup` is main-only, reviewer-gated, and has all
     seven variables but none of the seven secrets. No successful provider write
     or combined database + Storage
     restore drill has run, so no RPO/RTO or achieved-protection claim is valid.
     Monitoring/alerts and restore tooling/procedure remain to be completed.
   - Next implementation sequence:
     1. NEXT SESSION FIRST ACTION: add the seven GitHub Environment secrets from
        their existing 1Password items: `DR_PROD_DB_URL`, `DR_B2_KEY_ID`,
        `DR_B2_APPLICATION_KEY`, `DR_R2_ACCESS_KEY_ID`,
        `DR_R2_SECRET_ACCESS_KEY`, `DR_STORAGE_S3_ACCESS_KEY_ID`, and
        `DR_STORAGE_S3_SECRET_ACCESS_KEY`. Add them only under Environment
        `dr-backup`, never as repository secrets; verify names only and never
        expose values in chat, screenshots, source, shell arguments, or logs.
     2. Manually approve and run the read-only preflight from `main`; settle
        Supabase/B2/R2 endpoint, credential, AWS CLI, and bucket-access facts
        without uploading anything.
     3. Under a separate immutable-write gate, run the first combined encrypted
        database + Storage backup. Verify manifests, checksums, coverage, B2
        retention calls, R2 timestamped keys, and absence of plaintext residue.
     4. Restore into an isolated recovery project and verify Auth/application
        rows, animal histories, dailies, Processing, tasks/comments, every file
        bucket/path, private-file access, submissions, and background jobs.
     5. Add stale/failure monitoring, then only after the framework is exact and
        proven, build the final backup
        graphic and the admin-only `Site & Recovery` tab between `Deleted` and
        `Client Errors`.
   - Site & Recovery v1 is deliberately lean and collapsible: Overview; Accounts
     & Access; Backups & Recovery; Making Site Changes; Emergency Help; Takeover
     & References. It explains that a successor should open the local
     `WCF-planner` clone and have Codex or CC read `HO.md` then `PROJECT.md`.
     `HO.md` is model-workflow guidance, not a standalone novice manual. Netlify
     owns hosting/custom-domain/DNS/build/deploy instructions. Asana is excluded.
     Login identifiers are `ronnie@whitecreek.farm`; passwords are referenced
     only by the 1Password vault name. The common login/vault label must come
     from the smallest server-side admin-only settings boundary, not public
     source or browser env. The Anthropic API personal-account dependency is
     disclosed for later transfer.
   - Required gates: each bucket/retention change, secret, backup runner,
     deployment, migration, and any PROD restore action remains explicitly
     gated. A backup is not working until an isolated restore proves rows and
     physical files recover together. Do not create the final backup graphic
     before configuration and restore evidence settle the exact framework.
   - Success criteria: WCF Planner has documented and monitored recovery for
     database, Auth, every uploaded object, code/configuration, integrations,
     and unsaved drafts; no single Supabase/GitHub/Netlify/admin account can
     erase both production and recovery copies; measured restore drills meet the
     approved RPO/RTO; and Ronnie has a concise emergency runbook.

2. Shared TEST / Playwright rotating-flake closure
   - Status: ACTIVE ON `feature/test-playwright-reliability`; FIVE TEST-INFRA
     CHECKPOINTS PUSHED TO THE FEATURE BRANCH, NONE MERGED; MEASURED WARM-UP
     DISPATCH QUEUED.
   - Class: `DEFECT`/`CI`/`TEST-INFRA`/`RELIABILITY`.
   - Evidence and completed feature-branch work:
     - `61e9bed` replaced direct splash waits in 26 families with the shared
       two-marker readiness helper and guards its ownership. `6cbdd9c` makes
       application `page.goto` readiness central through the canonical fixture,
       with an explicit documented opt-out contract. The observed cold-boot
       failure mechanism has not recurred since centralization.
     - `e5b9ab3` keeps per-test isolation while parallelizing proven-independent
       TEST reset operations, batching FK-independent seed stages, making
       Storage cleanup fail closed, and caching a fully paginated immutable TEST
       admin identity. Idle fixture setup improved roughly 975→590ms for cattle
       forecast and 786→430ms for animal transfer; both original setup-timeout
       targets passed in full run `29936691088`.
     - CI remains red under rotating load. Run `29936691088` was clean on shard
       1 (284/284) and failed four on shard 2: a new TRUNCATE statement/lock
       timeout, an IndexedDB read hang, and two post-ready Task Center render
       races. Earlier runs rotated among other specs while focused leased runs
       passed. The unchanged common factor appears to be environmental
       amplification during long serial shards, but that remains an inference
       until the current diagnostic work reports runner and lock evidence.
     - Pasture remains separately unmeasured by these manual full dispatches
       because the classifier reports `pasture=false`; its earlier failure
       cluster is still open and untouched.
   - Diagnostic conclusion and next action: failure ordinals span the suite, so
     late-file accumulation is refuted; elapsed failures cluster at cold start
     and 11–16.5 minutes, and run `29936691088` placed three unrelated failures
     inside one minute. A prior hung page may leave a PostgREST query holding an
     ACCESS SHARE lock while the next reset's TRUNCATE waits for ACCESS
     EXCLUSIVE, but no blocker snapshot exists yet. Commit `8a8bff7` adds the
     fail-closed TEST-only lock diagnostic and bounded runner telemetry. Run
     `29954947453` confirmed CPU/cold-start pressure rather than memory/disk
     exhaustion: shard 1 failed two early Broiler public-form renders; shard 2
     failed two cold-start IndexedDB reads and two Task Center renders after its
     peak load sample. Package A's targets passed for the third run.
   - Chosen next fix: one automatic worker-scoped warm-up through the
     canonical fixture, with a separate fixture timeout so warm-up does not
     consume a normal test's 30-second budget. It must hard-refuse non-TEST/non-
     local targets, use a fresh context on the same worker browser, prime the
     Vite module graph and a disposable IndexedDB path without mutating TEST
     data, then close the context. This is committed and pushed as `722ba1f`;
     inspection proved the app has no route
     code-splitting, so one logged-out `/` visit compiles the full static module
     graph and authenticated route visits would add no compile coverage. Keep
     two serialized shards and retain telemetry/lock diagnostics for measured
     post-warm-up run `30002663288`, queued behind nightly `29999814082`. If steady-state
     CPU-spike failures remain after this measured fix, evaluate a billed 8-vCPU
     runner; do not add shorter shards or process restarts, which would repay the
     proven cold-start cost more often.
   - Build constraints: preserve fail-closed high-risk/full coverage and the
     one-file-at-a-time TEST-DB lease contract. Do not add blind retries, sleeps,
     weakened assertions, skipped coverage, or success-on-failure handling.
     Prefer deterministic readiness signals, idempotent scoped seeds, explicit
     session ownership, and isolation of cross-spec residue.
   - Validation: after selecting the smallest evidence-backed structural fix,
     demonstrate repeated clean full-shard/main-equivalent runs plus focused
     reruns of every changed fixture family; keep DB-free/risk-selection policy
     tests green and document any proven product defect as its own lane. Do not
     merge the current feature branch on the existing red evidence.
   - Success criteria: main CI is trustworthy and repeatable, failures identify a
     stable actionable cause, and no local Playwright or GitHub job can silently
     collide with another TEST database owner.

3. July newsletter: first real issue and editorial redesign
   - Status: EDITORIAL-STEERING UI/SOURCE SHIPPED; MIGRATION `189` REPORTED
     PROD-APPLIED; `newsletter-harvest` PROD v7 VERIFIED; NO ISSUE HAS EVER BEEN
     PUBLISHED. Target the July issue (covering July) for release by August 5.
     The draft must not read like a robot listing facts. Ronnie must still enter
     the real writing example used as the voice reference; do not invent a
     generic farm voice.
   - Class: `ENH`/`EDITORIAL`/`AI`/`DATA-OPERATION`.
   - Audience/message: owners, the farm team, and other family staff who interact
     with the farm (including household and personal-assistant roles). Lightly
     remind them that White Creek Farm is a multi-program regenerative Florida
     Panhandle farm: grass-finished cattle/sheep; non-GMO, corn-free and soy-free
     chicken/pig feed; nutritional meat and soil regeneration. Assume an informed
     audience. The issue should prove that the team is growing/developing, its
     work is effective, and the farm is distinctive/special.
   - Editorial/data decisions:
     - Team-centric `we` voice; warm and restrained, shorter rather than dense.
       Ronnie's review target is 10-15 minutes.
     - Facts are the backbone and positive feeling supports them. Prefer
       year-over-year comparisons; year-to-date and up to three years may appear
       when real comparable data exists. Missing periods display unavailable,
       never zero. Cover cattle, broilers, pigs, sheep, and eggs; any genuine
       increase may be noteworthy.
     - Strong story types include animals on farm, processing volume versus the
       same point last year, completed organizing/infrastructure projects and why
       they matter, and a focused difficulty the team overcame. Do not publish
       fragile promised timelines. If Animals on Farm is highlighted, keep it a
       separate fact/story and omit a combined all-species Total.
     - Photos/required-source list is due by the 1st; publish by the 5th. A named
       helper can gather the supplied checklist. Source verification is
       non-negotiable. The issue title/brand is simply `White Creek Farm`.
     - Distribute the published issue as a rotating 7-day link in the group chat.
       No email/PDF/RSS build is requested.
   - Remaining actions: Ronnie enters the writing example, then run one controlled
     PROD AI probe proving the style-save/write path; gather July facts/photos,
     let Ronnie edit/review, publish the first issue, and verify the expiring
     archive link. Keep monthly automation off until separately approved.
   - Success criteria: Ronnie can complete the monthly work in 10-15 minutes;
     one fact-checked, team-centric July issue is published by August 5; the
     keyed reader works; no private/unapproved media or fabricated comparison is
     exposed.

4. Processing final Asana cutover
   - Status: DECISION ONLY; recurring comments automation is live and healthy.
   - Class: `DECISION`/`CUTOVER`.
   - Remaining action: decide whether/when to set global
     `asana_sync_enabled=false`. Do not infer this authorization from successful
     comments-only automation; it is a separate operational gate.
   - Historical Activity decision is closed: do not import the roughly 16,855
     Asana system stories. They remain intentionally absent unless Ronnie makes
     a new explicit decision. The three deleted linked cards remain explicit
     404 skips.
   - Imported Asana `@mentions` may remain plain text; they do not need profile
     resolution, highlighting, or retroactive notifications. This is not a
     follow-up build item. Newly written Planner comments must retain the native
     working mention behavior.
   - Success criteria: the deliberate cutover does not interrupt hourly comments
     import, historical Activity remains absent, and no UI maintenance controls
     are revived.

5. Remove Processing Center tasks from Task Center lists
   - Status: REQUESTED; NOT YET INVESTIGATED OR BUILT.
   - Class: `ENH`/`TASK-CENTER`/`PROCESSING`.
   - Problem: Processing Center tasks currently appear in the Task Center list;
     they should not be shown there.
   - Scope: identify the durable Processing-task marker and exclude matching
     tasks from Task Center list surfaces without deleting task records,
     weakening permissions, or disrupting Processing Center workflows.
   - Success criteria: Processing Center tasks remain available to the
   Processing workflow but no longer appear in Task Center lists; ordinary
   Task Center tasks and their existing behavior remain unchanged.

---

## Global Decisions (Constitution)

The following decisions are locked and govern future builds. New code and
surface changes MUST conform unless this section is amended.

Rules:

- No surface may silently diverge from a locked decision. New exceptions MUST be
  added to `## Intentional Non-Uniformities` with justification.
- Changing any locked decision requires a Ronnie-approved amendment in this file
  and the relevant guard update in the same change.
- The entire `## Design System` section is part of the Constitution.

| Decision | Status | Evidence |
| --- | --- | --- |
| Font scale | Ratified; shared-token enforcement active, residual legacy drift only by scoped lane | `design_token_contract_static.test.js`, `record_page_shell_static.test.js` |
| Radius floor (CP0 section A3) | Ratified; 10px floor, `4`-`9` retired on real UI, sub-10 allowlist via `radius-allow` | `radius_floor_static.test.js`, `design_token_contract_static.test.js` |
| Confirm/Delete stacking | Ratified; top destructive overlay tier | `design_token_contract_static.test.js`, `shared_ui_extraction_contract_static.test.js` |
| Button height/padding | Ratified; standard button pad `10px 16px` | `design_token_contract_static.test.js` |
| Save model | Ratified; submit-style vs autosave split | `save_model_contract_static.test.js` |
| Ordinary text hierarchy | Ratified; Home + parity + CP0 true-black sweep shipped | `homeRedesign.css`, `index.html`, `src/shared/DataTable.css`, `design_token_contract_static.test.js` |
| Design-law package (CP0) | Ratified 2026-06-16 (CP0-SIGNOFF A1-A12 + Tabs); compliance pass shipped 2026-06-18; deferred residual tails closed 2026-06-30 | folded into Global Decisions + Design System; `tests/static/non_pasture_residuals_static.test.js` |
| True-black text (CP0 section A1) | Ratified; `--text-primary`/`--ink`/island `--text` = `#000`; `getReadableText` exempt | `design_token_contract_static.test.js`, island/openable guards |
| One border gray (CP0 section A2) | Ratified; `--border` == `--border-strong` (one defined gray) | `index.html` token layer |
| Program-color tabs (CP0 Tabs) | Selected tab = filled pill in program color; unselected = plain text; header sub-nav adopts it; top green chrome stays | `Header.jsx` sub-nav + `Tabs.jsx`; `tests/static/non_pasture_residuals_static.test.js` |
| Closed badge set (CP0 section A4) | `ok/warn/danger/info/neutral`; <=1 per row; soft signals = colored text | `Badge.jsx`; broiler/pig/cattle batch static guards assert `<Badge>` adoption |
| One table system (CP0 section A6) | hairline rows, no zebra, right-aligned numbers, status as text first, whole-row openable | `DataTable.jsx`, `DataTable.css` |
| Color discipline (CP0 section A12) | program accent only on pill/dot/one-figure/brand-button; closed text-color set; species = dot + black label | dedicated guard in `tests/static/non_pasture_residuals_static.test.js` plus `design_token_contract`/`openable_hover` guards |
| Universal hover affordance (CP0 WI-6) | tile/card openables lift 3px/300ms + trailing chevron; table rows signal via wash + cell-border + chevron without `<tr>` transform; daily record lists use div-based `.hoverable-tile` cards to get the Home-tile lift | `openable_hover_affordance_static.test.js` |

Locked functional invariants:

| Invariant | Contract section | Guard |
| --- | --- | --- |
| Single Supabase client owner; no unapproved browser secrets | Cross-App Rules | `supabase_client_owner_static.test.js`, `browser_secret_boundary_static.test.js` |
| Permissions enforced by RLS/RPC, never UI alone | Authentication And Roles | `light_user_portal_static.test.js` and per-surface guards |
| Route aliases only in `src/lib/routes.js` | Route Ownership | `url_alias_redirects.spec.js` |
| Fail-closed loading order | Cold-Boot And Fail-Closed Loading | `load_retry_robustness_inventory_static.test.js` |
| Audit-critical mutations through SECDEF RPCs | Entity Mutations And Audit Atomicity | `mutation_semantics_inventory_static.test.js` |
| Daily edits/deletes through ownership RPCs | Daily Reports | `cp2_daily_writes_via_rpc_static.test.js` |
| One canonical component per UI role | Shared UI And Record Chrome | `shared_ui_extraction_contract_static.test.js` |
| Playwright coverage selected by risk; unknown risk fails full | Validation Map | `ci_playwright_plan.test.js`, `ci_risk_based_workflow_static.test.js` |

---

## Intentional Non-Uniformities

These differences are current product/architecture decisions, not parity defects
unless Ronnie changes the contract:

- Light users are intentionally excluded from `/weighins` and `/production`.
  Light users have pasture farm-team-level access to `/pasture-map` (migration
  `139`): full Map + Field working controls, not a read-only/Map-only view.
- Light users may access Cattle Log through the webform/field-journal path.
- Migration `083` public webform submitter identity stays shelved. Authenticated
  submitter identity is the durable path.
- `/webform-pigs` remains a valid legacy standalone pig daily form route/alias.
- `egg_dailys` has warning/pre-submit duplicate prevention only; it is not
  covered by the daily unique-index backstop.
- Add Feed quick-log rows are not full daily reports, and missed-report checks
  exclude `source='add_feed_webform'`.
- Broiler, layer, and pig daily pages use Group copy rather than Batch copy.
- Pig planned-trip forecast weights are render-only. Latest weigh-ins do not
  change planned-trip forecast weights automatically.
- Program dashboards may show program-specific KPIs.
- The public `#webform-container` CSS island is intentionally separate from the
  React app tokens.
- The homepage redesign remains scoped under `.home.theme-crisp`; do not move
  Home-specific non-canonical micro-values globally without an amendment.
- The public `#webform-container` island has its CP5 form-styling pass in the
  static HTML shells (`ceb7dcf`). That pass affects the fallback/island surface,
  not authenticated React routes rendered through `#root`.
- CP0 section A12.1 permitted-uses are extended (2026-06-17) so the primary/brand button
  re-tints to the program color via `--brand` on each program's page wrapper; this
  is ratified, not palette drift.
- `getReadableText()` in `src/lib/styles.js` returns infrastructure contrast
  colors for arbitrary colored backgrounds; this is not palette drift.

---

## Product Surface

### Authenticated App

- Home dashboard: `.home.theme-crisp` landing surface with label-only program
  tiles, Pasture Map + Weather field row, Processing/Admin utility row, Animals
  on Farm, Production, missed-daily/equipment/material alerts, Next 30 Days, and
  admin Last-5-Days.
- `/animals-on-farm`: newest-first monthly recorded species counts and one
  independently scaled trend chart per species. There is no combined Total.
  Layer counts disclose the oldest contributing evidence date and whether any
  positive contributor is undated. History range starts Oct 2024.
- `/production`: per-program production totals, per-program YoY, and production
  events. Internal reconciliation prevents double-counting historical backfill,
  but the visible page is production reporting, not audit/import review. No
  combined total ever.
- `/pasture-map`: field map/planning surface for OnX KML import, land-area
  review, classification, outline close, draw/edit/snap/measure, acreage
  display, GPS locate, NAIP imagery, move ledger/current occupancy, planned
  moves, rest/history/stocking reports, offline vector queue, GPS field tracks,
  and line-style/pattern controls.
- Broiler: home, timeline, batches, feed, dailys, weigh-ins.
- Pig: home, breeding, farrowing, breeding pigs, batches, feed, dailys,
  weigh-ins with table-based session records and Active/Complete list sections.
- Layer: home, groups, batches, dailys, eggs.
- Cattle: home, herds, breeding, forecast, processing batches, dailys,
  weigh-ins, Cattle Log.
- Sheep: home, flocks, processing batches, dailys, weigh-ins.
- Equipment/Fleet: `/fleet` with fleet list, fuel log, and equipment detail;
  `/equipment` remains the login-gated fueling/checklist hub.
- Task Center: `/tasks`, with To Do List at `/tasks/todo` and record pages at
  `/tasks/todo/<id>`.
- Light portal: contained home for `role=light`, allowed webform/daily
  shortcuts, Tasks, My Submissions/View Past Reports, equipment public hub, fuel
  supply, Add Feed, legacy pig daily, Cattle Log, and pasture farm-team-level
  Pasture Map (full Map + Field working controls, migration `139`). No Production
  or Weigh-ins.
- Global Activity: `/activity`.
- Admin/config: `/admin`, including the Client Errors tab after Deleted. Site &
  Recovery is not built yet and will eventually slot between those two tabs.
- Admin runtime observability keeps `/admin/client-errors` as a compatible deep
  link to the same Client Errors panel.

### Login-Gated Form URLs

- Former public report/form URLs are authenticated. Existing paths and aliases
  stay valid, redirect logged-out users to login, and return to the requested URL
  after auth.
- `/dailys` and `/dailys/tasks`.
- `/addfeed`.
- `/weighins`.
- `/equipment` and `/equipment/<slug>`.
- `/fuel-supply`.
- `/webform-pigs`.
- Legacy aliases redirect through `src/lib/routes.js`.

### Operational Record Pages

Record pages are durable per-entity workspaces. They own record details,
Comments, collapsed Activity log, sequence navigation where appropriate, and
fail-closed loading.

Live Activity entity types and routes:

| Entity type | Route |
| --- | --- |
| `task.instance` | `/tasks/<id>` |
| `todo.item` | `/tasks/todo/<id>` |
| `cattle.animal` | `/cattle/herds/<id>` |
| `sheep.animal` | `/sheep/flocks/<id>` |
| `cattle.processing` | `/cattle/batches/<id>` |
| `sheep.processing` | `/sheep/batches/<id>` |
| `broiler.batch` | `/broiler/batches/<encoded name>` |
| `pig.batch` | `/pig/batches/<group id>` |
| `pig.breeder` | `/pig/sows/<id>` |
| `layer.batch` | `/layer/batches/<id>` |
| `layer.housing` | `/layer/housings/<id>` |
| `equipment.item` | `/fleet/<id>` |
| `poultry.daily` | `/broiler/dailys/<id>` |
| `layer.daily` | `/layer/dailys/<id>` |
| `egg.daily` | `/layer/eggs/<id>` |
| `pig.daily` | `/pig/dailys/<id>` |
| `cattle.daily` | `/cattle/dailys/<id>` |
| `sheep.daily` | `/sheep/dailys/<id>` |
| `weighin.session` | `/weigh-in-sessions/<id>` |
| `cattle.forecast` | `/cattle/forecast` |
| `cattle.breeding` | `/cattle/breeding` |
| `cattle.log` | `/cattle/log` |

No operational record workspace should reintroduce legacy `ActivityPanel` or
`ActivityModal`. Comments are discussion; Activity is audit/history.

---

## Backend And Data State

### Stack

- React 18 / Vite SPA.
- Supabase JS client from `src/lib/supabase.js` only.
- React Router DOM.
- `idb` for IndexedDB/offline queue.
- Leaflet for Pasture Map rendering; Leaflet-Geoman powers draw/edit/snap
  controls.
- Vitest for unit/static tests.
- Playwright for e2e.
- ESLint + Prettier.
- Netlify production deploy from `main`.
- Netlify Functions (serverless): the Home Weather data proxy
  (`netlify/functions/weather-forecast.js`).

### Supabase Migrations

Current PROD architecture includes all repository migrations through `166`,
`170` through `183`, and `185`-`189`; `167`-`169` are intentionally unused and
`184` is reserved/not present.
Recent load-bearing
migrations:

- `100` processing batch lifecycle RPCs.
- `101`-`104` audited delete RPCs and hardening.
- `105` recurring task template creation RPC.
- `106` delete layer batch RPC.
- `107` delete fuel bill RPC.
- `108` delete feed input RPC.
- `109` drop dead daily-photo anon insert policy.
- `110` cattle calf-row heifer promotion.
- `111` weigh-in note -> canonical comment mirror.
- `112` cattle log sidecar tables/RPCs/triggers.
- `113` Light daily report 3-day own-record edit/delete window.
- `114` task photo 5-total DB backstop.
- `115` Task Center To Do List schema/RPCs/photos/mentions/digest fields.
- `116` Pasture Map CP1:
  - `pasture_import_batches`, self-referencing `land_areas`, and append-only
    `land_area_geometry_versions`.
  - PostGIS in `extensions` schema; geometry stored as 4326; acreage via
    `ST_Area(geom::geography)`.
  - Deny-all RLS; access only through SECURITY DEFINER RPCs.
  - `list_land_areas` read gate originally: `farm_team`, `management`, `admin`;
    migration `136` widens only this read RPC and `list_pasture_moves` to Light.
  - Import/classify/close/delete gates: `management`, `admin`.
  - OnX UUID becomes `source_external_id`; re-import updates, not duplicates.
  - Polygons import as `unclassified`/`pending_review`; LineStrings import as
    `outline_candidate`; no auto-close; invalid polygons are flagged, not fixed.
  - No fabricated last-grazed date; `baseline_no_history` is distinct.
- `125` Production legacy events:
  - `production_legacy_events` table with deny-all RLS.
  - `list_production_legacy_events(date,date)` SECURITY DEFINER read RPC.
  - Read gate: `farm_team`, `management`, `admin`; Light excluded.
  - Spreadsheet importer upserts by stable `source_key`; 69 rows imported to
    PROD on 2026-06-15.
- `126` Breeding-pig Activity entity:
  - Adds `pig.breeder` to `_activity_can_read` / `_activity_can_write`.
  - Existence check is `app_store` key `ppp-breeders-v1`, object id match.
  - Program access gate is `pig`.
- `127` Pasture Map CP2 draw/edit:
  - Adds `create_land_area(text,text,jsonb,text,text)` and
    `update_land_area_geometry(text,jsonb)` SECURITY DEFINER RPCs.
  - Management/admin only; EXECUTE granted to `authenticated` and revoked from
    `PUBLIC`/`anon`.
  - Reuses `_land_area_add_version`; edits append a new geometry version and
    stamp version source as `drawn`, while preserving the original area source
    in raw payload.
  - Validates polygon/multipolygon GeoJSON and rejects invalid/self-
    intersecting geometry; acreage remains geodesic.
  - PROD-applied on 2026-06-16 with schema reload and structural/PostgREST anon
    permission smokes. No PROD land-area rows were created.
- `128` Pasture Map CP3 move ledger / occupancy / rest:
  - Adds `pasture_move_events`, `pasture_move_impacts`,
    `_land_area_current_geom`, `_pasture_move_summary`, updated
    `_land_area_summary`, `list_pasture_moves`, and `record_pasture_move`.
  - Move impacts track destination/departure/overlap. Grazing state and current
    occupants are derived from dated move events.
- `129` Pasture Map CP4 planning/reports:
  - Adds `pasture_planned_moves`, planned-move create/list/status RPCs, and
    history/rest/stocking report RPCs.
- `130` Pasture Map CP6 field GPS tracks:
  - Adds `create_land_area_track` for farm-team/management/admin field-created
    outline candidates from GPS LineStrings.
- `131` Pasture Map CP7 line style:
  - Adds line color/weight support and manager/admin style update RPCs.
- `132` Pasture Map line patterns/defaults:
  - Adds `line_pattern`, solid/dashed/dotted validation, default imported OnX
    line styling, default field-track styling, and
    `update_land_area_line_style`.
  - Verified TEST and PROD artifacts present on 2026-06-17 by catalog checks.
- `133` task system generation support and To Do approval notifications:
  - Widens `notifications_type_check` for `todo_completion_submitted`.
  - Reissues `submit_todo_completion` so non-manager completion submissions
    notify management/admin while approval and auto-approval still notify the
    To Do creator.
  - TEST-applied on 2026-06-17; PROD-applied on 2026-06-18.
- `134` originator task/to-do edit photos:
  - Preserves RPC-only writes, append-only private photo storage, and the shared
    5-photo total cap.
  - PROD-applied on 2026-06-18.
- `135` Pasture Map temp-paddock lifecycle:
  - Adds narrow SECURITY DEFINER RPCs for real temp paddock create/rename/redraw,
    archive/restore, and admin hard-delete using `kind='paddock'` plus
    `permanence='temporary'`; existing permanent-area create/update/delete RPCs
    remain management/admin locked.
  - TEST- and PROD-applied/verified. Production temp-paddock lifecycle calls are
    supported.
- `136` Pasture Map Light read-only Map access:
  - CREATE OR REPLACEs only `list_land_areas(boolean)` and
    `list_pasture_moves(int)` to add `light` to those read gates.
  - Does not widen write, planning, rest, stocking, or history report RPCs.
  - TEST-applied by CC and PROD-applied by Codex on 2026-06-20 with
    `psql --single-transaction`; PostgREST schema reload was notified.
  - PROD verification confirmed the two read RPCs contain the Light gate and
    `record_pasture_move`, planned-move, rest, stocking, and history RPCs do not
    contain Light.
- `137` Pasture feeder-pig paddock destinations:
  - Adds the feeder-pig paddock destination support used by the current
    Pasture Map production code.
  - PROD-applied before the 2026-06-24 wrap.
- `138` Tier-1 RLS anon write-boundary hardening:
  - Drops legacy anon/public write policies on targeted daily/weigh-in/comment
    write tables while preserving authenticated `*_auth_all` policies.
  - PROD-applied and verified: zero targeted `*_anon_*` policies remain; five
    authenticated policies remain.
- `139`-`141` Pasture Map V1 reset:
  - `139_pasture_map_light_farm_team.sql` widens pasture-only Light permissions
    to the farm-team-level pasture RPC set. It does not widen Light outside
    Pasture Map.
  - `140_pasture_map_rotations.sql` adds server-backed manual rotation paths.
  - `141_pasture_map_measurements.sql` adds saved distance-measurement layers.
  - PROD-applied and verified on 2026-06-24.
- `142` System task title entity labels:
  - Adds optional `p_entity_label` to `generate_system_task_instance`, backfills
    open system task titles, and supports the corresponding `tasks-cron` deploy.
  - PROD-applied and verified on 2026-06-24; `tasks-cron` was deployed after the
    migration.
- `143` Pasture Map reset-area-grazing-history:
  - `delete_land_area_grazing_history(p_id text)` SECDEF, management/admin gated.
    Clears one area's `pasture_move_impacts` and detaches it from every
    `pasture_move_events` from/to, then resets `baseline_no_history` so state
    re-derives to "no move history". Other areas' impacts are preserved.
  - PROD-applied + verified 2026-06-25. The UI button and client wrapper that
    called it are removed; the RPC stays deployed but unused. Append-only ledger
    background lives in the Pasture Map Load-Bearing Contract below.
- `144` Newsletter Engine data/RPC boundary:
  - Adds tables: `newsletter_issues`, `newsletter_fact_candidates`,
    `newsletter_photos`, `newsletter_runs`, and `newsletter_settings`.
  - Deny-all RLS; admin-only SECDEF RPCs for issue/intake/fact/photo/settings
    management; exactly three anon read RPCs for published list, published issue,
    and token-gated preview.
  - Public payloads use structured JSON blocks and approved photo paths only;
    no raw AI HTML and no `source_private_path` exposure.
  - Preview tokens are enabled/expiring, rotate on publish/unpublish/regenerate,
    and publish disables pre-publication preview links. Anon `noindex` is
    literal/locked true. Month inputs validate strict calendar `YYYY-MM`.
  - PROD catalog verified 2026-06-26: all five tables exist with RLS enabled;
    anon EXECUTE is present only on `list_published_newsletters`,
    `get_published_newsletter`, and `get_newsletter_preview` among the sampled
    newsletter RPCs.
- `145` Newsletter storage buckets:
  - Private `newsletter-staging` bucket: admin-only read/write for uploads and
    copied planner photos before public consent.
  - Public `newsletter-public` bucket: public read, admin-only write, populated
    only after admin photo approval; unapprove deletes the public copy.
  - PROD catalog verified 2026-06-26: `newsletter-staging` exists with
    `public=false`; `newsletter-public` exists with `public=true`.
- `146` Newsletter automation:
  - Adds the earlier Checkpoint B automation layer for
    `newsletter-harvest`, monthly reminder/task support, AI/template draft
    persistence, run logging, and a gated cron-invocation RPC.
  - PROD-applied + verified on 2026-06-29 as Gate 1 for PR #44, immediately
    before migration `151`. The monthly cron schedule remains intentionally off.
- `147` Pasture Map grazing entry delete and parent overlap:
  - Adds `delete_pasture_move(p_move_id)` SECDEF, management/admin gated,
    authenticated EXECUTE only, anon denied.
  - Per-stay delete removes the selected move and cascades its impacts. If the
    deleted move has a later move for the same animal group, the RPC clears only
    that later move's linked departure impacts for the touched areas and
    preserves the later move event. This prevents completed-stay drift.
  - `_land_area_summary` suppresses child-derived overlap state for direct
    parent pastures, so child paddock occupancy/rest does not color the parent
    fill. Parent-only history now resolves to baseline instead of visible
    no-history fill when appropriate.
  - TEST behavior and PROD catalog were verified on 2026-06-26.
- `148` Pasture Map group records, actual-weight metrics, planned cleanup:
  - Adds `pasture_move_events.total_weight_lbs` with a positive-value check and
    updates move/report RPCs to expose actual move-time group weight.
  - Updates `record_pasture_move` to accept optional `p_total_weight_lbs`;
    pasture group history/stay metrics use only recorded data for lbs/ac.
  - Drops the unused `pasture_planned_moves` table and planned-move RPCs. The
    rotation editor is now the planning source, and the group record move box
    records current area to next rotation area.
  - PROD smoke verified on 2026-06-26: weight column exists, record-move weight
    signature exists, and `pasture_planned_moves` is absent.
- `149` Pasture Map rest/history reconciliation:
  - Replaces `_land_area_summary` so orphan `pasture_move_impacts` whose move
    event has NULL `to_land_area_id`/`from_land_area_id` no longer derive
    occupancy, last touch, or resting state. This resolves the FP3/FP3A1 defect
    where the Map showed "Resting/Last grazed" while Reports showed no visible
    direct stay.
  - Preserves migration `147` child-from-parent suppression and does not change
    schema, RLS, grants, or return shape. Stale orphan impact rows are ignored,
    not deleted.
  - PROD-applied + verified 2026-06-27: FP3 and FP3A1 returned to baseline;
    Pig Pasture #4 remained occupied as positive control.
- `150` Pasture Map open-line edit:
  - Adds `update_land_area_track(p_id text, p_line_geojson jsonb)` SECDEF,
    management/admin gated, authenticated/service/postgres EXECUTE only and no
    anon/PUBLIC grant.
  - Validates LineString/MultiLineString with at least two points, allows only
    existing `outline_candidate` targets, rewrites `land_areas.raw_geometry` in
    place, and intentionally writes no acreage, geometry version, promotion, or
    schema/RLS/grant/return-shape change.
  - PROD-applied + verified 2026-06-27. PostgREST schema reload was issued
    manually after apply because this is a new exposed RPC. PR #45 later added
    `NOTIFY pgrst, 'reload schema'` to the migration file for future/fresh-env
    applies only; the migration was not re-applied to PROD because the function
    body was already live/verified.
- `151` Newsletter Autopilot:
  - Extends newsletter settings/issues for tone, length/detail, source
    coverage, photo plan, photo targets/minimums, and past-issue context;
    updates settings/generation input/admin/service RPCs; preserves mig `144`'s
    exactly-three anon RPC surface.
  - PROD-applied + verified on 2026-06-29 immediately after `146`. Verification
    covered the `146` RPC surface, the `151` RPC/settings/photo-plan additions,
    and the single backward-compatible `update_newsletter_settings` overload.
    `newsletter-harvest` was redeployed after the SQL gate (v2 at this
    mig-151/PR #44 checkpoint — see Current State for the current active version);
    the PROD-only `NEWSLETTER_AI_API_KEY` secret is live, so AI calls can use
    Anthropic in production. TEST intentionally remains without that key.
- `152` Pasture Map manager hard delete:
  - Widens `hard_delete_land_area` from admin-only to management+admin, keeping
    the occupancy guard, child-detach, and no-purge soft-delete path unchanged;
    the client danger zone + Area-record gate moved to `isManager`.
  - Applied to TEST and PROD on 2026-06-30 with the role gate, grants, occupancy
    guard, and no-purge path verified on PROD.
- `153` Newsletter archive-link gating:
  - Adds `archive_access_token` + `archive_access_expires_at` to
    `newsletter_settings`; key-gates the two published-archive anon RPCs
    (`list_published_newsletters`, `get_published_newsletter` gain `p_key` and
    return NULL unless the key matches + is unexpired, constant-time compare via
    `_newsletter_archive_key_ok`); `publish_newsletter_issue` mints a fresh 7-day
    key; adds the admin-only `regenerate_newsletter_archive_link`; and surfaces
    the key + expiry through `get_newsletter_settings`. Anon surface stays the
    same three RPCs (`get_newsletter_preview` unchanged). No BEGIN/COMMIT in the
    file (exec_sql / `psql --single-transaction` wrap it).
  - TEST-applied + behaviorally verified via `scripts/apply_test_mig_153.cjs`
    (locked w/ no/wrong/expired key; valid key works; admin-only regenerate kills
    the old key). PROD-applied + verified 2026-06-30 via
    `psql --single-transaction -v ON_ERROR_STOP=1` with a behavioral check;
    PostgREST reloaded via the file's `NOTIFY pgrst`. No Edge Function or Netlify
    env change. Reverses the prior "public no-login archive" contract.
- `154` Fuel-bill Activity entity / mutation-audit PR2B:
  - Adds dedicated `equipment.fuel_bill` Activity read/write scope by reissuing
    `_activity_can_read`; admin-only and existence-free so deleted fuel-bill
    tombstones remain readable.
  - Re-scopes `delete_fuel_bill` Activity from `equipment.item` to
    `equipment.fuel_bill`; `_activity_can_write` remains delegated to read.
  - TEST-applied and behaviorally verified by `scripts/apply_test_mig_154.cjs`;
    PROD-applied and verified after `d169757`.
- `155` Pasture Map departed-overlap rest fix:
  - Reissues `_land_area_is_occupied` / summary behavior so an area departed in
    the same move that created an overlap can rest correctly instead of staying
    zero-days/occupied.
  - No data mutation; PROD-applied as part of the pasture rested-paddock hotfix.
- `156` Processing Calendar foundation:
  - Adds the native Processing domain tables/RPC boundary, including records,
    subtasks, comments, attachments, templates/settings/import support, storage
    plumbing, `processing.record` Activity scope, and the initial
    `processing-asana-sync` Edge Function contract.
  - PROD-applied before the reconciler lane. Planner reconciliation, review
    resolution, comments, subtasks, conversation media, and ordinary attachments
    have run. Historical Activity is intentionally not being imported; only
    final cutover remains a Build Queue item 4 decision.
- `157` Processing Planner reconciler + Asana link table:
  - Adds `processing_asana_links`, imported comment provenance, subtask local
    ownership, drift/ack fields, reconciliation reports, planner enumeration,
    stale planner-row archival/unarchive, and the guarded Asana attach/import
    RPC contract.
  - `upsert_processing_from_asana` cannot mint `planner_batch`; Asana can only
    link/seed allowed provenance and artifacts. Manual crosswalks are sticky.
  - PROD-applied and catalog-verified. Planner reconcile, the retired workbench,
    comments, subtasks, and conversation-media lanes have run; see Current State
    and Build Queue item 4 for live counts and remaining decisions.
- `158` Pasture Map positive-area overlap impacts:
  - Reissues the pasture overlap predicate and affected move/read functions so a
    shared boundary/edge touch no longer counts as grazing overlap. Overlap
    state now requires positive geodesic intersection area (`> 1.0 m^2`) while
    still allowing true containment/real overlap.
  - PROD-applied and verified after the FP4D1 -> FP4E1 Mommas move defect:
    FP4D1 reads resting, FP4E1 occupied, and edge-touch neighbours FP4C1/FP4E2
    read baseline without data cleanup.
- `159` Processing reconciliation workbench:
  - Reissues/extends `resolve_processing_asana_link` so reassigning a link off a
    sole-owned Asana placeholder reparents comments/subtasks/attachments and
    archives the emptied placeholder.
  - Adds `triage_processing_asana_record`,
    `supersede_processing_asana_duplicate`, and an enriched
    `list_processing_reconciliation` with buckets, duplicate groups, candidates,
    dismissed rows, and duplicate-blocked provenance.
  - PROD-applied and verified; the client workbench and `sync_review_queue`
    action were deployed in the follow-on Edge gate, and Ronnie completed the
    reconciliation pass.
- `160` Processing broiler Time-on-Farm:
  - Reissues `list_processing_records` and `get_processing_record` to include
    `time_on_farm_days` for broiler `planner_batch` rows, derived read-only from
    `app_store` `ppp-v4` as `processingDate - hatchDate`.
  - PROD-applied and verified against live broiler planner rows. Migration `174`
    retired Time-on-Farm from the visible default suite/drawer; the read-only
    server value remains backward-compatible data, not an active UI field.
- `161` Processing soft archive RPC:
  - Adds `archive_processing_record(p_id text, p_archived boolean default true)`
    for Asana-owned/historical Processing rows. It preserves the record and any
    Asana links, supports restore, and refuses `planner_batch` rows because
    Planner-owned records are reconcile-managed.
  - PROD-applied and catalog-verified. Milestone hard delete remains separate.
- `162` Processing option lists:
  - Adds `customer_options` to the `processing_asana_sync_settings` singleton
    and wires the already-existing `processor_options` list into the UI.
  - Adds admin-only `set_processing_option_list(kind, options)`, which trims,
    de-dupes, drops blanks, and never rewrites stored Processing record values.
    Legacy/off-list customer/processor values remain valid and visible.
  - PROD-applied and verified; Customer/Processor choice management is live
    inside the admin-only Templates modal.
- `163` Processing attachments Storage bucket:
  - Creates the private `processing-attachments` bucket. SELECT on
    `storage.objects` is limited to authenticated operational roles
    (`farm_team`, `management`, `admin`) through `public.profile_role()`;
    `light`, `equipment_tech`, inactive users, and anon have no read. There is
    no authenticated INSERT policy at this migration checkpoint; Asana byte-copy
    writes are service-role importer work only.
  - PROD-applied and verified. Migration `166` later adds a narrow native-upload
    INSERT policy without opening the Asana namespace. Eight imported
    conversation-media objects remain stored; all 68 ordinary Asana GIDs are
    indexed, with the later verified stray-workbook cleanup represented by
    tombstones rather than live objects. The final dry run found 0 new files.
- `164` Processing engine:
  - Adds typed template field storage, profile-backed checklist assignees,
    automatic planner freshness, template checklist seeding for new Planner
    records, reordering, and best-effort Activity emits for Processing-owned
    mutations. Reserved Planner/RPC-owned field ids remain server-refused.
  - PROD-applied and TEST-proven. The parent-record assignee RPC remains deployed
    for compatibility, but the simplified UI no longer exposes parent Assignee.
- `165` Processing import history and ownership:
  - Adds deterministic immutable Asana system-story Activity import, display-only
    mention mapping for imported comments, and profile mapping for imported
    record/checklist assignees while preserving local completion/assignment.
  - PROD-applied. Subtask/mention support is live. Ronnie decided on 2026-07-17
    not to run the roughly 16,855-row system-story Activity import. Imported
    mention text does not require retroactive profile resolution or highlighting;
    native mentions on newly written Planner comments remain required.
- `166` Processing native attachment upload:
  - Adds append-only operational uploads only under
    `native/<record_id>/<uuid>-<filename>`, metadata registration, and Activity.
    Authenticated users cannot write the Asana-import namespace and have no
    UPDATE/DELETE policy.
  - PROD-applied and browser/static proven.
- `170` Processing detach farm-team cutover:
  - Reissues cattle/sheep detach RPCs with authenticated caller attribution,
    program-authorized `farm_team` access, batch-first lock order, and membership
    revalidation; client and login-gated webform detach paths use the RPCs.
  - PROD-applied and verified. Migration `179` later aligned the remaining
    conflicting lifecycle functions with this lock order.
- `171` Audited user management:
  - Adds deny-all immutable `user_management_audit`, admin-only profile mutation
    RPCs, guarded delete prepare/finalize/reconciliation, and the two-system Auth
    deletion contract used by `rapid-processor` v29.
  - PROD-applied and TEST-proven. Retained operational profile FKs intentionally
    refuse hard delete and direct admins to deactivate. The real Edge proof and
    whole-modal mutation serialization are complete; migration `183` closes the
    later create/reset audit and throttle scope.
- `172` Processing template suite v1:
  - Seeds one canonical Broiler/Cattle/Pig/Sheep template only when a program has
    no template rows and adds checkbox/URL validation to the field engine.
  - PROD-applied. These v1 rows are retained but inactive after `174`.
- `173` Processing conversation media:
  - Atomically links imported Asana media to immutable imported comments and the
    Processing attachment index with original author/time and idempotent storage
    provenance.
  - PROD-applied; 8 files are live in `processing-attachments`, including the two
    B-26-04 Brian Naide JPG posts. Idempotent rerun wrote no duplicates.
- `174` Processing template suite v2 / UI simplification:
  - Fail-closed upgrade from untouched v1 fields, preserving checklists verbatim;
    retires six visible fields and makes Broiler Customer a settings-backed
    single select like Processor. Broiler has 11 fields; other programs have 10.
  - PROD-applied. Active v2 checklist sizes are 8/16/11/16, v1 rows remain
    inactive, and no `processing_records` row was changed.
- `175` Processing planner foundation:
  - Rekeys planner-backed Processing rows to immutable source identity, hardens
    planner-source matching, backfills source phase/ordinal values, and preserves
    source facts as Planner-owned.
  - TEST proof and PROD apply passed before the runtime push.
- `176` Processing lifecycle reconcile:
  - Adds lifecycle reconcile behavior for planned/actual Pig trip promotion,
    source-date removal, worked archive versus empty removal, restore, Chicago
    boundary timing, and fail-closed correction paths.
  - TEST proof used stamped fixture ids after Codex review found and CC fixed a
    collision risk; PROD apply passed with migration file unchanged.
- `177` Processing workflow integration:
  - Adds completion/notification/template-step workflow integration, removes
    Processing subtask dates, normalizes option-list objects, and widens the
    notification check for the new Processing work types.
  - PROD-applied before the runtime push; `processing-asana-sync` was redeployed
    afterward with planned-Pig exclusion live.
- `178` Processing legacy live-weight/title compatibility:
  - Makes Processing record reads tolerate legacy Pig `liveWeights` shapes and
    reissues title synchronization so source batch-name changes flow to
    Processing across all planner programs.
  - PROD-applied atomically with `179`/`180`; the reported legacy record load
    failure and stale source-title behavior are repaired.
- `179` Processing lifecycle lock-order hardening:
  - Reissues the remaining unschedule/delete lifecycle functions with batch-first
    locking, deterministic `ORDER BY id` animal locks, and status revalidation
    while the batch lock is held. Role gates and lifecycle outcomes are unchanged.
  - Concurrency proof completed on TEST; PROD-applied after `178`.
- `180` Pasture direct-move rest/history authority:
  - Makes direct `to_land_area_id` authoritative for current occupancy and direct
    `from_land_area_id` authoritative for departure, rest start, and last grazed.
    Geometric overlap impacts remain advisory and cannot erase a direct stay.
  - PROD-applied and behaviorally verified on FP4D2, FP4D3, and FP4E3.
- `181` Pasture saved-measurement management:
  - Adds the owner-or-management `update_pasture_measurement` RPC for measurement
    name/color edits while retaining the existing owner/management delete gate.
  - PROD-applied after the saved-measurement click/manage client landed.
- `182` Cattle nonempty forecast-batch sequencing:
  - Reconciles forecast-backed cattle Processing batches so zero-cow months do
    not consume a visible batch number and populated months close the sequence
    atomically without disturbing worked records.
  - PROD-applied and behaviorally verified. The empty August row was retired;
    September is `C-26-05`, followed sequentially by October through December.
- `183` User-management audit expansion and reset throttle:
  - Adds admin-only audited profile creation, reset request/outcome ledger RPCs,
    one terminal event per reset request, and a service-role-only HMAC throttle
    table/gate that stores no raw email or IP. It also widens the immutable event
    vocabulary for truthful create/reset evidence.
  - PROD-applied with `psql --single-transaction -v ON_ERROR_STOP=1` and catalog,
    RLS, grant, runtime, delivery, and account-usability verification. The paired
    Edge deploy is `rapid-processor` PROD v31; v30 is the rollback target.
- `185` Processing attachment deletion and comments-only cron contract:
  - Adds admin-only two-phase exact-path Storage
    deletion, attachment tombstones/comment scrubbing and resurrection guards,
    an OFF-by-default comments-import flag, and a postgres-only Vault/pg_net cron
    invoker. Operational native upload remains unchanged. Creates no schedule.
  - PROD-applied and proof-verified. The comments-only flag is enabled and the
    hourly minute-7 schedule is active through Vault.
- `186` Processing pg_net cron delivery timeout/status:
  - Keeps the comments-only invocation contract auditable past pg_net's short
    default response window. PROD-applied after `185`; live cron responses have
    remained HTTP 200 and idempotent.
- `187` Historical Layer retirement dates:
  - Sets evidence-backed `retired_date` values only for `lh-23-01-em2`
    (2026-01-28), `lh-23-01-ls` (2026-01-28), and `lh-23-01-rh23`
    (2024-06-27). Missing rows are safe in non-PROD environments; conflicting
    status/date state fails closed instead of being overwritten.
  - PROD-applied transactionally from the merged-main blob and verified: all
    three target rows remain retired with the exact approved dates.
- `188` Processing carcass-yield source totals:
  - Adds guarded cattle/sheep total live and hanging weight plus actual-Pig
    hanging weight to the Processing source projection and reissues animal-detail
    reads with fail-closed numeric guards. Malformed, blank, zero, and negative
    stored weights cannot throw or fabricate yield.
  - PROD-applied atomically from merged main and verified read-only; the paired
    drawer lane renders source totals/yield without changing planner ownership.
- `189` Newsletter voice example and tone precedence:
  - Adds the bounded admin-only `newsletter_settings.voice_example` style
    reference, makes the legacy `tone` field an optional custom override, and
    reissues the settings/generation-input RPCs without widening the exactly-three
    anon newsletter surface. The writing example is never returned in public,
    preview, archive, or issue payloads.
  - TEST-applied and behaviorally verified by `scripts/apply_test_mig_189.cjs`.
    The lane reported a transactional PROD apply and post-apply verification;
    this wrap independently verified the paired `newsletter-harvest` PROD v7
    deploy but did not re-query the PROD database catalog.
- `190` DR backup database role:
  - Creates `wcf_backup` inert as `NOLOGIN`, with `BYPASSRLS` and membership only
    in `pg_read_all_data`; password/login activation is intentionally out of
    band and never appears in the migration.
  - PROD-applied and then separately activated. A direct login completed a full
    logical dump with 133/133 table-data entries, matched postgres on a populated
    RLS-protected Storage table, and failed a write probe. The credential lives
    only in 1Password and is not yet in GitHub.

Special migration notes:

- `082` is intentionally unused.
- `167`-`169` are intentionally unused; the sequence jumps from Processing
  migration `166` to detach/user-management migrations `170`/`171`, then resumes
  Processing migration work at `172`-`179`; Pasture follows at `180`-`181` and
  cattle forecast-batch reconciliation at `182`. User-management `183` and
  Processing `185`/`186`, Layer correction `187`, Processing yield `188`,
  Newsletter voice/tone migration `189`, and DR read-only role migration `190`
  are live; `184` is
  reserved/not present.
- `083` public webform submitter identity is shelved.
- `085` was applied before `084` in PROD so duplicate active daily identities
  were cleaned up before unique indexes.
- Migration number `061` (an early daily-report soft-delete/restore step) is a
  skipped/superseded number; `067_daily_soft_delete.sql` is the live daily
  soft-delete migration. No `061` file exists in the repo tree/history; if a PROD
  ledger entry for `061` ever matters, confirm it read-only before relying on it.
- New or changed SECDEF RPC return shapes need `NOTIFY pgrst, 'reload schema'`.
- PROD `exec_sql` is forbidden. Preferred PROD SQL apply remains `psql` with
  `ON_ERROR_STOP=1` per [HO.md](HO.md). The 2026-06-24 `139`-`142` release used
  Supabase's linked `db query` path with an explicit `BEGIN`/`COMMIT` wrapper
  because no raw `PROD_DB_URL` was present in the shell.

### Storage Buckets And Media

Known document/photo surfaces are locked by static guards:

- `daily-photos`.
- `task-photos`.
- `task-request-photos`.
- `comment-photos`.
- `equipment-maintenance-docs`.
- `fuel-bills`.
- `cattle-feed-pdfs`.
- `batch-documents`.
- `processing-attachments`.

Newsletter buckets are current PROD infrastructure as of 2026-06-26:
`newsletter-staging` is private/admin-only for uploads and copied planner photos
before approval; `newsletter-public` is public-read/admin-write and receives
only approved newsletter photo bytes.

Processing attachments Storage is current PROD infrastructure as of 2026-07-15:
`processing-attachments` is private; reads require authenticated operational
roles (`farm_team`, `management`, `admin`). Migration `166` permits authenticated
operational INSERT only under the append-only `native/` namespace; the Asana
namespace remains service-role only. Eight Asana conversation-media objects
(about 20.4 MB) remain stored. All 68 ordinary Asana GIDs are indexed, but the 55
stray-workbook rows are tombstoned and their remaining 54 objects were physically
removed by a pinned, verified PROD cleanup. Thirteen legitimate ordinary Asana
files plus one native upload remain live and were unchanged by that operation.
The normal v16 dry run is idempotent at 68 already-known / 0 new; three deleted
cards remain source-404 skips. The Asana template source was corrected and
post-audited, so new cards do not inherit the workbook.

Append-only upload expectations:

- Uploads use `upsert: false` unless a lane explicitly changes the contract.
- Duplicate-object errors are treated as retry success where the upload path is
  idempotent.
- Private buckets use signed URLs; public buckets use public URLs.
- No code should mutate `storage.objects` directly.

### Important Files

- `.github/workflows/dr-backup.yml`, `scripts/dr_backup.cjs`,
  `scripts/dr_inventory.cjs`, `scripts/lib/dr_layout.cjs`, and
  `scripts/lib/dr_orchestrate.cjs`: manual-only DR workflow, streaming encrypted
  database/Storage backup runner, inventory/diff/key/retention rules, and
  behaviorally tested upload orchestration. These are published on `main` in
  commit `b2c3826`; runtime use remains gated by the seven missing Environment
  secrets and explicit workflow approval.
- `supabase-migrations/190_dr_backup_role.sql`: PROD-applied source for the
  activated read-only `wcf_backup` role; password/login activation remains
  deliberately out of band.
- `tests/fixtures.js`, `tests/helpers/appReady.js`, `tests/setup/reset.js`,
  `tests/setup/testAdminIdentity.js`, and the hot scenario seed helpers:
  feature-branch Playwright readiness and fixture-budget ownership. Read Build
  Queue item 2 before modifying; the current branch is not merge-ready.
- `src/main.jsx`: app shell, view routing, auth-gated view rendering, global
  modals.
- `src/lib/routes.js`: canonical route map and aliases.
- `src/dashboard/HomeDashboard.jsx` and `src/dashboard/homeRedesign.css`: Home
  dashboard and scoped Home styling.
- `src/weather/HomeWeatherCard.jsx`: stable first-paint Weather shell and its
  loading/ready/unavailable request state machine.
- `netlify/functions/weather-forecast.js`: serverless Home Weather data owner
  (Open-Meteo proxy with 10-year monthly precipitation history), consumed by the
  Home dashboard Weather card.
- `src/dashboard/ProductionPage.jsx`, `src/lib/production.js`, and
  `src/lib/productionApi.js`: Production reporting page, internal production
  model/reconciliation rules, and data loading.
- `scripts/import_production_legacy_events_from_xlsx.cjs`: spreadsheet backfill
  importer for `production_legacy_events`.
- `src/processing/ProcessingCalendarView.jsx`,
  `src/processing/ProcessingDrawer.jsx`,
  `src/processing/ProcessingTemplatesModal.jsx`,
  `src/processing/ProcessingOptionsModal.jsx`,
  `src/processing/AddMilestoneModal.jsx`, `src/lib/processingApi.js`,
  `src/lib/processingSourceLink.js`,
  `supabase/functions/processing-asana-sync/index.ts`, and
  `supabase/functions/_shared/processingAsanaShape.js`: Processing Calendar
  schedule/drawer/templates/options UI, RPC wrappers, source-link display
  helpers, Edge Asana integration, gated operational import actions, and
  attachment/comment-media ownership. The old reconciliation modal was deleted
  by the UI-simplification lane.
- `supabase-migrations/156_processing_calendar.sql` through
  `166_processing_attachments_upload.sql` and `170_processing_detach_farm_team.sql`
  through `179_processing_lifecycle_lock_order.sql`, plus their committed
  `scripts/apply_test_mig_*.cjs` proofs,
  `scripts/proof_reconciler_blockers.cjs`, and
  `scripts/proof_reconciler_enumeration.cjs`: Processing Calendar schema/RPC,
  reconciler/import, template, conversation-media, option-list, and Storage
  proof lanes.
- `src/auth/UsersModal.jsx`, `src/auth/usersModalMutationLock.js`,
  `src/auth/LoginScreen.jsx`, `src/lib/userManagementApi.js`,
  `scripts/proof_test_user_delete_edge.cjs`,
  `scripts/proof_test_password_reset_hardening.cjs`,
  `supabase-migrations/171_audited_user_management.sql`, and
  `supabase-functions/rapid-processor.ts`: audited admin profile changes,
  guarded two-system Auth hard delete, and password-reset takeover/enumeration
  hardening.
- `src/pasture/PastureMapView.jsx`, `src/pasture/PastureMapCanvas.jsx`,
  `src/pasture/pastureMap.css`, `src/lib/pastureKml.js`,
  `src/lib/pastureGeometry.js`, `src/lib/pastureMapApi.js`, and
  `src/lib/pastureOffline.js`: Pasture Map import/draw/edit/measure, move
  ledger, group records, rotation planning, reports, offline vector queue, field
  tracks, and styling.
- `supabase-migrations/116_pasture_map_land_areas.sql`,
  `127_pasture_map_draw_edit.sql`, `128_pasture_map_move_ledger.sql`,
  `129_pasture_map_planning_reports.sql`, `130_pasture_map_field_tracks.sql`,
  `131_pasture_map_line_style.sql`,
  `132_pasture_map_line_patterns_and_defaults.sql`,
  `135_pasture_map_temp_paddocks.sql`, `136_pasture_map_light_read.sql`,
  `137_pasture_map_pig_paddocks.sql`,
  `139_pasture_map_light_farm_team.sql`, `140_pasture_map_rotations.sql`,
  `141_pasture_map_measurements.sql`, `143_pasture_map_reset_area_history.sql`,
  `147_pasture_map_grazing_entry_delete_and_parent_overlap.sql`,
  `148_pasture_map_group_records_weight_and_planned_move_cleanup.sql`,
  `149_pasture_map_rest_history_reconciliation.sql`,
  `150_pasture_map_open_line_edit.sql`, and
  `152_pasture_map_manager_hard_delete.sql`,
  `155_pasture_map_departure_overlap_rest.sql`,
  `158_pasture_map_positive_overlap_impacts.sql`,
  `180_pasture_direct_rest_history.sql`, and
  `181_pasture_measurement_edit.sql`: Pasture Map schema/RPC lanes
  through group records, rest/history reconciliation, actual-weight grazing
  metrics, open-line edit, manager hard delete, departed-overlap rest, and
  positive-area overlap.
- `scripts/apply_test_mig_127.cjs` through `scripts/apply_test_mig_132.cjs`,
  plus `scripts/apply_test_mig_147.cjs`, `scripts/apply_test_mig_148.cjs`, and
  `scripts/apply_test_mig_150.cjs`: TEST apply/smoke helpers for the Pasture
  Map lanes.
- `src/newsletter/*`, `src/lib/newsletterApi.js`,
  `src/lib/newsletterProductionYoy.js` (+ `supabase/functions/_shared` mirror),
  `tests/newsletter_public.spec.js`,
  `tests/static/newsletter_boundary_static.test.js`,
  `tests/static/newsletter_shared_parity.test.js`,
  `supabase-migrations/144_newsletter_engine.sql`,
  `supabase-migrations/145_newsletter_public_bucket.sql`,
  `supabase-migrations/146_newsletter_automation.sql`,
  `supabase-migrations/151_newsletter_autopilot.sql`,
  `supabase-migrations/153_newsletter_archive_link.sql`,
  `supabase-migrations/189_newsletter_voice_example.sql`,
  `supabase/functions/newsletter-harvest/index.ts`, and
  `scripts/apply_test_mig_144_145.cjs`, `scripts/apply_test_mig_153.cjs`, and
  `scripts/apply_test_mig_189.cjs`:
  Monthly Newsletter public/admin/API, boundary, storage, automation, archive-
  link gating, and the server-side harvest/detector/composer owners on `main`.
- `src/pig/SowsView.jsx`: breeding-pig grouped tables and record pages.
- `src/lib/activityRegistry.js`: client entity registry, labels, and routes.
- `src/lib/activityApi.js` and `src/lib/globalActivityApi.js`: Activity RPC
  clients.
- `src/lib/commentsApi.js` and `src/shared/CommentsSection.jsx`: Comments
  system.
- `src/shared/DataTable.jsx`, `src/shared/DataTable.css`,
  `src/shared/Badge.jsx`, `src/shared/StatusText.jsx`,
  `src/shared/EmptyState.jsx`, `src/shared/OperationalListEmptyState.jsx`,
  `src/shared/SectionBand.jsx`, `src/shared/Toolbar.jsx`, and
  `src/shared/Tabs.jsx`: canonical list/table/status/action primitives.
- `src/lib/programColors.js`: canonical program/species accent palette.
- `src/shared/RecordPageShell.jsx`: shared record-page chrome.
- `src/shared/RecordCollaborationSection.jsx`: Comments + Activity composition.
- `src/shared/RecordActivityLog.jsx`: audit-only record Activity view.
- `src/shared/RecordSequenceNav.jsx`: fixed prev/next record navigation.
- `src/dashboard/homeAlerts.js`: single source of truth for home/Light alert
  builders.
- `src/lib/feedPlanner.js` and `src/lib/feedOrderBasis.js`: feed order math and
  shared calendar-pinned order-month logic.
- `src/lib/cattleNutrition.js` and `src/cattle/CattleHomeView.jsx`: cattle
  nutrition dry-matter, CP/NFC, and herd rolling-window dashboard math.
- `supabase-migrations/182_cattle_nonempty_batch_sequence.sql` and
  `scripts/apply_test_mig_182.cjs`: atomic zero-cow forecast-month removal and
  sequential cattle batch-label reconciliation.
- `src/livestock/WeighInSessionPage.jsx` and
  `src/livestock/LivestockWeighInsView.jsx`: shared weigh-in record/list
  surfaces, including pig table entries and pig Active/Complete session list.
- `src/lib/savedViewsApi.js`: generic saved views on `app_saved_views`.
- `src/lib/csvExport.js` and `src/lib/printExport.js`: CSV and print owners.
- `src/lib/todoApi.js`: To Do List client owner.
- `src/shared/DeleteModal.jsx`, `src/shared/ConfirmModal.jsx`, and
  `src/shared/useModalFocusTrap.js`: modal primitives.
- `src/lib/clientErrorReporting.js`, `src/admin/ClientErrorsView.jsx`, and
  `src/webforms/WebformsAdminView.jsx`: runtime error capture plus the reusable
  Client Errors panel and its Admin-tab owner.

### Route Ownership

- `src/lib/routes.js` owns canonical paths and legacy aliases.
- `src/lib/activityRegistry.js` owns entity-to-record routes for Activity and
  notifications.
- `main.jsx` adapts URLs into view state. Do not add separate alias maps in
  views.

### Authentication And Roles

- Ronnie remains final gate owner.
- App roles include `admin`, `management`, `farm_team`, `equipment_tech`,
  `light`, and `inactive`.
- Runtime permission decisions must be enforced by RLS/RPCs, not just hidden UI.
- Report/form submission is login-required. The session user is the submitter;
  `owner_profile_id` is stamped server-side and client-supplied profile IDs are
  not trusted.
- Light allowlist excludes `/production`, `/weighins`, program dashboards,
  `/fleet`, `/activity`, `/admin`, and client-error review. `/pasture-map` is
  allowed for Light with pasture farm-team-level Map/Field working controls;
  runtime permission is enforced by RPC/RLS, not only by the client allowlist.
- UsersModal mutations are globally serialized for the modal lifetime. While a
  mutation is pending, row/global mutation controls and the close button are
  disabled and backdrop close is ignored; closing/reopening must not create a
  second lock while the first request is active. Controls and normal close
  behavior return after settlement, including failure.
- Public password reset is enumeration-safe: missing/blank/unknown/existing
  emails and authenticated non-admin callers receive the same generic success
  response. `test_to` is ignored, reset delivery may target only the account
  email resolved by Auth, and the removed `user_welcome` branch must not return.
  Admin callers may receive truthful operational errors. Migration `183` records
  the request separately from its delivery outcome, enforces one terminal per
  request, and gives the anonymous path service-role-only HMAC email/global
  throttles without storing raw email or IP. Report-email execution fails closed
  to its role allowlist.

---

## Design System

### Typography

- Canonical font family: self-hosted `Hanken Grotesk`.
- Canonical font-size set: `10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 26`.
- Allowed display sizes: `32, 34, 36, 48, 56`.
- Canonical shared-component font-weight scale: `400, 500, 600, 700`.

### Color Hierarchy

- Ordinary main text uses pure black (`#000000`): primary section/card/row
  titles, labels, buttons, and primary animal or production numbers.
- Supporting text uses muted gray: helper copy, subtext, metadata, secondary
  labels, and non-primary category labels.
- Intentional accent/semantic text remains allowed where color carries meaning:
  warning/error/success/info states, weather rain/freeze cues, overdue labels,
  and text inside approved semantic pastel blocks.
- A text-color cleanup must be typography-only unless the build explicitly says
  it is redesigning the affected block's background.
- CP0 section A12 program-accent discipline: the locked program palette (pig `#2B4C9B`,
  broiler `#C7920A`, layer `#D2601A`, cattle `#8E3328`, sheep `#4CA035`,
  equip/admin `#6B7280`) may appear ONLY on (a) the selected nav/tab pill, (b) a
  small dot in mixed lists, (c) optionally one headline figure, and (d) the
  primary/brand button via per-program `--brand` re-tint. (d) is a ratified
  extension of A12.1's permitted-uses list, decided 2026-06-17. Program color is
  never general body text, stat numbers, card backgrounds, left-border accents,
  or a status-color override. Species/group/herd/breed names render as dot +
  black label, not colored text. The dark-green top-bar chrome stays green.

### Spacing And Controls

- Standard button pad is `10px 16px`.
- Standard button vertical pad is `10px`.
- Inputs/selects/textareas use radius `10` (`--radius-sm`, CP0 section A3), border
  `1px var(--border-strong)`, pad `8px 11px`, and brand focus treatment.

### Radius

- CP0 section A3: 10px is the floor for real UI controls. Canonical radius tokens are
  `10`, `12`, `14`, `999` (pill), and `'50%'` (circle); `0` is allowed for
  intentionally square edges. The values `4`-`9` are retired on real UI.
- Genuinely decorative sub-components (legend swatches, accent/LED bars, progress
  bars, dividers, inline-code chips, small color dots) keep a sub-10 radius ONLY
  on a line tagged with the `radius-allow` marker; the floor guard fails any
  untagged sub-10 radius.
- Scope exemptions: the `.home` island (`homeRedesign.css`) keeps `9/12/18`; the
  public `#webform-container` island owns its CP5-local radius/token set in the
  HTML shell CSS and stays intentionally separate from React app tokens.
- New sub-10px control/card/row radii require a Ronnie-approved amendment and a
  matching guard update.
- Guards: `radius_floor_static.test.js` (floor + allowlist) and
  `design_token_contract_static.test.js` (canonical set on locked primitives).

### Stacking And Elevation

- Dialog layer order keeps Confirm/Delete at toast `9000`; other overlays and
  modals remain below that tier in the shared z-index ladder.
- Header stacking contract: the sticky header bar establishes a stacking
  context, so its hamburger and notifications dropdowns portal to
  `document.body` at z-index `9000` (above page content such as the Pasture map
  chrome, below the blocking-modal tier). Do not rely on raising the bar's own
  z-index — that would regress the `500`-tier page modals.

### Save Model

- Explicit Save/Submit by surface class is mandatory for submit-style flows.
- Autosave is mandatory for edit-in-place flows.

### Canonical Components

- Use canonical role owners before introducing equivalent alternatives.
- Canonical owners include `RecordPageShell`, `RecordSequenceNav`,
  `recordPageControls`, `DeleteModal`, `ConfirmModal`, `InlineNotice`, and
  record collaboration primitives.
- Canonical list/data owners include `DataTable`, `Badge`, `StatusText`,
  `EmptyState`, `OperationalListEmptyState`, `SectionBand`, `Toolbar`, `Tabs`,
  and `programColors`.
- `DataTable` is the default owner for row-comparable list surfaces. It owns the
  real table, mobile stacked row, load/error/empty, Active/Complete band, and
  keyboard row-open behavior.

---

## Load-Bearing Contracts

### Cross-App Rules

- Do not bypass RLS with client-side assumptions.
- Do not add browser secrets beyond approved `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, and approved dev/test flags.
- Do not create new Supabase clients outside `src/lib/supabase.js`.
- Do not use raw browser `alert`/`confirm`/`prompt` in product surfaces.
- Do not add route aliases outside `src/lib/routes.js`.
- Do not edit docs during normal build/hotfix lanes unless Ronnie explicitly
  asks for docs or wrap work.

### Cold-Boot And Fail-Closed Loading

Data surfaces must fail closed on load errors:

- Record pages render in this order: loading -> loadError -> not-found -> record.
- List/hub surfaces expose `data-<surface>-loaded` markers and gate rows/empty
  states behind `!loadError`.
- Load failures clear stale rows/state, show `InlineNotice`, and should provide a
  user-gated Retry.
- Sidecar reads may degrade best-effort only when the primary record/list load
  is valid.
- Header badge counts soft-fail; Header panel content fails closed.
- Home Weather renders its collapsed shell on the dashboard's first paint. The
  same button node persists through loading, ready, and unavailable states;
  loading clicks are inert, Retry/Refresh are single-flight, and refresh failure
  retains the last valid forecast.

### Activity, Comments, Mentions, Notifications

- Activity is audit/system history. Comments are user discussion.
- Runtime Activity access goes through SECDEF RPCs: `list_activity_events`,
  `list_global_activity`, `record_activity_event`, and domain-specific SECDEF
  RPCs that insert `activity_events`.
- No direct client `.from('activity_events')`, `.from('activity_mentions')`,
  `.from('comments')`, or `.from('comment_edits')`.
- Legacy Activity composer/count RPCs remain retired; do not use them.
- `RecordActivityLog` filters `comment.posted` and shows audit only.
- `CommentsSection` owns discussion, attachments, edit history, soft delete, and
  mentions.
- Mention bodies stay human-readable `@Name`; UUIDs do not appear in body text.
- Mention notifications route to the operational record page and target comment.
- Valid notification types: `task_completed`, `mention`, `comment_mention`,
  `todo_completion_approved`, `todo_completion_rejected`, `todo_converted`, and
  `todo_completion_submitted`.
- Notification writes happen inside SECDEF paths; client code must not insert or
  delete notifications.

### Activity Entity Additions

A new Activity entity requires all of this:

- SQL `_activity_can_read` branch.
- `activityRegistry` entry.
- Route/deep-link mapping.
- Permission and existence semantics.
- Record or workflow surface.
- Static test coverage.
- Activity/event logging strategy.

Workflow/worktable entities:

- `cattle.forecast` uses entity_id `cattle-forecast`; Forecast month bucket logs
  filter by `payload.month_key`.
- `cattle.breeding` uses entity_id `cattle-breeding`.
- These are table/workflow audit streams and are program-gated rather than
  row-existence gated.

### Entity Mutations And Audit Atomicity

- `runMutation` is for routine client-side mutations with best-effort Activity.
- `runMutation` must not know table names or business rules.
- `runMutation` is not transactional.
- Audit-critical delete/restore/transfer/status flows should move to SECDEF RPCs
  that mutate data and insert Activity in one transaction.
- Mutation inventory counts live in
  `mutation_semantics_inventory_static.test.js`.

### Delete, Restore, And Recovery

- Hard-delete owner inventory lives in `hard_delete_owner_static.test.js`.
- Soft-delete protected roots must not have direct client deletes: cattle,
  sheep, `cattle_dailys`, `sheep_dailys`, `poultry_dailys`, `layer_dailys`,
  `egg_dailys`, `pig_dailys`.
- Daily reports soft-delete through `soft_delete_daily_report` and restore
  through `restore_daily_report`.
- Cattle/sheep animals soft-delete/restore through their animal RPCs.
- Calving sub-row delete goes through `delete_cattle_calving_record`.

### Production

- Production means processed animals and eggs, not current inventory.
- There is no combined production total. Home and `/production` display per-
  program totals only.
- `/production` is a production reporting surface, not an import reconciliation
  workspace. Visible page language should be totals/events by program and year;
  do not expose Planner-vs-backfill/source-split/audit framing in the primary
  page.
- Production sources:
  - Broilers from `app_store.ppp-v4` processed/auto-processed batches.
  - Pigs from `app_store.ppp-feeders-v1.processingTrips`.
  - Cattle from `cattle_processing_batches.actual_process_date`.
  - Sheep from `sheep_processing_batches.actual_process_date`.
  - Eggs from `egg_dailys` counts, displayed as dozens.
  - Legacy backfill from `production_legacy_events`.
- Internal reconciliation: Planner wins by program/year coverage. If Planner has
  events for a program/year, Planner is the counted total and every legacy row
  for that same program/year is held out internally, including rows that
  represent the same batch dated differently. If Planner has no events for a
  program/year, legacy rows count as historical backfill.
- `/production` must not display Podio terminology, Raw-Podio columns, or
  delta-vs-Podio columns. It also must not display a visible Reconciliation tab,
  Legacy/Audit Review panel, source split, Held out, or Conflict columns.
- YoY is per program/year, not across programs.
- Summary is an all-years Program x Year matrix. Production Events show actual
  processing events only: no egg-day rows, no year picker, and imported legacy
  rows remain visible even when held out of Summary totals by the Planner-wins
  coverage rule.
- Processing events should link to record pages when a matching planner record
  can be confidently resolved, including broiler batch links by date/count.
- Light users are excluded by route allowlist and RPC role gate.

### Processing Calendar

- Processing Calendar is distinct from the existing `/production` reporting
  page. `/processing` is the workflow/schedule/record surface for processing
  batches, milestones, comments, attachments, custom fields, and subtasks.
  `/production` remains the processed-output reporting surface.
- Processing is now planner-first. Planner-backed rows own live batch facts
  (date/count/status/source identity). Asana can seed processor/customer only on
  first attach if blank, imports artifacts/history/drift one-way, and must never
  overwrite Planner-owned live facts after a match.
- Processing titles remain synchronized to the live source batch name for every
  planner program. Legacy Pig source reads must accept both current and historic
  `liveWeights` shapes instead of failing the entire record response.
- Selected-year summary totals are program-specific completed-animal counts for
  Broilers, Cattle, Lambs, and Pigs; there is no combined cross-species head
  count. Milestones count in neither program chips nor batch counts. Section
  headers may disclose milestone counts separately without calling them batches.
- Cattle planned batches render in one planned section. Their batch page and
  Processing drawer consume the same projected roster identity, tag, projected
  live weight, and exact planned-processing-date age. Missing/invalid/future DOB
  renders `Not recorded`; a month-only forecast must not invent an exact age.
- Planner-to-Processing reconciliation is first-class. Broiler rows require a
  Planner processing date; Pig persisted planned trips immediately create/update
  Processing records by stable planned-trip identity, then promote to actual trip
  identity without losing processor, subtasks, completion state, comments,
  attachments, or history. Stale empty planner rows are removed; worked rows are
  archived by reconcile and unarchived if the source returns.
- The main Processing table must stay batch-focused. Subtasks are not a table
  column; they belong in the record drawer/artifact model. The Batch/title
  column is sticky in the horizontal table. Historical import, reconciliation,
  and maintenance controls are intentionally absent from the day-to-day UI.
  Admins get a direct Templates button and a single global Add milestone button;
  archived/cancelled rows are not exposed through a day-to-day Show archived
  checkbox.
- Parent-record Assignee and visible Time-on-Farm are retired from the Processing
  UI. Checklist/subtask assignees remain supported. The server may still return
  backward-compatible `time_on_farm_days`, but it is not a default template or
  drawer field.
- Customer and Processor selector options are server-backed Processing settings.
  Both are true single selects; Customer stores zero-or-one value in its legacy
  array-backed record column. Admins edit choices inside Templates through
  `set_processing_option_list`; add/rename/deactivate/reactivate/undo edits
  autosave after a 500 ms debounce, and every editor exit flushes pending work.
  A failed flush keeps the editor open with its draft intact. Stored off-list
  values remain visible and old multi-customer rows show one explicit legacy
  state until deliberately replaced.
- Templates are local-only in the product UI. The active canonical v2 suite is
  Broiler 11 fields and Cattle/Pig/Sheep 10 fields, with checklists 8/16/11/16.
  The template modal uses a Tasks/Fields toggle; Fields edit inline rather than
  opening a second modal. The six retired field ids stay server-reserved so
  generic writes cannot revive them. Template saves version active rows; reset
  uses the same guarded defaults as migration `174`.
- Checklist completion toggles are dedicated optimistic mutations, not generic
  drawer reloads. The clicked checkbox changes in place, the drawer silently
  refetches server-authoritative completion blockers, and the schedule patches
  only confirmed `subtask_done`/`subtask_total` counts. Failed writes roll back
  without refreshing either surface; pending writes on different subtasks may
  overlap without publishing an unconfirmed neighbour count. Processor and
  Customer remain editable above Source details and must not be duplicated as
  read-only source rows.
- Processor, Customer, and checklist-assignee selects save quietly in place. A
  successful selection must not refresh/remount the schedule or drawer.
- Program sections render Sheep before Pig. Within the Pig table, Batch precedes
  Trip.
- Pig drawer identity is `<batch> · <trip>`; do not prepend `Pig Trip` or repeat
  a standalone Trip source row. Pig roster rows may show the trip-owned canonical
  Boar/Gilt value, but the standalone Sex FieldRow remains removed. Missing or
  conflicting sex is `Not recorded`, never inferred.
- Cattle, sheep, and Pig Source details show source-owned Total live weight,
  Hanging weight, and Carcass yield immediately after the count/age facts when
  valid. Yield is `hanging / live * 100`; strict positive finite plain-decimal
  inputs only. Malformed, formatted-with-commas, blank, zero, negative, NaN, or
  infinite values are excluded and all-missing output is `Not recorded` without
  a percent sign. Processing remains read-only for these planner facts.
- Processing lifecycle RPCs use one compatible batch-first lock order, then
  deterministic animal-row locks with membership/status revalidation under the
  batch lock. Do not reintroduce animal-first delete/unschedule paths.
- Asana operations are out-of-UI gated operations. Planner freshness still runs
  automatically, and the hourly minute-7 schedule is pinned to comments-only
  sync through Vault/pg_net. Read-only audits/dry runs and
  `asana_sync_enabled` cutover require explicit operational approval; removal of
  the UI controls is not permission to run them. Historical Activity will not
  be imported. Subtasks, comments, conversation media, and ordinary attachment
  backfill are complete.
- Processing attachment files live in private `processing-attachments` Storage.
  Reads require operational authenticated roles. Native uploads are append-only
  under `native/`; Asana imports are service-role only. Eight conversation-media
  files remain live; ordinary Asana GIDs include live attachments and preserved
  deletion tombstones. Asana object paths are filename-independent, and stored
  GIDs are skipped before any download/upload; the final dry run found 0 new
  attachments. Operational roles
  can upload by picker or accessible multi-file drag/drop. Only admins can
  delete; deletion uses the live two-phase exact-path physical/tombstone contract
  and imported tombstones prevent resurrection on later syncs.
- Processing Calendar status vocabulary is exactly `Planned`, `In Process`,
  and `Complete`, rendered from the server-derived `effective_status`
  (migration `176`): a record stays Planned until its processing date begins in
  America/Chicago, reads In Process automatically from that date (or whenever
  an actual Pig trip exists, regardless of date), and becomes Complete only
  through the explicit Mark complete action once the server-side blockers pass
  (date begun, Processor selected, live source Count > 0, every subtask
  completed or removed). Stored statuses are normalized to the same three
  values and the planner reconcile never copies raw native program statuses
  into Processing. `src/lib/processingStatusDisplay.js` still maps raw/legacy
  values for display, and Pig BATCH pages (not `/processing`) keep the
  pig-specific helper because raw `active` can mean either a future zero-head
  placeholder (`Planned`) or pigs already in the feeder workflow
  (`In Process`).
- Processing schedule rows sort by `processing_date` inside each program section
  regardless of status. Do not reintroduce an In Process / Planned / Complete
  display bucket; completed rows must stay in their natural schedule slot.
- The Asana token is a live secret and must not be committed, pasted into docs,
  or stored in source. The deployed Edge Function reads it from Supabase secrets.
  It is currently SET on the PROD Edge secret (the dry-run + comments lanes
  proved live connectivity); redeploying the Edge does not re-set it.
- Existing CP0/design-system contracts apply. Do not copy prototype styles that
  conflict with true-black text, radius floor, closed badge set, table hover,
  row-lift openable affordance, or program-accent rules unless Ronnie approves
  a Constitution amendment.

### Monthly Newsletter

- Current shipped scope is Newsletter Autopilot + the direction-first redesign +
  editorial steering + archive-link gating: link-gated public archive + admin editor, migrations
  `144`/`145` (data/storage/public boundary), `146` (automation/run logging/cron
  RPC support), `151` (Autopilot settings/source coverage/photo plan/past-issue
  context), `153` (archive-link gating), `189` (private writing example + tone
  precedence), and the `newsletter-harvest` Edge Function (PROD v7 / TEST v2 as
  directly checked 2026-07-20). Autopilot gathers planner facts first, lets Ronnie
  steer facts/Q&A/tone/length/writing example, writes or revises with AI/template composer,
  generates a photo plan, supports private upload + approval + place planned
  photos, previews, and publishes. The real AI path is enabled in PROD through the
  PROD-only `NEWSLETTER_AI_API_KEY` Edge Function secret; TEST is intentionally
  not configured with that key.
- Before Write/Revise, required unsaved style settings must save successfully;
  failure blocks generation, preserves edits for retry, and marks the save
  failed. The writing example is style reference only; facts are never reused
  from it. Helper copy distinguishes AI-ready, template, and unknown states.
- UI: the admin (`/admin/newsletter`) and public (`/newsletter`) surfaces follow
  the direction-first redesign (PR #54), built on the app's design tokens +
  shared primitives. Admin = a "this month" spotlight + section-banded openable
  tiles (list), a 7-step tracker (Facts · Steer · Draft · Revise · Photos ·
  Review · Publish) over step cards + a 312px utility rail (editor), and a grouped
  in-view Settings sub-surface (no route alias). Public = an editorial masthead,
  hover-lift archive cards, an issue page with numbers strip + reading time +
  sign-off + "More issues". The draft stays AI-owned (read-only blocks, revise-in-
  place, guarded rewrite).
- ACCESS (migration `153`, PR #59): the public archive is LINK-GATED, not open.
  `/newsletter`, `/newsletter/latest`, and issue slugs require a current,
  unexpired `?key=` (one shared archive access token in `newsletter_settings`
  that unlocks the new issue + all past issues). Publish mints a fresh 7-day key;
  the admin "Public link" card (Copy/Regenerate) rotates it on demand (instant
  revoke when someone leaves). A missing/invalid/expired key shows a "link
  expired" lock screen. The goal is that former staff can never keep a working
  link. Admins always read every issue via the authed admin RPCs regardless of
  the public key state. The draft preview (`?preview=<token>`) is a SEPARATE path
  with its own 30-day token and is unchanged by `153`.
- Public issue pages must be `noindex`; this is an invariant, not a setting admins
  can accidentally drift.
- Admin creation/editing lives inside the planner and is admin-only. The public
  reader surface is web-only; no PDF, email send, RSS, or reader login is part
  of the current requirement.
- The newsletter audience is informed: owners, the farm team, and other family
  staff who interact with the farm. The voice is warm, restrained, factual, and
  team-centric (`we`), using Ronnie's supplied writing example rather than a
  generic AI farm voice. The issue brand/title is simply `White Creek Farm`;
  prefer a shorter issue Ronnie can review in 10-15 minutes over a fixed page
  count. The first issue targets July coverage and an August 5 release.
- Content should prove growth/development, effectiveness, and what is distinctive
  about the farm through prior-month facts: animals on farm, births, notable
  processing/production/yield records, completed projects plus why they matter,
  and focused difficulties the team overcame. Do not include finances or
  mortalities, and do not publish fragile future timelines. First names of team
  members are OK; avoid sensitive/private details and never expose private file
  paths. If Animals on Farm is featured, it is a separate program story and
  never a combined all-species Total.
- Fact accuracy mirrors the app's canonical logic (PR #50/#55). Broilers "brought
  to processing" counts `totalToProcessor` (NOT the unpopulated processed-count
  fields), windows on the brought date (`processingDate − 1`, since a batch goes
  to the processor the day before its processing date), and falls back to
  projected live birds (`birdCountActual − mortalityCumulative`) for a batch
  brought-but-not-yet-tallied (self-corrects once `totalToProcessor` is entered).
- Year-over-year production: the harvest appends a deterministic
  "Production — year over year" stats section (exact, never AI-authored) to every
  draft — full-year vs prior-full-year for all five Production-tab programs
  (cattle/broilers/pigs/sheep/eggs), mirroring the tab's per-program quantity
  rules + Planner-wins-by-coverage (legacy backfills only program-years with no
  Planner data); eggs shown in dozens. Logic lives in the parity-locked
  `newsletterProductionYoy.js` (src/lib + `_shared` mirror); a strip-then-reappend
  keeps it from duplicating on revise.
- Year over year is the preferred comparison. Year to date and up to three years
  may be shown for cattle, broilers, pigs, sheep, and eggs when genuinely
  comparable data exists; missing periods are unavailable, never zero. Any real
  increase can be noteworthy, but every number must be source-verified.
- The monthly workflow is minimum-human-input but Ronnie-directed:
  gather this month's facts from planner sources without AI, let Ronnie select/
  add facts and answer Monthly Q&A, then AI writes a draft and photo shot-list.
  Revisions should edit the current draft in place. Photo requests should be
  generated from what is noteworthy; admins can add/remove suggestions and must
  approve photos before publication. Every issue should have at least a few
  photos.
- AI generation must stay inside the planner via a fixed prompt/template in the
  API/Edge Function setup. The model returns structured blocks only; the
  renderer whitelists block types and never renders raw AI HTML. Ronnie remains
  the final editorial approver.
- Data boundary: newsletter tables are deny-all RLS and exposed only through
  narrow SECURITY DEFINER RPCs. The anon surface is exactly three RPCs — published
  list, published issue, and token-gated preview. As of migration `153` the
  published list + published issue are additionally ARCHIVE-KEY-GATED (they take
  `p_key` and return NULL unless it matches the current, unexpired
  `archive_access_token`, constant-time compare via `_newsletter_archive_key_ok`);
  the preview RPC keeps its own draft token. Public and preview payloads expose
  approved photo paths only; draft facts, intake, runs, settings, and private
  source paths stay admin-only. The harvest detectors + draft composer run
  server-side inside `newsletter-harvest` (so detector/composer changes require an
  Edge Function redeploy).
- Photo boundary: uploads/copies start in private `newsletter-staging`. Approval
  copies bytes to public `newsletter-public`; unapproval deletes the public copy.
  A photo row being present or suggested is not public consent.
- Monthly operating target: a named helper receives a concrete source/photo
  checklist and returns it by the 1st; Ronnie reviews/publishes by the 5th. The
  published link rotates/expires after 7 days and is distributed in the group
  chat. No issue has yet been published, and monthly automation remains off.
- Preview boundary: preview links require `preview_enabled=true`, a matching
  token, and an unexpired `preview_expires_at`. Publish rotates/disables preview
  links so a pre-publication URL cannot expose later draft edits.

### Pasture Map

- Pasture Map architecture is provider-neutral: GeoJSON/PostGIS owns geometry;
  Leaflet renders the client map; OnX KML and drawn polygons are input sources;
  Google is not the geometry source.
- `land_areas` is the single self-referencing land model. It can represent
  pasture > paddock and feeder-pig area > section > paddock.
- Geometry history is append-only in `land_area_geometry_versions`; editing a
  boundary writes a new version instead of mutating history.
- Species is decoupled from land. `designation` is only a hint; animal-group
  occupancy belongs to dated move events in `pasture_move_events`.
- Imported/drawn land starts `baseline_no_history=true`; no fake last-grazed
  date is seeded.
- LineStrings are outline candidates and require human close/validation. Never
  auto-close an OnX LineString. In the UI these are called Tracks / Lines and
  are draft geometry only: no acreage, no move destination, no direct permanent
  promotion. Management/admin can reshape an existing saved Track/Line in place
  through `update_land_area_track`; this is line-only, outline-candidate-only,
  and does not write acreage, promotion, or geometry-version history.
- Computed acreage is geodesic and the UI shows it read-only. OnX/raw/manual
  acreage can exist as cross-check data, but the normal editing path must not
  ask users to type acreage or rest days.
- Draw/edit controls use Leaflet-Geoman. Snapping, live area/perimeter measure,
  Escape exit, and client self-intersection warnings are UI requirements; the
  migration `127` RPC validity gates are the database backstop. Measure remains
  transient until the user explicitly saves it as a `pasture_measurements` row;
  a measurement must never persist as a land area/track/temp paddock.
- Planner groups are derived, not user-entered. Canonical move/planning keys are:
  cattle herds -> `animal_type='cattle_herd'`, `group_key=herd`; sheep flocks ->
  `animal_type='sheep_flock'`, `group_key=flock`; breeder pigs ->
  `animal_type='breeder_pigs'`, `group_key='sow-1'|'sow-2'|'sow-3'|'boars'`;
  feeder pigs -> `animal_type='feeder_pigs'`, `group_key=sub.id`.
- Access: `farm_team`, `management`, `admin` can read/view/measure and use the
  Map working controls. Management/admin own permanent area import/classify/
  close/draw/edit, Tracks / Lines cleanup, promotion, and permanent-area
  lifecycle actions. Farm-team can record moves through the group record move
  box and create/edit/archive their own temp paddocks/tracks through migration
  `135`.
  `equipment_tech` and inactive users are excluded. Light is pasture farm-team-
  level through migration `139`: Light keeps the farm-team Map/Field working
  controls and is NOT read-only/Map-only; only management/admin-only actions stay
  gated, and write/report RPCs reject roles outside the granted set.
- Current Pasture Map tabs are Map / Field / Reports. Plan is folded into Map;
  Setup was already removed. Map is the single working surface: hover/tap reads
  a name + type/acres-only bubble (no rest/grazing state, occupant, or
  last-moved line); clicking a map area opens the accessible Area MODAL
  (`PastureAreaModal.jsx`:
  role=dialog, aria-modal, focus trap, backdrop) which hosts the same canonical
  Area Record body used by Reports: area summary, explicit name editor, Grazing
  History, and role-gated management/config controls (classification, parent
  pasture, line style, redraw, archive/restore, admin hard-delete). There is NO
  move form in the modal. The modal has one close affordance, the upper-right
  `X`, and it debounces/saves review edits on close. Area name editing is
  explicit Edit -> Save/Cancel with Enter-to-save and Escape-to-cancel; do not
  reintroduce blur-save naming.
  The slim side panel holds Animal Groups pop-out openable tiles, not flat
  tables. A group tile opens an inline group record beside the map, not a modal.
  The record order is group details, chip-based rotation editor, current->next
  move box with date/time and optional actual group weight, then grazing
  history. The rotation editor owns future planning; the old planned-move
  table/RPCs and free-form Record/Plan forms are removed. Tracks / Lines, the
  classification/review queue, and archived recovery are collapsed sections in
  Reports. Reviewed permanent paddocks require a parent pasture (UI-enforced via
  `update_land_area` `p_parent_id`; no DB constraint, no auto-backfill);
  parentless paddocks surface in a Reports "Needs pasture assignment" section.
  Field is phone-first execution/offline queue. The Field bottom toolbar is
  Walk paddock / Draw temp paddock / Measure only. On mobile the Field layout
  must fit that absolute bottom toolbar inside the viewport instead of inheriting
  the generic 900px stacked-layout minimum; regression proof checks 390x844 and
  360x800 before any click or Playwright auto-scroll. One-time setup/help lives in a
  secondary "Offline setup" status-row affordance (offline NAIP imagery
  download + the self-contained field guide) and saved measurements in a
  secondary "Saved measurements" toggle; the rail base/overlay popover stays available
  in Field. The field guide is served from `public/pasture-map-field-guide.html`
  (self-contained, inline images); `public/sw.js` serves an exact runtime-cached
  navigation before the SPA shell fallback so the guide works offline after one
  online open; `ensurePersistentStorage()` requests persistent storage on mount.
  A temp paddock drawn from the rotation editor stays saveable while the inline
  group record is open. Reports use pop-out openable
  tiles for Areas and Animal Groups; opening an Area renders the same canonical
  Area Record body. Reports also include animal-group grazing stays/metrics,
  inactive groups behind an Include inactive groups filter, and per-stay delete.
  Track/Line records hide grazing history, state, acreage, and rested-day rows.
  Light is pasture farm-team-level on the merged Map and Field.
- Map chrome is one right-side icon rail: Fit Farm, My Location, base/overlay,
  and Legend. The base/overlay control is a popover containing Satellite/Topo base map selection plus
  Pastures/Paddocks/Temp/Lines overlay toggles. Legend is a separate popover,
  mutually exclusive with the base/overlay popover. Hybrid basemap and hybrid reference/transport
  overlay code are removed. Zoom is scroll-wheel/pinch only; Leaflet default
  zoom controls and custom rail +/- buttons are intentionally absent.
- Move ledger / coloring contract: an area's occupancy/rest state is
  read-derived in `_land_area_summary`, not stored on `land_areas`. Migration
  `180` makes the direct move links authoritative: `to_land_area_id` owns current
  occupancy, and `from_land_area_id` owns departure, rest start, and last grazed.
  `pasture_move_impacts` overlap rows remain advisory for geometric context and
  current occupants; they cannot override a direct stay or fabricate a newer
  rest/history boundary. Migration `147` suppresses direct-child overlap impacts
  when deriving parent-pasture state, and migration `149` ignores orphan impacts
  whose move event has lost its directional link. A permanent paddock's
  bright-green stroke is a LOCKED designation color, independent of state; the
  FILL is the state.
- Boundary visibility toggles hide/show pasture, paddock, temp-paddock, or
  Lines/Tracks strokes only. Animal occupancy fills and group markers remain
  visible. A group's occupied-area marker is a teardrop location pin in the
  group color with a "Name · count" label (no initials avatar); rotation stops
  are numbered dots, and the number at the group's current area is suppressed so
  it does not stack under the pin. Draft lines render on the working Map; Field
  has a Draft lines toggle; selected draft lines show for context.
- Permanent pasture stroke is locked blue 4px; permanent paddock stroke is
  locked bright green 4px. Temp paddocks default to white dashed 5px and can be
  restyled. Only temp paddocks and GPS/field tracks have editable line style.
- Open-line edit is built. Entry points are the Area modal and Reports
  Tracks/Lines list. It routes through `update_land_area_track`, preserves
  Tracks/Lines draft semantics, and must not be broadened to polygon boundary
  edit or promotion without a new scoped migration/guard.
- Tracks/Lines and saved measurements use transparent 24px stroke hit targets so
  thin visible lines remain clickable without changing their appearance. Saved
  measurements open their own modal; the creator or management/admin can rename,
  recolor, or delete them through the measurement RPC boundary. Hit layers must
  keep `pointer-events: stroke` so they do not block unrelated map areas.
- Current Pasture Map includes the real-roster redesign, move ledger,
  animal-color occupancy, pop-out openable launch tiles, inline group records,
  chip-based rotation planning, group-record move logging, actual-weight
  grazing metrics, per-stay grazing delete, history/rest/stocking reports,
  offline vector snapshot/queue, offline NAIP imagery cache, GPS field tracks,
  line styling/pattern controls, temp-paddock lifecycle, the single-X Area
  modal, the shared Map/Reports Area Record body, explicit area-name editor,
  open-line edit, and Light pasture farm-team-level Map/Field access. It does
  not include daily-report wiring or a generic undo stack; corrections are
  delete the grazing stay and re-record the move.
- Future Pasture Map lanes should preserve the shipped Map / Field / Reports IA,
  the click-to-open Area modal, the Reports accordion, and the provider-neutral
  geometry/RPC model unless a new Ronnie-approved decision explicitly reopens
  any of them.

### Daily Reports

- Daily reports have dedicated record pages for poultry, layer, egg, pig, cattle,
  and sheep.
- Daily report list surfaces and Home "Last 5 Days" use shared white
  `DailyRecordCards` / `.hoverable-tile` record cards, including the Home-tile
  lift, focus ring, and trailing chevron at every breakpoint.
- All six open directly editable; no edit-mode toggle.
- Daily duplicate prevention is DB-backed for poultry/pig/layer/cattle/sheep by
  partial unique indexes (`084`) after cleanup (`085`); egg duplicate prevention
  is warning/pre-submit only.
- Add Feed quick-log rows are not full daily reports.
- Missed-report checks exclude `source='add_feed_webform'`.
- Daily edits route through `updateDailyReport` / `update_daily_report`.
- Daily deletes route through `soft_delete_daily_report`.
- Light can edit/delete only own rows inside the server-side window.

### Cattle And Sheep

- Cattle and sheep use dedicated Supabase tables, not `app_store`.
- Active cattle herds: `mommas`, `backgrounders`, `finishers`, `bulls`.
- Active sheep flocks: `rams`, `ewes`, `feeders`.
- Outcome states are `processed`, `deceased`, `sold`.
- Cattle Herds default to grouped, collapsible herd tiles when no
  filters/search/non-default sort are active. Any active filter/search/non-default
  sort renders one flat matched-results table through the shared `DataTable`.
  The `Sold` herd filter is flat and sold-only; it must not retain
  Processed/Deceased/Sold group headers. `Last Activity` sort/column reads the
  cattle animal Activity stream through `listActivityEvents`, shows date/time,
  defaults newest-first, and sorts missing activity last.
- Cattle nutrition rolling-window dashboard math must use true dry matter:
  `as-fed pounds * (1 - moisture_pct/100)` for `DM lb/day`; CP and NFC pounds
  use the feed-line nutrition snapshot percentages against that dry matter, not
  raw as-fed pounds.
- Sheep Flocks render a single always-flat list (the grouped/flat view toggle was
  removed). A column/display picker chooses which of the full field set shows;
  `tag` is always shown; the choice persists in saved views (`columnVisible`
  gates `flatColumns`). Outcome flocks stay browsable in
  `SheepCollapsibleOutcomeSections` below the flat list. Do not reintroduce a
  sheep `viewMode` toggle.
- Heifer-to-cow promotion fires from both calving records and calf-row dam links.
- Manual transfer goes through `transfer_cattle_animal` /
  `transfer_sheep_animal`.
- Processing-batch unschedule/delete go through audited SECDEF RPCs
  `unschedule_cattle_processing_batch` / `delete_sheep_processing_batch`.
- Cattle animal records in outcome states show `Age at processing` / `Age at
  sale` / `Age at death` from the terminal event date (processing-batch date,
  sale date, or death date); active herds show current `Age`. Cattle
  processing-batch rows show each cow's age at the batch processing date.
- Scheduled cattle Processing batches expose the same projected roster as the
  cattle batch page: tag, age at the exact planned processing date, and projected
  live weight. Forecast-only month views omit age because they lack an exact date.
- Cattle Log (`/cattle/log`) is a comment-backed program field journal on the
  singleton `cattle.log` entity. It supports keyword search, @mentions, photo
  attachments, offline create replay, issue filters, and #tag mirrors.

### Pig

- Pig feeder group started counts are authoritative.
- Current count is ledger-derived, not persisted `currentCount`.
- `pig.batch` record pages own metadata, sub-batches, mortality, planned trips,
  processing trips, forecast/current/FCR, send-to-trip source display, Comments,
  and Activity.
- Keep pig batch workflow split across `PigBatchPage`, `PigBatchHubTile`,
  `usePigMortality`, `usePigSubBatches`, `usePigPlannedTrips`, and
  `usePigProcessingTrips`.
- `PigContext.feedersLoaded` is the readiness boundary.
- Farm-born feeder batches are created from farrowing cycles, not manually from
  `/pig/batches`.
- Planned-trip row shape stays `{id, date, sex, subBatchId, plannedCount,
  order}`.
- Planned-trip locks live only in `ppp-pig-planned-trip-locks-v1`.
- Planned-trip forecast weights are render-only and based on DOB/farrowing age
  at trip date times Global ADG.
- Processing Pig records use the concise `<batch> · <trip>` drawer title and do
  not repeat Trip as a Source-details field. Canonical trip sex belongs on each
  Pig roster row, not as a standalone Sex field.
- Pig Batches hub rows use the locked 14-column inspection grid and open the
  batch record page.
- Breeding pigs (`/pig/sows`) are grouped table sections. The row is the record
  navigation target. Do not reintroduce the old PigTile/Record-button/modal-only
  workflow.
- Breeding-pig record pages use `pig.breeder` and mount Comments + Activity.
- Pig weigh-in record pages render entries in a dense table, not cards/badges.
  The leftmost column is the send-to-trip checkbox for eligible draft rows;
  sent/transferred rows are locked in-row. Weight/note autosave, prior weight,
  days, delta, ADG, undo send, transfer to breeding, undo transfer, and delete
  remain preserved.
- `/pig/weighins` is a navigation list split into Active and Complete sections.
  Pig list saved views, CSV export, Print, and status filters are intentionally
  removed. Broiler weigh-in lists keep the shared saved-view/export/print/filter
  behavior.

### Broiler, Layers, And Feed Planning

- Broiler batches live in `ppp-v4`.
- Broiler Batches filtering/sort/saved-views and the column/display picker are
  scoped to the PROCESSED table only; active/planned batches stay pinned above
  the controls. Filter/sort semantics live in the pure module
  `src/lib/broilerBatchFilters.js` (processing-date-desc default). Batch
  Comparison was removed - do not reintroduce it.
- Login-gated `/weighins` cannot read or mutate `app_store.ppp-v4` directly.
- Week 4/6 completion uses `stamp_broiler_batch_avg` RPC.
- Broiler batch record Week 4 and Week 6 weight fields are read-only display
  values sourced from completed weigh-ins via `loadBroilerBatchWeekAverages`;
  this is canonical for record display and prevents stale `ppp-v4` cache values
  from showing as "Not recorded."
- `ppp-v4.week4Lbs` / `week6Lbs` remain the mirror used by list/production
  surfaces. Admin/session-page write paths use `writeBroilerBatchAvg` and
  `recomputeBroilerBatchWeekAvg`; real `app_store` read/upsert failures must
  surface as `{ok:false,message}`. True no-data cases may no-op with
  `{ok:true}`.
- Broiler `persist(nb)` in `src/main.jsx` must keep the anonymous weigh-in
  webform mirrors fresh by calling
  `syncWebformConfig(null, null, nb, layerGroups, layerHousings)`.
- B-26-08 wk6 was repaired in PROD after the drift hardening deploy:
  `ppp-v4.week6Lbs` is 5.76 and matches canonical 5.76 from 30 completed
  weigh-in weights.
- Layer `current_count` is the physical anchor; projected count subtracts
  mortalities since anchor. Layer housing record surfaces now label the
  displayed count as live hens and use the projected live count when the raw
  physical anchor is stale/empty but daily-count history provides a valid
  anchor; Eggmobile 3 / `L-25-01` displays 112 live hens from anchor 115 minus
  three mortalities.
- Feed math lives in `src/lib/feedPlanner.js` and `src/lib/feedOrderBasis.js`.
- Feed-order recommendations use the latest active-month physical count when
  present; otherwise they fall back to previous-month estimate.
- Poultry feed-order math is per feed type: starter, grower, layerfeed.
- "Count includes `<month>` order" prevents double-counting the delivery.
- The feed-order board is calendar-pinned. Pig and broiler both show the next
  calendar month order card until the calendar advances; saving the order does
  not advance the visible board to the following month.
- The second feed summary tile for pig and broiler stays pinned to the current
  calendar month estimate via `estTileYM`.
- Broiler on-farm counts are centralized in `computeBroilerOnFarmCounts`.
- Broiler batch status auto-advances in `loadAllData`: planned -> active on/after
  hatch date, active -> processed on/after processing date.

### Tasks

- `/tasks` is canonical. `/my-tasks` and `/admin/tasks` are aliases only.
- Task writes go through v2 wrappers/RPCs.
- Frontend must not call `generate_system_task_instance`; `tasks-cron` is the
  runtime caller for system-task generation.
- System task rules live in `task_system_rules`; assignee and active state stay
  data-driven there, and the cron uses `lead_time_days` as the minting horizon.
- `tasks-cron` is deployed and active in PROD. The deployed function includes
  system-task generation with batch/group entity labels plus To Do approval/
  originator notifications; the daily cron remains `tasks-cron-daily` at
  `0 4 * * *` UTC through `public.invoke_tasks_cron()`.
- Existing open system-generated task titles were backfilled by migration `142`;
  newly generated system tasks get titles in the form
  `<rule name> - <entity label>`.
- `task_instance_photos` is canonical. Legacy single-photo columns are display
  fallback only.
- Task photos are capped at 5 total per task across creation and completion;
  migration `114` is the DB backstop.
- To Do List lives inside Task Center at `/tasks/todo` and `/tasks/todo/<id>`.
- To Do participants are `light`, `farm_team`, `management`, and `admin`;
  `equipment_tech` and inactive are excluded.
- Non-manager To Do completion submissions enter `pending_approval` and notify
  management/admin; approval or auto-approval notifies the To Do creator.

### Equipment

- Logged-in equipment lives under `/fleet`.
- Login-gated equipment checklist/fueling lives under `/equipment`.
- Equipment fueling submissions use `submit_equipment_fueling` RPC.
- After a valid meter reading, one directly expandable Service intervals list
  renders every configured main interval in numeric interval order. Due rows keep
  red prominence, a Due badge, and automatic expansion at their numeric position;
  non-due rows stay neutral/collapsed and show next milestone plus remaining
  hours/km. There is no nested Other/View-all control.
- Early full/partial service uses the same task keys, completion payload,
  nearest-milestone math, divisor propagation, and offline replay as due service.
  Collapse never clears state; machine changes and Log Another clear equipment-
  scoped ticks/expansion/photos so work cannot leak into another record.
- The fueling form's icon + `WCF Planner` title is one keyboard-accessible real
  `/` anchor on active, synced, and queued screens; `Fueling Log` remains plain
  text and Back continues to return to the Equipment hub.
- Light My Submissions edits/deletes its own equipment fuelings and fuel
  supplies through ownership RPCs.
- Fuel-log edit/delete paths recompute current readings from remaining fuel logs.
- Equipment checklist/material edits must not reload, lose focus, or reorder list
  items on click/edit.
- Equipment record Prev/Next navigation keeps the meter panel mounted, so every
  per-machine sync success/error notice must clear when `equipment.id` changes;
  never display one machine's reading on its neighbour.
- Home `Materials Needed` service groups must remain stable when a material is
  cleared; clearing one item must not reorder later interval groups or move them
  to the bottom of the list.
- Admin client error review is at `/admin/client-errors` and reads through
  `list_client_errors` only.

### Login-Gated Webforms And Offline Queue

- Login-gated webforms must not read `app_store` directly or use browser
  secrets.
- Former public forms now use Supabase auth state intentionally for login and
  locked submitter identity.
- Light is allowed only on contained report/form surfaces plus pasture
  farm-team-level `/pasture-map` access. Weigh-ins and Production remain outside
  the Light allowlist.
- Offline queue IndexedDB ownership is centralized in `src/lib/offlineQueue.js`.
- Offline RPC replay goes through `useOfflineRpcSubmit` where needed.
- Ownership stamping is server-side on replay.
- Shared TEST DB Playwright specs that reset/seed the DB must run one file at a
  time. GitHub CI serializes its two root shards and path-gated Pasture job, but
  local Playwright is outside that concurrency group: check active GitHub runs
  and obtain the TEST-DB execution window before starting any local browser
  spec. Never overlap local TEST Playwright with GitHub CI.

### Storage And File Inputs

- Upload owner/count guards are intentionally brittle.
- New upload/remove/signed/public URL owners require updating the matching static
  guard.
- Task, daily, and comment attachment uploads are append-only.
- Image file inputs intentionally omit `capture=` so mobile users can choose
  camera or library upload through the native picker.

### Runtime Observability

- `client_error_events` records redacted browser/runtime errors through
  `record_client_error`.
- Client Errors is a read-only, admin-gated, fail-closed, paginated Admin tab
  using `list_client_errors`; it is not in the header hamburger. The existing
  `/admin/client-errors` URL remains as a backward-compatible deep link. Both
  surfaces reuse one `ClientErrorsPanel` and mount exactly one global Header.
- Client error reporting must not store raw localStorage, auth tokens, full
  payloads, or secret-like data.

### Shared UI And Record Chrome

- Global openable affordance is shared through `.hoverable-tile` for card/div
  openables and `.hoverable-row` for table-row openables.
- Do not put `.hoverable-tile` on `<tr>` or `.hoverable-row` on non-`tr`
  elements.
- `RecordPageShell` owns record-page frame/loading/not-found/body/title chrome.
- `RecordCollaborationSection` is the only component that composes
  `CommentsSection` and `RecordActivityLog`.
- `RecordActivityLog` is audit-only and filters `comment.posted`.
- `RecordSequenceNav` is the shared sequence-navigation primitive.
- `DataTable` owns table/list rendering for comparable records: real `<table>`,
  sticky header, `.hoverable-row` row-open, fail-closed load/error/empty states,
  optional row selection, Active/Complete `SectionBand`s, and mobile stacked
  record-lines.
- `Badge` is for true lifecycle/status labels only. Use `StatusText` for inline
  soft signals and supporting status ink.
- Program/species accents come from `src/lib/programColors.js` and should appear
  as dots, selected pills, or rare headline accents, not as status badges or
  broad surface themes.
- `Toolbar` owns page action bars; `Tabs` owns in-page tab strips. Header
  section navigation remains owned by `Header.jsx`.
- `app_saved_views` saved views are a generic per-surface primitive.
- `DeleteModal` and `ConfirmModal` are app-level modal primitives.
- CSV export ownership lives in `csvExport.js`; row-print export ownership lives
  in `printExport.js`.
- Record page controls live in `src/shared/recordPageControls.jsx`.

### Source Boundary Guards

Static guards lock these boundaries. If a legitimate new owner is added, update
the guard in the same lane and explain why:

- Supabase client owner.
- Browser secret/env usage.
- `app_store`, `webform_config`, `profiles` access.
- `localStorage` owner/key inventory.
- IndexedDB/offline queue owner.
- Notifications client-write prohibition.
- Task API boundary.
- Comments/Activity table access.
- Route alias ownership.
- Light portal/access boundary.
- Login-gated webforms boundary.
- Storage upload/remove/signed/public URL ownership.
- Append-only bucket upload contracts.
- Image file input capture contract.
- Hard-delete owner inventory.
- Mutation semantics inventory.
- CP2 daily writes via ownership RPCs.
- Delete/recovery classification.
- Legacy Activity retirement.
- Load/retry readiness inventory.
- Design token and radius-floor contracts.
- Shared UI extraction contract.
- Openable hover affordance contract.

---

## Validation Map

Use [HO.md](HO.md) for the required validation floor and gates.

Common commands:

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Focused starting points:

| Area | Tests |
| --- | --- |
| Design system and shared UI | `tests/static/design_token_contract_static.test.js`, `tests/static/radius_floor_static.test.js`, `tests/static/shared_ui_extraction_contract_static.test.js`, `tests/static/openable_hover_affordance_static.test.js`, `src/lib/programColors.test.js` |
| Table/list conversions | `tests/static/daily_list_empty_state_static.test.js`, `tests/static/breeding_pigs_parity_static.test.js`, `tests/static/cattle_herd_exception_filters_static.test.js`, `tests/static/weighin_session_record_page_static.test.js`, `tests/static/pig_weighin_metrics_static.test.js` |
| Routes | `src/lib/routes.test.js`, `tests/url_alias_redirects.spec.js` |
| Activity and global log | `tests/static/activity_static.test.js`, `tests/static/activity_change_logging_static.test.js`, `tests/static/global_activity_log_static.test.js`, `tests/activity_navigation.spec.js` |
| Comments and mentions | `tests/static/comments_foundation_static.test.js`, `tests/static/mention_deep_links_static.test.js` |
| Notifications | `tests/static/notifications_static.test.js`, `tests/notifications_task_completed.spec.js` |
| Tasks | `tests/static/tasks_*.test.js`, `src/lib/tasksCenterApi.test.js`, `src/lib/tasksAdminApi.test.js`, `tests/tasks_v2_*.spec.js` |
| Record pages | `tests/static/record_page_*.test.js`, per-entity static tests, `tests/*_sequence_nav.spec.js` |
| Home / dashboard alerts | `tests/static/home_missed_daily_reports_static.test.js`, `tests/static/home_next_30_icons.test.js`, `tests/static/home_daily_tile_routing_static.test.js`, `tests/static/home_animal_history_static.test.js`, `tests/static/home_weather_static.test.js`, `tests/home_weather_shell.spec.js`, `src/lib/animalHistory.test.js`, `tests/static/light_user_portal_static.test.js` |
| Production | `src/lib/production.test.js`, `tests/static/production_page_static.test.js` |
| Processing Calendar | `tests/static/processing_calendar_migration_static.test.js`, `tests/static/processing_wiring_static.test.js`, `tests/static/processing_asana_security_static.test.js`, `tests/static/processing_reconciler_migration_static.test.js`, `tests/static/processing_reconciler_wiring_static.test.js`, `tests/static/processing_reconciliation_workbench_static.test.js`, `tests/static/processing_comments_import_static.test.js`, `tests/static/processing_conversation_fidelity_static.test.js`, `tests/static/processing_engine_static.test.js`, `tests/static/processing_cleanup_static.test.js`, `tests/static/processing_options_static.test.js`, `tests/static/processing_checklist_toggle_static.test.js`, `tests/static/processing_template_suite_static.test.js`, `tests/static/processing_templates_import_static.test.js`, `tests/static/processing_attachments_storage_static.test.js`, `tests/static/processing_legacy_liveweights_static.test.js`, `tests/static/processing_lock_order_static.test.js`, `tests/processing_calendar.spec.js`, `tests/processing_asana_importer.test.js`, `tests/processing_conversation_fidelity.test.js`, `tests/processing_asana_shape.test.js`, `tests/processing_asana_matcher.test.js`, `tests/processing_asana_templates.test.js`, `scripts/apply_test_mig_156.cjs` through `scripts/apply_test_mig_162.cjs`, `scripts/apply_test_mig_164.cjs` through `scripts/apply_test_mig_166.cjs`, `scripts/apply_test_mig_170.cjs` through `scripts/apply_test_mig_179.cjs`, `scripts/proof_reconciler_blockers.cjs`, `scripts/proof_reconciler_enumeration.cjs`, `scripts/ops_processing_attachment_backfill.cjs`, `scripts/proof_processing_attachment_backfill.cjs` |
| User management | `src/lib/userManagementApi.test.js`, `src/auth/usersModalMutationLock.test.js`, `tests/static/user_management_audit_static.test.js`, `tests/static/users_modal_self_name_edit.test.js`, `tests/static/rapid_processor_handlers.test.js`, `tests/static/rapid_processor_reset_hardening_static.test.js`, `tests/static/rapid_processor_user_create_static.test.js`, `tests/user_management_audit.spec.js`, `scripts/apply_test_mig_171.cjs`, `scripts/apply_test_mig_183.cjs`, `scripts/proof_test_user_delete_edge.cjs`, `scripts/proof_test_password_reset_hardening.cjs` |
| Newsletter | `tests/static/newsletter_boundary_static.test.js`, `tests/static/newsletter_shared_parity.test.js`, `src/lib/newsletterApi.test.js`, `src/lib/newsletterFacts.test.js`, `src/lib/newsletterProductionYoy.test.js`, `src/newsletter/NewsletterBlocks.test.js`, `tests/newsletter_public.spec.js`, `scripts/apply_test_mig_144_145.cjs`, `scripts/apply_test_mig_153.cjs`, `scripts/apply_test_mig_189.cjs` |
| Pasture Map | `src/lib/pastureKml.test.js`, `src/lib/pastureGeometry.test.js`, `src/lib/pasturePlannerGroups.test.js`, `tests/static/pasture_map_static.test.js`, `tests/static/pasture_direct_rest_history_static.test.js`, `tests/pasture_map_p2_map.spec.js`, `tests/pasture_map_placement.spec.js`, `tests/pasture_map_reports_records.spec.js`, `tests/pasture_map_reset_history.spec.js`, `tests/pasture_map_light_access.spec.js`, `tests/pasture_map_setup.spec.js`, `tests/pasture_map_tweaks2.spec.js`, `tests/pasture_map_import.spec.js`, `tests/pasture_map_cp2.spec.js`, `tests/pasture_map_cp3.spec.js`, `tests/pasture_map_cp4.spec.js`, `tests/pasture_map_cp5.spec.js`, `tests/pasture_map_cp6.spec.js`, `tests/pasture_map_cp7.spec.js`, `tests/pasture_map_tile_hover.spec.js`, `tests/pasture_map_open_line_edit.spec.js`, `tests/pasture_map_v1_measure.spec.js`, `playwright.pasture.config.js`, `scripts/apply_test_mig_147.cjs`, `scripts/apply_test_mig_148.cjs`, `scripts/apply_test_mig_150.cjs`, `scripts/apply_test_mig_180.cjs` |
| Breeding pigs | `tests/static/breeding_pigs_parity_static.test.js` |
| Feed planning | `src/lib/feedPlanner.test.js`, `src/lib/feedOrderBasis.test.js`, `tests/static/feed_order_board_static.test.js` |
| Pig | `src/lib/pig*.test.js`, `src/lib/pigBatchGridMetrics.test.js`, `tests/static/pig_batches_planned_trips_static.test.js`, `tests/static/weighin_session_record_page_static.test.js`, `tests/pig_*.spec.js` |
| Broiler/layer | `src/lib/broiler.test.js`, `tests/static/broiler_hatch_activation_static.test.js`, `tests/static/broiler_batch_record_page_static.test.js`, `tests/static/weighin_session_record_page_static.test.js`, `tests/static/webform_config_boundary_static.test.js`, `src/layer/*.test.js`, `tests/broiler_*.spec.js`, `tests/layer_*.spec.js` |
| Cattle | `tests/static/cattle_*.test.js`, `tests/cattle_*.spec.js`, `src/lib/cattleHerdFilters.test.js`, `scripts/apply_test_mig_182.cjs` |
| Sheep | `tests/static/sheep_*.test.js`, `tests/sheep_*.spec.js`, `src/lib/sheepFlockFilters.test.js` |
| Daily reports | `tests/static/daily_*.test.js`, `tests/static/cp2_daily_writes_via_rpc_static.test.js`, `tests/daily_*.spec.js` |
| Equipment | `src/lib/equipment.test.js`, `tests/static/equipment_*.test.js`, `tests/equipment_*.spec.js` |
| Export / print | `src/lib/csvExport.test.js`, `src/lib/printExport.test.js` |
| Login/offline webforms | `tests/static/light_user_portal_static.test.js`, `tests/offline_*.spec.js`, `tests/daily_report_photos.spec.js` |
| Storage/media guards | `tests/static/*storage*.test.js`, `tests/static/*photo*.test.js`, `tests/static/image_file_input_capture_static.test.js` |
| Runtime observability | `tests/static/error_resilience_static.test.js`, `tests/static/client_error_boundary_static.test.js`, `tests/static/client_errors_review_static.test.js`, `tests/client_errors_admin_tab.spec.js` |

Playwright notes:

- `.github/workflows/ci.yml` delegates browser scope to
  `scripts/ci_playwright_plan.cjs`. The only valid root-suite modes are `none`,
  `focused`, and `full`; any missing diff or unclassified path fails safe to
  `full`.
- Docs/static/unit-only changes run the DB-free verify floor. Mapped ordinary
  product changes run only their owned focused browser specs. Migrations, Edge,
  auth/session/role/Header/router, shared test infrastructure, CI/Playwright
  configuration, dependency changes, and explicit `high-risk`/`full-e2e` labels
  run both complete shards.
- The complete shards also run nightly and by manual dispatch. Pasture remains
  a separate path-gated suite. `e2e-policy-gate` is the stable required-check
  target and fails when the classifier-selected path did not succeed.
- A GitHub `Merge pull request #...` main push runs the DB-free verification
  floor without repeating browser work already executed against that PR's
  combined head. Direct main pushes still undergo ordinary fail-closed risk
  classification.
- Specs that reset the shared TEST DB must run one file at a time.
- Every local TEST-backed Playwright run must use
  `scripts/test_db_lease_run.cjs`; it dispatches the shared GitHub
  `wcf-test-db` concurrency lease and lets CI go first. Never run an unleased
  local TEST browser process because that process is invisible to the group and
  can corrupt seed/reset state.
- Local dev-server cold-start can hang if stray node/vite processes remain in
  old worktrees. Clear stale processes before diagnosing product flake.

---

## Agent Session Checklist

Before a new lane:

1. Read [HO.md](HO.md).
2. Read Current State, Build Queue, and the relevant contracts here.
3. Run `git status --short`, `git worktree list`, and inspect recent `git log`.
4. Identify dirty-tree risk, active worktrees, open gates, and migration state.
5. Inspect files in scope before planning.
6. If touching a boundary guard, update the guard in the same lane.
7. If touching SQL/RPC/RLS/Storage, state TEST/PROD apply and verification needs
   in the plan.
8. If approving a commit gate, queue the next CC-ready prompt in the same Codex
   response per [HO.md](HO.md).

---

## Archives

- Older narrative history: `archive/SESSION_LOG.md`.
- Research, screenshots, audits, and video evaluations:
  `C:\Users\Ronni\cc-research\` (workstation-local; outside the repo, so it will
  not resolve on another clone/agent).
- Parity audit evidence:
  `C:\Users\Ronni\cc-research\parity-audit-2026-06-05-CC.md` (workstation-local).
- Detailed build history lives in git log and tests. Keep this file as the
  compact project map, not a running transcript.
