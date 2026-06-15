// Unit tests for the Pasture Map OnX-KML parser. Structure mirrors the real
// export (ExtendedData UUID + notes; Polygons 2D/closed; LineStrings 3D/open).
// The repo's Vitest runs in node (no DOM), so the DOM-parse path is exercised
// with an injected @xmldom/xmldom DOMParser (dev-only); the browser runtime
// uses the global DOMParser with no extra dependency.
import {describe, it, expect} from 'vitest';
import {DOMParser as XmlDomParser} from '@xmldom/xmldom';
import {
  parseKmlToPlacemarks,
  parseAcreageNote,
  strip2D,
  geometryAcres,
  closeOutlineToPolygon,
} from './pastureKml.js';

// One Polygon (2D closed, an Area with a UUID) + one LineString (3D open, the
// OnX "boundary traced as a path" shape, notes carry an acreage).
const SAMPLE_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark><name>HUB</name>
  <ExtendedData>
    <Data name="name"><value>HUB</value></Data>
    <Data name="notes"><value></value></Data>
    <Data name="id"><value>270cb95f-6b89-46f4-84d1-02d48f51d656</value></Data>
    <Data name="type"><value>Area</value></Data>
    <Data name="color"><value>rgba(132,212,0,1)</value></Data>
  </ExtendedData>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    -86.44,30.84 -86.43,30.84 -86.43,30.85 -86.44,30.85 -86.44,30.84
  </coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>
<Placemark><name>FP2</name>
  <ExtendedData>
    <Data name="name"><value>FP2</value></Data>
    <Data name="notes"><value>6-3-22
11.3 ac</value></Data>
    <Data name="id"><value>4befb9c4-0969-4dcf-9a22-a0261f8fb921</value></Data>
    <Data name="color"><value>rgba(132,212,0,1)</value></Data>
  </ExtendedData>
  <LineString><coordinates>
    -86.42,30.84,50 -86.41,30.84,51 -86.41,30.85,52 -86.42,30.85,53
  </coordinates></LineString>
</Placemark>
</Document></kml>`;

describe('parseKmlToPlacemarks', () => {
  const pms = parseKmlToPlacemarks(SAMPLE_KML, XmlDomParser);

  it('parses both placemarks', () => {
    expect(pms).toHaveLength(2);
  });

  it('extracts the OnX UUID as external_id', () => {
    expect(pms[0].external_id).toBe('270cb95f-6b89-46f4-84d1-02d48f51d656');
    expect(pms[1].external_id).toBe('4befb9c4-0969-4dcf-9a22-a0261f8fb921');
  });

  it('classifies polygon vs line and flags outline candidates', () => {
    expect(pms[0].geometry_type).toBe('Polygon');
    expect(pms[0].is_outline_candidate).toBe(false);
    expect(pms[1].geometry_type).toBe('LineString');
    expect(pms[1].is_outline_candidate).toBe(true);
  });

  it('forces line coordinates to 2D (drops OnX Z/elevation)', () => {
    for (const c of pms[1].geometry.coordinates) {
      expect(c).toHaveLength(2);
    }
  });

  it('surfaces the acreage written in OnX notes', () => {
    expect(pms[1].note_acres).toBeCloseTo(11.3, 5);
  });

  it('computes geodesic acres for the polygon, none for the line', () => {
    expect(pms[0].computed_acres).toBeGreaterThan(100);
    expect(pms[0].computed_acres).toBeLessThan(500);
    expect(pms[1].computed_acres).toBeNull();
  });
});

describe('parseAcreageNote', () => {
  it('reads "11.3 ac" and "32.67ac" and "8.25ac"', () => {
    expect(parseAcreageNote('6-3-22\n11.3 ac')).toBeCloseTo(11.3, 5);
    expect(parseAcreageNote('6/7/22\n32.67ac')).toBeCloseTo(32.67, 5);
    expect(parseAcreageNote('8.25ac')).toBeCloseTo(8.25, 5);
  });
  it('returns null when there is no acreage token', () => {
    expect(parseAcreageNote('')).toBeNull();
    expect(parseAcreageNote('just a note')).toBeNull();
    expect(parseAcreageNote(null)).toBeNull();
  });
});

describe('strip2D', () => {
  it('drops the third ordinate at any nesting depth', () => {
    expect(strip2D([1, 2, 3])).toEqual([1, 2]);
    expect(strip2D([[1, 2, 9], [3, 4, 9]])).toEqual([[1, 2], [3, 4]]);
  });
});

describe('closeOutlineToPolygon', () => {
  it('closes an open square line into a valid polygon with positive acres', () => {
    const line = {type: 'LineString', coordinates: [[-86.42, 30.84], [-86.41, 30.84], [-86.41, 30.85], [-86.42, 30.85]]};
    const res = closeOutlineToPolygon(line);
    expect(res.valid).toBe(true);
    expect(res.polygon.type).toBe('Polygon');
    // ring is closed (first === last)
    const ring = res.polygon.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(res.acres).toBeGreaterThan(0);
  });

  it('rejects a self-intersecting (bowtie) outline', () => {
    const bowtie = {type: 'LineString', coordinates: [[0, 0], [1, 1], [1, 0], [0, 1]]};
    const res = closeOutlineToPolygon(bowtie);
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/self-intersect/i);
  });

  it('refuses a non-line geometry', () => {
    const res = closeOutlineToPolygon({type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]});
    expect(res.valid).toBe(false);
  });
});

describe('geometryAcres', () => {
  it('returns null for non-areal geometry', () => {
    expect(geometryAcres({type: 'LineString', coordinates: [[0, 0], [1, 1]]})).toBeNull();
  });
});
