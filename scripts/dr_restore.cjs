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
// Plaintext restore directory lifecycle (Option B, C:/BitLocker). The single
// approved plaintext root is FIXED; there is no caller-selected alternate.
const RESTORE_ROOT = 'C:\\wcf-dr-restore';
let ACTIVE_PLAINTEXT_DIR = null;

// Track live child processes so a handled cancellation can terminate them BEFORE
// cleanup (a running age/aws could still be writing into the restore dir).
const CHILDREN = new Set();
function trackChild(child) {
  CHILDREN.add(child);
  if (child && typeof child.on === 'function') child.on('close', () => CHILDREN.delete(child));
  return child;
}
function killChildren() {
  for (const c of CHILDREN) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  CHILDREN.clear();
}

// Overwrite the COMPLETE file in bounded chunks, fsync, close, then delete; then
// verify the directory is gone. Returns {ok, remaining}. BitLocker/device
// encryption is the PRIMARY at-rest protection — SSD wear-levelling means an
// overwrite cannot be guaranteed to erase underlying blocks, so the contract is
// encryption + deletion, not secure-erase. NEVER clears the active-path marker
// while anything remains, and forces a loud failure on residue.
function cleanupPlaintext(dir) {
  if (!dir) return {ok: true, remaining: 0};
  try {
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        const f = path.join(dir, name);
        try {
          const sz = fs.statSync(f).size;
          const fd = fs.openSync(f, 'r+');
          try {
            const chunk = Buffer.alloc(1 << 20, 0);
            for (let off = 0; off < sz; off += chunk.length) {
              fs.writeSync(fd, chunk, 0, Math.min(chunk.length, sz - off), off);
            }
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          /* overwrite is best-effort; the deletion below is what matters */
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
    /* fall through to the residue check */
  }
  let remaining = 0;
  try {
    remaining = fs.existsSync(dir) ? fs.readdirSync(dir).length + 1 : 0;
  } catch {
    remaining = fs.existsSync(dir) ? 1 : 0;
  }
  if (remaining > 0) {
    // Loud failure; do NOT clear ACTIVE_PLAINTEXT_DIR while residue remains.
    console.error(clean('CRITICAL: plaintext restore directory could NOT be removed — manual remediation required'));
    return {ok: false, remaining};
  }
  if (ACTIVE_PLAINTEXT_DIR === dir) ACTIVE_PLAINTEXT_DIR = null;
  return {ok: true, remaining: 0};
}

// Cleanup on any exit path (Node skips finally on signal death); kill children
// first so nothing is still writing plaintext.
process.on('exit', () => cleanupPlaintext(ACTIVE_PLAINTEXT_DIR));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    killChildren();
    cleanupPlaintext(ACTIVE_PLAINTEXT_DIR);
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  killChildren();
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
  const rootAbs = path.resolve(RESTORE_ROOT);
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
  const src = trackChild(
    spawn('aws', ['s3', 'cp', `s3://${r2.bucket}/${key}`, '-', '--endpoint-url', r2Endpoint(r2)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: r2Env(r2),
    }),
  );
  const age = trackChild(
    spawn('age', ['-d', '-i', ageIdentityPath, '-o', outFile], {stdio: ['pipe', 'ignore', 'pipe']}),
  );
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

// Re-validate the generated list fail-closed before connecting: re-parse it and
// confirm EVERY surviving entry still decides 'include' by desc + schema + tag
// (so no managed DDL, no storage.objects, no ACL/OWNER, and no un-approved
// global/other entry can reach the recovery database).
function validateGeneratedList(listPath) {
  const entries = RL.parseRestoreList(fs.readFileSync(listPath, 'utf8'));
  if (entries.length === 0) throw new Error('generated restore list is empty — refusing to connect');
  for (const e of entries) {
    if (RL.tocDecision(e) !== 'include') {
      throw new Error(
        `generated restore list has a non-included entry (${RL.safeLabel(`${e.desc} ${e.schema} ${e.tag}`, 60)}) — refusing to connect`,
      );
    }
  }
  return entries.length;
}

// Run a READ-ONLY SQL query against the recovery DB. Password via PGPASSWORD env,
// never argv (the DSN is parsed only for host/port/user). Returns tab-split rows.
function psqlQuery(cfg, dsnPassword, sql) {
  const du = new URL(cfg.dsn);
  const env = {...process.env, PGPASSWORD: dsnPassword, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '30'};
  const args = [
    '--host',
    du.hostname,
    '--port',
    du.port || '5432',
    '--username',
    du.username,
    '--dbname',
    RL.SUPABASE_DB,
    '-tAF\t',
    '-c',
    sql,
  ];
  const res = spawnSync('psql', args, {encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024});
  if (res.status !== 0) throw new Error(`psql query failed: ${clean(res.stderr || 'error').slice(-300)}`);
  return res.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

// Destination-state preflight — BEFORE the first write. Verifies the target is a
// FRESH recovery project: managed schemas + allowlisted tables (and
// storage.objects) exist; public has no user BASE TABLES; the allowlisted managed
// tables AND storage.objects are empty; and the manifest's required extensions
// are present (missing ones must be reconciled via an explicit reviewed plan, not
// auto-installed here). Runs after the destination guard, before pg_restore.
function destinationPreflight(cfg, dsnPassword, manifest) {
  const [[schemaCount]] = psqlQuery(
    cfg,
    dsnPassword,
    "select count(*) from information_schema.schemata where schema_name in ('auth','storage')",
  );
  if (Number(schemaCount) !== 2) throw new Error('recovery project is missing managed auth/storage schemas');
  for (const t of [...RL.MANAGED_DATA_ALLOWLIST, 'storage.objects']) {
    const [s, tab] = t.split('.');
    const [[n]] = psqlQuery(
      cfg,
      dsnPassword,
      `select count(*) from information_schema.tables where table_schema='${s}' and table_name='${tab}'`,
    );
    if (Number(n) !== 1) throw new Error(`recovery project is missing expected table ${t}`);
  }
  const [[pub]] = psqlQuery(
    cfg,
    dsnPassword,
    "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
  );
  if (Number(pub) !== 0)
    throw new Error(`recovery public schema is not empty (${RL.safeLabel(pub, 12)} base tables) — not a fresh project`);
  for (const t of [...RL.MANAGED_DATA_ALLOWLIST, 'storage.objects']) {
    const [[c]] = psqlQuery(cfg, dsnPassword, `select count(*) from ${t}`);
    if (Number(c) !== 0)
      throw new Error(`recovery ${t} is not empty (${RL.safeLabel(c, 12)} rows) — not a fresh project`);
  }
  const want = (manifest.not_backed_up && manifest.not_backed_up.extensions) || [];
  if (want.length) {
    const have = new Set(psqlQuery(cfg, dsnPassword, 'select extname from pg_extension').map((r) => r[0]));
    const missing = want.filter((e) => !have.has(e));
    if (missing.length)
      throw new Error(
        `recovery project is missing required extensions (${RL.safeLabel(missing.join(', '), 120)}); reconcile via an explicit reviewed plan before restore`,
      );
  }
  return {ok: true};
}

// STORAGE RESTORE (design; runs in a later live step). Streams each manifested R2
// body through the recovery project's official Storage API using the recovery
// service-role credential, with bounded concurrency + bounded disk (one staged
// object per worker), so storage.objects metadata is created normally. Fails
// closed on any partial upload, reports completed items, and never deletes the
// immutable R2 source. Only storage.buckets metadata comes from the DB archive;
// storage.objects rows are created by these uploads.
async function restoreStorage({cfg, r2, objects, serviceRoleKey}) {
  if (!serviceRoleKey)
    throw new Error('storage restore requires the recovery service-role key (recovery-config.serviceRoleKey)');
  const CONC = 4;
  const completed = [];
  const failures = [];
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcf-dr-stg-'));
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= objects.length) return;
      const o = objects[i];
      const stg = path.join(stageDir, `obj-${i}`);
      try {
        // Bounded disk: stage one body, upload, delete.
        execFileSync(
          'aws',
          [
            's3api',
            'get-object',
            '--bucket',
            r2.bucket,
            '--key',
            keys.storageObjectKey(o.bucket, o.path),
            '--endpoint-url',
            r2Endpoint(r2),
            stg,
          ],
          {stdio: ['ignore', 'ignore', 'pipe'], env: r2Env(r2)},
        );
        const body = fs.readFileSync(stg);
        const url = `${cfg.projectUrl}/storage/v1/object/${o.bucket}/${o.path.split('/').map(encodeURIComponent).join('/')}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceRoleKey}`,
            'x-upsert': 'false',
            'content-type': 'application/octet-stream',
          },
          body,
        });
        if (!resp.ok) throw new Error(`storage upload ${resp.status}`);
        completed.push({bucket: o.bucket, path: o.path, size: body.length});
      } catch (e) {
        failures.push({object: `${o.bucket}/${o.path}`, error: clean(String((e && e.message) || e)).slice(-160)});
      } finally {
        try {
          fs.rmSync(stg, {force: true});
        } catch {
          /* best effort */
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({length: Math.min(CONC, objects.length)}, worker));
  } finally {
    try {
      fs.rmSync(stageDir, {recursive: true, force: true});
    } catch {
      /* best effort */
    }
  }
  if (failures.length) {
    const err = new Error(
      `storage restore failed: ${completed.length}/${objects.length} uploaded, ${failures.length} failed (immutable R2 source left intact)`,
    );
    err.completed = completed;
    err.failures = failures;
    throw err;
  }
  // Verify count + path + size against the manifest.
  const cov = RL.verifyStorageCoverage(objects, completed);
  if (!cov.ok) throw new Error(`storage restore coverage mismatch: ${RL.safeLabel(cov.errors.join('; '), 200)}`);
  return {ok: true, uploaded: completed.length};
}

// POST-RESTORE VERIFICATION scaffolding (runs in the later live step). Recovery is
// NOT complete on pg_restore status alone; these produce independent evidence:
// application row counts by table, an Auth login with a restored user, private
// Storage retrieval, presence of processing/tasks/comments/submissions records,
// and an explicit Vault/cron/environment reconciliation list.
function planPostRestoreVerification(manifest) {
  return {
    dbRowCounts: [
      'cattle',
      'sheep',
      'poultry_dailys',
      'tasks_v2',
      'comments',
      'processing_records',
      'webform_submissions',
    ],
    authLogin: 'sign in as a known restored auth.users account against the recovery anon endpoint',
    privateStorage: 'create a signed URL for a private daily-photos object and fetch it',
    appRecords: ['processing_records', 'tasks_v2', 'comments', 'todo_items', 'webform_submissions'],
    reconcile: {
      vault_secret_names: (manifest.not_backed_up && manifest.not_backed_up.vault_secret_names) || [],
      cron_jobs: (manifest.not_backed_up && manifest.not_backed_up.cron_jobs) || [],
      external: (manifest.not_backed_up && manifest.not_backed_up.external) || [],
    },
  };
}

// Apply the selective restore, FAIL-CLOSED. --exit-on-error makes pg_restore stop
// on the first error; a nonzero status THROWS and stops immediately. The password
// goes via PGPASSWORD env, never on argv; the DSN is only parsed for host/port/
// user. Post-restore verification is additional evidence, not permission to
// ignore a restore error.
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
    '--exit-on-error',
    '-L',
    listPath,
    archivePath,
  ];
  const res = spawnSync('pg_restore', args, {encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024});
  if (res.status !== 0) {
    throw new Error(`pg_restore failed (status ${res.status}): ${clean(res.stderr || 'error').slice(-400)}`);
  }
  return {status: 0};
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

    const {list, included, excluded} = RL.buildSelectiveRestoreList(RL.parseRestoreList(pgRestoreList(archivePath)));
    fs.writeFileSync(listPath, list, {mode: 0o600});
    validateGeneratedList(listPath);
    say(
      `  selective list: ${included.length} included, ${excluded.length} excluded (managed DDL/ACL/storage.objects held out)`,
    );

    // Destination-state preflight BEFORE the first write: verify a FRESH project.
    destinationPreflight(cfg, dsnPassword, manifest);
    say('  destination verified as a fresh recovery project');

    pgRestoreApply(archivePath, listPath, cfg, dsnPassword); // --exit-on-error; throws on any error
    say('  pg_restore applied with --exit-on-error (completed without error)');
    return {ok: true, included: included.length, excluded: excluded.length};
  } finally {
    const c = cleanupPlaintext(dir);
    if (c.ok)
      say(
        '  plaintext cleanup verified (full overwrite + delete + confirmed gone; BitLocker is the at-rest guarantee)',
      );
    else
      console.error(clean(`  PLAINTEXT CLEANUP FAILED — ${c.remaining} item(s) remain; manual remediation required`));
  }
}

(async () => {
  if (mode === 'execute' || mode === 'preflight') {
    if (!hasBinary('aws'))
      refuse('the AWS CLI (S3-compatible client) is required on PATH to read R2. Phase 1 does not install it.');
    if (!hasBinary('age')) refuse('age is required on PATH for the decrypt step.');
    if (!hasBinary('pg_restore')) refuse('pg_restore (PostgreSQL client) is required on PATH for the restore step.');
    if (!hasBinary('psql')) refuse('psql (PostgreSQL client) is required on PATH for the destination-state preflight.');
  }
  const {cfg, dsnPassword} = loadRecoveryConfig();
  const r2 = loadR2Cred();
  const ageIdentityPath = assertAgeIdentityPath();
  const {manifest, objects} = await runPreflight(cfg, r2);
  if (mode === 'preflight') {
    say('  age identity: staged (path validated; contents never read)');
    say('\npreflight complete — read-only, nothing written or decrypted.\n');
    process.exit(0);
  }
  const dbRes = await runDbRestore({ageIdentityPath, cfg, r2, manifest, dsnPassword});
  say(`\nDB restore complete: ${dbRes.included} objects restored selectively.`);
  const storageRes = await restoreStorage({cfg, r2, objects, serviceRoleKey: cfg.serviceRoleKey});
  say(`storage restore complete: ${storageRes.uploaded}/${objects.length} objects uploaded + verified.`);
  const plan = planPostRestoreVerification(manifest);
  say(
    `post-restore verification (recovery is NOT complete on pg_restore status alone): ${plan.dbRowCounts.length} table counts, auth login, private storage, ${plan.appRecords.length} app-record checks; reconcile ${plan.reconcile.vault_secret_names.length} vault + ${plan.reconcile.cron_jobs.length} cron + ${plan.reconcile.external.length} external.`,
  );
  say('\nRestore step complete. Produce the post-restore verification evidence before calling recovery complete.\n');
  process.exit(0);
})().catch((e) => {
  refuse(e && e.message ? e.message : 'unknown restore error', 1);
});
