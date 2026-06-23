// ============================================================================
// src/lib/pasturePlannerGroups.js  —  Pasture Map planner-group roster, P1
// ----------------------------------------------------------------------------
// Pure, derived, READ-ONLY roster of real animal groups for the Pasture Map.
// There are NO free-form group names and NO user-entered counts: every count is
// computed from the same live app data the rest of the planner uses, so the
// pasture roster cannot drift from the herd/flock/pig records.
//
// Counts mirror the canonical app definitions exactly:
//   Cattle  — count current `cattle` rows by `herd` (active = deleted_at null).
//             (CattleHerdsView load path / herd enum.)
//   Sheep   — count current `sheep` rows by `flock` (active = deleted_at null).
//   Pigs    — Sow Group 1/2/3: !archived breeders, sex Sow|Gilt, group '1'|'2'|'3'
//               (BreedingView.jsx group filter).
//             Boars: !archived breeders, sex Boar (PigsHomeView active-boar count).
//             Feeder sub-batches: group.status==='active' && sub.status==='active'
//               with computeSubCurrentCount(...) > 0 (activePigFeederDailyTargets
//               active-sub rule + the shared ledger helper).
//
// Groups whose count is 0 are omitted everywhere. Output is ordered Pigs, Sheep,
// Cattle, and within each species in the fixed roster order.
//
// Each group also carries the (animalType, groupKey) identity used to key its
// moves in the pasture move ledger (record_pasture_move animal_type ∈
// cattle_herd|sheep_flock|breeder_pigs|feeder_pigs). This is the bridge the view
// uses to resolve a group's current location/occupancy from move events.
// ============================================================================
import {computeSubCurrentCount} from './pig.js';

// Design-token species colors (animal-type occupancy).
export const SPECIES_COLOR = {
  pig: '#A8418A',
  sheep: '#1E8A8A',
  cattle: '#9A3B2E',
};

// Fixed roster definitions in display order.
export const CATTLE_HERDS = [
  {key: 'mommas', name: 'Mommas', short: 'MM', unit: 'cows'},
  {key: 'backgrounders', name: 'Backgrounders', short: 'BG', unit: 'head'},
  {key: 'finishers', name: 'Finishers', short: 'FN', unit: 'head'},
  {key: 'bulls', name: 'Bulls', short: 'BL', unit: 'bulls'},
];
export const SHEEP_FLOCKS = [
  {key: 'ewes', name: 'Ewes', short: 'EW', unit: 'ewes'},
  {key: 'rams', name: 'Rams', short: 'RM', unit: 'rams'},
  {key: 'feeders', name: 'Feeders', short: 'FD', unit: 'head'},
];
export const SOW_GROUPS = ['1', '2', '3'];

const asArray = (v) => (Array.isArray(v) ? v : []);
const isLive = (row) => !!row && !row.deleted_at;

// Derive a short avatar code (<=3 chars) from a feeder sub-batch name.
export function deriveFeederShort(name) {
  const s = String(name || '');
  const digits = (s.match(/\d+/g) || []).pop();
  const letter = (s.match(/[A-Za-z]/) || [''])[0].toUpperCase();
  if (letter && digits) return (letter + digits).slice(0, 3);
  if (digits) return digits.slice(-3);
  const letters = s.replace(/[^A-Za-z]/g, '').toUpperCase();
  return (letters || 'F').slice(0, 2);
}

// Count active breeders in a numbered sow group ('1' | '2' | '3').
function sowGroupCount(breeders, group) {
  return asArray(breeders).filter(
    (b) => b && !b.archived && (b.sex === 'Sow' || b.sex === 'Gilt') && String(b.group || '') === String(group),
  ).length;
}

// Count active boars.
function boarCount(breeders) {
  return asArray(breeders).filter((b) => b && !b.archived && b.sex === 'Boar').length;
}

// Compute the full planner-group roster from already-loaded app data. All inputs
// are plain data; nothing is fetched here. options is forwarded to
// computeSubCurrentCount (e.g. {tripSourceSummary}).
export function computePlannerGroupRoster({
  cattle = [],
  sheep = [],
  breeders = [],
  feederGroups = [],
  options = {},
} = {}) {
  // ── Pigs ──────────────────────────────────────────────────────────────────
  const pigGroups = [];
  for (const g of SOW_GROUPS) {
    const count = sowGroupCount(breeders, g);
    if (count > 0) {
      pigGroups.push({
        id: `pig-sow-${g}`,
        species: 'pig',
        name: `Sow Group ${g}`,
        short: `S${g}`,
        count,
        unit: 'sows',
        animalType: 'breeder_pigs',
        groupKey: `sow-${g}`,
      });
    }
  }
  const boars = boarCount(breeders);
  if (boars > 0) {
    pigGroups.push({
      id: 'pig-boars',
      species: 'pig',
      name: 'Boars',
      short: 'B',
      count: boars,
      unit: 'boars',
      animalType: 'breeder_pigs',
      groupKey: 'boars',
    });
  }
  for (const grp of asArray(feederGroups)) {
    if (!grp || grp.status !== 'active') continue;
    for (const sub of asArray(grp.subBatches)) {
      if (!sub || sub.status !== 'active') continue;
      // group_key is the durable move-ledger identity; sub names can change, so
      // an active sub with no stable id is omitted rather than keyed by name.
      const subId = sub.id != null ? String(sub.id).trim() : '';
      if (!subId) continue;
      const count = computeSubCurrentCount(grp, sub, breeders, options);
      if (count > 0) {
        pigGroups.push({
          id: `pig-feeder-${subId}`,
          species: 'pig',
          name: sub.name,
          short: deriveFeederShort(sub.name),
          count,
          unit: 'head',
          animalType: 'feeder_pigs',
          groupKey: subId,
        });
      }
    }
  }

  // ── Sheep ─────────────────────────────────────────────────────────────────
  const sheepGroups = [];
  for (const f of SHEEP_FLOCKS) {
    const count = asArray(sheep).filter((s) => isLive(s) && s.flock === f.key).length;
    if (count > 0) {
      sheepGroups.push({
        id: `sheep-${f.key}`,
        species: 'sheep',
        name: f.name,
        short: f.short,
        count,
        unit: f.unit,
        animalType: 'sheep_flock',
        groupKey: f.key,
      });
    }
  }

  // ── Cattle ──────────────────────────────────────────────────────────────────
  const cattleGroups = [];
  for (const h of CATTLE_HERDS) {
    const count = asArray(cattle).filter((c) => isLive(c) && c.herd === h.key).length;
    if (count > 0) {
      cattleGroups.push({
        id: `cattle-${h.key}`,
        species: 'cattle',
        name: h.name,
        short: h.short,
        count,
        unit: h.unit,
        animalType: 'cattle_herd',
        groupKey: h.key,
      });
    }
  }

  const sections = [
    {species: 'pig', label: 'Pigs', color: SPECIES_COLOR.pig, groups: pigGroups},
    {species: 'sheep', label: 'Sheep', color: SPECIES_COLOR.sheep, groups: sheepGroups},
    {species: 'cattle', label: 'Cattle', color: SPECIES_COLOR.cattle, groups: cattleGroups},
  ].filter((s) => s.groups.length > 0);
  for (const s of sections) s.headCount = s.groups.reduce((n, g) => n + g.count, 0);

  const groups = sections.flatMap((s) => s.groups);
  return {groups, bySpecies: sections};
}

// Move destinations for a planner group, derived from the global destination set
// (real grazing areas, already excluding draft tracks/lines). Feeder pigs live in
// the permanent pig-pasture paddocks (kind='paddock', designation='feeder_pig'),
// so prefer those whenever any exist; the parent ~5ac pig pastures are a grouping,
// not a grazing cell. Graceful fallback: if no feeder-pig paddocks exist (e.g. a
// dev/test fixture without them), return the full set so behavior doesn't dead-end.
// All non-feeder groups (cattle/sheep/breeder pigs/boars) use the full set unchanged.
export function destinationsForGroup(group, destinationAreas) {
  const all = asArray(destinationAreas);
  if (group && group.animalType === 'feeder_pigs') {
    const paddocks = all.filter((a) => a && a.kind === 'paddock' && a.designation === 'feeder_pig');
    if (paddocks.length) return paddocks;
  }
  return all;
}

// True when an area is a parent pig pasture that already has feeder-pig paddock
// children. Such a pasture is a container, not a feeder-pig grazing destination.
export function isPigPastureWithPaddocks(area, destinationAreas) {
  if (!area || area.kind !== 'pasture') return false;
  return asArray(destinationAreas).some(
    (a) => a && a.kind === 'paddock' && a.designation === 'feeder_pig' && a.parent_id === area.id,
  );
}
