// ============================================================================
// programColors.js — canonical program (species) accent palette · CP0 §A12
// ----------------------------------------------------------------------------
// ONE source of truth for program identity color. Ratified 2026-06-16; these
// SUPERSEDE both prior systems — the Home island `--c-*` OKLCH dots and the
// legacy inline `kindColors`/`kindBg` pairs. As surfaces are touched (CP1→CP5)
// they migrate onto this module; do not reintroduce the old values.
//
// Treatment rules (A12):
//   • Program color appears ONLY as a solid dot or a solid SELECTED pill
//     (nav / tabs), and optionally one headline figure. Never a full-page
//     theme, card background, body text, or a status color.
//   • Program ≠ semantic by TREATMENT, not just hue: program = solid dot/pill;
//     semantic status = soft-bg badge or short ink text. That separation keeps
//     pig-blue from reading as `info` and cattle-brick from reading as `danger`.
//   • Selected pill text color comes from getReadableText() so it auto-picks
//     black on the light hues (broiler/layer/sheep) and white on pig/cattle/
//     gray — no contrast failures.
//
// Hues were tuned for distinctness to dodge two collisions:
//   • sheep green vs the forest brand green (#085041) AND the sea-green `ok`.
//   • broiler yellow vs layer orange at 9–12px dot size.
// ============================================================================
import {getReadableText} from './styles.js';

// Canonical hexes. Keyed by the stable program/species string used across the
// app (matches the daily `kind` strings: broiler/layer/pig/cattle/sheep).
export const PROGRAM_COLORS = {
  pig: '#2B4C9B', // royal/navy blue — deeper than the azure `info` semantic
  broiler: '#C7920A', // gold/mustard — clearly yellow
  layer: '#D2601A', // burnt orange — darker + redder than broiler
  cattle: '#8E3328', // deep brick red — darker than the bright `danger` red
  sheep: '#4CA035', // grass green — brighter/cooler than brand green AND `ok`
  equipment: '#6B7280', // slate gray
};

// Aliases for call sites that use a different label for the same accent.
const PROGRAM_ALIASES = {
  broilers: 'broiler',
  layers: 'layer',
  pigs: 'pig',
  sheeps: 'sheep',
  admin: 'equipment',
  equip: 'equipment',
  egg: 'layer', // eggs ride the layer accent
};

// Neutral fallback for an unknown program — the slate gray, never a guess.
export const PROGRAM_FALLBACK = PROGRAM_COLORS.equipment;

/** Resolve a program/species key (or alias) to its canonical accent hex. */
export function getProgramColor(key) {
  if (!key) return PROGRAM_FALLBACK;
  const k = String(key).toLowerCase();
  if (PROGRAM_COLORS[k]) return PROGRAM_COLORS[k];
  const aliased = PROGRAM_ALIASES[k];
  return (aliased && PROGRAM_COLORS[aliased]) || PROGRAM_FALLBACK;
}

/**
 * Inline style for a solid program dot (the in-list species marker).
 * Default 9px — the small-list dot size; pass `size` to scale.
 */
export function programDotStyle(key, size = 9) {
  return {
    display: 'inline-block',
    width: size,
    height: size,
    flex: `0 0 ${size}px`,
    borderRadius: '50%',
    background: getProgramColor(key),
  };
}

/**
 * Inline style for a tab/nav pill. Unselected = transparent, no border (A12 /
 * Tab decision). Selected = solid program fill with auto-contrast text.
 * `radius` defaults to the 10px floor (CP0 §A3).
 */
export function programPillStyle(key, selected, {radius = 999} = {}) {
  const fill = getProgramColor(key);
  return {
    padding: '7px 16px',
    borderRadius: radius,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: selected ? 700 : 500,
    whiteSpace: 'nowrap',
    background: selected ? fill : 'transparent',
    color: selected ? getReadableText(fill) : 'var(--text-secondary)',
  };
}
