// EquipmentFleetView — operational fleet list with search / status / category /
// fuel filters, a single sort rule + direction, and saved views (surface_key
// equipment.fleet). Two layouts share one toolbar + one filtered+sorted row
// set: a category-grouped tile view (default) and a flat unified grid (header
// row + aligned rows, PigBatchesView-style). The SAME sorted set drives the
// rendered rows, the record-sequence nav handed to onOpen, and the CSV/print
// export (via the shared buildEquipmentFleetExportColumns owner).
//
// equipment + fuelings arrive as props from EquipmentHome — that contract is
// preserved; saved-views CRUD goes through the shared savedViewsApi using the
// `sb` client prop.
import React from 'react';
import {
  EQUIPMENT_CATEGORIES,
  CATEGORY_BY_KEY,
  MISSED_FUELING_DAYS,
  WARRANTY_WINDOW_DAYS,
  EQUIPMENT_COLOR,
  soonestDue,
  daysSince,
  fmtReading,
} from '../lib/equipment.js';
import EquipmentAddModal from './EquipmentAddModal.jsx';
import EquipmentCategoryIcon from '../components/EquipmentCategoryIcon.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {buildEquipmentFleetExportColumns} from '../lib/operationalExportColumns.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {
  EQUIPMENT_FLEET_SORT_KEYS,
  buildEquipmentFleetPredicate,
  buildEquipmentFleetComparator,
} from '../lib/equipmentFleetFilters.js';

const EQUIPMENT_FLEET_SURFACE_KEY = 'equipment.fleet';

const STATUS_OPTIONS = [
  {key: 'active', label: 'Active'},
  {key: 'sold', label: 'Sold'},
];

const FUEL_TYPE_OPTIONS = [
  {key: 'diesel', label: 'Diesel'},
  {key: 'gasoline', label: 'Gasoline'},
  {key: 'unset', label: '(none)'},
];

const TRACKING_UNIT_OPTIONS = [
  {key: 'hours', label: 'Hours'},
  {key: 'km', label: 'KM'},
];

const FUELING_TIER_OPTIONS = [
  {key: '', label: 'Any fueling'},
  {key: 'fueled', label: 'Has fueling'},
  {key: 'neverFueled', label: 'Never fueled'},
  {key: 'missedFueling', label: 'Missed (' + MISSED_FUELING_DAYS + 'd+)'},
  {key: 'missedOrNeverFueled', label: 'Missed or never'},
];

const SORT_KEY_LABELS = {
  name: 'Name',
  category: 'Category',
  status: 'Status',
  daysSinceFueling: 'Days since fueling',
};

const inpS = {
  fontSize: 13,
  padding: '7px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

const ghostBtnS = {
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
};
const primaryBtnS = {...ghostBtnS, border: '1px solid ' + EQUIPMENT_COLOR, color: EQUIPMENT_COLOR};
const radioLabelS = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 12,
  color: '#374151',
  cursor: 'pointer',
};

export default function EquipmentFleetView({sb, equipment, fuelings, fmt, onOpen, onReload}) {
  const {useState, useMemo, useEffect} = React;
  const [showAdd, setShowAdd] = useState(false);
  const [exportNotice, setExportNotice] = useState(null);

  const [viewMode, setViewMode] = useState('grouped');
  const [filters, setFilters] = useState({});
  const [sortRule, setSortRule] = useState({key: 'name', dir: 'asc'});

  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);

  // Saved views are scoped to the signed-in profile via RLS; the picker still
  // needs the caller's id to split "my views" from public-others. The shared
  // sb client exposes the current user through getUser(); fetch it once.
  const [myProfileId, setMyProfileId] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!sb || !sb.auth || typeof sb.auth.getUser !== 'function') return undefined;
    sb.auth
      .getUser()
      .then(({data}) => {
        if (!cancelled) setMyProfileId(data?.user?.id || null);
      })
      .catch(() => {
        if (!cancelled) setMyProfileId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sb]);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, EQUIPMENT_FLEET_SURFACE_KEY);
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

  // Per-equipment derived data: service completions (for the "service due"
  // badge) + the latest fueling row/date. Built once from the fueling rows so
  // both the filter ctx (days-since-fueling) and the tiles share it.
  const {completionsById, latestFuelingById, latestFuelingDateById} = useMemo(() => {
    const completions = new Map();
    const latest = new Map();
    const latestDate = new Map();
    for (const fuel of fuelings || []) {
      const arr = completions.get(fuel.equipment_id) || [];
      (fuel.service_intervals_completed || []).forEach((c) =>
        arr.push({
          ...c,
          reading_at_completion:
            fuel.hours_reading != null ? fuel.hours_reading : fuel.km_reading != null ? fuel.km_reading : null,
        }),
      );
      completions.set(fuel.equipment_id, arr);
      const cur = latest.get(fuel.equipment_id);
      if (!cur || (fuel.date || '') > (cur.date || '')) {
        latest.set(fuel.equipment_id, fuel);
        latestDate.set(fuel.equipment_id, fuel.date || null);
      }
    }
    return {completionsById: completions, latestFuelingById: latest, latestFuelingDateById: latestDate};
  }, [fuelings]);

  const filterCtx = useMemo(
    () => ({todayMs: Date.now(), latestFuelingDateById, missedFuelingDays: MISSED_FUELING_DAYS}),
    [latestFuelingDateById],
  );

  // filtered = rows.filter(predicate); sorted = [...filtered].sort(comparator).
  // The sorted set is the single source of truth for render, record-sequence
  // nav, and export.
  const filtered = useMemo(
    () => (equipment || []).filter(buildEquipmentFleetPredicate(filters, filterCtx)),
    [equipment, filters, filterCtx],
  );
  const sorted = useMemo(
    () => [...filtered].sort(buildEquipmentFleetComparator(sortRule, filterCtx)),
    [filtered, sortRule, filterCtx],
  );

  const totalCount = (equipment || []).length;
  const filterCount = Object.keys(filters).length;

  // Category groups over the SORTED+filtered set (grouped mode); the visible/
  // rendered order is exactly the sorted order within each category, then any
  // category not in the canonical list. The flat array `fleetSeqRows` IS the
  // record-sequence + export order in both modes.
  const grouped = useMemo(
    () =>
      EQUIPMENT_CATEGORIES.map((cat) => ({...cat, rows: sorted.filter((e) => e.category === cat.key)})).filter(
        (g) => g.rows.length > 0,
      ),
    [sorted],
  );
  const uncategorized = useMemo(() => sorted.filter((e) => !CATEGORY_BY_KEY[e.category]), [sorted]);
  // Record-sequence order: grouped mode walks category groups (then any
  // uncategorized); flat mode is the plain sorted order. Either way it mirrors
  // exactly what the operator sees, so click-through prev/next matches the list.
  const fleetSeqRows = viewMode === 'flat' ? sorted : [...grouped.flatMap((g) => g.rows), ...uncategorized];

  const fleetExportRows = useMemo(
    () =>
      fleetSeqRows.map((eq) => {
        const reading = eq.tracking_unit === 'km' ? eq.current_km : eq.current_hours;
        return {
          ...eq,
          category: (CATEGORY_BY_KEY[eq.category] && CATEGORY_BY_KEY[eq.category].label) || eq.category,
          current_reading: reading,
          last_fueling_date: latestFuelingDateById.get(eq.id) || null,
        };
      }),
    [fleetSeqRows, latestFuelingDateById],
  );
  const exportColumns = buildEquipmentFleetExportColumns({fmt, fmtReading});

  function handleExportCsv() {
    if (!fleetExportRows.length) {
      setExportNotice({kind: 'warning', message: 'No equipment match the current filters to export.'});
      return;
    }
    const ok = downloadCsv(csvFilename('equipment-fleet'), rowsToCsv(exportColumns, fleetExportRows));
    setExportNotice(ok ? null : {kind: 'error', message: 'CSV export is only available in the browser.'});
  }

  function handlePrintRows() {
    if (!fleetExportRows.length) {
      setExportNotice({kind: 'warning', message: 'No equipment match the current filters to print.'});
      return;
    }
    const ok = printRows({
      title: 'Equipment Fleet',
      subtitle: fleetExportRows.length + ' equipment records',
      columns: exportColumns,
      rows: fleetExportRows,
    });
    setExportNotice(ok ? null : {kind: 'error', message: 'Print is only available in the browser.'});
  }

  // ── filter helpers ────────────────────────────────────────────────────────
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
  function toggleArrayValue(key, value) {
    setFilters((prev) => {
      const cur = Array.isArray(prev[key]) ? prev[key] : [];
      const nextValues = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      const next = {...prev};
      if (nextValues.length === 0) delete next[key];
      else next[key] = nextValues;
      return next;
    });
  }
  function clearAllFilters() {
    setFilters({});
  }
  function flipSortDir() {
    setSortRule((prev) => ({...prev, dir: prev.dir === 'asc' ? 'desc' : 'asc'}));
  }

  const search = filters.textSearch || '';
  const statusFilter = Array.isArray(filters.status) && filters.status.length === 1 ? filters.status[0] : '';
  const categoryFilter = Array.isArray(filters.category) && filters.category.length === 1 ? filters.category[0] : '';
  function setStatusFilter(value) {
    setFilter('status', value ? [value] : null);
  }
  function setCategoryFilter(value) {
    setFilter('category', value ? [value] : null);
  }

  // ── saved views ───────────────────────────────────────────────────────────
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );

  function fleetViewState() {
    return buildViewState({filters, sortRules: [sortRule], viewMode});
  }
  function applySavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    const rules = Array.isArray(st.sortRules) ? st.sortRules : [];
    const first = rules[0];
    setSortRule(
      first && first.key && EQUIPMENT_FLEET_SORT_KEYS.includes(first.key)
        ? {key: first.key, dir: first.dir === 'desc' ? 'desc' : 'asc'}
        : {key: 'name', dir: 'asc'},
    );
    setViewMode(st.viewMode === 'flat' ? 'flat' : 'grouped');
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
      setExportNotice({kind: 'error', message: 'Name the view before saving.'});
      return;
    }
    setSavedViewBusy(true);
    try {
      const created = await createSavedView(sb, {
        surfaceKey: EQUIPMENT_FLEET_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: fleetViewState(),
      });
      setShowSaveViewForm(false);
      await loadSavedViews();
      if (created?.id) setSelectedViewId(created.id);
    } catch (e) {
      setExportNotice({kind: 'error', message: 'Save view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  async function updateSelectedView() {
    if (!selectedView || !selectedViewIsMine) return;
    setSavedViewBusy(true);
    try {
      await updateSavedView(sb, selectedView.id, {viewState: fleetViewState()});
      await loadSavedViews();
      setExportNotice({kind: 'success', message: 'Updated "' + selectedView.name + '" to the current filters/sort.'});
    } catch (e) {
      setExportNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
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
    if (window._wcfConfirmDelete) window._wcfConfirmDelete('Delete saved view "' + view.name + '"?', run);
    else run();
  }
  async function proceedDeleteSelectedView(view) {
    setSavedViewBusy(true);
    try {
      await deleteSavedView(sb, view.id);
      setSelectedViewId('');
      await loadSavedViews();
      setExportNotice({kind: 'success', message: 'Deleted saved view "' + view.name + '".'});
    } catch (e) {
      setExportNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }

  // ── per-row badge metadata (shared by tile + flat row) ──────────────────────
  function rowMeta(eq) {
    const reading = eq.tracking_unit === 'km' ? eq.current_km : eq.current_hours;
    const dueInfo = soonestDue(eq.service_intervals, completionsById.get(eq.id) || [], reading, 50);
    const latestFuel = latestFuelingById.get(eq.id);
    const daysSinceFuel = daysSince(latestFuel?.date);
    const missedFuel = daysSinceFuel != null && daysSinceFuel > MISSED_FUELING_DAYS;
    const warrantyExpiresSoon =
      eq.warranty_expiration &&
      daysSince(eq.warranty_expiration) != null &&
      daysSince(eq.warranty_expiration) > -WARRANTY_WINDOW_DAYS &&
      daysSince(eq.warranty_expiration) < 0;
    return {reading, dueInfo, latestFuel, daysSinceFuel, missedFuel, warrantyExpiresSoon};
  }

  // Openable click + keyboard props shared by tile + flat row. Both render a
  // single whole-element action with no nested controls, so button semantics
  // are safe and the global .hoverable-tile :focus-visible affordance applies.
  const openableProps = (eq) => {
    const open = () => onOpen(eq.slug, fleetSeqRows);
    return {
      onClick: open,
      role: 'button',
      tabIndex: 0,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      },
    };
  };

  const tile = (eq) => {
    const {reading, dueInfo, latestFuel, daysSinceFuel, missedFuel, warrantyExpiresSoon} = rowMeta(eq);
    const cat = CATEGORY_BY_KEY[eq.category] || {color: '#57534e', bg: '#fafaf9', bd: '#d6d3d1'};

    return (
      <div
        key={eq.id}
        data-equipment-tile={eq.slug}
        {...openableProps(eq)}
        className="hoverable-tile"
        style={{
          background: eq.status === 'sold' ? '#f9fafb' : 'white',
          border: '1px solid ' + cat.bd,
          borderRadius: 12,
          padding: '14px 18px',
          cursor: 'pointer',
          minWidth: 0,
          opacity: eq.status === 'sold' ? 0.8 : 1,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
          <span style={{fontSize: 15, fontWeight: 700, color: cat.color}}>{eq.name}</span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: eq.status === 'active' ? '#d1fae5' : '#f3f4f6',
              color: eq.status === 'active' ? '#065f46' : '#374151',
              textTransform: 'uppercase',
            }}
          >
            {eq.status}
          </span>
          {eq.fuel_type && <span style={{fontSize: 11, color: '#6b7280'}}>{eq.fuel_type}</span>}
        </div>
        <div
          style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, fontSize: 11}}
        >
          <div>
            <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
              {eq.tracking_unit === 'km' ? 'Current KM' : 'Current Hours'}
            </div>
            <div style={{fontWeight: 700, color: '#111827'}}>{fmtReading(reading, eq.tracking_unit)}</div>
          </div>
          {latestFuel && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Last fueling
              </div>
              <div style={{fontWeight: 600, color: missedFuel ? '#b91c1c' : '#111827'}}>
                {fmt(latestFuel.date)}
                {daysSinceFuel != null ? ' (' + daysSinceFuel + 'd)' : ''}
              </div>
            </div>
          )}
          {dueInfo && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Next service
              </div>
              <div style={{fontWeight: 700, color: dueInfo.overdue ? '#b91c1c' : '#a16207'}}>
                {dueInfo.overdue
                  ? 'OVERDUE ' + dueInfo.hours_or_km + dueInfo.kind.charAt(0)
                  : dueInfo.hours_or_km + dueInfo.kind.charAt(0) + ' at ' + dueInfo.next_due}
              </div>
            </div>
          )}
          {warrantyExpiresSoon && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Warranty
              </div>
              <div style={{fontWeight: 700, color: '#a16207'}}>{fmt(eq.warranty_expiration)}</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // Flat unified-grid row (header row + aligned rows, PigBatchesView-style).
  const FLAT_GRID = '36px 1fr 110px 80px 90px 120px 150px';
  const flatRow = (eq, i) => {
    const {reading, dueInfo, latestFuel, daysSinceFuel, missedFuel} = rowMeta(eq);
    const cat = CATEGORY_BY_KEY[eq.category] || {color: '#57534e', label: eq.category, bg: '#fafaf9', bd: '#d6d3d1'};
    return (
      <div
        key={eq.id}
        data-equipment-row={eq.slug}
        {...openableProps(eq)}
        className="hoverable-tile"
        style={{
          display: 'grid',
          gridTemplateColumns: FLAT_GRID,
          alignItems: 'center',
          gap: 10,
          padding: '10px 16px',
          borderBottom: i < sorted.length - 1 ? '1px solid #f3f4f6' : 'none',
          cursor: 'pointer',
          background: eq.status === 'sold' ? '#f9fafb' : 'white',
        }}
      >
        <span style={{fontSize: 11, color: '#9ca3af', fontVariantNumeric: 'tabular-nums', fontWeight: 600}}>
          {i + 1}
        </span>
        <span style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: cat.color,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {eq.name}
          </span>
          {eq.fuel_type && <span style={{fontSize: 10, color: '#9ca3af'}}>{eq.fuel_type}</span>}
        </span>
        <span style={{fontSize: 11, color: cat.color, fontWeight: 600}}>{cat.label || eq.category || '—'}</span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 10,
            textAlign: 'center',
            background: eq.status === 'active' ? '#d1fae5' : '#f3f4f6',
            color: eq.status === 'active' ? '#065f46' : '#374151',
            textTransform: 'uppercase',
          }}
        >
          {eq.status}
        </span>
        <span style={{fontSize: 11, fontWeight: 600, color: '#111827'}}>{fmtReading(reading, eq.tracking_unit)}</span>
        <span style={{fontSize: 11, color: missedFuel ? '#b91c1c' : latestFuel ? '#111827' : '#9ca3af'}}>
          {latestFuel
            ? fmt(latestFuel.date) + (daysSinceFuel != null ? ' (' + daysSinceFuel + 'd)' : '')
            : 'no fueling'}
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: dueInfo ? (dueInfo.overdue ? '#b91c1c' : '#a16207') : '#9ca3af',
          }}
        >
          {dueInfo
            ? dueInfo.overdue
              ? 'OVERDUE ' + dueInfo.hours_or_km + dueInfo.kind.charAt(0)
              : dueInfo.hours_or_km + dueInfo.kind.charAt(0) + ' at ' + dueInfo.next_due
            : '—'}
        </span>
      </div>
    );
  };

  // True-empty (no equipment at all) keeps the original empty message.
  if (totalCount === 0) {
    return (
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
        No equipment yet. Run the Podio import, or use + Add Equipment.
      </div>
    );
  }

  const filteredEmpty = sorted.length === 0;

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 14}} data-equipment-fleet-loaded="true">
      {/* Saved views row */}
      <div
        data-equipment-saved-views-row
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <span style={{fontSize: 11, color: '#6b7280', fontWeight: 600}}>Saved views</span>
        {savedViewsError ? (
          <span
            style={{fontSize: 12, color: '#b91c1c', display: 'inline-flex', alignItems: 'center', gap: 8}}
            data-equipment-saved-views-error
          >
            Saved views unavailable. Filters still work.
            <button
              type="button"
              data-equipment-saved-views-retry
              onClick={loadSavedViews}
              disabled={savedViewsLoading}
              style={{
                fontSize: 11,
                padding: '3px 10px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                color: '#374151',
                cursor: savedViewsLoading ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                fontWeight: 600,
              }}
            >
              {savedViewsLoading ? 'Retrying…' : 'Retry'}
            </button>
          </span>
        ) : (
          <>
            <select
              data-equipment-saved-view-select
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
                  data-equipment-saved-view-update
                  onClick={updateSelectedView}
                  disabled={savedViewBusy}
                  style={ghostBtnS}
                >
                  Update to current
                </button>
                <button
                  type="button"
                  data-equipment-saved-view-delete
                  onClick={deleteSelectedView}
                  disabled={savedViewBusy}
                  style={{...ghostBtnS, color: '#b91c1c', borderColor: '#fecaca'}}
                >
                  Delete
                </button>
              </>
            )}
            <span style={{flex: 1}} />
            <button
              type="button"
              data-equipment-saved-view-save-open
              onClick={openSaveViewForm}
              disabled={savedViewBusy}
              style={primaryBtnS}
            >
              Save current view
            </button>
          </>
        )}
      </div>
      {showSaveViewForm && (
        <div
          data-equipment-saved-view-form
          style={{
            background: 'white',
            border: '1px solid ' + EQUIPMENT_COLOR,
            borderRadius: 10,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <input
            data-equipment-saved-view-name
            type="text"
            value={saveViewName}
            placeholder="View name"
            onChange={(e) => setSaveViewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSaveView();
            }}
            style={{...inpS, flex: 1, minWidth: 200}}
          />
          <label style={radioLabelS}>
            <input
              type="radio"
              name="saveEquipmentViewVisibility"
              checked={saveViewVisibility === 'private'}
              onChange={() => setSaveViewVisibility('private')}
              data-equipment-saved-view-visibility="private"
            />
            Private
          </label>
          <label style={radioLabelS}>
            <input
              type="radio"
              name="saveEquipmentViewVisibility"
              checked={saveViewVisibility === 'public'}
              onChange={() => setSaveViewVisibility('public')}
              data-equipment-saved-view-visibility="public"
            />
            Public
          </label>
          <button
            type="button"
            data-equipment-saved-view-save
            onClick={submitSaveView}
            disabled={savedViewBusy}
            style={primaryBtnS}
          >
            Save
          </button>
          <button type="button" onClick={() => setShowSaveViewForm(false)} disabled={savedViewBusy} style={ghostBtnS}>
            Cancel
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div
        data-equipment-fleet-toolbar
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
          <input
            type="text"
            data-equipment-fleet-search
            value={search}
            onChange={(e) => setFilter('textSearch', e.target.value)}
            placeholder="Search name, category, serial..."
            style={{...inpS, flex: 1, minWidth: 200}}
          />
          <select
            data-equipment-fleet-status-filter
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{...inpS, width: 'auto'}}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            data-equipment-fleet-category-filter
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            style={{...inpS, width: 'auto'}}
          >
            <option value="">All categories</option>
            {EQUIPMENT_CATEGORIES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <div
            data-equipment-fleet-fuel-filter
            style={{display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}
          >
            {FUEL_TYPE_OPTIONS.map((o) => {
              const active = Array.isArray(filters.fuelType) && filters.fuelType.includes(o.key);
              return (
                <button
                  key={o.key}
                  type="button"
                  data-equipment-fuel-type={o.key}
                  onClick={() => toggleArrayValue('fuelType', o.key)}
                  style={{
                    ...ghostBtnS,
                    padding: '5px 10px',
                    borderRadius: 999,
                    border: active ? '1px solid ' + EQUIPMENT_COLOR : '1px solid #d1d5db',
                    background: active ? '#fafaf9' : 'white',
                    color: active ? EQUIPMENT_COLOR : '#374151',
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <select
            data-equipment-fleet-fueling-tier
            value={filters.fuelingTier || ''}
            onChange={(e) => setFilter('fuelingTier', e.target.value)}
            style={{...inpS, width: 'auto'}}
          >
            {FUELING_TIER_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: '4px 8px',
            }}
          >
            <span style={{color: '#6b7280', marginRight: 4}}>Sort</span>
            <select
              data-equipment-fleet-sort-key
              value={sortRule.key}
              onChange={(e) => setSortRule({key: e.target.value, dir: sortRule.dir})}
              style={{...inpS, width: 'auto', fontSize: 12, padding: '4px 8px'}}
            >
              {EQUIPMENT_FLEET_SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_KEY_LABELS[key] || key}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-equipment-fleet-sort-dir={sortRule.dir}
              onClick={flipSortDir}
              title="Toggle sort direction"
              style={{...ghostBtnS, padding: '4px 10px'}}
            >
              {sortRule.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </div>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              padding: '4px 8px',
            }}
          >
            <span style={{color: '#6b7280', marginRight: 4}}>View</span>
            <label style={{display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}>
              <input
                type="radio"
                name="equipmentFleetViewMode"
                checked={viewMode === 'grouped'}
                onChange={() => setViewMode('grouped')}
                data-equipment-view-mode="grouped"
              />
              Grouped
            </label>
            <label style={{display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}>
              <input
                type="radio"
                name="equipmentFleetViewMode"
                checked={viewMode === 'flat'}
                onChange={() => setViewMode('flat')}
                data-equipment-view-mode="flat"
              />
              Flat
            </label>
          </div>
          <button type="button" data-equipment-fleet-export-csv="1" onClick={handleExportCsv} style={ghostBtnS}>
            Export CSV
          </button>
          <button type="button" data-equipment-fleet-print="1" onClick={handlePrintRows} style={ghostBtnS}>
            Print
          </button>
          <button
            onClick={() => setShowAdd(true)}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              border: 'none',
              background: EQUIPMENT_COLOR,
              color: 'white',
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            + Add Equipment
          </button>
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
          {filterCount > 0 && (
            <button
              type="button"
              data-equipment-fleet-clear-filters
              onClick={clearAllFilters}
              style={{...ghostBtnS, color: '#6b7280'}}
            >
              Clear filters
            </button>
          )}
          <span data-equipment-fleet-count style={{fontSize: 12, color: '#6b7280'}}>
            {sorted.length} of {totalCount} equipment
            {filterCount > 0 ? ' · ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's') : ''}
          </span>
        </div>
      </div>

      <InlineNotice notice={exportNotice} onDismiss={() => setExportNotice(null)} />
      {showAdd && (
        <EquipmentAddModal
          sb={sb}
          onClose={() => setShowAdd(false)}
          onCreated={(rec) => {
            setShowAdd(false);
            if (onReload) onReload();
            onOpen(rec.slug);
          }}
        />
      )}

      {/* Filtered-no-results (total > 0 but filters match nothing) */}
      {filteredEmpty && (
        <div
          data-equipment-fleet-no-match
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
          No equipment match the current filters.
        </div>
      )}

      {/* GROUPED MODE — category groups (default) */}
      {!filteredEmpty && viewMode === 'grouped' && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
          {grouped.map((g) => (
            <div key={g.key} data-equipment-fleet-group={g.key}>
              <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
                <EquipmentCategoryIcon category={g} size={18} />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: g.color,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  {g.label}
                </span>
                <span style={{fontSize: 11, color: '#6b7280'}}>
                  {g.rows.length} piece{g.rows.length === 1 ? '' : 's'}
                </span>
              </div>
              <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10}}>
                {g.rows.map(tile)}
              </div>
            </div>
          ))}
          {uncategorized.length > 0 && (
            <div data-equipment-fleet-group="uncategorized">
              <div style={{fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6}}>
                OTHER ({uncategorized.length})
              </div>
              <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10}}>
                {uncategorized.map(tile)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* FLAT MODE — unified grid (header row + aligned rows) */}
      {!filteredEmpty && viewMode === 'flat' && (
        <div
          data-equipment-fleet-flat
          style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: FLAT_GRID,
              alignItems: 'center',
              gap: 10,
              padding: '10px 16px',
              borderBottom: '1px solid #e5e7eb',
              background: '#f9fafb',
              fontSize: 11,
              fontWeight: 600,
              color: '#6b7280',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            <span>#</span>
            <span>Name</span>
            <span>Category</span>
            <span>Status</span>
            <span>Reading</span>
            <span>Last fueling</span>
            <span>Next service</span>
          </div>
          {sorted.map((eq, i) => flatRow(eq, i))}
        </div>
      )}
    </div>
  );
}
