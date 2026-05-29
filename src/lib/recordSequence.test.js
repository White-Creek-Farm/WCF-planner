import {describe, it, expect} from 'vitest';
import {toRecordSeq, recordSeqNavOptions, findSequenceNeighbors} from './recordSequence.js';

describe('toRecordSeq', () => {
  it('projects rows down to {id, tag}', () => {
    expect(
      toRecordSeq([
        {id: 'a', tag: '1', extra: 'x'},
        {id: 'b', tag: 'A45'},
      ]),
    ).toEqual([
      {id: 'a', tag: '1'},
      {id: 'b', tag: 'A45'},
    ]);
  });
  it('drops rows without an id and normalizes missing tag to null', () => {
    expect(toRecordSeq([{id: 'a'}, {tag: 'no-id'}, null, {id: 'c', tag: null}])).toEqual([
      {id: 'a', tag: null},
      {id: 'c', tag: null},
    ]);
  });
  it('returns [] for non-arrays', () => {
    expect(toRecordSeq(undefined)).toEqual([]);
    expect(toRecordSeq(null)).toEqual([]);
    expect(toRecordSeq('nope')).toEqual([]);
  });
});

describe('recordSeqNavOptions', () => {
  it('wraps the projected sequence under state.recordSeq', () => {
    expect(recordSeqNavOptions([{id: 'a', tag: '1'}])).toEqual({state: {recordSeq: [{id: 'a', tag: '1'}]}});
  });
});

describe('findSequenceNeighbors', () => {
  const seq = [
    {id: 'a', tag: '1'},
    {id: 'b', tag: '2'},
    {id: 'c', tag: '3'},
  ];

  it('returns prev + next for a middle record', () => {
    expect(findSequenceNeighbors(seq, 'b')).toEqual({
      index: 1,
      total: 3,
      prev: {id: 'a', tag: '1'},
      next: {id: 'c', tag: '3'},
    });
  });
  it('has no prev at the first record', () => {
    const r = findSequenceNeighbors(seq, 'a');
    expect(r.index).toBe(0);
    expect(r.prev).toBeNull();
    expect(r.next).toEqual({id: 'b', tag: '2'});
  });
  it('has no next at the last record', () => {
    const r = findSequenceNeighbors(seq, 'c');
    expect(r.index).toBe(2);
    expect(r.next).toBeNull();
    expect(r.prev).toEqual({id: 'b', tag: '2'});
  });
  it('matches ids by string coercion', () => {
    expect(findSequenceNeighbors([{id: 1}, {id: 2}], 2).index).toBe(1);
    expect(findSequenceNeighbors([{id: 1}, {id: 2}], '2').index).toBe(1);
  });

  // No-reliable-sequence cases → index -1 so the caller hides the controls.
  it('returns index -1 when the sequence is missing or not an array', () => {
    expect(findSequenceNeighbors(null, 'a').index).toBe(-1);
    expect(findSequenceNeighbors(undefined, 'a').index).toBe(-1);
  });
  it('returns index -1 for a single-record sequence', () => {
    expect(findSequenceNeighbors([{id: 'a', tag: '1'}], 'a').index).toBe(-1);
  });
  it('returns index -1 when the current id is not in the sequence', () => {
    expect(findSequenceNeighbors(seq, 'zzz').index).toBe(-1);
  });
  it('returns index -1 when currentId is null', () => {
    expect(findSequenceNeighbors(seq, null).index).toBe(-1);
  });
});
