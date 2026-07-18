import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static guards for the pig trip-sex lane in Processing Source details:
//   1) Sex is CANONICAL data — resolved from the record's reconcile-stamped
//      sub_batch_attribution (exact linked trip, single-sex trip-chain
//      contract), displayed with singular Gilt/Boar labels, never inferred
//      client-side from weight/position/title/free text.
//   2) Processing stays READ-ONLY for this source fact: no editable sex
//      control exists anywhere in the drawer.
//   3) The pig weights table shows Pig | Sex | Live weight with the stable
//      Pig 1..N labels; cattle/sheep/broiler Source details (including the
//      CC#1 cattle projected roster) are untouched.
// Behavior proofs live in src/lib/processingSourceLink.test.js.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const drawer = read('src/processing/ProcessingDrawer.jsx');
const helper = read('src/lib/processingSourceLink.js');

describe('canonical resolution', () => {
  it('sex resolves ONLY from the stored trip attribution via pigTripSexLabel', () => {
    expect(helper).toMatch(/export function pigTripSexLabel\(record\)/);
    expect(helper).toMatch(/record\.sub_batch_attribution/);
    // Singular display labels; fail-closed on unknown/conflicting vocabulary.
    expect(helper).toContain("labels.add('Boar')");
    expect(helper).toContain("labels.add('Gilt')");
    expect(helper).toMatch(/return null; \/\/ unknown vocabulary — never guess/);
    expect(helper).toMatch(/labels\.size === 1 \? \[\.\.\.labels\]\[0\] : null/);
    // The drawer consumes the helper — it never derives sex on its own.
    expect(drawer).toContain('pigTripSexLabel,');
    expect(drawer).toContain('const pigSexLabel = pigTripSexLabel(record);');
  });

  it('the drawer never infers sex from weights, position, titles, or free text', () => {
    // The drawer performs NO sex derivation of its own: it never touches a
    // .sex property (that read lives only inside pigTripSexLabel) and the
    // one resolver call is the single sex source for the roster column.
    expect(drawer).not.toMatch(/\.sex\b/);
    expect(drawer.match(/pigTripSexLabel\(/g)).toHaveLength(1);
    expect(drawer.match(/\bpigSexLabel\b/g)).toHaveLength(2); // declare + roster column
  });
});

describe('read-only presentation', () => {
  it('the standalone trip-level Sex FieldRow is REMOVED (2026-07-18 amendment); sex is roster-only and read-only', () => {
    // The redundant summary row between Trip and Processing date is gone —
    // per-pig sex lives exclusively in the roster's Sex column below.
    expect(drawer).not.toMatch(/<FieldRow label="Sex">/);
    // No editable sex control anywhere: no select/input/checkbox is bound to
    // sex, and no mutation payload carries a sex field.
    expect(drawer).not.toMatch(/<(select|input|textarea)[^>]*[Ss]ex/);
    expect(drawer).not.toMatch(/data-processing-[a-z-]*sex[a-z-]*-(select|input|edit)/);
    expect(drawer).not.toMatch(/set[A-Za-z]*Sex/);
  });

  it('pig weights table is Pig | Sex | Live weight with stable Pig 1..N labels', () => {
    expect(drawer).toMatch(
      /\{key: 'pig', label: 'Pig', render: \(_a, i\) => `Pig \$\{i \+ 1\}`\},\s*\{key: 'sex', label: 'Sex', render: \(\) => pigSexLabel\},\s*\{key: 'live', label: 'Live weight', align: 'right', render: \(a\) => weightText\(a\.live_weight\)\},/,
    );
  });
});

describe('other programs unchanged', () => {
  it('cattle/sheep animal table keeps its exact columns (no Sex column)', () => {
    expect(drawer).toMatch(
      /\{key: 'tag', label: 'Tag', render: \(a\) => a\.tag\},\s*\{key: 'age', label: 'Age', render: \(a\) => yearsMonthsText\(a\.age_days\)\},\s*\{key: 'live', label: 'Live weight', align: 'right', render: \(a\) => weightText\(a\.live_weight\)\},\s*\{key: 'hang', label: 'Hanging weight', align: 'right', render: \(a\) => weightText\(a\.hanging_weight\)\},/,
    );
  });

  it('the CC#1 cattle projected roster path is untouched', () => {
    expect(drawer).toContain('<CattleProjectedSourceRoster sb={sb} batchId={record.source_id} />');
    expect(drawer).toContain('loadProjectedRosterForScheduledBatch');
  });

  it('broiler Source details gain no sex row', () => {
    const broilerBlock = drawer.slice(
      drawer.indexOf("{kind === 'broiler' && ("),
      drawer.indexOf("{(kind === 'cattle'"),
    );
    expect(broilerBlock).toContain('label="Batch"');
    expect(broilerBlock).not.toMatch(/[Ss]ex/);
  });
});
