import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static locks for the pig drawer title simplification (2026-07-18):
//   • the drawer title renders through displayRecordTitle — pig planner
//     records display '<batch> · Trip <n>' (no 'Pig Trip · ' prefix) while
//     every other kind stays byte-identical and the formatter fails closed
//     to the stored title;
//   • the standalone pig Trip Source-details row is gone (the trip number
//     lives in the title); the Batch row remains;
//   • the schedule's separate Batch/Trip columns, View-pig-trip routing,
//     carcass yield, and the Pig | Sex | Live weight roster are untouched;
//   • presentation-only: stored titles, reconcile SQL, source ids, and
//     search contracts are unchanged.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const drawer = read('src/processing/ProcessingDrawer.jsx');
const helper = read('src/lib/processingSourceLink.js');
const view = read('src/processing/ProcessingCalendarView.jsx');

const pigBlock = drawer.slice(drawer.indexOf("{kind === 'pig' && ("), drawer.indexOf('{/* Apply-template preview'));

describe('drawer title', () => {
  it('renders through the presentation-only displayRecordTitle formatter', () => {
    expect(drawer).toContain('displayRecordTitle,');
    expect(drawer).toContain('{displayRecordTitle(record)}');
    // The raw stored title no longer renders directly in the h2.
    expect(drawer).not.toMatch(/<h2[^>]*>\{record\.title\}<\/h2>/);
  });

  it('the formatter is pig-planner-only and fails closed to the stored title', () => {
    expect(helper).toContain('export function displayRecordTitle(record)');
    expect(helper).toContain(
      "if (record.source_kind !== 'pig' || record.record_type !== 'planner_batch') return record.title || '';",
    );
    expect(helper).toContain(
      "if (!name || ordinal == null || !Number.isFinite(Number(ordinal))) return record.title || '';",
    );
    expect(helper).toContain('return `${name} · Trip ${ordinal}`;');
  });
});

describe('pig Source details', () => {
  it('the standalone Trip row is gone; the Batch row remains', () => {
    expect(drawer).not.toContain('<FieldRow label="Trip">');
    expect(pigBlock).toContain('<FieldRow label="Batch">');
    expect(pigBlock).toMatch(/standalone Trip row was removed/);
  });

  it('carcass yield and the Pig | Sex | Live weight roster are untouched', () => {
    expect(pigBlock).toContain('renderCarcassYield(');
    expect(pigBlock).toContain('summarizeCarcassYield({');
    expect(drawer).toMatch(
      /\{key: 'pig', label: 'Pig', render: \(_a, i\) => `Pig \$\{i \+ 1\}`\},\s*\{key: 'sex', label: 'Sex', render: \(\) => pigSexLabel\},\s*\{key: 'live', label: 'Live weight', align: 'right', render: \(a\) => weightText\(a\.live_weight\)\},/,
    );
  });

  it('View pig trip navigation is unchanged (exact groupId:tripId route)', () => {
    expect(drawer).toContain('sourceRouteForRecord');
    expect(drawer).toContain('sourceLinkLabel(record)');
    expect(helper).toContain('`/pig/batches/${groupId}?trip=${encodeURIComponent(tripId)}`');
  });
});

describe('untouched surfaces', () => {
  it('the schedule keeps its separate pig Batch and Trip columns', () => {
    expect(view).toMatch(/trip: \{key: 'trip', label: 'Trip', width: '64px'\}/);
    expect(view).toContain("pig: ['batch', 'trip', 'status', 'processing', 'processor', 'count', 'age']");
    expect(view).toContain('function renderTripCell(');
  });

  it('stored titles / reconcile SQL / search contracts are not touched by this lane', () => {
    // The SQL convention stays exactly as migration 178 wrote it.
    const mig178 = read('supabase-migrations/178_processing_legacy_liveweights.sql');
    expect(mig178).toContain("RETURN 'Pig Trip · ' || v_name || ' · Trip ' || COALESCE(p_rec.trip_ordinal, 0);");
    // The schedule still searches/renders via the server payload fields.
    expect(view).toContain('r.search_text');
  });
});
