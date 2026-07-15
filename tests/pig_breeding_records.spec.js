import {test, expect} from './fixtures.js';

const breeders = [
  {
    id: 'sow-101',
    tag: '101',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Tamworth',
    origin: 'Home raised',
    birthDate: '2024-03-04',
    lastWeight: '410',
    purchaseDate: '',
    purchaseAmount: '',
    notes: 'Strong maternal line',
    weighins: [
      {id: 'sw-1', date: '2026-01-02', weight: '398'},
      {id: 'sw-2', date: '2026-05-02', weight: '410'},
    ],
  },
  {
    id: 'sow-102',
    tag: '102',
    sex: 'Sow',
    group: '1',
    status: 'Sow Group',
    breed: 'Duroc',
    origin: 'Purchased',
    birthDate: '2024-04-10',
    lastWeight: '390',
    purchaseDate: '2025-01-14',
    purchaseAmount: '350',
    notes: 'Backup breeder',
    weighins: [{id: 'sw-3', date: '2026-05-03', weight: '390'}],
  },
];

async function upsertAppStore(supabaseAdmin, key, data) {
  const {error} = await supabaseAdmin.from('app_store').upsert({key, data}, {onConflict: 'key'});
  if (error) throw new Error('seed ' + key + ': ' + error.message);
}

async function seedBreedingPigs(supabaseAdmin) {
  await upsertAppStore(supabaseAdmin, 'ppp-breeders-v1', breeders);
  await upsertAppStore(supabaseAdmin, 'ppp-breeding-v1', []);
  await upsertAppStore(supabaseAdmin, 'ppp-farrowing-v1', []);
}

test.describe('Pig breeding-pig records', () => {
  test('hub search and record sequence navigation work end to end', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedBreedingPigs(supabaseAdmin);

    await page.goto('/pig/sows');
    const search = page.locator('[data-breeding-pig-search="1"]');
    await expect(search).toBeVisible({timeout: 15_000});
    await expect(page.locator('[data-breeding-pig-row="sow-101"]')).toBeVisible();
    await expect(page.locator('[data-breeding-pig-row="sow-102"]')).toBeVisible();

    await search.fill('Tamworth');
    await expect(page.locator('[data-breeding-pig-row="sow-101"]')).toBeVisible();
    await expect(page.locator('[data-breeding-pig-row="sow-102"]')).toHaveCount(0);

    // Export CSV / Print are compacted away on this hub
    // (EXTENDED_LIST_CONTROLS_ENABLED=false since 64f3cb7); the controls must
    // stay absent rather than render dead buttons.
    await expect(page.locator('[data-breeding-pigs-export-csv="1"]')).toHaveCount(0);
    await expect(page.locator('[data-breeding-pigs-print="1"]')).toHaveCount(0);

    await search.fill('no matching breeder');
    await expect(page.locator('[data-empty-state="breeding-pigs"]')).toContainText(
      'No breeding pigs match the current search',
    );
    await page.locator('[data-breeding-pig-search-clear="1"]').click();

    await page.locator('[data-breeding-pig-row="sow-101"]').click();
    await expect(page).toHaveURL(/\/pig\/sows\/sow-101$/, {timeout: 10_000});
    await expect(page.locator('[data-breeding-pig-record-loaded="true"]')).toBeVisible({timeout: 15_000});
    await expect(page.getByRole('button', {name: /Back to Breeding Pigs/})).toBeVisible();
    await expect(page.locator('[data-record-title="1"]')).toHaveText('#101 Sow');
    await expect(page.locator('[data-breeding-pig-record-details="1"]')).toContainText('Tamworth');
    await expect(page.locator('[data-breeding-pig-weight-history="sow-101"]')).toContainText('410 lb');

    const nextBtn = page.locator('[data-record-seq-next="1"]');
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('1 of 2');
    await expect(nextBtn).toHaveAttribute('aria-label', 'Next record: 102');
    await nextBtn.click();
    await expect(page).toHaveURL(/\/pig\/sows\/sow-102$/, {timeout: 10_000});
    await expect(page.locator('[data-record-title="1"]')).toHaveText('#102 Sow');
    await expect(page.locator('[data-record-seq-position="1"]')).toHaveText('2 of 2');
  });

  test('direct breeder URL renders without clobbering the record route', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    await seedBreedingPigs(supabaseAdmin);

    await page.goto('/pig/sows/sow-101');
    await expect(page).toHaveURL(/\/pig\/sows\/sow-101$/, {timeout: 10_000});
    await expect(page.locator('[data-breeding-pig-record-loaded="true"]')).toBeVisible({timeout: 15_000});
    await expect(page.locator('[data-record-seq-nav="1"]')).toHaveCount(0);

    await page.goto('/pig/sows/missing-breeder');
    await expect(page).toHaveURL(/\/pig\/sows\/missing-breeder$/, {timeout: 10_000});
    await expect(page.locator('[data-breeding-pig-record-not-found="true"]')).toBeVisible({timeout: 15_000});
  });
});
