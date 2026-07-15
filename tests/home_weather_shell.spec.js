import {test, expect} from './fixtures.js';

// ============================================================================
// Home weather card — immediate stable shell.
//
// The collapsed weather card must render together with the rest of the Home
// dashboard (no late arrival), keep one stable DOM node across loading /
// ready / unavailable / retry, stay visible on failure, and never duplicate
// in-flight requests. Initial load is non-forced (no _t= cache-buster);
// explicit Retry/Refresh are forced (_t= present).
//
// NOTE: this spec drives the authenticated Home page and therefore contacts
// the shared TEST database via the auth/session fixtures. Run it only inside
// an approved TEST window, one file per invocation.
// ============================================================================

const WEATHER_ROUTE = '**/.netlify/functions/weather-forecast*';

const FORECAST_FIXTURE = {
  fetchedAt: '2026-07-15T12:00:00.000Z',
  radarUrl: 'https://radar.weather.gov/',
  location: {label: 'Farm', lat: 30.844206, lon: -86.436543},
  sources: {forecast: 'Open-Meteo GFS/HRRR', radar: 'National Weather Service'},
  current: {temp: 88.4, weatherCode: 1000},
  today: {high: 93.1, low: 74.2, precipProb: 40},
  daily: [
    {
      date: '2026-07-15',
      weatherCodeMax: 1000,
      tempMax: 93.1,
      tempMin: 74.2,
      precipProbMax: 40,
      windSpeedMax: 8,
    },
  ],
  monthlyPrecip: {
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    years: [{year: 2026, values: [4.1, 3.2, 5.5, 2.9, 3.8, 6.2, 1.1, null, null, null, null, null], total: 26.8}],
  },
};

function fulfillForecast(route) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(FORECAST_FIXTURE),
  });
}

const card = (page) => page.locator('[data-weather-card="collapsed"]');

async function tagCardNode(page) {
  await page.evaluate(() => {
    window.__wxShellNode = document.querySelector('[data-weather-card="collapsed"]');
  });
}

async function cardNodeIsSame(page) {
  return page.evaluate(() => window.__wxShellNode === document.querySelector('[data-weather-card="collapsed"]'));
}

test('collapsed card renders immediately while the forecast is pending, then fills in place', async ({page}) => {
  let releaseForecast;
  const hold = new Promise((resolve) => {
    releaseForecast = resolve;
  });
  const requestUrls = [];
  await page.route(WEATHER_ROUTE, async (route) => {
    requestUrls.push(route.request().url());
    await hold;
    await fulfillForecast(route);
  });

  await page.goto('/');

  // The shell exists with the dashboard, in a visible loading state, before
  // the forecast response arrives.
  await expect(card(page)).toBeVisible({timeout: 15_000});
  await expect(card(page)).toHaveAttribute('data-weather-state', 'loading');
  await expect(card(page)).toHaveAttribute('aria-busy', 'true');
  await expect(card(page)).toContainText('Loading weather');

  // Loading clicks are inert: no modal, no broken expansion.
  await card(page).click();
  await expect(page.locator('[data-weather-card="expanded"]')).toHaveCount(0);

  await tagCardNode(page);
  releaseForecast();

  await expect(card(page)).toHaveAttribute('data-weather-state', 'ready', {timeout: 10_000});
  await expect(card(page)).toContainText('88');
  await expect(card(page)).toContainText('Rain 40%');
  expect(await cardNodeIsSame(page)).toBe(true);

  // Initial load is non-forced: no _t= cache-buster on the first request.
  expect(requestUrls.length).toBe(1);
  expect(requestUrls[0]).not.toContain('_t=');

  // Ready card expands to the real modal.
  await card(page).click();
  await expect(page.locator('[data-weather-card="expanded"]')).toBeVisible();
  await expect(page.locator('[data-weather-card="expanded"]')).toContainText('10-Day Forecast');
});

test('failure keeps the card; retry is forced, single-flight, and repopulates the same node', async ({page}) => {
  let failFirst = true;
  let releaseRetry;
  const retryHold = new Promise((resolve) => {
    releaseRetry = resolve;
  });
  const requestUrls = [];
  await page.route(WEATHER_ROUTE, async (route) => {
    requestUrls.push(route.request().url());
    if (failFirst) {
      failFirst = false;
      await route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"boom"}'});
      return;
    }
    await retryHold;
    await fulfillForecast(route);
  });

  await page.goto('/');

  // Failed load: the card stays, distinguishable and actionable.
  await expect(card(page)).toBeVisible({timeout: 15_000});
  await expect(card(page)).toHaveAttribute('data-weather-state', 'unavailable', {timeout: 10_000});
  await expect(card(page)).toContainText('Weather unavailable');
  await expect(card(page)).toContainText('Retry');
  await expect(page.locator('[data-weather-card="expanded"]')).toHaveCount(0);
  expect(requestUrls.length).toBe(1);

  await tagCardNode(page);

  // Rapid repeated clicks: visibly enters loading, but only ONE request goes out.
  await card(page).click();
  await expect(card(page)).toHaveAttribute('data-weather-state', 'loading');
  await expect(card(page)).toHaveAttribute('aria-busy', 'true');
  await card(page).click();
  await card(page).click();

  // Wait for the intercepted retry request to arrive before inspecting it;
  // the end-of-test count assertion still locks out duplicate requests.
  await expect.poll(() => requestUrls.length, {timeout: 10_000}).toBe(2);

  // Retry is forced.
  expect(requestUrls[1]).toContain('_t=');

  releaseRetry();

  // Successful retry populates the SAME card node in place.
  await expect(card(page)).toHaveAttribute('data-weather-state', 'ready', {timeout: 10_000});
  await expect(card(page)).toContainText('Rain 40%');
  expect(await cardNodeIsSame(page)).toBe(true);
  expect(requestUrls.length).toBe(2);
});

test('ready card keeps hover lift and modal Refresh stays forced without hiding the card on failure', async ({
  page,
}) => {
  let requestCount = 0;
  let refreshMode = 'ok';
  await page.route(WEATHER_ROUTE, async (route) => {
    requestCount += 1;
    if (refreshMode === 'fail') {
      await route.fulfill({status: 500, contentType: 'application/json', body: '{"error":"boom"}'});
      return;
    }
    await fulfillForecast(route);
  });

  await page.goto('/');
  await expect(card(page)).toHaveAttribute('data-weather-state', 'ready', {timeout: 15_000});

  // Hover lift affordance is intact on the collapsed card.
  await expect(card(page)).toHaveClass(/lift/);
  await card(page).hover();
  await expect
    .poll(async () => card(page).evaluate((el) => getComputedStyle(el).transform !== 'none'), {timeout: 3_000})
    .toBe(true);

  // Modal Refresh uses force and a failed refresh retains the last forecast.
  await card(page).click();
  const modal = page.locator('[data-weather-card="expanded"]');
  await expect(modal).toBeVisible();
  refreshMode = 'fail';
  const before = requestCount;
  const [refreshRequest] = await Promise.all([
    page.waitForRequest((req) => req.url().includes('weather-forecast')),
    modal.getByRole('button', {name: /Refresh/}).click(),
  ]);
  expect(refreshRequest.url()).toContain('_t=');
  await expect.poll(() => requestCount).toBe(before + 1);

  // Refresh failure must not blank the card or the modal data.
  await expect(card(page)).toHaveAttribute('data-weather-state', 'ready');
  await expect(modal).toContainText('10-Day Forecast');
});
