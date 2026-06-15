// ============================================================================
// src/lib/pastureKml.js  —  Pasture Map CP1
// ----------------------------------------------------------------------------
// Client-side OnX-KML parsing for the Pasture Map import flow. Converts a raw
// KML string (OnX Web-Map "Export" of Area Shapes + Lines) into the placemark
// array that import_land_area_batch (mig 116) expects:
//   { external_id, name, notes, color, geometry_type, geometry }
//
// Verified against a real OnX export (10 placemarks: 4 Polygons, 6 LineStrings,
// no folders). Findings baked in here:
//  - Every markup carries a stable UUID in ExtendedData (<Data name="id">),
//    surfaced by togeojson as properties.id -> used as external_id for
//    idempotent re-import.
//  - notes (properties.notes) hold free-text date + acreage ("6-3-22\n11.3 ac")
//    -> parseAcreageNote() extracts the acreage for an import cross-check.
//  - OnX LineStrings are area boundaries traced as OPEN paths and carry a Z
//    (elevation) ordinate; Polygons are 2D closed rings. We force everything to
//    2D (strip Z) and NEVER auto-close a line -- lines import as outline
//    candidates and a human closes them later (closeRing is preview-only here).
//
// Pure module: no React, no network, no Supabase. Safe to unit-test.
// ============================================================================
import {kml as kmlDomToGeoJson} from '@tmcw/togeojson';
import {area as turfArea} from '@turf/area';
import {kinks as turfKinks} from '@turf/kinks';

const SQM_PER_ACRE = 4046.8564224;

// Strip any third (Z/elevation) ordinate from a GeoJSON coordinate tree so
// stored geometry is strictly 2D [lon, lat]. Recurses through nested arrays.
export function strip2D(coords) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') return [coords[0], coords[1]];
  return coords.map(strip2D);
}

function geom2D(geometry) {
  if (!geometry || !geometry.type) return null;
  return {type: geometry.type, coordinates: strip2D(geometry.coordinates)};
}

// Pull a numeric acreage out of an OnX notes string, e.g. "6-3-22\n11.3 ac" or
// "32.67ac" -> 11.3 / 32.67. Returns null when no "<num> ac" token is present.
export function parseAcreageNote(notes) {
  if (!notes || typeof notes !== 'string') return null;
  const m = notes.match(/(\d+(?:\.\d+)?)\s*ac\b/i);
  return m ? parseFloat(m[1]) : null;
}

// Geodesic acres for a GeoJSON Polygon/MultiPolygon geometry (turf area is
// spherical m^2). Returns null for non-areal geometry.
export function geometryAcres(geometry) {
  if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) return null;
  try {
    const sqm = turfArea({type: 'Feature', geometry, properties: {}});
    return Math.round((sqm / SQM_PER_ACRE) * 10000) / 10000;
  } catch {
    return null;
  }
}

// Convert one togeojson Feature into a Pasture Map placemark. Returns null for
// features with no usable geometry. geometry_type is the GeoJSON type; the
// server re-derives + validates, but we surface it so the UI can split polygons
// (reviewable areas) from lines (outline candidates) before upload.
export function featureToPlacemark(feature) {
  if (!feature || !feature.geometry) return null;
  const g = geom2D(feature.geometry);
  if (!g) return null;
  const p = feature.properties || {};
  return {
    external_id: p.id != null ? String(p.id) : null,
    name: (p.name != null ? String(p.name) : '').trim() || null,
    notes: p.notes != null ? String(p.notes) : null,
    color: p.color != null ? String(p.color) : null,
    geometry_type: g.type,
    geometry: g,
    // Derived, client-only hints (not sent to the RPC):
    note_acres: parseAcreageNote(p.notes != null ? String(p.notes) : null),
    is_outline_candidate: g.type === 'LineString' || g.type === 'MultiLineString',
    computed_acres: geometryAcres(g),
  };
}

// Parse a raw KML string into placemarks. Requires a DOM (browser or jsdom):
// togeojson operates on a parsed Document, not a string.
export function parseKmlToPlacemarks(kmlText, domParser) {
  if (!kmlText || typeof kmlText !== 'string') return [];
  const Parser = domParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
  if (!Parser) throw new Error('parseKmlToPlacemarks requires a DOMParser (browser or jsdom)');
  const doc = new Parser().parseFromString(kmlText, 'text/xml');
  const fc = kmlDomToGeoJson(doc);
  const features = (fc && fc.features) || [];
  return features.map(featureToPlacemark).filter(Boolean);
}

// Close an OPEN line's coordinate ring into a Polygon for preview/confirm. This
// is the only place a line becomes a polygon, and it is ALWAYS user-initiated
// (no silent auto-close on import). Appends the first vertex if the ring isn't
// already closed, then reports self-intersection so the UI can block an invalid
// close. Returns { polygon, valid, acres, reason }.
export function closeOutlineToPolygon(lineGeometry) {
  if (!lineGeometry || (lineGeometry.type !== 'LineString' && lineGeometry.type !== 'MultiLineString')) {
    return {polygon: null, valid: false, acres: null, reason: 'not a line geometry'};
  }
  let ring =
    lineGeometry.type === 'LineString' ? strip2D(lineGeometry.coordinates) : strip2D(lineGeometry.coordinates[0]);
  if (!Array.isArray(ring) || ring.length < 3) {
    return {polygon: null, valid: false, acres: null, reason: 'need at least 3 points to close'};
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring = [...ring, [first[0], first[1]]];
  }
  const polygon = {type: 'Polygon', coordinates: [ring]};
  let selfIntersects = false;
  try {
    const k = turfKinks({type: 'Feature', geometry: polygon, properties: {}});
    selfIntersects = !!(k && k.features && k.features.length > 0);
  } catch {
    selfIntersects = false;
  }
  if (selfIntersects) {
    return {polygon, valid: false, acres: null, reason: 'self-intersecting; adjust the outline and retry'};
  }
  return {polygon, valid: true, acres: geometryAcres(polygon), reason: null};
}
