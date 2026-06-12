// Cattle Log API — thin RPC wrappers for the /cattle/log page.
//
// Entries are canonical comments on the singleton entity ('cattle.log',
// 'cattle-log'); every call here goes through the SECURITY DEFINER RPC
// family from migration 112. NO direct .from() access to comments or the
// cattle_log_* tables — the RPCs own all validation (roles, tag matching,
// mirrors, calf notes) and this module stays deliberately dumb.
//
// Style mirrors src/lib/commentsApi.js: throw `fnName: message` on RPC
// error, return `data` on success, fire COMMENT_CHANGE_EVENT after
// mutations that touch comments rows (submit/edit/delete also create or
// remove mirror comments on cow pages).

import {COMMENT_CHANGE_EVENT} from './commentsApi.js';

// Vitest runs in a node environment (no window); guard so the wrappers
// stay testable and SSR-safe.
function emitCommentChange() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(COMMENT_CHANGE_EVENT));
  }
}

/**
 * Client-generated entry id: 'cl-' + base36 timestamp + '-' + base36 random.
 * Guaranteed to never start with 'clog-' (mirror prefix) and to never
 * contain '--' (the mirror-id separator: 'clog-<entryId>--<cattleId>').
 * Generate once at submit time and persist with the queued offline row so
 * replays reuse the same id (the submit RPC is idempotent on p_id).
 */
export function generateCattleLogEntryId() {
  const ts = Date.now().toString(36);
  let rand = '';
  while (rand.length < 8) {
    rand += Math.random().toString(36).slice(2);
  }
  return `cl-${ts}-${rand.slice(0, 8)}`;
}

/**
 * Submit a new log entry. Returns {id, created_at, is_issue,
 * unresolved_tags, matched: [{tag, cattle_id}], replayed}.
 * Replay-idempotent: resubmitting an existing p_id returns the existing
 * summary with replayed:true instead of erroring.
 */
export async function submitCattleLogEntry(
  sb,
  {id, body, mentions = [], attachments = [], isIssue = true, calfNotes = {}},
) {
  if (!sb) throw new Error('submitCattleLogEntry: sb required');
  const {data, error} = await sb.rpc('submit_cattle_log_entry', {
    p_id: id,
    p_body: body,
    p_mentions: mentions,
    p_attachments: attachments,
    p_is_issue: isIssue,
    p_calf_notes: calfNotes,
  });
  if (error) throw new Error(`submitCattleLogEntry: ${error.message || String(error)}`);
  emitCommentChange();
  return data;
}

/**
 * Author-only edit of a live entry. Re-parses tags server-side, diffs the
 * links (removing/adding mirrors), and resyncs surviving mirrors.
 *
 * mentions semantics: an array REPLACES the entry's mentions (an empty []
 * clears them); null passes p_mentions NULL, which the RPC treats as
 * 'preserve existing mentions; no new notifications'. Callers that can't
 * reconstruct the full uuid list (the list RPC returns names, not uuids)
 * must pass null rather than a possibly-lossy array.
 */
export async function editCattleLogEntry(sb, {id, body, mentions = [], attachments = [], calfNotes = {}}) {
  if (!sb) throw new Error('editCattleLogEntry: sb required');
  const {data, error} = await sb.rpc('edit_cattle_log_entry', {
    p_id: id,
    p_body: body,
    // Explicit null → NULL (preserve). Only undefined falls back to [].
    p_mentions: mentions === null ? null : mentions,
    p_attachments: attachments,
    p_calf_notes: calfNotes,
  });
  if (error) throw new Error(`editCattleLogEntry: ${error.message || String(error)}`);
  emitCommentChange();
  return data;
}

/**
 * management/admin only. Soft-deletes the entry and hard-deletes its
 * mirror comments on cow pages.
 */
export async function deleteCattleLogEntry(sb, id) {
  if (!sb) throw new Error('deleteCattleLogEntry: sb required');
  const {data, error} = await sb.rpc('delete_cattle_log_entry', {
    p_id: id,
  });
  if (error) throw new Error(`deleteCattleLogEntry: ${error.message || String(error)}`);
  emitCommentChange();
  return data;
}

/**
 * management/admin only. Sets/clears the issue flag (both directions
 * allowed: clear and re-check).
 */
export async function setCattleLogIssue(sb, id, isIssue) {
  if (!sb) throw new Error('setCattleLogIssue: sb required');
  const {data, error} = await sb.rpc('set_cattle_log_issue', {
    p_id: id,
    p_is_issue: !!isIssue,
  });
  if (error) throw new Error(`setCattleLogIssue: ${error.message || String(error)}`);
  return data;
}

/**
 * List entries newest-first with keyset pagination.
 * - filter: 'issues' (default) | 'all'
 * - search: server-side full-history search (body / author / #tag), or null
 * - before: {createdAt, id} of the last loaded row for 'Load more'
 *   (snake_case {created_at, id} also accepted so a raw entry row works)
 * Returns {entries: [...], has_more}.
 */
export async function listCattleLogEntries(sb, {filter = 'issues', search = null, limit = 200, before = null} = {}) {
  if (!sb) throw new Error('listCattleLogEntries: sb required');
  const beforeCreatedAt = before ? before.createdAt || before.created_at || null : null;
  const beforeId = before ? before.id || null : null;
  const {data, error} = await sb.rpc('list_cattle_log_entries', {
    p_filter: filter,
    p_search: search || null,
    p_limit: limit,
    p_before_created_at: beforeCreatedAt,
    p_before_id: beforeId,
  });
  if (error) throw new Error(`listCattleLogEntries: ${error.message || String(error)}`);
  return data || {entries: [], has_more: false};
}

/**
 * Active profiles with role in (light, farm_team, management, admin).
 * Swallows errors (returns []) like loadMentionableProfiles — the mention
 * picker degrades gracefully rather than blocking the composer.
 */
export async function loadCattleLogMentionableProfiles(sb) {
  if (!sb) return [];
  const {data, error} = await sb.rpc('list_cattle_log_mentionable_profiles');
  if (error) return [];
  return data || [];
}

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.details) parts.push(String(err.details));
  if (err.hint) parts.push(String(err.hint));
  if (parts.length === 0) {
    try {
      parts.push(String(err));
    } catch (_e) {
      /* unstringifiable -> transient */
    }
  }
  return parts.join(' ');
}

/**
 * Classify an error from any wrapper above for the offline queue and
 * composer UX:
 * - 'ambiguous_tag'   — CATTLE_LOG_AMBIGUOUS_TAG (tag matches >1 active cow)
 * - 'mention_invalid' — CATTLE_LOG_MENTION_INVALID
 * - 'validation'      — CATTLE_LOG_VALIDATION (incl. mirror-guard raises)
 * - 'transient'       — network/fetch/abort/timeout/5xx/everything else
 *   (safe to keep queued and retry)
 * Works on raw supabase errors and on the `fnName: message` Errors the
 * wrappers throw (substring match, not prefix match).
 */
export function classifyCattleLogError(err) {
  const text = errorText(err);
  if (text.includes('CATTLE_LOG_AMBIGUOUS_TAG')) return 'ambiguous_tag';
  if (text.includes('CATTLE_LOG_MENTION_INVALID')) return 'mention_invalid';
  if (text.includes('CATTLE_LOG_VALIDATION')) return 'validation';
  return 'transient';
}
