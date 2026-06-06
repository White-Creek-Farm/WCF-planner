// ============================================================================
// CattleNewWeighInModal — Phase 2.1.4
// ============================================================================
// Cattle weigh-in flow "new session" modal. The team member is locked to the
// signed-in user; no roster-backed submitter selection remains.
// ============================================================================
import React from 'react';
import {renderCattleIconLabel} from '../components/CattleIcon.jsx';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';
const CattleNewWeighInModal = ({onClose, onCreate, authState}) => {
  const {useState, useEffect} = React;
  const lockedTeamName =
    authState && typeof authState === 'object'
      ? authState.name || authState.profile?.name || authState.profile?.full_name || authState.user?.email || ''
      : '';
  const todayStr = () => {
    const d = new Date();
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  const [team, setTeam] = useState(lockedTeamName);
  const [date, setDate] = useState(todayStr());
  const [herd, setHerd] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const HERD_OPTS = [
    {v: 'mommas', l: 'Mommas'},
    {v: 'backgrounders', l: 'Backgrounders'},
    {v: 'finishers', l: 'Finishers'},
    {v: 'bulls', l: 'Bulls'},
  ];
  useEffect(() => {
    setTeam(lockedTeamName);
  }, [lockedTeamName]);
  async function create() {
    if (!team) {
      setErr('Pick a team member.');
      return;
    }
    if (!herd) {
      setErr('Pick a herd.');
      return;
    }
    setErr('');
    setBusy(true);
    await onCreate({date, team_member: team, herd});
    setBusy(false);
  }
  const inpS = {
    fontFamily: 'inherit',
    fontSize: 13,
    padding: '8px 10px',
    border: '1px solid #d1d5db',
    borderRadius: 6,
    width: '100%',
    boxSizing: 'border-box',
    background: 'white',
  };
  const lblS = {display: 'block', fontSize: 12, color: '#374151', marginBottom: 4, fontWeight: 600};
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
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
        <div style={{fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 14}}>
          {renderCattleIconLabel('New Cattle Weigh-In', {size: 20})}
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
        <div style={{marginBottom: 14}}>
          <label style={lblS}>Herd *</label>
          <select value={herd} onChange={(e) => setHerd(e.target.value)} style={inpS}>
            <option value="">Select herd...</option>
            {HERD_OPTS.map((h) => (
              <option key={h.v} value={h.v}>
                {h.l}
              </option>
            ))}
          </select>
        </div>
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
            disabled={busy || !team || !herd}
            style={{
              padding: '8px 16px',
              borderRadius: 7,
              border: 'none',
              background: busy || !team || !herd ? '#9ca3af' : '#1e40af',
              color: 'white',
              fontWeight: 700,
              fontSize: 12,
              cursor: busy || !team || !herd ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Creating\u2026' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CattleNewWeighInModal;
