import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the reconciliation workbench lane:
//   • migration 159 — reconciliation RPCs (resolve reissue + triage + supersede +
//     enriched list) — SECDEF, gated, grants, no CHECK/table changes;
//   • edge sync_review_queue — records + links only (no artifacts / Storage);
//   • ProcessingReconciliationModal — bucketed one-item workbench + actions;
//   • processingApi — triage + supersede wrappers over the RPCs.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const mig = read('supabase-migrations/159_processing_reconciliation_workbench.sql');
const edgeFn = read('supabase/functions/processing-asana-sync/index.ts');
const reconModal = read('src/processing/ProcessingReconciliationModal.jsx');
const api = read('src/lib/processingApi.js');

function fnBody(name) {
  const re = new RegExp('CREATE OR REPLACE FUNCTION public\\.' + name + '\\b[\\s\\S]*?\\$fn\\$;');
  const m = mig.match(re);
  return m ? m[0] : '';
}

describe('mig 159 — reconciliation RPCs are SECDEF, operational-gated, RPC-only', () => {
  it('reissues/creates exactly the four workbench RPCs, all SECDEF + operational-gated', () => {
    for (const fn of [
      'resolve_processing_asana_link',
      'triage_processing_asana_record',
      'supersede_processing_asana_duplicate',
      'list_processing_reconciliation',
    ]) {
      const body = fnBody(fn);
      expect(body, `${fn} defined`).not.toBe('');
      expect(body, `${fn} SECDEF`).toContain('SECURITY DEFINER');
      expect(body, `${fn} gated`).toContain('public._processing_require_operational()');
    }
    // Read-derived + narrow RPCs only: no schema or CHECK changes in this migration.
    expect(mig).not.toContain('ALTER TABLE');
    expect(mig).not.toMatch(/ADD CONSTRAINT|DROP CONSTRAINT/);
    expect(mig).not.toContain('CREATE TABLE');
    expect(mig).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);
  });

  it('resolve reissue reparents artifacts + retires ONLY an orphaned Asana-owned placeholder', () => {
    const body = fnBody('resolve_processing_asana_link');
    // Reparent subtasks / attachments / comments to the new record.
    expect(body).toContain('UPDATE public.processing_subtasks    SET record_id = p_record_id');
    expect(body).toContain('UPDATE public.processing_attachments SET record_id = p_record_id');
    expect(body).toMatch(
      /UPDATE public\.comments SET entity_id = p_record_id[\s\S]*?entity_type = 'processing\.record'/,
    );
    // Only when the OLD record is an Asana-owned placeholder AND no other link owns it.
    expect(body).toMatch(/v_old_type IN \('asana_historical', 'import_exception'\)/);
    expect(body).toMatch(/NOT EXISTS \([\s\S]*?processing_record_id = v_old_rec AND asana_gid <> p_asana_gid/);
    expect(body).toContain('UPDATE public.processing_records SET archived = true');
    // Signature + grant preserved (grant/revoke live just after the fn body).
    expect(mig).toContain(
      'GRANT EXECUTE ON FUNCTION public.resolve_processing_asana_link(text, text) TO authenticated',
    );
    expect(mig).toMatch(/REVOKE ALL ON FUNCTION public\.resolve_processing_asana_link\(text, text\) FROM PUBLIC, anon/);
  });

  it('triage reclassifies milestone/historical/dismiss but NEVER a planner_batch', () => {
    const body = fnBody('triage_processing_asana_record');
    expect(body).toMatch(/IF v_type = 'planner_batch' THEN[\s\S]*?cannot triage a planner_batch/);
    expect(body).toMatch(/p_action = 'milestone'[\s\S]*?record_type = 'milestone'/);
    expect(body).toMatch(/p_action = 'historical'[\s\S]*?record_type = 'asana_historical'/);
    expect(body).toMatch(/p_action = 'dismiss'[\s\S]*?archived = true/);
    expect(mig).toContain(
      'GRANT EXECUTE ON FUNCTION public.triage_processing_asana_record(text, text) TO authenticated',
    );
  });

  it('supersede blocks a duplicate (provenance kept) and never archives a planner_batch/canonical', () => {
    const body = fnBody('supersede_processing_asana_duplicate');
    expect(body).toContain("match_status = 'duplicate_blocked'");
    // Never deletes provenance.
    expect(body).not.toMatch(/DELETE FROM public\.processing_asana_links/);
    // Archive gated to an orphaned Asana-owned placeholder that is not the canonical.
    expect(body).toMatch(/v_old_rec IS DISTINCT FROM p_canonical_record_id/);
    expect(body).toMatch(/v_old_type IN \('asana_historical', 'import_exception'\)/);
    expect(body).toContain('UPDATE public.processing_records SET archived = true');
    expect(mig).toContain(
      'GRANT EXECUTE ON FUNCTION public.supersede_processing_asana_duplicate(text, text) TO authenticated',
    );
  });

  it('list_processing_reconciliation is enriched (bucket + record + candidates + duplicate groups)', () => {
    const body = fnBody('list_processing_reconciliation');
    for (const key of ["'bucket'", "'record'", "'candidates'", "'duplicate_group'", "'duplicate_groups'"]) {
      expect(body, `enriched key ${key}`).toContain(key);
    }
    // Splits needs_review into ambiguous vs import_exception and surfaces the count.
    expect(body).toContain("'ambiguous'");
    expect(body).toContain("'import_exception'");
    expect(body).toContain("'import_exception_count'");
    // Blocker 1: a dismissed (archived) Asana-owned placeholder derives a non-active
    // 'dismissed' bucket so it leaves the active work queues.
    expect(body).toContain("'dismissed'");
    expect(body).toContain("'dismissed_count'");
    expect(body).toMatch(/rec\.archived = true AND rec\.record_type IN \('asana_historical', 'import_exception'\)/);
    // Blocker 2: duplicate groups + per-link duplicate_group count ACTIVE links only
    // (blocked duplicates drop out).
    expect(body).toContain("match_status <> 'duplicate_blocked'");
    // Blocker 2b: a dismissed (archived Asana-owned) placeholder is ALSO not an
    // active duplicate member — excluded from the group CTE, the link's own tag,
    // and the peer EXISTS. And the ACTIVE-work summary counts (needs_review_count /
    // import_exception_count) mirror the queues with the same guard. The COALESCE
    // archived-placeholder guard therefore appears >= 5 times.
    const dupExcl = body.match(/record_type IN \('asana_historical', 'import_exception'\), false\)/g) || [];
    expect(dupExcl.length).toBeGreaterThanOrEqual(5);
    // Active-work counts exclude dismissed archived placeholders (mirror the queues).
    expect(body).toMatch(
      /'needs_review_count'[\s\S]*?NOT COALESCE\(r\.archived AND r\.record_type IN \('asana_historical', 'import_exception'\), false\)/,
    );
    expect(body).toMatch(
      /'import_exception_count'[\s\S]*?NOT COALESCE\(r\.archived AND r\.record_type IN \('asana_historical', 'import_exception'\), false\)/,
    );
    expect(mig).toContain('GRANT EXECUTE ON FUNCTION public.list_processing_reconciliation() TO authenticated');
  });
});

describe('edge sync_review_queue — records + links ONLY (no artifacts / Storage)', () => {
  it('is a known action and runs review-only (reviewOnly flag routed into runSync)', () => {
    expect(edgeFn).toContain("'sync_review_queue'");
    expect(edgeFn).toContain("const reviewOnly = action === 'sync_review_queue';");
    expect(edgeFn).toContain('runSync(svc, action, sinceISO, runId, reviewOnly, ctx)');
    expect(edgeFn).toMatch(/async function runSync\([\s\S]*?reviewOnly = false,/);
  });

  it('review-only skips every artifact import; attachments never ride runSync at all', () => {
    // The processing-complete lane REMOVED attachment bytes from runSync
    // entirely: no doAttachments switch remains, importArtifacts carries no
    // Storage/byte work, and the only byte-copier is runAttachmentBackfill.
    expect(edgeFn).not.toContain('doAttachments');
    const importStart = edgeFn.indexOf('async function importArtifacts(');
    expect(importStart).toBeGreaterThan(-1);
    const importEnd = edgeFn.indexOf('\nasync function ', importStart + 1);
    const importBody = edgeFn.slice(importStart, importEnd);
    expect(importBody).not.toContain('backfillAttachment');
    expect(importBody).not.toContain('ATTACHMENT_BUCKET');
    expect(importBody).not.toMatch(/\.storage\b/);
    // EVERY importArtifacts call is guarded by !reviewOnly (none can run in review-only).
    const total = (edgeFn.match(/await importArtifacts\(/g) || []).length;
    const guarded = (edgeFn.match(/if \(!reviewOnly\) await importArtifacts\(/g) || []).length;
    expect(total).toBeGreaterThan(0);
    expect(guarded).toBe(total);
  });

  it('dry_run stays read-only and Storage backfill stays a separate write action', () => {
    // Attachment bytes move ONLY through the dedicated attachment_backfill
    // action → runAttachmentBackfill (never sync_once/sync_since/review queue).
    expect(edgeFn).toMatch(/if \(action === 'attachment_backfill'\)[\s\S]*?runAttachmentBackfill\(svc\)/);
    expect((edgeFn.match(/await runAttachmentBackfill\(svc\)/g) || []).length).toBe(1);
    // The read-only dry_run is untouched (still returns a plan, no writes).
    expect(edgeFn).toMatch(/if \(action === 'dry_run'\)[\s\S]*?runDryRun\(svc\)/);
  });
});

describe('ProcessingReconciliationModal — bucketed one-item workbench', () => {
  it('renders the workbench container + all five bucket tabs', () => {
    expect(reconModal).toContain('data-reconciliation-workbench="1"');
    expect(reconModal).toContain('data-reconciliation-bucket-tab');
    for (const key of [
      "key: 'ambiguous'",
      "key: 'import_exception'",
      "key: 'pig'",
      "key: 'duplicates'",
      "key: 'drift'",
    ]) {
      expect(reconModal).toContain(key);
    }
  });

  it('exposes every workbench action', () => {
    for (const marker of [
      'data-reconciliation-populate-btn="1"', // populate the review queue (sync_review_queue)
      'data-reconciliation-candidate', // assign to a suggested planner record
      'data-reconciliation-search="1"', // search-and-assign input
      'data-reconciliation-search-assign', // search result assign
      'data-reconciliation-triage-milestone="1"',
      'data-reconciliation-triage-historical="1"',
      'data-reconciliation-triage-dismiss="1"',
      'data-reconciliation-supersede', // block a duplicate
      'data-reconciliation-ack="1"', // acknowledge drift
      'data-reconciliation-skip="1"', // local skip/next
    ]) {
      expect(reconModal, marker).toContain(marker);
    }
  });

  it('the Pig tab is EXCLUSIVE — Ambiguous and Exceptions filter program=pig out', () => {
    expect(reconModal).toMatch(/bucket === 'ambiguous' && l\.program !== 'pig'/);
    expect(reconModal).toMatch(/bucket === 'import_exception' && l\.program !== 'pig'/);
    // The Pig queue is the only one that keeps program='pig' review rows.
    expect(reconModal).toMatch(/l\.program === 'pig' && notSkipped/);
  });

  it('drives every action through the RPC wrappers (no raw client table access)', () => {
    expect(reconModal).toContain('resolveProcessingAsanaLink(sb');
    expect(reconModal).toContain('triageProcessingAsanaRecord(sb');
    expect(reconModal).toContain('supersedeProcessingAsanaDuplicate(sb');
    expect(reconModal).toContain('acknowledgeProcessingDrift(sb');
    expect(reconModal).toContain("invokeProcessingAsanaSync(sb, {action: 'sync_review_queue'})");
    // Deny-all RLS boundary: the client never reads/writes a table directly.
    expect(reconModal).not.toMatch(/\bsb\.from\(/);
  });
});

describe('processingApi — triage + supersede wrappers over the mig-159 RPCs', () => {
  it('exposes triageProcessingAsanaRecord over triage_processing_asana_record', () => {
    expect(api).toContain('export async function triageProcessingAsanaRecord');
    expect(api).toContain("sb.rpc('triage_processing_asana_record'");
  });
  it('exposes supersedeProcessingAsanaDuplicate over supersede_processing_asana_duplicate', () => {
    expect(api).toContain('export async function supersedeProcessingAsanaDuplicate');
    expect(api).toContain("sb.rpc('supersede_processing_asana_duplicate'");
  });
});
