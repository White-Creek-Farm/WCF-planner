// Operator script for the ordinary Asana attachment lanes of the deployed
// processing-asana-sync Edge Function.
//
// Exactly two actions are reachable — nothing else can ride this script:
//   attachment_dry_run   (DEFAULT — read-only inventory, no writes anywhere)
//   attachment_backfill  (the ONLY ordinary-attachment byte-copy path; needs a
//                         second typed confirmation AND remains gated on
//                         Ronnie/Codex write approval outside this script)
//
// Usage:
//   node scripts/ops_processing_attachment_backfill.cjs --env=prod
//   node scripts/ops_processing_attachment_backfill.cjs --env=prod \
//        --action=attachment_backfill --confirm=attachment_backfill
//
//   --env=test|prod          REQUIRED. No default; TEST and PROD are explicit.
//   --action=<action>        Optional. Defaults to attachment_dry_run.
//   --confirm=<action>       Required (typed again) for attachment_backfill.
//   --admin-email=<email>    Optional PROD override when auto-discovery finds
//                            zero or multiple admin profiles.
//
// Auth:
//   PROD  — no admin password exists on disk, so the script mints a one-time
//           admin session: GoTrue admin generate_link (magiclink, NOT emailed)
//           via PROD_SERVICE_ROLE_JWT, verified for an access token, signed out
//           after the run. The Edge function itself re-checks is_admin.
//   TEST  — VITE_TEST_ADMIN_EMAIL / VITE_TEST_ADMIN_PASSWORD password sign-in
//           (requires WCF_TEST_DATABASE=1 and a non-PROD URL). Note: TEST has
//           no processing-asana-sync deploy at the time of writing; the call
//           will fail sanitized rather than touch PROD.
//
// This script NEVER prints JWTs, anon/service keys, Asana tokens, signed URLs,
// magic links, token hashes, OTPs, or any other recovery data. Output is the
// action, HTTP status, count fields, runId, and sanitized error text only.
//
// Exit codes: 0 clean; 1 invoked but error/partial (ok=false, errors>0, or
// bucketReady=false); 2 usage/env refusal (nothing was invoked).
const fs = require('fs');
const path = require('path');

const PROD_REF = 'pzfujbjtayhkdlxiblwe';
const FN_NAME = 'processing-asana-sync';
const ALLOWED_ACTIONS = new Set(['attachment_dry_run', 'attachment_backfill']);
// Only these response fields are ever printed from the Edge payload.
const COUNT_KEYS = [
  'linkedTasks',
  'attachmentsFound',
  'newAttachments',
  'alreadyStored',
  'copied',
  'skipped',
  'bucketReady',
  'errors',
  'dryRun',
];

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

// Strip anything token-shaped from server error text before printing.
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED-JWT]')
    .replace(/([?&](?:token|token_hash|apikey|key|signature|X-Amz-[A-Za-z-]+)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/\S*\/(?:sign|object|storage)\/\S+/gi, '[REDACTED-STORAGE-URL]')
    .slice(0, 600);
}

function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '[masked]';
  return `${s.slice(0, 2)}***${s.slice(at)}`;
}

function usageFail(msg) {
  console.error(`USAGE: ${msg}`);
  console.error(
    'node scripts/ops_processing_attachment_backfill.cjs --env=test|prod ' +
      '[--action=attachment_dry_run|attachment_backfill] [--confirm=attachment_backfill] [--admin-email=<email>]',
  );
  process.exit(2);
}

// Thrown instead of process.exit() once network handles exist (a hard exit
// with live undici sockets trips a libuv assertion on Windows).
class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {...options, signal: controller.signal});
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_e) {
      json = null;
    }
    return {status: res.status, json, text};
  } finally {
    clearTimeout(timer);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}
const ENV = (args.env || '').toLowerCase();
if (ENV !== 'test' && ENV !== 'prod') usageFail('--env=test|prod is required (explicit, no default)');
const ACTION = (args.action || 'attachment_dry_run').toLowerCase();
if (!ALLOWED_ACTIONS.has(ACTION)) {
  usageFail(`--action must be attachment_dry_run or attachment_backfill (got: ${ACTION})`);
}
if (ACTION === 'attachment_backfill' && (args.confirm || '') !== 'attachment_backfill') {
  usageFail('attachment_backfill is a WRITE: retype it as --confirm=attachment_backfill to proceed');
}

(async () => {
  let url;
  let anonKey;
  let accessToken;
  let signoutUrl = null;

  if (ENV === 'prod') {
    loadDotEnv(path.join(__dirname, '..', '.env.prod.local'));
    loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.prod.local'));
    url = `https://${PROD_REF}.supabase.co`;
    anonKey = process.env.PROD_ANON_KEY;
    const serviceKey = process.env.PROD_SERVICE_ROLE_JWT;
    if (!anonKey || !serviceKey) {
      throw new ExitError(
        2,
        'PROD_ANON_KEY / PROD_SERVICE_ROLE_JWT not present in .env.prod.local — nothing was invoked.',
      );
    }

    // Resolve the admin identity: explicit flag/env wins; otherwise the profile
    // table must contain exactly one admin.
    let adminEmail = (args['admin-email'] || process.env.PROD_ADMIN_EMAIL || '').trim();
    if (!adminEmail) {
      const q = await fetchJson(
        `${url}/rest/v1/profiles?role=eq.admin&select=email`,
        {headers: {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`}},
        30000,
      );
      const rows = Array.isArray(q.json) ? q.json : [];
      if (q.status !== 200 || rows.length !== 1) {
        throw new ExitError(
          2,
          `admin auto-discovery needs exactly one admin profile (status ${q.status}, found ${rows.length}); ` +
            'pass --admin-email=<email> explicitly. Nothing was invoked.',
        );
      }
      adminEmail = String(rows[0].email || '');
    }
    console.log(`admin identity: ${maskEmail(adminEmail)}`);

    // Mint a one-time admin session (magiclink is generated, never emailed).
    const gen = await fetchJson(
      `${url}/auth/v1/admin/generate_link`,
      {
        method: 'POST',
        headers: {apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({type: 'magiclink', email: adminEmail}),
      },
      30000,
    );
    const tokenHash =
      (gen.json && gen.json.hashed_token) || (gen.json && gen.json.properties && gen.json.properties.hashed_token);
    const emailOtp =
      (gen.json && gen.json.email_otp) || (gen.json && gen.json.properties && gen.json.properties.email_otp);
    if (gen.status !== 200 || (!tokenHash && !emailOtp)) {
      throw new ExitError(2, `generate_link failed (status ${gen.status}): ${sanitize(gen.json && gen.json.msg)}`);
    }
    let verify = tokenHash
      ? await fetchJson(
          `${url}/auth/v1/verify`,
          {
            method: 'POST',
            headers: {apikey: anonKey, 'Content-Type': 'application/json'},
            body: JSON.stringify({type: 'magiclink', token_hash: tokenHash}),
          },
          30000,
        )
      : {status: 0, json: null};
    if (!(verify.json && verify.json.access_token) && emailOtp) {
      verify = await fetchJson(
        `${url}/auth/v1/verify`,
        {
          method: 'POST',
          headers: {apikey: anonKey, 'Content-Type': 'application/json'},
          body: JSON.stringify({type: 'magiclink', email: adminEmail, token: emailOtp}),
        },
        30000,
      );
    }
    accessToken = verify.json && verify.json.access_token;
    if (!accessToken) {
      throw new ExitError(2, `verify failed (status ${verify.status}): could not establish an admin session.`);
    }
    signoutUrl = `${url}/auth/v1/logout`;
  } else {
    loadDotEnv(path.join(__dirname, '..', '.env.test'));
    loadDotEnv(path.join(__dirname, '..', '.env.test.local'));
    loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
    loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
    url = process.env.VITE_SUPABASE_URL;
    anonKey = process.env.VITE_SUPABASE_ANON_KEY;
    const email = process.env.VITE_TEST_ADMIN_EMAIL;
    const password = process.env.VITE_TEST_ADMIN_PASSWORD;
    if (!url || !anonKey || !email || !password) {
      throw new ExitError(2, 'missing TEST env (url / anon key / admin credentials) — nothing was invoked.');
    }
    if (process.env.WCF_TEST_DATABASE !== '1' || url.includes(PROD_REF)) {
      throw new ExitError(2, 'refusing: --env=test needs WCF_TEST_DATABASE=1 and a non-PROD URL. Nothing was invoked.');
    }
    const login = await fetchJson(
      `${url.replace(/\/$/, '')}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: {apikey: anonKey, 'Content-Type': 'application/json'},
        body: JSON.stringify({email, password}),
      },
      30000,
    );
    accessToken = login.json && login.json.access_token;
    if (!accessToken) {
      throw new ExitError(2, `TEST admin sign-in failed (status ${login.status}).`);
    }
    signoutUrl = `${url.replace(/\/$/, '')}/auth/v1/logout`;
  }

  // Everything after authentication runs under a finally that signs the
  // temporary session out on EVERY outcome: admin-preflight failure, Edge
  // timeout/throw, malformed response, and successful or partial runs alike.
  try {
    // Sanity gate before invoking anything: this session must be admin.
    const isAdmin = await fetchJson(
      `${url.replace(/\/$/, '')}/rest/v1/rpc/is_admin`,
      {
        method: 'POST',
        headers: {apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'},
        body: '{}',
      },
      30000,
    );
    if (isAdmin.json !== true) {
      throw new ExitError(
        2,
        `is_admin preflight failed (status ${isAdmin.status}, value ${JSON.stringify(isAdmin.json)}).`,
      );
    }
    console.log('is_admin preflight: true');

    const banner = ACTION === 'attachment_dry_run' ? 'DRY RUN (read-only)' : 'WRITE (attachment byte-copy)';
    console.log(`env=${ENV} action=${ACTION} — ${banner}`);

    // Exactly one invocation of exactly the requested attachment action.
    const fn = await fetchJson(
      `${url.replace(/\/$/, '')}/functions/v1/${FN_NAME}`,
      {
        method: 'POST',
        headers: {apikey: anonKey, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({mode: 'admin', action: ACTION}),
      },
      300000,
    );

    const body = fn.json || {};
    const payload = body.report || body.counts || {};
    const counts = {};
    for (const k of COUNT_KEYS) {
      if (payload[k] !== undefined) counts[k] = payload[k];
    }
    console.log(`http status: ${fn.status}`);
    console.log(`ok: ${body.ok === true}`);
    if (body.runId) console.log(`runId: ${body.runId}`);
    console.log(`counts: ${JSON.stringify(counts, null, 2)}`);
    if (body.error) console.log(`error (sanitized): ${sanitize(body.error)}`);
    if (!fn.json) console.log(`non-JSON response (sanitized): ${sanitize(fn.text)}`);

    const partial =
      body.ok !== true ||
      fn.status !== 200 ||
      (typeof counts.errors === 'number' && counts.errors > 0) ||
      counts.bucketReady === false;
    if (partial) {
      console.error('RESULT: error/partial — see counts above (nonzero exit preserved).');
      process.exitCode = 1;
      return;
    }
    console.log('RESULT: clean.');
  } finally {
    // Best-effort sign-out so the temporary session never lingers; failures
    // are reported as a status word only — never credentials.
    if (signoutUrl && accessToken) {
      let signedOut = 'failed (non-fatal)';
      try {
        const so = await fetchJson(
          signoutUrl,
          {method: 'POST', headers: {apikey: anonKey, Authorization: `Bearer ${accessToken}`}},
          15000,
        );
        signedOut = so.status === 204 || so.status === 200 ? 'ok' : `unexpected status ${so.status}`;
      } catch (_e) {
        /* keep 'failed (non-fatal)' */
      }
      console.log(`session sign-out: ${signedOut}`);
    }
  }
})().catch((e) => {
  if (e instanceof ExitError) {
    console.error(e.message);
    process.exitCode = e.code;
    return;
  }
  console.error(`FAIL: ${sanitize(e && e.message ? e.message : e)}`);
  process.exitCode = 1;
});
