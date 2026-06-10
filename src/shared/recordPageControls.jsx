// Generic record-page form controls + layout primitives. The daily-report
// hotfix established this as the reusable site-wide standard: a consistent
// label/value grid, predictable control widths, aligned boolean controls,
// roomy textareas, and a responsive (stacks on mobile) field row.
//
// Consumers should use these instead of local record-form primitives when a
// surface has a standard label/value edit form. Dense scan-first panels can
// stay local when a guard documents the exception.

import React from 'react';

// ── Responsive field-row grid ───────────────────────────────────────────────
// Desktop: a [label | control] grid with a fixed label column so every row's
// control edge lines up. Mobile (<=640px): stacks the label above a full-width
// control so selects/textareas use the whole card width instead of a cramped
// right column. Injected once as a real CSS class so the media query works
// (inline styles can't carry @media). Consumers apply `recordFieldRowClass`.
const FIELD_ROW_CLASS = 'wcf-record-field-row';
if (typeof document !== 'undefined' && !document.getElementById('wcf-record-controls-css')) {
  const el = document.createElement('style');
  el.id = 'wcf-record-controls-css';
  el.textContent =
    '.' +
    FIELD_ROW_CLASS +
    '{display:grid;grid-template-columns:170px minmax(0,1fr);align-items:center;' +
    'column-gap:16px;padding:8px 0;border-bottom:1px solid #f3f4f6;font-size:14px;}' +
    '@media (max-width:640px){.' +
    FIELD_ROW_CLASS +
    '{grid-template-columns:1fr;align-items:start;row-gap:4px;}}';
  document.head.appendChild(el);
}
export const recordFieldRowClass = FIELD_ROW_CLASS;

// Style-object equivalent of the desktop grid, for the rare caller that must
// spread it inline (e.g. a computed/read-only row that tweaks the background).
export const recordFieldRow = {
  display: 'grid',
  gridTemplateColumns: '170px minmax(0, 1fr)',
  alignItems: 'center',
  columnGap: 16,
  padding: '8px 0',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 14,
};

// White form card wrapping the editable fields.
export const recordFormCard = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: '16px 20px',
};

export const recordFieldLabel = {fontWeight: 600, color: '#4b5563', fontSize: 13};

// Predictable control width: fills the value column up to a sane cap.
export const recordControl = {
  fontSize: 14,
  padding: '7px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  width: '100%',
  maxWidth: 340,
  boxSizing: 'border-box',
};

// Textareas use the full value-column width and a practical min-height.
export const recordTextarea = {
  ...recordControl,
  maxWidth: '100%',
  minHeight: 96,
  resize: 'vertical',
  lineHeight: 1.4,
};

// Checkbox sized + left-aligned in the value column.
export const recordCheckbox = {width: 18, height: 18, cursor: 'pointer'};

// ── Record-page action buttons ──────────────────────────────────────────────
// Canonical action buttons for the record-page form footer (Save / Revert), the
// load-error Retry, and the Delete action. Tokens follow the Design System:
// radius 6 (the retired 7/8 values are gone), the standard 10px 16px button pad,
// and the canonical font-size scale. Call sites keep their own data hooks,
// disabled logic, labels, and any layout-only override (e.g. marginTop) via a
// spread.
const recordActionButtonBase = {
  padding: '10px 16px',
  borderRadius: 6,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

// Primary save (brand green).
export const recordSaveButton = {
  ...recordActionButtonBase,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
};

// Neutral/ghost action: form Revert and the load-error Retry.
export const recordSecondaryButton = {
  ...recordActionButtonBase,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
};

// Destructive: Delete report.
export const recordDeleteButton = {
  ...recordActionButtonBase,
  border: '1px solid #fca5a5',
  background: '#fef2f2',
  color: '#b91c1c',
};

// RecordPageBody maxWidth convention: form-centric record pages (mostly
// label/value fields, like the daily pages) use RECORD_FORM_MAXWIDTH for a
// consistent comfortable column. Dense stats / grid pages (e.g. layer batch
// lifecycle, broiler batch) may stay wider. A page whose RecordPageBody also
// wraps heavy stats/weight grids tuned to a narrower width should keep that
// width until those panels are migrated too — don't widen the whole page just
// to migrate a contained form card.
export const RECORD_FORM_MAXWIDTH = 960;

const lockedTeamMemberBox = {
  ...recordControl,
  background: '#f9fafb',
  borderColor: '#e5e7eb',
  color: '#374151',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};

export function LockedTeamMemberField({value, label = null, labelStyle, style, caption = 'signed in'}) {
  const display = value || 'Signed-in user';
  return (
    <div>
      {label != null && <label style={labelStyle}>{label}</label>}
      <div
        data-team-member-select="1"
        data-team-member-select-locked="1"
        style={style ? {...lockedTeamMemberBox, ...style} : lockedTeamMemberBox}
      >
        <span style={{fontWeight: 600}}>{display}</span>
        {caption ? <span style={{fontSize: 11, color: '#9ca3af'}}>{caption}</span> : null}
      </div>
    </div>
  );
}
