// ============================================================================
// PastureGroupHistoryModal — one animal group's full move history
// ----------------------------------------------------------------------------
// Accessible centered modal opened from an Animal Groups pill (Map side panel).
// Shows the group's complete move ledger (list_pasture_history_report, filtered
// by animalType + groupKey): each move's in/out area, moved date, head count,
// and notes, newest first.
//
// Follows the same shared modal contract as PastureAreaModal (role=dialog,
// aria-modal, labelled title, Escape close + focus trap/return focus via
// useModalFocusTrap, dark backdrop above the map, backdrop-click close). Pure
// presentational: the view owns the data fetch and passes rows/loading/error.
// ============================================================================
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import {useModalFocusTrap} from '../shared/useModalFocusTrap.js';

function areaLabel(id, name) {
  if (!id) return 'Not placed';
  return name || 'Unnamed area';
}

export default function PastureGroupHistoryModal({group, rows, loading, error, formatMoveTime, onClose}) {
  const {dialogRef, handleDialogKeyDown} = useModalFocusTrap({onCancel: onClose});
  const history = rows || [];
  return (
    <div
      className="pm-modal-backdrop"
      data-pasture-group-history-backdrop="1"
      data-overlay-dismiss="enabled"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
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
        data-pasture-group-history-modal={group ? group.id : ''}
        data-focus-trap="active"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pasture-group-history-title"
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
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
            <h2 id="pasture-group-history-title" className="pm-modal-title">
              {group ? group.name : 'Group'} — move history
            </h2>
            {group ? <span className="pm-modal-subtitle">{group.size}</span> : null}
          </div>
          <button
            type="button"
            className="pm-modal-close"
            onClick={onClose}
            aria-label="Close group history"
            title="Close (Esc)"
            data-pasture-group-history-close="1"
          >
            ✕
          </button>
        </div>
        <div className="pm-modal-body">
          {loading ? (
            <div className="pm-report-empty">Loading move history…</div>
          ) : error ? (
            <div className="pm-report-empty" data-pasture-group-history-error="1">
              {error}
            </div>
          ) : history.length ? (
            <div className="pm-group-history-list" data-pasture-group-history-list="1">
              {history.map((h) => (
                <div key={h.id} className="pm-record-stay" data-pasture-group-history-row={h.id}>
                  <div className="pm-record-stay-head">
                    <strong>
                      {areaLabel(h.from_land_area_id, h.from_land_area_name)} &rarr;{' '}
                      {areaLabel(h.to_land_area_id, h.to_land_area_name)}
                    </strong>
                    {h.animal_count != null && (
                      <span className="pm-record-stay-count">{Number(h.animal_count).toLocaleString()} head</span>
                    )}
                  </div>
                  <div className="pm-record-stay-when">{formatMoveTime ? formatMoveTime(h.moved_at) : h.moved_at}</div>
                  {h.notes && <div className="pm-record-stay-notes">{h.notes}</div>}
                </div>
              ))}
            </div>
          ) : (
            <div className="pm-report-empty" data-pasture-group-history-empty="1">
              No recorded moves for this group yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
