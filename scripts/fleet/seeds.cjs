#!/usr/bin/env node
// ============================================================================
// scripts/fleet/seeds.cjs — synthetic TEST-only fixture prerequisites
// ============================================================================
// The repository migration chain has three apply-time DO-block preflights that
// require pre-existing rows/config (they RAISE otherwise). These accreted over
// the reference project's incremental history and are NOT satisfied by the
// migration files alone. The bootstrap injects these synthetic, TEST-only
// seeds at the correct points so every migration applies UNMODIFIED (repo stays
// the source of truth — we add fixtures, we never edit a migration).
//
//   - mig 039/046: Vault preflight needs 4 non-empty secrets. We seed synthetic
//     PLACEHOLDER values (NOT real credentials) — the preflight only checks
//     length>0, and the Edge Functions they target are mocked in every spec.
//   - mig 052: needs profiles full_name='Simon' and ='Mak' (role != inactive).
//   - mig 137: needs exactly 4 active land_areas kind='pasture' named
//     'Pig Pasture #1'..'#4'. It then inserts 40 child paddocks itself.
//
// NONE of these contain a real credential or any PROD-derived data. All SQL is
// idempotent (IF NOT EXISTS / ON CONFLICT / existence-guarded).
// ============================================================================
'use strict';

// The four Vault secret NAMES the apply-time preflights read (mig 039 + 046).
// These are STRUCTURAL PLACEHOLDERS that satisfy the historical Vault-preflight
// length>0 check ONLY. They are NOT operational integration credentials.
//
// The *_FUNCTION_URL values are deliberately non-routable RFC 6761 `.invalid`
// hosts: if a pg_cron job ever fires invoke_tasks_cron()/summary (which do
// net.http_post), DNS resolution fails and ZERO outbound traffic leaves the
// project — no real Supabase host, no PROD endpoint, no email/provider call.
// The *_SECRET / *_SERVICE_ROLE_KEY values are unmistakable throwaway strings.
//
// No Playwright/browser path invokes (or even mocks) tasks-cron/tasks-summary,
// so a placeholder is safe. The drift attestation classifies these as
// `placeholder` (operational=false) so readiness can never falsely report the
// tasks integration as operationally green. See VAULT_PLACEHOLDERS below.
const VAULT_PLACEHOLDERS = Object.freeze([
  {
    name: 'TASKS_CRON_FUNCTION_URL',
    value: 'https://tasks-cron.wcf-fleet-test.invalid',
    kind: 'placeholder',
    integration: 'tasks-cron',
    operational: false,
  },
  {
    name: 'TASKS_SUMMARY_FUNCTION_URL',
    value: 'https://tasks-summary.wcf-fleet-test.invalid',
    kind: 'placeholder',
    integration: 'tasks-summary',
    operational: false,
  },
  {
    name: 'TASKS_CRON_SECRET',
    value: 'wcf-fleet-test-placeholder-NOT-OPERATIONAL',
    kind: 'placeholder',
    integration: 'tasks-cron',
    operational: false,
  },
  {
    name: 'TASKS_CRON_SERVICE_ROLE_KEY',
    value: 'wcf-fleet-test-placeholder-NOT-OPERATIONAL',
    kind: 'placeholder',
    integration: 'tasks-cron',
    operational: false,
  },
]);

function vaultSecretsSql() {
  const pairs = VAULT_PLACEHOLDERS.map((p) => `['${p.name}', '${p.value}']`).join(',\n    ');
  return `
do $fleet_vault$
declare
  pairs constant text[][] := array[
    ${pairs}
  ];
  p text[];
begin
  foreach p slice 1 in array pairs loop
    if not exists (select 1 from vault.secrets where name = p[1]) then
      perform vault.create_secret(p[2], p[1], 'wcf fleet test PLACEHOLDER — not an operational credential');
    end if;
  end loop;
end
$fleet_vault$;`;
}

// Simon + Mak — the two synthetic secondary TEST users. Migration 052 needs
// profiles full_name='Simon'/'Mak' with role != 'inactive', but they are ALSO
// loginable farm_team users the browser specs sign in as (tasks_v2_*,
// cattle_log role-gates, todo approval, etc. use email
// simon.tasks@wcfplanner.test with the placeholder password below). They are
// therefore created through the GoTrue admin API (auth.cjs ensureUser, applied
// by bootstrap) exactly like the admin — a hand-written encrypted_password is
// NOT a real bcrypt hash and makes signInWithPassword fail. This SQL only binds
// their profiles (role=farm_team) to the GoTrue-created auth rows and normalizes
// GoTrue token columns. The password is a well-known TEST placeholder that is
// already hard-coded in the specs (tests/tasks_v2_rpcs.spec.js), not a secret.
const SIMON_MAK_PASSWORD = 'apply_test_mig_052_placeholder_password';
const SIMON_MAK_USERS = [
  {email: 'simon.tasks@wcfplanner.test', fullName: 'Simon'},
  {email: 'mak.tasks@wcfplanner.test', fullName: 'Mak'},
];
const SIMON_MAK_SQL = `
insert into public.profiles (id, email, full_name, role)
select u.id, u.email, u.raw_user_meta_data->>'full_name', 'farm_team'
from auth.users u
where u.email in ('simon.tasks@wcfplanner.test','mak.tasks@wcfplanner.test')
on conflict (id) do update set full_name = excluded.full_name, role = coalesce(nullif(public.profiles.role,'inactive'), excluded.role);

${gotrueNormalizeSql()}`;

// Version-agnostic belt-and-suspenders: any auth.users text token/change column
// left NULL by a raw insert breaks GoTrue's admin API. Set them all to ''.
function gotrueNormalizeSql() {
  return `do $gotrue_norm$
declare col text;
begin
  for col in
    select column_name from information_schema.columns
    where table_schema='auth' and table_name='users' and data_type in ('text','character varying')
      and column_name ~ '(token|change)'
  loop
    execute format('update auth.users set %I = %L where %I is null', col, '', col);
  end loop;
end
$gotrue_norm$;`;
}

// Four synthetic pig pastures (parents for mig 137). Bounding boxes around the
// WCF farm coords that comfortably contain mig 137's hardcoded child paddocks.
// Valid, non-degenerate polygons; kind='pasture', active, reviewed.
const PIG_PASTURES = [
  {id: 'la-pigpasture-3', name: 'Pig Pasture #3', box: [-86.4332, 30.8486, -86.431, 30.8497]},
  {id: 'la-pigpasture-4', name: 'Pig Pasture #4', box: [-86.431, 30.8486, -86.4288, 30.8497]},
  {id: 'la-pigpasture-1', name: 'Pig Pasture #1', box: [-86.4332, 30.8474, -86.431, 30.8486]},
  {id: 'la-pigpasture-2', name: 'Pig Pasture #2', box: [-86.431, 30.8474, -86.4288, 30.8486]},
];

function boxPolygonJson([minLon, minLat, maxLon, maxLat]) {
  const ring = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
  return JSON.stringify({type: 'Polygon', coordinates: [ring]});
}

function pigPasturesSql() {
  const rows = PIG_PASTURES.map((p) => `('${p.id}','${p.name}','${boxPolygonJson(p.box)}'::jsonb)`).join(',\n      ');
  return `
do $fleet_pastures$
declare
  rec record;
  v_geom extensions.geometry;
begin
  for rec in
    select * from (values
      ${rows}
    ) as t(id, name, geom_json)
  loop
    if not exists (select 1 from public.land_areas where id = rec.id) then
      insert into public.land_areas
        (id, parent_id, kind, name, permanence, designation, status, review_status,
         geometry_status, baseline_no_history, source, source_external_id, created_by)
      values
        (rec.id, null, 'pasture', rec.name, 'permanent', 'feeder_pig', 'active', 'reviewed',
         'none', true, 'drawn', 'pigpasture:' || rec.id, null);
      v_geom := extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(rec.geom_json::text), 4326);
      perform public._land_area_add_version(
        rec.id, v_geom, 'drawn',
        jsonb_build_object('created_via', 'fleet_bootstrap', 'label', rec.name), null);
    end if;
  end loop;
  if (select count(*) from public.land_areas
        where name in ('Pig Pasture #1','Pig Pasture #2','Pig Pasture #3','Pig Pasture #4')
          and kind='pasture' and status='active' and deleted_at is null) <> 4 then
    raise exception 'fleet seed: expected 4 active pig pastures after seed';
  end if;
end
$fleet_pastures$;`;
}

module.exports = {
  vaultSecretsSql,
  VAULT_PLACEHOLDERS,
  SIMON_MAK_SQL,
  SIMON_MAK_USERS,
  SIMON_MAK_PASSWORD,
  gotrueNormalizeSql,
  pigPasturesSql,
  PIG_PASTURES,
};
