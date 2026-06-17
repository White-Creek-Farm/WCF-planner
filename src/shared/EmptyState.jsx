// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// ============================================================================
// EmptyState — restrained "loaded, zero rows" state · CP0 §A9
// ----------------------------------------------------------------------------
// Centered, calm, one line of supporting-gray text + an optional single ghost
// action. MUST only render when the load succeeded — callers gate it behind
// `!loadError` (never show an empty state over a failed load; that's an
// InlineNotice + Retry, per the locked fail-closed contract).
// ============================================================================

export default function EmptyState({message = 'Nothing here yet.', action}) {
  return (
    <div
      data-empty-state="1"
      style={{
        display: 'grid',
        placeItems: 'center',
        gap: 12,
        minHeight: 160,
        padding: 24,
        textAlign: 'center',
        color: 'var(--text-secondary)',
        fontSize: 13,
      }}
    >
      <div style={{maxWidth: 420, lineHeight: 1.5}}>{message}</div>
      {action && action.label && (
        <button
          type="button"
          data-empty-state-action="1"
          onClick={action.onClick}
          style={{
            padding: '10px 16px',
            borderRadius: 10,
            border: '1px solid var(--border-strong)',
            background: 'white',
            color: 'var(--text-secondary)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
