// EquipmentAddModal — admin creates a new piece of equipment from the
// Fleet view. Auto-generates a slug, inserts the equipment row, seeds
// empty service_intervals + every_fillup_items (admin edits those on
// the detail page). No webform-config seeding required since
// /fueling reads the equipment table directly.
import React from 'react';
import {EQUIPMENT_COLOR, EQUIPMENT_CATEGORIES} from '../lib/equipment.js';

export default function EquipmentAddModal({sb, onClose, onCreated}) {
  const [form, setForm] = React.useState({
    name: '',
    slug: '',
    category: 'tractors',
    tracking_unit: 'hours',
    fuel_type: 'diesel',
    takes_def: false,
    serial_number: '',
    fuel_tank_gal: '',
  });
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');

  function generateSlug() {
    const s = (form.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    return s || 'eq-' + Date.now();
  }

  async function save() {
    setErr('');
    if (!form.name.trim()) {
      setErr('Name required.');
      return;
    }
    const slug = (form.slug || '').trim() || generateSlug();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      setErr('Slug must be lowercase letters, numbers, hyphens.');
      return;
    }
    setSaving(true);
    const rec = {
      id: 'eq-' + slug,
      name: form.name.trim(),
      slug,
      category: form.category,
      tracking_unit: form.tracking_unit,
      fuel_type: form.fuel_type || null,
      takes_def: !!form.takes_def,
      serial_number: form.serial_number.trim() || null,
      fuel_tank_gal: form.fuel_tank_gal !== '' ? parseFloat(form.fuel_tank_gal) : null,
      status: 'active',
      service_intervals: [],
      every_fillup_items: [],
    };
    const {error} = await sb.from('equipment').insert(rec);
    setSaving(false);
    if (error) {
      setErr('Save failed: ' + error.message);
      return;
    }
    onCreated(rec);
  }

  const inpS = {
    fontSize: 13,
    padding: '8px 11px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 4, fontWeight: 500};

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '1rem',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 520,
          width: '100%',
          marginTop: 40,
          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{fontSize: 15, fontWeight: 700, color: EQUIPMENT_COLOR}}>Add Equipment</div>
          <button
            onClick={onClose}
            style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
          >
            {'×'}
          </button>
        </div>
        <div style={{padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12}}>
          <div style={{gridColumn: '1/-1'}}>
            <label style={lbl}>Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({...form, name: e.target.value})}
              placeholder="2025 John Deere 5075E - WCF - TR08"
              style={inpS}
              autoFocus
            />
          </div>
          <div style={{gridColumn: '1/-1'}}>
            <label style={lbl}>
              URL slug <span style={{color: '#9ca3af', fontWeight: 400}}>(leave blank to auto-generate from name)</span>
            </label>
            <input
              type="text"
              value={form.slug}
              onChange={(e) => setForm({...form, slug: e.target.value.toLowerCase()})}
              placeholder={generateSlug()}
              style={inpS}
            />
            <div style={{fontSize: 10, color: '#9ca3af', marginTop: 3}}>
              Will appear at /equipment/{form.slug || generateSlug()} and /fleet/{form.slug || generateSlug()}.
            </div>
          </div>
          <div>
            <label style={lbl}>Category *</label>
            <select value={form.category} onChange={(e) => setForm({...form, category: e.target.value})} style={inpS}>
              {EQUIPMENT_CATEGORIES.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.icon} {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={lbl}>Tracking *</label>
            <select
              value={form.tracking_unit}
              onChange={(e) => setForm({...form, tracking_unit: e.target.value})}
              style={inpS}
            >
              <option value="hours">Hours</option>
              <option value="km">KM</option>
            </select>
          </div>
          <div>
            <label style={lbl}>Fuel type</label>
            <select
              value={form.fuel_type || ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  fuel_type: e.target.value || null,
                  takes_def: e.target.value === 'gasoline' ? false : form.takes_def,
                })
              }
              style={inpS}
            >
              <option value="">None (implement)</option>
              <option value="diesel">Diesel</option>
              <option value="gasoline">Gasoline</option>
            </select>
          </div>
          <div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                fontWeight: 600,
                color: '#374151',
                marginTop: 24,
                cursor: form.fuel_type === 'diesel' ? 'pointer' : 'not-allowed',
                opacity: form.fuel_type === 'diesel' ? 1 : 0.4,
              }}
            >
              <input
                type="checkbox"
                checked={!!form.takes_def}
                disabled={form.fuel_type !== 'diesel'}
                onChange={(e) => setForm({...form, takes_def: e.target.checked})}
                style={{margin: 0, width: 16, height: 16, padding: 0, border: '1px solid #d1d5db'}}
              />
              Takes DEF
            </label>
          </div>
          <div>
            <label style={lbl}>Serial number</label>
            <input
              type="text"
              value={form.serial_number}
              onChange={(e) => setForm({...form, serial_number: e.target.value})}
              style={inpS}
            />
          </div>
          <div>
            <label style={lbl}>Fuel tank (gal)</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.fuel_tank_gal}
              onChange={(e) => setForm({...form, fuel_tank_gal: e.target.value})}
              style={inpS}
            />
          </div>
          {err && (
            <div
              style={{
                gridColumn: '1/-1',
                color: '#b91c1c',
                fontSize: 12,
                padding: '6px 10px',
                background: '#fef2f2',
                borderRadius: 6,
              }}
            >
              {err}
            </div>
          )}
        </div>
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#6b7280',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !form.name.trim()}
            style={{
              padding: '8px 20px',
              borderRadius: 7,
              border: 'none',
              background: saving || !form.name.trim() ? '#9ca3af' : EQUIPMENT_COLOR,
              color: 'white',
              fontWeight: 600,
              fontSize: 13,
              cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {saving ? 'Creating…' : 'Create Equipment'}
          </button>
        </div>
        <div style={{padding: '8px 20px 16px', fontSize: 11, color: '#9ca3af', textAlign: 'center'}}>
          After creation, add service intervals + every-fillup items from the detail page.
        </div>
      </div>
    </div>
  );
}
