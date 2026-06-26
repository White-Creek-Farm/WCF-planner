import {test, expect} from './fixtures.js';

// Runtime verification for the Monthly Newsletter (migs 144/145):
//   - a LOGGED-OUT visitor reaches the public archive/issue/preview ABOVE the
//     LoginScreen gate (the architectural crux),
//   - /newsletter/latest resolves, published issues render, the token preview
//     shows the preview banner only for an unexpired draft token, and a missing/
//     wrong token is "not found",
//   - the admin workspace + one-pass editor render for an admin.
// Seeds two throwaway issues (year 2099) via the service client and deletes them
// after; newsletter tables are not in the reset whitelist, so no resetDb needed.

const SHOTS = 'newsletter-shots';
const PREVIEW_TOKEN = 'a'.repeat(32);
const PUB = {id: 'nli-2099-11', ym: '2099-11', slug: '2099-11', title: 'White Creek Farm November 2099 Review'};
const DRAFT = {id: 'nli-2099-10', ym: '2099-10', slug: '2099-10', title: 'White Creek Farm October 2099 Review'};

// Real publish snapshots draft_payload -> published_payload and LEAVES
// draft_payload intact, so a published issue's editor still shows its blocks.
// Seed both with the same blocks to match that workflow shape.
const PUB_BLOCKS = [
  {type: 'heading', text: 'A Great November'},
  {type: 'paragraph', text: 'The herd grew and spirits were high across the farm.'},
  {
    type: 'stats',
    items: [
      {label: 'Cattle on farm', value: '142'},
      {label: 'Calves born', value: '7'},
    ],
  },
];

// Wait for the static boot splash to clear (it fades ~350ms after first paint on
// every route) so screenshots show the real surface, then capture full-page.
async function cleanShot(page, name) {
  await page
    .locator('#wcf-boot-loader')
    .waitFor({state: 'detached', timeout: 6000})
    .catch(() => {});
  await page.screenshot({path: `${SHOTS}/${name}.png`, fullPage: true});
}

async function seedNewsletter(supabaseAdmin) {
  await supabaseAdmin.from('newsletter_issues').delete().in('id', [PUB.id, DRAFT.id]);
  const {error: seedErr} = await supabaseAdmin.from('newsletter_issues').insert([
    {
      id: PUB.id,
      year_month: PUB.ym,
      slug: PUB.slug,
      title: PUB.title,
      status: 'published',
      period_start: '2099-11-01',
      period_end: '2099-11-30',
      noindex: true,
      preview_token: 'published-disabled',
      preview_enabled: false,
      // Mirror real publish: draft_payload stays intact alongside the snapshot.
      // (PostgREST bulk insert also sends a missing key as NULL, bypassing the
      // NOT NULL DEFAULT '{}', so every row in the array must carry draft_payload.)
      draft_payload: {blocks: PUB_BLOCKS},
      published_payload: {blocks: PUB_BLOCKS},
      published_at: new Date().toISOString(),
    },
    {
      id: DRAFT.id,
      year_month: DRAFT.ym,
      slug: DRAFT.slug,
      title: DRAFT.title,
      status: 'draft',
      period_start: '2099-10-01',
      period_end: '2099-10-31',
      noindex: true,
      preview_token: PREVIEW_TOKEN,
      preview_enabled: true,
      preview_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      draft_payload: {
        blocks: [
          {type: 'heading', text: 'October Draft Heading'},
          {type: 'paragraph', text: 'This issue is still a draft — shown only via the preview link.'},
        ],
      },
    },
  ]);
  // Fail loud: PostgREST bulk insert sends a missing key as NULL (bypassing the
  // column default), so a schema/payload mismatch must not be swallowed.
  if (seedErr) throw new Error('newsletter seed insert failed: ' + seedErr.message);
}

test.beforeAll(async ({supabaseAdmin}) => {
  await seedNewsletter(supabaseAdmin);
});

test.afterAll(async ({supabaseAdmin}) => {
  await supabaseAdmin.from('newsletter_issues').delete().in('id', [PUB.id, DRAFT.id]);
});

test.describe('public newsletter (logged out)', () => {
  // Drop the admin storageState — these must work with NO session.
  test.use({storageState: {cookies: [], origins: []}});

  test('renders archive, issue, latest, and token preview above the login gate', async ({page}) => {
    // Archive — the public surface mounts; it is NOT the LoginScreen.
    await page.goto('/newsletter');
    await expect(page.locator('.nl-archive')).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Monthly Review'})).toBeVisible();
    await expect(page.getByText(PUB.title)).toBeVisible();
    // The public bypass clears the static boot splash like any route.
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0);
    await cleanShot(page, 'public-archive-desktop');

    // Published issue page renders whitelisted blocks.
    await page.goto(`/newsletter/${PUB.slug}`);
    await expect(page.locator('.nl-issue')).toBeVisible();
    await expect(page.getByText('A Great November')).toBeVisible();
    await expect(page.getByText('Cattle on farm')).toBeVisible();
    await cleanShot(page, 'public-issue-desktop');

    // /newsletter/latest resolves to a published issue slug.
    await page.goto('/newsletter/latest');
    await expect(page.locator('.nl-issue')).toBeVisible();
    await expect(page).toHaveURL(/\/newsletter\/\d{4}-\d{2}$/);

    // Token preview shows the draft + preview banner (draft, unexpired token).
    await page.goto(`/newsletter/${DRAFT.slug}?preview=${PREVIEW_TOKEN}`);
    await expect(page.locator('.nl-preview-banner')).toBeVisible();
    await expect(page.getByText('October Draft Heading')).toBeVisible();
    await cleanShot(page, 'public-preview-desktop');

    // A draft without a token, and with a wrong token, is "not found".
    await page.goto(`/newsletter/${DRAFT.slug}`);
    await expect(page.getByText('Issue not found')).toBeVisible();
    await page.goto(`/newsletter/${DRAFT.slug}?preview=wrong-token`);
    await expect(page.getByText('Issue not found')).toBeVisible();

    // noindex meta is present on the public surface.
    await page.goto(`/newsletter/${PUB.slug}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('renders on a phone viewport', async ({page}) => {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/newsletter');
    await expect(page.locator('.nl-archive')).toBeVisible();
    await cleanShot(page, 'public-archive-mobile');
    await page.goto(`/newsletter/${PUB.slug}`);
    await expect(page.locator('.nl-issue')).toBeVisible();
    await cleanShot(page, 'public-issue-mobile');
  });
});

test.describe('admin newsletter (admin)', () => {
  test('renders the workspace and opens the one-pass editor', async ({page}) => {
    await page.goto('/admin/newsletter');
    await expect(page.getByRole('heading', {name: 'Monthly Newsletter'})).toBeVisible();
    await expect(page.getByText(PUB.title)).toBeVisible();
    await cleanShot(page, 'admin-list-desktop');

    await page.getByRole('row').filter({hasText: PUB.title}).getByRole('button', {name: 'Open'}).click();
    await expect(page.getByRole('heading', {name: 'Content blocks'})).toBeVisible();

    // Published issue: the editor shows the snapshotted draft blocks (publish
    // leaves draft_payload intact), not an empty "No blocks yet" state.
    await expect(page.getByText('No blocks yet.')).toHaveCount(0);
    await expect(page.locator('.nla-block')).toHaveCount(PUB_BLOCKS.length);
    await expect(page.locator('.nla-block').first().getByRole('textbox').first()).toHaveValue('A Great November');

    // Preview is draft-only: the disabled message shows and the Open-preview /
    // Regenerate controls are NOT rendered for a published issue.
    await expect(page.getByText('Preview is disabled while published')).toBeVisible();
    await expect(page.getByRole('link', {name: 'Open preview'})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Regenerate link'})).toHaveCount(0);
    await cleanShot(page, 'admin-editor-desktop');
  });
});
