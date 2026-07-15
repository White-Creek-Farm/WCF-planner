import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/webforms/WeighInsWebform.jsx'), 'utf8');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const code = stripComments(src);

// The weigh-ins select stage regressed once before: the species selects were
// labelled by unassociated sibling <label>s, so they had NO accessible name —
// screen readers announced a bare combobox and Playwright getByLabel could
// never match (the offline_queue_weigh_ins pig cluster failed on exactly
// this). Lock the htmlFor/id association for all four species selects so a
// markup refactor cannot silently reintroduce the gap.
describe('WeighInsWebform — accessible species-select label associations', () => {
  const PAIRS = [
    ['Herd \\*', 'weighins-cattle-herd'],
    ['Pig Batch \\*', 'weighins-pig-batch'],
    ['Broiler Batch \\*', 'weighins-broiler-batch'],
    ['Flock \\*', 'weighins-sheep-flock'],
  ];

  for (const [labelText, id] of PAIRS) {
    it(`associates the "${labelText.replace('\\', '')}" label with #${id}`, () => {
      // The visible label text is carried by a <label htmlFor> pointing at
      // the control id...
      expect(code).toMatch(new RegExp(`<label[^>]*htmlFor="${id}"[^>]*>\\s*${labelText}\\s*</label>`));
      // ...and exactly one <select> carries that id, with no duplicate
      // htmlFor/id claims elsewhere in the file.
      expect(code.match(new RegExp(`<select\\s+id="${id}"`, 'g'))).toHaveLength(1);
      expect(code.match(new RegExp(`(?<!htmlFor=")\\bid="${id}"`, 'g'))).toHaveLength(1);
      expect(code.match(new RegExp(`htmlFor="${id}"`, 'g'))).toHaveLength(1);
    });
  }

  it('keeps the broiler schooner-mirror marker meaning "settled", success or failure', () => {
    // startNewSession fails closed when labels are empty; the marker only
    // reports that the mirror read finished, so tests/deploy checks can wait
    // deterministically without treating failure as readiness.
    // Each request starts by clearing the previous mirror THEN dropping the
    // loaded flag, before the read fires — a failed retry can never reuse
    // stale schooner metadata to allow Start Session.
    expect(code).toMatch(
      /setBroilerBatchMeta\(\[\]\);\s*setBroilerBatchMetaLoaded\(false\);\s*sb\s*\.from\('webform_config'\)/,
    );
    expect(code).toMatch(/\.finally\(\(\) => setBroilerBatchMetaLoaded\(true\)\)/);
    expect(code).toMatch(/\.catch\(\(\) => \{/);
    expect(code).toMatch(/data-weighins-broiler-meta-loaded=\{broilerBatchMetaLoaded \? '1' : undefined\}/);
    // No success-path-only loaded flip remains.
    expect(code).not.toMatch(/setBroilerBatchMeta\(data\.data\);\s*setBroilerBatchMetaLoaded\(true\)/);
  });
});
