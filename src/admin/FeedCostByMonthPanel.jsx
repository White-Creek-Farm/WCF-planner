// Phase 2 Round 4 extraction (verbatim).
import React from 'react';
import {wcfSelectAll} from '../lib/pagination.js';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';

const FeedCostByMonthPanel = ({sb, feedCosts}) => {
  const {useState, useEffect} = React;
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [pd, ld, pg, cd, cfiRes] = await Promise.all([
        wcfSelectAll((f, t) =>
          sb.from('poultry_dailys').select('date,feed_lbs,feed_type').is('deleted_at', null).range(f, t),
        ),
        wcfSelectAll((f, t) =>
          sb.from('layer_dailys').select('date,feed_lbs,feed_type').is('deleted_at', null).range(f, t),
        ),
        wcfSelectAll((f, t) => sb.from('pig_dailys').select('date,feed_lbs').is('deleted_at', null).range(f, t)),
        wcfSelectAll((f, t) => sb.from('cattle_dailys').select('date,feeds').is('deleted_at', null).range(f, t)),
        sb.from('cattle_feed_inputs').select('name,cost_per_unit,freight_per_truck,units_per_truck'),
      ]);
      const cfi = (cfiRes && cfiRes.data) || [];
      const feedCostMap = {};
      for (const f of cfi) {
        const base = parseFloat(f.cost_per_unit) || 0;
        const fpt = parseFloat(f.freight_per_truck) || 0;
        const upt = parseInt(f.units_per_truck) || 0;
        const perUnit = base + (upt > 0 ? fpt / upt : 0);
        feedCostMap[f.name] = perUnit;
      }

      const months = new Map();
      const bump = (ym, prog, amt) => {
        if (!months.has(ym)) months.set(ym, {broiler: 0, layer: 0, pig: 0, cattle: 0});
        months.get(ym)[prog] += amt;
      };

      for (const d of pd || []) {
        const ym = (d.date || '').slice(0, 7);
        if (!ym) continue;
        const lbs = parseFloat(d.feed_lbs) || 0;
        const t = String(d.feed_type || '').toLowerCase();
        const cost = t === 'starter' || t === 'grower' ? parseFloat(feedCosts[t]) || 0 : 0;
        if (cost > 0 && lbs > 0) bump(ym, 'broiler', lbs * cost);
      }
      for (const d of ld || []) {
        const ym = (d.date || '').slice(0, 7);
        if (!ym) continue;
        const lbs = parseFloat(d.feed_lbs) || 0;
        const t = String(d.feed_type || '').toLowerCase();
        const cost =
          t === 'starter' || t === 'grower' ? parseFloat(feedCosts[t]) || 0 : parseFloat(feedCosts.layer) || 0;
        if (cost > 0 && lbs > 0) bump(ym, 'layer', lbs * cost);
      }
      const pigCost = parseFloat(feedCosts.pig) || 0;
      for (const d of pg || []) {
        const ym = (d.date || '').slice(0, 7);
        if (!ym) continue;
        const lbs = parseFloat(d.feed_lbs) || 0;
        if (pigCost > 0 && lbs > 0) bump(ym, 'pig', lbs * pigCost);
      }
      for (const d of cd || []) {
        const ym = (d.date || '').slice(0, 7);
        if (!ym) continue;
        const feeds = Array.isArray(d.feeds) ? d.feeds : [];
        for (const f of feeds) {
          const qty = parseFloat(f.qty) || 0;
          const perUnit = feedCostMap[f.feed_name] || 0;
          if (qty > 0 && perUnit > 0) bump(ym, 'cattle', qty * perUnit);
        }
      }

      const out = [...months.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, v]) => ({month, ...v, total: v.broiler + v.layer + v.pig + v.cattle}));
      setRows(out);
      setLoading(false);
    })();
  }, [feedCosts.starter, feedCosts.grower, feedCosts.layer, feedCosts.pig]);

  const fmtCost = (n) => (n > 0 ? '$' + n.toLocaleString(undefined, {maximumFractionDigits: 0}) : '\u2014');
  const fmtMonth = (ym) => {
    const [y, m] = ym.split('-');
    return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleString('en-US', {month: 'short', year: 'numeric'});
  };

  const totals = rows.reduce(
    (s, r) => ({
      broiler: s.broiler + r.broiler,
      layer: s.layer + r.layer,
      pig: s.pig + r.pig,
      cattle: s.cattle + r.cattle,
      total: s.total + r.total,
    }),
    {broiler: 0, layer: 0, pig: 0, cattle: 0, total: 0},
  );

  return (
    <div style={{marginTop: 8}}>
      <div style={{background: 'white', border: '1px solid var(--border)', borderRadius: 10, padding: '20px'}}>
        <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 4}}>Feed Cost by Month</div>
        <div style={{fontSize: 12, color: 'var(--ink-muted)', marginBottom: 14}}>
          Aggregated from daily reports. Broiler / Layer / Pig rates come from <strong>Feed Costs</strong> above. Cattle
          cost per feed comes from the <strong>Cattle & Sheep Inputs</strong> panel (cost per unit + freight amortized
          across units per truck). Current costs apply to all months \u2014 no per-month historical ledger.
        </div>
        {loading && (
          <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)'}}>{'Loading\u2026'}</div>
        )}
        {!loading && rows.length === 0 && (
          <div style={{padding: '2rem', textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13}}>
            No daily reports with matching feed costs yet. Fill in feed costs above and in Cattle & Sheep Inputs to
            populate this view.
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', fontSize: 12, borderCollapse: 'collapse'}}>
              <thead>
                <tr style={{background: 'var(--surface-2)', borderBottom: '2px solid var(--border)'}}>
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'left',
                      fontWeight: 700,
                      color: 'var(--ink-muted)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Month
                  </th>
                  {/* WI-2b: species column headers carry an emoji/icon as their
                      identity marker; the label text itself is black, not a
                      per-program color. */}
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {'\ud83d\udc14 Broiler'}
                  </th>
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {'\ud83d\udc13 Layer'}
                  </th>
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {'\ud83d\udc37 Pig'}
                  </th>
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {renderCattleIconLabel('Cattle', {size: 16})}
                  </th>
                  <th
                    style={{
                      padding: '10px',
                      textAlign: 'right',
                      fontWeight: 700,
                      color: 'var(--ink)',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.month}
                    style={{borderBottom: '1px solid var(--divider)', background: i % 2 ? '#fafafa' : 'white'}}
                  >
                    <td style={{padding: '8px 10px', textAlign: 'left', fontWeight: 600, color: 'var(--ink)'}}>
                      {fmtMonth(r.month)}
                    </td>
                    {/* WI-2a: feed-cost figures are raw money totals, not a
                        good/bad signal — render black; zero stays muted. */}
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        color: r.broiler > 0 ? 'var(--text-primary)' : 'var(--ink-faint)',
                      }}
                    >
                      {fmtCost(r.broiler)}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        color: r.layer > 0 ? 'var(--text-primary)' : 'var(--ink-faint)',
                      }}
                    >
                      {fmtCost(r.layer)}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        color: r.pig > 0 ? 'var(--text-primary)' : 'var(--ink-faint)',
                      }}
                    >
                      {fmtCost(r.pig)}
                    </td>
                    <td
                      style={{
                        padding: '8px 10px',
                        textAlign: 'right',
                        color: r.cattle > 0 ? 'var(--text-primary)' : 'var(--ink-faint)',
                      }}
                    >
                      {fmtCost(r.cattle)}
                    </td>
                    <td style={{padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: 'var(--ink)'}}>
                      {fmtCost(r.total)}
                    </td>
                  </tr>
                ))}
                <tr style={{borderTop: '2px solid var(--text-primary)', background: '#f3f4f6'}}>
                  <td style={{padding: '10px', textAlign: 'left', fontWeight: 700, color: 'var(--ink)', fontSize: 12}}>
                    All-time total
                  </td>
                  <td style={{padding: '10px', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)'}}>
                    {fmtCost(totals.broiler)}
                  </td>
                  <td style={{padding: '10px', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)'}}>
                    {fmtCost(totals.layer)}
                  </td>
                  <td style={{padding: '10px', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)'}}>
                    {fmtCost(totals.pig)}
                  </td>
                  <td style={{padding: '10px', textAlign: 'right', fontWeight: 700, color: 'var(--text-primary)'}}>
                    {fmtCost(totals.cattle)}
                  </td>
                  <td style={{padding: '10px', textAlign: 'right', fontWeight: 800, color: 'var(--ink)', fontSize: 13}}>
                    {fmtCost(totals.total)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default FeedCostByMonthPanel;
