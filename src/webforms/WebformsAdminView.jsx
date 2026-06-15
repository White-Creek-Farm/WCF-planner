// ============================================================================
// src/webforms/WebformsAdminView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Admin-only webforms config editor. Editor UI state lives inside this
// component (relocated from App during the per-view internalization lane);
// webformsConfig itself comes from useWebformsConfig(); the persist helper
// and the cross-tab adminTab toggle are passed in.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {sortByDailysOrder} from '../lib/dailysOrder.js';
import {setPublicAssigneeHidden} from '../lib/tasks.js';
import {loadPublicAssigneeAvailability, savePublicAssigneeAvailability} from '../lib/tasksAdminApi.js';
import UsersModal from '../auth/UsersModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from '../shared/InlineNotice.jsx';
import FeedCostsPanel from '../admin/FeedCostsPanel.jsx';
import FeedCostByMonthPanel from '../admin/FeedCostByMonthPanel.jsx';
import LivestockFeedInputsPanel from '../admin/LivestockFeedInputsPanel.jsx';
import NutritionTargetsPanel from '../admin/NutritionTargetsPanel.jsx';
import EquipmentWebformsAdmin from '../admin/EquipmentWebformsAdmin.jsx';
import FuelLogAdmin from '../admin/FuelLogAdmin.jsx';
import RecentlyDeletedDailyReports from '../admin/RecentlyDeletedDailyReports.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useWebformsConfig} from '../contexts/WebformsConfigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

function TeamAvailabilityEditor({loadUsers}) {
  const {allUsers} = useAuth();

  // Hydrate allUsers when this editor mounts and the auth context's list is
  // empty. Direct admin /webforms loads (URL bar / bookmark / reload) bypass
  // the Header -> Users click that would otherwise populate allUsers, and the
  // assignee checkboxes need it.
  React.useEffect(() => {
    if (typeof loadUsers !== 'function') return;
    if (Array.isArray(allUsers) && allUsers.length > 0) return;
    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  // Public-tasks assignee availability lives in webform_config.tasks_public_
  // assignee_availability, shape {hiddenProfileIds: [<profile uuid>, ...]}.
  // Controls which planner users appear in the public Tasks "Assign to" list.
  const [publicAssigneeAv, setPublicAssigneeAv] = React.useState({hiddenProfileIds: []});

  React.useEffect(() => {
    let cancelled = false;
    loadPublicAssigneeAvailability(sb).then((av) => {
      if (!cancelled) setPublicAssigneeAv(av);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggleAssignee(profileId, hidden) {
    setBusy(true);
    setErr('');
    try {
      const next = setPublicAssigneeHidden(publicAssigneeAv, profileId, hidden);
      const persisted = await savePublicAssigneeAvailability(sb, next);
      setPublicAssigneeAv(persisted);
    } catch (e) {
      setErr(e?.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const card = {
    background: 'linear-gradient(180deg, #ffffff 0%, #fbfdfc 100%)',
    border: '1px solid #d8e4de',
    borderRadius: 8,
    boxShadow: '0 10px 24px rgba(15, 23, 42, 0.06)',
    marginBottom: 18,
    overflow: 'hidden',
  };
  const rowStyle = {
    display: 'grid',
    gridTemplateColumns: '34px minmax(0, 1fr) auto',
    alignItems: 'center',
    gap: 10,
    minHeight: 54,
    padding: '10px 12px',
    border: '1px solid #e5e7eb',
    borderRadius: 8,
    background: '#ffffff',
    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
    fontSize: 12,
    color: '#1f2937',
    cursor: 'pointer',
    transition: 'border-color 120ms ease, box-shadow 120ms ease, background 120ms ease',
  };
  // Aligned CSS grid: rows/columns auto-fill so the list reads cleanly on
  // desktop and collapses to a single column on narrow/mobile widths.
  const assigneeGridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 8,
  };

  const hiddenAssigneeIds = new Set(publicAssigneeAv.hiddenProfileIds || []);
  const eligibleProfiles = (Array.isArray(allUsers) ? allUsers : [])
    .filter((u) => u && u.id && u.role !== 'inactive')
    .slice()
    .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  const hiddenCount = eligibleProfiles.filter((u) => hiddenAssigneeIds.has(u.id)).length;
  const includedCount = eligibleProfiles.length - hiddenCount;
  const roleLabels = {
    admin: 'Admin',
    management: 'Management',
    farm_team: 'Farm Team',
    light: 'Light',
    equipment_tech: 'Equipment',
  };

  function initialsFor(user) {
    const source = String(user.full_name || user.email || user.id || '').trim();
    if (!source) return '?';
    const parts = source.replace(/@.*/, '').split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2);
    return letters.toUpperCase();
  }

  return (
    <div style={card}>
      <div
        style={{
          padding: '14px 16px 12px',
          borderBottom: '1px solid #e5e7eb',
          display: 'flex',
          justifyContent: 'space-between',
          gap: 12,
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{fontSize: 13, fontWeight: 800, color: '#0f172a', marginBottom: 4}}>
            Public Tasks &mdash; Assignees
          </div>
          <div
            data-availability-default-copy="tasks-public"
            style={{fontSize: 12, color: '#64748b', lineHeight: 1.45, maxWidth: 560}}
          >
            Active planner users are included by default. Uncheck to hide a user from the public Tasks Assign-to
            dropdown.
          </div>
        </div>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 9px',
            borderRadius: 999,
            background: '#ecfdf5',
            border: '1px solid #bbf7d0',
            color: '#065f46',
            fontSize: 11,
            fontWeight: 700,
            whiteSpace: 'nowrap',
          }}
        >
          {includedCount} included
          {hiddenCount > 0 ? ` / ${hiddenCount} hidden` : ''}
        </div>
      </div>
      <div style={{padding: 16}}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
            gap: 10,
          }}
        >
          <div style={{fontSize: 11, color: '#64748b', fontWeight: 800, textTransform: 'uppercase'}}>
            Assignee (planner users)
          </div>
          {busy && <div style={{fontSize: 11, color: '#64748b'}}>Saving...</div>}
        </div>
        <div data-availability-assignee-grid="tasks-public" style={assigneeGridStyle}>
          {eligibleProfiles.length === 0 ? (
            <span style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>No eligible planner users yet.</span>
          ) : (
            eligibleProfiles.map((u) => {
              const isHidden = hiddenAssigneeIds.has(u.id);
              const name = u.full_name || u.email || u.id.slice(0, 8);
              return (
                <label
                  key={u.id}
                  data-availability-assignee-row="tasks-public"
                  data-availability-assignee-id={u.id}
                  data-availability-assignee-hidden={isHidden ? '1' : '0'}
                  style={{
                    ...rowStyle,
                    borderColor: isHidden ? '#e5e7eb' : '#b7d7ca',
                    background: isHidden ? '#f8fafc' : '#ffffff',
                    opacity: busy ? 0.72 : 1,
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: isHidden ? '#e5e7eb' : '#dff4eb',
                      color: isHidden ? '#64748b' : '#085041',
                      fontSize: 11,
                      fontWeight: 800,
                    }}
                  >
                    {initialsFor(u)}
                  </span>
                  <span style={{minWidth: 0}}>
                    <span
                      style={{
                        display: 'block',
                        color: isHidden ? '#64748b' : '#111827',
                        fontSize: 12,
                        fontWeight: 700,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {name}
                    </span>
                    <span style={{display: 'block', color: '#94a3b8', fontSize: 11, marginTop: 2}}>
                      {roleLabels[u.role] || u.role || 'Planner user'}
                    </span>
                  </span>
                  <span style={{display: 'inline-flex', alignItems: 'center', gap: 7}}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: isHidden ? '#64748b' : '#085041',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isHidden ? 'Hidden' : 'Included'}
                    </span>
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      disabled={busy}
                      onChange={(e) => onToggleAssignee(u.id, !e.target.checked)}
                      style={{margin: 0, accentColor: '#085041', width: 16, height: 16}}
                    />
                  </span>
                </label>
              );
            })
          )}
        </div>
      </div>
      {err && (
        <div
          style={{
            margin: '0 16px 16px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#b91c1c',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

export default function WebformsAdminView({
  Header,
  loadUsers,
  persistWebforms,
  saveFeedCosts,
  confirmDelete,
  adminTab,
  setAdminTab,
  refreshDailys,
}) {
  const [editWfId, setEditWfId] = React.useState(null);
  const [editFieldId, setEditFieldId] = React.useState(null);
  const [wfFieldForm, setWfFieldForm] = React.useState({label: '', type: 'text', required: false, options: []});
  // Inline notice for the wf-field add form's validation (label required +
  // button_toggle option count). Renders inside the add-field form so the
  // operator sees it on the surface that triggered the action.
  const [wfFieldNotice, setWfFieldNotice] = React.useState(null);
  const [newTeamMember, setNewTeamMember] = React.useState('');
  const [addingTo, setAddingTo] = React.useState(null);
  const [editFldLbl, setEditFldLbl] = React.useState(null);
  const [editFldVal, setEditFldVal] = React.useState('');
  const [editSecIdx, setEditSecIdx] = React.useState(null);
  const [editSecVal, setEditSecVal] = React.useState('');
  const [newOpt, setNewOpt] = React.useState('');
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {webformsConfig, wfGroups, setWfGroups} = useWebformsConfig();
  const {feedCosts} = useFeedCosts();
  const {setView} = useUI();
  const FIELD_TYPES = [
    {value: 'text', label: 'Text (single line)'},
    {value: 'textarea', label: 'Text (multi-line)'},
    {value: 'number', label: 'Number'},
    {value: 'yes_no', label: 'Yes / No toggle'},
    {value: 'button_toggle', label: 'Button toggle (custom options)'},
    {value: 'date', label: 'Date picker'},
  ];
  const TYPE_LABELS = {
    text: 'Text',
    textarea: 'Multi-line text',
    number: 'Number',
    yes_no: 'Yes/No toggle',
    button_toggle: 'Button toggle',
    date: 'Date',
    team_picker: 'Team member picker',
    group_picker: 'Group selector',
    egg_group: 'Egg group pair',
  };
  const TYPE_COLOR = {
    text: '#374151',
    textarea: '#374151',
    number: '#1d4ed8',
    yes_no: '#085041',
    button_toggle: '#1e40af',
    date: '#92400e',
    team_picker: '#0369a1',
    group_picker: '#be185d',
    egg_group: '#d97706',
  };

  const currentWf = editWfId ? webformsConfig.webforms.find((w) => w.id === editWfId) : null;

  function updateWf(updated) {
    const nb = {...webformsConfig, webforms: webformsConfig.webforms.map((w) => (w.id === editWfId ? updated : w))};
    persistWebforms(nb);
  }
  function updateSections(s) {
    updateWf({...currentWf, sections: s});
  }

  // The team-member roster (and its admin editor) was retired 2026-06-06:
  // every user is authenticated, so form submitters are locked to the
  // signed-in user. webformsConfig.teamMembers is no longer read or written.
  function moveSection(si, dir) {
    const s = [...currentWf.sections];
    if (si + dir < 0 || si + dir >= s.length) return;
    [s[si], s[si + dir]] = [s[si + dir], s[si]];
    updateSections(s);
  }
  function addSection() {
    updateSections([...currentWf.sections, {id: 'sec-' + Date.now(), title: 'New Section', system: false, fields: []}]);
  }
  function renameSection(si, title) {
    updateSections(currentWf.sections.map((s, i) => (i === si ? {...s, title} : s)));
  }
  function deleteSection(si) {
    confirmDelete('Delete this section and all its fields? This cannot be undone.', () => {
      updateSections(currentWf.sections.filter((_, i) => i !== si));
    });
  }
  function moveField(si, fi, dir) {
    updateSections(
      currentWf.sections.map((s, i) => {
        if (i !== si) return s;
        const f = [...s.fields];
        if (fi + dir < 0 || fi + dir >= f.length) return s;
        [f[fi], f[fi + dir]] = [f[fi + dir], f[fi]];
        return {...s, fields: f};
      }),
    );
  }
  function toggleField(si, fi) {
    updateSections(
      currentWf.sections.map((s, i) =>
        i !== si ? s : {...s, fields: s.fields.map((f, j) => (j !== fi ? f : {...f, enabled: !f.enabled}))},
      ),
    );
  }
  function deleteField(si, fi) {
    confirmDelete('Delete this field? This cannot be undone.', () => {
      updateSections(
        currentWf.sections.map((s, i) => (i !== si ? s : {...s, fields: s.fields.filter((_, j) => j !== fi)})),
      );
    });
  }
  function renameField(si, fi, label) {
    updateSections(
      currentWf.sections.map((s, i) =>
        i !== si ? s : {...s, fields: s.fields.map((f, j) => (j !== fi ? f : {...f, label}))},
      ),
    );
  }
  function saveNewField(si) {
    setWfFieldNotice(null);
    if (!wfFieldForm.label.trim()) {
      setWfFieldNotice({kind: 'error', message: 'Enter a field label.'});
      return;
    }
    if (wfFieldForm.type === 'button_toggle' && (!wfFieldForm.options || wfFieldForm.options.length < 2)) {
      setWfFieldNotice({kind: 'error', message: 'Add at least 2 button options.'});
      return;
    }
    const nf = {id: 'c-' + Date.now(), ...wfFieldForm, system: false, enabled: true};
    updateSections(currentWf.sections.map((s, i) => (i !== si ? s : {...s, fields: [...s.fields, nf]})));
    setWfFieldForm({label: '', type: 'text', required: false, options: []});
  }

  return (
    <div>
      <Header />
      {/* Sub-nav bar — matches animal section style */}
      <div
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
          onClick={() => setView('home')}
          style={{
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
          }}
        >
          ⌂ Home
        </button>
        <div style={{width: 1, height: 20, background: '#e5e7eb', margin: '0 4px'}} />
        {[
          {id: 'webforms', label: 'Webforms'},
          {id: 'equipment', label: 'Equipment'},
          {id: 'fuellog', label: 'Fuel Log'},
          {id: 'feedcosts', label: 'Feed'},
          {id: 'costsbymonth', label: 'Cost by Month'},
          {id: 'deleted', label: 'Deleted'},
        ].map((t) => {
          const active = adminTab === t.id && !editWfId;
          return (
            <button
              key={t.id}
              onClick={() => {
                setAdminTab(t.id);
                setEditWfId(null);
              }}
              style={{
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
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {adminTab === 'equipment' && (
        <div style={{padding: '1rem', maxWidth: 900, margin: '0 auto'}}>
          <EquipmentWebformsAdmin />
        </div>
      )}
      {adminTab === 'fuellog' && (
        <div style={{padding: '1rem', maxWidth: 1100, margin: '0 auto'}}>
          <FuelLogAdmin />
        </div>
      )}
      {adminTab === 'deleted' && (
        <div style={{padding: '1rem', maxWidth: 900, margin: '0 auto'}}>
          <RecentlyDeletedDailyReports refreshDailys={refreshDailys} />
        </div>
      )}
      <div
        style={{
          padding: '1rem',
          maxWidth: 720,
          margin: '0 auto',
          display: adminTab === 'equipment' || adminTab === 'fuellog' || adminTab === 'deleted' ? 'none' : 'block',
        }}
      >
        {showUsers && (
          <UsersModal
            sb={sb}
            authState={authState}
            allUsers={allUsers}
            setAllUsers={setAllUsers}
            setShowUsers={setShowUsers}
            loadUsers={loadUsers}
          />
        )}

        {adminTab === 'feedcosts' && (
          <div style={{display: 'flex', flexDirection: 'column'}}>
            <FeedCostsPanel feedCosts={feedCosts} saveFeedCosts={saveFeedCosts} />
            <LivestockFeedInputsPanel sb={sb} />
            <NutritionTargetsPanel sb={sb} />
          </div>
        )}

        {adminTab === 'costsbymonth' && <FeedCostByMonthPanel sb={sb} feedCosts={feedCosts} />}

        {adminTab === 'webforms' && (
          <div>
            {/* ── MASTER TEAM ROSTER + per-form availability filters (only at list level, hidden inside the per-form editor) ── */}
            {!editWfId && <TeamAvailabilityEditor loadUsers={loadUsers} />}

            {/* ── WEIGH-INS EDITOR (per-species lists retired; no editor needed for v1) ── */}
            {editWfId && currentWf && currentWf.id === 'weighins-webform' && (
              <div>
                <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16}}>
                  <button
                    onClick={() => {
                      setEditWfId(null);
                      setAddingTo(null);
                    }}
                    style={{fontSize: 12, color: '#1d4ed8', background: 'none', border: 'none', cursor: 'pointer'}}
                  >
                    ← All webforms
                  </button>
                  <span style={{color: '#d1d5db'}}>/</span>
                  <span style={{fontSize: 14, fontWeight: 700}}>{currentWf.name}</span>
                </div>
                <div
                  style={{
                    background: '#f9fafb',
                    border: '1px solid #e5e7eb',
                    borderRadius: 10,
                    padding: '14px 16px',
                    fontSize: 12,
                    color: '#4b5563',
                    lineHeight: 1.5,
                  }}
                >
                  The Weigh-Ins webform now uses the master team roster directly. Every active team member appears for
                  every species. Manage names from the Team Members section on the Webforms list.
                </div>
              </div>
            )}

            {/* ── EDITOR ── */}
            {editWfId && currentWf && currentWf.id !== 'weighins-webform' && (
              <div>
                <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16}}>
                  <button
                    onClick={() => {
                      setEditWfId(null);
                      setAddingTo(null);
                    }}
                    style={{fontSize: 12, color: '#1d4ed8', background: 'none', border: 'none', cursor: 'pointer'}}
                  >
                    ← All webforms
                  </button>
                  <span style={{color: '#d1d5db'}}>/</span>
                  <span style={{fontSize: 14, fontWeight: 700}}>{currentWf.name}</span>
                </div>
                <div
                  style={{
                    background: '#ecfdf5',
                    border: '1px solid #a7f3d0',
                    borderRadius: 10,
                    padding: '10px 16px',
                    marginBottom: 16,
                    fontSize: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                  }}
                >
                  <span style={{color: '#6b7280'}}>Live URL:</span>
                  <strong style={{color: '#085041'}}>wcfplanner.com/dailys</strong>
                  <a href="/dailys" target="_blank" style={{color: '#085041', fontSize: 11, marginLeft: 'auto'}}>
                    Open form →
                  </a>
                </div>

                {/* Per-form Team Members section retired 2026-04-29 — master
                    roster lives at the top of the Webforms list. Sections
                    pick up the master roster automatically via the team
                    picker. */}

                {/* Sections header */}
                <div style={{marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                  <div style={{fontSize: 13, fontWeight: 700, color: '#111827'}}>Form Sections & Fields</div>
                  <button
                    onClick={addSection}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 6,
                      border: 'none',
                      background: '#085041',
                      color: 'white',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    + Add Section
                  </button>
                </div>

                {(currentWf.sections || []).map((sec, si) => (
                  <div
                    key={sec.id}
                    style={{
                      background: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: 10,
                      marginBottom: 12,
                      overflow: 'hidden',
                    }}
                  >
                    {/* Section header row */}
                    <div
                      style={{
                        padding: '10px 14px',
                        background: sec.system ? '#f0fdf9' : '#f9fafb',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        borderBottom: '1px solid #e5e7eb',
                      }}
                    >
                      <div style={{display: 'flex', flexDirection: 'column', gap: 2}}>
                        <button
                          onClick={() => moveSection(si, -1)}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 10,
                            color: '#9ca3af',
                            lineHeight: 1,
                            padding: 0,
                            opacity: si === 0 ? 0.3 : 1,
                          }}
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => moveSection(si, 1)}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            fontSize: 10,
                            color: '#9ca3af',
                            lineHeight: 1,
                            padding: 0,
                            opacity: si === currentWf.sections.length - 1 ? 0.3 : 1,
                          }}
                        >
                          ▼
                        </button>
                      </div>
                      {editSecIdx === si ? (
                        <input
                          autoFocus
                          value={editSecVal}
                          onChange={(e) => setEditSecVal(e.target.value)}
                          onBlur={() => {
                            renameSection(si, editSecVal);
                            setEditSecIdx(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              renameSection(si, editSecVal);
                              setEditSecIdx(null);
                            }
                          }}
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            border: '1px solid #3b82f6',
                            borderRadius: 4,
                            padding: '2px 6px',
                            flex: 1,
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13,
                            color: '#111827',
                            flex: 1,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          {sec.title}
                          {sec.system && (
                            <span
                              style={{
                                fontSize: 10,
                                color: '#085041',
                                background: '#ecfdf5',
                                border: '1px solid #a7f3d0',
                                borderRadius: 4,
                                padding: '1px 5px',
                              }}
                            >
                              system
                            </span>
                          )}
                          {!sec.system && (
                            <button
                              onClick={() => {
                                setEditSecIdx(si);
                                setEditSecVal(sec.title);
                              }}
                              style={{
                                fontSize: 11,
                                color: '#9ca3af',
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                padding: '0 4px',
                              }}
                            >
                              ✎ rename
                            </button>
                          )}
                        </div>
                      )}
                      <div style={{display: 'flex', gap: 6, alignItems: 'center'}}>
                        <button
                          onClick={() => {
                            setWfFieldNotice(null);
                            setAddingTo(addingTo === si ? null : si);
                          }}
                          style={{
                            fontSize: 11,
                            padding: '3px 10px',
                            borderRadius: 5,
                            border: '1px solid #d1d5db',
                            background: 'white',
                            color: '#085041',
                            cursor: 'pointer',
                            fontWeight: 600,
                          }}
                        >
                          + Field
                        </button>
                        {!sec.system && (
                          <button
                            onClick={() => deleteSection(si)}
                            style={{
                              fontSize: 11,
                              color: '#b91c1c',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Add field form */}
                    {addingTo === si && (
                      <div style={{padding: '12px 14px', background: '#f0f7ff', borderBottom: '1px solid #e5e7eb'}}>
                        <div style={{fontSize: 12, fontWeight: 600, color: '#1d4ed8', marginBottom: 10}}>
                          Add field to "{sec.title}"
                        </div>
                        <InlineNotice notice={wfFieldNotice} onDismiss={() => setWfFieldNotice(null)} />
                        <div style={{display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginBottom: 10}}>
                          <div>
                            <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>
                              Label *
                            </label>
                            <input
                              value={wfFieldForm.label}
                              onChange={(e) => setWfFieldForm({...wfFieldForm, label: e.target.value})}
                              placeholder="e.g. Body weight (lbs)"
                              style={{fontSize: 12, padding: '6px 10px', width: '100%'}}
                            />
                          </div>
                          <div>
                            <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>
                              Type
                            </label>
                            <select
                              value={wfFieldForm.type}
                              onChange={(e) => setWfFieldForm({...wfFieldForm, type: e.target.value, options: []})}
                              style={{fontSize: 12, padding: '6px 8px', width: '100%'}}
                            >
                              {FIELD_TYPES.map((t) => (
                                <option key={t.value} value={t.value}>
                                  {t.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {wfFieldForm.type === 'button_toggle' && (
                          <div style={{marginBottom: 10}}>
                            <label style={{fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3}}>
                              Button options (min 2)
                            </label>
                            <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6}}>
                              {(wfFieldForm.options || []).map((o) => (
                                <div
                                  key={o}
                                  style={{
                                    background: '#e5e7eb',
                                    borderRadius: 4,
                                    padding: '2px 8px',
                                    fontSize: 11,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                  }}
                                >
                                  {o}
                                  <button
                                    onClick={() =>
                                      setWfFieldForm({
                                        ...wfFieldForm,
                                        options: wfFieldForm.options.filter((x) => x !== o),
                                      })
                                    }
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      color: '#6b7280',
                                      fontSize: 12,
                                      padding: 0,
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                            <div style={{display: 'flex', gap: 6}}>
                              <input
                                value={newOpt}
                                onChange={(e) => setNewOpt(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && newOpt.trim()) {
                                    setWfFieldForm({
                                      ...wfFieldForm,
                                      options: [...(wfFieldForm.options || []), newOpt.trim()],
                                    });
                                    setNewOpt('');
                                  }
                                }}
                                placeholder="Add option…"
                                style={{fontSize: 12, padding: '5px 8px', flex: 1}}
                              />
                              <button
                                onClick={() => {
                                  if (newOpt.trim()) {
                                    setWfFieldForm({
                                      ...wfFieldForm,
                                      options: [...(wfFieldForm.options || []), newOpt.trim()],
                                    });
                                    setNewOpt('');
                                  }
                                }}
                                style={{
                                  padding: '5px 10px',
                                  borderRadius: 5,
                                  border: 'none',
                                  background: '#374151',
                                  color: 'white',
                                  fontSize: 11,
                                  cursor: 'pointer',
                                }}
                              >
                                Add
                              </button>
                            </div>
                          </div>
                        )}
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 12,
                            cursor: 'pointer',
                            marginBottom: 8,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={wfFieldForm.required}
                            onChange={(e) => setWfFieldForm({...wfFieldForm, required: e.target.checked})}
                            style={{width: 'auto'}}
                          />
                          Required
                        </label>
                        <div style={{display: 'flex', gap: 6}}>
                          <button
                            onClick={() => saveNewField(si)}
                            style={{
                              padding: '6px 14px',
                              borderRadius: 6,
                              border: 'none',
                              background: '#085041',
                              color: 'white',
                              fontSize: 12,
                              fontWeight: 600,
                              cursor: 'pointer',
                            }}
                          >
                            Add Field
                          </button>
                          <button
                            onClick={() => {
                              setWfFieldNotice(null);
                              setAddingTo(null);
                              setWfFieldForm({label: '', type: 'text', required: false, options: []});
                              setNewOpt('');
                            }}
                            style={{
                              padding: '6px 12px',
                              borderRadius: 6,
                              border: '1px solid #d1d5db',
                              background: 'white',
                              color: '#374151',
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {sec.fields.length === 0 && (
                      <div
                        style={{
                          padding: '12px 14px',
                          fontSize: 12,
                          color: '#9ca3af',
                          textAlign: 'center',
                          fontStyle: 'italic',
                        }}
                      >
                        No fields — click "+ Field" to add
                      </div>
                    )}

                    {sec.fields.map((f, fi) => (
                      <div
                        key={f.id}
                        style={{
                          padding: '10px 14px',
                          borderBottom: fi < sec.fields.length - 1 ? '1px solid #f3f4f6' : 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          background: f.enabled ? 'white' : '#fafafa',
                          opacity: f.enabled ? 1 : 0.55,
                        }}
                      >
                        <div style={{display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0}}>
                          <button
                            onClick={() => moveField(si, fi, -1)}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 10,
                              color: '#9ca3af',
                              lineHeight: 1,
                              padding: 0,
                              opacity: fi === 0 || f.system ? 0.3 : 1,
                            }}
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => moveField(si, fi, 1)}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 10,
                              color: '#9ca3af',
                              lineHeight: 1,
                              padding: 0,
                              opacity: fi === sec.fields.length - 1 || f.system ? 0.3 : 1,
                            }}
                          >
                            ▼
                          </button>
                        </div>
                        <div style={{flex: 1}}>
                          {editFldLbl && editFldLbl.si === si && editFldLbl.fi === fi ? (
                            <input
                              autoFocus
                              value={editFldVal}
                              onChange={(e) => setEditFldVal(e.target.value)}
                              onBlur={() => {
                                renameField(si, fi, editFldVal);
                                setEditFldLbl(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  renameField(si, fi, editFldVal);
                                  setEditFldLbl(null);
                                }
                              }}
                              style={{
                                fontSize: 13,
                                border: '1px solid #3b82f6',
                                borderRadius: 4,
                                padding: '2px 6px',
                                width: '100%',
                              }}
                            />
                          ) : (
                            <div style={{display: 'flex', alignItems: 'center', gap: 6}}>
                              <span style={{fontSize: 13, fontWeight: 500, color: '#111827'}}>{f.label}</span>
                              {!f.system && (
                                <button
                                  onClick={() => {
                                    setEditFldLbl({si, fi});
                                    setEditFldVal(f.label);
                                  }}
                                  style={{
                                    fontSize: 11,
                                    color: '#9ca3af',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: '0 2px',
                                  }}
                                >
                                  ✎
                                </button>
                              )}
                            </div>
                          )}
                          <div style={{display: 'flex', gap: 4, marginTop: 3, flexWrap: 'wrap', alignItems: 'center'}}>
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 4,
                                background: TYPE_COLOR[f.type] || '#374151',
                                color: 'white',
                                fontWeight: 500,
                              }}
                            >
                              {TYPE_LABELS[f.type] || f.type}
                            </span>
                            {f.required && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: '#fef3c7',
                                  color: '#92400e',
                                  fontWeight: 500,
                                }}
                              >
                                required
                              </span>
                            )}
                            {f.system && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: '1px 6px',
                                  borderRadius: 4,
                                  background: '#f3f4f6',
                                  color: '#6b7280',
                                }}
                              >
                                system — locked
                              </span>
                            )}
                            {f.type === 'button_toggle' && f.options && (
                              <span style={{fontSize: 10, color: '#9ca3af'}}>{f.options.join(' / ')}</span>
                            )}
                          </div>
                        </div>
                        <div style={{display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center'}}>
                          {!f.system && (
                            <>
                              <button
                                onClick={() => {
                                  updateSections(
                                    currentWf.sections.map((s, i) =>
                                      i !== si
                                        ? s
                                        : {
                                            ...s,
                                            fields: s.fields.map((ff, j) =>
                                              j !== fi ? ff : {...ff, required: !ff.required},
                                            ),
                                          },
                                    ),
                                  );
                                }}
                                style={{
                                  fontSize: 11,
                                  padding: '3px 8px',
                                  borderRadius: 5,
                                  border: '1px solid #d1d5db',
                                  background: f.required ? '#fef3c7' : 'white',
                                  color: f.required ? '#92400e' : '#6b7280',
                                  cursor: 'pointer',
                                  fontWeight: f.required ? 600 : 400,
                                }}
                              >
                                {f.required ? '★ Req' : '☆ Req'}
                              </button>
                              <button
                                onClick={() => toggleField(si, fi)}
                                style={{
                                  fontSize: 11,
                                  padding: '3px 8px',
                                  borderRadius: 5,
                                  border: '1px solid #d1d5db',
                                  background: 'white',
                                  color: '#4b5563',
                                  cursor: 'pointer',
                                }}
                              >
                                {f.enabled ? 'Hide' : 'Show'}
                              </button>
                              <button
                                onClick={() => deleteField(si, fi)}
                                style={{
                                  fontSize: 11,
                                  color: '#b91c1c',
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                }}
                              >
                                Del
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* ── LIST ── */}
            {!editWfId && (
              <div>
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4}}>
                  <div style={{fontSize: 15, fontWeight: 700, color: '#111827'}}>Webforms</div>
                  <button
                    onClick={() => setView('home')}
                    style={{
                      padding: '5px 14px',
                      borderRadius: 7,
                      border: '1px solid #d1d5db',
                      background: 'white',
                      color: '#374151',
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    ← Home
                  </button>
                </div>
                <div style={{fontSize: 12, color: '#6b7280', marginBottom: 16}}>
                  Manage sections, fields, and team members. Changes go live immediately.
                </div>

                {sortByDailysOrder(webformsConfig.webforms, (w) => w.id).map((wf) => {
                  const isAddFeed = wf.id === 'add-feed-webform';
                  const isWeighIns = wf.id === 'weighins-webform';
                  const totalFields = (wf.sections || []).reduce(
                    (s, sec) => s + sec.fields.filter((f) => f.enabled).length,
                    0,
                  );
                  const tileBg = isAddFeed ? '#fffbeb' : isWeighIns ? '#eff6ff' : 'white';
                  const tileBorder = isAddFeed
                    ? '1px solid #fde68a'
                    : isWeighIns
                      ? '1px solid #bfdbfe'
                      : '1px solid #e5e7eb';
                  const titleColor = isAddFeed ? '#92400e' : isWeighIns ? '#1e40af' : '#111827';
                  const accent = isAddFeed ? '#92400e' : isWeighIns ? '#1e40af' : '#085041';
                  const iconPrefix = isAddFeed ? '🌾 ' : isWeighIns ? '⚖️ ' : '';
                  const liveHref = isAddFeed ? '/addfeed' : isWeighIns ? '/weighins' : '/dailys';
                  const liveLabel = isAddFeed
                    ? 'wcfplanner.com/addfeed'
                    : isWeighIns
                      ? 'wcfplanner.com/weighins'
                      : 'wcfplanner.com/dailys';
                  return (
                    <div
                      key={wf.id}
                      style={{
                        background: tileBg,
                        border: tileBorder,
                        borderRadius: 10,
                        padding: '16px',
                        marginBottom: 12,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'flex-start',
                          flexWrap: 'wrap',
                          gap: 8,
                        }}
                      >
                        <div>
                          <div style={{fontSize: 14, fontWeight: 700, color: titleColor}}>
                            {iconPrefix}
                            {wf.name}
                          </div>
                          <div style={{fontSize: 12, color: '#6b7280', marginTop: 2}}>{wf.description}</div>
                          <a
                            href={liveHref}
                            target="_blank"
                            style={{fontSize: 11, color: accent, display: 'block', marginTop: 4}}
                          >
                            {liveLabel}
                          </a>
                        </div>
                        <button
                          onClick={() => {
                            setEditWfId(wf.id);
                            setAddingTo(null);
                          }}
                          style={{
                            padding: '6px 16px',
                            borderRadius: 7,
                            border: 'none',
                            background: accent,
                            color: 'white',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          Edit {'\u2192'}
                        </button>
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          display: 'flex',
                          gap: 16,
                          fontSize: 12,
                          color: '#6b7280',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        {!isAddFeed && !isWeighIns && (
                          <span>
                            📋 {(wf.sections || []).length} sections · {totalFields} active fields
                          </span>
                        )}
                        <span style={{color: '#9ca3af'}}>👤 master team roster (manage from list)</span>
                        {!isWeighIns && (
                          <label
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              cursor: 'pointer',
                              marginLeft: 'auto',
                              userSelect: 'none',
                            }}
                          >
                            <span style={{color: '#374151', fontWeight: 500, fontSize: 11}}>Add Group:</span>
                            <div
                              onClick={() => {
                                const nb = {
                                  ...webformsConfig,
                                  webforms: webformsConfig.webforms.map((w) =>
                                    w.id === wf.id ? {...w, allowAddGroup: !wf.allowAddGroup} : w,
                                  ),
                                };
                                persistWebforms(nb);
                              }}
                              style={{
                                width: 36,
                                height: 20,
                                borderRadius: 10,
                                background: wf.allowAddGroup ? '#085041' : '#d1d5db',
                                cursor: 'pointer',
                                position: 'relative',
                                transition: 'background .2s',
                                flexShrink: 0,
                              }}
                            >
                              <div
                                style={{
                                  position: 'absolute',
                                  top: 2,
                                  left: wf.allowAddGroup ? 18 : 2,
                                  width: 16,
                                  height: 16,
                                  borderRadius: '50%',
                                  background: 'white',
                                  transition: 'left .2s',
                                  boxShadow: '0 1px 3px rgba(0,0,0,.2)',
                                }}
                              />
                            </div>
                            <span style={{fontSize: 11, color: wf.allowAddGroup ? '#085041' : '#9ca3af'}}>
                              {wf.allowAddGroup ? 'On' : 'Off'}
                            </span>
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
