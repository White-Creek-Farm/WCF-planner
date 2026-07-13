import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Non-pasture residuals - quick-nav and dashboard empty states', () => {
  it('home quick-nav tiles cannot force narrow-phone overflow', () => {
    const css = read('src/dashboard/homeRedesign.css');
    const tileBlock = css.match(/\.home \.tile \{[\s\S]*?\n\}/);
    expect(tileBlock, 'missing .home .tile block').not.toBeNull();
    expect(tileBlock[0]).toContain('min-width: 0;');
  });

  it('pig feeder dashboard cards show an explicit empty label when every metric is absent', () => {
    const src = read('src/pig/PigsHomeView.jsx');
    expect(src).toContain("const EMPTY_METRIC_LABEL = 'No data yet';");
    expect(src).toContain('data-pig-dashboard-empty="feeder-batch"');
    expect(src).toContain('!hasFeederDashboardData');
  });

  it('layer metric cards show an explicit empty label when every metric is absent', () => {
    const src = read('src/layer/LayersHomeView.jsx');
    expect(src).toContain("const EMPTY_METRIC_LABEL = 'No data yet';");
    expect(src).toContain('data-layer-dashboard-empty="metrics"');
    expect(src).toContain('!hasDashboardData');
  });
});

describe('Non-pasture residuals - P3 durability cleanup tails', () => {
  it('pig mortality and processing-trip durability stay on ppp-feeders-v1 with best-effort audit events', () => {
    const mortality = read('src/pig/usePigMortality.js');
    const trips = read('src/pig/usePigProcessingTrips.js');

    expect(mortality).toContain("key: 'ppp-feeders-v1'");
    expect(mortality).toContain('recordActivityEvent(sb');
    expect(mortality).toContain("eventType: 'record.created'");
    expect(mortality).toContain("eventType: 'record.deleted'");
    expect(mortality).toContain('catch (_e)');

    // Mig 176: trip edit/delete persist through the pigPlannerApi SECDEF RPCs
    // (server preserves subAttributions/ad-hoc keys); fcrCached remains the
    // client-persisted display cache via persistFeeders.
    expect(trips).toContain('persistFeeders(nb)');
    expect(trips).toContain('await pigUpdateProcessingTrip(sb, {');
    expect(trips).toContain('await pigDeleteProcessingTrip(sb, {groupId: batchId, tripId});');
    expect(trips).toContain('if (!currentTripId) return;');
    expect(trips).toContain('else delete next.fcrCached');
    expect(trips).toContain('recordActivityEvent(sb');
    expect(trips).toContain("record: 'pig.processingTrip'");
  });

  it('calcPoultryStatus is null-safe for missing batch objects', () => {
    const src = read('src/lib/broiler.js');
    expect(src).toContain("if (!batch || !batch.hatchDate) return 'planned';");
  });

  it('system-task orphan cleanup uses the audited typed delete path', () => {
    const src = read('src/tasks/SystemTasksTab.jsx');
    expect(src).toContain("import DeleteTaskModal from './DeleteTaskModal.jsx';");
    expect(src).toContain('data-system-orphan-delete-button=');
    expect(src).toContain('setDeleteOrphanTask');
    expect(src).toContain('onDeleted: () => {');
    expect(src).not.toMatch(/\.from\(\s*['"]task_instances['"]\s*\)\s*\.(insert|update|delete|upsert)/);
  });
});

describe('Non-pasture residuals - dedicated Tabs and A12 color guards', () => {
  it('shared Tabs render real tab semantics and selected program-color pills only', () => {
    const src = read('src/shared/Tabs.jsx');
    expect(src).toContain('role="tablist"');
    expect(src).toContain('role="tab"');
    expect(src).toContain('aria-selected={selected ?');
    expect(src).toContain('data-tab-active={selected ?');
    expect(src).toContain('getProgramColor');
    expect(src).toContain('getReadableText(fill)');
    expect(src).toContain("background: selected ? fill : 'transparent'");
  });

  it('header sub-nav selected tabs use canonical program color and unselected tabs stay plain text', () => {
    const src = read('src/shared/Header.jsx');
    expect(src).toMatch(/const navAccent = navProgram \? getProgramColor\(navProgram\) : '#085041'/);
    expect(src).toContain("background: active ? navAccent : 'transparent'");
    expect(src).toContain("color: active ? getReadableText(navAccent) : 'var(--text-primary)'");
    expect(src).toContain("border: 'none'");
  });

  it('programColors remains the single canonical A12 accent owner', () => {
    const src = read('src/lib/programColors.js');
    for (const [key, hex] of [
      ['pig', '#2B4C9B'],
      ['broiler', '#C7920A'],
      ['layer', '#D2601A'],
      ['cattle', '#8E3328'],
      ['sheep', '#4CA035'],
      ['equipment', '#6B7280'],
    ]) {
      expect(src).toContain(`${key}: '${hex}'`);
    }
    expect(src).toContain('export function programDotStyle');
    expect(src).toContain('background: getProgramColor(key)');
    expect(src).toContain('export function programPillStyle');
    expect(src).toContain("background: selected ? fill : 'transparent'");
    expect(src).toContain("color: selected ? getReadableText(fill) : 'var(--text-secondary)'");
  });
});

describe('Non-pasture residuals - root Playwright suite scope', () => {
  it('keeps local screenshot and audit utilities out of broad root e2e runs', () => {
    const src = read('playwright.config.js');
    expect(src).toContain('const hasExplicitSpecArg =');
    expect(src).toContain('const rootRunUtilityIgnores = hasExplicitSpecArg');
    expect(src).toContain("testIgnore: ['**/pasture_map_*.spec.js', ...rootRunUtilityIgnores]");

    for (const pattern of [
      '**/audit_review_screenshots.spec.js',
      '**/broiler_batches_redesign_screenshots.spec.js',
      '**/cattle_log_screenshots.spec.js',
      '**/cattle_sheep_columns_screenshots.spec.js',
      '**/daily_redesign_screenshots.spec.js',
      '**/production_redesign_screenshots.spec.js',
      '**/todo_screenshots.spec.js',
      '**/mobile_audit.spec.js',
      '**/ux_audit.spec.js',
    ]) {
      expect(src).toContain(pattern);
    }
  });
});
