# WCF Planner

Farm-management web app for White Creek Farm. React/Vite single-page app,
Supabase backend, Netlify production deploy from GitHub `main`.

This file is the durable project map: current state, architecture, roadmap, and
load-bearing contracts. Workflow, roles, gates, and relay format live in
[HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-06-04.
Current production checkpoint: `origin/main @ 1c0fadc` (latest app/build merge
`7de1758`, docs wrap `1c0fadc`).
Production URL: https://wcfplanner.com.

---

## Start Here

1. Read [HO.md](HO.md) for workflow and gates.
2. Read this file's Current State, Work Queue, and the relevant contracts.
3. Run `git status --short` and inspect recent `git log` before planning or
   editing.
4. Inspect the files in scope before changing anything.

Default session model: Codex plans/reviews, CC builds/validates, Ronnie approves
commit/push/PROD gates. Codex may build or edit only when Ronnie assigns it.

This file should answer "what is true now?" at the start of a session. Use git
history and tests for detailed lane history.

---

## Current State

- Production deploy: Netlify auto-deploys from GitHub `main`.
- Source of truth: `origin/main @ 1c0fadc`.
- Open gates for the shipped tree: none.
- PROD-applied numbered migration series is live through `092`. Migration `082`
  is unused; migration `083` is shelved. Operational note: the daily duplicate
  cleanup `085` was applied before unique-index migration `084`.
- TEST/PROD migrations `074` through `081` plus `084`/`085`/`086` were applied
  and verified during the 2026-06-03 hardening sequence.
- Light-user portal migrations `087`–`092` (CP1+CP2 ownership) were applied to
  PROD atomically (single transaction) and verified on 2026-06-04: `light` role
  in the profiles constraint, `owner_profile_id` on all 9 report tables, the
  server-trusted INSERT stamp + UPDATE owner-freeze triggers, the ownership RPCs,
  and the `092` red-switch (direct UPDATE/DELETE revoked on the 6 daily tables;
  privileged-only RLS on `equipment_fuelings`/`fuel_supplies`).
- Local note for new agents: edit `PROJECT.md` only during explicit docs or wrap
  work. Normal build lanes should leave docs alone.

### Latest Shipped Checkpoint

The following work is merged to `main` and PROD-ready or PROD-applied where
listed:

Earlier load-bearing migrations (`057`–`079`) are summarized under Supabase
Migrations below and in git history; this list keeps the most recent shipped
work:

- Authenticated Light-user portal, CP1+CP2, migrations `087`–`092`, PROD
  (2026-06-04, commit `4b69510` + merge `7de1758`). CP1: real authenticated
  `light` role; the former public report/form URLs (daily, Add Feed, equipment
  fueling, fuel supply, weigh-in) are now login-required with preserved
  URLs/aliases and return-to-URL after login; submitter is locked to the
  signed-in user; Light users are contained to a portal (daily list/record
  views, Add Feed, equipment fueling checklist, Tasks, My Submissions) and
  everything else fails closed. CP2: Light reads ALL reports but edits/deletes
  only its OWN, server-enforced — `owner_profile_id` stamped from `auth.uid()`
  by a BEFORE INSERT trigger (never client-supplied; NULL = legacy/unowned =
  read-only for Light), all daily edits/deletes routed through SECURITY DEFINER
  ownership RPCs with positive per-table column allowlists and server-side
  `field.updated` Activity diffs, and the `092` red-switch revoking direct
  PostgREST UPDATE/DELETE so enforcement is server-side, not UI-only.
- Feed second-tile current-month pin, code-only, PROD. The second feed summary
  tile (pig + broiler) stays on the current calendar month estimate via
  `estTileYM` and no longer rolls forward when a feed order advances the order
  workflow `activeYM`.
- Pig planned-trip weight forecast audit + weigh-in/batch-tile refinements,
  code-only, PROD.
- Cattle herd missing-dam / exception filters, code-only, PROD. `CattleHerdsView`
  exception filters backed by `src/lib/cattleHerdFilters.js`.
- Broiler on-farm count reconciliation, code-only, PROD. On-farm count derives
  from `src/lib/broiler.js` with a dedicated static guard.
- Legacy Activity composer RPC retirement, migration `080`, PROD. Historical
  composer/count functions remain in SQL but client execute is revoked for anon
  and authenticated roles.
- Processing detach Activity RPCs, migration `081`, PROD. Authenticated cattle
  and sheep processing-batch pages now detach through audited SECDEF RPCs that
  revert animals, clear weigh-in links, and log Activity in one transaction.
- Daily duplicate cleanup and unique indexes, migrations `085` then `084`,
  PROD. Historical duplicate active daily rows were soft-deleted, duplicate
  preflight now passes, and partial unique indexes enforce daily identity for
  poultry, pig, layer, cattle, and sheep daily reports.
- Daily duplicate app handling and equipment maintenance idempotency, migration
  `086`, PROD. Daily report duplicate constraint failures now show friendly
  messages across app edit/create surfaces, offline replay treats superseded
  duplicate dailys as non-stuck, and equipment maintenance events have
  `client_submission_id` idempotency protection against accidental double
  submits without blocking legitimate same-day service entries.
- Cattle forecast Activity log UI, commit `957f577` plus follow-up correction.
  `/cattle/forecast` renders Activity-only logs inside each expanded month
  bucket. Month bucket logs read the `cattle.forecast` stream and filter by
  `payload.month_key` so each month shows only its own Activity.
- Static hardening and inventory guards. The current tree locks source-wide
  table/bucket/env/local storage/API boundaries plus mutation/delete/load/UI
  inventories. Treat the matching static guards as the source of truth for
  current inventory counts.

### No Current Open Gates

There are no active commit, push, PROD migration, storage, deploy, or Vault
gates documented for this checkpoint. If a new session sees a dirty tree, inspect
it before planning; do not assume it is disposable.

Local worktree note: the main worktree is `C:\Users\Ronni\WCF-planner`.
Several suffixed Codex worktrees may still exist as shipped branch snapshots
(`feed`, `broiler`, `cattle`, `pig`). They are not active build lanes unless
Ronnie explicitly reuses or prunes them.

### Recommended Work Queue

Treat these as product lanes, not hotfixes, unless Ronnie says otherwise.
Shipped 2026-06-04 (removed from queue): authenticated Light-user portal CP1+CP2,
pig planned-trip weight audit, cattle missing-dam herd filters, feed second-tile
current-month pin, and broiler on-farm count reconciliation.

1. Task weekly email correction. Current `tasks-summary-weekly` cron is
   scheduled as Monday `13:00 UTC`, which is Monday 8am Central during daylight
   time. Change the product schedule to Sunday 8am Central, decide whether that
   means fixed UTC or true America/Chicago DST behavior, and add weekly email
   coverage for task-completed notifications owed to the task creator/assignor.
2. Equipment caught-up home notices. Add home tile notices when equipment
   maintenance and equipment materials are fully caught up, analogous to the
   "no missing daily reports" state.
3. Follow-on audited RPCs where remaining flows still have partial-state or
   audit gaps.

### Light-User Portal Contract

Locked product direction (do not re-litigate without Ronnie): authenticated-only
submission is the durable path. Lane 5 / migration `083` stays shelved; do NOT
build roster-id -> profile-id mapping.

Shipped contract:
- `light` is a real authenticated role managed through the normal user-management
  authority path.
- Former public report/form URLs stay valid but now require login; logged-out
  access redirects through login and returns to the requested URL.
- Submitter/team-member identity is the signed-in user and is displayed locked.
  Client-provided profile IDs are never authority.
- Light users land on a contained portal with only allowed surfaces: webform hub,
  daily report forms, six daily list/record views, Add Feed, equipment
  fueling/checklist, fuel supply, Tasks, legacy pig daily form, and My
  Submissions.
- Weigh-ins are intentionally not a Light surface.
- Light can read all daily report records in the allowed daily surfaces,
  including legacy rows, but can edit/delete only rows where
  `owner_profile_id = auth.uid()`. Legacy NULL-owner rows are read-only for
  Light.
- `owner_profile_id` is server-stamped by migration `089` on insert across the 9
  report tables. Offline replay stamps the authenticated user performing the
  replay; stored client profile IDs are ignored.
- Daily edit/delete writes route through `update_daily_report` and
  `soft_delete_daily_report`; direct client UPDATE/DELETE on daily tables is
  revoked by migration `092`.
- Equipment fueling and fuel supply own-record edits/deletes for Light happen in
  My Submissions through ownership RPCs. Privileged fleet/admin surfaces remain
  available to privileged roles under RLS/RPC controls.

Guard rails: `light_user_portal_static.test.js`,
`daily_edit_surface_static.test.js`, `daily_soft_delete_static.test.js`, and
`cp2_daily_writes_via_rpc_static.test.js` lock the route/nav/access and
ownership-write contracts.

---

## Product Surface

### Authenticated App

- Home dashboard.
- Broiler: home, timeline, batches, feed, dailys, weigh-ins.
- Pig: home, breeding, farrowing, sows, batches, feed, dailys, weigh-ins.
- Layer: home, groups, batches, dailys, eggs.
- Cattle: home, herds, breeding, forecast, processing batches, dailys,
  weigh-ins.
- Sheep: home, flocks, processing batches, dailys, weigh-ins.
- Equipment/Fleet: `/fleet` with fleet list, fuel log, and equipment detail.
- Task Center: `/tasks`.
- Light portal: contained home for `role=light`, allowed webform/daily shortcuts,
  Tasks, and My Submissions.
- Global Activity: `/activity`.
- Admin/config: `/admin`.
- Admin runtime observability: `/admin/client-errors`.

### Login-Gated Form URLs

- Former public report/form URLs are now authenticated. Existing paths and
  aliases stay valid, redirect logged-out users to login, and return to the
  requested URL after auth.
- `/dailys` and `/dailys/tasks`.
- `/addfeed`.
- `/weighins`.
- `/equipment` and `/equipment/<slug>`.
- `/fuel-supply`.
- `/webform-pigs` legacy standalone pig daily form.
- Legacy aliases redirect through `src/lib/routes.js`. Do not add alias logic
  outside that owner.
- Light users are allowed through the contained report/form surfaces but are not
  allowed into `/weighins`.

### Operational Record Pages

Record pages are durable per-entity workspaces. They own record details,
Comments, collapsed Activity log, sequence navigation where appropriate, and
fail-closed loading.

Live Activity entity types and routes:

| Entity type         | Route                              |
| ------------------- | ---------------------------------- |
| `task.instance`     | `/tasks/<id>`                      |
| `cattle.animal`     | `/cattle/herds/<id>`               |
| `sheep.animal`      | `/sheep/flocks/<id>`               |
| `cattle.processing` | `/cattle/batches/<id>`             |
| `sheep.processing`  | `/sheep/batches/<id>`              |
| `broiler.batch`     | `/broiler/batches/<encoded name>`  |
| `pig.batch`         | `/pig/batches/<group id>`          |
| `layer.batch`       | `/layer/batches/<id>`              |
| `layer.housing`     | `/layer/housings/<id>`             |
| `equipment.item`    | `/fleet/<id>`                      |
| `poultry.daily`     | `/broiler/dailys/<id>`             |
| `layer.daily`       | `/layer/dailys/<id>`               |
| `egg.daily`         | `/layer/eggs/<id>`                 |
| `pig.daily`         | `/pig/dailys/<id>`                 |
| `cattle.daily`      | `/cattle/dailys/<id>`              |
| `sheep.daily`       | `/sheep/dailys/<id>`               |
| `weighin.session`   | `/weigh-in-sessions/<id>`          |
| `cattle.forecast`   | `/cattle/forecast`                 |
| `cattle.breeding`   | `/cattle/breeding`                 |

No operational record workspace should reintroduce legacy `ActivityPanel` or
`ActivityModal`. Comments are discussion; Activity is audit/history.

---

## Backend And Data State

### Supabase Migrations

Current PROD architecture includes these load-bearing migrations:

- `057` notifications.
- `058` `activity_events` and `activity_mentions` foundation.
- `060` Activity mention contract.
- `062` Activity entity expansion.
- `063` notification activity resolution.
- `064` Activity Phase 2 entities.
- `065` Global Activity Log.
- `066` Activity change events.
- `067` daily soft-delete.
- `068` `client_error_events` and `record_client_error`.
- `069` `cattle.animal` soft-delete/restore.
- `070` daily delete for active roles.
- `071` Comments foundation.
- `072` weigh-in session Activity entity.
- `073` `comment-photos` Storage RLS.
- `074` `sheep.animal` soft-delete/restore.
- `075` animal transfer Activity RPCs.
- `076` `cattle.forecast` Activity entity.
- `077` `list_client_errors` admin read RPC.
- `078` `cattle.breeding` Activity entity.
- `079` `delete_cattle_calving_record` RPC.
- `080` legacy Activity composer RPC retirement.
- `081` authenticated processing-detach Activity RPCs.
- `084` daily report partial unique indexes.
- `085` daily duplicate cleanup.
- `086` equipment maintenance event idempotency.
- `087` `profiles.role` adds `light` to the CHECK constraint.
- `088` `owner_profile_id` columns + partial indexes on the 6 daily tables,
  `daily_submissions`, `equipment_fuelings`, `fuel_supplies`.
- `089` `stamp_owner_profile_id` BEFORE INSERT trigger (`trg_stamp_owner`)
  stamping `owner_profile_id := auth.uid()` on all 9 tables; never client-set.
- `090` `fuel_supplies` authenticated INSERT policy (CP1 login-gating fix).
- `091` ownership RPCs: `update_daily_report` (positive per-table column
  allowlist + server-side `field.updated` diff), `soft_delete_daily_report`
  ownership branch, `update_equipment_fueling`, `delete_equipment_fueling`,
  `update_fuel_supply`, and `delete_fuel_supply`.
  Light may mutate only rows where `owner_profile_id = auth.uid()`.
- `092` ownership enforce (red-switch): REVOKE direct UPDATE/DELETE on the 6
  daily tables, `trg_freeze_owner` BEFORE UPDATE trigger, privileged-only RLS on
  `equipment_fuelings`/`fuel_supplies`.

Special migration notes:

- `082` is intentionally unused.
- `083` public webform submitter identity is shelved and must not be applied
  unless Ronnie reverses the auth-only webform direction.
- `085` was applied before `084` in PROD so duplicate active daily identities
  were cleaned up before the unique indexes were created.
- `061_daily_report_soft_delete_restore.sql` is superseded by `067`.
- New or changed SECDEF RPC return shapes need
  `NOTIFY pgrst, 'reload schema'`.
- PROD `exec_sql` is forbidden. Apply PROD SQL with `psql` and
  `ON_ERROR_STOP=1` per [HO.md](HO.md).

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

Append-only upload expectations:

- Uploads use `upsert: false` unless a lane explicitly changes the contract.
- Duplicate-object errors are treated as retry success where the upload path is
  idempotent.
- Private buckets use signed URLs; public buckets use public URLs.
- No code should mutate `storage.objects` directly.

---

## Architecture Map

### Stack

- React 18 / Vite SPA.
- Supabase JS client from `src/lib/supabase.js` only.
- React Router DOM.
- `idb` for IndexedDB/offline queue.
- Playwright for e2e.
- Vitest for unit/static tests.
- ESLint + Prettier.
- Netlify production deploy from `main`.

### Important Files

- `src/main.jsx`: app shell, view routing, auth-gated view rendering, global
  modals.
- `src/lib/routes.js`: canonical route map and aliases.
- `src/lib/activityRegistry.js`: client entity registry, labels, and routes.
- `src/lib/activityApi.js` and `src/lib/globalActivityApi.js`: Activity RPC
  clients.
- `src/lib/commentsApi.js` and `src/shared/CommentsSection.jsx`: Comments
  system.
- `src/shared/RecordPageShell.jsx`: shared record-page chrome.
- `src/shared/RecordCollaborationSection.jsx`: Comments + Activity composition.
- `src/shared/RecordActivityLog.jsx`: audit-only record Activity view.
- `src/shared/RecordSequenceNav.jsx`: sequence navigation.
- `src/shared/InlineNotice.jsx`: non-blocking notices.
- `src/shared/DeleteModal.jsx` and `src/shared/ConfirmModal.jsx`: app modal
  primitives.
- `src/lib/entityMutations.js`: shared best-effort mutation + Activity helper.
- `src/lib/clientErrorReporting.js` and `src/admin/ClientErrorsView.jsx`:
  runtime error capture and admin review.

### Route Ownership

- `src/lib/routes.js` owns canonical paths and legacy aliases.
- `src/lib/activityRegistry.js` owns entity-to-record routes for Activity and
  notifications.
- `main.jsx` adapts URLs into view state. Do not add separate alias maps in
  views.

### Authentication And Roles

- Ronnie remains final gate owner.
- App roles include admin, management, farm_team, equipment_tech, light, and
  inactive.
- Runtime permission decisions must be enforced by RLS/RPCs, not just hidden UI.
- Report/form submission is login-required. The session user is the submitter;
  `owner_profile_id` is stamped server-side and client-supplied profile IDs are
  not trusted.

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

There are no current no-retry loadError gaps; this is locked by
`load_retry_robustness_inventory_static.test.js`.

### Activity, Comments, Mentions, Notifications

- Activity is audit/system history. Comments are user discussion.
- Runtime Activity access goes through SECDEF RPCs: `list_activity_events`,
  `list_global_activity`, `record_activity_event`, and domain-specific SECDEF
  RPCs that insert `activity_events`.
- No direct client `.from('activity_events')` or
  `.from('activity_mentions')`.
- No direct client `.from('comments')` or `.from('comment_edits')`.
- Legacy Activity composer/count RPCs (`post_activity_comment`,
  `edit_activity_event`, `delete_activity_event`, `count_activity_for_entity`)
  remain defined in historical SQL with no runtime callers, and migration `080`
  revoked client execute for anon and authenticated. Do not use them.
- `RecordActivityLog` filters `comment.posted` and shows audit only.
- `CommentsSection` owns user discussion, attachments, edit history, soft
  delete, and mentions.
- Mention bodies stay human-readable `@Name`. UUIDs do not appear in body text.
- Mention notifications route to the operational record page and target comment.
- Valid notification types: `task_completed`, `mention`, `comment_mention`.
- Notification writes happen inside SECDEF paths. Client code must not insert or
  delete notifications.
- `task_completed` notifications skip null creator and self-completion.

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

- `cattle.forecast` uses entity_id `cattle-forecast`; Forecast month bucket
  logs filter that stream by `payload.month_key`.
- `cattle.breeding` uses entity_id `cattle-breeding`.
- These are table/workflow audit streams. Their `_activity_can_read` branches
  are program-gated rather than row-existence gated.

### Entity Mutations And Audit Atomicity

- `runMutation` is for routine client-side mutations with best-effort Activity.
- `runMutation` must not know table names or business rules.
- `runMutation` is not transactional. If Activity fails after a successful data
  write, the data is already committed.
- Audit-critical delete/restore/transfer/status flows should move to SECDEF RPCs
  that mutate data and insert Activity in one transaction.
- Current inventory locks 220 literal Supabase mutations (30 delete, 65 insert,
  82 update, 43 upsert), 6 dynamic table mutations, and 7 `runMutation` caller
  modules. New mutation sites must update
  `mutation_semantics_inventory_static.test.js` deliberately.

### Delete, Restore, And Recovery

- Hard-delete owner surface is locked at 28 direct client table deletes.
- Soft-delete protected roots must not have direct client deletes: cattle, sheep,
  `cattle_dailys`, `sheep_dailys`, `poultry_dailys`, `layer_dailys`,
  `egg_dailys`, `pig_dailys`.
- Daily reports soft-delete through `soft_delete_daily_report` and restore
  through `restore_daily_report`.
- Cattle/sheep animals soft-delete/restore through their animal RPCs.
- Calving sub-row delete goes through `delete_cattle_calving_record` and logs
  `record.deleted` on the dam's `cattle.animal`.
- Root hard-delete Activity still needs a tombstone/deleted-record design if
  ever required.

### Cattle And Sheep

- Cattle and sheep use dedicated Supabase tables, not `app_store`.
- Active cattle herds: `mommas`, `backgrounders`, `finishers`, `bulls`.
- Active sheep flocks: `rams`, `ewes`, `feeders`.
- Outcome states are `processed`, `deceased`, `sold`.
- Cattle soft-delete/restore: `soft_delete_cattle_animal`,
  `restore_cattle_animal`.
- Sheep soft-delete/restore: `soft_delete_sheep_animal`,
  `restore_sheep_animal`.
- Animal restores reject active tag conflicts.
- Normal reads filter `deleted_at IS NULL`.
- Admin can inspect deleted rows where RLS/RPC supports it.
- No cattle/sheep table DELETE policy should exist for client hard-delete.
- Manual transfer goes through `transfer_cattle_animal` /
  `transfer_sheep_animal`: row update + transfer row + `status.changed`
  Activity in one transaction.
- Processing-batch helpers may need to resolve deleted animals by ID in admin
  context; do not add `deleted_at` filters there without redesign.
- Cattle Herds tab exception filters live in `src/lib/cattleHerdFilters.js` and
  render as checkboxes in the existing herd filter bar:
  - `Non Calving Cows`: cow/heifer, at least 30 months old, and no calving
    record in the last 9 months.
  - `Unmatched Calves`: any sex, no matched dam, and either born in the last 4
    months or missing DOB.
- Exception filters compose as OR with each other and still compose with herd,
  normal filters, and search. Current last-calved lookup is by current tag, not
  old tags; treat that as the accepted edge unless Ronnie asks to change it.

### Daily Reports

- Daily reports have dedicated record pages for poultry, layer, egg, pig, cattle,
  and sheep.
- All six open directly editable; no edit-mode toggle.
- Daily duplicate prevention (identity = date + batch_label for poultry/pig/
  layer, date + herd for cattle, date + flock for sheep; Add Feed rows excluded):
  - DB-enforced for those five tables by partial unique indexes (`084`); the
    one-time historical duplicate cleanup (`085`) ran first in PROD.
  - The client pre-submit guard (`src/lib/dailyDuplicateCheck.js`) still runs;
    the indexes are the backstop for edit-to-collide, races, and offline replay.
  - A constraint violation surfaces a friendly "report already exists" message
    across edit/create surfaces, and offline replay discards superseded
    duplicate dailys instead of sticking (`086` lane).
  - `egg_dailys` is intentionally NOT indexed — warning/pre-submit guard only.
- Add Feed quick-log rows are not full daily reports.
- Missed-report checks exclude `source='add_feed_webform'`.
- Daily edits route through `updateDailyReport` / `update_daily_report` so
  server-side allowlists, casts, ownership checks, and Activity diffs own the
  write. Do not reintroduce direct daily-table `.update()` calls.
- Daily deletes route through `soft_delete_daily_report`. Do not reintroduce
  direct client deletes for daily roots.
- `canEditOwnRecord(authState, record)` and
  `canDeleteDailyReport(authState, record)` mirror server rules: privileged
  roles can mutate allowed daily rows, Light can mutate only its own
  `owner_profile_id = auth.uid()` rows, inactive cannot mutate, and legacy
  NULL-owner rows are Light read-only.
- Admin Recently Deleted supports daily restore.
- Broiler/layer/pig daily pages use Group copy, not Batch copy.
- Layer daily group and `batch_id` resolution must go through
  `src/layer/layerDailyGroups.js`.

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
- `processingTrips[].subAttributions` stores `{subId, subBatchName, sex, count}`.
- Send-to-Trip may reconcile locked planned trip count but cannot change locked
  date.
- Planned-trip forecast weights are render-only and based on DOB/farrowing age
  at trip date times Global ADG. Latest weigh-ins do not change planned-trip
  forecast weights.
- Farrowing-age distribution uses the parent farrowing window and is scaled to
  sub-batches. Planned trips slice oldest-to-youngest; already shipped pigs are
  offset from the oldest side. Missing farrowing data falls back to the
  estimated-cycle band and is marked estimated; 1-pig projections show the full
  band.
- Processing trips show Forecast vs Actual with delta, display-only, so Ronnie
  can compare shipped results against the Global ADG model without auto-changing
  ADG.
- Weigh-in entry tiles show previous weigh-in/date and rank-matched per-pig ADG
  when a prior session exists. Blank notes are hidden behind `+ Note`; existing
  notes still show.
- Pig batch hub tiles show started count, current count, feed per pig started,
  and sub-batch chips.

### Broiler, Layers, And Feed Planning

- Broiler batches live in `ppp-v4`.
- Login-gated `/weighins` cannot read or mutate `app_store.ppp-v4` directly.
- Week 4/6 completion uses `stamp_broiler_batch_avg` RPC.
- Layer `current_count` is the physical anchor; projected count subtracts
  mortalities since anchor.
- Feed math lives in `src/lib/feedPlanner.js` and `src/lib/feedOrderBasis.js`.
- Feed-order recommendations use the latest active-month physical count when
  present; otherwise they fall back to previous-month estimate.
- Poultry feed-order math is per feed type: starter, grower, layerfeed.
- "Count includes `<month>` order" prevents double-counting the delivery.
- The "Order for `<active>`" tile labels its basis.
- The second feed summary tile for pig and broiler stays pinned to the current
  calendar month estimate via `estTileYM`; feed-order entry may advance the
  workflow `activeYM` without rolling this estimate tile forward.
- Broiler on-farm counts are centralized in `computeBroilerOnFarmCounts` in
  `src/lib/broiler.js`. "Birds on Farm" means projected live birds after
  mortality; "Birds Started" is shown separately. Home and Broiler Home use the
  same helper.

### Tasks

- `/tasks` is canonical. `/my-tasks` and `/admin/tasks` are aliases only.
- Task writes go through v2 wrappers/RPCs.
- Frontend must not call `generate_system_task_instance`.
- `task_instance_photos` is canonical. Legacy single-photo columns are display
  fallback only.
- Task assignee dropdowns use `loadTaskAssignableProfilesById` and fail closed
  on `webform_config` read errors.
- Header task badge soft-fails and must not break Header rendering.
- The `task_completed` notification contract is covered by Playwright.
- Current weekly task email is an open-task digest grouped by assignee only; it
  does not include completed-task notices owed to the creator/assignor.
- Current weekly task email cron is `tasks-summary-weekly` at `0 13 * * 1`
  (Monday 13:00 UTC), which is Monday 8am Central during daylight time. Product
  target is Sunday 8am Central; the build lane must decide fixed UTC versus
  true America/Chicago DST behavior.

### Equipment

- Logged-in equipment lives under `/fleet`.
- Login-gated equipment checklist/fueling lives under `/equipment`.
- Equipment fueling submissions use `submit_equipment_fueling` RPC.
- Light My Submissions edits/deletes its own equipment fuelings and fuel
  supplies through ownership RPCs. Privileged `/fleet` and admin fuel-log
  surfaces retain their privileged paths under RLS/RPC controls.
- Fuel-log edit/delete paths recompute current readings from remaining fuel logs.
- Equipment checklist/material edits must not reload, lose focus, or reorder list
  items on click/edit.
- Rolling material clears are bucketed by due service cycle.
- `equipment_maintenance_events` has `client_submission_id` idempotency (`086`):
  a double-tap "Add Event" collapses to a no-op. This is idempotency, not
  date-uniqueness — multiple legitimate same-day service events are still
  allowed. Fuelings and `fuel_supplies` already had `client_submission_id`
  idempotency (`030`).
- Backlog: home equipment tiles should show caught-up notices when all equipment
  maintenance and equipment materials are current, mirroring the "no missing
  daily reports" state.
- Admin client error review is at `/admin/client-errors` and reads through
  `list_client_errors` only.

### Login-Gated Webforms And Offline Queue

- Login-gated webforms must not read `app_store` directly or use browser
  secrets.
- Former public forms now use Supabase auth state intentionally for login and
  locked submitter identity. The signed-in session user is the submitter;
  client-supplied profile IDs are never trusted.
- Light is allowed only on contained report/form surfaces; weigh-ins remain
  outside the Light allowlist.
- Offline queue IndexedDB ownership is centralized in `src/lib/offlineQueue.js`.
- Offline RPC replay goes through `useOfflineRpcSubmit` where needed.
- Ownership stamping is server-side on replay: the replaying authenticated user
  becomes `owner_profile_id`.
- Shared TEST DB Playwright specs that reset/seed the DB must run one file at a
  time.

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
- `/admin/client-errors` is read-only, admin-gated, fail-closed, paginated, and
  uses `list_client_errors`.
- Client error reporting must not store raw localStorage, auth tokens, full
  payloads, or secret-like data.

### Shared UI And Record Chrome

- `RecordPageShell` owns record-page frame/loading/not-found/body/title chrome.
- `RecordCollaborationSection` is the only component that composes
  `CommentsSection` and `RecordActivityLog`.
- `RecordActivityLog` is audit-only and filters `comment.posted`.
- `RecordSequenceNav` is the shared sequence-navigation primitive.
- `DeleteModal` and `ConfirmModal` are app-level modal primitives, with known
  local exceptions locked by `shared_ui_extraction_contract_static.test.js`.
- Record page controls live in `src/shared/recordPageControls.jsx`.

### Source Boundary Guards

Static guards now lock these boundaries. If a legitimate new owner is added,
update the guard in the same lane and explain why:

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
- Shared UI extraction contract.

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

| Area                     | Tests                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routes                   | `src/lib/routes.test.js`, `tests/url_alias_redirects.spec.js`                                                                                                    |
| Activity and global log  | `tests/static/activity_static.test.js`, `tests/static/activity_change_logging_static.test.js`, `tests/static/global_activity_log_static.test.js`, `tests/activity_navigation.spec.js` |
| Comments and mentions    | `tests/static/comments_foundation_static.test.js`, `tests/static/mention_deep_links_static.test.js`                                                             |
| Notifications            | `tests/static/notifications_static.test.js`, `tests/notifications_task_completed.spec.js`                                                                        |
| Tasks                    | `tests/static/tasks_*.test.js`, `src/lib/tasksCenterApi.test.js`, `src/lib/tasksAdminApi.test.js`, `tests/tasks_v2_*.spec.js`                                  |
| Record pages             | `tests/static/record_page_*.test.js`, per-entity static tests, sequence-nav specs                                                                                |
| Readiness                | `tests/static/load_retry_robustness_inventory_static.test.js`, `tests/static/*readiness*`                                                                       |
| Mutation/delete/recovery | `tests/static/mutation_semantics_inventory_static.test.js`, `tests/static/delete_recovery_classification_static.test.js`, `tests/static/hard_delete_owner_static.test.js` |
| Cattle                   | `tests/static/cattle_*.test.js`, `tests/cattle_*.spec.js`                                                                                                       |
| Sheep                    | `tests/static/sheep_*.test.js`, `tests/sheep_*.spec.js`                                                                                                         |
| Daily reports            | `tests/static/daily_*.test.js`, `tests/static/cp2_daily_writes_via_rpc_static.test.js`, `tests/daily_*.spec.js`                                                 |
| Feed planning            | `src/lib/feedPlanner.test.js`, `src/lib/feedOrderBasis.test.js`, `tests/static/feed_order_board_static.test.js`                                                 |
| Pig                      | `src/lib/pig*.test.js`, `tests/pig_*.spec.js`                                                                                                                   |
| Broiler/layer            | `src/lib/broiler.test.js`, `src/layer/*.test.js`, `tests/broiler_*.spec.js`, `tests/layer_*.spec.js`                                                           |
| Equipment                | `src/lib/equipment.test.js`, `tests/static/equipment_*.test.js`, `tests/equipment_*.spec.js`                                                                    |
| Login/offline webforms   | `tests/static/light_user_portal_static.test.js`, `tests/offline_*.spec.js`, `tests/team_availability.spec.js`, `tests/daily_report_photos.spec.js`             |
| Storage/media guards     | `tests/static/*storage*.test.js`, `tests/static/*photo*.test.js`, `tests/static/image_file_input_capture_static.test.js`                                       |
| Runtime observability    | `tests/static/error_resilience_static.test.js`, `tests/static/client_error_boundary_static.test.js`, `tests/static/client_errors_review_static.test.js`          |

Playwright notes:

- Specs that reset the shared TEST DB must run one file at a time.
- Local dev-server cold-start can hang if stray node/vite processes remain in
  old worktrees. Clear stale processes before diagnosing product flake.
- The forecast Activity Playwright spec shipped but historically hit local
  cold-start setup timeouts; static and direct TEST checks covered the contract.

---

## Agent Session Checklist

Before a new lane:

1. Read [HO.md](HO.md).
2. Read Current State, Recommended Work Queue, and the relevant contracts here.
3. Run `git status --short` and inspect recent `git log`.
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
  `C:\Users\Ronni\cc-research\`.
- Detailed build history lives in git log and tests. Keep this file as the
  compact project map, not a running transcript.
