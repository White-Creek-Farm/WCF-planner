import {test, expect} from './fixtures.js';

// ============================================================================
// Equipment fueling — directly expandable service intervals
// ============================================================================
// The fueling form renders ONE "Service intervals" section once a valid
// reading is entered: due intervals first (always expanded, marked "Due"),
// every other configured main interval after them as collapsed rows with
// neutral next-milestone context that open directly (click / Enter / Space).
// Selected checklist items survive collapse; early (non-due) selections
// persist through the unchanged service_intervals_completed contract,
// including divisor propagation and identity-level dedup.
//
// Tests:
//    1 — hours-tracked: due before non-due; due expanded + marked Due;
//        non-due collapsed with neutral context, no warning language.
//    2 — km-tracked equivalent with km units.
//    3 — direct expand on click; keyboard Enter/Space toggles; collapse and
//        reopen preserves ticked tasks.
//    4 — no-due state keeps the green confirmation + collapsed rows.
//    5 — optional no-task interval: select + persist ({items:[], total:0}).
//    6 — optional task intervals: truthful partial AND full persistence.
//    7 — due partial persists; after Log Another the ticks reset; due full
//        persists on the second record.
//    8 — divisor propagation from an initially non-due larger interval;
//        explicit smaller partial upgrades in place — no duplicate entry.
//    9 — offline queued payload carries early selections (unchanged RPC
//        contract: submit_equipment_fueling + parent_in shape).
//   10 — every-fillup (oil gate) + attachment checklists unchanged.
//   11 — mobile: ≥44px disclosure target, tap-to-expand, submit reachable.
//   12 — live-route machine switch (hub → A → hub → B) with colliding
//        checklist keys: no A selections/photos reach B, B's projection uses
//        B-only history, and a delayed A-history response cannot corrupt B.
//        (The unmounted quick-mode picker's reset is locked separately in
//        tests/static/equipment_fueling_quick_switch_static.test.js.)
//   13 — PROD ordering hotfix: rows render in global ascending cadence
//        order for the Honda (due 200h between non-due 50h/500h) and 5065
//        (nearest-milestone non-due conflict) shapes; the due row stays
//        expanded + marked Due at its numerical position.
//
// Serial (workers=1 root config). Run this file on its own — never bundled
// with other TEST-backed specs (shared resetDb).
// ============================================================================

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const seedKey = (value) => `${value}-${RUN_ID}`;
const DB_NAME = 'wcf-offline-queue';

// Seed one active piece. Overrides supply tracking unit + service_intervals.
async function seedEq(supabaseAdmin, overrides = {}) {
  const row = {
    id: overrides.id || seedKey('eq-intervals'),
    name: 'Interval Test Tractor',
    slug: overrides.slug || seedKey('intervals'),
    category: 'tractors',
    status: 'active',
    tracking_unit: 'hours',
    current_hours: 100,
    current_km: null,
    fuel_type: 'diesel',
    takes_def: false,
    every_fillup_items: [],
    service_intervals: [],
    attachment_checklists: [],
    manuals: [],
    documents: [],
    ...overrides,
  };
  const {error} = await supabaseAdmin.from('equipment').upsert(row, {onConflict: 'id'});
  if (error) throw new Error(`seedEq: ${error.message}`);
  return row;
}

async function openForm(page, eq) {
  await page.goto(`/equipment/${eq.slug}`);
  await expect(page.locator('#wcf-boot-loader')).toHaveCount(0, {timeout: 15_000});
  await expect(page.getByText(eq.name)).toBeVisible({timeout: 15_000});
}

// Gallons is the first number input, reading the second (takes_def=false
// pieces). Checklists render only after the reading lands.
async function fillBasics(page, {gallons = '10', reading}) {
  const gallonsInput = page.locator('input[type="number"]').first();
  await expect(gallonsInput).toBeVisible({timeout: 10_000});
  await gallonsInput.fill(gallons);
  await page.locator('input[type="number"]').nth(1).fill(reading);
}

const rowFor = (page, key) => page.locator(`[data-interval-row="${key}"]`);
const disclosureFor = (page, key) => rowFor(page, key).locator('button[aria-expanded]');

async function saveAndWaitSynced(page) {
  await page.getByRole('button', {name: 'Save Fueling'}).click();
  await expect(page.getByText('Fueling saved')).toBeVisible({timeout: 15_000});
}

async function fetchFuelings(supabaseAdmin, eqId) {
  const {data, error} = await supabaseAdmin
    .from('equipment_fuelings')
    .select('id, hours_reading, km_reading, gallons, every_fillup_check, service_intervals_completed')
    .eq('equipment_id', eqId)
    .order('date', {ascending: true});
  if (error) throw new Error(`fetchFuelings: ${error.message}`);
  return data;
}

async function readQueue(page) {
  return await page.evaluate(
    (dbName) =>
      new Promise((resolve, reject) => {
        const watchdog = setTimeout(() => {
          reject(new Error('readQueue: indexedDB.open never fired onsuccess/onerror/onblocked within 5s'));
        }, 5000);
        const req = indexedDB.open(dbName);
        req.onsuccess = () => {
          clearTimeout(watchdog);
          const db = req.result;
          if (!db.objectStoreNames.contains('submissions')) {
            db.close();
            resolve([]);
            return;
          }
          const tx = db.transaction('submissions', 'readonly');
          const store = tx.objectStore('submissions');
          const all = store.getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => {
            db.close();
            reject(all.error);
          };
        };
        req.onerror = () => {
          clearTimeout(watchdog);
          reject(req.error);
        };
        req.onblocked = () => {
          clearTimeout(watchdog);
          reject(new Error('readQueue: indexedDB.open returned onblocked'));
        };
      }),
    DB_NAME,
  );
}

// --------------------------------------------------------------------------
// Test 1 — hours-tracked ordering, due prominence, neutral collapsed rows
// --------------------------------------------------------------------------
test('hours: due first + expanded + marked Due; non-due collapsed with neutral context', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('hours-order'),
    service_intervals: [
      {
        kind: 'hours',
        hours_or_km: 100,
        label: '100 Hour Service',
        tasks: [
          {id: 't100a', label: 'Grease zerks'},
          {id: 't100b', label: 'Check belts'},
        ],
      },
      {
        kind: 'hours',
        hours_or_km: 500,
        label: '500 Hour Service',
        tasks: [{id: 't500a', label: 'Change hydraulic oil'}],
      },
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '250'});

  // One unified section, no nested "Other/View all" control.
  await expect(page.getByText('Service intervals', {exact: true})).toBeVisible();
  await expect(page.getByText(/Other service intervals|View all service intervals/)).toHaveCount(0);

  // Due row: expanded (tasks visible), explicitly marked Due.
  const dueRow = rowFor(page, 'hours:100');
  await expect(dueRow).toBeVisible();
  await expect(dueRow).toHaveAttribute('data-interval-state', 'due');
  await expect(dueRow.getByText('Due', {exact: true})).toBeVisible();
  await expect(dueRow.getByText('Grease zerks')).toBeVisible();
  await expect(dueRow.getByText('Check belts')).toBeVisible();

  // Non-due row: collapsed, neutral milestone context, tasks hidden.
  const upRow = rowFor(page, 'hours:500');
  await expect(upRow).toHaveAttribute('data-interval-state', 'upcoming');
  await expect(upRow).toContainText('Next at 500h · 250h remaining');
  await expect(upRow.getByText('Change hydraulic oil')).toHaveCount(0);
  await expect(disclosureFor(page, 'hours:500')).toHaveAttribute('aria-expanded', 'false');

  // No due/overdue/missed/warning language on the non-due row.
  const upText = await upRow.innerText();
  expect(upText).not.toMatch(/due|overdue|missed|warning|⚠/i);

  // Due renders before non-due in the list.
  const states = await page
    .locator('[data-interval-row]')
    .evaluateAll((els) => els.map((el) => el.dataset.intervalState));
  expect(states).toEqual(['due', 'upcoming']);
});

// --------------------------------------------------------------------------
// Test 2 — km-tracked equivalence
// --------------------------------------------------------------------------
test('km: due/non-due ordering with km units in the neutral context', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('km-order'),
    tracking_unit: 'km',
    current_hours: null,
    current_km: 1000,
    fuel_type: 'gasoline',
    service_intervals: [
      {kind: 'km', hours_or_km: 1000, label: '1,000 KM Service', tasks: [{id: 'k1a', label: 'Rotate tires'}]},
      {kind: 'km', hours_or_km: 5000, label: '5,000 KM Service', tasks: [{id: 'k5a', label: 'Change diff fluid'}]},
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '1500'});

  const dueRow = rowFor(page, 'km:1000');
  await expect(dueRow).toHaveAttribute('data-interval-state', 'due');
  await expect(dueRow.getByText('Due', {exact: true})).toBeVisible();
  await expect(dueRow.getByText('Rotate tires')).toBeVisible();

  const upRow = rowFor(page, 'km:5000');
  await expect(upRow).toHaveAttribute('data-interval-state', 'upcoming');
  await expect(upRow).toContainText('Next at 5,000km · 3,500km remaining');
  await expect(upRow.getByText('Change diff fluid')).toHaveCount(0);

  const states = await page
    .locator('[data-interval-row]')
    .evaluateAll((els) => els.map((el) => el.dataset.intervalState));
  expect(states).toEqual(['due', 'upcoming']);
});

// --------------------------------------------------------------------------
// Test 3 — direct expand (click), keyboard toggle, ticks survive collapse
// --------------------------------------------------------------------------
test('non-due row opens on click + keyboard; collapse/reopen keeps ticked tasks', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('expand'),
    service_intervals: [
      {
        kind: 'hours',
        hours_or_km: 500,
        label: '500 Hour Service',
        tasks: [{id: 't500a', label: 'Change hydraulic oil'}],
      },
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '200'});

  const key = 'hours:500';
  const disclosure = disclosureFor(page, key);

  // Click the row: opens directly — no intermediate control.
  await disclosure.click();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  const task = rowFor(page, key).locator('label', {hasText: 'Change hydraulic oil'}).locator('input[type="checkbox"]');
  await expect(task).toBeVisible();
  await task.check();
  await expect(rowFor(page, key)).toContainText('1 of 1 selected');

  // Keyboard: Enter collapses…
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(rowFor(page, key).getByText('Change hydraulic oil')).toHaveCount(0);
  // …the header still shows the selection was kept…
  await expect(rowFor(page, key)).toContainText('1 of 1 selected');

  // …and Space reopens with the tick preserved.
  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(
    rowFor(page, key).locator('label', {hasText: 'Change hydraulic oil'}).locator('input[type="checkbox"]'),
  ).toBeChecked();
});

// --------------------------------------------------------------------------
// Test 4 — no-due state: green confirmation + collapsed rows beneath
// --------------------------------------------------------------------------
test('no service due: green confirmation retained + intervals still expandable', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('no-due'),
    service_intervals: [
      {kind: 'hours', hours_or_km: 100, label: '100 Hour Service', tasks: [{id: 'a', label: 'Grease zerks'}]},
      {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 'b', label: 'Change hydraulic oil'}]},
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '50'});

  await expect(page.getByText('✓ No service due at 50 hours.')).toBeVisible();
  const rows = page.locator('[data-interval-row]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-interval-state', 'upcoming');
  await expect(rows.nth(1)).toHaveAttribute('data-interval-state', 'upcoming');

  // Rows are directly expandable in the no-due state too.
  await disclosureFor(page, 'hours:100').click();
  await expect(rowFor(page, 'hours:100').getByText('Grease zerks')).toBeVisible();
});

// --------------------------------------------------------------------------
// Test 5 — optional no-task interval persists with the unchanged shape
// --------------------------------------------------------------------------
test('optional no-task interval: select + submit persists {items:[], total:0}', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('no-task'),
    service_intervals: [{kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: []}],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '200'});

  await disclosureFor(page, 'hours:500').click();
  await rowFor(page, 'hours:500').locator('label', {hasText: 'Mark this service done'}).locator('input').check();
  await expect(rowFor(page, 'hours:500')).toContainText('✓ selected');

  await saveAndWaitSynced(page);

  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(1);
  const completed = rows[0].service_intervals_completed;
  expect(completed).toHaveLength(1);
  expect(completed[0]).toMatchObject({
    interval: 500,
    kind: 'hours',
    label: '500 Hour Service',
    items_completed: [],
    total_tasks: 0,
  });
  expect(completed[0].auto_from).toBeUndefined();
});

// --------------------------------------------------------------------------
// Test 6 — optional task intervals: truthful partial + full persistence
// --------------------------------------------------------------------------
test('optional task intervals: partial records only ticked items; full records all', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('partial-full'),
    service_intervals: [
      {
        kind: 'hours',
        hours_or_km: 300,
        label: '300 Hour Service',
        tasks: [
          {id: 'p1', label: 'Replace fuel filter'},
          {id: 'p2', label: 'Replace air filter'},
        ],
      },
      {
        kind: 'hours',
        hours_or_km: 500,
        label: '500 Hour Service',
        tasks: [
          {id: 'f1', label: 'Change hydraulic oil'},
          {id: 'f2', label: 'Replace hydraulic filter'},
        ],
      },
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '100'});

  // Partial on the 300h (1 of 2)…
  await disclosureFor(page, 'hours:300').click();
  await rowFor(page, 'hours:300').locator('label', {hasText: 'Replace fuel filter'}).locator('input').check();
  await expect(rowFor(page, 'hours:300')).toContainText('· partial');

  // …full on the 500h (2 of 2).
  await disclosureFor(page, 'hours:500').click();
  await rowFor(page, 'hours:500').locator('label', {hasText: 'Change hydraulic oil'}).locator('input').check();
  await rowFor(page, 'hours:500').locator('label', {hasText: 'Replace hydraulic filter'}).locator('input').check();
  await expect(rowFor(page, 'hours:500')).toContainText('full completion');

  await saveAndWaitSynced(page);

  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(1);
  const completed = rows[0].service_intervals_completed;
  expect(completed).toHaveLength(2);
  const c300 = completed.find((c) => c.interval === 300);
  const c500 = completed.find((c) => c.interval === 500);
  expect(c300.items_completed).toEqual(['p1']);
  expect(c300.total_tasks).toBe(2);
  expect(c300.auto_from).toBeUndefined();
  expect(c500.items_completed.sort()).toEqual(['f1', 'f2']);
  expect(c500.total_tasks).toBe(2);
  expect(c500.auto_from).toBeUndefined();
});

// --------------------------------------------------------------------------
// Test 7 — due partial/full unchanged; Log Another clears interval ticks
// --------------------------------------------------------------------------
test('due interval: partial persists; ticks reset on Log Another; full persists next record', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('due-partial'),
    service_intervals: [
      {
        kind: 'hours',
        hours_or_km: 100,
        label: '100 Hour Service',
        tasks: [
          {id: 'd1', label: 'Grease zerks'},
          {id: 'd2', label: 'Check belts'},
        ],
      },
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '250'});

  const row = rowFor(page, 'hours:100');
  await expect(row).toHaveAttribute('data-interval-state', 'due');
  await row.locator('label', {hasText: 'Grease zerks'}).locator('input').check();
  await expect(row).toContainText('partial (will remain due)');
  await saveAndWaitSynced(page);

  // Log Another must not re-attach the previous record's checklist.
  await page.getByRole('button', {name: 'Log Another'}).click();
  await fillBasics(page, {reading: '251'});
  const rowAgain = rowFor(page, 'hours:100');
  await expect(rowAgain.locator('label', {hasText: 'Grease zerks'}).locator('input')).not.toBeChecked();

  await rowAgain.locator('label', {hasText: 'Grease zerks'}).locator('input').check();
  await rowAgain.locator('label', {hasText: 'Check belts'}).locator('input').check();
  await expect(rowAgain).toContainText('full completion');
  await saveAndWaitSynced(page);

  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(2);
  const first = rows.find((r) => Number(r.hours_reading) === 250);
  const second = rows.find((r) => Number(r.hours_reading) === 251);
  expect(first.service_intervals_completed).toHaveLength(1);
  expect(first.service_intervals_completed[0].items_completed).toEqual(['d1']);
  expect(first.service_intervals_completed[0].total_tasks).toBe(2);
  expect(second.service_intervals_completed).toHaveLength(1);
  expect(second.service_intervals_completed[0].items_completed.sort()).toEqual(['d1', 'd2']);
});

// --------------------------------------------------------------------------
// Test 8 — divisor propagation from an initially non-due larger interval
// --------------------------------------------------------------------------
test('non-due larger fully done covers due smaller; explicit partial upgrades — no duplicate', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('divisor'),
    service_intervals: [
      {
        kind: 'hours',
        hours_or_km: 500,
        label: '500 Hour Service',
        tasks: [
          {id: 's1', label: 'Replace fuel filter'},
          {id: 's2', label: 'Replace air filter'},
        ],
      },
      {kind: 'hours', hours_or_km: 1000, label: '1,000 Hour Service', tasks: [{id: 'b1', label: 'Full service pack'}]},
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '600'});

  // 500h due, 1000h upcoming (Next at 1,000h · 400h remaining).
  await expect(rowFor(page, 'hours:500')).toHaveAttribute('data-interval-state', 'due');
  const upRow = rowFor(page, 'hours:1000');
  await expect(upRow).toHaveAttribute('data-interval-state', 'upcoming');
  await expect(upRow).toContainText('Next at 1,000h · 400h remaining');

  // Explicit partial on the due 500h first.
  await rowFor(page, 'hours:500').locator('label', {hasText: 'Replace fuel filter'}).locator('input').check();

  // Then fully complete the non-due 1000h early.
  await disclosureFor(page, 'hours:1000').click();
  await upRow.locator('label', {hasText: 'Full service pack'}).locator('input').check();

  // Divisor coverage surfaces on the smaller interval: checkboxes freeze.
  await expect(
    rowFor(page, 'hours:500').locator('label', {hasText: 'Replace air filter'}).locator('input'),
  ).toBeDisabled();

  await saveAndWaitSynced(page);

  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(1);
  const completed = rows[0].service_intervals_completed;
  // Exactly ONE entry per interval identity.
  expect(completed).toHaveLength(2);
  const c500s = completed.filter((c) => c.interval === 500);
  expect(c500s).toHaveLength(1);
  expect(c500s[0].auto_from).toBe(1000);
  expect(c500s[0].items_completed.sort()).toEqual(['s1', 's2']);
  expect(c500s[0].total_tasks).toBe(2);
  const c1000 = completed.find((c) => c.interval === 1000);
  expect(c1000.items_completed).toEqual(['b1']);
  expect(c1000.auto_from).toBeUndefined();
});

// --------------------------------------------------------------------------
// Test 9 — offline queued payload carries early selections, contract intact
// --------------------------------------------------------------------------
test('offline: queued parent_in.service_intervals_completed contains the early selection', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('offline'),
    service_intervals: [
      {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 's1', label: 'Replace fuel filter'}]},
    ],
  });
  await openForm(page, eq);
  await page.route('**/rest/v1/rpc/submit_equipment_fueling**', (route) => route.abort('failed'));

  await fillBasics(page, {reading: '200'});
  await disclosureFor(page, 'hours:500').click();
  await rowFor(page, 'hours:500').locator('label', {hasText: 'Replace fuel filter'}).locator('input').check();
  await page.getByRole('button', {name: 'Save Fueling'}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});

  const queue = await readQueue(page);
  expect(queue).toHaveLength(1);
  expect(queue[0].form_kind).toBe('equipment_fueling');
  expect(queue[0].record.rpc).toBe('submit_equipment_fueling');
  const parent = queue[0].record.args.parent_in;
  expect(parent.client_submission_id).toBe(queue[0].csid);
  expect(parent.equipment_id).toBe(eq.id);
  expect(parent.service_intervals_completed).toHaveLength(1);
  expect(parent.service_intervals_completed[0]).toMatchObject({
    interval: 500,
    kind: 'hours',
    items_completed: ['s1'],
    total_tasks: 1,
  });

  // Nothing landed while offline.
  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(0);
  await page.unroute('**/rest/v1/rpc/submit_equipment_fueling**');
});

// --------------------------------------------------------------------------
// Test 10 — every-fillup (oil gate) + attachment checklists unchanged
// --------------------------------------------------------------------------
test('every-fillup oil gate + attachment checklist behavior unchanged', async ({page, supabaseAdmin, resetDb}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {
    slug: seedKey('fillup-attach'),
    every_fillup_items: [{id: 'oil', label: 'CHECK OIL'}],
    service_intervals: [
      {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 's1', label: 'Replace fuel filter'}]},
    ],
    attachment_checklists: [
      {
        name: 'Tough Cut',
        kind: 'hours',
        hours_or_km: 0,
        label: 'Every Use',
        tasks: [{id: 'ac1', label: 'Grease spindles'}],
      },
    ],
  });
  await openForm(page, eq);
  await fillBasics(page, {reading: '200'});

  await expect(page.getByText('Every-fillup checks')).toBeVisible();
  await expect(page.getByText('Attachment-specific checklists')).toBeVisible();

  // Oil gate still blocks submit for a non-ATV, non-Toro piece.
  await page.getByRole('button', {name: 'Save Fueling'}).click();
  await expect(page.getByText('"CHECK OIL" must be ticked before submitting.')).toBeVisible();

  await page.locator('label', {hasText: 'CHECK OIL'}).locator('input').check();
  await page.locator('label', {hasText: 'Grease spindles'}).locator('input').check();
  await saveAndWaitSynced(page);

  const rows = await fetchFuelings(supabaseAdmin, eq.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].every_fillup_check).toHaveLength(1);
  expect(rows[0].every_fillup_check[0]).toMatchObject({id: 'oil', ok: true});
  const attach = rows[0].service_intervals_completed.find((c) => c.attachment_name === 'Tough Cut');
  expect(attach).toBeTruthy();
  expect(attach.items_completed).toEqual(['ac1']);
  expect(attach.total_tasks).toBe(1);
  // No main-interval entry — nothing was ticked on the 500h row.
  expect(rows[0].service_intervals_completed).toHaveLength(1);
});

// --------------------------------------------------------------------------
// Test 12 — live-route machine switch: colliding keys leak nothing across
// --------------------------------------------------------------------------
// Machines A and B share EVERY checklist key (interval 'hours:500' with task
// s1, fillup chk1, attachment 'Tough Cut:hours:0'/ac1). A additionally has a
// full 500h completion at 1,000h in history. At reading 600 that makes A's
// 500h row "upcoming" while B's identical 500h row is DUE — so due-ness
// itself proves whose history drove the projection.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('live machine switch: no A checklist/photo state reaches B; B projects B-only history; stale A history cannot win', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const collidingConfig = {
    every_fillup_items: [{id: 'chk1', label: 'CHECK TIRES'}],
    service_intervals: [
      {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 's1', label: 'Replace fuel filter'}]},
    ],
    attachment_checklists: [
      {
        name: 'Tough Cut',
        kind: 'hours',
        hours_or_km: 0,
        label: 'Every Use',
        tasks: [{id: 'ac1', label: 'Grease spindles'}],
      },
    ],
  };
  const eqA = await seedEq(supabaseAdmin, {
    id: seedKey('eq-cross-a'),
    name: 'Machine A Tractor',
    slug: seedKey('cross-a'),
    ...collidingConfig,
  });
  const eqB = await seedEq(supabaseAdmin, {
    id: seedKey('eq-cross-b'),
    name: 'Machine B Tractor',
    slug: seedKey('cross-b'),
    ...collidingConfig,
  });
  // A's history: full 500h completion at 1,000h → at reading 600 A's 500h is
  // upcoming (next 1,500). B has no history → 500h due at 600.
  const {error: histErr} = await supabaseAdmin.from('equipment_fuelings').upsert(
    {
      id: seedKey('fuel-cross-a-hist'),
      client_submission_id: seedKey('csid-cross-a-hist'),
      equipment_id: eqA.id,
      date: '2026-07-01',
      team_member: 'History Seeder',
      fuel_type: 'diesel',
      gallons: 5,
      hours_reading: 1000,
      km_reading: null,
      every_fillup_check: [],
      service_intervals_completed: [
        {
          interval: 500,
          kind: 'hours',
          label: '500 Hour Service',
          completed_at: '2026-07-01',
          items_completed: ['s1'],
          total_tasks: 1,
        },
      ],
      photos: [],
      comments: null,
      source: 'fuel_log_webform',
    },
    {onConflict: 'id'},
  );
  expect(histErr).toBeNull();

  // ---- Round 1: load A up with selections + a photo, switch to B ----------
  await openForm(page, eqA);
  await fillBasics(page, {reading: '600'});
  const rowA = rowFor(page, 'hours:500');
  // A's own history drives A's projection: 500h upcoming, not due.
  await expect(rowA).toHaveAttribute('data-interval-state', 'upcoming', {timeout: 10_000});
  await expect(rowA).toContainText('Next at 1,500h · 900h remaining');

  await disclosureFor(page, 'hours:500').click();
  await rowA.locator('label', {hasText: 'Replace fuel filter'}).locator('input').check();
  await expect(rowA).toContainText('1 of 1 selected');
  await page.locator('label', {hasText: 'CHECK TIRES'}).locator('input').check();
  await page.locator('label', {hasText: 'Grease spindles'}).locator('input').check();
  await page
    .locator('input[type="file"]')
    .setInputFiles({name: 'leak-proof.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG, 'base64')});
  await expect(page.locator('img[src*="equipment-maintenance-docs"]')).toHaveCount(1, {timeout: 15_000});

  await page.getByRole('button', {name: '‹ Back'}).click();
  await expect(page.getByText('Tap your equipment to log a fueling')).toBeVisible({timeout: 10_000});
  await page.getByRole('button', {name: /Machine B Tractor/}).click();
  await expect(page.getByText('Machine B Tractor')).toBeVisible({timeout: 10_000});
  await fillBasics(page, {reading: '600'});

  // B's projection uses B-only history: identical config + reading, but DUE.
  const rowB = rowFor(page, 'hours:500');
  await expect(rowB).toHaveAttribute('data-interval-state', 'due');
  // None of A's selections or photos appear on B.
  await expect(rowB.locator('label', {hasText: 'Replace fuel filter'}).locator('input')).not.toBeChecked();
  await expect(page.locator('label', {hasText: 'CHECK TIRES'}).locator('input')).not.toBeChecked();
  await expect(page.locator('label', {hasText: 'Grease spindles'}).locator('input')).not.toBeChecked();
  await expect(page.locator('img[src*="equipment-maintenance-docs"]')).toHaveCount(0);

  // Submit B untouched: the persisted record carries nothing from A.
  await saveAndWaitSynced(page);
  const rowsB = await fetchFuelings(supabaseAdmin, eqB.id);
  expect(rowsB).toHaveLength(1);
  expect(rowsB[0].service_intervals_completed).toEqual([]);
  expect(rowsB[0].every_fillup_check).toEqual([]);
  const rowsA = await fetchFuelings(supabaseAdmin, eqA.id);
  expect(rowsA).toHaveLength(1); // only the seeded history row — nothing submitted for A

  // ---- Round 2: delayed A-history response cannot corrupt B ---------------
  await page.route('**/rest/v1/equipment_fuelings*', async (route) => {
    if (route.request().method() === 'GET' && route.request().url().includes(eqA.id)) {
      await new Promise((r) => setTimeout(r, 1500));
    }
    await route.continue();
  });
  await page.getByRole('button', {name: 'Back to Hub'}).click();
  await expect(page.getByText('Tap your equipment to log a fueling')).toBeVisible({timeout: 10_000});
  // Open A (its history GET is now slow) and switch to B before it resolves.
  await page.getByRole('button', {name: /Machine A Tractor/}).click();
  await expect(page.getByText('Machine A Tractor')).toBeVisible({timeout: 10_000});
  await page.getByRole('button', {name: '‹ Back'}).click();
  await expect(page.getByText('Tap your equipment to log a fueling')).toBeVisible({timeout: 10_000});
  await page.getByRole('button', {name: /Machine B Tractor/}).click();
  await expect(page.getByText('Machine B Tractor')).toBeVisible({timeout: 10_000});
  await fillBasics(page, {reading: '600'});
  await expect(rowFor(page, 'hours:500')).toHaveAttribute('data-interval-state', 'due');
  // Let A's delayed response land — B's projection must not flip.
  await page.waitForTimeout(2000);
  await expect(rowFor(page, 'hours:500')).toHaveAttribute('data-interval-state', 'due');
  await expect(
    rowFor(page, 'hours:500').locator('label', {hasText: 'Replace fuel filter'}).locator('input'),
  ).not.toBeChecked();
  await page.unroute('**/rest/v1/equipment_fuelings*');
});

// --------------------------------------------------------------------------
// Test 13 — PROD ordering hotfix: global ascending cadence order in the DOM
// --------------------------------------------------------------------------
test('rows render in ascending cadence order; due rows stay expanded + marked Due at their position', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();

  // Honda #1 shape: 50h fully done at 190 (snaps to milestone 200 → next
  // 250) so at reading 210 the 200h is DUE while 50h and 500h are not. The
  // pre-hotfix order rendered 200, 50, 500.
  const honda = await seedEq(supabaseAdmin, {
    id: seedKey('eq-order-honda'),
    name: 'Order Test Honda',
    slug: seedKey('order-honda'),
    service_intervals: [
      {kind: 'hours', hours_or_km: 50, label: '50 Hour Service', tasks: [{id: 'h50', label: 'Grease fittings'}]},
      {kind: 'hours', hours_or_km: 200, label: '200 Hour Service', tasks: [{id: 'h200', label: 'Change engine oil'}]},
      {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 'h500', label: 'Replace coolant'}]},
    ],
  });
  await supabaseAdmin.from('equipment_fuelings').upsert(
    {
      id: seedKey('fuel-order-honda'),
      client_submission_id: seedKey('csid-order-honda'),
      equipment_id: honda.id,
      date: '2026-07-01',
      team_member: 'History Seeder',
      fuel_type: 'diesel',
      gallons: 4,
      hours_reading: 190,
      km_reading: null,
      every_fillup_check: [],
      service_intervals_completed: [
        {
          interval: 50,
          kind: 'hours',
          label: '50 Hour Service',
          completed_at: '2026-07-01',
          items_completed: [],
          total_tasks: 0,
        },
      ],
      photos: [],
      comments: null,
      source: 'fuel_log_webform',
    },
    {onConflict: 'id'},
  );

  await openForm(page, honda);
  await fillBasics(page, {reading: '210'});
  // Wait for a state only the loaded HISTORY can produce (50h flips from
  // due to upcoming once its completion lands) before sampling row order —
  // asserting earlier races the async history fetch.
  await expect(rowFor(page, 'hours:50')).toHaveAttribute('data-interval-state', 'upcoming', {timeout: 10_000});
  const hondaOrder = await page
    .locator('[data-interval-row]')
    .evaluateAll((els) => els.map((el) => [el.dataset.intervalRow, el.dataset.intervalState]));
  expect(hondaOrder).toEqual([
    ['hours:50', 'upcoming'],
    ['hours:200', 'due'],
    ['hours:500', 'upcoming'],
  ]);
  // The due row keeps its prominence AT position 2: Due badge + expanded
  // checklist; the non-due neighbours stay collapsed.
  const dueRow = rowFor(page, 'hours:200');
  await expect(dueRow.getByText('Due', {exact: true})).toBeVisible();
  await expect(dueRow.getByText('Change engine oil')).toBeVisible();
  await expect(rowFor(page, 'hours:50').getByText('Grease fittings')).toHaveCount(0);
  await expect(rowFor(page, 'hours:500').getByText('Replace coolant')).toHaveCount(0);
  await expect(disclosureFor(page, 'hours:50')).toHaveAttribute('aria-expanded', 'false');

  // 5065 shape: 600h done at 1,750 and 1,200h done at 1,150 → at reading
  // 1,900 the non-due until_due order is 2000 (100) < 600/1200 (500). The
  // pre-hotfix order rendered 50, 250, 500, 2000, 600, 1200.
  const deere = await seedEq(supabaseAdmin, {
    id: seedKey('eq-order-5065'),
    name: 'Order Test 5065',
    slug: seedKey('order-5065'),
    current_hours: 1800,
    service_intervals: [50, 250, 500, 600, 1200, 2000].map((v) => ({
      kind: 'hours',
      hours_or_km: v,
      label: v + ' Hour Service',
      tasks: [{id: 't' + v, label: 'Task for ' + v}],
    })),
  });
  const seedFueling = (idKey, reading, completedIntervals) =>
    supabaseAdmin.from('equipment_fuelings').upsert(
      {
        id: seedKey(idKey),
        client_submission_id: seedKey('csid-' + idKey),
        equipment_id: deere.id,
        date: '2026-07-0' + (reading > 1500 ? '2' : '1'),
        team_member: 'History Seeder',
        fuel_type: 'diesel',
        gallons: 6,
        hours_reading: reading,
        km_reading: null,
        every_fillup_check: [],
        service_intervals_completed: completedIntervals.map((v) => ({
          interval: v,
          kind: 'hours',
          label: v + ' Hour Service',
          completed_at: '2026-07-01',
          items_completed: [],
          total_tasks: 0,
        })),
        photos: [],
        comments: null,
        source: 'fuel_log_webform',
      },
      {onConflict: 'id'},
    );
  await seedFueling('fuel-order-5065-a', 1150, [1200]);
  await seedFueling('fuel-order-5065-b', 1750, [600]);

  await openForm(page, deere);
  await fillBasics(page, {reading: '1900'});
  // Same race guard: 600h reads upcoming ONLY once its 1,750 completion has
  // loaded from history.
  await expect(rowFor(page, 'hours:600')).toHaveAttribute('data-interval-state', 'upcoming', {timeout: 10_000});
  const deereOrder = await page
    .locator('[data-interval-row]')
    .evaluateAll((els) => els.map((el) => [el.dataset.intervalRow, el.dataset.intervalState]));
  expect(deereOrder).toEqual([
    ['hours:50', 'due'],
    ['hours:250', 'due'],
    ['hours:500', 'due'],
    ['hours:600', 'upcoming'],
    ['hours:1200', 'upcoming'],
    ['hours:2000', 'upcoming'],
  ]);
  // The nearest non-due milestone (2000, 100h out) renders LAST, proving
  // next-milestone distance no longer controls order.
  await expect(rowFor(page, 'hours:2000')).toContainText('Next at 2,000h · 100h remaining');
});

// --------------------------------------------------------------------------
// Test 14 — logo hotfix: WCF Planner title links to the Planner homepage
// --------------------------------------------------------------------------
test('WCF Planner logo is a keyboard-activatable link to / on the form AND the done screen', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  const eq = await seedEq(supabaseAdmin, {slug: seedKey('logo-link')});
  await openForm(page, eq);

  // Exposed as a real link (role + href), icon + title inside, subtitle out.
  const logo = page.locator('a[data-fueling-logo-link]');
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', {name: /WCF Planner/})).toBeVisible();
  await expect(logo).not.toContainText('Fueling Log');

  // Keyboard activation navigates to the authenticated homepage (same tab).
  await logo.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/$/, {timeout: 15_000});
  await expect(page.locator('[data-home-grid="programs"]')).toBeVisible({timeout: 20_000});

  // The done screen renders the SAME linked logoEl. Queue a submission
  // offline so the done screen appears without needing the RPC.
  await openForm(page, eq);
  await page.route('**/rest/v1/rpc/submit_equipment_fueling**', (route) => route.abort('failed'));
  await fillBasics(page, {reading: '250'});
  await page.getByRole('button', {name: 'Save Fueling'}).click();
  await expect(page.locator('[data-submit-state="queued"]')).toBeVisible({timeout: 15_000});
  const doneLogo = page.locator('a[data-fueling-logo-link]');
  await expect(doneLogo).toBeVisible();
  await expect(doneLogo).toHaveAttribute('href', '/');
  // Click activation from the done screen lands home too.
  await doneLogo.click();
  await expect(page).toHaveURL(/\/$/, {timeout: 15_000});
  await expect(page.locator('[data-home-grid="programs"]')).toBeVisible({timeout: 20_000});
  await page.unroute('**/rest/v1/rpc/submit_equipment_fueling**');
});

// --------------------------------------------------------------------------
// Test 11 — mobile: usable disclosure target + tap-to-expand + submit
// --------------------------------------------------------------------------
test.describe('mobile', () => {
  test.use({hasTouch: true, viewport: {width: 390, height: 844}});

  test('44px+ disclosure target, tap expands, submit reachable', async ({page, supabaseAdmin, resetDb}) => {
    await resetDb();
    const eq = await seedEq(supabaseAdmin, {
      slug: seedKey('mobile'),
      service_intervals: [
        {kind: 'hours', hours_or_km: 500, label: '500 Hour Service', tasks: [{id: 's1', label: 'Replace fuel filter'}]},
      ],
    });
    await openForm(page, eq);
    await fillBasics(page, {reading: '200'});

    const disclosure = disclosureFor(page, 'hours:500');
    await expect(disclosure).toBeVisible();
    const box = await disclosure.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    // The accessible name carries the label + neutral context (reading 200 →
    // 300h remaining to the 500h milestone).
    await expect(disclosure).toContainText('500 Hour Service');
    await expect(disclosure).toContainText('Next at 500h · 300h remaining');

    await disclosure.tap();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await rowFor(page, 'hours:500').locator('label', {hasText: 'Replace fuel filter'}).locator('input').check();
    await expect(page.getByRole('button', {name: 'Save Fueling'})).toBeVisible();
    await saveAndWaitSynced(page);

    const rows = await fetchFuelings(supabaseAdmin, eq.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].service_intervals_completed).toHaveLength(1);
  });
});
