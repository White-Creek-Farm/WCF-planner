import {test, expect} from './fixtures.js';

function matrixTranslateY(transform) {
  if (!transform || transform === 'none') return 0;
  const match = transform.match(/^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)$/);
  return match ? Number(match[1]) : NaN;
}

async function resolveVarRgb(page, varName) {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = `var(${name})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  }, varName);
}

async function seedEquipment(supabaseAdmin, {id, name}) {
  const {error} = await supabaseAdmin.from('equipment').upsert(
    {
      id,
      slug: id,
      name,
      category: 'tractors',
      tracking_unit: 'hours',
      status: 'active',
      current_hours: null,
      current_km: null,
      warranty_expiration: null,
      service_intervals: [],
      attachment_checklists: [],
      every_fillup_items: [],
      notes: null,
    },
    {onConflict: 'id'},
  );
  if (error) throw new Error('seedEquipment(' + id + '): ' + error.message);
}

test('fleet tile: pointer cursor, hover wash + lift, keyboard focus + Enter opens the record', async ({
  page,
  supabaseAdmin,
  resetDb,
}) => {
  await resetDb();
  await seedEquipment(supabaseAdmin, {id: 'eq-a', name: 'Aaa Tractor'});
  await seedEquipment(supabaseAdmin, {id: 'eq-b', name: 'Bbb Tractor'});

  await page.goto('/fleet');
  const tile = page.locator('[data-equipment-tile]').first();
  await expect(tile).toBeVisible({timeout: 15_000});

  const resting = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {cursor: cs.cursor, transform: cs.transform};
  });
  expect(resting.cursor).toBe('pointer');
  expect(resting.transform).toBe('none');

  const restingBg = await tile.evaluate((el) => getComputedStyle(el).backgroundColor);
  await tile.hover();
  // WI-6 ratified lift is translateY(-3px)/300ms (global .hoverable-tile:hover,
  // index.html): poll until the transition settles at -3, then band it so a
  // larger drift still fails.
  await expect
    .poll(async () => matrixTranslateY(await tile.evaluate((el) => getComputedStyle(el).transform)), {timeout: 3_000})
    .toBeLessThanOrEqual(-2.9);
  const hovered = await tile.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {transform: cs.transform, boxShadow: cs.boxShadow, backgroundColor: cs.backgroundColor};
  });
  expect(matrixTranslateY(hovered.transform)).toBeGreaterThanOrEqual(-3.1);
  expect(hovered.boxShadow).not.toBe('none');
  expect(hovered.backgroundColor).toBe(restingBg);

  await page.mouse.move(0, 0);
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.hasAttribute('data-equipment-tile'));
  }
  expect(focused, 'Tab never reached a fleet tile').toBe(true);
  const focusRing = await page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return {outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth};
  });
  expect(focusRing.outlineStyle).toBe('solid');
  expect(focusRing.outlineWidth).toBe('2px');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/fleet\/eq-a$/, {timeout: 10_000});
});

test('broiler batches row: pointer cursor, hover wash on cells, no transform, Enter opens the record', async ({
  page,
  broilerTimelineScenario,
}) => {
  await broilerTimelineScenario({});
  await page.goto('/broiler/batches');
  const row = page.locator('tr.hoverable-row').first();
  await expect(row).toBeVisible({timeout: 15_000});

  expect(await row.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

  const expectedWash = await resolveVarRgb(page, '--row-hover');
  await row.hover();
  const cell = row.locator('td').first();
  await expect
    .poll(async () => cell.evaluate((el) => getComputedStyle(el).backgroundColor), {timeout: 3_000})
    .toBe(expectedWash);
  expect(await row.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  expect(await row.getAttribute('role')).toBe('button');
  expect(await row.getAttribute('tabindex')).toBe('0');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/broiler\/batches\/.+/, {timeout: 10_000});
});

const FORECAST_FIXTURE = {
  current: {temp: 72, feelsLike: 74, humidity: 82, windSpeed: 9, windGust: 18, weatherCode: 1101},
  today: {high: 88, low: 69, precipProb: 40, precipAmount: 0.08, windGustMax: 22},
  rainWindows: {
    next6h: {maxProb: 20, precipAmount: 0, startTime: null, endTime: null, confidence: 'none'},
    next24h: {
      maxProb: 55,
      precipAmount: 0.08,
      startTime: '2026-06-11T14:00:00',
      endTime: '2026-06-11T17:00:00',
      confidence: 'medium',
    },
    next48h: {
      maxProb: 55,
      precipAmount: 0.08,
      startTime: '2026-06-11T14:00:00',
      endTime: '2026-06-11T17:00:00',
      confidence: 'medium',
    },
  },
  dryWindow: {hours: 6, startTime: '2026-06-11T08:00:00', endTime: '2026-06-11T13:00:00'},
  freezeWarning: null,
  dailySource: 'open-meteo-gfs',
  daily: Array.from({length: 10}, (_, i) => ({
    date: `2026-06-${String(11 + i).padStart(2, '0')}`,
    tempMax: 88,
    tempMin: 69,
    precipProbMax: 40,
    precipAmount: 0.08,
    weatherCodeMax: 1101,
    windSpeedMax: 12,
    windGustMax: 22,
  })),
  monthlyPrecip: {
    unit: 'in',
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    years: [2026, 2025, 2024, 2023].map((year) => ({
      year,
      values: Array(12).fill(1.25),
      total: 15,
    })),
  },
  hourly: [],
  sources: {forecast: 'Open-Meteo GFS/HRRR', radar: 'National Weather Service'},
  radarUrl: 'https://radar.weather.gov/',
  fetchedAt: '2026-06-11T13:00:00Z',
  location: {lat: 30.84, lon: -86.43, label: 'Farm'},
};

test('home weather card: button with card/lift treatment, hover lift, click opens modal', async ({page, resetDb}) => {
  await resetDb();
  await page.route('**/.netlify/functions/weather-forecast*', (route) =>
    route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(FORECAST_FIXTURE)}),
  );
  await page.goto('/');

  const card = page.locator('[data-weather-card="collapsed"]');
  await expect(card).toBeVisible({timeout: 15_000});

  expect(await card.evaluate((el) => el.tagName)).toBe('BUTTON');
  expect(await card.evaluate((el) => el.className)).toContain('card');
  expect(await card.evaluate((el) => el.className)).toContain('weather-card');
  expect(await card.evaluate((el) => el.className)).toContain('lift');
  expect(await card.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
  expect(await card.evaluate((el) => getComputedStyle(el).transform)).toBe('none');

  await card.hover();
  // Same WI-6 settled lift as the fleet tile (.home .lift:hover is -3px too):
  // poll to the settled -3px, then band it so a larger drift still fails.
  await expect
    .poll(async () => matrixTranslateY(await card.evaluate((el) => getComputedStyle(el).transform)), {timeout: 3_000})
    .toBeLessThanOrEqual(-2.9);
  expect(matrixTranslateY(await card.evaluate((el) => getComputedStyle(el).transform))).toBeGreaterThanOrEqual(-3.1);
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');

  await card.click();
  const modal = page.locator('[data-weather-card="expanded"]');
  await expect(modal).toBeVisible({timeout: 5_000});
  const refresh = modal.getByRole('button', {name: 'Refresh'});
  await expect(refresh).toBeVisible();
  const close = modal.getByRole('button', {name: 'Close weather'});
  await close.click();
  await expect(modal).not.toBeVisible();
});
