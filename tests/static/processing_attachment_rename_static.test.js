import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Processing attachment RENAME + THUMBNAIL lane (mig 191).
// Rename is a narrow, operational-gated, metadata-only SECURITY DEFINER RPC; the
// drawer wires image thumbnails (private signed URLs, lazy, icon fallback) and
// an inline rename editor for operational roles only.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/191_processing_attachment_rename.sql');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const api = read('src/lib/processingAttachmentsApi.js');

describe('mig 191 — rename_processing_attachment RPC boundary', () => {
  it('is a SECURITY DEFINER function with a pinned search_path', () => {
    expect(mig).toMatch(
      /CREATE OR REPLACE FUNCTION public\.rename_processing_attachment\(p_id text, p_filename text\)/,
    );
    expect(mig).toMatch(/SECURITY DEFINER SET search_path = public/);
  });

  it('grants EXECUTE only to authenticated and revokes PUBLIC/anon (no direct table UPDATE)', () => {
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.rename_processing_attachment\(text, text\) FROM PUBLIC, anon/);
    expect(mig).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.rename_processing_attachment\(text, text\) TO authenticated/,
    );
    // No table-level grant is loosened — the rename is only reachable via the RPC.
    expect(mig).not.toMatch(/GRANT\s+UPDATE\s+ON\s+(TABLE\s+)?public\.processing_attachments/i);
    expect(mig).not.toMatch(/ALTER POLICY|CREATE POLICY|DROP POLICY/); // touches no RLS/Storage policy
  });

  it('enforces the operational role gate server-side and locks the row', () => {
    expect(mig).toContain('public._processing_require_operational()');
    expect(mig).toMatch(/FROM public\.processing_attachments WHERE id = p_id FOR UPDATE/);
  });

  it('validates trimmed / length / path-separator / control-char rules', () => {
    expect(mig).toContain('btrim(COALESCE(p_filename');
    expect(mig).toMatch(/length\(v_new\) > 200/);
    expect(mig).toContain("v_new ~ '[/\\\\]'"); // rejects / and \
    expect(mig).toContain("v_new ~ '[[:cntrl:]]'"); // rejects control chars
    expect(mig).toMatch(/filename cannot be empty/);
  });

  it('fails closed for deleted / pending-delete rows', () => {
    expect(mig).toMatch(/v_row\.deleted_at IS NOT NULL[\s\S]*?attachment is deleted/);
    expect(mig).toMatch(/v_row\.delete_requested_at IS NOT NULL[\s\S]*?pending delete/);
  });

  it('unchanged name is an idempotent no-op (no Activity duplicate)', () => {
    // The unchanged branch returns BEFORE the UPDATE / activity emit.
    const unchangedIdx = mig.indexOf('IF v_new = v_old THEN');
    const updateIdx = mig.indexOf('UPDATE public.processing_attachments SET filename');
    const activityIdx = mig.indexOf('PERFORM public._processing_emit_activity');
    expect(unchangedIdx).toBeGreaterThan(-1);
    expect(unchangedIdx).toBeLessThan(updateIdx);
    expect(unchangedIdx).toBeLessThan(activityIdx);
    expect(mig).toMatch(/'status', 'unchanged'/);
  });

  it('is metadata-only: filename changes, storage_path never does', () => {
    expect(mig).toContain('UPDATE public.processing_attachments SET filename = v_new WHERE id = v_row.id');
    // storage_path is never assigned; no Storage object move/copy/delete here.
    expect(mig).not.toMatch(/SET[\s\S]{0,80}storage_path\s*=/);
    expect(mig).not.toContain('storage.objects');
    expect(mig).not.toMatch(/storage\.buckets|createSignedUrl|\.remove\(/);
  });

  it('keeps linked comment attachment metadata coherent (exact bucket+path → name)', () => {
    expect(mig).toContain('UPDATE public.comments c');
    expect(mig).toContain("COALESCE(e->>'bucket', '') = 'processing-attachments'");
    expect(mig).toContain("COALESCE(e->>'path', '')   = v_row.storage_path");
    expect(mig).toContain("jsonb_build_object('name', v_new)");
    expect(mig).toContain("c.entity_type = 'processing.record'");
  });

  it('emits truthful Activity carrying attachment id + old/new filename', () => {
    expect(mig).toContain('_processing_emit_activity');
    expect(mig).toContain("'action', 'rename_attachment'");
    expect(mig).toContain("'old_filename', v_old");
    expect(mig).toContain("'new_filename', v_new");
    expect(mig).toContain("'attachment_id', v_row.id");
  });

  it('reloads PostgREST for the new RPC shape', () => {
    expect(mig).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('does NOT redefine the Asana importers (rename survives reconciliation)', () => {
    // Import RPCs never overwrite an existing row.filename; this migration must
    // not REDEFINE them, so that survival guarantee is preserved. (They may be
    // named in the header comment — only a CREATE OR REPLACE would be a risk.)
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION\s+public\.record_processing_attachment/);
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION\s+public\.record_processing_comment_media/);
  });
});

describe('ProcessingDrawer — thumbnail + rename wiring', () => {
  it('imports the thumbnail + rename API surface', () => {
    expect(drawer).toContain('getProcessingAttachmentThumbUrl');
    expect(drawer).toContain('renameProcessingAttachment');
    expect(drawer).toContain('isThumbnailableImage');
    expect(drawer).toContain('MAX_ATTACHMENT_FILENAME_LENGTH');
  });

  it('renders a lazy signed image thumbnail with an icon fallback', () => {
    expect(drawer).toContain('function ProcessingAttachmentThumb');
    expect(drawer).toContain('loading="lazy"');
    expect(drawer).toContain('decoding="async"');
    expect(drawer).toContain("objectFit: 'cover'");
    // failure/non-image path falls back to the file glyph.
    expect(drawer).toContain('data-processing-attachment-thumb="icon"');
    expect(drawer).toContain('data-processing-attachment-thumb="image"');
    // preview bytes are only requested for images (thumb helper is inside the
    // component that only mounts an <img> when isThumbnailableImage is true).
    expect(drawer).toContain('const isImage = isThumbnailableImage(attachment)');
  });

  it('gates the Rename control to operational roles and Delete stays admin-only', () => {
    expect(drawer).toContain('data-processing-attachment-rename');
    expect(drawer).toContain('data-processing-attachment-rename-save');
    expect(drawer).toContain('data-processing-attachment-rename-cancel');
    expect(drawer).toContain('data-processing-attachment-rename-input');
    // Rename appears under canOperate; Delete under isAdmin.
    expect(drawer).toMatch(/canOperate &&[\s\S]{0,400}data-processing-attachment-rename=/);
    expect(drawer).toMatch(/isAdmin &&[\s\S]{0,400}data-processing-attachment-delete=/);
  });

  it('supports Enter-to-save / Escape-to-cancel and per-attachment busy', () => {
    expect(drawer).toContain('function onRenameAttachmentKeyDown');
    expect(drawer).toMatch(/e\.key === 'Enter'[\s\S]{0,120}saveRenameAttachment/);
    expect(drawer).toMatch(/e\.key === 'Escape'[\s\S]{0,120}cancelRenameAttachment/);
    expect(drawer).toContain('renamingAttachmentIds');
    // reload after a successful rename so the server filename is authoritative
    expect(drawer).toMatch(/await renameProcessingAttachment\([\s\S]{0,160}await load\(\)/);
  });
});

describe('processingAttachmentsApi — private-bucket + validation invariants', () => {
  it('thumbnail helper signs the private bucket (never a public URL)', () => {
    expect(api).toContain('function getProcessingAttachmentThumbUrl');
    expect(api).toContain('.createSignedUrl(storagePath, expiresIn, options)');
    expect(api).not.toContain('getPublicUrl');
  });

  it('rename helper validates locally before the RPC', () => {
    expect(api).toContain('function renameProcessingAttachment');
    expect(api).toContain('validateAttachmentDisplayName(filename)');
    expect(api).toContain("sb.rpc('rename_processing_attachment'");
  });
});
