// ============================================================================
// src/dashboard/LightHomePortal.jsx  —  Lane 1 CP1
// ----------------------------------------------------------------------------
// Home portal for authenticated Light-role users. Light users are field users
// contained to the report/forms surfaces: this is their landing page instead
// of the full HomeDashboard. Compact shortcut tiles cover the four allowed
// areas — Daily Reports, Add Feed, Equipment, Tasks — each a large tap target.
//
// Containment is enforced in main.jsx (canLightAccessView allowlist + the
// fail-closed render guard). This component is the usable front door, not the
// boundary. It reuses the normal authenticated Header/shell.
// ============================================================================
import React from 'react';
import {useUI} from '../contexts/UIContext.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

export default function LightHomePortal({Header}) {
  const {setView} = useUI();
  const {authState} = useAuth();
  const name = (authState && authState !== false && authState.name) || '';

  // Each shortcut maps to one allowed view. setView mirrors how HomeDashboard's
  // program cards navigate (and keeps the URL/manifest in sync via the App URL
  // adapter). These four views are all on the Light allowlist in main.jsx.
  const tiles = [
    {
      label: 'Daily Reports',
      desc: 'Broiler · layer · pig · cattle · sheep · eggs',
      view: 'webformhub',
      icon: <span style={{fontSize: 34}}>📝</span>,
      color: '#085041',
      bg: '#ecfdf5',
      bd: '#a7f3d0',
    },
    {
      label: 'Add Feed',
      desc: 'Quick feed log',
      view: 'addfeed',
      icon: <span style={{fontSize: 34}}>🌾</span>,
      color: '#92400e',
      bg: '#fffbeb',
      bd: '#fde68a',
    },
    {
      label: 'Equipment',
      desc: 'Fueling & checklists',
      view: 'fuelingHub',
      icon: <PlannerIcon iconKey="tractor" text="🚜" size={34} />,
      color: '#57534e',
      bg: '#fafaf9',
      bd: '#e7e5e4',
    },
    {
      label: 'Tasks',
      desc: 'Your tasks',
      view: 'tasks',
      icon: <span style={{fontSize: 34}}>✅</span>,
      color: '#1e40af',
      bg: '#eff6ff',
      bd: '#bfdbfe',
    },
    {
      label: 'My Submissions',
      desc: 'Edit your fuelings & supplies',
      view: 'mySubmissions',
      icon: <span style={{fontSize: 34}}>📋</span>,
      color: '#7c3aed',
      bg: '#f5f3ff',
      bd: '#ddd6fe',
    },
  ];

  return (
    <div data-light-portal="1" style={{minHeight: '100vh', background: '#f1f3f2'}}>
      <Header />
      <div style={{padding: '1.25rem', maxWidth: 720, margin: '0 auto'}}>
        <div style={{marginBottom: 18}}>
          <div style={{fontSize: 20, fontWeight: 800, color: '#111827'}}>Field Portal</div>
          <div style={{fontSize: 13, color: '#6b7280', marginTop: 2}}>
            {name ? `Signed in as ${name}` : 'Signed in'} · choose a form to fill out
          </div>
        </div>
        <div data-light-portal-grid="1" style={{display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12}}>
          {tiles.map((t) => (
            <button
              key={t.view}
              data-light-portal-tile={t.view}
              onClick={() => setView(t.view)}
              style={{
                background: t.bg,
                border: '1px solid ' + t.bd,
                borderRadius: 14,
                padding: '20px 16px',
                cursor: 'pointer',
                boxShadow: '0 1px 3px rgba(0,0,0,.06)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 10,
                minHeight: 120,
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <div style={{lineHeight: 1}}>{t.icon}</div>
              <div>
                <div style={{fontSize: 17, fontWeight: 700, color: t.color}}>{t.label}</div>
                <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>{t.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
