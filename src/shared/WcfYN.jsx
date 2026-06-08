// ============================================================================
// WcfYN — Phase 2.1.1
// ============================================================================
// Two-button Yes/No toggle. Verbatim extraction from main.jsx (pre-migration
// index.html line ~9050). Used by AdminAddReportModal and public webforms.
// ============================================================================
import React from 'react';

const WcfYN = ({val, onChange}) => (
  <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
    {[
      {v: true, l: 'Yes'},
      {v: false, l: 'No'},
    ].map(({v, l}) => (
      <button
        key={l}
        type="button"
        onClick={() => onChange(v)}
        style={{
          flex: 1,
          padding: '10px 0',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 13,
          fontWeight: 500,
          cursor: 'pointer',
          background: val === v ? (v ? '#085041' : '#374151') : 'white',
          color: val === v ? 'white' : '#6b7280',
        }}
      >
        {l}
      </button>
    ))}
  </div>
);

export default WcfYN;
