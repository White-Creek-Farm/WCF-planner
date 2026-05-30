# WCF Planner

Farm-management web app for White Creek Farm. React/Vite SPA, Supabase backend,
Netlify production deploy from GitHub `main`.

This file is project-specific truth: current state, active roadmap,
architecture map, and load-bearing contracts. Workflow, gates, and relay format
live in [HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-05-30.

---

## Start Here

1. Read [HO.md](HO.md).
2. Read this file's Current State, Active Roadmap, and relevant Contracts.
3. Inspect `git status --short`, recent git log, and the files in the lane.

Default ownership: Codex plans/reviews; CC builds/validates. Codex edits source
only when Ronnie explicitly assigns it.

---

## Current State

- Production: `https://wcfplanner.com`
- Deploy: Netlify auto-deploy from `main`
- Production source: `origin/main` via Netlify auto-deploy.
- Latest pushed checkpoint on `origin/main`: `b848b4c`
  `feat(pig): create farm-born batches from the first farrowing record (CP1)`.
  Verify exact hashes with `git log` when a lane needs them.
- Latest shipped code checkpoints this session: legacy ActivityModal /
  ActivityPanel composer retirement from the global Activity Log, record-page
  sequence navigation CP1-CP4, and pig farrowing-created batch CP1.
- Local-only ahead of `origin/main`: none expected.
- Open gates: none for the session wrap. Public webform submitter
  completion notices are not a hotfix; they are deferred to the webform-light
  identity lane because today's public roster has no profile/email recipient.
- Operational record-page coverage as of this wrap: live for `cattle.animal`,
  `sheep.animal`, all 6 daily report types, `equipment.item`, `task.instance`,
  `weighin.session` for all 4 species, `cattle.processing` at
  `/cattle/batches/<id>`, `sheep.processing` at `/sheep/batches/<id>`,
  `layer.batch` at `/layer/batches/<id>`, `layer.housing` at
  `/layer/housings/<id>`, and `broiler.batch` at
  `/broiler/batches/<encoded name>`, and `pig.batch` at
  `/pig/batches/<group id>`. There is no remaining legacy inline ActivityPanel
  operational record workspace.
- Record-page sequence navigation is live for cattle/sheep animals, all six
  daily record pages, all weigh-in session list surfaces, tasks, equipment,
  cattle/sheep processing batches, layer batches, layer housings, and pig
  batches. It uses route state from the originating list order and hides on
  direct/deep-link opens. `broiler.batch` intentionally keeps BatchForm's
  embedded prev/next instead of adding duplicate RecordSequenceNav controls.
  Comment-photos Storage RLS hotfix is live (migration 073).
- PROD migrations live: `057` notifications, `058` activity events,
  `060` mention contract, `062` activity entity expansion, `063`
  notification activity resolution, `064` activity Phase 2 entities, `065`
  global activity log, `066` activity change events, `067` daily soft-delete,
  `068` client error events / durable client error reporting, `069` cattle
  animal soft-delete / restore, `070` daily delete for active roles, `071`
  comments foundation, `072` weigh-in session Activity entity, `073`
  comment-photos Storage RLS.
- PROD migrations drafted/stashed only: `059_daily_unique_indexes.sql` is not
  applied. `061_daily_report_soft_delete_restore.sql` is superseded by `067`.
- CI note: pig.batch cold-start record-page flakes were stabilized with a real
  `feedersLoaded` readiness signal. If verify is red, investigate the current
  failure before assuming this old pig race still applies. Do not mix unrelated
  CI-stabilization work into feature lanes.

### Shipped Checkpoint: Phase 1 Cattle Record Page + Comments Foundation

Status: live on PROD. Cattle record pages, Comments foundation, PROD migration
`071`, and the private `comment-photos` Storage bucket are shipped. Follow-up
UI hotfixes for the record title/header, cow-to-cow navigation, breeding
blacklist control, and herds-page Recently Deleted removal are also shipped.

Migration `071_comments_foundation.sql` is applied to TEST and PROD. The
`comment-photos` private Storage bucket exists on TEST and PROD.

What was built:
- Dedicated cattle animal record page at `/cattle/herds/<id>`.
- CattleHerdsView refactored as hub with CattleHerdsRouter wrapper:
  tiles navigate to record page, inline CowDetail expansion removed,
  Activity chips/modal removed, cowNavStack/cattle_comments removed,
  CollapsibleOutcomeSections updated.
- Reusable Comments layer: `comments` + `comment_edits` tables, 7 SECDEF
  RPCs (list/count/post/edit/delete comments + edit history +
  mentionable profiles), `comment_mention` notification type with direct
  entity routing columns on notifications, `list_recent_notifications`
  updated.
- CommentsSection component with @mentions (via dedicated RPC, not task
  assignees), photo/document attachments (compress + upload + signed
  URLs), inline edit with attachment add/remove, edit history display
  with previous attachments, soft-delete with non-admin redaction + admin
  audit, newest-first ordering.
- CattleAnimalPage: CowDetail fields (hideComments=true suppresses
  legacy section), CommentsSection, collapsed audit-only Activity log
  (filters out comment.posted), back navigation, hash anchor scroll for
  comment deep-links.
- comment_mention notification routing: resolveNotificationRoute handles
  comment_mention with #comment-<id> hash, Header navigates directly to
  record page URL.
- activityRegistry cattle.animal route returns /cattle/herds/<id>,
  routeToView handles cattle sub-paths.
- Static tests: cattle_record_page_static.test.js (55 tests),
  comments_foundation_static.test.js (65 tests).

Files created:
- supabase-migrations/071_comments_foundation.sql
- src/cattle/CattleAnimalPage.jsx
- src/shared/CommentsSection.jsx
- src/lib/commentsApi.js
- src/lib/commentAttachments.js
- tests/static/cattle_record_page_static.test.js
- tests/static/comments_foundation_static.test.js

Files modified:
- src/main.jsx (URL adapter for cattle herds sub-paths)
- src/cattle/CattleHerdsView.jsx (hub routing, removed inline expansion)
- src/cattle/CollapsibleOutcomeSections.jsx (onCowClick instead of
  renderCowDetail)
- src/cattle/CowDetail.jsx (hideComments prop, Issues label rename)
- src/lib/activityRegistry.js (cattle route, comment_mention routing,
  routeToView)
- src/shared/Header.jsx (comment_mention direct navigation)
- src/shared/MentionTextarea.jsx (loadProfiles prop)
- tests/static/global_activity_tile_wiring_static.test.js
- tests/static/mention_deep_links_static.test.js
- tests/static/animal_detail_age.test.js
- PROJECT.md (Codex doc updates)

E2E proof results (all passed on TEST):
- farm_team posted/listed comment
- Mention picker returns active profiles only, no role exposed
- @mention creates comment_mention notification with entity routing
- Self-mention rejected
- Edit preserves history
- Admin cannot edit others, can delete others
- Non-admin sees redacted deleted body (NULL), admin sees full body
- Activity log has zero comment.posted events for test comments
- User deletes own comment

Post-ship cleanup completed:
- Cattle record page shows the app header and a large `#tag` page title.
- Cow-to-cow links remount the record detail and keep back navigation scoped to
  actual cow-to-cow navigation.
- Breeding blacklist renders as a compact red pill; the checkbox explicitly
  overrides the global input width.
- Herds page no longer shows a Recently Deleted box. Cattle restore backend
  support remains available, but that recovery surface is not part of the herds
  page.

Follow-on status:
1. `equipment.item`, `task.instance`, all six daily report types, and
   `weighin.session` for all species have since migrated to the operational
   record-page pattern.
2. Broiler weigh-in session support, list cleanup, and focused workflow
   hardening are all shipped.

### Shipped Checkpoint: Phase 2A/2B Record Page Rollout

Status: live on PROD. Sheep animal record pages and all six authenticated daily
report record pages are shipped.

What was built:
- Dedicated sheep animal record pages at `/sheep/flocks/<id>` with app header,
  `#tag` title, SheepDetail, CommentsSection, collapsed Activity log,
  sheep-to-sheep navigation state, and retired inline expansion.
- Dedicated record pages for `poultry.daily`, `layer.daily`, `egg.daily`,
  `pig.daily`, `cattle.daily`, and `sheep.daily`, each with Comments and
  collapsed Activity history.
- Legacy Activity chips/modal surfaces retired from cattle, sheep, and all six
  daily report views. Lists now route to the durable record pages instead of
  hosting primary per-record workspaces.

Follow-up shipped after the rollout:
- Inline editing is live on all six daily record pages. Record pages open
  directly editable; no separate edit-mode button/toggle is the site standard.

Deferred from the rollout:
- Processing/batch record pages. These require identity and workflow design
  before migration.

### Shipped Checkpoint: Equipment, Task, Daily Edit, And Weigh-In Sessions

Status: live on PROD through `2924d3f`. Equipment, task, daily edit, and
all-species weigh-in session record-page work is shipped.

What was built:
- `equipment.item` record pages live at `/fleet/<id>`. Fleet tiles are
  summary/open-record surfaces only; record pages own Comments and collapsed
  Activity history. Activity routes use durable equipment IDs.
- `task.instance` record pages live at `/tasks/<id>`. Task list rows navigate
  to records, legacy `?task=<id>` redirects, and notifications use direct
  record-page routing through the explicit Header allowlist.
- `RecordActivityLog` is the shared collapsed audit-log component across
  migrated animal, daily, equipment, task, and weigh-in record pages.
- All six daily record pages are immediately editable and log saved changes via
  Activity where wired. Add Feed webform rows hide operational-only fields.
- Migration `072_weighin_session_activity_entity.sql` is applied to PROD.
  `weighin.session` is registered in Activity, the global Activity log, Header
  direct-route allowlist, and notification/deep-link routing.
- `/weigh-in-sessions/<id>` is live for cattle, sheep, pig, and broiler
  sessions. All four list views are navigation-only surfaces. Pig send-to-trip
  and transfer-to-breeding workflows live on the record page. Broiler metadata
  editing (week 4/6, team member), schooner weight grid, session notes, and
  ppp-v4 side effects (complete/reopen/delete/week-change) live on the record
  page. `LivestockWeighInsView` broiler inline workspace removed.
- Focused Playwright hardening shipped: list-to-record navigation (all 4
  species), save/reload persistence (cattle/sheep/pig), Comments hash scroll,
  cattle/sheep Send-to-Processor from record page, pig Send-to-Trip from
  record page, broiler metadata/grid/reopen E2E.

### Recent Shipped Work

| Area | State |
|---|---|
| Eggmobile 3 fallback | Live. Layer housing count fallback restored Eggmobile 3 and active layer totals. |
| Daily duplicate prevention | Live. Pre-submit duplicate guards are merged; DB unique-index migration `059` remains unapplied. |
| Broiler batch location labels | Live. Broiler daily/report dropdowns show current housing/location labels while storing the plain batch name. |
| Home Weather | Live. Tomorrow.io forecast proxy, 10-day forecast, rain/freeze focus, and animated radar are on Home. |
| Notifications Center | Live. `task_completed` and `mention` notifications use `public.notifications`; task and non-task mention deep-links are live. |
| Activity + @Mentions | Live through operational record pages where migrated. Comments, @mentions, and deep-links use the Comments foundation; legacy ActivityModal/ActivityPanel composer code is retired from `src`. Historical Activity comment RPCs remain in PROD migrations with zero client callers and must not be used for new work. |
| Global Activity Log | Live at `/activity`. Permission-filtered RPC reads `activity_events`; rows navigate to entity record pages when a registered route exists and are inert otherwise. Legacy comments, task completions, deleted-comment placeholders, and explicit system/change events show there today. New Comments foundation should keep comment text out of the global audit feed except for approved notification/deep-link metadata. |
| Activity Layer foundation | Live. `record_activity_event` records allowlisted change/lifecycle events through SECDEF RPC. Layer batch notes and equipment status are pilot surfaces. |
| Entity mutation helper | Live. `runMutation` standardizes client mutation errors plus optional best-effort Activity logging; it is not transactional. |
| Daily soft-delete + restore | Live. Transactional SECDEF RPCs `soft_delete_daily_report` / `restore_daily_report`. Soft-delete is allowed for any active authenticated role; restore remains admin-only. 6 daily entity types registered. `deleted_at`/`deleted_by` on all 6 daily tables. All read sites filtered. Admin Recently Deleted tab with restore. `record.deleted`/`record.restored` Activity events with human-readable labels. |
| Cattle soft-delete + restore | Live. Admin-only source-row soft-delete/restore for `cattle.animal` through SECDEF RPCs in migration `069`. Normal cattle reads hide deleted rows; no cattle DELETE policy remains. The herds-page Recently Deleted box was removed; restore remains a backend/admin capability for a future proper recovery surface. |
| Daily per-record Activity UI | Retired from all 6 authenticated daily views. Daily report record pages now own immediately editable fields, Comments, and collapsed Activity history. |
| Pig daily-target hotfix | Live. Pig feeder daily targets now come only from active sub-batches of active feeder groups. Parent feeder batches with zero sub-batches no longer appear in Daily Report webform active groups or Home missed-report notifications. SOWS/BOARS breeding-stock missed logic remains active. |
| Operational Record Pages foundation | Live on `cattle.animal`, `sheep.animal`, all 6 daily report entity types, `equipment.item`, `task.instance`, `weighin.session` for all 4 species, `cattle.processing`, `sheep.processing`, `layer.batch`, `layer.housing`, `broiler.batch`, and `pig.batch`. Site-wide standard is dedicated pages for operational records. Tiles/lists are clean summaries only. Record pages own fields, editing, Comments, attachments, Activity log, edit history, and future related tools. |
| Cattle processing batch record pages | Live at `/cattle/batches/<id>` for scheduled/active/complete rows. Virtual planned batches remain list-only. CommentsSection + RecordActivityLog. Complete batch weights are mobile-legible and read-only until reopened; active records use blur-save name editing with no Save Name button. Unschedule Activity deferred pending soft-delete strategy. ActivityPanel/ActivityModal retired from the list view. |
| Comment-photos Storage RLS | Live. Migration 073 adds authenticated INSERT + SELECT policies on `storage.objects` for the `comment-photos` bucket. Fixes "new row violates row-level security policy" on comment photo attachments. |
| Animal transfer handler hardening | Live. Cattle/sheep animal transfer handlers now check primary animal update errors before writing transfer audit rows, surface warning notices when audit insert fails after a successful move, and no-op when destination matches the current herd/flock. |
| Weigh-in session record pages | Live for cattle, sheep, pig, and broiler at `/weigh-in-sessions/<id>`. All 4 list views are navigation-only. Pig send-to-trip and transfer-to-breeding, broiler metadata/grid/ppp-v4 side effects all live on the record page. Focused Playwright hardening shipped for all species. |
| Record-page sequence navigation | Live. `src/shared/RecordSequenceNav.jsx` + `src/lib/recordSequence.js` thread visible list order through route state. Controls show neighbor labels and position only when a reliable sequence exists; direct URL, notification, create-flow, and deep-link opens hide them. E2E coverage exists for animals, dailys, weigh-ins, tasks, processing/batches, equipment, layer housing, and pig batches. `broiler.batch` intentionally uses BatchForm's embedded prev/next. |
| Codebase hardening and cleanup | Planned. Cleanup is a first-class roadmap track: retire deprecated UI/data paths as entities migrate, remove dead code with proof, extract shared record-page/list patterns, and document what remains intentionally legacy. |
| Error Resilience Phase 1 | Live. App-root ErrorBoundary, global `error` and `unhandledrejection` capture, and durable redacted client error events through `record_client_error` SECDEF RPC / `client_error_events` table. |
| Activity change logging | Live. Routine saved edits on migrated record pages record `field.updated`/`status.changed`/lifecycle Activity events where wired, including `cattle.animal`, `sheep.animal`, `equipment.item`, daily records, task instances, and cattle/sheep/pig weigh-in sessions. Cattle delete/restore is transactional/audited; sheep delete/restore, lifecycle/move actions, equipment child records, and admin-only documents remain deferred. |
| Stash hygiene | Complete. Three superseded WIP stashes were audited and dropped; `git stash list` verified empty and `main` matched `origin/main`. |
| Hamburger cleanup | Live. Hamburger has Home, Activity, Webforms: Dailys/Equipment, Admin/Users, Sign Out. |
| Home farrow window wording | Live. Misleading `N pending` text removed from Home Next 30 Days farrowing windows. |
| Tasks v2 | Canonical at `/tasks`; old `/my-tasks` and `/admin/tasks` are aliases. |
| RecordCollaborationSection | Live. Shared `src/shared/RecordCollaborationSection.jsx` composes `CommentsSection` + `RecordActivityLog` for one operational entity. Migrated operational record pages mount the composite instead of importing both children directly, including animals, dailys, equipment, tasks, weigh-in sessions, cattle/sheep processing, layer batch/housing, broiler batch, and pig batch. Spacing prop preserves prior layout (16 default, 0 on equipment/task). |
| Sheep processing batch record page | Live at `/sheep/batches/<id>`. `SheepBatchesView` is a navigation-only hub + router; the record page owns metadata edit (blur-save with field.updated Activity), per-sheep weight rows, detach via `detachSheepFromBatch`, and hard delete with the detach loop. Blocked-detach warnings hand off via navigation state so the hub re-surfaces them after navigate. `pinnedId` survives rename. Existing send-to-processor Playwright coverage (13 tests) intact. |
| LayerBatchStats helper | Live. `src/layer/layerBatchStats.js` extracts `HOUSING_CAPS`, `getHousingCap`, `inRange`, `calcPhaseFromAge`, `computeBatchStats`, `computeHousingStats` as pure helpers. `LayerBatchesView` calls them instead of re-inlining stat derivation; later layer.batch + layer.housing record-page migrations reuse the same helpers. Feed phase thresholds (21 day STARTER→GROWER, 140 day GROWER→LAYER) and housing active/retired date filtering preserved verbatim. |
| Layer batch + housing record pages | Live at `/layer/batches/<id>` and `/layer/housings/<id>`. `LayerBatchesView` is hub + router. `LayerBatchPage` owns metadata edit (autosave brooder/schooner with conflict detection, feed cost rates, notes field.updated Activity, Delete Batch with housings cascade) and renders housings as nav-only tiles. `LayerHousingPage` owns metadata edit + Retire (via `window._wcfConfirm`). `setLayerHousings` calls pass concrete arrays so `persistLayerHousings` + `syncWebformConfig` keep `housing_batch_map` / `full_config` in sync. |
| Broiler batch record page | Live at `/broiler/batches/<encoded name>`. `BroilerListView` is hub + router; row/card/timeline clicks navigate to the record page. `BroilerBatchPage` mounts `BatchForm` in embedded mode (Header skipped, modal overlay dropped) with `onClose` / `onNavigatePrev` / `onNavigateNext` overrides that drive URL navigation. `submit()` returns true/false; `closeForm()` propagates; `handleClose` guards `navigate()` so refused saves (blank name / hard conflict without override) keep the form open with `formNotice` instead of silently abandoning the user's edit. `pinnedId` + a URL-sync `navigate.replace` keep rename survival working; dirty form state cannot unmount BatchForm or replay `openEdit`. broiler.batch identity stays `batch.name` to preserve the existing Activity entityId contract; routes use `encodeURIComponent`. ActivityPanel/ActivityModal/wcf-entity-deep-link retired from BroilerListView. 2026-05-29 hotfix restored record-page editability by forwarding `upd`, `closeForm`, `submit`, and `parseProcessorXlsx` through `BroilerListView` to `BroilerBatchPage` / `BatchForm`. |
| Pig batch record page | Live at `/pig/batches/<group id>`. `/pig/batches` is a nav-only hub with Global ADG, Add Manual Batch, archive toggle, and `PigBatchHubTile`; the record page owns the single-batch workspace, metadata edit, sub-batches, mortality, planned trips + locks, processing trips + FCR cache, forecast/current/FCR display, send-to-trip source display, sequence navigation, and `RecordCollaborationSection` for `pig.batch`. ActivityPanel/ActivityModal/wcf-entity-deep-link retired for pig.batch. Workflows were split into `usePigMortality`, `usePigSubBatches`, `usePigPlannedTrips`, `usePigProcessingTrips`, and `PigBatchPage`. |
| Pig batch readiness stabilization | Live. `PigContext.feedersLoaded` is the real readiness signal for pig hub/record pages. `loadAllData()` resolves it in the same run as feeder app_store load, including success-with-data, success-empty, returned `{error}`, hard catch, and loadUser catch; SIGNED_OUT resets it. `PigBatchesView` exposes `data-pig-feeders-loaded` and gates Loading/not-found on `feedersLoaded`, fixing the cold-start record-page race and the empty-farm Loading-forever edge. Pig Playwright specs wait via `tests/helpers/pigReady.js`. |
| Farrowing-created pig batches | Live CP1. Saving the first farrowing record for a breeding cycle creates one `ppp-feeders-v1` farm-born `pig.batch` with deterministic id `farrowing-cycle-<cycle.id>`, `cycleId`, `farmBorn:true`, neutral `originalPigCount` from alive piglets, no fake gilt/boar split, and `startDate` from the earliest cycle farrowing date. Existing cycle-linked batches are reused untouched; later farrowing records do not duplicate or overwrite; delete/edit-away does not remove the batch. |

### Parked WIP Stash

Stash numbers can change if new stashes are added; always verify with
`git stash list` before acting. Do not pop or drop blindly.

No parked WIP stashes are expected as of 2026-05-28. The prior three
superseded stashes were audited and dropped during stash hygiene.

---

## Active Roadmap

1. Codebase hardening and cleanup - remove deprecated patterns as each entity
   migrates, classify legacy/import/test-only code, and reduce context burn for
   future sessions.
2. Record Page foundation stewardship - keep operational entities on the
   dedicated record-page pattern; no new Activity bubbles, inline record
   workspaces, or modal-based record workspaces.
3. Shared record-page shell / contracts - extract only what is proven from
   shipped record pages: header/back/title/loading/not-found conventions,
   sequence navigation placement, Comments placement, collapsed Activity audit
   log placement, and route/deep-link expectations.
4. Sheep delete/restore strategy design - decide source-row soft-delete vs
   tombstone/resolver model before implementation.
5. Audit-grade SECDEF RPCs - cattle/sheep lifecycle/status/move actions where
   mutation + Activity must be atomic.
6. Custom editable-table Activity - after record pages exist, add scoped
   history for operational tables such as cattle forecast month hide/unhide,
   feed forecast edits, breeding schedule edits, and similar table workflows.
7. Critical workflow Playwright matrix - define coverage targets, write specs
   for highest-risk uncovered paths.
8. Incremental mutation cleanup - domain by domain per Identity Map. Choose
   direct / `runMutation` / SECDEF per entity risk.
9. Shared UI extraction - extract filter bar, summary row, loading/empty/error
   patterns from views that repeat them 3+ times.
10. Deferred: webform-light user identities - replace anonymous public
   webform submitter fields with lightweight authenticated field users.
   Submitter/requester identity should come from the logged-in user, access
   can be disabled when an employee leaves, and light users should get the
   read-only field portal scope defined below.
11. Deferred: code-splitting - only when field-device measurements or
   operator pain justify it.
12. Deferred: TypeScript - gradual `allowJs` + JSDoc approach if/when
   started.

---

## Platform Roadmap

Longer-term direction organized by capability tier. Active Roadmap items
above are the near-term build queue drawn from these tiers.

### Operational Record Pages And Collaboration

Operational records use dedicated record pages as the site-wide standard.
Tiles and list rows are clean summaries only: no comment composer, no inline
comment thread, no Activity bubble, and no inline expanded record workspace.
Summary surfaces may show lightweight counts or indicators, but opening a
record navigates to that record's unique URL.

The record page is the operational workspace. It owns record fields, on-page
editing, Comments, comment attachments, comment edit history, collapsed Activity
log, related record sections, and future record-specific tools. Browser
history, refresh, bookmarks, shared links, and notification deep-links should
all target this page.

Record pages should also support view-scoped previous/next sequence navigation.
When an operator opens a record from a list, tile group, or table view, the
record page may show left/right arrows for the previous and next records in
that originating view's current filtered/sorted order. This is view order, not
global database-ID order. Direct URL opens, notification deep-links, search
opens, or views without a reliable sequence should hide or disable the arrows
unless the entity has an explicit safe default order.

The sequence arrows must show the neighboring record labels, such as
`Previous: #184` and `Next: #207`, so the operator knows where each arrow will
go before clicking. Desktop can use fixed side arrows. Mobile should use a
bottom previous/next control that does not cover editable fields. The expected
implementation is a shared record-page component plus route state/session
state passed from hubs; no database migration is expected.

Modals are allowed for narrow confirmations and small helper flows such as
delete confirmation or quick creation. Modals are not the primary workspace for
operational records, Comments, Activity, attachments, or edit history. Inline
expansion is not the primary workspace for operational records.

This foundation applies to operational farm records, including Tasks. It does
not apply to admin/config/setup records unless a later lane explicitly promotes
one to an operational record.

### Webform Identity And Submitter Attribution

Current public webforms remain no-auth where documented. Do not break existing
field workflows or make public routes require login as incidental scope in
unrelated lanes.

2026-05-29 product decision: notifying a public task submitter when the task is
completed is deferred to this identity lane. It is not a hotfix. Today's public
Task webform only stores a roster display name (`team_roster` entries are
random IDs + names, not profile IDs, and names are not unique) and collects no
email address. Do not name-match roster entries to profiles, do not add a
requester column that nothing can deliver to, and do not build an interim
requester-email lane unless Ronnie explicitly reopens that product direction.

Longer-term direction: add lightweight authenticated identities for employees
who need field access without the full planner/admin surface. Once that exists,
webforms should hardcode submitter/requester identity from the logged-in
lightweight user instead of asking the operator to choose an employee name from
a dropdown. As the lane rolls out, public webforms should be retired rather than
kept as a parallel primary path.

Light user access model:

- Authenticated, profile-backed users, distinct from public anonymous form
  visitors.
- Read-only access to all submitted webform results, including all daily
  reports for all programs and all equipment fueling/checklist submissions.
- Able to participate in tasks as real requester/submitter/assignee profiles
  once tasks move through the identity-backed path.
- No management/admin edit access by default; write access should be limited
  to the field submission/task flows explicitly designed for light users.
- Homepage should be a field portal, not the full planner dashboard: tasks
  relevant to the user plus read-only webform result views, with no hidden
  reliance on public URLs.

Expected end state:

- Former employees can be disabled centrally so they cannot keep submitting
  through old webform links.
- Random discovery of public webform URLs becomes less useful because
  meaningful submission requires an active lightweight identity.
- Task request, daily, add-feed, weigh-in, equipment, and similar webforms can
  remove employee submitter dropdowns where identity should be known.
- Durable profile IDs should back requester/submitter identity, while display
  names remain presentation only.

Do not build this inside a narrow notification, task, or public-form hotfix.
Hotfixes may add durable requester fields or server-side attribution that will
support this future lane, but the authentication/access model change needs its
own design, migration, validation, and rollout plan.

### Comments Foundation

Comments are user discussion. Activity is system/audit history. They are
separate layers even when they sit near each other on a record page.

Comments are keyed by `entity_type` + `entity_id`, so the thread belongs to the
underlying record and follows that record everywhere it appears. Comments are
not stored as `activity_events`, and posting/editing/deleting a comment must
not create routine Activity log noise. Mention notifications may be created by
comment actions, but the Activity log remains audit/system-event only.

The Comments layer supports plain text, line breaks, clickable pasted URLs,
active-user @mentions, photo/document attachments, author edit/delete,
admin delete-any, soft-delete placeholders, and visible edit history. The
normal user surface shows deleted comments as `Comment deleted`; admins can
view deleted contents/history for audit.

Canonical planned storage:

- `comments`: one row per user comment, keyed by `entity_type` + `entity_id`,
  with author profile, body, mentions, attachment metadata, edited/deleted
  metadata, and created timestamp.
- `comment_edits`: immutable edit-history rows storing the prior body, prior
  attachment state, editor, and timestamp.
- Comment attachment metadata is stored with the comment/edit record and points
  at private Storage objects. If attachments outgrow JSONB metadata, add a
  dedicated attachment table in a later migration.

If implementation chooses different table names, update this section in the
same commit so the contract stays exact.

In-record narrative fields are named `Issues`. The word `Comments` is reserved
for the discussion layer. Existing labels such as notes, comments/concerns,
operator comments, or session comments should be standardized to `Issues` as
their owning record pages are migrated. Do not perform broad schema renames
without a separate migration plan.

### Completed Phase 1 Cattle Record Page Scope

Phase 1 proved the foundation on `cattle.animal` and is live on PROD.

Required outcomes:

- Add a stable cattle animal record page route.
- Make cattle tiles/list rows open that record page.
- Remove cattle inline expansion as a primary experience.
- Remove the cattle animal edit modal as the primary edit experience.
- Cattle create modal may remain as a narrow create helper unless a later lane
  moves create flows onto record pages too.
- Move cattle animal fields and existing related cattle sections into the
  record-page workspace.
- Preserve existing cattle save semantics, including debounced/autosaved field
  changes and save-on-close/navigation where applicable.
- Add the reusable Comments layer with mentions, attachments, edit/delete,
  edit history, and soft-delete placeholders.
- Show Activity as a collapsed audit/system log, not as a bubble.
- Keep comment actions out of the Activity log.
- Wire mention notifications to the cattle record page and target comment.
- Rename visible cattle record narrative/comment-style fields to `Issues`
  where this phase touches them.
- Remove or update stale cattle tests that only prove the retired inline/modal
  behavior, replacing them with record-page tests.

Still out of scope after Phase 1:

- Migrating other entities; that is now the next active phase.
- Broad schema renames for existing in-record notes/comments fields.
- Reactions/emoji, real-time updates, or admin/config record pages.
- Production migration/deploy actions without Ronnie's separate gates.

### Codebase Hardening And Cleanup

Cleanup is a first-class roadmap track. The goal is a codebase that future
Codex/CC sessions can understand quickly without repeatedly loading obsolete
patterns, dead UI paths, or import-only data.

Cleanup rules:

- Remove deprecated code in the same entity phase that replaces it. When an
  entity moves to record pages, retire its Activity bubble, inline workspace,
  record-workspace modal, old deep-link path, and obsolete tests in that lane.
- Do not delete code by vibes. Removal needs proof: `rg`/import search,
  route/registry checks, focused tests, and a clear explanation of what
  replaced it.
- Keep compatibility code only when a live data shape, printed/public URL, or
  migration path still needs it. Mark it as legacy in `PROJECT.md` or a nearby
  comment with the condition for removal.
- Prefer deleting obsolete surfaces over hiding them behind flags once the new
  surface is validated.
- Avoid cleanup-only mega-PRs. Bundle cleanup with the domain migration that
  proves the replacement, or run small mechanical cleanup lanes with explicit
  test coverage.
- Keep source files focused. Large views should shrink as shared record-page,
  summary-list, filter-bar, and mutation primitives are extracted from proven
  repeated patterns.
- Large import artifacts, archived migrations, and test fixtures are not
  runtime app code. Do not load or reason through them in normal feature lanes
  unless the lane touches import/history/test bootstrap behavior.

Hardening sequence:

1. Record-page migration: each operational entity gets one page route, one
   summary surface, one Comments layer, and one Activity audit section.
2. Legacy UI retirement: remove Activity bubbles, ActivityModal usage, inline
   expanded record workspaces, and record-workspace edit modals for migrated
   entities.
3. Comments separation: move user discussion off legacy `activity_events`
   comment RPCs for migrated entities; keep Activity as audit/system history.
4. Mutation semantics: classify writes per entity as direct, `runMutation`, or
   SECDEF RPC. Move audit-critical flows to atomic server paths.
5. Delete/recovery: convert unsafe hard deletes to source-row soft-delete or a
   tombstone/resolver design, with restore expectations documented.
6. Identity cleanup: give `app_store` operational records stable IDs before
   adding record pages, Comments, Activity, or audit trails.
7. Shared UI extraction: extract only patterns proven across 3+ migrated
   surfaces.
8. Test matrix: each migrated entity gets static contract tests and at least
   one focused Playwright workflow covering open, edit, comment, mention, and
   Activity visibility.
9. Context hygiene: update `PROJECT.md` in each phase so future sessions know
   what is live, what is legacy, what can be ignored, and what is scheduled for
   removal.

Target cleanup outcomes:

- No Activity bubbles remain on migrated operational entities.
- No operational record's primary workspace is an inline expansion or modal.
- No new user discussion is stored in `activity_events`.
- No stale deep-link path opens a removed modal or inline panel.
- No broad feature lane needs to inspect import dumps, archived migrations, or
  unrelated legacy compatibility code.
- The Record Identity Map remains the starting point for every entity lane.

### Record Identity and Audit Coverage

Every meaningful entity needs a stable ID, human label, route/deep-link,
permission resolver, Activity/comments status, mutation path, and audit
status. The Record Identity Map below is the planning anchor. Expand it as
new entities gain Activity, mutation helpers, or delete/restore support.

### Error Resilience and Runtime Signals

Phase 1 shipped. App-root ErrorBoundary catches render/lifecycle crashes.
Global `error` and `unhandledrejection` listeners capture async/event
failures. Redacted client error events persist durably through
`record_client_error` SECDEF RPC and `client_error_events` table (migration
068). Feature-level error handling also remains (Header badges soft-fail,
RPC callers catch, offline queue classifies errors). Admin dashboard,
alerting, trend views, and external monitoring services are later tiers.

### Mutation Semantics

~200 direct `sb.from()` mutation calls exist across `src/`. Direct calls are
not automatically wrong - the missing piece is per-entity write semantics.
`runMutation` fits routine saves that want optional Activity logging. SECDEF
RPCs fit audit-critical flows where mutation and Activity must succeed or
fail together. `runMutation` caller count is not a success metric; correct
write path per entity is.

### Delete/Restore and Recovery Strategy

Daily reports and `cattle.animal` prove source-row soft-delete without
tombstones: the source row remains with `deleted_at`, and the Activity resolver
sees deleted rows. Remaining domains need deliberate design: sheep hard-delete
orphans children, and equipment/task sub-records still need per-entity recovery
decisions. Tombstones are only needed where source rows cannot remain
resolver-visible after deletion.

### Test Coverage Matrix

Test coverage is broad and changes frequently; avoid treating exact file/test
counts as durable project truth. Coverage is weighted toward tasks, activity,
and cattle soft-delete. Broader cattle CRUD, equipment lifecycle, and weigh-in
flows have thinner E2E coverage. The matrix should define which workflows must
always have Playwright coverage and fill gaps incrementally.

### Shared UI Extraction

14 shared components exist in `src/shared/`. The path is extraction from
proven patterns, not top-down design. When a pattern repeats across 3+
views (filter bar, date-grouped summary list, status indicator row,
loading/empty/error states), extract it.

### Deferred Long-Term Maturity

- TypeScript: 105k lines of pure JS. Gradual `allowJs` + JSDoc + typed
  utility modules when started, not a repo-wide conversion.
- Code-splitting: current 2 MB main chunk loads once and is browser-cached.
  Dynamic `import()` already defers xlsx and pdfjs-dist. Route-level
  splitting is justified only when field-device measurements show a problem.

---

## Record Identity Map

Compact reference for per-entity platform decisions. Default permission model
is RLS for table-backed entities and `program_access` checks for `app_store`
entities. Each operational entity needs a stable ID, route, record page,
permission resolver, mutation path, delete/recovery behavior, Comments, and
Activity logging. Expand this table as entities migrate to the operational
record-page foundation.

### Primary Operational Entities

| Entity | Stable ID | Label | Storage | Mutation | Delete | Record Page | Audit |
|---|---|---|---|---|---|---|---|
| task.instance | text | title | `task_instances` | SECDEF RPCs | hard (RPC, validated) | Live | comments + task.completed trigger + routine record-page Activity |
| poultry.daily | UUID | date + batch_label | `poultry_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| layer.daily | UUID | date + batch_label | `layer_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| egg.daily | UUID | date | `egg_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| pig.daily | UUID | date + batch_label | `pig_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| cattle.daily | UUID | date + herd | `cattle_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| sheep.daily | UUID | date + flock | `sheep_dailys` | direct | soft (SECDEF) | Live | comments + deleted/restored events |
| broiler.batch | name (string) | batch name | `app_store` ppp-v4 | direct (upsert) | TBD | Live at `/broiler/batches/<encoded name>`; BatchForm mounts in embedded mode under BroilerBatchPage; identity still batch.name (preserves Activity entityId contract); 2026-05-29 prop-forwarding hotfix restored record-page editing | partial - delete unlogged; routine field.updated via BatchForm's notes-change wiring |
| pig.batch | group id | batchName | `app_store` ppp-feeders-v1 | direct (upsert) | TBD | Live at `/pig/batches/<group id>`; `/pig/batches` is nav-only hub with Add Manual Batch; farm-born groups are created from first farrowing record using deterministic `farrowing-cycle-<cycle.id>` ids; PigBatchPage owns metadata, sub-batches, mortality, planned trips, processing trips, forecast/FCR, Comments + Activity | comments + collapsed Activity; routine field.updated coverage still partial/direct-client |
| layer.batch | UUID | name | `layer_batches` | direct | hard-cascade (housings) | Live at `/layer/batches/<id>`; BatchForm-style metadata edit modal + housings nav tiles + Add Housing helper | comments + routine field.updated for notes + status.changed on save |
| layer.housing | UUID | housing_name | `layer_housings` | direct | hard (via batch cascade) | Live at `/layer/housings/<id>`; metadata edit + Retire via `_wcfConfirm` | comments + routine field.updated on metadata edit |
| cattle.animal | UUID | tag | `cattle` | direct + `runMutation` + SECDEF delete/restore | soft (SECDEF, admin-only) | Live | comments + routine field.updated + deleted/restored events |
| sheep.animal | UUID | tag | `sheep` | direct + `runMutation` | hard-orphan (children remain) | Live | comments + routine field.updated; delete unlogged |
| weighin.session | UUID | date + species/batch/herd | `weigh_in_sessions` + `weigh_ins` | direct + app_store side effects for pig/broiler workflows | hard | Live for all 4 species | comments + routine field/status/lifecycle events |
| cattle.processing | UUID | batch name | `cattle_processing_batches` | direct + error-checked save | hard (scheduled only; active/complete not deletable) | Live at `/cattle/batches/<id>`; complete fields read-only until reopen | comments + status.changed + field.updated; unschedule Activity deferred pending soft-delete |
| sheep.processing | UUID | batch name | `sheep_processing_batches` | direct | hard (no record.deleted Activity; tombstone design deferred) | Live at `/sheep/batches/<id>`; metadata edit + per-sheep weight rows + detach via `detachSheepFromBatch`; sheep enter only via Send-to-Processor on weigh-in entry | comments + status.changed + routine field.updated for name/dates/cost/notes/weights/detach |
| equipment.item | UUID | name | `equipment` | mixed - status + admin fields via `runMutation`, detail fields direct | record itself not deletable; child fuelings/maintenance hard-delete | Live | comments + routine field.updated + status.changed; documents/child records excluded |

### Sub-Entities And Child Rows

| Entity | Storage | Parent | Record Page | Delete | Notes |
|---|---|---|---|---|---|
| weigh_in_sessions | `weigh_in_sessions` | cattle/pig/sheep/broiler | See primary `weighin.session` row | hard | SECDEF batch submit for creation |
| weigh_ins | `weigh_ins` | session | N/A child entry | hard | child entries |
| cattle_comments | `cattle_comments` | cattle.animal / legacy weigh-in notes | Legacy; do not use for new Comments | survives cattle soft-delete | Retained for legacy data and weigh-in cleanup paths; new record pages use `CommentsSection`. |
| cattle_transfers | `cattle_transfers` | cattle.animal | Parent cattle page | survives cattle soft-delete | Parent hard-delete is blocked; transfer trail remains. |
| cattle_calving_records | `cattle_calving_records` | cattle.animal | Parent cattle page | survives cattle soft-delete | `calf_id` remains on soft-delete; `dam_tag` is text. |
| sheep_comments | `sheep_comments` | sheep.animal / legacy weigh-in notes | Legacy; do not use for new Comments | hard (does not cascade) | Retained for legacy data and weigh-in cleanup paths; new record pages use `CommentsSection`. |
| cattle_breeding_cycles | `cattle_breeding_cycles` | cattle.animal | Parent cattle page | hard | |
| sheep_lambing_records | `sheep_lambing_records` | sheep.animal | Parent sheep page | hard (does not cascade) | |
| equipment_fuelings | `equipment_fuelings` | equipment.item | Parent equipment page | hard | current-reading recompute on delete |
| equipment_maintenance_events | `equipment_maintenance_events` | equipment.item | Parent equipment page | hard | |
| fuel_bills | `fuel_bills` | admin | N/A admin/config | TBD | |
| fuel_supplies | `fuel_supplies` | admin | N/A admin/config | TBD | |

### app_store JSON - Identity Notes

| Key | Domain | Notes |
|---|---|---|
| `ppp-v4` | broiler batches | `batch.name` is display ID; no UUID per record |
| `ppp-feeders-v1` | pig feeder groups + sub-batches | group-level ID exists; farm-born batches use deterministic `farrowing-cycle-<cycle.id>` IDs; sub-batch IDs are client-generated |
| `ppp-pigs-v1` | pig herd data | no per-record stable ID |
| `ppp-breeding-v1` | pig breeding cycles | no per-record stable ID |
| `ppp-farrowing-v1` | pig farrowing records | no per-record stable ID |
| `ppp-breeders-v1` | pig breeders | no per-record stable ID |
| `ppp-feed-orders-v1` | feed orders | no per-record stable ID |
| `ppp-pig-feed-inventory-v1` | pig feed inventory | no per-record stable ID |
| `ppp-poultry-feed-inventory-v1` | poultry feed inventory | no per-record stable ID |

App-store entities without stable per-record IDs cannot participate in
Activity, deep-links, or per-record audit trails until identity decisions are
made. `pig.batch` now uses feeder group `id`; `broiler.batch` intentionally
continues to use `batch.name` for entity identity to preserve its existing
Activity contract.

### Operational Record Page Migration Plan

Phase 1 (`cattle.animal`), Phase 2A (`sheep.animal`), Phase 2B (all six
daily report entity types), equipment/task, `weighin.session` for
cattle/sheep/pig/broiler, `cattle.processing`, `sheep.processing`,
`layer.batch`, `layer.housing`, `broiler.batch`, and `pig.batch` are live. They
replaced inline/list-page primary record workspaces with dedicated
record pages and reusable Comments/Activity foundation. No operational record
type should add or expand the legacy inline ActivityPanel pattern.

Operational entity types with record pages:
`cattle.animal`, `sheep.animal`, all 6 daily report entity types,
`equipment.item`, `task.instance`, `weighin.session` for all 4 species,
`cattle.processing` at `/cattle/batches/<id>`, `sheep.processing` at
`/sheep/batches/<id>`, `layer.batch` at `/layer/batches/<id>`,
`layer.housing` at `/layer/housings/<id>`, and `broiler.batch` at
`/broiler/batches/<encoded name>`, and `pig.batch` at
`/pig/batches/<group id>`.

Rollout state:

1. Completed: `cattle.animal`, `sheep.animal`, `poultry.daily`,
   `layer.daily`, `egg.daily`, `pig.daily`, `cattle.daily`, `sheep.daily`,
   `equipment.item`, `task.instance`, `weighin.session` for all species,
   `cattle.processing`, `sheep.processing`, `layer.batch`, `layer.housing`,
   `broiler.batch`, and `pig.batch`.
2. Completed: shared record-page sequence navigation is live for all migrated
   record-page surfaces where a reliable originating list order exists.
   `broiler.batch` is the intentional exception because BatchForm already owns
   embedded prev/next controls.
3. Completed CP1: farm-born pig batches are created from the first farrowing
   record for a breeding cycle, with deterministic `pig.batch` identity and
   create-only/idempotent reuse of existing linked batches.

Remaining rollout order:

1. Shared record-page shell / contracts - extract only what is proven from
   shipped record pages: header/back/title/loading/not-found conventions,
   Comments placement, collapsed Activity audit log placement, and
   route/deep-link expectations. Keep extraction thin; do not block entity
   migration on a large design-system rewrite. `RecordCollaborationSection`
   is the first proven extraction (Comments + collapsed Activity pairing).
2. Custom editable-table Activity - after record pages exist, add table-scoped
   audit/history for forecast/feed/breeding workflows. First target should be
   cattle forecast month hide/unhide.

Each phase must retire legacy Activity bubbles, record-workspace modals, and
inline expanded record workspaces for the entity it migrates. Do not leave
parallel primary experiences in place.

---

## Known Platform Risks

These are hardening priorities, not reasons to rewrite.

- Hard-delete data loss and audit blindness. Daily reports and `cattle.animal`
  now use soft-delete/restore with Activity events. Routine saved edits on
  migrated record pages log Activity events where wired, including
  cattle/sheep/pig weigh-in sessions. Sheep delete/restore, livestock
  lifecycle/move actions, equipment sub-records, broiler weigh-in sessions,
  breeding/lambing records, and task templates still need recovery and audit
  decisions. Sheep hard-delete orphans children. Cattle processing batch
  unschedule is hard-delete with no Activity event (deferred pending
  soft-delete strategy). See the Record Identity Map for per-entity delete
  behavior.
- Direct client mutations are the dominant write pattern (~200 call sites in
  `src`). Direct calls are not automatically wrong; the missing piece is
  per-entity write semantics specifying which paths should be direct,
  `runMutation`, or SECDEF RPC. Cattle/sheep animal transfers now check
  primary update failures before audit writes, but remain client-side and
  non-atomic. The Record Identity Map tracks this.
- Runtime observability is Phase 1 only. Redacted client error events now
  persist through migration 068, but there is no admin UI, alerting, trend
  view, or third-party monitoring. Keep future logging changes redacted and
  minimal.
- `runMutation` is non-transactional. If a client mutation succeeds and its
  Activity RPC fails, the data change is already committed. Audit-critical
  paths need transactional SECDEF RPCs/triggers.
- `app_store` JSON entities need stable per-record IDs before they can
  participate in Activity, deep-links, and per-record audit trails. Pig feeder
  groups now have `pig.batch` record identity via `group.id`; farm-born
  batches created from farrowing use deterministic `farrowing-cycle-<cycle.id>`
  group IDs. Broiler batches deliberately keep `batch.name` identity for
  compatibility. Pig breeding/farrowing records themselves still do not have
  operational record-page identity.
- Legacy Activity comments currently live inside `activity_events` and are
  legacy audit/comment data, not the pattern for new record pages. The new
  foundation separates Comments from Activity and the migrated operational
  record pages have retired compact Activity chips / ActivityModal. The
  ActivityPanel/ActivityModal client surfaces and legacy activity-composer
  helpers are removed from `src`; PROD legacy RPCs remain historical until a
  dedicated retirement migration.
- Deprecated UI paths and compatibility code will accumulate unless each
  record-page migration removes the old path it replaces. Cleanup is part of
  each migration lane, not optional polish.
- Playwright coverage is weighted toward tasks, activity, and cattle
  soft-delete. Broader cattle CRUD, equipment lifecycle, and weigh-in flows
  have thinner E2E coverage.
- `059_daily_unique_indexes.sql` remains unapplied. Do not apply until
  duplicate cleanup is explicitly approved and a safe `egg_dailys` scope is
  designed.
- Current main JS chunk is ~2 MB. Dynamic `import()` already defers xlsx
  and pdfjs-dist. Route-level code-splitting is deferred unless
  field-device measurements or operator pain justify it.

---

## Locked Decisions

- No Home Dashboard duplicate-report card.
- No routine duplicate-report notification fanout.
- Future duplicate handling should prevent the duplicate before save where
  possible, then use DB constraints where the scope is valid.
- `egg_dailys` gets warning/pre-submit guard only. Its current data does not
  support a safe hard unique scope.
- Deleted records need global visibility because the original summary tile may
  no longer exist. Per-record page history is not enough for recovery.
- Operational records use dedicated record pages as the site-wide standard.
  Tiles and list rows are clean summaries only.
- Activity bubbles, inline expanded record workspaces, and modal-based record
  workspaces are deprecated. Do not build new operational surfaces around
  them. Use record pages for the primary workspace.
- Modals remain acceptable for narrow confirmations and helper flows, such as
  typed delete confirmation or quick create, when they are not the primary
  record workspace.
- Each operational record page owns fields, on-page editing, Comments,
  attachments, edit history, collapsed Activity log, related sections, and
  future record-specific tools.
- Activity is Podio-style per operational record, with a separate global
  audit/recently deleted surface for deletes.
- Delete events may belong in Notifications Center because they are operational
  exceptions, not routine duplicate noise.
- Activity Log is accessible to all authenticated users and is permission
  filtered server-side. It is not admin-only.
- Comments are user discussion and Activity is system/audit history. Posting a
  comment is not an Activity log event.
- Comments are separate from existing record data fields. In-record narrative
  fields should be labeled `Issues`; reserve `Comments` for the discussion
  layer.
- Comment @mentions are active individual users only, searched by display name.
  Users cannot mention themselves. Mention notifications deep-link to the
  record page, focus Comments, and highlight the mentioned comment.
- Comments support plain text, line breaks, clickable pasted URLs,
  photo/document attachments, author edit/delete anytime, admin delete-any,
  soft-delete placeholders, and visible edit history.
- Admins can view deleted comment contents/history for audit. Normal users see
  `Comment deleted`.
- Public Task webform submitter completion notices are deferred to the
  webform-light identity lane. Do not name-match `team_roster` display names to
  profiles, and do not build requester/contact fields that have no deliverable
  recipient path unless Ronnie explicitly approves a new interim feature lane.
- Activity Layer change/lifecycle events go through `record_activity_event`,
  use `_activity_can_write`, and avoid notification fanout unless explicitly
  requested.
- `record.deleted` and `record.restored` currently mean soft-delete /
  tombstone-preserved records only. Hard-deleted entity visibility needs a
  separate tombstone/deleted-record resolver design.
- Phase 1 Activity event logging is UI-level best-effort unless a lane builds a
  transactional server RPC/trigger that mutates data and records Activity in the
  same transaction.
- Future feature lanes should identify the record/entity being changed, whether
  it needs per-record Activity/comments, how meaningful changes are logged, and
  which Playwright path proves the user workflow.
- Platform hardening should favor shared contracts that let the app grow toward
  300k+ lines without repeated per-surface invention.
- CC should not repitch skipped skill installs: UI UX Pro Max, Impeccable/Taste
  for WCF, Stop Slop, GSD, claude-mem for WCF, OpenSpec.
- `runMutation` caller count is not a success metric. The goal is correct
  write semantics per entity: direct calls for simple saves, `runMutation`
  for routine mutations that want optional Activity logging, SECDEF RPCs for
  audit-critical flows.
- Soft-delete does not require tombstones when the source row remains
  resolver-visible via `deleted_at`. Daily reports prove this model.
- Cattle soft-delete uses the source `cattle` row with `deleted_at` /
  `deleted_by`, not tombstones. Sold/deceased/processed are business states,
  not delete states. Active-herd cattle tag uniqueness remains scoped to
  `mommas`, `backgrounders`, `finishers`, and `bulls`, and excludes deleted
  rows.
- Tombstones are needed only for true hard-deleted records where source rows
  cannot remain resolver-visible and audit visibility is still required.

---

## Platform Lane Checklist

Use this checklist when planning any lane that creates, edits, deletes,
restores, completes, reopens, moves, or comments on planner records.

- Name the record/entity being changed, its stable ID, label, route, storage
  source, and permission resolver.
- Operational records need a dedicated record page unless explicitly out of
  scope. Do not add new inline expanded record workspaces or modal-based record
  workspaces.
- Keep Comments separate from Activity and from record `Issues` fields.
- Identify old code/UI being replaced and remove it in the same lane when the
  replacement is validated. If it cannot be removed yet, document why and what
  future proof allows removal.
- Use `runMutation` for routine client-side mutation consistency when it fits,
  but do not treat it as transactional.
- Use a SECDEF RPC/trigger when the data mutation and Activity event must be
  atomic.
- Log meaningful saved user actions; do not log keystrokes or noisy autosave
  ticks.
- Identify the focused Playwright path that proves the user workflow when a
  lane changes mutation behavior or adds a new surface.
- Identify delete behavior and restore expectations before modifying delete
  paths. Consult the Record Identity Map for current per-entity state.
- Identify whether the lane introduces a new unhandled runtime failure mode
  or needs error reporting coverage.
- Choose direct write vs `runMutation` vs SECDEF RPC based on entity risk
  and the Record Identity Map, not helper adoption targets.
- State commit, push, PROD migration, deploy, and docs gates separately.

---

## Architecture Map

### Stack

- React 18 + Vite.
- Supabase Auth, Postgres, RLS, Storage, Edge Functions.
- BrowserRouter with view-to-URL adapter.
- Production deploy from `main` through Netlify.

### Roles

- `admin`: all authenticated surfaces and admin controls.
- `management`: operational app access where allowed.
- `farm`: field/operator access where allowed.
- `viewer`: read-oriented authenticated access.
- Public/anon: documented public webforms only.

### Routes

Authenticated:

- `/` home dashboard
- `/tasks`
- `/activity`
- `/broiler`, `/layer`, `/pig`, `/cattle`, `/sheep`
- `/fleet`
- `/admin`

Operational record pages:

- `/cattle/herds/<id>`
- `/sheep/flocks/<id>`
- `/broiler/dailys/<id>`
- `/layer/dailys/<id>`
- `/layer/eggs/<id>`
- `/pig/dailys/<id>`
- `/cattle/dailys/<id>`
- `/sheep/dailys/<id>`
- `/fleet/<id>`
- `/tasks/<id>`
- `/weigh-in-sessions/<id>` (all 4 species live)
- Future operational entities in the Record Identity Map get a stable route
  before their tile/list surface is considered migrated.

Public:

- `/dailys`
- `/addfeed`
- `/weighins`
- `/equipment`
- `/equipment/<slug>`

Aliases:

- `/my-tasks` -> `/tasks`
- `/admin/tasks` -> `/tasks`

### Key Files

| Area | Files |
|---|---|
| App shell | `src/App.jsx`, `src/main.jsx`, `src/shared/Header.jsx` |
| Routes | `src/lib/routes.js` |
| Supabase | `src/lib/supabase.js`, `src/lib/pagination.js` |
| Tasks | `src/tasks/*`, `src/lib/tasks*Api.js`, `src/lib/tasksCenter*Api.js` |
| Notifications | `src/lib/notificationsApi.js`, `src/shared/Header.jsx` |
| Activity | `src/lib/activityApi.js`, `src/lib/activityRegistry.js`, `src/lib/globalActivityApi.js`, `src/activity/ActivityLogView.jsx` |
| Comments foundation | `src/lib/commentsApi.js`, `src/shared/CommentsSection.jsx`, and reusable record comments APIs keyed by `entity_type` + `entity_id`; `src/shared/MentionTextarea.jsx` remains the mention composer primitive. |
| Record sequence nav | `src/lib/recordSequence.js`, `src/shared/RecordSequenceNav.jsx` |
| Pig farrowing batches | `src/lib/pigFarrowBatch.js`, `src/pig/FarrowingView.jsx`, `src/pig/PigBatchesView.jsx` |
| Entity mutations | `src/lib/entityMutations.js` |
| Daily reports API | `src/lib/dailyReportsApi.js`, `src/admin/RecentlyDeletedDailyReports.jsx` |
| Public forms | `src/webforms/*` |
| Icons | `src/lib/plannerIcons.js`, `src/components/PlannerIcon.jsx` |
| Offline | `src/lib/offline*.js`, `src/lib/useOffline*.js` |

### Persistence

Hand-created prod tables that test bootstrap must seed before migrations alter
them:

`profiles`, `app_store`, `webform_config`, `poultry_dailys`, `layer_dailys`,
`egg_dailys`, `pig_dailys`, `layer_batches`, `layer_housings`.

Main table groups:

- Daily reports: `poultry_dailys`, `layer_dailys`, `egg_dailys`,
  `pig_dailys`, `cattle_dailys`, `sheep_dailys`.
- Tasks: `task_templates`, `task_instances`, `task_cron_runs`,
  `task_summary_runs`, `task_instance_*`, `task_system_rules`.
- Notifications/activity: `notifications`, `activity_events`,
  `activity_mentions`.
- Livestock: `cattle*`, `sheep*`, `weigh_in_sessions`, `weigh_ins`,
  `layer_batches`, `layer_housings`.
- Equipment/fuel: `equipment*`, `fuel_supplies`, `fuel_bills`,
  `fuel_bill_lines`, `equipment_service_materials`,
  `equipment_material_clears`.

Important `app_store` keys:

- `ppp-v4`: broiler batches.
- `ppp-feeders-v1`: pig feeder groups, sub-batches, planned trips,
  processing trips.
- `ppp-pigs-v1`, `ppp-breeding-v1`, `ppp-farrowing-v1`,
  `ppp-breeders-v1`: pig herd/breeding/farrowing data.
- `ppp-feed-orders-v1`, `ppp-pig-feed-inventory-v1`,
  `ppp-poultry-feed-inventory-v1`: feed planning.
- `ppp-pig-planned-trip-locks-v1`: pig planned-trip lock sidecar.
- `ppp-missed-cleared-v1`, `ppp-webforms-v1`: home/webform support.

Important `webform_config` keys:

- `team_roster`, `team_members`, `team_availability`
- `tasks_public_assignee_availability`
- `broiler_batch_meta`, `housing_batch_map`, `broiler_groups`,
  `active_groups`, `layer_groups`, `full_config`, `webform_settings`

Storage buckets:

- `batch-documents`
- `equipment-maintenance-docs`
- `fuel-bills`
- `daily-photos`
- `task-photos`
- `task-request-photos`
- `comment-photos` (private; Comments foundation attachments)

---

## Load-Bearing Contracts

Read the relevant contract before editing its files.

### Cross-App

- Do not change Supabase auth config in `src/lib/supabase.js` without a plan.
- Keep `wcfSelectAll`; Supabase `.limit()` silently caps at 1000.
- Keep BrowserRouter view-to-URL adapter unless doing a planned router lane.
- Do not introduce `window.confirm`, `window.alert`, or `window.prompt`.
- Use inline notices, `DeleteModal`, or typed confirmation surfaces.
- Public forms must keep no-auth access where documented.
- Netlify redirect order matters: `equipment.html` rules before SPA fallback.
- No migrations, RLS, Vault, Edge Function deploys, or production data actions
  without Ronnie's explicit gate from [HO.md](HO.md).

### Supabase And Storage

- Never delete directly from `storage.objects`; use Storage API list/remove
  recursion.
- Private buckets are read through signed URLs.
- Task photo uploads are append-only (`upsert:false`); duplicate object errors
  are retry success.
- Admin-created user emails, welcome emails, and password resets are sent by
  `rapid-processor` from `noreply@wcfplanner.com`.
- PROD `exec_sql` is forbidden.

### Tasks

- `/tasks` is canonical.
- Task writes go through v2 wrappers/RPCs only.
- Do not directly update `task_instances` or task sidecar tables from UI code.
- Do not call `generate_system_task_instance` from frontend code.
- `task_instance_photos` is canonical; legacy single-path columns are fallback
  display only.
- Header task badge soft-fails to zero and must not break Header rendering.
- Task assignee dropdowns use `loadTaskAssignableProfilesById` and fail closed
  on config read errors.

### Notifications

- Client cannot insert/delete notifications.
- Notification writes happen inside SECURITY DEFINER paths.
- Recipient-only RLS: users can select/update only their own rows.
- Recipient UPDATE grant is column-scoped to `read_at`.
- `complete_task_instance` notification insert must never roll back the task
  completion.
- Skip task-completed notification when creator is null or completer is creator.
- Valid `notifications.type`: `task_completed`, `mention`, `comment_mention`.
  New types require a migration that widens the CHECK.
- Header bell soft-fails to zero and must not break Header rendering.

### Activity, Comments, And Mentions

- Activity and Comments are separate contracts.
- Activity is system/audit history only. Comments are user discussion only.
- Live client Activity reads/writes use SECURITY DEFINER RPCs such as
  `list_activity_events`, `list_global_activity`, and
  `record_activity_event`.
- Legacy Activity composer RPCs `post_activity_comment`,
  `edit_activity_event`, `delete_activity_event`, and
  `count_activity_for_entity` remain in PROD from historical migrations but
  have zero client callers after ActivityModal/ActivityPanel retirement. Do
  not use them for new operational record pages; a future migration may revoke
  or retire them in its own lane.
- New record pages use the Comments foundation tables/APIs, not
  `activity_events`, for comment storage.
- Comments APIs/RPCs are expected to include `list_comments`,
  `count_comments`, `post_comment`, `edit_comment`, `delete_comment`, and
  `list_comment_edits`.
- No direct `.from('activity_events')`, `.from('activity_mentions')`,
  `.from('comments')`, or `.from('comment_edits')` in `src`; use the approved
  API/RPC layer.
- `_activity_can_read(entity_type, entity_id)` is fail-closed. Entity existence
  is checked before role shortcuts; admin does not bypass fake-id rejection.
- Supported entity types are: `task.instance`, `broiler.batch`, `pig.batch`,
  `layer.batch`, `layer.housing`, `cattle.animal`, `cattle.processing`,
  `sheep.animal`, `sheep.processing`, `equipment.item`, `poultry.daily`,
  `layer.daily`, `egg.daily`, `pig.daily`, `cattle.daily`, `sheep.daily`,
  `weighin.session`.
- New entity type = one permission resolver branch, one registry entry,
  stable record route/deep-link mapping, one record page surface, and a
  mutation/error/activity plan that uses `runMutation` or a SECDEF RPC where
  appropriate.
- `/activity` is a permission-filtered global audit timeline backed by
  `list_global_activity`; it must never bypass `_activity_can_read`.
- `record_activity_event` event types are server-allowlisted:
  `field.updated`, `status.changed`, `record.created`, `record.deleted`,
  `record.restored`. New event types require a migration.
- `record.deleted` and `record.restored` require the source entity to still
  exist for `_activity_can_read` / `_activity_can_write`; hard-delete audit
  visibility needs a tombstone/deleted-record design.
- Meaningful change logging must avoid keystroke/autosave noise. Prefer saved
  user actions such as notes/status/date/location/count changes.
- Pilot Activity change logging writes data first and records Activity
  best-effort. Security-critical or audit-critical paths should move toward
  server RPCs/triggers that mutate data and insert Activity in one transaction.
- Mentions store identity by profile ID. Visible body stays user-friendly
  plain `@Name`; UUIDs must not appear in body text.
- Server validates mentions: profile exists, profile active, display-name
  matched, caller can comment, and mentioned profile is not the caller.
- Mention notifications deep-link to the operational record page and identify
  the target comment so the page can focus/highlight it.
- Comment delete is soft-delete only. Authors can delete their own comments;
  admins can delete any comment. Admins cannot edit another user's comment.
- If a SECDEF RPC return shape changes, migration must end with
  `NOTIFY pgrst, 'reload schema'`.

### Entity Mutations

- `runMutation` in `src/lib/entityMutations.js` is the shared helper for
  routine client-side mutation consistency: run mutation, check error, optionally
  record Activity after success, and return `{ok, data}` or `{ok, error}`.
- `runMutation` must stay small. It must not know table names, business rules,
  entity-specific permissions, or UI components.
- `mutateFn` must return a Supabase-style `{data, error}` object. Undefined,
  null, or non-object returns are caller bugs and should fail.
- `runMutation` must never record Activity when the mutation failed.
- `runMutation` is not transactional. If the mutation succeeds and Activity
  logging fails, the data change is already committed.
- Use server-side SECDEF RPCs/triggers for audit-critical flows where mutation
  and Activity must succeed or fail together, especially delete/restore and
  lifecycle/status transitions.
- New routine save paths should prefer `runMutation` when it fits, while keeping
  domain logic in the caller.

### Daily Reports

- Add Feed quick-log rows can share daily tables but are not a substitute for a
  full daily report. Missed-report checks exclude `source='add_feed_webform'`.
- Duplicate prevention target:
  - poultry/pig/layer: `(date, batch_label)`
  - cattle: `(date, herd)`
  - sheep: `(date, flock)`
  - partial indexes exclude Add Feed rows
  - `egg_dailys`: warning/pre-submit guard only, no hard unique index yet
- Existing PROD duplicate cleanup is required before applying migration `059`.
- Daily reports use soft-delete via `soft_delete_daily_report` /
  `restore_daily_report` SECDEF RPCs. `soft_delete_daily_report` is available
  to any active authenticated role; `restore_daily_report` remains admin-only.
  All daily table reads filter `.is('deleted_at', null)`. Admin Recently Deleted
  tab shows deleted reports with restore. No hard-delete path remains for dailys.
- Delete button visibility across all 6 daily views follows
  `canDeleteDailyReport(authState)`: any truthy role except `inactive`.
- `dailyDuplicateCheck.js` excludes soft-deleted records from duplicate checks.
- Daily Report Record Pages are live for all 6 authenticated daily entities.
  They preserve the existing soft-delete/restore contracts, move per-record
  discussion to `CommentsSection`, keep Activity as collapsed audit history,
  retire daily Activity chips/modal UI, and open directly editable without a
  separate edit-mode button.
- Pig feeder daily targets come only from active sub-batches of active feeder
  groups. A parent feeder batch with zero sub-batches must not appear in the
  Daily Report webform active_groups or Home missed-report notifications.
- Home missed-report logic also includes active SOWS/BOARS breeding-stock
  groups derived from non-archived pig breeders.

### Pig

- Feeder group started counts are authoritative. Normal batches use
  `giltCount + boarCount`; farm-born batches with no sex split use neutral
  `originalPigCount` through `batchStartedCount`.
- Current count is ledger-derived, not persisted `currentCount`.
- `pig.batch` record pages are live at `/pig/batches/<group id>`. The hub at
  `/pig/batches` is navigation-only plus Global ADG, Add Manual Batch, archived
  toggle, and batch tiles. The record page owns metadata, sub-batches,
  mortality, planned trips + locks, processing trips, forecast/current/FCR
  display, send-to-trip source display, Comments, and collapsed Activity.
- Pig batch workflows are intentionally split into `PigBatchPage`,
  `PigBatchHubTile`, `usePigMortality`, `usePigSubBatches`,
  `usePigPlannedTrips`, and `usePigProcessingTrips`; do not re-inline these
  workflows into `PigBatchesView`.
- `PigContext.feedersLoaded` is the readiness boundary for pig hub/record
  pages. `PigBatchesView` exposes `data-pig-feeders-loaded`; pig Playwright
  specs should wait via `tests/helpers/pigReady.js`, not `#wcf-boot-loader`.
- Normal farm-born pig batches are created from the first farrowing record for
  a breeding cycle, not from `/pig/batches`. The generated `ppp-feeders-v1`
  batch stores `id: farrowing-cycle-<cycle.id>`, `cycleId`, `farmBorn:true`,
  neutral `originalPigCount` from alive piglets, `giltCount:0`, `boarCount:0`,
  `status:'active'`, and `startDate` from the earliest cycle farrowing date.
  Detection is by `cycleId` first, then deterministic id. Existing linked
  batches are reused untouched; later farrowing records do not duplicate or
  refresh counts; deleting/editing-away a farrowing record does not remove the
  batch. `/pig/batches` Add Manual Batch remains for manual/admin cases and
  does not offer a breeding-cycle selector in Add mode.
- Global ADG is farm-wide and stays on the hub or a future pig settings
  surface; do not duplicate it onto each pig batch record page.
- Planned-trip row shape stays exactly:
  `{id, date, sex, subBatchId, plannedCount, order}`.
- Lock state lives only in `ppp-pig-planned-trip-locks-v1`.
- `processingTrips[].subAttributions` must be stamped as
  `{subId, subBatchName, sex, count}`.
- Send-to-Trip from `/weigh-in-sessions/<id>` may reconcile a locked planned
  trip count, but cannot change the locked date. `/pig/weighins` is a list and
  navigation surface.
- Use `pigSlug` for sub-batch matching.

### Broiler And Layers

- Broiler batches live in `ppp-v4`.
- Public `/weighins` cannot read or mutate `app_store.ppp-v4` directly.
- Public week 4/6 completion uses `stamp_broiler_batch_avg` RPC.
- Do not grant anon direct `app_store` access.
- Admin weigh-in paths may use authenticated `app_store` helpers.
- Layer `current_count` is physical anchor; projected count subtracts
  mortalities since anchor.

### Feed Planning

- Feed math lives in `src/lib/feedPlanner.js`; views should not rebuild it.
- `LEAD_TIME_DAYS = 7`, `RESERVE_DAYS.default = 30`,
  `ORDER_ROUNDING_LBS = 50`, `STALE_SNAPSHOT_DAYS = 21`.
- Feed types: `pig`, `starter`, `grower`, `layerfeed`.
- Snapshot counts are anchors; today's on-hand subtracts consumption since the
  snapshot date.
- Poultry burn uses existing broiler/layer schedule helpers.

### Cattle And Sheep

- Cattle and sheep use dedicated Supabase tables, not `app_store`.
- Cattle herds: `mommas`, `backgrounders`, `finishers`, `bulls`.
- Sheep flocks: `rams`, `ewes`, `feeders`.
- Cattle animal delete/restore is admin-only through
  `soft_delete_cattle_animal` / `restore_cattle_animal`; clients have no direct
  cattle DELETE policy.
- Normal cattle read surfaces filter `deleted_at IS NULL`. Admin Recently
  Deleted surfaces may read deleted cattle through admin-gated RLS.
- Cattle active-herd tag uniqueness is `tag` where `deleted_at IS NULL` and
  herd is one of `mommas`, `backgrounders`, `finishers`, `bulls`.
- Sold/deceased/processed cattle are not delete states; they remain active
  records for delete/restore purposes.
- Processing batch detail may resolve a deleted cow by ID in admin context; do
  not add a `deleted_at` filter to `src/lib/cattleProcessingBatch.js` unless
  that workflow is redesigned.
- Cattle processing storage statuses remain `scheduled`, `active`, `complete`;
  UI may label `complete` as Processed.
- Cattle move only when Send-to-Processor promotes a row to `active`.
- `loadCattleWeighInsCached` keeps the two-query pattern. Do not rewrite to
  `!inner`.
- Old cattle tag source strings are load-bearing: `import`, `weigh_in`,
  `manual`.

### Cattle And Sheep Inputs

- Admin panel: `src/admin/LivestockFeedInputsPanel.jsx`.
- Public/new-record dropdowns hide only `status === 'inactive'`; legacy
  blank/null status remains selectable.
- Daily edit/history surfaces must load inactive referenced inputs for snapshot
  rebuilding; filter inactive rows at dropdown render sites, not load time.

### Equipment

- Logged-in Equipment: `/fleet`.
- Public equipment/fueling: `/equipment` and `/equipment/<slug>`.
- Public fueling uses `submit_equipment_fueling` RPC.
- Fuel-log edit/delete paths recompute current readings from remaining fuel logs.
- Equipment checklist/material textboxes must not reload, lose focus, or reorder
  list items on click/edit.
- Rolling materials clears are bucketed by due service cycle.

### Icons

- Use `public/icons/planner` through `PlannerIcon` or `plannerIconUrl`.
- App code must not reference `C:\Users\Ronni\OneDrive\Desktop\planner pics`.
- Do not put images inside `<option>` elements; use text fallback there.

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
|---|---|
| Routes | `src/lib/routes.test.js`, `tests/url_alias_redirects.spec.js` |
| Tasks | `tests/static/tasks_*.test.js`, `tests/tasks_v2_*.spec.js`, `src/lib/tasksCenterApi.test.js` |
| Activity | `tests/activity_navigation.spec.js`, `tests/static/activity_static.test.js`, `tests/static/global_activity_deep_links_static.test.js`, `tests/static/mention_deep_links_static.test.js`, `tests/static/activity_phase2_entities_static.test.js`, `tests/static/global_activity_log_static.test.js` |
| Operational record pages / Comments | New lanes must add focused static tests for route/deep-link contracts, no legacy Activity bubbles on migrated entities, Comments vs Activity separation, comment permissions, edit history, attachments, and mention targeting. Add Playwright for the migrated record workflow. |
| Entity mutations | `src/lib/entityMutations.test.js`, `tests/static/entity_mutations_static.test.js` |
| Daily reports | `tests/static/daily_soft_delete_static.test.js`, `tests/static/daily_duplicate_prevention_static.test.js` |
| Broiler | `src/lib/broiler.test.js`, `tests/broiler_*.spec.js`, `tests/static/weighinswebform_no_app_store.test.js` |
| Pig | `src/lib/pigForecast.test.js`, `tests/pig_*.spec.js` |
| Cattle | `src/lib/cattleForecast.test.js`, `tests/static/cattle_soft_delete_static.test.js`, `tests/cattle_*.spec.js` |
| Sheep | `tests/sheep_send_to_processor.spec.js` |
| Equipment | `tests/equipment_*.spec.js`, `tests/static/equipment_materials.test.js` |
| Offline/public forms | `tests/offline_*.spec.js`, `tests/team_availability.spec.js`, `tests/daily_report_photos.spec.js` |

---

## Archives

- Older narrative history: `archive/SESSION_LOG.md`.
- Research, screenshots, audits, and video evaluations:
  `C:\Users\Ronni\cc-research\`.
- Use git log for detailed shipped-code history; keep this file as the compact
  project map.
