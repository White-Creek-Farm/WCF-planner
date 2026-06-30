// ============================================================================
// newsletterFacts — Monthly Newsletter fact detectors (CP-B).
// ----------------------------------------------------------------------------
// Pure ESM. NO imports. NO Node/Deno APIs. NO `Date` use (the reporting period
// is passed in as 'YYYY-MM-DD' strings, and ISO date strings sort
// lexicographically, so all windowing is plain string/number math). This keeps
// the module deterministic and identically runnable in vitest (Node) and the
// newsletter-harvest Edge Function (Deno).
//
// Source-of-truth for the detector algorithm. A byte-identical copy lives at
//   supabase/functions/_shared/newsletterFacts.js
// (the Edge Function imports the shared copy via Deno's relative ESM
// resolution). Drift is locked by tests/static/newsletter_shared_parity.test.js.
//
// CONTRACT — detectNewsletterFacts(input) -> Fact[]
//   input = {
//     period:           { yearMonth, start, end },   // 'YYYY-MM' + two 'YYYY-MM-DD'
//     broilerBatches:   [...],   // app_store 'ppp-v4'
//     pigFeederGroups:  [...],   // app_store 'ppp-feeders-v1'
//     pigFarrowings:    [...],   // app_store 'ppp-farrowing-v1'
//     cattleHerds:      [...],   // shaped from `cattle` (active head, by herd)
//     cattleBirths:     [...],   // shaped from cattle_calving_records (born-alive)
//     sheepFlocks:      [...],   // shaped from `sheep` (active head, by flock)
//     sheepBirths:      [...],   // shaped from sheep_lambing_records (born-alive)
//     layerProduction:  [...],   // shaped from egg_dailys (summed group counts)
//     pastureMoves:     [...],   // shaped from pasture_move_events
//     dailySubmissions: [...],   // shaped from daily_submissions
//     completedTasks:   [...],   // shaped from task_instances (status=completed)
//     processingBatches:[...],   // shaped from cattle/sheep_processing_batches
//   }
//   The DB-row → input shaping (born-alive math, grouping, egg summing) lives in
//   the pure newsletterHarvestShape module; this module only runs detectors.
//   Fact = {
//     detectorKey, program, title, summary, metricValue, displayValue,
//     sourceRefs:[...], comparison:{}, confidence:'high'|'medium'|'low',
//     evidence:{...},
//   }
//
// EDITORIAL BOUNDARY (locked by the Monthly Newsletter contract):
//   The newsletter is fact-based POSITIVE PR. Detectors emit ONLY good-news,
//   evidence-backed accomplishments. They NEVER read or emit finances or
//   mortalities. assertNoForbiddenFacts() is a defense-in-depth final filter:
//   any candidate whose text trips the finance/mortality denylist is dropped
//   (the DB ingest RPC re-checks the same boundary).
// ============================================================================

// ── Finance / mortality boundary (defense in depth) ─────────────────────────
// Matches whole words so "processed" / "production" are NOT caught while
// "mortality" / "price" are. Processing & production are accomplishments and
// stay allowed; sales/prices/costs (finance) and deaths (mortality) are out.
const FORBIDDEN_FACT_RE =
  /\b(?:mortalit(?:y|ies)|died|death|deaths|dead|deceased|perished|cull|culled|culls|loss|losses|price|priced|pricing|cost|costs|revenue|profit|profits|income|expense|expenses|dollar|dollars|sale|sales|sold|invoice|invoiced|paid|payment|earnings)\b/i;

// Whole-text finance/mortality check. Exported so detectors that fold free text
// (e.g. task titles) into a fact can drop individual unsafe strings BEFORE they
// reach the fact — one bad title then neither leaks nor nukes the whole fact.
export function isForbiddenText(s) {
  const t = typeof s === 'string' ? s : '';
  return FORBIDDEN_FACT_RE.test(t) || /\$/.test(t);
}

export function isForbiddenFact(fact) {
  if (!fact || typeof fact !== 'object') return true;
  const haystack = `${fact.title || ''} ${fact.summary || ''} ${fact.displayValue || ''} ${fact.program || ''} ${fact.detectorKey || ''}`;
  return isForbiddenText(haystack);
}

// ── Small pure helpers ──────────────────────────────────────────────────────

function str(v) {
  if (v == null) return '';
  return String(v).trim();
}

function firstNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of keys) {
    if (obj[k] != null && Number.isFinite(Number(obj[k]))) return Number(obj[k]);
  }
  return 0;
}

function firstStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const s = str(obj[k]);
    if (s) return s;
  }
  return '';
}

// Normalize any value to a 'YYYY-MM-DD' string (or '' if not a date).
function isoDay(v) {
  const s = str(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Inclusive period membership using lexical compare on ISO day strings.
function inPeriod(dateStr, period) {
  const d = isoDay(dateStr);
  if (!d || !period) return false;
  return d >= str(period.start) && d <= str(period.end);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// One calendar day before an ISO day (UTC math, deterministic). '' if not a date.
// A broiler batch is BROUGHT to the processor the day before its processingDate
// (Ronnie: "the date it goes to the processor is always 1 day before the
// processing date"), so monthly "brought to processing" windows on this date.
function isoDayMinusOne(v) {
  const s = isoDay(v);
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

// Born-alive ONLY. We never fall back to totalBorn/litterSize, which include
// stillborn — publishing those as "piglets born alive" would be a mortality leak.
const PIG_BORN_ALIVE_KEYS = ['bornAlive', 'liveBorn', 'liveBirths', 'pigletsBornAlive', 'alive'];
const CATTLE_HEAD_KEYS = ['headCount', 'currentCount', 'count', 'head', 'animals', 'quantity'];
const SHEEP_HEAD_KEYS = ['headCount', 'currentCount', 'count', 'head', 'animals', 'quantity'];

// On-farm = a flock that has hatched and is not yet processed. Anything not
// explicitly 'active' (planned/processed/inactive/...) has no birds on the
// ground, so it is excluded — counting 'planned' batches was the inflation bug.
// Mirrors calcPoultryStatus(b) === 'active' in src/lib/broiler.js (the app
// auto-reconciles a batch's stored status to that computed status on load).
function isBroilerActive(batch) {
  return firstStr(batch, ['status']).toLowerCase() === 'active';
}

function pluralBirds(n) {
  return `${n} bird${n === 1 ? '' : 's'}`;
}

// ── Detectors ───────────────────────────────────────────────────────────────
// Each returns a Fact or null. A null means "no positive, evidence-backed story
// this month" (insufficient data, zero metric, etc.) and is dropped.

export function detectBroilerOnFarm(input) {
  const batches = asArray(input.broilerBatches).filter(isBroilerActive);
  let total = 0;
  const ids = [];
  for (const b of batches) {
    // Current birds = day-one placed (birdCountActual) minus cumulative
    // mortality, clamped >= 0 — mirrors computeBroilerOnFarmCounts' projectedBirds
    // in src/lib/broiler.js. NOT the ordered birdCount (a plan, not head on the
    // ground), which counted thousands of un-hatched birds.
    const c = Math.max(0, firstNum(b, ['birdCountActual']) - firstNum(b, ['mortalityCumulative']));
    if (c > 0) {
      total += c;
      ids.push(firstStr(b, ['name', 'batchName', 'id']));
    }
  }
  if (total <= 0) return null;
  return {
    detectorKey: 'broiler_on_farm',
    program: 'broiler',
    title: 'Broilers on the farm',
    summary: `${pluralBirds(total)} across ${ids.length} active flock${ids.length === 1 ? '' : 's'} at month end.`,
    metricValue: total,
    displayValue: pluralBirds(total),
    sourceRefs: [{module: 'ppp-v4', ids}],
    comparison: {},
    confidence: 'high',
    evidence: {flockCount: ids.length, totalBirds: total, flocks: ids},
  };
}

// Broilers brought to the processor this month. Mirrors the canonical app /
// Production-tab logic (src/lib/production.js buildBroilerProductionEvents): the
// bird count is the batch's totalToProcessor, NOT a "processed count" field
// (those are never populated in the data). "Brought to processing" is the day
// BEFORE the batch's processingDate (the batch physically goes to the processor
// a day ahead), so we window on processingDate − 1. A batch already brought but
// not yet tallied (totalToProcessor not entered, e.g. tonight's run) falls back
// to its projected live birds (birdCountActual − mortalityCumulative) so the
// issue reflects it immediately and self-corrects to the exact totalToProcessor
// once entered.
export function detectBroilerProcessed(input) {
  const batches = asArray(input.broilerBatches);
  let total = 0;
  const flocks = [];
  for (const b of batches) {
    if (firstStr(b, ['status']).toLowerCase() === 'planned') continue;
    const procDate = isoDay(firstStr(b, ['processingDate', 'processing_date', 'processedDate']));
    if (!procDate) continue;
    const broughtDate = isoDayMinusOne(procDate);
    if (!broughtDate || !inPeriod(broughtDate, input.period)) continue;
    const recorded = firstNum(b, ['totalToProcessor', 'total_to_processor']);
    const projected = Math.max(0, firstNum(b, ['birdCountActual']) - firstNum(b, ['mortalityCumulative']));
    const birds = recorded > 0 ? recorded : projected;
    if (birds <= 0) continue;
    total += birds;
    flocks.push({name: firstStr(b, ['name', 'batchName', 'id']), count: birds, date: broughtDate});
  }
  if (total <= 0) return null;
  const n = flocks.length;
  return {
    detectorKey: 'broiler_processed',
    program: 'broiler',
    title: 'Broilers brought to processing',
    summary: `${pluralBirds(total)} brought to the processor across ${n} flock${n === 1 ? '' : 's'} this month.`,
    metricValue: total,
    displayValue: pluralBirds(total),
    sourceRefs: [{module: 'ppp-v4', ids: flocks.map((f) => f.name)}],
    comparison: {},
    confidence: 'high',
    evidence: {totalBirds: total, batches: n, flocks},
  };
}

// ── Pig on-farm: ledger-derived current head ─────────────────────────────────
// The app NEVER persists a pig current count; it derives it from the audit
// ledger — started (giltCount+boarCount) − processing-trip pigs − transfers to
// breeding (ppp-breeders-v1) − mortality, clamped >= 0. These helpers mirror
// computeBatchCurrentCount + its chain in src/lib/pig.js, ported for the
// no-tripSourceSummary path the harvest runs in (no live source summary → trip
// pigs come from subAttributions / trip.pigCount, exactly as pig.js falls back
// to without a summary). KEEP IN SYNC with src/lib/pig.js.
function pigTransfersForSub(breeders, parentBatchName, subBatchName) {
  let count = 0;
  if (!Array.isArray(breeders)) return count;
  for (const b of breeders) {
    if (!b || !b.transferredFromBatch) continue;
    if (b.transferredFromBatch.batchName !== parentBatchName) continue;
    if (b.transferredFromBatch.subBatchName !== subBatchName) continue;
    count++;
  }
  return count;
}
function pigTransfersForBatch(breeders, parentBatchName) {
  let count = 0;
  if (!Array.isArray(breeders)) return count;
  for (const b of breeders) {
    if (!b || !b.transferredFromBatch) continue;
    if (b.transferredFromBatch.batchName !== parentBatchName) continue;
    count++;
  }
  return count;
}
function pigTripPigsForSub(trips, subId) {
  if (!Array.isArray(trips) || !subId) return 0;
  let n = 0;
  for (const t of trips) {
    const atts = t && Array.isArray(t.subAttributions) ? t.subAttributions : [];
    for (const a of atts) if (a && a.subId === subId) n += parseInt(a.count) || 0;
  }
  return n;
}
function pigTripPigCount(trip) {
  return parseInt(trip && trip.pigCount) || 0;
}
function pigMortalityForSub(group, subName) {
  let n = 0;
  for (const m of (group && group.pigMortalities) || []) {
    if (m && m.sub_batch_name === subName) n += parseInt(m.count) || 0;
  }
  return n;
}
function pigMortalityForBatch(group) {
  let n = 0;
  for (const m of (group && group.pigMortalities) || []) n += parseInt(m.count) || 0;
  return n;
}
function pigBatchStartedCount(group) {
  const gb = (parseInt(group && group.giltCount) || 0) + (parseInt(group && group.boarCount) || 0);
  if (gb > 0) return gb;
  if (group && group.farmBorn) return parseInt(group.originalPigCount) || 0;
  return 0;
}
// Per-sub current count: 0 when processed, else started − trips − transfers −
// mortality (clamped >= 0). Mirrors computeSubCurrentCount.
function pigSubCurrentCount(group, sub, breeders) {
  if (!sub || sub.status === 'processed') return 0;
  const started = (parseInt(sub.giltCount) || 0) + (parseInt(sub.boarCount) || 0);
  const tripPigs = pigTripPigsForSub((group && group.processingTrips) || [], sub.id);
  const transfers = pigTransfersForSub(breeders, group && group.batchName, sub.name);
  const mortality = pigMortalityForSub(group, sub.name);
  return Math.max(0, started - tripPigs - transfers - mortality);
}
// Parent feeder-group current count. With subs: sum of sub currents. Parent-only:
// started − trip pigs − transfers − mortality. Mirrors computeBatchCurrentCount;
// the parent-only no-started fallback returns 0 (the harvest has no live daily
// pig_count to fall back to, unlike the app's render path).
function pigBatchCurrentCount(group, breeders) {
  const subs = (group && group.subBatches) || [];
  if (subs.length > 0) {
    return subs.reduce((s, sub) => s + pigSubCurrentCount(group, sub, breeders), 0);
  }
  const parentTrips = ((group && group.processingTrips) || []).reduce((s, t) => s + pigTripPigCount(t), 0);
  const parentTransfers = pigTransfersForBatch(breeders, group && group.batchName);
  const parentMort = pigMortalityForBatch(group);
  const parentStarted = pigBatchStartedCount(group);
  if (parentStarted > 0) return Math.max(0, parentStarted - parentTrips - parentTransfers - parentMort);
  return 0;
}

export function detectPigsOnFarm(input) {
  // On-farm = ACTIVE feeder groups only (excludes planned/processed), counted by
  // the app's ledger, NOT a persisted field. breeders = ppp-breeders-v1.
  const groups = asArray(input.pigFeederGroups).filter((g) => firstStr(g, ['status']).toLowerCase() === 'active');
  const breeders = asArray(input.pigBreeders);
  let total = 0;
  const ids = [];
  for (const g of groups) {
    const c = pigBatchCurrentCount(g, breeders);
    if (c > 0) {
      total += c;
      ids.push(firstStr(g, ['batchName', 'id']));
    }
  }
  if (total <= 0) return null;
  return {
    detectorKey: 'pig_on_farm',
    program: 'pig',
    title: 'Pigs on the farm',
    summary: `${total} pig${total === 1 ? '' : 's'} on the farm across ${ids.length} group${ids.length === 1 ? '' : 's'} at month end.`,
    metricValue: total,
    displayValue: `${total} pig${total === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'ppp-feeders-v1', ids}],
    comparison: {},
    confidence: 'high',
    evidence: {groupCount: ids.length, totalPigs: total, groups: ids},
  };
}

export function detectPigFarrowings(input) {
  const records = asArray(input.pigFarrowings);
  let litters = 0;
  let piglets = 0;
  // Only present a piglet total when EVERY in-period litter has an explicit
  // born-alive count. If any litter lacks it, a partial sum would misrepresent
  // the month, so we report litters only at medium confidence and omit totals.
  let allHaveBornAlive = true;
  const evidence = [];
  for (const r of records) {
    const fd = isoDay(firstStr(r, ['farrowingDate', 'farrowing_date', 'date']));
    if (!fd || !inPeriod(fd, input.period)) continue;
    litters += 1;
    const alive = firstNum(r, PIG_BORN_ALIVE_KEYS); // explicit born-alive ONLY; never totalBorn
    if (alive > 0) piglets += alive;
    else allHaveBornAlive = false;
    evidence.push({group: firstStr(r, ['group', 'sow', 'id']), date: fd, bornAlive: alive});
  }
  if (litters <= 0) return null;
  const showPiglets = allHaveBornAlive && piglets > 0;
  return {
    detectorKey: 'pig_farrowings',
    program: 'pig',
    title: 'New litters farrowed',
    summary: showPiglets
      ? `${piglets} piglet${piglets === 1 ? '' : 's'} born across ${litters} litter${litters === 1 ? '' : 's'} this month.`
      : `${litters} litter${litters === 1 ? '' : 's'} farrowed this month.`,
    metricValue: showPiglets ? piglets : litters,
    displayValue: showPiglets
      ? `${piglets} piglet${piglets === 1 ? '' : 's'} · ${litters} litter${litters === 1 ? '' : 's'}`
      : `${litters} litter${litters === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'ppp-farrowing-v1', ids: evidence.map((e) => e.group)}],
    comparison: {},
    confidence: showPiglets ? 'high' : 'medium',
    evidence: {litters, piglets: showPiglets ? piglets : null, records: evidence},
  };
}

function herdHead(herd, keys) {
  return firstNum(herd, keys);
}

export function detectCattleOnFarm(input) {
  const herds = asArray(input.cattleHerds);
  let total = 0;
  const ids = [];
  for (const h of herds) {
    const c = herdHead(h, CATTLE_HEAD_KEYS);
    if (c > 0) {
      total += c;
      ids.push(firstStr(h, ['name', 'herd', 'id']));
    }
  }
  if (total <= 0) return null;
  return {
    detectorKey: 'cattle_on_farm',
    program: 'cattle',
    title: 'Cattle on the farm',
    summary: `${total} head of cattle across ${ids.length} herd${ids.length === 1 ? '' : 's'} at month end.`,
    metricValue: total,
    displayValue: `${total} head`,
    sourceRefs: [{module: 'cattle_herds', ids}],
    comparison: {},
    confidence: 'high',
    evidence: {herdCount: ids.length, totalHead: total, herds: ids},
  };
}

export function detectCattleBirths(input) {
  const births = asArray(input.cattleBirths);
  let calves = 0;
  const evidence = [];
  for (const b of births) {
    const bd = isoDay(firstStr(b, ['birthDate', 'birth_date', 'date', 'calvedDate']));
    if (!bd || !inPeriod(bd, input.period)) continue;
    const n = firstNum(b, ['count', 'calves', 'quantity']) || 1;
    calves += n;
    evidence.push({dam: firstStr(b, ['dam', 'cow', 'herd', 'id']), date: bd, count: n});
  }
  if (calves <= 0) return null;
  return {
    detectorKey: 'cattle_births',
    program: 'cattle',
    title: 'Calves born',
    summary: `${calves} calf${calves === 1 ? '' : 'ves'} born this month.`,
    metricValue: calves,
    displayValue: `${calves} calf${calves === 1 ? '' : 'ves'}`,
    sourceRefs: [{module: 'cattle_births', ids: evidence.map((e) => e.dam)}],
    comparison: {},
    confidence: 'high',
    evidence: {calves, records: evidence},
  };
}

export function detectSheepOnFarm(input) {
  const flocks = asArray(input.sheepFlocks);
  let total = 0;
  const ids = [];
  for (const f of flocks) {
    const c = herdHead(f, SHEEP_HEAD_KEYS);
    if (c > 0) {
      total += c;
      ids.push(firstStr(f, ['name', 'flock', 'id']));
    }
  }
  if (total <= 0) return null;
  return {
    detectorKey: 'sheep_on_farm',
    program: 'sheep',
    title: 'Sheep on the farm',
    summary: `${total} head of sheep across ${ids.length} flock${ids.length === 1 ? '' : 's'} at month end.`,
    metricValue: total,
    displayValue: `${total} head`,
    sourceRefs: [{module: 'sheep_flocks', ids}],
    comparison: {},
    confidence: 'high',
    evidence: {flockCount: ids.length, totalHead: total, flocks: ids},
  };
}

export function detectSheepBirths(input) {
  const births = asArray(input.sheepBirths);
  let lambs = 0;
  const evidence = [];
  for (const b of births) {
    const bd = isoDay(firstStr(b, ['birthDate', 'birth_date', 'date', 'lambedDate']));
    if (!bd || !inPeriod(bd, input.period)) continue;
    const n = firstNum(b, ['count', 'lambs', 'quantity']) || 1;
    lambs += n;
    evidence.push({ewe: firstStr(b, ['ewe', 'flock', 'id']), date: bd, count: n});
  }
  if (lambs <= 0) return null;
  return {
    detectorKey: 'sheep_births',
    program: 'sheep',
    title: 'Lambs born',
    summary: `${lambs} lamb${lambs === 1 ? '' : 's'} born this month.`,
    metricValue: lambs,
    displayValue: `${lambs} lamb${lambs === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'sheep_births', ids: evidence.map((e) => e.ewe)}],
    comparison: {},
    confidence: 'high',
    evidence: {lambs, records: evidence},
  };
}

export function detectLayerEggs(input) {
  const records = asArray(input.layerProduction);
  let eggs = 0;
  let days = 0;
  for (const r of records) {
    const d = isoDay(firstStr(r, ['date', 'collectedDate', 'day']));
    if (!d || !inPeriod(d, input.period)) continue;
    const e = firstNum(r, ['eggs', 'eggCount', 'collected', 'count', 'quantity']);
    if (e > 0) {
      eggs += e;
      days += 1;
    }
  }
  if (eggs <= 0) return null;
  return {
    detectorKey: 'layer_eggs',
    program: 'layer',
    title: 'Eggs collected',
    summary: `${eggs} eggs collected across ${days} day${days === 1 ? '' : 's'} this month.`,
    metricValue: eggs,
    displayValue: `${eggs} eggs`,
    sourceRefs: [{module: 'layer_production', ids: []}],
    comparison: {},
    confidence: 'high',
    evidence: {eggs, recordedDays: days},
  };
}

export function detectPastureMoves(input) {
  const moves = asArray(input.pastureMoves).filter((m) => inPeriod(m && m.date, input.period));
  if (moves.length === 0) return null;
  const groups = [...new Set(moves.map((m) => firstStr(m, ['groupLabel'])).filter(Boolean))];
  const n = moves.length;
  return {
    detectorKey: 'pasture_moves',
    program: 'pasture',
    title: 'Rotational grazing moves',
    summary: `${n} animal move${n === 1 ? '' : 's'} across the pastures this month${
      groups.length ? ` (${groups.length} group${groups.length === 1 ? '' : 's'})` : ''
    }.`,
    metricValue: n,
    displayValue: `${n} move${n === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'pasture_move_events', ids: groups}],
    comparison: {},
    confidence: 'high',
    evidence: {moves: n, groups},
  };
}

export function detectProcessing(input) {
  const batches = asArray(input.processingBatches).filter((b) => inPeriod(b && b.date, input.period));
  if (batches.length === 0) return null;
  let weight = 0;
  const names = [];
  for (const b of batches) {
    weight += firstNum(b, ['hangingWeightLbs']);
    const nm = firstStr(b, ['name']);
    if (nm) names.push(nm);
  }
  const n = batches.length;
  const lbs = Math.round(weight);
  return {
    detectorKey: 'processing_batches',
    program: 'production',
    title: 'Brought to processing',
    summary:
      lbs > 0
        ? `${n} processing batch${n === 1 ? '' : 'es'} completed this month (${lbs} lbs hanging weight).`
        : `${n} processing batch${n === 1 ? '' : 'es'} completed this month.`,
    metricValue: n,
    displayValue: lbs > 0 ? `${n} batch${n === 1 ? '' : 'es'} · ${lbs} lbs` : `${n} batch${n === 1 ? '' : 'es'}`,
    sourceRefs: [{module: 'processing_batches', ids: names}],
    comparison: {},
    confidence: 'medium',
    evidence: {batches: n, hangingWeightLbs: lbs > 0 ? lbs : null, names},
  };
}

export function detectCompletedTasks(input) {
  // Notable = one-off project work, not a recurring/system chore.
  const tasks = asArray(input.completedTasks).filter(
    (t) => t && inPeriod(t.date, input.period) && !t.fromRecurring && firstStr(t, ['designation']) !== 'system',
  );
  // Drop any title that trips the finance/mortality boundary BEFORE folding it
  // into the fact — one unsafe title neither leaks nor drops the whole fact.
  const safeTitles = tasks.map((t) => firstStr(t, ['title'])).filter((s) => s && !isForbiddenText(s));
  if (safeTitles.length === 0) return null;
  const sample = safeTitles.slice(0, 5);
  const n = safeTitles.length;
  return {
    detectorKey: 'completed_tasks',
    program: 'projects',
    title: 'Projects completed',
    summary:
      n === 1
        ? `One project finished this month: ${sample[0]}.`
        : `${n} projects finished this month, including ${sample.slice(0, 3).join(', ')}.`,
    metricValue: n,
    displayValue: `${n} project${n === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'task_instances', ids: []}],
    comparison: {},
    confidence: 'medium',
    evidence: {completed: n, titles: sample},
  };
}

export function detectDailyReports(input) {
  const subs = asArray(input.dailySubmissions).filter((s) => inPeriod(s && s.date, input.period));
  if (subs.length === 0) return null;
  const days = new Set(subs.map((s) => isoDay(s && s.date)).filter(Boolean));
  const people = new Set(subs.map((s) => firstStr(s, ['teamMember'])).filter(Boolean));
  const n = subs.length;
  return {
    detectorKey: 'daily_reports',
    program: 'team',
    title: 'Daily field reporting',
    summary: `The team filed ${n} field report${n === 1 ? '' : 's'} across ${days.size} day${
      days.size === 1 ? '' : 's'
    } this month, keeping every program current.`,
    metricValue: n,
    displayValue: `${n} report${n === 1 ? '' : 's'} · ${days.size} day${days.size === 1 ? '' : 's'}`,
    sourceRefs: [{module: 'daily_submissions', ids: []}],
    comparison: {},
    confidence: 'medium',
    evidence: {reports: n, days: days.size, contributors: people.size},
  };
}

// Ordered registry — the sort_order in the issue follows this order.
export const NEWSLETTER_DETECTORS = Object.freeze([
  detectCattleOnFarm,
  detectCattleBirths,
  detectSheepOnFarm,
  detectSheepBirths,
  detectPigsOnFarm,
  detectPigFarrowings,
  detectBroilerOnFarm,
  detectBroilerProcessed,
  detectLayerEggs,
  detectPastureMoves,
  detectProcessing,
  detectCompletedTasks,
  detectDailyReports,
]);

// Drop any candidate that trips the finance/mortality boundary. Pure filter.
export function assertNoForbiddenFacts(facts) {
  return asArray(facts).filter((f) => f && !isForbiddenFact(f));
}

// Run every detector over the input, drop nulls + forbidden, and stamp a stable
// sort order. Deterministic given the same input.
export function detectNewsletterFacts(input) {
  if (!input || typeof input !== 'object' || !input.period) return [];
  const out = [];
  for (const detect of NEWSLETTER_DETECTORS) {
    let fact = null;
    try {
      fact = detect(input);
    } catch (_e) {
      fact = null;
    }
    if (fact) out.push(fact);
  }
  const safe = assertNoForbiddenFacts(out);
  return safe.map((f, i) => ({...f, sortOrder: i}));
}
