import {test, expect} from './fixtures.js';

// ============================================================================
// Animals on Farm — layer-count accuracy + species small multiples.
//
// Seeds the PROD-shaped defect scenario behind the wrong 701 layer total:
//   - batch l-26-01 owns BOTH Eggmobile 2 (156) and Layer Schooner (293)
//   - batch l-26-03 owns Eggmobile 3 (115)
//   - Retirement Home (67) has dated dailys but NO start_date
// Correct layer total = 156 + 293 + 115 + 67 = 631. The legacy shared
// batch_id match produced 293 + 293 + 115 = 701 and dropped Retirement Home.
//
// Also proves the combined Total is gone from Home + the history page and
// that the species small multiples render one per-species-scaled chart.
//
// NOTE: this spec drives the authenticated Home page and resets/seeds the
// shared TEST database. Run it only inside an approved TEST window, one file
// per invocation.
// ============================================================================

const EXPECTED_LAYER_TOTAL = '631';

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// The daily report date also drives the freshness disclosure assertions: the
// UI must disclose THIS date as "last reported", not today/as-of.
const REPORT_DATE = isoDaysAgo(3);

async function seedLayerDefectScenario(supabaseAdmin) {
  const must = ({error}, label) => {
    if (error) throw new Error(label + ': ' + error.message);
  };
  const startDate = isoDaysAgo(40);
  const reportDate = REPORT_DATE;

  must(
    await supabaseAdmin.from('layer_batches').upsert(
      [
        {id: 'lb-2601', name: 'L-26-01', status: 'active', arrival_date: startDate},
        {id: 'lb-2603', name: 'L-26-03', status: 'active', arrival_date: startDate},
        {id: 'lb-rh', name: 'Retirement Home', status: 'active'},
      ],
      {onConflict: 'id'},
    ),
    'layer_batches upsert',
  );
  must(
    await supabaseAdmin.from('layer_housings').upsert(
      [
        {id: 'h-e2', batch_id: 'lb-2601', housing_name: 'Eggmobile 2', status: 'active', start_date: startDate},
        {id: 'h-ls', batch_id: 'lb-2601', housing_name: 'Layer Schooner', status: 'active', start_date: startDate},
        {id: 'h-e3', batch_id: 'lb-2603', housing_name: 'Eggmobile 3', status: 'active', start_date: startDate},
        // Retirement Home intentionally has NO start_date: only dated daily
        // evidence establishes that it is active.
        {id: 'h-rh', batch_id: 'lb-rh', housing_name: 'Retirement Home', status: 'active'},
      ],
      {onConflict: 'id'},
    ),
    'layer_housings upsert',
  );
  // layer_dailys.id is a client-generated text key (no DB default): fixed ids
  // + upsert keep the seed idempotent behind the resetTestDatabase() wipe.
  must(
    await supabaseAdmin.from('layer_dailys').upsert(
      [
        {
          id: 'ld-ah-e2',
          batch_label: 'Eggmobile 2',
          batch_id: 'lb-2601',
          date: reportDate,
          layer_count: 156,
          team_member: 'BMAN',
        },
        {
          id: 'ld-ah-ls',
          batch_label: 'Layer Schooner',
          batch_id: 'lb-2601',
          date: reportDate,
          layer_count: 293,
          team_member: 'BMAN',
        },
        {
          id: 'ld-ah-e3',
          batch_label: 'Eggmobile 3',
          batch_id: 'lb-2603',
          date: reportDate,
          layer_count: 115,
          team_member: 'BMAN',
        },
        {
          id: 'ld-ah-rh',
          batch_label: 'Retirement Home',
          batch_id: 'lb-rh',
          date: reportDate,
          layer_count: 67,
          team_member: 'BMAN',
        },
      ],
      {onConflict: 'id'},
    ),
    'layer_dailys upsert',
  );
}

test.describe('Animals on Farm layer accuracy and small multiples', () => {
  test.beforeEach(async ({resetDb, supabaseAdmin}) => {
    await resetDb();
    await seedLayerDefectScenario(supabaseAdmin);
  });

  test('Home card and history page agree on the exact-label layer total with no combined Total', async ({page}) => {
    await page.goto('/');

    // Home Animals on Farm card: five species stats, no Total tile.
    const animalsGrid = page.locator('[data-home-grid="animals"]');
    await expect(animalsGrid).toBeVisible({timeout: 20_000});
    await expect(animalsGrid.locator('.stat')).toHaveCount(5);
    await expect(animalsGrid).not.toContainText('Total');

    // Sibling housings under one batch keep their own counts: 631, never 701.
    const layersStat = animalsGrid.locator('.stat', {hasText: 'Layer Hens'});
    await expect(layersStat).toContainText(EXPECTED_LAYER_TOTAL, {timeout: 20_000});

    // Freshness disclosure: latest RECORDED counts; the disclosed layer date
    // is the OLDEST contributing source-evidence date (the seeded dailys all
    // share one date), never today's date. All contributors are dated, so the
    // undated warning must be absent.
    const homeNote = page.locator('[data-animals-freshness-note="true"]');
    await expect(homeNote).toBeVisible();
    await expect(homeNote).toContainText('Latest recorded counts, not verified current counts');
    await expect(homeNote).toContainText('Oldest layer count used was reported');
    await expect(homeNote).toHaveAttribute('data-layers-oldest-reported', REPORT_DATE);
    await expect(homeNote).toHaveAttribute('data-layers-has-undated', 'false');
    await expect(homeNote).not.toContainText('no reported date');

    // Review capture for Ronnie's UI-preview gate (Home card, no Total tile).
    await page.locator('button.card.stats').filter({hasText: 'Animals on Farm'}).screenshot({
      path: 'test-results/home-animals-card.png',
    });

    // The whole card opens the history page.
    await page.locator('button.card.stats').filter({hasText: 'Animals on Farm'}).click();
    await expect(page).toHaveURL(/\/animals-on-farm$/);
    await expect(page.locator('[data-animal-history-page="true"]')).toHaveAttribute(
      'data-animal-history-loaded',
      'true',
      {timeout: 20_000},
    );

    // History page: same layer figure on the layers chart header (test 8 —
    // Home and Animals on Farm calculations agree).
    await expect(page.locator('[data-animal-history-latest="layers"]')).toHaveText(EXPECTED_LAYER_TOTAL);

    // Freshness disclosure on the page: header line + layers chart tag both
    // carry the seeded OLDEST evidence date, no undated warning appears, and
    // the table method note is visible.
    const pageNote = page.locator('[data-animal-history-layers-oldest-reported]');
    await expect(pageNote).toBeVisible();
    await expect(pageNote).toContainText('Oldest layer count used was reported');
    await expect(pageNote).toHaveAttribute('data-animal-history-layers-oldest-reported', REPORT_DATE);
    await expect(pageNote).toHaveAttribute('data-animal-history-layers-has-undated', 'false');
    await expect(pageNote).not.toContainText('no reported date');
    const layersOldest = page.locator('[data-animal-history-series="layers"] [data-animal-history-oldest-reported]');
    await expect(layersOldest).toBeVisible();
    await expect(layersOldest).toContainText('oldest count reported');
    await expect(layersOldest).toHaveAttribute('data-animal-history-oldest-reported', REPORT_DATE);
    await expect(page.locator('[data-animal-history-series="layers"] [data-animal-history-has-undated]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-animal-history-method-note="true"]')).toContainText(
      'latest count recorded on or before',
    );

    // Species small multiples: one chart per species, each its own scale.
    const multiples = page.locator('[data-animal-history-chart="multiples"]');
    await expect(multiples).toBeVisible();
    for (const key of ['broilers', 'layers', 'pigs', 'cattle', 'sheep']) {
      await expect(multiples.locator(`[data-animal-history-series="${key}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-animal-history-scale-note="true"]')).toBeVisible();

    // No Total remnants: header figure, legend, chart series, table column.
    await expect(page.locator('[data-animal-history-latest-total]')).toHaveCount(0);
    const headerCells = page.locator('[data-animal-history-table="true"] thead th');
    await expect(headerCells).toHaveCount(6); // Month + 5 species
    await expect(page.locator('[data-animal-history-table="true"] thead')).not.toContainText('Total');

    // Table keeps exact values for the current month row.
    const currentRow = page.locator('[data-animal-history-table="true"] tbody tr').first();
    await expect(currentRow).toContainText(EXPECTED_LAYER_TOTAL);

    // Review capture for Ronnie's UI-preview gate (desktop).
    await page.screenshot({path: 'test-results/animal-history-desktop.png', fullPage: true});
  });

  test('mobile renders one readable chart per row without horizontal page overflow', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/animals-on-farm');
    await expect(page.locator('[data-animal-history-page="true"]')).toHaveAttribute(
      'data-animal-history-loaded',
      'true',
      {timeout: 20_000},
    );

    const multiples = page.locator('[data-animal-history-chart="multiples"]');
    await expect(multiples).toBeVisible();

    // Single-column stack: every species chart starts at the same x offset.
    const boxes = [];
    for (const key of ['broilers', 'layers', 'pigs', 'cattle', 'sheep']) {
      const box = await multiples.locator(`[data-animal-history-series="${key}"]`).boundingBox();
      expect(box).not.toBeNull();
      boxes.push(box);
    }
    const xs = new Set(boxes.map((b) => Math.round(b.x)));
    expect(xs.size).toBe(1);

    // No horizontal page overflow at phone width.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    // Review capture for Ronnie's UI-preview gate (mobile).
    await page.screenshot({path: 'test-results/animal-history-mobile.png', fullPage: true});
  });
});
