import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function expectAlias(src, from, to) {
  const re = new RegExp(`'${from.replace(/\//g, '\\/')}':\\s*'${to.replace(/\//g, '\\/')}'`);
  expect(src).toMatch(re);
}

function expectMenuOrder(src, items) {
  let previous = -1;
  for (const item of items) {
    const marker = `data-header-menu-item="${item}"`;
    const next = src.indexOf(marker);
    expect(next, `${marker} exists`).toBeGreaterThan(-1);
    expect(next, `${marker} follows prior menu item`).toBeGreaterThan(previous);
    previous = next;
  }
}

function expectCentralDateImport(src) {
  expect(src).toMatch(/import\s+\{[^}]*todayCentralISO[^}]*\}\s+from\s+['"]\.\.\/lib\/dateUtils\.js['"]/);
}

describe('Lane J route and header guard rails', () => {
  const routes = read('src/lib/routes.js');
  const header = read('src/shared/Header.jsx');

  it('preserves legacy route aliases operators may have bookmarked', () => {
    for (const [from, to] of [
      ['/webforms', '/dailys'],
      ['/webforms/tasks', '/dailys/tasks'],
      ['/fueling', '/equipment'],
      ['/equipment/fleet', '/fleet'],
      ['/my-tasks', '/tasks'],
      ['/admin/tasks', '/tasks'],
    ]) {
      expectAlias(routes, from, to);
    }
  });

  it('keeps the hamburger menu source order stable', () => {
    // Client Errors was relocated from the hamburger into the Admin tab row,
    // so it is intentionally absent from this menu order.
    expectMenuOrder(header, ['home', 'activity', 'dailys', 'equipment', 'admin', 'users', 'sign-out']);
  });
});

describe('Lane J Central-date defaults', () => {
  it('AdminAddReportModal uses todayCentralISO for report-date defaults', () => {
    const src = read('src/shared/AdminAddReportModal.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('const todayStr = todayCentralISO;');
    expect(src).not.toContain('const todayStr = () => {');
  });

  it('AdminNewWeighInModal initializes from todayCentralISO', () => {
    const src = read('src/shared/AdminNewWeighInModal.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('useState(todayCentralISO())');
    expect(src).not.toContain('const todayStr = (() => {');
  });

  it('AddFeedWebform resets its date from todayCentralISO', () => {
    const src = read('src/webforms/AddFeedWebform.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('setDate(todayCentralISO())');
  });

  it('EquipmentFuelingWebform initializes its date from todayCentralISO', () => {
    const src = read('src/webforms/EquipmentFuelingWebform.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('React.useState(() => todayCentralISO())');
  });

  it('FuelSupplyWebform uses todayCentralISO for its default date', () => {
    const src = read('src/webforms/FuelSupplyWebform.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('const today = todayCentralISO()');
  });

  it('PigDailysWebform uses todayCentralISO for initial, reset, and Today dates', () => {
    const src = read('src/webforms/PigDailysWebform.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('date: todayCentralISO()');
    expect((src.match(/todayCentralISO\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('TasksWebform memoizes the Central today string', () => {
    const src = read('src/webforms/TasksWebform.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('React.useMemo(() => todayCentralISO(), [])');
  });

  it('WebformHub uses todayCentralISO for shared link date defaults', () => {
    const src = read('src/webforms/WebformHub.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('const todayStr = todayCentralISO;');
  });

  it('WeighInsWebform uses Central date helpers for defaults and draft cutoff', () => {
    const src = read('src/webforms/WeighInsWebform.jsx');
    expect(src).toMatch(
      /import\s+\{[^}]*fmt[^}]*centralISOFor[^}]*todayCentralISO[^}]*\}\s+from\s+['"]\.\.\/lib\/dateUtils\.js['"]/,
    );
    expect(src).toContain('setDate(todayCentralISO())');
    expect(src).toContain('const cutoff = centralISOFor(new Date(Date.now() - 7 * 86400000))');
    expect(src).toContain('const today = todayCentralISO()');
  });

  it('LayerDailysView uses todayCentralISO for daily-report defaults', () => {
    const src = read('src/layer/LayerDailysView.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('const todayStr = todayCentralISO;');
    expect(src).not.toContain('const todayStr = () => {');
  });

  it('EggDailysView uses todayCentralISO for egg-report defaults', () => {
    const src = read('src/layer/EggDailysView.jsx');
    expectCentralDateImport(src);
    expect(src).toContain('const todayStr = todayCentralISO;');
    expect(src).not.toContain('const todayStr = () => {');
  });
});
