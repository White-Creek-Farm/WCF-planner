// EquipmentMaterialsEditor — admin per-equipment Materials section.
//
// Lives inside the EquipmentWebformsAdmin modal alongside the other editors
// (Manuals, Documents, ServiceIntervals, etc.). Reads/writes the
// equipment_service_materials sidecar table (mig 048); never modifies
// equipment.service_intervals or equipment.attachment_checklists JSONB.
//
// Groups materials by structural service identity per Codex amendment 3:
// (source_kind, interval_unit, interval_value, attachment_name). Service
// intervals + attachment checklists from the equipment row drive the
// groups list, even when no material rows exist yet — that's how admin
// adds the first material to a previously-empty service.
//
// Clears (equipment_material_clears) are exposed here as a per-material
// "Reset clear" control so admin can re-enable an "Every Use" clear or a
// historical bucket clear for testing/operator-error recovery. The
// operator-facing Materials Needed card on the home dashboard does NOT
// show cleared rows (the standalone /fleet/materials page was retired
// 2026-05-14); this editor is the only un-clear surface (Codex amendment 2).
import React from 'react';
import {sb} from '../lib/supabase.js';
import {openableProps} from '../shared/openable.js';

const inpS = {
  fontSize: 12,
  padding: '6px 8px',
  border: '1px solid var(--border-strong)',
  borderRadius: 5,
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

function makeId() {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return 'esm-' + globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return 'esm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

function groupKeyOf(o) {
  return `${o.source_kind}|${o.interval_unit}|${o.interval_value ?? ''}|${o.attachment_name ?? ''}`;
}

function groupLabelOf(o) {
  if (o.interval_unit === 'use') {
    return o.attachment_name ? `${o.attachment_name} — Every Use` : 'Every Use';
  }
  const unit = o.interval_unit === 'km' ? 'km' : 'h';
  if (o.attachment_name) {
    return `${o.attachment_name} — ${o.interval_value}${unit}`;
  }
  return `Every ${o.interval_value}${unit}`;
}

function sortMaterials(materials) {
  return (materials || []).slice().sort((a, b) => {
    const ao = Number(a.sort_order);
    const bo = Number(b.sort_order);
    if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
    if (Number.isFinite(ao) && !Number.isFinite(bo)) return -1;
    if (!Number.isFinite(ao) && Number.isFinite(bo)) return 1;
    const an = (a.material_name || '').toLowerCase();
    const bn = (b.material_name || '').toLowerCase();
    if (an !== bn) return an.localeCompare(bn);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

// Build the unioned list of groups: every service interval + attachment
// checklist on the equipment row, plus any standalone groups that exist in
// the materials table but no longer match a service (defensive — shouldn't
// happen during normal use but admin should still be able to see/clean
// them).
function buildGroups(equipment, materials) {
  const groups = new Map();
  // Service intervals on the equipment row.
  for (const iv of Array.isArray(equipment.service_intervals) ? equipment.service_intervals : []) {
    const value = Number(iv.hours_or_km);
    if (!Number.isFinite(value) || value <= 0) continue;
    const o = {
      source_kind: 'service_interval',
      interval_unit: iv.kind === 'km' ? 'km' : 'hours',
      interval_value: value,
      attachment_name: null,
    };
    const key = groupKeyOf(o);
    groups.set(key, {key, ...o, label: groupLabelOf(o), originLabel: iv.label || null, materials: []});
  }
  // Attachment checklists.
  for (const a of Array.isArray(equipment.attachment_checklists) ? equipment.attachment_checklists : []) {
    const value = Number(a.hours_or_km);
    const isUse = !Number.isFinite(value) || value <= 0;
    const o = {
      source_kind: 'attachment_checklist',
      interval_unit: isUse ? 'use' : a.kind === 'km' ? 'km' : 'hours',
      interval_value: isUse ? null : value,
      attachment_name: a.name || null,
    };
    const key = groupKeyOf(o);
    groups.set(key, {key, ...o, label: groupLabelOf(o), originLabel: a.label || null, materials: []});
  }
  // Materials' groups (in case some don't match a current service — surface
  // them so admin can clean up).
  for (const m of materials) {
    const o = {
      source_kind: m.source_kind,
      interval_unit: m.interval_unit,
      interval_value: m.interval_value,
      attachment_name: m.attachment_name,
    };
    const key = groupKeyOf(o);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ...o,
        label: groupLabelOf(o),
        originLabel: null,
        orphan: true,
        materials: [],
      });
    }
    groups.get(key).materials.push(m);
  }
  // Stable sort: service_interval first by interval_value asc, then attachments
  // by name + interval_value, then 'use' last.
  const arr = Array.from(groups.values());
  arr.sort((a, b) => {
    if (a.source_kind !== b.source_kind) {
      return a.source_kind === 'service_interval' ? -1 : 1;
    }
    if (a.interval_unit === 'use' && b.interval_unit !== 'use') return 1;
    if (b.interval_unit === 'use' && a.interval_unit !== 'use') return -1;
    if (a.attachment_name !== b.attachment_name) {
      return (a.attachment_name || '').localeCompare(b.attachment_name || '');
    }
    return (Number(a.interval_value) || 0) - (Number(b.interval_value) || 0);
  });
  return arr;
}

export default function EquipmentMaterialsEditor({equipment}) {
  const [materials, setMaterials] = React.useState([]);
  const [clearsByMat, setClearsByMat] = React.useState(new Map());
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [expandedKey, setExpandedKey] = React.useState(null);
  const [missingTables, setMissingTables] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setErr('');
    const [matRes, clrRes] = await Promise.all([
      sb
        .from('equipment_service_materials')
        .select('*')
        .eq('equipment_id', equipment.id)
        .order('sort_order', {ascending: true})
        .order('material_name', {ascending: true}),
      sb.from('equipment_material_clears').select('*').eq('equipment_id', equipment.id),
    ]);
    if (matRes.error) {
      if (/does not exist|relation/i.test(matRes.error.message || '')) {
        setMissingTables(true);
        setLoading(false);
        return;
      }
      setErr('Load failed: ' + matRes.error.message);
      setLoading(false);
      return;
    }
    setMaterials(sortMaterials(matRes.data || []));
    const m = new Map();
    for (const c of clrRes.data || []) {
      const arr = m.get(c.material_id) || [];
      arr.push(c);
      m.set(c.material_id, arr);
    }
    setClearsByMat(m);
    setLoading(false);
  }, [equipment.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const groups = React.useMemo(() => buildGroups(equipment, materials), [equipment, materials]);

  async function addMaterial(group, material_name) {
    const name = (material_name || '').trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    const row = {
      id: makeId(),
      equipment_id: equipment.id,
      source_kind: group.source_kind,
      service_label: group.originLabel || group.label,
      attachment_name: group.attachment_name,
      interval_value: group.interval_value,
      interval_unit: group.interval_unit,
      material_name: name,
      qty: null,
      unit: null,
      notes: null,
      active: true,
      sort_order: (group.materials.length + 1) * 10,
      auto_seeded: false,
    };
    const {error} = await sb.from('equipment_service_materials').insert(row);
    setBusy(false);
    if (error) {
      setErr('Add failed: ' + error.message);
      return;
    }
    setMaterials((prev) => sortMaterials([...prev, row]));
  }

  async function patchMaterial(material, patch) {
    setBusy(true);
    setErr('');
    const updatedAt = new Date().toISOString();
    const {error} = await sb
      .from('equipment_service_materials')
      .update({...patch, updated_at: updatedAt})
      .eq('id', material.id);
    setBusy(false);
    if (error) {
      setErr('Save failed: ' + error.message);
      return;
    }
    setMaterials((prev) => prev.map((m) => (m.id === material.id ? {...m, ...patch, updated_at: updatedAt} : m)));
  }

  async function removeMaterial(material) {
    window._wcfConfirmDelete(
      `Delete material "${material.material_name}"? This removes it from every future cycle. The admin can re-add it later.`,
      async () => {
        setBusy(true);
        setErr('');
        const {error} = await sb.from('equipment_service_materials').delete().eq('id', material.id);
        setBusy(false);
        if (error) {
          setErr('Delete failed: ' + error.message);
          return;
        }
        setMaterials((prev) => prev.filter((m) => m.id !== material.id));
        setClearsByMat((prev) => {
          const next = new Map(prev);
          next.delete(material.id);
          return next;
        });
      },
    );
  }

  async function unclearMaterial(material) {
    setBusy(true);
    setErr('');
    const {error} = await sb.from('equipment_material_clears').delete().eq('material_id', material.id);
    setBusy(false);
    if (error) {
      setErr('Reset failed: ' + error.message);
      return;
    }
    setClearsByMat((prev) => {
      const next = new Map(prev);
      next.delete(material.id);
      return next;
    });
  }

  if (missingTables) {
    return (
      <div style={card}>
        <div style={sectionTitle}>Materials</div>
        <div style={{fontSize: 12, color: '#9a3412'}}>
          Materials tables not yet applied. Run <code>supabase-migrations/048_equipment_service_materials.sql</code>{' '}
          first.
        </div>
      </div>
    );
  }

  return (
    <div style={card} data-equipment-materials-editor={equipment.id}>
      <div style={sectionTitle}>
        Materials{' '}
        <span style={{color: 'var(--ink-faint)', fontWeight: 400, fontSize: 10, marginLeft: 8}}>
          What parts/consumables this piece needs at each service
        </span>
      </div>
      {loading && <div style={{fontSize: 12, color: 'var(--ink-faint)'}}>Loading…</div>}
      {!loading && err && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            color: '#b91c1c',
            padding: '6px 10px',
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          {err}
        </div>
      )}
      {!loading && groups.length === 0 && (
        <div style={{fontSize: 12, color: 'var(--ink-faint)', fontStyle: 'italic'}}>
          No service intervals or attachment checklists configured. Add intervals first.
        </div>
      )}
      {!loading && groups.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          {groups.map((g) => {
            const isExpanded = expandedKey === g.key;
            return (
              <div
                key={g.key}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: isExpanded ? 'var(--surface-2)' : 'white',
                }}
                data-materials-group={g.key}
              >
                <div
                  {...openableProps(() => setExpandedKey(isExpanded ? null : g.key))}
                  className="hoverable-tile"
                  style={{
                    padding: '8px 12px',
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{fontSize: 11, color: 'var(--ink-faint)', minWidth: 14}}>{isExpanded ? '▼' : '▶'}</span>
                  <span style={{fontSize: 12, fontWeight: 700, color: 'var(--ink)'}}>{g.label}</span>
                  {g.orphan && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: '#fef3c7',
                        color: '#92400e',
                        fontWeight: 600,
                      }}
                      title="Materials exist but no matching service interval or attachment on this equipment row."
                    >
                      no matching service
                    </span>
                  )}
                  <span style={{fontSize: 11, color: 'var(--ink-muted)', marginLeft: 'auto'}}>
                    {g.materials.length} {g.materials.length === 1 ? 'material' : 'materials'}
                  </span>
                </div>
                {isExpanded && (
                  <div style={{borderTop: '1px solid var(--border)', padding: '10px 12px'}}>
                    {g.materials.length === 0 && (
                      <div style={{fontSize: 11, color: 'var(--ink-faint)', fontStyle: 'italic', marginBottom: 6}}>
                        No materials yet. Add below.
                      </div>
                    )}
                    {g.materials.length > 0 && (
                      <>
                        <div style={subTitle}>Materials at this service</div>
                        <div style={{display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10}}>
                          {g.materials.map((m) => (
                            <MaterialRow
                              key={m.id}
                              material={m}
                              clears={clearsByMat.get(m.id) || []}
                              busy={busy}
                              onPatch={patchMaterial}
                              onRemove={removeMaterial}
                              onUnclear={unclearMaterial}
                            />
                          ))}
                        </div>
                      </>
                    )}
                    <AddMaterialRow group={g} busy={busy} onAdd={addMaterial} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MaterialRow({material, clears, busy, onPatch, onRemove, onUnclear}) {
  const isCleared = clears.length > 0;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.5fr 60px 60px 1fr auto',
        gap: 6,
        alignItems: 'center',
      }}
      data-material-id={material.id}
    >
      <input
        type="text"
        defaultValue={material.material_name || ''}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== (material.material_name || '')) onPatch(material, {material_name: v});
        }}
        style={inpS}
      />
      <input
        type="text"
        defaultValue={material.qty || ''}
        placeholder="qty"
        onBlur={(e) => {
          const v = e.target.value.trim() || null;
          if (v !== (material.qty || null)) onPatch(material, {qty: v});
        }}
        style={inpS}
      />
      <input
        type="text"
        defaultValue={material.unit || ''}
        placeholder="unit"
        onBlur={(e) => {
          const v = e.target.value.trim() || null;
          if (v !== (material.unit || null)) onPatch(material, {unit: v});
        }}
        style={inpS}
      />
      <input
        type="text"
        defaultValue={material.notes || ''}
        placeholder="note (optional)"
        onBlur={(e) => {
          const v = e.target.value.trim() || null;
          if (v !== (material.notes || null)) onPatch(material, {notes: v});
        }}
        style={inpS}
      />
      <div style={{display: 'flex', gap: 4}}>
        {isCleared && (
          <button
            onClick={() => onUnclear(material)}
            disabled={busy}
            title={`Cleared in ${clears.length} bucket${clears.length === 1 ? '' : 's'} — reset to bring back to operator list`}
            style={{
              padding: '3px 8px',
              borderRadius: 5,
              border: '1px solid #fde68a',
              background: '#fffbeb',
              color: '#92400e',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            data-material-unclear={material.id}
          >
            Reset clear
          </button>
        )}
        <button
          onClick={() => onRemove(material)}
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
          data-material-remove={material.id}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AddMaterialRow({group, busy, onAdd}) {
  const [name, setName] = React.useState('');
  return (
    <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
      <input
        type="text"
        value={name}
        placeholder="+ New material name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onAdd(group, name);
            setName('');
          }
        }}
        style={{...inpS, flex: 1}}
        data-add-material={group.key}
      />
      <button
        onClick={() => {
          onAdd(group, name);
          setName('');
        }}
        disabled={busy || !name.trim()}
        style={{
          padding: '5px 12px',
          borderRadius: 5,
          border: '1px solid var(--border-strong)',
          background: !name.trim() ? '#f3f4f6' : 'white',
          color: !name.trim() ? 'var(--ink-faint)' : '#085041',
          fontSize: 12,
          fontWeight: 600,
          cursor: !name.trim() ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit',
        }}
      >
        + Add
      </button>
    </div>
  );
}
