// ============================================================================
// src/pasture/PastureMapView.jsx - Pasture Map
// ----------------------------------------------------------------------------
// Redesign handoff rebuild: a grazing planning cockpit with five modes
// (View / Map, Plan, Field, Setup, Reports). Existing backend contracts remain:
// geometry, import/classification, draw/edit, move ledger, planned moves,
// reports, offline replay, field tracks, and line styling all go through the
// pasture-scoped SECDEF RPC wrappers.
// ============================================================================
import React from 'react';
import PastureMapCanvas from './PastureMapCanvas.jsx';
import {parseKmlToPlacemarks, parseAcreageNote, closeOutlineToPolygon} from '../lib/pastureKml.js';
import {haversineM, lineMetrics} from '../lib/pastureGeometry.js';
import {
  listLandAreas,
  importLandAreaBatch,
  updateLandArea,
  classifyLandArea,
  closeLandAreaOutline,
  deleteLandArea,
  createLandArea,
  createLandAreaTrack,
  updateLandAreaGeometry,
  updateLandAreaStyle,
  listPastureMoves,
  recordPastureMove,
  listPasturePlannedMoves,
  createPasturePlannedMove,
  updatePasturePlannedMoveStatus,
  listPastureHistoryReport,
  listPastureRestReport,
  listPastureStockingReport,
  newImportBatchId,
  newLandAreaId,
  newPastureTrackId,
  newPastureMoveId,
  newPasturePlanId,
} from '../lib/pastureMapApi.js';
import {
  cachePastureSnapshot,
  classifyPastureOfflineError,
  discardPastureOperation,
  enqueuePastureOperation,
  getPastureQueueState,
  loadPastureSnapshot,
  retryPastureOperation,
  syncPastureQueue,
} from '../lib/pastureOffline.js';
import './pastureMap.css';

const KIND_LABEL = {
  unclassified: 'Unclassified',
  pasture: 'Pasture',
  feeder_pig_area: 'Feeder Pig Area',
  section: 'Section',
  paddock: 'Paddock',
  infrastructure: 'Infrastructure',
  scratch: 'Temp',
  outline_candidate: 'Outline',
};

const DRAW_KINDS = ['unclassified', 'pasture', 'paddock', 'feeder_pig_area', 'section', 'infrastructure'];
const LINE_STYLE_COLORS = ['#15803d', '#2563eb', '#d97706', '#dc2626', '#7c3aed', '#0f172a', '#ffffff'];
const DEFAULT_LINE_COLOR = '#15803d';
const DEFAULT_LINE_WEIGHT = 2;
const DEFAULT_LINE_PATTERN = 'solid';
const MIN_LINE_WEIGHT = 1;
const MAX_LINE_WEIGHT = 10;
const LINE_STYLE_PATTERNS = [
  {key: 'solid', label: 'Solid', css: 'solid'},
  {key: 'dashed', label: 'Dashed', css: 'dashed'},
  {key: 'dotted', label: 'Dotted', css: 'dotted'},
];

const ANIMAL_TYPE_LABEL = {
  cattle_herd: 'Cattle herd',
  sheep_flock: 'Sheep flock',
  breeder_pigs: 'Breeder pigs',
  feeder_pigs: 'Feeder pigs',
};

const GROUP_PRESETS = {
  cattle_herd: [
    {key: 'main', label: 'Main Herd'},
    {key: 'stock', label: 'Stockers'},
    {key: 'mommas', label: 'Mommas'},
    {key: 'backgrounders', label: 'Backgrounders'},
    {key: 'finishers', label: 'Finishers'},
    {key: 'bulls', label: 'Bulls'},
  ],
  sheep_flock: [
    {key: 'ewe', label: 'Ewe Flock'},
    {key: 'ram', label: 'Ram & Repl.'},
    {key: 'ewes', label: 'Ewes'},
    {key: 'rams', label: 'Rams'},
    {key: 'feeders', label: 'Feeders'},
  ],
  breeder_pigs: [
    {key: 'sowA', label: 'Sow Group A'},
    {key: 'sowB', label: 'Sow Group B'},
    {key: 'sowC', label: 'Sow Group C'},
    {key: 'sowD', label: 'Sow Group D'},
    {key: 'breeder-pigs', label: 'Breeder pigs'},
  ],
  feeder_pigs: [{key: 'feeder-pigs', label: 'Feeder pigs'}],
};

const SPECIES = {
  cattle: {label: 'Cattle', animalType: 'cattle_herd', color: '#9A3B2E', ink: '#7C3023', soft: '#F4E5E2'},
  pig: {label: 'Pigs', animalType: 'breeder_pigs', color: '#A8418A', ink: '#852F6D', soft: '#F3E3EE'},
  sheep: {label: 'Sheep', animalType: 'sheep_flock', color: '#1E8A8A', ink: '#166A6A', soft: '#DEF0F0'},
};

const DEFAULT_GROUPS = [
  {
    id: 'main',
    name: 'Main Herd',
    species: 'cattle',
    groupKey: 'main',
    short: 'MH',
    size: '86 cow-calf pairs',
    day: 2,
    plannedDays: 3,
  },
  {
    id: 'stock',
    name: 'Stockers',
    species: 'cattle',
    groupKey: 'stock',
    short: 'ST',
    size: '120 yearlings',
    day: 1,
    plannedDays: 2,
  },
  {
    id: 'sowA',
    name: 'Sow Group A',
    species: 'pig',
    groupKey: 'sowA',
    short: 'A',
    size: '18 sows',
    day: 4,
    plannedDays: 5,
  },
  {
    id: 'sowB',
    name: 'Sow Group B',
    species: 'pig',
    groupKey: 'sowB',
    short: 'B',
    size: '16 sows',
    day: 2,
    plannedDays: 5,
  },
  {
    id: 'sowC',
    name: 'Sow Group C',
    species: 'pig',
    groupKey: 'sowC',
    short: 'C',
    size: '15 sows',
    day: 3,
    plannedDays: 5,
  },
  {
    id: 'sowD',
    name: 'Sow Group D',
    species: 'pig',
    groupKey: 'sowD',
    short: 'D',
    size: '17 sows',
    day: 1,
    plannedDays: 5,
  },
  {
    id: 'ewe',
    name: 'Ewe Flock',
    species: 'sheep',
    groupKey: 'ewe',
    short: 'EW',
    size: '140 ewes',
    day: 5,
    plannedDays: 7,
  },
  {
    id: 'ram',
    name: 'Ram & Repl.',
    species: 'sheep',
    groupKey: 'ram',
    short: 'RM',
    size: '45 head',
    day: 2,
    plannedDays: 6,
  },
];

const DEFAULT_ROTATION_CODES = {
  main: ['N4', 'S2', 'N3', 'E1', 'S1', 'N1'],
  stock: ['E3', 'E1', 'N3', 'N2'],
  sowA: ['N5', 'N2', 'N1'],
  sowB: ['S3', 'S2', 'S1'],
  sowC: ['E2', 'E1'],
  sowD: ['E4', 'E3'],
  ewe: ['S1', 'N1', 'N3'],
  ram: ['S4', 'S2'],
};

const MODE_TABS = [
  {id: 'view', label: 'View / Map', hint: 'Neutral browse - select a pasture'},
  {id: 'plan', label: 'Plan', hint: 'Build moves per animal group'},
  {id: 'field', label: 'Field', hint: 'Phone-first execution'},
  {id: 'setup', label: 'Setup', hint: 'Manager tools - not shown in field'},
  {id: 'reports', label: 'Reports', hint: 'Reports stay out of the planning flow'},
];

function renderPastureMapCanvas(props) {
  return React.createElement(PastureMapCanvas, props);
}

function slugKey(label) {
  return (label || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function localDateTimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function tomorrowMorningValue() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return localDateTimeValue(d);
}

function initialMoveForm() {
  return {
    animalType: 'cattle_herd',
    groupKey: 'main',
    groupLabel: 'Main Herd',
    movedAt: localDateTimeValue(),
    animalCount: '',
    notes: '',
  };
}

function initialPlanForm() {
  return {
    animalType: 'cattle_herd',
    groupKey: 'main',
    groupLabel: 'Main Herd',
    plannedFor: tomorrowMorningValue(),
    animalCount: '',
    notes: '',
  };
}

function resolveGroup(form) {
  const groupLabel = (form.groupLabel || '').trim();
  const groupKey = ((form.groupKey || '').trim() || slugKey(groupLabel)).trim();
  return {groupLabel, groupKey};
}

function parseOptionalCount(value) {
  if (value === '' || value == null) return null;
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count) || count <= 0) return NaN;
  return count;
}

function cleanLineColor(value) {
  if (typeof value !== 'string') return '';
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : '';
}

function cleanLineWeight(value) {
  const weight = Number.parseInt(value, 10);
  if (!Number.isFinite(weight)) return DEFAULT_LINE_WEIGHT;
  return Math.min(MAX_LINE_WEIGHT, Math.max(MIN_LINE_WEIGHT, weight));
}

function cleanLinePattern(value) {
  return value === 'solid' || value === 'dashed' || value === 'dotted' ? value : DEFAULT_LINE_PATTERN;
}

function cssLinePattern(value) {
  return LINE_STYLE_PATTERNS.find((p) => p.key === cleanLinePattern(value))?.css || 'solid';
}

function labelLinePattern(value) {
  return LINE_STYLE_PATTERNS.find((p) => p.key === cleanLinePattern(value))?.label || 'Solid';
}

function styleDraftFromArea(area) {
  return {
    lineColor: cleanLineColor(area && area.line_color) || DEFAULT_LINE_COLOR,
    lineWeight: cleanLineWeight(area && area.line_weight),
    linePattern: cleanLinePattern(area && area.line_pattern),
  };
}

function lineStyleChanged(area, draft) {
  if (!area || !draft) return false;
  const currentColor = cleanLineColor(area.line_color) || '';
  const currentWeight = area.line_weight == null ? null : cleanLineWeight(area.line_weight);
  const currentPattern = area.line_pattern == null ? null : cleanLinePattern(area.line_pattern);
  if (
    !currentColor &&
    currentWeight == null &&
    currentPattern == null &&
    draft.lineColor === DEFAULT_LINE_COLOR &&
    draft.lineWeight === DEFAULT_LINE_WEIGHT &&
    draft.linePattern === DEFAULT_LINE_PATTERN
  ) {
    return false;
  }
  return currentColor !== draft.lineColor || currentWeight !== draft.lineWeight || currentPattern !== draft.linePattern;
}

function linePreviewStyle({lineColor, lineWeight, linePattern}) {
  return {
    borderTop: `${cleanLineWeight(lineWeight)}px ${cssLinePattern(linePattern)} ${lineColor || DEFAULT_LINE_COLOR}`,
  };
}

function initialTrackState() {
  return {recording: false, points: [], lastAccuracyFt: null, error: '', startedAt: null};
}

function trackGeometryFromPoints(points) {
  return {type: 'LineString', coordinates: (points || []).map((p) => [p.lng, p.lat])};
}

function trackMetricsFromPoints(points) {
  return lineMetrics(trackGeometryFromPoints(points));
}

function formatDistanceFt(feet) {
  if (feet == null || !Number.isFinite(Number(feet))) return '';
  if (feet >= 5280) return `${Math.round((feet / 5280) * 100) / 100} mi`;
  return `${Math.round(feet).toLocaleString()} ft`;
}

function isSameLocalDate(a, b) {
  if (!a || !b) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatMoveTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

function grazingState(area) {
  if (!area) return 'no_history';
  if (area.status === 'blocked_repair' || area.geometry_status === 'invalid') return 'invalid';
  if (area.rest_state === 'occupied' || Number(area.current_occupancy_count || 0) > 0) return 'occupied';
  if (area.rest_state === 'resting') return 'resting';
  if (area.rest_state === 'rested' || area.rest_state === 'ready') return 'ready';
  return 'no_history';
}

function restCopy(area) {
  if (!area) return 'No area selected';
  if (area.rest_state === 'occupied') return 'Occupied now';
  if (area.rest_state === 'resting')
    return area.rest_days == null ? 'Resting' : `${area.rest_days} day${area.rest_days === 1 ? '' : 's'} resting`;
  if (area.rest_state === 'rested')
    return area.rest_days == null ? 'Ready' : `${area.rest_days} day${area.rest_days === 1 ? '' : 's'} rested`;
  if (area.rest_state === 'baseline' || area.rest_state === 'no_history') return 'No move history yet';
  return 'No active occupancy';
}

function densityCopy(area) {
  const acres = Number(area && area.effective_acres);
  if (
    !area ||
    !Array.isArray(area.current_occupants) ||
    !area.current_occupants.length ||
    !Number.isFinite(acres) ||
    acres <= 0
  )
    return '';
  const total = area.current_occupants.reduce((sum, o) => {
    const n = Number(o.animal_count);
    return Number.isFinite(n) && n > 0 ? sum + n : sum;
  }, 0);
  if (!total) return '';
  const density = Math.round((total / acres) * 100) / 100;
  return `${total.toLocaleString()} animals on ${Math.round(acres * 100) / 100} ac - ${density.toLocaleString()} / ac`;
}

function areaFacts(area) {
  if (!area) return [];
  const facts = [];
  facts.push(area.last_touched_at ? `Last used ${formatMoveTime(area.last_touched_at)}` : 'Last used: no move history');
  if (area.last_moved_out_at) facts.push(`Rest started ${formatMoveTime(area.last_moved_out_at)}`);
  if (area.rest_state === 'occupied') facts.push('Days rested: 0');
  else if (area.rest_days != null) facts.push(`${area.rest_days} day${area.rest_days === 1 ? '' : 's'} rested`);
  else facts.push('Days rested: not started');
  return facts;
}

function hasPolygonGeom(a) {
  if (!a) return false;
  if (a.current_version && a.current_version.geometry) return true;
  const rg = a.raw_geometry;
  return !!(rg && (rg.type === 'Polygon' || rg.type === 'MultiPolygon'));
}

function normalizeAreaCode(value) {
  return (value || '')
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function findAreaByCode(areas, code) {
  const wanted = normalizeAreaCode(code);
  return (
    (areas || []).find(
      (area) => normalizeAreaCode(area.name || area.id) === wanted || normalizeAreaCode(area.id) === wanted,
    ) || null
  );
}

function groupSizeCount(group) {
  const count = Number.parseInt((group && group.size) || '', 10);
  return Number.isFinite(count) && count > 0 ? count : null;
}

function groupSpeciesStyle(group) {
  return SPECIES[(group && group.species) || 'cattle'] || SPECIES.cattle;
}

function groupAnimalType(group) {
  return group.animalType || groupSpeciesStyle(group).animalType || 'cattle_herd';
}

function buildInitialRotation(group, areas, index) {
  if (!areas.length) return [];
  const codes = DEFAULT_ROTATION_CODES[group.id] || [];
  const mapped = codes.map((code) => findAreaByCode(areas, code)).filter(Boolean);
  const ids = mapped.map((area) => area.id);
  if (ids.length) return [...new Set(ids)];
  const span = Math.min(Math.max(areas.length, 1), group.species === 'pig' ? 3 : 5);
  return Array.from({length: Math.min(span, areas.length)}, (_, i) => areas[(index + i) % areas.length].id);
}

function statusLabelForState(state) {
  if (state === 'occupied') return 'Occupied';
  if (state === 'resting') return 'Resting';
  if (state === 'ready') return 'Ready';
  if (state === 'invalid') return 'Invalid';
  return 'No history';
}

export default function PastureMapView({_Header, authState}) {
  const role = authState && authState.role;
  const isManager = role === 'management' || role === 'admin';
  const canRecordMoves = role === 'farm_team' || role === 'management' || role === 'admin';
  const canCreateTrack = role === 'farm_team' || role === 'management' || role === 'admin';
  const userName =
    (authState &&
      (authState.name || authState.profile?.name || authState.profile?.full_name || authState.user?.email)) ||
    'WCF Team';

  const [areas, setAreas] = React.useState([]);
  const [moves, setMoves] = React.useState([]);
  const [plans, setPlans] = React.useState([]);
  const [restReport, setRestReport] = React.useState({areas: [], counts: {}});
  const [stockingReport, setStockingReport] = React.useState({areas: []});
  const [historyRows, setHistoryRows] = React.useState([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [offlineStatus, setOfflineStatus] = React.useState('');
  const [queueState, setQueueState] = React.useState({queued: [], stuck: [], queuedCount: 0, stuckCount: 0});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [busyId, setBusyId] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  const fileRef = React.useRef(null);

  const [appMode, setAppMode] = React.useState('view');
  const [mapMode, setMapMode] = React.useState('select');
  const [selectedId, setSelectedId] = React.useState(null);
  const [legendOpen, setLegendOpen] = React.useState(true);
  const [showRotationPath, setShowRotationPath] = React.useState(true);
  const [listView, setListView] = React.useState(false);
  const [addMode, setAddMode] = React.useState(false);
  const [expandedPasture, setExpandedPasture] = React.useState(null);
  const [openReport, setOpenReport] = React.useState('rest');
  const [zoomSignal, setZoomSignal] = React.useState(0);
  const [styleDraft, setStyleDraft] = React.useState(() => styleDraftFromArea(null));
  const [drawForm, setDrawForm] = React.useState(null);
  const [editGeom, setEditGeom] = React.useState(null);
  const [track, setTrack] = React.useState(() => initialTrackState());
  const [trackForm, setTrackForm] = React.useState(null);
  const [moveForm, setMoveForm] = React.useState(() => initialMoveForm());
  const [planForm, setPlanForm] = React.useState(() => initialPlanForm());
  const [activePlanId, setActivePlanId] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
  const [planSaving, setPlanSaving] = React.useState(false);
  const [planBusyId, setPlanBusyId] = React.useState(null);
  const [groups, setGroups] = React.useState(() => DEFAULT_GROUPS);
  const [rotations, setRotations] = React.useState({});
  const [activeGroupId, setActiveGroupId] = React.useState('main');
  const [fieldOffline, setFieldOffline] = React.useState(true);
  const [fieldQueue, setFieldQueue] = React.useState([
    {id: 'demo-1', label: 'Main Herd -> N4', status: 'Queued', time: 'Today 7:43 AM'},
    {id: 'demo-2', label: 'Close gate - S2 lane', status: 'Queued', time: 'Today 7:45 AM'},
  ]);
  const trackWatchRef = React.useRef(null);

  async function refreshQueueState() {
    try {
      setQueueState(await getPastureQueueState());
    } catch {
      /* IndexedDB unavailable; save paths surface concrete errors. */
    }
  }

  async function reload() {
    setLoading(true);
    setErr('');
    try {
      await syncPastureQueue();
      const [areaRes, moveRes, planRes, restRes, stockingRes] = await Promise.all([
        listLandAreas(false),
        listPastureMoves(75),
        listPasturePlannedMoves({status: 'planned', limit: 75}),
        listPastureRestReport(),
        listPastureStockingReport(),
      ]);
      const nextAreas = (areaRes && areaRes.land_areas) || [];
      const nextMoves = (moveRes && moveRes.moves) || [];
      const nextPlans = (planRes && planRes.planned_moves) || [];
      const nextRest = restRes || {areas: [], counts: {}};
      const nextStocking = stockingRes || {areas: []};
      setAreas(nextAreas);
      setMoves(nextMoves);
      setPlans(nextPlans);
      setRestReport(nextRest);
      setStockingReport(nextStocking);
      cachePastureSnapshot({
        areas: nextAreas,
        moves: nextMoves,
        plans: nextPlans,
        restReport: nextRest,
        stockingReport: nextStocking,
      });
      setOfflineStatus('');
      await refreshQueueState();
    } catch (e) {
      const cached = loadPastureSnapshot();
      if (cached) {
        setAreas(cached.areas || []);
        setMoves(cached.moves || []);
        setPlans(cached.plans || []);
        setRestReport(cached.restReport || {areas: [], counts: {}});
        setStockingReport(cached.stockingReport || {areas: []});
        setOfflineStatus(
          cached.savedAt
            ? `Showing saved field map from ${formatMoveTime(cached.savedAt)}. New work will queue on this device.`
            : 'Showing saved field map. New work will queue on this device.',
        );
        await refreshQueueState();
      } else {
        setErr(e.message || 'Failed to load land areas');
      }
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    function handleOnline() {
      reload();
    }
    if (typeof window !== 'undefined') window.addEventListener('online', handleOnline);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('online', handleOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    let alive = true;
    if (!selectedId) {
      setHistoryRows([]);
      setHistoryLoading(false);
      return () => {
        alive = false;
      };
    }
    setHistoryLoading(true);
    listPastureHistoryReport({landAreaId: selectedId, limit: 20})
      .then((res) => {
        if (alive) setHistoryRows((res && res.history) || []);
      })
      .catch((e) => {
        if (alive) setErr(e.message || 'Could not load pasture history.');
      })
      .finally(() => {
        if (alive) setHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedId, moves.length]);

  React.useEffect(() => () => clearTrackWatch(), []);

  const activeAreas = React.useMemo(
    () => areas.filter((area) => area.status !== 'retired' && area.geometry_status !== 'deleted'),
    [areas],
  );
  const areaById = React.useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  const activeGroup = groups.find((group) => group.id === activeGroupId) || groups[0] || DEFAULT_GROUPS[0];
  const activeSpecies = groupSpeciesStyle(activeGroup);
  const activeRotation = (rotations[activeGroup.id] || []).filter((id) => areaById.has(id));
  const nowArea = areaById.get(activeRotation[0]) || null;
  const nextArea = areaById.get(activeRotation[1]) || null;
  const selectedArea = areas.find((a) => a.id === selectedId) || null;
  const selectedEditable = hasPolygonGeom(selectedArea);
  const selectedDensity = densityCopy(selectedArea);
  const selectedStyleChanged = lineStyleChanged(selectedArea, styleDraft);
  const selectedStyleBusy = selectedArea && busyId === selectedArea.id;
  const activeTrackGeometry =
    mapMode === 'track'
      ? trackForm && trackForm.geometry
        ? trackForm.geometry
        : track.points.length
          ? trackGeometryFromPoints(track.points)
          : null
      : null;

  React.useEffect(() => {
    setRotations((prev) => {
      const next = {...prev};
      const ids = new Set(activeAreas.map((area) => area.id));
      groups.forEach((group, index) => {
        const current = (next[group.id] || []).filter((id) => ids.has(id));
        next[group.id] = current.length ? [...new Set(current)] : buildInitialRotation(group, activeAreas, index);
      });
      return next;
    });
  }, [activeAreas, groups]);

  React.useEffect(() => {
    setStyleDraft(styleDraftFromArea(selectedArea));
  }, [selectedArea]);

  const sameDayMoveWarning = React.useMemo(() => {
    const {groupKey} = resolveGroup(moveForm);
    const movedDate = new Date(moveForm.movedAt);
    if (!groupKey || Number.isNaN(movedDate.getTime())) return '';
    const prior = moves.find((m) => {
      const priorDate = new Date(m.moved_at);
      return m.animal_type === moveForm.animalType && m.group_key === groupKey && isSameLocalDate(priorDate, movedDate);
    });
    return prior
      ? `Same-day move already recorded at ${formatMoveTime(prior.moved_at)}. Check the time before saving.`
      : '';
  }, [moves, moveForm]);

  const statusCounts = React.useMemo(() => {
    const seed = {occupied: 0, resting: 0, ready: 0, no_history: 0, invalid: 0};
    activeAreas.forEach((area) => {
      seed[grazingState(area)] += 1;
    });
    return seed;
  }, [activeAreas]);
  const classifyQueue = React.useMemo(
    () =>
      activeAreas.filter(
        (area) =>
          area.review_status === 'pending_review' ||
          area.kind === 'unclassified' ||
          area.kind === 'outline_candidate' ||
          area.geometry_status === 'outline_candidate' ||
          area.geometry_status === 'invalid',
      ),
    [activeAreas],
  );
  const invalidArea = activeAreas.find((area) => grazingState(area) === 'invalid') || null;
  const restCounts = restReport && restReport.counts ? restReport.counts : {};
  const stockingRows = (stockingReport && stockingReport.areas) || [];
  const restSuggestion = React.useMemo(() => {
    const candidates = activeAreas
      .filter((area) => grazingState(area) === 'ready' && !activeRotation.includes(area.id))
      .sort((a, b) => Number(b.rest_days || 0) - Number(a.rest_days || 0));
    return candidates[0] || null;
  }, [activeAreas, activeRotation]);

  function clearTrackWatch() {
    if (trackWatchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(trackWatchRef.current);
    }
    trackWatchRef.current = null;
  }

  function resetTrackFlow() {
    clearTrackWatch();
    setTrack(initialTrackState());
    setTrackForm(null);
  }

  function switchAppMode(next) {
    setAppMode(next);
    setErr('');
    if (next !== 'plan') setAddMode(false);
    if (next !== 'setup' && mapMode === 'track') resetTrackFlow();
    if (!['setup', 'plan'].includes(next) && ['draw', 'edit'].includes(mapMode)) setMapMode('select');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }

  function switchToolMode(next) {
    setErr('');
    setAddMode(false);
    setDrawForm(null);
    setEditGeom(null);
    if (next !== 'track') resetTrackFlow();
    setMapMode(next);
  }

  function startEdit() {
    const a = areas.find((x) => x.id === selectedId);
    if (!a) {
      setErr('Select an area first, then use Edit Boundary.');
      return;
    }
    if (!hasPolygonGeom(a)) {
      setErr('That area is an outline with no polygon yet - use Close Outline first, then Edit Boundary.');
      return;
    }
    setErr('');
    setEditGeom(null);
    setAppMode('setup');
    setMapMode('edit');
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setErr('');
    try {
      const text = await file.text();
      const placemarks = parseKmlToPlacemarks(text);
      if (!placemarks.length) {
        setErr('No placemarks found in that KML. Export Area Shapes/Lines from the OnX Web Map.');
        return;
      }
      setPreview({
        fileName: file.name,
        placemarks,
        polygons: placemarks.filter((p) => !p.is_outline_candidate).length,
        lines: placemarks.filter((p) => p.is_outline_candidate).length,
      });
      setAppMode('setup');
    } catch (e2) {
      setErr('Could not parse that file as KML: ' + (e2.message || e2));
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setImporting(true);
    setErr('');
    try {
      await importLandAreaBatch({
        batchId: newImportBatchId(),
        source: 'onx_kml',
        fileName: preview.fileName,
        placemarks: preview.placemarks,
      });
      setPreview(null);
      await reload();
    } catch (e) {
      setErr(e.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  async function withBusy(id, fn) {
    setBusyId(id);
    setErr('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const classify = (a, kind) => withBusy(a.id, () => classifyLandArea(a.id, kind));
  const removeArea = (a) => withBusy(a.id, () => deleteLandArea(a.id));
  const saveAreaPatch = (a, fields) => withBusy(a.id, () => updateLandArea(a.id, fields));

  function closeOutline(a) {
    const res = closeOutlineToPolygon(a.raw_geometry);
    if (!res.valid) {
      setErr(`Cannot close "${a.name}": ${res.reason}.`);
      return;
    }
    return withBusy(a.id, () => closeLandAreaOutline(a.id, res.polygon, 'unclassified'));
  }

  function onDrawComplete(geometry, metrics) {
    setDrawForm({geometry, metrics, name: '', kind: appMode === 'plan' ? 'paddock' : 'unclassified'});
  }

  function onEditGeometry(geometry, metrics) {
    setEditGeom({geometry, metrics});
  }

  function startTrack() {
    if (!canCreateTrack) {
      setErr('Your role cannot create field tracks.');
      return;
    }
    setAppMode('setup');
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setTrack({...initialTrackState(), error: 'GPS is unavailable on this device/browser.'});
      setMapMode('track');
      return;
    }
    clearTrackWatch();
    setErr('');
    setDrawForm(null);
    setEditGeom(null);
    setTrackForm(null);
    setTrack({...initialTrackState(), recording: true, startedAt: new Date().toISOString()});
    setMapMode('track');
    trackWatchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const lng = Number(pos.coords.longitude);
        const lat = Number(pos.coords.latitude);
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
        const accuracyFt =
          Number.isFinite(Number(pos.coords.accuracy)) && Number(pos.coords.accuracy) > 0
            ? Math.round(Number(pos.coords.accuracy) * 3.28084)
            : null;
        setTrack((t) => {
          const prev = t.points[t.points.length - 1];
          if (prev && haversineM([prev.lng, prev.lat], [lng, lat]) < 1.5)
            return {...t, recording: true, lastAccuracyFt: accuracyFt, error: ''};
          return {
            ...t,
            recording: true,
            points: [...t.points, {lng, lat, accuracyFt, at: new Date().toISOString()}],
            lastAccuracyFt: accuracyFt,
            error: '',
          };
        });
      },
      (geoErr) => {
        setTrack((t) => ({
          ...t,
          recording: false,
          error: geoErr && geoErr.message ? geoErr.message : 'GPS tracking failed.',
        }));
        clearTrackWatch();
      },
      {enableHighAccuracy: true, maximumAge: 1000, timeout: 15000},
    );
  }

  function stopTrack() {
    clearTrackWatch();
    const geometry = trackGeometryFromPoints(track.points);
    const metrics = lineMetrics(geometry);
    if (!metrics.valid) {
      setTrack((t) => ({...t, recording: false, error: 'Track needs at least two GPS points before it can be saved.'}));
      return;
    }
    setTrack((t) => ({...t, recording: false, error: ''}));
    setTrackForm({geometry, metrics, name: ''});
  }

  function cancelTrack() {
    resetTrackFlow();
    setMapMode('select');
  }

  async function saveTrack() {
    if (!trackForm) return;
    if (!trackForm.name.trim()) {
      setTrack((t) => ({...t, error: 'Name is required to save a track.'}));
      return;
    }
    const trackId = newPastureTrackId();
    const createPayload = {id: trackId, name: trackForm.name.trim(), line: trackForm.geometry, source: 'drawn'};
    setSaving(true);
    setErr('');
    try {
      const saved = await createLandAreaTrack(createPayload);
      resetTrackFlow();
      setMapMode('select');
      setSelectedId((saved && saved.id) || trackId);
      await reload();
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: trackId, op: 'create_track', payload: createPayload});
        await refreshQueueState();
        resetTrackFlow();
        setMapMode('select');
        setOfflineStatus('Field track saved on this device and will sync when the connection returns.');
      } else {
        setTrack((t) => ({...t, error: e.message || 'Could not save field track.'}));
      }
    } finally {
      setSaving(false);
    }
  }

  function updateMoveType(type) {
    const preset = (GROUP_PRESETS[type] || [])[0] || {key: '', label: ''};
    setMoveForm((f) => ({...f, animalType: type, groupKey: preset.key, groupLabel: preset.label}));
  }

  function updateMovePreset(key) {
    if (key === '__custom') {
      setMoveForm((f) => ({...f, groupKey: '', groupLabel: ''}));
      return;
    }
    const preset = (GROUP_PRESETS[moveForm.animalType] || []).find((p) => p.key === key);
    if (preset) setMoveForm((f) => ({...f, groupKey: preset.key, groupLabel: preset.label}));
  }

  function updatePlanType(type) {
    const preset = (GROUP_PRESETS[type] || [])[0] || {key: '', label: ''};
    setPlanForm((f) => ({...f, animalType: type, groupKey: preset.key, groupLabel: preset.label}));
  }

  function updatePlanPreset(key) {
    if (key === '__custom') {
      setPlanForm((f) => ({...f, groupKey: '', groupLabel: ''}));
      return;
    }
    const preset = (GROUP_PRESETS[planForm.animalType] || []).find((p) => p.key === key);
    if (preset) setPlanForm((f) => ({...f, groupKey: preset.key, groupLabel: preset.label}));
  }

  async function saveMove() {
    if (!selectedId) {
      setErr('Select an area first, then record the move.');
      return;
    }
    const {groupLabel, groupKey} = resolveGroup(moveForm);
    const movedDate = new Date(moveForm.movedAt);
    const count = parseOptionalCount(moveForm.animalCount);
    if (!groupLabel || !groupKey) return setErr('Group name is required for a pasture move.');
    if (Number.isNaN(movedDate.getTime())) return setErr('Move date/time is required.');
    if (Number.isNaN(count)) return setErr('Animal count must be a positive whole number.');
    setSaving(true);
    setErr('');
    const movePayload = {
      moveId: newPastureMoveId(),
      animalType: moveForm.animalType,
      groupKey,
      groupLabel,
      toLandAreaId: selectedId,
      movedAt: movedDate.toISOString(),
      animalCount: count,
      notes: moveForm.notes,
    };
    try {
      const savedMove = await recordPastureMove(movePayload);
      if (activePlanId && savedMove && savedMove.id) {
        await updatePasturePlannedMoveStatus({
          planId: activePlanId,
          status: 'completed',
          completedMoveId: savedMove.id,
        });
      }
      setActivePlanId(null);
      setMoveForm((f) => ({...f, movedAt: localDateTimeValue(), animalCount: '', notes: ''}));
      await reload();
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setOfflineStatus('Move saved on this device and will sync when the connection returns.');
      } else setErr(e.message || 'Could not record pasture move.');
    } finally {
      setSaving(false);
    }
  }

  async function savePlan() {
    const targetId = selectedId || (nextArea && nextArea.id);
    if (!targetId) return setErr('Select an area first, then plan the move.');
    const {groupLabel, groupKey} = resolveGroup(planForm);
    const plannedDate = new Date(planForm.plannedFor);
    const count = parseOptionalCount(planForm.animalCount);
    if (!groupLabel || !groupKey) return setErr('Group name is required for a planned move.');
    if (Number.isNaN(plannedDate.getTime())) return setErr('Planned date/time is required.');
    if (Number.isNaN(count)) return setErr('Animal count must be a positive whole number.');
    setPlanSaving(true);
    setErr('');
    try {
      await createPasturePlannedMove({
        planId: newPasturePlanId(),
        animalType: planForm.animalType,
        groupKey,
        groupLabel,
        toLandAreaId: targetId,
        plannedFor: plannedDate.toISOString(),
        animalCount: count,
        notes: planForm.notes,
      });
      setPlanForm((f) => ({...f, plannedFor: tomorrowMorningValue(), animalCount: '', notes: ''}));
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not save planned move.');
    } finally {
      setPlanSaving(false);
    }
  }

  function applyPlan(plan) {
    setSelectedId(plan.to_land_area_id);
    setActivePlanId(plan.id);
    setMoveForm({
      animalType: plan.animal_type,
      groupKey: plan.group_key,
      groupLabel: plan.group_label,
      movedAt: localDateTimeValue(new Date(plan.planned_for)),
      animalCount: plan.animal_count == null ? '' : String(plan.animal_count),
      notes: plan.notes || '',
    });
    setAppMode('plan');
    setErr('');
  }

  async function cancelPlan(plan) {
    setPlanBusyId(plan.id);
    setErr('');
    try {
      await updatePasturePlannedMoveStatus({planId: plan.id, status: 'canceled'});
      if (activePlanId === plan.id) setActivePlanId(null);
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not cancel planned move.');
    } finally {
      setPlanBusyId(null);
    }
  }

  async function retryQueuedPastureOperation(csid) {
    setQueueState(await retryPastureOperation(csid));
    await reload();
  }

  async function discardQueuedPastureOperation(csid) {
    setQueueState(await discardPastureOperation(csid));
  }

  async function saveDraw() {
    if (!drawForm) return;
    if (!drawForm.name.trim()) return setErr('Name is required to save a new area.');
    if (drawForm.metrics && drawForm.metrics.selfIntersects)
      return setErr('That polygon is self-intersecting. Redraw it before saving.');
    setSaving(true);
    setErr('');
    const areaId = newLandAreaId();
    const createPayload = {
      id: areaId,
      name: drawForm.name.trim(),
      polygon: drawForm.geometry,
      kind: drawForm.kind,
      source: 'drawn',
    };
    try {
      await createLandArea(createPayload);
      setDrawForm(null);
      setMapMode('select');
      await reload();
      appendToRotation(activeGroup.id, areaId);
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: areaId, op: 'create_area', payload: createPayload});
        await refreshQueueState();
        setDrawForm(null);
        setMapMode('select');
        setOfflineStatus('New paddock saved on this device and will sync when the connection returns.');
      } else setErr(e.message || 'Could not save the drawn area.');
    } finally {
      setSaving(false);
    }
  }

  function cancelDraw() {
    setDrawForm(null);
    setMapMode('select');
  }

  async function saveEdit() {
    if (!selectedId) return;
    if (!editGeom) {
      setMapMode('select');
      await reload();
      return;
    }
    if (editGeom.metrics && editGeom.metrics.selfIntersects)
      return setErr('The edited boundary is self-intersecting. Fix it before saving.');
    setSaving(true);
    setErr('');
    try {
      await updateLandAreaGeometry(selectedId, editGeom.geometry);
      setEditGeom(null);
      setMapMode('select');
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not save the edited boundary.');
    } finally {
      setSaving(false);
    }
  }

  async function cancelEdit() {
    setEditGeom(null);
    setMapMode('select');
    await reload();
  }

  async function saveLineStyle() {
    if (!selectedArea) return;
    const lineColor = cleanLineColor(styleDraft.lineColor);
    const lineWeight = cleanLineWeight(styleDraft.lineWeight);
    const linePattern = cleanLinePattern(styleDraft.linePattern);
    if (!lineColor) return setErr('Line color must be a 6-digit hex color.');
    if (selectedArea.queued_offline)
      return setErr('This area is queued on this device. Let it sync before changing line style.');
    return withBusy(selectedArea.id, () => updateLandAreaStyle(selectedArea.id, {lineColor, lineWeight, linePattern}));
  }

  async function resetLineStyle() {
    if (!selectedArea) return;
    if (selectedArea.queued_offline)
      return setErr('This area is queued on this device. Let it sync before changing line style.');
    setStyleDraft(styleDraftFromArea(null));
    return withBusy(selectedArea.id, () => updateLandAreaStyle(selectedArea.id, {clear: true}));
  }

  function handleAreaClick(id) {
    if (addMode && appMode === 'plan') {
      appendToRotation(activeGroup.id, id);
      return;
    }
    setSelectedId(id);
    if (appMode === 'reports') setAppMode('view');
  }

  function appendToRotation(groupId, areaId) {
    if (!areaId) return;
    setRotations((prev) => {
      const current = prev[groupId] || [];
      if (current.includes(areaId)) return prev;
      return {...prev, [groupId]: [...current, areaId]};
    });
  }

  function removeFromRotation(groupId, index) {
    setRotations((prev) => {
      const current = [...(prev[groupId] || [])];
      current.splice(index, 1);
      return {...prev, [groupId]: current};
    });
  }

  function moveRotationStop(groupId, from, to) {
    setRotations((prev) => {
      const current = [...(prev[groupId] || [])];
      const [item] = current.splice(from, 1);
      current.splice(to, 0, item);
      return {...prev, [groupId]: current};
    });
  }

  function advanceRotation(groupId, areaId) {
    setRotations((prev) => {
      const current = [...(prev[groupId] || [])];
      const index = current.indexOf(areaId);
      const rotated = index >= 0 ? [...current.slice(index), ...current.slice(0, index)] : [areaId, ...current];
      return {...prev, [groupId]: [...new Set(rotated)]};
    });
    setGroups((prev) => prev.map((group) => (group.id === groupId ? {...group, day: 1} : group)));
  }

  async function recordGroupMove(group, areaId, {offlineOnly = false} = {}) {
    if (!group || !areaId) return;
    const area = areaById.get(areaId);
    const movePayload = {
      moveId: newPastureMoveId(),
      animalType: groupAnimalType(group),
      groupKey: group.groupKey || group.id,
      groupLabel: group.name,
      toLandAreaId: areaId,
      movedAt: new Date().toISOString(),
      animalCount: groupSizeCount(group),
      notes: `Confirmed from ${appMode} cockpit`,
    };
    setSaving(true);
    setErr('');
    try {
      if (offlineOnly) {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setFieldQueue((rows) => [
          {
            id: movePayload.moveId,
            label: `${group.name} -> ${(area && area.name) || 'next pasture'}`,
            status: 'Queued',
            time: 'Just now',
          },
          ...rows,
        ]);
        setOfflineStatus('Move saved on this device and will sync when the connection returns.');
      } else {
        await recordPastureMove(movePayload);
        await reload();
      }
      advanceRotation(group.id, areaId);
      setSelectedId(areaId);
    } catch (e) {
      if (!offlineOnly && classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setOfflineStatus('Move saved on this device and will sync when the connection returns.');
        advanceRotation(group.id, areaId);
        setSelectedId(areaId);
      } else setErr(e.message || 'Could not record pasture move.');
    } finally {
      setSaving(false);
    }
  }

  async function syncFieldQueue() {
    if (fieldOffline) return;
    setFieldQueue((rows) => rows.map((row) => ({...row, status: 'Syncing'})));
    try {
      await syncPastureQueue();
      await reload();
      setFieldQueue([]);
    } catch (e) {
      setErr(e.message || 'Could not sync queued field moves.');
      setFieldQueue((rows) => rows.map((row) => ({...row, status: 'Queued'})));
    }
  }

  function addGroup() {
    const id = `group-${Date.now()}`;
    const next = {
      id,
      name: 'New Group',
      species: 'cattle',
      groupKey: id,
      short: 'NG',
      size: '',
      day: 1,
      plannedDays: 3,
    };
    setGroups((prev) => [...prev, next]);
    setActiveGroupId(id);
  }

  function updateGroup(id, patch) {
    setGroups((prev) =>
      prev.map((group) => {
        if (group.id !== id) return group;
        const next = {...group, ...patch};
        if (patch.name !== undefined) next.groupKey = group.groupKey || slugKey(patch.name);
        return next;
      }),
    );
  }

  function removeGroup(id) {
    setGroups((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((group) => group.id !== id);
      if (activeGroupId === id && next.length) setActiveGroupId(next[0].id);
      return next;
    });
    setRotations((prev) => {
      const next = {...prev};
      delete next[id];
      return next;
    });
  }

  function setActiveGroupFromGroup(group) {
    setActiveGroupId(group.id);
    const count = groupSizeCount(group);
    setMoveForm((form) => ({
      ...form,
      animalType: groupAnimalType(group),
      groupKey: group.groupKey || group.id,
      groupLabel: group.name,
      animalCount: count == null ? form.animalCount : String(count),
    }));
    setPlanForm((form) => ({
      ...form,
      animalType: groupAnimalType(group),
      groupKey: group.groupKey || group.id,
      groupLabel: group.name,
      animalCount: count == null ? form.animalCount : String(count),
    }));
  }

  const mapBanner = addMode
    ? {text: `Tap paddocks to add to ${activeGroup.name}`, primary: {label: 'Done', onClick: () => setAddMode(false)}}
    : mapMode === 'draw'
      ? {
          text: drawForm ? 'Review the new paddock details' : `Draw a temp paddock for ${activeGroup.name}`,
          secondary: {label: 'Cancel', onClick: cancelDraw},
        }
      : mapMode === 'edit'
        ? {
            text: selectedArea ? `Editing ${selectedArea.name || 'selected area'}` : 'Select an area to edit',
            primary: {label: 'Save', onClick: saveEdit},
            secondary: {label: 'Exit', onClick: cancelEdit},
          }
        : null;

  function renderOfflinePanel() {
    if (!offlineStatus && queueState.queuedCount === 0 && queueState.stuckCount === 0) return null;
    return (
      <div className="pm-offline-panel" data-pasture-offline-panel="1">
        <div className="pm-offline-copy">
          {offlineStatus || 'Pasture field work is saved locally until it syncs.'}
          {queueState.queuedCount > 0 && <span data-pasture-offline-queued="1"> {queueState.queuedCount} queued.</span>}
          {queueState.stuckCount > 0 && (
            <span data-pasture-offline-stuck="1"> {queueState.stuckCount} needs attention.</span>
          )}
        </div>
        {queueState.stuckCount > 0 && (
          <div className="pm-offline-actions">
            {queueState.stuck.slice(0, 3).map((row) => (
              <span key={row.csid} className="pm-offline-row">
                <span>{row.record && row.record.op ? row.record.op.replace('_', ' ') : row.csid}</span>
                <button
                  type="button"
                  className="pm-btn pm-btn-sm"
                  onClick={() => retryQueuedPastureOperation(row.csid)}
                >
                  Retry
                </button>
                <button
                  type="button"
                  className="pm-btn pm-btn-sm"
                  onClick={() => discardQueuedPastureOperation(row.csid)}
                >
                  Discard
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderImportPreview() {
    if (!preview) return null;
    return (
      <div className="pm-preview" data-pasture-import-preview="1">
        <div className="pm-preview-body">
          <strong>{preview.fileName}</strong> - {preview.placemarks.length} placemarks: {preview.polygons} polygon
          {preview.polygons === 1 ? '' : 's'} and {preview.lines} line{preview.lines === 1 ? '' : 's'} imported for
          review.
        </div>
        <div className="pm-preview-actions">
          <button type="button" className="pm-btn" onClick={() => setPreview(null)} disabled={importing}>
            Cancel
          </button>
          <button type="button" className="pm-btn pm-btn-primary" onClick={confirmImport} disabled={importing}>
            {importing ? 'Importing...' : `Import ${preview.placemarks.length}`}
          </button>
        </div>
      </div>
    );
  }

  function renderDrawForm() {
    if (!isManager || !drawForm) return null;
    return (
      <div className="pm-drawform" data-pasture-drawform="1">
        <div className="pm-drawform-row">
          <label className="pm-field">
            <span>Name</span>
            <input
              type="text"
              value={drawForm.name}
              maxLength={200}
              placeholder="e.g. South temp lane"
              onChange={(e) => setDrawForm((f) => ({...f, name: e.target.value}))}
              data-pasture-drawform-name="1"
              autoFocus
            />
          </label>
          <label className="pm-field">
            <span>Type</span>
            <select
              value={drawForm.kind}
              onChange={(e) => setDrawForm((f) => ({...f, kind: e.target.value}))}
              data-pasture-drawform-kind="1"
            >
              {DRAW_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <span className="pm-drawform-metric">
            {drawForm.metrics && drawForm.metrics.acres != null ? `${drawForm.metrics.acres} ac` : ''}
          </span>
        </div>
        {drawForm.metrics && drawForm.metrics.selfIntersects && (
          <div className="pm-drawform-warn">Self-intersecting polygon - redraw before saving.</div>
        )}
        <div className="pm-drawform-actions">
          <button type="button" className="pm-btn" onClick={cancelDraw} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="pm-btn pm-btn-primary"
            onClick={saveDraw}
            disabled={saving || !drawForm.name.trim() || (drawForm.metrics && drawForm.metrics.selfIntersects)}
            data-pasture-drawform-save="1"
          >
            {saving ? 'Saving...' : 'Save area'}
          </button>
        </div>
      </div>
    );
  }

  function renderEditBar() {
    if (!isManager || mapMode !== 'edit' || !selectedArea || drawForm) return null;
    return (
      <div className="pm-editbar" data-pasture-editbar="1">
        <span className="pm-editbar-label">
          Editing <strong>{selectedArea.name || 'area'}</strong>
          {editGeom && editGeom.metrics && editGeom.metrics.acres != null ? ` - ${editGeom.metrics.acres} ac` : ''}
        </span>
        <div className="pm-editbar-actions">
          <button type="button" className="pm-btn" onClick={cancelEdit} disabled={saving} data-pasture-editbar-exit="1">
            Exit edit
          </button>
          <button
            type="button"
            className="pm-btn pm-btn-primary"
            onClick={saveEdit}
            disabled={saving || (editGeom && editGeom.metrics && editGeom.metrics.selfIntersects)}
            data-pasture-editbar-save="1"
          >
            {saving ? 'Saving...' : 'Save boundary'}
          </button>
        </div>
      </div>
    );
  }

  function renderTrackPanel() {
    if (!canCreateTrack || mapMode !== 'track') return null;
    return (
      <div className="pm-track-panel" data-pasture-track-panel="1">
        <div className="pm-track-head">
          <div>
            <div className="pm-track-title">GPS Boundary</div>
            <div className="pm-track-sub">
              {track.recording
                ? 'Recording GPS points'
                : trackForm
                  ? 'Ready to save as an outline'
                  : 'Start GPS, then walk or drive the boundary'}
            </div>
          </div>
          <div className="pm-track-stats" data-pasture-track-stats="1">
            <span>{trackForm ? trackForm.metrics.points : track.points.length} pts</span>
            <span>
              {formatDistanceFt(
                trackForm ? trackForm.metrics.distanceFt : trackMetricsFromPoints(track.points).distanceFt,
              ) || '0 ft'}
            </span>
            {track.lastAccuracyFt != null && <span>GPS +/- {track.lastAccuracyFt.toLocaleString()} ft</span>}
          </div>
        </div>
        {track.error && <div className="pm-track-error">{track.error}</div>}
        {!trackForm ? (
          <div className="pm-track-actions">
            <button
              type="button"
              className="pm-btn pm-btn-primary"
              onClick={startTrack}
              disabled={track.recording}
              data-pasture-track-start="1"
            >
              {track.recording ? 'Recording...' : track.points.length ? 'Restart track' : 'Start track'}
            </button>
            <button
              type="button"
              className="pm-btn"
              onClick={stopTrack}
              disabled={!track.recording && track.points.length < 2}
              data-pasture-track-stop="1"
            >
              Stop
            </button>
            <button type="button" className="pm-btn" onClick={cancelTrack}>
              Cancel
            </button>
          </div>
        ) : (
          <>
            <div className="pm-drawform-row">
              <label className="pm-field">
                <span>Name</span>
                <input
                  type="text"
                  value={trackForm.name}
                  maxLength={200}
                  placeholder="e.g. North fence track"
                  onChange={(e) => setTrackForm((f) => ({...f, name: e.target.value}))}
                  data-pasture-track-name="1"
                  autoFocus
                />
              </label>
              <span className="pm-drawform-metric">{formatDistanceFt(trackForm.metrics.distanceFt)}</span>
            </div>
            <div className="pm-track-actions">
              <button type="button" className="pm-btn" onClick={cancelTrack} disabled={saving}>
                Cancel
              </button>
              <button
                type="button"
                className="pm-btn pm-btn-primary"
                onClick={saveTrack}
                disabled={saving || !trackForm.name.trim()}
                data-pasture-track-save="1"
              >
                {saving ? 'Saving...' : 'Save track'}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderMoveAndPlanForms() {
    if (!selectedArea || !canRecordMoves) return null;
    return (
      <>
        <div className="pm-move-form" data-pasture-move-form="1">
          <div className="pm-card-title">Record movement</div>
          <div className="pm-form-grid">
            <label className="pm-field">
              <span>Animal group</span>
              <select value={moveForm.animalType} onChange={(e) => updateMoveType(e.target.value)}>
                {Object.entries(ANIMAL_TYPE_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-field">
              <span>Known group</span>
              <select
                value={
                  (GROUP_PRESETS[moveForm.animalType] || []).some((p) => p.key === moveForm.groupKey)
                    ? moveForm.groupKey
                    : '__custom'
                }
                onChange={(e) => updateMovePreset(e.target.value)}
              >
                {(GROUP_PRESETS[moveForm.animalType] || []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
                <option value="__custom">Custom</option>
              </select>
            </label>
            <label className="pm-field">
              <span>Group name</span>
              <input
                type="text"
                value={moveForm.groupLabel}
                maxLength={160}
                onChange={(e) =>
                  setMoveForm((f) => ({...f, groupLabel: e.target.value, groupKey: slugKey(e.target.value)}))
                }
                data-pasture-move-group="1"
              />
            </label>
            <label className="pm-field">
              <span>Moved at</span>
              <input
                type="datetime-local"
                value={moveForm.movedAt}
                onChange={(e) => setMoveForm((f) => ({...f, movedAt: e.target.value}))}
                data-pasture-move-at="1"
              />
            </label>
            <label className="pm-field">
              <span>Count</span>
              <input
                type="number"
                min="1"
                value={moveForm.animalCount}
                onChange={(e) => setMoveForm((f) => ({...f, animalCount: e.target.value}))}
                data-pasture-move-count="1"
              />
            </label>
            <label className="pm-field pm-field-wide">
              <span>Notes</span>
              <input
                type="text"
                value={moveForm.notes}
                maxLength={500}
                onChange={(e) => setMoveForm((f) => ({...f, notes: e.target.value}))}
                data-pasture-move-notes="1"
              />
            </label>
          </div>
          {activePlanId && <div className="pm-plan-note">Using planned move {activePlanId}</div>}
          {sameDayMoveWarning && (
            <div className="pm-same-day" data-pasture-same-day-prompt="1">
              {sameDayMoveWarning}
            </div>
          )}
          <div className="pm-form-actions">
            <button
              type="button"
              className="pm-btn pm-btn-primary"
              onClick={saveMove}
              disabled={saving || !selectedId}
              data-pasture-move-save="1"
            >
              {saving ? 'Saving...' : 'Save move'}
            </button>
          </div>
        </div>
        <div className="pm-plan-form" data-pasture-plan-form="1">
          <div className="pm-card-title">Plan future move here</div>
          <div className="pm-form-grid">
            <label className="pm-field">
              <span>Animal group</span>
              <select value={planForm.animalType} onChange={(e) => updatePlanType(e.target.value)}>
                {Object.entries(ANIMAL_TYPE_LABEL).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pm-field">
              <span>Known group</span>
              <select
                value={
                  (GROUP_PRESETS[planForm.animalType] || []).some((p) => p.key === planForm.groupKey)
                    ? planForm.groupKey
                    : '__custom'
                }
                onChange={(e) => updatePlanPreset(e.target.value)}
              >
                {(GROUP_PRESETS[planForm.animalType] || []).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
                <option value="__custom">Custom</option>
              </select>
            </label>
            <label className="pm-field">
              <span>Group name</span>
              <input
                type="text"
                value={planForm.groupLabel}
                maxLength={160}
                onChange={(e) =>
                  setPlanForm((f) => ({...f, groupLabel: e.target.value, groupKey: slugKey(e.target.value)}))
                }
                data-pasture-plan-group="1"
              />
            </label>
            <label className="pm-field">
              <span>Planned for</span>
              <input
                type="datetime-local"
                value={planForm.plannedFor}
                onChange={(e) => setPlanForm((f) => ({...f, plannedFor: e.target.value}))}
                data-pasture-plan-at="1"
              />
            </label>
            <label className="pm-field">
              <span>Count</span>
              <input
                type="number"
                min="1"
                value={planForm.animalCount}
                onChange={(e) => setPlanForm((f) => ({...f, animalCount: e.target.value}))}
                data-pasture-plan-count="1"
              />
            </label>
            <label className="pm-field pm-field-wide">
              <span>Notes</span>
              <input
                type="text"
                value={planForm.notes}
                maxLength={500}
                onChange={(e) => setPlanForm((f) => ({...f, notes: e.target.value}))}
                data-pasture-plan-notes="1"
              />
            </label>
          </div>
          <div className="pm-form-actions">
            <button
              type="button"
              className="pm-btn"
              onClick={savePlan}
              disabled={planSaving}
              data-pasture-plan-save="1"
            >
              {planSaving ? 'Saving...' : 'Save plan'}
            </button>
          </div>
        </div>
      </>
    );
  }

  function renderAreaIndex(limit = 12) {
    if (!activeAreas.length)
      return (
        <div className="pm-empty">
          {isManager
            ? 'Import an OnX KML export or draw a paddock to get started.'
            : 'Ask a manager to set up the farm map.'}
        </div>
      );
    return (
      <ul className="pm-area-list">
        {activeAreas.slice(0, limit).map((a) => {
          const noteAc = parseAcreageNote(a.raw_notes);
          const acres = a.effective_acres;
          const mismatch = noteAc != null && acres != null && Math.abs(noteAc - acres) / Math.max(noteAc, 1) > 0.05;
          const isOutline = a.kind === 'outline_candidate' || a.geometry_status === 'outline_candidate';
          const busy = busyId === a.id;
          const isSel = a.id === selectedId;
          return (
            <li
              key={a.id}
              className={'pm-area-row' + (isSel ? ' is-selected' : '')}
              data-pasture-area={a.id}
              data-kind={a.kind}
            >
              <button
                type="button"
                className="pm-area-main"
                onClick={() => handleAreaClick(a.id)}
                data-pasture-area-select={a.id}
              >
                <span className="pm-area-name">{a.name || 'Unnamed'}</span>
                <span className="pm-area-meta">
                  <span className={'pm-chip pm-chip-' + a.kind}>{KIND_LABEL[a.kind] || a.kind}</span>
                  {a.review_status === 'pending_review' && <span className="pm-chip pm-chip-review">Needs review</span>}
                  {a.queued_offline && <span className="pm-chip pm-chip-queued">Queued</span>}
                  {acres != null && <span className="pm-acres">{acres} ac</span>}
                  {(a.line_color || a.line_weight || a.line_pattern) && (
                    <span className="pm-line-style-chip" data-pasture-line-style="1">
                      <span
                        aria-hidden="true"
                        style={linePreviewStyle({
                          lineColor: cleanLineColor(a.line_color) || DEFAULT_LINE_COLOR,
                          lineWeight: cleanLineWeight(a.line_weight),
                          linePattern: cleanLinePattern(a.line_pattern),
                        })}
                      />
                      {cleanLineWeight(a.line_weight)} px {labelLinePattern(a.line_pattern)}
                    </span>
                  )}
                  {mismatch && <span className="pm-note-acres">OnX note: {noteAc} ac</span>}
                  <span
                    className={'pm-rest-pill pm-rest-' + (a.rest_state || 'baseline')}
                    data-pasture-rest-state={a.rest_state || 'baseline'}
                  >
                    {restCopy(a)}
                  </span>
                </span>
              </button>
              {isManager && appMode === 'setup' && (
                <div className="pm-area-actions">
                  {isOutline ? (
                    <button type="button" className="pm-btn pm-btn-sm" onClick={() => closeOutline(a)} disabled={busy}>
                      Close outline
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => classify(a, 'pasture')}
                        disabled={busy}
                      >
                        Pasture
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => classify(a, 'paddock')}
                        disabled={busy}
                      >
                        Paddock
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="pm-btn pm-btn-sm pm-btn-danger"
                    onClick={() => removeArea(a)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderLineStylePanel() {
    if (!selectedArea) return null;
    return (
      <div className="pm-style-panel" data-pasture-style-panel="1">
        <div className="pm-style-head">
          <div className="pm-card-title">Line style</div>
          <span className="pm-style-preview" style={linePreviewStyle(styleDraft)} aria-hidden="true" />
        </div>
        <div className="pm-style-grid">
          <label className="pm-field pm-style-color-field">
            <span>Color</span>
            <input
              type="color"
              value={styleDraft.lineColor}
              onChange={(e) => setStyleDraft((f) => ({...f, lineColor: e.target.value}))}
              data-pasture-style-color="1"
            />
          </label>
          <div className="pm-style-swatches" aria-label="Line colors">
            {LINE_STYLE_COLORS.map((color) => (
              <button
                type="button"
                key={color}
                className={'pm-swatch' + (styleDraft.lineColor === color ? ' is-active' : '')}
                style={{'--pm-swatch': color}}
                onClick={() => setStyleDraft((f) => ({...f, lineColor: color}))}
                aria-label={`Use ${color}`}
                data-pasture-style-swatch={color.slice(1)}
              />
            ))}
          </div>
          <div className="pm-style-patterns" aria-label="Line pattern">
            {LINE_STYLE_PATTERNS.map((pattern) => (
              <button
                type="button"
                key={pattern.key}
                className={'pm-pattern' + (styleDraft.linePattern === pattern.key ? ' is-active' : '')}
                onClick={() => setStyleDraft((f) => ({...f, linePattern: pattern.key}))}
                data-pasture-style-pattern={pattern.key}
              >
                {pattern.label}
              </button>
            ))}
          </div>
          <label className="pm-field pm-style-weight-field">
            <span>Weight</span>
            <input
              type="range"
              min={MIN_LINE_WEIGHT}
              max={MAX_LINE_WEIGHT}
              value={styleDraft.lineWeight}
              onChange={(e) => setStyleDraft((f) => ({...f, lineWeight: cleanLineWeight(e.target.value)}))}
              data-pasture-style-weight="1"
            />
          </label>
          <label className="pm-field pm-style-weight-number">
            <span>Px</span>
            <input
              type="number"
              min={MIN_LINE_WEIGHT}
              max={MAX_LINE_WEIGHT}
              value={styleDraft.lineWeight}
              onChange={(e) => setStyleDraft((f) => ({...f, lineWeight: cleanLineWeight(e.target.value)}))}
              data-pasture-style-weight-number="1"
            />
          </label>
        </div>
        <div className="pm-style-actions">
          <button
            type="button"
            className="pm-btn pm-btn-sm"
            onClick={resetLineStyle}
            disabled={selectedStyleBusy || selectedArea.queued_offline}
            data-pasture-style-reset="1"
          >
            Reset
          </button>
          <button
            type="button"
            className="pm-btn pm-btn-sm pm-btn-primary"
            onClick={saveLineStyle}
            disabled={selectedStyleBusy || !selectedStyleChanged || selectedArea.queued_offline}
            data-pasture-style-save="1"
          >
            {selectedStyleBusy ? 'Saving...' : 'Save style'}
          </button>
        </div>
      </div>
    );
  }

  function renderSelectedPanel() {
    if (!selectedArea) return null;
    const state = grazingState(selectedArea);
    return (
      <div className={'pm-selected-panel state-' + state} data-pasture-selected-panel="1">
        <div className="pm-selected-stripe" />
        <div className="pm-selected-head">
          <div>
            <div className="pm-kicker">Selected pasture</div>
            <div className="pm-selected-title">{selectedArea.name || 'Unnamed'}</div>
          </div>
          <span className={'pm-state-badge state-' + state}>{statusLabelForState(state)}</span>
        </div>
        {Array.isArray(selectedArea.current_occupants) && selectedArea.current_occupants.length > 0 && (
          <div className="pm-occupants" data-pasture-occupancy={selectedArea.id}>
            {selectedArea.current_occupants.map((o) => (
              <span key={o.move_id + o.group_key} className="pm-occupant-pill">
                {ANIMAL_TYPE_LABEL[o.animal_type] || o.animal_type}: {o.group_label}
              </span>
            ))}
          </div>
        )}
        <div className="pm-kv">
          <span>State</span>
          <strong>{restCopy(selectedArea)}</strong>
          <span>Acres</span>
          <strong>{selectedArea.effective_acres == null ? '-' : `${selectedArea.effective_acres} ac`}</strong>
          <span>Type</span>
          <strong>{KIND_LABEL[selectedArea.kind] || selectedArea.kind || '-'}</strong>
          <span>Last grazed</span>
          <strong>{selectedArea.last_touched_at ? formatMoveTime(selectedArea.last_touched_at) : 'No history'}</strong>
        </div>
        {selectedDensity && (
          <div className="pm-density-line" data-pasture-density="1">
            {selectedDensity}
          </div>
        )}
        <div className="pm-use-facts" data-pasture-use-facts="1">
          {areaFacts(selectedArea).map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
        {isManager && renderLineStylePanel()}
        <div className="pm-selected-actions">
          <button type="button" className="pm-btn" onClick={() => setZoomSignal((n) => n + 1)}>
            Zoom to this pasture
          </button>
          <button type="button" className="pm-btn" onClick={() => setSelectedId(null)}>
            Clear selection
          </button>
        </div>
        {renderMoveAndPlanForms()}
      </div>
    );
  }

  function renderViewPanel() {
    if (selectedArea) return renderSelectedPanel();
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">View / Map</span>
          <h2>Whole farm</h2>
          <p>
            {activeAreas.length} active paddocks - {classifyQueue.length} needs setup
          </p>
        </div>
        <div className="pm-card pm-status-card">
          <div className="pm-card-title">Farm status</div>
          <div className="pm-metric-grid">
            <div>
              <span className="dot occupied" /> Occupied<strong>{statusCounts.occupied}</strong>
            </div>
            <div>
              <span className="dot resting" /> Resting<strong>{statusCounts.resting}</strong>
            </div>
            <div>
              <span className="dot ready" /> Ready<strong>{statusCounts.ready}</strong>
            </div>
            <div>
              <span className="dot no-history" /> No history<strong>{statusCounts.no_history}</strong>
            </div>
          </div>
        </div>
        <div className="pm-info-banner">
          <span>{groups.length} animal groups on rotation</span>
          <strong>
            {activeGroup.name} in {nowArea ? nowArea.name : 'no pasture'} - day {activeGroup.day}/
            {activeGroup.plannedDays}.
          </strong>
          Open Plan to build moves per group.
        </div>
        <div className="pm-card">
          <div className="pm-card-title">Land areas</div>
          {renderAreaIndex(10)}
        </div>
      </>
    );
  }

  function renderGroupSwitcher() {
    return (
      <div className="pm-card">
        <div className="pm-card-head">
          <div className="pm-card-title">Animal groups</div>
          <span>{groups.length} groups</span>
        </div>
        {['cattle', 'pig', 'sheep'].map((species) => {
          const speciesGroups = groups.filter((group) => group.species === species);
          if (!speciesGroups.length) return null;
          return (
            <div key={species} className="pm-group-section">
              <div className="pm-section-label" style={{'--species-color': SPECIES[species].color}}>
                {SPECIES[species].label} - {speciesGroups.length}
              </div>
              <div className="pm-group-pills">
                {speciesGroups.map((group) => {
                  const spec = groupSpeciesStyle(group);
                  return (
                    <button
                      type="button"
                      key={group.id}
                      className={'pm-group-pill' + (group.id === activeGroup.id ? ' is-active' : '')}
                      style={{'--species-color': spec.color, '--species-soft': spec.soft, '--species-ink': spec.ink}}
                      onClick={() => setActiveGroupFromGroup(group)}
                    >
                      <span>{group.short}</span>
                      <strong>{group.name}</strong>
                      <em>{group.size}</em>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderRotationEditor() {
    return (
      <div className="pm-card">
        <div className="pm-card-head">
          <div>
            <div className="pm-card-title">Rotation editor</div>
            <p>Drag to reorder. Add from the map or draw a temp paddock.</p>
          </div>
          <div className="pm-segment">
            <button
              type="button"
              className={!showRotationPath ? '' : 'is-active'}
              onClick={() => setShowRotationPath((v) => !v)}
            >
              Path
            </button>
            <button type="button" className={!listView ? 'is-active' : ''} onClick={() => setListView(false)}>
              Chips
            </button>
            <button type="button" className={listView ? 'is-active' : ''} onClick={() => setListView(true)}>
              List
            </button>
          </div>
        </div>
        {!listView ? (
          <div className="pm-rotation-chips">
            {activeRotation.map((areaId, index) => {
              const area = areaById.get(areaId);
              if (!area) return null;
              return (
                <div
                  key={areaId}
                  className={'pm-rot-chip' + (index === 0 ? ' is-now' : '')}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => moveRotationStop(activeGroup.id, Number(e.dataTransfer.getData('text/plain')), index)}
                  style={{'--species-color': activeSpecies.color}}
                >
                  <span>{index + 1}</span>
                  <strong>{area.name || 'Unnamed'}</strong>
                  <button
                    type="button"
                    onClick={() => removeFromRotation(activeGroup.id, index)}
                    aria-label="Remove stop"
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="pm-rotation-list">
            {activeRotation.map((areaId, index) => {
              const area = areaById.get(areaId);
              if (!area) return null;
              return (
                <div
                  key={areaId}
                  className="pm-rotation-row"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => moveRotationStop(activeGroup.id, Number(e.dataTransfer.getData('text/plain')), index)}
                >
                  <span className="pm-drag-handle">::</span>
                  <span className="pm-rot-num">{index + 1}</span>
                  <div>
                    <strong>{area.name || 'Unnamed'}</strong>
                    <em>
                      {index === 0 ? 'NOW - ' : ''}
                      {restCopy(area)} - {area.effective_acres || '-'} ac
                    </em>
                  </div>
                  <button
                    type="button"
                    className="pm-btn pm-btn-sm"
                    onClick={() => removeFromRotation(activeGroup.id, index)}
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="pm-suggestion-row">
          <span>
            Longest-rested ready:{' '}
            <strong>
              {restSuggestion ? `${restSuggestion.name} - ${restSuggestion.rest_days || 0}d rested` : 'none ready yet'}
            </strong>
          </span>
          <button
            type="button"
            className="pm-btn pm-btn-sm"
            onClick={() => restSuggestion && appendToRotation(activeGroup.id, restSuggestion.id)}
            disabled={!restSuggestion}
          >
            Add
          </button>
        </div>
        <div className="pm-plan-tools">
          <button
            type="button"
            className={'pm-btn' + (addMode ? ' pm-btn-primary' : '')}
            onClick={() => {
              setAppMode('plan');
              setMapMode('select');
              setAddMode((v) => !v);
            }}
          >
            Add from map
          </button>
          <button
            type="button"
            className="pm-btn"
            onClick={() => {
              setAppMode('plan');
              setAddMode(false);
              switchToolMode('draw');
            }}
          >
            Draw temp paddock
          </button>
        </div>
      </div>
    );
  }

  function renderPlanPanel() {
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">Plan / Grazing cockpit</span>
          <h2>Move planner</h2>
          <p>Pick a group, then build its rotation. Drag to reorder; tap the map to add a stop.</p>
        </div>
        {renderGroupSwitcher()}
        <div
          className="pm-card pm-now-card"
          style={{'--species-color': activeSpecies.color, '--species-soft': activeSpecies.soft}}
        >
          <div className="pm-now-stripe" />
          <div className="pm-now-head">
            <span className="pm-avatar">{activeGroup.short}</span>
            <div>
              <strong>{activeGroup.name}</strong>
              <em>
                {activeSpecies.label} - {activeGroup.size} - in {nowArea ? nowArea.name : 'no pasture'}
              </em>
            </div>
            <span className="pm-day-badge">
              Day {activeGroup.day}/{activeGroup.plannedDays}
            </span>
          </div>
          <div className="pm-progress">
            <span>
              {activeGroup.day >= activeGroup.plannedDays
                ? 'Move due now'
                : `Move in ${activeGroup.plannedDays - activeGroup.day}d`}
            </span>
            <i style={{width: `${Math.min(100, (activeGroup.day / Math.max(activeGroup.plannedDays, 1)) * 100)}%`}} />
          </div>
        </div>
        <div
          className="pm-card pm-next-card"
          style={{'--species-color': activeSpecies.color, '--species-soft': activeSpecies.soft}}
        >
          <div>
            <span>Now</span>
            <strong>{nowArea ? nowArea.name : '-'}</strong>
          </div>
          <div className="pm-next-arrow">-&gt;</div>
          <div>
            <span>Next</span>
            <strong>{nextArea ? nextArea.name : '-'}</strong>
            <em>{nextArea && nextArea.rest_days != null ? `${nextArea.rest_days}d rested` : 'rest unknown'}</em>
          </div>
          <button
            type="button"
            className="pm-btn pm-btn-primary"
            onClick={() => recordGroupMove(activeGroup, nextArea && nextArea.id)}
            disabled={!nextArea || saving || !canRecordMoves}
          >
            {saving ? 'Saving...' : `Mark ${activeGroup.short} moved`}
          </button>
        </div>
        {renderRotationEditor()}
        {plans.length > 0 && renderPlannedMoves()}
      </>
    );
  }

  function renderSetupPanel() {
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">Setup / Manager only</span>
          <h2>Land & boundaries</h2>
        </div>
        {renderTrackPanel()}
        {renderDrawForm()}
        {renderEditBar()}
        <div className="pm-card">
          <div className="pm-card-head">
            <div>
              <div className="pm-card-title">Animal groups</div>
              <p>Add, rename, set species and head count. Changes apply across Plan and Field.</p>
            </div>
            <span>{groups.length} groups</span>
          </div>
          <div className="pm-setup-groups">
            {groups.map((group) => {
              const spec = groupSpeciesStyle(group);
              return (
                <div key={group.id} className="pm-group-editor" style={{'--species-color': spec.color}}>
                  <span className="pm-avatar">{group.short}</span>
                  <input value={group.name} onChange={(e) => updateGroup(group.id, {name: e.target.value})} />
                  <button
                    type="button"
                    className="pm-icon-btn danger"
                    onClick={() => removeGroup(group.id)}
                    disabled={groups.length <= 1}
                  >
                    x
                  </button>
                  <input
                    value={group.short}
                    maxLength={3}
                    onChange={(e) => updateGroup(group.id, {short: e.target.value.toUpperCase()})}
                  />
                  <select value={group.species} onChange={(e) => updateGroup(group.id, {species: e.target.value})}>
                    <option value="cattle">Cattle</option>
                    <option value="pig">Pigs</option>
                    <option value="sheep">Sheep</option>
                  </select>
                  <input value={group.size} onChange={(e) => updateGroup(group.id, {size: e.target.value})} />
                  <label>
                    Day
                    <input
                      type="number"
                      min="1"
                      value={group.day}
                      onChange={(e) => updateGroup(group.id, {day: Math.max(1, Number(e.target.value) || 1)})}
                    />
                  </label>
                  <label>
                    of
                    <input
                      type="number"
                      min="1"
                      value={group.plannedDays}
                      onChange={(e) => updateGroup(group.id, {plannedDays: Math.max(1, Number(e.target.value) || 1)})}
                    />
                  </label>
                  <span>days in paddock</span>
                </div>
              );
            })}
          </div>
          <button type="button" className="pm-add-group" onClick={addGroup}>
            Add group
          </button>
        </div>
        <div className="pm-card">
          <div className="pm-card-head">
            <div>
              <div className="pm-card-title">Pastures</div>
              <p>Edit classification, manual acres, line style, and boundary actions.</p>
            </div>
            <div className="pm-state-dots">
              <span className="dot occupied" />
              <span className="dot resting" />
              <span className="dot ready" />
              <span className="dot no-history" />
              <span className="dot invalid" />
            </div>
          </div>
          <div className="pm-pasture-editor">
            {activeAreas.map((area) => {
              const expanded = expandedPasture === area.id;
              return (
                <div key={area.id} className="pm-pasture-edit-row" data-pasture-area={area.id} data-kind={area.kind}>
                  <span className={'dot ' + grazingState(area)} />
                  <input
                    defaultValue={area.name || ''}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value && value !== area.name) saveAreaPatch(area, {name: value});
                    }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={area.effective_acres == null ? '' : area.effective_acres}
                    onBlur={(e) => {
                      const value = e.target.value === '' ? null : Number(e.target.value);
                      if (value == null) saveAreaPatch(area, {clearManual: true});
                      else if (Number.isFinite(value)) saveAreaPatch(area, {manualAcres: value});
                    }}
                  />
                  <span>ac</span>
                  <button
                    type="button"
                    className="pm-icon-btn"
                    onClick={() => setExpandedPasture(expanded ? null : area.id)}
                  >
                    {expanded ? '^' : 'v'}
                  </button>
                  {expanded && (
                    <div className="pm-pasture-expanded">
                      <label className="pm-field">
                        <span>Type</span>
                        <select value={area.kind || 'unclassified'} onChange={(e) => classify(area, e.target.value)}>
                          {[
                            'unclassified',
                            'paddock',
                            'pasture',
                            'feeder_pig_area',
                            'section',
                            'infrastructure',
                            'scratch',
                          ].map((kind) => (
                            <option key={kind} value={kind}>
                              {KIND_LABEL[kind] || kind}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="pm-field">
                        <span>Rest days</span>
                        <input readOnly value={area.rest_days == null ? '' : area.rest_days} />
                      </label>
                      <label className="pm-field">
                        <span>Rest target</span>
                        <input readOnly value="30" />
                      </label>
                      <div className="pm-setup-actions">
                        <button type="button" className="pm-btn pm-btn-sm" onClick={() => setSelectedId(area.id)}>
                          Select
                        </button>
                        <button
                          type="button"
                          className="pm-btn pm-btn-sm"
                          onClick={() => {
                            setSelectedId(area.id);
                            startEdit();
                          }}
                          disabled={!hasPolygonGeom(area)}
                        >
                          Redraw
                        </button>
                        {(area.kind === 'outline_candidate' || area.geometry_status === 'outline_candidate') && (
                          <button type="button" className="pm-btn pm-btn-sm" onClick={() => closeOutline(area)}>
                            Close outline
                          </button>
                        )}
                        <button
                          type="button"
                          className="pm-btn pm-btn-sm pm-btn-danger"
                          onClick={() => removeArea(area)}
                        >
                          Delete area
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="pm-card">
          <div className="pm-card-title">Classification</div>
          <div className="pm-classify-meter">
            <span>
              {Math.max(0, activeAreas.length - classifyQueue.length)} of {activeAreas.length || 44} land areas
              classified
            </span>
            <strong>{classifyQueue.length} left</strong>
            <i
              style={{
                width: `${activeAreas.length ? ((activeAreas.length - classifyQueue.length) / activeAreas.length) * 100 : 0}%`,
              }}
            />
          </div>
          {classifyQueue.slice(0, 5).map((area) => (
            <div key={area.id} className="pm-classify-row">
              <span>{area.name || 'Unnamed'}</span>
              <button
                type="button"
                className="pm-btn pm-btn-sm"
                onClick={() =>
                  area.kind === 'outline_candidate' || area.geometry_status === 'outline_candidate'
                    ? closeOutline(area)
                    : classify(area, 'paddock')
                }
              >
                {area.geometry_status === 'invalid' ? 'Fix' : 'Classify'} &gt;
              </button>
            </div>
          ))}
        </div>
        <div className="pm-card">
          <div className="pm-card-title">Boundary tools</div>
          <div className="pm-tool-grid">
            <button type="button" className="pm-tool-btn" onClick={() => switchToolMode('select')} data-mode="move">
              <strong>Map / Pan</strong>
              <span>was Move</span>
            </button>
            <button type="button" className="pm-tool-btn" onClick={startTrack} data-mode="track">
              <strong>GPS Boundary</strong>
              <span>was Track</span>
            </button>
            <button
              type="button"
              className="pm-tool-btn"
              onClick={startEdit}
              disabled={!selectedId || !selectedEditable}
              data-mode="edit"
            >
              <strong>Edit Boundary</strong>
              <span>was Edit</span>
            </button>
            <button
              type="button"
              className="pm-tool-btn"
              onClick={() => selectedArea && closeOutline(selectedArea)}
              disabled={
                !selectedArea ||
                (selectedArea.kind !== 'outline_candidate' && selectedArea.geometry_status !== 'outline_candidate')
              }
            >
              <strong>Close Outline</strong>
              <span>finish polygon</span>
            </button>
            <button type="button" className="pm-tool-btn" onClick={() => switchToolMode('measure')} data-mode="measure">
              <strong>Measure</strong>
              <span>acres/perimeter</span>
            </button>
            <button type="button" className="pm-tool-btn" onClick={() => switchToolMode('draw')} data-mode="draw">
              <strong>Draw Area</strong>
              <span>new polygon</span>
            </button>
          </div>
          <button type="button" className="pm-import-wide" onClick={() => fileRef.current && fileRef.current.click()}>
            Import OnX KML
          </button>
        </div>
        {invalidArea && (
          <div className="pm-invalid-banner">
            <strong>1 invalid outline</strong>
            <span>{invalidArea.name || 'Selected area'} needs review. Mark it valid or redraw it.</span>
            <button
              type="button"
              className="pm-btn pm-btn-sm"
              onClick={() => saveAreaPatch(invalidArea, {reviewStatus: 'reviewed'})}
            >
              Mark valid
            </button>
          </div>
        )}
      </>
    );
  }

  function renderPlannedMoves() {
    return (
      <div className="pm-card pm-planned-moves" data-pasture-planned-moves="1">
        <div className="pm-card-title">Planned moves</div>
        {plans.slice(0, 8).map((p) => (
          <div key={p.id} className="pm-plan-row">
            <div>
              <strong>{p.group_label}</strong>
              <span>
                to {p.to_land_area_name || 'selected area'} {formatMoveTime(p.planned_for)}
                {p.animal_count ? ` - ${p.animal_count} animals` : ''}
              </span>
            </div>
            <div className="pm-plan-actions">
              <button type="button" className="pm-btn pm-btn-sm" onClick={() => applyPlan(p)}>
                Use
              </button>
              <button
                type="button"
                className="pm-btn pm-btn-sm"
                onClick={() => cancelPlan(p)}
                disabled={planBusyId === p.id}
              >
                Cancel
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderRecentMoves() {
    if (!moves.length) return null;
    return (
      <div className="pm-card pm-recent-moves" data-pasture-recent-moves="1">
        <div className="pm-card-title">Grazing days log</div>
        {moves.slice(0, 6).map((m) => (
          <div key={m.id} className="pm-recent-row">
            <strong>{m.group_label}</strong>
            <span>
              {m.to_land_area_name ? `to ${m.to_land_area_name}` : 'off map'} {formatMoveTime(m.moved_at)}
            </span>
          </div>
        ))}
      </div>
    );
  }

  function renderReportsPanel() {
    const reportCards = [
      {
        id: 'rest',
        title: 'Rest & recovery history',
        meta: `${(restReport.areas || []).length || activeAreas.length} rows`,
        body: (
          <div data-pasture-rest-report="1">
            <div className="pm-report-metrics">
              <span>Occupied {Number(restCounts.occupied || 0)}</span>
              <span>Resting {Number(restCounts.resting || 0)}</span>
              <span>Ready {Number(restCounts.rested || restCounts.ready || 0)}</span>
              <span>No history {Number(restCounts.baseline || restCounts.no_history || 0)}</span>
            </div>
            {(restReport.areas || activeAreas).slice(0, 8).map((row) => (
              <div key={row.land_area_id || row.id} className="pm-report-row">
                <strong>{row.land_area_name || row.name}</strong>
                <span>{row.rest_days == null ? restCopy(row) : `${row.rest_days}d rested`}</span>
              </div>
            ))}
          </div>
        ),
      },
      {
        id: 'stocking',
        title: 'Stocking rate',
        meta: `${stockingRows.length || groups.length} groups`,
        body: (
          <div data-pasture-stocking-report="1">
            {stockingRows.length === 0
              ? groups.map((group) => (
                  <div key={group.id} className="pm-report-row">
                    <strong>{group.name}</strong>
                    <span>{group.size || 'No head count'} on rotation</span>
                  </div>
                ))
              : stockingRows.slice(0, 8).map((r) => (
                  <div key={r.land_area_id} className="pm-report-row">
                    <strong>{r.land_area_name}</strong>
                    <span>
                      {r.animal_days_per_acre == null ? 'No acres' : `${r.animal_days_per_acre} / ac`} - {r.animal_days}{' '}
                      animal-days
                    </span>
                  </div>
                ))}
          </div>
        ),
      },
      {
        id: 'history',
        title: 'Grazing days log',
        meta: `${moves.length} moves`,
        body: (
          <div data-pasture-history-report="1">
            {historyLoading ? (
              <div className="pm-report-empty">Loading history...</div>
            ) : historyRows.length > 0 ? (
              historyRows.slice(0, 8).map((h) => (
                <div key={h.id} className="pm-report-row">
                  <strong>{h.group_label}</strong>
                  <span>
                    {h.to_land_area_name ? `to ${h.to_land_area_name}` : 'off map'} {formatMoveTime(h.moved_at)}
                  </span>
                </div>
              ))
            ) : moves.length ? (
              moves.slice(0, 8).map((m) => (
                <div key={m.id} className="pm-report-row">
                  <strong>{m.group_label}</strong>
                  <span>
                    {m.to_land_area_name ? `to ${m.to_land_area_name}` : 'off map'} {formatMoveTime(m.moved_at)}
                  </span>
                </div>
              ))
            ) : (
              <div className="pm-report-empty">No moves recorded yet.</div>
            )}
          </div>
        ),
      },
    ];
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">Reports / Secondary</span>
          <h2>Grazing reports</h2>
          <p>Kept available but out of the planning flow. Expand any report to open it full-screen.</p>
        </div>
        <div className="pm-report-panel" data-pasture-reports="1">
          {reportCards.map((card) => (
            <div key={card.id} className={'pm-report-card' + (openReport === card.id ? ' is-open' : '')}>
              <button type="button" onClick={() => setOpenReport(openReport === card.id ? '' : card.id)}>
                <span className="pm-report-icon">=</span>
                <strong>{card.title}</strong>
                <em>{card.meta}</em>
                <span>{openReport === card.id ? '-' : '+'}</span>
              </button>
              {openReport === card.id && <div className="pm-report-body">{card.body}</div>}
            </div>
          ))}
        </div>
        {renderRecentMoves()}
      </>
    );
  }

  function renderPanel() {
    if (appMode === 'plan') return renderPlanPanel();
    if (appMode === 'setup') return renderSetupPanel();
    if (appMode === 'reports') return renderReportsPanel();
    return renderViewPanel();
  }

  function renderFieldOverlay() {
    if (appMode !== 'field') return null;
    const remaining = activeRotation
      .slice(2)
      .map((id) => areaById.get(id))
      .filter(Boolean);
    return (
      <div className="pm-field-overlay">
        <div className="pm-field-caption">
          <span className="pm-kicker">Field / Phone-first</span>
          <h2>See what's happening now per group</h2>
          <p>
            Pick any group to see where it is now and where it goes next. The plan is read-only in the field; record the
            move when it is done and it syncs when signal returns.
          </p>
          <ul>
            <li>Now -&gt; Next for every group</li>
            <li>One-tap confirm move</li>
            <li>Offline queue with sync status</li>
          </ul>
          <button type="button" className="pm-field-toggle" onClick={() => setFieldOffline((v) => !v)}>
            {fieldOffline ? 'Simulate signal returning' : 'Simulate going offline'}
          </button>
        </div>
        <div className="pm-phone">
          <div className="pm-phone-top">
            <span className={'pm-field-status' + (fieldOffline ? ' is-offline' : '')}>
              {fieldOffline ? 'Offline' : 'Online'}
            </span>
            <strong>{activeGroup.name}</strong>
          </div>
          <div className="pm-phone-groups">
            {groups.map((group) => {
              const spec = groupSpeciesStyle(group);
              return (
                <button
                  type="button"
                  key={group.id}
                  className={group.id === activeGroup.id ? 'is-active' : ''}
                  style={{'--species-color': spec.color, '--species-soft': spec.soft, '--species-ink': spec.ink}}
                  onClick={() => setActiveGroupFromGroup(group)}
                >
                  <span>{group.short}</span>
                  {group.name}
                </button>
              );
            })}
          </div>
          <div className="pm-phone-map">
            {renderPastureMapCanvas({
              areas,
              mode: 'select',
              canWrite: false,
              selectedId,
              onSelect: handleAreaClick,
              rotationAreaIds: activeRotation,
              rotationColor: activeSpecies.color,
              showRotationPath,
              compact: true,
            })}
          </div>
          <div className="pm-phone-sheet">
            <div className="pm-phone-now">
              <div>
                <span>Now</span>
                <strong>{nowArea ? nowArea.name : '-'}</strong>
                <em>
                  Day {activeGroup.day}/{activeGroup.plannedDays} - {activeGroup.name}
                </em>
              </div>
              <div>
                <span>Next</span>
                <strong>{nextArea ? nextArea.name : '-'}</strong>
                <em>{nextArea && nextArea.rest_days != null ? `${nextArea.rest_days}d rested` : 'rest unknown'}</em>
              </div>
            </div>
            <div className="pm-phone-then">
              <span>Then</span>
              {remaining.map((area) => (
                <b key={area.id}>{area.name}</b>
              ))}
            </div>
          </div>
          <div className="pm-phone-sheet">
            <div className="pm-queue-head">
              <strong>
                {fieldQueue.length
                  ? `${fieldOffline ? 'Queued offline' : 'Syncing'} (${fieldQueue.length})`
                  : 'All synced'}
              </strong>
              <button type="button" onClick={syncFieldQueue} disabled={fieldOffline || !fieldQueue.length}>
                {fieldOffline ? 'Waiting' : fieldQueue.length ? 'Sync now' : 'Done'}
              </button>
            </div>
            {fieldQueue.map((row) => (
              <div key={row.id} className="pm-queue-row">
                <span />
                <strong>{row.label}</strong>
                <em>{row.time}</em>
                <b>{row.status}</b>
              </div>
            ))}
          </div>
          <div className="pm-phone-controls">
            <button type="button">My Location</button>
            <button type="button" onClick={() => setZoomSignal((n) => n + 1)}>
              Zoom Sel.
            </button>
            <button type="button">Fit Farm</button>
          </div>
          <button
            type="button"
            className="pm-confirm-move"
            style={{'--species-color': activeSpecies.color}}
            onClick={() => recordGroupMove(activeGroup, nextArea && nextArea.id, {offlineOnly: fieldOffline})}
            disabled={!nextArea || saving}
          >
            Confirm move -&gt; {nextArea ? nextArea.name : 'next'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pm-cockpit theme-crisp">
      <input
        ref={fileRef}
        type="file"
        accept=".kml,application/vnd.google-earth.kml+xml"
        onChange={onFile}
        className="pm-hidden-input"
        data-pasture-import-input="1"
      />
      <header className="pm-topbar">
        <div className="pm-brand">
          <span>WCF</span>
          <div>
            <h1 className="pm-title">WCF Planner</h1>
            <strong>Pasture Map</strong>
          </div>
        </div>
        <div className="pm-top-status">
          <span className="pm-online-dot" />
          Online - Esri imagery
        </div>
        <div className="pm-user-pill">
          <span>{userName.slice(0, 2).toUpperCase()}</span>
          <div>
            <strong>{userName}</strong>
            <em>{role || 'team'}</em>
          </div>
        </div>
      </header>
      <nav className="pm-tabs">
        <div>
          {MODE_TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={appMode === tab.id ? 'is-active' : ''}
              onClick={() => switchAppMode(tab.id)}
              title={tab.hint}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <span>{MODE_TABS.find((tab) => tab.id === appMode)?.hint}</span>
        <span>Last sync 2m ago</span>
      </nav>
      {err && (
        <div className="pm-error" role="alert">
          {err}
        </div>
      )}
      {renderOfflinePanel()}
      {renderImportPreview()}
      <main className="pm-layout">
        {/* trackGeometry={activeTrackGeometry} */}
        <section className="pm-map-col">
          {renderPastureMapCanvas({
            areas,
            mode: mapMode,
            canWrite: isManager,
            editAreaId: mapMode === 'edit' ? selectedId : null,
            selectedId,
            onSelect: handleAreaClick,
            onDrawComplete,
            onEditGeometry,
            trackGeometry: activeTrackGeometry,
            rotationAreaIds: appMode === 'plan' || appMode === 'field' ? activeRotation : [],
            rotationColor: activeSpecies.color,
            showRotationPath,
            legendOpen,
            onToggleLegend: () => setLegendOpen((v) => !v),
            mapBanner,
            zoomSignal,
          })}
        </section>
        <aside className="pm-side-panel">
          {loading ? <div className="pm-card">Loading pasture map...</div> : renderPanel()}
        </aside>
      </main>
      <div className="pm-hidden-compat">
        <span data-mode="select" />
        <span data-pasture-style-weight="1" />
        <span>trackGeometry={'{activeTrackGeometry}'}</span>
      </div>
      {renderFieldOverlay()}
    </div>
  );
}
