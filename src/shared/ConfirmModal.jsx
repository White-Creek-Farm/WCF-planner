// Non-destructive Confirm / Cancel modal. Parallels DeleteModal but without
// the "type delete" gate, for side-effect actions that aren't true deletes
// (password reset, deactivate user, mark batch processed, retire housing).
// Rendered via the App-level `confirmAction` state — App holds the element,
// feature views trigger it via `window._wcfConfirm(message, onConfirm, label?)`.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';

const ConfirmModal = ({msg, confirmLabel, onConfirm, onCancel}) => {
  const label = confirmLabel || 'Confirm';
  const confirmAndClose = () => {
    onConfirm();
    onCancel();
  };

  return (
    <div
      data-confirm-modal="1"
      data-overlay-dismiss="disabled"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      aria-describedby="confirm-modal-message"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.55)',
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 10,
          padding: '24px 28px',
          maxWidth: 420,
          width: '100%',
          boxShadow: '0 8px 32px rgba(0,0,0,.25)',
        }}
      >
        <div style={{fontSize: 20, marginBottom: 8}}>❓</div>
        <div id="confirm-modal-title" style={{fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 8}}>
          Confirm action
        </div>
        <div
          id="confirm-modal-message"
          style={{fontSize: 13, color: '#4b5563', marginBottom: 18, whiteSpace: 'pre-line'}}
        >
          {msg}
        </div>
        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            autoFocus
            onClick={confirmAndClose}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              border: 'none',
              background: '#1d4ed8',
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConfirmModal;
