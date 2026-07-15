import {describe, test, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

// ============================================================================
// EquipmentMeterStatusPanel scope + behavior lock
// ============================================================================
// After the Toro 205h stale-reading incident the admin Equipment Detail page
// gained an explicit Meter Status panel with a Sync action. This lock keeps:
//   * The sync write scoped to the single selected equipment id (no bulk
//     write that could touch other equipment rows).
//   * The reading source pinned to currentReadingFromFuelings (the same
//     helper the post-save / post-delete auto-sync in EquipmentDetail uses,
//     so manual and automatic paths can't diverge).
//   * Browser alert/confirm/prompt out of this surface — InlineNotice only.
//   * The 3-state classification (matching / ahead / behind) present in the
//     panel so the visual encoding doesn't quietly collapse to a single
//     state in a future refactor.
//
// The companion EquipmentDetail.jsx changes (panel placement + why-due math
// line on interval tiles) are locked here too via grep over that file.
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const panelPath = join(__dirname, '../../src/equipment/EquipmentMeterStatusPanel.jsx');
const detailPath = join(__dirname, '../../src/equipment/EquipmentDetail.jsx');
const panelSrc = readFileSync(panelPath, 'utf-8');
const detailSrc = readFileSync(detailPath, 'utf-8');

describe('EquipmentMeterStatusPanel — sync scope', () => {
  test('panel updates the equipment table filtered by eq.id only', () => {
    // The only Supabase update path in the panel must be
    // .from('equipment').update(...).eq('id', eq.id). A bulk update without
    // the id filter would risk overwriting unrelated equipment current_*.
    const updateMatches = panelSrc.match(
      /sb\s*\.\s*from\(\s*['"]equipment['"]\s*\)\s*\.update\([^)]*\)\s*\.eq\(\s*['"]id['"]\s*,\s*eq\.id\s*\)/g,
    );
    expect(updateMatches, 'expected exactly one scoped equipment update').not.toBeNull();
    expect(updateMatches.length).toBe(1);
  });

  test('panel never writes to any table other than `equipment`', () => {
    const otherTableWrites =
      panelSrc.match(/sb\s*\.\s*from\(\s*['"]([^'"]+)['"]\s*\)\s*\.(insert|update|upsert|delete)/g) || [];
    for (const m of otherTableWrites) {
      expect(m, `unexpected non-equipment write: ${m}`).toMatch(/from\(\s*['"]equipment['"]/);
    }
  });

  test('sync action sources the value from currentReadingFromFuelings', () => {
    expect(panelSrc).toMatch(/currentReadingFromFuelings\s*\(/);
    expect(panelSrc).toContain("import {currentReadingFromFuelings, fmtReading} from '../lib/equipment.js'");
  });

  test('no browser alert/confirm/prompt in the panel', () => {
    expect(panelSrc).not.toMatch(/\balert\s*\(/);
    expect(panelSrc).not.toMatch(/\bwindow\.alert\s*\(/);
    // confirm/prompt are allowed via _wcfConfirmDelete / _wcfConfirm; raw
    // window.confirm / window.prompt are not.
    expect(panelSrc).not.toMatch(/\bwindow\.confirm\s*\(/);
    expect(panelSrc).not.toMatch(/\bwindow\.prompt\s*\(/);
  });

  test('renders all three classification states', () => {
    // Visual encoding must distinguish matching / ahead / behind so the
    // operator can read the panel without inspecting the diff math.
    expect(panelSrc).toContain("'matching'");
    expect(panelSrc).toContain("'ahead'");
    expect(panelSrc).toContain("'behind'");
    // Plus the data-attribute test hook used by the audit + e2e specs.
    expect(panelSrc).toContain('data-meter-status-state');
    expect(panelSrc).toContain('data-meter-status-panel');
    expect(panelSrc).toContain('data-meter-sync-button');
  });

  test('success / warning / error notice kinds are wired', () => {
    expect(panelSrc).toMatch(/kind:\s*['"]success['"]/);
    expect(panelSrc).toMatch(/kind:\s*['"]error['"]/);
    expect(panelSrc).toMatch(/kind:\s*['"]warning['"]/);
  });

  test('null / undefined / empty current reading classifies as no_current, not behind', () => {
    // Number(null) coerces to 0, which would silently misclassify a fresh
    // equipment row with no stored meter as "behind by 167h". The panel
    // must inspect rawCurrent before Number() to detect missing values.
    expect(panelSrc).toMatch(/rawCurrent\s*!==\s*null/);
    expect(panelSrc).toMatch(/rawCurrent\s*!==\s*undefined/);
    expect(panelSrc).toMatch(/rawCurrent\s*!==\s*['"]['"]/);
    expect(panelSrc).toMatch(/Number\.isFinite\(Number\(rawCurrent\)\)/);
    // currentReading is null when not present, not 0.
    expect(panelSrc).toMatch(/const currentReading = hasCurrent \? Number\(rawCurrent\) : null;/);
  });

  test('sync button is reachable when fuel log exists and current is missing', () => {
    // Codex rework: no_current + has-fuel-log must show the Sync button so
    // admin can populate the missing current from history. The render gate
    // requires hasFuelLog and state !== matching and state !== no_fuel_log,
    // but does NOT require hasCurrent — so no_current still renders the
    // button.
    const gate = panelSrc.match(/hasFuelLog && state !== ['"]matching['"] && state !== ['"]no_fuel_log['"]/);
    expect(gate, 'sync button render gate').not.toBeNull();
    // Defensive: the gate must not require hasCurrent.
    expect(panelSrc).not.toMatch(/hasFuelLog && hasCurrent && state !== ['"]matching['"]/);
  });

  test('explainer copy says "highest fuel-log reading" (not "latest fuel-log entry")', () => {
    // The diff is computed against currentReadingFromFuelings, which is the
    // max reading across all fuelings — not the latest by date. Keep copy
    // aligned with math.
    expect(panelSrc).toContain('higher than the highest fuel-log reading');
    expect(panelSrc).not.toContain('higher than the latest fuel-log entry');
  });

  test('sync success calls onReload with quiet:true so the green notice survives', () => {
    // EquipmentHome.loadAll flips loading=true on a normal reload, which
    // unmounts the detail page and wipes out any inline notice. The Sync
    // success path must request a quiet reload so the "Synced" banner is
    // actually visible to the operator before they navigate away.
    const onReloadCall = panelSrc.match(/if \(onReload\) onReload\(\{quiet:\s*true\}\)/);
    expect(onReloadCall, 'onReload must be called with {quiet: true}').not.toBeNull();
    // Defensive: no bare onReload() call should remain on the sync path
    // (the only onReload invocation in the panel is the one above).
    const bareCalls = panelSrc.match(/onReload\(\)/g);
    expect(bareCalls).toBeNull();
  });

  test('the sync notice is cleared when the panel switches to another equipment row', () => {
    // The detail page keeps the panel MOUNTED while prev/next navigation
    // swaps the equipment prop, so a per-machine sync notice must reset on
    // eq.id change — otherwise "Synced… <N> h" from one machine keeps
    // rendering on every neighbour (the ATV-1 5,437h leak incident).
    expect(panelSrc).toMatch(/const eqId = eq\?\.id;/);
    expect(panelSrc).toMatch(/React\.useEffect\(\(\) => \{\s*\n\s*setNotice\(null\);\s*\n\s*\}, \[eqId\]\);/);
  });
});

describe('EquipmentHome.loadAll — quiet reload option', () => {
  test('accepts {quiet: true} and skips setLoading(true) when set', () => {
    const homePath = join(__dirname, '../../src/equipment/EquipmentHome.jsx');
    const homeSrc = readFileSync(homePath, 'utf-8');
    // Signature must default-destructure so legacy callers (useEffect mount,
    // existing onReload props) still work without an argument.
    expect(homeSrc).toMatch(/const loadAll = React\.useCallback\(\s*async \(\{quiet = false\} = \{\}\) =>/);
    // The setLoading(true) branch must be gated on !quiet so quiet callers
    // don't trigger the loading spinner that unmounts child detail panels.
    expect(homeSrc).toMatch(/if \(!quiet\) setLoading\(true\)/);
  });
});

describe('EquipmentDetail — panel placement + why-due math', () => {
  test('mounts the meter status panel for non-tech viewers', () => {
    expect(detailSrc).toContain('EquipmentMeterStatusPanel');
    // Equipment techs see the per-piece reference materials but not the
    // admin-only meter status / sync action.
    expect(detailSrc).toMatch(/\{!isEquipmentTech && \(\s*<EquipmentMeterStatusPanel/);
  });

  test('passes the locally-built fueling list (not a fresh DB read)', () => {
    // Passing sortedFuelings keeps the panel's diff math consistent with
    // the rest of the page — the same data the per-fueling auto-sync sees.
    expect(detailSrc).toMatch(/<EquipmentMeterStatusPanel[\s\S]*?fuelings=\{sortedFuelings\}/);
  });

  test('upcoming-service tiles include the why-due math + interval-size line', () => {
    expect(detailSrc).toContain('data-interval-tile');
    expect(detailSrc).toContain('data-interval-size');
    expect(detailSrc).toContain('data-interval-math');
    // The math line must reference both current and next-due.
    const mathBlock = detailSrc.match(/data-interval-math="1"[\s\S]*?<\/div>/);
    expect(mathBlock, 'interval math block').not.toBeNull();
    expect(mathBlock[0]).toContain('Current');
    expect(mathBlock[0]).toContain('next at');
  });
});

describe('InlineNotice — success kind palette is reachable', () => {
  test('explicit success branch exists', () => {
    const noticePath = join(__dirname, '../../src/shared/InlineNotice.jsx');
    const noticeSrc = readFileSync(noticePath, 'utf-8');
    expect(noticeSrc).toMatch(/kind\s*===\s*['"]success['"]/);
    expect(noticeSrc).toContain("'success'");
    // Green palette markers from the InlineNotice success branch.
    expect(noticeSrc).toContain('#ecfdf5');
    expect(noticeSrc).toContain('#065f46');
  });
});
