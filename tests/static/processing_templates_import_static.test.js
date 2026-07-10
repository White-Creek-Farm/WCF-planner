import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for sub-lane 5: Asana task-template importer. The pure mapping is
// unit-tested in tests/processing_asana_templates.test.js; this guards the Edge
// action wiring (no Deno available here) + the client trigger. The live run
// stays behind the ASANA_ACCESS_TOKEN + Edge-deploy gate.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const shape = read('supabase/functions/_shared/processingAsanaShape.js');
const edge = read('supabase/functions/processing-asana-sync/index.ts');
const templatesModal = read('src/processing/ProcessingTemplatesModal.jsx');

describe('shared module exports the pure importer primitives', () => {
  it('exports program inference + mapping + idempotency + plan', () => {
    expect(shape).toContain('export function inferProgramFromTemplateName');
    expect(shape).toContain('export function mapAsanaTemplateToProcessing');
    expect(shape).toContain('export function templateContentKey');
    expect(shape).toContain('export function buildTemplateImportPlan');
  });
});

describe('edge function wires the importer actions', () => {
  it('registers both actions and the helpers', () => {
    expect(edge).toContain('buildTemplateImportPlan');
    expect(edge).toContain("'import_templates_dry_run'");
    expect(edge).toContain("'import_templates'");
    expect(edge).toContain('async function fetchAsanaTemplates');
    expect(edge).toContain('async function runTemplateImport');
    expect(edge).toContain('function userClientFromReq');
    expect(edge).toContain('TEMPLATE_DETAIL_OPT_FIELDS');
    // reads the SF Processing Calendar project's task templates
    expect(edge).toContain("asanaGetAll('/task_templates'");
    expect(edge).toContain('/task_templates/${gid}');
  });

  it('dry-run is read-only; write is admin-only and uses the admin RPC via the user JWT', () => {
    // preview passes no user client + apply=false
    expect(edge).toContain('runTemplateImport(svc, null, false)');
    // write is admin-only
    expect(edge).toMatch(/import_templates is admin-only/);
    // writes via the caller's admin JWT through the existing admin-gated RPC
    expect(edge).toContain("userClient.rpc('upsert_processing_template'");
    // only 'ready' items are written (idempotent / conflict-safe)
    expect(edge).toMatch(/item\.status !== 'ready'/);
    // write is bracketed in a sync-run row
    expect(edge).toContain("start_processing_sync_run', {p_action: action}");
  });
});

describe('templates modal is LOCAL-ONLY (UI-simplification lane)', () => {
  it('carries NO Asana import workflow; the Edge actions stay for gated operational use', () => {
    expect(templatesModal).not.toContain('invokeProcessingAsanaSync');
    expect(templatesModal).not.toContain('import_templates');
    expect(templatesModal).not.toContain('data-processing-template-import-btn');
    expect(templatesModal).not.toContain('data-processing-template-import-apply');
    expect(templatesModal).not.toMatch(/Import from Asana/i);
    // Customer & Processor choice management opens from INSIDE Templates.
    expect(templatesModal).toContain('data-processing-options-btn="1"');
  });
});
