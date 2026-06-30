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
// Archive access key (mig 153): the published archive + issue pages are gated by
// a rotating key. Seed a known one so the logged-out tests can read; clear it in
// afterAll so the singleton returns to a locked state.
const ACCESS_KEY = 'k'.repeat(40);
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
      // Bulk insert normalizes columns across rows: since the DRAFT row sets
      // photo_plan, this row must set it too (a missing key would send NULL and
      // violate the NOT NULL column).
      photo_plan: [],
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
      photo_plan: [{id: 'pp-1', idea: 'The new lambs in the field', section: 'Sheep', photoId: null}],
    },
  ]);
  // Fail loud: PostgREST bulk insert sends a missing key as NULL (bypassing the
  // column default), so a schema/payload mismatch must not be swallowed.
  if (seedErr) throw new Error('newsletter seed insert failed: ' + seedErr.message);

  // Mig 153: set a known, unexpired archive access key so the gated public reads
  // succeed for these tests.
  const {error: setErr} = await supabaseAdmin
    .from('newsletter_settings')
    .update({
      archive_access_token: ACCESS_KEY,
      archive_access_expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
    })
    .eq('id', 'singleton');
  if (setErr) throw new Error('newsletter settings archive key seed failed: ' + setErr.message);
}

test.beforeAll(async ({supabaseAdmin}) => {
  await seedNewsletter(supabaseAdmin);
});

test.afterAll(async ({supabaseAdmin}) => {
  await supabaseAdmin.from('newsletter_issues').delete().in('id', [PUB.id, DRAFT.id]);
  // Re-lock: clear the seeded archive key.
  await supabaseAdmin
    .from('newsletter_settings')
    .update({archive_access_token: null, archive_access_expires_at: null})
    .eq('id', 'singleton');
});

test.describe('public newsletter (logged out)', () => {
  // Drop the admin storageState — these must work with NO session.
  test.use({storageState: {cookies: [], origins: []}});

  test('a missing/invalid archive key shows the locked screen, not the archive', async ({page}) => {
    // No key at all -> locked.
    await page.goto('/newsletter');
    await expect(page.getByRole('heading', {name: 'This link has expired'})).toBeVisible();
    await expect(page.locator('.nl-archive')).toHaveCount(0);
    await cleanShot(page, 'public-locked-desktop');
    // Wrong key -> locked (the RPC returns null for a non-matching key).
    await page.goto('/newsletter?key=not-the-real-key');
    await expect(page.getByRole('heading', {name: 'This link has expired'})).toBeVisible();
    await expect(page.locator('.nl-archive')).toHaveCount(0);
    // A published issue URL without the key is also locked (no leak by raw slug).
    await page.goto(`/newsletter/${PUB.slug}`);
    await expect(page.getByRole('heading', {name: 'This link has expired'})).toBeVisible();
    await expect(page.locator('.nl-issue')).toHaveCount(0);
  });

  test('renders archive, issue, latest, and token preview above the login gate', async ({page}) => {
    const k = `?key=${ACCESS_KEY}`;
    // Archive (with a valid key) — the public surface mounts; it is NOT the LoginScreen.
    await page.goto(`/newsletter${k}`);
    await expect(page.locator('.nl-archive')).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Monthly Review'})).toBeVisible();
    await expect(page.getByText(PUB.title)).toBeVisible();
    // The public bypass clears the static boot splash like any route.
    await expect(page.locator('#wcf-boot-loader')).toHaveCount(0);
    await cleanShot(page, 'public-archive-desktop');

    // Published issue page renders whitelisted blocks.
    await page.goto(`/newsletter/${PUB.slug}${k}`);
    await expect(page.locator('.nl-issue')).toBeVisible();
    await expect(page.getByText('A Great November')).toBeVisible();
    await expect(page.getByText('Cattle on farm')).toBeVisible();
    await cleanShot(page, 'public-issue-desktop');

    // /newsletter/latest resolves to a published issue slug (key carried through).
    await page.goto(`/newsletter/latest${k}`);
    await expect(page.locator('.nl-issue')).toBeVisible();
    await expect(page).toHaveURL(/\/newsletter\/\d{4}-\d{2}\?key=/);

    // Token preview shows the draft + preview banner (draft, unexpired token) —
    // the preview path uses its own token and needs no archive key.
    await page.goto(`/newsletter/${DRAFT.slug}?preview=${PREVIEW_TOKEN}`);
    await expect(page.locator('.nl-preview-banner')).toBeVisible();
    await expect(page.getByText('October Draft Heading')).toBeVisible();
    await cleanShot(page, 'public-preview-desktop');

    // A draft slug (not published) even WITH a valid key is "not available";
    // a wrong preview token is "not available" too.
    await page.goto(`/newsletter/${DRAFT.slug}${k}`);
    await expect(page.getByRole('heading', {name: 'Issue not available'})).toBeVisible();
    await page.goto(`/newsletter/${DRAFT.slug}?preview=wrong-token`);
    await expect(page.getByRole('heading', {name: 'Preview not available'})).toBeVisible();

    // noindex meta is present on the public surface.
    await page.goto(`/newsletter/${PUB.slug}${k}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('renders on a phone viewport', async ({page}) => {
    const k = `?key=${ACCESS_KEY}`;
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(`/newsletter${k}`);
    await expect(page.locator('.nl-archive')).toBeVisible();
    await cleanShot(page, 'public-archive-mobile');
    await page.goto(`/newsletter/${PUB.slug}${k}`);
    await expect(page.locator('.nl-issue')).toBeVisible();
    await cleanShot(page, 'public-issue-mobile');
  });
});

test.describe('admin newsletter (admin)', () => {
  test('renders the workspace and opens the 7-step editor', async ({page}) => {
    await page.goto('/admin/newsletter');
    await expect(page.getByRole('heading', {name: 'Monthly Newsletter'})).toBeVisible();
    await expect(page.getByText(PUB.title)).toBeVisible();
    // The rotating public-link control (mig 153) is surfaced with the seeded key.
    await expect(page.getByRole('heading', {name: 'Public link'})).toBeVisible();
    await expect(page.getByRole('button', {name: /Copy link|Generate link/})).toBeVisible();
    await cleanShot(page, 'admin-list-desktop');

    // Issues are openable hover-lift tiles (A6 affordance) — the whole tile opens
    // the editor; there is no per-row "Open" button.
    await page.locator('.nla-tile', {hasText: PUB.title}).click();

    // The direction-first 7-step tracker (Facts → … → Publish) heads the editor.
    await expect(page.locator('.nla-tracker')).toBeVisible();
    await expect(page.getByRole('heading', {name: 'This month’s facts'})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'The draft'})).toBeVisible();

    // Published issue: the AI-owned draft renders READ-ONLY (no manual block
    // editing) and shows the snapshotted blocks — publish leaves draft_payload
    // intact — not the empty "No draft yet" state.
    await expect(page.getByText('No draft yet.')).toHaveCount(0);
    await expect(page.locator('.nla-draft-preview')).toBeVisible();
    await expect(page.locator('.nla-draft-preview')).toContainText('A Great November');
    // The manual block palette + per-block editors are gone.
    await expect(page.locator('.nla-block')).toHaveCount(0);
    await expect(page.locator('.nla-add-blocks')).toHaveCount(0);

    // Preview is draft-only: the disabled message shows and the Open-preview /
    // Regenerate controls are NOT rendered for a published issue.
    await expect(page.getByText('Preview is disabled while published')).toBeVisible();
    await expect(page.getByRole('link', {name: 'Open preview'})).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'Regenerate link'})).toHaveCount(0);

    // Direction-first wiring: the facts step exposes the data-only "Gather facts"
    // (no AI), and the Revise step exposes the AI "Write/Rewrite/Revise draft".
    // These trigger the newsletter-harvest Edge Function; full invocation needs
    // the deploy gate, so this asserts the surface + wiring, not the round-trip.
    await expect(page.getByRole('button', {name: /Gather facts|Re-gather facts/}).first()).toBeVisible();
    // Published issue already has draft blocks → the AI button reads "Rewrite draft".
    await expect(page.getByRole('button', {name: /Write draft|Rewrite draft|Revise draft/})).toBeVisible();

    // The always-on guardrails are surfaced in the utility rail.
    await expect(page.getByRole('heading', {name: 'Guardrails'})).toBeVisible();
    await cleanShot(page, 'admin-editor-desktop');
  });

  test('surfaces the this-month spotlight, the settings sub-view, and the draft readiness', async ({page}) => {
    await page.goto('/admin/newsletter');
    await expect(page.getByRole('heading', {name: 'Monthly Newsletter'})).toBeVisible();
    // The current month is surfaced up front with a one-click "gather facts" action.
    await expect(page.locator('.nla-spotlight')).toBeVisible();
    await expect(page.getByRole('button', {name: /Gather this month’s facts|Re-gather facts/})).toBeVisible();

    // Settings is a dedicated in-view sub-surface of grouped cards (no new route).
    await page.getByRole('button', {name: 'Settings'}).click();
    await expect(page.getByRole('heading', {name: 'Newsletter settings'})).toBeVisible();
    await expect(page.getByText('AI provider')).toBeVisible();
    await expect(page.getByText('Tone preset')).toBeVisible();
    await expect(page.getByText('Length / detail')).toBeVisible();
    await cleanShot(page, 'admin-settings-desktop');
    await page.getByRole('button', {name: '‹ Back to issues'}).click();

    // Open the seeded DRAFT issue → readiness + photo plan render for a draft.
    await page.locator('.nla-tile', {hasText: DRAFT.title}).click();
    await expect(page.locator('.nla-readiness')).toBeVisible();

    // The AI photo plan (shot-list) renders from the seeded plan, and the
    // revise-in-place box is present.
    await expect(page.getByText('Photo plan — shots to get this month')).toBeVisible();
    await expect(page.getByText('The new lambs in the field')).toBeVisible();
    await expect(page.getByPlaceholder(/tell the AI what to change/i)).toBeVisible();
    await cleanShot(page, 'admin-draft-desktop');

    // Mobile capture of the editor for the UI review.
    await page.setViewportSize({width: 390, height: 844});
    await cleanShot(page, 'admin-editor-mobile');
  });
});
