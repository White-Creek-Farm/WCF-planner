import {useState, useEffect} from 'react';
import {sb} from '../lib/supabase.js';
import {recordActivityEvent} from '../lib/activityApi.js';
import {computePigBatchFCR, pigSourceCountKeys} from '../lib/pig.js';
import {pigUpdateProcessingTrip, pigDeleteProcessingTrip} from '../lib/pigPlannerApi.js';

// Pig.batch processing-trip workflow (CP10 extraction from PigBatchesView).
// Owns the trip-source tracking state (weigh_ins.sent_to_trip_id ->
// weigh_in_sessions.batch_id) and the add/edit/close/delete handlers. The
// PERSISTED trip edit/delete now routes through the transactional SECURITY
// DEFINER RPCs in pigPlannerApi.js (mig 176) instead of direct app_store JSON
// writes; the server preserves fields it is not sent (subAttributions, ad-hoc
// keys) and, for trips with linked weigh-ins, recomputes pigCount/liveWeights
// from the weigh_ins itself. Numeric coercion (hangingWeight), the
// date-required guard, autosave debounce, close flush, delete confirmation,
// the hasLinkedSource display logic, and the fcrCached stamp/clear contract
// via computePigBatchFCR are all unchanged (fcrCached stays a client-owned
// display cache, re-persisted after each RPC + reload).
//
// The processing-trip FORM state stays owned by PigContext and is threaded in
// (activeTripBatchId/tripForm/editTripId + setters). Other deps explicit:
//   feederGroups / persistFeeders — ppp-feeders-v1 source of truth + the
//                                   client-owned fcrCached persist path
//   setFeederGroups               — state setter used by the post-RPC reload
//   confirmDelete                 — delete-confirmation helper
//   tripAutoSaveTimer             — shared debounce ref (prop)
//   breeders / dailysForName      — inputs to computePigBatchFCR
export function usePigProcessingTrips({
  feederGroups,
  setFeederGroups,
  persistFeeders,
  confirmDelete,
  tripAutoSaveTimer,
  breeders,
  dailysForName,
  activeTripBatchId,
  setActiveTripBatchId,
  tripForm,
  setTripForm,
  editTripId,
  setEditTripId,
}) {
  // Trip source tracking: for each processing trip, which weigh-in session(s)
  // contributed pigs. Pulled from weigh_ins (sent_to_trip_id) + sessions (batch_id).
  const [tripSentWeighins, setTripSentWeighins] = useState([]);
  const [tripSessionBatch, setTripSessionBatch] = useState({}); // session_id -> batch_id
  useEffect(() => {
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
  function tripSourceEntries(tripId) {
    if (!tripId) return [];
    return tripSentWeighins
      .filter((e) => e.sent_to_trip_id === tripId)
      .slice()
      .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  }
  function tripSourceWeights(tripId) {
    return tripSourceEntries(tripId)
      .map((e) => parseFloat(e.weight) || 0)
      .filter((w) => w > 0);
  }
  function tripSourceCounts(tripId) {
    const counts = {};
    tripSourceEntries(tripId).forEach((e) => {
      const name = tripSessionBatch[e.session_id] || 'Unknown session';
      counts[name] = (counts[name] || 0) + 1;
    });
    return counts;
  }
  function tripSourceCountsByKey(tripId) {
    const counts = {};
    tripSourceEntries(tripId).forEach((e) => {
      const name = tripSessionBatch[e.session_id] || 'Unknown session';
      pigSourceCountKeys(name).forEach((key) => {
        counts[key] = (counts[key] || 0) + 1;
      });
    });
    return counts;
  }
  function tripSourceSummary(tripId) {
    const weights = tripSourceWeights(tripId);
    const totalLive = weights.reduce((a, b) => a + b, 0);
    const avgLive = weights.length > 0 ? totalLive / weights.length : null;
    return {
      weights,
      count: weights.length,
      totalLive,
      avgLive,
      counts: tripSourceCounts(tripId),
      countsByKey: tripSourceCountsByKey(tripId),
    };
  }

  // Refresh feederGroups from app_store after a server-side RPC mutation and
  // return the fresh array (the SECDEF trip RPCs write ppp-feeders-v1
  // directly; fcrCached below is recomputed on the reloaded row).
  async function reloadFeeders() {
    const {data} = await sb.from('app_store').select('data').eq('key', 'ppp-feeders-v1').maybeSingle();
    const groups = data && Array.isArray(data.data) ? data.data : null;
    if (groups) setFeederGroups(groups);
    return groups;
  }

  // Stamp parent.fcrCached so Transfer-to-Breeding (which reads it from the
  // persisted record) gets the real adjusted-feed / total-live-weight ratio
  // instead of falling back to the 3.5 industry default. fcrCached stays a
  // CLIENT-maintained display cache: recomputed after every trip edit/delete
  // because the numerator (raw feed) and denominator (trip live wt) both
  // change when trips change. If the helper returns null (no valid trips
  // remaining, or rawFeed <= credits), CLEAR the cache so the transfer flow
  // falls back to the default rather than using a stale ratio. The persist
  // writes ONLY this field's change on top of the server-owned trip state.
  function refreshFcrCached(batchId, groups) {
    if (!Array.isArray(groups)) return;
    const nb = groups.map((g) => {
      if (g.id !== batchId) return g;
      const next = {...g};
      const fcr = computePigBatchFCR(next, dailysForName, breeders, {tripSourceSummary});
      if (fcr != null) next.fcrCached = fcr;
      else delete next.fcrCached;
      return next;
    });
    const before = groups.find((g) => g.id === batchId);
    const after = nb.find((g) => g.id === batchId);
    if (!before || !after || before.fcrCached === after.fcrCached) return;
    persistFeeders(nb);
  }

  async function persistTrip(batchId, formSnapshot, currentTripId) {
    if (!formSnapshot.date) return;
    const sourceWeights = tripSourceWeights(currentTripId);
    // Processing trips are actual processor events sourced from sent weigh-in
    // entries. Do not create a NEW processing trip unless it has stamped
    // weigh_in rows. Legacy existing trips can still be edited with their
    // stored pigCount/liveWeights until a source backfill links them.
    if (!currentTripId) return;
    // hasLinkedSource mirrors the server rule: for trips with linked weigh-ins
    // the RPC recomputes pigCount/liveWeights from the weigh_ins itself
    // (authoritative), so explicit values are only passed on the legacy
    // (unlinked) path — where the stored values still win over the form, as
    // before.
    const hasLinkedSource = sourceWeights.length > 0;
    const tripFormBase = {...formSnapshot};
    ['hangingWeight'].forEach((key) => {
      const v = tripFormBase[key];
      tripFormBase[key] = v === '' || v == null ? 0 : parseFloat(v) || 0;
    });
    const tripId = currentTripId;
    const parent = feederGroups.find((g) => g.id === batchId);
    const existing = parent ? (parent.processingTrips || []).find((t) => t.id === tripId) || {} : {};
    // The persisted mutation is the transactional SECDEF RPC (mig 176): it
    // locks the store row, preserves fields it is not sent (subAttributions,
    // any future ad-hoc keys), and re-syncs the trip's Processing record in
    // the same transaction.
    try {
      await pigUpdateProcessingTrip(sb, {
        groupId: batchId,
        tripId,
        date: tripFormBase.date,
        hangingWeight: tripFormBase.hangingWeight,
        notes: tripFormBase.notes ?? null,
        pigCount: hasLinkedSource ? null : parseInt(existing.pigCount ?? tripFormBase.pigCount) || 0,
        liveWeights: hasLinkedSource ? null : existing.liveWeights || tripFormBase.liveWeights || '',
      });
    } catch (e) {
      console.warn('persistTrip:', e.message || e);
      return;
    }
    const groups = await reloadFeeders();
    refreshFcrCached(batchId, groups);
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
    confirmDelete('Delete this processing trip? This cannot be undone.', async () => {
      // Snapshot the parent group + the trip being removed BEFORE the RPC,
      // so the best-effort Activity payload can describe what was deleted.
      const parent = feederGroups.find((g) => g.id === batchId) || null;
      const removed = parent ? (parent.processingTrips || []).find((t) => t.id === tripId) || null : null;
      // Transactional SECDEF RPC (mig 176): removes the trip, clears any
      // dangling weigh-in sent_to_trip_id/sent_to_group_id stamps in the SAME
      // transaction (the old client path left them dangling), and applies the
      // worked-archive vs empty-remove rule to the trip's Processing record.
      try {
        await pigDeleteProcessingTrip(sb, {groupId: batchId, tripId});
      } catch (e) {
        console.warn('deleteTrip:', e.message || e);
        return;
      }
      const groups = await reloadFeeders();
      // Recompute fcrCached after the trip's live weight is removed (see
      // refreshFcrCached for the stamp/clear contract).
      refreshFcrCached(batchId, groups);
      // Best-effort pig.batch Activity (entity_id = group.id = batchId): a
      // processing trip was deleted. Never blocks the mutation (try/catch).
      try {
        recordActivityEvent(sb, {
          entityType: 'pig.batch',
          entityId: batchId,
          eventType: 'record.deleted',
          entityLabel: (parent && parent.batchName) || batchId,
          body: 'Deleted processing trip' + (removed && removed.date ? ' (' + removed.date + ')' : ''),
          payload: {
            record: 'pig.processingTrip',
            batchName: (parent && parent.batchName) || null,
            tripId,
            date: removed ? removed.date || null : null,
            pigCount: removed ? parseInt(removed.pigCount) || 0 : null,
            liveWeights: removed ? removed.liveWeights || null : null,
            hangingWeight: removed ? parseFloat(removed.hangingWeight) || 0 : null,
          },
        }).catch(() => {});
      } catch (_e) {
        /* best-effort — never block the delete */
      }
    });
  }

  return {
    tripSourceCounts,
    tripSourceEntries,
    tripSourceWeights,
    tripSourceSummary,
    updTrip,
    closeTripForm,
    deleteTrip,
  };
}
