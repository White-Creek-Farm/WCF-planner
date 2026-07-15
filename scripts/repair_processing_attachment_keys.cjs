// PROD repair for the CC#7 attachment_backfill key defect (Codex Option A).
//
// Defect: the deployed byte-copier passed raw '#'-bearing filenames into the
// storage upload URL, so 55 of 67 imported ordinary attachments were stored
// under '#'-TRUNCATED object keys while processing_attachments.storage_path
// recorded the full (unsignable, invalid-key) path.
//
// Repair sequence (copy -> verify -> patch -> verify -> delete), idempotent and
// resumable, restricted to EXACTLY the affected '#'-path rows:
//
//   --phase=preflight --manifest=<file>
//       Read-only. Verifies the affected-set shape (exactly 55 rows, sources
//       exist, sizes match, destinations absent-or-resumable, zero collisions,
//       the 8 comment-media rows and 4 clean ordinary rows excluded), then
//       writes the sanitized manifest (no URLs, no credentials).
//   --phase=repair --manifest=<file>
//       Copies each truncated source object to its canonical key
//       <parent_asana_gid>/<asana_attachment_gid>, verifies source/destination
//       SHA-256 equality and destination size, patches ONLY storage_path for
//       those rows, then proves the OPERATIONAL application path: all 67
//       imported rows mint signed URLs, fetch, and size-check; media/clean rows
//       and the unchanged domains are re-verified. Deletes nothing.
//   --phase=finalize --manifest=<file> --confirm=delete-truncated
//       Only after repair passed 67/67: deletes exactly the manifest's 55
//       obsolete truncated keys, then proves absence, canonical presence,
//       67/67 readability, and native-attachment invariance.
//
// The script STOPS (nonzero exit) without deleting anything if any count,
// mapping, hash, signed fetch, or invariant differs. Resume: rerunning a phase
// re-derives state from live storage/DB (copied-only and copied-and-patched
// rows are recognized and skipped).
//
// Canonical keys use Asana identifiers only (strict safe-segment validation);
// the original filename stays in processing_attachments.filename untouched.
// NEVER prints JWTs, keys, tokens, magic-link material, or signed URLs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROD_REF = 'pzfujbjtayhkdlxiblwe';
const BUCKET = 'processing-attachments';
const URL_BASE = `https://${PROD_REF}.supabase.co`;
const EXPECT_AFFECTED = 55;
const EXPECT_MEDIA = 8;
const EXPECT_CLEAN = 4;
const EXPECT_TOTAL = 67;

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

async function fetchRaw(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {...options, signal: controller.signal});
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options, timeoutMs) {
  const res = await fetchRaw(url, options, timeoutMs);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_e) {
    json = null;
  }
  return {status: res.status, json, text, headers: res.headers};
}

// Canonical repaired key: Asana identifiers only, strictly validated.
function safeAsanaSegment(value, label) {
  const s = String(value == null ? '' : value);
  if (!/^\d{1,32}$/.test(s)) throw new ExitError(1, `unsafe ${label} segment (must be a plain Asana numeric gid)`);
  return s;
}
function canonicalKey(parentGid, attachmentGid) {
  return `${safeAsanaSegment(parentGid, 'parent gid')}/${safeAsanaSegment(attachmentGid, 'attachment gid')}`;
}

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
}
const PHASE = (args.phase || '').toLowerCase();
const MANIFEST = args.manifest;
if (!['preflight', 'repair', 'finalize'].includes(PHASE) || !MANIFEST) {
  console.error(
    'USAGE: node scripts/repair_processing_attachment_keys.cjs --phase=preflight|repair|finalize --manifest=<file> [--confirm=delete-truncated]',
  );
  process.exit(2);
}
if (PHASE === 'finalize' && args.confirm !== 'delete-truncated') {
  console.error('finalize deletes the truncated source keys: retype --confirm=delete-truncated to proceed.');
  process.exit(2);
}

loadDotEnv(path.join(__dirname, '..', '.env.prod.local'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.prod.local'));
const SERVICE_KEY = process.env.PROD_SERVICE_ROLE_JWT;
const ANON_KEY = process.env.PROD_ANON_KEY;
if (!SERVICE_KEY || !ANON_KEY) {
  console.error('PROD_ANON_KEY / PROD_SERVICE_ROLE_JWT not present — nothing was touched.');
  process.exit(2);
}
const svcHeaders = {apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`};
const svcJsonHeaders = {...svcHeaders, 'Content-Type': 'application/json'};

const failures = [];
const check = (label, ok, detail) => {
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
  return ok;
};
const bail = () => {
  if (failures.length) {
    console.error(`STOPPED: ${failures.length} failed check(s): ${failures.join(' | ')}`);
    process.exitCode = 1;
    return true;
  }
  return false;
};

async function loadRows() {
  const r = await fetchJson(
    `${URL_BASE}/rest/v1/processing_attachments` +
      '?select=id,asana_attachment_gid,storage_path,record_id,comment_id,filename,content_type,size_bytes,source_url,original_created_at&limit=10000',
    {headers: svcHeaders},
    30000,
  );
  if (r.status !== 200 || !Array.isArray(r.json)) throw new ExitError(1, `attachment read failed (status ${r.status})`);
  return r.json;
}

async function listPrefix(prefix) {
  const l = await fetchJson(
    `${URL_BASE}/storage/v1/object/list/${BUCKET}`,
    {method: 'POST', headers: svcJsonHeaders, body: JSON.stringify({prefix: `${prefix}/`, limit: 1000})},
    30000,
  );
  if (l.status !== 200 || !Array.isArray(l.json))
    throw new ExitError(1, `storage list failed for prefix (status ${l.status})`);
  const map = new Map();
  for (const o of l.json)
    map.set(`${prefix}/${o.name}`, o.metadata && o.metadata.size != null ? Number(o.metadata.size) : null);
  return map;
}

async function listAllKeys(prefixes) {
  const all = new Map();
  for (const p of prefixes) {
    const m = await listPrefix(p);
    for (const [k, v] of m) all.set(k, v);
  }
  return all;
}

async function downloadBytes(key) {
  const enc = key.split('/').map(encodeURIComponent).join('/');
  const res = await fetchRaw(`${URL_BASE}/storage/v1/object/${BUCKET}/${enc}`, {headers: svcHeaders}, 120000);
  if (res.status !== 200) return null;
  return new Uint8Array(await res.arrayBuffer());
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function domainCounts() {
  const count = async (q) => {
    const r = await fetchJson(
      `${URL_BASE}/rest/v1/${q}`,
      {method: 'HEAD', headers: {...svcHeaders, Prefer: 'count=exact'}},
      30000,
    );
    const total = Number((r.headers.get('content-range') || '').split('/')[1]);
    if (!Number.isFinite(total)) throw new ExitError(1, `count failed for ${q} (status ${r.status})`);
    return total;
  };
  return {
    commentsTotal: await count('comments?select=id'),
    commentsImported: await count('comments?select=id&asana_comment_gid=not.is.null'),
    processingSubtasks: await count('processing_subtasks?select=id'),
    processingRecordActivity: await count('activity_events?select=id&entity_type=eq.processing.record'),
    processingRecords: await count('processing_records?select=id'),
    processingTemplates: await count('processing_templates?select=id'),
  };
}

// Classify live rows into the repair sets; every invariant is re-derived live.
function classify(rows) {
  const imported = rows.filter((r) => r.asana_attachment_gid);
  const media = imported.filter((r) => r.comment_id != null);
  const affected = imported.filter((r) => r.comment_id == null && /#/.test(r.storage_path));
  const clean = imported.filter(
    (r) => r.comment_id == null && !/#/.test(r.storage_path) && !/^\d{1,32}\/\d{1,32}$/.test(r.storage_path),
  );
  const repaired = imported.filter((r) => r.comment_id == null && /^\d{1,32}\/\d{1,32}$/.test(r.storage_path));
  const native = rows.filter((r) => !r.asana_attachment_gid);
  return {imported, media, affected, clean, repaired, native};
}

function truncatedSource(storagePath) {
  const parts = storagePath.split('/');
  return `${parts[0]}/${parts.slice(1).join('/').split(/[#?]/)[0]}`;
}

function manifestEntry(row) {
  const parentGid = row.storage_path.split('/')[0];
  return {
    id: row.id,
    asana_attachment_gid: row.asana_attachment_gid,
    parent_gid: parentGid,
    recorded_path: row.storage_path,
    source_key: truncatedSource(row.storage_path),
    dest_key: canonicalKey(parentGid, row.asana_attachment_gid),
    size_bytes: row.size_bytes,
  };
}

// Operational (RLS-gated) signed-URL proof over EVERY imported row.
async function operationalProof(rowsImported) {
  const adminEmail = (process.env.PROD_ADMIN_EMAIL || '').trim();
  if (!adminEmail) throw new ExitError(2, 'PROD_ADMIN_EMAIL required for the operational signed-URL proof');
  let accessToken = null;
  try {
    const gen = await fetchJson(
      `${URL_BASE}/auth/v1/admin/generate_link`,
      {method: 'POST', headers: svcJsonHeaders, body: JSON.stringify({type: 'magiclink', email: adminEmail})},
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
    let sizeOk = 0;
    let sizeSkipped = 0;
    const failedIds = [];
    for (const row of rowsImported) {
      let ok = false;
      try {
        const encPath = String(row.storage_path).split('/').map(encodeURIComponent).join('/');
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
          const obj = await fetchRaw(`${URL_BASE}/storage/v1${signedPath}`, {}, 120000);
          if (obj.status === 200) {
            const buf = new Uint8Array(await obj.arrayBuffer());
            fetchedOk += 1;
            if (row.size_bytes == null) sizeSkipped += 1;
            else if (Number(row.size_bytes) === buf.byteLength) sizeOk += 1;
            else throw new Error('size mismatch');
            ok = true;
          }
        }
      } catch (_e) {
        ok = false;
      }
      if (!ok) failedIds.push(row.id);
    }
    return {signedOk, fetchedOk, sizeOk, sizeSkipped, failedIds, total: rowsImported.length};
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
        /* keep */
      }
      console.log(`session sign-out: ${signedOut}`);
    }
  }
}

(async () => {
  const rows = await loadRows();
  const sets = classify(rows);

  // ── PREFLIGHT ───────────────────────────────────────────────────────────────
  if (PHASE === 'preflight') {
    check(`imported rows == ${EXPECT_TOTAL}`, sets.imported.length === EXPECT_TOTAL, `got ${sets.imported.length}`);
    check(
      `affected '#'-path rows == ${EXPECT_AFFECTED}`,
      sets.affected.length === EXPECT_AFFECTED && sets.repaired.length === 0,
      `affected ${sets.affected.length}, already-repaired ${sets.repaired.length}`,
    );
    check(
      `comment-media rows excluded == ${EXPECT_MEDIA}`,
      sets.media.length === EXPECT_MEDIA,
      `got ${sets.media.length}`,
    );
    check(
      `clean ordinary rows excluded == ${EXPECT_CLEAN}`,
      sets.clean.length === EXPECT_CLEAN,
      `got ${sets.clean.length}`,
    );
    check(
      'no media row carries a # path',
      sets.media.every((r) => !/#/.test(r.storage_path)),
      '',
    );
    check('native rows unchanged baseline', true, `native rows: ${sets.native.length}`);

    const entries = sets.affected.map(manifestEntry);
    const sourceKeys = new Set(entries.map((e) => e.source_key));
    const destKeys = new Set(entries.map((e) => e.dest_key));
    check('no source collisions', sourceKeys.size === entries.length, `${sourceKeys.size}/${entries.length}`);
    check('no destination collisions', destKeys.size === entries.length, `${destKeys.size}/${entries.length}`);

    const prefixes = [...new Set(sets.imported.map((r) => r.storage_path.split('/')[0]))];
    const live = await listAllKeys(prefixes);
    let srcExist = 0;
    let srcSizeOk = 0;
    let destAbsentOrResumable = 0;
    for (const e of entries) {
      const srcSize = live.get(e.source_key);
      if (srcSize !== undefined) srcExist += 1;
      if (srcSize != null && e.size_bytes != null && Number(srcSize) === Number(e.size_bytes)) srcSizeOk += 1;
      const destSize = live.get(e.dest_key);
      if (destSize === undefined || (destSize != null && Number(destSize) === Number(e.size_bytes)))
        destAbsentOrResumable += 1;
    }
    check(
      `all truncated sources exist == ${entries.length}`,
      srcExist === entries.length,
      `${srcExist}/${entries.length}`,
    );
    check(
      `all source sizes match size_bytes == ${entries.length}`,
      srcSizeOk === entries.length,
      `${srcSizeOk}/${entries.length}`,
    );
    check(
      `destinations absent or resumable == ${entries.length}`,
      destAbsentOrResumable === entries.length,
      `${destAbsentOrResumable}/${entries.length}`,
    );
    const destOverlap = entries.filter((e) => {
      const s = live.get(e.dest_key);
      return s !== undefined && e.size_bytes != null && Number(s) !== Number(e.size_bytes);
    });
    check('no destination collides with a foreign object', destOverlap.length === 0, `${destOverlap.length} conflicts`);

    if (bail()) return;

    const manifest = {
      createdAt: new Date().toISOString(),
      bucket: BUCKET,
      expect: {affected: EXPECT_AFFECTED, media: EXPECT_MEDIA, clean: EXPECT_CLEAN, total: EXPECT_TOTAL},
      domains: await domainCounts(),
      entries,
      mediaRows: sets.media.map((r) => ({
        id: r.id,
        gid: r.asana_attachment_gid,
        storage_path: r.storage_path,
        comment_id: r.comment_id,
        record_id: r.record_id,
      })),
      cleanRows: sets.clean.map((r) => ({
        id: r.id,
        gid: r.asana_attachment_gid,
        storage_path: r.storage_path,
        record_id: r.record_id,
      })),
      nativeRows: sets.native.map((r) => ({id: r.id, storage_path: r.storage_path, record_id: r.record_id})),
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(
      `manifest written: entries=${manifest.entries.length}, media=${manifest.mediaRows.length}, clean=${manifest.cleanRows.length}, native=${manifest.nativeRows.length}`,
    );
    console.log('PREFLIGHT OK');
    return;
  }

  // repair/finalize need the manifest from a passed preflight.
  if (!fs.existsSync(MANIFEST)) throw new ExitError(2, 'manifest not found — run --phase=preflight first');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== EXPECT_AFFECTED) {
    throw new ExitError(1, `manifest entries != ${EXPECT_AFFECTED} — refusing`);
  }
  const rowByGid = new Map(sets.imported.map((r) => [String(r.asana_attachment_gid), r]));

  // ── REPAIR (copy -> hash verify -> patch -> operational proof; NO deletes) ──
  if (PHASE === 'repair') {
    let copied = 0;
    let copySkipped = 0;
    let hashVerified = 0;
    let patched = 0;
    let patchSkipped = 0;
    for (const e of manifest.entries) {
      const row = rowByGid.get(String(e.asana_attachment_gid));
      if (!row) {
        check(`row present for gid ${e.asana_attachment_gid}`, false, 'missing');
        break;
      }
      // 1. copy (resumable: skip when destination already holds the bytes)
      const destBytesPre = await downloadBytes(e.dest_key);
      if (destBytesPre == null) {
        const cp = await fetchJson(
          `${URL_BASE}/storage/v1/object/copy`,
          {
            method: 'POST',
            headers: svcJsonHeaders,
            body: JSON.stringify({bucketId: BUCKET, sourceKey: e.source_key, destinationKey: e.dest_key}),
          },
          60000,
        );
        if (cp.status !== 200) {
          check(`copy ${e.asana_attachment_gid}`, false, `status ${cp.status}`);
          break;
        }
        copied += 1;
      } else {
        copySkipped += 1;
      }
      // 2. hash verify source vs destination
      const srcBytes = await downloadBytes(e.source_key);
      const destBytes = destBytesPre == null ? await downloadBytes(e.dest_key) : destBytesPre;
      if (!srcBytes || !destBytes || sha256(srcBytes) !== sha256(destBytes)) {
        check(`hash match ${e.asana_attachment_gid}`, false, 'source/destination bytes differ or unreadable');
        break;
      }
      if (e.size_bytes != null && destBytes.byteLength !== Number(e.size_bytes)) {
        check(`destination size ${e.asana_attachment_gid}`, false, `${destBytes.byteLength} != ${e.size_bytes}`);
        break;
      }
      hashVerified += 1;
      // 3. patch storage_path ONLY (resumable: skip when already canonical)
      if (row.storage_path === e.dest_key) {
        patchSkipped += 1;
        continue;
      }
      const up = await fetchJson(
        `${URL_BASE}/rest/v1/processing_attachments?asana_attachment_gid=eq.${encodeURIComponent(e.asana_attachment_gid)}`,
        {
          method: 'PATCH',
          headers: {...svcJsonHeaders, Prefer: 'return=representation'},
          body: JSON.stringify({storage_path: e.dest_key}),
        },
        30000,
      );
      if (up.status !== 200 || !Array.isArray(up.json) || up.json.length !== 1) {
        check(
          `patch ${e.asana_attachment_gid}`,
          false,
          `status ${up.status}, rows ${Array.isArray(up.json) ? up.json.length : 'n/a'}`,
        );
        break;
      }
      patched += 1;
    }
    console.log(
      `copy/verify/patch totals: copied=${copied}, copySkipped=${copySkipped}, hashVerified=${hashVerified}, patched=${patched}, patchSkipped=${patchSkipped}`,
    );
    check(
      `hash-verified == ${EXPECT_AFFECTED}`,
      hashVerified === EXPECT_AFFECTED,
      `${hashVerified}/${EXPECT_AFFECTED}`,
    );
    check(
      `patched+skipped == ${EXPECT_AFFECTED}`,
      patched + patchSkipped === EXPECT_AFFECTED,
      `${patched}+${patchSkipped}`,
    );
    if (bail()) return;

    // 4. full application-path proof + invariants
    const rowsAfter = await loadRows();
    const setsAfter = classify(rowsAfter);
    check(
      `imported rows still ${EXPECT_TOTAL}`,
      setsAfter.imported.length === EXPECT_TOTAL,
      `${setsAfter.imported.length}`,
    );
    check(
      'all affected rows now canonical',
      setsAfter.affected.length === 0 && setsAfter.repaired.length === EXPECT_AFFECTED,
      `remaining ${setsAfter.affected.length}, repaired ${setsAfter.repaired.length}`,
    );
    const mediaNow = new Map(setsAfter.media.map((r) => [String(r.asana_attachment_gid), r]));
    const mediaIntact = manifest.mediaRows.filter((m) => {
      const now = mediaNow.get(String(m.gid));
      return (
        now &&
        now.storage_path === m.storage_path &&
        String(now.comment_id) === String(m.comment_id) &&
        String(now.record_id) === String(m.record_id)
      );
    }).length;
    check(
      `media rows retain original paths/linkage == ${EXPECT_MEDIA}`,
      mediaIntact === EXPECT_MEDIA,
      `${mediaIntact}/${EXPECT_MEDIA}`,
    );
    const cleanNow = new Map(setsAfter.clean.map((r) => [String(r.asana_attachment_gid), r]));
    const cleanIntact = manifest.cleanRows.filter((c) => {
      const now = cleanNow.get(String(c.gid));
      return now && now.storage_path === c.storage_path && String(now.record_id) === String(c.record_id);
    }).length;
    check(
      `clean ordinary rows unchanged == ${EXPECT_CLEAN}`,
      cleanIntact === EXPECT_CLEAN,
      `${cleanIntact}/${EXPECT_CLEAN}`,
    );
    const domainsNow = await domainCounts();
    for (const k of Object.keys(manifest.domains)) {
      check(
        `domain unchanged: ${k}`,
        domainsNow[k] === manifest.domains[k],
        `pre ${manifest.domains[k]} -> now ${domainsNow[k]}`,
      );
    }
    const proof = await operationalProof(setsAfter.imported);
    check(`signed URLs minted == ${proof.total}`, proof.signedOk === proof.total, `${proof.signedOk}/${proof.total}`);
    check(`objects fetched == ${proof.total}`, proof.fetchedOk === proof.total, `${proof.fetchedOk}/${proof.total}`);
    check(
      'sizes match wherever recorded',
      proof.sizeOk + proof.sizeSkipped === proof.total && proof.failedIds.length === 0,
      `match ${proof.sizeOk}, no-size ${proof.sizeSkipped}, failed ${proof.failedIds.length}`,
    );
    if (proof.failedIds.length)
      console.error(`  failed row ids (first 10): ${proof.failedIds.slice(0, 10).join(', ')}`);
    if (bail()) return;
    console.log('REPAIR OK — sources NOT deleted; run --phase=finalize --confirm=delete-truncated after review.');
    return;
  }

  // ── FINALIZE (delete truncated sources, then re-prove everything) ───────────
  if (PHASE === 'finalize') {
    // Refuse unless the repair state is complete and proven-shaped.
    check(
      'all affected rows are canonical before delete',
      sets.affected.length === 0 && sets.repaired.length === EXPECT_AFFECTED,
      `affected ${sets.affected.length}, repaired ${sets.repaired.length}`,
    );
    const prefixes = [...new Set(manifest.entries.map((e) => e.parent_gid))];
    let live = await listAllKeys(prefixes);
    const destMissing = manifest.entries.filter((e) => live.get(e.dest_key) === undefined);
    check('all canonical destinations exist before delete', destMissing.length === 0, `${destMissing.length} missing`);
    if (bail()) return;

    const toDelete = manifest.entries.map((e) => e.source_key).filter((k) => live.get(k) !== undefined);
    console.log(
      `deleting ${toDelete.length} obsolete truncated keys (already absent: ${manifest.entries.length - toDelete.length})`,
    );
    if (toDelete.length) {
      const del = await fetchJson(
        `${URL_BASE}/storage/v1/object/${BUCKET}`,
        {method: 'DELETE', headers: svcJsonHeaders, body: JSON.stringify({prefixes: toDelete})},
        120000,
      );
      if (del.status !== 200) throw new ExitError(1, `delete failed (status ${del.status})`);
    }

    live = await listAllKeys(prefixes);
    const stillThere = manifest.entries.filter((e) => live.get(e.source_key) !== undefined);
    const destGone = manifest.entries.filter((e) => live.get(e.dest_key) === undefined);
    check(`all ${EXPECT_AFFECTED} obsolete keys absent`, stillThere.length === 0, `${stillThere.length} remain`);
    check(`all ${EXPECT_AFFECTED} canonical destinations remain`, destGone.length === 0, `${destGone.length} missing`);

    const rowsAfter = await loadRows();
    const setsAfter = classify(rowsAfter);
    const nativeSame =
      setsAfter.native.length === manifest.nativeRows.length &&
      manifest.nativeRows.every((n) =>
        setsAfter.native.some((r) => r.id === n.id && r.storage_path === n.storage_path),
      );
    check('native attachments unchanged', nativeSame, `${setsAfter.native.length} vs ${manifest.nativeRows.length}`);
    const proof = await operationalProof(setsAfter.imported);
    check(
      `all imported rows readable == ${proof.total}`,
      proof.fetchedOk === proof.total,
      `${proof.fetchedOk}/${proof.total}`,
    );
    check(
      'post-delete sizes match wherever recorded',
      proof.sizeOk + proof.sizeSkipped === proof.total && proof.failedIds.length === 0,
      `match ${proof.sizeOk}, no-size ${proof.sizeSkipped}, failed ${proof.failedIds.length}`,
    );
    if (bail()) return;
    console.log('FINALIZE OK — repair complete.');
  }
})().catch((e) => {
  if (e instanceof ExitError) {
    console.error(e.message);
    process.exitCode = e.code;
    return;
  }
  console.error(`FAIL: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
});
