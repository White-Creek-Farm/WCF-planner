// ============================================================================
// src/dashboard/LightHomePortal.jsx  -  Lane 1 CP1
// ----------------------------------------------------------------------------
// Home portal for authenticated Light-role users. Light users are field users
// contained to report/form surfaces; main.jsx enforces the route boundary. This
// component is only the usable front door and shares the regular home styling.
// ============================================================================
import React from 'react';
import {useNavigate} from 'react-router-dom';
import './homeRedesign.css';
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
import {ACTION_ICON_KEYS, PLANNER_ICON_KEYS} from '../lib/plannerIcons.js';
import {
  buildEquipmentAttention,
  buildMissedDailyReports,
  buildNext30Events,
  foldEquipmentFuelings,
} from './homeAlerts.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function Chevron({className}) {
  return (
    <svg
      className={className}
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function WrenchGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

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

  const tiles = [
    {
      label: 'Enter Daily Reports',
      desc: 'Broiler, layer, pig, cattle, sheep, eggs',
      view: 'webformhub',
      iconKey: ACTION_ICON_KEYS.dailyReports,
    },
    {
      label: 'Pasture Map',
      desc: 'View fields and animal locations',
      view: 'pastureMap',
      iconKey: PLANNER_ICON_KEYS.pastureMap,
    },
    {
      label: 'Add Feed',
      desc: 'Quick feed log',
      view: 'addfeed',
      iconKey: ACTION_ICON_KEYS.feed,
    },
    {
      label: 'Equipment',
      desc: 'Fueling and checklists',
      view: 'fuelingHub',
      iconKey: PLANNER_ICON_KEYS.tractor,
    },
    {
      label: 'Tasks',
      desc: 'Your tasks',
      view: 'tasks',
      iconKey: ACTION_ICON_KEYS.tasks,
    },
    {
      label: 'View Past Reports',
      desc: 'Daily report logs and equipment',
      view: 'mySubmissions',
      iconKey: ACTION_ICON_KEYS.pastReports,
    },
  ];

  function openEquipment(slug) {
    if (slug) navigate('/equipment/' + slug);
  }

  return (
    <div data-light-portal="1" className="home theme-crisp">
      {React.createElement(Header)}
      <main className="home-col" style={{maxWidth: 760}}>
        <section className="card" data-light-home-intro="1" style={{padding: '18px 20px'}}>
          <div style={{fontSize: 20, fontWeight: 780, color: 'var(--text)'}}>Field Portal</div>
          <div style={{fontSize: 13, color: 'var(--text-muted)', marginTop: 3}}>
            {name ? `Signed in as ${name}` : 'Signed in'} - choose what you need
          </div>
        </section>

        <section className="tiles" data-light-portal-grid="1">
          {tiles.map((t) => (
            <button
              key={t.view}
              type="button"
              data-light-portal-tile={t.view}
              className="tile"
              onClick={() => setView(t.view)}
            >
              <span className="coin">
                <PlannerIcon iconKey={t.iconKey} size={34} />
              </span>
              <span className="tile-text">
                <span className="tile-label">{t.label}</span>
                <span className="tile-sub">{t.desc}</span>
              </span>
              <Chevron className="tile-go" />
            </button>
          ))}
        </section>

        <div data-light-home-alerts="1" style={{display: 'flex', flexDirection: 'column', gap: 'var(--gap)'}}>
          {allMissed.length > 0 && (
            <section className="block" data-light-home-missed-dailys="1">
              <div className="block-head">
                <h2 className="section-label label-danger">Missed Daily Reports</h2>
                <span className="count-pill count-danger">{allMissed.length}</span>
              </div>
              <ul className="panel">
                {allMissed.map((m) => (
                  <li key={m.key} className="litem" data-light-home-missed-daily-row={m.key}>
                    <span className="coin coin-sm">
                      <PlannerIcon iconKey={m.iconKey} size={22} />
                    </span>
                    <div className="litem-body">
                      <div className="litem-title">{m.label}</div>
                      <div className="litem-meta">
                        {m.type} - No daily report for {fmt(m.date)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {equipmentAttention.length > 0 && (
            <section className="block" data-light-home-equipment-attention="1">
              <div className="block-head">
                <span className="head-ic">
                  <WrenchGlyph />
                </span>
                <h2 className="section-label">Equipment Attention</h2>
                <span className="count-pill count-danger">{equipmentAttention.length}</span>
              </div>
              <ul className="panel">
                {equipmentAttention.map((a) => {
                  const led = a.kind === 'overdue' ? 'led-danger' : 'led-warn';
                  const badge =
                    a.kind === 'overdue' ? 'badge-danger' : a.kind === 'warranty' ? 'badge-info' : 'badge-warn';
                  const badgeText =
                    a.pill || (a.kind === 'overdue' ? 'Overdue' : a.kind === 'warranty' ? 'Warranty' : 'Skipped');
                  const items = Array.isArray(a.items) ? a.items : [];
                  return (
                    <li
                      key={a.key}
                      className="litem eq is-link"
                      data-attention-kind={a.kind}
                      data-equipment-slug={a.slug}
                      role="button"
                      tabIndex={0}
                      onClick={() => openEquipment(a.slug)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openEquipment(a.slug);
                        }
                      }}
                    >
                      <span className={'eq-led ' + led} />
                      <div className="litem-body">
                        <div className="litem-title">{a.label}</div>
                        {items.length > 0 ? (
                          <div className="litem-types">
                            {items.map((it) => (
                              <div className="litem-type-row" key={it.key} data-attention-item-kind={it.kind}>
                                <span className={'type-chip type-' + it.type}>{it.typeLabel}</span>
                                <span className="litem-meta">{it.detail}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="litem-meta">{a.detail}</div>
                        )}
                      </div>
                      <span className={'badge-soft ' + badge}>{badgeText}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>

        {weekEvents.length > 0 && (
          <section className="block" data-light-home-next-30="1">
            <div className="block-head">
              <h2 className="section-label">Next 30 Days</h2>
              <span className="count-pill count-warn">{weekEvents.length}</span>
            </div>
            <ul className="panel">
              {weekEvents.map((e, i) => (
                <li key={`${e.type}-${e.date}-${e.label}-${i}`} className="litem" data-light-home-next-30-row={e.type}>
                  <span className="coin coin-sm">
                    <PlannerIcon iconKey={e.iconKey} size={18} />
                  </span>
                  <div className="litem-body">
                    <div className="litem-title">{e.label}</div>
                    <div className="litem-meta">{e.subline || fmt(e.date)}</div>
                  </div>
                  {e.reminder ? (
                    <span className="badge-soft badge-info">Reminder</span>
                  ) : (
                    <span className="dot" style={{background: e.color}} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
