// SheepBatchesView — hub + router for sheep processing batches.
//
// Sheep enter a processing batch ONLY through the Send-to-Processor flag
// on a sheep weigh-in entry (any draft session, any flock per §7). The
// hub lists batches as navigation-only summaries; the record page at
// /sheep/batches/<id> owns editing, per-sheep weights, detach, and delete.
// The + New Batch helper creates an empty shell and navigates to the
// record page.
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildProcessingBatchExportColumns} from '../lib/operationalExportColumns.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {
  SHEEP_BATCH_STATUS_KEYS,
  SHEEP_BATCH_SORT_KEYS,
  buildSheepBatchPredicate,
  buildSheepBatchComparator,
} from '../lib/sheepBatchFilters.js';
import SheepBatchPage from './SheepBatchPage.jsx';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';

const SHEEP_BATCHES_SURFACE_KEY = 'sheep.batches';
const EXTENDED_LIST_CONTROLS_ENABLED = false;

const SHEEP_BATCH_SORT_LABELS = {
  batchName: 'Batch name',
  status: 'Status',
  plannedDate: 'Planned date',
  animalCount: 'Sheep count',
  yieldPct: 'Yield %',
};

// Shared column template for the unified Sheep Batches grid. The header row and
// every batch row consume the SAME template so columns stay aligned, Podio-style
// (mirrors PIG_BATCH_GRID_COLUMNS in PigBatchHubTile).
//   Batch | Status | Sheep | Planned | Yield | Open
const SHEEP_BATCH_GRID_COLUMNS = 'minmax(140px, 1.8fr) 96px 64px minmax(120px, 1fr) 80px 60px';

const SheepBatchesHub = ({sb, fmt, Header, authState, showUsers, setShowUsers, allUsers, setAllUsers, loadUsers}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const {useState, useEffect, useMemo} = React;
  const role = authState && authState.role;
  const canEdit = role === 'admin' || role === 'management';

  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(null);
  const [notice, setNotice] = useState(null);
  const [creating, setCreating] = useState(false);

  // Right-sized list parity: flat filters + a single active sort rule.
  const [filters, setFilters] = useState({});
  const [sortRule, setSortRule] = useState({key: 'plannedDate', dir: 'desc'});
  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);
  const myProfileId = authState?.user?.id || null;

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const bR = await sb
        .from('sheep_processing_batches')
        .select('*')
        .order('planned_process_date', {ascending: false});
      if (bR.error) throw new Error('sheep_processing_batches: ' + (bR.error.message || bR.error));
      const byDate = (x) => x.actual_process_date || x.planned_process_date || x.created_at || '';
      setBatches((bR.data || []).slice().sort((a, b) => byDate(b).localeCompare(byDate(a))));
    } catch (e) {
      setBatches([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load sheep processing batches. Please refresh the page. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pick up a notice handed off via navigation state (e.g. delete report from
  // SheepBatchPage when blocked detaches need surfacing on the hub).
  useEffect(() => {
    if (location.state && location.state.notice) {
      setNotice(location.state.notice);
      navigate(location.pathname, {replace: true, state: null});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved views (surface_key sheep.batches). Failure degrades gracefully — a
  // small notice, never blocking the list or its filters.
  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, SHEEP_BATCHES_SURFACE_KEY);
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

  function openAdd() {
    if (!canEdit) return;
    setNotice(null);
    const yr = new Date().getFullYear().toString().slice(-2);
    const existing = batches
      .filter((b) => b.name && b.name.startsWith('S-' + yr + '-'))
      .map((b) => parseInt(b.name.slice(5)) || 0);
    const next = (Math.max(0, ...existing) + 1).toString().padStart(2, '0');
    setForm({
      name: 'S-' + yr + '-' + next,
      planned_process_date: '',
      status: 'planned',
    });
    setShowForm(true);
  }

  function closeForm() {
    setNotice(null);
    setShowForm(false);
    setForm(null);
  }

  async function saveNewBatch() {
    if (!canEdit || !form) return;
    setNotice(null);
    const name = (form.name || '').trim();
    if (!name) {
      setNotice({kind: 'error', message: 'Batch name required.'});
      return;
    }
    setCreating(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const row = {
      id,
      name,
      planned_process_date: form.planned_process_date || null,
      actual_process_date: null,
      processing_cost: null,
      notes: null,
      status: form.status || 'planned',
      sheep_detail: [],
      total_live_weight: null,
      total_hanging_weight: null,
    };
    const {error} = await sb.from('sheep_processing_batches').insert(row);
    setCreating(false);
    if (error) {
      setNotice({kind: 'error', message: 'Create failed: ' + error.message});
      return;
    }
    closeForm();
    navigate('/sheep/batches/' + id);
  }

  const planned = batches.filter((b) => (b.status || 'planned') !== 'complete');
  const completed = batches.filter((b) => b.status === 'complete');

  // Augment every batch with the per-batch derived fields the export column
  // builder + the filter/sort lib read (animal_count / weights / yield_pct).
  // ONE augmented array feeds filter → sort → render → record-seq nav → export
  // so the visible order and the exported order can never disagree.
  const augmentedBatches = useMemo(
    () =>
      batches.map((batch) => {
        const detailRows = Array.isArray(batch.sheep_detail) ? batch.sheep_detail : [];
        const totalLiveWeight = detailRows.reduce((sum, row) => sum + (parseFloat(row.live_weight) || 0), 0);
        const totalHangingWeight = detailRows.reduce((sum, row) => sum + (parseFloat(row.hanging_weight) || 0), 0);
        return {
          ...batch,
          animal_count: detailRows.length,
          total_live_weight: totalLiveWeight,
          total_hanging_weight: totalHangingWeight,
          yield_pct:
            totalLiveWeight > 0 && totalHangingWeight > 0 ? (totalHangingWeight / totalLiveWeight) * 100 : null,
        };
      }),
    [batches],
  );

  const effectiveFilters = EXTENDED_LIST_CONTROLS_ENABLED ? filters : {};
  const effectiveSortRule = EXTENDED_LIST_CONTROLS_ENABLED ? sortRule : {key: 'plannedDate', dir: 'desc'};

  const filteredBatches = useMemo(() => {
    const predicate = buildSheepBatchPredicate(effectiveFilters, {});
    return augmentedBatches.filter(predicate);
  }, [augmentedBatches, effectiveFilters]);

  const sortedBatches = useMemo(() => {
    const cmp = buildSheepBatchComparator(effectiveSortRule, {});
    return [...filteredBatches].sort(cmp);
  }, [filteredBatches, effectiveSortRule]);

  // The SORTED set is the single source of truth for the visible rows, the
  // record-sequence nav order, and the CSV/print export rows.
  const batchSeqRows = sortedBatches;
  const batchExportRows = sortedBatches;
  const exportColumns = buildProcessingBatchExportColumns({fmt, animalLabel: 'Sheep'});

  const activeFilterCount =
    (Array.isArray(effectiveFilters.status) && effectiveFilters.status.length > 0 ? 1 : 0) +
    (effectiveFilters.plannedDateRange &&
    (effectiveFilters.plannedDateRange.after || effectiveFilters.plannedDateRange.before)
      ? 1
      : 0) +
    (effectiveFilters.animalCountRange &&
    (effectiveFilters.animalCountRange.min != null || effectiveFilters.animalCountRange.max != null)
      ? 1
      : 0) +
    (typeof effectiveFilters.textSearch === 'string' && effectiveFilters.textSearch.trim() ? 1 : 0);
  const hasActiveFilters = activeFilterCount > 0;

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
  }
  function toggleStatusValue(value) {
    setFilters((prev) => {
      const cur = Array.isArray(prev.status) ? prev.status : [];
      const nextValues = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      const next = {...prev};
      if (nextValues.length === 0) delete next.status;
      else next.status = nextValues;
      return next;
    });
  }
  function setRangeBound(key, bound, value) {
    setFilters((prev) => {
      const cur = prev[key] && typeof prev[key] === 'object' ? {...prev[key]} : {};
      if (value === '' || value == null) delete cur[bound];
      else cur[bound] = value;
      const next = {...prev};
      if (!cur.min && cur.min !== 0 && !cur.max && cur.max !== 0 && !cur.after && !cur.before) delete next[key];
      else next[key] = cur;
      return next;
    });
  }
  function clearAllFilters() {
    setFilters({});
  }

  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );

  function sheepBatchesViewState() {
    return buildViewState({filters, sortRules: [{key: sortRule.key, dir: sortRule.dir}], viewMode: 'flat'});
  }
  function applySheepBatchSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    const rule = Array.isArray(st.sortRules) && st.sortRules[0] ? st.sortRules[0] : null;
    if (rule && SHEEP_BATCH_SORT_KEYS.includes(rule.key)) {
      setSortRule({key: rule.key, dir: rule.dir === 'desc' ? 'desc' : 'asc'});
    } else {
      setSortRule({key: 'plannedDate', dir: 'desc'});
    }
  }
  function onSelectSavedView(id) {
    setSelectedViewId(id);
    if (!id) return;
    applySheepBatchSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: SHEEP_BATCHES_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: sheepBatchesViewState(),
      });
      setShowSaveViewForm(false);
      await loadSavedViews();
      if (created?.id) setSelectedViewId(created.id);
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
      await updateSavedView(sb, selectedView.id, {viewState: sheepBatchesViewState()});
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
    }
  }

  function handleExportCsv() {
    if (!batchExportRows.length) {
      setNotice({kind: 'warning', message: 'No sheep processing batches to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('sheep-processing-batches'), rowsToCsv(exportColumns, batchExportRows));
    if (!ok) setNotice({kind: 'warning', message: 'CSV export is unavailable in this browser.'});
  }

  function handlePrintRows() {
    if (!batchExportRows.length) {
      setNotice({kind: 'warning', message: 'No sheep processing batches to print.'});
      return;
    }
    const ok = printRows({
      title: 'Sheep Processing Batches',
      subtitle: batchExportRows.length + ' filtered batches',
      columns: exportColumns,
      rows: batchExportRows,
    });
    if (!ok) setNotice({kind: 'warning', message: 'Print export is unavailable in this browser.'});
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: 'var(--ink-muted)', display: 'block', marginBottom: 3, fontWeight: 500};
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
  const savedViewPrimaryBtnS = {
    ...savedViewGhostBtnS,
    border: 'none',
    background: getProgramColor('sheep'),
    color: getReadableText(getProgramColor('sheep')),
  };
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
      data-sheep-batches-loaded={loading || loadError ? 'false' : 'true'}
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
        {!showForm && <InlineNotice notice={loadError} />}
        {!showForm && loadError && (
          <button
            type="button"
            data-sheep-batches-load-retry="1"
            onClick={loadAll}
            style={{
              padding: '7px 14px',
              borderRadius: 10,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
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
        {!showForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        <div
          style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}
          data-sheep-batches-root
        >
          <div style={{fontSize: 16, fontWeight: 700, color: 'var(--ink)'}}>
            Processing Batches{' '}
            <span style={{fontSize: 13, fontWeight: 400, color: 'var(--ink-muted)'}} data-sheep-batches-count>
              {sortedBatches.length} of {batches.length} · {planned.length} planned · {completed.length} complete
            </span>
          </div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end'}}>
            {EXTENDED_LIST_CONTROLS_ENABLED && (
              <>
                <button
                  type="button"
                  onClick={handleExportCsv}
                  data-sheep-batches-export-csv="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  onClick={handlePrintRows}
                  data-sheep-batches-print="1"
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
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
                style={{
                  padding: '7px 16px',
                  borderRadius: 10,
                  border: 'none',
                  background: getProgramColor('sheep'),
                  color: getReadableText(getProgramColor('sheep')),
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                + New Batch
              </button>
            )}
          </div>
        </div>

        {EXTENDED_LIST_CONTROLS_ENABLED && !loadError && !showForm && (
          <>
            {/* Saved views (surface_key sheep.batches) — degrades to a small
                notice on load failure; never blocks the list or filters. */}
            <div
              data-sheep-batches-saved-views-row
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
                <span style={{fontSize: 12, color: 'var(--danger)'}} data-sheep-batches-saved-views-error>
                  Saved views unavailable. Filters still work.
                </span>
              ) : (
                <>
                  <select
                    data-sheep-batches-saved-view-select
                    value={selectedViewId}
                    disabled={savedViewsLoading}
                    onChange={(e) => onSelectSavedView(e.target.value)}
                    style={{...inpS, width: 'auto', minWidth: 200, fontSize: 12, padding: '6px 10px'}}
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
                        data-sheep-batches-saved-view-update
                        onClick={updateSelectedView}
                        disabled={savedViewBusy}
                        style={savedViewGhostBtnS}
                      >
                        Update to current
                      </button>
                      <button
                        type="button"
                        data-sheep-batches-saved-view-delete
                        onClick={deleteSelectedView}
                        disabled={savedViewBusy}
                        style={{...savedViewGhostBtnS, color: 'var(--danger)', borderColor: 'var(--border)'}}
                      >
                        Delete
                      </button>
                    </>
                  )}
                  <span style={{flex: 1}} />
                  <button
                    type="button"
                    data-sheep-batches-saved-view-save-open
                    onClick={openSaveViewForm}
                    disabled={savedViewBusy}
                    style={savedViewPrimaryBtnS}
                  >
                    Save current view
                  </button>
                </>
              )}
            </div>

            {showSaveViewForm && (
              <div
                data-sheep-batches-saved-view-form
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
                  data-sheep-batches-saved-view-name
                  type="text"
                  value={saveViewName}
                  placeholder="View name"
                  onChange={(e) => setSaveViewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitSaveView();
                  }}
                  style={{...inpS, flex: 1, minWidth: 200}}
                />
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveSheepBatchViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-sheep-batches-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveSheepBatchViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-sheep-batches-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-sheep-batches-saved-view-save
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

            {/* Single toolbar row: search · status · planned-date range ·
                sheep-count range · sort + direction · clear. */}
            <div
              data-sheep-batches-toolbar
              style={{
                background: 'white',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '10px 14px',
                marginBottom: 10,
                display: 'flex',
                alignItems: 'flex-end',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{minWidth: 180, flex: 1}}>
                <label style={lbl}>Search</label>
                <input
                  type="text"
                  data-sheep-batches-search
                  value={filters.textSearch || ''}
                  placeholder="Batch name or ID"
                  onChange={(e) => setFilter('textSearch', e.target.value)}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Status</label>
                <div style={{display: 'flex', gap: 6}}>
                  {SHEEP_BATCH_STATUS_KEYS.map((s) => {
                    const on = Array.isArray(filters.status) && filters.status.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        data-sheep-batches-status-filter={s}
                        onClick={() => toggleStatusValue(s)}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 10,
                          border: '1px solid ' + (on ? getProgramColor('sheep') : 'var(--border-strong)'),
                          background: 'white',
                          color: on ? getProgramColor('sheep') : 'var(--ink-muted)',
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textTransform: 'capitalize',
                        }}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <label style={lbl}>Planned date</label>
                <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                  <input
                    type="date"
                    data-sheep-batches-planned-after
                    value={(filters.plannedDateRange && filters.plannedDateRange.after) || ''}
                    onChange={(e) => setRangeBound('plannedDateRange', 'after', e.target.value)}
                    style={{...inpS, width: 'auto'}}
                  />
                  <span style={{fontSize: 12, color: 'var(--ink-faint)'}}>to</span>
                  <input
                    type="date"
                    data-sheep-batches-planned-before
                    value={(filters.plannedDateRange && filters.plannedDateRange.before) || ''}
                    onChange={(e) => setRangeBound('plannedDateRange', 'before', e.target.value)}
                    style={{...inpS, width: 'auto'}}
                  />
                </div>
              </div>
              <div>
                <label style={lbl}>Sheep count</label>
                <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                  <input
                    type="number"
                    min="0"
                    data-sheep-batches-count-min
                    value={
                      filters.animalCountRange && filters.animalCountRange.min != null
                        ? filters.animalCountRange.min
                        : ''
                    }
                    placeholder="min"
                    onChange={(e) =>
                      setRangeBound(
                        'animalCountRange',
                        'min',
                        e.target.value === '' ? '' : parseInt(e.target.value, 10),
                      )
                    }
                    style={{...inpS, width: 70}}
                  />
                  <span style={{fontSize: 12, color: 'var(--ink-faint)'}}>to</span>
                  <input
                    type="number"
                    min="0"
                    data-sheep-batches-count-max
                    value={
                      filters.animalCountRange && filters.animalCountRange.max != null
                        ? filters.animalCountRange.max
                        : ''
                    }
                    placeholder="max"
                    onChange={(e) =>
                      setRangeBound(
                        'animalCountRange',
                        'max',
                        e.target.value === '' ? '' : parseInt(e.target.value, 10),
                      )
                    }
                    style={{...inpS, width: 70}}
                  />
                </div>
              </div>
              <div>
                <label style={lbl}>Sort</label>
                <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                  <select
                    data-sheep-batches-sort-key
                    value={sortRule.key}
                    onChange={(e) => setSortRule((prev) => ({...prev, key: e.target.value}))}
                    style={{...inpS, width: 'auto'}}
                  >
                    {SHEEP_BATCH_SORT_KEYS.map((k) => (
                      <option key={k} value={k}>
                        {SHEEP_BATCH_SORT_LABELS[k] || k}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    data-sheep-batches-sort-dir
                    onClick={() => setSortRule((prev) => ({...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc'}))}
                    title={sortRule.dir === 'asc' ? 'Ascending' : 'Descending'}
                    style={{
                      padding: '7px 12px',
                      borderRadius: 10,
                      border: '1px solid var(--border-strong)',
                      background: 'white',
                      color: 'var(--ink)',
                      fontSize: 13,
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {sortRule.dir === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
              </div>
              {hasActiveFilters && (
                <button
                  type="button"
                  data-sheep-batches-clear-filters
                  onClick={clearAllFilters}
                  style={{
                    padding: '7px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink-muted)',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Clear filters ({activeFilterCount})
                </button>
              )}
            </div>
          </>
        )}

        {loading && <div style={{textAlign: 'center', padding: '2rem', color: 'var(--ink-faint)'}}>Loading{'…'}</div>}

        {!loading && !loadError && batches.length === 0 && (
          <div
            data-sheep-batches-empty
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
            No processing batches yet. Click <strong>+ New Batch</strong> to plan one. Sheep enter this batch only via
            the Send-to-Processor flag on a sheep weigh-in entry.
          </div>
        )}

        {!loading && !loadError && batches.length > 0 && sortedBatches.length === 0 && (
          <div
            data-sheep-batches-no-match
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
            No sheep processing batches match the current filters.
          </div>
        )}

        {!loading && !loadError && sortedBatches.length > 0 && (
          <div
            data-sheep-batches-grid
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: SHEEP_BATCH_GRID_COLUMNS,
                gap: 10,
                alignItems: 'center',
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--surface-2)',
                fontSize: 10,
                fontWeight: 700,
                color: 'var(--ink-muted)',
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              <span>Batch</span>
              <span style={{justifySelf: 'start'}}>Status</span>
              <span>Sheep</span>
              <span>Planned</span>
              <span>Yield</span>
              <span style={{textAlign: 'right'}}>Open</span>
            </div>
            {sortedBatches.map((b) => (
              <BatchRow
                key={b.id}
                batch={b}
                fmt={fmt}
                onOpen={() =>
                  navigate('/sheep/batches/' + b.id, recordSeqNavOptions(labeledSeqItems(batchSeqRows, 'name')))
                }
              />
            ))}
          </div>
        )}
      </div>

      {showForm && form && (
        <div
          onClick={closeForm}
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
            data-sheep-new-batch-modal
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 480,
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
              <div style={{fontSize: 15, fontWeight: 600, color: 'var(--text-primary)'}}>New Processing Batch</div>
              <button
                type="button"
                onClick={closeForm}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--ink-faint)'}}
              >
                {'×'}
              </button>
            </div>
            <div style={{padding: '16px 20px'}}>
              <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({...form, name: e.target.value})}
                    data-sheep-new-batch-name
                    style={inpS}
                  />
                </div>
                <div>
                  <label style={lbl}>Status</label>
                  <select
                    value={form.status}
                    onChange={(e) => setForm({...form, status: e.target.value})}
                    data-sheep-new-batch-status
                    style={inpS}
                  >
                    <option value="planned">Planned</option>
                    <option value="complete">Complete</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>Planned Process Date</label>
                  <input
                    type="date"
                    value={form.planned_process_date}
                    onChange={(e) => setForm({...form, planned_process_date: e.target.value})}
                    data-sheep-new-batch-planned-date
                    style={inpS}
                  />
                </div>
              </div>
              <div
                style={{
                  marginTop: 12,
                  padding: '10px 12px',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  fontSize: 11,
                  color: 'var(--ink-muted)',
                }}
              >
                Sheep enter this batch only via the Send-to-Processor flag on a sheep weigh-in entry. Create the empty
                batch shell here; sheep attach themselves once they're flagged at the chute.
              </div>
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              <button
                type="button"
                onClick={saveNewBatch}
                disabled={creating}
                data-sheep-new-batch-save
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: creating ? 'var(--ink-faint)' : getProgramColor('sheep'),
                  color: getReadableText(getProgramColor('sheep')),
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Save & open
              </button>
              <button
                type="button"
                onClick={closeForm}
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

// Unified-grid nav-only row for one sheep processing batch (converted from the
// prior stacked card so all visible batches read as one aligned vertical
// inspection table — mirrors PigBatchHubTile). All prior data + the status
// badge + the click-to-open contract + the data attributes are preserved.
function BatchRow({batch, fmt, onOpen}) {
  const rows = Array.isArray(batch.sheep_detail) ? batch.sheep_detail : [];
  const totalLive = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const totalHang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  const yieldPct = totalLive > 0 && totalHang > 0 ? Math.round((totalHang / totalLive) * 1000) / 10 : null;
  const isComplete = batch.status === 'complete';
  return (
    <div
      data-batch-row={batch.id}
      data-batch-name={batch.name}
      data-batch-status={batch.status}
      {...openableProps(onOpen)}
      className="hoverable-tile"
      style={{
        display: 'grid',
        gridTemplateColumns: SHEEP_BATCH_GRID_COLUMNS,
        gap: 10,
        alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid var(--divider)',
        cursor: 'pointer',
        background: isComplete ? 'var(--surface-2)' : 'white',
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
        {batch.name}
      </span>

      {/* Status */}
      <span style={{justifySelf: 'start'}}>
        <Badge variant={isComplete ? 'ok' : 'warn'} style={{textTransform: 'uppercase'}}>
          {batch.status}
        </Badge>
      </span>

      {/* Sheep count */}
      <span style={{fontSize: 12, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums'}}>
        {rows.length > 0 ? <strong>{rows.length}</strong> : '—'}
      </span>

      {/* Planned / processed dates */}
      <span style={{fontSize: 11, color: 'var(--ink-muted)', display: 'flex', gap: 8, flexWrap: 'wrap'}}>
        {batch.planned_process_date ? <span>planned {fmt(batch.planned_process_date)}</span> : <span>—</span>}
        {batch.actual_process_date && (
          <span style={{color: 'var(--ok-ink)'}}>processed {fmt(batch.actual_process_date)}</span>
        )}
      </span>

      {/* Yield */}
      <span
        style={{
          fontSize: 12,
          color: yieldPct ? 'var(--text-primary)' : 'var(--ink-faint)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {yieldPct ? <strong>{yieldPct + '%'}</strong> : '—'}
      </span>

      {/* Open */}
      <span style={{fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right'}}>{'Open ->'}</span>
    </div>
  );
}

function SheepBatchesRouter(props) {
  const location = useLocation();
  const batchDetailId = location.pathname.startsWith('/sheep/batches/')
    ? location.pathname.slice('/sheep/batches/'.length) || null
    : null;
  if (batchDetailId) {
    return React.createElement(SheepBatchPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(SheepBatchesHub, props);
}

export default SheepBatchesRouter;
