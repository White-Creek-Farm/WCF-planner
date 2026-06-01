import {describe, expect, it} from 'vitest';
import {buildLayerDailyGroupOptions, resolveLayerDailyBatchId} from './layerDailyGroups.js';

describe('buildLayerDailyGroupOptions', () => {
  const layerBatches = [
    {id: 'batch-a', name: 'L-26-01', status: 'active'},
    {id: 'batch-b', name: 'L-26-02', status: 'active'},
    {id: 'batch-old', name: 'L-25-01', status: 'retired'},
  ];
  const layerHousings = [
    {id: 'housing-a', batch_id: 'batch-a', housing_name: 'Eggmobile 1', status: 'active'},
    {id: 'housing-old', batch_id: 'batch-old', housing_name: 'Old Coop', status: 'retired'},
  ];

  it('uses active unhoused batch names plus active housing names', () => {
    expect(buildLayerDailyGroupOptions({layerBatches, layerHousings})).toEqual(['L-26-02', 'Eggmobile 1']);
  });

  it('falls back to legacy active layer groups when batch and housing tables are unavailable', () => {
    const layerGroups = [
      {id: 'legacy-a', name: 'Legacy A', status: 'active'},
      {id: 'legacy-old', name: 'Legacy Old', status: 'retired'},
      'String Legacy',
    ];

    expect(buildLayerDailyGroupOptions({layerGroups})).toEqual(['Legacy A', 'String Legacy']);
  });

  it('preserves the current historical label when it is outside the active set', () => {
    expect(buildLayerDailyGroupOptions({layerBatches, layerHousings, currentLabel: 'Retired Group'})).toEqual([
      'L-26-02',
      'Eggmobile 1',
      'Retired Group',
    ]);
  });
});

describe('resolveLayerDailyBatchId', () => {
  const layerGroups = [{id: 'legacy-a', name: 'Legacy A', status: 'active'}];
  const layerBatches = [{id: 'batch-a', name: 'L-26-01', status: 'active'}];
  const layerHousings = [{id: 'housing-a', batch_id: 'batch-a', housing_name: 'Eggmobile 1', status: 'active'}];

  it('resolves exact group labels case-insensitively through batches, housings, then legacy groups', () => {
    expect(resolveLayerDailyBatchId('l-26-01', {layerGroups, layerBatches, layerHousings})).toBe('batch-a');
    expect(resolveLayerDailyBatchId('eggmObile 1', {layerGroups, layerBatches, layerHousings})).toBe('batch-a');
    expect(resolveLayerDailyBatchId('legacy a', {layerGroups, layerBatches: [], layerHousings: []})).toBe('legacy-a');
  });

  it('returns null when the label is missing or only a legacy string without an id', () => {
    expect(resolveLayerDailyBatchId('', {layerGroups, layerBatches, layerHousings})).toBeNull();
    expect(resolveLayerDailyBatchId('String Legacy', {layerGroups: ['String Legacy']})).toBeNull();
  });
});
