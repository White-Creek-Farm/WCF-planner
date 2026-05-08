// ============================================================================
// LivestockWeighInsView — Phase 2.3.6 (recovered from Round-1 bundling bug)
// ============================================================================
// Verbatim byte-for-byte. This view + AdminNewWeighInModal originally sat
// adjacent in main.jsx and the Round-1 anchor extracted both into the same
// file by accident; this commit splits them.
// ============================================================================
import React from 'react';
import AdminNewWeighInModal from '../shared/AdminNewWeighInModal.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {writeBroilerBatchAvg, recomputeBroilerBatchWeekAvg} from '../lib/broiler.js';
import {loadRoster, activeNames as rosterActiveNames} from '../lib/teamMembers.js';
import {pigSlug} from '../lib/pig.js';
import {
  formatAgeRange,
  formatFeedPerPig,
  formatGroupAdg,
  formatAvgWeight,
  reconcilePlannedTripsForSend,
} from '../lib/pigForecast.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import PigSendToTripModal from './PigSendToTripModal.jsx';
const LivestockWeighInsView = ({
  sb,
  fmt,
  Header,
  authState,
  setView,
  showUsers,
  setShowUsers,
  allUsers,
  setAllUsers,
  loadUsers,
  species,
}) => {
  const {useState, useEffect} = React;
  const [sessions, setSessions] = useState([]);
  const [entries, setEntries] = useState({}); // session_id -> [entries]
  const [loading, setLoading] = useState(true);
  const [expandedSession, setExpandedSession] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [broilerBatchRecs, setBroilerBatchRecs] = useState([]);
  const [showNewModal, setShowNewModal] = useState(false);
  // Per-expanded-tile grid editing state. Only one tile is expanded at a time.
  const [gridLabels, setGridLabels] = useState([]); // ['2','3'] for broiler etc.
  const [gridInputs, setGridInputs] = useState([]); // weight strings, length = labels*15
  const [gridUnlocked, setGridUnlocked] = useState(false); // false locks fields on complete
  const [gridNote, setGridNote] = useState('');
  const [savingGrid, setSavingGrid] = useState(false);
  const [gridErr, setGridErr] = useState('');
  // Active team roster (names only) — drives the broiler-only session
  // metadata edit dropdown. Loaded once on mount.
  const [activeRoster, setActiveRoster] = useState([]);
  // Per-expanded-tile broiler session metadata edit state. Reset on
  // expansion change (effect below). Only used when species==='broiler'.
  const [metaWeek, setMetaWeek] = useState(4);
  const [metaTeam, setMetaTeam] = useState('');
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState('');
  // Row-scoped error from reopenSession. Shape: {id, message} or null.
  // Lives outside the expansion effect's reset list so it survives the
  // post-update loadAll() — the expansion effect fires on `sessions`
  // change after loadAll, and clearing here would race the error
  // setter. Scoped by session id so an error from row A never bleeds
  // onto row B; cleared on the next successful reopen.
  const [actionErr, setActionErr] = useState(null);
  // Pig session metrics by session id. Populated lazily by an effect that
  // fans out one pig_session_metrics RPC per pig session in the loaded
  // list; results cache in this map so re-renders don't re-fetch. Refetched
  // when the sessions/entries graph changes. Authenticated scope returns
  // aggregates for any pig session (draft + complete history per the R1
  // scope rule). N round-trips per visible pig session list — acceptable
  // for v1 per Codex's W2.
  const [pigMetricsBySession, setPigMetricsBySession] = useState({});
  // Pig send-to-trip state (no-op for broilers)
  const [feederGroups, setFeederGroups] = useState([]);
  const [selectedEntryIds, setSelectedEntryIds] = useState(new Set());
  const [tripModal, setTripModal] = useState(null); // {session, entries: []}
  // Permission gate for pig send-to-planned-trip mutations (Codex pig
  // planned trips lane spec): admin OR management can mutate; farm_team
  // is read-only across the entire pig planned/processing trip surface,
  // including selection checkboxes, the send action, and undo-send.
  const canManagePigPlannedTrips = !!(authState && (authState.role === 'admin' || authState.role === 'management'));
  // Pig inline add-entry state (per expanded session — scoped via expandedSession)
  const [pigAddEntry, setPigAddEntry] = useState({weight: '', note: ''});
  const [pigBusy, setPigBusy] = useState(false);
  const [pigErr, setPigErr] = useState('');
  // Transfer-to-breeding modal state — scoped to one weigh-in entry at a time.
  const [transferModal, setTransferModal] = useState(null); // {session, entry}
  const [transferForm, setTransferForm] = useState({tag: '', group: '1', sex: 'Gilt', birthDate: ''});
  const [transferBusy, setTransferBusy] = useState(false);

  const speciesLabel = species === 'broiler' ? 'Broiler' : 'Pig';

  // Derive column labels for a session: broiler → split batch.schooner on '&'; pig → ['1','2'].
  function deriveLabels(s) {
    if (!s) return [];
    if (s.species === 'broiler') {
      const rec = broilerBatchRecs.find((b) => (b.name || '') === s.batch_id);
      const raw = rec && rec.schooner ? String(rec.schooner) : '';
      const parts = raw
        .split('&')
        .map((x) => x.trim())
        .filter(Boolean);
      return parts.length > 0 ? parts : ['(no schooner)'];
    }
    // Pig admin view moved to per-entry list (no grid) — labels stay empty.
    return [];
  }
  // Distribute a session's saved entries into a weights grid (mirrors the public webform).
  // Entries already sent to a processing trip are excluded here — they live in
  // the Send-to-Trip panel below the grid so re-saves don't wipe them.
  function hydrateGrid(s, sEntries, labels) {
    const grid = Array(labels.length * 15).fill('');
    const free = (sEntries || []).filter((e) => !e.sent_to_trip_id);
    if (s.species === 'broiler') {
      labels.forEach(function (label, colIdx) {
        const colE = free.filter(function (e) {
          return (e.tag || '') === label;
        });
        colE.slice(0, 15).forEach(function (e, i) {
          grid[colIdx * 15 + i] = String(e.weight);
        });
      });
    } else {
      free.slice(0, labels.length * 15).forEach(function (e, i) {
        grid[i] = String(e.weight);
      });
    }
    return grid;
  }

  async function loadAll() {
    setLoading(true);
    const sR = await sb
      .from('weigh_in_sessions')
      .select('*')
      .eq('species', species)
      .order('date', {ascending: false})
      .order('started_at', {ascending: false});
    if (sR.data) {
      setSessions(sR.data);
      if (sR.data.length > 0) {
        const ids = sR.data.map((s) => s.id);
        const eR = await sb.from('weigh_ins').select('*').in('session_id', ids).order('entered_at', {ascending: true});
        if (eR.data) {
          const m = {};
          eR.data.forEach((e) => {
            if (!m[e.session_id]) m[e.session_id] = [];
            m[e.session_id].push(e);
          });
          setEntries(m);
        }
      } else {
        setEntries({});
      }
    }
    setLoading(false);
  }
  useEffect(() => {
    loadAll();
  }, [species]);
  // Pig metrics fan-out (mig 049). One RPC per pig session in the visible
  // list; results cached in pigMetricsBySession so re-renders don't refetch.
  // Re-runs when the species changes (cattle/sheep/broiler views skip
  // entirely) or when the sessions/entries graph changes (so adding a
  // weigh-in to a draft session refreshes that session's metrics).
  useEffect(() => {
    if (species !== 'pig' || sessions.length === 0) {
      setPigMetricsBySession({});
      return;
    }
    let cancelled = false;
    Promise.all(
      sessions.map((s) =>
        sb.rpc('pig_session_metrics', {session_id_in: s.id}).then(({data, error}) => ({
          id: s.id,
          data: error ? {available: false} : data || {available: false},
        })),
      ),
    ).then((results) => {
      if (cancelled) return;
      const next = {};
      for (const r of results) next[r.id] = r.data;
      setPigMetricsBySession(next);
    });
    return () => {
      cancelled = true;
    };
    // sb is a stable prop from the parent; established pattern in this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [species, sessions, entries]);
  // Broilers: load app_store ppp-v4 once so we can resolve schooner per batch.
  useEffect(() => {
    if (species !== 'broiler') return;
    sb.from('app_store')
      .select('data')
      .eq('key', 'ppp-v4')
      .maybeSingle()
      .then(({data}) => {
        if (data && Array.isArray(data.data)) setBroilerBatchRecs(data.data);
      });
  }, [species]);
  // Active team roster — drives the broiler session metadata edit dropdown.
  // Loaded once. Legacy team_member values not in the active roster are
  // preserved in the option list per-session via the option-builder below.
  useEffect(() => {
    let cancelled = false;
    loadRoster(sb).then((roster) => {
      if (!cancelled) setActiveRoster(rosterActiveNames(roster));
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // Pigs: load feeder groups so the Send-to-Trip modal can list them.
  useEffect(() => {
    if (species !== 'pig') return;
    sb.from('app_store')
      .select('data')
      .eq('key', 'ppp-feeders-v1')
      .maybeSingle()
      .then(({data}) => {
        if (data && Array.isArray(data.data)) setFeederGroups(data.data);
      });
  }, [species]);
  async function reloadFeederGroups() {
    const {data} = await sb.from('app_store').select('data').eq('key', 'ppp-feeders-v1').maybeSingle();
    if (data && Array.isArray(data.data)) setFeederGroups(data.data);
  }
  // When the user expands a tile, derive labels + hydrate the grid + reset edit lock.
  // Drafts are auto-unlocked; complete sessions stay locked until the user clicks Edit.
  useEffect(() => {
    if (!expandedSession) {
      setGridLabels([]);
      setGridInputs([]);
      setGridUnlocked(false);
      setGridNote('');
      setGridErr('');
      setPigAddEntry({weight: '', note: ''});
      setPigErr('');
      setMetaWeek(4);
      setMetaTeam('');
      setMetaErr('');
      return;
    }
    const s = sessions.find((x) => x.id === expandedSession);
    if (!s) return;
    const labels = deriveLabels(s);
    const sEntries = entries[s.id] || [];
    setGridLabels(labels);
    setGridInputs(hydrateGrid(s, sEntries, labels));
    setGridUnlocked(s.status === 'draft');
    setGridNote(s.notes || '');
    setGridErr('');
    // Seed metadata-edit state from the just-expanded session. Number()
    // on broiler_week so the toggle compares cleanly against integers
    // 4 / 6 (avoids fake-dirty if the row arrives as a string).
    const w = Number(s.broiler_week);
    setMetaWeek(w === 4 || w === 6 ? w : 4);
    setMetaTeam(s.team_member || '');
    setMetaErr('');
  }, [expandedSession, sessions, entries, broilerBatchRecs]);

  // Reopen a complete session (status: complete -> draft, completed_at -> null).
  // Currently only wired up for broiler via the row-level button below; cattle/
  // sheep have their own reopen flows in their respective views. For broiler,
  // the OLD week's stored avg in app_store.ppp-v4 is recomputed from the
  // latest OTHER complete session (or the wk*Lbs key is deleted when no other
  // complete session backs it). Mirrors the metadata-edit lane's contract on
  // weekChanged. Side-effect runs only when species==='broiler' AND the
  // session was complete AND oldWeek is in {4, 6} (matches
  // recomputeBroilerBatchWeekAvg's no-op gate). Failures from the cleanup
  // are surfaced via actionErr after loadAll() so the row reflects DB truth
  // (draft) without pretending the avg cleanup landed.
  async function reopenSession(s) {
    const oldWeek = Number(s.broiler_week);
    const wasComplete = s.status === 'complete';
    const isBroiler = s.species === 'broiler';

    const r = await sb.from('weigh_in_sessions').update({status: 'draft', completed_at: null}).eq('id', s.id);
    if (r && r.error) {
      setActionErr({id: s.id, message: 'Reopen failed: ' + r.error.message});
      return;
    }

    if (isBroiler && wasComplete && (oldWeek === 4 || oldWeek === 6)) {
      const r2 = await recomputeBroilerBatchWeekAvg(sb, s.batch_id, oldWeek, {excludeSessionId: s.id});
      if (!r2.ok) {
        setActionErr({id: s.id, message: 'Session reopened, but ppp-v4 cleanup failed: ' + r2.message});
        await loadAll();
        return;
      }
    }

    setActionErr(null);
    await loadAll();
  }
  // Save the broiler-only metadata edit panel (broiler_week + team_member).
  // No-op if neither field changed. On a complete session whose week
  // changed, the OLD week's stored avg in app_store.ppp-v4 is recomputed
  // from the latest OTHER complete session (or cleared if none exist),
  // and the NEW week's avg is written from this session's current
  // entries. Status === 'draft' skips the side-effect (matches today's
  // writeBroilerBatchAvg complete-only gate).
  async function saveSessionMetadata(s) {
    if (!s) return;
    const oldWeek = Number(s.broiler_week);
    const newWeek = Number(metaWeek);
    const oldTeam = (s.team_member || '').trim();
    const newTeam = (metaTeam || '').trim();
    if (!newTeam) {
      setMetaErr('Pick a team member.');
      return;
    }
    if (newWeek !== 4 && newWeek !== 6) {
      setMetaErr('Week must be 4 or 6.');
      return;
    }
    const weekChanged = oldWeek !== newWeek;
    const teamChanged = oldTeam !== newTeam;
    if (!weekChanged && !teamChanged) return; // no-op, no DB write

    setMetaBusy(true);
    setMetaErr('');
    const upd = {};
    if (weekChanged) upd.broiler_week = newWeek;
    if (teamChanged) upd.team_member = newTeam;
    const r = await sb.from('weigh_in_sessions').update(upd).eq('id', s.id);
    if (r && r.error) {
      setMetaBusy(false);
      setMetaErr('Save failed: ' + r.error.message);
      return;
    }

    // Side-effect: only complete sessions and only when week changed.
    if (s.status === 'complete' && weekChanged) {
      const r1 = await recomputeBroilerBatchWeekAvg(sb, s.batch_id, oldWeek, {excludeSessionId: s.id});
      if (!r1.ok) {
        setMetaBusy(false);
        setMetaErr('Save partly failed (old week): ' + r1.message);
        return;
      }
      const eR = await sb.from('weigh_ins').select('weight').eq('session_id', s.id);
      if (eR && eR.error) {
        setMetaBusy(false);
        setMetaErr('Save partly failed (entries read): ' + eR.error.message);
        return;
      }
      await writeBroilerBatchAvg(sb, {...s, broiler_week: newWeek}, (eR && eR.data) || []);
    }

    setMetaBusy(false);
    await loadAll();
  }
  async function completeFromAdmin(s) {
    // If this session is the currently-expanded tile, flush any pending grid
    // edits to DB first so what's on screen is what gets recorded as complete.
    if (expandedSession === s.id && s.species === 'broiler') {
      await saveAdminGrid(s);
    }
    await sb
      .from('weigh_in_sessions')
      .update({status: 'complete', completed_at: new Date().toISOString()})
      .eq('id', s.id);
    if (species === 'broiler') {
      const eR = await sb.from('weigh_ins').select('*').eq('session_id', s.id);
      // Override status locally so writeBroilerBatchAvg's complete-only gate fires.
      await writeBroilerBatchAvg(sb, {...s, status: 'complete'}, (eR && eR.data) || []);
    }
    await loadAll();
  }
  // ── Pig per-entry admin helpers ───────────────────────────────────────────
  // Pigs moved off the grid flow; editing/deleting/adding happens one row at a
  // time, like cattle/sheep. Sent-to-trip entries can't be edited or deleted
  // (they'd desync from the trip's liveWeights string in app_store).
  async function addPigEntry(sessionId) {
    const w = parseFloat(pigAddEntry.weight);
    if (!Number.isFinite(w) || w <= 0) {
      setPigErr('Weight is required.');
      return;
    }
    setPigBusy(true);
    setPigErr('');
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {id, session_id: sessionId, tag: null, weight: w, note: pigAddEntry.note || null, new_tag_flag: false};
    const {error} = await sb.from('weigh_ins').insert(rec);
    setPigBusy(false);
    if (error) {
      setPigErr('Save failed: ' + error.message);
      return;
    }
    setPigAddEntry({weight: '', note: ''});
    await loadAll();
  }
  async function updatePigEntry(entryId, fields) {
    if (!entryId || !fields) return;
    const {error} = await sb.from('weigh_ins').update(fields).eq('id', entryId);
    if (error) {
      setPigErr('Update failed: ' + error.message);
      return;
    }
    await loadAll();
  }
  async function deletePigEntry(entryId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this weigh-in entry?', async () => {
      await sb.from('weigh_ins').delete().eq('id', entryId);
      await loadAll();
    });
  }
  async function savePigSessionNote(sessionId, note) {
    await sb
      .from('weigh_in_sessions')
      .update({notes: note || null})
      .eq('id', sessionId);
    await loadAll();
  }
  async function deleteSession(s) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this weigh-in session and all its entries? This cannot be undone.', async () => {
      await sb.from('weigh_in_sessions').delete().eq('id', s.id);
      await loadAll();
    });
  }

  // ── Transfer-to-Breeding (admin only) ────────────────────────────────────
  // Resolve a session's batch_id to {parentBatch, subBatch?} from feederGroups.
  // session.batch_id is whatever the public webform picked — usually a
  // sub-batch name like "P-26-01A (GILTS)", but can be a parent batchName too.
  function resolveBatchAndSub(sessionBatchId) {
    if (!sessionBatchId) return {parent: null, sub: null};
    const norm = String(sessionBatchId).trim().toLowerCase();
    for (const g of feederGroups) {
      if ((g.batchName || '').trim().toLowerCase() === norm) return {parent: g, sub: null};
      const sub = (g.subBatches || []).find((s) => (s.name || '').trim().toLowerCase() === norm);
      if (sub) return {parent: g, sub};
    }
    return {parent: null, sub: null};
  }
  // Compute parent batch's running FCR (lbs feed per lb live weight).
  // Falls back to industry default 3.5 if no trips have happened yet.
  function batchFCR(parent) {
    if (!parent) return 3.5;
    const subs = parent.subBatches || [];
    const dailyFeed =
      subs.length > 0
        ? subs.reduce((acc, sb) => acc + (sb.dailyFeedTotalCached || 0), 0) // not used (cache absent), see below
        : 0;
    // Easier: re-derive from raw feed - allocated. We don't have pigDailys
    // on this view, so use parent's processingTrips.liveWeights for live and
    // fall back to default for feed (no clean source here). To keep this
    // self-contained, use trips' counts × avg-live as a proxy; if no trips,
    // fall back to default 3.5.
    const trips = parent.processingTrips || [];
    const totalLive = trips.reduce((s, t) => {
      const w = (t.liveWeights || '')
        .split(/[\s,]+/)
        .map(parseFloat)
        .filter((v) => !isNaN(v) && v > 0);
      return s + w.reduce((a, b) => a + b, 0);
    }, 0);
    // Without pigDailys on this view, FCR can't be computed live here.
    // Use the stored fcrCached on the batch if present, else default 3.5.
    if (parent.fcrCached && parent.fcrCached > 0) return parent.fcrCached;
    return 3.5;
  }
  function openTransferModal(session, entry) {
    setTransferModal({session, entry});
    // Default birth date from session date minus 6 months (rough feeder pig
    // age at processing-weight). Admin can adjust.
    let bd = '';
    try {
      const sd = new Date((session.date || '') + 'T12:00:00');
      sd.setMonth(sd.getMonth() - 6);
      bd = sd.toISOString().slice(0, 10);
    } catch (_e) {
      /* defensive parse — leave bd as '' */
    }
    setTransferForm({tag: '', group: '1', sex: 'Gilt', birthDate: bd});
  }
  async function transferToBreeding() {
    if (!transferModal) return;
    const {session, entry} = transferModal;
    const tag = (transferForm.tag || '').trim();
    if (!tag) {
      alert('Tag # is required.');
      return;
    }
    if (!transferForm.group) {
      alert('Pick a group.');
      return;
    }
    setTransferBusy(true);
    try {
      // Resolve batch + sub from session.batch_id.
      const {parent, sub} = resolveBatchAndSub(session.batch_id);
      if (!parent) {
        alert('Could not match this session to a feeder batch.');
        setTransferBusy(false);
        return;
      }
      // FCR-based feed allocation: weight × FCR (lbs feed per lb live weight).
      const fcr = batchFCR(parent);
      const weight = parseFloat(entry.weight) || 0;
      const feedAllocLbs = Math.round(weight * fcr * 10) / 10;

      // 1. Insert into breeders registry.
      const breederId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
      const breederRec = {
        id: breederId,
        tag,
        sex: transferForm.sex || 'Gilt',
        group: transferForm.group,
        status: transferForm.sex === 'Boar' ? 'Boar Group' : 'Sow Group',
        breed: '',
        origin: parent.batchName || '',
        birthDate: transferForm.birthDate || '',
        lastWeight: weight,
        purchaseDate: '',
        purchaseAmount: '',
        notes: '',
        archived: false,
        weighins: [{weight, date: session.date || new Date().toISOString().slice(0, 10)}],
        transferredFromBatch: {
          batchName: parent.batchName,
          subBatchName: sub ? sub.name : null,
          transferDate: new Date().toISOString().slice(0, 10),
          feedAllocationLbs: feedAllocLbs,
          fcrUsed: fcr,
          sourceWeighInId: entry.id,
        },
      };
      // Read current breeders, append, write back.
      const brR = await sb.from('app_store').select('data').eq('key', 'ppp-breeders-v1').maybeSingle();
      if (brR.error) {
        alert('Could not read breeders registry: ' + brR.error.message);
        setTransferBusy(false);
        return;
      }
      const currentBreeders = brR.data && Array.isArray(brR.data.data) ? brR.data.data : [];
      // Idempotency: skip if a breeder is already linked to this weigh-in id.
      // (Guards against double-clicks before the modal closes.)
      if (currentBreeders.some((b) => b.transferredFromBatch && b.transferredFromBatch.sourceWeighInId === entry.id)) {
        alert('This weigh-in entry has already been transferred to breeding. No new breeder created.');
        setTransferModal(null);
        setTransferBusy(false);
        await loadAll();
        return;
      }
      const newBreeders = [...currentBreeders, breederRec];
      const brW = await sb.from('app_store').upsert({key: 'ppp-breeders-v1', data: newBreeders}, {onConflict: 'key'});
      if (brW.error) {
        alert('Could not save new breeder: ' + brW.error.message);
        setTransferBusy(false);
        return;
      }

      // 2. Accumulate feed allocation only. Started counts (giltCount /
      //    boarCount / originalPigCount on parent + sub) are NOT mutated —
      //    they're started counts. Transfer events live in breeders[]; the
      //    pig-batches view derives "current" ledger-style on display.
      const updatedFeederGroups = feederGroups.map((g) => {
        if (g.id !== parent.id) return g;
        return {
          ...g,
          feedAllocatedToTransfers: (parseFloat(g.feedAllocatedToTransfers) || 0) + feedAllocLbs,
        };
      });
      setFeederGroups(updatedFeederGroups);
      const fW = await sb
        .from('app_store')
        .upsert({key: 'ppp-feeders-v1', data: updatedFeederGroups}, {onConflict: 'key'});
      if (fW.error) {
        alert('Could not update feeder batch counts: ' + fW.error.message);
        setTransferBusy(false);
        return;
      }

      // 3. Stamp the weigh-in entry. Try the rich payload first; if any of
      // the new columns are missing on this Supabase project, fall back to
      // adding the marker via the note field so the action is at least
      // visible in the UI.
      const wi = await sb
        .from('weigh_ins')
        .update({
          transferred_to_breeding: true,
          transfer_breeder_id: breederId,
          feed_allocation_lbs: feedAllocLbs,
        })
        .eq('id', entry.id);
      if (wi.error) {
        const noteFallback =
          '[transferred_to_breeding breeder=' +
          breederId +
          ' feed_alloc=' +
          feedAllocLbs +
          ' lb] ' +
          (entry.note || '');
        const wi2 = await sb.from('weigh_ins').update({note: noteFallback}).eq('id', entry.id);
        if (wi2.error) {
          alert(
            'Transfer mostly succeeded — breeder #' +
              tag +
              ' was created and counts updated, but the weigh-in row could not be stamped: ' +
              wi.error.message +
              ' / ' +
              wi2.error.message,
          );
        } else {
          alert(
            'Transfer succeeded — note: weigh_ins schema is missing transferred_to_breeding columns, fell back to a note marker. Run the migration to enable the badge.',
          );
        }
      }

      setTransferModal(null);
      setTransferBusy(false);
      await loadAll();
    } catch (e) {
      alert('Transfer failed: ' + (e.message || 'unknown error'));
      setTransferBusy(false);
    }
  }

  // Admin save: wipe+rewrite semantics on the UNSENT pool. Entries with
  // sent_to_trip_id set are protected — they stay in weigh_ins and continue
  // referencing their trip in app_store.ppp-feeders-v1.
  async function saveAdminGrid(s) {
    if (!s) return;
    const rows = [];
    for (let i = 0; i < gridInputs.length; i++) {
      const w = gridInputs[i];
      if (w === '' || isNaN(parseFloat(w)) || parseFloat(w) <= 0) continue;
      const colIdx = Math.floor(i / 15);
      const tag = s.species === 'broiler' && gridLabels[colIdx] ? gridLabels[colIdx] : null;
      rows.push({weight: parseFloat(w), tag: tag});
    }
    setSavingGrid(true);
    setGridErr('');
    const del = await sb.from('weigh_ins').delete().eq('session_id', s.id).is('sent_to_trip_id', null);
    if (del.error) {
      setSavingGrid(false);
      setGridErr('Save failed (clear): ' + del.error.message);
      return;
    }
    let recs = [];
    if (rows.length > 0) {
      const t0 = Date.now();
      recs = rows.map(function (r, i) {
        return {
          id: String(t0 + i) + Math.random().toString(36).slice(2, 6),
          session_id: s.id,
          tag: r.tag,
          weight: r.weight,
          note: null,
          new_tag_flag: false,
        };
      });
      const ins = await sb.from('weigh_ins').insert(recs);
      if (ins.error) {
        setSavingGrid(false);
        setGridErr('Save failed (insert): ' + ins.error.message);
        return;
      }
    }
    if (gridNote !== (s.notes || '')) {
      await sb
        .from('weigh_in_sessions')
        .update({notes: gridNote || null})
        .eq('id', s.id);
    }
    if (s.species === 'broiler') {
      await writeBroilerBatchAvg(sb, s, recs);
    }
    setSavingGrid(false);
    // Re-lock complete sessions after save so the field stays read-only by default.
    if (s.status === 'complete') setGridUnlocked(false);
    await loadAll();
  }

  // Send-to-Trip: planned-trip-driven flow per Codex's pig planned trips
  // lane spec. The modal pre-resolves source sub-batch + sex; this handler
  // re-runs reconcilePlannedTripsForSend (single source of truth) on the
  // current plannedProcessingTrips, then creates an actual processingTrips
  // row dated to the target planned trip's date.
  //
  // Each weigh-in row is stamped with sent_to_trip_id + sent_to_group_id
  // so it survives grid saves and surfaces in the Sent panel. The new
  // actual processingTrips id is what gets stamped — the planned trip's
  // id stays in plannedProcessingTrips (or is removed via reconciliation),
  // those are different namespaces.
  async function sendEntriesToTrip({groupId, sourceSubId, sourceSubSex, sendCount}) {
    if (!tripModal) return;
    // Permission gate: farm_team cannot mutate planned/processing trips.
    if (!canManagePigPlannedTrips) {
      console.warn('sendEntriesToTrip refused: caller lacks admin/management role');
      setTripModal(null);
      return;
    }
    const {entries: selectedEntries} = tripModal;
    if (!groupId || !sourceSubId || !sourceSubSex || !selectedEntries || selectedEntries.length === 0) return;
    const groups = feederGroups.slice();
    const gi = groups.findIndex((g) => g.id === groupId);
    if (gi < 0) return;
    const g = {...groups[gi]};

    // Re-run reconciliation against the live planned-trip array. The modal
    // already validated, but the helper is the contract; rerun guards
    // against any concurrent mutation between modal open and confirm.
    const recon = reconcilePlannedTripsForSend(g.plannedProcessingTrips || [], {
      subBatchId: sourceSubId,
      sex: sourceSubSex,
      sendCount,
      today: todayCentralISO(),
    });
    if (recon.error) {
      // Surface to console + abort. The modal-side validation should
      // have caught this; if we got here, the plannedTrips changed
      // under us. Refusing without writes is the safe path.
      console.warn('sendEntriesToTrip reconciliation refused:', recon.error);
      return;
    }

    const sourceSub = (g.subBatches || []).find((sb) => sb.id === sourceSubId);
    if (!sourceSub) {
      console.warn('sendEntriesToTrip: source sub not found on group', groupId, sourceSubId);
      return;
    }

    const trips = (g.processingTrips || []).slice();
    const addWeights = selectedEntries.map((e) => parseFloat(e.weight) || 0).filter((w) => w > 0);
    const addCount = selectedEntries.length;

    // subAttributions row — denormalize subBatchName + sex onto the actual
    // processingTrips row per the §7 contract.
    const sexLabel = sourceSubSex === 'boar' ? 'Boars' : 'Gilts';
    const attRow = {subId: sourceSub.id, subBatchName: sourceSub.name, sex: sexLabel, count: addCount};

    // Always create a NEW actual processingTrips row dated to the target
    // planned trip's date. Each send is one actual trip; if the operator
    // sends to the same planned date twice, two actual rows result —
    // matches the existing semantics for non-planned sends.
    const newTripId = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    trips.push({
      id: newTripId,
      date: recon.targetTripDate,
      pigCount: addCount,
      liveWeights: addWeights.join(' '),
      hangingWeight: 0,
      notes: '',
      subAttributions: [attRow],
    });
    trips.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    g.processingTrips = trips;
    g.plannedProcessingTrips = recon.updatedPlannedTrips;
    groups[gi] = g;

    await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: groups}, {onConflict: 'key'});

    // Stamp every selected weigh_ins row with the actual trip + group.
    for (const e of selectedEntries) {
      await sb
        .from('weigh_ins')
        .update({
          sent_to_trip_id: newTripId,
          sent_to_group_id: groupId,
        })
        .eq('id', e.id);
    }

    setFeederGroups(groups);
    setSelectedEntryIds(new Set());
    setTripModal(null);
    await loadAll();
  }
  async function undoSendToTrip(entry) {
    if (!entry || !entry.sent_to_trip_id || !entry.sent_to_group_id) return;
    if (!canManagePigPlannedTrips) {
      console.warn('undoSendToTrip refused: caller lacks admin/management role');
      return;
    }
    const groups = feederGroups.slice();
    const gi = groups.findIndex((g) => g.id === entry.sent_to_group_id);
    if (gi >= 0) {
      const g = {...groups[gi]};
      const trips = (g.processingTrips || []).map((t) => {
        if (t.id !== entry.sent_to_trip_id) return t;
        const nt = {...t};
        nt.pigCount = Math.max(0, (parseInt(nt.pigCount) || 0) - 1);
        // Remove one occurrence of the weight from the liveWeights string
        const targetW = parseFloat(entry.weight);
        const parts = (nt.liveWeights || '').split(/\s+/).filter(Boolean);
        const idx = parts.findIndex((p) => parseFloat(p) === targetW);
        if (idx >= 0) parts.splice(idx, 1);
        nt.liveWeights = parts.join(' ');
        return nt;
      });
      g.processingTrips = trips;
      groups[gi] = g;
      await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: groups}, {onConflict: 'key'});
      setFeederGroups(groups);
    }
    await sb.from('weigh_ins').update({sent_to_trip_id: null, sent_to_group_id: null}).eq('id', entry.id);
    await loadAll();
  }

  // Reverse a transfer-to-breeding: drops the breeder (if still present),
  // increments the parent + sub batch counts back, decrements the batch's
  // feedAllocatedToTransfers, and clears the weigh-in entry. Also strips
  // the legacy [transferred_to_breeding ...] note marker if present.
  async function undoTransferToBreeding(session, entry) {
    if (!entry) return;
    if (!window._wcfConfirmDelete) {
      /* no-op: confirm helper missing */
    }
    const noteMarker = (entry.note || '').match(/\[transferred_to_breeding\s+breeder=([^\s\]]+)\s+feed_alloc=([\d.]+)/);
    const breederId = entry.transfer_breeder_id || (noteMarker ? noteMarker[1] : null);
    let feedAlloc = parseFloat(entry.feed_allocation_lbs);
    if (!Number.isFinite(feedAlloc) || feedAlloc <= 0) feedAlloc = noteMarker ? parseFloat(noteMarker[2]) : 0;
    if (!Number.isFinite(feedAlloc)) feedAlloc = 0;
    if (!entry.transferred_to_breeding && !noteMarker) {
      alert("This entry doesn't appear to be transferred — nothing to undo.");
      return;
    }
    // 1. Drop the breeder if still present.
    if (breederId) {
      const brR = await sb.from('app_store').select('data').eq('key', 'ppp-breeders-v1').maybeSingle();
      if (!brR.error) {
        const cur = brR.data && Array.isArray(brR.data.data) ? brR.data.data : [];
        const next = cur.filter((b) => b.id !== breederId);
        if (next.length !== cur.length) {
          await sb.from('app_store').upsert({key: 'ppp-breeders-v1', data: next}, {onConflict: 'key'});
        }
      }
    }
    // 2. Reverse the parent feed allocation. Started counts are not mutated
    //    by transfers (and therefore not reversed by undo) — see the
    //    transfer flow above.
    const {parent} = resolveBatchAndSub(session.batch_id);
    if (parent) {
      const updated = feederGroups.map((g) => {
        if (g.id !== parent.id) return g;
        return {
          ...g,
          feedAllocatedToTransfers: Math.max(0, (parseFloat(g.feedAllocatedToTransfers) || 0) - feedAlloc),
        };
      });
      setFeederGroups(updated);
      await sb.from('app_store').upsert({key: 'ppp-feeders-v1', data: updated}, {onConflict: 'key'});
    }
    // 3. Clear the weigh-in stamp / strip the note marker.
    const cleanedNote = (entry.note || '').replace(/^\[transferred_to_breeding[^\]]*\]\s*/, '') || null;
    await sb
      .from('weigh_ins')
      .update({
        transferred_to_breeding: false,
        transfer_breeder_id: null,
        feed_allocation_lbs: null,
        note: cleanedNote,
      })
      .eq('id', entry.id);
    await loadAll();
  }

  const filtered = sessions.filter((s) => statusFilter === 'all' || s.status === statusFilter);
  const totalEntries = filtered.reduce((s, sess) => s + (entries[sess.id] ? entries[sess.id].length : 0), 0);

  return (
    <div style={{minHeight: '100vh', background: '#f1f3f2'}}>
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
      <Header />
      <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 12,
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          <div>
            <div style={{fontSize: 16, fontWeight: 700, color: '#111827'}}>{speciesLabel} Weigh-In Sessions</div>
            <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>
              {filtered.length} sessions {'\u00b7'} {totalEntries} total entries
            </div>
          </div>
          <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
            <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
              {[
                {k: 'all', l: 'All'},
                {k: 'draft', l: 'Drafts'},
                {k: 'complete', l: 'Complete'},
              ].map((o, oi) => (
                <button
                  key={o.k}
                  onClick={() => setStatusFilter(o.k)}
                  style={{
                    padding: '5px 10px',
                    border: 'none',
                    borderRight: oi < 2 ? '1px solid #d1d5db' : 'none',
                    fontFamily: 'inherit',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: statusFilter === o.k ? '#1e40af' : 'white',
                    color: statusFilter === o.k ? 'white' : '#6b7280',
                  }}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowNewModal(true)}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: 'none',
                background: '#1e40af',
                color: 'white',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {'\u2696\ufe0f New Weigh-In'}
            </button>
          </div>
        </div>
        {showNewModal && (
          <AdminNewWeighInModal
            sb={sb}
            species={species}
            onClose={() => setShowNewModal(false)}
            onCreated={(rec) => {
              loadAll().then(() => setExpandedSession(rec.id));
            }}
          />
        )}

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: '#9ca3af'}}>Loading{'\u2026'}</div>}
        {!loading && filtered.length === 0 && (
          <div
            style={{
              background: 'white',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: 13,
            }}
          >
            No weigh-in sessions yet. Click <strong>{'\u2696\ufe0f New Weigh-In'}</strong> to start one.
          </div>
        )}

        <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
          {filtered.map((s) => {
            const isExpanded = expandedSession === s.id;
            const sEntries = entries[s.id] || [];
            const avgWeight =
              sEntries.length > 0
                ? sEntries.reduce((sum, e) => sum + (parseFloat(e.weight) || 0), 0) / sEntries.length
                : 0;
            const isComplete = s.status === 'complete';
            const fieldsLocked = isComplete && !gridUnlocked;
            const inpEditableStyle = {
              fontFamily: 'inherit',
              fontSize: 13,
              padding: '6px 8px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              width: '100%',
              boxSizing: 'border-box',
              background: 'white',
              color: '#111827',
              outline: 'none',
            };
            const inpLockedStyle = {
              ...inpEditableStyle,
              background: '#f3f4f6',
              color: '#374151',
              cursor: 'not-allowed',
            };
            return (
              <div
                key={s.id}
                style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden'}}
              >
                <div
                  onClick={() => setExpandedSession(isExpanded ? null : s.id)}
                  style={{
                    padding: '10px 16px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                  className="hoverable-tile"
                >
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{isExpanded ? '\u25bc' : '\u25b6'}</span>
                  <span style={{fontSize: 13, fontWeight: 700, color: '#111827', minWidth: 120}}>
                    {s.batch_id || 'Unknown batch'}
                  </span>
                  {species === 'broiler' && s.broiler_week && (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '2px 8px',
                        borderRadius: 10,
                        background: '#fef3c7',
                        color: '#92400e',
                      }}
                    >
                      {'WK ' + s.broiler_week}
                    </span>
                  )}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 10,
                      background: isComplete ? '#d1fae5' : '#fef3c7',
                      color: isComplete ? '#065f46' : '#92400e',
                      textTransform: 'uppercase',
                    }}
                  >
                    {s.status}
                  </span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>{fmt(s.date)}</span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>{s.team_member}</span>
                  <span style={{fontSize: 11, fontWeight: 600, color: '#1e40af'}}>
                    {sEntries.length} {sEntries.length === 1 ? 'entry' : 'entries'}
                  </span>
                  {/* Avg-weight badge: cattle/sheep/broiler only. For pig
                    tiles the new metrics row below is the single source of
                    truth (Codex W3). */}
                  {species !== 'pig' && avgWeight > 0 && (
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: '#065f46',
                        padding: '2px 10px',
                        borderRadius: 10,
                        background: '#d1fae5',
                      }}
                    >
                      avg {Math.round(avgWeight * 100) / 100} lb
                    </span>
                  )}
                  {species === 'broiler' && avgWeight > 0 && s.broiler_week && (
                    <span style={{fontSize: 10, color: '#6b7280', fontStyle: 'italic'}}>
                      {'\u2192 batch wk' + s.broiler_week + 'Lbs'}
                    </span>
                  )}
                </div>
                {/* Pig metrics row (mig 049 RPC). Sibling under the main
                  tile row so the metrics don't push the existing fields
                  to wrap on narrow widths. Hidden when no entries yet
                  (matches the public form's W1 gate) or when the RPC
                  said available=false. */}
                {species === 'pig' &&
                  sEntries.length > 0 &&
                  pigMetricsBySession[s.id] &&
                  pigMetricsBySession[s.id].available && (
                    <div
                      data-pig-metrics-row={s.id}
                      style={{
                        padding: '8px 16px',
                        borderTop: '1px solid #f3f4f6',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                        gap: 8,
                        background: '#fafafa',
                      }}
                    >
                      <div data-pig-metric="age">
                        <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Age at weigh-in</div>
                        <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                          {formatAgeRange({
                            minDays: pigMetricsBySession[s.id].age_min_days,
                            maxDays: pigMetricsBySession[s.id].age_max_days,
                            hasActual: pigMetricsBySession[s.id].has_actual_farrowing,
                          })}
                        </div>
                      </div>
                      <div data-pig-metric="feed">
                        <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Feed/pig</div>
                        <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                          {formatFeedPerPig(pigMetricsBySession[s.id].feed_per_pig_lbs)}
                        </div>
                      </div>
                      <div data-pig-metric="adg">
                        <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Group ADG</div>
                        <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                          {formatGroupAdg(pigMetricsBySession[s.id].group_adg_lbs_per_day)}
                        </div>
                      </div>
                      <div data-pig-metric="avg">
                        <div style={{fontSize: 9, color: '#6b7280', textTransform: 'uppercase'}}>Avg weight</div>
                        <div style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                          {formatAvgWeight(pigMetricsBySession[s.id].avg_weight_lbs)}
                        </div>
                      </div>
                    </div>
                  )}
                {isExpanded && (
                  <div style={{borderTop: '1px solid #f3f4f6', padding: '12px 16px', background: '#fafafa'}}>
                    {species === 'broiler' &&
                      (() => {
                        // Build team-member options: active roster, with the
                        // session's CURRENT team_member injected (and marked
                        // "(retired)") if it's no longer in the active list.
                        // This avoids blank-rendering historical sessions
                        // and never offers other retired names.
                        const baseRoster = activeRoster;
                        const cur = (s.team_member || '').trim();
                        const includesCurrent = !cur || baseRoster.includes(cur);
                        const teamOptions = includesCurrent
                          ? baseRoster.map((n) => ({value: n, label: n}))
                          : [{value: cur, label: cur + ' (retired)'}, ...baseRoster.map((n) => ({value: n, label: n}))];
                        const metaDirty =
                          Number(metaWeek) !== Number(s.broiler_week) || (metaTeam || '').trim() !== cur;
                        const wkBtnStyle = (active) => ({
                          padding: '4px 10px',
                          borderRadius: 6,
                          border: '1px solid ' + (active ? '#1e40af' : '#d1d5db'),
                          background: active ? '#1e40af' : 'white',
                          color: active ? 'white' : '#374151',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        });
                        return (
                          <div
                            data-testid="broiler-meta-panel"
                            style={{
                              border: '1px solid #e5e7eb',
                              borderRadius: 8,
                              padding: '10px 12px',
                              marginBottom: 10,
                              background: 'white',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                            }}
                          >
                            <div style={{fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: 0.4}}>
                              {'SESSION METADATA'}
                            </div>
                            <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                              <span style={{fontSize: 12, color: '#374151', minWidth: 90}}>{'Week:'}</span>
                              <button
                                type="button"
                                data-testid="broiler-meta-wk4"
                                onClick={() => setMetaWeek(4)}
                                aria-pressed={Number(metaWeek) === 4}
                                style={wkBtnStyle(Number(metaWeek) === 4)}
                              >
                                {'WK 4'}
                              </button>
                              <button
                                type="button"
                                data-testid="broiler-meta-wk6"
                                onClick={() => setMetaWeek(6)}
                                aria-pressed={Number(metaWeek) === 6}
                                style={wkBtnStyle(Number(metaWeek) === 6)}
                              >
                                {'WK 6'}
                              </button>
                            </div>
                            <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                              <span style={{fontSize: 12, color: '#374151', minWidth: 90}}>{'Team Member:'}</span>
                              <select
                                data-testid="broiler-meta-team"
                                value={metaTeam}
                                onChange={(e) => setMetaTeam(e.target.value)}
                                style={{
                                  fontFamily: 'inherit',
                                  fontSize: 13,
                                  padding: '6px 8px',
                                  border: '1px solid #d1d5db',
                                  borderRadius: 6,
                                  background: 'white',
                                  minWidth: 160,
                                }}
                              >
                                {teamOptions.map((opt) => (
                                  <option key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {metaDirty && (
                              <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
                                <button
                                  type="button"
                                  data-testid="broiler-meta-save"
                                  onClick={() => saveSessionMetadata(s)}
                                  disabled={metaBusy}
                                  style={{
                                    padding: '4px 12px',
                                    borderRadius: 6,
                                    border: 'none',
                                    background: metaBusy ? '#9ca3af' : '#1e40af',
                                    color: 'white',
                                    fontSize: 11,
                                    fontWeight: 600,
                                    cursor: metaBusy ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {metaBusy ? 'Saving…' : 'Save Metadata'}
                                </button>
                              </div>
                            )}
                            {metaErr && (
                              <div data-testid="broiler-meta-err" style={{fontSize: 11, color: '#b91c1c'}}>
                                {metaErr}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    <div style={{display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap'}}>
                      {isComplete && !gridUnlocked && (
                        <button
                          onClick={() => setGridUnlocked(true)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #1e40af',
                            background: '#eff6ff',
                            color: '#1e40af',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {'\u270e Edit Weights'}
                        </button>
                      )}
                      {species === 'broiler' && isComplete && (
                        <button
                          type="button"
                          data-testid="broiler-reopen-session"
                          onClick={() => reopenSession(s)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #d1d5db',
                            background: 'white',
                            color: '#0f766e',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Reopen Session
                        </button>
                      )}
                      {!isComplete && (
                        <button
                          onClick={() => completeFromAdmin(s)}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid #047857',
                            background: '#047857',
                            color: 'white',
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {'\u2713 Complete Weigh-In'}
                        </button>
                      )}
                      <button
                        onClick={() => deleteSession(s)}
                        style={{
                          marginLeft: 'auto',
                          padding: '4px 10px',
                          borderRadius: 6,
                          border: '1px solid #F09595',
                          background: 'white',
                          color: '#b91c1c',
                          fontSize: 11,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Delete Weigh-In
                      </button>
                    </div>
                    {actionErr && actionErr.id === s.id && (
                      <div data-testid="broiler-reopen-err" style={{fontSize: 11, color: '#b91c1c', marginBottom: 10}}>
                        {actionErr.message}
                      </div>
                    )}

                    {gridLabels.length > 0 && (
                      <React.Fragment>
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(' + gridLabels.length + ', 1fr)',
                            gap: 8,
                            marginBottom: 10,
                          }}
                        >
                          {gridLabels.map(function (label, col) {
                            return (
                              <div key={col}>
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    color: '#374151',
                                    textAlign: 'center',
                                    padding: '4px 0',
                                    marginBottom: 4,
                                    background: '#eef2ff',
                                    borderRadius: 6,
                                  }}
                                >
                                  {species === 'broiler' ? 'Schooner ' + label : 'Col ' + label}
                                </div>
                                {Array.from({length: 15}).map(function (_, row) {
                                  var idx = col * 15 + row;
                                  return (
                                    <div
                                      key={row}
                                      style={{display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3}}
                                    >
                                      <span
                                        style={{
                                          fontSize: 10,
                                          color: '#9ca3af',
                                          minWidth: 18,
                                          textAlign: 'right',
                                          fontVariantNumeric: 'tabular-nums',
                                        }}
                                      >
                                        {row + 1}
                                      </span>
                                      <input
                                        type="number"
                                        min="0"
                                        step="0.1"
                                        value={gridInputs[idx] || ''}
                                        disabled={fieldsLocked}
                                        readOnly={fieldsLocked}
                                        onChange={function (e) {
                                          var v = e.target.value;
                                          setGridInputs(function (prev) {
                                            var next = prev.slice();
                                            next[idx] = v;
                                            return next;
                                          });
                                        }}
                                        placeholder="0"
                                        style={fieldsLocked ? inpLockedStyle : inpEditableStyle}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                        <div style={{marginBottom: 10}}>
                          <label
                            style={{display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600}}
                          >
                            Session note
                          </label>
                          <textarea
                            value={gridNote}
                            disabled={fieldsLocked}
                            readOnly={fieldsLocked}
                            onChange={(ev) => setGridNote(ev.target.value)}
                            rows={2}
                            placeholder="Optional"
                            style={{...(fieldsLocked ? inpLockedStyle : inpEditableStyle), resize: 'vertical'}}
                          />
                        </div>
                        {gridErr && (
                          <div
                            style={{
                              color: '#b91c1c',
                              fontSize: 12,
                              marginBottom: 8,
                              padding: '6px 10px',
                              background: '#fef2f2',
                              borderRadius: 6,
                            }}
                          >
                            {gridErr}
                          </div>
                        )}
                        {!fieldsLocked && (
                          <button
                            onClick={() => saveAdminGrid(s)}
                            disabled={savingGrid}
                            style={{
                              padding: '8px 16px',
                              borderRadius: 7,
                              border: 'none',
                              background: savingGrid ? '#9ca3af' : '#1e40af',
                              color: 'white',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: savingGrid ? 'not-allowed' : 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            {savingGrid ? 'Saving\u2026' : 'Save Weights'}
                          </button>
                        )}
                        {isComplete && !gridUnlocked && (
                          <div style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                            Click <strong>{'\u270e Edit Weights'}</strong> above to make changes.
                          </div>
                        )}
                      </React.Fragment>
                    )}
                    {species === 'pig' &&
                      (() => {
                        const lookupTrip = (e) => {
                          const g = feederGroups.find((x) => x.id === e.sent_to_group_id);
                          if (!g) return null;
                          const t = (g.processingTrips || []).find((x) => x.id === e.sent_to_trip_id);
                          return t ? {group: g, trip: t} : null;
                        };
                        const toggle = (id) =>
                          setSelectedEntryIds((prev) => {
                            const n = new Set(prev);
                            if (n.has(id)) n.delete(id);
                            else n.add(id);
                            return n;
                          });
                        const unsent = sEntries.filter((e) => !e.sent_to_trip_id);
                        const sel = unsent.filter((e) => selectedEntryIds.has(e.id));
                        const rowInpS = {
                          fontSize: 12,
                          padding: '5px 8px',
                          border: '1px solid #d1d5db',
                          borderRadius: 5,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                          background: 'white',
                        };
                        return (
                          <div style={{marginTop: 4, paddingTop: 12, borderTop: '1px dashed #d1d5db'}}>
                            {/* Session summary — full breakdown of every entry's
                              outcome (sent / transferred / remaining) plus
                              feed credited to transfers. */}
                            {(() => {
                              const sentEntries = sEntries.filter((e) => e.sent_to_trip_id);
                              const transferredEntries = sEntries.filter(
                                (e) => e.transferred_to_breeding || /\[transferred_to_breeding/.test(e.note || ''),
                              );
                              const remainingEntries = sEntries.filter(
                                (e) =>
                                  !e.sent_to_trip_id &&
                                  !e.transferred_to_breeding &&
                                  !/\[transferred_to_breeding/.test(e.note || ''),
                              );
                              const sumW = (arr) => arr.reduce((s, e) => s + (parseFloat(e.weight) || 0), 0);
                              const sentW = sumW(sentEntries);
                              const transW = sumW(transferredEntries);
                              const remW = sumW(remainingEntries);
                              const totalFeedCredited = transferredEntries.reduce((s, e) => {
                                let v = parseFloat(e.feed_allocation_lbs);
                                if (!Number.isFinite(v) || v <= 0) {
                                  const m = (e.note || '').match(/feed_alloc=([\d.]+)/);
                                  if (m) v = parseFloat(m[1]);
                                }
                                return s + (Number.isFinite(v) ? v : 0);
                              }, 0);
                              if (sEntries.length === 0) return null;
                              return (
                                <div
                                  style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                                    gap: 8,
                                    marginBottom: 12,
                                    padding: '10px 12px',
                                    background: '#f9fafb',
                                    border: '1px solid #e5e7eb',
                                    borderRadius: 8,
                                  }}
                                >
                                  <div>
                                    <div
                                      style={{
                                        fontSize: 10,
                                        color: '#9ca3af',
                                        textTransform: 'uppercase',
                                        letterSpacing: 0.4,
                                      }}
                                    >
                                      Total entries
                                    </div>
                                    <div style={{fontSize: 14, fontWeight: 700, color: '#111827'}}>
                                      {sEntries.length}
                                    </div>
                                  </div>
                                  {sentEntries.length > 0 && (
                                    <div>
                                      <div
                                        style={{
                                          fontSize: 10,
                                          color: '#9ca3af',
                                          textTransform: 'uppercase',
                                          letterSpacing: 0.4,
                                        }}
                                      >
                                        Sent to trip
                                      </div>
                                      <div style={{fontSize: 14, fontWeight: 700, color: '#047857'}}>
                                        {sentEntries.length} {'· '}
                                        {Math.round(sentW)} lb
                                      </div>
                                    </div>
                                  )}
                                  {transferredEntries.length > 0 && (
                                    <div>
                                      <div
                                        style={{
                                          fontSize: 10,
                                          color: '#9ca3af',
                                          textTransform: 'uppercase',
                                          letterSpacing: 0.4,
                                        }}
                                      >
                                        {'→ Breeding'}
                                      </div>
                                      <div style={{fontSize: 14, fontWeight: 700, color: '#5b21b6'}}>
                                        {transferredEntries.length} {'· '}
                                        {Math.round(transW)} lb
                                      </div>
                                    </div>
                                  )}
                                  {totalFeedCredited > 0 && (
                                    <div>
                                      <div
                                        style={{
                                          fontSize: 10,
                                          color: '#9ca3af',
                                          textTransform: 'uppercase',
                                          letterSpacing: 0.4,
                                        }}
                                      >
                                        Feed credited out
                                      </div>
                                      <div style={{fontSize: 14, fontWeight: 700, color: '#5b21b6'}}>
                                        {Math.round(totalFeedCredited).toLocaleString()} lb
                                      </div>
                                    </div>
                                  )}
                                  {remainingEntries.length > 0 && (
                                    <div>
                                      <div
                                        style={{
                                          fontSize: 10,
                                          color: '#9ca3af',
                                          textTransform: 'uppercase',
                                          letterSpacing: 0.4,
                                        }}
                                      >
                                        Remaining
                                      </div>
                                      <div style={{fontSize: 14, fontWeight: 700, color: '#1e40af'}}>
                                        {remainingEntries.length} {'· '}
                                        {Math.round(remW)} lb
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                            <div style={{fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8}}>
                              Weights ({sEntries.length})
                            </div>
                            {sEntries.length === 0 && (
                              <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic', padding: '6px 0'}}>
                                No entries in this session yet.
                              </div>
                            )}
                            {/* Display order: descending by weight. Persisted
                              order (entered_at) and the load query are
                              unchanged; this is render-only. Codex W5 lock
                              covers the no-mutation invariant via static
                              test. */}
                            {[...sEntries]
                              .sort((a, b) => (parseFloat(b.weight) || 0) - (parseFloat(a.weight) || 0))
                              .map((e) => {
                                const isSent = !!e.sent_to_trip_id;
                                // Detect transferred state via either the proper column
                                // (when migration 014 has been applied) or the legacy
                                // note-marker fallback that the transfer flow writes
                                // when the column doesn't exist yet.
                                const isTransferred =
                                  !!e.transferred_to_breeding || /\[transferred_to_breeding/.test(e.note || '');
                                const link = isSent ? lookupTrip(e) : null;
                                const checked = selectedEntryIds.has(e.id);
                                const editable = !isSent && !isTransferred && !fieldsLocked;
                                // Action buttons (Breeding transfer, Delete, etc) stay
                                // available on completed/locked sessions. Final-trip
                                // decisions like "this gilt becomes a sow" need to
                                // happen post-completion without unlocking weights.
                                const canAct = !isSent && !isTransferred;
                                return (
                                  <div
                                    key={e.id}
                                    style={{
                                      display: 'grid',
                                      gridTemplateColumns: '24px 90px 1fr auto',
                                      gap: 8,
                                      padding: '6px 0',
                                      borderBottom: '1px solid #f3f4f6',
                                      alignItems: 'center',
                                    }}
                                  >
                                    {/* Col 1: select-to-trip checkbox (or spacer).
                                      Pig planned trips lane: gated on
                                      canManagePigPlannedTrips (admin/management).
                                      farm_team is read-only across the entire
                                      pig planned/processing trip surface. */}
                                    <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center'}}>
                                      {editable && canManagePigPlannedTrips && (
                                        <input
                                          type="checkbox"
                                          data-pig-send-select="1"
                                          checked={checked}
                                          onChange={() => toggle(e.id)}
                                          style={{margin: 0}}
                                          title="Select to send to trip"
                                        />
                                      )}
                                    </div>
                                    {/* Col 2: weight (input or read-only) */}
                                    <div>
                                      {editable ? (
                                        <input
                                          type="number"
                                          min="0"
                                          step="0.1"
                                          defaultValue={e.weight}
                                          onBlur={(ev) => {
                                            const v = parseFloat(ev.target.value);
                                            if (Number.isFinite(v) && v > 0 && v !== parseFloat(e.weight))
                                              updatePigEntry(e.id, {weight: v});
                                          }}
                                          style={{...rowInpS, width: '100%'}}
                                        />
                                      ) : (
                                        <span
                                          style={{
                                            fontWeight: 700,
                                            color: isSent ? '#047857' : isTransferred ? '#5b21b6' : '#1e40af',
                                            fontSize: 13,
                                          }}
                                        >
                                          {e.weight} lb
                                        </span>
                                      )}
                                    </div>
                                    {/* Col 3: note input OR sent/transferred badge */}
                                    <div
                                      style={{
                                        minWidth: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      {editable && (
                                        <input
                                          type="text"
                                          placeholder="Note (optional)"
                                          defaultValue={e.note || ''}
                                          onBlur={(ev) => {
                                            const v = (ev.target.value || '').trim() || null;
                                            if (v !== (e.note || null)) updatePigEntry(e.id, {note: v});
                                          }}
                                          style={{...rowInpS, flex: 1, minWidth: 120}}
                                        />
                                      )}
                                      {isSent && link && (
                                        <span
                                          style={{
                                            fontSize: 11,
                                            padding: '2px 8px',
                                            borderRadius: 4,
                                            background: '#d1fae5',
                                            color: '#065f46',
                                            fontWeight: 600,
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          {'\u2192 ' + link.group.batchName + ' \u00b7 ' + fmt(link.trip.date)}
                                        </span>
                                      )}
                                      {isSent && !link && (
                                        <span style={{fontSize: 11, color: '#b91c1c', fontStyle: 'italic'}}>
                                          (missing trip)
                                        </span>
                                      )}
                                      {isTransferred &&
                                        (() => {
                                          let feedLb = parseFloat(e.feed_allocation_lbs);
                                          if (!Number.isFinite(feedLb) || feedLb <= 0) {
                                            const m = (e.note || '').match(/feed_alloc=([\d.]+)/);
                                            if (m) feedLb = parseFloat(m[1]);
                                          }
                                          const feedTxt =
                                            Number.isFinite(feedLb) && feedLb > 0
                                              ? ' · ~' + Math.round(feedLb) + ' lb feed'
                                              : '';
                                          return (
                                            <span
                                              style={{
                                                fontSize: 11,
                                                padding: '2px 8px',
                                                borderRadius: 4,
                                                background: '#ede9fe',
                                                color: '#5b21b6',
                                                fontWeight: 600,
                                                whiteSpace: 'nowrap',
                                              }}
                                            >
                                              {'→ Transferred to Breeding' + feedTxt}
                                            </span>
                                          );
                                        })()}
                                      {!editable &&
                                        (() => {
                                          // Hide the transferred-to-breeding marker from the
                                          // visible note (it's an internal stamp from the
                                          // pre-migration fallback path).
                                          const cleanNote = (e.note || '').replace(
                                            /^\[transferred_to_breeding[^\]]*\]\s*/,
                                            '',
                                          );
                                          return cleanNote ? (
                                            <span style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic'}}>
                                              {cleanNote}
                                            </span>
                                          ) : null;
                                        })()}
                                    </div>
                                    {/* Col 4: action buttons */}
                                    <div style={{display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0}}>
                                      {canAct && (
                                        <button
                                          onClick={() => openTransferModal(s, e)}
                                          title="Transfer to breeding pigs"
                                          style={{
                                            background: '#f5f3ff',
                                            border: '1px solid #ddd6fe',
                                            borderRadius: 5,
                                            color: '#5b21b6',
                                            cursor: 'pointer',
                                            fontSize: 11,
                                            padding: '3px 8px',
                                            fontFamily: 'inherit',
                                            fontWeight: 600,
                                          }}
                                        >
                                          {'\u2192 Breeding'}
                                        </button>
                                      )}
                                      {isSent && canManagePigPlannedTrips && (
                                        <button
                                          data-pig-send-undo="1"
                                          onClick={() => undoSendToTrip(e)}
                                          title="Undo send to trip"
                                          style={{
                                            background: 'none',
                                            border: '1px solid #fecaca',
                                            borderRadius: 5,
                                            color: '#b91c1c',
                                            cursor: 'pointer',
                                            fontSize: 11,
                                            padding: '2px 8px',
                                            fontFamily: 'inherit',
                                          }}
                                        >
                                          Undo send
                                        </button>
                                      )}
                                      {isTransferred && (
                                        <button
                                          onClick={() => undoTransferToBreeding(s, e)}
                                          title="Reverse the transfer to breeding (puts pig back in batch + restores feed allocation)"
                                          style={{
                                            background: 'none',
                                            border: '1px solid #ddd6fe',
                                            borderRadius: 5,
                                            color: '#5b21b6',
                                            cursor: 'pointer',
                                            fontSize: 11,
                                            padding: '2px 8px',
                                            fontFamily: 'inherit',
                                          }}
                                        >
                                          Undo transfer
                                        </button>
                                      )}
                                      {editable && (
                                        <button
                                          onClick={() => deletePigEntry(e.id)}
                                          title="Delete entry"
                                          style={{
                                            background: 'none',
                                            border: '1px solid #fecaca',
                                            borderRadius: 5,
                                            color: '#b91c1c',
                                            cursor: 'pointer',
                                            fontSize: 11,
                                            padding: '2px 8px',
                                            fontFamily: 'inherit',
                                          }}
                                        >
                                          Delete
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}

                            {/* Add entry row */}
                            {!fieldsLocked && (
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  marginTop: 10,
                                  padding: '8px 10px',
                                  background: '#eff6ff',
                                  border: '1px dashed #bfdbfe',
                                  borderRadius: 6,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span style={{fontSize: 11, fontWeight: 600, color: '#1e40af'}}>+ Add:</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.1"
                                  placeholder="Weight (lb)"
                                  value={pigAddEntry.weight}
                                  onChange={(ev) => setPigAddEntry((p) => ({...p, weight: ev.target.value}))}
                                  style={{...rowInpS, width: 110}}
                                />
                                <input
                                  type="text"
                                  placeholder="Note (optional)"
                                  value={pigAddEntry.note}
                                  onChange={(ev) => setPigAddEntry((p) => ({...p, note: ev.target.value}))}
                                  style={{...rowInpS, flex: 1, minWidth: 120}}
                                />
                                <button
                                  onClick={() => addPigEntry(s.id)}
                                  disabled={pigBusy || !pigAddEntry.weight}
                                  style={{
                                    padding: '6px 14px',
                                    borderRadius: 5,
                                    border: 'none',
                                    background: pigBusy || !pigAddEntry.weight ? '#9ca3af' : '#1e40af',
                                    color: 'white',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: pigBusy || !pigAddEntry.weight ? 'not-allowed' : 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {pigBusy ? 'Saving\u2026' : 'Add'}
                                </button>
                              </div>
                            )}
                            {pigErr && (
                              <div
                                style={{
                                  color: '#b91c1c',
                                  fontSize: 12,
                                  marginTop: 8,
                                  padding: '6px 10px',
                                  background: '#fef2f2',
                                  borderRadius: 6,
                                }}
                              >
                                {pigErr}
                              </div>
                            )}

                            {/* Session note */}
                            <div style={{marginTop: 12}}>
                              <label
                                style={{
                                  display: 'block',
                                  fontSize: 12,
                                  color: '#374151',
                                  marginBottom: 4,
                                  fontWeight: 600,
                                }}
                              >
                                Session note
                              </label>
                              <textarea
                                defaultValue={s.notes || ''}
                                disabled={fieldsLocked}
                                readOnly={fieldsLocked}
                                onBlur={(ev) => {
                                  if ((ev.target.value || '') !== (s.notes || ''))
                                    savePigSessionNote(s.id, ev.target.value || '');
                                }}
                                rows={2}
                                placeholder="Optional"
                                style={{...(fieldsLocked ? inpLockedStyle : inpEditableStyle), resize: 'vertical'}}
                              />
                            </div>

                            {/* Send-to-Trip action bar — admin/management only.
                              farm_team can view the session and weights but
                              cannot mutate planned/processing trip state. */}
                            {unsent.length > 0 && !fieldsLocked && canManagePigPlannedTrips && (
                              <div
                                data-pig-send-bar="1"
                                style={{
                                  marginTop: 12,
                                  paddingTop: 10,
                                  borderTop: '1px dashed #e5e7eb',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span style={{fontSize: 11, color: '#6b7280'}}>{'\ud83d\ude9a Send to trip:'}</span>
                                <button
                                  onClick={() => setSelectedEntryIds(new Set(unsent.map((e) => e.id)))}
                                  style={{
                                    fontSize: 11,
                                    color: '#1d4ed8',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  Select all unsent ({unsent.length})
                                </button>
                                {selectedEntryIds.size > 0 && (
                                  <button
                                    onClick={() => setSelectedEntryIds(new Set())}
                                    style={{
                                      fontSize: 11,
                                      color: '#6b7280',
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      fontFamily: 'inherit',
                                    }}
                                  >
                                    Clear
                                  </button>
                                )}
                                <button
                                  disabled={sel.length === 0}
                                  onClick={() => setTripModal({session: s, entries: sel})}
                                  style={{
                                    marginLeft: 'auto',
                                    padding: '6px 14px',
                                    borderRadius: 6,
                                    border: 'none',
                                    background: sel.length > 0 ? '#047857' : '#d1d5db',
                                    color: 'white',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: sel.length > 0 ? 'pointer' : 'not-allowed',
                                    fontFamily: 'inherit',
                                  }}
                                >
                                  {'\u2192 Send ' + sel.length + ' to Trip'}
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {tripModal && (
        <PigSendToTripModal
          session={tripModal.session}
          selectedEntries={tripModal.entries}
          feederGroups={feederGroups}
          onClose={() => setTripModal(null)}
          onConfirm={sendEntriesToTrip}
        />
      )}
      {/* Transfer-to-Breeding modal */}
      {transferModal &&
        (() => {
          const {session, entry} = transferModal;
          const {parent, sub} = resolveBatchAndSub(session.batch_id);
          const fcr = parent ? batchFCR(parent) : 3.5;
          const weight = parseFloat(entry.weight) || 0;
          const previewAlloc = Math.round(weight * fcr * 10) / 10;
          return (
            <div
              onClick={() => !transferBusy && setTransferModal(null)}
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,.45)',
                zIndex: 600,
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
                  maxWidth: 460,
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
                  <div style={{fontSize: 15, fontWeight: 600, color: '#5b21b6'}}>{'→ Transfer to Breeding'}</div>
                  <button
                    onClick={() => setTransferModal(null)}
                    disabled={transferBusy}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: 22,
                      cursor: transferBusy ? 'not-allowed' : 'pointer',
                      color: '#9ca3af',
                      lineHeight: 1,
                    }}
                  >
                    {'×'}
                  </button>
                </div>
                <div style={{padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12}}>
                  <div style={{fontSize: 12, color: '#6b7280'}}>
                    From <strong>{(parent && parent.batchName) || session.batch_id}</strong>
                    {sub && (
                      <>
                        {' '}
                        {'·'} sub-batch <strong>{sub.name}</strong>
                      </>
                    )}
                    {' · weighed '}
                    <strong>{entry.weight} lb</strong>
                  </div>
                  <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                    <div>
                      <label
                        style={{display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600}}
                      >
                        {'New tag # *'}
                      </label>
                      <input
                        type="text"
                        value={transferForm.tag}
                        onChange={(e) => setTransferForm({...transferForm, tag: e.target.value})}
                        placeholder="e.g. 26"
                        style={{
                          width: '100%',
                          fontSize: 13,
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                    <div>
                      <label
                        style={{display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600}}
                      >
                        Group *
                      </label>
                      <select
                        value={transferForm.group}
                        onChange={(e) => setTransferForm({...transferForm, group: e.target.value})}
                        style={{
                          width: '100%',
                          fontSize: 13,
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                          background: 'white',
                        }}
                      >
                        <option value="1">Group 1</option>
                        <option value="2">Group 2</option>
                        <option value="3">Group 3</option>
                      </select>
                    </div>
                    <div>
                      <label
                        style={{display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600}}
                      >
                        Sex
                      </label>
                      <select
                        value={transferForm.sex}
                        onChange={(e) => setTransferForm({...transferForm, sex: e.target.value})}
                        style={{
                          width: '100%',
                          fontSize: 13,
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                          background: 'white',
                        }}
                      >
                        <option value="Gilt">Gilt</option>
                        <option value="Sow">Sow</option>
                        <option value="Boar">Boar</option>
                      </select>
                    </div>
                    <div>
                      <label
                        style={{display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600}}
                      >
                        Birth date (est.)
                      </label>
                      <input
                        type="date"
                        value={transferForm.birthDate}
                        onChange={(e) => setTransferForm({...transferForm, birthDate: e.target.value})}
                        style={{
                          width: '100%',
                          fontSize: 13,
                          padding: '8px 10px',
                          border: '1px solid #d1d5db',
                          borderRadius: 6,
                          fontFamily: 'inherit',
                          boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#5b21b6',
                      background: '#f5f3ff',
                      border: '1px solid #ddd6fe',
                      borderRadius: 6,
                      padding: '8px 10px',
                    }}
                  >
                    Feed allocation: <strong>{previewAlloc} lb</strong>
                    {' · weight ' + entry.weight + ' lb × FCR ' + fcr.toFixed(2)}
                    {(!parent || !parent.fcrCached) && (
                      <span style={{color: '#92400e'}}> {'(default FCR — no completed trips yet)'}</span>
                    )}
                    <div style={{marginTop: 3, color: '#7c3aed'}}>
                      This amount is subtracted from the batch's feed total so per-pig math stays accurate.
                    </div>
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
                    onClick={() => setTransferModal(null)}
                    disabled={transferBusy}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 7,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      fontWeight: 600,
                      fontSize: 12,
                      cursor: transferBusy ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={transferToBreeding}
                    disabled={transferBusy || !transferForm.tag.trim()}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 7,
                      border: 'none',
                      background: transferBusy || !transferForm.tag.trim() ? '#9ca3af' : '#5b21b6',
                      color: 'white',
                      fontWeight: 700,
                      fontSize: 12,
                      cursor: transferBusy || !transferForm.tag.trim() ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {transferBusy ? 'Transferring…' : '→ Transfer'}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
};

export default LivestockWeighInsView;
