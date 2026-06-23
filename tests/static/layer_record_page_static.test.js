import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const batchPage = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchPage.jsx'), 'utf8');
const housingPage = fs.readFileSync(path.join(ROOT, 'src/layer/LayerHousingPage.jsx'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'src/layer/LayerBatchesView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('main.jsx — /layer/batches/<id> and /layer/housings/<id> routes', () => {
  it('detects isLayerBatchesSubpath and isLayerHousingsSubpath', () => {
    expect(mainSrc).toContain('isLayerBatchesSubpath');
    expect(mainSrc).toContain('isLayerHousingsSubpath');
    expect(mainSrc).toContain("location.pathname.startsWith('/layer/batches/')");
    expect(mainSrc).toContain("location.pathname.startsWith('/layer/housings/')");
  });
  it('maps both subpaths to the layerbatches view', () => {
    expect(mainSrc).toContain("? 'layerbatches'");
  });
  it('guards both subpaths from view-to-URL clobber', () => {
    expect(mainSrc).toContain("view === 'layerbatches' && location.pathname.startsWith('/layer/batches/')");
    expect(mainSrc).toContain("view === 'layerbatches' && location.pathname.startsWith('/layer/housings/')");
  });
});

describe('activityRegistry — layer routes by ID', () => {
  it('layer.batch routes to /layer/batches/<id>', () => {
    expect(registrySrc).toMatch(/LAYER_BATCH[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/batches\/'\s*\+\s*id/);
  });
  it('layer.housing routes to /layer/housings/<id>', () => {
    expect(registrySrc).toMatch(/LAYER_HOUSING[\s\S]*?route:\s*\(id\)\s*=>\s*'\/layer\/housings\/'\s*\+\s*id/);
  });
  it('routeToView handles both /layer/batches/ and /layer/housings/ subpaths', () => {
    expect(registrySrc).toContain("path.startsWith('/layer/batches/')");
    expect(registrySrc).toContain("path.startsWith('/layer/housings/')");
  });
});

describe('Header — direct-route allowlist', () => {
  it('includes /layer/batches/ and /layer/housings/ in record-page route check', () => {
    expect(headerSrc).toContain("route.startsWith('/layer/batches/')");
    expect(headerSrc).toContain("route.startsWith('/layer/housings/')");
  });
});

describe('LayerBatchPage — record page structure', () => {
  it('derives the batch from the layerBatches prop, not a by-id load gate', () => {
    // main.jsx guarantees layerBatches is loaded before layer routes render, so
    // the record/not-found gate must read the prop — never an empty by-id read.
    expect(batchPage).toMatch(
      /const batch = React\.useMemo\(\s*\(\) => \(layerBatches \|\| \[\]\)\.find\(\(b\) => b\.id === batchId\)/,
    );
    expect(batchPage).not.toContain(".eq('id', batchId).maybeSingle()");
  });
  it('renders the title through the shared RecordTitle', () => {
    // data-record-title now lives in RecordPageShell's RecordTitle.
    expect(batchPage).toContain('<RecordTitle');
  });
  it('renders RecordCollaborationSection with layer.batch entityType', () => {
    expect(batchPage).toContain('RecordCollaborationSection');
    expect(batchPage).toContain('entityType="layer.batch"');
  });
  it('does not use ActivityPanel or ActivityModal', () => {
    expect(batchPage).not.toContain('ActivityPanel');
    expect(batchPage).not.toContain('ActivityModal');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(batchPage).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(batchPage).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(batchPage).toContain('location.hash');
    expect(batchPage).toContain('scrollIntoView');
  });
  it('has back link to /layer/batches', () => {
    expect(batchPage).toContain("navigate('/layer/batches')");
    expect(batchPage).toContain('Back to Layer Batches');
  });
  it('has batch-not-found state', () => {
    expect(batchPage).toContain('Batch not found');
  });
  it('uses extracted layerBatchStats helpers (no inline re-implementation)', () => {
    expect(batchPage).toMatch(/from\s+['"]\.\/layerBatchStats\.js['"]/);
    expect(batchPage).toContain('computeBatchStats');
    expect(batchPage).toContain('computeHousingStats');
  });
});

describe('LayerBatchPage — housing summaries navigate to /layer/housings/<id>', () => {
  it('housing tiles navigate to /layer/housings/<id>', () => {
    expect(batchPage).toContain("'/layer/housings/' + h.id");
  });
  it('does not keep housing editing inline (no per-row Edit Housing button on tile)', () => {
    expect(batchPage).not.toMatch(/data-batch-housing-edit/);
    expect(batchPage).not.toMatch(/setEditHousingId/);
  });
});

describe('LayerBatchPage — Edit Batch modal preserves existing semantics', () => {
  it('exposes Edit Batch action gated on canEdit', () => {
    expect(batchPage).toContain('data-layer-batch-edit');
    expect(batchPage).toMatch(/canEdit[\s\S]*?data-layer-batch-edit/);
  });
  it('renders the layer batch form modal with autosave', () => {
    expect(batchPage).toContain('data-layer-batch-form-modal');
    expect(batchPage).toContain('scheduleBatchAutosave');
    expect(batchPage).toContain('Auto-saves as you type');
  });
  it('preserves brooder + schooner phase fields', () => {
    expect(batchPage).toContain('BROODER PHASE');
    expect(batchPage).toContain('SCHOONER PHASE');
    expect(batchPage).toContain('BROODERS.map');
    expect(batchPage).toContain('SCHOONERS.map');
  });
  it('preserves feed cost rate display (read-only)', () => {
    expect(batchPage).toContain('FEED COST RATES');
    expect(batchPage).toContain('per_lb_starter_cost');
  });
  it('preserves the notes field.updated Activity wiring', () => {
    expect(batchPage).toContain('recordFieldChange');
    expect(batchPage).toContain("field: 'notes'");
    expect(batchPage).toContain("entityType: 'layer.batch'");
  });
});

describe('LayerBatchPage — delete routed through the SECDEF RPC (mig 106)', () => {
  it('has Delete Batch button gated on canEdit and routed through confirmDelete', () => {
    expect(batchPage).toContain('data-layer-batch-delete');
    expect(batchPage).toContain('confirmDelete');
  });
  it('routes handleDeleteBatch through deleteLayerBatch instead of two raw client deletes', () => {
    // The transactional SECDEF RPC (mig 106) now does the child-housing clear +
    // batch-root delete + record.deleted audit in one transaction; the page no
    // longer issues raw .delete() on either layer table.
    expect(batchPage).toMatch(/handleDeleteBatch[\s\S]*?deleteLayerBatch\(sb, batch\.id\)/);
    expect(batchPage).not.toMatch(/from\('layer_housings'\)[\s\S]*?\.delete\(\)/);
    expect(batchPage).not.toMatch(/from\('layer_batches'\)[\s\S]*?\.delete\(\)/);
  });
  it('does not emit a client record.deleted Activity event (the RPC audits server-side)', () => {
    expect(batchPage).not.toContain("eventType: 'record.deleted'");
  });
  it('navigates back to /layer/batches after a successful delete', () => {
    expect(batchPage).toMatch(/handleDeleteBatch[\s\S]*?navigate\('\/layer\/batches'\)/);
  });
});

describe('LayerBatchPage — + Add Housing helper navigates to record page', () => {
  it('has Add Housing button gated on canEdit + active', () => {
    expect(batchPage).toContain('data-layer-batch-add-housing');
  });
  it('helper modal inserts shell and navigates to /layer/housings/<id>', () => {
    expect(batchPage).toContain('data-layer-add-housing-modal');
    expect(batchPage).toMatch(/saveNewHousing[\s\S]*?navigate\('\/layer\/housings\/' \+ id\)/);
  });
});

describe('LayerHousingPage — record page structure', () => {
  it('derives housing from layerHousings and parent batch from layerBatches, not a by-id load gate', () => {
    expect(housingPage).toMatch(
      /const housing = React\.useMemo\([\s\S]*?\(layerHousings \|\| \[\]\)\.find\(\(h\) => h\.id === housingId\)/,
    );
    expect(housingPage).toMatch(
      /const parentBatch = React\.useMemo\([\s\S]*?\(layerBatches \|\| \[\]\)\.find\(\(b\) => b\.id === bid\)/,
    );
    expect(housingPage).not.toContain(".eq('id', housingId).maybeSingle()");
  });
  it('renders the title through the shared RecordTitle', () => {
    // data-record-title now lives in RecordPageShell's RecordTitle.
    expect(housingPage).toContain('<RecordTitle');
  });
  it('renders RecordCollaborationSection with layer.housing entityType', () => {
    expect(housingPage).toContain('RecordCollaborationSection');
    expect(housingPage).toContain('entityType="layer.housing"');
  });
  it('does not use ActivityPanel or ActivityModal', () => {
    expect(housingPage).not.toContain('ActivityPanel');
    expect(housingPage).not.toContain('ActivityModal');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(housingPage).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(housingPage).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(housingPage).toContain('location.hash');
    expect(housingPage).toContain('scrollIntoView');
  });
  it('has back link to parent batch when available, otherwise to /layer/batches', () => {
    expect(housingPage).toContain("'/layer/batches/' + parentBatch.id");
    expect(housingPage).toContain("'/layer/batches'");
  });
  it('has housing-not-found state', () => {
    expect(housingPage).toContain('Housing not found');
  });
  it('uses extracted layerBatchStats helpers (no inline re-implementation)', () => {
    expect(housingPage).toMatch(/from\s+['"]\.\/layerBatchStats\.js['"]/);
    expect(housingPage).toContain('computeHousingStats');
  });
});

describe('LayerHousingPage — metadata edit + retire preserve existing semantics', () => {
  it('has Edit Housing button gated on canEdit', () => {
    expect(housingPage).toContain('data-layer-housing-edit');
    expect(housingPage).toMatch(/canEdit[\s\S]*?data-layer-housing-edit/);
  });
  it('renders the housing form modal with autosave', () => {
    expect(housingPage).toContain('data-layer-housing-form-modal');
    expect(housingPage).toContain('scheduleHousingAutosave');
    expect(housingPage).toContain('Auto-saves as you type');
  });
  it('preserves current_count + current_count_date stamping logic', () => {
    expect(housingPage).toContain('current_count');
    expect(housingPage).toContain('current_count_date');
    expect(housingPage).toContain('Will be stamped');
  });
  it('has Retire button gated on canEdit and active status', () => {
    expect(housingPage).toContain('data-layer-housing-retire');
    expect(housingPage).toMatch(/canEdit[\s\S]*?data-layer-housing-retire/);
    expect(housingPage).toMatch(/isActive[\s\S]*?data-layer-housing-retire/);
  });
  it('does not log record.deleted Activity', () => {
    expect(housingPage).not.toContain("eventType: 'record.deleted'");
  });
  it('Retire button asks for confirmation via window._wcfConfirm before retiring', () => {
    expect(housingPage).toContain('window._wcfConfirm');
    expect(housingPage).toMatch(/onClick=\{confirmRetire\}/);
    expect(housingPage).toMatch(/confirmRetire[\s\S]*?window\._wcfConfirm\(/);
    expect(housingPage).toMatch(/_wcfConfirm\([^)]*?'Retire/);
  });
});

describe('LayerBatchPage + LayerHousingPage — setLayerHousings shape', () => {
  // main.jsx passes setLayerHousings: persistLayerHousings, which expects a
  // concrete next array so it can call syncWebformConfig(...) with it. A
  // function-updater would store the function instead of the array and
  // break housing_batch_map / full_config sync.
  it('LayerBatchPage never calls setLayerHousings with a function updater', () => {
    expect(batchPage).not.toMatch(/setLayerHousings\(\s*\(/);
  });
  it('LayerHousingPage never calls setLayerHousings with a function updater', () => {
    expect(housingPage).not.toMatch(/setLayerHousings\(\s*\(/);
  });
  it('LayerBatchPage computes next array from the layerHousings prop before calling setLayerHousings', () => {
    expect(batchPage).toMatch(
      /const nextHousings\s*=\s*\(layerHousings \|\| \[\]\)[\s\S]*?setLayerHousings\(nextHousings\)/,
    );
  });
  it('LayerHousingPage computes next array from the layerHousings prop before calling setLayerHousings', () => {
    expect(housingPage).toMatch(
      /const nextHousings\s*=\s*\(layerHousings \|\| \[\]\)[\s\S]*?setLayerHousings\(nextHousings\)/,
    );
  });
});

describe('Layer readiness markers — CI determinism (see helpers/layerReady.js)', () => {
  it('hub exposes data-layer-batches-loaded keyed on its load state', () => {
    expect(listSrc).toMatch(/data-layer-batches-loaded=\{loading \|\| loadError \? 'false' : 'true'\}/);
  });
  it('batch record page exposes data-layer-batch-record-loaded only on the loaded body', () => {
    // Marker rides RecordPageBody, which only renders past the loading/not-found guards.
    expect(batchPage).toMatch(/<RecordPageBody[^>]*data-layer-batch-record-loaded="true"/);
  });
  it('housing record page exposes data-layer-housing-record-loaded only on the loaded body', () => {
    expect(housingPage).toMatch(/<RecordPageBody[^>]*data-layer-housing-record-loaded="true"/);
  });
});

describe('LayerBatchesView — cleaned hub', () => {
  it('has LayerBatchesRouter that delegates to LayerBatchPage and LayerHousingPage', () => {
    expect(listSrc).toContain('LayerBatchesRouter');
    expect(listSrc).toContain('LayerBatchPage');
    expect(listSrc).toContain('LayerHousingPage');
    expect(listSrc).toContain("location.pathname.startsWith('/layer/batches/')");
    expect(listSrc).toContain("location.pathname.startsWith('/layer/housings/')");
  });
  it('tiles navigate to /layer/batches/<id>', () => {
    // Cards -> unified grid: the row click navigates to /layer/batches/<id>
    // using the renamed grid row var (batch -> row), still carrying the
    // SORTED set (batchSeqRows) as the record-sequence order.
    expect(listSrc).toContain("navigate('/layer/batches/' + row.id");
  });
  it('no inline selected-batch workspace remains', () => {
    expect(listSrc).not.toContain('selectedBatchId');
    expect(listSrc).not.toContain('batchHousings');
    expect(listSrc).not.toContain('PERFORMANCE SUMMARY');
    expect(listSrc).not.toContain('LIFECYCLE PHASES');
  });
  it('no inline housing workspace remains', () => {
    expect(listSrc).not.toContain('showHousingForm');
    expect(listSrc).not.toContain('retireHousing');
  });
  it('does not import or render ActivityPanel/ActivityModal', () => {
    expect(listSrc).not.toContain('ActivityPanel');
    expect(listSrc).not.toContain('ActivityModal');
  });
  it('does not listen for wcf-entity-deep-link', () => {
    expect(listSrc).not.toContain('wcf-entity-deep-link');
  });
  it('still has + New Batch helper modal (admin/management only)', () => {
    expect(listSrc).toContain('data-layer-new-batch-modal');
    expect(listSrc).toMatch(/canEdit[\s\S]*?\+ New Batch/);
  });
  it('+ New Batch helper inserts shell and navigates to /layer/batches/<id>', () => {
    expect(listSrc).toMatch(/saveNewBatch[\s\S]*?navigate\('\/layer\/batches\/' \+ id\)/);
  });
  it('pendingEdit deep-link from timeline navigates to /layer/batches/<id>', () => {
    expect(listSrc).toMatch(/pendingEdit[\s\S]*?navigate\('\/layer\/batches\/' \+ id\)/);
  });
});

describe('Layer cold-boot readiness required metric reads', () => {
  it('hub throws on layer_dailys / egg_dailys query errors instead of caching empty metrics', () => {
    expect(listSrc).toMatch(/if \(error\) \{\s*throw new Error\(`\$\{table\}: \$\{error\.message\}`\);/);
    expect(listSrc).toContain("setLoadError({kind: 'error', message: 'Could not load layer batch metrics: '");
  });

  it('hub clears stale metric state and blocks metric-backed tiles while loadError is active', () => {
    expect(listSrc).toMatch(/setRawLayerDailys\(\[\]\);\s*\n\s*setRawEggDailys\(\[\]\);/);
    // Cards -> unified grid: the metric-backed tile block is the inspection grid,
    // still gated on !loading && !loadError (the redesign added a sorted.length > 0
    // clause so an empty filtered set falls through to the shared empty state).
    expect(listSrc).toMatch(/!loading && !loadError && sorted\.length > 0 && \(/);
    expect(listSrc).toContain("data-layer-batches-loaded={loading || loadError ? 'false' : 'true'}");
  });

  it('batch record page renders a retryable load-error state before not-found/record content', () => {
    const loadErrorIdx = batchPage.indexOf('if (loadError)');
    const notFoundIdx = batchPage.indexOf('if (!batch)');
    expect(loadErrorIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(loadErrorIdx);
    expect(batchPage).toContain("from '../shared/RecordPageLoadError.jsx'");
    expect(batchPage).toContain('data-layer-batch-load-error="true"');
    expect(batchPage).toMatch(/<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
    expect(batchPage).toMatch(/<RecordPageLoadError[\s\S]*onRetry=\{loadAll\}/);
  });

  it('housing record page renders a retryable load-error state before not-found/record content', () => {
    const loadErrorIdx = housingPage.indexOf('if (loadError)');
    const notFoundIdx = housingPage.indexOf('if (!housing)');
    expect(loadErrorIdx).toBeGreaterThan(-1);
    expect(notFoundIdx).toBeGreaterThan(loadErrorIdx);
    expect(housingPage).toContain("from '../shared/RecordPageLoadError.jsx'");
    expect(housingPage).toContain('data-layer-housing-load-error="true"');
    expect(housingPage).toMatch(/<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
    expect(housingPage).toMatch(/<RecordPageLoadError[\s\S]*onRetry=\{loadAll\}/);
  });
});

describe('Eggmobile 3 / layer housing live-count display (Build Queue item 10)', () => {
  // Defect: an active housing whose current_count is a stale/empty 0 (e.g. Eggmobile 3
  // in L-25-01) must not present "Physical: 0" as the meaningful farm count. Both record
  // surfaces drive the headline hen figure from computeProjectedCount, which falls back to
  // the latest positive daily count as the anchor and subtracts mortalities since.
  for (const [name, src] of [
    ['LayerBatchPage', batchPage],
    ['LayerHousingPage', housingPage],
  ]) {
    it(`${name} surfaces a Live hens figure from computeProjectedCount, not a bare Physical current_count`, () => {
      expect(src, name).toContain('Live hens:');
      expect(src, name).toMatch(/const proj = computeProjectedCount/);
      expect(src, name).toMatch(/liveHens\s*=\s*proj\s*\?\s*proj\.projected/);
      // the old misleading "Physical: <raw current_count>" headline is gone
      expect(src, `${name} still renders a bare Physical: current_count headline`).not.toMatch(/Physical:\{' '\}/);
    });
  }
});
