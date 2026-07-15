import React from 'react';
import {sb} from '../lib/supabase.js';
import {currentReadingFromFuelings, fmtReading} from '../lib/equipment.js';
import {getProgramColor} from '../lib/programColors.js';
import {getReadableText} from '../lib/styles.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';

// ============================================================================
// EquipmentMeterStatusPanel
// ============================================================================
// Admin-facing explainer for the relationship between equipment.current_hours
// (or current_km) and the equipment's fuel-log history. Codex-2026 spec after
// the Toro 205h stale-reading incident: when the operator deletes/corrects a
// bad reading, the parent equipment row needs a clear path to be re-synced
// from the remaining history so service-due math doesn't keep using the bad
// number.
//
// Three states:
//   matching   — stored current === fuel-log max
//   ahead      — stored current > fuel-log max (manual meter read entered)
//   behind     — stored current < fuel-log max (stale; service math may run
//                against the wrong baseline)
//
// The Sync button uses currentReadingFromFuelings(eq, fuelings) and writes
// equipment.current_* scoped to eq.id only. No bulk-update path.
// ============================================================================

export default function EquipmentMeterStatusPanel({equipment, fuelings, fmt, onReload}) {
  const [notice, setNotice] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const eq = equipment;
  // The detail page keeps this panel MOUNTED while the prev/next arrows swap
  // the equipment prop, so a sync success/error notice from one machine would
  // otherwise keep rendering on every neighbour ("Synced… 5,437 h" leaking
  // onto other ATVs). Clear it whenever the panel starts showing a different
  // equipment row.
  const eqId = eq?.id;
  React.useEffect(() => {
    setNotice(null);
  }, [eqId]);
  const unit = eq?.tracking_unit === 'km' ? 'km' : 'hours';
  const currentField = unit === 'km' ? 'current_km' : 'current_hours';
  const readingField = unit === 'km' ? 'km_reading' : 'hours_reading';
  const unitChar = unit === 'km' ? 'k' : 'h';

  // Treat DB null / undefined / empty string as "no current reading set"
  // so the panel doesn't classify a missing meter as `behind 167h`. Plain
  // Number(null) returns 0, which would silently misread an unconfigured
  // equipment row as a stale-by-N case.
  const rawCurrent = eq?.[currentField];
  const hasCurrent =
    rawCurrent !== null && rawCurrent !== undefined && rawCurrent !== '' && Number.isFinite(Number(rawCurrent));
  const currentReading = hasCurrent ? Number(rawCurrent) : null;
  const list = Array.isArray(fuelings) ? fuelings : [];
  const fuelLogMax = currentReadingFromFuelings(eq, list);
  const hasFuelLog = Number.isFinite(fuelLogMax);
  const diff = hasCurrent && hasFuelLog ? Math.round((currentReading - fuelLogMax) * 10) / 10 : null;

  // Latest fueling row by date for the "last entry" line.
  const latest = list.reduce((m, f) => (!m || (f?.date || '') > (m?.date || '') ? f : m), null);
  const latestReading = latest ? Number(latest[readingField]) : null;
  const latestDate = latest && latest.date ? latest.date : null;
  const latestTeam = latest && latest.team_member ? latest.team_member : null;

  let state;
  if (!hasFuelLog) state = 'no_fuel_log';
  else if (!hasCurrent) state = 'no_current';
  else if (Math.abs(diff) < 0.5) state = 'matching';
  else if (diff > 0) state = 'ahead';
  else state = 'behind';

  const STATE = {
    matching: {bg: 'var(--ok-soft)', border: 'var(--border)', fg: 'var(--ok-ink)', label: 'In sync'},
    ahead: {
      bg: 'var(--warn-soft)',
      border: 'var(--border)',
      fg: 'var(--warn-ink)',
      label: 'Current is ahead of fuel log',
    },
    behind: {
      bg: 'var(--warn-soft)',
      border: 'var(--border)',
      fg: 'var(--warn-ink)',
      label: 'Current is behind fuel log',
    },
    no_fuel_log: {
      bg: 'var(--surface-2)',
      border: 'var(--border)',
      fg: 'var(--text-secondary)',
      label: 'No fuel log yet',
    },
    no_current: {
      bg: 'var(--surface-2)',
      border: 'var(--border)',
      fg: 'var(--text-secondary)',
      label: 'No current reading set',
    },
  };
  const palette = STATE[state];

  const explainer = (() => {
    if (state === 'matching') return 'Stored reading matches the highest fuel-log entry.';
    if (state === 'ahead')
      return (
        'Stored reading is ' +
        Math.abs(diff) +
        unitChar +
        ' higher than the highest fuel-log reading. This is normal if the operator entered a manual meter read between fuelings.'
      );
    if (state === 'behind')
      return (
        'Stored reading is ' +
        Math.abs(diff) +
        unitChar +
        ' lower than the highest fuel-log entry. Service-due math may use a stale baseline until current reading is synced.'
      );
    if (state === 'no_fuel_log')
      return 'No fueling history to compare against. Stored current reading is authoritative.';
    // no_current — there's fuel-log data but the equipment row has no
    // current reading yet. The Sync button populates it from history.
    return 'No current reading is stored on the equipment row. Sync from fuel log to populate from history.';
  })();

  async function syncFromFuelLog() {
    setNotice(null);
    if (!hasFuelLog) {
      setNotice({kind: 'warning', message: 'No fuel-log readings available to sync from.'});
      return;
    }
    if (state === 'matching') {
      setNotice({kind: 'success', message: 'Already in sync.'});
      return;
    }
    setBusy(true);
    const {error} = await sb
      .from('equipment')
      .update({[currentField]: fuelLogMax})
      .eq('id', eq.id);
    setBusy(false);
    if (error) {
      setNotice({kind: 'error', message: 'Sync failed: ' + error.message});
      return;
    }
    setNotice({
      kind: 'success',
      message: 'Synced. Current reading set to ' + fmtReading(fuelLogMax, unit) + ' (max of fuel-log history).',
    });
    // Quiet reload — refresh the parent equipment/fueling state without
    // flipping the loading spinner that would unmount this panel and
    // wipe out the success notice before the operator reads it.
    if (onReload) onReload({quiet: true});
  }

  const sectionTitle = {
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  };

  return (
    <div
      data-meter-status-panel="1"
      style={{background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 20px'}}
    >
      <div style={sectionTitle}>Meter Status</div>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <div
        data-meter-status-state={state}
        style={{
          background: palette.bg,
          border: '1px solid ' + palette.border,
          borderRadius: 10,
          padding: '10px 12px',
          marginBottom: 10,
        }}
      >
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6}}>
          <span style={{fontSize: 12, fontWeight: 700, color: palette.fg}}>{palette.label}</span>
          {/* Sync button appears whenever fuel-log data exists and the
              stored current reading is either missing or out of sync.
              Reachable in the no_current case so admin can populate a
              fresh current reading from history without typing a value. */}
          {hasFuelLog && state !== 'matching' && state !== 'no_fuel_log' && (
            <button
              type="button"
              onClick={syncFromFuelLog}
              disabled={busy}
              data-meter-sync-button="1"
              style={{
                padding: '5px 12px',
                borderRadius: 10,
                border: 'none',
                background: busy ? 'var(--border-strong)' : getProgramColor('equipment'),
                color: busy ? 'white' : getReadableText(getProgramColor('equipment')),
                fontSize: 11,
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
              }}
            >
              {busy ? 'Syncing…' : 'Sync current reading from fuel log'}
            </button>
          )}
        </div>
        <div style={{fontSize: 11, color: palette.fg, lineHeight: 1.4}}>{explainer}</div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 10,
          fontSize: 11,
        }}
      >
        <div>
          <div
            style={{
              color: 'var(--ink-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 700,
              fontSize: 10,
            }}
          >
            Stored current
          </div>
          <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)', marginTop: 2}}>
            {hasCurrent ? fmtReading(currentReading, unit) : '—'}
          </div>
        </div>
        <div>
          <div
            style={{
              color: 'var(--ink-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 700,
              fontSize: 10,
            }}
          >
            Fuel-log max
          </div>
          <div style={{fontSize: 14, fontWeight: 700, color: 'var(--ink)', marginTop: 2}}>
            {hasFuelLog ? fmtReading(fuelLogMax, unit) : '—'}
          </div>
        </div>
        <div>
          <div
            style={{
              color: 'var(--ink-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 700,
              fontSize: 10,
            }}
          >
            Difference
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: diff != null && diff !== 0 ? palette.fg : 'var(--ink)',
              marginTop: 2,
            }}
          >
            {diff == null ? '—' : (diff > 0 ? '+' : '') + diff + unitChar}
          </div>
        </div>
        <div>
          <div
            style={{
              color: 'var(--ink-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.4,
              fontWeight: 700,
              fontSize: 10,
            }}
          >
            Latest fueling
          </div>
          <div style={{fontSize: 12, color: 'var(--ink)', marginTop: 2}}>
            {latest ? (
              <>
                <strong>{Number.isFinite(latestReading) ? fmtReading(latestReading, unit) : '—'}</strong>
                {latestDate && (
                  <span style={{color: 'var(--ink-muted)', fontSize: 11}}>
                    {' · ' + (fmt ? fmt(latestDate) : latestDate)}
                  </span>
                )}
                {latestTeam && (
                  <div style={{color: 'var(--ink-muted)', fontSize: 11, marginTop: 2}}>by {latestTeam}</div>
                )}
              </>
            ) : (
              '—'
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
