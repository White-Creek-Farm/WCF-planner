import {describe, it, expect, vi} from 'vitest';
import {runMutation} from './entityMutations.js';

describe('runMutation — success path', () => {
  it('returns {ok: true, data} on successful mutation', async () => {
    const result = await runMutation(() => ({data: {id: '1'}, error: null}));
    expect(result).toEqual({ok: true, data: {id: '1'}});
  });

  it('treats {data: null, error: null} as success (Supabase void-return writes)', async () => {
    const result = await runMutation(() => ({data: null, error: null}));
    expect(result).toEqual({ok: true, data: null});
  });

  it('calls activity callback after successful mutation', async () => {
    const activity = vi.fn();
    await runMutation(() => ({data: {id: '1'}, error: null}), {activity});
    expect(activity).toHaveBeenCalledWith({id: '1'});
  });

  it('does NOT call activity when mutation fails', async () => {
    const activity = vi.fn();
    await runMutation(() => ({data: null, error: {message: 'rls denied'}}), {activity});
    expect(activity).not.toHaveBeenCalled();
  });
});

describe('runMutation — error path', () => {
  it('returns {ok: false, error} on Supabase error', async () => {
    const result = await runMutation(() => ({data: null, error: {message: 'constraint violated'}}));
    expect(result).toEqual({ok: false, error: 'constraint violated'});
  });

  it('returns {ok: false, error} when mutateFn throws', async () => {
    const result = await runMutation(() => {
      throw new Error('network down');
    });
    expect(result).toEqual({ok: false, error: 'network down'});
  });

  it('calls onError callback with the error message', async () => {
    const onError = vi.fn();
    await runMutation(() => ({data: null, error: {message: 'bad input'}}), {onError});
    expect(onError).toHaveBeenCalledWith('bad input');
  });

  it('calls onError when mutateFn throws', async () => {
    const onError = vi.fn();
    await runMutation(
      () => {
        throw new Error('timeout');
      },
      {onError},
    );
    expect(onError).toHaveBeenCalledWith('timeout');
  });
});

describe('runMutation — invalid mutateFn response', () => {
  it('rejects undefined (caller forgot to return the query)', async () => {
    const onError = vi.fn();
    const result = await runMutation(() => undefined, {onError});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must return {data, error}');
    expect(onError).toHaveBeenCalled();
  });

  it('rejects null', async () => {
    const result = await runMutation(() => null);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must return {data, error}');
  });

  it('rejects non-object (string)', async () => {
    const result = await runMutation(() => 'oops');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('must return {data, error}');
  });

  it('does NOT call activity when response is invalid', async () => {
    const activity = vi.fn();
    await runMutation(() => undefined, {activity});
    expect(activity).not.toHaveBeenCalled();
  });
});

describe('runMutation — activity best-effort', () => {
  it('swallows activity failure by default (activityBestEffort=true)', async () => {
    const activity = vi.fn().mockRejectedValue(new Error('rpc failed'));
    const result = await runMutation(() => ({data: {id: '1'}, error: null}), {activity});
    expect(result).toEqual({ok: true, data: {id: '1'}});
  });

  it('fails when activity throws and activityBestEffort=false', async () => {
    const activity = vi.fn().mockRejectedValue(new Error('rpc failed'));
    const onError = vi.fn();
    const result = await runMutation(() => ({data: {id: '1'}, error: null}), {
      activity,
      activityBestEffort: false,
      onError,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Activity logging failed');
    expect(onError).toHaveBeenCalled();
  });
});

describe('runMutation — edge cases', () => {
  it('works with no options object', async () => {
    const result = await runMutation(() => ({data: 42, error: null}));
    expect(result).toEqual({ok: true, data: 42});
  });

  it('passes mutation data to activity callback', async () => {
    const activity = vi.fn();
    await runMutation(() => ({data: {id: 'x', name: 'test'}, error: null}), {activity});
    expect(activity).toHaveBeenCalledWith({id: 'x', name: 'test'});
  });
});
