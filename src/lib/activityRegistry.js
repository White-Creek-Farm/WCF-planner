// Activity entity registry — the single client-side source of truth for
// "what is this entity_type, where does its detail page live, what label
// should we show on its notifications?".
//
// Server-side, the permission resolver `_activity_can_read` (mig 058)
// carries a parallel CASE expression. Adding a new entity_type means
// touching BOTH: register here + add a CASE branch in the SQL. The
// static lock asserts they stay in sync per-type as the registry grows.
//
// Phase 1: only `task.instance`.

export const ENTITY_TYPES = {
  TASK_INSTANCE: 'task.instance',
};

export const ACTIVITY_REGISTRY = {
  [ENTITY_TYPES.TASK_INSTANCE]: {
    /**
     * Human label for the entity (used in notification titles and Activity
     * panel header). Receives (entityId, ctx). ctx is an optional bag the
     * caller passes — for tasks it's typically the task instance row.
     */
    displayLabel: (id, ctx) => {
      if (ctx && ctx.title) return ctx.title;
      return id;
    },
    /**
     * Where clicking the notification or "Open" link should route to.
     * Tasks landing on /tasks; future entities use program-scoped paths.
     */
    route: (_id) => `/tasks`,
    /**
     * Program scope hint. null = not program-gated; future cattle.* etc.
     * use 'cattle' here. The server resolver still enforces the actual
     * read gate; this is just a hint for client-side filtering helpers
     * that might be added later.
     */
    program: null,
  },
};

/**
 * Look up a registry entry. Returns null for unknown types so callers
 * can fail gracefully instead of throwing on a new server-side type the
 * client hasn't shipped yet.
 */
export function getActivityEntityMeta(entityType) {
  return ACTIVITY_REGISTRY[entityType] || null;
}

/**
 * Resolve a notification row's route. Notifications carry both a
 * legacy task_instance_id (existing 'task_completed' rows) and the new
 * activity_event_id (mig 058 mention rows). The Header bell calls this
 * to figure out where to send the user on click.
 */
export function resolveNotificationRoute(notification, eventEntityType, eventEntityId) {
  // 'mention' notifications carry an activity_event_id; we look up the
  // entity from the event row (already fetched by the dropdown).
  if (notification && notification.type === 'mention' && eventEntityType) {
    const meta = getActivityEntityMeta(eventEntityType);
    if (meta && typeof meta.route === 'function') {
      try {
        return meta.route(eventEntityId);
      } catch (_e) {
        /* fall through to default */
      }
    }
  }
  // 'task_completed' (and any other legacy type) — default to /tasks.
  return '/tasks';
}
