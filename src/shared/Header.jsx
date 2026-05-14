// ============================================================================
// src/shared/Header.jsx  —  Phase 2 Round 6 tail + Notifications Center prep
// ----------------------------------------------------------------------------
// The top nav bar + program sub-nav. Reads view/menu state from UIContext,
// auth/save-status from AuthContext, form open-state booleans from
// BatchesContext + PigContext. A handful of App-only things come as props:
// two App helpers (signOut, loadUsers) and the built-up DeleteConfirmModal
// React element (depends on App's deleteConfirm state).
//
// 2026-05-14 navigation prep for the future Notifications Center:
//   - Webforms group (Dailys + Equipment text buttons) moved out of the
//     dark bar into the hamburger menu. The menu is the single broader-
//     navigation surface for every logged-in role.
//   - Tasks converted from a text button to an icon-only white circle on
//     the green bar; existing count badge and click behavior preserved.
//   - Notifications placeholder icon button added next to Tasks. NO fake
//     data, NO badge until the storage lane lands — this slot reserves
//     header layout so the Notifications Center can drop in without
//     another header refactor.
//   - Sign Out moved into the hamburger; the only top-bar exit point now
//     is via the menu. Keeps the header light at mobile widths.
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

// Shared white-button shape for header action icons (Tasks, Notifications,
// Hamburger). 2026-05-14 Codex direction: actual white buttons on the
// green header, not translucent outline-on-green. 36×36 hit target meets
// WCAG 2.5.5 (Level AAA = 24px / Level AA = 44px; 36px is a deliberate
// middle ground that keeps mobile usable without dominating the bar).
// Brand-green stroke (#085041) on solid white reads cleanly as an action
// group; the active state uses a subtle light-green tint that mirrors
// the palette used elsewhere in the app.
const HEADER_ICON_BTN = {
  width: 36,
  height: 36,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  padding: 0,
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,.55)',
  background: '#ffffff',
  color: '#085041',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  fontFamily: 'inherit',
};

const HEADER_ICON_BTN_ACTIVE = {
  ...HEADER_ICON_BTN,
  background: '#ecfdf5',
  border: '1px solid #ffffff',
  boxShadow: '0 0 0 1px rgba(255,255,255,.6)',
};

// Red badge for unread/open counts on header icons. White border so the
// badge pops cleanly off the white button.
const HEADER_BADGE = {
  position: 'absolute',
  top: -4,
  right: -4,
  padding: '0 5px',
  minWidth: 16,
  height: 16,
  lineHeight: '16px',
  fontSize: 10,
  fontWeight: 700,
  borderRadius: 999,
  background: '#dc2626',
  color: 'white',
  textAlign: 'center',
  border: '1px solid #ffffff',
};

// Inline monochrome SVG icons that use currentColor so the parent button's
// `color` style controls the stroke. Avoids the "mixed white-on-colored-
// tile" anti-pattern of dropping a colored PNG inside a white button.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function CheckmarkIcon({size = 18}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function BellIcon({size = 18}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

// Hamburger menu item shape. Generic; section labels override `style`.
const MENU_ITEM_BTN = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '10px 16px',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  fontSize: 13,
  textAlign: 'left',
  color: '#111827',
  fontFamily: 'inherit',
};

const MENU_SECTION_LABEL = {
  display: 'block',
  padding: '8px 16px 4px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  color: '#6b7280',
};

const MENU_DIVIDER = {
  height: 1,
  background: '#f3f4f6',
  margin: '4px 0',
};

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

  // Common navigation reset: every header-driven setView must also close
  // any open broiler/pig form drawers so they don't leak into the next
  // view. Extracted here so the hamburger menu's eight destinations don't
  // each have to repeat the three setShow*(false) calls.
  function go(nextView) {
    setShowForm(false);
    setShowBreedForm(false);
    setShowFarrowForm(false);
    setView(nextView);
    setShowMenu(false);
  }

  const isAdmin = authState?.role === 'admin';

  return (
    <div className="no-print">
      {DeleteConfirmModal}
      {ConfirmActionModal}
      {/* ── Dark top bar ── */}
      <div data-header-bar="1" style={S.header}>
        <button
          data-header-brand="1"
          onClick={() => go('home')}
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
        {/* Right-side icon group: Tasks, Notifications placeholder, Hamburger.
            Each is a 36x36 white-on-green button with a translucent border.
            On mobile the index.html @media rule reorders them via flex order
            so the brand stays first and these icons stay visible without
            wrapping under the brand. */}
        <div
          data-header-action-group="1"
          style={{display: 'flex', gap: 6, alignItems: 'center', marginLeft: 8, position: 'relative'}}
        >
          {authState?.user && (
            <button
              data-tasks-header-link="1"
              aria-label={`Tasks${myDueCount > 0 ? ` (${myDueCount} due or overdue)` : ''}`}
              title="Tasks"
              onClick={() => go('tasks')}
              style={view === 'tasks' ? HEADER_ICON_BTN_ACTIVE : HEADER_ICON_BTN}
            >
              <CheckmarkIcon size={18} />
              {myDueCount > 0 && (
                <span data-tasks-header-badge={myDueCount} style={HEADER_BADGE}>
                  {myDueCount}
                </span>
              )}
            </button>
          )}
          {/* Notifications placeholder — layout slot for the future
              Notifications Center lane. No real notification source is
              wired yet; deliberately renders WITHOUT a badge so a stale
              "0" or "N" can't mislead operators. The button is reachable
              and announces its placeholder state via aria-label; clicking
              it is a no-op until the Notifications Center ships. */}
          {authState?.user && (
            <button
              data-notifications-header-link="1"
              data-notifications-placeholder="1"
              aria-label="Notifications (coming soon)"
              title="Notifications (coming soon)"
              onClick={() => {
                /* Notifications Center not yet implemented — placeholder slot only. */
              }}
              style={HEADER_ICON_BTN}
            >
              <BellIcon size={18} />
            </button>
          )}
          {authState?.user && (
            <div style={{position: 'relative'}}>
              <button
                data-header-menu-toggle="1"
                aria-label="Menu"
                aria-expanded={showMenu ? 'true' : 'false'}
                onClick={() => setShowMenu((m) => !m)}
                style={showMenu ? HEADER_ICON_BTN_ACTIVE : HEADER_ICON_BTN}
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
                  data-header-menu="1"
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '110%',
                    background: 'white',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    boxShadow: '0 8px 24px rgba(0,0,0,.15)',
                    zIndex: 200,
                    minWidth: 220,
                    overflow: 'hidden',
                    fontFamily: 'inherit',
                  }}
                >
                  <button data-header-menu-item="home" onClick={() => go('home')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">🏠</span> Home
                  </button>

                  <div style={MENU_DIVIDER} />
                  <span style={MENU_SECTION_LABEL}>Webforms</span>
                  <button data-header-menu-item="dailys" onClick={() => go('webformhub')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">📝</span> Dailys
                  </button>
                  <button data-header-menu-item="addfeed" onClick={() => go('addfeed')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">🌾</span> Add Feed
                  </button>
                  <button data-header-menu-item="weighins" onClick={() => go('weighins')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">⚖️</span> Weigh-Ins
                  </button>
                  <button data-header-menu-item="equipment" onClick={() => go('fuelingHub')} style={MENU_ITEM_BTN}>
                    <PlannerIcon iconKey="tractor" size={16} /> Equipment
                  </button>
                  <button data-header-menu-item="fuel-supply" onClick={() => go('fuelSupply')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">⛽</span> Fuel Supply
                  </button>
                  <button data-header-menu-item="submit-task" onClick={() => go('tasksWebform')} style={MENU_ITEM_BTN}>
                    <span aria-hidden="true">✅</span> Submit a Task
                  </button>

                  {isAdmin && (
                    <>
                      <div style={MENU_DIVIDER} />
                      <button data-header-menu-item="admin" onClick={() => go('webforms')} style={MENU_ITEM_BTN}>
                        <span aria-hidden="true">⚙️</span> Admin
                      </button>
                      <button
                        data-header-menu-item="users"
                        onClick={() => {
                          setShowUsers(true);
                          loadUsers();
                          setShowMenu(false);
                        }}
                        style={MENU_ITEM_BTN}
                      >
                        <span aria-hidden="true">👥</span> Users
                      </button>
                    </>
                  )}

                  <div style={MENU_DIVIDER} />
                  <button
                    data-header-menu-item="sign-out"
                    onClick={() => {
                      setShowMenu(false);
                      signOut();
                    }}
                    style={{...MENU_ITEM_BTN, color: '#b91c1c'}}
                  >
                    <span aria-hidden="true">🚪</span> Sign Out
                  </button>
                </div>
              )}
            </div>
          )}
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
          <button onClick={() => go('home')} style={ghostBtn}>
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
