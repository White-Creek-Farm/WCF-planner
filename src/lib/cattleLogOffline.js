// Cattle Log offline queue (create-only) — queue, replay, and React hook.
//
// Contract (Cattle Log implementation contract, OFFLINE section):
//   - Queue record payload: {id, body, mentions, isIssue, calfNotes,
//     attachments: [{key, name, mime, size, is_image, captured_at}]}.
//     Attachment bytes are persisted as Blobs in IndexedDB next to the row
//     (offlineQueue.js is the single IDB owner — this module never touches
//     IDB directly).
//   - Replay, per record: for each attachment key not yet in uploadedPaths,
//     upload the blob to the comment-photos bucket at the deterministic path
//     'cattle.log/cattle-log/<entryId>/<index>-<sanitizedName>' with
//     upsert:false (a duplicate-object error COUNTS AS SUCCESS), persisting
//     uploadedPaths after EACH upload; then call submit_cattle_log_entry with
//     the uploaded paths as attachments. The RPC is replay-idempotent via
//     p_id, so double-replay is safe.
//   - Failure routing via classifyCattleLogError (cattleLogApi.js):
//     'transient' stays queued for the next pass (no retry cap);
//     'ambiguous_tag' / 'mention_invalid' / 'validation' flip the row to
//     needs_attention (never silently dropped) for operator Retry/Discard.
//   - Offline submits do NOT require calf notes (server accepts unresolved
//     tags without them on the replay path). No offline edit/delete/toggle.
//
// NOTE for the storage_upload_owner static guard: this module is a NEW
// upload owner (1 call) against the comment-photos bucket. The pinned
// EXPECTED_UPLOAD_OWNERS map + total in
// tests/static/storage_upload_owner_static.test.js must be updated by the
// guard owner.

import {useCallback, useEffect, useRef, useState} from 'react';

import {COMMENT_ATTACHMENT_BUCKET, MAX_COMMENT_ATTACHMENTS, MAX_DOCUMENT_BYTES} from './commentAttachments.js';
import {compressImage} from './photoCompress.js';
import {isStorageDuplicateError} from './tasks.js';
import {
  CATTLE_LOG_FORM_KIND,
  appendCattleLogUploadedPath,
  discardSubmission,
  enqueueCattleLogSubmission,
  listByFormKind,
  listPhotoBlobsByCsid,
  listQueued,
  markSynced,
  markSyncing,
  recoverStaleSyncing,
  setCattleLogOutcome,
} from './offlineQueue.js';

export const CATTLE_LOG_SUBMIT_RPC = 'submit_cattle_log_entry';

const TICK_INTERVAL_MS = 60_000;
const MAX_CATTLE_LOG_MENTIONS = 10;
// Server cap on body length (submit RPC rejects longer). Validated at queue
// time so an oversized entry can't enter the queue and dead-end as a
// needs-attention row whose Retry can never succeed.
const MAX_CATTLE_LOG_BODY_LEN = 4000;

// Same allowlist as commentAttachments.js (private there) — images are
// compressed to JPEG at queue time so the persisted blob's bytes equal what
// replay sends, keeping the deterministic path's content stable across
// retries.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];

// ── Deterministic paths ─────────────────────────────────────────────────────

/**
 * Storage-key-safe file name: basename only, conservative charset, never
 * empty. The sanitized name is computed ONCE at queue time and persisted in
 * payload.attachments[].key — later sanitizer changes can't break replay
 * determinism for already-queued rows.
 */
export function sanitizeCattleLogFileName(name) {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '');
  return base || 'attachment';
}

/**
 * 'cattle.log/cattle-log/<entryId>/<index>-<sanitizedName>' — satisfies the
 * server-side prefix check (paths must start with 'cattle.log/cattle-log/')
 * and is unique per attachment via the 0-based array index.
 */
export function buildCattleLogAttachmentPath(entryId, index, fileName) {
  return `cattle.log/cattle-log/${entryId}/${index}-${sanitizeCattleLogFileName(fileName)}`;
}

// ── Queue record mapping ────────────────────────────────────────────────────

/**
 * Map a raw submissions-store row to the contract queue-record shape the
 * page consumes. The internal 'syncing' status is exposed as 'queued' —
 * in-flight is an implementation detail; the operator-facing states are
 * exactly 'queued' | 'needs_attention'.
 */
export function toCattleLogQueueRecord(row) {
  if (!row) return null;
  return {
    id: row.csid,
    form: CATTLE_LOG_FORM_KIND,
    payload: row.payload ?? null,
    status: row.status === 'needs_attention' ? 'needs_attention' : 'queued',
    errorClass: row.errorClass ?? null,
    errorMessage: row.errorMessage ?? null,
    uploadedPaths: Array.isArray(row.uploadedPaths) ? row.uploadedPaths : [],
    createdAt: row.created_at ?? null,
  };
}

export async function listCattleLogQueue() {
  const rows = await listByFormKind(CATTLE_LOG_FORM_KIND);
  return rows
    .slice()
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .map(toCattleLogQueueRecord);
}

// ── Enqueue ─────────────────────────────────────────────────────────────────

function isImageFile(file) {
  return IMAGE_TYPES.includes(file.type);
}

/**
 * Prepare one File/Blob for the queue: compress images to JPEG (parity with
 * uploadCommentAttachment's online path), enforce the 10MB document cap, and
 * compute the deterministic storage key.
 */
async function prepareCattleLogAttachment(entryId, index, file) {
  if (!file) {
    throw new Error('cattleLogOffline: attachment file required');
  }
  let blob = file;
  let mime = file.type || 'application/octet-stream';
  let name = file.name || `attachment-${index + 1}`;
  if (isImageFile(file)) {
    blob = await compressImage(file);
    mime = 'image/jpeg';
    name = `${name.replace(/\.[^.]*$/, '') || 'photo'}.jpg`;
  } else if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`File too large: ${Math.round(file.size / 1024 / 1024)}MB (max 10MB)`);
  }
  const key = buildCattleLogAttachmentPath(entryId, index, name);
  return {
    key,
    photo_key: `photo-${index + 1}`,
    blob,
    mime,
    size_bytes: blob.size ?? 0,
    name,
    captured_at: new Date().toISOString(),
  };
}

/**
 * Queue a cattle log entry (with optional attachment Files) for offline
 * replay. Returns the contract-shaped queue record.
 *
 * @param {object} payload — {id, body, mentions?, isIssue?, calfNotes?}
 *   where id is the client-generated entry id ('cl-…').
 * @param {Array<File|Blob>} [files] — up to MAX_COMMENT_ATTACHMENTS.
 */
export async function queueCattleLogEntry(payload, files = []) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('cattleLogOffline.queueCattleLogEntry: payload required');
  }
  const id = payload.id;
  if (!id || typeof id !== 'string') {
    throw new Error('cattleLogOffline.queueCattleLogEntry: payload.id (entry id) required');
  }
  // Entry-id invariants the mirror-id scheme depends on: never the mirror
  // prefix, never the mirror separator.
  if (id.startsWith('clog-') || id.includes('--')) {
    throw new Error(`cattleLogOffline.queueCattleLogEntry: invalid entry id '${id}'`);
  }
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (body.trim().length < 4) {
    throw new Error('cattleLogOffline.queueCattleLogEntry: body must be at least 4 characters');
  }
  if (body.trim().length > MAX_CATTLE_LOG_BODY_LEN) {
    throw new Error(`cattleLogOffline.queueCattleLogEntry: body must be at most ${MAX_CATTLE_LOG_BODY_LEN} characters`);
  }
  const mentions = Array.isArray(payload.mentions) ? payload.mentions : [];
  if (mentions.length > MAX_CATTLE_LOG_MENTIONS) {
    throw new Error(`cattleLogOffline.queueCattleLogEntry: max ${MAX_CATTLE_LOG_MENTIONS} mentions`);
  }
  const fileList = Array.isArray(files) ? files : [];
  if (fileList.length > MAX_COMMENT_ATTACHMENTS) {
    throw new Error(`cattleLogOffline.queueCattleLogEntry: max ${MAX_COMMENT_ATTACHMENTS} attachments`);
  }

  const prepared = [];
  for (let i = 0; i < fileList.length; i++) {
    prepared.push(await prepareCattleLogAttachment(id, i, fileList[i]));
  }

  const row = await enqueueCattleLogSubmission({
    csid: id,
    payload: {
      id,
      body,
      mentions,
      isIssue: payload.isIssue !== false,
      calfNotes: payload.calfNotes && typeof payload.calfNotes === 'object' ? payload.calfNotes : {},
      // Blob-free attachment metadata — the single source of truth for both
      // the replay uploads and the RPC p_attachments shape.
      attachments: prepared.map((p) => ({
        key: p.key,
        name: p.name,
        mime: p.mime,
        size: p.size_bytes,
        is_image: IMAGE_TYPES.includes(p.mime),
        captured_at: p.captured_at,
      })),
    },
    attachments: prepared,
  });
  return toCattleLogQueueRecord(row);
}

// ── Replay ──────────────────────────────────────────────────────────────────

function isDuplicateUploadError(error) {
  if (isStorageDuplicateError(error)) return true;
  // Parity with uploadCommentAttachment's tolerant message check.
  return /duplicate|23505|409/i.test((error && error.message) || '');
}

async function uploadCattleLogAttachment(sb, path, blob, mime) {
  const {error} = await sb.storage
    .from(COMMENT_ATTACHMENT_BUCKET)
    .upload(path, blob, {contentType: mime || 'application/octet-stream', upsert: false});
  if (error && !isDuplicateUploadError(error)) throw error;
}

// Default classifier comes from cattleLogApi.js. Loaded lazily (and cached)
// so this module has no static dependency on the API module; tests inject
// their own classifier and never hit the import.
let defaultClassifierPromise = null;
function getDefaultClassifier() {
  if (!defaultClassifierPromise) {
    defaultClassifierPromise = import('./cattleLogApi.js')
      .then((mod) => mod.classifyCattleLogError)
      .catch((err) => {
        defaultClassifierPromise = null;
        throw err;
      });
  }
  return defaultClassifierPromise;
}

/**
 * Replay every queued cattle log entry (oldest first). Safe to call
 * repeatedly and concurrently with itself across triggers — rows flip to
 * 'syncing' while in flight and recoverStaleSyncing un-wedges interrupted
 * passes. needs_attention rows are NOT replayed (operator Retry re-queues).
 *
 * @param {object} sb — supabase client.
 * @param {object} [opts]
 * @param {(err: unknown) => string} [opts.classifyError] — defaults to
 *   classifyCattleLogError from cattleLogApi.js.
 * @returns {Promise<Array<{id, state: 'synced'|'queued'|'needs_attention',
 *   errorClass?, errorMessage?, data?}>>}
 */
export async function replayCattleLogQueue(sb, {classifyError} = {}) {
  const classify = classifyError || (await getDefaultClassifier());
  await recoverStaleSyncing(CATTLE_LOG_FORM_KIND);
  const queued = (await listQueued(CATTLE_LOG_FORM_KIND))
    .slice()
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  const results = [];
  for (const row of queued) {
    await markSyncing(row.csid);
    try {
      const payload = row.payload || {};
      const metas = Array.isArray(payload.attachments) ? payload.attachments : [];
      const uploaded = new Set(Array.isArray(row.uploadedPaths) ? row.uploadedPaths : []);
      let blobRows = null;
      for (const meta of metas) {
        if (uploaded.has(meta.key)) continue;
        if (blobRows === null) blobRows = await listPhotoBlobsByCsid(row.csid);
        const blobRow = blobRows.find((b) => b.key === meta.key);
        if (!blobRow || !blobRow.blob) {
          // Bytes are gone (evicted/corrupt IDB). Deterministic — retrying
          // can't recover them; surface for operator discard + re-submit.
          const missing = new Error(`CATTLE_LOG_VALIDATION: attachment bytes missing for ${meta.key}`);
          missing.cattleLogErrorClass = 'validation';
          throw missing;
        }
        await uploadCattleLogAttachment(sb, meta.key, blobRow.blob, meta.mime);
        // Persist after EACH upload so an interruption mid-record resumes
        // without re-sending finished bytes.
        await appendCattleLogUploadedPath(row.csid, meta.key);
        uploaded.add(meta.key);
      }
      const {data, error} = await sb.rpc(CATTLE_LOG_SUBMIT_RPC, {
        p_id: payload.id,
        p_body: payload.body,
        p_mentions: Array.isArray(payload.mentions) ? payload.mentions : [],
        p_attachments: metas.map((m) => ({
          path: m.key,
          name: m.name ?? null,
          mime: m.mime ?? null,
          is_image: m.is_image ?? String(m.mime || '').startsWith('image/'),
          captured_at: m.captured_at ?? null,
        })),
        p_is_issue: payload.isIssue !== false,
        p_calf_notes: payload.calfNotes && typeof payload.calfNotes === 'object' ? payload.calfNotes : {},
      });
      if (error) throw error;
      // Clean return — {replayed: true} and a fresh insert both count as
      // synced; the entry exists server-side either way.
      await markSynced(row.csid);
      results.push({id: row.csid, state: 'synced', data: data ?? null});
    } catch (err) {
      const errorClass = err && err.cattleLogErrorClass ? err.cattleLogErrorClass : classify(err);
      const errorMessage = err && err.message ? err.message : String(err);
      if (errorClass === 'transient') {
        await setCattleLogOutcome(row.csid, {status: 'queued', errorClass: 'transient', errorMessage});
        results.push({id: row.csid, state: 'queued', errorClass: 'transient', errorMessage});
      } else {
        await setCattleLogOutcome(row.csid, {status: 'needs_attention', errorClass, errorMessage});
        results.push({id: row.csid, state: 'needs_attention', errorClass, errorMessage});
      }
    }
  }
  return results;
}

// ── Hook ────────────────────────────────────────────────────────────────────

/**
 * Queue-state hook for CattleLogPage. Auto-replays on mount, window
 * 'online', visibilitychange→visible, and a 60s tick (useOfflineRpcSubmit
 * precedent).
 *
 * @param {object} sb — supabase client.
 * @returns {{entries, enqueue, retry, discard, syncing, syncNow, refresh}}
 *   entries: contract queue records, newest first;
 *   enqueue(payload, files): queue + refresh, returns the record;
 *   retry(id): re-queue a needs_attention row, then replay;
 *   discard(id): drop the row + its blobs (storage objects already uploaded
 *     are NOT auto-deleted — same caveat as discardSubmission).
 */
export function useCattleLogQueue(sb) {
  const [entries, setEntries] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    const list = await listCattleLogQueue();
    if (!mountedRef.current) return;
    setEntries(list);
  }, []);

  const syncNow = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (mountedRef.current) setSyncing(true);
    try {
      await replayCattleLogQueue(sb);
    } catch {
      // Replay never intentionally throws (failures are routed per-record);
      // a hard throw here (e.g. IDB unavailable) must not kill the page.
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setSyncing(false);
      await refresh();
    }
  }, [sb, refresh]);

  const enqueue = useCallback(
    async (payload, files) => {
      const record = await queueCattleLogEntry(payload, files);
      await refresh();
      return record;
    },
    [refresh],
  );

  const retry = useCallback(
    async (id) => {
      await setCattleLogOutcome(id, {status: 'queued'});
      await refresh();
      await syncNow();
    },
    [refresh, syncNow],
  );

  const discard = useCallback(
    async (id) => {
      await discardSubmission(id);
      await refresh();
    },
    [refresh],
  );

  // Mount: load queue state, fire one replay pass.
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    syncNow();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, syncNow]);

  // Background triggers: online event + visibility return + 60s tick.
  useEffect(() => {
    function handleOnline() {
      syncNow();
    }
    function handleVisibility() {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') syncNow();
    }
    if (typeof window !== 'undefined') window.addEventListener('online', handleOnline);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);
    const tick = setInterval(() => {
      syncNow();
    }, TICK_INTERVAL_MS);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', handleOnline);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(tick);
    };
  }, [syncNow]);

  return {entries, enqueue, retry, discard, syncing, syncNow, refresh};
}
