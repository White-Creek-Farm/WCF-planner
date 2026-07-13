import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import * as shape from '../../supabase/functions/_shared/processingAsanaShape.js';

// Static guards for the reconciler: the mig-157 RPCs stay server-side for
// gated operational use; the CLIENT workbench (modal + wrappers + entry point)
// was removed by the UI-simplification lane. The pure matcher module remains
// the Edge Function's brain.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('reconciler server surface stays; client workbench is gone', () => {
  it('mig 157 keeps the four reconciliation RPCs server-side', () => {
    const mig = read('supabase-migrations/157_processing_reconciler.sql');
    for (const rpc of [
      'reconcile_planner_to_processing',
      'list_processing_reconciliation',
      'resolve_processing_asana_link',
      'acknowledge_processing_drift',
    ]) {
      expect(mig, `mig 157 defines ${rpc}`).toContain(`FUNCTION public.${rpc}`);
    }
  });
  it('the client wrappers + workbench UI are removed (UI-simplification lane)', () => {
    const api = read('src/lib/processingApi.js');
    for (const fn of [
      'reconcilePlannerToProcessing',
      'listProcessingReconciliation',
      'resolveProcessingAsanaLink',
      'acknowledgeProcessingDrift',
    ]) {
      expect(api, `${fn} wrapper must be gone`).not.toMatch(new RegExp('export (async )?function ' + fn + '\\b'));
    }
    expect(fs.existsSync(path.join(ROOT, 'src/processing/ProcessingReconciliationModal.jsx'))).toBe(false);
    expect(read('src/processing/ProcessingCalendarView.jsx')).not.toContain('data-processing-reconciliation-btn');
  });
  it('ProcessingDrawer badges imported (Asana-sourced) subtasks', () => {
    const d = read('src/processing/ProcessingDrawer.jsx');
    expect(d).toMatch(/source === 'asana'/);
  });
  it('edge loadPlannerRows filters archived=false (retired rows are never match candidates)', () => {
    const edge = read('supabase/functions/processing-asana-sync/index.ts');
    expect(edge).toMatch(/loadPlannerRows[\s\S]*?record_type', 'planner_batch'\)[\s\S]*?\.eq\('archived', false\)/);
  });
  it('edge loadPlannerRows excludes PLANNED pig rows (mig-176 source_phase) and the matcher re-guards', () => {
    const edge = read('supabase/functions/processing-asana-sync/index.ts');
    // source_phase is selected AND planned rows are filtered out post-fetch.
    expect(edge).toMatch(/loadPlannerRows[\s\S]*?sub_batch_attribution, source_phase/);
    expect(edge).toMatch(/loadPlannerRows[\s\S]*?source_phase !== 'planned'/);
    // Defense-in-depth: the pure matcher's pig branch applies the same guard.
    const matcher = read('supabase/functions/_shared/processingAsanaShape.js');
    expect(matcher).toMatch(/source_phase === 'planned'\) return false/);
  });
});

describe('pure matcher module (deterministic, no code-match for pigs)', () => {
  it('exports the matcher surface', () => {
    for (const fn of [
      'normalizeWcfCode',
      'matchAsanaTaskToPlanner',
      'deriveProcessingYear',
      'classifyBucket',
      'computeDrift',
    ]) {
      expect(typeof shape[fn], `${fn} should be a function`).toBe('function');
    }
  });
  it('normalizeWcfCode canonicalizes a real code and rejects junk', () => {
    expect(shape.normalizeWcfCode('not a batch')).toBeNull();
    expect(shape.normalizeWcfCode('WCF-C-26-01')).toBeTruthy();
  });
  it('classifyRecordType never returns planner_batch (Asana cannot mint planner rows)', () => {
    // A 2026 program task must NOT classify as planner_batch anymore.
    const out = shape.classifyRecordType(
      {name: 'WCF-B-26-09', resource_subtype: 'default'},
      {sectionName: 'WCF Broiler Processing', program: 'broiler'},
    );
    expect(out).not.toBe('planner_batch');
  });
});
