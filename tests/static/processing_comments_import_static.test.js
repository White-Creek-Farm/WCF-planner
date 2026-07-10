import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Lane A static guards: the comments-only import is exactly that — Asana comments
// for already-linked rows via record_processing_comment, and NOTHING else. No
// subtasks, no attachments, no Storage, and never the sync_once artifact path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const edgeFn = read('supabase/functions/processing-asana-sync/index.ts');
const reconModal = read('src/processing/ProcessingReconciliationModal.jsx');

// Body of runCommentsImport only (up to the next function declaration).
function commentsFnBody() {
  const start = edgeFn.indexOf('async function runCommentsImport(');
  expect(start).toBeGreaterThan(-1);
  const rest = edgeFn.slice(start + 1);
  const next = rest.indexOf('\nasync function ');
  return next === -1 ? edgeFn.slice(start) : edgeFn.slice(start, start + 1 + next);
}
// A named dispatch branch (from `if (action === 'X')` to the next `if (action ===`).
function branch(actionName) {
  const start = edgeFn.indexOf(`if (action === '${actionName}')`);
  expect(start, `branch ${actionName}`).toBeGreaterThan(-1);
  const rest = edgeFn.slice(start + 1);
  const next = rest.indexOf('if (action === ');
  return next === -1 ? edgeFn.slice(start) : edgeFn.slice(start, start + 1 + next);
}

describe('Lane A — comments-only import actions', () => {
  it('registers comments_dry_run + sync_comments actions', () => {
    expect(edgeFn).toContain("'comments_dry_run'");
    expect(edgeFn).toContain("'sync_comments'");
    expect(edgeFn).toContain('async function runCommentsImport(');
  });

  it('runCommentsImport imports COMMENTS ONLY — no subtasks / attachments / Storage / rematch', () => {
    const body = commentsFnBody();
    // The only write RPC it calls is record_processing_comment.
    expect(body).toContain("svc.rpc('record_processing_comment'");
    // Reads existing linked rows only via the shared loadLinkedGids helper,
    // which is itself a read-only non-null-record link lookup.
    expect(body).toContain('loadLinkedGids(svc)');
    const helperStart = edgeFn.indexOf('async function loadLinkedGids(');
    expect(helperStart).toBeGreaterThan(-1);
    const helper = edgeFn.slice(helperStart, helperStart + 600);
    expect(helper).toContain("from('processing_asana_links')");
    expect(helper).toMatch(/\.not\('processing_record_id', 'is', null\)/);
    // Absolutely no artifact/Storage/reconcile work.
    expect(body).not.toContain('upsert_processing_subtask_from_asana');
    expect(body).not.toContain('record_processing_attachment');
    expect(body).not.toContain('backfillAttachment');
    expect(body).not.toContain('reconcile_planner_to_processing');
    expect(body).not.toContain('importArtifacts');
    expect(body).not.toContain('runSync');
    expect(body).not.toMatch(/\.storage\b/);
    expect(body).not.toContain('ATTACHMENT_BUCKET');
    expect(body).not.toContain('SUBTASK_OPT_FIELDS');
    expect(body).not.toContain('ATTACH_OPT_FIELDS');
    // It DOES read the comment stories.
    expect(body).toContain('STORY_OPT_FIELDS');
    expect(body).toContain('isRealComment');
  });

  it('the dispatch branches route to runCommentsImport, never runSync', () => {
    // comments_dry_run shares the read-only per-lane dry-run branch (comments /
    // artifacts / activity) — it must route to runCommentsImport(svc, true, …).
    const dryStart = edgeFn.indexOf("if (action === 'comments_dry_run'");
    expect(dryStart).toBeGreaterThan(-1);
    const dryRest = edgeFn.slice(dryStart + 1);
    const dryNext = dryRest.indexOf('if (action === ');
    const dry = dryNext === -1 ? edgeFn.slice(dryStart) : edgeFn.slice(dryStart, dryStart + 1 + dryNext);
    expect(dry).toMatch(/runCommentsImport\(svc, true/);
    expect(dry).not.toContain('runSync');
    const write = branch('sync_comments');
    expect(write).toMatch(/runCommentsImport\(svc, false/);
    expect(write).not.toContain('runSync');
    // sync_comments is still gated behind the Asana token (it sits after the token check).
    const tokenIdx = edgeFn.indexOf("error: 'ASANA_ACCESS_TOKEN not configured'");
    const syncCommentsIdx = edgeFn.indexOf("if (action === 'sync_comments')");
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(syncCommentsIdx).toBeGreaterThan(tokenIdx);
  });

  it('client exposes admin Preview + Import comments controls wired to the two actions', () => {
    expect(reconModal).toContain('data-reconciliation-comments-preview-btn="1"');
    expect(reconModal).toContain('data-reconciliation-comments-import-btn="1"');
    expect(reconModal).toContain("invokeProcessingAsanaSync(sb, {action: 'comments_dry_run'})");
    expect(reconModal).toContain("invokeProcessingAsanaSync(sb, {action: 'sync_comments'})");
  });
});
