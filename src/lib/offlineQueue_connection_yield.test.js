// Regression: the cached offline-queue connection must YIELD to an external
// deleteDatabase()/upgrade instead of blocking it. Guards the deadlock behind
// tests/offline_queue_canary.spec.js: the form mounts and getDb() caches a
// long-lived connection; the canary's wipeOfflineQueue() calls
// indexedDB.deleteDatabase(); without a `blocking` handler that closes the
// cached connection, the delete stays blocked and the canary's readQueue()
// indexedDB.open() serializes behind the pending delete and hangs to the test
// timeout. getDb()'s `blocking` handler (offlineQueue.js) makes this
// deterministic. Runs on fake-indexeddb — no app server or TEST database.
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import 'fake-indexeddb/auto';

import {getDb, enqueueSubmission, DB_NAME, _resetDbForTests} from './offlineQueue.js';

function freshIndexedDB() {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  _resetDbForTests();
  await freshIndexedDB();
});
afterEach(() => {
  _resetDbForTests();
});

// deleteDatabase must reach onsuccess (delete completed), not sit on onblocked.
// Bounded so a regression reports 'timeout' instead of hanging the vitest run.
function deleteOutcome(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => done('timeout'), timeoutMs);
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      clearTimeout(t);
      done('deleted');
    };
    req.onerror = () => {
      clearTimeout(t);
      done('error');
    };
  });
}

// A subsequent open (the canary readQueue step) must also resolve.
function openOutcome(timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const t = setTimeout(() => done('timeout'), timeoutMs);
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => {
      clearTimeout(t);
      req.result.close();
      done('opened');
    };
    req.onerror = () => {
      clearTimeout(t);
      done('error');
    };
  });
}

describe('offline queue — cached connection yields to external delete/open', () => {
  it('deleteDatabase completes while the app holds a cached getDb() connection', async () => {
    await enqueueSubmission({
      formKind: 'fuel_supply',
      csid: 'csid-yield-1',
      record: {id: 'a', client_submission_id: 'csid-yield-1'},
    });
    await getDb(); // app holds the connection open, like the mounted form
    expect(await deleteOutcome(3000)).toBe('deleted');
  });

  it('a subsequent indexedDB.open resolves after the wipe (canary readQueue step)', async () => {
    await enqueueSubmission({
      formKind: 'fuel_supply',
      csid: 'csid-yield-2',
      record: {id: 'b', client_submission_id: 'csid-yield-2'},
    });
    await getDb();
    await deleteOutcome(3000); // wipe
    expect(await openOutcome(3000)).toBe('opened'); // read
  });
});
