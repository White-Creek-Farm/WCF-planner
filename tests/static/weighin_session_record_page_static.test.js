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
const sheepCacheSrc = fs.readFileSync(path.join(ROOT, 'src/lib/sheepCache.js'), 'utf8');
const pigEntryBranchStart = pageSrc.indexOf('if (isPig) {');
const pigEntryBranchEnd = pageSrc.indexOf('const cow = animals.find', pigEntryBranchStart);
const pigEntryBranch = pageSrc.slice(pigEntryBranchStart, pigEntryBranchEnd);
const cattleSheepEntryBranchStart = pageSrc.indexOf('const cow = animals.find', pigEntryBranchEnd);
const cattleSheepEntryBranchEnd = pageSrc.indexOf(
  '<span style={{fontSize: 11, fontWeight: 600',
  cattleSheepEntryBranchStart,
);
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
  it('renders sent-to-trip badge for pig entries', () => {
    expect(pageSrc).toContain('sent_to_trip_id');
    expect(pageSrc).toContain('Sent to trip');
  });
  it('renders transferred badge for pig entries', () => {
    expect(pageSrc).toContain('transferred_to_breeding');
    expect(pageSrc).toContain('Transferred');
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
  it('sendEntriesToTrip checks app_store upsert before stamping', () => {
    expect(pageSrc).toMatch(/sendEntriesToTrip[\s\S]*?upsertErr[\s\S]*?stampFailed/);
  });
  it('sendEntriesToTrip throws on stamp failure instead of closing modal', () => {
    expect(pageSrc).toMatch(/stampFailed[\s\S]*?throw new Error/);
  });
  it('sendEntriesToTrip throws on app_store upsert failure before any setTripModal(null)', () => {
    expect(pageSrc).toMatch(/upsertErr[\s\S]*?throw new Error[\s\S]*?setTripModal\(null\)/);
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
  it('logs record.deleted on session delete', () => {
    expect(pageSrc).toContain("eventType: 'record.deleted'");
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
  it('delete-entry checks delete error before logging record.deleted', () => {
    expect(pageSrc).toMatch(/\.delete\(\)\.eq\('id', e\.id\)[\s\S]*?if \(!error\)[\s\S]*?record\.deleted/);
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

describe('WeighInSessionPage — broiler record page', () => {
  it('loadAll allows species broiler', () => {
    expect(pageSrc).toContain("sp !== 'broiler'");
  });
  it('loads ppp-v4 for broiler batch recs', () => {
    expect(pageSrc).toContain("'ppp-v4'");
    expect(pageSrc).toContain('broilerBatchRecs');
  });
  it('loads active roster for broiler', () => {
    expect(pageSrc).toContain('loadRoster');
    expect(pageSrc).toContain('activeRoster');
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
    expect(pageSrc).toContain('broiler-meta-team');
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
  it('preserves retired team member in dropdown', () => {
    expect(pageSrc).toContain("(retired)'");
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
  it('tiles have data-weighin-session-tile marker', () => {
    expect(livestockSrc).toContain('data-weighin-session-tile');
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

  it('does not render empty-state or tiles while a load failure is active', () => {
    for (const src of [listSrc, sheepListSrc, livestockSrc]) {
      expect(src).toMatch(/!loading && !loadFailed && filtered\.length === 0/);
      expect(src).toMatch(/!loadFailed &&\s*filtered\.map/);
    }
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
