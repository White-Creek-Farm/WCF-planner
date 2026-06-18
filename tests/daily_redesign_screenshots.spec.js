import {test} from './fixtures.js';
import fs from 'node:fs';

// ============================================================================
// Build Queue 5 — UI preview capture (NOT a CI assertion suite).
// Seeds representative daily reports across all six programs (variety: feed +
// neutral tag, no-feed, mortality badge, comment note, 0 kV voltage, long feed
// wrap, long team name, herd/flock dots) and screenshots the six program list
// pages + the admin Home "Last 5 Days" feed, desktop + mobile, so Ronnie can
// approve the redesign before commit.
// Screenshots -> C:/Users/Ronni/cc-research/daily-redesign/.
// ============================================================================

const SHOT = 'C:/Users/Ronni/cc-research/daily-redesign';
const DESKTOP = {width: 1280, height: 1000};
const MOBILE = {width: 390, height: 844};

// Dates inside the Home "last 7 days" window (env clock ~2026-06-18).
const D1 = '2026-06-18';
const D2 = '2026-06-17';
const D3 = '2026-06-16';

const base = (id, date) => ({id, date, deleted_at: null, deleted_by: null, client_submission_id: null});

test.describe('Daily redesign UI preview', () => {
  test('seed + capture all daily surfaces', async ({page, supabaseAdmin, resetDb}) => {
    test.setTimeout(180_000);
    await resetDb();
    fs.mkdirSync(SHOT, {recursive: true});

    const ins = async (table, rows) => {
      const r = await supabaseAdmin.from(table).upsert(rows, {onConflict: 'id'});
      if (r.error) throw new Error(`${table}: ${r.error.message}`);
    };

    // ---- Broiler (poultry_dailys) ----
    await ins('poultry_dailys', [
      {...base('b1', D1), team_member: 'Simon', batch_label: 'B-26-10', feed_lbs: 175, feed_type: 'GROWER', photos: []},
      {...base('b2', D1), team_member: 'Simon', batch_label: 'B-26-09', feed_lbs: 775, feed_type: 'GROWER', photos: []},
      {
        ...base('b3', D1),
        team_member: 'Simon',
        batch_label: 'B-26-07',
        mortality_count: 2,
        mortality_reason: '1 cull, 1 DOA',
        photos: [],
      },
      {
        ...base('b4', D1),
        team_member: 'Simon',
        batch_label: 'B-26-06',
        mortality_count: 13,
        mortality_reason: 'leg issues',
        comments: 'Noticed quite a few birds had some pretty bad leg issues. Couldn’t make it to the feeder, so we culled them.',
        photos: [],
      },
      {...base('b5', D1), team_member: 'Simon', batch_label: 'B-26-08', feed_lbs: 300, feed_type: 'GROWER', photos: []},
      {
        ...base('b6', D2),
        team_member: 'Simon',
        batch_label: 'B-26-10',
        mortality_count: 1,
        mortality_reason: 'DOA',
        photos: [],
      },
    ]);

    // ---- Pig (pig_dailys) — 0 kV must read red; others black ----
    await ins('pig_dailys', [
      {
        ...base('p1', D1),
        team_member: 'Simon',
        batch_label: 'P-26-02A (GILTS)',
        batch_id: 'p-26-02a',
        feed_lbs: 50,
        pig_count: 5,
        fence_voltage: 3.4,
        group_moved: false,
        photos: [],
      },
      {
        ...base('p2', D1),
        team_member: 'Simon',
        batch_label: 'BOARS',
        batch_id: 'boars',
        feed_lbs: 10,
        pig_count: 2,
        fence_voltage: 5.2,
        group_moved: false,
        photos: [],
      },
      {
        ...base('p3', D1),
        team_member: 'Simon',
        batch_label: 'SOWS',
        batch_id: 'sows',
        feed_lbs: 135,
        pig_count: 24,
        fence_voltage: 4.3,
        issues: '#21 is giving birth — only saw 2 piglets at the time. Believe she is still going, will update when we know more.',
        photos: [],
      },
      {
        ...base('p4', D2),
        team_member: 'Simon',
        batch_label: 'P-26-02B (BOARS)',
        batch_id: 'p-26-02b',
        feed_lbs: 50,
        pig_count: 8,
        fence_voltage: 0,
        issues: 'The boars were weighed and moved to the holding corral.',
        photos: [],
      },
    ]);

    // ---- Layer (layer_dailys) ----
    await ins('layer_dailys', [
      {
        ...base('l1', D1),
        team_member: 'Simon',
        batch_label: 'Retirement Home',
        feed_lbs: 13,
        feed_type: 'LAYER',
        mortality_count: 1,
        mortality_reason: 'Predator',
        comments: 'Looks like another raccoon.',
        photos: [],
      },
      {...base('l2', D1), team_member: 'Simon', batch_label: 'Eggmobile 2', photos: []},
      {...base('l3', D1), team_member: 'Simon', batch_label: 'Layer Schooner', photos: []},
      {...base('l4', D1), team_member: 'Simon', batch_label: 'Eggmobile 3', group_moved: false, photos: []},
    ]);

    // ---- Egg (egg_dailys) — no photos column ----
    await ins('egg_dailys', [
      {
        id: 'e1',
        date: D1,
        deleted_at: null,
        deleted_by: null,
        team_member: 'Jenny Lee',
        group1_name: 'Eggmobile 3',
        group1_count: 76,
        group2_name: 'Layer Schooner',
        group2_count: 204,
        group3_name: 'Eggmobile 2',
        group3_count: 96,
        dozens_on_hand: 125,
      },
      {
        id: 'e2',
        date: D2,
        deleted_at: null,
        deleted_by: null,
        team_member: 'Jenny Lee',
        group1_name: 'Eggmobile 3',
        group1_count: 64,
        group2_name: 'Layer Schooner',
        group2_count: 180,
        dozens_on_hand: 110,
      },
    ]);

    // ---- Cattle (cattle_dailys) — long feed wraps; herd dots ----
    await ins('cattle_dailys', [
      {
        ...base('c1', D1),
        team_member: 'Nick',
        herd: 'finishers',
        fence_voltage: 7,
        water_checked: true,
        feeds: [
          {feed_name: 'Citrus Pellets', qty: 425, unit: 'lb'},
          {feed_name: 'Molasses', qty: 1, unit: 'tub'},
        ],
        minerals: [],
        photos: [],
      },
      {
        ...base('c2', D1),
        team_member: 'Nick',
        herd: 'mommas',
        fence_voltage: 7,
        water_checked: true,
        feeds: [],
        minerals: [],
        photos: [],
      },
      {
        ...base('c3', D2),
        team_member: 'Brian',
        herd: 'finishers',
        fence_voltage: 5.1,
        water_checked: true,
        feeds: [
          {feed_name: 'Alfalfa 2000#', qty: 1, unit: 'bale'},
          {feed_name: 'Citrus Pellets', qty: 425, unit: 'lb'},
        ],
        minerals: [],
        issues: 'Opened paddock line so they can access next paddock.',
        photos: [],
      },
    ]);

    // ---- Sheep (sheep_dailys) — long team name wraps inside chip ----
    await ins('sheep_dailys', [
      {
        ...base('s1', D1),
        team_member: 'Nick',
        flock: 'ewes',
        fence_voltage_kv: 7,
        waterers_working: true,
        feeds: [{feed_name: 'Alfalfa Pellets', qty: 50, unit: 'lb'}],
        minerals: [],
        photos: [],
      },
      {
        ...base('s2', D2),
        team_member: 'Brian Naide',
        flock: 'ewes',
        fence_voltage_kv: 6.4,
        waterers_working: true,
        feeds: [],
        minerals: [],
        comments: 'Moved flock to the river paddock.',
        photos: [],
      },
      {
        ...base('s3', D3),
        team_member: 'Nick',
        flock: 'ewes',
        fence_voltage_kv: 7,
        waterers_working: true,
        feeds: [],
        minerals: [],
        photos: [],
      },
    ]);

    const surfaces = [
      {name: '01-broiler-dailys', url: '/broiler/dailys', ready: '[data-broiler-dailys-loaded="true"]'},
      {name: '02-pig-dailys', url: '/pig/dailys', ready: '[data-pig-dailys-loaded="true"]'},
      {name: '03-layer-dailys', url: '/layer/dailys', ready: '[data-layer-dailys-loaded="true"]'},
      {name: '04-egg-dailys', url: '/layer/eggs', ready: '[data-egg-dailys-loaded="true"]'},
      {name: '05-cattle-dailys', url: '/cattle/dailys', ready: '[data-cattle-dailys-loaded="true"]'},
      {name: '06-sheep-dailys', url: '/sheep/dailys', ready: '[data-sheep-dailys-loaded="true"]'},
      {name: '07-home-last5days', url: '/', ready: '.admin-daily'},
    ];

    for (const s of surfaces) {
      // desktop
      await page.setViewportSize(DESKTOP);
      await page.goto(s.url);
      await page.waitForSelector('#wcf-boot-loader', {state: 'detached', timeout: 20_000}).catch(() => {});
      await page.waitForSelector(s.ready, {timeout: 20_000}).catch(() => {});
      await page.waitForTimeout(700);
      await page.screenshot({path: `${SHOT}/${s.name}-desktop.png`, fullPage: true});

      // mobile
      await page.setViewportSize(MOBILE);
      await page.goto(s.url);
      await page.waitForSelector('#wcf-boot-loader', {state: 'detached', timeout: 20_000}).catch(() => {});
      await page.waitForSelector(s.ready, {timeout: 20_000}).catch(() => {});
      await page.waitForTimeout(700);
      await page.screenshot({path: `${SHOT}/${s.name}-mobile.png`, fullPage: true});
    }
  });
});
