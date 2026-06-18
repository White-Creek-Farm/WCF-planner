// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';

// ============================================================================
// Tabs — canonical IN-PAGE tab strip · CP0 §A5 / Tab decision
// ----------------------------------------------------------------------------
// Filled pill, program-colored when selected (no border when unselected) — the
// pig-redesign style, app-wide. Owns IN-PAGE tabs (Production, etc.). The dark
// header sub-nav stays its OWN owner (Header.jsx) and is NOT replaced by this.
//
//   tabs: [{ key, label, program? }]
//   active: key
//   onChange: (key) => void
//   program: optional default program accent for the whole strip (e.g. 'cattle')
//
// Selected pill = solid program color with auto-contrast text (getReadableText).
// Non-program tabs fall back to the brand green. Radius = 10px floor (A3).
// ============================================================================

function pillStyle(selected, program) {
  const fill = program ? getProgramColor(program) : '#085041';
  return {
    padding: '8px 16px',
    borderRadius: 999,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: selected ? 700 : 500,
    whiteSpace: 'nowrap',
    background: selected ? fill : 'transparent',
    color: selected ? getReadableText(fill) : 'var(--text-secondary)',
    transition: 'background .14s, color .14s',
  };
}

export default function Tabs({tabs = [], active, onChange, program}) {
  return (
    <div
      data-tabs="1"
      role="tablist"
      style={{display: 'inline-flex', gap: 2, padding: 3, background: 'var(--surface-2)', borderRadius: 12}}
    >
      {tabs.filter(Boolean).map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected ? 'true' : 'false'}
            data-tab-active={selected ? '1' : undefined}
            onClick={() => onChange && onChange(t.key)}
            style={pillStyle(selected, t.program || program)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
