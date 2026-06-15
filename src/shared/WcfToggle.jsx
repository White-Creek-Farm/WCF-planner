// ============================================================================
// WcfToggle — Phase 2.1.1
// ============================================================================
// N-option horizontal segmented-control toggle with deselect-on-second-click.
// Verbatim extraction from main.jsx. Used by AdminAddReportModal and public
// webforms for feed-type selection (STARTER / GROWER / LAYER).
// ============================================================================
import React from 'react';

const WcfToggle = ({opts, val, onChange}) => (
  <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-strong)'}}>
    {opts.map((o, i) => (
      <React.Fragment key={o}>
        {i > 0 && <div style={{width: 1, background: 'var(--border-strong)', flexShrink: 0}} />}
        <button
          type="button"
          onClick={() => onChange(val === o ? '' : o)}
          style={{
            flex: 1,
            padding: '10px 0',
            border: 'none',
            fontFamily: 'inherit',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
            background: val === o ? '#085041' : 'white',
            color: val === o ? 'white' : 'var(--ink-muted)',
          }}
        >
          {o}
        </button>
      </React.Fragment>
    ))}
  </div>
);

export default WcfToggle;
