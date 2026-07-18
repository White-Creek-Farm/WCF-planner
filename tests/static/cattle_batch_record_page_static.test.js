import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pageSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchPage.jsx'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleBatchesView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const registrySrc = fs.readFileSync(path.join(ROOT, 'src/lib/activityRegistry.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('main.jsx — /cattle/batches/<id> route', () => {
  it('detects isCattleBatchesSubpath', () => {
    expect(mainSrc).toContain("location.pathname.startsWith('/cattle/batches/')");
  });
  it('maps subpath to cattlebatches view', () => {
    expect(mainSrc).toContain('isCattleBatchesSubpath');
    expect(mainSrc).toContain("? 'cattlebatches'");
  });
  it('guards subpath from view-to-URL clobber', () => {
    expect(mainSrc).toContain("view === 'cattlebatches' && location.pathname.startsWith('/cattle/batches/')");
  });
});

describe('activityRegistry — cattle.processing route', () => {
  it('routes cattle.processing to /cattle/batches/<id>', () => {
    expect(registrySrc).toMatch(/CATTLE_PROCESSING[\s\S]*?route:\s*\(id\)\s*=>\s*'\/cattle\/batches\/'\s*\+\s*id/);
  });
  it('routeToView handles /cattle/batches/ subpath', () => {
    expect(registrySrc).toContain("path.startsWith('/cattle/batches/')");
  });
});

describe('Header — direct-route allowlist', () => {
  it('includes /cattle/batches/ in record-page route check', () => {
    expect(headerSrc).toContain("route.startsWith('/cattle/batches/')");
  });
});

describe('CattleBatchPage — record page structure', () => {
  it('loads cattle_processing_batches by id', () => {
    expect(pageSrc).toContain("from('cattle_processing_batches')");
    expect(pageSrc).toContain(".eq('id', batchId)");
  });
  it('renders the title through the shared RecordTitle', () => {
    // data-record-title now lives in RecordPageShell's RecordTitle.
    expect(pageSrc).toContain('<RecordTitle');
  });
  it('renders RecordCollaborationSection with cattle.processing entityType', () => {
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(pageSrc).toContain('entityType="cattle.processing"');
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
  it('has back link to /cattle/batches', () => {
    expect(pageSrc).toContain("navigate('/cattle/batches')");
    expect(pageSrc).toContain('Back to Processing Batches');
  });
  it('has batch-not-found state', () => {
    expect(pageSrc).toContain('Batch not found');
  });
});

describe('CattleBatchPage — scheduled batch support', () => {
  it('shows scheduled date editor', () => {
    expect(pageSrc).toContain('data-scheduled-batch-date');
    expect(pageSrc).toContain('handleUpdateScheduledDate');
  });
  it('has unschedule flow with two-step confirmation', () => {
    expect(pageSrc).toContain('data-scheduled-batch-unschedule');
    expect(pageSrc).toContain('data-scheduled-batch-unschedule-warning');
    expect(pageSrc).toContain('data-scheduled-batch-unschedule-confirm');
    expect(pageSrc).toContain('Confirm unschedule');
  });
  it('unschedule only works for scheduled status', () => {
    expect(pageSrc).toMatch(/handleUnschedule[\s\S]*?status !== 'scheduled'/);
  });
  it('navigates back to list after unschedule', () => {
    expect(pageSrc).toMatch(/handleUnschedule[\s\S]*?navigate\('\/cattle\/batches'\)/);
  });
  it('unschedules via the audited SECDEF RPC wrapper (migration 100), not a direct delete', () => {
    // The unaudited sb.from('cattle_processing_batches').delete() is gone; the
    // unschedule routes through the transactional RPC that logs record.deleted.
    expect(pageSrc).toContain('unscheduleCattleProcessingBatch');
    expect(pageSrc).toMatch(/handleUnschedule[\s\S]*?unscheduleCattleProcessingBatch/);
    expect(pageSrc).not.toMatch(/cattle_processing_batches'\)\s*\.delete\(/);
  });
});

describe('CattleBatchPage — active/complete batch support', () => {
  it('has rename with validation via blur save', () => {
    expect(pageSrc).toContain('handleSaveRename');
    expect(pageSrc).toContain('validateRealBatchRename');
    expect(pageSrc).toContain('data-rename-input');
    expect(pageSrc).toContain('onBlur={handleSaveRename}');
  });
  it('does not have a Save name button', () => {
    expect(pageSrc).not.toContain('Save name');
    expect(pageSrc).not.toContain('data-save-rename');
  });
  it('name input is hidden when batch is complete', () => {
    expect(pageSrc).toMatch(/!isComplete[\s\S]*?data-rename-input/);
  });
  it('has hanging weight editing', () => {
    expect(pageSrc).toContain('data-batch-hanging-weight');
    expect(pageSrc).toContain('data-batch-live-weight');
    expect(pageSrc).toContain('saveCowWeight');
  });
  it('weight inputs are disabled when batch is complete', () => {
    expect(pageSrc).toMatch(/weightDisabled\s*=\s*!canEdit \|\| isComplete/);
    expect(pageSrc).toMatch(/disabled=\{weightDisabled\}[\s\S]*?data-batch-live-weight/);
    expect(pageSrc).toMatch(/disabled=\{weightDisabled\}[\s\S]*?data-batch-hanging-weight/);
  });
  it('disabled weight inputs have legible styling for mobile/iOS', () => {
    expect(pageSrc).toContain('opacity: 1');
    expect(pageSrc).toContain("WebkitTextFillColor: '#111827'");
    expect(pageSrc).toContain('minWidth: 70');
  });
  it('has mark complete and reopen', () => {
    expect(pageSrc).toContain('data-mark-complete');
    expect(pageSrc).toContain('data-reopen');
    expect(pageSrc).toContain('handleMarkComplete');
    expect(pageSrc).toContain('handleReopen');
  });
  it('has auto-complete on last hanging weight', () => {
    expect(pageSrc).toContain('batchHasAllHangingWeights');
    expect(pageSrc).toContain('markBatchComplete');
  });
  it('saveCowWeight checks update result and blocks auto-complete on failure', () => {
    expect(pageSrc).toMatch(/saveCowWeight[\s\S]*?\{error\}[\s\S]*?if \(error\)[\s\S]*?return[\s\S]*?setBatch/);
  });
  it('has cow detach via the audited SECDEF RPC wrapper', () => {
    expect(pageSrc).toContain('handleDetach');
    // Detach now goes through the transactional RPC wrapper (migration 081),
    // which logs Activity atomically — the page no longer calls the
    // detachCowFromBatch client helper.
    expect(pageSrc).toContain('detachCattleFromProcessingBatch');
    expect(pageSrc).not.toContain('detachCowFromBatch');
    expect(pageSrc).toContain('data-batch-cow-row');
  });
  it('logs Activity for complete, reopen, rename, and date edit (detach logs in the RPC)', () => {
    expect(pageSrc).toContain('recordStatusChange');
    expect(pageSrc).toContain('recordActivityEvent');
    expect(pageSrc).toMatch(/handleMarkComplete[\s\S]*?logStatus/);
    expect(pageSrc).toMatch(/handleReopen[\s\S]*?logStatus/);
    expect(pageSrc).toMatch(/handleSaveRename[\s\S]*?logEvent[\s\S]*?Renamed/);
    expect(pageSrc).toMatch(/handleUpdateScheduledDate[\s\S]*?logEvent[\s\S]*?Scheduled date/);
    // The detach handler no longer logs a best-effort client Activity event —
    // the RPC writes the "Detached #TAG from batch" event in the same txn.
    expect(pageSrc).not.toContain("'Detached #'");
  });
  it('shows stats: live weight, hanging weight, yield, cost', () => {
    expect(pageSrc).toContain('Live wt total');
    expect(pageSrc).toContain('Hanging wt');
    expect(pageSrc).toContain('Yield');
    expect(pageSrc).toContain('Cost');
  });
  it('shows each cow age at the batch processing date', () => {
    expect(pageSrc).toContain('function ageAtProcessing');
    expect(pageSrc).toContain('const batchProcessDate = batch.actual_process_date || batch.planned_process_date');
    expect(pageSrc).toContain('const processingAge = ageAtProcessing(cow?.birth_date, batchProcessDate)');
    expect(pageSrc).toContain('data-batch-cow-processing-age');
    expect(pageSrc).toContain("'Age at processing ' + processingAge");
  });
});

describe('CattleBatchesView — cleaned list view', () => {
  it('has CattleBatchesRouter that delegates to record page', () => {
    expect(listSrc).toContain('CattleBatchesRouter');
    expect(listSrc).toContain('CattleBatchPage');
  });
  it('real batch tiles navigate to /cattle/batches/<id>', () => {
    expect(listSrc).toContain("navigate('/cattle/batches/' + b.id");
  });
  it('scheduled batch tiles navigate to /cattle/batches/<id>', () => {
    expect(listSrc).toContain("'/cattle/batches/' + sb2.id");
  });
  it('does not have expandedBatchId state', () => {
    expect(listSrc).not.toContain('expandedBatchId');
  });
  it('does not have BatchTile component', () => {
    expect(listSrc).not.toContain('function BatchTile');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(listSrc).not.toContain('ActivityPanel');
    expect(listSrc).not.toContain('ActivityModal');
  });
  it('does not have cow editing state', () => {
    expect(listSrc).not.toContain('cowDraft');
    expect(listSrc).not.toContain('saveCowWeight');
  });
  it('still has virtual planned section with schedule action', () => {
    expect(listSrc).toContain('data-virtual-batch');
    expect(listSrc).toContain('scheduleVirtualBatch');
  });
  it('still has status filter (planned, scheduled, active, processed)', () => {
    expect(listSrc).toContain('data-cattle-batches-root');
    expect(listSrc).toContain('scheduled');
    expect(listSrc).toContain('active');
    expect(listSrc).toContain('processed');
  });
  it('schedule navigates to record page', () => {
    expect(listSrc).toMatch(/scheduleVirtualBatch[\s\S]*?navigate\('\/cattle\/batches\/' \+ rowId\)/);
  });
});

describe('CattleBatchesView - cold-boot readiness', () => {
  const loadAllMatch = listSrc.match(/async function loadAll\(\)[\s\S]*?\n\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the hub in Loading when a boot read rejects', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('exposes a readiness marker keyed on loading or loadError', () => {
    expect(listSrc).toMatch(/data-cattle-batches-loaded=\{loading \|\| loadError \? 'false' : 'true'\}/);
  });

  it('surfaces essential processing read errors and clears stale state', () => {
    expect(listSrc).toContain('const [loadError, setLoadError] = useState(null);');
    expect(loadAllSrc).toContain("throw new Error('cattle_processing_batches: '");
    expect(loadAllSrc).toContain("throw new Error('cattle: '");
    expect(loadAllSrc).toContain("throw new Error('cattle_calving_records: '");
    expect(loadAllSrc).toContain('Could not load cattle processing batches. Please refresh the page.');
    expect(loadAllSrc).toContain('setBatches([]);');
    expect(loadAllSrc).toContain('setCattle([]);');
    expect(loadAllSrc).toContain('setWeighIns([]);');
    expect(loadAllSrc).toContain('setCalvingRecs([]);');
  });

  it('keeps load failures non-dismissible with a retry action and blocks hub sections', () => {
    expect(listSrc).toContain('<InlineNotice notice={loadError} />');
    expect(listSrc).toMatch(/\{loadError && \([\s\S]*?onClick=\{loadAll\}[\s\S]*?Retry/);
    expect(listSrc).toMatch(/!loading && !loadError && \(/);
    // The consolidated Planned section is gated on load success like every
    // other pipeline section.
    expect(listSrc).toMatch(/!loading && !loadError && \([\s\S]*?data-planned-section/);
  });

  it('degrades forecast sidecar failures without blocking real batch rows', () => {
    expect(loadAllSrc).toContain('forecastSidecarErrors');
    expect(loadAllSrc).toMatch(/loadForecastSettings\(sb\)\.catch[\s\S]*?return null;/);
    expect(loadAllSrc).toMatch(/loadHeiferIncludes\(sb\)\.catch[\s\S]*?return new Set\(\);/);
    expect(loadAllSrc).toMatch(/loadHidden\(sb\)\.catch[\s\S]*?return \[\];/);
    expect(loadAllSrc).toContain('Planned batches may be unavailable until refresh.');
  });
});

describe('Consolidated Planned pipeline + projected rosters — canonical adapter locks', () => {
  const forecastPageSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleForecastBatchPage.jsx'), 'utf8');
  const drawerSrc = fs.readFileSync(path.join(ROOT, 'src/processing/ProcessingDrawer.jsx'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleForecastApi.js'), 'utf8');
  const rosterTableSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/ProjectedRosterTable.jsx'), 'utf8');

  it('one Planned section: chronological merge, Forecast/Scheduled chips, no per-row PLANNED badge', () => {
    expect(listSrc).toContain('data-planned-section');
    expect(listSrc).not.toContain('Show Planned Batches');
    expect(listSrc).toContain('const plannedRows = [');
    expect(listSrc).toContain("sortKey: row.monthKey + '-15'");
    // Scheduled rows no longer render the status-label badge ("Planned") —
    // the section heading owns lifecycle; rows carry scheduling-state chips.
    expect(listSrc).not.toMatch(/processingStatusLabel\(sb2\.status\)/);
    expect(listSrc).toMatch(/data-planned-row="scheduled"/);
    expect(listSrc).toMatch(/data-planned-row="forecast"/);
  });

  it('forecast rows open a real route-backed detail keyed by stable monthKey', () => {
    expect(listSrc).toContain("navigate('/cattle/batches/forecast/' + vb.monthKey)");
    expect(listSrc).toContain("location.pathname.startsWith('/cattle/batches/forecast/')");
  });

  it('scheduled batch page renders the PROJECTED roster through the canonical loader, fail-closed', () => {
    expect(pageSrc).toContain('loadProjectedRosterForScheduledBatch');
    expect(pageSrc).toContain('data-scheduled-projected-roster');
    expect(pageSrc).toContain('data-projected-roster-unavailable');
    expect(pageSrc).toContain('ProjectedRosterTable');
    // Rendered ONLY for scheduled batches — actual rosters never mix with
    // projections on active/complete pages.
    expect(pageSrc).toMatch(/\{isScheduled && \([\s\S]*?data-scheduled-projected-roster/);
    expect(pageSrc).toMatch(/batch\.status !== 'scheduled'[\s\S]*?setProjectedRoster\(null\)/);
  });

  it('forecast-only detail reconstructs from live data and never masquerades as a record', () => {
    expect(forecastPageSrc).toContain('loadCattleForecastBundle');
    expect(forecastPageSrc).toContain('projectPlannedRoster');
    expect(forecastPageSrc).toContain('parseMonthKey');
    // Scheduled month points at the persisted record instead of a shadow copy.
    expect(forecastPageSrc).toContain('data-forecast-batch-scheduled-pointer');
    // Fail-closed empty state, no fabricated cohort.
    expect(forecastPageSrc).toContain('data-forecast-batch-empty');
    // Not a persisted record page: no collaboration stream, no direct table
    // access (all data arrives through the shared bundle loader).
    expect(forecastPageSrc).not.toContain('RecordCollaborationSection');
    expect(forecastPageSrc).not.toMatch(/from\('cattle_processing_batches'\)/);
  });

  it('Processing Drawer cattle source falls back to the canonical projected roster', () => {
    expect(drawerSrc).toContain('loadProjectedRosterForScheduledBatch');
    expect(drawerSrc).toContain('CattleProjectedSourceRoster');
    expect(drawerSrc).toMatch(/kind === 'cattle' \? \([\s\S]*?CattleProjectedSourceRoster/);
    expect(drawerSrc).toContain('data-processing-projected-roster');
    expect(drawerSrc).toContain('data-processing-projected-unavailable');
    // Non-scheduled empty batches keep the classic truthful copy.
    expect(drawerSrc).toContain('No animals recorded on the source batch.');
  });

  it('no surface duplicates the forecast math — projection flows through the shared loader/adapter only', () => {
    // The loader composes the canonical helpers…
    expect(apiSrc).toContain('loadCattleWeighInsCached(sb, {throwOnError: true})');
    expect(apiSrc).toMatch(/loadProjectedRosterForScheduledBatch[\s\S]*?dateToMonthKey[\s\S]*?projectPlannedRoster/);
    // …and no consuming surface re-implements eligibility/ADG/projection.
    for (const src of [pageSrc, drawerSrc, forecastPageSrc, rosterTableSrc]) {
      expect(src).not.toMatch(/projectedWeightAtMonth|computeLast[23]ADG|snapToNearestMilestone|buildForecast\(\{/);
    }
    // The shared table imports ONLY the shared age formatter from the
    // forecast module — no selection/projection math.
    expect(rosterTableSrc).toMatch(/import \{formatAgeAtDate\} from '\.\.\/lib\/cattleForecast\.js'/);
  });

  it('Age at processing: one shared formatter, exact planned date, both surfaces identical', () => {
    // The canonical roster row carries the cow's birth date (null = never guess).
    const forecastLibSrc = fs.readFileSync(path.join(ROOT, 'src/lib/cattleForecast.js'), 'utf8');
    expect(forecastLibSrc).toMatch(/birthDate: r\.cow\.birth_date \|\| null/);
    // Shared table renders the column only when the EXACT planned date is
    // provided, via formatAgeAtDate with the canonical Not recorded fallback.
    expect(rosterTableSrc).toContain('Age at processing');
    expect(rosterTableSrc).toMatch(/formatAgeAtDate\(r\.birthDate, processDate\) \|\| 'Not recorded'/);
    // Cattle batch page anchors the column to the batch's planned date.
    expect(pageSrc).toContain('processDate={batch.planned_process_date}');
    // Processing drawer uses the SAME helper with the SAME date source.
    expect(drawerSrc).toMatch(/formatAgeAtDate\(a\.birthDate, state\.processDate\)/);
    expect(drawerSrc).toMatch(/processDate: r\.batch\.planned_process_date/);
    expect(drawerSrc).toContain("label: 'Age at processing'");
    // The forecast-only detail has no exact date (monthKey identity) and
    // must NOT fabricate ages from a bare month.
    expect(forecastPageSrc).not.toContain('processDate=');
  });
});

describe('CattleBatchPage - cold-boot readiness', () => {
  const loadAllMatch = pageSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}React\.useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the cattle processing record page in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('keeps missing batches as not-found while surfacing real read failures', () => {
    expect(loadAllSrc).toContain(".eq('id', batchId).maybeSingle()");
    expect(loadAllSrc).toContain("throw new Error('cattle_processing_batches: '");
    expect(loadAllSrc).toContain("throw new Error('cattle: '");
    expect(loadAllSrc).toContain("throw new Error('cattle_processing_batches list: '");
    expect(loadAllSrc).toContain('Could not load cattle processing batch');
  });

  it('clears stale record state and renders loadError through InlineNotice', () => {
    expect(loadAllSrc).toContain('setBatch(null);');
    expect(loadAllSrc).toContain('setCattle([]);');
    expect(loadAllSrc).toContain('setAllBatches([]);');
    expect(loadAllSrc).toContain("setRenameDraft('');");
    expect(loadAllSrc).toContain("setScheduledDateDraft('');");
    expect(pageSrc).toContain("from '../shared/RecordPageLoadError.jsx'");
    expect(pageSrc).toMatch(/if \(loadError\)[\s\S]*?<RecordPageLoadError[\s\S]*notice=\{loadError\}/);
    expect(pageSrc).toMatch(/<RecordPageLoadError[\s\S]*onRetry=\{loadAll\}/);
  });

  it('exposes a loaded marker only on the resolved record body', () => {
    expect(pageSrc).toMatch(/<RecordPageBody[^>]*data-cattle-batch-record-loaded="true"/);
  });
});
