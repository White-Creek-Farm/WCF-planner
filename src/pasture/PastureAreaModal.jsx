// ============================================================================
// PastureAreaModal — Pasture Map "Area modal"
// ----------------------------------------------------------------------------
// Accessible centered modal that hosts ALL per-area editing (classification,
// parent pasture, line style, record/plan move, redraw/archive/restore, and the
// admin hard-delete). It replaces the old side-panel "Plan area inspector": a
// click/tap on a map area opens this dialog over the map; the desktop hover
// readout is independent and stays.
//
// Follows the shared modal contract (see ConfirmModal/DeleteModal): role=dialog,
// aria-modal, labelled title, Escape close + focus trap/return focus via
// useModalFocusTrap, a dark backdrop, and a zIndex above the map. The view owns
// close behavior so the single visible X can save/debounce before dismissing.
// ============================================================================
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import {useModalFocusTrap} from '../shared/useModalFocusTrap.js';

export default function PastureAreaModal({areaId, title, subtitle, onClose, closeDisabled = false, children}) {
  const {dialogRef, handleDialogKeyDown} = useModalFocusTrap({onCancel: onClose});
  return (
    <div
      className="pm-modal-backdrop"
      data-pasture-area-modal-backdrop="1"
      data-overlay-dismiss="disabled"
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
        ref={dialogRef}
        className="pm-modal-dialog"
        data-pasture-area-modal={areaId}
        data-focus-trap="active"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pasture-area-modal-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          handleDialogKeyDown(e);
          if (e.key === 'Escape') e.stopPropagation();
        }}
        style={{
          background: 'var(--surface, #fff)',
          borderRadius: 12,
          maxWidth: 520,
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,.25)',
        }}
      >
        <div className="pm-modal-head">
          <div className="pm-modal-head-text">
            <h2 id="pasture-area-modal-title" className="pm-modal-title">
              {title || 'Area'}
            </h2>
            {subtitle ? <span className="pm-modal-subtitle">{subtitle}</span> : null}
          </div>
          <button
            type="button"
            className="pm-modal-close"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Save and close area editor"
            title="Save and close"
            data-pasture-area-modal-close="1"
          >
            ✕
          </button>
        </div>
        <div className="pm-modal-body">{children}</div>
      </div>
    </div>
  );
}
