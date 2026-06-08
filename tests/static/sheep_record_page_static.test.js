import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const flocksView = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepFlocksView.jsx'), 'utf8');
const animalPage = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepAnimalPage.jsx'), 'utf8');
const sheepDetail = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDetail.jsx'), 'utf8');
const collapsible = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepCollapsibleOutcomeSections.jsx'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registry = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const savedViewsApi = fs.readFileSync(path.join(ROOT, 'src/lib/savedViewsApi.js'), 'utf8');
const csvExport = fs.readFileSync(path.join(ROOT, 'src/lib/csvExport.js'), 'utf8');

describe('SheepFlocksView - saved views', () => {
  it('uses the shared saved-views API on the sheep.flocks surface', () => {
    expect(flocksView).toContain("from '../lib/savedViewsApi.js'");
    expect(flocksView).toContain("SHEEP_FLOCKS_SURFACE_KEY = 'sheep.flocks'");
    expect(flocksView).toContain('listSavedViews(sb, SHEEP_FLOCKS_SURFACE_KEY)');
    expect(flocksView).toContain('createSavedView(sb');
    expect(flocksView).toContain('updateSavedView(sb');
    expect(flocksView).toContain('deleteSavedView(sb');
    expect(savedViewsApi).toContain("from('app_saved_views')");
  });

  it('captures and reapplies only the current sheep search/status/sort controls', () => {
    expect(flocksView).toContain('function sheepFlocksViewState()');
    expect(flocksView).toContain('search: search ||');
    expect(flocksView).toContain('statusFilter: statusFilter ||');
    expect(flocksView).toContain('sortBy: sortBy ||');
    expect(flocksView).toContain('function applySheepSavedView(view)');
    expect(flocksView).toContain('setSearch(typeof st.search');
    expect(flocksView).toContain('setStatusFilter(validStatuses.has(st.statusFilter)');
    expect(flocksView).toContain('setSortBy(validSorts.has(st.sortBy)');
  });

  it('renders select/save/update/delete controls with sheep-specific hooks', () => {
    for (const marker of [
      'data-sheep-saved-views-row',
      'data-sheep-saved-view-select',
      'data-sheep-saved-view-save',
      'data-sheep-saved-view-update',
      'data-sheep-saved-view-delete',
      'data-sheep-saved-view-visibility',
    ]) {
      expect(flocksView).toContain(marker);
    }
  });

  it('saved-view load failures degrade without blocking the sheep hub', () => {
    expect(flocksView).toContain('savedViewsError');
    expect(flocksView).toContain('data-sheep-saved-views-error');
    expect(flocksView).toMatch(/\{!loadError && \(\s*<>[\s\S]*?data-sheep-saved-views-row[\s\S]*?Top toolbar/);
  });
});

describe('SheepFlocksView - CSV export', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain("import {centralISOFor} from './dateUtils.js'");
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
    expect(csvExport).toContain('URL.revokeObjectURL');
    expect(csvExport).toContain("type: 'text/csv;charset=utf-8'");
    expect(csvExport).toContain('centralISOFor(date)');
  });

  it('exports the current filtered + sorted sheep rows, not the raw sheep list', () => {
    expect(flocksView).toContain("from '../lib/csvExport.js'");
    expect(flocksView).toContain('function handleExportCsv');
    expect(flocksView).toContain('data-sheep-flocks-export-csv="1"');
    expect(flocksView).toContain('rowsToCsv(columns, sorted)');
    expect(flocksView).not.toContain('rowsToCsv(columns, sheep)');
  });

  it('keeps export disabled while the flock list is loading or failed', () => {
    expect(flocksView).toContain('disabled={loading || loadError}');
    expect(flocksView).toContain("cursor: loading || loadError ? 'not-allowed' : 'pointer'");
  });

  it('keeps sheep export columns useful for flock-list decisions', () => {
    for (const header of [
      'Tag',
      'Flock',
      'Sex',
      'Breed',
      'Origin',
      'Last weight lbs',
      'Last weighed',
      'Last lambed',
      'Lamb count',
      'Dam tag',
      'Sire tag',
      'Record ID',
    ]) {
      expect(flocksView).toContain(`header: '${header}'`);
    }
  });
});

describe('SheepFlocksView — no legacy Activity or inline SheepDetail', () => {
  it('does not import ActivityPanel', () => {
    expect(flocksView).not.toMatch(/^import ActivityPanel/m);
  });
  it('does not import ActivityModal', () => {
    expect(flocksView).not.toMatch(/^import ActivityModal/m);
  });
  it('does not render SheepDetail inline', () => {
    expect(flocksView).not.toMatch(/<SheepDetail\b/);
  });
  it('does not have expandedSheep state', () => {
    expect(flocksView).not.toContain('setExpandedSheep');
  });
  it('does not have sheepNavStack state', () => {
    expect(flocksView).not.toContain('sheepNavStack');
  });
  it('does not query sheep_comments', () => {
    expect(flocksView).not.toContain("from('sheep_comments').select('*')");
  });
  it('navigates to /sheep/flocks/<id> on tile click', () => {
    expect(flocksView).toContain("navigate('/sheep/flocks/' + s.id");
  });
  it('passes the visible-order sequence through route state on row click (flat + tile)', () => {
    // Flat mode hands the sorted order; tile mode hands the per-flock
    // flockSheep order. Both feed RecordSequenceNav on the record page.
    expect(flocksView).toContain('recordSeqNavOptions(sorted)');
    expect(flocksView).toContain('recordSeqNavOptions(flockSheep)');
    expect(flocksView).toContain("from '../lib/recordSequence.js'");
  });
  it('imports SheepAnimalPage for hub routing', () => {
    expect(flocksView).toContain('SheepAnimalPage');
  });
  it('parses /sheep/flocks/<id> from URL', () => {
    expect(flocksView).toContain('/sheep/flocks/');
  });
  it('passes Header to SheepAnimalPage', () => {
    expect(flocksView).toContain('Header: props.Header');
  });
});

describe('SheepFlocksView - cold-boot readiness', () => {
  const loadAllMatch = flocksView.match(/async function loadAll\(\)[\s\S]*?\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('fails closed on required hub read errors', () => {
    expect(flocksView).toContain("import {loadSheepWeighInsCached} from '../lib/sheepCache.js'");
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
    expect(loadAllSrc).toContain('loadSheepWeighInsCached(sb, {throwOnError: true})');
    for (const table of ['sheep', 'sheep_lambing_records', 'sheep_breeds', 'sheep_origins']) {
      expect(loadAllSrc, `SheepFlocksView must throw on ${table} errors`).toContain(`throw new Error('${table}: ' +`);
    }
    for (const clearCall of [
      'setSheep([]);',
      'setWeighIns([]);',
      'setLambingRecs([]);',
      'setBreedOpts([]);',
      'setOriginOpts([]);',
    ]) {
      expect(loadAllSrc, `SheepFlocksView must clear ${clearCall} on catch`).toContain(clearCall);
    }
  });

  it('exposes loaded/error retry markers and hides loaded hub content under error', () => {
    expect(flocksView).toContain("data-sheep-flocks-loaded={loading || loadError ? 'false' : 'true'}");
    expect(flocksView).toContain('data-sheep-flocks-load-error="true"');
    expect(flocksView).toContain('data-sheep-flocks-load-retry="1"');
    expect(flocksView).toMatch(/data-sheep-flocks-load-retry="1"[\s\S]*?onClick=\{loadAll\}/);
    expect(flocksView).toContain('<InlineNotice notice={loadError} />');
    expect(flocksView).toMatch(/\{!loadError && \(\s*<>[\s\S]*?Top toolbar/);
  });
});

describe('SheepCollapsibleOutcomeSections — no inline SheepDetail', () => {
  it('does not render SheepDetail JSX', () => {
    expect(collapsible).not.toMatch(/<SheepDetail\b/);
  });
  it('does not accept renderSheepDetail prop', () => {
    expect(collapsible).not.toContain('renderSheepDetail');
  });
  it('accepts onSheepClick for navigation', () => {
    expect(collapsible).toContain('onSheepClick');
  });
});

describe('SheepAnimalPage — SheepDetail remount on navigation', () => {
  it('keys SheepDetail by sheep.id to force remount', () => {
    expect(animalPage).toContain('key={animal.id}');
  });
  it('resets state on sheepId change', () => {
    expect(animalPage).toContain('setAnimal(null)');
    expect(animalPage).toContain('setLoading(true)');
  });
});

describe('SheepAnimalPage — app header', () => {
  it('accepts Header prop', () => {
    expect(animalPage).toMatch(/SheepAnimalPage\(\{[^}]*Header/);
  });
  it('renders Header through the shared record-page chrome', () => {
    // The literal {Header && <Header />} now lives in RecordPageShell; the page
    // hands Header to the shared frame/loading/not-found primitives.
    expect(animalPage).toContain('RecordPageFrame');
    expect(animalPage).toContain('Header={Header}');
  });
});

describe('SheepAnimalPage — record page structure', () => {
  it('renders RecordCollaborationSection with sheep.animal', () => {
    expect(animalPage).toContain('RecordCollaborationSection');
    expect(animalPage).toContain('entityType="sheep.animal"');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(animalPage).not.toMatch(/^import ActivityPanel/m);
    expect(animalPage).not.toMatch(/^import ActivityModal/m);
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(animalPage).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(animalPage).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('does not load sheep_comments', () => {
    expect(animalPage).not.toContain("from('sheep_comments')");
  });
  it('passes hideComments to SheepDetail', () => {
    expect(animalPage).toContain('hideComments={true}');
  });
  it('has a back link to /sheep/flocks', () => {
    expect(animalPage).toContain("navigate('/sheep/flocks')");
  });
  it('handles hash anchors for comment deep-links', () => {
    expect(animalPage).toContain('location.hash');
    expect(animalPage).toContain('scrollIntoView');
  });
});

describe('SheepAnimalPage — record page title', () => {
  it('shows tag as the page title', () => {
    expect(animalPage).toContain("animal.tag ? '#' + animal.tag : 'Untagged animal'");
  });
  it('renders the title through the shared RecordTitle', () => {
    // The data-record-title marker now lives in RecordPageShell's RecordTitle.
    expect(animalPage).toContain('<RecordTitle>');
  });
});

describe('SheepAnimalPage — record sequence navigation', () => {
  it('renders the shared RecordSequenceNav', () => {
    expect(animalPage).toContain("from '../shared/RecordSequenceNav.jsx'");
    expect(animalPage).toContain('<RecordSequenceNav');
  });
  it('reads the sequence from route state', () => {
    expect(animalPage).toContain('location.state?.recordSeq');
  });
  it('passes currentId + onNavigate to the sequence nav', () => {
    expect(animalPage).toMatch(/<RecordSequenceNav[\s\S]*?currentId=\{sheepId\}[\s\S]*?onNavigate=\{navigateSeq\}/);
  });
  it('navigateSeq carries the sequence forward', () => {
    expect(animalPage).toMatch(
      /navigateSeq[\s\S]*?navigate\('\/sheep\/flocks\/' \+ id, recordSeqNavOptions\(recordSeq\)\)/,
    );
  });
  it('sheep-to-sheep click-through does NOT carry the sequence (controls hide)', () => {
    expect(animalPage).toMatch(
      /navigateToSheep[\s\S]*?state: \{fromSheepId: animal\.id, fromSheepTag: animal\.tag \|\| animal\.id\}/,
    );
  });
});

describe('SheepAnimalPage — sheep-to-sheep navigation state', () => {
  it('does not hard-code canNavigateBack={true}', () => {
    expect(animalPage).not.toContain('canNavigateBack={true}');
  });
  it('derives canNavigateBack from location.state.fromSheepId', () => {
    expect(animalPage).toContain('fromSheepId');
    expect(animalPage).toContain('canNavigateBack={Boolean(fromSheepId)}');
  });
  it('passes fromSheepTag as backToTag', () => {
    expect(animalPage).toContain('backToTag={fromSheepTag}');
  });
  it('navigateToSheep passes route state with source sheep', () => {
    expect(animalPage).toContain('fromSheepId: animal.id');
    expect(animalPage).toContain('fromSheepTag: animal.tag');
  });
});

describe('SheepAnimalPage — delete semantics', () => {
  it('uses admin-only soft delete via RPC, not a hard delete', () => {
    expect(animalPage).not.toContain(".delete().eq('id', animal.id)");
    expect(animalPage).toContain('softDeleteSheepAnimal');
    expect(animalPage).toContain("is('deleted_at', null)");
  });
});

describe('SheepDetail — hideComments prop', () => {
  it('accepts hideComments prop', () => {
    expect(sheepDetail).toContain('hideComments');
  });
  it('labels the legacy section as Issues not Comments Timeline', () => {
    expect(sheepDetail).toContain('>Issues<');
    expect(sheepDetail).not.toContain('>Comments Timeline<');
  });
});

describe('URL adapter — sheep flocks sub-path', () => {
  it('detects /sheep/flocks/<id> as a sub-path', () => {
    expect(mainJsx).toContain("location.pathname.startsWith('/sheep/flocks/')");
  });
  it('preserves /sheep/flocks/<id> in view→URL sync', () => {
    expect(mainJsx).toContain("view === 'sheepflocks' && location.pathname.startsWith('/sheep/flocks/')");
  });
});

describe('activityRegistry — sheep.animal route', () => {
  it('routes to /sheep/flocks/<id> not just /sheep/flocks', () => {
    expect(registry).toMatch(/route:\s*\(id\)\s*=>\s*'\/sheep\/flocks\/'\s*\+\s*id/);
  });
  it('routeToView handles /sheep/flocks/<id> paths', () => {
    expect(registry).toContain("path.startsWith('/sheep/flocks/')");
  });
});

describe('SheepAnimalPage — transactional transfer via RPC', () => {
  it('transferSheep calls the transferSheepAnimal RPC wrapper', () => {
    expect(animalPage).toContain("import {transferSheepAnimal} from '../lib/animalTransferApi.js'");
    expect(animalPage).toMatch(/transferSheep[\s\S]*?transferSheepAnimal\(sb, animal\.id, newFlock/);
  });
  it('transferSheep keeps a client no-op guard when destination matches current flock', () => {
    expect(animalPage).toMatch(/transferSheep[\s\S]*?newFlock === animal\.flock[\s\S]*?return/);
  });
  it('transferSheep no longer does a client update + sheep_transfers insert or the audit warning', () => {
    const fn = animalPage.match(/async function transferSheep\([\s\S]*?\n {2}\}/);
    expect(fn, 'expected transferSheep body').not.toBeNull();
    expect(fn[0]).not.toContain("from('sheep_transfers')");
    expect(fn[0]).not.toMatch(/kind:\s*'warning'/);
  });
});

describe('SheepAnimalPage - cold-boot readiness', () => {
  const loadAllMatch = animalPage.match(/async function loadAll\(\)[\s\S]*?\n {2}React\.useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the sheep animal record page in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('keeps missing sheep rows as not-found while surfacing real read failures', () => {
    expect(loadAllSrc).toContain(".eq('id', sheepId).is('deleted_at', null).maybeSingle()");
    expect(loadAllSrc).toContain("throw new Error('sheep: '");
    expect(loadAllSrc).toContain("throw new Error('sheep list: '");
    expect(loadAllSrc).toContain("throw new Error('sheep_lambing_records: '");
    expect(loadAllSrc).toContain("throw new Error('sheep_breeds: '");
    expect(loadAllSrc).toContain("throw new Error('sheep_origins: '");
    expect(loadAllSrc).toContain('Could not load sheep record');
  });

  it('uses strict sheep weigh-ins cache and clears stale side state on failure', () => {
    expect(animalPage).toContain("import {loadSheepWeighInsCached} from '../lib/sheepCache.js'");
    expect(loadAllSrc).toContain('loadSheepWeighInsCached(sb, {throwOnError: true})');
    expect(loadAllSrc).toContain('setAnimal(null);');
    expect(loadAllSrc).toContain('setAllSheep([]);');
    expect(loadAllSrc).toContain('setWeighIns([]);');
    expect(loadAllSrc).toContain('setLambingRecs([]);');
    expect(loadAllSrc).toContain('setBreedOpts([]);');
    expect(loadAllSrc).toContain('setOriginOpts([]);');
    expect(animalPage).toMatch(/if \(loadError\)[\s\S]*?<InlineNotice notice=\{loadError\}/);
  });

  it('keeps load failures non-dismissible with a retry action', () => {
    expect(animalPage).toContain('data-sheep-animal-load-error="true"');
    expect(animalPage).toContain('<InlineNotice notice={loadError} />');
    expect(animalPage).not.toContain('<InlineNotice notice={loadError} onDismiss');
    expect(animalPage).toMatch(/onClick=\{loadAll\}[\s\S]*?Retry/);
  });

  it('keeps the resolved record body marker used by Playwright helpers', () => {
    expect(animalPage).toContain('data-sheep-animal-page="1"');
  });
});
