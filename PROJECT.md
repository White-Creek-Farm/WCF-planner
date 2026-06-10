# WCF Planner

Farm-management web app for White Creek Farm. React/Vite single-page app,
Supabase backend, Netlify production deploy from GitHub `main`.

This file is the durable project map: current state, architecture, roadmap, and
load-bearing contracts. Workflow, roles, gates, and relay format live in
[HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-06-10.
Current pushed checkpoint: `origin/main` commit `d7fc2c9` (all source pushed; no
docs-vs-code split). On top of the `ab39eb2` three-lane ship, 2026-06-10 pushed
two integrations: (1) two power-failure-recovery lanes — source-wide
record/shared/auth visual-token closure + the Pig Batches unified inspection grid
(`b192a2a`, merged `434c6b3`), and the daily-photo anon-policy drop (migration
`109`) + roster-teardown cleanup (`44be516`, merged `a3e6220`); and (2)
operational-list parity — right-sized search/filter/sort/saved-views + filtered
CSV/print across six hubs (Pig, Cattle, Broiler, Layer, Sheep Batches +
Equipment Fleet; Layer + Sheep also converted cards→unified grid) (`21a4532`,
merged `6b650aa`), plus the scoped modal/action token closure, Lane E/I
(`49a94f9`, merged `d7fc2c9`). Netlify auto-deploys from GitHub `main`; `d7fc2c9`
was live-verified on 2026-06-10 by asset-hash rotation to
`assets/main-CkhY001g.js` (matching the local build).
Migration series live through 109 (`109` PROD-applied 2026-06-10).
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
| 1 Font scale | Ratified; shared-token enforcement active, source-wide cleanup ongoing | `design_token_contract_static.test.js`, `record_page_shell_static.test.js` |
| 2 Button corners | Ratified; shared-token enforcement active | `design_token_contract_static.test.js` |
| 3 Confirm/Delete stacking | Ratified; enforcement active for shared modal tier | `design_token_contract_static.test.js`, `shared_ui_extraction_contract_static.test.js` |
| 4 Button height/padding | Ratified; shared-token enforcement active | `design_token_contract_static.test.js` |
| 5 Save model (Submit vs autosave) | Ratified; current model guarded | `save_model_contract_static.test.js` |

1. Font sizes use a clean px scale. Canonical set: `10, 11, 12, 13, 14, 15, 16, 18,
   20, 22, 26`. Lift `9 -> 10`, fold `17 -> 18`, `24 -> 22`, `28 -> 26`.
   Display whitelist remains `32/34/36/48/56` for hero-only usage. Fractional
   font values (`12.5`, `10.5`) are forbidden.
   - Guard: `design_token_contract_static.test.js` and
     `record_page_shell_static.test.js` cover the shipped shared-token slice.
     Source-wide cleanup remains Lane I follow-up work.

2. Button corners use canonical `6px` radius. The values `7` and `8` are retired.
   Canonical radius set is `{4, 6, 10, 14, 999, '50%'}`.
   - Guard: `design_token_contract_static.test.js` covers the shipped shared
     radius/token slice.

3. Confirm/Delete dialogs remain top-tier destructive overlay priority at
   toast (`9000`) so confirm stacks are never visually hidden.
   - Guard: `design_token_contract_static.test.js` plus the shared modal
     extraction guard.

4. Button vertical pad defaults to `10px`; the standard button pad is `10px 16px`.
   - Guard: `design_token_contract_static.test.js`.

5. Save model is contractually split by surface:
   - Submit-style surfaces (daily reports, webforms, modals) use explicit Save/
     Submit controls.
   - Edit-in-place surfaces (record pages, weigh-in entry) use autosave.
   - Guard: `save_model_contract_static.test.js` plus touched Playwright when a
     surface behavior changes.

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
- Current `origin/main`: `d7fc2c9` (all source pushed; no docs-vs-code split). On
  top of the `ab39eb2` three-lane ship, 2026-06-10 pushed: the two
  power-failure-recovery lanes (record/shared/auth token closure + Pig Batches
  unified grid, `b192a2a`→`434c6b3`; daily-photo anon-policy drop migration `109`
  + roster cleanup, `44be516`→`a3e6220`), then operational-list parity across six
  hubs (`21a4532`→`6b650aa`) and the scoped modal/action token closure, Lane E/I
  (`49a94f9`→`d7fc2c9`). See Latest Shipped Checkpoint for per-lane detail.
- Live verification: `https://wcfplanner.com/` served `assets/main-CkhY001g.js`
  after the `d7fc2c9` push (asset-hash rotation), matching the local build and
  confirming the runtime deployed, not merely that `origin/main` advanced.
- Integrated-`main` validation before the final push: `npm run lint` 0 errors,
  `npm test` 206 files / 5485 passed, `npm run build` green.
- Local main dirty state: only untracked local artifacts remain — the homepage
  design reference folder (`WCF Planner Redesign/`) and throwaway screenshot
  folders (`cp4-shots/`, `lanee-shots/`). None are production source; all are
  intentionally excluded from commits.
- Migration `109` (`drop_daily_photos_anon_insert`) applied to TEST (`exec_sql`)
  then PROD (`psql --single-transaction`, `ON_ERROR_STOP=1`) and verified
  2026-06-10: precheck found all three daily-photos storage policies present; the
  apply dropped only the dead anon-insert policy (the daily-report forms are
  login-required — uploads run authenticated under `daily_photos_auth_insert`
  (`099`), signed-URL reads under `daily_photos_auth_select` (`031`)); postcheck
  confirms `daily_photos_anon_insert` absent and both auth policies present. Zero
  runtime code impact; an authenticated daily-photo upload round-trip passed on
  TEST with the anon policy dropped.
- Migrations `105`-`108` applied to PROD and verified 2026-06-09: `105`
  `create_recurring_task_template` (non-admin recurring-task creation via the New
  Task modal); `106` `delete_layer_batch`, `107` `delete_fuel_bill`, `108`
  `delete_feed_input` (audited transactional cascade-delete RPCs for the layer
  batch+housings, fuel bill+lines, and feed input+tests roots). Each is SECURITY
  DEFINER with `search_path = public`, `authenticated` EXECUTE / anon revoked
  (REST probe 401), verified by a behavioral round-trip (seed -> RPC -> root +
  children gone + one `record.deleted` audit) inside a rolled-back transaction
  (zero PROD trace). `106` auth-gated, `107` admin-gated, `108` authenticated
  (mirrors each surface's existing access).
- Parallel worktrees: only the primary `C:\Users\Ronni\WCF-planner` (`main`) and
  `C:\Users\Ronni\WCF-planner-light-audit` (detached at `ab39eb2`) remain; the
  four merged feature worktrees/branches from this session
  (`cc/operational-list-parity-sprint`, `codex/record-token-parity-sprint`,
  `cc/list-export-closure`, `codex/record-token-closure`) were pruned after
  merge. Start a new parallel lane by creating a fresh scoped branch from current
  `main` in a worktree.
- Open code gates: none for `origin/main` `d7fc2c9`. No PROD migration, Storage,
  Vault, or Edge Function deploy gate is open.
- PROD-applied numbered migration series is live through `109`. Migration `082`
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
- Migrations `101`-`104` (Lane A audited-delete RPCs) were applied to TEST
  (`exec_sql`) then PROD (`psql --single-transaction`, `ON_ERROR_STOP=1`) and
  verified on 2026-06-09. `101` adds `delete_weigh_in_entry` /
  `delete_weigh_in_session`; `102` adds the privileged fueling delete (later
  renamed) plus `delete_equipment_maintenance_event`; `103` hardens the weigh-in
  RPCs with target-row `FOR UPDATE` (idempotent under concurrency — no
  double-audit, no false ok on a second 0-row delete); `104` renames the
  privileged fueling RPC to `admin_delete_equipment_fueling` and drops the
  colliding `delete_equipment_fueling(text,text,text)` overload while preserving
  migration `091`'s owner-scoped `delete_equipment_fueling(text)`. Each is
  SECURITY DEFINER with `search_path = public`, `authenticated` EXECUTE, anon
  revoked (REST probe → 401); behavioral round-trips (seed → RPC → row gone +
  `record.deleted` audit, plus second-delete idempotency) ran clean inside
  rolled-back transactions (zero PROD trace). Fueling delete is role-gated
  (admin/management/farm_team/equipment_tech, mirroring migration `092`);
  weigh-in and maintenance-event deletes remain authenticated-only.
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

- Operational-list parity + modal token closure, pushed `origin/main` `d7fc2c9`
  (2026-06-10). Code/tests only; no migration/storage/Vault/deploy. Two
  integrated lanes, disjoint files, conflict-free:
  - Six-hub operational-list parity (`21a4532`, merged `6b650aa`): right-sized
    search/filter/sort + saved views + filtered CSV/print on Pig Batches
    (`pig.batches`), Cattle Batches (`cattle.batches`), Broiler Batches
    (`broiler.batches`), Layer Batches (`layer.batches`), Sheep Batches
    (`sheep.batches`), and Equipment Fleet (`equipment.fleet`). Layer + Sheep
    Batches converted cards→unified inspection grid. Per-hub pure filter libs
    (`src/lib/{pig,cattle,broiler,layer,sheep}BatchFilters.js`,
    `equipmentFleetFilters.js`) own the predicate + single-rule comparator;
    saved views use the existing `app_saved_views` table + `savedViewsApi` with
    new `surface_key` strings (no migration). Broiler + Layer exports refactored
    from hard-coded subsets to the filtered+sorted set; Cattle Batch export count
    restored to attached-detail-rows only (Lane K parity with sheep); Equipment
    Fleet fuel-type filter uses the canonical `gasoline` value; Equipment Fuel
    Log gained a Retry on saved-views load failure. Validation: lint 0 errors,
    `npm test` 206 files / 5485 passed, build green, per-hub sequence-nav
    Playwright all pass.
  - Scoped modal/action token closure, Lane E/I (`49a94f9`, merged `d7fc2c9`):
    `taskModalStyles` extended to own the recurring/system task modal + lightbox
    tokens; the admin/cattle/sheep/pig/equipment action modals spread the shared
    `recordSaveButton`/`recordSecondaryButton` tokens (existing colors preserved
    via background overrides); cattle send-modal panels move retired radius `8`→
    `6`. Guards: `modal_action_tokens_static`, `task_modal_tokens_static`.
- Power-failure-recovery lanes, pushed `origin/main` `a3e6220` (2026-06-10).
  - Record/shared/auth token closure + Pig Batches unified grid (`b192a2a`,
    merged `434c6b3`): canonical font/radius conformance across 23
    record/shared/auth surfaces (guard `record_page_token_closure_static`); the
    Pig Batches hub redesigned from Active|Processed swimlanes into one unified
    vertical inspection grid (`PigBatchHubTile` card→row, shared
    `PIG_BATCH_GRID_COLUMNS`, active-first/processed-bottom sort).
  - Daily-photo anon-policy drop (migration `109`) + roster-teardown cleanup
    (`44be516`, merged `a3e6220`): drops the dead `daily_photos_anon_insert`
    storage policy (PROD-applied + verified 2026-06-10 — see Current State);
    removes the obsolete broiler `T_negative` runtime app_store-isolation test
    (source isolation still locked by `weighinswebform_no_app_store`);
    comment-only updates to the daily-photo upload helpers.
- Lane A audited-delete RPCs + Codex five-lane shared primitives, pushed source
  checkpoint `5dde0fe` (2026-06-09). PROD migrations `101`-`104` applied +
  verified (detail under Current State). Integrated validation before the final
  push: lint 0 errors, `npm test` 191 files / 5168 passed, build green; live
  post-push asset-hash rotation to `assets/main-DY8s-Ips.js`. Landed:
  - Lane A CP2 (`a417d87`, mig `101`): `delete_weigh_in_entry` /
    `delete_weigh_in_session` SECDEF RPCs — weigh-in entry/session deletes plus
    comment cleanup and `record.deleted` audit in one transaction.
  - Lane A CP3 (`428ec2e`, mig `102`/`103`): role-gated fueling delete +
    `delete_equipment_maintenance_event` SECDEF RPCs for the EquipmentDetail
    child-log deletes; `103` adds `FOR UPDATE` idempotency to the weigh-in RPCs.
  - Lane A CP3 follow-up (`5dde0fe`, mig `104`): privileged fueling RPC renamed to
    `admin_delete_equipment_fueling`, dropping the `delete_equipment_fueling`
    name collision with migration `091`'s owner-scoped delete.
  - Codex five-lane (`0e3c9e1`, merged `fcb340b`): `RecordPageLoadError` (Lane E
    CP4, seven record pages), `OperationalListEmptyState` (Lane F CP3, six daily
    hubs), `taskModalStyles` (Lane I CP5, five task modals), `dailyReportExports`
    (Lane K CP2, six daily hubs), and non-daily record action buttons on shared
    tokens (Lane E CP3). UI preview (desktop + mobile) captured + approved.
- Record-page + weigh-in shared-primitive lanes, pushed source checkpoint
  `d71f3de` (2026-06-08). Code/tests only; no PROD migration, Storage, Vault, or
  Edge Function work. Integrated validation before push: lint 0 errors,
  `npm test` 186 files / 5108 passed, build green. Live post-push probe:
  `https://wcfplanner.com/` HTTP 200 serving `assets/main-C5KiCik5.js`, matching
  the local merged build. Landed:
  - Lane I CP4 (`859696a`): the six daily record pages route Retry/Revert/Save/
    Delete through shared canonical action buttons in
    `src/shared/recordPageControls.jsx` (`recordSaveButton` /
    `recordSecondaryButton` / `recordDeleteButton`; radius 6, 10px16px pad,
    fontSize 13). Retired 7/8 radii and bespoke action padding removed; Sheep
    Save normalized blue→brand green. Add/Remove-row buttons left out of scope.
    Guard slice in `daily_record_pages_shared_controls_static.test.js`.
  - Lane J + Lane F CP2 (`04fd932`, merged `09d8c09`): image alt-text policy —
    `src/lib/imageAlt.js` (`imageAltText`) drives every user-media `<img>` owner
    with contextual fallbacks and decorative `aria-hidden`; guard
    `image_alt_text_policy_static.test.js`. Weigh-in list empty states now
    distinguish true-empty from filtered/search-no-results across cattle/sheep/
    livestock, preserving load-failure suppression.
  - Lane E CP2 (`6e31e7f`): `SheepDailyPage` drops its local `inputStyle`
    primitive and adopts the shared `recordControl` (via the `inp` alias the
    other daily pages use); feed/mineral row controls derive from it. Behavior,
    options, validation, and RPC paths unchanged; `btnSmall` row buttons kept.
    Sheep parity slice added to the shared-controls guard.
  - Lane F/K (`3e18623`, merged `d71f3de`): shared
    `src/shared/WeighInSessionListTile.jsx` (tile chrome + status badge with
    beforeStatus/afterCount/children slots, embedded variant) and
    `src/lib/weighInSessionExports.js` column builders
    (`buildRuminantWeighInSessionColumns`, `buildLivestockWeighInSessionColumns`,
    `averageEntryWeight`). Cattle/sheep/livestock views render through the tile
    and still export the filtered set; the weigh-in static guard now watches
    shared tile/helper ownership instead of duplicated view literals.

- Homepage redesign CP3 + outstanding build queue merge, pushed source
  checkpoint `99e933a` (2026-06-08, commits `93b42fd`, `d716d31`, merge
  `99e933a`). Code/assets/tests only; no new PROD migrations, Storage, Vault, or
  Edge Function work. Landed:
  - Homepage CP3 (`93b42fd`): `HomeDashboard` now uses the scoped
    `src/dashboard/homeRedesign.css` `.home.theme-crisp` treatment, the approved
    label-only program tiles, Processing/Admin utility row, live weather card,
    real Animals-on-Farm counts, blank-but-present Production card, in-app
    coming-soon destinations for not-built top-level areas, and transparent
    planner PNG icon assets. `buildEquipmentAttention` keeps full shared
    `detail` text for non-HomeDashboard consumers, while HomeDashboard uses
    `metaLabel` + `pill` for the redesigned badge layout.
  - Lane H terminal copy (`d716d31`): locked submitter/default webform copy is
    standardized to "Team member" and covered by
    `webform_terminal_copy_static.test.js`.
  - Lane I shared token slice (`d716d31`): shared button/radius/title tokens were
    tightened (`styles.js`, shared primitives, `RecordTitle` default) and locked
    by `design_token_contract_static.test.js`.
  - Lane D save-model guard (`d716d31`): `save_model_contract_static.test.js`
    locks explicit Save/Submit on daily surfaces and autosave on
    weigh-in/equipment edit surfaces.
  - Lane F parity (`775aa56` + `d716d31`): saved views and filtered CSV expanded
    across daily/weigh-in/fuel-log surfaces; Sheep Flocks gained full
    filter/sort helper parity via `src/lib/sheepFlockFilters.js`; Layer/Egg
    daily lists gained saved views and visible team filters.
  - Lane J policy/a11y (`d716d31`): `DeleteModal`/`ConfirmModal` use
    `useModalFocusTrap`, and central-date defaults are guarded across admin and
    webform entry points.
  - Lane K export/print parity (`d716d31`): `src/lib/printExport.js` owns row
    print HTML/window behavior; print/CSV coverage expanded across cattle/sheep
    inventory, daily lists, equipment fuel log, and livestock/cattle/sheep
    weigh-ins.
  Constituent validation was reported green before commit/merge: homepage CP3
  had lint/build/full tests and focused homepage/light Playwright; the Codex
  build queue had `npm test` 183 files / 5062 passed, build, lint, diff, and
  Prettier checks clean. No post-push live probe is recorded here.

- Post-seven-lane runtime queue, pushed source checkpoint `6620d5d`
  (2026-06-08, commits `053bafa` through `6620d5d`). Code-only, no new PROD
  migrations/storage/Vault actions. Landed:
  - Lane H (`053bafa`): `EquipmentFuelingWebform` submits through
    `useOfflineRpcSubmit('equipment_fueling')`, queues transient/offline RPC
    failures to IndexedDB, auto-replays, and exposes `StuckSubmissionsModal`
    recovery. Migration `047` already provided idempotent replay semantics.
  - Lane E CP1 (`797ca55`): `PigBatchPage` adopts the shared
    `RecordPageBody` loaded wrapper with `data-pig-batch-record-loaded`, using
    the approved left-aligned cap while leaving PigBatchesView ownership intact.
  - Lane K expansions (`efe24f9`, `2e06edd`, `6620d5d`): shared CSV export
    expanded beyond Cattle Herds to Sheep Flocks, Sheep Weigh-In Sessions,
    Equipment Fuel Log, and Cattle Weigh-In Sessions. Exports use
    `src/lib/csvExport.js` and the active filtered result set, not raw rows.
    `bf223c9` merged the Codex sheep CSV worktree.
  Validation before push was green (full tests/build reported clean; standard
  lint warnings only). No post-push live probe is recorded here.

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

### Current Local Gates

No PROD migration, storage, deploy, Vault, commit, push, or merge gate is open as
of `origin/main` `d7fc2c9`.

- Main CC worktree `C:\Users\Ronni\WCF-planner` is on `main` at `origin/main`
  `d7fc2c9`. The only untracked local artifacts are the homepage design reference
  folder (`WCF Planner Redesign/`) and throwaway screenshot folders
  (`cp4-shots/`, `lanee-shots/`).
- Only one parallel worktree remains: `C:\Users\Ronni\WCF-planner-light-audit`
  (detached at `ab39eb2`). The four feature worktrees/branches from this session
  (`cc/operational-list-parity-sprint`, `codex/record-token-parity-sprint`,
  `cc/list-export-closure`, `codex/record-token-closure`) were pruned after
  merge. Create a fresh scoped branch from current `main` in a worktree for the
  next parallel build lane.

If a new session sees additional dirty state, inspect it before planning; do not
assume it is disposable. Create new scoped worktrees/branches only for active
lanes, and prune them after merge once Ronnie confirms. Per-lane worktrees need
their own `node_modules` (`npm ci`) and gitignored `.env.test*` to run
tests/Playwright. See [HO.md](HO.md) Parallel Codex Worktree.

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
Additional 2026-06-08 shipped queue now on `origin/main` `d71f3de`: Lane H
EquipmentFueling offline queue + stuck recovery plus terminal-copy parity; Lane
E Pig batch `RecordPageBody` CP1 plus Sheep daily CP2 shared-control parity;
Lane I homepage redesign CP1-CP3 plus shared token/action-button guard slices;
Lane D save-model guard slice; Lane F saved-view/filter/sort parity, weigh-in
empty-state parity, and shared weigh-in tile primitives; Lane J modal focus/
central-date policy plus image alt-text policy; and Lane K CSV/print expansion
through the listed daily, weigh-in, fuel-log, inventory surfaces plus shared
weigh-in column builders. No local-only build checkpoint remains in the queue.
Additional 2026-06-09 Lane A work (PROD-applied + verified, not source-only):
weigh-in entry/session deletes (`101`) and EquipmentDetail fueling/maintenance
deletes (`102`) route through transactional audited RPCs; `103` hardens the
weigh-in delete RPCs with target-row `FOR UPDATE`; and `104` renames the
privileged fueling RPC to `admin_delete_equipment_fueling`, dropping a name
collision with the migration-`091` owner-scoped delete. Current State carries the
live PROD apply/verification detail.
Also shipped 2026-06-09 (Codex five-lane, `0e3c9e1` merged via `fcb340b`):
shared record/list/modal primitives — non-daily record-page action buttons on
shared record tokens (Lane E CP3); `src/lib/dailyReportExports.js` daily-hub
CSV/print column builders consumed by the six daily hubs (Lane K CP2);
`src/tasks/taskModalStyles.js` task-modal token extraction across the five task
modals (Lane I CP5); shared `src/shared/RecordPageLoadError.jsx` adopted by seven
non-daily record pages (Lane E CP4); and shared
`src/shared/OperationalListEmptyState.jsx` adopted by six daily list hubs with
row rendering gated behind successful load + nonempty filtered rows (Lane F CP3).
UI preview (desktop + mobile) was captured and approved before merge.
Shipped 2026-06-10 (this session, pushed `origin/main` `d7fc2c9`):
- Power-failure recovery: source-wide record/shared/auth visual-token closure +
  the Pig Batches swimlanes→unified-inspection-grid redesign (`b192a2a`); the
  daily-photo dead anon-policy drop (migration `109`, PROD-applied) + roster
  cleanup (`44be516`).
- Lane F + Lane K six-hub operational-list parity: right-sized search/filter/sort
  + saved views (new `app_saved_views` surface_keys `pig.batches` / `cattle.batches`
  / `broiler.batches` / `layer.batches` / `sheep.batches` / `equipment.fleet`, no
  migration) + filtered CSV/print, via per-hub pure filter libs; Layer + Sheep
  Batches converted cards→unified grid; Equipment Fuel Log saved-views Retry
  (`21a4532`).
- Lane E/I scoped modal/action token closure across the task + weigh-in +
  send-to-processor + equipment modals (`49a94f9`).
Detail in Latest Shipped Checkpoint above; six-hub visual screenshots waived by
Ronnie.
Shipped 2026-06-09 (this session, code checkpoint `ab39eb2`, followed by docs
wrap `b5f433d`; visual preview waived by Ronnie for this push):
- Lane 15 Tasks creation/public config: Public Tasks assignee checkbox grid;
  New Task modal One-time/Recurring toggle, recurring available to all
  authenticated roles except Light via the new `create_recurring_task_template`
  SECDEF RPC (migration `105`).
- Lane 16 Broiler dashboard/batches: trend = latest 9 processed; Hatchery column
  after Breed in Batch Comparison; active dashboard tiles open the batch record
  page.
- Lane 17 Equipment attention + record pages: grouped per-equipment attention
  notices with typed items; standalone read-only `/fleet/fueling/<id>` and
  `/fleet/checklist/<id>` record pages on the `equipment.item` entity.
- Lane 18 Cattle weigh-in record-page entry parity: dense tag-ascending table,
  herd-scoped diminishing picker + reconcile panel, completion blocked on
  unresolved `new_tag_flag`.
- Lanes 13/14/E/F (Codex pig batch): RecordSequenceNav UX (desktop icon-only
  edge chevrons + in-flow mobile row), pig breeding-pig record pages at
  `/pig/sows/<id>`, PigBatchPage record chrome, pig hub/list parity; plus
  source-derived processing-trip metrics (the shared `processingTripPigCount`
  resolver: actual weights come from stamped weigh-in source rows, with a stored
  fallback for legacy trips).
- Lane K export/print: shared `src/lib/operationalExportColumns.js` column owner
  wired into Activity Log, Equipment Fleet, and the cattle/sheep/broiler/layer/
  pig batch hubs (CSV via `csvExport.js`, print via `printExport.js`, visible
  filtered rows, hub-matching metric derivations).
- Lane A remaining: audited cascade-delete SECDEF RPCs `delete_layer_batch`
  (`106`), `delete_fuel_bill` (`107`), `delete_feed_input` (`108`); best-effort
  `pig.batch`/`broiler.batch`/`layer.batch`/`layer.housing`/`sheep.animal`
  Activity emissions for the app_store/retire flows that previously left no
  trace. Layer retire (status) is the audited normal flock-end path; hard-delete
  is the rare cleanup. Inventory: of ~90 destructive/multi-table flows, 74
  no-action, the rest covered here.
- Light role audit: Light portal design parity (reuses the approved
  `.home.theme-crisp` white-panel classes; Equipment Attention no longer colored;
  `/equipment` containment intact) and an admin-only, in-memory, non-persisting
  role-preview tool (`AuthContext` real vs effective state + Header select/banner)
  for smoke-testing what each auth level sees. My Submissions confirmed correct
  as-is (own fueling/fuel-supply records; dailies edited via the allowlisted
  daily pages).
- Lane J home KPI uniform frame: DROPPED. Per Ronnie, program dashboards stay
  program-specific; the only home-dashboard target was dead code, so the lane was
  reverted, not shipped.

Detailed parity evidence lives in
`C:\Users\Ronni\cc-research\parity-audit-2026-06-05-CC.md`; line-level findings
stay there, not in this durable map.

Class legend: `DEFECT` = build without a product decision once scoped;
`DECISION` = Ronnie must choose product/UX/policy before build; `ENH` =
enhancement/polish lane.

Locked queue direction from Ronnie (2026-06-09):
- Physically deleted root records keep durable history in global Activity only;
  do not build tombstone/deleted-record pages unless reopened.
- Move destructive flows to SECDEF RPCs only when they are audit-critical,
  multi-table, lifecycle/cascade, or cleanup-sensitive. Do not wrap tiny
  owner-scoped preference/config deletes just for uniformity.
- Pig batch should move to full record-page chrome parity when scoped, while
  preserving its heavier workflow.
- Saved views, richer search, sort, and filters are for high-repeat operational
  lists only, not every small admin/config list.
- AI-assisted filtering/sorting stays later-roadmap work until deterministic
  list parity is done; if built, it suggests filters/sorts with preview/apply.
- CSV/print expansion is for operational/reporting surfaces only.
- Visual-token cleanup should be strict and source-wide, with screenshots for
  visible UI changes.
- Homepage/program KPIs should use a uniform frame with domain-specific metrics
  inside that frame.

Next-session priority lanes (planned 2026-06-10):

1. Codex - Pig Batch Metrics Grid Cleanup. Class: `DEFECT`/`ENH`. Size: medium.
   Scope: Pig Batches hub only. Replace the packed sub-batch metric pills and
   redundant `Open` column with an inspection table whose visible columns are:
   `Batch`, `Status`, `Started Head`, `Current Head`, `Total Feed`,
   `Feed / Pig`, `Gilts Started`, `Gilts Current`, `Gilts Total Feed`,
   `Gilts Feed / Pig`, `Boars Started`, `Boars Current`, `Boars Total Feed`,
   and `Boars Feed / Pig`. The whole row should open the batch record using the
   shared openable-row hover class; do not build the global hover redesign in
   this lane. Sort active batches newest-first so `P-27-01` appears above
   `P-26-02`; keep processed batches at the bottom. Processed/closed batches
   should display current head as `0` on the hub. `Feed / Pig` is the readable
   hub label for the normalized feed metric; keep the implementation consistent
   with the current per-started-head calculation unless Ronnie explicitly
   reopens the formula. Preserve CSV/print/filter/saved-view behavior with the
   new column model.
   Success criteria: hub rows are legible at a glance, no sub-batch metric is
   hidden in a dense chip, the latest active batch sorts first, processed current
   counts do not show stale live head counts, and the row hover clearly signals
   openability without an `Open` column.
   Guard target: Pig Batch hub static guards, pure comparator/filter tests,
   processed-current metric coverage, export/print column checks, and focused Pig
   Batch Playwright smoke where practical. Migration/Storage/PROD gate: none
   expected; if a live data correction is discovered, stop for Ronnie approval
   before any PROD mutation.

2. CC - Global Openable Hover Affordance. Class: `ENH`. Size: medium.
   Scope: cross-app hover/focus polish for openable rows/cards. Formalize one
   global `.hoverable-tile` style, or the equivalent shared class, so openable
   operational rows and cards share the home-screen feel: pointer cursor,
   subtle hover highlight/lift/border/shadow where appropriate,
   `:focus-visible` keyboard affordance, and no layout shift. Audit existing
   `className="hoverable-tile"` usage and make sure dense tables, list tiles,
   home/dashboard tiles, and record-linked cards improve without becoming noisy.
   Remove explicit `Open` affordances only where the whole row/card already opens
   and the removal is safe; otherwise document remaining explicit affordances as
   intentional follow-up. Do not redesign Pig Batch columns in this lane.
   Success criteria: openable things across the app feel consistently clickable,
   non-openable rows stay visually plain, keyboard users get the same affordance,
   and the Pig Batch metrics lane can consume the shared hover class without
   inventing a local style.
   Guard target: global style/static guard for the hover class, representative
   row/tile ownership guards, targeted UI smoke where practical, plus format,
   lint, relevant static tests, and build. Migration/Storage/PROD gate: none.

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
   REMAINING SCOPE SHIPPED 2026-06-09 (cascade-delete RPCs `106`-`108` for the
   layer-batch/fuel-bill/feed-input roots + best-effort app_store/retire Activity
   emissions; full destructive-flow audit done — see the Shipped block above).
   Class: `DEFECT`/`DECISION`. Size: large.
   Shipped 2026-06-08: processing-batch unschedule/delete moved to audited SECDEF
   RPCs (migration `100`); the cattle.breeding Activity stream is now mounted.
   Shipped 2026-06-09 (PROD-applied + verified): weigh-in entry/session deletes
   and EquipmentDetail fueling/maintenance deletes moved to audited transactional
   RPCs (`101`/`102`) with `FOR UPDATE` hardening (`103`); the privileged fueling
   RPC was renamed to `admin_delete_equipment_fueling` to remove a migration-`091`
   name collision (`104`). Remaining: inventory
   the other pig/broiler/layer/cattle/sheep destructive or multi-table flows and
   move only audit-critical, lifecycle/cascade, or cleanup-sensitive flows to
   SECDEF RPCs where needed; ensure mounted Activity streams receive meaningful
   events. Deleted root records use global Activity only; do not build a
   tombstone/deleted-record page model unless Ronnie reopens that decision.
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
5. Lane D - Save/editing model policy. GUARDED CORE SHIPPED 2026-06-08.
   The EquipmentDetail flush-on-blur/before-navigation autosave loss is fixed
   (pending edits flush on blur/pagehide/visibilitychange/unmount and re-queue
   on save failure). `save_model_contract_static.test.js` now locks the current
   contract: daily/report submit-style surfaces use explicit Save/Submit, while
   weigh-in/equipment edit-in-place surfaces autosave. Reopen only for a named
   surface that violates the contract or for a Ronnie-approved change to the
   save/indicator model.
6. Lane E - Record-page shell and chrome parity. PARTIAL.
   Shipped 2026-06-08: `EquipmentDetail` adopted `RecordPageBody`/`RecordTitle`
   and exposes `data-equipment-record-loaded`; `PigBatchPage` adopted the shared
   `RecordPageBody` loaded wrapper with `data-pig-batch-record-loaded` using the
   approved left-aligned cap. CP2 (`6e31e7f`): `SheepDailyPage` removed its local
   `inputStyle` primitive and adopted the shared `recordControl` (via the `inp`
   alias the other daily pages use) for its fields and feed/mineral row controls,
   aligning its structure with the other daily record pages; `btnSmall`
   Add/Remove-row buttons stay intentionally distinct. Sheep parity slice in
   `daily_record_pages_shared_controls_static.test.js`.
   Remaining: move Pig batch toward the full standalone
   `RecordPageFrame`/`RecordTitle` model while preserving its heavier workflow,
   standardize record widths and loaded/error hooks, and expand
   `recordPageControls` adoption to the remaining record pages. Optional
   follow-up: align the weigh-in feed/mineral Add/Remove row-button microstyle
   (Sheep chip vs Cattle text-link) if full parity is wanted.
   Guard target: record-page shell/chrome static guards and focused Playwright.
7. Lane F - List, hub, filter, sort, saved-view, and empty-state parity. PARTIAL.
   Class: `ENH`. Size: large.
   Shipped 2026-06-08: `SheepFlocksView` uses the full helper-backed filter/sort
   model in `src/lib/sheepFlockFilters.js` plus saved views on
   `surface_key = 'sheep.flocks'`; saved views and filtered CSV exports expanded
   across cattle/sheep/livestock weigh-ins, Pig Daily Reports, daily hubs,
   Equipment Fuel Log, Layer Dailys, and Egg Dailys. Saved-view load failures
   degrade locally without blocking parent lists. CP2 (`04fd932`): cattle/sheep/
   livestock weigh-in list empty states now distinguish true-empty from
   filtered/search-no-results, preserving load-failure suppression. Shared
   weigh-in list primitives (`3e18623`): `src/shared/WeighInSessionListTile.jsx`
   and the `src/lib/weighInSessionExports.js` column builders de-duplicate the
   cattle/sheep/livestock session tiles and CSV/print columns.
   Shipped 2026-06-10 (`21a4532`): right-sized search/filter/sort + saved views +
   filtered CSV/print on the six high-repeat hubs — Pig/Cattle/Broiler/Layer/Sheep
   Batches + Equipment Fleet. Per-hub pure filter libs
   (`src/lib/{pig,cattle,broiler,layer,sheep}BatchFilters.js`,
   `equipmentFleetFilters.js`); new `app_saved_views` surface_keys (no migration);
   Layer + Sheep Batches converted cards→unified grid. Per-hub filter static
   guards added.
   Remaining: extract any remaining drifting row/tile primitives beyond weigh-ins,
   add search/sort/saved views only to any further high-repeat operational lists,
   standardize filtered/empty states where gaps are found, and defer real AI
   filter/sort work until deterministic list parity is done. Any later AI
   filter/sort must suggest changes with explicit preview/apply behavior.
   Guard target: per-surface filter/sort tests, saved-view tests, and static
   shared-row/empty-state guards.
8. Lane G - Restore/recovery surface. SHIPPED 2026-06-08.
   `RecentlyDeletedDailyReports` is now a combined Recently Deleted Records
   surface that restores daily reports plus deleted cattle/sheep animals
   (`restoreCattleAnimal`/`restoreSheepAnimal`), fail-closed, dispatching the
   correct restore RPC by record kind.
9. Lane H - Webform/offline parity. CORE SHIPPED 2026-06-08.
   Class: `ENH` for any future consolidation. Size: medium.
   Shipped 2026-06-08: `EquipmentFuelingWebform` now submits through
   `useOfflineRpcSubmit('equipment_fueling')`, queues transient/offline RPC
   failures, auto-replays, and exposes stuck-submission recovery; no new
   migration was needed because migration `047` already supports idempotent
   replay. The later build-queue merge standardized locked submitter copy to
   "Team member" and guards terminal queued/stuck/saved copy.
   Remaining: consolidate legacy webform paths only if a concrete duplicate flow
   causes product friction; documented aliases must remain valid.
   Guard target: offline/webform static guards and focused offline Playwright.
10. Lane I - Visual tokens, terminology, formatting, and design primitives.
    PARTIAL. Class: `ENH`. Size: large.
    Shipped 2026-06-08: homepage redesign CP1-CP3 is on `main` (self-hosted
    Hanken font, redesigned green header, transparent planner icons, scoped
    `homeRedesign.css`, and full `HomeDashboard` integration). Shared token
    slice also shipped: button padding/radius updates, `RecordTitle` default
    `26`, shared primitive radius tightening, and
    `design_token_contract_static.test.js`. CP4 (`859696a`): the six daily record
    pages route Retry/Revert/Save/Delete through shared canonical action buttons
    (`recordSaveButton`/`recordSecondaryButton`/`recordDeleteButton` in
    `recordPageControls.jsx`; radius 6, 10px16px pad, fontSize 13), removing the
    retired 7/8 radii and bespoke action padding and normalizing Sheep Save from
    blue to brand green (`daily_record_pages_shared_controls_static.test.js`
    action-button slice).
    Shipped 2026-06-10: source-wide record/shared/auth visual-token closure
    (`b192a2a`, guard `record_page_token_closure_static`) across 23 surfaces, plus
    the scoped modal/action token closure (`49a94f9`, Lane E/I — the task /
    weigh-in / send-to-processor / equipment modals adopt shared
    `recordSaveButton` / `recordSecondaryButton`; guards `modal_action_tokens_static`,
    `task_modal_tokens_static`).
    Remaining: any residual source-wide typography/radius/color drift outside the
    shipped shared primitives and documented exceptions; visible UI changes need
    targeted screenshots. Any future homepage visual changes should preserve the
    approved `.home.theme-crisp` composition unless Ronnie reopens the design.
    Guard target: typography, radius, button-control, z-index, shared-ui/token
    static guards, plus targeted visual Playwright/screenshots where needed.
11. Lane J - Cross-cutting product and accessibility policy. SHIPPED (core)
    2026-06-08; the one open item (home-dashboard KPI uniform frame) was DROPPED
    2026-06-09 — program dashboards stay program-specific (the only home target
    was dead code), so no Lane J work remains open.
    Class: `DECISION`. Size: medium.
    Shipped 2026-06-08: shared Delete/Confirm modals have focus-trap behavior via
    `useModalFocusTrap.js`; central-date defaults are guarded across admin
    modals, webforms, WebformHub, and Layer/Egg daily list defaults; route/nav
    policy guards were added in `lane_j_policy_static.test.js`. Image alt-text
    policy shipped (`04fd932`): `src/lib/imageAlt.js` (`imageAltText`) drives
    every user-media `<img>` owner with contextual fallbacks and marks decorative
    images `aria-hidden`, locked by `image_alt_text_policy_static.test.js`.
    Remaining: none — the only open item (home-dashboard KPI uniform frame) was
    dropped above. Reopen only for a new Ronnie-approved cross-cutting product or
    accessibility policy decision. (The general "program KPIs use a uniform frame"
    principle stays in Locked queue direction as forward guidance, not open work.)
    Guard target: route/nav/date/a11y static guards plus focused Playwright once
    more decisions are made.
12. Lane K - Export/print parity. OPERATIONAL-HUB SCOPE SHIPPED 2026-06-09
    (shared `operationalExportColumns.js` owner across the 7 list/fleet/log
    surfaces — see the Shipped block above). Class: `DECISION`/`ENH`.
    Shipped 2026-06-08: cattle-herd CSV export — `src/lib/csvExport.js` is the
    single rows-to-CSV / Blob / object-URL / filename / revoke owner (with a
    formula/DDE-injection guard and farm-Central filename dates), and
    `CattleHerdsView` exports the active filtered/sorted `sortedFlat` rows.
    The pushed runtime queue further extends CSV to Sheep Flocks, Sheep Weigh-In
    Sessions, Equipment Fuel Log, and Cattle Weigh-In Sessions. The build-queue
    merge added `src/lib/printExport.js` plus print/CSV expansion across
    livestock/cattle/sheep weigh-ins, cattle/sheep inventory, Broiler/Pig/
    Cattle/Sheep dailys, Layer/Egg dailys, and Equipment Fuel Log. Shared
    weigh-in column builders (`3e18623`): `src/lib/weighInSessionExports.js` owns
    the ruminant + livestock weigh-in session CSV/print column specs, consumed by
    the cattle/sheep/livestock views (still exporting the filtered set).
    Shipped 2026-06-10 (`21a4532`): the six operational hubs now export the
    VISIBLE filtered+sorted rows — Broiler + Layer Batch exports refactored off
    their hard-coded subsets, and the Cattle Batch export count restored to
    attached-detail-rows only (parity with sheep). All via the existing shared
    `csvExport`/`printExport` + `operationalExportColumns` owners.
    Remaining: extend the shared CSV/print model only to remaining operational
    or reporting surfaces where export supports work, billing, feed, records, or
    audit. Keep permissions bounded to RLS-visible rows, use shared column specs
    where useful, and consider a fuller shared print stylesheet/screenshot gate
    if print use becomes more central.
    Guard target: column-spec/export tests and print stylesheet/screenshot checks
    (`csvExport.js` owns CSV download; `printExport.js` owns row-print output).

13. Record Nav UX Fix. SHIPPED 2026-06-09 (see Shipped block above). Class: `DEFECT`. Size: medium.
    Problem: fixed text Prev/Next pills on record pages can overlap record data,
    especially dense pages such as pig batches and weigh-in sessions. Direction:
    desktop record sequence navigation should become simple fixed-edge chevrons
    with accessible labels/tooltips for the target record; mobile should not use
    side-fixed controls and should instead show a compact static top row below
    the Back link/title area. Equipment record pages keep sequence navigation
    and should follow the same global model.
    Guard target: `RecordSequenceNav` tests, per-record sequence Playwright, and
    desktop/mobile screenshots for at least one dense record page.
14. Pig Operations Parity. SHIPPED 2026-06-09 (see Shipped block above). Class: `DEFECT`/`ENH`. Size: large.
    Scope:
    - Pig processing-trip actual weights must come from linked weigh-in data,
      be read-only on the trip, and require a weigh-in source before completing
      or recording the processing trip.
    - Pig Batches tab should keep its existing page/tiles but present all batch
      statuses in a column-style comparison layout with the important stats and
      metrics visible for at-a-glance comparison.
    - Breeding pig tiles stay as-is; add breeding-pig record pages whose first
      version shows the exact same data currently shown in the pop-out modal.
    - Fix `/pig/breeding` jumping to the top during normal scrolling.
    Guard target: pig batch/trip static guards, focused pig Playwright for trip
    weight source and breeding scroll stability, and record-page chrome guards
    for breeding pig records.
15. Tasks Creation And Public Config UX. SHIPPED 2026-06-09 (migration `105`). Class: `DEFECT`/`ENH`. Size: medium.
    Scope:
    - Public Tasks assignee checkbox names should render as a simple aligned
      checkbox grid with readable rows/columns and clean spacing; no role
      grouping or searchable picker in the first pass.
    - Task Center `New Task` should support a One-time / Recurring toggle in the
      existing modal. Recurring creation is available to all authenticated roles
      except Light users.
    Guard target: task static guards, public Tasks config screenshot/static
    checks, and focused Tasks Playwright for recurring creation visibility by
    role where practical.
16. Broiler Dashboard And Batches UX. SHIPPED 2026-06-09. Class: `DEFECT`/`ENH`. Size: medium.
    Scope:
    - Broiler dashboard "LBS PRODUCED TREND - LAST 9 BATCHES" should select the
      latest nine processed batches. Tables/lists show newest first; charts show
      oldest left to newest right.
    - Broiler Batches tab Batch Comparison should include Hatchery as a visible
      column/metric immediately after Breed. Batch Comparison remains a
      processed-batch comparison surface.
    - Active batch tiles on the Broiler Dashboard should open the corresponding
      broiler batch record page.
    Guard target: broiler dashboard/batch static guards plus focused Playwright
    for dashboard tile navigation and trend ordering.
17. Equipment Attention And Fueling Checklist Record Pages. SHIPPED 2026-06-09.
    Class: `DEFECT`/`ENH`. Size: medium/large.
    Scope:
    - Combine duplicate equipment attention notices for the same equipment into
      one notice with multiple due items inside. The notice must distinguish
      checklist/material/service items clearly (for example, a 50-hour checklist
      due item should not look like a duplicate service alert).
    - Add full audit record pages for fueling/checklist entries using record
      chrome and the existing checklist data plus Comments and Activity.
    Guard target: home/equipment attention static guards, equipment record-page
    guards, Activity/comment guards, and focused equipment Playwright.
18. Cattle Weigh-In Record Page Entry Parity. SHIPPED 2026-06-09. Class: `DEFECT`/`ENH`. Size: medium.
    Context: herd selection for cattle weigh-in sessions still works (not a gap).
    The parity gap is on the authenticated cattle weigh-in record page
    (`WeighInSessionPage`): the public `WeighInsWebform` still has the desired
    cattle workflow — `remainingTags` (herd-scoped cow tags minus tags already
    weighed in the session), `remainingCows` (herd-scoped unaccounted-for cows for
    replacement/lost-tag reconciliation), `pendingReconciles` (`new_tag_flag`
    entries that must reconcile before completion), and "Pool narrows as more cows
    get weighed" behavior. The record page has lower-level reconcile/tag-swap
    mechanics, but its entry UI is free-text and the reconcile dropdown shows all
    cattle with tags, not the diminishing herd-scoped pool.
    Direction:
    - Convert cattle weigh-in record-page entries from card/grid to a dense
      list/table sorted ascending by numeric tag.
    - Preserve autosave/edit, delete, note, prior weight/date, days-since, weight
      delta, ADG, processor flag, comments/Activity side effects, and record-page
      chrome.
    - Columns for scanning: Tag, Weight, Note, Prior, Days, +/- Delta, ADG,
      Herd/Status or Processor, Time, Actions.
    - Normal cattle entry defaults to a herd-scoped "available cows to weigh"
      picker/list that removes cows already weighed in that session.
    - Lost/replacement/new-tag entries use a dedicated reconciliation panel scoped
      to that session's remaining herd cows, not all cattle.
    - Reconciliation keeps existing behavior: update the cow's current tag, append
      the prior tag into `old_tags`, clear `weigh_ins.new_tag_flag`, stitch
      `cattle_comments` to the cow/tag, and log Activity.
    - Block completion while unresolved `new_tag_flag` entries remain (matching the
      public form).
    - Keep explicit swap/new-tag escape hatches, but make the main workflow
      picker/list driven.
    Guard target: static guard that the cattle record page computes/uses
    herd-scoped diminishing pools (`remainingTags`/`remainingCows` or equivalent);
    static guard that the reconcile dropdown does not use all animals blindly;
    static/Playwright guard that cattle entries render as a list/table sorted
    ascending by tag; focused Playwright for a cattle session (choose herd/session,
    weigh cows from the diminishing list, create a replacement/new-tag entry,
    reconcile it to a remaining cow, and verify completion is blocked until
    resolved).

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
- The homepage redesign is intentionally scoped under `.home.theme-crisp` in
  `src/dashboard/homeRedesign.css` and may keep approved design-reference
  micro-type/weight values while Lane I source-wide token cleanup remains
  incremental. Future homepage visual changes must preserve the approved
  composition unless Ronnie reopens the design.
- `getReadableText()` in `src/lib/styles.js` returns `#0f172a`/`white` as
  auto-contrast for arbitrary colored backgrounds. These two values are
  infrastructure, not palette drift, and are exempt from the color migration.

---

## Product Surface

### Authenticated App

- Home dashboard: redesigned `.home.theme-crisp` landing surface with label-only
  program tiles, Processing/Admin utility row, live weather, Animals-on-Farm
  counts, Production placeholder card, missed-daily/equipment/material alerts,
  Next 30 Days, and admin Last-5-Days.
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
- `101`-`104` audited-delete RPCs (Lane A CP2/CP3): `101`
  `delete_weigh_in_entry`/`delete_weigh_in_session`; `102` privileged fueling
  delete + `delete_equipment_maintenance_event`; `103` weigh-in delete
  `FOR UPDATE` idempotency; `104` renames the privileged fueling RPC to
  `admin_delete_equipment_fueling` (drops the migration-`091` name collision).
  Applied TEST + PROD 2026-06-09.
- `105` `create_recurring_task_template(p_template jsonb)`: SECDEF RPC for the
  Task Center New Task recurring path — role-gated (rejects light/inactive,
  allows all other authenticated roles), server-stamps `created_by_profile_id`
  from `auth.uid()`, idempotent by client id; lets non-admin roles create a
  recurring `task_templates` row without hitting the admin-only direct-write RLS.
  Wrapper `createRecurringTaskTemplateV2`. Applied TEST + PROD 2026-06-09.
- `106` `delete_layer_batch(p_batch_id text)`: one-txn delete of child
  `layer_housings` + the `layer_batches` root + one `layer.batch record.deleted`
  Activity; `layer_dailys`/`egg_dailys` left as history (retire stays the normal
  flock-end op). Auth-gated. Wrapper `layerBatchDeleteApi`. Applied TEST + PROD
  2026-06-09.
- `107` `delete_fuel_bill(p_bill_id text)`: `is_admin()`-gated, `FOR UPDATE`;
  deletes the `fuel_bills` root (`fuel_bill_lines` via FK cascade) + one
  `equipment.item record.deleted` Activity; client removes the bill PDF
  best-effort after the RPC. Wrapper `fuelBillDeleteApi`. Applied TEST + PROD
  2026-06-09.
- `108` `delete_feed_input(p_input_id text)`: authenticated-gated, `FOR UPDATE`;
  deletes the `cattle_feed_inputs` root (`cattle_feed_tests` via FK cascade) +
  one `cattle.forecast record.deleted` Activity; client bulk-removes the feed
  PDFs best-effort after the RPC. Wrapper `feedInputDeleteApi`. Applied TEST +
  PROD 2026-06-09. (`105`-`108` all SECDEF, `search_path public`, REVOKE
  anon / GRANT authenticated, `NOTIFY pgrst`; ids are TEXT slugs so the params
  are `text`, not `uuid`.)

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
  `HomeDashboard` and `LightHomePortal`. Equipment attention keeps shared
  `detail` full for single-text consumers and gives HomeDashboard `metaLabel` +
  `pill` for the CP3 badge layout.
- `src/dashboard/homeRedesign.css`: scoped homepage redesign styles under
  `.home.theme-crisp`; do not move these into global CSS without a Lane I design
  amendment.
- `src/lib/savedViewsApi.js`: `app_saved_views` CRUD + `buildViewState`.
  Original consumer was Cattle Herds; shipped consumers now reuse it across
  multiple list/report surfaces with distinct `surface_key` values.
- `src/lib/cattleHerdFilters.js`: pure cattle herd filter/sort predicates
  (vitest-locked).
- `src/lib/sheepFlockFilters.js`: pure Sheep Flocks filter/sort predicates and
  dimension helpers (vitest-locked).
- `src/lib/processingBatchDeleteApi.js`: client wrappers for the audited
  processing-batch lifecycle RPCs (`unschedule_cattle_processing_batch`,
  `delete_sheep_processing_batch`; migration `100`).
- `src/lib/csvExport.js`: the single CSV rows-to-CSV / Blob / object-URL /
  filename / revoke owner, with a spreadsheet formula/DDE-injection guard and
  farm-Central filename dates. All CSV lanes should export the active filtered
  result set unless a Ronnie-approved exception is documented.
- `src/lib/printExport.js`: shared rows-to-print HTML/window owner for record
  and list print exports.
- `src/shared/InlineNotice.jsx`: non-blocking notices (`error`/`warning`/
  `success`/`info` kinds).
- `src/shared/DeleteModal.jsx` and `src/shared/ConfirmModal.jsx`: app modal
  primitives.
- `src/shared/useModalFocusTrap.js`: shared modal focus-trap/Escape behavior for
  modal primitives.
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

- Canonical font family: self-hosted `Hanken Grotesk` from `index.html` and
  inheritance from `fontFamily: 'inherit'` on component styles.
- Canonical font-size set: `10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 26`.
- Allowed display sizes: `32, 34, 36, 48, 56`.
- Canonical shared-component font-weight scale: `400, 500, 600, 700`. Existing
  legacy/scoped drift is Lane I cleanup work and should not expand without a
  documented exception.

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
  with `surface_key = 'sheep.flocks'`, capturing search/filter/sort state; load
  failures degrade to an inline notice and never block the flock hub. Sheep
  Flocks filter/sort logic lives in `src/lib/sheepFlockFilters.js`.
- Additional saved-view consumers now shipped on `main` include daily/report and
  weigh-in/fuel-log surfaces using distinct `surface_key` values such as
  `layer.dailys` and `layer.eggs`; failures must degrade locally without
  converting the parent list into a load failure.
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
- `EquipmentFuelingWebform` uses `useOfflineRpcSubmit('equipment_fueling')`;
  transient/offline RPC failures queue and replay, with stuck-submission recovery
  via `StuckSubmissionsModal`. Offline photo blob capture is not part of that
  shipped lane; queued payloads carry already-uploaded photo URLs.
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
  (`savedViewsApi.js`, `surface_key`). New consumers reuse the same table/API
  with a distinct `surface_key`, and failures should degrade locally without
  converting the parent list into a load failure.
- `DeleteModal` and `ConfirmModal` are app-level modal primitives. New
  destructive/confirmation flows should use them unless a documented exception
  is added to `shared_ui_extraction_contract_static.test.js`; shared modal
  focus behavior lives in `useModalFocusTrap.js`.
- CSV export ownership lives in `csvExport.js`; row-print export ownership lives
  in `printExport.js`. New exports should use active filtered/sorted rows unless
  a Ronnie-approved exception is documented.
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
| Record pages             | `tests/static/record_page_*.test.js`, per-entity static tests, `tests/*_sequence_nav.spec.js`, `tests/record_sequence_nav_fixed.spec.js`, `tests/static/record_sequence_nav_cp3_static.test.js`, `tests/static/save_model_contract_static.test.js` |
| Home / dashboard alerts  | `tests/static/home_missed_daily_reports_static.test.js`, `tests/static/home_next_30_icons.test.js`, `tests/static/home_daily_tile_routing_static.test.js`, `tests/static/light_user_portal_static.test.js`, `tests/light_home_alerts.spec.js`, `tests/home_dashboard_equipment.spec.js` |
| Readiness                | `tests/static/load_retry_robustness_inventory_static.test.js`, `tests/static/*readiness*`                                                                       |
| Mutation/delete/recovery | `tests/static/mutation_semantics_inventory_static.test.js`, `tests/static/delete_recovery_classification_static.test.js`, `tests/static/hard_delete_owner_static.test.js` |
| Cattle                   | `tests/static/cattle_*.test.js`, `tests/cattle_*.spec.js`, `src/lib/cattleHerdFilters.test.js`, `tests/static/app_saved_views_migration_static.test.js`         |
| Sheep                    | `tests/static/sheep_*.test.js`, `tests/sheep_*.spec.js`, `src/lib/sheepFlockFilters.test.js`                                                                     |
| Daily reports            | `tests/static/daily_*.test.js`, `tests/static/daily_hub_saved_views_csv_static.test.js`, `tests/static/cp2_daily_writes_via_rpc_static.test.js`, `tests/daily_*.spec.js` |
| Feed planning            | `src/lib/feedPlanner.test.js`, `src/lib/feedOrderBasis.test.js`, `tests/static/feed_order_board_static.test.js`                                                 |
| Pig                      | `src/lib/pig*.test.js`, `tests/pig_*.spec.js`                                                                                                                   |
| Broiler/layer            | `src/lib/broiler.test.js`, `tests/static/broiler_hatch_activation_static.test.js`, `src/layer/*.test.js`, `tests/broiler_*.spec.js`, `tests/layer_*.spec.js`    |
| Equipment                | `src/lib/equipment.test.js`, `tests/static/equipment_*.test.js`, `tests/equipment_*.spec.js`                                                                    |
| Export / print           | `src/lib/csvExport.test.js`, `src/lib/printExport.test.js`, `tests/static/weighin_session_record_page_static.test.js`                                          |
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
