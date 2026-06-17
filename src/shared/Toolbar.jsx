import React from 'react';

// ============================================================================
// Toolbar — canonical page action bar · CP0 §A5
// ----------------------------------------------------------------------------
// One grouped bar per view: title + optional count, EXACTLY ONE primary action,
// supporting secondary actions, and an overflow `⋯` for the rest. Replaces the
// scattered button sprawl the audit flagged (cattle-herds 39 btns, etc.).
//
// Action shape: { label, onClick, disabled?, tone? }  tone: 'primary'|'default'|'danger'
//   props: { title?, count?, primaryAction?, secondaryActions?[], overflowActions?[] }
//
// Buttons use the ratified 10px radius (CP0 §A3) and the button ladder (§A5):
// primary = solid brand green / white; default = white / gray / border;
// danger = white / red ink.
// ============================================================================

function btnStyle(tone) {
  const base = {
    padding: '10px 16px',
    borderRadius: 10,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  if (tone === 'primary') return {...base, border: 'none', background: '#085041', color: 'white'};
  if (tone === 'danger') return {...base, border: '1px solid #F09595', background: 'white', color: '#b91c1c'};
  return {...base, border: '1px solid var(--border-strong)', background: 'white', color: 'var(--text-secondary)'};
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function ActionButton({action, tone}) {
  if (!action || !action.label) return null;
  return (
    <button type="button" onClick={action.onClick} disabled={action.disabled} style={btnStyle(action.tone || tone)}>
      {action.label}
    </button>
  );
}

export default function Toolbar({title, count, primaryAction, secondaryActions = [], overflowActions = []}) {
  const [overflowOpen, setOverflowOpen] = React.useState(false);
  return (
    <div
      data-toolbar="1"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        marginBottom: 14,
      }}
    >
      {title != null && (
        <div style={{display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0}}>
          <span style={{fontSize: 16, fontWeight: 700, color: '#000'}}>{title}</span>
          {count != null && (
            <span
              style={{fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums'}}
            >
              {count}
            </span>
          )}
        </div>
      )}
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexWrap: 'wrap'}}>
        {secondaryActions.filter(Boolean).map((a, i) => (
          <ActionButton key={a.key || a.label || i} action={a} tone="default" />
        ))}
        <ActionButton action={primaryAction} tone="primary" />
        {overflowActions.filter(Boolean).length > 0 && (
          <div style={{position: 'relative'}}>
            <button
              type="button"
              aria-label="More actions"
              aria-expanded={overflowOpen ? 'true' : 'false'}
              onClick={() => setOverflowOpen((o) => !o)}
              style={{...btnStyle('default'), padding: '10px 12px'}}
            >
              {'⋯'}
            </button>
            {overflowOpen && (
              <>
                <div onClick={() => setOverflowOpen(false)} style={{position: 'fixed', inset: 0, zIndex: 199}} />
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '110%',
                    background: 'white',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,.15)',
                    zIndex: 200,
                    minWidth: 180,
                    overflow: 'hidden',
                  }}
                >
                  {overflowActions.filter(Boolean).map((a, i) => (
                    <button
                      key={a.key || a.label || i}
                      type="button"
                      onClick={() => {
                        setOverflowOpen(false);
                        a.onClick && a.onClick();
                      }}
                      disabled={a.disabled}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '10px 16px',
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontFamily: 'inherit',
                        color: a.tone === 'danger' ? '#b91c1c' : '#000',
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
