// ============================================================================
// AdminNewWeighInModal — Phase 2.1.4
// ============================================================================
// Verbatim byte-for-byte extraction from main.jsx. Admin-side modal that
// starts a new weigh-in session for a given species. Self-contained — uses
// `sb` via props.
// ============================================================================
import React from 'react';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
import {todayCentralISO} from '../lib/dateUtils.js';
import {LockedTeamMemberField} from './recordPageControls.jsx';
const AdminNewWeighInModal = ({sb, species, authState, onClose, onCreated}) => {
  const {useState, useEffect} = React;
  const lockedTeamName =
    authState && typeof authState === 'object'
      ? authState.name || authState.profile?.name || authState.profile?.full_name || authState.user?.email || ''
      : '';
  const [team, setTeam] = useState(lockedTeamName);
  const [date, setDate] = useState(todayCentralISO());
  const [batchOpts, setBatchOpts] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [week, setWeek] = useState(4);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setTeam(lockedTeamName);
  }, [lockedTeamName]);

  useEffect(() => {
    if (species === 'broiler') {
      sb.from('webform_config')
        .select('data')
        .eq('key', 'broiler_groups')
        .maybeSingle()
        .then(({data}) => {
          if (data && Array.isArray(data.data)) setBatchOpts(data.data);
        });
    } else if (species === 'pig') {
      sb.from('webform_config')
        .select('data')
        .eq('key', 'active_groups')
        .maybeSingle()
        .then(({data}) => {
          if (data && Array.isArray(data.data)) {
            setBatchOpts(data.data.filter((n) => n && n.toUpperCase() !== 'SOWS' && n.toUpperCase() !== 'BOARS'));
          }
        });
    }
  }, []);

  async function create() {
    if (!team) {
      setErr('Pick a team member.');
      return;
    }
    if (!batchId) {
      setErr('Pick a batch.');
      return;
    }
    setErr('');
    setBusy(true);
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    const rec = {
      id,
      date,
      team_member: team,
      species,
      status: 'draft',
      batch_id: batchId,
    };
    if (species === 'broiler') rec.broiler_week = week;
    const {error} = await sb.from('weigh_in_sessions').insert(rec);
    setBusy(false);
    if (error) {
      setErr('Could not create: ' + error.message);
      return;
    }
    onCreated && onCreated(rec);
    onClose && onClose();
  }

  const lblS = {display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600};
  const inpS = {
    fontFamily: 'inherit',
    fontSize: 13,
    padding: '8px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    width: '100%',
    boxSizing: 'border-box',
    background: 'white',
    color: '#111827',
    outline: 'none',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 420,
          width: '100%',
          padding: '18px 20px',
          boxShadow: '0 12px 40px rgba(0,0,0,.25)',
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 700,
            color: '#111827',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <PlannerIcon iconKey={species === 'broiler' ? ANIMAL_ICON_KEYS.broiler : ANIMAL_ICON_KEYS.pig} size={20} />
          <span>New {species === 'broiler' ? 'Broiler' : 'Pig'} Weigh-In</span>
        </div>
        <div style={{marginBottom: 10}}>
          {React.createElement(LockedTeamMemberField, {
            value: team,
            label: 'Team member *',
            labelStyle: lblS,
            style: inpS,
          })}
        </div>
        <div style={{marginBottom: 10}}>
          <label style={lblS}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inpS} />
        </div>
        <div style={{marginBottom: 10}}>
          <label style={lblS}>{species === 'broiler' ? 'Broiler batch *' : 'Pig batch *'}</label>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} style={inpS}>
            <option value="">Select batch...</option>
            {batchOpts.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        {species === 'broiler' && (
          <div style={{marginBottom: 14}}>
            <label style={lblS}>Week *</label>
            <div style={{display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #d1d5db'}}>
              {[4, 6].map((w) => (
                <button
                  key={w}
                  type="button"
                  onClick={() => setWeek(w)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    border: 'none',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: week === w ? '#1e40af' : 'white',
                    color: week === w ? 'white' : '#6b7280',
                  }}
                >
                  {'Week ' + w}
                </button>
              ))}
            </div>
          </div>
        )}
        {err && (
          <div
            style={{
              color: '#b91c1c',
              fontSize: 12,
              marginBottom: 10,
              padding: '6px 10px',
              background: '#fef2f2',
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}
        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontWeight: 600,
              fontSize: 12,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={busy || !team || !batchId}
            style={{
              padding: '8px 16px',
              borderRadius: 7,
              border: 'none',
              background: busy || !team || !batchId ? '#9ca3af' : '#1e40af',
              color: 'white',
              fontWeight: 700,
              fontSize: 12,
              cursor: busy || !team || !batchId ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Creating\u2026' : 'Create Weigh-In'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Admin weigh-ins view for broilers + pigs. Mirrors CattleWeighInsView but
// drops cattle-specific bits (herd, new-tag reconciliation) and adds:
//   • schooner grouping for broilers (reads schooner name from weigh_ins.tag)
//   • in-place grid editing with edit lock on complete sessions

export default AdminNewWeighInModal;
