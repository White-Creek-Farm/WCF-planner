// ============================================================================
// DeleteModal — Phase 2.1.2
// ============================================================================
// Type-"delete"-to-confirm destructive-action confirmation modal. Verbatim
// extraction from main.jsx. Rendered via the BatchesContext-owned
// `deleteConfirm` state — App holds the element, Header/feature views trigger
// it via `setDeleteConfirm({message, onConfirm})`.
// ============================================================================
import React from 'react';
import {useModalFocusTrap} from './useModalFocusTrap.js';

const DeleteModal = ({msg, onConfirm, onCancel}) => {
  const [typed, setTyped] = React.useState('');
  const ready = typed.trim().toLowerCase() === 'delete';
  const {dialogRef, handleDialogKeyDown} = useModalFocusTrap({onCancel});
  const confirmAndClose = () => {
    onConfirm();
    onCancel();
  };

  return (
    <div
      data-delete-modal="1"
      data-overlay-dismiss="disabled"
      data-focus-trap="active"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-modal-title"
      aria-describedby="delete-modal-message"
      tabIndex={-1}
      onKeyDown={handleDialogKeyDown}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,.55)',
        zIndex: 11000,
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
        <div style={{fontSize: 20, marginBottom: 8}}>⚠️</div>
        <div id="delete-modal-title" style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 8}}>
          Are you sure?
        </div>
        <div id="delete-modal-message" style={{fontSize: 13, color: 'var(--ink-muted)', marginBottom: 16}}>
          {msg}
        </div>
        <div style={{fontSize: 12, color: 'var(--ink-muted)', marginBottom: 6}}>
          Type <strong>delete</strong> to confirm:
        </div>
        <input
          autoFocus
          data-modal-initial-focus="1"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) {
              confirmAndClose();
            }
          }}
          aria-label="Type delete to confirm"
          placeholder="delete"
          style={{
            width: '100%',
            padding: '8px 12px',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            fontSize: 13,
            fontFamily: 'inherit',
            marginBottom: 16,
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            onClick={onCancel}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            disabled={!ready}
            onClick={confirmAndClose}
            style={{
              padding: '10px 16px',
              borderRadius: 6,
              border: 'none',
              background: ready ? '#b91c1c' : '#f3f4f6',
              color: ready ? 'white' : '#9ca3af',
              fontSize: 13,
              fontWeight: 600,
              cursor: ready ? 'pointer' : 'default',
              fontFamily: 'inherit',
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteModal;
