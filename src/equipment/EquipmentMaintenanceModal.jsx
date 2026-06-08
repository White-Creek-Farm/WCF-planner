// EquipmentMaintenanceModal — add or edit a maintenance event for a piece
// of equipment. Supports photo uploads into the
// 'equipment-maintenance-docs' Storage bucket.
import React from 'react';
import {EQUIPMENT_COLOR} from '../lib/equipment.js';
import {newClientSubmissionId} from '../lib/clientSubmissionId.js';
import {imageAltText} from '../lib/imageAlt.js';

export default function EquipmentMaintenanceModal({sb, equipment, existing, authState, onClose, onSaved}) {
  const [form, setForm] = React.useState(
    () =>
      existing || {
        event_date: new Date().toISOString().slice(0, 10),
        event_type: 'service',
        title: '',
        description: '',
        cost: '',
        hours_at_event: equipment.tracking_unit === 'hours' ? equipment.current_hours || '' : '',
        photos: [],
      },
  );
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [err, setErr] = React.useState('');
  // Stable idempotency key for this modal instance. A double-tap / in-flight
  // re-submit of the SAME new event replays the same id and collapses to a
  // no-op via the equipment_maintenance_events client_submission_id unique
  // index (mig 086) instead of inserting a duplicate row. Re-opening the modal
  // for a genuinely new event mints a fresh id, so legitimate multiple
  // same-day events are unaffected.
  const csidRef = React.useRef(newClientSubmissionId());

  async function uploadPhoto(file) {
    setUploading(true);
    setErr('');
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const pathInBucket = equipment.slug + '/' + Date.now() + '-' + safe;
    const {error: upErr} = await sb.storage
      .from('equipment-maintenance-docs')
      .upload(pathInBucket, file, {upsert: false});
    if (upErr) {
      setErr('Upload failed: ' + upErr.message);
      setUploading(false);
      return;
    }
    const {data: pub} = sb.storage.from('equipment-maintenance-docs').getPublicUrl(pathInBucket);
    setForm((f) => ({
      ...f,
      photos: [
        ...(f.photos || []),
        {name: file.name, path: pathInBucket, url: pub.publicUrl, uploadedAt: new Date().toISOString()},
      ],
    }));
    setUploading(false);
  }
  async function removePhoto(idx) {
    const photo = (form.photos || [])[idx];
    if (photo && photo.path) {
      try {
        await sb.storage.from('equipment-maintenance-docs').remove([photo.path]);
      } catch (e) {
        /* best-effort */
      }
    }
    setForm((f) => ({...f, photos: (f.photos || []).filter((_, i) => i !== idx)}));
  }
  async function save() {
    if (!form.event_date) {
      setErr('Event date required.');
      return;
    }
    setSaving(true);
    setErr('');
    const rec = {
      equipment_id: equipment.id,
      event_date: form.event_date,
      event_type: form.event_type || 'other',
      title: form.title || null,
      description: form.description || null,
      cost: form.cost !== '' ? parseFloat(form.cost) : null,
      hours_at_event: form.hours_at_event !== '' ? parseFloat(form.hours_at_event) : null,
      photos: form.photos || [],
      team_member: (authState && authState.name) || null,
    };
    let error;
    if (existing && existing.id) {
      ({error} = await sb.from('equipment_maintenance_events').update(rec).eq('id', existing.id));
    } else {
      const id = 'emev-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      ({error} = await sb
        .from('equipment_maintenance_events')
        .insert({id, client_submission_id: csidRef.current, ...rec}));
    }
    if (error) {
      // A duplicate client_submission_id means this exact event was already
      // saved by a prior in-flight submit — treat as success, not an error.
      if (String(error.code) === '23505' && /client_submission_id/i.test(error.message || '')) {
        setSaving(false);
        onSaved();
        return;
      }
      setErr('Save failed: ' + error.message);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
  }

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};

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
          maxWidth: 560,
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
          <div style={{fontSize: 15, fontWeight: 700, color: EQUIPMENT_COLOR}}>
            {existing ? 'Edit Maintenance Event' : 'Add Maintenance Event'}
          </div>
          <button
            onClick={onClose}
            style={{background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#9ca3af'}}
          >
            {'×'}
          </button>
        </div>
        <div style={{padding: '16px 20px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
          <div>
            <label style={lbl}>Event date *</label>
            <input
              type="date"
              value={form.event_date}
              onChange={(e) => setForm({...form, event_date: e.target.value})}
              style={inpS}
            />
          </div>
          <div>
            <label style={lbl}>Type</label>
            <select
              value={form.event_type}
              onChange={(e) => setForm({...form, event_type: e.target.value})}
              style={inpS}
            >
              <option value="service">Service</option>
              <option value="repair">Repair</option>
              <option value="inspection">Inspection</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div style={{gridColumn: '1/-1'}}>
            <label style={lbl}>Title</label>
            <input
              value={form.title}
              onChange={(e) => setForm({...form, title: e.target.value})}
              placeholder="Short summary"
              style={inpS}
            />
          </div>
          <div style={{gridColumn: '1/-1'}}>
            <label style={lbl}>Description / notes</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({...form, description: e.target.value})}
              rows={4}
              placeholder="What was done, parts used, vendor mentions, etc."
              style={{...inpS, resize: 'vertical'}}
            />
          </div>
          <div>
            <label style={lbl}>Cost ($)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.cost}
              onChange={(e) => setForm({...form, cost: e.target.value})}
              style={inpS}
            />
          </div>
          <div>
            <label style={lbl}>{equipment.tracking_unit === 'km' ? 'KM at event' : 'Hours at event'}</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={form.hours_at_event}
              onChange={(e) => setForm({...form, hours_at_event: e.target.value})}
              style={inpS}
            />
          </div>
          <div style={{gridColumn: '1/-1'}}>
            <label style={lbl}>Photos</label>
            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8}}>
              {(form.photos || []).map((p, i) => (
                <div key={i} style={{position: 'relative'}}>
                  <img
                    src={p.url}
                    alt={imageAltText(p.name, {
                      fallback: 'Maintenance event photo',
                      index: i,
                      total: (form.photos || []).length,
                    })}
                    style={{width: 80, height: 80, objectFit: 'cover', borderRadius: 6, border: '1px solid #e5e7eb'}}
                  />
                  <button
                    type="button"
                    onClick={() => removePhoto(i)}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -6,
                      width: 20,
                      height: 20,
                      borderRadius: '50%',
                      border: 'none',
                      background: '#b91c1c',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: 12,
                      lineHeight: 1,
                    }}
                  >
                    {'×'}
                  </button>
                </div>
              ))}
            </div>
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                for (const f of files) await uploadPhoto(f);
                e.target.value = '';
              }}
              disabled={uploading}
            />
            {uploading && <div style={{fontSize: 11, color: '#9ca3af', marginTop: 4}}>Uploading{'…'}</div>}
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
            disabled={saving || uploading}
            style={{
              padding: '8px 20px',
              borderRadius: 7,
              border: 'none',
              background: saving || uploading ? '#9ca3af' : EQUIPMENT_COLOR,
              color: 'white',
              fontWeight: 600,
              fontSize: 13,
              cursor: saving || uploading ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {saving ? 'Saving…' : existing ? 'Save' : 'Add Event'}
          </button>
        </div>
      </div>
    </div>
  );
}
