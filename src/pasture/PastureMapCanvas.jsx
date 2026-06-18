// ============================================================================
// src/pasture/PastureMapCanvas.jsx - Pasture Map cockpit canvas
// ----------------------------------------------------------------------------
// Leaflet render for the redesigned grazing cockpit. Esri World Imagery is the
// primary tile source; geometry remains provider-neutral GeoJSON/PostGIS.
// Draw/edit/measure still use Leaflet-Geoman and feed the existing SECDEF RPC
// wrappers from PastureMapView.
// ============================================================================
import React from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import {area as turfArea} from '@turf/area';
import {polygonMetrics, ringPerimeterM, SQM_PER_ACRE} from '../lib/pastureGeometry.js';

const WCF_CENTER = [30.84175647927683, -86.43686683451689];
const ESRI_IMAGERY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const MAP_MAX_ZOOM = 26;
const IMAGERY_NATIVE_MAX_ZOOM = 19;
const BASELINE_REST_STATE = 'baseline';
const LINE_PATTERN_DASH = {
  solid: null,
  dashed: '10,8',
  dotted: '1,8',
};
const STATE_STYLE = {
  occupied: {color: '#23578f', fillColor: '#2E6FB5', fillOpacity: 0.68},
  resting: {color: '#8A6A1E', fillColor: '#C7920A', fillOpacity: 0.5},
  ready: {color: '#2f7a46', fillColor: '#3F9B5B', fillOpacity: 0.5},
  baseline: {color: '#6B7280', fillColor: '#9AA1AB', fillOpacity: 0.08},
  no_history: {color: '#6B7280', fillColor: '#9AA1AB', fillOpacity: 0.34},
  invalid: {color: '#C0452F', fillColor: '#C0452F', fillOpacity: 0.12, dashArray: '6,6'},
};

function cleanLineColor(value) {
  if (typeof value !== 'string') return null;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
}

function cleanLineWeight(value) {
  const weight = Number(value);
  if (!Number.isFinite(weight)) return null;
  const rounded = Math.round(weight);
  return rounded >= 1 && rounded <= 10 ? rounded : null;
}

function cleanLinePattern(value) {
  return value === 'solid' || value === 'dashed' || value === 'dotted' ? value : null;
}

function applyLineStyle(a, style) {
  const color = cleanLineColor(a && a.line_color);
  const weight = cleanLineWeight(a && a.line_weight);
  const pattern = cleanLinePattern(a && a.line_pattern);
  const next = {
    ...style,
    ...(color ? {color} : {}),
    ...(weight ? {weight} : {}),
  };
  if (pattern) {
    const dashArray = LINE_PATTERN_DASH[pattern];
    if (dashArray) next.dashArray = dashArray;
    else delete next.dashArray;
  }
  return next;
}

function hasSavedLineStyle(a) {
  return !!(
    cleanLineColor(a && a.line_color) ||
    cleanLineWeight(a && a.line_weight) ||
    cleanLinePattern(a && a.line_pattern)
  );
}

function areaState(a) {
  // Occupancy is NOT decided here: the Map derives it client-side from the P1
  // roster + move ledger (see styleForArea's occupant branch), not from the
  // backend current_occupancy_count, so the two cannot disagree on the map.
  if (!a) return 'no_history';
  if (a.status === 'blocked_repair' || a.geometry_status === 'invalid') return 'invalid';
  if (a.rest_state === 'resting') return 'resting';
  if (a.rest_state === 'rested' || a.rest_state === 'ready') return 'ready';
  if (a.rest_state === BASELINE_REST_STATE) return BASELINE_REST_STATE;
  return 'no_history';
}

// Precedence (Codex P2 contract): archived -> outline/invalid -> occupied
// (animal-type color) -> baseline -> resting -> ready -> no history.
function styleForArea(a, selected, occupant) {
  if (a.status === 'retired') {
    return applyLineStyle(a, {
      color: '#6B7280',
      weight: 2,
      dashArray: '4,5',
      fillColor: '#9AA1AB',
      fillOpacity: 0.1,
    });
  }
  if (a.geometry_status === 'outline_candidate' || a.kind === 'outline_candidate') {
    const outline = hasSavedLineStyle(a)
      ? applyLineStyle(a, {color: '#dc2626', weight: 5, fillColor: '#C0452F', fillOpacity: 0.08})
      : {color: '#dc2626', weight: 5, fillColor: '#C0452F', fillOpacity: 0.08};
    return selected ? {...outline, color: '#0f1a14', weight: 3.5} : outline;
  }
  if (a.status === 'blocked_repair' || a.geometry_status === 'invalid') {
    const inv = applyLineStyle(a, {...STATE_STYLE.invalid});
    return selected ? {...inv, color: '#0f1a14', weight: 3.5} : inv;
  }
  // Occupied: fill in the occupying group's animal-type color (client roster).
  if (occupant) {
    let occ = {color: occupant.ink, fillColor: occupant.color, fillOpacity: 0.62, weight: 2};
    if (a.permanence === 'temporary') occ.dashArray = '6,4';
    else if (a.kind === 'pasture') {
      occ.weight = 2.5;
      occ.dashArray = '10,5';
    }
    occ = applyLineStyle(a, occ);
    return selected ? {...occ, color: '#0f1a14', weight: 3.5} : occ;
  }
  if (a.rest_state === 'baseline') {
    const baseline = applyLineStyle(a, {...STATE_STYLE.baseline, fillOpacity: 0.08});
    return selected ? {...baseline, color: '#0f1a14', weight: 3.5, fillOpacity: 0.78} : baseline;
  }
  let next = {...STATE_STYLE[areaState(a)]};
  if (a.kind === 'pasture') {
    next.weight = 2.5;
    next.dashArray = '10,5';
  } else if (a.kind === 'scratch' || a.kind === 'temp') {
    next.weight = 2;
    next.color = '#2f7a46';
    next.dashArray = '5,4';
  } else {
    next.weight = 1.5;
    if (areaState(a) !== 'invalid') delete next.dashArray;
  }
  next = applyLineStyle(a, next);
  if (selected) next = {...next, color: '#0f1a14', weight: 3.5, fillOpacity: Math.max(next.fillOpacity || 0, 0.78)};
  return next;
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
  return [a.name || 'Unnamed', acres].filter(Boolean).join(' - ');
}

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

function layerCenter(layer) {
  if (!layer || !layer.getBounds) return null;
  const b = layer.getBounds();
  if (!b || !b.isValid()) return null;
  return b.getCenter();
}

function rotationIcon(number, color) {
  return L.divIcon({
    className: 'pm-rotation-marker',
    html: `<span style="background:${color}">${number}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

export default function PastureMapCanvas({
  areas,
  occupants = {},
  onSelect,
  mode = 'select',
  canWrite = false,
  editAreaId = null,
  selectedId = null,
  onDrawComplete,
  onEditGeometry,
  trackGeometry = null,
  rotationAreaIds = [],
  rotationColor = '#1C8A5F',
  showRotationPath = true,
  legendOpen = true,
  onToggleLegend,
  mapBanner = null,
  compact = false,
  zoomSignal = 0,
}) {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const layerRef = React.useRef(null);
  const areaLayersRef = React.useRef(new Map());
  const locateRef = React.useRef(null);
  const tempRef = React.useRef(null);
  const trackRef = React.useRef(null);
  const rotationRef = React.useRef(null);
  const editLayerRef = React.useRef(null);
  const fitSignatureRef = React.useRef('');
  const cbRef = React.useRef({});
  cbRef.current = {onSelect, onDrawComplete, onEditGeometry};
  const [gpsMsg, setGpsMsg] = React.useState('');
  const [hud, setHud] = React.useState(null);

  React.useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const map = L.map(elRef.current, {
      center: WCF_CENTER,
      zoom: compact ? 14 : 15,
      maxZoom: MAP_MAX_ZOOM,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 40,
      zoomControl: !compact,
    });
    L.tileLayer(ESRI_IMAGERY_URL, {
      maxZoom: MAP_MAX_ZOOM,
      maxNativeZoom: IMAGERY_NATIVE_MAX_ZOOM,
      attribution: 'Esri World Imagery - Maxar',
    }).addTo(map);
    L.control.scale({imperial: true, metric: false, position: 'bottomright'}).addTo(map);
    if (map.pm) map.pm.setGlobalOptions({snappable: true, snapDistance: 20});
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [compact]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) layerRef.current.remove();
    areaLayersRef.current = new Map();
    const group = L.featureGroup();
    const fitSignature = (areas || [])
      .map((a) => {
        const version = a.current_version && (a.current_version.id || a.current_version.version_number);
        const rawType = a.raw_geometry && a.raw_geometry.type;
        return [a.id, version || '', a.geometry_status || '', rawType || ''].join(':');
      })
      .join('|');

    (areas || []).forEach((a) => {
      const g = areaGeom(a);
      if (!g) return;
      const occList = occupants[a.id] || [];
      const occ = occList[0] || null;
      const style = styleForArea(a, a.id === selectedId, occ);
      const lyr = L.geoJSON(
        {type: 'Feature', geometry: g.geometry, properties: {}},
        {style: g.kind === 'line' ? {...style, fill: false} : style},
      );
      lyr.bindTooltip(labelFor(a) + (g.kind === 'line' ? ' (outline)' : ''), {
        direction: 'center',
        className: 'pm-map-label',
        permanent: !compact && g.kind === 'polygon' && !occ,
      });
      lyr.on('click', () => {
        if (!['draw', 'edit', 'measure', 'track'].includes(mode) && cbRef.current.onSelect)
          cbRef.current.onSelect(a.id);
      });
      lyr.addTo(group);
      let inner = lyr;
      lyr.eachLayer((sub) => {
        inner = sub;
      });
      areaLayersRef.current.set(a.id, inner);

      // Occupied polygons carry a readable group marker at the centroid so the
      // map answers "what group is here" at a glance (P2 Map contract).
      if (occ && g.kind === 'polygon') {
        const center = layerCenter(inner);
        if (center) {
          const more = occList.length > 1 ? `<span class="pm-occ-more">+${occList.length - 1}</span>` : '';
          const countLabel = occ.count != null ? ` &middot; ${occ.count}` : '';
          L.marker(center, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'pm-occupant-marker',
              html:
                `<span class="pm-occ-avatar" style="background:${occ.color}">${occ.short || ''}</span>` +
                `<span class="pm-occ-name">${occ.name || ''}${countLabel}</span>${more}`,
              iconSize: [0, 0],
            }),
          }).addTo(group);
        }
      }
    });

    group.addTo(map);
    layerRef.current = group;
    try {
      const b = group.getBounds();
      if (fitSignature && fitSignature !== fitSignatureRef.current && b && b.isValid()) {
        map.fitBounds(b, {padding: compact ? [14, 14] : [36, 36], maxZoom: compact ? 18 : 19});
        fitSignatureRef.current = fitSignature;
      }
    } catch {
      /* no bounds yet */
    }
  }, [areas, occupants, selectedId, mode, compact]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (trackRef.current) {
      trackRef.current.remove();
      trackRef.current = null;
    }
    if (!trackGeometry || trackGeometry.type !== 'LineString' || !Array.isArray(trackGeometry.coordinates)) return;
    const coords = trackGeometry.coordinates.filter((p) => Array.isArray(p) && p.length >= 2);
    if (!coords.length) return;
    const group = L.layerGroup();
    if (coords.length >= 2) {
      L.geoJSON(
        {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties: {}},
        {style: {color: '#ffffff', weight: 5, opacity: 1, dashArray: '2,7'}},
      ).addTo(group);
    }
    const last = coords[coords.length - 1];
    L.circleMarker([last[1], last[0]], {
      radius: 6,
      color: '#0e7490',
      fillColor: '#67e8f9',
      fillOpacity: 1,
      weight: 2,
    }).addTo(group);
    group.addTo(map);
    trackRef.current = group;
    if (coords.length === 1) map.setView([last[1], last[0]], Math.max(map.getZoom(), 18));
    return () => {
      if (trackRef.current === group) {
        group.remove();
        trackRef.current = null;
      }
    };
  }, [trackGeometry]);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (rotationRef.current) {
      rotationRef.current.remove();
      rotationRef.current = null;
    }
    if (!showRotationPath || !rotationAreaIds.length) return;
    const centers = rotationAreaIds
      .map((id) => layerCenter(areaLayersRef.current.get(id)))
      .filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
    if (!centers.length) return;
    const group = L.layerGroup();
    if (centers.length >= 2)
      L.polyline(centers, {color: rotationColor, weight: 3, opacity: 0.95, dashArray: '1,8'}).addTo(group);
    centers.forEach((point, index) => {
      L.marker(point, {icon: rotationIcon(index + 1, rotationColor), interactive: false}).addTo(group);
    });
    group.addTo(map);
    rotationRef.current = group;
    return () => {
      if (rotationRef.current === group) {
        group.remove();
        rotationRef.current = null;
      }
    };
  }, [areas, rotationAreaIds, rotationColor, selectedId, showRotationPath]);

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
          clearTemp();
          tempRef.current = layer;
          if (layer.setStyle) layer.setStyle({color: '#2f7a46', weight: 3, fillColor: '#3F9B5B', fillOpacity: 0.22});
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

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !zoomSignal || !selectedId) return;
    const layer = areaLayersRef.current.get(selectedId);
    if (layer && layer.getBounds) {
      const b = layer.getBounds();
      if (b && b.isValid()) map.fitBounds(b, {padding: [50, 50], maxZoom: 20});
    }
  }, [zoomSignal, selectedId]);

  function fitFarm() {
    const map = mapRef.current;
    if (!map || !layerRef.current) return;
    try {
      const b = layerRef.current.getBounds();
      if (b && b.isValid()) map.fitBounds(b, {padding: [36, 36], maxZoom: compact ? 18 : 19});
    } catch {
      map.setView(WCF_CENTER, compact ? 14 : 15);
    }
  }

  function zoomSelected() {
    const map = mapRef.current;
    if (!map || !selectedId) {
      fitFarm();
      return;
    }
    const layer = areaLayersRef.current.get(selectedId);
    if (layer && layer.getBounds) {
      const b = layer.getBounds();
      if (b && b.isValid()) {
        map.fitBounds(b, {padding: [50, 50], maxZoom: 20});
        return;
      }
    }
    fitFarm();
  }

  function locate() {
    const map = mapRef.current;
    if (!map) return;
    setGpsMsg('Locating...');
    map.locate({setView: true, enableHighAccuracy: true, maxZoom: MAP_MAX_ZOOM, timeout: 15000});
    map.once('locationfound', (e) => {
      if (locateRef.current) locateRef.current.remove();
      const g = L.layerGroup();
      L.circleMarker(e.latlng, {radius: 7, color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1, weight: 2}).addTo(g);
      L.circle(e.latlng, {radius: e.accuracy, color: '#3b82f6', weight: 1, fillOpacity: 0.08}).addTo(g);
      g.addTo(map);
      locateRef.current = g;
      const ft = Math.round(e.accuracy * 3.28084);
      setGpsMsg(ft > 30 ? `GPS accuracy ~${ft} ft - let it settle before tracing` : `GPS accuracy ~${ft} ft`);
    });
    map.once('locationerror', () => setGpsMsg('Location unavailable'));
  }

  return (
    <div className={'pm-map-wrap' + (compact ? ' is-compact' : '')}>
      <div ref={elRef} className="pm-map" data-pasture-map-canvas="1" />
      {hud && (
        <div className="pm-hud" data-pasture-hud="1" data-hud-valid={hud.valid === false ? 'false' : 'true'}>
          <div className="pm-hud-row">
            <span className="pm-hud-k">Acres</span>
            <span className="pm-hud-v">{hud.acres != null ? hud.acres.toLocaleString() : '-'}</span>
          </div>
          <div className="pm-hud-row">
            <span className="pm-hud-k">Perimeter</span>
            <span className="pm-hud-v">{hud.perimeterFt != null ? `${hud.perimeterFt.toLocaleString()} ft` : '-'}</span>
          </div>
          {hud.selfIntersects && <div className="pm-hud-warn">Self-intersecting - fix before saving</div>}
        </div>
      )}
      {!compact && mapBanner && (
        <div className="pm-map-banner">
          <span>{mapBanner.text}</span>
          {mapBanner.primary && (
            <button type="button" className="pm-mini-btn is-primary" onClick={mapBanner.primary.onClick}>
              {mapBanner.primary.label}
            </button>
          )}
          {mapBanner.secondary && (
            <button type="button" className="pm-mini-btn" onClick={mapBanner.secondary.onClick}>
              {mapBanner.secondary.label}
            </button>
          )}
        </div>
      )}
      {!compact && (
        <div className="pm-map-controls">
          <button type="button" className="pm-map-control" onClick={fitFarm}>
            Fit Farm
          </button>
          <button type="button" className="pm-map-control" onClick={zoomSelected}>
            Zoom Selected
          </button>
          <button type="button" className="pm-map-control" onClick={locate}>
            My Location
          </button>
        </div>
      )}
      {!compact && (
        <div className={'pm-legend' + (legendOpen ? ' is-open' : '')}>
          <button type="button" className="pm-legend-head" onClick={onToggleLegend}>
            <span>Legend</span>
            <span aria-hidden="true">{legendOpen ? '-' : '+'}</span>
          </button>
          {legendOpen && (
            <div className="pm-legend-body">
              <span>
                <i className="state occ-cattle" /> Occupied - Cattle
              </span>
              <span>
                <i className="state occ-sheep" /> Occupied - Sheep
              </span>
              <span>
                <i className="state occ-pigs" /> Occupied - Pigs
              </span>
              <span>
                <i className="state resting" /> Resting - recovering
              </span>
              <span>
                <i className="state ready" /> Ready to graze
              </span>
              <span>
                <i className="state no-history" /> No history / unknown
              </span>
              <span>
                <i className="state invalid" /> Invalid / needs setup
              </span>
              <hr />
              <span>
                <i className="state selected" /> Selected pasture
              </span>
              <span>
                <i className="state rotation" /> Active group rotation
              </span>
              <span>
                <i className="state temp" /> Temp paddock
              </span>
              <span>
                <i className="state gps" /> GPS boundary trace
              </span>
            </div>
          )}
        </div>
      )}
      {gpsMsg && <div className="pm-gps-msg">{gpsMsg}</div>}
    </div>
  );
}
