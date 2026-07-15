// ============================================================================
// processingAsanaShape — PURE mapping/diff layer for the Processing ⇄ Asana
// one-way mirror (SF Processing Calendar → native Processing domain).
// ----------------------------------------------------------------------------
// Pure ESM. NO Deno/Node APIs, NO imports, NO I/O, NO Date.now(). Every export
// is deterministic so it is importable + unit-testable by Node/vitest AND by the
// Deno edge function (../processing-asana-sync/index.ts imports this file).
//
// Responsibility split:
//   - THIS module shapes Asana API JSON into the exact `p_row` objects the
//     migration 156/157 importer RPCs accept (upsert_processing_from_asana,
//     upsert_processing_subtask_from_asana), MATCHES an Asana task to a Planner
//     batch (matchAsanaTaskToPlanner), classifies bucket + record_type, computes
//     per-link drift, and diffs a batch of mapped rows against what is stored.
//   - The edge function owns all network I/O + the service_role RPC calls. It
//     calls reconcile_planner_to_processing() FIRST, loads the planner_batch
//     rows, then feeds this module's PURE matcher each Asana task to decide
//     matched / historical / import_exception / needs_review / milestone.
//
// LOCKED MODEL (migration 157): Planner is senior whenever a Planner batch/event
// exists (any year). The Asana pass NEVER mints planner_batch and NEVER
// overwrites Planner live facts. Year is derived from the DATE (never the Asana
// 'Year' field); cutoff 2024 splits unmatched rows into asana_historical (<2024)
// vs import_exception (>=2024).
//
// Contract references (migrations 156/157):
//   upsert_processing_from_asana p_row keys (asana_historical | import_exception
//     | milestone ONLY — never planner_batch): asana_gid, record_type, program,
//     title, processing_date, status, number_processed, asana_section_name,
//     historical_snapshot, raw_asana_snapshot, sync_run_id.
//   link_asana_to_processing p_row keys: asana_gid, processing_record_id|null,
//     program, asana_batch_code, match_status ('matched'|'historical'|
//     'needs_review'|'milestone'), match_method ('auto_exact'|'manual_crosswalk'|
//     'historical'|'milestone'|'none'), confidence, candidate_record_ids[],
//     raw_asana_snapshot, drift, seed_processor, seed_customer, sync_run_id.
//   record_type CHECK: planner_batch | asana_historical | milestone |
//     import_exception. program CHECK: broiler | cattle | pig | sheep.
// ============================================================================

// ── Constants ───────────────────────────────────────────────────────────────

// Asana section name → WCF program. Section names carry no trailing space here;
// sectionToProgram trims the incoming value before lookup.
export const SECTION_TO_PROGRAM = Object.freeze({
  'WCF Broiler Processing': 'broiler',
  'WCF Cattle Processing': 'cattle',
  'WCF Pig Processing': 'pig',
  'WCF Lamb Processing': 'sheep',
});

export const ASANA_PROJECT_GID = '1201484014160203';

// Fallback signal: the Asana "Farm Programs" enum (and common singular/plural
// variants) → program. Keyed lowercase; consulted only when the section name
// itself does not resolve. 'Lamb'/'Lambs'/'Sheep' all mean the sheep program.
const FARM_PROGRAM_FALLBACK = Object.freeze({
  broiler: 'broiler',
  broilers: 'broiler',
  cattle: 'cattle',
  cow: 'cattle',
  cows: 'cattle',
  pig: 'pig',
  pigs: 'pig',
  hog: 'pig',
  hogs: 'pig',
  lamb: 'sheep',
  lambs: 'sheep',
  sheep: 'sheep',
});

// Asana custom-field NAMES (exact, as they appear on the SF Processing Calendar
// tasks). Read via trimmed keys so an export/API trailing-space variant still
// resolves (see normalizeCfMap).
const CF = Object.freeze({
  STATUS: 'Status (Processing)',
  ANIMALS: 'Animals Processed',
  CUSTOMER: 'Customer (Broiler)',
  PROCESSOR: 'Processor',
  PLANNED_PROC: 'Planned Processing Date (SF)',
  ACTUAL_PROC: 'Actual Processing Date (SF)',
  PRODUCT_PICKUP: 'Product Pick-up Date',
  BATCH_NAME: 'Batch Name (Farms)',
  FARM: 'Farm',
  YEAR: 'Year',
  ANIMAL_MASTER: 'Status (Animal Master)',
  FARM_PROGRAMS: 'Farm Programs',
  FARM_ARRIVAL: 'Farm Arrival Date',
  CONDEMNED: 'Condemed', // Asana's spelling — keep
});

// Every Asana custom field on the SF Processing Calendar and its planner
// destination. The destination audit FAILS CLOSED when a live field name is not
// in this map (a new Asana field must get a destination before any import).
// Formula fields export evaluated values; we re-derive them (processingFields).
export const CF_DESTINATIONS = Object.freeze({
  'Status (Processing)': 'processing_records.status (normalized display)',
  'Animals Processed': 'processing_records.number_processed',
  'Customer (Broiler)': 'processing_records.customer',
  Processor: 'processing_records.processor',
  'Planned Processing Date (SF)': 'historical_snapshot.planned_proc',
  'Actual Processing Date (SF)': 'processing_records.processing_date / historical_snapshot.actual_proc',
  'Product Pick-up Date': 'historical_snapshot.product_pickup',
  'Batch Name (Farms)': 'historical_snapshot.batch_name (+ matcher signal)',
  Farm: 'historical_snapshot.farm',
  Year: 'historical_snapshot.year (display only; matching derives year from dates)',
  'Status (Animal Master)': 'historical_snapshot.animal_master',
  'Farm Programs': 'program (section fallback)',
  'Farm Arrival Date': 'historical_snapshot.farm_arrival',
  Condemed: 'historical_snapshot.condemned',
  'Actual Time On Farm': 'derived (processingFields.deriveActualTofDays; Asana raw minutes ignored)',
  'Planned Time on Farm': 'derived (processingFields.derivePlannedTofDays)',
  'Time Remaining Until Processing': 'derived (processingFields.deriveTimeRemaining)',
});

// Business fields compared by buildDiffPlan. Deliberately EXCLUDES volatile
// provenance (raw_asana_snapshot, sync_run_id, last_synced_at) so re-importing
// an unchanged task is a no-op even though its snapshot/run id churn each run.
const COMPARE_FIELDS = Object.freeze([
  'record_type',
  'program',
  'title',
  'processing_date',
  'status',
  'processor',
  'number_processed',
  'customer',
  'asana_section_name',
  'source_kind',
  'source_id',
]);

// ── Small pure helpers ──────────────────────────────────────────────────────

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    return v;
  }
  return null;
}

// Any date-ish value → 'YYYY-MM-DD' (drops a time component) or null.
function toDateOnly(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

// Any numeric-ish value → integer or null. Tolerates thousands separators/spaces
// from display strings ("70,560").
function toInt(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '') return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// processing_records.customer is a jsonb ARRAY. Coerce a single Asana value
// (string) or an existing array into a clean string array; never null.
function toCustomerArray(v) {
  if (v == null) return [];
  const src = Array.isArray(v) ? v : [v];
  const out = [];
  for (const item of src) {
    if (item == null) continue;
    const s = String(item).trim();
    if (s) out.push(s);
  }
  return out;
}

// Deterministic stringify with sorted object keys so field-order never affects
// equality. Arrays keep their order (semantically significant for customer).
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

// ── Custom-field resolution ─────────────────────────────────────────────────

// Resolve ONE Asana custom_field object to a plain scalar/array value.
// Handles enum / multi_enum / number / text / date / display_value shapes.
export function customFieldDisplay(cf) {
  if (cf == null) return null;
  if (typeof cf !== 'object' || Array.isArray(cf)) return cf;
  if (cf.enum_value && typeof cf.enum_value === 'object') return cf.enum_value.name ?? null;
  if (Array.isArray(cf.multi_enum_values)) {
    return cf.multi_enum_values.map((e) => (e && e.name != null ? e.name : null)).filter((x) => x != null);
  }
  if (typeof cf.number_value === 'number') return cf.number_value;
  if (cf.date_value && typeof cf.date_value === 'object') {
    return cf.date_value.date || cf.date_value.date_time || null;
  }
  if (cf.text_value != null) return cf.text_value;
  if ('display_value' in cf) return cf.display_value ?? null;
  return null;
}

// Build a { [fieldName]: resolvedValue } map from a task's custom_fields array.
// Exported so the edge function can index once and reuse.
export function indexCustomFields(task) {
  const out = {};
  const list = task && Array.isArray(task.custom_fields) ? task.custom_fields : [];
  for (const cf of list) {
    if (cf && cf.name != null) out[cf.name] = customFieldDisplay(cf);
  }
  return out;
}

// If a value still looks like a raw Asana custom-field object, resolve it;
// otherwise pass it through. Lets callers hand us EITHER an already-resolved
// map or a map of raw CF objects.
function resolveCf(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (
      'number_value' in v ||
      'text_value' in v ||
      'enum_value' in v ||
      'display_value' in v ||
      'date_value' in v ||
      'multi_enum_values' in v
    ) {
      return customFieldDisplay(v);
    }
  }
  return v;
}

// Normalize an incoming custom-field map: trim keys (tolerates trailing-space
// export variants) and resolve any raw CF objects to scalars.
function normalizeCfMap(customFieldsByName) {
  const out = {};
  if (customFieldsByName && typeof customFieldsByName === 'object') {
    for (const [k, v] of Object.entries(customFieldsByName)) {
      out[String(k).trim()] = resolveCf(v);
    }
  }
  return out;
}

// ── Section → program ───────────────────────────────────────────────────────

// Resolve an Asana section name (or a Farm Programs enum value) to a WCF
// program, or null. Trims first; exact section match wins, then the Farm
// Programs fallback (case-insensitive).
export function sectionToProgram(sectionName) {
  if (sectionName == null) return null;
  const trimmed = String(sectionName).trim();
  if (!trimmed) return null;
  if (Object.prototype.hasOwnProperty.call(SECTION_TO_PROGRAM, trimmed)) return SECTION_TO_PROGRAM[trimmed];
  const lower = trimmed.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FARM_PROGRAM_FALLBACK, lower)) return FARM_PROGRAM_FALLBACK[lower];
  return null;
}

// ── Year derivation + WCF code normalization ────────────────────────────────

// Processing YEAR derived from the DATE — NEVER the Asana 'Year' custom field
// (unreliable in the export). Precedence: actual proc → planned proc → due_on →
// created_at. Returns a 4-digit integer or null. Pure + deterministic.
export function deriveProcessingYear(task, customFieldsByName = null) {
  const cf = normalizeCfMap(customFieldsByName != null ? customFieldsByName : indexCustomFields(task));
  const d = toDateOnly(
    firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on, task && task.created_at),
  );
  if (d) return Number.parseInt(d.slice(0, 4), 10);
  return null;
}

// Canonical WCF batch code: WCF-<P>-YY-NN[SUFFIX], P ∈ {B,C,P,L}. Extracts an
// embedded code from a noisy string — task Name ("WCF-B-26-16: 700 @5LBS"),
// Batch Name (Farms) ("WCF-B-26-10"), with trailing CR/LF/colon/whitespace.
// Zero-pads NN to two digits, uppercases the program letter + optional single-
// letter suffix, and ALWAYS emits the leading "WCF-" even when the source omits
// it. Returns null when no code is present. Deterministic + idempotent
// (normalizeWcfCode(normalizeWcfCode(x)) === normalizeWcfCode(x)).
export function normalizeWcfCode(str) {
  if (str == null) return null;
  // (?:WCF-)? optional prefix; \b so we never match mid-word; a single-letter
  // suffix must be immediately attached (no space) so a following description
  // word is never swallowed; trailing \b closes the token cleanly.
  const m = /(?:WCF-)?\b([BCPL])-(\d{2})-(\d{1,3})([A-Za-z])?\b/i.exec(String(str));
  if (!m) return null;
  const nn = m[3].padStart(2, '0');
  const suffix = m[4] ? m[4].toUpperCase() : '';
  return `WCF-${m[1].toUpperCase()}-${m[2]}-${nn}${suffix}`;
}

// ── historical_snapshot ─────────────────────────────────────────────────────

// Curated read-only snapshot of the source-of-truth Asana fields. Only keys with
// a present value are included ("where present" per the contract).
function buildHistoricalSnapshot(task, cf) {
  const candidate = {
    start_on: (task && task.start_on) || null,
    due_on: (task && task.due_on) || null,
    planned_proc: toDateOnly(cf[CF.PLANNED_PROC]),
    actual_proc: toDateOnly(cf[CF.ACTUAL_PROC]),
    product_pickup: toDateOnly(cf[CF.PRODUCT_PICKUP]),
    batch_name: cleanStr(cf[CF.BATCH_NAME]),
    farm: cleanStr(cf[CF.FARM]),
    year: toInt(cf[CF.YEAR]),
    animal_master: cleanStr(cf[CF.ANIMAL_MASTER]),
    farm_arrival: toDateOnly(cf[CF.FARM_ARRIVAL]),
    condemned: toInt(cf[CF.CONDEMNED]),
    notes: cleanStr(task && task.notes),
    assignee_name: cleanStr(task && task.assignee && task.assignee.name),
  };
  const out = {};
  for (const [k, v] of Object.entries(candidate)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

// ── Record mapping ──────────────────────────────────────────────────────────

// Map one Asana task → the p_row object for upsert_processing_from_asana.
// opts:
//   sectionName        Asana section this task sits under (drives program)
//   customFieldsByName  pre-indexed CF map (else derived from task.custom_fields)
//   recordType          override (else defaults to 'asana_historical'; the edge
//                       fn passes classifyRecordType(...) here)
//   sectionGid          Asana section gid (provenance)
//   projectGid          Asana project gid (defaults ASANA_PROJECT_GID)
//   matchStatus         optional match_status ('matched'|'review'|'unmatched'…)
//   syncRunId           current sync run id (provenance)
export function mapAsanaTaskToProcessingRow(task, opts = {}) {
  const {
    sectionName = null,
    customFieldsByName = null,
    recordType,
    sectionGid = null,
    projectGid = ASANA_PROJECT_GID,
    matchStatus,
    syncRunId = null,
  } = opts || {};

  const cf = normalizeCfMap(customFieldsByName != null ? customFieldsByName : indexCustomFields(task));
  const program = sectionToProgram(sectionName) || sectionToProgram(cf[CF.FARM_PROGRAMS]) || null;

  const completed = task && task.completed === true;
  const rawStatus = cleanStr(cf[CF.STATUS]);
  // Asana `completed` is authoritative for Complete; otherwise carry the RAW
  // 'Status (Processing)' value (e.g. 'Reserved') — the display layer
  // (processingStatusDisplay.js) normalizes it. Never invent a status.
  const status = completed ? 'complete' : rawStatus || 'planned';

  const processingDate = toDateOnly(firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on));

  const row = {
    asana_gid: task && task.gid != null ? String(task.gid) : null,
    record_type: recordType || 'asana_historical',
    program,
    title: task && task.name != null ? String(task.name) : '(untitled)',
    processing_date: processingDate,
    status,
    processor: cleanStr(cf[CF.PROCESSOR]),
    number_processed: toInt(cf[CF.ANIMALS]),
    customer: toCustomerArray(cf[CF.CUSTOMER]),
    // Task-level Asana assignee: display name always; gid so the edge layer can
    // map to a planner profile via the user directory (email match).
    assignee_name: cleanStr(task && task.assignee && task.assignee.name),
    assignee_gid: task && task.assignee && task.assignee.gid != null ? String(task.assignee.gid) : null,
    source_kind: null, // resolved app-side after a match; importer leaves null
    source_id: null,
    asana_project_gid: projectGid || null,
    asana_section_gid: sectionGid || null,
    asana_section_name: sectionName != null ? String(sectionName).trim() || null : null,
    historical_snapshot: buildHistoricalSnapshot(task, cf),
    raw_asana_snapshot: task || {},
  };
  if (matchStatus) row.match_status = matchStatus;
  if (syncRunId) row.sync_run_id = syncRunId;
  return row;
}

// Pure record_type rules. The Asana pass NEVER mints planner_batch — only the
// Planner bridge (reconcile_planner_to_processing) does. This returns just the
// two record_types decidable from the task alone; the edge layer runs the
// matcher + classifyBucket to split match_candidate into matched (link only) vs
// asana_historical vs import_exception.
//   'milestone'       — an Asana milestone (resource_subtype), OR a task with no
//                       resolvable program (section headers / stray notes).
//   'match_candidate' — a program task; hand it to matchAsanaTaskToPlanner.
// opts: { sectionName, program }
export function classifyRecordType(task, opts = {}) {
  const {sectionName = null} = opts || {};
  const program =
    opts && Object.prototype.hasOwnProperty.call(opts, 'program') ? opts.program : sectionToProgram(sectionName);
  if (task && task.resource_subtype === 'milestone') return 'milestone';
  if (!program) return 'milestone';
  return 'match_candidate';
}

// ── Matching + bucketing + drift (Planner-is-senior reconciler core) ─────────

// Bucket an Asana program task by the 2024 cutoff (year is DATE-derived, never
// the 'Year' field). Never mutates anything. Returns:
//   'matched'          — opts.matched === true (edge already linked a Planner row)
//   'milestone'        — an Asana milestone
//   'historical'       — unmatched, derivable year < 2024 → asana_historical
//   'import_exception' — unmatched, derivable year >= 2024
//   'needs_review'     — NO derivable year (with or without a code)
// opts: { matched, year, customFieldsByName }
export function classifyBucket(task, opts = {}) {
  if (opts && opts.matched === true) return 'matched';
  if (task && task.resource_subtype === 'milestone') return 'milestone';
  const year =
    opts && opts.year != null ? toInt(opts.year) : deriveProcessingYear(task, opts ? opts.customFieldsByName : null);
  if (year != null && year < 2024) return 'historical';
  if (year != null && year >= 2024) return 'import_exception';
  return 'needs_review';
}

// Tokenize a pig sub-batch attribution (planner row) or Batch Name (Asana task)
// into a lowercase Set of identifiers. Accepts an array (jsonb / multi-enum) or
// a delimited string.
function pigSubBatchTokens(value) {
  const out = new Set();
  const push = (x) => {
    const s = cleanStr(x);
    if (s) out.add(s.toLowerCase());
  };
  if (value == null) return out;
  const arr = Array.isArray(value) ? value : [value];
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === 'object') {
      push(item.subBatchId ?? item.sub_batch_id ?? item.id ?? item.label ?? item.name);
    } else {
      for (const part of String(item).split(/[,;/|]+/)) push(part);
    }
  }
  return out;
}

// Sub-batch overlap is non-discriminating when EITHER side has no tokens (fall
// back to date+count); otherwise require a non-empty intersection.
function pigSubBatchOverlap(a, b) {
  if (a.size === 0 || b.size === 0) return true;
  for (const t of a) if (b.has(t)) return true;
  return false;
}

// Deterministically match ONE Asana program task to a Planner batch row.
// opts:
//   program      resolved WCF program (broiler|cattle|pig|sheep)
//   code         caller's normalized WCF code hint (coded programs; optional)
//   plannerRows  loaded record_type='planner_batch' rows: {id, program, title,
//                processing_date, status, number_processed, sub_batch_attribution,
//                source_phase}
//   customFieldsByName  pre-indexed CF map (else derived from the task)
// Returns { method, recordId|null, candidateIds[], confidence }:
//   'milestone'   — task is an Asana milestone (excluded from batch matching)
//   'auto_exact'  — exactly ONE planner candidate (recordId set, confidence high)
//   'needs_review'— >=2 candidates, OR the Name-code and Batch-Name-code resolve
//                   to DIFFERENT planner rows, OR ambiguous with no clean pick
//   'historical'  — no candidate + derivable year < 2024 (→ asana_historical)
// Coded programs match a normalized WCF code (from Name AND Batch Name) against
// each planner row's normalized title. PIG has no code: match by program + date
// equal + count (Animals Processed) equal + sub-batch overlap.
export function matchAsanaTaskToPlanner(task, opts = {}) {
  const {program = null, plannerRows = []} = opts || {};
  const none = (method) => ({method, recordId: null, candidateIds: [], confidence: 'none'});

  if (task && task.resource_subtype === 'milestone') return none('milestone');
  if (!program) return none('needs_review');

  const cf = normalizeCfMap(opts.customFieldsByName != null ? opts.customFieldsByName : indexCustomFields(task));
  const rows = (Array.isArray(plannerRows) ? plannerRows : []).filter((r) => r && r.program === program);

  // No planner candidate → bucket by the 2024 cutoff (year is DATE-derived).
  const noMatch = () =>
    none(
      classifyBucket(task, {matched: false, customFieldsByName: cf}) === 'historical' ? 'historical' : 'needs_review',
    );

  // PIG: no code — match on program + date + count + sub-batch overlap.
  // PLANNED pig rows (source_phase='planned', mig 176) are forecast trips, not
  // fulfilled processing — never match candidates. Absent/NULL source_phase
  // stays eligible (legacy rows predate the column). Mirrors loadPlannerRows.
  if (program === 'pig') {
    const date = toDateOnly(firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on));
    const count = toInt(cf[CF.ANIMALS]);
    const taskTokens = pigSubBatchTokens(cf[CF.BATCH_NAME]);
    const candidates = rows.filter((r) => {
      if (r.source_phase === 'planned') return false;
      if (date == null || toDateOnly(r.processing_date) !== date) return false;
      if (count == null || toInt(r.number_processed) !== count) return false;
      return pigSubBatchOverlap(taskTokens, pigSubBatchTokens(r.sub_batch_attribution));
    });
    if (candidates.length === 1) {
      return {method: 'auto_exact', recordId: candidates[0].id, candidateIds: [candidates[0].id], confidence: 'high'};
    }
    if (candidates.length >= 2) {
      return {method: 'needs_review', recordId: null, candidateIds: candidates.map((r) => r.id), confidence: 'low'};
    }
    return noMatch();
  }

  // CODED programs (broiler / cattle / sheep).
  const nameCode = normalizeWcfCode(task && task.name);
  const bnCode = normalizeWcfCode(cf[CF.BATCH_NAME]);
  const primaryCode = normalizeWcfCode(opts.code) || nameCode || bnCode;
  const candFor = (c) => (c ? rows.filter((r) => normalizeWcfCode(r.title) === c) : []);

  // Name/BN disagreement veto: both codes present, both resolve to a planner
  // row, and they resolve to DIFFERENT rows → needs_review (no auto pick).
  if (nameCode && bnCode && nameCode !== bnCode) {
    const idsName = candFor(nameCode).map((r) => r.id);
    const idsBN = candFor(bnCode).map((r) => r.id);
    const sameSingleRow = idsName.length === 1 && idsBN.length === 1 && idsName[0] === idsBN[0];
    if (idsName.length && idsBN.length && !sameSingleRow) {
      return {
        method: 'needs_review',
        recordId: null,
        candidateIds: Array.from(new Set([...idsName, ...idsBN])),
        confidence: 'low',
      };
    }
  }

  if (!primaryCode) return noMatch();
  const candidates = candFor(primaryCode);
  if (candidates.length === 1) {
    return {method: 'auto_exact', recordId: candidates[0].id, candidateIds: [candidates[0].id], confidence: 'high'};
  }
  if (candidates.length >= 2) {
    return {method: 'needs_review', recordId: null, candidateIds: candidates.map((r) => r.id), confidence: 'low'};
  }
  return noMatch();
}

// Per-link DRIFT: the fields where the Asana task DISAGREES with the linked
// Planner record. Informational ONLY — never applied to the record (Planner is
// senior). Compares processing_date, number_processed, status. Reports a field
// only when the Asana side has a value that differs from the Planner value.
// opts: { customFieldsByName }
export function computeDrift(task, plannerRow, opts = {}) {
  const drift = {};
  if (!plannerRow) return drift;
  const cf = normalizeCfMap(
    opts && opts.customFieldsByName != null ? opts.customFieldsByName : indexCustomFields(task),
  );

  const aDate = toDateOnly(firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on));
  const pDate = toDateOnly(plannerRow.processing_date);
  if (aDate != null && aDate !== pDate) drift.processing_date = {asana: aDate, planner: pDate};

  const aNum = toInt(cf[CF.ANIMALS]);
  const pNum = toInt(plannerRow.number_processed);
  if (aNum != null && aNum !== pNum) drift.number_processed = {asana: aNum, planner: pNum};

  const aStatus = task && task.completed === true ? 'complete' : cleanStr(cf[CF.STATUS]);
  const pStatus = cleanStr(plannerRow.status);
  if (aStatus != null && (pStatus == null || aStatus.toLowerCase() !== pStatus.toLowerCase())) {
    drift.status = {asana: aStatus, planner: pStatus};
  }
  return drift;
}

// ── Subtask mapping ─────────────────────────────────────────────────────────

// Map one Asana subtask → p_row for upsert_processing_subtask_from_asana.
// assignee_gid rides along so the edge layer can resolve a profile id through
// the user directory (stable gid/email — never display name alone).
export function mapAsanaSubtask(subtask, parentGid, sortOrder) {
  const s = subtask || {};
  return {
    asana_gid: s.gid != null ? String(s.gid) : null,
    parent_asana_gid: parentGid != null ? String(parentGid) : null,
    label: s.name != null ? String(s.name) : '(untitled)',
    assignee: s.assignee && s.assignee.name != null ? String(s.assignee.name) : null,
    assignee_gid: s.assignee && s.assignee.gid != null ? String(s.assignee.gid) : null,
    done: s.completed === true,
    completed_at: s.completed_at || null,
    due_on: toDateOnly(s.due_on),
    start_on: toDateOnly(s.start_on),
    sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
  };
}

// Depth-first flatten of a (possibly nested) subtask tree into an ordered list
// of { subtask, sortOrder } pairs, sortOrder starting at 1 (parent before its
// children). v1 flattens the hierarchy — every node attaches directly to the
// record. Never mutates the input.
export function flattenSubtasks(subtaskTree) {
  const out = [];
  let order = 0;
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node == null) continue;
      order += 1;
      out.push({subtask: node, sortOrder: order});
      if (Array.isArray(node.subtasks) && node.subtasks.length) walk(node.subtasks);
    }
  };
  walk(subtaskTree);
  return out;
}

// ── Comments (stories) ──────────────────────────────────────────────────────

// True only for a real human comment story — excludes system stories (status
// changes, assignments, rule noise) and likes.
export function isRealComment(story) {
  return !!story && story.type === 'comment';
}

// Map an Asana comment story → a normalized comment shape.
export function mapAsanaComment(story) {
  const s = story || {};
  return {
    asana_comment_gid: s.gid != null ? String(s.gid) : null,
    original_author_name: s.created_by && s.created_by.name != null ? String(s.created_by.name) : null,
    body: s.text != null ? String(s.text) : '',
    created_at: s.created_at || null,
  };
}

// ── Diff plan (idempotency) ─────────────────────────────────────────────────

function makeNativeGetter(nativeByGid) {
  if (nativeByGid instanceof Map) return (gid) => (nativeByGid.has(gid) ? nativeByGid.get(gid) : null);
  if (nativeByGid && typeof nativeByGid === 'object') {
    return (gid) => (Object.prototype.hasOwnProperty.call(nativeByGid, gid) ? nativeByGid[gid] : null);
  }
  return () => null;
}

// Canonical comparable projection of a row (mapped OR stored native), over the
// business COMPARE_FIELDS only, with undefined coerced to null and customer
// normalized to a clean string array. Deterministic (sorted-key) stringify so
// two rows describing the same state compare equal regardless of field order.
function comparableKey(row) {
  const proj = {};
  for (const k of COMPARE_FIELDS) {
    let v = row ? row[k] : undefined;
    if (v === undefined) v = null;
    if (k === 'customer') v = toCustomerArray(v);
    if (k === 'number_processed') v = v == null ? null : toInt(v);
    if (k === 'processing_date') v = v == null ? null : toDateOnly(v);
    proj[k] = v;
  }
  return stableStringify(proj);
}

// Diff a batch of mapped Asana rows against the currently-stored native records
// (keyed by asana_gid; accepts a Map or a plain object). Pure + deterministic:
//   - gid absent in native            → would INSERT
//   - gid present, fields identical   → would SKIP (idempotent no-op)
//   - gid present, fields differ      → would UPDATE
// Re-running with native reflecting the same rows yields 0 inserts/0 updates.
export function buildDiffPlan(asanaRows, nativeByGid) {
  const getNative = makeNativeGetter(nativeByGid);
  const plan = {wouldInsert: 0, wouldUpdate: 0, wouldSkip: 0, inserts: [], updates: []};
  const rows = Array.isArray(asanaRows) ? asanaRows : [];
  for (const row of rows) {
    const gid = row && row.asana_gid != null ? String(row.asana_gid) : null;
    if (!gid) continue; // cannot diff a row without its idempotency key
    const native = getNative(gid);
    if (native == null) {
      plan.wouldInsert += 1;
      plan.inserts.push(row);
      continue;
    }
    if (comparableKey(row) === comparableKey(native)) {
      plan.wouldSkip += 1;
    } else {
      plan.wouldUpdate += 1;
      plan.updates.push(row);
    }
  }
  return plan;
}

// ── Read-only dry-run report (mirrors the write-path classification) ──────────

// Build the review packet the /processing "Dry run" surfaces. For each Asana task
// it assigns the SAME bucket the write path (runSync) would, WITHOUT writing:
//   matched          — auto_exact link to a senior Planner record (+ drift preview)
//   historical       — unmatched, date-derived year < 2024
//   import_exception — unmatched, year >= 2024 OR no derivable year, no candidates
//   needs_review     — >=2 planner candidates / Name↔BN disagreement (deferred)
//   milestone        — Asana milestone OR no resolvable program
// and collects per-record review detail, milestones, duplicate/collision reports,
// pig match candidates, and a drift preview for auto_exact links.
//
// PURE + deterministic: no I/O, no writes, no Date.now(). The edge function feeds
// it fetched Asana tasks + reconciled planner_batch rows and returns it verbatim.
//   fetchedTasks: [{ task, sectionName, cf? }]  (cf optional; derived if absent)
//   plannerRows:  record_type='planner_batch' rows (see loadPlannerRows)
export function buildDryRunReport(fetchedTasks, plannerRows) {
  const tasks = Array.isArray(fetchedTasks) ? fetchedTasks : [];
  const rows = Array.isArray(plannerRows) ? plannerRows : [];
  const plannerById = new Map();
  for (const r of rows) if (r && r.id != null) plannerById.set(String(r.id), r);

  const buckets = {matched: 0, historical: 0, import_exception: 0, needs_review: 0, milestone: 0};
  const review = [];
  const milestones = [];
  const pigCandidates = [];
  const driftPreview = [];

  // Collision accumulators.
  const codeIndex = new Map(); // `${program}::${code}` -> [{gid, title}]
  const matchedByRecord = new Map(); // recordId -> [{gid, program}]
  const ambiguousCandidates = []; // one Asana task -> >=2 planner candidates

  const candDetail = (ids) =>
    (Array.isArray(ids) ? ids : []).map((id) => {
      const r = plannerById.get(String(id));
      return r
        ? {id: r.id, title: r.title ?? null, source_id: r.source_id ?? null, source_kind: r.source_kind ?? null}
        : {id, title: null, source_id: null, source_kind: null};
    });

  for (const ft of tasks) {
    const task = (ft && ft.task) || {};
    const sectionName = ft ? ft.sectionName : null;
    const cf = normalizeCfMap(ft && ft.cf != null ? ft.cf : indexCustomFields(task));
    const gid = task && task.gid != null ? String(task.gid) : null;
    const title = task && task.name != null ? String(task.name) : '(untitled)';

    // Reuse the exact mapping/program/code the write path uses.
    const row = mapAsanaTaskToProcessingRow(task, {sectionName, customFieldsByName: cf});
    const program = row.program;
    const code =
      normalizeWcfCode(task && task.name) || normalizeWcfCode((row.historical_snapshot || {}).batch_name) || null;

    // Milestone (Asana milestone OR no resolvable program) — excluded from matching.
    if (classifyRecordType(task, {sectionName, program}) === 'milestone') {
      buckets.milestone += 1;
      milestones.push({
        gid,
        title,
        program,
        section: sectionName != null ? String(sectionName).trim() || null : null,
      });
      continue;
    }

    // Track Asana program+code duplicates (coded programs only; pig has no code).
    if (code) {
      const key = `${program}::${code}`;
      if (!codeIndex.has(key)) codeIndex.set(key, []);
      codeIndex.get(key).push({gid, title});
    }

    const match = matchAsanaTaskToPlanner(task, {program, code, plannerRows: rows, customFieldsByName: cf});

    // Pig review aid: surface signals + candidates for EVERY pig task.
    if (program === 'pig') {
      pigCandidates.push({
        gid,
        title,
        date: toDateOnly(firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on)),
        count: toInt(cf[CF.ANIMALS]),
        tokens: Array.from(pigSubBatchTokens(cf[CF.BATCH_NAME])),
        method: match.method,
        candidates: candDetail(match.method === 'auto_exact' && match.recordId ? [match.recordId] : match.candidateIds),
      });
    }

    if (match.method === 'auto_exact' && match.recordId) {
      buckets.matched += 1;
      const rid = String(match.recordId);
      if (!matchedByRecord.has(rid)) matchedByRecord.set(rid, []);
      matchedByRecord.get(rid).push({gid, program});
      const plannerRow = plannerById.get(rid) || null;
      const drift = computeDrift(task, plannerRow, {customFieldsByName: cf});
      if (drift && Object.keys(drift).length > 0) {
        driftPreview.push({
          gid,
          recordId: rid,
          recordTitle: plannerRow ? (plannerRow.title ?? null) : null,
          source_id: plannerRow ? (plannerRow.source_id ?? null) : null,
          drift,
        });
      }
      continue;
    }

    if (match.method === 'historical') {
      buckets.historical += 1;
      continue;
    }

    // needs_review (>=1 candidate → deferred crosswalk) vs import_exception (no
    // candidate: unmatched >=2024 or no derivable year). Mirrors runSync exactly.
    const candidateIds = Array.isArray(match.candidateIds) ? match.candidateIds : [];
    if (candidateIds.length > 0) {
      buckets.needs_review += 1;
      review.push({
        gid,
        program,
        title,
        code,
        processing_date: row.processing_date,
        number_processed: row.number_processed,
        bucket: 'needs_review',
        reason: 'ambiguous_multiple_candidates',
        candidateIds,
        candidates: candDetail(candidateIds),
      });
      if (candidateIds.length >= 2) ambiguousCandidates.push({gid, title, program, code, candidateIds});
      continue;
    }

    buckets.import_exception += 1;
    review.push({
      gid,
      program,
      title,
      code,
      processing_date: row.processing_date,
      number_processed: row.number_processed,
      bucket: 'import_exception',
      reason: deriveProcessingYear(task, cf) != null ? 'unmatched_ge_2024' : 'no_derivable_year',
      candidateIds: [],
      candidates: [],
    });
  }

  const duplicateAsanaCodes = [];
  for (const [key, list] of codeIndex) {
    if (list.length >= 2) {
      const sep = key.indexOf('::');
      duplicateAsanaCodes.push({
        program: key.slice(0, sep),
        code: key.slice(sep + 2),
        gids: list.map((x) => x.gid),
        titles: list.map((x) => x.title),
      });
    }
  }

  // Planner rows taking >=2 auto matches. Pig legitimately links N Asana sub-batch
  // rows to one trip, so only coded programs are flagged as contested.
  const plannerContested = [];
  for (const [recordId, hits] of matchedByRecord) {
    if (hits.length < 2) continue;
    const r = plannerById.get(recordId);
    const program = r ? r.program : hits[0].program;
    if (program === 'pig') continue;
    plannerContested.push({
      recordId,
      title: r ? (r.title ?? null) : null,
      source_id: r ? (r.source_id ?? null) : null,
      program,
      gids: hits.map((x) => x.gid),
    });
  }

  return {
    tasksFetched: tasks.length,
    plannerRows: rows.length,
    buckets,
    review,
    milestones,
    collisions: {duplicateAsanaCodes, ambiguousCandidates, plannerContested},
    pigCandidates,
    driftPreview,
  };
}

// ── Asana task-template → processing_templates mapping (sub-lane 5) ────────────
// Asana task templates carry no section, so the WCF program is inferred from the
// template NAME. The single-template GET recipe (template.*) is the source: its
// subtasks are COMPACT (name + subtype only — no assignee/description/recursion)
// and its custom_fields expose name/type/default. We map:
//   recipe.subtasks[].name  → checklist[].{label, assignee:null}
//   recipe.custom_fields[]  → fields[].{name, type, asana_gid, default?, options?}
// matching the shapes upsert_processing_template + ProcessingTemplatesModal use.
// Everything here is PURE + deterministic (importable by vitest and the edge fn).

// Infer a WCF program from a template name. Returns a program only when exactly
// one program's keyword appears (word-boundary); none or ambiguous → null so the
// importer defers to an admin instead of guessing.
export function inferProgramFromTemplateName(name) {
  const s = cleanStr(name);
  if (!s) return null;
  const KW = [
    ['broiler', 'broiler'],
    ['broilers', 'broiler'],
    ['chicken', 'broiler'],
    ['chickens', 'broiler'],
    ['poultry', 'broiler'],
    ['cattle', 'cattle'],
    ['beef', 'cattle'],
    ['cow', 'cattle'],
    ['cows', 'cattle'],
    ['lamb', 'sheep'],
    ['lambs', 'sheep'],
    ['sheep', 'sheep'],
    ['mutton', 'sheep'],
    ['pig', 'pig'],
    ['pigs', 'pig'],
    ['pork', 'pig'],
    ['hog', 'pig'],
    ['hogs', 'pig'],
    ['swine', 'pig'],
  ];
  const found = new Set();
  for (const [kw, prog] of KW) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(s)) found.add(prog);
  }
  return found.size === 1 ? Array.from(found)[0] : null;
}

// Asana custom-field type (cf.type / resource_subtype) → our template field type.
function asanaTemplateFieldType(cf) {
  const t = cf && (cf.type || cf.resource_subtype);
  switch (t) {
    case 'enum':
      return 'single';
    case 'multi_enum':
      return 'multi';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'people':
      return 'people';
    case 'text':
      return 'text';
    default:
      return 'text';
  }
}

// Map ONE Asana task-template GET response into {program, fields[], checklist[]}
// plus provenance + warnings for anything the read API cannot carry.
export function mapAsanaTemplateToProcessing(templateResponse, opts = {}) {
  const tpl = templateResponse || {};
  const recipe = tpl.template || {};
  const warnings = [];

  const templateName = cleanStr(tpl.name) || cleanStr(recipe.name) || null;
  const program = (opts && opts.program) || inferProgramFromTemplateName(templateName);
  if (!program) warnings.push('no_program_inferred');

  const subs = Array.isArray(recipe.subtasks) ? recipe.subtasks : [];
  const checklist = [];
  for (const st of subs) {
    const label = cleanStr(st && st.name);
    if (label) checklist.push({label, assignee: null});
  }
  // The recipe's compact subtasks never carry an assignee — flag it once.
  if (subs.length > 0) warnings.push('subtask_assignees_not_readable');

  const cfs = Array.isArray(recipe.custom_fields) ? recipe.custom_fields : [];
  const fields = [];
  for (const cf of cfs) {
    const name = cleanStr(cf && cf.name);
    if (!name) continue;
    const field = {name, type: asanaTemplateFieldType(cf)};
    if (cf && cf.gid != null) field.asana_gid = String(cf.gid);
    const def = customFieldDisplay(cf);
    if (def != null && def !== '') field.default = def;
    if (Array.isArray(cf.enum_options)) {
      // Normalized option shape {key, label, color:{bg,ink}, asana_gid?} so a
      // re-import compares equal to what the editor stores (idempotent) and
      // Asana option colors survive the import (mapped to the locked palette).
      const options = cf.enum_options
        .map((o) => {
          const label = cleanStr(o && o.name);
          if (!label) return null;
          const out = {
            key: optionKeySlug(label),
            label,
            color: asanaColorToPalette(o && o.color),
          };
          if (o && o.gid != null) out.asana_gid = String(o.gid);
          return out;
        })
        .filter((x) => x != null);
      if (options.length) field.options = options;
    }
    fields.push(field);
  }

  return {
    asana_template_gid: tpl.gid != null ? String(tpl.gid) : null,
    templateName,
    program,
    fields,
    checklist,
    warnings,
    meta: {
      task_name: cleanStr(recipe.name),
      relative_start_on: recipe.relative_start_on ?? null,
      relative_due_on: recipe.relative_due_on ?? null,
      description: cleanStr(recipe.description),
    },
  };
}

// Normalize ONE template option (string | {label,bg,ink} | {label,color}) into
// the comparable {key, label, color:{bg,ink}} shape. Colorless legacy options
// compare as the default grey so an import that only ADDS colors is a change.
const TEMPLATE_DEFAULT_OPTION_COLOR = Object.freeze({bg: '#C8CDD3', ink: '#3F4650'});
function optionKeySlug(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function normalizeTemplateOption(opt) {
  if (opt == null) return null;
  if (typeof opt === 'string') {
    const label = cleanStr(opt);
    if (!label) return null;
    return {key: optionKeySlug(label), label, color: {...TEMPLATE_DEFAULT_OPTION_COLOR}};
  }
  const label = cleanStr(opt.label != null ? opt.label : opt.name);
  if (!label) return null;
  const bg = (opt.color && opt.color.bg) || opt.bg || TEMPLATE_DEFAULT_OPTION_COLOR.bg;
  const ink = (opt.color && opt.color.ink) || opt.ink || TEMPLATE_DEFAULT_OPTION_COLOR.ink;
  return {key: opt.key || optionKeySlug(label), label, color: {bg, ink}};
}

// Asana enum-option color NAMES → the locked 12-color palette (bg/ink). Unknown
// or absent colors fall back to the default grey pair.
const ASANA_COLOR_TO_PALETTE = Object.freeze({
  red: {bg: '#E07A6E', ink: '#6E1C15'},
  orange: {bg: '#E4924A', ink: '#6F3711'},
  'yellow-orange': {bg: '#E4924A', ink: '#6F3711'},
  yellow: {bg: '#E8B73E', ink: '#5A4304'},
  'yellow-green': {bg: '#93C896', ink: '#285F33'},
  green: {bg: '#93C896', ink: '#285F33'},
  'blue-green': {bg: '#7FC6BE', ink: '#1E5F57'},
  aqua: {bg: '#7FC6BE', ink: '#1E5F57'},
  blue: {bg: '#6AA6DD', ink: '#173B5E'},
  indigo: {bg: '#8E9BE0', ink: '#2A2F66'},
  purple: {bg: '#C09BE0', ink: '#3F2E66'},
  magenta: {bg: '#E59CC0', ink: '#6F2A50'},
  'hot-pink': {bg: '#E59CC0', ink: '#6F2A50'},
  pink: {bg: '#F0B3A8', ink: '#9F3322'},
  'cool-gray': {bg: '#C8CDD3', ink: '#3F4650'},
  gray: {bg: '#C8CDD3', ink: '#3F4650'},
});
export function asanaColorToPalette(colorName) {
  const key = cleanStr(colorName);
  if (key && Object.prototype.hasOwnProperty.call(ASANA_COLOR_TO_PALETTE, key.toLowerCase())) {
    return {...ASANA_COLOR_TO_PALETTE[key.toLowerCase()]};
  }
  return {...TEMPLATE_DEFAULT_OPTION_COLOR};
}

// Stable content key over everything MEANINGFUL a template carries: field
// order, name, type, DEFAULT, and full option lists (label + color, in order),
// plus checklist step order + labels. A change to any of those can never be
// classified 'unchanged'. Deliberately EXCLUDED: checklist assignees — the
// Asana task-template API cannot express them (documented null-assignee
// behavior), so planner-side step assignments are enrichment the import must
// neither detect as drift nor clobber (see mergeTemplateChecklistAssignees).
export function templateContentKey(template) {
  const t = template || {};
  const fields = (Array.isArray(t.fields) ? t.fields : []).map((f) => ({
    name: cleanStr(f && f.name),
    type: cleanStr(f && f.type) || 'text',
    default: f && f.default != null && f.default !== '' ? f.default : null,
    options: (Array.isArray(f && f.options) ? f.options : [])
      .map(normalizeTemplateOption)
      .filter((x) => x != null)
      .map((o) => ({label: o.label, color: o.color})),
  }));
  const checklist = (Array.isArray(t.checklist) ? t.checklist : []).map((c) => ({
    label: cleanStr(c && c.label),
  }));
  return stableStringify({fields, checklist});
}

// Carry planner-side checklist assignees across a template re-import: for each
// imported step, adopt the assignee/assignee_profile_id of the FIRST unconsumed
// active step with the same label (order shifts keep assignments; renamed steps
// intentionally reset). Pure — returns a NEW checklist array.
export function mergeTemplateChecklistAssignees(importedChecklist, activeChecklist) {
  const imported = Array.isArray(importedChecklist) ? importedChecklist : [];
  const pool = (Array.isArray(activeChecklist) ? activeChecklist : []).map((s) => ({step: s, used: false}));
  return imported.map((step) => {
    const label = cleanStr(step && step.label);
    const hit = pool.find((p) => !p.used && cleanStr(p.step && p.step.label) === label);
    if (!hit) return {...step};
    hit.used = true;
    return {
      ...step,
      assignee: hit.step.assignee != null ? hit.step.assignee : (step && step.assignee) || null,
      assignee_profile_id: hit.step.assignee_profile_id || null,
    };
  });
}

// Build the import plan for a set of Asana task-template responses against the
// currently-active processing_templates (keyed by program). PURE + deterministic.
// Per item status:
//   'ready'      — single template for its program, differs from active → write
//   'unchanged'  — single template equal to the active one → skip (idempotent)
//   'conflict'   — >=2 templates map to the same program → skip, admin resolves
//   'no_program' — program couldn't be inferred → skip, admin resolves
// activeByProgram: { [program]: {fields, checklist} } (from processing_templates
// where is_active). Only 'ready' items should be written.
export function buildTemplateImportPlan(rawTemplates, activeByProgram = {}) {
  const list = Array.isArray(rawTemplates) ? rawTemplates : [];
  const items = [];
  const byProgram = {};
  for (const raw of list) {
    const m = mapAsanaTemplateToProcessing(raw);
    const item = {
      asana_template_gid: m.asana_template_gid,
      templateName: m.templateName,
      program: m.program,
      fields: m.fields,
      checklist: m.checklist,
      warnings: m.warnings.slice(),
      status: m.program ? 'ready' : 'no_program',
    };
    if (m.program) {
      if (!byProgram[m.program]) byProgram[m.program] = [];
      byProgram[m.program].push(item);
    }
    items.push(item);
  }
  for (const arr of Object.values(byProgram)) {
    if (arr.length >= 2) {
      for (const it of arr) {
        it.status = 'conflict';
        it.warnings.push('multiple_templates_for_program');
      }
      continue;
    }
    const it = arr[0];
    const active = activeByProgram && activeByProgram[it.program];
    if (active && templateContentKey(it) === templateContentKey(active)) it.status = 'unchanged';
  }
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    items,
    summary: {
      total: items.length,
      ready: count('ready'),
      unchanged: count('unchanged'),
      conflict: count('conflict'),
      no_program: count('no_program'),
    },
  };
}

// ── Users, mentions, system stories, rate limits, destination audit ───────────
// (importer-completeness layer; PURE — the edge function feeds fetched JSON in.)

// Build a user directory from GET /users?workspace=…&opt_fields=name,email —
// stable gid/email identity, never display name alone.
//   byGid:   { [gid]: {gid, name, email} }
//   byEmail: { [lowercased email]: gid }
export function buildUserDirectory(users) {
  const byGid = {};
  const byEmail = {};
  for (const u of Array.isArray(users) ? users : []) {
    if (!u || u.gid == null) continue;
    const gid = String(u.gid);
    const email = cleanStr(u.email);
    byGid[gid] = {gid, name: cleanStr(u.name), email};
    if (email) byEmail[email.toLowerCase()] = gid;
  }
  return {byGid, byEmail};
}

// Resolve an Asana user (by gid) to a planner profile id via email match.
// profilesByEmail: { [lowercased email]: profileId } (service-role read).
// Returns {profileId|null, name|null} — a miss keeps the display name as the
// documented fallback destination.
export function mapAsanaUserToProfile(assigneeGid, directory, profilesByEmail) {
  const gid = assigneeGid != null ? String(assigneeGid) : null;
  const user = gid && directory && directory.byGid ? directory.byGid[gid] : null;
  if (!user) return {profileId: null, name: null};
  const email = user.email ? user.email.toLowerCase() : null;
  const profileId = email && profilesByEmail && profilesByEmail[email] ? profilesByEmail[email] : null;
  return {profileId, name: user.name || null};
}

// Extract mentioned planner profile ids from an Asana comment body. Asana
// renders mentions in story text as profile URLs
// (https://app.asana.com/0/profile/<user gid>). Every resolvable mention maps
// gid -> email -> profile id; unresolvable mentions stay display-only text.
export function parseAsanaMentionProfileIds(text, directory, profilesByEmail) {
  const out = [];
  const seen = new Set();
  const s = String(text || '');
  const re = /https:\/\/app\.asana\.com\/0\/profile\/(\d+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const {profileId} = mapAsanaUserToProfile(m[1], directory, profilesByEmail);
    if (profileId && !seen.has(profileId)) {
      seen.add(profileId);
      out.push(profileId);
    }
  }
  return out;
}

// True for an Asana SYSTEM story (status set, assigned, due date changed…) —
// the history feed the comments import intentionally skips.
export function isSystemStory(story) {
  return !!story && story.type === 'system';
}

// Map an Asana system story → p_row for record_processing_history_event.
export function mapAsanaSystemStory(story, parentGid) {
  const s = story || {};
  return {
    parent_asana_gid: parentGid != null ? String(parentGid) : null,
    asana_story_gid: s.gid != null ? String(s.gid) : null,
    body: s.text != null ? String(s.text) : '',
    original_author_name: s.created_by && s.created_by.name != null ? String(s.created_by.name) : null,
    created_at: s.created_at || null,
  };
}

// ── Attachment storage keys ───────────────────────────────────────────────────

// Strict safe-segment validation for storage-key parts: a plain Asana numeric
// gid and nothing else. Anything unexpected throws instead of producing a key.
export function safeAsanaKeySegment(value, label = 'gid') {
  const s = String(value == null ? '' : value);
  if (!/^\d{1,32}$/.test(s)) {
    throw new Error(`unsafe ${label} for storage key: must be a plain Asana numeric gid`);
  }
  return s;
}

// The ONE storage-key convention for Asana attachment bytes:
// <parent_asana_gid>/<asana_attachment_gid>. Keys are built from Asana
// identifiers ONLY — filenames never participate, so unsafe filename
// characters (#, ?, slashes, control characters, Unicode forms, length) can
// never truncate or mangle an object key. The original filename lives only in
// metadata (processing_attachments.filename) and stays what the UI displays.
// (Pre-repair imports embedded the filename; the 2026-07-15 PROD repair moved
// those objects to this convention.)
export function asanaAttachmentStorageKey(parentGid, attachmentGid) {
  return `${safeAsanaKeySegment(parentGid, 'parent gid')}/${safeAsanaKeySegment(attachmentGid, 'attachment gid')}`;
}

// ── Conversation fidelity (comments ⇄ attachments) ───────────────────────────

// Extract the attachment gids a comment story references INLINE via its
// html_text (`<a data-asana-gid="…" data-asana-type="attachment" …>`). This is
// the STABLE story→attachment relationship Asana supplies for media posted in
// the conversation; attribute order inside the anchor tag is tolerated.
export function parseHtmlTextAttachmentGids(htmlText) {
  const out = [];
  const seen = new Set();
  const s = String(htmlText || '');
  const anchorRe = /<a\b[^>]*>/gi;
  let m;
  while ((m = anchorRe.exec(s)) !== null) {
    const tag = m[0];
    if (!/data-asana-type="attachment"/i.test(tag)) continue;
    // gid value taken verbatim; callers constrain it against the task's real
    // attachment gid set, so the parser doesn't assume Asana's numeric format.
    const gidMatch = /data-asana-gid="([^"]+)"/i.exec(tag);
    if (gidMatch && !seen.has(gidMatch[1])) {
      seen.add(gidMatch[1]);
      out.push(gidMatch[1]);
    }
  }
  return out;
}

// Build ONE task's conversation-fidelity plan from its raw stories +
// attachments and the already-imported baselines. PURE + deterministic.
//   stories:      GET /tasks/{gid}/stories rows (type, resource_subtype, text,
//                 html_text, created_at, created_by{gid,name})
//   attachments:  GET /tasks/{gid}/attachments rows (gid, name, size,
//                 created_at, download_url, …)
//   importedCommentGids:   Set/array of comments.asana_comment_gid already in
//                          the planner
//   storedAttachmentGids:  Set/array of processing_attachments.asana_attachment_gid
// Classification:
//   text_comment    — comment story, no attachment refs (sync_comments owns it)
//   media_comment   — comment story with text + inline attachment refs
//   file_only_post  — comment story whose body is empty but references media,
//                     OR an unreferenced attachment whose author/timestamp is
//                     carried by exactly ONE 'attachment_added' system story
//                     (association: 'attachment_story')
//   task_attachment — attachment with NO conversational context at all
// Ambiguity is EXPLICIT: an unreferenced attachment matching zero or several
// attachment_added stories by filename lands in `ambiguous`, never guessed by
// timestamp alone.
export function buildConversationPlan(input) {
  const {stories = [], attachments = [], importedCommentGids = [], storedAttachmentGids = []} = input || {};
  const imported = importedCommentGids instanceof Set ? importedCommentGids : new Set(importedCommentGids);
  const stored = storedAttachmentGids instanceof Set ? storedAttachmentGids : new Set(storedAttachmentGids);

  const attsByGid = new Map();
  for (const a of attachments) {
    if (a && a.gid != null) attsByGid.set(String(a.gid), a);
  }

  const items = [];
  const ambiguous = [];
  const claimed = new Set(); // attachment gids owned by a comment story
  const directAmbiguous = new Set();

  // 1. Comment stories: the html_text inline refs are the direct relationship.
  // Resolve them in two passes so a malformed/duplicated attachment reference
  // cannot be silently awarded to whichever story happened to sort first.
  const commentRows = [];
  const directOwners = new Map();
  for (const s of stories) {
    if (!s || s.type !== 'comment') continue;
    const gid = s.gid != null ? String(s.gid) : null;
    const refs = parseHtmlTextAttachmentGids(s.html_text).filter((g) => attsByGid.has(g));
    commentRows.push({story: s, gid, refs});
    for (const g of refs) {
      const owners = directOwners.get(g) || [];
      owners.push(gid);
      directOwners.set(g, owners);
    }
  }
  for (const [attachmentGid, ownerGids] of directOwners) {
    if (ownerGids.length <= 1) continue;
    directAmbiguous.add(attachmentGid);
    ambiguous.push({
      attachmentGid,
      filename: attsByGid.get(attachmentGid)?.name || null,
      reason: `${ownerGids.length} comment stories reference this attachment — association not inferable`,
      storyGids: ownerGids,
    });
  }
  for (const {story: s, gid, refs: rawRefs} of commentRows) {
    const refs = rawRefs.filter((g) => !directAmbiguous.has(g));
    for (const g of refs) claimed.add(g);
    const body = cleanStr(s.text) || '';
    const kind = refs.length === 0 ? 'text_comment' : body ? 'media_comment' : 'file_only_post';
    items.push({
      kind,
      storyGid: gid,
      body,
      author: s.created_by && s.created_by.name != null ? String(s.created_by.name) : null,
      authorGid: s.created_by && s.created_by.gid != null ? String(s.created_by.gid) : null,
      created_at: s.created_at || null,
      attachmentGids: refs,
      association: refs.length ? 'html_ref' : 'none',
      alreadyImportedComment: gid != null && imported.has(gid),
      newAttachmentGids: refs.filter((g) => !stored.has(g)),
    });
  }

  // 2. Unclaimed attachments: exactly ONE attachment_added system story naming
  //    the file carries its author/timestamp (association: 'attachment_story').
  const attachStories = stories.filter((s) => s && s.type === 'system' && s.resource_subtype === 'attachment_added');
  const fallbackMatches = new Map();
  const singleStoryClaims = new Map();
  for (const [gid, att] of attsByGid) {
    if (claimed.has(gid) || directAmbiguous.has(gid)) continue;
    const name = cleanStr(att.name) || '';
    const matches = name ? attachStories.filter((s) => String(s.text || '').includes(name)) : [];
    fallbackMatches.set(gid, matches);
    if (matches.length === 1) {
      const claimers = singleStoryClaims.get(matches[0]) || [];
      claimers.push(gid);
      singleStoryClaims.set(matches[0], claimers);
    }
  }
  for (const [gid, att] of attsByGid) {
    if (claimed.has(gid)) continue;
    const name = cleanStr(att.name) || '';
    const matches = fallbackMatches.get(gid) || [];
    const singleStoryIsUnique = matches.length === 1 && (singleStoryClaims.get(matches[0]) || []).length === 1;
    if (!directAmbiguous.has(gid) && singleStoryIsUnique) {
      const s = matches[0];
      items.push({
        kind: 'file_only_post',
        storyGid: s.gid != null ? String(s.gid) : null,
        body: '',
        author: s.created_by && s.created_by.name != null ? String(s.created_by.name) : null,
        authorGid: s.created_by && s.created_by.gid != null ? String(s.created_by.gid) : null,
        created_at: s.created_at || att.created_at || null,
        attachmentGids: [gid],
        association: 'attachment_story',
        alreadyImportedComment: s.gid != null && imported.has(String(s.gid)),
        newAttachmentGids: stored.has(gid) ? [] : [gid],
      });
      claimed.add(gid);
      continue;
    }
    if (!directAmbiguous.has(gid) && matches.length > 1) {
      ambiguous.push({
        attachmentGid: gid,
        filename: name || null,
        reason: `${matches.length} attachment_added stories name this file — association not inferable`,
        storyGids: matches.map((s) => (s.gid != null ? String(s.gid) : null)),
      });
    } else if (!directAmbiguous.has(gid) && matches.length === 1 && !singleStoryIsUnique) {
      const s = matches[0];
      const claimers = singleStoryClaims.get(s) || [];
      ambiguous.push({
        attachmentGid: gid,
        filename: name || null,
        reason: `one attachment_added story matches ${claimers.length} attachments — association not inferable`,
        storyGids: [s.gid != null ? String(s.gid) : null],
      });
    }
    // Zero or many matches → no conversational context is claimed.
    items.push({
      kind: 'task_attachment',
      storyGid: null,
      body: '',
      author: null,
      authorGid: null,
      created_at: att.created_at || null,
      attachmentGids: [gid],
      association: 'none',
      alreadyImportedComment: false,
      newAttachmentGids: stored.has(gid) ? [] : [gid],
    });
  }

  const count = (kind) => items.filter((i) => i.kind === kind).length;
  const conversationItems = items.filter((i) => i.kind === 'media_comment' || i.kind === 'file_only_post');
  return {
    items,
    ambiguous,
    counts: {
      textComments: count('text_comment'),
      mediaComments: count('media_comment'),
      fileOnlyPosts: count('file_only_post'),
      taskAttachments: count('task_attachment'),
      alreadyImported: items.filter((i) => i.kind !== 'task_attachment' && i.alreadyImportedComment).length,
      missingComments: items.filter((i) => i.kind !== 'task_attachment' && !i.alreadyImportedComment).length,
      newMediaBytes: conversationItems.reduce((s, i) => s + i.newAttachmentGids.length, 0),
      ambiguous: ambiguous.length,
    },
  };
}

// Map one conversation-plan item (media_comment | file_only_post) plus its
// fetched attachment objects into the p_row record_processing_comment_media
// accepts. `storagePathFor(gid, filename)` is injected so the path convention
// stays owned by the edge layer (and matches attachment_backfill exactly).
export function conversationItemToCommentMediaRow(item, parentGid, attsByGid, storagePathFor, mentions = []) {
  const metas = (item.attachmentGids || [])
    .map((gid) => {
      const att = attsByGid instanceof Map ? attsByGid.get(gid) : attsByGid && attsByGid[gid];
      if (!att) return null;
      const filename = att.name != null ? String(att.name) : `attachment-${gid}`;
      return {
        asana_attachment_gid: gid,
        filename,
        content_type: null, // resolved at download time by the edge layer
        size_bytes: att.size != null ? Number(att.size) : null,
        storage_path: storagePathFor(gid, filename),
        original_created_at: att.created_at || null,
      };
    })
    .filter(Boolean);
  return {
    parent_asana_gid: parentGid != null ? String(parentGid) : null,
    asana_comment_gid: item.storyGid,
    body: item.body || '',
    original_author_name: item.author,
    created_at: item.created_at,
    mentions,
    attachments: metas,
  };
}

// HTTP 429 backoff: milliseconds to wait before retry `attempt` (1-based),
// honoring a numeric Retry-After header (seconds) when present. Exponential
// fallback capped at 30s. Pure — no clock access.
export function retryAfterMs(retryAfterHeader, attempt) {
  const n = Number(String(retryAfterHeader == null ? '' : retryAfterHeader).trim());
  if (Number.isFinite(n) && n > 0) return Math.min(n, 60) * 1000;
  const a = Math.max(1, Number(attempt) || 1);
  return Math.min(1000 * Math.pow(2, a - 1), 30000);
}

// ── Destination audit (fail-closed zero-unmapped report) ─────────────────────
// Prove EVERY piece of live Asana data has a planner destination BEFORE any
// write import. Input is raw fetched JSON; output:
//   {ok, unmapped:[{kind, id, name, reason}], counts, users, fields}
// A NON-EMPTY unmapped list must block every write action (edge-enforced).
// Users resolve to a profile (email match) OR the documented display-name
// fallback — only an identity-less user is unmapped. Dependencies have NO
// destination (ground truth: zero live dependencies); any appearing → unmapped.
export function buildDestinationAudit(input) {
  const {
    sections = [],
    customFieldSettings = [],
    users = [],
    tasks = [],
    storyTypeCounts = {},
    dependencyCount = 0,
    taskTemplates = [],
    subtaskCount = null,
    attachmentCount = null,
    profilesByEmail = {},
  } = input || {};
  const unmapped = [];

  // Sections → programs. Empty/"(no section)" rows classify as milestones by
  // design; any OTHER unknown section blocks.
  const sectionReport = [];
  for (const sec of sections) {
    const name = cleanStr(sec && sec.name);
    const program = sectionToProgram(name);
    sectionReport.push({gid: sec && sec.gid != null ? String(sec.gid) : null, name, program});
    if (name && !program && !/untitled section/i.test(name)) {
      unmapped.push({kind: 'section', id: sec && sec.gid, name, reason: 'no program mapping'});
    }
  }

  // Custom fields (+ every enum option) → CF_DESTINATIONS.
  const fieldReport = [];
  for (const setting of customFieldSettings) {
    const cf = (setting && setting.custom_field) || setting || {};
    const name = cleanStr(cf.name);
    if (!name) continue;
    const destination = Object.prototype.hasOwnProperty.call(CF_DESTINATIONS, name) ? CF_DESTINATIONS[name] : null;
    const options = (Array.isArray(cf.enum_options) ? cf.enum_options : []).map((o) => ({
      gid: o && o.gid != null ? String(o.gid) : null,
      name: cleanStr(o && o.name),
      color: cleanStr(o && o.color),
      palette: asanaColorToPalette(o && o.color),
    }));
    fieldReport.push({
      gid: cf.gid != null ? String(cf.gid) : null,
      name,
      type: cleanStr(cf.type || cf.resource_subtype),
      destination,
      options,
    });
    if (!destination) {
      unmapped.push({kind: 'field', id: cf.gid, name, reason: 'no destination in CF_DESTINATIONS'});
    }
    for (const o of options) {
      if (!o.name) unmapped.push({kind: 'option', id: o.gid, name: null, reason: 'unnamed option on ' + name});
    }
  }

  // Users → profile match or display-name fallback.
  const directory = buildUserDirectory(users);
  const userReport = Object.values(directory.byGid).map((u) => ({
    gid: u.gid,
    name: u.name,
    email: u.email,
    profile_id: u.email && profilesByEmail[u.email.toLowerCase()] ? profilesByEmail[u.email.toLowerCase()] : null,
  }));
  for (const u of userReport) {
    if (!u.name && !u.email) {
      unmapped.push({kind: 'user', id: u.gid, name: null, reason: 'no name or email identity'});
    }
  }

  // Story types: comment + system have destinations; anything else blocks.
  for (const [type, count] of Object.entries(storyTypeCounts || {})) {
    if (type !== 'comment' && type !== 'system' && count > 0) {
      unmapped.push({kind: 'story_type', id: null, name: type, reason: count + ' stories of unmapped type'});
    }
  }

  // Dependencies: no planner destination exists — any live dependency blocks.
  if (Number(dependencyCount) > 0) {
    unmapped.push({
      kind: 'dependency',
      id: null,
      name: 'dependencies/dependents',
      reason: dependencyCount + ' live dependency link(s) have no planner destination',
    });
  }

  return {
    ok: unmapped.length === 0,
    unmapped,
    counts: {
      sections: sectionReport.length,
      fields: fieldReport.length,
      options: fieldReport.reduce((s, f) => s + f.options.length, 0),
      users: userReport.length,
      usersMatched: userReport.filter((u) => u.profile_id).length,
      tasks: Array.isArray(tasks) ? tasks.length : 0,
      taskTemplates: Array.isArray(taskTemplates) ? taskTemplates.length : 0,
      subtasks: subtaskCount,
      attachments: attachmentCount,
      dependencyCount: Number(dependencyCount) || 0,
      storyTypes: storyTypeCounts,
    },
    sections: sectionReport,
    fields: fieldReport,
    users: userReport,
  };
}
