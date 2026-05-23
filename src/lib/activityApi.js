// Activity + @Mentions client API — read + comment + edit + soft-delete.
//
// Backed by 4 SECURITY DEFINER RPCs (mig 058 + mig 060 contract change):
//   list_activity_events(entity_type, entity_id, limit)
//     → returns rows with mentioned_profile_ids[] + mentioned_profile_names[]
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
// Mention contract (mig 060):
//   * The visible body is freeform plain text. Users only ever see
//     "@DisplayName" — uuids are NEVER shown.
//   * p_mentions[] is the AUTHORITATIVE mention identity. The server
//     validates each uuid (exists + not inactive + ≤10 cap + caller has
//     write permission) and fans out notifications. The body text is no
//     longer parsed for uuid tokens.
//   * Renderer chips "@Name" spans by matching mentioned_profile_names[]
//     returned from list_activity_events. Best-effort: ambiguous names
//     (two teammates with the same display name) all render as chips;
//     notifications still go to whichever uuid the user picked.

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
 * List activity events for one entity (newest first). Each row carries
 * both `mentioned_profile_ids` and `mentioned_profile_names` arrays
 * (same length, same order) for chip rendering. Soft-deleted rows are
 * INCLUDED so the panel can render "(comment deleted)" placeholders.
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
 * picked from the @ popover — the authoritative mention identity. The
 * visible body is freeform plain text; uuids never appear in it.
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

// ── Mention rendering helper (pure, exported for reuse + testing) ──────

/**
 * Split a comment body into renderable segments. Each "@Name" span whose
 * Name matches an entry in mentionedProfileNames becomes a chip; the
 * rest is plain text.
 *
 * Output is an array of:
 *   {type: 'text', text: '...'}
 *   {type: 'mention', display: 'Mak', profileId: 'uuid-or-null'}
 *
 * Multi-word names work (the picker inserts the full literal string).
 * Longest-match-wins so "@Test Admin" doesn't get partially eaten by
 * "@Test" if both names exist.
 *
 * Ambiguous case: if two mentioned profiles share the same display
 * name, all "@Name" spans chip with the FIRST profileId in the array.
 * The notification fan-out (server-side) is unaffected — every uuid
 * the user picked is notified separately. profileId may be null if
 * the renderer is called without the ids array (text-only chipping).
 */
export function renderMentionSegments(body, mentionedProfileNames = [], mentionedProfileIds = []) {
  if (!body || typeof body !== 'string') return [];
  if (!Array.isArray(mentionedProfileNames) || mentionedProfileNames.length === 0) {
    return [{type: 'text', text: body}];
  }
  // Pair name → first profile id. Names array can contain duplicates;
  // keep the first occurrence so the chip carries a stable id.
  const nameToId = new Map();
  for (let i = 0; i < mentionedProfileNames.length; i++) {
    const n = mentionedProfileNames[i];
    if (!n || nameToId.has(n)) continue;
    nameToId.set(n, mentionedProfileIds[i] || null);
  }
  // Longest-match-wins so multi-word names beat shorter substrings.
  const sortedNames = [...nameToId.keys()].filter((n) => n.length > 0).sort((a, b) => b.length - a.length);
  if (sortedNames.length === 0) return [{type: 'text', text: body}];

  const out = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== '@') {
      // Accumulate plain text until the next '@'.
      let j = i + 1;
      while (j < body.length && body[j] !== '@') j++;
      out.push({type: 'text', text: body.slice(i, j)});
      i = j;
      continue;
    }
    // body[i] === '@' — try to match a known mention name starting here.
    let matched = null;
    for (const name of sortedNames) {
      if (body.startsWith('@' + name, i)) {
        // Word-boundary on the right side: next char must be end-of-string
        // or non-name punctuation so "@Nick" doesn't match inside "@Nickname".
        const tailIdx = i + 1 + name.length;
        const tail = body[tailIdx];
        if (tail === undefined || /[\s.,!?;:)\]}'"-]/.test(tail)) {
          matched = name;
          break;
        }
      }
    }
    if (matched) {
      out.push({type: 'mention', display: matched, profileId: nameToId.get(matched)});
      i += 1 + matched.length;
    } else {
      // Lone @ not followed by a known mention — render as plain text.
      out.push({type: 'text', text: '@'});
      i += 1;
    }
  }
  // Collapse adjacent text segments for cleaner output.
  const collapsed = [];
  for (const seg of out) {
    const last = collapsed[collapsed.length - 1];
    if (seg.type === 'text' && last && last.type === 'text') {
      last.text += seg.text;
    } else {
      collapsed.push(seg);
    }
  }
  return collapsed;
}
