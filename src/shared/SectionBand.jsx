// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// ============================================================================
// SectionBand — in-table section splitter · CP0 §A6
// ----------------------------------------------------------------------------
// A full-width band row that splits sections INSIDE one table (e.g. Active /
// Complete) — NOT separate cards. Small uppercase supporting-gray label + an
// optional count.
//
// Two render modes so it works inside a real <table> or a flex/div list:
//   • as="tr"  (default) → a single full-width <td colSpan={span}> band row.
//   • as="div"           → a standalone band div for non-table lists.
// ============================================================================

const labelStyle = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-secondary)',
};

const countStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text-muted)',
  fontVariantNumeric: 'tabular-nums',
};

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function Inner({label, count}) {
  return (
    <span style={{display: 'inline-flex', alignItems: 'baseline', gap: 8}}>
      <span style={labelStyle}>{label}</span>
      {count != null && <span style={countStyle}>{count}</span>}
    </span>
  );
}

export default function SectionBand({label, count, as = 'tr', span = 1}) {
  if (as === 'div') {
    return (
      <div
        data-section-band="1"
        style={{
          padding: '10px 14px',
          background: 'var(--surface-2)',
          borderTop: '1px solid var(--divider)',
          borderBottom: '1px solid var(--divider)',
        }}
      >
        <Inner label={label} count={count} />
      </div>
    );
  }
  return (
    <tr data-section-band="1">
      <td
        colSpan={span}
        style={{
          padding: '10px 14px',
          background: 'var(--surface-2)',
          borderTop: '1px solid var(--divider)',
          borderBottom: '1px solid var(--divider)',
        }}
      >
        <Inner label={label} count={count} />
      </td>
    </tr>
  );
}
