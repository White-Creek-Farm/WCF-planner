// EquipmentFleetView — grid of equipment tiles clustered by category.
// Each tile shows name, current hours/km, fuel type, status, and a
// "service due" or "overdue" badge when the upcoming-service calculator
// says so. Click a tile → navigate to /equipment/<slug>.
import React from 'react';
import {
  EQUIPMENT_CATEGORIES,
  CATEGORY_BY_KEY,
  MISSED_FUELING_DAYS,
  WARRANTY_WINDOW_DAYS,
  EQUIPMENT_COLOR,
  soonestDue,
  daysSince,
  fmtReading,
} from '../lib/equipment.js';
import EquipmentAddModal from './EquipmentAddModal.jsx';
import EquipmentCategoryIcon from '../components/EquipmentCategoryIcon.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityPanel from '../shared/ActivityPanel.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';

export default function EquipmentFleetView({sb, equipment, fuelings, fmt, onOpen, onReload}) {
  const {authState} = useAuth();
  const [showAdd, setShowAdd] = React.useState(false);
  const [activityTarget, setActivityTarget] = React.useState(null);
  if (!equipment || equipment.length === 0) {
    return (
      <div
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 12,
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280',
          fontSize: 13,
        }}
      >
        No equipment yet. Run the Podio import, or use + Add Equipment.
      </div>
    );
  }

  // Build per-equipment completions from fueling rows so we can compute the
  // "service due" badge on each tile. service_intervals_completed is an
  // array on each fueling entry.
  const completionsById = new Map();
  const latestFuelingById = new Map();
  for (const f of fuelings || []) {
    const arr = completionsById.get(f.equipment_id) || [];
    (f.service_intervals_completed || []).forEach((c) =>
      arr.push({
        ...c,
        reading_at_completion: f.hours_reading != null ? f.hours_reading : f.km_reading != null ? f.km_reading : null,
      }),
    );
    completionsById.set(f.equipment_id, arr);
    const latest = latestFuelingById.get(f.equipment_id);
    if (!latest || (f.date || '') > (latest.date || '')) latestFuelingById.set(f.equipment_id, f);
  }

  // Group equipment by category, active first.
  const grouped = EQUIPMENT_CATEGORIES.map((cat) => ({
    ...cat,
    rows: equipment
      .filter((e) => e.category === cat.key && e.status !== 'sold')
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
  })).filter((g) => g.rows.length > 0);
  const sold = equipment.filter((e) => e.status === 'sold').sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const tile = (eq) => {
    const reading = eq.tracking_unit === 'km' ? eq.current_km : eq.current_hours;
    const dueInfo = soonestDue(eq.service_intervals, completionsById.get(eq.id) || [], reading, 50);
    const latestFuel = latestFuelingById.get(eq.id);
    const daysSinceFuel = daysSince(latestFuel?.date);
    const missedFuel = daysSinceFuel != null && daysSinceFuel > MISSED_FUELING_DAYS;
    const warrantyExpiresSoon =
      eq.warranty_expiration &&
      daysSince(eq.warranty_expiration) != null &&
      daysSince(eq.warranty_expiration) > -WARRANTY_WINDOW_DAYS &&
      daysSince(eq.warranty_expiration) < 0;
    const cat = CATEGORY_BY_KEY[eq.category] || {color: '#57534e', bg: '#fafaf9', bd: '#d6d3d1'};

    return (
      <div
        key={eq.id}
        onClick={() => onOpen(eq.slug)}
        className="hoverable-tile"
        style={{
          background: 'white',
          border: '1px solid ' + cat.bd,
          borderRadius: 12,
          padding: '14px 18px',
          cursor: 'pointer',
          transition: 'transform .1s',
          minWidth: 0,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap'}}>
          <span style={{fontSize: 15, fontWeight: 700, color: cat.color}}>{eq.name}</span>
          <span onClick={(e) => e.stopPropagation()} data-activity-surface="equipment.item">
            {React.createElement(ActivityPanel, {
              sb,
              authState,
              entityType: 'equipment.item',
              entityId: eq.id,
              entityLabel: eq.name,
              entityCtx: {slug: eq.slug},
              mode: 'compact',
              onCompactClick: setActivityTarget,
            })}
          </span>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 10,
              background: eq.status === 'active' ? '#d1fae5' : '#f3f4f6',
              color: eq.status === 'active' ? '#065f46' : '#374151',
              textTransform: 'uppercase',
            }}
          >
            {eq.status}
          </span>
          {eq.fuel_type && <span style={{fontSize: 11, color: '#6b7280'}}>{eq.fuel_type}</span>}
        </div>
        <div
          style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, fontSize: 11}}
        >
          <div>
            <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
              {eq.tracking_unit === 'km' ? 'Current KM' : 'Current Hours'}
            </div>
            <div style={{fontWeight: 700, color: '#111827'}}>{fmtReading(reading, eq.tracking_unit)}</div>
          </div>
          {latestFuel && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Last fueling
              </div>
              <div style={{fontWeight: 600, color: missedFuel ? '#b91c1c' : '#111827'}}>
                {fmt(latestFuel.date)}
                {daysSinceFuel != null ? ' (' + daysSinceFuel + 'd)' : ''}
              </div>
            </div>
          )}
          {dueInfo && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Next service
              </div>
              <div style={{fontWeight: 700, color: dueInfo.overdue ? '#b91c1c' : '#a16207'}}>
                {dueInfo.overdue
                  ? 'OVERDUE ' + dueInfo.hours_or_km + dueInfo.kind.charAt(0)
                  : dueInfo.hours_or_km + dueInfo.kind.charAt(0) + ' at ' + dueInfo.next_due}
              </div>
            </div>
          )}
          {warrantyExpiresSoon && (
            <div>
              <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4}}>
                Warranty
              </div>
              <div style={{fontWeight: 700, color: '#a16207'}}>{fmt(eq.warranty_expiration)}</div>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 18}}>
      <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: -8}}>
        <button
          onClick={() => setShowAdd(true)}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: EQUIPMENT_COLOR,
            color: 'white',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Add Equipment
        </button>
      </div>
      {showAdd && (
        <EquipmentAddModal
          sb={sb}
          onClose={() => setShowAdd(false)}
          onCreated={(rec) => {
            setShowAdd(false);
            if (onReload) onReload();
            onOpen(rec.slug);
          }}
        />
      )}
      {grouped.map((g) => (
        <div key={g.key}>
          <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
            <EquipmentCategoryIcon category={g} size={18} />
            <span
              style={{fontSize: 14, fontWeight: 700, color: g.color, textTransform: 'uppercase', letterSpacing: 0.4}}
            >
              {g.label}
            </span>
            <span style={{fontSize: 11, color: '#6b7280'}}>
              {g.rows.length} piece{g.rows.length === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10}}>
            {g.rows.map(tile)}
          </div>
        </div>
      ))}
      {sold.length > 0 && (
        <div style={{marginTop: 10}}>
          <div style={{fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 6}}>SOLD ({sold.length})</div>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8}}>
            {sold.map((eq) => (
              <div
                key={eq.id}
                onClick={() => onOpen(eq.slug)}
                className="hoverable-tile"
                style={{
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 10,
                  padding: '10px 14px',
                  cursor: 'pointer',
                  opacity: 0.8,
                }}
              >
                <div style={{fontSize: 13, fontWeight: 700, color: '#374151'}}>{eq.name}</div>
                <div style={{fontSize: 11, color: '#9ca3af'}}>{eq.serial_number || '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {React.createElement(ActivityModal, {
        sb,
        authState,
        target: activityTarget,
        onClose: () => setActivityTarget(null),
      })}
    </div>
  );
}
