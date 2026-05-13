// ============================================================================
// src/shared/Header.jsx  —  Phase 2 Round 6 tail
// ----------------------------------------------------------------------------
// The top nav bar + program sub-nav. Reads view/menu state from UIContext,
// auth/save-status from AuthContext, form open-state booleans from
// BatchesContext + PigContext. A handful of App-only things come as props:
// two App helpers (signOut, loadUsers) and the built-up DeleteConfirmModal
// React element (depends on App's deleteConfirm state).
//
// App() wraps this in a local `Header` factory closure so every extracted
// view can keep receiving `Header` as a zero-arg prop — no ripple changes
// across the ~50 call sites.
// ============================================================================
import React from 'react';
import {S} from '../lib/styles.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {countMyOpenDueOrPastTasks} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT} from '../lib/tasksCenterMutationsApi.js';
import {todayCentralISO} from '../lib/dateUtils.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import PlannerIcon from '../components/PlannerIcon.jsx';

export default function Header({sb, signOut, loadUsers, DeleteConfirmModal, ConfirmActionModal}) {
  const {authState, saveStatus, setShowUsers} = useAuth();
  const {view, setView, showMenu, setShowMenu} = useUI();
  const {showForm, setShowForm} = useBatches();
  const {showBreedForm, setShowBreedForm, showFarrowForm, setShowFarrowForm} = usePig();
  // Tasks v2 T3: own due/past-due count for the Header badge. Soft-fails
  // to 0 on any error so a transient DB hiccup never crashes Header.
  // Re-runs on auth user change, view change, and TASK_CHANGE_EVENT so
  // the badge catches up immediately after a completion or any other
  // /tasks mutation. A lightweight window-focus listener also nudges a
  // refresh when the user tabs back in.
  const callerProfileId = authState && authState.user ? authState.user.id : null;
  const [myDueCount, setMyDueCount] = React.useState(0);
  React.useEffect(() => {
    if (!sb || !callerProfileId) {
      setMyDueCount(0);
      return undefined;
    }
    let cancelled = false;
    async function refresh() {
      try {
        const n = await countMyOpenDueOrPastTasks(sb, callerProfileId, todayCentralISO());
        if (!cancelled) setMyDueCount(n || 0);
      } catch (e) {
        if (!cancelled) setMyDueCount(0);
        // Soft-fail: log for diagnostics but never throw out of Header.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('Header tasks badge: count failed', e && e.message ? e.message : e);
        }
      }
    }
    refresh();
    function onFocus() {
      refresh();
    }
    function onTaskChange() {
      refresh();
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('focus', onFocus);
      window.addEventListener(TASK_CHANGE_EVENT, onTaskChange);
    }
    return () => {
      cancelled = true;
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener(TASK_CHANGE_EVENT, onTaskChange);
      }
    };
  }, [sb, callerProfileId, view]);
  const poultryViews = ['broilerHome', 'timeline', 'list', 'feed', 'broilerdailys', 'broilerweighins'];
  const pigViews = ['pigsHome', 'breeding', 'farrowing', 'sows', 'pigbatches', 'pigs', 'pigdailys', 'pigweighins'];
  const cattleViews = [
    'cattleHome',
    'cattleherds',
    'cattledailys',
    'cattleweighins',
    'cattlebreeding',
    'cattleforecast',
    'cattlebatches',
  ];
  const sheepViews = ['sheepHome', 'sheepflocks', 'sheepdailys', 'sheepweighins', 'sheepbatches'];
  const inPoultry = poultryViews.includes(view) || showForm;
  const inPigs = pigViews.includes(view) || showBreedForm || showFarrowForm;
  const inLayers = ['layersHome', 'layerbatches', 'layerdailys', 'eggdailys'].includes(view);
  const inCattle = cattleViews.includes(view);
  const inSheep = sheepViews.includes(view);
  const inEquipment = view === 'equipmentHome';
  const inSection = inPoultry || inPigs || inLayers || inCattle || inSheep || inEquipment;
  const nb = (active) => ({
    padding: '7px 16px',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    whiteSpace: 'nowrap',
    border: active ? '2px solid #085041' : '1px solid #d1d5db',
    background: active ? '#085041' : 'white',
    color: active ? 'white' : '#374151',
  });
  const ghostBtn = {
    padding: '7px 12px',
    borderRadius: 8,
    border: '1px solid #d1d5db',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    background: 'white',
    color: '#6b7280',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  };
  return (
    <div className="no-print">
      {DeleteConfirmModal}
      {ConfirmActionModal}
      {/* ── Dark top bar ── */}
      <div data-header-bar="1" style={S.header}>
        <button
          onClick={() => {
            setShowForm(false);
            setShowBreedForm(false);
            setShowFarrowForm(false);
            setView('home');
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{fontSize: 17, fontWeight: 700, letterSpacing: '-.4px', color: 'white'}}>WCF Planner</div>
          {inPoultry && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              BROILERS
            </span>
          )}
          {['webforms'].includes(view) && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              ADMIN
            </span>
          )}
          {inPigs && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              PIGS
            </span>
          )}
          {inLayers && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              LAYERS
            </span>
          )}
          {inCattle && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              CATTLE
            </span>
          )}
          {inSheep && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              SHEEP
            </span>
          )}
          {inEquipment && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: 'rgba(255,255,255,.6)',
                borderLeft: '1px solid rgba(255,255,255,.25)',
                paddingLeft: 10,
                letterSpacing: 0.5,
              }}
            >
              EQUIPMENT
            </span>
          )}
        </button>
        {/* Webforms group: Dailys + Equipment public webform hubs sit
            inside a labeled wrapper so operators read them as one
            group. Tasks button sits OUTSIDE this group with a divider
            so it doesn't read as another webform link. */}
        <div data-header-webforms-group="1" style={{display: 'flex', gap: 6, alignItems: 'center', marginLeft: 16}}>
          <span
            data-header-webforms-label="1"
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,.55)',
              paddingRight: 4,
            }}
          >
            Webforms
          </span>
          <button
            onClick={() => {
              setShowForm(false);
              setShowBreedForm(false);
              setShowFarrowForm(false);
              setView('webformhub');
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,.3)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              background: view === 'webformhub' ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.1)',
              color: 'white',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            📝 Dailys
          </button>
          <button
            data-header-webforms-equipment="1"
            onClick={() => {
              setShowForm(false);
              setShowBreedForm(false);
              setShowFarrowForm(false);
              setView('fuelingHub');
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,.3)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              background: view === 'fuelingHub' ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.1)',
              color: 'white',
              fontFamily: 'inherit',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <PlannerIcon iconKey="tractor" size={16} />
            Equipment
          </button>
        </div>
        {/* Visual divider: separates the Webforms group from the Tasks
            destination so the Tasks button reads as its own
            navigation, not another webform link. */}
        {authState?.user && (
          <div data-header-tasks-divider="1" style={{display: 'flex', alignItems: 'center', marginLeft: 8}}>
            <div
              style={{
                width: 1,
                height: 20,
                background: 'rgba(255,255,255,.25)',
                marginRight: 10,
              }}
            />
            <button
              data-tasks-header-link="1"
              onClick={() => {
                setShowForm(false);
                setShowBreedForm(false);
                setShowFarrowForm(false);
                setView('tasks');
              }}
              style={{
                padding: '5px 12px',
                borderRadius: 7,
                border: '1px solid rgba(255,255,255,.3)',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 500,
                background: view === 'tasks' ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.1)',
                color: 'white',
                fontFamily: 'inherit',
                whiteSpace: 'nowrap',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <PlannerIcon iconKey="checkmark" size={16} />
              Tasks
              {myDueCount > 0 && (
                <span
                  data-tasks-header-badge={myDueCount}
                  aria-label={`${myDueCount} tasks due or overdue`}
                  style={{
                    display: 'inline-block',
                    padding: '0 6px',
                    minWidth: 16,
                    height: 16,
                    lineHeight: '16px',
                    fontSize: 10,
                    fontWeight: 700,
                    borderRadius: 999,
                    background: '#dc2626',
                    color: 'white',
                    textAlign: 'center',
                  }}
                >
                  {myDueCount}
                </span>
              )}
            </button>
          </div>
        )}
        <div
          data-header-userinfo="1"
          style={{fontSize: 11, display: 'flex', alignItems: 'center', gap: 5, opacity: 0.75, marginLeft: 'auto'}}
        >
          {saveStatus === 'saving' && <span style={{color: '#a7f3d0', fontWeight: 500}}>Saving…</span>}
          {saveStatus === 'saved' && <span style={{color: '#a7f3d0', fontWeight: 500}}>✓ Saved</span>}
          {saveStatus === 'error' && (
            <span style={{color: '#fca5a5', fontWeight: 500}}>⚠ Save failed — check connection</span>
          )}
          {!saveStatus && authState?.name && (
            <span data-header-username="1">
              {authState.name} · <span style={{textTransform: 'capitalize'}}>{authState?.role}</span>
            </span>
          )}
        </div>
        <div style={{display: 'flex', gap: 6, alignItems: 'center', position: 'relative'}}>
          {authState?.user && (
            <div style={{position: 'relative'}}>
              <button
                onClick={() => setShowMenu((m) => !m)}
                style={{
                  padding: '5px 10px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,.3)',
                  cursor: 'pointer',
                  fontSize: 15,
                  background: 'rgba(255,255,255,.1)',
                  color: 'white',
                  lineHeight: 1,
                }}
              >
                ☰
              </button>
              {showMenu && (
                <div
                  onClick={() => setShowMenu(false)}
                  style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 199}}
                />
              )}
              {showMenu && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '110%',
                    background: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,.15)',
                    zIndex: 200,
                    minWidth: 160,
                    overflow: 'hidden',
                  }}
                >
                  {/* T11 retired the legacy My Tasks / Tasks Center
                      burger entries — the dark-bar ✅ Tasks button is
                      the single canonical destination. The Users entry
                      stays for admin user management. */}
                  {authState?.role === 'admin' && (
                    <button
                      onClick={() => {
                        setShowUsers(true);
                        loadUsers();
                        setShowMenu(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 16px',
                        border: 'none',
                        background: 'none',
                        cursor: 'pointer',
                        fontSize: 13,
                        textAlign: 'left',
                        color: '#111827',
                        fontFamily: 'inherit',
                      }}
                    >
                      👥 Users
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <button
            onClick={signOut}
            style={{
              padding: '5px 12px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,.3)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
              background: 'rgba(255,255,255,.1)',
              color: 'white',
            }}
          >
            Sign Out
          </button>
        </div>
      </div>
      {/* ── Light sub-nav bar — only in section views ── */}
      {inSection && (
        <div
          data-header-subnav="1"
          style={{
            background: 'white',
            borderBottom: '1px solid #e5e7eb',
            padding: '8px 1.25rem',
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => {
              setShowForm(false);
              setShowBreedForm(false);
              setShowFarrowForm(false);
              setView('home');
            }}
            style={ghostBtn}
          >
            ⌂ Home
          </button>
          <div style={{width: 1, height: 20, background: '#e5e7eb', margin: '0 4px'}} />
          {inPoultry &&
            [
              ['broilerHome', 'Dashboard'],
              ['timeline', 'Timeline'],
              ['list', 'Batches'],
              ['broilerdailys', 'Dailys'],
              ['broilerweighins', 'Weigh-Ins'],
              ['feed', 'Poultry Feed'],
            ].map(([v, l]) => (
              <button
                key={v}
                style={nb(view === v && !showForm)}
                onClick={() => {
                  setShowForm(false);
                  setView(v);
                }}
              >
                {l}
              </button>
            ))}
          {inPigs &&
            [
              ['pigsHome', 'Dashboard'],
              ['breeding', 'Timeline'],
              ['farrowing', 'Farrowing'],
              ['sows', 'Breeding Pigs'],
              ['pigbatches', 'Batches'],
              ['pigdailys', 'Dailys'],
              ['pigweighins', 'Weigh-Ins'],
              ['pigs', 'Feed'],
            ].map(([v, l]) => (
              <button
                key={v}
                style={nb(view === v && !showForm && !showBreedForm && !showFarrowForm)}
                onClick={() => {
                  setShowForm(false);
                  setShowBreedForm(false);
                  setShowFarrowForm(false);
                  setView(v);
                }}
              >
                {l}
              </button>
            ))}
          {inLayers &&
            [
              ['layersHome', 'Dashboard'],
              ['layerbatches', 'Layer Batches'],
              ['layerdailys', 'Layer Dailys'],
              ['eggdailys', 'Egg Dailys'],
            ].map(([v, l]) => (
              <button key={v} style={nb(view === v)} onClick={() => setView(v)}>
                {l}
              </button>
            ))}
          {inCattle &&
            [
              ['cattleHome', 'Dashboard'],
              ['cattleherds', 'Herds'],
              ['cattlebreeding', 'Breeding'],
              ['cattleweighins', 'Weigh-Ins'],
              ['cattleforecast', 'Forecast'],
              ['cattlebatches', 'Batches'],
              ['cattledailys', 'Dailys'],
            ].map(([v, l]) => (
              <button key={v} style={nb(view === v)} onClick={() => setView(v)}>
                {l}
              </button>
            ))}
          {inSheep &&
            [
              ['sheepHome', 'Dashboard'],
              ['sheepflocks', 'Flocks'],
              ['sheepweighins', 'Weigh-Ins'],
              ['sheepdailys', 'Dailys'],
              ['sheepbatches', 'Batches'],
            ].map(([v, l]) => (
              <button key={v} style={nb(view === v)} onClick={() => setView(v)}>
                {l}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
