// React hook that wraps the offline queue for a single form. Coordinates:
//   - immediate-online happy path (try the insert, return 'synced')
//   - failure-classified queueing (network/5xx/RLS → queue, schema → throw)
//   - background sync (online event + 60s tick + manual button)
//   - stuck-row surfacing on mount + after each sync pass
//   - Phase 1D-A: hasPhotos branch with prepared-photo flow + atomic
//     submission+photo_blobs enqueue + state:'stuck' return
//
// Failure classification (PostgREST/insert path, order matters):
//   1. Network / TypeError ("Failed to fetch", etc.) → enqueue + return 'queued'.
//   2. Duplicate key (code 23505) on `client_submission_id` → SUCCESS (the
//      row is already there from a prior replay; treat as 'synced'). This
//      is the anon-friendly idempotency path — see comment block on
//      `attemptInsert` below.
//   3. PostgREST status >= 500 → enqueue (transient backend or auth blip).
//   4. RLS denial (status 401/403/code starting with '42') → enqueue.
//      Reasoning: anon RLS misfires intermittently on the test environment
//      under load; better to retry than to drop the row.
//   5. PostgREST 4xx with a code matching schema/validation patterns
//      (PGRST*, 23xxx other than the dup-key path above) → throw. These
//      are real bugs; surfacing is correct.
//   6. Anything else → enqueue (safe default).
//
// Storage error classification (Phase 1D-A, separate from PostgREST shape):
//   - Network / fetch / timeout → 'network' (queue + retry)
//   - status 500-599 / 429       → 'server'  (queue)
//   - status 409 (Duplicate)     → 'success-409' (continue, do not retry/stuck)
//   - status 401 / 403           → 'rls-stuck' (markStuckNow immediately —
//                                  usually missing bucket policy; surface
//                                  loudly per Codex review v2 #5)
//   - other 4xx                  → 'schema'  (stuck)
//   - unknown / no status        → 'unknown' (queue; retry budget eventually
//                                  stucks via MAX_RETRIES)
//
// Idempotency contract:
//   - The original Codex plan said `.upsert(..., {onConflict, ignoreDuplicates: true})`
//     but that breaks under anon RLS: PostgREST's ON CONFLICT path requires
//     SELECT privilege on the conflict-target column, and the public webform
//     tables (fuel_supplies / equipment_fuelings / weigh_ins / weigh_in_sessions)
//     all grant anon INSERT only. We use plain `.insert(record)` instead and
//     rely on the unique index alone for dedup; the resulting 23505 on a
//     replay is the "already synced" signal. Same idempotency guarantee, no
//     RLS expansion required.
//
// Don't trust navigator.onLine as a gate (it's a lie when DNS resolves but
// the host is unreachable). Treat the network attempt itself as the source
// of truth; use the 'online' event only as a sync trigger.

import {useCallback, useEffect, useRef, useState} from 'react';

import {sb} from './supabase.js';
import {newClientSubmissionId} from './clientSubmissionId.js';
import {buildRecord, getFormConfig} from './offlineForms.js';
import {preparePhotos, preparedToRowMeta, uploadPreparedPhotosSequential, StorageUploadError} from './dailyPhotos.js';
import {
  enqueueSubmission,
  enqueueSubmissionWithPhotos,
  listQueued,
  listStuck,
  listPhotoBlobsByCsid,
  markSyncing,
  markSynced,
  markFailed,
  markStuckNow,
  recoverStaleSyncing,
  retrySubmission,
  discardSubmission,
  MAX_RETRIES,
} from './offlineQueue.js';

const TICK_INTERVAL_MS = 60_000;

// Postgres unique-constraint violation. With our non-partial unique index
// on client_submission_id (mig 030), a duplicate replay of an already-
// synced row raises this code. The hook treats it as success.
const DUPLICATE_KEY_CODE = '23505';

function isDuplicateCsidViolation(err) {
  if (!err) return false;
  if (String(err.code) !== DUPLICATE_KEY_CODE) return false;
  // Be precise about WHICH constraint — a 23505 on an unrelated index
  // (e.g. cattle.tag) is a real bug, not an idempotency hit.
  const msg = String(err.message || '');
  return /client_submission_id/i.test(msg);
}

// 23505 on the active-daily-identity UNIQUE indexes (mig 084): a DIFFERENT
// active report already occupies this date+identity. Unlike a csid replay this
// is not the same row — but the queued row can never succeed, so on replay it
// is treated as superseded (discarded as synced) rather than stuck forever.
function isDailySupersededViolation(err) {
  if (!err) return false;
  if (String(err.code) !== DUPLICATE_KEY_CODE) return false;
  return /_active_daily_identity_uq/i.test(String(err.message || ''));
}

function dailySupersededMessage(record = {}) {
  const label = record.batch_label || record.herd || record.flock || '';
  const date = record.date || '';
  return label
    ? `A report already exists for ${label} on ${date}. Edit the existing report instead.`
    : `A report already exists for ${date}. Edit the existing report instead.`;
}

// Build a schema-class error carrying a friendly message so the live-submit
// catch paths re-raise it to the caller (classifyError keys on the 23 code)
// instead of silently queueing it for a retry that can never succeed.
function dailySupersededError(record) {
  const e = new Error(dailySupersededMessage(record));
  e.code = DUPLICATE_KEY_CODE;
  return e;
}

function classifyError(err) {
  // Plain network failure — fetch throws TypeError ("Failed to fetch") on
  // offline / DNS / aborted-connection.
  if (err instanceof TypeError) return 'network';
  if (err && err.name === 'TypeError') return 'network';
  if (err && err.message && /failed to fetch|network ?error|load failed/i.test(err.message)) return 'network';

  // PostgREST error shape — supabase-js v2 returns {message, code, details, hint, status}
  const status = err && err.status != null ? Number(err.status) : null;
  const code = err && err.code != null ? String(err.code) : '';

  if (status != null) {
    if (status >= 500) return 'server';
    if (status === 401 || status === 403) return 'rls';
    // 4xx schema/validation: PGRST116 = no rows, PGRST204 = no schema cache,
    // 23xxx (other than dup-csid handled above) = integrity constraints.
    // These are real bugs the operator can't fix.
    if (status >= 400 && status < 500) {
      if (/^PGRST/i.test(code) || /^23/.test(code) || /^22/.test(code)) return 'schema';
      // Unknown 4xx — queue rather than drop. Operator can discard from the
      // stuck modal if it really is stuck.
      return 'unknown';
    }
  }

  // Codeless schema-class fallback. supabase-js v2 sometimes returns PostgREST
  // error envelopes WITHOUT a `.status` field on the error object (only the
  // response status, which we can't read here). Mirrors useOfflineRpcSubmit's
  // codeless branch — PGRST* / 22* / 23* / P0001 codes always indicate
  // deterministic schema/validation problems regardless of HTTP status.
  if (/^PGRST/i.test(code) || /^23/.test(code) || /^22/.test(code) || code === 'P0001') return 'schema';

  return 'unknown';
}

// ----------------------------------------------------------------------------
// Storage error classifier (Phase 1D-A)
// ----------------------------------------------------------------------------
// supabase-js storage errors don't carry PostgREST shapes. The classifier
// inspects status/code/message of a StorageUploadError (or any storage
// error) and returns one of the offline-queue states.
function classifyStorageError(err) {
  if (!err) return 'unknown';
  // Network/fetch/timeout — same logic as the insert classifier's network branch.
  if (err instanceof TypeError) return 'network';
  if (err && err.name === 'TypeError') return 'network';
  if (err && err.message && /failed to fetch|network ?error|load failed|timeout/i.test(err.message)) return 'network';

  // supabase-js storage errors expose the HTTP status as `statusCode`
  // (string) on the native StorageApiError shape, NOT `status`. The hook's
  // StorageUploadError wrapper normalizes `status`, but raw storage errors
  // (e.g. when the queue worker reads error.statusCode directly without
  // the wrapper) still carry only `statusCode`. Fall back to it so the
  // classifier doesn't lose the status on either shape.
  const status = err.status != null ? Number(err.status) : err.statusCode != null ? Number(err.statusCode) : null;
  const code = err.code != null ? String(err.code) : '';

  if (status != null) {
    if (status >= 500) return 'server';
    if (status === 429) return 'server';
    if (status === 409) return 'success-409';
    if (status === 401 || status === 403) return 'rls-stuck';
    if (status >= 400 && status < 500) return 'schema';
  }
  // Codeless duplicate hint (some supabase-js paths drop status).
  if (/duplicate/i.test(code) || /duplicate/i.test(String(err.message))) return 'success-409';
  return 'unknown';
}

// Plain insert — anon RLS friendly. See top-of-file comment for why we
// don't use upsert + ignoreDuplicates here.
async function attemptInsert(formKind, record) {
  const cfg = getFormConfig(formKind);
  const {data, error} = await sb.from(cfg.table).insert(record);
  return {data, error};
}

/**
 * @param {string} formKind — registry key (e.g. 'fuel_supply').
 * @returns {{
 *   submit: (payload: object) => Promise<{state: 'synced' | 'queued' | 'stuck', csid: string, id: string, record: object, error?: object}>,
 *   syncNow: () => Promise<void>,
 *   stuckRows: Array<object>,
 *   queuedCount: number,
 *   refresh: () => Promise<void>,
 *   retryStuck: (csid: string) => Promise<void>,
 *   discardStuck: (csid: string) => Promise<void>,
 *   syncing: boolean,
 * }}
 */
export function useOfflineSubmit(formKind) {
  const [stuckRows, setStuckRows] = useState([]);
  const [queuedCount, setQueuedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  // Validate the form_kind once at mount — typos blow up loud, not silent.
  useEffect(() => {
    getFormConfig(formKind);
  }, [formKind]);

  const refresh = useCallback(async () => {
    const [queued, stuck] = await Promise.all([listQueued(formKind), listStuck(formKind)]);
    if (!mountedRef.current) return;
    setQueuedCount(queued.length);
    setStuckRows(stuck);
  }, [formKind]);

  const syncNow = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (mountedRef.current) setSyncing(true);
    try {
      // Recover any rows orphaned in 'syncing' from a prior tab/crash
      // mid-flight. Fresh in-flight rows (within the threshold) stay
      // 'syncing' so concurrent same-tab passes don't step on each other.
      await recoverStaleSyncing(formKind);
      await _drainQueuedFormKind(formKind, sb);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setSyncing(false);
      await refresh();
    }
  }, [formKind, refresh]);

  const submit = useCallback(
    async (payload, opts = {}) => {
      return _runSubmit({formKind, payload, opts, refresh});
    },
    [formKind, refresh],
  );

  const retryStuck = useCallback(
    async (csid) => {
      await retrySubmission(csid);
      await refresh();
      // Fire a sync pass immediately so the operator sees the result.
      await syncNow();
    },
    [refresh, syncNow],
  );

  const discardStuck = useCallback(
    async (csid) => {
      await discardSubmission(csid);
      await refresh();
    },
    [refresh],
  );

  // Mount: load existing stuck/queued state, fire one sync pass.
  useEffect(() => {
    mountedRef.current = true;
    refresh();
    syncNow();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, syncNow]);

  // Background triggers: online event + 60s tick.
  useEffect(() => {
    function handleOnline() {
      syncNow();
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline);
    }
    const id = setInterval(() => {
      // navigator.onLine is advisory, not authoritative — fire sync regardless;
      // the upsert call itself is the source of truth.
      syncNow();
    }, TICK_INTERVAL_MS);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', handleOnline);
      clearInterval(id);
    };
  }, [syncNow]);

  return {
    submit,
    syncNow,
    stuckRows,
    queuedCount,
    refresh,
    retryStuck,
    discardStuck,
    syncing,
  };
}

// ============================================================================
// Test-exported seams (mirrors useOfflineRpcSubmit pattern)
// ============================================================================
export const _classifyError = classifyError;
export const _classifyStorageError = classifyStorageError;

// ----------------------------------------------------------------------------
// _runSubmit — the submit() lifecycle without React. Test seam.
// ----------------------------------------------------------------------------
//
// Three return states (Phase 1D-A — Codex review v2.1 correction 4):
//   - 'synced' : row landed in DB (online happy path, OR 23505=already-synced)
//   - 'queued' : transient failure (network/5xx/unknown). Will replay later.
//   - 'stuck'  : deterministic failure (storage 401/403, row schema after
//                photo upload, etc.). Operator surfaces in stuck modal.
//
// Empty-photos short-circuit (Codex review v2.1 correction 7):
//   When formKind has hasPhotos:true but payload.photos is empty/absent,
//   the lifecycle falls through to the no-photo flat path so existing
//   pig_dailys_offline.spec.js cases stay green.
export async function _runSubmit({formKind, payload, opts = {}, refresh}) {
  const cfg = getFormConfig(formKind);
  const csid = opts.csid ?? newClientSubmissionId();
  const id = opts.id ?? `${formKind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // hasPhotos branch only fires if hasPhotos:true AND payload.photos has
  // at least 1 file. Empty/absent → flat path.
  const photoFiles = cfg.hasPhotos && Array.isArray(payload && payload.photos) ? payload.photos : [];
  if (photoFiles.length > 0) {
    return await _runSubmitWithPhotos({formKind, payload, photoFiles, csid, id, refresh});
  }

  return await _runFlatSubmit({formKind, payload, csid, id, refresh});
}

// ----------------------------------------------------------------------------
// Flat-row submit (no-photo path, byte-identical to pre-1D-A behavior)
// ----------------------------------------------------------------------------
async function _runFlatSubmit({formKind, payload, csid, id, refresh}) {
  // Build the row WITHOUT raw photo files (caller may have passed them; the
  // hasPhotos branch handles those above). buildRecord already coerces to
  // photos:[] when payload.photos is empty/absent.
  const sanitized = sanitizePhotosFromPayload(payload, []);
  const record = buildRecord(formKind, sanitized, {id, csid});

  try {
    const {error} = await attemptInsert(formKind, record);
    if (!error) {
      return {state: 'synced', csid, id, record};
    }
    if (isDuplicateCsidViolation(error)) {
      return {state: 'synced', csid, id, record};
    }
    if (isDailySupersededViolation(error)) {
      // A different active report already holds this date+identity (raced past
      // the pre-submit guard). Surface the friendly message; do not queue.
      throw dailySupersededError(record);
    }
    const kind = classifyError(error);
    if (kind === 'schema') {
      throw new Error(`offlineSubmit: schema/validation error: ${error.message ?? error.code ?? 'unknown'}`);
    }
    await enqueueSubmission({formKind, csid, payload: sanitized, record});
    await markFailed(csid, error.message ?? `${kind} error`);
    if (refresh) await refresh();
    return {state: 'queued', csid, id, record};
  } catch (err) {
    const kind = classifyError(err);
    if (kind === 'schema') {
      throw err;
    }
    await enqueueSubmission({formKind, csid, payload: sanitized, record});
    await markFailed(csid, err && err.message ? err.message : String(err));
    if (refresh) await refresh();
    return {state: 'queued', csid, id, record};
  }
}

// ----------------------------------------------------------------------------
// hasPhotos submit lifecycle (Codex review v2.1 corrections 1+2+3+4)
// ----------------------------------------------------------------------------
//
// Memory-only preparation, atomic enqueue on any queue/stuck path, and
// state:'stuck' return for deterministic failures (storage 401/403, row
// schema-after-upload).
//
// Online happy path produces NO IDB writes. Tab death pre-upload loses the
// in-memory blobs — same loss profile as a no-photo submit dying mid-attempt.
async function _runSubmitWithPhotos({formKind, payload, photoFiles, csid, id, refresh}) {
  // Step 1: prepare (compress + path/captured_at) ONCE in memory.
  // preparePhotos errors (RangeError on >10, TypeError on bad input,
  // compressImage decode failures) are deterministic operator errors.
  // Let them throw inline — nothing has hit IDB or storage yet, no cleanup
  // needed. Caller's try/catch surfaces inline.
  const prepared = await preparePhotos(formKind, csid, photoFiles);

  // Step 2: build the daily-row record with sanitized photo metadata.
  const photoMeta = preparedToRowMeta(prepared);
  const sanitized = sanitizePhotosFromPayload(payload, photoMeta);
  const record = buildRecord(formKind, sanitized, {id, csid});

  // Step 3: try uploads online, sequential.
  let uploadsCompleted = false;
  try {
    await uploadPreparedPhotosSequential(sb, prepared, {upsert: false});
    uploadsCompleted = true;
  } catch (uploadErr) {
    const kind = classifyStorageError(uploadErr);
    if (kind === 'rls-stuck' || kind === 'schema') {
      // Codex review v2.1 correction 4: surface loudly via stuck modal.
      // Atomic enqueue with stuck status so the operator can retry after
      // a policy/code fix.
      await enqueueSubmissionWithPhotos({
        csid,
        formKind,
        payload: sanitized,
        record,
        photos: prepared,
        status: 'failed',
        retryCount: MAX_RETRIES,
        lastError: storageErrSummary(uploadErr),
      });
      if (refresh) await refresh();
      return {state: 'stuck', csid, id, record, error: uploadErr};
    }
    // network / server / unknown / success-409-but-thrown(?) → queue + retry.
    await enqueueSubmissionWithPhotos({
      csid,
      formKind,
      payload: sanitized,
      record,
      photos: prepared,
      status: 'queued',
      retryCount: 1,
      lastError: storageErrSummary(uploadErr),
    });
    if (refresh) await refresh();
    return {state: 'queued', csid, id, record, error: uploadErr};
  }

  // Step 4: row insert. Reached only when all photos uploaded.
  void uploadsCompleted;
  try {
    const {error} = await attemptInsert(formKind, record);
    if (!error) {
      // Synced happy path. Nothing in IDB to clean up — we never wrote.
      return {state: 'synced', csid, id, record};
    }
    if (isDuplicateCsidViolation(error)) {
      // Already-synced replay. Same IDB story.
      return {state: 'synced', csid, id, record};
    }
    if (isDailySupersededViolation(error)) {
      // Superseded by an existing active report. Re-raise as schema-class so
      // the catch below routes it to STUCK with the friendly message (photos
      // are already uploaded; the operator can discard the redundant row).
      throw dailySupersededError(record);
    }
    const kind = classifyError(error);
    if (kind === 'schema') {
      // Codex review v2.1 correction 3: schema-after-photo-upload goes to
      // STUCK (not throw). Photos are already in the bucket; queueing
      // preserves recovery after a code/schema fix.
      await enqueueSubmissionWithPhotos({
        csid,
        formKind,
        payload: sanitized,
        record,
        photos: prepared,
        status: 'failed',
        retryCount: MAX_RETRIES,
        lastError: error.message ?? error.code ?? 'schema error',
      });
      if (refresh) await refresh();
      return {state: 'stuck', csid, id, record, error};
    }
    // network / server / 401/403 / unknown → queue + retry.
    await enqueueSubmissionWithPhotos({
      csid,
      formKind,
      payload: sanitized,
      record,
      photos: prepared,
      status: 'queued',
      retryCount: 1,
      lastError: error.message ?? `${kind} error`,
    });
    if (refresh) await refresh();
    return {state: 'queued', csid, id, record, error};
  } catch (err) {
    const kind = classifyError(err);
    if (kind === 'schema') {
      // Same as the error-envelope schema branch — go to stuck, don't throw.
      await enqueueSubmissionWithPhotos({
        csid,
        formKind,
        payload: sanitized,
        record,
        photos: prepared,
        status: 'failed',
        retryCount: MAX_RETRIES,
        lastError: err && err.message ? err.message : String(err),
      });
      if (refresh) await refresh();
      return {state: 'stuck', csid, id, record, error: err};
    }
    await enqueueSubmissionWithPhotos({
      csid,
      formKind,
      payload: sanitized,
      record,
      photos: prepared,
      status: 'queued',
      retryCount: 1,
      lastError: err && err.message ? err.message : String(err),
    });
    if (refresh) await refresh();
    return {state: 'queued', csid, id, record, error: err};
  }
}

function sanitizePhotosFromPayload(payload, photoMeta) {
  if (!payload) return {photos: photoMeta};
  const next = {...payload};
  next.photos = photoMeta;
  return next;
}

function storageErrSummary(err) {
  if (!err) return 'storage upload failed';
  if (err instanceof StorageUploadError) {
    return `${err.message} (status=${err.status ?? '?'} code=${err.code ?? '?'} key=${err.photo_key ?? '?'})`;
  }
  return err.message ?? String(err);
}

// ----------------------------------------------------------------------------
// _syncQueuedEntry — drain ONE queued entry. Test seam (Codex correction 8).
// ----------------------------------------------------------------------------
//
// hasPhotos branch:
//   - listPhotoBlobsByCsid(csid) MUST match record.photos.length and every
//     path. Mismatch → markStuckNow + skip insert (Codex correction 5).
//   - Sequential upload with upsert:false. 409 = success-continue (the path
//     already exists in the bucket from a prior partial attempt; same csid
//     means same content). 401/403 → markStuckNow. Other classifier
//     branches per the table above.
//   - On all uploads succeeded, attempt insert. 23505 = synced.
//
// Empty-photos branch: drains straight to insert (no-photo flat path).
export async function _syncQueuedEntry(formKind, entry, sbClient = sb) {
  await markSyncing(entry.csid);
  const recordPhotos = Array.isArray(entry.record && entry.record.photos) ? entry.record.photos : [];
  const cfg = getFormConfig(formKind);
  const expectsPhotos = cfg.hasPhotos && recordPhotos.length > 0;

  if (expectsPhotos) {
    // Codex correction 5: replay guard. Confirm photo_blobs exists for every
    // path in record.photos before touching storage or the row.
    const blobs = await listPhotoBlobsByCsid(entry.csid);
    if (blobs.length !== recordPhotos.length) {
      await markStuckNow(entry.csid, 'photo_blobs missing or incomplete (count mismatch)');
      return;
    }
    const blobPaths = new Set(blobs.map((b) => b.key));
    for (const meta of recordPhotos) {
      if (!blobPaths.has(meta.path)) {
        await markStuckNow(entry.csid, `photo_blobs missing for path ${meta.path}`);
        return;
      }
    }
    // Sequential upload with upsert:false. RLS on `daily-photos` grants
    // authenticated INSERT only (mig 099 daily_photos_auth_insert; the dead
    // anon INSERT policy was dropped by mig 109) — there is NO UPDATE policy.
    // upsert:true would trigger an UPSERT (INSERT-OR-UPDATE) and
    // fail 403 RLS even on a fresh INSERT path because supabase-storage's
    // upsert path checks the UPDATE policy too. With upsert:false, a fresh
    // path INSERTs cleanly; an already-existing path 409s, which the
    // classifier treats as 'success-continue' (idempotent — the prior
    // upload bytes are identical to ours since path is content-addressed
    // by csid + photo_key + same compressed source). Net effect matches
    // upsert:true semantically without needing an UPDATE policy.
    for (const blob of blobs) {
      try {
        const {error} = await sbClient.storage
          .from('daily-photos')
          .upload(blob.key, blob.blob, {upsert: false, contentType: blob.mime ?? 'image/jpeg'});
        if (error) {
          const wrapped = new StorageUploadError({
            message: error.message ?? 'storage upload failed',
            status: error.statusCode != null ? Number(error.statusCode) : error.status,
            code: error.error ?? error.code,
            path: blob.key,
            photo_key: blob.photo_key,
            cause: error,
          });
          const kind = classifyStorageError(wrapped);
          if (kind === 'success-409') continue;
          if (kind === 'rls-stuck' || kind === 'schema') {
            await markStuckNow(entry.csid, storageErrSummary(wrapped));
            return;
          }
          await markFailed(entry.csid, storageErrSummary(wrapped));
          return;
        }
      } catch (err) {
        const kind = classifyStorageError(err);
        if (kind === 'rls-stuck' || kind === 'schema') {
          await markStuckNow(entry.csid, storageErrSummary(err));
          return;
        }
        await markFailed(entry.csid, storageErrSummary(err));
        return;
      }
    }
  }

  // Insert the row. Same classifier as the flat path.
  try {
    const {error} = await sbClient.from(cfg.table).insert(entry.record);
    if (error) {
      if (isDuplicateCsidViolation(error) || isDailySupersededViolation(error)) {
        // csid replay = already synced; identity collision = superseded by an
        // existing active report. Either way the queued row is redundant and
        // can never succeed — discard as synced instead of sticking forever.
        await markSynced(entry.csid);
        return;
      }
      const kind = classifyError(error);
      if (kind === 'schema') {
        await markStuckNow(entry.csid, error.message ?? 'schema error');
        return;
      }
      await markFailed(entry.csid, error.message ?? `${kind} error`);
      return;
    }
    await markSynced(entry.csid);
  } catch (err) {
    await markFailed(entry.csid, err && err.message ? err.message : String(err));
  }
}

// ----------------------------------------------------------------------------
// _drainQueuedFormKind — drain ALL queued entries for a form-kind. Test seam.
// ----------------------------------------------------------------------------
export async function _drainQueuedFormKind(formKind, sbClient = sb) {
  const queued = await listQueued(formKind);
  for (const entry of queued) {
    await _syncQueuedEntry(formKind, entry, sbClient);
  }
}
