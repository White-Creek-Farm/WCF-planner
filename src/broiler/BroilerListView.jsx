// ============================================================================
// src/broiler/BroilerListView.jsx — hub + router
// ----------------------------------------------------------------------------
// Hub is a navigation-only list of broiler batches. Row/card clicks navigate
// to /broiler/batches/<encoded name>, where BroilerBatchPage mounts BatchForm
// in embedded mode. Comments + collapsed Activity now live on the record
// page via RecordCollaborationSection. broiler.batch identity stays as
// batch.name to preserve the existing Activity entityId contract.
// ============================================================================
import React from 'react';
import {useNavigate, useLocation} from 'react-router-dom';
import {openableProps} from '../shared/openable.js';
import {sb} from '../lib/supabase.js';
import {recordActivityEvent} from '../lib/activityApi.js';
import {fmt, fmtS, todayISO} from '../lib/dateUtils.js';
import {S, getReadableText} from '../lib/styles.js';
import {getProgramColor} from '../lib/programColors.js';
import {
  calcTimeline,
  calcPoultryStatus,
  calcBroilerStatsFromDailys,
  getBatchColor,
  breedLabel,
  isNearHoliday,
} from '../lib/broiler.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DataTable from '../shared/DataTable.jsx';
import UsersModal from '../auth/UsersModal.jsx';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildBroilerBatchExportColumns} from '../lib/operationalExportColumns.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {
  BROILER_BATCH_STATUSES,
  buildBroilerBatchPredicate,
  buildBroilerBatchComparator,
  broilerBreedFilterOptions,
} from '../lib/broilerBatchFilters.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import BroilerBatchPage from './BroilerBatchPage.jsx';

const BROILER_BATCHES_SURFACE_KEY = 'broiler.batches';
const EXTENDED_LIST_CONTROLS_ENABLED = false;

// Sort dropdown options (single active sort rule). Mirrors the hub's sort keys
// from broilerBatchFilters.js as labeled key:dir pairs.
const BROILER_SORT_OPTIONS = [
  {value: 'batchName:asc', key: 'batchName', dir: 'asc', label: 'Name ↑'},
  {value: 'batchName:desc', key: 'batchName', dir: 'desc', label: 'Name ↓'},
  {value: 'status:asc', key: 'status', dir: 'asc', label: 'Status (planned first)'},
  {value: 'status:desc', key: 'status', dir: 'desc', label: 'Status (processed first)'},
  {value: 'startDate:asc', key: 'startDate', dir: 'asc', label: 'Hatch date (oldest)'},
  {value: 'startDate:desc', key: 'startDate', dir: 'desc', label: 'Hatch date (newest)'},
  {value: 'birdCount:desc', key: 'birdCount', dir: 'desc', label: 'Birds ↓'},
  {value: 'birdCount:asc', key: 'birdCount', dir: 'asc', label: 'Birds ↑'},
  {value: 'lbsProduced:desc', key: 'lbsProduced', dir: 'desc', label: 'Feed lbs ↓'},
  {value: 'lbsProduced:asc', key: 'lbsProduced', dir: 'asc', label: 'Feed lbs ↑'},
];

const BROILER_STATUS_LABELS = {planned: 'Planned', active: 'Active', processed: 'Processed'};

function broilerBatchHref(b) {
  return '/broiler/batches/' + encodeURIComponent(b && b.name ? b.name : '');
}

// Best-effort broiler.batch status.changed Activity (entity_id = batch.name —
// the broiler batch identity). Never blocks the status flip: try/catch +
// swallowed promise reject. Does not change the archive/reactivate behavior.
function recordBroilerStatusChange(b, from, to) {
  const name = b && b.name ? b.name : null;
  if (!name) return;
  try {
    recordActivityEvent(sb, {
      entityType: 'broiler.batch',
      entityId: name,
      eventType: 'status.changed',
      entityLabel: name,
      body: 'Broiler batch ' + name + ' status changed from ' + from + ' to ' + to,
      payload: {
        record: 'broiler.batch',
        name,
        breed: (b && b.breed) || null,
        hatchery: (b && b.hatchery) || null,
        changes: [{field: 'status', label: 'Status', from, to, old_present: !!from, new_present: !!to}],
      },
    }).catch(() => {});
  } catch (_e) {
    /* best-effort — never block the status flip */
  }
}

function BroilerListHub({Header, loadUsers, openAdd, openEdit, persist, del, confirmDelete, canDeleteAnything}) {
  const navigate = useNavigate();
  const {authState, dataLoaded, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {batches, setBatches} = useBatches();
  const {broilerDailys} = useDailysRecent();
  const {feedCosts} = useFeedCosts();
  const {setView, showAllComparison, setShowAllComparison} = useUI();

  const role = authState?.role;
  const isAdmin = role === 'admin';
  const isMgmt = role === 'management' || role === 'admin';
  const [listNotice, setListNotice] = React.useState(null);
  const myProfileId = authState?.user?.id || null;

  // Filter + single-rule sort state. Persisted per surface so a refresh keeps
  // the operator's last filter/sort. filters is an opaque dict consumed by
  // buildBroilerBatchPredicate; sortRules holds a single {key, dir} rule
  // (right-sized) but is stored as an array to match the saved-view contract.
  const [filters, setFilters] = usePersistentViewState('broiler.batches.filters', {});
  const [sortRules, setSortRules] = usePersistentViewState('broiler.batches.sortRules', [
    {key: 'batchName', dir: 'asc'},
  ]);
  const sortRule = sortRules[0] || {key: 'batchName', dir: 'asc'};

  // Saved views (broiler.batches surface). Failure degrades gracefully — the
  // list + filters keep working; only the saved-views row shows a notice.
  const [savedViews, setSavedViews] = React.useState([]);
  const [savedViewsError, setSavedViewsError] = React.useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = React.useState(true);
  const [selectedViewId, setSelectedViewId] = React.useState('');
  const [showSaveViewForm, setShowSaveViewForm] = React.useState(false);
  const [saveViewName, setSaveViewName] = React.useState('');
  const [saveViewVisibility, setSaveViewVisibility] = React.useState('private');
  const [savedViewBusy, setSavedViewBusy] = React.useState(false);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, BROILER_BATCHES_SURFACE_KEY);
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
  React.useEffect(() => {
    loadSavedViews();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Carry the visible order of the section the batch was clicked from into route
  // state so the record page can show prev/next. Sequence ids are batch ids;
  // labels are batch names (BroilerBatchPage resolves id -> current name).
  function openBatch(b, seqRows) {
    if (!b || !b.name) return;
    const opts = seqRows ? recordSeqNavOptions(labeledSeqItems(seqRows, 'name')) : undefined;
    navigate(broilerBatchHref(b), opts);
  }

  // Total feed lbs produced for a batch (daily-reports-aware, with the legacy
  // manual fallback). Single source for the export row, the "lbsProduced" sort
  // key (via ctx.totalFeedLbsOf), and the row Feed cell semantics.
  const totalFeedLbsFor = React.useCallback(
    (batch) => {
      const n = (value) => parseFloat(value) || 0;
      const stats = calcBroilerStatsFromDailys(batch, broilerDailys);
      const useManualFeedFallback = !stats.legacy && stats.starterFeed === 0 && stats.growerFeed === 0;
      const starterLbs = useManualFeedFallback ? n(batch.brooderFeedLbs) : stats.starterFeed;
      const growerLbs = useManualFeedFallback ? n(batch.schoonerFeedLbs) : stats.growerFeed;
      return starterLbs + growerLbs;
    },
    [broilerDailys],
  );

  // ── filter + sort across ALL batches ──────────────────────────────────────
  // Status is the EFFECTIVE poultry status so the filter agrees with the badge
  // each row renders. The filtered + sorted set is the single source for the
  // active table, the processed cards, the record-sequence order, and export.
  const filterCtx = React.useMemo(
    () => ({statusOf: (b) => calcPoultryStatus(b), totalFeedLbsOf: totalFeedLbsFor}),
    [totalFeedLbsFor],
  );
  const effectiveFilters = EXTENDED_LIST_CONTROLS_ENABLED ? filters : {};
  const effectiveSortRule = EXTENDED_LIST_CONTROLS_ENABLED ? sortRule : {key: 'batchName', dir: 'asc'};
  const filtered = React.useMemo(
    () => batches.filter(buildBroilerBatchPredicate(effectiveFilters, filterCtx)),
    [batches, effectiveFilters, filterCtx],
  );
  const sorted = React.useMemo(
    () => [...filtered].sort(buildBroilerBatchComparator(effectiveSortRule, filterCtx)),
    [filtered, effectiveSortRule, filterCtx],
  );

  // Section views derived from the SORTED set (broiler has a real planned →
  // active → processed pipeline, so the active table + processed cards stay,
  // but both now scan in the chosen sort order and respect the filters).
  const activeRows = sorted.filter((b) => b.status === 'planned' || b.status === 'active');
  const processedCardRows = sorted.filter((b) => b.status === 'processed');

  const observedBreeds = React.useMemo(() => [...new Set(batches.map((b) => b.breed).filter(Boolean))], [batches]);
  const breedFilterOptions = React.useMemo(
    () => broilerBreedFilterOptions(observedBreeds, breedLabel),
    [observedBreeds],
  );

  const totalCount = batches.length;
  const visibleCount = sorted.length;
  const filterCount = Object.keys(effectiveFilters).length;

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
  function clearAllFilters() {
    setFilters({});
  }
  function setStatusFilter(value) {
    if (!value) setFilter('status', null);
    else setFilter('status', [value]);
  }
  function setBreedFilter(value) {
    if (!value) setFilter('breed', null);
    else setFilter('breed', [value]);
  }
  function setStartDateBound(bound, value) {
    setFilters((prev) => {
      const range = {...(prev.startDateRange || {})};
      if (value) range[bound] = value;
      else delete range[bound];
      const next = {...prev};
      if (!range.after && !range.before) delete next.startDateRange;
      else next.startDateRange = range;
      return next;
    });
  }
  function setSortValue(value) {
    const opt = BROILER_SORT_OPTIONS.find((o) => o.value === value) || BROILER_SORT_OPTIONS[0];
    setSortRules([{key: opt.key, dir: opt.dir}]);
  }
  function flipSortDir() {
    setSortRules([{key: sortRule.key, dir: sortRule.dir === 'asc' ? 'desc' : 'asc'}]);
  }

  const search = filters.textSearch || '';
  const statusFilterValue = Array.isArray(filters.status) && filters.status.length === 1 ? filters.status[0] : '';
  const breedFilterValue = Array.isArray(filters.breed) && filters.breed.length === 1 ? filters.breed[0] : '';
  const startAfter = (filters.startDateRange && filters.startDateRange.after) || '';
  const startBefore = (filters.startDateRange && filters.startDateRange.before) || '';
  const sortValue =
    BROILER_SORT_OPTIONS.find((o) => o.key === sortRule.key && o.dir === sortRule.dir)?.value || 'batchName:asc';

  // ── saved views ────────────────────────────────────────────────────────────
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
  function broilerBatchesViewState() {
    return buildViewState({filters, sortRules, viewMode: 'grouped'});
  }
  function applyBroilerSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    setSortRules(
      Array.isArray(st.sortRules) && st.sortRules.length > 0 ? [st.sortRules[0]] : [{key: 'batchName', dir: 'asc'}],
    );
  }
  function onSelectSavedView(id) {
    setSelectedViewId(id);
    if (!id) return;
    applyBroilerSavedView(savedViews.find((v) => v.id === id));
  }
  function openSaveViewForm() {
    setSaveViewName('');
    setSaveViewVisibility('private');
    setShowSaveViewForm(true);
  }
  async function submitSaveView() {
    const name = saveViewName.trim();
    if (!name) {
      setListNotice({kind: 'error', message: 'Name the view before saving.'});
      return;
    }
    setSavedViewBusy(true);
    try {
      const created = await createSavedView(sb, {
        surfaceKey: BROILER_BATCHES_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: broilerBatchesViewState(),
      });
      setShowSaveViewForm(false);
      await loadSavedViews();
      if (created?.id) setSelectedViewId(created.id);
    } catch (e) {
      setListNotice({kind: 'error', message: 'Save view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  async function updateSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    setSavedViewBusy(true);
    try {
      await updateSavedView(sb, selectedView.id, {viewState: broilerBatchesViewState()});
      await loadSavedViews();
      setListNotice({
        kind: 'success',
        message: 'Updated "' + selectedView.name + '" to the current search/filter/sort.',
      });
    } catch (e) {
      setListNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
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
      setListNotice({kind: 'success', message: 'Deleted saved view "' + view.name + '".'});
    } catch (e) {
      setListNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
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
    if (confirmDelete) confirmDelete('Delete saved view "' + view.name + '"?', run);
    else void proceedDeleteSelectedView(view);
  }

  // ── export — fed the FILTERED + SORTED set (record-sequence order) ──────────
  const broilerExportRows = sorted.map((batch) => {
    const n = (value) => parseFloat(value) || 0;
    const stats = calcBroilerStatsFromDailys(batch, broilerDailys);
    const useManualFeedFallback = !stats.legacy && stats.starterFeed === 0 && stats.growerFeed === 0;
    const starterLbs = useManualFeedFallback ? n(batch.brooderFeedLbs) : stats.starterFeed;
    const growerLbs = useManualFeedFallback ? n(batch.schoonerFeedLbs) : stats.growerFeed;
    const totalFeed = starterLbs + growerLbs;
    const processed = n(batch.totalToProcessor);
    let timeOnFarm = '';
    if (batch.hatchDate && batch.processingDate) {
      const days = Math.round(
        (new Date(batch.processingDate + 'T12:00:00') - new Date(batch.hatchDate + 'T12:00:00')) / 86400000,
      );
      timeOnFarm = Math.floor(days / 7) + 'w ' + (days % 7) + 'd';
    }
    return {
      ...batch,
      export_status: calcPoultryStatus(batch),
      time_on_farm: timeOnFarm,
      export_mortality: stats.mortality,
      export_starter_lbs: starterLbs,
      export_grower_lbs: growerLbs,
      export_total_feed_lbs: totalFeed,
      export_feed_per_processed_bird: processed > 0 && totalFeed > 0 ? totalFeed / processed : null,
    };
  });
  const exportColumns = buildBroilerBatchExportColumns({fmt});

  function handleExportCsv() {
    if (!broilerExportRows.length) {
      setListNotice({kind: 'warning', message: 'No broiler batches to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('broiler-batches'), rowsToCsv(exportColumns, broilerExportRows));
    if (!ok) setListNotice({kind: 'warning', message: 'CSV export is unavailable in this browser.'});
  }

  function handlePrintRows() {
    if (!broilerExportRows.length) {
      setListNotice({kind: 'warning', message: 'No broiler batches to print.'});
      return;
    }
    const ok = printRows({
      title: 'Broiler Batches',
      subtitle: broilerExportRows.length + ' batches',
      columns: exportColumns,
      rows: broilerExportRows,
    });
    if (!ok) setListNotice({kind: 'warning', message: 'Print export is unavailable in this browser.'});
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #085041', color: '#085041'};
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
      <div style={{padding: '1rem'}} data-broiler-batches-loaded={dataLoaded ? 'true' : 'false'}>
        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginBottom: 10}}>
          {EXTENDED_LIST_CONTROLS_ENABLED && (
            <>
              <button
                type="button"
                onClick={handleExportCsv}
                data-broiler-batches-export-csv="1"
                style={{
                  padding: '7px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.1,
                }}
              >
                Export CSV
              </button>
              <button
                type="button"
                onClick={handlePrintRows}
                data-broiler-batches-print="1"
                style={{
                  padding: '7px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: 0.1,
                }}
              >
                Print
              </button>
            </>
          )}
          <button
            style={{
              padding: '7px 18px',
              borderRadius: 10,
              border: 'none',
              // WI-2d: broiler primary action re-tinted to the program accent.
              background: getProgramColor('broiler'),
              color: getReadableText(getProgramColor('broiler')),
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.1,
              display: isMgmt ? 'block' : 'none',
            }}
            onClick={openAdd}
          >
            + Add Batch
          </button>
        </div>
        <InlineNotice notice={listNotice} onDismiss={() => setListNotice(null)} />
        {/* Saved views row — degrades gracefully when the API fails */}
        {EXTENDED_LIST_CONTROLS_ENABLED && (
          <div
            data-broiler-saved-views-row
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
              <span style={{fontSize: 12, color: '#b91c1c'}} data-broiler-saved-views-error>
                Saved views unavailable. Filters still work.
              </span>
            ) : (
              <>
                <select
                  data-broiler-saved-view-select
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
                      data-broiler-saved-view-update
                      onClick={updateSelectedView}
                      disabled={savedViewBusy}
                      style={savedViewGhostBtnS}
                    >
                      Update to current
                    </button>
                    <button
                      type="button"
                      data-broiler-saved-view-delete
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
                  data-broiler-saved-view-save-open
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
        {EXTENDED_LIST_CONTROLS_ENABLED && showSaveViewForm && (
          <div
            data-broiler-saved-view-form
            style={{
              background: 'white',
              border: '1px solid #a7f3d0',
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
              data-broiler-saved-view-name
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
                name="saveBroilerViewVisibility"
                checked={saveViewVisibility === 'private'}
                onChange={() => setSaveViewVisibility('private')}
                data-broiler-saved-view-visibility="private"
              />
              Private
            </label>
            <label style={savedViewRadioLabelS}>
              <input
                type="radio"
                name="saveBroilerViewVisibility"
                checked={saveViewVisibility === 'public'}
                onChange={() => setSaveViewVisibility('public')}
                data-broiler-saved-view-visibility="public"
              />
              Public
            </label>
            <button
              type="button"
              data-broiler-saved-view-save
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
        {/* Top toolbar — search + status + breed + start-date range + sort */}
        {EXTENDED_LIST_CONTROLS_ENABLED && (
          <div
            data-broiler-batches-toolbar
            style={{
              background: 'white',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: '12px 16px',
              marginBottom: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
              <input
                type="text"
                value={search}
                onChange={(e) => setFilter('textSearch', e.target.value)}
                placeholder="Search batch name, breed, hatchery..."
                data-broiler-search
                style={{...inpS, flex: 1, minWidth: 200, width: '100%'}}
              />
              <select
                value={statusFilterValue}
                onChange={(e) => setStatusFilter(e.target.value)}
                data-broiler-status-filter
                style={{...inpS, width: 'auto'}}
              >
                <option value="">All statuses</option>
                {BROILER_BATCH_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {BROILER_STATUS_LABELS[s] || s}
                  </option>
                ))}
              </select>
              <select
                value={breedFilterValue}
                onChange={(e) => setBreedFilter(e.target.value)}
                data-broiler-breed-filter
                style={{...inpS, width: 'auto'}}
              >
                <option value="">All breeds</option>
                {breedFilterOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </select>
              <label
                style={{fontSize: 11, color: 'var(--ink-muted)', display: 'inline-flex', alignItems: 'center', gap: 4}}
              >
                Hatch after
                <input
                  type="date"
                  value={startAfter}
                  onChange={(e) => setStartDateBound('after', e.target.value)}
                  data-broiler-start-after
                  style={{...inpS, width: 'auto'}}
                />
              </label>
              <label
                style={{fontSize: 11, color: 'var(--ink-muted)', display: 'inline-flex', alignItems: 'center', gap: 4}}
              >
                before
                <input
                  type="date"
                  value={startBefore}
                  onChange={(e) => setStartDateBound('before', e.target.value)}
                  data-broiler-start-before
                  style={{...inpS, width: 'auto'}}
                />
              </label>
              <select
                value={sortValue}
                onChange={(e) => setSortValue(e.target.value)}
                data-broiler-sort
                style={{...inpS, width: 'auto'}}
              >
                {BROILER_SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={flipSortDir}
                data-broiler-sort-dir
                title="Flip sort direction"
                style={savedViewGhostBtnS}
              >
                {sortRule.dir === 'desc' ? '↓' : '↑'}
              </button>
              {filterCount > 0 && (
                <button type="button" onClick={clearAllFilters} data-broiler-clear-filters style={savedViewGhostBtnS}>
                  Clear filters
                </button>
              )}
            </div>
            <div style={{fontSize: 12, color: 'var(--ink-muted)'}} data-broiler-count>
              Showing {visibleCount} of {totalCount} batches
              {filterCount > 0 && ' - ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's')}
            </div>
          </div>
        )}
        <div style={{...S.card, overflowX: 'auto'}}>
          <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900}}>
            <thead>
              <tr style={{background: 'var(--surface-2)', borderBottom: '1px solid var(--border)'}}>
                {[
                  'Batch Name',
                  'Breed',
                  'Hatchery',
                  'Hatch Date',
                  'Birds',
                  'Mort.',
                  'Brooder',
                  'Schooner',
                  'Brooder Period',
                  'Schooner Period',
                  'Processing Date',
                  'Time on Farm',
                  'Feed',
                  'Status',
                  '',
                ].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: '8px 10px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: 'var(--ink-muted)',
                      whiteSpace: 'nowrap',
                      fontSize: 11,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activeRows.length === 0 && (
                <tr>
                  <td
                    colSpan={15}
                    style={{padding: '2.5rem', textAlign: 'center', color: 'var(--ink-faint)'}}
                    data-broiler-batches-empty={totalCount === 0 ? 'true' : 'filtered'}
                  >
                    {totalCount === 0
                      ? 'No batches yet — click "+ Add Batch" to get started'
                      : visibleCount === 0
                        ? 'No broiler batches match the current filters'
                        : filterCount > 0
                          ? 'No active or planned batches match the current filters'
                          : 'No active or planned batches — see processed below'}
                  </td>
                </tr>
              )}
              {activeRows.map((b, i) => {
                const C = getBatchColor(b.name);
                const autoSt = calcPoultryStatus(b);
                const hw = isNearHoliday(b.hatchDate);
                const pw = b.processingDate && isNearHoliday(b.processingDate);
                const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
                // Prefer stored brooderIn (hatchDate+1 per migration) over calcTimeline's (same as hatch)
                const brooderIn = b.brooderIn || (live ? live.brooderIn : null);
                const brooderOut = b.brooderOut || (live ? live.brooderOut : null);
                const schoonerIn = live ? live.schoonerIn : b.schoonerIn;
                const schoonerOut = live ? live.schoonerOut : b.schoonerOut;
                return (
                  <tr
                    key={b.id}
                    {...openableProps(() => openBatch(b, activeRows))}
                    className="hoverable-row"
                    style={{
                      borderBottom: '1px solid var(--border)',
                      background: i % 2 === 0 ? 'white' : '#fafafa',
                      cursor: 'pointer',
                    }}
                  >
                    <td style={{padding: '8px 10px', fontWeight: 600, whiteSpace: 'nowrap'}}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: 2 /* radius-allow: 10px legend swatch */,
                          background: C.bg,
                          marginRight: 6,
                          verticalAlign: 'middle',
                        }}
                      />
                      {b.name}
                    </td>
                    {/* Breed is a category, not a status badge → plain text (WI-2b/WI-4). */}
                    <td style={{padding: '8px 10px', color: 'var(--text-primary)', fontWeight: 600}}>{b.breed}</td>
                    <td style={{padding: '8px 10px', color: 'var(--ink-muted)', whiteSpace: 'nowrap'}}>{b.hatchery}</td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                      {fmt(b.hatchDate)}
                      {hw ? ' \u26a0' : ''}
                    </td>
                    <td style={{padding: '8px 10px'}}>{b.birdCount}</td>
                    <td
                      style={{
                        padding: '8px 10px',
                        // Mortality count is a genuine signal (WI-2a keep): danger when > 0.
                        color:
                          (b.mortalityCumulative || 0) > 0 ||
                          (!/^b-24-/i.test(b.name) &&
                            broilerDailys
                              .filter(
                                (d) =>
                                  (d.batch_label || '')
                                    .toLowerCase()
                                    .trim()
                                    .replace(/^\(processed\)\s*/, '')
                                    .trim() === b.name.toLowerCase().trim(),
                              )
                              .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0) > 0)
                            ? 'var(--danger)'
                            : 'var(--ink-faint)',
                        fontWeight: 600,
                      }}
                    >
                      {(() => {
                        if (/^b-24-/i.test(b.name)) return b.mortalityCumulative || 0;
                        return broilerDailys
                          .filter(
                            (d) =>
                              (d.batch_label || '')
                                .toLowerCase()
                                .trim()
                                .replace(/^\(processed\)\s*/, '')
                                .trim() === b.name.toLowerCase().trim(),
                          )
                          .reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
                      })()}
                    </td>
                    <td style={{padding: '8px 10px'}}>{b.brooder}</td>
                    {/* Schooner is a category, not a status → plain text (WI-4). */}
                    <td style={{padding: '8px 10px', color: 'var(--text-primary)'}}>{b.schooner}</td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--ink-muted)'}}>
                      {fmtS(brooderIn) + ' \u2192 ' + fmtS(brooderOut)}
                    </td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap', color: 'var(--ink-muted)'}}>
                      {fmtS(schoonerIn) + ' \u2192 ' + fmtS(schoonerOut)}
                    </td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                      {b.processingDate ? (
                        <span>
                          {fmt(b.processingDate)}
                          {pw ? ' ⚠' : ''}
                        </span>
                      ) : (
                        <span style={{color: 'var(--ink-faint)'}}>TBD</span>
                      )}
                    </td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                      {(() => {
                        if (!b.hatchDate || !b.processingDate)
                          return <span style={{color: 'var(--ink-faint)'}}>—</span>;
                        const days = Math.round(
                          (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                        );
                        const w = Math.floor(days / 7),
                          d = days % 7;
                        return (
                          <span style={{fontWeight: 500, color: 'var(--text-primary)'}}>
                            {w}w {d}d
                          </span>
                        );
                      })()}
                    </td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                      {(() => {
                        const isB24 = /^b-24-/i.test(b.name);
                        if (isB24) {
                          const total = (b.brooderFeedLbs || 0) + (b.schoonerFeedLbs || 0);
                          return total > 0 ? (
                            <span style={{color: 'var(--text-primary)', fontWeight: 600}}>
                              {total.toLocaleString()} lbs
                            </span>
                          ) : (
                            <span style={{color: 'var(--ink-faint)'}}>—</span>
                          );
                        }
                        const bd = broilerDailys.filter(
                          (d) =>
                            (d.batch_label || '')
                              .toLowerCase()
                              .trim()
                              .replace(/^\(processed\)\s*/, '')
                              .trim() === b.name.toLowerCase().trim(),
                        );
                        const total = bd.reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
                        if (bd.length === 0) return <span style={{color: 'var(--ink-faint)'}}>—</span>;
                        return (
                          <span style={{color: 'var(--text-primary)', fontWeight: 600}}>
                            {Math.round(total).toLocaleString()} lbs
                          </span>
                        );
                      })()}
                    </td>
                    {/* WI-4: lifecycle status → Badge. active→ok, planned→warn, processed→neutral. */}
                    <td style={{padding: '8px 10px'}}>
                      <Badge variant={autoSt === 'active' ? 'ok' : autoSt === 'planned' ? 'warn' : 'neutral'}>
                        {autoSt}
                      </Badge>
                    </td>
                    <td style={{padding: '8px 10px', whiteSpace: 'nowrap'}}>
                      {isMgmt && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const nb = batches.map((x) => (x.id === b.id ? {...x, status: 'processed'} : x));
                            setBatches(nb);
                            persist(nb);
                            recordBroilerStatusChange(b, b.status || 'active', 'processed');
                          }}
                          style={{
                            fontSize: 11,
                            color: 'var(--ink-muted)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            marginRight: 8,
                          }}
                        >
                          Archive
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (canDeleteAnything(authState?.role)) {
                              setListNotice(null);
                              del(b.id);
                            } else {
                              setListNotice({kind: 'error', message: 'Only admins can delete batches.'});
                            }
                          }}
                          style={{
                            fontSize: 11,
                            color: 'var(--danger)',
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                          }}
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Batch Comparison Table ── */}
        {(() => {
          const completedBatches = batches
            .filter((b) => b.status === 'processed')
            .sort((a, b) => {
              const da = a.processingDate || '';
              const db = b.processingDate || '';
              return da < db ? 1 : da > db ? -1 : 0;
            });
          const displayed = showAllComparison ? completedBatches : completedBatches.slice(0, 10);
          if (completedBatches.length === 0) return null;
          return (
            <div style={{marginTop: 24}}>
              <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8}}>
                <div style={{fontSize: 13, fontWeight: 700, color: 'var(--ink)', letterSpacing: 0.3}}>
                  BATCH COMPARISON
                </div>
                {completedBatches.length > 10 && (
                  <button
                    onClick={() => setShowAllComparison((v) => !v)}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--text-primary)',
                      background: 'none',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: '3px 10px',
                      cursor: 'pointer',
                    }}
                  >
                    {showAllComparison ? 'Show Last 10' : 'Show All ' + completedBatches.length}
                  </button>
                )}
              </div>
              <div style={{...S.card, overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 1100}}>
                  <thead>
                    <tr style={{background: 'var(--surface-2)', borderBottom: '1px solid var(--border)'}}>
                      {[
                        'Batch',
                        'Breed',
                        'Hatchery',
                        'Time on Farm',
                        'Schooner',
                        'Birds Arrived',
                        '4 Wk Lbs',
                        '6 Wk Lbs',
                        'Feed / Bird',
                        'Starter Feed',
                        'Grower Feed',
                        'Total Feed',
                        '# Processed',
                        'Avg Breast',
                        'Avg Thigh',
                        'Avg Dressed',
                        '',
                      ].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '7px 10px',
                            textAlign: 'left',
                            fontWeight: 600,
                            color: 'var(--ink)',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayed.map((b, i) => {
                      const n = (v) => parseFloat(v) || 0;
                      // Daily-reports-aware feed totals: B-24 uses legacy manual fields,
                      // B-25+ pulls from broilerDailys (matches dashboard's batchFeed helper)
                      const isB24 = /^b-24-/i.test(b.name);
                      let starter, grower;
                      if (isB24) {
                        starter = n(b.brooderFeedLbs);
                        grower = n(b.schoonerFeedLbs);
                      } else {
                        const bd = broilerDailys.filter(
                          (d) =>
                            (d.batch_label || '')
                              .toLowerCase()
                              .trim()
                              .replace(/^\(processed\)\s*/, '')
                              .trim() === b.name.toLowerCase().trim(),
                        );
                        starter = Math.round(
                          bd
                            .filter((d) => d.feed_type === 'STARTER')
                            .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
                        );
                        grower = Math.round(
                          bd
                            .filter((d) => d.feed_type === 'GROWER')
                            .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0),
                        );
                        // Fall back to manual fields if no daily reports found
                        if (starter === 0 && grower === 0) {
                          starter = n(b.brooderFeedLbs);
                          grower = n(b.schoonerFeedLbs);
                        }
                      }
                      const totalFeed = starter + grower;
                      const processed = n(b.totalToProcessor);
                      const feedPerBird = processed > 0 && totalFeed > 0 ? (totalFeed / processed).toFixed(1) : null;
                      const sch = (b.schooner || '').toString().trim();
                      const timeOnFarm = (() => {
                        if (!b.hatchDate || !b.processingDate) return null;
                        const days = Math.round(
                          (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                        );
                        return `${Math.floor(days / 7)}w ${days % 7}d`;
                      })();
                      // WI-2a: all comparison cells are raw metrics → black ink.
                      const cell = (v, opts = {}) => {
                        const {bold} = opts;
                        return (
                          <td
                            key={Math.random()}
                            style={{
                              padding: '7px 10px',
                              whiteSpace: 'nowrap',
                              color: v ? 'var(--ink)' : 'var(--ink-faint)',
                              fontWeight: bold || v ? 600 : 400,
                            }}
                          >
                            {v || '—'}
                          </td>
                        );
                      };
                      return (
                        <tr
                          key={b.id}
                          {...openableProps(() => openBatch(b, displayed))}
                          style={{
                            borderBottom: '1px solid var(--border)',
                            background: i % 2 === 0 ? 'white' : '#fafafa',
                            cursor: 'pointer',
                          }}
                          className="hoverable-row"
                        >
                          <td style={{padding: '7px 10px', fontWeight: 700, whiteSpace: 'nowrap', color: 'var(--ink)'}}>
                            {b.name}
                          </td>
                          {/* Breed is a category, not a status badge → plain text (WI-2b/WI-4). */}
                          <td style={{padding: '7px 10px'}}>
                            {b.breed ? (
                              <span style={{color: 'var(--text-primary)', fontWeight: 600}}>{b.breed}</span>
                            ) : (
                              <span style={{color: 'var(--ink-faint)'}}>—</span>
                            )}
                          </td>
                          {cell(b.hatchery || null)}
                          {cell(timeOnFarm)}
                          {/* Schooner is a category, not a status \u2192 plain text (WI-4). */}
                          <td style={{padding: '7px 10px'}}>
                            {sch ? (
                              <span style={{fontSize: 11, fontWeight: 600, color: 'var(--text-primary)'}}>{sch}</span>
                            ) : (
                              <span style={{color: 'var(--ink-faint)'}}>{'\u2014'}</span>
                            )}
                          </td>
                          {cell(b.birdCountActual ? parseInt(b.birdCountActual).toLocaleString() : null)}
                          {cell(n(b.week4Lbs) > 0 ? `${n(b.week4Lbs)} lbs` : null)}
                          {cell(n(b.week6Lbs) > 0 ? `${n(b.week6Lbs)} lbs` : null)}
                          {cell(feedPerBird ? `${feedPerBird} lbs` : null)}
                          {cell(starter > 0 ? `${Math.round(starter).toLocaleString()} lbs` : null)}
                          {cell(grower > 0 ? `${Math.round(grower).toLocaleString()} lbs` : null)}
                          {cell(totalFeed > 0 ? `${Math.round(totalFeed).toLocaleString()} lbs` : null, {bold: true})}
                          {cell(processed > 0 ? processed.toLocaleString() : null)}
                          {cell(n(b.avgBreastLbs) > 0 ? `${n(b.avgBreastLbs)} lbs` : null)}
                          {cell(n(b.avgThighsLbs) > 0 ? `${n(b.avgThighsLbs)} lbs` : null)}
                          {cell(n(b.avgDressedLbs) > 0 ? `${n(b.avgDressedLbs)} lbs` : null)}
                          {isAdmin && (
                            <td style={{padding: '7px 10px', whiteSpace: 'nowrap'}}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  del(b.id);
                                }}
                                style={{
                                  fontSize: 11,
                                  color: 'var(--danger)',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  fontFamily: 'inherit',
                                }}
                              >
                                Delete
                              </button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!showAllComparison && completedBatches.length > 10 && (
                <div style={{textAlign: 'center', fontSize: 11, color: 'var(--ink-faint)', marginTop: 6}}>
                  {completedBatches.length - 10} more batches hidden — click "Show All" to expand
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Processed batches ──
            CP0 WI-3 / F014: the former card-per-row PROCESSED block (bordered
            cards with cream sub-panels + stat-soup + multiple chips) is now the
            canonical shared <DataTable> — one clean table for the repeated
            records. Numbers are black (DataTable's is-num cells), status is a
            single neutral <Badge>, borders are the DataTable hairlines.
            onRowOpen reuses the exact same openBatch() drill-in the cards used,
            so the record-page route + prev/next sequence is unchanged. Per-card
            feed/grit/cost breakdown, weigh-in weights, and birds-arrived remain
            on the batch RECORD page (the drill-in) — no data is lost. */}
        {processedCardRows.length > 0 &&
          (() => {
            // Per-batch derived stats (same source logic as the prior cards):
            // B-24-* uses manually entered feed totals; B-25+ pulls daily reports.
            const statsFor = (b) => {
              const isB24 = /^b-24-/i.test(b.name);
              const bd = broilerDailys.filter(
                (d) =>
                  (d.batch_label || '')
                    .toLowerCase()
                    .trim()
                    .replace(/^\(processed\)\s*/, '')
                    .trim() === b.name.toLowerCase().trim(),
              );
              const dailyStarterLbs = bd
                .filter((d) => d.feed_type === 'STARTER')
                .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
              const dailyGrowerLbs = bd
                .filter((d) => d.feed_type === 'GROWER')
                .reduce((s, d) => s + (parseFloat(d.feed_lbs) || 0), 0);
              const dailyGritLbs = bd.reduce((s, d) => s + (parseFloat(d.grit_lbs) || 0), 0);
              const dailyMortality = bd.reduce((s, d) => s + (parseInt(d.mortality_count) || 0), 0);
              const starterLbs = isB24 ? b.brooderFeedLbs || 0 : dailyStarterLbs;
              const growerLbs = isB24 ? b.schoonerFeedLbs || 0 : dailyGrowerLbs;
              const gritLbs = isB24 ? b.gritLbs || 0 : dailyGritLbs;
              const mortality = isB24 ? b.mortalityCumulative || 0 : dailyMortality;
              const totalFeed = starterLbs + growerLbs;
              const feedCost = starterLbs * (b.perLbStarterCost || 0) + growerLbs * (b.perLbStandardCost || 0);
              const gritCost = gritLbs * (b.perLbGritCost || 0);
              const chickCost = parseFloat(b.chickCost) || 0;
              const totalCost = feedCost + gritCost + (b.processingCost || 0) + chickCost;
              const perBird = b.totalToProcessor > 0 ? totalCost / b.totalToProcessor : 0;
              const mortalityPct = b.birdCount > 0 ? ((mortality / b.birdCount) * 100).toFixed(1) : '0';
              const tofDays =
                b.hatchDate && b.processingDate
                  ? Math.round(
                      (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                    )
                  : null;
              const timeOnFarm = tofDays != null ? `${Math.floor(tofDays / 7)}w ${tofDays % 7}d` : null;
              return {totalFeed, mortality, mortalityPct, totalCost, perBird, timeOnFarm};
            };

            const processedColumns = [
              {
                key: 'name',
                label: 'Batch',
                primary: true,
                render: (b) => {
                  const C = getBatchColor(b.name);
                  return (
                    <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          borderRadius: 2 /* radius-allow: 10px legend swatch */,
                          background: C.bg,
                          verticalAlign: 'middle',
                        }}
                      />
                      {b.name}
                    </span>
                  );
                },
              },
              // Breed + schooner are categories, not status -> plain text (WI-2b/WI-4).
              {
                key: 'breed',
                label: 'Breed',
                render: (b) => <StatusText tone="muted">{b.breed ? breedLabel(b.breed) : '—'}</StatusText>,
              },
              {
                key: 'hatchery',
                label: 'Hatchery',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{b.hatchery || '—'}</StatusText>,
              },
              {
                key: 'processingDate',
                label: 'Process Date',
                render: (b) => <StatusText tone="muted">{b.processingDate ? fmt(b.processingDate) : '—'}</StatusText>,
              },
              {
                key: 'timeOnFarm',
                label: 'Time on Farm',
                mobilePriority: false,
                render: (b) => {
                  const {timeOnFarm} = statsFor(b);
                  return <StatusText tone="muted">{timeOnFarm || '—'}</StatusText>;
                },
              },
              {
                key: 'birdCount',
                label: 'Birds',
                align: 'right',
                render: (b) => (b.birdCount || 0).toLocaleString(),
              },
              {
                key: 'toProcessor',
                label: 'To Processor',
                align: 'right',
                render: (b) => (b.totalToProcessor || 0).toLocaleString(),
              },
              {
                key: 'mortality',
                label: 'Mortality',
                align: 'right',
                render: (b) => {
                  const {mortality, mortalityPct} = statsFor(b);
                  const label = `${mortality} (${mortalityPct}%)`;
                  // Mortality over threshold keeps a danger signal (WI-2a); else black.
                  return mortality > 20 ? <StatusText tone="danger">{label}</StatusText> : label;
                },
              },
              {
                key: 'totalFeed',
                label: 'Total Feed',
                align: 'right',
                render: (b) => {
                  const {totalFeed} = statsFor(b);
                  return totalFeed > 0 ? `${Math.round(totalFeed).toLocaleString()} lbs` : '—';
                },
              },
              {
                key: 'perBird',
                label: 'Per Bird Cost',
                align: 'right',
                mobilePriority: false,
                render: (b) => {
                  const {perBird} = statsFor(b);
                  return perBird > 0 ? `$${perBird.toFixed(2)}` : '—';
                },
              },
              {
                key: 'status',
                label: 'Status',
                render: () => <Badge variant="neutral">processed</Badge>,
              },
              {
                key: 'actions',
                label: '',
                mobilePriority: false,
                render: (b) => (
                  <span style={{display: 'inline-flex', gap: 8, whiteSpace: 'nowrap'}}>
                    {isMgmt && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const nb = batches.map((x) => {
                            if (x.id !== b.id) return x;
                            const upd = {...x, status: 'active'};
                            // Stamp current admin rates if missing (e.g. reactivating a blank batch)
                            if (!upd.perLbStarterCost || !upd.perLbStandardCost) {
                              upd.perLbStarterCost = feedCosts.starter || 0;
                              upd.perLbStandardCost = feedCosts.grower || 0;
                              upd.perLbGritCost = feedCosts.grit || 0;
                            }
                            return upd;
                          });
                          setBatches(nb);
                          persist(nb);
                          recordBroilerStatusChange(b, b.status || 'processed', 'active');
                        }}
                        style={{
                          fontSize: 11,
                          color: 'var(--text-primary)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Reactivate
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          confirmDelete('Delete this batch? This cannot be undone.', () => del(b.id));
                        }}
                        style={{
                          fontSize: 11,
                          color: 'var(--danger)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                ),
              },
            ];

            return (
              <div style={{marginTop: 20}}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--ink-faint)',
                    marginBottom: 8,
                    letterSpacing: 0.3,
                  }}
                >
                  PROCESSED ({processedCardRows.length})
                </div>
                <div style={{...S.card, overflowX: 'auto'}}>
                  <DataTable
                    surfaceKey="broiler-processed"
                    rows={processedCardRows}
                    rowKey="id"
                    density="compact"
                    columns={processedColumns}
                    onRowOpen={(b) => openBatch(b, processedCardRows)}
                  />
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

function BroilerListRouter(props) {
  const location = useLocation();
  if (location.pathname.startsWith('/broiler/batches/')) {
    return React.createElement(BroilerBatchPage, props);
  }
  return React.createElement(BroilerListHub, props);
}

export default BroilerListRouter;
