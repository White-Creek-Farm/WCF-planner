// Shared mutation helper for WCF entity writes.
//
// Standardizes: run mutation → check error → optionally record activity
// → return normalized result. Views keep their domain logic (what table,
// what fields, what query shape); the helper owns the error/activity
// contract.
//
// NON-TRANSACTIONAL: this helper runs the mutation and activity as two
// separate async calls. If the mutation succeeds but activity logging
// fails, the data change is already committed — it cannot be rolled
// back from here. For audit-grade atomicity (e.g. delete + activity in
// one transaction), use a server-side SECDEF RPC instead.
//
// Usage:
//   const result = await runMutation(mutateFn, { activity, onError });
//
//   mutateFn — async () => supabase response ({data, error}).
//              The helper does NOT know about tables, upsert vs insert,
//              or business rules. The caller builds the query.
//              Must return an object with {data, error} shape. Returning
//              undefined/null/non-object is treated as a caller bug and
//              fails the mutation.
//
//   activity — optional. If provided AND the mutation succeeds, records
//              an activity event via the supplied function. If the
//              activity call itself fails, behavior depends on
//              activityBestEffort (default true = swallow, false = fail).
//
//   onError  — optional. Receives the Supabase error message string.
//              Typical use: setNotice({kind: 'error', message}).
//
// Returns:
//   { ok: true, data }          on success
//   { ok: false, error: '...' } on mutation failure
//
// The helper never swallows mutation errors. It never records activity
// when the mutation failed. It never hides table-specific logic.

import {recordStatusChange, recordFieldChange, recordActivityEvent} from './activityApi.js';

export {recordStatusChange, recordFieldChange, recordActivityEvent};

export async function runMutation(mutateFn, {activity, activityBestEffort = true, onError} = {}) {
  let resp;
  try {
    resp = await mutateFn();
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (typeof onError === 'function') onError(msg);
    return {ok: false, error: msg};
  }

  if (resp == null || typeof resp !== 'object') {
    const msg = 'runMutation: mutateFn must return {data, error}, got ' + typeof resp;
    if (typeof onError === 'function') onError(msg);
    return {ok: false, error: msg};
  }

  const {data, error} = resp;
  if (error) {
    const msg = error.message || String(error);
    if (typeof onError === 'function') onError(msg);
    return {ok: false, error: msg};
  }

  if (typeof activity === 'function') {
    try {
      await activity(data);
    } catch (e) {
      if (!activityBestEffort) {
        const msg = 'Activity logging failed: ' + ((e && e.message) || String(e));
        if (typeof onError === 'function') onError(msg);
        return {ok: false, error: msg};
      }
    }
  }

  return {ok: true, data};
}
