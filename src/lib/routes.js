// ============================================================================
// src/lib/routes.js  —  Phase 3.1: route map scaffolding
// ----------------------------------------------------------------------------
// Single source of truth for the view ↔ URL mapping. Used by the URL sync
// adapter in App (Phase 3.2) to write `view` state into the address bar and
// read it back on mount + on popstate (back/forward button).
//
// Nothing in here imports React or hooks — it's pure data. Safe to import
// from any module, including main.jsx at module scope.
//
// The `view` state machine stays unchanged. setView('X') is still the API
// every component calls. The URL just mirrors `view` (and vice versa on
// back/forward).
//
// 2026-05-06 public-URL rename:
//   - Public daily-reports hub canonical: /dailys (was /webforms).
//   - Public equipment/fueling hub canonical: /equipment (was /fueling).
//   - Internal logged-in Equipment module canonical: /fleet (was /equipment).
//   Old paths remain working aliases — see ALIASES_EXACT / ALIASES_PREFIX.
// ============================================================================

// view string → URL path. Keep paths lower-kebab-case, program-scoped where
// it makes sense. Home is '/'. Legacy hash bookmarks (/#weighins, /#addfeed,
// /#webforms) map to canonical paths and are rewritten by the hash-compat
// shim in main.jsx.
export const VIEW_TO_PATH = {
  // Home
  home: '/',

  // Broiler
  broilerHome: '/broiler',
  timeline: '/broiler/timeline',
  list: '/broiler/batches',
  feed: '/broiler/feed',
  broilerdailys: '/broiler/dailys',
  broilerweighins: '/broiler/weighins',

  // Pig
  pigsHome: '/pig',
  breeding: '/pig/breeding',
  farrowing: '/pig/farrowing',
  sows: '/pig/sows',
  pigbatches: '/pig/batches',
  pigs: '/pig/feed', // `pigs` is the current view string for PigFeedView
  pigdailys: '/pig/dailys',
  pigweighins: '/pig/weighins',

  // Layer
  layersHome: '/layer',
  layers: '/layer/groups', // legacy LayersView — pre-batch-housings layer groups editor
  layerbatches: '/layer/batches',
  layerdailys: '/layer/dailys',
  eggdailys: '/layer/eggs',

  // Cattle
  cattleHome: '/cattle',
  cattleherds: '/cattle/herds',
  cattlebreeding: '/cattle/breeding',
  cattleweighins: '/cattle/weighins',
  cattleforecast: '/cattle/forecast',
  cattlebatches: '/cattle/batches',
  cattledailys: '/cattle/dailys',

  // Sheep
  sheepHome: '/sheep',
  sheepflocks: '/sheep/flocks',
  sheepbatches: '/sheep/batches',
  sheepdailys: '/sheep/dailys',
  sheepweighins: '/sheep/weighins',

  // Equipment (logged-in internal — moved to /fleet 2026-05-06).
  // Note: only the equipmentHome view has a top-level VIEW_TO_PATH entry.
  // EquipmentHome owns sub-routing under /fleet/* (Fleet view at /fleet,
  // Fuel Log at /fleet/fuel-log, per-equipment detail at /fleet/<slug>),
  // and main.jsx's URL adapter routes any /fleet/<sub> path to
  // view='equipmentHome'. Adding /fleet/fuel-log here would break that —
  // PATH_TO_VIEW would resolve to a separate equipmentFuelLog view that
  // isn't registered in main.jsx VALID_VIEWS, snapping the user home.
  // The legacy /equipment/fleet and /equipment/fuel-log paths are
  // preserved via ALIASES_EXACT (both redirect into the /fleet/* world).
  equipmentHome: '/fleet',

  // Admin (logged-in only)
  webforms: '/admin',
  // Task Center (Tasks v2). Auth-gated, requireAdmin:false. Every
  // logged-in user can reach this; the System Tasks tab self-gates
  // to admins inside the view. Legacy /my-tasks and /admin/tasks
  // are aliases that redirect here (T11) — see ALIASES_EXACT.
  tasks: '/tasks',
  activity: '/activity',

  // Public (no-auth) — these also have legacy aliases handled below.
  webformhub: '/dailys',
  tasksWebform: '/dailys/tasks',
  addfeed: '/addfeed',
  weighins: '/weighins',
  webform: '/webform-pigs', // legacy standalone pig-dailys public form (rare)
  fuelingHub: '/equipment',
  fuelSupply: '/fuel-supply',
};

// Reverse map: path → view. Used by the URL sync adapter on mount and on
// popstate to figure out what view the URL currently points at.
export const PATH_TO_VIEW = Object.fromEntries(Object.entries(VIEW_TO_PATH).map(([v, p]) => [p, v]));

// Legacy hash bookmarks users may have saved in browsers/Slack/email.
// main.jsx reads these once on app mount and history.replaceState()s to
// the corresponding clean path before the router boots.
// NOTE: /#access_token=...&type=recovery is deliberately NOT rewritten —
// SetPasswordScreen parses it from the hash for backward compat with the
// supabase invite/recovery email template.
export const HASH_COMPAT = {
  '#weighins': '/weighins',
  '#addfeed': '/addfeed',
  '#webforms': '/dailys',
};

// Exact-path aliases for the 2026-05-06 public-URL rename. The URL sync
// adapter resolves these before routing — visiting any of these triggers a
// replace-navigate to the canonical path so operators with bookmarks /
// printed materials still land on the right hub and the address bar
// updates.
//
// Intentionally NOT aliased: /equipment/<slug> does NOT redirect to
// /fleet/<slug>. /equipment is now the public equipment-checklist hub, and
// /equipment/<slug> resolves to that hub's per-piece detail. Old logged-in
// /equipment/<slug> bookmarks land on the public checklist for that piece.
export const ALIASES_EXACT = {
  '/webforms': '/dailys',
  '/webforms/tasks': '/dailys/tasks',
  '/fueling': '/equipment',
  '/fueling/supply': '/equipment/supply',
  '/equipment/fleet': '/fleet',
  '/equipment/fuel-log': '/fleet/fuel-log',
  // T11: retire legacy Tasks routes. Both legacy paths redirect to
  // /tasks so old bookmarks, the dark-bar burger menu's prior entries,
  // and any external links (digest emails, Slack pastes) land on the
  // canonical Task Center. The legacy MyTasksView / AdminTasksView
  // mounts are removed from main.jsx; the alias is the only path.
  '/my-tasks': '/tasks',
  '/admin/tasks': '/tasks',
  // 2026-05-14: standalone /fleet/materials operator page retired in
  // favor of the home dashboard Materials Needed card. Old bookmarks
  // land on the fleet list (which already includes the per-equipment
  // detail entry points).
  '/fleet/materials': '/fleet',
};

// Prefix aliases. The matched prefix is replaced with the canonical prefix
// and the rest of the path is preserved (e.g. /webforms/sheep → /dailys/sheep,
// /fueling/jd-317 → /equipment/jd-317). The exact-aliases map is checked
// first, so /webforms/tasks and /fueling/supply hit the exact rule before
// falling through to the generic prefix rule.
export const ALIASES_PREFIX = [
  ['/webforms/', '/dailys/'],
  ['/fueling/', '/equipment/'],
];
