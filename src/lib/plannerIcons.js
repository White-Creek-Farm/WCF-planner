// Planner icon registry — single source of truth for the PNG icon set
// served from /icons/planner/. Every consumer references icons via stable
// keys here, NOT direct file paths, so a future asset rename, format swap
// (PNG→WebP), or per-key resolution change touches one file.
//
// Asset pipeline: raw PNGs at C:/Users/Ronni/OneDrive/Desktop/planner pics
// were resized to 256px max + palette-quantized PNG via
// scripts/optimize_planner_icons.cjs. Outputs land at
// public/icons/planner/<key>.png and ship through Vite's public/ pipeline
// (no hash, served at runtime URL /icons/planner/<key>.png).
//
// Browsers can't render <img> inside <option>, so consumers using
// <select><option> dropdowns keep emoji/text labels separate. The emoji
// fallback per category lives on the consumer side (e.g. EQUIPMENT_CATEGORIES
// in src/lib/equipment.js still carries an `icon` emoji string).

const ICON_BASE = '/icons/planner';

// Stable key map. Keep keys kebab-case + ASCII; never reference file paths
// directly outside this module.
export const PLANNER_ICON_KEYS = {
  // Animal programs
  broiler: 'broiler',
  layingHen: 'laying-hen',
  eggs: 'eggs',
  pig: 'pig',
  cow: 'cow',
  sheep: 'sheep',

  // Equipment categories
  tractor: 'tractor',
  atv: 'atv',
  hijet: 'hijet',
  mowers: 'mowers',
  skidsteers: 'skidsteers',
  forestry: 'forestry',
  fueling: 'fueling',

  // Actions
  dailyReports: 'daily-reports',
  pastReports: 'past-reports',
  feed: 'feed',
  checkmark: 'checkmark',
  weighins: 'weighins',

  // Homepage-redesign UI icons (2026-06-08). Raster PNGs optimized to ≤256px
  // palette and shipped at public/icons/planner/<key>.png.
  weather: 'weather',
  wrench: 'wrench',
  admin: 'admin',
  processing: 'processing',
  pastureMap: 'pasture-map',
};

const VALID_KEYS = new Set(Object.values(PLANNER_ICON_KEYS));

/**
 * Resolve a planner-icon key to its public URL path. Returns null when the
 * key is unknown so callers can fall back to a text/emoji label cleanly.
 */
export function plannerIconUrl(key) {
  if (!key) return null;
  if (!VALID_KEYS.has(key)) return null;
  return `${ICON_BASE}/${key}.png`;
}

// Convenience aliases keyed by domain term so call sites stay readable.
//
//   ANIMAL_ICON_KEYS.broiler -> 'broiler' -> /icons/planner/broiler.png
//   EQUIPMENT_CATEGORY_ICON_KEYS.tractors -> 'tractor' -> /icons/planner/tractor.png
//   ACTION_ICON_KEYS.weighins -> 'weighins' -> /icons/planner/weighins.png

// Animal programs use weigh_in_sessions.species values where applicable
// (broiler / pig / cattle / sheep). Layers / eggs are display-only labels.
export const ANIMAL_ICON_KEYS = {
  broiler: PLANNER_ICON_KEYS.broiler,
  layer: PLANNER_ICON_KEYS.layingHen,
  egg: PLANNER_ICON_KEYS.eggs,
  pig: PLANNER_ICON_KEYS.pig,
  cattle: PLANNER_ICON_KEYS.cow,
  sheep: PLANNER_ICON_KEYS.sheep,
};

// EQUIPMENT_CATEGORIES.key -> icon key.
export const EQUIPMENT_CATEGORY_ICON_KEYS = {
  tractors: PLANNER_ICON_KEYS.tractor,
  atvs: PLANNER_ICON_KEYS.atv,
  hijets: PLANNER_ICON_KEYS.hijet,
  mowers: PLANNER_ICON_KEYS.mowers,
  skidsteers: PLANNER_ICON_KEYS.skidsteers,
  forestry: PLANNER_ICON_KEYS.forestry,
};

export const ACTION_ICON_KEYS = {
  dailyReports: PLANNER_ICON_KEYS.dailyReports,
  pastReports: PLANNER_ICON_KEYS.pastReports,
  feed: PLANNER_ICON_KEYS.feed,
  tasks: PLANNER_ICON_KEYS.checkmark,
  fueling: PLANNER_ICON_KEYS.fueling,
  weighins: PLANNER_ICON_KEYS.weighins,
};
