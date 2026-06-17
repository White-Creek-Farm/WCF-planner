// ============================================================================
// src/pasture/PastureMapCanvas.jsx  —  Pasture Map (CP1 render + CP2 draw/edit)
// ----------------------------------------------------------------------------
// Leaflet render of land areas over USGS/NAIP aerial imagery. CP1: read-only
// polygons/outlines + GPS "you are here". CP2 adds Leaflet-Geoman modes:
//   select  — pan + click-to-select (all roles)
//   measure — draw a throwaway polygon to read acres/perimeter (all roles)
//   draw    — draw a new polygon; hands geometry up for the save form (write)
//   edit    — drag vertices of the selected area; hands geometry up (write)
// A live HUD shows acres + perimeter while drawing/editing and flags
// self-intersection (client guard; the create/update RPCs are the backstop).
//
// Occupancy / rest-day coloring is still CP3 — areas color by classification.
// ============================================================================
import React from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import {area as turfArea} from '@turf/area';
import {polygonMetrics, ringPerimeterM, SQM_PER_ACRE} from '../lib/pastureGeometry.js';

const WCF_CENTER = [30.84175647927683, -86.43686683451689];
const NAIP_URL = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}';

function styleForArea(a) {
  if (a.status === 'blocked_repair') return {color: '#b91c1c', weight: 2, fillColor: '#ef4444', fillOpacity: 0.18};
  if (a.status === 'retired')
    return {color: '#6b7280', weight: 2, dashArray: '4,5', fillColor: '#9ca3af', fillOpacity: 0.1};
  if (a.geometry_status === 'outline_candidate' || a.kind === 'outline_candidate')
    return {color: '#d97706', weight: 2, dashArray: '6,6', fillColor: '#f59e0b', fillOpacity: 0.12};
  if (a.geometry_status === 'invalid')
    return {color: '#dc2626', weight: 2, dashArray: '3,4', fillColor: '#f87171', fillOpacity: 0.1};
  if (a.kind === 'infrastructure' || a.kind === 'scratch')
    return {color: '#475569', weight: 2, fillColor: '#64748b', fillOpacity: 0.15};
  return {color: '#15803d', weight: 2, fillColor: '#22c55e', fillOpacity: 0.14};
}

function areaGeom(a) {
  if (a.current_version && a.current_version.geometry) return {kind: 'polygon', geometry: a.current_version.geometry};
  const rg = a.raw_geometry;
  if (rg && (rg.type === 'Polygon' || rg.type === 'MultiPolygon')) return {kind: 'polygon', geometry: rg};
  if (rg && (rg.type === 'LineString' || rg.type === 'MultiLineString')) return {kind: 'line', geometry: rg};
  return null;
}

function labelFor(a) {
  const acres = a.effective_acres != null ? `${a.effective_acres} ac` : null;
  return [a.name || 'Unnamed', acres].filter(Boolean).join(' · ');
}

// Best-effort live metrics from a Geoman working/edit layer's latlngs.
function liveMetricsFromLayer(layer) {
  let latlngs;
  try {
    latlngs = layer.getLatLngs();
  } catch {
    return null;
  }
  while (Array.isArray(latlngs) && latlngs.length && Array.isArray(latlngs[0])) latlngs = latlngs[0];
  if (!Array.isArray(latlngs) || latlngs.length < 2)
    return {acres: null, perimeterFt: null, points: latlngs ? latlngs.length : 0};
  const ring = latlngs.map((p) => [p.lng, p.lat]);
  const closedRing = [...ring, ring[0]];
  let acres = null;
  if (ring.length >= 3) {
    try {
      acres =
        Math.round(
          (turfArea({type: 'Feature', geometry: {type: 'Polygon', coordinates: [closedRing]}, properties: {}}) /
            SQM_PER_ACRE) *
            100,
        ) / 100;
    } catch {
      acres = null;
    }
  }
  return {acres, perimeterFt: Math.round(ringPerimeterM(ring, false) * 3.28084), points: ring.length};
}

export default function PastureMapCanvas({
  areas,
  onSelect,
  mode = 'select',
  canWrite = false,
  editAreaId = null,
  onDrawComplete,
  onEditGeometry,
}) {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const layerRef = React.useRef(null);
  const areaLayersRef = React.useRef(new Map());
  const locateRef = React.useRef(null);
  const tempRef = React.useRef(null);
  const editLayerRef = React.useRef(null);
  const cbRef = React.useRef({});
  cbRef.current = {onSelect, onDrawComplete, onEditGeometry};
  const [gpsMsg, setGpsMsg] = React.useState('');
  const [hud, setHud] = React.useState(null);

  // ── Map init ──
  React.useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const map = L.map(elRef.current, {center: WCF_CENTER, zoom: 15, zoomControl: true});
    L.tileLayer(NAIP_URL, {maxZoom: 19, attribution: 'Imagery: USGS / NAIP (public domain)'}).addTo(map);
    if (map.pm) map.pm.setGlobalOptions({snappable: true, snapDistance: 20});
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Render areas ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) layerRef.current.remove();
    areaLayersRef.current = new Map();
    const group = L.featureGroup();
    (areas || []).forEach((a) => {
      const g = areaGeom(a);
      if (!g) return;
      const baseStyle = styleForArea(a);
      const style = g.kind === 'line' ? {...baseStyle, fill: false, dashArray: '6,6'} : baseStyle;
      const lyr = L.geoJSON({type: 'Feature', geometry: g.geometry, properties: {}}, {style});
      lyr.bindTooltip(labelFor(a) + (g.kind === 'line' ? ' (outline)' : ''), {
        direction: 'center',
        className: 'pm-label',
      });
      lyr.on('click', () => cbRef.current.onSelect && cbRef.current.onSelect(a.id));
      lyr.addTo(group);
      if (g.kind === 'polygon') {
        // The first sub-layer is the editable polygon for CP2 edit mode.
        let inner = lyr;
        lyr.eachLayer((sub) => {
          inner = sub;
        });
        areaLayersRef.current.set(a.id, inner);
      }
    });
    group.addTo(map);
    layerRef.current = group;
    try {
      const b = group.getBounds();
      if (b && b.isValid()) map.fitBounds(b, {padding: [30, 30], maxZoom: 17});
    } catch {
      /* no bounds yet */
    }
  }, [areas]);

  // ── Geoman mode wiring ──
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.pm) return;

    function clearTemp() {
      if (tempRef.current) {
        try {
          map.removeLayer(tempRef.current);
        } catch {
          /* already gone */
        }
        tempRef.current = null;
      }
    }
    function teardown() {
      try {
        map.pm.disableDraw();
      } catch {
        /* noop */
      }
      if (editLayerRef.current) {
        try {
          editLayerRef.current.pm.disable();
        } catch {
          /* noop */
        }
        editLayerRef.current = null;
      }
      map.off('pm:create');
      map.off('pm:drawstart');
      clearTemp();
    }

    teardown();
    setHud(null);

    const writeMode = mode === 'draw' || mode === 'edit';
    if (writeMode && !canWrite) return;

    if (mode === 'draw' || mode === 'measure') {
      map.pm.enableDraw('Polygon', {snappable: true, snapDistance: 20, continueDrawing: false});
      map.on('pm:drawstart', ({workingLayer}) => {
        if (!workingLayer) return;
        const upd = () => {
          const m = liveMetricsFromLayer(workingLayer);
          if (m) setHud({...m, live: true, mode});
        };
        workingLayer.on('pm:vertexadded', upd);
        workingLayer.on('pm:change', upd);
      });
      map.on('pm:create', (e) => {
        const layer = e.layer;
        const gj = layer.toGeoJSON().geometry;
        const metrics = polygonMetrics(gj);
        if (mode === 'measure') {
          clearTemp();
          tempRef.current = layer;
          if (layer.setStyle) layer.setStyle({color: '#2563eb', weight: 2, dashArray: '6,6', fillOpacity: 0.05});
          setHud({...metrics, frozen: true, mode: 'measure'});
          try {
            map.pm.disableDraw();
          } catch {
            /* noop */
          }
        } else {
          map.removeLayer(layer);
          setHud({...metrics, frozen: true, mode: 'draw'});
          try {
            map.pm.disableDraw();
          } catch {
            /* noop */
          }
          cbRef.current.onDrawComplete && cbRef.current.onDrawComplete(gj, metrics);
        }
      });
    } else if (mode === 'edit' && editAreaId) {
      const layer = areaLayersRef.current.get(editAreaId);
      if (layer && layer.pm) {
        layer.pm.enable({snappable: true, snapDistance: 20, allowSelfIntersection: false});
        editLayerRef.current = layer;
        const onChange = () => {
          const gj = layer.toGeoJSON().geometry;
          const metrics = polygonMetrics(gj);
          setHud({...metrics, mode: 'edit'});
          cbRef.current.onEditGeometry && cbRef.current.onEditGeometry(gj, metrics);
        };
        layer.on('pm:markerdragend', onChange);
        layer.on('pm:edit', onChange);
        onChange();
      }
    }

    return teardown;
  }, [mode, editAreaId, canWrite, areas]);

  function locate() {
    const map = mapRef.current;
    if (!map) return;
    setGpsMsg('Locating…');
    map.locate({setView: true, enableHighAccuracy: true, maxZoom: 18, timeout: 15000});
    map.once('locationfound', (e) => {
      if (locateRef.current) locateRef.current.remove();
      const g = L.layerGroup();
      L.circleMarker(e.latlng, {radius: 7, color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1, weight: 2}).addTo(g);
      L.circle(e.latlng, {radius: e.accuracy, color: '#3b82f6', weight: 1, fillOpacity: 0.08}).addTo(g);
      g.addTo(map);
      locateRef.current = g;
      const ft = Math.round(e.accuracy * 3.28084);
      setGpsMsg(ft > 30 ? `GPS accuracy ~${ft} ft — let it settle before tracing` : `GPS accuracy ~${ft} ft`);
    });
    map.once('locationerror', () => setGpsMsg('Location unavailable (check permissions / signal)'));
  }

  return (
    <div className="pm-map-wrap">
      <div ref={elRef} className="pm-map" data-pasture-map-canvas="1" />
      {hud && (
        <div className="pm-hud" data-pasture-hud="1" data-hud-valid={hud.valid === false ? 'false' : 'true'}>
          <div className="pm-hud-row">
            <span className="pm-hud-k">Acres</span>
            <span className="pm-hud-v">{hud.acres != null ? hud.acres.toLocaleString() : '—'}</span>
          </div>
          <div className="pm-hud-row">
            <span className="pm-hud-k">Perimeter</span>
            <span className="pm-hud-v">{hud.perimeterFt != null ? `${hud.perimeterFt.toLocaleString()} ft` : '—'}</span>
          </div>
          {hud.selfIntersects && <div className="pm-hud-warn">Self-intersecting — fix before saving</div>}
        </div>
      )}
      <button type="button" className="pm-locate-btn" onClick={locate}>
        📍 You are here
      </button>
      {gpsMsg && <div className="pm-gps-msg">{gpsMsg}</div>}
    </div>
  );
}
