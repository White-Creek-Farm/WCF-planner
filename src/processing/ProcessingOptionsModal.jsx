// ============================================================================
// src/processing/ProcessingOptionsModal.jsx  —  admin editor for the Processing
// Customer / Processor selector choices.
// ----------------------------------------------------------------------------
// Admin-only (opened from inside ProcessingTemplatesModal, which is itself
// admin-gated). Edits the two server-backed option lists that drive the
// Customer + Processor selects in the drawer + Add Milestone:
//   setProcessingOptionList(sb, 'processor' | 'customer', [...])  (mig 162)
// Each list is edited locally (add / remove / reorder-by-remove) then saved
// wholesale; the server trims + de-dupes. Editing a list NEVER rejects or
// rewrites values already stored on records — legacy/off-list values persist and
// keep rendering; they simply won't appear as a picker choice unless added here.
// On save the parent refetches settings so the drawer + modal pick up the change.
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

function sameList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function OptionListEditor({kind, title, hint, initial, busy, onSave}) {
  const {useState} = React;
  const [items, setItems] = useState(() => (Array.isArray(initial) ? initial.slice() : []));
  const [draft, setDraft] = useState('');
  const base = Array.isArray(initial) ? initial : [];
  const dirty = !sameList(items, base);

  function add() {
    const v = draft.trim();
    if (!v || items.includes(v)) {
      setDraft('');
      return;
    }
    setItems((cur) => [...cur, v]);
    setDraft('');
  }
  function remove(v) {
    setItems((cur) => cur.filter((x) => x !== v));
  }

  return (
    <div style={{marginBottom: 22}}>
      <label style={labelStyle}>{title}</label>
      <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginBottom: 10, lineHeight: 1.4}}>{hint}</div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 10}}>
        {items.length === 0 && (
          <span style={{fontSize: 12.5, color: T.faint, fontWeight: 600}}>No choices yet — add one below.</span>
        )}
        {items.map((opt) => (
          <span
            key={opt}
            data-processing-option-chip={opt}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              fontWeight: 700,
              borderRadius: 999,
              padding: '5px 8px 5px 12px',
              border: `1px solid ${T.border}`,
              background: '#F6F8F9',
              color: T.ink,
            }}
          >
            {opt}
            <button
              type="button"
              aria-label={`Remove ${opt}`}
              disabled={busy}
              onClick={() => remove(opt)}
              style={{
                width: 18,
                height: 18,
                borderRadius: 999,
                border: 'none',
                background: '#E4E7EA',
                color: T.muted,
                cursor: busy ? 'default' : 'pointer',
                fontSize: 11,
                lineHeight: 1,
                fontFamily: 'inherit',
              }}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
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
          onClick={() => onSave(kind, items)}
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

export default function ProcessingOptionsModal({processorOptions = [], customerOptions = [], onClose, onSaved}) {
  const {useState} = React;
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function save(kind, items) {
    setBusy(true);
    setNotice(null);
    try {
      await setProcessingOptionList(sb, kind, items);
      setNotice({kind: 'success', message: `${kind === 'processor' ? 'Processor' : 'Customer'} choices saved.`});
      if (onSaved) onSaved();
    } catch (e) {
      setNotice({kind: 'error', message: friendlyProcessingError(e)});
    } finally {
      setBusy(false);
    }
  }

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
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              These drive the pickers in the drawer + Add milestone. Editing never changes values already on records.
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
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
          <OptionListEditor
            kind="customer"
            title="Customer choices (broiler)"
            hint="The choices in the Customer select on broiler records + milestones."
            initial={customerOptions}
            busy={busy}
            onSave={save}
          />
          <OptionListEditor
            kind="processor"
            title="Processor choices"
            hint="The choices in the Processor select for all programs."
            initial={processorOptions}
            busy={busy}
            onSave={save}
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
