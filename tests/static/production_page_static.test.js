import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const homeSrc = read('src/dashboard/HomeDashboard.jsx');
const pageSrc = read('src/dashboard/ProductionPage.jsx');
const mainSrc = read('src/main.jsx');
const helperSrc = read('src/lib/production.js');
const apiSrc = read('src/lib/productionApi.js');
const migrationSrc = read('supabase-migrations/125_production_legacy_events.sql');
const importScriptSrc = read('scripts/import_production_legacy_events_from_xlsx.cjs');

describe('Production page route and homepage card', () => {
  it('registers the canonical Production path', () => {
    expect(VIEW_TO_PATH.production).toBe('/production');
    expect(PATH_TO_VIEW['/production']).toBe('production');
  });

  it('homepage Production card opens the real page and has no combined total slot', () => {
    const productionBlock = homeSrc.slice(
      homeSrc.indexOf("setView('production')"),
      homeSrc.indexOf('Missed Daily Reports'),
    );
    expect(productionBlock).toContain("setView('production')");
    expect(productionBlock).toContain('data-home-grid="production"');
    expect(productionBlock).not.toContain("setComingSoon('Production')");
    expect(productionBlock).not.toContain('data-status="not-built"');
    expect(productionBlock).not.toContain('stat-total');
    expect(productionBlock).not.toContain('sdot-total');
    expect(productionBlock).not.toMatch(/>\s*Total\s*</);
  });

  it('main.jsx allows and renders the production view', () => {
    expect(mainSrc).toContain("import ProductionPage from './dashboard/ProductionPage.jsx'");
    expect(mainSrc).toMatch(/VALID_VIEWS\s*=\s*\[[\s\S]*?'production'/);
    expect(mainSrc).toContain(
      "if (view === 'production') return React.createElement(ProductionPage, {Header, setView})",
    );
    const lightAllowedBlock = mainSrc.match(/const LIGHT_ALLOWED_VIEWS[\s\S]*?new Set\(\[([\s\S]*?)\]\)/)?.[1] || '';
    expect(lightAllowedBlock).not.toContain("'production'");
  });
});

describe('Production page data contracts', () => {
  it('uses production sources plus historical rows internally, not a combined total table', () => {
    for (const fn of [
      'buildBroilerProductionEvents',
      'buildPigProductionEvents',
      'buildCattleProductionEvents',
      'buildSheepProductionEvents',
      'buildEggProductionEvents',
      'reconcileProductionEvents',
      'buildProductionModel',
      'buildProductionMatrix',
      'buildProductionEventsView',
      'buildProductionSummary',
      'buildProductionLedger',
      'buildProductionAuditView',
    ]) {
      expect(helperSrc).toContain(`export function ${fn}`);
    }
    expect(apiSrc).toContain("['ppp-v4', 'ppp-feeders-v1']");
    expect(apiSrc).toContain("'cattle_processing_batches'");
    expect(apiSrc).toContain("'sheep_processing_batches'");
    expect(apiSrc).toContain("'egg_dailys'");
    expect(helperSrc).not.toMatch(/combinedProductionTotal|productionTotal/);
  });

  it('keeps import/reconciliation language off the operator-facing production page', () => {
    expect(pageSrc).toContain("{key: 'summary', label: 'Summary'}");
    expect(pageSrc).toContain("{key: 'counted', label: 'Production Events'}");
    expect(pageSrc).not.toContain("{key: 'reconcile', label: 'Reconciliation'}");
    expect(pageSrc).not.toContain('Planner');
    expect(pageSrc).not.toContain('Legacy');
    expect(pageSrc).not.toContain('Historical backfill');
    expect(pageSrc).not.toContain('backfill');
    expect(pageSrc).not.toContain('<th>Source</th>');
    expect(pageSrc).not.toContain('function LegacyAuditPanel');
    expect(pageSrc).not.toContain('production-audit-details');
    expect(pageSrc).not.toContain('Legacy Backfill Audit');
    expect(pageSrc).not.toContain('Reconciliation / Audit');
    expect(pageSrc).not.toContain('Counted Events');
    // Summary is the all-years matrix; Production Events is the event/history
    // view. The single-year summary/ledger presenters are no longer wired to the
    // page (they still exist in the helper for reconciliation tests).
    expect(pageSrc).toContain('buildProductionMatrix');
    expect(pageSrc).toContain('buildProductionEventsView');
    expect(pageSrc).not.toContain('buildProductionAuditView');
    expect(pageSrc).not.toContain('buildProductionSummary');
    expect(pageSrc).not.toContain('buildProductionLedger');
    // per-program accent color is applied on the matrix/ledger tables
    expect(pageSrc).toContain('PROGRAM_ACCENT_VAR');
    expect(pageSrc).not.toContain('prod-reason-cell');
    expect(pageSrc).not.toContain('title={row.reason}');
  });

  it('never references Podio on the page', () => {
    expect(pageSrc).not.toMatch(/Podio/i);
    expect(helperSrc).not.toMatch(/Podio/i);
  });

  it('keeps the no-combined-total contract on the redesigned page', () => {
    expect(pageSrc).not.toContain('stat-total');
    expect(pageSrc).not.toContain('sdot-total');
  });
});

describe('Production multi-year matrix (Summary)', () => {
  it('renders the all-years matrix component with the latest-year emphasis hook', () => {
    expect(pageSrc).toContain('function ProductionMatrix');
    expect(pageSrc).toContain('<ProductionMatrix matrix={matrix}');
    // Latest recorded year column carries the is-latest styling hook.
    expect(pageSrc).toContain('is-latest');
    // YoY direction classes drive the green/red/muted delta colors.
    expect(pageSrc).toContain('pm-delta-');
  });

  it('keeps the exact footer copy from the handoff', () => {
    expect(pageSrc).toContain('Eggs in dozens');
    expect(pageSrc).toContain('YoY compares each program to its previous recorded year');
    expect(pageSrc).toContain('no prior / not recorded that');
  });

  it('keeps the Summary matrix and Production Events all-years on the page', () => {
    // buildProductionMatrix takes the whole model (all years), not a single year.
    expect(pageSrc).toMatch(/buildProductionMatrix\(model\)/);
    expect(pageSrc).toMatch(/buildProductionEventsView\(model\)/);
    expect(pageSrc).not.toContain('selectedYear');
    expect(pageSrc).not.toContain('production-year-picker');
    expect(pageSrc).not.toContain('production-year-card');
    expect(pageSrc).not.toContain('data-home-grid="production"');
    expect(pageSrc).toContain('Production Events');
    expect(pageSrc).toContain('Every processing event recorded across all years.');
  });

  it('links matched Production Events rows to their record pages', () => {
    expect(pageSrc).toContain("import {Link} from 'react-router-dom'");
    expect(pageSrc).toContain('data-production-event-record-link="1"');
    expect(pageSrc).toContain('row.recordPath');
    expect(helperSrc).toContain('PLANNER_MATCH_START_DATE');
    expect(helperSrc).toContain('findUniquePlannerMatch');
    expect(helperSrc).toContain('/broiler/batches/');
  });
});

describe('Production legacy migration and importer', () => {
  it('stores spreadsheet backfill behind deny-all RLS and an authenticated SECDEF list RPC', () => {
    expect(migrationSrc).toContain('CREATE TABLE IF NOT EXISTS public.production_legacy_events');
    expect(migrationSrc).toContain('ALTER TABLE public.production_legacy_events ENABLE ROW LEVEL SECURITY');
    expect(migrationSrc).toContain('CREATE POLICY production_legacy_events_deny_all');
    expect(migrationSrc).toContain('CREATE OR REPLACE FUNCTION public.list_production_legacy_events');
    expect(migrationSrc).toMatch(/SECURITY DEFINER[\s\S]{0,80}?SET search_path = public/);
    expect(migrationSrc).toContain("v_role NOT IN ('farm_team', 'management', 'admin')");
    expect(migrationSrc).toContain(
      'GRANT EXECUTE ON FUNCTION public.list_production_legacy_events(date, date) TO authenticated',
    );
  });

  it('imports by stable source_key and ignores Podio relationship markdown for counts', () => {
    expect(importScriptSrc).toContain("onConflict: 'source_key'");
    expect(importScriptSrc).toContain("row['Number Processed']");
    expect(importScriptSrc).toContain('raw_relationship');
    expect(importScriptSrc).toContain("review_status: 'approved'");
  });
});
