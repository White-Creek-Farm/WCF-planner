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
    expect(src).toContain("updTrip('pigCount'");
    expect(src).toContain("updTrip('liveWeights'");
    expect(src).toContain("updTrip('hangingWeight'");
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

// Lane E CP1 — the routed pig batch record adopts the shared RecordPageBody
// wrapper + a locked loaded marker, WITHOUT taking over Header/frame/loading/
// not-found ownership (those stay in PigBatchesView, which already renders the
// combined hub/record Header). Per the ratified CP1 ruling: RecordPageBody
// only, no RecordTitle (would duplicate the colored batch header), and no
// RecordPageFrame/Loading/NotFound conversion.
describe('Lane E CP1: PigBatchPage adopts the shared RecordPageBody chrome', () => {
  it('imports RecordPageBody from the shared record-page shell', () => {
    expect(src).toMatch(/import\s*\{\s*RecordPageBody\s*\}\s*from\s*'\.\.\/shared\/RecordPageShell\.jsx'/);
  });

  it('wraps the loaded record content in RecordPageBody', () => {
    expect(src).toContain('<RecordPageBody');
    expect(src).toContain('</RecordPageBody>');
  });

  it('exposes the locked loaded marker only on the RecordPageBody wrapper', () => {
    expect(src).toMatch(/<RecordPageBody[\s\S]*?data-pig-batch-record-loaded="true"/);
  });

  it('keeps the body LEFT-aligned (CP1 exception) so it lines up under the PigBatchesView back link', () => {
    // Pig owns the back link + RecordSequenceNav in PigBatchesView, OUTSIDE this
    // body. The default centered margin:'0 auto' would detach the card from the
    // far-left back link, so CP1 overrides to margin:0 + zero horizontal padding
    // (also avoids double mobile inset under PigBatchesView's 1rem padding).
    const body = src.match(/<RecordPageBody[\s\S]*?>/);
    expect(body).not.toBeNull();
    expect(body[0]).toContain('margin: 0');
    expect(body[0]).toContain('paddingLeft: 0');
    expect(body[0]).toContain('paddingRight: 0');
  });

  it('does NOT add RecordTitle (the colored batch header is preserved as the record title in CP1)', () => {
    expect(src).not.toContain('RecordTitle');
  });

  it('does NOT take over Header/frame/loading/not-found ownership (stays in PigBatchesView)', () => {
    expect(src).not.toContain('RecordPageFrame');
    expect(src).not.toContain('RecordPageLoading');
    expect(src).not.toContain('RecordPageNotFound');
    expect(src).not.toContain('Header={Header}');
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
