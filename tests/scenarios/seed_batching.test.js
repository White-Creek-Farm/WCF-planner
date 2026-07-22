import {beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetTestAdminIdentityCache} from '../setup/testAdminIdentity.js';
import {seedCattleForecast} from './cattle_forecast_seed.js';
import {seedAnimalTransfer} from './animal_transfer_seed.js';

const ADMIN_EMAIL = 'admin@wcfplanner.test';

// Fake supabaseAdmin: listUsers resolves the admin instantly; every
// from(table).upsert stamps start/end times so barrier ordering and
// within-barrier overlap are provable. Records payloads to prove seeded
// values are unchanged.
function makeSeedFake({delay = 20} = {}) {
  const events = [];
  const payloads = {};
  const tableApis = {};
  const upsertFor = (table) =>
    vi.fn((data) => {
      payloads[table] = data;
      events.push({type: 'start', table, t: performance.now()});
      return new Promise((resolve) =>
        setTimeout(() => {
          events.push({type: 'end', table, t: performance.now()});
          resolve({error: null, data: null});
        }, delay),
      );
    });
  return {
    events,
    payloads,
    auth: {
      admin: {
        listUsers: vi.fn(async () => ({data: {users: [{id: 'admin-1', email: ADMIN_EMAIL}]}, error: null})),
      },
    },
    from: vi.fn((table) => {
      if (!tableApis[table]) tableApis[table] = {upsert: upsertFor(table)};
      return tableApis[table];
    }),
  };
}

const startT = (events, table) => events.find((e) => e.type === 'start' && e.table === table)?.t;
const endT = (events, table) => events.find((e) => e.type === 'end' && e.table === table)?.t;

beforeEach(() => {
  __resetTestAdminIdentityCache();
  process.env.WCF_TEST_DATABASE = '1';
  process.env.VITE_SUPABASE_URL = 'http://test.local';
  process.env.VITE_TEST_ADMIN_EMAIL = ADMIN_EMAIL;
});

describe('seedCattleForecast barrier ordering', () => {
  it('batches barrier-1 reference/profile rows, then keeps cattle → session → weigh-ins ordered', async () => {
    const fake = makeSeedFake();
    await seedCattleForecast(fake);
    const {events} = fake;

    const b1 = ['profiles', 'cattle_breeds', 'cattle_origins'];
    // Within-barrier overlap: all three barrier-1 upserts start before any ends.
    const lastB1Start = Math.max(...b1.map((t) => startT(events, t)));
    const firstB1End = Math.min(...b1.map((t) => endT(events, t)));
    expect(lastB1Start).toBeLessThan(firstB1End);

    // Dependency barriers hold, in order.
    const lastB1End = Math.max(...b1.map((t) => endT(events, t)));
    expect(lastB1End).toBeLessThanOrEqual(startT(events, 'cattle'));
    expect(endT(events, 'cattle')).toBeLessThanOrEqual(startT(events, 'weigh_in_sessions'));
    expect(endT(events, 'weigh_in_sessions')).toBeLessThanOrEqual(startT(events, 'weigh_ins'));
  });

  it('preserves seeded values (cattle rows carry the fixed F-* ids)', async () => {
    const fake = makeSeedFake();
    await seedCattleForecast(fake);
    const ids = fake.payloads.cattle.map((c) => c.id);
    expect(ids).toContain('F1');
    expect(ids).toContain('F-AT-MAX');
    expect(fake.payloads.weigh_in_sessions.id).toBe('wsess-cattle-forecast-seed');
  });

  it('fails setup immediately when a barrier-1 member fails', async () => {
    const fake = makeSeedFake();
    fake.from = vi.fn((table) => ({
      upsert: vi.fn(async () => (table === 'cattle_origins' ? {error: {message: 'origins boom'}} : {error: null})),
    }));
    await expect(seedCattleForecast(fake)).rejects.toThrow(/origins boom/);
  });
});

describe('seedAnimalTransfer barrier ordering', () => {
  it('runs the profile first, then the two independent animal rows together', async () => {
    const fake = makeSeedFake();
    await seedAnimalTransfer(fake);
    const {events} = fake;

    // Profile (reference) fully precedes both animal rows.
    expect(endT(events, 'profiles')).toBeLessThanOrEqual(startT(events, 'cattle'));
    expect(endT(events, 'profiles')).toBeLessThanOrEqual(startT(events, 'sheep'));

    // cattle + sheep overlap (both start before either ends).
    const lastStart = Math.max(startT(events, 'cattle'), startT(events, 'sheep'));
    const firstEnd = Math.min(endT(events, 'cattle'), endT(events, 'sheep'));
    expect(lastStart).toBeLessThan(firstEnd);
  });

  it('preserves seeded values and returns the admin id', async () => {
    const fake = makeSeedFake();
    const ids = await seedAnimalTransfer(fake);
    expect(ids).toMatchObject({adminId: 'admin-1', cowId: 'xfer-cow', eweId: 'xfer-ewe'});
    expect(fake.payloads.cattle.tag).toBe('XF-100');
    expect(fake.payloads.sheep.tag).toBe('XF-200');
  });

  it('fails setup immediately when an animal-row upsert fails', async () => {
    const fake = makeSeedFake();
    fake.from = vi.fn((table) => ({
      upsert: vi.fn(async () => (table === 'sheep' ? {error: {message: 'sheep boom'}} : {error: null})),
    }));
    await expect(seedAnimalTransfer(fake)).rejects.toThrow(/sheep boom/);
  });
});
