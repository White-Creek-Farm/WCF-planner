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
import PastureAreaModal from './PastureAreaModal.jsx';
import DataTable from '../shared/DataTable.jsx';
import {openableProps} from '../shared/openable.js';
import {parseKmlToPlacemarks, closeOutlineToPolygon} from '../lib/pastureKml.js';
import {haversineM, lineMetrics} from '../lib/pastureGeometry.js';
import {
  listLandAreas,
  importLandAreaBatch,
  updateLandArea,
  closeLandAreaOutline,
  deleteLandArea,
  createLandArea,
  createLandAreaTrack,
  updateLandAreaGeometry,
  updateLandAreaTrack,
  updateLandAreaStyle,
  listPastureMoves,
  recordPastureMove,
  listPastureHistoryReport,
  deletePastureMove,
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
} from '../lib/pastureMapApi.js';
import {
  cachePastureSnapshot,
  classifyPastureOfflineError,
  discardPastureOperation,
  enqueuePastureOperation,
  ensurePersistentStorage,
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
const AREA_MODAL_CLOSE_DEBOUNCE_MS = 180;
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
  {id: 'view', label: 'Map', hint: 'Groups, moves, rotation, and boundary tools'},
  {id: 'field', label: 'Field', hint: 'Phone-first execution'},
  {id: 'reports', label: 'Reports', hint: 'Reports stay out of the planning flow'},
];

function renderPastureMapCanvas(props) {
  return React.createElement(PastureMapCanvas, props);
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

function localDateTimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
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
  // Rest-tracking only. Grazing recency ("last grazed") lives in the Grazing
  // History card, not here, so the merged record doesn't repeat it.
  const facts = [];
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

// A saved Track / Line carries an editable LineString in raw_geometry (no polygon
// version). Open-line edit (mig 150) reshapes that line in place.
function hasLineGeom(a) {
  if (!a) return false;
  const rg = a.raw_geometry;
  return !!(rg && (rg.type === 'LineString' || rg.type === 'MultiLineString'));
}

function groupSizeCount(group) {
  const direct = Number(group && group.count);
  if (Number.isFinite(direct) && direct > 0) return direct;
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

function speciesFromAnimalType(t) {
  if (t === 'sheep_flock') return 'sheep';
  if (t === 'breeder_pigs' || t === 'feeder_pigs') return 'pig';
  return 'cattle';
}

function groupIdentityKey(group) {
  if (!group) return '';
  return `${groupAnimalType(group)}::${group.groupKey || group.id}`;
}

function historyGroupId(animalType, groupKey) {
  return `history-${String(animalType || 'animals').replace(/[^a-z0-9_-]/gi, '-')}-${String(
    groupKey || 'group',
  ).replace(/[^a-z0-9_-]/gi, '-')}`;
}

function roundOne(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function fmtMetric(value, suffix = '') {
  const n = roundOne(value);
  if (n == null) return 'Unknown';
  return `${n.toLocaleString()}${suffix}`;
}

function fmtHeadCount(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString() : 'Unknown';
}

function shortGroupCode(label) {
  const words = String(label || '')
    .replace(/[^A-Za-z0-9 ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const fromWords = words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  if (fromWords) return fromWords.slice(0, 3);
  return 'G';
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
    const weightLbs = roundOne(ev.total_weight_lbs);
    const lbsPerAcre = weightLbs != null && hasAcres ? Math.round((weightLbs / acreVal) * 10) / 10 : null;
    stays.push({
      id: ev.id,
      groupLabel: ev.group_label,
      animalType: ev.animal_type,
      headCount,
      areaName: ev.to_land_area_name,
      acres: hasAcres ? acreVal : null,
      inAt: ev.moved_at,
      outAt: exit ? exit.moved_at : null,
      stillHere: !exit,
      days,
      density,
      animalDays,
      weightLbs,
      lbsPerAcre,
      notes: ev.notes || '',
    });
  }
  return stays.reverse(); // newest first
}

function buildGroupGrazingStays(group, history, areaById) {
  const animalType = groupAnimalType(group);
  const groupKey = group && (group.groupKey || group.id);
  const asc = (history || [])
    .filter((h) => h && h.moved_at && h.animal_type === animalType && h.group_key === groupKey)
    .slice()
    .sort((a, b) => {
      const timeDiff = new Date(a.moved_at) - new Date(b.moved_at);
      if (timeDiff) return timeDiff;
      return new Date(a.created_at || a.moved_at) - new Date(b.created_at || b.moved_at);
    });
  const nowMs = Date.now();
  const stays = [];
  for (let i = 0; i < asc.length; i++) {
    const ev = asc[i];
    if (!ev.to_land_area_id) continue;
    let exit = null;
    for (let j = i + 1; j < asc.length; j++) {
      const nx = asc[j];
      if (nx.id === ev.id) continue;
      exit = nx;
      break;
    }
    const area = areaById.get(ev.to_land_area_id) || null;
    const acres = area ? Number(area.effective_acres) : Number(ev.to_land_area_acres);
    const hasAcres = Number.isFinite(acres) && acres > 0;
    const inMs = new Date(ev.moved_at).getTime();
    const endMs = exit ? new Date(exit.moved_at).getTime() : nowMs;
    const days =
      Number.isFinite(inMs) && Number.isFinite(endMs) && endMs >= inMs
        ? Math.round(((endMs - inMs) / 86400000) * 10) / 10
        : null;
    const count = Number.parseInt(ev.animal_count, 10);
    const headCount = Number.isFinite(count) && count > 0 ? count : null;
    const density = headCount != null && hasAcres ? Math.round((headCount / acres) * 100) / 100 : null;
    const animalDays = headCount != null && days != null ? Math.round(headCount * days) : null;
    const weightLbs = roundOne(ev.total_weight_lbs);
    const lbsPerAcre = weightLbs != null && hasAcres ? Math.round((weightLbs / acres) * 10) / 10 : null;
    stays.push({
      id: ev.id,
      areaId: ev.to_land_area_id,
      areaName: ev.to_land_area_name || (area && area.name) || 'Unknown area',
      groupLabel: ev.group_label || (group && group.name),
      animalType: ev.animal_type,
      headCount,
      acres: hasAcres ? acres : null,
      inAt: ev.moved_at,
      outAt: exit ? exit.moved_at : null,
      stillHere: !exit,
      days,
      density,
      animalDays,
      weightLbs,
      lbsPerAcre,
      notes: ev.notes || '',
    });
  }
  return stays.reverse();
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

// Shared, explicit area-name editor used by BOTH the Map area modal and the
// Reports area record (one canonical control, two shells). Replaces the old
// blur-only save: a pencil/Edit affordance opens a controlled input with Save +
// Cancel, Enter saves, Escape cancels, and a visible saving/saved/error state.
// onSave(name) must resolve on success and REJECT on failure so the editor can
// show its own status. Gated by canEdit (management/admin, or farm_team+ for temp).
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function AreaNameEditor({area, canEdit, onSave, trailing = null}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(area.name || '');
  const [status, setStatus] = React.useState('idle'); // idle | saving | saved | error
  const [error, setError] = React.useState(null);
  const inputRef = React.useRef(null);

  React.useEffect(() => {
    if (!editing) setValue(area.name || '');
  }, [area.id, area.name, editing]);

  React.useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function startEdit() {
    setValue(area.name || '');
    setError(null);
    setStatus('idle');
    setEditing(true);
  }
  function cancel() {
    setEditing(false);
    setError(null);
    setStatus('idle');
    setValue(area.name || '');
  }
  async function save() {
    const next = value.trim();
    if (!next) {
      setError('Name is required');
      setStatus('error');
      return;
    }
    if (next === (area.name || '')) {
      cancel();
      return;
    }
    setStatus('saving');
    setError(null);
    try {
      await onSave(next);
      setStatus('saved');
      setEditing(false);
    } catch (e) {
      setError((e && e.message) || 'Save failed');
      setStatus('error');
    }
  }

  if (!editing) {
    return (
      <div className="pm-name-edit" data-pasture-area-name-edit={area.id}>
        <span className="pm-name-edit-value">{area.name || 'Unnamed area'}</span>
        {trailing}
        {canEdit && (
          <button
            type="button"
            className="pm-name-edit-btn"
            onClick={startEdit}
            aria-label="Edit area name"
            title="Edit name"
            data-pasture-area-name-edit-start={area.id}
          >
            <span aria-hidden="true">✎</span> Edit
          </button>
        )}
        {status === 'saved' && (
          <span className="pm-name-edit-status is-saved" role="status">
            Saved
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="pm-name-edit is-editing" data-pasture-area-name-edit={area.id}>
      <input
        ref={inputRef}
        className="pm-name-edit-input"
        value={value}
        disabled={status === 'saving'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation(); // cancel the edit, do not close the host modal
            cancel();
          }
        }}
        aria-label="Area name"
        data-pasture-area-name-input={area.id}
      />
      <button
        type="button"
        className="pm-btn pm-btn-sm pm-btn-primary"
        onClick={save}
        disabled={status === 'saving'}
        data-pasture-area-name-save={area.id}
      >
        {status === 'saving' ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        className="pm-btn pm-btn-sm"
        onClick={cancel}
        disabled={status === 'saving'}
        data-pasture-area-name-cancel={area.id}
      >
        Cancel
      </button>
      {status === 'error' && (
        <span className="pm-name-edit-status is-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
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
  const [allHistory, setAllHistory] = React.useState([]);
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
  const [areaModalCloseSaving, setAreaModalCloseSaving] = React.useState(false);
  const areaModalCloseRef = React.useRef({timer: null, running: false});
  const [legendOpen, setLegendOpen] = React.useState(false);
  const [addMode, setAddMode] = React.useState(false);
  // Reports = every-area grazing records: the area list, the drilled-in area, and
  // that area's lazily-loaded move history (the source for its grazing timeline).
  const [reportAreaId, setReportAreaId] = React.useState(null);
  const [reportGroupId, setReportGroupId] = React.useState(null);
  const [includeInactiveGroups, setIncludeInactiveGroups] = React.useState(false);
  const [reportHistory, setReportHistory] = React.useState([]);
  const [reportHistoryLoading, setReportHistoryLoading] = React.useState(false);
  const [selectedGroupId, setSelectedGroupId] = React.useState(null);
  const [groupRecordHistory, setGroupRecordHistory] = React.useState([]);
  const [groupRecordLoading, setGroupRecordLoading] = React.useState(false);
  const [groupRecordError, setGroupRecordError] = React.useState('');
  const [groupMoveAt, setGroupMoveAt] = React.useState(() => localDateTimeValue());
  const [zoomSignal, setZoomSignal] = React.useState(0);
  const [styleDraft, setStyleDraft] = React.useState(() => styleDraftFromArea(null));
  const [confirmDeleteId, setConfirmDeleteId] = React.useState(null);
  const [confirmDeleteStayId, setConfirmDeleteStayId] = React.useState(null);
  const [historyReloadSignal, setHistoryReloadSignal] = React.useState(0);
  const [confirmPromoteId, setConfirmPromoteId] = React.useState(null);
  const [boundaryFilter, setBoundaryFilter] = React.useState({pasture: true, paddock: true, temp: true, line: true});
  const [draftLinesVisible, setDraftLinesVisible] = React.useState(false);
  const [drawIsTemp, setDrawIsTemp] = React.useState(false);
  const [drawForm, setDrawForm] = React.useState(null);
  const [editGeom, setEditGeom] = React.useState(null);
  const [track, setTrack] = React.useState(() => initialTrackState());
  const [trackForm, setTrackForm] = React.useState(null);
  const [saving, setSaving] = React.useState(false);
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
  const groups = React.useMemo(
    () => roster.groups.map((g) => ({...g, active: true, size: `${g.count} ${g.unit}`})),
    [roster],
  );
  const [serverRotations, setServerRotations] = React.useState([]);
  const [measurements, setMeasurements] = React.useState([]);
  const [measureForm, setMeasureForm] = React.useState(null);
  const [imageryStatus, setImageryStatus] = React.useState({state: 'missing'});
  const [imageryProgress, setImageryProgress] = React.useState(null);
  const [activeGroupId, setActiveGroupId] = React.useState(null);
  const [online, setOnline] = React.useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  // Secondary Field affordances, kept off the recurring Walk/Draw/Measure toolbar.
  // Offline setup holds one-time offline imagery + field guide; Saved measurements
  // surfaces the saved-distance list outside the Measure tool's flow.
  const [offlineSetupOpen, setOfflineSetupOpen] = React.useState(false);
  const [savedMeasuresOpen, setSavedMeasuresOpen] = React.useState(false);
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
      const [areaRes, moveRes, historyRes, rotRes, measRes] = await Promise.all([
        listLandAreas(false),
        listPastureMoves(75),
        canViewPlanning ? listPastureHistoryReport({limit: 1000}) : Promise.resolve({history: []}),
        canViewPlanning ? listPastureRotations() : Promise.resolve({rotations: []}),
        canViewPlanning ? listPastureMeasurements() : Promise.resolve({measurements: []}),
      ]);
      const nextAreas = (areaRes && areaRes.land_areas) || [];
      const nextMoves = (moveRes && moveRes.moves) || [];
      const nextHistory = (historyRes && historyRes.history) || [];
      const nextRotations = (rotRes && rotRes.rotations) || [];
      setAreas(nextAreas);
      setMoves(nextMoves);
      setAllHistory(nextHistory);
      setServerRotations(nextRotations);
      setMeasurements((measRes && measRes.measurements) || []);
      cachePastureSnapshot({
        areas: nextAreas,
        moves: nextMoves,
        history: nextHistory,
        rotations: nextRotations,
      });
      setOfflineStatus('');
      await refreshQueueState();
    } catch (e) {
      const cached = loadPastureSnapshot();
      if (cached) {
        setAreas(cached.areas || []);
        setMoves(cached.moves || []);
        setAllHistory(cached.history || []);
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

  // Best-effort: keep the offline pasture snapshot/queue from being evicted in the
  // field. Silent and browser-gated; no UI is shown on a denial.
  React.useEffect(() => {
    ensurePersistentStorage();
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

  // Load the open area's full move history (the grazing-timeline source) for the
  // canonical Area Record, in EITHER shell: the Map area modal or the Reports
  // record both key off the selected area. Same farm_team+/light read gate.
  React.useEffect(() => {
    let alive = true;
    if (!selectedId || !canViewPlanning) {
      setReportHistory([]);
      setReportHistoryLoading(false);
      return () => {
        alive = false;
      };
    }
    setReportHistoryLoading(true);
    listPastureHistoryReport({landAreaId: selectedId, limit: 500})
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
  }, [selectedId, canViewPlanning, moves.length, historyReloadSignal]);

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
  const historicalGroups = React.useMemo(() => {
    const activeKeys = new Set(groups.map(groupIdentityKey));
    const seen = new Set();
    const out = [];
    for (const row of allHistory || []) {
      if (!row || !row.animal_type || !row.group_key) continue;
      const key = `${row.animal_type}::${row.group_key}`;
      if (activeKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      const species = speciesFromAnimalType(row.animal_type);
      const label = row.group_label || `${animalTypeLabel(row.animal_type)} ${row.group_key}`;
      out.push({
        id: historyGroupId(row.animal_type, row.group_key),
        active: false,
        species,
        name: label,
        short: shortGroupCode(label),
        count: null,
        unit: 'head',
        size: 'Inactive',
        animalType: row.animal_type,
        groupKey: row.group_key,
        totalWeightLbs: null,
      });
    }
    return out;
  }, [allHistory, groups]);
  const allRecordGroups = React.useMemo(() => [...groups, ...historicalGroups], [groups, historicalGroups]);
  const recordGroupById = React.useMemo(() => {
    const m = new Map();
    for (const group of allRecordGroups) m.set(group.id, group);
    return m;
  }, [allRecordGroups]);
  const selectedRecordGroup = selectedGroupId ? recordGroupById.get(selectedGroupId) || null : null;
  const reportRecordGroup = reportGroupId ? recordGroupById.get(reportGroupId) || null : null;
  const recordGroupLocation = React.useMemo(() => {
    const out = {};
    const rows = allHistory && allHistory.length ? allHistory : moves;
    for (const g of allRecordGroups) {
      const mv = rows.find((m) => m.animal_type === groupAnimalType(g) && m.group_key === (g.groupKey || g.id));
      out[g.id] =
        mv && mv.to_land_area_id
          ? {areaId: mv.to_land_area_id, areaName: mv.to_land_area_name, movedAt: mv.moved_at}
          : null;
    }
    return out;
  }, [allRecordGroups, allHistory, moves]);
  const openRecordGroup = selectedRecordGroup || reportRecordGroup || null;

  React.useEffect(() => {
    let alive = true;
    if (!openRecordGroup || !canViewPlanning) {
      setGroupRecordHistory([]);
      setGroupRecordLoading(false);
      setGroupRecordError('');
      return () => {
        alive = false;
      };
    }
    setGroupRecordLoading(true);
    setGroupRecordError('');
    listPastureHistoryReport({
      animalType: groupAnimalType(openRecordGroup),
      groupKey: openRecordGroup.groupKey || openRecordGroup.id,
      limit: 500,
    })
      .then((res) => {
        if (alive) setGroupRecordHistory((res && res.history) || []);
      })
      .catch((e) => {
        if (alive) setGroupRecordError(e.message || 'Could not load the group grazing record.');
      })
      .finally(() => {
        if (alive) setGroupRecordLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [openRecordGroup, canViewPlanning, historyReloadSignal, moves.length]);
  function rotationIdsForGroup(group) {
    if (!group) return [];
    const ids = serverRotationByKey.get(groupIdentityKey(group)) || rotations[group.id] || [];
    return ids.filter((id) => areaById.has(id));
  }

  function locationForGroup(group) {
    if (!group) return null;
    return recordGroupLocation[group.id] || groupLocation[group.id] || null;
  }

  function currentAreaForGroup(group) {
    const loc = locationForGroup(group);
    if (!loc || !loc.areaId) return null;
    return areaById.get(loc.areaId) || {id: loc.areaId, name: loc.areaName};
  }

  function nextAreaForGroup(group) {
    const rotation = rotationIdsForGroup(group);
    const current = currentAreaForGroup(group);
    if (!rotation.length) return null;
    if (current && rotation.includes(current.id))
      return areaById.get(rotation[rotation.indexOf(current.id) + 1]) || null;
    return areaById.get(rotation[0]) || null;
  }

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
  // Parent-pasture assignment: permanent paddocks live UNDER a permanent pasture
  // (land_areas.parent_id). Eligible parents are the permanent pastures (never a
  // temp paddock, never the area itself). update_land_area validates existence,
  // self-parenting and cycles server-side; this list just scopes the picker.
  const parentPastureOptions = React.useMemo(
    () =>
      activeAreas
        .filter((a) => a.kind === 'pasture' && a.permanence !== 'temporary')
        .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [activeAreas],
  );
  // A reviewed PERMANENT paddock must carry a parent pasture. Parentless permanent
  // paddocks are surfaced in Reports under "Needs pasture assignment" until fixed;
  // we never auto-backfill a parent.
  function isPermanentPaddock(a) {
    return !!a && a.kind === 'paddock' && a.permanence !== 'temporary';
  }
  function needsParentAssignment(a) {
    return isPermanentPaddock(a) && !a.parent_id;
  }
  // Reports area list: every real area (incl. archived/retired) except draft Tracks /
  // Lines (setupAreas already applies that filter), grouped so pastures and feeder-pig
  // areas carry their child paddocks nested (parent_id), with temp paddocks and
  // everything else in their own sections.
  // Reports accordion model: pastures carry their child paddocks (parent_id) so a
  // pasture row collapses to hide them; permanent paddocks with NO parent are split
  // out into a "Needs pasture assignment" review group. Archived areas and draft
  // Tracks / Lines stay reachable in their own collapsed sections (rendered from
  // archivedAreas / trackLineAreas). Active, non-retired, non-outline only here.
  const reportGroups = React.useMemo(() => {
    const byName = (a, b) => (a.name || '').localeCompare(b.name || '');
    const active = setupAreas.filter((a) => a.status !== 'retired').sort(byName);
    const childrenOf = (id) => active.filter((a) => a.parent_id === id);
    const used = new Set();
    const take = (list) => {
      const out = [];
      list.forEach((a) => {
        if (used.has(a.id)) return;
        used.add(a.id);
        out.push(a);
      });
      return out;
    };
    const withChildren = (parents) =>
      take(parents).map((p) => {
        const children = childrenOf(p.id);
        children.forEach((c) => used.add(c.id));
        return {area: p, children};
      });
    const pastures = withChildren(active.filter((a) => a.kind === 'pasture' && a.permanence !== 'temporary'));
    const needsPasture = take(
      active.filter((a) => a.kind === 'paddock' && a.permanence !== 'temporary' && !a.parent_id),
    );
    const feeders = withChildren(active.filter((a) => a.kind === 'feeder_pig_area'));
    const temp = take(active.filter((a) => a.permanence === 'temporary'));
    const other = take(active);
    return {pastures, needsPasture, feeders, temp, other};
  }, [setupAreas]);
  const reportArea = reportAreaId ? areaById.get(reportAreaId) || null : null;
  // Canonical Area Record (Map modal + Reports record) keys off the open/selected
  // area; its move history loads into reportHistory for whichever shell is open.
  const recordStays = React.useMemo(
    () => (selectedArea ? buildGrazingStays(selectedArea.id, reportHistory, selectedArea.effective_acres) : []),
    [selectedArea, reportHistory],
  );
  const recordTotals = React.useMemo(() => grazingRecordTotals(recordStays), [recordStays]);
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
    if (selectedGroupId || reportGroupId) setGroupMoveAt(localDateTimeValue());
  }, [selectedGroupId, reportGroupId]);

  React.useEffect(() => {
    setStyleDraft(styleDraftFromArea(selectedArea));
  }, [selectedArea]);

  React.useEffect(
    () => () => {
      if (areaModalCloseRef.current.timer) clearTimeout(areaModalCloseRef.current.timer);
    },
    [],
  );

  // Escape: exit an active map tool (draw/edit/measure/track) if one is running,
  // otherwise clear the current selection + any open inline confirms. The tool
  // switch also clears the tool's transient layer/HUD (see switchToolMode).
  const escStateRef = React.useRef({mapMode});
  escStateRef.current = {mapMode};
  React.useEffect(() => {
    function onKey(e) {
      if (e.defaultPrevented) return;
      if (e.key !== 'Escape') return;
      if (['draw', 'edit', 'measure', 'track', 'droppin'].includes(escStateRef.current.mapMode)) {
        switchToolMode('select');
        return;
      }
      setSelectedId(null);
      setSelectedGroupId(null);
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
    if (next !== 'reports') {
      setReportAreaId(null);
      setReportGroupId(null);
    }
    if (next !== 'view') setSelectedGroupId(null);
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

  // Open-line edit: reshape a saved Track / Line (outline candidate) in place.
  // Separate entry from startEdit (which is polygon-only) because lines have no
  // polygon version and save through the line RPC, not the boundary RPC.
  function startEditLine(a) {
    if (!a || !isOutlineCandidateArea(a) || !hasLineGeom(a)) {
      setErr('Select a Track / Line with a saved line, then use Edit line.');
      return;
    }
    setErr('');
    setEditGeom(null);
    setSelectedId(a.id);
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

  const removeArea = (a) => withBusy(a.id, () => deleteLandArea(a.id));
  const saveAreaPatch = (a, fields) => withBusy(a.id, () => updateLandArea(a.id, fields));

  // Inline name save for AreaNameEditor (Map modal + Reports record). Unlike
  // withBusy it RE-THROWS on failure so the editor can show its own error state;
  // it still sets busy + reload()s on success so the new name appears everywhere.
  async function saveAreaName(a, name) {
    setBusyId(a.id);
    setErr('');
    try {
      if (a.permanence === 'temporary') await renameTempLandArea(a.id, name);
      else await updateLandArea(a.id, {name});
      await reload();
    } finally {
      setBusyId(null);
    }
  }

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
    // Permanent paddock: it must sit UNDER a parent pasture to be reviewed. When a
    // parent is already assigned we mark it reviewed; otherwise we classify it but
    // leave review pending so it surfaces under "Needs pasture assignment" until a
    // parent is chosen (no auto-backfill).
    return withBusy(a.id, () =>
      updateLandArea(a.id, {
        kind: 'paddock',
        permanence: 'permanent',
        ...(a.parent_id ? {reviewStatus: 'reviewed'} : {}),
      }),
    );
  }
  // Assign / clear the parent pasture for a paddock. update_land_area validates
  // existence, self-parenting and cycles; an empty selection clears the parent.
  const assignParent = (a, parentId) => saveAreaPatch(a, parentId ? {parentId} : {clearParent: true});
  // Mark an area reviewed from the Area modal. A permanent paddock MUST have a
  // parent pasture first: we block the review (never silently save an orphan
  // paddock) and surface the reason inline.
  function saveAreaReview(a) {
    if (needsParentAssignment(a)) {
      setErr('Assign a parent pasture before saving this paddock.');
      return undefined;
    }
    return saveAreaPatch(a, {reviewStatus: 'reviewed'});
  }
  function closeAreaModal() {
    const area = selectedArea;
    if (!area || areaModalCloseRef.current.running) return;
    if (areaModalCloseRef.current.timer) clearTimeout(areaModalCloseRef.current.timer);
    areaModalCloseRef.current.timer = setTimeout(async () => {
      areaModalCloseRef.current.timer = null;
      if (areaModalCloseRef.current.running) return;
      areaModalCloseRef.current.running = true;
      setAreaModalCloseSaving(true);
      try {
        if (isManager && area.review_status !== 'reviewed') {
          const result = saveAreaReview(area);
          if (result === undefined) return;
          await result;
        }
        setSelectedId(null);
      } finally {
        areaModalCloseRef.current.running = false;
        setAreaModalCloseSaving(false);
      }
    }, AREA_MODAL_CLOSE_DEBOUNCE_MS);
  }
  // Open the Area modal for an area from anywhere (map click, Reports review rows,
  // classification queue): focus the Map tab in select mode and select it.
  function openAreaModal(areaId) {
    setAppMode('view');
    setMapMode('select');
    setAddMode(false);
    setReportAreaId(null);
    setSelectedId(areaId);
  }
  // Open the canonical Area Record in the Reports shell. Sets selectedId so the
  // shared record body (built around the selected area) renders in Reports too,
  // exactly as it does inside the Map area modal.
  function openAreaRecord(areaId) {
    setReportGroupId(null);
    setReportAreaId(areaId);
    setSelectedId(areaId);
  }
  function closeAreaRecord() {
    setReportAreaId(null);
    setSelectedId(null);
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
  function confirmHardDelete(a) {
    setConfirmDeleteId(null);
    return withBusy(a.id, () => hardDeleteLandArea(a.id));
  }

  // Management/admin per-entry grazing delete (mig 147): remove ONE grazing stay,
  // which is the move-IN pasture_move_events row (stay.id from buildGrazingStays).
  // Its impacts cascade and all area state re-derives; reload() refreshes the Map
  // fills + Farm status and the signal re-pulls the open Reports timeline.
  async function deleteGrazingStay(stay) {
    if (!stay || !stay.id) return;
    setConfirmDeleteStayId(null);
    setBusyId(stay.id);
    setErr('');
    try {
      await deletePastureMove(stay.id);
      await reload();
      setHistoryReloadSignal((n) => n + 1);
    } catch (e) {
      setErr(e.message || 'Could not delete this grazing entry.');
    } finally {
      setBusyId(null);
    }
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

  // Standalone, self-contained offline field guide (public/pasture-map-field-guide.html).
  // Opening it once while online lets the service worker runtime-cache it for no-signal
  // field reference. It is product help, not a move/draw control, so it is a plain link.
  function renderFieldGuide() {
    return (
      <div className="pm-card" data-pasture-field-guide="1">
        <div className="pm-card-head">
          <div className="pm-card-title">Field guide</div>
        </div>
        <p className="pm-imagery-note">
          How-to for the phone map: my location, walk/draw a paddock, measure, and offline imagery. Open it once with
          signal and it stays available offline.
        </p>
        <a
          className="pm-btn pm-btn-primary"
          href="/pasture-map-field-guide.html"
          target="_blank"
          rel="noopener noreferrer"
          data-pasture-field-guide-link="1"
        >
          Open field guide
        </a>
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
    if (selectedArea && isOutlineCandidateArea(selectedArea) && editGeom.metrics && editGeom.metrics.valid === false)
      return setErr('A Track / Line needs at least two points.');
    setSaving(true);
    setErr('');
    try {
      // Saved Tracks / Lines reshape through the line RPC (no acreage, no version,
      // no promotion); temp paddocks redraw through the owner-or-manager temp RPC;
      // permanent areas through the mgmt/admin boundary RPC.
      if (selectedArea && isOutlineCandidateArea(selectedArea))
        await updateLandAreaTrack(selectedId, editGeom.geometry);
      else if (selectedArea && selectedArea.permanence === 'temporary')
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

  async function recordGroupMove(group, areaId, movedAtValue = groupMoveAt) {
    // Hard write-gate: only farm_team/management/admin record moves. Light and any
    // other non-writer can never trigger a move (UI also hides the controls; the
    // SECDEF RPC rejects non-writers server-side too).
    if (!canRecordMoves) return;
    if (!group || !areaId) return;
    const movedDate = new Date(movedAtValue);
    if (Number.isNaN(movedDate.getTime())) return setErr('Move date/time is required.');
    const movePayload = {
      moveId: newPastureMoveId(),
      animalType: groupAnimalType(group),
      groupKey: group.groupKey || group.id,
      groupLabel: group.name,
      toLandAreaId: areaId,
      movedAt: movedDate.toISOString(),
      animalCount: groupSizeCount(group),
      totalWeightLbs: group.totalWeightLbs || null,
      notes: null,
    };
    setSaving(true);
    setErr('');
    try {
      await recordPastureMove(movePayload);
      await reload();
      setGroupMoveAt(localDateTimeValue());
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'transient') {
        await enqueuePastureOperation({id: movePayload.moveId, op: 'record_move', payload: movePayload});
        await refreshQueueState();
        setOfflineStatus('Move saved on this device and will sync when the connection returns.');
        setGroupMoveAt(localDateTimeValue());
      } else setErr(e.message || 'Could not record pasture move.');
    } finally {
      setSaving(false);
    }
  }

  function setActiveGroupFromGroup(group) {
    // Move/plan forms were removed from the Area modal, so switching the active
    // group no longer primes a form — it just selects the group for the side panel.
    setActiveGroupId(group.id);
  }

  function openGroupRecord(group, source = 'map') {
    if (!group) return;
    if (group.active !== false) setActiveGroupFromGroup(group);
    setSelectedId(null);
    setErr('');
    if (source === 'reports') {
      setReportAreaId(null);
      setReportGroupId(group.id);
    } else {
      setSelectedGroupId(group.id);
    }
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
            {saving ? 'Saving...' : isOutlineCandidateArea(selectedArea) ? 'Save line' : 'Save boundary'}
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

  // Combined Area section: the read-only detail (name, state, acres, occupancy,
  // rest facts) AND the management controls (classification, parent, redraw,
  // archive) in ONE card. "Type" is dropped because the Classification control
  // already names it; the name shows once, with its inline editor for managers.
  function renderAreaSummary() {
    const area = selectedArea;
    if (!area) return null;
    const state = grazingState(area);
    const isTemp = area.permanence === 'temporary';
    const canManageArea = isTemp ? canRecordMoves : isManager;
    const lockedStyle = isManager && isFixedStyleArea(area);
    const occupants = occupantsByArea[area.id] || [];
    return (
      <div className={'pm-selected-panel pm-area-summary state-' + state} data-pasture-selected-panel="1">
        <div className="pm-selected-stripe" />
        <div className="pm-selected-head">
          <div className="pm-area-summary-id">
            <div className="pm-kicker">Area</div>
            {isManager ? (
              <AreaNameEditor area={area} canEdit={canManageArea} onSave={(name) => saveAreaName(area, name)} />
            ) : (
              <div className="pm-selected-title">{area.name || 'Unnamed'}</div>
            )}
          </div>
          <span className={'pm-state-badge state-' + state}>{statusLabelForState(state)}</span>
        </div>
        <div className="pm-area-detail-chips" data-pasture-area-detail={area.id}>
          <span className={'pm-chip pm-chip-' + area.kind}>{designationLabel(area)}</span>
          {isTemp && <span className="pm-chip pm-chip-temp">Temp</span>}
          {isArchivedArea(area) && <span className="pm-chip">{isTemp ? 'Archived temp' : 'Archived'}</span>}
        </div>
        {occupants.length > 0 && (
          <div className="pm-occupants" data-pasture-occupancy={area.id}>
            {/* Occupant identity + count come from the roster-matched group when
                available (same source as the map marker + the locked move-form
                count); unmatched ledger rows and overlap-only occupancy are
                tagged, never shown as a fresh/real group. */}
            {occupants.map((o, i) => (
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
        {/* A saved Track / Line is draft geometry with no grazing/rest/acreage —
            those rows are meaningless for it, so show them only for real areas. */}
        {!isOutlineCandidateArea(area) && (
          <>
            <div className="pm-kv">
              <span>State</span>
              <strong data-pasture-rest-state={area.rest_state || 'baseline'}>{restCopy(area)}</strong>
              <span>Acres</span>
              <strong data-pasture-acres-readonly={area.id}>
                {area.effective_acres == null ? '-' : `${area.effective_acres} ac`}
              </strong>
            </div>
            {selectedDensity && (
              <div className="pm-density-line" data-pasture-density="1">
                {selectedDensity}
              </div>
            )}
            <div className="pm-use-facts" data-pasture-use-facts="1">
              {areaFacts(area).map((fact) => (
                <span key={fact}>{fact}</span>
              ))}
            </div>
          </>
        )}
        {isManager && renderAreaManageActions(area)}
        {lockedStyle && (
          <p className="pm-style-locked-note" data-pasture-setup-linestyle-locked="1">
            {area.kind === 'pasture' ? 'Pasture' : 'Paddock'} boundaries use a fixed
            {area.kind === 'pasture' ? ' blue' : ' green'} line and cannot be restyled. Only temp paddocks and GPS field
            tracks have editable line style.
          </p>
        )}
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
    // group rows open the inline record page. Clicking/tapping an area opens the
    // working Area inspector (and the group cockpit stays below).
    const unplacedGroupCount = groups.filter((g) => !groupLocation[g.id]).length;
    const queuedItemCount = (queueState.queuedCount || 0) + (queueState.stuckCount || 0);
    return (
      <>
        <div className="pm-panel-title" data-pasture-map-header="1">
          <span className="pm-kicker">MAP - WHERE THINGS ARE</span>
          <h2>Current groups</h2>
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
    const sections = ['cattle', 'pig', 'sheep']
      .map((species) => {
        const rows = groups.filter((group) => group.species === species);
        return rows.length ? {key: species, label: `${SPECIES[species].label} - ${rows.length}`, rows} : null;
      })
      .filter(Boolean);
    // Launcher list, not a data grid: each group is a shared .hoverable-tile that
    // POPS OUT (lift + shadow) on hover/focus like the Home tiles / Pasture Map
    // button, opening the group record. Tiles (divs) own the lift per the openable
    // affordance contract (lift is for .hoverable-tile, never a <tr>).
    return (
      <div className="pm-card pm-group-table-card pm-tile-card" data-surface="pasture-group-table">
        <div className="pm-card-head">
          <div className="pm-card-title">Animal groups</div>
          <span>{groups.length} groups</span>
        </div>
        {sections.length === 0 ? (
          <div className="pm-tile-empty">No active planner groups yet.</div>
        ) : (
          <div className="pm-tile-list">
            {sections.map((section) => (
              <div key={section.key} className="pm-tile-section" data-pasture-group-section={section.key}>
                <div className="pm-tile-band">{section.label}</div>
                {section.rows.map((group) => {
                  const spec = groupSpeciesStyle(group);
                  const loc = groupLocation[group.id];
                  const timeInArea = loc && loc.movedAt ? formatTimeInArea(loc.movedAt) : null;
                  return (
                    <div
                      key={group.id}
                      className="pm-open-tile pm-group-tile hoverable-tile"
                      style={{'--species-color': spec.color}}
                      data-pasture-group-row={group.groupKey || group.id}
                      data-active={group.id === activeGroupId ? '1' : undefined}
                      {...openableProps(() => openGroupRecord(group))}
                    >
                      <span className="pm-group-avatar">{group.short}</span>
                      <span className="pm-open-tile-main">
                        <span className="pm-open-tile-title">{group.name}</span>
                        <span className="pm-open-tile-sub">
                          {loc ? loc.areaName || 'Placed' : 'Not placed'}
                          {timeInArea ? ` · ${timeInArea}` : ''}
                        </span>
                      </span>
                      <span className="pm-open-tile-metric">
                        <strong>{groupSizeCount(group)?.toLocaleString() || '-'}</strong>
                        <em>head</em>
                      </span>
                      <span className="chev" aria-hidden="true">
                        {'›'}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderRotationEditor(group = activeGroup) {
    const rotation = rotationIdsForGroup(group);
    const currentArea = currentAreaForGroup(group);
    const spec = groupSpeciesStyle(group);
    return (
      <div className="pm-card">
        <div className="pm-card-head">
          <div>
            <div className="pm-card-title">Rotation editor</div>
            <p>Drag to reorder. Add from the map or draw a temp paddock.</p>
          </div>
        </div>
        <div className="pm-rotation-chips" data-pasture-rotation-chips={group ? group.groupKey || group.id : ''}>
          {rotation.map((areaId, index) => {
            const area = areaById.get(areaId);
            if (!area) return null;
            const isNow = !!currentArea && areaId === currentArea.id;
            return (
              <div
                key={areaId}
                className={'pm-rot-chip' + (isNow ? ' is-now' : '')}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => moveRotationStop(group.id, Number(e.dataTransfer.getData('text/plain')), index)}
                style={{'--species-color': spec.color}}
              >
                <span>{index + 1}</span>
                <strong>{area.name || 'Unnamed'}</strong>
                <button type="button" onClick={() => removeFromRotation(group.id, index)} aria-label="Remove stop">
                  x
                </button>
              </div>
            );
          })}
          {!rotation.length && <div className="pm-report-empty">Add areas to build this rotation.</div>}
        </div>
        <div className="pm-plan-tools">
          <button
            type="button"
            className={'pm-btn' + (addMode ? ' pm-btn-primary' : '')}
            onClick={() => {
              if (group && group.active !== false) {
                setActiveGroupFromGroup(group);
                setSelectedGroupId(group.id);
              }
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
              if (group && group.active !== false) {
                setActiveGroupFromGroup(group);
                setSelectedGroupId(group.id);
              }
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

  function renderGroupDetails(group) {
    const loc = locationForGroup(group);
    const current = currentAreaForGroup(group);
    const timeInArea = loc && loc.movedAt ? formatTimeInArea(loc.movedAt) : null;
    const spec = groupSpeciesStyle(group);
    return (
      <div
        className="pm-card pm-group-record-details"
        style={{'--species-color': spec.color, '--species-soft': spec.soft}}
        data-pasture-group-record-details={group.groupKey || group.id}
      >
        <div className="pm-group-record-head">
          <span className="pm-avatar">{group.short}</span>
          <div>
            <h3>{group.name}</h3>
            <p>
              {animalTypeLabel(groupAnimalType(group))} &middot; {group.active === false ? 'Inactive' : group.size}
            </p>
          </div>
        </div>
        <div className="pm-record-facts pm-record-facts-grid">
          <span className="pm-record-fact">
            <b>{fmtHeadCount(group.count)}</b> head
          </span>
          <span className="pm-record-fact">
            <b>{current ? current.name : 'Not placed'}</b> current area
          </span>
          <span className="pm-record-fact">
            <b>{timeInArea || 'Unknown'}</b> time in area
          </span>
          <span className="pm-record-fact">
            <b>{group.totalWeightLbs ? fmtMetric(group.totalWeightLbs, ' lbs') : 'Unknown'}</b> recorded weight
          </span>
        </div>
      </div>
    );
  }

  function renderGroupMoveBox(group) {
    const current = currentAreaForGroup(group);
    const next = nextAreaForGroup(group);
    const rotation = rotationIdsForGroup(group);
    const disabled = !group.active || !canRecordMoves || !next || saving;
    return (
      <div className="pm-card pm-group-move-card" data-pasture-group-move={group.groupKey || group.id}>
        <div className="pm-card-title">Move</div>
        <div className="pm-group-move-grid">
          <div className="pm-group-move-cell">
            <span>Current area</span>
            <strong>{current ? current.name : 'Not placed'}</strong>
            <em>{current ? restCopy(current) : 'Not placed'}</em>
          </div>
          <div className="pm-next-arrow" aria-hidden="true">
            -&gt;
          </div>
          <div className="pm-group-move-cell">
            <span>Next area</span>
            <strong>{next ? next.name : '-'}</strong>
            <em>
              {next && next.rest_days != null
                ? `${next.rest_days}d rested`
                : rotation.length
                  ? 'Rest unknown'
                  : 'Add rotation stops first'}
            </em>
          </div>
        </div>
        <label className="pm-field pm-field-wide">
          <span>Moved at</span>
          <input
            type="datetime-local"
            value={groupMoveAt}
            onChange={(e) => setGroupMoveAt(e.target.value)}
            data-pasture-group-move-at="1"
            disabled={!group.active || !canRecordMoves}
          />
        </label>
        <button
          type="button"
          className="pm-btn pm-btn-primary pm-move-btn"
          onClick={() => recordGroupMove(group, next && next.id, groupMoveAt)}
          disabled={disabled}
          data-pasture-move="1"
        >
          {saving ? 'Saving...' : 'Move'}
        </button>
      </div>
    );
  }

  function renderGroupGrazingHistory(group) {
    const rows = buildGroupGrazingStays(group, groupRecordHistory, areaById);
    const columns = [
      {key: 'areaName', label: 'Area', primary: true},
      {key: 'inAt', label: 'In', render: (stay) => formatMoveTime(stay.inAt)},
      {key: 'outAt', label: 'Out', render: (stay) => (stay.outAt ? formatMoveTime(stay.outAt) : 'Now')},
      {key: 'days', label: 'Days', align: 'right', render: (stay) => fmtMetric(stay.days)},
      {key: 'headCount', label: 'Head', align: 'right', render: (stay) => fmtHeadCount(stay.headCount)},
      {key: 'acres', label: 'Acres', align: 'right', render: (stay) => fmtMetric(stay.acres, ' ac')},
      {key: 'density', label: 'Head/ac', align: 'right', render: (stay) => fmtMetric(stay.density)},
      {
        key: 'animalDays',
        label: 'Animal-days',
        align: 'right',
        render: (stay) => (stay.animalDays != null ? stay.animalDays.toLocaleString() : 'Unknown'),
      },
      {key: 'lbsPerAcre', label: 'Lbs/ac', align: 'right', render: (stay) => fmtMetric(stay.lbsPerAcre)},
      {
        key: 'actions',
        label: '',
        mobilePriority: false,
        render: (stay) =>
          isManager ? (
            <span className="pm-record-stay-actions" data-pasture-report-stay-actions={stay.id}>
              {confirmDeleteStayId === stay.id ? (
                <span className="pm-record-stay-confirm" data-pasture-report-stay-confirm={stay.id}>
                  Delete?
                  <button
                    type="button"
                    className="pm-btn pm-btn-sm pm-btn-danger"
                    onClick={() => deleteGrazingStay(stay)}
                    disabled={busyId === stay.id}
                    data-pasture-report-stay-delete-yes={stay.id}
                  >
                    Delete
                  </button>
                  <button type="button" className="pm-btn pm-btn-sm" onClick={() => setConfirmDeleteStayId(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="pm-btn pm-btn-sm pm-btn-danger"
                  onClick={() => setConfirmDeleteStayId(stay.id)}
                  disabled={busyId === stay.id}
                  data-pasture-report-stay-delete={stay.id}
                >
                  Delete
                </button>
              )}
            </span>
          ) : null,
      },
    ];
    return (
      <div className="pm-card pm-group-grazing-history" data-pasture-group-grazing-history={group.groupKey || group.id}>
        <div className="pm-card-title">Grazing History</div>
        {groupRecordError && <div className="pm-error-inline">{groupRecordError}</div>}
        <DataTable
          surfaceKey="pasture-group-grazing-history"
          rows={rows}
          rowKey="id"
          columns={columns}
          density="compact"
          loading={groupRecordLoading}
          emptyMessage="No grazing stays recorded for this group yet."
        />
      </div>
    );
  }

  function renderGroupRecord(group, source = 'map') {
    if (!group) return null;
    return (
      <>
        <div className="pm-panel-title pm-record-title">
          <button
            type="button"
            className="pm-btn pm-btn-sm"
            onClick={() => (source === 'reports' ? setReportGroupId(null) : setSelectedGroupId(null))}
            data-pasture-group-record-back="1"
          >
            &larr; {source === 'reports' ? 'All records' : 'Groups'}
          </button>
          <span className="pm-kicker">Group record</span>
          <h2>{group.name}</h2>
        </div>
        {renderGroupDetails(group)}
        {group.active === false ? (
          <div className="pm-card pm-report-empty">Inactive groups keep grazing history but cannot be moved.</div>
        ) : (
          <>
            {renderRotationEditor(group)}
            {renderGroupMoveBox(group)}
          </>
        )}
        {renderGroupGrazingHistory(group)}
      </>
    );
  }

  function renderPlanPanel() {
    if (selectedRecordGroup)
      return (
        <>
          {/* A temp paddock drawn from this group's rotation editor must stay
              saveable while the inline group record is open. Without these forms
              the canvas only shows the Cancel banner and the name + Save area
              control is unreachable, so the drawn paddock can never be added. */}
          {renderDrawForm()}
          {renderMeasureForm()}
          {renderGroupRecord(selectedRecordGroup, 'map')}
        </>
      );
    if (!activeGroup)
      return (
        <>
          <div className="pm-card">
            <div className="pm-empty">
              No active planner groups. Add animals in Cattle, Sheep, or Pigs to plan moves.
            </div>
          </div>
        </>
      );
    return (
      <>
        {renderGroupSwitcher()}
        {/* Transient build-tool save forms stay on the Map tab while a tool is
            active so a redraw (launched from the Area modal) or a drawn temp
            paddock (launched from the rotation editor) can be saved. Per-area
            classification / management, Tracks / Lines, the classification queue
            and archived recovery moved to the Area modal and the Reports tab. */}
        {renderTrackPanel()}
        {renderDrawForm()}
        {renderMeasureForm()}
        {renderEditBar()}
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
        {/* Single bottom Import KML entry point (manager-gated, like the import RPC). */}
        {isManager && (
          <button
            type="button"
            className="pm-import-wide"
            onClick={() => fileRef.current && fileRef.current.click()}
            data-pasture-import-kml="1"
          >
            Import OnX KML
          </button>
        )}
      </>
    );
  }

  // Tracks / Lines, the classification queue and archived recovery moved OFF the
  // Map side panel into the Reports tab (renderReportAreaList) as collapsed review
  // sections, each opening the Area modal or its management action there.

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
      <div className="pm-area-manage" data-pasture-area-manage={area.id} data-kind={area.kind}>
        {isOutline ? (
          <div className="pm-field" data-pasture-designation-line={area.id}>
            <span>Draft line</span>
            <div className="pm-temp-designation">
              <span className="pm-chip pm-chip-outline_candidate">Track / line</span>
              <button
                type="button"
                className="pm-btn pm-btn-sm"
                onClick={() => startEditLine(area)}
                disabled={!isManager || busyId === area.id || !hasLineGeom(area)}
                data-pasture-edit-line={area.id}
              >
                Edit line
              </button>
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
        {isPermanentPaddock(area) && (
          <label className="pm-field">
            <span>Parent pasture</span>
            <select
              value={area.parent_id || ''}
              disabled={!isManager}
              onChange={(e) => assignParent(area, e.target.value || null)}
              data-pasture-area-parent-select={area.id}
            >
              <option value="">No parent pasture</option>
              {parentPastureOptions
                .filter((p) => p.id !== area.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || 'Unnamed pasture'}
                  </option>
                ))}
            </select>
          </label>
        )}
        {needsParentAssignment(area) && (
          <div className="pm-needs-parent" data-pasture-needs-parent={area.id}>
            Needs pasture assignment - choose the parent pasture this paddock sits in before it can be saved.
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

  // Area modal: the SINGLE home for per-area editing. A click/tap on a map area
  // (canvas onSelect -> selectedId) opens this accessible centered dialog over the
  // map; the desktop hover readout is independent and stays. Replaces the old
  // side-panel "Plan area inspector". The inner wrapper keeps the legacy
  // data-pasture-plan-inspector hook so existing id-addressable assertions resolve;
  // the dialog/backdrop carry the data-pasture-area-modal selectors. Read-only
  // facts on top, then Manage / Line style / Record-or-plan move, the admin
  // hard-delete (no "Danger zone" framing). The header X is the single visible
  // close affordance and saves the review state before dismissing.
  function renderAreaModal() {
    if (!selectedArea) return null;
    return (
      <PastureAreaModal
        areaId={selectedArea.id}
        title={selectedArea.name || 'Unnamed area'}
        subtitle={designationLabel(selectedArea)}
        onClose={closeAreaModal}
        closeDisabled={areaModalCloseSaving}
      >
        {/* Map shell hosts the SAME canonical Area Record the Reports shell shows
            (detail + grazing history + management). Move/animal placement is NOT
            here — it stays in the side-panel group workflow. */}
        <div className="pm-plan-inspector" data-pasture-plan-inspector={selectedArea.id}>
          {renderAreaRecordContent()}
        </div>
      </PastureAreaModal>
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
    if (reportGroupId && reportRecordGroup) return renderGroupRecord(reportRecordGroup, 'reports');
    return renderReportAreaList();
  }

  function renderReportAreaList() {
    if (Array.isArray(allRecordGroups)) {
      const needsClassifyTable = classifyQueue.filter((a) => !isOutlineCandidateArea(a));
      const pushed = new Set();
      const areaRows = [];
      const pushArea = (area, section, depth = 0) => {
        if (!area || pushed.has(area.id)) return;
        pushed.add(area.id);
        areaRows.push({...area, reportSection: section, reportDepth: depth});
      };
      reportGroups.needsPasture.forEach((area) => pushArea(area, 'Needs pasture assignment'));
      reportGroups.pastures.forEach(({area, children}) => {
        pushArea(area, 'Pastures');
        children.forEach((child) => pushArea(child, area.name || 'Paddocks', 1));
      });
      reportGroups.feeders.forEach(({area, children}) => {
        pushArea(area, 'Feeder-pig areas');
        children.forEach((child) => pushArea(child, area.name || 'Feeder paddocks', 1));
      });
      reportGroups.temp.forEach((area) => pushArea(area, 'Temp paddocks'));
      reportGroups.other.forEach((area) => pushArea(area, 'Other areas'));
      archivedAreas.forEach((area) => pushArea(area, 'Archived areas'));
      const areaSections = Array.from(
        areaRows.reduce((m, row) => {
          const key = row.reportSection || 'Areas';
          if (!m.has(key)) m.set(key, []);
          m.get(key).push(row);
          return m;
        }, new Map()),
        ([label, rows]) => ({key: label, label, rows}),
      );
      const groupRows = includeInactiveGroups ? allRecordGroups : groups;
      const groupSections = ['cattle', 'pig', 'sheep']
        .map((species) => {
          const rows = groupRows.filter((group) => group.species === species);
          return rows.length ? {key: species, label: SPECIES[species].label, rows} : null;
        })
        .filter(Boolean);
      const showMaintenance =
        (isManager &&
          (reportGroups.needsPasture.length > 0 || needsClassifyTable.length > 0 || trackLineAreas.length > 0)) ||
        archivedAreas.length > 0;
      return (
        <>
          <div className="pm-panel-title">
            <span className="pm-kicker">Reports</span>
            <h2>Grazing records</h2>
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
          <div
            className="pm-card pm-report-table-card pm-tile-card"
            data-pasture-report-areas="1"
            data-surface="pasture-report-area-table"
          >
            <div className="pm-card-title">Areas</div>
            {areaSections.length === 0 ? (
              <div className="pm-tile-empty">No areas yet. Import or draw areas first.</div>
            ) : (
              <div className="pm-tile-list">
                {areaSections.map((section) => (
                  <div key={section.key} className="pm-tile-section">
                    <div className="pm-tile-band">{section.label}</div>
                    {section.rows.map((area) => (
                      <div
                        key={area.id}
                        className={'pm-open-tile pm-area-tile hoverable-tile depth-' + (area.reportDepth || 0)}
                        data-pasture-report-area-row={area.id}
                        {...openableProps(() => openAreaRecord(area.id))}
                      >
                        <span className="pm-open-tile-main">
                          <span className="pm-open-tile-title">
                            {area.name || 'Unnamed'} {reportAreaTag(area.id)}
                          </span>
                          <span className="pm-open-tile-sub">
                            {[
                              designationLabel(area),
                              area.effective_acres == null
                                ? null
                                : `${Number(area.effective_acres).toLocaleString()} ac`,
                              area.last_touched_at
                                ? `Last grazed ${formatMoveTime(area.last_touched_at)}`
                                : 'No history',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        <span className="pm-area-tile-state">
                          <i className={'dot ' + grazingState(area)} /> {restCopy(area)}
                        </span>
                        <span className="chev" aria-hidden="true">
                          {'›'}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            className="pm-card pm-report-table-card pm-tile-card"
            data-pasture-report-groups="1"
            data-surface="pasture-report-group-table"
          >
            <div className="pm-card-head">
              <div className="pm-card-title">Animal groups</div>
              <label className="pm-inline-toggle">
                <input
                  type="checkbox"
                  checked={includeInactiveGroups}
                  onChange={(e) => setIncludeInactiveGroups(e.target.checked)}
                  data-pasture-include-inactive-groups="1"
                />
                <span>Include inactive groups</span>
              </label>
            </div>
            {groupSections.length === 0 ? (
              <div className="pm-tile-empty">No animal groups yet.</div>
            ) : (
              <div className="pm-tile-list">
                {groupSections.map((section) => (
                  <div key={section.key} className="pm-tile-section">
                    <div className="pm-tile-band">{section.label}</div>
                    {section.rows.map((group) => {
                      const spec = groupSpeciesStyle(group);
                      const loc = recordGroupLocation[group.id];
                      return (
                        <div
                          key={group.id}
                          className="pm-open-tile pm-group-tile hoverable-tile"
                          style={{'--species-color': spec.color}}
                          data-pasture-report-group-row={group.groupKey || group.id}
                          {...openableProps(() => openGroupRecord(group, 'reports'))}
                        >
                          <span className="pm-group-avatar">{group.short}</span>
                          <span className="pm-open-tile-main">
                            <span className="pm-open-tile-title">{group.name}</span>
                            <span className="pm-open-tile-sub">
                              {[
                                group.active === false ? 'Inactive' : 'Current',
                                loc ? loc.areaName || 'Placed' : 'Not placed',
                                loc && loc.movedAt ? formatMoveTime(loc.movedAt) : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </span>
                          <span className="pm-open-tile-metric">
                            <strong>{groupSizeCount(group)?.toLocaleString() || '-'}</strong>
                            <em>head</em>
                          </span>
                          <span className="chev" aria-hidden="true">
                            {'›'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          {showMaintenance && (
            <div className="pm-card pm-report-review-card" data-pasture-report-review="1">
              <div className="pm-card-title">Area maintenance</div>
              {reportGroups.needsPasture.map((area) => (
                <div key={area.id} className="pm-report-review-row" data-pasture-report-needs-row={area.id}>
                  <span>{area.name || 'Unnamed'} needs pasture assignment</span>
                  {isManager && (
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm"
                      onClick={() => openAreaModal(area.id)}
                      data-pasture-report-assign-pasture={area.id}
                    >
                      Assign pasture
                    </button>
                  )}
                </div>
              ))}
              {isManager &&
                needsClassifyTable.map((area) => (
                  <div
                    key={area.id}
                    className="pm-report-review-row"
                    data-pasture-report-needs-classification={area.id}
                  >
                    <span>{area.name || 'Unnamed'} needs classification</span>
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm"
                      onClick={() => openAreaModal(area.id)}
                      data-pasture-report-classify-open={area.id}
                    >
                      Classify
                    </button>
                  </div>
                ))}
              {trackLineAreas.map((a) => (
                <div key={a.id} className="pm-report-review-row" data-pasture-track-line={a.id}>
                  <span>
                    <span className="pm-chip pm-chip-outline_candidate">Track / line</span> {a.name || 'Unnamed'}
                  </span>
                  {isManager && (
                    <div className="pm-track-line-actions">
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => startEditLine(a)}
                        disabled={busyId === a.id || !hasLineGeom(a)}
                        data-pasture-track-line-edit={a.id}
                      >
                        Edit line
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => closeIntoTempPaddock(a)}
                        disabled={busyId === a.id}
                        data-pasture-track-line-close={a.id}
                      >
                        Close into temp paddock
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm pm-btn-danger"
                        onClick={() => removeArea(a)}
                        disabled={busyId === a.id}
                        data-pasture-track-line-delete={a.id}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {archivedAreas.map((a) => (
                <div key={a.id} className="pm-report-review-row" data-pasture-archived-row={a.id}>
                  <span>{a.name || 'Unnamed'} is archived</span>
                  {isManager && (
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm"
                      onClick={() => restoreArea(a)}
                      disabled={busyId === a.id}
                      data-pasture-archived-restore={a.id}
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    // Manager review surface: areas still needing classification (outline candidates
    // live in the Tracks / Lines section instead).
    const needsClassify = classifyQueue.filter((a) => !isOutlineCandidateArea(a));
    // A row that opens the area's grazing record (no map; read-only to all roles).
    const inventoryRow = (area, depth) => {
      const state = grazingState(area);
      return (
        <button
          type="button"
          key={area.id}
          className={'pm-report-area-row depth-' + depth + ' state-' + state}
          onClick={() => openAreaRecord(area.id)}
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
    };
    const hasAny =
      reportGroups.pastures.length ||
      reportGroups.needsPasture.length ||
      reportGroups.feeders.length ||
      reportGroups.temp.length ||
      reportGroups.other.length ||
      trackLineAreas.length ||
      archivedAreas.length;
    return (
      <>
        <div className="pm-panel-title">
          <span className="pm-kicker">Reports</span>
          <h2>Grazing records by area</h2>
          <p>Pastures collapse to hide their paddocks. Open an area for its full grazing record.</p>
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
          {/* Needs pasture assignment: parentless permanent paddocks. Open by default
              so it is unmissable; managers get an Assign action into the Area modal. */}
          {reportGroups.needsPasture.length > 0 && (
            <details className="pm-report-section pm-report-needs" open data-pasture-report-needs-pasture="1">
              <summary>
                <span>Needs pasture assignment</span>
                <span className="pm-report-count">{reportGroups.needsPasture.length}</span>
              </summary>
              {reportGroups.needsPasture.map((area) => (
                <div key={area.id} className="pm-report-review-row" data-pasture-report-needs-row={area.id}>
                  {inventoryRow(area, 0)}
                  {isManager && (
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm"
                      onClick={() => openAreaModal(area.id)}
                      data-pasture-report-assign-pasture={area.id}
                    >
                      Assign pasture
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
          {/* Pastures, each collapsed; expanding reveals its child paddocks (parent_id). */}
          {reportGroups.pastures.length > 0 && (
            <div className="pm-report-section" data-pasture-report-pastures="1">
              <div className="pm-report-section-title">Pastures</div>
              {reportGroups.pastures.map(({area, children}) => (
                <details key={area.id} className="pm-report-pasture" data-pasture-report-pasture={area.id}>
                  <summary>
                    <span className="pm-report-area-name">
                      {area.name || 'Unnamed'} {reportAreaTag(area.id)}
                    </span>
                    <span className="pm-report-area-meta">
                      {designationLabel(area)}
                      {area.effective_acres != null ? ` · ${area.effective_acres} ac` : ''}
                      {children.length ? ` · ${children.length} paddock${children.length === 1 ? '' : 's'}` : ''}
                    </span>
                  </summary>
                  <div className="pm-report-pasture-body">
                    {inventoryRow(area, 0)}
                    {children.map((c) => inventoryRow(c, 1))}
                    {!children.length && <div className="pm-report-empty">No paddocks under this pasture yet.</div>}
                  </div>
                </details>
              ))}
            </div>
          )}
          {/* Manager review: areas still needing classification (non-outline). */}
          {isManager && needsClassify.length > 0 && (
            <details className="pm-report-section" data-pasture-report-needs-classification="1">
              <summary>
                <span>Needs classification</span>
                <span className="pm-report-count">{needsClassify.length}</span>
              </summary>
              {needsClassify.map((area) => (
                <div key={area.id} className="pm-report-review-row">
                  {inventoryRow(area, 0)}
                  <button
                    type="button"
                    className="pm-btn pm-btn-sm"
                    onClick={() => openAreaModal(area.id)}
                    data-pasture-report-classify-open={area.id}
                  >
                    Classify
                  </button>
                </div>
              ))}
            </details>
          )}
          {reportGroups.feeders.length > 0 && (
            <details className="pm-report-section" data-pasture-report-feeders="1">
              <summary>
                <span>Feeder-pig areas</span>
                <span className="pm-report-count">{reportGroups.feeders.length}</span>
              </summary>
              {reportGroups.feeders.map(({area, children}) => (
                <div key={area.id} className="pm-report-pasture-body">
                  {inventoryRow(area, 0)}
                  {children.map((c) => inventoryRow(c, 1))}
                </div>
              ))}
            </details>
          )}
          {reportGroups.temp.length > 0 && (
            <details className="pm-report-section" data-pasture-report-temp="1">
              <summary>
                <span>Temp paddocks</span>
                <span className="pm-report-count">{reportGroups.temp.length}</span>
              </summary>
              {reportGroups.temp.map((area) => inventoryRow(area, 0))}
            </details>
          )}
          {/* Tracks / Lines: draft geometry. Open the record, or (manager) close into a
              temp paddock / delete. No map zoom here - Reports renders no map. */}
          {trackLineAreas.length > 0 && (
            <details className="pm-report-section">
              <summary>
                <span>Tracks / Lines</span>
                <span className="pm-report-count">{trackLineAreas.length}</span>
              </summary>
              {trackLineAreas.map((a) => (
                <div key={a.id} className="pm-report-review-row" data-pasture-track-line={a.id}>
                  <span className="pm-report-area-name">
                    <span className="pm-chip pm-chip-outline_candidate">Track / line</span>
                    {a.name || 'Unnamed'}
                  </span>
                  {isManager && (
                    <div className="pm-track-line-actions">
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => startEditLine(a)}
                        disabled={busyId === a.id || !hasLineGeom(a)}
                        data-pasture-track-line-edit={a.id}
                      >
                        Edit line
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm"
                        onClick={() => closeIntoTempPaddock(a)}
                        disabled={busyId === a.id}
                        data-pasture-track-line-close={a.id}
                      >
                        Close into temp paddock
                      </button>
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm pm-btn-danger"
                        onClick={() => removeArea(a)}
                        disabled={busyId === a.id}
                        data-pasture-track-line-delete={a.id}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </details>
          )}
          {/* Archived areas: restore (manager) or open the record. */}
          {archivedAreas.length > 0 && (
            <details className="pm-report-section" data-pasture-archived="1">
              <summary>
                <span>Archived areas</span>
                <span className="pm-report-count">{archivedAreas.length}</span>
              </summary>
              {archivedAreas.map((a) => (
                <div key={a.id} className="pm-report-review-row" data-pasture-archived-row={a.id}>
                  {inventoryRow(a, 0)}
                  {isManager && (
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm"
                      onClick={() => restoreArea(a)}
                      disabled={busyId === a.id}
                      data-pasture-archived-restore={a.id}
                    >
                      Restore
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
          {reportGroups.other.length > 0 && (
            <details className="pm-report-section" data-pasture-report-other="1">
              <summary>
                <span>Other areas</span>
                <span className="pm-report-count">{reportGroups.other.length}</span>
              </summary>
              {reportGroups.other.map((area) => inventoryRow(area, 0))}
            </details>
          )}
          {!hasAny && <div className="pm-report-empty">No areas yet. Import or draw areas first.</div>}
        </div>
      </>
    );
  }

  // Grazing-history section of the canonical Area Record: status header + lifetime
  // totals + the dated stay timeline with the per-entry delete (mig 147). Keys off
  // the open area (selectedArea); shown in BOTH the Map modal and the Reports record.
  function renderAreaGrazingHistory() {
    const area = selectedArea;
    if (!area) return null;
    const occ = (occupantsByArea[area.id] || []).find((o) => !o.overlap) || null;
    const openStay = recordStays.find((s) => s.stillHere) || null;
    const statusLine =
      occ && openStay
        ? `In use by ${occ.name} since ${formatMoveTime(openStay.inAt)}`
        : area.last_touched_at
          ? `Last grazed ${formatMoveTime(area.last_touched_at)}`
          : 'No grazing history yet';
    // ONE card. The area's designation / acres / current state already live in the
    // Area-detail panel above, so the history card carries only what's unique to the
    // grazing record: the status line, lifetime totals, and the dated stay timeline.
    return (
      <div className="pm-card pm-grazing-record" data-pasture-report-record={area.id} data-pasture-report-timeline="1">
        <div className="pm-card-title">Grazing History</div>
        <div className="pm-record-status" data-pasture-report-status="1">
          {statusLine}
        </div>
        <div className="pm-record-totals" data-pasture-report-totals="1">
          <span>
            <b>{recordTotals.timesGrazed}</b> times grazed
          </span>
          <span>
            <b>{recordTotals.totalAnimalDays.toLocaleString()}</b> animal-days
          </span>
          <span>
            <b>{recordTotals.avgDensity != null ? recordTotals.avgDensity.toLocaleString() : '-'}</b> avg head/ac
          </span>
        </div>
        {reportHistoryLoading ? (
          <div className="pm-report-empty">Loading record...</div>
        ) : recordStays.length ? (
          recordStays.map((s) => (
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
                {s.acres != null && <span>{s.acres.toLocaleString()} ac</span>}
                {s.density != null && <span>{s.density.toLocaleString()} head/ac</span>}
                {s.animalDays != null && <span>{s.animalDays.toLocaleString()} animal-days</span>}
                <span>{s.lbsPerAcre != null ? `${s.lbsPerAcre.toLocaleString()} lbs/ac` : 'lbs/ac unknown'}</span>
              </div>
              {s.notes && <div className="pm-record-stay-notes">{s.notes}</div>}
              {/* Management/admin per-entry delete (mig 147): removes THIS stay's
                    move-IN pasture_move_events row (s.id); its impacts cascade and
                    every area's state re-derives. Inline confirm, no window.confirm. */}
              {isManager && (
                <div className="pm-record-stay-actions" data-pasture-report-stay-actions={s.id}>
                  {confirmDeleteStayId === s.id ? (
                    <span className="pm-record-stay-confirm" data-pasture-report-stay-confirm={s.id}>
                      Delete this grazing entry? This cannot be undone.
                      <button
                        type="button"
                        className="pm-btn pm-btn-sm pm-btn-danger"
                        onClick={() => deleteGrazingStay(s)}
                        disabled={busyId === s.id}
                        data-pasture-report-stay-delete-yes={s.id}
                      >
                        Delete entry
                      </button>
                      <button type="button" className="pm-btn pm-btn-sm" onClick={() => setConfirmDeleteStayId(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="pm-btn pm-btn-sm pm-btn-danger"
                      onClick={() => setConfirmDeleteStayId(s.id)}
                      disabled={busyId === s.id}
                      data-pasture-report-stay-delete={s.id}
                    >
                      Delete entry
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        ) : (
          <div className="pm-report-empty">No grazing recorded for this area yet.</div>
        )}
      </div>
    );
  }

  // The ONE canonical Area Record, rendered identically in BOTH shells (the Map
  // area modal and the Reports record): area detail + name edit + grazing history
  // + management (classification / parent / line style / archive / hard-delete),
  // each role-gated. Move recording is NOT here — it stays in the group workflow.
  function renderAreaRecordContent() {
    const area = selectedArea;
    if (!area) return null;
    const styleEligible = isManager && canEditLineStyle(area);
    return (
      <div className="pm-area-record" data-pasture-area-record={area.id}>
        {/* ONE Area section: detail + name edit + management combined. */}
        {renderAreaSummary()}
        {/* Tracks / Lines are draft geometry; they never carry grazing history. */}
        {!isOutlineCandidateArea(area) && renderAreaGrazingHistory()}
        {styleEligible && (
          <section className="pm-modal-section" data-pasture-modal-section="linestyle" data-pasture-setup-linestyle="1">
            <div className="pm-modal-section-label">Line style</div>
            {renderLineStylePanel()}
          </section>
        )}
        {isAdmin && (
          <section className="pm-modal-section pm-modal-section-danger" data-pasture-modal-section="danger">
            {renderDangerZone(area)}
          </section>
        )}
      </div>
    );
  }

  // Reports shell for the canonical Area Record: a Back affordance over the same
  // renderAreaRecordContent the Map modal hosts. (selectedId is set when an area is
  // opened from Reports, so selectedArea === the open area in both shells.)
  function renderAreaRecord() {
    if (!selectedArea) return null;
    return (
      <>
        <div className="pm-panel-title pm-record-title">
          <button type="button" className="pm-btn pm-btn-sm" onClick={closeAreaRecord} data-pasture-report-back="1">
            &larr; All areas
          </button>
          <span className="pm-kicker">Area record</span>
        </div>
        {renderAreaRecordContent()}
      </>
    );
  }

  function renderPanel() {
    // Field is a full-screen OnX-style map; its controls live in the field chrome
    // overlay, not the side panel.
    if (appMode === 'field') return null;
    if (appMode === 'reports') return renderReportsPanel();
    // Slim Map side panel = the GROUP / rotation cockpit only: Current groups +
    // status overview on top, then the planning cockpit (group switcher,
    // current-group Move/Clear, planned moves, rotation editor, bottom Import KML).
    // Per-area editing now lives in the Area modal (renderAreaModal), opened by
    // clicking a map area, so the panel never swaps to an inline inspector.
    return (
      <>
        {renderViewPanel()}
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
          <div className="pm-field-status" data-pasture-field-status="1">
            <span className="pm-field-title">Field</span>
            <span
              className={'pm-field-net' + (online ? '' : ' is-offline')}
              data-pasture-field-online={online ? '1' : '0'}
            >
              <i aria-hidden="true" />
              {online ? 'Online' : 'Offline'}
            </span>
            {/* Secondary, low-prominence affordances — kept off the recurring
                Walk/Draw/Measure toolbar. Saved measurements only appears when
                there are some to review. */}
            <button
              type="button"
              className={'pm-field-setup-btn' + (offlineSetupOpen ? ' is-active' : '')}
              onClick={() => setOfflineSetupOpen((v) => !v)}
              aria-expanded={offlineSetupOpen}
              data-pasture-offline-setup-toggle="1"
            >
              <span aria-hidden="true">&#9881;</span> Offline setup
            </button>
            {measurements.length > 0 && (
              <button
                type="button"
                className={'pm-field-setup-btn' + (savedMeasuresOpen ? ' is-active' : '')}
                onClick={() => setSavedMeasuresOpen((v) => !v)}
                aria-expanded={savedMeasuresOpen}
                data-pasture-saved-measures-toggle="1"
              >
                <span aria-hidden="true">&#128207;</span> Saved measurements
              </button>
            )}
          </div>
          {offlineSetupOpen && (
            <div className="pm-field-setup-panel" data-pasture-offline-setup="1">
              {renderOfflineImagery()}
              {renderFieldGuide()}
            </div>
          )}
          {savedMeasuresOpen && measurements.length > 0 && (
            <div className="pm-field-setup-panel" data-pasture-saved-measures="1">
              {renderMeasurementsList()}
            </div>
          )}
        </div>
        <div className="pm-field-forms">
          {renderTrackPanel()}
          {renderDrawForm()}
          {renderMeasureForm()}
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
                nextStopOnly: false,
                showRotationPath: true,
                previewAreaId: null,
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
      {/* Area modal overlay: clicking/tapping a map area (Map tab) opens it over the
          map. Gated to the Map tab in select mode - not while a build tool is active
          (draw/edit/measure/track/droppin) or while tapping to add rotation stops. */}
      {appMode === 'view' &&
        selectedArea &&
        !addMode &&
        !['draw', 'edit', 'measure', 'track', 'droppin'].includes(mapMode) &&
        renderAreaModal()}
      <div className="pm-hidden-compat">
        <span data-mode="select" />
        <span data-pasture-style-weight="1" />
        <span>trackGeometry={'{activeTrackGeometry}'}</span>
      </div>
    </div>
  );
}
