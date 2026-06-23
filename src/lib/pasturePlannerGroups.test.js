import {describe, expect, it} from 'vitest';
import {
  computePlannerGroupRoster,
  deriveFeederShort,
  destinationsForGroup,
  isPigPastureWithPaddocks,
  SPECIES_COLOR,
} from './pasturePlannerGroups.js';

// Minimal builders that match the real row/record shapes the helper reads.
const cow = (herd, extra = {}) => ({id: `c-${Math.random()}`, herd, ...extra});
const ewe = (flock, extra = {}) => ({id: `s-${Math.random()}`, flock, ...extra});
const sow = (group, extra = {}) => ({id: `b-${Math.random()}`, sex: 'Sow', group, archived: false, ...extra});
const boar = (extra = {}) => ({id: `b-${Math.random()}`, sex: 'Boar', archived: false, ...extra});
// A feeder sub that has no trips/transfers/mortality so its ledger current is
// simply giltCount + boarCount.
const feederGroup = (subBatches, extra = {}) => ({
  status: 'active',
  batchName: 'Batch 22',
  processingTrips: [],
  subBatches,
  ...extra,
});
const sub = (name, gilt, boar_, extra = {}) => ({
  id: `sub-${name}`,
  name,
  status: 'active',
  giltCount: gilt,
  boarCount: boar_,
  ...extra,
});

describe('computePlannerGroupRoster', () => {
  it('returns an empty roster for empty/missing input', () => {
    expect(computePlannerGroupRoster()).toEqual({groups: [], bySpecies: []});
    expect(computePlannerGroupRoster({cattle: [], sheep: [], breeders: [], feederGroups: []})).toEqual({
      groups: [],
      bySpecies: [],
    });
  });

  it('counts cattle by herd, excludes soft-deleted, hides count-0 herds', () => {
    const cattle = [
      cow('mommas'),
      cow('mommas'),
      cow('mommas', {deleted_at: '2026-01-01'}), // excluded
      cow('finishers'),
      cow('bulls'),
      // no backgrounders -> hidden
    ];
    const {bySpecies} = computePlannerGroupRoster({cattle});
    const cattleSec = bySpecies.find((s) => s.species === 'cattle');
    const byName = Object.fromEntries(cattleSec.groups.map((g) => [g.name, g.count]));
    expect(byName).toEqual({Mommas: 2, Finishers: 1, Bulls: 1});
    expect(cattleSec.groups.some((g) => g.name === 'Backgrounders')).toBe(false);
    expect(cattleSec.headCount).toBe(4);
    const mommas = cattleSec.groups.find((g) => g.name === 'Mommas');
    expect(mommas).toMatchObject({species: 'cattle', animalType: 'cattle_herd', groupKey: 'mommas', short: 'MM'});
  });

  it('counts sheep by flock and excludes soft-deleted', () => {
    const sheep = [ewe('ewes'), ewe('ewes'), ewe('rams'), ewe('feeders', {deleted_at: 'x'})];
    const sec = computePlannerGroupRoster({sheep}).bySpecies.find((s) => s.species === 'sheep');
    expect(Object.fromEntries(sec.groups.map((g) => [g.name, g.count]))).toEqual({Ewes: 2, Rams: 1});
    expect(sec.groups.find((g) => g.name === 'Ewes')).toMatchObject({animalType: 'sheep_flock', groupKey: 'ewes'});
  });

  it('counts sow groups by number (Sow + Gilt), excludes archived, hides empty groups', () => {
    const breeders = [
      sow('1'),
      sow('1', {sex: 'Gilt'}),
      sow('1', {archived: true}), // excluded
      sow('2'),
      // group 3 empty -> hidden
      boar(),
      boar({archived: true}), // excluded
    ];
    const sec = computePlannerGroupRoster({breeders}).bySpecies.find((s) => s.species === 'pig');
    const byName = Object.fromEntries(sec.groups.map((g) => [g.name, g.count]));
    expect(byName['Sow Group 1']).toBe(2);
    expect(byName['Sow Group 2']).toBe(1);
    expect('Sow Group 3' in byName).toBe(false);
    expect(byName.Boars).toBe(1);
    expect(sec.groups.find((g) => g.name === 'Sow Group 1')).toMatchObject({
      animalType: 'breeder_pigs',
      groupKey: 'sow-1',
      short: 'S1',
    });
    expect(sec.groups.find((g) => g.name === 'Boars')).toMatchObject({groupKey: 'boars', short: 'B'});
  });

  it('includes only active feeder sub-batches with current count > 0, labeled by name', () => {
    const feederGroups = [
      feederGroup([
        sub('Weaners — Batch 22', 18, 4), // 22
        sub('Empty sub', 0, 0), // count 0 -> excluded
        sub('Processed sub', 10, 0, {status: 'processed'}), // processed -> excluded
      ]),
      feederGroup([sub('Inactive parent sub', 5, 5)], {status: 'processed'}), // parent inactive -> skipped
    ];
    const sec = computePlannerGroupRoster({feederGroups}).bySpecies.find((s) => s.species === 'pig');
    const feeders = sec.groups.filter((g) => g.animalType === 'feeder_pigs');
    expect(feeders).toHaveLength(1);
    expect(feeders[0]).toMatchObject({name: 'Weaners — Batch 22', count: 22, groupKey: 'sub-Weaners — Batch 22'});
  });

  it('omits an active feeder sub-batch that has no stable id (count > 0 but unkeyable)', () => {
    const feederGroups = [
      feederGroup([
        {name: 'No-id sub', status: 'active', giltCount: 9, boarCount: 1, id: ''}, // blank id -> omitted
        {name: 'Null-id sub', status: 'active', giltCount: 3, boarCount: 0, id: null}, // null id -> omitted
        sub('Weaners — Batch 30', 10, 0), // keeps
      ]),
    ];
    const sec = computePlannerGroupRoster({feederGroups}).bySpecies.find((s) => s.species === 'pig');
    const feeders = (sec ? sec.groups : []).filter((g) => g.animalType === 'feeder_pigs');
    expect(feeders.map((g) => g.name)).toEqual(['Weaners — Batch 30']);
  });

  it('orders Pigs -> Sheep -> Cattle and pigs in roster order (sows, boars, feeders)', () => {
    const roster = computePlannerGroupRoster({
      cattle: [cow('mommas')],
      sheep: [ewe('ewes')],
      breeders: [sow('1'), boar()],
      feederGroups: [feederGroup([sub('Feeders — Batch 9', 12, 0)])],
    });
    expect(roster.bySpecies.map((s) => s.species)).toEqual(['pig', 'sheep', 'cattle']);
    expect(roster.groups.map((g) => g.name)).toEqual(['Sow Group 1', 'Boars', 'Feeders — Batch 9', 'Ewes', 'Mommas']);
  });

  it('species sections carry the design-token color and a head total', () => {
    const sec = computePlannerGroupRoster({cattle: [cow('mommas'), cow('finishers')]}).bySpecies[0];
    expect(sec).toMatchObject({species: 'cattle', color: SPECIES_COLOR.cattle, headCount: 2});
  });
});

describe('deriveFeederShort', () => {
  it('builds a <=3 char code from letters + trailing number', () => {
    expect(deriveFeederShort('Weaners — Batch 22')).toBe('W22');
    expect(deriveFeederShort('Finishers — Batch 7')).toBe('F7');
    expect(deriveFeederShort('Batch 105')).toBe('B10'); // letter B + digits 105, clamped to 3 chars
  });

  it('falls back to letters when no number is present', () => {
    expect(deriveFeederShort('Weaners')).toBe('WE');
    expect(deriveFeederShort('')).toBe('F');
  });
});

describe('destinationsForGroup + isPigPastureWithPaddocks (feeder-pig destinations)', () => {
  const pigPasture = {id: 'la-p4', kind: 'pasture', name: 'Pig Pasture #4', designation: 'feeder_pig'};
  const padB3 = {id: 'la-pigpad-b3', kind: 'paddock', designation: 'feeder_pig', name: 'B-3', parent_id: 'la-p4'};
  const padB4 = {id: 'la-pigpad-b4', kind: 'paddock', designation: 'feeder_pig', name: 'B-4', parent_id: 'la-p4'};
  const cattlePasture = {id: 'la-cp', kind: 'pasture', name: 'North Pasture', designation: 'cattle'};
  const tempPad = {id: 'la-tmp', kind: 'paddock', permanence: 'temporary', name: 'Temp West'};
  const feeder = {id: 'pig-feeder-x', animalType: 'feeder_pigs', groupKey: 'x'};
  const cattle = {id: 'cattle-mommas', animalType: 'cattle_herd', groupKey: 'mommas'};

  const all = [pigPasture, padB3, padB4, cattlePasture, tempPad];

  it('feeder-pig group prefers the feeder-pig paddocks only', () => {
    const dests = destinationsForGroup(feeder, all);
    expect(dests).toEqual([padB3, padB4]);
    expect(dests).not.toContain(pigPasture); // parent pasture is not a feeder destination
  });

  it('feeder-pig group falls back to the full set when no feeder paddocks exist', () => {
    const noPads = [pigPasture, cattlePasture, tempPad];
    expect(destinationsForGroup(feeder, noPads)).toEqual(noPads);
  });

  it('non-feeder groups (cattle) use the full destination set unchanged', () => {
    expect(destinationsForGroup(cattle, all)).toEqual(all);
  });

  it('isPigPastureWithPaddocks flags the parent pig pasture but not paddocks/other pastures', () => {
    expect(isPigPastureWithPaddocks(pigPasture, all)).toBe(true);
    expect(isPigPastureWithPaddocks(padB3, all)).toBe(false);
    expect(isPigPastureWithPaddocks(cattlePasture, all)).toBe(false);
    // graceful: a pig pasture with no paddock children is still placeable
    expect(isPigPastureWithPaddocks(pigPasture, [pigPasture, cattlePasture])).toBe(false);
  });
});
