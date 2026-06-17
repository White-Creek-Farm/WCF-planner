import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
import {buildForecast} from '../lib/cattleForecast.js';
import {loadForecastSettings, loadHeiferIncludes, loadHidden} from '../lib/cattleForecastApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildProcessingBatchExportColumns} from '../lib/operationalExportColumns.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {
  CATTLE_BATCH_STATUS_KEYS,
  CATTLE_BATCH_SORT_KEYS,
  buildCattleBatchPredicate,
  buildCattleBatchComparator,
} from '../lib/cattleBatchFilters.js';
import CattleBatchPage from './CattleBatchPage.jsx';

const CATTLE_BATCHES_SURFACE_KEY = 'cattle.batches';
const EXTENDED_LIST_CONTROLS_ENABLED = false;

const CATTLE_BATCH_STATUS_LABELS = {scheduled: 'Scheduled', active: 'Active', complete: 'Processed'};
const CATTLE_BATCH_SORT_LABELS = {
  batchName: 'Batch name',
  status: 'Status',
  plannedDate: 'Process date',
  animalCount: 'Cow count',
  yieldPct: 'Yield %',
};

const CattleBatchesHub = ({
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
}) => {
  const navigate = useNavigate();
  const {useState, useEffect, useMemo} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batches, setBatches] = useState([]);
  const [cattle, setCattle] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calvingRecs, setCalvingRecs] = useState([]);
  const [forecastSettings, setForecastSettings] = useState(null);
  const [heiferIncludes, setHeiferIncludes] = useState(new Set());
  const [hidden, setHidden] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [showPlanned, setShowPlanned] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [scheduleDateDraft, setScheduleDateDraft] = useState({});
  const [notice, setNotice] = useState(null);

  // ── Operational-list toolbar state (search / status / range filters + a
  // single active sort rule). Persisted per-surface so a refresh keeps the
  // operator's working set. Saved views layer on top via savedViewsApi. ──
  const [filters, setFilters] = usePersistentViewState('cattle.batches.filters', {});
  const [sortRule, setSortRule] = usePersistentViewState('cattle.batches.sortRule', {key: 'plannedDate', dir: 'desc'});
  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);
  const myProfileId = (authState && authState.user && authState.user.id) || null;

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [bR, cR, wAll, calR] = await Promise.all([
        sb.from('cattle_processing_batches').select('*').order('actual_process_date', {ascending: false}),
        sb.from('cattle').select('*').is('deleted_at', null),
        loadCattleWeighInsCached(sb),
        sb.from('cattle_calving_records').select('*'),
      ]);
      if (bR.error) throw new Error('cattle_processing_batches: ' + (bR.error.message || bR.error));
      if (cR.error) throw new Error('cattle: ' + (cR.error.message || cR.error));
      if (calR.error) throw new Error('cattle_calving_records: ' + (calR.error.message || calR.error));

      const forecastSidecarErrors = [];
      const [settings, inc, hid] = await Promise.all([
        loadForecastSettings(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return null;
        }),
        loadHeiferIncludes(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return new Set();
        }),
        loadHidden(sb).catch((e) => {
          forecastSidecarErrors.push(e);
          return [];
        }),
      ]);

      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches((bR.data || []).slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
      setCattle(cR.data || []);
      setWeighIns(wAll || []);
      setCalvingRecs(calR.data || []);
      setForecastSettings(settings);
      setHeiferIncludes(inc);
      setHidden(hid);
      if (forecastSidecarErrors.length > 0) {
        setNotice(
          (prev) =>
            prev || {
              kind: 'warning',
              message: 'Forecast data could not fully load. Planned batches may be unavailable until refresh.',
            },
        );
      }
    } catch (e) {
      setBatches([]);
      setCattle([]);
      setWeighIns([]);
      setCalvingRecs([]);
      setForecastSettings(null);
      setHeiferIncludes(new Set());
      setHidden([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load cattle processing batches. Please refresh the page. (' + (e.message || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, CATTLE_BATCHES_SURFACE_KEY);
      setSavedViews(rows);
      setSavedViewsError(null);
      setSelectedViewId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : ''));
    } catch (e) {
      setSavedViews([]);
      setSavedViewsError(e.message || String(e));
    } finally {
      setSavedViewsLoading(false);
    }
  }
  useEffect(() => {
    loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forecast = useMemo(() => {
    if (!forecastSettings) return null;
    const realBatchesOnly = batches.filter((b) => b.status === 'active' || b.status === 'complete');
    const scheduledBatchesOnly = batches.filter((b) => b.status === 'scheduled');
    return buildForecast({
      cattle,
      weighIns,
      settings: forecastSettings,
      includes: heiferIncludes,
      hidden,
      realBatches: realBatchesOnly,
      scheduledBatches: scheduledBatchesOnly,
      todayMs: Date.now(),
    });
  }, [cattle, weighIns, forecastSettings, heiferIncludes, hidden, batches]);

  const virtualPlanned = useMemo(() => {
    if (!forecast) return [];
    const nowYm = new Date().toISOString().slice(0, 7);
    const limitMs = Date.now() + 365 * 86400000;
    const limitYm = new Date(limitMs).toISOString().slice(0, 7);
    return forecast.virtualBatches.filter((vb) => vb.monthKey >= nowYm && vb.monthKey <= limitYm);
  }, [forecast]);

  const scheduledList = useMemo(() => {
    if (!forecast) return [];
    return forecast.scheduledBatches
      .slice()
      .sort((a, b) => (a.planned_process_date || '').localeCompare(b.planned_process_date || ''));
  }, [forecast]);

  async function scheduleVirtualBatch(vb) {
    if (!canEdit) return;
    setNotice(null);
    const date = (scheduleDateDraft[vb.name] || '').trim();
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setNotice({kind: 'error', message: 'Pick a processor date (YYYY-MM-DD) before scheduling.'});
      return;
    }
    const rowId = 'cpb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const row = {
      id: rowId,
      name: vb.name,
      planned_process_date: date,
      status: 'scheduled',
      cows_detail: [],
      documents: [],
    };
    const r = await sb.from('cattle_processing_batches').insert(row).select().single();
    if (r.error) {
      setNotice({kind: 'error', message: 'Schedule failed: ' + r.error.message});
      return;
    }
    navigate('/cattle/batches/' + rowId);
  }

  const active = batches.filter((b) => b.status === 'active');
  const completed = batches.filter((b) => b.status === 'complete');

  // Enrich a pipeline batch into the export/filter shape the rest of the view
  // (and the shared processing-batch export columns) read. Scheduled rows are
  // forecast-backed (animalIds, no cows_detail); active/processed rows carry a
  // cows_detail array. animal_count + yield_pct are the fields the toolbar
  // filters/sorts on, so deriving them here keeps filter + sort + CSV/print on
  // one shape.
  function enrichBatch(batch) {
    const detailRows = Array.isArray(batch.cows_detail) ? batch.cows_detail : [];
    const totalLiveWeight = detailRows.reduce((sum, row) => sum + (parseFloat(row.live_weight) || 0), 0);
    const totalHangingWeight = detailRows.reduce((sum, row) => sum + (parseFloat(row.hanging_weight) || 0), 0);
    return {
      ...batch,
      // Operational exports + the count filter/sort count ATTACHED detail rows
      // only (Lane K contract, parity with sheep). Scheduled/forecast batches
      // still display "N cows forecast" separately via batch.animalIds.
      animal_count: detailRows.length,
      total_live_weight: totalLiveWeight,
      total_hanging_weight: totalHangingWeight,
      yield_pct: totalLiveWeight > 0 && totalHangingWeight > 0 ? (totalHangingWeight / totalLiveWeight) * 100 : null,
    };
  }

  // One predicate + comparator drive filtering/sorting across every pipeline
  // section (scheduled / active / processed). Filtering runs on the enriched
  // shape; we keep each section's ORIGINAL rows aligned so render + nav still
  // pass the real batch objects through. Single active sort rule (right-sized).
  const effectiveFilters = EXTENDED_LIST_CONTROLS_ENABLED ? filters : {};
  const effectiveSortRule = EXTENDED_LIST_CONTROLS_ENABLED ? sortRule : {key: 'plannedDate', dir: 'desc'};
  const batchPredicate = buildCattleBatchPredicate(effectiveFilters);
  const batchComparator = buildCattleBatchComparator(effectiveSortRule);
  function applyToolbar(rows) {
    return rows
      .map((b) => ({raw: b, enriched: enrichBatch(b)}))
      .filter((pair) => batchPredicate(pair.enriched))
      .sort((a, b) => batchComparator(a.enriched, b.enriched));
  }
  const scheduledPairs = applyToolbar(scheduledList);
  const activePairs = applyToolbar(active);
  const completedPairs = applyToolbar(completed);
  const scheduledVisible = scheduledPairs.map((p) => p.raw);
  const activeVisible = activePairs.map((p) => p.raw);
  const completedVisible = completedPairs.map((p) => p.raw);

  // Visible/rendered order for record sequence nav (scheduled → active → then
  // processed ONLY when the Show Processed Batches section is expanded).
  // Virtual/planned forecast tiles are excluded — they don't route. This is the
  // filtered + sorted set, so nav stepping matches what the operator sees.
  const batchSeqRows = [...scheduledVisible, ...activeVisible, ...(showCompleted ? completedVisible : [])];
  // CSV/print is fed the SAME filtered + sorted set (enriched), never the raw
  // batches list.
  const batchExportRows = [...scheduledPairs, ...activePairs, ...(showCompleted ? completedPairs : [])].map(
    (p) => p.enriched,
  );

  // Routable total (pre-filter) vs visible (post-filter) for the "N of M"
  // count + the filtered-no-results empty state. Completed only counts toward
  // the total when its section is expanded (same rule as the rendered set).
  const routableTotal = scheduledList.length + active.length + (showCompleted ? completed.length : 0);
  const visibleTotal = batchSeqRows.length;
  const filtersActive = Object.keys(effectiveFilters || {}).length > 0;

  const exportColumns = buildProcessingBatchExportColumns({fmt, animalLabel: 'Cow'});

  function handleExportCsv() {
    if (!batchExportRows.length) {
      setNotice({kind: 'warning', message: 'No visible cattle processing batches to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('cattle-processing-batches'), rowsToCsv(exportColumns, batchExportRows));
    if (!ok) setNotice({kind: 'warning', message: 'CSV export is unavailable in this browser.'});
  }

  function handlePrintRows() {
    if (!batchExportRows.length) {
      setNotice({kind: 'warning', message: 'No visible cattle processing batches to print.'});
      return;
    }
    const ok = printRows({
      title: 'Cattle Processing Batches',
      subtitle: batchExportRows.length + ' visible batches',
      columns: exportColumns,
      rows: batchExportRows,
    });
    if (!ok) setNotice({kind: 'warning', message: 'Print export is unavailable in this browser.'});
  }

  // ── Toolbar helpers (filter mutation + saved-view CRUD) ──────────────────
  function setFilter(key, value) {
    setFilters((prev) => {
      const next = {...prev};
      if (
        value == null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
      ) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
    setSelectedViewId('');
  }
  function setRangeBound(key, bound, raw) {
    setFilters((prev) => {
      const cur = prev[key] && typeof prev[key] === 'object' ? {...prev[key]} : {};
      if (raw === '' || raw == null) {
        delete cur[bound];
      } else {
        const num = parseInt(raw, 10);
        if (!Number.isFinite(num)) delete cur[bound];
        else cur[bound] = num;
      }
      const next = {...prev};
      if (Object.keys(cur).length === 0) delete next[key];
      else next[key] = cur;
      return next;
    });
    setSelectedViewId('');
  }
  function setDateBound(key, bound, raw) {
    setFilters((prev) => {
      const cur = prev[key] && typeof prev[key] === 'object' ? {...prev[key]} : {};
      if (raw === '' || raw == null) delete cur[bound];
      else cur[bound] = raw;
      const next = {...prev};
      if (Object.keys(cur).length === 0) delete next[key];
      else next[key] = cur;
      return next;
    });
    setSelectedViewId('');
  }
  function toggleStatus(value) {
    setFilters((prev) => {
      const curList = Array.isArray(prev.status) ? prev.status : [];
      const nextList = curList.includes(value) ? curList.filter((x) => x !== value) : [...curList, value];
      const next = {...prev};
      if (nextList.length === 0) delete next.status;
      else next.status = nextList;
      return next;
    });
    setSelectedViewId('');
  }
  function clearAllFilters() {
    setFilters({});
    setSelectedViewId('');
  }
  function setSortKey(key) {
    setSortRule((prev) => ({key, dir: (prev && prev.dir) || 'asc'}));
    setSelectedViewId('');
  }
  function flipSortDir() {
    setSortRule((prev) => ({
      key: (prev && prev.key) || 'plannedDate',
      dir: prev && prev.dir === 'asc' ? 'desc' : 'asc',
    }));
    setSelectedViewId('');
  }

  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );

  function cattleBatchesViewState() {
    return buildViewState({filters, sortRules: [sortRule], viewMode: 'grouped'});
  }
  function applySavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    const rules = Array.isArray(st.sortRules) ? st.sortRules : [];
    setSortRule(rules[0] && rules[0].key ? rules[0] : {key: 'plannedDate', dir: 'desc'});
  }
  function onSelectSavedView(id) {
    setSelectedViewId(id);
    if (!id) return;
    applySavedView(savedViews.find((v) => v.id === id));
  }
  function openSaveViewForm() {
    setSaveViewName('');
    setSaveViewVisibility('private');
    setShowSaveViewForm(true);
  }
  async function submitSaveView() {
    const name = saveViewName.trim();
    if (!name) {
      setNotice({kind: 'error', message: 'Name the view before saving.'});
      return;
    }
    setSavedViewBusy(true);
    try {
      const created = await createSavedView(sb, {
        surfaceKey: CATTLE_BATCHES_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: cattleBatchesViewState(),
      });
      setShowSaveViewForm(false);
      await loadSavedViews();
      if (created && created.id) setSelectedViewId(created.id);
    } catch (e) {
      setNotice({kind: 'error', message: 'Save view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  async function updateSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    setSavedViewBusy(true);
    try {
      await updateSavedView(sb, selectedView.id, {viewState: cattleBatchesViewState()});
      await loadSavedViews();
      setNotice({kind: 'success', message: 'Updated "' + selectedView.name + '" to the current filters/sort.'});
    } catch (e) {
      setNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  async function proceedDeleteSelectedView(view) {
    setSavedViewBusy(true);
    try {
      await deleteSavedView(sb, view.id);
      setSelectedViewId('');
      await loadSavedViews();
      setNotice({kind: 'success', message: 'Deleted saved view "' + view.name + '".'});
    } catch (e) {
      setNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  function deleteSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    const view = selectedView;
    const run = () => {
      void proceedDeleteSelectedView(view);
    };
    if (window._wcfConfirmDelete) {
      window._wcfConfirmDelete('Delete saved view "' + view.name + '"?', run);
    } else {
      run();
    }
  }

  const toolbarInputS = {
    fontSize: 12,
    padding: '6px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };
  const savedViewGhostBtnS = {
    padding: '6px 12px',
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
    background: 'white',
    color: 'var(--ink)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid var(--brand)', color: 'var(--brand)'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };

  return (
    <div
      style={{minHeight: '100vh', background: 'var(--bg-page)'}}
      data-cattle-batches-loaded={loading || loadError ? 'false' : 'true'}
    >
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
        <InlineNotice notice={loadError} />
        {loadError && (
          <button
            type="button"
            onClick={loadAll}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--brand)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
            }}
          >
            Retry
          </button>
        )}
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
          <div style={{fontSize: 16, fontWeight: 700, color: 'var(--ink)'}} data-cattle-batches-root>
            Processing Batches{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: 'var(--ink-muted)'}}>
              {scheduledList.length} scheduled · {active.length} active · {completed.length} processed
            </span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
            {EXTENDED_LIST_CONTROLS_ENABLED && (
              <>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  data-cattle-batches-export-csv="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handlePrintRows}
                  data-cattle-batches-print="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Print
                </button>
              </>
            )}
            {!canEdit && (
              <span
                style={{
                  fontSize: 11,
                  padding: '3px 8px',
                  background: '#eff6ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: 999,
                  color: '#1e40af',
                  fontWeight: 600,
                }}
              >
                READ-ONLY
              </span>
            )}
          </div>
        </div>

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: 'var(--ink-faint)'}}>Loading{'…'}</div>}

        {/* Saved views row — degrades to a small notice if it can't load,
            never blocking the list/filters below. */}
        {EXTENDED_LIST_CONTROLS_ENABLED && !loading && !loadError && (
          <div
            data-cattle-batches-saved-views-row
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Saved views</span>
            {savedViewsError ? (
              <span style={{fontSize: 12, color: '#b91c1c'}} data-cattle-batches-saved-views-error>
                Saved views unavailable. Filters still work.
              </span>
            ) : (
              <>
                <select
                  data-cattle-batches-saved-view-select
                  value={selectedViewId}
                  disabled={savedViewsLoading}
                  onChange={(e) => onSelectSavedView(e.target.value)}
                  style={{...toolbarInputS, width: 'auto', minWidth: 200}}
                >
                  <option value="">{savedViewsLoading ? 'Loading...' : 'Select a saved view'}</option>
                  {myViews.length > 0 && (
                    <optgroup label="My views">
                      {myViews.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name + (v.visibility === 'public' ? ' - public' : ' - private')}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {publicOtherViews.length > 0 && (
                    <optgroup label="Public views">
                      {publicOtherViews.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                {selectedViewIsMine && (
                  <>
                    <button
                      type="button"
                      data-cattle-batches-saved-view-update
                      onClick={updateSelectedView}
                      disabled={savedViewBusy}
                      style={savedViewGhostBtnS}
                    >
                      Update to current
                    </button>
                    <button
                      type="button"
                      data-cattle-batches-saved-view-delete
                      onClick={deleteSelectedView}
                      disabled={savedViewBusy}
                      style={{...savedViewGhostBtnS, color: '#b91c1c', borderColor: '#fecaca'}}
                    >
                      Delete
                    </button>
                  </>
                )}
                <span style={{flex: 1}} />
                <button
                  type="button"
                  data-cattle-batches-saved-view-save-open
                  onClick={openSaveViewForm}
                  disabled={savedViewBusy}
                  style={savedViewPrimaryBtnS}
                >
                  Save current view
                </button>
              </>
            )}
          </div>
        )}
        {EXTENDED_LIST_CONTROLS_ENABLED && !loading && !loadError && showSaveViewForm && (
          <div
            data-cattle-batches-saved-view-form
            style={{
              background: 'white',
              border: '1px solid #bfdbfe',
              borderRadius: 10,
              padding: '10px 14px',
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <input
              data-cattle-batches-saved-view-name
              type="text"
              value={saveViewName}
              placeholder="View name"
              onChange={(e) => setSaveViewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitSaveView();
              }}
              style={{...toolbarInputS, flex: 1, minWidth: 200}}
            />
            <label style={savedViewRadioLabelS}>
              <input
                type="radio"
                name="saveCattleBatchViewVisibility"
                checked={saveViewVisibility === 'private'}
                onChange={() => setSaveViewVisibility('private')}
                data-cattle-batches-saved-view-visibility="private"
              />
              Private
            </label>
            <label style={savedViewRadioLabelS}>
              <input
                type="radio"
                name="saveCattleBatchViewVisibility"
                checked={saveViewVisibility === 'public'}
                onChange={() => setSaveViewVisibility('public')}
                data-cattle-batches-saved-view-visibility="public"
              />
              Public
            </label>
            <button
              type="button"
              data-cattle-batches-saved-view-save
              onClick={submitSaveView}
              disabled={savedViewBusy}
              style={savedViewPrimaryBtnS}
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => setShowSaveViewForm(false)}
              disabled={savedViewBusy}
              style={savedViewGhostBtnS}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Operational toolbar — search + status + planned-date range + cow
            count range + sort + direction, filtering/sorting across every
            pipeline section at once. Right-sized: a single flat row, not the
            multi-group chip popovers of the herds tab. */}
        {EXTENDED_LIST_CONTROLS_ENABLED && !loading && !loadError && (
          <div
            data-cattle-batches-toolbar
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '12px 16px',
              marginBottom: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
              <input
                type="text"
                data-cattle-batches-search
                value={(filters && filters.textSearch) || ''}
                onChange={(e) => setFilter('textSearch', e.target.value)}
                placeholder="Search batch name, notes..."
                style={{...toolbarInputS, flex: 1, minWidth: 200}}
              />
              <div
                style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}
                data-cattle-batches-status-filter
              >
                <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Status</span>
                {CATTLE_BATCH_STATUS_KEYS.map((s) => {
                  const on = Array.isArray(filters && filters.status) && filters.status.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      data-cattle-batches-status-option={s}
                      onClick={() => toggleStatus(s)}
                      style={{
                        fontSize: 12,
                        padding: '5px 10px',
                        borderRadius: 10,
                        border: '1px solid ' + (on ? '#1d4ed8' : 'var(--border-strong)'),
                        background: 'white',
                        color: on ? '#1e40af' : 'var(--ink-muted)',
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {CATTLE_BATCH_STATUS_LABELS[s]}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}} data-cattle-batches-planned-range>
                <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Process date</span>
                <input
                  type="date"
                  data-cattle-batches-planned-after
                  value={(filters && filters.plannedDateRange && filters.plannedDateRange.after) || ''}
                  onChange={(e) => setDateBound('plannedDateRange', 'after', e.target.value)}
                  style={{...toolbarInputS, width: 'auto'}}
                />
                <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>to</span>
                <input
                  type="date"
                  data-cattle-batches-planned-before
                  value={(filters && filters.plannedDateRange && filters.plannedDateRange.before) || ''}
                  onChange={(e) => setDateBound('plannedDateRange', 'before', e.target.value)}
                  style={{...toolbarInputS, width: 'auto'}}
                />
              </div>
              <div style={{display: 'flex', alignItems: 'center', gap: 6}} data-cattle-batches-count-range>
                <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Cows</span>
                <input
                  type="number"
                  min="0"
                  data-cattle-batches-count-min
                  value={(filters && filters.animalCountRange && filters.animalCountRange.min) ?? ''}
                  onChange={(e) => setRangeBound('animalCountRange', 'min', e.target.value)}
                  placeholder="min"
                  style={{...toolbarInputS, width: 72}}
                />
                <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>to</span>
                <input
                  type="number"
                  min="0"
                  data-cattle-batches-count-max
                  value={(filters && filters.animalCountRange && filters.animalCountRange.max) ?? ''}
                  onChange={(e) => setRangeBound('animalCountRange', 'max', e.target.value)}
                  placeholder="max"
                  style={{...toolbarInputS, width: 72}}
                />
              </div>
              <span style={{flex: 1}} />
              <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Sort</span>
                <select
                  data-cattle-batches-sort-key
                  value={(sortRule && sortRule.key) || 'plannedDate'}
                  onChange={(e) => setSortKey(e.target.value)}
                  style={{...toolbarInputS, width: 'auto'}}
                >
                  {CATTLE_BATCH_SORT_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {CATTLE_BATCH_SORT_LABELS[k]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-cattle-batches-sort-dir
                  onClick={flipSortDir}
                  title={sortRule && sortRule.dir === 'desc' ? 'Descending' : 'Ascending'}
                  style={savedViewGhostBtnS}
                >
                  {sortRule && sortRule.dir === 'desc' ? 'Desc ↓' : 'Asc ↑'}
                </button>
              </div>
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
              <span style={{fontSize: 12, color: 'var(--ink-muted)'}} data-cattle-batches-count>
                {visibleTotal} of {routableTotal} {routableTotal === 1 ? 'batch' : 'batches'}
              </span>
              {filtersActive && (
                <button
                  type="button"
                  data-cattle-batches-clear-filters
                  onClick={clearAllFilters}
                  style={{...savedViewGhostBtnS, color: '#b91c1c', borderColor: '#fecaca'}}
                >
                  Clear filters
                </button>
              )}
            </div>
          </div>
        )}

        {/* Show Planned Batches (virtual, top, collapsed) */}
        {!loading && !loadError && (
          <CollapsibleSection
            label="Show Planned Batches"
            count={virtualPlanned.length}
            expanded={showPlanned}
            onToggle={() => setShowPlanned((v) => !v)}
            color="white"
            border="#fca5a5"
            text="#991b1b"
            railColor="#991b1b"
            dataKey="planned"
          >
            {virtualPlanned.length === 0 ? (
              <div style={{padding: '0.75rem', color: 'var(--ink-faint)', fontSize: 12, fontStyle: 'italic'}}>
                No planned batches in the next 12 months — the forecast has no eligible cattle landing in the display
                window.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6, padding: '0.5rem 0.75rem'}}>
                {virtualPlanned.map((vb) => (
                  <div
                    key={vb.name}
                    data-virtual-batch={vb.name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      background: 'white',
                      border: '1px dashed #fca5a5',
                      borderRadius: 10,
                      fontSize: 12,
                    }}
                  >
                    <strong style={{color: '#991b1b'}}>{vb.name}</strong>
                    <span style={{color: 'var(--ink-muted)'}}>{vb.label}</span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: '#fef2f2',
                        color: '#991b1b',
                        border: '1px solid #fca5a5',
                        borderRadius: 999,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Planned
                    </span>
                    <span style={{color: 'var(--ink-muted)'}}>
                      {vb.animalIds.length} {vb.animalIds.length === 1 ? 'cow' : 'cows'}
                    </span>
                    {vb.projectedTotalLbs > 0 && (
                      <span style={{color: '#065f46', fontWeight: 600}}>
                        {Math.round(vb.projectedTotalLbs).toLocaleString()} lb projected
                      </span>
                    )}
                    <span style={{flex: 1}} />
                    {canEdit ? (
                      <span style={{display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
                        <input
                          data-virtual-batch-schedule-date={vb.name}
                          type="date"
                          value={scheduleDateDraft[vb.name] || ''}
                          onChange={(e) => setScheduleDateDraft((prev) => ({...prev, [vb.name]: e.target.value}))}
                          style={{
                            fontSize: 11,
                            padding: '3px 6px',
                            border: '1px solid var(--border-strong)',
                            borderRadius: 10,
                            fontFamily: 'inherit',
                          }}
                          title="Processor date for this batch"
                        />
                        <button
                          data-virtual-batch-schedule={vb.name}
                          onClick={() => scheduleVirtualBatch(vb)}
                          disabled={!scheduleDateDraft[vb.name]}
                          style={{
                            fontSize: 11,
                            padding: '4px 10px',
                            borderRadius: 10,
                            border: 'none',
                            background: scheduleDateDraft[vb.name] ? '#085041' : '#9ca3af',
                            color: 'white',
                            cursor: scheduleDateDraft[vb.name] ? 'pointer' : 'not-allowed',
                            fontFamily: 'inherit',
                            fontWeight: 600,
                          }}
                        >
                          Schedule
                        </button>
                      </span>
                    ) : (
                      <span style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
                        Created when sent to processor at WeighIns
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* Scheduled batches — navigate to record page */}
        {!loading && !loadError && scheduledList.length > 0 && (
          <div style={{marginTop: 12}} data-scheduled-section>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#92400e',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Scheduled ({scheduledVisible.length}
              {scheduledVisible.length !== scheduledList.length ? ' of ' + scheduledList.length : ''})
            </div>
            {scheduledVisible.length === 0 ? (
              <div
                data-cattle-batches-scheduled-empty-filtered
                style={{padding: '0.75rem', color: 'var(--ink-faint)', fontSize: 12, fontStyle: 'italic'}}
              >
                No scheduled batches match the current filters.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                {scheduledVisible.map((sb2) => (
                  <div
                    key={sb2.id}
                    data-scheduled-batch={sb2.name}
                    data-batch-row={sb2.id}
                    {...openableProps(() =>
                      navigate('/cattle/batches/' + sb2.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name'))),
                    )}
                    className="hoverable-tile"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      flexWrap: 'wrap',
                      padding: '8px 10px',
                      background: 'white',
                      border: '1px solid #fde68a',
                      borderRadius: 10,
                      fontSize: 12,
                      cursor: 'pointer',
                    }}
                  >
                    <strong style={{color: '#92400e'}}>{sb2.name}</strong>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        background: '#fffbeb',
                        color: '#92400e',
                        border: '1px solid #fde68a',
                        borderRadius: 999,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                      }}
                    >
                      Scheduled
                    </span>
                    <span style={{color: 'var(--ink-muted)'}}>
                      {sb2.animalIds.length} {sb2.animalIds.length === 1 ? 'cow' : 'cows'} forecast
                    </span>
                    {sb2.planned_process_date && (
                      <span style={{color: '#065f46'}}>{fmt(sb2.planned_process_date)}</span>
                    )}
                    <span style={{flex: 1}} />
                    <span style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
                      Cattle remain forecast-backed until sent from WeighIns
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Active batches — navigate to record page */}
        {!loading && !loadError && (
          <div style={{marginTop: 12}}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: '#1d4ed8',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                marginBottom: 8,
              }}
            >
              Active ({activeVisible.length}
              {activeVisible.length !== active.length ? ' of ' + active.length : ''})
            </div>
            {active.length === 0 ? (
              <div
                style={{
                  background: 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: '1.25rem',
                  textAlign: 'center',
                  color: 'var(--ink-muted)',
                  fontSize: 13,
                }}
              >
                No active batches. Cattle enter an active batch only via the Send-to-Processor flag on a finishers
                weigh-in session.
              </div>
            ) : activeVisible.length === 0 ? (
              <div
                data-cattle-batches-active-empty-filtered
                style={{
                  background: 'white',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: '1.25rem',
                  textAlign: 'center',
                  color: 'var(--ink-muted)',
                  fontSize: 13,
                }}
              >
                No active batches match the current filters.
              </div>
            ) : (
              <div style={{display: 'flex', flexDirection: 'column', gap: 10}}>
                {activeVisible.map((b) => {
                  const rows = Array.isArray(b.cows_detail) ? b.cows_detail : [];
                  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
                  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
                  const yieldPct =
                    totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
                  return (
                    <div
                      key={b.id}
                      data-batch-row={b.id}
                      data-batch-name={b.name}
                      data-batch-status={b.status}
                      {...openableProps(() =>
                        navigate('/cattle/batches/' + b.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name'))),
                      )}
                      className="hoverable-tile"
                      style={{
                        background: 'white',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        padding: '12px 18px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>{b.name}</span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 10,
                          background: '#1d4ed8',
                          color: 'white',
                          textTransform: 'uppercase',
                        }}
                      >
                        {b.status}
                      </span>
                      <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                        {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
                      </span>
                      {b.actual_process_date && (
                        <span style={{fontSize: 11, color: '#065f46'}}>processed {fmt(b.actual_process_date)}</span>
                      )}
                      {yieldPct && (
                        <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Processed batches — navigate to record page */}
        {!loading && !loadError && (
          <div style={{marginTop: 14}}>
            <CollapsibleSection
              label="Show Processed Batches"
              count={completed.length}
              expanded={showCompleted}
              onToggle={() => setShowCompleted((v) => !v)}
              color="var(--divider)"
              border="var(--border-strong)"
              text="var(--ink)"
              dataKey="processed"
            >
              {completed.length === 0 ? (
                <div style={{padding: '0.75rem', color: 'var(--ink-faint)', fontSize: 12, fontStyle: 'italic'}}>
                  No processed batches yet.
                </div>
              ) : completedVisible.length === 0 ? (
                <div
                  data-cattle-batches-processed-empty-filtered
                  style={{padding: '0.75rem', color: 'var(--ink-faint)', fontSize: 12, fontStyle: 'italic'}}
                >
                  No processed batches match the current filters.
                </div>
              ) : (
                <div style={{display: 'flex', flexDirection: 'column', gap: 10, padding: '0.5rem 0'}}>
                  {completedVisible.map((b) => {
                    const rows = Array.isArray(b.cows_detail) ? b.cows_detail : [];
                    const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
                    const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
                    const yieldPct =
                      totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
                    return (
                      <div
                        key={b.id}
                        data-batch-row={b.id}
                        data-batch-name={b.name}
                        data-batch-status={b.status}
                        {...openableProps(() =>
                          navigate(
                            '/cattle/batches/' + b.id,
                            recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')),
                          ),
                        )}
                        className="hoverable-tile"
                        style={{
                          background: 'white',
                          border: '1px solid var(--border)',
                          borderRadius: 12,
                          padding: '12px 18px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)'}}>{b.name}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: 10,
                            background: '#374151',
                            color: 'white',
                            textTransform: 'uppercase',
                          }}
                        >
                          {b.status}
                        </span>
                        <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>
                          {rows.length} {rows.length === 1 ? 'cow' : 'cows'}
                        </span>
                        {(b.actual_process_date || b.planned_process_date) && (
                          <span style={{fontSize: 11, color: '#065f46'}}>
                            processed {fmt(b.actual_process_date || b.planned_process_date)}
                          </span>
                        )}
                        {yieldPct && (
                          <span style={{fontSize: 11, fontWeight: 600, color: '#065f46'}}>{yieldPct + '% yield'}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CollapsibleSection>
          </div>
        )}
      </div>
    </div>
  );
};

function CollapsibleSection({label, count, expanded, onToggle, color, border, text, railColor, children, dataKey}) {
  return (
    <div
      style={{
        background: 'white',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        marginBottom: 0,
      }}
      data-batches-section={dataKey}
    >
      <div
        {...openableProps(onToggle)}
        className="hoverable-tile"
        style={{
          padding: '12px 16px',
          background: color,
          borderBottom: expanded ? '1px solid ' + border : 'none',
          ...(railColor ? {borderLeft: '3px solid ' + railColor} : null),
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
      >
        <span style={{fontSize: 12, color: text}}>{expanded ? '▼' : '▶'}</span>
        <span style={{fontSize: 13, fontWeight: 700, color: text}}>{label}</span>
        <span style={{fontSize: 11, color: text, opacity: 0.7}}>({count})</span>
      </div>
      {expanded && children}
    </div>
  );
}

function CattleBatchesRouter(props) {
  const location = useLocation();
  const batchDetailId = location.pathname.startsWith('/cattle/batches/')
    ? location.pathname.slice('/cattle/batches/'.length) || null
    : null;
  if (batchDetailId) {
    return React.createElement(CattleBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(CattleBatchesHub, props);
}

export default CattleBatchesRouter;
