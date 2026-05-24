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
import {addDays, fmt, fmtS, todayISO, toISO} from '../lib/dateUtils.js';
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
  pigSlug,
} from '../lib/pig.js';
import {
  PLANNED_TRIP_MIN_SIZE,
  PLANNED_TRIP_TARGET_WEIGHT_LBS,
  PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
  allocatePlannedTrips,
  recalculateProjections,
  seedGlobalADG,
  movePigsBetweenTrips,
  addPlannedTrip,
  deletePlannedTripWithReconciliation,
} from '../lib/pigForecast.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';
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
  const [activityTarget, setActivityTarget] = React.useState(null);

  React.useEffect(() => {
    function onEntityDeepLink() {
      const dl = window._wcfEntityDeepLink;
      if (!dl || dl.entityType !== 'pig.batch') return;
      const g = (feederGroups || []).find((x) => x.id === dl.entityId);
      if (g) {
        window._wcfEntityDeepLink = null;
        setActivityTarget({entityType: 'pig.batch', entityId: g.id, entityLabel: g.batchName});
      }
    }
    onEntityDeepLink();
    window.addEventListener('wcf-entity-deep-link', onEntityDeepLink);
    return () => window.removeEventListener('wcf-entity-deep-link', onEntityDeepLink);
  }, [feederGroups]);

  const [showSubForm, setShowSubForm] = React.useState(null); // batchId or null
  const [subForm, setSubForm] = React.useState({name: '', giltCount: 0, boarCount: 0, originalPigCount: 0, notes: ''});
  const [editSubId, setEditSubId] = React.useState(null);
  // Inline notice shared across this view's modals + page-level actions
  // (mortality, sub-batch, feeder form, ADG input). Cleared on each
  // action entry; failure paths set + return.
  const [notice, setNotice] = React.useState(null);
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

  // ── Planned-trip forecasting infrastructure (commit 4a) ─────────────────
  // Global ADG: app_store key ppp-pig-global-adg-v1, shape
  //   {manualValue: number | null, updatedAt: ISO | null,
  //    updatedBy: profileId | null}
  // Manual value (when set) overrides the system estimate. System estimate
  // is computed live from pig sessions with usable (ageDays, avgWeightLbs).
  // No reset button per Codex — admin types a new value to change. The
  // null-clearing path (revert to live seed) is parked for a future
  // discussion.
  const [globalAdgRow, setGlobalAdgRow] = React.useState(null); // null=loading, {} after load
  const [adgEditing, setAdgEditing] = React.useState(false);
  const [adgInput, setAdgInput] = React.useState('');
  const [adgSaving, setAdgSaving] = React.useState(false);
  // Planned-trip calendar picker state. The date input is exposed one card
  // at a time; picker changes and day-step buttons autosave immediately.
  const [editingPlannedTripId, setEditingPlannedTripId] = React.useState(null);
  const [editingPlannedTripDate, setEditingPlannedTripDate] = React.useState('');
  // Manual + Add planned-trip form (single open at a time per sub).
  // {groupId, subBatchId, sex} identifies the open form; date and count
  // are the user inputs.
  const [addingTripFor, setAddingTripFor] = React.useState(null);
  const [addingTripDate, setAddingTripDate] = React.useState('');
  const [addingTripCount, setAddingTripCount] = React.useState('');
  const [addingTripError, setAddingTripError] = React.useState('');
  // Planned-trip locks sidecar (Codex pig planned trips lane). Sidecar
  // key: ppp-pig-planned-trip-locks-v1. Shape:
  //   { [tripId]: { locked: true, lockedByName, lockedByUserId, lockedAt } }
  // Locks ride OUTSIDE plannedProcessingTrips so the documented six-key
  // shape (id, date, sex, subBatchId, plannedCount, order) is preserved
  // byte-identical on persisted rows.
  const [plannedTripLocks, setPlannedTripLocks] = React.useState({});
  const [unlockingTripId, setUnlockingTripId] = React.useState(null);
  React.useEffect(() => {
    sb.from('app_store')
      .select('data')
      .eq('key', 'ppp-pig-global-adg-v1')
      .maybeSingle()
      .then(({data}) => {
        if (data && data.data && typeof data.data === 'object') {
          setGlobalAdgRow(data.data);
        } else {
          setGlobalAdgRow({manualValue: null, updatedAt: null, updatedBy: null});
        }
      });
  }, []);
  React.useEffect(() => {
    sb.from('app_store')
      .select('data')
      .eq('key', 'ppp-pig-planned-trip-locks-v1')
      .maybeSingle()
      .then(({data}) => {
        if (data && data.data && typeof data.data === 'object') {
          setPlannedTripLocks(data.data);
        } else {
          setPlannedTripLocks({});
        }
      });
  }, []);

  // Latest pig weigh-in session entries grouped by sub_batch_id (resolved
  // via pigSlug from session.batch_id). Drives the rank-window projection
  // when latest entries exist, and also feeds the system-estimate ADG seed.
  const [pigSessionsForForecast, setPigSessionsForForecast] = React.useState([]);
  const [pigEntriesForForecast, setPigEntriesForForecast] = React.useState([]);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const {data: sessions} = await sb
        .from('weigh_in_sessions')
        .select('id, batch_id, date, status, started_at')
        .eq('species', 'pig')
        .order('date', {ascending: false});
      if (cancelled) return;
      setPigSessionsForForecast(sessions || []);
      const ids = (sessions || []).map((s) => s.id);
      if (ids.length === 0) {
        setPigEntriesForForecast([]);
        return;
      }
      const {data: ents} = await sb.from('weigh_ins').select('session_id, weight').in('session_id', ids);
      if (cancelled) return;
      setPigEntriesForForecast(ents || []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // latestEntriesBySubId: Map<subId, [{weight}]> from the most recent pig
  // session for each sub. Used by recalculateProjections rank-window mode.
  const latestEntriesBySubId = React.useMemo(() => {
    if (pigSessionsForForecast.length === 0) return {};
    // Group sessions by pigSlug(batch_id), pick the latest per slug.
    const latestBySlug = {};
    for (const s of pigSessionsForForecast) {
      const slug = pigSlug(s.batch_id);
      if (!slug) continue;
      const cur = latestBySlug[slug];
      if (!cur || (s.date || '') > (cur.date || '')) latestBySlug[slug] = s;
    }
    // Build slug -> entries map.
    const entriesBySession = {};
    for (const e of pigEntriesForForecast) {
      if (!entriesBySession[e.session_id]) entriesBySession[e.session_id] = [];
      entriesBySession[e.session_id].push(e);
    }
    // Resolve slug -> subBatchId via feederGroups.
    const out = {};
    for (const g of feederGroups || []) {
      for (const sub of g.subBatches || []) {
        const slug = pigSlug(sub.name);
        const sess = latestBySlug[slug];
        if (sess) out[sub.id] = entriesBySession[sess.id] || [];
      }
    }
    return out;
  }, [feederGroups, pigSessionsForForecast, pigEntriesForForecast]);

  // System ADG estimate via seedGlobalADG. Pairs each pig session's avg
  // weight with its age in days at session date. Age = sessionDate − cycle's
  // first farrowing date (or theoretical farrowingStart fallback).
  const systemAdgEstimate = React.useMemo(() => {
    if (pigSessionsForForecast.length === 0) return null;
    const sessAvg = {};
    for (const e of pigEntriesForForecast) {
      const w = parseFloat(e.weight);
      if (!isFinite(w) || w <= 0) continue;
      if (!sessAvg[e.session_id]) sessAvg[e.session_id] = {sum: 0, n: 0};
      sessAvg[e.session_id].sum += w;
      sessAvg[e.session_id].n += 1;
    }
    const usable = [];
    for (const s of pigSessionsForForecast) {
      const ent = sessAvg[s.id];
      if (!ent || ent.n === 0) continue;
      // Resolve cycle for this session via feederGroups.
      const slug = pigSlug(s.batch_id);
      let cycleId = null;
      for (const g of feederGroups || []) {
        for (const sub of g.subBatches || []) {
          if (pigSlug(sub.name) === slug) {
            cycleId = g.cycleId;
            break;
          }
        }
        if (cycleId) break;
      }
      if (!cycleId) continue;
      const ageRange = libCalcAgeRange(cycleId, new Date(s.date + 'T12:00:00'), breedingCycles, farrowingRecs);
      if (ageRange.minDays == null || ageRange.maxDays == null) continue;
      // Use the midpoint of the cycle age range.
      const ageDays = (ageRange.minDays + ageRange.maxDays) / 2;
      usable.push({ageDays, avgWeightLbs: ent.sum / ent.n});
    }
    return seedGlobalADG(usable);
  }, [feederGroups, breedingCycles, farrowingRecs, pigSessionsForForecast, pigEntriesForForecast]);

  // Effective Global ADG: manual value when set, otherwise the live system
  // estimate. null when neither is available.
  const effectiveAdgLbsPerDay =
    globalAdgRow && globalAdgRow.manualValue != null
      ? parseFloat(globalAdgRow.manualValue)
      : systemAdgEstimate
        ? systemAdgEstimate.valueLbsPerDay
        : null;

  function persistGlobalAdg(nextValue) {
    setAdgSaving(true);
    const next = {
      manualValue: nextValue,
      updatedAt: new Date().toISOString(),
      updatedBy: (authState && authState.user && authState.user.id) || null,
    };
    sb.from('app_store')
      .upsert({key: 'ppp-pig-global-adg-v1', data: next}, {onConflict: 'key'})
      .then(({error}) => {
        setAdgSaving(false);
        if (error) {
          console.warn('persistGlobalAdg error:', error.message || error);
          return;
        }
        setGlobalAdgRow(next);
        setAdgEditing(false);
      });
  }

  // ── Planned-trip lock helpers (Codex pig planned trips lane) ────────────
  // Locked trips block MANUAL /pig/batches edits end-to-end — guards live
  // INSIDE the handlers, not only in JSX, so neighbor moves and chain-
  // additions also respect the lock. Send-to-Trip fulfillment from
  // /pig/weighins is intentionally NOT gated by these locks: when an
  // operator sends pigs to a planned trip, the fulfillment flow may
  // reconcile a locked trip's plannedCount (decrement, or remove the
  // trip outright if all its planned pigs are processed) per the
  // existing planned/processing trip contract. The lock only forbids
  // manual date / count / add / delete mutation in this view — the
  // processor date a trip was scheduled with stays intact through
  // fulfillment.
  function isTripLocked(tripId) {
    if (!tripId) return false;
    const entry = plannedTripLocks && plannedTripLocks[tripId];
    return !!(entry && entry.locked);
  }
  function isChainLocked(plannedTrips, subBatchId, sex) {
    if (!Array.isArray(plannedTrips)) return false;
    return plannedTrips.filter((t) => t.subBatchId === subBatchId && t.sex === sex).some((t) => isTripLocked(t.id));
  }
  function persistPlannedTripLocks(next) {
    sb.from('app_store')
      .upsert({key: 'ppp-pig-planned-trip-locks-v1', data: next}, {onConflict: 'key'})
      .then(({error}) => {
        if (error) console.warn('persistPlannedTripLocks error:', error.message || error);
      });
  }
  function lockPlannedTrip(tripId) {
    if (!isManager) return;
    if (!tripId) return;
    const name = (authState && authState.name) || (authState && authState.user && authState.user.email) || 'Unknown';
    const userId = (authState && authState.user && authState.user.id) || null;
    const record = {locked: true, lockedByName: name, lockedByUserId: userId, lockedAt: new Date().toISOString()};
    const next = {...(plannedTripLocks || {}), [tripId]: record};
    setPlannedTripLocks(next);
    persistPlannedTripLocks(next);
  }
  function unlockPlannedTrip(tripId) {
    if (!isManager) return;
    if (!tripId) return;
    const next = {...(plannedTripLocks || {})};
    delete next[tripId];
    setPlannedTripLocks(next);
    persistPlannedTripLocks(next);
    setUnlockingTripId(null);
  }
  // Reconciliation recipient for a delete — mirrors
  // deletePlannedTripWithReconciliation: pigs flow onto the NEXT chain
  // trip, falling back to PREVIOUS if the deleted trip is last in the
  // (subBatchId, sex) chain. Returns the recipient trip object, or null.
  function deleteReconciliationRecipient(plannedTrips, tripId) {
    if (!Array.isArray(plannedTrips)) return null;
    const target = plannedTrips.find((t) => t.id === tripId);
    if (!target) return null;
    const chain = plannedTrips
      .filter((t) => t.subBatchId === target.subBatchId && t.sex === target.sex)
      .slice()
      .sort((a, b) => {
        const dA = a.date || '';
        const dB = b.date || '';
        if (dA === dB) return (a.order || 0) - (b.order || 0);
        return dA.localeCompare(dB);
      });
    const idx = chain.findIndex((t) => t.id === tripId);
    if (idx < 0) return null;
    return chain[idx + 1] || chain[idx - 1] || null;
  }

  // Planned-trip date edit for a single trip. Updates the matching trip's
  // date field and persists. Other fields are preserved via {...t}; the
  // persistable shape stays minimal (id, date, sex, subBatchId,
  // plannedCount, order). recalculateProjections re-runs on the next
  // render with the new daysUntil.
  function setPlannedTripDateById(groupId, tripId, newDate) {
    if (!isManager) return;
    if (isTripLocked(tripId)) return; // Lock guard: target trip locked.
    if (typeof newDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return;
    const nb = feederGroups.map((fg) => {
      if (fg.id !== groupId) return fg;
      return {
        ...fg,
        plannedProcessingTrips: (fg.plannedProcessingTrips || []).map((t) =>
          t.id === tripId ? {...t, date: newDate} : t,
        ),
      };
    });
    persistFeeders(nb);
  }

  function shiftPlannedTripDateById(groupId, tripId, currentDate, deltaDays) {
    if (!isManager) return;
    if (isTripLocked(tripId)) return; // Lock guard: target trip locked.
    if (typeof currentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return;
    const nextDate = toISO(addDays(currentDate, deltaDays));
    if (editingPlannedTripId === tripId) setEditingPlannedTripDate(nextDate);
    setPlannedTripDateById(groupId, tripId, nextDate);
  }

  // Commit 4b — admin count move between two planned trips in the same
  // (subBatchId, sex) pair. Caller already scoped the to-trip to the
  // adjacent same-pair sibling, so the cross-pair guard inside
  // movePigsBetweenTrips is structurally unreachable from this UI; the
  // guard remains as defense in depth. Single-pig moves only for v1
  // (Codex W1); zero-count trips stay visible (Codex W2).
  function movePlannedTripPigsById(groupId, fromTripId, toTripId) {
    if (!isManager) return;
    // Lock guard: blocked when source OR target is locked. Mirrors Codex's
    // neighbor-mutation rule — even a lock on the receiving trip prevents
    // an indirect change.
    if (isTripLocked(fromTripId) || isTripLocked(toTripId)) return;
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return;
    const r = movePigsBetweenTrips(fg.plannedProcessingTrips || [], fromTripId, toTripId, 1);
    if (r.error) {
      console.warn('movePlannedTripPigsById:', r.error);
      return;
    }
    const nb = feederGroups.map((g) => (g.id !== groupId ? g : {...g, plannedProcessingTrips: r.trips}));
    persistFeeders(nb);
  }

  // Manual add (admin/management) — appends a planned trip to the
  // (subBatchId, sex) chain. order = max(existing order in chain) + 1.
  // Date is whatever the user typed; recalculateProjections sorts by
  // date+order so out-of-order dates still render correctly.
  function addPlannedTripById(groupId, {subBatchId, sex, date, plannedCount}) {
    if (!isManager) return {error: 'gated'};
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return {error: 'group not found'};
    // Lock guard: disable Add when ANY existing trip in the same
    // (subBatchId, sex) chain is locked — Codex's "if the add would draw
    // pigs from a locked trip, block it; safest UI is disable Add for
    // that sex chain when any trip in that chain is locked."
    if (isChainLocked(fg.plannedProcessingTrips || [], subBatchId, sex)) {
      return {error: 'chain locked'};
    }
    const r = addPlannedTrip(fg.plannedProcessingTrips || [], {subBatchId, sex, date, plannedCount});
    if (r.error) return r;
    const nb = feederGroups.map((g) => (g.id !== groupId ? g : {...g, plannedProcessingTrips: r.trips}));
    persistFeeders(nb);
    return {ok: true};
  }

  // Delete with reconciliation (admin/management) — removes the trip and
  // moves its plannedCount onto the NEXT chain trip (or PREVIOUS if last).
  // Refuses when chain has only one trip.
  function deletePlannedTripById(groupId, tripId) {
    if (!isManager) return {error: 'gated'};
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return {error: 'group not found'};
    // Lock guard: refuse when the deleted trip OR its reconciliation
    // recipient is locked. Codex's neighbor-mutation rule applies
    // because delete reconciles the deleted trip's plannedCount onto
    // the next (or previous) chain trip.
    if (isTripLocked(tripId)) return {error: 'locked'};
    const recipient = deleteReconciliationRecipient(fg.plannedProcessingTrips || [], tripId);
    if (recipient && isTripLocked(recipient.id)) return {error: 'recipient locked'};
    const r = deletePlannedTripWithReconciliation(fg.plannedProcessingTrips || [], tripId);
    if (r.error) {
      console.warn('deletePlannedTripById:', r.error);
      return r;
    }
    const nb = feederGroups.map((g) => (g.id !== groupId ? g : {...g, plannedProcessingTrips: r.trips}));
    persistFeeders(nb);
    return {ok: true};
  }

  // Auto-allocate planned trips for any (sub, sex) pair that satisfies all
  // requirements (Codex Q2). Idempotent and narrow: never overwrites an
  // existing pair and never writes when requirements are missing.
  React.useEffect(() => {
    if (!feederGroups || feederGroups.length === 0) return;
    if (effectiveAdgLbsPerDay == null) return;
    const today = new Date().toISOString().slice(0, 10);
    let dirty = false;
    const next = feederGroups.map((g) => {
      if (g.status === 'processed' || !g.cycleId) return g;
      const subs = g.subBatches || [];
      if (subs.length === 0) return g;
      const ageRange = libCalcAgeRange(g.cycleId, new Date(today + 'T12:00:00'), breedingCycles, farrowingRecs);
      if (ageRange.minDays == null || ageRange.maxDays == null) return g;
      const planned = Array.isArray(g.plannedProcessingTrips) ? g.plannedProcessingTrips.slice() : [];
      let groupDirty = false;
      for (const sub of subs) {
        if (sub.status === 'processed') continue;
        const giltCount = parseInt(sub.giltCount) || 0;
        const boarCount = parseInt(sub.boarCount) || 0;
        // Sex-mixed subs are flagged in the UI; never auto-allocate (Q1).
        if (giltCount > 0 && boarCount > 0) continue;
        const sex = giltCount > 0 ? 'gilt' : boarCount > 0 ? 'boar' : null;
        if (!sex) continue;
        // Already has planned trips for this (sub, sex) pair — leave alone.
        const existingForPair = planned.filter((t) => t.subBatchId === sub.id && t.sex === sex);
        if (existingForPair.length > 0) continue;
        // Ledger remaining for this sub. Mortality + transfers + real-trip
        // attributions are sex-agnostic in current data; for v1 we treat
        // a single-sex sub's remaining as the whole ledger remainder.
        const transfers = pigTransfersForSub(breeders, g.batchName, sub.name);
        const tripPigs = pigTripPigsForSub(g.processingTrips || [], sub.id);
        const mortality = pigMortalityForSub(g, sub.name);
        const started = giltCount + boarCount;
        const remaining = Math.max(0, started - tripPigs - transfers.count - mortality);
        if (remaining <= 0) continue;
        // Forecasted ready start date. Anchor on latest entries when
        // available; fall back to cycle age + ADG. Clamp to today.
        const latest = latestEntriesBySubId[sub.id] || [];
        const adg = effectiveAdgLbsPerDay;
        let anchorWeight = null;
        let anchorDate = today;
        if (latest.length > 0) {
          const sumW = latest.reduce((s, e) => s + (parseFloat(e.weight) || 0), 0);
          const cnt = latest.filter((e) => parseFloat(e.weight) > 0).length;
          if (cnt > 0) anchorWeight = sumW / cnt;
        } else {
          // Use the OLDEST cycle age (so heavier pigs lead the ready date).
          anchorWeight = ageRange.maxDays * adg;
        }
        let readyDate = today;
        if (anchorWeight != null && adg > 0) {
          const daysToReady = Math.max(0, (PLANNED_TRIP_TARGET_WEIGHT_LBS - anchorWeight) / adg);
          const d = new Date(anchorDate + 'T12:00:00');
          d.setDate(d.getDate() + Math.ceil(daysToReady));
          const candidate = d.toISOString().slice(0, 10);
          readyDate = candidate < today ? today : candidate;
        }
        const allocated = allocatePlannedTrips({
          remainingCount: remaining,
          sex,
          subBatchId: sub.id,
          startDate: readyDate,
        });
        if (allocated.length > 0) {
          for (const t of allocated) planned.push(t);
          groupDirty = true;
        }
      }
      if (groupDirty) {
        dirty = true;
        return {...g, plannedProcessingTrips: planned};
      }
      return g;
    });
    if (dirty) persistFeeders(next);
    // sb is a stable prop; persistFeeders reads from latest feederGroups
    // through the closure. eslint-disable matches the file's existing
    // pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feederGroups, breedingCycles, farrowingRecs, breeders, latestEntriesBySubId, effectiveAdgLbsPerDay]);

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
    setNotice(null);
    setMortalityModal({batchId});
    setMortalityForm({sub_batch_id: '', count: '', comment: ''});
  }
  async function saveMortality() {
    if (!mortalityModal) return;
    setNotice(null);
    const count = parseInt(mortalityForm.count);
    if (!Number.isFinite(count) || count <= 0) {
      setNotice({kind: 'error', message: 'Enter a count of 1 or more.'});
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
      setNotice({kind: 'error', message: 'Save failed: ' + (e.message || 'unknown')});
      setMortalityBusy(false);
      return;
    }
    setMortalityBusy(false);
    setMortalityModal(null);
  }
  async function deleteMortality(batchId, entryId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this mortality entry?', async () => {
      setNotice(null);
      const nb = feederGroups.map((g) =>
        g.id === batchId ? {...g, pigMortalities: (g.pigMortalities || []).filter((m) => m.id !== entryId)} : g,
      );
      setFeederGroups(nb);
      try {
        await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: nb}, {onConflict: 'key'});
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || 'unknown')});
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
    window._wcfConfirm(
      'Mark this batch as processed? It will be hidden from the webform.',
      () => {
        const nb = feederGroups.map((g) =>
          g.id === batchId
            ? {...g, status: 'processed', subBatches: (g.subBatches || []).map((s) => ({...s, status: 'processed'}))}
            : g,
        );
        persistFeeders(nb);
      },
      'Mark Processed',
    );
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
    setNotice(null);
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

  // Planned-trip mutation gate: admin OR management can mutate, farm_team
  // is read-only. Per Codex's pig-planned-trips lane spec — applies to the
  // inline date editor, manual Add, Delete, and the ← / → move arrows.
  const isManager = !!(authState && (authState.role === 'admin' || authState.role === 'management'));
  return (
    <div>
      <Header />
      <div style={{padding: '0 12px'}}>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      </div>
      {/* Global ADG (commit 4a). Manual override + live system estimate.
        Manager-and-above (admin role for v1) can edit; operators read-only.
        Persists to app_store ppp-pig-global-adg-v1. No reset button per
        Codex; admin types a new value to change. */}
      <div
        style={{
          padding: '10px 14px',
          margin: '8px 12px',
          background: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
          <span style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600}}>Global ADG</span>
          {!adgEditing && (
            <span style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>
              {effectiveAdgLbsPerDay != null
                ? `${(Math.round(effectiveAdgLbsPerDay * 100) / 100).toFixed(2)} lb/day`
                : '— Projection unavailable'}
            </span>
          )}
          {!adgEditing && globalAdgRow && globalAdgRow.manualValue != null && (
            <span
              style={{
                fontSize: 10,
                color: '#92400e',
                background: '#fef3c7',
                padding: '2px 8px',
                borderRadius: 10,
                fontWeight: 600,
              }}
            >
              MANUAL
            </span>
          )}
          {!adgEditing && isManager && (
            <button
              onClick={() => {
                setAdgInput(effectiveAdgLbsPerDay != null ? String(Math.round(effectiveAdgLbsPerDay * 100) / 100) : '');
                setAdgEditing(true);
              }}
              style={{
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                color: '#1d4ed8',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Edit
            </button>
          )}
          {adgEditing && (
            <>
              <input
                type="number"
                step="0.01"
                min="0"
                value={adgInput}
                onChange={(e) => setAdgInput(e.target.value)}
                placeholder="lb/day"
                style={{
                  fontSize: 13,
                  padding: '4px 8px',
                  border: '1px solid #d1d5db',
                  borderRadius: 6,
                  width: 110,
                  fontFamily: 'inherit',
                }}
              />
              <button
                onClick={() => {
                  setNotice(null);
                  const v = parseFloat(adgInput);
                  if (!isFinite(v) || v <= 0) {
                    setNotice({kind: 'error', message: 'Enter a positive number for Global ADG.'});
                    return;
                  }
                  persistGlobalAdg(v);
                }}
                disabled={adgSaving}
                style={{
                  fontSize: 11,
                  padding: '4px 12px',
                  borderRadius: 6,
                  border: '1px solid #085041',
                  background: '#085041',
                  color: 'white',
                  cursor: adgSaving ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {adgSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => setAdgEditing(false)}
                style={{
                  fontSize: 11,
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        <div style={{fontSize: 10, color: '#6b7280'}}>
          {systemAdgEstimate
            ? `System estimate: ${(Math.round(systemAdgEstimate.valueLbsPerDay * 100) / 100).toFixed(2)} lb/day from ${systemAdgEstimate.sampleCount} session${systemAdgEstimate.sampleCount === 1 ? '' : 's'}`
            : 'System estimate: — (need pig sessions with weights and known age)'}
          {globalAdgRow && globalAdgRow.manualValue != null && globalAdgRow.updatedAt
            ? ` · manual set ${(globalAdgRow.updatedAt || '').slice(0, 10)}`
            : ''}
        </div>
      </div>
      {/* Mortality entry modal — overlay across the page */}
      {mortalityModal &&
        (() => {
          const target = feederGroups.find((g) => g.id === mortalityModal.batchId);
          if (!target) return null;
          const subs = (target.subBatches || []).filter((s) => s.status === 'active');
          return (
            <div
              onClick={() => {
                setNotice(null);
                setMortalityModal(null);
              }}
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
                    onClick={() => {
                      setNotice(null);
                      setMortalityModal(null);
                    }}
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
                  <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
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
                setNotice(null);
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
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
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
                    <select
                      value={feederForm.cycleId}
                      onChange={(e) => updFeeder('cycleId', e.target.value)}
                      data-feeder-cycle-select
                    >
                      <option value="">{'\u2014 Select \u2014'}</option>
                      {breedingCycles
                        .filter((c) => {
                          // Commit 5 — hide cycles already linked to ANOTHER
                          // pig batch. Edit mode keeps the self-batch's
                          // cycle visible by excluding self from the link
                          // set. Empty cycleId entries are ignored.
                          if (!editFeederId) {
                            // Add mode: any other batch linking this cycle hides it.
                            return !(feederGroups || []).some((fg) => fg.cycleId === c.id);
                          }
                          // Edit mode: only exclude OTHER batches.
                          return !(feederGroups || []).some((fg) => fg.id !== editFeederId && fg.cycleId === c.id);
                        })
                        .map((c) => {
                          const tl = calcBreedingTimeline(c.exposureStart);
                          return (
                            <option key={c.id} value={c.id}>
                              {cycleLabel(c, cycleSeqMap)} —{' '}
                              {tl ? fmtS(tl.farrowingStart) + ' to ' + fmtS(tl.farrowingEnd) : fmtS(c.exposureStart)}
                            </option>
                          );
                        })}
                    </select>
                    {/* Commit 5 empty-state hint: shown only in Add mode
                      when every breeding cycle is already linked. Edit
                      mode never hits this branch because the self batch's
                      own cycle stays visible. */}
                    {!editFeederId &&
                      breedingCycles.filter((c) => !(feederGroups || []).some((fg) => fg.cycleId === c.id)).length ===
                        0 && (
                        <div
                          data-feeder-cycle-empty-hint
                          style={{fontSize: 11, color: '#92400e', fontStyle: 'italic', marginTop: 4}}
                        >
                          All breeding cycles are already linked to a pig batch. Add a new breeding cycle in the
                          Breeding tab before creating another batch.
                        </div>
                      )}
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
                        setNotice(null);
                        if (!feederForm.batchName) {
                          setNotice({kind: 'error', message: 'Please enter a batch name.'});
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
                      <span onClick={(e) => e.stopPropagation()} data-activity-surface="pig.batch">
                        {React.createElement(ActivityPanel, {
                          sb,
                          authState,
                          entityType: 'pig.batch',
                          entityId: g.id,
                          entityLabel: g.batchName,
                          mode: 'compact',
                          onCompactClick: setActivityTarget,
                        })}
                      </span>
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
                            setNotice(null);
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
                            setNotice(null);
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
                            <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
                          </div>
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
                    // Planned-trip projection for this sub (commit 4a).
                    // Read-only render — date/count edit controls land in
                    // commit 4b. Cycle age + Global ADG drive the
                    // pre-weigh-in band; latestEntriesBySubId drives the
                    // rank-window band when entries exist.
                    const subGiltCount = parseInt(sb.giltCount) || 0;
                    const subBoarCount = parseInt(sb.boarCount) || 0;
                    const isMixedSex = subGiltCount > 0 && subBoarCount > 0;
                    const todayStr = todayISO();
                    const cycleAgeForRender = g.cycleId
                      ? libCalcAgeRange(g.cycleId, new Date(todayStr + 'T12:00:00'), breedingCycles, farrowingRecs)
                      : null;
                    const cycleAgeDaysAtRef =
                      cycleAgeForRender && cycleAgeForRender.minDays != null
                        ? {minDays: cycleAgeForRender.minDays, maxDays: cycleAgeForRender.maxDays}
                        : null;
                    const plannedRawForSub = (g.plannedProcessingTrips || []).filter((t) => t.subBatchId === sb.id);
                    const plannedProjected = recalculateProjections(plannedRawForSub, {
                      latestEntries: latestEntriesBySubId[sb.id] || [],
                      referenceDate: todayStr,
                      globalAdgLbsPerDay: effectiveAdgLbsPerDay,
                      cycleAgeDaysAtRef,
                      targetWeightLbs: PLANNED_TRIP_TARGET_WEIGHT_LBS,
                      minSize: PLANNED_TRIP_MIN_SIZE,
                      overWeightWarnLbs: PLANNED_TRIP_OVER_WEIGHT_WARN_LBS,
                    });
                    return (
                      <React.Fragment key={sb.id}>
                        <div
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
                          <span
                            style={{
                              fontSize: 11,
                              color: '#111827',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                            }}
                          >
                            <PlannerIcon iconKey={ANIMAL_ICON_KEYS.pig} size={14} />
                            {sft.currentCount} current
                          </span>
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
                                setNotice(null);
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
                        {/* Planned trips for this sub (commit 4a, read-only).
                        Compact band beneath the sub row. Cards show date,
                        count, projected weight range, ready badge, and
                        warnings. Edit controls land in commit 4b. */}
                        {sb.status !== 'processed' && (
                          <div
                            data-planned-trips-sub={sb.id}
                            style={{
                              margin: '0 0 8px 0',
                              padding: '6px 10px',
                              borderRadius: 7,
                              border: '1px dashed #d1d5db',
                              background: '#fafafa',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 10,
                                color: '#6b7280',
                                textTransform: 'uppercase',
                                fontWeight: 600,
                                marginBottom: 6,
                              }}
                            >
                              Planned trips (forecast)
                            </div>
                            {isMixedSex && (
                              <div style={{fontSize: 11, color: '#92400e', fontStyle: 'italic'}}>
                                Mixed sex sub: split into separate gilts/boars subgroups before planning trips.
                              </div>
                            )}
                            {!isMixedSex && !g.cycleId && (
                              <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                                Link a breeding cycle to see planned trips.
                              </div>
                            )}
                            {!isMixedSex && g.cycleId && effectiveAdgLbsPerDay == null && (
                              <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                                Set Global ADG above to see planned trips.
                              </div>
                            )}
                            {!isMixedSex &&
                              g.cycleId &&
                              effectiveAdgLbsPerDay != null &&
                              plannedProjected.length === 0 && (
                                <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                                  Projection unavailable — cycle age range not yet usable.
                                </div>
                              )}
                            {/* Manual + Add planned trip (admin/management only).
                              Sex comes from the sub itself (non-mixed subs are
                              gilt-only or boar-only). Mixed-sex hint above already
                              tells the user to split before planning. Date is
                              free-form per Codex's pre-build answer #2 — the chain
                              re-sorts by date+order on render. */}
                            {!isMixedSex && isManager && (
                              <div data-planned-trip-add-shell={sb.id} style={{marginBottom: 6}}>
                                {addingTripFor && addingTripFor.subBatchId === sb.id ? (
                                  <div
                                    style={{
                                      display: 'flex',
                                      gap: 6,
                                      flexWrap: 'wrap',
                                      alignItems: 'center',
                                      background: 'white',
                                      border: '1px solid #d1d5db',
                                      borderRadius: 6,
                                      padding: '6px 8px',
                                      fontSize: 11,
                                    }}
                                  >
                                    <input
                                      data-planned-trip-add-date={sb.id}
                                      type="date"
                                      value={addingTripDate}
                                      onChange={(e) => setAddingTripDate(e.target.value)}
                                      style={{
                                        fontSize: 11,
                                        padding: '2px 4px',
                                        border: '1px solid #d1d5db',
                                        borderRadius: 5,
                                        fontFamily: 'inherit',
                                        width: 132,
                                        minWidth: 132,
                                        maxWidth: 132,
                                        flex: '0 0 132px',
                                        boxSizing: 'border-box',
                                      }}
                                    />
                                    <input
                                      data-planned-trip-add-count={sb.id}
                                      type="number"
                                      min={1}
                                      placeholder="pigs"
                                      value={addingTripCount}
                                      onChange={(e) => setAddingTripCount(e.target.value)}
                                      style={{
                                        fontSize: 11,
                                        padding: '2px 4px',
                                        border: '1px solid #d1d5db',
                                        borderRadius: 5,
                                        fontFamily: 'inherit',
                                        width: 70,
                                      }}
                                    />
                                    <span style={{color: '#6b7280'}}>{addingTripFor.sex}</span>
                                    <button
                                      data-planned-trip-add-save={sb.id}
                                      onClick={() => {
                                        const r = addPlannedTripById(g.id, {
                                          subBatchId: sb.id,
                                          sex: addingTripFor.sex,
                                          date: addingTripDate,
                                          plannedCount: parseInt(addingTripCount),
                                        });
                                        if (r && r.error) {
                                          setAddingTripError(r.error);
                                          return;
                                        }
                                        setAddingTripFor(null);
                                        setAddingTripDate('');
                                        setAddingTripCount('');
                                        setAddingTripError('');
                                      }}
                                      style={{
                                        fontSize: 10,
                                        padding: '3px 10px',
                                        borderRadius: 5,
                                        border: '1px solid #085041',
                                        background: '#085041',
                                        color: 'white',
                                        cursor: 'pointer',
                                        fontFamily: 'inherit',
                                      }}
                                    >
                                      Add
                                    </button>
                                    <button
                                      onClick={() => {
                                        setAddingTripFor(null);
                                        setAddingTripDate('');
                                        setAddingTripCount('');
                                        setAddingTripError('');
                                      }}
                                      style={{
                                        fontSize: 10,
                                        padding: '3px 10px',
                                        borderRadius: 5,
                                        border: '1px solid #d1d5db',
                                        background: 'white',
                                        color: '#6b7280',
                                        cursor: 'pointer',
                                        fontFamily: 'inherit',
                                      }}
                                    >
                                      Cancel
                                    </button>
                                    {addingTripError && (
                                      <span
                                        data-planned-trip-add-error={sb.id}
                                        style={{color: '#b91c1c', fontSize: 10, fontStyle: 'italic'}}
                                      >
                                        {addingTripError}
                                      </span>
                                    )}
                                  </div>
                                ) : (
                                  (() => {
                                    // Codex pig planned trips lane: when ANY trip in a
                                    // (subBatchId, sex) chain is locked, disable Add for
                                    // that chain — an add would draw pigs from the locked
                                    // chain's plannedCount reservoir.
                                    const giltChainLocked = isChainLocked(
                                      g.plannedProcessingTrips || [],
                                      sb.id,
                                      'gilt',
                                    );
                                    const boarChainLocked = isChainLocked(
                                      g.plannedProcessingTrips || [],
                                      sb.id,
                                      'boar',
                                    );
                                    return (
                                      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap'}}>
                                        {(parseInt(sb.giltCount) || 0) > 0 && (
                                          <button
                                            data-planned-trip-add-button={`${sb.id}-gilt`}
                                            data-planned-trip-add-locked={giltChainLocked ? 'true' : 'false'}
                                            disabled={giltChainLocked}
                                            onClick={() => {
                                              if (giltChainLocked) return;
                                              setAddingTripFor({groupId: g.id, subBatchId: sb.id, sex: 'gilt'});
                                              setAddingTripDate(new Date().toISOString().slice(0, 10));
                                              setAddingTripCount('');
                                              setAddingTripError('');
                                            }}
                                            style={{
                                              fontSize: 10,
                                              padding: '3px 10px',
                                              borderRadius: 5,
                                              border: '1px solid #1d4ed8',
                                              background: giltChainLocked ? '#f3f4f6' : 'white',
                                              color: giltChainLocked ? '#9ca3af' : '#1d4ed8',
                                              cursor: giltChainLocked ? 'not-allowed' : 'pointer',
                                              fontFamily: 'inherit',
                                              fontWeight: 600,
                                              opacity: giltChainLocked ? 0.6 : 1,
                                            }}
                                            title={
                                              giltChainLocked
                                                ? 'Gilt chain has a locked trip — unlock first'
                                                : undefined
                                            }
                                          >
                                            + Add gilt trip
                                          </button>
                                        )}
                                        {(parseInt(sb.boarCount) || 0) > 0 && (
                                          <button
                                            data-planned-trip-add-button={`${sb.id}-boar`}
                                            data-planned-trip-add-locked={boarChainLocked ? 'true' : 'false'}
                                            disabled={boarChainLocked}
                                            onClick={() => {
                                              if (boarChainLocked) return;
                                              setAddingTripFor({groupId: g.id, subBatchId: sb.id, sex: 'boar'});
                                              setAddingTripDate(new Date().toISOString().slice(0, 10));
                                              setAddingTripCount('');
                                              setAddingTripError('');
                                            }}
                                            style={{
                                              fontSize: 10,
                                              padding: '3px 10px',
                                              borderRadius: 5,
                                              border: '1px solid #1d4ed8',
                                              background: boarChainLocked ? '#f3f4f6' : 'white',
                                              color: boarChainLocked ? '#9ca3af' : '#1d4ed8',
                                              cursor: boarChainLocked ? 'not-allowed' : 'pointer',
                                              fontFamily: 'inherit',
                                              fontWeight: 600,
                                              opacity: boarChainLocked ? 0.6 : 1,
                                            }}
                                            title={
                                              boarChainLocked
                                                ? 'Boar chain has a locked trip — unlock first'
                                                : undefined
                                            }
                                          >
                                            + Add boar trip
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })()
                                )}
                              </div>
                            )}
                            {!isMixedSex &&
                              g.cycleId &&
                              effectiveAdgLbsPerDay != null &&
                              plannedProjected.length > 0 && (
                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                                    gap: 6,
                                  }}
                                >
                                  {plannedProjected.map((t, ti) => {
                                    const projRange =
                                      t.projectedMinLbs != null && t.projectedMaxLbs != null
                                        ? `${Math.round(t.projectedMinLbs)} – ${Math.round(t.projectedMaxLbs)} lb`
                                        : '—';
                                    const projAvg =
                                      t.projectedAvgLbs != null ? `~${Math.round(t.projectedAvgLbs)} lb avg` : '';
                                    // Move targets within this (sub, sex) chain. plannedProjected
                                    // is already sorted by (date, order). nextSameSex receives
                                    // forward moves; prevSameSex receives back moves.
                                    const nextSameSex = plannedProjected.slice(ti + 1).find((nt) => nt.sex === t.sex);
                                    const prevSameSex = plannedProjected
                                      .slice(0, ti)
                                      .reverse()
                                      .find((pt) => pt.sex === t.sex);
                                    // Chain trip count for THIS sex governs the delete-disable.
                                    // A chain of one trip cannot be deleted (deletion would
                                    // lose the planned-count signal).
                                    const sameSexChainCount = plannedProjected.filter((ct) => ct.sex === t.sex).length;
                                    const canDelete = isManager && sameSexChainCount > 1;
                                    const isEditingDate = editingPlannedTripId === t.id;
                                    // Lock state for this card. Locked trips hide every
                                    // mutation affordance (date, ±1d, move, delete) so
                                    // operators can only re-enable mutation by going
                                    // through the inline two-step unlock.
                                    const lockEntry = plannedTripLocks && plannedTripLocks[t.id];
                                    const tripLocked = !!(lockEntry && lockEntry.locked);
                                    const lockedByLabel = tripLocked
                                      ? 'Locked by user: ' + (lockEntry.lockedByName || 'Unknown')
                                      : null;
                                    return (
                                      <div
                                        key={t.id}
                                        data-planned-trip-id={t.id}
                                        data-planned-trip-sex={t.sex}
                                        data-planned-trip-locked={tripLocked ? 'true' : 'false'}
                                        style={{
                                          background: tripLocked ? '#f9fafb' : 'white',
                                          border: tripLocked ? '1px solid #cbd5f5' : '1px solid #e5e7eb',
                                          borderRadius: 6,
                                          padding: '6px 10px',
                                          fontSize: 11,
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: 2,
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            gap: 4,
                                            flexWrap: 'wrap',
                                          }}
                                        >
                                          <span style={{fontWeight: 700, color: '#111827'}}>{fmt(t.date)}</span>
                                          {tripLocked && (
                                            <span
                                              data-planned-trip-locked-by={t.id}
                                              style={{
                                                fontSize: 10,
                                                fontWeight: 700,
                                                padding: '2px 8px',
                                                borderRadius: 10,
                                                background: '#eef2ff',
                                                color: '#3730a3',
                                                border: '1px solid #c7d2fe',
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: 4,
                                              }}
                                              title={
                                                lockEntry && lockEntry.lockedAt
                                                  ? 'Locked ' + fmt(lockEntry.lockedAt)
                                                  : undefined
                                              }
                                            >
                                              🔒 {lockedByLabel}
                                            </span>
                                          )}
                                          {!tripLocked && isManager && (
                                            <div style={{display: 'inline-flex', gap: 3, alignItems: 'center'}}>
                                              <button
                                                data-planned-trip-edit-date={t.id}
                                                onClick={() => {
                                                  if (isEditingDate) {
                                                    setEditingPlannedTripId(null);
                                                    setEditingPlannedTripDate('');
                                                    return;
                                                  }
                                                  setEditingPlannedTripId(t.id);
                                                  setEditingPlannedTripDate(t.date || '');
                                                }}
                                                style={{
                                                  fontSize: 11,
                                                  width: 24,
                                                  height: 22,
                                                  padding: 0,
                                                  borderRadius: 5,
                                                  border: '1px solid #bfdbfe',
                                                  background: '#eff6ff',
                                                  color: '#1d4ed8',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                  display: 'inline-flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                }}
                                                title="Open planned trip calendar"
                                              >
                                                📅
                                              </button>
                                              <button
                                                data-planned-trip-date-back={t.id}
                                                onClick={() => shiftPlannedTripDateById(g.id, t.id, t.date, -1)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 5px',
                                                  borderRadius: 5,
                                                  border: '1px solid #bfdbfe',
                                                  background: 'white',
                                                  color: '#1d4ed8',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Move planned trip date back 1 day"
                                              >
                                                ←1d
                                              </button>
                                              <button
                                                data-planned-trip-date-forward={t.id}
                                                onClick={() => shiftPlannedTripDateById(g.id, t.id, t.date, 1)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 5px',
                                                  borderRadius: 5,
                                                  border: '1px solid #bfdbfe',
                                                  background: 'white',
                                                  color: '#1d4ed8',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Move planned trip date forward 1 day"
                                              >
                                                1d→
                                              </button>
                                              <button
                                                data-planned-trip-lock={t.id}
                                                onClick={() => lockPlannedTrip(t.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 6px',
                                                  borderRadius: 5,
                                                  border: '1px solid #c7d2fe',
                                                  background: 'white',
                                                  color: '#3730a3',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Lock this planned trip (mark scheduled with the processor)"
                                              >
                                                🔒 Lock
                                              </button>
                                            </div>
                                          )}
                                          {!tripLocked && isEditingDate && (
                                            <input
                                              data-planned-trip-date-input={t.id}
                                              type="date"
                                              value={editingPlannedTripDate}
                                              onChange={(e) => {
                                                const nextDate = e.target.value;
                                                setEditingPlannedTripDate(nextDate);
                                                if (nextDate && nextDate !== t.date) {
                                                  setPlannedTripDateById(g.id, t.id, nextDate);
                                                }
                                              }}
                                              style={{
                                                fontSize: 11,
                                                padding: '2px 4px',
                                                border: '1px solid #d1d5db',
                                                borderRadius: 5,
                                                fontFamily: 'inherit',
                                                width: 132,
                                              }}
                                            />
                                          )}
                                          <span style={{color: '#1e40af', fontWeight: 600}}>
                                            {t.plannedCount} {t.sex === 'gilt' ? 'gilt' : 'boar'}
                                            {t.plannedCount === 1 ? '' : 's'}
                                          </span>
                                        </div>
                                        <div style={{color: '#374151'}}>{projRange}</div>
                                        {projAvg && <div style={{color: '#6b7280'}}>{projAvg}</div>}
                                        <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 2}}>
                                          {t.ready && (
                                            <span
                                              style={{
                                                fontSize: 9,
                                                fontWeight: 700,
                                                padding: '1px 6px',
                                                borderRadius: 8,
                                                background: '#d1fae5',
                                                color: '#065f46',
                                                textTransform: 'uppercase',
                                              }}
                                            >
                                              Ready
                                            </span>
                                          )}
                                          {t.warnings.includes('undersized') && (
                                            <span
                                              style={{
                                                fontSize: 9,
                                                fontWeight: 700,
                                                padding: '1px 6px',
                                                borderRadius: 8,
                                                background: '#fef3c7',
                                                color: '#92400e',
                                                textTransform: 'uppercase',
                                              }}
                                            >
                                              Under {PLANNED_TRIP_MIN_SIZE}
                                            </span>
                                          )}
                                          {t.warnings.includes('overweight') && (
                                            <span
                                              style={{
                                                fontSize: 9,
                                                fontWeight: 700,
                                                padding: '1px 6px',
                                                borderRadius: 8,
                                                background: '#fee2e2',
                                                color: '#991b1b',
                                                textTransform: 'uppercase',
                                              }}
                                            >
                                              Over {PLANNED_TRIP_OVER_WEIGHT_WARN_LBS}
                                            </span>
                                          )}
                                        </div>
                                        {/* Move arrows + delete (admin/management).
                                          ← back: send 1 pig from this trip to the PREVIOUS
                                          chain trip (heaviest in current rank window).
                                          → forward: send 1 pig from this trip to the NEXT
                                          chain trip (lightest in current rank window).
                                          First trip: forward only. Last trip: back only.
                                          Middle trips: both. Disabled when this trip has
                                          0 pigs to give. */}
                                        {!tripLocked && isManager && (nextSameSex || prevSameSex || canDelete) && (
                                          <div style={{display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap'}}>
                                            {prevSameSex && (
                                              <button
                                                data-planned-trip-move-back={t.id}
                                                disabled={(parseInt(t.plannedCount) || 0) <= 0}
                                                onClick={() => movePlannedTripPigsById(g.id, t.id, prevSameSex.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 6px',
                                                  borderRadius: 5,
                                                  border: '1px solid #d1d5db',
                                                  background: 'white',
                                                  color: (parseInt(t.plannedCount) || 0) > 0 ? '#1d4ed8' : '#9ca3af',
                                                  cursor:
                                                    (parseInt(t.plannedCount) || 0) > 0 ? 'pointer' : 'not-allowed',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Move 1 pig back to the previous planned trip (heaviest in this trip's rank window)"
                                              >
                                                ← −1
                                              </button>
                                            )}
                                            {nextSameSex && (
                                              <button
                                                data-planned-trip-move-forward={t.id}
                                                disabled={(parseInt(t.plannedCount) || 0) <= 0}
                                                onClick={() => movePlannedTripPigsById(g.id, t.id, nextSameSex.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 6px',
                                                  borderRadius: 5,
                                                  border: '1px solid #d1d5db',
                                                  background: 'white',
                                                  color: (parseInt(t.plannedCount) || 0) > 0 ? '#1d4ed8' : '#9ca3af',
                                                  cursor:
                                                    (parseInt(t.plannedCount) || 0) > 0 ? 'pointer' : 'not-allowed',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Move 1 pig forward to the next planned trip (lightest in this trip's rank window)"
                                              >
                                                −1 →
                                              </button>
                                            )}
                                            {canDelete && (
                                              <button
                                                data-planned-trip-delete={t.id}
                                                onClick={() => deletePlannedTripById(g.id, t.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 6px',
                                                  borderRadius: 5,
                                                  border: '1px solid #fecaca',
                                                  background: 'white',
                                                  color: '#b91c1c',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Delete this planned trip (its pigs move to the next, or previous if last)"
                                              >
                                                🗑
                                              </button>
                                            )}
                                          </div>
                                        )}
                                        {/* Locked trip — admin/management can unlock via a
                                          two-step inline confirmation. No window.confirm. */}
                                        {tripLocked &&
                                          isManager &&
                                          (unlockingTripId === t.id ? (
                                            <div
                                              data-planned-trip-unlock-warning={t.id}
                                              style={{
                                                display: 'flex',
                                                gap: 6,
                                                flexWrap: 'wrap',
                                                marginTop: 4,
                                                padding: '6px 8px',
                                                border: '1px solid #fecaca',
                                                background: '#fef2f2',
                                                borderRadius: 6,
                                                alignItems: 'center',
                                              }}
                                            >
                                              <span
                                                style={{
                                                  color: '#991b1b',
                                                  fontSize: 11,
                                                  lineHeight: 1.3,
                                                  flex: '1 1 100%',
                                                }}
                                              >
                                                This trip has already been scheduled with the processor. Only unlock if
                                                you have rescheduled with the processor.
                                              </span>
                                              <button
                                                data-planned-trip-unlock-cancel={t.id}
                                                onClick={() => setUnlockingTripId(null)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 8px',
                                                  borderRadius: 5,
                                                  border: '1px solid #d1d5db',
                                                  background: 'white',
                                                  color: '#4b5563',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                              >
                                                Cancel
                                              </button>
                                              <button
                                                data-planned-trip-unlock-confirm={t.id}
                                                onClick={() => unlockPlannedTrip(t.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 10px',
                                                  borderRadius: 5,
                                                  border: 'none',
                                                  background: '#b91c1c',
                                                  color: 'white',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                  fontWeight: 600,
                                                }}
                                              >
                                                Confirm unlock
                                              </button>
                                            </div>
                                          ) : (
                                            <div style={{display: 'flex', marginTop: 4}}>
                                              <button
                                                data-planned-trip-unlock={t.id}
                                                onClick={() => setUnlockingTripId(t.id)}
                                                style={{
                                                  fontSize: 10,
                                                  padding: '2px 8px',
                                                  borderRadius: 5,
                                                  border: '1px solid #c7d2fe',
                                                  background: 'white',
                                                  color: '#3730a3',
                                                  cursor: 'pointer',
                                                  fontFamily: 'inherit',
                                                }}
                                                title="Unlock this planned trip (requires confirmation)"
                                              >
                                                🔓 Unlock
                                              </button>
                                            </div>
                                          ))}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                          </div>
                        )}
                      </React.Fragment>
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
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
}
