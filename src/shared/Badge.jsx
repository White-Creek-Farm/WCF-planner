// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// ============================================================================
// Badge — canonical status badge with a CLOSED variant set · CP0 §A4
// ----------------------------------------------------------------------------
// Replaces the free-color `S.badge(bg, tx)` factory (the mechanism behind
// "badge soup"). A badge means STATUS, never decoration. One per row/line, max.
// For soft signals (overdue date, positive ADG, "low") prefer <StatusText>
// (colored ink) over a badge.
//
//   variant ∈ { ok, warn, danger, info, neutral }
//
// Colors come from the ratified semantic tokens (:root) so the palette is
// uniform and contrast-safe. `neutral` is for lifecycle labels (Draft, Active).
//
// NOTE: program/species color is NOT a badge — it's a dot/accent. Use
// programDotStyle() from src/lib/programColors.js for that.
// ============================================================================

const VARIANTS = {
  ok: {bg: 'var(--ok-soft)', fg: 'var(--ok-ink)'},
  warn: {bg: 'var(--warn-soft)', fg: 'var(--warn-ink)'},
  danger: {bg: 'var(--danger-soft)', fg: 'var(--danger)'},
  info: {bg: 'var(--info-soft)', fg: 'var(--info)'},
  neutral: {bg: 'var(--surface-2)', fg: 'var(--text-secondary)'},
};

export default function Badge({variant = 'neutral', children, title, style}) {
  const palette = VARIANTS[variant] || VARIANTS.neutral;
  return (
    <span
      data-badge={variant}
      title={title}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        background: palette.bg,
        color: palette.fg,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export const BADGE_VARIANTS = Object.keys(VARIANTS);
