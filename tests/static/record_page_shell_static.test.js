import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const shell = fs.readFileSync(path.join(ROOT, 'src/shared/RecordPageShell.jsx'), 'utf8');

// Every operational record page migrated onto the shared chrome (CP1 animal +
// daily pages, CP2 batch/processing/housing pages, CP3 weigh-in session page,
// Lane E closure pig batch page).
const pages = [
  {name: 'CattleAnimalPage', path: 'src/cattle/CattleAnimalPage.jsx'},
  {name: 'SheepAnimalPage', path: 'src/sheep/SheepAnimalPage.jsx'},
  {name: 'PoultryDailyPage', path: 'src/broiler/PoultryDailyPage.jsx'},
  {name: 'LayerDailyPage', path: 'src/layer/LayerDailyPage.jsx'},
  {name: 'EggDailyPage', path: 'src/layer/EggDailyPage.jsx'},
  {name: 'PigDailyPage', path: 'src/pig/PigDailyPage.jsx'},
  {name: 'CattleDailyPage', path: 'src/cattle/CattleDailyPage.jsx'},
  {name: 'SheepDailyPage', path: 'src/sheep/SheepDailyPage.jsx'},
  {name: 'CattleBatchPage', path: 'src/cattle/CattleBatchPage.jsx'},
  {name: 'SheepBatchPage', path: 'src/sheep/SheepBatchPage.jsx'},
  {name: 'LayerBatchPage', path: 'src/layer/LayerBatchPage.jsx'},
  {name: 'LayerHousingPage', path: 'src/layer/LayerHousingPage.jsx'},
  {name: 'BroilerBatchPage', path: 'src/broiler/BroilerBatchPage.jsx'},
  {name: 'WeighInSessionPage', path: 'src/livestock/WeighInSessionPage.jsx'},
  {name: 'PigBatchPage', path: 'src/pig/PigBatchPage.jsx'},
];
const srcs = {};
for (const p of pages) {
  srcs[p.name] = fs.readFileSync(path.join(ROOT, p.path), 'utf8');
}

describe('RecordPageShell — exported primitives', () => {
  for (const name of [
    'RecordPageFrame',
    'RecordPageLoading',
    'RecordPageNotFound',
    'RecordPageBody',
    'RecordBackLink',
    'RecordTitle',
  ]) {
    it(`exports ${name}`, () => {
      expect(shell).toContain(`export function ${name}(`);
    });
  }
});

describe('RecordPageShell — owns the shared chrome markup', () => {
  it('renders the optional Header inside the app frame', () => {
    expect(shell).toContain('{Header && <Header />}');
  });
  it('uses the full-height neutral app background', () => {
    expect(shell).toContain("minHeight: '100vh'");
    expect(shell).toContain("background: '#f1f3f2'");
  });
  it('owns the data-record-title marker', () => {
    expect(shell).toContain('data-record-title="1"');
  });
  it('makes RecordTitle fontSize and margin configurable with CP1 defaults', () => {
    // Animal/daily pages keep 26 / '0 0 12px'; batch title rows opt into 24 / 0.
    expect(shell).toMatch(/RecordTitle\(\{[^}]*fontSize = 26[^}]*margin = '0 0 12px'[^}]*\}\)/);
  });
  it('defaults the content body to maxWidth 800', () => {
    expect(shell).toContain('maxWidth = 800');
  });
  it('keeps the body maxWidth configurable and merges an optional style last (margin/padding preserved)', () => {
    expect(shell).toMatch(/RecordPageBody\(\{[^}]*maxWidth = 800[^}]*style[^}]*\}\)/);
    expect(shell).toContain("margin: '0 auto'");
    expect(shell).toContain("padding: '12px 16px'");
    expect(shell).toContain('...style}}');
  });
  it('spreads extra props onto the body wrapper (page-specific data attrs)', () => {
    expect(shell).toContain('<div {...rest}');
  });
  it('forwards extra props through the frame + not-found (state-specific data attrs)', () => {
    expect(shell).toMatch(/RecordPageFrame\(\{Header, children, \.\.\.rest\}\)/);
    expect(shell).toMatch(/RecordPageNotFound\(\{Header, backLabel, onBack, message, \.\.\.rest\}\)/);
  });
  it('defaults the loading label to the ellipsis form', () => {
    expect(shell).toContain("label = 'Loading…'");
  });
  it('forwards extra props through the loading frame (state markers)', () => {
    expect(shell).toMatch(/RecordPageLoading\(\{Header, label = 'Loading…', \.\.\.rest\}\)/);
    expect(shell).toMatch(/<RecordPageFrame Header=\{Header\} \{\.\.\.rest\}>/);
  });
  it('renders an arrow before the back label', () => {
    expect(shell).toContain("{'← '}");
  });
  it('gives the loaded back link a heavier weight than the not-found link', () => {
    expect(shell).toContain('fontWeight: 500');
  });
});

describe('RecordPageShell — stays presentational', () => {
  it('imports nothing (cannot reach Supabase, routing, Comments, or Activity)', () => {
    // Pure JSX + the automatic runtime — no React import needed, no other deps.
    const imports = shell.match(/^import .*/gm) || [];
    expect(imports).toHaveLength(0);
  });
  it('does not render sequence nav, collaboration, or call routing hooks itself', () => {
    // Code-shape checks (angle bracket / call paren) so the explanatory header
    // comment, which names these by prose, does not trip the assertion.
    expect(shell).not.toContain('<RecordSequenceNav');
    expect(shell).not.toContain('<RecordCollaborationSection');
    expect(shell).not.toContain('useNavigate(');
    expect(shell).not.toContain('entityType=');
  });
});

describe('Migrated record pages — use the shared chrome, not inline copies', () => {
  for (const p of pages) {
    const src = srcs[p.name];
    it(`${p.name} imports the shared shell primitives`, () => {
      expect(src).toContain("from '../shared/RecordPageShell.jsx'");
      expect(src).toContain('<RecordPageFrame');
      expect(src).toContain('<RecordPageBody');
    });
    it(`${p.name} no longer hand-rolls the frame, title, or content wrapper`, () => {
      expect(src).not.toContain("minHeight: '100vh'");
      expect(src).not.toContain('data-record-title="1"');
      expect(src).not.toContain('maxWidth: 800');
    });
    it(`${p.name} still hands Header to the shared chrome`, () => {
      expect(src).toContain('Header={Header}');
    });
  }
});
