// CattleHerdsView — composable filter chips + ordered sort rules + explicit
// grouped/flat toggle + local smart-filter assistant. See PROJECT.md §8
// "Cattle Herd filters + maternal-field retirement" for the locked plan.
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
  parseSmartFilter,
  mergeObservedValues,
  cowTagSet,
  lastWeightFor,
  calfCountFor,
  CATTLE_HERD_KEYS,
  CATTLE_OUTCOME_KEYS,
  CATTLE_ALL_HERD_KEYS,
  CATTLE_QUICK_FILTERS,
  CATTLE_SORT_KEYS,
  STALE_WEIGHT_DAYS_DEFAULT,
} from '../lib/cattleHerdFilters.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {recordSeqNavOptions} from '../lib/recordSequence.js';
import {runMutation, recordFieldChange} from '../lib/entityMutations.js';
import {buildChanges, countSummary} from '../lib/activityChangeDiff.js';
import {softDeleteCattleAnimal} from '../lib/cattleDeleteApi.js';
import {deleteCattleCalvingRecord} from '../lib/cattleCalvingApi.js';

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

const HERD_COLORS = {
  mommas: {bg: '#fef2f2', tx: '#991b1b', bd: '#fca5a5'},
  backgrounders: {bg: '#ffedd5', tx: '#9a3412', bd: '#fdba74'},
  finishers: {bg: '#fff1f2', tx: '#9f1239', bd: '#fda4af'},
  bulls: {bg: '#fee2e2', tx: '#7f1d1d', bd: '#fca5a5'},
  processed: {bg: '#f3f4f6', tx: '#374151', bd: '#d1d5db'},
  deceased: {bg: '#f9fafb', tx: '#6b7280', bd: '#e5e7eb'},
  sold: {bg: '#eff6ff', tx: '#1e40af', bd: '#bfdbfe'},
};

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
  breed: {asc: '↑ A→Z', desc: '↓ Z→A'},
  origin: {asc: '↑ A→Z', desc: '↓ Z→A'},
};

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
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
};
const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

const chipBaseS = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 999,
  fontSize: 12,
  fontFamily: 'inherit',
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const chipActiveS = {
  ...chipBaseS,
  border: '1px solid #991b1b',
  background: '#fef2f2',
  color: '#991b1b',
  fontWeight: 600,
};

function buildSmartProposalPreview(proposal) {
  if (!proposal) return null;
  const parts = [];
  for (const [k, v] of Object.entries(proposal.chips || {})) {
    if (v == null || (Array.isArray(v) && v.length === 0)) continue;
    if (k === 'ageMonthsRange') {
      const r = [];
      if (v.min != null) r.push('≥ ' + v.min + 'mo');
      if (v.max != null) r.push('≤ ' + v.max + 'mo');
      parts.push('Age ' + r.join(' '));
    } else if (k === 'calvingWindow' && v.mode === 'noneSince') {
      parts.push('Not calved since ' + v.since);
    } else if (Array.isArray(v)) {
      parts.push(k + '=' + v.join(','));
    } else if (typeof v === 'boolean') {
      parts.push(k + (v ? '=on' : '=off'));
    } else {
      parts.push(k + '=' + v);
    }
  }
  for (const r of proposal.sortRules || []) parts.push('sort ' + r.key + ' ' + r.dir);
  return parts.join(' · ');
}

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

  // Composable filter / sort state.
  const [viewMode, setViewMode] = useState('grouped'); // 'grouped' | 'flat'
  const [filters, setFilters] = useState({});
  const [sortRules, setSortRules] = useState([{key: 'tag', dir: 'asc'}]);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [openFilter, setOpenFilter] = useState(null); // chip popover state — string key

  // Smart-filter assistant state.
  const [smartInputText, setSmartInputText] = useState('');
  const [smartProposal, setSmartProposal] = useState(null);
  const [smartError, setSmartError] = useState(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const [expandedHerds, setExpandedHerds] = useState({});

  async function loadAll() {
    const [cR, wAll, calR, brR, orR, pbR] = await Promise.all([
      sb.from('cattle').select('*').is('deleted_at', null).order('tag'),
      loadCattleWeighInsCached(sb),
      sb.from('cattle_calving_records').select('*').order('calving_date', {ascending: false}),
      sb.from('cattle_breeds').select('*').order('label'),
      sb.from('cattle_origins').select('*').order('label'),
      sb.from('cattle_processing_batches').select('id,name,actual_process_date,planned_process_date'),
    ]);
    if (cR.data) setCattle(cR.data);
    setWeighIns(wAll);
    if (calR.data) setCalvingRecs(calR.data);
    if (brR.data) setBreedOpts(brR.data);
    if (orR.data) setOriginOpts(orR.data);
    if (pbR.data) setProcessingBatches(pbR.data);
    setLoading(false);
  }
  useEffect(() => {
    loadAll();
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
  const HERD_TILE_DEFAULT_COW_WEIGHT = 1000;
  const HERD_TILE_ESTIMATE_DAYS = 120;
  function isHerdTileRecentlyPurchased(cow) {
    if (!cow || !cow.purchase_date) return false;
    const ms = Date.now() - new Date(cow.purchase_date + 'T12:00:00Z').getTime();
    return ms >= 0 && ms <= HERD_TILE_ESTIMATE_DAYS * 86400000;
  }
  function effectiveWeight(cow) {
    const real = lastWeight(cow);
    if (real != null && real > 0) return real;
    return isHerdTileRecentlyPurchased(cow) ? HERD_TILE_DEFAULT_COW_WEIGHT : 0;
  }

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

  const filtered = useMemo(() => {
    const effectiveFilters = {...filters};
    const userSetHerd = Array.isArray(filters.herdSet) && filters.herdSet.length > 0;
    const searching = typeof filters.textSearch === 'string' && filters.textSearch.trim();
    if (!userSetHerd && !searching) {
      effectiveFilters.herdSet = [...CATTLE_HERD_KEYS];
    }
    const predicate = buildCattlePredicate(effectiveFilters, {
      todayMs: Date.now(),
      calvingRecs,
      weighIns,
      staleDaysThreshold: STALE_WEIGHT_DAYS_DEFAULT,
    });
    return cattle.filter(predicate);
  }, [cattle, filters, calvingRecs, weighIns]);

  const sortedFlat = useMemo(() => {
    const cmp = buildCattleComparator(sortRules, {calvingRecs, weighIns});
    return [...filtered].sort(cmp);
  }, [filtered, sortRules, calvingRecs, weighIns]);

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

  // ── smart-assistant handlers ───────────────────────────────────────────────
  function runSmartFilter() {
    const text = smartInputText;
    setSmartError(null);
    if (!text.trim()) {
      setSmartProposal(null);
      return;
    }
    const proposal = parseSmartFilter(text, {
      todayMs: Date.now(),
      breedOptions: breedFilterOptions,
      originOptions: originFilterOptions,
    });
    if (proposal.confidence === 'low') {
      setSmartProposal(null);
      setSmartError("I couldn't parse this. Try the filter chips below.");
      return;
    }
    setSmartProposal(proposal);
  }
  function applySmartProposal() {
    if (!smartProposal) return;
    setFilters((prev) => ({...prev, ...smartProposal.chips}));
    if (Array.isArray(smartProposal.sortRules) && smartProposal.sortRules.length > 0) {
      setSortRules(smartProposal.sortRules);
    }
    setSmartProposal(null);
    setSmartInputText('');
  }
  function discardSmartProposal() {
    setSmartProposal(null);
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
    if (!tag) return null;
    return calvingRecs.find((r) => r.dam_tag === tag);
  }
  function calfCount(tag) {
    return calfCountFor(tag, calvingRecs);
  }

  // ── filter / sort UI subcomponents (inline for context) ────────────────────
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

  // eslint-disable-next-line no-unused-vars -- JSX-only use
  function SpecialFilterCheckbox({filterKey, label}) {
    const checked = filters[filterKey] === true;
    return (
      <label
        data-cattle-special-filter={filterKey}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          borderRadius: 6,
          border: checked ? '1px solid #991b1b' : '1px solid #d1d5db',
          background: checked ? '#fef2f2' : 'white',
          color: checked ? '#991b1b' : '#374151',
          fontSize: 12,
          fontWeight: checked ? 600 : 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setFilter(filterKey, e.target.checked ? true : null)}
          data-cattle-special-filter-checkbox={filterKey}
          style={{margin: 0}}
        />
        <span>{label}</span>
      </label>
    );
  }

  function quickFilterButtons() {
    return CATTLE_QUICK_FILTERS.map((key) => {
      if (key === 'textSearch') return null; // handled by separate search input
      const active = key in filters;
      let label;
      switch (key) {
        case 'herdSet':
          label = active ? 'Herd: ' + (filters.herdSet || []).map((h) => HERD_LABELS[h] || h).join(', ') : '+ Herd';
          break;
        case 'sex':
          label = active
            ? 'Sex: ' +
              (filters.sex || []).map((s) => (SEX_OPTIONS.find((o) => o.key === s) || {}).label || s).join(', ')
            : '+ Sex';
          break;
        case 'ageMonthsRange': {
          if (!active) {
            label = '+ Age';
          } else {
            const r = [];
            if (filters.ageMonthsRange.min != null) r.push('≥' + filters.ageMonthsRange.min + 'mo');
            if (filters.ageMonthsRange.max != null) r.push('≤' + filters.ageMonthsRange.max + 'mo');
            label = 'Age: ' + r.join(' ');
          }
          break;
        }
        case 'calvedStatus': {
          if (active) {
            label = 'Calved: ' + (filters.calvedStatus === 'yes' ? 'yes' : 'no');
          } else if (filters.calvingWindow && filters.calvingWindow.mode === 'noneSince') {
            label = 'Not calved since ' + filters.calvingWindow.since;
          } else {
            label = '+ Calved';
          }
          break;
        }
        case 'breedingBlacklist':
          if (filters.breedingBlacklist === true) label = 'Blacklist: only';
          else if (filters.breedingBlacklist === false) label = 'Blacklist: hide';
          else label = '+ Blacklist';
          break;
        case 'weightTier':
          if (active) {
            const tierLabels = {
              hasWeight: 'has weight',
              noWeight: 'no weight',
              staleWeight: 'stale weight',
              staleOrNoWeight: 'stale or no weight',
            };
            label = 'Weight: ' + (tierLabels[filters.weightTier] || filters.weightTier);
          } else {
            label = '+ Weight';
          }
          break;
        default:
          label = key;
      }
      const isOpen = openFilter === key;
      const chipActive = active || (key === 'calvedStatus' && filters.calvingWindow);
      return (
        <div key={key} style={{position: 'relative', display: 'inline-block'}}>
          <FilterChip
            label={label + (chipActive ? ' ×' : '')}
            active={chipActive}
            dataAttr={key}
            onClick={(e) => {
              if (chipActive && (e.shiftKey || e.metaKey || e.altKey)) {
                clearFilter(key);
                if (key === 'calvedStatus') clearFilter('calvingWindow');
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
    });
  }

  function moreFiltersButtons() {
    if (!showMoreFilters) return null;
    const dims = [
      'birthDateRange',
      'lastCalvedRange',
      'calfCountRange',
      'breedingStatus',
      'damPresence',
      'sirePresence',
      'weightRange',
      'breed',
      'origin',
      'wagyuPctRange',
    ];
    return dims.map((key) => {
      const active = key in filters;
      let label;
      switch (key) {
        case 'birthDateRange': {
          if (!active) label = '+ Birth date';
          else {
            const r = filters.birthDateRange;
            label = 'Born ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
          }
          break;
        }
        case 'lastCalvedRange': {
          if (!active) label = '+ Last calved';
          else {
            const r = filters.lastCalvedRange;
            label = 'Last calved ' + (r.after ? 'after ' + r.after : '') + (r.before ? ' before ' + r.before : '');
          }
          break;
        }
        case 'calfCountRange': {
          if (!active) label = '+ Calf count';
          else {
            const r = filters.calfCountRange;
            const parts = [];
            if (r.min != null) parts.push('≥' + r.min);
            if (r.max != null) parts.push('≤' + r.max);
            label = 'Calves ' + parts.join(' ');
          }
          break;
        }
        case 'breedingStatus':
          label = active
            ? 'Status: ' +
              (filters.breedingStatus || [])
                .map((s) => (BREEDING_STATUS_OPTIONS.find((o) => o.key === s) || {}).label || s)
                .join(', ')
            : '+ Breeding status';
          break;
        case 'damPresence':
          label = active ? 'Dam: ' + filters.damPresence : '+ Dam';
          break;
        case 'sirePresence':
          label = active ? 'Sire: ' + filters.sirePresence : '+ Sire';
          break;
        case 'weightRange': {
          if (!active) label = '+ Weight range';
          else {
            const r = filters.weightRange;
            const parts = [];
            if (r.min != null) parts.push('≥' + r.min + 'lb');
            if (r.max != null) parts.push('≤' + r.max + 'lb');
            label = 'Weight ' + parts.join(' ');
          }
          break;
        }
        case 'breed':
          label = active ? 'Breed: ' + (filters.breed || []).join(', ') : '+ Breed';
          break;
        case 'origin':
          label = active ? 'Origin: ' + (filters.origin || []).join(', ') : '+ Origin';
          break;
        case 'wagyuPctRange': {
          if (!active) label = '+ Wagyu %';
          else {
            const r = filters.wagyuPctRange;
            const parts = [];
            if (r.min != null) parts.push('≥' + r.min);
            if (r.max != null) parts.push('≤' + r.max);
            label = 'Wagyu ' + parts.join(' ') + '%';
          }
          break;
        }
        default:
          label = key;
      }
      const isOpen = openFilter === key;
      return (
        <div key={key} style={{position: 'relative', display: 'inline-block'}}>
          <FilterChip
            label={label + (active ? ' ×' : '')}
            active={active}
            dataAttr={key}
            onClick={(e) => {
              if (active && (e.shiftKey || e.metaKey || e.altKey)) {
                clearFilter(key);
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
    });
  }

  function sortBar() {
    const used = new Set(sortRules.map((r) => r.key));
    const available = CATTLE_SORT_KEYS.filter((k) => !used.has(k));
    return (
      <div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
        <span style={{fontSize: 11, color: '#6b7280', fontWeight: 600, marginRight: 4}}>Sort:</span>
        {sortRules.length === 0 && <span style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>(none)</span>}
        {sortRules.map((r, i) => (
          <span
            key={r.key}
            data-sort-rule={r.key}
            data-sort-dir={r.dir}
            style={{
              ...chipActiveS,
              cursor: 'default',
              gap: 4,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontWeight: 500,
            }}
          >
            <span style={{fontWeight: 600, color: '#991b1b'}}>{i + 1}.</span>
            <span>{SORT_KEY_LABELS[r.key] || r.key}</span>
            <button
              type="button"
              onClick={() => flipSortDir(i)}
              title="Toggle direction"
              style={{
                fontSize: 11,
                background: '#f9fafb',
                border: '1px solid #d1d5db',
                borderRadius: 4,
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
                color: i === 0 ? '#d1d5db' : '#6b7280',
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
                color: i === sortRules.length - 1 ? '#d1d5db' : '#6b7280',
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

  // ── derived UI flags ───────────────────────────────────────────────────────
  const isFlat = viewMode === 'flat';
  const filterCount = Object.keys(filters).length;
  const search = filters.textSearch || '';

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
      <div style={{padding: '1rem', maxWidth: 1200, margin: '0 auto'}}>
        {!showAddForm && <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />}
        {/* Smart-filter row */}
        <div
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span aria-hidden style={{fontSize: 16}}>
            {'🪄'}
          </span>
          <input
            type="text"
            value={smartInputText}
            placeholder="Try in plain English: heffers older than 18 months"
            data-smart-input
            onChange={(e) => setSmartInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSmartFilter();
            }}
            style={{...inpS, flex: 1, minWidth: 240}}
          />
          <button
            type="button"
            onClick={runSmartFilter}
            data-smart-apply
            disabled={!smartInputText.trim()}
            style={{
              padding: '7px 14px',
              borderRadius: 7,
              border: '1px solid #991b1b',
              background: 'white',
              color: '#991b1b',
              fontWeight: 600,
              fontSize: 12,
              cursor: smartInputText.trim() ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              opacity: smartInputText.trim() ? 1 : 0.5,
            }}
          >
            Parse
          </button>
        </div>
        {(smartProposal || smartError) && (
          <div
            data-smart-preview
            style={{
              background: smartError ? '#fef2f2' : '#eff6ff',
              border: '1px solid ' + (smartError ? '#fca5a5' : '#bfdbfe'),
              borderRadius: 8,
              padding: '10px 14px',
              marginBottom: 8,
              fontSize: 12,
              color: smartError ? '#b91c1c' : '#1e3a8a',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            {smartError && <span>{smartError}</span>}
            {smartProposal && (
              <>
                <span style={{fontWeight: 600}}>Proposed:</span>
                <span>{buildSmartProposalPreview(smartProposal) || '(none)'}</span>
                {smartProposal.unmapped && smartProposal.unmapped.length > 0 && (
                  <span style={{color: '#92400e', fontStyle: 'italic'}}>
                    Unmapped: {smartProposal.unmapped.join(', ')}
                  </span>
                )}
                {smartProposal.notes && smartProposal.notes.length > 0 && (
                  <span style={{color: '#1e3a8a', fontStyle: 'italic'}}>{smartProposal.notes.join('; ')}</span>
                )}
                <span style={{flex: 1}} />
                <button
                  type="button"
                  onClick={applySmartProposal}
                  data-smart-apply-proposal
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: 'none',
                    background: '#1d4ed8',
                    color: 'white',
                    fontWeight: 600,
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Apply
                </button>
                <button
                  type="button"
                  onClick={discardSmartProposal}
                  data-smart-discard
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid #d1d5db',
                    background: 'white',
                    color: '#6b7280',
                    fontSize: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Discard
                </button>
              </>
            )}
          </div>
        )}

        {/* Top toolbar */}
        <div
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
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
                  name="cattleViewMode"
                  checked={viewMode === 'grouped'}
                  onChange={() => setViewMode('grouped')}
                  data-view-mode="grouped"
                />
                Grouped
              </label>
              <label style={{display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer'}}>
                <input
                  type="radio"
                  name="cattleViewMode"
                  checked={viewMode === 'flat'}
                  onChange={() => setViewMode('flat')}
                  data-view-mode="flat"
                />
                Flat
              </label>
            </div>
            <button
              onClick={() => setShowBulkImport(true)}
              style={{
                padding: '7px 14px',
                borderRadius: 7,
                border: '1px solid #991b1b',
                background: 'white',
                color: '#991b1b',
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
                borderRadius: 7,
                border: 'none',
                background: '#991b1b',
                color: 'white',
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

          <div style={{display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap'}}>
            <span style={{fontSize: 11, color: '#6b7280', fontWeight: 600, marginRight: 4}}>Filters:</span>
            {quickFilterButtons()}
            <SpecialFilterCheckbox filterKey="nonCalvingCows" label="Non Calving Cows" />
            <SpecialFilterCheckbox filterKey="unmatchedCalves" label="Unmatched Calves" />
            <button
              type="button"
              onClick={() => setShowMoreFilters((v) => !v)}
              style={{
                ...chipBaseS,
                color: '#1d4ed8',
                border: '1px dashed #bfdbfe',
              }}
              data-more-filters-toggle
            >
              {showMoreFilters ? 'Hide more filters' : 'More filters…'}
            </button>
            {filterCount > 0 && (
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
                Clear all
              </button>
            )}
          </div>
          {showMoreFilters && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
                paddingLeft: 50,
                paddingTop: 4,
                borderTop: '1px dashed #e5e7eb',
              }}
              data-more-filters-panel
            >
              {moreFiltersButtons()}
            </div>
          )}

          {sortBar()}

          <div style={{fontSize: 11, color: '#6b7280'}} data-cattle-match-count>
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

        {loading && <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading{'…'}</div>}
        {!loading && cattle.length === 0 && (
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
            No cattle records yet. Click <strong>+ Add Cow</strong> to add your first one, or wait for the Podio import.
          </div>
        )}

        {/* FLAT MODE */}
        {!loading && isFlat && cattle.length > 0 && (
          <div
            data-cattle-flat-list
            style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
          >
            <div
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid #e5e7eb',
                background: '#f9fafb',
                fontSize: 12,
                fontWeight: 600,
                color: '#4b5563',
              }}
            >
              {sortedFlat.length} cattle
            </div>
            {sortedFlat.length === 0 && (
              <div style={{padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
                No cattle match the current filter.
              </div>
            )}
            {sortedFlat.map((c, i) => {
              const hc = HERD_COLORS[c.herd] || HERD_COLORS.mommas;
              const lw = lastWeight(c);
              return (
                <div
                  key={c.id}
                  id={'cow-' + c.id}
                  data-cow-row-tag={c.tag || ''}
                  style={{borderBottom: i < sortedFlat.length - 1 ? '1px solid #f3f4f6' : 'none'}}
                >
                  <div
                    onClick={() => navigate('/cattle/herds/' + c.id, recordSeqNavOptions(sortedFlat))}
                    style={{
                      padding: '10px 16px 10px 0',
                      display: 'grid',
                      gridTemplateColumns: '48px 16px 70px 110px 60px 180px 70px 90px 1fr',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      background: c.breeding_blacklist ? '#fecaca' : 'white',
                    }}
                    className="hoverable-tile"
                  >
                    <span
                      style={{
                        fontSize: 11,
                        color: '#9ca3af',
                        fontVariantNumeric: 'tabular-nums',
                        alignSelf: 'stretch',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        paddingRight: 10,
                        paddingLeft: 8,
                        marginTop: -10,
                        marginBottom: -10,
                        borderRight: '1px solid #d1d5db',
                        fontWeight: 600,
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{fontSize: 11, color: '#9ca3af'}}>{'▶'}</span>
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13,
                        color: '#111827',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      {c.tag ? '#' + c.tag : '(no tag)'}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 8px',
                        borderRadius: 4,
                        background: hc.bg,
                        color: hc.tx,
                        border: '1px solid ' + hc.bd,
                        fontWeight: 600,
                        textAlign: 'center',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {HERD_LABELS[c.herd]}
                    </span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{c.sex || '—'}</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: '#6b7280',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {c.breed || '—'}
                    </span>
                    <span style={{fontSize: 11, color: '#6b7280'}}>{age(c.birth_date) || '—'}</span>
                    <span style={{fontSize: 11, color: lw ? '#065f46' : '#9ca3af', fontWeight: lw ? 600 : 400}}>
                      {lw ? lw.toLocaleString() + ' lb' : 'no weigh-in'}
                    </span>
                    <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                      {c.dam_tag && <span style={{fontSize: 11, color: '#9ca3af'}}>{'dam #' + c.dam_tag}</span>}
                      {c.breeding_blacklist && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: '#fef2f2',
                            color: '#b91c1c',
                            fontWeight: 600,
                          }}
                        >
                          BLACKLIST
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* GROUPED MODE — herd tiles */}
        {!loading && !isFlat && cattle.length > 0 && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            {CATTLE_HERD_KEYS.map((h) => {
              // Per-tile sort applies inside the herd group (Codex implementation
              // note 2026-05-02). Filter the global filtered list to this herd
              // then run the comparator within.
              const cmp = buildCattleComparator(sortRules, {calvingRecs, weighIns});
              const cows = filtered.filter((c) => c.herd === h).sort(cmp);
              const totalWt = cows.reduce((s, c) => s + effectiveWeight(c), 0);
              const estCount = cows.filter(
                (c) => (lastWeight(c) == null || lastWeight(c) === 0) && isHerdTileRecentlyPurchased(c),
              ).length;
              const hc = HERD_COLORS[h];
              const herdOpen = !!expandedHerds[h];
              return (
                <div
                  key={h}
                  style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}
                >
                  <div
                    onClick={() => setExpandedHerds({...expandedHerds, [h]: !herdOpen})}
                    data-herd-tile={h}
                    data-herd-open={herdOpen ? '1' : '0'}
                    style={{
                      padding: '12px 18px',
                      background: hc.bg,
                      borderBottom: herdOpen ? '1px solid ' + hc.bd : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{fontSize: 12, color: hc.tx}}>{herdOpen ? '▼' : '▶'}</span>
                    <span style={{fontSize: 15, fontWeight: 700, color: hc.tx}}>
                      {renderCattleIconLabel(HERD_LABELS[h], {size: 21})}
                    </span>
                    <span style={{fontSize: 12, color: hc.tx, opacity: 0.8}}>
                      {cows.length} {cows.length === 1 ? 'cow' : 'cows'}
                    </span>
                    {totalWt > 0 && (
                      <span style={{fontSize: 12, color: hc.tx, opacity: 0.8}}>
                        {'· ' + Math.round(totalWt).toLocaleString() + ' lbs total'}
                      </span>
                    )}
                    {estCount > 0 && (
                      <span style={{fontSize: 11, color: hc.tx, opacity: 0.7, fontStyle: 'italic'}}>
                        {'(' + estCount + ' est. @ 1,000 lb)'}
                      </span>
                    )}
                  </div>
                  {herdOpen && cows.length === 0 && (
                    <div style={{padding: '1rem 18px', color: '#9ca3af', fontSize: 12, fontStyle: 'italic'}}>
                      {filterCount > 0 ? 'No cows match the current filters.' : 'No cows in this herd yet.'}
                    </div>
                  )}
                  {herdOpen &&
                    cows.map((c, cowIdx) => {
                      const lw = lastWeight(c);
                      const lc = lastCalving(c.tag);
                      const cc = calfCount(c.tag);
                      return (
                        <div
                          key={c.id}
                          id={'cow-' + c.id}
                          data-cow-row-tag={c.tag || ''}
                          style={{borderBottom: '1px solid #f3f4f6'}}
                        >
                          <div
                            onClick={() => navigate('/cattle/herds/' + c.id, recordSeqNavOptions(cows))}
                            style={{
                              padding: '10px 18px 10px 0',
                              display: 'grid',
                              gridTemplateColumns: '48px 16px 70px 60px 180px 70px 90px 1fr',
                              alignItems: 'center',
                              gap: 10,
                              cursor: 'pointer',
                              background: c.breeding_blacklist ? '#fecaca' : 'transparent',
                            }}
                            className="hoverable-tile"
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: '#9ca3af',
                                fontVariantNumeric: 'tabular-nums',
                                alignSelf: 'stretch',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                paddingRight: 10,
                                paddingLeft: 8,
                                marginTop: -10,
                                marginBottom: -10,
                                borderRight: '1px solid #d1d5db',
                                fontWeight: 600,
                              }}
                            >
                              {cowIdx + 1}
                            </span>
                            <span style={{fontSize: 11, color: '#9ca3af'}}>{'▶'}</span>
                            <span
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                color: '#111827',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                              }}
                            >
                              {c.tag ? '#' + c.tag : '(no tag)'}
                            </span>
                            <span style={{fontSize: 11, color: '#6b7280'}}>{c.sex || '—'}</span>
                            <span
                              style={{
                                fontSize: 11,
                                color: '#6b7280',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {c.breed || '—'}
                            </span>
                            <span style={{fontSize: 11, color: '#6b7280'}}>{age(c.birth_date) || '—'}</span>
                            <span style={{fontSize: 11, color: lw ? '#065f46' : '#9ca3af', fontWeight: lw ? 600 : 400}}>
                              {lw ? lw.toLocaleString() + ' lb' : '—'}
                            </span>
                            <span style={{display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap'}}>
                              {c.dam_tag && <span style={{fontSize: 11, color: '#9ca3af'}}>{'dam #' + c.dam_tag}</span>}
                              {h === 'mommas' && (
                                <span data-calf-count={cc} style={{fontSize: 11, color: '#7f1d1d', fontWeight: 600}}>
                                  {'Calves: ' + cc}
                                </span>
                              )}
                              {h === 'mommas' && lc && (
                                <span style={{fontSize: 11, color: '#9ca3af'}}>
                                  {'last calved ' + fmt(lc.calving_date)}
                                </span>
                              )}
                              {c.breeding_blacklist && (
                                <span
                                  style={{
                                    fontSize: 10,
                                    padding: '1px 6px',
                                    borderRadius: 4,
                                    background: '#fef2f2',
                                    color: '#b91c1c',
                                    fontWeight: 600,
                                  }}
                                >
                                  BLACKLIST
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <CollapsibleOutcomeSections
              cattle={cattle}
              weighIns={weighIns}
              HERD_COLORS={HERD_COLORS}
              HERD_LABELS={HERD_LABELS}
              OUTCOMES={CATTLE_OUTCOME_KEYS}
              fmt={fmt}
              setStatusFilter={(value) => {
                if (!value || value === 'active') return;
                if (value === 'all') {
                  setViewMode('flat');
                  clearFilter('herdSet');
                  return;
                }
                setViewMode('flat');
                setFilter('herdSet', [value]);
              }}
              processingInfo={processingInfo}
              onCowClick={(c) => navigate('/cattle/herds/' + c.id)}
            />
          </div>
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
                borderBottom: '1px solid #e5e7eb',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{fontSize: 15, fontWeight: 600, color: '#991b1b'}}>{editId ? 'Edit Cow' : 'Add Cow'}</div>
              <button
                onClick={() => {
                  closeCowForm();
                }}
                style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
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
                        borderRadius: 6,
                        border: 'none',
                        background: '#1d4ed8',
                        color: 'white',
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
                        borderRadius: 6,
                        border: '1px solid #d1d5db',
                        background: 'white',
                        color: '#374151',
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

              <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 4}}>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6}}>
                  <label
                    style={{
                      ...lbl,
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: '#374151',
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
                      color: '#1d4ed8',
                      background: 'none',
                      border: '1px dashed #bfdbfe',
                      borderRadius: 5,
                      padding: '3px 10px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    + Add Prior Tag
                  </button>
                </div>
                <div style={{fontSize: 11, color: '#6b7280', marginBottom: 8}}>
                  Tags this cow had before her current one — the purchase tag from the selling farm, plus any tags
                  swapped out over time. Multiple entries supported.
                </div>
                {(form.old_tags || []).length === 0 && (
                  <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic', padding: '4px 0'}}>
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
                          borderRadius: 5,
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
                <div style={{gridColumn: '1/-1', borderTop: '1px solid #e5e7eb', paddingTop: 12, marginTop: 4}}>
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
                  <div style={{fontSize: 11, color: '#9ca3af', marginLeft: 26, marginTop: 4}}>
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
            <div style={{padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8}}>
              <button
                onClick={saveCow}
                disabled={saving}
                style={{
                  padding: '8px 20px',
                  borderRadius: 7,
                  border: 'none',
                  background: '#991b1b',
                  color: 'white',
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
                    borderRadius: 7,
                    border: '1px solid #F09595',
                    background: 'white',
                    color: '#b91c1c',
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
                  borderRadius: 7,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#6b7280',
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
    border: '1px solid #d1d5db',
    borderRadius: 8,
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
      <div style={{fontSize: 10, color: '#6b7280', fontStyle: 'italic', marginTop: 4}}>Applies to females only.</div>
    );
  }

  switch (filterKey) {
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
                {opt.source === 'historical' && <em style={{color: '#9ca3af', marginLeft: 4}}>(historical)</em>}
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
                {opt.source === 'historical' && <em style={{color: '#9ca3af', marginLeft: 4}}>(historical)</em>}
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
    <div style={{display: 'flex', gap: 6, marginTop: 6, paddingTop: 6, borderTop: '1px solid #f3f4f6'}}>
      <button
        type="button"
        onClick={onClear}
        style={{
          fontSize: 11,
          color: '#b91c1c',
          background: 'none',
          border: '1px solid #fecaca',
          borderRadius: 5,
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
          color: '#374151',
          background: 'white',
          border: '1px solid #d1d5db',
          borderRadius: 5,
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
