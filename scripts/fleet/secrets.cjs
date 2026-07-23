#!/usr/bin/env node
// ============================================================================
// scripts/fleet/secrets.cjs — protected-environment TEST credential routing
// ============================================================================
// Each fleet project's credentials live in its OWN GitHub protected environment
// (test-a / test-b / test-c / test-d), so a CI job assigned to one project can
// only read that project's environment secrets — a shard for TEST A can never
// read TEST B's service-role key. PROD and DR environments are untouched.
//
// Custody rules (enforced by construction):
//   - Secret VALUES are written to GitHub via STDIN (`gh secret set` reads the
//     value from standard input) — never as a command-line argument (argv is
//     visible in process listings) and never logged.
//   - Only NAMES are ever read back for verification.
//   - service-role / DB credentials never go into a VITE_ (browser-bundled)
//     variable — VITE_ carries only URL + anon key + the TEST admin
//     email/password used by the e2e login.
//   - This module performs GitHub mutations only when explicitly invoked with
//     apply=true; the default is a names-only PLAN so it is safe to inspect.
// ============================================================================
'use strict';

const {assertBootstrapTarget} = require('./projects.cjs');
const {redactError} = require('./redact.cjs');

const REPO = 'White-Creek-Farm/WCF-planner';

// The five TEST secrets (same names the existing CI + .env.test contract use).
// VITE_* are browser-bundle-safe (URL + anon key are public by design; the TEST
// admin email/password are e2e-only on a throwaway TEST project). The
// service-role key is server-side only and MUST NOT be VITE_-prefixed.
const SECRET_NAMES = Object.freeze([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'VITE_TEST_ADMIN_EMAIL',
  'VITE_TEST_ADMIN_PASSWORD',
]);

function envNameForKey(key) {
  const entry = assertBootstrapTarget(key); // only TEST A-D get their own env
  return entry.key; // 'test-a' ...
}

// Names-only plan for reporting — carries NO values.
function planSecretRouting(key) {
  return {repo: REPO, environment: envNameForKey(key), secret_names: [...SECRET_NAMES]};
}

// Build the value map from bootstrap outputs. Returned object is for immediate
// stdin routing only; callers must never log it.
function buildSecretValues({creds, adminEmail, adminPassword}) {
  return {
    VITE_SUPABASE_URL: creds.url,
    VITE_SUPABASE_ANON_KEY: creds.anon,
    SUPABASE_SERVICE_ROLE_KEY: creds.serviceRole,
    VITE_TEST_ADMIN_EMAIL: adminEmail,
    VITE_TEST_ADMIN_PASSWORD: adminPassword,
  };
}

// Explicit protection policy for a TEST fleet environment. Distinct from the
// dr-backup environment (reviewer-gated): TEST CI runs unattended, so required
// reviewers/wait timers would BREAK automation and are deliberately absent —
// forcing Ronnie to approve every browser shard is not viable.
//
// CONTAINMENT for automated TEST execution is TWO controls, NOT reviewers:
//   1. Per-environment secret SCOPING + one-environment-per-job binding: a job
//      only receives an environment's secrets if it declares that exact
//      environment, so a test-a job cannot read test-b / dr-backup / PROD
//      values. This is the primary isolation guarantee.
//   2. A CUSTOM deployment-branch policy (NOT a wildcard, NOT all-branches):
//      only the named branches may deploy to the environment, so an arbitrary
//      fork/branch cannot spin up a job that binds these environments and reads
//      their secrets.
const ENV_PROTECTION_POLICY = Object.freeze({
  wait_timer: 0,
  prevent_self_review: false,
  reviewers: [],
  deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
});

// The ONLY branches allowed to deploy to a TEST fleet environment. main is the
// live lane; the fleet feature branch runs this cutover; the reliability branch
// is the active TEST-infra lane. No wildcards.
const ALLOWED_BRANCHES = Object.freeze(['main', 'feature/test-project-fleet', 'feature/test-playwright-reliability']);

async function ensureEnvironment(
  io,
  {repo = REPO, environment, policy = ENV_PROTECTION_POLICY, branches = ALLOWED_BRANCHES},
) {
  const res = await io.run('gh', ['api', '-X', 'PUT', `repos/${repo}/environments/${environment}`, '--input', '-'], {
    input: JSON.stringify(policy),
  });
  if (res.code !== 0)
    throw redactError(new Error(`ensureEnvironment(${environment}) failed: ${res.stderr || res.stdout}`));
  // Reconcile the custom branch policies to EXACTLY the allowed set.
  const existing = await io.run('gh', ['api', `repos/${repo}/environments/${environment}/deployment-branch-policies`]);
  let current = [];
  try {
    current = JSON.parse(existing.stdout).branch_policies || [];
  } catch {
    current = [];
  }
  for (const bp of current) {
    if (!branches.includes(bp.name))
      await io.run('gh', [
        'api',
        '-X',
        'DELETE',
        `repos/${repo}/environments/${environment}/deployment-branch-policies/${bp.id}`,
      ]);
  }
  const have = new Set(current.map((b) => b.name));
  for (const name of branches) {
    if (!have.has(name)) {
      const add = await io.run(
        'gh',
        ['api', '-X', 'POST', `repos/${repo}/environments/${environment}/deployment-branch-policies`, '--input', '-'],
        {input: JSON.stringify({name, type: 'branch'})},
      );
      if (add.code !== 0)
        throw redactError(new Error(`add branch policy ${name} to ${environment} failed: ${add.stderr || add.stdout}`));
    }
  }
  return {environment, policy, branches};
}

// Read back and verify the environment's protection config + branch policies
// (rules/names only — never secret values).
async function verifyEnvironment(io, {repo = REPO, environment}) {
  const res = await io.run('gh', ['api', `repos/${repo}/environments/${environment}`]);
  if (res.code !== 0) return {exists: false};
  let cfg = {};
  try {
    cfg = JSON.parse(res.stdout);
  } catch {
    return {exists: false};
  }
  const rules = cfg.protection_rules || [];
  let branchNames = [];
  const bp = await io.run('gh', ['api', `repos/${repo}/environments/${environment}/deployment-branch-policies`]);
  try {
    branchNames = (JSON.parse(bp.stdout).branch_policies || []).map((b) => b.name).sort();
  } catch {
    branchNames = [];
  }
  return {
    exists: true,
    name: cfg.name,
    required_reviewers: rules.filter((r) => r.type === 'required_reviewers'),
    wait_timer: (rules.find((r) => r.type === 'wait_timer') || {}).wait_timer || 0,
    deployment_branch_policy: cfg.deployment_branch_policy || null,
    branch_policies: branchNames,
  };
}

// Set one env secret with the VALUE fed via stdin (never argv, never logged).
async function setEnvSecret(io, {repo = REPO, environment, name, value}) {
  if (!SECRET_NAMES.includes(name)) throw new Error(`Refusing to set unknown secret name ${name}`);
  const res = await io.run('gh', ['secret', 'set', name, '--repo', repo, '--env', environment], {input: value});
  if (res.code !== 0)
    throw redactError(new Error(`setEnvSecret(${environment}/${name}) failed: ${res.stderr || res.stdout}`));
}

// Verify names only (never values).
async function listEnvSecretNames(io, {repo = REPO, environment}) {
  const res = await io.run('gh', ['secret', 'list', '--repo', repo, '--env', environment, '--json', 'name']);
  if (res.code !== 0) return [];
  try {
    return JSON.parse(res.stdout).map((s) => s.name);
  } catch {
    return [];
  }
}

// Route all five secrets for a project into its protected environment via
// stdin, then verify by NAME only. apply=false => plan only (no mutation).
async function routeProjectSecrets(io, {key, values, apply = false}) {
  const environment = envNameForKey(key);
  const plan = planSecretRouting(key);
  if (!apply) return {applied: false, ...plan};
  await ensureEnvironment(io, {environment});
  for (const name of SECRET_NAMES) {
    if (values[name] == null) throw new Error(`Missing value for ${name} (not routing partial credentials).`);
    await setEnvSecret(io, {environment, name, value: String(values[name])});
  }
  const present = await listEnvSecretNames(io, {environment});
  const missing = SECRET_NAMES.filter((n) => !present.includes(n));
  if (missing.length) throw new Error(`Post-set verification failed; missing secret names: ${missing.join(', ')}`);
  return {applied: true, environment, verified_names: SECRET_NAMES.filter((n) => present.includes(n))};
}

module.exports = {
  REPO,
  SECRET_NAMES,
  ENV_PROTECTION_POLICY,
  ALLOWED_BRANCHES,
  envNameForKey,
  planSecretRouting,
  buildSecretValues,
  ensureEnvironment,
  verifyEnvironment,
  setEnvSecret,
  listEnvSecretNames,
  routeProjectSecrets,
};
