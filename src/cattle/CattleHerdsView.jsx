// CattleHerdsView — composable filter chips in organized always-visible groups
// + ordered sort rules + explicit grouped/flat toggle + saved views
// (surface_key cattle.herds). The local smart-filter assistant was removed
// (PROJECT.md Recommended Work Queue); a real AI-assisted filter/sort is queued
// separately.
//
// Filter / sort semantics live in src/lib/cattleHerdFilters.js (pure module,
// vitest-locked). This file is UI wiring only.
//
// Maternal-issue UI retired this build (PROJECT.md §8). DB columns
// `cattle.maternal_issue_flag` + `cattle.maternal_issue_desc` are NOT dropped
// — that's a separate migration gate.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import UsersModal from '../auth/UsersModal.jsx';
import CattleBulkImport from './CattleBulkImport.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import CattleAnimalPage from './CattleAnimalPage.jsx';
import CollapsibleOutcomeSections from './CollapsibleOutcomeSections.jsx';
import {loadCattleWeighInsCached} from '../lib/cattleCache.js';
import {
  buildCattlePredicate,
  buildCattleComparator,
  mergeObservedValues,
  cowTagSet,
  lastWeightFor,
  lastWeightEntryFor,
  calfCountFor,
  buildCalvingEvidence,
  lastCalvingRecordFor,
  CATTLE_HERD_KEYS,
  CATTLE_OUTCOME_KEYS,
  CATTLE_ALL_HERD_KEYS,
  CATTLE_SORT_KEYS,
  STALE_WEIGHT_DAYS_DEFAULT,
} from '../lib/cattleHerdFilters.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DataTable from '../shared/DataTable.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';
import {softDeleteCattleAnimal} from '../lib/cattleDeleteApi.js';
import {deleteCattleCalvingRecord} from '../lib/cattleCalvingApi.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';

const CATTLE_EXCLUDE = ['herd', 'processing_batch_id'];
const CATTLE_LABELS = {
  tag: 'Tag',
  sex: 'Sex',
  breed: 'Breed',
  origin: 'Origin',
  birth_date: 'Birth date',
  purchase_date: 'Purchase date',
  purchase_amount: 'Purchase amount',
  dam_tag: 'Dam tag',
  sire_tag: 'Sire tag',
  registration_num: 'Registration #',
  pct_wagyu: '% Wagyu',
  breeding_status: 'Breeding status',
  breeding_blacklist: 'Breeding blacklist',
  sale_date: 'Sale date',
  sale_amount: 'Sale amount',
  death_date: 'Death date',
  death_reason: 'Death reason',
  old_tags: 'Prior tags',
};
const CATTLE_FORMATTERS = {
  old_tags: (v) => countSummary(v, 'prior tag'),
};

const HERD_LABELS = {
  mommas: 'Mommas',
  backgrounders: 'Backgrounders',
  finishers: 'Finishers',
  bulls: 'Bulls',
  processed: 'Processed',
  deceased: 'Deceased',
  sold: 'Sold',
};

// Toggleable columns for the cattle list (the column/display picker). `tag` is
// always shown; the rest can be hidden/shown, and the choice is stored in saved
// views. Defaults keep today's visible set on.
const CATTLE_HERD_COLUMNS = [
  {key: 'herd', label: 'Herd', default: true},
  {key: 'sex', label: 'Sex', default: true},
  {key: 'breed', label: 'Breed', default: true},
  {key: 'origin', label: 'Origin', default: true},
  {key: 'age', label: 'Age', default: true},
  {key: 'birthDate', label: 'Birth Date', default: false},
  {key: 'lastWeight', label: 'Last Weight', default: true},
  {key: 'lastWeighed', label: 'Last Weighed', default: false},
  {key: 'lastCalved', label: 'Last Calved', default: true},
  {key: 'calfCount', label: 'Calf Count', default: true},
  {key: 'breedingStatus', label: 'Breeding Status', default: false},
  {key: 'breedingBlacklist', label: 'Breeding Blacklist', default: false},
  {key: 'damTag', label: 'Dam Tag', default: false},
  {key: 'sireTag', label: 'Sire Tag', default: false},
  {key: 'pctWagyu', label: '% Wagyu', default: false},
  {key: 'registrationNum', label: 'Registration #', default: false},
  {key: 'purchaseDate', label: 'Purchase Date', default: false},
  {key: 'purchaseAmount', label: 'Purchase Amount', default: false},
  {key: 'saleDate', label: 'Sale Date', default: false},
  {key: 'saleAmount', label: 'Sale Amount', default: false},
  {key: 'deathDate', label: 'Death Date', default: false},
  {key: 'deathReason', label: 'Death Reason', default: false},
  {key: 'recordId', label: 'Record ID', default: false},
];
const CATTLE_DEFAULT_COLUMN_KEYS = CATTLE_HERD_COLUMNS.filter((c) => c.default).map((c) => c.key);

const SEX_OPTIONS = [
  {key: 'cow', label: 'Cow'},
  {key: 'heifer', label: 'Heifer'},
  {key: 'bull', label: 'Bull'},
  {key: 'steer', label: 'Steer'},
];

const BREEDING_STATUS_OPTIONS = [
  {key: 'OPEN', label: 'Open'},
  {key: 'PREGNANT', label: 'Pregnant'},
  {key: 'N/A', label: 'N/A'},
  {key: 'unset', label: '(unset)'},
];

const SORT_KEY_LABELS = {
  tag: 'Tag',
  age: 'Age',
  lastWeight: 'Last weight',
  herd: 'Herd',
  sex: 'Sex',
  lastCalved: 'Last calved',
  calfCount: 'Calf count',
  nonCalving: 'Non-calving',
  breed: 'Breed',
  origin: 'Origin',
};

const SORT_DIR_LABELS = {
  tag: {asc: '↑ low→high', desc: '↓ high→low'},
  age: {asc: 'youngest first', desc: 'oldest first'},
  lastWeight: {asc: 'lightest first', desc: 'heaviest first'},
  herd: {asc: '↑ active→outcome', desc: '↓ outcome→active'},
  sex: {asc: '↑ cow→steer', desc: '↓ steer→cow'},
  lastCalved: {asc: 'oldest first', desc: 'most recent first'},
  calfCount: {asc: 'fewest first', desc: 'most first'},
  nonCalving: {asc: 'candidates last', desc: 'candidates first'},
  breed: {asc: '↑ A→Z', desc: '↓ Z→A'},
  origin: {asc: '↑ A→Z', desc: '↓ Z→A'},
};

// Saved-views surface key for the cattle herds list (migration 095).
const CATTLE_HERDS_SURFACE_KEY = 'cattle.herds';

// Organized filter groups (replaces the old quick/More-filters split). Each
// filter is always visible under its group. 'nonCalving' is a composite chip
// (boolean toggle + "no calf since" date); 'unmatchedCalves' is a boolean
// toggle chip. Everything else opens a value popover.
const FILTER_GROUPS = [
  {key: 'core', label: 'Core', keys: ['herdSet', 'sex', 'ageMonthsRange', 'breed', 'origin', 'weightTier']},
  {
    key: 'calving',
    label: 'Calving/Breeding',
    keys: ['nonCalving', 'calvedStatus', 'lastCalvedRange', 'calfCountRange', 'breedingStatus', 'breedingBlacklist'],
  },
  {
    key: 'lineage',
    label: 'Lineage/Other',
    // Unmatched Calves is a lineage/data-relationship check (no matched dam),
    // rendered as a checkbox-style filter pushed off to the right side of the
    // Lineage/Other row (not mid-row among the chip filters).
    keys: ['damPresence', 'sirePresence', 'birthDateRange', 'wagyuPctRange', 'weightRange', 'unmatchedCalves'],
  },
];
// Checkbox-style filters (a labeled checkbox, not a pill/popover chip).
const CHECKBOX_FILTER_KEYS = new Set(['unmatchedCalves']);
const CHECKBOX_FILTER_LABELS = {unmatchedCalves: 'Unmatched Calves'};

const EMPTY_COW = {
  tag: '',
  sex: 'cow',
  herd: 'mommas',
  breed: '',
  breeding_blacklist: false,
  pct_wagyu: '',
  origin: '',
  birth_date: '',
  purchase_date: '',
  purchase_amount: '',
  dam_tag: '',
  sire_tag: '',
  registration_num: '',
  breeding_status: '',
  sale_date: '',
  sale_amount: '',
  death_date: '',
  death_reason: '',
  old_tags: [],
};

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

const chipBaseS = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontFamily: 'inherit',
  border: '1px solid var(--border-strong)',
  background: 'white',
  color: 'var(--ink-muted)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
// CP0 A12: cattle selection accent (filter chips, sort rule #, tool buttons,
// saved-view button) uses the canonical program color, not the near-duplicate
// #991b1b, so it matches the maroon nav pill + primary buttons exactly.
const CATTLE_ACCENT = getProgramColor('cattle');
const chipActiveS = {
  ...chipBaseS,
  border: `1px solid ${CATTLE_ACCENT}`,
  background: 'white',
  color: CATTLE_ACCENT,
  fontWeight: 600,
};

function CattleHerdsRouter(props) {
  const location = useLocation();
  const cattleDetailId = location.pathname.startsWith('/cattle/herds/')
    ? location.pathname.slice('/cattle/herds/'.length) || null
    : null;
  if (cattleDetailId) {
    return React.createElement(CattleAnimalPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(CattleHerdsHub, props);
}

const CattleHerdsHub = ({
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
  pendingEdit,
  setPendingEdit,
}) => {
  const {useState, useEffect, useMemo} = React;
  const navigate = useNavigate();
  const [cattle, setCattle] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [calvingRecs, setCalvingRecs] = useState([]);
  // Inline notice for save / patch / calving validation failures.
  // Cleared on each save attempt + on form open so a prior row's error
  // never shadows the next flow.
  const [notice, setNotice] = useState(null);
  const [breedOpts, setBreedOpts] = useState([]);
  const [originOpts, setOriginOpts] = useState([]);
  // Inline new-origin UI: when the operator picks "+ Add new origin…" in the
  // form's Origin select, we expose a small text input next to the select
  // instead of opening a native window.prompt. addingOrigin gates render;
  // newOriginInput holds the in-progress label.
  const [addingOrigin, setAddingOrigin] = useState(false);
  const [newOriginInput, setNewOriginInput] = useState('');
  const [processingBatches, setProcessingBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Composable filter / sort state.
  const [filters, setFilters] = usePersistentViewState('cattle.herds.filters', {});
  const [sortRules, setSortRules] = usePersistentViewState('cattle.herds.sortRules', [{key: 'tag', dir: 'asc'}]);
  // Which columns show in the flat cattle list (the column/display picker),
  // persisted per surface and stored in saved views. `tag` is always shown.
  const [visibleColumns, setVisibleColumns] = usePersistentViewState(
    'cattle.herds.columns',
    CATTLE_DEFAULT_COLUMN_KEYS,
  );
  function toggleColumn(key) {
    setVisibleColumns((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }
  const columnVisible = (key) => key === 'tag' || visibleColumns.includes(key);
  const [openFilter, setOpenFilter] = useState(null); // chip popover state — string key
  const [openToolPanel, setOpenToolPanel] = useState(null); // savedViews | filters | sort | columns

  // Saved views (migration 095). Load failures must NOT break the list — they
  // surface as a disabled control + inline message (cold-boot safety).
  const [savedViews, setSavedViews] = useState([]);
  const [savedViewsError, setSavedViewsError] = useState(null);
  const [savedViewsLoading, setSavedViewsLoading] = useState(true);
  const [selectedViewId, setSelectedViewId] = useState('');
  const [showSaveViewForm, setShowSaveViewForm] = useState(false);
  const [saveViewName, setSaveViewName] = useState('');
  const [saveViewVisibility, setSaveViewVisibility] = useState('private');
  const [savedViewBusy, setSavedViewBusy] = useState(false);
  const myProfileId = authState?.user?.id || null;

  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [cR, wAll, calR, brR, orR, pbR] = await Promise.all([
        sb.from('cattle').select('*').is('deleted_at', null).order('tag'),
        loadCattleWeighInsCached(sb, {throwOnError: true}),
        sb.from('cattle_calving_records').select('*').order('calving_date', {ascending: false}),
        sb.from('cattle_breeds').select('*').order('label'),
        sb.from('cattle_origins').select('*').order('label'),
        sb.from('cattle_processing_batches').select('id,name,actual_process_date,planned_process_date'),
      ]);
      if (cR.error) throw new Error('cattle: ' + (cR.error.message || cR.error));
      if (calR.error) throw new Error('cattle_calving_records: ' + (calR.error.message || calR.error));
      if (brR.error) throw new Error('cattle_breeds: ' + (brR.error.message || brR.error));
      if (orR.error) throw new Error('cattle_origins: ' + (orR.error.message || orR.error));
      if (pbR.error) throw new Error('cattle_processing_batches: ' + (pbR.error.message || pbR.error));
      setCattle(cR.data || []);
      setWeighIns(wAll || []);
      setCalvingRecs(calR.data || []);
      setBreedOpts(brR.data || []);
      setOriginOpts(orR.data || []);
      setProcessingBatches(pbR.data || []);
    } catch (e) {
      setCattle([]);
      setWeighIns([]);
      setCalvingRecs([]);
      setBreedOpts([]);
      setOriginOpts([]);
      setProcessingBatches([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load cattle herds. Please retry. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadAll();
  }, []);

  // Saved views load on their own path so a failure (e.g. table missing before
  // PROD migration, or an RLS hiccup) degrades the saved-view control only and
  // never blocks the cattle list.
  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, CATTLE_HERDS_SURFACE_KEY);
      setSavedViews(rows);
      setSavedViewsError(null);
      // Drop a stale selection if the row is gone.
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
  }, []);

  // ── helpers (the lib owns the math; these are display-side wrappers) ──────
  function age(birth) {
    if (!birth) return null;
    const ms = Date.now() - new Date(birth + 'T12:00:00Z').getTime();
    const days = Math.floor(ms / 86400000);
    if (days < 0) return null;
    const y = Math.floor(days / 365);
    const m = Math.floor((days % 365) / 30);
    if (y > 0) return y + 'y ' + m + 'm';
    return m + 'm';
  }
  function ageAtDate(birth, endDate) {
    if (!birth || !endDate) return null;
    const ms = new Date(endDate + 'T12:00:00Z').getTime() - new Date(birth + 'T12:00:00Z').getTime();
    const days = Math.floor(ms / 86400000);
    if (days < 0) return null;
    const y = Math.floor(days / 365);
    const m = Math.floor((days % 365) / 30);
    if (y > 0) return y + 'y ' + m + 'm';
    return m + 'm';
  }
  function processingInfo(cow) {
    if (!cow || cow.herd !== 'processed' || !cow.processing_batch_id) return null;
    const b = processingBatches.find((pb) => pb.id === cow.processing_batch_id);
    if (!b) return null;
    const date = b.actual_process_date || b.planned_process_date;
    if (!date) return null;
    return {date, age: ageAtDate(cow.birth_date, date)};
  }
  function lastWeight(cow) {
    return lastWeightFor(cow, weighIns);
  }
  // Aggregate herd-tile total uses default for recently-purchased cows without
  // a real weigh-in. Per-cow rows still show "no weigh-in" honestly.
  // ── filter + sort: pure-helper-driven ─────────────────────────────────────
  // Default behavior matches today's "active" mode: when no herdSet chip is
  // explicitly set, cap the result to active herd keys (UNLESS the user has
  // a textSearch active — then relax to all so prior outcomes can match).
  const breedFilterOptions = useMemo(
    () => mergeObservedValues(breedOpts, [...new Set(cattle.map((c) => c.breed).filter(Boolean))]),
    [breedOpts, cattle],
  );
  const originFilterOptions = useMemo(
    () => mergeObservedValues(originOpts, [...new Set(cattle.map((c) => c.origin).filter(Boolean))]),
    [originOpts, cattle],
  );
  const calvingEvidence = useMemo(() => buildCalvingEvidence(cattle, calvingRecs), [cattle, calvingRecs]);

  const filtered = useMemo(() => {
    const effectiveFilters = {...filters};
    const userSetHerd = Array.isArray(filters.herdSet) && filters.herdSet.length > 0;
    const searching = typeof filters.textSearch === 'string' && filters.textSearch.trim();
    if (!userSetHerd && !searching) {
      effectiveFilters.herdSet = [...CATTLE_HERD_KEYS];
    }
    const predicate = buildCattlePredicate(effectiveFilters, {
      todayMs: Date.now(),
      calvingRecs: calvingEvidence,
      weighIns,
      staleDaysThreshold: STALE_WEIGHT_DAYS_DEFAULT,
    });
    return cattle.filter(predicate);
  }, [cattle, filters, calvingEvidence, weighIns]);

  const sortedFlat = useMemo(() => {
    const cmp = buildCattleComparator(sortRules, {
      calvingRecs: calvingEvidence,
      weighIns,
      todayMs: Date.now(),
      nonCalvingCutoffDate: filters.nonCalvingCutoffDate,
    });
    return [...filtered].sort(cmp);
  }, [filtered, sortRules, calvingEvidence, weighIns, filters.nonCalvingCutoffDate]);

  function cattleHerdExportColumns() {
    const female = (cow) => cow.sex === 'cow' || cow.sex === 'heifer';
    return [
      {header: 'Tag', value: (c) => c.tag || ''},
      {header: 'Herd', value: (c) => HERD_LABELS[c.herd] || c.herd || ''},
      {header: 'Sex', value: (c) => c.sex || ''},
      {header: 'Breed', value: (c) => c.breed || ''},
      {header: 'Origin', value: (c) => c.origin || ''},
      {header: 'Age', value: (c) => age(c.birth_date) || ''},
      {header: 'Birth date', value: (c) => c.birth_date || ''},
      {header: 'Last weight lbs', value: (c) => lastWeight(c) ?? ''},
      {header: 'Last weighed', value: (c) => lastWeightEntryFor(c, weighIns)?.entered_at || ''},
      {header: 'Last calved', value: (c) => (female(c) ? lastCalving(c.tag)?.calving_date || '' : '')},
      {header: 'Calf count', value: (c) => (female(c) ? calfCount(c.tag) : '')},
      {header: 'Breeding status', value: (c) => c.breeding_status || ''},
      {header: 'Breeding blacklist', value: (c) => (c.breeding_blacklist ? 'yes' : 'no')},
      {header: 'Dam tag', value: (c) => c.dam_tag || ''},
      {header: 'Sire tag', value: (c) => c.sire_tag || ''},
      {header: 'Percent Wagyu', value: (c) => c.pct_wagyu ?? ''},
      {header: 'Purchase date', value: (c) => c.purchase_date || ''},
      {header: 'Purchase amount', value: (c) => c.purchase_amount ?? ''},
      {header: 'Sale date', value: (c) => c.sale_date || ''},
      {header: 'Sale amount', value: (c) => c.sale_amount ?? ''},
      {header: 'Death date', value: (c) => c.death_date || ''},
      {header: 'Death reason', value: (c) => c.death_reason || ''},
      {header: 'Record ID', value: (c) => c.id || ''},
    ];
  }

  function handleExportCsv() {
    const columns = cattleHerdExportColumns();
    const ok = downloadCsv(csvFilename('cattle-herds'), rowsToCsv(columns, sortedFlat));
    if (!ok) setNotice({kind: 'error', message: 'CSV export is only available in the browser.'});
  }

  function handlePrintRows() {
    const columns = cattleHerdExportColumns();
    const ok = printRows({
      title: 'Cattle Herds',
      subtitle: sortedFlat.length + ' filtered cattle',
      columns,
      rows: sortedFlat,
    });
    if (!ok) setNotice({kind: 'error', message: 'Print is only available in the browser.'});
  }

  // ── filter chip handlers ───────────────────────────────────────────────────
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
  function clearFilter(key) {
    setFilter(key, null);
  }
  function clearAllFilters() {
    setFilters({});
  }

  function toggleFilterArrayValue(key, value) {
    setFilters((prev) => {
      const cur = Array.isArray(prev[key]) ? prev[key] : [];
      const next = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      const out = {...prev};
      if (next.length === 0) delete out[key];
      else out[key] = next;
      return out;
    });
  }

  // ── sort rule handlers ─────────────────────────────────────────────────────
  function addSortRule(key) {
    setSortRules((prev) => {
      if (prev.find((r) => r.key === key)) return prev;
      const nextRule = {key, dir: 'asc'};
      const onlyDefaultTag = prev.length === 1 && prev[0].key === 'tag' && prev[0].dir === 'asc';
      if (onlyDefaultTag && key !== 'tag') return [nextRule];
      return [nextRule, ...prev];
    });
  }
  function removeSortRule(idx) {
    setSortRules((prev) => prev.filter((_, i) => i !== idx));
  }
  function flipSortDir(idx) {
    setSortRules((prev) => prev.map((r, i) => (i === idx ? {...r, dir: r.dir === 'asc' ? 'desc' : 'asc'} : r)));
  }
  function moveSortRule(idx, delta) {
    setSortRules((prev) => {
      const next = [...prev];
      const target = idx + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  // ── saved-view handlers ────────────────────────────────────────────────────
  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function applySavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    setFilters(st.filters && typeof st.filters === 'object' ? st.filters : {});
    setSortRules(Array.isArray(st.sortRules) ? st.sortRules : []);
    setVisibleColumns(Array.isArray(st.columns) && st.columns.length > 0 ? st.columns : CATTLE_DEFAULT_COLUMN_KEYS);
    setOpenFilter(null);
    setOpenToolPanel(null);
  }
  function onSelectSavedView(id) {
    setSelectedViewId(id);
    if (!id) return;
    const view = savedViews.find((v) => v.id === id);
    applySavedView(view);
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
        surfaceKey: CATTLE_HERDS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: {...buildViewState({filters, sortRules, viewMode: 'flat'}), columns: visibleColumns},
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
      await updateSavedView(sb, selectedView.id, {
        viewState: {...buildViewState({filters, sortRules, viewMode: 'flat'}), columns: visibleColumns},
      });
      await loadSavedViews();
      setNotice({kind: 'success', message: `Updated "${selectedView.name}" to the current filters/sort/view.`});
    } catch (e) {
      setNotice({kind: 'error', message: 'Update view failed: ' + (e.message || String(e))});
    } finally {
      setSavedViewBusy(false);
    }
  }
  function deleteSelectedView() {
    if (!selectedView || !selectedViewIsMine || !window._wcfConfirmDelete) return;
    window._wcfConfirmDelete(`Delete saved view "${selectedView.name}"?`, async () => {
      setSavedViewBusy(true);
      try {
        await deleteSavedView(sb, selectedView.id);
        setSelectedViewId('');
        await loadSavedViews();
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete view failed: ' + (e.message || String(e))});
      } finally {
        setSavedViewBusy(false);
      }
    });
  }

  // ── Add / Edit / Delete / Transfer / Calving — preserved ───────
  // Single close path for the Add/Edit cow modal. Centralizes the form +
  // edit-id reset alongside the inline add-origin UI state so no close path
  // can leak addingOrigin/newOriginInput into the next modal open.
  function closeCowForm() {
    setNotice(null);
    setShowAddForm(false);
    setEditId(null);
    setForm(null);
    setAddingOrigin(false);
    setNewOriginInput('');
  }
  function openAdd() {
    setNotice(null);
    setForm({...EMPTY_COW});
    setEditId(null);
    setAddingOrigin(false);
    setNewOriginInput('');
    setShowAddForm(true);
  }
  function openEdit(cow) {
    setNotice(null);
    setForm({
      ...EMPTY_COW,
      ...cow,
      pct_wagyu: cow.pct_wagyu != null ? String(cow.pct_wagyu) : '',
      purchase_amount: cow.purchase_amount != null ? String(cow.purchase_amount) : '',
      sale_amount: cow.sale_amount != null ? String(cow.sale_amount) : '',
      birth_date: cow.birth_date || '',
      purchase_date: cow.purchase_date || '',
      sale_date: cow.sale_date || '',
      death_date: cow.death_date || '',
      breeding_status: cow.breeding_status || '',
      old_tags: Array.isArray(cow.old_tags)
        ? cow.old_tags.map(function (t) {
            return {
              tag: t.tag || '',
              changed_at: (t.changed_at || '').slice(0, 10),
              source: t.source || 'manual',
            };
          })
        : [],
    });
    setEditId(cow.id);
    setAddingOrigin(false);
    setNewOriginInput('');
    setShowAddForm(true);
  }
  async function saveCow() {
    if (!form.tag.trim()) {
      window._wcfConfirm(
        'Save cow without a tag? (For unweaned calves; admin can tag later.)',
        () => {
          void proceedSaveCow();
        },
        'Save',
      );
      return;
    }
    await proceedSaveCow();
  }
  async function proceedSaveCow() {
    setSaving(true);
    const isFemale = form.sex === 'cow' || form.sex === 'heifer';
    const rec = {
      tag: form.tag.trim() || null,
      sex: form.sex,
      herd: form.herd,
      breed: form.breed || null,
      breeding_blacklist: !!form.breeding_blacklist,
      pct_wagyu: form.pct_wagyu !== '' ? parseInt(form.pct_wagyu) : null,
      origin: form.origin || null,
      birth_date: form.birth_date || null,
      purchase_date: form.purchase_date || null,
      purchase_amount: form.purchase_amount !== '' ? parseFloat(form.purchase_amount) : null,
      dam_tag: form.dam_tag || null,
      sire_tag: form.sire_tag || null,
      registration_num: form.registration_num || null,
      breeding_status: isFemale ? form.breeding_status || null : null,
      sale_date: form.sale_date || null,
      sale_amount: form.sale_amount !== '' ? parseFloat(form.sale_amount) : null,
      death_date: form.death_date || null,
      death_reason: form.death_reason || null,
      old_tags: (Array.isArray(form.old_tags) ? form.old_tags : [])
        .map(function (t) {
          var tag = String(t.tag || '').trim();
          if (!tag) return null;
          var out = {tag: tag};
          if (t.changed_at)
            out.changed_at = t.changed_at.length === 10 ? t.changed_at + 'T12:00:00.000Z' : t.changed_at;
          if (t.source) out.source = t.source;
          return out;
        })
        .filter(Boolean),
    };
    setNotice(null);
    let newId = editId;
    if (editId) {
      const oldCow = cattle.find((c) => c.id === editId);
      const result = await runMutation(() => sb.from('cattle').update(rec).eq('id', editId), {
        activity: () => {
          const changes = buildChanges(oldCow, rec, {
            exclude: CATTLE_EXCLUDE,
            labels: CATTLE_LABELS,
            formatters: CATTLE_FORMATTERS,
          });
          if (changes.length === 0) return;
          return recordFieldChange(sb, {
            entityType: 'cattle.animal',
            entityId: editId,
            entityLabel: rec.tag || oldCow?.tag || editId,
            changes,
          });
        },
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      });
      if (!result.ok) {
        setSaving(false);
        return;
      }
    } else {
      newId = (rec.tag ? 'c-' + rec.tag : 'c-' + Date.now()) + '-' + Math.random().toString(36).slice(2, 5);
      const {error} = await sb.from('cattle').insert({id: newId, ...rec});
      if (error) {
        setNotice({kind: 'error', message: 'Save failed: ' + error.message});
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    await loadAll();
    closeCowForm();
  }
  async function patchCow(cowId, fields) {
    if (!cowId || !fields) return;
    setNotice(null);
    const cow = cattle.find((c) => c.id === cowId);
    const result = await runMutation(() => sb.from('cattle').update(fields).eq('id', cowId), {
      activity: () => {
        const changes = buildChanges(cow, fields, {
          exclude: CATTLE_EXCLUDE,
          labels: CATTLE_LABELS,
          formatters: CATTLE_FORMATTERS,
        });
        if (changes.length === 0) return;
        return recordFieldChange(sb, {
          entityType: 'cattle.animal',
          entityId: cowId,
          entityLabel: fields.tag || cow?.tag || cowId,
          changes,
        });
      },
      onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    if (result.ok) setCattle((prev) => prev.map((c) => (c.id === cowId ? {...c, ...fields} : c)));
  }
  async function deleteCow(id) {
    if (!window._wcfConfirmDelete) return;
    const cow = cattle.find((c) => c.id === id);
    window._wcfConfirmDelete('Delete this cow record? An admin can restore it later.', async () => {
      try {
        await softDeleteCattleAnimal(sb, id, cow?.tag || id);
        await loadAll();
        closeCowForm();
        setNotice({kind: 'success', message: 'Cow #' + (cow?.tag || id) + ' deleted.'});
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }
  async function addCalvingRecord(cow, formData) {
    setNotice(null);
    if (!formData.calving_date) {
      setNotice({kind: 'error', message: 'Calving date required.'});
      return false;
    }
    if (formData.complications_flag && !(formData.complications_desc || '').trim()) {
      setNotice({kind: 'error', message: 'Complications description required when complications flag is set.'});
      return false;
    }
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      dam_tag: cow.tag,
      calving_date: formData.calving_date,
      calf_tag: formData.calf_tag || null,
      sire_tag: formData.sire_tag || null,
      total_born: parseInt(formData.total_born) || 0,
      deaths: parseInt(formData.deaths) || 0,
      complications_flag: !!formData.complications_flag,
      complications_desc: formData.complications_desc || null,
      notes: formData.notes || null,
    };
    const {error} = await sb.from('cattle_calving_records').insert(rec);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return false;
    }
    await loadAll();
    return true;
  }
  async function deleteCalvingRecord(recId) {
    if (!window._wcfConfirmDelete) return;
    window._wcfConfirmDelete('Delete this calving record?', async () => {
      try {
        // Transactional RPC: deletes the row + logs a deletion Activity event
        // scoped to the dam, atomically.
        await deleteCattleCalvingRecord(sb, recId, authState && authState.name ? authState.name : null);
        await loadAll();
      } catch (e) {
        setNotice({kind: 'error', message: 'Delete failed: ' + (e.message || String(e))});
      }
    });
  }
  function lastCalving(tag) {
    return lastCalvingRecordFor(tag, calvingEvidence);
  }
  function calfCount(tag) {
    return calfCountFor(tag, calvingEvidence);
  }

  // ── filter / sort UI subcomponents (inline for context) ────────────────────
  // eslint-disable-next-line no-unused-vars -- JSX-only use
  function FilterChip({label, active, onClick, dataAttr}) {
    return (
      <button
        type="button"
        onClick={onClick}
        style={active ? chipActiveS : chipBaseS}
        data-filter-chip={dataAttr || undefined}
      >
        {label}
      </button>
    );
  }

  // ── chip helpers (label + active/clear) shared by all filter groups ─────────
  function chipActiveFor(key) {
    if (key === 'nonCalving') return filters.nonCalvingCows === true || !!filters.nonCalvingCutoffDate;
    if (key === 'calvedStatus') return 'calvedStatus' in filters || !!filters.calvingWindow;
    return key in filters;
  }
  function clearChip(key) {
    if (key === 'nonCalving') {
      clearFilter('nonCalvingCows');
      clearFilter('nonCalvingCutoffDate');
      return;
    }
    if (key === 'calvedStatus') {
      clearFilter('calvedStatus');
      clearFilter('calvingWindow');
      return;
    }
    clearFilter(key);
  }

  function chipLabelFor(key) {
    const active = chipActiveFor(key);
    switch (key) {
      case 'herdSet':
        return active ? 'Herd: ' + (filters.herdSet || []).map((h) => HERD_LABELS[h] || h).join(', ') : '+ Herd';
      case 'sex':
        return active
          ? 'Sex: ' + (filters.sex || []).map((s) => (SEX_OPTIONS.find((o) => o.key === s) || {}).label || s).join(', ')
          : '+ Sex';
      case 'ageMonthsRange': {
        if (!active) return '+ Age';
        const r = [];
        if (filters.ageMonthsRange.min != null) r.push('≥' + filters.ageMonthsRange.min + 'mo');
        if (filters.ageMonthsRange.max != null) r.push('≤' + filters.ageMonthsRange.max + 'mo');
        return 'Age: ' + r.join(' ');
      }
      case 'breed':
        return active ? 'Breed: ' + (filters.breed || []).join(', ') : '+ Breed';
      case 'origin':
        return active ? 'Origin: ' + (filters.origin || []).join(', ') : '+ Origin';
      case 'weightTier': {
        if (!active) return '+ Weight';
        const tierLabels = {
          hasWeight: 'has weight',
          noWeight: 'no weight',
          staleWeight: 'stale weight',
          staleOrNoWeight: 'stale or no weight',
        };
        return 'Weight: ' + (tierLabels[filters.weightTier] || filters.weightTier);
      }
      case 'nonCalving': {
        // Single user-facing control is the "No calf since" date. A legacy
        // persisted nonCalvingCows boolean (no date) still shows the chip active
        // with its 9-month default label, but the checkbox is no longer exposed.
        if (filters.nonCalvingCutoffDate) return 'No calf since ' + filters.nonCalvingCutoffDate;
        if (filters.nonCalvingCows === true) return 'No calf since (9-mo default)';
        return '+ No calf since';
      }
      case 'calvedStatus': {
        if ('calvedStatus' in filters) return 'Calved: ' + (filters.calvedStatus === 'yes' ? 'yes' : 'no');
        if (filters.calvingWindow && filters.calvingWindow.mode === 'noneSince')
          return 'Not calved since ' + filters.calvingWindow.since;
        return '+ Calved';
      }
      case 'lastCalvedRange': {
        if (!active) return '+ Last calved';
        const r = filters.lastCalvedRange;
        return 'Last calved ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
      }
      case 'calfCountRange': {
        if (!active) return '+ Calf count';
        const r = filters.calfCountRange;
        const parts = [];
        if (r.min != null) parts.push('≥' + r.min);
        if (r.max != null) parts.push('≤' + r.max);
        return 'Calves ' + parts.join(' ');
      }
      case 'breedingStatus':
        return active
          ? 'Status: ' +
              (filters.breedingStatus || [])
                .map((s) => (BREEDING_STATUS_OPTIONS.find((o) => o.key === s) || {}).label || s)
                .join(', ')
          : '+ Breeding status';
      case 'breedingBlacklist':
        if (filters.breedingBlacklist === true) return 'Blacklist: only';
        if (filters.breedingBlacklist === false) return 'Blacklist: hide';
        return '+ Blacklist';
      case 'damPresence':
        return active ? 'Dam: ' + filters.damPresence : '+ Dam';
      case 'sirePresence':
        return active ? 'Sire: ' + filters.sirePresence : '+ Sire';
      case 'birthDateRange': {
        if (!active) return '+ Birth date';
        const r = filters.birthDateRange;
        return 'Born ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
      }
      case 'wagyuPctRange': {
        if (!active) return '+ Wagyu %';
        const r = filters.wagyuPctRange;
        const parts = [];
        if (r.min != null) parts.push('≥' + r.min);
        if (r.max != null) parts.push('≤' + r.max);
        return 'Wagyu ' + parts.join(' ') + '%';
      }
      case 'weightRange': {
        if (!active) return '+ Weight range';
        const r = filters.weightRange;
        const parts = [];
        if (r.min != null) parts.push('≥' + r.min + 'lb');
        if (r.max != null) parts.push('≤' + r.max + 'lb');
        return 'Weight ' + parts.join(' ');
      }
      default:
        return key;
    }
  }

  // Popover filter chip (value picker).
  function renderFilterChip(key) {
    const active = chipActiveFor(key);
    const isOpen = openFilter === key;
    return (
      <div key={key} style={{position: 'relative', display: 'inline-block'}}>
        <FilterChip
          label={chipLabelFor(key) + (active ? ' ×' : '')}
          active={active}
          dataAttr={key}
          onClick={(e) => {
            if (active && (e.shiftKey || e.metaKey || e.altKey)) {
              clearChip(key);
              return;
            }
            setOpenFilter(isOpen ? null : key);
          }}
        />
        {isOpen && (
          <FilterChipPopover
            filterKey={key}
            filters={filters}
            setFilters={setFilters}
            setFilter={setFilter}
            clearFilter={clearFilter}
            toggleFilterArrayValue={toggleFilterArrayValue}
            breedFilterOptions={breedFilterOptions}
            originFilterOptions={originFilterOptions}
            onClose={() => setOpenFilter(null)}
          />
        )}
      </div>
    );
  }

  // Checkbox-style boolean filter (a labeled checkbox, not a pill chip) — e.g.
  // Unmatched Calves, which sits in Lineage/Other beside Dam/Sire.
  function renderCheckboxFilter(key) {
    const checked = filters[key] === true;
    const label = CHECKBOX_FILTER_LABELS[key] || key;
    return (
      <label
        key={key}
        data-cattle-special-filter={key}
        style={{
          // Pushed to the right edge of its group row so it sits off to the
          // side rather than mid-row among the chip filters.
          marginLeft: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 10,
          border: checked ? `1px solid ${CATTLE_ACCENT}` : '1px solid var(--border-strong)',
          background: checked ? '#fef2f2' : 'white',
          color: checked ? CATTLE_ACCENT : 'var(--ink)',
          fontSize: 12,
          fontWeight: checked ? 600 : 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setFilter(key, e.target.checked ? true : null)}
          data-cattle-special-filter-checkbox={key}
          style={{margin: 0}}
        />
        <span>{label}</span>
      </label>
    );
  }

  function renderFilterGroups() {
    return FILTER_GROUPS.map((g) => (
      <div
        key={g.key}
        data-filter-group={g.key}
        style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}
      >
        <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600, marginRight: 4, minWidth: 96}}>
          {g.label}
        </span>
        {g.keys.map((key) => (CHECKBOX_FILTER_KEYS.has(key) ? renderCheckboxFilter(key) : renderFilterChip(key)))}
      </div>
    ));
  }

  function sortBar() {
    const used = new Set(sortRules.map((r) => r.key));
    const available = CATTLE_SORT_KEYS.filter((k) => !used.has(k));
    return (
      <div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
        <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600, marginRight: 4}}>Sort:</span>
        {sortRules.length === 0 && (
          <span style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>(none)</span>
        )}
        {sortRules.map((r, i) => (
          <span
            key={r.key}
            data-sort-rule={r.key}
            data-sort-dir={r.dir}
            style={{
              ...chipActiveS,
              cursor: 'default',
              gap: 4,
              border: '1px solid var(--border-strong)',
              background: 'white',
              color: 'var(--ink)',
              fontWeight: 500,
            }}
          >
            <span style={{fontWeight: 600, color: CATTLE_ACCENT}}>{i + 1}.</span>
            <span>{SORT_KEY_LABELS[r.key] || r.key}</span>
            <button
              type="button"
              onClick={() => flipSortDir(i)}
              title="Toggle direction"
              style={{
                fontSize: 11,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                borderRadius: 10,
                padding: '0 6px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {(SORT_DIR_LABELS[r.key] || {})[r.dir] || r.dir}
            </button>
            <button
              type="button"
              onClick={() => moveSortRule(i, -1)}
              disabled={i === 0}
              title="Move up"
              style={{
                background: 'none',
                border: 'none',
                color: i === 0 ? 'var(--border-strong)' : 'var(--ink-muted)',
                cursor: i === 0 ? 'not-allowed' : 'pointer',
                fontSize: 12,
                padding: '0 2px',
              }}
            >
              {'▲'}
            </button>
            <button
              type="button"
              onClick={() => moveSortRule(i, 1)}
              disabled={i === sortRules.length - 1}
              title="Move down"
              style={{
                background: 'none',
                border: 'none',
                color: i === sortRules.length - 1 ? 'var(--border-strong)' : 'var(--ink-muted)',
                cursor: i === sortRules.length - 1 ? 'not-allowed' : 'pointer',
                fontSize: 12,
                padding: '0 2px',
              }}
            >
              {'▼'}
            </button>
            <button
              type="button"
              onClick={() => removeSortRule(i)}
              title="Remove sort"
              style={{
                background: 'none',
                border: 'none',
                color: '#b91c1c',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: '0 4px',
              }}
            >
              {'×'}
            </button>
          </span>
        ))}
        {available.length > 0 && (
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) {
                addSortRule(e.target.value);
                e.target.value = '';
              }
            }}
            style={{...inpS, width: 'auto', fontSize: 11, padding: '4px 8px'}}
            data-sort-add
          >
            <option value="">+ Sort by…</option>
            {available.map((k) => (
              <option key={k} value={k}>
                {SORT_KEY_LABELS[k] || k}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  // Cow columns for the always-flat list, rendered through the shared
  // <DataTable>. The full set is built here; the column/display picker
  // (columnVisible) decides which actually render. Calf count + last-calved
  // render for FEMALES (cow/heifer). Rows go through <DataTable>, which owns the
  // hover/keyboard affordance — this file no longer renders its own faux-grid
  // rows (filters/sort/saved-views/CSV/print logic unchanged).
  const ellipsisCellS = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 160,
  };
  function cowTableColumns() {
    const female = (c) => c.sex === 'cow' || c.sex === 'heifer';
    const money = (v) => (v != null && v !== '' ? '$' + Number(v).toLocaleString() : '—');
    const dateCell = (v) => <StatusText tone="muted">{v ? fmt(v) : '—'}</StatusText>;
    const textCell = (v) => <StatusText tone="muted">{v || '—'}</StatusText>;
    return [
      {
        key: 'tag',
        label: 'Tag',
        primary: true,
        render: (c) => (
          <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
            <span style={{fontWeight: 700}}>{c.tag ? '#' + c.tag : '(no tag)'}</span>
            {c.breeding_blacklist && <Badge variant="danger">BLACKLIST</Badge>}
          </span>
        ),
      },
      {
        key: 'herd',
        label: 'Herd',
        render: (c) => (
          <span style={{fontSize: 11, color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap'}}>
            {HERD_LABELS[c.herd]}
          </span>
        ),
      },
      {key: 'sex', label: 'Sex', render: (c) => <StatusText tone="muted">{c.sex || '—'}</StatusText>},
      {
        key: 'breed',
        label: 'Breed',
        render: (c) => (
          <StatusText tone="muted" style={ellipsisCellS}>
            {c.breed || '—'}
          </StatusText>
        ),
      },
      {
        key: 'origin',
        label: 'Origin',
        render: (c) => (
          <StatusText tone="muted" style={ellipsisCellS}>
            <span data-cattle-row-origin={c.id}>{c.origin || '—'}</span>
          </StatusText>
        ),
      },
      {
        key: 'age',
        label: 'Age',
        align: 'right',
        render: (c) => <StatusText tone="muted">{age(c.birth_date) || '—'}</StatusText>,
      },
      {key: 'birthDate', label: 'Birth Date', align: 'right', render: (c) => dateCell(c.birth_date)},
      {
        key: 'lastWeight',
        label: 'Last Weight',
        align: 'right',
        render: (c) => {
          const lw = lastWeight(c);
          return lw ? (
            <StatusText tone="ok">{lw.toLocaleString() + ' lb'}</StatusText>
          ) : (
            <StatusText tone="muted">no weigh-in</StatusText>
          );
        },
      },
      {
        key: 'lastWeighed',
        label: 'Last Weighed',
        align: 'right',
        render: (c) => {
          const e = lastWeightEntryFor(c, weighIns);
          return <StatusText tone="muted">{e?.entered_at ? fmt(String(e.entered_at).slice(0, 10)) : '—'}</StatusText>;
        },
      },
      {
        key: 'lastCalved',
        label: 'Last Calved',
        align: 'right',
        render: (c) => {
          const lc = female(c) ? lastCalving(c.tag) : null;
          return <StatusText tone="muted">{lc?.calving_date ? fmt(lc.calving_date) : '—'}</StatusText>;
        },
      },
      {
        key: 'calfCount',
        label: 'Calf Count',
        align: 'right',
        render: (c) => {
          const cc = female(c) ? calfCount(c.tag) : null;
          return cc == null ? (
            <StatusText tone="muted">—</StatusText>
          ) : (
            <span data-calf-count={cc} style={{fontSize: 12, color: 'var(--text-primary)', fontWeight: 600}}>
              {cc}
            </span>
          );
        },
      },
      {key: 'breedingStatus', label: 'Breeding Status', render: (c) => textCell(c.breeding_status)},
      {
        key: 'breedingBlacklist',
        label: 'Breeding Blacklist',
        render: (c) =>
          c.breeding_blacklist ? <Badge variant="danger">YES</Badge> : <StatusText tone="muted">no</StatusText>,
      },
      {
        key: 'damTag',
        label: 'Dam Tag',
        render: (c) => <StatusText tone="muted">{c.dam_tag ? '#' + c.dam_tag : '—'}</StatusText>,
      },
      {
        key: 'sireTag',
        label: 'Sire Tag',
        render: (c) => <StatusText tone="muted">{c.sire_tag ? '#' + c.sire_tag : '—'}</StatusText>,
      },
      {
        key: 'pctWagyu',
        label: '% Wagyu',
        align: 'right',
        render: (c) => (
          <StatusText tone="muted">{c.pct_wagyu != null && c.pct_wagyu !== '' ? c.pct_wagyu + '%' : '—'}</StatusText>
        ),
      },
      {key: 'registrationNum', label: 'Registration #', render: (c) => textCell(c.registration_num)},
      {key: 'purchaseDate', label: 'Purchase Date', align: 'right', render: (c) => dateCell(c.purchase_date)},
      {
        key: 'purchaseAmount',
        label: 'Purchase Amount',
        align: 'right',
        render: (c) => <StatusText tone="muted">{money(c.purchase_amount)}</StatusText>,
      },
      {key: 'saleDate', label: 'Sale Date', align: 'right', render: (c) => dateCell(c.sale_date)},
      {
        key: 'saleAmount',
        label: 'Sale Amount',
        align: 'right',
        render: (c) => <StatusText tone="muted">{money(c.sale_amount)}</StatusText>,
      },
      {key: 'deathDate', label: 'Death Date', align: 'right', render: (c) => dateCell(c.death_date)},
      {
        key: 'deathReason',
        label: 'Death Reason',
        render: (c) => (
          <StatusText tone="muted" style={ellipsisCellS}>
            {c.death_reason || '—'}
          </StatusText>
        ),
      },
      {key: 'recordId', label: 'Record ID', render: (c) => <StatusText tone="muted">{c.id || '—'}</StatusText>},
    ].filter((col) => columnVisible(col.key));
  }

  // Shared <DataTable> renderer for the cattle list. `navList` is the exact
  // visible-order array (sortedFlat for flat; per-herd cows for grouped) so the
  // record page's sequence nav still walks the on-screen order. The per-row
  // hooks (id="cow-<id>", data-cow-row-tag) and the blacklist row tint are
  // preserved via rowProps + rowStyle.
  // eslint-disable-next-line no-unused-vars -- JSX-only use
  function CattleDataTable({navList, surfaceKey}) {
    return (
      <DataTable
        surfaceKey={surfaceKey}
        rowKey="id"
        showRowNumbers
        columns={cowTableColumns()}
        rows={navList}
        onRowOpen={(c) => navigate('/cattle/herds/' + c.id, recordSeqNavOptions(navList))}
        rowProps={(c) => ({id: 'cow-' + c.id, 'data-cow-row-tag': c.tag || ''})}
        rowStyle={(c) => (c.breeding_blacklist ? {background: '#fecaca'} : undefined)}
      />
    );
  }

  // ── derived UI flags ───────────────────────────────────────────────────────
  const filterCount = Object.keys(filters).length;
  const search = filters.textSearch || '';

  // Saved-view picker partition: my views (any visibility) vs other people's
  // public views. RLS already excludes other people's PRIVATE views from the
  // list, so publicOtherViews is simply public rows I don't own.
  const myViews = savedViews.filter((v) => myProfileId && v.owner_profile_id === myProfileId);
  const publicOtherViews = savedViews.filter(
    (v) => v.visibility === 'public' && !(myProfileId && v.owner_profile_id === myProfileId),
  );
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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: `1px solid ${CATTLE_ACCENT}`, color: CATTLE_ACCENT};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };
  // Selected tool button = solid program-color fill with a white glyph (matches
  // the filled program tab in the top nav); unselected = white with dark glyph.
  const toolButtonS = (active = false) => ({
    width: 34,
    height: 34,
    borderRadius: 10,
    border: active ? `1px solid ${CATTLE_ACCENT}` : '1px solid var(--border-strong)',
    background: active ? CATTLE_ACCENT : 'white',
    color: active ? getReadableText(CATTLE_ACCENT) : 'var(--ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    flex: '0 0 auto',
  });
  const columnsGhostBtnS = {
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
  const toolPanelS = {
    borderTop: '1px solid var(--border)',
    paddingTop: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  };
  function toggleToolPanel(panel) {
    setOpenFilter(null);
    setOpenToolPanel((cur) => (cur === panel ? null : panel));
  }

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
      <div
        style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}
        data-cattle-herds-loaded={loading || loadError ? 'false' : 'true'}
      >
        {!showAddForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {loadError && (
          <div data-cattle-herds-load-error="true">
            <InlineNotice notice={loadError} />
            <button
              type="button"
              data-cattle-herds-load-retry="1"
              onClick={loadAll}
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
          </div>
        )}

        {!loadError && (
          <>
            {openToolPanel === 'savedViews' && (
              <div
                data-saved-views-row
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
                  <span style={{fontSize: 12, color: '#b91c1c'}} data-saved-views-error>
                    Saved views unavailable. Filters still work.
                  </span>
                ) : (
                  <>
                    <select
                      data-saved-view-select
                      value={selectedViewId}
                      disabled={savedViewsLoading}
                      onChange={(e) => onSelectSavedView(e.target.value)}
                      style={{...inpS, width: 'auto', minWidth: 200, fontSize: 12, padding: '6px 10px'}}
                    >
                      <option value="">{savedViewsLoading ? 'Loading…' : '— Select a saved view —'}</option>
                      {myViews.length > 0 && (
                        <optgroup label="My views">
                          {myViews.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name + (v.visibility === 'public' ? ' · public' : ' · private')}
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
                          data-saved-view-update
                          onClick={updateSelectedView}
                          disabled={savedViewBusy}
                          style={savedViewGhostBtnS}
                        >
                          Update to current
                        </button>
                        <button
                          type="button"
                          data-saved-view-delete
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
                      data-saved-view-save-open
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
            {openToolPanel === 'savedViews' && showSaveViewForm && (
              <div
                data-saved-view-form
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
                  data-saved-view-name
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
                    name="saveViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-saved-view-save
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

            {/* Top toolbar */}
            <div
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
                  value={search}
                  onChange={(e) => setFilter('textSearch', e.target.value)}
                  placeholder="Search by tag, dam, sire, breed, origin..."
                  style={{...inpS, flex: 1, minWidth: 200}}
                />
                <button
                  type="button"
                  data-cattle-herds-saved-views-toggle="1"
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
                  data-cattle-herds-filters-toggle="1"
                  aria-label="Filters"
                  title="Filters"
                  aria-expanded={openToolPanel === 'filters'}
                  onClick={() => toggleToolPanel('filters')}
                  style={toolButtonS(openToolPanel === 'filters')}
                >
                  ≡
                </button>
                <button
                  type="button"
                  data-cattle-herds-sort-toggle="1"
                  aria-label="Sort"
                  title="Sort"
                  aria-expanded={openToolPanel === 'sort'}
                  onClick={() => toggleToolPanel('sort')}
                  style={toolButtonS(openToolPanel === 'sort')}
                >
                  ↕
                </button>
                <span style={{position: 'relative', display: 'inline-flex'}}>
                  <button
                    type="button"
                    data-cattle-herds-columns-toggle="1"
                    aria-label="Columns"
                    title="Columns shown in the list"
                    aria-expanded={openToolPanel === 'columns'}
                    onClick={() => toggleToolPanel('columns')}
                    style={toolButtonS(openToolPanel === 'columns')}
                  >
                    ▦
                  </button>
                  {openToolPanel === 'columns' && (
                    <div
                      data-cattle-herds-columns
                      style={{
                        position: 'absolute',
                        top: 40,
                        left: 0,
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
                        Columns shown ({visibleColumns.length}/{CATTLE_HERD_COLUMNS.length})
                      </div>
                      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 10px'}}>
                        {CATTLE_HERD_COLUMNS.map((col) => (
                          <label
                            key={col.key}
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
                              checked={visibleColumns.includes(col.key)}
                              onChange={() => toggleColumn(col.key)}
                              data-cattle-column-toggle={col.key}
                              style={{flex: '0 0 auto', margin: 0, width: 15, height: 15}}
                            />
                            <span>{col.label}</span>
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
                          onClick={() => setVisibleColumns(CATTLE_HERD_COLUMNS.map((c) => c.key))}
                          data-cattle-columns-all
                          style={columnsGhostBtnS}
                        >
                          Show all
                        </button>
                        <button
                          type="button"
                          onClick={() => setVisibleColumns(CATTLE_DEFAULT_COLUMN_KEYS)}
                          data-cattle-columns-reset
                          style={columnsGhostBtnS}
                        >
                          Reset
                        </button>
                      </div>
                    </div>
                  )}
                </span>
                <button
                  type="button"
                  data-cattle-herds-export-csv="1"
                  aria-label="Export CSV"
                  title="Export CSV"
                  onClick={handleExportCsv}
                  disabled={loading}
                  style={{
                    ...toolButtonS(false),
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.65 : 1,
                  }}
                >
                  CSV
                </button>
                <button
                  type="button"
                  data-cattle-herds-print="1"
                  aria-label="Print"
                  title="Print"
                  onClick={handlePrintRows}
                  disabled={loading}
                  style={{
                    ...toolButtonS(false),
                    cursor: loading ? 'not-allowed' : 'pointer',
                    opacity: loading ? 0.65 : 1,
                  }}
                >
                  ⎙
                </button>
                <button
                  onClick={() => setShowBulkImport(true)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 10,
                    border: '1px solid var(--border-strong)',
                    background: 'white',
                    color: 'var(--ink)',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {'📥'} Bulk Import
                </button>
                <button
                  onClick={openAdd}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 10,
                    border: 'none',
                    background: getProgramColor('cattle'),
                    color: getReadableText(getProgramColor('cattle')),
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + Add Cow
                </button>
              </div>

              {openToolPanel === 'filters' && (
                <div data-cattle-filter-groups style={toolPanelS}>
                  {renderFilterGroups()}
                  {filterCount > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        style={{
                          ...chipBaseS,
                          color: '#b91c1c',
                          border: '1px solid #fecaca',
                          background: '#fef2f2',
                        }}
                      >
                        Clear all filters
                      </button>
                    </div>
                  )}
                </div>
              )}

              {openToolPanel === 'sort' && <div style={toolPanelS}>{sortBar()}</div>}

              <div style={{fontSize: 11, color: 'var(--ink-muted)'}} data-cattle-match-count>
                {sortedFlat.length} {sortedFlat.length === 1 ? 'match' : 'cattle match'}
                {filterCount > 0 && ' · ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's')}
                {sortRules.length > 0 && ' · ' + sortRules.length + ' sort' + (sortRules.length === 1 ? '' : 's')}
              </div>
            </div>

            {showBulkImport && (
              <CattleBulkImport
                sb={sb}
                breedOpts={breedOpts}
                originOpts={originOpts}
                existingCattle={cattle}
                onClose={() => setShowBulkImport(false)}
                onComplete={loadAll}
              />
            )}

            {loading && (
              <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)'}}>Loading{'…'}</div>
            )}
            {!loading && cattle.length === 0 && (
              <div
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
                No cattle records yet. Click <strong>+ Add Cow</strong> to add your first one, or wait for the Podio
                import.
              </div>
            )}

            {/* Flat cattle list (results are always flat) */}
            {!loading && cattle.length > 0 && (
              <div
                data-cattle-flat-list
                style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden'}}
              >
                <div
                  style={{
                    padding: '10px 16px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--ink-muted)',
                  }}
                >
                  {sortedFlat.length} cattle
                </div>
                {sortedFlat.length === 0 && (
                  <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
                    No cattle match the current filter.
                  </div>
                )}
                <CattleDataTable navList={sortedFlat} surfaceKey="cattle-herds-flat" />
              </div>
            )}

            {/* Outcome herds (processed / deceased / sold) stay browsable below
                the flat list; clicking one filters the flat list to it. */}
            {!loading && cattle.length > 0 && (
              <CollapsibleOutcomeSections
                cattle={cattle}
                weighIns={weighIns}
                HERD_LABELS={HERD_LABELS}
                OUTCOMES={CATTLE_OUTCOME_KEYS}
                fmt={fmt}
                setStatusFilter={(value) => {
                  if (!value || value === 'active' || value === 'all') {
                    clearFilter('herdSet');
                    return;
                  }
                  setFilter('herdSet', [value]);
                }}
                processingInfo={processingInfo}
                onCowClick={(c) => navigate('/cattle/herds/' + c.id)}
              />
            )}
          </>
        )}
      </div>

      {/* Add/Edit cow modal */}
      {showAddForm && form && (
        <div
          onClick={() => {
            closeCowForm();
          }}
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
            style={{
              background: 'white',
              borderRadius: 12,
              width: '100%',
              maxWidth: 640,
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
              <div style={{fontSize: 15, fontWeight: 600, color: 'var(--text-primary)'}}>
                {editId ? 'Edit Cow' : 'Add Cow'}
              </div>
              <button
                onClick={() => {
                  closeCowForm();
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--ink-faint)'}}
              >
                {'×'}
              </button>
            </div>
            <div
              style={{
                padding: '16px 20px',
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                maxHeight: '70vh',
                overflowY: 'auto',
              }}
            >
              <div style={{gridColumn: '1/-1'}}>
                <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
              </div>
              <div>
                <label style={lbl}>Tag #</label>
                <input
                  value={form.tag}
                  onChange={(e) => setForm({...form, tag: e.target.value})}
                  placeholder="Required (or blank for unweaned calf)"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sex</label>
                <select value={form.sex} onChange={(e) => setForm({...form, sex: e.target.value})} style={inpS}>
                  <option value="cow">Cow</option>
                  <option value="heifer">Heifer</option>
                  <option value="bull">Bull</option>
                  <option value="steer">Steer</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Herd *</label>
                <select value={form.herd} onChange={(e) => setForm({...form, herd: e.target.value})} style={inpS}>
                  {CATTLE_ALL_HERD_KEYS.map((h) => (
                    <option key={h} value={h}>
                      {HERD_LABELS[h]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Breed</label>
                <select
                  value={form.breed || ''}
                  onChange={(e) => setForm({...form, breed: e.target.value})}
                  style={inpS}
                >
                  <option value="">{'— select —'}</option>
                  {breedOpts
                    .filter(function (b) {
                      return b.active;
                    })
                    .map(function (b) {
                      return React.createElement('option', {key: b.id, value: b.label}, b.label);
                    })}
                  {form.breed &&
                    !breedOpts.some(function (b) {
                      return b.active && b.label === form.breed;
                    }) && <option value={form.breed}>{form.breed + ' (historical)'}</option>}
                </select>
              </div>
              <div>
                <label style={lbl}>% Wagyu</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={form.pct_wagyu}
                  onChange={(e) => setForm({...form, pct_wagyu: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Origin</label>
                <select
                  value={form.origin || ''}
                  onChange={function (e) {
                    var v = e.target.value;
                    if (v === '__add__') {
                      // Open the inline add-origin UI; form.origin stays unchanged
                      // until the operator types a name and clicks Save.
                      setNewOriginInput('');
                      setAddingOrigin(true);
                      return;
                    }
                    setForm({...form, origin: v});
                  }}
                  style={inpS}
                >
                  <option value="">{'— select —'}</option>
                  {originOpts
                    .filter(function (o) {
                      return o.active;
                    })
                    .map(function (o) {
                      return React.createElement('option', {key: o.id, value: o.label}, o.label);
                    })}
                  {form.origin &&
                    !originOpts.some(function (o) {
                      return o.active && o.label === form.origin;
                    }) && <option value={form.origin}>{form.origin}</option>}
                  <option value="__add__">{'+ Add new origin…'}</option>
                </select>
                {addingOrigin && (
                  <div style={{display: 'flex', gap: 6, marginTop: 6, alignItems: 'center'}}>
                    <input
                      autoFocus
                      type="text"
                      placeholder="New origin name"
                      value={newOriginInput}
                      onChange={(e) => setNewOriginInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setAddingOrigin(false);
                          setNewOriginInput('');
                        }
                      }}
                      style={{...inpS, flex: 1}}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        var name = (newOriginInput || '').trim();
                        if (!name) return;
                        var exists = originOpts.find(function (o) {
                          return o.label.toLowerCase() === name.toLowerCase();
                        });
                        if (exists) {
                          setForm({...form, origin: exists.label});
                          setAddingOrigin(false);
                          setNewOriginInput('');
                          return;
                        }
                        var id = 'origin-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                        sb.from('cattle_origins')
                          .insert({id: id, label: name, active: true})
                          .then(function () {
                            setOriginOpts(
                              [...originOpts, {id: id, label: name, active: true}].sort(function (a, b) {
                                return a.label.localeCompare(b.label);
                              }),
                            );
                            setForm({...form, origin: name});
                            setAddingOrigin(false);
                            setNewOriginInput('');
                          });
                      }}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 10,
                        border: 'none',
                        background: getProgramColor('cattle'),
                        color: getReadableText(getProgramColor('cattle')),
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingOrigin(false);
                        setNewOriginInput('');
                      }}
                      style={{
                        padding: '5px 12px',
                        borderRadius: 10,
                        border: '1px solid var(--border-strong)',
                        background: 'white',
                        color: 'var(--ink)',
                        fontSize: 11,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div>
                <label style={lbl}>Birth Date</label>
                <input
                  type="date"
                  value={form.birth_date}
                  onChange={(e) => setForm({...form, birth_date: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Purchase Date</label>
                <input
                  type="date"
                  value={form.purchase_date}
                  onChange={(e) => setForm({...form, purchase_date: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Purchase Amount ($)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.purchase_amount}
                  onChange={(e) => setForm({...form, purchase_amount: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Dam Tag #</label>
                <input
                  value={form.dam_tag}
                  onChange={(e) => setForm({...form, dam_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sire Tag # / Reg #</label>
                <input
                  value={form.sire_tag}
                  onChange={(e) => setForm({...form, sire_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Registration #</label>
                <input
                  value={form.registration_num}
                  onChange={(e) => setForm({...form, registration_num: e.target.value})}
                  style={inpS}
                />
              </div>
              {(form.sex === 'cow' || form.sex === 'heifer') && (
                <div>
                  <label style={lbl}>Breeding Status</label>
                  <select
                    value={form.breeding_status || ''}
                    onChange={(e) => setForm({...form, breeding_status: e.target.value})}
                    style={inpS}
                  >
                    <option value="">{'— not set —'}</option>
                    <option value="OPEN">Open</option>
                    <option value="PREGNANT">Pregnant</option>
                    <option value="N/A">N/A</option>
                  </select>
                </div>
              )}

              <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <label
                    style={{
                      ...lbl,
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--ink)',
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Prior Tags
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setForm({
                        ...form,
                        old_tags: [...(form.old_tags || []), {tag: '', changed_at: '', source: 'manual'}],
                      })
                    }
                    style={{
                      fontSize: 11,
                      color: 'var(--brand)',
                      background: 'none',
                      border: '1px dashed #bfdbfe',
                      borderRadius: 10,
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add Prior Tag
                  </button>
                </div>
                <div style={{fontSize: 11, color: 'var(--ink-muted)', marginBottom: 8}}>
                  Tags this cow had before her current one — the purchase tag from the selling farm, plus any tags
                  swapped out over time. Multiple entries supported.
                </div>
                {(form.old_tags || []).length === 0 && (
                  <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic', padding: '4px 0'}}>
                    No prior tags recorded.
                  </div>
                )}
                {(form.old_tags || []).map(function (t, ti) {
                  return (
                    <div
                      key={ti}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '100px 140px 1fr 30px',
                        gap: 8,
                        marginBottom: 6,
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="text"
                        placeholder="Tag #"
                        value={t.tag || ''}
                        onChange={function (e) {
                          var next = (form.old_tags || []).slice();
                          next[ti] = {...next[ti], tag: e.target.value};
                          setForm({...form, old_tags: next});
                        }}
                        style={{...inpS, fontSize: 12, padding: '6px 8px'}}
                      />
                      <input
                        type="date"
                        value={t.changed_at || ''}
                        onChange={function (e) {
                          var next = (form.old_tags || []).slice();
                          next[ti] = {...next[ti], changed_at: e.target.value};
                          setForm({...form, old_tags: next});
                        }}
                        style={{...inpS, fontSize: 12, padding: '6px 8px'}}
                      />
                      <select
                        value={t.source || 'manual'}
                        onChange={function (e) {
                          var next = (form.old_tags || []).slice();
                          next[ti] = {...next[ti], source: e.target.value};
                          setForm({...form, old_tags: next});
                        }}
                        style={{...inpS, fontSize: 12, padding: '6px 8px'}}
                      >
                        <option value="import">Purchase tag (selling farm)</option>
                        <option value="weigh_in">Swapped tag (weigh-in)</option>
                        <option value="manual">Other / manual entry</option>
                      </select>
                      <button
                        type="button"
                        title="Remove"
                        onClick={function () {
                          var next = (form.old_tags || []).filter(function (_, i) {
                            return i !== ti;
                          });
                          setForm({...form, old_tags: next});
                        }}
                        style={{
                          background: 'none',
                          border: '1px solid #F09595',
                          borderRadius: 10,
                          color: '#b91c1c',
                          cursor: 'pointer',
                          fontSize: 14,
                          lineHeight: 1,
                          padding: '4px 6px',
                          fontFamily: 'inherit',
                        }}
                      >
                        {'×'}
                      </button>
                    </div>
                  );
                })}
              </div>

              {form.sex !== 'steer' && (
                <div style={{gridColumn: '1/-1', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4}}>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: 'pointer',
                      fontSize: 13,
                      color: '#7f1d1d',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!form.breeding_blacklist}
                      onChange={(e) => setForm({...form, breeding_blacklist: e.target.checked})}
                      style={{margin: 0, flexShrink: 0}}
                    />
                    <span>Breeding blacklist</span>
                  </label>
                  <div style={{fontSize: 11, color: 'var(--ink-faint)', marginLeft: 26, marginTop: 4}}>
                    Use the Issues section to record why.
                  </div>
                </div>
              )}

              {(form.herd === 'sold' || form.sale_date) && (
                <React.Fragment>
                  <div>
                    <label style={lbl}>Sale Date</label>
                    <input
                      type="date"
                      value={form.sale_date}
                      onChange={(e) => setForm({...form, sale_date: e.target.value})}
                      style={inpS}
                    />
                  </div>
                  <div>
                    <label style={lbl}>Sale Amount ($)</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={form.sale_amount}
                      onChange={(e) => setForm({...form, sale_amount: e.target.value})}
                      style={inpS}
                    />
                  </div>
                </React.Fragment>
              )}
              {(form.herd === 'deceased' || form.death_date) && (
                <React.Fragment>
                  <div>
                    <label style={lbl}>Death Date</label>
                    <input
                      type="date"
                      value={form.death_date}
                      onChange={(e) => setForm({...form, death_date: e.target.value})}
                      style={inpS}
                    />
                  </div>
                  <div>
                    <label style={lbl}>Death Reason</label>
                    <input
                      value={form.death_reason}
                      onChange={(e) => setForm({...form, death_reason: e.target.value})}
                      style={inpS}
                    />
                  </div>
                </React.Fragment>
              )}
            </div>
            <div style={{padding: '12px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8}}>
              <button
                onClick={saveCow}
                disabled={saving}
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: getProgramColor('cattle'),
                  color: getReadableText(getProgramColor('cattle')),
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : editId ? 'Save' : 'Add Cow'}
              </button>
              {editId && authState?.role === 'admin' && (
                <button
                  onClick={() => deleteCow(editId)}
                  style={{
                    padding: '8px 16px',
                    borderRadius: 10,
                    border: '1px solid var(--border)',
                    background: 'white',
                    color: 'var(--danger)',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Delete
                </button>
              )}
              <button
                onClick={() => {
                  closeCowForm();
                }}
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

// ── FilterChipPopover ────────────────────────────────────────────────────────
function FilterChipPopover({
  filterKey,
  filters,
  setFilters,
  setFilter,
  clearFilter,
  toggleFilterArrayValue,
  breedFilterOptions,
  originFilterOptions,
  onClose,
}) {
  const popS = {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    left: 0,
    background: 'white',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    padding: '10px 12px',
    boxShadow: '0 4px 16px rgba(0,0,0,.08)',
    zIndex: 50,
    minWidth: 260,
  };
  const rowS = {display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12};
  const choiceRowS = {
    display: 'grid',
    gridTemplateColumns: '18px 1fr',
    columnGap: 8,
    alignItems: 'center',
    marginBottom: 6,
    fontSize: 12,
    width: '100%',
    justifyItems: 'start',
  };
  const choiceTextS = {minWidth: 0, whiteSpace: 'nowrap'};

  function FemaleHint() {
    return (
      <div style={{fontSize: 10, color: 'var(--ink-muted)', fontStyle: 'italic', marginTop: 4}}>
        Applies to females only.
      </div>
    );
  }

  switch (filterKey) {
    case 'nonCalving':
      // Single user-facing control: the "No calf since" date. Setting it shows
      // mature (30+ month) cows/heifers whose last calving is missing or before
      // the date. No checkbox; no separate Age filter needed.
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>No calf since:</span>
            <input
              type="date"
              value={filters.nonCalvingCutoffDate || ''}
              onChange={(e) => {
                // The date is the only control: setting it clears any legacy
                // persisted boolean so state stays unambiguous.
                setFilter('nonCalvingCutoffDate', e.target.value || null);
                if (e.target.value) clearFilter('nonCalvingCows');
              }}
              data-cattle-noncalving-cutoff
              style={{...inpS, width: 150}}
            />
          </div>
          <div style={{fontSize: 10, color: 'var(--ink-muted)', marginTop: 4}}>
            Cows/heifers 30+ months old whose last calving is missing or before this date.
          </div>
          <PopoverFooter
            onClear={() => {
              clearFilter('nonCalvingCows');
              clearFilter('nonCalvingCutoffDate');
            }}
            onClose={onClose}
          />
        </div>
      );
    case 'herdSet':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {[...CATTLE_HERD_KEYS, ...CATTLE_OUTCOME_KEYS].map((h) => (
            <label key={h} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="checkbox"
                checked={(filters.herdSet || []).includes(h)}
                onChange={() => toggleFilterArrayValue('herdSet', h)}
              />
              <span style={choiceTextS}>{HERD_LABELS[h]}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('herdSet')} onClose={onClose} />
        </div>
      );
    case 'sex':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {SEX_OPTIONS.map((opt) => (
            <label key={opt.key} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="checkbox"
                checked={(filters.sex || []).includes(opt.key)}
                onChange={() => toggleFilterArrayValue('sex', opt.key)}
              />
              <span style={choiceTextS}>{opt.label}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('sex')} onClose={onClose} />
        </div>
      );
    case 'ageMonthsRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>Min months:</span>
            <input
              type="number"
              min="0"
              value={(filters.ageMonthsRange && filters.ageMonthsRange.min) ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? null : parseInt(e.target.value);
                setFilter('ageMonthsRange', {...(filters.ageMonthsRange || {}), min: v});
              }}
              style={{...inpS, width: 80}}
            />
          </div>
          <div style={rowS}>
            <span>Max months:</span>
            <input
              type="number"
              min="0"
              value={(filters.ageMonthsRange && filters.ageMonthsRange.max) ?? ''}
              onChange={(e) => {
                const v = e.target.value === '' ? null : parseInt(e.target.value);
                setFilter('ageMonthsRange', {...(filters.ageMonthsRange || {}), max: v});
              }}
              style={{...inpS, width: 80}}
            />
          </div>
          <PopoverFooter onClear={() => clearFilter('ageMonthsRange')} onClose={onClose} />
        </div>
      );
    case 'calvedStatus':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <label style={{...choiceRowS, cursor: 'pointer'}}>
            <input
              type="radio"
              name="calvedStatus"
              checked={filters.calvedStatus === 'yes' && !filters.calvingWindow}
              onChange={() => {
                clearFilter('calvingWindow');
                setFilter('calvedStatus', 'yes');
              }}
            />
            <span style={choiceTextS}>Has calved</span>
          </label>
          <label style={{...choiceRowS, cursor: 'pointer'}}>
            <input
              type="radio"
              name="calvedStatus"
              checked={filters.calvedStatus === 'no' && !filters.calvingWindow}
              onChange={() => {
                clearFilter('calvingWindow');
                setFilter('calvedStatus', 'no');
              }}
            />
            <span style={choiceTextS}>Never calved</span>
          </label>
          <label style={{...choiceRowS, cursor: 'pointer'}}>
            <input
              type="radio"
              name="calvedStatus"
              checked={!!filters.calvingWindow && filters.calvingWindow.mode === 'noneSince'}
              onChange={() => {
                clearFilter('calvedStatus');
                const yr = new Date().getUTCFullYear();
                setFilter('calvingWindow', {mode: 'noneSince', since: `${yr}-01-01`});
              }}
            />
            <span style={choiceTextS}>Not calved this year</span>
          </label>
          <FemaleHint />
          <PopoverFooter
            onClear={() => {
              clearFilter('calvedStatus');
              clearFilter('calvingWindow');
            }}
            onClose={onClose}
          />
        </div>
      );
    case 'breedingBlacklist':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <label style={{...choiceRowS, cursor: 'pointer'}}>
            <input
              type="radio"
              name="breedingBlacklist"
              checked={filters.breedingBlacklist === true}
              onChange={() => setFilter('breedingBlacklist', true)}
            />
            <span style={choiceTextS}>Only blacklisted</span>
          </label>
          <label style={{...choiceRowS, cursor: 'pointer'}}>
            <input
              type="radio"
              name="breedingBlacklist"
              checked={filters.breedingBlacklist === false}
              onChange={() => setFilter('breedingBlacklist', false)}
            />
            <span style={choiceTextS}>Hide blacklisted</span>
          </label>
          <PopoverFooter onClear={() => clearFilter('breedingBlacklist')} onClose={onClose} />
        </div>
      );
    case 'weightTier':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {[
            {k: 'hasWeight', label: 'Has weight'},
            {k: 'noWeight', label: 'No weight'},
            {k: 'staleWeight', label: 'Stale weight (>90 days)'},
            {k: 'staleOrNoWeight', label: 'Stale or no weight'},
          ].map((opt) => (
            <label key={opt.k} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="radio"
                name="weightTier"
                checked={filters.weightTier === opt.k}
                onChange={() => setFilter('weightTier', opt.k)}
              />
              <span style={choiceTextS}>{opt.label}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('weightTier')} onClose={onClose} />
        </div>
      );
    case 'birthDateRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>After:</span>
            <input
              type="date"
              value={(filters.birthDateRange && filters.birthDateRange.after) || ''}
              onChange={(e) =>
                setFilter('birthDateRange', {...(filters.birthDateRange || {}), after: e.target.value || null})
              }
              style={{...inpS, width: 140}}
            />
          </div>
          <div style={rowS}>
            <span>Before:</span>
            <input
              type="date"
              value={(filters.birthDateRange && filters.birthDateRange.before) || ''}
              onChange={(e) =>
                setFilter('birthDateRange', {...(filters.birthDateRange || {}), before: e.target.value || null})
              }
              style={{...inpS, width: 140}}
            />
          </div>
          <PopoverFooter onClear={() => clearFilter('birthDateRange')} onClose={onClose} />
        </div>
      );
    case 'lastCalvedRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>After:</span>
            <input
              type="date"
              value={(filters.lastCalvedRange && filters.lastCalvedRange.after) || ''}
              onChange={(e) =>
                setFilter('lastCalvedRange', {...(filters.lastCalvedRange || {}), after: e.target.value || null})
              }
              style={{...inpS, width: 140}}
            />
          </div>
          <div style={rowS}>
            <span>Before:</span>
            <input
              type="date"
              value={(filters.lastCalvedRange && filters.lastCalvedRange.before) || ''}
              onChange={(e) =>
                setFilter('lastCalvedRange', {...(filters.lastCalvedRange || {}), before: e.target.value || null})
              }
              style={{...inpS, width: 140}}
            />
          </div>
          <FemaleHint />
          <PopoverFooter onClear={() => clearFilter('lastCalvedRange')} onClose={onClose} />
        </div>
      );
    case 'calfCountRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>Min:</span>
            <input
              type="number"
              min="0"
              value={(filters.calfCountRange && filters.calfCountRange.min) ?? ''}
              onChange={(e) =>
                setFilter('calfCountRange', {
                  ...(filters.calfCountRange || {}),
                  min: e.target.value === '' ? null : parseInt(e.target.value),
                })
              }
              style={{...inpS, width: 80}}
            />
          </div>
          <div style={rowS}>
            <span>Max:</span>
            <input
              type="number"
              min="0"
              value={(filters.calfCountRange && filters.calfCountRange.max) ?? ''}
              onChange={(e) =>
                setFilter('calfCountRange', {
                  ...(filters.calfCountRange || {}),
                  max: e.target.value === '' ? null : parseInt(e.target.value),
                })
              }
              style={{...inpS, width: 80}}
            />
          </div>
          <FemaleHint />
          <PopoverFooter onClear={() => clearFilter('calfCountRange')} onClose={onClose} />
        </div>
      );
    case 'breedingStatus':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {BREEDING_STATUS_OPTIONS.map((opt) => (
            <label key={opt.key} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="checkbox"
                checked={(filters.breedingStatus || []).includes(opt.key)}
                onChange={() => toggleFilterArrayValue('breedingStatus', opt.key)}
              />
              <span style={choiceTextS}>{opt.label}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('breedingStatus')} onClose={onClose} />
        </div>
      );
    case 'damPresence':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {['any', 'present', 'missing'].map((v) => (
            <label key={v} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="radio"
                name="damPresence"
                checked={(filters.damPresence || 'any') === v}
                onChange={() => (v === 'any' ? clearFilter('damPresence') : setFilter('damPresence', v))}
              />
              <span style={choiceTextS}>{v}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('damPresence')} onClose={onClose} />
        </div>
      );
    case 'sirePresence':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          {['any', 'present', 'missing'].map((v) => (
            <label key={v} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="radio"
                name="sirePresence"
                checked={(filters.sirePresence || 'any') === v}
                onChange={() => (v === 'any' ? clearFilter('sirePresence') : setFilter('sirePresence', v))}
              />
              <span style={choiceTextS}>{v}</span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('sirePresence')} onClose={onClose} />
        </div>
      );
    case 'weightRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>Min lb:</span>
            <input
              type="number"
              min="0"
              value={(filters.weightRange && filters.weightRange.min) ?? ''}
              onChange={(e) =>
                setFilter('weightRange', {
                  ...(filters.weightRange || {}),
                  min: e.target.value === '' ? null : parseFloat(e.target.value),
                })
              }
              style={{...inpS, width: 100}}
            />
          </div>
          <div style={rowS}>
            <span>Max lb:</span>
            <input
              type="number"
              min="0"
              value={(filters.weightRange && filters.weightRange.max) ?? ''}
              onChange={(e) =>
                setFilter('weightRange', {
                  ...(filters.weightRange || {}),
                  max: e.target.value === '' ? null : parseFloat(e.target.value),
                })
              }
              style={{...inpS, width: 100}}
            />
          </div>
          <PopoverFooter onClear={() => clearFilter('weightRange')} onClose={onClose} />
        </div>
      );
    case 'breed':
      return (
        <div style={{...popS, maxHeight: 280, overflowY: 'auto'}} data-filter-popover={filterKey}>
          {breedFilterOptions.map((opt) => (
            <label key={opt.label} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="checkbox"
                checked={(filters.breed || []).includes(opt.label)}
                onChange={() => toggleFilterArrayValue('breed', opt.label)}
              />
              <span style={choiceTextS}>
                {opt.label}
                {opt.source === 'historical' && (
                  <em style={{color: 'var(--ink-faint)', marginLeft: 4}}>(historical)</em>
                )}
              </span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('breed')} onClose={onClose} />
        </div>
      );
    case 'origin':
      return (
        <div style={{...popS, maxHeight: 280, overflowY: 'auto'}} data-filter-popover={filterKey}>
          {originFilterOptions.map((opt) => (
            <label key={opt.label} style={{...choiceRowS, cursor: 'pointer'}}>
              <input
                type="checkbox"
                checked={(filters.origin || []).includes(opt.label)}
                onChange={() => toggleFilterArrayValue('origin', opt.label)}
              />
              <span style={choiceTextS}>
                {opt.label}
                {opt.source === 'historical' && (
                  <em style={{color: 'var(--ink-faint)', marginLeft: 4}}>(historical)</em>
                )}
              </span>
            </label>
          ))}
          <PopoverFooter onClear={() => clearFilter('origin')} onClose={onClose} />
        </div>
      );
    case 'wagyuPctRange':
      return (
        <div style={popS} data-filter-popover={filterKey}>
          <div style={rowS}>
            <span>Min %:</span>
            <input
              type="number"
              min="0"
              max="100"
              value={(filters.wagyuPctRange && filters.wagyuPctRange.min) ?? ''}
              onChange={(e) =>
                setFilter('wagyuPctRange', {
                  ...(filters.wagyuPctRange || {}),
                  min: e.target.value === '' ? null : parseFloat(e.target.value),
                })
              }
              style={{...inpS, width: 80}}
            />
          </div>
          <div style={rowS}>
            <span>Max %:</span>
            <input
              type="number"
              min="0"
              max="100"
              value={(filters.wagyuPctRange && filters.wagyuPctRange.max) ?? ''}
              onChange={(e) =>
                setFilter('wagyuPctRange', {
                  ...(filters.wagyuPctRange || {}),
                  max: e.target.value === '' ? null : parseFloat(e.target.value),
                })
              }
              style={{...inpS, width: 80}}
            />
          </div>
          <PopoverFooter onClear={() => clearFilter('wagyuPctRange')} onClose={onClose} />
        </div>
      );
    default:
      return null;
  }
}

function PopoverFooter({onClear, onClose}) {
  return (
    <div style={{display: 'flex', gap: 6, marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--divider)'}}>
      <button
        type="button"
        onClick={onClear}
        style={{
          fontSize: 11,
          color: '#b91c1c',
          background: 'none',
          border: '1px solid #fecaca',
          borderRadius: 10,
          padding: '3px 8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        Clear
      </button>
      <button
        type="button"
        onClick={onClose}
        style={{
          fontSize: 11,
          color: 'var(--ink)',
          background: 'white',
          border: '1px solid var(--border-strong)',
          borderRadius: 10,
          padding: '3px 8px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          marginLeft: 'auto',
        }}
      >
        Close
      </button>
    </div>
  );
}

export default CattleHerdsRouter;
