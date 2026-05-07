// EquipmentMaterialListView — operator rolling-stock checklist at
// /fleet/materials. Loads equipment + fuelings + materials + clears,
// folds them through buildMaterialChecklist (src/lib/equipmentMaterials.js),
// renders Equipment → Service group → Material rows. Each row has a single
// Clear button that records a clear keyed to the current due bucket. Per
// Codex amendment 2 cleared rows vanish entirely from the active list —
// there is no toggle here to bring them back into the operator view. The
// un-clear surface lives in the admin editor (EquipmentMaterialsEditor).
//
// The view is gated behind !isEquipmentTech in EquipmentHome (same pattern
// as Fleet/Fuel Log subviews).
import React from 'react';
import {sb} from '../lib/supabase.js';
import {buildMaterialChecklist, HOURS_WINDOW, KM_WINDOW} from '../lib/equipmentMaterials.js';

const cardS = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: '14px 18px',
  marginBottom: 14,
};

function makeId() {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function') {
    return 'emc-' + globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  }
  return 'emc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

export default function EquipmentMaterialListView() {
  const [equipment, setEquipment] = React.useState([]);
  const [fuelings, setFuelings] = React.useState([]);
  const [materials, setMaterials] = React.useState([]);
  const [clears, setClears] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [missingTables, setMissingTables] = React.useState(false);
  const [err, setErr] = React.useState('');

  const reload = React.useCallback(async () => {
    setLoading(true);
    setErr('');
    const [eqRes, fuelRes, matRes, clrRes] = await Promise.all([
      sb.from('equipment').select('*').eq('status', 'active').order('name'),
      sb
        .from('equipment_fuelings')
        .select('id, equipment_id, date, hours_reading, km_reading, service_intervals_completed')
        .order('date', {ascending: false})
        .limit(5000),
      sb.from('equipment_service_materials').select('*').eq('active', true),
      sb.from('equipment_material_clears').select('*'),
    ]);
    if (eqRes.error) {
      setErr('Equipment load failed: ' + eqRes.error.message);
      setLoading(false);
      return;
    }
    if (matRes.error) {
      if (/does not exist|relation/i.test(matRes.error.message || '')) {
        setMissingTables(true);
        setLoading(false);
        return;
      }
      setErr('Materials load failed: ' + matRes.error.message);
      setLoading(false);
      return;
    }
    // Defensive: if we can't read the clears table, refuse to render. An
    // empty-clears fallback would resurface previously-cleared materials.
    if (clrRes.error) {
      if (/does not exist|relation/i.test(clrRes.error.message || '')) {
        setMissingTables(true);
      } else {
        setErr('Clears load failed: ' + clrRes.error.message);
      }
      setLoading(false);
      return;
    }
    setEquipment(eqRes.data || []);
    setFuelings(fuelRes.data || []);
    setMaterials(matRes.data || []);
    setClears(clrRes.data || []);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const fuelingsBy = React.useMemo(() => {
    const m = new Map();
    for (const f of fuelings) {
      const arr = m.get(f.equipment_id) || [];
      arr.push(f);
      m.set(f.equipment_id, arr);
    }
    return m;
  }, [fuelings]);

  const checklist = React.useMemo(
    () => buildMaterialChecklist({equipment, fuelingsBy, materials, clears}),
    [equipment, fuelingsBy, materials, clears],
  );

  async function clearOne(material, group) {
    setErr('');
    const row = {
      id: makeId(),
      material_id: material.id,
      equipment_id: material.equipment_id,
      due_bucket_value: group.due_bucket_value,
      due_bucket_unit: group.due_bucket_unit,
      cleared_at: new Date().toISOString(),
    };
    const {error} = await sb.from('equipment_material_clears').insert(row);
    if (error) {
      // Treat unique-key collision as a no-op (already cleared in this bucket).
      if (!/duplicate key|23505/i.test(error.message || '')) {
        setErr('Clear failed: ' + error.message);
        return;
      }
    }
    await reload();
  }

  if (missingTables) {
    return (
      <div
        style={{
          background: '#fff7ed',
          border: '1px solid #fdba74',
          borderRadius: 10,
          padding: '1rem 1.25rem',
          color: '#9a3412',
          fontSize: 13,
        }}
      >
        Materials tables not yet applied. Run <code>supabase-migrations/048_equipment_service_materials.sql</code> in
        the SQL Editor first.
      </div>
    );
  }
  if (loading) {
    return <div style={{textAlign: 'center', padding: '3rem', color: '#9ca3af'}}>Loading materials…</div>;
  }

  return (
    <div data-material-list-view="1">
      <div style={{display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 14}}>
        <h2 style={{fontSize: 20, fontWeight: 700, color: '#111827', margin: 0}}>Materials Checklist</h2>
        <span style={{fontSize: 12, color: '#6b7280'}}>
          Coming due in the next {HOURS_WINDOW}h (or {KM_WINDOW}km for km-tracked) · {checklist.length}{' '}
          {checklist.length === 1 ? 'piece' : 'pieces'}
        </span>
      </div>
      {err && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 8,
            color: '#b91c1c',
            padding: '10px 14px',
            fontSize: 13,
            marginBottom: 14,
          }}
        >
          {err}
        </div>
      )}
      {checklist.length === 0 && (
        <div style={cardS}>
          <div style={{fontSize: 13, color: '#6b7280'}}>
            No materials in the active rolling window. Add seeded materials in admin or wait for upcoming intervals.
          </div>
        </div>
      )}
      {checklist.map((row) => (
        <EquipmentBlock key={row.equipment.id} row={row} onClear={clearOne} />
      ))}
    </div>
  );
}

function EquipmentBlock({row, onClear}) {
  const eq = row.equipment;
  const unit = eq.tracking_unit === 'km' ? 'km' : 'h';
  const reading = row.current_reading;
  return (
    <div style={cardS} data-material-equipment={eq.slug}>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10}}>
        <div style={{fontSize: 15, fontWeight: 700, color: '#111827'}}>{eq.name}</div>
        <div style={{fontSize: 11, color: '#6b7280'}}>
          {eq.slug} · {Number.isFinite(reading) ? `${Math.round(reading).toLocaleString()} ${unit}` : '— ' + unit}
        </div>
      </div>
      {row.groups.map((g) => (
        <ServiceGroup key={g.groupKey} group={g} eq={eq} onClear={onClear} />
      ))}
    </div>
  );
}

function ServiceGroup({group, eq, onClear}) {
  const isOverdue = group.status?.overdue;
  const labelUnit = group.interval_unit === 'km' ? 'km' : group.interval_unit === 'use' ? '' : 'h';
  const groupLabel =
    group.interval_unit === 'use'
      ? group.attachment_name
        ? `${group.attachment_name} — Every Use`
        : 'Every Use'
      : group.attachment_name
        ? `${group.attachment_name} — ${group.interval_value}${labelUnit}`
        : `Every ${group.interval_value}${labelUnit}`;
  const dueLabel = (() => {
    if (group.interval_unit === 'use') return 'always';
    if (!group.status) return '—';
    if (isOverdue) return 'OVERDUE';
    return `due in ${group.status.until_due}${labelUnit}`;
  })();
  return (
    <div
      style={{
        marginTop: 6,
        marginBottom: 8,
        padding: '8px 10px',
        background: isOverdue ? '#fef2f2' : '#f9fafb',
        border: '1px solid ' + (isOverdue ? '#fecaca' : '#e5e7eb'),
        borderRadius: 8,
      }}
      data-material-service={group.groupKey}
    >
      <div style={{display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6}}>
        <div style={{fontSize: 12, fontWeight: 700, color: isOverdue ? '#b91c1c' : '#374151'}}>{groupLabel}</div>
        <div
          style={{
            fontSize: 11,
            color: isOverdue ? '#b91c1c' : '#6b7280',
            fontWeight: isOverdue ? 700 : 500,
          }}
        >
          {dueLabel}
        </div>
      </div>
      <div style={{display: 'flex', flexDirection: 'column', gap: 4}}>
        {group.materials.map((m) => (
          <MaterialRow key={m.id} material={m} group={group} eq={eq} onClear={onClear} />
        ))}
      </div>
    </div>
  );
}

function MaterialRow({material, group, onClear}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 6px',
        fontSize: 13,
        color: '#111827',
      }}
      data-material-row={material.id}
    >
      <span style={{flex: 1}}>{material.material_name}</span>
      {material.qty && (
        <span style={{fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap'}}>
          {material.qty}
          {material.unit ? ` ${material.unit}` : ''}
        </span>
      )}
      {material.notes && (
        <span style={{fontSize: 11, color: '#6b7280', fontStyle: 'italic', maxWidth: 240, textAlign: 'right'}}>
          {material.notes}
        </span>
      )}
      <button
        onClick={() => onClear(material, group)}
        style={{
          padding: '3px 10px',
          borderRadius: 5,
          border: '1px solid #d1d5db',
          background: 'white',
          color: '#374151',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
        data-material-clear={material.id}
        title="Mark this material as in stock — vanishes from the list until the next service cycle"
      >
        ✓ Clear
      </button>
    </div>
  );
}
