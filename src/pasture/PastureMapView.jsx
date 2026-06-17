// ============================================================================
// src/pasture/PastureMapView.jsx  —  Pasture Map (CP1 + CP2 draw/edit)
// ----------------------------------------------------------------------------
// CP1: import OnX-KML land, classify, close outlines, delete, GPS locate.
// CP2: select/pan, measure, and (management/admin) draw new polygons + edit
// existing boundaries on the map. Drawn areas require an in-app name + kind
// before save (no raw prompt/alert/confirm). farm_team can view + measure only.
// All geometry writes go through the mig 127 SECDEF RPCs. NO move ledger /
// occupancy / rest / daily-report wiring (CP3+).
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
  createLandArea,
  updateLandAreaGeometry,
  newImportBatchId,
  newLandAreaId,
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

// Kinds a freshly drawn polygon may be saved as (no outline_candidate/scratch).
const DRAW_KINDS = ['unclassified', 'pasture', 'paddock', 'feeder_pig_area', 'section', 'infrastructure'];

// Vertex-edit only applies to areas that already have a polygon (drawn/imported
// or a closed outline). Outline candidates have no polygon layer yet, so Edit is
// disabled for them — they must be closed first.
function hasPolygonGeom(a) {
  if (!a) return false;
  if (a.current_version && a.current_version.geometry) return true;
  const rg = a.raw_geometry;
  return !!(rg && (rg.type === 'Polygon' || rg.type === 'MultiPolygon'));
}

export default function PastureMapView({Header, authState}) {
  const role = authState && authState.role;
  const isManager = role === 'management' || role === 'admin';

  const [areas, setAreas] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [busyId, setBusyId] = React.useState(null);
  const [preview, setPreview] = React.useState(null);
  const [importing, setImporting] = React.useState(false);
  const fileRef = React.useRef(null);

  // CP2 state
  const [mode, setMode] = React.useState('select'); // select | measure | draw | edit
  const [selectedId, setSelectedId] = React.useState(null);
  const [drawForm, setDrawForm] = React.useState(null); // {geometry, metrics, name, kind}
  const [editGeom, setEditGeom] = React.useState(null); // {geometry, metrics}
  const [saving, setSaving] = React.useState(false);

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

  function switchMode(next) {
    setErr('');
    setDrawForm(null);
    setEditGeom(null);
    setMode(next);
  }
  function startEdit() {
    const a = areas.find((x) => x.id === selectedId);
    if (!a) {
      setErr('Select an area first (tap it on the map or in the list), then Edit.');
      return;
    }
    if (!hasPolygonGeom(a)) {
      setErr('That area is an outline with no polygon yet — use "Close outline" first, then Edit.');
      return;
    }
    setErr('');
    setEditGeom(null);
    setMode('edit');
  }

  // ── CP1 import ──
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
  const classify = (a, kind) => withBusy(a.id, () => classifyLandArea(a.id, kind));
  const removeArea = (a) => withBusy(a.id, () => deleteLandArea(a.id));
  function closeOutline(a) {
    const res = closeOutlineToPolygon(a.raw_geometry);
    if (!res.valid) {
      setErr(`Cannot close "${a.name}": ${res.reason}.`);
      return;
    }
    return withBusy(a.id, () => closeLandAreaOutline(a.id, res.polygon, 'unclassified'));
  }

  // ── CP2 draw / edit ──
  function onDrawComplete(geometry, metrics) {
    setDrawForm({geometry, metrics, name: '', kind: 'unclassified'});
  }
  function onEditGeometry(geometry, metrics) {
    setEditGeom({geometry, metrics});
  }
  async function saveDraw() {
    if (!drawForm) return;
    if (!drawForm.name.trim()) {
      setErr('Name is required to save a new area.');
      return;
    }
    if (drawForm.metrics && drawForm.metrics.selfIntersects) {
      setErr('That polygon is self-intersecting. Redraw it before saving.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await createLandArea({
        id: newLandAreaId(),
        name: drawForm.name.trim(),
        polygon: drawForm.geometry,
        kind: drawForm.kind,
        source: 'drawn',
      });
      setDrawForm(null);
      setMode('select');
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not save the drawn area.');
    } finally {
      setSaving(false);
    }
  }
  function cancelDraw() {
    setDrawForm(null);
    setMode('select');
  }
  async function saveEdit() {
    if (!selectedId) return;
    if (!editGeom) {
      // No vertex change captured — nothing to save.
      setMode('select');
      await reload();
      return;
    }
    if (editGeom.metrics && editGeom.metrics.selfIntersects) {
      setErr('The edited boundary is self-intersecting. Fix it before saving.');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await updateLandAreaGeometry(selectedId, editGeom.geometry);
      setEditGeom(null);
      setMode('select');
      await reload();
    } catch (e) {
      setErr(e.message || 'Could not save the edited boundary.');
    } finally {
      setSaving(false);
    }
  }
  async function cancelEdit() {
    setEditGeom(null);
    setMode('select');
    await reload(); // discard in-place vertex drags by re-rendering from the DB
  }

  const counts = areas.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});
  const selectedArea = areas.find((a) => a.id === selectedId) || null;
  const selectedEditable = hasPolygonGeom(selectedArea);

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
            {/* CP2 mode toolbar — stable height so the map doesn't jump. */}
            <div className="pm-toolbar" data-pasture-toolbar="1">
              <button
                type="button"
                className={'pm-mode' + (mode === 'select' ? ' is-active' : '')}
                onClick={() => switchMode('select')}
                data-mode="select"
              >
                Select
              </button>
              <button
                type="button"
                className={'pm-mode' + (mode === 'measure' ? ' is-active' : '')}
                onClick={() => switchMode('measure')}
                data-mode="measure"
              >
                Measure
              </button>
              {isManager && (
                <>
                  <button
                    type="button"
                    className={'pm-mode' + (mode === 'draw' ? ' is-active' : '')}
                    onClick={() => switchMode('draw')}
                    data-mode="draw"
                  >
                    Draw
                  </button>
                  <button
                    type="button"
                    className={'pm-mode' + (mode === 'edit' ? ' is-active' : '')}
                    onClick={startEdit}
                    disabled={!selectedId || !selectedEditable}
                    title={selectedId && !selectedEditable ? 'Close this outline first to edit its polygon' : undefined}
                    data-mode="edit"
                  >
                    Edit{selectedArea ? ` · ${selectedArea.name || 'selected'}` : ''}
                  </button>
                </>
              )}
              <span className="pm-toolbar-hint">
                {mode === 'draw'
                  ? 'Tap to add points; tap the first point to finish.'
                  : mode === 'edit'
                    ? 'Drag the white handles to reshape.'
                    : mode === 'measure'
                      ? 'Draw a shape to read its acres/perimeter.'
                      : 'Tap an area to select it.'}
              </span>
            </div>

            {/* Draw save form — in-app, never a raw prompt. */}
            {isManager && drawForm && (
              <div className="pm-drawform" data-pasture-drawform="1">
                <div className="pm-drawform-row">
                  <label className="pm-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={drawForm.name}
                      maxLength={200}
                      placeholder="e.g. ET-12"
                      onChange={(e) => setDrawForm((f) => ({...f, name: e.target.value}))}
                      data-pasture-drawform-name="1"
                      autoFocus
                    />
                  </label>
                  <label className="pm-field">
                    <span>Kind</span>
                    <select
                      value={drawForm.kind}
                      onChange={(e) => setDrawForm((f) => ({...f, kind: e.target.value}))}
                      data-pasture-drawform-kind="1"
                    >
                      {DRAW_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="pm-drawform-metric">
                    {drawForm.metrics && drawForm.metrics.acres != null ? `${drawForm.metrics.acres} ac` : ''}
                  </span>
                </div>
                {drawForm.metrics && drawForm.metrics.selfIntersects && (
                  <div className="pm-drawform-warn">Self-intersecting polygon — redraw before saving.</div>
                )}
                <div className="pm-drawform-actions">
                  <button type="button" className="pm-btn" onClick={cancelDraw} disabled={saving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pm-btn pm-btn-primary"
                    onClick={saveDraw}
                    disabled={saving || !drawForm.name.trim() || (drawForm.metrics && drawForm.metrics.selfIntersects)}
                    data-pasture-drawform-save="1"
                  >
                    {saving ? 'Saving…' : 'Save area'}
                  </button>
                </div>
              </div>
            )}

            {/* Edit save/cancel bar. */}
            {isManager && mode === 'edit' && selectedArea && !drawForm && (
              <div className="pm-editbar" data-pasture-editbar="1">
                <span className="pm-editbar-label">
                  Editing <strong>{selectedArea.name || 'area'}</strong>
                  {editGeom && editGeom.metrics && editGeom.metrics.acres != null
                    ? ` · ${editGeom.metrics.acres} ac`
                    : ''}
                </span>
                <div className="pm-editbar-actions">
                  <button type="button" className="pm-btn" onClick={cancelEdit} disabled={saving}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="pm-btn pm-btn-primary"
                    onClick={saveEdit}
                    disabled={saving || (editGeom && editGeom.metrics && editGeom.metrics.selfIntersects)}
                    data-pasture-editbar-save="1"
                  >
                    {saving ? 'Saving…' : 'Save boundary'}
                  </button>
                </div>
              </div>
            )}

            <PastureMapCanvas
              areas={areas}
              mode={mode}
              canWrite={isManager}
              editAreaId={mode === 'edit' ? selectedId : null}
              onSelect={setSelectedId}
              onDrawComplete={onDrawComplete}
              onEditGeometry={onEditGeometry}
            />
          </section>

          <section className="pm-list-col">
            {!loading && areas.length === 0 && (
              <div className="pm-empty">
                No land areas yet.{' '}
                {isManager
                  ? 'Import an OnX KML export or draw one to get started.'
                  : 'Ask a manager to set up the farm map.'}
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
                const isSel = a.id === selectedId;
                return (
                  <li
                    key={a.id}
                    className={'pm-item' + (isSel ? ' is-selected' : '')}
                    data-pasture-area={a.id}
                    data-kind={a.kind}
                  >
                    <button
                      type="button"
                      className="pm-item-main pm-item-select"
                      onClick={() => setSelectedId(a.id)}
                      data-pasture-area-select={a.id}
                    >
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
                    </button>
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
