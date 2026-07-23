#!/usr/bin/env node
// ============================================================================
// scripts/fleet/lease.cjs — per-project TEST DB lease routing
// ============================================================================
// The legacy scripts/test_db_lease_run.cjs holds ONE global wcf-test-db slot so
// a local run can't race CI on the single shared TEST project. The fleet needs
// PER-PROJECT leases: TEST A/B/C/D and focused main each get their own
// concurrency group wcf-test-db-<project>, so different projects run in
// parallel while one project stays serialized against itself + its CI jobs.
//
// This module owns the ROUTING + GUARD (the safety-critical, unit-tested part)
// and drives .github/workflows/test-db-lease-project.yml through the SAME
// dispatch -> wait-for-in_progress -> run -> cancel-to-release lifecycle proven
// by the legacy wrapper. Hard rules (mirrors the mission):
//   - An explicit project assignment is REQUIRED. No default, no fallback, no
//     target inferred from a CC number.
//   - PROD and unknown targets are refused before any dispatch.
//   - WCF_TEST_DATABASE must be '1' and the URL must not contain the PROD ref.
//   - The legacy global lease is NOT removed; this runs alongside it until the
//     fleet cutover isolation proof passes.
// ============================================================================
'use strict';

const {resolveTarget, isProdRef, TargetError} = require('./projects.cjs');

const WORKFLOW_FILE = 'test-db-lease-project.yml';
const RUN_NAME_PREFIX = 'TEST DB lease ';

// key ('test-a' | 'test-main' | ...) -> {project suffix, concurrency group}.
// Refuses PROD, unknown, and a missing assignment. Any lease-eligible fleet
// project (the 4 bootstrap targets + focused main) is allowed; the reference
// project is lease-eligible for focused browser work, PROD never is.
function resolveLease(token) {
  if (token == null || String(token).trim() === '') {
    throw new TargetError('Lease requires an explicit project assignment — there is no default or fallback target.');
  }
  const entry = resolveTarget(token); // throws on unknown
  if (entry.role === 'prod-prohibited' || isProdRef(entry.ref)) {
    throw new TargetError(`Refusing lease: "${entry.name}" is PRODUCTION. Hard stop.`);
  }
  if (entry.quarantined) {
    throw new TargetError(
      `Refusing lease: "${entry.name}" is QUARANTINED (Disk I/O Budget depletion) — excluded from browser testing.`,
    );
  }
  if (!entry.lease) {
    throw new TargetError(`Refusing lease: "${entry.key}" has no lease group (not a lease-eligible fleet project).`);
  }
  const project = entry.key === 'test-main' ? 'main' : entry.key.replace('test-', '');
  const group = `wcf-test-db-${project}`;
  if (group !== entry.lease) {
    throw new TargetError(`Lease group mismatch for ${entry.key}: derived ${group} != registry ${entry.lease}.`);
  }
  return {key: entry.key, ref: entry.ref, project, group};
}

// gh workflow-run args for the per-project lease. project is a fixed choice so
// the concurrency group can never be an arbitrary string.
function buildDispatchArgs({project, leaseId, holdMinutes = 90, ref = null}) {
  const args = [
    'workflow',
    'run',
    WORKFLOW_FILE,
    '-f',
    `project=${project}`,
    '-f',
    `lease_id=${leaseId}`,
    '-f',
    `hold_minutes=${holdMinutes}`,
  ];
  if (ref) args.push('--ref', ref);
  return args;
}

// Env guard identical in intent to test_db_lease_run.cjs / assertTestDatabase.
function assertLeaseEnvSafe(env, prodRef = 'pzfujbjtayhkdlxiblwe') {
  if (env.WCF_TEST_DATABASE !== '1') {
    throw new TargetError('WCF_TEST_DATABASE is not exactly "1"; refusing to lease/run TEST-backed commands.');
  }
  const url = env.VITE_SUPABASE_URL;
  if (typeof url !== 'string' || url.length === 0) {
    throw new TargetError('VITE_SUPABASE_URL is missing from the environment.');
  }
  if (url.includes(prodRef)) {
    throw new TargetError(`VITE_SUPABASE_URL matches the PRODUCTION project ref; refusing.`);
  }
}

// The uniquely named run title for this project + lease id (exact-match, never
// substring), so concurrent dispatches never claim the wrong run.
function leaseRunTitle({project, leaseId}) {
  return `${RUN_NAME_PREFIX}${project} ${leaseId}`;
}

module.exports = {
  WORKFLOW_FILE,
  RUN_NAME_PREFIX,
  resolveLease,
  buildDispatchArgs,
  assertLeaseEnvSafe,
  leaseRunTitle,
};
