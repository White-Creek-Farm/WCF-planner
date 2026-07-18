// Shared PROJECTED roster table for planned cattle batches. Rendered by the
// cattle batch record page (scheduled status), the forecast-only batch
// detail page, and referenced conceptually by the Processing Drawer's cattle
// Source details — every surface feeds it (or mirrors it) from the canonical
// projectPlannedRoster adapter in src/lib/cattleForecast.js so tags, per-cow
// weights, and totals can never disagree between surfaces.
//
// When `processDate` is provided (a persisted batch's EXACT
// planned_process_date), an "Age at processing" column renders via the
// shared formatAgeAtDate helper — the same helper the Processing Drawer
// uses, so the two surfaces always show identical ages. The forecast-only
// detail page has no exact date (stable monthKey only) and passes none, so
// it keeps the two-column layout; ages are never derived from a bare month.
//
// The weights here are LIVE FORECAST projections, not measurements. The
// table always carries the Projected labeling; callers must not render it
// for batches whose actual cows_detail has been attached.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import {formatAgeAtDate} from '../lib/cattleForecast.js';

export default function ProjectedRosterTable({roster, processDate}) {
  const rows = (roster && roster.rows) || [];
  const showAge = !!processDate;
  if (rows.length === 0) {
    return (
      <div
        data-projected-roster-empty="1"
        style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', padding: '4px 0'}}
      >
        No cattle currently project into this month — the cohort is empty until the forecast lands cattle here.
      </div>
    );
  }
  return (
    <div data-projected-roster={rows.length} style={{overflowX: 'auto'}}>
      <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12}}>
        <thead>
          <tr>
            <th style={thS}>Tag</th>
            {showAge && <th style={thS}>Age at processing</th>}
            <th style={{...thS, textAlign: 'right'}}>Projected live weight</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cattleId} data-projected-roster-row={r.cattleId}>
              <td style={tdS}>{r.tag ? '#' + r.tag : r.cattleId}</td>
              {showAge && (
                <td
                  data-projected-roster-age={r.cattleId}
                  style={{...tdS, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'}}
                >
                  {formatAgeAtDate(r.birthDate, processDate) || 'Not recorded'}
                </td>
              )}
              <td style={{...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums'}}>
                {Math.round(r.projectedWeight).toLocaleString()} lb
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={showAge ? 2 : 1} style={{...tdS, fontWeight: 700, color: 'var(--ink)'}}>
              {roster.count} {roster.count === 1 ? 'cow' : 'cows'} projected
            </td>
            <td
              data-projected-roster-total={Math.round(roster.projectedTotalLbs)}
              style={{
                ...tdS,
                textAlign: 'right',
                fontWeight: 700,
                color: 'var(--ink)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {Math.round(roster.projectedTotalLbs).toLocaleString()} lb projected
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const thS = {
  textAlign: 'left',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--ink-muted)',
  padding: '4px 6px',
  borderBottom: '1px solid var(--divider)',
};
const tdS = {
  padding: '5px 6px',
  borderBottom: '1px solid var(--divider)',
  color: 'var(--ink)',
};
