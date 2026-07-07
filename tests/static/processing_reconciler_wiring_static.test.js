import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import * as shape from '../../supabase/functions/_shared/processingAsanaShape.js';

// Static guards for the reconciler client wiring + the pure matcher module.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('reconciler lib wrappers', () => {
  const api = read('src/lib/processingApi.js');
  it('exposes the four mig-157 RPC wrappers', () => {
    for (const fn of [
      'reconcilePlannerToProcessing',
      'listProcessingReconciliation',
      'resolveProcessingAsanaLink',
      'acknowledgeProcessingDrift',
    ]) {
      expect(api, `missing ${fn}`).toMatch(new RegExp('export (async )?function ' + fn + '\\b'));
    }
  });
  it('routes the wrappers through sb.rpc with the exact RPC names', () => {
    expect(api).toContain("'reconcile_planner_to_processing'");
    expect(api).toContain("'list_processing_reconciliation'");
    expect(api).toContain("'resolve_processing_asana_link'");
    expect(api).toContain("'acknowledge_processing_drift'");
  });
});

describe('reconciler UI wiring', () => {
  it('ProcessingCalendarView adds an admin reconciliation entry point', () => {
    expect(read('src/processing/ProcessingCalendarView.jsx')).toContain('data-processing-reconciliation-btn');
  });
  it('ProcessingReconciliationModal has the crosswalk + drift markers', () => {
    const m = read('src/processing/ProcessingReconciliationModal.jsx');
    for (const mk of [
      'data-processing-reconciliation-modal',
      'data-processing-reconciliation-loaded',
      'data-reconciliation-review-row',
      'data-reconciliation-resolve',
      'data-reconciliation-ack',
    ]) {
      expect(m, `missing marker ${mk}`).toContain(mk);
    }
    // Uses the crosswalk + report + ack wrappers.
    expect(m).toMatch(/resolveProcessingAsanaLink|listProcessingReconciliation/);
  });
  it('ProcessingDrawer badges imported (Asana-sourced) subtasks', () => {
    const d = read('src/processing/ProcessingDrawer.jsx');
    expect(d).toMatch(/source === 'asana'/);
  });
  it('edge loadPlannerRows filters archived=false (retired rows are never match candidates)', () => {
    const edge = read('supabase/functions/processing-asana-sync/index.ts');
    expect(edge).toMatch(/loadPlannerRows[\s\S]*?record_type', 'planner_batch'\)[\s\S]*?\.eq\('archived', false\)/);
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
