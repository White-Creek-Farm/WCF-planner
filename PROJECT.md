# WCF Planner

Farm-management web app for White Creek Farm. React/Vite single-page app,
Supabase backend, Netlify production deploy from GitHub `main`.

This file is the durable project map: current state, architecture, roadmap, and
load-bearing contracts. Workflow, roles, gates, and relay format live in
[HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-06-08.
Current production checkpoint: integrated `main` commit `91546a7` — a seven-lane
ship (Lane 0 InlineNotice correctness; Lane A processing-batch lifecycle RPCs +
cattle.breeding Activity mount; Codex Lanes B/C/D/E/F/G/K). PROD-deployed and
verified live at wcfplanner.com by Netlify bundle-hash match (`main-DZOL_lsp.js`)
to the local integrated build. Migration series live through 100.
Production URL: https://wcfplanner.com.

---

## Start Here

1. Read [HO.md](HO.md) for workflow and gates.
2. Read this file's Current State, Build Queue, and the relevant contracts.
3. Run `git status --short` and inspect recent `git log` before planning or
   editing.
4. Inspect the files in scope before changing anything.

Default session model: Codex plans/reviews, CC builds/validates, Ronnie approves
commit/push/PROD gates. Codex may build or edit only when Ronnie assigns it.

This file should answer "what is true now?" at the start of a session. Use git
history and tests for detailed lane history.

---

## Project Map Governance

This file is a docs-as-code project map, not a session log, scratchpad, or
append-only changelog. It uses project-specific rules first, with these external
references as guard rails:

- Diataxis documentation structure: separate reference, explanation, how-to, and
  tutorial content. `PROJECT.md` is durable reference plus brief explanation;
  procedural workflow belongs in `HO.md`, and detailed history belongs in git or
  `archive/SESSION_LOG.md`. Reference: https://diataxis.fr/.
- RFC 2119 / RFC 8174 requirement language: capitalized `MUST`, `MUST NOT`,
  `SHOULD`, `SHOULD NOT`, and `MAY` carry normative force. Use them only for
  rules future agents must preserve. References:
  https://datatracker.ietf.org/doc/rfc2119/ and
  https://datatracker.ietf.org/doc/rfc8174/.
- Google developer documentation style: project-specific style comes first, then
  a general developer-doc style guide for clarity and consistency. Reference:
  https://developers.google.com/style/.
- Google documentation best practices: keep docs minimal and accurate, update
  docs with code, delete dead documentation, and avoid duplication. Reference:
  https://google.github.io/styleguide/docguide/best_practices.html.

Rules for editing this file:

- Build Queue is the only home for outstanding build/design work. Do not hide
  "future", "needs", "still needs", "TODO", or "TBD" work in later sections.
- Contract sections describe current architecture, standards, and guard rails.
  If a contract is aspirational rather than true, move the work to Build Queue
  and state the current guard/inventory honestly.
- Current State and Latest Shipped Checkpoint summarize what is live now.
  Detailed lane narrative belongs in git history or the archive, not here.
- Inventory counts, migration state, test names, and owner lists must match the
  source/static guards at the time of edit. Prefer pointing to the guard as the
  source of truth instead of duplicating fragile counts here.
- Every Build Queue item should state class (`DEFECT`, `DECISION`, `ENH`),
  scope, success criteria, validation/guard target, and any migration/PROD gate
  once it is promoted into an active lane.
- Remove or reconcile stale text instead of appending corrections nearby. The
  file should read as one coherent project map written intentionally.
- Normal build/hotfix lanes must not edit this file unless Ronnie explicitly
  requests docs, wrap, or a named `PROJECT.md` change.

- Design/function invariants that govern cross-surface behavior now live in
  `## Global Decisions (Constitution)` and `## Design System`.

## Global Decisions (Constitution)

The following decisions are locked and govern future builds. New code and surface
changes MUST conform unless this section is amended.

Rules (normative):
- Global Decisions are loaded from this section and enforced with lane guard
  targets.
- No surface may silently diverge from a locked decision. New exceptions MUST be
  added to `## Intentional Non-Uniformities` with justification.
- Changing any locked decision requires a Ronnie-approved amendment in this file
  and the relevant guard target in the same change.
- This lock covers the decisions and functional invariants in this section plus
  the entire `## Design System` section. The rest of `PROJECT.md` (Current State,
  Build Queue, inventories, contract narrative) updates normally under
  `## Project Map Governance`.
- The entire `## Design System` section is a Global Decision: its tokens, palette,
  elevation, z-index ladder, canonical components, and iconography policy MUST NOT
  change except by amendment.
- Agents MAY propose amendments with rationale and evidence; Ronnie ratifies.

| Decision | Status | Evidence |
| --- | --- | --- |
| 1 Font scale | Ratified; enforcement pending | Lane I guard target (not yet built) |
| 2 Button corners | Ratified; enforcement pending | Lane I guard target (not yet built) |
| 3 Confirm/Delete stacking | Ratified; enforcement pending | Lane I guard target (not yet built) |
| 4 Button height/padding | Ratified; enforcement pending | Lane I guard target (not yet built) |
| 5 Save model (Submit vs autosave) | Ratified; enforcement pending | Lane D save/autosave guard (static + Playwright) |

1. Font sizes use a clean px scale. Canonical set: `10, 11, 12, 13, 14, 15, 16, 18,
   20, 22, 26`. Lift `9 -> 10`, fold `17 -> 18`, `24 -> 22`, `28 -> 26`.
   Display whitelist remains `32/34/36/48/56` for hero-only usage. Fractional
   font values (`12.5`, `10.5`) are forbidden.
   - Guard target (Lane I, not yet built): a `typography_tokens` static clamp to
     this set. Decision is ratified; automated enforcement is pending Lane I.

2. Button corners use canonical `6px` radius. The values `7` and `8` are retired.
   Canonical radius set is `{4, 6, 10, 14, 999, '50%'}`.
   - Guard target (Lane I, not yet built): a `border_radius_scale` static clamp.
     Decision is ratified; automated enforcement is pending Lane I.

3. Confirm/Delete dialogs remain top-tier destructive overlay priority at
   toast (`9000`) so confirm stacks are never visually hidden.
   - Guard target (Lane I, not yet built): a `zindex_scale` static clamp.
     Decision is ratified; automated enforcement is pending Lane I.

4. Button vertical pad defaults to `10px`; the standard button pad is `10px 16px`.
   - Guard target (Lane I, not yet built): a `button_control_tokens` static clamp.
     Decision is ratified; automated enforcement is pending Lane I.

5. Save model is contractually split by surface:
   - Submit-style surfaces (daily reports, webforms, modals) use explicit Save/
     Submit controls.
   - Edit-in-place surfaces (record pages, weigh-in entry) use autosave.
   - Guard target: Lane D save/autosave coverage and Playwright.

### Locked functional invariants

These load-bearing behaviors are Global Decisions, defined in full in the
referenced contract sections. This table designates them amendment-locked: new or
changed code MUST conform, and changing one requires a Ronnie-approved amendment
plus a guard update in the same change.

| Invariant | Contract section | Guard |
| --- | --- | --- |
| Single Supabase client owner; no unapproved browser secrets | Cross-App Rules | `supabase_client_owner_static.test.js`, `browser_secret_boundary_static.test.js` |
| Permissions enforced by RLS/RPC, never UI alone | Authentication And Roles | `light_user_portal_static.test.js` |
| Route aliases only in `src/lib/routes.js` | Route Ownership | `url_alias_redirects.spec.js` |
| Fail-closed loading order (record + list) | Cold-Boot And Fail-Closed Loading | `load_retry_robustness_inventory_static.test.js` |
| Audit-critical mutations via SECDEF RPC; no client writes to activity, comments, or notifications | Entity Mutations And Audit Atomicity; Activity, Comments, Mentions, Notifications | `mutation_semantics_inventory_static.test.js` |
| Daily edits/deletes via ownership RPCs; soft-delete protected roots | Daily Reports; Delete, Restore, And Recovery | `cp2_daily_writes_via_rpc_static.test.js` |
| One canonical component per UI role | Shared UI And Record Chrome; Design System | `shared_ui_extraction_contract_static.test.js` |

---

## Current State

- Production deploy: Netlify auto-deploys from GitHub `main`.
- Source of truth: `origin/main`; production app/build checkpoint is commit
  `91546a7` (2026-06-08 seven-lane ship — see Latest Shipped Checkpoint). Deploy
  verified live at wcfplanner.com by Netlify bundle-hash match
  (`main-DZOL_lsp.js`) to the local integrated build, HTTP 200.
- Integrated-`main` validation at ship: `npm run lint` 0 errors,
  `npm test` 176 files / 4827 passed, `npm run build` green.
- Open gates for the shipped tree: none.
- PROD-applied numbered migration series is live through `100`. Migration `082`
  is unused; migration `083` is shelved. Operational note: the daily duplicate
  cleanup `085` was applied before unique-index migration `084`.
- Migration `100` (`processing_batch_lifecycle_rpcs`) was applied to TEST
  (`exec_sql`) then PROD (`psql --single-transaction`, `ON_ERROR_STOP=1`) and
  verified on 2026-06-08: `unschedule_cattle_processing_batch` and
  `delete_sheep_processing_batch` exist as SECURITY DEFINER with
  `search_path = public`; `authenticated` has EXECUTE, anon is revoked (REST
  probe → 401); a cattle + sheep behavioral round-trip (seed → RPC → row gone +
  `record.deleted` audit) ran clean inside a rolled-back transaction (zero PROD
  trace); PostgREST cache reload confirmed by the anon REST 401 (registered, not
  404).
- Migrations `097`–`099` were applied to TEST (`exec_sql`) then PROD
  (`psql --single-transaction`, `ON_ERROR_STOP=1`) and verified on 2026-06-06:
  `097` locks the public Tasks `submit_task_instance` to authenticated callers
  and drops the roster-membership check; `098` deletes the retired
  `webform_config` roster keys (`team_roster`, `team_members`,
  `team_availability`, `per_form_team_members`, `weighins_team_members`) and
  drops the dead `equipment.team_members` column; `099` adds the missing
  `daily_photos_auth_insert` storage policy so authenticated daily-report photo
  uploads no longer 403.
- Migration `096` (`processing_attach_activity_rpcs`) was applied to TEST with
  `exec_sql`, then PROD with `psql --single-transaction` and `ON_ERROR_STOP=1`,
  and verified on 2026-06-06: cattle/sheep attach RPCs exist, authenticated has
  EXECUTE, anon is revoked, and PostgREST cache reload was verified by anon REST
  permission denial.
- Migration `095` (`app_saved_views`, generic per-surface saved views) was
  applied to TEST then PROD and verified on 2026-06-05: table + RLS
  (public-or-owner SELECT, owner-only INSERT/UPDATE/DELETE), the owner-stamp
  (`auth.uid()`) and updated_at/owner-freeze triggers, and grants to
  `authenticated`.
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

- Seven-lane integration, migration `100`, PROD (2026-06-08, integrated `main`
  `91546a7`; CC + Codex parallel lanes). Built on parallel branches, CC-verified,
  merged in order Lane 0 → Lane A → Codex, then pushed and PROD-deployed
  (bundle-hash verified). Lanes:
  - Lane 0 (`2436b75`): InlineNotice correctness — the four flat-prop call sites
    (`CattleAnimalPage`, `SheepAnimalPage`, `MySubmissions` mutation + load
    notices) now use the canonical `notice={...}` / `onDismiss` shape (they were
    rendering nothing); added the benign `info` kind (blue) so
    `SheepDailyPage`'s "No changes to save." stops rendering as a red error; the
    legacy `CowDetail` Issues panel is suppressed inside cattle forecast
    (`hideComments`). Guard: `tests/static/inline_notice_contract_static.test.js`.
  - Lane A (`8f4bb65`): processing-batch lifecycle RPCs (migration `100`).
    `CattleBatchPage.handleUnschedule` and `SheepBatchPage.handleDeleteBatch` now
    route through the audited SECDEF RPCs `unschedule_cattle_processing_batch` /
    `delete_sheep_processing_batch` instead of direct client deletes — atomic
    straggler-clear + delete + `record.deleted` audit in one transaction. Wrapper
    `src/lib/processingBatchDeleteApi.js`.
  - Lane A (`0455540`): `CattleBreedingView` mounts the audit-only
    `cattle.breeding` workflow Activity stream (`RecordCollaborationSection`,
    entity_id `cattle-breeding`, `showComments=false`), reusing the existing
    stream populated by the mig `094` cycle RPCs. Code-only.
  - Codex Lanes B/C/D/E/F/G/K (`12cbb07`): Lane B fail-closed loading parity
    (`RecentlyDeletedDailyReports`, `CattleHerdsView`, `SheepFlocksView`,
    `MySubmissions` clear stale rows on load failure, show `InlineNotice` +
    Retry, gate content behind non-error loaded state); Lane C
    `DeleteModal`/`ConfirmModal` canonical dialog semantics (role/aria-modal/
    aria-labelledby, Escape, disabled overlay-dismiss); Lane D `EquipmentDetail`
    pending-autosave flush on blur/pagehide/visibilitychange/unmount, with CC's
    polish to re-queue a pending edit on save failure instead of dropping it;
    Lane E `EquipmentDetail` adopts `RecordPageBody`/`RecordTitle` +
    `data-equipment-record-loaded`; Lane F `SheepFlocksView` saved views via the
    existing `app_saved_views` API (`surface_key = 'sheep.flocks'`), degrading to
    an inline notice on load error; Lane G `RecentlyDeletedDailyReports` is a
    combined Recently Deleted Records surface (daily + cattle + sheep animals),
    fail-closed, dispatching the correct restore RPC by record kind; Lane K
    cattle-herd CSV export via the new `src/lib/csvExport.js` (escaping,
    formula/DDE-injection guard, Central-date filename, sole browser-download
    owner) — `CattleHerdsView` exports the filtered/sorted `sortedFlat` rows.
  - Merge note: the `MySubmissions.jsx` overlap (Lane 0 InlineNotice fix vs
    Codex's fail-closed rewrite) was resolved by keeping the Codex superset —
    both the Lane 0 `notice={...}` shape and the fail-closed hooks are preserved.
- Team-member roster teardown, migrations `097`–`099`, PROD (2026-06-06,
  commits `029b55c` + `33d10af` + `a507d90`). Every public webform submitter is
  locked to the signed-in user (no roster dropdown); the `team_roster` /
  `team_members` / `team_availability` machinery was removed front-to-back —
  `src/lib/teamMembers.js` + `teamAvailability.js` deleted (the unrelated
  `sortByDailysOrder` webforms-list ordering extracted to
  `src/lib/dailysOrder.js`), the `WebformsAdminView` roster editor replaced by a
  Public-Tasks-assignee-only tile, and all roster reads/writes + `wcf_team`
  localStorage gone. `098` drops the `webform_config` roster keys + the
  `equipment.team_members` column; `099` adds `daily_photos_auth_insert` (the
  login-required photo webforms were 403'ing authenticated uploads). The
  offline/photo Playwright specs were converted from anonymous to authenticated
  (submitter is the profile full_name, e.g. `Test Admin`). Build + vitest green
  (174 files / 4771 tests); deploy verified.
- Processing-attach RPC lane + daily edit-page locks, migration `096`, PROD
  (2026-06-06, merge `ad47fee`). Authenticated cattle/sheep
  Send-to-Processor attach flows now use transactional SECDEF RPCs for batch
  detail, animal state, transfer audit rows, weigh-in stamps, and Activity.
  Public/shared modal callers keep the legacy helper fallback. The six daily
  edit pages now lock the Team Member field to the signed-in user using the
  shared locked-field control.
- Five-lane ship, code-only except migration `095`, PROD (2026-06-05, merge
  `97da649`). Landed together and deploy-verified:
  - Cattle herd filters / row parity / saved views (migration `095`). Removed the
    local plain-English/Parse smart filter; organized always-visible filter
    groups (Core, Calving/Breeding, Lineage/Other — no Exceptions group);
    `Unmatched Calves` is a checkbox off to the right of Lineage/Other;
    non-calving is a single "No calf since" date control; flat + grouped rows
    share one `CowListRow` (calf count + last-calved parity); saved views via
    `app_saved_views` + `src/lib/savedViewsApi.js` (private/public, owner-only
    edit/delete, RLS-scoped).
  - Cattle/sheep/pig weigh-in entry debounce autosave + Days-since and signed
    +/- weight-delta chips. Per-row Save/Revert removed; edits autosave (700ms),
    on blur, and are flushed before completing a session. Pig autosaves only
    weight/note and keeps sent-to-trip / transferred rows locked.
  - Fixed record-page prev/next navigation: `RecordSequenceNav` pins Prev to the
    left screen edge and Next to the right (vertically centered, broiler
    side-nav placement), as sleek flat pills with neighbor titles + a small
    bottom-center "i of n" pill; stays available while scrolling. Broiler batch
    joined the shared nav and its custom `BatchForm` side-nav was removed.
    (Placement settled via the `22799f1` hotfix after a bottom-center version
    read as hidden.)
  - Broiler auto-processing: active batches auto-advance to `processed` on/after
    `processingDate` (inclusive) via `shouldAutoProcessBroilerBatch`, persisted in
    `loadAllData`.
  - Equipment caught-up home notices (maintenance + materials) and shared home
    alert builders in `src/dashboard/homeAlerts.js`; the Light home now shows
    read-only Missed Daily Reports, Equipment Attention, and Next 30 Days
    (equipment attention routes to `/equipment/<slug>`, never `/fleet`).
- Audited RPC follow-ups, migration `094`, PROD (2026-06-04, commit
  `235647c`). Cattle breeding cycle save/delete and sheep lambing record delete
  now route through authenticated SECDEF RPCs with `search_path = public`,
  PostgREST grants/reload, and transactional Activity writes. Client code no
  longer performs direct writes for those flows.
- Task weekly email correction, migration `093`, PROD (2026-06-04, commit
  `c0b3fed`). `tasks-summary-weekly` now runs Sunday 8am America/Chicago with
  dual UTC cron entries and helper-side DST gating. The weekly window starts at
  the previous Sunday 8am Central. Completed-assigned coverage comes from
  `task_completed` notifications owed to task creators/assignors; recipients
  are open assignees union completed-assigned recipients, assigned-only
  recipients still receive email, and both-empty recipients are skipped.

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
  exception filters backed by `src/lib/cattleHerdFilters.js`. (Superseded by the
  2026-06-05 herd-filters rewrite + saved views, migration `095` — see Latest
  Shipped Checkpoint and the Cattle And Sheep contract for the current shape.)
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

Local worktree note: the main CC worktree is at `C:\Users\Ronni\WCF-planner`
on `main`. The runtime/app production checkpoint is `91546a7` (the seven-lane
ship deployed to PROD); `main` HEAD carries the docs-reconciliation commits on
top (docs-only, no bundle change) and is pushed to `origin/main`. The Codex
worktree is at `C:\Users\Ronni\WCF-planner-codex`, parked on
`codex/parallel-worktree` reset to current `main`. The four merged lane branches
(`fix/lane0-inline-notice`, `feature/lane-a-processing-rpc`,
`feature/lane-a-cattle-breeding-activity`, `codex/lane-b-fail-closed-loading`)
were deleted after the 2026-06-08 ship. Create new scoped worktrees/branches only for active lanes, and
prune them after merge once Ronnie confirms. Per-lane worktrees need their own
`node_modules` (`npm ci`) and gitignored `.env.test*` to run tests/Playwright.
See [HO.md](HO.md) Parallel Codex Worktree.

### Build Queue

Treat these as product lanes, not hotfixes, unless Ronnie says otherwise.
This is the canonical home for outstanding build/design work; do not scatter
hidden to-do notes through later contract sections.
Shipped 2026-06-04 (removed from queue): authenticated Light-user portal CP1+CP2,
pig planned-trip weight audit, cattle missing-dam herd filters, feed second-tile
current-month pin, broiler on-farm count reconciliation, and task weekly email
correction.
Shipped 2026-06-05 (removed from queue): cattle herd filters / row parity /
saved views (migration `095`), cattle/sheep/pig weigh-in debounce autosave +
Days/delta chips, fixed record-page prev/next nav + broiler batch on the shared
nav, broiler auto-processing on processing date, equipment caught-up home
notices, and Light home alerts with shared `homeAlerts.js` builders.
Shipped 2026-06-06 (removed from queue): the Sprint 1 Lane 0 locked-submitter
item plus the full team-member roster teardown — `TasksWebform` submitter
locked to the signed-in user (migration `097`), all `team_roster` /
`team_availability` code + storage removed (migration `098`), and the
`daily_photos_auth_insert` storage policy added so authenticated photo uploads
work (migration `099`). Low-priority roster-teardown
follow-ups: delete or repurpose the skipped `broiler_weigh_in_schooners`
T_negative app_store-isolation test (now moot under the authed admin shell;
source guarantee stays locked by `tests/static/weighinswebform_no_app_store`),
and drop the now-redundant `daily_photos_anon_insert` policy once no anonymous
upload path remains.
Shipped 2026-06-08 (removed/trimmed from queue): Lane 0 InlineNotice correctness
(all four flat-prop call sites + `info` kind + forecast Issues suppression — the
final Lane 0 items); Lane A processing-batch lifecycle RPCs (migration `100`);
Lane A cattle.breeding Activity mount; and Codex Lanes B (fail-closed loading
parity on the recovery/list/MySubmissions surfaces), C (DeleteModal/ConfirmModal
canonical dialog semantics), D (EquipmentDetail autosave flush + re-queue), E
(EquipmentDetail shared record chrome), F-narrow (Sheep Flocks saved views on
`app_saved_views` surface_key `sheep.flocks`), G (combined Recently Deleted
Records recovery surface), and K-narrow (cattle-herd CSV export). The larger
Lanes A/D/E/F/K remain open for their unshipped scope (see the lane list below).

Detailed parity evidence lives in
`C:\Users\Ronni\cc-research\parity-audit-2026-06-05-CC.md`; line-level findings
stay there, not in this durable map.

Class legend: `DEFECT` = build without a product decision once scoped;
`DECISION` = Ronnie must choose product/UX/policy before build; `ENH` =
enhancement/polish lane.

Sprint assignment (executed 2026-06-08): the CC Sprints 1 + 2 (Lane 0
correctness, Lane A audit/RPC atomicity) and Codex Sprints 3 + 4 (Lanes B/C +
D/E, plus the F/G/K slices) shipped in the seven-lane integration above. Those
prompts are retired. The remaining open scope is captured in the lane list
below.

1. Lane 0 - Immediate correctness bugs. SHIPPED 2026-06-08.
   All four broken `InlineNotice` prop-shape call sites fixed, the `info` notice
   kind added, the legacy `CowDetail` Issues panel suppressed in cattle forecast,
   and the `TasksWebform` submitter locked (mig `097`, 2026-06-06). Guard:
   `tests/static/inline_notice_contract_static.test.js`.
2. Lane A - Audit, Activity, RPC atomicity, and tombstone/deleted-record design.
   PARTIAL. Class: `DEFECT`/`DECISION`. Size: large.
   Shipped 2026-06-08: processing-batch unschedule/delete moved to audited SECDEF
   RPCs (migration `100`); the cattle.breeding Activity stream is now mounted.
   Remaining: move the other audit-critical pig/broiler/layer/cattle/sheep
   destructive or multi-table flows to SECDEF RPCs where needed, ensure other
   mounted Activity streams receive meaningful events, and design the root
   hard-delete tombstone/deleted-record model before expanding physical root
   deletes.
   Guard target: extend mutation semantics, hard-delete owner, delete/recovery,
   and Activity static guards.
3. Lane B - Fail-closed loading parity. SHIPPED 2026-06-08 (core).
   `RecentlyDeletedDailyReports`, `CattleHerdsView`, `SheepFlocksView`, and
   `MySubmissions` now clear stale state on load failure, show `InlineNotice` +
   user-gated Retry, and gate content behind non-error loaded markers, locked by
   `load_retry_robustness_inventory_static.test.js`. Reopen only if a specific
   record/hub/section-home surface is found still failing open.
4. Lane C - Notice and delete-modal primitive parity. SHIPPED 2026-06-08.
   `DeleteModal`/`ConfirmModal` carry canonical dialog semantics (role,
   aria-modal/labelledby, Escape, disabled overlay-dismiss) under the expanded
   `shared_ui_extraction_contract_static.test.js`.
5. Lane D - Save/editing model policy. PARTIAL. Class: `DECISION`/`DEFECT`.
   Shipped 2026-06-08: the EquipmentDetail flush-on-blur/before-navigation
   autosave loss is fixed (pending edits flush on blur/pagehide/visibilitychange/
   unmount and re-queue on save failure).
   Remaining (DECISION): define the canonical edit/save behavior by surface type,
   decide broiler weigh-in explicit-save versus autosave parity, and define how
   global versus local save indicators represent RPC/app-store/autosave writes.
   Guard target: focused save/autosave static guards plus touched Playwright.
6. Lane E - Record-page shell and chrome parity. PARTIAL.
   Shipped 2026-06-08: `EquipmentDetail` adopted `RecordPageBody`/`RecordTitle`
   and exposes `data-equipment-record-loaded`.
   Remaining: bring `PigBatchPage` onto shared record chrome, standardize record
   widths and loaded/error hooks, expand `recordPageControls` adoption, and align
   the Sheep daily page structure with the other daily record pages.
   Guard target: record-page shell/chrome static guards and focused Playwright.
7. Lane F - List, hub, filter, sort, saved-view, and empty-state parity. PARTIAL.
   Class: `ENH`. Size: large.
   Shipped 2026-06-08: `SheepFlocksView` saved views via `app_saved_views`
   (`surface_key = 'sheep.flocks'`), capturing search + status + sort, degrading
   to an inline notice on load error.
   Remaining: bring Sheep Flocks to the full Cattle Herds filter-group/multi-sort
   model, extract drifting row/tile primitives, define which other lists get
   search/sort/saved views, standardize filtered/empty states, and keep the real
   AI filter/sort investigation layered on deterministic filters with explicit
   preview/apply behavior.
   Guard target: per-surface filter/sort tests, saved-view tests, and static
   shared-row/empty-state guards.
8. Lane G - Restore/recovery surface. SHIPPED 2026-06-08.
   `RecentlyDeletedDailyReports` is now a combined Recently Deleted Records
   surface that restores daily reports plus deleted cattle/sheep animals
   (`restoreCattleAnimal`/`restoreSheepAnimal`), fail-closed, dispatching the
   correct restore RPC by record kind.
9. Lane H - Webform/offline parity.
   Class: `DEFECT` for EquipmentFueling offline/stuck recovery gaps; `ENH` for
   consolidation and terminal-copy parity. Size: medium.
   Scope: bring EquipmentFuelingWebform onto the same offline queue and stuck
   recovery expectations as other login-gated forms, consolidate legacy
   webform paths where appropriate without breaking documented aliases, and
   standardize terminal success/queued copy and locked submitter labels.
   Guard target: offline/webform static guards and focused offline Playwright.
10. Lane I - Visual tokens, terminology, formatting, and design primitives.
    Class: `ENH`. Size: large.
    Scope: ratify and enforce the decisions in `## Global Decisions
    (Constitution)` across all surfaces: font scale, button radius/corners,
    button height/padding, dialog stacking, and Save/Submit versus autosave.
    Migrate remaining drift to shared tokens and canonical components before
    adding exceptions.
    Guard target: typography, radius, button-control, z-index, and shared-ui/token
    static guards, plus targeted visual Playwright checks where needed.
11. Lane J - Cross-cutting product and accessibility policy.
    Class: `DECISION`. Size: medium.
    Scope: decide canonical nav IA order, farm-Central date defaults across
    livestock/tasks/webforms, modal keyboard/focus/ARIA behavior, image alt text
    policy, and any baseline home-dashboard KPI rules where program differences
    still need a uniform frame.
    Guard target: route/nav/date/a11y static guards plus focused Playwright once
    decisions are made.
12. Lane K - Export/print parity. PARTIAL. Class: `DECISION`/`ENH`.
    Shipped 2026-06-08: cattle-herd CSV export — `src/lib/csvExport.js` is the
    single rows-to-CSV / Blob / object-URL / filename / revoke owner (with a
    formula/DDE-injection guard and farm-Central filename dates), and
    `CattleHerdsView` exports the active filtered/sorted `sortedFlat` rows.
    Remaining: extend the shared CSV/export model to other operational lists and
    record pages with shared column specs, keep permissions bounded to
    RLS-visible rows, and add a shared print view/stylesheet rather than
    per-section print islands.
    Guard target: column-spec/export tests and print stylesheet/screenshot checks
    (the single-download owner is now `csvExport.js`).

### Light-User Portal Contract

Locked product direction (do not re-litigate without Ronnie): authenticated-only
submission is the durable path. The migration `083` public-webform identity
approach stays shelved; do NOT build roster-id -> profile-id mapping.

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
- The Light home portal (`LightHomePortal.jsx`) shows read-only alert cards above
  the shortcut grid — Missed Daily Reports and Equipment Attention — plus a
  Next-30 events list below (only when there are events). These reuse the shared
  `src/dashboard/homeAlerts.js` builders. RLS, not UI, is the boundary: a real
  `light` user must be able to read `app_store`/equipment/`equipment_fuelings`
  for these cards, proven behaviorally by `tests/light_home_alerts.spec.js`
  (real Light auth user, not the client-only role override).

Guard rails: `light_user_portal_static.test.js`,
`daily_edit_surface_static.test.js`, `daily_soft_delete_static.test.js`, and
`cp2_daily_writes_via_rpc_static.test.js` lock the route/nav/access and
ownership-write contracts.

---

## Intentional Non-Uniformities

These differences are current product/architecture decisions, not parity defects
unless Ronnie changes the contract:

- Light users are intentionally excluded from `/weighins`; they stay contained
  to the allowed report/form, Tasks, and My Submissions surfaces.
- Migration `083` public webform submitter identity stays shelved. Do not build
  roster-id -> profile-id mapping; authenticated submitter identity is the
  durable path.
- `/webform-pigs` remains a valid legacy standalone pig daily form route/alias
  while legacy compatibility is required. Consolidation must preserve aliases.
- `egg_dailys` is intentionally not covered by the daily unique-index backstop
  and has no daily photo column/surface. Egg duplicate prevention is warning /
  pre-submit only unless a later schema lane changes it.
- Add Feed quick-log rows are not full daily reports, and missed-report checks
  exclude `source='add_feed_webform'`.
- Broiler, layer, and pig daily pages use Group copy rather than Batch copy.
- Pig planned-trip forecast weights are render-only. Latest weigh-ins do not
  change planned-trip forecast weights automatically.
- Program dashboards may show program-specific KPIs. Lane J can define a shared
  dashboard frame/baseline, but it must not force identical metrics where the
  programs genuinely differ.
- The public `#webform-container` styling (gradient submit, brand-tinted shadow,
  larger font, scoped input padding) is an intentionally self-contained design
  system, separate from the React app tokens in `## Design System`. It is not
  token drift and is excluded from the app token migration.
- `getReadableText()` in `src/lib/styles.js` returns `#0f172a`/`white` as
  auto-contrast for arbitrary colored backgrounds. These two values are
  infrastructure, not palette drift, and are exempt from the color migration.

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

Record-page prev/next sequence navigation is owned by the shared
`RecordSequenceNav` (Prev pinned to the left screen edge, Next to the right,
vertically centered — broiler side-nav placement). Broiler batch pages use the
shared component; the old bespoke `BatchForm` side-nav was removed. Nav renders
only when route state carries a valid sequence; direct links/notifications get
no nav.

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
- `093` task weekly email correction: Sunday 8am America/Chicago digest with
  dual UTC cron entries, helper-side DST gating, previous-Sunday-08:00-Central
  windowing, and completed-assigned task coverage.
- `094` audited RPC follow-ups: cattle breeding cycle upsert/delete and sheep
  lambing delete through authenticated SECDEF RPCs with transactional Activity
  writes.
- `095` `app_saved_views`: generic per-surface saved views
  (`id, surface_key, name, visibility, view_state jsonb, owner_profile_id,
  created_at, updated_at`). Server-trusted ownership — BEFORE INSERT trigger
  stamps `owner_profile_id := auth.uid()`; BEFORE UPDATE freezes owner +
  refreshes `updated_at`. RLS: public-or-owner SELECT, owner-only
  INSERT/UPDATE/DELETE; grants to `authenticated` only. First consumer is the
  cattle herds list (`surface_key = 'cattle.herds'`) via
  `src/lib/savedViewsApi.js`. Direct client CRUD is acceptable here because
  RLS scopes every operation (saved views are user preferences, not
  audit-critical entity writes). Applied TEST + PROD 2026-06-05.
- `096` processing attach Activity RPCs: authenticated cattle/sheep
  Send-to-Processor attach flows now use SECDEF RPCs that update processing
  batch detail, animal processed state, transfer audit rows, weigh-in stamps,
  and Activity atomically. Authenticated has EXECUTE; anon/PUBLIC are revoked.
  Applied TEST + PROD 2026-06-06.
- `097` public Tasks submitter lock: `submit_task_instance` now requires an
  authenticated caller, drops the `team_roster`/`team_availability` membership
  check, keeps assignee validation + idempotency, and revokes anon EXECUTE.
  Applied TEST + PROD 2026-06-06.
- `098` team-roster teardown: deletes the retired `webform_config` keys
  (`team_roster`, `team_members`, `team_availability`, `per_form_team_members`,
  `weighins_team_members`) and drops the dead `equipment.team_members` column
  (zero src references, no dependent views/policies/functions). Applied TEST +
  PROD 2026-06-06.
- `099` `daily_photos_auth_insert`: adds the missing `FOR INSERT TO
  authenticated` storage policy on the `daily-photos` bucket (mig `031` granted
  anon INSERT only), so authenticated daily-report photo uploads no longer 403
  now that the photo webforms are login-required. Applied TEST + PROD
  2026-06-06.
- `100` `processing_batch_lifecycle_rpcs`: audited SECDEF RPCs
  `unschedule_cattle_processing_batch` and `delete_sheep_processing_batch` that
  replace the last direct client hard-deletes of processing-batch roots. Each
  defensively unlinks straggler `processing_batch_id` rows, writes a
  `record.deleted` Activity event, and deletes the batch in one transaction
  (cattle unschedule is server-refused unless status `scheduled`). admin/management
  gate in-function, `SET search_path = public`, REVOKE PUBLIC/anon + GRANT
  authenticated, `NOTIFY pgrst`. The record.deleted event lives on the
  cattle.processing / sheep.processing entity and persists in the GLOBAL Activity
  log after the row is gone (per-entity read is existence-gated; full tombstone
  redesign stays out of scope). Client wrapper `src/lib/processingBatchDeleteApi.js`.
  Applied TEST + PROD 2026-06-08.

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
- `src/shared/RecordSequenceNav.jsx`: fixed prev/next record navigation pinned to
  the left/right screen edges (broiler side-nav placement).
- `src/dashboard/homeAlerts.js`: single source of truth for home/Light alert
  builders (`buildNext30Events`, `buildMissedDailyReports`,
  `buildEquipmentAttention`, `foldEquipmentFuelings`), shared by
  `HomeDashboard` and `LightHomePortal`.
- `src/lib/savedViewsApi.js`: `app_saved_views` CRUD + `buildViewState`
  (first consumer: cattle herds list).
- `src/lib/cattleHerdFilters.js`: pure cattle herd filter/sort predicates
  (vitest-locked).
- `src/lib/processingBatchDeleteApi.js`: client wrappers for the audited
  processing-batch lifecycle RPCs (`unschedule_cattle_processing_batch`,
  `delete_sheep_processing_batch`; migration `100`).
- `src/lib/csvExport.js`: the single CSV rows-to-CSV / Blob / object-URL /
  filename / revoke owner, with a spreadsheet formula/DDE-injection guard and
  farm-Central filename dates (first consumer: cattle herds export).
- `src/shared/InlineNotice.jsx`: non-blocking notices (`error`/`warning`/
  `success`/`info` kinds).
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

## Design System

### Typography

- Canonical font family: `Geist` stack from `index.html` and inheritance from
  `fontFamily: 'inherit'` on component styles.
- Canonical font-size set: `10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 26`.
- Allowed display sizes: `32, 34, 36, 48, 56`.
- Font-weight scale: `400, 500, 600, 700` only; `800` is forbidden.

### Spacing and controls

- Standard button pad is `10px 16px`.
- Standard button vertical pad is `10px`.
- Inputs/selects/textareas use radius `6`, border `1px #d1d5db`, pad `8px 11px`
  and brand focus treatment.

### Radius

- Canonical radius tokens are `4`, `6`, `10`, `14`, `999`, and `'50%'`.
- The values `7` and `8` are retired.

### Stacking and elevation

- Dialog layer order keeps Confirm/Delete at toast `9000`; other overlays and
  modals remain below that tier in the shared z-index ladder.

### Save model

- Explicit Save/Submit by surface class is mandatory for submit-style flows.
  Autosave is mandatory for edit-in-place flows. Lane D owns migration and any
  residual exceptions.

### Canonical components

- Use canonical role owners before introducing equivalent alternatives.
- Canonical owners include `RecordPageShell`, `RecordSequenceNav`,
  `recordPageControls`, and modal primitives.

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

Load/retry readiness is inventoried by
`load_retry_robustness_inventory_static.test.js`; changed surfaces must update
the guard deliberately.

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
- Mutation inventory counts live in
  `mutation_semantics_inventory_static.test.js`. New mutation sites must update
  that guard deliberately.

### Delete, Restore, And Recovery

- Hard-delete owner inventory lives in `hard_delete_owner_static.test.js`.
  Legitimate new hard-delete owners must update that guard deliberately.
- Soft-delete protected roots must not have direct client deletes: cattle, sheep,
  `cattle_dailys`, `sheep_dailys`, `poultry_dailys`, `layer_dailys`,
  `egg_dailys`, `pig_dailys`.
- Daily reports soft-delete through `soft_delete_daily_report` and restore
  through `restore_daily_report`.
- Cattle/sheep animals soft-delete/restore through their animal RPCs.
- Calving sub-row delete goes through `delete_cattle_calving_record` and logs
  `record.deleted` on the dam's `cattle.animal`.

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
- Processing-batch unschedule/delete go through the audited SECDEF RPCs
  `unschedule_cattle_processing_batch` / `delete_sheep_processing_batch`
  (migration `100`, wrapper `src/lib/processingBatchDeleteApi.js`): atomic
  straggler-unlink + delete + `record.deleted` Activity. Do not reintroduce
  direct client `.delete()` on `cattle_processing_batches` /
  `sheep_processing_batches`. The per-sheep flock-revert detach loop still runs
  client-side first via the migration `081` detach RPCs.
- `CattleBreedingView` mounts the audit-only `cattle.breeding` workflow Activity
  stream (`RecordCollaborationSection`, entity_id `cattle-breeding`,
  `showComments=false`), populated by the migration `094` cycle RPCs.
- Sheep Flocks saved views use `src/lib/savedViewsApi.js` over `app_saved_views`
  with `surface_key = 'sheep.flocks'`, capturing search + status + sort; load
  failures degrade to an inline notice and never block the flock hub.
- Cattle Herds filters/sorts live in `src/lib/cattleHerdFilters.js` (pure,
  vitest-locked); UI is `CattleHerdsView`. Filters render in three
  always-visible groups (Core, Calving/Breeding, Lineage/Other) — no "More
  filters" toggle, no Exceptions group, and no plain-English/Parse smart
  assistant. See Build Queue for the real AI filter/sort investigation.
- Non-calving is a single "No calf since [date]" control: mature cow/heifer
  (30+ months) whose last calving is missing OR before the date. Backward
  compatibility — `filters.nonCalvingCows === true` still means the
  9-months-ago default in the predicate, but the checkbox is no longer exposed.
  A `nonCalving` sort key ranks candidates first/last.
- `Unmatched Calves` is a checkbox-style filter pushed to the right of
  Lineage/Other: any sex, no matched dam, born in the last 4 months or missing
  DOB (`filters.unmatchedCalves === true`). Exception predicates compose as OR
  and still compose with herd/normal filters/search. Last-calved lookup is by
  current tag, not old tags (accepted edge).
- Flat and grouped rows render through one shared `CowListRow`, so calf count +
  last-calved metadata cannot drift between the two views (shown for females).
- Saved views: `src/lib/savedViewsApi.js` over `app_saved_views`
  (`surface_key = 'cattle.herds'`). Any authenticated user saves private or
  public views capturing `{filters, sortRules, viewMode}`; public-or-owner
  visibility, owner-only update/delete, RLS-enforced. Load failures degrade to a
  disabled picker + inline notice (the list still works).

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
- Pig weigh-in entry autosaves; the tile shows a days-since-last-weigh-in delta
  alongside the previous session so the gap between weigh-ins is visible at a
  glance.
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
- Broiler batch status auto-advances in `loadAllData` (`src/main.jsx`):
  `shouldAutoActivateBroilerBatch` promotes planned -> active on/after the hatch
  date, then `shouldAutoProcessBroilerBatch` (both in `src/lib/broiler.js`)
  promotes active -> processed on/after the processing date (inclusive of
  today). Auto-process runs after auto-activation within the same `ppp-v4`
  migration map and persists before the webform mirror sync reads the store.

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
- Weekly task email (`tasks-summary-weekly`, migration `093`) runs Sunday 8am
  America/Chicago via dual UTC cron entries with helper-side DST gating; the
  weekly window starts at the previous Sunday 8am Central. Recipients are open
  assignees unioned with completed-assigned recipients (completed-task notices
  owed to creators/assignors via `task_completed` notifications); assigned-only
  recipients still get email, both-empty recipients are skipped.

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
- Home equipment tiles show caught-up notices when all equipment maintenance and
  all equipment materials are current, mirroring the "no missing daily reports"
  state (`showEquipmentMaintenanceCaughtUp` / `showEquipmentMaterialsCaughtUp`
  in `HomeDashboard`, fed by `buildEquipmentAttention` in
  `src/dashboard/homeAlerts.js`).
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

- Design tokens and visual contract details are in `## Design System`.

- `RecordPageShell` owns record-page frame/loading/not-found/body/title chrome.
- `RecordCollaborationSection` is the only component that composes
  `CommentsSection` and `RecordActivityLog`.
- `RecordActivityLog` is audit-only and filters `comment.posted`.
- `RecordSequenceNav` is the shared sequence-navigation primitive: fixed flat
  pills pinned to the left (Prev) and right (Next) screen edges, vertically
  centered, with a small bottom-center "i of n" pill. Hooks
  (`data-record-seq-nav/-prev/-next/-position/-fixed`) are locked by the
  `*_sequence_nav.spec.js` suites. Note the fixed-position gotchas: the
  container must carry no CSS transform (a transformed ancestor re-anchors
  `position:fixed` children to itself), and the position pill stays in-flow so
  the container has a real, visible box.
- `app_saved_views` saved views are a generic per-surface primitive
  (`savedViewsApi.js`, `surface_key`); the cattle herds list is the first
  consumer. New consumers reuse the same table/API with a distinct
  `surface_key`.
- `DeleteModal` and `ConfirmModal` are app-level modal primitives. New
  destructive/confirmation flows should use them unless a documented exception
  is added to `shared_ui_extraction_contract_static.test.js`.
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
| Record pages             | `tests/static/record_page_*.test.js`, per-entity static tests, `tests/*_sequence_nav.spec.js`, `tests/record_sequence_nav_fixed.spec.js`, `tests/static/record_sequence_nav_cp3_static.test.js` |
| Home / dashboard alerts  | `tests/static/home_missed_daily_reports_static.test.js`, `tests/static/home_next_30_icons.test.js`, `tests/static/home_daily_tile_routing_static.test.js`, `tests/light_home_alerts.spec.js` |
| Readiness                | `tests/static/load_retry_robustness_inventory_static.test.js`, `tests/static/*readiness*`                                                                       |
| Mutation/delete/recovery | `tests/static/mutation_semantics_inventory_static.test.js`, `tests/static/delete_recovery_classification_static.test.js`, `tests/static/hard_delete_owner_static.test.js` |
| Cattle                   | `tests/static/cattle_*.test.js`, `tests/cattle_*.spec.js`, `src/lib/cattleHerdFilters.test.js`, `tests/static/app_saved_views_migration_static.test.js`         |
| Sheep                    | `tests/static/sheep_*.test.js`, `tests/sheep_*.spec.js`                                                                                                         |
| Daily reports            | `tests/static/daily_*.test.js`, `tests/static/cp2_daily_writes_via_rpc_static.test.js`, `tests/daily_*.spec.js`                                                 |
| Feed planning            | `src/lib/feedPlanner.test.js`, `src/lib/feedOrderBasis.test.js`, `tests/static/feed_order_board_static.test.js`                                                 |
| Pig                      | `src/lib/pig*.test.js`, `tests/pig_*.spec.js`                                                                                                                   |
| Broiler/layer            | `src/lib/broiler.test.js`, `tests/static/broiler_hatch_activation_static.test.js`, `src/layer/*.test.js`, `tests/broiler_*.spec.js`, `tests/layer_*.spec.js`    |
| Equipment                | `src/lib/equipment.test.js`, `tests/static/equipment_*.test.js`, `tests/equipment_*.spec.js`                                                                    |
| Login/offline webforms   | `tests/static/light_user_portal_static.test.js`, `tests/offline_*.spec.js`, `tests/daily_report_photos.spec.js`             |
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
2. Read Current State, Build Queue, and the relevant contracts here.
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
- Parity audit evidence for the 2026-06-05 Build Queue:
  `C:\Users\Ronni\cc-research\parity-audit-2026-06-05-CC.md`.
- Detailed build history lives in git log and tests. Keep this file as the
  compact project map, not a running transcript.
