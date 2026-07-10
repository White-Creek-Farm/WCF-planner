// ============================================================================
// tests/processing_asana_templates.test.js — unit tests for the PURE Asana
// task-template → processing_templates mapping (sub-lane 5). Runs under Node
// (vitest); imports the same shared module the Deno edge fn imports, so passing
// here locks the importer's mapping/idempotency contract without a deploy.
// ============================================================================

import {describe, it, expect} from 'vitest';
import {
  inferProgramFromTemplateName,
  mapAsanaTemplateToProcessing,
  templateContentKey,
  buildTemplateImportPlan,
} from '../supabase/functions/_shared/processingAsanaShape.js';

// A realistic single-template GET response (opt_fields=name,template.name,
// template.subtasks.name,template.custom_fields.*), shaped like the Asana API.
function templateFixture(overrides = {}) {
  return {
    gid: '1209999000000001',
    resource_type: 'task_template',
    name: 'Broiler processing checklist',
    created_at: '2026-01-02T10:00:00.000Z',
    template: {
      name: 'WCF Broiler batch',
      task_resource_subtype: 'default_task',
      description: 'Standard broiler processing steps',
      relative_start_on: -2,
      relative_due_on: 5,
      subtasks: [
        {name: 'Confirm headcount', task_resource_subtype: 'default_task'},
        {name: 'Book processor slot', task_resource_subtype: 'default_task'},
        {name: '', task_resource_subtype: 'default_task'}, // blank → dropped
      ],
      custom_fields: [
        {gid: 'cf1', name: 'Customer (Broiler)', type: 'enum', display_value: "Sonny's"},
        {
          gid: 'cf2',
          name: 'Processor',
          type: 'text',
          display_value: 'Atlanta Poultry Processing',
          text_value: 'Atlanta Poultry Processing',
        },
        {gid: 'cf3', name: 'Animals Processed', type: 'number', number_value: 700},
        {
          gid: 'cf4',
          name: 'Grade',
          type: 'enum',
          display_value: 'A',
          enum_options: [{name: 'A'}, {name: 'B'}],
        },
        {gid: 'cf5', name: '', type: 'text'}, // no name → dropped
      ],
    },
    ...overrides,
  };
}

describe('inferProgramFromTemplateName', () => {
  it('maps program keywords + synonyms (word-boundary)', () => {
    expect(inferProgramFromTemplateName('Broiler processing checklist')).toBe('broiler');
    expect(inferProgramFromTemplateName('Chicken slaughter steps')).toBe('broiler');
    expect(inferProgramFromTemplateName('Cattle / Beef harvest')).toBe('cattle');
    expect(inferProgramFromTemplateName('Lamb processing')).toBe('sheep');
    expect(inferProgramFromTemplateName('Sheep template')).toBe('sheep');
    expect(inferProgramFromTemplateName('Pig (hog) template')).toBe('pig');
    expect(inferProgramFromTemplateName('Pork cut sheet')).toBe('pig');
  });
  it('returns null for no keyword or ambiguous (multiple programs)', () => {
    expect(inferProgramFromTemplateName('General processing template')).toBeNull();
    expect(inferProgramFromTemplateName('')).toBeNull();
    expect(inferProgramFromTemplateName(null)).toBeNull();
    expect(inferProgramFromTemplateName('Broiler and Cattle combined')).toBeNull(); // ambiguous
    expect(inferProgramFromTemplateName('pigment analysis')).toBeNull(); // no word-boundary hit
  });
});

describe('mapAsanaTemplateToProcessing', () => {
  it('maps subtasks→checklist (assignee null) and custom fields→fields', () => {
    const m = mapAsanaTemplateToProcessing(templateFixture());
    expect(m.program).toBe('broiler');
    expect(m.asana_template_gid).toBe('1209999000000001');
    // blank subtask dropped; assignee is never readable from the recipe
    expect(m.checklist).toEqual([
      {label: 'Confirm headcount', assignee: null},
      {label: 'Book processor slot', assignee: null},
    ]);
    // fields: name + mapped type + gid + default; enum options carried as
    // normalized {key,label,color} objects (colorless → default grey pair) so a
    // re-import compares equal to what the editor stores.
    expect(m.fields).toEqual([
      {name: 'Customer (Broiler)', type: 'single', asana_gid: 'cf1', default: "Sonny's"},
      {name: 'Processor', type: 'text', asana_gid: 'cf2', default: 'Atlanta Poultry Processing'},
      {name: 'Animals Processed', type: 'number', asana_gid: 'cf3', default: 700},
      {
        name: 'Grade',
        type: 'single',
        asana_gid: 'cf4',
        default: 'A',
        options: [
          {key: 'a', label: 'A', color: {bg: '#C8CDD3', ink: '#3F4650'}},
          {key: 'b', label: 'B', color: {bg: '#C8CDD3', ink: '#3F4650'}},
        ],
      },
    ]);
    expect(m.warnings).toContain('subtask_assignees_not_readable');
    expect(m.meta.relative_due_on).toBe(5);
  });

  it('flags an un-inferable program instead of guessing', () => {
    const m = mapAsanaTemplateToProcessing(templateFixture({name: 'General template', template: {subtasks: []}}));
    expect(m.program).toBeNull();
    expect(m.warnings).toContain('no_program_inferred');
  });

  it('honors an explicit program override', () => {
    const m = mapAsanaTemplateToProcessing(templateFixture({name: 'Generic'}), {program: 'cattle'});
    expect(m.program).toBe('cattle');
  });
});

describe('templateContentKey (idempotency + meaningful-change detection)', () => {
  it('ignores UNKNOWN extra keys but keeps object-key order irrelevant', () => {
    const a = {
      fields: [{type: 'text', name: 'X', asana_gid: 'zz', extra: true}],
      checklist: [{label: 'S', assignee: null}],
    };
    const b = {fields: [{name: 'X', type: 'text'}], checklist: [{label: 'S', assignee: null}]};
    expect(templateContentKey(a)).toBe(templateContentKey(b));
  });
  it('checklist ASSIGNEES are excluded (Asana cannot express them; planner-side enrichment)', () => {
    const a = {fields: [], checklist: [{label: 'S', assignee: 'Ronnie Jones', assignee_profile_id: 'uuid-1'}]};
    const b = {fields: [], checklist: [{label: 'S', assignee: null}]};
    expect(templateContentKey(a)).toBe(templateContentKey(b));
  });
  it('differs when a step or field changes', () => {
    const a = {fields: [{name: 'X', type: 'text'}], checklist: [{label: 'S', assignee: null}]};
    const b = {fields: [{name: 'X', type: 'number'}], checklist: [{label: 'S', assignee: null}]};
    const c = {fields: [{name: 'X', type: 'text'}], checklist: [{label: 'S2', assignee: null}]};
    expect(templateContentKey(a)).not.toBe(templateContentKey(b));
    expect(templateContentKey(a)).not.toBe(templateContentKey(c));
  });
  it('differs on option add/remove, option COLOR change, default change, and ORDER change', () => {
    const base = {
      fields: [
        {name: 'Grade', type: 'single', options: [{key: 'a', label: 'A', color: {bg: '#93C896', ink: '#285F33'}}]},
        {name: 'Notes', type: 'text'},
      ],
      checklist: [{label: 'S1'}, {label: 'S2'}],
    };
    const addedOption = {
      ...base,
      fields: [
        {
          name: 'Grade',
          type: 'single',
          options: [
            {key: 'a', label: 'A', color: {bg: '#93C896', ink: '#285F33'}},
            {key: 'b', label: 'B', color: {bg: '#C8CDD3', ink: '#3F4650'}},
          ],
        },
        base.fields[1],
      ],
    };
    const recolored = {
      ...base,
      fields: [
        {name: 'Grade', type: 'single', options: [{key: 'a', label: 'A', color: {bg: '#E07A6E', ink: '#6E1C15'}}]},
        base.fields[1],
      ],
    };
    const defaulted = {...base, fields: [{...base.fields[0], default: 'A'}, base.fields[1]]};
    const fieldOrder = {...base, fields: [base.fields[1], base.fields[0]]};
    const stepOrder = {...base, checklist: [{label: 'S2'}, {label: 'S1'}]};
    for (const changed of [addedOption, recolored, defaulted, fieldOrder, stepOrder]) {
      expect(templateContentKey(changed)).not.toBe(templateContentKey(base));
    }
  });
});

describe('buildTemplateImportPlan', () => {
  it('classifies ready / unchanged / conflict / no_program', () => {
    const broiler = templateFixture(); // → broiler, ready unless active matches
    const cattle = templateFixture({gid: 'c1', name: 'Cattle template'});
    const cattleDup = templateFixture({gid: 'c2', name: 'Cattle harvest'}); // 2nd cattle → conflict
    const generic = templateFixture({gid: 'g1', name: 'General template'}); // no_program

    // active broiler equals the mapped broiler → unchanged
    const mappedBroiler = mapAsanaTemplateToProcessing(broiler);
    const activeByProgram = {broiler: {fields: mappedBroiler.fields, checklist: mappedBroiler.checklist}};

    const plan = buildTemplateImportPlan([broiler, cattle, cattleDup, generic], activeByProgram);
    const byGid = Object.fromEntries(plan.items.map((i) => [i.asana_template_gid, i]));
    expect(byGid['1209999000000001'].status).toBe('unchanged');
    expect(byGid['c1'].status).toBe('conflict');
    expect(byGid['c2'].status).toBe('conflict');
    expect(byGid['g1'].status).toBe('no_program');
    expect(plan.summary.total).toBe(4);
    expect(plan.summary.conflict).toBe(2);
    expect(plan.summary.no_program).toBe(1);
    expect(plan.summary.unchanged).toBe(1);
  });

  it('marks a single changed template ready', () => {
    const plan = buildTemplateImportPlan([templateFixture()], {}); // no active → ready
    expect(plan.items[0].status).toBe('ready');
    expect(plan.summary.ready).toBe(1);
  });
});
