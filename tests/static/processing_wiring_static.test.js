import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {ACTIVITY_REGISTRY, ENTITY_TYPES, routeToView} from '../../src/lib/activityRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const activityLogView = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
const mainJsx = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const routesSrc = fs.readFileSync(path.join(ROOT, 'src/lib/routes.js'), 'utf8');
const homeDashboard = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');
const processingCalendar = fs.readFileSync(path.join(ROOT, 'src/processing/ProcessingCalendarView.jsx'), 'utf8');

describe('processing wiring — activityRegistry', () => {
  it('registers the processing.record entity type', () => {
    expect(ENTITY_TYPES.PROCESSING_RECORD).toBe('processing.record');
  });

  it('has a registry entry whose route resolves to /processing', () => {
    const entry = ACTIVITY_REGISTRY['processing.record'];
    expect(entry).toBeTruthy();
    expect(typeof entry.route).toBe('function');
    expect(entry.route()).toBe('/processing');
  });

  it('routeToView(/processing) resolves to the processing view', () => {
    expect(routeToView('/processing').view).toBe('processing');
  });
});

describe('processing wiring - admin Asana sync controls', () => {
  it('renders admin-only dry-run and sync buttons that call the Edge Function actions', () => {
    expect(processingCalendar).toContain('data-processing-asana-dry-run-btn="1"');
    expect(processingCalendar).toContain("runAsanaSyncAction('dry_run')");
    expect(processingCalendar).toContain('data-processing-asana-sync-btn="1"');
    expect(processingCalendar).toContain("runAsanaSyncAction('sync_once')");
  });

  it('keeps Sync now disabled until a successful dry run in the page session', () => {
    expect(processingCalendar).toContain('const [dryRunReady, setDryRunReady] = useState(false)');
    expect(processingCalendar).toMatch(/const syncNowDisabled =[\s\S]*?!dryRunReady/);
    expect(processingCalendar).toMatch(/if \(action === 'dry_run'\)[\s\S]*?setDryRunReady\(true\)/);
    // Every write action is gated by ITS OWN dry run (WRITE_REQUIRES map):
    // sync_once needs dry_run; the artifact/activity/attachment imports each
    // need their dedicated dry run and can never ride the record dry run.
    expect(processingCalendar).toMatch(/sync_once: 'dry_run'/);
    expect(processingCalendar).toMatch(/sync_artifacts: 'artifacts_dry_run'/);
    expect(processingCalendar).toMatch(/sync_activity: 'activity_dry_run'/);
    expect(processingCalendar).toMatch(/attachment_backfill: 'attachment_dry_run'/);
    expect(processingCalendar).toMatch(/requiredDryRun === 'dry_run' && !dryRunReady/);
    expect(processingCalendar).toMatch(/!importReady\[requiredDryRun\]/);
  });

  it('locks every Asana admin control when asana_sync_enabled is false (cutover)', () => {
    expect(processingCalendar).toMatch(/asanaSyncEnabled === false/);
    expect(processingCalendar).toMatch(/const asanaLocked =[\s\S]*?asanaSyncEnabled === false/);
  });
});

describe('processing wiring — dry-run report reads the real Edge contract', () => {
  it('dryRunSummary reports tasksFetched/plannerRows/buckets, not the removed would-insert/update/skip fields', () => {
    expect(processingCalendar).toContain('p.buckets');
    expect(processingCalendar).toContain('tasksFetched');
    expect(processingCalendar).toContain('plannerRows');
    // The old UI bug (reading fields runDryRun never returns) is gone.
    expect(processingCalendar).not.toContain('wouldInsert');
    expect(processingCalendar).not.toContain('wouldUpdate');
    expect(processingCalendar).not.toContain('wouldSkip');
  });

  it('renders a read-only DryRunReport panel driven by plan.buckets + review-grade detail', () => {
    expect(processingCalendar).toContain('function DryRunReport');
    expect(processingCalendar).toContain('data-processing-dry-run-report="1"');
    expect(processingCalendar).toContain('plan.buckets');
    for (const key of [
      'plan.review',
      'plan.milestones',
      'plan.collisions',
      'plan.pigCandidates',
      'plan.driftPreview',
    ]) {
      expect(processingCalendar).toContain(key);
    }
    // Stored from the dry_run result and rendered admin-only.
    expect(processingCalendar).toContain('setDryRunPlan((result && result.plan) || null)');
    expect(processingCalendar).toContain('isAdmin && dryRunPlan && <DryRunReport plan={dryRunPlan} />');
  });

  it('the DryRunReport panel is read-only (no write/import affordance inside it)', () => {
    const start = processingCalendar.indexOf('function DryRunReport');
    const end = processingCalendar.indexOf('export default function ProcessingCalendarView', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = processingCalendar.slice(start, end);
    expect(body).not.toContain('runAsanaSyncAction');
    expect(body).not.toContain('sync_once');
    expect(body).not.toMatch(/onClick=/);
  });
});

describe('processing wiring — ActivityLogView labels + filter', () => {
  it('labels processing.record as Processing', () => {
    expect(activityLogView).toContain("'processing.record': 'Processing'");
  });

  it('offers a Processing filter option', () => {
    expect(activityLogView).toContain("{value: 'processing.record', label: 'Processing'}");
  });
});

describe('processing wiring — main.jsx view + role gate', () => {
  it("lists 'processing' among VALID_VIEWS", () => {
    expect(mainJsx).toMatch(/VALID_VIEWS = \[[\s\S]*?'processing'[\s\S]*?\]/);
  });

  it('imports ProcessingCalendarView', () => {
    expect(mainJsx).toMatch(/import ProcessingCalendarView from ['"]\.\/processing\/ProcessingCalendarView\.jsx['"]/);
  });

  it('gates the view to farm_team/management/admin via isProcessingRole', () => {
    expect(mainJsx).toContain('isProcessingRole');
    expect(mainJsx).toMatch(/isProcessingRole\s*=[\s\S]*?\[\s*'farm_team'\s*,\s*'management'\s*,\s*'admin'\s*\]/);
  });

  it('bounces a non-operational role away from the processing view', () => {
    expect(mainJsx).toMatch(/if \(view === 'processing'[\s\S]{0,40}?!isProcessingRole\)\s*setView\('home'\)/);
  });

  it('renders ProcessingCalendarView on the processing view branch', () => {
    expect(mainJsx).toMatch(/if \(view === 'processing'\)/);
    expect(mainJsx).toMatch(/view === 'processing'[\s\S]*?ProcessingCalendarView/);
  });
});

describe('processing wiring — routes.js', () => {
  it("maps processing to '/processing'", () => {
    expect(routesSrc).toMatch(/processing:\s*'\/processing'/);
  });
});

describe('processing wiring — HomeDashboard Processing card', () => {
  it("navigates to the processing view via setView('processing')", () => {
    expect(homeDashboard).toContain("setView('processing')");
  });

  it('no longer routes Processing to the coming-soon overlay', () => {
    expect(homeDashboard).not.toContain("setComingSoon('Processing')");
  });
});
