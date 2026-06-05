import {describe, it, expect} from 'vitest';
import {
  calcPoultryStatus,
  shouldAutoActivateBroilerBatch,
  shouldAutoProcessBroilerBatch,
  computeBroilerOnFarmCounts,
  recomputeBroilerBatchWeekAvg,
} from './broiler.js';

// Minimal Supabase-style query mock.
//
// Supports the chainable shape recomputeBroilerBatchWeekAvg + applyPppV4Update
// build:
//   sb.from(table).select(cols).eq(col,val)... .order().limit() → Promise
//   sb.from(table).select(cols).eq(col,val).maybeSingle()       → Promise
//   sb.from(table).upsert(row, opts)                            → Promise
//
// Each mock query records its filters + the table it was issued against and
// then resolves with whatever the test pre-registered for that table.
function makeSb(handlers) {
  const calls = {sessions: [], weighIns: [], appStoreSelect: [], appStoreUpsert: []};
  function selectChain(table) {
    const filters = {neq: {}, eq: {}};
    let order = null;
    let lim = null;
    const chain = {
      eq(col, val) {
        filters.eq[col] = val;
        return chain;
      },
      neq(col, val) {
        filters.neq[col] = val;
        return chain;
      },
      order(col, opts) {
        order = {col, opts};
        return chain;
      },
      limit(n) {
        lim = n;
        return chain;
      },
      maybeSingle() {
        return Promise.resolve(handlers.appStoreSelect(filters));
      },
      then(resolve, reject) {
        // Used when callers await the chain directly (sessions / weigh_ins).
        const action = table === 'weigh_in_sessions' ? handlers.sessions : handlers.weighIns;
        const recordTo = table === 'weigh_in_sessions' ? calls.sessions : calls.weighIns;
        recordTo.push({filters, order, lim});
        return Promise.resolve(action(filters, order, lim)).then(resolve, reject);
      },
    };
    return chain;
  }
  return {
    sb: {
      from(table) {
        return {
          select() {
            if (table === 'app_store') {
              return {
                eq() {
                  return {
                    maybeSingle: () =>
                      Promise.resolve().then(() => {
                        calls.appStoreSelect.push(true);
                        return handlers.appStoreSelect();
                      }),
                  };
                },
              };
            }
            return selectChain(table);
          },
          upsert(row) {
            calls.appStoreUpsert.push(row);
            return Promise.resolve(handlers.appStoreUpsert(row));
          },
        };
      },
    },
    calls,
  };
}

describe('broiler hatch-date status promotion', () => {
  it('auto-computes planned batches as active on their hatch date', () => {
    expect(calcPoultryStatus({status: 'planned', hatchDate: '2026-05-05', breed: 'CC'}, '2026-05-05')).toBe('active');
  });

  it('keeps planned batches planned before hatch date', () => {
    expect(calcPoultryStatus({status: 'planned', hatchDate: '2026-05-06', breed: 'CC'}, '2026-05-05')).toBe('planned');
  });

  it('does not override explicit active or processed states', () => {
    expect(calcPoultryStatus({status: 'active', hatchDate: '2026-05-10', breed: 'CC'}, '2026-05-05')).toBe('active');
    expect(calcPoultryStatus({status: 'processed', hatchDate: '2026-05-01', breed: 'CC'}, '2026-05-05')).toBe(
      'processed',
    );
  });

  it('flags only planned batches whose hatch date is today or earlier for persistence', () => {
    expect(shouldAutoActivateBroilerBatch({status: 'planned', hatchDate: '2026-05-05'}, '2026-05-05')).toBe(true);
    expect(shouldAutoActivateBroilerBatch({status: 'planned', hatchDate: '2026-05-04'}, '2026-05-05')).toBe(true);
    expect(shouldAutoActivateBroilerBatch({status: 'planned', hatchDate: '2026-05-06'}, '2026-05-05')).toBe(false);
    expect(shouldAutoActivateBroilerBatch({status: 'active', hatchDate: '2026-05-05'}, '2026-05-05')).toBe(false);
  });
});

describe('broiler processing-date auto-processing', () => {
  it('flags active batches whose processing date is today or earlier (inclusive)', () => {
    expect(shouldAutoProcessBroilerBatch({status: 'active', processingDate: '2026-05-05'}, '2026-05-05')).toBe(true);
    expect(shouldAutoProcessBroilerBatch({status: 'active', processingDate: '2026-05-04'}, '2026-05-05')).toBe(true);
  });

  it('leaves active batches with a future processing date alone', () => {
    expect(shouldAutoProcessBroilerBatch({status: 'active', processingDate: '2026-05-06'}, '2026-05-05')).toBe(false);
  });

  it('only affects active batches — not planned, processed, missing status, or no processing date', () => {
    expect(shouldAutoProcessBroilerBatch({status: 'planned', processingDate: '2026-05-01'}, '2026-05-05')).toBe(false);
    expect(shouldAutoProcessBroilerBatch({status: 'processed', processingDate: '2026-05-01'}, '2026-05-05')).toBe(
      false,
    );
    expect(shouldAutoProcessBroilerBatch({processingDate: '2026-05-01'}, '2026-05-05')).toBe(false);
    expect(shouldAutoProcessBroilerBatch({status: 'active'}, '2026-05-05')).toBe(false);
    expect(shouldAutoProcessBroilerBatch(null, '2026-05-05')).toBe(false);
  });
});

describe('computeBroilerOnFarmCounts', () => {
  it('uses active projected live birds as on-farm count and keeps started count separate', () => {
    const batches = [
      {name: 'B-ACT-1', status: 'active', hatchDate: '2026-05-01', breed: 'CC', birdCountActual: 750},
      {name: 'B-ACT-2', status: 'planned', hatchDate: '2026-05-02', breed: 'WR', birdCountActual: 500},
      {name: 'B-PROC', status: 'processed', hatchDate: '2026-04-01', breed: 'CC', birdCountActual: 700},
      {name: 'B-FUTURE', status: 'planned', hatchDate: '2026-05-20', breed: 'CC', birdCountActual: 600},
    ];
    const dailys = [
      {batch_label: 'B-ACT-1', mortality_count: 4, feed_lbs: 0, grit_lbs: 0},
      {batch_label: 'B-ACT-1', mortality_count: '6', feed_lbs: 0, grit_lbs: 0},
      {batch_label: 'B-ACT-2', mortality_count: 3, feed_lbs: 0, grit_lbs: 0},
      {batch_label: 'B-PROC', mortality_count: 50, feed_lbs: 0, grit_lbs: 0},
    ];

    const counts = computeBroilerOnFarmCounts(batches, dailys, '2026-05-10');

    expect(counts.activeBatches.map((b) => b.name)).toEqual(['B-ACT-1', 'B-ACT-2']);
    expect(counts.activeBatchCount).toBe(2);
    expect(counts.startedBirds).toBe(1250);
    expect(counts.mortality).toBe(13);
    expect(counts.onFarmBirds).toBe(1237);
  });

  it('uses legacy B-24 mortality fields for active legacy batches', () => {
    const counts = computeBroilerOnFarmCounts(
      [
        {
          name: 'B-24-LEG',
          status: 'active',
          hatchDate: '2024-05-01',
          breed: 'CC',
          birdCountActual: 700,
          mortalityCumulative: 12,
        },
      ],
      [],
      '2024-05-10',
    );

    expect(counts.startedBirds).toBe(700);
    expect(counts.mortality).toBe(12);
    expect(counts.onFarmBirds).toBe(688);
  });
});

describe('recomputeBroilerBatchWeekAvg', () => {
  it('returns {ok:true} for invalid args (defensive no-op)', async () => {
    const {sb} = makeSb({
      sessions: () => ({}),
      weighIns: () => ({}),
      appStoreSelect: () => ({}),
      appStoreUpsert: () => ({}),
    });
    expect(await recomputeBroilerBatchWeekAvg(null, 'B-1', 4)).toEqual({ok: true});
    expect(await recomputeBroilerBatchWeekAvg(sb, '', 4)).toEqual({ok: true});
    expect(await recomputeBroilerBatchWeekAvg(sb, 'B-1', 5)).toEqual({ok: true});
    expect(await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: null})).toBeTruthy();
  });

  it('deletes the wk4Lbs key when no other complete sessions back the week', async () => {
    let upserted = null;
    const {sb} = makeSb({
      sessions: () => ({data: [], error: null}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({
        data: {data: [{name: 'B-1', schooner: '2&3', week4Lbs: 1.5, week6Lbs: 2.0}]},
        error: null,
      }),
      appStoreUpsert: (row) => {
        upserted = row;
        return {error: null};
      },
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'sess-x'});
    expect(r).toEqual({ok: true});
    expect(upserted.data[0]).not.toHaveProperty('week4Lbs');
    expect(upserted.data[0].week6Lbs).toBe(2.0);
  });

  it('deletes the wk6Lbs key when no other complete sessions back wk6', async () => {
    let upserted = null;
    const {sb} = makeSb({
      sessions: () => ({data: [], error: null}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'B-1', week4Lbs: 1.5, week6Lbs: 2.0}]}, error: null}),
      appStoreUpsert: (row) => {
        upserted = row;
        return {error: null};
      },
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 6, {excludeSessionId: 'sess-x'});
    expect(r).toEqual({ok: true});
    expect(upserted.data[0]).not.toHaveProperty('week6Lbs');
    expect(upserted.data[0].week4Lbs).toBe(1.5);
  });

  it('writes the avg of the latest OTHER complete session when one exists', async () => {
    let upserted = null;
    const {sb, calls} = makeSb({
      sessions: () => ({
        data: [{id: 'sess-other', completed_at: '2026-04-30T10:00:00Z'}],
        error: null,
      }),
      weighIns: () => ({data: [{weight: 1.4}, {weight: 1.6}], error: null}), // avg 1.5
      appStoreSelect: () => ({data: {data: [{name: 'B-1', week4Lbs: 9.9}]}, error: null}),
      appStoreUpsert: (row) => {
        upserted = row;
        return {error: null};
      },
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'sess-moved'});
    expect(r).toEqual({ok: true});
    expect(upserted.data[0].week4Lbs).toBe(1.5);
    // Sessions query carried excludeSessionId as a .neq filter.
    expect(calls.sessions[0].filters.neq).toEqual({id: 'sess-moved'});
    expect(calls.sessions[0].filters.eq).toMatchObject({
      species: 'broiler',
      batch_id: 'B-1',
      broiler_week: 4,
      status: 'complete',
    });
  });

  it('omits .neq when excludeSessionId is omitted/null', async () => {
    const {sb, calls} = makeSb({
      sessions: () => ({data: [{id: 'sess-only', completed_at: '2026-04-30T10:00:00Z'}], error: null}),
      weighIns: () => ({data: [{weight: 2}, {weight: 2}], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'B-1'}]}, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    const r1 = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4);
    expect(r1).toEqual({ok: true});
    expect(calls.sessions[0].filters.neq).toEqual({});

    const r2 = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: null});
    expect(r2).toEqual({ok: true});
    expect(calls.sessions[1].filters.neq).toEqual({});
  });

  it('orders by completed_at desc and limits to 1 (latest wins)', async () => {
    const {sb, calls} = makeSb({
      sessions: () => ({data: [{id: 'latest', completed_at: '2026-05-01'}], error: null}),
      weighIns: () => ({data: [{weight: 1.7}], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'B-1'}]}, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'sess-moved'});
    expect(calls.sessions[0].order).toEqual({col: 'completed_at', opts: {ascending: false}});
    expect(calls.sessions[0].lim).toBe(1);
  });

  it('returns {ok:true} as no-op when picked session has zero usable entries', async () => {
    let upserted = null;
    const {sb} = makeSb({
      sessions: () => ({data: [{id: 'sess-other', completed_at: '2026-04-30'}], error: null}),
      weighIns: () => ({data: [{weight: 0}, {weight: -1}, {weight: 'NaN'}], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'B-1'}]}, error: null}),
      appStoreUpsert: (row) => {
        upserted = row;
        return {error: null};
      },
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r).toEqual({ok: true});
    expect(upserted).toBeNull(); // no upsert fired (no usable entries)
  });

  it('returns {ok:true} as no-op when ppp-v4 row is absent', async () => {
    const {sb, calls} = makeSb({
      sessions: () => ({data: [], error: null}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({data: null, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r).toEqual({ok: true});
    expect(calls.appStoreUpsert).toEqual([]);
  });

  it('returns {ok:true} as no-op when batch row is missing from ppp-v4', async () => {
    const {sb, calls} = makeSb({
      sessions: () => ({data: [], error: null}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'OTHER-1', week4Lbs: 1.0}]}, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r).toEqual({ok: true});
    expect(calls.appStoreUpsert).toEqual([]);
  });

  it('returns {ok:false} when sessions read errors', async () => {
    const {sb} = makeSb({
      sessions: () => ({data: null, error: {message: 'rls denied'}}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({data: null, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/sessions read failed/);
  });

  it('returns {ok:false} when entries read errors', async () => {
    const {sb} = makeSb({
      sessions: () => ({data: [{id: 'sess-other', completed_at: '2026-04-30'}], error: null}),
      weighIns: () => ({data: null, error: {message: 'boom'}}),
      appStoreSelect: () => ({data: null, error: null}),
      appStoreUpsert: () => ({error: null}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/entries read failed/);
  });

  it('returns {ok:false} when ppp-v4 select errors (delete branch)', async () => {
    const {sb} = makeSb({
      sessions: () => ({data: [], error: null}),
      weighIns: () => ({data: [], error: null}),
      appStoreSelect: () => ({data: null, error: {message: 'select boom'}}),
      appStoreUpsert: () => ({error: null}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ppp-v4 read failed/);
  });

  it('returns {ok:false} when ppp-v4 upsert errors (recompute branch)', async () => {
    const {sb} = makeSb({
      sessions: () => ({data: [{id: 'sess-other', completed_at: '2026-04-30'}], error: null}),
      weighIns: () => ({data: [{weight: 1.5}], error: null}),
      appStoreSelect: () => ({data: {data: [{name: 'B-1'}]}, error: null}),
      appStoreUpsert: () => ({error: {message: 'upsert boom'}}),
    });
    const r = await recomputeBroilerBatchWeekAvg(sb, 'B-1', 4, {excludeSessionId: 'x'});
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ppp-v4 upsert failed/);
  });
});
