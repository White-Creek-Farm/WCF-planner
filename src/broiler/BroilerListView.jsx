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
  BROILER_BATCH_DEFAULT_SORT,
  buildBroilerBatchPredicate,
  buildBroilerBatchComparator,
  broilerBreedFilterOptions,
  broilerDistinctFieldValues,
} from '../lib/broilerBatchFilters.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import BroilerBatchPage from './BroilerBatchPage.jsx';

const BROILER_BATCHES_SURFACE_KEY = 'broiler.batches';

// Sort dropdown options (single active sort rule). Mirrors the hub's sort keys
// from broilerBatchFilters.js as labeled key:dir pairs. Default is processed
// newest-first (processing date descending).
const BROILER_SORT_OPTIONS = [
  {value: 'processingDate:desc', key: 'processingDate', dir: 'desc', label: 'Processed date (newest)'},
  {value: 'processingDate:asc', key: 'processingDate', dir: 'asc', label: 'Processed date (oldest)'},
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

// Toggleable data columns for the processed-batches table (the column picker).
// `name` (Batch) and the row actions are always shown; these are the columns the
// operator can hide/show, and the choice is stored in saved views.
const BROILER_PROCESSED_COLUMNS = [
  {key: 'breed', label: 'Breed', default: true},
  {key: 'hatchery', label: 'Hatchery', default: true},
  {key: 'brooder', label: 'Brooder', default: false},
  {key: 'schooner', label: 'Schooner', default: false},
  {key: 'hatchDate', label: 'Hatch Date', default: false},
  {key: 'brooderPeriod', label: 'Brooder Period', default: false},
  {key: 'schoonerPeriod', label: 'Schooner Period', default: false},
  {key: 'processingDate', label: 'Process Date', default: true},
  {key: 'timeOnFarm', label: 'Time on Farm', default: true},
  {key: 'birdCount', label: 'Birds Ordered', default: true},
  {key: 'birdsArrived', label: 'Birds Arrived', default: false},
  {key: 'toProcessor', label: 'To Processor', default: true},
  {key: 'mortality', label: 'Mortality', default: true},
  {key: 'mortalityPct', label: 'Mortality %', default: false},
  {key: 'chickCost', label: 'Chick Cost', default: false},
  {key: 'starterFeed', label: 'Starter Feed', default: false},
  {key: 'growerFeed', label: 'Grower Feed', default: false},
  {key: 'totalFeed', label: 'Total Feed', default: true},
  {key: 'feedPerBird', label: 'Feed / Bird', default: false},
  {key: 'week4Lbs', label: '4-wk Wt', default: false},
  {key: 'week6Lbs', label: '6-wk Wt', default: false},
  {key: 'avgBreast', label: 'Avg Breast', default: false},
  {key: 'avgThigh', label: 'Avg Thigh', default: false},
  {key: 'avgDressed', label: 'Avg Whole', default: false},
  {key: 'totalMeat', label: 'Total Meat', default: false},
  {key: 'processingCost', label: 'Processing Cost', default: false},
  {key: 'processingPerBird', label: 'Processing / Bird', default: false},
  {key: 'totalCost', label: 'Total Cost', default: false},
  {key: 'perBird', label: 'Cost / Bird', default: true},
  {key: 'status', label: 'Status', default: true},
];
const BROILER_DEFAULT_COLUMN_KEYS = BROILER_PROCESSED_COLUMNS.filter((c) => c.default).map((c) => c.key);

// CSV/print export header -> the display column key that controls it. An export
// column whose controlling column is hidden is dropped, so the export matches
// the columns currently shown in the processed table. Columns with no export
// counterpart simply don't gate any export column.
const BROILER_EXPORT_HEADER_COLUMN = {
  Batch: 'name',
  'Record ID': 'name',
  Status: 'status',
  Breed: 'breed',
  Hatchery: 'hatchery',
  Schooner: 'schooner',
  'Hatch date': 'hatchDate',
  'Processing date': 'processingDate',
  'Time on farm': 'timeOnFarm',
  'Birds ordered': 'birdCount',
  'Birds arrived': 'birdsArrived',
  'To processor': 'toProcessor',
  Mortality: 'mortality',
  'Starter feed lbs': 'starterFeed',
  'Grower feed lbs': 'growerFeed',
  'Total feed lbs': 'totalFeed',
  'Feed per processed bird': 'feedPerBird',
  'Avg dressed lbs': 'avgDressed',
};

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
    {...BROILER_BATCH_DEFAULT_SORT},
  ]);
  const sortRule = sortRules[0] || {...BROILER_BATCH_DEFAULT_SORT};

  // Compact icon-panel toolbar (Cattle Herds parity): one tool panel open at a
  // time — 'savedViews' | 'filters' | 'sort' | null.
  const [openToolPanel, setOpenToolPanel] = React.useState(null);
  function toggleToolPanel(panel) {
    setOpenToolPanel((cur) => (cur === panel ? null : panel));
  }

  // Which processed-table columns are shown (the column/display picker). Persisted
  // per surface and stored in saved views. `name` + row actions are always shown.
  const [visibleColumns, setVisibleColumns] = usePersistentViewState(
    'broiler.batches.columns',
    BROILER_DEFAULT_COLUMN_KEYS,
  );
  function toggleColumn(key) {
    setVisibleColumns((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }
  const columnVisible = (key) => key === 'name' || key === 'actions' || visibleColumns.includes(key);

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

  // ── filter + sort scope ───────────────────────────────────────────────────
  // The search/filter/sort + column controls drive the PROCESSED history table
  // ONLY. Active/planned batches stay pinned on top in a stable name order,
  // untouched by the controls. Status is the EFFECTIVE poultry status so the
  // filter agrees with the badge each row renders.
  const filterCtx = React.useMemo(
    () => ({statusOf: (b) => calcPoultryStatus(b), totalFeedLbsOf: totalFeedLbsFor}),
    [totalFeedLbsFor],
  );
  const activeRows = React.useMemo(
    () =>
      batches
        .filter((b) => b.status === 'planned' || b.status === 'active')
        .sort(buildBroilerBatchComparator({key: 'batchName', dir: 'asc'}, filterCtx)),
    [batches, filterCtx],
  );
  const processedBatches = React.useMemo(() => batches.filter((b) => b.status === 'processed'), [batches]);
  const filtered = React.useMemo(
    () => processedBatches.filter(buildBroilerBatchPredicate(filters, filterCtx)),
    [processedBatches, filters, filterCtx],
  );
  const processedCardRows = React.useMemo(
    () => [...filtered].sort(buildBroilerBatchComparator(sortRule, filterCtx)),
    [filtered, sortRule, filterCtx],
  );

  const observedBreeds = React.useMemo(
    () => [...new Set(processedBatches.map((b) => b.breed).filter(Boolean))],
    [processedBatches],
  );
  const breedFilterOptions = React.useMemo(
    () => broilerBreedFilterOptions(observedBreeds, breedLabel),
    [observedBreeds],
  );

  const totalCount = batches.length;
  const processedTotal = processedBatches.length;
  const visibleCount = processedCardRows.length;
  const filterCount = Object.keys(filters).length;

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
  // Single-select multi-value filter (status/breed/hatchery/brooder/schooner):
  // stored as a one-element array so the predicate's array matcher applies.
  function setSelectFilter(key, value) {
    setFilter(key, value ? [value] : null);
  }
  function selectFilterValue(key) {
    return Array.isArray(filters[key]) && filters[key].length === 1 ? filters[key][0] : '';
  }
  // Date-range bound setter for any *DateRange filter (startDateRange / processingDateRange).
  function setDateBound(rangeKey, bound, value) {
    setFilters((prev) => {
      const range = {...(prev[rangeKey] || {})};
      if (value) range[bound] = value;
      else delete range[bound];
      const next = {...prev};
      if (!range.after && !range.before) delete next[rangeKey];
      else next[rangeKey] = range;
      return next;
    });
  }
  // Numeric-range bound setter for any *Range filter (birdCountRange, etc.).
  function setNumBound(rangeKey, bound, value) {
    setFilters((prev) => {
      const range = {...(prev[rangeKey] || {})};
      if (value !== '' && value != null) range[bound] = value;
      else delete range[bound];
      const next = {...prev};
      if ((range.min == null || range.min === '') && (range.max == null || range.max === '')) delete next[rangeKey];
      else next[rangeKey] = range;
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
  const dateBound = (rangeKey, bound) => (filters[rangeKey] && filters[rangeKey][bound]) || '';
  const numBound = (rangeKey, bound) => {
    const v = filters[rangeKey] && filters[rangeKey][bound];
    return v == null ? '' : v;
  };
  const sortValue =
    BROILER_SORT_OPTIONS.find((o) => o.key === sortRule.key && o.dir === sortRule.dir)?.value || 'processingDate:desc';

  const hatcheryOptions = React.useMemo(
    () => broilerDistinctFieldValues(processedBatches, 'hatchery'),
    [processedBatches],
  );
  const brooderOptions = React.useMemo(
    () => broilerDistinctFieldValues(processedBatches, 'brooder'),
    [processedBatches],
  );
  const schoonerOptions = React.useMemo(
    () => broilerDistinctFieldValues(processedBatches, 'schooner'),
    [processedBatches],
  );

  // ── saved views ────────────────────────────────────────────────────────────
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
  function broilerBatchesViewState() {
    return {...buildViewState({filters, sortRules, viewMode: 'grouped'}), columns: visibleColumns};
  }
  function applyBroilerSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    setSortRules(
      Array.isArray(st.sortRules) && st.sortRules.length > 0 ? [st.sortRules[0]] : [{...BROILER_BATCH_DEFAULT_SORT}],
    );
    setVisibleColumns(Array.isArray(st.columns) && st.columns.length > 0 ? st.columns : BROILER_DEFAULT_COLUMN_KEYS);
    setOpenToolPanel(null);
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

  // ── export — the processed table's filtered + sorted rows, and only the
  // columns currently shown (the column picker drives the export too). ─────────
  const broilerExportRows = processedCardRows.map((batch) => {
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
  const exportColumns = buildBroilerBatchExportColumns({fmt}).filter((c) => {
    const key = BROILER_EXPORT_HEADER_COLUMN[c.header];
    return key ? columnVisible(key) : true;
  });

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
  // Compact icon button + tool panel (Cattle Herds parity).
  const BROILER_ACCENT = getProgramColor('broiler');
  // Selected tool button = solid program-amber fill with a white glyph (matches
  // the filled program tab in the top nav); unselected = white with dark glyph.
  const toolButtonS = (active = false) => ({
    width: 34,
    height: 34,
    borderRadius: 10,
    border: active ? `1px solid ${BROILER_ACCENT}` : '1px solid var(--border-strong)',
    background: active ? BROILER_ACCENT : 'white',
    color: active ? '#fff' : 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    flex: '0 0 auto',
  });
  const toolPanelS = {
    background: 'white',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '12px 16px',
    marginBottom: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  };
  const filterLabelS = {
    fontSize: 11,
    color: 'var(--ink-muted)',
    display: 'inline-flex',
    flexDirection: 'column',
    gap: 3,
    fontWeight: 600,
  };
  const numInpS = {...inpS, width: 84};

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
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink-faint)',
            marginBottom: 8,
            letterSpacing: 0.3,
          }}
        >
          ACTIVE / PLANNED ({activeRows.length})
        </div>
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
                  <td colSpan={15} style={{padding: '2.5rem', textAlign: 'center', color: 'var(--ink-faint)'}}>
                    {totalCount === 0
                      ? 'No batches yet — click "+ Add Batch" to get started'
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
        <div
          style={{
            marginTop: 26,
            paddingTop: 16,
            borderTop: '2px solid var(--border)',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--ink)',
            letterSpacing: 0.3,
            marginBottom: 10,
          }}
        >
          PROCESSED BATCHES
        </div>
        {/* Compact icon-panel toolbar — Cattle Herds parity (controls the processed table below) */}
        <div
          data-broiler-batches-toolbar
          style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8}}
        >
          <input
            type="text"
            value={search}
            onChange={(e) => setFilter('textSearch', e.target.value)}
            placeholder="Search batch name, breed, hatchery..."
            data-broiler-search
            aria-label="Search broiler batches"
            style={{...inpS, flex: 1, minWidth: 180}}
          />
          <button
            type="button"
            data-broiler-batches-saved-views-toggle="1"
            aria-label="Saved views"
            title="Saved views"
            aria-expanded={openToolPanel === 'savedViews'}
            onClick={() => toggleToolPanel('savedViews')}
            style={toolButtonS(openToolPanel === 'savedViews')}
          >
            ☆
          </button>
          <button
            type="button"
            data-broiler-batches-filters-toggle="1"
            aria-label="Filters"
            title="Filters"
            aria-expanded={openToolPanel === 'filters'}
            onClick={() => toggleToolPanel('filters')}
            style={toolButtonS(openToolPanel === 'filters')}
          >
            {filterCount > 0 ? '≡ ' + filterCount : '≡'}
          </button>
          <button
            type="button"
            data-broiler-batches-sort-toggle="1"
            aria-label="Sort"
            title="Sort"
            aria-expanded={openToolPanel === 'sort'}
            onClick={() => toggleToolPanel('sort')}
            style={toolButtonS(openToolPanel === 'sort')}
          >
            ↕
          </button>
          <span style={{position: 'relative', flex: '0 0 auto'}}>
            <button
              type="button"
              data-broiler-batches-columns-toggle="1"
              aria-label="Columns"
              title="Columns shown in the processed table"
              aria-expanded={openToolPanel === 'columns'}
              onClick={() => toggleToolPanel('columns')}
              style={toolButtonS(openToolPanel === 'columns')}
            >
              ▦
            </button>
            {openToolPanel === 'columns' && (
              <div
                data-broiler-batches-columns
                style={{
                  position: 'absolute',
                  top: 40,
                  right: 0,
                  zIndex: 40,
                  width: 440,
                  maxWidth: '92vw',
                  maxHeight: 520,
                  overflowY: 'auto',
                  background: 'white',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 12,
                  boxShadow: '0 8px 24px rgba(20,30,40,.16)',
                  padding: '8px 8px 10px',
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--ink-muted)',
                    fontWeight: 700,
                    padding: '4px 6px 8px',
                    borderBottom: '1px solid var(--border)',
                    marginBottom: 6,
                  }}
                >
                  Columns shown in the processed table ({visibleColumns.length}/{BROILER_PROCESSED_COLUMNS.length})
                </div>
                <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 10px'}}>
                  {BROILER_PROCESSED_COLUMNS.map((c) => (
                    <label
                      key={c.key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 9,
                        padding: '6px 8px',
                        borderRadius: 10,
                        cursor: 'pointer',
                        fontSize: 13,
                        color: 'var(--ink)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(c.key)}
                        onChange={() => toggleColumn(c.key)}
                        data-broiler-column-toggle={c.key}
                        style={{flex: '0 0 auto', margin: 0, width: 15, height: 15}}
                      />
                      <span>{c.label}</span>
                    </label>
                  ))}
                </div>
                <div
                  style={{
                    borderTop: '1px solid var(--border)',
                    marginTop: 6,
                    paddingTop: 8,
                    display: 'flex',
                    gap: 8,
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setVisibleColumns(BROILER_PROCESSED_COLUMNS.map((c) => c.key))}
                    data-broiler-columns-all
                    style={savedViewGhostBtnS}
                  >
                    Show all
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibleColumns(BROILER_DEFAULT_COLUMN_KEYS)}
                    data-broiler-columns-reset
                    style={savedViewGhostBtnS}
                  >
                    Reset
                  </button>
                </div>
              </div>
            )}
          </span>
          <button
            type="button"
            data-broiler-batches-export-csv="1"
            aria-label="Export CSV"
            title="Export CSV"
            onClick={handleExportCsv}
            style={toolButtonS(false)}
          >
            CSV
          </button>
          <button
            type="button"
            data-broiler-batches-print="1"
            aria-label="Print"
            title="Print"
            onClick={handlePrintRows}
            style={toolButtonS(false)}
          >
            ⎙
          </button>
          <button
            type="button"
            onClick={openAdd}
            style={{
              padding: '0 14px',
              height: 34,
              borderRadius: 10,
              border: 'none',
              background: BROILER_ACCENT,
              color: getReadableText(BROILER_ACCENT),
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: 0.1,
              display: isMgmt ? 'inline-flex' : 'none',
              alignItems: 'center',
              flex: '0 0 auto',
            }}
          >
            + Add Batch
          </button>
        </div>

        <InlineNotice notice={listNotice} onDismiss={() => setListNotice(null)} />

        {/* Saved views panel */}
        {openToolPanel === 'savedViews' && (
          <div data-broiler-saved-views-row style={toolPanelS}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
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
            {showSaveViewForm && (
              <div
                data-broiler-saved-view-form
                style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}
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
          </div>
        )}

        {/* Filters panel */}
        {openToolPanel === 'filters' && (
          <div data-broiler-batches-filters style={toolPanelS}>
            <div style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>
              Filters apply to the processed batches below
            </div>
            <div style={{display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end'}}>
              <label style={filterLabelS}>
                Breed
                <select
                  value={selectFilterValue('breed')}
                  onChange={(e) => setSelectFilter('breed', e.target.value)}
                  data-broiler-breed-filter
                  style={{...inpS, width: 'auto'}}
                >
                  <option value="">All</option>
                  {breedFilterOptions.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={filterLabelS}>
                Hatchery
                <select
                  value={selectFilterValue('hatchery')}
                  onChange={(e) => setSelectFilter('hatchery', e.target.value)}
                  data-broiler-hatchery-filter
                  style={{...inpS, width: 'auto'}}
                >
                  <option value="">All</option>
                  {hatcheryOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label style={filterLabelS}>
                Brooder
                <select
                  value={selectFilterValue('brooder')}
                  onChange={(e) => setSelectFilter('brooder', e.target.value)}
                  data-broiler-brooder-filter
                  style={{...inpS, width: 'auto'}}
                >
                  <option value="">All</option>
                  {brooderOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label style={filterLabelS}>
                Schooner
                <select
                  value={selectFilterValue('schooner')}
                  onChange={(e) => setSelectFilter('schooner', e.target.value)}
                  data-broiler-schooner-filter
                  style={{...inpS, width: 'auto'}}
                >
                  <option value="">All</option>
                  {schoonerOptions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end'}}>
              <label style={filterLabelS}>
                Hatch date
                <span style={{display: 'inline-flex', gap: 4, alignItems: 'center'}}>
                  <input
                    type="date"
                    value={dateBound('startDateRange', 'after')}
                    onChange={(e) => setDateBound('startDateRange', 'after', e.target.value)}
                    data-broiler-start-after
                    style={{...inpS, width: 'auto'}}
                  />
                  <span>–</span>
                  <input
                    type="date"
                    value={dateBound('startDateRange', 'before')}
                    onChange={(e) => setDateBound('startDateRange', 'before', e.target.value)}
                    data-broiler-start-before
                    style={{...inpS, width: 'auto'}}
                  />
                </span>
              </label>
              <label style={filterLabelS}>
                Processing date
                <span style={{display: 'inline-flex', gap: 4, alignItems: 'center'}}>
                  <input
                    type="date"
                    value={dateBound('processingDateRange', 'after')}
                    onChange={(e) => setDateBound('processingDateRange', 'after', e.target.value)}
                    data-broiler-processing-after
                    style={{...inpS, width: 'auto'}}
                  />
                  <span>–</span>
                  <input
                    type="date"
                    value={dateBound('processingDateRange', 'before')}
                    onChange={(e) => setDateBound('processingDateRange', 'before', e.target.value)}
                    data-broiler-processing-before
                    style={{...inpS, width: 'auto'}}
                  />
                </span>
              </label>
            </div>
            <div style={{display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end'}}>
              {[
                {key: 'birdCountRange', label: 'Birds', hook: 'birdcount'},
                {key: 'birdsArrivedRange', label: 'Birds arrived', hook: 'birdsarrived'},
                {key: 'toProcessorRange', label: 'To processor', hook: 'toprocessor'},
                {key: 'mortalityRange', label: 'Mortality', hook: 'mortality'},
                {key: 'lbsProducedRange', label: 'Feed lbs', hook: 'lbsproduced'},
              ].map((r) => (
                <label key={r.key} style={filterLabelS}>
                  {r.label}
                  <span style={{display: 'inline-flex', gap: 4, alignItems: 'center'}}>
                    <input
                      type="number"
                      value={numBound(r.key, 'min')}
                      onChange={(e) => setNumBound(r.key, 'min', e.target.value)}
                      placeholder="min"
                      data-broiler-range-min={r.hook}
                      style={numInpS}
                    />
                    <span>–</span>
                    <input
                      type="number"
                      value={numBound(r.key, 'max')}
                      onChange={(e) => setNumBound(r.key, 'max', e.target.value)}
                      placeholder="max"
                      data-broiler-range-max={r.hook}
                      style={numInpS}
                    />
                  </span>
                </label>
              ))}
            </div>
            {filterCount > 0 && (
              <div>
                <button type="button" onClick={clearAllFilters} data-broiler-clear-filters style={savedViewGhostBtnS}>
                  Clear all filters
                </button>
              </div>
            )}
          </div>
        )}

        {/* Sort panel */}
        {openToolPanel === 'sort' && (
          <div data-broiler-batches-sort-panel style={toolPanelS}>
            <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
              <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600}}>Sort by</span>
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
                {sortRule.dir === 'desc' ? '↓ Desc' : '↑ Asc'}
              </button>
            </div>
          </div>
        )}

        <div style={{fontSize: 12, color: 'var(--ink-muted)', marginBottom: 10}} data-broiler-count>
          {activeRows.length} active/planned · showing {visibleCount} of {processedTotal} processed
          {filterCount > 0 && ' - ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's')}
        </div>

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
        {processedTotal > 0 &&
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
              const processingCost = parseFloat(b.processingCost) || 0;
              const totalCost = feedCost + gritCost + processingCost + chickCost;
              const toProc = parseFloat(b.totalToProcessor) || 0;
              const perBird = toProc > 0 ? totalCost / toProc : 0;
              const feedPerBird = toProc > 0 ? totalFeed / toProc : 0;
              const processingPerBird = toProc > 0 ? processingCost / toProc : 0;
              const totalMeat = (parseFloat(b.avgDressedLbs) || 0) * toProc;
              const mortalityPct = b.birdCount > 0 ? ((mortality / b.birdCount) * 100).toFixed(1) : '0';
              const tofDays =
                b.hatchDate && b.processingDate
                  ? Math.round(
                      (new Date(b.processingDate + 'T12:00:00') - new Date(b.hatchDate + 'T12:00:00')) / 86400000,
                    )
                  : null;
              const timeOnFarm = tofDays != null ? `${Math.floor(tofDays / 7)}w ${tofDays % 7}d` : null;
              return {
                starterLbs,
                growerLbs,
                totalFeed,
                mortality,
                mortalityPct,
                totalCost,
                perBird,
                feedPerBird,
                processingPerBird,
                totalMeat,
                timeOnFarm,
              };
            };

            // Processed-table cell formatters.
            const money0 = (n) => (n > 0 ? '$' + Math.round(n).toLocaleString() : '—');
            const money2 = (n) => (n > 0 ? '$' + n.toFixed(2) : '—');
            const lbs0 = (n) => (n > 0 ? Math.round(n).toLocaleString() + ' lbs' : '—');
            const wt2 = (v) => (parseFloat(v) > 0 ? Number(v).toFixed(2) + ' lbs' : '—');
            const period = (b, which) => {
              const live = calcTimeline(b.hatchDate, b.breed, b.processingDate);
              const inD =
                which === 'brooder'
                  ? b.brooderIn || (live ? live.brooderIn : null)
                  : live
                    ? live.schoonerIn
                    : b.schoonerIn;
              const outD =
                which === 'brooder'
                  ? b.brooderOut || (live ? live.brooderOut : null)
                  : live
                    ? live.schoonerOut
                    : b.schoonerOut;
              return fmtS(inD) + ' → ' + fmtS(outD);
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
                key: 'brooder',
                label: 'Brooder',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{b.brooder || '—'}</StatusText>,
              },
              {
                key: 'schooner',
                label: 'Schooner',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{b.schooner || '—'}</StatusText>,
              },
              {
                key: 'hatchDate',
                label: 'Hatch Date',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{b.hatchDate ? fmt(b.hatchDate) : '—'}</StatusText>,
              },
              {
                key: 'brooderPeriod',
                label: 'Brooder Period',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{period(b, 'brooder')}</StatusText>,
              },
              {
                key: 'schoonerPeriod',
                label: 'Schooner Period',
                mobilePriority: false,
                render: (b) => <StatusText tone="muted">{period(b, 'schooner')}</StatusText>,
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
                render: (b) => <StatusText tone="muted">{statsFor(b).timeOnFarm || '—'}</StatusText>,
              },
              {
                key: 'birdCount',
                label: 'Birds Ordered',
                align: 'right',
                render: (b) => (b.birdCount || 0).toLocaleString(),
              },
              {
                key: 'birdsArrived',
                label: 'Birds Arrived',
                align: 'right',
                mobilePriority: false,
                render: (b) => (parseInt(b.birdCountActual) > 0 ? parseInt(b.birdCountActual).toLocaleString() : '—'),
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
                  const {mortality} = statsFor(b);
                  return mortality > 20 ? (
                    <StatusText tone="danger">{mortality.toLocaleString()}</StatusText>
                  ) : (
                    mortality.toLocaleString()
                  );
                },
              },
              {
                key: 'mortalityPct',
                label: 'Mortality %',
                align: 'right',
                mobilePriority: false,
                render: (b) => statsFor(b).mortalityPct + '%',
              },
              {
                key: 'chickCost',
                label: 'Chick Cost',
                align: 'right',
                mobilePriority: false,
                render: (b) => money2(parseFloat(b.chickCost) || 0),
              },
              {
                key: 'starterFeed',
                label: 'Starter Feed',
                align: 'right',
                mobilePriority: false,
                render: (b) => lbs0(statsFor(b).starterLbs),
              },
              {
                key: 'growerFeed',
                label: 'Grower Feed',
                align: 'right',
                mobilePriority: false,
                render: (b) => lbs0(statsFor(b).growerLbs),
              },
              {
                key: 'totalFeed',
                label: 'Total Feed',
                align: 'right',
                render: (b) => lbs0(statsFor(b).totalFeed),
              },
              {
                key: 'feedPerBird',
                label: 'Feed / Bird',
                align: 'right',
                mobilePriority: false,
                render: (b) => {
                  const v = statsFor(b).feedPerBird;
                  return v > 0 ? v.toFixed(2) + ' lbs' : '—';
                },
              },
              {
                key: 'week4Lbs',
                label: '4-wk Wt',
                align: 'right',
                mobilePriority: false,
                render: (b) => wt2(b.week4Lbs),
              },
              {
                key: 'week6Lbs',
                label: '6-wk Wt',
                align: 'right',
                mobilePriority: false,
                render: (b) => wt2(b.week6Lbs),
              },
              {
                key: 'avgBreast',
                label: 'Avg Breast',
                align: 'right',
                mobilePriority: false,
                render: (b) => wt2(b.avgBreastLbs),
              },
              {
                key: 'avgThigh',
                label: 'Avg Thigh',
                align: 'right',
                mobilePriority: false,
                render: (b) => wt2(b.avgThighsLbs),
              },
              {
                key: 'avgDressed',
                label: 'Avg Whole',
                align: 'right',
                mobilePriority: false,
                render: (b) => wt2(b.avgDressedLbs),
              },
              {
                key: 'totalMeat',
                label: 'Total Meat',
                align: 'right',
                mobilePriority: false,
                render: (b) => lbs0(statsFor(b).totalMeat),
              },
              {
                key: 'processingCost',
                label: 'Processing Cost',
                align: 'right',
                mobilePriority: false,
                render: (b) => money0(parseFloat(b.processingCost) || 0),
              },
              {
                key: 'processingPerBird',
                label: 'Processing / Bird',
                align: 'right',
                mobilePriority: false,
                render: (b) => money2(statsFor(b).processingPerBird),
              },
              {
                key: 'totalCost',
                label: 'Total Cost',
                align: 'right',
                mobilePriority: false,
                render: (b) => money0(statsFor(b).totalCost),
              },
              {
                key: 'perBird',
                label: 'Cost / Bird',
                align: 'right',
                mobilePriority: false,
                render: (b) => money2(statsFor(b).perBird),
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
              <div>
                {processedCardRows.length === 0 ? (
                  <div
                    style={{
                      padding: '2.5rem',
                      textAlign: 'center',
                      color: 'var(--ink-faint)',
                      ...S.card,
                    }}
                    data-broiler-batches-empty={processedTotal === 0 ? 'true' : 'filtered'}
                  >
                    No broiler batches match the current filters
                  </div>
                ) : (
                  <div style={{...S.card, overflowX: 'auto'}}>
                    <DataTable
                      surfaceKey="broiler-processed"
                      rows={processedCardRows}
                      rowKey="id"
                      density="compact"
                      columns={processedColumns.filter((c) => columnVisible(c.key))}
                      onRowOpen={(b) => openBatch(b, processedCardRows)}
                    />
                  </div>
                )}
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
