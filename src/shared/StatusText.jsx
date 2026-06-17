// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// ============================================================================
// StatusText — inline colored-ink status · CP0 §A4 / §A6
// ----------------------------------------------------------------------------
// The single biggest de-badging lever: for soft, in-row signals (an overdue
// date in danger ink, a positive ADG in ok ink, a "low" count in warn ink),
// prefer colored TEXT over a pill. Reserve <Badge> for true lifecycle state.
//
//   tone ∈ { ok, warn, danger, info, muted }   (default: muted)
//
// Colors come from the ratified semantic tokens (:root). `muted` is the
// supporting gray for non-signal secondary text.
// ============================================================================

const TONES = {
  ok: 'var(--ok-ink)',
  warn: 'var(--warn-ink)',
  danger: 'var(--danger)',
  info: 'var(--info)',
  muted: 'var(--text-secondary)',
};

export default function StatusText({tone = 'muted', children, title, style}) {
  const color = TONES[tone] || TONES.muted;
  return (
    <span data-status-text={tone} title={title} style={{color, fontWeight: 600, ...style}}>
      {children}
    </span>
  );
}

export const STATUS_TONES = Object.keys(TONES);
