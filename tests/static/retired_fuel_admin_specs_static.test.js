import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.resolve(__dirname, '..');
const ROOT = path.resolve(TESTS, '..');
const exists = (rel) => fs.existsSync(path.join(TESTS, rel));

// ============================================================================
// Retirement guard — Admin fuel-reporting browser specs.
// ============================================================================
// Commit 5bae452 removed the Admin `Fuel Log` and `Cost by Month` tab buttons
// (an approved product-contract change; PROJECT.md Build Queue item 6 owns the
// dormant panels/APIs/data). The two Playwright specs that drove those surfaces
// clicked the removed `Fuel Log` button and are now UNREACHABLE:
//   - tests/fuel_bill_pdf.spec.js  (uploadFixture -> getByRole('button','Fuel Log'))
//   - tests/fuel_reconcile.spec.js (gotoReconcile -> getByRole('button','Fuel Log'))
// They were RETIRED from collected coverage — not skipped, fixme'd, or retried,
// and no button was restored and no test-only route/backdoor was added. This
// guard makes the removal explicit so the obsolete specs cannot silently
// reappear and so unrelated browser coverage is not reduced by accident.
// ============================================================================

describe('Retired Admin fuel-reporting browser specs', () => {
  it('the two obsolete Admin-surface specs are removed from collected coverage', () => {
    expect(exists('fuel_bill_pdf.spec.js'), 'fuel_bill_pdf.spec.js must stay retired').toBe(false);
    expect(exists('fuel_reconcile.spec.js'), 'fuel_reconcile.spec.js must stay retired').toBe(false);
  });

  it('a contract-accurate rendered-UI proof replaces them (Admin does not see the hidden tabs)', () => {
    expect(exists('admin_fuel_tabs_retired.spec.js')).toBe(true);
    const proof = fs.readFileSync(path.join(TESTS, 'admin_fuel_tabs_retired.spec.js'), 'utf8');
    expect(proof).toContain("'Fuel Log'");
    expect(proof).toContain("'Cost by Month'");
    expect(proof).toMatch(/toHaveCount\(0\)/);
    // No skip/fixme/retry backdoors concealing an obsolete surface.
    expect(proof).not.toMatch(/test\.(skip|fixme)|retries\s*:/);
  });

  it('the dormant scenario/seed helpers are preserved for the later Build Queue item 6 decision', () => {
    const fixtures = fs.readFileSync(path.join(TESTS, 'fixtures.js'), 'utf8');
    expect(fixtures).toContain('fuelBillScenario');
    expect(fixtures).toContain('fuelReconcileScenario');
  });

  it('the source-level guard still asserts both tabs are hidden (retained, not weakened)', () => {
    const guard = fs.readFileSync(path.join(TESTS, 'static/client_errors_review_static.test.js'), 'utf8');
    expect(guard).toContain("expect(wfaSrc).not.toContain(\"{id: 'fuellog', label: 'Fuel Log'}\")");
    expect(guard).toContain("expect(wfaSrc).not.toContain(\"{id: 'costsbymonth', label: 'Cost by Month'}\")");
  });

  it('the dormant implementation + data are NOT deleted (Build Queue item 6 owns that)', () => {
    // Retiring the tests must not delete the panels the hidden tabs render.
    const wfa = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformsAdminView.jsx'), 'utf8');
    expect(wfa).toContain("adminTab === 'fuellog'");
    expect(wfa).toContain("adminTab === 'costsbymonth'");
  });
});
