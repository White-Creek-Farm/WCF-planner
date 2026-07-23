// ============================================================================
// Worker warm-up helpers (origin safety + IndexedDB probe name)
// ============================================================================
// The warm-up primes the cold-start work measured on CI: the first navigation
// compiles Vite's module graph, and the first IndexedDB open pays the browser's
// IDB subsystem init. Both are one-time per worker. This module holds the parts
// worth unit-testing on their own; the fixture wiring lives in fixtures.js.

// The local TEST app origin. Mirrors playwright.config.js `use.baseURL` — a
// worker-scoped fixture cannot depend on Playwright's test-scoped `baseURL`
// fixture, so the warm-up reads this constant instead. A static guard keeps it
// in sync with the config, and assertLocalTestOrigin still validates it.
export const LOCAL_APP_ORIGIN = 'http://localhost:5173';

// Throwaway IndexedDB name for the warm-up probe. Deliberately NOT the real
// offline-queue DB ('wcf-offline-queue') — opening that at the wrong version
// would corrupt the schema the offline specs depend on. A throwaway DB warms
// the browser IDB code path and creates zero queue records.
export const WARMUP_PROBE_DB = '__wcf_warmup_probe__';

// Hard-refuse any target that is not the local TEST application origin. The
// warm-up must never reach PROD or any non-local host. baseURL is the app
// origin (the dev:test server on localhost/127.0.0.1) — not Supabase — so a
// non-local host means a misconfigured run and we fail closed.
export function assertLocalTestOrigin(baseURL) {
  let url;
  try {
    url = new URL(baseURL || 'http://localhost:5173');
  } catch {
    throw new Error(`warm-up refused: baseURL "${baseURL}" is not a valid URL`);
  }
  const host = url.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(`warm-up refused: origin host "${host}" is not the local TEST application origin`);
  }
  return url;
}
