# DB/RLS Legacy Write-Boundary — Inventory & Conversion Plan

**Lane:** security closure #1 (DB/RLS legacy write boundary). **Branch:** `security/db-rls-write-boundary`.
**Date:** 2026-06-23. **Gates:** read-only inventory + planning. No PROD writes, no PROD migration, no `exec_sql` in PROD. Candidate migration is review-only, NOT applied.

---

## 0. Headline finding (refines the prior assumption)

The earlier worry — "a blind anon `DROP POLICY` would break the public weigh-in/webform paths" — **does not hold once the auth model is checked.** Evidence:

1. **Single shared authenticated client.** `src/lib/supabase.js` is the only `createClient` (locked by `supabase_client_owner_static.test.js`). There is no anon-only client — the exact basis migration 109 used to drop `daily_photos_anon_insert`.
2. **Login-gated render.** `src/main.jsx:3429` returns `<LoginScreen/>` when `authState === false`, **before** the view switch that mounts the weigh-in/daily/webform write surfaces (`view === 'weighins'` at `:3472`, daily views, `WeighInSessionPage`, bulk imports). No unauthenticated session reaches a write to these tables.
3. **The "anon" policies have no `TO` clause** — they are PUBLIC-role permissive policies, and the separate `*_auth_all` (`TO authenticated`) policies already cover every signed-in operation. So the "anon" policies are **redundant for authenticated and dead for anon.**

**Conclusion:** dropping the dead public/anon policies (Tier 1) is **safe and requires no app change or RPC conversion**. The genuine remaining exposure is the broad `*_auth_all USING(true)` policies (Tier 2) — any authenticated user (incl. `light`) can write/edit/delete any row — which is a larger RPC-conversion effort, designed below but deferred to its own gated lane.

---

## 1. Write-path inventory (client `.from(...).insert/update/upsert/delete`)

Target tables and where the app writes them (all behind the login gate):

| Table | Write call sites (representative) | Caller role context |
|---|---|---|
| `cattle_dailys` | `CattleDailysView.jsx:106,183`; `main.jsx:1507` (AddFeed) | authenticated app + AddFeed webform (login-gated) |
| `sheep_dailys` | `SheepDailysView.jsx:120,204`; `main.jsx:1515` | authenticated app + AddFeed (login-gated) |
| `weigh_ins` | `WeighInSessionPage.jsx` (~15 sites), `WeighInsWebform.jsx` (~7), `Cattle/SheepBulkImport`, `cattle/sheepProcessingBatch.js`, `PigBatchesView`, `usePigProcessingTrips` | authenticated app + weigh-in webform (login-gated) |
| `weigh_in_sessions` | `WeighInSessionPage.jsx`, `WeighInsWebform.jsx`, `Cattle/Sheep/LivestockWeighInsView`, `AdminNewWeighInModal`, bulk imports, `broiler.js`, `PigBatchesView` | authenticated app + webform (login-gated) |
| `sheep_comments` | `SheepBulkImport.jsx:285`; `WeighInsWebform.jsx:1061` (delete) | authenticated app (login-gated) |

Adjacent legacy `*_auth_all` tables discovered in the same archive modules (same Tier-2 pattern, **out of scope for this lane** but flagged): `cattle`, `cattle_comments`, `cattle_calving_records`, `cattle_breeding_cycles`, `cattle_processing_batches`, `cattle_transfers`, `sheep`, `sheep_breeds`, `sheep_origins`, `sheep_lambing_records`, `sheep_processing_batches`, `sheep_transfers`, `equipment`, `equipment_*`, `fuel_*`. (`cattle`/`sheep` were already partly hardened by migs 069/074.)

---

## 2. Policy matrix (from migration source — live PROD state pending verification)

`auth_all` = `CREATE POLICY ..._auth_all FOR ALL TO authenticated USING (true) WITH CHECK (true)` (archive 001/009). `anon_*` policies were created with **no `TO` clause** → PUBLIC role.

| Table | Current policies (source) | anon/public access | authenticated access | Hardening already applied | Classification | Target boundary |
|---|---|---|---|---|---|---|
| `cattle_dailys` | `cattle_dailys_anon_insert` (PUBLIC INSERT), `cattle_dailys_auth_all` | public INSERT (dead) | INSERT via auth_all; UPDATE/DELETE GRANT-revoked (mig 092) | mig 092 revoke U/D; owner-stamp trigger 089; ownership RPCs 113 | anon INSERT = dead → **Tier 1 drop**; auth INSERT broad → Tier 2 | drop public INSERT now; Tier-2 RPC/role-gate INSERT |
| `sheep_dailys` | `sheep_dailys_anon_insert`, `sheep_dailys_anon_select`, `sheep_dailys_auth_all` | public INSERT + SELECT (dead) | INSERT via auth_all; U/D GRANT-revoked (092) | mig 092; 089; 113 | dead public → **Tier 1 drop**; auth INSERT broad → Tier 2 | same as cattle_dailys |
| `weigh_ins` | `weigh_ins_anon_insert`, `_anon_select`, `_anon_update` (all PUBLIC), `weigh_ins_auth_all` | public I/S/U (dead) | full FOR ALL via auth_all | delete RPCs 101/103 rely on auth_all; note-comment trigger 111 | dead public → **Tier 1 drop**; broad auth FOR ALL → Tier 2 | drop public now; Tier-2 scope writes to RPC/role |
| `weigh_in_sessions` | `_anon_insert`, `_anon_update`, `_anon_select` (PUBLIC; legacy `_anon_rw`), `weigh_in_sessions_auth_all` | public I/S/U (dead) | full FOR ALL via auth_all | delete RPCs 101/103; triggers 111 | dead public → **Tier 1 drop**; broad auth → Tier 2 | drop public now; Tier-2 scope to RPC/role |
| `sheep_comments` | `sheep_comments_anon_insert`, `_anon_select` (PUBLIC), `sheep_comments_auth_all` | public I/S (dead) | full FOR ALL via auth_all | note-comment sync (111) writes here | dead public → **Tier 1 drop**; broad auth → Tier 2 | drop public now; Tier-2 scope to RPC/role |

> Note: migs 069 (`cattle`) and 074 (`sheep`) already replaced the base-table `anon_*` policies with `TO anon` soft-delete-aware versions; they are NOT in this drop set. The five tables above are the residual anon teardown that 069/074/109 did not cover.

---

## 3. Tier 1 — drop dead public/anon write policies (READY, gated)

**Candidate migration:** [`supabase-migrations/138_drop_dead_anon_write_policies.sql`](supabase-migrations/138_drop_dead_anon_write_policies.sql) (review-only, not applied).

- Drops the 11 dead public/anon policies on the 5 tables. Idempotent (`DROP POLICY IF EXISTS`). Touches **no** `auth_all` policy and **no** GRANT.
- **App impact: none.** Every signed-in write continues via the `*_auth_all` (`TO authenticated`) policies. Anon writes (which the app never makes) become denied — the security gain.
- **Number reconciliation:** filed as `138` against `origin/main @ e7fa640`; CC#1's parallel pasture work may also claim `138` — reconcile the number at apply time.

**Rollback:** re-create the dropped policies (the exact `CREATE POLICY ... FOR <cmd> [WITH CHECK|USING] (true)` bodies are in `archive/001_cattle_module.sql` / `archive/009_sheep_module.sql`). Because the drops are pure removals of dead permissions, rollback restores prior state exactly. No data is touched.

**Required TEST proof (before PROD gate):**
1. Apply `138` to TEST only (`psql --single-transaction` against `TEST_DB_URL`, or `exec_sql`).
2. Re-run `pg_policies` (post-apply verification query in the migration) — confirm no `*_anon_*` rows remain and each `*_auth_all` survives.
3. Run the authenticated write flows one spec per invocation (no bundling — shared TEST DB): the weigh-in session create/edit and a cattle/sheep daily submit e2e, proving signed-in writes still succeed.
4. (Optional) prove anon is now denied: a direct `anon`-key INSERT into one table returns RLS denial.

---

## 4. Tier 2 — constrain `auth_all USING(true)` (DESIGNED, deferred to own gated lane)

The real "any authenticated user can write any row" exposure. **Larger and behavior-sensitive — do not fold into Tier 1.**

Design:
- **Dailys (`cattle_dailys`/`sheep_dailys`):** UPDATE/DELETE already locked (mig 092 + ownership RPCs). Remaining: INSERT open to any authenticated. Convert daily INSERT to a `SECURITY DEFINER` RPC (`submit_*_daily`) with pinned `search_path`, input validation, server-stamped `owner_profile_id` (trigger 089 already does this), and a role check that excludes `light` except through the existing light 3-day-window path (mig 113). Then narrow `auth_all` to non-INSERT or `TO authenticated` with a role predicate.
- **Weigh-ins (`weigh_ins`/`weigh_in_sessions`):** the heaviest. ~40 direct write call sites plus delete RPCs 101/103/111 that depend on `auth_all`. Convert create/edit/delete to SECDEF RPCs (several already exist for delete) with role gates; keep team/admin app flows working; only then narrow `auth_all`. Requires a staged call-site migration + behavioral e2e per surface.
- **`sheep_comments`:** writes come from bulk import (admin) + weigh-in note-sync trigger (111, SECDEF). Route the client write through an RPC or restrict `auth_all` to the roles that legitimately comment.

**Removable only AFTER conversion:** the `*_auth_all` policies (and any broadened GRANTs) on weigh_ins/weigh_in_sessions/sheep_comments and the daily INSERT allowance — each can be narrowed only once its replacement RPC path is proven in TEST. This is the explicit "remove only after RPC conversion" set.

---

## 5. Open verifications (live state — required before the PROD gate)

CC audited from migration source; live PROD must be confirmed (read-only) before applying `138`:
- `pg_policies` for the 5 tables: confirm the `*_anon_*` policies exist with `roles = {public}` and that a `*_auth_all` (`roles = {authenticated}`) remains for each.
- Table GRANTs (`information_schema.role_table_grants`): confirm whether `anon` still holds INSERT/UPDATE on these tables (informational — dropping the policy denies anon regardless).
- Confirm no additional permissive policy was added out-of-band that would change the analysis.

---

## 6. Explicit PROD gate required

- **No PROD action taken.** `138` is a candidate; nothing applied to TEST or PROD this lane.
- **Tier 1 PROD apply** requires: (a) Codex review of this plan, (b) TEST apply + behavioral proof (§3), then (c) **Ronnie PROD migration approval**, applied via `psql --single-transaction` with `ON_ERROR_STOP=1`, post-apply `pg_policies` verification, and PostgREST reload.
- **Tier 2** is a separate, larger lane — RPC conversions built and proven on TEST first, then its own PROD gate. Not started.

---

## 7. Residual risk

- The "anon is dead" conclusion rests on the login gate + single client. If any future code adds a pre-auth write or a second anon client, the analysis must be revisited (the `supabase_client_owner_static` guard protects the single-client invariant).
- Tier 1 leaves the broad authenticated-write exposure intact until Tier 2 — i.e., a `light`/`farm_team` user can still write/edit livestock+weigh-in rows directly. Tier 1 closes only the unauthenticated hole.
- Live PROD policy/grant drift vs source is unverified (¶5) — the candidate migration is idempotent and safe even if some policies are already absent.
