import React from 'react';
import {sb} from '../lib/supabase.js';
import {restoreDailyReport} from '../lib/dailyReportsApi.js';
import {restoreCattleAnimal} from '../lib/cattleDeleteApi.js';
import {restoreSheepAnimal} from '../lib/sheepDeleteApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

const TABLE_CONFIG = {
  'poultry.daily': {
    recordKind: 'daily',
    table: 'poultry_dailys',
    label: 'Broiler Daily',
    badgeLabel: 'Broiler',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'layer.daily': {
    recordKind: 'daily',
    table: 'layer_dailys',
    label: 'Layer Daily',
    badgeLabel: 'Layer',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'egg.daily': {
    recordKind: 'daily',
    table: 'egg_dailys',
    label: 'Egg Daily',
    badgeLabel: 'Egg',
    select: 'id, date, deleted_at, deleted_by, team_member',
    identity: () => '',
  },
  'pig.daily': {
    recordKind: 'daily',
    table: 'pig_dailys',
    label: 'Pig Daily',
    badgeLabel: 'Pig',
    select: 'id, date, deleted_at, deleted_by, batch_label, team_member',
    identity: (r) => r.batch_label || '',
  },
  'cattle.daily': {
    recordKind: 'daily',
    table: 'cattle_dailys',
    label: 'Cattle Daily',
    badgeLabel: 'Cattle',
    select: 'id, date, deleted_at, deleted_by, herd, team_member',
    identity: (r) => r.herd || '',
  },
  'sheep.daily': {
    recordKind: 'daily',
    table: 'sheep_dailys',
    label: 'Sheep Daily',
    badgeLabel: 'Sheep',
    select: 'id, date, deleted_at, deleted_by, flock, team_member',
    identity: (r) => r.flock || '',
  },
};

const ANIMAL_CONFIG = {
  'cattle.animal': {
    recordKind: 'animal',
    table: 'cattle',
    label: 'Cattle Animal',
    badgeLabel: 'Cattle',
    select: 'id, tag, herd, sex, deleted_at, deleted_by',
    restore: restoreCattleAnimal,
    identity: (r) => (r.tag ? '#' + r.tag : '(no tag)'),
    detail: (r) => [r.herd, r.sex].filter(Boolean).join(' - '),
  },
  'sheep.animal': {
    recordKind: 'animal',
    table: 'sheep',
    label: 'Sheep Animal',
    badgeLabel: 'Sheep',
    select: 'id, tag, flock, sex, deleted_at, deleted_by',
    restore: restoreSheepAnimal,
    identity: (r) => (r.tag ? '#' + r.tag : '(no tag)'),
    detail: (r) => [r.flock, r.sex].filter(Boolean).join(' - '),
  },
};

const RECOVERY_CONFIG = {...TABLE_CONFIG, ...ANIMAL_CONFIG};

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

function restoreLabel(row) {
  return [row.date, row.identityLabel, row.detailLabel].filter(Boolean).join(' - ') || row.id;
}

export default function RecentlyDeletedDailyReports({refreshDailys}) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [notice, setNotice] = React.useState(null);
  const [loadError, setLoadError] = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const all = [];
    const errors = [];
    try {
      for (const [entityType, cfg] of Object.entries(RECOVERY_CONFIG)) {
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
            all.push({
              ...r,
              entityType,
              recordKind: cfg.recordKind,
              tableLabel: cfg.label,
              badgeLabel: cfg.badgeLabel || cfg.label,
              identityLabel: cfg.identity(r),
              detailLabel: cfg.detail ? cfg.detail(r) : '',
            });
          }
        }
      }
      if (errors.length > 0) {
        throw new Error(errors.join('\n'));
      }
      all.sort((a, b) => (b.deleted_at || '').localeCompare(a.deleted_at || ''));
      setRows(all);
    } catch (e) {
      setRows([]);
      setLoadError({
        kind: 'error',
        message: 'Could not load recently deleted records. Please retry.\n' + (e?.message || e),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  async function handleRestore(row) {
    setNotice(null);
    try {
      const label = restoreLabel(row);
      const cfg = RECOVERY_CONFIG[row.entityType];
      if (row.recordKind === 'daily') {
        await restoreDailyReport(sb, row.entityType, row.id, label);
        if (refreshDailys) refreshDailys('all');
      } else {
        await cfg.restore(sb, row.id, label);
      }
      setRows((prev) => prev.filter((r) => !(r.id === row.id && r.entityType === row.entityType)));
      setNotice({kind: 'success', message: 'Record restored: ' + row.tableLabel + ' ' + label});
    } catch (e) {
      setNotice({kind: 'error', message: 'Restore failed: ' + (e.message || String(e))});
    }
  }

  return (
    <div data-recently-deleted-dailys-loaded={loading || loadError ? 'false' : 'true'}>
      <div style={{fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 12}}>Recently Deleted Records</div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {loadError && (
        <div data-recently-deleted-dailys-load-error="true">
          <InlineNotice notice={loadError} />
          <button
            type="button"
            data-recently-deleted-dailys-retry="1"
            onClick={load}
            style={{
              padding: '7px 14px',
              borderRadius: 6,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#085041',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              marginBottom: 12,
            }}
          >
            Retry
          </button>
        </div>
      )}
      {loading && <div style={{color: '#9ca3af', fontSize: 13, padding: '2rem 0'}}>Loading...</div>}
      {!loading && !loadError && rows.length === 0 && (
        <div style={{color: '#6b7280', fontSize: 13, padding: '2rem 0', textAlign: 'center'}}>No deleted records.</div>
      )}
      {!loading && !loadError && rows.length > 0 && (
        <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
          {rows.map((r) => {
            const bc = BADGE_COLORS[r.badgeLabel] || {bg: '#f3f4f6', color: '#374151'};
            return (
              <div
                key={r.entityType + '-' + r.id}
                data-recently-deleted-record-kind={r.recordKind}
                data-recently-deleted-entity={r.entityType}
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
                <span style={{fontWeight: 600, color: '#111827'}}>{r.date || r.identityLabel || r.id}</span>
                {r.date && r.identityLabel && <span style={{color: '#6b7280'}}>{r.identityLabel}</span>}
                {r.detailLabel && <span style={{color: '#6b7280'}}>{r.detailLabel}</span>}
                {r.team_member && <span style={{color: '#9ca3af', fontSize: 11}}>by {r.team_member}</span>}
                <span style={{color: '#9ca3af', fontSize: 11, marginLeft: 'auto'}}>
                  Deleted {fmtDate(r.deleted_at)}
                </span>
                <button
                  type="button"
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
