// Activity entity registry — the single client-side source of truth for
// "what is this entity_type, where does its detail page live, what label
// should we show on its notifications?".
//
// Server-side, the permission resolver `_activity_can_read` (mig 058 +
// mig 062) carries a parallel CASE expression. Adding a new entity_type
// means touching BOTH: register here + add a CASE branch in the SQL.

export const ENTITY_TYPES = {
  TASK_INSTANCE: 'task.instance',
  BROILER_BATCH: 'broiler.batch',
  LAYER_BATCH: 'layer.batch',
  LAYER_HOUSING: 'layer.housing',
  CATTLE_ANIMAL: 'cattle.animal',
  SHEEP_ANIMAL: 'sheep.animal',
  EQUIPMENT_ITEM: 'equipment.item',
  PIG_BATCH: 'pig.batch',
  CATTLE_PROCESSING: 'cattle.processing',
  SHEEP_PROCESSING: 'sheep.processing',
};

export const ACTIVITY_REGISTRY = {
  [ENTITY_TYPES.TASK_INSTANCE]: {
    displayLabel: (id, ctx) => (ctx && ctx.title ? ctx.title : id),
    route: (id) => `/tasks?task=${encodeURIComponent(id)}`,
    program: null,
  },
  [ENTITY_TYPES.BROILER_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (_id) => '/broiler/batches',
    program: 'broiler',
  },
  [ENTITY_TYPES.LAYER_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (_id) => '/layer/batches',
    program: 'layer',
  },
  [ENTITY_TYPES.LAYER_HOUSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.housing_name ? ctx.housing_name : id),
    route: (_id) => '/layer/batches',
    program: 'layer',
  },
  [ENTITY_TYPES.CATTLE_ANIMAL]: {
    displayLabel: (id, ctx) => (ctx && ctx.tag ? ctx.tag : id),
    route: (_id) => '/cattle/herds',
    program: 'cattle',
  },
  [ENTITY_TYPES.SHEEP_ANIMAL]: {
    displayLabel: (id, ctx) => (ctx && ctx.tag ? ctx.tag : id),
    route: (_id) => '/sheep/flocks',
    program: 'sheep',
  },
  [ENTITY_TYPES.EQUIPMENT_ITEM]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (_id, ctx) => (ctx && ctx.slug ? `/fleet/${ctx.slug}` : '/fleet'),
    program: null,
  },
  [ENTITY_TYPES.PIG_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.batchName ? ctx.batchName : id),
    route: (_id) => '/pig/batches',
    program: 'pig',
  },
  [ENTITY_TYPES.CATTLE_PROCESSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (_id) => '/cattle/batches',
    program: 'cattle',
  },
  [ENTITY_TYPES.SHEEP_PROCESSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (_id) => '/sheep/batches',
    program: 'sheep',
  },
};

export function getActivityEntityMeta(entityType) {
  return ACTIVITY_REGISTRY[entityType] || null;
}

export function resolveNotificationRoute(notification, eventEntityType, eventEntityId) {
  if (notification && notification.type === 'mention' && eventEntityType) {
    const meta = getActivityEntityMeta(eventEntityType);
    if (meta && typeof meta.route === 'function') {
      try {
        return meta.route(eventEntityId);
      } catch (_e) {
        /* fall through */
      }
    }
  }
  if (notification && notification.task_instance_id) {
    if (notification.type === 'task_completed') {
      return `/tasks?tab=completed&task=${encodeURIComponent(notification.task_instance_id)}`;
    }
    return `/tasks?task=${encodeURIComponent(notification.task_instance_id)}`;
  }
  return '/tasks';
}

export function routeToView(routePath) {
  if (!routePath) return {view: 'home', search: ''};
  const [path, search] = routePath.split('?');
  const VIEW_MAP = {
    '/tasks': 'tasks',
    '/broiler/batches': 'list',
    '/layer': 'layersHome',
    '/layer/batches': 'layerbatches',
    '/pig/batches': 'pigbatches',
    '/cattle/batches': 'cattlebatches',
    '/sheep/batches': 'sheepbatches',
    '/cattle/herds': 'cattleherds',
    '/sheep/flocks': 'sheepflocks',
    '/fleet': 'equipmentHome',
    '/admin': 'webforms',
  };
  if (path.startsWith('/fleet/')) return {view: 'equipmentHome', search: search || ''};
  return {view: VIEW_MAP[path] || 'home', search: search || ''};
}
