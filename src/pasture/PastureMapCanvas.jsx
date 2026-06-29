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
import {lineMetrics, polygonMetrics, ringPerimeterM, SQM_PER_ACRE} from '../lib/pastureGeometry.js';
import {getCachedTile, naipTileUrl} from '../lib/pastureImagery.js';

const WCF_CENTER = [30.84175647927683, -86.43686683451689];
const ESRI_IMAGERY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const MAP_MAX_ZOOM = 26;
const IMAGERY_NATIVE_MAX_ZOOM = 19;
// Basemap switcher sources (Esri online; online use is fine - only OFFLINE tile
// CACHING is restricted, which is why offline imagery uses public-domain NAIP).
const ESRI_TOPO_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';

// Offline imagery layer (CP-F): serves the cached NAIP farm tiles when offline,
// falling back to a live NAIP fetch for any tile not in the cache. Used for the
// satellite basemap only while the app is offline.
const OfflineImageryLayer = L.TileLayer.extend({
  createTile(coords, done) {
    const tile = document.createElement('img');
    tile.alt = '';
    const show = (blob) => {
      if (!blob) {
        done(null, tile);
        return;
      }
      const url = URL.createObjectURL(blob);
      tile.onload = () => {
        URL.revokeObjectURL(url);
        done(null, tile);
      };
      tile.onerror = () => {
        URL.revokeObjectURL(url);
        done(null, tile);
      };
      tile.src = url;
    };
    getCachedTile(coords.z, coords.x, coords.y).then((cached) => {
      if (cached) {
        show(cached);
        return;
      }
      fetch(naipTileUrl(coords.z, coords.x, coords.y), {mode: 'cors'})
        .then((r) => (r.ok ? r.blob() : null))
        .then(show)
        .catch(() => show(null));
    });
    return tile;
  },
});
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

// Fixed boundary strokes by designation (lane: designation/boundary behavior).
// Permanent pasture/paddock strokes are NOT editable — they are forced here and
// ignore any saved line_color/line_weight/line_pattern. Only the FILL reflects
// occupancy/state. Temp paddocks default to white dashed 5px but stay editable
// (applyLineStyle is layered on top for temp + GPS/field outline candidates).
const PERMANENT_PASTURE_STROKE = {color: '#1d4ed8', weight: 4}; // high-contrast blue
const PERMANENT_PADDOCK_STROKE = {color: '#4ade80', weight: 4}; // bright/light green
const TEMP_PADDOCK_DEFAULT_STROKE = {color: '#ffffff', weight: 5, dashArray: LINE_PATTERN_DASH.dashed};

function isPermanentPasture(a) {
  return !!a && a.kind === 'pasture' && a.permanence !== 'temporary';
}
function isPermanentPaddock(a) {
  return !!a && a.kind === 'paddock' && a.permanence !== 'temporary';
}
function isTempPaddock(a) {
  return !!a && a.permanence === 'temporary';
}
// Which boundary-overlay toggle category an area belongs to (null = always shown:
// unclassified / outline candidates / GPS field lines are not toggle-managed).
function boundaryCategory(a) {
  if (isTempPaddock(a)) return 'temp';
  if (isPermanentPasture(a)) return 'pasture';
  if (isPermanentPaddock(a)) return 'paddock';
  return null;
}

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

// Force the designation boundary stroke. Permanent pasture/paddock get a fixed,
// non-editable stroke (saved line_* is ignored). Temp paddocks get the white
// dashed 5px default with applyLineStyle layered on so they stay editable. The
// FILL passed in (occupancy/state) is preserved either way. Returns the style
// with the correct stroke, or the input untouched for non-designation kinds.
function withDesignationStroke(a, style) {
  if (isPermanentPasture(a)) {
    return {
      ...style,
      color: PERMANENT_PASTURE_STROKE.color,
      weight: PERMANENT_PASTURE_STROKE.weight,
      dashArray: undefined,
    };
  }
  if (isPermanentPaddock(a)) {
    return {
      ...style,
      color: PERMANENT_PADDOCK_STROKE.color,
      weight: PERMANENT_PADDOCK_STROKE.weight,
      dashArray: undefined,
    };
  }
  if (isTempPaddock(a)) {
    return applyLineStyle(a, {...style, ...TEMP_PADDOCK_DEFAULT_STROKE});
  }
  return null;
}

// Hide an area's boundary stroke (keep its fill + occupant marker) when its
// boundary-overlay category is toggled off. Leaflet `stroke:false` removes the
// outline only; the fill polygon and the separate divIcon marker are untouched.
function applyBoundaryVisibility(a, style, boundaryFilter) {
  if (!boundaryFilter) return style;
  const cat = boundaryCategory(a);
  if (cat && boundaryFilter[cat] === false) return {...style, stroke: false};
  return style;
}

// Precedence (Codex P2 contract): archived -> outline/invalid -> occupied
// (animal-type color) -> baseline -> resting -> ready -> no history.
function styleForArea(a, selected, occupant, boundaryFilter) {
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

  // Base style = FILL by occupancy/state (the occupancy color must stay visible
  // regardless of the boundary overlay). Stroke is set by designation below.
  let next;
  if (occupant) {
    next = {color: occupant.ink, fillColor: occupant.color, fillOpacity: 0.62, weight: 2};
  } else if (a.rest_state === 'baseline') {
    next = {...STATE_STYLE.baseline, fillOpacity: 0.08};
  } else {
    next = {...STATE_STYLE[areaState(a)]};
  }

  // Designation stroke: fixed for permanent pasture/paddock, editable default
  // for temp paddocks. Non-designation kinds (unclassified, etc.) keep the
  // legacy kind-based stroke + optional saved line style.
  const designation = withDesignationStroke(a, next);
  if (designation) {
    next = designation;
  } else {
    next.weight = 1.5;
    if (!occupant && areaState(a) !== 'invalid') delete next.dashArray;
    next = applyLineStyle(a, next);
  }

  next = applyBoundaryVisibility(a, next, boundaryFilter);

  // Selection highlights the area's OWN boundary line (bright outline), not a
  // bounding box and not a heavy fill - same idea as OnX Hunt.
  if (selected)
    next = {
      ...next,
      color: '#fde047',
      weight: 4.5,
      stroke: true,
    };
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

// Closed GeoJSON polygon ring from an array of L.LatLng drop-point vertices.
function dropPolygonGeoJSON(verts) {
  const ring = verts.map((ll) => [ll.lng, ll.lat]);
  if (verts.length) ring.push([verts[0].lng, verts[0].lat]);
  return {type: 'Polygon', coordinates: [ring]};
}

function rotationIcon(number, color, dim) {
  return L.divIcon({
    className: 'pm-rotation-marker' + (dim ? ' is-dim' : ''),
    html: `<span style="background:${color}">${number}</span>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// Compact inline-SVG icons for the right-side control rail. 20px, currentColor so
// the button's color drives them; aria-hidden (the button carries the label).
const railSvg = (children) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const RAIL_ICONS = {
  // Fit: expand-to-frame corners.
  fit: railSvg(
    <>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </>,
  ),
  // Locate: crosshair / target.
  locate: railSvg(
    <>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="2" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22" y2="12" />
    </>,
  ),
  // Layers: stacked sheets.
  layers: railSvg(
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </>,
  ),
  // Legend: a key / list.
  legend: railSvg(
    <>
      <line x1="8" y1="7" x2="20" y2="7" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="17" x2="20" y2="17" />
      <circle cx="4" cy="7" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="17" r="1" />
    </>,
  ),
};

// Read-only Map hover/tap readout labels.
const AREA_TIP_KIND = {
  pasture: 'Pasture',
  feeder_pig_area: 'Feeder-pig area',
  section: 'Section',
  paddock: 'Paddock',
  unclassified: 'Unclassified',
  infrastructure: 'Infrastructure',
  outline_candidate: 'Track / line',
  scratch: 'Scratch',
};
function escTip(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"]/g,
    (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c],
  );
}
// Read-only Map readout for an area (desktop hover / touch tap): name + size only.
// No grazing/rest history, occupant, or last-moved date on the Map bubble.
function areaHoverTip(a) {
  const type = a.permanence === 'temporary' ? 'Temp paddock' : AREA_TIP_KIND[a.kind] || 'Area';
  const acres = a.effective_acres == null ? null : `${a.effective_acres} ac`;
  return (
    `<span class="pm-tip-name">${escTip(a.name) || 'Unnamed'}</span>` +
    `<span class="pm-tip-meta">${escTip(type)}${acres ? ' &middot; ' + acres : ''}</span>`
  );
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
  rotationPaths = [],
  nextStopOnly = false,
  showRotationPath = true,
  previewAreaId = null,
  legendOpen = true,
  onToggleLegend,
  mapBanner = null,
  compact = false,
  zoomSignal = 0,
  boundaryFilter = null,
  onToggleBoundary,
  appMode = 'view',
  draftLinesVisible = false,
  onToggleDraftLines,
  onExitTool,
  isTouch = false,
  onSaveMeasurement,
  measurements = [],
  online = true,
}) {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const layerRef = React.useRef(null);
  const areaLayersRef = React.useRef(new Map());
  const locateRef = React.useRef(null);
  const tempRef = React.useRef(null);
  const trackRef = React.useRef(null);
  const rotationRef = React.useRef(null);
  const previewRef = React.useRef(null);
  const previewTooltipRef = React.useRef(null);
  const editLayerRef = React.useRef(null);
  const fitSignatureRef = React.useRef('');
  const cbRef = React.useRef({});
  cbRef.current = {onSelect, onDrawComplete, onEditGeometry};
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  // Set when an area feature is clicked so the subsequent map-background click
  // (which Leaflet also fires) does not immediately clear the new selection.
  const featureClickRef = React.useRef(false);
  const [gpsMsg, setGpsMsg] = React.useState('');
  const [hud, setHud] = React.useState(null);
  // Stateful GPS location (CP-D): off -> center+follow -> heading cone -> off.
  const watchRef = React.useRef(null);
  const followRef = React.useRef(false);
  const pausedRef = React.useRef(false);
  const lastFixRef = React.useRef(null);
  const [locateState, setLocateState] = React.useState('off');
  const locateStateRef = React.useRef('off');
  locateStateRef.current = locateState;
  // Custom Drop Point draw (CP-D): own the in-progress polygon vertices so the
  // crosshair center-drop + tap-to-place + Undo work without Geoman internals.
  const dropVertsRef = React.useRef([]);
  const dropLayerRef = React.useRef(null);
  const dropClickRef = React.useRef(null);
  // Saved distance measurements (CP-E): the last measured line geometry + the
  // rendered layer of persisted measurements.
  const measureGeomRef = React.useRef(null);
  const measureLayerRef = React.useRef(null);
  // Two-point distance ruler: the in-progress A/B vertices + the bound map-click
  // handler (so it can be torn down on tool switch).
  const measureVertsRef = React.useRef([]);
  const measureClickRef = React.useRef(null);
  // Basemap switcher (CP-F): satellite (default) / topo.
  const basemapRef = React.useRef(null);
  const [basemap, setBasemap] = React.useState('satellite');
  // Right-rail "Layers" popover (base map + boundary overlays), collapsed by default.
  const [layersOpen, setLayersOpen] = React.useState(false);

  React.useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const map = L.map(elRef.current, {
      center: WCF_CENTER,
      zoom: compact ? 14 : 15,
      maxZoom: MAP_MAX_ZOOM,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 40,
      // Zoom lives in the custom right-side control rail (not Leaflet's default).
      zoomControl: false,
    });
    L.control.scale({imperial: true, metric: false, position: 'bottomright'}).addTo(map);
    // Dedicated high-z pane so the GPS/current-location marker + heading cone render
    // ABOVE pasture boundaries, occupancy fills, measurement layers, and saved layers
    // (circleMarker/circle otherwise share the SVG overlay pane with the polygons and
    // can be painted over when areas re-render). Above markers/tooltips, below popups.
    map.createPane('pm-locate-pane');
    const locatePane = map.getPane('pm-locate-pane');
    if (locatePane) locatePane.style.zIndex = '690';
    if (map.pm) map.pm.setGlobalOptions({snappable: true, snapDistance: 20});
    // Clicking empty map background clears the current selection (but not while
    // drawing/editing/measuring/tracking, and not when the click was on an area).
    map.on('click', () => {
      if (featureClickRef.current) {
        featureClickRef.current = false;
        return;
      }
      if (['draw', 'edit', 'measure', 'track', 'droppin'].includes(modeRef.current)) return;
      if (cbRef.current.onSelect) cbRef.current.onSelect(null);
    });
    // Panning pauses GPS follow (the user took manual control); tapping My Location
    // re-engages it. The map itself never rotates (north-up in v1).
    map.on('dragstart', () => {
      followRef.current = false;
      if (locateStateRef.current !== 'off') pausedRef.current = true;
    });
    mapRef.current = map;
    const invalidateTimer = setTimeout(() => {
      if (mapRef.current !== map) return;
      try {
        map.invalidateSize();
      } catch {
        /* map unmounted during a transition */
      }
    }, 50);
    return () => {
      clearTimeout(invalidateTimer);
      if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
      watchRef.current = null;
      try {
        map.stop();
      } catch {
        /* map may already be mid-teardown */
      }
      map.remove();
      mapRef.current = null;
    };
  }, [compact]);

  // Basemap layer(s) for the active basemap. Re-runs on basemap change and on the
  // [compact] map rebuild so the tiles always re-attach. Online use of Esri tiles
  // is fine; OFFLINE imagery uses public-domain NAIP (see pastureImagery).
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (basemapRef.current) {
      basemapRef.current.forEach((l) => {
        try {
          map.removeLayer(l);
        } catch {
          /* already gone */
        }
      });
      basemapRef.current = null;
    }
    const layers = [];
    if (basemap === 'topo') {
      layers.push(L.tileLayer(ESRI_TOPO_URL, {maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 19, attribution: 'Esri Topo'}));
    } else if (!online) {
      // Offline + satellite: serve the cached NAIP farm tiles.
      layers.push(new OfflineImageryLayer('', {maxZoom: MAP_MAX_ZOOM, maxNativeZoom: 17}));
    } else {
      layers.push(
        L.tileLayer(ESRI_IMAGERY_URL, {
          maxZoom: MAP_MAX_ZOOM,
          maxNativeZoom: IMAGERY_NATIVE_MAX_ZOOM,
          attribution: 'Esri World Imagery - Maxar',
        }),
      );
    }
    layers.forEach((l) => l.addTo(map));
    basemapRef.current = layers;
  }, [basemap, compact, online]);

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

    // Render biggest areas first (bottom) so smaller child paddocks sit ON TOP of
    // their parent pasture and win the click: clicking inside a paddock selects
    // the paddock; clicking the pasture where no paddock covers it selects the
    // pasture. Draft lines (no acreage) sort last -> on top.
    const areaSizeOf = (a) => Number(a.effective_acres ?? a.computed_acres ?? 0);
    const ordered = [...(areas || [])].sort((a, b) => areaSizeOf(b) - areaSizeOf(a));
    ordered.forEach((a) => {
      const g = areaGeom(a);
      if (!g) return;
      // Draft lines (GPS tracks / open lines): shown on the working Map, on Field when
      // the Draft-lines toggle is on, or when the line itself is the current selection.
      if (g.kind === 'line') {
        // Map: the Boundaries "Lines" toggle controls draft-line visibility. Field:
        // its own Draft-lines toggle. The selected line always shows so an in-progress
        // edit/selection can never be hidden by a toggle.
        const lineVisible = !boundaryFilter || boundaryFilter.line !== false;
        const showDraft =
          (appMode === 'view' && lineVisible) || (appMode === 'field' && draftLinesVisible) || a.id === selectedId;
        if (!showDraft) return;
      }
      const occList = occupants[a.id] || [];
      // Current location = the group whose latest move DESTINATION is this area.
      // Overlap-only impacts (the group physically lives in a different, overlapping
      // area) must NOT paint this area as a second current placement of the same
      // group — that made one canonical group (e.g. "Ewes - 58") look located in two
      // places. The overlap still rides along in the hover/tap readout (occList).
      const primaryOcc = occList.find((o) => !o.overlap) || null;
      // className keys the SVG path to the area id so polygon click selection is
      // addressable (Map + Plan inspectors open from clicking the area itself,
      // not a side-panel list).
      const style = {
        ...styleForArea(a, a.id === selectedId, primaryOcc, boundaryFilter),
        className: `pm-area-path pm-area-${a.id}`,
      };
      const lyr = L.geoJSON(
        {type: 'Feature', geometry: g.geometry, properties: {}},
        {style: g.kind === 'line' ? {...style, fill: false} : style},
      );
      // Clean default: do NOT permanently label every area. Names show on hover;
      // occupied areas carry their own always-on group/count marker (below). The
      // currently SELECTED area shows its label permanently.
      // Map (view) shows a rich read-only hover/tap readout; other modes keep the
      // plain name label. The SELECTED area always shows its permanent name label.
      if (appMode === 'view' && g.kind === 'polygon' && a.id !== selectedId) {
        // Read-only Map readout. Wider than the default tooltip (see CSS) and made
        // edge-aware: clampTooltipWithin pins it inside the map container on open and
        // on every sticky move, so it provably cannot render off-screen at the edges.
        lyr.bindTooltip(areaHoverTip(a), {
          direction: 'top',
          className: 'pm-area-hover-tip',
          sticky: true,
          opacity: 1,
        });
        const clampTip = () => clampTooltipWithin(lyr);
        lyr.on('tooltipopen', clampTip);
        lyr.on('mousemove', clampTip);
      } else {
        lyr.bindTooltip(labelFor(a) + (g.kind === 'line' ? ' (outline)' : ''), {
          direction: 'center',
          className: 'pm-map-label',
          permanent: a.id === selectedId,
        });
      }
      lyr.on('click', () => {
        // Merged Map: clicking/tapping an area selects it and opens the working
        // inspector. Desktop hover still shows the read-only readout; the click is the
        // way into the inspector. Suppressed only while a draw/edit/measure/track tool
        // is active (those own map clicks).
        // Flag so the map-background click handler doesn't clear this selection.
        featureClickRef.current = true;
        if (!['draw', 'edit', 'measure', 'track', 'droppin'].includes(mode) && cbRef.current.onSelect)
          cbRef.current.onSelect(a.id);
      });
      lyr.addTo(group);
      let inner = lyr;
      lyr.eachLayer((sub) => {
        inner = sub;
      });
      areaLayersRef.current.set(a.id, inner);

      // Exactly ONE current-location marker per occupied polygon, and only for the
      // DESTINATION occupant (primaryOcc). Overlap-only impacts never get a full
      // "Ewes - 58" marker here, so the same canonical group can never appear placed
      // in two areas. Roster-unmatched destination occupants stay tagged + muted.
      if (primaryOcc && g.kind === 'polygon') {
        const center = layerCenter(inner);
        if (center) {
          const more = occList.length > 1 ? `<span class="pm-occ-more">+${occList.length - 1}</span>` : '';
          const countLabel = primaryOcc.count != null ? ` &middot; ${primaryOcc.count}` : '';
          const tag = primaryOcc.needsReconciliation ? '<span class="pm-occ-tag">needs roster</span>' : '';
          const markerCls = 'pm-occupant-marker' + (primaryOcc.needsReconciliation ? ' is-unmatched' : '');
          L.marker(center, {
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: markerCls,
              html:
                `<span class="pm-occ-pin" style="color:${primaryOcc.color}"></span>` +
                `<span class="pm-occ-name">${primaryOcc.name || ''}${countLabel}</span>${tag}${more}`,
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
  }, [areas, occupants, selectedId, mode, compact, boundaryFilter, appMode, draftLinesVisible, isTouch]);

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
    if (!showRotationPath || !rotationPaths.length) return;
    const group = L.layerGroup();
    // One path per group, in its species color; the active group is emphasized,
    // others dimmed. Next-stop-only collapses each path to a single labelled dot
    // at the group's next planned stop so overlapping paths declutter.
    rotationPaths.forEach((path) => {
      const color = path.color || '#1C8A5F';
      const dim = !path.isActive;
      if (nextStopOnly) {
        const center = layerCenter(areaLayersRef.current.get(path.nextAreaId));
        if (center && Number.isFinite(center.lat) && Number.isFinite(center.lng)) {
          const stopNo = Math.max(1, (path.areaIds || []).indexOf(path.nextAreaId) + 1);
          L.marker(center, {icon: rotationIcon(stopNo, color, dim), interactive: false}).addTo(group);
        }
        return;
      }
      // Keep each stop's rotation number (its position in the order) alongside its
      // centroid so the numbering stays correct even when a stop is skipped.
      const stops = (path.areaIds || [])
        .map((id, i) => ({id, num: i + 1, center: layerCenter(areaLayersRef.current.get(id))}))
        .filter((s) => s.center && Number.isFinite(s.center.lat) && Number.isFinite(s.center.lng));
      if (!stops.length) return;
      if (stops.length >= 2) {
        // Decorative path: must not intercept clicks meant for the area polygons it
        // crosses (it runs through their centroids).
        L.polyline(
          stops.map((s) => s.center),
          {
            color,
            weight: path.isActive ? 3.5 : 2,
            opacity: path.isActive ? 0.95 : 0.5,
            dashArray: '1,8',
            interactive: false,
          },
        ).addTo(group);
      }
      stops.forEach((s) => {
        // Skip the number at the group's CURRENT area: the occupant location pin
        // already marks it, so the pin and number don't stack on the same centroid.
        if (s.id === path.currentAreaId) return;
        L.marker(s.center, {icon: rotationIcon(s.num, color, dim), interactive: false}).addTo(group);
      });
    });
    group.addTo(map);
    rotationRef.current = group;
    return () => {
      if (rotationRef.current === group) {
        group.remove();
        rotationRef.current = null;
      }
    };
  }, [areas, rotationPaths, nextStopOnly, selectedId, showRotationPath]);

  // Saved distance measurements: a layer of dashed LineStrings with name labels,
  // shown on the working Map + Field (a layer, not a grazing destination). Reports has
  // no canvas, so this only renders on Map/Field anyway.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (measureLayerRef.current) {
      measureLayerRef.current.remove();
      measureLayerRef.current = null;
    }
    if (!measurements.length) return;
    const group = L.layerGroup();
    measurements.forEach((mm) => {
      const geom = mm && mm.geometry;
      if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return;
      const latlngs = geom.coordinates
        .map((c) => (Array.isArray(c) ? [Number(c[1]), Number(c[0])] : null))
        .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (latlngs.length < 2) return;
      const color =
        typeof mm.line_color === 'string' && /^#[0-9a-f]{6}$/i.test(mm.line_color) ? mm.line_color : '#7c3aed';
      L.polyline(latlngs, {color, weight: 3, dashArray: '4,6', interactive: false}).addTo(group);
      const mid = latlngs[Math.floor(latlngs.length / 2)];
      L.marker(mid, {
        interactive: false,
        icon: L.divIcon({className: 'pm-measure-label', html: escTip(mm.name || ''), iconSize: [0, 0]}),
      }).addTo(group);
    });
    group.addTo(map);
    measureLayerRef.current = group;
  }, [measurements, appMode]);

  // Transient hover/focus preview: highlight a Current-group's CURRENT area on an
  // amber overlay and surface its name, WITHOUT touching selection. Distinct from
  // the dark selected-area stroke. Cleared on mouse-leave/blur (previewAreaId null)
  // or when it coincides with the actual selection.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previewRef.current) {
      previewRef.current.remove();
      previewRef.current = null;
    }
    const prevTip = previewTooltipRef.current;
    if (prevTip && prevTip.id !== selectedId) {
      try {
        prevTip.layer.closeTooltip();
      } catch {
        /* tooltip already gone */
      }
    }
    previewTooltipRef.current = null;
    if (!previewAreaId || previewAreaId === selectedId) return;
    const layer = areaLayersRef.current.get(previewAreaId);
    if (!layer) return;
    let gj;
    try {
      gj = layer.toGeoJSON();
    } catch {
      gj = null;
    }
    if (!gj) return;
    const overlay = L.geoJSON(gj, {
      style: {color: '#f59e0b', weight: 4, fillColor: '#fbbf24', fillOpacity: 0.25, dashArray: '4,4'},
      interactive: false,
    });
    overlay.addTo(map);
    previewRef.current = overlay;
    // Surface the previewed area's name via its bound readout tooltip (clamped by
    // clampTooltipWithin on tooltipopen, same as a direct hover).
    try {
      layer.openTooltip();
      previewTooltipRef.current = {id: previewAreaId, layer};
    } catch {
      /* no tooltip bound */
    }
    return () => {
      if (previewRef.current === overlay) {
        overlay.remove();
        previewRef.current = null;
      }
    };
  }, [previewAreaId, selectedId, areas, occupants]);

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
      if (dropClickRef.current) {
        map.off('click', dropClickRef.current);
        dropClickRef.current = null;
      }
      if (measureClickRef.current) {
        map.off('click', measureClickRef.current);
        measureClickRef.current = null;
      }
      measureVertsRef.current = [];
      if (dropLayerRef.current) {
        dropLayerRef.current.remove();
        dropLayerRef.current = null;
      }
      dropVertsRef.current = [];
      clearTemp();
    }

    teardown();
    setHud(null);
    const writeMode = mode === 'draw' || mode === 'edit' || mode === 'droppin';
    if (writeMode && !canWrite) return;

    if (mode === 'draw') {
      map.pm.enableDraw('Polygon', {snappable: true, snapDistance: 20, continueDrawing: false});
      map.on('pm:drawstart', ({workingLayer}) => {
        if (!workingLayer) return;
        const upd = () => {
          const m = liveMetricsFromLayer(workingLayer);
          if (m) setHud({...m, live: true, mode: 'draw'});
        };
        workingLayer.on('pm:vertexadded', upd);
        workingLayer.on('pm:change', upd);
      });
      map.on('pm:create', (e) => {
        const layer = e.layer;
        const gj = layer.toGeoJSON().geometry;
        const metrics = polygonMetrics(gj);
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
      });
    } else if (mode === 'measure') {
      // Two-point distance ruler (NOT Geoman, NOT an area/multi-segment tool): tap
      // point A, tap point B, and the measurement freezes automatically into exactly
      // one straight 2-coordinate LineString showing distance only. No 3+ point lines,
      // no polygon behavior, no double-click-to-finish.
      beginMeasure();
    } else if (mode === 'edit' && editAreaId) {
      const layer = areaLayersRef.current.get(editAreaId);
      if (layer && layer.pm) {
        layer.pm.enable({snappable: true, snapDistance: 20, allowSelfIntersection: false});
        editLayerRef.current = layer;
        const onChange = () => {
          const gj = layer.toGeoJSON().geometry;
          // A saved Track / Line edits as a polyline: report distance, not acreage.
          const isLine = !!gj && (gj.type === 'LineString' || gj.type === 'MultiLineString');
          const metrics = isLine ? lineMetrics(gj) : polygonMetrics(gj);
          setHud({...metrics, mode: 'edit', isLine});
          cbRef.current.onEditGeometry && cbRef.current.onEditGeometry(gj, metrics);
        };
        layer.on('pm:markerdragend', onChange);
        layer.on('pm:edit', onChange);
        onChange();
      }
    } else if (mode === 'droppin') {
      // Custom drop-point polygon: vertices come from the Drop point button (map
      // center) and tap-to-place (map clicks). No Geoman draw is enabled here.
      dropVertsRef.current = [];
      renderDropShape();
      const onMapClick = (e) => {
        if (!e || !e.latlng) return;
        dropVertsRef.current = [...dropVertsRef.current, e.latlng];
        renderDropShape();
      };
      map.on('click', onMapClick);
      dropClickRef.current = onMapClick;
    }

    return teardown;
    // beginMeasure/renderDropShape only read refs + stable setters; this effect is
    // intentionally keyed to the tool inputs and must not re-run every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Edge-aware Map readout: pin a layer's open tooltip fully inside the map
  // container (8px margin). Leaflet positions sticky tooltips by transform on every
  // mousemove; we reset our corrective margin, measure, then nudge it back in-bounds,
  // so the readout provably cannot render off-screen at any edge.
  function clampTooltipWithin(layer) {
    const map = mapRef.current;
    const tt = layer && layer.getTooltip && layer.getTooltip();
    const el = tt && tt.getElement && tt.getElement();
    if (!map || !el) return;
    el.style.marginLeft = '0px';
    el.style.marginTop = '0px';
    const mapRect = map.getContainer().getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (r.right > mapRect.right - margin) dx = mapRect.right - margin - r.right;
    if (r.left + dx < mapRect.left + margin) dx = mapRect.left + margin - r.left;
    if (r.bottom > mapRect.bottom - margin) dy = mapRect.bottom - margin - r.bottom;
    if (r.top + dy < mapRect.top + margin) dy = mapRect.top + margin - r.top;
    if (dx) el.style.marginLeft = `${dx}px`;
    if (dy) el.style.marginTop = `${dy}px`;
  }

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

  // Draw the in-progress 2-point ruler: the A/B endpoint dots and, once both are
  // placed, the single straight dashed line between them.
  function renderMeasureShape() {
    const map = mapRef.current;
    if (!map) return;
    if (tempRef.current) {
      try {
        map.removeLayer(tempRef.current);
      } catch {
        /* already gone */
      }
      tempRef.current = null;
    }
    const verts = measureVertsRef.current.slice(0, 2);
    if (!verts.length) return;
    const g = L.layerGroup();
    if (verts.length === 2) {
      L.polyline(verts, {color: '#2563eb', weight: 3, dashArray: '6,6', interactive: false}).addTo(g);
    }
    verts.forEach((ll) => {
      L.circleMarker(ll, {
        radius: 5,
        color: '#1d4ed8',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2,
        interactive: false,
      }).addTo(g);
    });
    g.addTo(map);
    tempRef.current = g;
  }

  // Arm the two-point distance ruler: first map click = point A, second = point B,
  // then the line freezes automatically (further clicks are ignored until Clear).
  function beginMeasure() {
    const map = mapRef.current;
    if (!map) return;
    if (measureClickRef.current) {
      map.off('click', measureClickRef.current);
      measureClickRef.current = null;
    }
    measureVertsRef.current = [];
    measureGeomRef.current = null;
    renderMeasureShape();
    // No HUD until the first point is placed (matches the prior "HUD appears once
    // you start measuring" lifecycle; Clear/Done/Escape all return to no HUD).
    setHud(null);
    const onClick = (e) => {
      if (!e || !e.latlng) return;
      if (measureVertsRef.current.length >= 2) return; // frozen after B
      const verts = [...measureVertsRef.current, e.latlng];
      measureVertsRef.current = verts;
      renderMeasureShape();
      if (verts.length < 2) {
        setHud({distanceFt: 0, points: 1, live: true, mode: 'measure', isLine: true});
        return;
      }
      const gj = {type: 'LineString', coordinates: verts.slice(0, 2).map((ll) => [ll.lng, ll.lat])};
      const m = lineMetrics(gj);
      measureGeomRef.current = gj;
      setHud({distanceFt: m.distanceFt, points: 2, frozen: true, mode: 'measure', isLine: true});
    };
    map.on('click', onClick);
    measureClickRef.current = onClick;
  }

  // Measurement is transient: discard the drawn ruler + reset so the user can measure
  // another A->B. Never persists anything.
  function clearMeasure() {
    const map = mapRef.current;
    if (!map) return;
    if (tempRef.current) {
      try {
        map.removeLayer(tempRef.current);
      } catch {
        /* already gone */
      }
      tempRef.current = null;
    }
    measureVertsRef.current = [];
    measureGeomRef.current = null;
    // Clear removes the HUD entirely (transient — nothing saved); the click handler
    // stays armed so the next two taps start a fresh A->B measurement.
    setHud(null);
  }

  function renderLocateMarker(headingMode = locateStateRef.current === 'heading') {
    const map = mapRef.current;
    const fix = lastFixRef.current;
    if (!map || !fix) return;
    if (locateRef.current) locateRef.current.remove();
    const g = L.layerGroup();
    if (fix.accuracy) {
      L.circle(fix.latlng, {
        radius: fix.accuracy,
        color: '#3b82f6',
        weight: 1,
        fillOpacity: 0.08,
        pane: 'pm-locate-pane',
      }).addTo(g);
    }
    if (headingMode && fix.heading != null && !Number.isNaN(fix.heading)) {
      // Heading cone: a rotated arrow showing facing direction. The map stays
      // north-up (v1 never rotates the map); only the cone rotates.
      L.marker(fix.latlng, {
        interactive: false,
        keyboard: false,
        pane: 'pm-locate-pane',
        icon: L.divIcon({
          className: 'pm-gps-cone',
          html: `<i style="transform:rotate(${Math.round(fix.heading)}deg)"></i>`,
          iconSize: [44, 44],
          iconAnchor: [22, 22],
        }),
      }).addTo(g);
    }
    L.circleMarker(fix.latlng, {
      radius: 7,
      color: '#1d4ed8',
      fillColor: '#3b82f6',
      fillOpacity: 1,
      weight: 2,
      pane: 'pm-locate-pane',
    }).addTo(g);
    g.addTo(map);
    locateRef.current = g;
  }

  function stopWatch() {
    if (watchRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
  }

  function startWatch() {
    const map = mapRef.current;
    if (!map) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsMsg('Location unavailable on this device');
      return;
    }
    if (watchRef.current != null) return;
    setGpsMsg('Locating...');
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        lastFixRef.current = {
          latlng: L.latLng(pos.coords.latitude, pos.coords.longitude),
          accuracy: pos.coords.accuracy || 0,
          heading: pos.coords.heading,
        };
        renderLocateMarker();
        if (followRef.current && mapRef.current) {
          mapRef.current.setView(lastFixRef.current.latlng, Math.max(mapRef.current.getZoom(), 17), {animate: false});
        }
        const ft = Math.round((pos.coords.accuracy || 0) * 3.28084);
        setGpsMsg(ft > 30 ? `GPS ~${ft} ft - let it settle` : `GPS ~${ft} ft`);
      },
      () => setGpsMsg('Location unavailable'),
      {enableHighAccuracy: true, timeout: 15000, maximumAge: 2000},
    );
  }

  // Stateful My Location: off -> center+follow -> heading cone -> off. Panning
  // pauses follow; tapping again re-engages it without advancing the cycle. The
  // map never rotates (north-up); the 'heading' -> off tap is the north reset.
  function cycleLocate() {
    if (locateStateRef.current === 'off') {
      setLocateState('follow');
      followRef.current = true;
      pausedRef.current = false;
      startWatch();
    } else if (pausedRef.current) {
      followRef.current = true;
      pausedRef.current = false;
      if (lastFixRef.current && mapRef.current) {
        mapRef.current.setView(lastFixRef.current.latlng, Math.max(mapRef.current.getZoom(), 17), {animate: false});
      }
    } else if (locateStateRef.current === 'follow') {
      setLocateState('heading');
      renderLocateMarker(true);
    } else {
      setLocateState('off');
      followRef.current = false;
      stopWatch();
      if (locateRef.current) {
        locateRef.current.remove();
        locateRef.current = null;
      }
      setGpsMsg('');
    }
  }

  // Drop Point (custom, Geoman-independent): own the in-progress polygon vertices
  // so the fixed-center crosshair workflow works reliably. The user pans the map
  // under the crosshair and taps Drop point to add a vertex at center; tapping the
  // map (tap-to-place) adds one wherever tapped. Undo pops the last, Save closes
  // the ring (>=3 pts) and hands it up via onDrawComplete, Cancel discards.
  function renderDropShape() {
    const map = mapRef.current;
    if (!map) return;
    if (dropLayerRef.current) {
      dropLayerRef.current.remove();
      dropLayerRef.current = null;
    }
    const verts = dropVertsRef.current;
    if (!verts.length) {
      setHud(null);
      return;
    }
    const g = L.layerGroup();
    if (verts.length >= 3) {
      L.polygon(verts, {
        color: '#2f7a46',
        weight: 3,
        fillColor: '#3F9B5B',
        fillOpacity: 0.22,
        interactive: false,
      }).addTo(g);
    } else if (verts.length === 2) {
      L.polyline(verts, {color: '#2f7a46', weight: 3, interactive: false}).addTo(g);
    }
    verts.forEach((ll) => {
      L.circleMarker(ll, {
        radius: 5,
        color: '#0f5132',
        fillColor: '#ffffff',
        fillOpacity: 1,
        weight: 2,
        interactive: false,
      }).addTo(g);
    });
    g.addTo(map);
    dropLayerRef.current = g;
    if (verts.length >= 3) {
      const m = polygonMetrics(dropPolygonGeoJSON(verts));
      setHud({...m, live: true, mode: 'draw'});
    } else {
      setHud({acres: null, perimeterFt: null, live: true, mode: 'draw'});
    }
  }
  function dropPoint() {
    const map = mapRef.current;
    if (!map) return;
    dropVertsRef.current = [...dropVertsRef.current, map.getCenter()];
    renderDropShape();
  }
  function undoPoint() {
    if (!dropVertsRef.current.length) return;
    dropVertsRef.current = dropVertsRef.current.slice(0, -1);
    renderDropShape();
  }
  function saveShape() {
    const verts = dropVertsRef.current;
    if (verts.length < 3) {
      setGpsMsg('Drop at least 3 points before saving');
      return;
    }
    const gj = dropPolygonGeoJSON(verts);
    const metrics = polygonMetrics(gj);
    // Freeze the HUD; the parent opens the name/save form via onDrawComplete.
    setHud({...metrics, frozen: true, mode: 'draw'});
    if (cbRef.current.onDrawComplete) cbRef.current.onDrawComplete(gj, metrics);
  }
  function cancelDraw() {
    if (dropLayerRef.current) {
      dropLayerRef.current.remove();
      dropLayerRef.current = null;
    }
    dropVertsRef.current = [];
    setHud(null);
    if (onExitTool) onExitTool();
  }

  return (
    <div className={'pm-map-wrap' + (compact ? ' is-compact' : '') + (appMode === 'field' ? ' is-field' : '')}>
      <div ref={elRef} className="pm-map" data-pasture-map-canvas="1" />
      {mode === 'droppin' && !compact && <div className="pm-crosshair" aria-hidden="true" data-pasture-crosshair="1" />}
      {mode === 'droppin' && !compact && canWrite && !(hud && hud.frozen) && (
        <div className="pm-drawbar" data-pasture-drawbar="1">
          <button type="button" className="pm-drawbar-btn is-primary" onClick={dropPoint} data-pasture-drop-point="1">
            Drop point
          </button>
          <button type="button" className="pm-drawbar-btn" onClick={undoPoint} data-pasture-drop-undo="1">
            Undo
          </button>
          <button type="button" className="pm-drawbar-btn is-save" onClick={saveShape} data-pasture-drop-save="1">
            Save
          </button>
          <button type="button" className="pm-drawbar-btn" onClick={cancelDraw} data-pasture-drop-cancel="1">
            Cancel
          </button>
        </div>
      )}
      {hud && (
        <div
          className={'pm-hud' + (mapBanner ? ' is-below-banner' : '')}
          data-pasture-hud="1"
          data-hud-valid={hud.valid === false ? 'false' : 'true'}
        >
          {hud.isLine ? (
            <div className="pm-hud-row">
              <span className="pm-hud-k">Distance</span>
              <span className="pm-hud-v">{hud.distanceFt != null ? `${hud.distanceFt.toLocaleString()} ft` : '-'}</span>
            </div>
          ) : (
            <>
              <div className="pm-hud-row">
                <span className="pm-hud-k">Acres</span>
                <span className="pm-hud-v">{hud.acres != null ? hud.acres.toLocaleString() : '-'}</span>
              </div>
              <div className="pm-hud-row">
                <span className="pm-hud-k">Perimeter</span>
                <span className="pm-hud-v">
                  {hud.perimeterFt != null ? `${hud.perimeterFt.toLocaleString()} ft` : '-'}
                </span>
              </div>
            </>
          )}
          {hud.selfIntersects && <div className="pm-hud-warn">Self-intersecting - fix before saving</div>}
          {hud.mode === 'measure' && (
            <div className="pm-hud-actions" data-pasture-measure-actions="1">
              <button type="button" className="pm-mini-btn" onClick={clearMeasure} data-pasture-measure-clear="1">
                Clear measurement
              </button>
              {hud.frozen && onSaveMeasurement && (
                <button
                  type="button"
                  className="pm-mini-btn is-save"
                  onClick={() => onSaveMeasurement(measureGeomRef.current, hud.distanceFt)}
                  data-pasture-measure-save="1"
                >
                  Save
                </button>
              )}
              <button
                type="button"
                className="pm-mini-btn is-primary"
                onClick={() => onExitTool && onExitTool()}
                data-pasture-measure-done="1"
              >
                Done
              </button>
            </div>
          )}
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
        <div className="pm-control-rail" data-pasture-control-rail="1">
          <div className="pm-rail-group pm-map-controls">
            <button
              type="button"
              className="pm-rail-btn"
              onClick={fitFarm}
              aria-label="Fit Farm"
              title="Fit Farm"
              data-pasture-fit="1"
            >
              {RAIL_ICONS.fit}
            </button>
            <button
              type="button"
              className={'pm-rail-btn pm-locate-btn is-' + locateState}
              onClick={cycleLocate}
              data-pasture-locate="1"
              data-pasture-locate-state={locateState}
              aria-pressed={locateState !== 'off'}
              aria-label={locateState === 'off' ? 'My Location' : locateState === 'follow' ? 'Following' : 'Heading'}
              title={locateState === 'off' ? 'My Location' : locateState === 'follow' ? 'Following' : 'Heading'}
            >
              {RAIL_ICONS.locate}
            </button>
          </div>
          {boundaryFilter && onToggleBoundary && (
            <div className="pm-rail-group pm-rail-pop-anchor">
              <button
                type="button"
                className={'pm-rail-btn' + (layersOpen ? ' is-active' : '')}
                onClick={() => {
                  setLayersOpen((o) => !o);
                  if (!layersOpen && legendOpen && onToggleLegend) onToggleLegend();
                }}
                aria-expanded={layersOpen}
                aria-label="Layers"
                title="Layers"
                data-pasture-layers-toggle="1"
              >
                {RAIL_ICONS.layers}
              </button>
              {layersOpen && (
                <div className="pm-rail-pop pm-layers-pop" data-pasture-layers-pop="1">
                  <div className="pm-pop-title">Layers</div>
                  <div className="pm-pop-group pm-basemap-switch" data-pasture-basemap="1">
                    <span className="pm-pop-label">Base map</span>
                    <div className="pm-basemap-row">
                      {['satellite', 'topo'].map((b) => (
                        <button
                          key={b}
                          type="button"
                          className={'pm-basemap-btn' + (basemap === b ? ' is-active' : '')}
                          onClick={() => setBasemap(b)}
                          data-pasture-basemap-option={b}
                        >
                          {b === 'satellite' ? 'Satellite' : 'Topo'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div
                    className="pm-pop-group pm-boundary-toggle"
                    data-pasture-boundary-toggle="1"
                    role="group"
                    aria-label="Boundary overlay"
                  >
                    <span className="pm-pop-label">Show</span>
                    {[
                      {key: 'pasture', label: 'Pastures'},
                      {key: 'paddock', label: 'Paddocks'},
                      {key: 'temp', label: 'Temp paddocks'},
                      {key: 'line', label: 'Lines'},
                    ].map((b) => {
                      const on = boundaryFilter[b.key] !== false;
                      return (
                        <button
                          key={b.key}
                          type="button"
                          className={'pm-boundary-chip boundary-' + b.key + (on ? ' is-on' : '')}
                          aria-pressed={on}
                          onClick={() => onToggleBoundary(b.key)}
                          data-pasture-boundary={b.key}
                          data-pasture-boundary-on={on ? '1' : '0'}
                        >
                          <i aria-hidden="true" />
                          {b.label}
                        </button>
                      );
                    })}
                    {appMode === 'field' && onToggleDraftLines && (
                      <button
                        type="button"
                        className={'pm-boundary-chip boundary-temp' + (draftLinesVisible ? ' is-on' : '')}
                        aria-pressed={draftLinesVisible}
                        onClick={onToggleDraftLines}
                        data-pasture-draftlines-on={draftLinesVisible ? '1' : '0'}
                        data-pasture-draftlines-toggle="1"
                      >
                        <i aria-hidden="true" />
                        Draft lines
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          <div className="pm-rail-group pm-rail-pop-anchor">
            <button
              type="button"
              className={'pm-rail-btn' + (legendOpen ? ' is-active' : '')}
              onClick={() => {
                onToggleLegend && onToggleLegend();
                if (!legendOpen) setLayersOpen(false);
              }}
              aria-expanded={legendOpen}
              aria-label="Legend"
              title="Legend"
              data-pasture-legend-toggle="1"
            >
              {RAIL_ICONS.legend}
            </button>
            {legendOpen && (
              <div className="pm-rail-pop pm-legend-pop" data-pasture-legend-pop="1">
                <div className="pm-pop-title">Legend</div>
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
                    <i className="state boundary-pasture" /> Pasture boundary
                  </span>
                  <span>
                    <i className="state boundary-paddock" /> Paddock boundary
                  </span>
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
              </div>
            )}
          </div>
        </div>
      )}
      {gpsMsg && <div className="pm-gps-msg">{gpsMsg}</div>}
    </div>
  );
}
