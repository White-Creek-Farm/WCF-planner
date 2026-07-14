// ============================================================================
// src/processing/ProcessingOptionsModal.jsx  —  admin AUTOSAVE editor for the
// Processing Customer / Processor selector choices.
// ----------------------------------------------------------------------------
// Admin-only (rendered inside ProcessingTemplatesModal's Fields surface, which
// is itself admin-gated — the old standalone modal wrapper was dead code and
// is removed). Edits the two server-backed option lists that drive the
// Customer + Processor selects in the drawer + Add Milestone:
//   setProcessingOptionList(sb, 'processor' | 'customer', [...])  (mig 162/175)
// Options are STABLE objects {id, label, active} (mig 175): an existing option
// can be RENAMED in place (same id, new label) or DEACTIVATED/REACTIVATED, but
// NEVER deleted — the server refuses deletion, so this UI offers no hard-delete
// (only a not-yet-saved draft entry can be withdrawn). New entries are sent
// WITHOUT an id; the server mints 'opt-<uuid>'.
//
// AUTOSAVE model (UX lane) — there is NO Save button:
//   • Every edit (add via button/Enter, rename, deactivate/reactivate,
//     withdraw) schedules one debounced save (AUTOSAVE_DEBOUNCE_MS), so typing
//     a rename never issues an RPC per keystroke.
//   • At most ONE RPC in flight per list; an edit made during a request makes
//     the engine persist the NEWEST full list right after it — out-of-order
//     responses are impossible by construction.
//   • A payload identical to the last successful save is skipped.
//   • Success reconciles server-minted ids into local state (matched through
//     client-only temp keys, never sent) and notifies the parent so the
//     drawer/milestone dropdowns refresh; parent refreshes never clobber
//     local edits (props seed the editor exactly once).
//   • The single-writer items model lives in a ref mirrored into state, so an
//     async save continuation can never clobber a just-batched user edit.
//   • Blank labels never autosave (the mig-175 server RAISES on blank or
//     duplicate labels and refuses stored-id deletion): a mid-rename empty
//     field just waits; a flush attempt with a blank label fails with the
//     inline error instead of discarding anything.
//   • A new entry withdrawn while its request is in flight has already been
//     stored (stored options cannot be deleted) — the reconcile converts the
//     too-late withdrawal into a deactivation under the Deactivated section.
//   • The HOST must await the registered flush (registerFlush) before
//     unmounting the editor / closing the modal; a failed flush returns false
//     so the host stays open with the inline error + edits retained. An
//     unmount without a host flush still fire-and-forgets a final persist.
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
const smallBtn = {
  background: '#fff',
  border: `1px solid #D2D6DB`,
  color: '#3F4650',
  borderRadius: 10,
  padding: '7px 11px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
  flex: 'none',
};

// Debounce for the autosave engine — long enough that typing a rename does not
// issue an RPC per keystroke, short enough to feel immediate.
const AUTOSAVE_DEBOUNCE_MS = 500;
// Client-only keys for not-yet-saved entries (NEVER sent to the server) — the
// id-mint reconciliation matches on these after a save returns.
let tempKeySeq = 0;

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
// RPC payload for a draft list: labels trimmed, server ids included when
// present, client temp keys omitted.
function payloadFor(items) {
  return items.map((o) => {
    const out = {label: o.label.trim(), active: o.active};
    if (o.id != null) out.id = o.id;
    return out;
  });
}
const payloadKey = (items) => JSON.stringify(payloadFor(items));
const hasBlankLabel = (items) => items.some((o) => !o.label.trim());

// eslint-disable-next-line no-unused-vars -- JSX-only use
function OptionListEditor({kind, title, initial, onPersist, onBlankBlocked, registerFlush}) {
  const {useState, useRef, useEffect, useCallback} = React;
  // Seeded ONCE from props — later parent option refreshes must never clobber
  // newer local edits; the autosave engine is the only writer back.
  const [items, setItems] = useState(() => normalizeList(initial));
  const [draft, setDraft] = useState('');
  // 'idle' (pristine) | 'pending' (debounce armed) | 'saving' | 'saved' | 'error'
  const [saveState, setSaveState] = useState('idle');

  // Single-writer model: the ref is the source of truth, updated synchronously
  // by every mutation; state mirrors it for render. Async save continuations
  // always see the newest list and can never clobber a batched user edit.
  const itemsRef = useRef(items);
  const mutateItems = useCallback((fn) => {
    itemsRef.current = fn(itemsRef.current);
    setItems(itemsRef.current);
  }, []);

  // Autosave engine: debounce timer, the single in-flight chain, and the
  // payload key of the last successful save (skip-duplicate contract).
  const engineRef = useRef(null);
  if (engineRef.current === null) {
    engineRef.current = {timer: null, chain: null, lastSavedKey: payloadKey(normalizeList(initial))};
  }

  // Persist loop: at most ONE RPC in flight; after each successful save it
  // re-serializes the NEWEST items, so an edit made during a request is
  // persisted right after it. Resolves 'ok' | 'failed' | 'blank'.
  const persistNow = useCallback(() => {
    const engine = engineRef.current;
    if (engine.timer) {
      clearTimeout(engine.timer);
      engine.timer = null;
    }
    if (!engine.chain) {
      engine.chain = (async () => {
        try {
          for (;;) {
            const snapshot = itemsRef.current;
            // A blanked label must never reach the server (mig 175 RAISES on
            // blank labels — a mid-rename autosave would just error noisily).
            // Wait for the label to come back or let the flush block.
            if (hasBlankLabel(snapshot)) return 'blank';
            const payload = payloadFor(snapshot);
            const key = JSON.stringify(payload);
            if (key === engine.lastSavedKey) {
              setSaveState((s) => (s === 'idle' ? s : 'saved'));
              return 'ok';
            }
            setSaveState('saving');
            const res = await onPersist(kind, payload);
            if (!res || res.ok !== true) {
              setSaveState('error');
              return 'failed'; // edits retained; the next edit or flush retries
            }
            const savedList = Array.isArray(res.options) ? normalizeList(res.options) : null;
            if (!savedList) {
              // Saved, but no echo to reconcile against: remember the payload
              // we sent so the loop converges without a duplicate save.
              engine.lastSavedKey = key;
            } else {
              engine.lastSavedKey = payloadKey(savedList);
              mutateItems((cur) => {
                // No edits landed during the request → adopt server truth
                // verbatim (minted ids, server normalization).
                if (cur === snapshot) return savedList;
                // Edits landed mid-flight: only stamp minted ids onto the
                // still-present temp entries; the loop persists the rest on
                // its next pass with the newest list.
                const minted = new Map();
                if (savedList.length === snapshot.length) {
                  snapshot.forEach((o, i) => {
                    if (o.id == null && o.tempKey && savedList[i]?.id != null) minted.set(o.tempKey, savedList[i].id);
                  });
                } else {
                  const byLabel = new Map(
                    savedList.filter((o) => o.id != null).map((o) => [o.label.toLocaleLowerCase(), o.id]),
                  );
                  snapshot.forEach((o) => {
                    if (o.id == null && o.tempKey) {
                      const id = byLabel.get(o.label.trim().toLocaleLowerCase());
                      if (id != null) minted.set(o.tempKey, id);
                    }
                  });
                }
                const next = cur.map((o) =>
                  o.id == null && o.tempKey && minted.has(o.tempKey) ? {...o, id: minted.get(o.tempKey)} : o,
                );
                // A new entry withdrawn DURING its persisting request is
                // already stored server-side, and stored options cannot be
                // deleted (mig 175 raises). Convert the too-late withdrawal
                // into a deactivation: visible under Deactivated, persisted by
                // the loop's next pass.
                const present = new Set(next.map((o) => o.tempKey).filter(Boolean));
                snapshot.forEach((o) => {
                  if (o.id == null && o.tempKey && minted.has(o.tempKey) && !present.has(o.tempKey)) {
                    next.push({id: minted.get(o.tempKey), label: o.label.trim(), active: false});
                  }
                });
                return next;
              });
            }
            setSaveState('saved');
          }
        } finally {
          engine.chain = null;
        }
      })();
    }
    return engine.chain;
  }, [kind, onPersist, mutateItems]);

  const scheduleAutosave = useCallback(() => {
    const engine = engineRef.current;
    if (engine.timer) clearTimeout(engine.timer);
    setSaveState((s) => (s === 'saving' ? s : 'pending'));
    engine.timer = setTimeout(() => {
      engine.timer = null;
      persistNow();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [persistNow]);

  // Host-awaited flush: cancel the debounce and persist everything now.
  // Returns false when the list cannot be persisted (RPC failure or a blank
  // label) — the host must then STAY OPEN so the edits are never discarded.
  const flush = useCallback(async () => {
    const engine = engineRef.current;
    if (engine.timer) {
      clearTimeout(engine.timer);
      engine.timer = null;
    }
    for (;;) {
      const res = await persistNow();
      if (res === 'blank') {
        if (onBlankBlocked) onBlankBlocked(kind);
        return false;
      }
      if (res === 'failed') return false;
      if (payloadKey(itemsRef.current) === engine.lastSavedKey) return true;
    }
  }, [persistNow, onBlankBlocked, kind]);

  useEffect(() => {
    if (registerFlush) registerFlush(kind, flush);
    return () => {
      if (registerFlush) registerFlush(kind, null);
    };
  }, [registerFlush, kind, flush]);

  // Adopt refreshed parent options only while the editor is CLEAN — nothing
  // pending, nothing in flight, everything saved. A parent refresh can then
  // never clobber newer unsaved local edits, while a remount or late settings
  // refetch after our own save still becomes current.
  useEffect(() => {
    const engine = engineRef.current;
    if (engine.timer || engine.chain) return;
    if (payloadKey(itemsRef.current) !== engine.lastSavedKey) return;
    const next = normalizeList(initial);
    const nextKey = payloadKey(next);
    if (nextKey === payloadKey(itemsRef.current)) return;
    itemsRef.current = next;
    setItems(next);
    engine.lastSavedKey = nextKey;
  }, [initial]);

  // Backstop: an unmount the host forgot to flush still fire-and-forgets a
  // final persist (state updates after unmount are no-ops; the RPC completes).
  useEffect(() => {
    return () => {
      const engine = engineRef.current;
      if (engine.timer || payloadKey(itemsRef.current) !== engine.lastSavedKey) persistNow();
    };
  }, [persistNow]);

  function add() {
    const v = draft.trim();
    if (!v || itemsRef.current.some((o) => o.label.toLocaleLowerCase() === v.toLocaleLowerCase())) {
      setDraft('');
      return;
    }
    // New entries carry NO id until saved — the server mints one; the temp key
    // is client-only and lets the save reconcile the minted id back in.
    mutateItems((cur) => [...cur, {id: null, tempKey: `tmp-${++tempKeySeq}`, label: v, active: true}]);
    setDraft('');
    scheduleAutosave();
  }
  function rename(idx, label) {
    // Same id, new label — the server updates the option in place.
    mutateItems((cur) => cur.map((o, i) => (i === idx ? {...o, label} : o)));
    scheduleAutosave();
  }
  function setActive(idx, active) {
    mutateItems((cur) => cur.map((o, i) => (i === idx ? {...o, active} : o)));
    scheduleAutosave();
  }
  function withdrawDraftEntry(idx) {
    // Only a NOT-YET-SAVED entry (no id) can be withdrawn — stored options are
    // never deletable (the server refuses deletion; deactivate instead).
    mutateItems((cur) => cur.filter((o, i) => i !== idx || o.id != null));
    scheduleAutosave();
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
          key={opt.id || opt.tempKey || `new-${idx}`}
          data-processing-option-row={opt.id || opt.label}
          style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7}}
        >
          <input
            value={opt.label}
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
              onClick={() => withdrawDraftEntry(idx)}
              aria-label={`Undo adding ${opt.label}`}
              style={smallBtn}
            >
              Undo
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActive(idx, false)}
              data-processing-option-deactivate={opt.id}
              aria-label={`Deactivate ${opt.label}`}
              style={smallBtn}
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
              key={opt.id || opt.tempKey || `new-${idx}`}
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
                onClick={() => setActive(idx, true)}
                data-processing-option-deactivate={opt.id || opt.label}
                aria-label={`Reactivate ${opt.label}`}
                style={smallBtn}
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
          disabled={!draft.trim()}
          data-processing-option-add={kind}
          style={{
            background: '#fff',
            border: `1px solid #D2D6DB`,
            color: '#3F4650',
            borderRadius: 10,
            padding: '9px 14px',
            fontSize: 13,
            fontWeight: 700,
            cursor: !draft.trim() ? 'default' : 'pointer',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
          }}
        >
          Add
        </button>
        {/* Compact autosave state — there is intentionally NO Save button. */}
        {saveState !== 'idle' && (
          <span
            data-processing-option-autosave={kind}
            data-state={saveState}
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: saveState === 'error' ? '#B4373A' : saveState === 'saved' ? '#1F7A4D' : T.faint,
              whiteSpace: 'nowrap',
              flex: 'none',
            }}
          >
            {saveState === 'saved' ? 'Saved ✓' : saveState === 'error' ? 'Not saved' : 'Saving…'}
          </span>
        )}
      </div>
    </div>
  );
}

export function ProcessingOptionsEditor({processorOptions = [], customerOptions = [], onSaved, registerFlush}) {
  const {useState, useRef, useEffect, useCallback} = React;
  const [notice, setNotice] = useState(null);

  // Autosave persist for one list. Resolves {ok, options}; a failure sets the
  // inline error and the editor keeps its edits for the retry.
  const persist = useCallback(
    async (kind, items) => {
      try {
        const data = await setProcessingOptionList(sb, kind, items);
        setNotice(null);
        if (onSaved) onSaved();
        return {ok: true, options: Array.isArray(data?.options) ? data.options : null};
      } catch (e) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
        return {ok: false};
      }
    },
    [onSaved],
  );

  const onBlankBlocked = useCallback((kind) => {
    setNotice({
      kind: 'error',
      message: `A ${kind} choice name cannot be empty. Restore the name or undo the entry.`,
    });
  }, []);

  // Aggregate the per-list flushes for the host: the Templates modal awaits
  // this before unmounting this editor or closing. False = a list could not
  // be persisted (the inline error explains why) — the host must stay open.
  const flushesRef = useRef(new Map());
  const registerListFlush = useCallback((kind, fn) => {
    if (fn) flushesRef.current.set(kind, fn);
    else flushesRef.current.delete(kind);
  }, []);
  const flushAll = useCallback(async () => {
    let ok = true;
    for (const fn of [...flushesRef.current.values()]) {
      if (!(await fn())) ok = false;
    }
    return ok;
  }, []);
  useEffect(() => {
    if (registerFlush) registerFlush(flushAll);
    return () => {
      if (registerFlush) registerFlush(null);
    };
  }, [registerFlush, flushAll]);

  return (
    <>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <OptionListEditor
        kind="customer"
        title="Customer choices (broiler)"
        initial={customerOptions}
        onPersist={persist}
        onBlankBlocked={onBlankBlocked}
        registerFlush={registerListFlush}
      />
      <OptionListEditor
        kind="processor"
        title="Processor choices"
        initial={processorOptions}
        onPersist={persist}
        onBlankBlocked={onBlankBlocked}
        registerFlush={registerListFlush}
      />
    </>
  );
}
