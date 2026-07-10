// ============================================================================
// src/lib/processingAttachmentsApi.js — Processing attachment client owner
// ----------------------------------------------------------------------------
// The ONLY client owner for the private 'processing-attachments' Storage bucket
// (mig 163 SELECT policy + mig 166 native INSERT policy). Two responsibilities:
//
//   • Signed READ (open/download): getProcessingAttachmentUrl mints a
//     short-lived signed URL for any attachment row's storage_path — imported
//     Asana bytes ('<gid>/…') and native uploads ('native/<record id>/…') both
//     read through the operational SELECT policy.
//   • Native UPLOAD ("Add files"): uploadProcessingAttachment puts the bytes
//     under 'native/<record id>/<uuid>-<safe filename>' (append-only,
//     upsert:false) and registers the metadata row via the
//     add_processing_attachment RPC (caller provenance, no Asana gid, Activity
//     emitted server-side). Images are NOT recompressed — processing documents
//     (invoices, kill sheets, spreadsheets) must arrive byte-exact.
//
// No destructive removal here on purpose: the bucket is append-only for
// authenticated users (no UPDATE/DELETE policy) until a delete contract is
// explicitly designed and approved.
// ============================================================================
import {newProcessingId} from './processingApi.js';

export const PROCESSING_ATTACHMENT_BUCKET = 'processing-attachments';
export const MAX_PROCESSING_ATTACHMENT_BYTES = 50 * 1024 * 1024; // matches the RPC cap

// Signed URL for one attachment row's storage_path (default 10 minutes).
// Returns null on failure — the drawer shows a retry-able error instead of a
// dead link.
export async function getProcessingAttachmentUrl(sb, storagePath, expiresIn = 600) {
  if (!storagePath) return null;
  const {data, error} = await sb.storage.from(PROCESSING_ATTACHMENT_BUCKET).createSignedUrl(storagePath, expiresIn);
  if (error) return null;
  return data?.signedUrl || null;
}

// Keep the original filename readable in the object key but strip path
// separators / control characters that would break the key or the policy match.
export function safeAttachmentFilename(name) {
  const base = String(name || 'file')
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'file').slice(0, 120);
}

// Upload one native file for a record, then register its metadata row.
// Returns the RPC result ({id, replayed}). Throws with a user-presentable
// message on validation/upload failure.
export async function uploadProcessingAttachment(sb, {recordId, file} = {}) {
  if (!recordId) throw new Error('uploadProcessingAttachment: recordId required');
  if (!file) throw new Error('uploadProcessingAttachment: file required');
  if (file.size > MAX_PROCESSING_ATTACHMENT_BYTES) {
    throw new Error(`File too large: ${Math.round(file.size / 1024 / 1024)}MB (max 50MB)`);
  }
  const id = newProcessingId('pat');
  const filename = safeAttachmentFilename(file.name);
  const contentType = file.type || 'application/octet-stream';
  const storagePath = `native/${recordId}/${id}-${filename}`;

  const {error: upErr} = await sb.storage
    .from(PROCESSING_ATTACHMENT_BUCKET)
    .upload(storagePath, file, {upsert: false, contentType});
  // The path embeds a fresh uuid, so a duplicate-object error can only be this
  // same upload retrying — treat it as success and proceed to registration.
  if (upErr && !/duplicate|23505|409/i.test(upErr.message || '')) {
    throw new Error(`uploadProcessingAttachment: ${upErr.message ?? 'upload failed'}`);
  }

  const {data, error} = await sb.rpc('add_processing_attachment', {
    p_row: {
      id,
      record_id: recordId,
      filename,
      content_type: contentType,
      size_bytes: file.size,
      storage_path: storagePath,
    },
  });
  if (error) throw new Error(`uploadProcessingAttachment: ${error.message || String(error)}`);
  return data;
}
