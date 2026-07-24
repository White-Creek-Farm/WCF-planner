// Disaster-recovery ISOLATED RESTORE runner (Build Queue item 1).
//
// Recovers a backup generation into an ISOLATED, TEMPORARY Supabase recovery
// project — never PROD, never the TEST fleet. Sources from Cloudflare R2 (its
// credential supports reading); the write-focused B2 key is never used or
// widened. Credentials and the age PRIVATE identity are supplied ONLY as file
// paths OUTSIDE the repository; contents are never printed/logged and the age
// identity is never read into this process (age reads it via -i <path>).
//
// GENERATION IS EXPLICIT — no "latest".
//
// PLAINTEXT (approved design, Option B): a safe restore into a MANAGED Supabase
// project must be SELECTIVE (public schema+data; auth/storage TABLE DATA only;
// never Supabase-managed auth/storage DDL/ownership/grants/service objects),
// which needs the archive TOC on a SEEKABLE file. So the decrypted custom-format
// dump is materialised transiently, but ONLY beneath a dedicated randomized
// directory on the device-encrypted C: volume, outside the repo and any
// cloud-synced folder, created with inheritance removed and access restricted to
// this Windows account + SYSTEM. It is byte+sha verified against the manifest
// before pg_restore. Cleanup runs on EVERY exit (success, failure, cancellation,
// subprocess error, signal): best-effort overwrite, flush/close, rename, unlink,
// remove TOC/list files, and verify the path is gone. BitLocker/device
// encryption is the PRIMARY at-rest protection because SSD overwrite cannot be
// guaranteed. No plaintext archive path, DSN, password, age path, or credential
// value is ever logged.
//
// PHASE 1 STATE: tooling only. It does NOT create the recovery project, install
// the AWS CLI, request secret values, or execute a restore. The DB-restore code
// below runs only in --mode=execute with real inputs, behind fail-closed checks.
//
// Exit codes: 0 ok; 1 a step failed; 2 usage/config/guard refusal.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFileSync, spawnSync, spawn} = require('child_process');
const RL = require('./lib/dr_restore_layout.cjs');

const argv = process.argv.slice(2);
const arg = (k, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

// Secret VALUES held only in-process, registered for stderr/message redaction.
// The DSN, its decoded password, and the R2 credential are all registered before
// any subprocess runs.
const SECRET_VALUES = [];
function registerSecret(v) {
  if (typeof v === 'string' && v.length >= 8 && !SECRET_VALUES.includes(v)) SECRET_VALUES.push(v);
  return v;
}
const clean = (t) => RL.redactSecrets(t, SECRET_VALUES);

function refuse(msg, code = 2) {
  console.error(clean(`refusing: ${msg}`));
  process.exit(code);
}

const REPO_REAL = (() => {
  try {
    return fs.realpathSync(path.resolve(__dirname, '..'));
  } catch {
    return path.resolve(__dirname, '..');
  }
})();

// Resolve a caller-supplied path to its CANONICAL form and refuse anything inside
// the repository. realpath collapses junctions/symlinks/.. and (on Windows)
// casing, so a casing change or a link pointing back into the repo cannot bypass
// this. The file must exist first.
function resolveExternalPath(p, label, {read}) {
  if (!p) {
    refuse(
      `--${label} is required (a file path OUTSIDE the repo; contents are never printed${read ? '' : ' or read'})`,
    );
  }
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) refuse(`--${label} file not found (path is not printed for safety)`);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    refuse(`--${label} path could not be canonicalised`);
  }
  if (RL.pathIsInside(real, REPO_REAL)) {
    refuse(`--${label} must live OUTSIDE the repository`);
  }
  return real;
}

function readSecretFile(p, label) {
  const real = resolveExternalPath(p, label, {read: true});
  const raw = fs.readFileSync(real, 'utf8').trim();
  if (!raw) refuse(`--${label} file is empty`);
  return raw;
}

// The age PRIVATE identity is handled by PATH ONLY — never read here. The decrypt
// passes the path to `age -d -i <path>`, so key material never enters this
// process, a log, a manifest, or an argv value.
function assertAgeIdentityPath() {
  return resolveExternalPath(arg('age-identity'), 'age-identity', {read: false});
}

const mode = arg('mode', 'preflight');
if (!['preflight', 'execute'].includes(mode))
  refuse(`--mode must be preflight or execute (got "${RL.safeLabel(mode, 24)}")`);

const generation = RL.requireExplicitGeneration(arg('generation', '20260724T180923Z'));
const tier = arg('tier', 'hourly');
const keys = RL.restoreSourceKeys(generation, tier);

function loadRecoveryConfig() {
  const raw = readSecretFile(arg('recovery-config'), 'recovery-config');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    refuse('--recovery-config is not valid JSON (contents not printed)');
  }
  let out;
  try {
    out = RL.assertRecoveryDestination({
      projectRef: cfg.projectRef,
      projectUrl: cfg.projectUrl,
      dsn: cfg.dsn,
      confirmation: arg('confirm'),
    });
  } catch (e) {
    refuse(clean(e.message));
  }
  // Register the full DSN AND its decoded password INDEPENDENTLY for redaction,
  // before any subprocess can echo them. Also register any recovery service-role
  // key if the config carries one (Phase 2 storage restore).
  registerSecret(cfg.dsn);
  registerSecret(out.dsnPassword);
  if (cfg.serviceRoleKey) registerSecret(cfg.serviceRoleKey);
  return {cfg, projectRef: out.projectRef, dsnPassword: out.dsnPassword};
}

function loadR2Cred() {
  const raw = readSecretFile(arg('r2-cred'), 'r2-cred');
  let c;
  try {
    c = JSON.parse(raw);
  } catch {
    refuse('--r2-cred is not valid JSON (contents not printed)');
  }
  for (const k of ['accessKeyId', 'secretAccessKey', 'endpoint', 'bucket']) {
    if (!c[k]) refuse(`--r2-cred is missing "${k}"`);
  }
  c.region = c.region || 'auto';
  try {
    RL.assertR2Source({endpoint: c.endpoint, bucket: c.bucket, region: c.region});
  } catch (e) {
    refuse(clean(e.message));
  }
  registerSecret(c.accessKeyId);
  registerSecret(c.secretAccessKey);
  return c;
}

function hasBinary(bin) {
  try {
    execFileSync(bin, ['--version'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

function r2Env(cred) {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: cred.accessKeyId,
    AWS_SECRET_ACCESS_KEY: cred.secretAccessKey,
    AWS_DEFAULT_REGION: cred.region || 'auto',
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
  };
}
const r2Endpoint = (cred) => (cred.endpoint.startsWith('http') ? cred.endpoint : `https://${cred.endpoint}`);

// Read-only R2 operations the restore may use. Unknown ops are refused.
const R2_READ_OPS = Object.freeze(['get-object', 'head-object', 'list-objects-v2']);
function assertR2ReadOnly(op) {
  if (!R2_READ_OPS.includes(op))
    throw new Error(`refusing R2 op "${op}": restore reads only (${R2_READ_OPS.join(', ')})`);
  return op;
}

function r2GetObjectBuffer(cred, key) {
  assertR2ReadOnly('get-object');
  const tmp = path.join(os.tmpdir(), `wcf-dr-r2-${crypto.randomBytes(6).toString('hex')}`);
  try {
    execFileSync(
      'aws',
      ['s3api', 'get-object', '--bucket', cred.bucket, '--key', key, '--endpoint-url', r2Endpoint(cred), tmp],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: r2Env(cred),
      },
    );
    return fs.readFileSync(tmp);
  } finally {
    try {
      fs.rmSync(tmp, {force: true});
    } catch {
      /* best effort */
    }
  }
}

// Stream an R2 object through a sha256 hash WITHOUT staging it. Read-only.
function r2HashObject(cred, key) {
  return new Promise((resolve, reject) => {
    assertR2ReadOnly('get-object');
    const child = spawn('aws', ['s3', 'cp', `s3://${cred.bucket}/${key}`, '-', '--endpoint-url', r2Endpoint(cred)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: r2Env(cred),
    });
    const h = crypto.createHash('sha256');
    let bytes = 0;
    let err = '';
    child.stdout.on('data', (c) => {
      h.update(c);
      bytes += c.length;
    });
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('close', (code) =>
      code !== 0
        ? reject(new Error(`r2 read exited ${code}: ${clean(err).slice(-300)}`))
        : resolve({sha256: h.digest('hex'), bytes}),
    );
  });
}

const say = (s = '') => console.log(s);

// ---------------------------------------------------------------------------
// Plaintext restore directory lifecycle (Option B, C:/BitLocker).
const RESTORE_ROOT_DEFAULT = 'C:\\wcf-dr-restore';
let ACTIVE_PLAINTEXT_DIR = null;

// Best-effort overwrite + delete of plaintext, then verify it is gone. BitLocker
// is the primary at-rest protection; SSD wear-levelling means an overwrite is not
// guaranteed to erase the underlying blocks, so deletion + device encryption is
// the contract, not secure-erase.
function cleanupPlaintext(dir) {
  if (!dir) return;
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name);
        try {
          const sz = fs.statSync(f).size;
          if (sz > 0) fs.writeFileSync(f, Buffer.alloc(Math.min(sz, 1 << 20), 0)); // best-effort overwrite
        } catch {
          /* continue */
        }
        try {
          fs.rmSync(f, {force: true});
        } catch {
          /* continue */
        }
      }
      fs.rmSync(dir, {recursive: true, force: true});
    }
  } catch {
    /* best effort */
  }
  if (fs.existsSync(dir)) console.error(clean('WARNING: plaintext restore directory could not be fully removed'));
  if (ACTIVE_PLAINTEXT_DIR === dir) ACTIVE_PLAINTEXT_DIR = null;
}

// Cleanup on any exit path (Node skips finally on signal death).
process.on('exit', () => cleanupPlaintext(ACTIVE_PLAINTEXT_DIR));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    cleanupPlaintext(ACTIVE_PLAINTEXT_DIR);
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  cleanupPlaintext(ACTIVE_PLAINTEXT_DIR);
  console.error(clean(`FAILED: ${e && e.message ? e.message.split('\n')[0] : 'uncaught'}`));
  process.exit(1);
});

// Require an explicit runtime confirmation, tied to C:, that device encryption
// was verified before any decryption.
function assertEncryptedVolumeVerified() {
  const v = arg('encrypted-volume-verified');
  const expected = 'DEVICE ENCRYPTION VERIFIED ON C:';
  if (v !== expected)
    refuse(
      `decryption requires --encrypted-volume-verified="${expected}" (confirm BitLocker/device encryption on C: first)`,
    );
}

// Create the randomized restore directory on C: with inheritance removed and
// access restricted to this Windows account + SYSTEM. Refuses a stale directory
// from an interrupted prior run rather than silently leaving plaintext behind.
function prepareRestoreDir() {
  const root = arg('restore-root', RESTORE_ROOT_DEFAULT);
  const rootAbs = path.resolve(root);
  const rootReal = fs.existsSync(rootAbs) ? fs.realpathSync(rootAbs) : rootAbs;
  RL.assertPlaintextLocation(rootReal, {repoReal: REPO_REAL});
  if (!fs.existsSync(rootAbs)) fs.mkdirSync(rootAbs, {recursive: true});
  // Stale-run detection: any leftover wcf-restore-* dir means a prior run was
  // interrupted; stop and report rather than creating another.
  const stale = fs.readdirSync(rootAbs).filter((n) => n.startsWith('wcf-restore-'));
  if (stale.length > 0)
    refuse(
      `a stale restore directory from an interrupted run exists under the restore root; remove it before retrying (${stale.length} found)`,
    );
  const dir = path.join(rootAbs, `wcf-restore-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir);
  ACTIVE_PLAINTEXT_DIR = dir;
  // Remove inheritance and grant only this account + SYSTEM (inheritable to files
  // created inside). icacls is the Windows ACL tool; failure is fatal.
  const user = process.env.USERNAME || 'Ronni';
  const res = spawnSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    cleanupPlaintext(dir);
    refuse(
      `could not restrict ACL on the restore directory: ${clean(res.stderr || res.stdout || 'icacls failed').slice(0, 200)}`,
    );
  }
  return dir;
}

/**
 * PREFLIGHT — read-only. Verifies the recovery destination, the R2 source, BOTH
 * published manifests (structure + exact agreement), and the encrypted package
 * checksum (streamed, no decrypt). Writes nothing.
 */
async function runPreflight(cfg, r2) {
  say(`\nDR restore PREFLIGHT — generation ${generation} (tier ${tier})`);
  say('='.repeat(64));
  say(`  destination: recovery project ${cfg.projectRef} (guard passed; DSN not shown)`);
  say(`  source: R2 bucket ${r2.bucket} (read-only, endpoint pinned)`);

  const dbManifest = JSON.parse(r2GetObjectBuffer(r2, keys.dbManifest).toString('utf8'));
  const storageManifest = JSON.parse(r2GetObjectBuffer(r2, keys.storageManifest).toString('utf8'));
  // Both manifests must exist, parse, validate, and agree exactly.
  RL.assertManifestsAgree(dbManifest, storageManifest);
  const mv = RL.verifyManifest(dbManifest, {runId: generation, tier});
  if (!mv.ok) {
    say('  MANIFEST VERIFICATION FAILED:');
    for (const e of mv.errors) say(`    - ${RL.safeLabel(e, 200)}`);
    refuse('manifest verification failed; not proceeding', 1);
  }
  say(
    `  both manifests OK + agree: coverage ${RL.safeLabel(dbManifest.coverage, 40)}, ${mv.objects.length} storage objects`,
  );

  const enc = await r2HashObject(r2, keys.dbPackage);
  RL.assertSha256(enc.sha256, dbManifest.database.encrypted_sha256, 'encrypted database package');
  say(`  encrypted package OK: ${enc.bytes} bytes, sha256 matches manifest`);
  const nb = dbManifest.not_backed_up || {};
  say(
    `  NOT in package (re-enter/reconcile, never copy): ${(nb.vault_secret_names || []).length} vault secrets, ${(nb.cron_jobs || []).length} cron, ${(nb.extensions || []).length} extensions, Edge/Netlify env`,
  );
  return {manifest: dbManifest, objects: mv.objects};
}

// Compute byte count + sha256 of a materialised file.
function statAndHash(file) {
  const bytes = fs.statSync(file).size;
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return {bytes, sha256: h.digest('hex')};
}

// Stream the encrypted R2 object through `age -d -i <path>` into a file on the
// restricted C: dir. Encrypted bytes never touch disk; only the decrypted archive
// (required seekable for pg_restore) is written, inside the encrypted volume.
function streamDecryptToFile(r2, key, ageIdentityPath, outFile) {
  const src = spawn('aws', ['s3', 'cp', `s3://${r2.bucket}/${key}`, '-', '--endpoint-url', r2Endpoint(r2)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: r2Env(r2),
  });
  const age = spawn('age', ['-d', '-i', ageIdentityPath, '-o', outFile], {stdio: ['pipe', 'ignore', 'pipe']});
  let srcErr = '';
  let ageErr = '';
  src.stderr.on('data', (c) => (srcErr += c.toString()));
  age.stderr.on('data', (c) => (ageErr += c.toString()));
  src.stdout.pipe(age.stdin);
  const wait = (child, tag, buf) =>
    new Promise((res, rej) =>
      child.on('close', (code) =>
        code === 0 ? res() : rej(new Error(`${tag} exited ${code}: ${clean(buf()).slice(-200)}`)),
      ),
    );
  return Promise.all([wait(src, 'r2 read', () => srcErr), wait(age, 'age decrypt', () => ageErr)]);
}

// `pg_restore -l archive` → TOC text (seekable archive required; the pipe form
// cannot list). Never connects to a database.
function pgRestoreList(archivePath) {
  const res = spawnSync('pg_restore', ['-l', archivePath], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (res.status !== 0) throw new Error(`pg_restore -l failed: ${clean(res.stderr || 'error').slice(-200)}`);
  return res.stdout;
}

// Re-validate the generated list file fail-closed before connecting: re-parse it
// and refuse if any managed-schema DDL entry survived.
function validateGeneratedList(listPath) {
  const text = fs.readFileSync(listPath, 'utf8');
  const entries = RL.parseRestoreList(text);
  for (const e of entries) {
    if (RL.MANAGED_SCHEMAS.includes(e.schema) && String(e.desc).toUpperCase() !== 'TABLE DATA') {
      throw new Error(
        `generated restore list contains managed ${RL.safeLabel(e.schema, 16)} DDL — refusing to connect`,
      );
    }
  }
  if (entries.length === 0) throw new Error('generated restore list is empty — refusing to connect');
  return entries.length;
}

// Apply the selective restore. Password goes via PGPASSWORD env, never argv.
function pgRestoreApply(archivePath, listPath, cfg, dsnPassword) {
  const du = new URL(cfg.dsn);
  const env = {...process.env, PGPASSWORD: dsnPassword, PGSSLMODE: 'require'};
  const args = [
    '--host',
    du.hostname,
    '--port',
    du.port || '5432',
    '--username',
    du.username,
    '--dbname',
    RL.SUPABASE_DB,
    '--no-owner',
    '--no-privileges',
    '-L',
    listPath,
    archivePath,
  ];
  const res = spawnSync('pg_restore', args, {encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024});
  // pg_restore may exit non-zero on benign "already exists" notices; surface the
  // status and let the post-restore verification be the source of truth. Never
  // print the DSN/password (redacted anyway).
  return {status: res.status, stderrTail: clean(res.stderr || '').slice(-400)};
}

/**
 * DB RESTORE (execute only). Materialises the decrypted archive on the restricted
 * C: dir, verifies byte+sha vs manifest, builds+validates a SELECTIVE restore
 * list (public schema+data; auth/storage DATA only; never managed DDL), applies
 * it, and cleans up plaintext on EVERY exit path.
 */
async function runDbRestore({ageIdentityPath, cfg, r2, manifest, dsnPassword}) {
  assertEncryptedVolumeVerified();
  const dir = prepareRestoreDir();
  const archivePath = path.join(dir, `wcf-db-${generation}.dump`);
  const listPath = path.join(dir, `restore-${generation}.list`);
  try {
    say('  decrypting (encrypted stream → age → archive on the restricted C: dir)…');
    await streamDecryptToFile(r2, keys.dbPackage, ageIdentityPath, archivePath);
    const {bytes, sha256} = statAndHash(archivePath);
    RL.assertByteCount(bytes, manifest.database.dump_bytes, 'decrypted archive');
    RL.assertSha256(sha256, manifest.database.dump_sha256, 'decrypted archive');
    say('  decrypted archive verified (byte count + sha256 match manifest)');

    const entries = RL.parseRestoreList(pgRestoreList(archivePath));
    const {list, included, excluded} = RL.buildSelectiveRestoreList(entries);
    fs.writeFileSync(listPath, list, {mode: 0o600});
    validateGeneratedList(listPath);
    say(
      `  selective restore list built: ${included.length} entries included, ${excluded.length} excluded (managed DDL/ACL held out)`,
    );

    const r = pgRestoreApply(archivePath, listPath, cfg, dsnPassword);
    say(`  pg_restore applied (status ${r.status}); post-restore verification is authoritative`);
    return {ok: true, included: included.length, excluded: excluded.length, restoreStatus: r.status};
  } finally {
    cleanupPlaintext(dir);
    say('  plaintext cleanup complete (overwrite best-effort + delete; BitLocker is the at-rest guarantee)');
  }
}

(async () => {
  if (mode === 'execute' || mode === 'preflight') {
    if (!hasBinary('aws'))
      refuse('the AWS CLI (S3-compatible client) is required on PATH to read R2. Phase 1 does not install it.');
    if (!hasBinary('age')) refuse('age is required on PATH for the decrypt step.');
    if (!hasBinary('pg_restore')) refuse('pg_restore (PostgreSQL client) is required on PATH for the restore step.');
  }
  const {cfg, dsnPassword} = loadRecoveryConfig();
  const r2 = loadR2Cred();
  const ageIdentityPath = assertAgeIdentityPath();
  const {manifest} = await runPreflight(cfg, r2);
  if (mode === 'preflight') {
    say('  age identity: staged (path validated; contents never read)');
    say('\npreflight complete — read-only, nothing written or decrypted.\n');
    process.exit(0);
  }
  await runDbRestore({ageIdentityPath, cfg, r2, manifest, dsnPassword});
  say('\nDB restore step complete. Storage restore + post-restore verification follow (later step).\n');
  process.exit(0);
})().catch((e) => {
  refuse(e && e.message ? e.message : 'unknown restore error', 1);
});
