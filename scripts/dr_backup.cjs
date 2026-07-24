// Disaster-recovery BACKUP RUNNER (Build Queue item 1).
//
// Produces one backup generation: a streamed, client-side-encrypted logical
// database package, an incremental storage inventory, an integrity manifest,
// and the upload to the two independent providers.
//
// DRY RUN IS THE DEFAULT AND UPLOADS NOTHING. The B2 bucket has Object Lock
// enabled, so an uploaded object cannot be deleted before its retention
// expires. Dry run exists so the manifest and key layout can be reviewed
// BEFORE the first write becomes immutable.
//
// Usage:
//   node scripts/dr_backup.cjs --env=prod                    (dry run)
//   node scripts/dr_backup.cjs --env=prod --prev=<manifest>  (incremental)
//   node scripts/dr_backup.cjs --env=prod --out=<dir>        (keep manifest)
//   node scripts/dr_backup.cjs --env=prod --preflight        (provider check, no write)
//   node scripts/dr_backup.cjs --env=prod --execute          (upload; gated)
//   ... --execute --database-only    (explicitly accept a DB-only generation)
//
// UPLOAD ORDER IS PAYLOAD -> STORAGE BODIES -> MANIFESTS LAST. The manifest is
// the authoritative record of a generation AND the input to the next run's
// incremental diff, so publishing it before its payload is stored would both
// overstate the backup and make the next run skip objects that were never
// transferred. Any earlier failure aborts before the manifest is written.
//
// RETENTION: the per-object windows are a MINIMUM IMMUTABILITY floor, not an
// expiry schedule. Nothing here deletes anything, B2 has no lifecycle rule, and
// the writer key has no delete capability, so objects are stored INDEFINITELY.
// Do not describe this as enforcing "48 hourly generations" — it does not.
//
// PLAINTEXT NEVER TOUCHES DISK, IN EITHER MODE. pg_dump's stdout is piped
// straight into age; only ciphertext is ever written. When no recipient is
// configured, the dump is streamed through a hash and discarded so a dry run
// can still measure it without materialising a readable dump. The dump carries
// auth.users rows (real emails and password hashes), so this is the property
// that matters most in this file.
//
// Provider configuration (verified before this was written):
//   B2  wcf-planner-dr-primary-2026 @ s3.us-east-005.backblazeb2.com
//       private, SSE-B2, Object Lock ON, default governance 2 days.
//       Writer key capabilities: listBuckets, writeFiles, writeFileRetentions.
//       NO deleteFiles, NO bypassGovernance. This runner therefore never
//       deletes or overwrites-with-delete; retention promotion is copy-only.
//   R2  wcf-planner-dr-secondary-2026, private, prefix lock rules configured.
//       No object versioning, so every R2 key carries the run timestamp.
//
// Exit codes: 0 ok; 1 a step failed; 2 usage/config refusal.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {execFileSync, spawn} = require('child_process');
const L = require('./lib/dr_layout.cjs');
const O = require('./lib/dr_orchestrate.cjs');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const arg = (k, d = null) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

const env = arg('env');
if (env !== 'prod' && env !== 'test') {
  console.error('refusing: --env=prod or --env=test is required (no default target)');
  process.exit(2);
}
const execute = flag('execute');
const preflight = flag('preflight');
// Deliberately produce a generation WITHOUT storage file bodies. Without this
// opt-in, --execute refuses when bodies are pending and no Supabase read
// credential is configured, rather than silently producing a database-only
// backup that reads as complete.
const databaseOnly = flag('database-only');
const tier = arg('tier', 'hourly');

// TEST has NO PostgreSQL DSN. WCF_TEST_DATABASE is a boolean safety FLAG ("=1
// means I really mean TEST"), not a connection string, and the repo reaches TEST
// only through the Supabase JS client and the exec_sql RPC. An earlier version
// of this file read that flag as a DSN, which would have built the nonsense
// connection string "1". Refuse loudly instead of failing obscurely at connect.
if (env === 'test') {
  console.error('refusing: --env=test is not supported. TEST has no PostgreSQL DSN.');
  console.error('  WCF_TEST_DATABASE is a safety flag (=1), not a connection string;');
  console.error('  the repo reaches TEST via the Supabase client + exec_sql, and pg_dump');
  console.error('  needs a real DSN. Backups target PROD only.');
  process.exit(2);
}

const root = path.resolve(__dirname, '..');
loadDotEnv(path.join(root, '.env.prod.local'));
const DB_URL = process.env.PROD_DB_URL;
if (!DB_URL) {
  console.error('refusing: PROD_DB_URL is not set');
  process.exit(2);
}

// Every value that must never appear in output, for redaction of child stderr.
const SECRETS = [
  DB_URL,
  process.env.DR_B2_APPLICATION_KEY,
  process.env.DR_B2_KEY_ID,
  process.env.DR_R2_SECRET_ACCESS_KEY,
  process.env.DR_R2_ACCESS_KEY_ID,
  process.env.DR_STORAGE_S3_SECRET_ACCESS_KEY,
  process.env.DR_STORAGE_S3_ACCESS_KEY_ID,
].filter(Boolean);
const clean = (t) => L.redactSecrets(t, SECRETS);

// Execute mode is fail-closed: refuse unless EVERY provider value is present.
// A partially configured run could upload to one provider only, leaving a
// single point of failure that still looks like a success.
if (execute || preflight) {
  const missing = L.missingExecuteConfig(process.env);
  if (missing.length > 0) {
    console.error(`refusing: --${execute ? 'execute' : 'preflight'} requires complete provider configuration.`);
    console.error(`  missing: ${missing.join(', ')}`);
    console.error('  (names only; no value is ever printed)');
    process.exit(2);
  }
  if (!hasBinary('aws')) {
    console.error(`refusing: --${execute ? 'execute' : 'preflight'} needs the AWS CLI (S3-compatible client) on PATH.`);
    process.exit(2);
  }
}

function hasBinary(bin) {
  try {
    execFileSync(bin, ['--version'], {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

const SEP = '\x1f';
function q(sql) {
  try {
    return execFileSync('psql', [DB_URL, '-tAF', SEP, '-c', sql], {
      encoding: 'utf8',
      env: {...process.env, PGCONNECT_TIMEOUT: '30'},
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split(SEP));
  } catch (e) {
    console.error(clean(`probe failed: ${e.message || 'psql error'}`));
    process.exit(1);
  }
}

const runId = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\.\d{3}Z$/, 'Z');

// Work dir holds CIPHERTEXT only. Cleanup is idempotent and registered on exit
// AND on every terminating signal: Node does not run finally blocks on signal
// death, and an earlier plain try/finally left a real PROD dump on disk when a
// run was SIGTERMed. CI cancellation would do the same.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcf-dr-'));

// Child tracking + cleanup come from the pure orchestration module so their
// ordering (kill children BEFORE removing files) is behaviorally tested. A live
// transfer child could still be writing into workDir; killing first prevents
// that. Cleanup is idempotent and registered on exit AND every terminating
// signal, because Node does not run finally blocks on signal death — an earlier
// plain try/finally left a real PROD dump on disk when a run was SIGTERMed.
const childRegistry = O.createChildRegistry();
const cleanup = O.createCleanup({
  killChildren: () => childRegistry.killAll(),
  removeWorkDir: () => {
    try {
      fs.rmSync(workDir, {recursive: true, force: true});
    } catch {
      /* best effort; never mask the original failure */
    }
  },
});
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  cleanup();
  console.error(clean(`FAILED: ${e.message?.split('\n')[0] || 'uncaught'}`));
  process.exit(1);
});

const say = (s = '') => console.log(s);
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

/**
 * Stream pg_dump straight into age. Plaintext exists only in the pipe.
 *
 * Both exit codes are checked. This is not defensive padding: if pg_dump dies
 * partway, age happily encrypts the truncated bytes it already received and
 * exits 0, producing a VALID age file containing an INCOMPLETE dump. Trusting
 * age's status alone would silently ship corrupt backups.
 */
function dumpAndEncrypt(recipient) {
  return new Promise((resolve, reject) => {
    const encPath = recipient ? path.join(workDir, `wcf-db-${runId}.dump.age`) : null;
    const plainHash = crypto.createHash('sha256');
    const encHash = crypto.createHash('sha256');
    let plainBytes = 0;
    let encBytes = 0;
    const errors = [];

    const dump = spawn(
      'pg_dump',
      [DB_URL, '-Fc', '-Z6', '--no-owner', '--no-privileges', '-n', 'public', '-n', 'auth', '-n', 'storage'],
      {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PGCONNECT_TIMEOUT: '60'}},
    );
    let dumpStderr = '';
    dump.stderr.on('data', (c) => (dumpStderr += c.toString()));
    dump.stdout.on('data', (c) => {
      plainHash.update(c);
      plainBytes += c.length;
    });

    const finishers = [];
    if (recipient) {
      const enc = spawn('age', ['-r', recipient], {stdio: ['pipe', 'pipe', 'pipe']});
      let encStderr = '';
      enc.stderr.on('data', (c) => (encStderr += c.toString()));
      enc.stdout.on('data', (c) => {
        encHash.update(c);
        encBytes += c.length;
      });
      const out = fs.createWriteStream(encPath);
      enc.stdout.pipe(out);
      dump.stdout.pipe(enc.stdin);
      finishers.push(
        new Promise((res) =>
          enc.on('close', (code) => {
            if (code !== 0) errors.push(`age exited ${code}: ${clean(encStderr).slice(0, 200)}`);
            res();
          }),
        ),
        new Promise((res) => out.on('close', res)),
      );
    } else {
      // No recipient: measure by draining the stream. Nothing is written.
      dump.stdout.resume();
    }

    finishers.push(
      new Promise((res) =>
        dump.on('close', (code) => {
          if (code !== 0) errors.push(`pg_dump exited ${code}: ${clean(dumpStderr).slice(0, 200)}`);
          res();
        }),
      ),
    );

    Promise.all(finishers)
      .then(() => {
        if (errors.length) return reject(new Error(errors.join(' | ')));
        if (plainBytes === 0) return reject(new Error('pg_dump produced no output'));
        if (recipient && encBytes === 0) return reject(new Error('age produced no ciphertext'));
        resolve({
          encPath,
          plainBytes,
          encBytes: recipient ? encBytes : null,
          plainSha: plainHash.digest('hex'),
          encSha: recipient ? encHash.digest('hex') : null,
        });
      })
      .catch(reject);
  });
}

/** Shared AWS CLI environment for a provider. Credentials go by env, never argv. */
function awsEnvFor(provider) {
  const isB2 = provider === 'b2';
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: isB2 ? process.env.DR_B2_KEY_ID : process.env.DR_R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: isB2 ? process.env.DR_B2_APPLICATION_KEY : process.env.DR_R2_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: isB2 ? 'us-east-005' : 'auto',
    // R2 rejects the CRC32 checksum newer AWS CLI versions add by default.
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
  };
}

function endpointFor(provider) {
  const raw = provider === 'b2' ? process.env.DR_B2_ENDPOINT : process.env.DR_R2_ENDPOINT;
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

/** Run an aws s3api subcommand read-only. Returns {ok, out|error}; never throws. */
function awsRead(provider, args) {
  try {
    const out = execFileSync('aws', ['s3api', ...args, '--endpoint-url', endpointFor(provider)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: awsEnvFor(provider),
    });
    return {ok: true, out};
  } catch (e) {
    return {ok: false, error: clean(e.stderr?.toString() || e.message || 'aws call failed').slice(0, 300)};
  }
}

/**
 * Non-destructive provider preflight. Authenticates and checks bucket
 * reachability WITHOUT writing an object, so credential/endpoint/bucket
 * mistakes surface before the first immutable B2 write.
 *
 * Deliberately asymmetric, because the two credentials are scoped differently:
 *   B2  writer key holds listBuckets + writeFiles + writeFileRetentions only.
 *       It has NO listFiles and NO readFiles, so ListObjects and HeadObject
 *       are EXPECTED to fail and are not attempted. list-buckets is the only
 *       meaningful check available, and it proves credentials + bucket
 *       existence but NOT writability.
 *   R2  token is Object Read & Write scoped to the bucket, so head-bucket and
 *       a 1-key list are both valid and prove real bucket-level access.
 * Requests no delete and no governance-bypass capability.
 */
function runPreflight() {
  const results = [];

  // The B2 writer key is deliberately bucket-scoped (listBuckets + writeFiles +
  // writeFileRetentions only). B2 maps the S3 ListBuckets operation to the
  // ACCOUNT-level listAllBucketNames capability, which this key does not hold,
  // so ListBuckets returns AccessDenied "not entitled" even when the credentials
  // are valid — the credential authenticated, it simply is not authorized for an
  // account-wide op. HeadBucket on THIS bucket is satisfied by listBuckets and is
  // the correct read-only proof of credentials + endpoint + bucket for a
  // bucket-scoped key. (A truly bad credential fails earlier with
  // InvalidAccessKeyId / SignatureDoesNotMatch, not "not entitled".)
  const b2Bucket = process.env.DR_B2_BUCKET;
  const hbB2 = awsRead('b2', ['head-bucket', '--bucket', b2Bucket]);
  results.push({
    provider: 'B2',
    check: 'credentials valid + bucket reachable (head-bucket)',
    ok: hbB2.ok,
    detail: hbB2.ok ? `${b2Bucket} reachable` : hbB2.error,
  });

  const r2Bucket = process.env.DR_R2_BUCKET;
  const hb = awsRead('r2', ['head-bucket', '--bucket', r2Bucket]);
  results.push({
    provider: 'R2',
    check: 'head-bucket',
    ok: hb.ok,
    detail: hb.ok ? `${r2Bucket} reachable` : hb.error,
  });
  if (hb.ok) {
    const ls = awsRead('r2', ['list-objects-v2', '--bucket', r2Bucket, '--max-keys', '1']);
    results.push({
      provider: 'R2',
      check: 'list-objects-v2 (read access)',
      ok: ls.ok,
      detail: ls.ok ? 'readable' : ls.error,
    });
  }
  return results;
}

// Every spawned child is tracked in the shared registry so cancellation can
// terminate the whole tree (a transfer runs two children at once).
function spawnTracked(bin, args, opts) {
  return childRegistry.track(spawn(bin, args, opts));
}

/** AWS CLI environment for reading Supabase Storage. Credentials by env only. */
function supabaseEnv() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.DR_STORAGE_S3_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.DR_STORAGE_S3_SECRET_ACCESS_KEY,
    AWS_DEFAULT_REGION: process.env.DR_STORAGE_S3_REGION,
    AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required',
  };
}

/**
 * Stream ONE object from Supabase Storage into ONE provider. Nothing is staged
 * on disk: the source read is piped directly into the destination write.
 *
 * Uses the high-level `aws s3 cp` on both ends because s3api put-object needs a
 * seekable body and a pipe is not seekable. `cp` decides upload vs download by
 * argument ORDER, so the source side is asserted download-only first — a
 * transposition would otherwise write to production Storage.
 *
 * Both child exit codes are checked. Same lesson as the pg_dump pipeline: a
 * source that dies partway can leave the destination believing it received a
 * complete (but truncated) object.
 */
function streamOneObject(obj, provider, destKey) {
  return new Promise((resolve, reject) => {
    const srcUri = `s3://${obj.bucket}/${obj.path}`;
    L.assertSupabaseDownloadOnly(srcUri, '-');

    const destBucket = provider === 'b2' ? process.env.DR_B2_BUCKET : process.env.DR_R2_BUCKET;
    const errors = [];

    const src = spawnTracked('aws', ['s3', 'cp', srcUri, '-', '--endpoint-url', supabaseEndpoint()], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: supabaseEnv(),
    });
    const dest = spawnTracked(
      'aws',
      [
        's3',
        'cp',
        '-',
        `s3://${destBucket}/${destKey}`,
        '--endpoint-url',
        endpointFor(provider),
        '--expected-size',
        String(obj.size),
      ],
      {stdio: ['pipe', 'ignore', 'pipe'], env: awsEnvFor(provider)},
    );

    let srcErr = '';
    let destErr = '';
    src.stderr.on('data', (c) => (srcErr += c.toString()));
    dest.stderr.on('data', (c) => (destErr += c.toString()));
    src.stdout.pipe(dest.stdin);

    Promise.all([
      new Promise((res) =>
        src.on('close', (code) => {
          if (code !== 0) errors.push(`source read exited ${code}: ${clean(srcErr).slice(0, 160)}`);
          res();
        }),
      ),
      new Promise((res) =>
        dest.on('close', (code) => {
          if (code !== 0) errors.push(`dest write exited ${code}: ${clean(destErr).slice(0, 160)}`);
          res();
        }),
      ),
    ]).then(() => (errors.length ? reject(new Error(errors.join(' | '))) : resolve()));
  });
}

function supabaseEndpoint() {
  const raw = process.env.DR_STORAGE_S3_ENDPOINT;
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

/**
 * B2 storage objects need 35 days of immutability, but the bucket default is
 * only 2 and `aws s3 cp` cannot carry object-lock headers. So retention is set
 * as a second call, which is exactly why the writer key was granted
 * writeFileRetentions. A failure here is a REAL failure: the object would
 * otherwise sit at the 2-day default rather than the required 35.
 */
function setB2Retention(key) {
  const retention = JSON.stringify({Mode: 'GOVERNANCE', RetainUntilDate: L.retainUntilForKey(key, new Date())});
  try {
    execFileSync(
      'aws',
      [
        's3api',
        'put-object-retention',
        '--bucket',
        process.env.DR_B2_BUCKET,
        '--key',
        key,
        '--retention',
        retention,
        '--endpoint-url',
        endpointFor('b2'),
      ],
      {stdio: ['ignore', 'ignore', 'pipe'], env: awsEnvFor('b2')},
    );
    return {ok: true};
  } catch (e) {
    return {ok: false, error: clean(e.stderr?.toString() || e.message || 'retention failed').slice(0, 200)};
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ordering, retry, bounded concurrency, and the payload -> storage -> manifest
// sequence all live in scripts/lib/dr_orchestrate.cjs, wired below with the real
// aws-CLI ops. That module is behaviorally tested with in-memory fakes.

/** Upload one object. B2 carries an explicit per-object governance retention. */
function putObject(provider, key, bodyPath) {
  const isB2 = provider === 'b2';
  const bucket = isB2 ? process.env.DR_B2_BUCKET : process.env.DR_R2_BUCKET;
  const args = [
    's3api',
    'put-object',
    '--bucket',
    bucket,
    '--key',
    key,
    '--body',
    bodyPath,
    '--endpoint-url',
    endpointFor(provider),
  ];
  if (isB2) {
    // B2 REQUIRES a Content-MD5 or x-amz-checksum-* header on any Put Object that
    // carries Object Lock parameters (it returns InvalidRequest without one). The
    // shared awsEnvFor sets AWS_REQUEST_CHECKSUM_CALCULATION=when_required so R2
    // does not reject the CLI's default CRC32; "when_required" does NOT add a
    // checksum for this B2 object-lock put, so supply an explicit Content-MD5 —
    // the original, universally accepted S3 object-lock requirement. This is added
    // only on the B2 branch, so R2 is unaffected. Bodies routed through put-object
    // are small (the encrypted DB package and the JSON manifests); storage bodies
    // use `aws s3 cp` and set retention separately.
    const contentMd5 = crypto.createHash('md5').update(fs.readFileSync(bodyPath)).digest('base64');
    // The bucket default is only 2 days; daily/monthly/storage must outlive it.
    args.push(
      '--content-md5',
      contentMd5,
      '--object-lock-mode',
      'GOVERNANCE',
      '--object-lock-retain-until-date',
      L.retainUntilForKey(key, new Date()),
    );
  }
  try {
    execFileSync('aws', args, {stdio: ['ignore', 'ignore', 'pipe'], env: awsEnvFor(provider)});
    return {ok: true};
  } catch (e) {
    return {ok: false, error: clean(e.stderr?.toString() || e.message || 'upload failed').slice(0, 300)};
  }
}

let exitCode = 0;
(async () => {
  try {
    say(`\nDR backup runner — ${env.toUpperCase()} — ${execute ? 'EXECUTE' : 'DRY RUN (uploads nothing)'}`);
    say('='.repeat(64));
    say(`run id: ${runId}   tier: ${tier}`);

    // Preflight runs BEFORE the ~55s dump: a credential or endpoint mistake
    // should surface in seconds, not after a full backup has been produced.
    if (preflight) {
      say(`\nprovider preflight — read-only, uploads nothing`);
      const results = runPreflight();
      for (const r of results) {
        say(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.provider}  ${r.check}`);
        say(`        ${r.detail}`);
      }
      say(`\n  CANNOT be verified before the first write:`);
      say(`    - B2 writability (the key has no readFiles/listFiles, by design)`);
      say(`    - whether B2 accepts the governance retain-until header`);
      say(`    - whether R2 accepts the checksum configuration`);
      say(`  Those are only proven by the first real put. Expect G6 to be the`);
      say(`  first true test of the write path.\n`);
      exitCode = results.every((r) => r.ok) ? 0 : 1;
      cleanup();
      process.exit(exitCode);
    }

    const [[serverVersion]] = q(`select current_setting('server_version')`);
    const recipient = process.env.DR_AGE_RECIPIENT || null;

    say(`\n[1/4] streamed dump + encryption  (plaintext never written to disk)`);
    const t0 = Date.now();
    const pkg = await dumpAndEncrypt(recipient);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    say(`      dump      ${mb(pkg.plainBytes)} in ${secs}s   sha256 ${pkg.plainSha.slice(0, 16)}…`);
    if (recipient) {
      say(`      encrypted ${mb(pkg.encBytes)}   sha256 ${pkg.encSha.slice(0, 16)}…`);
      say(`      recipient ${recipient.slice(0, 14)}…`);
    } else {
      say(`      encryption SKIPPED — DR_AGE_RECIPIENT not set; dump streamed to a hash and discarded`);
    }

    say(`\n[2/4] storage inventory`);
    const objects = q(`
      select o.bucket_id, o.name, (o.metadata->>'size')::bigint::text,
             replace(o.metadata->>'eTag', '"', ''), o.updated_at::text
      from storage.objects o order by o.bucket_id, o.name
    `).map(([bucket, p, size, etag, updated]) => ({bucket, path: p, size: Number(size), etag, updated_at: updated}));
    const totalBytes = objects.reduce((a, o) => a + o.size, 0);
    say(`      ${objects.length} objects, ${(totalBytes / 1024 ** 3).toFixed(2)} GB`);

    const prevFile = arg('prev');
    let prevObjects;
    if (prevFile) {
      if (!fs.existsSync(prevFile)) {
        console.error(`refusing: --prev file not found: ${prevFile}`);
        process.exit(2);
      }
      prevObjects = JSON.parse(fs.readFileSync(prevFile, 'utf8')).storage?.objects || [];
    }
    const diff = L.diffStorageObjects(objects, prevObjects);

    // The pure decision function is the authority on whether execute may proceed
    // and with what coverage. It refuses a full execute whose storage-source
    // credential is incomplete, naming only the missing variables.
    const decision = L.decideExecution({
      mode: execute ? 'execute' : 'dry-run',
      changedCount: diff.changed.length,
      databaseOnly,
      env: process.env,
    });
    if (decision.phase === 'refuse') {
      console.error(`refusing: ${diff.changed.length} storage objects need transfer but the Supabase`);
      console.error(`  Storage read credential is incomplete. Missing: ${decision.missing.join(', ')}`);
      console.error('  (names only; no value is ever printed)');
      console.error('  pass --database-only to deliberately accept a DATABASE-ONLY backup;');
      console.error('  that run protects the database and manifests but NOT files.');
      cleanup();
      process.exit(2);
    }
    if (prevFile) {
      const moved = diff.changed.reduce((a, o) => a + o.size, 0);
      say(
        `      incremental: ${diff.changed.length} new/changed (${mb(moved)}), ${diff.unchanged.length} unchanged, ${diff.removed.length} removed`,
      );
    } else {
      say(`      no --prev manifest: FULL baseline copy`);
    }

    const cronJobs = q(`select jobname, schedule from cron.job order by jobname`).map(([jobname, schedule]) => ({
      jobname,
      schedule,
    }));
    const vaultNames = q(`select name from vault.secrets order by name`).map(([n]) => n);
    const extensions = q(`select extname from pg_extension order by extname`).map(([e]) => e);
    let gitCommit = 'unknown';
    try {
      gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
    } catch {
      /* not fatal */
    }

    const dbKeys = L.databaseKeys(runId, tier);
    const storageManifest = L.storageManifestKey(runId);
    const manifest = {
      run_id: runId,
      env,
      tier,
      // Honest coverage label. A restore operator must be able to tell from the
      // manifest alone whether files were included, without reading prose.
      coverage: databaseOnly ? 'database-only' : 'database-and-storage',
      physical_retention: L.PHYSICAL_RETENTION,
      runner_git_commit: gitCommit,
      database: {
        server_version: serverVersion,
        dump_bytes: pkg.plainBytes,
        dump_sha256: pkg.plainSha,
        encrypted_bytes: pkg.encBytes,
        encrypted_sha256: pkg.encSha,
        encryption: recipient ? 'age-asymmetric' : 'NOT-ENCRYPTED-DRY-RUN',
        age_recipient: recipient, // public half only
      },
      storage: {total_objects: objects.length, total_bytes: totalBytes, objects},
      not_backed_up: {
        vault_secret_names: vaultNames,
        vault_note:
          'Vault ciphertext is bound to the Supabase-managed project key and does NOT decrypt in another project. These names must be re-entered by hand after a restore or the cron jobs below stay dead.',
        cron_jobs: cronJobs,
        extensions,
        external: ['Edge Function secrets', 'Netlify environment variables'],
      },
    };
    const manifestPath = path.join(workDir, `manifest-${runId}.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    say(`\n[3/4] provider ${execute ? 'upload' : 'plan'}`);
    // PAYLOAD first, MANIFESTS last. The manifest is the authoritative record of
    // what a generation contains and it seeds the next run's incremental diff.
    // Publishing it before its payload is safely stored would both overstate the
    // backup and cause the NEXT run to skip objects that were never transferred.
    const payload = [
      {provider: 'b2', key: dbKeys.dump, body: pkg.encPath, label: 'database package'},
      {provider: 'r2', key: dbKeys.dump, body: pkg.encPath, label: 'database package'},
    ].filter((p) => p.body);
    const manifests = [
      {provider: 'b2', key: dbKeys.manifest, body: manifestPath, label: 'database manifest'},
      {provider: 'b2', key: storageManifest, body: manifestPath, label: 'storage manifest'},
      {provider: 'r2', key: dbKeys.manifest, body: manifestPath, label: 'database manifest'},
      {provider: 'r2', key: storageManifest, body: manifestPath, label: 'storage manifest'},
    ];

    if (!execute) {
      for (const p of [...payload, ...manifests]) {
        const ret = p.provider === 'b2' ? `  immutable ${L.minImmutableDaysForKey(p.key)}d GOVERNANCE` : '';
        say(`      ${p.provider.toUpperCase()}  PUT ${p.key}${ret}`);
      }
      say(`      B2  PUT storage/objects/<bucket>/<path>            x${diff.changed.length}  immutable 35d`);
      say(`      R2  PUT storage/objects/<bucket>/<path>@${runId}   x${diff.changed.length}`);
      say(`      order: payload -> storage bodies -> manifests LAST (manifest never advances on failure)`);
      if (!recipient) say(`      NOTE: no database package to upload without DR_AGE_RECIPIENT`);
      if (diff.changed.length > 0) {
        say(`      storage bodies stream to BOTH providers on --execute`);
        say(`      (concurrency ${L.TRANSFER_CONCURRENCY}, ${L.RETRY_ATTEMPTS} attempts, no disk staging)`);
      }
    } else {
      // Real production ops wired into the pure orchestrator. The orchestrator
      // owns the payload -> storage -> manifests ordering and the failure
      // semantics; these functions are the only I/O.
      const ops = {
        putObject: (provider, key, body) => putObject(provider, key, body),
        streamObject: (obj, provider, destKey) => streamOneObject(obj, provider, destKey),
        setB2Retention: (key) => setB2Retention(key),
        sleep,
      };
      say(`      uploading: payload -> storage bodies -> manifests (manifest never advances on failure)`);
      if (databaseOnly && diff.changed.length > 0) {
        say(`      SKIP storage bodies x${diff.changed.length} — DATABASE-ONLY run, files NOT protected`);
      }
      const res = await O.orchestrateUpload(
        {
          payload,
          storageChanged: databaseOnly ? [] : diff.changed,
          manifests,
          runId,
          databaseOnly,
          concurrency: L.TRANSFER_CONCURRENCY,
          retryAttempts: L.RETRY_ATTEMPTS,
        },
        ops,
      );
      if (res.ok) {
        say(`      ${res.transferred}/${databaseOnly ? 0 : diff.changed.length} storage objects to BOTH providers`);
        say(`      manifests published; coverage ${decision.coverage}`);
      } else {
        exitCode = 1;
        say(`      ABORT at ${res.failedAt}: the authoritative manifest was NOT advanced; next run re-transfers`);
        for (const f of (res.failures || []).slice(0, 5)) say(`      FAIL ${f.target || f.object}: ${f.error}`);
        if ((res.failures || []).length > 5) say(`      ... and ${res.failures.length - 5} more failures`);
      }
    }

    say(`\n[4/4] not covered by this package — restore must handle manually`);
    say(
      `      ${vaultNames.length} vault secrets, ${cronJobs.length} cron schedules, ${extensions.length} extensions,`,
    );
    say(`      Edge Function secrets, Netlify env vars`);

    const outDir = arg('out');
    if (outDir) {
      fs.mkdirSync(outDir, {recursive: true});
      const dest = path.join(outDir, `manifest-${runId}.json`);
      fs.copyFileSync(manifestPath, dest);
      say(`\nwrote ${dest}  (no secret values; vault appears by NAME only)`);
    }
    say('');
  } catch (err) {
    console.error(clean(`\nFAILED: ${err.message?.split('\n')[0] || 'unknown error'}`));
    exitCode = 1;
  } finally {
    cleanup();
  }
  process.exit(exitCode);
})();
