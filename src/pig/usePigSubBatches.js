import {useState} from 'react';

// Pig.batch sub-batch (partition) workflow (CP8 extraction from PigBatchesView).
// Owns the sub-form state plus the add/edit/autosave/close/save/delete/archive
// handlers and the in-modal partition-count editor. Verbatim lift — persists via
// the existing persistFeeders helper, preserves the ppp-feeders-v1 subBatches
// shape, the originalPigCount = gilt+boar invariant, all validation messages,
// and processed/active semantics. The sub-batch form + partition editor JSX stay
// in PigBatchesView and consume the returned state/handlers.
//
// Deps passed in explicitly (React-context-free):
//   feederGroups / setFeederGroups — ppp-feeders-v1 source of truth
//                                    (setFeederGroups drives the optimistic
//                                    partition update before the debounced save)
//   persistFeeders                 — existing persist helper
//   setNotice                      — shared inline notice
//   confirmDelete                  — delete-confirmation helper
//   subAutoSaveTimer/pigAutoSaveTimer — shared debounce refs (props)
//   partitionDirtyRef              — shared with closeFeederForm (view-owned ref):
//                                    set here on a partition edit, cleared there
export function usePigSubBatches({
  feederGroups,
  setFeederGroups,
  persistFeeders,
  setNotice,
  confirmDelete,
  subAutoSaveTimer,
  pigAutoSaveTimer,
  partitionDirtyRef,
}) {
  const [showSubForm, setShowSubForm] = useState(null); // batchId or null
  const [subForm, setSubForm] = useState({name: '', giltCount: 0, boarCount: 0, originalPigCount: 0, notes: ''});
  const [editSubId, setEditSubId] = useState(null);

  function archiveSubBatch(batchId, subId) {
    const nb = feederGroups.map((g) =>
      g.id !== batchId
        ? g
        : {...g, subBatches: (g.subBatches || []).map((s) => (s.id === subId ? {...s, status: 'processed'} : s))},
    );
    persistFeeders(nb);
  }
  function unarchiveSubBatch(batchId, subId) {
    const nb = feederGroups.map((g) =>
      g.id !== batchId
        ? g
        : {...g, subBatches: (g.subBatches || []).map((s) => (s.id === subId ? {...s, status: 'active'} : s))},
    );
    persistFeeders(nb);
  }
  // Persist a sub-batch using the given form state. Returns the new subId on success.
  //
  // NEW sub-batches: form provides {name, sex:'Gilts'|'Boars', count, notes}.
  // We translate that into giltCount/boarCount/originalPigCount with the
  // single non-zero count on the chosen side. The new count must not push
  // sum-of-subs past the parent's gilt/boar total — caller validates.
  //
  // EDIT mode: form provides {name, notes} only. Counts + status + id are
  // preserved verbatim from the existing sub. To rebalance counts, the
  // admin edits the parent partition UI.
  function persistSubBatch(batchId, formState, currentSubId) {
    const subId = currentSubId || String(Date.now());
    const nb = feederGroups.map((g) => {
      if (g.id !== batchId) return g;
      const subs = g.subBatches || [];
      const existing = currentSubId ? subs.find((s) => s.id === currentSubId) || {} : {};
      let sub;
      if (currentSubId) {
        // Edit mode: only name + notes mutate.
        sub = {...existing, name: formState.name, notes: formState.notes || '', id: subId};
      } else {
        // New mode: derive gilt/boar counts from sex + count.
        const sex = formState.sex || 'Gilts';
        const c = formState.count === '' || formState.count == null ? 0 : parseInt(formState.count) || 0;
        sub = {
          id: subId,
          status: 'active',
          name: formState.name,
          notes: formState.notes || '',
          giltCount: sex === 'Gilts' ? c : 0,
          boarCount: sex === 'Boars' ? c : 0,
          originalPigCount: c,
        };
      }
      const updated = currentSubId ? subs.map((s) => (s.id === currentSubId ? sub : s)) : [...subs, sub];
      return {...g, subBatches: updated};
    });
    persistFeeders(nb);
    return subId;
  }

  // Validate a new sub-batch against parent's available gilt/boar pool.
  // Returns null when valid, or a string error message. Edit mode skips
  // validation (counts are locked).
  function validateNewSub(batchId, formState) {
    if (!formState.name || !formState.name.trim()) return 'Sub-batch name is required.';
    const c = formState.count === '' || formState.count == null ? 0 : parseInt(formState.count) || 0;
    if (c <= 0) return 'Count must be 1 or more.';
    const sex = formState.sex || 'Gilts';
    const g = feederGroups.find((x) => x.id === batchId);
    if (!g) return null;
    const parentTotal = sex === 'Boars' ? parseInt(g.boarCount) || 0 : parseInt(g.giltCount) || 0;
    const usedBy = (g.subBatches || []).reduce(
      (a, s) => a + (sex === 'Boars' ? parseInt(s.boarCount) || 0 : parseInt(s.giltCount) || 0),
      0,
    );
    const remaining = Math.max(0, parentTotal - usedBy);
    if (c > remaining)
      return (
        'Only ' +
        remaining +
        ' ' +
        sex.toLowerCase() +
        ' available on parent batch (has ' +
        parentTotal +
        ', already used ' +
        usedBy +
        ').'
      );
    return null;
  }

  function updSub(batchId, k, v) {
    setNotice(null);
    const next = {...subForm, [k]: v};
    setSubForm(next);
    if (!next.name || !next.name.trim()) return;
    // New mode requires a valid count before autosaving (otherwise we'd
    // persist a 0-count sub on the first keystroke). Edit mode autosaves
    // on any name/notes change.
    if (!editSubId) {
      const c = next.count === '' || next.count == null ? 0 : parseInt(next.count) || 0;
      if (c <= 0) return;
    }
    clearTimeout(subAutoSaveTimer.current);
    subAutoSaveTimer.current = setTimeout(() => {
      if (!editSubId) {
        const err = validateNewSub(batchId, next);
        if (err) {
          setNotice({kind: 'error', message: err});
          return;
        }
      }
      const newId = persistSubBatch(batchId, next, editSubId);
      // After first autosave, hand the form to edit mode so subsequent
      // saves update the same row (and lock counts). Reshape subForm to
      // match the locked-display shape (giltCount/boarCount/originalPigCount).
      if (!editSubId) {
        setEditSubId(newId);
        const sex = next.sex || 'Gilts';
        const c = parseInt(next.count) || 0;
        setSubForm({
          name: next.name,
          notes: next.notes || '',
          giltCount: sex === 'Gilts' ? c : 0,
          boarCount: sex === 'Boars' ? c : 0,
          originalPigCount: c,
        });
      }
    }, 1500);
  }

  function closeSubForm(batchId) {
    clearTimeout(subAutoSaveTimer.current);
    setNotice(null);
    // Flush any pending changes synchronously on close, but only if the
    // form is in a valid persistable shape.
    if (subForm.name && subForm.name.trim()) {
      if (editSubId) {
        persistSubBatch(batchId, subForm, editSubId);
      } else {
        const err = validateNewSub(batchId, subForm);
        if (!err) persistSubBatch(batchId, subForm, editSubId);
      }
    }
    setShowSubForm(null);
    setEditSubId(null);
    setSubForm({name: '', sex: 'Gilts', count: 0, notes: ''});
  }

  function saveSubBatch(batchId) {
    setNotice(null);
    if (!subForm.name.trim()) {
      setNotice({kind: 'error', message: 'Please enter a sub-batch name.'});
      return;
    }
    if (!editSubId) {
      const err = validateNewSub(batchId, subForm);
      if (err) {
        setNotice({kind: 'error', message: err});
        return;
      }
    }
    clearTimeout(subAutoSaveTimer.current);
    persistSubBatch(batchId, subForm, editSubId);
    setShowSubForm(null);
    setEditSubId(null);
    setSubForm({name: '', sex: 'Gilts', count: 0, notes: ''});
  }

  function deleteSubBatch(batchId, subId) {
    confirmDelete('Delete this sub-batch? This cannot be undone.', () => {
      const nb = feederGroups.map((g) =>
        g.id !== batchId ? g : {...g, subBatches: (g.subBatches || []).filter((s) => s.id !== subId)},
      );
      persistFeeders(nb);
    });
  }

  // Sub-batch partition: edit a sub's count from inside the parent modal.
  // Sub's existing sex (giltCount-only or boarCount-only) is locked; this
  // function only adjusts the magnitude. Uses pigAutoSaveTimer for the
  // 1.5s debounce shared with the parent's other fields.
  function updSubPartition(batchId, subId, newCountStr) {
    const c = newCountStr === '' || newCountStr == null ? 0 : parseInt(newCountStr) || 0;
    const nb = feederGroups.map((g) => {
      if (g.id !== batchId) return g;
      const subs = (g.subBatches || []).map((sb) => {
        if (sb.id !== subId) return sb;
        const isBoars = (parseInt(sb.boarCount) || 0) > 0 && (parseInt(sb.giltCount) || 0) === 0;
        if (isBoars) return {...sb, giltCount: 0, boarCount: c, originalPigCount: c};
        return {...sb, giltCount: c, boarCount: 0, originalPigCount: c};
      });
      return {...g, subBatches: subs};
    });
    setFeederGroups(nb);
    partitionDirtyRef.current = true;
    clearTimeout(pigAutoSaveTimer.current);
    pigAutoSaveTimer.current = setTimeout(() => {
      persistFeeders(nb);
      partitionDirtyRef.current = false;
    }, 1500);
  }

  return {
    showSubForm,
    setShowSubForm,
    subForm,
    setSubForm,
    editSubId,
    setEditSubId,
    archiveSubBatch,
    unarchiveSubBatch,
    validateNewSub,
    updSub,
    closeSubForm,
    saveSubBatch,
    deleteSubBatch,
    updSubPartition,
  };
}
