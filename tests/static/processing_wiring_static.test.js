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
