import {shouldAutoProcessBroilerBatch} from './broiler.js';

export const PRODUCTION_PROGRAMS = [
  {key: 'cattle', label: 'Cattle', eventLabel: 'cattle', unit: 'cattle', quantityLabel: 'Processed'},
  {key: 'broiler', label: 'Broilers', eventLabel: 'birds', unit: 'birds', quantityLabel: 'Processed'},
  {key: 'pig', label: 'Pigs', eventLabel: 'pigs', unit: 'pigs', quantityLabel: 'Processed'},
  {key: 'sheep', label: 'Sheep/Lamb', eventLabel: 'lambs', unit: 'lambs', quantityLabel: 'Processed'},
  {key: 'egg', label: 'Eggs/doz', eventLabel: 'doz', unit: 'dozens', quantityLabel: 'Dozens'},
];

export const HOME_PRODUCTION_PROGRAMS = ['broiler', 'egg', 'pig', 'cattle', 'sheep'];
export const PAGE_PRODUCTION_PROGRAMS = ['cattle', 'broiler', 'pig', 'sheep', 'egg'];
// Designer-specified row order for the all-years matrix: Broilers, Pigs, Cattle,
// Sheep/Lamb, then Eggs last. Production Events reuses it for the program
// tie-break when two rows share a date.
export const PRODUCTION_MATRIX_PROGRAM_ORDER = ['broiler', 'pig', 'cattle', 'sheep', 'egg'];
const PLANNER_MATCH_START_DATE = '2024-01-01';
const PLANNER_MATCH_DAY_WINDOW = 3;

export const PROGRAM_BY_KEY = Object.fromEntries(PRODUCTION_PROGRAMS.map((program) => [program.key, program]));

// Per-program accent, mapped onto the shared homeRedesign.css tokens. Eggs reuse
// the layer accent so the ledger color-keys to the same palette as Home.
export const PROGRAM_ACCENT_VAR = {
  broiler: 'var(--c-broiler)',
  egg: 'var(--c-layer)',
  pig: 'var(--c-pig)',
  cattle: 'var(--c-cattle)',
  sheep: 'var(--c-sheep)',
};

// Display metadata for every reconciliation disposition. `counted` mirrors
// whether the row contributes to the per-program total.
export const PRODUCTION_STATUS_META = {
  planner: {label: 'Planner', tone: 'ok', counted: true},
  legacy_only: {label: 'Legacy backfill', tone: 'info', counted: true},
  matched: {label: 'Matched · held out', tone: 'warn', counted: false},
  matched_loose: {label: 'Loose match · held out', tone: 'warn', counted: false},
  superseded: {label: 'Superseded by Planner · held out', tone: 'warn', counted: false},
  conflict: {label: 'Conflict · held out', tone: 'danger', counted: false},
};

export function productionStatusMeta(status) {
  return PRODUCTION_STATUS_META[status] || {label: status || 'Unknown', tone: 'warn', counted: false};
}

export function normalizeProductionProgram(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (['chicken', 'broiler', 'broilers', 'bird', 'birds'].includes(raw)) return 'broiler';
  if (['pig', 'pigs', 'pork', 'feeder pig', 'feeder pigs'].includes(raw)) return 'pig';
  if (['cattle', 'cow', 'beef', 'steer', 'steers'].includes(raw)) return 'cattle';
  if (['lamb', 'lambs', 'sheep', 'mutton'].includes(raw)) return 'sheep';
  if (['egg', 'eggs', 'dozen', 'dozens'].includes(raw)) return 'egg';
  return null;
}

export function normalizeBatchName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const str = String(value).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

export function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonArrayLength(value) {
  if (Array.isArray(value)) return value.length;
  if (!value) return 0;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function makeEvent({
  id,
  program,
  date,
  batchName,
  quantity,
  source,
  sourceTable,
  sourceId,
  sourceLabel,
  raw = null,
  zeroIsReal = false,
}) {
  const cleanProgram = normalizeProductionProgram(program);
  const cleanDate = isoDate(date);
  const cleanQuantity = numeric(quantity);
  if (!cleanProgram || !cleanDate || cleanQuantity === null) return null;
  if (cleanQuantity < 0) return null;
  if (!zeroIsReal && cleanQuantity === 0) return null;
  return {
    id: String(id || `${source}:${cleanProgram}:${cleanDate}:${normalizeBatchName(batchName)}:${cleanQuantity}`),
    program: cleanProgram,
    date: cleanDate,
    year: cleanDate.slice(0, 4),
    batchName: String(batchName || '').trim(),
    batchKey: normalizeBatchName(batchName),
    quantity: cleanQuantity,
    source,
    sourceTable,
    sourceId: sourceId == null ? null : String(sourceId),
    sourceLabel,
    raw,
  };
}

export function buildBroilerProductionEvents(batches = [], {today} = {}) {
  return (batches || [])
    .map((batch, index) => {
      const date = isoDate(batch.processingDate || batch.processing_date);
      const quantity = numeric(batch.totalToProcessor ?? batch.total_to_processor);
      const status = String(batch.status || '').toLowerCase();
      const asOf = isoDate(today) || new Date().toISOString().slice(0, 10);
      const processed =
        status === 'processed' || shouldAutoProcessBroilerBatch(batch, today) || (!status && date && date <= asOf);
      if (!processed) return null;
      return makeEvent({
        id: `planner:broiler:${batch.id || batch.name || index}`,
        program: 'broiler',
        date,
        batchName: batch.name || batch.batchName || batch.batch_name,
        quantity,
        source: 'planner',
        sourceTable: 'app_store.ppp-v4',
        sourceId: batch.id || batch.name || index,
        sourceLabel: 'Planner',
        raw: batch,
      });
    })
    .filter(Boolean);
}

export function buildPigProductionEvents(feederGroups = []) {
  return (feederGroups || [])
    .flatMap((group, groupIndex) =>
      (group.processingTrips || []).map((trip, tripIndex) =>
        makeEvent({
          id: `planner:pig:${group.id || group.batchName || groupIndex}:${trip.id || tripIndex}`,
          program: 'pig',
          date: trip.date,
          batchName: group.batchName || group.name || trip.batchName,
          quantity: trip.pigCount,
          source: 'planner',
          sourceTable: 'app_store.ppp-feeders-v1.processingTrips',
          sourceId: trip.id || `${group.id || groupIndex}:${tripIndex}`,
          sourceLabel: 'Planner',
          raw: {group, trip},
        }),
      ),
    )
    .filter(Boolean);
}

export function buildCattleProductionEvents(batches = []) {
  return (batches || [])
    .map((batch, index) =>
      makeEvent({
        id: `planner:cattle:${batch.id || index}`,
        program: 'cattle',
        date: batch.actual_process_date,
        batchName: batch.name || batch.batch_name,
        quantity: jsonArrayLength(batch.cows_detail),
        source: 'planner',
        sourceTable: 'cattle_processing_batches',
        sourceId: batch.id || index,
        sourceLabel: 'Planner',
        raw: batch,
      }),
    )
    .filter(Boolean);
}

export function buildSheepProductionEvents(batches = []) {
  return (batches || [])
    .map((batch, index) =>
      makeEvent({
        id: `planner:sheep:${batch.id || index}`,
        program: 'sheep',
        date: batch.actual_process_date,
        batchName: batch.name || batch.batch_name,
        quantity: jsonArrayLength(batch.sheep_detail),
        source: 'planner',
        sourceTable: 'sheep_processing_batches',
        sourceId: batch.id || index,
        sourceLabel: 'Planner',
        raw: batch,
      }),
    )
    .filter(Boolean);
}

export function eggCountForDaily(row) {
  return (
    (numeric(row.group1_count) || 0) +
    (numeric(row.group2_count) || 0) +
    (numeric(row.group3_count) || 0) +
    (numeric(row.group4_count) || 0)
  );
}

export function buildEggProductionEvents(eggDailys = []) {
  return (eggDailys || [])
    .map((daily, index) =>
      makeEvent({
        id: `planner:egg:${daily.id || daily.date || index}`,
        program: 'egg',
        date: daily.date,
        batchName: [daily.group1_name, daily.group2_name, daily.group3_name, daily.group4_name]
          .filter(Boolean)
          .join(', '),
        quantity: eggCountForDaily(daily),
        source: 'planner',
        sourceTable: 'egg_dailys',
        sourceId: daily.id || index,
        sourceLabel: 'Planner',
        raw: daily,
      }),
    )
    .filter(Boolean);
}

export function buildLegacyProductionEvents(rows = []) {
  return (rows || [])
    .map((row, index) => {
      const reviewStatus = row.review_status || 'approved';
      if (reviewStatus === 'rejected') return null;
      return makeEvent({
        id: `legacy:${row.id || row.source_key || index}`,
        program: row.program || row.raw_program,
        date: row.event_date || row.date,
        batchName: row.batch_name || row.batchName,
        quantity: row.quantity ?? row.count,
        source: 'legacy',
        sourceTable: 'production_legacy_events',
        sourceId: row.id || row.source_key || index,
        sourceLabel: 'Legacy spreadsheet',
        raw: row,
        zeroIsReal: true,
      });
    })
    .filter(Boolean);
}

function exactEventKey(event) {
  return [event.program, event.date, event.batchKey, event.quantity].join('|');
}

function looseEventKey(event) {
  return [event.program, event.date, event.quantity].join('|');
}

function indexEvents(events, keyFn) {
  const map = new Map();
  for (const event of events) {
    const key = keyFn(event);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(event);
  }
  return map;
}

// Classify a held-out legacy row against Planner for the audit view. Counting is
// decided by coverage (see reconcileProductionEvents); this only labels WHY a
// legacy row in a Planner-covered program/year is held.
function classifyCoveredLegacy(legacyEvent, plannerEvents, plannerByExact, plannerByLoose) {
  if (legacyEvent.batchKey) {
    const exact = plannerByExact.get(exactEventKey(legacyEvent)) || [];
    if (exact.length >= 1) {
      return {
        status: 'matched',
        plannerEvent: exact[0],
        reason: 'Same program, date, batch, and count already exist in Planner.',
      };
    }
  }
  const loose = plannerByLoose.get(looseEventKey(legacyEvent)) || [];
  if (loose.length >= 1) {
    return {
      status: 'matched_loose',
      plannerEvent: loose[0],
      reason: 'Same program, date, and count already exist in Planner; legacy batch name is blank or different.',
    };
  }
  // Same program + date but a different count (or same batch identity): a real
  // conflict where Planner wins.
  const sameDate = plannerEvents.filter(
    (event) => event.program === legacyEvent.program && event.date === legacyEvent.date,
  );
  if (sameDate.length > 0) {
    const sameBatch = legacyEvent.batchKey ? sameDate.find((event) => event.batchKey === legacyEvent.batchKey) : null;
    return {
      status: 'conflict',
      plannerEvent: sameBatch || sameDate[0],
      reason: 'Planner has the same event identity with a different count. Planner wins until reviewed.',
    };
  }
  // Same batch name elsewhere in Planner: the legacy row is the same batch dated
  // at a different time (e.g. an export-time stamp).
  if (legacyEvent.batchKey) {
    const sameBatch = plannerEvents.find(
      (event) => event.program === legacyEvent.program && event.batchKey === legacyEvent.batchKey,
    );
    if (sameBatch) {
      return {
        status: 'matched',
        plannerEvent: sameBatch,
        reason: `Planner already has batch ${legacyEvent.batchName}; the legacy row is the same batch dated differently.`,
      };
    }
  }
  return {
    status: 'superseded',
    plannerEvent: null,
    reason: 'Planner has records for this program and year, so the legacy row is held as backfill (Planner wins).',
  };
}

// Planner wins by coverage: for any program+year Planner has events, Planner IS
// the total and legacy rows are held as backfill (no per-row date/name guessing
// that can double-count). Legacy counts only for program+years Planner has
// nothing — pre-Planner history. Eggs are Planner-only and unaffected.
export function reconcileProductionEvents({plannerEvents = [], legacyEvents = []} = {}) {
  const combined = plannerEvents.map((event) => ({
    ...event,
    reconciliationStatus: 'planner',
    reason: 'Counted from the Planner record.',
  }));
  const audit = [];
  const plannerCoverage = new Set(plannerEvents.map((event) => `${event.program}|${event.year}`));
  const plannerByExact = indexEvents(plannerEvents, exactEventKey);
  const plannerByLoose = indexEvents(plannerEvents, looseEventKey);

  for (const legacyEvent of legacyEvents) {
    const covered = plannerCoverage.has(`${legacyEvent.program}|${legacyEvent.year}`);
    if (covered) {
      const {status, plannerEvent, reason} = classifyCoveredLegacy(
        legacyEvent,
        plannerEvents,
        plannerByExact,
        plannerByLoose,
      );
      audit.push({legacyEvent, plannerEvent, status, counted: false, reason});
      continue;
    }

    const reason = 'Only found in the legacy backfill (no Planner records for this program and year).';
    combined.push({...legacyEvent, reconciliationStatus: 'legacy_only', reason});
    audit.push({legacyEvent, plannerEvent: null, status: 'legacy_only', counted: true, reason});
  }

  return {
    events: combined.sort((a, b) => b.date.localeCompare(a.date) || a.program.localeCompare(b.program)),
    audit,
  };
}

export function buildPlannerProductionEvents({
  batches = [],
  feederGroups = [],
  cattleProcessingBatches = [],
  sheepProcessingBatches = [],
  eggDailys = [],
  today,
} = {}) {
  return [
    ...buildBroilerProductionEvents(batches, {today}),
    ...buildPigProductionEvents(feederGroups),
    ...buildCattleProductionEvents(cattleProcessingBatches),
    ...buildSheepProductionEvents(sheepProcessingBatches),
    ...buildEggProductionEvents(eggDailys),
  ];
}

export function buildProductionYearRows(events = [], programKey) {
  const totals = new Map();
  for (const event of events) {
    if (event.program !== programKey) continue;
    totals.set(event.year, (totals.get(event.year) || 0) + event.quantity);
  }
  const years = [...totals.keys()].sort();
  return years.map((year, index) => {
    const quantity = totals.get(year) || 0;
    const prevYear = years[index - 1];
    const previous = prevYear ? totals.get(prevYear) : null;
    return {
      year,
      quantity,
      yoy: previous === null || previous === undefined ? null : quantity - previous,
    };
  });
}

export function buildProductionModel(sources = {}) {
  const plannerEvents = buildPlannerProductionEvents(sources);
  const legacyEvents = buildLegacyProductionEvents(sources.legacyEvents || []);
  const reconciliation = reconcileProductionEvents({plannerEvents, legacyEvents});
  const years = [...new Set(reconciliation.events.map((event) => event.year))].sort();
  const programRows = Object.fromEntries(
    PAGE_PRODUCTION_PROGRAMS.map((programKey) => [
      programKey,
      buildProductionYearRows(reconciliation.events, programKey),
    ]),
  );
  return {
    plannerEvents,
    legacyEvents,
    events: reconciliation.events,
    audit: reconciliation.audit,
    years,
    programRows,
  };
}

// Program × Year matrix for the Summary view. Reuses the reconciled per-program
// year rows (model.programRows) and the union year list (model.years); ignores
// any selected-year drill-in. Each cell is display-ready: the total on top and
// the YoY delta beneath, where YoY compares to that program's PREVIOUS RECORDED
// year (the row's own yoy). Missing program/year -> total "—" + delta "—"; a
// real zero -> "0"; flat YoY -> "±0"; eggs in dozens (one decimal). The latest
// recorded year is flagged for the emphasis wash + bold total.
export function buildProductionMatrix(model) {
  const years = [...new Set(((model && model.years) || []).map(String))].sort();
  const latest = years.length ? years[years.length - 1] : null;
  const programRows = (model && model.programRows) || {};
  const matrixLabel = (programKey) => (PROGRAM_BY_KEY[programKey]?.label || programKey).replace('/doz', '');
  const rows = PRODUCTION_MATRIX_PROGRAM_ORDER.map((programKey) => {
    const byYear = new Map((programRows[programKey] || []).map((row) => [String(row.year), row]));
    const cells = years.map((year) => {
      const row = byYear.get(year);
      const isLatest = year === latest;
      if (!row) {
        return {
          year,
          isLatest,
          hasData: false,
          total: null,
          totalText: '—',
          delta: null,
          deltaText: '—',
          deltaKind: 'none',
        };
      }
      let deltaText = '—';
      let deltaKind = 'none';
      if (row.yoy !== null && row.yoy !== undefined) {
        const display = quantityForDisplay(programKey, row.yoy);
        const rounded = programKey === 'egg' ? Math.round(display * 10) / 10 : Math.round(display);
        if (rounded === 0) {
          deltaText = '±0';
          deltaKind = 'flat';
        } else {
          deltaText = formatProductionDelta(programKey, row.yoy);
          deltaKind = rounded > 0 ? 'up' : 'down';
        }
      }
      return {
        year,
        isLatest,
        hasData: true,
        total: row.quantity,
        totalText: formatProductionNumber(programKey, row.quantity),
        delta: row.yoy,
        deltaText,
        deltaKind,
      };
    });
    return {programKey, label: matrixLabel(programKey), accent: PROGRAM_ACCENT_VAR[programKey], cells};
  });
  return {years, latest, rows};
}

function daysBetweenIso(a, b) {
  const da = isoDate(a);
  const db = isoDate(b);
  if (!da || !db) return Infinity;
  const ta = Date.parse(`${da}T00:00:00Z`);
  const tb = Date.parse(`${db}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

function eventRecordPath(event) {
  if (!event) return null;
  if (event.program === 'broiler' && event.batchName) {
    return `/broiler/batches/${encodeURIComponent(event.batchName)}`;
  }
  if (event.program === 'pig' && event.raw && event.raw.group && event.raw.group.id) {
    return `/pig/batches/${encodeURIComponent(event.raw.group.id)}`;
  }
  if (event.program === 'cattle' && event.sourceTable === 'cattle_processing_batches' && event.sourceId) {
    return `/cattle/batches/${encodeURIComponent(event.sourceId)}`;
  }
  if (event.program === 'sheep' && event.sourceTable === 'sheep_processing_batches' && event.sourceId) {
    return `/sheep/batches/${encodeURIComponent(event.sourceId)}`;
  }
  return null;
}

function findUniquePlannerMatch(event, plannerEvents) {
  if (!event || event.source !== 'legacy' || event.program === 'egg' || event.date < PLANNER_MATCH_START_DATE) {
    return null;
  }
  const quantity = Number(event.quantity);
  if (!Number.isFinite(quantity)) return null;
  const candidates = (plannerEvents || [])
    .filter((candidate) => {
      if (!candidate || candidate.program !== event.program || candidate.program === 'egg') return false;
      if (Number(candidate.quantity) !== quantity) return false;
      return daysBetweenIso(candidate.date, event.date) <= PLANNER_MATCH_DAY_WINDOW;
    })
    .map((candidate) => ({
      candidate,
      dayDistance: daysBetweenIso(candidate.date, event.date),
      batchMatch: event.batchKey && event.batchKey === candidate.batchKey ? 0 : 1,
    }))
    .sort((a, b) => a.dayDistance - b.dayDistance || a.batchMatch - b.batchMatch);

  if (candidates.length === 0) return null;
  const best = candidates[0];
  const tied = candidates.filter(
    (item) => item.dayDistance === best.dayDistance && item.batchMatch === best.batchMatch,
  );
  return tied.length === 1 ? best.candidate : null;
}

// Production Events view: the operator-facing event/history log (NOT the totals
// reconciliation). Shows actual processing events — Planner processing events
// (eggs excluded; egg-day records are not processing events) plus EVERY imported
// production_legacy_events row, including rows held out of Summary totals by the
// coverage rule. Optional year filter narrows the list; within a year all
// imported production events stay visible. Sorted by date desc, then program.
export function buildProductionEventsView(model, {year} = {}) {
  const order = Object.fromEntries(PRODUCTION_MATRIX_PROGRAM_ORDER.map((programKey, index) => [programKey, index]));
  const planner = ((model && model.plannerEvents) || []).filter((event) => event.program !== 'egg');
  const legacy = ((model && model.legacyEvents) || []).filter((event) => event.program !== 'egg');
  const yearStr = year === null || year === undefined || year === '' ? null : String(year);
  return [...planner, ...legacy]
    .filter((event) => (yearStr ? event.year === yearStr : true))
    .sort((a, b) => b.date.localeCompare(a.date) || (order[a.program] ?? 9) - (order[b.program] ?? 9))
    .map((event) => {
      const matchedPlannerEvent = findUniquePlannerMatch(event, planner);
      const batchName = event.batchName || (matchedPlannerEvent && matchedPlannerEvent.batchName) || '';
      const recordPath =
        (event.source === 'legacy' ? null : eventRecordPath(event)) || eventRecordPath(matchedPlannerEvent) || '';
      return {
        id: event.id,
        date: event.date,
        program: event.program,
        batchName,
        quantity: event.quantity,
        recordPath,
        matchedBatchName: matchedPlannerEvent ? matchedPlannerEvent.batchName : '',
        event,
      };
    });
}

export function quantityForDisplay(programKey, quantity) {
  if (quantity === null || quantity === undefined) return null;
  return programKey === 'egg' ? quantity / 12 : quantity;
}

export function formatProductionNumber(programKey, quantity) {
  if (quantity === null || quantity === undefined) return '--';
  const display = quantityForDisplay(programKey, quantity);
  if (programKey === 'egg') {
    const rounded = Math.round(display * 10) / 10;
    return rounded.toLocaleString(undefined, {
      minimumFractionDigits: rounded % 1 === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    });
  }
  return Math.round(display).toLocaleString();
}

export function formatProductionDelta(programKey, delta) {
  if (delta === null || delta === undefined) return '--';
  const display = quantityForDisplay(programKey, delta);
  const rounded = programKey === 'egg' ? Math.round(display * 10) / 10 : Math.round(display);
  if (rounded === 0) return '0';
  const abs = Math.abs(rounded).toLocaleString(undefined, {
    minimumFractionDigits: programKey === 'egg' && Math.abs(rounded) % 1 !== 0 ? 1 : 0,
    maximumFractionDigits: programKey === 'egg' ? 1 : 0,
  });
  return `${rounded > 0 ? '+' : '-'}${abs}`;
}

export function formatEventQuantity(event) {
  if (!event) return '--';
  const program = PROGRAM_BY_KEY[event.program];
  const value = formatProductionNumber(event.program, event.quantity);
  return `${value} ${program ? program.eventLabel : ''}`.trim();
}

export function totalsForYear(events = [], year) {
  const yearStr = String(year);
  const totals = new Map();
  for (const event of events) {
    if (event.year !== yearStr) continue;
    totals.set(event.program, (totals.get(event.program) || 0) + event.quantity);
  }
  return totals;
}

// Per-program summary for a single year. Decomposes the counted total into
// Planner vs legacy backfill, plus the held-out legacy rows (Planner wins).
export function buildProductionSummary(model, year) {
  const yearStr = String(year);
  const events = (model && model.events) || [];
  const audit = (model && model.audit) || [];
  const programRows = (model && model.programRows) || {};
  const sum = (list) => list.reduce((total, item) => total + (item.quantity || 0), 0);
  return PAGE_PRODUCTION_PROGRAMS.map((programKey) => {
    const inYear = (event) => event.program === programKey && event.year === yearStr;
    const countedRows = events.filter(inYear);
    const counted = sum(countedRows);
    const plannerCounted = sum(countedRows.filter((event) => event.source === 'planner'));
    const legacyCounted = sum(countedRows.filter((event) => event.source === 'legacy'));
    const heldRows = audit.filter(
      (row) => !row.counted && row.legacyEvent.program === programKey && row.legacyEvent.year === yearStr,
    );
    const heldOut = heldRows.reduce((total, row) => total + (row.legacyEvent.quantity || 0), 0);
    const conflict = heldRows
      .filter((row) => row.status === 'conflict')
      .reduce((total, row) => total + (row.legacyEvent.quantity || 0), 0);
    const yoyRow = (programRows[programKey] || []).find((row) => row.year === yearStr);
    return {
      programKey,
      label: PROGRAM_BY_KEY[programKey].label,
      accent: PROGRAM_ACCENT_VAR[programKey],
      counted,
      plannerCounted,
      legacyCounted,
      heldOut,
      conflict,
      yoy: yoyRow ? yoyRow.yoy : null,
    };
  });
}

function decorateLedgerRow(event, {counted, status, reason}) {
  const meta = productionStatusMeta(status);
  return {
    id: `${event.id}:${status}`,
    date: event.date,
    program: event.program,
    batchName: event.batchName,
    quantity: event.quantity,
    source: event.source,
    counted,
    status,
    statusLabel: meta.label,
    tone: meta.tone,
    reason,
    event,
  };
}

// Counted events for a year (Planner + legacy-only), annotated with status,
// reason, and tone so the ledger can render reconciliation state inline.
export function buildProductionLedger(model, year) {
  const yearStr = String(year);
  return ((model && model.events) || [])
    .filter((event) => event.year === yearStr)
    .map((event) => {
      const status = event.reconciliationStatus || (event.source === 'legacy' ? 'legacy_only' : 'planner');
      const reason =
        event.reason ||
        (event.source === 'legacy'
          ? 'Only found in the legacy spreadsheet backfill.'
          : 'Counted from the Planner record.');
      return decorateLedgerRow(event, {counted: true, status, reason});
    });
}

// Every legacy backfill row's disposition for a year, counted or held out, with the
// reason surfaced as data (not a title hover).
export function buildProductionAuditView(model, year) {
  const yearStr = String(year);
  return ((model && model.audit) || [])
    .filter((row) => row.legacyEvent.year === yearStr)
    .map((row) => decorateLedgerRow(row.legacyEvent, {counted: row.counted, status: row.status, reason: row.reason}));
}

export function homeProductionStats(model, year = new Date().getFullYear()) {
  const totals = totalsForYear(model && model.events ? model.events : [], year);
  return HOME_PRODUCTION_PROGRAMS.map((programKey) => ({
    programKey,
    label: PROGRAM_BY_KEY[programKey].label.replace('/doz', ''),
    value: totals.has(programKey) ? formatProductionNumber(programKey, totals.get(programKey)) : '--',
  }));
}
