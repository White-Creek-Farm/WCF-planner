// ============================================================================
// src/dashboard/MySubmissions.jsx
// ----------------------------------------------------------------------------
// Kept at the legacy /my-submissions route, but the Light-user product surface
// is now a review hub: enter daily reports, or jump to the past-report logs.
// Edit/delete permissions live on the daily record pages themselves.
// ============================================================================
import React from 'react';
import {useUI} from '../contexts/UIContext.jsx';
import {ANIMAL_ICON_KEYS, PLANNER_ICON_KEYS} from '../lib/plannerIcons.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';
import './homeRedesign.css';

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

const DAILY_LOGS = [
  {
    label: 'Broiler Daily Reports',
    desc: 'Broiler logs',
    view: 'broilerdailys',
    iconKey: ANIMAL_ICON_KEYS.broiler,
  },
  {
    label: 'Layer Daily Reports',
    desc: 'Layer logs',
    view: 'layerdailys',
    iconKey: ANIMAL_ICON_KEYS.layer,
  },
  {
    label: 'Egg Reports',
    desc: 'Egg count logs',
    view: 'eggdailys',
    iconKey: ANIMAL_ICON_KEYS.egg,
  },
  {
    label: 'Pig Daily Reports',
    desc: 'Pig logs',
    view: 'pigdailys',
    iconKey: ANIMAL_ICON_KEYS.pig,
  },
  {
    label: 'Cattle Daily Reports',
    desc: 'Cattle logs',
    view: 'cattledailys',
    iconKey: ANIMAL_ICON_KEYS.cattle,
  },
  {
    label: 'Sheep Daily Reports',
    desc: 'Sheep logs',
    view: 'sheepdailys',
    iconKey: ANIMAL_ICON_KEYS.sheep,
  },
  {
    label: 'Equipment',
    desc: 'Equipment forms',
    view: 'fuelingHub',
    iconKey: PLANNER_ICON_KEYS.tractor,
  },
];

const enterTile = {
  label: 'Enter Daily Reports',
  desc: 'Broiler, layer, pig, cattle, sheep, eggs',
  view: 'webformhub',
  iconKey: PLANNER_ICON_KEYS.checkmark,
};

export default function MySubmissions({Header}) {
  const {setView} = useUI();

  function go(view) {
    setView(view);
  }

  return (
    <div data-view-past-reports="1" className="home theme-crisp">
      {React.createElement(Header)}
      <main className="home-col" style={{maxWidth: 760}}>
        <section className="card" data-view-past-reports-intro="1" style={{padding: '18px 20px'}}>
          <div style={{fontSize: 20, fontWeight: 780, color: 'var(--text)'}}>View Past Reports</div>
          <div style={{fontSize: 13, color: 'var(--text-muted)', marginTop: 3}}>Daily report logs and equipment</div>
        </section>

        <section className="block" data-enter-daily-reports-section="1">
          <div className="block-head">
            <h2 className="section-label">Enter Daily Reports</h2>
          </div>
          <button
            type="button"
            data-review-hub-enter-dailys="1"
            className="tile"
            onClick={() => go(enterTile.view)}
            style={{minHeight: 76}}
          >
            <span className="coin">
              <PlannerIcon iconKey={enterTile.iconKey} size={34} />
            </span>
            <span className="tile-text">
              <span className="tile-label">{enterTile.label}</span>
              <span className="tile-sub">{enterTile.desc}</span>
            </span>
            <Chevron className="tile-go" />
          </button>
        </section>

        <section className="block" data-view-past-reports-section="1">
          <div className="block-head">
            <h2 className="section-label">View Past Reports</h2>
          </div>
          <div className="tiles" data-view-past-reports-grid="1">
            {DAILY_LOGS.map((item) => (
              <button
                key={item.view}
                type="button"
                data-view-past-reports-link={item.view}
                className="tile"
                onClick={() => go(item.view)}
              >
                <span className="coin">
                  <PlannerIcon iconKey={item.iconKey} size={34} />
                </span>
                <span className="tile-text">
                  <span className="tile-label">{item.label}</span>
                  <span className="tile-sub">{item.desc}</span>
                </span>
                <Chevron className="tile-go" />
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
