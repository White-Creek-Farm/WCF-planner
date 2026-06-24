// Pasture Map offline imagery (CP-F).
// ----------------------------------------------------------------------------
// Field GPS work happens where there is often NO cell signal, so V1 supports a
// one-tap download of a FIXED farm-area satellite cache used when offline.
//
// Provider: USDA/USGS NAIP. NAIP is PUBLIC DOMAIN (US-government work) and is the
// only satellite source we may legally self-cache — Esri World Imagery and Mapbox
// both forbid storing tiles. So the online basemap stays Esri (high-res Maxar) and
// the OFFLINE cache is NAIP. There is NO credential/token gate (NAIP is public);
// the only failure mode is the network being unavailable while downloading, which
// fails closed with a clear status the Field surfaces.
//
// NAIP is served from an ArcGIS ImageServer (exportImage), not an XYZ tile cache,
// so each XYZ tile is requested by its EPSG:3857 bbox. Tiles are stored in their
// OWN IndexedDB (separate from the shared offline-queue DB, which is version-pinned
// by a static guard) so large image blobs never touch that schema.
// ----------------------------------------------------------------------------
import {openDB} from 'idb';

export const NAIP_IMAGESERVER = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer';
export const IMAGERY_DB_NAME = 'wcf-pasture-imagery';
export const IMAGERY_DB_VERSION = 1;
export const IMAGERY_STATUS_KEY = 'wcf-pasture-imagery-status-v1';
// Days after which a cached farm download is considered stale (NAIP refreshes on a
// multi-year cadence, but flag a re-download prompt so the cache does not rot).
export const IMAGERY_STALE_DAYS = 180;

// Fixed farm area (a few miles around the WCF center) + the zoom band cached for
// field work. Kept deliberately small so the download is bounded.
const FARM_BBOX = {west: -86.4769, south: 30.8118, east: -86.3968, north: 30.8717};
const FARM_ZOOMS = [15, 16, 17];
const TILE_SIZE = 256;
const WEB_MERCATOR_ORIGIN = 20037508.342789244;

function dbPromise() {
  // Uses the idb wrapper exclusively (no raw indexedDB global, per the storage
  // boundary guard). If IndexedDB is unavailable (e.g. SSR/Node), openDB throws or
  // rejects and every caller falls back gracefully (null db / caught rejection).
  try {
    return openDB(IMAGERY_DB_NAME, IMAGERY_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      },
    });
  } catch {
    return null;
  }
}

export function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

// EPSG:3857 bounds [minX, minY, maxX, maxY] of an XYZ tile.
export function tile3857Bounds(z, x, y) {
  const size = (2 * WEB_MERCATOR_ORIGIN) / Math.pow(2, z);
  const minX = -WEB_MERCATOR_ORIGIN + x * size;
  const maxY = WEB_MERCATOR_ORIGIN - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

// NAIP exportImage URL for one XYZ tile.
export function naipTileUrl(z, x, y) {
  const [minX, minY, maxX, maxY] = tile3857Bounds(z, x, y);
  const params = new URLSearchParams({
    bbox: `${minX},${minY},${maxX},${maxY}`,
    bboxSR: '3857',
    imageSR: '3857',
    size: `${TILE_SIZE},${TILE_SIZE}`,
    format: 'jpgpng',
    f: 'image',
  });
  return `${NAIP_IMAGESERVER}/exportImage?${params.toString()}`;
}

function lngLatToTile(lng, lat, z) {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {x, y};
}

// The full list of {z,x,y} tiles covering the fixed farm bbox across FARM_ZOOMS.
export function farmTileList() {
  const tiles = [];
  for (const z of FARM_ZOOMS) {
    const tl = lngLatToTile(FARM_BBOX.west, FARM_BBOX.north, z);
    const br = lngLatToTile(FARM_BBOX.east, FARM_BBOX.south, z);
    for (let x = tl.x; x <= br.x; x++) {
      for (let y = tl.y; y <= br.y; y++) tiles.push({z, x, y});
    }
  }
  return tiles;
}

export async function getCachedTile(z, x, y) {
  const db = dbPromise();
  if (!db) return null;
  try {
    return (await (await db).get('tiles', tileKey(z, x, y))) || null;
  } catch {
    return null;
  }
}

// Returns true only if the tile was actually written, so the download cannot
// claim a clean save when a cache write (e.g. quota) fails.
async function putCachedTile(z, x, y, blob) {
  const db = dbPromise();
  if (!db) return false;
  try {
    await (await db).put('tiles', blob, tileKey(z, x, y));
    return true;
  } catch {
    return false;
  }
}

function readStatus() {
  if (typeof localStorage === 'undefined') return {state: 'missing'};
  try {
    const raw = localStorage.getItem(IMAGERY_STATUS_KEY);
    return raw ? JSON.parse(raw) : {state: 'missing'};
  } catch {
    return {state: 'missing'};
  }
}

function writeStatus(status) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(IMAGERY_STATUS_KEY, JSON.stringify(status));
  } catch {
    /* ignore */
  }
}

// { state: 'missing'|'downloading'|'downloaded'|'stale'|'failed', count, total, savedAt }
export function getOfflineImageryStatus() {
  const status = readStatus();
  if (status.state === 'downloaded' && status.savedAt) {
    const ageDays = (nowMs() - new Date(status.savedAt).getTime()) / 86400000;
    if (ageDays > IMAGERY_STALE_DAYS) return {...status, state: 'stale'};
  }
  return status;
}

function nowMs() {
  // Wrapped so callers/tests can reason about it; Date.now is fine in the browser.
  return Date.now();
}

// Download + cache the fixed farm area's NAIP tiles. Fails CLOSED: any fetch error
// leaves a 'failed' status (with how far it got) and the Field surfaces it. onProgress
// receives {done,total} after each tile.
export async function downloadFarmImagery(onProgress) {
  const tiles = farmTileList();
  const total = tiles.length;
  writeStatus({state: 'downloading', count: 0, total});
  let done = 0;
  let failed = 0;
  for (const t of tiles) {
    try {
      const res = await fetch(naipTileUrl(t.z, t.x, t.y), {mode: 'cors'});
      // A tile counts as cached ONLY if BOTH the fetch and the cache write succeed.
      if (res.ok && (await putCachedTile(t.z, t.x, t.y, await res.blob()))) {
        done += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
    if (onProgress) onProgress({done, total});
  }
  // Only a COMPLETE cache (every tile fetched AND written) reports a clean save.
  // Any fetch/write failure surfaces 'partial' (warning) or 'failed' -- never a
  // silent 'downloaded'.
  let state;
  if (done === 0) state = 'failed';
  else if (failed > 0 || done < total) state = 'partial';
  else state = 'downloaded';
  const status = {state, count: done, total, failed, savedAt: isoNow()};
  writeStatus(status);
  return status;
}

function isoNow() {
  return new Date(nowMs()).toISOString();
}

export async function clearOfflineImagery() {
  const db = dbPromise();
  if (db) {
    try {
      await (await db).clear('tiles');
    } catch {
      /* ignore */
    }
  }
  writeStatus({state: 'missing'});
}
