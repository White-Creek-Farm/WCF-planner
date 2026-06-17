import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pageSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/WeighInSessionPage.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const listSrc = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleWeighInsView.jsx'), 'utf8');
const sheepListSrc = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepWeighInsView.jsx'), 'utf8');
const livestockSrc = fs.readFileSync(path.join(ROOT, 'src/livestock/LivestockWeighInsView.jsx'), 'utf8');
const weighInSessionTileSrc = fs.readFileSync(path.join(ROOT, 'src/shared/WeighInSessionListTile.jsx'), 'utf8');
const weighInSessionExportsSrc = fs.readFileSync(path.join(ROOT, 'src/lib/weighInSessionExports.js'), 'utf8');
const sheepCacheSrc = fs.readFileSync(path.join(ROOT, 'src/lib/sheepCache.js'), 'utf8');
const csvExport = fs.readFileSync(path.join(ROOT, 'src/lib/csvExport.js'), 'utf8');
const printExport = fs.readFileSync(path.join(ROOT, 'src/lib/printExport.js'), 'utf8');
const savedViewsApi = fs.readFileSync(path.join(ROOT, 'src/lib/savedViewsApi.js'), 'utf8');
// Both pig and cattle/sheep entries now render as dense tables (pig redesign).
// The two render branches are guarded by stable conditions used as slice
// anchors. Pig branch: from the pig table guard to the cattle/sheep table
// guard. Cattle/sheep branch: from the table guard to the reconcile-panel guard
// (the table itself, excluding the Add-entry form + reconcile panel).
const pigEntryBranchStart = pageSrc.indexOf('{isPig && sEntries.length > 0 && (');
const cattleSheepEntryBranchStart = pageSrc.indexOf('{!isPig && sEntries.length > 0 && (');
const cattleSheepEntryBranchEnd = pageSrc.indexOf('{!isPig && pendingReconciles.length > 0 && (');
const pigEntryBranch = pageSrc.slice(pigEntryBranchStart, cattleSheepEntryBranchStart);
const cattleSheepEntryBranch = pageSrc.slice(cattleSheepEntryBranchStart, cattleSheepEntryBranchEnd);
const entryAutosaveStart = pageSrc.indexOf('async function saveEntryDraft');
const entryAutosaveEnd = pageSrc.indexOf('function isEntryLocked', entryAutosaveStart);
const entryAutosaveFunction = pageSrc.slice(entryAutosaveStart, entryAutosaveEnd);

describe('main.jsx — /weigh-in-sessions/<id> route', () => {
  it('detects isWeighInSessionSubpath', () => {
    expect(mainSrc).toContain("location.pathname.startsWith('/weigh-in-sessions/')");
  });
  it('maps subpath to weighinsessions view', () => {
    expect(mainSrc).toContain("'weighinsessions'");
  });
  it('guards subpath from view-to-URL clobber', () => {
    expect(mainSrc).toContain("view === 'weighinsessions' && location.pathname.startsWith('/weigh-in-sessions/')");
  });
  it('imports WeighInSessionPage', () => {
    expect(mainSrc).toContain("import WeighInSessionPage from './livestock/WeighInSessionPage.jsx'");
  });
  it('mounts WeighInSessionPage for weighinsessions view', () => {
    expect(mainSrc).toContain("view === 'weighinsessions'");
    expect(mainSrc).toContain('WeighInSessionPage');
  });
  it('weighinsessions is in VALID_VIEWS', () => {
    expect(mainSrc).toMatch(/VALID_VIEWS\s*=\s*\[[\s\S]*?'weighinsessions'/);
  });
  it('weighinsessions is not single-program-gated (multi-species)', () => {
    expect(mainSrc).not.toMatch(/VIEW_TO_PROGRAM[\s\S]*?weighinsessions:/);
  });
});

describe('WeighInSessionPage — data loading', () => {
  it('loads weigh_in_sessions by ID', () => {
    expect(pageSrc).toContain("from('weigh_in_sessions')");
    expect(pageSrc).toContain(".eq('id', sessionId)");
  });
  it('loads weigh_ins for the session', () => {
    expect(pageSrc).toContain("from('weigh_ins')");
    expect(pageSrc).toContain(".eq('session_id', sessionId)");
  });
  it('loads animal rows with species-specific query (cattle uses deleted_at, sheep does not)', () => {
    expect(pageSrc).toContain("from('cattle').select('*').is('deleted_at', null)");
    expect(pageSrc).toContain("from('sheep').select('*')");
  });
  it('checks species before loading entries and animals', () => {
    expect(pageSrc).toMatch(/species[\s\S]*?!==\s*'cattle'[\s\S]*?!==\s*'sheep'[\s\S]*?return/);
  });
  it('checks program_access before loading entries', () => {
    expect(pageSrc).toContain('canAccessSpecies');
    expect(pageSrc).toContain('program_access');
    expect(pageSrc).toMatch(/canAccessSpecies\(sp\)[\s\S]*?setAccessDenied[\s\S]*?return[\s\S]*?from\('weigh_ins'\)/);
  });
  it('renders access-denied state when program_access denies', () => {
    expect(pageSrc).toContain('accessDenied');
    expect(pageSrc).toContain('data-access-denied');
  });
  it('does not render the collaboration section when access denied', () => {
    expect(pageSrc).toMatch(/accessDenied[\s\S]*?return[\s\S]*?RecordCollaborationSection/);
  });
});

describe('WeighInSessionPage — RecordCollaborationSection', () => {
  it('renders RecordCollaborationSection with weighin.session entityType', () => {
    expect(pageSrc).toContain('RecordCollaborationSection');
    expect(pageSrc).toContain('entityType="weighin.session"');
  });
  it('does not import CommentsSection or RecordActivityLog directly', () => {
    expect(pageSrc).not.toContain("from '../shared/CommentsSection.jsx'");
    expect(pageSrc).not.toContain("from '../shared/RecordActivityLog.jsx'");
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(pageSrc).toContain('location.hash');
    expect(pageSrc).toContain('scrollIntoView');
  });
});

describe('WeighInSessionPage — cattle + sheep + pig + broiler support', () => {
  it('supports cattle, sheep, pig, and broiler; shows unsupported for others', () => {
    expect(pageSrc).toContain("session.species !== 'broiler'");
    expect(pageSrc).toContain('data-unsupported-species');
  });
  it('imports pig metrics formatters', () => {
    expect(pageSrc).toContain('formatAgeRange');
    expect(pageSrc).toContain('formatFeedPerPig');
    expect(pageSrc).toContain('formatGroupAdg');
    expect(pageSrc).toContain('formatAvgWeight');
  });
  it('calls pig_session_metrics RPC for pig sessions', () => {
    expect(pageSrc).toContain('pig_session_metrics');
  });
  it('renders rank-matched per-entry ADG for pig sessions with prior entries', () => {
    expect(pageSrc).toContain('computeRankMatchedPigEntryADG');
    expect(pageSrc).toContain('pigPriorSession');
    expect(pageSrc).toContain('data-pig-entry-adg');
  });
  it('renders previous pig weigh-in weight/date beside the per-entry ADG', () => {
    expect(pageSrc).toContain('data-pig-entry-prior');
    expect(pageSrc).toContain('Prior weigh-in on ');
    expect(pageSrc).toContain('pigEntryAdg.priorWeightLbs');
    expect(pageSrc).toContain('pigEntryAdg.priorDate');
  });
  it('renders days-since and +/- weight delta chips beside pig entry ADG', () => {
    expect(pageSrc).toContain('data-entry-days');
    expect(pageSrc).toContain('data-entry-delta');
    expect(pageSrc).toContain('data-pig-entry-days');
    expect(pageSrc).toContain('data-pig-entry-delta');
    expect(pageSrc).toContain('pigEntryAdg.daysBetween');
    expect(pageSrc).toContain('pigEntryAdg.weightDeltaLbs');
    expect(pageSrc).toContain("'+/- ' + formatSignedLbs");
  });
  it('hides blank pig note inputs behind a compact reveal button', () => {
    expect(pageSrc).toContain('openPigNoteEntryIds');
    expect(pageSrc).toContain('showPigNoteInput');
    expect(pageSrc).toContain('data-pig-entry-add-note');
  });
  it('renders sent-to-trip status text for pig entries', () => {
    expect(pageSrc).toContain('sent_to_trip_id');
    expect(pageSrc).toContain('Sent to trip');
  });
  it('renders transferred status text for pig entries', () => {
    expect(pageSrc).toContain('transferred_to_breeding');
    expect(pageSrc).toContain('Transferred');
  });
  it('renders pig entries as a dense table, not a badge/card grid', () => {
    expect(pigEntryBranch).toContain('<table');
    expect(pigEntryBranch).toContain('<thead');
    expect(pigEntryBranch).toContain('<tbody');
    // No card-grid auto-fill template inside the pig branch anymore.
    expect(pigEntryBranch).not.toContain('minmax(260px, 1fr)');
  });
  it('puts the send-to-trip checkbox in the leftmost pig table column', () => {
    // First column header is the trip-select column; the row checkbox carries
    // the send-select marker and toggles selectedEntryIds.
    expect(pigEntryBranch).toContain("['Trip', 'Weight', 'Note', 'Prior', 'Days', '+/-', 'ADG', 'Status', '']");
    expect(pigEntryBranch).toContain('data-pig-send-select');
    expect(pigEntryBranch).toMatch(/type="checkbox"[\s\S]*?setSelectedEntryIds/);
    // Sent rows show locked-checked; ineligible rows are disabled.
    expect(pigEntryBranch).toContain('checked={isSent || (canSelect && selectedEntryIds.has(e.id))}');
    expect(pigEntryBranch).toContain('disabled={!canSelect}');
  });
  it('locks sent/transferred pig entries as read-only', () => {
    expect(pageSrc).toContain('isLocked');
  });
  it('pig entry edits autosave weight and note without tag or new_tag_flag writes', () => {
    expect(pageSrc).toContain('setPigEntryField');
    expect(pageSrc).toContain('scheduleEntryAutosave');
    expect(pageSrc).toContain('flushPigEntryAutosave');
    expect(pageSrc).toContain('data-entry-autosave');
    expect(pageSrc).toContain('data-pig-entry-autosave');
    expect(pageSrc).toMatch(/sess\.species === 'pig'[\s\S]*?\{updates: \{weight: newWeight, note\}/);
    expect(entryAutosaveFunction).toContain('buildEntryDraftSave');
  });
  it('pig entry branch no longer renders per-row Save/Revert buttons', () => {
    expect(pigEntryBranch).not.toMatch(/>\s*Revert\s*</);
    expect(pigEntryBranch).not.toMatch(/>\s*Save\s*</);
  });
  it('handler-level isEntryLocked guards autosave and deleteEntry', () => {
    expect(pageSrc).toContain('function isEntryLocked');
    expect(pageSrc).toMatch(/saveEntryDraft[\s\S]*?isEntryLocked\(entry\)/);
    expect(pageSrc).toMatch(/function deleteEntry[\s\S]*?isEntryLocked\(e\)/);
  });
  it('isEntryLocked checks sent_to_trip_id, transferred_to_breeding, and note marker', () => {
    expect(pageSrc).toMatch(/isEntryLocked[\s\S]*?sent_to_trip_id/);
    expect(pageSrc).toMatch(/isEntryLocked[\s\S]*?transferred_to_breeding/);
    expect(pageSrc).toMatch(/isEntryLocked[\s\S]*?transferred_to_breeding/);
  });
  it('session select includes batch_id for pig', () => {
    expect(pageSrc).toContain('batch_id');
    expect(pageSrc).toMatch(/\.select\([^)]*batch_id/);
  });
  it('imports PigSendToTripModal', () => {
    expect(pageSrc).toContain('PigSendToTripModal');
  });
  it('imports reconcilePlannedTripsForSend', () => {
    expect(pageSrc).toContain('reconcilePlannedTripsForSend');
  });
  it('has send-to-trip flow', () => {
    expect(pageSrc).toContain('sendEntriesToTrip');
    expect(pageSrc).toContain('undoSendToTrip');
    expect(pageSrc).toContain('selectedEntryIds');
  });
  it('has transfer-to-breeding flow', () => {
    expect(pageSrc).toContain('transferToBreeding');
    expect(pageSrc).toContain('undoTransferToBreeding');
    expect(pageSrc).toContain('transferModal');
  });
  it('loads feeder groups for pig sessions', () => {
    expect(pageSrc).toContain("'ppp-feeders-v1'");
    expect(pageSrc).toContain('feederGroups');
  });
  it('has canManagePigPlannedTrips permission gate', () => {
    expect(pageSrc).toContain('canManagePigPlannedTrips');
  });
  it('mounts PigSendToTripModal', () => {
    expect(pageSrc).toContain('PigSendToTripModal');
    expect(pageSrc).toContain('tripModal');
  });
  it('has transfer-to-breeding modal UI', () => {
    expect(pageSrc).toContain('Transfer to Breeding');
    expect(pageSrc).toContain('transferForm');
  });
  it('does not import pigSlug (unused)', () => {
    expect(pageSrc).not.toContain("from '../lib/pig.js'");
  });
  it('resolveBatchAndSub matches exact lower-case and slug-like pig batch ids', () => {
    expect(pageSrc).toContain('function pigBatchLookupKeys(value)');
    expect(pageSrc).toMatch(/pigBatchNameMatches\(g\.batchName, batchId\)/);
    expect(pageSrc).toMatch(/pigBatchNameMatches\(s\.name, batchId\)/);
  });
  it('sendEntriesToTrip stamps source weigh-ins before recording the processing trip', () => {
    expect(pageSrc).toMatch(/sendEntriesToTrip[\s\S]*?sent_to_trip_id: newTripId[\s\S]*?upsertErr/);
  });
  it('sendEntriesToTrip throws on stamp failure instead of recording the trip', () => {
    expect(pageSrc).toMatch(/stampErr[\s\S]*?throw new Error\('Send failed \(stamp source entry\): '/);
  });
  it('sendEntriesToTrip clears source stamps if app_store upsert fails before closing the modal', () => {
    expect(pageSrc).toMatch(
      /upsertErr[\s\S]*?update\(\{sent_to_trip_id: null, sent_to_group_id: null\}\)[\s\S]*?throw new Error[\s\S]*?setTripModal\(null\)/,
    );
  });
  it('sendEntriesToTrip throws on all pre-mutation validation failures', () => {
    const fn = pageSrc.match(/async function sendEntriesToTrip[\s\S]*?await loadAll\(\);\s*\}/);
    expect(fn).not.toBeNull();
    const body = fn[0];
    expect(body).not.toMatch(/\breturn;/);
  });
  it('undoSendToTrip surfaces notice and returns on clearErr', () => {
    expect(pageSrc).toMatch(/undoSendToTrip[\s\S]*?clearErr[\s\S]*?setNotice[\s\S]*?return/);
  });
  it('undoSendToTrip reconciles stored subAttributions after removing one source entry', () => {
    expect(pageSrc).toMatch(/undoSendToTrip[\s\S]*?resolveBatchAndSub\(session && session\.batch_id\)\.sub/);
    expect(pageSrc).toMatch(
      /undoSendToTrip[\s\S]*?subAttributions[\s\S]*?Math\.max\(0, \(parseInt\(a\.count\) \|\| 0\) - 1\)/,
    );
  });
  it('transferToBreeding checks breeders and feeders upserts', () => {
    expect(pageSrc).toMatch(/transferToBreeding[\s\S]*?brUpsertErr[\s\S]*?fgUpsertErr/);
  });
  it('transferToBreeding keeps modal open on stamp failure', () => {
    expect(pageSrc).toMatch(/!stampOk[\s\S]*?setTransferNotice[\s\S]*?setTransferBusy\(false\)[\s\S]*?return/);
  });
  it('transferToBreeding only closes modal after stamp succeeds', () => {
    expect(pageSrc).toMatch(/stampOk[\s\S]*?return[\s\S]*?setTransferModal\(null\)/);
  });
  it('undoTransferToBreeding surfaces notice and returns on clearErr', () => {
    expect(pageSrc).toMatch(/undoTransferToBreeding[\s\S]*?clearErr[\s\S]*?setTransferNotice[\s\S]*?return/);
  });
  it('undoTransferToBreeding checks all steps before Activity', () => {
    expect(pageSrc).toMatch(/undoTransferToBreeding[\s\S]*?undoOk[\s\S]*?clearErr[\s\S]*?recordActivityEvent/);
  });
  it('imports SheepSendToProcessorModal', () => {
    expect(pageSrc).toContain('SheepSendToProcessorModal');
  });
  it('imports sheepCache functions', () => {
    expect(pageSrc).toContain('loadSheepWeighInsCached');
    expect(pageSrc).toContain('invalidateSheepWeighInsCache');
  });
  it('imports detachSheepFromBatch', () => {
    expect(pageSrc).toContain('detachSheepFromBatch');
  });
  it('has FLOCK_LABELS for sheep', () => {
    expect(pageSrc).toContain('FLOCK_LABELS');
    expect(pageSrc).toContain("rams: 'Rams'");
  });
  it('has a species-aware back link', () => {
    expect(pageSrc).toContain('/cattle/weighins');
    expect(pageSrc).toContain('/sheep/weighins');
    expect(pageSrc).toContain('/pig/weighins');
    expect(pageSrc).toContain('/broiler/weighins');
  });
});

describe('WeighInSessionPage — no edit-mode gate', () => {
  it('has no page-level editing state toggle', () => {
    expect(pageSrc).not.toContain('[editing, setEditing]');
    expect(pageSrc).not.toContain('handleEdit');
    expect(pageSrc).not.toMatch(/!editing\s*&&/);
    expect(pageSrc).not.toContain('setEditing(');
  });
  it('has no row-level edit gate', () => {
    expect(pageSrc).not.toContain('editingEntryId');
    expect(pageSrc).not.toContain('startEdit');
    expect(pageSrc).not.toContain('setEditingEntryId');
    expect(pageSrc).not.toContain('isEditing');
  });
  it('does not import ActivityPanel or ActivityModal', () => {
    expect(pageSrc).not.toMatch(/import ActivityPanel/);
    expect(pageSrc).not.toMatch(/import ActivityModal/);
  });
});

describe('WeighInSessionPage — cattle entry operations', () => {
  it('has add-entry form', () => {
    expect(pageSrc).toContain('addForm');
    expect(pageSrc).toContain('Add entry');
  });
  it('has per-row direct entry editing with debounce autosave', () => {
    expect(pageSrc).toContain('entryEdits');
    expect(pageSrc).toContain('setEntryField');
    expect(pageSrc).toContain('scheduleEntryAutosave');
    expect(pageSrc).toContain('flushEntryAutosave');
    expect(pageSrc).toContain('data-entry-autosave');
  });
  it('cattle/sheep entry branch no longer renders per-row Save/Revert buttons', () => {
    expect(cattleSheepEntryBranch).not.toMatch(/>\s*Revert\s*</);
    expect(cattleSheepEntryBranch).not.toMatch(/>\s*Save\s*</);
  });
  it('cattle/sheep entries autosave tag, weight, note, and new_tag_flag', () => {
    expect(pageSrc).toContain('buildEntryDraftSave');
    expect(pageSrc).toContain('new_tag_flag: newTagFlag');
    expect(pageSrc).toContain("labels: {tag: 'Tag', weight: 'Weight', note: 'Note', new_tag_flag: 'New tag'}");
  });
  it('renders days-since and +/- weight delta chips for cattle/sheep prior weigh-ins', () => {
    expect(cattleSheepEntryBranch).toContain('data-entry-days');
    expect(cattleSheepEntryBranch).toContain('data-entry-delta');
    expect(cattleSheepEntryBranch).toContain('daysBetweenDates');
    expect(cattleSheepEntryBranch).toContain("'+/- ' + formatSignedLbs");
    // The dense-table days cell must keep the 'Days ' text prefix the e2e
    // floor asserts (weighin_session_record_pages.spec.js: 'Days 27').
    expect(cattleSheepEntryBranch).toContain("'Days ' + priorDays");
  });
  it('has delete-entry', () => {
    expect(pageSrc).toContain('deleteEntry');
  });
  it('has tag reconciliation', () => {
    expect(pageSrc).toContain('reconcileNewTag');
    expect(pageSrc).toContain('Reconcile to known cow');
  });
  it('has ADG computation', () => {
    expect(pageSrc).toContain('adgLbPerDay');
    expect(pageSrc).toContain('avg ADG');
  });
  it('has send-to-processor toggle', () => {
    expect(pageSrc).toContain('toggleProcessor');
    expect(pageSrc).toContain('send_to_processor');
  });
  it('mounts CattleSendToProcessorModal', () => {
    expect(pageSrc).toContain('CattleSendToProcessorModal');
  });
  it('has complete/reopen/delete session actions', () => {
    expect(pageSrc).toContain('completeSession');
    expect(pageSrc).toContain('reopenSession');
    expect(pageSrc).toContain('deleteSession');
  });
  it('has tag-swap retag flow', () => {
    expect(pageSrc).toContain('priorTag');
    expect(pageSrc).toContain('Swap + Add');
  });
  it('does not write forbidden retag reconcile_intent for resolved swap-tag entries', () => {
    expect(pageSrc).not.toContain("reconcile_intent: 'retag'");
    expect(pageSrc).toContain('reconcile_intent: null');
    expect(pageSrc).toContain('existingAtNewTag && existingAtNewTag.id !== cow.id');
  });
  it('records resolved swap-tag prior tags as weigh-in history tags', () => {
    const start = pageSrc.indexOf('const existingOldTags = Array.isArray(cow.old_tags)');
    const end = pageSrc.indexOf('const swapTable =', start);
    const swapBlock = pageSrc.slice(start, end);
    expect(swapBlock).toContain("source: 'weigh_in'");
    expect(swapBlock).not.toContain("source: 'import'");
    expect(swapBlock).toContain('priorTagIndex');
  });
  it('shades blacklisted cattle in add/reconcile dropdowns', () => {
    expect(pageSrc).toContain('BLACKLIST_OPTION_STYLE');
    expect(pageSrc).toContain('data-breeding-blacklist-option');
    expect(pageSrc).toContain("backgroundColor: '#fee2e2'");
    expect(pageSrc).toContain("color: '#991b1b'");
  });
});

describe('WeighInSessionPage — cattle weigh-in entry parity (Lane 18)', () => {
  it('renders cattle/sheep entries as a dense table, not a card grid', () => {
    // The card-grid wrapper is now pig-only; cattle/sheep use a <table> with a
    // stable list marker.
    expect(cattleSheepEntryBranch).toContain('data-weighin-entry-list="1"');
    expect(cattleSheepEntryBranch).toContain('<table');
    expect(cattleSheepEntryBranch).toContain('<thead>');
    expect(cattleSheepEntryBranch).toContain('<tbody>');
    expect(cattleSheepEntryBranch).toContain('<tr');
    // No card-grid auto-fill template inside the cattle/sheep branch anymore.
    expect(cattleSheepEntryBranch).not.toContain('minmax(260px, 1fr)');
  });
  it('sorts the cattle/sheep table ascending by numeric tag', () => {
    expect(cattleSheepEntryBranch).toContain('[...sEntries].sort(sortEntriesByTagAsc)');
  });
  it('keeps the per-row autosave handlers wired identically in the table cells', () => {
    expect(cattleSheepEntryBranch).toContain("setEntryField(e, 'tag', ev.target.value)");
    expect(cattleSheepEntryBranch).toContain("setEntryField(e, 'weight', ev.target.value)");
    expect(cattleSheepEntryBranch).toContain("setEntryField(e, 'note', ev.target.value)");
    expect(cattleSheepEntryBranch).toContain('flushEntryAutosave(e.id)');
    expect(cattleSheepEntryBranch).toContain('data-entry-autosave={e.id}');
    expect(cattleSheepEntryBranch).toContain('deleteEntry(e)');
    // Reconciliation is driven from the dedicated panel (below the table), not
    // an in-row select.
    expect(pageSrc).toContain('reconcileNewTag(e, ev.target.value)');
  });
  it('still uses autosave (no explicit per-row Save/Submit) for cattle/sheep entries — save-model guard', () => {
    expect(pageSrc).toContain('scheduleEntryAutosave');
    expect(pageSrc).toContain('flushEntryAutosave');
    expect(pageSrc).toContain('saveEntryDraft');
    expect(pageSrc).toContain('WEIGHIN_ENTRY_AUTOSAVE_DELAY_MS = 700');
    expect(cattleSheepEntryBranch).not.toMatch(/>\s*Save\s*</);
    expect(cattleSheepEntryBranch).not.toMatch(/>\s*Submit\s*</);
  });
  it('computes herd-scoped remaining pools (not all cattle)', () => {
    // Scope to the session herd/flock, minus tags already weighed this session.
    expect(pageSrc).toContain('const animalGroupField');
    expect(pageSrc).toContain('const weighedTagSet');
    expect(pageSrc).toContain('const herdCows');
    expect(pageSrc).toMatch(/herdCows\s*=[\s\S]*?\(c\[animalGroupField\] \|\| null\) === \(session\.herd \|\| null\)/);
    expect(pageSrc).toContain('const remainingCows = herdCows.filter((c) => !weighedTagSet.has(c.tag))');
    expect(pageSrc).toContain('const remainingTags = remainingCows.map((c) => c.tag)');
  });
  it('main add-entry workflow offers a herd-scoped diminishing picker of remaining cows', () => {
    expect(pageSrc).toContain('data-weighin-remaining-picker="1"');
    expect(pageSrc).toMatch(/data-weighin-remaining-picker[\s\S]*?remainingCows\.map/);
    expect(pageSrc).toMatch(/remainingTags\.length \+ ' remaining/);
  });
  it('reconcile panel is scoped to remaining HERD cows, not all animals', () => {
    // The dedicated reconcile panel only offers remainingCows (herd-scoped),
    // never the full animals list.
    expect(pageSrc).toContain('data-weighin-reconcile-panel="1"');
    const panelStart = pageSrc.indexOf('data-weighin-reconcile-panel');
    const panelEnd = pageSrc.indexOf('<RecordCollaborationSection', panelStart);
    const panel = pageSrc.slice(panelStart, panelEnd);
    expect(panel).toContain('remainingCows.map');
    // Never iterate the full animals directory inside the reconcile/add surface.
    expect(panel).not.toMatch(/animals\.(map|filter|sort)/);
  });
  it('preserves reconcileNewTag mechanics (tag swap, old_tags, clear flag, comment stitch, Activity)', () => {
    expect(pageSrc).toMatch(/async function reconcileNewTag[\s\S]*?old_tags: updatedOldTags/);
    expect(pageSrc).toMatch(/reconcileNewTag[\s\S]*?new_tag_flag: false/);
    expect(pageSrc).toMatch(/reconcileNewTag[\s\S]*?cattle_comments|reconcileNewTag[\s\S]*?commentsTable2/);
    expect(pageSrc).toMatch(/reconcileNewTag[\s\S]*?Reconciled new tag/);
  });
  it('blocks completion while unresolved new_tag_flag entries remain (handler + button)', () => {
    // Handler-level gate in completeSession.
    expect(pageSrc).toMatch(
      /async function completeSession[\s\S]*?new_tag_flag === true[\s\S]*?before completing this session/,
    );
    // pendingReconciles derived from new_tag_flag entries.
    expect(pageSrc).toContain('const pendingReconciles');
    expect(pageSrc).toMatch(/pendingReconciles[\s\S]*?new_tag_flag === true/);
    // Complete button disabled + relabeled while pending.
    expect(pageSrc).toContain('data-weighin-complete-blocked');
    expect(pageSrc).toMatch(/pendingReconciles\.length > 0[\s\S]*?disabled=\{blockComplete\}/);
  });
});

describe('WeighInSessionPage — Activity audit logging', () => {
  it('imports runMutation, recordFieldChange, recordStatusChange, recordActivityEvent', () => {
    expect(pageSrc).toContain('runMutation');
    expect(pageSrc).toContain('recordFieldChange');
    expect(pageSrc).toContain('recordStatusChange');
    expect(pageSrc).toContain('recordActivityEvent');
  });
  it('imports buildChanges', () => {
    expect(pageSrc).toContain('buildChanges');
  });
  it('logs status.changed on complete/reopen', () => {
    expect(pageSrc).toContain("entityType: 'weighin.session'");
    expect(pageSrc).toContain("from: 'draft'");
    expect(pageSrc).toContain("to: 'complete'");
    expect(pageSrc).toContain("from: 'complete'");
    expect(pageSrc).toContain("to: 'draft'");
  });
  it('routes session delete through the transactional delete_weigh_in_session RPC (record.deleted logged in-txn)', () => {
    expect(pageSrc).toContain("from '../lib/weighInDeleteApi.js'");
    expect(pageSrc).toMatch(/async function deleteSession[\s\S]*?deleteWeighInSession\(sb,/);
    // The record.deleted audit now lives in the SECDEF RPC (mig 101), not as a
    // best-effort client recordActivityEvent on this page.
    expect(pageSrc).not.toContain("eventType: 'record.deleted'");
  });
  it('logs record.created on add entry', () => {
    expect(pageSrc).toContain("eventType: 'record.created'");
  });
  it('logs field.updated on entry save via buildChanges', () => {
    expect(pageSrc).toContain("eventType: 'field.updated'");
  });
  it('logs field.updated on processor toggle', () => {
    expect(pageSrc).toContain('for processor');
  });
  it('logs field.updated on reconcile new tag', () => {
    expect(pageSrc).toContain('Reconciled new tag');
  });
  it('add-entry checks insert error before logging record.created', () => {
    expect(pageSrc).toContain('insErr');
    expect(pageSrc).toMatch(/insErr\)[\s\S]*?return[\s\S]*?record\.created/);
  });
  it('delete-entry routes through the transactional delete_weigh_in_entry RPC and surfaces failures', () => {
    expect(pageSrc).toMatch(/async function deleteEntry[\s\S]*?deleteWeighInEntry\(sb,/);
    expect(pageSrc).not.toMatch(/\.delete\(\)\.eq\('id', e\.id\)/);
    expect(pageSrc).toMatch(/deleteWeighInEntry\(sb,[\s\S]*?if \(!r\.ok\)[\s\S]*?setNotice/);
  });
});

describe('WeighInSessionPage — record sequence navigation (CP2)', () => {
  it('renders the shared RecordSequenceNav', () => {
    expect(pageSrc).toContain("from '../shared/RecordSequenceNav.jsx'");
    expect(pageSrc).toContain('<RecordSequenceNav');
  });
  it('reads the sequence from route state', () => {
    expect(pageSrc).toContain('location.state?.recordSeq');
  });
  it('navigateSeq carries the sequence forward', () => {
    expect(pageSrc).toContain("navigate('/weigh-in-sessions/' + id, recordSeqNavOptions(recordSeq))");
  });
});

describe('Weigh-in list views — pass visible-order sequence with date · group label (CP2)', () => {
  const views = [
    {name: 'CattleWeighInsView', src: listSrc, group: 'HERD_LABELS[r.herd]'},
    {name: 'SheepWeighInsView', src: sheepListSrc, group: 'FLOCK_LABELS[r.herd]'},
    {name: 'LivestockWeighInsView', src: livestockSrc, group: 'r.batch_id'},
  ];
  for (const v of views) {
    it(`${v.name} imports recordSeqNavOptions`, () => {
      expect(v.src).toContain("from '../lib/recordSequence.js'");
    });
    it(`${v.name} builds sequence items over the visible filtered order`, () => {
      expect(v.src).toContain('recordSeqNavOptions(');
      expect(v.src).toContain('filtered.map((r) =>');
    });
    it(`${v.name} label uses date plus the ${v.group} group`, () => {
      expect(v.src).toContain(v.group);
    });
  }
});

describe('CattleWeighInsView — cleaned list view', () => {
  it('navigates to /weigh-in-sessions/<id> on tile click', () => {
    expect(listSrc).toContain("'/weigh-in-sessions/' + s.id");
  });
  it('does not have expandedSession state', () => {
    expect(listSrc).not.toContain('expandedSession');
  });
  it('does not render inline entries', () => {
    expect(listSrc).not.toContain('sEntries.map');
  });
  it('does not import CattleSendToProcessorModal', () => {
    expect(listSrc).not.toContain('CattleSendToProcessorModal');
  });
  it('does not import detachCowFromBatch', () => {
    expect(listSrc).not.toContain('detachCowFromBatch');
  });
  it('still has + New Weigh-In button', () => {
    expect(listSrc).toContain('New Weigh-In');
    expect(listSrc).toContain('data-new-weighin-button');
  });
  it('navigates to record page after creating a new session', () => {
    expect(listSrc).toContain("navigate('/weigh-in-sessions/' + id)");
  });
  it('still has status filter', () => {
    expect(listSrc).toContain('statusFilter');
  });
  it('still has tag search', () => {
    expect(listSrc).toContain('tagSearch');
  });
});

describe('SheepWeighInsView — cleaned list view', () => {
  it('navigates to /weigh-in-sessions/<id> on tile click', () => {
    expect(sheepListSrc).toContain("'/weigh-in-sessions/' + s.id");
  });
  it('does not have expandedSession state', () => {
    expect(sheepListSrc).not.toContain('expandedSession');
  });
  it('does not render inline entries', () => {
    expect(sheepListSrc).not.toContain('sEntries.map');
  });
  it('does not import SheepSendToProcessorModal', () => {
    expect(sheepListSrc).not.toContain('SheepSendToProcessorModal');
  });
  it('does not import detachSheepFromBatch', () => {
    expect(sheepListSrc).not.toContain('detachSheepFromBatch');
  });
  it('still has + New Weigh-In button', () => {
    expect(sheepListSrc).toContain('New Weigh-In');
    expect(sheepListSrc).toContain('data-new-weighin-button');
  });
  it('navigates to record page after creating a new session', () => {
    expect(sheepListSrc).toContain("navigate('/weigh-in-sessions/' + id)");
  });
  it('still has status filter', () => {
    expect(sheepListSrc).toContain('statusFilter');
  });
  it('still has tag search', () => {
    expect(sheepListSrc).toContain('tagSearch');
  });
});

describe('Cattle and sheep weigh-in list saved views (Lane F)', () => {
  const views = [
    {
      name: 'CattleWeighInsView',
      src: listSrc,
      surfaceConst: 'CATTLE_WEIGHINS_SURFACE_KEY',
      surfaceKey: 'cattle.weighins',
      stateFn: 'cattleWeighInsViewState',
      applyFn: 'applyCattleSavedView',
      markerPrefix: 'data-cattle-weighins-saved',
    },
    {
      name: 'SheepWeighInsView',
      src: sheepListSrc,
      surfaceConst: 'SHEEP_WEIGHINS_SURFACE_KEY',
      surfaceKey: 'sheep.weighins',
      stateFn: 'sheepWeighInsViewState',
      applyFn: 'applySheepSavedView',
      markerPrefix: 'data-sheep-weighins-saved',
    },
  ];

  it('uses the shared app_saved_views API owner', () => {
    expect(savedViewsApi).toContain("from('app_saved_views')");
    expect(savedViewsApi).toContain('export async function listSavedViews');
    expect(savedViewsApi).toContain('export async function createSavedView');
    expect(savedViewsApi).toContain('export async function updateSavedView');
    expect(savedViewsApi).toContain('export async function deleteSavedView');
  });

  for (const v of views) {
    it(`${v.name} uses a species-specific saved-view surface`, () => {
      expect(v.src).toContain("from '../lib/savedViewsApi.js'");
      expect(v.src).toContain(`const ${v.surfaceConst} = '${v.surfaceKey}'`);
      expect(v.src).toContain(`listSavedViews(sb, ${v.surfaceConst})`);
      expect(v.src).toContain(`surfaceKey: ${v.surfaceConst}`);
      expect(v.src).toContain('createSavedView(sb, {');
      expect(v.src).toContain('updateSavedView(sb, selectedView.id');
      expect(v.src).toContain('deleteSavedView(sb, view.id)');
    });

    it(`${v.name} saves and restores exactly the current status filter plus tag search`, () => {
      expect(v.src).toContain(`function ${v.stateFn}()`);
      expect(v.src).toContain('statusFilter: VALID_WEIGHIN_STATUS_FILTERS.has(statusFilter) ? statusFilter :');
      expect(v.src).toContain("tagSearch: tagSearch || ''");
      expect(v.src).toContain(`function ${v.applyFn}(view)`);
      expect(v.src).toContain('setStatusFilter(VALID_WEIGHIN_STATUS_FILTERS.has(st.statusFilter)');
      expect(v.src).toContain("setTagSearch(typeof st.tagSearch === 'string' ? st.tagSearch : '')");
    });

    it(`${v.name} renders the full saved-view control without browser confirm/prompt APIs`, () => {
      for (const marker of [
        `${v.markerPrefix}-views-row`,
        `${v.markerPrefix}-view-select`,
        `${v.markerPrefix}-view-save-open`,
        `${v.markerPrefix}-view-form`,
        `${v.markerPrefix}-view-name`,
        `${v.markerPrefix}-view-visibility="private"`,
        `${v.markerPrefix}-view-visibility="public"`,
        `${v.markerPrefix}-view-save`,
        `${v.markerPrefix}-view-update`,
        `${v.markerPrefix}-view-delete`,
      ]) {
        expect(v.src).toContain(marker);
      }
      expect(v.src).toContain('window._wcfConfirmDelete');
      expect(v.src).not.toContain('window.confirm');
      expect(v.src).not.toContain('window.prompt');
    });

    it(`${v.name} degrades saved-view failures without flipping the list load state`, () => {
      const savedViewBlock = v.src.slice(
        v.src.indexOf('async function loadSavedViews'),
        v.src.indexOf('function handleExportCsv'),
      );
      expect(v.src).toContain('Saved views unavailable. Filters still work.');
      expect(v.src).toContain(`${v.markerPrefix}-views-error`);
      expect(v.src).toContain('const loadFailed = !!notice;');
      expect(savedViewBlock).toContain('setSavedViewsError(e.message || String(e))');
      expect(savedViewBlock).toContain('setSavedViewNotice');
      expect(savedViewBlock).not.toContain('setNotice(');
    });
  }
});

describe('Pig and broiler weigh-in list saved views (Lane F)', () => {
  it('uses species-specific saved-view surfaces for the shared livestock list', () => {
    expect(livestockSrc).toContain("from '../lib/savedViewsApi.js'");
    expect(livestockSrc).toContain("pig: 'pig.weighins'");
    expect(livestockSrc).toContain("broiler: 'broiler.weighins'");
    expect(livestockSrc).toContain('listSavedViews(sb, savedViewSurfaceKey)');
    expect(livestockSrc).toContain('surfaceKey: savedViewSurfaceKey');
    expect(livestockSrc).toContain('createSavedView(sb, {');
    expect(livestockSrc).toContain('updateSavedView(sb, selectedView.id');
    expect(livestockSrc).toContain('deleteSavedView(sb, view.id)');
  });

  it('saves and restores the current status filter only', () => {
    expect(livestockSrc).toContain('function livestockWeighInsViewState()');
    expect(livestockSrc).toContain('statusFilter: VALID_WEIGHIN_STATUS_FILTERS.has(statusFilter) ? statusFilter :');
    expect(livestockSrc).toContain('function applyLivestockSavedView(view)');
    expect(livestockSrc).toContain('setStatusFilter(VALID_WEIGHIN_STATUS_FILTERS.has(st.statusFilter)');
  });

  it('renders a saved-view control and keeps saved-view failures separate from list load failure', () => {
    const savedViewBlock = livestockSrc.slice(
      livestockSrc.indexOf('async function loadSavedViews'),
      livestockSrc.indexOf('function handleExportCsv'),
    );
    for (const marker of [
      'data-livestock-weighins-saved-views-row',
      'data-livestock-weighins-saved-view-select',
      'data-livestock-weighins-saved-view-save-open',
      'data-livestock-weighins-saved-view-form',
      'data-livestock-weighins-saved-view-name',
      'data-livestock-weighins-saved-view-visibility="private"',
      'data-livestock-weighins-saved-view-visibility="public"',
      'data-livestock-weighins-saved-view-save',
      'data-livestock-weighins-saved-view-update',
      'data-livestock-weighins-saved-view-delete',
      'data-livestock-weighins-saved-views-error',
    ]) {
      expect(livestockSrc).toContain(marker);
    }
    expect(livestockSrc).toContain('Saved views unavailable. Filters still work.');
    expect(livestockSrc).toContain('const loadFailed = !!notice;');
    expect(savedViewBlock).toContain('setSavedViewsError(e.message || String(e))');
    expect(savedViewBlock).not.toContain('setNotice(');
    expect(livestockSrc).toContain('window._wcfConfirmDelete');
    expect(livestockSrc).not.toContain('window.confirm');
    expect(livestockSrc).not.toContain('window.prompt');
  });
});

describe('Pig weigh-in list — Active/Complete sections (pig redesign)', () => {
  it('splits the pig list into Active and Complete sections', () => {
    expect(livestockSrc).toContain("const isPig = species === 'pig'");
    // CP2: pig list renders via the shared DataTable's Active/Complete section bands.
    expect(livestockSrc).toMatch(/sections=\{\[/);
    expect(livestockSrc).toContain("label: 'Active'");
    expect(livestockSrc).toContain("label: 'Complete'");
    // Active = non-complete (incl. draft); Complete = complete.
    expect(livestockSrc).toContain("sessions.filter((s) => s.status !== 'complete')");
    expect(livestockSrc).toContain("sessions.filter((s) => s.status === 'complete')");
  });

  it('hides saved views, export, print, and the status filter behind the site-wide list-control gate', () => {
    expect(livestockSrc).toContain('const EXTENDED_LIST_CONTROLS_ENABLED = false;');
    expect(livestockSrc).toContain('{EXTENDED_LIST_CONTROLS_ENABLED && !loadFailed && !isPig && (');
    expect(livestockSrc).toContain('{EXTENDED_LIST_CONTROLS_ENABLED && !isPig && (');
    // The mechanics still exist in source, but the runtime UI is gated off here.
    expect(livestockSrc).toContain('data-livestock-weighins-export-csv="1"');
    expect(livestockSrc).toContain('data-livestock-weighins-print="1"');
  });

  it('keeps New Weigh-In for the pig list', () => {
    expect(livestockSrc).toContain('New Weigh-In');
  });

  it('bases the pig header/summary on sessions, ignoring statusFilter', () => {
    expect(livestockSrc).toContain(
      'const visibleSessions = EXTENDED_LIST_CONTROLS_ENABLED && !isPig ? filtered : sessions',
    );
    expect(livestockSrc).toContain('const visibleTotalEntries = visibleSessions.reduce(');
    // Header renders the visible (unfiltered for pig) counts.
    expect(livestockSrc).toContain('{visibleSessions.length} sessions');
    expect(livestockSrc).toContain('{visibleTotalEntries} total entries');
  });

  it('uses sessions.length for the pig empty state with no filter wording', () => {
    expect(livestockSrc).toMatch(/!loading && !loadFailed && visibleSessions\.length === 0/);
    // Pig empty copy is the plain "none" message/hint — no filter wording.
    expect(livestockSrc).toMatch(/emptyStateMessage =\s*isPig \|\| emptyStateKind === 'none'/);
    expect(livestockSrc).toMatch(/emptyStateHint =\s*isPig \|\| emptyStateKind === 'none'/);
  });

  it('does not load saved views while the site-wide list-control gate is disabled', () => {
    expect(livestockSrc).toMatch(
      /if \(isPig \|\| !EXTENDED_LIST_CONTROLS_ENABLED\) \{[\s\S]{0,320}setSavedViews\(\[\]\)[\s\S]{0,320}return;/,
    );
    // Re-enable path still calls loadSavedViews().
    expect(livestockSrc).toContain('loadSavedViews();');
  });
});

describe('SheepWeighInsView - CSV export', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  it('exports the current visible sheep weigh-in sessions, not the raw session list', () => {
    expect(sheepListSrc).toContain("from '../lib/csvExport.js'");
    expect(sheepListSrc).toContain('function handleExportCsv');
    expect(sheepListSrc).toContain('data-sheep-weighins-export-csv="1"');
    expect(sheepListSrc).toContain('rowsToCsv(columns, filtered)');
    expect(sheepListSrc).not.toContain('rowsToCsv(columns, sessions)');
  });

  it('keeps sheep weigh-in export columns useful for session review', () => {
    expect(sheepListSrc).toContain("groupHeader: 'Flock'");
    expect(sheepListSrc).toContain('buildRuminantWeighInSessionColumns');
    for (const header of [
      'Date',
      'Status',
      'Team member',
      'Entry count',
      'Matching tag entries',
      'New tag count',
      'Started at',
      'Session ID',
    ]) {
      expect(weighInSessionExportsSrc).toContain(`header: '${header}'`);
    }
  });
});

describe('CattleWeighInsView - CSV export (Lane K CP3)', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  it('exports the current visible cattle weigh-in sessions, not the raw session list', () => {
    expect(listSrc).toContain("from '../lib/csvExport.js'");
    expect(listSrc).toContain('function handleExportCsv');
    expect(listSrc).toContain('data-cattle-weighins-export-csv="1"');
    expect(listSrc).toContain('rowsToCsv(columns, filtered)');
    expect(listSrc).not.toContain('rowsToCsv(columns, sessions)');
  });

  it('keeps cattle weigh-in export columns useful for session review', () => {
    expect(listSrc).toContain("groupHeader: 'Herd'");
    expect(listSrc).toContain('buildRuminantWeighInSessionColumns');
    for (const header of [
      'Date',
      'Status',
      'Team member',
      'Entry count',
      'Matching tag entries',
      'New tag count',
      'Started at',
      'Session ID',
    ]) {
      expect(weighInSessionExportsSrc).toContain(`header: '${header}'`);
    }
  });

  it('keeps the export fallback browser-only and free of window.alert/confirm', () => {
    expect(listSrc).toContain('CSV export is only available in the browser.');
    expect(listSrc).not.toContain('window.alert');
    expect(listSrc).not.toContain('window.confirm');
  });
});

describe('Weigh-in list print export (Lane K)', () => {
  const WEIGHIN_LISTS = [
    {
      name: 'CattleWeighInsView',
      src: listSrc,
      prefix: 'cattle-weighins',
      fn: 'cattleWeighInsExportColumns',
    },
    {
      name: 'SheepWeighInsView',
      src: sheepListSrc,
      prefix: 'sheep-weighins',
      fn: 'sheepWeighInsExportColumns',
    },
    {
      name: 'LivestockWeighInsView',
      src: livestockSrc,
      prefix: 'livestock-weighins',
      fn: 'livestockWeighInsExportColumns',
    },
  ];

  it('uses the shared printExport owner for browser print mechanics', () => {
    expect(printExport).toContain('export function rowsToPrintHtml');
    expect(printExport).toContain('export function printRows');
    expect(printExport).toContain('data-print-export-frame');
    expect(printExport).toContain('window.print');
    expect(printExport).toContain('escapeHtml');
  });

  for (const list of WEIGHIN_LISTS) {
    it(`${list.name} prints the current filtered sessions, not raw sessions`, () => {
      expect(list.src).toContain("from '../lib/printExport.js'");
      expect(list.src).toContain('function handlePrintRows');
      expect(list.src).toContain(`data-${list.prefix}-print="1"`);
      expect(list.src).toContain("subtitle: filtered.length + ' filtered weigh-in sessions'");
      expect(list.src).toContain('rows: filtered');
      expect(list.src).not.toContain('rows: sessions');
    });

    it(`${list.name} uses one column spec for CSV and print`, () => {
      expect(list.src).toContain(`function ${list.fn}()`);
      expect(list.src).toContain(`const columns = ${list.fn}();`);
      expect(list.src).toContain('rowsToCsv(columns, filtered)');
      expect(list.src).toContain('printRows({');
    });

    it(`${list.name} keeps print fallback browser-only`, () => {
      expect(list.src).toContain('Print is only available in the browser.');
      expect(list.src).not.toContain('window.alert');
      expect(list.src).not.toContain('window.confirm');
    });
  }
});

describe('Weigh-in list shared tile primitive (Lane F)', () => {
  it('owns the common weigh-in session tile marker and chrome', () => {
    expect(weighInSessionTileSrc).toContain('data-weighin-session-tile');
    expect(weighInSessionTileSrc).toContain('hoverable-tile');
    expect(weighInSessionTileSrc).toContain('borderRadius: 10');
    expect(weighInSessionTileSrc).toContain("padding: '10px 16px'");
    expect(weighInSessionTileSrc).toContain("background: isComplete ? '#d1fae5' : '#fef3c7'");
    expect(weighInSessionTileSrc).toContain("color: isComplete ? '#065f46' : '#92400e'");
  });

  it('all three weigh-in list views render via the shared DataTable primitive', () => {
    // CP2: the canonical list primitive is the shared DataTable; it replaced the
    // per-session WeighInSessionListTile card in the list views.
    for (const src of [listSrc, sheepListSrc, livestockSrc]) {
      expect(src).toContain("import DataTable from '../shared/DataTable.jsx'");
      expect(src).toContain('<DataTable');
    }
  });

  it('keeps shared export column builders out of the list views', () => {
    expect(weighInSessionExportsSrc).toContain('export function buildRuminantWeighInSessionColumns');
    expect(weighInSessionExportsSrc).toContain('export function buildLivestockWeighInSessionColumns');
    expect(listSrc).toContain('buildRuminantWeighInSessionColumns');
    expect(sheepListSrc).toContain('buildRuminantWeighInSessionColumns');
    expect(livestockSrc).toContain('buildLivestockWeighInSessionColumns');
  });
});

describe('WeighInSessionPage — broiler record page', () => {
  it('loadAll allows species broiler', () => {
    expect(pageSrc).toContain("sp !== 'broiler'");
  });
  it('loads ppp-v4 for broiler batch recs', () => {
    expect(pageSrc).toContain("'ppp-v4'");
    expect(pageSrc).toContain('broilerBatchRecs');
  });
  it('does not load a roster for broiler session metadata', () => {
    expect(pageSrc).not.toContain('loadRoster');
    expect(pageSrc).not.toContain('activeRoster');
    expect(pageSrc).not.toContain('metaTeam');
  });
  it('imports writeBroilerBatchAvg and recomputeBroilerBatchWeekAvg', () => {
    expect(pageSrc).toContain('writeBroilerBatchAvg');
    expect(pageSrc).toContain('recomputeBroilerBatchWeekAvg');
  });
  it('has broiler grid labels and inputs state', () => {
    expect(pageSrc).toContain('gridLabels');
    expect(pageSrc).toContain('gridInputs');
  });
  it('derives schooner labels from ppp-v4', () => {
    expect(pageSrc).toContain('deriveBroilerLabels');
    expect(pageSrc).toMatch(/schooner[\s\S]*?split\('&'\)/);
  });
  it('renders broiler metadata panel', () => {
    expect(pageSrc).toContain('data-testid="broiler-meta-panel"');
    expect(pageSrc).toContain('broiler-meta-wk4');
    expect(pageSrc).toContain('broiler-meta-wk6');
    expect(pageSrc).toContain('LockedTeamMemberField');
    expect(pageSrc).toContain('broiler-meta-save');
  });
  it('renders broiler weight grid', () => {
    expect(pageSrc).toContain('data-broiler-grid');
    expect(pageSrc).toContain('Schooner');
  });
  it('has broiler grid save function', () => {
    expect(pageSrc).toContain('saveBroilerGrid');
    expect(pageSrc).toContain('Save Weights');
  });
  it('has broiler metadata save function', () => {
    expect(pageSrc).toContain('saveBroilerMetadata');
    expect(pageSrc).toContain('Save Metadata');
  });
  it('broiler complete flushes grid then writes batch avg', () => {
    expect(pageSrc).toMatch(/isBroiler[\s\S]*?saveBroilerGrid[\s\S]*?writeBroilerBatchAvg/);
  });
  it('broiler reopen recomputes old week avg', () => {
    expect(pageSrc).toMatch(/wasBroilerComplete[\s\S]*?recomputeBroilerBatchWeekAvg/);
  });
  it('broiler delete recomputes old week for complete sessions', () => {
    expect(pageSrc).toMatch(
      /isBroiler && session\.status === 'complete'[\s\S]*?recomputeBroilerBatchWeekAvg[\s\S]*?finishDelete|recordActivityEvent/,
    );
  });
  it('broiler metadata save handles week change side effects', () => {
    expect(pageSrc).toMatch(/saveBroilerMetadata[\s\S]*?recomputeBroilerBatchWeekAvg[\s\S]*?writeBroilerBatchAvg/);
  });
  it('shows broiler week badge in title area', () => {
    expect(pageSrc).toContain("'WK ' + session.broiler_week");
  });
  it('shows broiler avg weight in title area', () => {
    expect(pageSrc).toContain('broilerAvg');
  });
  it('shows the saved team member as a locked display, not a dropdown', () => {
    expect(pageSrc).toContain('LockedTeamMemberField');
    expect(pageSrc).not.toContain('broiler-meta-team');
    expect(pageSrc).not.toContain("(retired)'");
  });
  it('has session notes textarea for broiler grid', () => {
    expect(pageSrc).toContain('gridNote');
    expect(pageSrc).toContain('Session note');
  });
  it('does not show cattle/sheep/pig entries section for broiler', () => {
    expect(pageSrc).toContain('!isBroiler');
  });
  it('has no page-level edit-mode gate on broiler grid', () => {
    expect(pageSrc).not.toContain('gridUnlocked');
    expect(pageSrc).not.toContain('Edit Weights');
  });
  it('logs Activity for broiler grid save', () => {
    expect(pageSrc).toMatch(/saveBroilerGrid[\s\S]*?recordActivityEvent[\s\S]*?Saved broiler grid/);
  });
  it('logs Activity for broiler metadata save', () => {
    expect(pageSrc).toMatch(/saveBroilerMetadata[\s\S]*?recordActivityEvent[\s\S]*?Updated metadata/);
  });
  it('saveBroilerGrid returns false on failure', () => {
    expect(pageSrc).toMatch(/saveBroilerGrid[\s\S]*?return false/);
  });
  it('completeSession checks grid save result before marking complete', () => {
    expect(pageSrc).toMatch(/gridOk[\s\S]*?if \(!gridOk\) return/);
  });
  it('reopenSession checks recompute result and surfaces failure via notice', () => {
    expect(pageSrc).toMatch(/reopenSession[\s\S]*?recomputeBroilerBatchWeekAvg[\s\S]*?!r2\.ok[\s\S]*?setNotice/);
  });
  it('deleteSession checks recompute result and blocks delete on failure', () => {
    expect(pageSrc).toMatch(
      /finishDelete[\s\S]*?recomputeBroilerBatchWeekAvg[\s\S]*?!r2\.ok[\s\S]*?setNotice[\s\S]*?return/,
    );
  });
});

describe('LivestockWeighInsView — navigation-only list', () => {
  it('all tiles navigate to /weigh-in-sessions/<id>', () => {
    expect(livestockSrc).toContain("'/weigh-in-sessions/' + s.id");
  });
  it('session creation navigates to record page', () => {
    expect(livestockSrc).toContain("navigate('/weigh-in-sessions/' + rec.id)");
  });
  it('does not have expandedSession state', () => {
    expect(livestockSrc).not.toContain('expandedSession');
  });
  it('does not have broiler grid or metadata state', () => {
    expect(livestockSrc).not.toContain('gridInputs');
    expect(livestockSrc).not.toContain('gridLabels');
    expect(livestockSrc).not.toContain('metaWeek');
    expect(livestockSrc).not.toContain('metaTeam');
  });
  it('does not have inline action functions', () => {
    expect(livestockSrc).not.toContain('saveAdminGrid');
    expect(livestockSrc).not.toContain('saveSessionMetadata');
    expect(livestockSrc).not.toContain('completeFromAdmin');
    expect(livestockSrc).not.toContain('reopenSession');
    expect(livestockSrc).not.toContain('deleteSession');
  });
  it('does not import broiler helpers', () => {
    expect(livestockSrc).not.toContain('writeBroilerBatchAvg');
    expect(livestockSrc).not.toContain('recomputeBroilerBatchWeekAvg');
    expect(livestockSrc).not.toContain('loadRoster');
  });
  it('rows have data-weighin-session-tile marker', () => {
    // CP2: the navigation marker now rides on the DataTable row via rowProps.
    expect(livestockSrc).toContain("'data-weighin-session-tile': s.id");
  });
  it('still has status filter', () => {
    expect(livestockSrc).toContain('statusFilter');
  });
  it('still has New Weigh-In button', () => {
    expect(livestockSrc).toContain('New Weigh-In');
  });
  it('still shows broiler week badge', () => {
    expect(livestockSrc).toContain('broiler_week');
  });
  it('still shows avg weight badge for broiler', () => {
    expect(livestockSrc).toContain('avgWeight');
  });
  it('pig metrics row is preserved', () => {
    expect(livestockSrc).toContain('pigMetricsBySession');
    expect(livestockSrc).toContain('formatAgeRange');
  });
});

describe('Weigh-in readiness markers — CI determinism (see helpers/weighInReady.js)', () => {
  it('record page exposes data-weighin-session-record-loaded only on the loaded body', () => {
    expect(pageSrc).toMatch(/<RecordPageBody[^>]*data-weighin-session-record-loaded="true"/);
  });
  it('cattle / sheep / livestock list views expose data-weighin-list-loaded keyed on load/error state', () => {
    for (const src of [listSrc, sheepListSrc, livestockSrc]) {
      expect(src).toMatch(/data-weighin-list-loaded=\{loading \|\| loadFailed \? 'false' : 'true'\}/);
    }
  });
});

describe('LivestockWeighInsView - cold-boot readiness', () => {
  const loadAllMatch = livestockSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the pig/broiler list readiness marker in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('surfaces session and entry read failures through InlineNotice and clears stale rows', () => {
    expect(livestockSrc).toContain("import InlineNotice from '../shared/InlineNotice.jsx'");
    expect(livestockSrc).toContain('<InlineNotice notice={notice} />');
    expect(loadAllSrc).toContain("throw new Error('weigh_in_sessions: '");
    expect(loadAllSrc).toContain("throw new Error('weigh_ins: '");
    expect(loadAllSrc).toContain('Could not load ');
    expect(loadAllSrc).toContain('setSessions([]);');
    expect(loadAllSrc).toContain('setEntries({});');
    expect(loadAllSrc).toContain('setPigMetricsBySession({});');
  });

  it('pig metrics fanout fails closed per session instead of rejecting the whole effect', () => {
    expect(livestockSrc).toMatch(
      /\.rpc\('pig_session_metrics'[\s\S]*?\.catch\(\(\) => \(\{id: s\.id, data: \{available: false\}\}\)\)/,
    );
  });
});

describe('CattleWeighInsView - cold-boot readiness', () => {
  const loadAllMatch = listSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the cattle list readiness marker in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('surfaces cattle sessions/cache failures through InlineNotice and clears stale rows', () => {
    expect(listSrc).toContain("import InlineNotice from '../shared/InlineNotice.jsx'");
    expect(listSrc).toContain('<InlineNotice notice={notice} />');
    expect(loadAllSrc).toContain('loadCattleWeighInsCached(sb, {throwOnError: true})');
    expect(loadAllSrc).toContain("throw new Error('weigh_in_sessions: '");
    expect(loadAllSrc).toContain('Could not load cattle weigh-in sessions');
    expect(loadAllSrc).toContain('setSessions([]);');
    expect(loadAllSrc).toContain('setEntries({});');
  });
});

describe('SheepWeighInsView - cold-boot readiness', () => {
  const loadAllMatch = sheepListSrc.match(/async function loadAll\(\)[\s\S]*?\n {2}useEffect/);
  const loadAllSrc = loadAllMatch ? loadAllMatch[0] : '';

  it('never strands the sheep list readiness marker in Loading after a failed boot read', () => {
    expect(loadAllSrc).toContain('try {');
    expect(loadAllSrc).toContain('} catch (e) {');
    expect(loadAllSrc).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
  });

  it('surfaces sheep sessions/cache failures through InlineNotice and clears stale rows', () => {
    expect(sheepListSrc).toContain("import InlineNotice from '../shared/InlineNotice.jsx'");
    expect(sheepListSrc).toContain('<InlineNotice notice={notice} />');
    expect(loadAllSrc).toContain('loadSheepWeighInsCached(sb, {throwOnError: true})');
    expect(loadAllSrc).toContain("throw new Error('weigh_in_sessions: '");
    expect(loadAllSrc).toContain('Could not load sheep weigh-in sessions');
    expect(loadAllSrc).toContain('setSessions([]);');
    expect(loadAllSrc).toContain('setEntries({});');
  });
});

describe('Weigh-in list load-error states', () => {
  it('keeps failed reads non-dismissible with a retry action', () => {
    for (const src of [listSrc, sheepListSrc, livestockSrc]) {
      expect(src).toContain('const loadFailed = !!notice;');
      expect(src).toMatch(/\{loadFailed && \([\s\S]*?onClick=\{loadAll\}[\s\S]*?Retry/);
    }
  });

  it('does not render empty-state or rows while a load failure is active', () => {
    // CP2: rows render through the shared DataTable, still gated behind
    // !loadFailed (+ !loading). Cattle/sheep gate the empty-state on filtered
    // and render <DataTable> only when not failed.
    for (const src of [listSrc, sheepListSrc]) {
      expect(src).toMatch(/!loading && !loadFailed && filtered\.length === 0/);
      expect(src).toContain('<DataTable');
      expect(src).toMatch(/!loadFailed/);
    }
    // The shared pig/broiler list keeps the empty-state gated on visibleSessions
    // and renders the DataTable via a !loadFailed && !loading-gated IIFE.
    expect(livestockSrc).toMatch(/!loading && !loadFailed && visibleSessions\.length === 0/);
    expect(livestockSrc).toMatch(/!loadFailed &&\s*!loading &&/);
    expect(livestockSrc).toContain('<DataTable');
  });
});

describe('Weigh-in list empty-state parity', () => {
  const lists = [
    {name: 'CattleWeighInsView', src: listSrc, label: 'cattle'},
    {name: 'SheepWeighInsView', src: sheepListSrc, label: 'sheep'},
    {name: 'LivestockWeighInsView', src: livestockSrc, label: 'livestock'},
  ];

  for (const list of lists) {
    it(`${list.name} distinguishes no sessions from filtered-out sessions`, () => {
      expect(list.src).toContain("const emptyStateKind = sessions.length === 0 ? 'none' : 'filtered';");
      expect(list.src).toContain('data-weighin-empty-state="1"');
      expect(list.src).toContain('data-weighin-empty-kind={emptyStateKind}');
      expect(list.src).toContain('emptyStateMessage');
      expect(list.src).toContain('emptyStateHint');
      expect(list.src).toContain('Switch back to All to see every session.');
    });
  }

  it('cattle and sheep tag-search empty states point operators to clear search', () => {
    for (const src of [listSrc, sheepListSrc]) {
      expect(src).toMatch(/tagQ\s*\?\s*'No /);
      expect(src).toContain('+ tagSearch +');
      expect(src).toContain('Clear the tag search or switch back to All.');
    }
  });

  it('none-state copy is species-specific instead of the old generic message', () => {
    expect(listSrc).toContain('No cattle weigh-in sessions yet.');
    expect(sheepListSrc).toContain('No sheep weigh-in sessions yet.');
    expect(livestockSrc).toContain("speciesLabel.toLowerCase() + ' weigh-in sessions yet.'");
  });
});

describe('loadSheepWeighInsCached - strict read-failure contract', () => {
  it('accepts throwOnError without changing default callers', () => {
    expect(sheepCacheSrc).toContain('export async function loadSheepWeighInsCached(sb, opts = {})');
    expect(sheepCacheSrc).toContain('const throwOnError = !!opts.throwOnError');
  });

  it('throws on sessions and weigh_ins read failures only when requested', () => {
    expect(sheepCacheSrc).toMatch(/if \(sR\.error\)[\s\S]*?throw new Error\('loadSheepWeighInsCached sessions: '/);
    expect(sheepCacheSrc).toMatch(/if \(pageError\)[\s\S]*?throw new Error\('loadSheepWeighInsCached weigh_ins: '/);
    expect(sheepCacheSrc).toContain('return _sheepWeighInsCache || [];');
    expect(sheepCacheSrc).toContain('return _sheepWeighInsCache || rows;');
  });
});

describe('LivestockWeighInsView - CSV export (Lane K)', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  it('exports the current visible pig/broiler weigh-in sessions, not the raw session list', () => {
    expect(livestockSrc).toContain("from '../lib/csvExport.js'");
    expect(livestockSrc).toContain('function handleExportCsv');
    expect(livestockSrc).toContain('data-livestock-weighins-export-csv="1"');
    expect(livestockSrc).toContain('rowsToCsv(columns, filtered)');
    expect(livestockSrc).not.toContain('rowsToCsv(columns, sessions)');
  });

  it('keeps livestock weigh-in export columns useful for session review', () => {
    expect(livestockSrc).toContain('buildLivestockWeighInSessionColumns');
    for (const header of [
      'Date',
      'Species',
      'Batch ID',
      'Broiler week',
      'Status',
      'Team member',
      'Entry count',
      'Average weight',
      'Started at',
      'Session ID',
    ]) {
      expect(weighInSessionExportsSrc).toContain(`header: '${header}'`);
    }
  });

  it('keeps the export fallback browser-only and free of window.alert/confirm', () => {
    expect(livestockSrc).toContain('CSV export is only available in the browser.');
    expect(livestockSrc).not.toContain('window.alert');
    expect(livestockSrc).not.toContain('window.confirm');
  });
});
