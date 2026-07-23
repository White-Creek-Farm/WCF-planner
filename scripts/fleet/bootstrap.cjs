#!/usr/bin/env node
// ============================================================================
// scripts/fleet/bootstrap.cjs — idempotent, fail-closed TEST fleet bootstrap
// ============================================================================
// Two modes, auto-detected from the project's current state:
//   execute — fresh/empty project: apply hand-seed + fixtures + every migration
//             IN ORDER, one at a time, writing the ledger row in the SAME
//             transaction as the migration body (a version is recorded only
//             after that migration succeeds; a half-applied migration can never
//             be marked complete; interruption resumes safely by skipping
//             ledgered versions).
//   adopt   — a project already carrying the schema (built before the ledger
//             existed): do NOT rerun bodies; verify each migration's
//             postconditions and record 'adopted-verified' / 'adopted-checksum-
//             only', REFUSING (fail closed) if a postcondition is missing.
//
// Both modes then: ensure a loginable synthetic admin, disable placeholder-
// backed cron jobs, write the TEST marker with audit metadata, and attest.
// Credentials are handled in memory only and returned to the caller for secure
// routing to GitHub secrets — never logged.
// ============================================================================
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {assertBootstrapTarget} = require('./projects.cjs');
const {ensureLinked} = require('./target.cjs');
const {runSql} = require('./sql.cjs');
const {fetchProjectKeys} = require('./keys.cjs');
const {
  LEDGER_DDL,
  listMigrations,
  checksum,
  classifyAdoption,
  snapshotObjects,
  ledgerUpsertSql,
  buildSupersededSet,
} = require('./ledger.cjs');
const {MARKER_DDL, markerUpsertSql} = require('./marker.cjs');
const {ensureAdminUser, ensureUser, adminProfileUpsertSql, ADMIN_EMAIL} = require('./auth.cjs');
const {disablePlaceholderCronJobs, PLACEHOLDER_CRON_JOBS} = require('./cron.cjs');
const {buildAndSegment, stripInnerTx} = require('./bundle.cjs');
const seeds = require('./seeds.cjs');
const {attest, countingDefinition} = require('./attest.cjs');

const PASTURE_BOUNDARY = 137;

function generatePassword() {
  return crypto.randomBytes(32).toString('base64').replace(/[+/=]/g, '').slice(0, 40);
}

// Pure execution planner: the ordered steps for a fresh 'execute' bootstrap,
// skipping migrations already in the ledger (resume-after-interruption) and
// injecting the pig-pasture fixture immediately before migration 137. Exported
// for interruption/boundary unit tests.
function planMigrationSteps(migrations, doneSet) {
  const steps = [];
  for (const m of migrations) {
    if (Number(m.version) === PASTURE_BOUNDARY)
      steps.push({kind: 'fixture', version: 'pig-pastures', boundary: PASTURE_BOUNDARY});
    if (!doneSet.has(m.version)) steps.push({kind: 'migration', version: m.version, path: m.path, file: m.file});
  }
  return steps;
}

async function detectState(io, {key, workdir}) {
  const {rows} = await runSql(io, {
    key,
    workdir,
    sql: `select (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as base_tables;`,
  });
  return {baseTables: Number(rows[0].base_tables)};
}

function markerDetails({cronRows}) {
  return {
    disabled_cron_jobs: PLACEHOLDER_CRON_JOBS.map((j) => ({
      jobname: j.jobname,
      integration: j.integration,
      reason:
        'placeholder Vault secrets — non-operational integration; disabled to prevent scheduled DNS/HTTP attempts',
      active: (cronRows.find((r) => r.jobname === j.jobname) || {}).active,
    })),
    vault_placeholders: seeds.VAULT_PLACEHOLDERS.map((v) => ({
      name: v.name,
      integration: v.integration,
      operational: false,
    })),
    fixtures: [
      {name: 'vault-secrets', boundary_before: '039', synthetic: true},
      {name: 'simon-mak-profiles', boundary_before: '052', synthetic: true},
      {name: 'admin-profile', boundary_before: '172', synthetic: true},
      {name: 'pig-pastures', boundary_before: '137', synthetic: true},
    ],
    counting_definition: countingDefinition(),
  };
}

// Record the synthetic-prerequisite boundary/version ledger rows. In execute
// mode the fixtures were freshly created ('executed'); in adopt mode they were
// verified present ('adopted-verified').
async function recordFixtureLedger(io, {key, workdir, mode}) {
  const status = mode === 'execute' ? 'executed' : 'adopted-verified';
  const entries = [
    {version: 'fixture:vault-secrets', boundary: '039', sql: seeds.vaultSecretsSql()},
    {version: 'fixture:simon-mak', boundary: '052', sql: seeds.SIMON_MAK_SQL},
    {version: 'fixture:pig-pastures', boundary: '137', sql: seeds.pigPasturesSql()},
    {version: 'fixture:admin-profile', boundary: '172', sql: 'goTrue admin + profiles role=admin'},
  ];
  const upserts = entries.map((e) =>
    ledgerUpsertSql({
      version: e.version,
      kind: 'fixture',
      sum: checksum(e.sql),
      status,
      postconditionCount: 0,
      boundaryBefore: e.boundary,
      note: 'synthetic TEST-only prerequisite',
    }),
  );
  await runSql(io, {key, workdir, sql: upserts.join('\n')});
}

// Re-apply the synthetic fixtures idempotently (used in adopt mode so a project
// that lost a fixture is repaired; all are IF NOT EXISTS / guarded).
async function ensureFixtures(io, {key, workdir}) {
  await runSql(io, {key, workdir, sql: seeds.vaultSecretsSql()});
  await runSql(io, {key, workdir, sql: seeds.SIMON_MAK_SQL});
  await runSql(io, {key, workdir, sql: seeds.pigPasturesSql()});
}

async function adoptBootstrap(io, {key, workdir}) {
  const snap = await snapshotObjects(io, {key, workdir}, {runSql});
  const migrations = listMigrations();
  const superseded = buildSupersededSet(migrations, (p) => fs.readFileSync(p, 'utf8'));
  const upserts = [];
  const refusals = [];
  let verified = 0;
  let checksumOnly = 0;
  for (const m of migrations) {
    const body = fs.readFileSync(m.path, 'utf8');
    const cls = classifyAdoption(body, snap, superseded);
    if (cls.status === 'refused') {
      refusals.push(`${m.version}(${m.file})[${cls.missing.map((x) => x.type + ':' + x.name).join(',')}]`);
      continue;
    }
    upserts.push(
      ledgerUpsertSql({
        version: m.version,
        kind: 'migration',
        sum: checksum(body),
        status: cls.status,
        postconditionCount: cls.postconditionCount,
        note: m.file,
      }),
    );
    cls.status === 'adopted-verified' ? verified++ : checksumOnly++;
  }
  if (refusals.length) {
    // Fail closed: a partially applied migration cannot be adopted as complete.
    throw new Error(
      `Adoption REFUSED for ${refusals.length} migration(s) — project is partially applied / NOT READY: ${refusals.join('; ')}`,
    );
  }
  const seg = await buildAndSegment(io);
  for (const s of [
    {v: '000-handseed', kind: 'handseed', sql: seg.handseed},
    {v: '999-exec_sql', kind: 'exec_sql', sql: seg.execsql},
  ]) {
    const cls = classifyAdoption(s.sql, snap, superseded);
    upserts.push(
      ledgerUpsertSql({
        version: s.v,
        kind: s.kind,
        sum: checksum(s.sql),
        status: cls.status === 'refused' ? 'adopted-checksum-only' : cls.status,
        postconditionCount: cls.postconditionCount,
        note: s.kind,
      }),
    );
  }
  // One batched transaction of all ledger upserts (verification already done).
  await runSql(io, {key, workdir, sql: upserts.join('\n')});
  io.log(
    `Adopted ${migrations.length} migrations (verified=${verified}, checksum-only=${checksumOnly}) + handseed + exec_sql.`,
  );
  return {adopted: migrations.length, verified, checksumOnly};
}

async function executeBootstrap(io, {entry, key, workdir, creds, adminPassword}) {
  const seg = await buildAndSegment(io);
  // resume: which versions are already ledgered?
  const {rows: done} = await runSql(io, {key, workdir, sql: `select version from public.wcf_fleet_migrations;`}).catch(
    () => ({rows: []}),
  );
  const doneSet = new Set(done.map((r) => r.version));

  // hand seed (idempotent create-if-not-exists)
  if (!doneSet.has('000-handseed')) {
    await runSql(io, {
      key,
      workdir,
      sql:
        seg.handseed +
        '\n' +
        ledgerUpsertSql({
          version: '000-handseed',
          kind: 'handseed',
          sum: checksum(seg.handseed),
          status: 'executed',
          postconditionCount: 9,
          note: 'hand seed',
        }),
    });
  }
  // admin (needed before mig 172) + simon/mak + vault
  const admin = await ensureAdminUser(io, {
    ref: entry.ref,
    url: creds.url,
    serviceRole: creds.serviceRole,
    password: adminPassword,
  });
  await runSql(io, {key, workdir, sql: adminProfileUpsertSql(admin.id)});
  // Simon + Mak: loginable farm_team users the browser specs sign in as. Create
  // them through GoTrue (like the admin) so they actually authenticate, THEN
  // bind their profiles (role=farm_team) to the created auth rows.
  for (const u of seeds.SIMON_MAK_USERS) {
    await ensureUser(io, {
      ref: entry.ref,
      url: creds.url,
      serviceRole: creds.serviceRole,
      email: u.email,
      password: seeds.SIMON_MAK_PASSWORD,
      fullName: u.fullName,
    });
  }
  await runSql(io, {key, workdir, sql: seeds.SIMON_MAK_SQL});
  await runSql(io, {key, workdir, sql: seeds.vaultSecretsSql()});

  const migrations = listMigrations();
  for (const step of planMigrationSteps(migrations, doneSet)) {
    if (step.kind === 'fixture') {
      await runSql(io, {key, workdir, sql: seeds.pigPasturesSql()}); // idempotent fixture before 137
      continue;
    }
    const raw = fs.readFileSync(step.path, 'utf8');
    const led = ledgerUpsertSql({
      version: step.version,
      kind: 'migration',
      sum: checksum(raw),
      status: 'executed',
      postconditionCount: 0,
      note: step.file,
    });
    // migration body + ledger row in ONE transaction (endpoint-wrapped), so a
    // version is recorded ONLY after its body succeeds; interruption leaves no
    // partial ledger row and resume re-attempts it cleanly.
    await runSql(io, {key, workdir, sql: stripInnerTx(raw) + '\n' + led, timeoutMs: 120000});
  }
  if (!doneSet.has('999-exec_sql')) {
    await runSql(io, {
      key,
      workdir,
      sql:
        seg.execsql +
        '\n' +
        ledgerUpsertSql({
          version: '999-exec_sql',
          kind: 'exec_sql',
          sum: checksum(seg.execsql),
          status: 'executed',
          postconditionCount: 1,
          note: 'exec_sql',
        }),
    });
  }
  io.log(`Executed ${migrations.length} migrations with per-migration ledger commits.`);
  return {executed: migrations.length};
}

async function bootstrap(io, {key, workdir, password} = {}) {
  const entry = assertBootstrapTarget(key); // fail closed
  await ensureLinked(io, {key, workdir}); // link + verify != PROD
  io.log(`Bootstrap ${entry.name} (${entry.ref})`);

  await runSql(io, {key, workdir, sql: LEDGER_DDL});
  await runSql(io, {key, workdir, sql: MARKER_DDL});

  const state = await detectState(io, {key, workdir});
  const mode = state.baseTables < 10 ? 'execute' : 'adopt';
  io.log(`${state.baseTables} base tables -> mode=${mode}`);

  const creds = await fetchProjectKeys(io, {ref: entry.ref}); // service role in memory
  const adminPassword = password || generatePassword();

  if (mode === 'execute') {
    await executeBootstrap(io, {entry, key, workdir, creds, adminPassword});
  } else {
    await adoptBootstrap(io, {key, workdir});
    await ensureFixtures(io, {key, workdir});
  }

  // loginable admin (both modes; resets password to the stored secret)
  const admin = await ensureAdminUser(io, {
    ref: entry.ref,
    url: creds.url,
    serviceRole: creds.serviceRole,
    password: adminPassword,
  });
  await runSql(io, {key, workdir, sql: adminProfileUpsertSql(admin.id)});
  await recordFixtureLedger(io, {key, workdir, mode});

  // cron override + marker
  const cronRows = await disablePlaceholderCronJobs(io, {key, workdir});
  await runSql(io, {
    key,
    workdir,
    sql: markerUpsertSql({
      projectKey: entry.key,
      projectRef: entry.ref,
      projectName: entry.name,
      mode,
      version: 'fleet-1',
      details: markerDetails({cronRows}),
    }),
  });

  const report = await attest(io, {key, workdir});
  // NOTE: creds + adminPassword are secrets — caller routes to gh secrets via
  // stdin and MUST NOT log them.
  return {mode, adminEmail: ADMIN_EMAIL, adminPassword, creds, report};
}

module.exports = {
  bootstrap,
  detectState,
  adoptBootstrap,
  executeBootstrap,
  generatePassword,
  planMigrationSteps,
  markerDetails,
  recordFixtureLedger,
  ensureFixtures,
};
