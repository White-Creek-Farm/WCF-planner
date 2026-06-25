// ============================================================================
// src/pasture/PastureMapView.jsx - Pasture Map
// ----------------------------------------------------------------------------
// Redesign handoff rebuild: a grazing planning cockpit with five modes
// (Map, Plan, Field, Reports). Existing backend contracts remain:
// geometry, import/classification, draw/edit, move ledger, planned moves,
// reports, offline replay, field tracks, and line styling all go through the
// pasture-scoped SECDEF RPC wrappers.
// ============================================================================
import React from 'react';
import PastureMapCanvas from './PastureMapCanvas.jsx';
import {parseKmlToPlacemarks, closeOutlineToPolygon} from '../lib/pastureKml.js';
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
  clearPasturePlacement,
  listPasturePlannedMoves,
  createPasturePlannedMove,
  updatePasturePlannedMoveStatus,
  listPastureHistoryReport,
  listPastureRotations,
  upsertPastureRotation,
  clearPastureRotation,
  listPastureMeasurements,
  createPastureMeasurement,
  deletePastureMeasurement,
  newPastureMeasurementId,
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
import {computePlannerGroupRoster, isPigPastureWithPaddocks} from '../lib/pasturePlannerGroups.js';
import {getOfflineImageryStatus, downloadFarmImagery} from '../lib/pastureImagery.js';
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

const SPECIES = {
  cattle: {label: 'Cattle', animalType: 'cattle_herd', color: '#9A3B2E', ink: '#7C3023', soft: '#F4E5E2'},
  pig: {label: 'Pigs', animalType: 'breeder_pigs', color: '#A8418A', ink: '#852F6D', soft: '#F3E3EE'},
  sheep: {label: 'Sheep', animalType: 'sheep_flock', color: '#1E8A8A', ink: '#166A6A', soft: '#DEF0F0'},
};

// Neutral palette for an occupant whose ledger (animal_type, group_key) no longer
// maps to a derived roster group (renamed/removed group, deleted feeder sub, etc).
const OCCUPANT_UNMATCHED = {color: '#9AA1AB', ink: '#4B5563'};

// Reconcile an area's server current_occupants (move-ledger occupancy, including
// overlap impacts) against the derived roster. Roster-matched occupants carry the
// roster identity + LOCKED roster count + species color; unmatched ledger rows are
// flagged needsReconciliation and rendered neutrally (never as a fake group). Each
// occupant keeps its impact_kind so overlap-only occupancy can be shown distinctly.
function reconcileAreaOccupants(area, rosterByKey) {
  const list = Array.isArray(area && area.current_occupants) ? area.current_occupants : [];
  return list.map((o) => {
    const g = rosterByKey.get(`${o.animal_type}::${o.group_key}`);
    const overlap = o.impact_kind === 'overlap';
    if (g) {
      const sp = SPECIES[g.species] || SPECIES.cattle;
      return {
        matched: true,
        species: g.species,
        short: g.short,
        name: g.name,
        count: g.count,
        color: sp.color,
        ink: sp.ink,
        overlap,
        animalType: g.animalType,
        groupKey: g.groupKey,
      };
    }
    return {
      matched: false,
      needsReconciliation: true,
      species: null,
      short: '?',
      name: o.group_label || 'Unmatched group',
      count: o.animal_count != null ? o.animal_count : null,
      color: OCCUPANT_UNMATCHED.color,
      ink: OCCUPANT_UNMATCHED.ink,
      overlap,
      animalType: o.animal_type,
      groupKey: o.group_key,
    };
  });
}

const MODE_TABS = [
  // Map is the single working surface: hover readout + click/tap inspector + all the
  // planning/boundary/move tools (Plan folded in). Field and Reports stay separate.
  {id: 'view', label: 'Map', hint: 'Groups, moves, rotation, boundary tools - hover to read, click to work'},
  {id: 'field', label: 'Field', hint: 'Phone-first execution'},
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
  return {
    recording: false,
    paused: false,
    points: [],
    lastAccuracyFt: null,
    error: '',
    startedAt: null,
    activeSeconds: 0,
  };
}

// Live recording duration as m:ss.
function formatTrackDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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
// "2d 4h" / "6h" elapsed since a group entered its current paddock. null when
// there is no usable move timestamp (caller shows "Time in paddock unknown").
function formatTimeInArea(movedAt) {
  if (!movedAt) return null;
  const ms = Date.now() - new Date(movedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalHours = Math.floor(ms / 3600000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
const ANIMAL_TYPE_LABEL = {
  cattle_herd: 'Cattle',
  sheep_flock: 'Sheep',
  breeder_pigs: 'Pigs',
  feeder_pigs: 'Feeder pigs',
};
function animalTypeLabel(t) {
  return ANIMAL_TYPE_LABEL[t] || 'Animals';
}

// Derive grazing STAYS for an area from its move-event history
// (list_pasture_history_report, already filtered to the area). A stay starts on each
// move INTO the area (to_land_area_id === id) and ends on that same group's next move
// OUT (from_land_area_id === id); an unmatched start is "still here". Per-stay density
// (head/ac) and animal-days derive from the area's acres and the stay length. Overlap
// impacts are NOT stays (the group grazed a different, overlapping area).
function buildGrazingStays(areaId, history, acres) {
  const asc = (history || [])
    .filter((h) => h && h.moved_at)
    .slice()
    .sort((a, b) => new Date(a.moved_at) - new Date(b.moved_at));
  const acreVal = Number(acres);
  const hasAcres = Number.isFinite(acreVal) && acreVal > 0;
  const nowMs = Date.now();
  const stays = [];
  for (let i = 0; i < asc.length; i++) {
    const ev = asc[i];
    if (ev.to_land_area_id !== areaId) continue;
    let exit = null;
    for (let j = i + 1; j < asc.length; j++) {
      const nx = asc[j];
      if (nx.animal_type !== ev.animal_type || nx.group_key !== ev.group_key) continue;
      if (nx.from_land_area_id === areaId) {
        exit = nx;
        break;
      }
      if (nx.to_land_area_id === areaId) break; // re-entry without a recorded exit
    }
    const inMs = new Date(ev.moved_at).getTime();
    const endMs = exit ? new Date(exit.moved_at).getTime() : nowMs;
    const days =
      Number.isFinite(inMs) && Number.isFinite(endMs) && endMs >= inMs
        ? Math.round(((endMs - inMs) / 86400000) * 10) / 10
        : null;
    const count = Number.parseInt(ev.animal_count, 10);
    const headCount = Number.isFinite(count) && count > 0 ? count : null;
    const density = headCount != null && hasAcres ? Math.round((headCount / acreVal) * 100) / 100 : null;
    const animalDays = headCount != null && days != null ? Math.round(headCount * days) : null;
    stays.push({
      id: ev.id,
      groupLabel: ev.group_label,
      animalType: ev.animal_type,
      headCount,
      inAt: ev.moved_at,
      outAt: exit ? exit.moved_at : null,
      stillHere: !exit,
      days,
      density,
      animalDays,
      notes: ev.notes || '',
    });
  }
  return stays.reverse(); // newest first
}

function grazingRecordTotals(stays) {
  let totalAnimalDays = 0;
  const densities = [];
  for (const s of stays) {
    if (s.animalDays != null) totalAnimalDays += s.animalDays;
    if (s.density != null) densities.push(s.density);
  }
  const avgDensity = densities.length
    ? Math.round((densities.reduce((a, b) => a + b, 0) / densities.length) * 100) / 100
    : null;
  return {timesGrazed: stays.length, totalAnimalDays, avgDensity};
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
  // V1 reset: Light has farm_team-level pasture access (pasture-scoped ONLY;
  // Light stays restricted in every other module). Migration 139 widens the same
  // farm_team-level pasture RPCs to include 'light' — keep client + DB in lockstep.
  const canRecordMoves = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light';
  const canCreateTrack = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light';
  const canViewPlanning = role === 'farm_team' || role === 'management' || role === 'admin' || role === 'light';
  // Touch devices have no hover: on Map, desktop hovers an area for the readout
  // and clicking does nothing; touch taps an area to open a read-only popover.
  // Read once - hover capability is stable for a session.
  const [isTouch] = React.useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none)').matches
      : false,
  );

  const [areas, setAreas] = React.useState([]);
  const [moves, setMoves] = React.useState([]);
  const [plans, setPlans] = React.useState([]);
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
  // Map-mode hover/focus preview of a Current group's current area. Preview is
  // display-only: it NEVER mutates selectedId or activeGroupId.
  const [previewAreaId, setPreviewAreaId] = React.useState(null);
  const [legendOpen, setLegendOpen] = React.useState(false);
  const [showRotationPath, setShowRotationPath] = React.useState(true);
  const [nextStopOnly, setNextStopOnly] = React.useState(false);
  const [listView, setListView] = React.useState(false);
  const [addMode, setAddMode] = React.useState(false);
  const [expandedPasture, setExpandedPasture] = React.useState(null);
  // Reports = every-area grazing records: the area list, the drilled-in area, and
  // that area's lazily-loaded move history (the source for its grazing timeline).
  const [reportAreaId, setReportAreaId] = React.useState(null);
  const [reportHistory, setReportHistory] = React.useState([]);
  const [reportHistoryLoading, setReportHistoryLoading] = React.useState(false);
  const [zoomSignal, setZoomSignal] = React.useState(0);
  const [styleDraft, setStyleDraft] = React.useState(() => styleDraftFromArea(null));
  const [confirmDeleteId, setConfirmDeleteId] = React.useState(null);
  const [confirmPromoteId, setConfirmPromoteId] = React.useState(null);
  const [toolsOpen, setToolsOpen] = React.useState(false);
  const [boundaryFilter, setBoundaryFilter] = React.useState({pasture: true, paddock: true, temp: true});
  const [draftLinesVisible, setDraftLinesVisible] = React.useState(false);
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
  // the leading count back out). Rotation "day count / planned days" was a neutral
  // placeholder and is no longer shown; time-in-paddock comes from the move ledger.
  const groups = React.useMemo(() => roster.groups.map((g) => ({...g, size: `${g.count} ${g.unit}`})), [roster]);
  const [serverRotations, setServerRotations] = React.useState([]);
  const [measurements, setMeasurements] = React.useState([]);
  const [measureForm, setMeasureForm] = React.useState(null);
  const [imageryStatus, setImageryStatus] = React.useState({state: 'missing'});
  const [imageryProgress, setImageryProgress] = React.useState(null);
  const [activeGroupId, setActiveGroupId] = React.useState(null);
  const [online, setOnline] = React.useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [fieldLayersOpen, setFieldLayersOpen] = React.useState(false);
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
      // Light is Map-only: fetch only the area + move data the Map needs, and skip
      // the planning/report RPCs (which Light is not granted and never displays).
      const [areaRes, moveRes, planRes, rotRes, measRes] = await Promise.all([
        listLandAreas(false),
        listPastureMoves(75),
        canViewPlanning
          ? listPasturePlannedMoves({status: 'planned', limit: 75})
          : Promise.resolve({planned_moves: []}),
        canViewPlanning ? listPastureRotations() : Promise.resolve({rotations: []}),
        canViewPlanning ? listPastureMeasurements() : Promise.resolve({measurements: []}),
      ]);
      const nextAreas = (areaRes && areaRes.land_areas) || [];
      const nextMoves = (moveRes && moveRes.moves) || [];
      const nextPlans = (planRes && planRes.planned_moves) || [];
      const nextRotations = (rotRes && rotRes.rotations) || [];
      setAreas(nextAreas);
      setMoves(nextMoves);
      setPlans(nextPlans);
      setServerRotations(nextRotations);
      setMeasurements((measRes && measRes.measurements) || []);
      cachePastureSnapshot({
        areas: nextAreas,
        moves: nextMoves,
        plans: nextPlans,
        rotations: nextRotations,
      });
      setOfflineStatus('');
      await refreshQueueState();
    } catch (e) {
      const cached = loadPastureSnapshot();
      if (cached) {
        setAreas(cached.areas || []);
        setMoves(cached.moves || []);
        setPlans(cached.plans || []);
        setServerRotations(cached.rotations || []);
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
    setImageryStatus(getOfflineImageryStatus());
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

  // Reports drill-down: load the selected area's full move history (the grazing
  // timeline source) only when its record is open. Same farm_team+/light read gate.
  React.useEffect(() => {
    let alive = true;
    if (!reportAreaId || appMode !== 'reports' || !canViewPlanning) {
      setReportHistory([]);
      setReportHistoryLoading(false);
      return () => {
        alive = false;
      };
    }
    setReportHistoryLoading(true);
    listPastureHistoryReport({landAreaId: reportAreaId, limit: 500})
      .then((res) => {
        if (alive) setReportHistory((res && res.history) || []);
      })
      .catch((e) => {
        if (alive) setErr(e.message || 'Could not load the area grazing record.');
      })
      .finally(() => {
        if (alive) setReportHistoryLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reportAreaId, appMode, canViewPlanning, moves.length]);

  React.useEffect(() => () => clearTrackWatch(), []);

  // Live recording duration: tick activeSeconds each second while recording and
  // not paused (so the duration freezes on Pause and resumes on Resume).
  React.useEffect(() => {
    if (!track.recording || track.paused) return undefined;
    const id = setInterval(() => setTrack((t) => ({...t, activeSeconds: t.activeSeconds + 1})), 1000);
    return () => clearInterval(id);
  }, [track.recording, track.paused]);

  const activeAreas = React.useMemo(
    () => areas.filter((area) => area.status !== 'retired' && area.geometry_status !== 'deleted'),
    [areas],
  );
  // The manage/recovery source keeps ALL live areas (including archived/retired)
  // so they can be restored; list_land_areas already excludes hard-deleted rows.
  // Outline candidates (tracks / open lines) are NOT areas — they live in the
  // dedicated Tracks / Lines section, not the Area Setup classification list.
  const setupAreas = React.useMemo(
    () => areas.filter((area) => area.geometry_status !== 'deleted' && !isOutlineCandidateArea(area)),
    [areas],
  );
  // Real grazing destinations only: tracks / open lines are draft geometry and
  // must never be offered as a move destination or seeded into a rotation.
  const destinationAreas = React.useMemo(
    () => activeAreas.filter((area) => !isOutlineCandidateArea(area)),
    [activeAreas],
  );
  const trackLineAreas = React.useMemo(() => activeAreas.filter((area) => isOutlineCandidateArea(area)), [activeAreas]);
  // Archived (retired) areas left the active lists when Setup was removed; this is
  // their recovery surface in Plan.
  const archivedAreas = React.useMemo(
    () => areas.filter((area) => area.status === 'retired' && area.geometry_status !== 'deleted'),
    [areas],
  );
  const areaById = React.useMemo(() => new Map(areas.map((area) => [area.id, area])), [areas]);
  // Server-backed manual rotations: serverRotations is the raw {animal_type,
  // group_key, area_ids} cache (mig 140); the per-group view is derived and pruned
  // to areas that still exist (archived/deleted destinations drop out). Edits
  // update serverRotations optimistically and persist via upsert/clear; no route
  // is generated client-side.
  const serverRotationByKey = React.useMemo(() => {
    const m = new Map();
    for (const r of serverRotations) {
      m.set(`${r.animal_type}::${r.group_key}`, Array.isArray(r.area_ids) ? r.area_ids : []);
    }
    return m;
  }, [serverRotations]);
  const rotations = React.useMemo(() => {
    const out = {};
    for (const g of groups) {
      const ids = serverRotationByKey.get(`${g.animalType}::${g.groupKey || g.id}`) || [];
      out[g.id] = ids.filter((id) => areaById.has(id));
    }
    return out;
  }, [groups, serverRotationByKey, areaById]);
  const activeGroup = groups.find((group) => group.id === activeGroupId) || groups[0] || null;
  const activeSpecies = groupSpeciesStyle(activeGroup);
  const activeRotation = ((activeGroup && rotations[activeGroup.id]) || []).filter((id) => areaById.has(id));
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
  // Derived placement for the active group. CONTRACT: actual current location
  // comes ONLY from recorded move events (groupLocation), never from the rotation
  // array. The rotation is a plan, not proof the animals are there.
  //   - placed + current area is a rotation stop  -> next = the FOLLOWING stop.
  //   - placed but current area is off-rotation    -> next = rotation[0] (first
  //     planned target); current copy must not imply it is part of the rotation.
  //   - not placed                                 -> current = null ("Not placed"),
  //     next = rotation[0] (the group's first move lands on the first stop).
  const activeCurrentArea = React.useMemo(() => {
    const loc = activeGroup ? groupLocation[activeGroup.id] : null;
    if (!loc || !loc.areaId) return null;
    return areaById.get(loc.areaId) || {id: loc.areaId, name: loc.areaName};
  }, [activeGroup, groupLocation, areaById]);
  const activeCurrentInRotation = !!activeCurrentArea && activeRotation.includes(activeCurrentArea.id);
  const activeNextArea = React.useMemo(() => {
    if (activeCurrentInRotation) {
      const idx = activeRotation.indexOf(activeCurrentArea.id);
      return areaById.get(activeRotation[idx + 1]) || null;
    }
    return areaById.get(activeRotation[0]) || null;
  }, [activeCurrentInRotation, activeCurrentArea, activeRotation, areaById]);
  // All groups' manual rotation paths for the Plan map: each carries its species
  // color + short label so overlapping paths stay distinguishable, the active
  // group is emphasized, and nextAreaId is the group's next planned stop (derived
  // from actual placement, never index 0 blindly).
  const rotationPaths = React.useMemo(() => {
    const out = [];
    for (const g of groups) {
      const ids = rotations[g.id] || [];
      if (!ids.length) continue;
      const loc = groupLocation[g.id];
      const currentId = loc && loc.areaId;
      const inRot = currentId && ids.includes(currentId);
      const nextAreaId = inRot ? ids[ids.indexOf(currentId) + 1] || ids[0] : ids[0];
      const spec = groupSpeciesStyle(g);
      out.push({
        groupId: g.id,
        areaIds: ids,
        color: spec.color,
        short: g.short,
        isActive: g.id === activeGroupId,
        nextAreaId,
      });
    }
    return out;
  }, [groups, rotations, groupLocation, activeGroupId]);
  // Roster lookup by the canonical move-ledger identity (animal_type, group_key).
  const rosterByKey = React.useMemo(() => {
    const m = new Map();
    for (const g of groups) m.set(`${g.animalType}::${g.groupKey}`, g);
    return m;
  }, [groups]);
  // Reconciled occupancy for the Map canvas, the Occupied explanation, and the
  // Area inspector. Source of truth = land_areas.current_occupants (the SAME
  // move-ledger occupancy Farm status counts, including geometric overlap
  // impacts), reconciled to the derived roster so identity/counts match the
  // roster and a stale ledger group_key with no roster match renders in a neutral
  // "needs roster reconciliation" state instead of as a fake group.
  const occupantsByArea = React.useMemo(() => {
    const out = {};
    for (const a of areas) {
      const recon = reconcileAreaOccupants(a, rosterByKey);
      if (recon.length) out[a.id] = recon;
    }
    return out;
  }, [areas, rosterByKey]);
  // Occupied areas Farm status counts, with their reconciled occupants, for the
  // Map "Occupied" explanation (replaces the removed Land areas list).
  const occupiedExplain = React.useMemo(
    () =>
      activeAreas
        .filter((a) => grazingState(a) === 'occupied')
        .map((a) => ({area: a, occupants: occupantsByArea[a.id] || []})),
    [activeAreas, occupantsByArea],
  );
  const selectedArea = areas.find((a) => a.id === selectedId) || null;
  // Reports area list: every real area (incl. archived/retired) except draft Tracks /
  // Lines (setupAreas already applies that filter), grouped so pastures and feeder-pig
  // areas carry their child paddocks nested (parent_id), with temp paddocks and
  // everything else in their own sections.
  const reportSections = React.useMemo(() => {
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
    const childrenOf = (id) => setupAreas.filter((a) => a.parent_id === id).sort(byName);
    const used = new Set();
    const withChildren = (parents) => {
      const rows = [];
      parents.sort(byName).forEach((p) => {
        if (used.has(p.id)) return;
        rows.push({area: p, depth: 0});
        used.add(p.id);
        childrenOf(p.id).forEach((c) => {
          if (used.has(c.id)) return;
          rows.push({area: c, depth: 1});
          used.add(c.id);
        });
      });
      return rows;
    };
    const pastureRows = withChildren(setupAreas.filter((a) => a.kind === 'pasture' && a.permanence !== 'temporary'));
    const feederRows = withChildren(setupAreas.filter((a) => a.kind === 'feeder_pig_area'));
    const flat = (list) => {
      const rows = list.sort(byName).map((a) => ({area: a, depth: 0}));
      rows.forEach((r) => used.add(r.area.id));
      return rows;
    };
    const tempRows = flat(setupAreas.filter((a) => a.permanence === 'temporary' && !used.has(a.id)));
    const otherRows = flat(setupAreas.filter((a) => !used.has(a.id)));
    return [
      {key: 'pastures', title: 'Pastures & paddocks', rows: pastureRows},
      {key: 'feeders', title: 'Feeder-pig areas', rows: feederRows},
      {key: 'temp', title: 'Temp paddocks', rows: tempRows},
      {key: 'other', title: 'Other areas', rows: otherRows},
    ].filter((s) => s.rows.length);
  }, [setupAreas]);
  const reportArea = reportAreaId ? areaById.get(reportAreaId) || null : null;
  const reportStays = React.useMemo(
    () => (reportArea ? buildGrazingStays(reportArea.id, reportHistory, reportArea.effective_acres) : []),
    [reportArea, reportHistory],
  );
  const reportTotals = React.useMemo(() => grazingRecordTotals(reportStays), [reportStays]);
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

  // Keep the active group pointed at a real roster group (no demo default), and
  // prime the move/plan forms with that group's locked identity + count.
  React.useEffect(() => {
    if (groups.length && !groups.some((g) => g.id === activeGroupId)) setActiveGroupFromGroup(groups[0]);
    else if (!groups.length && activeGroupId !== null) setActiveGroupId(null);
  }, [groups, activeGroupId]);

  React.useEffect(() => {
    setStyleDraft(styleDraftFromArea(selectedArea));
  }, [selectedArea]);

  // Escape: exit an active map tool (draw/edit/measure/track) if one is running,
  // otherwise clear the current selection + any open inline confirms. The tool
  // switch also clears the tool's transient layer/HUD (see switchToolMode).
  const escStateRef = React.useRef({mapMode});
  escStateRef.current = {mapMode};
  React.useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (['draw', 'edit', 'measure', 'track', 'droppin'].includes(escStateRef.current.mapMode)) {
        switchToolMode('select');
        return;
      }
      setSelectedId(null);
      setConfirmDeleteId(null);
      setConfirmPromoteId(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Field online/offline indicator from the real connection (not a manual toggle).
  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

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
    setPreviewAreaId(null);
    if (next !== 'reports') setReportAreaId(null);
    if (next !== 'view') setAddMode(false);
    // Boundary tools (track/draw/edit) live on the merged Map; reset them off any other tab.
    if (next !== 'view' && mapMode === 'track') resetTrackFlow();
    if (next !== 'view' && ['draw', 'edit'].includes(mapMode)) setMapMode('select');
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
    setAppMode('view');
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
      setAppMode('view');
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
  function toggleDraftLines() {
    setDraftLinesVisible((v) => !v);
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

  // Close a track / open line into a TEMP paddock (management/admin only). Closes
  // the line into a paddock polygon, then flips it to permanence='temporary' so it
  // gets the default white-dashed-5px temp style and can follow the existing
  // temp -> permanent promotion flow. Uses existing RPCs (no new SQL).
  async function closeIntoTempPaddock(a) {
    const res = closeOutlineToPolygon(a.raw_geometry);
    if (!res.valid) {
      setErr(`Cannot close "${a.name}": ${res.reason}.`);
      return;
    }
    return withBusy(a.id, async () => {
      await closeLandAreaOutline(a.id, res.polygon, 'paddock');
      await updateLandArea(a.id, {permanence: 'temporary', reviewStatus: 'reviewed'});
    });
  }

  function onDrawComplete(geometry, metrics) {
    setDrawForm({geometry, metrics, name: '', kind: appMode === 'view' ? 'paddock' : 'unclassified'});
  }

  function onEditGeometry(geometry, metrics) {
    setEditGeom({geometry, metrics});
  }

  // GPS watch callback: append points while recording and NOT paused. Shared by
  // Start and Resume.
  function beginTrackWatch() {
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
          // Paused (or stopped): keep the live accuracy but don't grow the track.
          if (t.paused || !t.recording) return {...t, lastAccuracyFt: accuracyFt};
          const prev = t.points[t.points.length - 1];
          if (prev && haversineM([prev.lng, prev.lat], [lng, lat]) < 1.5)
            return {...t, lastAccuracyFt: accuracyFt, error: ''};
          return {
            ...t,
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
          paused: false,
          error: geoErr && geoErr.message ? geoErr.message : 'GPS tracking failed.',
        }));
        clearTrackWatch();
      },
      {enableHighAccuracy: true, maximumAge: 1000, timeout: 15000},
    );
  }

  function startTrack() {
    if (!canCreateTrack) {
      setErr('Your role cannot create field tracks.');
      return;
    }
    // GPS Boundary works from both Plan and the Field cockpit; keep the current
    // tab (Field stays Field) rather than yanking the user into Plan.
    if (appMode !== 'field') setAppMode('view');
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
    beginTrackWatch();
  }

  // Pause keeps the watch alive (live accuracy) but stops growing the track and
  // freezes the duration; Resume continues the SAME track.
  function pauseTrack() {
    setTrack((t) => ({...t, paused: true}));
  }

  function resumeTrack() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    clearTrackWatch();
    setTrackForm(null);
    setTrack((t) => ({...t, recording: true, paused: false, error: ''}));
    setMapMode('track');
    beginTrackWatch();
  }

  function stopTrack() {
    clearTrackWatch();
    const geometry = trackGeometryFromPoints(track.points);
    const metrics = lineMetrics(geometry);
    if (!metrics.valid) {
      setTrack((t) => ({
        ...t,
        recording: false,
        paused: false,
        error: 'Track needs at least two GPS points before it can be saved.',
      }));
      return;
    }
    setTrack((t) => ({...t, recording: false, paused: false, error: ''}));
    setTrackForm({geometry, metrics, name: ''});
  }

  function cancelTrack() {
    resetTrackFlow();
    setMapMode('select');
  }

  // Saved distance measurements (CP-E): the canvas hands up the measured line; we
  // name it and persist. Measurements are layers only - no acreage, destination,
  // or report effect.
  function onSaveMeasurement(geometry, distanceFt) {
    if (!geometry || geometry.type !== 'LineString') return;
    setMeasureForm({geometry, distanceFt: distanceFt || null, name: ''});
  }

  async function saveMeasurement() {
    if (!measureForm || !measureForm.name.trim()) return;
    const id = newPastureMeasurementId();
    setSaving(true);
    setErr('');
    try {
      await createPastureMeasurement({
        id,
        name: measureForm.name.trim(),
        geometry: measureForm.geometry,
        distanceFt: measureForm.distanceFt,
      });
      setMeasureForm(null);
      switchToolMode('select');
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not save the measurement.');
    } finally {
      setSaving(false);
    }
  }

  async function deleteMeasurement(id) {
    setErr('');
    try {
      await deletePastureMeasurement(id);
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not delete the measurement.');
    }
  }

  // Offline imagery (CP-F): one-tap download of the fixed farm-area satellite cache
  // (public-domain NAIP, no token). Fails closed to a clear status if the network
  // is unavailable while downloading.
  async function downloadImagery() {
    setImageryStatus({state: 'downloading'});
    setImageryProgress({done: 0, total: 0});
    try {
      const result = await downloadFarmImagery((p) => setImageryProgress(p));
      setImageryStatus(result);
    } catch (e) {
      setImageryStatus({state: 'failed'});
      setErr(e.message || 'Offline imagery download failed.');
    } finally {
      setImageryProgress(null);
    }
  }

  function renderOfflineImagery() {
    const s = imageryStatus || {state: 'missing'};
    const downloading = s.state === 'downloading';
    const warn = s.state === 'missing' || s.state === 'stale' || s.state === 'failed' || s.state === 'partial';
    const label =
      s.state === 'downloaded'
        ? `Saved (${s.count || 0} tiles)`
        : s.state === 'partial'
          ? `Partial save (${s.count || 0}/${s.total || 0}) - retry`
          : s.state === 'stale'
            ? 'Saved imagery is stale'
            : s.state === 'failed'
              ? 'Download failed - retry'
              : downloading
                ? imageryProgress
                  ? `Downloading ${imageryProgress.done}/${imageryProgress.total || '?'}`
                  : 'Downloading...'
                : 'No offline imagery yet';
    return (
      <div className="pm-card" data-pasture-offline-imagery="1">
        <div className="pm-card-head">
          <div className="pm-card-title">Offline imagery</div>
          <span className={'pm-imagery-state' + (warn ? ' is-warn' : '')} data-pasture-imagery-state={s.state}>
            {label}
          </span>
        </div>
        <p className="pm-imagery-note">Satellite for the farm area, cached for no-signal field work (NAIP).</p>
        <button
          type="button"
          className="pm-btn pm-btn-primary"
          onClick={downloadImagery}
          disabled={downloading}
          data-pasture-imagery-download="1"
        >
          {downloading
            ? 'Downloading...'
            : s.state === 'downloaded' || s.state === 'partial'
              ? 'Re-download'
              : 'Download farm imagery'}
        </button>
      </div>
    );
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
    const targetId = selectedId || (activeNextArea && activeNextArea.id);
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
    setAppMode('view');
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
      // A temp paddock draw (Plan/Field) mints a real temp paddock via the
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
        // A temp paddock must replay through create_temp_area (the farm_team-capable
        // P0 RPC), NOT create_area (mgmt/admin) - otherwise a farm_team/light user's
        // offline temp draw would fail on sync.
        if (drawIsTemp) {
          await enqueuePastureOperation({
            id: areaId,
            op: 'create_temp_area',
            payload: {id: areaId, name: createPayload.name, polygon: createPayload.polygon, source: 'drawn'},
          });
        } else {
          await enqueuePastureOperation({id: areaId, op: 'create_area', payload: createPayload});
        }
        await refreshQueueState();
        setDrawForm(null);
        setDrawIsTemp(false);
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
    if (addMode && appMode === 'view' && activeGroup) {
      appendToRotation(activeGroup.id, id);
      return;
    }
    setSelectedId(id);
    if (appMode === 'reports') setAppMode('view');
  }

  // Persist a group's user-built rotation: optimistically update the server cache
  // (the rotations memo recomputes) then upsert/clear server-side, queueing
  // offline on a transient failure. Stores exactly what the user ordered.
  function persistRotation(group, areaIds) {
    if (!group) return;
    const animalType = group.animalType;
    const groupKey = group.groupKey || group.id;
    setServerRotations((prev) => {
      const others = prev.filter((r) => !(r.animal_type === animalType && r.group_key === groupKey));
      return areaIds.length ? [...others, {animal_type: animalType, group_key: groupKey, area_ids: areaIds}] : others;
    });
    const payload = {animalType, groupKey, areaIds};
    const run = areaIds.length ? upsertPastureRotation(payload) : clearPastureRotation({animalType, groupKey});
    run.catch(async (e) => {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({
          id: `rot-${animalType}-${groupKey}`,
          op: areaIds.length ? 'upsert_rotation' : 'clear_rotation',
          payload,
        });
        await refreshQueueState();
      } else setErr(e.message || 'Could not save the rotation.');
    });
  }

  function appendToRotation(groupId, areaId) {
    if (!areaId) return;
    const area = areaById.get(areaId);
    // Draft tracks / open lines are not valid grazing destinations.
    if (isOutlineCandidateArea(area)) {
      setErr('Tracks / open lines cannot be a move destination. Close it into a temp paddock first.');
      return;
    }
    const group = groups.find((g) => g.id === groupId);
    // Feeder pigs graze the individual pig-pasture paddocks, not the parent ~5ac
    // pasture. When that pasture has paddock children, steer to a child paddock.
    if (group && group.animalType === 'feeder_pigs' && isPigPastureWithPaddocks(area, destinationAreas)) {
      setErr(`Feeder pigs go in a specific paddock inside ${area.name}, not the whole pasture. Tap a paddock cell.`);
      return;
    }
    const current = rotations[groupId] || [];
    if (current.includes(areaId)) return;
    persistRotation(group, [...current, areaId]);
  }

  function removeFromRotation(groupId, index) {
    const group = groups.find((g) => g.id === groupId);
    const current = [...(rotations[groupId] || [])];
    current.splice(index, 1);
    persistRotation(group, current);
  }

  function moveRotationStop(groupId, from, to) {
    const group = groups.find((g) => g.id === groupId);
    const current = [...(rotations[groupId] || [])];
    const [item] = current.splice(from, 1);
    current.splice(to, 0, item);
    persistRotation(group, current);
  }

  async function recordGroupMove(group, areaId) {
    // Hard write-gate: only farm_team/management/admin record moves. Light and any
    // other non-writer can never trigger a move (UI also hides the controls; the
    // SECDEF RPC rejects non-writers server-side too).
    if (!canRecordMoves) return;
    if (!group || !areaId) return;
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
      await recordPastureMove(movePayload);
      await reload();
      setSelectedId(areaId);
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setOfflineStatus('Move saved on this device and will sync when the connection returns.');
        setSelectedId(areaId);
      } else setErr(e.message || 'Could not record pasture move.');
    } finally {
      setSaving(false);
    }
  }

  // Clear current area: record a normal pasture move for the group with NO
  // destination (toLandAreaId null) so it becomes Not placed and its prior area
  // starts resting through the existing move-ledger departure impact. Reuses
  // record_pasture_move via clearPasturePlacement (no new RPC); queues offline as the
  // same record_move payload. No-op when the group is already Not placed.
  async function clearPlacement(group) {
    // Same hard write-gate as recordGroupMove (the SECDEF RPC enforces it too;
    // mig 139 includes light in the allowed roles).
    if (!canRecordMoves || !group) return;
    const loc = groupLocation[group.id];
    if (!loc || !loc.areaId) return; // already Not placed
    const movePayload = {
      moveId: newPastureMoveId(),
      animalType: groupAnimalType(group),
      groupKey: group.groupKey || group.id,
      groupLabel: group.name,
      toLandAreaId: null,
      movedAt: new Date().toISOString(),
      animalCount: groupSizeCount(group),
      notes: `Cleared from ${loc.areaName || 'current area'}`,
    };
    setSaving(true);
    setErr('');
    try {
      await clearPasturePlacement(movePayload);
      await reload();
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setOfflineStatus('Cleared on this device and will sync when the connection returns.');
      } else setErr(e.message || 'Could not clear the current area.');
    } finally {
      setSaving(false);
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
    if (!drawForm) return null;
    // Temp paddock draw (Field/Plan) is available to farm_team/light (canCreateTrack);
    // permanent draw/edit stays manager-only.
    if (!isManager && !(drawIsTemp && canCreateTrack)) return null;
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

  function renderMeasureForm() {
    if (!measureForm) return null;
    return (
      <div className="pm-card pm-measure-form" data-pasture-measure-form="1">
        <div className="pm-card-title">Save measurement</div>
        <div className="pm-drawform-row">
          <label className="pm-field">
            <span>Name</span>
            <input
              type="text"
              value={measureForm.name}
              maxLength={200}
              placeholder="e.g. North fence length"
              onChange={(e) => setMeasureForm((f) => ({...f, name: e.target.value}))}
              data-pasture-measure-name="1"
              autoFocus
            />
          </label>
          <span className="pm-drawform-metric">{formatDistanceFt(measureForm.distanceFt)}</span>
        </div>
        <div className="pm-track-actions">
          <button type="button" className="pm-btn" onClick={() => setMeasureForm(null)} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="pm-btn pm-btn-primary"
            onClick={saveMeasurement}
            disabled={saving || !measureForm.name.trim()}
            data-pasture-measure-save-confirm="1"
          >
            {saving ? 'Saving...' : 'Save measurement'}
          </button>
        </div>
      </div>
    );
  }

  function renderMeasurementsList() {
    if (!measurements.length) return null;
    return (
      <div className="pm-card" data-pasture-measurements="1">
        <div className="pm-card-head">
          <div className="pm-card-title">Saved measurements</div>
          <span data-pasture-measurements-count="1">{measurements.length}</span>
        </div>
        {measurements.map((mm) => (
          <div key={mm.id} className="pm-measurement-row" data-pasture-measurement={mm.id}>
            <strong>{mm.name}</strong>
            <span>{formatDistanceFt(mm.distance_ft)}</span>
            <button
              type="button"
              className="pm-btn pm-btn-sm"
              onClick={() => deleteMeasurement(mm.id)}
              data-pasture-measurement-delete={mm.id}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    );
  }

  function renderTrackPanel() {
    if (!canCreateTrack || mapMode !== 'track') return null;
    const liveMetrics = trackForm ? trackForm.metrics : trackMetricsFromPoints(track.points);
    const trackState = track.recording ? (track.paused ? 'paused' : 'recording') : trackForm ? 'stopped' : 'idle';
    return (
      <div className="pm-track-panel" data-pasture-track-panel="1">
        <div className="pm-track-head">
          <div>
            <div className="pm-track-title">
              {trackState === 'recording' && <span className="pm-rec-dot" aria-hidden="true" />}
              Walk paddock
            </div>
            <div className="pm-track-sub" data-pasture-track-state={trackState}>
              {trackState === 'recording'
                ? 'Recording GPS points'
                : trackState === 'paused'
                  ? 'Paused - Resume to keep recording'
                  : trackState === 'stopped'
                    ? 'Stopped - Save, Resume, or Cancel'
                    : 'Start GPS, then walk or drive the boundary'}
            </div>
          </div>
          <div className="pm-track-stats" data-pasture-track-stats="1">
            <span>{trackForm ? trackForm.metrics.points : track.points.length} pts</span>
            <span>{formatDistanceFt(liveMetrics.distanceFt) || '0 ft'}</span>
            <span data-pasture-track-duration="1">{formatTrackDuration(track.activeSeconds)}</span>
            {track.lastAccuracyFt != null && <span>GPS +/- {track.lastAccuracyFt.toLocaleString()} ft</span>}
          </div>
        </div>
        {track.error && <div className="pm-track-error">{track.error}</div>}
        {trackForm ? (
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
                className="pm-btn"
                onClick={resumeTrack}
                disabled={saving}
                data-pasture-track-resume="1"
              >
                Resume
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
        ) : track.recording ? (
          <div className="pm-track-actions">
            {track.paused ? (
              <button
                type="button"
                className="pm-btn pm-btn-primary"
                onClick={resumeTrack}
                data-pasture-track-resume="1"
              >
                Resume
              </button>
            ) : (
              <button type="button" className="pm-btn" onClick={pauseTrack} data-pasture-track-pause="1">
                Pause
              </button>
            )}
            <button type="button" className="pm-btn" onClick={stopTrack} data-pasture-track-stop="1">
              Stop
            </button>
            <button type="button" className="pm-btn" onClick={cancelTrack}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="pm-track-actions">
            <button type="button" className="pm-btn pm-btn-primary" onClick={startTrack} data-pasture-track-start="1">
              {track.points.length ? 'Restart track' : 'Start track'}
            </button>
            <button type="button" className="pm-btn" onClick={cancelTrack}>
              Cancel
            </button>
          </div>
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
          <button
            type="button"
            className="pm-selected-close"
            onClick={() => setSelectedId(null)}
            aria-label="Close area detail"
            title="Close (Esc)"
            data-pasture-clear-selection="1"
          >
            ✕
          </button>
        </div>
        <div className="pm-area-detail-chips" data-pasture-area-detail={selectedArea.id}>
          <span className={'pm-chip pm-chip-' + selectedArea.kind}>{designationLabel(selectedArea)}</span>
          {isTempArea(selectedArea) && <span className="pm-chip pm-chip-temp">Temp</span>}
          {isArchivedArea(selectedArea) && (
            <span className="pm-chip">{isTempArea(selectedArea) ? 'Archived temp' : 'Archived'}</span>
          )}
        </div>
        {(occupantsByArea[selectedArea.id] || []).length > 0 && (
          <div className="pm-occupants" data-pasture-occupancy={selectedArea.id}>
            {/* Occupant identity + count come from the roster-matched group when
                available (same source as the map marker + the locked move-form
                count); unmatched ledger rows and overlap-only occupancy are
                tagged, never shown as a fresh/real group. */}
            {(occupantsByArea[selectedArea.id] || []).map((o, i) => (
              <span
                key={(o.animalType || '') + (o.groupKey || '') + i}
                className={
                  'pm-occupant-pill' + (o.needsReconciliation ? ' is-unmatched' : '') + (o.overlap ? ' is-overlap' : '')
                }
                data-pasture-occupant-unmatched={o.needsReconciliation ? '1' : undefined}
              >
                {o.name}
                {o.count != null ? ` · ${o.count}` : ''}
                {o.overlap ? ' (overlap)' : ''}
                {o.needsReconciliation ? ' (needs roster)' : ''}
              </span>
            ))}
          </div>
        )}
        <div className="pm-kv">
          <span>State</span>
          <strong data-pasture-rest-state={selectedArea.rest_state || 'baseline'}>{restCopy(selectedArea)}</strong>
          <span>Acres</span>
          <strong data-pasture-acres-readonly={selectedArea.id}>
            {selectedArea.effective_acres == null ? '-' : `${selectedArea.effective_acres} ac`}
          </strong>
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
        {/* Map is read-only "where things are"; move/plan recording lives in
            Plan and area management lives in the contextual modal. */}
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

  // Map-mode Current-group hover/focus preview: highlight the group's CURRENT
  // area on the map (and surface its label) without selecting/zooming/activating.
  // A Not-placed group highlights nothing. Never mutates selectedId/activeGroupId.
  function previewGroupArea(group) {
    const loc = groupLocation[group.id];
    setPreviewAreaId(loc && loc.areaId ? loc.areaId : null);
  }
  function clearGroupPreview() {
    setPreviewAreaId(null);
  }

  // Current Groups (Map): roster-backed groups with locked counts and current
  // location resolved from the move ledger by (animal_type, group_key). On Map
  // these rows are inspection-only — clicking does nothing; hover/focus previews
  // the group's current area on the map.
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
                const isPreview = previewAreaId && loc && loc.areaId === previewAreaId;
                // Focusable, NON-button row: there is no click action, so button
                // semantics would be wrong. Hover/focus previews only.
                return (
                  <div
                    key={g.id}
                    className={'pm-current-row is-preview-row' + (isPreview ? ' is-previewing' : '')}
                    style={{'--species-color': sec.color}}
                    tabIndex={0}
                    data-pasture-current-group={g.groupKey}
                    onMouseEnter={() => previewGroupArea(g)}
                    onMouseLeave={clearGroupPreview}
                    onFocus={() => previewGroupArea(g)}
                    onBlur={clearGroupPreview}
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
                      {loc && loc.movedAt && (
                        <em className="pm-loc-time" data-pasture-current-time="1">
                          {formatTimeInArea(loc.movedAt)}
                        </em>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Map "Occupied" explanation: enumerates every area Farm status counts as
  // occupied (including overlap), with the reconciled occupant(s). Replaces the
  // removed Land areas list and keeps Occupied=N understandable without it.
  function renderOccupiedExplain() {
    if (!occupiedExplain.length) return null;
    return (
      <div className="pm-occupied-explain" data-pasture-occupied-explain="1">
        <div className="pm-occupied-explain-title">What is occupied</div>
        {occupiedExplain.map(({area, occupants}) => (
          <div key={area.id} className="pm-occupied-row" data-pasture-occupied-area={area.id}>
            <strong>{area.name || 'Unnamed'}</strong>
            <span className="pm-occupied-by">
              {occupants.length
                ? occupants
                    .map(
                      (o) =>
                        `${o.name}${o.count != null ? ` ${o.count}` : ''}${o.overlap ? ' (overlap)' : ''}${
                          o.needsReconciliation ? ' (needs roster)' : ''
                        }`,
                    )
                    .join(', ')
                : 'Occupied (no current group on record)'}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Touch-only read-only popover: on Map, tapping an area opens the same read-only
  // Area detail as a popover over the map (desktop uses the hover readout instead).
  function renderViewPanel() {
    // Merged Map overview "where things are": desktop hovers an area for the readout;
    // hover/focus a group row to preview its area on the map. Clicking/tapping an area
    // opens the working Area inspector (and the planning cockpit stays below).
    const unplacedGroupCount = groups.filter((g) => !groupLocation[g.id]).length;
    const queuedItemCount = (queueState.queuedCount || 0) + (queueState.stuckCount || 0);
    return (
      <>
        <div className="pm-panel-title" data-pasture-map-header="1">
          <span className="pm-kicker">MAP - WHERE THINGS ARE</span>
          <h2>Current groups</h2>
          <p>
            {groups.length
              ? `${groups.length - unplacedGroupCount} of ${groups.length} groups placed - hover to read, click an area to work; tap on a phone`
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
            <div data-pasture-status-unplaced="1">
              <span className="dot unplaced" /> Unplaced<strong>{unplacedGroupCount}</strong>
            </div>
            <div data-pasture-status-queued="1">
              <span className="dot queued" /> Queued<strong>{queuedItemCount}</strong>
            </div>
          </div>
          {renderOccupiedExplain()}
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
            <button
              type="button"
              className={nextStopOnly ? 'is-active' : ''}
              onClick={() => setNextStopOnly((v) => !v)}
              data-pasture-next-stop-only={nextStopOnly ? '1' : '0'}
            >
              Next only
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
              // NOW reflects ACTUAL recorded placement, not index 0.
              const isNow = !!activeCurrentArea && areaId === activeCurrentArea.id;
              return (
                <div
                  key={areaId}
                  className={'pm-rot-chip' + (isNow ? ' is-now' : '')}
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
              // NOW reflects ACTUAL recorded placement, not index 0.
              const isNow = !!activeCurrentArea && areaId === activeCurrentArea.id;
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
                      {isNow ? 'NOW - ' : ''}
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
        <div className="pm-plan-tools">
          <button
            type="button"
            className={'pm-btn' + (addMode ? ' pm-btn-primary' : '')}
            onClick={() => {
              setAppMode('view');
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
              setAppMode('view');
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
        {(() => {
          const curLoc = groupLocation[activeGroup.id] || null;
          // Current area is the recorded placement only (activeCurrentArea); an
          // unplaced group reads "Not placed" instead of borrowing rotation[0].
          const currentArea = activeCurrentArea;
          const timeInArea = curLoc ? formatTimeInArea(curLoc.movedAt) : null;
          const offRotation = !!currentArea && !activeCurrentInRotation;
          const timeCopy = currentArea
            ? timeInArea
              ? `In ${currentArea.name} for ${timeInArea}`
              : 'Time in paddock unknown'
            : 'Not placed';
          return (
            <div
              className="pm-card pm-group-move-card"
              style={{'--species-color': activeSpecies.color, '--species-soft': activeSpecies.soft}}
              data-pasture-group-move="1"
            >
              <div className="pm-group-move-head">
                <span className="pm-avatar">{activeGroup.short}</span>
                <div>
                  <strong>{activeGroup.name}</strong>
                  <em>
                    {activeSpecies.label} &middot; {activeGroup.size}
                  </em>
                </div>
              </div>
              <div className="pm-group-move-grid">
                <div className="pm-group-move-cell">
                  <span>Current area</span>
                  <strong>{currentArea ? currentArea.name : 'Not placed'}</strong>
                  <em data-pasture-time-in-area="1">{offRotation ? `${timeCopy} (off rotation)` : timeCopy}</em>
                </div>
                <div className="pm-next-arrow" aria-hidden="true">
                  -&gt;
                </div>
                <div className="pm-group-move-cell">
                  <span>Next area</span>
                  <strong>{activeNextArea ? activeNextArea.name : '-'}</strong>
                  <em>
                    {activeNextArea && activeNextArea.rest_days != null
                      ? `${activeNextArea.rest_days}d rested`
                      : 'Rest unknown'}
                  </em>
                </div>
              </div>
              <button
                type="button"
                className="pm-btn pm-btn-primary pm-move-btn"
                onClick={() => recordGroupMove(activeGroup, activeNextArea && activeNextArea.id)}
                disabled={!activeNextArea || saving || !canRecordMoves}
                data-pasture-move="1"
              >
                {saving ? 'Saving...' : 'Move'}
              </button>
              {/* Clear current area: only when the group is actually placed. Records a
                  no-destination move so it becomes Not placed (no new RPC). */}
              {currentArea && (
                <button
                  type="button"
                  className="pm-btn pm-clear-btn"
                  onClick={() => clearPlacement(activeGroup)}
                  disabled={saving || !canRecordMoves}
                  data-pasture-clear-placement="1"
                >
                  {saving ? 'Saving...' : 'Clear current area'}
                </button>
              )}
            </div>
          );
        })()}
        {activeNextArea && (occupantsByArea[activeNextArea.id] || []).some((o) => o.name !== activeGroup.name) && (
          <div className="pm-conflict-warn" data-pasture-plan-conflict="1">
            &#9888; {activeNextArea.name} is currently occupied by{' '}
            {(occupantsByArea[activeNextArea.id].find((o) => o.name !== activeGroup.name) || {}).name}.
          </div>
        )}
        {renderRotationEditor()}
        {plans.length > 0 && renderPlannedMoves()}
        {/* Manager workflow tools (relocated from the removed Setup tab). Per-area
            classification / management opens the contextual area modal on select;
            manual / off-rotation move also lives in that modal. */}
        {renderTracksLines()}
        {renderClassificationQueue()}
        {renderArchivedAreas()}
        {renderBoundaryTools()}
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

  // Tracks / Lines: GPS tracks + manually drawn OPEN lines. Draft geometry only -
  // no acreage, never a move destination, not promotable directly. Each row can
  // be zoomed, closed into a temp paddock (mgmt/admin), or deleted.
  function renderTracksLines() {
    const lines = trackLineAreas;
    if (!lines.length) return null;
    return (
      <div className="pm-card pm-tracks-lines" data-pasture-tracks-lines="1">
        <div className="pm-card-head">
          <div>
            <div className="pm-card-title">Tracks / Lines</div>
            <p>GPS tracks and drawn open lines - draft geometry, not grazing areas yet.</p>
          </div>
          <span className="pm-open-outline-count" data-pasture-tracks-lines-count="1">
            {lines.length}
          </span>
        </div>
        {lines.map((a) => (
          <div key={a.id} className="pm-open-outline-row" data-pasture-track-line={a.id}>
            <button
              type="button"
              className="pm-open-outline-name"
              onClick={() => {
                setSelectedId(a.id);
                setZoomSignal((n) => n + 1);
              }}
              data-pasture-track-line-zoom={a.id}
            >
              <span className="pm-chip pm-chip-outline_candidate">Track / line</span>
              {a.name || 'Unnamed'}
            </button>
            <div className="pm-track-line-actions">
              <button
                type="button"
                className="pm-btn pm-btn-sm"
                onClick={() => closeIntoTempPaddock(a)}
                disabled={!isManager || busyId === a.id}
                title="Close into a temp paddock (manager/admin)"
                data-pasture-track-line-close={a.id}
              >
                Close into temp paddock
              </button>
              <button
                type="button"
                className="pm-btn pm-btn-sm pm-btn-danger"
                onClick={() => removeArea(a)}
                disabled={!isManager || busyId === a.id}
                data-pasture-track-line-delete={a.id}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  // Boundary tools (relocated from the removed Setup tab into Plan). Collapsible
  // so Plan stays focused on rotation/moves until tools are needed. Draw / track /
  // edit forms surface here when active.
  // Archived-area recovery (Plan). Retired areas are off the active lists; restore
  // them here. Management/admin only (restore RPC enforces it too).
  function renderArchivedAreas() {
    if (!isManager || !archivedAreas.length) return null;
    return (
      <div className="pm-card" data-pasture-archived="1">
        <div className="pm-card-title">Archived areas</div>
        {archivedAreas.map((a) => (
          <div key={a.id} className="pm-classify-row" data-pasture-archived-row={a.id}>
            <span>
              {a.name || 'Unnamed'}
              {isTempArea(a) ? ' (temp)' : ''}
            </span>
            <button
              type="button"
              className="pm-btn pm-btn-sm"
              onClick={() => restoreArea(a)}
              disabled={busyId === a.id}
              data-pasture-archived-restore={a.id}
            >
              Restore
            </button>
          </div>
        ))}
      </div>
    );
  }

  function renderBoundaryTools() {
    if (!isManager) return null;
    return (
      <>
        {/* Transient operation forms always surface in Plan while active, even if
            the tool grid is collapsed. */}
        {renderTrackPanel()}
        {renderDrawForm()}
        {renderMeasureForm()}
        {renderEditBar()}
        <div className="pm-card" data-pasture-boundary-tools="1">
          <button
            type="button"
            className="pm-manual-move-toggle"
            onClick={() => setToolsOpen((v) => !v)}
            aria-expanded={toolsOpen}
            data-pasture-boundary-tools-toggle="1"
          >
            <span>Boundary tools</span>
            <span aria-hidden="true">{toolsOpen ? '-' : '+'}</span>
          </button>
          {toolsOpen && (
            <>
              <div className="pm-tool-grid">
                <button type="button" className="pm-tool-btn" onClick={() => switchToolMode('select')} data-mode="move">
                  <strong>Map / Pan</strong>
                  <span>browse &amp; select</span>
                </button>
                <button type="button" className="pm-tool-btn" onClick={startTrack} data-mode="track">
                  <strong>GPS Boundary</strong>
                  <span>walk a line</span>
                </button>
                <button
                  type="button"
                  className="pm-tool-btn"
                  onClick={startEdit}
                  disabled={!selectedId || !selectedEditable}
                  data-mode="edit"
                >
                  <strong>Edit Boundary</strong>
                  <span>reshape selected</span>
                </button>
                <button
                  type="button"
                  className="pm-tool-btn"
                  onClick={() => switchToolMode('measure')}
                  data-mode="measure"
                >
                  <strong>Measure</strong>
                  <span>two-point distance</span>
                </button>
                <button
                  type="button"
                  className="pm-tool-btn"
                  onClick={() => {
                    // New drawn land is always a TEMP paddock; permanent comes from promotion.
                    setDrawIsTemp(true);
                    switchToolMode('draw');
                  }}
                  data-mode="draw"
                >
                  <strong>Draw Temp Paddock</strong>
                  <span>promote later</span>
                </button>
              </div>
              <button
                type="button"
                className="pm-import-wide"
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                Import OnX KML
              </button>
            </>
          )}
        </div>
      </>
    );
  }

  // Compact classification queue (Plan). Rows open the contextual area modal to
  // classify - no long Setup-style list.
  function renderClassificationQueue() {
    if (!isManager || !classifyQueue.length) return null;
    return (
      <div className="pm-card" data-pasture-classify-queue="1">
        <div className="pm-card-title">Needs classification</div>
        <div className="pm-classify-meter">
          <span>
            {Math.max(0, activeAreas.length - classifyQueue.length)} of {activeAreas.length || 0} areas classified
          </span>
          <strong>{classifyQueue.length} left</strong>
        </div>
        {classifyQueue.slice(0, 8).map((area) => (
          <div key={area.id} className="pm-classify-row">
            <span>{area.name || 'Unnamed'}</span>
            <button
              type="button"
              className="pm-btn pm-btn-sm"
              onClick={() => setSelectedId(area.id)}
              data-pasture-classify-open={area.id}
            >
              Open &gt;
            </button>
          </div>
        ))}
      </div>
    );
  }

  // Per-area management for the contextual modal (relocated from the Setup
  // pasture-editor row). Classification / promotion / close-outline-into-temp /
  // redraw / archive / restore / admin hard-delete. Acreage stays read-only
  // (shown in the detail panel); no rest-days input.
  function renderAreaManageActions(area) {
    if (!area || !isManager) return null;
    const isTemp = area.permanence === 'temporary';
    const isArchived = area.status === 'retired';
    const isOutline = area.kind === 'outline_candidate' || area.geometry_status === 'outline_candidate';
    const canManageArea = isTemp ? canRecordMoves : isManager;
    return (
      <div className="pm-card pm-area-manage" data-pasture-area-manage={area.id} data-kind={area.kind}>
        <div className="pm-card-title">Manage area</div>
        {!isOutline && (
          <label className="pm-field">
            <span>Name</span>
            <input
              key={area.id}
              defaultValue={area.name || ''}
              disabled={!canManageArea}
              onBlur={(e) => {
                const value = e.target.value.trim();
                if (value && value !== area.name) isTemp ? renameTemp(area, value) : saveAreaPatch(area, {name: value});
              }}
            />
          </label>
        )}
        {isOutline ? (
          <div className="pm-field" data-pasture-designation-line={area.id}>
            <span>Draft line</span>
            <div className="pm-temp-designation">
              <span className="pm-chip pm-chip-outline_candidate">Track / line</span>
              <button
                type="button"
                className="pm-btn pm-btn-sm"
                onClick={() => closeIntoTempPaddock(area)}
                disabled={!isManager || busyId === area.id}
                data-pasture-close-into-temp={area.id}
              >
                Close into temp paddock
              </button>
            </div>
          </div>
        ) : isTemp ? (
          <div className="pm-field" data-pasture-designation={area.id} data-pasture-designation-temp="1">
            <span>Designation</span>
            <div className="pm-temp-designation">
              <span className="pm-chip pm-chip-temp">Temp paddock</span>
              {confirmPromoteId === area.id ? (
                <span className="pm-promote-confirm" data-pasture-promote-confirm={area.id}>
                  Promote to permanent? The boundary style locks to the fixed permanent style.
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
                  <button type="button" className="pm-btn pm-btn-sm" onClick={() => setConfirmPromoteId(null)}>
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
              )}
            </div>
          </div>
        ) : (
          <label className="pm-field">
            <span>Classification</span>
            <select
              value={area.kind === 'pasture' ? 'pasture' : area.kind === 'paddock' ? 'paddock' : 'unclassified'}
              disabled={!isManager}
              onChange={(e) => classifyDesignation(area, e.target.value)}
              data-pasture-designation={area.id}
            >
              <option value="unclassified" disabled>
                Needs classification
              </option>
              <option value="pasture">Pasture</option>
              <option value="paddock">Paddock</option>
            </select>
          </label>
        )}
        {area.kind === 'unclassified' && (
          <div className="pm-needs-classification" data-pasture-needs-classification={area.id}>
            Needs classification - choose Pasture or Paddock. New land is added as a temp paddock via Draw.
          </div>
        )}
        <div className="pm-setup-actions">
          <button
            type="button"
            className="pm-btn pm-btn-sm"
            onClick={() => {
              setDrawIsTemp(isTemp);
              startEdit();
            }}
            disabled={!hasPolygonGeom(area) || !canManageArea}
            data-pasture-redraw={area.id}
          >
            Redraw
          </button>
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
          {/* Hard delete is NOT here - it lives in a deliberate admin-only Danger
              zone (renderDangerZone), away from normal actions. */}
        </div>
      </div>
    );
  }

  // Admin-only Danger zone: hard delete is intentionally isolated behind its own
  // disclosure + inline confirm so it is never adjacent to routine area actions.
  function renderDangerZone(area) {
    if (!area || !isAdmin) return null;
    return (
      <div className="pm-card pm-danger-zone" data-pasture-danger-zone={area.id}>
        <div className="pm-card-title">Danger zone</div>
        <p className="pm-danger-note">
          Hard delete permanently removes this area's map shape. History keeps text snapshots. This cannot be undone.
        </p>
        {confirmDeleteId === area.id ? (
          <span className="pm-hard-delete-confirm" data-pasture-hard-delete-confirm={area.id}>
            Permanently hard delete {area.name || 'this area'}?
            <button
              type="button"
              className="pm-btn pm-btn-sm pm-btn-danger"
              onClick={() => confirmHardDelete(area)}
              data-pasture-hard-delete-yes={area.id}
            >
              Hard delete
            </button>
            <button type="button" className="pm-btn pm-btn-sm" onClick={() => setConfirmDeleteId(null)}>
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
        )}
      </div>
    );
  }

  // Plan-mode Area inspector: a right-side, sectioned/disclosed inspector that
  // REPLACES the old centered modal. Read-only facts on top, then collapsible
  // action sections (Manage, Line style, Record / plan move, Danger zone). No
  // overlay, no backdrop, no interaction trap.
  function renderPlanAreaInspector() {
    if (!selectedArea) return null;
    const styleEligible = isManager && canEditLineStyle(selectedArea);
    const lockedStyle = isManager && isFixedStyleArea(selectedArea);
    return (
      <div className="pm-plan-inspector" data-pasture-plan-inspector={selectedArea.id}>
        {renderSelectedPanel()}
        {isManager && (
          <details className="pm-inspector-section" open data-pasture-inspector-section="manage">
            <summary>Manage area</summary>
            {renderAreaManageActions(selectedArea)}
            {/* Locked permanent-style is a small inline note where the style
                controls would otherwise appear - not a standalone card. */}
            {lockedStyle && (
              <p className="pm-style-locked-note" data-pasture-setup-linestyle-locked="1">
                {selectedArea.kind === 'pasture' ? 'Pasture' : 'Paddock'} boundaries use a fixed
                {selectedArea.kind === 'pasture' ? ' blue' : ' green'} line and cannot be restyled. Only temp paddocks
                and GPS field tracks have editable line style.
              </p>
            )}
          </details>
        )}
        {styleEligible && (
          <details
            className="pm-inspector-section"
            data-pasture-inspector-section="linestyle"
            data-pasture-setup-linestyle="1"
          >
            <summary>Line style</summary>
            {renderLineStylePanel()}
          </details>
        )}
        {canRecordMoves && !isOutlineCandidateArea(selectedArea) && (
          <details
            className="pm-inspector-section"
            open
            data-pasture-inspector-section="move"
            data-pasture-modal-move="1"
          >
            <summary>Record / plan move</summary>
            {renderMoveAndPlanForms()}
          </details>
        )}
        {isAdmin && (
          <details className="pm-inspector-section pm-inspector-danger" data-pasture-inspector-section="danger">
            <summary>Danger zone</summary>
            {renderDangerZone(selectedArea)}
          </details>
        )}
      </div>
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

  // Reports = every-area grazing records. The list (grouped, archived tagged) drills
  // into a per-area record: status header + lifetime totals + the dated grazing
  // timeline (every stay, by which group and how many head, with density/animal-days).
  function renderReportsPanel() {
    if (reportAreaId && reportArea) return renderAreaRecord();
    return renderReportAreaList();
  }

  function renderReportAreaList() {
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">Reports</span>
          <h2>Grazing records by area</h2>
          <p>Every area and its full grazing history. Select an area to open its record.</p>
        </div>
        <div className="pm-report-status-strip" data-pasture-report-summary="1">
          <span>
            <i className="dot occupied" /> Occupied {statusCounts.occupied}
          </span>
          <span>
            <i className="dot resting" /> Resting {statusCounts.resting}
          </span>
          <span>
            <i className="dot ready" /> Ready {statusCounts.ready}
          </span>
          <span>
            <i className="dot no-history" /> No history {statusCounts.no_history}
          </span>
        </div>
        <div className="pm-report-area-list" data-pasture-report-areas="1">
          {reportSections.map((section) => (
            <div key={section.key} className="pm-report-area-section">
              <div className="pm-report-area-section-title">{section.title}</div>
              {section.rows.map(({area, depth}) => {
                const state = grazingState(area);
                return (
                  <button
                    type="button"
                    key={area.id}
                    className={'pm-report-area-row depth-' + depth + ' state-' + state}
                    onClick={() => setReportAreaId(area.id)}
                    data-pasture-report-area-row={area.id}
                  >
                    <span className="pm-report-area-name">
                      {area.name || 'Unnamed'} {reportAreaTag(area.id)}
                    </span>
                    <span className="pm-report-area-meta">
                      {designationLabel(area)}
                      {area.effective_acres != null ? ` · ${area.effective_acres} ac` : ''}
                    </span>
                    <span className="pm-report-area-status">
                      <i className="dot" /> {restCopy(area)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {!reportSections.length && <div className="pm-report-empty">No areas yet. Import or draw areas first.</div>}
        </div>
      </>
    );
  }

  function renderAreaRecord() {
    const area = reportArea;
    const occ = (occupantsByArea[area.id] || []).find((o) => !o.overlap) || null;
    const openStay = reportStays.find((s) => s.stillHere) || null;
    const statusLine =
      occ && openStay
        ? `In use by ${occ.name} since ${formatMoveTime(openStay.inAt)}`
        : area.last_touched_at
          ? `Last grazed ${formatMoveTime(area.last_touched_at)}`
          : 'No grazing history yet';
    return (
      <>
        <div className="pm-panel-title pm-record-title">
          <button
            type="button"
            className="pm-btn pm-btn-sm"
            onClick={() => setReportAreaId(null)}
            data-pasture-report-back="1"
          >
            &larr; All areas
          </button>
          <span className="pm-kicker">Area grazing record</span>
          <h2>
            {area.name || 'Unnamed area'} {reportAreaTag(area.id)}
          </h2>
        </div>
        <div className="pm-card pm-record-header" data-pasture-report-record={area.id}>
          <div className="pm-record-facts">
            <span className="pm-record-fact">
              <b>{designationLabel(area)}</b>
            </span>
            {area.effective_acres != null && <span className="pm-record-fact">{area.effective_acres} ac</span>}
          </div>
          <div className="pm-record-status" data-pasture-report-status="1">
            {statusLine}
          </div>
          <div className="pm-record-rest">{restCopy(area)}</div>
          <div className="pm-record-totals" data-pasture-report-totals="1">
            <span>
              <b>{reportTotals.timesGrazed}</b> times grazed
            </span>
            <span>
              <b>{reportTotals.totalAnimalDays.toLocaleString()}</b> animal-days
            </span>
            <span>
              <b>{reportTotals.avgDensity != null ? reportTotals.avgDensity.toLocaleString() : '-'}</b> avg head/ac
            </span>
          </div>
        </div>
        <div className="pm-card" data-pasture-report-timeline="1">
          <div className="pm-card-title">Grazing timeline</div>
          {reportHistoryLoading ? (
            <div className="pm-report-empty">Loading record...</div>
          ) : reportStays.length ? (
            reportStays.map((s) => (
              <div key={s.id} className="pm-record-stay" data-pasture-report-stay="1">
                <div className="pm-record-stay-head">
                  <strong>{s.groupLabel}</strong>
                  <span className="pm-record-stay-type">{animalTypeLabel(s.animalType)}</span>
                  {s.headCount != null && (
                    <span className="pm-record-stay-count">{s.headCount.toLocaleString()} head</span>
                  )}
                  {s.stillHere && <span className="pm-record-stay-here">Still here</span>}
                </div>
                <div className="pm-record-stay-when">
                  {formatMoveTime(s.inAt)} &rarr; {s.outAt ? formatMoveTime(s.outAt) : 'now'}
                  {s.days != null ? ` · ${s.days} day${s.days === 1 ? '' : 's'}` : ''}
                </div>
                <div className="pm-record-stay-metrics">
                  {s.density != null && <span>{s.density.toLocaleString()} head/ac</span>}
                  {s.animalDays != null && <span>{s.animalDays.toLocaleString()} animal-days</span>}
                </div>
                {s.notes && <div className="pm-record-stay-notes">{s.notes}</div>}
              </div>
            ))
          ) : (
            <div className="pm-report-empty">No grazing recorded for this area yet.</div>
          )}
        </div>
      </>
    );
  }

  function renderPanel() {
    // Field is a full-screen OnX-style map; its controls live in the field chrome
    // overlay, not the side panel.
    if (appMode === 'field') return null;
    if (appMode === 'reports') return renderReportsPanel();
    // Merged Map: clicking/tapping an area opens the working Area inspector; with no
    // selection the top shows the Current groups overview. The planning cockpit
    // (group switcher, move + Clear, rotation editor, boundary/manager tools) is
    // ALWAYS rendered below so selecting an area never hides the working controls.
    // Suppressed while tapping the map to add rotation stops (addMode) and during
    // active map tools so the map + transient tool forms stay usable.
    const inspecting = selectedArea && !addMode && !['draw', 'edit', 'measure', 'track', 'droppin'].includes(mapMode);
    return (
      <>
        {inspecting ? renderPlanAreaInspector() : renderViewPanel()}
        {renderPlanPanel()}
      </>
    );
  }

  // OnX-style Field chrome: the real map is the hero (rendered in pm-map-col);
  // this overlays a top status pill, the active build-tool save forms, and a dark
  // bottom toolbar (Walk paddock / Draw paddock / Measure / Layers). Field is a
  // spatial GPS tool - locate yourself, build a temp paddock, measure - and never
  // records group moves (that stays in Plan).
  function renderFieldChrome() {
    if (appMode !== 'field') return null;
    const measuring = mapMode === 'measure';
    return (
      <div className="pm-field-chrome" data-pasture-field-chrome="1">
        <div className="pm-field-top">
          <span className="pm-field-title">Field</span>
          <span
            className={'pm-field-net' + (online ? '' : ' is-offline')}
            data-pasture-field-online={online ? '1' : '0'}
          >
            <i aria-hidden="true" />
            {online ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="pm-field-forms">
          {renderTrackPanel()}
          {renderDrawForm()}
          {renderMeasureForm()}
          {fieldLayersOpen ? renderMeasurementsList() : null}
          {fieldLayersOpen ? renderOfflineImagery() : null}
        </div>
        <div className="pm-field-toolbar" data-pasture-field-toolbar="1">
          <button
            type="button"
            className={'pm-field-tool is-record' + (mapMode === 'track' ? ' is-active' : '')}
            onClick={startTrack}
            disabled={!canCreateTrack}
            data-pasture-field-walk="1"
          >
            <span className="pm-field-tool-ic" aria-hidden="true">
              &#9673;
            </span>
            <span>Walk paddock</span>
          </button>
          <button
            type="button"
            className={'pm-field-tool is-draw' + (mapMode === 'droppin' ? ' is-active' : '')}
            onClick={() => {
              setDrawIsTemp(true);
              switchToolMode('droppin');
            }}
            disabled={!canCreateTrack}
            data-pasture-field-draw="1"
          >
            <span className="pm-field-tool-ic" aria-hidden="true">
              &#9998;
            </span>
            <span>Draw paddock</span>
          </button>
          <button
            type="button"
            className={'pm-field-tool' + (measuring ? ' is-active' : '')}
            onClick={() => switchToolMode('measure')}
            data-pasture-field-measure="1"
          >
            <span className="pm-field-tool-ic" aria-hidden="true">
              &#128207;
            </span>
            <span>Measure</span>
          </button>
          <button
            type="button"
            className={'pm-field-tool' + (fieldLayersOpen ? ' is-active' : '')}
            onClick={() => setFieldLayersOpen((v) => !v)}
            data-pasture-field-layers="1"
          >
            <span className="pm-field-tool-ic" aria-hidden="true">
              &#9636;
            </span>
            <span>Layers</span>
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
          {/* All pasture roles (incl. Light, now farm_team-level) see every tab. */}
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
      <main
        className={
          'pm-layout' +
          (appMode === 'field' ? ' is-field' : '') +
          // Mobile bottom-sheet only when an area is selected (its inspector); with no
          // selection the Map panel stacks below the map so areas stay tappable.
          (appMode === 'view' && selectedId ? ' is-plan' : '') +
          (appMode === 'reports' ? ' is-reports' : '')
        }
      >
        {/* trackGeometry={activeTrackGeometry} */}
        {/* Reports is a separate read/report surface: it renders NO map column,
            map controls, move controls, or canvas — just the full-width reports. */}
        {appMode === 'reports' ? (
          <section className="pm-reports-col" data-pasture-reports-col="1">
            {loading ? <div className="pm-card">Loading pasture map...</div> : renderReportsPanel()}
          </section>
        ) : (
          <>
            <section className="pm-map-col">
              {renderPastureMapCanvas({
                areas,
                occupants: occupantsByArea,
                mode: mapMode,
                canWrite: appMode === 'field' ? canCreateTrack : isManager,
                editAreaId: mapMode === 'edit' ? selectedId : null,
                selectedId,
                onSelect: handleAreaClick,
                onDrawComplete,
                onEditGeometry,
                trackGeometry: activeTrackGeometry,
                rotationPaths: appMode === 'view' ? rotationPaths : [],
                nextStopOnly,
                showRotationPath,
                previewAreaId: appMode === 'view' ? previewAreaId : null,
                legendOpen,
                onToggleLegend: () => setLegendOpen((v) => !v),
                mapBanner,
                zoomSignal,
                boundaryFilter,
                onToggleBoundary: toggleBoundary,
                appMode,
                isTouch,
                measurements,
                onSaveMeasurement,
                online,
                fieldLayersOpen,
                draftLinesVisible,
                onToggleDraftLines: toggleDraftLines,
                onExitTool: () => switchToolMode('select'),
              })}
              {renderFieldChrome()}
            </section>
            <aside className="pm-side-panel">
              {loading ? <div className="pm-card">Loading pasture map...</div> : renderPanel()}
            </aside>
          </>
        )}
      </main>
      <div className="pm-hidden-compat">
        <span data-mode="select" />
        <span data-pasture-style-weight="1" />
        <span>trackGeometry={'{activeTrackGeometry}'}</span>
      </div>
    </div>
  );
}
