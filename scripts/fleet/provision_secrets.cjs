#!/usr/bin/env node
// ============================================================================
// scripts/fleet/provision_secrets.cjs — protected-environment credential
// provisioning for one fleet project (mission Phase 3).
// ============================================================================
// For a named TEST bootstrap project (a/b/c/d) this:
//   1. verifies the target identity (link ref == registry, != PROD/test-main);
//   2. retrieves the project's anon + service-role keys via the CLI;
//   3. resets the synthetic admin's password to a FRESH generated value (so the
//      GitHub secret always matches the project's live admin login) — no
//      outbound email (email_confirm:true, no invite);
//   4. creates/normalizes the project's PROTECTED GitHub environment (custom
//      branch policy, no reviewers) and routes exactly its five secrets via
//      STDIN (never argv/logs), then verifies by NAME only;
//   5. reads back and prints the environment protection policy (names/rules).
// Secret VALUES are never printed. apply=false prints a names-only plan.
//
// Usage: node scripts/fleet/provision_secrets.cjs <test-a|b|c|d> [--apply]
// ============================================================================
'use strict';

const path = require('path');
const {realIo} = require('./io.cjs');
const {assertBootstrapTarget} = require('./projects.cjs');
const {ensureLinked, readLinkedRef} = require('./target.cjs');
const {fetchProjectKeys} = require('./keys.cjs');
const {ensureAdminUser, ADMIN_EMAIL} = require('./auth.cjs');
const {adminProfileUpsertSql} = require('./auth.cjs');
const {runSql} = require('./sql.cjs');
const {generatePassword} = require('./bootstrap.cjs');
const secrets = require('./secrets.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

async function provision(io, {key, workdir = REPO_ROOT, apply = false}) {
  const entry = assertBootstrapTarget(key); // PROD/test-main/unknown -> throw
  await ensureLinked(io, {key, workdir}); // link + verify ref
  const linked = readLinkedRef(io, workdir);
  if (linked !== entry.ref) throw new Error(`HARD STOP: linked ${linked} != ${entry.ref}`);

  const plan = secrets.planSecretRouting(key);
  if (!apply) return {applied: false, ...plan};

  const creds = await fetchProjectKeys(io, {ref: entry.ref}); // url/anon/serviceRole (non-enumerable)
  const adminPassword = generatePassword();
  const admin = await ensureAdminUser(io, {
    ref: entry.ref,
    url: creds.url,
    serviceRole: creds.serviceRole,
    password: adminPassword,
  });
  await runSql(io, {key, workdir, sql: adminProfileUpsertSql(admin.id)});

  const values = secrets.buildSecretValues({creds, adminEmail: ADMIN_EMAIL, adminPassword});
  const routed = await secrets.routeProjectSecrets(io, {key, values, apply: true});
  const envPolicy = await secrets.verifyEnvironment(io, {environment: entry.key});
  // NOTE: values/creds/adminPassword are secrets — never logged.
  return {
    applied: true,
    environment: routed.environment,
    verified_secret_names: routed.verified_names,
    env_policy: envPolicy,
  };
}

if (require.main === module) {
  const key = process.argv[2];
  const apply = process.argv.includes('--apply');
  provision(realIo(), {key, apply})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => {
      console.error('PROVISION FAILED:', e.message);
      process.exit(1);
    });
}

module.exports = {provision};
