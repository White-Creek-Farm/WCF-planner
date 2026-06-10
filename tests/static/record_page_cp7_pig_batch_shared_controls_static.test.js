import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Record Page Visual Consistency CP7 — PigBatchPage's contained editable form
// surfaces (mortality entry modal, sub-batch add/edit form, processing trip
// form) adopt the shared record-page control styling, becoming single-column +
// mobile-legible, WITHOUT changing pig batch behavior: mortality save/delete,
// sub-batch updSub/closeSubForm/deleteSubBatch, processing-trip
// updTrip/closeTripForm/deleteTrip, planned-trip lock/add/edit controls,
// PigContext ownership, ledger/FCR/yield math, Comments/Activity, and routing
// are all unchanged. The compact inline planned-trip add/edit controls keep
// their dense fixed-width inline styling (recordControl would break that row).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchPage.jsx'), 'utf8');

describe('CP7: PigBatchPage adopts shared record-page controls', () => {
  it('imports the shared control primitives', () => {
    expect(src).toContain("from '../shared/recordPageControls.jsx'");
    for (const name of ['recordFieldRowClass', 'recordFieldLabel', 'recordControl', 'recordTextarea']) {
      expect(src).toContain(name);
    }
  });

  it('styles the contained form controls with the shared primitives', () => {
    expect(src).toContain('style={recordControl}');
    expect(src).toContain('style={recordTextarea}');
    expect(src).toContain('<span style={recordFieldLabel}>');
    // mortality (3) + sub-batch (4) + trip (5) = 12 migrated field rows.
    const rows = src.match(/className=\{recordFieldRowClass\}/g) || [];
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });

  it('drops the old S.label styling but keeps S for buttons', () => {
    expect(src).not.toContain('S.label');
    expect(src).toContain("import {S} from '../lib/styles.js'");
    expect(src).toContain('S.btnDanger');
  });

  it('preserves the mortality modal save path', () => {
    expect(src).toContain('saveMortality');
    expect(src).toContain('mortalityForm');
    expect(src).toContain('setMortalityForm');
  });

  it('preserves the sub-batch form handlers', () => {
    expect(src).toContain('updSub(g.id');
    expect(src).toContain('closeSubForm(g.id)');
    expect(src).toContain('deleteSubBatch(g.id');
  });

  it('preserves the processing trip form handlers', () => {
    expect(src).toContain("updTrip('date'");
    expect(src).toContain("updTrip('hangingWeight'");
    expect(src).toContain("updTrip('notes'");
    expect(src).toContain('tripSourceSummary(editTripId)');
    expect(src).toContain('data-pig-trip-source-weights');
    expect(src).not.toContain("updTrip('liveWeights'");
    expect(src).not.toContain("updTrip('pigCount'");
    expect(src).toContain('closeTripForm');
    expect(src).toContain('deleteTrip(g.id');
  });

  it('keeps the compact inline planned-trip controls and their data attributes', () => {
    for (const attr of [
      'data-planned-trip-add-shell',
      'data-planned-trip-add-date',
      'data-planned-trip-add-count',
      'data-planned-trip-add-save',
      'data-planned-trip-date-input',
    ]) {
      expect(src).toContain(attr);
    }
    // The inline add/edit row keeps its dense fixed widths (not recordControl).
    expect(src).toContain('width: 132');
    expect(src).toContain('🔒 Lock');
  });

  it('keeps RecordCollaborationSection mounted for the pig.batch entity (identity unchanged)', () => {
    expect(src).toContain('RecordCollaborationSection');
    expect(src).toContain('entityType="pig.batch"');
  });
});

// Lane E closure — the routed pig batch record now owns the full shared
// record-page frame + body + title stack while preserving the heavier pig
// workflow. PigBatchesView remains the hub/router and composes shared
// loading/not-found states for deep links.
describe('Lane E: PigBatchPage owns shared record-page chrome', () => {
  it('imports the shared record-page shell primitives', () => {
    expect(src).toMatch(
      /import\s*\{\s*RecordPageFrame,\s*RecordPageBody,\s*RecordBackLink,\s*RecordTitle\s*\}\s*from\s*'\.\.\/shared\/RecordPageShell\.jsx'/,
    );
    expect(src).toContain("import RecordSequenceNav from '../shared/RecordSequenceNav.jsx'");
  });

  it('wraps the loaded record content in RecordPageFrame and RecordPageBody', () => {
    expect(src).toContain('<RecordPageFrame Header={Header}');
    expect(src).toContain('<RecordPageBody');
    expect(src).toContain('</RecordPageFrame>');
    expect(src).toContain('</RecordPageBody>');
  });

  it('exposes the locked loaded marker only on the RecordPageBody wrapper', () => {
    expect(src).toMatch(/<RecordPageBody[\s\S]*?data-pig-batch-record-loaded="true"/);
  });

  it('renders Back, sequence nav, and RecordTitle inside the loaded body', () => {
    const bodyMatch = src.match(/<RecordPageBody[\s\S]*?<\/RecordPageBody>/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch[0]).toContain('<RecordBackLink');
    expect(bodyMatch[0]).toContain('<RecordSequenceNav');
    expect(bodyMatch[0]).toContain('<RecordTitle>');
    expect(bodyMatch[0]).toContain('onBack={onBack}');
    expect(bodyMatch[0]).toContain('currentId={recordId || group.id}');
  });

  it('uses the default centered RecordPageBody instead of the retired left-aligned exception', () => {
    const body = src.match(/<RecordPageBody[\s\S]*?>/);
    expect(body).not.toBeNull();
    expect(body[0]).not.toContain('margin: 0');
    expect(body[0]).not.toContain('paddingLeft: 0');
    expect(body[0]).not.toContain('paddingRight: 0');
  });

  it('takes Header/frame ownership for the loaded record', () => {
    expect(src).toContain('Header={Header}');
    expect(src).not.toContain('RecordPageLoading');
    expect(src).not.toContain('RecordPageNotFound');
  });

  it('PigBatchesView composes shared loading/not-found states without duplicating Header on records', () => {
    const view = fs.readFileSync(path.join(ROOT, 'src/pig/PigBatchesView.jsx'), 'utf8');
    expect(view).toContain("from '../shared/RecordPageShell.jsx'");
    expect(view).toContain('<RecordPageLoading Header={Header}');
    expect(view).toContain('<RecordPageNotFound');
    expect(view).toContain('{!recordMode && <Header />}');
    expect(view).toContain('Header={Header}');
  });

  it('keeps the collaboration mount inside the shared body (identity unchanged)', () => {
    // RecordCollaborationSection must remain inside the loaded RecordPageBody
    // wrapper so the pig.batch comments/activity composer renders with the
    // record, not as a detached sibling.
    const bodyMatch = src.match(/<RecordPageBody[\s\S]*?<\/RecordPageBody>/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch[0]).toContain('RecordCollaborationSection');
    expect(bodyMatch[0]).toContain('entityType="pig.batch"');
  });
});
