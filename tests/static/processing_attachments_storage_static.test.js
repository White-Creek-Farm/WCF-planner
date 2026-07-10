import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for sub-lane 6: Asana artifacts (subtasks + attachments) +
// Storage. Subtask + attachment IMPORT is already wired in the Edge function;
// the only gap is the private Storage bucket (mig 163, HELD) + a read-only
// attachment preview. Subtasks stay out of the main calendar table.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig163 = read('supabase-migrations/163_processing_attachments_storage.sql');
const edge = read('supabase/functions/processing-asana-sync/index.ts');
const view = read('src/processing/ProcessingCalendarView.jsx');

describe('mig 163 — private processing-attachments bucket (Storage gate)', () => {
  it('creates a PRIVATE bucket idempotently with an OPERATIONAL-gated SELECT policy', () => {
    expect(mig163).toContain('INSERT INTO storage.buckets (id, name, public)');
    expect(mig163).toContain("('processing-attachments', 'processing-attachments', false)");
    expect(mig163).toContain('ON CONFLICT (id) DO NOTHING');
    expect(mig163).toContain('processing_attachments_operational_select');
    expect(mig163).toMatch(/FOR SELECT\s+TO authenticated/);
    // SELECT is narrowed to the Processing operational boundary — NOT all-auth.
    expect(mig163).toContain("public.profile_role() IN ('farm_team', 'management', 'admin')");
    // guard against a bare all-authenticated read (bucket check with no role gate)
    expect(mig163).not.toMatch(/USING \(bucket_id = 'processing-attachments'\)/);
    // writes are service-role only (importer); no authenticated INSERT policy yet
    expect(mig163).not.toMatch(/FOR INSERT\s+TO authenticated/);
    // clearly marked as a held gate
    expect(mig163).toMatch(/STORAGE GATE|HELD/);
  });
});

describe('edge — attachment dry-run (preview before the gated write path)', () => {
  it('registers a read-only attachment_dry_run that reports bucket readiness + new vs stored', () => {
    expect(edge).toContain("'attachment_dry_run'");
    expect(edge).toContain('async function runAttachmentDryRun');
    expect(edge).toContain('bucketReady');
    expect(edge).toContain('newAttachments');
    expect(edge).toContain('getBucket(ATTACHMENT_BUCKET)');
    // the dry-run helper must NOT write: no upload / record RPC in its body
    // (slice ends at the next declaration — the separate backfill runner).
    const start = edge.indexOf('async function runAttachmentDryRun');
    const end = edge.indexOf('interface AttachmentBackfillCounts', start);
    expect(end).toBeGreaterThan(start);
    const body = edge.slice(start, end);
    expect(body).not.toContain('.upload(');
    expect(body).not.toContain('record_processing_attachment');
  });

  it('keeps the attachment byte-copy write path gated on the bucket', () => {
    // the WRITE path uploads into the private bucket (only works once mig 163 applied)
    expect(edge).toContain('svc.storage.from(ATTACHMENT_BUCKET).upload(');
    expect(edge).toContain("const ATTACHMENT_BUCKET = 'processing-attachments'");
    // and it is reachable ONLY through the dedicated runAttachmentBackfill
    // runner (processing-complete lane: sync_once/sync_since never copy bytes).
    expect(edge).toContain('async function runAttachmentBackfill');
    expect(edge).not.toContain('doAttachments');
  });
});

describe('subtasks stay out of the main calendar table as a COLUMN', () => {
  it('ProcessingCalendarView has no Subtasks column; the Batch-cell checklist meta is the only subtask reference', () => {
    // The handoff-restored Batch cell shows "N-step checklist · done/total"
    // (WS5); a dedicated Subtasks COLUMN must not return.
    expect(view).not.toContain('>Subtasks</span>');
    expect(view).toContain('checklistMeta');
    // Outside the checklist meta derivation, no other subtask surface exists
    // in the table (no toggle buttons, no drawer-style subtask rows).
    expect(view).not.toMatch(/toggleSubtask|data-processing-subtask=/);
  });
});
