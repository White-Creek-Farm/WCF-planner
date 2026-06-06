// SheepNewWeighInModal — mirror of CattleNewWeighInModal for sheep.
// Lets the user pick date and flock (rams / ewes / feeders) before opening a
// new draft weigh-in session. The team member is locked to the signed-in user.
import React from 'react';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import {ANIMAL_ICON_KEYS} from '../lib/plannerIcons.js';
import {LockedTeamMemberField} from '../shared/recordPageControls.jsx';

const SheepNewWeighInModal = ({onClose, onCreate, authState}) => {
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
  const FLOCK_OPTS = [
    {v: 'rams', l: 'Rams'},
    {v: 'ewes', l: 'Ewes'},
    {v: 'feeders', l: 'Feeders'},
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
      setErr('Pick a flock.');
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
          <PlannerIcon iconKey={ANIMAL_ICON_KEYS.sheep} size={20} />
          <span>New Sheep Weigh-In</span>
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
          <label style={lblS}>Flock *</label>
          <select value={herd} onChange={(e) => setHerd(e.target.value)} style={inpS}>
            <option value="">Select flock...</option>
            {FLOCK_OPTS.map((h) => (
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
              background: busy || !team || !herd ? '#9ca3af' : '#0f766e',
              color: 'white',
              fontWeight: 700,
              fontSize: 12,
              cursor: busy || !team || !herd ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Creating…' : 'Create Session'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SheepNewWeighInModal;
