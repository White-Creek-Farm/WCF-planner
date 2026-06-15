import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Lane 0 correctness guard: InlineNotice has one canonical prop shape
// (notice={{kind, message}} + onDismiss). Several call sites historically
// passed flat kind=/message= props (and onClose), which made InlineNotice
// render nothing because the component reads `notice.message`. This guard
// locks the canonical call shape, the benign `info` kind, and the cattle
// forecast CowDetail Issues-panel suppression.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const inlineNotice = read('src/shared/InlineNotice.jsx');
const cattleAnimal = read('src/cattle/CattleAnimalPage.jsx');
const sheepAnimal = read('src/sheep/SheepAnimalPage.jsx');
const forecast = read('src/cattle/CattleForecastView.jsx');
const cowDetail = read('src/cattle/CowDetail.jsx');

// Call sites that must use the canonical notice={...} shape.
// (MySubmissions was rebuilt into a no-data "View Past Reports" navigation hub
// in commit a56e57e and no longer renders InlineNotice at all, so it is no
// longer a call site.)
const CALL_SITES = [
  ['src/cattle/CattleAnimalPage.jsx', cattleAnimal],
  ['src/sheep/SheepAnimalPage.jsx', sheepAnimal],
];

describe('InlineNotice — component shape and info kind', () => {
  it('reads notice.message and renders nothing without a message', () => {
    expect(inlineNotice).toContain('if (!notice || !notice.message) return null;');
  });

  it('maps the benign info kind so it does not fall through to error styling', () => {
    expect(inlineNotice).toContain("else if (notice.kind === 'info') kind = 'info';");
  });

  it('gives the info kind its own (blue) palette branch', () => {
    expect(inlineNotice).toMatch(/kind === 'info'\s*\?\s*\{bg: '#eff6ff', border: '#bfdbfe', fg: '#1e40af'\}/);
  });

  it('documents info in the shape comment', () => {
    expect(inlineNotice).toContain("'error' | 'warning' | 'success' | 'info'");
  });

  it('emits the resolved kind on data-inline-notice (so info is queryable)', () => {
    expect(inlineNotice).toContain('data-inline-notice={kind}');
  });
});

describe('InlineNotice — canonical call shape at fixed sites', () => {
  for (const [name, src] of CALL_SITES) {
    it(`${name} never passes flat message= to InlineNotice`, () => {
      // The component has no `message` prop; flat message=/kind= silently render nothing.
      expect(src).not.toMatch(/<InlineNotice\b[^>]*\bmessage=/);
    });

    it(`${name} never passes onClose= to InlineNotice (prop is onDismiss)`, () => {
      expect(src).not.toMatch(/<InlineNotice\b[^>]*\bonClose=/);
    });
  }

  it('CattleAnimalPage passes the notice object, not flat kind/message', () => {
    expect(cattleAnimal).toContain('<InlineNotice notice={notice} onDismiss={() => setNotice(null)} />');
  });

  it('SheepAnimalPage passes the notice object, not flat kind/message', () => {
    expect(sheepAnimal).toContain('<InlineNotice notice={notice} onDismiss={() => setNotice(null)} />');
  });
});

describe('Cattle forecast — legacy CowDetail Issues panel suppressed', () => {
  it('CowDetail gates the legacy Issues panel behind hideComments', () => {
    expect(cowDetail).toMatch(/\{!hideComments &&[\s\S]{0,400}>Issues</);
  });

  it('CattleForecastView passes hideComments to its expanded CowDetail', () => {
    expect(forecast).toMatch(/<CowDetail\b[\s\S]*?hideComments=\{true\}[\s\S]*?\/>/);
  });
});
