import {describe, expect, it} from 'vitest';
import {WARMUP_PROBE_DB, assertLocalTestOrigin} from './warmup.js';

describe('assertLocalTestOrigin', () => {
  it('accepts the local TEST app origins', () => {
    expect(assertLocalTestOrigin('http://localhost:5173').hostname).toBe('localhost');
    expect(assertLocalTestOrigin('http://127.0.0.1:5173').hostname).toBe('127.0.0.1');
    expect(assertLocalTestOrigin(undefined).hostname).toBe('localhost'); // defaults local
  });
  it('hard-refuses a non-local host (never PROD or any remote origin)', () => {
    expect(() => assertLocalTestOrigin('https://wcfplanner.com')).toThrow(/not the local TEST/);
    expect(() => assertLocalTestOrigin('https://pzfujbjtayhkdlxiblwe.supabase.co')).toThrow(/not the local TEST/);
    expect(() => assertLocalTestOrigin('http://example.com:5173')).toThrow(/not the local TEST/);
  });
  it('refuses a malformed baseURL', () => {
    expect(() => assertLocalTestOrigin('not a url')).toThrow(/not a valid URL/);
  });
});

describe('WARMUP_PROBE_DB', () => {
  it('is a throwaway name, never the real offline-queue DB', () => {
    expect(WARMUP_PROBE_DB).toBe('__wcf_warmup_probe__');
    expect(WARMUP_PROBE_DB).not.toBe('wcf-offline-queue');
  });
});
