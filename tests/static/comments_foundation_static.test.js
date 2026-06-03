import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig071 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/071_comments_foundation.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/commentsApi.js'), 'utf8');
const sectionSrc = fs.readFileSync(path.join(ROOT, 'src/shared/CommentsSection.jsx'), 'utf8');
const attachSrc = fs.readFileSync(path.join(ROOT, 'src/lib/commentAttachments.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function listRuntimeSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRuntimeSourceFiles(full));
      continue;
    }
    if (!entry.isFile() || !/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe('migration 071 — tables', () => {
  it('creates comments table', () => {
    expect(mig071).toContain('CREATE TABLE IF NOT EXISTS public.comments');
    expect(mig071).toContain('entity_type');
    expect(mig071).toContain('entity_id');
    expect(mig071).toContain('author_profile_id');
    expect(mig071).toContain('mentions');
    expect(mig071).toContain('attachments');
    expect(mig071).toContain('deleted_at');
  });
  it('creates comment_edits table', () => {
    expect(mig071).toContain('CREATE TABLE IF NOT EXISTS public.comment_edits');
    expect(mig071).toContain('previous_body');
    expect(mig071).toContain('previous_attachments');
  });
  it('locks down tables with RLS deny-all', () => {
    expect(mig071).toContain('comments_deny_all');
    expect(mig071).toContain('comment_edits_deny_all');
  });
});

describe('migration 071 — notification routing', () => {
  it('adds comment_entity_type/id/label and comment_id to notifications', () => {
    expect(mig071).toContain('comment_entity_type');
    expect(mig071).toContain('comment_entity_id');
    expect(mig071).toContain('comment_entity_label');
    expect(mig071).toContain('comment_id');
  });
  it('widens type CHECK for comment_mention', () => {
    expect(mig071).toContain("'comment_mention'");
  });
  it('updates list_recent_notifications for comment_mention routing', () => {
    expect(mig071).toContain("n.type = 'comment_mention'");
    expect(mig071).toContain('_activity_can_read(n.comment_entity_type');
  });
});

describe('migration 071 — SECDEF RPCs', () => {
  it('has list_comments', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.list_comments');
    expect(mig071).toContain('SECURITY DEFINER');
  });
  it('has count_comments', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.count_comments');
  });
  it('has post_comment', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.post_comment');
  });
  it('has edit_comment', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.edit_comment');
  });
  it('has delete_comment', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.delete_comment');
  });
  it('has list_comment_edits', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.list_comment_edits');
  });
});

describe('migration 071 — mention validation', () => {
  it('rejects self-mentions', () => {
    expect(mig071).toContain('cannot mention yourself');
  });
  it('does NOT call _extract_mention_uuids in RPC function bodies', () => {
    const fnBodies = mig071.match(/\$fn\$[\s\S]*?\$fn\$/g) || [];
    for (const body of fnBodies) {
      expect(body).not.toContain('_extract_mention_uuids');
    }
  });
  it('validates mentioned profile exists and is active', () => {
    expect(mig071).toContain('mentioned profile % not found');
    expect(mig071).toContain('mentioned profile % is inactive');
  });
  it('caps mentions at 10', () => {
    expect(mig071).toContain('too many mentions');
  });
});

describe('migration 071 — attachment validation', () => {
  it('validates attachments is a JSON array', () => {
    expect(mig071).toContain('attachments must be a JSON array');
  });
  it('caps attachments at 5', () => {
    expect(mig071).toContain('too many attachments');
  });
  it('validates per-item path field', () => {
    expect(mig071).toContain('missing path');
  });
  it('validates per-item name field', () => {
    expect(mig071).toContain('missing name');
  });
  it('validates per-item mime field', () => {
    expect(mig071).toContain('missing mime');
  });
  it('validates path is scoped to entity', () => {
    expect(mig071).toContain('path not scoped to entity');
  });
});

describe('migration 071 — deleted comment redaction', () => {
  it('list_comments returns NULL body for non-admin deleted rows', () => {
    expect(mig071).toMatch(/deleted_at IS NOT NULL AND v_role <> 'admin'[\s\S]*?THEN NULL ELSE c\.body/);
  });
  it('list_comments returns empty attachments for non-admin deleted rows', () => {
    expect(mig071).toMatch(
      /deleted_at IS NOT NULL AND v_role <> 'admin'[\s\S]*?THEN '\[\]'::jsonb ELSE c\.attachments/,
    );
  });
  it('list_comment_edits returns empty for non-admin deleted comments', () => {
    expect(mig071).toContain("v_comment.deleted_at IS NOT NULL AND v_role <> 'admin'");
  });
});

describe('migration 071 — comment order', () => {
  it('returns comments newest-first', () => {
    expect(mig071).toContain('ORDER BY r.created_at DESC');
    expect(mig071).toContain('ORDER BY c.created_at DESC');
  });
});

describe('migration 071 — mentioned_profile_names', () => {
  it('returns mentioned_profile_names with ORDER BY ordinality', () => {
    expect(mig071).toContain('mentioned_profile_names');
    expect(mig071).toContain('ORDER BY m.ord');
  });
});

describe('migration 071 — permissions hardening', () => {
  it('edit_comment checks caller role is active', () => {
    expect(mig071).toMatch(/edit_comment: caller role.*cannot edit/);
  });
  it('edit_comment checks _activity_can_write', () => {
    expect(mig071).toContain('edit_comment: not permitted for entity');
  });
  it('delete_comment checks caller role is active', () => {
    expect(mig071).toMatch(/delete_comment: caller role.*cannot delete/);
  });
  it('delete_comment checks _activity_can_write', () => {
    expect(mig071).toContain('delete_comment: not permitted for entity');
  });
  it('edit_comment SELECTs mentions into v_row', () => {
    expect(mig071).toMatch(
      /SELECT id, entity_type, entity_id, author_profile_id, body, mentions, attachments, deleted_at/,
    );
  });
});

describe('migration 071 — NOTIFY', () => {
  it('ends with NOTIFY pgrst reload', () => {
    expect(mig071).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('commentsApi — RPC wrappers', () => {
  it('exports listComments', () => {
    expect(apiSrc).toContain('export async function listComments');
  });
  it('exports countComments', () => {
    expect(apiSrc).toContain('export async function countComments');
  });
  it('exports postComment', () => {
    expect(apiSrc).toContain('export async function postComment');
  });
  it('exports editComment', () => {
    expect(apiSrc).toContain('export async function editComment');
  });
  it('exports deleteComment', () => {
    expect(apiSrc).toContain('export async function deleteComment');
  });
  it('exports listCommentEdits', () => {
    expect(apiSrc).toContain('export async function listCommentEdits');
  });
  it('exports loadMentionableProfiles', () => {
    expect(apiSrc).toContain('export async function loadMentionableProfiles');
  });
  it('does not JSON.stringify attachments', () => {
    expect(apiSrc).not.toContain('JSON.stringify');
  });
  it('does not directly query comments table', () => {
    expect(apiSrc).not.toContain("from('comments')");
  });
});

describe('CommentsSection — structure', () => {
  it('imports CommentsSection API, not Activity API for posting', () => {
    expect(sectionSrc).toContain("from '../lib/commentsApi.js'");
    expect(sectionSrc).not.toContain('postActivityComment');
  });
  it('has no Activity composer', () => {
    expect(sectionSrc).not.toContain('data-activity-compose');
    expect(sectionSrc).not.toContain('data-activity-post-button');
  });
  it('has comment compose area', () => {
    expect(sectionSrc).toContain('data-comments-compose');
    expect(sectionSrc).toContain('data-comments-post-button');
  });
  it('renders comment list', () => {
    expect(sectionSrc).toContain('data-comments-list');
  });
  it('renders scroll anchors for comments', () => {
    expect(sectionSrc).toContain("id={'comment-' + c.id}");
  });
  it('supports edit with attachment preservation', () => {
    expect(sectionSrc).toContain('editDraft.attachments');
  });
  it('supports edit with attachment add', () => {
    expect(sectionSrc).toContain('editFiles');
  });
  it('shows edit history with previous attachments', () => {
    expect(sectionSrc).toContain('previous_attachments');
  });
  it('uses loadMentionableProfiles for mentions, not task assignees', () => {
    expect(sectionSrc).toContain('loadMentionableProfiles');
    expect(sectionSrc).toContain('loadProfiles={mentionLoader}');
  });
  it('filters current user from mention picker', () => {
    expect(sectionSrc).toContain('p.id !== callerProfileId');
  });
});

describe('commentAttachments — helpers', () => {
  it('exports upload helper', () => {
    expect(attachSrc).toContain('export async function uploadCommentAttachment');
  });
  it('exports signed URL helper', () => {
    expect(attachSrc).toContain('export async function getAttachmentSignedUrl');
  });
  it('handles both images and documents', () => {
    expect(attachSrc).toContain('is_image');
    expect(attachSrc).toContain('compressImage');
    expect(attachSrc).toContain('MAX_DOCUMENT_BYTES');
  });
  it('uses the comment-photos bucket', () => {
    expect(attachSrc).toContain("'comment-photos'");
  });
});

describe('No direct table access in src/', () => {
  const allSrc = [apiSrc, sectionSrc, attachSrc];
  it('no file directly queries comments or comment_edits', () => {
    for (const src of allSrc) {
      expect(src).not.toContain("from('comments')");
      expect(src).not.toContain("from('comment_edits')");
    }
  });
  it('commentsApi does not directly SELECT from profiles', () => {
    expect(apiSrc).not.toContain("from('profiles')");
  });
  it('commentsApi uses RPC for mentionable profiles', () => {
    expect(apiSrc).toContain("sb.rpc('list_comment_mentionable_profiles')");
  });

  it('runtime source does not directly query Comments or Activity foundation tables', () => {
    const forbidden = ['comments', 'comment_edits', 'activity_events', 'activity_mentions'];
    const offenders = [];
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const table of forbidden) {
        if (new RegExp(`from\\(['"]${table}['"]\\)`).test(code)) offenders.push(`${rel}: ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('migration 071 — mentionable profiles RPC', () => {
  it('defines list_comment_mentionable_profiles', () => {
    expect(mig071).toContain('CREATE OR REPLACE FUNCTION public.list_comment_mentionable_profiles');
  });
  it('is SECURITY DEFINER', () => {
    expect(mig071).toMatch(/list_comment_mentionable_profiles[\s\S]*?SECURITY DEFINER/);
  });
  it('SELECT columns are only id and full_name', () => {
    const fnStart = mig071.indexOf('CREATE OR REPLACE FUNCTION public.list_comment_mentionable_profiles');
    expect(fnStart).toBeGreaterThan(-1);
    const fnChunk = mig071.slice(fnStart, fnStart + 800);
    expect(fnChunk).toMatch(/SELECT p\.id,\s*p\.full_name\s/);
  });
  it('rejects null/inactive caller role', () => {
    const fnStart = mig071.indexOf('CREATE OR REPLACE FUNCTION public.list_comment_mentionable_profiles');
    const fnChunk = mig071.slice(fnStart, fnStart + 800);
    expect(fnChunk).toContain('profile_role()');
    expect(fnChunk).toMatch(/caller role.*cannot read/);
  });
  it('REVOKE from anon + GRANT to authenticated', () => {
    expect(mig071).toMatch(/REVOKE ALL ON FUNCTION public\.list_comment_mentionable_profiles.*FROM PUBLIC, anon/);
    expect(mig071).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_comment_mentionable_profiles.*TO authenticated/);
  });
});

describe('migration 071 — attachment path validation', () => {
  it('uses starts_with not LIKE for path scoping', () => {
    const fnBodies = mig071.match(/\$fn\$[\s\S]*?\$fn\$/g) || [];
    for (const body of fnBodies) {
      if (body.includes('path not scoped to entity')) {
        expect(body).toContain('starts_with');
        expect(body).not.toContain('LIKE');
      }
    }
  });
});
