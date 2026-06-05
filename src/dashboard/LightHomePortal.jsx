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
import {useNavigate} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
import {fmt} from '../lib/dateUtils.js';
import {useUI} from '../contexts/UIContext.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useCattleHome} from '../contexts/CattleHomeContext.jsx';
import {useSheepHome} from '../contexts/SheepHomeContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {
  buildEquipmentAttention,
  buildMissedDailyReports,
  buildNext30Events,
  foldEquipmentFuelings,
} from './homeAlerts.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

export default function LightHomePortal({Header}) {
  const {setView} = useUI();
  const {authState} = useAuth();
  const navigate = useNavigate();
  const {batches} = useBatches();
  const {breedingCycles, farrowingRecs, feederGroups, breeders} = usePig();
  const {layerGroups} = useLayer();
  const {broilerDailys, pigDailys, layerDailysRecent, cattleDailysRecent, sheepDailysRecent} = useDailysRecent();
  const {cattleForHome} = useCattleHome();
  const {sheepForHome} = useSheepHome();
  const {missedCleared} = useFeedCosts();
  const name = (authState && authState !== false && authState.name) || '';
  const [equipment, setEquipment] = React.useState([]);
  const [equipmentCompletions, setEquipmentCompletions] = React.useState({});
  const [equipmentFuelings, setEquipmentFuelings] = React.useState({});

  React.useEffect(() => {
    sb.from('equipment')
      .select(
        'id,slug,name,status,tracking_unit,current_hours,current_km,warranty_expiration,service_intervals,attachment_checklists,every_fillup_items',
      )
      .eq('status', 'active')
      .then(({data, error}) => {
        if (error || !data) return;
        setEquipment(data);
      });
    sb.from('equipment_fuelings')
      .select('equipment_id,date,team_member,hours_reading,km_reading,service_intervals_completed,every_fillup_check')
      .order('date', {ascending: false})
      .limit(5000)
      .then(({data, error}) => {
        if (error || !data) return;
        const folded = foldEquipmentFuelings(data);
        setEquipmentCompletions(folded.equipmentCompletions);
        setEquipmentFuelings(folded.equipmentFuelings);
      });
  }, []);

  const allMissed = buildMissedDailyReports({
    batches,
    broilerDailys,
    pigDailys,
    layerDailysRecent,
    cattleDailysRecent,
    sheepDailysRecent,
    feederGroups,
    breeders,
    layerGroups,
    cattleForHome,
    sheepForHome,
    missedCleared,
  });
  const equipmentAttention = buildEquipmentAttention({
    equipment,
    equipmentFuelings,
    equipmentCompletions,
    missedCleared,
  });
  const weekEvents = buildNext30Events({batches, breedingCycles, farrowingRecs, feederGroups});

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
        <div data-light-home-alerts="1" style={{display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 18}}>
          {allMissed.length > 0 && (
            <div data-light-home-missed-dailys="1">
              <div style={{fontSize: 13, fontWeight: 600, color: '#b91c1c', letterSpacing: 0.3, marginBottom: 8}}>
                ⚠ MISSED DAILY REPORTS
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                {allMissed.map((m) => (
                  <div
                    key={m.key}
                    data-light-home-missed-daily-row={m.key}
                    style={{
                      background: '#fef2f2',
                      border: '1px solid #fecaca',
                      borderRadius: 10,
                      padding: '10px 16px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <PlannerIcon iconKey={m.iconKey} size={22} />
                    <div style={{flex: 1}}>
                      <div style={{fontSize: 13, fontWeight: 600, color: '#b91c1c'}}>{m.label}</div>
                      <div style={{fontSize: 11, color: '#9ca3af'}}>
                        {m.type} · No daily report for {fmt(m.date)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {equipmentAttention.length > 0 && (
            <div data-light-home-equipment-attention="1">
              <div style={{fontSize: 13, fontWeight: 600, color: '#92400e', letterSpacing: 0.3, marginBottom: 8}}>
                🔧 EQUIPMENT ATTENTION
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
                {equipmentAttention.map((a) => {
                  const palette =
                    a.kind === 'overdue'
                      ? {bg: '#fef2f2', bd: '#fecaca', tx: '#b91c1c', icon: '🔧'}
                      : a.kind === 'fillup_streak'
                        ? {bg: '#fffbeb', bd: '#fde68a', tx: '#92400e', icon: '⛽'}
                        : {bg: '#fef3c7', bd: '#fcd34d', tx: '#92400e', icon: '🛡'};
                  return (
                    <button
                      type="button"
                      key={a.key}
                      data-attention-kind={a.kind}
                      data-equipment-slug={a.slug}
                      onClick={() => navigate('/equipment/' + a.slug)}
                      style={{
                        background: palette.bg,
                        border: '1px solid ' + palette.bd,
                        borderRadius: 10,
                        padding: '10px 16px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        textAlign: 'left',
                        width: '100%',
                      }}
                    >
                      <span style={{fontSize: 18}}>{palette.icon}</span>
                      <span style={{flex: 1}}>
                        <span style={{display: 'block', fontSize: 13, fontWeight: 600, color: palette.tx}}>
                          {a.label}
                        </span>
                        <span style={{display: 'block', fontSize: 11, color: '#9ca3af'}}>{a.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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

        {weekEvents.length > 0 && (
          <div data-light-home-next-30="1" style={{marginTop: 18}}>
            <div style={{fontSize: 13, fontWeight: 600, color: '#4b5563', marginBottom: 8, letterSpacing: 0.3}}>
              NEXT 30 DAYS
            </div>
            <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
              {weekEvents.map((e, i) => (
                <div
                  key={`${e.type}-${e.date}-${e.label}-${i}`}
                  data-light-home-next-30-row={e.type}
                  style={{
                    background: e.reminder ? '#eff6ff' : 'white',
                    border: e.reminder ? '1px solid #bfdbfe' : '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '10px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    boxShadow: '0 1px 3px rgba(0,0,0,.04)',
                  }}
                >
                  <PlannerIcon iconKey={e.iconKey} size={18} />
                  <div style={{flex: 1}}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: e.reminder ? 600 : 500,
                        color: e.reminder ? '#1e40af' : '#111827',
                      }}
                    >
                      {e.label}
                    </div>
                    <div style={{fontSize: 11, color: '#9ca3af'}}>{e.subline || fmt(e.date)}</div>
                  </div>
                  {e.reminder ? (
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        color: '#1d4ed8',
                        background: '#dbeafe',
                        padding: '2px 8px',
                        borderRadius: 10,
                      }}
                    >
                      REMINDER
                    </span>
                  ) : (
                    <div style={{width: 8, height: 8, borderRadius: 4, background: e.color, flexShrink: 0}} />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
