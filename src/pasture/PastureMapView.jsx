// ============================================================================
// src/pasture/PastureMapView.jsx  —  Pasture Map CP1 (/pasture-map)
// ----------------------------------------------------------------------------
// The Pasture Map home surface. CP1 scope: import OnX-KML land, name/classify
// imported shapes, see them on USGS/NAIP aerial imagery with acreage, close
// LineString outline candidates into polygons, and GPS "you are here". NO move
// ledger / occupancy / rest / daily-report wiring (CP3+). farm_team+ can read;
// classify/close/delete are management/admin only.
// ============================================================================
import React from 'react';
import PastureMapCanvas from './PastureMapCanvas.jsx';
import {parseKmlToPlacemarks, parseAcreageNote, closeOutlineToPolygon} from '../lib/pastureKml.js';
import {
  listLandAreas,
  importLandAreaBatch,
  classifyLandArea,
  closeLandAreaOutline,
  deleteLandArea,
  newImportBatchId,
} from '../lib/pastureMapApi.js';
import './pastureMap.css';

const KIND_LABEL = {
  unclassified: 'Unclassified',
  pasture: 'Pasture',
  feeder_pig_area: 'Feeder Pig Area',
  section: 'Section',
  paddock: 'Paddock',
  infrastructure: 'Infrastructure',
  scratch: 'Scratch',
  outline_candidate: 'Outline (needs close)',
};

export default function PastureMapView({Header, authState}) {
  const role = authState && authState.role;
  const isManager = role === 'management' || role === 'admin';

  const [areas, setAreas] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [busyId, setBusyId] = React.useState(null);
  const [preview, setPreview] = React.useState(null); // {fileName, placemarks, polygons, lines}
  const [importing, setImporting] = React.useState(false);
  const fileRef = React.useRef(null);

  async function reload() {
    setLoading(true);
    setErr('');
    try {
      const res = await listLandAreas(false);
      setAreas((res && res.land_areas) || []);
    } catch (e) {
      setErr(e.message || 'Failed to load land areas');
    } finally {
      setLoading(false);
    }
  }
  React.useEffect(() => {
    reload();
  }, []);

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setErr('');
    try {
      const text = await file.text();
      const placemarks = parseKmlToPlacemarks(text);
      if (!placemarks.length) {
        setErr('No placemarks found in that KML. Export Area Shapes/Lines from the OnX Web Map.');
        return;
      }
      setPreview({
        fileName: file.name,
        placemarks,
        polygons: placemarks.filter((p) => !p.is_outline_candidate).length,
        lines: placemarks.filter((p) => p.is_outline_candidate).length,
      });
    } catch (e2) {
      setErr('Could not parse that file as KML: ' + (e2.message || e2));
    }
  }

  async function confirmImport() {
    if (!preview) return;
    setImporting(true);
    setErr('');
    try {
      await importLandAreaBatch({
        batchId: newImportBatchId(),
        source: 'onx_kml',
        fileName: preview.fileName,
        placemarks: preview.placemarks,
      });
      setPreview(null);
      await reload();
    } catch (e) {
      setErr(e.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  async function withBusy(id, fn) {
    setBusyId(id);
    setErr('');
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  function classify(a, kind) {
    return withBusy(a.id, () => classifyLandArea(a.id, kind));
  }
  function removeArea(a) {
    return withBusy(a.id, () => deleteLandArea(a.id));
  }
  function closeOutline(a) {
    const line = a.raw_geometry;
    const res = closeOutlineToPolygon(line);
    if (!res.valid) {
      setErr(`Cannot close "${a.name}": ${res.reason}. Vertex editing arrives in the next checkpoint.`);
      return;
    }
    return withBusy(a.id, () => closeLandAreaOutline(a.id, res.polygon, 'unclassified'));
  }

  const counts = areas.reduce((m, a) => {
    m[a.kind] = (m[a.kind] || 0) + 1;
    return m;
  }, {});

  return (
    <div className="pm-view">
      <Header />
      <main className="pm-main">
        <div className="pm-head">
          <div>
            <h1 className="pm-title">Pasture Map</h1>
            <div className="pm-sub">
              {loading ? 'Loading…' : `${areas.length} land area${areas.length === 1 ? '' : 's'}`}
              {counts.outline_candidate
                ? ` · ${counts.outline_candidate} outline${counts.outline_candidate === 1 ? '' : 's'} to close`
                : ''}
              {counts.unclassified ? ` · ${counts.unclassified} to classify` : ''}
            </div>
          </div>
          {isManager && (
            <div className="pm-head-actions">
              <input
                ref={fileRef}
                type="file"
                accept=".kml,application/vnd.google-earth.kml+xml"
                onChange={onFile}
                style={{display: 'none'}}
                data-pasture-import-input="1"
              />
              <button
                type="button"
                className="pm-btn pm-btn-primary"
                onClick={() => fileRef.current && fileRef.current.click()}
              >
                Import OnX KML
              </button>
            </div>
          )}
        </div>

        {err && (
          <div className="pm-error" role="alert">
            {err}
          </div>
        )}

        {preview && (
          <div className="pm-preview" data-pasture-import-preview="1">
            <div className="pm-preview-body">
              <strong>{preview.fileName}</strong> — {preview.placemarks.length} placemarks: {preview.polygons} polygon
              {preview.polygons === 1 ? '' : 's'} (import directly), {preview.lines} line
              {preview.lines === 1 ? '' : 's'} (import as outline candidates to close). Imported shapes land{' '}
              <em>unclassified</em> for review.
            </div>
            <div className="pm-preview-actions">
              <button type="button" className="pm-btn" onClick={() => setPreview(null)} disabled={importing}>
                Cancel
              </button>
              <button type="button" className="pm-btn pm-btn-primary" onClick={confirmImport} disabled={importing}>
                {importing ? 'Importing…' : `Import ${preview.placemarks.length}`}
              </button>
            </div>
          </div>
        )}

        <div className="pm-body">
          <section className="pm-map-col">
            <PastureMapCanvas areas={areas} onSelect={() => {}} />
          </section>

          <section className="pm-list-col">
            {!loading && areas.length === 0 && (
              <div className="pm-empty">
                No land areas yet.{' '}
                {isManager ? 'Import an OnX KML export to get started.' : 'Ask a manager to import the farm map.'}
              </div>
            )}
            <ul className="pm-list">
              {areas.map((a) => {
                const noteAc = parseAcreageNote(a.raw_notes);
                const acres = a.effective_acres;
                const mismatch =
                  noteAc != null && acres != null && Math.abs(noteAc - acres) / Math.max(noteAc, 1) > 0.05;
                const isOutline = a.kind === 'outline_candidate' || a.geometry_status === 'outline_candidate';
                const busy = busyId === a.id;
                return (
                  <li key={a.id} className="pm-item" data-pasture-area={a.id} data-kind={a.kind}>
                    <div className="pm-item-main">
                      <div className="pm-item-name">{a.name || 'Unnamed'}</div>
                      <div className="pm-item-meta">
                        <span className={'pm-chip pm-chip-' + a.kind}>{KIND_LABEL[a.kind] || a.kind}</span>
                        {a.review_status === 'pending_review' && (
                          <span className="pm-chip pm-chip-review">Needs review</span>
                        )}
                        {acres != null && <span className="pm-acres">{acres} ac</span>}
                        {mismatch && <span className="pm-note-acres">OnX note: {noteAc} ac</span>}
                        {a.geometry_status === 'invalid' && (
                          <span className="pm-chip pm-chip-invalid">Invalid geometry</span>
                        )}
                      </div>
                    </div>
                    {isManager && (
                      <div className="pm-item-actions">
                        {isOutline ? (
                          <button
                            type="button"
                            className="pm-btn pm-btn-sm"
                            onClick={() => closeOutline(a)}
                            disabled={busy}
                          >
                            Close outline
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="pm-btn pm-btn-sm"
                              onClick={() => classify(a, 'pasture')}
                              disabled={busy}
                            >
                              Pasture
                            </button>
                            <button
                              type="button"
                              className="pm-btn pm-btn-sm"
                              onClick={() => classify(a, 'paddock')}
                              disabled={busy}
                            >
                              Paddock
                            </button>
                            <button
                              type="button"
                              className="pm-btn pm-btn-sm"
                              onClick={() => classify(a, 'infrastructure')}
                              disabled={busy}
                            >
                              Infra
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="pm-btn pm-btn-sm pm-btn-danger"
                          onClick={() => removeArea(a)}
                          disabled={busy}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
