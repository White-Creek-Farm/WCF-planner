// Monthly Newsletter client API (migs 144 + 145).
//
// The newsletter engine is a public, web-only "White Creek Farm <Month> Review"
// archive. Every read/write routes through the SECURITY DEFINER RPCs from
// supabase-migrations/144_newsletter_engine.sql — this module never touches the
// newsletter_* tables directly (deny-all RLS).
//
// Access split:
//   - PUBLIC (anon-reachable) reads: list_published_newsletters,
//     get_published_newsletter(slug), get_newsletter_preview(slug, token).
//     These are the ONLY three anon RPCs and they return sanitized payloads
//     (approved photo paths only; never source_private_path).
//   - ADMIN (authenticated, role=admin enforced server-side) RPCs: issue
//     create/list/get/save/intake, fact include/manual, photo register/update/
//     approve/cover/remove, publish/unpublish, preview-token rotate, settings.
//
// Photo privacy flow (mig 145): a photo's bytes always land in the PRIVATE
// newsletter-staging bucket first (a new upload, or a re-upload of an existing
// private planner photo). Only on admin approval are the bytes COPIED into the
// PUBLIC newsletter-public bucket at the same relative path, and only then is
// set_newsletter_photo_approved(true) called. Unapprove/remove deletes the
// public bytes. A photo row existing is not public consent — approval is.

import {compressImage} from './photoCompress.js';
import {isStorageDuplicateError} from './tasks.js';

// ── Buckets + storage paths ──────────────────────────────────────────────────

export const NEWSLETTER_STAGING_BUCKET = 'newsletter-staging';
export const NEWSLETTER_PUBLIC_BUCKET = 'newsletter-public';

// register_newsletter_photo enforces that every storage_path lives under
// `newsletter/<issueId>/` with no traversal. Staging and public buckets use the
// SAME relative path, so approval is a same-path byte copy.
export function buildNewsletterStoragePath(issueId, token, ext = 'jpg') {
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext.toLowerCase() : 'jpg';
  return `newsletter/${issueId}/${token}.${safeExt}`;
}

// A client-side unique token for the storage filename. register_newsletter_photo
// assigns its own row id (nlp-...) server-side; the storage path only needs to be
// unique per issue (UNIQUE(issue_id, storage_path)).
export function generateNewsletterPhotoToken() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const MAX_NEWSLETTER_PHOTOS_PER_ISSUE = 12;

// ── Public path helpers (used by the public app + admin preview links) ───────

export const NEWSLETTER_ARCHIVE_PATH = '/newsletter';
export const NEWSLETTER_LATEST_PATH = '/newsletter/latest';

export function buildNewsletterIssuePath(slug) {
  return `/newsletter/${encodeURIComponent(slug)}`;
}

export function buildNewsletterPreviewPath(slug, token) {
  return `/newsletter/${encodeURIComponent(slug)}?preview=${encodeURIComponent(token)}`;
}

// ── Ids / display ────────────────────────────────────────────────────────────

// YYYY-MM for a Date (defaults to "now" in the farm's local clock). Used to seed
// the admin "create this month's issue" affordance; the server re-validates.
export function currentYearMonth(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Human label for a YYYY-MM slug, e.g. "June 2026". Pure string math (no Date
// parsing) so it never drifts across time zones.
export function formatYearMonth(yearMonth) {
  if (typeof yearMonth !== 'string') return '';
  const m = yearMonth.match(/^(\d{4})-(\d{2})$/);
  if (!m) return yearMonth;
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return yearMonth;
  return `${MONTHS[monthIdx]} ${m[1]}`;
}

// ── Anon (public) reads — the only three anon-reachable RPCs ─────────────────

// The archive is gated by a rotating access key (mig 153). The RPC returns NULL
// when the key is missing/invalid/expired (LOCKED) and [] when the key is valid
// but nothing is published yet — so callers can tell "locked" from "empty".
export async function listPublishedNewsletters(sb, key) {
  const {data, error} = await sb.rpc('list_published_newsletters', {p_key: key ?? null});
  if (error) throw new Error(`listPublishedNewsletters: ${error.message || String(error)}`);
  if (data == null) return null; // locked
  return Array.isArray(data) ? data : [];
}

export async function getPublishedNewsletter(sb, slug, key) {
  const {data, error} = await sb.rpc('get_published_newsletter', {p_slug: slug, p_key: key ?? null});
  if (error) throw new Error(`getPublishedNewsletter: ${error.message || String(error)}`);
  return data || null;
}

export async function getNewsletterPreview(sb, slug, token) {
  const {data, error} = await sb.rpc('get_newsletter_preview', {p_slug: slug, p_token: token});
  if (error) throw new Error(`getNewsletterPreview: ${error.message || String(error)}`);
  return data || null;
}

// Public URL for an approved newsletter photo (newsletter-public bucket).
export function newsletterPublicPhotoUrl(sb, storagePath) {
  if (!storagePath) return '';
  const {data} = sb.storage.from(NEWSLETTER_PUBLIC_BUCKET).getPublicUrl(storagePath);
  return (data && data.publicUrl) || '';
}

// ── Admin RPC wrappers ───────────────────────────────────────────────────────

export async function listNewsletterIssuesAdmin(sb) {
  const {data, error} = await sb.rpc('list_newsletter_issues_admin');
  if (error) throw new Error(`listNewsletterIssuesAdmin: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

export async function getNewsletterIssueAdmin(sb, id) {
  const {data, error} = await sb.rpc('get_newsletter_issue_admin', {p_id: id});
  if (error) throw new Error(`getNewsletterIssueAdmin: ${error.message || String(error)}`);
  return data || null;
}

export async function createNewsletterIssue(sb, yearMonth, title = null) {
  const {data, error} = await sb.rpc('create_newsletter_issue', {
    p_year_month: yearMonth,
    p_title: title || null,
  });
  if (error) throw new Error(`createNewsletterIssue: ${error.message || String(error)}`);
  return data;
}

export async function saveNewsletterDraft(sb, id, draftPayload) {
  const {data, error} = await sb.rpc('save_newsletter_draft', {p_id: id, p_draft_payload: draftPayload});
  if (error) throw new Error(`saveNewsletterDraft: ${error.message || String(error)}`);
  return data;
}

export async function saveNewsletterIntake(sb, id, intakeAnswers) {
  const {data, error} = await sb.rpc('save_newsletter_intake', {p_id: id, p_intake_answers: intakeAnswers});
  if (error) throw new Error(`saveNewsletterIntake: ${error.message || String(error)}`);
  return data;
}

export async function setNewsletterFactIncluded(sb, factId, included) {
  const {data, error} = await sb.rpc('set_newsletter_fact_included', {p_fact_id: factId, p_included: !!included});
  if (error) throw new Error(`setNewsletterFactIncluded: ${error.message || String(error)}`);
  return data;
}

export async function addNewsletterManualFact(sb, {issueId, title, summary = null, program = 'manual'}) {
  const {data, error} = await sb.rpc('add_newsletter_manual_fact', {
    p_issue_id: issueId,
    p_title: title,
    p_summary: summary || null,
    p_program: program || 'manual',
  });
  if (error) throw new Error(`addNewsletterManualFact: ${error.message || String(error)}`);
  return data;
}

export async function registerNewsletterPhoto(
  sb,
  {issueId, storagePath, sourcePrivatePath = null, caption = null, altText = null, firstName = null},
) {
  const {data, error} = await sb.rpc('register_newsletter_photo', {
    p_issue_id: issueId,
    p_storage_path: storagePath,
    p_source_private_path: sourcePrivatePath || null,
    p_caption: caption || null,
    p_alt_text: altText || null,
    p_first_name: firstName || null,
  });
  if (error) throw new Error(`registerNewsletterPhoto: ${error.message || String(error)}`);
  return data;
}

export async function updateNewsletterPhoto(sb, {id, caption, altText, firstName, sortOrder}) {
  const {data, error} = await sb.rpc('update_newsletter_photo', {
    p_id: id,
    p_caption: caption ?? null,
    p_alt_text: altText ?? null,
    p_first_name: firstName ?? null,
    p_sort_order: sortOrder ?? null,
  });
  if (error) throw new Error(`updateNewsletterPhoto: ${error.message || String(error)}`);
  return data;
}

export async function setNewsletterCover(sb, issueId, photoId) {
  const {data, error} = await sb.rpc('set_newsletter_cover', {p_issue_id: issueId, p_photo_id: photoId});
  if (error) throw new Error(`setNewsletterCover: ${error.message || String(error)}`);
  return data;
}

export async function publishNewsletterIssue(sb, id) {
  const {data, error} = await sb.rpc('publish_newsletter_issue', {p_id: id});
  if (error) throw new Error(`publishNewsletterIssue: ${error.message || String(error)}`);
  return data;
}

export async function unpublishNewsletterIssue(sb, id) {
  const {data, error} = await sb.rpc('unpublish_newsletter_issue', {p_id: id});
  if (error) throw new Error(`unpublishNewsletterIssue: ${error.message || String(error)}`);
  return data;
}

export async function regenerateNewsletterPreviewToken(sb, id) {
  const {data, error} = await sb.rpc('regenerate_newsletter_preview_token', {p_id: id});
  if (error) throw new Error(`regenerateNewsletterPreviewToken: ${error.message || String(error)}`);
  return data;
}

// ── Automation (mig 146 + newsletter-harvest Edge Function) ──────────────────

// Trigger the server-side harvest / AI-draft for an issue. The Edge Function
// authenticates the admin (rpc is_admin on the caller JWT), runs the requested
// steps with the service role, and returns a summary. The AI provider key never
// leaves the function; this only passes the issue id + which steps to run.
//   steps: ['harvest'] | ['draft'] | ['harvest','draft']
//   overwrite: when running 'draft', replace existing draft blocks (default true)
export async function runNewsletterHarvest(
  sb,
  {issueId, steps = ['harvest', 'draft'], overwrite = true, revisionNotes = ''},
) {
  const {data, error} = await sb.functions.invoke('newsletter-harvest', {
    body: {mode: 'admin', issueId, steps, overwrite, revisionNotes},
  });
  if (error) {
    // Edge errors carry the HTTP body on error.context in supabase-js v2.
    let detail = error.message || String(error);
    try {
      const body = error.context && (await error.context.json());
      if (body && body.error) detail = body.error;
    } catch (_e) {
      /* keep the generic message */
    }
    throw new Error(`runNewsletterHarvest: ${detail}`);
  }
  if (data && data.ok === false) throw new Error(`runNewsletterHarvest: ${data.error || 'failed'}`);
  return data || {};
}

// One-action "Prepare issue": harvest planner facts THEN generate the draft in a
// single server pass — the autopilot primary action. overwrite replaces existing
// draft blocks (the admin Prepare button passes true; the monthly cron uses false
// so it never clobbers admin edits).
export async function prepareNewsletterIssue(sb, {issueId, overwrite = true}) {
  return runNewsletterHarvest(sb, {issueId, steps: ['harvest', 'draft'], overwrite});
}

// Gather facts ONLY (harvest, no AI draft) — the "direction first" entry point.
// Scan the planner for this month's facts so the admin can curate them and add
// direction (Q&A, tone) BEFORE the AI writes anything.
export async function gatherNewsletterFacts(sb, {issueId}) {
  return runNewsletterHarvest(sb, {issueId, steps: ['harvest']});
}

// Regenerate the draft only (no re-harvest), optionally with revision notes the
// AI applies in place to the current draft ("warmer tone", "shorten the cattle
// section"). Revision notes only affect the Anthropic provider; the offline
// template composer regenerates deterministically and ignores them.
export async function regenerateNewsletterDraft(sb, {issueId, revisionNotes = ''}) {
  return runNewsletterHarvest(sb, {issueId, steps: ['draft'], overwrite: true, revisionNotes});
}

// Fulfill (or clear) one photo-plan slot with an approved photo. photoId null
// clears the slot.
export async function setNewsletterPhotoPlanSlot(sb, {issueId, slotId, photoId = null}) {
  const {data, error} = await sb.rpc('set_newsletter_photo_plan_slot', {
    p_issue_id: issueId,
    p_slot_id: slotId,
    p_photo_id: photoId ?? null,
  });
  if (error) throw new Error(`setNewsletterPhotoPlanSlot: ${error.message || String(error)}`);
  return data;
}

// Ask the Edge Function whether the AI provider key is configured (boolean only;
// the key never leaves the function). Non-throwing — the settings UI treats a
// failure / pre-deploy function as "unknown" and falls back to the template.
export async function probeNewsletterAi(sb) {
  try {
    const {data, error} = await sb.functions.invoke('newsletter-harvest', {body: {mode: 'admin', probe: true}});
    if (error) return {ok: false, aiConfigured: false};
    return {ok: !!(data && data.ok), aiConfigured: !!(data && data.aiConfigured)};
  } catch (_e) {
    return {ok: false, aiConfigured: false};
  }
}

export async function listNewsletterRunsAdmin(sb, issueId) {
  const {data, error} = await sb.rpc('list_newsletter_runs_admin', {p_issue_id: issueId});
  if (error) throw new Error(`listNewsletterRunsAdmin: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

export async function getNewsletterSettings(sb) {
  const {data, error} = await sb.rpc('get_newsletter_settings');
  if (error) throw new Error(`getNewsletterSettings: ${error.message || String(error)}`);
  return data || {};
}

// Admin: mint a fresh public archive access link (mig 153). Instantly revokes the
// prior link; the new key is valid for `days` (server clamps 1..60, default 7).
// Returns the updated settings (including the new archiveAccessToken + expiry).
export async function regenerateNewsletterArchiveLink(sb, days) {
  const {data, error} = await sb.rpc('regenerate_newsletter_archive_link', {
    p_days: Number.isFinite(days) ? days : null,
  });
  if (error) throw new Error(`regenerateNewsletterArchiveLink: ${error.message || String(error)}`);
  return data || {};
}

// Build the shareable public archive URL for a given key (origin-aware).
export function buildNewsletterArchiveLink(key) {
  if (!key) return '';
  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  return `${origin}/newsletter?key=${encodeURIComponent(key)}`;
}

// Append the gated archive key to an internal newsletter path so navigation
// keeps the link working (archive -> issue -> back all carry ?key=).
export function withNewsletterKey(path, key) {
  if (!key) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}key=${encodeURIComponent(key)}`;
}

export async function updateNewsletterSettings(
  sb,
  {
    aiProvider,
    aiModel,
    tone,
    tonePreset,
    lengthDetail,
    photoMin,
    photoTarget,
    pastIssueContextCount,
    taskAssignee,
    draftGenDay,
    publishTargetDay,
  } = {},
) {
  const {data, error} = await sb.rpc('update_newsletter_settings', {
    p_ai_provider: aiProvider ?? null,
    p_ai_model: aiModel ?? null,
    p_tone: tone ?? null,
    p_tone_preset: tonePreset ?? null,
    p_length_detail: lengthDetail ?? null,
    p_photo_min: Number.isFinite(photoMin) ? photoMin : null,
    p_photo_target: Number.isFinite(photoTarget) ? photoTarget : null,
    p_past_issue_context_count: Number.isFinite(pastIssueContextCount) ? pastIssueContextCount : null,
    p_task_assignee: taskAssignee ?? null,
    p_draft_gen_day: draftGenDay ?? null,
    p_publish_target_day: publishTargetDay ?? null,
  });
  if (error) throw new Error(`updateNewsletterSettings: ${error.message || String(error)}`);
  return data;
}

// Recent published issues + their included facts — powers the brief's repetition
// warnings (and any "what did we say last month" admin context).
export async function getNewsletterRecentPublishedAdmin(sb, {limit = 3, excludeId = null} = {}) {
  const {data, error} = await sb.rpc('get_newsletter_recent_published_admin', {
    p_limit: limit,
    p_exclude_id: excludeId,
  });
  if (error) throw new Error(`getNewsletterRecentPublishedAdmin: ${error.message || String(error)}`);
  return Array.isArray(data) ? data : [];
}

// ── Staging storage (private) ────────────────────────────────────────────────

// Upload a (compressed) image blob into the PRIVATE staging bucket and return
// the relative storage path. Idempotent: a duplicate object is treated as
// success (deterministic path + upsert:false, mirroring the task-photo owner).
export async function uploadNewsletterStagingPhoto(sb, issueId, blob, {token, ext = 'jpg'} = {}) {
  const relPath = buildNewsletterStoragePath(issueId, token || generateNewsletterPhotoToken(), ext);
  const compressed = await compressImage(blob);
  const {error} = await sb.storage
    .from(NEWSLETTER_STAGING_BUCKET)
    .upload(relPath, compressed, {contentType: compressed.type || 'image/jpeg', upsert: false});
  if (error && !isStorageDuplicateError(error)) {
    throw new Error(`uploadNewsletterStagingPhoto: ${error.message || String(error)}`);
  }
  return relPath;
}

// Re-upload an EXISTING private planner photo into staging. The caller passes a
// signed URL for the private source; we fetch the bytes and stage them so the
// public copy is a real byte copy, never a hotlinked private signed URL.
export async function stageNewsletterPhotoFromUrl(sb, issueId, sourceUrl, {ext = 'jpg'} = {}) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`stageNewsletterPhotoFromUrl: fetch failed (${res.status})`);
  const blob = await res.blob();
  return uploadNewsletterStagingPhoto(sb, issueId, blob, {ext});
}

export async function getNewsletterStagingSignedUrl(sb, storagePath, ttlSeconds = 600) {
  const {data, error} = await sb.storage.from(NEWSLETTER_STAGING_BUCKET).createSignedUrl(storagePath, ttlSeconds);
  if (error) throw new Error(`getNewsletterStagingSignedUrl: ${error.message || String(error)}`);
  return (data && data.signedUrl) || '';
}

// Copy staged bytes into the PUBLIC bucket at the same relative path. Cross-
// bucket copy isn't a single storage call, so we download (signed) and re-upload.
async function copyStagingBytesToPublic(sb, storagePath) {
  const signed = await getNewsletterStagingSignedUrl(sb, storagePath, 120);
  const res = await fetch(signed);
  if (!res.ok) throw new Error(`copyStagingBytesToPublic: staging fetch failed (${res.status})`);
  const blob = await res.blob();
  const {error} = await sb.storage
    .from(NEWSLETTER_PUBLIC_BUCKET)
    .upload(storagePath, blob, {contentType: blob.type || 'image/jpeg', upsert: true});
  if (error && !isStorageDuplicateError(error)) {
    throw new Error(`copyStagingBytesToPublic: ${error.message || String(error)}`);
  }
}

// Checked bucket-object deletion. Supabase storage reports a MISSING object as a
// non-error (empty data, error=null), so an already-gone object is fine — but a
// real permission/network/storage failure is surfaced (thrown), never swallowed,
// so the admin sees the failed cleanup and can retry. This matters most for the
// PUBLIC bucket: a silently-failed delete would leave approved bytes reachable
// by public URL.
async function removeBucketObject(sb, bucket, storagePath) {
  if (!storagePath) return;
  const {error} = await sb.storage.from(bucket).remove([storagePath]);
  if (error) throw new Error(`remove ${bucket}/${storagePath}: ${error.message || String(error)}`);
}

async function deletePublicBytes(sb, storagePath) {
  return removeBucketObject(sb, NEWSLETTER_PUBLIC_BUCKET, storagePath);
}

async function deleteStagingBytes(sb, storagePath) {
  return removeBucketObject(sb, NEWSLETTER_STAGING_BUCKET, storagePath);
}

// ── Approval gate (consent-to-public) ────────────────────────────────────────

// Approve a photo: copy staging bytes -> public FIRST, then flip approved=true
// (the RPC the public read path keys on). If the copy fails we never flip the
// flag, so unapproved bytes are never reachable by public URL.
export async function approveNewsletterPhoto(sb, photo) {
  await copyStagingBytesToPublic(sb, photo.storagePath);
  const {data, error} = await sb.rpc('set_newsletter_photo_approved', {p_id: photo.id, p_approved: true});
  if (error) throw new Error(`approveNewsletterPhoto: ${error.message || String(error)}`);
  return data;
}

// Unapprove: flip approved=false FIRST (public read path stops serving it), then
// delete the public bytes.
export async function unapproveNewsletterPhoto(sb, photo) {
  const {data, error} = await sb.rpc('set_newsletter_photo_approved', {p_id: photo.id, p_approved: false});
  if (error) throw new Error(`unapproveNewsletterPhoto: ${error.message || String(error)}`);
  await deletePublicBytes(sb, photo.storagePath);
  return data;
}

// Remove a photo entirely: delete public + staging bytes, then drop the row.
export async function removeNewsletterPhoto(sb, photo) {
  await deletePublicBytes(sb, photo.storagePath);
  await deleteStagingBytes(sb, photo.storagePath);
  const {data, error} = await sb.rpc('remove_newsletter_photo', {p_id: photo.id});
  if (error) throw new Error(`removeNewsletterPhoto: ${error.message || String(error)}`);
  return data;
}

// ── Error classification ─────────────────────────────────────────────────────
// Deterministic validation failures carry the NEWSLETTER_VALIDATION prefix from
// the RPCs; everything else is transient (network/5xx) and worth a retry.

export function isNewsletterValidationError(err) {
  return !!err && typeof err.message === 'string' && err.message.includes('NEWSLETTER_VALIDATION');
}

export function friendlyNewsletterError(err) {
  const msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
  const idx = msg.indexOf('NEWSLETTER_VALIDATION:');
  if (idx >= 0) return msg.slice(idx + 'NEWSLETTER_VALIDATION:'.length).trim();
  return msg.replace(/^[a-zA-Z_]+:\s*/, '');
}
