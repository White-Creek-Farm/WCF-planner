// LayerBatchesView — hub + router for layer batches and housings.
//
// Hub shows a unified vertical inspection grid (header row + aligned nav-only
// rows) of layer batches with summary stats, plus a right-sized toolbar:
// search, status, supplier, start-date range, bird-count range, a single
// active sort rule, saved views (surface_key 'layer.batches'), and CSV/print
// export of the filtered+sorted set. Filter/sort semantics live in the pure
// lib src/lib/layerBatchFilters.js. Row clicks navigate to /layer/batches/<id>
// with the SORTED set as the record-sequence order. The per-record workspace
// (metadata edit, lifecycle phases, housings list, batch delete cascade) lives
// on LayerBatchPage; layer.housing records have their own page at
// /layer/housings/<id>. Both record pages own Comments + collapsed Activity
// via RecordCollaborationSection.
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import OperationalListEmptyState from '../shared/OperationalListEmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
import {computeHousingDisplayCount, computeLayerFeedCost} from '../lib/layerHousing.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildLayerBatchExportColumns} from '../lib/operationalExportColumns.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {LAYER_BATCH_SORT_KEYS, buildLayerBatchPredicate, buildLayerBatchComparator} from '../lib/layerBatchFilters.js';
import {computeBatchStats} from './layerBatchStats.js';
import LayerBatchPage from './LayerBatchPage.jsx';
import LayerHousingPage from './LayerHousingPage.jsx';

const LAYER_BATCHES_SURFACE_KEY = 'layer.batches';
const EXTENDED_LIST_CONTROLS_ENABLED = false;

const LAYER_BATCH_STATUS_OPTIONS = [
  {key: 'active', label: 'Active'},
  {key: 'retired', label: 'Retired'},
];

const LAYER_BATCH_SORT_KEY_LABELS = {
  batchName: 'Batch name',
  status: 'Status',
  startDate: 'Start date',
  birdCount: 'Bird count',
};

const LAYER_BATCH_SORT_DIR_LABELS = {
  batchName: {asc: 'A to Z', desc: 'Z to A'},
  status: {asc: 'active to retired', desc: 'retired to active'},
  startDate: {asc: 'oldest first', desc: 'newest first'},
  birdCount: {asc: 'fewest first', desc: 'most first'},
};

// Shared column template for the unified Layer Batches inspection grid. The hub
// header row and every batch row consume the SAME template so the columns stay
// aligned, Podio-style. Tracks:
//   Batch | Status | Housings | Hens | Feed | Mort. | Dozens | Cost | Open
const LAYER_BATCH_GRID_COLUMNS = 'minmax(120px, 1.4fr) 84px minmax(120px, 1.6fr) 70px 92px 64px 72px 84px 56px';

const LayerBatchesHub = ({
  sb,
  layerGroups,
  layerBatches,
  setLayerBatches,
  layerHousings,
  fmt,
  Header,
  authState,
  pendingEdit,
  setPendingEdit,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const {useState, useEffect} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [rawLayerDailys, setRawLayerDailys] = useState([]);
  const [rawEggDailys, setRawEggDailys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const myProfileId = authState?.user?.id || null;

  // Right-sized list parity: a single toolbar row of filters + a single active
  // sort rule, persisted across navigation via usePersistentViewState.
  const [fSearch, setFSearch] = usePersistentViewState('layer.batches.search', '');
  const [fStatus, setFStatus] = usePersistentViewState('layer.batches.status', '');
  const [fSupplier, setFSupplier] = usePersistentViewState('layer.batches.supplier', '');
  const [fStartAfter, setFStartAfter] = usePersistentViewState('layer.batches.startAfter', '');
  const [fStartBefore, setFStartBefore] = usePersistentViewState('layer.batches.startBefore', '');
  const [fBirdMin, setFBirdMin] = usePersistentViewState('layer.batches.birdMin', '');
  const [fBirdMax, setFBirdMax] = usePersistentViewState('layer.batches.birdMax', '');
  const [sortKey, setSortKey] = usePersistentViewState('layer.batches.sortKey', 'status');
  const [sortDir, setSortDir] = usePersistentViewState('layer.batches.sortDir', 'asc');

  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);
  const [savedViewNotice, setSavedViewNotice] = useState(null);

  const [showAddBatch, setShowAddBatch] = useState(false);
  const [addName, setAddName] = useState('');
  const [addArrivalDate, setAddArrivalDate] = useState('');
  const [addStatus, setAddStatus] = useState('active');
  const [addErr, setAddErr] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  function nextBatchName() {
    const yr = new Date().getFullYear().toString().slice(2);
    const existing = (layerBatches || []).filter((b) => b.name && b.name.match(/^L-\d{2}-\d{2}$/));
    const nums = existing.map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...nums) + 1).toString().padStart(2, '0');
    return `L-${yr}-${next}`;
  }

  const loadLayerMetrics = React.useCallback(async () => {
    const PAGE = 1000;
    async function fetchAll(table, columns) {
      let all = [];
      let offset = 0;
      let done = false;
      while (!done) {
        const {data, error} = await sb
          .from(table)
          .select(columns)
          .is('deleted_at', null)
          .range(offset, offset + PAGE - 1);
        if (error) {
          throw new Error(`${table}: ${error.message}`);
        }
        if (!data || data.length === 0) {
          done = true;
          break;
        }
        all = all.concat(data);
        if (data.length < PAGE) done = true;
        else offset += PAGE;
      }
      return all;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const [ld, ed] = await Promise.all([
        fetchAll('layer_dailys', 'batch_label,batch_id,feed_lbs,grit_lbs,mortality_count,layer_count,date,feed_type'),
        fetchAll(
          'egg_dailys',
          'group1_name,group1_count,group2_name,group2_count,group3_name,group3_count,group4_name,group4_count,date',
        ),
      ]);
      setRawLayerDailys(ld);
      setRawEggDailys(ed);
    } catch (e) {
      setRawLayerDailys([]);
      setRawEggDailys([]);
      setLoadError({kind: 'error', message: 'Could not load layer batch metrics: ' + (e?.message || e)});
    } finally {
      setLoading(false);
    }
  }, [sb]);

  useEffect(() => {
    loadLayerMetrics();
  }, [layerBatches, layerHousings, loadLayerMetrics]);

  // Pick up notice handed via navigation state (e.g. delete report from
  // record page if blocked detaches need surfacing on the hub).
  useEffect(() => {
    if (location.state && location.state.notice) {
      setNotice(location.state.notice);
      navigate(location.pathname, {replace: true, state: null});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timeline deep-link → /layer/batches/<id>
  useEffect(() => {
    if (pendingEdit?.viewName === 'layerbatches' && pendingEdit?.id) {
      const id = pendingEdit.id;
      setPendingEdit && setPendingEdit(null);
      navigate('/layer/batches/' + id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEdit]);

  // Saved views degrade locally: a load failure shows a small notice but never
  // blocks the list or the filters.
  const loadSavedViews = React.useCallback(async () => {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, LAYER_BATCHES_SURFACE_KEY);
      setSavedViews(rows);
      setSavedViewsError(null);
      setSelectedViewId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : ''));
    } catch (e) {
      setSavedViews([]);
      setSavedViewsError(e.message || String(e));
    } finally {
      setSavedViewsLoading(false);
    }
  }, [sb]);

  useEffect(() => {
    loadSavedViews();
  }, [loadSavedViews]);

  const batchStats = React.useMemo(
    () => computeBatchStats(layerBatches || [], layerHousings || [], rawLayerDailys, rawEggDailys),
    [layerBatches, layerHousings, rawLayerDailys, rawEggDailys],
  );

  function openAdd() {
    if (!canEdit) return;
    setAddErr('');
    setAddName(nextBatchName());
    setAddArrivalDate('');
    setAddStatus('active');
    setShowAddBatch(true);
  }

  async function saveNewBatch() {
    if (!canEdit) return;
    setAddErr('');
    const name = (addName || '').trim();
    if (!name) {
      setAddErr('Batch name required.');
      return;
    }
    setAddBusy(true);
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const rec = {
      id,
      name,
      status: addStatus || 'active',
      arrival_date: addArrivalDate || null,
      original_count: null,
      supplier: null,
      cost_per_bird: null,
      brooder_name: null,
      brooder_entry_date: null,
      brooder_exit_date: null,
      schooner_name: null,
      schooner_entry_date: null,
      schooner_exit_date: null,
      notes: null,
    };
    const {error} = await sb.from('layer_batches').upsert(rec, {onConflict: 'id'});
    setAddBusy(false);
    if (error) {
      setAddErr('Could not save: ' + error.message);
      return;
    }
    if (typeof setLayerBatches === 'function') {
      setLayerBatches((prev) => {
        const exists = prev.find((b) => b.id === rec.id);
        return exists ? prev.map((b) => (b.id === rec.id ? rec : b)) : [...prev, rec];
      });
    }
    setShowAddBatch(false);
    navigate('/layer/batches/' + id);
  }

  const totalBatches = (layerBatches || []).length;
  const activeBatches = (layerBatches || []).filter((b) => b.status === 'active');

  // Filter values for the lib live as a plain object so saved views round-trip
  // the exact predicate input. Empty range fields collapse to null so the
  // predicate treats them as inactive.
  const numOrNull = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const rawFilters = {
    textSearch: fSearch,
    status: fStatus,
    supplier: fSupplier,
    startDateRange: {after: fStartAfter || null, before: fStartBefore || null},
    birdCountRange: {min: numOrNull(fBirdMin), max: numOrNull(fBirdMax)},
  };
  const rawSortRule = {key: sortKey, dir: sortDir};
  const filters = EXTENDED_LIST_CONTROLS_ENABLED
    ? rawFilters
    : {textSearch: '', status: '', supplier: '', startDateRange: {}, birdCountRange: {}};
  const sortRule = EXTENDED_LIST_CONTROLS_ENABLED ? rawSortRule : {key: 'status', dir: 'asc'};
  const hasActiveFilters =
    EXTENDED_LIST_CONTROLS_ENABLED &&
    !!(fSearch || fStatus || fSupplier || fStartAfter || fStartBefore || fBirdMin || fBirdMax);

  // Distinct suppliers observed on the batches, for the supplier dropdown.
  const supplierOpts = [...new Set((layerBatches || []).map((b) => b.supplier).filter(Boolean))].sort();

  // filtered = predicate over all batches; sorted = single active sort rule.
  // The SORTED set drives render, record-sequence nav, and CSV/print export.
  const filtered = (layerBatches || []).filter(buildLayerBatchPredicate(filters));
  const sorted = [...filtered].sort(buildLayerBatchComparator(sortRule));
  const batchSeqRows = sorted;

  function decorateBatch(batch) {
    const stats = batchStats[batch.id] || {};
    const activeHousings = (layerHousings || []).filter((h) => h.batch_id === batch.id && h.status === 'active');
    const currentHens = activeHousings.reduce(
      (sum, housing) => sum + computeHousingDisplayCount(housing, rawLayerDailys, layerHousings),
      0,
    );
    return {
      ...batch,
      active_housing_names: activeHousings
        .map((h) => h.housing_name)
        .filter(Boolean)
        .join(', '),
      current_hens: currentHens,
      total_feed_lbs: stats.totalFeed || 0,
      total_mortality: stats.totalMort || 0,
      total_dozens: stats.totalEggs > 0 ? Math.floor(stats.totalEggs / 12) : 0,
      feed_cost: computeLayerFeedCost(stats.starterFeed, stats.growerFeed, stats.layerFeed, batch),
    };
  }
  const layerBatchExportRows = sorted.map(decorateBatch);
  const exportColumns = buildLayerBatchExportColumns({fmt});
  function handleExportCsv() {
    if (!layerBatchExportRows.length) {
      setNotice({kind: 'warning', message: 'No layer batches to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('layer-batches'), rowsToCsv(exportColumns, layerBatchExportRows));
    if (!ok) setNotice({kind: 'warning', message: 'CSV export is unavailable in this browser.'});
  }

  function handlePrintRows() {
    if (!layerBatchExportRows.length) {
      setNotice({kind: 'warning', message: 'No layer batches to print.'});
      return;
    }
    const ok = printRows({
      title: 'Layer Batches',
      subtitle: layerBatchExportRows.length + ' batches',
      columns: exportColumns,
      rows: layerBatchExportRows,
    });
    if (!ok) setNotice({kind: 'warning', message: 'Print export is unavailable in this browser.'});
  }

  function clearFilters() {
    setFSearch('');
    setFStatus('');
    setFSupplier('');
    setFStartAfter('');
    setFStartBefore('');
    setFBirdMin('');
    setFBirdMax('');
  }

  // ── Saved views (surface_key 'layer.batches') ──────────────────────────────
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );

  function layerBatchesViewState() {
    return buildViewState({
      filters,
      sortRules: [{key: sortKey, dir: sortDir}],
      viewMode: 'flat',
    });
  }

  function applyLayerBatchesSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    const f = st.filters && typeof st.filters === 'object' ? st.filters : {};
    setFSearch(typeof f.textSearch === 'string' ? f.textSearch : '');
    setFStatus(typeof f.status === 'string' ? f.status : '');
    setFSupplier(typeof f.supplier === 'string' ? f.supplier : '');
    const sdr = f.startDateRange && typeof f.startDateRange === 'object' ? f.startDateRange : {};
    setFStartAfter(typeof sdr.after === 'string' ? sdr.after : '');
    setFStartBefore(typeof sdr.before === 'string' ? sdr.before : '');
    const bcr = f.birdCountRange && typeof f.birdCountRange === 'object' ? f.birdCountRange : {};
    setFBirdMin(bcr.min != null ? String(bcr.min) : '');
    setFBirdMax(bcr.max != null ? String(bcr.max) : '');
    const rule = Array.isArray(st.sortRules) && st.sortRules[0] ? st.sortRules[0] : null;
    setSortKey(rule && LAYER_BATCH_SORT_KEYS.includes(rule.key) ? rule.key : 'status');
    setSortDir(rule && rule.dir === 'desc' ? 'desc' : 'asc');
    setSavedViewNotice(null);
  }

  function onSelectSavedView(id) {
    setSelectedViewId(id);
    setSavedViewNotice(null);
    if (!id) return;
    applyLayerBatchesSavedView(savedViews.find((v) => v.id === id));
  }

  function openSaveViewForm() {
    setSaveViewName('');
    setSaveViewVisibility('private');
    setSavedViewNotice(null);
    setShowSaveViewForm(true);
  }

  async function submitSaveView() {
    const name = saveViewName.trim();
    if (!name) {
      setSavedViewNotice({kind: 'error', message: 'Name the view before saving.'});
      return;
    }
    setSavedViewBusy(true);
    try {
      const created = await createSavedView(sb, {
        surfaceKey: LAYER_BATCHES_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: layerBatchesViewState(),
      });
      setShowSaveViewForm(false);
      setSavedViewNotice({kind: 'success', message: 'Saved view "' + name + '".'});
      await loadSavedViews();
      if (created?.id) setSelectedViewId(created.id);
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Save view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  async function updateSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    setSavedViewBusy(true);
    try {
      await updateSavedView(sb, selectedView.id, {viewState: layerBatchesViewState()});
      await loadSavedViews();
      setSavedViewNotice({kind: 'success', message: 'Updated "' + selectedView.name + '" to the current filters.'});
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
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
      setSavedViewNotice({kind: 'success', message: 'Deleted saved view "' + view.name + '".'});
    } catch (e) {
      setSavedViewNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  function deleteSelectedView() {
    if (!selectedView || !selectedViewIsMine || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete saved view "' + selectedView.name + '"?', () => {
      void proceedDeleteSelectedView(selectedView);
    });
  }

  const fieldS = {
    padding: '6px 10px',
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'white',
    width: 'auto',
  };
  const savedViewGhostBtnS = {
    ...fieldS,
    color: 'var(--ink)',
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };

  return (
    <div style={{minHeight: '100vh', background: 'var(--bg-page)'}}>
      <Header />
      <div
        style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}
        data-layer-batches-hub
        data-layer-batches-loaded={loading || loadError ? 'false' : 'true'}
      >
        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
        <InlineNotice notice={loadError} />
        {loadError && (
          <button
            type="button"
            onClick={loadLayerMetrics}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--text-primary)',
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
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16}}>
          <div style={{fontSize: 20, fontWeight: 700, color: 'var(--ink)'}}>
            Layer Batches
            <span
              style={{fontSize: 13, fontWeight: 400, color: 'var(--ink-muted)', marginLeft: 8}}
              data-layer-batches-count
            >
              {sorted.length} of {totalBatches}
              {totalBatches > 0 ? ' · ' + activeBatches.length + ' active' : ''}
            </span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
            {EXTENDED_LIST_CONTROLS_ENABLED && (
              <>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  data-layer-batches-export-csv="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handlePrintRows}
                  data-layer-batches-print="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Print
                </button>
              </>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={openAdd}
                data-layer-new-batch
                style={{
                  padding: '7px 18px',
                  borderRadius: 10,
                  border: 'none',
                  background: getProgramColor('layer'),
                  color: getReadableText(getProgramColor('layer')),
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                + New Batch
              </button>
            )}
          </div>
        </div>

        {EXTENDED_LIST_CONTROLS_ENABLED && !loadError && (
          <>
            <div
              data-layer-batches-saved-views-row
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
                <span style={{fontSize: 12, color: 'var(--danger)'}} data-layer-batches-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-layer-batches-saved-view-select
                    value={selectedViewId}
                    disabled={savedViewsLoading}
                    onChange={(e) => onSelectSavedView(e.target.value)}
                    style={{...fieldS, minWidth: 200}}
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
                        data-layer-batches-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-layer-batches-saved-view-delete
                        onClick={deleteSelectedView}
                        disabled={savedViewBusy}
                        style={{...savedViewGhostBtnS, color: 'var(--danger)', borderColor: 'var(--border)'}}
                      >
                        Delete
                      </button>
                    </>
                  )}
                  <span style={{flex: 1}} />
                  {savedViewNotice && (
                    <span
                      style={{
                        fontSize: 12,
                        color: savedViewNotice.kind === 'success' ? 'var(--ok-ink)' : 'var(--danger)',
                      }}
                    >
                      {savedViewNotice.message}
                    </span>
                  )}
                  <button
                    type="button"
                    data-layer-batches-saved-view-save-open
                    onClick={openSaveViewForm}
                    disabled={savedViewBusy || savedViewsLoading}
                    style={savedViewPrimaryBtnS}
                  >
                    Save current view
                  </button>
                </>
              )}
            </div>
            {showSaveViewForm && (
              <div
                data-layer-batches-saved-view-form
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
                <input
                  data-layer-batches-saved-view-name
                  type="text"
                  value={saveViewName}
                  placeholder="View name"
                  onChange={(e) => setSaveViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSaveView();
                  }}
                  style={{...fieldS, flex: 1, minWidth: 200}}
                />
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveLayerBatchesViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-layer-batches-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveLayerBatchesViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-layer-batches-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-layer-batches-saved-view-save
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
            <div
              data-layer-batches-toolbar
              style={{display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center'}}
            >
              <input
                type="text"
                data-layer-batches-search
                value={fSearch}
                placeholder="Search batch / supplier"
                onChange={(e) => setFSearch(e.target.value)}
                style={{...fieldS, minWidth: 180}}
              />
              <select
                data-layer-batches-status-filter
                value={fStatus}
                onChange={(e) => setFStatus(e.target.value)}
                style={fieldS}
              >
                <option value="">All statuses</option>
                {LAYER_BATCH_STATUS_OPTIONS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                data-layer-batches-supplier-filter
                value={fSupplier}
                onChange={(e) => setFSupplier(e.target.value)}
                style={fieldS}
              >
                <option value="">All suppliers</option>
                {supplierOpts.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Start</span>
              <input
                type="date"
                data-layer-batches-start-after
                value={fStartAfter}
                onChange={(e) => setFStartAfter(e.target.value)}
                style={{...fieldS, width: 130}}
              />
              <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>to</span>
              <input
                type="date"
                data-layer-batches-start-before
                value={fStartBefore}
                onChange={(e) => setFStartBefore(e.target.value)}
                style={{...fieldS, width: 130}}
              />
              <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>Birds</span>
              <input
                type="number"
                min="0"
                data-layer-batches-bird-min
                value={fBirdMin}
                placeholder="min"
                onChange={(e) => setFBirdMin(e.target.value)}
                style={{...fieldS, width: 78}}
              />
              <input
                type="number"
                min="0"
                data-layer-batches-bird-max
                value={fBirdMax}
                placeholder="max"
                onChange={(e) => setFBirdMax(e.target.value)}
                style={{...fieldS, width: 78}}
              />
              <span style={{flex: 1}} />
              <select
                data-layer-batches-sort-key
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value)}
                style={fieldS}
              >
                {LAYER_BATCH_SORT_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {LAYER_BATCH_SORT_KEY_LABELS[k] || k}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-layer-batches-sort-dir
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                style={{...savedViewGhostBtnS}}
                title="Toggle sort direction"
              >
                {(LAYER_BATCH_SORT_DIR_LABELS[sortKey] && LAYER_BATCH_SORT_DIR_LABELS[sortKey][sortDir]) ||
                  (sortDir === 'desc' ? 'desc' : 'asc')}
              </button>
              {hasActiveFilters && (
                <button
                  type="button"
                  data-layer-batches-clear-filters
                  onClick={clearFilters}
                  style={{...fieldS, color: 'var(--ink-muted)', cursor: 'pointer', fontWeight: 600}}
                >
                  Clear
                </button>
              )}
            </div>
          </>
        )}

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)'}}>Loading...</div>}

        {!loading && !loadError && totalBatches === 0 && (
          <div
            data-empty-state="true-empty"
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '2rem',
              textAlign: 'center',
              color: 'var(--ink-muted)',
              fontSize: 13,
            }}
          >
            No layer batches yet. Click <strong>+ New Batch</strong> to plan one.
          </div>
        )}

        {/* true-empty (totalBatches === 0) is handled by the richer block above
            with the +New Batch call to action; the shared component renders the
            filtered-no-results message only. */}
        {totalBatches > 0 && (
          <OperationalListEmptyState
            loading={loading}
            loadError={loadError}
            totalCount={totalBatches}
            filteredCount={sorted.length}
            emptyLabel="No layer batches yet"
            filteredLabel="No layer batches match the current filters"
          />
        )}

        {!loading && !loadError && sorted.length > 0 && (
          <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden'}}>
            {/* Header row — same grid template as every batch row below. */}
            <div
              data-layer-batches-grid-header
              style={{
                display: 'grid',
                gridTemplateColumns: LAYER_BATCH_GRID_COLUMNS,
                gap: 10,
                alignItems: 'center',
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface-2)',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--ink-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
            >
              <span>Batch</span>
              <span>Status</span>
              <span>Housings</span>
              <span>Hens</span>
              <span>Feed</span>
              <span>Mort.</span>
              <span>Dozens</span>
              <span>Cost</span>
              <span style={{textAlign: 'right'}}>Open</span>
            </div>
            {layerBatchExportRows.map((row) => {
              const stats = batchStats[row.id] || {};
              const isRetired = row.status === 'retired';
              const isRetHome = row.name === 'Retirement Home';
              const statusLabel = isRetHome ? 'Permanent' : isRetired ? 'Retired' : 'Active';
              const statusVariant = isRetHome ? 'warn' : isRetired ? 'neutral' : 'ok';
              const fc = row.feed_cost;
              return (
                <div
                  key={row.id}
                  data-layer-batch-tile={row.id}
                  {...openableProps(() =>
                    navigate('/layer/batches/' + row.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name'))),
                  )}
                  className="hoverable-tile"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: LAYER_BATCH_GRID_COLUMNS,
                    gap: 10,
                    alignItems: 'center',
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--divider)',
                    cursor: 'pointer',
                    background: isRetired ? '#fafafa' : 'white',
                    opacity: isRetired ? 0.85 : 1,
                  }}
                >
                  {/* Batch */}
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 13,
                      color: 'var(--ink)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.name}
                  </span>
                  {/* Status */}
                  <span style={{justifySelf: 'start'}}>
                    <Badge variant={statusVariant}>{statusLabel}</Badge>
                  </span>
                  {/* Active housings */}
                  <span
                    style={{
                      fontSize: 11,
                      color: row.active_housing_names ? 'var(--ink)' : 'var(--ink-faint)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.active_housing_names ? '🏠 ' + row.active_housing_names : '—'}
                  </span>
                  {/* Current hens */}
                  <span style={{fontSize: 12, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums'}}>
                    {row.current_hens > 0 ? <strong>{row.current_hens.toLocaleString()}</strong> : '—'}
                  </span>
                  {/* Feed */}
                  <span style={{fontSize: 12, color: stats.totalFeed > 0 ? 'var(--text-primary)' : 'var(--ink-faint)'}}>
                    {stats.totalFeed > 0 ? (
                      <strong>{Math.round(stats.totalFeed).toLocaleString() + ' lb'}</strong>
                    ) : (
                      '—'
                    )}
                  </span>
                  {/* Mortality — danger ink only when it flags a high loss */}
                  <span style={{fontSize: 12, fontVariantNumeric: 'tabular-nums'}}>
                    {stats.totalMort > 10 ? (
                      <StatusText tone="danger">{row.total_mortality > 0 ? row.total_mortality : '0'}</StatusText>
                    ) : (
                      <span style={{color: 'var(--text-primary)'}}>
                        {row.total_mortality > 0 ? row.total_mortality : '0'}
                      </span>
                    )}
                  </span>
                  {/* Dozens */}
                  <span
                    style={{fontSize: 12, color: row.total_dozens > 0 ? 'var(--text-primary)' : 'var(--ink-faint)'}}
                  >
                    {row.total_dozens > 0 ? row.total_dozens.toLocaleString() : '—'}
                  </span>
                  {/* Cost */}
                  <span style={{fontSize: 12, color: fc != null ? 'var(--text-primary)' : 'var(--ink-faint)'}}>
                    {fc != null
                      ? '$' + fc.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})
                      : '—'}
                  </span>
                  {/* Open */}
                  <span style={{fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right'}}>
                    {'Open ->'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* + New Batch helper */}
      {showAddBatch && (
        <div
          onClick={() => setShowAddBatch(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,.45)',
            zIndex: 500,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '1rem',
            overflowY: 'auto',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            data-layer-new-batch-modal
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 440,
              boxShadow: '0 8px 32px rgba(0,0,0,.2)',
              marginTop: 40,
            }}
          >
            <div
              style={{
                padding: '14px 20px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: 'var(--text-primary)'}}>New Layer Batch</div>
              <button
                type="button"
                onClick={() => setShowAddBatch(false)}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--ink-faint)'}}
              >
                ×
              </button>
            </div>
            <div style={{padding: '16px 20px', display: 'grid', gap: 10}}>
              <div>
                <label
                  style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3, fontWeight: 500}}
                >
                  Batch Name *
                </label>
                <input
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  data-layer-new-batch-name
                  placeholder="e.g. L-26-01"
                />
              </div>
              <div>
                <label
                  style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3, fontWeight: 500}}
                >
                  Status
                </label>
                <select value={addStatus} onChange={(e) => setAddStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              <div>
                <label
                  style={{fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3, fontWeight: 500}}
                >
                  Arrival Date
                </label>
                <input type="date" value={addArrivalDate} onChange={(e) => setAddArrivalDate(e.target.value)} />
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--ink-muted)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  padding: '8px 10px',
                }}
              >
                Saves a batch shell and opens its record page. Fill in brooder, schooner, and costs there.
              </div>
              {addErr && <div style={{color: 'var(--danger)', fontSize: 12, fontWeight: 600}}>{addErr}</div>}
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              <button
                type="button"
                onClick={saveNewBatch}
                disabled={addBusy}
                data-layer-new-batch-save
                style={{
                  padding: '8px 18px',
                  borderRadius: 10,
                  border: 'none',
                  background: addBusy ? '#9ca3af' : getProgramColor('layer'),
                  color: addBusy ? 'white' : getReadableText(getProgramColor('layer')),
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: addBusy ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save & open
              </button>
              <button
                type="button"
                onClick={() => setShowAddBatch(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink-muted)',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function LayerBatchesRouter(props) {
  const location = useLocation();
  if (location.pathname.startsWith('/layer/housings/')) {
    return React.createElement(LayerHousingPage, {
      sb: props.sb,
      fmt: props.fmt,
      Header: props.Header,
      authState: props.authState,
      layerGroups: props.layerGroups,
      layerBatches: props.layerBatches,
      layerHousings: props.layerHousings,
      setLayerHousings: props.setLayerHousings,
    });
  }
  if (location.pathname.startsWith('/layer/batches/')) {
    return React.createElement(LayerBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      Header: props.Header,
      authState: props.authState,
      layerGroups: props.layerGroups,
      layerBatches: props.layerBatches,
      layerHousings: props.layerHousings,
      setLayerBatches: props.setLayerBatches,
      setLayerHousings: props.setLayerHousings,
      batches: props.batches,
      feedCosts: props.feedCosts,
      confirmDelete: props.confirmDelete,
    });
  }
  return React.createElement(LayerBatchesHub, props);
}

export default LayerBatchesRouter;
