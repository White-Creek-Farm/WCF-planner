import {test, expect} from './fixtures.js';

// ============================================================================
// Light home alerts — behavioral + RLS proof.
// ----------------------------------------------------------------------------
// A REAL Light auth user (not the admin storageState, not the DEV role
// override) logs in through the normal LoginScreen, so every query runs under
// the Light user's RLS. We seed a missed broiler daily, a near-term processing
// event, and an equipment piece with an unchecked every-fillup item, then
// assert the Light home renders all three alert families.
//
// The fillup_streak assertion is the load-bearing RLS proof: it only renders if
// the Light user can SELECT equipment_fuelings. If it fails, Light RLS (not the
// UI) is the blocker.
// ============================================================================

// Fresh browser context — opt out of the global admin storageState so we drive
// a genuine Light login.
test.use({storageState: {cookies: [], origins: []}});

const LIGHT_EMAIL = 'test-light-home-alerts@wcfplanner.test';
const LIGHT_PASSWORD = 'LightHomeAlerts123!';
const EQUIP_SLUG = 'light-home-alerts-tractor';
const BATCH_NAME = 'LIGHT-HA-01';

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function ensureLightUser(supabaseAdmin) {
  const existing = await supabaseAdmin.auth.admin.listUsers();
  let user = existing.data?.users?.find((u) => u.email === LIGHT_EMAIL);
  if (!user) {
    const created = await supabaseAdmin.auth.admin.createUser({
      email: LIGHT_EMAIL,
      password: LIGHT_PASSWORD,
      email_confirm: true,
    });
    if (created.error) throw new Error(`create light user: ${created.error.message}`);
    user = created.data?.user;
  } else {
    // Keep the password deterministic across re-runs.
    await supabaseAdmin.auth.admin.updateUserById(user.id, {password: LIGHT_PASSWORD});
  }
  await supabaseAdmin.from('profiles').upsert({id: user.id, email: LIGHT_EMAIL, role: 'light'}, {onConflict: 'id'});
  return user;
}

async function seedAlertsData(supabaseAdmin) {
  // Active broiler batch on-farm now, processing within 30 days, NO daily report
  // seeded -> missed-daily rows + a "processing" next-30 event.
  const batch = {
    id: 'light-ha-batch-1',
    name: BATCH_NAME,
    status: 'active',
    breed: 'CC',
    hatchery: 'Meyer Hatchery',
    hatchDate: isoOffset(-40),
    processingDate: isoOffset(10),
    birdCount: 700,
    notes: '',
  };
  let r = await supabaseAdmin.from('app_store').upsert({key: 'ppp-v4', data: [batch]}, {onConflict: 'key'});
  if (r.error) throw new Error(`seed ppp-v4: ${r.error.message}`);

  // Equipment with an every-fillup item, active.
  r = await supabaseAdmin.from('equipment').upsert(
    {
      id: 'light-ha-equip-1',
      name: 'Light Home Alerts Tractor',
      slug: EQUIP_SLUG,
      category: 'tractors',
      status: 'active',
      tracking_unit: 'hours',
      current_hours: 120,
      current_km: null,
      fuel_type: 'diesel',
      every_fillup_items: [{id: 'oil', label: 'Oil check'}],
      service_intervals: [],
      attachment_checklists: [],
      manuals: [],
      documents: [],
      team_members: [],
    },
    {onConflict: 'id'},
  );
  if (r.error) throw new Error(`seed equipment: ${r.error.message}`);

  // A fueling where the oil item was NOT checked -> fillup_streak alert, but
  // ONLY if the Light user can read this row (the RLS proof).
  r = await supabaseAdmin.from('equipment_fuelings').upsert(
    {
      id: 'light-ha-fuel-1',
      client_submission_id: 'light-ha-fuel-csid-1',
      equipment_id: 'light-ha-equip-1',
      date: isoOffset(-1),
      team_member: 'BMAN',
      fuel_type: 'diesel',
      gallons: 10,
      hours_reading: 120,
      km_reading: null,
      every_fillup_check: [],
      service_intervals_completed: [],
      photos: [],
      comments: null,
      source: 'fuel_log_webform',
      podio_source_app: null,
    },
    {onConflict: 'id'},
  );
  if (r.error) throw new Error(`seed equipment_fuelings: ${r.error.message}`);
}

async function loginAsLight(page) {
  await page.goto('/');
  await page.getByPlaceholder('your@email.com').first().fill(LIGHT_EMAIL);
  await page.getByPlaceholder('••••••••').fill(LIGHT_PASSWORD);
  await page.getByRole('button', {name: /^sign in$/i}).click();
  await expect(page.locator('[data-login-screen]')).toHaveCount(0, {timeout: 15_000});
}

test('Light home surfaces missed dailys, equipment attention (RLS proof), and next-30 events', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await ensureLightUser(supabaseAdmin);
  await seedAlertsData(supabaseAdmin);

  await loginAsLight(page);

  // Contained Light portal renders.
  await expect(page.locator('[data-light-portal="1"]')).toBeVisible({timeout: 15_000});

  // Missed daily report rows for the seeded active broiler batch (depends on
  // Light reading app_store batches + the daily tables).
  await expect(page.locator('[data-light-home-missed-daily-row]').first()).toBeVisible({timeout: 15_000});

  // Equipment Attention fillup_streak — the equipment_fuelings RLS proof.
  const attention = page.locator(`[data-attention-kind="fillup_streak"][data-equipment-slug="${EQUIP_SLUG}"]`);
  await expect(attention).toBeVisible({timeout: 15_000});

  // Next 30 Days processing event for the seeded batch.
  await expect(page.locator('[data-light-home-next-30-row="processing"]')).toBeVisible({timeout: 15_000});

  // Attention row routes to the allowed public equipment surface, not /fleet.
  await attention.click();
  await expect(page).toHaveURL(new RegExp('/equipment/' + EQUIP_SLUG), {timeout: 10_000});
  await expect(page).not.toHaveURL(/\/fleet\//);
});
