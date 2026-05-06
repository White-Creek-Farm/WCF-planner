// FuelLogAdmin — admin ledger for fuel supplies (fuel delivered to the
// farm). Lives under /webforms → Fuel Log tab. Shows the supply history,
// YTD + 30-day totals by destination, and inline edit/delete per row.
//
// Also surfaces the /fueling/supply public webform URL so admin can share it
// to operators.

import React from 'react';
import {sb} from '../lib/supabase.js';
import FuelBillsView from './FuelBillsView.jsx';
import FuelReconcileView from './FuelReconcileView.jsx';

const DESTINATIONS = [
  {value: 'cell', label: 'Portable fuel cell', color: '#92400e', bg: '#fef3c7'},
  {value: 'gas_can', label: 'Gas can(s)', color: '#7f1d1d', bg: '#fee2e2'},
  {value: 'farm_truck', label: 'Farm truck', color: '#1e40af', bg: '#dbeafe'},
  {value: 'other', label: 'Other', color: '#374151', bg: '#f3f4f6'},
];
const FUEL_TYPES = ['diesel', 'gasoline', 'def'];
const destMeta = Object.fromEntries(DESTINATIONS.map((d) => [d.value, d]));

function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${m}/${d}/${y.slice(2)}`;
}
function money(n) {
  if (n == null || n === '') return '—';
  return '$' + Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export default function FuelLogAdmin() {
  const [mode, setMode] = React.useState('supplies'); // 'supplies' | 'bills' | 'reconcile'
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [missingSchema, setMissingSchema] = React.useState(false);
  const [editingId, setEditingId] = React.useState(null);
  const [newOpen, setNewOpen] = React.useState(false);

  async function load() {
    setLoading(true);
    const {data, error} = await sb.from('fuel_supplies').select('*').order('date', {ascending: false}).limit(5000);
    if (error && /does not exist|relation/i.test(error.message || '')) {
      setMissingSchema(true);
      setLoading(false);
      return;
    }
    setRows(data || []);
    setLoading(false);
  }
  React.useEffect(() => {
    load();
  }, []);

  // NOTE: missingSchema/loading checks are handled inside the supplies tab.
  // Bills + Reconcile tabs are independent and shouldn't be blocked by a
  // fuel_supplies query state.

  // Aggregates (safe even when rows is empty).
  const today = new Date();
  const ytdStart = today.getFullYear() + '-01-01';
  const thirtyAgo = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const ytd = rows.filter((r) => r.date >= ytdStart);
  const last30 = rows.filter((r) => r.date >= thirtyAgo);

  function totals(list) {
    const sum = (by) =>
      list.reduce((s, r) => s + (Number(r.gallons) || 0) * (r.fuel_type === by || by === '*' ? 1 : 0), 0);
    return {
      all: list.reduce((s, r) => s + (Number(r.gallons) || 0), 0),
      diesel: sum('diesel'),
      gasoline: sum('gasoline'),
      def: sum('def'),
      cost: list.reduce((s, r) => s + (Number(r.total_cost) || 0), 0),
      n: list.length,
    };
  }
  const ytdT = totals(ytd),
    last30T = totals(last30);

  const card = {
    background: 'white',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: '14px 18px',
    marginBottom: 14,
  };
  const th = {
    fontSize: 10,
    fontWeight: 700,
    color: '#6b7280',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    padding: '6px 10px',
    textAlign: 'left',
    background: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
  };
  const td = {fontSize: 12, padding: '8px 10px', borderBottom: '1px solid #f3f4f6', color: '#111827'};

  const tabBtn = (id, label) => {
    const on = mode === id;
    return (
      <button
        key={id}
        onClick={() => setMode(id)}
        style={{
          padding: '7px 14px',
          borderRadius: 6,
          border: on ? '2px solid #085041' : '1px solid #d1d5db',
          background: on ? '#085041' : 'white',
          color: on ? 'white' : '#374151',
          fontSize: 12,
          fontWeight: on ? 700 : 500,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        {label}
      </button>
    );
  };

  return (
    <div>
      <div style={{display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap'}}>
        {tabBtn('supplies', 'Supplies ledger')}
        {tabBtn('bills', 'Bills')}
        {tabBtn('reconcile', 'Reconciliation')}
      </div>

      {mode === 'bills' && <FuelBillsView />}
      {mode === 'reconcile' && <FuelReconcileView />}
      {mode !== 'supplies' ? null : (
        <>
          {missingSchema && (
            <div style={{padding: 20, fontSize: 13, color: '#b91c1c'}}>
              fuel_supplies table missing. Apply supabase-migrations/024_fuel_supplies_and_suppressed_flag.sql in the
              SQL Editor first.
            </div>
          )}
          {loading && !missingSchema && (
            <div style={{padding: 20, fontSize: 13, color: '#6b7280'}}>Loading fuel supplies…</div>
          )}
          {!loading && !missingSchema && (
            <>
              {/* Header + public URL */}
              <div style={{...card, background: '#f0fdf4', borderColor: '#86efac'}}>
                <div style={{display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap'}}>
                  <div style={{flex: 1, minWidth: 200}}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: '#065f46',
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      Public Webform
                    </div>
                    <div style={{fontSize: 14, fontWeight: 700, color: '#065f46', marginTop: 4}}>
                      ⛽ Fuel Supply Log
                    </div>
                    <div style={{fontSize: 12, color: '#047857', marginTop: 4}}>
                      Operators log fuel <strong>delivered to the farm</strong> (portable cell / gas cans / farm truck).
                      Per-equipment fuelings go under /equipment.
                    </div>
                  </div>
                  <div>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#065f46',
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      URL
                    </div>
                    <a
                      href="/equipment/supply"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{fontSize: 13, color: '#1d4ed8', fontFamily: 'monospace'}}
                    >
                      /equipment/supply
                    </a>
                  </div>
                </div>
              </div>

              {/* Aggregates */}
              <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14}}>
                <TotalsCard title="Year-to-date" t={ytdT} />
                <TotalsCard title="Last 30 days" t={last30T} />
              </div>

              {/* Ledger header + Add button */}
              <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8}}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 700,
                    color: '#111827',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                  }}
                >
                  Fuel Supply Ledger <span style={{color: '#9ca3af', fontWeight: 500}}>({rows.length} entries)</span>
                </div>
                <button
                  onClick={() => {
                    setNewOpen(!newOpen);
                    setEditingId(null);
                  }}
                  style={{
                    marginLeft: 'auto',
                    padding: '6px 14px',
                    borderRadius: 6,
                    border: 'none',
                    background: newOpen ? '#b91c1c' : '#085041',
                    color: 'white',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {newOpen ? '✕ Cancel' : '+ Add supply'}
                </button>
              </div>

              {newOpen && (
                <SupplyEditor
                  initial={{date: new Date().toISOString().slice(0, 10), destination: 'cell', fuel_type: 'diesel'}}
                  onCancel={() => setNewOpen(false)}
                  onSaved={() => {
                    setNewOpen(false);
                    load();
                  }}
                  isNew
                />
              )}

              {/* Ledger table */}
              <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden'}}>
                {rows.length === 0 ? (
                  <div style={{padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
                    No fuel supplies logged yet.
                  </div>
                ) : (
                  <table style={{width: '100%', borderCollapse: 'collapse'}}>
                    <thead>
                      <tr>
                        <th style={th}>Date</th>
                        <th style={{...th, textAlign: 'right'}}>Gal</th>
                        <th style={th}>Fuel</th>
                        <th style={th}>Destination</th>
                        <th style={th}>Team</th>
                        <th style={th}>Supplier</th>
                        <th style={{...th, textAlign: 'right'}}>$/gal</th>
                        <th style={{...th, textAlign: 'right'}}>Total</th>
                        <th style={th}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const dm = destMeta[r.destination] || destMeta.other;
                        const editing = editingId === r.id;
                        if (editing) {
                          return (
                            <tr key={r.id}>
                              <td colSpan={9} style={{padding: 0}}>
                                <SupplyEditor
                                  initial={r}
                                  onCancel={() => setEditingId(null)}
                                  onSaved={() => {
                                    setEditingId(null);
                                    load();
                                  }}
                                />
                              </td>
                            </tr>
                          );
                        }
                        return (
                          <tr key={r.id} style={{cursor: 'pointer'}} onClick={() => setEditingId(r.id)}>
                            <td style={td}>{fmtDate(r.date)}</td>
                            <td style={{...td, textAlign: 'right', fontWeight: 600}}>
                              {Number(r.gallons).toLocaleString(undefined, {maximumFractionDigits: 1})}
                            </td>
                            <td style={td}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '2px 7px',
                                  borderRadius: 4,
                                  background: '#eff6ff',
                                  color: '#1e40af',
                                  textTransform: 'uppercase',
                                }}
                              >
                                {r.fuel_type || '?'}
                              </span>
                            </td>
                            <td style={td}>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 700,
                                  padding: '2px 7px',
                                  borderRadius: 4,
                                  background: dm.bg,
                                  color: dm.color,
                                  textTransform: 'uppercase',
                                }}
                              >
                                {dm.label}
                              </span>
                            </td>
                            <td style={td}>{r.team_member || '—'}</td>
                            <td style={{...td, color: '#6b7280'}}>{r.supplier || '—'}</td>
                            <td style={{...td, textAlign: 'right', color: '#6b7280'}}>{money(r.cost_per_gal)}</td>
                            <td style={{...td, textAlign: 'right', color: '#065f46', fontWeight: 600}}>
                              {money(r.total_cost)}
                            </td>
                            <td style={{...td, color: '#9ca3af', fontSize: 11}}>edit ▸</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function TotalsCard({title, t}) {
  return (
    <div style={{background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px'}}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginBottom: 8,
        }}
      >
        {title} <span style={{color: '#9ca3af', fontWeight: 500}}>({t.n} entries)</span>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
        <div>
          <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase'}}>Total gallons</div>
          <div style={{fontSize: 22, fontWeight: 700, color: '#111827'}}>{Math.round(t.all).toLocaleString()}</div>
        </div>
        <div>
          <div style={{fontSize: 10, color: '#9ca3af', textTransform: 'uppercase'}}>Spend</div>
          <div style={{fontSize: 22, fontWeight: 700, color: '#065f46'}}>{money(t.cost)}</div>
        </div>
      </div>
      <div style={{display: 'flex', gap: 8, marginTop: 10, fontSize: 11, color: '#6b7280', flexWrap: 'wrap'}}>
        <span>
          Diesel: <strong style={{color: '#1e40af'}}>{Math.round(t.diesel).toLocaleString()}</strong>
        </span>
        <span>
          Gasoline: <strong style={{color: '#a16207'}}>{Math.round(t.gasoline).toLocaleString()}</strong>
        </span>
        <span>
          DEF: <strong style={{color: '#92400e'}}>{Math.round(t.def).toLocaleString()}</strong>
        </span>
      </div>
    </div>
  );
}

function SupplyEditor({initial, onCancel, onSaved, isNew}) {
  const [r, setR] = React.useState({...initial});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const upd = (k, v) => setR((x) => ({...x, [k]: v}));

  async function save() {
    setErr('');
    const gal = parseFloat(r.gallons);
    if (!r.date) {
      setErr('Date required');
      return;
    }
    if (!Number.isFinite(gal) || gal <= 0) {
      setErr('Gallons must be > 0');
      return;
    }
    setBusy(true);
    const rec = {
      id: r.id || 'fs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      date: r.date,
      gallons: gal,
      fuel_type: r.fuel_type || null,
      supplier: (r.supplier || '').trim() || null,
      cost_per_gal: r.cost_per_gal ? Number(r.cost_per_gal) : null,
      total_cost: r.total_cost ? Number(r.total_cost) : null,
      destination: r.destination || 'cell',
      team_member: r.team_member || null,
      notes: (r.notes || '').trim() || null,
      source: r.source || 'manual',
    };
    const {error} = await sb.from('fuel_supplies').upsert(rec, {onConflict: 'id'});
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onSaved();
  }

  async function del() {
    if (!r.id) return;
    if (!confirm('Delete this fuel supply entry?')) return;
    setBusy(true);
    const {error} = await sb.from('fuel_supplies').delete().eq('id', r.id);
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onSaved();
  }

  const inp = {
    fontSize: 13,
    padding: '6px 9px',
    border: '1px solid #d1d5db',
    borderRadius: 5,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
  const lbl = {
    fontSize: 10,
    color: '#6b7280',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 3,
    display: 'block',
  };

  return (
    <div
      style={{
        background: '#fafafa',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '14px 18px',
        margin: isNew ? '0 0 14px' : 0,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div>
          <label style={lbl}>Date</label>
          <input type="date" value={r.date || ''} onChange={(e) => upd('date', e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>Destination</label>
          <select value={r.destination || 'cell'} onChange={(e) => upd('destination', e.target.value)} style={inp}>
            {DESTINATIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={lbl}>Fuel</label>
          <select value={r.fuel_type || ''} onChange={(e) => upd('fuel_type', e.target.value)} style={inp}>
            {FUEL_TYPES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={lbl}>Gallons</label>
          <input
            type="number"
            min="0"
            step="0.1"
            value={r.gallons || ''}
            onChange={(e) => upd('gallons', e.target.value)}
            style={inp}
          />
        </div>
        <div>
          <label style={lbl}>Team</label>
          <input
            type="text"
            value={r.team_member || ''}
            onChange={(e) => upd('team_member', e.target.value)}
            style={inp}
          />
        </div>
        <div>
          <label style={lbl}>Supplier</label>
          <input type="text" value={r.supplier || ''} onChange={(e) => upd('supplier', e.target.value)} style={inp} />
        </div>
        <div>
          <label style={lbl}>$/gal</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={r.cost_per_gal || ''}
            onChange={(e) => upd('cost_per_gal', e.target.value)}
            style={inp}
          />
        </div>
        <div>
          <label style={lbl}>Total $</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={r.total_cost || ''}
            onChange={(e) => upd('total_cost', e.target.value)}
            style={inp}
          />
        </div>
      </div>
      <div style={{marginBottom: 10}}>
        <label style={lbl}>Notes</label>
        <textarea
          rows={2}
          value={r.notes || ''}
          onChange={(e) => upd('notes', e.target.value)}
          style={{...inp, resize: 'vertical'}}
        />
      </div>
      {err && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#b91c1c',
            padding: '6px 10px',
            borderRadius: 5,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          {err}
        </div>
      )}
      <div style={{display: 'flex', gap: 8}}>
        <button
          onClick={save}
          disabled={busy}
          style={{
            padding: '6px 16px',
            borderRadius: 5,
            border: 'none',
            background: busy ? '#9ca3af' : '#085041',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {busy ? 'Saving…' : isNew ? 'Add' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          style={{
            padding: '6px 16px',
            borderRadius: 5,
            border: '1px solid #d1d5db',
            background: 'white',
            color: '#374151',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
        {!isNew && r.id && (
          <button
            onClick={del}
            disabled={busy}
            style={{
              marginLeft: 'auto',
              padding: '6px 12px',
              borderRadius: 5,
              border: '1px solid #fecaca',
              background: 'white',
              color: '#b91c1c',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}
