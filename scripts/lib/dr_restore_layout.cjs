// Pure layout/policy logic for the disaster-recovery RESTORE runner.
//
// Everything here is a pure function with no I/O, no network, and no secrets, so
// the destination guards, source pinning, generation pinning, manifest
// verification, and selective-restore TOC policy can be unit-tested without a
// database, a provider, or any credential. The runner (scripts/dr_restore.cjs)
// is the only caller.
//
// SAFETY POSTURE — this module is the last line of defence against a restore
// writing to the wrong database or reading from an attacker-supplied source. A
// restore is a bulk overwrite; pointed at the wrong project it is catastrophic
// and, for PROD, irreversible. Destinations and sources are validated
// STRUCTURALLY (parsed, exact host/protocol/db/user), never by loose substring
// matches, and everything is deny-by-default.
//
// Key layout is shared with the backup runner via dr_layout.cjs so a restore
// fetches EXACTLY the keys a backup wrote.

'use strict';

const L = require('./dr_layout.cjs');

// Project references a restore must NEVER target (dashboard-confirmed).
const FORBIDDEN_PROJECT_REFS = Object.freeze({
  pzfujbjtayhkdlxiblwe: 'PROD (Farm Planner)',
  msxvjupafhkcrerulolv: 'wcf-planner-test-main (quarantined)',
  dkigsoyejzjwldqtqkkn: 'TEST A',
  hiaisktuuropjnbfytwx: 'TEST B',
  fopyfgcspicjmzngvsxp: 'TEST C',
  ycwnlcgdwaimmxbjbyry: 'TEST D',
});

const PROJECT_REF_RE = /^[a-z0-9]{20}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SUPABASE_DIRECT_USER = 'postgres';
const SUPABASE_DB = 'postgres';

// The R2 restore SOURCE is pinned exactly — the restore is not a generic
// arbitrary-S3 reader. Approved Cloudflare endpoint host + bucket + region.
const APPROVED_R2 = Object.freeze({
  endpointHost: '9cf61539da8c9903163bd5fb6b2b6958.r2.cloudflarestorage.com',
  bucket: 'wcf-planner-dr-secondary-2026',
  region: 'auto',
});

// Schemas Supabase manages; only their TABLE DATA may be restored, never DDL.
const MANAGED_SCHEMAS = Object.freeze(['auth', 'storage']);

function requiredConfirmation(projectRef) {
  return `RESTORE INTO ${projectRef}`;
}

/**
 * Sanitise untrusted content (manifest strings, provider errors) before it is
 * surfaced in a log: replace control characters, collapse whitespace, and bound
 * the length. Uses char codes (no control-char regex literal). Secret redaction
 * is layered on top by the runner's clean().
 */
function safeLabel(s, max = 160) {
  const input = String(s == null ? '' : s);
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0);
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

function tryUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// Refuse a URL/DSN whose credentials smuggle a project reference or a supabase
// domain (a trick to slip a forbidden target past host validation).
function credentialsAreClean(u) {
  const user = (u.username || '').toLowerCase();
  let pass = '';
  try {
    pass = decodeURIComponent(u.password || '').toLowerCase();
  } catch {
    return false;
  }
  const blob = `${user} ${pass}`;
  if (/supabase\.(co|com)/.test(blob)) return false;
  for (const ref of Object.keys(FORBIDDEN_PROJECT_REFS)) if (blob.includes(ref)) return false;
  return true;
}

/**
 * Deny-by-default recovery-destination guard. Parses the project URL and the DSN
 * STRUCTURALLY and requires an exact recovery identity. Returns {ok, projectRef,
 * dsnPassword} (the decoded password so the caller can register it for
 * redaction). NEVER includes the DSN or the password in a thrown message.
 */
function assertRecoveryDestination({projectRef, projectUrl, dsn, confirmation} = {}) {
  for (const [k, v] of Object.entries({projectRef, projectUrl, dsn, confirmation})) {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`refusing restore: missing required destination field "${k}"`);
    }
  }
  if (!PROJECT_REF_RE.test(projectRef)) {
    throw new Error('refusing restore: projectRef is not a valid 20-char Supabase reference');
  }
  if (FORBIDDEN_PROJECT_REFS[projectRef]) {
    throw new Error(
      `refusing restore: ${projectRef} is ${FORBIDDEN_PROJECT_REFS[projectRef]} — never a restore target`,
    );
  }
  if (confirmation !== requiredConfirmation(projectRef)) {
    throw new Error(`refusing restore: confirmation string must be exactly "${requiredConfirmation(projectRef)}"`);
  }

  // Project URL: https, exact <ref>.supabase.co host, no auth/path/query/fragment.
  const pu = tryUrl(projectUrl);
  if (!pu) throw new Error('refusing restore: project URL is not a parseable URL');
  if (pu.protocol !== 'https:') throw new Error('refusing restore: project URL must be https');
  if (pu.hostname !== `${projectRef}.supabase.co`) {
    throw new Error('refusing restore: project URL host must be exactly <projectRef>.supabase.co');
  }
  if (pu.username || pu.password) throw new Error('refusing restore: project URL must not carry credentials');
  if (!(pu.pathname === '' || pu.pathname === '/') || pu.search || pu.hash) {
    throw new Error('refusing restore: project URL must have no path, query, or fragment');
  }

  // DSN: postgresql, exact db.<ref>.supabase.co host, /postgres database, the
  // direct-connection user, a password, and no query/fragment.
  const du = tryUrl(dsn);
  if (!du) throw new Error('refusing restore: DSN is not a parseable URL');
  if (du.protocol !== 'postgresql:') throw new Error('refusing restore: DSN must use the postgresql: protocol');
  if (du.hostname !== `db.${projectRef}.supabase.co`) {
    throw new Error('refusing restore: DSN host must be exactly db.<projectRef>.supabase.co');
  }
  if (du.pathname !== `/${SUPABASE_DB}`) throw new Error(`refusing restore: DSN database must be ${SUPABASE_DB}`);
  if (du.username !== SUPABASE_DIRECT_USER) {
    throw new Error(`refusing restore: DSN must connect as the direct-connection user ${SUPABASE_DIRECT_USER}`);
  }
  if (!du.password) throw new Error('refusing restore: DSN must include a password');
  if (du.search || du.hash) throw new Error('refusing restore: DSN must have no query string or fragment');
  if (!credentialsAreClean(du)) {
    throw new Error('refusing restore: DSN credentials must not embed a project reference or supabase domain');
  }
  // Defence in depth (the exact-host checks already exclude these).
  for (const [ref, label] of Object.entries(FORBIDDEN_PROJECT_REFS)) {
    if (du.hostname.includes(ref) || pu.hostname.includes(ref)) {
      throw new Error(`refusing restore: destination references ${label}`);
    }
  }
  let dsnPassword;
  try {
    dsnPassword = decodeURIComponent(du.password);
  } catch {
    throw new Error('refusing restore: DSN password is not valid percent-encoding');
  }
  return {ok: true, projectRef, dsnPassword};
}

/**
 * Pin the R2 source exactly. HTTPS, the approved Cloudflare endpoint host, the
 * approved bucket, region auto, and no credentials/path/query/fragment/port.
 */
function assertR2Source({endpoint, bucket, region} = {}) {
  for (const [k, v] of Object.entries({endpoint, bucket, region})) {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`refusing restore: R2 source missing "${k}"`);
  }
  const u = tryUrl(endpoint);
  if (!u) throw new Error('refusing restore: R2 endpoint is not a parseable URL');
  if (u.protocol !== 'https:') throw new Error('refusing restore: R2 endpoint must be https');
  if (u.hostname !== APPROVED_R2.endpointHost)
    throw new Error('refusing restore: R2 endpoint host is not the approved Cloudflare endpoint');
  if (u.username || u.password) throw new Error('refusing restore: R2 endpoint must not carry credentials');
  if (u.port) throw new Error('refusing restore: R2 endpoint must not specify a port');
  if (!(u.pathname === '' || u.pathname === '/') || u.search || u.hash) {
    throw new Error('refusing restore: R2 endpoint must have no path, query, or fragment');
  }
  if (bucket !== APPROVED_R2.bucket)
    throw new Error('refusing restore: R2 bucket is not the approved DR secondary bucket');
  if (region !== APPROVED_R2.region) throw new Error(`refusing restore: R2 region must be ${APPROVED_R2.region}`);
  return {ok: true};
}

/**
 * True if childReal is the parentReal directory or lives inside it. Paths must be
 * CANONICAL (realpath-resolved by the caller so junctions/symlinks/.. are
 * collapsed); comparison is case-insensitive on Windows so a casing change cannot
 * bypass an in-repository refusal.
 */
function pathIsInside(childReal, parentReal, {win = process.platform === 'win32'} = {}) {
  const sep = win ? '\\' : '/';
  const norm = (p) => {
    let s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
    if (win) s = s.toLowerCase();
    return s;
  };
  const c = norm(childReal);
  const p = norm(parentReal);
  return c === p || c.startsWith(p + sep);
}

/**
 * The decrypted-plaintext archive may ONLY live beneath a dedicated directory on
 * the device-encrypted C: volume, outside the repo and outside common
 * cloud-synced folders. Inputs are canonical paths. Returns {ok} or throws.
 */
function assertPlaintextLocation(realDir, {repoReal, win = process.platform === 'win32'} = {}) {
  if (typeof realDir !== 'string' || realDir.trim() === '')
    throw new Error('refusing restore: plaintext directory is required');
  if (!win) throw new Error('refusing restore: the approved plaintext design is C:/BitLocker (Windows) only');
  const low = realDir.toLowerCase();
  if (!/^c:\\/.test(low)) throw new Error('refusing restore: plaintext must live on the device-encrypted C: drive');
  if (repoReal && pathIsInside(realDir, repoReal, {win}))
    throw new Error('refusing restore: plaintext must be OUTSIDE the repository');
  for (const bad of ['\\onedrive', '\\dropbox', '\\google drive', '\\googledrive', '\\box\\', '\\icloud']) {
    if (low.includes(bad))
      throw new Error('refusing restore: plaintext directory must not be inside a cloud-synced folder');
  }
  return {ok: true};
}

/** Pin an EXPLICIT generation. No latest/current/newest, ever. */
function requireExplicitGeneration(runId) {
  if (typeof runId !== 'string' || runId.trim() === '') {
    throw new Error('refusing restore: an explicit generation (YYYYMMDDTHHMMSSZ) is required — no "latest"');
  }
  if (/latest|current|newest/i.test(runId)) {
    throw new Error(
      `refusing restore: symbolic generation "${safeLabel(runId, 32)}" is not allowed; pin an exact run id`,
    );
  }
  L.runIdParts(runId); // throws unless it matches YYYYMMDDTHHMMSSZ
  return runId;
}

/** R2 object keys for one generation, shared with the backup layout. */
function restoreSourceKeys(runId, tier = 'hourly') {
  const db = L.databaseKeys(runId, tier);
  return {
    dbPackage: db.dump,
    dbManifest: db.manifest,
    storageManifest: L.storageManifestKey(runId),
    storageObjectKey: (bucket, objectPath) => L.storageObjectKey('r2', bucket, objectPath, runId),
  };
}

/**
 * Structural + coverage verification of a fetched manifest BEFORE any restore.
 * Treats every surfaced value as untrusted (safeLabel). Returns collected errors.
 */
function verifyManifest(manifest, {runId, tier}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return {ok: false, errors: ['manifest missing or not an object'], objects: []};
  }
  if (manifest.run_id !== runId) errors.push(`manifest run_id ${safeLabel(manifest.run_id, 40)} != requested ${runId}`);
  if (manifest.tier !== tier) errors.push(`manifest tier ${safeLabel(manifest.tier, 16)} != requested ${tier}`);
  if (manifest.coverage !== 'database-and-storage') {
    errors.push(
      `coverage is "${safeLabel(manifest.coverage, 40)}" — a database-only generation cannot prove a full restore`,
    );
  }
  const db = manifest.database || {};
  if (!SHA256_RE.test(db.dump_sha256 || '')) errors.push('database.dump_sha256 missing or malformed');
  if (!SHA256_RE.test(db.encrypted_sha256 || '')) errors.push('database.encrypted_sha256 missing or malformed');
  if (db.encryption !== 'age-asymmetric')
    errors.push(`database.encryption is "${safeLabel(db.encryption, 32)}", not age-asymmetric`);
  if (!Number.isInteger(db.dump_bytes) || db.dump_bytes <= 0)
    errors.push('database.dump_bytes missing or non-positive');

  const st = manifest.storage || {};
  const objects = Array.isArray(st.objects) ? st.objects : [];
  if (!Array.isArray(st.objects)) errors.push('storage.objects is missing');
  else if (st.objects.length !== st.total_objects) {
    errors.push(`storage.total_objects ${safeLabel(st.total_objects, 12)} != objects[] length ${st.objects.length}`);
  }
  for (const o of objects) {
    if (!o || typeof o.bucket !== 'string' || typeof o.path !== 'string' || !Number.isInteger(o.size)) {
      errors.push(`malformed storage object entry: ${safeLabel(JSON.stringify(o), 80)}`);
      break;
    }
  }
  return {ok: errors.length === 0, errors, objects};
}

// Deterministic serialisation for cross-manifest comparison (sorted keys).
function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function firstDiff(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) if (stableStringify(a && a[k]) !== stableStringify(b && b[k])) return k;
  return null;
}

/**
 * Require the database manifest and the storage manifest to both exist and agree
 * on every field that defines the generation, the database package, coverage, the
 * not-backed-up inventory, and all Storage objects. The backup writes identical
 * content to both keys, so disagreement means tampering or a partial write.
 */
function assertManifestsAgree(dbManifest, storageManifest) {
  if (!dbManifest || typeof dbManifest !== 'object')
    throw new Error('refusing restore: database manifest missing or not an object');
  if (!storageManifest || typeof storageManifest !== 'object')
    throw new Error('refusing restore: storage manifest missing or not an object');
  const pick = (m) => ({
    run_id: m.run_id,
    env: m.env,
    tier: m.tier,
    coverage: m.coverage,
    physical_retention: m.physical_retention,
    database: m.database,
    storage: m.storage,
    not_backed_up: m.not_backed_up,
  });
  const a = pick(dbManifest);
  const b = pick(storageManifest);
  if (stableStringify(a) !== stableStringify(b)) {
    const diff = firstDiff(a, b);
    throw new Error(
      `refusing restore: database and storage manifests disagree${diff ? ` on "${safeLabel(diff, 40)}"` : ''}`,
    );
  }
  return {ok: true};
}

/** Assert an observed sha256 matches the manifest's expected value (fail-closed). */
function assertSha256(actualHex, expectedHex, label) {
  if (!SHA256_RE.test(expectedHex || '')) throw new Error(`refusing restore: no valid expected checksum for ${label}`);
  if (actualHex !== expectedHex) {
    throw new Error(
      `refusing restore: ${label} checksum mismatch (expected ${String(expectedHex).slice(0, 12)}…, got ${String(actualHex).slice(0, 12)}…)`,
    );
  }
  return true;
}

/** Assert the decrypted archive's exact byte count matches the manifest. */
function assertByteCount(actual, expected, label) {
  if (!Number.isInteger(expected) || expected <= 0)
    throw new Error(`refusing restore: no valid expected byte count for ${label}`);
  if (actual !== expected)
    throw new Error(`refusing restore: ${label} byte count mismatch (expected ${expected}, got ${actual})`);
  return true;
}

/** Verify a completed Storage restore against the manifest: count + path + size. */
function verifyStorageCoverage(manifestObjects, restored) {
  const errors = [];
  if (restored.length !== manifestObjects.length) {
    errors.push(`restored ${restored.length} storage objects, manifest lists ${manifestObjects.length}`);
  }
  const restoredBySig = new Map(restored.map((r) => [`${r.bucket} ${r.path}`, r]));
  for (const m of manifestObjects) {
    const hit = restoredBySig.get(`${m.bucket} ${m.path}`);
    if (!hit) {
      errors.push(`missing after restore: ${safeLabel(`${m.bucket}/${m.path}`, 120)}`);
      continue;
    }
    if (Number.isInteger(m.size) && Number.isInteger(hit.size) && hit.size !== m.size) {
      errors.push(
        `size mismatch ${safeLabel(`${m.bucket}/${m.path}`, 120)}: manifest ${m.size} vs restored ${hit.size}`,
      );
    }
  }
  return {ok: errors.length === 0, errors};
}

// ---------------------------------------------------------------------------
// SELECTIVE restore TOC policy. `pg_restore -l` emits one line per archive
// entry. FAIL-CLOSED throughout: every real entry must parse, every entry must
// map to an explicit include/exclude decision, and anything not understood
// REFUSES the whole restore. The policy keeps public object DDL+data (never
// SCHEMA creation, never ACL/OWNER), and ONLY the explicit managed-data allowlist
// below. It never re-creates Supabase-managed auth/storage DDL and never restores
// storage.objects (the later official Storage upload must create those rows;
// restoring them first would create ghost/duplicate metadata).

// The ONLY managed-schema TABLE DATA a restore may load. Everything else in auth/
// storage (sessions, refresh tokens, audit log, flow state, schema_migrations,
// instances, storage.objects, storage migrations, ...) is excluded.
const MANAGED_DATA_ALLOWLIST = Object.freeze(['auth.users', 'auth.identities', 'storage.buckets']);

// Known pg_restore object descriptions, longest-first so multi-word descs win.
const TOC_DESCS = Object.freeze(
  [
    'MATERIALIZED VIEW DATA',
    'MATERIALIZED VIEW',
    'SEQUENCE OWNED BY',
    'SEQUENCE SET',
    'FK CONSTRAINT',
    'CHECK CONSTRAINT',
    'DEFAULT ACL',
    'TABLE DATA',
    'PROCEDURAL LANGUAGE',
    'OPERATOR CLASS',
    'OPERATOR FAMILY',
    'TEXT SEARCH CONFIGURATION',
    'TEXT SEARCH DICTIONARY',
    'TEXT SEARCH PARSER',
    'TEXT SEARCH TEMPLATE',
    'FOREIGN DATA WRAPPER',
    'FOREIGN TABLE',
    'ACCESS METHOD',
    'EVENT TRIGGER',
    'DATABASE PROPERTIES',
    'ROW SECURITY',
    'LARGE OBJECT',
    'USER MAPPING',
    'PUBLICATION TABLE',
    'SCHEMA',
    'TABLE',
    'VIEW',
    'SEQUENCE',
    'FUNCTION',
    'PROCEDURE',
    'AGGREGATE',
    'TYPE',
    'DOMAIN',
    'CAST',
    'CONSTRAINT',
    'TRIGGER',
    'RULE',
    'INDEX',
    'DEFAULT',
    'COMMENT',
    'ACL',
    'OWNER',
    'EXTENSION',
    'POLICY',
    'PUBLICATION',
    'SUBSCRIPTION',
    'GRANT',
    'SERVER',
    'COLLATION',
    'CONVERSION',
    'BLOB',
    'ENCODING',
    'STDSTRINGS',
    'SEARCHPATH',
    'DATABASE',
    'TRANSFORM',
    'STATISTICS',
    'OPERATOR',
  ].sort((a, b) => b.length - a.length),
);

/**
 * Parse a `pg_restore -l` listing into structured entries. FAIL-CLOSED: comment
 * (";") and blank lines are skipped, but every remaining "<dumpId>; ..." line
 * MUST parse into a known desc + schema or this throws. entry = {line, desc,
 * schema, tag}; schema is "-" for global objects; tag is the object name (owner
 * is dropped as the trailing token).
 */
function parseRestoreList(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || /^\s*;/.test(line)) continue;
    const m = line.match(/^\d+;\s+\S+\s+\S+\s+(.+)$/);
    if (!m) throw new Error(`refusing restore: unparseable pg_restore -l line: ${safeLabel(line, 80)}`);
    const rest = m[1];
    const desc = TOC_DESCS.find((d) => rest === d || rest.startsWith(`${d} `));
    if (!desc) throw new Error(`refusing restore: unknown TOC object type in: ${safeLabel(line, 80)}`);
    const tokens = rest.slice(desc.length).trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2) throw new Error(`refusing restore: malformed TOC entry: ${safeLabel(line, 80)}`);
    entries.push({line, desc, schema: tokens[0], tag: tokens.slice(1, -1).join(' ')});
  }
  return entries;
}

/**
 * include | exclude | refuse decision for one parsed entry, by desc + schema +
 * tag (never schema alone). 'refuse' aborts the whole restore.
 */
function tocDecision(entry) {
  const desc = String(entry && entry.desc ? entry.desc : '').toUpperCase();
  const schema = String(entry && entry.schema != null ? entry.schema : '');
  const tag = String(entry && entry.tag != null ? entry.tag : '');
  if (desc === 'SCHEMA') return 'exclude'; // the fresh project already owns schemas
  if (desc === 'ACL' || desc === 'OWNER' || desc === 'DEFAULT ACL' || desc === 'GRANT') return 'exclude';
  if (schema === '-' || schema === '') {
    // Global objects: extensions/comments/directives are reconciled out-of-band.
    if (
      ['EXTENSION', 'COMMENT', 'ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE', 'DATABASE PROPERTIES'].includes(desc)
    )
      return 'exclude';
    return 'refuse';
  }
  if (schema === 'public') return 'include'; // public object DDL + data
  if (MANAGED_SCHEMAS.includes(schema)) {
    if (desc === 'TABLE DATA' && MANAGED_DATA_ALLOWLIST.includes(`${schema}.${tag}`)) return 'include';
    return 'exclude'; // all other managed DDL/data (incl. storage.objects) excluded
  }
  return 'refuse'; // any other schema is not understood
}

/**
 * Build the reviewed restore list. FAIL-CLOSED: refuses empty/unparseable TOC,
 * refuses ANY not-understood entry, requires every allowlisted managed table to
 * be present as DATA, and refuses if managed DDL or a non-allowlisted managed
 * table (e.g. storage.objects) leaked into the included set.
 */
function buildSelectiveRestoreList(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('refusing restore: empty or unparseable TOC');
  const included = [];
  const excluded = [];
  for (const e of entries) {
    const d = tocDecision(e);
    if (d === 'refuse') {
      throw new Error(
        `refusing restore: TOC entry not understood/approved: ${safeLabel(e.line || `${e.desc} ${e.schema} ${e.tag}`, 80)}`,
      );
    }
    (d === 'include' ? included : excluded).push(e);
  }
  for (const key of MANAGED_DATA_ALLOWLIST) {
    const [sch, tab] = key.split('.');
    const has = included.some(
      (e) => e.schema === sch && String(e.desc).toUpperCase() === 'TABLE DATA' && e.tag === tab,
    );
    if (!has) throw new Error(`refusing restore: selective TOC is missing required managed data ${key}`);
  }
  const leak = included.find(
    (e) =>
      MANAGED_SCHEMAS.includes(e.schema) &&
      !(String(e.desc).toUpperCase() === 'TABLE DATA' && MANAGED_DATA_ALLOWLIST.includes(`${e.schema}.${e.tag}`)),
  );
  if (leak)
    throw new Error(
      `refusing restore: selective TOC would restore managed ${safeLabel(`${leak.schema} ${leak.desc}`, 40)}`,
    );
  const list = `${included.map((e) => e.line).join('\n')}\n`;
  return {list, included, excluded};
}

module.exports = {
  FORBIDDEN_PROJECT_REFS,
  PROJECT_REF_RE,
  APPROVED_R2,
  SUPABASE_DIRECT_USER,
  SUPABASE_DB,
  MANAGED_SCHEMAS,
  MANAGED_DATA_ALLOWLIST,
  requiredConfirmation,
  safeLabel,
  assertRecoveryDestination,
  assertR2Source,
  pathIsInside,
  assertPlaintextLocation,
  requireExplicitGeneration,
  restoreSourceKeys,
  verifyManifest,
  assertManifestsAgree,
  assertSha256,
  assertByteCount,
  verifyStorageCoverage,
  tocDecision,
  buildSelectiveRestoreList,
  parseRestoreList,
  redactSecrets: L.redactSecrets,
};
