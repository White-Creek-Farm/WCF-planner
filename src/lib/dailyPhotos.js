// Daily-report photo upload helpers.
//
// One source-of-truth for path scheme + metadata shape across every daily
// form (cattle, sheep, pig, poultry/broiler, layer). Egg dailys excluded —
// migration 030 deliberately omitted egg_dailys.photos. Add Feed deferred
// until the parent-submission/RPC design lands.
//
// Path scheme (locked in PROJECT.md §8 Initiative C v1 plan):
//
//   <form_kind>/<client_submission_id>/<photo_key>.jpg
//
// e.g.  cattle_dailys/csid-abc-123/photo-1.jpg
//
// Metadata shape (mirrors equipment_fuelings.photos from migration 018):
//
//   {path, name, mime, size_bytes, captured_at}
//
// Path-only — never publicUrl. The daily-photos bucket is private; admin
// reads via signed URLs (10-min expiry, mirroring fuel-bills bucket
// pattern from migration 026).

import {compressImage} from './photoCompress.js';

export const DAILY_BUCKET = 'daily-photos';
export const MAX_PHOTOS_PER_REPORT = 10;

const VALID_FORM_KINDS = Object.freeze([
  'cattle_dailys',
  'sheep_dailys',
  'pig_dailys',
  'poultry_dailys',
  'layer_dailys',
]);

export function isValidFormKind(formKind) {
  return VALID_FORM_KINDS.includes(formKind);
}

export function buildPhotoPath(formKind, csid, photoKey) {
  if (!isValidFormKind(formKind)) {
    throw new Error(`buildPhotoPath: invalid formKind ${JSON.stringify(formKind)}`);
  }
  if (!csid || typeof csid !== 'string') {
    throw new Error('buildPhotoPath: csid required');
  }
  if (!photoKey || typeof photoKey !== 'string') {
    throw new Error('buildPhotoPath: photoKey required');
  }
  return `${formKind}/${csid}/${photoKey}.jpg`;
}

/**
 * Compress + upload a single daily-report photo.
 *
 * @param {object} sb — the shared authenticated supabase client. Daily-report
 *   forms are login-required, so uploads run as the authenticated role under
 *   daily_photos_auth_insert (mig 099).
 * @param {string} formKind — one of `cattle_dailys` / `sheep_dailys` / etc.
 * @param {string} csid — client_submission_id for the parent daily row.
 * @param {string} photoKey — stable per-photo key, e.g. 'photo-1'.
 * @param {File|Blob} file — original image; will be compressed before upload.
 * @returns {Promise<object>} canonical photo metadata for the row's
 *   `photos` jsonb column.
 */
export async function uploadDailyPhoto(sb, formKind, csid, photoKey, file) {
  if (!file) throw new Error('uploadDailyPhoto: file required');
  const compressed = await compressImage(file);
  const path = buildPhotoPath(formKind, csid, photoKey);
  const {error} = await sb.storage
    .from(DAILY_BUCKET)
    .upload(path, compressed, {upsert: false, contentType: 'image/jpeg'});
  if (error) {
    throw new Error(`uploadDailyPhoto: ${error.message ?? 'upload failed'}`);
  }
  return formatPhotoForRow({
    path,
    name: file.name || `${photoKey}.jpg`,
    mime: 'image/jpeg',
    size_bytes: compressed.size,
  });
}

/**
 * Build the canonical photo-metadata shape stored in `*_dailys.photos`.
 * Caller can hand-roll an entry too — this helper just locks the field
 * names + adds `captured_at`.
 */
export function formatPhotoForRow({path, name, mime, size_bytes}) {
  return {
    path,
    name: name ?? null,
    mime: mime ?? 'image/jpeg',
    size_bytes: size_bytes ?? null,
    captured_at: new Date().toISOString(),
  };
}

/**
 * Sequentially compress + upload every selected file. Aborts on the first
 * failure (per locked decision: no partial-photo row insert). Returns the
 * full list of metadata entries on success.
 *
 * Sequential, not parallel: keeps cellular bandwidth predictable, gives the
 * UI a clean per-file progress signal, and means a partial-success state
 * is impossible (the first failure stops the chain).
 */
export async function uploadDailyPhotosSequential(sb, formKind, csid, files, onPhotoUploaded) {
  if (files.length > MAX_PHOTOS_PER_REPORT) {
    throw new Error(`uploadDailyPhotosSequential: max ${MAX_PHOTOS_PER_REPORT} photos per submission`);
  }
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const photoKey = `photo-${i + 1}`;
    const meta = await uploadDailyPhoto(sb, formKind, csid, photoKey, files[i]);
    results.push(meta);
    if (typeof onPhotoUploaded === 'function') onPhotoUploaded(i, meta);
  }
  return results;
}

export const _VALID_FORM_KINDS = VALID_FORM_KINDS;

// ============================================================================
// Phase 1D-A — prepared-photo flow (compress once, then reuse the blob)
// ============================================================================
// The legacy uploadDailyPhoto helper compresses internally on every call.
// That's fine for the synchronous online-only path WebformHub uses today
// (1D-B will migrate that callsite). For the offline queue we need to:
//
//   1. Compress every selected file ONCE at submit time.
//   2. Stamp captured_at ONCE at preparation time (replay must not re-stamp).
//   3. Persist the compressed blob to IDB if we end up queueing.
//   4. Replay uses the stored blob with upsert:false and never re-compresses.
//      An already-uploaded path returns 409 which the storage classifier
//      treats as success-continue. (Phase 1D-A originally specified
//      upsert:true; switched to upsert:false because daily-photos grants
//      authenticated INSERT only (mig 099; the dead anon INSERT policy was
//      dropped by mig 109) with no UPDATE policy — the upsert path triggers
//      an UPDATE policy check and 403s even on fresh paths. Net replay
//      behavior identical.)
//
// PreparedPhoto carries everything the row's photos jsonb needs PLUS the
// raw compressed blob. The hook strips the blob before writing the
// submissions row (sanitized payload contract from Codex review v2 #6) but
// keeps the blob in the photo_blobs store.
//
// Shape (informally):
//
//   PreparedPhoto = {
//     photo_key:   string,    // 'photo-1' | 'photo-2' | ...
//     path:        string,    // <form_kind>/<csid>/<photo_key>.jpg
//     blob:        Blob,      // compressed JPEG
//     name:        string | null,    // original filename for row meta
//     mime:        string,    // 'image/jpeg' (post-compression)
//     size_bytes:  number,    // compressed size
//     captured_at: string,    // ISO timestamp; stamped once
//   }

/**
 * Custom error class for prepared-photo storage uploads. Preserves the
 * underlying supabase-js storage error's status/code/message PLUS the path
 * + photo_key that failed, so the queue's storage-error classifier can
 * distinguish 409/401/403/5xx/network without losing precision.
 */
export class StorageUploadError extends Error {
  constructor({message, status, code, path, photo_key, cause}) {
    super(message ?? 'storage upload failed');
    this.name = 'StorageUploadError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.photo_key = photo_key;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Compress + prepare every file for submission. Call this ONCE at submit
 * time. The returned array is consumed both by the online upload path
 * (uploadPreparedPhotosSequential) and, on failure, by the offline-queue
 * persistence path (offlineQueue.enqueueSubmissionWithPhotos).
 *
 * @param {string} formKind
 * @param {string} csid
 * @param {File[]|Blob[]} files
 * @returns {Promise<Array>} PreparedPhoto[] (see top-of-section shape)
 */
export async function preparePhotos(formKind, csid, files) {
  if (!isValidFormKind(formKind)) {
    throw new Error(`preparePhotos: invalid formKind ${JSON.stringify(formKind)}`);
  }
  if (!csid) throw new Error('preparePhotos: csid required');
  if (!Array.isArray(files)) throw new TypeError('preparePhotos: files must be an array');
  if (files.length > MAX_PHOTOS_PER_REPORT) {
    // Codex correction 10: defense-in-depth cap at the helper level. UI
    // also validates, but the hook callsite shouldn't be the only guard.
    throw new RangeError(`preparePhotos: max ${MAX_PHOTOS_PER_REPORT} photos per submission (got ${files.length})`);
  }
  const capturedAt = new Date().toISOString();
  const out = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const photo_key = `photo-${i + 1}`;
    const compressed = await compressImage(file);
    out.push({
      photo_key,
      path: buildPhotoPath(formKind, csid, photo_key),
      blob: compressed,
      name: (file && file.name) || `${photo_key}.jpg`,
      mime: 'image/jpeg',
      size_bytes: compressed.size,
      captured_at: capturedAt,
    });
  }
  return out;
}

/**
 * Strip blobs from a PreparedPhoto[] to get the row-meta shape stored in
 * the daily-row's photos jsonb column. The blob stays in IDB / memory
 * separately; the row only references the path.
 */
export function preparedToRowMeta(prepared) {
  return prepared.map((p) => ({
    path: p.path,
    name: p.name ?? null,
    mime: p.mime ?? 'image/jpeg',
    size_bytes: p.size_bytes ?? null,
    captured_at: p.captured_at ?? new Date().toISOString(),
  }));
}

/**
 * Upload a single prepared photo without re-compressing. Throws a
 * StorageUploadError on failure that preserves status/code/path/photo_key
 * for the queue classifier.
 *
 * @param {object} sb — supabase client
 * @param {object} prepared — PreparedPhoto entry
 * @param {object} [opts]
 * @param {boolean} [opts.upsert=false] — true for queue replay path
 * @returns {Promise<object>} row-meta entry (path/name/mime/size_bytes/captured_at)
 */
export async function uploadPreparedPhoto(sb, prepared, opts = {}) {
  if (!prepared || !prepared.path || !prepared.blob) {
    throw new Error('uploadPreparedPhoto: prepared.path + prepared.blob required');
  }
  const upsert = !!opts.upsert;
  const {error} = await sb.storage
    .from(DAILY_BUCKET)
    .upload(prepared.path, prepared.blob, {upsert, contentType: prepared.mime ?? 'image/jpeg'});
  if (error) {
    throw new StorageUploadError({
      message: error.message ?? 'storage upload failed',
      status: error.statusCode != null ? Number(error.statusCode) : error.status,
      code: error.error ?? error.code,
      path: prepared.path,
      photo_key: prepared.photo_key,
      cause: error,
    });
  }
  return {
    path: prepared.path,
    name: prepared.name ?? null,
    mime: prepared.mime ?? 'image/jpeg',
    size_bytes: prepared.size_bytes ?? null,
    captured_at: prepared.captured_at ?? new Date().toISOString(),
  };
}

/**
 * Sequential upload over PreparedPhoto[]. Aborts on first failure (per
 * locked policy: no partial-photo row insert). Returns the row-meta
 * entries on full success.
 *
 * Sequential, not parallel: predictable cellular bandwidth, clean per-photo
 * progress signal via optional onPhotoUploaded callback, and replay
 * determinism (same order on every drain).
 */
export async function uploadPreparedPhotosSequential(sb, prepared, opts = {}, onPhotoUploaded) {
  const results = [];
  for (let i = 0; i < prepared.length; i++) {
    const meta = await uploadPreparedPhoto(sb, prepared[i], opts);
    results.push(meta);
    if (typeof onPhotoUploaded === 'function') onPhotoUploaded(i, meta);
  }
  return results;
}
