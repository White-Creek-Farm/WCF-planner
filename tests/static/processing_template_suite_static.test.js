import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {
  defaultProcessingTemplateSuite,
  PROCESSING_FIELD_TYPES,
  validateTemplateDraft,
} from '../../src/lib/processingFields.js';

// Static guards for the template suite (mig 172 v1 seed + mig 174 v2 upgrade
// + controls):
//   • mig 174's v2 JSON is BYTE-EQUAL to the canonical JS suite
//     (defaultProcessingTemplateSuite) for all four programs — the migration
//     and the client Reset-to-default can never drift;
//   • mig 174's expected-v1 JSON is BYTE-EQUAL to what mig 172 actually seeded
//     — the fail-closed comparison can never drift either;
//   • 174 fails closed on customized fields, is idempotent, preserves the
//     active checklist, and never deletes template rows or touches records;
//   • 172 stays insert-if-absent only; set_processing_field checkbox/url kept;
//   • Customer + Processor are TRUE SELECTS everywhere (no free-text path);
//   • the Templates manager (checklist-only since the planner-integration
//     lane) validates via validateChecklistDraft before activation, shows
//     Active/Draft state, and previews the draft checklist;
//   • the retired template-field Details surface may not return to the drawer
//     (source facts render once, in the fixed core rows + Source details).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/172_processing_template_suite.sql');
const mig174 = read('supabase-migrations/174_processing_template_suite_v2.sql');
const mig177 = read('supabase-migrations/177_processing_workflow_integration.sql');
const drawer = read('src/processing/ProcessingDrawer.jsx');
const milestoneModal = read('src/processing/AddMilestoneModal.jsx');
const templatesModal = read('src/processing/ProcessingTemplatesModal.jsx');
const fieldsLib = read('src/lib/processingFields.js');

const PROGRAMS = ['broiler', 'cattle', 'pig', 'sheep'];

// Extract the two '...'::jsonb literals of one program's 172 INSERT block.
function seedJson(program) {
  const start = mig.indexOf(`SELECT 'ptpl-default-${program}'`);
  expect(start, `${program} seed present`).toBeGreaterThan(-1);
  const block = mig.slice(start, mig.indexOf('WHERE NOT EXISTS', start));
  const literals = [...block.matchAll(/'((?:[^']|'')*)'::jsonb/g)].map((m) => m[1].replace(/''/g, "'"));
  expect(literals.length, `${program} carries fields + checklist literals`).toBe(2);
  return {fields: JSON.parse(literals[0]), checklist: JSON.parse(literals[1])};
}

// Extract one CASE assignment block ('v_v1' | 'v_v2' | 'v_checklist') of mig
// 174 as {program: parsedJson}.
function mig174Case(varName) {
  const start = mig174.indexOf(`${varName} :=`);
  expect(start, `174 assigns ${varName}`).toBeGreaterThan(-1);
  const block = mig174.slice(start, mig174.indexOf('END;', start));
  const out = {};
  for (const m of block.matchAll(/WHEN '(\w+)' THEN '((?:[^']|'')*)'::jsonb/g)) {
    out[m[1]] = JSON.parse(m[2].replace(/''/g, "'"));
  }
  expect(Object.keys(out).sort(), `${varName} covers all programs`).toEqual([...PROGRAMS].sort());
  return out;
}

describe('mig 174 — v2 JSON is in lockstep with the canonical JS suite AND the 172 seed', () => {
  const suite = defaultProcessingTemplateSuite();
  const v1 = mig174Case('v_v1');
  const v2 = mig174Case('v_v2');
  const checklist = mig174Case('v_checklist');

  for (const program of PROGRAMS) {
    it(`${program}: 174 v2 === defaultProcessingTemplateSuite(); 174 expected-v1 === 172 seed`, () => {
      expect(v2[program]).toEqual(JSON.parse(JSON.stringify(suite[program].fields)));
      expect(checklist[program]).toEqual(JSON.parse(JSON.stringify(suite[program].checklist)));
      const seeded = seedJson(program);
      expect(v1[program]).toEqual(seeded.fields);
      expect(checklist[program]).toEqual(seeded.checklist);
    });
  }

  it('field counts after cleanup: broiler 11; cattle/pig/sheep 10; retired ids gone', () => {
    const retired = ['farm', 'procPlanned', 'actualTOF', 'plannedTOF', 'timeRemaining', 'productPickup'];
    for (const program of PROGRAMS) {
      const ids = v2[program].map((f) => f.id);
      expect(ids.length).toBe(program === 'broiler' ? 11 : 10);
      for (const gone of retired) expect(ids, `${program} drops ${gone}`).not.toContain(gone);
      expect(ids, `${program} keeps farmArrival`).toContain('farmArrival');
      expect(ids, `${program} keeps procActual`).toContain('procActual');
    }
    expect(mig174).toContain("CASE v_program WHEN 'broiler' THEN 11 ELSE 10 END");
  });

  it('Customer v2 is a broiler-only SINGLE select sourced from customer_options', () => {
    const customer = v2.broiler.find((f) => f.id === 'customer');
    expect(customer).toEqual({
      id: 'customer',
      name: 'Customer (Broiler)',
      type: 'single',
      optionsSource: 'settings.customer_options',
    });
    for (const program of ['cattle', 'pig', 'sheep']) {
      expect(v2[program].some((f) => f.id === 'customer')).toBe(false);
    }
    // …and the v1 it replaces was the multi (drift canary for the upgrade check)
    expect(v1.broiler.find((f) => f.id === 'customer').type).toBe('multi');
  });

  it('the canonical suite itself passes publish validation for every program', () => {
    for (const program of PROGRAMS) {
      const verdict = validateTemplateDraft(suite[program].fields, suite[program].checklist);
      expect(verdict.problems, `${program} suite valid`).toEqual([]);
    }
  });

  it('fail-closed / idempotent / preserving contract is in the SQL', () => {
    // refuses an administrator-customized fields layout
    expect(mig174).toMatch(/IF v_active\.fields IS DISTINCT FROM v_v1 THEN[\s\S]*?administrator-customized/);
    // reapplication no-op
    expect(mig174).toMatch(/IF v_active\.fields = v_v2 THEN\s*\n\s*CONTINUE;/);
    // checklist preserved verbatim on the upgrade path
    expect(mig174).toMatch(/v_active\.version \+ 1,\s*\n\s*v_v2, v_active\.checklist/);
    // never deletes template rows; never touches records
    expect(mig174).not.toMatch(/DELETE FROM/i);
    expect(mig174).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+public\.processing_records/i);
    // one atomic DO block; PROCESSING_VALIDATION error class
    expect(mig174).toMatch(/DO \$mig\$/);
    expect(mig174).toContain('PROCESSING_VALIDATION:');
  });
});

describe('mig 172 — v1 seed stays insert-if-absent with the field-engine reissue', () => {
  it('seeds are insert-if-absent, deterministic v1, and can never touch existing rows', () => {
    for (const program of PROGRAMS) {
      expect(mig).toContain(`'ptpl-default-${program}', '${program}', 1,`);
      expect(mig).toContain(
        `WHERE NOT EXISTS (SELECT 1 FROM public.processing_templates WHERE program = '${program}')`,
      );
    }
    // No statement may modify or remove template rows — seed-only migration.
    expect(mig).not.toMatch(/UPDATE public\.processing_templates/i);
    expect(mig).not.toMatch(/DELETE FROM public\.processing_templates/i);
    expect(mig).not.toMatch(/is_active = false/i);
  });

  it('set_processing_field reissue adds checkbox + url validation and keeps the contract', () => {
    expect(mig).toMatch(/v_type = 'checkbox'[\s\S]*?jsonb_typeof\(p_value\) <> 'boolean'/);
    expect(mig).toMatch(/v_type = 'url'[\s\S]*?https\?:/);
    expect(mig).toContain('PERFORM public._processing_require_operational()');
    expect(mig).toContain('_processing_reserved_field_ids()');
    expect(mig).toContain('milestones do not take template fields');
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.set_processing_field(text, text, jsonb) TO authenticated');
    expect(mig).toContain("NOTIFY pgrst, 'reload schema'");
  });
});

describe('control ownership — Customer AND Processor are true selects everywhere', () => {
  it('drawer: selects sourced from the option lists; free-typing paths removed; legacy values stay visible', () => {
    expect(drawer).toContain('data-processing-processor-select');
    expect(drawer).toContain('data-processing-customer-select');
    expect(drawer).toMatch(/\(legacy\)/);
    expect(drawer).not.toContain('data-processing-processor-input');
    expect(drawer).not.toContain('datalist');
  });
  it('Add Milestone: selects, no datalist/free input', () => {
    expect(milestoneModal).toMatch(/<select[\s\S]{0,400}data-processing-milestone-processor/);
    expect(milestoneModal).toMatch(/<select[\s\S]{0,400}data-processing-milestone-customer/);
    expect(milestoneModal).not.toContain('datalist');
  });
  it('the template Processor + Customer defs are settings-sourced (no baked options)', () => {
    expect(fieldsLib).toMatch(/id: 'processor',[\s\S]{0,200}optionsSource: 'settings\.processor_options'/);
    expect(fieldsLib).toMatch(/id: 'customer',[\s\S]{0,200}optionsSource: 'settings\.customer_options'/);
    expect(fieldsLib).toMatch(/id: 'customer',[\s\S]{0,120}type: 'single'/);
  });
  it('no field renders twice: the template-field Details surface stays retired from the drawer', () => {
    // Planner-integration lane: the configurable Details section is gone, so
    // the fixed core rows + read-only Source details are the ONLY render of
    // each fact — the double-render class of bug is structurally impossible.
    expect(drawer).not.toContain('data-processing-details-section');
    expect(drawer).not.toContain('CORE_COVERED_FIELD_IDS');
    expect(drawer).not.toContain('resolveFieldDisplay');
    expect(drawer).not.toContain('data-processing-field-input');
    expect(drawer).toContain('data-processing-source-section');
  });
});

describe('field engine — control types survive as pure data (no drawer renderers)', () => {
  it('checkbox + url stay supported types (preserved fields data must keep validating)', () => {
    // The engine remains importable/pure: server-preserved historical fields
    // (mig 177 rides the active fields along on every save) can carry these
    // types, so the vocabulary may not shrink even though the drawer no
    // longer renders field editors and the modal no longer offers type pickers.
    expect(PROCESSING_FIELD_TYPES).toContain('checkbox');
    expect(PROCESSING_FIELD_TYPES).toContain('url');
    expect(drawer).not.toMatch(/field\.type === 'checkbox'/);
    expect(drawer).not.toMatch(/field\.type === 'url'/);
    expect(templatesModal).not.toMatch(/\{value: 'checkbox', label: 'Checkbox'\}/);
    expect(templatesModal).not.toMatch(/\{value: 'url', label: 'URL'\}/);
  });
});

describe('Templates manager — Active/Draft state, preview, publish validation', () => {
  it('shows Active/Draft state per program and a draft preview', () => {
    expect(templatesModal).toContain('data-processing-template-state');
    expect(templatesModal).toContain('data-processing-template-preview-toggle');
    expect(templatesModal).toContain('data-processing-template-preview="1"');
    expect(templatesModal).toMatch(/Active v\$\{activeVersion\}/);
    expect(templatesModal).toMatch(/Draft \(unsaved\)/);
  });
  it('publish validation blocks invalid drafts before the RPC call (checklist-only path)', () => {
    // The modal edits ONLY the checklist now; it validates through the
    // dedicated checklist path, and the full validateTemplateDraft keeps
    // delegating to the SAME rules so both paths can never drift.
    expect(templatesModal).toContain('validateChecklistDraft(draftChecklist)');
    expect(templatesModal).not.toContain('validateTemplateDraft');
    expect(templatesModal).toMatch(/if \(!verdict\.ok\)[\s\S]*?return;/);
    // Cannot activate messaging references the problems list.
    expect(templatesModal).toContain('Cannot activate this template');
    expect(fieldsLib).toMatch(/problems\.push\(\.\.\.validateChecklistDraft\(checklist\)\.problems\);/);
  });
  it('Reset restores the canonical default CHECKLIST only (fields are server-preserved)', () => {
    expect(templatesModal).toContain('defaultProcessingChecklist(program)');
    expect(templatesModal).not.toContain('defaultProcessingFields');
  });
  it('saves preserve the fields (incl. the settings-source markers) verbatim: fields:null + server keep', () => {
    // The client can no longer author fields, so Processor/Customer can never
    // lose their optionsSource markers through this modal: every save sends
    // fields:null and mig 177's upsert keeps the active version's fields.
    expect(templatesModal).toMatch(
      /upsertProcessingTemplate\(sb, \{program, fields: null, checklist: cleanChecklist\}\)/,
    );
    expect(mig177).toMatch(
      /IF p_fields IS NULL THEN\s*\n\s*SELECT fields INTO v_fields FROM public\.processing_templates/,
    );
    expect(mig177).toMatch(/WHERE program = p_program AND is_active = true;/);
  });
});
