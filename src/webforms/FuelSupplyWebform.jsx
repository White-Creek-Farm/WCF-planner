// Public Fuel Supply Log webform. Canonical URL is /fueling/supply (tile on
// the FuelingHub). Legacy /fuel-supply alias is still wired in main.jsx +
// routes.js so any direct bookmarks keep working.
//
// Logged when there's no fueling checklist for what's being filled with
// fuel (portable cell fills, gas cans, farm-truck top-offs, etc). Writes to
// fuel_supplies — never counts as equipment consumption.
//
// Anonymous access (RLS policy on fuel_supplies allows anon insert). No
// auth required.
//
// Phase 1B canary: submission goes through useOfflineSubmit, which tries
// the network synchronously and queues to IndexedDB on failure. The form
// keeps its existing validation and post-submit reset
// behavior; what changes is the success path — synced rows show "✓ Supply
// logged" exactly like before; queued rows show "📡 Saved on this device —
// will sync when online" so the operator knows the row is captured but
// not yet replicated.

import React from 'react';

import {todayCentralISO} from '../lib/dateUtils.js';
import {useOfflineSubmit} from '../lib/useOfflineSubmit.js';
import StuckSubmissionsModal from './StuckSubmissionsModal.jsx';
import LockedSubmitter from './LockedSubmitter.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

// destination drives whether this row counts as CONSUMPTION in the admin
// reconciliation view. cell-refill rows are inventory movement (the cell
// is a storage tank — fuel going INTO it is delivery, not use), and are
// excluded. All other destinations count as consumption.
const DESTINATIONS = [
  {value: 'gas_can', label: 'Gas can(s)'},
  {value: 'farm_truck', label: 'Farm truck'},
  {value: 'other', label: 'Other equipment / use'},
  {value: 'cell', label: '⚠ Cell refill (inventory only — not consumption)'},
];

const FUEL_TYPES = [
  {value: 'diesel', label: 'Diesel'},
  {value: 'gasoline', label: 'Gasoline'},
  {value: 'def', label: 'DEF'},
];

export default function FuelSupplyWebform({onBack, sessionSubmitter}) {
  // Lane 1 CP1: on the authenticated path the submitter is the signed-in user,
  // locked. No roster dropdown, no localStorage convenience selection.
  const lockedName = sessionSubmitter?.name || '';
  const today = todayCentralISO();
  const [date, setDate] = React.useState(today);
  const [team, setTeam] = React.useState(lockedName);
  const [gallons, setGallons] = React.useState('');
  const [fuelType, setFuelType] = React.useState('diesel');
  const [destination, setDestination] = React.useState('cell');
  const [notes, setNotes] = React.useState('');
  const [err, setErr] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  // 'none' | 'synced' | 'queued'
  const [doneState, setDoneState] = React.useState('none');
  const [stuckOpen, setStuckOpen] = React.useState(false);

  const {submit, stuckRows, retryStuck, discardStuck} = useOfflineSubmit('fuel_supply');

  // Open the stuck modal automatically the first time we observe stuck rows
  // (mount or refresh after a failed pass). Operator can close it; we don't
  // re-open on every render.
  const initialStuckShownRef = React.useRef(false);
  React.useEffect(() => {
    if (stuckRows.length > 0 && !initialStuckShownRef.current) {
      initialStuckShownRef.current = true;
      setStuckOpen(true);
    }
  }, [stuckRows.length]);

  // Keep the submitter pinned to the signed-in identity. The form is always
  // login-required, so `team` is always the locked name.
  React.useEffect(() => {
    if (team !== lockedName) setTeam(lockedName);
  }, [team, lockedName]);

  async function handleSubmit() {
    setErr('');
    if (!team) {
      setErr('Pick a team member.');
      return;
    }
    if (!date) {
      setErr('Date required.');
      return;
    }
    const gal = parseFloat(gallons);
    if (!Number.isFinite(gal) || gal <= 0) {
      setErr('Gallons must be a positive number.');
      return;
    }
    setSubmitting(true);

    try {
      const result = await submit({
        date,
        gallons: gal,
        fuel_type: fuelType,
        destination,
        team_member: team,
        notes: notes.trim() || null,
      });
      setDoneState(result.state);
      setGallons('');
      setNotes('');
    } catch (e) {
      // Schema/validation bug — surface it instead of silently queuing.
      setErr('Save failed: ' + (e && e.message ? e.message : String(e)));
    } finally {
      setSubmitting(false);
    }
  }

  const cardS = {
    background: 'white',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 18px',
    marginBottom: 14,
  };
  const lblS = {
    display: 'block',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--ink-muted)',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  };
  const inpS = {
    fontSize: 14,
    padding: '8px 10px',
    border: '1px solid var(--border-strong)',
    borderRadius: 10,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <div style={{minHeight: '100vh', background: 'var(--bg-page)'}}>
      <div
        style={{
          background: '#085041',
          color: 'white',
          padding: '14px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div style={{fontSize: 18, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8}}>
          <PlannerIcon iconKey="fueling" size={20} />
          <span>Fuel Supply Log</span>
        </div>
        <div style={{fontSize: 11, opacity: 0.85}}>WCF Planner</div>
        {stuckRows.length > 0 && (
          <button
            onClick={() => setStuckOpen(true)}
            data-stuck-button="1"
            style={{
              marginLeft: 'auto',
              background: '#b45309',
              color: 'white',
              border: 'none',
              borderRadius: 10,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
              fontWeight: 600,
            }}
          >
            ⚠ {stuckRows.length} stuck
          </button>
        )}
        {onBack && (
          <button
            onClick={onBack}
            style={{
              marginLeft: stuckRows.length > 0 ? 8 : 'auto',
              background: 'transparent',
              color: 'white',
              border: '1px solid rgba(255,255,255,.4)',
              borderRadius: 10,
              padding: '4px 10px',
              cursor: 'pointer',
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            ← Back
          </button>
        )}
      </div>

      <div style={{maxWidth: 560, margin: '0 auto', padding: '16px'}}>
        {/* WI-5: genuine warn-notice panel — standardized warn ink on warn-soft, neutral border. */}
        <div style={{...cardS, background: 'var(--warn-soft)', borderColor: 'var(--border)'}}>
          <div style={{fontSize: 12, fontWeight: 700, color: 'var(--warn-ink)', marginBottom: 6}}>
            ⚠ When to use this form
          </div>
          <div style={{fontSize: 12, color: '#78716c', lineHeight: 1.5}}>
            Use this form when there is <strong>no fueling checklist</strong> for what is being filled with fuel — e.g.
            gas can fills, farm truck top-offs, generators, chainsaws.
            <br />
            <br />
            <strong>Cell refills</strong> (fuel pumped INTO the portable cell from a supplier delivery) are inventory
            storage, not consumption. Use the cell-refill destination only if there is no bill on file covering the same
            delivery.
          </div>
        </div>

        {doneState === 'synced' && (
          <div data-submit-state="synced" style={{...cardS, background: '#ecfdf5', borderColor: '#a7f3d0'}}>
            <div style={{fontSize: 13, fontWeight: 700, color: '#065f46', marginBottom: 4}}>✓ Supply logged</div>
            <div style={{fontSize: 12, color: '#047857'}}>
              Form reset for another entry. You can keep logging deliveries.
            </div>
          </div>
        )}

        {doneState === 'queued' && (
          <div data-submit-state="queued" style={{...cardS, background: '#fef3c7', borderColor: '#fde68a'}}>
            <div style={{fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 4}}>
              📡 Saved on this device
            </div>
            <div style={{fontSize: 12, color: '#78716c'}}>
              No connection right now. Your entry is queued and will sync as soon as the device is back online. Keep
              logging — additional entries will queue too.
            </div>
          </div>
        )}

        <div style={cardS}>
          <div style={{marginBottom: 12}}>
            <label style={lblS}>Date *</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inpS} />
          </div>

          <div style={{marginBottom: 12}}>
            <LockedSubmitter name={lockedName} label="Team member" labelStyle={lblS} />
          </div>

          <div style={{marginBottom: 12}}>
            <label style={lblS}>Destination *</label>
            <select value={destination} onChange={(e) => setDestination(e.target.value)} style={inpS}>
              {DESTINATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{marginBottom: 12}}>
            <label style={lblS}>Fuel type *</label>
            <select value={fuelType} onChange={(e) => setFuelType(e.target.value)} style={inpS}>
              {FUEL_TYPES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{marginBottom: 12}}>
            <label style={lblS}>Gallons *</label>
            <input
              type="number"
              min="0"
              step="0.1"
              value={gallons}
              onChange={(e) => setGallons(e.target.value)}
              placeholder="e.g. 300"
              style={inpS}
            />
          </div>

          <div style={{marginBottom: 12}}>
            <label style={lblS}>
              Notes <span style={{color: 'var(--ink-faint)', textTransform: 'none', fontWeight: 400}}>(optional)</span>
            </label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth noting"
              style={{...inpS, resize: 'vertical'}}
            />
          </div>

          {err && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                color: '#b91c1c',
                padding: '8px 12px',
                borderRadius: 10,
                fontSize: 12,
                marginBottom: 12,
              }}
            >
              {err}
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={submitting}
            data-submit-button="1"
            style={{
              width: '100%',
              padding: '14px 16px',
              borderRadius: 10,
              border: 'none',
              background: submitting ? '#9ca3af' : '#085041',
              color: 'white',
              fontSize: 15,
              fontWeight: 700,
              cursor: submitting ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {submitting ? 'Saving…' : 'Log supply'}
          </button>
        </div>
      </div>

      {stuckOpen && (
        <StuckSubmissionsModal
          rows={stuckRows}
          formLabel="fuel supply log"
          describeRow={(row) => {
            const p = row.payload || {};
            const dateStr = p.date || '?';
            const galStr = p.gallons != null ? `${p.gallons} gal` : '?';
            const destStr = p.destination || '?';
            return `${dateStr} · ${galStr} · ${destStr}`;
          }}
          onRetry={async (csid) => {
            await retryStuck(csid);
          }}
          onDiscard={async (csid) => {
            await discardStuck(csid);
          }}
          onClose={() => setStuckOpen(false)}
        />
      )}
    </div>
  );
}
