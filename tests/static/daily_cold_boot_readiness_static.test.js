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
// PigDailysView now owns its own local pig_dailys list load with fail-closed
// readiness (Retry + marker), syncing the parent cache via setPigDailys. See
// the "PigDailysView - local cold-boot readiness" block below and
// tests/static/pig_dailys_view_readiness_static.test.js. This superseded the
// earlier prop-driven approach via the dedicated PigDailysView readiness lane.
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

// ── PigDailysView owns local list readiness ─────────────────────────────────
describe('PigDailysView - local cold-boot readiness', () => {
  const src = read('src/pig/PigDailysView.jsx');

  it('renders the list from local records loaded from pig_dailys', () => {
    expect(src).toContain('const [records, setRecords] = useState([]);');
    expect(src).toMatch(/from\('pig_dailys'\)[\s\S]*?\.select\('\*'\)[\s\S]*?\.is\('deleted_at', null\)/);
    expect(src).toMatch(/\.order\('date', \{ascending: false\}\)[\s\S]*?\.range\(from, from \+ PAGE - 1\)/);
    expect(src).toContain('setPigDailys && setPigDailys(all);');
  });

  it('keeps save mutations intact and fails closed on list-read errors', () => {
    expect(src).toMatch(/from\('pig_dailys'\)[\s\S]{0,40}?\.update\(/);
    expect(src).toMatch(/from\('pig_dailys'\)[\s\S]{0,40}?\.insert\(/);
    expect(src).toContain('setRecords([]);');
    expect(src).toContain("data-pig-dailys-loaded={loading || loadError ? 'false' : 'true'}");
    expect(src).toContain('<InlineNotice notice={loadError} />');
    expect(src).toContain('data-daily-list-retry="1"');
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

// ── Cleanup combo: mutation notices use the current InlineNotice API ────────
// Daily record pages previously passed kind=/message= props that the current
// InlineNotice ({notice, onDismiss}) ignores, so save/delete notices silently
// never rendered. Lock that they now pass the dismissible notice object — while
// the readiness loadError stays non-dismissible (asserted above).
describe('Daily record pages - mutation notice uses current InlineNotice API', () => {
  for (const {file} of RECORD_PAGES) {
    const src = read(file);
    it(`${file} renders the mutation notice via notice={notice} (not ignored kind=/message=)`, () => {
      expect(src).toContain('<InlineNotice notice={notice} onDismiss={() => setNotice(null)} />');
      expect(src).not.toContain('kind={notice.kind}');
      expect(src).not.toContain('message={notice.message}');
    });
  }
});

// ── Cleanup combo: BroilerListView marker reflects real load state ──────────
describe('BroilerListView - readiness marker reflects real load state', () => {
  const src = read('src/broiler/BroilerListView.jsx');
  it('drives data-broiler-batches-loaded from dataLoaded, not a static literal', () => {
    expect(src).toContain("data-broiler-batches-loaded={dataLoaded ? 'true' : 'false'}");
    expect(src).not.toContain('data-broiler-batches-loaded="true"');
  });
});
