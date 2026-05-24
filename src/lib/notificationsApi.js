// In-app notifications — read-only helpers + mark-read mutations.
//
// Writes (insertion of new notifications) happen ONLY inside SECURITY
// DEFINER RPCs. Today the only writer is complete_task_instance v2
// (mig 053 + mig 057) which inserts a 'task_completed' notification for
// the task creator when somebody else completes it.
//
// The recipient-only RLS (mig 057) means:
//   * SELECT returns only the caller's own notifications.
//   * UPDATE accepts only the caller's own rows; WITH CHECK keeps
//     recipient_profile_id pinned so a malicious client can't reassign.
//   * INSERT/DELETE are unreachable from the client.
//
// Header badge soft-fails on any error (count -> 0) so a transient DB
// blip never breaks header render. Same soft-fail pattern as the
// existing Tasks-due badge in src/shared/Header.jsx.

// We expose a small custom-event name so the Header dropdown panel can
// nudge a refresh after a mark-read action without prop-drilling through
// AuthContext. Mirrors the TASK_CHANGE_EVENT pattern in
// tasksCenterMutationsApi.js.
export const NOTIFICATIONS_CHANGE_EVENT = 'wcf-notifications-change';

export function fireNotificationsChangeEvent() {
  if (typeof window === 'undefined' || !window.dispatchEvent) return;
  try {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGE_EVENT));
  } catch (_e) {
    /* CustomEvent not supported in some test envs; safe to ignore */
  }
}

/**
 * Count unread notifications for the caller. Returns 0 for a falsy
 * recipientId (unauthenticated render path). Throws on DB error so the
 * caller (Header) can soft-fail to 0.
 */
export async function countUnreadNotifications(sb, recipientId) {
  if (!sb || !recipientId) return 0;
  const {count, error} = await sb
    .from('notifications')
    .select('id', {count: 'exact', head: true})
    .eq('recipient_profile_id', recipientId)
    .is('read_at', null);
  if (error) throw new Error(`countUnreadNotifications: ${error.message}`);
  return count || 0;
}

/**
 * Load the caller's most recent notifications (read and unread). Capped
 * at limit (default 20) so the dropdown panel stays light. The recipient
 * RLS keeps cross-user rows out.
 */
export async function loadRecentNotifications(sb, {limit = 20} = {}) {
  if (!sb) return [];
  const {data, error} = await sb
    .from('notifications')
    .select(
      'id, recipient_profile_id, actor_profile_id, type, task_instance_id, activity_event_id, title, body, read_at, created_at',
    )
    .order('created_at', {ascending: false})
    .limit(limit);
  if (error) throw new Error(`loadRecentNotifications: ${error.message}`);
  return data || [];
}

/**
 * Mark a single notification as read (sets read_at = now()). RLS keeps
 * cross-user updates blocked. Idempotent: marking an already-read row
 * leaves read_at unchanged (we filter by .is('read_at', null) to avoid
 * re-stamping).
 */
export async function markNotificationRead(sb, id) {
  if (!sb || !id) return null;
  const {data, error} = await sb
    .from('notifications')
    .update({read_at: new Date().toISOString()})
    .eq('id', id)
    .is('read_at', null)
    .select('id, read_at')
    .maybeSingle();
  if (error) throw new Error(`markNotificationRead: ${error.message}`);
  fireNotificationsChangeEvent();
  return data;
}

/**
 * Mark all unread notifications for the recipient as read. Returns the
 * number of rows updated.
 */
export async function markAllNotificationsRead(sb, recipientId) {
  if (!sb || !recipientId) return 0;
  const {data, error} = await sb
    .from('notifications')
    .update({read_at: new Date().toISOString()})
    .eq('recipient_profile_id', recipientId)
    .is('read_at', null)
    .select('id');
  if (error) throw new Error(`markAllNotificationsRead: ${error.message}`);
  fireNotificationsChangeEvent();
  return (data || []).length;
}
