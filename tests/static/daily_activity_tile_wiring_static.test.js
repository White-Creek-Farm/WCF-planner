import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ENTITY_TYPES, ACTIVITY_REGISTRY} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const broilerDailys = fs.readFileSync(path.join(ROOT, 'src/broiler/BroilerDailysView.jsx'), 'utf8');
const layerDailys = fs.readFileSync(path.join(ROOT, 'src/layer/LayerDailysView.jsx'), 'utf8');
const eggDailys = fs.readFileSync(path.join(ROOT, 'src/layer/EggDailysView.jsx'), 'utf8');
const pigDailys = fs.readFileSync(path.join(ROOT, 'src/pig/PigDailysView.jsx'), 'utf8');
const cattleDailys = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleDailysView.jsx'), 'utf8');
const sheepDailys = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDailysView.jsx'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');

const poultryPage = fs.readFileSync(path.join(ROOT, 'src/broiler/PoultryDailyPage.jsx'), 'utf8');
const pigPage = fs.readFileSync(path.join(ROOT, 'src/pig/PigDailyPage.jsx'), 'utf8');
const cattlePage = fs.readFileSync(path.join(ROOT, 'src/cattle/CattleDailyPage.jsx'), 'utf8');
const sheepPage = fs.readFileSync(path.join(ROOT, 'src/sheep/SheepDailyPage.jsx'), 'utf8');
const layerPage = fs.readFileSync(path.join(ROOT, 'src/layer/LayerDailyPage.jsx'), 'utf8');
const eggPage = fs.readFileSync(path.join(ROOT, 'src/layer/EggDailyPage.jsx'), 'utf8');

const DAILY_TYPES = ['poultry.daily', 'layer.daily', 'egg.daily', 'pig.daily', 'cattle.daily', 'sheep.daily'];

describe('activityRegistry — daily entity types', () => {
  for (const t of DAILY_TYPES) {
    it(`exports ${t} in ENTITY_TYPES`, () => {
      expect(Object.values(ENTITY_TYPES)).toContain(t);
    });

    it(`has registry entry for ${t}`, () => {
      expect(ACTIVITY_REGISTRY[t]).toBeTruthy();
      expect(typeof ACTIVITY_REGISTRY[t].route).toBe('function');
    });

    it(`${t} route includes the record ID`, () => {
      const route = ACTIVITY_REGISTRY[t].route('test-id');
      expect(route).toContain('test-id');
    });
  }
});

describe('Daily views — retired legacy Activity UI', () => {
  const views = [
    {name: 'BroilerDailysView', src: broilerDailys},
    {name: 'LayerDailysView', src: layerDailys},
    {name: 'EggDailysView', src: eggDailys},
    {name: 'PigDailysView', src: pigDailys},
    {name: 'CattleDailysView', src: cattleDailys},
    {name: 'SheepDailysView', src: sheepDailys},
  ];

  for (const v of views) {
    it(`${v.name} does not import ActivityPanel`, () => {
      expect(v.src).not.toMatch(/^import ActivityPanel/m);
    });
    it(`${v.name} does not import ActivityModal`, () => {
      expect(v.src).not.toMatch(/^import ActivityModal/m);
    });
  }
});

describe('Daily views — navigate to record page', () => {
  const views = [
    {name: 'BroilerDailysView', src: broilerDailys, path: '/broiler/dailys/'},
    {name: 'PigDailysView', src: pigDailys, path: '/pig/dailys/'},
    {name: 'CattleDailysView', src: cattleDailys, path: '/cattle/dailys/'},
    {name: 'SheepDailysView', src: sheepDailys, path: '/sheep/dailys/'},
    {name: 'LayerDailysView', src: layerDailys, path: '/layer/dailys/'},
    {name: 'EggDailysView', src: eggDailys, path: '/layer/eggs/'},
  ];

  for (const v of views) {
    it(`${v.name} navigates to ${v.path}<id>`, () => {
      // Whitespace-tolerant: Prettier may wrap the navigate(...) call across
      // lines (e.g. inside the shared openableProps spread).
      expect(v.src).toMatch(new RegExp("navigate\\(\\s*'" + v.path.replace(/\//g, '\\/')));
    });
  }
});

describe('Daily views — pass visible-order sequence through route state (CP2)', () => {
  const views = [
    {name: 'BroilerDailysView', src: broilerDailys, suffix: "'batch_label'"},
    {name: 'LayerDailysView', src: layerDailys, suffix: "'batch_label'"},
    {name: 'PigDailysView', src: pigDailys, suffix: "'batch_label'"},
    {name: 'CattleDailysView', src: cattleDailys, suffix: "'herd'"},
    {name: 'SheepDailysView', src: sheepDailys, suffix: "'flock'"},
    {name: 'EggDailysView', src: eggDailys, suffix: 'null'},
  ];
  for (const v of views) {
    it(`${v.name} imports the recordSequence helpers`, () => {
      expect(v.src).toContain("from '../lib/recordSequence.js'");
    });
    it(`${v.name} row click passes recordSeqNavOptions(dailySeqItems(filtered, ${v.suffix}))`, () => {
      expect(v.src).toContain('recordSeqNavOptions(dailySeqItems(filtered, ' + v.suffix + '))');
    });
    it(`${v.name} row carries a data-daily-row hook`, () => {
      // CP2: daily rows render through the shared DataTable, which emits the
      // hook via rowProps={(d) => ({'data-daily-row': d.id})}. Accept that form
      // or the legacy inline data-daily-row={d.id} attribute. The runtime
      // contract (every daily row carries data-daily-row=<id>) is unchanged.
      expect(v.src).toMatch(/data-daily-row(?:=\{d\.id\}|': d\.id)/);
    });
  }
});

describe('Daily record pages — render sequence navigation (CP2)', () => {
  const pages = [
    {name: 'PoultryDailyPage', src: poultryPage, path: '/broiler/dailys/'},
    {name: 'PigDailyPage', src: pigPage, path: '/pig/dailys/'},
    {name: 'CattleDailyPage', src: cattlePage, path: '/cattle/dailys/'},
    {name: 'SheepDailyPage', src: sheepPage, path: '/sheep/dailys/'},
    {name: 'LayerDailyPage', src: layerPage, path: '/layer/dailys/'},
    {name: 'EggDailyPage', src: eggPage, path: '/layer/eggs/'},
  ];
  for (const p of pages) {
    it(`${p.name} renders the shared RecordSequenceNav`, () => {
      expect(p.src).toContain("from '../shared/RecordSequenceNav.jsx'");
      expect(p.src).toContain('<RecordSequenceNav');
    });
    it(`${p.name} reads the sequence from route state`, () => {
      expect(p.src).toContain('location.state?.recordSeq');
    });
    it(`${p.name} navigateSeq carries the sequence forward`, () => {
      expect(p.src).toContain("navigate('" + p.path + "' + id, recordSeqNavOptions(recordSeq))");
    });
  }
});

describe('Daily record pages — structure', () => {
  const pages = [
    {name: 'PoultryDailyPage', src: poultryPage, entity: 'poultry.daily'},
    {name: 'PigDailyPage', src: pigPage, entity: 'pig.daily'},
    {name: 'CattleDailyPage', src: cattlePage, entity: 'cattle.daily'},
    {name: 'SheepDailyPage', src: sheepPage, entity: 'sheep.daily'},
    {name: 'LayerDailyPage', src: layerPage, entity: 'layer.daily'},
    {name: 'EggDailyPage', src: eggPage, entity: 'egg.daily'},
  ];

  for (const p of pages) {
    it(`${p.name} renders RecordCollaborationSection with ${p.entity}`, () => {
      expect(p.src).toContain('RecordCollaborationSection');
      expect(p.src).toContain(`entityType="${p.entity}"`);
    });
    it(`${p.name} does not import CommentsSection or RecordActivityLog directly`, () => {
      expect(p.src).not.toContain("from '../shared/CommentsSection.jsx'");
      expect(p.src).not.toContain("from '../shared/RecordActivityLog.jsx'");
    });
    it(`${p.name} renders the title through the shared RecordTitle`, () => {
      // The data-record-title marker now lives in RecordPageShell's RecordTitle.
      expect(p.src).toContain('<RecordTitle>');
    });
    it(`${p.name} renders Header through the shared record-page chrome`, () => {
      // The literal {Header && <Header />} now lives in RecordPageShell.
      expect(p.src).toContain('RecordPageFrame');
      expect(p.src).toContain('Header={Header}');
    });
    it(`${p.name} uses softDeleteDailyReport`, () => {
      expect(p.src).toContain('softDeleteDailyReport');
    });
  }
});

describe('Daily views — no direct activity table access', () => {
  const allSrc = [broilerDailys, layerDailys, eggDailys, pigDailys, cattleDailys, sheepDailys];
  for (const src of allSrc) {
    it('does not reference .from(activity_events)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_events['"]\)/);
    });
    it('does not reference .from(activity_mentions)', () => {
      expect(src).not.toMatch(/\.from\(['"]activity_mentions['"]\)/);
    });
  }
});

describe('URL adapter — daily sub-paths', () => {
  const paths = [
    {path: '/broiler/dailys/', view: 'broilerdailys'},
    {path: '/pig/dailys/', view: 'pigdailys'},
    {path: '/cattle/dailys/', view: 'cattledailys'},
    {path: '/sheep/dailys/', view: 'sheepdailys'},
    {path: '/layer/dailys/', view: 'layerdailys'},
    {path: '/layer/eggs/', view: 'eggdailys'},
  ];

  for (const p of paths) {
    it(`detects ${p.path}<id> sub-path`, () => {
      expect(mainJsx).toContain(`location.pathname.startsWith('${p.path}')`);
    });
    it(`guards ${p.view} sub-path from URL clobbering`, () => {
      expect(mainJsx).toContain(`view === '${p.view}' && location.pathname.startsWith('${p.path}')`);
    });
  }
});
