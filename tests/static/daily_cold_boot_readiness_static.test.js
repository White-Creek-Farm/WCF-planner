import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Daily Record/Hubs Cold-Boot Readiness
// ============================================================================
// Locks the fail-closed cold-boot/readiness contract (same pattern as the
// merged cold-boot builds 1-10) across the six authenticated daily report
// record pages and their daily hub/list surfaces:
//
//   - by-id record loads use maybeSingle, so a true zero-row read renders the
//     existing Not Found state while a real query/read error surfaces as a
//     dedicated loadError state (never a misleading "not found");
//   - every required Supabase .error is checked and thrown into the load-error
//     path;
//   - loading -> loadError -> not-found -> record render states;
//   - InlineNotice renders the loadError with a back link;
//   - stale record/list state is cleared on failure so old data cannot render
//     after a failed cold boot;
//   - setLoading(false) runs in finally (record pages) / on every branch
//     (list views) so the surface never strands in Loading;
//   - the daily soft-delete contract (.is('deleted_at', null)) is preserved on
//     every read;
//   - stable data-* readiness markers exist for future Playwright waits.
//
// PigDailysView is intentionally NOT load-hardened here: it is prop-driven
// (the pigDailys list arrives from the parent PigContext, whose feedersLoaded
// readiness signal already gates pig surfaces). Its pig_dailys .from() calls
// are save mutations, not a list load. Locked by the prop-driven assertions.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── Record pages ─────────────────────────────────────────────────────────
const RECORD_PAGES = [
  {
    file: 'src/broiler/PoultryDailyPage.jsx',
    table: 'poultry_dailys',
    idVar: 'recordId',
    marker: 'data-poultry-daily-record-loaded="true"',
  },
  {
    file: 'src/layer/LayerDailyPage.jsx',
    table: 'layer_dailys',
    idVar: 'recordId',
    marker: 'data-layer-daily-record-loaded="true"',
  },
  {
    file: 'src/layer/EggDailyPage.jsx',
    table: 'egg_dailys',
    idVar: 'recordId',
    marker: 'data-egg-daily-record-loaded="true"',
  },
  {
    file: 'src/pig/PigDailyPage.jsx',
    table: 'pig_dailys',
    idVar: 'recordId',
    marker: 'data-pig-daily-record-loaded="true"',
  },
  {
    file: 'src/cattle/CattleDailyPage.jsx',
    table: 'cattle_dailys',
    idVar: 'recordId',
    marker: 'data-cattle-daily-record-loaded="true"',
  },
  {
    file: 'src/sheep/SheepDailyPage.jsx',
    table: 'sheep_dailys',
    idVar: 'recordId',
    marker: 'data-sheep-daily-record-loaded="true"',
  },
];

describe('Daily record pages - cold-boot readiness', () => {
  for (const {file, table, idVar, marker} of RECORD_PAGES) {
    const src = read(file);

    it(`${file} loads the record by id with maybeSingle + preserved deleted_at filter`, () => {
      const re = new RegExp(
        `from\\('${table}'\\)[\\s\\S]{0,160}?\\.eq\\('id', ${idVar}\\)[\\s\\S]{0,80}?\\.is\\('deleted_at', null\\)[\\s\\S]{0,40}?\\.maybeSingle\\(\\)`,
      );
      expect(src).toMatch(re);
    });

    it(`${file} throws real read errors into the load-error path`, () => {
      expect(src).toContain(`throw new Error('${table}: '`);
      expect(src).toContain('Could not load daily report');
    });

    it(`${file} never strands in Loading (try/catch/finally with setLoading(false))`, () => {
      expect(src).toContain('try {');
      expect(src).toContain('} catch (e) {');
      expect(src).toMatch(/finally\s*\{[\s\S]*?setLoading\(false\);[\s\S]*?\}/);
    });

    it(`${file} renders a loadError state with InlineNotice and clears stale record state`, () => {
      expect(src).toContain('const [loadError, setLoadError]');
      expect(src).toMatch(/if \(loadError\)[\s\S]*?<InlineNotice notice=\{loadError\}/);
      expect(src).toContain('setRecord(null);');
      expect(src).toContain('setForm(null);');
    });

    it(`${file} keeps the resolved-record readiness marker`, () => {
      expect(src).toContain(marker);
    });
  }
});

// ── Group-dropdown contracts preserved (broiler/layer/pig) ─────────────────
describe('Daily record pages - group dropdown contracts unchanged', () => {
  it('PoultryDailyPage still builds broiler group options from props', () => {
    expect(read('src/broiler/PoultryDailyPage.jsx')).toContain('buildBroilerGroupOptions(batches');
  });
  it('LayerDailyPage still resolves groups through layerDailyGroups.js', () => {
    const src = read('src/layer/LayerDailyPage.jsx');
    expect(src).toContain('buildLayerDailyGroupOptions');
    expect(src).toContain('layerDailyGroups');
  });
  it('PigDailyPage still builds pig group options from props', () => {
    expect(read('src/pig/PigDailyPage.jsx')).toContain('buildPigGroupOptions(feederGroups');
  });
});

// ── Hub / list surfaces ────────────────────────────────────────────────────
const HUB_VIEWS = [
  {file: 'src/broiler/BroilerDailysView.jsx', table: 'poultry_dailys', marker: 'data-broiler-dailys-loaded'},
  {file: 'src/layer/LayerDailysView.jsx', table: 'layer_dailys', marker: 'data-layer-dailys-loaded'},
  {file: 'src/layer/EggDailysView.jsx', table: 'egg_dailys', marker: 'data-egg-dailys-loaded'},
  {file: 'src/cattle/CattleDailysView.jsx', table: 'cattle_dailys', marker: 'data-cattle-dailys-loaded'},
  {file: 'src/sheep/SheepDailysView.jsx', table: 'sheep_dailys', marker: 'data-sheep-dailys-loaded'},
];

describe('Daily hub/list views - cold-boot readiness', () => {
  for (const {file, table, marker} of HUB_VIEWS) {
    const src = read(file);

    it(`${file} fails closed on the initial list read (error branch + catch + clear)`, () => {
      expect(src).toContain('const [loadError, setLoadError]');
      // The initial list load surfaces a loadError and clears stale rows.
      expect(src).toContain('setLoadError({');
      expect(src).toContain('setRecords([]);');
      expect(src).toMatch(/\.then\(\(\{data, error\}\) =>/);
      expect(src).toMatch(/\.catch\(\(e\) =>/);
    });

    it(`${file} preserves the deleted_at soft-delete filter on the list read`, () => {
      expect(src).toContain(`from('${table}')`);
      expect(src).toContain(".is('deleted_at', null)");
    });

    it(`${file} renders the loadError via InlineNotice and exposes a readiness marker`, () => {
      expect(src).toContain('<InlineNotice notice={loadError}');
      expect(src).toContain(`${marker}={loading || loadError ? 'false' : 'true'}`);
    });
  }
});

// ── PigDailysView is prop-driven; readiness is upstream (feedersLoaded) ─────
describe('PigDailysView - prop-driven readiness (no local list load)', () => {
  const src = read('src/pig/PigDailysView.jsx');

  it('renders the list from the pigDailys prop, not a local select', () => {
    expect(src).toContain('pigDailys');
    // No paginated list select of pig_dailys lives in this view.
    expect(src).not.toMatch(/from\('pig_dailys'\)[\s\S]{0,120}?\.range\(/);
  });

  it('only touches pig_dailys for save mutations (update/insert), not a list read', () => {
    expect(src).toMatch(/from\('pig_dailys'\)[\s\S]{0,40}?\.update\(/);
    expect(src).toMatch(/from\('pig_dailys'\)[\s\S]{0,40}?\.insert\(/);
  });
});

// ── Retry affordance ───────────────────────────────────────────────────────
// After the 6 Codex readiness lanes standardized on Retry + non-dismissible
// load errors, the daily lane matches: the loadError InlineNotice has no
// onDismiss, and a user-click-gated Retry re-runs the EXISTING load path
// (record pages call loadAll(); hubs bump reloadKey which the load effect
// depends on). No effect re-fires on error, so there is no retry loop.
const RECORD_RETRY = [
  {file: 'src/broiler/PoultryDailyPage.jsx', errMarker: 'data-poultry-daily-load-error="true"'},
  {file: 'src/layer/LayerDailyPage.jsx', errMarker: 'data-layer-daily-load-error="true"'},
  {file: 'src/layer/EggDailyPage.jsx', errMarker: 'data-egg-daily-load-error="true"'},
  {file: 'src/pig/PigDailyPage.jsx', errMarker: 'data-pig-daily-load-error="true"'},
  {file: 'src/cattle/CattleDailyPage.jsx', errMarker: 'data-cattle-daily-load-error="true"'},
  {file: 'src/sheep/SheepDailyPage.jsx', errMarker: 'data-sheep-daily-load-error="true"'},
];

describe('Daily record pages - Retry affordance (non-dismissible loadError)', () => {
  for (const {file, errMarker} of RECORD_RETRY) {
    const src = read(file);
    it(`${file} keeps load failures non-dismissible with a Retry that re-runs loadAll`, () => {
      expect(src).toContain('<InlineNotice notice={loadError} />');
      expect(src).not.toContain('notice={loadError} onDismiss');
      expect(src).toContain('data-daily-record-retry="1"');
      expect(src).toContain('onClick={() => loadAll()}');
      expect(src).toContain(errMarker);
    });
  }
});

describe('Daily hub/list views - Retry affordance (user-gated reloadKey)', () => {
  for (const {file} of HUB_VIEWS) {
    const src = read(file);
    it(`${file} keeps load failures non-dismissible with a reloadKey Retry`, () => {
      expect(src).toContain('<InlineNotice notice={loadError} />');
      expect(src).not.toContain('notice={loadError} onDismiss');
      expect(src).toContain('data-daily-list-retry="1"');
      expect(src).toContain('const [reloadKey, setReloadKey]');
      expect(src).toContain('onClick={() => setReloadKey((k) => k + 1)}');
      expect(src).toContain('}, [reloadKey]);');
    });
  }
});
