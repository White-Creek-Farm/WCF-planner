// Unit tests for the Processing custom-field engine: stable default ids (v2
// simplified suite), the ownership matrix (reserved/bound ids), and value-
// precedence resolution.
import {describe, expect, it} from 'vitest';
import {
  PROCESSING_FIELD_PALETTE,
  PROCESSING_FIELD_TYPES,
  DEFAULT_OPTION_COLOR,
  normalizeFieldOption,
  normalizeFieldDef,
  optionKeyFromLabel,
  defaultProcessingFields,
  defaultProcessingChecklist,
  defaultProcessingTemplateSuite,
  validateTemplateDraft,
  validateChecklistDraft,
  activeOptionLabels,
  optionLabelState,
  RESERVED_PROCESSING_FIELD_IDS,
  isReservedProcessingFieldId,
  resolveFarmArrival,
  resolveFieldDisplay,
  isFieldEditable,
} from './processingFields.js';

describe('defaults (v2 simplified suite, stable ids)', () => {
  it('every program carries the kept stable ids, in order, with processor last', () => {
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const ids = defaultProcessingFields(program).map((f) => f.id);
      expect(ids[0]).toBe('procActual');
      expect(ids[ids.length - 1]).toBe('processor');
      for (const kept of ['status', 'program', 'batchName', 'animals', 'condemned', 'farmArrival', 'year']) {
        expect(ids, `${program} keeps ${kept}`).toContain(kept);
      }
    }
  });
  it('the six retired display fields are gone from every program default', () => {
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const ids = defaultProcessingFields(program).map((f) => f.id);
      for (const gone of ['farm', 'procPlanned', 'actualTOF', 'plannedTOF', 'timeRemaining', 'productPickup']) {
        expect(ids, `${program} drops ${gone}`).not.toContain(gone);
      }
    }
  });
  it('field counts: broiler 11, cattle/pig/sheep 10', () => {
    expect(defaultProcessingFields('broiler')).toHaveLength(11);
    for (const program of ['cattle', 'pig', 'sheep']) {
      expect(defaultProcessingFields(program)).toHaveLength(10);
    }
  });
  it('Customer is a broiler-only SINGLE select sourced from settings.customer_options', () => {
    const customer = defaultProcessingFields('broiler').find((f) => f.id === 'customer');
    expect(customer).toBeTruthy();
    expect(customer.type).toBe('single');
    expect(customer.optionsSource).toBe('settings.customer_options');
    expect(customer.options).toBeUndefined();
    expect(defaultProcessingFields('cattle').some((f) => f.id === 'customer')).toBe(false);
  });
  it('keeps the Asana Condemed spelling', () => {
    const f = defaultProcessingFields('pig').find((x) => x.id === 'condemned');
    expect(f.name).toBe('Condemed');
  });
  it('default checklists exist per program with assignees', () => {
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const steps = defaultProcessingChecklist(program);
      expect(steps.length).toBeGreaterThan(5);
      expect(steps[0]).toEqual({
        label: 'Send Weight & Animal Count',
        assignee: 'Ronnie Jones',
        assignee_profile_id: null,
      });
    }
  });
  it('palette has exactly 12 bg/ink pairs and grey is the default', () => {
    expect(PROCESSING_FIELD_PALETTE).toHaveLength(12);
    expect(DEFAULT_OPTION_COLOR).toEqual({bg: '#C8CDD3', ink: '#3F4650'});
  });
  it('checkbox + url are supported control types', () => {
    expect(PROCESSING_FIELD_TYPES).toEqual([
      'text',
      'number',
      'date',
      'single',
      'multi',
      'people',
      'checkbox',
      'url',
      'formula',
    ]);
  });
  it('Processor is a settings-sourced select (no baked options) in every program default', () => {
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const proc = defaultProcessingFields(program).find((f) => f.id === 'processor');
      expect(proc.type).toBe('single');
      expect(proc.optionsSource).toBe('settings.processor_options');
      expect(proc.options).toBeUndefined();
    }
  });
  it('defaultProcessingTemplateSuite covers all four programs with valid drafts', () => {
    const suite = defaultProcessingTemplateSuite();
    expect(Object.keys(suite).sort()).toEqual(['broiler', 'cattle', 'pig', 'sheep']);
    for (const program of Object.keys(suite)) {
      expect(validateTemplateDraft(suite[program].fields, suite[program].checklist).ok).toBe(true);
    }
    // broiler carries Customer; the mammal programs do not
    expect(suite.broiler.fields.some((f) => f.id === 'customer')).toBe(true);
    expect(suite.cattle.fields.some((f) => f.id === 'customer')).toBe(false);
  });
});

describe('validateTemplateDraft (publish validation)', () => {
  it('accepts a clean draft', () => {
    const verdict = validateTemplateDraft(
      [
        {id: 'a', name: 'A', type: 'text'},
        {id: 'b', name: 'B', type: 'single', options: [{key: 'x', label: 'X'}]},
        {id: 'proc', name: 'Processor', type: 'single', optionsSource: 'settings.processor_options'},
        {id: 'c', name: 'C', type: 'checkbox'},
        {id: 'd', name: 'D', type: 'url'},
      ],
      [{label: 'Step'}],
    );
    expect(verdict).toEqual({ok: true, problems: []});
  });
  it('rejects duplicate ids, blank names, unsupported types, optionless selects, duplicate options, blank steps', () => {
    const verdict = validateTemplateDraft(
      [
        {id: 'a', name: 'A', type: 'text'},
        {id: 'a', name: 'A2', type: 'text'}, // duplicate id
        {id: 'b', name: '  ', type: 'text'}, // blank name
        {id: 'c', name: 'C', type: 'select'}, // unsupported type
        {id: 'd', name: 'D', type: 'single', options: []}, // no options, no source
        {id: 'e', name: 'E', type: 'multi', options: ['X', 'X']}, // duplicate option
        {
          id: 'g',
          name: 'G',
          type: 'single',
          options: [
            {key: 'x', label: 'Same'},
            {key: 'y', label: 'same'},
          ],
        },
        {id: 'h', name: 'H', type: 'single', options: ['Valid', '  ']}, // blank option
        {name: 'F', type: 'text'}, // missing id
      ],
      [{label: ''}],
    );
    expect(verdict.ok).toBe(false);
    const text = verdict.problems.join(' | ');
    expect(text).toContain('duplicate id "a"');
    expect(text).toContain('name is required');
    expect(text).toContain('unsupported type "select"');
    expect(text).toContain('needs at least one option');
    expect(text).toContain('duplicate option "X"');
    expect(text).toContain('duplicate option "same"');
    expect(text).toContain('option #2 needs a label');
    expect(text).toContain('missing a stable id');
    expect(text).toContain('Checklist step #1: label is required');
  });
});

describe('validateChecklistDraft (checklist-only path — mig 177 stable step ids)', () => {
  it('accepts steps with and without ids (id-less steps are new; the server mints ids)', () => {
    expect(
      validateChecklistDraft([
        {id: 'stp-1', label: 'Existing step', assignee: null, assignee_profile_id: null},
        {label: 'Brand new step'},
        {id: null, label: 'Also new'},
      ]),
    ).toEqual({ok: true, problems: []});
  });
  it('rejects blank labels and duplicate step ids', () => {
    const verdict = validateChecklistDraft([
      {id: 'stp-1', label: 'A'},
      {id: 'stp-1', label: 'B'}, // duplicate stable id
      {label: '  '}, // blank label
    ]);
    expect(verdict.ok).toBe(false);
    const text = verdict.problems.join(' | ');
    expect(text).toContain('duplicate step id "stp-1"');
    expect(text).toContain('Checklist step #3: label is required');
  });
  it('validateTemplateDraft delegates its checklist path (no weakening)', () => {
    const verdict = validateTemplateDraft([], [{id: 'x', label: 'A'}, {id: 'x', label: 'B'}, {label: ''}]);
    expect(verdict.ok).toBe(false);
    const text = verdict.problems.join(' | ');
    expect(text).toContain('duplicate step id "x"');
    expect(text).toContain('label is required');
  });
  it('tolerates a non-array', () => {
    expect(validateChecklistDraft(null)).toEqual({ok: true, problems: []});
  });
});

describe('option-list helpers (mig 175: [{id,label,active}] Customer/Processor choices)', () => {
  const OPTS = [
    {id: 'opt-1', label: "Sonny's", active: true},
    {id: 'opt-2', label: 'Old Processor', active: false},
    {id: 'opt-3', label: '  Padded Label  ', active: true},
  ];

  it('activeOptionLabels returns ACTIVE labels only, trimmed, in list order', () => {
    expect(activeOptionLabels(OPTS)).toEqual(["Sonny's", 'Padded Label']);
  });
  it('activeOptionLabels accepts the legacy plain-string shape (all active)', () => {
    expect(activeOptionLabels(['A', ' B ', ''])).toEqual(['A', 'B']);
  });
  it('activeOptionLabels tolerates mixed/garbage input and non-arrays', () => {
    expect(activeOptionLabels(['A', {id: 'x', label: 'B', active: false}, {label: 'C'}, null, 42])).toEqual(['A', 'C']);
    expect(activeOptionLabels(null)).toEqual([]);
    expect(activeOptionLabels(undefined)).toEqual([]);
    expect(activeOptionLabels('nope')).toEqual([]);
  });
  it('activeOptionLabels: object entries without an explicit active flag count as active', () => {
    expect(activeOptionLabels([{id: 'x', label: 'Implicit'}])).toEqual(['Implicit']);
  });

  it('optionLabelState classifies current, deactivated, and off-list stored labels', () => {
    expect(optionLabelState(OPTS, "Sonny's")).toEqual({known: true, active: true});
    expect(optionLabelState(OPTS, 'Old Processor')).toEqual({known: true, active: false});
    expect(optionLabelState(OPTS, 'Never Configured')).toEqual({known: false, active: false});
  });
  it('optionLabelState matches trim + case-insensitively (mirrors the server label de-dupe)', () => {
    expect(optionLabelState(OPTS, "  sonny's ")).toEqual({known: true, active: true});
    expect(optionLabelState(OPTS, 'padded label')).toEqual({known: true, active: true});
  });
  it('optionLabelState treats blank/null stored values and legacy string lists sanely', () => {
    expect(optionLabelState(OPTS, '')).toEqual({known: false, active: false});
    expect(optionLabelState(OPTS, null)).toEqual({known: false, active: false});
    expect(optionLabelState(['Legacy A'], 'legacy a')).toEqual({known: true, active: true});
    expect(optionLabelState(null, 'anything')).toEqual({known: false, active: false});
  });
});

describe('option/def normalization', () => {
  it('normalizes a bare string option to {key,label,color}', () => {
    expect(normalizeFieldOption('Coastal Pastures - CONFIRMED')).toEqual({
      key: 'coastal_pastures_confirmed',
      label: 'Coastal Pastures - CONFIRMED',
      color: {...DEFAULT_OPTION_COLOR},
    });
  });
  it('keeps existing key/color and accepts prototype {bg,ink}', () => {
    expect(normalizeFieldOption({key: 'k1', label: 'A', bg: '#93C896', ink: '#285F33'})).toEqual({
      key: 'k1',
      label: 'A',
      color: {bg: '#93C896', ink: '#285F33'},
    });
  });
  it('normalizeFieldDef mints a deterministic id from the name when absent', () => {
    const f = normalizeFieldDef({name: 'Kill Sheet #', type: 'text'});
    expect(f.id).toBe('fld-' + optionKeyFromLabel('Kill Sheet #'));
    // deterministic: same name → same id on every load
    expect(normalizeFieldDef({name: 'Kill Sheet #', type: 'text'}).id).toBe(f.id);
  });
  it('normalizeFieldDef coerces unknown types to text and normalizes select options', () => {
    const f = normalizeFieldDef({id: 'x', name: 'X', type: 'wat', options: ['a']});
    expect(f.type).toBe('text');
    const s = normalizeFieldDef({id: 'y', name: 'Y', type: 'single', options: ['a', null, '']});
    expect(s.options).toEqual([{key: 'a', label: 'a', color: {...DEFAULT_OPTION_COLOR}}]);
  });
});

describe('ownership matrix (reserved ids)', () => {
  it('locks every planner-owned / derived / RPC-owned id, INCLUDING the retired display ids', () => {
    for (const id of [
      'procActual',
      'procPlanned',
      'status',
      'program',
      'batchName',
      'animals',
      'year',
      'actualTOF',
      'plannedTOF',
      'timeRemaining',
      'customer',
      'processor',
    ]) {
      expect(RESERVED_PROCESSING_FIELD_IDS).toContain(id);
      expect(isReservedProcessingFieldId(id)).toBe(true);
    }
    expect(isReservedProcessingFieldId('condemned')).toBe(false);
    expect(isReservedProcessingFieldId('farmArrival')).toBe(false);
  });
  it('isFieldEditable: milestones never, formula never, reserved never, local yes', () => {
    const batch = {record_type: 'planner_batch'};
    expect(isFieldEditable({id: 'condemned', type: 'number'}, batch)).toBe(true);
    expect(isFieldEditable({id: 'condemned', type: 'number'}, {record_type: 'milestone'})).toBe(false);
    expect(isFieldEditable({id: 'actualTOF', type: 'formula'}, batch)).toBe(false);
    expect(isFieldEditable({id: 'animals', type: 'number'}, batch)).toBe(false);
  });
});

describe('farm arrival precedence', () => {
  it('local field edits win over snapshot for farm arrival', () => {
    const rec = {
      fields: {farmArrival: '2026-05-10'},
      historical_snapshot: {farm_arrival: '2026-05-04'},
    };
    expect(resolveFarmArrival(rec)).toBe('2026-05-10');
  });
  it('snapshot wins over the server-derived column', () => {
    const rec = {historical_snapshot: {farm_arrival: '2026-05-04'}, farm_arrival: '2026-05-01'};
    expect(resolveFarmArrival(rec)).toBe('2026-05-04');
  });
});

describe('resolveFieldDisplay (one precedence chain)', () => {
  const record = {
    record_type: 'asana_historical',
    program: 'broiler',
    title: 'WCF-B-26-08: 700 @5LBS',
    processing_date: '2026-06-22',
    status: 'planned',
    number_processed: 700,
    customer: ["Sonny's"],
    processor: 'Atlanta Poultry Processing',
    fields: {condemned: 4},
    historical_snapshot: {
      batch_name: 'WCF-B-26-08',
      planned_proc: '2026-06-24',
      farm_arrival: '2026-05-04',
      condemned: 9,
      animal_master: 'On Farm',
    },
  };

  it('bound ids read from the record and stay read-only', () => {
    expect(resolveFieldDisplay({id: 'animals', type: 'number'}, record)).toEqual({
      value: 700,
      readOnly: true,
      source: 'record',
    });
    expect(resolveFieldDisplay({id: 'batchName', type: 'text'}, record).value).toBe('WCF-B-26-08');
    expect(resolveFieldDisplay({id: 'year', type: 'single'}, record).value).toBe('2026');
    expect(resolveFieldDisplay({id: 'procActual', type: 'date'}, record).value).toBe('2026-06-22');
  });
  it('local fields[fid] wins over the imported snapshot', () => {
    const r = resolveFieldDisplay({id: 'condemned', type: 'number'}, record);
    expect(r).toEqual({value: 4, readOnly: false, source: 'local'});
  });
  it('snapshot value surfaces when no local value exists (snake_case tolerated)', () => {
    const r = resolveFieldDisplay({id: 'animalMaster', type: 'single'}, record);
    expect(r).toEqual({value: 'On Farm', readOnly: false, source: 'imported'});
  });
  it('unknown local field with no value resolves to none/editable', () => {
    expect(resolveFieldDisplay({id: 'killSheet', type: 'text'}, record)).toEqual({
      value: null,
      readOnly: false,
      source: 'none',
    });
  });
});
