// ActivityModal — thin modal wrapper around <ActivityPanel mode="full">.
//
// Compact chips on dense list rows (TaskRow, future CowRow, etc.) open
// this modal when clicked. Keeps the panel layout-agnostic — the panel
// itself doesn't know about modals; the caller picks the surface.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from './ActivityPanel.jsx';

const OVERLAY = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  zIndex: 252,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
};
const PANEL = {
  background: 'white',
  borderRadius: 12,
  padding: 14,
  width: 'min(540px, 96vw)',
  maxHeight: '92vh',
  overflowY: 'auto',
  fontFamily: 'inherit',
};
const HEADER = {display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10};
const BTN_GHOST = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
};

export default function ActivityModal({sb, authState, target, onClose}) {
  if (!target) return null;
  const {entityType, entityId, entityLabel, entityCtx} = target;
  function close() {
    if (onClose) onClose();
  }
  return (
    <div data-activity-modal="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={HEADER}>
          <h2 style={{fontSize: 16, margin: 0, color: '#111827'}}>{entityLabel || entityId}</h2>
          <button type="button" data-activity-modal-close="1" onClick={close} style={BTN_GHOST}>
            Close
          </button>
        </div>
        <ActivityPanel
          sb={sb}
          authState={authState}
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
          entityCtx={entityCtx}
          mode="full"
        />
      </div>
    </div>
  );
}
