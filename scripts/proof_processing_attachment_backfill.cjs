// Pre/post proof for the ONE approved PROD attachment_backfill run (CC#7).
//
// Phases:
//   --phase=pre  --out=<snapshot.json>       (service-role READS only)
//     Snapshots processing_attachments rows (id, gid, path, record, comment
//     linkage, size) plus the unchanged-domain counts: comments (total +
//     imported), processing_subtasks, processing.record activity_events,
//     processing_records, processing_templates.
//   --phase=post --snapshot=<snapshot.json>  (reads + signed-URL byte fetches)
//     Proves, against the snapshot:
//       - exactly the expected unique Asana attachment gids, no duplicates;
//       - exactly the expected new rows; pre-existing comment-media rows keep
//         their storage_path, comment_id, and record_id;
//       - unchanged-domain counts are identical;
//       - EXHAUSTIVE storage proof: every asana-gid row's object is signed via
//         an OPERATIONAL admin session (the RLS-gated path the UI uses), every
//         object is fetched, and fetched byte length equals size_bytes wherever
//         size_bytes is recorded. Aggregate pass counts only; URLs are never
//         printed; the temporary session is signed out in a finally.
//
// Expected shape flags (default to the approved CC#7 plan):
//   --expect-total=67 --expect-new=59
//
// PROD only, explicit: --env=prod is required. This script performs NO writes
// anywhere (signing an object URL is a read grant, not a mutation) and NEVER
// prints JWTs, keys, tokens, magic-link material, or signed URLs.
//
// Exit codes: 0 all proofs pass; 1 any proof fails; 2 usage/env refusal.
const fs = require('fs');
const path = require('path');

const PROD_REF = 'pzfujbjtayhkdlxiblwe';
const BUCKET = 'processing-attachments';

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
    return {status: res.status, json, text, headers: res.headers};
  } finally {
    clearTimeout(timer);
  }
}

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}
const PHASE = (args.phase || '').toLowerCase();
if ((args.env || '').toLowerCase() !== 'prod' || (PHASE !== 'pre' && PHASE !== 'post')) {
  console.error('USAGE: node scripts/proof_processing_attachment_backfill.cjs --env=prod --phase=pre|post ...');
  process.exit(2);
}
const EXPECT_TOTAL = Number(args['expect-total'] || 67);
const EXPECT_NEW = Number(args['expect-new'] || 59);

loadDotEnv(path.join(__dirname, '..', '.env.prod.local'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.prod.local'));
const URL_BASE = `https://${PROD_REF}.supabase.co`;
const SERVICE_KEY = process.env.PROD_SERVICE_ROLE_JWT;
const ANON_KEY = process.env.PROD_ANON_KEY;
if (!SERVICE_KEY || !ANON_KEY) {
  console.error('PROD_ANON_KEY / PROD_SERVICE_ROLE_JWT not present — nothing was read.');
  process.exit(2);
}

const svcHeaders = {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`};

async function countRows(pathAndQuery) {
  const r = await fetchJson(
    `${URL_BASE}/rest/v1/${pathAndQuery}`,
    {method: 'HEAD', headers: {...svcHeaders, Prefer: 'count=exact'}},
    30000,
  );
  const range = r.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) throw new ExitError(1, `count failed for ${pathAndQuery} (status ${r.status})`);
  return total;
}

async function loadAttachmentRows() {
  const r = await fetchJson(
    `${URL_BASE}/rest/v1/processing_attachments` +
      '?select=id,asana_attachment_gid,storage_path,record_id,comment_id,content_type,size_bytes&limit=10000',
    {headers: svcHeaders},
    30000,
  );
  if (r.status !== 200 || !Array.isArray(r.json)) throw new ExitError(1, `attachment read failed (status ${r.status})`);
  return r.json;
}

async function domainCounts() {
  return {
    commentsTotal: await countRows('comments?select=id'),
    commentsImported: await countRows('comments?select=id&asana_comment_gid=not.is.null'),
    processingSubtasks: await countRows('processing_subtasks?select=id'),
    processingRecordActivity: await countRows('activity_events?select=id&entity_type=eq.processing.record'),
    processingRecords: await countRows('processing_records?select=id'),
    processingTemplates: await countRows('processing_templates?select=id'),
  };
}

(async () => {
  if (PHASE === 'pre') {
    const out = args.out;
    if (!out) throw new ExitError(2, '--out=<snapshot.json> required for --phase=pre');
    const rows = await loadAttachmentRows();
    const domains = await domainCounts();
    const asanaRows = rows.filter((r) => r.asana_attachment_gid);
    fs.writeFileSync(out, JSON.stringify({takenAt: new Date().toISOString(), rows, domains}, null, 2));
    console.log(`pre-snapshot written: rows=${rows.length}`);
    console.log(`asana-gid rows: ${asanaRows.length}`);
    console.log(`domains: ${JSON.stringify(domains)}`);
    console.log('PRE-SNAPSHOT OK');
    return;
  }

  // ── post phase ──────────────────────────────────────────────────────────────
  const snapFile = args.snapshot;
  if (!snapFile || !fs.existsSync(snapFile))
    throw new ExitError(2, '--snapshot=<snapshot.json> required for --phase=post');
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const preRows = snap.rows.filter((r) => r.asana_attachment_gid);
  const failures = [];
  const check = (label, ok, detail) => {
    console.log(`  [${ok ? 'ok' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  // 1. Database completeness.
  const rowsNow = await loadAttachmentRows();
  const asanaNow = rowsNow.filter((r) => r.asana_attachment_gid);
  const gids = asanaNow.map((r) => String(r.asana_attachment_gid));
  const uniqueGids = new Set(gids);
  check(`unique asana gids == ${EXPECT_TOTAL}`, uniqueGids.size === EXPECT_TOTAL, `got ${uniqueGids.size}`);
  check('no duplicate gids', uniqueGids.size === gids.length, `${gids.length} rows / ${uniqueGids.size} unique`);
  check(
    `new asana rows == ${EXPECT_NEW}`,
    asanaNow.length - preRows.length === EXPECT_NEW,
    `pre ${preRows.length} -> post ${asanaNow.length}`,
  );
  const nowByGid = new Map(asanaNow.map((r) => [String(r.asana_attachment_gid), r]));
  let mediaIntact = 0;
  for (const pre of preRows) {
    const now = nowByGid.get(String(pre.asana_attachment_gid));
    if (
      now &&
      now.storage_path === pre.storage_path &&
      String(now.comment_id || '') === String(pre.comment_id || '') &&
      String(now.record_id || '') === String(pre.record_id || '')
    ) {
      mediaIntact += 1;
    }
  }
  check(
    `pre-existing comment-media rows intact (path+comment+record) == ${preRows.length}`,
    mediaIntact === preRows.length,
    `${mediaIntact}/${preRows.length}`,
  );

  // 2. Unchanged domains.
  const domainsNow = await domainCounts();
  for (const k of Object.keys(snap.domains)) {
    check(
      `domain unchanged: ${k}`,
      domainsNow[k] === snap.domains[k],
      `pre ${snap.domains[k]} -> post ${domainsNow[k]}`,
    );
  }

  // 3. Exhaustive storage proof through the OPERATIONAL signed-URL path.
  //    Mint a one-time admin session (magiclink generated, never emailed, never
  //    printed) — admin is an operational role for the bucket's SELECT policy.
  let accessToken = null;
  try {
    const adminEmail = (process.env.PROD_ADMIN_EMAIL || '').trim();
    if (!adminEmail) throw new ExitError(2, 'PROD_ADMIN_EMAIL required in env for the operational signed-URL proof');
    const gen = await fetchJson(
      `${URL_BASE}/auth/v1/admin/generate_link`,
      {
        method: 'POST',
        headers: {...svcHeaders, 'Content-Type': 'application/json'},
        body: JSON.stringify({type: 'magiclink', email: adminEmail}),
      },
      30000,
    );
    const tokenHash =
      (gen.json && gen.json.hashed_token) || (gen.json && gen.json.properties && gen.json.properties.hashed_token);
    const emailOtp =
      (gen.json && gen.json.email_otp) || (gen.json && gen.json.properties && gen.json.properties.email_otp);
    if (gen.status !== 200 || (!tokenHash && !emailOtp))
      throw new ExitError(1, `generate_link failed (status ${gen.status})`);
    let verify = tokenHash
      ? await fetchJson(
          `${URL_BASE}/auth/v1/verify`,
          {
            method: 'POST',
            headers: {apikey: ANON_KEY, 'Content-Type': 'application/json'},
            body: JSON.stringify({type: 'magiclink', token_hash: tokenHash}),
          },
          30000,
        )
      : {status: 0, json: null};
    if (!(verify.json && verify.json.access_token) && emailOtp) {
      verify = await fetchJson(
        `${URL_BASE}/auth/v1/verify`,
        {
          method: 'POST',
          headers: {apikey: ANON_KEY, 'Content-Type': 'application/json'},
          body: JSON.stringify({type: 'magiclink', email: adminEmail, token: emailOtp}),
        },
        30000,
      );
    }
    accessToken = verify.json && verify.json.access_token;
    if (!accessToken) throw new ExitError(1, `verify failed (status ${verify.status}) — no operational session`);

    let signedOk = 0;
    let fetchedOk = 0;
    let byteMatch = 0;
    let byteSkipped = 0;
    const failedIds = [];
    for (const row of asanaNow) {
      const encPath = String(row.storage_path).split('/').map(encodeURIComponent).join('/');
      let ok = false;
      try {
        const sign = await fetchJson(
          `${URL_BASE}/storage/v1/object/sign/${BUCKET}/${encPath}`,
          {
            method: 'POST',
            headers: {apikey: ANON_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({expiresIn: 300}),
          },
          30000,
        );
        const signedPath = sign.json && sign.json.signedURL;
        if (sign.status === 200 && signedPath) {
          signedOk += 1;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 60000);
          try {
            const obj = await fetch(`${URL_BASE}/storage/v1${signedPath}`, {signal: controller.signal});
            if (obj.status === 200) {
              const buf = new Uint8Array(await obj.arrayBuffer());
              fetchedOk += 1;
              if (row.size_bytes == null) byteSkipped += 1;
              else if (Number(row.size_bytes) === buf.byteLength) byteMatch += 1;
              else throw new Error(`byte length ${buf.byteLength} != size_bytes ${row.size_bytes}`);
              ok = true;
            }
          } finally {
            clearTimeout(timer);
          }
        }
      } catch (_e) {
        ok = false;
      }
      if (!ok) failedIds.push(row.id);
    }
    check(`signed URLs minted == ${asanaNow.length}`, signedOk === asanaNow.length, `${signedOk}/${asanaNow.length}`);
    check(`objects fetched == ${asanaNow.length}`, fetchedOk === asanaNow.length, `${fetchedOk}/${asanaNow.length}`);
    check(
      'byte lengths match size_bytes (where recorded)',
      byteMatch + byteSkipped === asanaNow.length && failedIds.length === 0,
      `match ${byteMatch}, no-size ${byteSkipped}, failed ${failedIds.length}`,
    );
    if (failedIds.length) console.error(`  failed row ids (first 10): ${failedIds.slice(0, 10).join(', ')}`);
  } finally {
    if (accessToken) {
      let signedOut = 'failed (non-fatal)';
      try {
        const so = await fetchJson(
          `${URL_BASE}/auth/v1/logout`,
          {method: 'POST', headers: {apikey: ANON_KEY, Authorization: `Bearer ${accessToken}`}},
          15000,
        );
        signedOut = so.status === 204 || so.status === 200 ? 'ok' : `unexpected status ${so.status}`;
      } catch (_e) {
        /* keep 'failed (non-fatal)' */
      }
      console.log(`session sign-out: ${signedOut}`);
    }
  }

  if (failures.length) {
    console.error(`POST-PROOF FAILED: ${failures.length} check(s): ${failures.join(' | ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('POST-PROOF: ALL CHECKS PASSED');
})().catch((e) => {
  if (e instanceof ExitError) {
    console.error(e.message);
    process.exitCode = e.code;
    return;
  }
  console.error(`FAIL: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
