// Activity + @Mentions client API — read + comment + edit + soft-delete.
//
// Backed by 4 SECURITY DEFINER RPCs in mig 058:
//   list_activity_events(entity_type, entity_id, limit)
//   post_activity_comment(entity_type, entity_id, body, entity_label, mentions[])
//   edit_activity_event(event_id, body, mentions[])
//   delete_activity_event(event_id)
//
// The platform contract: clients NEVER hit `.from('activity_events')` or
// `.from('activity_mentions')` directly. RLS lockdown on the tables
// blocks it anyway (REVOKE ALL from authenticated), but the static lock
// also rejects any such reference in src/. The RPC layer is the only
// path; the SECDEF resolver re-checks the source entity's read gate.
//
// Mention notifications fan out server-side inside post_activity_comment
// and edit_activity_event. The frontend only supplies the list of
// mentioned profile ids; the RPC validates each id actually appears
// inline in the body (so a malicious client cannot notify arbitrary
// profiles) and rejects inactive recipients.

export const ACTIVITY_CHANGE_EVENT = 'wcf-activity-change';

export function fireActivityChangeEvent(entityType, entityId) {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  try {
    window.dispatchEvent(new CustomEvent(ACTIVITY_CHANGE_EVENT, {detail: {entityType, entityId}}));
  } catch (_e) {
    /* CustomEvent not supported in some test envs */
  }
}

/**
 * List activity events for one entity (newest first). Returns rows with
 * a `mentioned_profile_ids` array column the renderer uses to render
 * @mention chips. Soft-deleted rows are INCLUDED so the panel can show
 * "(comment deleted)" placeholders in place; the deleted_at column tells
 * the renderer which is which.
 */
export async function listActivityEvents(sb, entityType, entityId, {limit = 50} = {}) {
  if (!sb) return [];
  if (!entityType || !entityId) return [];
  const {data, error} = await sb.rpc('list_activity_events', {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_limit: limit,
  });
  if (error) throw new Error(`listActivityEvents: ${error.message || String(error)}`);
  return data || [];
}

/**
 * Count of NON-soft-deleted activity events for one entity. Used by the
 * compact chip on dense list rows. Lazy-loaded — never eager-batched in
 * Phase 1.
 */
export async function countActivityForEntity(sb, entityType, entityId) {
  if (!sb || !entityType || !entityId) return 0;
  const {data, error} = await sb.rpc('count_activity_for_entity', {
    p_entity_type: entityType,
    p_entity_id: entityId,
  });
  if (error) throw new Error(`countActivityForEntity: ${error.message || String(error)}`);
  return typeof data === 'number' ? data : Number(data) || 0;
}

/**
 * Post a comment. `mentions` is the array of profile uuids the user
 * picked from the @ popover; the RPC validates each uuid actually
 * appears in the body's `@[Name](profile:uuid)` markup.
 *
 * `entityLabel` is included so the resulting `mention` notifications
 * can render "X mentioned you on <label>" without having to round-trip
 * back to the entity table. Pass the cow tag, task title, equipment
 * name, etc. — whatever the registry's displayLabel resolver would
 * return.
 */
export async function postActivityComment(sb, {entityType, entityId, body, entityLabel, mentions = []}) {
  if (!sb) throw new Error('postActivityComment: sb required');
  if (!entityType || !entityId) throw new Error('postActivityComment: entityType + entityId required');
  if (!body || !body.trim()) throw new Error('postActivityComment: body required');
  const {data, error} = await sb.rpc('post_activity_comment', {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_body: body,
    p_entity_label: entityLabel || null,
    p_mentions: Array.isArray(mentions) ? mentions : [],
  });
  if (error) throw new Error(`postActivityComment: ${error.message || String(error)}`);
  fireActivityChangeEvent(entityType, entityId);
  return data;
}

/**
 * Edit your own comment. Server enforces author-only.
 */
export async function editActivityEvent(sb, {eventId, body, mentions = []}) {
  if (!sb || !eventId) throw new Error('editActivityEvent: sb + eventId required');
  const {data, error} = await sb.rpc('edit_activity_event', {
    p_event_id: eventId,
    p_body: body,
    p_mentions: Array.isArray(mentions) ? mentions : [],
  });
  if (error) throw new Error(`editActivityEvent: ${error.message || String(error)}`);
  fireActivityChangeEvent(null, null); // unknown entity at this point; just nudge
  return data;
}

/**
 * Soft-delete a comment. Author or admin only (RPC enforces).
 * Idempotent on already-deleted rows.
 */
export async function deleteActivityEvent(sb, eventId) {
  if (!sb || !eventId) throw new Error('deleteActivityEvent: sb + eventId required');
  const {data, error} = await sb.rpc('delete_activity_event', {p_event_id: eventId});
  if (error) throw new Error(`deleteActivityEvent: ${error.message || String(error)}`);
  fireActivityChangeEvent(null, null);
  return data;
}

// ── Mention parsing / rendering helpers (pure functions, exported for
// reuse + testing) ──────────────────────────────────────────────────────

// Match @[Display Name](profile:<uuid>). The display name allows any
// non-newline characters except ']' (which would close the bracket
// group). UUID is the standard 36-char hyphenated form.
const MENTION_INLINE_RE =
  /@\[([^\]\n]+)\]\(profile:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)/g;

/**
 * Extract the unique profile uuids referenced in a comment body. Mirrors
 * the server-side _extract_mention_uuids exactly. Order preserved
 * first-appearance.
 */
export function extractMentionUuids(body) {
  if (!body || typeof body !== 'string') return [];
  const seen = new Set();
  const out = [];
  let m;
  // RegExp objects with the `g` flag are stateful; use a fresh one.
  const re = new RegExp(MENTION_INLINE_RE.source, 'g');
  while ((m = re.exec(body)) !== null) {
    const uuid = m[2].toLowerCase();
    if (!seen.has(uuid)) {
      seen.add(uuid);
      out.push(uuid);
    }
  }
  return out;
}

/**
 * Split a comment body into renderable segments. Output is an array of
 *   {type: 'text', text: '...'}
 *   {type: 'mention', display: 'Mak', profileId: 'uuid'}
 * The renderer maps text segments to plain text and mention segments to
 * a styled chip.
 */
export function renderMentionSegments(body) {
  if (!body || typeof body !== 'string') return [];
  const out = [];
  let last = 0;
  const re = new RegExp(MENTION_INLINE_RE.source, 'g');
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push({type: 'text', text: body.slice(last, m.index)});
    out.push({type: 'mention', display: m[1], profileId: m[2].toLowerCase()});
    last = re.lastIndex;
  }
  if (last < body.length) out.push({type: 'text', text: body.slice(last)});
  return out;
}

/**
 * Build the canonical inline mention string from a picked profile.
 *   buildMentionToken({id, full_name}) → '@[Mak](profile:abc-...)'
 */
export function buildMentionToken(profile) {
  if (!profile || !profile.id) return '';
  const display = (profile.full_name || profile.name || 'Unknown').replace(/[\]\n]/g, '');
  return `@[${display}](profile:${profile.id})`;
}
