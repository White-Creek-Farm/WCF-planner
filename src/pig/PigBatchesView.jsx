// ============================================================================
// src/pig/PigBatchesView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Pig feeder batches admin view (largest inline-JSX view by line count —
// ~662 lines). Pig entity arrays, the feeder form, and the trip form all
// live in PigContext; collapsed-state Sets, the three auto-save refs, and
// the persistFeeders helper still live in App and come in as props.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, toISO} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcBreedingTimeline,
  calcCycleStatus,
  buildCycleSeqMap,
  cycleLabel,
  PIG_GROUP_COLORS,
  getReadableText,
  pigTransfersForSub,
  pigTransfersForBatch,
  pigTripPigsForSub,
  pigTripPigsAttributed,
  pigMortalityForSub,
  pigMortalityForBatch,
  computePigBatchFCR,
  calcAgeRange as libCalcAgeRange,
} from '../lib/pig.js';
import UsersModal from '../auth/UsersModal.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

export default function PigBatchesView({
  Header,
  loadUsers,
  persistFeeders,
  confirmDelete,
  pigAutoSaveTimer,
  subAutoSaveTimer,
  tripAutoSaveTimer,
  collapsedBatches,
  setCollapsedBatches,
  collapsedMonths,
  setCollapsedMonths,
}) {
  const [showSubForm, setShowSubForm] = React.useState(null); // batchId or null
  const [subForm, setSubForm] = React.useState({name: '', giltCount: 0, boarCount: 0, originalPigCount: 0, notes: ''});
  const [editSubId, setEditSubId] = React.useState(null);
  const [showArchBatches, setShowArchBatches] = React.useState(false);
  // Tracks whether the parent modal's partition editor has unsaved sub-batch
  // count changes. closeFeederForm reads this so a fast close (<1.5s) still
  // flushes the pending partition write — the shared pigAutoSaveTimer would
  // otherwise be cleared by closeFeederForm and the change lost on reload.
  const partitionDirtyRef = React.useRef(false);
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {
    breedingCycles,
    breeders,
    farrowingRecs,
    feederGroups,
    setFeederGroups,
    feederForm,
    setFeederForm,
    originalFeederForm,
    setOriginalFeederForm,
    showFeederForm,
    setShowFeederForm,
    editFeederId,
    setEditFeederId,
    activeTripBatchId,
    setActiveTripBatchId,
    tripForm,
    setTripForm,
    editTripId,
    setEditTripId,
    boarNames,
  } = usePig();
  const {pigDailys} = useDailysRecent();
  const {setView} = useUI();
  const statusColors = {active: {bg: '#085041', tx: 'white'}, processed: {bg: '#4b5563', tx: 'white'}};
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);
  // Trip source tracking: for each processing trip, which weigh-in session(s)
  // contributed pigs. Pulled from weigh_ins (sent_to_trip_id) + sessions (batch_id).
  const [tripSentWeighins, setTripSentWeighins] = React.useState([]);
  const [tripSessionBatch, setTripSessionBatch] = React.useState({}); // session_id -> batch_id
  React.useEffect(() => {
    (async () => {
      const {data: sent} = await sb
        .from('weigh_ins')
        .select('id, session_id, sent_to_trip_id, weight')
        .not('sent_to_trip_id', 'is', null);
      if (!sent) return;
      setTripSentWeighins(sent);
      const ids = [...new Set(sent.map((e) => e.session_id).filter(Boolean))];
      if (ids.length === 0) return;
      const {data: sess} = await sb.from('weigh_in_sessions').select('id, batch_id').in('id', ids);
      const m = {};
      (sess || []).forEach((s) => {
        m[s.id] = s.batch_id;
      });
      setTripSessionBatch(m);
    })();
  }, []);
  function tripSourceCounts(tripId) {
    if (!tripId) return {};
    const counts = {};
    tripSentWeighins.forEach((e) => {
      if (e.sent_to_trip_id !== tripId) return;
      const name = tripSessionBatch[e.session_id] || 'Unknown session';
      counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
  }

  // ── Pig mortality entries (parent batch with sub-batch attribution) ─────
  // Stored as feederGroup.pigMortalities = [{id, date, sub_batch_id,
  // sub_batch_name, count, comment, team_member, created_at}]. Pure audit
  // log — current pig count keeps coming from dailys; mortality just
  // surfaces the death history with attribution.
  const [mortalityModal, setMortalityModal] = React.useState(null);
  const [mortalityForm, setMortalityForm] = React.useState({sub_batch_id: '', count: '', comment: ''});
  const [mortalityBusy, setMortalityBusy] = React.useState(false);
  const [expandedMortality, setExpandedMortality] = React.useState(null);
  function openMortalityModal(batchId) {
    setMortalityModal({batchId});
    setMortalityForm({sub_batch_id: '', count: '', comment: ''});
  }
  async function saveMortality() {
    if (!mortalityModal) return;
    const count = parseInt(mortalityForm.count);
    if (!Number.isFinite(count) || count <= 0) {
      alert('Enter a count of 1 or more.');
      return;
    }
    setMortalityBusy(true);
    const batchId = mortalityModal.batchId;
    const subId = mortalityForm.sub_batch_id || null;
    const target = feederGroups.find((g) => g.id === batchId);
    const subName = subId ? ((target && target.subBatches) || []).find((s) => s.id === subId)?.name || null : null;
    const entry = {
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      date: todayISO(),
      sub_batch_id: subId,
      sub_batch_name: subName,
      count,
      comment: (mortalityForm.comment || '').trim() || null,
      team_member: (authState && authState.user && authState.user.email) || 'unknown',
      created_at: new Date().toISOString(),
    };
    const nb = feederGroups.map((g) =>
      g.id === batchId ? {...g, pigMortalities: [...(g.pigMortalities || []), entry]} : g,
    );
    setFeederGroups(nb);
    try {
      await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: nb}, {onConflict: 'key'});
    } catch (e) {
      alert('Save failed: ' + (e.message || 'unknown'));
      setMortalityBusy(false);
      return;
    }
    setMortalityBusy(false);
    setMortalityModal(null);
  }
  async function deleteMortality(batchId, entryId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this mortality entry?', async () => {
      const nb = feederGroups.map((g) =>
        g.id === batchId ? {...g, pigMortalities: (g.pigMortalities || []).filter((m) => m.id !== entryId)} : g,
      );
      setFeederGroups(nb);
      try {
        await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: nb}, {onConflict: 'key'});
      } catch (e) {
        alert('Delete failed: ' + (e.message || 'unknown'));
      }
    });
  }

  // Match pig_dailys to a name (case-insensitive) — used for both batch and sub-batch matching
  function dailysForName(name) {
    const n = name.trim().toLowerCase();
    // Also build a slug version for fallback matching
    const slug = n.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return pigDailys.filter((d) => {
      const lbl = (d.batch_label || '').trim().toLowerCase();
      const bid = (d.batch_id || '').trim().toLowerCase();
      const bidSlug = bid.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const lblSlug = lbl.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return lbl === n || bid === n || bidSlug === slug || lblSlug === slug;
    });
  }

  function archiveBatch(batchId) {
    if (!window.confirm('Mark this batch as processed? It will be hidden from the webform.')) return;
    const nb = feederGroups.map((g) =>
      g.id === batchId
        ? {...g, status: 'processed', subBatches: (g.subBatches || []).map((s) => ({...s, status: 'processed'}))}
        : g,
    );
    persistFeeders(nb);
  }
  function unarchiveBatch(batchId) {
    const nb = feederGroups.map((g) => (g.id === batchId ? {...g, status: 'active'} : g));
    persistFeeders(nb);
  }
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
          alert(err);
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
    if (!subForm.name.trim()) {
      alert('Please enter a sub-batch name.');
      return;
    }
    if (!editSubId) {
      const err = validateNewSub(batchId, subForm);
      if (err) {
        alert(err);
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

  // Thin closure over the lib helper that supplies the React-context-bound
  // breedingCycles + farrowingRecs arrays. Keeping the wrapper preserves the
  // existing call-site signature (cycleId, asOfDate?) without ripple changes.
  function calcAgeRange(cycleId, asOfDate) {
    return libCalcAgeRange(cycleId, asOfDate, breedingCycles, farrowingRecs);
  }

  // Trip helpers
  function parseLiveWeights(str) {
    return (str || '')
      .split(/[\s,]+/)
      .map((v) => parseFloat(v))
      .filter((v) => !isNaN(v) && v > 0);
  }
  function tripTotalLive(t) {
    return parseLiveWeights(t.liveWeights).reduce((a, b) => a + b, 0);
  }
  function tripYield(t) {
    const live = tripTotalLive(t);
    const hang = parseFloat(t.hangingWeight) || 0;
    if (!live || !hang) return null;
    return Math.round((hang / live) * 1000) / 10;
  }

  function persistTrip(batchId, formSnapshot, currentTripId) {
    if (!formSnapshot.date) return;
    const tripFormNum = {...formSnapshot};
    ['pigCount', 'hangingWeight'].forEach((key) => {
      const v = tripFormNum[key];
      tripFormNum[key] = v === '' || v == null ? 0 : parseFloat(v) || 0;
    });
    const tripId = currentTripId || String(Date.now());
    const nb = feederGroups.map((g) => {
      if (g.id !== batchId) return g;
      const trips = g.processingTrips || [];
      // Preserve fields not present in the form (subAttributions, any
      // future ad-hoc keys) by spreading the existing trip first when
      // editing. Same shape rule as persistSubBatch.
      const existing = currentTripId ? trips.find((t) => t.id === currentTripId) || {} : {};
      const trip = {...existing, ...tripFormNum, id: tripId};
      const updated = currentTripId ? trips.map((t) => (t.id === currentTripId ? trip : t)) : [...trips, trip];
      updated.sort((a, b) => a.date.localeCompare(b.date));
      const next = {...g, processingTrips: updated};
      // Stamp parent.fcrCached so Transfer-to-Breeding (which reads it
      // from the persisted record) gets the real adjusted-feed / total-
      // live-weight ratio instead of falling back to the 3.5 industry
      // default. Recomputed here on every trip add/edit because the
      // numerator (raw feed) and denominator (trip live wt) both change
      // when trips change. If the helper returns null (no valid trips
      // remaining, or rawFeed <= credits), CLEAR the cache so the transfer
      // flow falls back to the default rather than using a stale ratio.
      const fcr = computePigBatchFCR(next, dailysForName, breeders);
      if (fcr != null) next.fcrCached = fcr;
      else delete next.fcrCached;
      return next;
    });
    persistFeeders(nb);
    if (!editTripId) setEditTripId(tripId);
    return tripId;
  }
  function updTrip(k, v) {
    const next = {...tripForm, [k]: v};
    setTripForm(next);
    if (!next.date) return;
    clearTimeout(tripAutoSaveTimer.current);
    tripAutoSaveTimer.current = setTimeout(() => {
      persistTrip(activeTripBatchId, next, editTripId);
    }, 1500);
  }
  function closeTripForm() {
    clearTimeout(tripAutoSaveTimer.current);
    if (tripForm.date && activeTripBatchId) {
      persistTrip(activeTripBatchId, tripForm, editTripId);
    }
    setTripForm({date: '', pigCount: 0, liveWeights: '', hangingWeight: 0, notes: ''});
    setEditTripId(null);
    setActiveTripBatchId(null);
  }

  function deleteTrip(batchId, tripId) {
    confirmDelete('Delete this processing trip? This cannot be undone.', () => {
      const nb = feederGroups.map((g) => {
        if (g.id !== batchId) return g;
        const next = {...g, processingTrips: (g.processingTrips || []).filter((t) => t.id !== tripId)};
        // Recompute fcrCached after the trip's live weight is removed.
        // If no valid trips remain, CLEAR the cache so the transfer flow
        // falls back to the 3.5 industry default rather than driving
        // future allocations off a stale ratio.
        const fcr = computePigBatchFCR(next, dailysForName, breeders);
        if (fcr != null) next.fcrCached = fcr;
        else delete next.fcrCached;
        return next;
      });
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

  function updFeeder(k, v) {
    const f = {...feederForm, [k]: v};
    // Auto-compute originalPigCount from gilts + boars
    if (k === 'giltCount' || k === 'boarCount')
      f.originalPigCount =
        (parseInt(k === 'giltCount' ? v : f.giltCount) || 0) + (parseInt(k === 'boarCount' ? v : f.boarCount) || 0);
    setFeederForm(f);
    if (editFeederId) {
      clearTimeout(pigAutoSaveTimer.current);
      pigAutoSaveTimer.current = setTimeout(() => {
        // Parse numeric form fields back to numbers (form state holds raw strings during typing)
        const fNum = {...f};
        [
          'giltCount',
          'boarCount',
          'originalPigCount',
          'perLbFeedCost',
          'legacyFeedLbs',
          'feedAllocatedToTransfers',
        ].forEach((key) => {
          const v2 = fNum[key];
          fNum[key] = v2 === '' || v2 == null ? 0 : parseFloat(v2) || 0;
        });
        const existing = feederGroups.find((g) => g.id === editFeederId);
        const grp = {processingTrips: [], subBatches: [], ...existing, ...fNum, id: editFeederId};
        const nb = feederGroups.map((g) => (g.id === editFeederId ? grp : g));
        persistFeeders(nb);
        setOriginalFeederForm(f);
      }, 1500);
    }
  }
  function closeFeederForm() {
    clearTimeout(pigAutoSaveTimer.current);
    if (editFeederId && originalFeederForm) {
      const FEEDER_KEYS = [
        'batchName',
        'cycleId',
        'giltCount',
        'boarCount',
        'startDate',
        'originalPigCount',
        'perLbFeedCost',
        'legacyFeedLbs',
        'notes',
        'status',
        'feedAllocatedToTransfers',
      ];
      const parentChanged = FEEDER_KEYS.some(
        (k) => String(feederForm[k] || '') !== String(originalFeederForm[k] || ''),
      );
      if (parentChanged) {
        // Parse numeric form fields back to numbers. nb uses current
        // feederGroups state, which already includes any optimistic
        // partition edits (setFeederGroups was called in updSubPartition),
        // so a single persist covers both kinds of change.
        const fNum = {...feederForm};
        [
          'giltCount',
          'boarCount',
          'originalPigCount',
          'perLbFeedCost',
          'legacyFeedLbs',
          'feedAllocatedToTransfers',
        ].forEach((key) => {
          const v2 = fNum[key];
          fNum[key] = v2 === '' || v2 == null ? 0 : parseFloat(v2) || 0;
        });
        const existing = feederGroups.find((g) => g.id === editFeederId);
        const grp = {processingTrips: [], subBatches: [], ...existing, ...fNum, id: editFeederId};
        const nb = feederGroups.map((g) => (g.id === editFeederId ? grp : g));
        persistFeeders(nb);
        partitionDirtyRef.current = false;
      } else if (partitionDirtyRef.current) {
        // Parent fields didn't change but a partition edit is pending —
        // flush the in-memory feederGroups state so the close-before-1.5s
        // race doesn't drop the partition repair.
        persistFeeders(feederGroups);
        partitionDirtyRef.current = false;
      }
    }
    setShowFeederForm(false);
    setEditFeederId(null);
    setOriginalFeederForm(null);
  }

  return (
    <div>
      <Header />
      {/* Mortality entry modal — overlay across the page */}
      {mortalityModal &&
        (() => {
          const target = feederGroups.find((g) => g.id === mortalityModal.batchId);
          if (!target) return null;
          const subs = (target.subBatches || []).filter((s) => s.status === 'active');
          return (
            <div
              onClick={() => setMortalityModal(null)}
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,.45)',
                zIndex: 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  background: 'white',
                  borderRadius: 12,
                  width: '100%',
                  maxWidth: 480,
                  boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                }}
              >
                <div
                  style={{
                    padding: '14px 20px',
                    borderBottom: '1px solid #e5e7eb',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div style={{fontSize: 15, fontWeight: 600, color: '#b91c1c'}}>
                    {'💀 Record Mortality — ' + target.batchName}
                  </div>
                  <button
                    onClick={() => setMortalityModal(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: 22,
                      cursor: 'pointer',
                      color: '#9ca3af',
                      lineHeight: 1,
                    }}
                  >
                    {'×'}
                  </button>
                </div>
                <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12}}>
                  <div>
                    <label style={S.label}>Sub-batch (optional)</label>
                    <select
                      value={mortalityForm.sub_batch_id}
                      onChange={(e) => setMortalityForm({...mortalityForm, sub_batch_id: e.target.value})}
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        fontSize: 13,
                        border: '1px solid #d1d5db',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                        boxSizing: 'border-box',
                        background: 'white',
                      }}
                    >
                      <option value="">{'— Whole batch (no sub) —'}</option>
                      {subs.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>{'Count *'}</label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={mortalityForm.count}
                      onChange={(e) => setMortalityForm({...mortalityForm, count: e.target.value})}
                      placeholder="e.g. 1"
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        fontSize: 13,
                        border: '1px solid #d1d5db',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                  <div>
                    <label style={S.label}>Comment / cause (optional)</label>
                    <textarea
                      value={mortalityForm.comment}
                      onChange={(e) => setMortalityForm({...mortalityForm, comment: e.target.value})}
                      rows={2}
                      placeholder="e.g. found dead in pen, suspected respiratory"
                      style={{
                        width: '100%',
                        padding: '8px 10px',
                        fontSize: 13,
                        border: '1px solid #d1d5db',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                        boxSizing: 'border-box',
                        resize: 'vertical',
                      }}
                    />
                  </div>
                  <div style={{fontSize: 11, color: '#6b7280'}}>
                    {'Stamped: ' +
                      todayISO() +
                      ' · ' +
                      ((authState && authState.user && authState.user.email) || 'unknown')}
                  </div>
                </div>
                <div
                  style={{
                    padding: '12px 20px',
                    borderTop: '1px solid #e5e7eb',
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    onClick={() => setMortalityModal(null)}
                    disabled={mortalityBusy}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 7,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: mortalityBusy ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveMortality}
                    disabled={mortalityBusy || !mortalityForm.count}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 7,
                      border: 'none',
                      background: mortalityBusy || !mortalityForm.count ? '#9ca3af' : '#b91c1c',
                      color: 'white',
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: mortalityBusy || !mortalityForm.count ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {mortalityBusy ? 'Saving…' : 'Save Mortality'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      <div style={{padding: '1rem'}}>
        {showUsers && (
          <UsersModal
            sb={sb}
            authState={authState}
            allUsers={allUsers}
            setAllUsers={setAllUsers}
            setShowUsers={setShowUsers}
            loadUsers={loadUsers}
          />
        )}
        <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 12}}>
          <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            {feederGroups.some((g) => g.status === 'processed') && (
              <button
                onClick={() => setShowArchBatches((s) => !s)}
                style={{
                  padding: '7px 14px',
                  borderRadius: 8,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                {showArchBatches ? 'Hide processed' : 'Show processed'} (
                {feederGroups.filter((g) => g.status === 'processed').length})
              </button>
            )}
            <button
              onClick={() => {
                setFeederForm({
                  batchName: '',
                  cycleId: '',
                  giltCount: 0,
                  boarCount: 0,
                  startDate: '',
                  originalPigCount: 0,
                  perLbFeedCost: 0,
                  legacyFeedLbs: 0,
                  notes: '',
                  status: 'active',
                });
                setEditFeederId(null);
                setShowFeederForm(true);
                setActiveTripBatchId(null);
                setShowSubForm(null);
              }}
              style={{
                padding: '7px 18px',
                borderRadius: 8,
                border: 'none',
                background: '#085041',
                color: 'white',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.1,
                fontFamily: 'inherit',
              }}
            >
              + Add Batch
            </button>
          </div>
        </div>

        {/* Add/Edit batch form */}
        {showFeederForm && (
          <div
            onClick={closeFeederForm}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'rgba(0,0,0,.45)',
              zIndex: 500,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '1rem',
              overflowY: 'auto',
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: 'white',
                borderRadius: 12,
                width: '100%',
                maxWidth: 580,
                boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                maxHeight: '90vh',
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid #e5e7eb',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  position: 'sticky',
                  top: 0,
                  background: 'white',
                  zIndex: 1,
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                  <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                    {editFeederId ? 'Edit Pig Batch' : 'Add Pig Batch'}
                  </div>
                  {editFeederId && (
                    <div style={{marginLeft: 8, fontSize: 11, color: '#9ca3af'}}>Auto-saves as you type</div>
                  )}
                  {editFeederId &&
                    (() => {
                      const sorted = [...feederGroups].sort((a, b) =>
                        (a.batchName || '').localeCompare(b.batchName || '', undefined, {numeric: true}),
                      );
                      const idx = sorted.findIndex((g) => g.id === editFeederId);
                      const prev = idx > 0 ? sorted[idx - 1] : null;
                      const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;
                      const ns = (on) => ({
                        padding: '3px 10px',
                        borderRadius: 6,
                        border: '1px solid #d1d5db',
                        background: on ? 'white' : '#f9fafb',
                        color: on ? '#374151' : '#d1d5db',
                        cursor: on ? 'pointer' : 'default',
                        fontSize: 11,
                        fontWeight: 600,
                        fontFamily: 'inherit',
                      });
                      return (
                        <div style={{display: 'flex', gap: 4, alignItems: 'center'}}>
                          <button
                            disabled={!prev}
                            style={ns(!!prev)}
                            onClick={() => {
                              if (prev) {
                                closeFeederForm();
                                setTimeout(() => {
                                  const f = {
                                    batchName: prev.batchName || '',
                                    cycleId: prev.cycleId || '',
                                    giltCount: prev.giltCount || 0,
                                    boarCount: prev.boarCount || 0,
                                    startDate: prev.startDate || '',
                                    originalPigCount: prev.originalPigCount || 0,
                                    perLbFeedCost: prev.perLbFeedCost || 0,
                                    legacyFeedLbs: prev.legacyFeedLbs || 0,
                                    notes: prev.notes || '',
                                    status: prev.status || 'active',
                                  };
                                  setFeederForm(f);
                                  setOriginalFeederForm(f);
                                  setEditFeederId(prev.id);
                                  setShowFeederForm(true);
                                }, 50);
                              }
                            }}
                          >
                            {'\u2039 ' + (prev ? prev.batchName : '\u2014')}
                          </button>
                          <span style={{fontSize: 10, color: '#9ca3af'}}>
                            {idx + 1}/{sorted.length}
                          </span>
                          <button
                            disabled={!next}
                            style={ns(!!next)}
                            onClick={() => {
                              if (next) {
                                closeFeederForm();
                                setTimeout(() => {
                                  const f = {
                                    batchName: next.batchName || '',
                                    cycleId: next.cycleId || '',
                                    giltCount: next.giltCount || 0,
                                    boarCount: next.boarCount || 0,
                                    startDate: next.startDate || '',
                                    originalPigCount: next.originalPigCount || 0,
                                    perLbFeedCost: next.perLbFeedCost || 0,
                                    legacyFeedLbs: next.legacyFeedLbs || 0,
                                    notes: next.notes || '',
                                    status: next.status || 'active',
                                  };
                                  setFeederForm(f);
                                  setOriginalFeederForm(f);
                                  setEditFeederId(next.id);
                                  setShowFeederForm(true);
                                }, 50);
                              }
                            }}
                          >
                            {(next ? next.batchName : '\u2014') + ' \u203a'}
                          </button>
                        </div>
                      );
                    })()}
                </div>
                <button
                  onClick={closeFeederForm}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: 22,
                    cursor: 'pointer',
                    color: '#9ca3af',
                    lineHeight: 1,
                    padding: '0 4px',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{padding: '16px 20px'}}>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>
                      Batch name <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <input
                      value={feederForm.batchName}
                      onChange={(e) => updFeeder('batchName', e.target.value)}
                      placeholder="e.g. Group 2 Fall 2025"
                    />
                  </div>
                  <div>
                    <label style={S.label}>
                      Linked breeding cycle <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <select value={feederForm.cycleId} onChange={(e) => updFeeder('cycleId', e.target.value)}>
                      <option value="">{'\u2014 Select \u2014'}</option>
                      {breedingCycles.map((c) => {
                        const tl = calcBreedingTimeline(c.exposureStart);
                        return (
                          <option key={c.id} value={c.id}>
                            {cycleLabel(c, cycleSeqMap)} —{' '}
                            {tl ? fmtS(tl.farrowingStart) + ' to ' + fmtS(tl.farrowingEnd) : fmtS(c.exposureStart)}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>
                      Status <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <select value={feederForm.status} onChange={(e) => updFeeder('status', e.target.value)}>
                      {['active', 'processed'].map((s) => (
                        <option key={s} value={s}>
                          {s === 'processed' ? 'Processed' : 'Active'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={S.label}>
                      Start date <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <input
                      type="date"
                      value={feederForm.startDate || ''}
                      onChange={(e) => updFeeder('startDate', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={S.label}>
                      Gilts count <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={feederForm.giltCount || ''}
                      onChange={(e) => updFeeder('giltCount', e.target.value)}
                    />
                  </div>
                  <div>
                    <label style={S.label}>
                      Boars count (intact males) <span style={{color: '#dc2626'}}>*</span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={feederForm.boarCount || ''}
                      onChange={(e) => updFeeder('boarCount', e.target.value)}
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Original pig count</label>
                    <div
                      style={{
                        padding: '8px 11px',
                        background: '#f9fafb',
                        border: '1px solid #e5e7eb',
                        borderRadius: 6,
                        fontSize: 13,
                        fontWeight: 600,
                        color: '#374151',
                      }}
                    >
                      {(parseInt(feederForm.giltCount) || 0) + (parseInt(feederForm.boarCount) || 0)}
                    </div>
                    <div style={{fontSize: 11, color: '#9ca3af', marginTop: 2}}>Auto-calculated: gilts + boars</div>
                  </div>
                  {editFeederId &&
                    (() => {
                      const liveGroup = feederGroups.find((x) => x.id === editFeederId);
                      const subs = (liveGroup && liveGroup.subBatches) || [];
                      if (subs.length === 0) return null;
                      const sumG = subs.reduce((s, sb) => s + (parseInt(sb.giltCount) || 0), 0);
                      const sumB = subs.reduce((s, sb) => s + (parseInt(sb.boarCount) || 0), 0);
                      const tgtG = parseInt(feederForm.giltCount) || 0;
                      const tgtB = parseInt(feederForm.boarCount) || 0;
                      const okG = sumG === tgtG;
                      const okB = sumB === tgtB;
                      return (
                        <div
                          style={{
                            gridColumn: '1/-1',
                            border: '1px solid #e5e7eb',
                            borderRadius: 8,
                            padding: '10px 12px',
                            background: '#fafafa',
                          }}
                        >
                          <div style={{fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6}}>
                            Distribute across sub-batches
                          </div>
                          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                            {subs.map((sb) => {
                              const isBoars = (parseInt(sb.boarCount) || 0) > 0 && (parseInt(sb.giltCount) || 0) === 0;
                              const sex = isBoars ? 'Boars' : 'Gilts';
                              const c = isBoars ? parseInt(sb.boarCount) || 0 : parseInt(sb.giltCount) || 0;
                              return (
                                <div
                                  key={sb.id}
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: '1fr 80px 100px',
                                    gap: 8,
                                    alignItems: 'center',
                                  }}
                                >
                                  <span style={{fontSize: 12, color: '#111827', fontWeight: 600}}>{sb.name}</span>
                                  <span
                                    style={{
                                      fontSize: 11,
                                      padding: '3px 8px',
                                      borderRadius: 5,
                                      background: isBoars ? '#dbeafe' : '#d1fae5',
                                      color: isBoars ? '#1e40af' : '#065f46',
                                      textAlign: 'center',
                                      fontWeight: 600,
                                    }}
                                  >
                                    {sex}
                                  </span>
                                  <input
                                    type="number"
                                    min="0"
                                    value={c || ''}
                                    onChange={(e) => updSubPartition(editFeederId, sb.id, e.target.value)}
                                  />
                                </div>
                              );
                            })}
                          </div>
                          <div style={{display: 'flex', gap: 14, marginTop: 8, fontSize: 11}}>
                            <span style={{color: okG ? '#065f46' : '#b91c1c', fontWeight: 600}}>
                              Gilts: {sumG} / {tgtG} {okG ? '✓' : '⚠'}
                            </span>
                            <span style={{color: okB ? '#1e40af' : '#b91c1c', fontWeight: 600}}>
                              Boars: {sumB} / {tgtB} {okB ? '✓' : '⚠'}
                            </span>
                          </div>
                          {(!okG || !okB) && (
                            <div
                              style={{
                                marginTop: 6,
                                fontSize: 11,
                                color: '#b91c1c',
                                background: '#fef2f2',
                                border: '1px solid #fecaca',
                                borderRadius: 5,
                                padding: '5px 9px',
                              }}
                            >
                              Sub totals don’t match parent gilts/boars. Adjust counts above so they sum exactly.
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>
                      Feed credited to breeding transfers (lbs){' '}
                      <span style={{fontWeight: 400, color: '#9ca3af', fontSize: 11}}>
                        {'(subtracted from total feed; set to 0 to clear)'}
                      </span>
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={feederForm.feedAllocatedToTransfers || ''}
                      onChange={(e) => updFeeder('feedAllocatedToTransfers', e.target.value)}
                      placeholder="0"
                    />
                  </div>
                  <div style={{gridColumn: '1/-1'}}>
                    <div style={{fontSize: 11, fontWeight: 700, color: '#4b5563', letterSpacing: 0.5, marginBottom: 6}}>
                      {'\ud83d\udcb0 FEED COST RATE'}{' '}
                      <span style={{fontWeight: 400, color: '#9ca3af'}}>
                        {'(locked \u2014 set in Admin \u203a Feed Costs)'}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: '#374151',
                        padding: '8px 12px',
                        background: '#f9fafb',
                        borderRadius: 8,
                        border: '1px solid #e5e7eb',
                      }}
                    >
                      Pig feed:{' '}
                      <strong>
                        {feederForm.perLbFeedCost !== '' && feederForm.perLbFeedCost != null
                          ? '$' + parseFloat(feederForm.perLbFeedCost).toFixed(3) + '/lb'
                          : '\u2014'}
                      </strong>
                    </div>
                  </div>

                  {feederForm.cycleId && (
                    <div
                      style={{
                        gridColumn: '1/-1',
                        background: '#ecfdf5',
                        border: '1px solid #a7f3d0',
                        borderRadius: 8,
                        padding: '8px 12px',
                        fontSize: 12,
                        color: '#085041',
                      }}
                    >
                      <strong>Age range today:</strong> {calcAgeRange(feederForm.cycleId).text}
                    </div>
                  )}
                  <div style={{gridColumn: '1/-1'}}>
                    <label style={S.label}>Notes</label>
                    <input
                      value={feederForm.notes}
                      onChange={(e) => updFeeder('notes', e.target.value)}
                      placeholder="Any notes about this batch..."
                    />
                  </div>
                </div>
                <div style={{display: 'flex', gap: 8, marginTop: 12}}>
                  {!editFeederId && (
                    <button
                      onClick={() => {
                        if (!feederForm.batchName) {
                          alert('Please enter a batch name.');
                          return;
                        }
                        const grp = {id: String(Date.now()), processingTrips: [], subBatches: [], ...feederForm};
                        const nb = [...feederGroups, grp];
                        persistFeeders(nb);
                        setShowFeederForm(false);
                        setEditFeederId(null);
                        setOriginalFeederForm(null);
                      }}
                      style={{...S.btnPrimary, width: 'auto', padding: '8px 20px'}}
                    >
                      Add batch
                    </button>
                  )}
                  {editFeederId && (
                    <button
                      onClick={() => {
                        confirmDelete('Delete this batch? This cannot be undone.', () => {
                          clearTimeout(pigAutoSaveTimer.current);
                          const nb = feederGroups.filter((g) => g.id !== editFeederId);
                          setFeederGroups(nb);
                          persistFeeders(nb);
                          setShowFeederForm(false);
                          setEditFeederId(null);
                          setOriginalFeederForm(null);
                        });
                      }}
                      style={S.btnDanger}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {feederGroups.filter((g) => g.status !== 'processed').length === 0 && !showFeederForm && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af', fontSize: 13}}>
            No pig batches yet — click "+ Add Batch" to get started
          </div>
        )}

        {feederGroups
          .filter((g) => showArchBatches || g.status !== 'processed')
          .map((g) => {
            const cycle = breedingCycles.find((c) => c.id === g.cycleId);
            const tl = cycle ? calcBreedingTimeline(cycle.exposureStart) : null;
            const sc = statusColors[g.status] || statusColors.active;
            const C = cycle ? PIG_GROUP_COLORS[cycle.group] : null;
            const trips = g.processingTrips || [];
            const totalLive = trips.reduce((s, t) => s + tripTotalLive(t), 0);
            const totalHang = trips.reduce((s, t) => s + (parseFloat(t.hangingWeight) || 0), 0);
            // Carcass yield % only counts trips that have a hanging weight
            // entered. Otherwise a trip with no hanging data drags the
            // denominator (live wt) down without contributing to the
            // numerator, making the % look artificially low.
            const tripsWithHang = trips.filter((t) => (parseFloat(t.hangingWeight) || 0) > 0);
            const yieldHang = tripsWithHang.reduce((s, t) => s + (parseFloat(t.hangingWeight) || 0), 0);
            const yieldLive = tripsWithHang.reduce((s, t) => s + tripTotalLive(t), 0);
            const overallYield =
              yieldLive > 0 && yieldHang > 0 ? Math.round((yieldHang / yieldLive) * 1000) / 10 : null;
            // Sub-batches
            const subBatches = g.subBatches || [];
            const hasSubBatches = subBatches.length > 0;

            // Feed matching by label (case-insensitive) for parent batch
            const batchDailys = hasSubBatches ? [] : dailysForName(g.batchName);
            const dailyFeedTotal = batchDailys.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
            const legacyFeed = parseFloat(g.legacyFeedLbs) || parseFloat(g.totalFeedLbs) || 0;

            // Per-sub ledger metrics. Started counts come from stored fields
            // (no longer mutated by transfers). Transfers + trip attribution
            // + mortality are derived from audit logs. Sub adjusted feed
            // subtracts the per-sub transfer credit (sourced from breeders[],
            // not the parent-aggregate g.feedAllocatedToTransfers, so sub
            // and parent reconcile cleanly).
            const subFeedTotals = subBatches.map((sb) => {
              const sd = dailysForName(sb.name);
              const rawFeedSub =
                sd.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0) + (parseFloat(sb.legacyFeedLbs) || 0);
              const latest =
                [...sd].sort(
                  (a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0,
                )[0] || null;
              const transfers = pigTransfersForSub(breeders, g.batchName, sb.name);
              const tripPigs = pigTripPigsForSub(g.processingTrips || [], sb.id);
              const mortality = pigMortalityForSub(g, sb.name);
              const started = (parseInt(sb.giltCount) || 0) + (parseInt(sb.boarCount) || 0);
              const ledgerCurrent = Math.max(0, started - tripPigs - transfers.count - mortality);
              const currentCount = sb.status === 'processed' ? 0 : ledgerCurrent;
              const dailyCount = latest?.pig_count;
              const adjustedFeed = Math.max(0, rawFeedSub - transfers.feedAllocLbs);
              return {
                sb,
                dailys: sd,
                latestDaily: latest,
                started,
                rawFeed: rawFeedSub,
                transferFeedCredit: transfers.feedAllocLbs,
                adjustedFeed,
                feedTotal: adjustedFeed, // back-compat alias
                transferCount: transfers.count,
                tripPigs,
                mortality,
                ledgerCurrent,
                currentCount,
                dailyCount,
              };
            });
            const subAdjustedFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.adjustedFeed, 0);
            const subRawFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.rawFeed, 0);
            const rawFeed = hasSubBatches ? subRawFeedTotal + legacyFeed : dailyFeedTotal + legacyFeed;
            // Parent aggregate transfer credit: prefer sum-of-subs (canonical
            // from breeders[]); fall back to g.feedAllocatedToTransfers for
            // parent-only batches that never had subs.
            const subTransferFeedTotal = subFeedTotals.reduce((s, sf) => s + sf.transferFeedCredit, 0);
            const parentTransferAgg = pigTransfersForBatch(breeders, g.batchName);
            const feedAllocatedOut = hasSubBatches
              ? subTransferFeedTotal
              : parentTransferAgg.feedAllocLbs || parseFloat(g.feedAllocatedToTransfers) || 0;
            const totalFeed = Math.max(0, rawFeed - feedAllocatedOut);

            // Current pig count: ledger-derived for batches with subs;
            // latest-daily fallback for parent-only batches (no sub
            // attribution available without weigh_in linkage).
            const sortedDailys = hasSubBatches
              ? subFeedTotals
                  .flatMap((sf) => sf.dailys)
                  .sort(
                    (a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0,
                  )
              : [...batchDailys].sort(
                  (a, b) => b.date.localeCompare(a.date) || b.submitted_at?.localeCompare(a.submitted_at || '') || 0,
                );
            const latestDaily = sortedDailys[0] || null;
            let currentPigCount;
            if (hasSubBatches) {
              currentPigCount = subFeedTotals.reduce((s, sf) => s + (sf.currentCount || 0), 0);
            } else {
              const parentTrips = (g.processingTrips || []).reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
              const parentTransfers = parentTransferAgg.count;
              const parentMort = pigMortalityForBatch(g);
              const parentStarted = (parseInt(g.giltCount) || 0) + (parseInt(g.boarCount) || 0);
              currentPigCount =
                parentStarted > 0
                  ? Math.max(0, parentStarted - parentTrips - parentTransfers - parentMort)
                  : (latestDaily?.pig_count ?? null);
            }
            // Freeze age once the batch is empty AND has at least one
            // processor trip — pin the reference date to the latest trip
            // so age stops advancing while the batch lingers archived.
            // Mortality/transfer-only emptying does NOT freeze (no trip
            // date to pin to). If a trip is later edited away and current
            // > 0 again, age resumes using today.
            const latestTripDate =
              trips
                .map((t) => (typeof t?.date === 'string' && t.date ? t.date : null))
                .filter(Boolean)
                .sort()
                .slice(-1)[0] || null;
            const ageRange =
              currentPigCount === 0 && latestTripDate
                ? calcAgeRange(g.cycleId, new Date(latestTripDate + 'T12:00:00'))
                : calcAgeRange(g.cycleId);
            // Started count for denominators: sum-of-subs (for hasSubBatches)
            // or parent stored gilts+boars. Both are now stable across
            // transfers — they reflect what entered the batch.
            const originalPigCount = hasSubBatches
              ? subFeedTotals.reduce((s, sf) => s + sf.started, 0)
              : (parseInt(g.giltCount) || 0) + (parseInt(g.boarCount) || 0) || parseInt(g.originalPigCount) || 0;
            // Feed cost
            const perLbCost = parseFloat(g.perLbFeedCost) || 0;
            const totalFeedCost = totalFeed > 0 && perLbCost > 0 ? totalFeed * perLbCost : null;
            // Feed conversion ratio = total feed / total live weight produced.
            // Standard FCR definition (lbs feed per lb live weight). The old
            // hybrid (avg-feed-per-pig / avg-live-weight) drifted whenever
            // original-count and pigs-processed weren't equal.
            const pigsProcessed = trips.reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0);
            const feedConversion =
              totalFeed > 0 && totalLive > 0 ? Math.round((totalFeed / totalLive) * 100) / 100 : null;
            const showTripForm = activeTripBatchId === g.id;
            const farrowPct = ageRange.total > 0 ? Math.round((ageRange.count / ageRange.total) * 100) : 0;

            return (
              <div
                key={g.id}
                style={{
                  background: 'white',
                  border: `1px solid ${C ? C.farrowing : '#e0e0e0'}`,
                  borderRadius: 10,
                  marginBottom: 14,
                  overflow: 'hidden',
                  fontSize: 12,
                }}
              >
                {/* Batch header */}
                {(() => {
                  const headerBg = C ? C.boar : '#f9f9f9';
                  const ht = getReadableText(headerBg);
                  return (
                    <div
                      style={{
                        padding: '12px 16px',
                        background: headerBg,
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '6px 16px',
                        alignItems: 'center',
                      }}
                    >
                      <strong style={{fontSize: 14, color: ht}}>{g.batchName}</strong>
                      <span style={S.badge('#065f46', 'white')}>Gilts: {g.giltCount}</span>
                      <span style={S.badge('#1e40af', 'white')}>Boars: {g.boarCount}</span>
                      {currentPigCount !== null ? (
                        <span style={{color: ht, fontWeight: 500}}>
                          Current: <strong>{currentPigCount}</strong>
                        </span>
                      ) : (
                        originalPigCount > 0 && (
                          <span style={{color: ht, opacity: 0.85}}>Started: {originalPigCount}</span>
                        )
                      )}
                      <span style={{color: ht, fontWeight: 600}}>
                        Age: {ageRange.text}
                        {!ageRange.hasActual && ageRange.text !== '—' && (
                          <span style={{fontSize: 10, color: ht, opacity: 0.75, marginLeft: 4}}>(estimated)</span>
                        )}
                      </span>
                      {g.startDate && (
                        <span style={{color: ht, fontSize: 11, opacity: 0.85}}>Started {fmt(g.startDate)}</span>
                      )}
                      <span style={S.badge(sc.bg, sc.tx)}>{g.status}</span>
                      <div
                        style={{marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap'}}
                      >
                        {g.status === 'active' ? (
                          <button
                            onClick={() => archiveBatch(g.id)}
                            style={{
                              fontSize: 11,
                              padding: '3px 10px',
                              borderRadius: 5,
                              border: '1px solid #d1d5db',
                              color: '#6b7280',
                              background: 'white',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Mark Processed
                          </button>
                        ) : (
                          <button
                            onClick={() => unarchiveBatch(g.id)}
                            style={{
                              fontSize: 11,
                              padding: '3px 10px',
                              borderRadius: 5,
                              border: '1px solid #085041',
                              color: '#085041',
                              background: 'white',
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Reactivate
                          </button>
                        )}
                        <button
                          onClick={() => openMortalityModal(g.id)}
                          style={{
                            fontSize: 11,
                            padding: '3px 10px',
                            borderRadius: 5,
                            border: '1px solid #fecaca',
                            color: '#b91c1c',
                            background: 'white',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          + Mortality
                        </button>
                        <button
                          onClick={() => {
                            const f = {
                              batchName: g.batchName,
                              cycleId: g.cycleId || '',
                              giltCount: g.giltCount,
                              boarCount: g.boarCount,
                              startDate: g.startDate || '',
                              originalPigCount: g.originalPigCount || 0,
                              perLbFeedCost: g.perLbFeedCost || 0,
                              legacyFeedLbs: g.legacyFeedLbs || 0,
                              feedAllocatedToTransfers: g.feedAllocatedToTransfers || 0,
                              notes: g.notes || '',
                              status: g.status,
                            };
                            setFeederForm(f);
                            setOriginalFeederForm(f);
                            setEditFeederId(g.id);
                            setShowFeederForm(true);
                            setShowSubForm(null);
                          }}
                          style={{
                            fontSize: 11,
                            color: '#1d4ed8',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Summary stats */}
                {(() => {
                  const anyDailys = hasSubBatches
                    ? subFeedTotals.some((sf) => sf.dailys.length > 0)
                    : batchDailys.length > 0;
                  return trips.length > 0 || totalFeed > 0 || anyDailys;
                })() && (
                  <div style={{padding: '10px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb'}}>
                    <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 8}}>
                      {[
                        {
                          label: 'Total feed',
                          val: totalFeed > 0 ? `${Math.round(totalFeed).toLocaleString()} lbs` : '—',
                          color: '#92400e',
                          hint:
                            feedAllocatedOut > 0
                              ? `raw ${Math.round(rawFeed).toLocaleString()} − ${Math.round(feedAllocatedOut).toLocaleString()} transferred out`
                              : dailyFeedTotal > 0 && legacyFeed > 0
                                ? `${Math.round(dailyFeedTotal).toLocaleString()} from dailys + ${Math.round(legacyFeed).toLocaleString()} legacy`
                                : dailyFeedTotal > 0
                                  ? `from ${batchDailys.length} daily reports`
                                  : null,
                        },
                        ...(feedAllocatedOut > 0
                          ? [
                              {
                                label: 'Feed → Breeding',
                                val: `−${Math.round(feedAllocatedOut).toLocaleString()} lbs`,
                                color: '#5b21b6',
                                hint: 'credited to transferred pigs (subtracted above)',
                              },
                            ]
                          : []),
                        {
                          label: 'Lbs per pig',
                          val: (() => {
                            const transferredCount = hasSubBatches
                              ? subFeedTotals.reduce((s, sf) => s + sf.transferCount, 0)
                              : parentTransferAgg.count;
                            const mortalityCount = hasSubBatches
                              ? subFeedTotals.reduce((s, sf) => s + sf.mortality, 0)
                              : pigMortalityForBatch(g);
                            const finishers = Math.max(0, originalPigCount - transferredCount - mortalityCount);
                            return totalFeed > 0 && finishers > 0
                              ? `${Math.round(totalFeed / finishers)} lbs/pig`
                              : '—';
                          })(),
                          color: '#78350f',
                          hint: (() => {
                            const transferredCount = hasSubBatches
                              ? subFeedTotals.reduce((s, sf) => s + sf.transferCount, 0)
                              : parentTransferAgg.count;
                            const mortalityCount = hasSubBatches
                              ? subFeedTotals.reduce((s, sf) => s + sf.mortality, 0)
                              : pigMortalityForBatch(g);
                            const finishers = Math.max(0, originalPigCount - transferredCount - mortalityCount);
                            if (finishers <= 0) return null;
                            const parts = [`adjusted feed ÷ ${finishers}`];
                            if (transferredCount > 0 || mortalityCount > 0) {
                              const subParts = [`${originalPigCount} started`];
                              if (transferredCount > 0) subParts.push(`− ${transferredCount} transferred`);
                              if (mortalityCount > 0) subParts.push(`− ${mortalityCount} mortality`);
                              parts.push(`(${subParts.join(' ')})`);
                            }
                            return parts.join(' ');
                          })(),
                        },
                        {
                          label: 'Feed cost',
                          val: totalFeedCost
                            ? `$${totalFeedCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
                            : '—',
                          color: '#92400e',
                          hint: perLbCost > 0 ? `$${perLbCost}/lb` : null,
                        },
                        {
                          label: 'Feed conversion',
                          val: feedConversion ? `${feedConversion} lbs/lb` : '—',
                          color: '#78350f',
                        },
                        {
                          label: 'Pigs processed',
                          val: trips.reduce((s, t) => s + (parseInt(t.pigCount) || 0), 0),
                          color: '#111827',
                        },
                        {
                          label: 'Total live wt',
                          val: totalLive > 0 ? `${Math.round(totalLive)} lbs` : '—',
                          color: '#1d4ed8',
                        },
                        {label: 'Avg carcass yield', val: overallYield ? `${overallYield}%` : '—', color: '#16a34a'},
                      ].map((s) => (
                        <div
                          key={s.label}
                          style={{
                            textAlign: 'center',
                            background: 'white',
                            border: '1px solid #e5e7eb',
                            borderRadius: 8,
                            padding: '6px 10px',
                          }}
                        >
                          <div
                            style={{
                              fontSize: 10,
                              color: '#9ca3af',
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                              marginBottom: 2,
                            }}
                          >
                            {s.label}
                          </div>
                          <div style={{fontSize: 15, fontWeight: 700, color: s.color}}>{s.val === 0 ? '—' : s.val}</div>
                          {s.hint && <div style={{fontSize: 10, color: '#9ca3af', marginTop: 1}}>{s.hint}</div>}
                        </div>
                      ))}
                    </div>
                    {(() => {
                      const allDailysCount = hasSubBatches
                        ? subFeedTotals.reduce((s, sf) => s + sf.dailys.length, 0)
                        : batchDailys.length;
                      return allDailysCount > 0 ? (
                        <div style={{marginTop: 8, fontSize: 11, color: '#6b7280'}}>
                          <span>
                            📋 {allDailysCount} daily report{allDailysCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                      ) : null;
                    })()}
                  </div>
                )}

                {/* Transferred-to-breeding note (per sub-batch breakdown) */}
                {(() => {
                  const transferred = (breeders || []).filter(
                    (b) => b && b.transferredFromBatch && b.transferredFromBatch.batchName === g.batchName,
                  );
                  if (transferred.length === 0) return null;
                  const bySub = {};
                  transferred.forEach((b) => {
                    const k = b.transferredFromBatch.subBatchName || g.batchName;
                    bySub[k] = (bySub[k] || 0) + 1;
                  });
                  return (
                    <div
                      style={{
                        padding: '8px 16px',
                        borderBottom: '1px solid #e5e7eb',
                        background: '#f5f3ff',
                        fontSize: 12,
                        color: '#5b21b6',
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontWeight: 700}}>{'→ Breeding:'}</span>
                      {Object.entries(bySub).map(([sub, count], i) => (
                        <span key={sub}>
                          {(i > 0 ? ' · ' : '') +
                            count +
                            ' ' +
                            (count === 1 ? 'pig' : 'pigs') +
                            ' out of ' +
                            sub +
                            ' sent to breeding pigs group'}
                        </span>
                      ))}
                    </div>
                  );
                })()}

                {/* Sub-batches panel */}
                <div style={{padding: '10px 16px', borderBottom: '1px solid #e5e7eb'}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563'}}>
                      Sub-batches {subBatches.length > 0 ? `(${subBatches.length})` : ''}
                    </div>
                    <div style={{display: 'flex', gap: 6}}>
                      {showSubForm === g.id && !editSubId ? (
                        <button
                          onClick={() => closeSubForm(g.id)}
                          style={{
                            fontSize: 11,
                            color: '#6b7280',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Close
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            setShowSubForm(g.id);
                            setEditSubId(null);
                            setSubForm({name: '', sex: 'Gilts', count: 0, notes: ''});
                          }}
                          style={{
                            padding: '3px 10px',
                            borderRadius: 5,
                            border: 'none',
                            background: '#ecfdf5',
                            color: '#083d30',
                            cursor: 'pointer',
                            fontSize: 11,
                            fontWeight: 600,
                            fontFamily: 'inherit',
                          }}
                        >
                          + Add sub-batch
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Sub-batch form (modal) */}
                  {showSubForm === g.id && (
                    <div
                      onClick={() => closeSubForm(g.id)}
                      style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: 'rgba(0,0,0,.45)',
                        zIndex: 500,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '1rem',
                      }}
                    >
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          background: 'white',
                          borderRadius: 12,
                          width: '100%',
                          maxWidth: 480,
                          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                        }}
                      >
                        <div
                          style={{
                            padding: '14px 20px',
                            borderBottom: '1px solid #e5e7eb',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                            {editSubId ? 'Edit Sub-batch' : 'New Sub-batch'}{' '}
                            <span style={{fontWeight: 400, color: '#9ca3af', fontSize: 11, marginLeft: 6}}>
                              Auto-saves as you type
                            </span>
                          </div>
                          <button
                            onClick={() => closeSubForm(g.id)}
                            style={{
                              background: 'none',
                              border: 'none',
                              fontSize: 22,
                              cursor: 'pointer',
                              color: '#9ca3af',
                              lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <div style={{padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                          <div style={{gridColumn: '1/-1'}}>
                            <label style={S.label}>Sub-batch name *</label>
                            <input
                              value={subForm.name}
                              onChange={(e) => updSub(g.id, 'name', e.target.value)}
                              placeholder="e.g. P-26-01 A (GILTS)"
                            />
                            <div style={{fontSize: 10, color: '#9ca3af', marginTop: 2}}>
                              Must match the label used on daily reports
                            </div>
                          </div>
                          {!editSubId ? (
                            <>
                              <div>
                                <label style={S.label}>Sex *</label>
                                <select
                                  value={subForm.sex || 'Gilts'}
                                  onChange={(e) => updSub(g.id, 'sex', e.target.value)}
                                >
                                  <option value="Gilts">Gilts</option>
                                  <option value="Boars">Boars</option>
                                </select>
                              </div>
                              <div>
                                <label style={S.label}>Count *</label>
                                <input
                                  type="number"
                                  min="0"
                                  value={subForm.count || ''}
                                  onChange={(e) => updSub(g.id, 'count', e.target.value)}
                                  placeholder={(() => {
                                    const sex = subForm.sex || 'Gilts';
                                    const parentTotal =
                                      sex === 'Boars' ? parseInt(g.boarCount) || 0 : parseInt(g.giltCount) || 0;
                                    const usedBy = (g.subBatches || [])
                                      .filter(
                                        (s) =>
                                          (sex === 'Boars' ? parseInt(s.boarCount) || 0 : parseInt(s.giltCount) || 0) >
                                          0,
                                      )
                                      .reduce(
                                        (a, s) =>
                                          a +
                                          (sex === 'Boars' ? parseInt(s.boarCount) || 0 : parseInt(s.giltCount) || 0),
                                        0,
                                      );
                                    const remaining = Math.max(0, parentTotal - usedBy);
                                    return remaining > 0 ? `Up to ${remaining} available` : '0 available';
                                  })()}
                                />
                              </div>
                            </>
                          ) : (
                            <>
                              <div
                                style={{
                                  gridColumn: '1/-1',
                                  padding: '10px 12px',
                                  background: '#f9fafb',
                                  border: '1px solid #e5e7eb',
                                  borderRadius: 8,
                                }}
                              >
                                <div style={{fontSize: 11, color: '#9ca3af', marginBottom: 4}}>
                                  Sex + count are locked. Edit the parent batch to redistribute.
                                </div>
                                <div
                                  style={{display: 'flex', gap: 14, fontSize: 13, color: '#111827', fontWeight: 600}}
                                >
                                  {(parseInt(subForm.giltCount) || 0) > 0 && <span>Gilts: {subForm.giltCount}</span>}
                                  {(parseInt(subForm.boarCount) || 0) > 0 && <span>Boars: {subForm.boarCount}</span>}
                                  <span style={{color: '#6b7280'}}>
                                    Original count:{' '}
                                    {(parseInt(subForm.giltCount) || 0) + (parseInt(subForm.boarCount) || 0)}
                                  </span>
                                </div>
                              </div>
                            </>
                          )}
                          <div style={{gridColumn: '1/-1'}}>
                            <label style={S.label}>Notes</label>
                            <input
                              value={subForm.notes}
                              onChange={(e) => updSub(g.id, 'notes', e.target.value)}
                              placeholder="Optional"
                            />
                          </div>
                        </div>
                        {editSubId && (
                          <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
                            <button onClick={() => deleteSubBatch(g.id, editSubId)} style={S.btnDanger}>
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {subBatches.length === 0 && showSubForm !== g.id && (
                    <div style={{fontSize: 11, color: '#9ca3af', padding: '2px 0 6px'}}>
                      No sub-batches — daily reports go directly to this batch. Add sub-batches to split A/B groups.
                    </div>
                  )}

                  {subBatches.map((sb) => {
                    const sft = subFeedTotals.find((x) => x.sb.id === sb.id) || {
                      adjustedFeed: 0,
                      rawFeed: 0,
                      transferFeedCredit: 0,
                      dailys: [],
                      latestDaily: null,
                      currentCount: null,
                      started: 0,
                      transferCount: 0,
                      tripPigs: 0,
                      mortality: 0,
                      dailyCount: null,
                    };
                    const sbSc = statusColors[sb.status] || statusColors.active;
                    const dailyVsLedger =
                      sft.dailyCount != null &&
                      sb.status !== 'processed' &&
                      Math.abs((parseInt(sft.dailyCount) || 0) - sft.ledgerCurrent) > 2;
                    return (
                      <div
                        key={sb.id}
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'center',
                          gap: '6px 12px',
                          padding: '8px 10px',
                          borderRadius: 7,
                          border: '1px solid #e5e7eb',
                          marginBottom: 6,
                          background: sb.status === 'processed' ? '#f9fafb' : 'white',
                          opacity: sb.status === 'processed' ? 0.7 : 1,
                        }}
                      >
                        <strong style={{fontSize: 12, color: '#111827'}}>{sb.name}</strong>
                        <span style={S.badge(sbSc.bg, sbSc.tx)}>{sb.status}</span>
                        {sft.started > 0 && (
                          <span style={{fontSize: 11, color: '#374151'}}>
                            Started: <strong>{sft.started}</strong>
                          </span>
                        )}
                        {sft.adjustedFeed > 0 && (
                          <span style={{fontSize: 11, color: '#92400e', fontWeight: 600}}>
                            🌾 {Math.round(sft.adjustedFeed).toLocaleString()} lbs feed
                          </span>
                        )}
                        {(() => {
                          const finishers = Math.max(0, sft.started - sft.transferCount - sft.mortality);
                          return sft.adjustedFeed > 0 && finishers > 0 ? (
                            <span
                              style={{fontSize: 11, color: '#78350f'}}
                              title={`adjusted feed ÷ ${finishers} (started ${sft.started}${sft.transferCount ? ` − ${sft.transferCount} transferred` : ''}${sft.mortality ? ` − ${sft.mortality} mortality` : ''})`}
                            >
                              ({Math.round(sft.adjustedFeed / finishers)} lbs/pig)
                            </span>
                          ) : null;
                        })()}
                        {sft.transferFeedCredit > 0 && (
                          <span
                            style={{fontSize: 10, color: '#6b7280'}}
                            title={`raw ${Math.round(sft.rawFeed).toLocaleString()} − ${Math.round(sft.transferFeedCredit).toLocaleString()} credited to ${sft.transferCount} transferred`}
                          >
                            (−{Math.round(sft.transferFeedCredit).toLocaleString()} → breeding)
                          </span>
                        )}
                        <span style={{fontSize: 11, color: '#111827'}}>🐷 {sft.currentCount} current</span>
                        {dailyVsLedger && (
                          <span
                            style={{
                              fontSize: 10,
                              color: '#b91c1c',
                              background: '#fef2f2',
                              border: '1px solid #fecaca',
                              padding: '1px 6px',
                              borderRadius: 4,
                            }}
                            title="Latest daily count differs from ledger by more than 2"
                          >
                            ⚠ daily {sft.dailyCount}
                          </span>
                        )}
                        {sft.dailys.length > 0 && (
                          <span style={{fontSize: 11, color: '#6b7280'}}>📋 {sft.dailys.length} reports</span>
                        )}

                        <div style={{marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center'}}>
                          {sb.status === 'active' ? (
                            <button
                              onClick={() => archiveSubBatch(g.id, sb.id)}
                              style={{
                                fontSize: 11,
                                padding: '2px 8px',
                                borderRadius: 5,
                                border: '1px solid #d1d5db',
                                color: '#6b7280',
                                background: 'white',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Mark Processed
                            </button>
                          ) : (
                            <button
                              onClick={() => unarchiveSubBatch(g.id, sb.id)}
                              style={{
                                fontSize: 11,
                                padding: '2px 8px',
                                borderRadius: 5,
                                border: '1px solid #085041',
                                color: '#085041',
                                background: 'white',
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                              }}
                            >
                              Reactivate
                            </button>
                          )}
                          <button
                            onClick={() => {
                              clearTimeout(subAutoSaveTimer.current);
                              setShowSubForm(g.id);
                              setEditSubId(sb.id);
                              setSubForm({
                                name: sb.name,
                                giltCount: sb.giltCount || 0,
                                boarCount: sb.boarCount || 0,
                                originalPigCount: sb.originalPigCount || 0,
                                notes: sb.notes || '',
                              });
                            }}
                            style={{
                              fontSize: 11,
                              color: '#1d4ed8',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            Rename
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Processing trips */}
                <div style={{padding: '10px 16px'}}>
                  <div
                    style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8}}
                  >
                    <div style={{fontSize: 12, fontWeight: 600, color: '#4b5563'}}>
                      Processing trips {trips.length > 0 ? `(${trips.length})` : ''}
                    </div>
                    <span style={{fontSize: 10, color: '#9ca3af', fontStyle: 'italic'}}>
                      Trips originate from weigh-ins via Send-to-Trip
                    </span>
                  </div>

                  {/* Trip form (modal) */}
                  {showTripForm && (
                    <div
                      onClick={closeTripForm}
                      style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: 'rgba(0,0,0,.45)',
                        zIndex: 500,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '1rem',
                      }}
                    >
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          background: 'white',
                          borderRadius: 12,
                          width: '100%',
                          maxWidth: 520,
                          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
                        }}
                      >
                        <div
                          style={{
                            padding: '14px 20px',
                            borderBottom: '1px solid #e5e7eb',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <div style={{fontSize: 15, fontWeight: 600, color: '#085041'}}>
                            {editTripId ? 'Edit Processing Trip' : 'New Processing Trip'}{' '}
                            <span style={{fontWeight: 400, color: '#9ca3af', fontSize: 11, marginLeft: 6}}>
                              Auto-saves as you type
                            </span>
                          </div>
                          <button
                            onClick={closeTripForm}
                            style={{
                              background: 'none',
                              border: 'none',
                              fontSize: 22,
                              cursor: 'pointer',
                              color: '#9ca3af',
                              lineHeight: 1,
                            }}
                          >
                            ×
                          </button>
                        </div>
                        <div style={{padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                          <div>
                            <label style={S.label}>Processing date</label>
                            <input
                              type="date"
                              value={tripForm.date}
                              onChange={(e) => updTrip('date', e.target.value)}
                            />
                          </div>
                          <div>
                            <label style={S.label}>Number of pigs</label>
                            <input
                              type="number"
                              min="0"
                              value={tripForm.pigCount || ''}
                              onChange={(e) => updTrip('pigCount', e.target.value)}
                            />
                          </div>
                          <div style={{gridColumn: '1/-1'}}>
                            <label style={S.label}>
                              Live weights — enter each pig's weight separated by commas or spaces
                            </label>
                            <input
                              value={tripForm.liveWeights}
                              onChange={(e) => updTrip('liveWeights', e.target.value)}
                              placeholder="e.g. 245, 268, 231, 255, 240"
                            />
                            {tripForm.liveWeights &&
                              (() => {
                                const wts = parseLiveWeights(tripForm.liveWeights);
                                const total = wts.reduce((a, b) => a + b, 0);
                                const avg = wts.length > 0 ? Math.round(total / wts.length) : 0;
                                return wts.length > 0 ? (
                                  <div style={{fontSize: 11, color: '#085041', marginTop: 3}}>
                                    {wts.length} pigs {'\u00b7'} Total: {Math.round(total)} lbs{'\u00b7'} Avg: {avg}{' '}
                                    lbs/pig
                                  </div>
                                ) : null;
                              })()}
                            {editTripId &&
                              (() => {
                                const counts = tripSourceCounts(editTripId);
                                const keys = Object.keys(counts);
                                if (keys.length === 0) return null;
                                return (
                                  <div
                                    style={{
                                      fontSize: 11,
                                      color: '#065f46',
                                      marginTop: 6,
                                      padding: '5px 9px',
                                      background: '#ecfdf5',
                                      border: '1px solid #a7f3d0',
                                      borderRadius: 5,
                                    }}
                                  >
                                    <strong>Sources:</strong> {keys.map((k) => k + ' (' + counts[k] + ')').join(', ')}
                                  </div>
                                );
                              })()}
                          </div>
                          <div>
                            <label style={S.label}>Hanging weight (lbs) — total for this trip</label>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={tripForm.hangingWeight || ''}
                              onChange={(e) => updTrip('hangingWeight', e.target.value)}
                            />
                            {tripForm.hangingWeight > 0 && tripTotalLive(tripForm) > 0 && (
                              <div style={{fontSize: 11, color: '#16a34a', marginTop: 3}}>
                                Carcass yield: {tripYield(tripForm)}%
                              </div>
                            )}
                          </div>
                          <div>
                            <label style={S.label}>Notes</label>
                            <input
                              value={tripForm.notes}
                              onChange={(e) => updTrip('notes', e.target.value)}
                              placeholder="Any notes for this trip..."
                            />
                          </div>
                        </div>
                        {editTripId && (
                          <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
                            <button
                              onClick={() => {
                                deleteTrip(g.id, editTripId);
                                setActiveTripBatchId(null);
                                setEditTripId(null);
                              }}
                              style={S.btnDanger}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Trip list */}
                  {trips.length === 0 && !showTripForm && (
                    <div style={{color: '#9ca3af', fontSize: 11, padding: '4px 0 8px'}}>
                      No processing trips yet — they’ll appear here once you Send-to-Trip from /pig/weighins
                    </div>
                  )}
                  {trips.map((t, ti) => {
                    const live = tripTotalLive(t);
                    const yld = tripYield(t);
                    const wts = parseLiveWeights(t.liveWeights);
                    const avg = wts.length > 0 ? Math.round(live / wts.length) : 0;
                    return (
                      <div
                        key={t.id}
                        style={{
                          borderTop: '1px solid #e5e7eb',
                          padding: '8px 0',
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '4px 14px',
                          alignItems: 'flex-start',
                        }}
                      >
                        <div style={{fontWeight: 600, minWidth: 90, color: '#111827'}}>{fmt(t.date)}</div>
                        <span>{parseInt(t.pigCount) || 0} pigs</span>
                        {live > 0 && (
                          <span style={{color: '#1d4ed8'}}>
                            Live: {Math.round(live)} lbs{avg > 0 ? ` (avg ${avg} lbs)` : ''}
                          </span>
                        )}
                        {parseFloat(t.hangingWeight) > 0 && (
                          <span style={{color: '#085041'}}>Hang: {parseFloat(t.hangingWeight)} lbs</span>
                        )}
                        {yld !== null && <span style={{color: '#16a34a', fontWeight: 600}}>Yield: {yld}%</span>}
                        {t.notes && <span style={{color: '#9ca3af', fontStyle: 'italic'}}>{t.notes}</span>}
                        <div style={{marginLeft: 'auto', display: 'flex', gap: 8}}>
                          <button
                            onClick={() => {
                              setTripForm({
                                date: t.date,
                                pigCount: t.pigCount,
                                liveWeights: t.liveWeights,
                                hangingWeight: t.hangingWeight,
                                notes: t.notes || '',
                              });
                              setEditTripId(t.id);
                              setActiveTripBatchId(g.id);
                            }}
                            style={{
                              fontSize: 11,
                              color: '#1d4ed8',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => deleteTrip(g.id, t.id)}
                            style={{
                              fontSize: 11,
                              color: '#b91c1c',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
                        </div>
                        {wts.length > 0 && (
                          <div style={{width: '100%', fontSize: 10, color: '#9ca3af', marginTop: 1}}>
                            Weights: {t.liveWeights}
                          </div>
                        )}
                        {(() => {
                          const counts = tripSourceCounts(t.id);
                          const keys = Object.keys(counts);
                          if (keys.length === 0) return null;
                          return (
                            <div style={{width: '100%', fontSize: 11, color: '#065f46', marginTop: 2}}>
                              <strong>From:</strong> {keys.map((k) => k + ' (' + counts[k] + ')').join(', ')}
                            </div>
                          );
                        })()}
                      </div>
                    );
                  })}
                </div>

                {/* Mortality summary (expandable) */}
                {(g.pigMortalities || []).length > 0 &&
                  (() => {
                    const morts = g.pigMortalities || [];
                    const total = morts.reduce((s, m) => s + (parseInt(m.count) || 0), 0);
                    const isOpen = expandedMortality === g.id;
                    return (
                      <div
                        style={{
                          padding: '6px 16px',
                          background: '#fef2f2',
                          borderTop: '1px solid #f3f4f6',
                          fontSize: 11,
                        }}
                      >
                        <div
                          onClick={() => setExpandedMortality(isOpen ? null : g.id)}
                          style={{display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer'}}
                        >
                          <span style={{color: '#9ca3af'}}>{isOpen ? '▼' : '▶'}</span>
                          <span style={{color: '#b91c1c', fontWeight: 600}}>
                            {'💀 ' + total + ' ' + (total === 1 ? 'mortality' : 'mortalities') + ' on record'}
                          </span>
                          <span style={{color: '#9ca3af'}}>
                            {'(' + morts.length + ' ' + (morts.length === 1 ? 'entry' : 'entries') + ')'}
                          </span>
                        </div>
                        {isOpen && (
                          <div style={{marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4}}>
                            {[...morts].reverse().map((m) => (
                              <div
                                key={m.id}
                                style={{
                                  display: 'flex',
                                  gap: 10,
                                  alignItems: 'center',
                                  padding: '4px 8px',
                                  background: 'white',
                                  borderRadius: 5,
                                  border: '1px solid #fde68a',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span style={{color: '#374151', minWidth: 90, fontWeight: 600}}>{fmt(m.date)}</span>
                                <span style={{color: '#b91c1c', fontWeight: 700, minWidth: 32}}>{m.count}</span>
                                <span style={{color: '#6b7280', minWidth: 120}}>
                                  {m.sub_batch_name || 'Whole batch'}
                                </span>
                                {m.comment && (
                                  <span style={{color: '#374151', fontStyle: 'italic', flex: 1, minWidth: 120}}>
                                    {m.comment}
                                  </span>
                                )}
                                <span style={{color: '#9ca3af', fontSize: 10, marginLeft: 'auto'}}>
                                  {m.team_member}
                                </span>
                                <button
                                  onClick={() => deleteMortality(g.id, m.id)}
                                  title="Delete"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: '#b91c1c',
                                    cursor: 'pointer',
                                    fontSize: 13,
                                    lineHeight: 1,
                                    padding: '0 4px',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {'×'}
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                {/* Cycle info footer */}
                {tl && (
                  <div
                    style={{
                      padding: '6px 16px',
                      background: '#ecfdf5',
                      borderTop: '1px solid #e5e7eb',
                      fontSize: 11,
                      color: '#9ca3af',
                    }}
                  >
                    {cycleLabel(cycle, cycleSeqMap)} · Farrowing: {fmtS(tl.farrowingStart)} → {fmtS(tl.farrowingEnd)} ·{' '}
                    {boarNames.boar1}: {cycle.boar1Tags || '—'} · {boarNames.boar2}: {cycle.boar2Tags || '—'}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
