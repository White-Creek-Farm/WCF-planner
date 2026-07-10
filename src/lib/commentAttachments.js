import {compressImage} from './photoCompress.js';

export const COMMENT_ATTACHMENT_BUCKET = 'comment-photos';
// Buckets a comment-attachment metadata row may reference. Metadata without a
// bucket keeps defaulting to comment-photos; anything outside this closed set
// is coerced back to the default so client-owned metadata can never point the
// signed-URL reader at an arbitrary bucket. 'processing-attachments' carries
// the imported Asana conversation media (private; operational SELECT policy).
export const ALLOWED_COMMENT_ATTACHMENT_BUCKETS = Object.freeze([COMMENT_ATTACHMENT_BUCKET, 'processing-attachments']);
export const MAX_COMMENT_ATTACHMENTS = 5;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];

function isImage(file) {
  return IMAGE_TYPES.includes(file.type);
}

export function buildAttachmentPath(entityType, entityId, key, ext) {
  return `${entityType}/${entityId}/${key}.${ext}`;
}

export async function uploadCommentAttachment(sb, entityType, entityId, key, file) {
  if (!file) throw new Error('uploadCommentAttachment: file required');

  let blob = file;
  let contentType = file.type || 'application/octet-stream';
  let ext = (file.name || '').split('.').pop() || 'bin';

  if (isImage(file)) {
    blob = await compressImage(file);
    contentType = 'image/jpeg';
    ext = 'jpg';
  } else if (file.size > MAX_DOCUMENT_BYTES) {
    throw new Error(`File too large: ${Math.round(file.size / 1024 / 1024)}MB (max 10MB)`);
  }

  const path = buildAttachmentPath(entityType, entityId, key, ext);
  const {error} = await sb.storage.from(COMMENT_ATTACHMENT_BUCKET).upload(path, blob, {upsert: false, contentType});
  if (error && !/duplicate|23505|409/i.test(error.message || '')) {
    throw new Error(`uploadCommentAttachment: ${error.message ?? 'upload failed'}`);
  }

  return {
    path,
    name: file.name || `${key}.${ext}`,
    mime: contentType,
    size_bytes: blob.size,
    is_image: isImage(file),
    captured_at: new Date().toISOString(),
  };
}

export async function getAttachmentSignedUrl(sb, storagePath, expiresIn = 600, bucket = COMMENT_ATTACHMENT_BUCKET) {
  const safeBucket = ALLOWED_COMMENT_ATTACHMENT_BUCKETS.includes(bucket) ? bucket : COMMENT_ATTACHMENT_BUCKET;
  const {data, error} = await sb.storage.from(safeBucket).createSignedUrl(storagePath, expiresIn);
  if (error) return null;
  return data?.signedUrl || null;
}

export async function removeAttachment(sb, storagePath) {
  const {error} = await sb.storage.from(COMMENT_ATTACHMENT_BUCKET).remove([storagePath]);
  if (error) throw new Error(`removeAttachment: ${error.message ?? 'remove failed'}`);
}
