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
  CATTLE_FORECAST: 'cattle.forecast',
  SHEEP_PROCESSING: 'sheep.processing',
  POULTRY_DAILY: 'poultry.daily',
  LAYER_DAILY: 'layer.daily',
  EGG_DAILY: 'egg.daily',
  PIG_DAILY: 'pig.daily',
  CATTLE_DAILY: 'cattle.daily',
  SHEEP_DAILY: 'sheep.daily',
  WEIGHIN_SESSION: 'weighin.session',
};

export const ACTIVITY_REGISTRY = {
  [ENTITY_TYPES.TASK_INSTANCE]: {
    displayLabel: (id, ctx) => (ctx && ctx.title ? ctx.title : id),
    route: (id) => `/tasks/${encodeURIComponent(id)}`,
    program: null,
  },
  [ENTITY_TYPES.BROILER_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (id) => '/broiler/batches/' + encodeURIComponent(id),
    program: 'broiler',
  },
  [ENTITY_TYPES.LAYER_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (id) => '/layer/batches/' + id,
    program: 'layer',
  },
  [ENTITY_TYPES.LAYER_HOUSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.housing_name ? ctx.housing_name : id),
    route: (id) => '/layer/housings/' + id,
    program: 'layer',
  },
  [ENTITY_TYPES.CATTLE_ANIMAL]: {
    displayLabel: (id, ctx) => (ctx && ctx.tag ? ctx.tag : id),
    route: (id) => '/cattle/herds/' + id,
    program: 'cattle',
  },
  [ENTITY_TYPES.SHEEP_ANIMAL]: {
    displayLabel: (id, ctx) => (ctx && ctx.tag ? ctx.tag : id),
    route: (id) => '/sheep/flocks/' + id,
    program: 'sheep',
  },
  [ENTITY_TYPES.EQUIPMENT_ITEM]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (id) => `/fleet/${id}`,
    program: null,
  },
  [ENTITY_TYPES.PIG_BATCH]: {
    displayLabel: (id, ctx) => (ctx && ctx.batchName ? ctx.batchName : id),
    route: (id) => '/pig/batches/' + encodeURIComponent(id),
    program: 'pig',
  },
  [ENTITY_TYPES.CATTLE_PROCESSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (id) => '/cattle/batches/' + id,
    program: 'cattle',
  },
  // Custom editable-table Activity: singleton cattle forecast workflow entity.
  // The label is constant (the table, not a per-row record); rows route to the
  // forecast view.
  [ENTITY_TYPES.CATTLE_FORECAST]: {
    displayLabel: () => 'Cattle Forecast',
    route: () => '/cattle/forecast',
    program: 'cattle',
  },
  [ENTITY_TYPES.SHEEP_PROCESSING]: {
    displayLabel: (id, ctx) => (ctx && ctx.name ? ctx.name : id),
    route: (id) => '/sheep/batches/' + id,
    program: 'sheep',
  },
  [ENTITY_TYPES.POULTRY_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.batch_label ? ' · ' + ctx.batch_label : '') : id),
    route: (id) => '/broiler/dailys/' + id,
    program: 'broiler',
  },
  [ENTITY_TYPES.LAYER_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.batch_label ? ' · ' + ctx.batch_label : '') : id),
    route: (id) => '/layer/dailys/' + id,
    program: 'layer',
  },
  [ENTITY_TYPES.EGG_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date : id),
    route: (id) => '/layer/eggs/' + id,
    program: 'layer',
  },
  [ENTITY_TYPES.PIG_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.batch_label ? ' · ' + ctx.batch_label : '') : id),
    route: (id) => '/pig/dailys/' + id,
    program: 'pig',
  },
  [ENTITY_TYPES.CATTLE_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.herd ? ' · ' + ctx.herd : '') : id),
    route: (id) => '/cattle/dailys/' + id,
    program: 'cattle',
  },
  [ENTITY_TYPES.SHEEP_DAILY]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.flock ? ' · ' + ctx.flock : '') : id),
    route: (id) => '/sheep/dailys/' + id,
    program: 'sheep',
  },
  [ENTITY_TYPES.WEIGHIN_SESSION]: {
    displayLabel: (id, ctx) => (ctx && ctx.date ? ctx.date + (ctx.species ? ' · ' + ctx.species : '') : id),
    route: (id) => '/weigh-in-sessions/' + id,
    program: null,
  },
};

export function getActivityEntityMeta(entityType) {
  return ACTIVITY_REGISTRY[entityType] || null;
}

export function resolveNotificationRoute(notification, eventEntityType, eventEntityId) {
  if (notification && notification.type === 'comment_mention') {
    const et = notification.activity_entity_type;
    const eid = notification.activity_entity_id;
    if (et && eid) {
      const meta = getActivityEntityMeta(et);
      if (meta && typeof meta.route === 'function') {
        try {
          let route = meta.route(eid);
          if (notification.comment_id) route += '#comment-' + notification.comment_id;
          return route;
        } catch (_e) {
          /* fall through */
        }
      }
    }
  }
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
    return `/tasks/${encodeURIComponent(notification.task_instance_id)}`;
  }
  return '/tasks';
}

export function routeToView(routePath) {
  if (!routePath) return {view: 'home', search: ''};
  const [path, search] = routePath.split('?');
  const VIEW_MAP = {
    '/tasks': 'tasks',
    '/broiler/batches': 'list',
    '/broiler/dailys': 'broilerdailys',
    '/layer': 'layersHome',
    '/layer/batches': 'layerbatches',
    '/layer/dailys': 'layerdailys',
    '/layer/eggs': 'eggdailys',
    '/pig/batches': 'pigbatches',
    '/pig/dailys': 'pigdailys',
    '/cattle/batches': 'cattlebatches',
    '/cattle/herds': 'cattleherds',
    '/cattle/dailys': 'cattledailys',
    '/sheep/batches': 'sheepbatches',
    '/sheep/flocks': 'sheepflocks',
    '/sheep/dailys': 'sheepdailys',
    '/fleet': 'equipmentHome',
    '/admin': 'webforms',
  };
  if (path.startsWith('/tasks/')) return {view: 'tasks', search: search || ''};
  if (path.startsWith('/fleet/')) return {view: 'equipmentHome', search: search || ''};
  if (path.startsWith('/cattle/herds/')) return {view: 'cattleherds', search: search || ''};
  if (path.startsWith('/cattle/batches/')) return {view: 'cattlebatches', search: search || ''};
  if (path.startsWith('/sheep/flocks/')) return {view: 'sheepflocks', search: search || ''};
  if (path.startsWith('/sheep/batches/')) return {view: 'sheepbatches', search: search || ''};
  if (path.startsWith('/broiler/dailys/')) return {view: 'broilerdailys', search: search || ''};
  if (path.startsWith('/pig/batches/')) return {view: 'pigbatches', search: search || ''};
  if (path.startsWith('/pig/dailys/')) return {view: 'pigdailys', search: search || ''};
  if (path.startsWith('/cattle/dailys/')) return {view: 'cattledailys', search: search || ''};
  if (path.startsWith('/sheep/dailys/')) return {view: 'sheepdailys', search: search || ''};
  if (path.startsWith('/layer/dailys/')) return {view: 'layerdailys', search: search || ''};
  if (path.startsWith('/layer/eggs/')) return {view: 'eggdailys', search: search || ''};
  if (path.startsWith('/layer/batches/')) return {view: 'layerbatches', search: search || ''};
  if (path.startsWith('/layer/housings/')) return {view: 'layerbatches', search: search || ''};
  if (path.startsWith('/broiler/batches/')) return {view: 'list', search: search || ''};
  if (path.startsWith('/weigh-in-sessions/')) return {view: 'weighinsessions', search: search || ''};
  return {view: VIEW_MAP[path] || 'home', search: search || ''};
}
