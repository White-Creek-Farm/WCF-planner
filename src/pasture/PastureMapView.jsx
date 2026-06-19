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
  createTempLandArea,
  updateTempLandAreaGeometry,
  renameTempLandArea,
  archiveLandArea,
  restoreLandArea,
  hardDeleteLandArea,
  PM_AREA_OCCUPIED_COPY,
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
import {computePlannerGroupRoster} from '../lib/pasturePlannerGroups.js';
import {usePig} from '../contexts/PigContext.jsx';
import {useCattleHome} from '../contexts/CattleHomeContext.jsx';
import {useSheepHome} from '../contexts/SheepHomeContext.jsx';
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

const SPECIES = {
  cattle: {label: 'Cattle', animalType: 'cattle_herd', color: '#9A3B2E', ink: '#7C3023', soft: '#F4E5E2'},
  pig: {label: 'Pigs', animalType: 'breeder_pigs', color: '#A8418A', ink: '#852F6D', soft: '#F3E3EE'},
  sheep: {label: 'Sheep', animalType: 'sheep_flock', color: '#1E8A8A', ink: '#166A6A', soft: '#DEF0F0'},
};

const MODE_TABS = [
  {id: 'view', label: 'Map', hint: 'Browse groups & areas - select to inspect'},
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
    groupKey: '',
    groupLabel: '',
    movedAt: localDateTimeValue(),
    animalCount: '',
    notes: '',
  };
}

function initialPlanForm() {
  return {
    animalType: 'cattle_herd',
    groupKey: '',
    groupLabel: '',
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

// Designation label for Area Detail: the three product designations
// (Pasture / Paddock / Temp paddock) derived from kind + permanence, else the
// raw kind label (unclassified imports show "Needs classification").
function designationLabel(area) {
  if (!area) return '-';
  if (area.permanence === 'temporary') return 'Temp paddock';
  if (area.kind === 'pasture') return 'Pasture';
  if (area.kind === 'paddock') return 'Paddock';
  if (area.kind === 'unclassified') return 'Needs classification';
  return KIND_LABEL[area.kind] || area.kind || 'Unclassified';
}
function isTempArea(area) {
  return !!area && area.permanence === 'temporary';
}
function isArchivedArea(area) {
  return !!area && area.status === 'retired';
}
function isOutlineCandidateArea(area) {
  return !!area && (area.kind === 'outline_candidate' || area.geometry_status === 'outline_candidate');
}
// Permanent pasture/paddock use a fixed, non-editable boundary style. Their line
// style cannot be edited; only temp paddocks and GPS/field outline candidates can.
function isFixedStyleArea(area) {
  return !!area && area.permanence !== 'temporary' && (area.kind === 'pasture' || area.kind === 'paddock');
}
function canEditLineStyle(area) {
  return isTempArea(area) || isOutlineCandidateArea(area);
}

export default function PastureMapView({Header, authState}) {
  const role = authState && authState.role;
  const isManager = role === 'management' || role === 'admin';
  const isAdmin = role === 'admin';
  const canRecordMoves = role === 'farm_team' || role === 'management' || role === 'admin';
  const canCreateTrack = role === 'farm_team' || role === 'management' || role === 'admin';

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
  const [confirmDeleteId, setConfirmDeleteId] = React.useState(null);
  const [confirmPromoteId, setConfirmPromoteId] = React.useState(null);
  const [boundaryFilter, setBoundaryFilter] = React.useState({pasture: true, paddock: true, temp: true});
  const [drawIsTemp, setDrawIsTemp] = React.useState(false);
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
  const {breeders, feederGroups} = usePig();
  const {cattleForHome} = useCattleHome();
  const {sheepForHome} = useSheepHome();
  // Derived, READ-ONLY planner roster: counts are locked from real animal
  // records (never user-entered) via the shared pasturePlannerGroups helper.
  const roster = React.useMemo(
    () => computePlannerGroupRoster({cattle: cattleForHome, sheep: sheepForHome, breeders, feederGroups}),
    [cattleForHome, sheepForHome, breeders, feederGroups],
  );
  // `size` is the display string the existing UI reads (groupSizeCount parses
  // the leading count back out); day/plannedDays are neutral placeholders until
  // the P3 Plan redesign tracks real rotation days.
  const groups = React.useMemo(
    () => roster.groups.map((g) => ({...g, size: `${g.count} ${g.unit}`, day: 1, plannedDays: 1})),
    [roster],
  );
  const [rotations, setRotations] = React.useState({});
  const [activeGroupId, setActiveGroupId] = React.useState(null);
  const [fieldOffline, setFieldOffline] = React.useState(true);
  const [fieldQueue, setFieldQueue] = React.useState([]);
  const [fieldDupeAck, setFieldDupeAck] = React.useState(false);
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
  // Setup lists ALL live areas (including archived/retired) so they can be
  // restored; list_land_areas already excludes hard-deleted (deleted_at) rows.
  const setupAreas = React.useMemo(() => areas.filter((area) => area.geometry_status !== 'deleted'), [areas]);
  const areaById = React.useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  const activeGroup = groups.find((group) => group.id === activeGroupId) || groups[0] || null;
  const activeSpecies = groupSpeciesStyle(activeGroup);
  const activeRotation = ((activeGroup && rotations[activeGroup.id]) || []).filter((id) => areaById.has(id));
  const nowArea = areaById.get(activeRotation[0]) || null;
  const nextArea = areaById.get(activeRotation[1]) || null;
  // Current location per planner group = latest move ledger row by
  // (animal_type, group_key). moves is sorted moved_at DESC, so the first match
  // is the latest; no match -> Not placed (null).
  const groupLocation = React.useMemo(() => {
    const out = {};
    for (const g of groups) {
      const mv = moves.find((m) => m.animal_type === g.animalType && m.group_key === g.groupKey);
      out[g.id] =
        mv && mv.to_land_area_id
          ? {areaId: mv.to_land_area_id, areaName: mv.to_land_area_name, movedAt: mv.moved_at}
          : null;
    }
    return out;
  }, [groups, moves]);
  // Client-side occupancy for the Map canvas: area id -> occupying roster groups
  // (animal-type color + identity), derived from the SAME (animal_type,
  // group_key) contract as groupLocation. This — not land_areas.current_occupants
  // — drives the map's animal-colored fills and group markers.
  const occupantsByArea = React.useMemo(() => {
    const out = {};
    for (const g of groups) {
      const loc = groupLocation[g.id];
      if (!loc || !loc.areaId) continue;
      const sp = SPECIES[g.species] || SPECIES.cattle;
      (out[loc.areaId] = out[loc.areaId] || []).push({
        species: g.species,
        short: g.short,
        name: g.name,
        count: g.count,
        color: sp.color,
        ink: sp.ink,
      });
    }
    return out;
  }, [groups, groupLocation]);
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

  // Keep the active group pointed at a real roster group (no demo default), and
  // prime the move/plan forms with that group's locked identity + count.
  React.useEffect(() => {
    if (groups.length && !groups.some((g) => g.id === activeGroupId)) setActiveGroupFromGroup(groups[0]);
    else if (!groups.length && activeGroupId !== null) setActiveGroupId(null);
  }, [groups, activeGroupId]);

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
      // The server raises the bare PM_AREA_OCCUPIED sentinel; the client owns the copy.
      setErr(e.message === 'PM_AREA_OCCUPIED' ? PM_AREA_OCCUPIED_COPY : e.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  const classify = (a, kind) => withBusy(a.id, () => classifyLandArea(a.id, kind));
  const removeArea = (a) => withBusy(a.id, () => deleteLandArea(a.id));
  const saveAreaPatch = (a, fields) => withBusy(a.id, () => updateLandArea(a.id, fields));

  // P0 temp-paddock lifecycle. Designations are exactly Pasture / Paddock /
  // Temp paddock; temp = permanence 'temporary'.
  function classifyDesignation(a, designation) {
    if (designation === 'pasture')
      return withBusy(a.id, () =>
        updateLandArea(a.id, {kind: 'pasture', permanence: 'permanent', reviewStatus: 'reviewed'}),
      );
    if (designation === 'temp')
      return withBusy(a.id, () =>
        updateLandArea(a.id, {kind: 'paddock', permanence: 'temporary', reviewStatus: 'reviewed'}),
      );
    return withBusy(a.id, () =>
      updateLandArea(a.id, {kind: 'paddock', permanence: 'permanent', reviewStatus: 'reviewed'}),
    );
  }
  // Promote a temp paddock to a PERMANENT pasture/paddock. Management/admin only
  // (update_land_area is mgmt/admin gated server-side too). After promotion the
  // boundary style locks to the fixed permanent style, so this is explicit and
  // confirmed in the UI rather than a silent designation switch.
  function promoteTempArea(a, kind) {
    setConfirmPromoteId(null);
    return withBusy(a.id, () => updateLandArea(a.id, {kind, permanence: 'permanent', reviewStatus: 'reviewed'}));
  }
  function toggleBoundary(category) {
    setBoundaryFilter((f) => ({...f, [category]: !f[category]}));
  }
  const archiveArea = (a) => withBusy(a.id, () => archiveLandArea(a.id));
  const restoreArea = (a) => withBusy(a.id, () => restoreLandArea(a.id));
  const renameTemp = (a, name) => withBusy(a.id, () => renameTempLandArea(a.id, name));
  function confirmHardDelete(a) {
    setConfirmDeleteId(null);
    return withBusy(a.id, () => hardDeleteLandArea(a.id));
  }

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
    // A GPS-walked boundary that closes into a valid polygon becomes a REAL temp
    // paddock (farm_team-capable P0 RPC), usable across Map/Plan/Field/Reports.
    // A 2-point trace that cannot close stays an outline candidate.
    const closed = closeOutlineToPolygon(trackForm.geometry);
    const asTemp = closed.valid;
    const op = asTemp ? 'create_temp_area' : 'create_track';
    const createPayload = asTemp
      ? {id: trackId, name: trackForm.name.trim(), polygon: closed.polygon, source: 'drawn'}
      : {id: trackId, name: trackForm.name.trim(), line: trackForm.geometry, source: 'drawn'};
    setSaving(true);
    setErr('');
    try {
      const saved = asTemp ? await createTempLandArea(createPayload) : await createLandAreaTrack(createPayload);
      resetTrackFlow();
      setMapMode('select');
      setSelectedId((saved && saved.id) || trackId);
      await reload();
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: trackId, op, payload: createPayload});
        await refreshQueueState();
        resetTrackFlow();
        setMapMode('select');
        setOfflineStatus(
          asTemp
            ? 'Temp paddock saved on this device and will sync when the connection returns.'
            : 'Field track saved on this device and will sync when the connection returns.',
        );
      } else {
        setTrack((t) => ({...t, error: e.message || 'Could not save field track.'}));
      }
    } finally {
      setSaving(false);
    }
  }

  // Group picker is a single flat list from the locked roster (no species
  // pre-selector, no free-form): selecting a group fills its durable
  // (animal_type, group_key) identity and the locked count. The select value is
  // the roster group id resolved from the form's current animal_type+group_key.
  function rosterGroupById(id) {
    return groups.find((g) => g.id === id) || null;
  }
  function rosterGroupId(form) {
    const g = groups.find((x) => x.animalType === form.animalType && x.groupKey === form.groupKey);
    return g ? g.id : '';
  }
  function updateMoveGroup(id) {
    const g = rosterGroupById(id);
    if (g)
      setMoveForm((f) => ({
        ...f,
        animalType: g.animalType,
        groupKey: g.groupKey,
        groupLabel: g.name,
        animalCount: String(g.count),
      }));
  }
  function updatePlanGroup(id) {
    const g = rosterGroupById(id);
    if (g)
      setPlanForm((f) => ({
        ...f,
        animalType: g.animalType,
        groupKey: g.groupKey,
        groupLabel: g.name,
        animalCount: String(g.count),
      }));
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
      // animalCount stays locked to the roster group; only transient inputs reset.
      setMoveForm((f) => ({...f, movedAt: localDateTimeValue(), notes: ''}));
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
      // animalCount stays locked to the roster group; only transient inputs reset.
      setPlanForm((f) => ({...f, plannedFor: tomorrowMorningValue(), notes: ''}));
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
      // A temp paddock draw (Plan/Field/Setup) mints a real temp paddock via the
      // farm_team-capable P0 RPC; a permanent draw uses the mgmt/admin RPC.
      if (drawIsTemp) await createTempLandArea({id: areaId, name: createPayload.name, polygon: createPayload.polygon});
      else await createLandArea(createPayload);
      setDrawForm(null);
      setDrawIsTemp(false);
      setMapMode('select');
      await reload();
      if (drawIsTemp && activeGroup) appendToRotation(activeGroup.id, areaId);
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
    setDrawIsTemp(false);
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
      // Temp paddocks redraw through the owner-or-manager temp RPC; permanent
      // areas through the mgmt/admin RPC.
      if (selectedArea && selectedArea.permanence === 'temporary')
        await updateTempLandAreaGeometry(selectedId, editGeom.geometry);
      else await updateLandAreaGeometry(selectedId, editGeom.geometry);
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
    if (addMode && appMode === 'plan' && activeGroup) {
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
    ? {
        text: `Tap paddocks to add to ${activeGroup ? activeGroup.name : 'the group'}`,
        primary: {label: 'Done', onClick: () => setAddMode(false)},
      }
    : mapMode === 'draw'
      ? {
          text: drawForm
            ? 'Review the new paddock details'
            : `Draw a temp paddock for ${activeGroup ? activeGroup.name : 'the group'}`,
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
          {drawIsTemp ? (
            <span className="pm-drawform-type-note" data-pasture-drawform-temp="1">
              New area = Temp paddock
            </span>
          ) : (
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
          )}
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
            <label className="pm-field pm-field-wide">
              <span>Group</span>
              <select
                value={rosterGroupId(moveForm)}
                onChange={(e) => updateMoveGroup(e.target.value)}
                data-pasture-move-group="1"
              >
                <option value="" disabled>
                  Select group
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
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
              <span>Count (locked)</span>
              <input type="number" value={moveForm.animalCount} readOnly data-pasture-move-count="1" />
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
            <label className="pm-field pm-field-wide">
              <span>Group</span>
              <select
                value={rosterGroupId(planForm)}
                onChange={(e) => updatePlanGroup(e.target.value)}
                data-pasture-plan-group="1"
              >
                <option value="" disabled>
                  Select group
                </option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
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
              <span>Count (locked)</span>
              <input type="number" value={planForm.animalCount} readOnly data-pasture-plan-count="1" />
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
                  {/* Fixed permanent boundaries ignore saved line_* -> no editable chip. */}
                  {!isFixedStyleArea(a) && (a.line_color || a.line_weight || a.line_pattern) && (
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
            <div className="pm-kicker">Area detail</div>
            <div className="pm-selected-title">{selectedArea.name || 'Unnamed'}</div>
          </div>
          <span className={'pm-state-badge state-' + state}>{statusLabelForState(state)}</span>
        </div>
        <div className="pm-area-detail-chips" data-pasture-area-detail={selectedArea.id}>
          <span className={'pm-chip pm-chip-' + selectedArea.kind}>{designationLabel(selectedArea)}</span>
          {isTempArea(selectedArea) && <span className="pm-chip pm-chip-temp">Temp</span>}
          {isArchivedArea(selectedArea) && (
            <span className="pm-chip">{isTempArea(selectedArea) ? 'Archived temp' : 'Archived'}</span>
          )}
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
          <strong>{designationLabel(selectedArea)}</strong>
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
        {/* Map is read-only "where things are": move/plan recording lives in
            Plan, line-style editing lives in Setup. */}
        <div className="pm-selected-actions">
          <button type="button" className="pm-btn" onClick={() => setZoomSignal((n) => n + 1)}>
            Zoom to this pasture
          </button>
          <button type="button" className="pm-btn" onClick={() => setSelectedId(null)}>
            Clear selection
          </button>
        </div>
      </div>
    );
  }

  // Select a planner group and, when it has a current location, select + zoom
  // that area; otherwise clear the selection (group is Not placed).
  function selectGroupAndLocation(group) {
    setActiveGroupFromGroup(group);
    const loc = groupLocation[group.id];
    if (loc && loc.areaId) {
      setSelectedId(loc.areaId);
      setZoomSignal((n) => n + 1);
    } else {
      setSelectedId(null);
    }
  }

  // Current Groups: roster-backed groups with locked counts and current
  // location resolved from the move ledger by (animal_type, group_key).
  function renderCurrentGroups() {
    if (!groups.length) {
      return (
        <div className="pm-card" data-pasture-current-groups="empty">
          <div className="pm-card-title">Current groups</div>
          <div className="pm-empty">
            No active planner groups. Add animals in Cattle, Sheep, or Pigs to populate the roster.
          </div>
        </div>
      );
    }
    const placed = groups.filter((g) => groupLocation[g.id]).length;
    return (
      <div className="pm-card" data-pasture-current-groups="1">
        <div className="pm-card-head">
          <div className="pm-card-title">Current groups</div>
          <span>
            {placed} of {groups.length} placed
          </span>
        </div>
        {roster.bySpecies.map((sec) => (
          <div key={sec.species} className="pm-group-section">
            <div className="pm-section-label" style={{'--species-color': sec.color}}>
              {sec.label} - {sec.headCount} head
            </div>
            <div className="pm-current-rows">
              {sec.groups.map((g) => {
                const loc = groupLocation[g.id];
                const isActive = activeGroup && g.id === activeGroup.id;
                return (
                  <button
                    type="button"
                    key={g.id}
                    className={'pm-current-row' + (isActive ? ' is-active' : '')}
                    style={{'--species-color': sec.color}}
                    onClick={() => selectGroupAndLocation(g)}
                    data-pasture-current-group={g.groupKey}
                  >
                    <span className="pm-avatar">{g.short}</span>
                    <span className="pm-current-name">
                      <strong>{g.name}</strong>
                      <em>
                        {g.count} {g.unit}
                      </em>
                    </span>
                    <span
                      className={'pm-loc-chip ' + (loc ? 'placed' : 'unplaced')}
                      data-pasture-group-location={loc ? loc.areaId : 'none'}
                    >
                      {loc ? loc.areaName || 'Placed' : 'Not placed'}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  function renderViewPanel() {
    if (selectedArea) return renderSelectedPanel();
    return (
      <>
        <div className="pm-panel-title" data-pasture-map-header="1">
          <span className="pm-kicker">MAP - WHERE THINGS ARE</span>
          <h2>Current groups</h2>
          <p>
            {groups.length
              ? `${groups.filter((g) => groupLocation[g.id]).length} of ${groups.length} groups placed - tap a group or area`
              : 'No active planner groups yet'}
          </p>
        </div>
        {renderCurrentGroups()}
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
              setDrawIsTemp(true);
              switchToolMode('draw');
            }}
            data-pasture-draw-temp="1"
          >
            Draw temp paddock
          </button>
        </div>
      </div>
    );
  }

  function renderPlanPanel() {
    if (!activeGroup)
      return (
        <>
          <div className="pm-panel-title">
            <span className="pm-kicker">Plan / Grazing cockpit</span>
            <h2>Move planner</h2>
          </div>
          <div className="pm-card">
            <div className="pm-empty">
              No active planner groups. Add animals in Cattle, Sheep, or Pigs to plan moves.
            </div>
          </div>
        </>
      );
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
        {nextArea && (occupantsByArea[nextArea.id] || []).some((o) => o.name !== activeGroup.name) && (
          <div className="pm-conflict-warn" data-pasture-plan-conflict="1">
            &#9888; {nextArea.name} is currently occupied by{' '}
            {(occupantsByArea[nextArea.id].find((o) => o.name !== activeGroup.name) || {}).name}.
          </div>
        )}
        {renderRotationEditor()}
        {plans.length > 0 && renderPlannedMoves()}
        {canRecordMoves && (
          <div className="pm-card" data-pasture-plan-destinations="1">
            <div className="pm-card-title">
              {selectedArea ? `Record / plan for ${selectedArea.name}` : 'Select an area to record or plan a move'}
            </div>
            {renderAreaIndex(10)}
          </div>
        )}
        {renderMoveAndPlanForms()}
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
        {selectedArea && isManager && canEditLineStyle(selectedArea) && (
          <div className="pm-card" data-pasture-setup-linestyle="1">
            <div className="pm-card-title">Line style - {selectedArea.name}</div>
            {renderLineStylePanel()}
          </div>
        )}
        {selectedArea && isManager && isFixedStyleArea(selectedArea) && (
          <div className="pm-card" data-pasture-setup-linestyle-locked="1">
            <div className="pm-card-title">Line style - {selectedArea.name}</div>
            <p className="pm-style-locked-note">
              {selectedArea.kind === 'pasture' ? 'Pasture' : 'Paddock'} boundaries use a fixed
              {selectedArea.kind === 'pasture' ? ' blue' : ' green'} line and cannot be restyled. Only temp paddocks and
              GPS field tracks have editable line style.
            </p>
          </div>
        )}
        <div className="pm-card">
          <div className="pm-card-head">
            <div>
              <div className="pm-card-title">Animal groups</div>
              <p>Locked roster - counts come from real animal records (Cattle, Sheep, Pigs), not edited here.</p>
            </div>
            <span>{groups.length} groups</span>
          </div>
          {groups.length ? (
            <div className="pm-setup-groups">
              {groups.map((group) => {
                const spec = groupSpeciesStyle(group);
                return (
                  <div
                    key={group.id}
                    className="pm-group-editor pm-group-readonly"
                    style={{'--species-color': spec.color}}
                    data-pasture-roster-group={group.groupKey}
                  >
                    <span className="pm-avatar">{group.short}</span>
                    <strong>{group.name}</strong>
                    <span>{group.size}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="pm-empty">
              No active planner groups. Add animals in Cattle, Sheep, or Pigs to populate the roster.
            </div>
          )}
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
            {setupAreas.map((area) => {
              const expanded = expandedPasture === area.id;
              const isTemp = area.permanence === 'temporary';
              const isArchived = area.status === 'retired';
              const isOutline = area.kind === 'outline_candidate' || area.geometry_status === 'outline_candidate';
              // Temp paddocks: creator/owner or manager (RPC enforces ownership).
              // Permanent areas: management/admin only.
              const canManageArea = isTemp ? canRecordMoves : isManager;
              return (
                <div
                  key={area.id}
                  className={'pm-pasture-edit-row' + (isArchived ? ' is-archived' : '')}
                  data-pasture-area={area.id}
                  data-kind={area.kind}
                  data-pasture-permanence={area.permanence || 'permanent'}
                  data-pasture-status={area.status}
                >
                  <span className={'dot ' + grazingState(area)} />
                  <input
                    defaultValue={area.name || ''}
                    disabled={!canManageArea}
                    onBlur={(e) => {
                      const value = e.target.value.trim();
                      if (value && value !== area.name)
                        isTemp ? renameTemp(area, value) : saveAreaPatch(area, {name: value});
                    }}
                  />
                  <input
                    type="number"
                    step="0.01"
                    defaultValue={area.effective_acres == null ? '' : area.effective_acres}
                    disabled={!canManageArea}
                    onBlur={(e) => {
                      const value = e.target.value === '' ? null : Number(e.target.value);
                      if (value == null) saveAreaPatch(area, {clearManual: true});
                      else if (Number.isFinite(value)) saveAreaPatch(area, {manualAcres: value});
                    }}
                  />
                  <span>ac</span>
                  <span className="pm-area-tags">
                    <span className="pm-chip">{designationLabel(area)}</span>
                    {isTemp && <span className="pm-chip pm-chip-temp">Temp</span>}
                    {isArchived && <span className="pm-chip">{isTemp ? 'Archived temp' : 'Archived'}</span>}
                  </span>
                  <button
                    type="button"
                    className="pm-icon-btn"
                    onClick={() => setExpandedPasture(expanded ? null : area.id)}
                    data-pasture-expand={area.id}
                  >
                    {expanded ? '^' : 'v'}
                  </button>
                  {expanded && (
                    <div className="pm-pasture-expanded">
                      {isTemp ? (
                        <div className="pm-field" data-pasture-designation={area.id} data-pasture-designation-temp="1">
                          <span>Designation</span>
                          <div className="pm-temp-designation">
                            <span className="pm-chip pm-chip-temp">Temp paddock</span>
                            {isManager &&
                              (confirmPromoteId === area.id ? (
                                <span className="pm-promote-confirm" data-pasture-promote-confirm={area.id}>
                                  Promote to permanent? The boundary style locks to the fixed permanent style and can no
                                  longer be edited.
                                  <button
                                    type="button"
                                    className="pm-btn pm-btn-sm pm-btn-primary"
                                    onClick={() => promoteTempArea(area, 'pasture')}
                                    data-pasture-promote-pasture={area.id}
                                  >
                                    Pasture
                                  </button>
                                  <button
                                    type="button"
                                    className="pm-btn pm-btn-sm pm-btn-primary"
                                    onClick={() => promoteTempArea(area, 'paddock')}
                                    data-pasture-promote-paddock={area.id}
                                  >
                                    Paddock
                                  </button>
                                  <button
                                    type="button"
                                    className="pm-btn pm-btn-sm"
                                    onClick={() => setConfirmPromoteId(null)}
                                  >
                                    Cancel
                                  </button>
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="pm-btn pm-btn-sm"
                                  onClick={() => setConfirmPromoteId(area.id)}
                                  data-pasture-promote={area.id}
                                >
                                  Promote to permanent
                                </button>
                              ))}
                          </div>
                        </div>
                      ) : (
                        <label className="pm-field">
                          <span>Designation</span>
                          <select
                            value={area.kind === 'pasture' ? 'pasture' : 'paddock'}
                            disabled={!isManager}
                            onChange={(e) => classifyDesignation(area, e.target.value)}
                            data-pasture-designation={area.id}
                          >
                            <option value="pasture">Pasture</option>
                            <option value="paddock">Paddock</option>
                          </select>
                        </label>
                      )}
                      {area.kind === 'unclassified' && (
                        <div className="pm-needs-classification" data-pasture-needs-classification={area.id}>
                          Needs classification
                        </div>
                      )}
                      <label className="pm-field">
                        <span>Rest days</span>
                        <input readOnly value={area.rest_days == null ? '' : area.rest_days} />
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
                            setDrawIsTemp(isTemp);
                            startEdit();
                          }}
                          disabled={!hasPolygonGeom(area) || !canManageArea}
                          data-pasture-redraw={area.id}
                        >
                          Redraw
                        </button>
                        {isOutline && (
                          <button
                            type="button"
                            className="pm-btn pm-btn-sm"
                            onClick={() => closeOutline(area)}
                            disabled={!isManager}
                          >
                            Close outline
                          </button>
                        )}
                        {isArchived ? (
                          <button
                            type="button"
                            className="pm-btn pm-btn-sm"
                            onClick={() => restoreArea(area)}
                            disabled={!canManageArea}
                            data-pasture-restore={area.id}
                          >
                            Restore
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="pm-btn pm-btn-sm"
                            onClick={() => archiveArea(area)}
                            disabled={!canManageArea}
                            data-pasture-archive={area.id}
                          >
                            {isTemp ? 'Archive temp paddock' : 'Archive'}
                          </button>
                        )}
                        {isAdmin &&
                          (confirmDeleteId === area.id ? (
                            <span className="pm-hard-delete-confirm" data-pasture-hard-delete-confirm={area.id}>
                              Hard delete this area permanently? History will keep text snapshots, but the map shape
                              will be removed.
                              <button
                                type="button"
                                className="pm-btn pm-btn-sm pm-btn-danger"
                                onClick={() => confirmHardDelete(area)}
                                data-pasture-hard-delete-yes={area.id}
                              >
                                Hard delete
                              </button>
                              <button
                                type="button"
                                className="pm-btn pm-btn-sm"
                                onClick={() => setConfirmDeleteId(null)}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="pm-btn pm-btn-sm pm-btn-danger"
                              onClick={() => setConfirmDeleteId(area.id)}
                              data-pasture-hard-delete={area.id}
                            >
                              Hard delete
                            </button>
                          ))}
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
            <button
              type="button"
              className="pm-tool-btn"
              onClick={() => {
                // New drawn land is always a TEMP paddock. Permanent pasture/
                // paddock are created by promoting a temp paddock, not drawn.
                setDrawIsTemp(true);
                switchToolMode('draw');
              }}
              data-mode="draw"
            >
              <strong>Draw Temp Paddock</strong>
              <span>promote later</span>
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

  // Reports keep spatial/status context: every row is tagged Permanent / Temp /
  // Archived / Archived temp, or Deleted when only a text snapshot survives
  // (the area is gone from the live list). Archived areas are included.
  function reportAreaTag(landAreaId) {
    const a = areaById.get(landAreaId);
    if (!a) return <span className="pm-report-tag deleted">Deleted</span>;
    const isTemp = a.permanence === 'temporary';
    const isArch = a.status === 'retired';
    const label = isArch ? (isTemp ? 'Archived temp' : 'Archived') : isTemp ? 'Temp' : 'Permanent';
    const cls = isArch ? 'archived' : isTemp ? 'temp' : 'permanent';
    return <span className={'pm-report-tag ' + cls}>{label}</span>;
  }

  function renderReportsPanel() {
    const restRows = restReport.areas && restReport.areas.length ? restReport.areas : setupAreas;
    const reportCards = [
      {
        id: 'rest',
        title: 'Rest & recovery history',
        meta: `${restRows.length} rows - incl. archived`,
        body: (
          <div data-pasture-rest-report="1">
            <div className="pm-report-metrics">
              <span>Occupied {Number(restCounts.occupied || 0)}</span>
              <span>Resting {Number(restCounts.resting || 0)}</span>
              <span>Ready {Number(restCounts.rested || restCounts.ready || 0)}</span>
              <span>No history {Number(restCounts.baseline || restCounts.no_history || 0)}</span>
            </div>
            {restRows.slice(0, 12).map((row) => (
              <div key={row.land_area_id || row.id} className="pm-report-row">
                <strong>{row.land_area_name || row.name}</strong>
                {reportAreaTag(row.land_area_id || row.id)}
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
                    {reportAreaTag(r.land_area_id)}
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
                  {reportAreaTag(h.to_land_area_id)}
                  <span>
                    {h.to_land_area_name ? `to ${h.to_land_area_name}` : 'off map'} {formatMoveTime(h.moved_at)}
                  </span>
                </div>
              ))
            ) : moves.length ? (
              moves.slice(0, 8).map((m) => (
                <div key={m.id} className="pm-report-row">
                  <strong>{m.group_label}</strong>
                  {reportAreaTag(m.to_land_area_id)}
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
    if (!activeGroup)
      return (
        <div className="pm-field-overlay">
          <div className="pm-field-caption">
            <span className="pm-kicker">Field / Phone-first</span>
            <h2>No active planner groups</h2>
            <p>Add animals in Cattle, Sheep, or Pigs to use the field workflow.</p>
          </div>
        </div>
      );
    const remaining = activeRotation
      .slice(2)
      .map((id) => areaById.get(id))
      .filter(Boolean);
    // Same-day duplicate guard: has the active group already moved today?
    const today = new Date().toDateString();
    const fieldMovedToday = moves.some(
      (m) =>
        m.animal_type === activeGroup.animalType &&
        m.group_key === activeGroup.groupKey &&
        new Date(m.moved_at).toDateString() === today,
    );
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
              occupants: occupantsByArea,
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
          {fieldMovedToday && (
            <div className="pm-field-dupe" data-pasture-field-dupe="1">
              {activeGroup.name} already moved today. Record anyway?
            </div>
          )}
          <button
            type="button"
            className="pm-confirm-move"
            style={{'--species-color': activeSpecies.color}}
            onClick={() => {
              if (fieldMovedToday && !fieldDupeAck) {
                setFieldDupeAck(true);
                return;
              }
              setFieldDupeAck(false);
              recordGroupMove(activeGroup, nextArea && nextArea.id, {offlineOnly: fieldOffline});
            }}
            disabled={!nextArea || saving}
            data-pasture-field-confirm="1"
          >
            {fieldMovedToday && fieldDupeAck ? 'Record anyway' : `Confirm move -> ${nextArea ? nextArea.name : 'next'}`}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pm-cockpit theme-crisp">
      {Header ? <Header /> : null}
      <input
        ref={fileRef}
        type="file"
        accept=".kml,application/vnd.google-earth.kml+xml"
        onChange={onFile}
        className="pm-hidden-input"
        data-pasture-import-input="1"
      />
      <nav className="pm-tabs" aria-label="Pasture map modes">
        <div>
          {MODE_TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={appMode === tab.id ? 'is-active' : ''}
              onClick={() => switchAppMode(tab.id)}
              title={tab.hint}
              aria-current={appMode === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </div>
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
            occupants: occupantsByArea,
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
            boundaryFilter,
            onToggleBoundary: toggleBoundary,
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
