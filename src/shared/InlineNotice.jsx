// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

// ============================================================================
// InlineNotice — small inline error/warning banner used in place of alert()
// ============================================================================
// Drop in next to a form action area (inside a modal) or above a list view
// (after a filter row). Renders nothing when `notice` is null. Caller owns
// the state so the same notice object can be rendered in two places (e.g.
// inside an open modal AND on the list view behind it) and dismissed once.
//
// Shape:
//   notice = { kind: 'error' | 'warning' | 'success' | 'info', message: string } | null
//
// `kind` defaults to 'error'. Multi-line messages are honored via
// white-space: pre-line on the body text. The 'success' kind uses a
// green palette and is intended for short confirmation messages where
// a banner is more visible than relying on state to re-render
// (e.g. an admin "Synced" confirmation). The 'info' kind uses a blue
// palette for benign, non-error notices (e.g. "No changes to save.") so
// they do not render with alarming error styling.
// ============================================================================

export default function InlineNotice({notice, onDismiss}) {
  if (!notice || !notice.message) return null;
  let kind;
  if (notice.kind === 'warning') kind = 'warning';
  else if (notice.kind === 'success') kind = 'success';
  else if (notice.kind === 'info') kind = 'info';
  else kind = 'error';
  const palette =
    kind === 'warning'
      ? {bg: '#fef3c7', border: '#fde68a', fg: '#92400e'}
      : kind === 'success'
        ? {bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46'}
        : kind === 'info'
          ? {bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af'}
          : {bg: '#fee2e2', border: '#fecaca', fg: '#b91c1c'};
  return (
    <div
      role="alert"
      data-inline-notice={kind}
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.fg,
        borderRadius: 8,
        padding: '8px 12px',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <div style={{flex: 1, whiteSpace: 'pre-line', minWidth: 0, wordBreak: 'break-word'}}>{notice.message}</div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notice"
          style={{
            background: 'none',
            border: 'none',
            color: palette.fg,
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
            marginTop: 2,
            fontFamily: 'inherit',
          }}
        >
          {'×'}
        </button>
      )}
    </div>
  );
}
