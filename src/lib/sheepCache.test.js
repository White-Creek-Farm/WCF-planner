import {beforeEach, describe, expect, it} from 'vitest';
import {invalidateSheepWeighInsCache, loadSheepWeighInsCached} from './sheepCache.js';

function query(result) {
  return {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    in() {
      return this;
    },
    range() {
      return this;
    },
    then(resolve) {
      resolve(result);
    },
  };
}

function makeSb({sessions, weighIns}) {
  return {
    from(table) {
      if (table === 'weigh_in_sessions') return query(sessions);
      if (table === 'weigh_ins') return query(weighIns);
      throw new Error('unexpected table: ' + table);
    },
  };
}

const OK_SESSIONS = {data: [{id: 'sess-1'}], error: null};
const OK_WEIGH_INS = {
  data: [
    {id: 'w1', entered_at: '2026-05-01T12:00:00Z'},
    {id: 'w2', entered_at: '2026-05-04T12:00:00Z'},
  ],
  error: null,
};

describe('loadSheepWeighInsCached - read-failure visibility', () => {
  beforeEach(() => {
    invalidateSheepWeighInsCache();
  });

  it('throws on a sessions read error when throwOnError is set', async () => {
    const sb = makeSb({sessions: {data: null, error: {message: 'boom'}}, weighIns: OK_WEIGH_INS});
    await expect(loadSheepWeighInsCached(sb, {throwOnError: true})).rejects.toThrow(/sessions/);
  });

  it('throws on a weigh_ins page read error when throwOnError is set', async () => {
    const sb = makeSb({sessions: OK_SESSIONS, weighIns: {data: null, error: {message: 'page down'}}});
    await expect(loadSheepWeighInsCached(sb, {throwOnError: true})).rejects.toThrow(/weigh_ins/);
  });

  it('does not poison the cache on a failed read', async () => {
    const badSb = makeSb({sessions: {data: null, error: {message: 'boom'}}, weighIns: OK_WEIGH_INS});
    await expect(loadSheepWeighInsCached(badSb, {throwOnError: true})).rejects.toThrow();

    const goodSb = makeSb({sessions: OK_SESSIONS, weighIns: OK_WEIGH_INS});
    const rows = await loadSheepWeighInsCached(goodSb, {throwOnError: true});
    expect(rows.map((r) => r.id)).toEqual(['w2', 'w1']);
  });

  it('treats an empty sheep session list as a legitimate empty result', async () => {
    const sb = makeSb({sessions: {data: [], error: null}, weighIns: OK_WEIGH_INS});
    await expect(loadSheepWeighInsCached(sb, {throwOnError: true})).resolves.toEqual([]);
  });

  it('keeps the default soft contract for existing callers', async () => {
    const sb = makeSb({sessions: {data: null, error: {message: 'boom'}}, weighIns: OK_WEIGH_INS});
    await expect(loadSheepWeighInsCached(sb)).resolves.toEqual([]);
  });
});
