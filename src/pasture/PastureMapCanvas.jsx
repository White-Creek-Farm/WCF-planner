// ============================================================================
// src/pasture/PastureMapCanvas.jsx  —  Pasture Map CP1
// ----------------------------------------------------------------------------
// Read-only Leaflet render of land areas over USGS/NAIP aerial imagery (free,
// public-domain, no API key, covers WCF). Imperative Leaflet (no react-leaflet
// dep). Polygons render from the current geometry version; outline candidates
// render as dashed lines. "You are here" uses the browser Geolocation API with
// an accuracy circle (CP1 field-locate; full offline tile cache is CP5).
//
// NOTE: occupancy / rest-day coloring (occupied / resting<60 / neutral 60+)
// arrives with the move ledger in CP3 — there is no grazing history yet, so CP1
// colors by classification/geometry state and shows every area neutral.
// ============================================================================
import React from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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
  // unclassified + pasture/paddock/etc with valid geometry: neutral green.
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

export default function PastureMapCanvas({areas, onSelect}) {
  const elRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const layerRef = React.useRef(null);
  const locateRef = React.useRef(null);
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  const [gpsMsg, setGpsMsg] = React.useState('');

  React.useEffect(() => {
    if (mapRef.current || !elRef.current) return;
    const map = L.map(elRef.current, {center: WCF_CENTER, zoom: 15, zoomControl: true});
    L.tileLayer(NAIP_URL, {
      maxZoom: 19,
      attribution: 'Imagery: USGS / NAIP (public domain)',
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (layerRef.current) {
      layerRef.current.remove();
      layerRef.current = null;
    }
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
      lyr.on('click', () => onSelectRef.current && onSelectRef.current(a.id));
      lyr.addTo(group);
    });
    group.addTo(map);
    layerRef.current = group;
    try {
      const b = group.getBounds();
      if (b && b.isValid()) map.fitBounds(b, {padding: [30, 30], maxZoom: 17});
    } catch {
      /* no valid bounds yet */
    }
  }, [areas]);

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
      <button type="button" className="pm-locate-btn" onClick={locate}>
        📍 You are here
      </button>
      {gpsMsg && <div className="pm-gps-msg">{gpsMsg}</div>}
    </div>
  );
}
