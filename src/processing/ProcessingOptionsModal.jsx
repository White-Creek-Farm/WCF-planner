// ============================================================================
// src/processing/ProcessingOptionsModal.jsx  —  admin editor for the Processing
// Customer / Processor selector choices.
// ----------------------------------------------------------------------------
// Admin-only (opened from inside ProcessingTemplatesModal, which is itself
// admin-gated). Edits the two server-backed option lists that drive the
// Customer + Processor selects in the drawer + Add Milestone:
//   setProcessingOptionList(sb, 'processor' | 'customer', [...])  (mig 162/175)
// Options are STABLE objects {id, label, active} (mig 175): an existing option
// can be RENAMED in place (same id, new label) or DEACTIVATED/REACTIVATED, but
// NEVER deleted — the server refuses deletion, so this UI offers no hard-delete
// (only a not-yet-saved draft entry can be withdrawn). New entries are sent
// WITHOUT an id; the server mints 'opt-<uuid>'. Editing a list NEVER rejects or
// rewrites values already stored on records — a deactivated option disappears
// from new picker choices, but its historical stored labels keep rendering as
// legacy values. On save the parent refetches settings so the drawer + modals
// pick up the change.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {setProcessingOptionList, friendlyProcessingError} from '../lib/processingApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

const T = {
  card: '#fff',
  border: '#E6E8EB',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
};
const labelStyle = {
  display: 'block',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: T.label,
  marginBottom: 8,
};
const inputStyle = {
  flex: 1,
  minWidth: 0,
  border: `1px solid #D2D6DB`,
  borderRadius: 10,
  padding: '9px 11px',
  fontSize: 13.5,
  fontWeight: 600,
  color: T.ink,
  fontFamily: 'inherit',
  background: '#fff',
  outline: 'none',
  boxSizing: 'border-box',
};
const smallBtn = (disabled) => ({
  background: '#fff',
  border: `1px solid #D2D6DB`,
  color: '#3F4650',
  borderRadius: 10,
  padding: '7px 11px',
  fontSize: 12,
  fontWeight: 700,
  cursor: disabled ? 'default' : 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  flex: 'none',
});

// Normalize a server/legacy option entry into the draft shape {id,label,active}.
// Tolerates the pre-175 plain-string shape so a stale settings payload can
// never blank the editor.
function normalizeOption(opt) {
  if (opt == null) return null;
  if (typeof opt === 'string') {
    const label = opt.trim();
    return label ? {id: null, label, active: true} : null;
  }
  if (typeof opt !== 'object') return null;
  const label = String(opt.label ?? '').trim();
  if (!label) return null;
  return {id: opt.id ?? null, label, active: opt.active !== false};
}
function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map(normalizeOption).filter(Boolean);
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function OptionListEditor({kind, title, initial, busy, onSave}) {
  const {useState} = React;
  const [items, setItems] = useState(() => normalizeList(initial));
  const [draft, setDraft] = useState('');
  const dirty = JSON.stringify(items) !== JSON.stringify(normalizeList(initial));

  function add() {
    const v = draft.trim();
    if (!v || items.some((o) => o.label.toLocaleLowerCase() === v.toLocaleLowerCase())) {
      setDraft('');
      return;
    }
    // New entries carry NO id until saved — the server mints one.
    setItems((cur) => [...cur, {id: null, label: v, active: true}]);
    setDraft('');
  }
  function rename(idx, label) {
    // Same id, new label — the server updates the option in place.
    setItems((cur) => cur.map((o, i) => (i === idx ? {...o, label} : o)));
  }
  function setActive(idx, active) {
    setItems((cur) => cur.map((o, i) => (i === idx ? {...o, active} : o)));
  }
  function withdrawDraftEntry(idx) {
    // Only a NOT-YET-SAVED entry (no id) can be withdrawn — stored options are
    // never deletable (the server refuses deletion; deactivate instead).
    setItems((cur) => cur.filter((o, i) => i !== idx || o.id != null));
  }
  async function handleSave() {
    const payload = items.map((o) => {
      const out = {label: o.label.trim(), active: o.active};
      if (o.id != null) out.id = o.id;
      return out;
    });
    const saved = await onSave(kind, payload);
    // Sync the draft to the saved list (new entries now carry server ids) so
    // dirty-tracking is correct before the parent's settings refetch lands.
    if (Array.isArray(saved)) setItems(normalizeList(saved));
  }

  const entries = items.map((opt, idx) => ({opt, idx}));
  const activeEntries = entries.filter((e) => e.opt.active);
  const inactiveEntries = entries.filter((e) => !e.opt.active);

  return (
    <div style={{marginBottom: 22}}>
      <label style={labelStyle}>{title}</label>

      {activeEntries.length === 0 && (
        <div style={{fontSize: 12.5, color: T.faint, fontWeight: 600, marginBottom: 10}}>
          No active choices — add one below{inactiveEntries.length ? ' or reactivate one' : ''}.
        </div>
      )}
      {activeEntries.map(({opt, idx}) => (
        <div
          key={opt.id || `new-${idx}`}
          data-processing-option-row={opt.id || opt.label}
          style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7}}
        >
          <input
            value={opt.label}
            disabled={busy}
            onChange={(e) => rename(idx, e.target.value)}
            aria-label={`Rename ${opt.label || 'option'}`}
            style={inputStyle}
          />
          {opt.id == null && (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                color: '#8A6A1E',
                background: '#F7EFD6',
                borderRadius: 999,
                padding: '3px 8px',
                flex: 'none',
              }}
            >
              new
            </span>
          )}
          {opt.id == null ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => withdrawDraftEntry(idx)}
              aria-label={`Undo adding ${opt.label}`}
              style={smallBtn(busy)}
            >
              Undo
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setActive(idx, false)}
              data-processing-option-deactivate={opt.id}
              aria-label={`Deactivate ${opt.label}`}
              style={smallBtn(busy)}
            >
              Deactivate
            </button>
          )}
        </div>
      ))}

      {inactiveEntries.length > 0 && (
        <div style={{margin: '12px 0 10px'}}>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 800,
              color: T.faint,
              textTransform: 'uppercase',
              letterSpacing: '.05em',
              marginBottom: 6,
            }}
          >
            Deactivated
          </div>
          {inactiveEntries.map(({opt, idx}) => (
            <div
              key={opt.id || `new-${idx}`}
              data-processing-option-row={opt.id || opt.label}
              style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, opacity: 0.75}}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: T.faint,
                  textDecoration: 'line-through',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {opt.label}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setActive(idx, true)}
                data-processing-option-deactivate={opt.id || opt.label}
                aria-label={`Reactivate ${opt.label}`}
                style={smallBtn(busy)}
              >
                Reactivate
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={`Add a ${kind}…`}
          data-processing-option-add-input={kind}
          style={inputStyle}
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !draft.trim()}
          style={{
            background: '#fff',
            border: `1px solid #D2D6DB`,
            color: '#3F4650',
            borderRadius: 10,
            padding: '9px 14px',
            fontSize: 13,
            fontWeight: 700,
            cursor: busy || !draft.trim() ? 'default' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          Add
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !dirty}
          data-processing-option-save={kind}
          style={{
            background: busy || !dirty ? '#EAECEF' : T.green,
            color: busy || !dirty ? '#9AA1AB' : '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '9px 16px',
            fontSize: 13,
            fontWeight: 700,
            cursor: busy || !dirty ? 'default' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          {dirty ? 'Save' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

export function ProcessingOptionsEditor({processorOptions = [], customerOptions = [], onSaved}) {
  const {useState} = React;
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  // Returns the saved option list on success (the editor resyncs its draft to
  // the server-minted ids), or null on failure.
  async function save(kind, items) {
    setBusy(true);
    setNotice(null);
    try {
      const data = await setProcessingOptionList(sb, kind, items);
      setNotice({kind: 'success', message: `${kind === 'processor' ? 'Processor' : 'Customer'} choices saved.`});
      if (onSaved) onSaved();
      return Array.isArray(data?.options) ? data.options : null;
    } catch (e) {
      setNotice({kind: 'error', message: friendlyProcessingError(e)});
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <OptionListEditor
        kind="customer"
        title="Customer choices (broiler)"
        initial={customerOptions}
        busy={busy}
        onSave={save}
      />
      <OptionListEditor
        kind="processor"
        title="Processor choices"
        initial={processorOptions}
        busy={busy}
        onSave={save}
      />
    </>
  );
}

export default function ProcessingOptionsModal({processorOptions = [], customerOptions = [], onClose, onSaved}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 7000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      data-processing-options-modal="1"
    >
      <style>{`@keyframes wcfProcModalIn{from{transform:translateY(10px) scale(.985);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}`}</style>
      <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
      <div
        style={{
          position: 'relative',
          width: 560,
          maxWidth: '96vw',
          maxHeight: '90vh',
          background: T.card,
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(20,30,40,.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'wcfProcModalIn .18s ease',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '16px 20px',
            borderBottom: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontSize: 16, fontWeight: 800, letterSpacing: '-.01em', color: T.ink}}>
              Customer &amp; processor choices
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: '#fff',
              color: T.muted,
              cursor: 'pointer',
              fontSize: 15,
            }}
          >
            ✕
          </button>
        </div>

        <div style={{flex: 1, overflow: 'auto', padding: '18px 20px 4px'}}>
          <ProcessingOptionsEditor
            processorOptions={processorOptions}
            customerOptions={customerOptions}
            onSaved={onSaved}
          />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px',
            borderTop: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#fff',
              border: `1px solid #D2D6DB`,
              color: '#3F4650',
              borderRadius: 10,
              padding: '10px 16px',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
