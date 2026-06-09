import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const viewSrc = fs.readFileSync(path.join(ROOT, 'src/pig/PigDailysView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const savedViewsApi = fs.readFileSync(path.join(ROOT, 'src/lib/savedViewsApi.js'), 'utf8');
const csvExport = fs.readFileSync(path.join(ROOT, 'src/lib/csvExport.js'), 'utf8');
const dailyReportExports = fs.readFileSync(path.join(ROOT, 'src/lib/dailyReportExports.js'), 'utf8');
const printExport = fs.readFileSync(path.join(ROOT, 'src/lib/printExport.js'), 'utf8');

describe('PigDailysView hub cold-boot readiness', () => {
  it('owns a local records load instead of rendering directly from the app pigDailys prop', () => {
    expect(viewSrc).toContain('const [records, setRecords] = useState([]);');
    expect(viewSrc).toContain('const [loading, setLoading] = useState(true);');
    expect(viewSrc).not.toMatch(/\bpigDailys\b/);
    expect(viewSrc).toMatch(/from\('pig_dailys'\)[\s\S]*?\.select\('\*'\)[\s\S]*?\.is\('deleted_at', null\)/);
    expect(viewSrc).toMatch(/\.order\('date', \{ascending: false\}\)[\s\S]*?\.range\(from, from \+ PAGE - 1\)/);
    expect(viewSrc).toContain('all.push(...data);');
    expect(viewSrc).toContain('setRecords(all);');
    expect(viewSrc).toContain('setPigDailys && setPigDailys(all);');
  });

  it('fails closed on load errors and exposes a stable readiness marker', () => {
    expect(viewSrc).toContain('const [loadError, setLoadError] = useState(null);');
    expect(viewSrc).toContain('setRecords([]);');
    expect(viewSrc).toContain('setPigDailys && setPigDailys([]);');
    expect(viewSrc).toContain('Could not load daily reports. Please refresh the page.');
    expect(viewSrc).toContain("data-pig-dailys-loaded={loading || loadError ? 'false' : 'true'}");
  });

  it('shows a non-dismissible loadError notice and user-gated Retry', () => {
    expect(viewSrc).toContain('<InlineNotice notice={loadError} />');
    expect(viewSrc).not.toContain('<InlineNotice notice={loadError} onDismiss');
    expect(viewSrc).toContain('const [reloadKey, setReloadKey] = useState(0);');
    expect(viewSrc).toMatch(/data-daily-list-retry="1"[\s\S]*?onClick=\{\(\) => setReloadKey\(\(k\) => k \+ 1\)\}/);
    expect(viewSrc).toMatch(/useEffect\(\(\) => \{[\s\S]*?\}, \[reloadKey\]\);/);
  });

  it('does not render empty-state or row content while loading or loadError is active', () => {
    expect(viewSrc).toMatch(/loading && <div[\s\S]*?>Loading\.\.\.<\/div>/);
    expect(viewSrc).toContain("from '../shared/OperationalListEmptyState.jsx'");
    expect(viewSrc).toContain('<OperationalListEmptyState');
    expect(viewSrc).toContain('loadError={loadError}');
    expect(viewSrc).toContain('totalCount={records.length}');
    expect(viewSrc).toContain('filteredCount={filtered.length}');
    expect(viewSrc).toContain('!loading && !loadError && filtered.length > 0');
  });
});

describe('main.jsx PigDailysView prop handoff', () => {
  it('no longer passes the dead pigDailys prop but keeps setPigDailys', () => {
    // PigDailysView owns its local pig_dailys load; the stale prop handoff is
    // removed. setPigDailys stays so the view keeps the shared recent-dailys
    // context in sync. Note: \bpigDailys\b (lowercase p) cannot match inside
    // setPigDailys (capital P), so it isolates the standalone prop.
    const render = mainSrc.match(/React\.createElement\(PigDailysView, \{[\s\S]*?\}\)/);
    expect(render).not.toBeNull();
    // Strip line comments so the assertion reflects actual passed props, not
    // an explanatory comment that names the removed prop.
    const code = render[0].replace(/\/\/[^\n]*/g, '');
    expect(code).toContain('setPigDailys');
    expect(code).not.toMatch(/\bpigDailys\b/);
  });
});

describe('PigDailysView saved views (Lane F)', () => {
  it('uses the shared app_saved_views API owner with a pig.dailys surface', () => {
    expect(savedViewsApi).toContain("from('app_saved_views')");
    expect(viewSrc).toContain("from '../lib/savedViewsApi.js'");
    expect(viewSrc).toContain("const PIG_DAILYS_SURFACE_KEY = 'pig.dailys'");
    expect(viewSrc).toContain('listSavedViews(sb, PIG_DAILYS_SURFACE_KEY)');
    expect(viewSrc).toContain('surfaceKey: PIG_DAILYS_SURFACE_KEY');
    expect(viewSrc).toContain('createSavedView(sb, {');
    expect(viewSrc).toContain('updateSavedView(sb, selectedView.id');
    expect(viewSrc).toContain('deleteSavedView(sb, view.id)');
  });

  it('saves and restores every pig daily filter, including the now-visible team filter', () => {
    expect(viewSrc).toContain('function pigDailysViewState()');
    for (const field of ['fBatch', 'fTeam', 'fFrom', 'fTo']) {
      expect(viewSrc).toContain(`${field}: ${field} || ''`);
      expect(viewSrc).toContain(`typeof st.${field} === 'string' ? st.${field} : ''`);
    }
    expect(viewSrc).toContain('srcFilter: VALID_PIG_DAILY_SOURCE_FILTERS.has(srcFilter) ? srcFilter :');
    expect(viewSrc).toContain('setSrcFilter(VALID_PIG_DAILY_SOURCE_FILTERS.has(st.srcFilter) ? st.srcFilter :');
    expect(viewSrc).toContain('data-pig-dailys-team-filter="1"');
    expect(viewSrc).toContain('setFTeam(e.target.value)');
  });

  it('renders the saved-view control and degrades saved-view failures locally', () => {
    const savedViewLoadBlock = viewSrc.slice(
      viewSrc.indexOf('async function loadSavedViews'),
      viewSrc.indexOf('useEffect(() => {\n    loadSavedViews();'),
    );
    const savedViewHandlersBlock = viewSrc.slice(
      viewSrc.indexOf('function pigDailysViewState'),
      viewSrc.indexOf('function handleExportCsv'),
    );
    for (const marker of [
      'data-pig-dailys-saved-views-row',
      'data-pig-dailys-saved-view-select',
      'data-pig-dailys-saved-view-save-open',
      'data-pig-dailys-saved-view-form',
      'data-pig-dailys-saved-view-name',
      'data-pig-dailys-saved-view-visibility="private"',
      'data-pig-dailys-saved-view-visibility="public"',
      'data-pig-dailys-saved-view-save',
      'data-pig-dailys-saved-view-update',
      'data-pig-dailys-saved-view-delete',
      'data-pig-dailys-saved-views-error',
    ]) {
      expect(viewSrc).toContain(marker);
    }
    expect(viewSrc).toContain('Saved views unavailable. Filters still work.');
    expect(savedViewLoadBlock).toContain('setSavedViewsError(e.message || String(e))');
    expect(savedViewLoadBlock).not.toContain('setLoadError(');
    expect(savedViewLoadBlock).not.toContain('setNotice(');
    expect(savedViewHandlersBlock).not.toContain('setLoadError(');
    expect(savedViewHandlersBlock).not.toContain('setNotice(');
    expect(viewSrc).toContain('window._wcfConfirmDelete');
    expect(viewSrc).not.toContain('window.confirm');
    expect(viewSrc).not.toContain('window.prompt');
  });
});

describe('PigDailysView CSV export (Lane K)', () => {
  it('uses the shared csvExport owner for browser download mechanics', () => {
    expect(csvExport).toContain('export function rowsToCsv');
    expect(csvExport).toContain('export function csvFilename');
    expect(csvExport).toContain('export function downloadCsv');
    expect(csvExport).toContain('new Blob');
    expect(csvExport).toContain('URL.createObjectURL');
  });

  it('exports the current filtered pig daily rows, not raw records', () => {
    expect(viewSrc).toContain("from '../lib/csvExport.js'");
    expect(viewSrc).toContain("from '../lib/dailyReportExports.js'");
    expect(viewSrc).toContain('function handleExportCsv');
    expect(viewSrc).toContain('data-pig-dailys-export-csv="1"');
    expect(viewSrc).toContain('const columns = buildPigDailyExportColumns();');
    expect(viewSrc).toContain('rowsToCsv(columns, filtered)');
    expect(viewSrc).not.toContain('rowsToCsv(columns, records)');
  });

  it('keeps pig daily export columns useful for daily review', () => {
    for (const header of [
      'Date',
      'Pig group',
      'Team member',
      'Source',
      'Feed lbs',
      'Pig count',
      'Fence voltage',
      'Group moved',
      'Nipple drinker moved',
      'Nipple drinker working',
      'Troughs moved',
      'Fence walked',
      'Issues',
      'Photo count',
      'Record ID',
    ]) {
      expect(dailyReportExports).toContain(`header: '${header}'`);
    }
  });

  it('keeps the CSV fallback browser-only and free of window.alert/confirm', () => {
    expect(viewSrc).toContain('CSV export is only available in the browser.');
    expect(viewSrc).not.toContain('window.alert');
    expect(viewSrc).not.toContain('window.confirm');
  });
});

describe('PigDailysView print export (Lane K)', () => {
  it('uses the shared printExport owner for browser print mechanics', () => {
    expect(printExport).toContain('export function rowsToPrintHtml');
    expect(printExport).toContain('export function printRows');
    expect(printExport).toContain('data-print-export-frame');
    expect(printExport).toContain('window.print');
    expect(printExport).toContain('escapeHtml');
  });

  it('prints the current filtered pig daily rows, not raw records', () => {
    expect(viewSrc).toContain("from '../lib/printExport.js'");
    expect(viewSrc).toContain('function handlePrintRows');
    expect(viewSrc).toContain('data-pig-dailys-print="1"');
    expect(viewSrc).toContain("subtitle: filtered.length + ' filtered daily reports'");
    expect(viewSrc).toContain('rows: filtered');
    expect(viewSrc).not.toContain('rows: records');
  });

  it('uses one column spec for CSV and print', () => {
    expect(dailyReportExports).toContain('export function buildPigDailyExportColumns');
    expect(viewSrc).toContain('const columns = buildPigDailyExportColumns();');
    expect(viewSrc).toContain('rowsToCsv(columns, filtered)');
    expect(viewSrc).toContain('printRows({');
  });
});
