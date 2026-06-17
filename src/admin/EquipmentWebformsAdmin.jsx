// EquipmentWebformsAdmin — centralized admin editor for every equipment
// piece's /fueling webform config. Lives under the /webforms admin tab.
//
// Lets admin edit, per selected piece:
//   • Identity: name, serial, status (active / retired)
//   • Webform help text: operator_notes (top banner) + fuel_gallons_help
//   • Every-fillup items + every_fillup_help
//   • Service intervals (per-interval help_text + per-task add/remove/edit)
//   • Attachment checklists (for Ventrac etc.)
//
// One dropdown at the top picks which equipment piece is being edited. All
// saves auto-persist on blur and reload the row from Supabase.

import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import {EQUIPMENT_CATEGORIES} from '../lib/equipment.js';
import EquipmentMaterialsEditor from './EquipmentMaterialsEditor.jsx';
import {runMutation, recordFieldChange, recordStatusChange} from '../lib/entityMutations.js';
import {countSummary, makeFieldChange} from '../lib/activityChangeDiff.js';

const inpS = {
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: 10,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  width: '100%',
};
const sectionTitle = {
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--ink-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};
const subTitle = {
  fontSize: 10,
  color: 'var(--ink-muted)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 4,
};
const card = {
  background: 'white',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '14px 20px',
  marginBottom: 14,
};

function applySavedEquipmentPatch(onLocalPatch, onReload, patch) {
  if (typeof onLocalPatch === 'function') {
    onLocalPatch(patch);
    return;
  }
  if (typeof onReload === 'function') onReload();
}

export default function EquipmentWebformsAdmin() {
  const [equipment, setEquipment] = React.useState([]);
  const [selectedId, setSelectedId] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [missingSchema, setMissingSchema] = React.useState(false);
  const didInitialLoadRef = React.useRef(false);
  const modalScrollRef = React.useRef(null);
  const pendingReloadScrollTopRef = React.useRef(null);

  const loadAll = React.useCallback(async () => {
    const isInitialLoad = !didInitialLoadRef.current;
    if (isInitialLoad) {
      setLoading(true);
    } else if (modalScrollRef.current) {
      pendingReloadScrollTopRef.current = modalScrollRef.current.scrollTop;
    }
    const {data, error} = await sb.from('equipment').select('*').order('category').order('name');
    if (error && /does not exist|relation/i.test(error.message || '')) {
      setMissingSchema(true);
      setLoading(false);
      return;
    }
    setEquipment(data || []);
    didInitialLoadRef.current = true;
    setLoading(false);
  }, []);
  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  React.useLayoutEffect(() => {
    if (pendingReloadScrollTopRef.current == null || !modalScrollRef.current) return;
    const top = pendingReloadScrollTopRef.current;
    pendingReloadScrollTopRef.current = null;
    modalScrollRef.current.scrollTop = top;
  }, [equipment]);

  const patchEquipmentLocal = React.useCallback((id, patch) => {
    setEquipment((prev) => prev.map((e) => (e.id === id ? {...e, ...patch} : e)));
  }, []);

  const selected = equipment.find((e) => e.id === selectedId) || null;

  // Close modal on Esc key.
  React.useEffect(() => {
    if (!selected) return;
    const h = (e) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [selected]);

  if (missingSchema) {
    return (
      <div style={{padding: 20, fontSize: 13, color: '#b91c1c'}}>
        Equipment schema not applied. Run migrations 016–021 in Supabase.
      </div>
    );
  }
  if (loading) return <div style={{padding: 20, fontSize: 13, color: 'var(--ink-muted)'}}>Loading equipment…</div>;

  const soldList = equipment
    .filter((e) => e.status === 'sold')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div>
      {/* FuelSupplyAdminSection retired 2026-04-29. The team-member roster it
          referenced was retired 2026-06-06 — submitters are now login-locked. */}
      <div style={card}>
        <div style={sectionTitle}>
          Equipment{' '}
          <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
            Click a piece to edit
          </span>
        </div>
        {EQUIPMENT_CATEGORIES.map((cat) => {
          const inCat = equipment
            .filter((e) => e.category === cat.key && e.status !== 'sold')
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
          if (inCat.length === 0) return null;
          return (
            <div key={cat.key} style={{marginBottom: 12}}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: cat.color,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  marginBottom: 5,
                }}
              >
                {cat.icon} {cat.label}
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 3}}>
                {inCat.map((e) => {
                  const on = selectedId === e.id;
                  return (
                    <div
                      key={e.id}
                      {...openableProps(() => setSelectedId(e.id))}
                      className="hoverable-tile"
                      style={{
                        padding: '7px 12px',
                        border: '1px solid ' + (on ? cat.color : 'var(--border)'),
                        background: 'white',
                        borderRadius: 10,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontSize: 13,
                      }}
                    >
                      <span style={{fontWeight: on ? 700 : 500, color: 'var(--ink)', flex: 1}}>{e.name}</span>
                      {e.status !== 'active' && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 999,
                            background: '#fef3c7',
                            color: '#92400e',
                            textTransform: 'uppercase',
                            fontWeight: 600,
                          }}
                        >
                          {e.status}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {soldList.length > 0 && (
          <div style={{marginTop: 18, paddingTop: 12, borderTop: '1px solid var(--border)'}}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--ink-muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                marginBottom: 5,
              }}
            >
              Sold
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 3}}>
              {soldList.map((e) => {
                const on = selectedId === e.id;
                return (
                  <div
                    key={e.id}
                    {...openableProps(() => setSelectedId(e.id))}
                    className="hoverable-tile"
                    style={{
                      padding: '7px 12px',
                      border: '1px solid ' + (on ? '#6b7280' : 'var(--border)'),
                      background: on ? '#f3f4f6' : 'white',
                      borderRadius: 10,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                      color: 'var(--ink-muted)',
                    }}
                  >
                    <span style={{fontWeight: on ? 700 : 500, flex: 1}}>{e.name}</span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: '#e5e7eb',
                        color: '#6b7280',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                      }}
                    >
                      sold
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div style={{fontSize: 11, color: 'var(--ink-faint)', marginTop: 10}}>
          Changes auto-save on blur. Live on /equipment/&lt;slug&gt; immediately after save.
        </div>
      </div>

      {selected && (
        <div
          ref={modalScrollRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedId(null);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(17,24,39,.6)',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            padding: '24px 16px',
            overflowY: 'auto',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: 'var(--bg-page)',
              borderRadius: 14,
              width: '100%',
              maxWidth: 880,
              boxShadow: '0 20px 40px rgba(0,0,0,.3)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                position: 'sticky',
                top: 0,
                zIndex: 2,
                background: 'white',
                borderBottom: '1px solid var(--border)',
                padding: '14px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{flex: 1, minWidth: 0}}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: 'var(--ink-muted)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}
                >
                  Editing
                </div>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {selected.name}
                </div>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                style={{
                  fontSize: 14,
                  padding: '6px 14px',
                  borderRadius: 10,
                  border: '1px solid var(--border-strong)',
                  background: 'white',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 600,
                }}
                title="Close (Esc)"
              >
                ✕ Close
              </button>
            </div>
            <div style={{padding: '14px 20px'}}>
              <IdentityEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <SpecsEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <ManualsEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <DocumentsEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <WebformHelpTextEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <EveryFillupEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              <ServiceIntervalEditor
                equipment={selected}
                onReload={loadAll}
                onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
              />
              {Array.isArray(selected.attachment_checklists) && selected.attachment_checklists.length > 0 && (
                <AttachmentChecklistsEditor
                  equipment={selected}
                  onReload={loadAll}
                  onLocalPatch={(patch) => patchEquipmentLocal(selected.id, patch)}
                />
              )}
              <EquipmentMaterialsEditor equipment={selected} onReload={loadAll} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── identity: name / serial / status ───────────────────────────────────────
function IdentityEditor({equipment, onReload, onLocalPatch}) {
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  async function save(col, val) {
    setNotice(null);
    const payload = typeof val === 'string' && !val.trim() ? null : val;
    const oldVal = equipment[col];
    setBusy(true);
    const result = await runMutation(
      () =>
        sb
          .from('equipment')
          .update({[col]: payload})
          .eq('id', equipment.id),
      {
        activity: () => {
          if (col === 'status') {
            return recordStatusChange(sb, {
              entityType: 'equipment.item',
              entityId: equipment.id,
              entityLabel: equipment.name,
              from: oldVal,
              to: payload,
            });
          }
          if (oldVal === payload || (oldVal == null && payload == null)) return;
          const lbl = col === 'name' ? payload || equipment.name : equipment.name;
          return recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: lbl,
            changes: [makeFieldChange(col, col === 'serial_number' ? 'Serial number' : 'Name', oldVal, payload)],
          });
        },
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {[col]: payload});
  }
  return (
    <div style={card}>
      <div style={sectionTitle}>
        Identity{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Equipment name · serial · status
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div style={{display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', rowGap: 10}}>
        <div style={subTitle}>Name</div>
        <input
          type="text"
          defaultValue={equipment.name || ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== (equipment.name || '')) save('name', v);
          }}
          style={inpS}
        />
        <div style={subTitle}>Serial</div>
        <input
          type="text"
          defaultValue={equipment.serial_number || ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (equipment.serial_number || '')) save('serial_number', v);
          }}
          style={inpS}
        />
        <div style={subTitle}>Status</div>
        <select
          value={equipment.status}
          disabled={busy}
          onChange={(e) => save('status', e.target.value)}
          style={{...inpS, maxWidth: 180}}
        >
          <option value="active">active</option>
          <option value="sold">sold</option>
        </select>
      </div>
    </div>
  );
}

// ── specs & fluids (filters, oils, capacities, warranty) ─────────────────
// Part numbers, oil types, tank capacities, warranty info. Debounced
// auto-save on blur, matching the inline /equipment/<slug> spec panel.
function SpecsEditor({equipment, onReload, onLocalPatch}) {
  const [_busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  async function save(col, val) {
    setNotice(null);
    setBusy(true);
    const payload = typeof val === 'string' && !val.trim() ? null : val;
    const oldVal = equipment[col];
    const result = await runMutation(
      () =>
        sb
          .from('equipment')
          .update({[col]: payload})
          .eq('id', equipment.id),
      {
        activity: () => {
          if (oldVal === payload || (oldVal == null && payload == null)) return;
          return recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [makeFieldChange(col, col.replace(/_/g, ' '), oldVal, payload)],
          });
        },
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {[col]: payload});
  }
  const FIELDS = [
    ['engine_oil', 'Engine Oil'],
    ['oil_filter', 'Oil Filter'],
    ['hydraulic_oil', 'Hydraulic Oil'],
    ['hydraulic_filter', 'Hydraulic Filter'],
    ['coolant', 'Coolant'],
    ['brake_fluid', 'Brake Fluid'],
    ['fuel_filter', 'Fuel Filter'],
    ['def_filter', 'DEF Filter'],
    ['gearbox_drive_oil', 'Gearbox / Drive Oil'],
    ['air_filters', 'Air Filters'],
    ['warranty_description', 'Warranty note'],
  ];
  const taS = {...inpS, resize: 'vertical'};
  return (
    <div style={card}>
      <div style={sectionTitle}>
        Specs &amp; Fluids{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Part numbers, oils, capacities — auto-saves on blur
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px 14px'}}>
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <div style={subTitle}>{label}</div>
            <textarea
              rows={1}
              defaultValue={equipment[k] || ''}
              onBlur={(e) => {
                const v = e.target.value;
                if (v.trim() !== (equipment[k] || '')) save(k, v);
              }}
              style={taS}
            />
          </div>
        ))}
        <div>
          <div style={subTitle}>Fuel tank (gal)</div>
          <input
            type="number"
            min="0"
            step="0.1"
            defaultValue={equipment.fuel_tank_gal != null ? equipment.fuel_tank_gal : ''}
            onBlur={(e) => {
              const v = e.target.value === '' ? null : Number(e.target.value);
              if (v !== equipment.fuel_tank_gal) save('fuel_tank_gal', v);
            }}
            style={inpS}
          />
        </div>
        {equipment.takes_def && (
          <div>
            <div style={subTitle}>DEF tank (gal)</div>
            <input
              type="number"
              min="0"
              step="0.1"
              defaultValue={equipment.def_tank_gal != null ? equipment.def_tank_gal : ''}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== equipment.def_tank_gal) save('def_tank_gal', v);
              }}
              style={inpS}
            />
          </div>
        )}
        <div>
          <div style={subTitle}>Warranty ends</div>
          <input
            type="date"
            defaultValue={equipment.warranty_expiration || ''}
            onBlur={(e) => {
              const v = e.target.value || null;
              if (v !== equipment.warranty_expiration) save('warranty_expiration', v);
            }}
            style={inpS}
          />
        </div>
      </div>
    </div>
  );
}

// ── manuals & videos (operator reference materials) ──────────────────────
// PDFs go into Supabase Storage at manuals/<slug>/<timestamp>-<safe-name>.
// Videos are YouTube URLs only — we derive the thumbnail at render time.
function youtubeId(url) {
  if (!url) return null;
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/,
  ];
  for (const re of patterns) {
    const m = re.exec(url);
    if (m) return m[1];
  }
  return null;
}

function ManualsEditor({equipment, onReload, onLocalPatch}) {
  const [busy, setBusy] = React.useState(false);
  const [newVideoUrl, setNewVideoUrl] = React.useState('');
  const [newVideoTitle, setNewVideoTitle] = React.useState('');
  const [uploading, setUploading] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const manuals = Array.isArray(equipment.manuals) ? equipment.manuals : [];

  async function persist(next) {
    setNotice(null);
    setBusy(true);
    const result = await runMutation(() => sb.from('equipment').update({manuals: next}).eq('id', equipment.id), {
      activity: () =>
        recordFieldChange(sb, {
          entityType: 'equipment.item',
          entityId: equipment.id,
          entityLabel: equipment.name,
          changes: [
            makeFieldChange('manuals', 'Manuals', countSummary(manuals, 'manual'), countSummary(next, 'manual')),
          ],
        }),
      onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
    });
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {manuals: next});
  }

  async function uploadPdf(file) {
    if (!file) return;
    setNotice(null);
    setUploading(true);
    const safe = (file.name || 'manual.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const bucketPath = 'manuals/' + equipment.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(bucketPath, file, {upsert: false, contentType: file.type || 'application/pdf'});
    if (upErr) {
      setNotice({kind: 'error', message: 'Upload failed: ' + upErr.message});
      setUploading(false);
      return;
    }
    const {data: pub} = sb.storage.from('equipment-maintenance-docs').getPublicUrl(bucketPath);
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const next = [
      ...manuals,
      {type: 'pdf', title, url: pub.publicUrl, path: bucketPath, uploadedAt: new Date().toISOString()},
    ];
    await persist(next);
    setUploading(false);
  }

  async function addVideo() {
    const url = newVideoUrl.trim();
    if (!url) return;
    setNotice(null);
    const vid = youtubeId(url);
    if (!vid) {
      setNotice({
        kind: 'error',
        message: 'Doesn’t look like a YouTube URL. Try https://youtu.be/... or https://youtube.com/watch?v=...',
      });
      return;
    }
    const title = newVideoTitle.trim() || url;
    await persist([...manuals, {type: 'video', title, url, youtube_id: vid}]);
    setNewVideoUrl('');
    setNewVideoTitle('');
  }

  async function editTitle(idx, title) {
    const next = manuals.slice();
    next[idx] = {...next[idx], title};
    await persist(next);
  }

  async function removeOne(idx) {
    const entry = manuals[idx];
    if (!entry) return;
    window._wcfConfirmDelete('Remove "' + (entry.title || 'this manual') + '"?', async () => {
      if (entry.type === 'pdf' && entry.path) {
        try {
          await sb.storage.from('equipment-maintenance-docs').remove([entry.path]);
        } catch (e) {
          /*ignore*/
        }
      }
      await persist(manuals.filter((_, i) => i !== idx));
    });
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Manuals &amp; Videos{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Operator reference — shows on /equipment and /fleet
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {manuals.length === 0 && (
        <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 8}}>
          No manuals or videos added yet.
        </div>
      )}
      {manuals.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10}}>
          {manuals.map((m, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 1fr 80px',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                background: '#fafafa',
                border: '1px solid var(--border)',
                borderRadius: 10,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 999,
                  textAlign: 'center',
                  background: m.type === 'pdf' ? '#fef3c7' : '#fee2e2',
                  color: m.type === 'pdf' ? '#92400e' : '#991b1b',
                }}
              >
                {m.type === 'pdf' ? '📄 PDF' : '▶ VIDEO'}
              </span>
              <div>
                <input
                  type="text"
                  defaultValue={m.title || ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== (m.title || '')) editTitle(i, v);
                  }}
                  style={{...inpS, padding: '3px 7px', fontSize: 12}}
                />
                <a
                  href={m.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{fontSize: 10, color: 'var(--brand)', textDecoration: 'none', wordBreak: 'break-all'}}
                >
                  {m.url}
                </a>
              </div>
              <button
                onClick={() => removeOne(i)}
                disabled={busy}
                style={{
                  padding: '4px 8px',
                  borderRadius: 10,
                  border: '1px solid #fecaca',
                  background: 'white',
                  color: '#b91c1c',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
        <div style={{padding: '10px', background: '#fffbeb', borderRadius: 10, border: '1px dashed #fde68a'}}>
          <div style={{...subTitle, color: '#92400e'}}>Upload PDF</div>
          <input
            type="file"
            accept="application/pdf"
            disabled={uploading || busy}
            onChange={(e) => {
              if (e.target.files && e.target.files[0]) uploadPdf(e.target.files[0]);
              e.target.value = '';
            }}
            style={{fontSize: 12}}
          />
          {uploading && <div style={{fontSize: 10, color: '#92400e', marginTop: 4}}>Uploading…</div>}
        </div>
        <div style={{padding: '10px', background: '#fef2f2', borderRadius: 10, border: '1px dashed #fecaca'}}>
          <div style={{...subTitle, color: '#991b1b'}}>Add YouTube video</div>
          <input
            type="text"
            value={newVideoTitle}
            onChange={(e) => setNewVideoTitle(e.target.value)}
            placeholder="Title (optional)"
            style={{...inpS, marginBottom: 4, fontSize: 12}}
          />
          <div style={{display: 'flex', gap: 6}}>
            <input
              type="text"
              value={newVideoUrl}
              onChange={(e) => setNewVideoUrl(e.target.value)}
              placeholder="https://youtu.be/..."
              style={{...inpS, fontSize: 12, flex: 1}}
            />
            <button
              onClick={addVideo}
              disabled={busy || !newVideoUrl.trim()}
              style={{
                padding: '6px 12px',
                borderRadius: 10,
                border: 'none',
                background: busy || !newVideoUrl.trim() ? '#9ca3af' : '#991b1b',
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              + Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── admin-only documents (invoices, contracts, warranty paperwork, etc.)
// NOT shown on the public /fueling webform or /equipment detail page —
// visible only inside this admin modal. Separate column from `manuals`
// so the two buckets can't mix up.
function DocumentsEditor({equipment, onReload, onLocalPatch}) {
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const docs = Array.isArray(equipment.documents) ? equipment.documents : [];

  async function persist(next) {
    setNotice(null);
    setBusy(true);
    const {error} = await sb.from('equipment').update({documents: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      setNotice({kind: 'error', message: 'Save failed: ' + error.message});
      return;
    }
    applySavedEquipmentPatch(onLocalPatch, onReload, {documents: next});
  }

  async function uploadPdf(file) {
    if (!file) return;
    setNotice(null);
    setUploading(true);
    const safe = (file.name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const bucketPath = 'documents/' + equipment.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(bucketPath, file, {upsert: false, contentType: file.type || 'application/pdf'});
    if (upErr) {
      setNotice({kind: 'error', message: 'Upload failed: ' + upErr.message});
      setUploading(false);
      return;
    }
    const {data: pub} = sb.storage.from('equipment-maintenance-docs').getPublicUrl(bucketPath);
    const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    await persist([
      ...docs,
      {type: 'pdf', title, url: pub.publicUrl, path: bucketPath, uploadedAt: new Date().toISOString()},
    ]);
    setUploading(false);
  }

  async function editTitle(idx, title) {
    const next = docs.slice();
    next[idx] = {...next[idx], title};
    await persist(next);
  }

  async function removeOne(idx) {
    const entry = docs[idx];
    if (!entry) return;
    window._wcfConfirmDelete('Remove "' + (entry.title || 'this document') + '"?', async () => {
      if (entry.type === 'pdf' && entry.path) {
        try {
          await sb.storage.from('equipment-maintenance-docs').remove([entry.path]);
        } catch (e) {
          /*ignore*/
        }
      }
      await persist(docs.filter((_, i) => i !== idx));
    });
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Admin Documents{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Internal only — invoices, contracts, warranty paperwork. NOT shown on /equipment or /fleet.
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {docs.length === 0 && (
        <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 8}}>
          No admin documents uploaded yet.
        </div>
      )}
      {docs.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10}}>
          {docs.map((d, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '60px 1fr 80px',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                background: '#fafafa',
                border: '1px solid var(--border)',
                borderRadius: 10,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 999,
                  textAlign: 'center',
                  background: '#e0e7ff',
                  color: '#3730a3',
                }}
              >
                📄 PDF
              </span>
              <div>
                <input
                  type="text"
                  defaultValue={d.title || ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== (d.title || '')) editTitle(i, v);
                  }}
                  style={{...inpS, padding: '3px 7px', fontSize: 12}}
                />
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{fontSize: 10, color: 'var(--brand)', textDecoration: 'none', wordBreak: 'break-all'}}
                >
                  {d.url}
                </a>
              </div>
              <button
                onClick={() => removeOne(i)}
                disabled={busy}
                style={{
                  padding: '4px 8px',
                  borderRadius: 10,
                  border: '1px solid #fecaca',
                  background: 'white',
                  color: '#b91c1c',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{padding: '10px', background: '#eef2ff', borderRadius: 10, border: '1px dashed #c7d2fe'}}>
        <div style={{...subTitle, color: '#3730a3'}}>Upload PDF</div>
        <input
          type="file"
          accept="application/pdf"
          disabled={uploading || busy}
          onChange={(e) => {
            if (e.target.files && e.target.files[0]) uploadPdf(e.target.files[0]);
            e.target.value = '';
          }}
          style={{fontSize: 12}}
        />
        {uploading && <div style={{fontSize: 10, color: '#3730a3', marginTop: 4}}>Uploading…</div>}
      </div>
    </div>
  );
}

// ── webform help text: operator_notes + fuel_gallons_help ─────────────────
function WebformHelpTextEditor({equipment, onReload, onLocalPatch}) {
  const [_busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  async function save(col, val) {
    setNotice(null);
    const payload = (val && val.trim()) || null;
    const oldVal = equipment[col];
    setBusy(true);
    const result = await runMutation(
      () =>
        sb
          .from('equipment')
          .update({[col]: payload})
          .eq('id', equipment.id),
      {
        activity: () => {
          if (oldVal === payload || (oldVal == null && payload == null)) return;
          const label =
            col === 'operator_notes'
              ? 'Operator notes'
              : col === 'fuel_gallons_help'
                ? 'Fuel gallons help'
                : col.replace(/_/g, ' ');
          return recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [makeFieldChange(col, label, oldVal, payload)],
          });
        },
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {[col]: payload});
  }
  const taS = {...inpS, resize: 'vertical'};
  return (
    <div style={card}>
      <div style={sectionTitle}>
        Webform Help Text{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Shown to the team on /equipment/{equipment.slug}
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div style={{marginBottom: 14}}>
        <div style={subTitle}>Operator notes (yellow banner at top of form — between-fillup maintenance etc.)</div>
        <textarea
          defaultValue={equipment.operator_notes || ''}
          onBlur={(e) => {
            const v = e.target.value;
            if (v.trim() !== (equipment.operator_notes || '')) save('operator_notes', v);
          }}
          placeholder="e.g. Rotor bearings must be greased every 4 hours."
          rows={3}
          style={taS}
        />
      </div>
      <div>
        <div style={subTitle}>Gallons field help (shown below the gallons input)</div>
        <textarea
          defaultValue={equipment.fuel_gallons_help || ''}
          onBlur={(e) => {
            const v = e.target.value;
            if (v.trim() !== (equipment.fuel_gallons_help || '')) save('fuel_gallons_help', v);
          }}
          placeholder="e.g. Use 2.5 oz of Toro fuel conditioner per 5 gallons of gasoline."
          rows={2}
          style={taS}
        />
      </div>
    </div>
  );
}

// ── every-fillup items + every_fillup_help ─────────────────────────────────
function EveryFillupEditor({equipment, onReload, onLocalPatch}) {
  const [newLabel, setNewLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const items = Array.isArray(equipment.every_fillup_items) ? equipment.every_fillup_items : [];

  async function persist(next) {
    setNotice(null);
    setBusy(true);
    const result = await runMutation(
      () => sb.from('equipment').update({every_fillup_items: next}).eq('id', equipment.id),
      {
        activity: () =>
          recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [
              makeFieldChange(
                'every_fillup_items',
                'Every-fillup items',
                countSummary(items, 'item'),
                countSummary(next, 'item'),
              ),
            ],
          }),
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {every_fillup_items: next});
  }
  async function addOne() {
    const label = (newLabel || '').trim();
    if (!label) return;
    const id =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'item-' + Date.now();
    await persist(items.concat([{id, label}]));
    setNewLabel('');
  }
  async function removeOne(idx) {
    await persist(items.filter((_, i) => i !== idx));
  }
  async function editLabel(idx, label) {
    const next = items.slice();
    next[idx] = {...next[idx], label};
    await persist(next);
  }
  async function editFillupHelp(help) {
    setNotice(null);
    const payload = help || null;
    const oldVal = equipment.every_fillup_help || null;
    setBusy(true);
    const result = await runMutation(
      () => sb.from('equipment').update({every_fillup_help: payload}).eq('id', equipment.id),
      {
        activity: () => {
          if (oldVal === payload) return;
          return recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [makeFieldChange('every_fillup_help', 'Every-fillup help', oldVal, payload)],
          });
        },
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {every_fillup_help: payload});
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Every-fillup Items{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Ticked by the team on every /equipment submission
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div style={{marginBottom: 14}}>
        <div style={subTitle}>Help text (shown above the checks on the webform)</div>
        <textarea
          defaultValue={equipment.every_fillup_help || ''}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (equipment.every_fillup_help || '')) editFillupHelp(v);
          }}
          placeholder="e.g. Tire Pressure: 20 psi recommended."
          rows={2}
          style={{...inpS, resize: 'vertical'}}
        />
      </div>
      {items.length === 0 && (
        <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 8}}>
          No items configured yet.
        </div>
      )}
      {items.length > 0 && (
        <div style={{display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, marginBottom: 8, alignItems: 'center'}}>
          {items.map((it, i) => (
            <React.Fragment key={i}>
              <input
                type="text"
                defaultValue={it.label || ''}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== (it.label || '')) editLabel(i, v);
                }}
                style={inpS}
              />
              <button
                onClick={() => removeOne(i)}
                disabled={busy}
                style={{
                  padding: '3px 8px',
                  borderRadius: 10,
                  border: '1px solid #fecaca',
                  background: 'white',
                  color: '#b91c1c',
                  fontSize: 11,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Remove
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 80px',
          gap: 8,
          marginTop: 10,
          padding: '10px',
          background: '#fafafa',
          borderRadius: 10,
          border: '1px dashed var(--border-strong)',
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="e.g. CHECK OIL LEVEL"
          style={inpS}
        />
        <button
          onClick={addOne}
          disabled={busy || !newLabel.trim()}
          style={{
            padding: '6px 12px',
            borderRadius: 10,
            border: 'none',
            background: busy || !newLabel.trim() ? '#9ca3af' : '#57534e',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy || !newLabel.trim() ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Add
        </button>
      </div>
    </div>
  );
}

// ── service intervals + per-interval tasks + per-interval help text ───────
function ServiceIntervalEditor({equipment, onReload, onLocalPatch}) {
  const [newVal, setNewVal] = React.useState('');
  const [newKind, setNewKind] = React.useState(equipment.tracking_unit || 'hours');
  const [newLabel, setNewLabel] = React.useState('');
  const [expandedIdx, setExpandedIdx] = React.useState(null);
  const [newTaskLabels, setNewTaskLabels] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  // Drag-reorder state. dragSource = {intervalIdx, taskIdx} of the row
  // being dragged; dragTarget = {intervalIdx, taskIdx} of the row the
  // pointer is currently over (for the insertion highlight). Both clear
  // on drop / drag-end.
  const [dragSource, setDragSource] = React.useState(null);
  const [dragTarget, setDragTarget] = React.useState(null);
  const intervals = Array.isArray(equipment.service_intervals) ? equipment.service_intervals : [];

  async function persist(next) {
    setNotice(null);
    setBusy(true);
    const result = await runMutation(
      () => sb.from('equipment').update({service_intervals: next}).eq('id', equipment.id),
      {
        activity: () =>
          recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [
              makeFieldChange(
                'service_intervals',
                'Service intervals',
                countSummary(intervals, 'interval'),
                countSummary(next, 'interval'),
              ),
            ],
          }),
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {service_intervals: next});
  }
  async function addOne() {
    setNotice(null);
    const v = parseInt(newVal, 10);
    if (!Number.isFinite(v) || v <= 0) {
      setNotice({kind: 'error', message: 'Enter a positive integer.'});
      return;
    }
    const label = (newLabel || '').trim() || `Every ${v} ${newKind === 'km' ? 'km' : 'hours'} checklist`;
    const next = intervals
      .concat([{hours_or_km: v, kind: newKind, label, tasks: []}])
      .sort((a, b) => a.hours_or_km - b.hours_or_km);
    await persist(next);
    setNewVal('');
    setNewLabel('');
  }
  async function removeOne(idx) {
    window._wcfConfirmDelete('Remove this interval + all its tasks?', async () => {
      await persist(intervals.filter((_, i) => i !== idx));
    });
  }
  async function editLabel(idx, label) {
    const next = intervals.slice();
    next[idx] = {...next[idx], label};
    await persist(next);
  }
  async function addTask(idx) {
    const raw = (newTaskLabels[idx] || '').trim();
    if (!raw) return;
    const id =
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50) || 'task-' + Date.now();
    const tasks = Array.isArray(intervals[idx].tasks) ? intervals[idx].tasks : [];
    const next = intervals.slice();
    next[idx] = {...intervals[idx], tasks: tasks.concat([{id, label: raw}])};
    await persist(next);
    setNewTaskLabels((m) => ({...m, [idx]: ''}));
  }
  async function removeTask(ii, ti) {
    const tasks = Array.isArray(intervals[ii].tasks) ? intervals[ii].tasks : [];
    const next = intervals.slice();
    next[ii] = {...intervals[ii], tasks: tasks.filter((_, x) => x !== ti)};
    await persist(next);
  }
  async function editTaskLabel(ii, ti, label) {
    const tasks = Array.isArray(intervals[ii].tasks) ? intervals[ii].tasks : [];
    const nextTasks = tasks.slice();
    nextTasks[ti] = {...nextTasks[ti], label};
    const next = intervals.slice();
    next[ii] = {...intervals[ii], tasks: nextTasks};
    await persist(next);
  }
  async function reorderTask(ii, fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const tasks = Array.isArray(intervals[ii].tasks) ? intervals[ii].tasks : [];
    if (fromIdx < 0 || fromIdx >= tasks.length || toIdx < 0 || toIdx >= tasks.length) return;
    const reordered = tasks.slice();
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const next = intervals.slice();
    next[ii] = {...intervals[ii], tasks: reordered};
    await persist(next);
  }
  async function editHelpText(ii, help_text) {
    const next = intervals.slice();
    next[ii] = {...intervals[ii], help_text: help_text || null};
    await persist(next);
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Service Intervals{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Click an interval to edit its tasks + help text
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {intervals.length === 0 && (
        <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 8}}>
          No intervals configured.
        </div>
      )}
      {intervals.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8}}>
          {intervals.map((iv, i) => {
            const isExpanded = expandedIdx === i;
            const tasks = Array.isArray(iv.tasks) ? iv.tasks : [];
            return (
              <div
                key={i}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 10,
                  background: isExpanded ? 'var(--surface-2)' : 'white',
                }}
              >
                <div
                  {...openableProps(() => setExpandedIdx(isExpanded ? null : i))}
                  className="hoverable-tile"
                  style={{
                    padding: '8px 12px',
                    display: 'grid',
                    gridTemplateColumns: '20px 90px 70px 1fr 70px',
                    gap: 10,
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>{isExpanded ? '▼' : '▶'}</span>
                  <span style={{fontSize: 12, fontWeight: 700, color: 'var(--ink)'}}>
                    {iv.hours_or_km.toLocaleString()} {iv.kind}
                  </span>
                  <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>{tasks.length} tasks</span>
                  <input
                    type="text"
                    defaultValue={iv.label || ''}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (iv.label || '')) editLabel(i, v);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    style={inpS}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeOne(i);
                    }}
                    disabled={busy}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 10,
                      border: '1px solid #fecaca',
                      background: 'white',
                      color: '#b91c1c',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Remove
                  </button>
                </div>
                {isExpanded && (
                  <div style={{borderTop: '1px solid var(--border)', padding: '10px 12px'}}>
                    <div style={subTitle}>Help text (torque specs, tire pressure, etc. — shown on the webform)</div>
                    <textarea
                      defaultValue={iv.help_text || ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (iv.help_text || '')) editHelpText(i, v);
                      }}
                      placeholder="e.g. Lugnut torque: 47lbs"
                      rows={2}
                      style={{...inpS, resize: 'vertical', marginBottom: 12}}
                    />
                    <div style={subTitle}>Tasks at this interval</div>
                    {tasks.length === 0 && (
                      <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 6}}>
                        No sub-tasks yet. Add below.
                      </div>
                    )}
                    {tasks.map((t, ti) => {
                      const isDragSource = dragSource && dragSource.intervalIdx === i && dragSource.taskIdx === ti;
                      const isDragTarget =
                        dragSource &&
                        dragSource.intervalIdx === i &&
                        dragTarget &&
                        dragTarget.intervalIdx === i &&
                        dragTarget.taskIdx === ti &&
                        dragSource.taskIdx !== ti;
                      return (
                        <div
                          // Stable key by task id (with fallback) — fixes the
                          // "delete just-added task instead of selected row"
                          // bug. With key={ti}, defaultValue inputs were
                          // reused by index across re-renders, leaving DOM
                          // labels out of sync with the underlying array.
                          key={t.id || `idx-${ti}`}
                          draggable={true}
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = 'move';
                            // Some browsers require setData to enable drag.
                            try {
                              e.dataTransfer.setData('text/plain', String(ti));
                            } catch (_e) {
                              /* setData fail is non-fatal */
                            }
                            setDragSource({intervalIdx: i, taskIdx: ti});
                          }}
                          onDragOver={(e) => {
                            if (!dragSource || dragSource.intervalIdx !== i) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = 'move';
                            if (!dragTarget || dragTarget.intervalIdx !== i || dragTarget.taskIdx !== ti) {
                              setDragTarget({intervalIdx: i, taskIdx: ti});
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!dragSource || dragSource.intervalIdx !== i) return;
                            reorderTask(i, dragSource.taskIdx, ti);
                            setDragSource(null);
                            setDragTarget(null);
                          }}
                          onDragEnd={() => {
                            setDragSource(null);
                            setDragTarget(null);
                          }}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '20px 1fr 70px',
                            gap: 8,
                            marginBottom: 4,
                            padding: '2px 4px',
                            alignItems: 'center',
                            background: isDragTarget ? '#fef3c7' : 'transparent',
                            opacity: isDragSource ? 0.4 : 1,
                            border: isDragTarget ? '1px dashed #f59e0b' : '1px solid transparent',
                            borderRadius: 10,
                          }}
                        >
                          <span
                            aria-hidden="true"
                            title="Drag to reorder"
                            style={{
                              fontSize: 14,
                              color: 'var(--ink-faint)',
                              cursor: 'grab',
                              textAlign: 'center',
                              userSelect: 'none',
                              lineHeight: 1,
                            }}
                          >
                            ≡
                          </span>
                          <input
                            type="text"
                            defaultValue={t.label || ''}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== (t.label || '')) editTaskLabel(i, ti, v);
                            }}
                            style={inpS}
                          />
                          <button
                            onClick={() => removeTask(i, ti)}
                            disabled={busy}
                            style={{
                              padding: '3px 8px',
                              borderRadius: 10,
                              border: '1px solid #fecaca',
                              background: 'white',
                              color: '#b91c1c',
                              fontSize: 11,
                              cursor: 'pointer',
                              fontFamily: 'inherit',
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 70px',
                        gap: 8,
                        marginTop: 8,
                        padding: '8px',
                        background: 'white',
                        borderRadius: 10,
                        border: '1px dashed var(--border-strong)',
                        alignItems: 'center',
                      }}
                    >
                      <input
                        type="text"
                        value={newTaskLabels[i] || ''}
                        onChange={(e) => setNewTaskLabels((m) => ({...m, [i]: e.target.value}))}
                        placeholder="e.g. CHECK OIL LEVEL"
                        style={inpS}
                      />
                      <button
                        onClick={() => addTask(i)}
                        disabled={busy || !(newTaskLabels[i] || '').trim()}
                        style={{
                          padding: '5px 10px',
                          borderRadius: 10,
                          border: 'none',
                          background: busy || !(newTaskLabels[i] || '').trim() ? '#9ca3af' : '#57534e',
                          color: 'white',
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: busy || !(newTaskLabels[i] || '').trim() ? 'not-allowed' : 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        + Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '80px 80px 1fr 110px',
          gap: 8,
          marginTop: 10,
          padding: '10px',
          background: '#fafafa',
          borderRadius: 10,
          border: '1px dashed var(--border-strong)',
          alignItems: 'center',
        }}
      >
        <input
          type="number"
          min="1"
          value={newVal}
          onChange={(e) => setNewVal(e.target.value)}
          placeholder="e.g. 50"
          style={inpS}
        />
        <select value={newKind} onChange={(e) => setNewKind(e.target.value)} style={inpS}>
          <option value="hours">hours</option>
          <option value="km">km</option>
        </select>
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (default 'Every N hours checklist')"
          style={inpS}
        />
        <button
          onClick={addOne}
          disabled={busy || !newVal}
          style={{
            padding: '6px 12px',
            borderRadius: 10,
            border: 'none',
            background: busy || !newVal ? '#9ca3af' : '#57534e',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy || !newVal ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Add interval
        </button>
      </div>
    </div>
  );
}

// ── attachment checklists (Ventrac etc.) ───────────────────────────────────
function AttachmentChecklistsEditor({equipment, onReload, onLocalPatch}) {
  const [expandedIdx, setExpandedIdx] = React.useState(null);
  const [newTaskLabels, setNewTaskLabels] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  // Drag-reorder state, scoped per attachment-checklist row. Same shape
  // as ServiceIntervalEditor's dragSource / dragTarget.
  const [dragSource, setDragSource] = React.useState(null);
  const [dragTarget, setDragTarget] = React.useState(null);
  const items = Array.isArray(equipment.attachment_checklists) ? equipment.attachment_checklists : [];

  async function persist(next) {
    setNotice(null);
    setBusy(true);
    const result = await runMutation(
      () => sb.from('equipment').update({attachment_checklists: next}).eq('id', equipment.id),
      {
        activity: () =>
          recordFieldChange(sb, {
            entityType: 'equipment.item',
            entityId: equipment.id,
            entityLabel: equipment.name,
            changes: [
              makeFieldChange(
                'attachment_checklists',
                'Attachment checklists',
                countSummary(items, 'checklist'),
                countSummary(next, 'checklist'),
              ),
            ],
          }),
        onError: (msg) => setNotice({kind: 'error', message: 'Save failed: ' + msg}),
      },
    );
    setBusy(false);
    if (!result.ok) return;
    applySavedEquipmentPatch(onLocalPatch, onReload, {attachment_checklists: next});
  }
  async function editHelpText(idx, help_text) {
    const next = items.slice();
    next[idx] = {...items[idx], help_text: help_text || null};
    await persist(next);
  }
  async function addTask(idx) {
    const raw = (newTaskLabels[idx] || '').trim();
    if (!raw) return;
    const id =
      raw
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50) || 'task-' + Date.now();
    const tasks = Array.isArray(items[idx].tasks) ? items[idx].tasks : [];
    const next = items.slice();
    next[idx] = {...items[idx], tasks: tasks.concat([{id, label: raw}])};
    await persist(next);
    setNewTaskLabels((m) => ({...m, [idx]: ''}));
  }
  async function removeTask(ii, ti) {
    const tasks = Array.isArray(items[ii].tasks) ? items[ii].tasks : [];
    const next = items.slice();
    next[ii] = {...items[ii], tasks: tasks.filter((_, x) => x !== ti)};
    await persist(next);
  }
  async function editTaskLabel(ii, ti, label) {
    const tasks = Array.isArray(items[ii].tasks) ? items[ii].tasks : [];
    const nextTasks = tasks.slice();
    nextTasks[ti] = {...nextTasks[ti], label};
    const next = items.slice();
    next[ii] = {...items[ii], tasks: nextTasks};
    await persist(next);
  }
  async function reorderTask(ii, fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    const tasks = Array.isArray(items[ii].tasks) ? items[ii].tasks : [];
    if (fromIdx < 0 || fromIdx >= tasks.length || toIdx < 0 || toIdx >= tasks.length) return;
    const reordered = tasks.slice();
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const next = items.slice();
    next[ii] = {...items[ii], tasks: reordered};
    await persist(next);
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Attachment Checklists{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Shown as optional sections on the webform
        </span>
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
        {items.map((a, i) => {
          const isExpanded = expandedIdx === i;
          const tasks = Array.isArray(a.tasks) ? a.tasks : [];
          return (
            <div
              key={i}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: isExpanded ? 'var(--surface-2)' : 'white',
              }}
            >
              <div
                {...openableProps(() => setExpandedIdx(isExpanded ? null : i))}
                className="hoverable-tile"
                style={{
                  padding: '8px 12px',
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr 80px 60px',
                  gap: 10,
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
              >
                <span style={{fontSize: 11, color: 'var(--ink-faint)'}}>{isExpanded ? '▼' : '▶'}</span>
                <span style={{fontSize: 12, fontWeight: 700, color: 'var(--ink)'}}>{a.name}</span>
                <span style={{fontSize: 12, color: 'var(--ink-muted)'}}>
                  {a.hours_or_km} {a.kind}
                </span>
                <span style={{fontSize: 11, color: 'var(--ink-muted)'}}>{tasks.length} tasks</span>
              </div>
              {isExpanded && (
                <div style={{borderTop: '1px solid var(--border)', padding: '10px 12px'}}>
                  <div style={subTitle}>Help text</div>
                  <textarea
                    defaultValue={a.help_text || ''}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v !== (a.help_text || '')) editHelpText(i, v);
                    }}
                    rows={2}
                    style={{...inpS, resize: 'vertical', marginBottom: 12}}
                  />
                  <div style={subTitle}>Tasks</div>
                  {tasks.map((t, ti) => {
                    const isDragSource = dragSource && dragSource.intervalIdx === i && dragSource.taskIdx === ti;
                    const isDragTarget =
                      dragSource &&
                      dragSource.intervalIdx === i &&
                      dragTarget &&
                      dragTarget.intervalIdx === i &&
                      dragTarget.taskIdx === ti &&
                      dragSource.taskIdx !== ti;
                    return (
                      <div
                        // Stable key by task id (with fallback) — same fix
                        // as ServiceIntervalEditor for the
                        // "delete just-added task" key/index bug.
                        key={t.id || `idx-${ti}`}
                        draggable={true}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move';
                          try {
                            e.dataTransfer.setData('text/plain', String(ti));
                          } catch (_e) {
                            /* setData fail is non-fatal */
                          }
                          setDragSource({intervalIdx: i, taskIdx: ti});
                        }}
                        onDragOver={(e) => {
                          if (!dragSource || dragSource.intervalIdx !== i) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                          if (!dragTarget || dragTarget.intervalIdx !== i || dragTarget.taskIdx !== ti) {
                            setDragTarget({intervalIdx: i, taskIdx: ti});
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!dragSource || dragSource.intervalIdx !== i) return;
                          reorderTask(i, dragSource.taskIdx, ti);
                          setDragSource(null);
                          setDragTarget(null);
                        }}
                        onDragEnd={() => {
                          setDragSource(null);
                          setDragTarget(null);
                        }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '20px 1fr 70px',
                          gap: 8,
                          marginBottom: 4,
                          padding: '2px 4px',
                          alignItems: 'center',
                          background: isDragTarget ? '#fef3c7' : 'transparent',
                          opacity: isDragSource ? 0.4 : 1,
                          border: isDragTarget ? '1px dashed #f59e0b' : '1px solid transparent',
                          borderRadius: 10,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          title="Drag to reorder"
                          style={{
                            fontSize: 14,
                            color: 'var(--ink-faint)',
                            cursor: 'grab',
                            textAlign: 'center',
                            userSelect: 'none',
                            lineHeight: 1,
                          }}
                        >
                          ≡
                        </span>
                        <input
                          type="text"
                          defaultValue={t.label || ''}
                          onBlur={(e) => {
                            const v = e.target.value.trim();
                            if (v && v !== (t.label || '')) editTaskLabel(i, ti, v);
                          }}
                          style={inpS}
                        />
                        <button
                          onClick={() => removeTask(i, ti)}
                          disabled={busy}
                          style={{
                            padding: '3px 8px',
                            borderRadius: 10,
                            border: '1px solid #fecaca',
                            background: 'white',
                            color: '#b91c1c',
                            fontSize: 11,
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 70px',
                      gap: 8,
                      marginTop: 8,
                      padding: '8px',
                      background: 'white',
                      borderRadius: 10,
                      border: '1px dashed var(--border-strong)',
                      alignItems: 'center',
                    }}
                  >
                    <input
                      type="text"
                      value={newTaskLabels[i] || ''}
                      onChange={(e) => setNewTaskLabels((m) => ({...m, [i]: e.target.value}))}
                      placeholder="e.g. CHECK BLADE BOLTS"
                      style={inpS}
                    />
                    <button
                      onClick={() => addTask(i)}
                      disabled={busy || !(newTaskLabels[i] || '').trim()}
                      style={{
                        padding: '5px 10px',
                        borderRadius: 10,
                        border: 'none',
                        background: busy || !(newTaskLabels[i] || '').trim() ? '#9ca3af' : '#57534e',
                        color: 'white',
                        fontSize: 11,
                        fontWeight: 600,
                        cursor: busy || !(newTaskLabels[i] || '').trim() ? 'not-allowed' : 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
