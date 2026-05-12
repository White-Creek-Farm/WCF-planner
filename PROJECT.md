# WCF Planner

**Farm-management web app for White Creek Farm.** Production is a React/Vite SPA backed by Supabase and deployed from GitHub branch `main` through Netlify.

Live URL: https://wcfplanner.com

Last updated: 2026-05-09

This file is the project-specific source of truth: current build state, architecture, routes, data contracts, domain rules, and active roadmap. Workflow SOP, gate rules, validation requirements, and prompt relay rules live in [HO.md](HO.md). Session narratives live in git log and [archive/SESSION_LOG.md](archive/SESSION_LOG.md).

---

## Start Here

Use this order when opening the repo cold:

1. Read **Current Build State** to know what is shipped.
2. Check **Active Roadmap** for the next lane.
3. Use **Routes**, **Key Files**, and **Persistence** to find the owning surface.
4. Read **Load-Bearing Contracts** before touching related code.
5. Follow [HO.md](HO.md) for validation, commit, push, deploy, and CC/Codex handoff rules.

---

## Current Build State

### Shipped

| Area | Current state |
|---|---|
| Core app | Vite + React 18 SPA, BrowserRouter with view-to-URL adapter, Netlify production from `main`. |
| Public webforms | `/dailys`, `/addfeed`, `/weighins`, `/equipment`, `/equipment/supply`, `/dailys/tasks`. Legacy aliases remain. |
| Logged-in equipment | `/fleet`, `/fleet/<slug>`, `/fleet/fuel-log`, `/fleet/materials`. Public `/equipment/<slug>` is not a logged-in fleet route. |
| Tasks v2 | T1-T11 complete and deployed. `/tasks` is canonical. `/my-tasks` and `/admin/tasks` redirect to `/tasks`. Header has the single Tasks destination. Weekly digest uses the v2 template and shared cron-secret rapid-processor auth. |
| Task assignees | Task Center mutation dropdowns use `tasks_public_assignee_availability`. Hidden profiles are excluded from New Task/Reassign/Recurring/System Rule modals. Read-only history/group labels still display hidden or inactive names when already assigned. |
| Header | Dark bar groups Dailys + Equipment under "Webforms"; Equipment routes to public `/equipment`. Tasks is visually separated from webform links. |
| Planner icons | `public/icons/planner/*.png` supplies program/action/equipment icons. Use `PlannerIcon`, `PlannerIconLabel`, and `plannerIconUrl`; do not reference the OneDrive source folder in app code. |
| Pig planned trips | `/pig/batches` supports admin/management add/delete/move/date-step planned trips. `/pig/weighins` send-to-processor flow targets planned trips and reconciles exact, under-pull, residual, and over-pull cases. Farm team is read-only on planned/processing trip mutations. |
| Pig processor controls | Completed pig weigh-in sessions still expose processor-send controls for authorized users when unsent entries exist. |
| Layer dashboard | Main layer dashboard shows lifetime active-batch cost metrics. Rolling 30/90/120 windows and lbs/doz were removed from that dashboard. Layer group/batch detail views keep their own existing metrics. |
| Equipment admin | Equipment checklist/materials text edits preserve focus and do not reload/reorder the screen on every textbox click. Drag reorder and checklist rows remain stable. |
| Feed planner math | `src/lib/feedPlanner.js` landed as pure helper/test foundation. It is not yet wired into `/pig/feed` or `/broiler/feed` UI. |

### Active Roadmap

1. **Feed order board UI** for `/pig/feed` and `/broiler/feed`.
   - Goal: answer "How much feed do I need to order?"
   - Use `src/lib/feedPlanner.js`.
   - Snapshot-anchored counts, stale-count warning at 21 days, 7-day lead time, 30-day reserve, round suggested orders up to nearest 50 lb.
   - No planning-month/cycle picker.
   - "Use suggested" writes to the current calendar month in `ppp-feed-orders-v1`.
   - Existing retro/backfill monthly order entry must remain in a collapsed ledger.

2. **Remove operator-facing `includesCurrentMonthDelivery`** after the snapshot order board covers the old cases.
   - Keep helpers tolerant of legacy rows.
   - Separate commit so old-data regressions are bisectable.

3. **CI Actions secrets** remain a repo-admin task.
   - Required secrets are listed in [HO.md](HO.md).
   - Without them, Playwright e2e in GitHub Actions fails at the test-database guard.

---

## Infrastructure

| Item | Value |
|---|---|
| Repo | https://github.com/byronronniejones-lab/WCF-planner |
| Production | https://wcfplanner.com |
| Netlify alias | https://cheerful-narwhal-1e39f5.netlify.app |
| Supabase project URL | https://pzfujbjtayhkdlxiblwe.supabase.co |
| Supabase client | `src/lib/supabase.js` |
| Supabase auth config | `detectSessionInUrl:false`, `storageKey:'farm-planner-auth'` |
| Edge functions | `tasks-cron`, `tasks-summary`, `rapid-processor` |
| Canonical rapid-processor source | `supabase-functions/rapid-processor.ts`; stage under `supabase/functions/rapid-processor/index.ts` only for deploy |
| Farm location | Lat `30.84175647927683`, lon `-86.43686683451689` |

### Stack

- React 18, Vite 5, React Router 7.
- Supabase JS v2.
- Inline React styles plus small scoped CSS in `index.html`.
- No TypeScript and no CSS framework.
- Quality tools: `format:check`, `lint`, `vitest`, `build`, Playwright.
- `xlsx` is lazy-loaded through `window._wcfLoadXLSX`.

---

## Roles And Permissions

| Role | General capability |
|---|---|
| `farm_team` | Read most assigned program surfaces; edit/delete own daily reports only; read-only for pig planned/processing trip mutations. |
| `management` | Edit operational records; delete daily reports; can mutate pig planned/processing trip surfaces. |
| `admin` | Full app access; deletes, admin panels, Tasks system/admin controls, user management. |
| `inactive` | Not an eligible active user. |

Per-program access uses `profiles.program_access`. Null/empty means all programs. Admins always bypass program restrictions.

Known admin profiles in production:

| Person | Profile/email note |
|---|---|
| Ronnie | `ronnie@whitecreek.farm` is the admin profile. |
| Isabel | `isabel@sonnysfarm.com` is an admin profile. |
| Mak | Management. |
| Simon | Farm team. |

Do not treat `byronronniejones@gmail.com` as the Ronnie admin profile for Tasks assignee logic. It has been used as an inbox/test address and should not bypass the profile/availability rules.

---

## Routes

### Authenticated

| Path | Surface |
|---|---|
| `/` | Home dashboard |
| `/broiler`, `/broiler/timeline`, `/broiler/batches`, `/broiler/feed`, `/broiler/dailys`, `/broiler/weighins` | Broiler |
| `/pig`, `/pig/breeding`, `/pig/farrowing`, `/pig/sows`, `/pig/batches`, `/pig/feed`, `/pig/dailys`, `/pig/weighins` | Pig |
| `/layer`, `/layer/groups`, `/layer/batches`, `/layer/dailys`, `/layer/eggs` | Layers and eggs |
| `/cattle`, `/cattle/herds`, `/cattle/forecast`, `/cattle/breeding`, `/cattle/batches`, `/cattle/dailys`, `/cattle/weighins` | Cattle |
| `/sheep`, `/sheep/flocks`, `/sheep/batches`, `/sheep/dailys`, `/sheep/weighins` | Sheep |
| `/fleet`, `/fleet/<slug>`, `/fleet/fuel-log`, `/fleet/materials` | Logged-in equipment |
| `/admin` | Admin webforms/feed/fuel/equipment configuration |
| `/tasks` | Tasks v2 Task Center |

### Public, No Auth

| Path | Surface |
|---|---|
| `/dailys` | Public webform hub |
| `/dailys/<form>` | Public daily-report form |
| `/dailys/tasks` | Public task request form |
| `/addfeed` | Public Add Feed form |
| `/weighins` | Public weigh-ins form |
| `/equipment` | Public equipment/fueling hub |
| `/equipment/<slug>` | Public per-piece equipment checklist/fueling form |
| `/equipment/supply`, `/fuel-supply` | Public fuel supply form |
| `/webform-pigs` | Legacy standalone pig dailys form |

### Aliases

Defined in `src/lib/routes.js`.

| Legacy path | Canonical path |
|---|---|
| `/webforms*` | `/dailys*` |
| `/fueling*` | `/equipment*` |
| `/equipment/fleet` | `/fleet` |
| `/equipment/fuel-log` | `/fleet/fuel-log` |
| `/my-tasks` | `/tasks` |
| `/admin/tasks` | `/tasks` |

Do not alias `/equipment/<slug>` to `/fleet/<slug>`. It is now the public equipment checklist route.

---

## Key Files

### App Shell

| File | Purpose |
|---|---|
| `src/main.jsx` | Provider tree, URL adapter, view dispatch, app-level persistence helpers. |
| `src/lib/routes.js` | View-to-path map, hash compatibility, legacy aliases. |
| `src/shared/Header.jsx` | Dark top bar, public webform group, Tasks button/badge, burger menu. |
| `src/lib/supabase.js` | Supabase client and auth storage config. |

### Feature Views

| Directory | Surface |
|---|---|
| `src/tasks/` | Tasks v2 Task Center, tabs, modals, lightbox. |
| `src/pig/` | Pig home, breeding, farrowing, sows, batches, feed, dailys. |
| `src/broiler/` | Broiler home, timeline, batches, feed, dailys, weigh-ins. |
| `src/layer/` | Layer home, groups, batches, dailys, eggs. |
| `src/cattle/` | Cattle home, herds, forecast, breeding, batches, dailys, weigh-ins. |
| `src/sheep/` | Sheep home, flocks, batches, dailys, weigh-ins. |
| `src/livestock/` | Shared broiler/pig weigh-in admin view and pig send-to-trip modal. |
| `src/equipment/` | Fleet, detail, fuel log, materials checklist, maintenance/document surfaces. |
| `src/webforms/` | Public webforms and Webforms admin config. |
| `src/dashboard/` | Home dashboard. |

### Core Helpers

| File | Purpose |
|---|---|
| `src/lib/feedPlanner.js` | Snapshot-anchored feed order math; pure helper for next feed UI lane. |
| `src/lib/pigForecast.js` | Pig planned-trip projection/add/delete/move/send reconciliation helpers. |
| `src/lib/pig.js` | Pig breeding timeline, slug, transfer/mortality/trip ledger helpers. |
| `src/lib/broiler.js` | Broiler/layer schedules, feed projection, status/timeline helpers. |
| `src/lib/layerHousing.js` | Layer housing anchor and projected count math. |
| `src/lib/tasksCenterApi.js` | Read helpers for `/tasks`, including assignable-profile filtering. |
| `src/lib/tasksCenterMutationsApi.js` | Tasks v2 mutation/storage/signed-url wrappers. |
| `src/lib/tasks.js` | Pure task constants, recurrence labels, storage path helpers, public assignee availability key. |
| `src/lib/tasksRecurrence.js` | Shared recurrence math mirrored by `tasks-cron`. |
| `src/lib/equipment.js` | Equipment category metadata and service interval math. |
| `src/lib/equipmentMaterials.js` | Rolling material checklist sidecar math. |
| `src/lib/plannerIcons.js` | Stable planner icon registry and URL resolver. |
| `src/components/PlannerIcon.jsx` | Shared planner PNG icon component. |
| `src/lib/pagination.js` | Supabase `.range()` pagination helper. |
| `src/lib/cattleCache.js` | Two-query cattle weigh-in cache. |
| `src/lib/clientSubmissionId.js` | Stable client submission IDs for idempotent RPC/webform writes. |
| `src/lib/offline*.js`, `src/lib/useOffline*.js` | Offline queue registries and hooks for public forms. |

---

## Persistence

### Supabase Tables

| Table/group | Purpose |
|---|---|
| `profiles` | Users, roles, program access. Hand-created prod table, no migration owns the initial create. |
| `app_store` | JSON blob store for most non-daily structured app data. Hand-created prod table. |
| `webform_config` | Public form config and availability. Hand-created prod table. |
| `poultry_dailys`, `layer_dailys`, `egg_dailys`, `pig_dailys` | Daily reports. Hand-created prod tables. `pig_dailys` has no `feed_type` column. |
| `layer_batches`, `layer_housings` | Layer batch/housing model. Hand-created prod tables. |
| `weigh_in_sessions`, `weigh_ins` | Shared weigh-ins for cattle, sheep, pig, broiler. |
| `cattle*` | Cattle module tables, comments, forecast, processing, feed tests/inputs. |
| `sheep`, `sheep_lambing_records`, `sheep_processing_batches`, `sheep_transfers` | Sheep module. |
| `equipment*`, `fuel_supplies`, `fuel_bills`, `fuel_bill_lines`, `equipment_service_materials`, `equipment_material_clears` | Equipment, fuel, bills, materials. |
| `task_templates`, `task_instances`, `task_cron_runs`, `task_summary_runs` | Tasks base, cron, summary audit. |
| `task_instance_due_date_edits`, `task_instance_photos`, `task_system_rules` | Tasks v2 audit/photo/system-rule sidecars. |

Nine prod tables are hand-created and must be seeded in test bootstrap before migrations that alter them: `profiles`, `app_store`, `webform_config`, `poultry_dailys`, `layer_dailys`, `egg_dailys`, `pig_dailys`, `layer_batches`, `layer_housings`.

### App Store Keys

| Key | Contents |
|---|---|
| `ppp-v4` | Broiler batches. |
| `ppp-feeders-v1` | Pig feeder groups, sub-batches, planned trips, processing trips. |
| `ppp-pigs-v1` | Pig sow/boar count data. |
| `ppp-breeding-v1` | Pig breeding cycles. |
| `ppp-farrowing-v1` | Farrowing records. |
| `ppp-breeders-v1` | Breeding pig registry and transferred-to-breeding audit records. |
| `ppp-boars-v1`, `ppp-breed-options-v1`, `ppp-origin-options-v1` | Pig option maps. |
| `ppp-feed-costs-v1` | Feed cost rates. |
| `ppp-feed-orders-v1` | Feed orders by feed type and calendar month. |
| `ppp-pig-feed-inventory-v1` | Pig physical feed count snapshot. |
| `ppp-poultry-feed-inventory-v1` | Poultry physical feed count snapshots by starter/grower/layerfeed. |
| `ppp-pig-global-adg-v1` | Pig planned-trip global ADG control. |
| `ppp-missed-cleared-v1` | Cleared missed-report alerts. |
| `ppp-webforms-v1` | Webform configuration mirror. |

### Webform Config Keys

| Key | Contents |
|---|---|
| `team_roster` | Canonical public team roster. |
| `team_members` | Legacy all-names mirror. |
| `team_availability` | Per-public-form hidden roster IDs. |
| `tasks_public_assignee_availability` | Hidden task-assignee profile IDs for public/Task Center assignment surfaces. |
| `full_config`, `webform_settings`, `housing_batch_map`, `broiler_groups`, `broiler_batch_meta`, `active_groups`, `layer_groups` | Public webform support data. |

### Storage Buckets

| Bucket | Purpose |
|---|---|
| `batch-documents` | Broiler batch attachments. |
| `equipment-maintenance-docs` | Equipment manuals, documents, fueling photos. |
| `fuel-bills` | Private fuel bill PDFs; access by signed URL. |
| `daily-photos` | Daily report photos. |
| `task-photos` | Private task completion photos. |
| `task-request-photos` | Private task request/creation photos. |

---

## Domain State

### Feed Planning

Current UI:

- `/pig/feed` and `/broiler/feed` still use the legacy feed tabs.
- `src/lib/feedPlanner.js` is the new pure math foundation and is covered by unit tests.

New helper contracts:

- `LEAD_TIME_DAYS = 7`.
- `RESERVE_DAYS = {default: 30}`.
- `ORDER_ROUNDING_LBS = 50`.
- `STALE_SNAPSHOT_DAYS = 21`.
- Feed types: `pig`, `starter`, `grower`, `layerfeed`.
- Days of runway walks forward day-by-day; never use `onHand / todayBurn`.
- Snapshot counts are anchors: today's on-hand = snapshot lbs minus consumption since snapshot date.
- Pig feeder count is ledger-derived through pig helpers, not persisted `currentCount`.
- Poultry projection uses existing broiler/layer schedule helpers: `getFeedSchedule`, `LAYER_FEED_SCHEDULE`, `LAYER_FEED_PER_DAY`, `computeProjectedCount`.

Next UI lane:

- Put the order answer first.
- No planning cycle picker.
- No-snapshot values must look visually estimated and prompt for a count.
- Stale snapshots show a recount warning after 21 days.
- Suggested orders commit to the current calendar month in `ppp-feed-orders-v1`.
- Keep the monthly ledger/backfill inputs in a collapsed drill-down.

### Tasks v2

Tasks v2 is complete and canonical at `/tasks`.

Functional surfaces:

- Header Tasks button and due/past-due badge for the logged-in user.
- My Tasks tab: own open tasks plus grouped visible open tasks.
- Recurring tab: template groups, admin CRUD.
- Completed tab: completed rows, notes, assignee/completed-by names, photo lightbox.
- System Tasks tab: admin-only view of built-in system rules, admin rule edits.
- New Task modal, Complete Task modal, due-date edit modal, assign/delete modals.
- Photo sidecar lightbox with signed URLs.
- Weekly digest rebranded to Tasks v2 and verified in production.

Mutation paths:

- Use v2 SECDEF RPC wrappers from `tasksCenterMutationsApi.js`.
- Do not directly update `task_instances` from UI code.
- Do not call `generate_system_task_instance` from frontend code.
- Task-assignee mutation dropdowns use `loadTaskAssignableProfilesById`.
- Read-only display maps may use the unfiltered eligible-profile map so stranded historical assignments still render by name.

Routes:

- `/tasks` is canonical.
- `/my-tasks` and `/admin/tasks` are aliases only.
- Deleted legacy components should not be reintroduced.

### Pig

Core model:

- Feeder group started counts are authoritative.
- Sub-batches partition parent gilt/boar counts and are single-sex.
- Current count is ledger-derived: started minus processing-trip sub-attributions, breeding transfers, and mortality.
- Processing trips originate from weigh-ins via Send-to-Processor.
- `processingTrips[].subAttributions` must be stamped as `{subId, subBatchName, sex, count}`.

Planned trips:

- Persisted planned-trip shape is exactly `{id, date, sex, subBatchId, plannedCount, order}`.
- Derived projection/warning/ready fields are not persisted.
- Admin/management can add, delete, move counts, and date-step planned trips.
- Delete reconciles count to next trip, falling back to previous.
- Move forward moves the lightest pig from current to next; move back moves the heaviest pig from current to previous.
- First trip cannot move backward; last trip cannot move forward; middle trips can move either way.
- `/pig/weighins` sends selected pigs to the next planned trip in that chain and reconciles exact, under-pull, residual, over-pull, and exhausted-chain cases.

Slug rule:

- Always use `pigSlug` for sub-batch matching. Do not hand-type dashed variants such as `p-26-01-a`.

### Broiler And Layers

Broiler:

- Batches live in `ppp-v4`.
- Feed schedules live in `src/lib/broiler.js`.
- Week 4/6 weigh-ins write averages back to batch records when sessions complete.
- `broiler_batch_meta` is the public weigh-in source; public forms must not read `app_store.ppp-v4`.

Layers:

- `layer_batches` and `layer_housings` are the current layer model.
- `current_count` is a physical anchor; projected count subtracts mortalities since anchor.
- Main Layer dashboard now shows lifetime active-batch cost metrics only.
- Do not duplicate the same metric block when a batch has only one housing.

### Cattle

- Dedicated Supabase tables, not `app_store`.
- Herds: `mommas`, `backgrounders`, `finishers`, `bulls`; outcomes: `processed`, `deceased`, `sold`.
- Cattle processing batch workflow: Planned (virtual forecast) → Scheduled (`status='scheduled'`, processor date booked, cattle remain forecast-eligible) → Active (Send-to-Processor promotes or creates) → Processed (UI label; storage value stays `status='complete'`).
- Scheduled batches never update `cattle.herd` or `cattle.processing_batch_id` — cattle move only when Send-to-Processor flips a row to `active`. Migration 054 added `'scheduled'` to the status CHECK alongside `'active'` and `'complete'`.
- Cattle processing batches enter `active` either by Send-to-Processor promoting a matching scheduled row OR creating a fresh active row when no scheduled match exists. UI surfaces "Processed" for `status='complete'` rows — DB value is unchanged so RPC + JS comparisons stay stable.
- `loadCattleWeighInsCached` uses the two-query pattern. No `!inner` join rewrite.
- Old tag source strings are load-bearing: `import`, `weigh_in`, `manual`.

### Sheep

- Dedicated sheep tables plus shared weigh-in tables.
- Flocks: `rams`, `ewes`, `feeders`; outcomes: `processed`, `deceased`, `sold`.
- Sheep processing mirrors cattle but has looser Send-to-Processor gating: draft sessions from any flock.

### Equipment And Fuel

- Logged-in Equipment lives under `/fleet`.
- Public equipment/fueling lives under `/equipment`.
- Fuel supplied to farm is `fuel_supplies`; fuel consumed by equipment is `equipment_fuelings`.
- Public fueling uses `submit_equipment_fueling` RPC to insert fueling and bump current reading atomically.
- Materials checklist data lives in `equipment_service_materials` and `equipment_material_clears`.
- Equipment admin checklist/material textboxes must be one-click editable with no reload/focus loss/list reorder.

---

## Load-Bearing Contracts

Read this section before editing related files.

### Cross-App

- Do not change Supabase auth config in `src/lib/supabase.js` without a migration plan.
- Keep `wcfSelectAll` pagination pattern. `.limit()` silently caps at 1000.
- Keep BrowserRouter view-to-URL adapter unless doing a planned full router migration.
- Keep `\u` JSX escape literals where they already exist.
- Do not introduce `window.confirm`, `window.alert`, or `window.prompt` for destructive flows; use typed confirmation modals.
- Use `DeleteModal` for deletes.
- Public forms must keep no-auth access where documented.
- Netlify redirect order matters: `equipment.html` rules before SPA fallback.

### Supabase And Storage

- Never delete directly from `storage.objects`; use Storage API list/remove recursion.
- Private buckets must be read through signed URLs.
- Task photo uploads are append-only (`upsert:false`), and duplicate object errors are retry success.
- No migrations, RLS, Vault, or Edge Function deploys without explicit gates from Ronnie.

### Tasks

- Task Center writes go through v2 wrappers/RPCs only.
- Do not directly write task sidecar tables from the frontend.
- `task_instance_photos` is canonical; legacy single-path columns are compatibility display fallback.
- Header badge must soft-fail to zero and never break Header rendering.
- Task Center assignee dropdowns must respect `tasks_public_assignee_availability` and fail closed on config read errors.
- System task generation stays in cron/Edge Function flow, not frontend.

### Pig

- Planned trips persist exactly six keys: `id`, `date`, `sex`, `subBatchId`, `plannedCount`, `order`.
- `ppp-feeders-v1` remains the planned/processing trip persistence key.
- `ppp-pig-global-adg-v1` shape remains `{manualValue, updatedAt, updatedBy}`.
- `processingTrips[].subAttributions` is required for attribution-aware ledger math.
- `weigh_ins.sent_to_trip_id` and `sent_to_group_id` must be stamped on processor send.
- Farm team cannot mutate planned/processing trip state.

### Feed

- New feed order logic must use `feedPlanner.js`, not rebuild separate math inside views.
- Pig count derives from ledger helpers, not stored/current UI fields.
- Poultry burn must stay tied to existing broiler/layer schedule helpers.
- Snapshot rows may carry legacy flags; helpers tolerate them but UI should move away from them.

### Equipment

- Public `/equipment/<slug>` remains public checklist/fueling; logged-in detail is `/fleet/<slug>`.
- Equipment admin text inputs must not reload the screen, lose cursor focus, or reorder list items on click/edit.
- Rolling materials clears are bucketed by due service cycle; do not collapse them into a single permanent hide flag.

### Icons

- Use `public/icons/planner` through `PlannerIcon`/`plannerIconUrl`.
- App code must not reference `C:\Users\Ronni\OneDrive\Desktop\planner pics`.
- Do not put images inside `<option>` elements; use text fallback there.

---

## Validation

Use [HO.md](HO.md) for the required floor and gate sequence. Common commands:

```bash
npm run format:check
npm run lint
npm test
npm run build
npm run test:e2e
```

Focused examples:

```bash
npx vitest run src/lib/feedPlanner.test.js
npx playwright test tests/pig_send_to_planned_trip.spec.js
npx playwright test tests/tasks_v2_t8_t9_admin_controls.spec.js
```

Current lint baseline is warnings-only. Do not add errors. When changing a lane, touched files should be warning-clean unless the repo has an established JSX false-positive pattern with an inline rationale.

---

## Testing Map

| Area | Good starting tests |
|---|---|
| Routes/aliases | `src/lib/routes.test.js`, `tests/url_alias_redirects.spec.js` |
| Tasks v2 | `tests/static/tasks_v2_route_wiring.test.js`, `tests/tasks_v2_*.spec.js`, `src/lib/tasksCenterApi.test.js` |
| Feed planner | `src/lib/feedPlanner.test.js` |
| Pig planned trips/send | `src/lib/pigForecast.test.js`, `tests/pig_batches_planned_trips.spec.js`, `tests/pig_send_to_planned_trip.spec.js`, `tests/pig_batch_math.spec.js` |
| Equipment | `tests/equipment_fueling_rpc.spec.js`, `tests/equipment_materials.spec.js`, `tests/home_dashboard_equipment.spec.js`, `tests/static/equipment_materials.test.js` |
| Layer dashboard | `tests/static/layer_dashboard_static.test.js` |
| Broiler | `tests/broiler_timeline.spec.js`, `tests/broiler_weigh_in_schooners.spec.js`, `src/lib/broiler.test.js` |
| Cattle | `tests/cattle_*.spec.js`, `src/lib/cattleForecast.test.js` |
| Sheep | `tests/sheep_send_to_processor.spec.js` |
| Offline/public forms | `tests/offline_*.spec.js`, `tests/team_availability.spec.js`, `tests/daily_report_photos.spec.js` |

---

## Recent Milestones

| Commit | Summary |
|---|---|
| `7e50211` | Feed planner pure math helper and tests. |
| `226c039` | Layer active-batch lifetime metrics. |
| `8cef90e` | Pig planned-trip autosave date steppers. |
| `57fd7b7` | Equipment checklist row/focus stability. |
| `d7c522d` | Planner-wide PNG icon set. |
| `5cd008a` | Restored pig processor-send controls on completed weigh-ins. |
| `2bf38ef` | Header webforms grouping, Equipment label, Tasks divider, task-assignee availability mapping, larger task photo icons. |
| `be57d89` | Pig planned processing trips manual add/delete/move and planned-trip-driven send flow. |
| `4e04132` | Tasks digest shared cron-secret auth. |
| `102aa5b` | Tasks T10/T11 route retirement and digest rebrand. |
| `53831e7` | Tasks T8/T9 due-date edits, assign/delete, recurring/system admin. |
| `a2052ce` | Tasks T6/T7 New Task, Complete Task, photo lightbox. |
| `c25f61b` | Tasks T5 System Tasks tab. |
| `e7c9650` | Tasks T3/T4 Header badge, Completed and Recurring tabs. |
| `86b4557` | Equipment admin text-save reload hotfix. |

For older migration history and rationale, use git log plus `archive/SESSION_LOG.md`.

