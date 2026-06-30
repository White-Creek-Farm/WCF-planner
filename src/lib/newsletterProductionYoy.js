// ============================================================================
// newsletterProductionYoy — year-over-year production totals for the newsletter.
// ----------------------------------------------------------------------------
// Pure ESM. NO imports. NO Node/Deno APIs. NO `Date` use (the harvest passes
// `today`/`thisYear`/`lastYear` in). Runs identically in vitest (Node) and the
// newsletter-harvest Edge Function (Deno).
//
// Source-of-truth copy lives at src/lib; a byte-identical copy lives at
//   supabase/functions/_shared/newsletterProductionYoy.js
// Drift is locked by tests/static/newsletter_shared_parity.test.js.
//
// WHY: Ronnie wants a "production numbers, year over year" section that matches
// the Production tab. The tab's per-program annual totals (src/lib/production.js)
// follow program-specific quantity rules and a "Planner-wins-by-coverage" rule
// (for any program+year the Planner has events, the Planner IS the total; legacy
// spreadsheet rows only backfill program+years the Planner never recorded). This
// module mirrors those exact rules — broiler totalToProcessor (processed by the
// tab's predicate), pig processing-trip pigCount, cattle cows_detail / sheep
// sheep_detail head, eggs summed and shown in DOZENS — so the newsletter's YoY
// numbers equal the tab's for planner-era years.
//
// FINANCE/MORTALITY BOUNDARY: only production OUTPUT quantities are read; no
// cost/price/death fields are ever touched.
// ============================================================================

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function isoDate(v) {
  const s = v == null ? '' : String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function yearOf(v) {
  const d = isoDate(v);
  return d ? d.slice(0, 4) : '';
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

// Mirror of broiler.js shouldAutoProcessBroilerBatch: an active batch is counted
// as processed once today reaches its processingDate (inclusive).
function broilerProcessed(batch, today) {
  const status = String((batch && batch.status) || '').toLowerCase();
  if (status === 'processed') return true;
  const procDate = isoDate((batch && (batch.processingDate || batch.processing_date)) || '');
  if (!procDate) return false;
  const asOf = isoDate(today) || '9999-12-31';
  if (status === 'active') return asOf >= procDate;
  // No explicit status: the tab treats a past processingDate as processed.
  if (!status) return procDate <= asOf;
  return false;
}

function eggCountForDaily(row) {
  return (
    (num(row && row.group1_count) || 0) +
    (num(row && row.group2_count) || 0) +
    (num(row && row.group3_count) || 0) +
    (num(row && row.group4_count) || 0)
  );
}

// ── Per-program planner events → {program, year, quantity} ───────────────────
// Each builder yields the SAME quantity the Production tab counts.
function plannerEvents(sources, today) {
  const out = [];
  const push = (program, date, quantity) => {
    const y = yearOf(date);
    const q = num(quantity);
    if (!y || q === null || q < 0) return;
    out.push({program, year: y, quantity: q});
  };

  for (const b of arr(sources.broilerBatches)) {
    if (!broilerProcessed(b, today)) continue;
    push(
      'broiler',
      (b && (b.processingDate || b.processing_date)) || '',
      num(b && (b.totalToProcessor ?? b.total_to_processor)) || 0,
    );
  }
  for (const g of arr(sources.feederGroups)) {
    for (const t of arr(g && g.processingTrips)) {
      push('pig', t && t.date, t && t.pigCount);
    }
  }
  for (const b of arr(sources.cattleProcessingBatches)) {
    push('cattle', b && b.actual_process_date, jsonArrayLength(b && b.cows_detail));
  }
  for (const b of arr(sources.sheepProcessingBatches)) {
    push('sheep', b && b.actual_process_date, jsonArrayLength(b && b.sheep_detail));
  }
  for (const d of arr(sources.eggDailys)) {
    push('egg', d && d.date, eggCountForDaily(d));
  }
  return out;
}

function legacyEvents(rows) {
  const out = [];
  for (const r of arr(rows)) {
    if (!r || typeof r !== 'object') continue;
    if ((r.review_status || 'approved') === 'rejected') continue;
    const program = String(r.program || r.raw_program || '')
      .trim()
      .toLowerCase();
    const y = yearOf(r.event_date || r.date);
    const q = num(r.quantity ?? r.count);
    if (!program || !y || q === null || q < 0) continue;
    out.push({program, year: y, quantity: q});
  }
  return out;
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// Planner-wins-by-coverage total for a program+year: Planner sum if Planner has
// ANY event that program+year, else the legacy backfill sum.
function totalFor(planner, legacy, program, year) {
  let plannerSum = 0;
  let plannerHas = false;
  for (const e of planner) {
    if (e.program === program && e.year === year) {
      plannerSum += e.quantity;
      plannerHas = true;
    }
  }
  if (plannerHas) return plannerSum;
  let legacySum = 0;
  for (const e of legacy) {
    if (e.program === program && e.year === year) legacySum += e.quantity;
  }
  return legacySum;
}

// Program display order + labels/units, mirroring the Production tab.
export const YOY_PROGRAMS = Object.freeze([
  {key: 'cattle', label: 'Cattle', unit: 'cattle'},
  {key: 'broiler', label: 'Broilers', unit: 'birds'},
  {key: 'pig', label: 'Pigs', unit: 'pigs'},
  {key: 'sheep', label: 'Sheep / lamb', unit: 'lambs'},
  {key: 'egg', label: 'Eggs', unit: 'dozens'},
]);

// Eggs are reported in DOZENS (matching the tab); everything else is head/birds.
function displayQty(program, q) {
  if (q === null || q === undefined) return null;
  return program === 'egg' ? q / 12 : q;
}

export function formatYoyNumber(program, q) {
  const d = displayQty(program, q);
  if (d === null) return '0';
  if (program === 'egg') {
    const r = Math.round(d * 10) / 10;
    return r.toLocaleString(undefined, {minimumFractionDigits: r % 1 === 0 ? 0 : 1, maximumFractionDigits: 1});
  }
  return Math.round(d).toLocaleString();
}

export function formatYoyDelta(program, delta) {
  const d = displayQty(program, delta);
  if (d === null) return '0';
  const r = program === 'egg' ? Math.round(d * 10) / 10 : Math.round(d);
  if (r === 0) return 'no change';
  const abs = Math.abs(r).toLocaleString(undefined, {
    minimumFractionDigits: program === 'egg' && Math.abs(r) % 1 !== 0 ? 1 : 0,
    maximumFractionDigits: program === 'egg' ? 1 : 0,
  });
  return `${r > 0 ? '▲ ' : '▼ '}${abs}`;
}

// Compute YoY totals for thisYear vs lastYear across all programs.
//   sources: { broilerBatches, feederGroups, cattleProcessingBatches,
//              sheepProcessingBatches, eggDailys, legacyEvents }
//   opts:    { thisYear: '2026', lastYear: '2025', today: 'YYYY-MM-DD' }
// Returns { thisYear, lastYear, programs: [{key,label,unit,current,previous,delta}] }
// — only programs with data in either year are included.
export function computeProductionYoy(sources, opts) {
  const o = opts || {};
  const thisYear = String(o.thisYear || '');
  const lastYear = String(o.lastYear || '');
  const today = o.today || '';
  const src = sources || {};
  const planner = plannerEvents(src, today);
  const legacy = legacyEvents(src.legacyEvents);

  const programs = [];
  for (const p of YOY_PROGRAMS) {
    const current = totalFor(planner, legacy, p.key, thisYear);
    const previous = totalFor(planner, legacy, p.key, lastYear);
    if (current <= 0 && previous <= 0) continue; // nothing to report for this program
    programs.push({key: p.key, label: p.label, unit: p.unit, current, previous, delta: current - previous});
  }
  return {thisYear, lastYear, programs};
}

export const PRODUCTION_YOY_HEADING = 'Production — year over year';

// Remove a previously-appended YoY section from a block list (the optional
// leading divider + the heading + the contiguous paragraph/stats run that
// follows it). Used to (a) keep it out of the current-draft sample sent to the
// AI on a revise, and (b) replace it cleanly on every regeneration so it never
// duplicates. Pure; identifies the section by our exact heading text.
export function stripProductionYoyBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks.slice() : [];
  const i = list.findIndex(
    (b) => b && typeof b === 'object' && b.type === 'heading' && String(b.text || '').trim() === PRODUCTION_YOY_HEADING,
  );
  if (i < 0) return list;
  let start = i;
  if (start > 0 && list[start - 1] && list[start - 1].type === 'divider') start -= 1;
  // The section is exactly heading → paragraph → stats; consume those only (not a
  // greedy run, so an unrelated paragraph after the section is never removed).
  let end = i + 1;
  if (list[end] && list[end].type === 'paragraph') end += 1;
  if (list[end] && list[end].type === 'stats') end += 1;
  list.splice(start, end - start);
  return list;
}

// Build the deterministic "Production — year over year" draft section (whitelisted
// blocks only). Returns [] when there is nothing to show. Numbers are EXACT (never
// AI-authored): a stats block, one cell per program, value = this-year figure with
// the signed YoY delta vs last year.
export function buildProductionYoyBlocks(yoy) {
  if (!yoy || !Array.isArray(yoy.programs) || yoy.programs.length === 0) return [];
  const items = yoy.programs.map((p) => ({
    label: p.key === 'egg' ? 'Eggs (doz)' : p.label,
    value: `${formatYoyNumber(p.key, p.current)} (${formatYoyDelta(p.key, p.delta)} vs ${yoy.lastYear})`,
  }));
  return [
    {type: 'divider'},
    {type: 'heading', text: PRODUCTION_YOY_HEADING, level: 2},
    {
      type: 'paragraph',
      text: `How ${yoy.thisYear} is tracking against ${yoy.lastYear} across the farm’s production programs.`,
    },
    {type: 'stats', items},
  ];
}
