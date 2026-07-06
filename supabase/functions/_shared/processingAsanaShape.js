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
//     migration-155 importer RPCs accept (upsert_processing_from_asana,
//     upsert_processing_subtask_from_asana), classifies record_type, and diffs
//     a batch of mapped rows against what is already stored (idempotency).
//   - The edge function owns all network I/O + the service_role RPC calls +
//     the real match lookups. classifyRecordType exposes the pure *rules*; the
//     edge fn feeds it the `matched` signal it resolves at run time.
//
// Contract references (migration 155):
//   processing_records columns / upsert_processing_from_asana p_row keys:
//     asana_gid, record_type, program, title, processing_date, status,
//     processor, number_processed, customer(jsonb array), source_kind,
//     source_id, asana_project_gid, asana_section_gid, asana_section_name,
//     match_status, match_confidence, match_evidence, historical_snapshot,
//     raw_asana_snapshot, sync_run_id.
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

// ── Year derivation (shared by mapper + classifier) ─────────────────────────

// Best-effort processing year: the explicit 'Year' custom field wins; else the
// year of actual→planned proc date → due_on → start_on.
function deriveYear(task, cf) {
  const explicit = toInt(cf[CF.YEAR]);
  if (explicit) return explicit;
  const d = toDateOnly(
    firstNonEmpty(cf[CF.ACTUAL_PROC], cf[CF.PLANNED_PROC], task && task.due_on, task && task.start_on),
  );
  if (d) return Number.parseInt(d.slice(0, 4), 10);
  return null;
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

// Pure record_type rules. The edge fn resolves the real match and passes the
// `matched` boolean; everything else is derivable from the task itself.
//   1. resource_subtype 'milestone', OR no resolvable program → 'milestone'
//   2. year ≥ 2026 AND a program:
//        matched === false → 'import_exception' (an unmatched 2026 planner task)
//        otherwise         → 'planner_batch'    (matchable / matched)
//   3. otherwise (pre-2026, or no year, with a program) → 'asana_historical'
// opts: { sectionName, program, customFieldsByName, matched }
export function classifyRecordType(task, opts = {}) {
  const {sectionName = null, matched} = opts || {};
  const program =
    opts && Object.prototype.hasOwnProperty.call(opts, 'program') ? opts.program : sectionToProgram(sectionName);

  if (task && task.resource_subtype === 'milestone') return 'milestone';
  if (!program) return 'milestone';

  const cf = normalizeCfMap(
    opts && opts.customFieldsByName != null ? opts.customFieldsByName : indexCustomFields(task),
  );
  const year = deriveYear(task, cf);

  if (year != null && year >= 2026) {
    if (matched === false) return 'import_exception';
    return 'planner_batch';
  }
  return 'asana_historical';
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
