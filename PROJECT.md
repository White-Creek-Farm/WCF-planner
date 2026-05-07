# WCF Planner

**Farm-management web app for White Creek Farm.** Owner + admin: Ronnie Jones. Live at [https://wcfplanner.com](https://wcfplanner.com).

Production serves a React/Vite bundle from branch `main`. The pre-Vite single-file origin and migration history live in Part 3.

`PROJECT.md` is the project-specific source of truth: product goal, stack, architecture, schema, domain rules, design constraints, load-bearing contracts, roadmap, and build history. Reusable workflow SOP, prompt-relay rules, branch/merge approval rules, validation floor, and session-wrap rules live in [`HO.md`](HO.md) and should not be duplicated here. For per-session narrative history, see [`archive/SESSION_LOG.md`](archive/SESSION_LOG.md).

**Last updated:** 2026-05-07. HO.md remains the static start-of-session SOP; PROJECT.md carries project state and roadmap only.

---

## Table of contents

- **Part 1 — Project Reference** — product goal, infrastructure, schema, architecture, domain, design constraints, load-bearing contracts, roadmap
- **Part 2 — Design Decisions** — load-bearing choices with rationale and rejected alternatives
- **Part 3 — History** — migration origin, phase tally, transferable lessons
- **Part 4 — Session Index** — one-line map of every dated session; detail lives in git log + `archive/SESSION_LOG.md`

---

# Part 1 — Project Reference

## 1. Project overview

WCF Planner is White Creek Farm's internal farm-management application. It centralizes livestock planning, daily reports, weigh-ins, feed/fuel workflows, equipment records, public webforms, operational tasking, and reporting surfaces that support farm decisions.

The app is a React/Vite SPA backed by Supabase and deployed through Netlify. It favors practical farm operations over marketing-style UI: dense but readable dashboards, clear tables, direct edit flows, and fast access to the current operational state.

Workflow SOP, agent roles, prompt formats, approval gates, branch/merge rules, and session-wrap rules are intentionally not maintained in this file. Those belong in `HO.md`. This file should stay focused on facts and decisions that are specific to WCF Planner.

### Design constraints

- **No purple-heavy UI.** Keep the product grounded in the existing farm-management palette and program-specific visual language.
- Operational views should be efficient and scannable. Avoid decorative landing-page patterns where the user needs a working tool.
- User-facing flows should preserve existing farm vocabulary unless a lane explicitly renames it.

### Critical codebase constraints (post-migration)

- **Vite build, not Babel-in-browser.** Source is ESM under `src/`. A one-time `wcf-babel-*` localStorage purge runs on every mount — safe to leave in forever.
- **React hooks rules:** never put `useState` / `useEffect` / `useRef` inside conditional blocks. Always at top level of the component function.
- **Hook-based view extractions close over many App-scope names.** Missing one = runtime `ReferenceError` on first nav to that view. Builds pass silently; only the browser catches these. The repo's bare-name audit practice for hook-based extractions is documented in §Part 3 "Lessons".
- **`\u` JSX escape literals stay** (em-dashes, bullets, en-dashes). They're on the don't-touch list — removing them mid-migration is risk-for-nothing.
- **Router is BrowserRouter with a view↔URL adapter.** `setView('X')` and `useNavigate('/path')` both work. Legacy `/#weighins` etc. bookmarks are rewritten to clean paths by a sync shim in `main.jsx` before `root.render()`.

### Deployment facts

- Netlify auto-builds production from GitHub branch `main`.
- Netlify can build previews from feature branches or PR deploy previews.
- Production rebuilds usually settle in about 90 seconds after `main` updates.
- Production: `https://wcfplanner.com` (alias `https://cheerful-narwhal-1e39f5.netlify.app`).
- Preview shape: `<branch>--cheerful-narwhal-1e39f5.netlify.app` when branch deploys are enabled, or `deploy-preview-N--...` via a PR.
- Rollback paths, fastest first: Netlify UI -> Deploys -> "Publish deploy" on a pre-incident build; revert the merge commit and rebuild; restore `~/OneDrive/Desktop/WCF-planner-backups/index.html.pre-vite-2026-04-19` only as a nuclear option.

---

## 2. Infrastructure

### Hosting & domain

| Service | Details |
|---|---|
| Live URL | https://wcfplanner.com |
| Netlify alias | https://cheerful-narwhal-1e39f5.netlify.app |
| Hosting | Netlify (Farm Team account) — auto-deploys from GitHub `main` |
| Repo | https://github.com/byronronniejones-lab/WCF-planner |
| Static routing | `public/_redirects` serves `/equipment*` + `/fueling*` from `equipment.html` before the final `/* /index.html 200` SPA fallback. |

### Supabase

| Item | Value |
|---|---|
| Project URL | https://pzfujbjtayhkdlxiblwe.supabase.co |
| Auth config | `detectSessionInUrl: false`, `storageKey: 'farm-planner-auth'` — see §Part 2 for rationale |
| Anon key location | `src/lib/supabase.js` |
| Admin email | byronronniejones@gmail.com (Ronnie) |
| Edge functions | `rapid-processor` (email/user actions; legacy flat source), `tasks-cron`, `tasks-summary` |
| Storage buckets | `batch-documents`, `equipment-maintenance-docs`, `fuel-bills`, `daily-photos`, `task-photos`, `task-request-photos`, cattle-related file attachments |

### Tech stack

- **React 18** via npm (`react@18.3.1`, `react-dom@18.3.1`).
- **Vite 5** build (`@vitejs/plugin-react`). Dev server on default port 5173.
- **React Router 7** (`react-router-dom@7.14.1`) with `BrowserRouter` + URL↔view adapter (see §Part 2).
- **Supabase JS v2** (`@supabase/supabase-js@2.45.0`).
- **SheetJS/XLSX** (`xlsx@0.18.5`) lazy-loaded via `await import('xlsx')` on first use.
- **Geist** font from Google Fonts.
- No TypeScript, no CSS framework — all styles are inline `style={{…}}` + scoped webform CSS in `index.html`.
- Quality tooling: `format:check` (Prettier), `lint` (ESLint 9 flat config), `vitest`, `build`, and Playwright. CI workflow at `.github/workflows/ci.yml` runs on PRs and pushes to `main`.

### Farm location

Lat `30.84175647927683`, Lon `-86.43686683451689`. West Central Florida. Used by any future weather-API integration and any location-scoped features.

---

## 3. Database schema

### Migration layout

Migrations 001–026 live in `supabase-migrations/archive/`; current parent-path migrations run through `048_equipment_service_materials.sql`. Key anchors: migs 027-029 processing/transfer foundations, migs 030/031 offline queue + daily photos, migs 034/035 Add Feed + weigh-in RPCs, migs 036-046 Tasks v1, migs 043/044 Cattle Forecast + calving automation, mig 045 pg_net timeout bump for task cron, mig 047 equipment fueling RPC/current-reading reconciliation, and mig 048 equipment service-material sidecar tables. Use `rg --files supabase-migrations` for the exact file list.

### Hand-created prod tables (not in any migration)

Nine tables exist in production but were created by hand in the Supabase dashboard (or via Supabase auth templates) before any migration in this repo was written. No `.sql` file creates them. Discovered 2026-04-28 while scaffolding the Playwright test harness — the bootstrap bundle for a fresh test project must seed these explicitly (see `scripts/build_test_bootstrap.js` → `hand_created_tables_seed` block) before any migration that ALTERs them (e.g. mig 008 ALTER profiles, mig 011 UPDATE webform_config) can run.

Affected: `profiles`, `app_store`, `webform_config`, `poultry_dailys`, `layer_dailys`, `egg_dailys`, `pig_dailys`, `layer_batches`, `layer_housings`. Schemas captured from prod via `information_schema.columns`. If any of these schemas drift on prod, the bootstrap bundle stays stale until regenerated against the new shape.

### Tables

| Table | Purpose |
|---|---|
| `app_store` | Main JSON blob store — all non-daily structured data. Key-value: `key` (text PK), `data` (jsonb). |
| `webform_config` | Config for public webforms (anon-accessible RLS). Same key-value shape as `app_store`. |
| `poultry_dailys` | Broiler daily reports. Has nullable `source` column. |
| `layer_dailys` | Layer daily reports. Has nullable `source` column. |
| `egg_dailys` | Egg collection reports. |
| `pig_dailys` | Pig daily reports. Has nullable `source` column. **No `feed_type` column** — pig reports don't track feed type. |
| `cattle_dailys` | Cattle daily reports. `feeds` jsonb (multi-line with `is_creep` per-line flag + `nutrition_snapshot` at submit time), `minerals` jsonb, + standard fields. |
| `sheep_dailys` | Sheep daily reports. Sheep-specific fields (bales of hay, alfalfa lbs, minerals given/% eaten). |
| `layer_batches` | Layer batch parent records (dedicated table). |
| `layer_housings` | Per-housing records with `current_count` anchor model. |
| `cattle`, `cattle_calving_records`, `cattle_processing_batches`, `cattle_feed_inputs`, `cattle_feed_tests`, `cattle_comments` | Cattle module. `cattle_comments` uses a `source` column for multi-origin timeline (`manual`/`weigh_in`/`daily_report`/`calving`). `cattle.old_tags` is jsonb — don't change its shape. Mig 043 simplified real `cattle_processing_batches.status` to `active|complete`; "planned" is now a computed Forecast/Batches UI concept, not a stored DB status. |
| `cattle_forecast_settings`, `cattle_forecast_heifer_includes`, `cattle_forecast_hidden` | Cattle Forecast v1 persistence from mig 043 (source `d2eccda`; PROD + TEST applied 2026-05-04). Settings singleton controls target/display weights, fallback ADG, horizon, capacity, and included herds. Heifer includes stores explicit momma-heifer finish candidates. Hidden stores per-cow/per-month hides. |
| `sheep`, `sheep_lambing_records` | Sheep module. |
| `weigh_in_sessions` + `weigh_ins` | Shared across cattle/pig/broiler/sheep via `species` column. |
| `profiles` | User profiles + roles (`farm_team`, `management`, `admin`, `inactive`). Per-program access via `program_access` text array. |
| `equipment`, `equipment_fuelings`, `equipment_maintenance_events` | Equipment module. Migration 016 + extensions through 025, plus mig 047's `submit_equipment_fueling` RPC for public fueling submissions. `equipment.team_members`/`manuals`/`documents`/`attachment_checklists` are jsonb. `equipment_fuelings.photos` is jsonb (`[{name,path,url,uploadedAt,podio_file_id?}]`). `service_intervals_completed` is jsonb (`[{interval,kind,items_completed,total_tasks,attachment_name?,...}]`). |
| `equipment_service_materials`, `equipment_material_clears` | Equipment rolling materials checklist sidecar tables from mig 048. Authenticated-only RLS. Materials are grouped by equipment -> service/attachment interval -> material; clears are keyed by material + due bucket so one material can be hidden until the next rolling service cycle. |
| `fuel_supplies` | Fuel **delivered** to the farm (cell / can / farm truck / other). Anon insert via `/equipment/supply` webform (legacy `/fueling/supply` alias retained). NEVER counts as consumption — that's `equipment_fuelings.gallons`. |
| `fuel_bills`, `fuel_bill_lines` | Migration 026. Admin-uploaded supplier invoices (Home Oil etc.) for monthly reconciliation against `fuel_supplies`. Authenticated-only RLS. PDFs in the admin-only `fuel-bills` storage bucket (signed-URL access only). |
| `task_templates`, `task_instances`, `task_cron_runs`, `task_summary_runs` | Tasks Module v1 C1-C4 shipped through mig 046. Migs 036-038 created templates/instances/RLS/private completion-photo bucket; mig 039 installed daily task generation + `tasks-cron`; mig 040 added `complete_task_instance`; migs 041/042 added public Tasks submit + request photos; mig 045 bumped pg_net timeout; mig 046 added weekly summaries + `task_summary_runs` + `tasks-summary`. Templates are admin-only. Instances are admin-all plus assignee SELECT-own; assignees complete through SECDEF RPC, not direct UPDATE. Cron/summary audit rows are admin SELECT only and service-role append-only. No required-photo behavior exists anywhere in Tasks v1. |
| `batch-documents` | Storage bucket for broiler batch file attachments. |
| `equipment-maintenance-docs` | Storage bucket for equipment manuals + documents + fueling photos. Public bucket (anon read), authenticated/anon write per the policies in migrations 016 + 018. |
| `fuel-bills` | Storage bucket for uploaded supplier invoices. `public:false` — authenticated-only via 10-min signed URLs from the admin Bills view. |
| `task-photos` | Private bucket from mig 038 for optional completion photos. Path: `task-photos/<assignee_uid>/<instance_id>/<filename>` in DB, `<assignee_uid>/<instance_id>/<filename>` in Storage upload calls. Append-only policy: uploads use `upsert:false`; duplicate object errors are treated as retry success. Reads via signed URLs only. |
| `task-request-photos` | Private bucket from mig 042 for optional public/admin task request photos. Path: `task-request-photos/<one_time_instance_id>/<filename>`. Append-only policy with the same duplicate-as-success retry contract. Reads via signed URLs only. |

### `app_store` keys

| Key | Contents |
|---|---|
| `ppp-v4` | Broiler batches array |
| `ppp-layer-groups-v1` | Legacy layer groups (superseded by `layer_batches`/`layer_housings`, still used for some webform config) |
| `ppp-webforms-v1` | Webform configuration (includes Add Feed + Cattle Dailys entries) |
| `ppp-feeders-v1` | Pig feeder groups with sub-batches and processing trips |
| `ppp-pigs-v1` | Pig sow/boar count data |
| `ppp-breeding-v1` | Pig breeding cycle records |
| `ppp-farrowing-v1` | Farrowing records (initialized from `INITIAL_FARROWING` constant in `main.jsx`) |
| `ppp-breeders-v1` | Pig breeding registry (initialized from `INITIAL_BREEDERS`) |
| `ppp-boars-v1` | Boar names mapping |
| `ppp-breed-options-v1`, `ppp-origin-options-v1` | Dropdown option lists |
| `ppp-feed-costs-v1` | `{starter, grower, layer, pig, grit}` per-lb rates |
| `ppp-feed-orders-v1` | Feed orders by month by type |
| `ppp-pig-feed-inventory-v1` | Pig physical feed count: `{count, date}` or null |
| `ppp-poultry-feed-inventory-v1` | Poultry physical counts: `{starter:{count,date}, grower:{count,date}, layer:{count,date}}` |
| `ppp-broiler-notes-v1`, `ppp-pig-notes-v1`, `ppp-layer-notes-v1` | Per-section notes |
| `ppp-missed-cleared-v1` | Cleared missed-report alerts (Set serialized as array) |
| `ppp-archived-sows-v1` | Archived sow records |

### `webform_config` keys

| Key | Contents |
|---|---|
| `full_config` | Complete config — `{webforms, teamMembers, broilerGroups, layerGroups}` |
| `broiler_groups` | Active broiler batch names (string array) |
| `broiler_batch_meta` | Active broiler batch metadata for public WeighIns schooner labels. Canonical public source; never read `app_store.ppp-v4` from the public broiler form. |
| `active_groups` | Active pig group names (string array) |
| `team_roster` | Canonical team roster: `[{id, name}]`. Sole writer is the central Webforms admin roster editor. |
| `team_members` | Legacy all-names mirror (`string[]`) kept for old readers. Written atomically by the roster helper, not by public forms. |
| `team_availability` | Per-public-form hidden roster IDs. Empty/missing means every roster member is visible for that form. |
| `tasks_public_assignee_availability` | Public Tasks assignee availability. Shape: `{hiddenProfileIds:[profile_uuid,...]}`. Separate from roster availability because task assignees are `profiles.id`, not team-roster IDs. |
| `per_form_team_members` | _Retired 2026-04-29._ Per-form filtering eliminated; existing rows preserved (no destructive op) but no longer read or written. See §7 `team_roster` entry. |
| `webform_settings` | `{allowAddGroup: {"pig-dailys": true, …}}` |
| `housing_batch_map` | `{housingName: batchName}` — maps housing to batch NAME (not id) |
| `layer_groups` | Active layer group names |

---

## 4. Application architecture

### File tree (current high-level layout)

```
WCF-planner/
├─ index.html                 # default app HTML; manifest start_url=/dailys
├─ equipment.html             # equipment app-install HTML; manifest start_url=/equipment
├─ vite.config.js
├─ package.json
├─ public/
│  └─ _redirects              # equipment HTML rules, then SPA fallback
├─ src/
│  ├─ main.jsx                # ~1,750 lines — provider tree + App wiring + view dispatch
│  ├─ contexts/               # 10 feature-scoped providers (see §4.3)
│  ├─ lib/                    # helper modules (see §4.4)
│  ├─ shared/                 # Header, DeleteModal, WcfYN, WcfToggle, AdminAddReportModal, AdminNewWeighInModal
│  ├─ auth/                   # SetPasswordScreen, LoginScreen, UsersModal, MyTasksView
│  ├─ webforms/               # AddFeedWebform, WeighInsWebform, TasksWebform, WebformHub, WebformsAdminView, PigDailysWebform
│  ├─ admin/                  # AdminTasksView, FeedCostsPanel, FeedCostByMonthPanel, LivestockFeedInputsPanel, NutritionTargetsPanel, Fuel Log admin views
│  ├─ dashboard/              # HomeDashboard
│  ├─ broiler/                # BatchForm, BroilerHomeView, BroilerTimelineView, BroilerListView, BroilerFeedView, BroilerDailysView
│  ├─ layer/                  # LayersHomeView, LayersView, LayerBatchesView, LayerDailysView, EggDailysView
│  ├─ pig/                    # PigsHomeView, BreedingView, FarrowingView, SowsView, PigBatchesView, PigFeedView, PigDailysView
│  ├─ cattle/                 # CattleHomeView, CattleHerdsView, CattleBreedingView, CattleBatchesView, CattleDailysView, CattleWeighInsView, CattleBulkImport, CattleNewWeighInModal, CowDetail, CollapsibleOutcomeSections
│  ├─ sheep/                  # SheepHomeView, SheepFlocksView, SheepDailysView, SheepWeighInsView, SheepBulkImport, SheepDetail
│  ├─ livestock/              # LivestockWeighInsView (broiler+pig shared), PigSendToTripModal
│  └─ equipment/              # EquipmentHome, fleet/detail/fuel-log/materials views, maintenance modal, add modal, ManualsCard
├─ archive/
│  └─ SESSION_LOG.md          # Frozen raw session narratives (pre-consolidation)
├─ supabase-migrations/       # SQL migrations
├─ supabase/functions/        # Canonical Supabase Edge Functions: tasks-cron, tasks-summary
├─ supabase-functions/        # Legacy flat rapid-processor source; stage temporarily under supabase/functions/rapid-processor/ for deploy
├─ scripts/                   # CLI Node import scripts (Podio importers, merge tools) — NOT bundled
└─ PROJECT.md                 # this file
```

### `src/main.jsx` structure

~1,750 lines. Pure wiring + dispatch. Shape:

1. **Imports** (~160 lines) — React, router, all contexts, all feature views, all libs.
2. **Module-scope startup:**
   - One-time `wcf-babel-*` localStorage purge.
   - Legacy hash-bookmark compat shim (runs synchronously before `root.render()`).
   - Lazy XLSX loader (`window._wcfLoadXLSX`).
3. **Module-scope constants still used by App:** `STORAGE_KEY`, `INITIAL_BREEDERS`, `INITIAL_FARROWING`, `EMPTY_FORM`, `EMPTY_DAILY`, `canEdit*/canDelete*` permission helpers. Cattle constants + `detectConflicts` + `writeBroilerBatchAvg` moved to `src/lib/` during the 2026-04-21 polish.
4. **`function App()` body:**
   - Destructures from 10 contexts (`useAuth`, `useBatches`, `usePig`, `useLayer`, `useDailysRecent`, `useCattleHome`, `useSheepHome`, `useWebformsConfig`, `useFeedCosts`, `useUI`).
   - Derived role helpers + 2 Phase 3 URL↔view sync effects.
   - ~40 `useState` hooks for view-local state (feed orders, expanded months, collapsed flags, `wf*` admin form state, auto-save timer refs, daily form state, etc.).
   - Effects: webform config load, cattle count, initial dailys loads, `refreshDailys`, `VALID_VIEWS` gate, `canAccessProgram` redirect, auth listener with 6s timeout, visibility refresh.
   - Data helpers: `loadUser`, `loadAllData` (loads 19 `app_store` keys + paginated pig/poultry dailys), `loadUsers`, `saveFeedCosts`, `sbSave` (with 3-attempt retry), `signOut`, 9 `persist*` helpers, `syncWebformConfig`, `persistDaily`/`deleteDaily`, `backupData`/`restoreData`.
   - Form helpers: `upd`, `openAdd`, `openEdit`, `parseProcessorXlsx`, `confirmDelete`, `closeForm`, `submit`, `del`, `resolveSire`.
   - `Header` wrapper closure (threads App-only props into extracted `HeaderBase`).
   - `DeleteConfirmModal` memo.
   - Webform bypass routes (public, no auth): `addfeed`, `weighins`, `webformhub`, `webform`.
   - Auth gates: `pwRecovery` / `null` / `false` / `!dataLoaded`.
   - View dispatch table (one `if(view==="X") return React.createElement(…)` per view).
   - `return null` default.
5. **`const root = createRoot(…)` + `root.render(<BrowserRouter>…<App/>…</BrowserRouter>)`.** The provider stack wraps App with all 10 contexts.
6. **Boot loader fade-out** via two nested `requestAnimationFrame`s after first paint.

### Provider tree (order matters — some consumers sit inside others)

```
<BrowserRouter>
  <AuthProvider>
    <BatchesProvider formInit={EMPTY_FORM}>
      <PigProvider initialFarrowing={INITIAL_FARROWING} initialBreeders={INITIAL_BREEDERS} breedTlStartInit={…}>
        <LayerProvider>
          <DailysRecentProvider>
            <CattleHomeProvider>
              <SheepHomeProvider>
                <WebformsConfigProvider configInit={DEFAULT_WEBFORMS_CONFIG}>
                  <FeedCostsProvider>
                    <UIProvider>
                      <App/>
```

### Helper libs (`src/lib/`)

`src/lib/` is the live source of truth; run `rg --files src/lib` for the complete list. High-signal helpers:

| Module | Exports |
|---|---|
| `supabase.js` | `sb` (the Supabase client, `detectSessionInUrl:false` + `storageKey:'farm-planner-auth'`) |
| `email.js` | `wcfSendEmail(type, data)` — fire-and-forget edge-function call |
| `pagination.js` | `wcfSelectAll(buildRangeQuery, pageSize)` — the `.range(from, from+999)` loop pattern (don't touch — see §7) |
| `dateUtils.js` | `addDays`, `toISO`, `fmt`, `fmtS`, `todayISO` |
| `styles.js` | `S` — shared style constants |
| `defaults.js` | `DEFAULT_WEBFORMS_CONFIG` |
| `layerHousing.js` | `setHousingAnchorFromReport`, `computeProjectedCount`, `computeLayerFeedCost` |
| `cattleCache.js` | `loadCattleWeighInsCached`, `invalidateCattleWeighInsCache` — two-query pattern, no `!inner` joins (don't touch — see §7) |
| `cattleBreeding.js` | `calcCattleBreedingTimeline`, `buildCattleCycleSeqMap`, `cattleCycleLabel` |
| `pig.js` | Pig breeding constants (`BOAR_EXPOSURE_DAYS=45`, `GESTATION_DAYS=116`, `WEANING_DAYS=42`, `GROW_OUT_DAYS=183`) + `calcBreedingTimeline`, `buildCycleSeqMap`, `cycleLabel`, `calcCycleStatus` |
| `broiler.js` | ~450 lines. Full broiler + layer housing domain: constants (`BROODER_DAYS`, `CC_SCHOONER`, `WR_SCHOONER`, `BROODERS`, `SCHOONERS`, cleanout windows, hatchery lists, breed/status styles), + `overlaps`, `getFeedSchedule`, `calcBatchFeed`, `calcBatchFeedForMonth`, `calcLayerFeedForMonth`, `calcTimeline`, `calcPoultryStatus`, `calcBroilerStatsFromDailys`, `getBatchColor`, `breedLabel`, `isNearHoliday`, `calcTargetHatch`, `suggestHatchDates`, `writeBroilerBatchAvg` |
| `cattle.js` | Cattle module constants: 4 active herds + 3 outcomes + labels + colors + 5 breeding-day constants |
| `conflicts.js` | `detectConflicts` — broiler/layer scheduling overlap detector |
| `tasks.js` | Pure Tasks constants/helpers: recurrence labels, photo bucket/path helpers, duplicate-storage-error classifier. No Supabase side effects. |
| `tasksAdminApi.js`, `tasksPublicApi.js`, `tasksUserApi.js` | Side-effect wrappers for admin Tasks Center, public `/dailys/tasks`, and logged-in `/my-tasks` surfaces. |
| `tasksRecurrence.js` | Shared recurrence math mirrored by the `tasks-cron` Edge Function helper and parity-locked by static tests. |
| `equipment.js` | Equipment category metadata + service interval math (`computeIntervalStatus`, `latestSaneReading`, milestone snap helpers). |
| `equipmentMaterials.js` | Rolling materials aggregation, due-window math, clear-bucket identity, and attachment-scoped completion handling. |
| `clientSubmissionId.js` | Stable client-side IDs for webform/RPC idempotency. |
| `teamMembers.js`, `teamAvailability.js` | Canonical roster read/write helpers and per-form availability filtering. |
| `broilerBatchMeta.js` | Public broiler weigh-in mirror helpers; keeps public form off `app_store.ppp-v4`. |
| `offlineForms.js`, `offlineRpcForms.js` | Offline queue registries for direct-insert and RPC-mediated public forms. |
| `useOfflineSubmit.js`, `useOfflineRpcSubmit.js` | Offline queue hooks mounted by public webform surfaces. |
| `dailyPhotos.js`, `photoCompress.js` | Daily-report photo path/compression helpers. |
| `fuelBillParser.js` | Fuel bill PDF text parser and tax-included vs tax-exclusive allocation logic. |
| `routes.js` | `VIEW_TO_PATH`, `PATH_TO_VIEW`, `HASH_COMPAT` — Phase 3 URL↔view maps |

### URL routing (Phase 3 adapter pattern)

Two `useEffect`s inside App keep URL and `view` state mirrored:

- **URL → view** on `location.pathname` change: resolve via `PATH_TO_VIEW`; if unknown path, snap to `home` + `navigate({pathname:'/', hash: location.hash}, {replace:true})` (preserving hash protects the password-recovery flow).
- **view → URL** on `view` change: `navigate(VIEW_TO_PATH[view])`. A `syncingFromUrl` ref prevents infinite loops.

Every existing `setView('X')` call site continues to work unchanged. See §Part 2 for the adapter-vs-full-migration rationale.

### URL shape

| Path | View | Access |
|---|---|---|
| `/` | home dashboard | auth |
| `/broiler`, `/broiler/timeline`, `/broiler/batches`, `/broiler/feed`, `/broiler/dailys`, `/broiler/weighins` | broiler program | auth |
| `/pig`, `/pig/breeding`, `/pig/farrowing`, `/pig/sows`, `/pig/batches`, `/pig/feed`, `/pig/dailys`, `/pig/weighins` | pig program | auth |
| `/layer`, `/layer/groups`, `/layer/batches`, `/layer/dailys`, `/layer/eggs` | layer program | auth |
| `/cattle`, `/cattle/herds`, `/cattle/forecast`, `/cattle/breeding`, `/cattle/batches`, `/cattle/dailys`, `/cattle/weighins` | cattle program | auth |
| `/sheep`, `/sheep/flocks`, `/sheep/batches`, `/sheep/dailys`, `/sheep/weighins` | sheep program | auth |
| `/fleet`, `/fleet/<slug>`, `/fleet/fuel-log`, `/fleet/materials` | logged-in equipment module (Fleet view + per-piece detail + Fuel Log + rolling Materials Checklist) | auth |
| `/admin`, `/admin/tasks` | webforms/feed/fuel admin + Tasks Center | admin only |
| `/my-tasks` | logged-in assignee task list + completion flow | auth |
| `/dailys`, `/dailys/<form>`, `/dailys/tasks`, `/addfeed`, `/weighins`, `/equipment`, `/equipment/<slug>`, `/equipment/supply`, `/fuel-supply` | public webforms | **no auth** |

**2026-05-06 public-URL rename.** Daily-reports hub canonical moved from `/webforms` to `/dailys`. Equipment/fueling hub canonical moved from `/fueling` to `/equipment`. Internal logged-in Equipment module moved from `/equipment` to `/fleet`. Legacy aliases retained:
- `/webforms*` → `/dailys*`
- `/fueling*` → `/equipment*`
- `/equipment/fleet` → `/fleet`
- `/equipment/fuel-log` → `/fleet/fuel-log`

`/equipment/<slug>` is **NOT** an internal alias anymore — it is the canonical public per-piece equipment-checklist URL. Operators with old logged-in `/equipment/<slug>` bookmarks land on the public checklist; admins reach the logged-in detail at `/fleet/<slug>`. Aliases are wired in `src/lib/routes.js` (`ALIASES_EXACT` + `ALIASES_PREFIX`) and resolved by `main.jsx`'s URL-sync effect via `navigate({replace: true})`. `/addfeed`, `/weighins`, `/fuel-supply` stay byte-stable as primary paths.

Legacy `/#weighins`, `/#addfeed`, `/#webforms` hash bookmarks are rewritten to clean canonical paths (`/weighins`, `/addfeed`, `/dailys`) by the module-scope hash shim before React renders. Recovery hashes (`/#access_token=…&type=recovery`) are deliberately left intact — `SetPasswordScreen` parses them directly.

Unknown paths snap to home.

### Key people

| Person | Role | Email |
|---|---|---|
| Byron (Ronnie) Jones | Admin / Owner | byronronniejones@gmail.com |
| Mak | Management | mak@whitecreek.farm |
| Simon | Farm Team | Simon.rosa3@gmail.com |
| Josh | Farm Team | — |
| Jenny | Farm Team | — |
| BMAN | Team member (shows in webform team pickers) | — |
| BRIAN | Team member | — |
| RONNIE | Team member (legacy display alias) | — |

---

## 5. Domain reference

### 5.1 Feed system (pig & poultry)

**Data model.** Orders in `ppp-feed-orders-v1`: `{pig:{…}, starter:{…}, grower:{…}, layerfeed:{…}}`, each an ISO-month map (e.g. `"2025-10"` → lbs). Physical counts in `ppp-pig-feed-inventory-v1` and `ppp-poultry-feed-inventory-v1`.

**Order timing model.** Orders arrive at the END of the month. So:
- Mid-month, the current month's order has NOT arrived yet.
- "Actual On Hand" = orders from past months only, minus consumption since tracking started.
- "End of Month Estimate" = all orders through current month (including the arriving one) minus all consumption (actual + projected remaining days).
- "Suggested Order" for next month = next month's projected consumption − end-of-month estimate.

**Tracking start.** First month with any order entered across any feed type for that program. Consumption before that is ignored. For poultry, tracking starts for ALL three feed types when the first order in ANY type is entered.

**Monthly tile ledger (forward pass):**
```
START OF MONTH = previous month's END  (or 0 for first tracking month)
CONSUMED       = actual (past months) | actual + projected remaining (current) | projected (future)
ORDERED        = entered amount (arrives end of month)
END OF MONTH   = START - CONSUMED + ORDERED
```

**Physical count.** When entered, becomes the new anchor for all calculations forward. Shows adjustment badge: "Count adj +/- X". Only the latest count is stored — no history.

**Pig feed tab** (`/pig/feed`): 4 stat tiles + 3 projection cards + physical count input + monthly tiles with per-group breakdown.

Projection rates:
- Sows (non-nursing): 5 lbs/day
- Nursing sows: 12 lbs/day (computed from farrowing records + breeding timelines)
- Boars: 5 lbs/day
- Feeder pigs: 1 lb/day per month of age

**Poultry feed tab** (`/broiler/feed`): compact table (one row per feed type) + physical count + monthly tiles per feed type + collapsible batch-level feed estimates below. **No daily variance for poultry** — bulk feeding creates huge daily swings that don't normalize until month end.

### 5.2 Broiler batch system

- Batches in `ppp-v4`. Auto-status: planned before hatch, active on/after hatch, processed after processing. Hatch-date activation shipped in `fd12e6a` and is locked by `tests/static/broiler_hatch_activation_static.test.js`.
- B-24-* batches use legacy manual feed fields. B-25+ batches pull totals from `poultry_dailys`.
- Processing data: birds to processor, avg dressed weight, avg breast/thigh, whole/cuts lbs. Excel processor reports auto-parse via SheetJS.
- Document attachments via the `batch-documents` Supabase Storage bucket.
- 24-color palette assigned by trailing batch number for visual distinction.
- Schedule conflicts detected by `detectConflicts` in `src/lib/conflicts.js`: hard conflicts for broiler-vs-broiler brooder/schooner overlap (with cleanout windows), soft conflicts for broiler-vs-layer.
- Week 4 + Week 6 weigh-in averages written back to the batch by `writeBroilerBatchAvg` in `src/lib/broiler.js` on session completion.

### 5.3 Layer housing model

- `layer_batches` — batch-level (name, original_count, feed cost rates, lifecycle dates).
- `layer_housings` — per-housing (housing_name, batch_id, `current_count` anchor, start_date).
- `current_count` is a verified anchor from physical counts. Projected count = anchor − mortalities since anchor date.
- "Retirement Home" is a permanent pseudo-batch that never closes. Edit modal hides lifecycle fields.
- Helpers: `setHousingAnchorFromReport`, `computeProjectedCount`, `computeLayerFeedCost` in `src/lib/layerHousing.js`.

### 5.4 Pig breeding system

- Breeding cycles: Boar Exposure → Paddock → Farrowing → Weaning → Grow-out.
- Constants (`src/lib/pig.js`): 45-day exposure, 116-day gestation, 42-day weaning, 183-day grow-out.
- Farrowing records linked to cycles by date window + sow tag → boar-tag lists (`boar1Tags`, `boar2Tags`); `resolveSire` in main.jsx does the lookup.
- Feeder groups with sub-batches and processing trips.
- Breeding pig registry (`INITIAL_BREEDERS` seed has 24 Podio-imported pigs; `INITIAL_FARROWING` has 13 historical records).

**Breeding cycle modal (`BreedingView.jsx`) — major operational refactor 2026-04-22**:
- Sow assignments are **chip-based**, not free-text textareas. Each boar has a chip row + `+ Add sow from Group N` dropdown filtered to that group.
- **Auto-pull from breeders**: when a cycle is unstarted, opening the modal merges any group sows not yet in either boar's list into Boar 1. `mergeSowsIntoB1(group, b1, b2, excluded)` skips `cycle.excludedSows[]` so removed sows don't keep coming back.
- **2-week grace period**: `isCycleLocked(exposureStart)` returns true 14 days after the cycle starts; chip × delete + auto-pull stop firing once locked. Banner switches to "Cycle locked".
- **Custom batch number**: optional `cycle.customSuffix` overrides the auto `YY-NN`. Used by `cycleLabel()` and the gantt bar label.
- **Color palette = blue family**: `PIG_GROUP_COLORS` per group has base + lighter (gilts) + darker (boars) shades. Group 1 sky `#0EA5E9`, Group 2 core blue `#2563EB`, Group 3 slate `#475569`.

**Transfer-to-Breeding flow (admin weigh-ins → breeders registry)** — rewritten 2026-04-27:
- `LivestockWeighInsView.jsx` → per-row **→ Breeding** button on pig sessions opens a modal: New tag, Group, Sex, Birth date (auto session date − 6 mo). No feed input — auto-computed.
- `feedAllocationLbs = pig.weight × FCR`. FCR resolves via `parent.fcrCached` (now populated by `computePigBatchFCR` in `src/lib/pig.js` on every trip add/edit/delete) → industry default `3.5` when no valid trips yet.
- On confirm: inserts breeders entry (`transferredFromBatch: {batchName, subBatchName, transferDate, feedAllocationLbs, fcrUsed, sourceWeighInId}`) and accumulates `parent.feedAllocatedToTransfers`. **Started counts (giltCount/boarCount/originalPigCount on parent + sub) are NOT mutated** — they record what entered the batch. Transfer events live in the breeders[] audit log; "current" pig count is derived ledger-style on display.
- **Dup guard**: pre-insert check skips when an existing breeder already references the same `sourceWeighInId`.
- **Migration 014** adds `weigh_ins.transferred_to_breeding`, `transfer_breeder_id`, `feed_allocation_lbs` columns. Pre-migration fallback writes `[transferred_to_breeding breeder=ID feed_alloc=N lb] <note>` marker into `weigh_ins.note`.
- **Undo Transfer**: drops breeder by `transfer_breeder_id` (or note marker), reverses `feedAllocatedToTransfers`, clears weigh-in stamp + strips note marker. Started counts stay untouched (symmetric with attach).
- **Breeding pig tile** (`SowsView.jsx`): transferred sows show banner `This gilt was saved from <subBatch> on <date>.` (word adapts: gilt/sow/boar).

**Pig batch accounting model (rewritten 2026-04-27, see commit `3fab65d` and predecessors)**:
- **Started counts** are authoritative. Sub-batches are **partitions** of their parent — sum of subs.giltCount === parent.giltCount and same for boars. Sub-batches are single-sex (Add Sub-batch modal has Gilts/Boars selector + single count). Edit Sub-batch is rename-only; counts read-only. Parent batch modal has a "Distribute across sub-batches" section with sex-specific sum-vs-parent validation.
- **Current = ledger-derived**: `started − Σ(trip pigs attributed via subAttributions) − Σ(transfers from breeders[]) − Σ(mortality)`. Status='processed' override forces 0. Diagnostic chip when latest daily count diverges from ledger by >2.
- **Adjusted feed = raw feed − transfer credits**, where credits are sourced per-sub from `breeders[].transferredFromBatch.subBatchName + feedAllocationLbs` (not the parent-aggregate `feedAllocatedToTransfers`). Sum-of-subs reconciles to parent within rounding.
- **Lbs/pig denominator = finishers (started − transferred − mortality)**, NOT started. Numerator is adjusted feed. Mixing the two frames produced the 1644 vs 1186 lbs/pig bug on P-26-01A.
- **Trips originate from weigh-ins via Send-to-Trip only.** "+ Add Trip" was removed from PigBatchesView. Each trip carries `subAttributions: [{subId, subBatchName, sex, count}]` so the ledger can attribute trip pigs to specific subs.
- **First-load reconcile** in `reconcileFeederGroupsFromBreeders` (`src/lib/pig.js`) enforces only the deterministic invariant `sub.originalPigCount === sub.giltCount + sub.boarCount` when sex sums already match parent. Mismatches are skipped with a console warning — admin resolves via the partition UI (no silent redistribute).
- **Recompute scope** (intentional limit): FCR cache refreshes only on trip add/edit/delete. Daily-feed and transfer-credit changes don't refresh the cache mid-cycle; the ratio updates organically on the next trip write. Acceptable per the scoped roadmap item.

**Pig batch tile (`PigBatchesView.jsx`)**:
- **Per-sub Mark Processed / Reactivate** buttons. Processed subs force `currentCount=0` and drop out of the public webform group dropdown via `syncWebformConfig`.
- **Mortality entry**: + Mortality button on each batch tile opens a modal (Sub-batch picker, Count, Comment). Stored on `feederGroup.pigMortalities[]` with auto date + admin email. Expandable list per tile shows history with delete.
- **Breeding-transfer note**: purple banner `→ Breeding: N pigs out of <sub> sent to breeding pigs group`. Live-derived from `breeders.transferredFromBatch.batchName`.
- **Feed → Breeding stat tile**: shows `−N lbs` when `feedAllocatedToTransfers > 0`. Total Feed tile hint reads `raw X − Y transferred out`.
- **Carcass yield %** only counts trips with `hangingWeight > 0`. Trips waiting on processor data don't drag the % down.
- **Editable `feedAllocatedToTransfers`** in Edit Batch modal (set to 0 to clear stale state from outside-the-undo-flow cleanup).
- **Trip source attribution**: each processing trip shows `From: P-26-01A (GILTS) (2), P-26-01B (BOARS) (2)` derived from `weigh_ins.sent_to_trip_id` join with sessions. Edit Trip modal includes a green "Sources:" block.

**Pig timeline gantt (`BreedingView.jsx`)**:
- 2x zoom (week-cell width `40px`, was `80px`) so ~8 months fit in the viewport.
- `borderRadius:8` on bars (also broiler).
- Bar labels honor `customSuffix` (`G3 · 26-01 — Sows in with Boars`).
- Newest cycle cards on top below the chart.

**Public weigh-ins (`WeighInsWebform.jsx`)**:
- Per-species team-member lists (admin panel has a Weigh-Ins tile with 4 boxes for Cattle / Sheep / Pig / Broiler). Falls back to global team list if a species' list is empty.
- Pig flow is **per-entry** (no 2x15 grid): Weight + Note + Save. Entry list shows ascending (#1 at top).
- Cattle flow modes renamed: `↻ Swap Tag` (was Retag) + `+ Missing Tag` (was Replacement Tag). Internal mode IDs (`'retag'` / `'replacement'`) and `old_tags.source` values (`'weigh_in'`) unchanged for historical resolution.
- Swap Tag button gated until a cow is picked in the dropdown; auto-populates the Prior tag field.
- Cattle/sheep entries show age + prior weight + ADG.
- Resume-session bug fixed: `cattleHerd` / `sheepFlock` now restored from session row.

**Per-pig weight history on breeding pigs (`SowsView.jsx`)**:
- Each tile has `+ Record` weight input below the stats. New entries append to `breeder.weighins: [{weight, date}]` and update `lastWeight`. Tile shows compact history row (latest 6) + `+N more` overflow.

### 5.5 Cattle module

- 4 active herds + 3 outcomes (see `src/lib/cattle.js`):
  - Active: `mommas`, `backgrounders`, `finishers`, `bulls`
  - Outcomes: `processed`, `deceased`, `sold`
- Palette: red family (no purple — Bulls is wine/deep red, outcomes are neutral).
- Breeding timeline constants: `BULL_EXPOSURE_DAYS=65`, `PREG_CHECK_OFFSET=30`, `GESTATION=274`, `CALVING_WINDOW=65`, `NURSING=213`. See `src/lib/cattleBreeding.js`.
- Per-head cost rollup (feed + processing) was deferred from the original module build.
- Podio data imported April 16–17, 2026: 469 cattle, 1,930 weigh-ins, 1,525 daily reports. The planner has been the source of truth for cattle dailys + weigh-ins since 2026-04-17 — no further Podio cattle import planned.
- All cattle data lives in dedicated tables (`cattle`, `cattle_dailys`, `cattle_feed_inputs`, `cattle_calving_records`, `cattle_processing_batches`, `cattle_feed_tests`, `cattle_comments`) — NOT `app_store`. See §Part 2 Decision 5.
- **Processing batch flow (rewritten 2026-04-27):** admin creates an empty batch shell on `/cattle/batches`; cattle enter and leave a batch ONLY via the `send_to_processor` flag on a finishers weigh-in entry. No manual cow attach in the batch view (multi-select + "+ Add cow from finishers" dropdown removed). Clearing the flag, deleting the entry, deleting the session, or deleting the batch all detach attached cows and revert their herd via the `weigh_ins.prior_herd_or_flock` → `cattle_transfers` audit fallback hierarchy. Detach blocks with admin warning if no prior herd is recorded (no silent default). See §7 + `src/lib/cattleProcessingBatch.js`.
- DNA test PDF parser: manual entry is the workaround for v1.

### 5.6 Sheep module

- Parallel structure to cattle but with sheep terminology (flock / ewe / ram / wether / lambing).
- 3 active flocks + 3 outcomes: Active `rams`, `ewes`, `feeders`; Outcomes `processed`, `deceased`, `sold`.
- Phase 1 UI shipped April 18: directory, flat/tile modes, add/edit/delete/transfer, inline detail, bulk import, dailys + weigh-ins. No nutrition targets (Phase 2).
- **Podio data imported 2026-04-21:** 67 Podio sheep + 18 newly-purchased lambs (Willie Nisewonger, $275/each, KATAHDIN, DOB 2026-01-01, tags `RAM 001`–`RAM 008` + `EWE 001`–`EWE 010`, all in `ewes` flock pending weigh-in retag). Also 26 synthesized lambing records, 6 historical weigh-in sessions (34 weigh-ins), and 639 `sheep_dailys` (3 null-date rows skipped). The planner is now the sole source of truth for sheep — no further Podio sheep import planned.
- Migration 009 (sheep schema) had been drafted pre-import but was never applied to Supabase until 2026-04-21. Migration 010 extended `weigh_in_sessions.species` CHECK to include `'sheep'` (mig 009 originally assumed the CHECK already allowed it). Both applied that day.
- Sheep-specific daily fields: bales of hay, alfalfa lbs, minerals given + % eaten, fence voltage kV, waterers working.
- **Processing batch flow (added 2026-04-27, mirrors cattle):** `/sheep/batches` view + `+ New Batch` empty shell + per-row × detach + Delete-batch loop with revert. Migrations 028 (`sheep_processing_batches`) + 029 (`sheep_transfers` append-only audit) installed in the same session. `src/lib/sheepProcessingBatch.js` mirrors the cattle helpers; `SheepSendToProcessorModal` triggers from session-complete on `/sheep/weighins` AND the public `/weighins` webform. SheepHome has a Processing Batches tile.
- **Sheep weigh-in feature parity (added 2026-04-27):** SheepWeighInsView rewritten 185 → ~390 lines to match CattleWeighInsView. `SheepNewWeighInModal` for session create. Status filter (all / draft / complete) + tag search + Edit / Delete per entry + Swap Tag + Missing Tag + reconcile-new-tag + Send-to-Processor toggle + ADG vs prior completed session. Send-to-Processor gate is intentionally LOOSER than cattle's: any draft session, any flock (cattle stays finishers-only). `SheepFlocksView.transferSheep` writes a `sheep_transfers` audit row.

### 5.7 Daily reports / webforms

- Public webforms at `/webforms`, `/addfeed`, `/weighins` (no auth required).
- Programs: Broiler, Layer, Pig, Egg, Cattle daily reports. Plus the legacy pig-dailys form at `/webform` (extracted to `src/webforms/PigDailysWebform.jsx` in the 2026-04-21 polish).
- Team-member dropdowns read the master roster (`webform_config.team_roster`, legacy `team_members` mirror); per-form filtering retired 2026-04-29. Admin-configurable required/optional fields.
- Add Group feature: submit multiple batch reports in one form submission (via `allowAddGroup`).
- All delete actions use `DeleteModal` (type "delete" to confirm) — never `window.confirm`.

### 5.8 Add Feed webform

- Route: `/addfeed`. Inserts a new row into the appropriate `*_dailys` table with `source='add_feed_webform'`. Does NOT merge, mutate, or check collisions.
- Works because all 16+ feed-aggregation sites use `.reduce()` over filtered row arrays — multiple rows per batch+date are already normal.
- Rows visually badged in the Reports list with a 🌾 icon. Edit modal hides non-feed fields.
- Tri-state filter chip in each Reports list: All / Daily Reports / Add Feed.
- Pig inserts omit `feed_type` entirely (`pig_dailys` has no such column).

### 5.9 Permissions

| Role | Capabilities |
|---|---|
| `farm_team` | Edit + delete own daily reports only |
| `management` | Edit anything; delete daily reports only |
| `admin` | Full access — edit + delete everything; only admin can delete batches / groups |

Per-program access via `profiles.program_access` text array. Null/empty = full access. Otherwise a list like `['cattle','broiler']`. Admins always bypass. Canonical check: `canAccessProgram(prog)` + `VIEW_TO_PROGRAM` map in `main.jsx`.

Role-derived predicates also live in main.jsx: `canEditAll`, `canDeleteDailys`, `canDeleteAll`, etc. Module-level versions (`canEditDailys`, `canEditAnything`, etc.) exist in `main.jsx` for component prop threading.

---

## 6. Conditional field rules + design preferences

### Conditional field rules (apply to ALL forms)

1. **Feed type** is only required when `feed_lbs > 0`. Enforced in `validateRequiredFields()` and explicit submit checks.
2. **Mortality reason** is hidden until `mortality_count > 0`; then required with red asterisk.
3. All delete confirmations use `DeleteModal` (type "delete" to confirm). No `window.confirm`.

### Design preferences

- **No purple colors anywhere.** Cattle palette uses reds/wines (Bulls is wine, not purple).
- Modals are centered overlays, never inline forms.
- Auto-save with 1.5s debounce on edit forms; save on close.
- Colored pills for yes/no fields, team members, comments.
- Delete button lives only in the modal footer when editing (no separate Done/Cancel because auto-save handles commit).
- Alternating colors on batch cards.
- The pig feed tile layout is the model for all feed-tab tiles.
- Program palette committed 2026-04-14 (commit `524b4c2`) — don't repaint programs without revisiting that commit.

---

## 7. Don't-touch list

The following are load-bearing project contracts, not migration-era artifacts. Changes that touch them require explicit planning and review before implementation. They were originally documented in `MIGRATION_PLAN.md §10` and are promoted here as authoritative.

- **`wcfSelectAll` pagination** (`.range(from, from+999)` + while-loop pattern in `src/lib/pagination.js`). `.limit()` silently caps at 1000 — the pagination helper is the only correct way to load >1000 rows.
- **Two-query `loadCattleWeighInsCached`** in `src/lib/cattleCache.js`. Session IDs first, then `weigh_ins.in()`. **No `!inner` joins anywhere.**
- **Supabase auth config:** `detectSessionInUrl: false` + `storageKey: 'farm-planner-auth'` in `src/lib/supabase.js`. See §Part 2 for rationale — do not change without a migration plan for outstanding sessions.
- **Source-label workflow strings:** `'import'` / `'weigh_in'` / `'manual'` for `old_tags` history entries. Renaming breaks prior-tag reconciliation.
- **`cellDates: true`** in any `XLSX.read()` call. Excel date parsing is broken without it.
- **`_wcfPersistData` debounce timing (800ms).** Changing the window risks double-saves or lost saves.
- **Webform URL paths (post 2026-05-06 rename):** canonical `/dailys`, `/dailys/<form>`, `/dailys/tasks`, `/addfeed`, `/weighins`, `/equipment`, `/equipment/<slug>`, `/equipment/supply`, `/fuel-supply` — plus the legacy aliases (`/webforms*` → `/dailys*`, `/fueling*` → `/equipment*`) and `/#` hash variants that the shim rewrites. The public-URL rename was deliberate; `/addfeed` and `/weighins` stay byte-stable. Field materials print canonical URLs going forward, but legacy aliases must keep redirecting indefinitely until/unless an explicit retire-by date is set. PWA install routing is split at the static HTML layer (Netlify `_redirects` serves `equipment.html` for `/equipment*` + `/fueling*` before the SPA fallback) — see "PWA install entry points" entry below.
- **PWA install entry points (added 2026-05-06).** `index.html` links `/manifest.webmanifest` with start_url `/dailys`; `equipment.html` links `/manifest-equipment.webmanifest` with start_url `/equipment`. `vite.config.js` must keep both as `rollupOptions.input`; `public/_redirects` must route `/equipment*` + `/fueling*` to `/equipment.html` before the catch-all `/* /index.html 200`. Static lock: `tests/static/pwa_install_html.test.js`.
- **Per-program `canAccessProgram` rules** (admin always bypasses). Behavior contract with `profiles.program_access` rows.
- **`\u` JSX escape literals** (em-dashes, bullets, en-dashes). Preserve the exact escape form — mixing with unicode characters in source risks encoding drift across editors.
- **`cattle.old_tags` jsonb shape.** Retag reconciliation reads specific field names.
- **`weigh_in_sessions.species` column convention** (`broiler` / `pig` / `cattle` / `sheep`). The shared session table discriminates here.
- **Supabase RLS policies.** None are touched by frontend work anyway — flag any suggestion that would require an RLS change.
- **`breeders[].transferredFromBatch.sourceWeighInId` shape.** The pig Transfer-to-Breeding dup guard reads this exact key — renaming breaks dedup and lets fast double-clicks recreate duplicates.
- **`weigh_ins.note` `[transferred_to_breeding breeder=… feed_alloc=…]` marker.** Pre-migration-014 fallback path writes this; the LivestockWeighInsView badge detection regex (`/\[transferred_to_breeding/`) and the feed_alloc parser depend on the format.
- **Pig transfer `mode` identifiers** in weigh_ins flow (`'retag'` / `'replacement'`) and old_tags `source` values (`'import'` / `'weigh_in'` / `'manual'`). User-facing strings were renamed to "Swap Tag" / "Missing Tag" / "(swap)" but internal IDs stayed for historical-data resolution.
- **Pig color palette = blue family only.** `PIG_GROUP_COLORS` in `src/lib/pig.js` uses sky / core blue / slate. Per-group base, lighter for gilts grow-out, darker for boars grow-out. No purple anywhere in pig views (Ronnie's standing rule).
- **`pigMortalities`, `pigsTransferredOut` audit fields on feeder groups.** Mortality count + comment + team_member + date stored on `feederGroup.pigMortalities[]`; transfer counts derived from `breeders.transferredFromBatch.batchName`. Both arrays are append-only audit logs — don't mutate historical entries.
- **Podio `status='deleted'` filter in equipment seeders.** `scripts/import_equipment.cjs` + `scripts/patch_equipment_intervals.cjs` + `scripts/patch_equipment_help_text.cjs` must filter BOTH `field.status !== 'deleted'` AND `option.status !== 'deleted'` when walking Podio's app-config JSON. The API ships cruft from cloned templates (e.g. tractor fields still sitting in the Honda ATV app) that the published webform hides — removing the filter resurrects the cross-contaminated intervals on the planner. Surveyed 2026-04-23: 21 deleted fields + ~400 deleted options across 17 apps. Every piece is affected.
- **Equipment `total_tasks` in `equipment_fuelings.service_intervals_completed` is baked in at import time** — stored per-completion. After an interval's task count changes (e.g. Podio prunes an option, or the admin task editor deletes one), historical rows become stale. Don't add new consumers that read `total_tasks` directly — fetch the current `equipment.service_intervals[].tasks.length` or run `scripts/patch_equipment_completions.cjs --commit` to re-clamp. UI in `EquipmentDetail.jsx` expanded-row already computes live from current config.
- **`items_completed` slug format in completions.** Slugified via `text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50)`. Same slugify is used in `rebuildFromConfig` so IDs match. Changing either end will break the `taskById` lookup in the expanded fueling row and the matching in the completions patch.
- **`attachment_checklists` JSONB shape on equipment.** `[{name, hours_or_km, kind, label, tasks:[{id,label}], help_text}]`. Keyed in the webform by `name + kind + hours_or_km`. Detected at seed time by `/\s--\s|\s—\s/` in the Podio field label (e.g. "Tough Cut -- Every 50 Hours"). Don't co-mingle attachment and main intervals — the dedup on (kind, hours_or_km) will lose attachment data.
- **"Every Use" / "Every Session" interval sentinel = `hours_or_km: 0`.** Ventrac's attachments include per-session checks (not hour-based). `parseIntervalLabel` in `scripts/import_equipment.cjs` matches `\bEVERY\s+(USE|SESSION)\b` and returns `values: [0]`. Render logic on `EquipmentFuelingWebform.jsx` + `EquipmentWebformsAdmin.jsx` treats `hours_or_km === 0` as literal "Every Use" label. Don't change the sentinel — all existing attachment rows in Supabase use 0.
- **Podio external_id variants for the every-fillup field.** Some apps use `every-fuel-fill-up-checklist` (most), others use `every-fuel-fill-up` (2018 Hijet + a few). `import_equipment.cjs` tries both. When adding a NEW Podio app, grep its `*.config.json` for `external_id` first and extend the fallback list if you find a third variant. Silent data loss if you miss one.
- **Equipment status enum is `active | sold`** (migration 022 renamed `retired` → `sold`). Don't reintroduce `'retired'` — fleet view, admin modal, detail page, import script, and dedup all key on `'sold'` for the 6 sold pieces (JD-317/333/Gator, Kubota-RTV, Polaris-Ranger, Great-Plains-Drill).
- **`equipment.manuals` is operator-facing; `equipment.documents` is admin-only.** Same JSONB shape `[{type:'pdf'|'video', title, url, path?, uploadedAt}]`. ManualsCard (on public `/equipment/<slug>` + logged-in `/fleet/<slug>` post 2026-05-06 rename) reads ONLY `manuals`. Admin modal's DocumentsEditor reads/writes ONLY `documents`. Don't mix — admin paperwork (invoices, warranties, purchase docs) leaking onto the public webform is a confidentiality break.
- **`fuel_supplies` table != `equipment_fuelings` table, and consumption combines them.** `equipment_fuelings` is per-equipment checklist fuel use. `fuel_supplies` records fuel dispensed at `/equipment/supply`; `destination='cell'` is inventory movement, while `gas_can`/`farm_truck`/`other` are consumption. Reconciliation consumption = non-suppressed equipment fuelings + non-cell supply rows; never count cell-destination supply rows as consumption.
- **Public equipment fueling submissions use `submit_equipment_fueling` RPC** (mig 047, shipped 2026-05-06). `/equipment/<slug>` must call `sb.rpc('submit_equipment_fueling', {parent_in})`, not a direct anon `equipment` update. The RPC is `SECURITY DEFINER`, `SET search_path = public`, anon + authenticated EXECUTE, and atomically inserts `equipment_fuelings` plus GREATEST-bumps `equipment.current_hours` or `equipment.current_km`. Idempotency is owned by `client_submission_id` with `ON CONFLICT DO NOTHING RETURNING` + fallback SELECT, so replay returns an idempotent response rather than surfacing 23505. Do not add anon UPDATE on `equipment`; the table also carries admin-controlled specs/manuals/documents/checklists. `latestSaneReading` stays as read-side fallback for historical drift or future bypasses.
- **Equipment rolling materials sidecar tables** (mig 048). Materials live in `equipment_service_materials`; clears live in `equipment_material_clears`. No anon policies and no parts data inside `equipment.service_intervals` or `attachment_checklists` JSONB. Clear identity is `(material_id, due_bucket_value, due_bucket_unit)` so one material hides until its next bucket; hours window 100h, Hijet/km window 5000km, `use` clears stay until admin reset, and attachment completion math must scope by `attachment_name`.
- **FuelingHub.jsx enumerates equipment columns explicitly** — when adding a new column to `equipment`, also add it to `FuelingHub.jsx:19`'s select list, or the public `/equipment/<slug>` webform (was `/fueling/<slug>` pre-rename; the file is still `src/webforms/FuelingHub.jsx`) won't see the new field. Same rule for `HomeDashboard.jsx` equipment fetch. Always grep `from('equipment')` across `src/` after a migration.
- **Dedup-then-scrub ordering is a trap.** `scripts/patch_dedup_fueling_pairs.cjs` merges winner data but keeps the winner's original `podio_source_app` label. If you then run `scripts/patch_scrub_fuel_log_only.cjs` (deletes by `podio_source_app='fuel_log'`), you destroy merged rows that carry checklist data. Either (a) update source labels in dedup, (b) scrub by content criteria via `scripts/patch_scrub_empty_checklists.cjs`, or (c) always re-import via `import_equipment.cjs --fuelings-only` before scrubbing by source.
- **`import_equipment.cjs --fuelings-only` flag.** Use this for every post-launch re-import. Full-import form wipes admin-patched fields on the `equipment` table (operator_notes, team_members, manuals, documents, attachment_checklists adjustments, hand-edited fluid specs). Full-import is only correct on a clean-slate initial seed.
- **Podio-side duplicate submissions are real.** Operators sometimes submit the same Checklist twice within 24-48 hours. Known pairs as of 2026-04-24: c362 ×2, gehl ×2, honda-atv-1 ×4, ps100 ×1. Planner collapses to 1 row per unique (date, reading, team) via fallback match. Raw Podio counts ≥ planner counts for those pieces — that's correct, not a bug.
- **Snap-to-nearest milestone semantics for service intervals** (`src/lib/equipment.js` `snapToNearestMilestone` + `aggregateCompletionsByMilestone`). Every full completion at reading R for interval I snaps to whichever milestone (multiple of I) is closer. Tie-break favors the previous milestone (treat as late completion of prior). Next-due = snapped milestone + I. Don't revert to floor-based math — it caused the "500hr at 968h flagged overdue at 1000h" bug. Divisor cascade uses parent's RAW reading, NOT parent's snapped milestone — each sub-interval does its own independent snap. (Cascading the parent's snap would over-credit subs — 600hr at 1596 snapping to 1800 would falsely satisfy 50hr's 1700/1750/1800.)
- **Cumulative-partial milestone model** (`aggregateCompletionsByMilestone`). All completions (full + partial) for a given interval are grouped by their snapped milestone. Within each group, the UNION of `items_completed` is what counts. If union ≥ task count, the milestone is virtually-fully-satisfied even when no single submission was full. This handles real-world maintenance flow where work spans multiple sessions (e.g. 500hr partial at 440h with 14/16 done + 500hr partial at 444h with the missing 2/16 = full coverage of the 500h milestone). `total_tasks` is read from CURRENT equipment config so admin task edits re-evaluate history correctly. Don't switch to "latest single completion wins" — Ronnie depends on this for parts-arrival workflows.
- **Read-fresh-then-write for `webform_config` jsonb keys.** Any caller that edits a JSONB-valued row in `webform_config` must re-fetch the latest `data` from the DB right before its upsert and merge against fresh state, NEVER trust local React state alone. The upsert overwrites the entire `data` field, so concurrent toggles' setState effects may not have landed and stale-state writes silently drop other keys' edits. `saveRoster` in `src/lib/teamMembers.js` is the canonical implementation of this pattern (read-fresh-then-merge by id, with a documented first-canonical-save shortcut to avoid duplicating legacy names). Any future JSONB-key editor on `webform_config` (or any similar wide-jsonb store) follows the same pattern.
- **`fuel_bills` + `fuel_bill_lines` are admin-only.** Migration 026. RLS = authenticated SELECT/INSERT/UPDATE/DELETE. The `fuel-bills` storage bucket is `public:false` — signed URLs only (10-min expiry via the BillDetail PdfLink component). Don't add anon access; bills carry financial info.
- **Tax allocation depends on bill-format detection in `parseFuelBillText`.** Home Oil's `Tax and Other Charges Included in Price` phrase means unit prices are already all-in, so allocated tax stays 0. Tax-exclusive formats use additive allocation. Do not remove the detector; otherwise Home Oil bills double-count tax in line costs and reconciliation.
- **`weigh_ins.prior_herd_or_flock` semantics (mig 027).** Stamped at attach time with the animal's herd (cattle) or flock (sheep) BEFORE the move to `'processed'`, AND ONLY when transitioning non-processed → processed. The detach helper reads it first to revert. Multi-batch reattach must NOT capture `'processed'` as the prior state. On detach, BOTH `target_processing_batch_id` AND `send_to_processor` are cleared on every matching `weigh_ins` row (the second clear was a fix in commit `448152e` after the per-row × on the batch view left orphan flag chips).
- **Detach fallback hierarchy (cattle + sheep).** `detachCowFromBatch` / `detachSheepFromBatch` resolve prior herd/flock via: (1) `weigh_ins.prior_herd_or_flock` for the entry that attached this animal, (2) most recent `cattle_transfers` / `sheep_transfers` row with `reason='processing_batch' AND reference_id=batchId`, use `from_herd`/`from_flock`, (3) BLOCK with `reason:'no_prior_herd'` / `'no_prior_flock'` — never silently default. Callers surface the block to admin.
- **`cattle_transfers` + `sheep_transfers` are append-only audit logs.** RLS allows authenticated INSERT + SELECT only — no UPDATE/DELETE policies. Reversal events go in as new rows with `reason='processing_batch_undo'`.
- **Cattle/sheep batch membership rule.** Animals enter `cattle_processing_batches` / `sheep_processing_batches` ONLY via the `send_to_processor` flag on a finishers (cattle) or any-flock (sheep) weigh-in entry, then through the SendToProcessor modal at session-complete time. There is no manual cow/sheep multi-select on the batch modal anymore. The batch view's per-row × button calls the detach helper; Delete-batch loops detach over every row with success/failure reporting (Codex Edge Case #2). The cattle gate stays strict (finishers-only); sheep gate is intentionally looser per Ronnie's request — any draft session, any flock.
- **`processingTrips[].subAttributions` schema** = `[{subId, subBatchName, sex, count}]`. `subBatchName` and `sex` are denormalized for readability + future-proofing (per Codex review). Send-to-Trip in `LivestockWeighInsView` stamps these on every trip; the cattle/sheep send-to-processor flows do equivalent stamping. Legacy P-26-01 trips were patched via `scripts/patch_p26_01_trip_attributions.cjs --commit`.
- **`parent.fcrCached` clear-on-null contract.** `computePigBatchFCR` returns null when no valid trips remain or rawFeed ≤ credits. Both `persistTrip` and `deleteTrip` MUST `delete next.fcrCached` (not leave the previous value) when the helper returns null, so the transfer flow's `parent.fcrCached || 3.5` falls back to default rather than a stale ratio.
- **Photo→fueling matching falls back to `(equipment_id, date)`.** Original `pull_podio_equipment_photos.cjs --upload` matched only by `podio_item_id`. After the dedup-then-scrub flow merged Fuel Log + Checklist pairs (keeping Fuel Log's `podio_item_id`), photos attached to the now-deleted Checklist items lost their match — only 48 of 195 unique manifest items linked. `scripts/patch_relink_photos_by_date.cjs` reads each photo entry's date from the Podio item dump and matches by (equipment_id, date) instead. Brought coverage from 48 → 167 fuelings linked (552 photos). When importing future Podio apps with similar dedup pressure, prefer date-matching for the link step.
- **`daily-photos` storage bucket is private; reads via signed URLs only** (mig 031). Daily-report photos store paths in row JSON and authenticated views render signed URLs. Keep anon INSERT-only and no public SELECT/UPDATE/DELETE; operator-context photos are not public equipment manuals.
- **`client_submission_id` is the queue idempotency key on webform target tables** (mig 030). Public direct-insert flows use plain `.insert(record)` and treat 23505 on the `*_client_submission_id_uq` index as already-synced; anon `.upsert(... onConflict ...)` is blocked by RLS because PostgREST needs SELECT on the conflict target. RPC flows may use SQL `ON CONFLICT` inside SECURITY DEFINER functions.
- **3 hand-created prod tables (`pig_dailys`, `poultry_dailys`, `layer_dailys`) likely have RLS disabled in prod.** They appeared in PROJECT.md §3 as hand-created; Ronnie's pg_policies dashboard export (2026-04-28 eve+) confirmed they have NO policies — none exist for those tables. The public webforms write to them anonymously and it works because RLS isn't enforced (RLS-disabled = everyone has access regardless of policies). **Don't ENABLE RLS on these tables without first establishing INSERT policies for the anon/public role** — doing so would break AddFeedWebform and PigDailysWebform on the next deploy. If a future build needs RLS on these tables (e.g. for tenancy isolation), it must come paired with policy creation in the same migration.
- **Team-member master roster:** `webform_config.team_roster` is canonical object[]; `team_members` is the legacy all-name mirror. Sole writer is `TeamRosterEditor`/`saveRoster` in `src/lib/teamMembers.js`. Delete flow must clean `team_availability` and `equipment.team_members` before saving the roster; historical `team_member` strings are never rewritten. Tasks use `profiles.id`, not roster ids.
- **Team-member per-form availability:** `webform_config.team_availability` stores hidden roster ids per public form key. Sole writer is `TeamAvailabilityEditor`; public forms read via `loadAvailability` + `availableNamesFor`. Stable ids preserve hide state across renames; delete cleanup removes hidden ids for removed workers.
- **`submit_weigh_in_session_batch` RPC** (mig 035). Pig + broiler fresh draft weigh-in sessions must create the parent `weigh_in_sessions` row and child `weigh_ins` atomically through this RPC, with dedup owned by the parent `client_submission_id`. V1 accepts only `species in (pig, broiler)` and `status='draft'`; cattle/sheep completion, processor, retag, and side-effect-heavy paths stay out until their own RPC design exists.
- **Public broiler WeighIns reads `webform_config.broiler_batch_meta`; never `app_store.ppp-v4`.** `src/lib/broilerBatchMeta.js` builds `broiler_groups` + `broiler_batch_meta` together from active batches only, so public anon forms never query the auth-only app store. Empty schooners block session start/resume; there is no `(no schooner)` fallback.
- **Admin broiler session metadata edit + `recomputeBroilerBatchWeekAvg` helper.** On `/broiler/weighins`, changing a complete broiler session's week, or reopening it to draft, must recompute/clear the old `ppp-v4 wk*Lbs` value with that session excluded before stamping any new complete-session average. `recomputeBroilerBatchWeekAvg(sb, batchId, week, {excludeSessionId})` returns `{ok,message?}` and only `{ok:false}` is user-visible failure.
- **Tasks Module v1 shipped contract** (migs 036-046; C1-C4 shipped through `5c839e7`, TEST + PROD DB/function probes green). `public.is_admin()` remains the single admin-role helper for task RLS and RPC auth. `task_templates` are admin-only. `task_instances` are admin-all plus assignee SELECT-own; assignees cannot direct-UPDATE and complete through `public.complete_task_instance(...)` instead. `task_cron_runs` and `task_summary_runs` are admin SELECT only and service-role append-only. NO required-photo behavior exists anywhere in Tasks v1.
- **Tasks generation + summary schedules**: `tasks-cron-daily` runs `public.invoke_tasks_cron()` at `0 4 * * *` UTC; `tasks-summary-weekly` runs `public.invoke_tasks_summary()` at `0 13 * * 1` UTC. Vault secrets in use: `TASKS_CRON_FUNCTION_URL`, `TASKS_SUMMARY_FUNCTION_URL`, `TASKS_CRON_SECRET`, `TASKS_CRON_SERVICE_ROLE_KEY`. PROD probe rows with `tcr-probe-*` and `tsr-probe-*` prefixes are real audit, not cleanup debt.
- **Tasks C1-C4 surfaces shipped**: C1 `/admin/tasks` admin Tasks Center; C2 `/my-tasks` assignee list + optional completion photo + `complete_task_instance` RPC; C3/C3.1 `/dailys/tasks` public submit + assignee availability + offline RPC queue + optional request photos; C4 weekly task summary emails through `tasks-summary` -> `rapid-processor` payload type `tasks_weekly_summary`. Admin-side "mark complete someone else's open task from Tasks Center" was intentionally deferred.
- **Tasks photo storage contract**: completion photos use `task-photos/<assignee_uid>/<instance_id>/<filename>`; request photos use `task-request-photos/<one_time_instance_id>/<filename>`. Both buckets are private and append-only. Uploads must use `upsert:false`; duplicate storage errors are classified as retry success. Do not switch these flows to `upsert:true` unless bucket UPDATE policies are intentionally added.
- **Tasks Edge Function deploy lessons**: new Edge Functions live under canonical `supabase/functions/<name>/index.ts`. The legacy `supabase-functions/rapid-processor.ts` file is still the source of truth for rapid-processor; deploy it by temporarily staging it under `supabase/functions/rapid-processor/index.ts`, deploying with `--no-verify-jwt`, then removing the temp directory. Branches that are reachable without JWT verification must self-gate; `user_delete` checks caller admin status and `tasks_weekly_summary` checks the service-role bearer.
- **`daily_submissions` + `submit_add_feed_batch` RPC** (mig 034). Add Feed is a parent-plus-children submission: anon callers use the SECURITY DEFINER RPC, not direct multi-row child inserts, so parent/children are atomic and idempotent by parent `client_submission_id`. Child daily rows do not carry the parent csid; `daily_submission_id` is a soft pointer because some child tables are hand-created prod tables. No anon policies belong on `daily_submissions`.

---

## 8. Open items / roadmap

### Recently shipped (2026-05-01 through 2026-05-07)

- **Tasks v1 C1-C4 closed.** Admin Tasks Center, `/my-tasks`, public `/dailys/tasks` (was `/webforms/tasks` pre-rename — see URL rename below), request photos, completion photos, daily generation, weekly summaries, migs 036-046, and TEST/PROD function+DB probes are shipped through `5c839e7`.
- **Cattle Forecast + herd polish shipped.** Forecast source and mig 043 are live; mig 044 calving automation is captured; cattle heifer inclusion states and herd sorting/filter polish are shipped.
- **Broiler hatch-date activation shipped.** Planned broiler batches auto-switch to active on hatch date (`fd12e6a`).
- **Equipment mower icon + Backup/Restore cleanup shipped.** Do not list those as future cleanup.
- **Photo-picker hotfix (`307ed3b`, 2026-05-06).** Removed forced camera capture from public Tasks request photos and `DailyPhotoCapture`; users get the normal device picker.
- **Public URL rename + App Setup modal (`fb79c38`, 2026-05-06).** `/webforms` -> `/dailys`, `/fueling` -> `/equipment`, logged-in `/equipment` -> `/fleet`; aliases retained. See §7 URL/PWA entries.
- **Static-HTML PWA install hotfix (`130660c`, 2026-05-06).** Added `equipment.html` and redirect order so equipment installs use `start_url=/equipment`; see §7 PWA install entry points.
- **Equipment fueling current-reading RPC (`0e66274`, 2026-05-06).** Public `/equipment/<slug>` fueling now uses mig 047 `submit_equipment_fueling` to insert fuelings and bump current readings atomically.
- **Pig public weigh-in recent entries hotfix (`c4abc06`, 2026-05-06).** Pig sessions render all current-session entries with `Recent entries (<count>)`; the old latest-10 cap is gone.
- **Equipment rolling materials checklist (`97bdb6b`, 2026-05-07).** Mig 048 sidecar tables, `/fleet/materials`, HomeDashboard Materials Needed card, and per-equipment admin Materials editor shipped.
- **HomeDashboard equipment alert specs (`3e28284`, 2026-05-07).** Locked alert priority order to `KIND_ORDER = {overdue:0, fillup_streak:1, warranty:2}` with alphabetical-within-kind tiebreak (already in `src/dashboard/HomeDashboard.jsx`), and added an auto-clear spec that drives the anon `submit_equipment_fueling` RPC then reloads `/home` to confirm the overdue row vanishes. New `seedHomeDashboardEquipmentMix` sibling seed helper. 7 specs total in `tests/home_dashboard_equipment.spec.js` (5 existing single-kind + 2 new).
- **HO.md SOP nuance (`d0ebec4`, 2026-05-07).** Communication Format section gained the rule that `From CC:` / `From Codex:` copyable handoff blocks should stay plain text; no Markdown backticks around file paths, route names, function names, commit subjects, or command names — backticked terms render as shaded snippets and add friction to one-click copy/paste.
- **Per-view state internalization lane (`501e702`..`2a04c1f`, 2026-05-07).** Phase 0 audit covered 31 `useState` hooks in `App()` body. Six internalization commits moved 19 hooks to their owning views: SowsView leaderboard cluster (`501e702`), PigBatches sub-form cluster (`9a511d8`), feed month-expansion sibling move (`2a6edd5`), WebformsAdminView editor-view cluster (`7adcc61`), WebformsAdminView inline-edit cluster (`a76eb3b`), and PigBatches archived-batches toggle (`b02730f`). Two cleanup commits removed dead/write-only state and the EMPTY_DAILY block plus related no-op setter calls and three app_store loader writes (`b7b51e0`, `2a04c1f`): editDailyId, dailyForm, dailysFilter, pigNotes, layerNotes, broilerNotes, wfView, showDailyForm. Lint warnings dropped from 746 to 734 with zero new warnings. Hooks intentionally left in App: `feedOrders`, `pigFeedInventory`, `poultryFeedInventory`, `collapsedBatches`, `collapsedMonths`, `adminTab` (multi-view shared, domain-tracked, or localStorage-backed). Smoke-gate rule refined during the lane: smoke skippable for pure single-view UI-state relocation when handlers/save logic and saved-data ownership are unchanged, bare-name audit is clean, and validation floor is green; smoke required for state that becomes a submitted operational record, public form payload, localStorage-backed state, URL-persisted state, shared cross-view state, or handler/render branch changes.

### Deferred Initiative B follow-ups (Phase 2.5-2.6)

Lint at 0 errors and Prettier enforcement are already shipped. Remaining Initiative B cleanup is mechanical churn that does not unlock anything:

- **Phase 2.5 `no-unused-vars` cleanup** — current `npm run lint` baseline is 0 errors / ~734 warnings (post-per-view-internalization, 2026-05-07); the bulk are still `no-unused-vars` from Phase-2-extraction imports plus drift from later lanes. Some `eslint --fix`-able; rest is per-site removal. Largest of the three.
- **Phase 2.6 `react-hooks/exhaustive-deps` triage** — 61 warnings, case-by-case judgment.

### Near-term (known & actionable)

No active approved build is in progress after the per-view state internalization lane.

- **Import more Podio apps** (Ronnie has more workspaces coming over — animal dailys, breeding records, etc.). Budget time for each: inventory fields via dump, filter `status='deleted'`, match external_id variants (e.g. `every-fuel-fill-up` vs `-checklist`), design per-app → planner table mapping, add per-app Fuel-Log-style category map if applicable, add `--fuelings-only`-style flag if it touches a patched-admin table, dry-run, audit against Podio XLSX exports. All Podio-import pitfalls live in §7 (don't-touch list). **For photo links, prefer `(equipment_id, date)` matching from day 1** to avoid the 147-orphan problem we hit on the equipment apps.
- **Optional DB cleanup after explicit gates.** Cattle maternal issue UI is retired, but DB columns still require a separate TEST/PROD audit before any drop. Sheep analogous fields are a separate decision.
- **`/equipment/supply` operator smoke test.** Bills + Reconciliation paths are smoke-tested end-to-end (2026-04-27, real Home Oil PDF), but the public supply form itself hasn't had an operator submission this iteration. Ronnie should submit one entry to confirm anon insert + per-form team filter + the relabeled cell-refill destination warning. Legacy `/fueling/supply` remains an alias.
- **Multi-month Home Oil bill validation.** First real bill (`IN-0195942`, Mar 2026 delivery) parsed clean end-to-end. Pull a handful more through `/admin → Fuel Log → Bills → + Upload bill` to confirm regex stability across month-to-month variation. New supplier formats will need their own detection branch — `parseFuelBillText` currently keys on the literal `Tax and Other Charges Included in Price` phrase to pick tax-included vs additive logic.
- **Purchased ↔ consumed reconciliation review.** `/admin → Fuel Log → Reconciliation` groups bills (`fuel_bills` + `fuel_bill_lines`, by `delivery_date` month) on the PURCHASED side, vs (`equipment_fuelings` excluding `suppressed` + non-cell `fuel_supplies`, by `date` month) on the CONSUMED side. Variance bands: ≤5% green / 5–10% orange / >10% red (driven by `VARIANCE_WARN_PCT = 5` in `FuelReconcileView.jsx`). Single-month variance is rarely meaningful — month timing (bill arrives one month, fuel gets used the next) and inventory carryover in the cell make exact monthly matches uncommon. Look at multi-month trends. Once bills accumulate, scan for sustained patterns rather than single-month deltas.
- **Per-head cattle cost rollup.** Feed cost (from `cattle_dailys.feeds[].lbs_as_fed × landed_per_lb`) + processing cost (from `cattle_processing_batches`) per cow with attribution rules. Not blocking ops.
- **Feed system physical count verification.** The adjustment calculation (system estimate vs actual count) needs real-world validation. Code reviewed for edge cases.
- **Cattle Add-Cow flow cleanup.** Edit-in-modal is gone in favor of inline expanded tiles. The remaining Add-Cow path still uses modal/form state in `src/cattle/CattleHerdsView.jsx`; either keep it as add-only modal or convert it to "create empty cow row, expand it inline."
- **A10 CI Actions secrets configuration** (Ronnie task, ~5 min). Five repo Actions secrets needed at [Settings → Secrets and variables → Actions](https://github.com/byronronniejones-lab/WCF-planner/settings/secrets/actions): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_TEST_ADMIN_EMAIL`, `VITE_TEST_ADMIN_PASSWORD`. Values come from `.env.test` / `.env.test.local`. Until configured, the CI workflow's e2e step fails fast on the assertTestDatabase guard (lint/vitest/build pass). After configuration, re-run failed jobs from the Actions UI or push any change to validate end-to-end.
### Deferred (no current owner)

- **DNA test PDF parser** for cattle — manual entry is the v1 workaround.
- **Weather API integration** — multi-program scope, no provider chosen. Farm coords in §2.
- **TypeScript conversion.**
- **Additional Playwright coverage beyond Phase 1.** All 9 planned specs + smoke + A1 follow-up shipped 2026-04-28 (late PM); see §8 sequencing for SHAs. Future candidates as the app grows: equipment fueling webform flows, public weigh-ins webform, layer housing math, Add-Feed webform, /sheep bulk import (now-functional after `900aed1` — would lock the runtime fix). Each can land as its own focused spec following the established cadence.
- **CSS framework** (Tailwind, etc.) or styled-components.
- **Service worker / offline app shell** (PWA install entry points are already shipped; no service worker exists yet).
- **Splitting `app_store` jsonb blobs into dedicated tables** (per-feature).
- **Full router migration** (replace `setView('X')` with `useNavigate('/path')` across every view). The adapter works fine; this is pure churn for "idiomatic React Router" without user-visible benefit.
- **Sheep module Phase 2** — nutrition targets, retag flow.

### Known gotchas (watch for these)

- **The `housingBatchMap` shape** was not directly SQL-verified during the Add Feed design. Existing code treats it as `{housingName: batchName}` (flat object). If layer `batch_id` resolution misbehaves at runtime, that's the first place to look.
- **The `source` column** on dailys tables is nullable. Filter logic: `r.source !== 'add_feed_webform'` handles null correctly (returns true). No null guard needed.
- **Historical B-24-* broiler batches** use legacy manual feed fields. B-25+ batches pull from dailys. Don't unify these without backfilling the older data.
- **PigsHomeView shows feed=0 once a pig batch's subs are all processed.** `PigsHomeView.jsx:100-103` filters dailys by ACTIVE subs only — when every sub is marked processed, the filter excludes the whole batch's daily reports and total feed reports as 0 on the home dashboard. PigBatchesView's totals are unaffected (it reads all subs regardless). Pre-dates the 2026-04-27 accounting overhaul; left as follow-up.
- **Imported sheep weigh-in sessions have `herd=null`.** Podio import never set `weigh_in_sessions.herd`. The Send-to-Processor toggle on `/sheep/weighins` is gated to draft sessions only (no flock check); admin can flag any sheep on those legacy sessions. New sessions created via "+ New Weigh-In" set the flock correctly. Cattle gate stays strict (finishers-only).
- **`pigSlug('P-26-01A') === 'p-26-01a'` (NO dash before the letter).** `pigSlug` in `src/lib/pig.js` slugifies via `/[^a-z0-9]+/g` — uppercase letters become alphanumeric after `toLowerCase()`, so the `A` in `P-26-01A` merges with the digits beside it instead of getting a separating dash. `LivestockWeighInsView.sendEntriesToTrip` resolves which sub a session's entries belong to by `pigSlug(session.batch_id) === pigSlug(sub.name)` — feed it `'p-26-01-a'` (hand-typed dashed form) and the match silently fails, producing a trip with empty `subAttributions`. Foot-gun for any future test seed or operator who builds `weigh_in_sessions.batch_id` by hand. Always run input through `pigSlug` rather than typing the dashed form.
- **Nine prod tables are hand-created, no migration owns them.** `profiles`, `app_store`, `webform_config`, `poultry_dailys`, `layer_dailys`, `egg_dailys`, `pig_dailys`, `layer_batches`, `layer_housings`. They exist in production from manual dashboard setup or Supabase auth templates that pre-date the migration history in this repo. The bootstrap bundle (`scripts/build_test_bootstrap.js` → `hand_created_tables_seed`) seeds them on a fresh test project; if any of these schemas drift on prod, regenerate the bundle against the new shape. See §3 for the full list + capture date.
- **Pig batch tile uses no `.hoverable-tile` class and doesn't click-to-expand.** `PigBatchesView.jsx:836+` renders each feeder group inline — trips and sub-batches are always visible inside the batch card. Cattle/sheep/broiler tiles all use `.hoverable-tile` + click-to-expand state, so test selectors that copy the cattle/sheep pattern silently fail on `/pig/batches`. For Playwright specs targeting trip rows, anchor on text content (date + pig count) plus the always-present Edit button — see `tripRow()` in `tests/pig_fcr_cache.spec.js` for the canonical helper.
- **Supabase blocks direct DELETE on `storage.objects`.** Service-role queries via `exec_sql` get back `Direct deletion from storage tables is not allowed. Use the Storage API instead.` Test reset for storage cleanup must use `sb.storage.from(bucket).list()` + `.remove()` recursion, NOT raw SQL. See `cleanupFuelBillsStorage` in `tests/setup/reset.js`. If a future test needs cleanup for another bucket, follow that pattern (top-level `list()` returns folder-shaped entries; recurse into each to get file paths).
- **DOM hooks added 2026-04-28 for stable Playwright selection** (no logic change, no semantic meaning beyond test infrastructure):
    - `BroilerTimelineView.jsx`: `data-gantt="1"` + `data-week-header="1"` + `data-iso={isoString}` + `data-today-line="1"` (shipped PM, A7).
    - `FuelReconcileView.jsx`: `data-month="YYYY-MM"` + `data-fuel-type="diesel|gasoline|def"` + `data-cell="purchased|consumed|variance"` on the 9 fuel-type cells per row, plus `data-variance-band="green|orange|red"` on the 3 variance cells (shipped late PM, A8b).
    - `HomeDashboard.jsx`: `data-attention-kind="overdue|fillup_streak|warranty"` + `data-equipment-slug="<slug>"` on each EQUIPMENT ATTENTION row (shipped late PM, A1 follow-up; reduced from 5 kinds to 3 in the 2026-04-28 eve hotfix when Ronnie clarified equipment is hour/km-based, not calendar-based).

    If a future refactor renames or removes these attributes, the corresponding Playwright spec breaks — search for `data-` in `tests/` before refactoring view files.
- **Vite dev-server cleanup race on consecutive `npm run test:e2e` runs.** With `reuseExistingServer: false` in `playwright.config.js`, the dev server takes a few seconds to release port 5173 between back-to-back invocations. A second `test:e2e` started immediately after the first finishes can hit a 20s `page.goto` timeout in `tests/setup/global.setup.js` because Vite hasn't fully bound 5173 yet. The race only affects local development cadence (one test run after another in quick succession); CI is unaffected because each workflow run gets a fresh runner. Workaround: wait 5-10 seconds between runs, or kill any zombie node process listening on 5173 before starting (`Get-NetTCPConnection -LocalPort 5173`). Not a test code issue.
- **Selector trap on labels with text-collision against table headers.** Both `<label>Subtotal</label>` (form field) and `<th>Subtotal</th>` (line items column header) appear in the FuelBillsView upload modal. A naive `:has(text="Subtotal", exact)` filter matches both, and `.last()` lands deep in the table. Anchor on the element name: `label:text-is("Subtotal")` instead. Same trap likely exists for any modal that has both a header form AND a table with overlapping column names.

---

# Part 2 — Design Decisions

Load-bearing choices with rationale and — where it matters — the alternatives that were rejected. Future sessions should not relitigate these without reading the "why" first.

## 2.1 Add Feed Webform (2026-04-12, shipped)

### What was decided

The Add Feed webform (route `/addfeed`) inserts a brand-new row into the appropriate `*_dailys` table with `source='add_feed_webform'`. It does **not** mutate any existing row. It does **not** merge. It does **not** check for collisions. It inserts a fresh row and walks away.

All 16+ feed-aggregation sites already use `.reduce((s,d) => s + (parseFloat(d.feed_lbs) || 0), 0)` over filtered row arrays. Multiple rows per batch+date are already normal. The new Add Feed row is automatically picked up by every existing total, average, cost-per-dozen, feed-per-hen, and dashboard tile, with zero changes to any calculation code.

Add Feed rows are visually badged in the three Reports lists (broiler / layer / pig) with a 🌾 icon when `source === 'add_feed_webform'`. A tri-state filter chip (All / Daily Reports / Add Feed) lives at the top of each list. Edit modals hide non-feed fields for Add Feed rows to prevent users from accidentally turning them into frankenrows.

### Why — rejected alternatives

We went through three rejected designs before landing here. Don't re-propose these:

**Rejected #1: Merge logic on the dailys row.** Original spec had Add Feed look up an existing dailys row for that batch+date, increment its `feed_lbs`, and handle feed_type collisions (insert new row if feed_type differs, update if same/empty). **Why rejected:** multiple daily reports per batch+date are normal — the existing webform just `.insert()`s a fresh row every submit, no upsert. So "find the existing row to mutate" has no unique answer when there are 2+ rows for the same batch+date. Mutating an arbitrary one, and then later editing the morning vs evening report, could overwrite or double-count. Brittle.

**Rejected #2: Separate `feed_edit_log` ledger table.** Parallel audit table with its own row per Add Feed submission, linked to the dailys row via `daily_report_id`. **Why rejected:** the "mutate the dailys row" half still had the multi-row problem. And once you stop mutating it, the ledger becomes redundant — the dailys row IS the audit trail, distinguished by `source`. The `feed_edit_log` table was created and then dropped during the design session. Do not reference it.

**Rejected #3: Dedicated Feed Log tab in each dailys view.** Initially planned as `Reports | Add Feed Log` tabs side by side. **Why rejected:** once Add Feed rows are just badged dailys rows, a separate tab is duplicate UI. A filter chip gives the same audit-scanning capability with one small UI control instead of a parallel tab + modal + list rendering.

### Why the chosen design wins

Zero changes to calculation infrastructure. No orphan handling (Add Feed always creates a complete row). No new tables. No new modals. No multi-row ambiguity. The editing constraints (lbs + feed_type only) are enforced via conditional rendering in the existing edit modal, ~5–10 lines per modal. Smallest footprint, maximum reuse.

### Verified facts (do not re-verify)

1. All feed-aggregation sites use `.reduce()` over filtered row arrays — none assume one row per batch+date. Verified via grep during the design session.
2. No code anywhere filters dailys rows by `source`. Adding the column is invisible to existing logic.
3. `source` column added to all three dailys tables (`layer_dailys`, `poultry_dailys`, `pig_dailys`) via `ALTER TABLE … ADD COLUMN IF NOT EXISTS source TEXT;`. Nullable, no default. Existing rows have null.
4. `pig_dailys` has **no `feed_type` column.** Add Feed inserts for pig must omit `feed_type` entirely — passing null fails because the column doesn't exist.

## 2.2 Cattle module (2026-04-15, shipped)

### Decision 1: Directory tab merged into Herds (no separate Directory)

**Decided:** 6 sub-tabs (Dashboard / Herds / Dailys / Weigh-Ins / Breeding / Batches) — no Directory. Herds combines per-herd-tile operational view AND flat searchable directory view.

**How it works:** Default = per-herd tiles for the 4 active herds, outcome herds (Processed / Deceased / Sold) collapsed at bottom. When the user types in search or picks a non-active status filter, the view switches to a flat sortable list across all matching cattle. Add / Edit / Transfer / Delete work in both modes.

**Why:** A separate Directory tab duplicates UI. The unique value of "Directory" was (1) cross-herd search, (2) flat sortable table, (3) outcome animals as first-class records — all achievable with a search box + status filter on top of Herds. One tab, less navigation, no confusion about "which tab do I edit a cow on."

### Decision 2: `is_creep` as a per-line flag on `cattle_dailys.feeds` (not a feed-input attribute, not a separate compound feed)

**Decided:** When a Mommas daily report includes creep-feed ingredients (alfalfa pellets, citrus pellets, sugar, colostrum supplement), each feed line can be flagged with an `is_creep` boolean. Creep lines are excluded from Mommas nutrition math (calves eat them, not the mommas) but included in cost totals. Stored inline in the `feeds` jsonb on each `cattle_dailys` row.

**Why:** Creep ingredients are NOT unique to creep — alfalfa pellets are also eaten by Bulls, citrus pellets also by Backgrounders/Finishers. So we can't tag the FEED itself as "exclude from nutrition." Tag the USAGE.

**Rejected: separate `cattle_creep_batches` table + standalone "Mix Creep Batch" form.** Rejected because Ronnie said "we don't need a creep feed standalone form, we just track ingredients and cost like everything else." Simpler = win.

**Rejected: `exclude_from_nutrition` boolean on `cattle_feed_inputs`.** Would mark alfalfa pellets as always-excluded — but then you can't feed them directly to bulls without it counting. Same ingredient, different usage. Per-line flag is the only model that works.

### Decision 3: Comments unified into one `cattle_comments` table with a `source` discriminator

**Decided:** All per-cow observations live in a single `cattle_comments` table. `source` distinguishes origin (`manual` / `weigh_in` / `daily_report` / `calving`). `reference_id` links back to the originating row when applicable. Cow profile shows a unified timeline.

**Why:** Observations naturally come from multiple sources — a weigh-in note, a calving observation, an ad-hoc field note. Unifying them means cow profiles show a single chronological timeline instead of stitching from `weigh_ins.note` + `cattle_calving_records.notes` + `cattle.notes`.

**Rejected: comment fields scattered across source tables** — would have required cow-profile views to query 4+ tables and merge client-side. Too much friction.

**Rejected: `cow.notes` as a single text field** — Ronnie wanted a date-stamped timeline, not a single editable blob.

### Decision 4: Snapshot nutrition onto `cattle_dailys.feeds` at submit time (not by-reference lookup)

**Decided:** Each feed line stores `nutrition_snapshot: {moisture_pct, nfc_pct, protein_pct}` captured at submit time. Editing the parent feed in admin does NOT rewrite historical reports.

**Why:** By-reference lookup means uploading a new test PDF for "Rye Baleage" would silently revise the calculated nutrition of every past daily report. Misleading — the cow ate the hay that was in the field at the time, not the hay's current spec.

### Decision 5: Cattle uses dedicated Supabase tables (not `app_store` jsonb)

**Decided:** All cattle data lives in dedicated tables. `app_store` is used only for legacy poultry/pig blobs.

**Why:** Matches the pattern used by `pig_dailys`, `layer_dailys`, `egg_dailys`, `poultry_dailys`, `layer_batches`, `layer_housings`. Dedicated tables have RLS policies, indexes, foreign keys, and SQL queryability. jsonb blobs are fine for a small handful of records but don't scale to 469+ cattle with weigh-ins and dailys.

### Decision 6: Delete Permanently (not Mark Inactive) for feed entries

**Decided:** Livestock Feed Inputs panel's edit modal has a "Delete Feed" button that permanently deletes the feed row + cascades to its tests + cleans up PDFs from storage. Historical `cattle_dailys` snapshots are preserved (nutrition is stored by-value per Decision 4).

**Why:** Ronnie asked for "I should be able to delete any feed tile." "Mark Inactive" was leftover from an earlier draft.

**Safety:** Cascade is intentional — `cattle_feed_tests.feed_input_id` has `ON DELETE CASCADE`. PDFs in storage are removed by app code (not Postgres cascade). Historical reports retain their snapshot values.

## 2.3 Supabase auth config

### `detectSessionInUrl: false` + `storageKey: 'farm-planner-auth'`

**Decided:** The Supabase client is initialized with `detectSessionInUrl: false` and `storageKey: 'farm-planner-auth'` in `src/lib/supabase.js`. `SetPasswordScreen` parses the recovery token from `window.location.hash` manually and calls `sb.auth.setSession(…)` itself.

**Why:** The default (`detectSessionInUrl: true`) makes supabase-js auto-consume the URL hash on client init — which races with React mount, can clear the hash before `SetPasswordScreen` sees it, and fights with `BrowserRouter`'s location parsing. Manual parsing is more verbose but puts ordering in our control.

**Why the custom storage key:** The default key (`sb-<project-ref>-auth-token`) changes if we ever migrate the Supabase project. Using a stable app-owned key means outstanding sessions survive a project-ref change.

**Don't change these** without a migration plan for currently-signed-in users (they'd lose their session on deploy).

## 2.4 Two-query `loadCattleWeighInsCached` (no `!inner` joins)

**Decided:** `src/lib/cattleCache.js` fetches weigh-in sessions first (IDs only), then `weigh_ins` via `.in('session_id', ids)`. Two round trips, not one.

**Why not a `!inner` join:** PostgREST's `!inner` emits a SQL inner join with subquery filters that, under our RLS policies + realistic row counts, generates query plans that time out or return incomplete result sets. The two-query pattern is explicitly safer. Verified during the original cattle build.

**Don't unify these into one PostgREST call** without rerunning the timing experiments from the April 16 cattle import session.

## 2.5 Vite migration — key decisions

### Feature-scoped Contexts over one god-Context or Zustand

**Decided:** 10 feature-scoped React Contexts — `AuthContext`, `BatchesContext`, `PigContext`, `LayerContext`, `DailysRecentContext`, `CattleHomeContext`, `SheepHomeContext`, `WebformsConfigContext`, `FeedCostsContext`, `UIContext`.

**Why:** One god-Context forces every consumer to re-render on every state change. Zustand is a fine library but introduces a dependency + mental model switch for zero incremental benefit over native React context. Feature scoping maps directly to the folder tree (each provider owns state for exactly one program/area) and the provider order in `main.jsx` makes dependency ordering explicit.

### BrowserRouter with a view↔URL adapter (not full `setView` → `useNavigate` migration)

**Decided:** Phase 3 wrapped the root in `<BrowserRouter>` and added two `useEffect`s inside `App` that mirror `view` state to `location.pathname`. Every existing `setView('X')` call site continues to work.

**Why:** A full migration would replace `setView('X')` with `useNavigate('/path')` at ~50 call sites across extracted views. Pure churn for idiomatic React Router — same user-visible outcome, same URLs, same back button. The adapter is a thin layer on top of a clean state machine; the state machine isn't a hack, it's a clean model that happens to mirror URLs now.

### Hook-based extraction with a systematic bare-name audit (not file-slice for every component)

**Decided:** Components with ≤100 lines of JSX that close over many App-scope names are extracted as hook-based components that consume their own contexts directly. Components that are pure JSX trees can be file-sliced. Every hook-based extraction runs through a bare-name audit before push.

**Why:** PowerShell file-slicing (the big-block cut-and-paste pattern from Phase 2 Rounds 1–5) is the right tool for components whose content never touches App's locals. Hook-based is the only option when the component reads 10+ pieces of shared state. Mixing the two approaches lets each component pick its lowest-risk path.

The bare-name audit (see §Part 3 "Lessons") caught zero misses in the Phase 2 finale sessions after one painful audit-less round produced 8 commits of runtime fixups.

### Hash-compat shim over user bookmark migration

**Decided:** `/#weighins`, `/#addfeed`, `/#webforms` bookmarks are rewritten to clean paths by a module-scope `history.replaceState` shim that runs before `root.render()`. Recovery hashes (`/#access_token=…&type=recovery`) are left intact.

**Why:** Users have those URLs printed on field materials, saved in Slack messages, and bookmarked in phones. A shim is invisible; a URL migration would silently 404 on every legacy bookmark until the user noticed and updated.

### Supabase password-recovery stays on hash (not `/reset?token=…`)

**Decided:** The Phase 3 plan originally called for switching `SetPasswordScreen` to read tokens from `/reset?token=…` as primary. **Skipped deliberately.**

**Why:** Auth tokens in URL query params end up in server logs, `Referer` headers, and browser history. Supabase's default hash-fragment format exists specifically to avoid those leaks. Moving them to query params is a security regression.

### What the migration deliberately did NOT do

- TypeScript conversion.
- Test suite (Vitest/Playwright).
- CSS framework (Tailwind etc.).
- Storybook.
- Service worker / offline app shell. PWA install entry points shipped later; no service worker exists yet.
- Splitting `app_store` jsonb blobs into dedicated tables.
- Bundle splitting beyond Vite's defaults.
- Any framework jump (Next.js, React Server Components).

Each can come later as its own initiative. Migration was purely toolchain + organization.

---

# Part 3 — History

## 3.1 Origin

WCF Planner started as a single `index.html` file serving the full app: ~19,445 lines of JSX inside a `<script type="text/jsx-source">` block, transpiled in the browser via Babel-standalone with a localStorage cache. React, ReactDOM, supabase-js, and xlsx were loaded from CDNs. No build step, no package.json, no `src/` tree. Deploy = commit `index.html` to GitHub, Netlify serves it.

The model held for months while features accumulated: broiler batch tracking, pig breeding + farrowing + feeder batches, layer housing, egg collection, public webforms with admin configuration, a cattle module (469 animals imported from Podio), a sheep module. By early April 2026, `index.html` was ~19k lines. Cold-load on mobile cellular ran Babel on every visit — ~2–3 seconds to interactive. A single accidental break could take the whole app down; there were no extraction boundaries.

## 3.2 Migration timeline (April 19–21, 2026 — ~4 calendar days, ~30 commits)

### Phase 1 — Vite scaffolding

Replace in-browser Babel with a proper Vite build. Same code, different toolchain.

- Moved the JSX source block verbatim into `src/main.jsx`. No logic changes. Replaced CDN `<script>` tags in `index.html` with `<script type="module" src="/src/main.jsx">`.
- Replaced `_wcfLoadXLSX` CDN fetch with `await import('xlsx')`. Same lazy-load contract.
- Deleted the `_wcfBabelCache` localStorage helper + eval bootstrap. Added a one-time `wcf-babel-*` purge to free ~600 KB per user.
- Added `public/_redirects` for Netlify SPA fallback.
- Build: `npm run build` → `dist/`. Netlify config: publish `dist/`, build command `npm run build`.
- Result: identical user experience, near-instant mobile cold load.

### Phase 2 — Component extraction (8 rounds)

Split the monolithic `src/main.jsx` into a feature-organized tree.

- **Round 0** — Extracted 10 feature-scoped Contexts (`AuthContext`, `BatchesContext`, `PigContext`, `LayerContext`, `DailysRecentContext`, `CattleHomeContext`, `SheepHomeContext`, `WebformsConfigContext`, `FeedCostsContext`, `UIContext`). App now wraps in a provider tree.
- **Rounds 1–5** — Leaf components + single-feature views + admin panels + public webforms. PowerShell file-slicing for big blocks that didn't close over App state. 30+ components moved.
- **Round 6** — Inline views inside App (the hard ones: `BroilerHomeView`, `BroilerListView`, `BroilerTimelineView`, `BroilerFeedView`, `BatchForm`, `PigsHomeView`, `BreedingView`, `FarrowingView`, `SowsView`, `PigBatchesView`, `PigFeedView`, plus `LayersHomeView`, `LayersView`, `LayerBatchesView`, and all cattle/sheep views). Hook-based extraction.
- **Round 7** — `HomeDashboard` (the biggest single extraction — ~540 lines reading every data context).
- **Round 8** — `EquipmentPlaceholder` stub.
- **Phase 2 cutover** — merge commit `9799960` to `main` on 2026-04-21. Ronnie's verdict: "everything looks good. Zero difference noticed actually."

End state: `src/main.jsx` 19,445 → ~2,000 lines of pure wiring.

### Phase 3 — URL routing

Add per-tab URLs + working browser back button via `react-router-dom@7`.

- Installed `react-router-dom`. Created `src/lib/routes.js` with `VIEW_TO_PATH`, `PATH_TO_VIEW`, `HASH_COMPAT` maps.
- Wrapped root in `<BrowserRouter>`. Added URL↔view adapter (two `useEffect`s with `syncingFromUrl` ref guard) inside `App`.
- Hash-compat shim at module scope, runs synchronously before `root.render()`. Rewrites `/#weighins`, `/#addfeed`, `/#webforms` to clean paths via `history.replaceState`. Recovery hash left alone.
- Polish: URLSync fallback preserves `location.hash` (protects password-recovery flow on mangled URLs). `UIContext.initialView()` reads pathname first — no LoginScreen flash on `/weighins` cold load.
- **Phase 3 cutover** — merge commit `7779750` to `main` on 2026-04-21. Ronnie's verdict: "Everything look great. We have 'urls' for each page and back button work."

### Post-migration polish

Four commits on a short-lived `polish` branch on 2026-04-21:

- `CATTLE_*` constants → `src/lib/cattle.js`. Fixed latent `ReferenceError` in `cattleBreeding.js` (had been using `CATTLE_*_DAYS` + `toISO` + `addDays` as bare refs with no imports).
- `detectConflicts` → `src/lib/conflicts.js`. Preserved `–` escape literals.
- `writeBroilerBatchAvg` → `src/lib/broiler.js`. Fixed second latent `ReferenceError` — `WeighInsWebform.jsx` + `LivestockWeighInsView.jsx` both called it with no import.
- `renderWebform` → `src/webforms/PigDailysWebform.jsx`. Moved 5 `wf*` state pieces into the new component as internal `useState`; dropped 10 unused props from `WebformsAdminView`.

Polish cutover: merge commit `8b3d1c0` to `main` on 2026-04-21.

## 3.3 Final numbers

| Metric | Pre-migration | Post-migration | Delta |
|---|---|---|---|
| `index.html` | 19,445 lines | ~30 lines | -99% |
| Main source file | — | `src/main.jsx` ~1,750 lines | — |
| Main source vs pre | `index.html` = 19,445 | main.jsx = 1,750 | **-91%** |
| Bundle size (gzipped) | Babel transpile every load | 308 KB + 143 KB lazy xlsx | — |
| Module count | 1 file | 162 modules | — |
| Extracted components | 0 | 54+ | — |
| Helper libs | inline | 14 in `src/lib/` | — |
| Contexts | 0 | 10 | — |
| URL support | hash-only | per-tab paths + working back button | — |
| Latent `ReferenceError` bugs caught along the way | — | 2 (in `cattleBreeding.js`, in 2 `writeBroilerBatchAvg` callers) | — |

## 3.4 Transferable lessons

These are session-independent patterns worth preserving for future Claude work on this codebase.

### The bare-name audit pattern (hook-based extractions)

Hook-based view extractions close over dozens of App-scope names. Missing a single one = runtime `ReferenceError` on first nav to that view. Builds pass silently; only the browser catches these. **Clean build is not proof of correctness.**

The cure: before pushing any hook-based extraction, run a systematic bare-name audit:

1. Parse the new file's imports + destructures + function params + local const/let/var + function declarations into a `known` set.
2. Scan every identifier-looking token in the body.
3. Strip comments + string literals + JSX text + property access (preceded by `.`) + object keys (followed by `:`) + JSX attributes (followed by `=`) + lowercase-HTML tag names.
4. Flag what's left.
5. Cross-check remaining suspects against every `lib/*` export, every context state name, and the App-helper blast list: `persist`, `del`, `confirmDelete`, `saveFeedCosts`, `loadUsers`, `refreshDailys`, `openEdit`, `submit`, `upd`, `closeForm`, `signOut`, `backupData`, `restoreData`, `sbSave`, `persistBreeding`, `persistFarrowing`, `persistFeeders`, `persistBreeders`, `persistBreedOptions`, `persistOriginOptions`, `persistWebforms`, `persistLayerGroups`, `persistLayerHousings`, `resolveSire`, `parseProcessorXlsx`.

A reference `tmp_audit.cjs` script was used during Phase 2 Round 6+ and the 2026-04-21 polish. It's dev-only — delete before push. Never commit it.

The pattern earned its keep: Phase 2 Round 6 had 8 fix-up commits before the audit was introduced. Round 6-tail, Round 7, Round 8, and the 2026-04-21 polish shipped with zero post-push `ReferenceError` fixups.

### The latent `ReferenceError` class of bug

Both `src/lib/cattleBreeding.js` (CATTLE_* constants + toISO + addDays) and `writeBroilerBatchAvg`'s callers (`WeighInsWebform.jsx` + `LivestockWeighInsView.jsx`) had bare-identifier references with no imports, apparently cold in production and therefore never caught. Vite doesn't error on unresolved identifiers at build time — only at runtime, and only when the specific call path executes.

**When doing any `src/lib/` lift, check every existing caller for an import statement.** Not having one isn't "don't need to add it" — it's "there's a latent bug here."

### PowerShell file-slicing (for big JSX blocks)

For components with minimal App-state coupling, byte-range slicing via PowerShell (`[System.Collections.ArrayList]::RemoveRange`) is faster and less error-prone than transcribing JSX through Read → Write. The file content never enters conversation context, so there's no drift.

Pattern: locate the target block's start + end line numbers (via Grep), verify the closing brace index, slice the byte range into the new file, remove from the source. Always verify with `npm run build` clean before commit.

### Module-scope synchronous shims run before React

For startup-order-sensitive work (hash-bookmark compat, the `wcf-babel-*` localStorage purge), module-scope code in `main.jsx` executes before `createRoot(…).render(…)`. This is the only safe place for logic that must happen before React's first render sees the URL or mutates the DOM.

### The `_wcfConfirmDelete` window escape hatch

App exposes `confirmDelete` as `window._wcfConfirmDelete` so deeply-nested components can trigger the confirmation modal without prop-drilling. Strict-mode-safe only if the consuming component has `confirmDelete` in scope — extracting a component that uses it as a bare identifier without making it a prop will crash (see the `LayerBatchesView` latent fix in Phase 2 Round 2 tail).

## 3.5 Backup paths still valid

- **Netlify UI → Deploys → "Publish deploy"** on any pre-incident build. Fastest rollback, ~60s to live.
- **`git revert -m 1 <merge-commit> && git push`.** Durable — preserves the incident commit in history.
- **`~/OneDrive/Desktop/WCF-planner-backups/index.html.pre-vite-2026-04-19`** (1.3 MB, blob SHA `e06c66df…`). Pre-migration single-file app. Nuclear option if git ever gets confused.

## 3.6 Stale branches (deleted post-cutover)

- `vite-migration` — Phase 2 work. Deleted 2026-04-21 session 3. Structurally merged via `9799960`.
- `phase-3-router` — Phase 3 work. Deleted 2026-04-21 session 3. Structurally merged via `7779750`.
- `polish` — 2026-04-21 polish + doc commits. Deleted same day. Structurally merged via `8b3d1c0`.

Only `main` remains (local + origin). All history preserved in merge commits on `main`.

---

# Part 4 — Session Index

One line per working session. Detail lives in git log (`git log --oneline --date=short`) and full per-session narratives in [`archive/SESSION_LOG.md`](archive/SESSION_LOG.md). The left column shows a representative commit SHA.

| Date | SHA (end) | Headline |
|---|---|---|
| 2026-04-12 | `021714b` | Initial setup: repo, Netlify auto-deploy, Add Feed Webform full feature build, pig feed planning tab, comprehensive PROJECT.md handover. |
| 2026-04-13 | `fbac585` | Feed tab overhaul — running ledger, order-timing model, suggested orders; pig/broiler feed inventory; breeding pigs redesign + farrowing cycle linkage. Three commits of feed-tab bugfixes. |
| 2026-04-14 | `85f17eb` | Program color palette applied across app (no purple); auto-generated pig breeding cycle labels; egg webform Group 1 bug fix; broiler feed projections updated from WCF historical data (`94f0d5e`); branded welcome/password-reset emails via Resend (`a7a9658`); B-24-02..B-25-01 migrated to FR breed. Cattle module Q&A captured. |
| 2026-04-15 | `5716420` | Cattle module Phase 1 build + Phase 2 (cattle/pig/broiler dailys) + Phase 3 Directory-merged-into-Herds. Admin feed inputs + test PDFs + cattle webforms + dailys view (`d8a4a67`, `be4525e`). Deployment SOP codified in docs. Two post-deploy hotfixes (`45756a5`, `05578a0`). |
| 2026-04-16 | `56bad15` | Cattle Podio data import: 469 cattle, 1,930 weigh-ins (`56bad15`), tag-swap history + New-Cow-vs-Replacement-Tag split (`6a40485`), per-schooner broiler weigh-in columns, admin tabs for broilers/pigs. |
| 2026-04-17 | `3874dca` | Cattle admin UX deep dive: weigh-in functionality, mortality fix, cattle batches + rolling nutrition panel (`618125c`), cow-detail polish + clickable lineage (`e8ca425`), Cost-by-Month tab + DM field (`bc2cc24`). |
| 2026-04-17 (eve) | `ac40fd8` | Cow detail: weight history polish + tag search + Prior Tags editor + on-the-spot retag flow. Six commits sitting unpushed at session end. |
| 2026-04-18 | (see archive) | Cattle bulk import tool (self-serve XLSX), auth hardening (SetPasswordScreen — invite + recovery), user management improvements, Sheep module Phase 1 (directory + flat/tile + add/edit/transfer + bulk import + dailys + weigh-ins). |
| 2026-04-19 | `6f15a29` | Vite migration plan drafted: goals, phased plan (Phases 1–3), risk register, don't-touch list, cutover checklist. Backup created. |
| 2026-04-20 (AM) | `67d2ae3` | Phase 1 preview verified. Phase 2 Round 0: all 10 Contexts extracted from App. |
| 2026-04-20 (PM) | `0f02b2c` | Phase 2 Rounds 1–5: leaf components + auth screens + single-feature dailys views + stateful views + admin panels + public webforms. PowerShell file-slicing pattern established. |
| 2026-04-20 (eve) | `7e9f999` | Phase 2 Round 6: all 12 inline views extracted. 8 commits of runtime ReferenceError fixups — the painful session that taught us to build the bare-name audit. |
| 2026-04-21 (AM) | `377211a` | Phase 2 finale: Round 6 tail (Header + BatchForm) + Round 7 (HomeDashboard) + Round 8 (EquipmentPlaceholder) + Round 2 tail (LayerBatchesView with latent-bug fix). Zero post-push fixups — the audit pattern earned its keep. |
| 2026-04-21 (midday) | `7779750` | Phase 2 cutover to production (`9799960`) + Phase 3 URL routing (3.1/3.2/3.3/polish) + Phase 3 cutover to production (`7779750`). Per-tab URLs + working back button live. |
| 2026-04-21 (eve) | `8b3d1c0` | Polish: CATTLE_* + detectConflicts + writeBroilerBatchAvg + renderWebform extractions. Two latent `ReferenceError` bugs caught and fixed. Polish cutover (`8b3d1c0`). |
| 2026-04-21 (wrap) | (this commit) | Doc consolidation: `archive/SESSION_LOG.md` frozen; `PROJECT.md` rewritten in 4 parts (Living Reference, Design Decisions, History, Session Index); `DECISIONS.md` + `MIGRATION_PLAN.md` to be deleted in the final commit. |
| 2026-04-21 (later) | (this commit) | Sheep Podio import: mig 009 (sheep module, never previously applied) + mig 010 (weigh_in_sessions.species CHECK extended with 'sheep') applied via SQL Editor; `scripts/import_sheep.cjs` landed 85 sheep (67 Podio + 18 new Willie Nisewonger lambs), 26 lambing records, 6 weigh-in sessions (34 weigh-ins), 639 sheep_dailys. Planner is now sole source of truth for sheep. |
| 2026-04-23 | `5cd306f` | **Equipment module v1.** Mig 016 created equipment/fueling/maintenance tables, storage, and the `equipment_tech` role; `import_equipment.cjs` seeded the initial Podio-derived fleet, service intervals, fill-up items, and fueling history. Shipped logged-in Fleet/detail/fuel-log surfaces plus public `/fueling` checklist routing; follow-up polish/import pitfalls are captured in §7 and later rows. |
| 2026-04-22 | `642137c` | Weigh-in UX, pig breeding/batches, broiler parser/costs, cattle inline edit, migration 014 transfer fields, and missed-daily filtering fixes. Durable contracts from this day live in §7; full operational narrative remains in git log/archive. |
| 2026-04-25 | `f9ce5be`..`1551e75` | Equipment service math overhaul, fuel-bill parser/reconciliation UI, team-member admin rebuild, and photo relink by `(equipment_id,date)`. §7 holds the lasting contracts for snap-to-nearest milestones, cumulative partials, tax allocation, read-fresh writes, and photo matching. |
| 2026-04-24 | `b00f36f`+ | Equipment data parity, admin equipment UX, fuel supply/fuel log foundations, manuals/documents buckets, and Podio import/patch scripts. Key rules preserved in §7: manuals vs documents, sold status, fuel_supplies semantics, every-use sentinel, external_id fallbacks, fuelings-only re-import, and Podio duplicate handling. |
| 2026-04-23 | `5cd306f`..`3d3d586` | **Equipment polish marathon.** Root-caused and fixed Podio deleted-field/option contamination across equipment webforms, rebuilt equipment import/patch scripts around the `status='deleted'` filter, and tightened interval/help-text seeding. The durable rules from this lane live in §7: Podio deleted filters, attachment checklist shape, every-use sentinel, external_id fallbacks, and fuelings-only re-import safety. |

| 2026-04-27 | (current) | Test-suite Phase 1 plus fuel-ops closeout: Vitest harness, equipment/date/routes tests, fuel-bill parser tests, real Home Oil PDF parser fixes, and the first reconciliation review. Follow-up contracts live in §7 and §8 Near-term. |

| 2026-04-27 (PM) | `1f7a299`..`a8c7133` | Pig accounting overhaul, cattle/sheep Send-to-Processor parity, and Pig FCR cache. Migs 027-029 added prior herd/flock, sheep processing batches, and sheep transfer audit logs; durable rules live in §7. |

| 2026-04-28 | `0ad8fc2`..`3234ff6` | Playwright A2/A4: isolated TEST Supabase harness, reset/bootstrap guards, global admin auth, and pig batch math regression coverage. Later rows carry the expanded Playwright suite. |

| 2026-04-28 PM | spec commits `e320237`..`d9fa8ba`; wrap docs in following commit | Playwright Phase 1 expanded from A5 through A8a: cattle processor, sheep processor, broiler timeline, pig FCR cache, and fuel PDF upload all shipped / pushed / deploy-verified. Current baseline: 34 e2e + 53 vitest green. A8b fuel reconciliation is next and plan-approved; A10 remains blocked by Initiative B. Durable gotchas added below. |

| 2026-04-28 (late PM) | `b2e2f13`..`0f57d47` | Playwright Phase 1 closed, ESLint/Prettier tooling landed, CI workflow added, and HomeDashboard equipment alerts gained focused coverage. CI secrets remain a Ronnie-owned setup item in §8. |
| 2026-04-28 (eve) | (this commit) | Feed physical count delivery-included flag for pig and poultry feed counts. The flag suppresses the count-month delivery from EOM math when the physical count already includes it; validation covered vitest/lint/build plus browser smoke. |

| 2026-04-28 (eve hotfix) | (this commit) | HomeDashboard equipment-attention noise removal: near-due and missed-fueling rows were removed so the dashboard shows actionable equipment rows only. Existing tests were flipped into negative locks. |

| 2026-04-28 (eve+) | `f3862d9`..(this commit) | Prettier go-live replayed after the dashboard hotfix: src, tests/configs/functions, and scripts were formatted, and CI gained `npm run format:check`. |

| 2026-04-28 (eve drift) | `2e02f81` | Read-only recon found public equipment fueling drift under anon RLS, and HomeDashboard adopted `latestSaneReading` as a read-side fallback. The root cause was later resolved by mig 047; see the 2026-05-07 row. |
| 2026-04-28 (eve queue) | `9e93e0a` | Initiative C Phase 1A DB-only queue/photo contracts: mig 030 added `client_submission_id` indexes and photo columns; mig 031 added the private `daily-photos` bucket and policies. Runtime queue/photo work shipped in later rows. |
| 2026-04-28 (eve wrap) | (this commit) | Docs wrap for the equipment drift + queue-schema session. Consolidated §7 contracts for daily photos, client submission ids, and RLS-disabled hand-created tables; later rows supersede the temporary follow-up roadmap items. |
| 2026-04-29 | `b5a07a9` + this wrap | Initiative C Phase 1B adapter foundation and FuelSupply offline canary: idempotent client ids, IndexedDB queue helpers, stuck-submission modal, PWA manifest/icons, and anon insert-plus-23505 dedup contract. Mig 030 was applied to prod; later rows carry the photo/RPC follow-through. |
| 2026-04-30 | `c619176`..`00754c3` | Initiative C Phase 1C-D/1D plus broiler weigh-in fixes: pig/broiler fresh draft weigh-ins moved through the RPC/offline queue, daily-report photo queue shipped for key forms, public broiler schooner metadata moved to `webform_config`, and admin broiler session metadata edits gained safe average recompute behavior. |
| 2026-05-01 | `4874f1d` + this wrap | Broiler reopen average cleanup plus Tasks Phase A. Migs 036-038 created task tables/RLS/private photo bucket; TEST recon was green and Phase B decisions were locked for cron/Vault/generation. |
| 2026-05-01 | `a44971a` + this wrap | **Tasks Module Phase B source + TEST verification.** Mig 039 and `tasks-cron` source shipped: task schema cleanup, recurrence expansion, pg_cron/pg_net/Vault integration, `invoke_tasks_cron`, and `generate_task_instances`. TEST deploy/recon/probes were green; PROD deployment was tracked separately and later superseded by the 2026-05-06 Tasks v1 closeout. |
| 2026-05-01 (PROD deploy) | (this wrap) | **Tasks Phase B PROD deploy + C1-C4 plan lock.** PROD Vault secrets, `tasks-cron` Edge Function, mig 039, cron schedule, and auth probes were applied/verified using psql + Supabase CLI. The same session locked the combined Tasks C1-C4 plan; those phases later shipped and are summarized in the 2026-05-06 row. |
| 2026-05-04 | `d2eccda`..`8cb0bdf` + this wrap | Cattle Forecast shipped and polished. Mig 043 added forecast settings/includes/hidden rows; mig 044 added calving automation. Follow-up commits tightened watchlist visibility, ADG, hidden projected weights, month tiles, actual-batch cow detail, date formatting, heifer eligibility, Herd sorting/filtering, and summary labels. |
| 2026-05-06 | `267e877`..`5c839e7` + this wrap | **Tasks v1 C1-C4 closed; broiler/cattle hotfixes captured.** Admin Tasks Center, `/my-tasks`, public `/dailys/tasks` (then `/webforms/tasks` before the URL rename), request photos, daily generation, weekly summaries, and migs 040-046 all shipped after TEST/PROD probes. Broiler hatch-date activation and cattle heifer-inclusion copy also landed; this docs wrap removed shipped Tasks/Cattle/Broiler work from future-build scope. |
| 2026-05-07 | `0e66274`..`97bdb6b` + this wrap | **Equipment fueling RPC, pig weigh-in all-entries hotfix, and equipment rolling materials.** `0e66274` shipped mig 047 `submit_equipment_fueling(parent_in jsonb)`: public `/equipment/<slug>` fueling now inserts the fueling row and bumps `equipment.current_hours/current_km` atomically through a SECURITY DEFINER RPC, with idempotency by `client_submission_id` and a one-shot active-equipment reconciliation. `c4abc06` fixed pig public weigh-ins so the current session renders all entries, not only the latest 10; static + Playwright locks assert a 12-entry session keeps #1 and #12 visible. `97bdb6b` shipped mig 048 equipment materials: authenticated-only `equipment_service_materials` + `equipment_material_clears`, curated seed list, `/fleet/materials`, admin-home Materials Needed card, and per-equipment admin Materials editor. This wrap removes Equipment Material List and Equipment Reading Reconciliation from future-build lists, adds the new §7 contracts, and updates migrations/routes/schema/current-state notes through mig 048. |
| 2026-05-07 (later) | `3e28284`..`2a04c1f` + this wrap | **HomeDashboard alert specs, HO.md SOP nuance, and per-view state internalization lane.** `3e28284` locked HomeDashboard alert priority order (overdue → fillup_streak → warranty) and added an auto-clear spec via the anon `submit_equipment_fueling` RPC + page reload; new `seedHomeDashboardEquipmentMix` sibling seed helper. `d0ebec4` added the HO.md rule that copyable `From CC:` / `From Codex:` handoff blocks stay plain text (no Markdown backticks around paths/names/commands). `501e702`..`b02730f` (six commits) internalized 19 of the 31 App-body `useState` hooks across SowsView, PigBatchesView, PigFeedView, BroilerFeedView, and WebformsAdminView. `b7b51e0` + `2a04c1f` cleaned up dead/write-only state: editDailyId, dailyForm, dailysFilter, pigNotes, layerNotes, broilerNotes, wfView, showDailyForm, EMPTY_DAILY, plus related no-op setter calls and three app_store loader writes. Lint warnings 746 → 734 with zero new warnings. Hooks intentionally left in App: feedOrders, pigFeedInventory, poultryFeedInventory, collapsedBatches, collapsedMonths, adminTab. Smoke-gate rule refined during the lane: skippable for pure single-view UI relocation when handlers/save logic and saved-data ownership are unchanged, bare-name audit is clean, and validation floor is green; required for state that becomes a submitted operational record, public payload, localStorage-backed state, URL-persisted state, shared cross-view state, or handler/render branch changes. |

**How to use this index:** if you need the exact commit message or a specific bugfix commit, run `git log --oneline <date>..` or filter by filename. If you need the narrator's-voice session-end summary, see the matching block in `archive/SESSION_LOG.md`. Git log is the authoritative timeline — this table is just the map.
