import {describe, it, expect, vi} from 'vitest';
import {
  generateCattleLogEntryId,
  submitCattleLogEntry,
  editCattleLogEntry,
  deleteCattleLogEntry,
  setCattleLogIssue,
  listCattleLogEntries,
  loadCattleLogMentionableProfiles,
  classifyCattleLogError,
} from './cattleLogApi.js';

// Supabase-shaped mock: capture rpc(name, params) calls and return a fixed
// {data, error} payload. Mirrors how commentsApi tests its thin wrappers.
function makeSb(result = {data: null, error: null}) {
  const rpc = vi.fn(async () => result);
  return {sb: {rpc}, rpc};
}

describe('generateCattleLogEntryId', () => {
  it("matches 'cl-' + base36 timestamp + '-' + base36 random", () => {
    const id = generateCattleLogEntryId();
    expect(id).toMatch(/^cl-[0-9a-z]+-[0-9a-z]{8}$/);
  });

  it("never starts with the mirror prefix 'clog-'", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCattleLogEntryId().startsWith('clog-')).toBe(false);
    }
  });

  it("never contains '--' (mirror-id separator)", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateCattleLogEntryId()).not.toContain('--');
    }
  });

  it('produces unique ids across calls', () => {
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(generateCattleLogEntryId());
    expect(ids.size).toBe(200);
  });

  it('survives a worst-case Math.random of 0 (random segment still 8 chars)', () => {
    const spy = vi.spyOn(Math, 'random');
    // First call returns 0 ('0'.toString(36) -> '0', slice(2) -> ''), the
    // loop must keep going until 8 chars accumulate.
    let n = 0;
    spy.mockImplementation(() => (n++ === 0 ? 0 : 0.123456789));
    try {
      expect(generateCattleLogEntryId()).toMatch(/^cl-[0-9a-z]+-[0-9a-z]{8}$/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('submitCattleLogEntry', () => {
  it('calls submit_cattle_log_entry with full param mapping', async () => {
    const summary = {
      id: 'cl-x-y',
      created_at: '2026-06-12T10:00:00Z',
      is_issue: true,
      unresolved_tags: [],
      matched: [],
      replayed: false,
    };
    const {sb, rpc} = makeSb({data: summary, error: null});
    const out = await submitCattleLogEntry(sb, {
      id: 'cl-x-y',
      body: 'Cow #123 limping',
      mentions: ['uuid-1'],
      attachments: [
        {
          path: 'cattle.log/cattle-log/cl-x-y/0-a.jpg',
          name: 'a.jpg',
          mime: 'image/jpeg',
          is_image: true,
          captured_at: 't',
        },
      ],
      isIssue: true,
      calfNotes: {456: {calf_herd: 'mommas'}},
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('submit_cattle_log_entry', {
      p_id: 'cl-x-y',
      p_body: 'Cow #123 limping',
      p_mentions: ['uuid-1'],
      p_attachments: [
        {
          path: 'cattle.log/cattle-log/cl-x-y/0-a.jpg',
          name: 'a.jpg',
          mime: 'image/jpeg',
          is_image: true,
          captured_at: 't',
        },
      ],
      p_is_issue: true,
      p_calf_notes: {456: {calf_herd: 'mommas'}},
    });
    expect(out).toEqual(summary);
  });

  it('defaults mentions/attachments/isIssue/calfNotes', async () => {
    const {sb, rpc} = makeSb({data: {id: 'cl-a-b'}, error: null});
    await submitCattleLogEntry(sb, {id: 'cl-a-b', body: 'note body'});
    expect(rpc).toHaveBeenCalledWith('submit_cattle_log_entry', {
      p_id: 'cl-a-b',
      p_body: 'note body',
      p_mentions: [],
      p_attachments: [],
      p_is_issue: true,
      p_calf_notes: {},
    });
  });

  it('throws prefixed error on RPC error', async () => {
    const {sb} = makeSb({data: null, error: {message: 'CATTLE_LOG_VALIDATION: body too short'}});
    await expect(submitCattleLogEntry(sb, {id: 'cl-a-b', body: 'hi'})).rejects.toThrow(
      /submitCattleLogEntry: CATTLE_LOG_VALIDATION: body too short/,
    );
  });

  it('throws when sb is missing', async () => {
    await expect(submitCattleLogEntry(null, {id: 'cl-a-b', body: 'note'})).rejects.toThrow(
      /submitCattleLogEntry: sb required/,
    );
  });
});

describe('editCattleLogEntry', () => {
  it('calls edit_cattle_log_entry with full param mapping (no p_is_issue)', async () => {
    const {sb, rpc} = makeSb({data: {id: 'cl-a-b'}, error: null});
    await editCattleLogEntry(sb, {
      id: 'cl-a-b',
      body: 'edited body #77',
      mentions: ['uuid-2'],
      attachments: [],
      calfNotes: {77: {calf_herd: 'finishers', calf_sex: 'steer'}},
    });
    expect(rpc).toHaveBeenCalledWith('edit_cattle_log_entry', {
      p_id: 'cl-a-b',
      p_body: 'edited body #77',
      p_mentions: ['uuid-2'],
      p_attachments: [],
      p_calf_notes: {77: {calf_herd: 'finishers', calf_sex: 'steer'}},
    });
  });

  it('defaults mentions/attachments/calfNotes', async () => {
    const {sb, rpc} = makeSb({data: null, error: null});
    await editCattleLogEntry(sb, {id: 'cl-a-b', body: 'edited'});
    expect(rpc).toHaveBeenCalledWith('edit_cattle_log_entry', {
      p_id: 'cl-a-b',
      p_body: 'edited',
      p_mentions: [],
      p_attachments: [],
      p_calf_notes: {},
    });
  });

  it('passes mentions: null through as p_mentions null (preserve existing; no notifications)', async () => {
    const {sb, rpc} = makeSb({data: null, error: null});
    await editCattleLogEntry(sb, {id: 'cl-a-b', body: 'edited', mentions: null});
    expect(rpc.mock.calls[0][1].p_mentions).toBeNull();
  });

  it('still clears mentions with an explicit empty array', async () => {
    const {sb, rpc} = makeSb({data: null, error: null});
    await editCattleLogEntry(sb, {id: 'cl-a-b', body: 'edited', mentions: []});
    expect(rpc.mock.calls[0][1].p_mentions).toEqual([]);
  });

  it('throws prefixed error on RPC error', async () => {
    const {sb} = makeSb({data: null, error: {message: 'CATTLE_LOG_AMBIGUOUS_TAG: 123'}});
    await expect(editCattleLogEntry(sb, {id: 'cl-a-b', body: 'edited #123'})).rejects.toThrow(
      /editCattleLogEntry: CATTLE_LOG_AMBIGUOUS_TAG: 123/,
    );
  });

  it('throws when sb is missing', async () => {
    await expect(editCattleLogEntry(null, {id: 'cl-a-b', body: 'edited'})).rejects.toThrow(
      /editCattleLogEntry: sb required/,
    );
  });
});

describe('deleteCattleLogEntry', () => {
  it('calls delete_cattle_log_entry with p_id', async () => {
    const {sb, rpc} = makeSb({data: {id: 'cl-a-b'}, error: null});
    const out = await deleteCattleLogEntry(sb, 'cl-a-b');
    expect(rpc).toHaveBeenCalledWith('delete_cattle_log_entry', {p_id: 'cl-a-b'});
    expect(out).toEqual({id: 'cl-a-b'});
  });

  it('throws prefixed error on RPC error', async () => {
    const {sb} = makeSb({data: null, error: {message: 'CATTLE_LOG_VALIDATION: not allowed'}});
    await expect(deleteCattleLogEntry(sb, 'cl-a-b')).rejects.toThrow(
      /deleteCattleLogEntry: CATTLE_LOG_VALIDATION: not allowed/,
    );
  });

  it('throws when sb is missing', async () => {
    await expect(deleteCattleLogEntry(null, 'cl-a-b')).rejects.toThrow(/deleteCattleLogEntry: sb required/);
  });
});

describe('setCattleLogIssue', () => {
  it('calls set_cattle_log_issue with p_id and p_is_issue', async () => {
    const {sb, rpc} = makeSb({data: {id: 'cl-a-b', is_issue: false}, error: null});
    await setCattleLogIssue(sb, 'cl-a-b', false);
    expect(rpc).toHaveBeenCalledWith('set_cattle_log_issue', {p_id: 'cl-a-b', p_is_issue: false});
  });

  it('coerces truthy/falsy isIssue to boolean', async () => {
    const {sb, rpc} = makeSb({data: null, error: null});
    await setCattleLogIssue(sb, 'cl-a-b', 1);
    expect(rpc).toHaveBeenLastCalledWith('set_cattle_log_issue', {p_id: 'cl-a-b', p_is_issue: true});
    await setCattleLogIssue(sb, 'cl-a-b', undefined);
    expect(rpc).toHaveBeenLastCalledWith('set_cattle_log_issue', {p_id: 'cl-a-b', p_is_issue: false});
  });

  it('throws prefixed error on RPC error', async () => {
    const {sb} = makeSb({data: null, error: {message: 'CATTLE_LOG_VALIDATION: management/admin only'}});
    await expect(setCattleLogIssue(sb, 'cl-a-b', true)).rejects.toThrow(/setCattleLogIssue: CATTLE_LOG_VALIDATION/);
  });

  it('throws when sb is missing', async () => {
    await expect(setCattleLogIssue(null, 'cl-a-b', true)).rejects.toThrow(/setCattleLogIssue: sb required/);
  });
});

describe('listCattleLogEntries', () => {
  it('applies contract defaults: issues filter, no search, limit 200, no keyset', async () => {
    const {sb, rpc} = makeSb({data: {entries: [], has_more: false}, error: null});
    await listCattleLogEntries(sb);
    expect(rpc).toHaveBeenCalledWith('list_cattle_log_entries', {
      p_filter: 'issues',
      p_search: null,
      p_limit: 200,
      p_before_created_at: null,
      p_before_id: null,
    });
  });

  it('passes filter/search/limit and camelCase before keyset', async () => {
    const {sb, rpc} = makeSb({data: {entries: [], has_more: false}, error: null});
    await listCattleLogEntries(sb, {
      filter: 'all',
      search: '#123',
      limit: 50,
      before: {createdAt: '2026-06-01T00:00:00Z', id: 'cl-old-1'},
    });
    expect(rpc).toHaveBeenCalledWith('list_cattle_log_entries', {
      p_filter: 'all',
      p_search: '#123',
      p_limit: 50,
      p_before_created_at: '2026-06-01T00:00:00Z',
      p_before_id: 'cl-old-1',
    });
  });

  it('accepts a raw entry row (snake_case created_at) as before', async () => {
    const {sb, rpc} = makeSb({data: {entries: [], has_more: false}, error: null});
    await listCattleLogEntries(sb, {before: {created_at: '2026-06-01T00:00:00Z', id: 'cl-old-2'}});
    expect(rpc.mock.calls[0][1].p_before_created_at).toBe('2026-06-01T00:00:00Z');
    expect(rpc.mock.calls[0][1].p_before_id).toBe('cl-old-2');
  });

  it('normalizes empty-string search to null', async () => {
    const {sb, rpc} = makeSb({data: {entries: [], has_more: false}, error: null});
    await listCattleLogEntries(sb, {search: ''});
    expect(rpc.mock.calls[0][1].p_search).toBe(null);
  });

  it('returns the RPC payload, with an empty fallback when data is null', async () => {
    const payload = {entries: [{id: 'cl-a-b', body: 'note', tags: []}], has_more: true};
    const {sb} = makeSb({data: payload, error: null});
    expect(await listCattleLogEntries(sb)).toEqual(payload);
    const {sb: sb2} = makeSb({data: null, error: null});
    expect(await listCattleLogEntries(sb2)).toEqual({entries: [], has_more: false});
  });

  it('throws prefixed error on RPC error (fail-closed loading)', async () => {
    const {sb} = makeSb({data: null, error: {message: 'permission denied'}});
    await expect(listCattleLogEntries(sb)).rejects.toThrow(/listCattleLogEntries: permission denied/);
  });

  it('throws when sb is missing', async () => {
    await expect(listCattleLogEntries(null)).rejects.toThrow(/listCattleLogEntries: sb required/);
  });
});

describe('loadCattleLogMentionableProfiles', () => {
  it('calls list_cattle_log_mentionable_profiles with no params', async () => {
    const profiles = [{id: 'uuid-1', full_name: 'Ronnie Jones'}];
    const {sb, rpc} = makeSb({data: profiles, error: null});
    expect(await loadCattleLogMentionableProfiles(sb)).toEqual(profiles);
    expect(rpc).toHaveBeenCalledWith('list_cattle_log_mentionable_profiles');
  });

  it('swallows errors and returns [] (mention picker degrades gracefully)', async () => {
    const {sb} = makeSb({data: null, error: {message: 'boom'}});
    expect(await loadCattleLogMentionableProfiles(sb)).toEqual([]);
  });

  it('returns [] when sb is missing or data is null', async () => {
    expect(await loadCattleLogMentionableProfiles(null)).toEqual([]);
    const {sb} = makeSb({data: null, error: null});
    expect(await loadCattleLogMentionableProfiles(sb)).toEqual([]);
  });
});

describe('classifyCattleLogError', () => {
  it('classifies CATTLE_LOG_AMBIGUOUS_TAG as ambiguous_tag', () => {
    expect(classifyCattleLogError({message: 'CATTLE_LOG_AMBIGUOUS_TAG: 123'})).toBe('ambiguous_tag');
    expect(classifyCattleLogError(new Error('CATTLE_LOG_AMBIGUOUS_TAG: 0045'))).toBe('ambiguous_tag');
  });

  it('classifies CATTLE_LOG_MENTION_INVALID as mention_invalid', () => {
    expect(classifyCattleLogError({message: 'CATTLE_LOG_MENTION_INVALID: inactive profile'})).toBe('mention_invalid');
  });

  it('classifies CATTLE_LOG_VALIDATION as validation (incl. mirror guard)', () => {
    expect(classifyCattleLogError({message: 'CATTLE_LOG_VALIDATION: body too short'})).toBe('validation');
    expect(
      classifyCattleLogError(new Error('CATTLE_LOG_VALIDATION: cattle log mirrors are managed by the Cattle Log RPCs')),
    ).toBe('validation');
  });

  it('matches wrapped wrapper errors (substring, not prefix)', () => {
    expect(classifyCattleLogError(new Error('submitCattleLogEntry: CATTLE_LOG_AMBIGUOUS_TAG: 123'))).toBe(
      'ambiguous_tag',
    );
    expect(classifyCattleLogError(new Error('editCattleLogEntry: CATTLE_LOG_MENTION_INVALID: self-mention'))).toBe(
      'mention_invalid',
    );
    expect(classifyCattleLogError(new Error('submitCattleLogEntry: CATTLE_LOG_VALIDATION: too many attachments'))).toBe(
      'validation',
    );
  });

  it('reads supabase error details/hint when message lacks the prefix', () => {
    expect(
      classifyCattleLogError({message: 'invalid input', details: 'CATTLE_LOG_VALIDATION: bad attachment path'}),
    ).toBe('validation');
    expect(classifyCattleLogError({message: '', hint: 'CATTLE_LOG_AMBIGUOUS_TAG: 9'})).toBe('ambiguous_tag');
  });

  it('classifies network/fetch/abort/timeout/5xx as transient', () => {
    expect(classifyCattleLogError(new TypeError('Failed to fetch'))).toBe('transient');
    expect(classifyCattleLogError({message: 'NetworkError when attempting to fetch resource.'})).toBe('transient');
    expect(classifyCattleLogError({message: 'The operation was aborted.'})).toBe('transient');
    expect(classifyCattleLogError({message: 'timeout of 30000ms exceeded'})).toBe('transient');
    expect(classifyCattleLogError({message: '500 Internal Server Error', code: '500'})).toBe('transient');
    expect(classifyCattleLogError({message: '503 Service Unavailable'})).toBe('transient');
  });

  it('classifies unknown shapes and empty errors as transient (never silently drop)', () => {
    expect(classifyCattleLogError(null)).toBe('transient');
    expect(classifyCattleLogError(undefined)).toBe('transient');
    expect(classifyCattleLogError({})).toBe('transient');
    expect(classifyCattleLogError('some random string')).toBe('transient');
    expect(classifyCattleLogError({code: 'PGRST301'})).toBe('transient');
  });

  it('classifies plain string errors carrying the prefix', () => {
    expect(classifyCattleLogError('CATTLE_LOG_VALIDATION: nope')).toBe('validation');
  });
});
