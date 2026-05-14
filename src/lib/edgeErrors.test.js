import {describe, it, expect} from 'vitest';
import {unwrapEdgeFunctionError} from './edgeErrors.js';

// Build a fake Response-shaped object that mirrors what the Supabase JS
// SDK puts on err.context for a non-2xx Edge Function response.
function fakeContext(body) {
  return {
    text: async () => body,
  };
}

describe('unwrapEdgeFunctionError', () => {
  it('returns the JSON.error string when context body parses cleanly', async () => {
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: fakeContext(JSON.stringify({error: 'User already registered'})),
    };
    expect(await unwrapEdgeFunctionError(err)).toBe('User already registered');
  });

  it('falls back to JSON.message when error is absent', async () => {
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: fakeContext(JSON.stringify({message: 'Email rate limit exceeded'})),
    };
    expect(await unwrapEdgeFunctionError(err)).toBe('Email rate limit exceeded');
  });

  it('returns the raw body when the response is not JSON', async () => {
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: fakeContext('Service Unavailable'),
    };
    expect(await unwrapEdgeFunctionError(err)).toBe('Service Unavailable');
  });

  it('falls through to err.message when JSON.error is empty', async () => {
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: fakeContext(JSON.stringify({error: ''})),
    };
    // Empty JSON.error is not actionable AND raw body "{"error":""}" is
    // not user-facing-useful either; fall through to err.message rather
    // than dumping the JSON literal on the operator.
    expect(await unwrapEdgeFunctionError(err)).toBe('Edge Function returned a non-2xx status code');
  });

  it('returns err.message when context is missing', async () => {
    const err = {message: 'Network error'};
    expect(await unwrapEdgeFunctionError(err)).toBe('Network error');
  });

  it('returns "Unknown error" when err is null/undefined', async () => {
    expect(await unwrapEdgeFunctionError(null)).toBe('Unknown error');
    expect(await unwrapEdgeFunctionError(undefined)).toBe('Unknown error');
  });

  it('returns err.message when context.text throws', async () => {
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: {
        text: async () => {
          throw new Error('body already consumed');
        },
      },
    };
    expect(await unwrapEdgeFunctionError(err)).toBe('Edge Function returned a non-2xx status code');
  });

  it('returns "Unknown error" when neither context nor message is useful', async () => {
    const err = {context: fakeContext('')};
    expect(await unwrapEdgeFunctionError(err)).toBe('Unknown error');
  });

  it('handles non-text context shapes by falling back to message', async () => {
    // Defensive: some shims pass an object with no .text() method.
    const err = {message: 'fallback', context: {status: 500}};
    expect(await unwrapEdgeFunctionError(err)).toBe('fallback');
  });

  it('returns the JSON.error even when err.message is also set', async () => {
    // Locks the resolution order: context body wins over the generic
    // non-2xx message that Supabase JS attaches.
    const err = {
      message: 'Edge Function returned a non-2xx status code',
      context: fakeContext(JSON.stringify({error: 'forbidden'})),
    };
    expect(await unwrapEdgeFunctionError(err)).toBe('forbidden');
  });
});
