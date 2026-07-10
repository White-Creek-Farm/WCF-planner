// ============================================================================
// src/lib/processingFields.js — Processing custom-field engine (pure)
// ----------------------------------------------------------------------------
// PURE, deterministic helpers for the template-driven Processing record fields:
//   • DEFAULT_PROCESSING_FIELDS — the per-program default field layout with the
//     STABLE ids from the design handoff §6 (Asana custom fields map to these
//     ids). "Reset to default" in the Templates manager restores these.
//   • PROCESSING_FIELD_PALETTE — the 12 bg/ink select-option color pairs from
//     the handoff prototype (the only colors the option editor may assign).
//   • Field BINDINGS (ownership matrix): a bound field reads from the record /
//     a derived calc / a dedicated RPC and is NOT writable through the generic
//     set_processing_field path. Everything else is a local Processing-owned
//     value stored in processing_records.fields keyed by the field id.
//   • Derived formulas — the three handoff formula fields are implemented HERE
//     (never authored in the template UI): Actual Time On Farm, Planned Time on
//     Farm, Time Remaining Until Processing.
//   • resolveFieldDisplay — one precedence chain for every field:
//     local fields[fid]  >  imported historical_snapshot  >  derived/record.
//
// No I/O, no Date.now() (callers pass todayISO), importable by vitest + the UI.
// Server mirror: set_processing_field (mig 164) refuses the RESERVED ids below;
// keep the two lists in lockstep.
// ============================================================================

// ── 12-color option palette (prototype PALETTE, bg/ink pairs) ────────────────
export const PROCESSING_FIELD_PALETTE = Object.freeze([
  {bg: '#E07A6E', ink: '#6E1C15'},
  {bg: '#E4924A', ink: '#6F3711'},
  {bg: '#E8B73E', ink: '#5A4304'},
  {bg: '#93C896', ink: '#285F33'},
  {bg: '#7FC6BE', ink: '#1E5F57'},
  {bg: '#6AA6DD', ink: '#173B5E'},
  {bg: '#8E9BE0', ink: '#2A2F66'},
  {bg: '#C09BE0', ink: '#3F2E66'},
  {bg: '#E59CC0', ink: '#6F2A50'},
  {bg: '#BFE3CB', ink: '#245737'},
  {bg: '#F0B3A8', ink: '#9F3322'},
  {bg: '#C8CDD3', ink: '#3F4650'}, // default grey for new options
]);
export const DEFAULT_OPTION_COLOR = PROCESSING_FIELD_PALETTE[11];

export const PROCESSING_FIELD_TYPES = Object.freeze(['text', 'number', 'date', 'single', 'multi', 'people', 'formula']);

// ── Option normalization ─────────────────────────────────────────────────────
// Template select options are stored as {key, label, color:{bg,ink}}. Accepts
// legacy shapes: a bare string (Asana template import), {label,bg,ink}
// (prototype), or an already-normalized object. Deterministic key from label.
export function optionKeyFromLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function normalizeFieldOption(opt) {
  if (opt == null) return null;
  if (typeof opt === 'string') {
    const label = opt.trim();
    if (!label) return null;
    return {key: optionKeyFromLabel(label), label, color: {...DEFAULT_OPTION_COLOR}};
  }
  const label = String(opt.label ?? opt.name ?? '').trim();
  if (!label) return null;
  const bg = (opt.color && opt.color.bg) || opt.bg || DEFAULT_OPTION_COLOR.bg;
  const ink = (opt.color && opt.color.ink) || opt.ink || DEFAULT_OPTION_COLOR.ink;
  return {key: opt.key || optionKeyFromLabel(label), label, color: {bg, ink}};
}

export function normalizeFieldDef(field) {
  if (!field || typeof field !== 'object') return null;
  const name = String(field.name || '').trim();
  if (!name) return null;
  const type = PROCESSING_FIELD_TYPES.includes(field.type) ? field.type : 'text';
  const out = {...field, name, type};
  if (!out.id) out.id = 'fld-' + optionKeyFromLabel(name);
  if (type === 'single' || type === 'multi') {
    const options = (Array.isArray(field.options) ? field.options : []).map(normalizeFieldOption).filter(Boolean);
    out.options = options;
  } else if ('options' in out) {
    // keep authored option data across a type change (prototype behavior)
  }
  return out;
}

// ── Default per-program field layout (handoff §6; ids are STABLE) ────────────
const STATUS_OPTIONS = [
  {key: 'planned', label: 'Planned', color: {bg: '#E8B73E', ink: '#5A4304'}},
  {key: 'reserved', label: 'Reserved', color: {bg: '#93C896', ink: '#285F33'}},
  // Asana's real (misspelled) option name — display normalizes to "In Process".
  {key: 'in_proccess', label: 'In-Proccess', color: {bg: '#E4924A', ink: '#6F3711'}},
  {key: 'completed', label: 'Completed', color: {bg: '#E07A6E', ink: '#6E1C15'}},
  {key: 'tbc', label: 'TBC', color: {bg: '#E59CC0', ink: '#6F2A50'}},
  {key: 'goal', label: 'Goal', color: {bg: '#6AA6DD', ink: '#173B5E'}},
];
const CUSTOMER_OPTIONS_DEFAULT = [
  {key: 'sonnys', label: "Sonny's", color: {bg: '#BFE3CB', ink: '#245737'}},
  {key: 'coastal_confirmed', label: 'Coastal Pastures - CONFIRMED', color: {bg: '#F0B3A8', ink: '#9F3322'}},
  {key: 'coastal_potential', label: 'Coastal Pastures - POTENTIAL', color: {bg: '#EFC07E', ink: '#875213'}},
];
const ANIMAL_MASTER_OPTIONS = [
  {key: 'scheduled', label: 'Scheduled', color: {bg: '#EDEFF1', ink: '#5B626C'}},
  {key: 'on_farm', label: 'On Farm', color: {bg: '#E7EDF8', ink: '#3B6CB7'}},
  {key: 'inventoried', label: 'Inventoried', color: {bg: '#DDF1EE', ink: '#2E7A73'}},
];

function baseFields() {
  return [
    {id: 'procActual', name: 'Actual Processing Date (SF)', type: 'date'},
    {id: 'status', name: 'Status (Processing)', type: 'single', options: STATUS_OPTIONS},
    {
      id: 'program',
      name: 'Farm Programs',
      type: 'single',
      options: [
        {key: 'broiler', label: 'Broiler', color: {bg: '#E8B73E', ink: '#5A4304'}},
        {key: 'cattle', label: 'Cattle', color: {bg: '#F0B3A8', ink: '#9F3322'}},
        {key: 'pig', label: 'Pigs', color: {bg: '#6AA6DD', ink: '#173B5E'}},
        {key: 'sheep', label: 'Lambs', color: {bg: '#93C896', ink: '#285F33'}},
      ],
    },
    {id: 'batchName', name: 'Batch Name (Farms)', type: 'text'},
    {
      id: 'farm',
      name: 'Farm',
      type: 'single',
      options: [{key: 'wcf', label: 'WCF', color: {bg: '#DDF1EE', ink: '#2E7A73'}}],
    },
    {id: 'animals', name: 'Animals Processed', type: 'number'},
    {id: 'condemned', name: 'Condemed', type: 'number'}, // Asana's spelling — keep
    {id: 'farmArrival', name: 'Farm Arrival Date', type: 'date'},
    {
      id: 'year',
      name: 'Year',
      type: 'single',
      options: [
        {key: 'y2026', label: '2026', color: {bg: '#EDEFF1', ink: '#5B626C'}},
        {key: 'y2027', label: '2027', color: {bg: '#EDEFF1', ink: '#5B626C'}},
      ],
    },
    {id: 'animalMaster', name: 'Status (Animal Master)', type: 'single', options: ANIMAL_MASTER_OPTIONS},
    {id: 'procPlanned', name: 'Planned Processing Date (SF)', type: 'date'},
    {id: 'actualTOF', name: 'Actual Time On Farm', type: 'formula'},
    {id: 'plannedTOF', name: 'Planned Time on Farm', type: 'formula'},
    {id: 'timeRemaining', name: 'Time Remaining Until Processing', type: 'formula'},
    {id: 'productPickup', name: 'Product Pick-up Date', type: 'date'},
    {id: 'processor', name: 'Processor', type: 'text'},
  ];
}

export function defaultProcessingFields(program) {
  const fields = baseFields();
  if (program === 'broiler') {
    // Customer is a Broiler-only Processing-owned field (server-enforced).
    fields.splice(fields.length - 1, 0, {
      id: 'customer',
      name: 'Customer (Broiler)',
      type: 'multi',
      options: CUSTOMER_OPTIONS_DEFAULT,
    });
  }
  return fields.map((f) => ({
    ...f,
    options: f.options ? f.options.map((o) => ({...o, color: {...o.color}})) : undefined,
  }));
}

// ── Default per-program checklists (handoff prototype DSUB) ──────────────────
// Assignees are display names (the prototype's five people); the Templates
// manager lets an admin re-point steps at real profiles (assignee_profile_id),
// and the Asana template import replaces these with the live checklist.
const DSUB = Object.freeze({
  broiler: [
    ['Send Weight & Animal Count', 'Ronnie Jones'],
    ['Prepare Cut List', 'Brian Naide'],
    ['Add to Processing Spreadsheet by Protein', 'Brett Post'],
    ['Create Invoice from Farm to Customer', 'Brett Post'],
    ['Inventory in Product and add to Asana', 'Brian Naide'],
    ['If Applicable - Send photo of new product label', 'Brian Naide'],
    ['Add Inventory to Shopify', 'Isabel Hermann'],
    ['Reconcile and Analyze Podio', 'Ronnie Jones'],
  ],
  cattle: [
    ['Send Weight & Animal Count', 'Ronnie Jones'],
    ['Prepare Cut List', 'Ronnie Jones'],
    ['Create and Post Inventory Intake Sheet', 'Brett Post'],
    ['Determine Wholesale Price / Animal', 'Brett Post'],
    ['Add to Processing Spreadsheet by Protein', 'Brett Post'],
    ['Create Invoice from Farm to Customer', 'Brett Post'],
    ['Obtain Product List from Processor & Send to Debbie', 'Isabel Hermann'],
    ['Inventory in Product & Send to Debbie', 'Isabel Hermann'],
    ['If Applicable - Send photo of new product label to Debbie', 'Isabel Hermann'],
    ['Add Inventory to Shopify', 'Jessica Torres'],
    ['Reconcile and Analyze Podio', 'Ronnie Jones'],
    ['Prepare Cutlist for Processor', 'Ronnie Jones'],
    ['Approve Cutlist', 'Isabel Hermann'],
    ['Inventory in Product through Asana Inventory Form', 'Jessica Torres'],
    ['Schedule/Notify payment of Kill & Processing', 'Ronnie Jones'],
    ['Update Status to Inventoried', 'Jessica Torres'],
  ],
  pig: [
    ['Send Weight & Animal Count', 'Ronnie Jones'],
    ['Prepare Cut List', 'Ronnie Jones'],
    ['Add to Processing Spreadsheet by Protein', 'Brett Post'],
    ['Create Invoice from Farm to Customer', 'Brett Post'],
    ['Inventory in Product and add to Asana', 'Isabel Hermann'],
    ['If Applicable - Send photo of new product label', 'Isabel Hermann'],
    ['Add Inventory to Shopify', 'Jessica Torres'],
    ['Reconcile and Analyze Podio', 'Ronnie Jones'],
    ['Inventory in Product through Asana Inventory Form', 'Jessica Torres'],
    ['If Applicable - Send photo of new product label to Debbie', 'Isabel Hermann'],
    ['Update Status to Inventoried', 'Jessica Torres'],
  ],
  sheep: [
    ['Send Weight & Animal Count', 'Ronnie Jones'],
    ['Prepare Cut List', 'Ronnie Jones'],
    ['Add to Processing Spreadsheet by Protein', 'Brett Post'],
    ['Create Invoice from Farm to Customer', 'Brett Post'],
    ['Inventory in Product and add to Asana', 'Isabel Hermann'],
    ['If Applicable - Send photo of new product label', 'Isabel Hermann'],
    ['Add Inventory to Shopify', 'Jessica Torres'],
    ['Reconcile and Analyze Podio', 'Ronnie Jones'],
    ['Update Final Animal Count & Weight', 'Ronnie Jones'],
    ['Schedule/Notify payment of Kill & Processing with Jennifer', 'Ronnie Jones'],
    ['Obtain Product List from Processor & Save to Egnyte', 'Isabel Hermann'],
    ['Inventory in Product through Asana Inventory Form', 'Jessica Torres'],
    ['If Applicable - Send photo of new product label to Debbie', 'Isabel Hermann'],
    ['Approve Cutlist', 'Isabel Hermann'],
    ['Prepare Cutlist for Processor', 'Ronnie Jones'],
    ['Update Status to Inventoried', 'Jessica Torres'],
  ],
});

export function defaultProcessingChecklist(program) {
  const steps = DSUB[program] || [];
  return steps.map(([label, assignee]) => ({label, assignee, assignee_profile_id: null}));
}

// ── Ownership matrix (bindings) ──────────────────────────────────────────────
// A field id in RESERVED_PROCESSING_FIELD_IDS is BOUND: its value comes from the
// record / a derived calc / a dedicated RPC — never from fields[fid]. The mig-164
// set_processing_field RPC refuses these ids server-side (keep in lockstep).
export const RESERVED_PROCESSING_FIELD_IDS = Object.freeze([
  'procActual', // planner/imported processing date (record.processing_date / snapshot)
  'procPlanned', // planner/imported planned date (snapshot.planned_proc)
  'status', // display status (deriveDisplayStatus) — Planned / In Process / Complete
  'program', // record.program
  'batchName', // record.title
  'animals', // record.number_processed (source-owned)
  'year', // derived from the processing date (never the Asana Year field)
  'actualTOF', // derived formula
  'plannedTOF', // derived formula
  'timeRemaining', // derived formula
  'customer', // dedicated set_processing_customer RPC (broiler only)
  'processor', // dedicated set_processing_processor RPC
]);

export function isReservedProcessingFieldId(id) {
  return RESERVED_PROCESSING_FIELD_IDS.includes(id);
}

// ── Small date helpers (pure) ────────────────────────────────────────────────
function isoDateOnly(v) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v == null ? '' : v).trim());
  return m ? m[1] : null;
}
function wholeDaysBetween(laterISO, earlierISO) {
  const a = isoDateOnly(laterISO);
  const b = isoDateOnly(earlierISO);
  if (!a || !b) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((ta - tb) / 86400000);
}

function snapshotVal(record, keys) {
  const snap = record && record.historical_snapshot;
  if (!snap || typeof snap !== 'object') return null;
  for (const k of keys) {
    const v = snap[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}
function localFieldVal(record, fid) {
  const f = record && record.fields;
  if (!f || typeof f !== 'object') return null;
  const v = f[fid];
  return v === undefined || v === '' ? null : v;
}

// Farm arrival precedence: local edit > imported snapshot > server-derived
// broiler hatch date (mig 164 adds farm_arrival for broiler planner rows).
export function resolveFarmArrival(record) {
  return (
    isoDateOnly(localFieldVal(record, 'farmArrival')) ||
    isoDateOnly(snapshotVal(record, ['farm_arrival', 'farmArrival'])) ||
    isoDateOnly(record && record.farm_arrival) ||
    null
  );
}

// ── The three handoff formula fields ─────────────────────────────────────────
// Actual Time On Farm (days): server-derived broiler TOF when present, else
// actual processing date − farm arrival.
export function deriveActualTofDays(record) {
  if (!record) return null;
  if (record.time_on_farm_days != null && Number.isFinite(Number(record.time_on_farm_days))) {
    return Number(record.time_on_farm_days);
  }
  const actual =
    isoDateOnly(localFieldVal(record, 'procActual')) ||
    isoDateOnly(snapshotVal(record, ['actual_proc'])) ||
    isoDateOnly(record.processing_date);
  const arrival = resolveFarmArrival(record);
  const d = wholeDaysBetween(actual, arrival);
  return d != null && d >= 0 ? d : null;
}

// Planned Time on Farm (days): planned processing date − farm arrival.
export function derivePlannedTofDays(record) {
  if (!record) return null;
  const planned =
    isoDateOnly(localFieldVal(record, 'procPlanned')) ||
    isoDateOnly(snapshotVal(record, ['planned_proc'])) ||
    isoDateOnly(record.processing_date);
  const arrival = resolveFarmArrival(record);
  const d = wholeDaysBetween(planned, arrival);
  return d != null && d >= 0 ? d : null;
}

// Time Remaining Until Processing (days, signed): processing date − today.
// Callers pass todayISO (no Date.now() here). Complete records return null.
export const PROCESSING_DUE_SOON_DAYS = 14;
export function deriveTimeRemaining(record, todayISO) {
  if (!record || !todayISO) return null;
  if (record.completed_at || String(record.status || '').toLowerCase() === 'complete') return null;
  const target = isoDateOnly(record.processing_date);
  if (!target) return null;
  const days = wholeDaysBetween(target, todayISO);
  if (days == null) return null;
  return {days, past: days < 0, dueSoon: days >= 0 && days <= PROCESSING_DUE_SOON_DAYS};
}

export function formatDaysAsWeeks(days) {
  if (days == null || !Number.isFinite(days) || days < 0) return null;
  const weeks = Math.floor(days / 7);
  const rem = days % 7;
  return `${weeks}w ${rem}d`;
}

export function formatTimeRemaining(remaining) {
  if (!remaining) return null;
  const abs = Math.abs(remaining.days);
  const base = abs >= 14 ? `${Math.floor(abs / 7)}w ${abs % 7}d` : `${abs}d`;
  return remaining.past ? `${base} ago` : base;
}

// ── Field display resolution (one precedence chain) ─────────────────────────
// Returns {value, readOnly, source} for one template field on one record.
//   source: 'local' | 'imported' | 'record' | 'derived' | 'none'
// Bound fields are always readOnly here (their edits go through dedicated RPCs
// or are Planner-owned facts). Local fields are editable for batch records
// (milestones don't take templates) by operational roles.
export function resolveFieldDisplay(field, record, {todayISO = null} = {}) {
  const fid = field && field.id;
  if (!fid || !record) return {value: null, readOnly: true, source: 'none'};

  switch (fid) {
    case 'procActual': {
      const local = isoDateOnly(snapshotVal(record, ['actual_proc']));
      return {value: local || isoDateOnly(record.processing_date), readOnly: true, source: 'record'};
    }
    case 'procPlanned':
      return {value: isoDateOnly(snapshotVal(record, ['planned_proc'])), readOnly: true, source: 'imported'};
    case 'status':
      return {value: record.status ?? null, readOnly: true, source: 'record'};
    case 'program':
      return {value: record.program ?? null, readOnly: true, source: 'record'};
    case 'batchName':
      return {
        value: snapshotVal(record, ['batch_name']) || record.title || null,
        readOnly: true,
        source: 'record',
      };
    case 'animals':
      return {value: record.number_processed ?? null, readOnly: true, source: 'record'};
    case 'year': {
      const d = isoDateOnly(record.processing_date);
      return {
        value: d ? d.slice(0, 4) : snapshotVal(record, ['year']) != null ? String(snapshotVal(record, ['year'])) : null,
        readOnly: true,
        source: d ? 'derived' : 'imported',
      };
    }
    case 'customer':
      return {value: Array.isArray(record.customer) ? record.customer : [], readOnly: true, source: 'record'};
    case 'processor':
      return {value: record.processor ?? null, readOnly: true, source: 'record'};
    case 'actualTOF':
      return {value: formatDaysAsWeeks(deriveActualTofDays(record)), readOnly: true, source: 'derived'};
    case 'plannedTOF':
      return {value: formatDaysAsWeeks(derivePlannedTofDays(record)), readOnly: true, source: 'derived'};
    case 'timeRemaining':
      return {value: formatTimeRemaining(deriveTimeRemaining(record, todayISO)), readOnly: true, source: 'derived'};
    case 'farmArrival': {
      const local = localFieldVal(record, 'farmArrival');
      if (local != null) return {value: isoDateOnly(local), readOnly: false, source: 'local'};
      const snap = isoDateOnly(snapshotVal(record, ['farm_arrival', 'farmArrival']));
      if (snap) return {value: snap, readOnly: false, source: 'imported'};
      const derived = isoDateOnly(record.farm_arrival);
      return {value: derived, readOnly: false, source: derived ? 'derived' : 'none'};
    }
    default: {
      const local = localFieldVal(record, fid);
      if (local != null) return {value: local, readOnly: false, source: 'local'};
      // Imported values land in historical_snapshot under snake_case-ish keys;
      // accept both the field id and a snake_cased variant.
      const snake = String(fid)
        .replace(/([A-Z])/g, '_$1')
        .toLowerCase();
      const snap = snapshotVal(record, [fid, snake]);
      if (snap != null) return {value: snap, readOnly: false, source: 'imported'};
      return {value: null, readOnly: false, source: 'none'};
    }
  }
}

// Editable check for a field on a record (milestones never take template
// fields; formula/bound fields are read-only; everything else is local).
export function isFieldEditable(field, record) {
  if (!field || !record) return false;
  if (record.record_type === 'milestone') return false;
  if (field.type === 'formula') return false;
  if (isReservedProcessingFieldId(field.id)) return false;
  return true;
}
