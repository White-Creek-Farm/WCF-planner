import React from 'react';
import {sb} from '../lib/supabase.js';
import {restoreDailyReport} from '../lib/dailyReportsApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

const TABLE_CONFIG = {
  'poultry.daily': {
    table: 'poultry_dailys',
    label: 'Broiler',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'layer.daily': {
    table: 'layer_dailys',
    label: 'Layer',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'egg.daily': {
    table: 'egg_dailys',
    label: 'Egg',
    select: 'id, date, deleted_at, deleted_by, team_member',
    identity: () => '',
  },
  'pig.daily': {
    table: 'pig_dailys',
    label: 'Pig',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'cattle.daily': {
    table: 'cattle_dailys',
    label: 'Cattle',
    select: 'id, date, deleted_at, deleted_by, herd, team_member',
    identity: (r) => r.herd || '',
  },
  'sheep.daily': {
    table: 'sheep_dailys',
    label: 'Sheep',
    select: 'id, date, deleted_at, deleted_by, flock, team_member',
    identity: (r) => r.flock || '',
  },
};

const BADGE_COLORS = {
  Broiler: {bg: '#fef3c7', color: '#92400e'},
  Layer: {bg: '#dbeafe', color: '#1e40af'},
  Egg: {bg: '#ede9fe', color: '#5b21b6'},
  Pig: {bg: '#fce7f3', color: '#9d174d'},
  Cattle: {bg: '#d1fae5', color: '#065f46'},
  Sheep: {bg: '#e0f2fe', color: '#075985'},
};

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString();
  } catch (_e) {
    return d;
  }
}

export default function RecentlyDeletedDailyReports({refreshDailys}) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [queryErrors, setQueryErrors] = React.useState([]);

  const load = React.useCallback(async () => {
    setLoading(true);
    const all = [];
    const errors = [];
    for (const [entityType, cfg] of Object.entries(TABLE_CONFIG)) {
      const {data, error} = await sb
        .from(cfg.table)
        .select(cfg.select)
        .not('deleted_at', 'is', null)
        .order('deleted_at', {ascending: false})
        .limit(50);
      if (error) {
        errors.push(cfg.label + ': ' + error.message);
        continue;
      }
      if (data) {
        for (const r of data) {
          all.push({...r, entityType, tableLabel: cfg.label, identityLabel: cfg.identity(r)});
        }
      }
    }
    all.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
    setRows(all);
    setQueryErrors(errors);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleRestore(row) {
    setNotice(null);
    try {
      const label = row.date + (row.identityLabel ? ' · ' + row.identityLabel : '');
      await restoreDailyReport(sb, row.entityType, row.id, label);
      setRows((prev) => prev.filter((r) => !(r.id === row.id && r.entityType === row.entityType)));
      if (refreshDailys) refreshDailys('all');
      setNotice({kind: 'success', message: 'Report restored: ' + row.tableLabel + ' ' + row.date});
    } catch (e) {
      setNotice({kind: 'error', message: 'Restore failed: ' + (e.message || String(e))});
    }
  }

  return (
    <div>
      <div style={{fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 12}}>
        Recently Deleted Daily Reports
      </div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {queryErrors.length > 0 && (
        <div style={{color: '#b91c1c', fontSize: 12, marginBottom: 8}}>
          {queryErrors.map((e, i) => (
            <div key={i}>{e}</div>
          ))}
        </div>
      )}
      {loading && <div style={{color: '#9ca3af', fontSize: 13, padding: '2rem 0'}}>Loading…</div>}
      {!loading && rows.length === 0 && queryErrors.length === 0 && (
        <div style={{color: '#6b7280', fontSize: 13, padding: '2rem 0', textAlign: 'center'}}>No deleted reports.</div>
      )}
      {!loading && rows.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          {rows.map((r) => {
            const bc = BADGE_COLORS[r.tableLabel] || {bg: '#f3f4f6', color: '#374151'};
            return (
              <div
                key={r.entityType + '-' + r.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  background: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              >
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: bc.bg,
                    color: bc.color,
                    textTransform: 'uppercase',
                  }}
                >
                  {r.tableLabel}
                </span>
                <span style={{fontWeight: 600, color: '#111827'}}>{r.date}</span>
                {r.identityLabel && <span style={{color: '#6b7280'}}>{r.identityLabel}</span>}
                {r.team_member && <span style={{color: '#9ca3af', fontSize: 11}}>by {r.team_member}</span>}
                <span style={{color: '#9ca3af', fontSize: 11, marginLeft: 'auto'}}>
                  Deleted {fmtDate(r.deleted_at)}
                </span>
                <button
                  onClick={() => handleRestore(r)}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 6,
                    border: '1px solid #065f46',
                    background: '#ecfdf5',
                    color: '#065f46',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  Restore
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
