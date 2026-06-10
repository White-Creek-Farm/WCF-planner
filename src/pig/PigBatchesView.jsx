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
import {recordActivityEvent} from '../lib/activityApi.js';
import {fmtS} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {
  calcBreedingTimeline,
  calcCycleStatus,
  buildCycleSeqMap,
  cycleLabel,
  pigTransfersForSub,
  pigTripPigsForSub,
  pigTripPigsAttributed,
  pigMortalityForSub,
  calcAgeRange as libCalcAgeRange,
  pigSlug,
  computeBatchCurrentCount,
  computeSubCurrentCount,
  batchStartedCount,
  pigTransfersForBatch,
  processingTripPigCount,
  tripTotalLive,
  pigMortalityForBatch,
  computePigBatchFCR,
} from '../lib/pig.js';
import {
  PLANNED_TRIP_TARGET_WEIGHT_LBS,
  allocatePlannedTrips,
  buildFarrowingAgeDistribution,
  projectFarrowingAgeWindow,
  seedGlobalADG,
} from '../lib/pigForecast.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {useNavigate, useLocation} from 'react-router-dom';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildPigBatchExportColumns} from '../lib/operationalExportColumns.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import {useAuth} from '../contexts/AuthContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import PigBatchHubTile, {PIG_BATCH_GRID_COLUMNS} from './PigBatchHubTile.jsx';
import {usePigMortality} from './usePigMortality.js';
import {usePigSubBatches} from './usePigSubBatches.js';
import {usePigPlannedTrips} from './usePigPlannedTrips.js';
import {usePigProcessingTrips} from './usePigProcessingTrips.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import PigBatchPage from './PigBatchPage.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import {RecordPageLoading, RecordPageNotFound} from '../shared/RecordPageShell.jsx';

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
  // Inline notice shared across this view's modals + page-level actions
  // (mortality, sub-batch, feeder form, ADG input). Cleared on each
  // action entry; failure paths set + return.
  const [notice, setNotice] = React.useState(null);
  const [showArchBatches, setShowArchBatches] = React.useState(true);
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
    feedersLoaded,
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
  } = usePig();
  // Sub-batch (partition) workflow — state + handlers live in usePigSubBatches
  // (CP8). partitionDirtyRef stays view-owned (closeFeederForm also reads it).
  const subBatches = usePigSubBatches({
    feederGroups,
    setFeederGroups,
    persistFeeders,
    setNotice,
    confirmDelete,
    subAutoSaveTimer,
    pigAutoSaveTimer,
    partitionDirtyRef,
    breeders,
  });
  // The hub Add-Batch flow + the feeder-form partition editor (both stay in this
  // view) use these two; the rest of the sub-batch API is consumed on the record
  // page via the bundle spread below.
  const {setShowSubForm, updSubPartition} = subBatches;
  // Manager gate (admin OR management) — used by the planned-trip workflow plus
  // the Global ADG editor + planned-trip JSX. Computed here so the hook below
  // and the later JSX share one source.
  const isManager = !!(authState && (authState.role === 'admin' || authState.role === 'management'));
  // Planned-processing-trip workflow — state + lock sidecar + handlers live in
  // usePigPlannedTrips (CP9). Planned-trip JSX below consumes these.
  const plannedTrips = usePigPlannedTrips({feederGroups, persistFeeders, authState, isManager});
  // Processing-trip workflow — trip-source tracking + add/edit/close/delete live
  // in usePigProcessingTrips (CP10). Trip FORM state stays owned by PigContext
  // (threaded in). dailysForName is hoisted (function decl) so it's available here.
  const processingTrips = usePigProcessingTrips({
    feederGroups,
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
  });
  const {pigDailys} = useDailysRecent();
  const {setView} = useUI();
  const navigate = useNavigate();
  const location = useLocation();
  // Record-page routing: /pig/batches/<encodeURIComponent(group.id)> renders the
  // single selected batch's full workspace; the bare hub renders nav-only tiles.
  // group.id is the stable route identity; batchName stays the display label.
  const recordMode = location.pathname.startsWith('/pig/batches/');
  // decode in a try/catch — a malformed %-sequence (e.g. /pig/batches/%) would
  // otherwise throw; fall back to the raw slice so it just resolves to
  // not-found instead of crashing the view (mirrors BroilerBatchPage).
  const recordRawId = recordMode ? location.pathname.slice('/pig/batches/'.length) : null;
  let recordId = recordRawId;
  if (recordMode) {
    try {
      recordId = decodeURIComponent(recordRawId);
    } catch {
      recordId = recordRawId;
    }
  }
  const recordGroup = recordMode ? (feederGroups || []).find((g) => g.id === recordId) : null;
  // Originating list order handed through route state; absent on direct links.
  const recordSeq = location.state?.recordSeq || null;
  // Visible hub order: active batches first, then processed at the bottom
  // (stable within each group, so persisted order is preserved inside the
  // active block and inside the processed block). Processed rows are hidden
  // entirely when the Show/Hide toggle is off. One unified row stack (no status
  // swimlanes); this same array is the record-sequence + CSV/print order.
  const visiblePigBatches = (feederGroups || [])
    .filter((g) => showArchBatches || g.status !== 'processed')
    .slice()
    .sort((a, b) => (a.status === 'processed' ? 1 : 0) - (b.status === 'processed' ? 1 : 0));
  const goToBatch = (id, rows) =>
    navigate(
      '/pig/batches/' + encodeURIComponent(id),
      rows ? recordSeqNavOptions(labeledSeqItems(rows, 'batchName')) : undefined,
    );
  const navigateSeq = (id) => navigate('/pig/batches/' + encodeURIComponent(id), recordSeqNavOptions(recordSeq));
  const goToHub = () => navigate('/pig/batches');

  const statusColors = {active: {bg: '#085041', tx: 'white'}, processed: {bg: '#4b5563', tx: 'white'}};
  const cycleSeqMap = buildCycleSeqMap(breedingCycles);
  function latestDailyPigCountForBatch(group) {
    if (!group || (group.subBatches || []).length > 0) return null;
    const rows = dailysForName(group.batchName);
    const sorted = [...rows].sort(
      (a, b) =>
        (b.date || '').localeCompare(a.date || '') || (b.submitted_at || '').localeCompare(a.submitted_at || '') || 0,
    );
    return sorted[0]?.pig_count ?? null;
  }

  function adjustedFeedForBatch(group) {
    if (!group) return 0;
    const subs = group.subBatches || [];
    let rawFeed = parseFloat(group.legacyFeedLbs) || parseFloat(group.totalFeedLbs) || 0;
    if (subs.length > 0) {
      for (const sub of subs) {
        rawFeed += parseFloat(sub.legacyFeedLbs) || 0;
        for (const row of dailysForName(sub.name)) rawFeed += parseFloat(row.feed_lbs) || 0;
      }
    } else {
      for (const row of dailysForName(group.batchName)) rawFeed += parseFloat(row.feed_lbs) || 0;
    }
    const transfers = pigTransfersForBatch(breeders, group.batchName);
    const transferCredit =
      transfers.feedAllocLbs > 0 ? transfers.feedAllocLbs : parseFloat(group.feedAllocatedToTransfers) || 0;
    return Math.max(0, rawFeed - transferCredit);
  }

  const pigBatchExportRows = visiblePigBatches.map((group) => {
    const tripOptions = {tripSourceSummary: processingTrips.tripSourceSummary};
    const transfers = pigTransfersForBatch(breeders, group.batchName);
    const cycle = (breedingCycles || []).find((c) => c && c.id === group.cycleId);
    const current = computeBatchCurrentCount(group, breeders, {
      latestDailyPigCount: latestDailyPigCountForBatch(group),
      tripSourceSummary: processingTrips.tripSourceSummary,
    });
    return {
      ...group,
      started_count: batchStartedCount(group),
      current_count: current,
      trip_pigs: (group.processingTrips || []).reduce(
        (sum, trip) => sum + processingTripPigCount(trip, tripOptions),
        0,
      ),
      transfer_pigs: transfers.count,
      mortality_count: pigMortalityForBatch(group),
      total_live_lbs: (group.processingTrips || []).reduce((sum, trip) => sum + tripTotalLive(trip, tripOptions), 0),
      adjusted_feed_lbs: adjustedFeedForBatch(group),
      fcr: computePigBatchFCR(group, dailysForName, breeders, tripOptions),
      cycle_label: cycle ? cycleLabel(cycle, cycleSeqMap) : '',
    };
  });
  const exportColumns = buildPigBatchExportColumns({fmt: fmtS});

  function handleExportCsv() {
    if (!pigBatchExportRows.length) {
      setNotice({kind: 'warning', message: 'No visible pig batches to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('pig-batches'), rowsToCsv(exportColumns, pigBatchExportRows));
    if (!ok) setNotice({kind: 'warning', message: 'CSV export is unavailable in this browser.'});
  }

  function handlePrintRows() {
    if (!pigBatchExportRows.length) {
      setNotice({kind: 'warning', message: 'No visible pig batches to print.'});
      return;
    }
    const ok = printRows({
      title: 'Pig Batches',
      subtitle: pigBatchExportRows.length + ' visible batches',
      columns: exportColumns,
      rows: pigBatchExportRows,
    });
    if (!ok) setNotice({kind: 'warning', message: 'Print export is unavailable in this browser.'});
  }
  // Processing-trip source tracking + handlers live in usePigProcessingTrips
  // (CP10); tripSourceCounts is consumed by the trip JSX via the hook.

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
  // Planned-trip state + lock sidecar live in usePigPlannedTrips (CP9).
  React.useEffect(() => {
    sb.from('app_store')
      .select('data')
      .eq('key', 'ppp-pig-global-adg-v1')
      .maybeSingle()
      .then(({data, error}) => {
        if (error) {
          setGlobalAdgRow({manualValue: null, updatedAt: null, updatedBy: null});
          setNotice({kind: 'warning', message: 'Global ADG override could not be loaded: ' + error.message});
          return;
        }
        if (data && data.data && typeof data.data === 'object') {
          setGlobalAdgRow(data.data);
        } else {
          setGlobalAdgRow({manualValue: null, updatedAt: null, updatedBy: null});
        }
      })
      .catch((e) => {
        setGlobalAdgRow({manualValue: null, updatedAt: null, updatedBy: null});
        setNotice({kind: 'warning', message: 'Global ADG override could not be loaded: ' + (e?.message || e)});
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
      try {
        const {data: sessions, error: sessionsError} = await sb
          .from('weigh_in_sessions')
          .select('id, batch_id, date, status, started_at')
          .eq('species', 'pig')
          .order('date', {ascending: false});
        if (sessionsError) throw new Error('weigh_in_sessions: ' + sessionsError.message);
        if (cancelled) return;
        setPigSessionsForForecast(sessions || []);
        const ids = (sessions || []).map((s) => s.id);
        if (ids.length === 0) {
          setPigEntriesForForecast([]);
          return;
        }
        const {data: ents, error: entriesError} = await sb
          .from('weigh_ins')
          .select('session_id, weight')
          .in('session_id', ids);
        if (entriesError) throw new Error('weigh_ins: ' + entriesError.message);
        if (cancelled) return;
        setPigEntriesForForecast(ents || []);
      } catch (e) {
        if (cancelled) return;
        setPigSessionsForForecast([]);
        setPigEntriesForForecast([]);
        setNotice({kind: 'warning', message: 'Pig forecast weigh-ins could not be loaded: ' + (e?.message || e)});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  // Planned-trip lock helpers + add/move/delete/date handlers live in
  // usePigPlannedTrips (CP9). The planned-trip JSX consumes them via the hook.

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
      const cycleAgeDaysAtRef = {minDays: ageRange.minDays, maxDays: ageRange.maxDays};
      const ageDistributionAtRef = buildFarrowingAgeDistribution({
        cycleId: g.cycleId,
        asOfDate: today,
        breedingCycles,
        farrowingRecs,
        cycleAgeDaysAtRef,
      });
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
        const tripPigs = pigTripPigsForSub(g.processingTrips || [], sub.id, {
          tripSourceSummary: processingTrips.tripSourceSummary,
          subName: sub.name,
        });
        const mortality = pigMortalityForSub(g, sub.name);
        const started = giltCount + boarCount;
        const remaining = Math.max(0, started - tripPigs - transfers.count - mortality);
        if (remaining <= 0) continue;
        // Forecasted ready start date. Ronnie preference: planned trip dates
        // are based only on DOB/farrowing age at trip date times Global ADG.
        // First weigh-ins do not move planned dates.
        const adg = effectiveAdgLbsPerDay;
        if (adg == null) continue;
        const forecastPopulationCount = Math.max(0, started - transfers.count - mortality);
        const nextWindow = projectFarrowingAgeWindow(ageDistributionAtRef, {
          populationCount: forecastPopulationCount,
          rankOffset: tripPigs,
          windowCount: 1,
        });
        const anchorAgeDays = nextWindow ? nextWindow.maxDays : ageRange.maxDays;
        const anchorWeight = anchorAgeDays * adg;
        const anchorDate = today;
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
  }, [feederGroups, breedingCycles, farrowingRecs, breeders, effectiveAdgLbsPerDay]);

  // ── Pig mortality entries (parent batch with sub-batch attribution) ─────
  // Stored as feederGroup.pigMortalities = [{id, date, sub_batch_id,
  // sub_batch_name, count, comment, team_member, created_at}]. Pure audit
  // log — current pig count keeps coming from dailys; mortality just
  // surfaces the death history with attribution. State + handlers live in
  // usePigMortality (CP7); the modal + mortality-log JSX render in PigBatchPage.
  const mortality = usePigMortality({feederGroups, setFeederGroups, setNotice, authState});

  // Match pig_dailys to a name (case-insensitive) — used for both batch and sub-batch matching
  function dailysForName(name) {
    if (!name) return [];
    const n = String(name).trim().toLowerCase();
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

  function batchHubTileInfo(g, started) {
    const subs = g.subBatches || [];
    const parentLegacy = parseFloat(g.legacyFeedLbs) || parseFloat(g.totalFeedLbs) || 0;
    if (subs.length > 0) {
      const subSummaries = subs.map((sb) => {
        const rows = dailysForName(sb.name);
        const rawFeedLbs =
          rows.reduce((sum, d) => sum + (parseFloat(d.feed_lbs) || 0), 0) + (parseFloat(sb.legacyFeedLbs) || 0);
        const transfers = pigTransfersForSub(breeders, g.batchName, sb.name);
        const adjustedFeedLbs = Math.max(0, rawFeedLbs - transfers.feedAllocLbs);
        const subStarted = (parseInt(sb.giltCount) || 0) + (parseInt(sb.boarCount) || 0);
        return {
          id: sb.id,
          name: sb.name,
          status: sb.status,
          started: subStarted,
          current: computeSubCurrentCount(g, sb, breeders, {tripSourceSummary: processingTrips.tripSourceSummary}),
          feedPerStarted: subStarted > 0 && adjustedFeedLbs > 0 ? adjustedFeedLbs / subStarted : null,
          adjustedFeedLbs,
        };
      });
      const startedDenominator = started > 0 ? started : subSummaries.reduce((sum, s) => sum + s.started, 0);
      const feedTotalLbs = parentLegacy + subSummaries.reduce((sum, s) => sum + s.adjustedFeedLbs, 0);
      return {
        subSummaries,
        feedPerStarted: startedDenominator > 0 && feedTotalLbs > 0 ? feedTotalLbs / startedDenominator : null,
      };
    }

    const feedRows = dailysForName(g.batchName);
    const rawFeedLbs = feedRows.reduce((sum, d) => sum + (parseFloat(d.feed_lbs) || 0), 0) + parentLegacy;
    const transferCredit =
      pigTransfersForBatch(breeders, g.batchName).feedAllocLbs || parseFloat(g.feedAllocatedToTransfers) || 0;
    const adjustedFeedLbs = Math.max(0, rawFeedLbs - transferCredit);
    return {
      subSummaries: [],
      feedPerStarted: started > 0 && adjustedFeedLbs > 0 ? adjustedFeedLbs / started : null,
    };
  }

  function renderPigBatchTile(g, rowsForSequence) {
    const sc = statusColors[g.status] || statusColors.active;
    const subs = g.subBatches || [];
    const latestDailyPigCount =
      subs.length > 0
        ? null
        : (() => {
            // Same ordering as the record workspace (date desc, then
            // submitted_at desc) so the hub tile and record page can't
            // disagree on "Current" when a parent-only batch has multiple
            // reports on the same date.
            const rows = dailysForName(g.batchName);
            const sorted = [...rows].sort(
              (a, b) =>
                (b.date || '').localeCompare(a.date || '') ||
                (b.submitted_at || '').localeCompare(a.submitted_at || '') ||
                0,
            );
            return sorted[0]?.pig_count ?? null;
          })();
    const current = computeBatchCurrentCount(g, breeders, {
      latestDailyPigCount,
      tripSourceSummary: processingTrips.tripSourceSummary,
    });
    const started = batchStartedCount(g);
    const tileInfo = batchHubTileInfo(g, started);
    return (
      <PigBatchHubTile
        key={g.id}
        group={g}
        current={current}
        started={started}
        feedPerStarted={tileInfo.feedPerStarted}
        subSummaries={tileInfo.subSummaries}
        statusColor={sc}
        onOpen={() => goToBatch(g.id, rowsForSequence)}
      />
    );
  }

  // Best-effort pig.batch status.changed Activity (entity_id = group.id).
  // Never blocks the archive/unarchive mutation (try/catch + swallowed reject).
  function recordBatchStatusChange(group, from, to, subCascadeCount) {
    if (!group) return;
    try {
      recordActivityEvent(sb, {
        entityType: 'pig.batch',
        entityId: group.id,
        eventType: 'status.changed',
        entityLabel: group.batchName || group.id,
        body:
          'Batch ' +
          (group.batchName || group.id) +
          ' status changed from ' +
          from +
          ' to ' +
          to +
          (subCascadeCount
            ? ' (' + subCascadeCount + ' sub-batch' + (subCascadeCount === 1 ? '' : 'es') + ' cascaded)'
            : ''),
        payload: {
          changes: [{field: 'status', label: 'Status', from, to, old_present: true, new_present: true}],
          subCascadeCount: subCascadeCount || 0,
        },
      }).catch(() => {});
    } catch (_e) {
      /* best-effort — never block the status change */
    }
  }
  function archiveBatch(batchId) {
    window._wcfConfirm(
      'Mark this batch as processed? It will be hidden from the webform.',
      () => {
        const target = feederGroups.find((g) => g.id === batchId) || null;
        const subCascadeCount = target ? (target.subBatches || []).filter((s) => s.status !== 'processed').length : 0;
        const nb = feederGroups.map((g) =>
          g.id === batchId
            ? {...g, status: 'processed', subBatches: (g.subBatches || []).map((s) => ({...s, status: 'processed'}))}
            : g,
        );
        persistFeeders(nb);
        recordBatchStatusChange(target, 'active', 'processed', subCascadeCount);
      },
      'Mark Processed',
    );
  }
  function unarchiveBatch(batchId) {
    const target = feederGroups.find((g) => g.id === batchId) || null;
    const nb = feederGroups.map((g) => (g.id === batchId ? {...g, status: 'active'} : g));
    persistFeeders(nb);
    recordBatchStatusChange(target, 'processed', 'active', 0);
  }
  // Sub-batch CRUD (archive/unarchive/persist/validate/upd/close/save/delete)
  // lives in usePigSubBatches (CP8); the form JSX below consumes the handlers.

  // Thin closure over the lib helper that supplies the React-context-bound
  // breedingCycles + farrowingRecs arrays. Keeping the wrapper preserves the
  // existing call-site signature (cycleId, asOfDate?) without ripple changes.
  function calcAgeRange(cycleId, asOfDate) {
    return libCalcAgeRange(cycleId, asOfDate, breedingCycles, farrowingRecs);
  }

  // Trip yield helpers (parseLiveWeights / tripTotalLive / tripYield) now live
  // in lib/pig.js as pure helpers, shared with computePigBatchFCR.

  // Processing-trip handlers (persistTrip/updTrip/closeTripForm/deleteTrip) live
  // in usePigProcessingTrips (CP10); the trip form + list JSX consume them.

  // updSubPartition (the in-modal partition-count editor) also lives in
  // usePigSubBatches (CP8); it shares partitionDirtyRef with closeFeederForm.

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

  // isManager (admin/management mutation gate) is computed once near the top,
  // alongside the usePigPlannedTrips hook that consumes it.

  // CP11: the record-page workspace (card + mortality modal + collaboration)
  // renders in PigBatchPage. PigBatchesView owns the hooks + view-level
  // derivations and threads them down as one bundle so the moved JSX is
  // byte-identical. The hub (ADG / Add Batch / archived toggle / tiles), the
  // shared feeder-form modal, and the back/loading/not-found states stay here.
  const pigBatchPageView = {
    persistFeeders,
    confirmDelete,
    pigAutoSaveTimer,
    subAutoSaveTimer,
    tripAutoSaveTimer,
    isManager,
    notice,
    setNotice,
    effectiveAdgLbsPerDay,
    systemAdgEstimate,
    dailysForName,
    archiveBatch,
    unarchiveBatch,
    ...mortality,
    ...subBatches,
    ...plannedTrips,
    ...processingTrips,
  };
  return (
    <div data-pig-feeders-loaded={feedersLoaded ? 'true' : 'false'}>
      {!recordMode && <Header />}
      <div style={{padding: '0 12px'}}>
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      </div>
      {/* Global ADG (commit 4a). Manual override + live system estimate.
        Manager-and-above (admin role for v1) can edit; operators read-only.
        Persists to app_store ppp-pig-global-adg-v1. No reset button per
        Codex; admin types a new value to change. Hub-only — farm-wide, not per
        batch, so it does not render on a single-batch record page. */}
      {!recordMode && (
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
            <span style={{fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600}}>
              Global ADG
            </span>
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
                  setAdgInput(
                    effectiveAdgLbsPerDay != null ? String(Math.round(effectiveAdgLbsPerDay * 100) / 100) : '',
                  );
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
      )}
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
        {!recordMode && (
          <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 12}}>
            <div style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end'}}>
              <button
                type="button"
                onClick={handleExportCsv}
                data-pig-batches-export-csv="1"
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                Export CSV
              </button>
              <button
                type="button"
                onClick={handlePrintRows}
                data-pig-batches-print="1"
                style={{
                  padding: '7px 12px',
                  borderRadius: 8,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
              >
                Print
              </button>
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
                + Add Manual Batch
              </button>
            </div>
          </div>
        )}

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
                  {/* Farm-born batches are created from the first farrowing record
                      (FarrowingView), not here. Add Manual Batch offers no cycle
                      selector; in Edit mode the linked cycle is read-only/fixed. */}
                  {editFeederId && feederForm.cycleId && (
                    <div>
                      <label style={S.label}>Linked breeding cycle (fixed)</label>
                      <select
                        value={feederForm.cycleId}
                        onChange={(e) => updFeeder('cycleId', e.target.value)}
                        data-feeder-cycle-select
                        disabled
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
                    </div>
                  )}
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
                          // Snapshot the batch root (with its sub/trip/mortality
                          // counts) BEFORE the filter, for the best-effort
                          // record.deleted Activity payload.
                          const removed = feederGroups.find((g) => g.id === editFeederId) || null;
                          const nb = feederGroups.filter((g) => g.id !== editFeederId);
                          setFeederGroups(nb);
                          persistFeeders(nb);
                          setShowFeederForm(false);
                          setEditFeederId(null);
                          setOriginalFeederForm(null);
                          // Best-effort pig.batch Activity (entity_id = group.id):
                          // batch root deleted. Never blocks the mutation.
                          try {
                            const subCount = removed ? (removed.subBatches || []).length : 0;
                            const tripCount = removed ? (removed.processingTrips || []).length : 0;
                            const mortalityCount = removed
                              ? (removed.pigMortalities || []).reduce((a, m) => a + (parseInt(m.count) || 0), 0)
                              : 0;
                            recordActivityEvent(sb, {
                              entityType: 'pig.batch',
                              entityId: removed ? removed.id : editFeederId,
                              eventType: 'record.deleted',
                              entityLabel: (removed && removed.batchName) || editFeederId,
                              body:
                                'Deleted batch ' +
                                ((removed && removed.batchName) || editFeederId) +
                                ' (' +
                                subCount +
                                ' sub-batch' +
                                (subCount === 1 ? '' : 'es') +
                                ', ' +
                                tripCount +
                                ' trip' +
                                (tripCount === 1 ? '' : 's') +
                                ', ' +
                                mortalityCount +
                                ' mortality)',
                              payload: {
                                record: 'pig.batch',
                                batchName: (removed && removed.batchName) || null,
                                subBatchCount: subCount,
                                processingTripCount: tripCount,
                                mortalityCount,
                              },
                            }).catch(() => {});
                          } catch (_e) {
                            /* best-effort — never block the delete */
                          }
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

        {!recordMode && (feederGroups || []).length === 0 && !showFeederForm && (
          <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af', fontSize: 13}}>
            No pig batches yet — farm-born batches appear here once you record the cycle's first farrowing; use "+ Add
            Manual Batch" for manual/admin batches.
          </div>
        )}

        {/* Record-page loading: pig feeders haven't finished loading yet.
            Keyed on the real readiness signal (feedersLoaded) — NOT
            feederGroups.length, which can't tell "still loading" from "loaded
            and genuinely empty" and races record-page tests on cold start.
            Showing the not-found state during this window would flash
            "Batch not found" on a valid deep-link before data loads. */}
        {recordMode && !recordGroup && !feedersLoaded && (
          <RecordPageLoading Header={Header} label="Loading pig batch…" />
        )}

        {/* Record-page not-found: data loaded, but the URL id is genuinely
            absent from the feeder groups. */}
        {recordMode && !recordGroup && feedersLoaded && (
          <RecordPageNotFound
            Header={Header}
            backLabel="Back to Pig Batches"
            onBack={goToHub}
            message="Batch not found."
          />
        )}

        {/* Hub: one unified vertical inspection grid — one row per visible
            batch, active and processed in the same row stack (the Show/Hide
            processed toggle controls whether processed rows are included).
            Consistent columns let every batch's key metrics be compared at a
            glance; clicking a row opens that batch's record-page workspace.
            The header row and each batch row share PIG_BATCH_GRID_COLUMNS so
            the columns stay aligned. Horizontal scroll on narrow screens keeps
            the table readable without collapsing the column alignment. */}
        {!recordMode && visiblePigBatches.length > 0 && (
          <div style={{overflowX: 'auto', border: '1px solid #e5e7eb', borderRadius: 10, background: 'white'}}>
            <div data-pig-batch-grid="1" style={{minWidth: 720}}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: PIG_BATCH_GRID_COLUMNS,
                  gap: 10,
                  alignItems: 'center',
                  padding: '8px 14px',
                  borderBottom: '1px solid #e5e7eb',
                  background: '#f9fafb',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                }}
              >
                {['Batch', 'Status', 'Started', 'Current', 'Feed/started', 'Sub-batches · Gilts/Boars', ''].map(
                  (h, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {h}
                    </span>
                  ),
                )}
              </div>
              {visiblePigBatches.map((g) => renderPigBatchTile(g, visiblePigBatches))}
            </div>
          </div>
        )}

        {/* Record page: the selected batch's full workspace (one group). The
            card body below is unchanged from the legacy inline render; only its
            source is narrowed to the routed group (processed batches still open
            via direct link). */}
        {recordMode && recordGroup && (
          <PigBatchPage
            Header={Header}
            group={recordGroup}
            view={pigBatchPageView}
            recordSeq={recordSeq}
            recordId={recordId}
            onNavigateSeq={navigateSeq}
            onBack={goToHub}
          />
        )}
      </div>
    </div>
  );
}
