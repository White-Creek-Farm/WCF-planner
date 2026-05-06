// FuelReconcileView — month-by-month reconciliation of PURCHASED vs CONSUMED.
//
//   • Purchased = fuel_bills + fuel_bill_lines (supplier invoices), grouped
//     by delivery_date month. Authoritative source of what was bought.
//   • Consumed = equipment_fuelings (per-piece checklists at /fueling/<slug>)
//     PLUS non-cell fuel_supplies (direct dispensing at /fueling/supply for
//     gas cans, farm truck, etc.), both grouped by date month.
//   • Cell-refill rows on fuel_supplies (destination='cell') are inventory
//     movement (filling the portable cell from a supplier delivery), not
//     consumption — excluded so the same gallons aren't double-counted once
//     equipment fuelings record what was pulled out of the cell later.
//
// Single-month variance is rarely meaningful — month timing and inventory
// carryover (fuel sitting in cell across month boundaries) means an exact
// match shouldn't be expected. Look at multi-month trends.
//
// equipment_fuelings stores DEF in a separate def_gallons column (added when
// an equipment fillup also dispenses DEF), distinct from the gallons + fuel_type
// pair. Aggregation reads both: gallons → diesel/gasoline bucket per fuel_type;
// def_gallons → def bucket regardless of fuel_type.

import React from 'react';
import {sb} from '../lib/supabase.js';

const VARIANCE_WARN_PCT = 5;

function monthKey(dateStr) {
  if (!dateStr) return null;
  return String(dateStr).slice(0, 7); // YYYY-MM
}
function monthLabel(yyyymm) {
  const [y, m] = yyyymm.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[parseInt(m, 10) - 1] + ' ' + y;
}
function money(n) {
  if (n == null || n === 0) return '—';
  return '$' + Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export default function FuelReconcileView() {
  const [loading, setLoading] = React.useState(true);
  const [missingSchema, setMissingSchema] = React.useState(false);
  const [bills, setBills] = React.useState([]);
  const [billLines, setBillLines] = React.useState([]);
  const [supplies, setSupplies] = React.useState([]);
  const [fuelings, setFuelings] = React.useState([]);

  async function load() {
    setLoading(true);
    const [billsRes, linesRes, supRes, fuelRes] = await Promise.all([
      sb.from('fuel_bills').select('*').order('delivery_date', {ascending: false}).limit(2000),
      sb.from('fuel_bill_lines').select('*').limit(10000),
      sb.from('fuel_supplies').select('*').order('date', {ascending: false}).limit(10000),
      sb
        .from('equipment_fuelings')
        .select('id,date,gallons,def_gallons,fuel_type,suppressed')
        .order('date', {ascending: false})
        .limit(20000),
    ]);
    if (billsRes.error && /does not exist|relation/i.test(billsRes.error.message || '')) {
      setMissingSchema(true);
      setLoading(false);
      return;
    }
    setBills(billsRes.data || []);
    setBillLines(linesRes.data || []);
    setSupplies(supRes.data || []);
    setFuelings(fuelRes.data || []);
    setLoading(false);
  }
  React.useEffect(() => {
    load();
  }, []);

  if (missingSchema) {
    return (
      <div style={{padding: 20, fontSize: 13, color: '#b91c1c'}}>
        fuel_bills table missing. Apply supabase-migrations/026_fuel_bills.sql in the SQL Editor first.
      </div>
    );
  }
  if (loading) return <div style={{padding: 20, fontSize: 13, color: '#6b7280'}}>Loading…</div>;

  const billsById = Object.fromEntries(bills.map((b) => [b.id, b]));
  const months = new Map();

  function ensureMonth(k) {
    if (!months.has(k))
      months.set(k, {
        purchased: {diesel: 0, gasoline: 0, def: 0, cost: 0},
        consumed: {diesel: 0, gasoline: 0, def: 0},
        billCount: 0,
        eqCount: 0, // equipment_fueling rows
        directCount: 0, // non-cell fuel_supplies rows
      });
    return months.get(k);
  }

  // PURCHASED side: bills grouped by delivery_date month.
  for (const ln of billLines) {
    const bill = billsById[ln.bill_id];
    const k = monthKey(bill && bill.delivery_date);
    if (!k) continue;
    const m = ensureMonth(k);
    const t = ln.fuel_type;
    if (t && m.purchased[t] != null) m.purchased[t] += Number(ln.net_units) || 0;
    m.purchased.cost += Number(ln.line_total) || 0;
  }
  for (const b of bills) {
    const k = monthKey(b.delivery_date);
    if (!k) continue;
    ensureMonth(k).billCount += 1;
  }

  // CONSUMED side, part 1: equipment_fuelings (skip suppressed soft-deletes).
  for (const f of fuelings) {
    if (f.suppressed) continue;
    const k = monthKey(f.date);
    if (!k) continue;
    const m = ensureMonth(k);
    const t = f.fuel_type;
    const gal = Number(f.gallons) || 0;
    if (t && m.consumed[t] != null && gal > 0) m.consumed[t] += gal;
    const def = Number(f.def_gallons) || 0;
    if (def > 0) m.consumed.def += def;
    if (gal > 0 || def > 0) m.eqCount += 1;
  }

  // CONSUMED side, part 2: non-cell fuel_supplies (gas cans, farm truck, other).
  // destination='cell' rows are inventory movement (filling the portable cell
  // from supplier) — excluding them avoids double-counting against bills.
  for (const s of supplies) {
    if (s.destination === 'cell') continue;
    const k = monthKey(s.date);
    if (!k) continue;
    const m = ensureMonth(k);
    const t = s.fuel_type;
    const gal = Number(s.gallons) || 0;
    if (t && m.consumed[t] != null && gal > 0) m.consumed[t] += gal;
    if (gal > 0) m.directCount += 1;
  }

  const sorted = Array.from(months.entries()).sort((a, b) => b[0].localeCompare(a[0]));

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

  function variancePct(purchasedGal, consumedGal) {
    if (purchasedGal === 0 && consumedGal === 0) return null;
    if (purchasedGal === 0) return null; // no purchase to compare against
    return ((consumedGal - purchasedGal) / purchasedGal) * 100;
  }
  function varColor(pct) {
    if (pct == null) return '#9ca3af';
    if (Math.abs(pct) <= VARIANCE_WARN_PCT) return '#065f46';
    if (Math.abs(pct) <= VARIANCE_WARN_PCT * 2) return '#9a3412';
    return '#b91c1c';
  }
  // Sibling helper: same threshold constant + Math.abs semantics as varColor
  // so the two cannot drift. Returned as a stable string for Playwright
  // selectors (data-variance-band attribute on the variance cells).
  function varBand(pct) {
    if (pct == null) return 'none';
    if (Math.abs(pct) <= VARIANCE_WARN_PCT) return 'green';
    if (Math.abs(pct) <= VARIANCE_WARN_PCT * 2) return 'orange';
    return 'red';
  }

  return (
    <div>
      <div style={{...card, background: '#f0fdf4', borderColor: '#86efac'}}>
        <div style={{fontSize: 12, color: '#065f46', lineHeight: 1.5}}>
          <strong>How this works:</strong> <strong>Purchased</strong> = supplier bills (Home Oil etc.) grouped by
          delivery month. <strong>Consumed</strong> = per-piece equipment fueling checklists at{' '}
          <code>/equipment/&lt;piece&gt;</code> plus direct non-equipment dispensing at <code>/equipment/supply</code>{' '}
          (gas cans, farm truck, other). Cell refills (fuel going INTO the portable cell from a supplier delivery) are
          inventory movement, NOT consumption — they're excluded so we don't double-count once the equipment checklists
          record what was later pulled out of the cell. Variance bands: <strong>&le;{VARIANCE_WARN_PCT}% green</strong>{' '}
          ·{' '}
          <strong>
            {VARIANCE_WARN_PCT}–{VARIANCE_WARN_PCT * 2}% orange
          </strong>{' '}
          · <strong>&gt;{VARIANCE_WARN_PCT * 2}% red</strong>. <em>Single-month variance is rarely meaningful</em> —
          month timing (bill arrives one month, fuel gets consumed the next) and inventory carryover in the cell make
          exact monthly matches uncommon. Look at multi-month trends.
        </div>
      </div>

      <div style={{...card, padding: 0, overflow: 'auto'}}>
        {sorted.length === 0 ? (
          <div style={{padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13}}>
            No bills, equipment fuelings, or direct fuel logs yet.
          </div>
        ) : (
          <table style={{width: '100%', borderCollapse: 'collapse', minWidth: 1100}}>
            <thead>
              <tr>
                <th rowSpan={2} style={th}>
                  Month
                </th>
                <th colSpan={4} style={{...th, borderBottom: '1px solid #d1d5db', textAlign: 'center'}}>
                  Purchased (bills)
                </th>
                <th colSpan={3} style={{...th, borderBottom: '1px solid #d1d5db', textAlign: 'center'}}>
                  Consumed (equipment + direct)
                </th>
                <th colSpan={3} style={{...th, borderBottom: '1px solid #d1d5db', textAlign: 'center'}}>
                  Variance %
                </th>
              </tr>
              <tr>
                <th style={{...th, textAlign: 'right'}}>Diesel</th>
                <th style={{...th, textAlign: 'right'}}>Gas</th>
                <th style={{...th, textAlign: 'right'}}>DEF</th>
                <th style={{...th, textAlign: 'right'}}>Cost</th>
                <th style={{...th, textAlign: 'right'}}>Diesel</th>
                <th style={{...th, textAlign: 'right'}}>Gas</th>
                <th style={{...th, textAlign: 'right'}}>DEF</th>
                <th style={{...th, textAlign: 'right'}}>Diesel</th>
                <th style={{...th, textAlign: 'right'}}>Gas</th>
                <th style={{...th, textAlign: 'right'}}>DEF</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(([k, m]) => {
                const vDiesel = variancePct(m.purchased.diesel, m.consumed.diesel);
                const vGas = variancePct(m.purchased.gasoline, m.consumed.gasoline);
                const vDef = variancePct(m.purchased.def, m.consumed.def);
                const usageBits = [];
                if (m.eqCount) usageBits.push(`${m.eqCount} equipment`);
                if (m.directCount) usageBits.push(`${m.directCount} direct`);
                const usageLabel = usageBits.length ? usageBits.join(' / ') : '0 use';
                return (
                  <tr key={k}>
                    <td style={{...td, fontWeight: 600}}>
                      {monthLabel(k)}{' '}
                      <span style={{color: '#9ca3af', fontWeight: 400, fontSize: 10}}>
                        · {m.billCount} bill{m.billCount === 1 ? '' : 's'} / {usageLabel}
                      </span>
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="diesel"
                      data-cell="purchased"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.purchased.diesel ? '#1e40af' : '#9ca3af',
                        fontWeight: m.purchased.diesel ? 600 : 400,
                      }}
                    >
                      {m.purchased.diesel ? Math.round(m.purchased.diesel).toLocaleString() : '—'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="gasoline"
                      data-cell="purchased"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.purchased.gasoline ? '#a16207' : '#9ca3af',
                        fontWeight: m.purchased.gasoline ? 600 : 400,
                      }}
                    >
                      {m.purchased.gasoline ? Math.round(m.purchased.gasoline).toLocaleString() : '—'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="def"
                      data-cell="purchased"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.purchased.def ? '#92400e' : '#9ca3af',
                        fontWeight: m.purchased.def ? 600 : 400,
                      }}
                    >
                      {m.purchased.def ? Math.round(m.purchased.def).toLocaleString() : '—'}
                    </td>
                    <td style={{...td, textAlign: 'right', color: '#065f46', fontWeight: 600}}>
                      {money(m.purchased.cost)}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="diesel"
                      data-cell="consumed"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.consumed.diesel ? '#1e40af' : '#9ca3af',
                        fontWeight: m.consumed.diesel ? 600 : 400,
                      }}
                    >
                      {m.consumed.diesel ? Math.round(m.consumed.diesel).toLocaleString() : '—'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="gasoline"
                      data-cell="consumed"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.consumed.gasoline ? '#a16207' : '#9ca3af',
                        fontWeight: m.consumed.gasoline ? 600 : 400,
                      }}
                    >
                      {m.consumed.gasoline ? Math.round(m.consumed.gasoline).toLocaleString() : '—'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="def"
                      data-cell="consumed"
                      style={{
                        ...td,
                        textAlign: 'right',
                        color: m.consumed.def ? '#92400e' : '#9ca3af',
                        fontWeight: m.consumed.def ? 600 : 400,
                      }}
                    >
                      {m.consumed.def ? Math.round(m.consumed.def).toLocaleString() : '—'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="diesel"
                      data-cell="variance"
                      data-variance-band={varBand(vDiesel)}
                      style={{...td, textAlign: 'right', color: varColor(vDiesel), fontWeight: 700}}
                    >
                      {vDiesel == null ? '—' : (vDiesel >= 0 ? '+' : '') + vDiesel.toFixed(1) + '%'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="gasoline"
                      data-cell="variance"
                      data-variance-band={varBand(vGas)}
                      style={{...td, textAlign: 'right', color: varColor(vGas), fontWeight: 700}}
                    >
                      {vGas == null ? '—' : (vGas >= 0 ? '+' : '') + vGas.toFixed(1) + '%'}
                    </td>
                    <td
                      data-month={k}
                      data-fuel-type="def"
                      data-cell="variance"
                      data-variance-band={varBand(vDef)}
                      style={{...td, textAlign: 'right', color: varColor(vDef), fontWeight: 700}}
                    >
                      {vDef == null ? '—' : (vDef >= 0 ? '+' : '') + vDef.toFixed(1) + '%'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
