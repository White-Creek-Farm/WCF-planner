// Pasture Map CP5 offline helpers. IndexedDB ownership stays centralized in
// offlineQueue.js; this module reuses its submissions store with form_kind
// 'pasture_map'. Vector outlines are cached in localStorage so the map can
// render the last known geometry without changing the shared IDB schema.
import {
  discardSubmission,
  enqueueSubmission,
  listQueued,
  listStuck,
  markFailed,
  markStuckNow,
  markSynced,
  markSyncing,
  recoverStaleSyncing,
  retrySubmission,
} from './offlineQueue.js';
import {
  clearPastureRotation,
  createLandArea,
  createLandAreaTrack,
  createTempLandArea,
  recordPastureMove,
  updatePasturePlannedMoveStatus,
  upsertPastureRotation,
} from './pastureMapApi.js';

export const PASTURE_OFFLINE_FORM_KIND = 'pasture_map';
export const PASTURE_VECTOR_CACHE_KEY = 'wcf-pasture-map-vector-cache-v1';

function storageAvailable() {
  return typeof window !== 'undefined' && window.localStorage;
}

export function cachePastureSnapshot(snapshot) {
  if (!storageAvailable() || !snapshot) return false;
  try {
    window.localStorage.setItem(
      PASTURE_VECTOR_CACHE_KEY,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        areas: snapshot.areas || [],
        moves: snapshot.moves || [],
        plans: snapshot.plans || [],
        rotations: snapshot.rotations || [],
        restReport: snapshot.restReport || {areas: [], counts: {}},
        stockingReport: snapshot.stockingReport || {areas: []},
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadPastureSnapshot() {
  if (!storageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(PASTURE_VECTOR_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.areas)) return null;
    return {
      savedAt: parsed.savedAt || null,
      areas: parsed.areas || [],
      moves: parsed.moves || [],
      plans: parsed.plans || [],
      rotations: parsed.rotations || [],
      restReport: parsed.restReport || {areas: [], counts: {}},
      stockingReport: parsed.stockingReport || {areas: []},
    };
  } catch {
    return null;
  }
}

export function classifyPastureOfflineError(err) {
  const cause = (err && err.cause) || err || {};
  const msg = `${(err && err.message) || ''} ${(cause && cause.message) || ''}`;
  if (err instanceof TypeError || cause instanceof TypeError) return 'transient';
  if (/failed to fetch|network ?error|load failed|offline/i.test(msg)) return 'transient';

  const status = cause.status != null ? Number(cause.status) : err && err.status != null ? Number(err.status) : null;
  const code = cause.code != null ? String(cause.code) : err && err.code != null ? String(err.code) : '';
  if (status != null) {
    if (status >= 500 || status === 401 || status === 403) return 'transient';
    if (status >= 400 && status < 500) {
      if (/^PGRST/i.test(code) || /^23/.test(code) || /^22/.test(code) || code === 'P0001') return 'schema';
      return 'transient';
    }
  }
  if (/^PGRST/i.test(code) || /^23/.test(code) || /^22/.test(code) || code === 'P0001') return 'schema';
  return 'transient';
}

export async function enqueuePastureOperation({id, op, payload}) {
  if (!id || !op || !payload) throw new Error('enqueuePastureOperation: id, op, and payload are required');
  return await enqueueSubmission({
    formKind: PASTURE_OFFLINE_FORM_KIND,
    csid: id,
    payload,
    record: {op, payload},
  });
}

async function replayPastureOperation(row) {
  if (!row || !row.record || !row.record.op) throw new Error('pasture queue row missing operation');
  if (row.record.op === 'record_move') {
    const res = await recordPastureMove(row.record.payload);
    if (row.record.payload.activePlanId && res && res.id) {
      await updatePasturePlannedMoveStatus({
        planId: row.record.payload.activePlanId,
        status: 'completed',
        completedMoveId: res.id,
      });
    }
    return res;
  }
  if (row.record.op === 'create_area') return await createLandArea(row.record.payload);
  if (row.record.op === 'create_temp_area') return await createTempLandArea(row.record.payload);
  if (row.record.op === 'create_track') return await createLandAreaTrack(row.record.payload);
  if (row.record.op === 'upsert_rotation') return await upsertPastureRotation(row.record.payload);
  if (row.record.op === 'clear_rotation') return await clearPastureRotation(row.record.payload);
  throw new Error(`unknown pasture queue operation ${row.record.op}`);
}

export async function syncPastureQueue() {
  await recoverStaleSyncing(PASTURE_OFFLINE_FORM_KIND);
  const queued = await listQueued(PASTURE_OFFLINE_FORM_KIND);
  for (const row of queued) {
    await markSyncing(row.csid);
    try {
      await replayPastureOperation(row);
      await markSynced(row.csid);
    } catch (e) {
      if (classifyPastureOfflineError(e) === 'schema') await markStuckNow(row.csid, e.message || String(e));
      else await markFailed(row.csid, e.message || String(e));
    }
  }
  return await getPastureQueueState();
}

export async function getPastureQueueState() {
  const [queued, stuck] = await Promise.all([
    listQueued(PASTURE_OFFLINE_FORM_KIND),
    listStuck(PASTURE_OFFLINE_FORM_KIND),
  ]);
  return {queued, stuck, queuedCount: queued.length, stuckCount: stuck.length};
}

export async function retryPastureOperation(csid) {
  await retrySubmission(csid);
  return await syncPastureQueue();
}

export async function discardPastureOperation(csid) {
  await discardSubmission(csid);
  return await getPastureQueueState();
}
