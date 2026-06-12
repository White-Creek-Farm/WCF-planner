import {describe, it, expect} from 'vitest';
import {
  parseCattleLogTags,
  normalizeTagSearchQuery,
  buildCattleLogBodySegments,
  matchTagToCattle,
} from './cattleLogTags.js';

// ── helpers ──────────────────────────────────────────────────────────────────
let nextId = 0;
function cow(overrides) {
  nextId += 1;
  return {
    id: 'cow-' + nextId,
    tag: '1001',
    old_tags: [],
    herd: 'mommas',
    deleted_at: null,
    ...overrides,
  };
}

// ── parseCattleLogTags ───────────────────────────────────────────────────────
describe('parseCattleLogTags', () => {
  it('extracts a single digit tag', () => {
    expect(parseCattleLogTags('cow #123 limping')).toEqual(['123']);
  });

  it('extracts multiple tags in order of appearance', () => {
    expect(parseCattleLogTags('#9 then #123 then #45')).toEqual(['9', '123', '45']);
  });

  it('dedupes repeats preserving first-seen order', () => {
    expect(parseCattleLogTags('#22 and #7 and #22 again #7')).toEqual(['22', '7']);
  });

  it('treats #0123 and #123 as distinct tags (exact text, leading zeros kept)', () => {
    expect(parseCattleLogTags('#0123 is not #123')).toEqual(['0123', '123']);
  });

  it('tag is the maximal digit run immediately after # — #12a yields 12', () => {
    expect(parseCattleLogTags('saw #12a in the chute')).toEqual(['12']);
  });

  it('rejects # not immediately followed by a digit — #a12 yields nothing', () => {
    expect(parseCattleLogTags('saw #a12 in the chute')).toEqual([]);
  });

  it('handles adjacent tags with no separator', () => {
    expect(parseCattleLogTags('#1#2#3')).toEqual(['1', '2', '3']);
  });

  it('handles tags at start and end of body', () => {
    expect(parseCattleLogTags('#5 starts and ends #6')).toEqual(['5', '6']);
  });

  it('stops at punctuation after the digit run', () => {
    expect(parseCattleLogTags('check #45.')).toEqual(['45']);
    expect(parseCattleLogTags('(#45)')).toEqual(['45']);
  });

  it('skips extra leading hashes but still finds the digit-prefixed tag', () => {
    // '##12' — the second '#' is immediately followed by digits.
    expect(parseCattleLogTags('##12')).toEqual(['12']);
  });

  it('returns [] for bare #, empty, null, undefined, and non-strings', () => {
    expect(parseCattleLogTags('just a # alone')).toEqual([]);
    expect(parseCattleLogTags('')).toEqual([]);
    expect(parseCattleLogTags(null)).toEqual([]);
    expect(parseCattleLogTags(undefined)).toEqual([]);
    expect(parseCattleLogTags(42)).toEqual([]);
  });

  it('does not match digits without a leading #', () => {
    expect(parseCattleLogTags('cow 123 limping')).toEqual([]);
  });
});

// ── normalizeTagSearchQuery ──────────────────────────────────────────────────
describe('normalizeTagSearchQuery', () => {
  it('all-digit query yields a tag with text unchanged', () => {
    expect(normalizeTagSearchQuery('123')).toEqual({text: '123', tag: '123'});
  });

  it('strips a leading # before the all-digits check', () => {
    expect(normalizeTagSearchQuery('#123')).toEqual({text: '#123', tag: '123'});
  });

  it('strips multiple leading hashes', () => {
    expect(normalizeTagSearchQuery('##77')).toEqual({text: '##77', tag: '77'});
  });

  it('preserves leading zeros in the tag (exact-text search)', () => {
    expect(normalizeTagSearchQuery('#0123')).toEqual({text: '#0123', tag: '0123'});
  });

  it('non-numeric remainder yields tag null', () => {
    expect(normalizeTagSearchQuery('#12a')).toEqual({text: '#12a', tag: null});
    expect(normalizeTagSearchQuery('bessie')).toEqual({text: 'bessie', tag: null});
    expect(normalizeTagSearchQuery('#limping cow')).toEqual({text: '#limping cow', tag: null});
  });

  it('trims whitespace and uses the trimmed text', () => {
    expect(normalizeTagSearchQuery('  #77  ')).toEqual({text: '#77', tag: '77'});
    expect(normalizeTagSearchQuery('  fence  ')).toEqual({text: 'fence', tag: null});
  });

  it('embedded # (not leading) does not produce a tag', () => {
    expect(normalizeTagSearchQuery('cow #12')).toEqual({text: 'cow #12', tag: null});
  });

  it('bare #, empty, null, undefined yield empty text and null tag', () => {
    expect(normalizeTagSearchQuery('#')).toEqual({text: '#', tag: null});
    expect(normalizeTagSearchQuery('')).toEqual({text: '', tag: null});
    expect(normalizeTagSearchQuery('   ')).toEqual({text: '', tag: null});
    expect(normalizeTagSearchQuery(null)).toEqual({text: '', tag: null});
    expect(normalizeTagSearchQuery(undefined)).toEqual({text: '', tag: null});
  });
});

// ── buildCattleLogBodySegments ───────────────────────────────────────────────
describe('buildCattleLogBodySegments', () => {
  it('body with no tags is a single text segment', () => {
    expect(buildCattleLogBodySegments('all quiet today')).toEqual([{type: 'text', value: 'all quiet today'}]);
  });

  it('splits text around a tag, consuming the #', () => {
    expect(buildCattleLogBodySegments('cow #123 limping')).toEqual([
      {type: 'text', value: 'cow '},
      {type: 'tag', value: '123'},
      {type: 'text', value: ' limping'},
    ]);
  });

  it('handles a leading tag (no empty leading text segment)', () => {
    expect(buildCattleLogBodySegments('#9 down by the pond')).toEqual([
      {type: 'tag', value: '9'},
      {type: 'text', value: ' down by the pond'},
    ]);
  });

  it('handles a trailing tag (no empty trailing text segment)', () => {
    expect(buildCattleLogBodySegments('moved #44')).toEqual([
      {type: 'text', value: 'moved '},
      {type: 'tag', value: '44'},
    ]);
  });

  it('a tag-only body is a single tag segment', () => {
    expect(buildCattleLogBodySegments('#7')).toEqual([{type: 'tag', value: '7'}]);
  });

  it('adjacent tags produce back-to-back tag segments', () => {
    expect(buildCattleLogBodySegments('#1#2')).toEqual([
      {type: 'tag', value: '1'},
      {type: 'tag', value: '2'},
    ]);
  });

  it('maximal digit run — trailing letters become text', () => {
    expect(buildCattleLogBodySegments('#12a')).toEqual([
      {type: 'tag', value: '12'},
      {type: 'text', value: 'a'},
    ]);
  });

  it('non-tag # stays in the text segment', () => {
    expect(buildCattleLogBodySegments('hay #a12 bale')).toEqual([{type: 'text', value: 'hay #a12 bale'}]);
  });

  it('duplicate tags each get their own segment (no dedupe)', () => {
    expect(buildCattleLogBodySegments('#5 and #5')).toEqual([
      {type: 'tag', value: '5'},
      {type: 'text', value: ' and '},
      {type: 'tag', value: '5'},
    ]);
  });

  it('preserves leading zeros in tag segment values', () => {
    expect(buildCattleLogBodySegments('#0123')).toEqual([{type: 'tag', value: '0123'}]);
  });

  it('returns [] for empty, null, undefined, and non-strings', () => {
    expect(buildCattleLogBodySegments('')).toEqual([]);
    expect(buildCattleLogBodySegments(null)).toEqual([]);
    expect(buildCattleLogBodySegments(undefined)).toEqual([]);
    expect(buildCattleLogBodySegments(7)).toEqual([]);
  });

  it('round-trips: concatenating segments (with # restored) rebuilds the body', () => {
    const body = 'cow #123 and #0045a near #7';
    const rebuilt = buildCattleLogBodySegments(body)
      .map((s) => (s.type === 'tag' ? '#' + s.value : s.value))
      .join('');
    expect(rebuilt).toBe(body);
  });
});

// ── matchTagToCattle ─────────────────────────────────────────────────────────
describe('matchTagToCattle', () => {
  it('matches a single active cow by current tag', () => {
    const target = cow({tag: '123'});
    const result = matchTagToCattle('123', [cow({tag: '999'}), target]);
    expect(result).toEqual({status: 'matched', cattle: [target]});
  });

  it('returns unmatched when no row carries the tag', () => {
    expect(matchTagToCattle('123', [cow({tag: '1'}), cow({tag: '2'})])).toEqual({
      status: 'unmatched',
      cattle: [],
    });
  });

  it('current-tag match wins over an old-tag match on a different cow (not ambiguous)', () => {
    const current = cow({tag: '50'});
    const retagged = cow({tag: '900', old_tags: [{tag: '50', source: 'manual'}]});
    const result = matchTagToCattle('50', [retagged, current]);
    expect(result).toEqual({status: 'matched', cattle: [current]});
  });

  it('falls back to non-import old_tags when no current tag matches', () => {
    const retagged = cow({tag: '900', old_tags: [{tag: '50', source: 'manual'}]});
    const result = matchTagToCattle('50', [cow({tag: '1'}), retagged]);
    expect(result).toEqual({status: 'matched', cattle: [retagged]});
  });

  it('old_tags entries with source import never match', () => {
    const purchased = cow({tag: '900', old_tags: [{tag: '50', source: 'import'}]});
    expect(matchTagToCattle('50', [purchased])).toEqual({status: 'unmatched', cattle: []});
  });

  it('old_tags entries with missing or null source count as non-import', () => {
    const noSource = cow({tag: '900', old_tags: [{tag: '50'}]});
    expect(matchTagToCattle('50', [noSource])).toEqual({status: 'matched', cattle: [noSource]});

    const nullSource = cow({tag: '901', old_tags: [{tag: '51', source: null}]});
    expect(matchTagToCattle('51', [nullSource])).toEqual({status: 'matched', cattle: [nullSource]});
  });

  it('import old tag on one cow does not block a manual old-tag match on another', () => {
    const imported = cow({tag: '900', old_tags: [{tag: '50', source: 'import'}]});
    const manual = cow({tag: '901', old_tags: [{tag: '50', source: 'weighin'}]});
    expect(matchTagToCattle('50', [imported, manual])).toEqual({status: 'matched', cattle: [manual]});
  });

  it('two active cows sharing a current tag are ambiguous', () => {
    const a = cow({tag: '77'});
    const b = cow({tag: '77'});
    const result = matchTagToCattle('77', [a, b]);
    expect(result.status).toBe('ambiguous');
    expect(result.cattle).toEqual([a, b]);
  });

  it('two active cows sharing a non-import old tag are ambiguous', () => {
    const a = cow({tag: '900', old_tags: [{tag: '50', source: 'manual'}]});
    const b = cow({tag: '901', old_tags: [{tag: '50', source: 'weighin'}]});
    const result = matchTagToCattle('50', [a, b]);
    expect(result.status).toBe('ambiguous');
    expect(result.cattle).toEqual([a, b]);
  });

  it('a cow matching on both current tag and its own old tag is matched once, not ambiguous', () => {
    const both = cow({tag: '50', old_tags: [{tag: '50', source: 'manual'}]});
    expect(matchTagToCattle('50', [both])).toEqual({status: 'matched', cattle: [both]});
  });

  it('duplicate old-tag entries on one cow count as a single row', () => {
    const dup = cow({
      tag: '900',
      old_tags: [
        {tag: '50', source: 'manual'},
        {tag: '50', source: 'weighin'},
      ],
    });
    expect(matchTagToCattle('50', [dup])).toEqual({status: 'matched', cattle: [dup]});
  });

  it('soft-deleted rows never match (current or old tag)', () => {
    const deleted = cow({tag: '123', deleted_at: '2026-01-01T00:00:00Z'});
    expect(matchTagToCattle('123', [deleted])).toEqual({status: 'unmatched', cattle: []});

    const deletedOld = cow({
      tag: '900',
      old_tags: [{tag: '50', source: 'manual'}],
      deleted_at: '2026-01-01T00:00:00Z',
    });
    expect(matchTagToCattle('50', [deletedOld])).toEqual({status: 'unmatched', cattle: []});
  });

  it('outcome-herd rows (processed/deceased/sold) never match', () => {
    expect(matchTagToCattle('123', [cow({tag: '123', herd: 'processed'})])).toEqual({
      status: 'unmatched',
      cattle: [],
    });
    expect(matchTagToCattle('123', [cow({tag: '123', herd: 'deceased'})])).toEqual({
      status: 'unmatched',
      cattle: [],
    });
    expect(matchTagToCattle('123', [cow({tag: '123', herd: 'sold'})])).toEqual({
      status: 'unmatched',
      cattle: [],
    });
  });

  it('all four active herds are eligible', () => {
    for (const herd of ['mommas', 'backgrounders', 'finishers', 'bulls']) {
      const row = cow({tag: '321', herd});
      expect(matchTagToCattle('321', [row])).toEqual({status: 'matched', cattle: [row]});
    }
  });

  it('an inactive duplicate does not make a single active match ambiguous', () => {
    const active = cow({tag: '77'});
    const sold = cow({tag: '77', herd: 'sold'});
    const deleted = cow({tag: '77', deleted_at: '2026-01-01T00:00:00Z'});
    expect(matchTagToCattle('77', [sold, active, deleted])).toEqual({status: 'matched', cattle: [active]});
  });

  it('exact text match: 0123 does not match a cow tagged 123 and vice versa', () => {
    const plain = cow({tag: '123'});
    const padded = cow({tag: '0123'});
    expect(matchTagToCattle('123', [plain, padded])).toEqual({status: 'matched', cattle: [plain]});
    expect(matchTagToCattle('0123', [plain, padded])).toEqual({status: 'matched', cattle: [padded]});
  });

  it('non-digit or empty tag input is unmatched', () => {
    const rows = [cow({tag: '123'})];
    expect(matchTagToCattle('12a', rows)).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle('', rows)).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle(null, rows)).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle(undefined, rows)).toEqual({status: 'unmatched', cattle: []});
  });

  it('tolerates empty, null, or malformed cattleRows input', () => {
    expect(matchTagToCattle('123', [])).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle('123', null)).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle('123', undefined)).toEqual({status: 'unmatched', cattle: []});
    expect(matchTagToCattle('123', [null, undefined, 'junk'])).toEqual({status: 'unmatched', cattle: []});
  });

  it('tolerates malformed old_tags shapes without throwing', () => {
    const rows = [
      cow({tag: '900', old_tags: null}),
      cow({tag: '901', old_tags: 'not-an-array'}),
      cow({tag: '902', old_tags: ['50', null, 50]}),
      cow({tag: '903', old_tags: [{source: 'manual'}]}),
    ];
    expect(matchTagToCattle('50', rows)).toEqual({status: 'unmatched', cattle: []});
  });

  it('numeric old-tag values from jsonb round-trips still exact-match as text', () => {
    const numeric = cow({tag: '900', old_tags: [{tag: 50, source: 'manual'}]});
    expect(matchTagToCattle('50', [numeric])).toEqual({status: 'matched', cattle: [numeric]});
    // but a numeric 123 never matches the zero-padded '0123'
    const numericPlain = cow({tag: '901', old_tags: [{tag: 123, source: 'manual'}]});
    expect(matchTagToCattle('0123', [numericPlain])).toEqual({status: 'unmatched', cattle: []});
  });
});
