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
//                processing_date, status, number_processed, sub_batch_attribution}
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
  if (program === 'pig') {
    const date = toDateOnly(firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on));
    const count = toInt(cf[CF.ANIMALS]);
    const taskTokens = pigSubBatchTokens(cf[CF.BATCH_NAME]);
    const candidates = rows.filter((r) => {
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
export function mapAsanaSubtask(subtask, parentGid, sortOrder) {
  const s = subtask || {};
  return {
    asana_gid: s.gid != null ? String(s.gid) : null,
    parent_asana_gid: parentGid != null ? String(parentGid) : null,
    label: s.name != null ? String(s.name) : '(untitled)',
    assignee: s.assignee && s.assignee.name != null ? String(s.assignee.name) : null,
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
