# WCF Planner

Farm-management web app for White Creek Farm. React/Vite single-page app,
Supabase backend, Netlify production deploy from GitHub `main`.

This file is the durable project map: current state, architecture, roadmap, and
load-bearing contracts. Workflow, roles, gates, and relay format live in
[HO.md](HO.md). Do not turn this file into a session transcript.

Last updated: 2026-06-26.
Current product checkpoint: `73a8432` (`Merge pasture group records workflow`).
Latest shipped product merges include newsletter Checkpoint A (`7d41d7f`) and
Pasture Map group records (`73a8432`).
Current docs checkpoint: this 2026-06-26 pasture CC#1/newsletter/processing
wrap.
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

- Production deploy: Netlify auto-deploys from GitHub `main`.
- Source: latest product merge on `main` is `73a8432` (`Merge pasture group
  records workflow`). `origin/main` is pushed. The immediately prior shipped
  newsletter merge is `7d41d7f` (PR #40, `feature/newsletter-engine`).
- Active lanes / PR gates: Pasture Map CC#1 is built locally on
  `fix/pasture-prod-smoke-warning-cleanup` and is being committed/pushed from
  this wrap. It still needs review/merge and, separately, explicit PROD approval
  before migration `149` is applied. Monthly Newsletter Checkpoint A is
  committed, merged to `main`, and pushed; Checkpoint B automation remains open.
- Worktree inventory at wrap:
  `C:/Users/Ronni/WCF-planner-codex-residuals` is clean on `main`;
  `C:/Users/Ronni/WCF-planner` is clean on
  `feature/pasture-groups-grazing-edit` except untracked review screenshot
  folders `pasture-cp2-shots/`, `pasture-grazing-edit-shots/`, and
  `pasture-map-shots/`; `C:/Users/Ronni/WCF-planner-newsletter` is clean on
  `feature/newsletter-engine` except untracked `newsletter-shots/`.
- Open production/build gates: Pasture migration `149` is written in the CC#1
  branch but is not PROD-applied; applying it remains a separate Ronnie gate.
  Newsletter automation is not built. Migration `146`, the
  `newsletter-harvest` Edge Function, AI/Vault secret wiring, and the monthly
  `pg_cron` schedule remain Build Queue work. The admin navigation entry for
  `/admin/newsletter` is also not added yet; the admin surface is reachable by
  URL.
- PROD-applied recent migrations include `112` through `116`, `125` through
  `145`, `147`, and `148`. Migration `146` is reserved for newsletter
  automation and is not written/applied. Migration `143`
  (`delete_land_area_grazing_history`) remains deployed but unused by the UI.
  Pasture migrations `147` and `148` are PROD-applied and smoke verified:
  `delete_pasture_move` exists, `pasture_move_events.total_weight_lbs` exists,
  and the retired `pasture_planned_moves` table is absent. Pasture migration
  `149_pasture_map_rest_history_reconciliation.sql` exists only as pending
  branch work until explicitly applied. Newsletter migrations `144` and `145`
  are present on PROD: the five newsletter tables have RLS
  enabled, the public anon RPC surface is the three newsletter read RPCs, and
  buckets `newsletter-staging` (private) and `newsletter-public` (public) exist.
  PROD currently has `0` newsletter issues.
- Production legacy import: `Processing Events - ALL.xlsx` parsed 69 rows,
  skipped 0, and upserted 69 rows into `production_legacy_events` on PROD by
  stable `source_key`.
- Processing Calendar investigation (planning only; no schema/importer/UI built):
  Codex and CC reached consensus on the Asana-backed Processing workflow after
  reviewing the handoff folder `design_handoff_processing_calendar`, the CSV,
  current repo contracts, and the live Asana API for project
  `1201484014160203` (`SF Processing Calendar `, trailing space). Do not commit
  or document the Asana token. Current live audit on 2026-06-26 found 117
  top-level records, 5 top-level milestones, sections Broiler 48 / Cattle 27 /
  Pig 29 / Lamb 13, 1,132 CSV subtask rows (1,121 direct API subtasks plus 11
  nested children), 122 real comments on 52 top-level records, 71 attachments,
  and 0 live dependencies. Counts are a checkpoint, not a hardcoded import
  target; the importer must self-count against live API at cutover. Ronnie
  decided comments must import but Asana system activity/stories must not.
- Newsletter PROD state: Checkpoint A is merged and pushed. Public no-login
  archive routes live under `/newsletter`, including `/newsletter/latest`,
  issue slugs, and token preview. Admin manual issue editing lives at
  `/admin/newsletter` and is admin-only. The engine is manual/public/admin only:
  no fact detectors, AI generation, monthly task, Edge Function, Vault secret,
  or cron are live yet. First production issue creation/publication still needs
  real admin use and browser verification with actual photo upload/approve/cover
  bytes.
- Pasture Map PROD state: tabs are Map / Field / Reports. Map is the single
  working surface. The Area modal is config-only and has one close affordance:
  the upper-right `X`, which debounces/saves edits on close; extra Close, Save
  Area, Zoom to pasture, and Clear selection controls are removed. The side
  panel uses DataTable-style animal group rows with normal site hover/open
  behavior. Clicking a group row opens the inline group record beside the map
  (not a modal), ordered as group details, rotation editor, move box, then
  grazing history. The rotation editor is chip-based, supports Add from map and
  Draw temp paddock, can be reordered, and shows the selected group's path on
  the map. The old planned-move utility/table/RPCs are removed. Move recording
  happens from current area to next rotation area with a date/time field and
  optional actual group weight; grazing stays use only recorded data for head
  count, acres, head/ac, days, animal-days, and lbs/ac. Reports include grazing
  stays by animal group, inactive groups behind an Include inactive groups
  filter, and per-stay delete. Parent-pasture occupancy/rest fill no longer
  comes from direct child paddock impacts. Light keeps pasture farm-team-level
  Map/Field working controls; non-pasture authorization is unchanged.
- Pasture Map CC#1 pending branch state
  (`fix/pasture-prod-smoke-warning-cleanup`): the Map Area modal and Reports
  Area record now share one canonical Area Record body, so the Map modal gains
  grazing history and the Reports record gains the same management controls.
  Area name editing uses one shared explicit Edit -> Save/Cancel editor with
  Enter-to-save, Escape-to-cancel, visible saving/saved/error states, and no
  blur-save. The Map Animal Groups launcher and the Reports Areas / Animal
  Groups launchers are rebuilt as `.hoverable-tile` pop-out openable tiles with
  shared chevron/keyboard behavior instead of flat table rows. Area summaries no
  longer repeat "Last grazed"; grazing recency lives in Grazing History. The
  FP3/FP3A1 phantom "Resting/Last grazed" defect is handled by migration `149`,
  which replaces `_land_area_summary` to ignore orphan `pasture_move_impacts`
  whose move event has lost its directional `to_land_area_id`/`from_land_area_id`
  link; no data mutation is included. Validation run during this wrap:
  targeted Prettier check, `tests/static/pasture_map_static.test.js` (174/174),
  `npm run lint` (0 errors; existing warnings), full `npm test` (251 files /
  6377 tests), `npm run build`, TEST-only `scripts/apply_test_mig_149.cjs`, and
  focused Playwright `tests/pasture_map_tile_hover.spec.js` (4/4) passed.
- Latest validation on merged `main`: `npm run format:check` passed; `npm test`
  passed (`251` files / `6371` tests); `npm run build` passed; `npm run lint`
  passed with 0 errors and existing warnings. Full pasture Playwright passed
  before merge (`playwright.pasture.config.js`, 36/36). Newsletter public/admin
  Playwright passed in the CC#2 lane (`tests/newsletter_public.spec.js`, 5/5).
  Residual non-blocking console noise observed during pasture Playwright:
  duplicate `undefined|date` keys in HomeDashboard/LightHomePortal and Leaflet
  `_leaflet_pos` teardown warnings during rapid navigation.
- Broiler derived-data drift lane is closed: merge `6b94d37` contains Codex
  `c639311` and CC#2 `6ff36c7`; code is deployed/verified; B-26-08 wk6 PROD
  repair was run through `recomputeBroilerBatchWeekAvg(sb, 'B-26-08', 6)` and
  verified cached `ppp-v4.week6Lbs=5.76` equals canonical 5.76 from 30 weights.
- `tasks-cron` Edge Function is active in PROD. It generates recurring tasks,
  system-task instances with batch/group entity labels, and To Do approval/
  originator notifications. Existing open system tasks were backfilled by
  migration `142`.
- Dependency hardening is complete: Vite/Vitest/plugin-react majors were
  upgraded, SheetJS is pinned to the patched 0.20.3 tarball, Node is pinned to
  22 for Netlify, and `npm audit` is 0 on the hardened lockfile.

### Recent Shipped Checkpoints

The following work is merged to `main` and pushed. Netlify deploys from `main`.
The current source checkpoint is listed in the header above.

- Pasture Map group records workflow (`73a8432`, pushed 2026-06-26):
  - Area modal dismissal was simplified to one upper-right `X`; removed the
    extra area-detail `X`, Close, Save Area, Zoom to pasture, and Clear
    selection controls. Area edits debounce/save on close.
  - Animal groups in the Map side panel were rebuilt as DataTable-style rows
    with the site's normal hover/open behavior. Clicking a group opens an inline
    group record beside the map so the full map remains visible while planning.
  - The inline group record order is group details, simplified chip-based
    rotation editor, move box, and grazing history. The move box records current
    area to next rotation area with a date/time field and optional actual group
    weight; no notes field. The rotation path renders on the map.
  - Migration `148` adds `pasture_move_events.total_weight_lbs`, updates pasture
    move/history report RPCs for actual-weight metrics, and drops the unused
    planned-move table/RPCs. PROD smoke verified the column, record-move
    signature, and planned table removal.
  - Validation: full pasture Playwright 36/36; merged-main
    `format:check`, `npm test` (`251` files / `6371` tests), `build`, and
    `lint` 0 errors all passed.
- Pasture Map groups, per-entry grazing delete, and parent coloring
  (PR #39, `b1ccf88`, pushed 2026-06-26):
  - Migration `147` adds `delete_pasture_move(p_move_id)` for management/admin
    per-stay grazing delete and updates `_land_area_summary` so parent pastures
    do not derive occupancy/rest fill from direct child paddocks.
  - Completed-stay delete is chain-aware: deleting the move-in event clears the
    linked departure impacts on the next move for the same group/touched areas,
    preserves the later move event, and prevents derived-state drift.
  - The Map side panel removed the old Current groups card/header copy; group
    rows carry location data, and Reports rename grazing records to Grazing
    History with per-entry delete.
  - Migration `143` remains deployed but unused; the whole-area grazing reset UI
    and client wrapper were removed.
- Monthly Newsletter Checkpoint A, manual public + admin engine
  (PR #40, `7d41d7f`, pushed 2026-06-26):
  - Public no-login routes `/newsletter`, `/newsletter/latest`, issue slugs, and
    token preview are mounted above the login gate. Public rendering uses a
    structured block whitelist and locked `noindex`; no raw AI HTML.
  - Admin-only `/admin/newsletter` supports manual issue creation/editing,
    intake answers, manual facts, photo staging/approval/cover controls,
    preview, publish/unpublish, and draft-only preview token regeneration.
  - Migrations `144`/`145` define deny-all newsletter tables, the narrow three
    RPC anon surface, preview hardening, and private/public newsletter buckets.
    PROD catalog verified the tables/RPCs/buckets exist; PROD issue count is
    currently `0`.
  - Remaining newsletter automation is not part of Checkpoint A: no fact
    detectors, AI generation, `newsletter-harvest` Edge Function, Vault secret,
    migration `146`, or monthly cron are live yet.
  - CC#2 validation before merge: `format:check`, `lint`, `npm test`, `build`,
    TEST migration apply/smoke, and `tests/newsletter_public.spec.js` 5/5.
- Pasture Map Area modal, Reports accordion, reset-history, and move-to-side-bar
  (PRs #37-#38, pushed 2026-06-25; `main` now `d18736f`):
  - PR #37 (`05b03e5`): per-area editing moved out of the Map side panel into an
    accessible Area modal (`role=dialog`, `aria-modal`, focus trap via
    `useModalFocusTrap`, backdrop) opened by clicking a map area; desktop hover
    readout unchanged. New `src/pasture/PastureAreaModal.jsx`. Reviewed permanent
    paddocks require a parent pasture (UI-enforced, no auto-backfill);
    parentless paddocks surface in a Reports "Needs pasture assignment" section.
    Side panel slimmed; Tracks/Lines + classification queue + archived recovery
    relocated to a collapsible Reports accordion (pastures collapse over child
    paddocks via `parent_id`; Reports renders no map). The Map boundary-tools
    grid was removed (draw/measure/GPS reachable via Field + the rotation editor
    "Draw temp paddock"; redraw via the modal).
  - PR #38 (`d18736f`): added migration `143`
    `delete_land_area_grazing_history` (management/admin per-area "Reset grazing
    history") - applied and verified on PROD (`psql --single-transaction`;
    SECDEF, authenticated EXECUTE, anon denied; PostgREST schema reloaded).
    Move/animal placement was pulled OUT of the Area modal and relocated to the
    side panel ("Record a move" + "Plan a move": any roster group + any
    destination area; the planned-move "Use" records in one click). Later pasture
    checkpoints removed those free-form move/plan controls and the per-area
    reset button in favor of group-record moves and per-stay grazing delete; mig
    `143`'s RPC stays deployed but unused.
  - PROD data fix (2026-06-25): reparented FP3/FP4 paddocks under their pastures
    via `psql --single-transaction` - 6 FP3 paddocks to the FP3 pasture (fixing
    FP3A1, which was mis-parented to FP4) and 23 FP4 paddocks to the FP4 pasture.
    Verified: all 6 under FP3, all 23 under FP4; the FP3 outline-candidate draft
    line was correctly excluded.
  - Validation before each merge: `format:check` clean; `lint` 0 errors;
    `npm test` 6309 passed; `build` green; `playwright.pasture.config.js` 35/35.
    The heavy sequential pasture suite has an occasional ~1/35 timing flake that
    passes in isolation; a `mommas`-herd seed collision in
    `pasture_map_cp2.spec.js` drove extra flake until cp2 was switched to a
    `bulls`-herd seed (note: `cattle_herd_check` restricts herds to
    `mommas`/`backgrounders`/`finishers`/`bulls`).
- Pasture Map V1 reset and system-task title labels (PRs #31-#32, pushed
  2026-06-24):
  - PROD migrations `139`, `140`, `141`, and `142` are applied and verified.
  - Pasture Map V1 ships read-only Map, group-first Plan, Field tools, saved
    measurements, basemaps/offline NAIP cache, and pasture-only Light
    farm-team-level access.
  - `tasks-cron` was deployed after migration `142`; new system-generated task
    titles include the entity label, and open system tasks were backfilled.
- Accounting snapshot and CI-radius follow-ups (`1369c61`, `7a6ce37`,
  `f6b103c`, `877b7b5`, `67051e6`, `c1cd81a`, pushed 2026-06-24):
  - Cattle Herds and Sheep Flocks have accounting snapshot month pickers for
    completed past month-ends only. Current month and future months are rejected
    by both the picker and shared snapshot helper.
  - Snapshot rows represent animals active on the final day of that month based
    on purchase/birth/created date, sale/death/delete date, and transfer
    history in farm-local Central time.
  - On-screen Herd/Flock remains present-time current group; Snapshot
    Herd/Flock shows month-end basis. CSV/print include both.
  - Main CI radius-floor failure was closed by raising pasture UI radii to the
    canonical floor and marking the tiny status swatch carve-out.
- Daily Report / Task / To Do UI follow-ups (PRs #28-#30, pushed 2026-06-24):
  - Daily report forms use filled selected Yes/No toggles with black default
    text and white selected text.
  - Daily report "Submit a Task or a To Do" copy is corrected.
  - To Do List page controls use the same selected-toggle fill style.
- Weather, mobile, layer, and CI fixes (PRs #23-#27, pushed 2026-06-23/24):
  - Mobile app-shell load hotfix restored production mobile loading.
  - Weather precipitation uses the farm map point and supports 10-year monthly
    history.
  - Eggmobile 3 / layer housing record pages show projected live hens from the
    physical anchor and mortality history instead of a misleading raw zero.
  - Six stale CI static guards were updated; remaining main unit blocker was
    later closed by the pasture radius-floor fix.
- Security/dependency closure (PRs #17-#22, pushed 2026-06-22/23):
  - RLS migration `138` was applied to PROD and verified: anon write policies
    removed from the targeted legacy write tables while authenticated policies
    remain.
  - Dependency hardening upgraded the Vite/Vitest toolchain, pinned patched
    SheetJS 0.20.3, set Netlify Node 22, and reduced `npm audit` to 0.

- Pasture Map Phase 1/2 reconciliation and Light read-only Map access
  (`7a9da4f`, `3c0fe0a`, `bd19cc0`, pushed 2026-06-20):
  - `7a9da4f`: current/next group placement is derived from the move ledger by
    canonical roster keys instead of rotation arrays.
  - `3c0fe0a`: Light home gets the new Daily Reports and View Past Reports
    image assets plus a Pasture Map tile.
  - `bd19cc0`: Map/Plan modal flow is replaced by side-panel inspectors; Map
    has no Land areas list, no centered area modal, no current-group click
    action, and hover/focus previews only the mapped area/name. Plan owns area
    management and move/planning controls.
  - Light users have read-only, Map-only Pasture Map access. Migration `136`
    widens only `list_land_areas` and `list_pasture_moves` to Light; write,
    planning, rest, stocking, and history RPCs remain non-Light.
  - Validation: `format:check` clean; lint 0 errors with 791 existing warnings;
    build green; focused static tests 142 passed; pasture Playwright config 18
    passed. Migration `136` is applied and verified on TEST and PROD.
- Pasture Map Plan-centric IA and tool lifecycle (merge `1a200ae`, pushed
  2026-06-19):
  - `359ac46`: Setup tab removed. Tabs are Map / Plan / Field / Reports. Plan
    owns Boundary tools, Tracks / Lines, classification queue, archived-area
    recovery, rotation planning, and move controls. Selecting a pasture/paddock/
    temp paddock opens a contextual area modal instead of a Setup side-list.
  - `3af3489`: tool lifecycle hardening. Measure creates only a transient
    HUD/shape and exits via Clear measurement, Done, Escape, or switching tools;
    Escape exits active draw/edit/track/measure flows; confusing "was ..."
    button subtext was removed.
  - Tracks / Lines are GPS tracks and manually drawn open lines only: draft
    geometry, no acreage, no move destination, no direct permanent promotion.
    They can be zoomed, deleted, or closed into a temp paddock by management/
    admin. Open-line editing is intentionally deferred pending a new RPC.
  - Validation after rebase onto `6b94d37`: `format:check` clean; lint 0
    errors with 793 pre-existing warnings; build green; 111 static pasture
    guards passed; all 10 pasture Playwright specs passed (`p2_map`, `setup`,
    `cp2`-`cp7`, `import`, `tweaks2`, 35 tests total).
- Broiler derived-data drift hardening (merge `6b94d37`, pushed 2026-06-19):
  - `c639311`: broiler batch record Week 4/6 display reads canonical averages
    from completed weigh-in sessions via `loadBroilerBatchWeekAverages`; shared
    average/stamp helpers converge read/write/recompute logic; `ppp-v4` read/
    upsert failures surface as `{ok:false,message}` instead of silent no-ops.
  - `6ff36c7`: `main.jsx` broiler `persist(nb)` syncs webform mirrors via
    `syncWebformConfig(null, null, nb, layerGroups, layerHousings)`, keeping
    anonymous weigh-in dropdown/meta/schooner labels fresh after broiler create/
    edit/status/schooner/brooder changes.
  - B-26-08 wk6 one-time PROD repair is complete: before `week6Lbs=0`, after
    `week6Lbs=5.76`; only B-26-08 and only that key changed; canonical average
    remains 5.76 from 30 weights.
  - Validation: `format:check` clean; lint 0 errors with 786 pre-existing
    warnings at lane time; build green; focused broiler/weigh-in/webform tests
    352 passed.
- Pasture Map planner-group redesign (merge `7ffb72d`, deployed 2026-06-18):
  - P0 `661068c`: migration `135_pasture_map_temp_paddocks.sql` plus
    `pastureMapApi` wrappers for temp-paddock lifecycle RPCs. TEST- and
    PROD-applied/verified.
  - P1 `4ca2dd2`: real planner-group roster helper with derived/locked counts
    for pigs, sheep, and cattle. Canonical move keys are `cattle_herd` herd key,
    `sheep_flock` flock key, `breeder_pigs` `sow-1`/`sow-2`/`sow-3`/`boars`,
    and `feeder_pigs` sub-batch id.
  - P2+ one-shot `3cf334b`: `PastureMapView`/canvas/CSS/offline support
    originally redesigned across Map, Plan, Field, Setup, and Reports. The
    later `1a200ae` lane removed Setup and moved its useful tools into Plan.
    Map is read-only and
    answers where groups are: occupied polygons use animal-type colors and group
    markers derived from the roster plus latest move ledger. Plan owns move and
    planned-move recording with flat roster group pickers and locked counts.
    Field owns phone-first execution/offline queue/confirm planned move/record
    track. Reports carry type/status tags and include archived context.
  - CP2/CP6/CP7/import Playwright drift was repaired in the later pasture lanes;
    all 10 pasture Playwright specs are green at `1a200ae`.
- Weather rebuild and follow-ups:
  - `d7f761a`/`be11e60` rebuilt the Home Weather card around structured
    Open-Meteo forecast data, an official NWS radar link, a 10-day forecast, and
    monthly precipitation history for 2026 plus the previous three years.
    Removed the weak in-app radar and vague narrative/weather-alert panels.
  - `d282b6a` changed the 10-day forecast wind mph display to sustained daily
    max wind (`windSpeedMax`), not gusts. Focused weather/static tests,
    `format:check`, lint, and build passed in the weather worktree before push.
- Production page:
  - `3021078` changed Summary to an all-years Program x Year matrix and rebuilt
    Production Events around planner events plus legacy `production_legacy_events`
    rows, excluding egg-day records from the event list.
  - `8b21a20` removed the year picker/top duplicate stat from events, ensured
    all imported production events show, and links matched broiler processing
    events to batch record pages when the batch can be deduced.
- List controls - column pickers, program-color tool buttons, always-flat
  results (2026-06-18):
  - Broiler Batches: rich filtering + single-rule sort + saved views scoped to
    the PROCESSED table only; a processed-table column/display picker over ~30
    fields (saved in views); Batch Comparison removed; processed default sort is
    processing-date descending. Active/planned batches stay pinned above the
    controls, untouched. Pure filter lib: `src/lib/broilerBatchFilters.js`.
  - Cattle Herds + Sheep Flocks: a column/display picker over every field
    (cattle 23, sheep 25), persisted per surface (`cattle.herds.columns` /
    `sheep.flocks.columns`) and stored in saved views. The grouped/flat view
    toggle is REMOVED - results are always one flat list; outcome herds/flocks
    (processed/sold/deceased) stay browsable in the collapsible sections below.
    `tag` is always shown.
  - Selected tool buttons fill with the program color + readable (white) glyph
    to match the filled top-nav tab - broiler gold, cattle maroon, sheep green.
    `getReadableText(accent)` returns white for cattle/sheep; broiler gold is
    light, so the broiler selected glyph is hard-set white.
  - Daily program list pages + Home "Last 5 Days" render as white record-cards
    via shared `DailyRecordCards` (Egg Dailys included; hover-lift preserved).
  - Shipped to `main`: daily cards `eb1d1c4`, production multi-year `3021078`,
    broiler `7f9256e`, cattle/sheep `c666553`. Validation: `npm run build`
    green; cattle/sheep `eslint` 0 errors; `npm run format:check` green; full
    Vitest at the documented 7 pre-existing failures (programColors, global
    activity, image capture, pig batch filters/planned trips, breeding pig
    links, pasture radius floor) with no new failures; all 5 cattle e2e specs
    green (the grouped-tile `cattle_herd_filters` spec was rewritten flat-only).
  - Pitfalls logged: the `radius_floor` guard scans every file, so the new
    column-row hover radius had to be `>=10px` (bumped 8->10 in all three
    views); the `openable_hover_affordance` guard greps the literal
    `hoverable-tile` string, so a stale comment mentioning it tripped the guard
    after `openableProps` was removed - reword such comments.
- Design-law compliance pass (CP0 A1-A12 + Tabs + WI-6; 2026-06-17 designer
  audit, 53 findings):
  - Tokens + Constitution amended to CP0 - true-black primary text, one defined
    border gray, 10px radius floor + documented sub-10 allowlist - with the
    `design_token_contract` / `radius_floor` / `openable_hover_affordance` guards
    updated in the same change.
  - Universal hover affordance: tile/card openables lift 3px/300ms + trailing
    chevron. Shared `DataTable` rows use row-hover wash + cell-border emphasis +
    chevron without transforming `<tr>`. Daily report lists now use div-based
    `.hoverable-tile` record cards so they get the exact Home-tile lift.
  - Header sub-nav selected tab -> filled program-color PILL (radius 999: pig blue
    / broiler gold / layer orange / cattle maroon / sheep green); unselected =
    plain text; dark-green top-bar chrome kept.
  - Site-wide color sweep (all programs): stat numbers -> black, species/group/
    herd/flock -> dot + black label, card backgrounds + colored borders
    neutralized, status -> shared `Badge`, category chips -> dot+label/text,
    primary actions re-tinted per program; semantic colors (mortality, YoY,
    warn/danger notices) preserved.
  - Dailys (Ã—6): status row-fills removed, comments black + 2-line clamp,
    herd/flock pills -> dot+label, `DataTable` windowed render cap (export/print/
    filters/saved-views unchanged).
  - Broiler PROCESSED cards -> shared `DataTable`; weigh-in list + shared session
    page program-accented. Pasture Map intentionally untouched.
- Pasture Map header polish:
  - `/pasture-map` uses the shared app `Header` instead of a pasture-only header.
  - The WCF Planner brand in the shared header is a home link.
  - Pasture Map mode tabs are pure black text until selected, then render as a
    pure black filled pill with pure white text.
  - Static guards cover the shared-header route contract and tab color behavior.
- Task notifications hotfix:
  - `tasks-cron` still generates recurring template tasks and now also generates
    eligible system tasks from active `task_system_rules`.
  - System task generation reads the real planner stores:
    `ppp-v4`, `ppp-feeders-v1`, `ppp-breeding-v1`, and `ppp-farrowing-v1`.
  - `lead_time_days` controls when a system task is minted; `due_date` remains
    the actual farm event date.
  - To Do completion submitted by non-managers now notifies management/admin
    that approval is waiting.
  - Whoever created a To Do is notified when completion is approved or
    auto-approved.
  - Migration `133` is TEST- and PROD-applied; `tasks-cron` Edge Function v3 is
    deployed, active, and smoked in PROD.
- Originator task/to-do editing:
  - Task creators and admins can edit open task title, details, due date,
    assignee, and append request photos from the task record page.
  - To Do creators/managers can edit existing To Do data and append additional
    origination photos from the To Do record edit panel.
  - Migration `134` is PROD-applied and preserves RPC-only writes, append-only
    private photo storage, and the shared 5-photo total cap.
- Site-wide Home aesthetic parity rollout:
  - Foundation/global token layer and shared openable hover primitives.
  - Admin, activity, webforms, equipment, Task Center, To Do, cattle, sheep, pig,
    broiler, layer, and livestock parity slices.
  - Program identity colors remain small accents; broad pastel fills were
    reduced where scoped. Green Header chrome remains.
  - Guard repairs closed stale assumptions around z-index, task photo ownership,
    My Submissions, webforms, record-page shell, and openable hover.
- Site-wide UI cleanup core and DataTable conversion:
  - Merge PR #9 (`59bc089`) shipped canonical primitives: `DataTable`, `Badge`,
    `StatusText`, `EmptyState`, `OperationalListEmptyState`, `SectionBand`,
    `Toolbar`, and `Tabs`. Program accents come from
    `src/lib/programColors.js`.
  - Ordinary operational text tightened to true black for primary titles,
    labels, row values, buttons, and main numbers; supporting metadata stays
    muted gray.
  - Radius floor is active: UI element radii must be at least `10px`; values
    `1`-`9` are retired except explicit decorative `radius-allow` carve-outs
    and the ratified `.home.theme-crisp` island.
  - Merge PR #10 (`be63b96` / `9d22fab`) converted the 12 named list surfaces
    from faux cards/grids to shared `DataTable`: broiler/cattle/pig/layer/egg/
    sheep dailys, cattle herds, sheep flocks, breeding pigs, and cattle/sheep/
    livestock weigh-ins.
  - Rows are real `<tr>` `.hoverable-row` openables with keyboard row-open,
    fail-closed loading/error/empty states, and mobile stacked record-lines.
- Cattle forecast mobile overflow:
  - Merge PR #14 (`9647d55` / `819d285`) wraps the wide forecast chart, month,
    and past-actual tables in local horizontal scroll so the page does not force
    body-level overflow on mobile.
- Feed-order month hotfix:
  - Pig and broiler feed boards use the same calendar-pinned order-month rule.
  - "Order for `<month>`" stays on the next calendar month until the calendar
    advances; saving an order no longer rolls the board to the following month.
  - Source owner: `src/lib/feedOrderBasis.js` (`calendarOrderYM`).
- Breeding pigs parity:
  - Breeding pigs are table-based by group, not modal/card Record-button tiles.
  - Table rows open `/pig/sows/<id>` with hover affordance.
  - Breeding-pig record pages mount Comments + Activity via `pig.breeder`.
  - Migration `126` adds `pig.breeder` to the Activity read/write resolver and
    is PROD-applied.
- Animals on Farm snapshot hotfix:
  - Home uses the shared current animal snapshot logic and no longer carries the
    stale layer-count import.
  - Animals on Farm page remains the monthly history/detail view.
- Production page:
  - Home Production card opens `/production`.
  - No combined total exists anywhere; totals are per program only.
  - Year-over-year values are per program/year.
  - Visible page language is production reporting, not import/audit
    reconciliation. The page shows Summary and Production Events; no visible
    Reconciliation/Audit tab, source split, Planner-vs-backfill split, Podio
    terminology, Raw-Podio columns, or delta-vs-Podio columns.
  - Production data auto-updates from Planner sources plus historical backfill.
    The reconciliation rule is internal: Planner wins by program/year coverage;
    historical rows count only for program/years with no Planner events.
  - Light users are excluded from `/production`.
  - Migration `125` and the 69-row legacy import are PROD-applied.
- Pig weigh-ins:
  - Pig weigh-in record pages render entries as dense tables, not card/badge
    grids.
  - The send-to-trip control is the leftmost row checkbox; the existing
    `Send N to Trip` modal/action flow is preserved.
  - `/pig/weighins` is split into Active and Complete sections. Pig list saved
    views, CSV export, Print, and status filters are removed. Broiler weigh-ins
    keep the shared saved-view/export/print/filter behavior.
- Pasture Map:
  - Home shows a Pasture Map button beside Weather above Processing/Admin.
  - `/pasture-map` renders the one-page grazing cockpit with Map, Field, and
    Reports tabs. Plan is folded into Map; the Setup tab was already removed.
  - Map is the single working surface (Plan merged in). Desktop hover shows the
    read-only area readout; clicking/tapping an area opens the accessible Area
    modal for area configuration only. The modal has one upper-right `X` close
    affordance and debounces/saves edits on close.
  - The Map side panel uses DataTable-style Animal Groups rows. Clicking a group
    row opens the inline group record beside the full map. Group records show
    details, a chip-based rotation editor, a current->next move box with
    date/time and optional actual group weight, and grazing history.
  - Rotation order is the planning source. The old planned-move utility/table/
    RPCs and free-form Record/Plan move forms are removed.
  - Occupancy visuals are derived from the real planner-group roster and latest
    `pasture_move_events` by canonical `(animal_type, group_key)`, not from
    ad-hoc/free-form groups. Occupied polygons fill by animal type and show
    group markers. Parent pasture fill suppresses direct-child overlap state.
    Group row hover is table-only; it does not preview on the map.
  - Field mode provides phone-first execution controls, offline queue/sync
    state, `My Location`, `Fit Farm`, and draft-lines visibility when
    applicable.
  - Client parses OnX KML with `@tmcw/togeojson`; Polygons import as reviewable
    areas; LineStrings import as outline candidates and are never auto-closed.
  - Tracks / Lines are draft LineStrings only. They have no acreage, are
    excluded from move destinations and rotation seeding, render on the working
    Map and on Field (via the Draft-lines toggle), and can be zoomed/deleted/
    closed into a temp paddock. Edit for open LineStrings is deferred until a new
    line-geometry RPC exists.
  - Read access starts at `farm_team`; management/admin can import/classify,
    close/delete permanent areas, draw/edit permanent geometry, promote temp
    areas, manage Tracks / Lines, and delete individual grazing stays. Farm-team
    users can view/measure, record moves from the group record, and create temp
    paddocks/tracks through the temp lifecycle. Light is pasture farm-team-level
    (migration `139`): Light keeps the farm-team working controls on Map and
    Field and is NOT Map-only/read-only; only management/admin-only actions stay
    gated.
  - Map rendering uses Leaflet with Esri World Imagery as the primary online
    imagery source. Geometry is provider-neutral GeoJSON/PostGIS; Google is not
    the geometry source.
  - Draw/edit uses Leaflet-Geoman with snapping, transient measure HUD, client
    self-intersection warnings, Escape exits, and DB-side validity checks.
    Measure never persists geometry.
  - Geometry edits are append-only versions. UI acreage is computed/read-only;
    raw OnX/manual acreage is a cross-check, not the normal editing path.
  - Permanent pasture boundaries are fixed blue 4px and permanent paddock
    boundaries are fixed bright green 4px. Temp paddocks default to white dashed
    5px and are style-editable. Only temp paddocks and GPS/field tracks have
    editable line style.
  - Migrations `116`, `127`, `128`, `129`, `130`, `131`, `132`, `135`, `136`,
    `139`, `140`, `141`, `143`, `147`, and `148` are present on PROD. Offline
    imagery cache is not built; vector/cache/queue behavior is present.
  - `design_handoff_pasture_map/` is committed as the design reference bundle;
    production code does not import from it.

---

## Build Queue

Treat these as product lanes, not hotfixes, unless Ronnie says otherwise.
This is the canonical home for outstanding build/design work.

1. Monthly Newsletter Checkpoint B automation and first-production verification
   - Status: NEXT NEWSLETTER LANE. Checkpoint A is shipped: code is merged to
     `main`/pushed, PROD has migrations `144`/`145` and both newsletter buckets,
     and PROD currently has `0` newsletter issues.
   - Class: `ENH`/`AI`/`DB-GATE`/`SECURITY`/`AUTOMATION`.
   - Scope:
     - Add fact detectors for animal counts, births, production records,
       processing/yield highs, and other positive noteworthy events. Keep the
       no-finances/no-mortalities rule enforced.
     - Build the `newsletter-harvest` Edge Function/AI adapter with fixed prompt,
       structured JSON/block output, run logging, and admin final-editor flow.
     - Add migration `146` for ingest/automation helpers, monthly task/cron
       scheduling, and any DB-side references needed by the Edge Function.
     - Wire the required AI provider Vault/API secret and monthly `pg_cron`
       schedule after explicit approval.
     - Add a normal admin navigation entry to `/admin/newsletter` once Ronnie
       signs off on placement.
     - Do a first-production content pass: create a real draft, upload/approve
       photos, set cover, preview, publish, verify `/newsletter/latest`, then
       unpublish/republish if the workflow needs adjustment.
   - Validation target: TEST apply of `144`/`145`/`146` in order for automation
     work; newsletter static guards; API/unit tests; public/admin Playwright;
     storage upload/approve/remove browser coverage with real staging->public
     bytes; PROD catalog checks after any approved apply/deploy; noindex and
     preview-token hardening checks.
   - Gates: PROD migration `146`, Edge Function deploy, Vault secret, cron
     enablement, nav/release push, and first-production publish are explicit
     Ronnie gates. Do not assume Checkpoint A approval covers automation.

2. Processing Calendar Asana import and native workflow
   - Status: PLANNING CONSENSUS ONLY. No build prompt has been issued and no
     schema/importer/UI work is approved yet. Codex should ask Ronnie the
     blocker questions one at a time before writing the CC build prompt.
   - Class: `ENH`/`DB-GATE`/`SECURITY`/`STORAGE`/`DATA-IMPORT`.
   - Source/design: `design_handoff_processing_calendar` contains the prototype
     handoff, CSV, README, and support file. The CSV is not sufficient for
     import because comments, attachments, Asana gids, recursive subtasks, and
     reliable metadata require the live Asana API.
   - Verified live API checkpoint on 2026-06-26: project
     `1201484014160203` (`SF Processing Calendar ` with trailing space), 117
     top-level records, 5 top-level milestones, section counts Broiler 48 /
     Cattle 27 / Pig 29 / Lamb 13, 1,132 CSV subtask rows, 122 real comments
     on 52 top-level records, 71 attachments, and 0 live dependencies. The
     importer must self-audit current live counts at cutover; do not hardcode
     these counts as permanent truth.
   - Consensus defaults unless Ronnie changes them:
     - Build a standalone Processing domain with its own tables and
       `asana_gid` provenance; do not mutate cattle/sheep/pig/broiler source
       tables during import. Link to existing program records only when a
       confident match exists.
     - Treat the Asana import as one-time, idempotent, and re-runnable unless
       Ronnie explicitly asks for ongoing sync.
     - Use a server-side/service-role importer, store the Asana token only in
       Supabase Vault, preserve original timestamps and historical comment
       author display names, and suppress notifications during import.
     - Import real Asana comments. Do not import Asana system activity/stories,
       field-change logs, likes, follower/rule events, or status-change noise.
       Native WCF Activity should begin from cutover forward.
     - Copy Asana-hosted attachments into WCF/Supabase Storage if Ronnie
       approves the Storage/Vault gates; do not rely on temporary Asana links
       for durable records.
     - Use per-record field snapshots plus active/retired template fields so
       deleted fields hide on future batches but remain visible on past batches
       where they existed.
     - Group program by Asana Section, not the broad `Farm Programs` field.
       Milestone/non-batch classification remains an open Ronnie decision.
     - Preserve real Asana field types/options: `Processor` is enum, `Farm`
       includes GOF/WCF, `Year` enum is 2023-2027, actual dates reach 2022,
       `Status (Animal Master)` has the real Asana option set, and
       `Farm Programs` is a broad global field. Derive display year from
       processing date when `Year` is null so 2022 records do not disappear.
     - Recursively fetch subtasks. Flatten nested subtasks for v1 unless Ronnie
       asks for nested checklist UI.
     - Conform to CP0/design-system contracts and use the normal full-page
       record route pattern unless Ronnie explicitly approves a new drawer
       primitive. Light users are excluded by default.
   - Blocker questions Codex must ask Ronnie one at a time before the build
     prompt:
     1. Standalone Processing domain vs directly unifying existing program
        batch tables.
     2. One-time Asana import vs ongoing Asana sync.
     3. Full-page Processing record route vs slide-in panel.
     4. How to classify non-batch top-level records and milestones.
     5. Whether imported records are editable or historical-locked after import.
     6. Whether attachments must be copied into Storage.
     7. Completion source of truth: Asana completed state, `Status
        (Processing)`, or all subtasks complete.
     8. Which existing WCF workflow creates future Processing records, since
        batches cannot be created inside the Processing tab.
     9. Permissions by role for view/edit/templates/comments/milestones.
     10. Field/template deletion and versioning behavior.
   - Validation target: API dry-run inventory with live count reconciliation;
     TEST-only schema/import first; idempotent re-run proof; imported task,
     field, subtask, comment, attachment, milestone, and author-display spot
     checks; static design/RLS/permission guards; focused browser coverage for
     list filters, record pages, comments, subtasks, templates, milestones, and
     hover/openable table behavior.
   - Gates: TEST migration/import may happen only inside an approved lane. PROD
     migration apply, Vault secret add/rotate, Storage bucket creation/change,
     Asana import cutover, Edge Function/deploy work if any, commit, push, and
     release are separate Ronnie gates. `exec_sql` in PROD remains forbidden.

3. Pasture Map CC#1 area record, pop-out tiles, and rest-history reconciliation
   - Status: BUILT on `fix/pasture-prod-smoke-warning-cleanup`; pending
     review/merge and explicit PROD migration `149` approval. Do not treat the
     migration as PROD-applied until CC reports the approved apply/verification.
   - Class: `DEFECT`/`UX`/`DB-GATE`.
   - Scope built:
     - Combined the Map Area modal and Reports Area record around one canonical
       Area Record body. The Map modal now shows grazing history; the Reports
       record now has the same management/config controls. Move recording
       remains in the animal-group workflow, not the area record.
     - Added shared explicit area-name editing for Map and Reports: Edit opens a
       controlled input, Save/Cancel are visible, Enter saves, Escape cancels
       without closing the host modal, and saving/saved/error states are shown.
       Permanent areas save through `updateLandArea`; temp areas save through
       `renameTempLandArea`.
     - Rebuilt the Map Animal Groups launcher plus Reports Areas and Reports
       Animal Groups launchers as `.hoverable-tile` pop-out openable tiles with
       shared `openableProps`, keyboard activation, and chevron reveal. These
       surfaces are no longer DataTables because they open records rather than
       present dense tabular data.
     - Removed duplicate last-grazed copy from the area summary; grazing recency
       and stay counts live in Grazing History.
     - Added migration `149_pasture_map_rest_history_reconciliation.sql` to
       replace `_land_area_summary` so orphan NULL-link move impacts from reset
       or hard-delete flows no longer make FP3/FP3A1 read "Resting" or "Last
       grazed" when Reports show no visible stay. The migration is read-function
       only: no schema, RLS, or data mutation.
   - Validation target: `npm run format:check`, focused static pasture guard
     tests, focused Pasture Map Playwright including
     `tests/pasture_map_tile_hover.spec.js`, and TEST-only migration `149`
     verification with `scripts/apply_test_mig_149.cjs` before any PROD apply.
   - Gates: commit/push approved in this wrap. Merge/release remains separate.
     PROD migration `149` apply and verification remain separate Ronnie gates;
     `exec_sql` in PROD is still forbidden.

4. Pasture Map open-line Edit fast-follow
   - Class: `ENH`/`DB-GATE`.
   - Scope: allow editing saved Tracks / Lines LineString geometry. Current
     polygon edit RPCs intentionally reject line geometry; open lines can be
     zoomed, deleted, or closed into a temp paddock, but not edited in place.
   - Success criteria: add a narrow RPC such as
     `update_land_area_track(p_id text, p_line_geojson jsonb)` gated to
     management/admin, validating LineString/MultiLineString only; wire Geoman
     line edit UI; preserve Tracks / Lines semantics (no acreage, no move
     destination, no direct permanent promotion); add static and Playwright
     coverage.
   - Gate: TEST migration apply inside lane; explicit Ronnie PROD approval for
     the new migration and PostgREST schema reload. No manual PROD JSON edits.

5. P3 derived-data durability/audit residuals
   - Class: `DEFECT`/`ENH`.
   - Scope candidates from CC#2 audit: pig mortality/trips durability, cosmetic
     `calcPoultryStatus` cleanup, and orphan system-task detection/cleanup.
     These are not active lanes and should be scoped one at a time.
   - Success criteria: each sub-lane states source of truth, write path, read
     path, guard tests, and whether a one-time data repair is needed.
   - Gate: depends on sub-lane; data cleanup needs explicit PROD approval.

6. Parity Residuals
   - Class: `ENH`.
   - Known small follow-up from the parity rollout: Home quick-nav tiles need a
     narrow-phone fix because `.home .tile` is missing `min-width: 0`, which can
     let quick-nav tiles overflow at `<=375px`.
   - Scope each separately; do not reopen a full site-wide parity pass without a
     new audit.
   - Gate: code-only unless a touched surface needs a guard update.

7. Design-Law Compliance residual follow-ups
   - Class: `ENH`. The CP0 compliance pass (A1-A12 + Tabs + WI-6; the 2026-06-17
     designer audit) shipped 2026-06-18. Source of truth for the laws is
     `CP0-SIGNOFF.md`, folded into Global Decisions + Design System above. These
     are the deliberately deferred tails only:
   - Section 5.4 explicit empty-state: pig/layer dashboard all-dash group cards
     show `--` rather than a "No data yet" label. They are genuine empties
     (A9-ok) and A10 says leave dashboards as-is, so this is low-priority polish.
   - Optional dedicated static guards for Tabs + A12 color-discipline laws.
     Today they are enforced by the sweep + code review + existing
     `design_token_contract` / `openable_hover_affordance` guards.
   - Pre-existing main test debt, unrelated to this lane: `ActivityLogView`
     retry, `PigBatchesView` filters/grid, and `SowsView` breeding-record entry
     point. Scope separately.
   - Gate: code-only.

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
| Design-law package (CP0) | Ratified 2026-06-16 (CP0-SIGNOFF A1-A12 + Tabs); compliance pass shipped 2026-06-18 | folded into Global Decisions + Design System; residual follow-ups in Build Queue 6 |
| True-black text (CP0 section A1) | Ratified; `--text-primary`/`--ink`/island `--text` = `#000`; `getReadableText` exempt | `design_token_contract_static.test.js`, island/openable guards |
| One border gray (CP0 section A2) | Ratified; `--border` == `--border-strong` (one defined gray) | `index.html` token layer |
| Program-color tabs (CP0 Tabs) | Selected tab = filled pill in program color; unselected = plain text; header sub-nav adopts it; top green chrome stays | `Header.jsx` sub-nav + `Tabs.jsx`; no dedicated static guard (Build Queue 6) |
| Closed badge set (CP0 section A4) | `ok/warn/danger/info/neutral`; <=1 per row; soft signals = colored text | `Badge.jsx`; broiler/pig/cattle batch static guards assert `<Badge>` adoption |
| One table system (CP0 section A6) | hairline rows, no zebra, right-aligned numbers, status as text first, whole-row openable | `DataTable.jsx`, `DataTable.css` |
| Color discipline (CP0 section A12) | program accent only on pill/dot/one-figure/brand-button; closed text-color set; species = dot + black label | enforced by the sweep + `design_token_contract`/`openable_hover` guards; no dedicated grep guard (Build Queue 6) |
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
- The public `#webform-container` island adopts the CP0 section A3 10px radius floor on
  the app `:root` (`index.html`/`dailys.html`/`equipment.html` aligned 2026-06-17);
  the island's own `--wf-r-*` corner radii are pending the CP5 forms pass.
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
- `/animals-on-farm`: newest-first monthly species counts and multi-series line
  graph for Broilers, Layer Hens, Pigs, Cattle, Sheep, and Total. History range
  starts Oct 2024.
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
- Admin/config: `/admin`.
- Admin runtime observability: `/admin/client-errors`.

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

### Supabase Migrations

Current PROD architecture includes all applied migrations through `116`, plus
`125` through `145`, `147`, and `148`. Migration `146` is reserved for the next
newsletter automation lane and is not written/applied. Recent load-bearing
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
- `146` Newsletter automation (RESERVED, not written/applied):
  - Expected to own monthly `pg_cron`, newsletter harvest/generation scheduling,
    Edge Function/Vault secret references, and any DB-side automation helpers.
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
- `149` Pasture Map rest/history reconciliation (WRITTEN, not PROD-applied):
  - Replaces `_land_area_summary` so orphan `pasture_move_impacts` whose move
    event has NULL `to_land_area_id`/`from_land_area_id` no longer derive
    occupancy, last touch, or resting state. This resolves the FP3/FP3A1 defect
    where the Map showed "Resting/Last grazed" while Reports showed no visible
    direct stay.
  - Preserves migration `147` child-from-parent suppression and does not change
    schema, RLS, grants, or return shape. Stale orphan impact rows are ignored,
    not deleted. PROD apply requires an explicit Ronnie migration gate.

Special migration notes:

- `082` is intentionally unused.
- `083` public webform submitter identity is shelved.
- `085` was applied before `084` in PROD so duplicate active daily identities
  were cleaned up before unique indexes.
- `061_daily_report_soft_delete_restore.sql` is superseded by `067`.
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

Newsletter buckets are current PROD infrastructure as of 2026-06-26:
`newsletter-staging` is private/admin-only for uploads and copied planner photos
before approval; `newsletter-public` is public-read/admin-write and receives
only approved newsletter photo bytes.

Append-only upload expectations:

- Uploads use `upsert: false` unless a lane explicitly changes the contract.
- Duplicate-object errors are treated as retry success where the upload path is
  idempotent.
- Private buckets use signed URLs; public buckets use public URLs.
- No code should mutate `storage.objects` directly.

### Important Files

- `src/main.jsx`: app shell, view routing, auth-gated view rendering, global
  modals.
- `src/lib/routes.js`: canonical route map and aliases.
- `src/dashboard/HomeDashboard.jsx` and `src/dashboard/homeRedesign.css`: Home
  dashboard and scoped Home styling.
- `src/dashboard/ProductionPage.jsx`, `src/lib/production.js`, and
  `src/lib/productionApi.js`: Production reporting page, internal production
  model/reconciliation rules, and data loading.
- `scripts/import_production_legacy_events_from_xlsx.cjs`: spreadsheet backfill
  importer for `production_legacy_events`.
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
  `139_pasture_map_light_farm_team.sql`, `140_pasture_map_rotations.sql`,
  `141_pasture_map_measurements.sql`, `143_pasture_map_reset_area_history.sql`,
  `147_pasture_map_grazing_entry_delete_and_parent_overlap.sql`, and
  `148_pasture_map_group_records_weight_and_planned_move_cleanup.sql`: Pasture
  Map schema/RPC lanes through group records and actual-weight grazing metrics.
- `scripts/apply_test_mig_127.cjs` through `scripts/apply_test_mig_132.cjs`,
  plus `scripts/apply_test_mig_147.cjs` and `scripts/apply_test_mig_148.cjs`:
  TEST apply/smoke helpers for the Pasture Map lanes.
- `src/newsletter/*`, `src/lib/newsletterApi.js`, `tests/newsletter_public.spec.js`,
  `tests/static/newsletter_boundary_static.test.js`,
  `supabase-migrations/144_newsletter_engine.sql`,
  `supabase-migrations/145_newsletter_public_bucket.sql`, and
  `scripts/apply_test_mig_144_145.cjs`: Monthly Newsletter Checkpoint A public,
  admin, API, boundary, migration, and TEST smoke owners.
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
- `src/livestock/WeighInSessionPage.jsx` and
  `src/livestock/LivestockWeighInsView.jsx`: shared weigh-in record/list
  surfaces, including pig table entries and pig Active/Complete session list.
- `src/lib/savedViewsApi.js`: generic saved views on `app_saved_views`.
- `src/lib/csvExport.js` and `src/lib/printExport.js`: CSV and print owners.
- `src/lib/todoApi.js`: To Do List client owner.
- `src/shared/DeleteModal.jsx`, `src/shared/ConfirmModal.jsx`, and
  `src/shared/useModalFocusTrap.js`: modal primitives.
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
  public `#webform-container` island radius is pending the CP5 forms pass.
- New sub-10px control/card/row radii require a Ronnie-approved amendment and a
  matching guard update.
- Guards: `radius_floor_static.test.js` (floor + allowlist) and
  `design_token_contract_static.test.js` (canonical set on locked primitives).

### Stacking And Elevation

- Dialog layer order keeps Confirm/Delete at toast `9000`; other overlays and
  modals remain below that tier in the shared z-index ladder.

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

- Not shipped yet. The Processing Calendar is the planned Asana replacement for
  the `SF Processing Calendar ` project, not the existing `/production`
  reporting page.
- `/production` remains the processed-output reporting surface. The Processing
  Calendar should be a workflow/schedule/record surface for processing batches,
  milestones, comments, attachments, custom fields, and subtasks.
- Asana import must use the API, not CSV alone. The CSV can assist audit only;
  authoritative import needs Asana gids, sections, custom field gids/options,
  recursive subtasks, comments, attachments, and user metadata.
- Import comments, not activity. Preserve real comment author display,
  timestamp, and body. Do not import Asana system stories, field-change logs,
  likes, follower/rule events, or status-change noise.
- Imported Activity tabs start empty and accrue only native WCF events after
  cutover.
- The Asana token is a live secret and must not be committed, pasted into docs,
  or stored in source. Future importer work must use Supabase Vault or an
  equivalent approved secret path.
- Historical field behavior requires versioning/snapshots: retired fields must
  disappear from future batches while remaining visible on past/imported batches
  where they existed.
- Default planning stance is standalone Processing tables with `asana_gid`
  provenance and optional links to existing program batch records. This remains
  pending Ronnie's answer before build.
- Program grouping should come from Asana Section, not the broad
  `Farm Programs` custom field. Year filters must not hide records whose Year
  field is null but whose processing date is in 2022.
- Existing CP0/design-system contracts apply. Do not copy prototype styles that
  conflict with true-black text, radius floor, closed badge set, table hover,
  or program-accent rules unless Ronnie approves a Constitution amendment.

### Monthly Newsletter

- Current shipped scope is Checkpoint A: manual public archive + admin editor,
  migrations `144`/`145`, and newsletter storage buckets. Checkpoint B remains
  automation: fact detectors, AI generation, `newsletter-harvest`, migration
  `146`, Vault secret, monthly task, and `pg_cron`.
- The newsletter is a public no-login web archive at `/newsletter`, with past
  months navigable and a latest-issue route. Public issue pages must be
  `noindex`; this is an invariant, not a setting admins can accidentally drift.
- Admin creation/editing lives inside the planner and is admin-only. The public
  reader surface is web-only; no PDF, email send, RSS, or reader login is part
  of the current requirement.
- The newsletter voice is factual positive PR for owners and periphery staff,
  styled like White Creek Farm's current emails. Titles follow the pattern
  `White Creek Farm June Review`; target length is about two pages.
- Content should be based on prior-month facts: animals on farm, births, notable
  processing/production/yield records, and other genuinely noteworthy good-news
  events. Do not include finances or mortalities. First names of team members
  are OK; avoid sensitive/private details and never expose private file paths.
- The monthly workflow is one coordinated late-month task/reminder plus an
  admin Q&A/intake pass that asks for events the planner may not know. Photo
  requests should be generated from what is noteworthy; admins can add/remove
  suggestions and must approve photos before publication. Every issue should
  have at least a few photos.
- AI generation must stay inside the planner via a fixed prompt/template in the
  API/Edge Function setup. The model returns structured blocks only; the
  renderer whitelists block types and never renders raw AI HTML. Ronnie remains
  the final editorial approver.
- Data boundary: newsletter tables are deny-all RLS and exposed only through
  narrow SECURITY DEFINER RPCs. The anon surface is exactly published list,
  published issue, and token-gated preview. Public and preview payloads expose
  approved photo paths only; draft facts, intake, runs, settings, and private
  source paths stay admin-only.
- Photo boundary: uploads/copies start in private `newsletter-staging`. Approval
  copies bytes to public `newsletter-public`; unapproval deletes the public copy.
  A photo row being present or suggested is not public consent.
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
  promotion.
- Computed acreage is geodesic and the UI shows it read-only. OnX/raw/manual
  acreage can exist as cross-check data, but the normal editing path must not
  ask users to type acreage or rest days.
- Draw/edit controls use Leaflet-Geoman. Snapping, live area/perimeter measure,
  Escape exit, and client self-intersection warnings are UI requirements; the
  migration `127` RPC validity gates are the database backstop. Measure is
  transient and must never persist a land area/track/temp paddock.
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
  Setup was already removed. Map is the single working surface: hover reads;
  clicking a map area opens the accessible Area MODAL (`PastureAreaModal.jsx`:
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
  Field is phone-first execution/offline queue. Reports use pop-out openable
  tiles for Areas and Animal Groups; opening an Area renders the same canonical
  Area Record body. Reports also include animal-group grazing stays/metrics,
  inactive groups behind an Include inactive groups filter, and per-stay delete.
  Light is pasture farm-team-level on the merged Map and Field.
- Move ledger / coloring contract: an area's occupancy/rest state is
  read-derived in `_land_area_summary` from `pasture_move_impacts`
  (`destination`/`overlap`/`departure`), not stored on `land_areas`.
  `record_pasture_move` still writes overlap impacts for intersecting areas, but
  migration `147` suppresses direct-child overlap impacts when deriving parent
  pasture state. Migration `149` (pending PROD apply until explicitly approved)
  additionally ignores orphan impacts whose move event has lost its directional
  `to_land_area_id`/`from_land_area_id` link, so an area cannot read
  "Resting/Last grazed" without a visible stay or non-orphan impact explaining
  it. A permanent paddock's bright-green stroke is a LOCKED designation color,
  independent of state; the FILL is the state.
- Boundary visibility toggles hide/show pasture, paddock, or temp-paddock
  strokes only. Animal occupancy fills and group markers remain visible. Draft
  lines render on the working Map; Field has a Draft lines toggle; selected draft
  lines show for context.
- Permanent pasture stroke is locked blue 4px; permanent paddock stroke is
  locked bright green 4px. Temp paddocks default to white dashed 5px and can be
  restyled. Only temp paddocks and GPS/field tracks have editable line style.
- Open-line edit is not built. It needs a future narrow RPC such as
  `update_land_area_track(p_id text, p_line_geojson jsonb)` plus TEST/PROD
  migration gates. Until then, saved Tracks / Lines can be zoomed, deleted, or
  closed into temp paddocks, but not edited in place.
- Current Pasture Map includes the real-roster redesign, move ledger,
  animal-color occupancy, pop-out openable launch tiles, inline group records,
  chip-based rotation planning, group-record move logging, actual-weight
  grazing metrics, per-stay grazing delete, history/rest/stocking reports,
  offline vector snapshot/queue, GPS field tracks, line styling/pattern
  controls, temp-paddock lifecycle, the single-X Area modal, the shared
  Map/Reports Area Record body, explicit area-name editor, and Light pasture
  farm-team-level Map/Field access. It does not include offline imagery cache,
  daily-report wiring, open-line edit, or a generic undo stack; corrections are
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
- Cattle Herds and Sheep Flocks render a single always-flat list (the
  grouped/flat view toggle was removed). A column/display picker chooses which
  of the full field set shows; `tag` is always shown; the choice persists in
  saved views (`columnVisible` gates `cowTableColumns` / `flatColumns`). Outcome
  herds/flocks stay browsable in `CollapsibleOutcomeSections` /
  `SheepCollapsibleOutcomeSections` below the flat list. Do not reintroduce the
  per-herd/per-flock grouped tiles or a `viewMode` toggle.
- Heifer-to-cow promotion fires from both calving records and calf-row dam links.
- Manual transfer goes through `transfer_cattle_animal` /
  `transfer_sheep_animal`.
- Processing-batch unschedule/delete go through audited SECDEF RPCs
  `unschedule_cattle_processing_batch` / `delete_sheep_processing_batch`.
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
- Light My Submissions edits/deletes its own equipment fuelings and fuel
  supplies through ownership RPCs.
- Fuel-log edit/delete paths recompute current readings from remaining fuel logs.
- Equipment checklist/material edits must not reload, lose focus, or reorder list
  items on click/edit.
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
| Home / dashboard alerts | `tests/static/home_missed_daily_reports_static.test.js`, `tests/static/home_next_30_icons.test.js`, `tests/static/home_daily_tile_routing_static.test.js`, `tests/static/home_animal_history_static.test.js`, `src/lib/animalHistory.test.js`, `tests/static/light_user_portal_static.test.js` |
| Production | `src/lib/production.test.js`, `tests/static/production_page_static.test.js` |
| Newsletter | `tests/static/newsletter_boundary_static.test.js`, `src/lib/newsletterApi.test.js`, `src/newsletter/NewsletterBlocks.test.js`, `tests/newsletter_public.spec.js`, `scripts/apply_test_mig_144_145.cjs` |
| Pasture Map | `src/lib/pastureKml.test.js`, `src/lib/pastureGeometry.test.js`, `src/lib/pasturePlannerGroups.test.js`, `tests/static/pasture_map_static.test.js`, `tests/pasture_map_p2_map.spec.js`, `tests/pasture_map_placement.spec.js`, `tests/pasture_map_reports_records.spec.js`, `tests/pasture_map_reset_history.spec.js`, `tests/pasture_map_light_access.spec.js`, `tests/pasture_map_setup.spec.js`, `tests/pasture_map_tweaks2.spec.js`, `tests/pasture_map_import.spec.js`, `tests/pasture_map_cp2.spec.js`, `tests/pasture_map_cp3.spec.js`, `tests/pasture_map_cp4.spec.js`, `tests/pasture_map_cp5.spec.js`, `tests/pasture_map_cp6.spec.js`, `tests/pasture_map_cp7.spec.js`, `playwright.pasture.config.js`, `scripts/apply_test_mig_147.cjs`, `scripts/apply_test_mig_148.cjs` |
| Breeding pigs | `tests/static/breeding_pigs_parity_static.test.js` |
| Feed planning | `src/lib/feedPlanner.test.js`, `src/lib/feedOrderBasis.test.js`, `tests/static/feed_order_board_static.test.js` |
| Pig | `src/lib/pig*.test.js`, `src/lib/pigBatchGridMetrics.test.js`, `tests/static/pig_batches_planned_trips_static.test.js`, `tests/static/weighin_session_record_page_static.test.js`, `tests/pig_*.spec.js` |
| Broiler/layer | `src/lib/broiler.test.js`, `tests/static/broiler_hatch_activation_static.test.js`, `tests/static/broiler_batch_record_page_static.test.js`, `tests/static/weighin_session_record_page_static.test.js`, `tests/static/webform_config_boundary_static.test.js`, `src/layer/*.test.js`, `tests/broiler_*.spec.js`, `tests/layer_*.spec.js` |
| Cattle | `tests/static/cattle_*.test.js`, `tests/cattle_*.spec.js`, `src/lib/cattleHerdFilters.test.js` |
| Sheep | `tests/static/sheep_*.test.js`, `tests/sheep_*.spec.js`, `src/lib/sheepFlockFilters.test.js` |
| Daily reports | `tests/static/daily_*.test.js`, `tests/static/cp2_daily_writes_via_rpc_static.test.js`, `tests/daily_*.spec.js` |
| Equipment | `src/lib/equipment.test.js`, `tests/static/equipment_*.test.js`, `tests/equipment_*.spec.js` |
| Export / print | `src/lib/csvExport.test.js`, `src/lib/printExport.test.js` |
| Login/offline webforms | `tests/static/light_user_portal_static.test.js`, `tests/offline_*.spec.js`, `tests/daily_report_photos.spec.js` |
| Storage/media guards | `tests/static/*storage*.test.js`, `tests/static/*photo*.test.js`, `tests/static/image_file_input_capture_static.test.js` |
| Runtime observability | `tests/static/error_resilience_static.test.js`, `tests/static/client_error_boundary_static.test.js`, `tests/static/client_errors_review_static.test.js` |

Playwright notes:

- Specs that reset the shared TEST DB must run one file at a time.
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
  `C:\Users\Ronni\cc-research\`.
- Parity audit evidence:
  `C:\Users\Ronni\cc-research\parity-audit-2026-06-05-CC.md`.
- Detailed build history lives in git log and tests. Keep this file as the
  compact project map, not a running transcript.
