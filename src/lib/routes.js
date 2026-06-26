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
  animalHistory: '/animals-on-farm',
  production: '/production',

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
  cattlelog: '/cattle/log',

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

  // Pasture Map (logged-in field surface). Land/paddock model + OnX-KML import
  // + aerial map. Auth-gated, not program-scoped (cross-species field tool).
  pastureMap: '/pasture-map',

  // Newsletter admin (admin-only, inside the planner). Exact path; the
  // route-level guard in main.jsx requires admin. Issue selection is component
  // state, not a URL subpath, so this stays a single exact route.
  newsletterAdmin: '/admin/newsletter',

  // Admin (logged-in only)
  webforms: '/admin',
  // Task Center (Tasks v2). Auth-gated, requireAdmin:false. Every
  // logged-in user can reach this; the System Tasks tab self-gates
  // to admins inside the view. Legacy /my-tasks and /admin/tasks
  // are aliases that redirect here (T11) — see ALIASES_EXACT.
  tasks: '/tasks',
  activity: '/activity',
  // Light-user review hub. Kept at the legacy path so old links still land.
  mySubmissions: '/my-submissions',
  // Admin-only runtime observability review surface (self-gated via the
  // list_client_errors admin RPC + requireAdmin route guard).
  clientErrors: '/admin/client-errors',

  // Newsletter — PUBLIC no-login archive. Unlike the report/form hubs below
  // (which are login-required), /newsletter renders in a bypass block ABOVE
  // the LoginScreen gate in main.jsx. /newsletter is the archive; the public
  // app owns its own pathname routing for /newsletter/latest and
  // /newsletter/<slug> (main.jsx maps any /newsletter* to view 'newsletter'),
  // and issue preview is /newsletter/<slug>?preview=<token>.
  newsletter: '/newsletter',

  // Public (no-auth) — these also have legacy aliases handled below.
  webformhub: '/dailys',
  tasksWebform: '/dailys/tasks',
  addfeed: '/addfeed',
  weighins: '/weighins',
  webform: '/webform-pigs', // legacy standalone pig-dailys public form (rare)
  fuelingHub: '/equipment',
  fuelSupply: '/fuel-supply',
};

// Per-entry record pages under the /fleet/* world. Like the Fuel Log and
// per-piece detail sub-routes, EquipmentHome owns these internally — main.jsx
// routes any /fleet/<sub> path to view='equipmentHome' (see PATH_TO_VIEW note
// above), so they are intentionally NOT registered in VIEW_TO_PATH. Adding a
// param path like /fleet/fueling/:id there would break the VIEW_TO_PATH ↔
// PATH_TO_VIEW round-trip (param templates can't round-trip a literal path) and
// snap the user home. They live here as the single source of truth for the
// canonical path shapes so views never hardcode the prefix in more than one
// place. EquipmentHome dispatches /fleet/fueling/<id> → fueling-entry and
// /fleet/checklist/<id> → checklist-entry sub-views.
export const FLEET_ENTRY_ROUTES = {
  fuelingEntry: '/fleet/fueling/:id',
  checklistEntry: '/fleet/checklist/:id',
};

// Build the concrete path for a single fueling / checklist entry record page.
export function fleetFuelingEntryPath(id) {
  return '/fleet/fueling/' + id;
}
export function fleetChecklistEntryPath(id) {
  return '/fleet/checklist/' + id;
}

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

export function resolvePathAlias(pathname) {
  if (!pathname) return null;
  const exactAlias = ALIASES_EXACT[pathname];
  if (exactAlias) return exactAlias;
  for (const [oldPrefix, newPrefix] of ALIASES_PREFIX) {
    if (pathname.startsWith(oldPrefix)) {
      return newPrefix + pathname.slice(oldPrefix.length);
    }
  }
  return null;
}
