import {describe, it, expect} from 'vitest';
import {
  computeProjectedCount,
  computeHousingDisplayCount,
  createLayerDailyHousingMatcher,
  layerDailyMatchesHousing,
} from './layerHousing.js';

describe('layerDailyMatchesHousing (canonical shared rule)', () => {
  const eggmobile2 = {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2'};
  const schooner = {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner'};
  const soloHousing = {id: 'h-solo', batch_id: 'lb-9', housing_name: 'Eggmobile 1'};
  const roster = [eggmobile2, schooner, soloHousing];

  it('exact normalized label match wins', () => {
    const daily = {batch_label: '  layer schooner ', batch_id: 'l-26-01'};
    expect(layerDailyMatchesHousing(daily, schooner, roster)).toBe(true);
  });

  it('a sibling housing`s label never matches through the shared batch_id', () => {
    const daily = {batch_label: 'Layer Schooner', batch_id: 'l-26-01'};
    expect(layerDailyMatchesHousing(daily, eggmobile2, roster)).toBe(false);
  });

  it('one daily row matches at most one housing across the roster', () => {
    const matcher = createLayerDailyHousingMatcher(roster);
    const daily = {batch_label: 'Layer Schooner', batch_id: 'l-26-01'};
    const matched = roster.filter((h) => matcher(daily, h));
    expect(matched).toEqual([schooner]);
  });

  it('unambiguous batch-id fallback works for a single-housing batch', () => {
    const daily = {batch_label: 'L-25-01', batch_id: 'lb-9'};
    expect(layerDailyMatchesHousing(daily, soloHousing, roster)).toBe(true);
  });

  it('ambiguous multi-housing batch fallback fails closed', () => {
    const daily = {batch_label: 'L-26-01', batch_id: 'l-26-01'};
    expect(layerDailyMatchesHousing(daily, eggmobile2, roster)).toBe(false);
    expect(layerDailyMatchesHousing(daily, schooner, roster)).toBe(false);
  });

  it('without a roster the housing itself is the only known housing (legacy fallback)', () => {
    const daily = {batch_label: 'L-25-01', batch_id: 'lb-9'};
    expect(layerDailyMatchesHousing(daily, soloHousing)).toBe(true);
    expect(layerDailyMatchesHousing(daily, soloHousing, [])).toBe(true);
  });

  it('no batch ids on either side means exact label only', () => {
    expect(
      layerDailyMatchesHousing({batch_label: 'Retirement Home'}, {id: 'h-rh', housing_name: 'Retirement Home'}),
    ).toBe(true);
    expect(
      layerDailyMatchesHousing({batch_label: 'Somewhere Else'}, {id: 'h-rh', housing_name: 'Retirement Home'}),
    ).toBe(false);
  });
});

describe('sibling housings do not double-count dailys', () => {
  const eggmobile2 = {id: 'h-e2', batch_id: 'l-26-01', housing_name: 'Eggmobile 2', current_count: null};
  const schooner = {id: 'h-ls', batch_id: 'l-26-01', housing_name: 'Layer Schooner', current_count: null};
  const roster = [eggmobile2, schooner];
  const dailys = [
    {batch_label: 'Eggmobile 2', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 156, mortality_count: 0},
    {batch_label: 'Layer Schooner', batch_id: 'l-26-01', date: '2026-04-10', layer_count: 293, mortality_count: 0},
  ];

  it('computeHousingDisplayCount gives each sibling its own exact-label count', () => {
    expect(computeHousingDisplayCount(eggmobile2, dailys, roster)).toBe(156);
    expect(computeHousingDisplayCount(schooner, dailys, roster)).toBe(293);
  });

  it('computeProjectedCount anchors each sibling on its own daily', () => {
    expect(computeProjectedCount(eggmobile2, dailys, roster).anchor).toBe(156);
    expect(computeProjectedCount(schooner, dailys, roster).anchor).toBe(293);
  });

  it('a sibling with no evidence of its own stays empty instead of borrowing', () => {
    const schoonerOnly = [dailys[1]];
    expect(computeHousingDisplayCount(eggmobile2, schoonerOnly, roster)).toBe(0);
    expect(computeProjectedCount(eggmobile2, schoonerOnly, roster)).toBeNull();
  });
});

describe('computeProjectedCount', () => {
  it('returns null for null housing', () => {
    expect(computeProjectedCount(null, [])).toBeNull();
  });

  it('uses explicit current_count when set', () => {
    const housing = {housing_name: 'Eggmobile 1', current_count: 200, current_count_date: '2026-04-01'};
    const dailys = [{batch_label: 'Eggmobile 1', date: '2026-04-05', layer_count: 210, mortality_count: 3}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(200);
    expect(result.projected).toBe(197);
    expect(result.mortSince).toBe(3);
  });

  it('falls back to latest daily layer_count when current_count is null', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null, current_count_date: null};
    const dailys = [
      {batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0},
      {batch_label: 'Eggmobile 3', date: '2026-04-05', layer_count: 120, mortality_count: 0},
    ];
    const result = computeProjectedCount(housing, dailys);
    expect(result).not.toBeNull();
    expect(result.anchor).toBe(115);
    expect(result.anchorDate).toBe('2026-04-10');
    expect(result.projected).toBe(115);
  });

  it('subtracts mortality after fallback anchor date', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null, current_count_date: null};
    const dailys = [
      {batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0},
      {batch_label: 'Eggmobile 3', date: '2026-04-12', layer_count: null, mortality_count: 2},
      {batch_label: 'Eggmobile 3', date: '2026-04-15', layer_count: null, mortality_count: 1},
    ];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.anchorDate).toBe('2026-04-10');
    expect(result.mortSince).toBe(3);
    expect(result.projected).toBe(112);
  });

  it('returns null when current_count is null and no matching dailys exist', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null, current_count_date: null};
    const dailys = [{batch_label: 'Eggmobile 1', date: '2026-04-10', layer_count: 200, mortality_count: 0}];
    expect(computeProjectedCount(housing, dailys)).toBeNull();
  });

  it('ignores dailys with zero or null layer_count in fallback', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null, current_count_date: null};
    const dailys = [
      {batch_label: 'Eggmobile 3', date: '2026-04-12', layer_count: null, mortality_count: 1},
      {batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0},
    ];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.anchorDate).toBe('2026-04-10');
    expect(result.mortSince).toBe(1);
    expect(result.projected).toBe(114);
  });

  it('explicit current_count wins even when dailys have higher layer_count', () => {
    const housing = {housing_name: 'Eggmobile 1', current_count: 100, current_count_date: '2026-04-01'};
    const dailys = [{batch_label: 'Eggmobile 1', date: '2026-04-10', layer_count: 200, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(100);
  });

  it('case-insensitive batch_label matching for fallback', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null, current_count_date: null};
    const dailys = [{batch_label: 'eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result).not.toBeNull();
    expect(result.anchor).toBe(115);
  });

  it('current_count 0 with no date falls back to daily', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: 0, current_count_date: null};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.anchorDate).toBe('2026-04-10');
    expect(result.projected).toBe(115);
  });

  it('current_count 0 with older date falls back to newer daily', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: 0, current_count_date: '2026-03-01'};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.anchorDate).toBe('2026-04-10');
    expect(result.projected).toBe(115);
  });

  it('active housing with current_count 0 and newer date still falls back to daily', () => {
    const housing = {housing_name: 'Eggmobile 3', status: 'active', current_count: 0, current_count_date: '2026-05-18'};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.projected).toBe(115);
  });

  it('retired housing with current_count 0 and newer date preserves intentional zero', () => {
    const housing = {
      housing_name: 'Eggmobile 3',
      status: 'retired',
      current_count: 0,
      current_count_date: '2026-05-01',
    };
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(0);
    expect(result.projected).toBe(0);
  });

  it('current_count 0 with no date and no matching dailys returns projected 0', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: 0, current_count_date: null};
    const dailys = [{batch_label: 'Eggmobile 1', date: '2026-04-10', layer_count: 200, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(0);
    expect(result.projected).toBe(0);
  });

  it('current_count 0 with same date as daily falls back to daily', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: 0, current_count_date: '2026-04-10'};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
    expect(result.projected).toBe(115);
  });

  it('string current_count "0" falls back to daily', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: '0', current_count_date: null};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
  });

  it('empty string current_count falls back to daily', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: '', current_count_date: null};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    const result = computeProjectedCount(housing, dailys);
    expect(result.anchor).toBe(115);
  });

  it('matches daily by batch_id when batch_label differs from housing_name', () => {
    const housing = {housing_name: 'Eggmobile 3', batch_id: 'batch-99', current_count: null, current_count_date: null};
    const dailys = [
      {batch_label: 'L-25-01', batch_id: 'batch-99', date: '2026-04-10', layer_count: 115, mortality_count: 0},
    ];
    const result = computeProjectedCount(housing, dailys);
    expect(result).not.toBeNull();
    expect(result.anchor).toBe(115);
  });
});

describe('computeHousingDisplayCount', () => {
  it('returns 0 for null housing', () => {
    expect(computeHousingDisplayCount(null, [])).toBe(0);
  });

  it('returns positive current_count directly', () => {
    const housing = {housing_name: 'Eggmobile 1', current_count: 200};
    expect(computeHousingDisplayCount(housing, [])).toBe(200);
  });

  it('falls back to daily when current_count is 0', () => {
    const housing = {housing_name: 'Eggmobile 3', status: 'active', current_count: 0, current_count_date: '2026-05-18'};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    expect(computeHousingDisplayCount(housing, dailys)).toBe(115);
  });

  it('falls back to daily when current_count is null', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null};
    const dailys = [{batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0}];
    expect(computeHousingDisplayCount(housing, dailys)).toBe(115);
  });

  it('does NOT subtract mortality', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: null};
    const dailys = [
      {batch_label: 'Eggmobile 3', date: '2026-04-10', layer_count: 115, mortality_count: 0},
      {batch_label: 'Eggmobile 3', date: '2026-04-15', layer_count: null, mortality_count: 5},
    ];
    expect(computeHousingDisplayCount(housing, dailys)).toBe(115);
  });

  it('matches by batch_id when housing_name differs', () => {
    const housing = {housing_name: 'Eggmobile 3', batch_id: 'b-99', current_count: null};
    const dailys = [{batch_label: 'L-25-01', batch_id: 'b-99', date: '2026-04-10', layer_count: 115}];
    expect(computeHousingDisplayCount(housing, dailys)).toBe(115);
  });

  it('returns 0 when no match and current_count is 0', () => {
    const housing = {housing_name: 'Eggmobile 3', current_count: 0};
    const dailys = [{batch_label: 'Eggmobile 1', date: '2026-04-10', layer_count: 200}];
    expect(computeHousingDisplayCount(housing, dailys)).toBe(0);
  });
});
