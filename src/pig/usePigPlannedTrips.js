import {useState, useEffect} from 'react';
import {sb} from '../lib/supabase.js';
import {toISO, addDays} from '../lib/dateUtils.js';
import {
  addPlannedTrip,
  movePigsBetweenTrips,
  deletePlannedTripWithReconciliation,
  deleteReconciliationRecipient,
} from '../lib/pigForecast.js';
import {
  pigAddPlannedTrip,
  pigSetPlannedTripDate,
  pigMovePlannedPigs,
  pigDeletePlannedTrip,
} from '../lib/pigPlannerApi.js';

// Pig.batch planned-processing-trip workflow (CP9 extraction from PigBatchesView).
// Owns the planned-trip editing/add state + the lock sidecar
// (ppp-pig-planned-trip-locks-v1) and every add/move/delete/date/lock handler.
// The persisted plannedProcessingTrips six-key row shape, the locks-sidecar
// shape, the manager unlock gate, add/move/delete reconciliation behavior,
// date-edit behavior, and planned-trip ordering are all unchanged — but the
// PERSISTED mutations now route through the transactional SECURITY DEFINER
// RPCs in pigPlannerApi.js (mig 176) instead of direct app_store JSON writes.
// The pigForecast pure cores are kept for PRE-VALIDATION only, so the inline
// guard/error UX stays instant and identical; after a successful RPC the hook
// re-reads ppp-feeders-v1 to sync local state with the server-owned row. The
// lock sidecar stays fully client-owned (the RPCs re-check locks server-side).
// The planned-trip JSX stays in PigBatchesView and consumes the returned
// state/handlers.
//
// Deps passed in explicitly (React-context-free):
//   feederGroups    — ppp-feeders-v1 source of truth
//   setFeederGroups — state setter used by the post-RPC reload
//   authState       — lock attribution (lockedByName / lockedByUserId)
//   isManager       — admin/management mutation gate
export function usePigPlannedTrips({feederGroups, setFeederGroups, authState, isManager}) {
  // Planned-trip calendar picker state. The date input is exposed one card at a
  // time; picker changes and day-step buttons autosave immediately.
  const [editingPlannedTripId, setEditingPlannedTripId] = useState(null);
  const [editingPlannedTripDate, setEditingPlannedTripDate] = useState('');
  // Manual + Add planned-trip form (single open at a time per sub).
  const [addingTripFor, setAddingTripFor] = useState(null);
  const [addingTripDate, setAddingTripDate] = useState('');
  const [addingTripCount, setAddingTripCount] = useState('');
  const [addingTripError, setAddingTripError] = useState('');
  // Planned-trip locks sidecar (key ppp-pig-planned-trip-locks-v1). Shape:
  //   { [tripId]: { locked: true, lockedByName, lockedByUserId, lockedAt } }
  // Rides OUTSIDE plannedProcessingTrips so the documented six-key row shape
  // (id, date, sex, subBatchId, plannedCount, order) stays byte-identical.
  const [plannedTripLocks, setPlannedTripLocks] = useState({});
  const [unlockingTripId, setUnlockingTripId] = useState(null);

  useEffect(() => {
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

  // Refresh feederGroups from app_store after a server-side RPC mutation. The
  // SECDEF planner RPCs write ppp-feeders-v1 directly, so local state re-syncs
  // by re-reading the row instead of an optimistic client write.
  async function reloadFeeders() {
    const {data} = await sb.from('app_store').select('data').eq('key', 'ppp-feeders-v1').maybeSingle();
    if (data && Array.isArray(data.data)) setFeederGroups(data.data);
  }

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

  // Planned-trip date edit for a single trip. The client guards (manager gate,
  // lock, date shape) keep the UX instant; the persisted mutation is the SECDEF
  // RPC (mig 176), which re-checks them server-side and preserves the minimal
  // persistable shape (id, date, sex, subBatchId, plannedCount, order).
  function setPlannedTripDateById(groupId, tripId, newDate) {
    if (!isManager) return;
    if (isTripLocked(tripId)) return; // Lock guard: target trip locked.
    if (typeof newDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return;
    pigSetPlannedTripDate(sb, {groupId, tripId, date: newDate})
      .then(() => reloadFeeders())
      .catch((e) => console.warn('setPlannedTripDateById:', e.message || e));
  }

  function shiftPlannedTripDateById(groupId, tripId, currentDate, deltaDays) {
    if (!isManager) return;
    if (isTripLocked(tripId)) return; // Lock guard: target trip locked.
    if (typeof currentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(currentDate)) return;
    const nextDate = toISO(addDays(currentDate, deltaDays));
    if (editingPlannedTripId === tripId) setEditingPlannedTripDate(nextDate);
    setPlannedTripDateById(groupId, tripId, nextDate);
  }

  // Admin count move between two planned trips in the same (subBatchId, sex)
  // pair. Caller already scoped the to-trip to the adjacent same-pair sibling;
  // the cross-pair guard inside movePigsBetweenTrips remains as defense in depth.
  // Single-pig moves only (W1); zero-count trips stay visible (W2).
  function movePlannedTripPigsById(groupId, fromTripId, toTripId) {
    if (!isManager) return;
    // Lock guard: blocked when source OR target is locked (neighbor-mutation rule).
    if (isTripLocked(fromTripId) || isTripLocked(toTripId)) return;
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return;
    // Pre-validate with the pure core (instant, identical error surfacing);
    // the computed array is discarded — the SECDEF RPC performs the persisted
    // move (mig 176) and re-runs the same cross-pair/count rules server-side.
    const r = movePigsBetweenTrips(fg.plannedProcessingTrips || [], fromTripId, toTripId, 1);
    if (r.error) {
      console.warn('movePlannedTripPigsById:', r.error);
      return;
    }
    pigMovePlannedPigs(sb, {groupId, fromTripId, toTripId, count: 1})
      .then(() => reloadFeeders())
      .catch((e) => console.warn('movePlannedTripPigsById:', e.message || e));
  }

  // Manual add (admin/management) — appends a planned trip to the (subBatchId,
  // sex) chain. order = max(existing order in chain) + 1.
  function addPlannedTripById(groupId, {subBatchId, sex, date, plannedCount}) {
    if (!isManager) return {error: 'gated'};
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return {error: 'group not found'};
    // Lock guard: disable Add when ANY existing trip in the same (subBatchId,
    // sex) chain is locked.
    if (isChainLocked(fg.plannedProcessingTrips || [], subBatchId, sex)) {
      return {error: 'chain locked'};
    }
    // Pre-validate with the pure core so the inline form error stays instant
    // and identical; the SECDEF RPC (mig 176) re-runs the same draw-from-chain
    // rules when it persists the add.
    const r = addPlannedTrip(fg.plannedProcessingTrips || [], {subBatchId, sex, date, plannedCount});
    if (r.error) return r;
    pigAddPlannedTrip(sb, {groupId, subBatchId, sex, date, plannedCount})
      .then(() => reloadFeeders())
      .catch((e) => console.warn('addPlannedTripById:', e.message || e));
    return {ok: true};
  }

  // Delete with reconciliation (admin/management) — removes the trip and moves
  // its plannedCount onto the NEXT chain trip (or PREVIOUS if last). Refuses
  // when chain has only one trip.
  function deletePlannedTripById(groupId, tripId) {
    if (!isManager) return {error: 'gated'};
    const fg = feederGroups.find((g) => g.id === groupId);
    if (!fg) return {error: 'group not found'};
    // Lock guard: refuse when the deleted trip OR its reconciliation recipient
    // is locked (delete reconciles the count onto the next/previous chain trip).
    if (isTripLocked(tripId)) return {error: 'locked'};
    const recipient = deleteReconciliationRecipient(fg.plannedProcessingTrips || [], tripId);
    if (recipient && isTripLocked(recipient.id)) return {error: 'recipient locked'};
    // Pre-validate with the pure core (single-trip-chain refusal etc.); the
    // SECDEF RPC (mig 176) performs the persisted delete + count fold.
    const r = deletePlannedTripWithReconciliation(fg.plannedProcessingTrips || [], tripId);
    if (r.error) {
      console.warn('deletePlannedTripById:', r.error);
      return r;
    }
    pigDeletePlannedTrip(sb, {groupId, tripId})
      .then(() => reloadFeeders())
      .catch((e) => console.warn('deletePlannedTripById:', e.message || e));
    return {ok: true};
  }

  return {
    editingPlannedTripId,
    setEditingPlannedTripId,
    editingPlannedTripDate,
    setEditingPlannedTripDate,
    addingTripFor,
    setAddingTripFor,
    addingTripDate,
    setAddingTripDate,
    addingTripCount,
    setAddingTripCount,
    addingTripError,
    setAddingTripError,
    plannedTripLocks,
    unlockingTripId,
    setUnlockingTripId,
    isChainLocked,
    lockPlannedTrip,
    unlockPlannedTrip,
    setPlannedTripDateById,
    shiftPlannedTripDateById,
    movePlannedTripPigsById,
    addPlannedTripById,
    deletePlannedTripById,
  };
}
