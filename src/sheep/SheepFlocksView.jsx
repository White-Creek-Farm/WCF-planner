// Sheep flocks view — full parity with CattleHerdsView. Ronnie's request
// 2026-04-23: every functionality matches the cattle herds tab; only
// field names and display data remain distinct.
//
// Key mechanics mirrored from CattleHerdsView:
//   * Top toolbar: search + status filter + sort + bulk import + add.
//   * Flat mode (search / non-active filter) vs tile mode (default).
//   * Inline-editable expanded tile via SheepDetail (no Edit modal).
//   * Outcome flocks (processed/deceased/sold) collapsed at bottom in
//     tile mode, fully searchable via filter.
//   * Navigation stack for dam/sire/lamb click-through.
//   * Add Sheep modal retained only for creating new records.
//   * Tag / age / weight / flock sort options.
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import UsersModal from '../auth/UsersModal.jsx';
import {openableProps} from '../shared/openable.js';
import SheepBulkImport from './SheepBulkImport.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import SheepAnimalPage from './SheepAnimalPage.jsx';
import SheepCollapsibleOutcomeSections from './SheepCollapsibleOutcomeSections.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import DataTable from '../shared/DataTable.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import StatusText from '../shared/StatusText.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {
  listSavedViews,
  createSavedView,
  updateSavedView,
  deleteSavedView,
  buildViewState,
} from '../lib/savedViewsApi.js';
import {usePersistentViewState} from '../lib/usePersistentViewState.js';
import {loadSheepWeighInsCached} from '../lib/sheepCache.js';
import {csvFilename, downloadCsv, rowsToCsv} from '../lib/csvExport.js';
import {printRows} from '../lib/printExport.js';
import {
  SHEEP_FLOCK_KEYS,
  SHEEP_OUTCOME_KEYS,
  SHEEP_ALL_FLOCK_KEYS,
  SHEEP_SORT_KEYS,
  buildLambingEvidence,
  buildSheepPredicate,
  buildSheepComparator,
  lastWeightFor,
  lastWeightEntryFor,
  lambCountFor,
  lastLambingRecordFor,
  mergeObservedSheepValues,
} from '../lib/sheepFlockFilters.js';

function SheepFlocksRouter(props) {
  const location = useLocation();
  const sheepDetailId = location.pathname.startsWith('/sheep/flocks/')
    ? location.pathname.slice('/sheep/flocks/'.length) || null
    : null;
  if (sheepDetailId) {
    return React.createElement(SheepAnimalPage, {
      sb: props.sb,
      fmt: props.fmt,
      authState: props.authState,
      Header: props.Header,
    });
  }
  return React.createElement(SheepFlocksHub, props);
}

const SHEEP_FLOCKS_SURFACE_KEY = 'sheep.flocks';

const SEX_OPTIONS = [
  {key: 'ewe', label: 'Ewe'},
  {key: 'ram', label: 'Ram'},
  {key: 'wether', label: 'Wether'},
  {key: 'lamb', label: 'Lamb'},
];

const BREEDING_STATUS_OPTIONS = [
  {key: 'Open', label: 'Open'},
  {key: 'Pregnant', label: 'Pregnant'},
  {key: 'N/A', label: 'N/A'},
  {key: 'unset', label: '(unset)'},
];

const SHEEP_SORT_KEY_LABELS = {
  tag: 'Tag',
  age: 'Age',
  lastWeight: 'Last weight',
  flock: 'Flock',
  sex: 'Sex',
  lastLambed: 'Last lambed',
  lambCount: 'Lamb count',
  breed: 'Breed',
  origin: 'Origin',
  breedingStatus: 'Breeding status',
};

const SHEEP_SORT_DIR_LABELS = {
  tag: {asc: 'low to high', desc: 'high to low'},
  age: {asc: 'youngest first', desc: 'oldest first'},
  lastWeight: {asc: 'lightest first', desc: 'heaviest first'},
  flock: {asc: 'active to outcome', desc: 'outcome to active'},
  sex: {asc: 'ewe to lamb', desc: 'lamb to ewe'},
  lastLambed: {asc: 'oldest first', desc: 'most recent first'},
  lambCount: {asc: 'fewest first', desc: 'most first'},
  breed: {asc: 'A to Z', desc: 'Z to A'},
  origin: {asc: 'A to Z', desc: 'Z to A'},
  breedingStatus: {asc: 'A to Z', desc: 'Z to A'},
};

const SHEEP_FILTER_GROUPS = [
  {key: 'core', label: 'Core', keys: ['flockSet', 'sex', 'ageMonthsRange', 'breed', 'origin', 'weightTier']},
  {
    key: 'lambing',
    label: 'Lambing/Breeding',
    keys: ['lambedStatus', 'lastLambedRange', 'lambCountRange', 'breedingStatus', 'breedingBlacklist', 'maternalIssue'],
  },
  {key: 'lineage', label: 'Lineage/Other', keys: ['damPresence', 'sirePresence', 'birthDateRange', 'weightRange']},
];

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
const chipActiveS = {
  ...chipBaseS,
  border: '1px solid #0f766e',
  background: 'white',
  color: '#0f766e',
  fontWeight: 600,
};

const SheepFlocksHub = ({
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
  const [sheep, setSheep] = useState([]);
  const [weighIns, setWeighIns] = useState([]);
  const [lambingRecs, setLambingRecs] = useState([]);
  const [notice, setNotice] = useState(null);
  const [breedOpts, setBreedOpts] = useState([]);
  const [originOpts, setOriginOpts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [viewMode, setViewMode] = usePersistentViewState('sheep.flocks.viewMode', 'grouped');
  const [filters, setFilters] = usePersistentViewState('sheep.flocks.filters', {});
  const [sortRules, setSortRules] = usePersistentViewState('sheep.flocks.sortRules', [{key: 'tag', dir: 'asc'}]);
  const [openFilter, setOpenFilter] = useState(null);
  const [openToolPanel, setOpenToolPanel] = useState(null);
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
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [expandedFlocks, setExpandedFlocks] = useState({});

  const FLOCKS = SHEEP_FLOCK_KEYS;
  const OUTCOMES = SHEEP_OUTCOME_KEYS;
  const ALL_FLOCKS = SHEEP_ALL_FLOCK_KEYS;
  const FLOCK_LABELS = {
    rams: 'Rams',
    ewes: 'Ewes',
    feeders: 'Feeders',
    processed: 'Processed',
    deceased: 'Deceased',
    sold: 'Sold',
  };
  const FLOCK_COLORS = {
    rams: {bg: '#f0fdfa', tx: '#0f766e', bd: '#5eead4'},
    ewes: {bg: '#fdf4ff', tx: '#86198f', bd: '#f0abfc'},
    feeders: {bg: '#fefce8', tx: '#854d0e', bd: '#fde047'},
    processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
    deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
    sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
  };

  const EMPTY_SHEEP = {
    tag: '',
    sex: 'ewe',
    flock: 'ewes',
    breed: '',
    breeding_blacklist: false,
    origin: '',
    birth_date: '',
    purchase_date: '',
    purchase_amount: '',
    dam_tag: '',
    dam_reg_num: '',
    sire_tag: '',
    sire_reg_num: '',
    registration_num: '',
    breeding_status: '',
    maternal_issue_flag: false,
    maternal_issue_desc: '',
    sale_date: '',
    sale_amount: '',
    death_date: '',
    death_reason: '',
    old_tags: [],
  };

  async function loadAll() {
    setLoading(true);
    setLoadError(null);
    try {
      const [sR, wAll, lR, brR, orR] = await Promise.all([
        sb.from('sheep').select('*').is('deleted_at', null).order('tag'),
        loadSheepWeighInsCached(sb, {throwOnError: true}),
        sb.from('sheep_lambing_records').select('*').order('lambing_date', {ascending: false}),
        sb.from('sheep_breeds').select('*').order('label'),
        sb.from('sheep_origins').select('*').order('label'),
      ]);
      if (sR.error) throw new Error('sheep: ' + (sR.error.message || sR.error));
      if (lR.error) throw new Error('sheep_lambing_records: ' + (lR.error.message || lR.error));
      if (brR.error) throw new Error('sheep_breeds: ' + (brR.error.message || brR.error));
      if (orR.error) throw new Error('sheep_origins: ' + (orR.error.message || orR.error));
      setSheep(sR.data || []);
      setWeighIns(wAll || []);
      setLambingRecs(lR.data || []);
      setBreedOpts(brR.data || []);
      setOriginOpts(orR.data || []);
    } catch (e) {
      setSheep([]);
      setWeighIns([]);
      setLambingRecs([]);
      setBreedOpts([]);
      setOriginOpts([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load sheep flocks. Please retry. (' + ((e && e.message) || e) + ')',
      });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    loadAll();
  }, []);

  async function loadSavedViews() {
    setSavedViewsLoading(true);
    try {
      const rows = await listSavedViews(sb, SHEEP_FLOCKS_SURFACE_KEY);
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

  function age(birth) {
    if (!birth) return null;
    const days = Math.floor((Date.now() - new Date(birth + 'T12:00:00').getTime()) / 86400000);
    if (days < 0) return null;
    const y = Math.floor(days / 365),
      m = Math.floor((days % 365) / 30);
    if (y > 0) return y + 'y ' + m + 'm';
    return m + 'm';
  }
  function lastWeight(s) {
    return lastWeightFor(s, weighIns);
  }
  function lastWeightEntry(s) {
    return lastWeightEntryFor(s, weighIns);
  }
  function lastLambing(tag) {
    return lastLambingRecordFor(tag, lambingEvidence);
  }
  function lambCount(tag) {
    return lambCountFor(tag, lambingEvidence);
  }

  const breedFilterOptions = useMemo(
    () => mergeObservedSheepValues(breedOpts, [...new Set(sheep.map((s) => s.breed).filter(Boolean))]),
    [breedOpts, sheep],
  );
  const originFilterOptions = useMemo(
    () => mergeObservedSheepValues(originOpts, [...new Set(sheep.map((s) => s.origin).filter(Boolean))]),
    [originOpts, sheep],
  );
  const lambingEvidence = useMemo(() => buildLambingEvidence(sheep, lambingRecs), [sheep, lambingRecs]);

  const filtered = useMemo(() => {
    const effectiveFilters = {...filters};
    const userSetFlock = Array.isArray(filters.flockSet) && filters.flockSet.length > 0;
    const searching = typeof filters.textSearch === 'string' && filters.textSearch.trim();
    if (!userSetFlock && !searching) {
      effectiveFilters.flockSet = [...SHEEP_FLOCK_KEYS];
    }
    const predicate = buildSheepPredicate(effectiveFilters, {
      todayMs: Date.now(),
      lambingRows: lambingEvidence,
      weighIns,
    });
    return sheep.filter(predicate);
  }, [sheep, filters, lambingEvidence, weighIns]);

  const sorted = useMemo(() => {
    const cmp = buildSheepComparator(sortRules, {
      lambingRows: lambingEvidence,
      weighIns,
    });
    return [...filtered].sort(cmp);
  }, [filtered, sortRules, lambingEvidence, weighIns]);

  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const selectedViewIsMine = !!(selectedView && myProfileId && selectedView.owner_profile_id === myProfileId);

  function legacySheepFiltersFromSavedView(st) {
    const next = {};
    if (typeof st.search === 'string' && st.search.trim()) next.textSearch = st.search;
    const validStatuses = new Set(['active', 'all', ...ALL_FLOCKS]);
    const status = validStatuses.has(st.statusFilter) ? st.statusFilter : 'active';
    if (status && status !== 'active' && status !== 'all') next.flockSet = [status];
    return next;
  }
  function legacySheepSortRulesFromSortBy(sortBy) {
    const map = {
      'tag-asc': [{key: 'tag', dir: 'asc'}],
      'tag-desc': [{key: 'tag', dir: 'desc'}],
      'age-asc': [{key: 'age', dir: 'asc'}],
      'age-desc': [{key: 'age', dir: 'desc'}],
      'weight-desc': [{key: 'lastWeight', dir: 'desc'}],
      'weight-asc': [{key: 'lastWeight', dir: 'asc'}],
    };
    return map[sortBy] || [{key: 'tag', dir: 'asc'}];
  }
  function sheepFlocksViewState() {
    return buildViewState({filters, sortRules, viewMode});
  }
  function applySheepSavedView(view) {
    if (!view) return;
    const st = view.view_state || {};
    if (st.filters && typeof st.filters === 'object') {
      setFilters(st.filters);
      setSortRules(Array.isArray(st.sortRules) ? st.sortRules : [{key: 'tag', dir: 'asc'}]);
      setViewMode(st.viewMode === 'flat' ? 'flat' : 'grouped');
    } else {
      setFilters(legacySheepFiltersFromSavedView(st));
      setSortRules(legacySheepSortRulesFromSortBy(st.sortBy));
      setViewMode(st.statusFilter && st.statusFilter !== 'active' ? 'flat' : 'grouped');
    }
    setOpenFilter(null);
    setOpenToolPanel(null);
  }
  function onSelectSavedView(id) {
    setSelectedViewId(id);
    if (!id) return;
    applySheepSavedView(savedViews.find((v) => v.id === id));
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
        surfaceKey: SHEEP_FLOCKS_SURFACE_KEY,
        name,
        visibility: saveViewVisibility,
        viewState: sheepFlocksViewState(),
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
      await updateSavedView(sb, selectedView.id, {viewState: sheepFlocksViewState()});
      await loadSavedViews();
      setNotice({kind: 'success', message: 'Updated "' + selectedView.name + '" to the current search/filter/sort.'});
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
  function sheepFlocksExportColumns() {
    const female = (row) => row.sex === 'ewe';
    return [
      {header: 'Tag', value: (s) => s.tag || ''},
      {header: 'Flock', value: (s) => FLOCK_LABELS[s.flock] || s.flock || ''},
      {header: 'Sex', value: (s) => s.sex || ''},
      {header: 'Breed', value: (s) => s.breed || ''},
      {header: 'Origin', value: (s) => s.origin || ''},
      {header: 'Age', value: (s) => age(s.birth_date) || ''},
      {header: 'Birth date', value: (s) => s.birth_date || ''},
      {header: 'Last weight lbs', value: (s) => lastWeight(s) ?? ''},
      {header: 'Last weighed', value: (s) => lastWeightEntry(s)?.entered_at || ''},
      {header: 'Last lambed', value: (s) => (female(s) ? lastLambing(s.tag)?.lambing_date || '' : '')},
      {header: 'Lamb count', value: (s) => (female(s) ? lambCount(s.tag) : '')},
      {header: 'Breeding status', value: (s) => s.breeding_status || ''},
      {header: 'Breeding blacklist', value: (s) => (s.breeding_blacklist ? 'yes' : 'no')},
      {header: 'Dam tag', value: (s) => s.dam_tag || ''},
      {header: 'Dam registration #', value: (s) => s.dam_reg_num || ''},
      {header: 'Sire tag', value: (s) => s.sire_tag || ''},
      {header: 'Sire registration #', value: (s) => s.sire_reg_num || ''},
      {header: 'Registration #', value: (s) => s.registration_num || ''},
      {header: 'Purchase date', value: (s) => s.purchase_date || ''},
      {header: 'Purchase amount', value: (s) => s.purchase_amount ?? ''},
      {header: 'Sale date', value: (s) => s.sale_date || ''},
      {header: 'Sale amount', value: (s) => s.sale_amount ?? ''},
      {header: 'Death date', value: (s) => s.death_date || ''},
      {header: 'Death reason', value: (s) => s.death_reason || ''},
      {header: 'Record ID', value: (s) => s.id || ''},
    ];
  }

  function handleExportCsv() {
    const columns = sheepFlocksExportColumns();
    const ok = downloadCsv(csvFilename('sheep-flocks'), rowsToCsv(columns, sorted));
    if (!ok) setNotice({kind: 'error', message: 'CSV export is only available in the browser.'});
  }

  function handlePrintRows() {
    const columns = sheepFlocksExportColumns();
    const ok = printRows({
      title: 'Sheep Flocks',
      subtitle: sorted.length + ' filtered sheep',
      columns,
      rows: sorted,
    });
    if (!ok) setNotice({kind: 'error', message: 'Print is only available in the browser.'});
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

  function openAdd() {
    setNotice(null);
    setForm({...EMPTY_SHEEP});
    setShowAddForm(true);
  }
  async function saveSheep() {
    setNotice(null);
    if (!form.tag.trim()) {
      window._wcfConfirm(
        'Save sheep without a tag?',
        () => {
          void proceedSaveSheep();
        },
        'Save',
      );
      return;
    }
    await proceedSaveSheep();
  }
  async function proceedSaveSheep() {
    setSaving(true);
    const isEwe = form.sex === 'ewe';
    const rec = {
      tag: form.tag.trim() || null,
      sex: form.sex,
      flock: form.flock,
      breed: form.breed || null,
      breeding_blacklist: !!form.breeding_blacklist,
      origin: form.origin || null,
      birth_date: form.birth_date || null,
      purchase_date: form.purchase_date || null,
      purchase_amount: form.purchase_amount !== '' ? parseFloat(form.purchase_amount) : null,
      dam_tag: form.dam_tag || null,
      dam_reg_num: form.dam_reg_num || null,
      sire_tag: form.sire_tag || null,
      sire_reg_num: form.sire_reg_num || null,
      registration_num: form.registration_num || null,
      breeding_status: isEwe ? form.breeding_status || null : null,
      maternal_issue_flag: !!form.maternal_issue_flag,
      maternal_issue_desc: form.maternal_issue_desc || null,
      sale_date: form.sale_date || null,
      sale_amount: form.sale_amount !== '' ? parseFloat(form.sale_amount) : null,
      death_date: form.death_date || null,
      death_reason: form.death_reason || null,
      old_tags: Array.isArray(form.old_tags) ? form.old_tags : [],
    };
    const newId = (rec.tag ? 's-' + rec.tag : 's-' + Date.now()) + '-' + Math.random().toString(36).slice(2, 5);
    const {error} = await sb.from('sheep').insert({id: newId, ...rec});
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      setSaving(false);
      return;
    }
    setSaving(false);
    await loadAll();
    setShowAddForm(false);
    setForm(null);
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
      const nextValues = cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value];
      const next = {...prev};
      if (nextValues.length === 0) delete next[key];
      else next[key] = nextValues;
      return next;
    });
  }
  function addSortRule(key) {
    setSortRules((prev) => {
      if (prev.find((r) => r.key === key)) return prev;
      const nextRule = {key, dir: 'asc'};
      const onlyDefaultTag = prev.length === 1 && prev[0].key === 'tag' && prev[0].dir === 'asc';
      if (onlyDefaultTag && key !== 'tag') return [nextRule];
      return [nextRule, ...prev];
    });
  }
  function removeSortRule(index) {
    setSortRules((prev) => prev.filter((_, i) => i !== index));
  }
  function flipSortDir(index) {
    setSortRules((prev) => prev.map((r, i) => (i === index ? {...r, dir: r.dir === 'asc' ? 'desc' : 'asc'} : r)));
  }
  function moveSortRule(index, delta) {
    setSortRules((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function chipActiveFor(key) {
    return key in filters;
  }
  function chipLabelFor(key) {
    const active = chipActiveFor(key);
    switch (key) {
      case 'flockSet':
        return active ? 'Flock: ' + (filters.flockSet || []).map((f) => FLOCK_LABELS[f] || f).join(', ') : '+ Flock';
      case 'sex':
        return active
          ? 'Sex: ' + (filters.sex || []).map((s) => (SEX_OPTIONS.find((o) => o.key === s) || {}).label || s).join(', ')
          : '+ Sex';
      case 'ageMonthsRange': {
        if (!active) return '+ Age';
        const parts = [];
        if (filters.ageMonthsRange.min != null) parts.push('>=' + filters.ageMonthsRange.min + 'mo');
        if (filters.ageMonthsRange.max != null) parts.push('<=' + filters.ageMonthsRange.max + 'mo');
        return 'Age: ' + parts.join(' ');
      }
      case 'breed':
        return active ? 'Breed: ' + (filters.breed || []).join(', ') : '+ Breed';
      case 'origin':
        return active ? 'Origin: ' + (filters.origin || []).join(', ') : '+ Origin';
      case 'weightTier': {
        if (!active) return '+ Weight';
        const labels = {
          hasWeight: 'has weight',
          noWeight: 'no weight',
          staleWeight: 'stale weight',
          staleOrNoWeight: 'stale or no weight',
        };
        return 'Weight: ' + (labels[filters.weightTier] || filters.weightTier);
      }
      case 'lambedStatus':
        return active ? 'Lambed: ' + (filters.lambedStatus === 'yes' ? 'yes' : 'no') : '+ Lambed';
      case 'lastLambedRange': {
        if (!active) return '+ Last lambed';
        const r = filters.lastLambedRange;
        return 'Last lambed ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
      }
      case 'lambCountRange': {
        if (!active) return '+ Lamb count';
        const parts = [];
        if (filters.lambCountRange.min != null) parts.push('>=' + filters.lambCountRange.min);
        if (filters.lambCountRange.max != null) parts.push('<=' + filters.lambCountRange.max);
        return 'Lambs ' + parts.join(' ');
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
      case 'maternalIssue':
        if (filters.maternalIssue === true) return 'Maternal issue: only';
        if (filters.maternalIssue === false) return 'Maternal issue: hide';
        return '+ Maternal issue';
      case 'damPresence':
        return active ? 'Dam: ' + filters.damPresence : '+ Dam';
      case 'sirePresence':
        return active ? 'Sire: ' + filters.sirePresence : '+ Sire';
      case 'birthDateRange': {
        if (!active) return '+ Birth date';
        const r = filters.birthDateRange;
        return 'Born ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
      }
      case 'weightRange': {
        if (!active) return '+ Weight range';
        const parts = [];
        if (filters.weightRange.min != null) parts.push('>=' + filters.weightRange.min + 'lb');
        if (filters.weightRange.max != null) parts.push('<=' + filters.weightRange.max + 'lb');
        return 'Weight ' + parts.join(' ');
      }
      default:
        return key;
    }
  }
  function renderFilterChip(key) {
    const active = chipActiveFor(key);
    const isOpen = openFilter === key;
    return (
      <div key={key} style={{position: 'relative', display: 'inline-block'}}>
        <button
          type="button"
          data-sheep-filter-chip={key}
          onClick={(e) => {
            if (active && (e.shiftKey || e.metaKey || e.altKey)) {
              clearFilter(key);
              return;
            }
            setOpenFilter(isOpen ? null : key);
          }}
          style={active ? chipActiveS : chipBaseS}
        >
          {chipLabelFor(key) + (active ? ' x' : '')}
        </button>
        {isOpen && (
          <SheepFilterPopover
            filterKey={key}
            filters={filters}
            setFilter={setFilter}
            clearFilter={clearFilter}
            toggleFilterArrayValue={toggleFilterArrayValue}
            breedFilterOptions={breedFilterOptions}
            originFilterOptions={originFilterOptions}
            FLOCK_LABELS={FLOCK_LABELS}
            ALL_FLOCKS={ALL_FLOCKS}
            onClose={() => setOpenFilter(null)}
          />
        )}
      </div>
    );
  }
  function renderFilterGroups() {
    return SHEEP_FILTER_GROUPS.map((group) => (
      <div
        key={group.key}
        data-sheep-filter-group={group.key}
        style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}
      >
        <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600, marginRight: 4, minWidth: 108}}>
          {group.label}
        </span>
        {group.keys.map((key) => renderFilterChip(key))}
      </div>
    ));
  }
  function sortBar() {
    const used = new Set(sortRules.map((r) => r.key));
    const available = SHEEP_SORT_KEYS.filter((key) => !used.has(key));
    return (
      <div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
        <span style={{fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600, marginRight: 4}}>Sort:</span>
        {sortRules.length === 0 && (
          <span style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic'}}>(none)</span>
        )}
        {sortRules.map((rule, i) => (
          <span
            key={rule.key}
            data-sheep-sort-rule={rule.key}
            data-sheep-sort-dir={rule.dir}
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
            <span style={{fontWeight: 600, color: '#0f766e'}}>{i + 1}.</span>
            <span>{SHEEP_SORT_KEY_LABELS[rule.key] || rule.key}</span>
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
              {(SHEEP_SORT_DIR_LABELS[rule.key] || {})[rule.dir] || rule.dir}
            </button>
            <button
              type="button"
              onClick={() => moveSortRule(i, -1)}
              disabled={i === 0}
              title="Move up"
              style={{
                background: 'none',
                border: 'none',
                color: i === 0 ? 'var(--ink-faint)' : 'var(--ink-muted)',
                cursor: i === 0 ? 'not-allowed' : 'pointer',
                fontSize: 12,
                padding: '0 2px',
              }}
            >
              {'^'}
            </button>
            <button
              type="button"
              onClick={() => moveSortRule(i, 1)}
              disabled={i === sortRules.length - 1}
              title="Move down"
              style={{
                background: 'none',
                border: 'none',
                color: i === sortRules.length - 1 ? 'var(--ink-faint)' : 'var(--ink-muted)',
                cursor: i === sortRules.length - 1 ? 'not-allowed' : 'pointer',
                fontSize: 12,
                padding: '0 2px',
              }}
            >
              {'v'}
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
              {'x'}
            </button>
          </span>
        ))}
        {available.length > 0 && (
          <select
            data-sheep-sort-add
            value=""
            onChange={(e) => {
              if (e.target.value) {
                addSortRule(e.target.value);
                e.target.value = '';
              }
            }}
            style={{...inpS, width: 'auto', fontSize: 11, padding: '4px 8px'}}
          >
            <option value="">+ Sort by...</option>
            {available.map((key) => (
              <option key={key} value={key}>
                {SHEEP_SORT_KEY_LABELS[key] || key}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  const isFlatMode = viewMode === 'flat';
  const filterCount = Object.keys(filters).length;
  const search = filters.textSearch || '';
  const statusFilter = (() => {
    const flockSet = Array.isArray(filters.flockSet) ? filters.flockSet : [];
    if (flockSet.length === 0) return 'active';
    if (flockSet.length === SHEEP_ALL_FLOCK_KEYS.length && SHEEP_ALL_FLOCK_KEYS.every((f) => flockSet.includes(f)))
      return 'all';
    return flockSet.length === 1 ? flockSet[0] : 'all';
  })();
  function setStatusFilter(value) {
    if (value === 'active') {
      clearFilter('flockSet');
      setViewMode('grouped');
    } else if (value === 'all') {
      setFilter('flockSet', [...SHEEP_ALL_FLOCK_KEYS]);
      setViewMode('flat');
    } else {
      setFilter('flockSet', [value]);
      setViewMode('flat');
    }
  }
  const sortBy = (() => {
    const first = sortRules[0] || {key: 'tag', dir: 'asc'};
    const map = {
      'tag:asc': 'tag-asc',
      'tag:desc': 'tag-desc',
      'age:asc': 'age-asc',
      'age:desc': 'age-desc',
      'lastWeight:desc': 'weight-desc',
      'lastWeight:asc': 'weight-asc',
    };
    return map[first.key + ':' + (first.dir || 'asc')] || 'tag-asc';
  })();
  function setSortBy(value) {
    setSortRules(legacySheepSortRulesFromSortBy(value));
  }
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
  const savedViewPrimaryBtnS = {...savedViewGhostBtnS, border: '1px solid #0f766e', color: '#0f766e'};
  const savedViewRadioLabelS = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    color: 'var(--ink)',
    cursor: 'pointer',
  };
  const toolButtonS = (active = false) => ({
    width: 34,
    height: 34,
    borderRadius: 10,
    border: active ? '1px solid #0f766e' : '1px solid var(--border-strong)',
    background: active ? '#f0fdfa' : 'white',
    color: active ? '#0f766e' : 'var(--ink)',
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

  // Shared id/tag primary cell — keeps the disclosure caret + tag text.
  function renderSheepTag(s) {
    return (
      <span style={{display: 'flex', alignItems: 'center', gap: 6}}>
        <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>{'▶'}</span>
        <span style={{fontWeight: 700}}>{s.tag ? '#' + s.tag : '(no tag)'}</span>
      </span>
    );
  }
  function renderSheepWeight(s) {
    const lw = lastWeight(s);
    if (!lw) return <StatusText tone="muted">no weigh-in</StatusText>;
    return <StatusText tone="ok">{lw.toLocaleString() + ' lb'}</StatusText>;
  }
  // Blacklisted rows keep their soft red wash from the tile era.
  function sheepRowStyle(s) {
    return s.breeding_blacklist ? {background: '#fecaca'} : undefined;
  }
  // FLAT mode columns: Flock, Sex, Breed, Age, Weight, Signals.
  const flatColumns = [
    {key: 'tag', label: 'Tag', primary: true, render: renderSheepTag},
    {
      key: 'flock',
      label: 'Flock',
      render: (s) => {
        const fc = FLOCK_COLORS[s.flock] || FLOCK_COLORS.ewes;
        return (
          <span
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 999,
              background: 'white',
              color: fc.tx,
              border: '1px solid ' + fc.bd,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {FLOCK_LABELS[s.flock]}
          </span>
        );
      },
    },
    {key: 'sex', label: 'Sex', render: (s) => s.sex || '—'},
    {key: 'breed', label: 'Breed', mobilePriority: false, render: (s) => s.breed || '—'},
    {key: 'age', label: 'Age', render: (s) => age(s.birth_date) || '—'},
    {key: 'weight', label: 'Last weight', align: 'right', render: renderSheepWeight},
    {
      key: 'signals',
      label: 'Notes',
      mobilePriority: false,
      render: (s) => (
        <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
          {s.dam_tag && <StatusText tone="muted">{'dam #' + s.dam_tag}</StatusText>}
          {s.maternal_issue_flag && <Badge variant="danger">MATERNAL ISSUE</Badge>}
          {s.breeding_blacklist && <Badge variant="danger">BLACKLIST</Badge>}
        </span>
      ),
    },
  ];
  // TILE mode columns (per flock): Sex, Breed, Age, Weight, Signals.
  // `flockKey` drives the ewe-only lamb count / last-lambed signals.
  function tileColumns(flockKey) {
    return [
      {key: 'tag', label: 'Tag', primary: true, render: renderSheepTag},
      {key: 'sex', label: 'Sex', render: (s) => s.sex || '—'},
      {key: 'breed', label: 'Breed', mobilePriority: false, render: (s) => s.breed || '—'},
      {key: 'age', label: 'Age', render: (s) => age(s.birth_date) || '—'},
      {key: 'weight', label: 'Last weight', align: 'right', render: renderSheepWeight},
      {
        key: 'signals',
        label: 'Notes',
        mobilePriority: false,
        render: (s) => {
          const lc = lambCount(s.tag);
          const ll = lastLambing(s.tag);
          return (
            <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
              {flockKey === 'ewes' && lc > 0 && (
                <StatusText tone="ok">{lc + ' ' + (lc === 1 ? 'lamb' : 'lambs')}</StatusText>
              )}
              {flockKey === 'ewes' && ll && (
                <StatusText tone="muted">{'last lambed ' + fmt(ll.lambing_date)}</StatusText>
              )}
              {s.maternal_issue_flag && <Badge variant="danger">MATERNAL</Badge>}
              {s.breeding_blacklist && <Badge variant="danger">BLACKLIST</Badge>}
            </span>
          );
        },
      },
    ];
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
        data-sheep-flocks-loaded={loading || loadError ? 'false' : 'true'}
      >
        {!showAddForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {loadError && (
          <div data-sheep-flocks-load-error="true">
            <InlineNotice notice={loadError} />
            <button
              type="button"
              data-sheep-flocks-load-retry="1"
              onClick={loadAll}
              style={{
                padding: '7px 14px',
                borderRadius: 10,
                border: '1px solid var(--border-strong)',
                background: 'white',
                color: '#085041',
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
                data-sheep-saved-views-row
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
                  <span style={{fontSize: 12, color: '#b91c1c'}} data-sheep-saved-views-error>
                    Saved views unavailable. Filters still work.
                  </span>
                ) : (
                  <>
                    <select
                      data-sheep-saved-view-select
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
                          data-sheep-saved-view-update
                          onClick={updateSelectedView}
                          disabled={savedViewBusy}
                          style={savedViewGhostBtnS}
                        >
                          Update to current
                        </button>
                        <button
                          type="button"
                          data-sheep-saved-view-delete
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
                      data-sheep-saved-view-save-open
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
                data-sheep-saved-view-form
                style={{
                  background: 'white',
                  border: '1px solid #99f6e4',
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
                  data-sheep-saved-view-name
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
                    name="saveSheepViewVisibility"
                    checked={saveViewVisibility === 'private'}
                    onChange={() => setSaveViewVisibility('private')}
                    data-sheep-saved-view-visibility="private"
                  />
                  Private
                </label>
                <label style={savedViewRadioLabelS}>
                  <input
                    type="radio"
                    name="saveSheepViewVisibility"
                    checked={saveViewVisibility === 'public'}
                    onChange={() => setSaveViewVisibility('public')}
                    data-sheep-saved-view-visibility="public"
                  />
                  Public
                </label>
                <button
                  type="button"
                  data-sheep-saved-view-save
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
                  placeholder="Search tag, dam, sire, breed, origin..."
                  style={{...inpS, flex: 1, minWidth: 200}}
                />
                <button
                  type="button"
                  data-sheep-flocks-saved-views-toggle="1"
                  aria-label="Saved views"
                  aria-pressed={openToolPanel === 'savedViews'}
                  title="Saved views"
                  onClick={() => toggleToolPanel('savedViews')}
                  style={toolButtonS(openToolPanel === 'savedViews')}
                >
                  ☆
                </button>
                <button
                  type="button"
                  data-sheep-flocks-filters-toggle="1"
                  aria-label="Filters"
                  aria-pressed={openToolPanel === 'filters'}
                  title="Filters"
                  onClick={() => toggleToolPanel('filters')}
                  style={toolButtonS(openToolPanel === 'filters')}
                >
                  ≡
                </button>
                <button
                  type="button"
                  data-sheep-flocks-sort-toggle="1"
                  aria-label="Sort"
                  aria-pressed={openToolPanel === 'sort'}
                  title="Sort"
                  onClick={() => toggleToolPanel('sort')}
                  style={toolButtonS(openToolPanel === 'sort')}
                >
                  ↕
                </button>
                <button
                  type="button"
                  data-sheep-flocks-view-toggle="1"
                  aria-label="View mode"
                  aria-pressed={openToolPanel === 'view'}
                  title="View mode"
                  onClick={() => toggleToolPanel('view')}
                  style={toolButtonS(openToolPanel === 'view')}
                >
                  ▦
                </button>
                {openToolPanel === 'filters' && (
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{...inpS, width: 'auto'}}
                  >
                    <option value="active">All Active Flocks</option>
                    <option value="all">All (including outcomes)</option>
                    <option disabled>{'───'}</option>
                    {FLOCKS.map((f) => (
                      <option key={f} value={f}>
                        {FLOCK_LABELS[f]}
                      </option>
                    ))}
                    <option disabled>{'───'}</option>
                    {OUTCOMES.map((f) => (
                      <option key={f} value={f}>
                        {FLOCK_LABELS[f]}
                      </option>
                    ))}
                  </select>
                )}
                {openToolPanel === 'sort' && (
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{...inpS, width: 'auto'}}>
                    <option value="tag-asc">Tag {'↑'}</option>
                    <option value="tag-desc">Tag {'↓'}</option>
                    <option value="age-asc">Age (youngest first)</option>
                    <option value="age-desc">Age (oldest first)</option>
                    <option value="weight-desc">Weight {'↓'}</option>
                    <option value="weight-asc">Weight {'↑'}</option>
                  </select>
                )}
                {openToolPanel === 'view' && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 12,
                      color: 'var(--ink)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 10,
                      padding: '4px 8px',
                    }}
                  >
                    <span style={{color: 'var(--ink-muted)', marginRight: 4}}>View</span>
                    <label style={{display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}>
                      <input
                        type="radio"
                        name="sheepFlocksViewMode"
                        checked={viewMode === 'grouped'}
                        onChange={() => setViewMode('grouped')}
                        data-sheep-view-mode="grouped"
                      />
                      Grouped
                    </label>
                    <label style={{display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}>
                      <input
                        type="radio"
                        name="sheepFlocksViewMode"
                        checked={viewMode === 'flat'}
                        onChange={() => setViewMode('flat')}
                        data-sheep-view-mode="flat"
                      />
                      Flat
                    </label>
                  </div>
                )}
                <button
                  type="button"
                  data-sheep-flocks-export-csv="1"
                  aria-label="Export CSV"
                  title="Export CSV"
                  onClick={handleExportCsv}
                  disabled={loading || loadError}
                  style={{
                    ...toolButtonS(false),
                    background: loading || loadError ? 'var(--surface-2)' : 'white',
                    color: loading || loadError ? 'var(--ink-faint)' : 'var(--ink)',
                    cursor: loading || loadError ? 'not-allowed' : 'pointer',
                    opacity: loading || loadError ? 0.75 : 1,
                  }}
                >
                  CSV
                </button>
                <button
                  type="button"
                  data-sheep-flocks-print="1"
                  aria-label="Print"
                  title="Print"
                  onClick={handlePrintRows}
                  disabled={loading || loadError}
                  style={{
                    ...toolButtonS(false),
                    background: loading || loadError ? 'var(--surface-2)' : 'white',
                    color: loading || loadError ? 'var(--ink-faint)' : 'var(--ink)',
                    cursor: loading || loadError ? 'not-allowed' : 'pointer',
                    opacity: loading || loadError ? 0.75 : 1,
                  }}
                >
                  ⎙
                </button>
                <button
                  onClick={() => setShowBulkImport(true)}
                  style={{
                    padding: '7px 14px',
                    borderRadius: 10,
                    border: '1px solid #0f766e',
                    background: 'white',
                    color: '#0f766e',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  📥 Bulk Import
                </button>
                <button
                  onClick={openAdd}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 10,
                    border: 'none',
                    background: '#0f766e',
                    color: 'white',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }}
                >
                  + Add Sheep
                </button>
              </div>
              {openToolPanel === 'filters' && (
                <div data-sheep-filter-groups style={toolPanelS}>
                  {renderFilterGroups()}
                  {filterCount > 0 && (
                    <div>
                      <button
                        type="button"
                        onClick={clearAllFilters}
                        style={{
                          padding: '5px 10px',
                          borderRadius: 10,
                          border: '1px solid var(--border-strong)',
                          background: 'white',
                          color: 'var(--ink-muted)',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                </div>
              )}
              {openToolPanel === 'sort' && <div style={toolPanelS}>{sortBar()}</div>}
              <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>
                Showing {sorted.length} of {sheep.length} sheep
                {filterCount > 0 && ' - ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's')}
                {sortRules.length > 0 && ' - ' + sortRules.length + ' sort' + (sortRules.length === 1 ? '' : 's')}
              </div>
            </div>

            {showBulkImport && (
              <SheepBulkImport
                sb={sb}
                breedOpts={breedOpts}
                originOpts={originOpts}
                existingSheep={sheep}
                onClose={() => setShowBulkImport(false)}
                onComplete={loadAll}
              />
            )}

            {loading && (
              <div style={{textAlign: 'center', padding: '3rem', color: 'var(--ink-faint)'}}>Loading{'…'}</div>
            )}
            {!loading && sheep.length === 0 && (
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
                No sheep records yet. Click <strong>+ Add Sheep</strong> or <strong>Bulk Import</strong>.
              </div>
            )}

            {/* FLAT MODE — search or non-active filter */}
            {!loading && isFlatMode && sheep.length > 0 && (
              <div
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
                  {sorted.length} sheep match
                </div>
                {sorted.length === 0 && (
                  <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
                    No sheep match the current filter.
                  </div>
                )}
                <DataTable
                  surfaceKey="sheep-flocks-flat-table"
                  showRowNumbers
                  rows={sorted}
                  rowKey="id"
                  density="comfortable"
                  columns={flatColumns}
                  rowProps={(s) => ({id: 'sheep-' + s.id, 'data-sheep-flock-row': s.id})}
                  rowStyle={sheepRowStyle}
                  onRowOpen={(s) => navigate('/sheep/flocks/' + s.id, recordSeqNavOptions(sorted))}
                />
              </div>
            )}

            {/* TILE MODE — default view */}
            {!loading && !isFlatMode && sheep.length > 0 && (
              <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
                {FLOCKS.map((f) => {
                  const flockSheep = sorted.filter((s) => s.flock === f);
                  const fc = FLOCK_COLORS[f];
                  const open = !!expandedFlocks[f];
                  return (
                    <div
                      key={f}
                      style={{
                        background: 'white',
                        border: '1px solid var(--border)',
                        borderRadius: 12,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        {...openableProps(() => setExpandedFlocks({...expandedFlocks, [f]: !open}))}
                        className="hoverable-tile"
                        style={{
                          padding: '12px 18px',
                          background: 'white',
                          borderLeft: '3px solid ' + fc.bd,
                          borderBottom: open ? '1px solid ' + fc.bd : 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 12,
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{fontSize: 12, color: fc.tx}}>{open ? '▼' : '▶'}</span>
                        <span
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color: fc.tx,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <PlannerIcon iconKey={ANIMAL_ICON_KEYS.sheep} size={18} />
                          <span>{FLOCK_LABELS[f]}</span>
                        </span>
                        <span style={{fontSize: 12, color: fc.tx, opacity: 0.8}}>
                          {flockSheep.length} {flockSheep.length === 1 ? 'sheep' : 'sheep'}
                        </span>
                      </div>
                      {open && flockSheep.length === 0 && (
                        <div
                          style={{padding: '1rem 18px', color: 'var(--ink-faint)', fontSize: 12, fontStyle: 'italic'}}
                        >
                          {filterCount > 0 ? 'No sheep match the current filters.' : 'No sheep in this flock yet.'}
                        </div>
                      )}
                      {open && flockSheep.length > 0 && (
                        <DataTable
                          surfaceKey={'sheep-flocks-tile-' + f}
                          showRowNumbers
                          rows={flockSheep}
                          rowKey="id"
                          density="comfortable"
                          columns={tileColumns(f)}
                          rowProps={(s) => ({id: 'sheep-' + s.id, 'data-sheep-flock-row': s.id})}
                          rowStyle={sheepRowStyle}
                          onRowOpen={(s) => navigate('/sheep/flocks/' + s.id, recordSeqNavOptions(flockSheep))}
                        />
                      )}
                    </div>
                  );
                })}
                {/* Outcome flocks shown collapsed at the bottom */}
                <SheepCollapsibleOutcomeSections
                  sheep={sheep}
                  FLOCK_COLORS={FLOCK_COLORS}
                  FLOCK_LABELS={FLOCK_LABELS}
                  OUTCOMES={OUTCOMES}
                  fmt={fmt}
                  setStatusFilter={setStatusFilter}
                  onSheepClick={(s) => navigate('/sheep/flocks/' + s.id)}
                />
              </div>
            )}
          </>
        )}
      </div>

      {/* Add Sheep modal (kept for creating new records only) */}
      {showAddForm && form && (
        <div
          onClick={() => {
            setNotice(null);
            setShowAddForm(false);
            setForm(null);
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
              <div style={{fontSize: 15, fontWeight: 600, color: '#0f766e'}}>Add Sheep</div>
              <button
                onClick={() => {
                  setNotice(null);
                  setShowAddForm(false);
                  setForm(null);
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
                  placeholder="Required (or blank for unweaned lamb)"
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sex</label>
                <select value={form.sex} onChange={(e) => setForm({...form, sex: e.target.value})} style={inpS}>
                  <option value="ewe">Ewe</option>
                  <option value="ram">Ram</option>
                  <option value="wether">Wether</option>
                  <option value="lamb">Lamb</option>
                </select>
              </div>
              <div>
                <label style={lbl}>Flock *</label>
                <select value={form.flock} onChange={(e) => setForm({...form, flock: e.target.value})} style={inpS}>
                  {ALL_FLOCKS.map((f) => (
                    <option key={f} value={f}>
                      {FLOCK_LABELS[f]}
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
                  {breedOpts.map((b) => (
                    <option key={b.id} value={b.label}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Origin</label>
                <select
                  value={form.origin || ''}
                  onChange={(e) => setForm({...form, origin: e.target.value})}
                  style={inpS}
                >
                  <option value="">{'— select —'}</option>
                  {originOpts.map((o) => (
                    <option key={o.id} value={o.label}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={lbl}>Registration #</label>
                <input
                  value={form.registration_num}
                  onChange={(e) => setForm({...form, registration_num: e.target.value})}
                  style={inpS}
                />
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
              <div></div>
              <div>
                <label style={lbl}>Dam Tag</label>
                <input
                  value={form.dam_tag}
                  onChange={(e) => setForm({...form, dam_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Dam Reg #</label>
                <input
                  value={form.dam_reg_num}
                  onChange={(e) => setForm({...form, dam_reg_num: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sire Tag</label>
                <input
                  value={form.sire_tag}
                  onChange={(e) => setForm({...form, sire_tag: e.target.value})}
                  style={inpS}
                />
              </div>
              <div>
                <label style={lbl}>Sire Reg #</label>
                <input
                  value={form.sire_reg_num}
                  onChange={(e) => setForm({...form, sire_reg_num: e.target.value})}
                  style={inpS}
                />
              </div>
              {form.sex === 'ewe' && (
                <div style={{gridColumn: '1/-1'}}>
                  <label style={lbl}>Breeding Status</label>
                  <select
                    value={form.breeding_status}
                    onChange={(e) => setForm({...form, breeding_status: e.target.value})}
                    style={inpS}
                  >
                    <option value="">{'— not set —'}</option>
                    <option value="Open">Open</option>
                    <option value="Pregnant">Pregnant</option>
                    <option value="N/A">N/A</option>
                  </select>
                </div>
              )}
            </div>
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid var(--border)',
                display: 'flex',
                gap: 8,
                justifyContent: 'flex-end',
              }}
            >
              <button
                onClick={() => {
                  setShowAddForm(false);
                  setForm(null);
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
              <button
                onClick={saveSheep}
                disabled={saving}
                style={{
                  padding: '8px 20px',
                  borderRadius: 10,
                  border: 'none',
                  background: '#0f766e',
                  color: 'white',
                  fontWeight: 600,
                  fontSize: 13,
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving…' : 'Add Sheep'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

function SheepFilterPopover({
  filterKey,
  filters,
  setFilter,
  clearFilter,
  toggleFilterArrayValue,
  breedFilterOptions,
  originFilterOptions,
  FLOCK_LABELS,
  ALL_FLOCKS,
  onClose,
}) {
  const boxS = {
    position: 'absolute',
    zIndex: 40,
    top: 'calc(100% + 6px)',
    left: 0,
    width: 280,
    padding: 12,
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
    background: 'white',
    boxShadow: '0 10px 28px rgba(0,0,0,.14)',
  };
  const labelS = {display: 'block', fontSize: 11, color: 'var(--ink-muted)', fontWeight: 600, marginBottom: 4};
  const rowS = {display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8};
  const inputS = {
    fontSize: 12,
    padding: '6px 8px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const smallInputS = {...inputS, width: 110};
  const btnS = {
    padding: '5px 10px',
    borderRadius: 10,
    border: '1px solid var(--border-strong)',
    background: 'white',
    color: 'var(--ink)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
  const checkboxS = {display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink)', marginBottom: 6};

  function setNumberRange(key, field, raw) {
    const current = filters[key] && typeof filters[key] === 'object' ? filters[key] : {};
    const next = {...current};
    if (raw === '') delete next[field];
    else next[field] = Number(raw);
    setFilter(key, next);
  }
  function setDateRange(key, field, raw) {
    const current = filters[key] && typeof filters[key] === 'object' ? filters[key] : {};
    const next = {...current};
    if (!raw) delete next[field];
    else next[field] = raw;
    setFilter(key, next);
  }
  function renderMulti(key, options) {
    const selected = Array.isArray(filters[key]) ? filters[key] : [];
    return (
      <div>
        {options.map((opt) => (
          <label key={opt.key} style={checkboxS}>
            <input
              type="checkbox"
              checked={selected.includes(opt.key)}
              onChange={() => toggleFilterArrayValue(key, opt.key)}
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    );
  }
  function renderRange(key, firstLabel, secondLabel, type) {
    const current = filters[key] || {};
    const setter = type === 'date' ? setDateRange : setNumberRange;
    return (
      <div style={rowS}>
        <label style={{flex: '1 1 110px'}}>
          <span style={labelS}>{firstLabel}</span>
          <input
            type={type}
            value={current.min ?? current.after ?? ''}
            onChange={(e) => setter(key, type === 'date' ? 'after' : 'min', e.target.value)}
            style={smallInputS}
          />
        </label>
        <label style={{flex: '1 1 110px'}}>
          <span style={labelS}>{secondLabel}</span>
          <input
            type={type}
            value={current.max ?? current.before ?? ''}
            onChange={(e) => setter(key, type === 'date' ? 'before' : 'max', e.target.value)}
            style={smallInputS}
          />
        </label>
      </div>
    );
  }
  function renderSelect(key, options) {
    return (
      <select value={filters[key] ?? ''} onChange={(e) => setFilter(key, e.target.value || null)} style={inputS}>
        <option value="">Any</option>
        {options.map((opt) => (
          <option key={opt.key} value={opt.key}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  function renderBoolean(key, trueLabel, falseLabel) {
    const value = key in filters ? String(filters[key]) : '';
    return (
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === '') setFilter(key, null);
          else setFilter(key, e.target.value === 'true');
        }}
        style={inputS}
      >
        <option value="">Any</option>
        <option value="true">{trueLabel}</option>
        <option value="false">{falseLabel}</option>
      </select>
    );
  }

  let body;
  if (filterKey === 'flockSet') {
    body = renderMulti(
      'flockSet',
      ALL_FLOCKS.map((key) => ({key, label: FLOCK_LABELS[key] || key})),
    );
  } else if (filterKey === 'sex') {
    body = renderMulti('sex', SEX_OPTIONS);
  } else if (filterKey === 'ageMonthsRange') {
    body = renderRange('ageMonthsRange', 'Min months', 'Max months', 'number');
  } else if (filterKey === 'breed') {
    body = renderMulti(
      'breed',
      (breedFilterOptions || []).map((opt) => ({key: opt.label, label: opt.label})),
    );
  } else if (filterKey === 'origin') {
    body = renderMulti(
      'origin',
      (originFilterOptions || []).map((opt) => ({key: opt.label, label: opt.label})),
    );
  } else if (filterKey === 'weightTier') {
    body = renderSelect('weightTier', [
      {key: 'hasWeight', label: 'Has weight'},
      {key: 'noWeight', label: 'No weight'},
      {key: 'staleWeight', label: 'Stale weight'},
      {key: 'staleOrNoWeight', label: 'Stale or no weight'},
    ]);
  } else if (filterKey === 'lambedStatus') {
    body = renderSelect('lambedStatus', [
      {key: 'yes', label: 'Has lambed'},
      {key: 'no', label: 'Never lambed'},
    ]);
  } else if (filterKey === 'lastLambedRange') {
    body = renderRange('lastLambedRange', 'After', 'Before', 'date');
  } else if (filterKey === 'lambCountRange') {
    body = renderRange('lambCountRange', 'Min lambs', 'Max lambs', 'number');
  } else if (filterKey === 'breedingStatus') {
    body = renderMulti('breedingStatus', BREEDING_STATUS_OPTIONS);
  } else if (filterKey === 'breedingBlacklist') {
    body = renderBoolean('breedingBlacklist', 'Only blacklisted', 'Hide blacklisted');
  } else if (filterKey === 'maternalIssue') {
    body = renderBoolean('maternalIssue', 'Only maternal issues', 'Hide maternal issues');
  } else if (filterKey === 'damPresence') {
    body = renderSelect('damPresence', [
      {key: 'present', label: 'Dam present'},
      {key: 'missing', label: 'Dam missing'},
    ]);
  } else if (filterKey === 'sirePresence') {
    body = renderSelect('sirePresence', [
      {key: 'present', label: 'Sire present'},
      {key: 'missing', label: 'Sire missing'},
    ]);
  } else if (filterKey === 'birthDateRange') {
    body = renderRange('birthDateRange', 'After', 'Before', 'date');
  } else if (filterKey === 'weightRange') {
    body = renderRange('weightRange', 'Min lb', 'Max lb', 'number');
  } else {
    body = <div style={{fontSize: 12, color: 'var(--ink-muted)'}}>No control for this filter.</div>;
  }

  return (
    <div style={boxS} data-sheep-filter-popover={filterKey}>
      <div style={{fontSize: 12, color: 'var(--ink)', fontWeight: 700, marginBottom: 8}}>
        {SHEEP_FILTER_GROUPS.flatMap((group) => group.keys).includes(filterKey) ? filterKey : 'Filter'}
      </div>
      {body}
      <div style={{display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 10}}>
        <button type="button" onClick={() => clearFilter(filterKey)} style={btnS}>
          Clear
        </button>
        <button type="button" onClick={onClose} style={{...btnS, borderColor: '#0f766e', color: '#0f766e'}}>
          Done
        </button>
      </div>
    </div>
  );
}

export default SheepFlocksRouter;
