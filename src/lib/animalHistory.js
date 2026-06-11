import {pigSlug} from './pig.js';

export const ANIMAL_HISTORY_SPECIES = Object.freeze([
  {key: 'broilers', label: 'Broilers', cssVar: '--c-broiler'},
  {key: 'layers', label: 'Layer Hens', cssVar: '--c-layer'},
  {key: 'pigs', label: 'Pigs', cssVar: '--c-pig'},
  {key: 'cattle', label: 'Cattle', cssVar: '--c-cattle'},
  {key: 'sheep', label: 'Sheep', cssVar: '--c-sheep'},
]);

export const ACTIVE_CATTLE_HERDS = Object.freeze(['mommas', 'backgrounders', 'finishers', 'bulls']);
export const ACTIVE_SHEEP_FLOCKS = Object.freeze(['rams', 'ewes', 'feeders']);

const ACTIVE_CATTLE_SET = new Set(ACTIVE_CATTLE_HERDS);
const ACTIVE_SHEEP_SET = new Set(ACTIVE_SHEEP_FLOCKS);
const OUTCOME_GROUPS = new Set(['processed', 'deceased', 'sold']);

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function num(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function int(value) {
  return Math.trunc(num(value));
}

function norm(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function normLabel(value) {
  return norm(value)
    .replace(/^\(processed\)\s*/, '')
    .trim();
}

function minISO(dates) {
  const clean = dates.map(isoDate).filter(Boolean).sort();
  return clean[0] || null;
}

function monthKey(value) {
  const iso = isoDate(value);
  return iso ? iso.slice(0, 7) : null;
}

function monthEnd(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
  const [y, m] = month.split('-').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function addMonth(month) {
  const [y, m] = month.split('-').map((v) => parseInt(v, 10));
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

function monthsBetween(startMonth, endMonth) {
  if (!startMonth || !endMonth || startMonth > endMonth) return [];
  const out = [];
  let m = startMonth;
  while (m <= endMonth) {
    out.push(m);
    m = addMonth(m);
  }
  return out;
}

function snapshotDateForMonth(month, asOfDate) {
  const end = monthEnd(month);
  const today = isoDate(asOfDate) || new Date().toISOString().slice(0, 10);
  if (!end) return today;
  return end > today ? today : end;
}

function groupById(rows, idField) {
  const map = new Map();
  for (const row of rows || []) {
    const id = row && row[idField];
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  for (const list of map.values()) {
    list.sort((a, b) =>
      (isoDate(a.transferred_at || a.created_at) || '').localeCompare(isoDate(b.transferred_at || b.created_at) || ''),
    );
  }
  return map;
}

function batchLabels(batch) {
  return new Set([batch && batch.name, batch && batch.id].map(normLabel).filter(Boolean));
}

function dailyMatchesLabels(daily, labels) {
  const direct = normLabel(daily && daily.batch_label);
  if (direct && labels.has(direct)) return true;
  const batchId = normLabel(daily && daily.batch_id);
  return !!batchId && labels.has(batchId);
}

export function broilersOnFarmAt(batches, broilerDailys, asOfDate) {
  const asOf = isoDate(asOfDate);
  if (!asOf) return 0;
  let total = 0;
  for (const batch of batches || []) {
    if (!batch || batch.deleted_at) continue;
    const start = isoDate(
      batch.hatchDate || batch.hatch_date || batch.brooderIn || batch.brooder_in || batch.arrival_date,
    );
    if (!start || start > asOf) continue;
    const processed = isoDate(batch.processingDate || batch.processing_date);
    if (processed && processed <= asOf) continue;
    if (!processed && norm(batch.status) === 'processed') continue;

    const labels = batchLabels(batch);
    const started = int(batch.birdCountActual) || int(batch.birdCount) || int(batch.original_count);
    if (started <= 0) continue;

    const matchingDailys = (broilerDailys || []).filter(
      (d) => d && isoDate(d.date) && isoDate(d.date) <= asOf && dailyMatchesLabels(d, labels),
    );
    const mortality =
      matchingDailys.length > 0 || !/^b-24-/i.test(String(batch.name || ''))
        ? matchingDailys.reduce((sum, d) => sum + int(d.mortality_count), 0)
        : int(batch.mortalityCumulative);
    total += Math.max(0, started - mortality);
  }
  return total;
}

function layerDailyMatchesHousing(daily, housing) {
  if (!daily || !housing) return false;
  const label = normLabel(daily.batch_label);
  const housingName = normLabel(housing.housing_name);
  if (label && housingName && label === housingName) return true;
  return !!(housing.batch_id && daily.batch_id && String(daily.batch_id) === String(housing.batch_id));
}

function layerHousingCountAt(housing, parentBatch, layerDailys, asOf) {
  const start = isoDate(
    housing.start_date || (parentBatch && (parentBatch.brooder_entry_date || parentBatch.arrival_date)),
  );
  const retired = isoDate(housing.retired_date);
  const latestDaily = (layerDailys || [])
    .filter((d) => {
      const date = isoDate(d && d.date);
      if (!date || date > asOf) return false;
      if (start && date < start) return false;
      if (retired && date >= retired) return false;
      return int(d.layer_count) > 0 && layerDailyMatchesHousing(d, housing);
    })
    .sort((a, b) => (isoDate(b.date) || '').localeCompare(isoDate(a.date) || ''))[0];
  if (latestDaily) return int(latestDaily.layer_count);

  const currentCountDate = isoDate(housing.current_count_date);
  if (housing.current_count != null && (!currentCountDate || currentCountDate <= asOf))
    return Math.max(0, int(housing.current_count));
  return 0;
}

export function layersOnFarmAt(layerBatches, layerHousings, layerDailys, asOfDate) {
  const asOf = isoDate(asOfDate);
  if (!asOf) return 0;
  const batchesById = new Map((layerBatches || []).map((b) => [b && b.id, b]));
  const housingsByBatch = new Map();
  for (const h of layerHousings || []) {
    if (!h || !h.batch_id) continue;
    if (!housingsByBatch.has(h.batch_id)) housingsByBatch.set(h.batch_id, []);
    housingsByBatch.get(h.batch_id).push(h);
  }

  let total = 0;
  for (const housing of layerHousings || []) {
    if (!housing || housing.deleted_at) continue;
    const parent = batchesById.get(housing.batch_id) || null;
    const start = isoDate(housing.start_date || (parent && (parent.brooder_entry_date || parent.arrival_date)));
    if (!start || start > asOf) continue;
    const retired = isoDate(housing.retired_date);
    if (retired && retired <= asOf) continue;
    if (!retired && norm(housing.status) === 'retired') continue;
    total += layerHousingCountAt(housing, parent, layerDailys, asOf);
  }

  for (const batch of layerBatches || []) {
    if (!batch || batch.deleted_at || housingsByBatch.has(batch.id)) continue;
    const start = isoDate(batch.brooder_entry_date || batch.arrival_date || batch.start_date);
    if (!start || start > asOf) continue;
    if (norm(batch.status) === 'retired') continue;
    total += Math.max(0, int(batch.original_count));
  }

  return total;
}

function feederTargets(feederGroups) {
  const targets = [];
  for (const group of feederGroups || []) {
    if (!group) continue;
    const subs = Array.isArray(group.subBatches) ? group.subBatches : [];
    if (subs.length > 0) {
      for (const sub of subs) {
        if (!sub) continue;
        targets.push({
          group,
          sub,
          subId: sub.id || null,
          label: sub.name || group.batchName,
          start: isoDate(sub.startDate || group.startDate),
          status: sub.status || group.status,
          started: int(sub.giltCount) + int(sub.boarCount) || int(sub.originalPigCount),
        });
      }
      continue;
    }
    targets.push({
      group,
      sub: null,
      subId: null,
      label: group.batchName,
      start: isoDate(group.startDate),
      status: group.status,
      started: int(group.giltCount) + int(group.boarCount) || (group.farmBorn ? int(group.originalPigCount) : 0),
    });
  }
  return targets;
}

function pigDailyMatchesLabel(daily, label) {
  if (!daily || !label) return false;
  const keys = new Set([normLabel(label), pigSlug(label)].filter(Boolean));
  const labelKey = normLabel(daily.batch_label);
  if (keys.has(labelKey) || keys.has(pigSlug(labelKey))) return true;
  const idKey = normLabel(daily.batch_id);
  return keys.has(idKey) || keys.has(pigSlug(idKey));
}

function latestPigDailyCount(pigDailys, label, asOf) {
  const rows = (pigDailys || [])
    .filter((d) => {
      const date = isoDate(d && d.date);
      return date && date <= asOf && pigDailyMatchesLabel(d, label) && int(d.pig_count) > 0;
    })
    .sort((a, b) => (isoDate(b.date) || '').localeCompare(isoDate(a.date) || ''));
  const row = rows[0] || null;
  return row ? {count: int(row.pig_count), date: isoDate(row.date)} : null;
}

function targetTripCount(target, asOf, afterDate = null) {
  let count = 0;
  for (const trip of (target.group && target.group.processingTrips) || []) {
    const date = isoDate(trip && trip.date);
    if (!date || date > asOf || (afterDate && date <= afterDate)) continue;
    if (!target.subId) {
      count += int(trip.pigCount);
      continue;
    }
    const attributions = Array.isArray(trip.subAttributions) ? trip.subAttributions : [];
    if (attributions.length > 0) {
      for (const att of attributions) {
        if (!att) continue;
        if (att.subId === target.subId || normLabel(att.subBatchName) === normLabel(target.label))
          count += int(att.count);
      }
    } else if (((target.group && target.group.subBatches) || []).length === 1) {
      count += int(trip.pigCount);
    }
  }
  return count;
}

function targetMortalityCount(target, asOf, afterDate = null) {
  let count = 0;
  for (const entry of (target.group && target.group.pigMortalities) || []) {
    const date = isoDate(entry && (entry.date || entry.created_at));
    if (!date || date > asOf || (afterDate && date <= afterDate)) continue;
    if (target.subId) {
      if (entry.sub_batch_id === target.subId || normLabel(entry.sub_batch_name) === normLabel(target.label))
        count += int(entry.count);
    } else {
      count += int(entry.count);
    }
  }
  return count;
}

function targetTransferCount(target, breeders, asOf, afterDate = null) {
  let count = 0;
  for (const breeder of breeders || []) {
    const source = breeder && breeder.transferredFromBatch;
    if (!source || source.batchName !== (target.group && target.group.batchName)) continue;
    if (target.subId && normLabel(source.subBatchName) !== normLabel(target.label)) continue;
    const date = isoDate(source.transferDate || source.created_at);
    if (!date || date > asOf || (afterDate && date <= afterDate)) continue;
    count += 1;
  }
  return count;
}

function feederTargetCountAt(target, breeders, pigDailys, asOf) {
  if (!target || !target.label || !target.start || target.start > asOf) return 0;
  const latest = latestPigDailyCount(pigDailys, target.label, asOf);
  if (latest) {
    const laterEvents =
      targetTripCount(target, asOf, latest.date) +
      targetMortalityCount(target, asOf, latest.date) +
      targetTransferCount(target, breeders, asOf, latest.date);
    return Math.max(0, latest.count - laterEvents);
  }
  if (target.started <= 0) return norm(target.status) === 'processed' ? 0 : 0;
  return Math.max(
    0,
    target.started -
      targetTripCount(target, asOf) -
      targetMortalityCount(target, asOf) -
      targetTransferCount(target, breeders, asOf),
  );
}

function breederStartDate(breeder) {
  const transferDate = breeder && breeder.transferredFromBatch && breeder.transferredFromBatch.transferDate;
  return isoDate(
    transferDate || breeder.purchaseDate || breeder.purchase_date || breeder.created_at || breeder.birthDate,
  );
}

function breederIsActiveAt(breeder, asOf) {
  if (!breeder) return false;
  const status = norm(breeder.status);
  if (breeder.archived || OUTCOME_GROUPS.has(status)) return false;
  const start = breederStartDate(breeder);
  return !start || start <= asOf;
}

function breederFallbackCount(breeders, asOf, sexGroup) {
  return (breeders || []).filter((b) => {
    if (!breederIsActiveAt(b, asOf)) return false;
    const sex = norm(b.sex);
    return sexGroup === 'boars' ? sex === 'boar' : sex === 'sow' || sex === 'gilt';
  }).length;
}

export function pigsOnFarmAt(feederGroups, breeders, pigDailys, asOfDate) {
  const asOf = isoDate(asOfDate);
  if (!asOf) return 0;
  const feederTotal = feederTargets(feederGroups).reduce(
    (sum, target) => sum + feederTargetCountAt(target, breeders, pigDailys, asOf),
    0,
  );
  const sowsDaily = latestPigDailyCount(pigDailys, 'SOWS', asOf);
  const boarsDaily = latestPigDailyCount(pigDailys, 'BOARS', asOf);
  const sows = sowsDaily ? sowsDaily.count : breederFallbackCount(breeders, asOf, 'sows');
  const boars = boarsDaily ? boarsDaily.count : breederFallbackCount(breeders, asOf, 'boars');
  return feederTotal + sows + boars;
}

function animalStartDate(animal, transfers, groupField) {
  return minISO([
    animal && (animal.purchase_date || animal.purchaseDate),
    animal && animal.created_at,
    ...(transfers || []).map((t) => t && (t.transferred_at || t.created_at)),
    animal && animal.birth_date,
    animal && animal.birthDate,
    animal && animal[groupField] ? new Date().toISOString().slice(0, 10) : null,
  ]);
}

function animalGroupAt(animal, transfers, asOf, groupField, fromField) {
  let group = norm(animal && animal[groupField]);
  const later = [...(transfers || [])].sort((a, b) =>
    (isoDate(b.transferred_at || b.created_at) || '').localeCompare(isoDate(a.transferred_at || a.created_at) || ''),
  );
  for (const transfer of later) {
    const date = isoDate(transfer && (transfer.transferred_at || transfer.created_at));
    if (date && date > asOf) group = norm(transfer[fromField]) || group;
  }
  return group;
}

function animalIsAliveAt(animal, asOf) {
  const sale = isoDate(animal && (animal.sale_date || animal.sold_date));
  const death = isoDate(animal && animal.death_date);
  if (sale && sale <= asOf) return false;
  if (death && death <= asOf) return false;
  return true;
}

function herdCountAt(rows, transfers, asOfDate, {idField, groupField, fromField, activeSet}) {
  const asOf = isoDate(asOfDate);
  if (!asOf) return 0;
  const transfersById = groupById(transfers, idField);
  let count = 0;
  for (const row of rows || []) {
    if (!row || row.deleted_at) continue;
    const rowTransfers = transfersById.get(row.id) || [];
    const start = animalStartDate(row, rowTransfers, groupField);
    if (start && start > asOf) continue;
    if (!animalIsAliveAt(row, asOf)) continue;
    const group = animalGroupAt(row, rowTransfers, asOf, groupField, fromField);
    if (activeSet.has(group)) count += 1;
  }
  return count;
}

export function cattleOnFarmAt(cattle, cattleTransfers, asOfDate) {
  return herdCountAt(cattle, cattleTransfers, asOfDate, {
    idField: 'cattle_id',
    groupField: 'herd',
    fromField: 'from_herd',
    activeSet: ACTIVE_CATTLE_SET,
  });
}

export function sheepOnFarmAt(sheep, sheepTransfers, asOfDate) {
  return herdCountAt(sheep, sheepTransfers, asOfDate, {
    idField: 'sheep_id',
    groupField: 'flock',
    fromField: 'from_flock',
    activeSet: ACTIVE_SHEEP_SET,
  });
}

export function inferAnimalHistoryStartMonth(data = {}) {
  const dates = [];
  for (const b of data.batches || []) dates.push(b.hatchDate, b.hatch_date, b.processingDate, b.processing_date);
  for (const d of data.broilerDailys || []) dates.push(d.date);
  for (const b of data.layerBatches || []) dates.push(b.arrival_date, b.brooder_entry_date, b.start_date);
  for (const h of data.layerHousings || []) dates.push(h.start_date, h.retired_date, h.current_count_date);
  for (const d of data.layerDailys || []) dates.push(d.date);
  for (const g of data.feederGroups || []) {
    dates.push(g.startDate);
    for (const s of g.subBatches || []) dates.push(s.startDate || g.startDate);
    for (const t of g.processingTrips || []) dates.push(t.date);
    for (const m of g.pigMortalities || []) dates.push(m.date || m.created_at);
  }
  for (const b of data.breeders || []) {
    if (b && b.transferredFromBatch) dates.push(b.transferredFromBatch.transferDate);
  }
  for (const d of data.pigDailys || []) dates.push(d.date);
  for (const c of data.cattle || [])
    dates.push(c.purchase_date, c.purchaseDate, c.created_at, c.sale_date, c.sold_date, c.death_date);
  for (const t of data.cattleTransfers || []) dates.push(t.transferred_at, t.created_at);
  for (const s of data.sheep || [])
    dates.push(s.purchase_date, s.purchaseDate, s.created_at, s.sale_date, s.sold_date, s.death_date);
  for (const t of data.sheepTransfers || []) dates.push(t.transferred_at, t.created_at);

  const earliest = minISO(dates);
  return earliest ? earliest.slice(0, 7) : null;
}

export function buildAnimalHistoryRows(data = {}, asOfDate = new Date()) {
  const today = isoDate(asOfDate) || new Date().toISOString().slice(0, 10);
  const startMonth = inferAnimalHistoryStartMonth(data);
  const endMonth = monthKey(today);
  if (!startMonth || !endMonth) return [];
  return monthsBetween(startMonth, endMonth)
    .map((month) => {
      const snapshotDate = snapshotDateForMonth(month, today);
      const row = {
        month,
        snapshotDate,
        broilers: broilersOnFarmAt(data.batches, data.broilerDailys, snapshotDate),
        layers: layersOnFarmAt(data.layerBatches, data.layerHousings, data.layerDailys, snapshotDate),
        pigs: pigsOnFarmAt(data.feederGroups, data.breeders, data.pigDailys, snapshotDate),
        cattle: cattleOnFarmAt(data.cattle, data.cattleTransfers, snapshotDate),
        sheep: sheepOnFarmAt(data.sheep, data.sheepTransfers, snapshotDate),
      };
      row.total = ANIMAL_HISTORY_SPECIES.reduce((sum, s) => sum + row[s.key], 0);
      return row;
    })
    .reverse();
}

export function formatAnimalHistoryMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return month || '';
  const [year, monthNum] = month.split('-').map((v) => parseInt(v, 10));
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {month: 'short', year: 'numeric'});
}

export const _animalHistoryInternals = {
  isoDate,
  monthEnd,
  monthsBetween,
  snapshotDateForMonth,
  feederTargets,
};
