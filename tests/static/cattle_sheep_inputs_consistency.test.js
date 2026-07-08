// ============================================================================
// Cattle & Sheep Inputs — consistency sweep across non-webform entry surfaces
// ============================================================================
// Sibling lock to `livestock_feed_inputs_panel.test.js`. After the public
// WebformHub + AddFeedWebform fix, this lane closes the gap on the
// logged-in entry surfaces that load `cattle_feed_inputs`:
//
//   - src/cattle/CattleDailysView.jsx  — admin/management edit of cattle
//                                        daily reports.
//   - src/sheep/SheepDailysView.jsx    — admin/management edit of sheep
//                                        daily reports.
//   - src/shared/AdminAddReportModal.jsx — admin "Add Report" flow.
//   - src/cattle/CattleDailyPage.jsx   — cattle daily report record page
//                                        (open-to-edit feed/mineral dropdowns).
//   - src/sheep/SheepDailyPage.jsx     — sheep daily report record page
//                                        (open-to-edit feed/mineral dropdowns).
//
// Rule each surface must follow:
//
//   1. No server-side `.eq('status', 'active')` predicate against
//      `cattle_feed_inputs`. The server filter would exclude legacy
//      rows whose status column is null / undefined / blank — those
//      must still surface as eligible per the Operator Clarity
//      contract.
//
//   2. New-selection dropdowns must filter out rows where
//      `status === 'inactive'`. Either via a load-time client filter
//      (admin add-only flows, no historical edit) or via a call-site
//      filter at every dropdown render (CattleDailys / SheepDailys —
//      historical edit must still resolve inactive-by-id feeds via
//      the unfiltered loaded array, so the filter lives at the
//      dropdown call site).
//
// Out of scope (intentionally not locked here):
//   - src/admin/LivestockFeedInputsPanel.jsx — master list, must
//     surface inactive rows under the Inactive feeds toggle. Has its
//     own dedicated lock file already.
//   - src/admin/FeedCostByMonthPanel.jsx     — builds a historical
//     cost lookup map by name and must read every row, active or
//     inactive.
// ============================================================================

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, it, expect} from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const cattleDailysSrc = readFileSync(resolve(ROOT, 'src/cattle/CattleDailysView.jsx'), 'utf8');
const sheepDailysSrc = readFileSync(resolve(ROOT, 'src/sheep/SheepDailysView.jsx'), 'utf8');
const adminAddReportSrc = readFileSync(resolve(ROOT, 'src/shared/AdminAddReportModal.jsx'), 'utf8');
const cattleDailyPageSrc = readFileSync(resolve(ROOT, 'src/cattle/CattleDailyPage.jsx'), 'utf8');
const sheepDailyPageSrc = readFileSync(resolve(ROOT, 'src/sheep/SheepDailyPage.jsx'), 'utf8');

const ENTRY_SURFACES = [
  ['src/cattle/CattleDailysView.jsx', cattleDailysSrc],
  ['src/sheep/SheepDailysView.jsx', sheepDailysSrc],
  ['src/shared/AdminAddReportModal.jsx', adminAddReportSrc],
  ['src/cattle/CattleDailyPage.jsx', cattleDailyPageSrc],
  ['src/sheep/SheepDailyPage.jsx', sheepDailyPageSrc],
];

describe('cattle/sheep entry surfaces — no server-side status filter at load', () => {
  for (const [label, src] of ENTRY_SURFACES) {
    it(`${label} does not pin cattle_feed_inputs to .eq('status', 'active')`, () => {
      // The legacy `.eq('status', 'active')` predicate excludes rows whose
      // status is null / undefined / blank. Drop the server filter and apply
      // the inactive-exclusion check client-side so legacy rows fall through.
      expect(src).toMatch(/from\('cattle_feed_inputs'\)/);
      expect(src).not.toMatch(/\.eq\(\s*'status'\s*,\s*'active'\s*\)/);
    });
  }
});

describe('CattleDailysView — call-site filter on dropdowns', () => {
  it('feed dropdown predicate excludes inactive inputs', () => {
    // The feed dropdown filter sits next to the category + herd_scope
    // checks. Locking on the inline pattern catches both the existing
    // category/herd predicate and the new status guard in one place.
    expect(cattleDailysSrc).toMatch(
      /feedsForHerd = feedInputs\.filter\(\s*\(f\) =>[\s\S]*?f\.status !== 'inactive'[\s\S]*?f\.category !== 'mineral'[\s\S]*?f\.herd_scope/,
    );
  });

  it('mineral dropdown predicate excludes inactive inputs', () => {
    expect(cattleDailysSrc).toMatch(
      /const minerals = feedInputs\.filter\(\(f\) => f\.status !== 'inactive' && f\.category === 'mineral'\)/,
    );
  });

  it('retains the unfiltered feedInputs array so save-time .find() resolves inactive-by-id rows', () => {
    // Save-time builds the feeds/minerals snapshot via `.find((x) => x.id === r.feedId)`
    // on the unfiltered array; filtering at load time would silently drop
    // historical inactive references on next save.
    expect(cattleDailysSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === r\.feedId\)/);
    expect(cattleDailysSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === m\.feedId\)/);
  });
});

describe('SheepDailysView — call-site filter on dropdowns', () => {
  it('feed dropdown predicate excludes inactive inputs', () => {
    expect(sheepDailysSrc).toMatch(
      /feedsForFlock = feedInputs\.filter\(\s*\(f\) =>[\s\S]*?f\.status !== 'inactive'[\s\S]*?f\.category !== 'mineral'[\s\S]*?f\.herd_scope/,
    );
  });

  it('mineral dropdown predicate excludes inactive inputs', () => {
    expect(sheepDailysSrc).toMatch(
      /const minerals = feedInputs\.filter\(\(f\) => f\.status !== 'inactive' && f\.category === 'mineral'\)/,
    );
  });

  it('retains the unfiltered loaded array for historical .find() lookups', () => {
    expect(sheepDailysSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === r\.feedId\)/);
    expect(sheepDailysSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === m\.feedId\)/);
  });

  it('keeps the load-time herd_scope sub-filter so the loaded array stays sheep-relevant', () => {
    // Pre-existing optimization unrelated to the status fix: only load rows
    // whose herd_scope overlaps with at least one active sheep flock. Locked
    // here so the consistency sweep doesn't accidentally widen the load
    // surface beyond what the file used to ship.
    expect(sheepDailysSrc).toMatch(/SHEEP_ACTIVE_FLOCKS\.includes/);
  });
});

describe('AdminAddReportModal — load-time client filter (new-record-only flow)', () => {
  it("setCattleFeedInputs applies .filter((f) => f.status !== 'inactive')", () => {
    // Admin "Add Report" only ever inserts new rows, so a load-time client
    // filter is safe: every save-time .find() against cattleFeedInputs maps
    // to a row the user picked from the already-filtered dropdown.
    expect(adminAddReportSrc).toMatch(/setCattleFeedInputs\(\s*data\.filter\(\(f\) => f\.status !== 'inactive'\)\s*\)/);
  });
});

describe('CattleDailyPage — record page dropdown filter (historical edit flow)', () => {
  it('feed dropdown options exclude inactive inputs', () => {
    expect(cattleDailyPageSrc).toMatch(
      /feedOptions = feedInputs\.filter\(\(fi\) => fi\.status !== 'inactive' && fi\.category !== 'mineral'\)/,
    );
  });

  it('mineral dropdown options exclude inactive inputs', () => {
    expect(cattleDailyPageSrc).toMatch(
      /mineralOptions = feedInputs\.filter\(\(fi\) => fi\.status !== 'inactive' && fi\.category === 'mineral'\)/,
    );
  });

  it('retains the unfiltered feedInputs array so save-time .find() resolves inactive-by-id rows', () => {
    // The loaded feedInputs array is NOT status-filtered, so opening a report
    // that references a since-inactivated feed still resolves it on save.
    expect(cattleDailyPageSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === r\.feedId\)/);
    expect(cattleDailyPageSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === m\.feedId\)/);
  });
});

describe('SheepDailyPage — record page dropdown filter (historical edit flow)', () => {
  it('feedCategories option map excludes inactive inputs (drives both feed + mineral dropdowns)', () => {
    expect(sheepDailyPageSrc).toMatch(
      /feedCategories = feedInputs\s*\.filter\(\(fi\) => fi\.status !== 'inactive'\)\s*\.reduce\(/,
    );
  });

  it('retains the unfiltered feedInputs array so save-time .find() resolves inactive-by-id rows', () => {
    expect(sheepDailyPageSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === r\.feedId\)/);
    expect(sheepDailyPageSrc).toMatch(/feedInputs\.find\(\(x\) => x\.id === m\.feedId\)/);
  });
});

describe('entry-surface consistency — no entry surface drifts back to .eq active', () => {
  // Aggregate negative assertion mirrors the public-webform lock so a future
  // refactor on any of the three named surfaces cannot reintroduce the
  // server-side status pin.
  for (const [label, src] of ENTRY_SURFACES) {
    it(`${label}: defensive negative — no .eq('status', 'active') anywhere`, () => {
      expect(src).not.toMatch(/\.eq\(\s*'status'\s*,\s*'active'\s*\)/);
    });
  }
});
