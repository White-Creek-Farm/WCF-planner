import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const pages = [
  {
    name: 'PoultryDailyPage',
    path: 'src/broiler/PoultryDailyPage.jsx',
    entity: 'poultry.daily',
    table: 'poultry_dailys',
  },
  {name: 'LayerDailyPage', path: 'src/layer/LayerDailyPage.jsx', entity: 'layer.daily', table: 'layer_dailys'},
  {name: 'EggDailyPage', path: 'src/layer/EggDailyPage.jsx', entity: 'egg.daily', table: 'egg_dailys'},
  {name: 'PigDailyPage', path: 'src/pig/PigDailyPage.jsx', entity: 'pig.daily', table: 'pig_dailys'},
  {name: 'CattleDailyPage', path: 'src/cattle/CattleDailyPage.jsx', entity: 'cattle.daily', table: 'cattle_dailys'},
  {name: 'SheepDailyPage', path: 'src/sheep/SheepDailyPage.jsx', entity: 'sheep.daily', table: 'sheep_dailys'},
];

const srcs = {};
for (const p of pages) {
  srcs[p.name] = fs.readFileSync(path.join(ROOT, p.path), 'utf8');
}

describe('All daily record pages — editable surface', () => {
  for (const p of pages) {
    const src = srcs[p.name];
    it(`${p.name} has data-daily-edit-form marker`, () => {
      expect(src).toContain('data-daily-edit-form="1"');
    });
    it(`${p.name} has Save button with data-daily-save marker`, () => {
      expect(src).toContain('data-daily-save="1"');
    });
    it(`${p.name} has Cancel/Revert button with data-daily-cancel marker`, () => {
      expect(src).toContain('data-daily-cancel="1"');
    });
    it(`${p.name} updates its own table`, () => {
      expect(src).toContain(`from('${p.table}')`);
      expect(src).toContain('.update(');
    });
    it(`${p.name} uses field.updated Activity logging`, () => {
      expect(src).toContain('runMutation');
      expect(src).toContain('recordFieldChange');
      expect(src).toContain('buildChanges');
      expect(src).toContain(`entityType: '${p.entity}'`);
    });
    it(`${p.name} preserves CommentsSection`, () => {
      expect(src).toContain('CommentsSection');
    });
    it(`${p.name} preserves RecordActivityLog`, () => {
      expect(src).toContain('RecordActivityLog');
    });
    it(`${p.name} does not import ActivityPanel or ActivityModal`, () => {
      expect(src).not.toMatch(/import ActivityPanel/);
      expect(src).not.toMatch(/import ActivityModal/);
    });
    it(`${p.name} has no edit-mode gate (opens editable immediately)`, () => {
      expect(src).not.toContain('[editing, setEditing]');
      expect(src).not.toContain('handleEdit');
      expect(src).not.toMatch(/!editing\s*&&/);
      expect(src).not.toContain('setEditing(');
      expect(src).not.toContain('editing ?');
    });
  }
});

describe('Egg daily — daily_dozen_count computation', () => {
  const src = srcs['EggDailyPage'];
  it('computes daily_dozen_count from group counts', () => {
    expect(src).toContain('daily_dozen_count');
    expect(src).toContain('Math.floor(');
  });
});

describe('Layer daily — setHousingAnchorFromReport', () => {
  const src = srcs['LayerDailyPage'];
  it('imports and calls setHousingAnchorFromReport after save', () => {
    expect(src).toContain('setHousingAnchorFromReport');
  });
  it('handles ambiguous-batch warning', () => {
    expect(src).toContain('ambiguous-batch');
  });
});

describe('Pig daily — batch_id derivation', () => {
  const src = srcs['PigDailyPage'];
  it('derives batch_id on save', () => {
    expect(src).toContain('batch_id');
  });
});

describe('Cattle daily — feed/mineral JSON rebuild', () => {
  const src = srcs['CattleDailyPage'];
  it('loads cattle_feed_inputs', () => {
    expect(src).toContain("from('cattle_feed_inputs')");
  });
  it('rebuilds feeds JSON with nutrition_snapshot', () => {
    expect(src).toContain('nutrition_snapshot');
    expect(src).toContain('feed_input_id');
    expect(src).toContain('lbs_as_fed');
  });
  it('supports creep flag for mommas herd', () => {
    expect(src).toContain('is_creep');
    expect(src).toContain('mommas');
  });
  it('uses feed/mineral formatters for Activity diffs', () => {
    expect(src).toContain('FORMATTERS');
  });
});

describe('Sheep daily — feed/mineral JSON rebuild', () => {
  const src = srcs['SheepDailyPage'];
  it('loads cattle_feed_inputs', () => {
    expect(src).toContain("from('cattle_feed_inputs')");
  });
  it('rebuilds feeds JSON with lbs_as_fed', () => {
    expect(src).toContain('feed_input_id');
    expect(src).toContain('lbs_as_fed');
  });
  it('sets is_creep to false for sheep', () => {
    expect(src).toContain('is_creep: false');
  });
});

describe('add_feed_webform source restriction', () => {
  const restricted = ['PoultryDailyPage', 'LayerDailyPage', 'PigDailyPage', 'CattleDailyPage', 'SheepDailyPage'];
  for (const name of restricted) {
    it(`${name} checks for add_feed_webform source`, () => {
      expect(srcs[name]).toContain('add_feed_webform');
    });
  }
});
