// Unit tests for the Processing custom-field engine: stable default ids, the
// ownership matrix (reserved/bound ids), value-precedence resolution, and the
// three derived handoff formulas.
import {describe, expect, it} from 'vitest';
import {
  PROCESSING_FIELD_PALETTE,
  DEFAULT_OPTION_COLOR,
  normalizeFieldOption,
  normalizeFieldDef,
  optionKeyFromLabel,
  defaultProcessingFields,
  defaultProcessingChecklist,
  RESERVED_PROCESSING_FIELD_IDS,
  isReservedProcessingFieldId,
  resolveFarmArrival,
  deriveActualTofDays,
  derivePlannedTofDays,
  deriveTimeRemaining,
  formatDaysAsWeeks,
  formatTimeRemaining,
  resolveFieldDisplay,
  isFieldEditable,
} from './processingFields.js';

describe('defaults (handoff §6, stable ids)', () => {
  it('every program carries the stable handoff field ids in order', () => {
    for (const program of ['broiler', 'cattle', 'pig', 'sheep']) {
      const ids = defaultProcessingFields(program).map((f) => f.id);
      expect(ids).toContain('procActual');
      expect(ids).toContain('status');
      expect(ids).toContain('condemned');
      expect(ids).toContain('farmArrival');
      expect(ids).toContain('actualTOF');
      expect(ids).toContain('plannedTOF');
      expect(ids).toContain('timeRemaining');
      expect(ids).toContain('processor');
      // ordered: actual date first, processor last-ish
      expect(ids[0]).toBe('procActual');
    }
  });
  it('Customer is a broiler-only default field', () => {
    expect(defaultProcessingFields('broiler').some((f) => f.id === 'customer')).toBe(true);
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
  it('locks every planner-owned / derived / RPC-owned id', () => {
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

describe('derived formulas', () => {
  it('actual TOF prefers the server-derived broiler value', () => {
    expect(deriveActualTofDays({time_on_farm_days: 49})).toBe(49);
  });
  it('actual TOF falls back to processing date − farm arrival', () => {
    const rec = {processing_date: '2026-06-22', historical_snapshot: {farm_arrival: '2026-05-04'}};
    expect(deriveActualTofDays(rec)).toBe(49);
    expect(formatDaysAsWeeks(49)).toBe('7w 0d');
  });
  it('planned TOF uses the planned date from the snapshot', () => {
    const rec = {historical_snapshot: {planned_proc: '2026-06-24', farm_arrival: '2026-05-04'}};
    expect(derivePlannedTofDays(rec)).toBe(51);
  });
  it('local field edits win over snapshot for farm arrival', () => {
    const rec = {
      fields: {farmArrival: '2026-05-10'},
      historical_snapshot: {farm_arrival: '2026-05-04'},
    };
    expect(resolveFarmArrival(rec)).toBe('2026-05-10');
  });
  it('time remaining: due-soon within 14 days, past negative, complete null', () => {
    const today = '2026-07-10';
    expect(deriveTimeRemaining({processing_date: '2026-07-13'}, today)).toEqual({days: 3, past: false, dueSoon: true});
    expect(deriveTimeRemaining({processing_date: '2026-07-24'}, today)).toEqual({days: 14, past: false, dueSoon: true});
    expect(deriveTimeRemaining({processing_date: '2026-07-25'}, today)).toEqual({
      days: 15,
      past: false,
      dueSoon: false,
    });
    expect(deriveTimeRemaining({processing_date: '2026-07-01'}, today)).toEqual({days: -9, past: true, dueSoon: false});
    expect(deriveTimeRemaining({processing_date: '2026-07-13', completed_at: 'x'}, today)).toBeNull();
    expect(deriveTimeRemaining({processing_date: '2026-07-13', status: 'complete'}, today)).toBeNull();
    expect(deriveTimeRemaining({}, today)).toBeNull();
  });
  it('formats time remaining as days, weeks past 14d, and "ago" for overdue', () => {
    expect(formatTimeRemaining({days: 3, past: false, dueSoon: true})).toBe('3d');
    expect(formatTimeRemaining({days: 15, past: false, dueSoon: false})).toBe('2w 1d');
    expect(formatTimeRemaining({days: -9, past: true, dueSoon: false})).toBe('9d ago');
    expect(formatTimeRemaining(null)).toBeNull();
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
  const today = '2026-07-10';

  it('bound ids read from the record and stay read-only', () => {
    expect(resolveFieldDisplay({id: 'animals', type: 'number'}, record, {todayISO: today})).toEqual({
      value: 700,
      readOnly: true,
      source: 'record',
    });
    expect(resolveFieldDisplay({id: 'batchName', type: 'text'}, record, {todayISO: today}).value).toBe('WCF-B-26-08');
    expect(resolveFieldDisplay({id: 'procPlanned', type: 'date'}, record, {todayISO: today}).value).toBe('2026-06-24');
    expect(resolveFieldDisplay({id: 'year', type: 'single'}, record, {todayISO: today}).value).toBe('2026');
  });
  it('local fields[fid] wins over the imported snapshot', () => {
    const r = resolveFieldDisplay({id: 'condemned', type: 'number'}, record, {todayISO: today});
    expect(r).toEqual({value: 4, readOnly: false, source: 'local'});
  });
  it('snapshot value surfaces when no local value exists (snake_case tolerated)', () => {
    const r = resolveFieldDisplay({id: 'animalMaster', type: 'single'}, record, {todayISO: today});
    expect(r).toEqual({value: 'On Farm', readOnly: false, source: 'imported'});
  });
  it('derived formulas resolve read-only', () => {
    expect(resolveFieldDisplay({id: 'actualTOF', type: 'formula'}, record, {todayISO: today}).value).toBe('7w 0d');
    expect(resolveFieldDisplay({id: 'timeRemaining', type: 'formula'}, record, {todayISO: today}).readOnly).toBe(true);
  });
  it('unknown local field with no value resolves to none/editable', () => {
    expect(resolveFieldDisplay({id: 'killSheet', type: 'text'}, record, {todayISO: today})).toEqual({
      value: null,
      readOnly: false,
      source: 'none',
    });
  });
});
