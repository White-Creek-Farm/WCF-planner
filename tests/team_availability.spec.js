import {test, expect} from './fixtures.js';

// ============================================================================
// Team-member per-form availability filters + roster hard-delete cascade
// 2026-04-29
// ============================================================================
// Locks the post-build contract:
//   - webform_config.team_availability is a sibling key to team_roster.
//     Shape: {forms: {<formKey>: {hiddenIds: [<rosterId>, ...]}}}.
//   - Every active roster member appears in every form by default; the
//     admin TeamAvailabilityEditor narrows per form.
//   - Deletion is the only removal path. Active/inactive UI is gone.
//   - Coordinated delete order: clean availability hiddenIds → cascade
//     equipment.team_members → saveRoster (last). Failure of any
//     pre-roster step leaves the roster entry intact for retry.
//   - Historical *_dailys.team_member strings are NEVER rewritten.
//   - Public webforms cannot add new names (negative regression lock).
// ============================================================================

const ROSTER_SEED = [
  {id: 'tm-alice', name: 'ALICE'},
  {id: 'tm-bob', name: 'BOB'},
  {id: 'tm-carl', name: 'CARL'},
];

async function seedRoster(supabaseAdmin, roster = ROSTER_SEED) {
  const r1 = await supabaseAdmin.from('webform_config').upsert({key: 'team_roster', data: roster}, {onConflict: 'key'});
  if (r1.error) throw new Error(`seedRoster: roster upsert failed: ${r1.error.message}`);
  const r2 = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_members', data: roster.map((e) => e.name)}, {onConflict: 'key'});
  if (r2.error) throw new Error(`seedRoster: legacy mirror upsert failed: ${r2.error.message}`);
}

async function seedAvailability(supabaseAdmin, availability) {
  const r = await supabaseAdmin
    .from('webform_config')
    .upsert({key: 'team_availability', data: availability}, {onConflict: 'key'});
  if (r.error) throw new Error(`seedAvailability: upsert failed: ${r.error.message}`);
}

// --------------------------------------------------------------------------
// Test 1 — Default visibility: every active roster name appears everywhere
// --------------------------------------------------------------------------
test('default: roster member visible on cattle-dailys + fuel-supply with no availability key', async ({
  page,
  supabaseAdmin,
  resetDb,
  browser,
}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);
  // No team_availability row — empty default.

  // Anon path: fuel-supply public form.
  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const fuelTeam = anonPage.getByRole('combobox').first();
    await expect
      .poll(async () => await fuelTeam.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('ALICE');
    const fuelOpts = await fuelTeam.locator('option').allTextContents();
    expect(fuelOpts).toEqual(expect.arrayContaining(['ALICE', 'BOB', 'CARL']));

    // Anon path: cattle-dailys via WebformHub.
    await anonPage.goto('/webforms/cattle');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const cattleTeam = anonPage.getByRole('combobox').first();
    await expect
      .poll(async () => await cattleTeam.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('ALICE');
    const cattleOpts = await cattleTeam.locator('option').allTextContents();
    expect(cattleOpts).toEqual(expect.arrayContaining(['ALICE', 'BOB', 'CARL']));
  } finally {
    await anonContext.close();
  }
  void page;
});

// --------------------------------------------------------------------------
// Test 2 — Hidden on one form: availability key narrows that form only
// --------------------------------------------------------------------------
test('availability: BOB hidden from cattle-dailys is invisible there but visible on sheep-dailys + fuel-supply', async ({
  page,
  supabaseAdmin,
  resetDb,
  browser,
}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);
  await seedAvailability(supabaseAdmin, {forms: {'cattle-dailys': {hiddenIds: ['tm-bob']}}});

  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    // cattle-dailys: BOB hidden.
    await anonPage.goto('/webforms/cattle');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const cattleTeam = anonPage.getByRole('combobox').first();
    await expect
      .poll(async () => await cattleTeam.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('ALICE');
    const cattleOpts = await cattleTeam.locator('option').allTextContents();
    expect(cattleOpts).toContain('ALICE');
    expect(cattleOpts).toContain('CARL');
    expect(cattleOpts).not.toContain('BOB');

    // sheep-dailys: BOB still visible (per-form isolation).
    await anonPage.goto('/webforms/sheep');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const sheepTeam = anonPage.getByRole('combobox').first();
    await expect
      .poll(async () => await sheepTeam.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('BOB');

    // fuel-supply: BOB still visible.
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const fuelTeam = anonPage.getByRole('combobox').first();
    await expect
      .poll(async () => await fuelTeam.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('BOB');
  } finally {
    await anonContext.close();
  }
  void page;
});

// --------------------------------------------------------------------------
// Test 3 — Admin editor toggle persists hidden state per form
// --------------------------------------------------------------------------
test('admin editor: unchecking a member on cattle-dailys writes hiddenIds', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);

  await page.goto('/admin');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Wait for the master roster to render — the availability editor reads
  // the same context state.
  await expect(page.locator('[data-roster-active="1"]', {hasText: 'BOB'})).toBeVisible({timeout: 10_000});

  // Open the cattle-dailys availability section.
  await page.locator('[data-availability-toggle="cattle-dailys"]').click();

  // Uncheck BOB on cattle-dailys. Using .click() instead of .uncheck()
  // because the React-controlled input pattern (checked={!isHidden}) would
  // make .uncheck()'s synchronous state-change assertion race with the
  // async DB roundtrip — the data-attribute assertion below is the real
  // settle gate.
  const bobRow = page.locator('[data-availability-row="cattle-dailys"][data-availability-member="tm-bob"]');
  await expect(bobRow).toBeVisible({timeout: 5_000});
  await bobRow.locator('input[type="checkbox"]').click();

  // The badge should update and the row attribute should flip.
  await expect(bobRow).toHaveAttribute('data-availability-hidden', '1', {timeout: 10_000});

  // Verify persistence to DB.
  await expect
    .poll(
      async () => {
        const {data} = await supabaseAdmin
          .from('webform_config')
          .select('data')
          .eq('key', 'team_availability')
          .maybeSingle();
        return data?.data?.forms?.['cattle-dailys']?.hiddenIds || [];
      },
      {timeout: 10_000},
    )
    .toContain('tm-bob');
});

// --------------------------------------------------------------------------
// Test 4 — Public webforms have no add-member affordance
// --------------------------------------------------------------------------
test('public form: fuel-supply has no add-member input or button', async ({page, supabaseAdmin, resetDb, browser}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);

  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

    // No roster-add affordances should ever appear on a public form.
    await expect(anonPage.locator('[data-roster-add-input="1"]')).toHaveCount(0);
    await expect(anonPage.locator('[data-roster-add-button="1"]')).toHaveCount(0);
    await expect(anonPage.getByRole('button', {name: /add team member/i})).toHaveCount(0);
  } finally {
    await anonContext.close();
  }
  void page;
});

// --------------------------------------------------------------------------
// Test 5 — Hard delete cascades: roster + mirror + availability + equipment
// --------------------------------------------------------------------------
// Coordinated delete order locked: clean availability → cascade
// equipment.team_members → saveRoster. Historical rows preserved.
test('delete: cascades to availability + equipment + mirror; roster entry gone; history preserved', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);
  // Pre-existing availability hides BOB on two forms.
  await seedAvailability(supabaseAdmin, {
    forms: {
      'cattle-dailys': {hiddenIds: ['tm-bob', 'tm-alice']},
      'fuel-supply': {hiddenIds: ['tm-bob']},
      'sheep-dailys': {hiddenIds: []},
    },
  });
  // Equipment row that lists BOB as an operator.
  await supabaseAdmin.from('equipment').upsert(
    {
      id: 'eq-test-1',
      slug: 'eq-test-1',
      name: 'Test Tractor',
      category: 'tractor',
      status: 'active',
      tracking_unit: 'hours',
      team_members: ['BOB', 'CARL'],
    },
    {onConflict: 'id'},
  );
  // Historical cattle_dailys row authored by BOB. Must NOT be rewritten by delete.
  await supabaseAdmin.from('cattle_dailys').upsert(
    {
      id: 'cd-history-1',
      date: '2026-04-01',
      team_member: 'BOB',
      herd: 'mommas',
      deleted_at: null,
      deleted_by: null,
    },
    {onConflict: 'id'},
  );

  await page.goto('/admin');
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

  // Stub the DeleteModal to immediately invoke the callback (same pattern as
  // cattle_send_to_processor / sheep_send_to_processor specs). main.jsx
  // assigns the global in a useEffect after first render.
  await page.waitForFunction(() => typeof window._wcfConfirmDelete === 'function');
  await page.evaluate(() => {
    window._wcfConfirmDelete = (_msg, fn) => fn();
  });

  // Click the × delete button on BOB's chip.
  const bobChip = page.locator('[data-roster-active="1"][data-roster-id="tm-bob"]');
  await expect(bobChip).toBeVisible({timeout: 10_000});
  await bobChip.locator('[data-roster-delete="1"]').click();

  // Wait for BOB's chip to disappear (the post-cascade roster save lands).
  await expect(bobChip).toHaveCount(0, {timeout: 15_000});

  // Roster + mirror: BOB gone from canonical and legacy keys.
  const {data: rosterRow} = await supabaseAdmin
    .from('webform_config')
    .select('data')
    .eq('key', 'team_roster')
    .maybeSingle();
  const rosterIds = (rosterRow?.data || []).map((e) => e.id);
  expect(rosterIds).not.toContain('tm-bob');
  expect(rosterIds).toEqual(expect.arrayContaining(['tm-alice', 'tm-carl']));

  const {data: mirrorRow} = await supabaseAdmin
    .from('webform_config')
    .select('data')
    .eq('key', 'team_members')
    .maybeSingle();
  expect(mirrorRow.data).not.toContain('BOB');
  expect(mirrorRow.data).toEqual(expect.arrayContaining(['ALICE', 'CARL']));

  // Availability: tm-bob stripped from every formKey. Other ids preserved.
  const {data: availRow} = await supabaseAdmin
    .from('webform_config')
    .select('data')
    .eq('key', 'team_availability')
    .maybeSingle();
  const cattleHidden = availRow?.data?.forms?.['cattle-dailys']?.hiddenIds || [];
  const fuelHidden = availRow?.data?.forms?.['fuel-supply']?.hiddenIds || [];
  expect(cattleHidden).not.toContain('tm-bob');
  expect(cattleHidden).toContain('tm-alice'); // unrelated id preserved
  expect(fuelHidden).not.toContain('tm-bob');

  // Equipment cascade: BOB removed from team_members. CARL preserved.
  const {data: eqRow} = await supabaseAdmin
    .from('equipment')
    .select('team_members')
    .eq('id', 'eq-test-1')
    .maybeSingle();
  expect(eqRow.team_members).not.toContain('BOB');
  expect(eqRow.team_members).toContain('CARL');

  // History preservation: cattle_dailys row still names BOB.
  const {data: histRow} = await supabaseAdmin
    .from('cattle_dailys')
    .select('team_member')
    .eq('id', 'cd-history-1')
    .maybeSingle();
  expect(histRow.team_member).toBe('BOB');
});

// --------------------------------------------------------------------------
// Test 6 — Stale localStorage.wcf_team cannot resurrect a hidden member
// --------------------------------------------------------------------------
// Acceptance contract: deleted / hidden master-roster names cannot appear
// as a selectable option in any new-entry dropdown. The previous
// "(saved earlier)" UX in FuelSupplyWebform was a known violation —
// removed in this build. This test pre-seeds localStorage.wcf_team with a
// name that's hidden by team_availability, opens the public fuel supply
// form anonymously, and verifies the name does not appear and cannot be
// submitted. Same regression locks the same surface for hard-deleted
// roster members (delete strips them from the available list, and the
// stale localStorage guard clears the now-orphaned selection).
test('fuel supply: stale localStorage.wcf_team for a hidden member is cleared, not rendered', async ({
  page,
  supabaseAdmin,
  resetDb,
  browser,
}) => {
  await resetDb();
  await seedRoster(supabaseAdmin);
  await seedAvailability(supabaseAdmin, {forms: {'fuel-supply': {hiddenIds: ['tm-bob']}}});

  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  // Pre-seed localStorage BEFORE any page script runs.
  await anonPage.addInitScript(() => {
    localStorage.setItem('wcf_team', 'BOB');
  });
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});

    const teamSelect = anonPage.getByRole('combobox').first();
    // Wait for ALICE to appear so we know the available list has loaded.
    await expect
      .poll(async () => await teamSelect.locator('option').allTextContents(), {timeout: 10_000})
      .toContain('ALICE');

    // BOB must NOT appear as an option (no "(saved earlier)" anywhere).
    const opts = await teamSelect.locator('option').allTextContents();
    expect(opts).not.toContain('BOB');
    expect(opts.some((o) => /BOB/i.test(o))).toBe(false);

    // The stale-name guard must have cleared the selection.
    await expect.poll(async () => await teamSelect.inputValue(), {timeout: 10_000}).toBe('');

    // localStorage.wcf_team must have been removed.
    const stored = await anonPage.evaluate(() => localStorage.getItem('wcf_team'));
    expect(stored).toBeNull();

    // Submitting without picking surfaces the standard "Pick a team member"
    // error — we cannot ship a stale BOB row anywhere.
    await anonPage.locator('input[type="number"]').fill('25');
    await anonPage.locator('[data-submit-button="1"]').click();
    await expect(anonPage.getByText('Pick a team member.')).toBeVisible({timeout: 5_000});

    // Confirm DB has zero fuel_supplies rows authored by BOB.
    const {data: rows} = await supabaseAdmin.from('fuel_supplies').select('id').eq('team_member', 'BOB');
    expect(rows || []).toEqual([]);
  } finally {
    await anonContext.close();
  }
  void page;
});

// --------------------------------------------------------------------------
// Test 7 — Legacy {active: false} entries are passively dropped on next save
// --------------------------------------------------------------------------
// Roster contains an `active: false` entry from the retired soft-delete UX.
// normalizeRoster drops it on read; the next saveRoster (e.g. via add)
// rewrites the canonical row without that entry. Public form never shows it.
test('legacy migration: active:false entries vanish from public dropdown', async ({
  page,
  supabaseAdmin,
  resetDb,
  browser,
}) => {
  await resetDb();
  // Direct seed of the legacy shape — bypasses saveRoster.
  await supabaseAdmin.from('webform_config').upsert(
    {
      key: 'team_roster',
      data: [
        {id: 'tm-alice', name: 'ALICE', active: true},
        {id: 'tm-old', name: 'OLDGUY', active: false},
      ],
    },
    {onConflict: 'key'},
  );
  await supabaseAdmin.from('webform_config').upsert(
    {
      key: 'team_members',
      data: ['ALICE', 'OLDGUY'],
    },
    {onConflict: 'key'},
  );

  const anonContext = await browser.newContext({storageState: undefined});
  const anonPage = await anonContext.newPage();
  try {
    await anonPage.goto('/fueling/supply');
    await expect(anonPage.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
    const team = anonPage.getByRole('combobox').first();
    await expect.poll(async () => await team.locator('option').allTextContents(), {timeout: 10_000}).toContain('ALICE');
    const opts = await team.locator('option').allTextContents();
    expect(opts).toContain('ALICE');
    expect(opts).not.toContain('OLDGUY');
  } finally {
    await anonContext.close();
  }
  void page;
});
