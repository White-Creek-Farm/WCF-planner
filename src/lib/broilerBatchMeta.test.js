import {describe, it, expect} from 'vitest';
import {splitSchooners, buildBroilerPublicMirror, deriveBroilerColumnLabels} from './broilerBatchMeta.js';

describe('splitSchooners', () => {
  it('splits a single ampersand pair and trims', () => {
    expect(splitSchooners('Schooner 2 & Schooner 3')).toEqual(['Schooner 2', 'Schooner 3']);
  });

  it('handles three-way splits with mixed whitespace', () => {
    expect(splitSchooners(' A &  B & C ')).toEqual(['A', 'B', 'C']);
  });

  it('returns [] for null / undefined / empty', () => {
    expect(splitSchooners(null)).toEqual([]);
    expect(splitSchooners(undefined)).toEqual([]);
    expect(splitSchooners('')).toEqual([]);
  });

  it('drops empty fragments from stray ampersands', () => {
    expect(splitSchooners('&')).toEqual([]);
    expect(splitSchooners('A & & B')).toEqual(['A', 'B']);
  });

  it('coerces non-strings via String()', () => {
    expect(splitSchooners(0)).toEqual([]);
    expect(splitSchooners(123)).toEqual(['123']);
  });
});

describe('buildBroilerPublicMirror', () => {
  const sample = [
    {name: 'B-26-01', status: 'active', schooner: 'Schooner 2 & Schooner 3'},
    {name: 'B-26-02', status: 'planned', schooner: 'Schooner 1'},
    {name: 'B-26-03', status: 'active', schooner: ''},
    {name: 'B-25-09', status: 'archived', schooner: 'Schooner 4'},
    {name: 'B-25-08', status: 'processed', schooner: 'Schooner 5'},
  ];

  it('includes only status === "active" batches (planned/archived/processed all dropped)', () => {
    const {groups, meta} = buildBroilerPublicMirror(sample);
    expect(groups).toEqual(['B-26-01', 'B-26-03']);
    expect(meta.map((m) => m.name)).toEqual(['B-26-01', 'B-26-03']);
  });

  it('drops planned batches', () => {
    const {groups, meta} = buildBroilerPublicMirror(sample);
    expect(groups).not.toContain('B-26-02');
    expect(meta.find((m) => m.name === 'B-26-02')).toBeUndefined();
  });

  it('drops archived and processed batches', () => {
    const {groups} = buildBroilerPublicMirror(sample);
    expect(groups).not.toContain('B-25-09');
    expect(groups).not.toContain('B-25-08');
  });

  it('groups[i] aligns with meta[i].name', () => {
    const {groups, meta} = buildBroilerPublicMirror(sample);
    groups.forEach((name, i) => {
      expect(meta[i].name).toBe(name);
    });
  });

  it('keeps active empty-schooner batches with schooners:[] (admin misconfig surfaces at Start Session)', () => {
    const {meta} = buildBroilerPublicMirror(sample);
    const empty = meta.find((m) => m.name === 'B-26-03');
    expect(empty).toMatchObject({name: 'B-26-03', schooners: []});
  });

  it('parses ampersand-joined schooners into per-batch arrays', () => {
    const {meta} = buildBroilerPublicMirror(sample);
    const twoCol = meta.find((m) => m.name === 'B-26-01');
    expect(twoCol.schooners).toEqual(['Schooner 2', 'Schooner 3']);
  });

  it('returns {groups:[], meta:[]} for null/undefined/empty input', () => {
    expect(buildBroilerPublicMirror(null)).toEqual({groups: [], meta: []});
    expect(buildBroilerPublicMirror(undefined)).toEqual({groups: [], meta: []});
    expect(buildBroilerPublicMirror([])).toEqual({groups: [], meta: []});
  });

  it('skips falsy rows defensively', () => {
    const {groups} = buildBroilerPublicMirror([null, undefined, {name: 'X', status: 'active', schooner: 'Y'}]);
    expect(groups).toEqual(['X']);
  });

  it('drops rows with no status field defensively', () => {
    const {groups} = buildBroilerPublicMirror([{name: 'NoStatus', schooner: 'Y'}]);
    expect(groups).toEqual([]);
  });
});

describe('deriveBroilerColumnLabels', () => {
  const meta = [
    {name: 'B-26-01', schooners: ['Schooner 2', 'Schooner 3']},
    {name: 'B-26-02', schooners: ['Schooner 1']},
    {name: 'B-26-03', schooners: []},
  ];

  it('returns the schooners array for the matching batch', () => {
    expect(deriveBroilerColumnLabels(meta, 'B-26-01')).toEqual(['Schooner 2', 'Schooner 3']);
    expect(deriveBroilerColumnLabels(meta, 'B-26-02')).toEqual(['Schooner 1']);
  });

  it('returns [] for empty-schooner batches (no fallback)', () => {
    expect(deriveBroilerColumnLabels(meta, 'B-26-03')).toEqual([]);
  });

  it('returns [] when batch not in meta (no fallback)', () => {
    expect(deriveBroilerColumnLabels(meta, 'B-99-99')).toEqual([]);
  });

  it('returns [] for null/undefined/empty meta', () => {
    expect(deriveBroilerColumnLabels(null, 'B-26-01')).toEqual([]);
    expect(deriveBroilerColumnLabels(undefined, 'B-26-01')).toEqual([]);
    expect(deriveBroilerColumnLabels([], 'B-26-01')).toEqual([]);
  });

  it("never produces '(no schooner)' or ['1','2'] sentinels", () => {
    const out = deriveBroilerColumnLabels(meta, 'B-26-03');
    expect(out).not.toContain('(no schooner)');
    expect(out).not.toEqual(['1', '2']);
    const missing = deriveBroilerColumnLabels(meta, 'NOPE');
    expect(missing).not.toContain('(no schooner)');
    expect(missing).not.toEqual(['1', '2']);
  });

  it('drops empty-string entries inside schooners[] defensively', () => {
    const m = [{name: 'X', schooners: ['Schooner 2', '', 'Schooner 3']}];
    expect(deriveBroilerColumnLabels(m, 'X')).toEqual(['Schooner 2', 'Schooner 3']);
  });
});
