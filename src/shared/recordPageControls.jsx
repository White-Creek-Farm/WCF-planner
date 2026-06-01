// Generic record-page form controls + layout primitives. The daily-report
// hotfix established this as the reusable site-wide standard: a consistent
// label/value grid, predictable control widths, aligned boolean controls,
// roomy textareas, a responsive (stacks on mobile) field row, and the
// roster-backed Team Member dropdown.
//
// FUTURE CONSUMERS (migrate onto these in a dedicated "record page visual
// consistency" lane — do NOT refactor them here): task instance, weigh-in
// session, cattle/sheep animal, cattle/sheep/layer processing batch, layer
// batch + housing, equipment item, and future equipment fueling / checklist
// record pages. The six daily record pages are the first consumers.

import React from 'react';
import {loadRoster, activeNames} from '../lib/teamMembers.js';

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

// Roster-backed Team Member dropdown. Loads the team roster and renders the
// active names. The currently-saved value is preserved: if it is not in the
// active roster it is offered as a selectable historical option labeled
// "<name> (not in roster)" so an editor can keep the original submitter. It
// does NOT allow arbitrary new names to be typed, and never auto-stamps the
// logged-in user — team_member stays the existing display-name string.
export function TeamMemberSelect({sb, value, onChange, style}) {
  const [names, setNames] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const roster = await loadRoster(sb);
        if (!cancelled) setNames(activeNames(roster));
      } catch {
        if (!cancelled) setNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb]);

  const v = value || '';
  const isHistorical = v !== '' && !names.includes(v);
  return (
    <select
      data-team-member-select="1"
      value={v}
      onChange={(e) => onChange(e.target.value)}
      style={style || recordControl}
    >
      <option value="">— Select team member —</option>
      {names.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
      {isHistorical && (
        <option key={v} value={v}>
          {v} (not in roster)
        </option>
      )}
    </select>
  );
}
