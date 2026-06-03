// Feed-order count-aware basis scenario for tests/feed_order_basis.spec.js.
//
// The seed makes the current-month physical count and previous-month ending
// estimate produce different recommendations. That way the browser test proves
// the rendered "Order for" tile is subtracting Actual On Hand when a current
// count exists, not the stale previous estimate.

import {assertTestDatabase} from '../setup/assertTestDatabase.js';
import {calcBatchFeedForMonth} from '../../src/lib/broiler.js';
import {pigDailyBurnLbs} from '../../src/lib/feedPlanner.js';
import {recommendedFeedOrder} from '../../src/lib/feedOrderBasis.js';

function must(result, label) {
  if (result?.error) {
    throw new Error(`feedOrderBasisSeed [${label}]: ${result.error.message}`);
  }
  return result;
}

function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function currentYM() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function addMonthsYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function ymShort(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month: 'short'});
}

function daysInYM(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

async function ensureAdminProfile(supabaseAdmin) {
  const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!adminEmail) {
    throw new Error('feedOrderBasisSeed: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const usersResult = await supabaseAdmin.auth.admin.listUsers();
  if (usersResult.error) {
    throw new Error(`feedOrderBasisSeed [auth.listUsers]: ${usersResult.error.message}`);
  }
  const adminUser = usersResult.data?.users?.find((u) => u.email === adminEmail);
  if (!adminUser) {
    throw new Error(`feedOrderBasisSeed: test admin user "${adminEmail}" missing.`);
  }
  must(
    await supabaseAdmin
      .from('profiles')
      .upsert({id: adminUser.id, email: adminUser.email, role: 'admin'}, {onConflict: 'id'}),
    'profiles upsert',
  );
}

function pigProjectedMonth(ym, ctx) {
  const midDate = ym + '-15';
  return Math.round(pigDailyBurnLbs(midDate, ctx).totalLbs * daysInYM(ym));
}

export async function seedFeedOrderBasisScenario(supabaseAdmin) {
  assertTestDatabase(process.env.VITE_SUPABASE_URL || '');
  await ensureAdminProfile(supabaseAdmin);

  const thisYM = currentYM();
  const prevYM = addMonthsYM(thisYM, -1);
  const nextYM = addMonthsYM(thisYM, 1);
  const countDate = thisYM + '-01';

  const pigCountOnHand = 1500;
  const pigPrevOrder = 25000;
  const pigGroup = {
    id: 'fg-feed-order-basis-pig',
    batchName: 'P-FEED-BASIS',
    cycleId: '',
    giltCount: 200,
    boarCount: 0,
    originalPigCount: 200,
    startDate: addDaysISO(countDate, -90),
    status: 'active',
    notes: '',
    processingTrips: [],
    pigMortalities: [],
    subBatches: [],
  };
  const archivedBreeders = [{id: 'br-feed-order-basis-archived', tag: 'ARCHIVED', sex: 'Sow', archived: true}];
  const pigCtx = {
    feederGroups: [pigGroup],
    breedingCycles: [],
    breeders: archivedBreeders,
    farrowingRecs: [],
  };
  const pigNeedThruNext = pigProjectedMonth(thisYM, pigCtx) + pigProjectedMonth(nextYM, pigCtx);
  const pigExpectedOrder = recommendedFeedOrder({
    needThruNext: pigNeedThruNext,
    hasCurrentCount: true,
    actualOnHand: pigCountOnHand,
    endOfPrevEst: pigPrevOrder,
  });
  const pigStaleEstimateOrder = recommendedFeedOrder({
    needThruNext: pigNeedThruNext,
    hasCurrentCount: false,
    actualOnHand: pigCountOnHand,
    endOfPrevEst: pigPrevOrder,
  });

  const starterCountOnHand = 250;
  const poultryPrevOrder = 500;
  const broilerBatch = {
    id: 'br-feed-order-basis',
    name: 'B-FEED-BASIS',
    breed: 'CC',
    hatchDate: addDaysISO(countDate, -7),
    brooderIn: addDaysISO(countDate, -7),
    brooderOut: addDaysISO(countDate, 7),
    schoonerIn: addDaysISO(countDate, 7),
    schoonerOut: addDaysISO(countDate, 42),
    processingDate: addDaysISO(countDate, 43),
    birdCount: 750,
    status: 'active',
  };
  const currentFeed = calcBatchFeedForMonth(broilerBatch, thisYM);
  const nextFeed = calcBatchFeedForMonth(broilerBatch, nextYM);
  const starterNeedThruNext = currentFeed.starter + nextFeed.starter;
  const starterExpectedOrder = recommendedFeedOrder({
    needThruNext: starterNeedThruNext,
    hasCurrentCount: true,
    actualOnHand: starterCountOnHand,
    endOfPrevEst: poultryPrevOrder,
  });
  const starterStaleEstimateOrder = recommendedFeedOrder({
    needThruNext: starterNeedThruNext,
    hasCurrentCount: false,
    actualOnHand: starterCountOnHand,
    endOfPrevEst: poultryPrevOrder,
  });

  if (pigExpectedOrder === pigStaleEstimateOrder || starterExpectedOrder === starterStaleEstimateOrder) {
    throw new Error('feedOrderBasisSeed: count and previous-estimate recommendations must differ.');
  }

  const feedOrders = {
    pig: {[prevYM]: pigPrevOrder},
    starter: {[prevYM]: poultryPrevOrder},
    grower: {[prevYM]: poultryPrevOrder},
    layerfeed: {[prevYM]: poultryPrevOrder},
  };

  const appStoreRows = [
    {key: 'ppp-feeders-v1', data: [pigGroup]},
    {key: 'ppp-breeders-v1', data: archivedBreeders},
    {key: 'ppp-breeding-v1', data: []},
    {key: 'ppp-farrowing-v1', data: []},
    {key: 'ppp-v4', data: [broilerBatch]},
    {key: 'ppp-feed-orders-v1', data: feedOrders},
    {
      key: 'ppp-pig-feed-inventory-v1',
      data: {count: pigCountOnHand, date: countDate, includesCurrentMonthDelivery: true},
    },
    {
      key: 'ppp-poultry-feed-inventory-v1',
      data: {
        starter: {
          count: starterCountOnHand,
          date: countDate,
          includesCurrentMonthDelivery: true,
        },
      },
    },
  ];
  must(await supabaseAdmin.from('app_store').upsert(appStoreRows, {onConflict: 'key'}), 'app_store upsert');

  return {
    thisYM,
    prevYM,
    nextYM,
    activeLabel: ymShort(thisYM),
    prevLabel: ymShort(prevYM),
    pig: {
      needThruNext: pigNeedThruNext,
      expectedOrder: pigExpectedOrder,
      staleEstimateOrder: pigStaleEstimateOrder,
    },
    poultry: {
      starterNeedThruNext,
      starterExpectedOrder,
      starterStaleEstimateOrder,
    },
  };
}
