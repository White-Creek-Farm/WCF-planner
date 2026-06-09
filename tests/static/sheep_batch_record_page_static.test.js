import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pageSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchPage.jsx'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepBatchesView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('main.jsx — /sheep/batches/<id> route', () => {
  it('detects isSheepBatchesSubpath', () => {
    expect(mainSrc).toContain("location.pathname.startsWith('/sheep/batches/')");
  });
  it('maps subpath to sheepbatches view', () => {
    expect(mainSrc).toContain('isSheepBatchesSubpath');
    expect(mainSrc).toContain("? 'sheepbatches'");
  });
  it('guards subpath from view-to-URL clobber', () => {
    expect(mainSrc).toContain("view === 'sheepbatches' && location.pathname.startsWith('/sheep/batches/')");
  });
});

describe('activityRegistry — sheep.processing route', () => {
  it('routes sheep.processing to /sheep/batches/<id>', () => {
    expect(registrySrc).toMatch(/SHEEP_PROCESSING[\s\S]*?route:\s*\(id\)\s*=>\s*'\/sheep\/batches\/'\s*\+\s*id/);
  });
  it('routeToView handles /sheep/batches/ subpath', () => {
    expect(registrySrc).toContain("path.startsWith('/sheep/batches/')");
  });
});

describe('Header — direct-route allowlist', () => {
  it('includes /sheep/batches/ in record-page route check', () => {
    expect(headerSrc).toContain("route.startsWith('/sheep/batches/')");
  });
});

describe('SheepBatchPage — record page structure', () => {
  it('loads sheep_processing_batches by id', () => {
    expect(pageSrc).toContain("from('sheep_processing_batches')");
    expect(pageSrc).toContain(".eq('id', batchId)");
  });
  it('renders the title through the shared RecordTitle', () => {
    // data-record-title now lives in RecordPageShell's RecordTitle.
    expect(pageSrc).toContain('<RecordTitle');
  });
  it('renders RecordCollaborationSection with sheep.processing entityType', () => {
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(pageSrc).toContain('entityType="sheep.processing"');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(pageSrc).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(pageSrc).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('does not use ActivityPanel or ActivityModal', () => {
    expect(pageSrc).not.toContain('ActivityPanel');
    expect(pageSrc).not.toContain('ActivityModal');
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(pageSrc).toContain('location.hash');
    expect(pageSrc).toContain('scrollIntoView');
  });
  it('has back link to /sheep/batches', () => {
    expect(pageSrc).toContain("navigate('/sheep/batches')");
    expect(pageSrc).toContain('Back to Processing Batches');
  });
  it('has batch-not-found state', () => {
    expect(pageSrc).toContain('Batch not found');
  });
});

describe('SheepBatchesHub - cold-boot readiness', () => {
  const loadAllMatch = listSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('exposes a readiness marker keyed on loading or loadError', () => {
    expect(listSrc).toMatch(/data-sheep-batches-loaded=\{loading \|\| loadError \? 'false' : 'true'\}/);
  });

  it('never strands the sheep processing hub in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('surfaces sheep_processing_batches read failures and clears stale rows', () => {
    expect(listSrc).toContain('const [loadError, setLoadError] = useState(null);');
    expect(loadAllSrc).toContain("throw new Error('sheep_processing_batches: '");
    expect(loadAllSrc).toContain('Could not load sheep processing batches');
    expect(loadAllSrc).toContain('setBatches([]);');
    expect(listSrc).toContain('<InlineNotice notice={loadError} />');
    expect(listSrc).toContain('<InlineNotice notice={notice} onDismiss={() => setNotice(null)} />');
  });

  it('keeps load failures non-dismissible with a retry action and blocks hub rows', () => {
    expect(listSrc).toMatch(/\{!showForm && loadError && \([\s\S]*?onClick=\{loadAll\}[\s\S]*?Retry/);
    expect(listSrc).toMatch(/!loading && !loadError && batches\.length === 0/);
    expect(listSrc).toMatch(/!loading && !loadError && planned\.length > 0/);
    expect(listSrc).toMatch(/!loading && !loadError && completed\.length > 0/);
  });
});

describe('SheepBatchPage - cold-boot readiness', () => {
  const loadAllMatch = pageSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}React\.useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the sheep processing record page in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('surfaces batch and sheep read failures through a loadError InlineNotice', () => {
    expect(pageSrc).toContain('const [loadError, setLoadError] = React.useState(null);');
    expect(loadAllSrc).toContain("throw new Error('sheep_processing_batches: '");
    expect(loadAllSrc).toContain("throw new Error('sheep: '");
    expect(loadAllSrc).toContain('Could not load sheep processing batch');
    expect(loadAllSrc).toContain('setBatch(null);');
    expect(loadAllSrc).toContain('setSheep([]);');
    expect(loadAllSrc).toContain('setMetaDraft(null);');
    expect(pageSrc).toContain("from '../shared/RecordPageLoadError.jsx'");
    expect(pageSrc).toMatch(/if \(loadError\)[\s\S]*?<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
    expect(pageSrc).toMatch(/<RecordPageLoadError[\s\S]*onRetry=\{loadAll\}/);
  });

  it('exposes a loaded marker only on the resolved record body', () => {
    expect(pageSrc).toMatch(/<RecordPageBody[^>]*data-sheep-batch-record-loaded="true"/);
  });
});

describe('SheepBatchPage — sheep-specific contracts', () => {
  it('does not invent a cattle-style scheduled/active lifecycle', () => {
    expect(pageSrc).not.toContain("status === 'scheduled'");
    expect(pageSrc).not.toContain("status === 'active'");
    expect(pageSrc).not.toMatch(/'scheduled'[\s\S]*'active'[\s\S]*'complete'/);
  });
  it('supports planned + complete statuses only', () => {
    expect(pageSrc).toContain('<option value="planned">');
    expect(pageSrc).toContain('<option value="complete">');
  });
  it('uses the audited SECDEF RPC wrapper for per-row detach + delete loop', () => {
    // Detach now goes through the transactional RPC wrapper (migration 081),
    // which logs Activity atomically — not the detachSheepFromBatch client
    // helper (which the public WeighInsWebform anon path still uses).
    expect(pageSrc).toContain('detachSheepFromProcessingBatch');
    expect(pageSrc).not.toContain("from '../lib/sheepProcessingBatch.js'");
  });
  it('preserves no_prior_flock warning on detach', () => {
    expect(pageSrc).toContain('no_prior_flock');
    expect(pageSrc).toMatch(/no_prior_flock[\s\S]*?Manually move via the Flocks tab/);
  });
  it('invalidates sheep weigh-in cache on detach/delete', () => {
    expect(pageSrc).toContain('invalidateSheepWeighInsCache');
  });
  it('does not include manual sheep-attach UI', () => {
    expect(pageSrc).not.toMatch(/Add sheep from feeders/i);
    expect(pageSrc).not.toMatch(/feeders weigh-in entry/i);
  });
  it('keeps the Send-to-Processor hint visible on the record page', () => {
    expect(pageSrc).toMatch(/Sheep enter this batch only via the Send-to-Processor flag/);
  });
});

describe('SheepBatchPage — metadata + weight editing', () => {
  it('has blur-save name editor', () => {
    expect(pageSrc).toContain('data-sheep-batch-name');
    expect(pageSrc).toMatch(/data-sheep-batch-name[\s\S]*?onBlur=/);
  });
  it('has status select with status.changed Activity', () => {
    expect(pageSrc).toContain('data-sheep-batch-status');
    expect(pageSrc).toContain('recordStatusChange');
    expect(pageSrc).toContain("entityType: 'sheep.processing'");
  });
  it('has planned + actual date inputs that blur-save', () => {
    expect(pageSrc).toContain('data-sheep-batch-planned-date');
    expect(pageSrc).toContain('data-sheep-batch-actual-date');
  });
  it('has processing cost input that blur-saves', () => {
    expect(pageSrc).toContain('data-sheep-batch-cost');
  });
  it('has notes textarea that blur-saves', () => {
    expect(pageSrc).toContain('data-sheep-batch-notes');
  });
  it('per-row weight inputs are present', () => {
    expect(pageSrc).toContain('data-batch-sheep-live-weight');
    expect(pageSrc).toContain('data-batch-sheep-hanging-weight');
  });
  it('recomputes totals + persists sheep_detail on weight save', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?recomputeTotals/);
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?sheep_detail/);
  });
  it('weight inputs are disabled when batch is complete', () => {
    expect(pageSrc).toMatch(/weightDisabled\s*=\s*!canEdit \|\| isComplete/);
  });
  it('logs field.updated for meaningful metadata saves', () => {
    expect(pageSrc).toContain('recordActivityEvent');
    expect(pageSrc).toContain("eventType: 'field.updated'");
  });
  it('does not emit a client record.deleted Activity event (the mig 100 RPC owns the delete audit)', () => {
    // The hard delete is now audited inside delete_sheep_processing_batch
    // (record.deleted, in the same transaction). The page must not also write a
    // best-effort client-side Activity event for it.
    expect(pageSrc).not.toContain("eventType: 'record.deleted'");
  });
  it('saveSheepWeight logs best-effort field.updated Activity after successful save', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?\.update\([\s\S]*?if \(error\)[\s\S]*?return[\s\S]*?logEvent\(/);
  });
  it('saveSheepWeight skips Activity when DB update fails (error-then-return precedes logEvent)', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?if \(error\)[\s\S]*?return;[\s\S]*?logEvent\(/);
  });
  it('saveSheepWeight skips Activity for unchanged values', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?oldNorm\s*===\s*newNorm[\s\S]*?return/);
  });
  it('saveSheepWeight rejects NaN before writing', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?Number\.isNaN[\s\S]*?return/);
  });
  it('saveSheepWeight Activity body names the tag and the field label', () => {
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?'Live weight'/);
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?'Hanging weight'/);
    expect(pageSrc).toMatch(/saveSheepWeight[\s\S]*?'#' \+ tag/);
  });
});

describe('SheepBatchPage — delete flow', () => {
  it('has delete button gated on canEdit', () => {
    expect(pageSrc).toContain('data-sheep-batch-delete');
    expect(pageSrc).toMatch(/canEdit[\s\S]*?data-sheep-batch-delete/);
  });
  it('delete routes through window._wcfConfirmDelete', () => {
    expect(pageSrc).toContain('window._wcfConfirmDelete');
  });
  it('delete drives detach loop via the audited SECDEF RPC wrapper', () => {
    expect(pageSrc).toMatch(/handleDeleteBatch[\s\S]*?detachSheepFromProcessingBatch/);
  });
  it('clears stragglers + removes batch via the SECDEF lifecycle RPC (mig 100), then navigates back', () => {
    // The straggler clear (sheep.update processing_batch_id=null) and the batch
    // hard delete moved into delete_sheep_processing_batch, made atomic + audited.
    expect(pageSrc).toMatch(/handleDeleteBatch[\s\S]*?deleteSheepProcessingBatch/);
    expect(pageSrc).not.toContain('processing_batch_id: null');
    expect(pageSrc).not.toMatch(/sheep_processing_batches'\)\s*\.delete\(/);
    expect(pageSrc).toMatch(/handleDeleteBatch[\s\S]*?navigate\('\/sheep\/batches'\)/);
  });
  it('reports blocked detaches in the notice', () => {
    expect(pageSrc).toContain('could not be auto-reverted');
  });
  it('hands blocked-detach warning to the hub via navigation state (no setTimeout race)', () => {
    expect(pageSrc).toMatch(
      /handleDeleteBatch[\s\S]*?blocked\.length > 0[\s\S]*?navigate\('\/sheep\/batches', \{state: \{notice/,
    );
    expect(pageSrc).not.toMatch(/handleDeleteBatch[\s\S]*?setTimeout\([\s\S]*?navigate/);
  });
});

describe('SheepBatchesHub — surfaces handed-off notice from navigation state', () => {
  it('reads location.state.notice on mount', () => {
    expect(listSrc).toContain('location.state');
    expect(listSrc).toMatch(/location\.state\.notice[\s\S]*?setNotice\(location\.state\.notice\)/);
  });
  it('clears navigation state after reading so refresh does not replay', () => {
    expect(listSrc).toMatch(/navigate\(location\.pathname,\s*\{replace:\s*true,\s*state:\s*null\}\)/);
  });
});

describe('SheepBatchesView — cleaned list view', () => {
  it('has SheepBatchesRouter that delegates to record page', () => {
    expect(listSrc).toContain('SheepBatchesRouter');
    expect(listSrc).toContain('SheepBatchPage');
  });
  it('real batch tiles navigate to /sheep/batches/<id>', () => {
    expect(listSrc).toContain("navigate('/sheep/batches/' + b.id");
  });
  it('new batch save navigates to record page after insert', () => {
    expect(listSrc).toMatch(/saveNewBatch[\s\S]*?navigate\('\/sheep\/batches\/' \+ id\)/);
  });
  it('does not have expandedBatchId state', () => {
    expect(listSrc).not.toContain('expandedBatchId');
  });
  it('does not have per-row weight editing', () => {
    expect(listSrc).not.toContain('saveSheepWeight');
    expect(listSrc).not.toContain('sheepDraft');
  });
  it('does not have inline detach or detach helpers', () => {
    expect(listSrc).not.toContain('detachSheepFromBatch');
    expect(listSrc).not.toContain('detachSheepAndReport');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(listSrc).not.toContain('ActivityPanel');
    expect(listSrc).not.toContain('ActivityModal');
  });
  it('does not have activityTarget state or deep-link listener', () => {
    expect(listSrc).not.toContain('activityTarget');
    expect(listSrc).not.toContain('wcf-entity-deep-link');
  });
  it('keeps the Send-to-Processor hint on the empty state', () => {
    expect(listSrc).toMatch(/Sheep enter this batch only via the Send-to-Processor flag/);
  });
  it('still has + New Batch button (admin/management only)', () => {
    expect(listSrc).toContain('+ New Batch');
    expect(listSrc).toMatch(/canEdit[\s\S]*?\+ New Batch/);
  });
  it('still has the no-manual-attach hint in the new-batch modal', () => {
    expect(listSrc).toContain('data-sheep-new-batch-modal');
    expect(listSrc).toMatch(/Sheep enter this batch only via the Send-to-Processor flag/);
  });
});
