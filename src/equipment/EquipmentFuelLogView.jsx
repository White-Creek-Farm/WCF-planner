// EquipmentFuelLogView — flat list of every fueling entry across all
// equipment. Filters by equipment, fuel type, date range, team member.
// Matches the "Fuel Log" Podio tab's mental model.
import React from 'react';
import {stripPodioHtml} from '../lib/equipment.js';

export default function EquipmentFuelLogView({equipment, fuelings, fmt}) {
  const [eqFilter, setEqFilter] = React.useState('');
  const [fuelFilter, setFuelFilter] = React.useState('');
  const [teamFilter, setTeamFilter] = React.useState('');
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');

  const eqById = React.useMemo(() => Object.fromEntries(equipment.map((e) => [e.id, e])), [equipment]);
  const teamMembers = React.useMemo(() => {
    const set = new Set();
    fuelings.forEach((f) => {
      if (f.team_member) set.add(f.team_member);
    });
    return Array.from(set).sort();
  }, [fuelings]);

  const filtered = fuelings.filter((f) => {
    if (eqFilter && f.equipment_id !== eqFilter) return false;
    if (fuelFilter && f.fuel_type !== fuelFilter) return false;
    if (teamFilter && f.team_member !== teamFilter) return false;
    if (fromDate && (f.date || '') < fromDate) return false;
    if (toDate && (f.date || '') > toDate) return false;
    return true;
  });

  const totals = {
    count: filtered.length,
    gallons: filtered.reduce((s, f) => s + (parseFloat(f.gallons) || 0), 0),
    def_gallons: filtered.reduce((s, f) => s + (parseFloat(f.def_gallons) || 0), 0),
    cost: filtered.reduce((s, f) => s + (parseFloat(f.gallons) || 0) * (parseFloat(f.fuel_cost_per_gal) || 0), 0),
  };

  const inpS = {
    fontSize: 13,
    padding: '7px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

  return (
    <div>
      <div
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          padding: '12px 16px',
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <select value={eqFilter} onChange={(e) => setEqFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
          <option value="">All equipment</option>
          {equipment.map((eq) => (
            <option key={eq.id} value={eq.id}>
              {eq.name}
            </option>
          ))}
        </select>
        <select value={fuelFilter} onChange={(e) => setFuelFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
          <option value="">All fuel types</option>
          <option value="diesel">Diesel</option>
          <option value="gasoline">Gasoline</option>
          <option value="def">DEF</option>
        </select>
        <select value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} style={{...inpS, width: 'auto'}}>
          <option value="">All team members</option>
          {teamMembers.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
          style={inpS}
          title="From date"
        />
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={inpS} title="To date" />
        <button
          onClick={() => {
            setEqFilter('');
            setFuelFilter('');
            setTeamFilter('');
            setFromDate('');
            setToDate('');
          }}
          style={{
            padding: '7px 14px',
            borderRadius: 7,
            border: '1px solid #d1d5db',
            background: 'white',
            color: '#374151',
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Clear
        </button>
      </div>

      <div
        style={{
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          padding: '12px 18px',
          marginBottom: 14,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 14,
          fontSize: 11,
        }}
      >
        <div>
          <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Entries</div>
          <div style={{fontSize: 18, fontWeight: 700, color: '#111827'}}>{totals.count.toLocaleString()}</div>
        </div>
        <div>
          <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Gallons</div>
          <div style={{fontSize: 18, fontWeight: 700, color: '#1e40af'}}>
            {Math.round(totals.gallons).toLocaleString()}
          </div>
        </div>
        {totals.def_gallons > 0 && (
          <div>
            <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>DEF Gal</div>
            <div style={{fontSize: 18, fontWeight: 700, color: '#a16207'}}>
              {Math.round(totals.def_gallons).toLocaleString()}
            </div>
          </div>
        )}
        {totals.cost > 0 && (
          <div>
            <div style={{color: '#9ca3af', fontSize: 10, textTransform: 'uppercase'}}>Cost</div>
            <div style={{fontSize: 18, fontWeight: 700, color: '#065f46'}}>
              ${Math.round(totals.cost).toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <div
        data-mobile-hscroll="1"
        style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden'}}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 90px 70px 60px 80px 110px 1fr',
            columnGap: 14,
            background: '#f9fafb',
            padding: '8px 14px',
            fontSize: 10,
            fontWeight: 700,
            color: '#6b7280',
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            borderBottom: '1px solid #e5e7eb',
            minWidth: 700,
          }}
        >
          <div>Date</div>
          <div>Equipment</div>
          <div>Fuel</div>
          <div style={{textAlign: 'right'}}>Gal</div>
          <div style={{textAlign: 'right'}}>DEF</div>
          <div style={{textAlign: 'right'}}>Reading</div>
          <div>Team</div>
          <div>Comments</div>
        </div>
        {filtered.length === 0 && (
          <div style={{padding: '2rem', textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
            No fueling entries match the current filters.
          </div>
        )}
        {filtered.slice(0, 500).map((f, i) => {
          const eq = eqById[f.equipment_id];
          const reading =
            f.hours_reading != null
              ? Math.round(f.hours_reading) + ' h'
              : f.km_reading != null
                ? Math.round(f.km_reading) + ' km'
                : '—';
          return (
            <div
              key={f.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '90px 1fr 90px 70px 60px 80px 110px 1fr',
                columnGap: 14,
                padding: '6px 14px',
                fontSize: 12,
                borderBottom: i < Math.min(500, filtered.length) - 1 ? '1px solid #f3f4f6' : 'none',
                fontVariantNumeric: 'tabular-nums',
                minWidth: 700,
              }}
            >
              <div style={{color: '#111827'}}>{fmt(f.date)}</div>
              <div
                style={{
                  fontWeight: 600,
                  color: '#111827',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {eq ? eq.name : f.equipment_id}
              </div>
              <div style={{color: '#6b7280'}}>{f.fuel_type || '—'}</div>
              <div style={{textAlign: 'right', color: '#1e40af', fontWeight: 600}}>
                {f.gallons ? Math.round(f.gallons * 10) / 10 : '—'}
              </div>
              <div style={{textAlign: 'right', color: '#a16207', fontWeight: 600}}>
                {f.def_gallons ? Math.round(f.def_gallons * 10) / 10 : '—'}
              </div>
              <div style={{textAlign: 'right', color: '#6b7280'}}>{reading}</div>
              <div style={{color: '#6b7280'}}>{f.team_member || '—'}</div>
              <div
                style={{
                  color: '#6b7280',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontStyle: stripPodioHtml(f.comments) ? 'italic' : 'normal',
                }}
              >
                {stripPodioHtml(f.comments) || '—'}
              </div>
            </div>
          );
        })}
        {filtered.length > 500 && (
          <div
            style={{padding: '10px 14px', background: '#f9fafb', color: '#9ca3af', fontSize: 11, textAlign: 'center'}}
          >
            Showing first 500 of {filtered.length.toLocaleString()} entries. Narrow the filters to see more.
          </div>
        )}
      </div>
    </div>
  );
}
