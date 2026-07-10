import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the Conversation Fidelity lane (mig 173 + comment_media
// actions + shared comments bucket contract):
//   • mig 173 — provenance columns; record_processing_comment_media is
//     service_role-only, reuse-not-touch on comments, enrichment-only on
//     pre-existing attachment rows, bucket pinned server-side;
//   • edge — comment_media_dry_run is read-only, sync_comment_media is the
//     ONLY comment-media byte-copier, both share ONE storage-path convention
//     with attachment_backfill, write action preflighted + cutover-gated;
//   • shared comments — bucket allowlist is a CLOSED set with comment-photos
//     default; the thumb passes the metadata bucket through.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/173_processing_comment_media.sql');
const edge = read('supabase/functions/processing-asana-sync/index.ts');
const shape = read('supabase/functions/_shared/processingAsanaShape.js');
const attachLib = read('src/lib/commentAttachments.js');
const commentsUi = read('src/shared/CommentsSection.jsx');

function edgeSlice(startMarker, endMarker) {
  const start = edge.indexOf(startMarker);
  expect(start, `edge contains ${startMarker}`).toBeGreaterThan(-1);
  const end = edge.indexOf(endMarker, start + 1);
  return end === -1 ? edge.slice(start) : edge.slice(start, end);
}

describe('mig 173 — atomic imported comment-media contract', () => {
  it('adds nullable provenance columns and keeps the asana_attachment_gid idempotency key', () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS asana_story_gid\s+text/);
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS original_author_name text/);
    expect(mig).toMatch(
      /ADD COLUMN IF NOT EXISTS comment_id\s+text REFERENCES public\.comments\(id\) ON DELETE SET NULL/,
    );
    // No change to the unique idempotency contract (owned by 156/157).
    expect(mig).not.toMatch(/DROP (INDEX|CONSTRAINT)/i);
  });

  it('record_processing_comment_media is service_role-only and parent-resolved via the link', () => {
    expect(mig).toContain(
      'REVOKE ALL ON FUNCTION public.record_processing_comment_media(jsonb) FROM PUBLIC, anon, authenticated',
    );
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.record_processing_comment_media(jsonb) TO service_role');
    expect(mig).toMatch(/FROM public\.processing_asana_links[\s\S]*?processing_record_id IS NOT NULL/);
  });

  it('reuse never touches body/author/timestamp; enrichment fills ONLY an empty attachments list', () => {
    // The only UPDATE on comments sets attachments (nothing else).
    const updates = [...mig.matchAll(/UPDATE public\.comments SET ([^;]+);/g)].map((m) => m[1]);
    expect(updates.length).toBe(1);
    expect(updates[0].trim()).toMatch(/^attachments = v_metas_json WHERE id = v_comment_id$/);
    expect(mig).toMatch(/jsonb_array_length\(COALESCE\(v_existing\.attachments, '\[\]'::jsonb\)\) = 0/);
    expect(mig).toContain("v_comment_action := 'reused'");
  });

  it('attachment rows are skip-or-enrich by gid (COALESCE-only; never duplicated)', () => {
    expect(mig).toMatch(/WHERE asana_attachment_gid = v_att_gid/);
    expect(mig).toContain('v_att_row.record_id <> v_rec_id');
    expect(mig).toContain('v_att_row.comment_id <> v_comment_id');
    expect(mig).toContain('v_att_row.asana_story_gid <> v_story_gid');
    expect(mig).toMatch(/asana_story_gid\s+= COALESCE\(asana_story_gid, v_story_gid\)/);
    expect(mig).toMatch(/comment_id\s+= COALESCE\(comment_id, v_comment_id\)/);
    expect(mig).toContain('OR v_att_row.original_author_name IS NULL');
  });

  it('refuses cross-record comment-gid reuse instead of enriching the wrong record', () => {
    expect(mig).toContain("v_existing.entity_type IS DISTINCT FROM 'processing.record'");
    expect(mig).toContain('v_existing.entity_id IS DISTINCT FROM v_rec_id');
    expect(mig).toContain("v_existing.source IS DISTINCT FROM 'asana'");
    expect(mig).toContain('v_existing.is_imported IS DISTINCT FROM true');
  });

  it('the comments metadata bucket is PINNED server-side to processing-attachments', () => {
    expect(mig).toContain("'bucket', 'processing-attachments'");
    // is_image derives from mime/extension (thumbnail contract).
    expect(mig).toMatch(/ILIKE 'image\/%'/);
  });

  it('mentions stay display-only (validated against real profiles; no notification writes)', () => {
    expect(mig).toMatch(/EXISTS \(SELECT 1 FROM public\.profiles WHERE id = \(v_m #>> '\{\}'\)::uuid\)/);
    expect(mig).not.toContain('notifications');
  });
});

describe('edge — comment-media action isolation', () => {
  it('registers comment_media_dry_run (read-only) + sync_comment_media (preflighted write)', () => {
    expect(edge).toContain("'comment_media_dry_run'");
    expect(edge).toContain("'sync_comment_media'");
    expect(edge).toMatch(/WRITE_ACTIONS = new Set\(\[[\s\S]*?'sync_comment_media'/);
    // dry run dispatches with dryRun=true and never opens a sync-run row.
    const dryBranch = edgeSlice("if (action === 'comment_media_dry_run')", "if (action === 'attachment_dry_run')");
    expect(dryBranch).toMatch(/runCommentMedia\(svc, true/);
    expect(dryBranch).not.toContain('startRun');
    // write dispatches with dryRun=false inside a sync-run bracket.
    const writeBranch = edgeSlice("if (action === 'sync_comment_media')", "if (action === 'sync_artifacts')");
    expect(writeBranch).toMatch(/runCommentMedia\(svc, false, ctx\)/);
    expect(writeBranch).toContain('startRun');
  });

  it('the dry-run report carries the required fields including the exact B-26-04 plan', () => {
    expect(edge).toContain("const B2604_TASK_GID = '1211760432273073'");
    for (const key of [
      'textComments',
      'mediaComments',
      'fileOnlyPosts',
      'taskAttachments',
      'alreadyImported',
      'missingComments',
      'newMediaBytes',
      'ambiguous',
      'deadParents',
      'errors',
    ]) {
      expect(edge, `report field ${key}`).toContain(key);
    }
    expect(edge).toContain('b2604');
    expect(edge).toContain('ambiguousDetails');
  });

  it('ONE storage-path convention: both byte-copiers route through asanaAttachmentPath', () => {
    expect(edge).toContain('function asanaAttachmentPath(');
    expect((edge.match(/asanaAttachmentPath\(/g) || []).length).toBeGreaterThanOrEqual(3);
    // The literal template appears exactly ONCE — inside the helper itself.
    expect((edge.match(/\$\{parentGid\}\/\$\{gid\}-/g) || []).length).toBe(1);
    // sync_comment_media reuses stored paths for known gids (no double copy).
    expect(edge).toMatch(
      /const known = storedAttachments\.get\(attGid\);[\s\S]*?meta\.storage_path = known\.storage_path/,
    );
  });

  it('only runCommentMedia calls record_processing_comment_media; text comments stay with sync_comments', () => {
    expect((edge.match(/rpc\('record_processing_comment_media'/g) || []).length).toBe(1);
    const walker = edgeSlice('async function runCommentMedia(', '// ─── sync (write)');
    expect(walker).toContain("item.kind !== 'media_comment' && item.kind !== 'file_only_post'");
  });

  it('never records metadata after a media download/upload failure', () => {
    const walker = edgeSlice('async function runCommentMedia(', '// ─── sync (write)');
    expect(walker).toContain('let mediaReady = true');
    expect(walker).toMatch(/if \(!mediaReady\) continue;[\s\S]*?rpc\('record_processing_comment_media'/);
  });

  it('pure conversation mapper is exported with explicit ambiguity handling', () => {
    for (const name of ['parseHtmlTextAttachmentGids', 'buildConversationPlan', 'conversationItemToCommentMediaRow']) {
      expect(shape, `shape exports ${name}`).toMatch(new RegExp(`export function ${name}\\b`));
    }
    expect(shape).toContain('association not inferable');
  });
});

describe('shared comments — closed bucket allowlist', () => {
  it('allows exactly comment-photos (default) + processing-attachments; coerces anything else', () => {
    expect(attachLib).toMatch(
      /ALLOWED_COMMENT_ATTACHMENT_BUCKETS = Object\.freeze\(\[COMMENT_ATTACHMENT_BUCKET, 'processing-attachments'\]\)/,
    );
    expect(attachLib).toMatch(
      /ALLOWED_COMMENT_ATTACHMENT_BUCKETS\.includes\(bucket\) \? bucket : COMMENT_ATTACHMENT_BUCKET/,
    );
    // Default parameter keeps every existing caller on comment-photos.
    expect(attachLib).toMatch(/bucket = COMMENT_ATTACHMENT_BUCKET\)/);
  });
  it('the comment thumb passes the metadata bucket through the allowlisted reader', () => {
    expect(commentsUi).toContain('getAttachmentSignedUrl(sb, att.path, 600, att.bucket)');
  });
});
