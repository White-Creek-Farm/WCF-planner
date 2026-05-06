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
import {loadRoster, activeNames as activeNamesFromRoster} from '../lib/teamMembers.js';
import {EQUIPMENT_CATEGORIES} from '../lib/equipment.js';

const inpS = {
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 5,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
  width: '100%',
};
const sectionTitle = {
  fontSize: 11,
  fontWeight: 700,
  color: '#4b5563',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};
const subTitle = {
  fontSize: 10,
  color: '#6b7280',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 4,
};
const card = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '14px 20px',
  marginBottom: 14,
};

export default function EquipmentWebformsAdmin() {
  const [equipment, setEquipment] = React.useState([]);
  const [selectedId, setSelectedId] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [missingSchema, setMissingSchema] = React.useState(false);

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    const {data, error} = await sb.from('equipment').select('*').order('category').order('name');
    if (error && /does not exist|relation/i.test(error.message || '')) {
      setMissingSchema(true);
      setLoading(false);
      return;
    }
    setEquipment(data || []);
    setLoading(false);
  }, []);
  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

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
  if (loading) return <div style={{padding: 20, fontSize: 13, color: '#6b7280'}}>Loading equipment…</div>;

  const soldList = equipment
    .filter((e) => e.status === 'sold')
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  return (
    <div>
      {/* FuelSupplyAdminSection retired 2026-04-29 — master roster lives in
          /webforms admin (TeamRosterEditor); per-form filtering removed. */}
      <div style={card}>
        <div style={sectionTitle}>
          Equipment{' '}
          <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>Click a piece to edit</span>
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
                      onClick={() => setSelectedId(e.id)}
                      style={{
                        padding: '7px 12px',
                        border: '1px solid ' + (on ? cat.color : '#e5e7eb'),
                        background: on ? cat.bg : 'white',
                        borderRadius: 6,
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontSize: 13,
                      }}
                    >
                      <span style={{fontWeight: on ? 700 : 500, color: '#111827', flex: 1}}>{e.name}</span>
                      {e.status !== 'active' && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 3,
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
          <div style={{marginTop: 18, paddingTop: 12, borderTop: '1px solid #e5e7eb'}}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: '#6b7280',
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
                    onClick={() => setSelectedId(e.id)}
                    style={{
                      padding: '7px 12px',
                      border: '1px solid ' + (on ? '#6b7280' : '#e5e7eb'),
                      background: on ? '#f3f4f6' : 'white',
                      borderRadius: 6,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      fontSize: 13,
                      color: '#6b7280',
                    }}
                  >
                    <span style={{fontWeight: on ? 700 : 500, flex: 1}}>{e.name}</span>
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
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
        <div style={{fontSize: 11, color: '#9ca3af', marginTop: 10}}>
          Changes auto-save on blur. Live on /equipment/&lt;slug&gt; immediately after save.
        </div>
      </div>

      {selected && (
        <div
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
              background: '#f1f3f2',
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
                borderBottom: '1px solid #e5e7eb',
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
                    color: '#6b7280',
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
                    color: '#111827',
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
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  color: '#374151',
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
              <IdentityEditor equipment={selected} onReload={loadAll} />
              <TeamMembersEditor equipment={selected} onReload={loadAll} />
              <SpecsEditor equipment={selected} onReload={loadAll} />
              <ManualsEditor equipment={selected} onReload={loadAll} />
              <DocumentsEditor equipment={selected} onReload={loadAll} />
              <WebformHelpTextEditor equipment={selected} onReload={loadAll} />
              <EveryFillupEditor equipment={selected} onReload={loadAll} />
              <ServiceIntervalEditor equipment={selected} onReload={loadAll} />
              {Array.isArray(selected.attachment_checklists) && selected.attachment_checklists.length > 0 && (
                <AttachmentChecklistsEditor equipment={selected} onReload={loadAll} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── identity: name / serial / status ───────────────────────────────────────
function IdentityEditor({equipment, onReload}) {
  const [busy, setBusy] = React.useState(false);
  async function save(col, val) {
    setBusy(true);
    const {error} = await sb
      .from('equipment')
      .update({[col]: typeof val === 'string' && !val.trim() ? null : val})
      .eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }
  return (
    <div style={card}>
      <div style={sectionTitle}>
        Identity{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Equipment name · serial · status
        </span>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10, alignItems: 'center', rowGap: 10}}>
        <div style={subTitle}>Name</div>
        <input
          type="text"
          defaultValue={equipment.name || ''}
          disabled={busy}
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
          disabled={busy}
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

// ── team members: who typically operates this piece ───────────────────────
// Reads + writes the MASTER list (webform_config.team_members) so admins
// can add/remove team members from the whole system right here, not just
// toggle per-piece assignments.
// Per-piece operator assignment editor. Reads the canonical team roster
// via the helper and lets admin toggle which operators are assigned to
// THIS piece of equipment. Master add/remove was retired 2026-04-29 —
// the central editor in /webforms admin (TeamRosterEditor) is the only
// writer of the master roster. This component never writes
// webform_config.team_roster or team_members; it only writes the
// equipment.team_members column.
function TeamMembersEditor({equipment, onReload}) {
  const [roster, setRoster] = React.useState([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    loadRoster(sb).then((r) => {
      if (!cancelled) setRoster(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const assigned = Array.isArray(equipment.team_members) ? equipment.team_members : [];
  const activeMaster = activeNamesFromRoster(roster);

  async function toggle(name) {
    setBusy(true);
    const next = assigned.includes(name) ? assigned.filter((n) => n !== name) : [...assigned, name];
    const {error} = await sb.from('equipment').update({team_members: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Team Members{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Assign operators to this piece · names managed in admin
        </span>
      </div>
      {activeMaster.length === 0 && (
        <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>
          No active team members yet. Add names in the Webforms admin → Team Members section.
        </div>
      )}
      {activeMaster.length > 0 && (
        <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10}}>
          {activeMaster.map((name) => {
            const on = assigned.includes(name);
            return (
              <button
                key={name}
                onClick={() => toggle(name)}
                disabled={busy}
                style={{
                  fontSize: 12,
                  padding: '5px 11px',
                  borderRadius: 5,
                  border: '1px solid ' + (on ? '#047857' : '#d1d5db'),
                  background: on ? '#d1fae5' : 'white',
                  color: on ? '#047857' : '#6b7280',
                  fontWeight: on ? 600 : 400,
                  cursor: busy ? 'not-allowed' : 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {on ? '✓ ' : ''}
                {name}
              </button>
            );
          })}
        </div>
      )}
      {assigned.length === 0 && activeMaster.length > 0 && (
        <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic'}}>None assigned to this piece yet.</div>
      )}
    </div>
  );
}

// ── specs & fluids (filters, oils, capacities, warranty) ─────────────────
// Part numbers, oil types, tank capacities, warranty info. Debounced
// auto-save on blur, matching the inline /equipment/<slug> spec panel.
function SpecsEditor({equipment, onReload}) {
  const [busy, setBusy] = React.useState(false);
  async function save(col, val) {
    setBusy(true);
    const payload = typeof val === 'string' && !val.trim() ? null : val;
    const {error} = await sb
      .from('equipment')
      .update({[col]: payload})
      .eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
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
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Part numbers, oils, capacities — auto-saves on blur
        </span>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px 14px'}}>
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <div style={subTitle}>{label}</div>
            <textarea
              rows={1}
              defaultValue={equipment[k] || ''}
              disabled={busy}
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
            disabled={busy}
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
              disabled={busy}
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
            disabled={busy}
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

function ManualsEditor({equipment, onReload}) {
  const [busy, setBusy] = React.useState(false);
  const [newVideoUrl, setNewVideoUrl] = React.useState('');
  const [newVideoTitle, setNewVideoTitle] = React.useState('');
  const [uploading, setUploading] = React.useState(false);
  const manuals = Array.isArray(equipment.manuals) ? equipment.manuals : [];

  async function persist(next) {
    setBusy(true);
    const {error} = await sb.from('equipment').update({manuals: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }

  async function uploadPdf(file) {
    if (!file) return;
    setUploading(true);
    const safe = (file.name || 'manual.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const bucketPath = 'manuals/' + equipment.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(bucketPath, file, {upsert: false, contentType: file.type || 'application/pdf'});
    if (upErr) {
      alert('Upload failed: ' + upErr.message);
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
    const vid = youtubeId(url);
    if (!vid) {
      alert('Doesn’t look like a YouTube URL. Try https://youtu.be/... or https://youtube.com/watch?v=...');
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
    if (!confirm('Remove "' + (entry.title || 'this manual') + '"?')) return;
    if (entry.type === 'pdf' && entry.path) {
      try {
        await sb.storage.from('equipment-maintenance-docs').remove([entry.path]);
      } catch (e) {
        /*ignore*/
      }
    }
    await persist(manuals.filter((_, i) => i !== idx));
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Manuals &amp; Videos{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Operator reference — shows on /equipment and /fleet
        </span>
      </div>
      {manuals.length === 0 && (
        <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8}}>
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
                border: '1px solid #e5e7eb',
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
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
                  disabled={busy}
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
                  style={{fontSize: 10, color: '#1d4ed8', textDecoration: 'none', wordBreak: 'break-all'}}
                >
                  {m.url}
                </a>
              </div>
              <button
                onClick={() => removeOne(i)}
                disabled={busy}
                style={{
                  padding: '4px 8px',
                  borderRadius: 5,
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
        <div style={{padding: '10px', background: '#fffbeb', borderRadius: 6, border: '1px dashed #fde68a'}}>
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
        <div style={{padding: '10px', background: '#fef2f2', borderRadius: 6, border: '1px dashed #fecaca'}}>
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
                borderRadius: 6,
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
function DocumentsEditor({equipment, onReload}) {
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const docs = Array.isArray(equipment.documents) ? equipment.documents : [];

  async function persist(next) {
    setBusy(true);
    const {error} = await sb.from('equipment').update({documents: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }

  async function uploadPdf(file) {
    if (!file) return;
    setUploading(true);
    const safe = (file.name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
    const bucketPath = 'documents/' + equipment.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(bucketPath, file, {upsert: false, contentType: file.type || 'application/pdf'});
    if (upErr) {
      alert('Upload failed: ' + upErr.message);
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
    if (!confirm('Remove "' + (entry.title || 'this document') + '"?')) return;
    if (entry.type === 'pdf' && entry.path) {
      try {
        await sb.storage.from('equipment-maintenance-docs').remove([entry.path]);
      } catch (e) {
        /*ignore*/
      }
    }
    await persist(docs.filter((_, i) => i !== idx));
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Admin Documents{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Internal only — invoices, contracts, warranty paperwork. NOT shown on /equipment or /fleet.
        </span>
      </div>
      {docs.length === 0 && (
        <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8}}>
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
                border: '1px solid #e5e7eb',
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
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
                  disabled={busy}
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
                  style={{fontSize: 10, color: '#1d4ed8', textDecoration: 'none', wordBreak: 'break-all'}}
                >
                  {d.url}
                </a>
              </div>
              <button
                onClick={() => removeOne(i)}
                disabled={busy}
                style={{
                  padding: '4px 8px',
                  borderRadius: 5,
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
      <div style={{padding: '10px', background: '#eef2ff', borderRadius: 6, border: '1px dashed #c7d2fe'}}>
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
function WebformHelpTextEditor({equipment, onReload}) {
  const [busy, setBusy] = React.useState(false);
  async function save(col, val) {
    setBusy(true);
    const {error} = await sb
      .from('equipment')
      .update({[col]: (val && val.trim()) || null})
      .eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }
  const taS = {...inpS, resize: 'vertical'};
  return (
    <div style={card}>
      <div style={sectionTitle}>
        Webform Help Text{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Shown to the team on /equipment/{equipment.slug}
        </span>
      </div>
      <div style={{marginBottom: 14}}>
        <div style={subTitle}>Operator notes (yellow banner at top of form — between-fillup maintenance etc.)</div>
        <textarea
          defaultValue={equipment.operator_notes || ''}
          disabled={busy}
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
          disabled={busy}
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
function EveryFillupEditor({equipment, onReload}) {
  const [newLabel, setNewLabel] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const items = Array.isArray(equipment.every_fillup_items) ? equipment.every_fillup_items : [];

  async function persist(next) {
    setBusy(true);
    const {error} = await sb.from('equipment').update({every_fillup_items: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
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
    setBusy(true);
    const {error} = await sb
      .from('equipment')
      .update({every_fillup_help: help || null})
      .eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Every-fillup Items{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Ticked by the team on every /equipment submission
        </span>
      </div>
      <div style={{marginBottom: 14}}>
        <div style={subTitle}>Help text (shown above the checks on the webform)</div>
        <textarea
          defaultValue={equipment.every_fillup_help || ''}
          disabled={busy}
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
        <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8}}>
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
                disabled={busy}
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
                  borderRadius: 5,
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
          borderRadius: 6,
          border: '1px dashed #d1d5db',
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
            borderRadius: 6,
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
function ServiceIntervalEditor({equipment, onReload}) {
  const [newVal, setNewVal] = React.useState('');
  const [newKind, setNewKind] = React.useState(equipment.tracking_unit || 'hours');
  const [newLabel, setNewLabel] = React.useState('');
  const [expandedIdx, setExpandedIdx] = React.useState(null);
  const [newTaskLabels, setNewTaskLabels] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const intervals = Array.isArray(equipment.service_intervals) ? equipment.service_intervals : [];

  async function persist(next) {
    setBusy(true);
    const {error} = await sb.from('equipment').update({service_intervals: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
  }
  async function addOne() {
    const v = parseInt(newVal, 10);
    if (!Number.isFinite(v) || v <= 0) {
      alert('Enter a positive integer.');
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
    if (!confirm('Remove this interval + all its tasks?')) return;
    await persist(intervals.filter((_, i) => i !== idx));
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
  async function editHelpText(ii, help_text) {
    const next = intervals.slice();
    next[ii] = {...intervals[ii], help_text: help_text || null};
    await persist(next);
  }

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Service Intervals{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Click an interval to edit its tasks + help text
        </span>
      </div>
      {intervals.length === 0 && (
        <div style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic', marginBottom: 8}}>
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
                style={{border: '1px solid #e5e7eb', borderRadius: 6, background: isExpanded ? '#f9fafb' : 'white'}}
              >
                <div
                  onClick={() => setExpandedIdx(isExpanded ? null : i)}
                  style={{
                    padding: '8px 12px',
                    display: 'grid',
                    gridTemplateColumns: '20px 90px 70px 1fr 70px',
                    gap: 10,
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{fontSize: 11, color: '#9ca3af'}}>{isExpanded ? '▼' : '▶'}</span>
                  <span style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>
                    {iv.hours_or_km.toLocaleString()} {iv.kind}
                  </span>
                  <span style={{fontSize: 11, color: '#6b7280'}}>{tasks.length} tasks</span>
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
                      borderRadius: 5,
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
                  <div style={{borderTop: '1px solid #e5e7eb', padding: '10px 12px'}}>
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
                      <div style={{fontSize: 11, color: '#9ca3af', fontStyle: 'italic', marginBottom: 6}}>
                        No sub-tasks yet. Add below.
                      </div>
                    )}
                    {tasks.map((t, ti) => (
                      <div
                        key={ti}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 70px',
                          gap: 8,
                          marginBottom: 4,
                          alignItems: 'center',
                        }}
                      >
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
                            borderRadius: 5,
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
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 70px',
                        gap: 8,
                        marginTop: 8,
                        padding: '8px',
                        background: 'white',
                        borderRadius: 5,
                        border: '1px dashed #d1d5db',
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
                          borderRadius: 5,
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
          borderRadius: 6,
          border: '1px dashed #d1d5db',
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
            borderRadius: 6,
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
function AttachmentChecklistsEditor({equipment, onReload}) {
  const [expandedIdx, setExpandedIdx] = React.useState(null);
  const [newTaskLabels, setNewTaskLabels] = React.useState({});
  const [busy, setBusy] = React.useState(false);
  const items = Array.isArray(equipment.attachment_checklists) ? equipment.attachment_checklists : [];

  async function persist(next) {
    setBusy(true);
    const {error} = await sb.from('equipment').update({attachment_checklists: next}).eq('id', equipment.id);
    setBusy(false);
    if (error) {
      alert('Save failed: ' + error.message);
      return;
    }
    onReload();
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

  return (
    <div style={card}>
      <div style={sectionTitle}>
        Attachment Checklists{' '}
        <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          Shown as optional sections on the webform
        </span>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
        {items.map((a, i) => {
          const isExpanded = expandedIdx === i;
          const tasks = Array.isArray(a.tasks) ? a.tasks : [];
          return (
            <div
              key={i}
              style={{border: '1px solid #e5e7eb', borderRadius: 6, background: isExpanded ? '#f9fafb' : 'white'}}
            >
              <div
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
                style={{
                  padding: '8px 12px',
                  display: 'grid',
                  gridTemplateColumns: '20px 1fr 80px 60px',
                  gap: 10,
                  alignItems: 'center',
                  cursor: 'pointer',
                }}
              >
                <span style={{fontSize: 11, color: '#9ca3af'}}>{isExpanded ? '▼' : '▶'}</span>
                <span style={{fontSize: 12, fontWeight: 700, color: '#111827'}}>{a.name}</span>
                <span style={{fontSize: 12, color: '#6b7280'}}>
                  {a.hours_or_km} {a.kind}
                </span>
                <span style={{fontSize: 11, color: '#6b7280'}}>{tasks.length} tasks</span>
              </div>
              {isExpanded && (
                <div style={{borderTop: '1px solid #e5e7eb', padding: '10px 12px'}}>
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
                  {tasks.map((t, ti) => (
                    <div
                      key={ti}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 70px',
                        gap: 8,
                        marginBottom: 4,
                        alignItems: 'center',
                      }}
                    >
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
                          borderRadius: 5,
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
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 70px',
                      gap: 8,
                      marginTop: 8,
                      padding: '8px',
                      background: 'white',
                      borderRadius: 5,
                      border: '1px dashed #d1d5db',
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
                        borderRadius: 5,
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
