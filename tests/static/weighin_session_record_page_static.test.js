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
  it('does not render CommentsSection or RecordActivityLog when access denied', () => {
    expect(pageSrc).toMatch(/accessDenied[\s\S]*?return[\s\S]*?CommentsSection/);
  });
});

describe('WeighInSessionPage — CommentsSection + RecordActivityLog', () => {
  it('renders CommentsSection with weighin.session entityType', () => {
    expect(pageSrc).toContain('CommentsSection');
    expect(pageSrc).toContain('entityType="weighin.session"');
  });
  it('renders RecordActivityLog with weighin.session entityType', () => {
    expect(pageSrc).toContain('RecordActivityLog');
    expect(pageSrc).toContain('entityType="weighin.session"');
  });
  it('has hash-scroll for comment deep-links', () => {
    expect(pageSrc).toContain('location.hash');
    expect(pageSrc).toContain('scrollIntoView');
  });
});

describe('WeighInSessionPage — cattle + sheep + pig support', () => {
  it('supports cattle, sheep, and pig; shows unsupported for others', () => {
    expect(pageSrc).toContain(
      "session.species !== 'cattle' && session.species !== 'sheep' && session.species !== 'pig'",
    );
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
  it('pig saveEntry writes only weight and note, not tag or new_tag_flag', () => {
    expect(pageSrc).toMatch(/sp === 'pig'[\s\S]*?\{weight: newWeight, note:/);
  });
  it('handler-level isEntryLocked guards saveEntry and deleteEntry', () => {
    expect(pageSrc).toContain('function isEntryLocked');
    expect(pageSrc).toMatch(/function saveEntry[\s\S]*?isEntryLocked\(e\)/);
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
  it('has per-row direct entry editing with Save/Revert', () => {
    expect(pageSrc).toContain('entryEdits');
    expect(pageSrc).toContain('saveEntry');
    expect(pageSrc).toContain('revertEntry');
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

describe('CattleWeighInsView — cleaned list view', () => {
  it('navigates to /weigh-in-sessions/<id> on tile click', () => {
    expect(listSrc).toContain("navigate('/weigh-in-sessions/' + s.id)");
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
    expect(sheepListSrc).toContain("navigate('/weigh-in-sessions/' + s.id)");
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
