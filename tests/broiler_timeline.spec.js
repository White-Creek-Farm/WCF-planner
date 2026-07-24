import {test, expect} from './fixtures.js';

// ============================================================================
// Broiler timeline range + auto-scroll spec — Phase A7
// ============================================================================
// Codex-reviewed scope: lock the data-derived range + auto-scroll contract
// on /broiler/timeline. Single read-only component (no §7 entries to walk).
//
// 4 tests:
//   1  range derivation: broiler-only data dictates tlStart/tlEnd
//   2  range derivation: layer batches contribute, Retirement Home excluded
//      (combined into one test — the seed places Retirement's projected end
//      date LATER than the active layer's, so asserting tlEnd === active+30
//      proves both inclusion AND the Retirement-Home exclusion that would
//      otherwise be only "indirectly" tested)
//   3  auto-scroll lands today near the left edge (~12% offset)
//   4  today indicator (vertical green line) renders within the gantt
//
// Production hooks added in this PR for stable selection:
//   - data-week-header="1" + data-iso={toISO(w)} on each labeled week cell
//   - data-today-line="1" on the today-indicator div (rendered once per
//     resource row — Tests assert .first() since one is enough)
// ============================================================================

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Test 1 — broiler-only range derivation
// --------------------------------------------------------------------------
test('range: broiler-only data sets tlStart=today-90 and tlEnd=processing+30', async ({
  page,
  broilerTimelineScenario,
}) => {
  const {tlStart, tlEnd} = await broilerTimelineScenario({});

  await page.goto('/broiler/timeline');

  // Wait for the gantt to render. The element exists in the JSX even when
  // batches array is empty, but for a stable read we wait on the first
  // labeled week header which only renders post-data-load.
  const headers = page.locator('[data-week-header="1"]');
  await expect(headers.first()).toBeVisible({timeout: 15_000});

  // First header anchored at tlStart per the contract at
  // BroilerTimelineView.jsx:62 — wkHdrs[0] = tlS = tlStart.
  const firstIso = await headers.first().getAttribute('data-iso');
  expect(firstIso).toBe(tlStart);

  // Last header is the start of the week covering tlEnd: lastIso <= tlEnd
  // < lastIso + 7d. weeksShown = ceil(totalDays / 7), so the last week
  // can extend up to 6 days beyond tlEnd.
  const lastIso = await headers.last().getAttribute('data-iso');
  expect(lastIso <= tlEnd).toBe(true);
  expect(addDaysISO(lastIso, 7) > tlEnd).toBe(true);

  // Total width matches the formula: ceil(totalDays / 7) * 120.
  const gantt = page.locator('[data-gantt="1"]');
  const widthPx = await gantt.evaluate((el) => parseInt(el.style.width, 10));
  const tlS = new Date(tlStart + 'T12:00:00');
  const tlE = new Date(tlEnd + 'T12:00:00');
  const totalDays = Math.max(1, Math.round((tlE - tlS) / 86400000));
  expect(widthPx).toBe(Math.ceil(totalDays / 7) * 120);
});

// --------------------------------------------------------------------------
// Test 2 — active layer included, Retirement Home excluded (combined)
// --------------------------------------------------------------------------
test('range: active layer extends right bound; Retirement Home excluded', async ({page, broilerTimelineScenario}) => {
  // Seed has broiler processing today+60, active layer ending today+180,
  // Retirement Home ending today+240. If Retirement were included,
  // tlEnd would be today+270 instead of today+210.
  const {today, tlEnd, latestEnd} = await broilerTimelineScenario({
    withActiveLayer: true,
    withRetirement: true,
  });

  // Sanity: latestEnd should reflect the active layer (today+180), NOT
  // Retirement Home (today+240). If this assertion fails, the seed is
  // miscomputing — look there before changing the test.
  expect(latestEnd).toBe(addDaysISO(today, 180));
  expect(tlEnd).toBe(addDaysISO(today, 210));

  await page.goto('/broiler/timeline');
  const headers = page.locator('[data-week-header="1"]');
  await expect(headers.first()).toBeVisible({timeout: 15_000});

  // Last week header is the start of the week covering today+210, NOT
  // today+240. If Retirement weren't excluded, the last header would be
  // ~30 days later and this bound check would fail.
  const lastIso = await headers.last().getAttribute('data-iso');
  expect(lastIso <= tlEnd).toBe(true);
  expect(addDaysISO(lastIso, 7) > tlEnd).toBe(true);

  // Stronger: assert the last header is BEFORE today+240 (i.e. before
  // where Retirement would have placed it). This is the "real value"
  // exclusion lock Codex called out — without this, a regression that
  // re-includes Retirement could pass Test 2 if the new tlEnd happens
  // to be in the same final week.
  expect(lastIso < addDaysISO(today, 240)).toBe(true);
});

// --------------------------------------------------------------------------
// Test 3 — auto-scroll lands today near left edge
// --------------------------------------------------------------------------
test('auto-scroll: today is positioned ~12% from the left edge on first paint', async ({
  page,
  broilerTimelineScenario,
}) => {
  // Use the wider seed (with active layer) so the gantt is wide enough
  // to actually require scrolling — narrow ranges may have
  // scrollWidth <= clientWidth and the auto-scroll guards short-circuit
  // (BroilerTimelineView.jsx:71).
  const {today, tlStart} = await broilerTimelineScenario({withActiveLayer: true});

  await page.goto('/broiler/timeline');
  await expect(page.locator('[data-week-header="1"]').first()).toBeVisible({timeout: 15_000});

  // Read the layout values directly from the DOM and compute the
  // expected scrollLeft using the same formula the component uses
  // (lines 72-74).
  const layout = await page.evaluate(() => {
    const inner = document.querySelector('[data-gantt="1"]');
    const wrap = inner.parentElement;
    return {
      scrollLeft: wrap.scrollLeft,
      clientWidth: wrap.clientWidth,
      scrollWidth: wrap.scrollWidth,
      ganttPx: parseInt(inner.style.width, 10),
    };
  });

  // Sanity: the gantt is wider than the viewport (otherwise auto-scroll
  // would short-circuit and scrollLeft = 0). If this fails, increase
  // the seed's date range.
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth);

  // Expected scrollLeft per BroilerTimelineView.jsx:72-74:
  //   targetX = (todayPct/100) * ganttPx - clientWidth * 0.12
  //   scrollLeft = max(0, targetX)
  const tlS = new Date(tlStart + 'T12:00:00');
  const tlE_iso = await page.locator('[data-week-header="1"]').last().getAttribute('data-iso');
  // Reconstruct totalDays from the rendered range. We derive end from
  // the last header + 7d (the week boundary) for an upper-bound match
  // to ceil(totalDays / 7) * 7.
  const lastWeekStart = new Date(tlE_iso + 'T12:00:00');
  const renderedDays = Math.round((lastWeekStart - tlS) / 86400000) + 7;
  const todayDays = Math.round((new Date(today + 'T12:00:00') - tlS) / 86400000);
  const todayPct = (todayDays / renderedDays) * 100;
  const expectedScroll = Math.max(0, (todayPct / 100) * layout.ganttPx - layout.clientWidth * 0.12);

  // Tolerance: ±20px covers minor rounding differences between the
  // component's internal totalDays (computed from tlS/tlE Date objects)
  // and our rendered-week reconstruction.
  expect(Math.abs(layout.scrollLeft - expectedScroll)).toBeLessThan(20);
});

// --------------------------------------------------------------------------
// Test 4 — today indicator visible within the gantt
// --------------------------------------------------------------------------
test('today indicator: vertical green line renders within the gantt', async ({page, broilerTimelineScenario}) => {
  await broilerTimelineScenario({withActiveLayer: true});

  await page.goto('/broiler/timeline');
  await expect(page.locator('[data-week-header="1"]').first()).toBeVisible({timeout: 15_000});

  // The today line is rendered once per resource row (inside the
  // RESOURCES.map loop, BroilerTimelineView.jsx:190-193). Asserting
  // .first() is visible is enough — if the conditional `todayPct >= 0
  // && todayPct <= 100` ever fails, all instances disappear together.
  const todayLine = page.locator('[data-today-line="1"]').first();
  await expect(todayLine).toBeVisible();

  // Sanity: there's at least one (proves the conditional evaluated truthy).
  // Multiple is fine and expected (one per row); we don't lock the count.
  const count = await page.locator('[data-today-line="1"]').count();
  expect(count).toBeGreaterThanOrEqual(1);
});

// --------------------------------------------------------------------------
// Test 5 — row separation: boundary divider + schooner alternating fills
// --------------------------------------------------------------------------
// Locks the visual-scanning hotfix on the rendered surface:
//   - exactly one strong 2px divider, at the brooder -> schooner boundary
//     (above Schooner 1), NOT above Brooder 3
//   - schooner rows alternate plain / shaded fill in resource order
//   - the fill covers BOTH the sticky label cell and the grid body (one band)
//   - brooder rows stay unstriped (transparent grid body)
test('row separation: divider at brooder/schooner boundary and schooner fills alternate', async ({
  page,
  broilerTimelineScenario,
}) => {
  await broilerTimelineScenario({withActiveLayer: true});

  await page.goto('/broiler/timeline');
  await expect(page.locator('[data-week-header="1"]').first()).toBeVisible({timeout: 15_000});

  const rows = await page.evaluate(() => {
    const bg = (el) => (el ? getComputedStyle(el).backgroundColor : null);
    return [...document.querySelectorAll('[data-resource-row="1"]')].map((row) => ({
      label: row.getAttribute('data-resource-label'),
      type: row.getAttribute('data-resource-type'),
      fill: row.getAttribute('data-row-fill'),
      divider: row.getAttribute('data-row-divider'),
      borderTopWidth: getComputedStyle(row).borderTopWidth,
      labelBg: bg(row.querySelector('[data-row-region="label"]')),
      gridBg: bg(row.querySelector('[data-row-region="grid"]')),
    }));
  });

  // All eight resource rows render.
  expect(rows.map((r) => r.label)).toEqual([
    'Brooder 1',
    'Brooder 2',
    'Brooder 3',
    'Schooner 1',
    'Schooner 2 & 3',
    'Schooner 4 & 5',
    'Schooner 6 & 6A',
    'Schooner 7 & 7A',
  ]);

  // Exactly one divider, on Schooner 1, at 2px; the row above it is a brooder.
  const dividerRows = rows.filter((r) => r.divider === '1');
  expect(dividerRows).toHaveLength(1);
  expect(dividerRows[0].label).toBe('Schooner 1');
  expect(dividerRows[0].type).toBe('schooner');
  expect(dividerRows[0].borderTopWidth).toBe('2px');
  const dividerIdx = rows.findIndex((r) => r.divider === '1');
  expect(rows[dividerIdx - 1].type).toBe('brooder');
  expect(rows[dividerIdx - 1].label).toBe('Brooder 3');
  // No other row carries the thick border.
  rows.filter((r) => r.divider !== '1').forEach((r) => expect(r.borderTopWidth).toBe('1px'));

  // Schooner fill bands alternate in resource order, starting plain.
  const schooners = rows.filter((r) => r.type === 'schooner');
  expect(schooners.map((r) => r.fill)).toEqual(['plain', 'shaded', 'plain', 'shaded', 'plain']);

  // Every schooner row is one continuous band: label cell bg === grid body bg.
  schooners.forEach((r) => expect(r.labelBg).toBe(r.gridBg));

  // Shaded and plain fills are visually distinct.
  const plainBg = schooners.find((r) => r.fill === 'plain').gridBg;
  const shadedBg = schooners.find((r) => r.fill === 'shaded').gridBg;
  expect(plainBg).not.toBe(shadedBg);

  // Brooder rows stay unstriped: transparent grid body, fill marked 'none'.
  const brooders = rows.filter((r) => r.type === 'brooder');
  brooders.forEach((r) => {
    expect(r.fill).toBe('none');
    expect(r.gridBg).toBe('rgba(0, 0, 0, 0)');
  });
});
