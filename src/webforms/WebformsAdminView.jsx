// ============================================================================
// src/webforms/WebformsAdminView.jsx  —  Phase 2 Round 6
// ----------------------------------------------------------------------------
// Admin-only webforms config editor. Most form state is App-scope (Round 0
// deliberately left these out of WebformsConfigContext per §14's unowned
// state list) and comes in as a pile of props. webformsConfig itself is
// in useWebformsConfig(); the persist helper is passed in.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {fmt, fmtS, todayISO, addDays} from '../lib/dateUtils.js';
import {S} from '../lib/styles.js';
import {addMember, renameMember, removeMember, saveRoster, loadRoster} from '../lib/teamMembers.js';
import {
  TEAM_AVAILABILITY_FORM_KEYS,
  cleanAvailabilityForDeletedId,
  loadAvailability,
  saveAvailability,
  setHidden,
} from '../lib/teamAvailability.js';
import {setPublicAssigneeHidden} from '../lib/tasks.js';
import {loadPublicAssigneeAvailability, savePublicAssigneeAvailability} from '../lib/tasksAdminApi.js';
import UsersModal from '../auth/UsersModal.jsx';
import FeedCostsPanel from '../admin/FeedCostsPanel.jsx';
import FeedCostByMonthPanel from '../admin/FeedCostByMonthPanel.jsx';
import LivestockFeedInputsPanel from '../admin/LivestockFeedInputsPanel.jsx';
import NutritionTargetsPanel from '../admin/NutritionTargetsPanel.jsx';
import EquipmentWebformsAdmin from '../admin/EquipmentWebformsAdmin.jsx';
import FuelLogAdmin from '../admin/FuelLogAdmin.jsx';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useFeedCosts} from '../contexts/FeedCostsContext.jsx';
import {useWebformsConfig} from '../contexts/WebformsConfigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';

// ── Team Roster master editor ────────────────────────────────────────────
// Sole writer of webform_config.team_roster (canonical) +
// webform_config.team_members (legacy mirror). Read-fresh-then-merge
// inside saveRoster keeps concurrent admin tabs from clobbering each
// other. v1 actions: add / rename / hard-delete. The previous
// active/inactive (soft-delete) workflow was retired 2026-04-29 — delete
// is the only removal path. The "temporarily inactive worker" workflow
// is intentionally gone; admins re-add a returning worker as a new entry.
//
// Coordinated delete order: clean availability hiddenIds → cascade
// equipment.team_members → saveRoster (last). If any cleanup step fails,
// the roster entry stays put so the admin still has a UI handle to retry.
// See PROJECT.md §7 team_roster entry for the contract.
function TeamRosterEditor() {
  const {wfRoster, setWfRoster, wfAvailability, setWfAvailability} = useWebformsConfig();
  const [busy, setBusy] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [editingId, setEditingId] = React.useState(null);
  const [editValue, setEditValue] = React.useState('');
  const [err, setErr] = React.useState('');

  // First load — fall back to loadRoster directly if context wasn't populated
  // by a prior /webform or /webformhub mount. Idempotent.
  React.useEffect(() => {
    if (wfRoster && wfRoster.length > 0) return;
    let cancelled = false;
    loadRoster(sb).then((r) => {
      if (!cancelled && Array.isArray(r) && r.length > 0) setWfRoster(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next) {
    setBusy(true);
    setErr('');
    try {
      const persisted = await saveRoster(sb, next);
      setWfRoster(persisted);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      const next = addMember(wfRoster || [], name);
      setNewName('');
      await persist(next);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    }
  }

  async function onRename(id) {
    const name = editValue.trim();
    if (!name) {
      setEditingId(null);
      return;
    }
    try {
      const next = renameMember(wfRoster || [], id, name);
      setEditingId(null);
      setEditValue('');
      await persist(next);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    }
  }

  // Coordinated delete: dependencies first, roster last.
  function onDelete(member) {
    if (!window._wcfConfirmDelete) return;
    const confirmMsg =
      `Permanently delete "${member.name}" from the team roster? They will disappear ` +
      `from every dropdown going forward. Historical reports keep their stored name.`;
    window._wcfConfirmDelete(confirmMsg, async () => {
      setBusy(true);
      setErr('');
      try {
        // Step 1: read fresh availability + equipment rows that name them.
        // equipment.team_members is jsonb; filter client-side rather than via
        // PostgREST .contains() (which mangles jsonb-array filters under
        // some supabase-js + PostgREST combinations). Equipment row count is
        // ≤20 in prod — trivial overhead.
        const freshAvailability = await loadAvailability(sb);
        const {data: allEquipment, error: eqReadErr} = await sb.from('equipment').select('id, team_members');
        if (eqReadErr) {
          throw new Error(`Read failed: ${eqReadErr.message}. Roster member NOT removed.`);
        }
        const equipmentRows = (allEquipment || []).filter(
          (r) => Array.isArray(r.team_members) && r.team_members.includes(member.name),
        );

        // Step 2: compute cleanup state.
        const cleanedAvailability = cleanAvailabilityForDeletedId(freshAvailability, member.id);

        // Step 3: persist availability cleanup BEFORE roster save.
        let persistedAvailability;
        try {
          persistedAvailability = await saveAvailability(sb, cleanedAvailability);
        } catch (e) {
          throw new Error(`Availability cleanup failed: ${e?.message || e}. Roster member NOT removed. Try again.`);
        }
        if (setWfAvailability) setWfAvailability(persistedAvailability);

        // Step 4: cascade equipment.team_members.
        for (const row of equipmentRows || []) {
          const next = (row.team_members || []).filter((m) => m !== member.name);
          const {error: eqErr} = await sb.from('equipment').update({team_members: next}).eq('id', row.id);
          if (eqErr) {
            throw new Error(
              `Equipment cleanup failed on row ${row.id}: ${eqErr.message}. ` + `Roster member NOT removed. Try again.`,
            );
          }
        }

        // Step 5: only after cleanup succeeds, save roster. Pass removedIds
        // so saveRoster's read-fresh-then-merge doesn't silently re-add
        // member.id from fresh (the entry is "fresh-only" relative to
        // post-removeMember local — without this the delete intent loses
        // to concurrent-add preservation logic).
        const nextRoster = removeMember(wfRoster || [], member.id);
        try {
          const persistedRoster = await saveRoster(sb, nextRoster, {removedIds: [member.id]});
          setWfRoster(persistedRoster);
        } catch (e) {
          throw new Error(
            `Roster save failed: ${e?.message || e}. Dependencies were cleaned but the roster ` +
              `entry remains. Try again to retry the delete.`,
          );
        }
      } catch (e) {
        setErr(e?.message ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    });
  }

  const roster = Array.isArray(wfRoster) ? wfRoster : [];

  const card = {
    background: 'white',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 16,
  };
  const chip = (bg, fg, border) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: bg,
    border: '1px solid ' + border,
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    color: fg,
    fontWeight: 500,
  });
  const ico = {background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0};

  return (
    <div style={card}>
      <div style={{fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 6}}>
        Team Members
        <span style={{fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 8}}>
          one master list · used by every webform, daily report, and weigh-in
        </span>
      </div>
      <div style={{fontSize: 12, color: '#6b7280', marginBottom: 12, lineHeight: 1.5}}>
        Every name in this list appears in every team-member dropdown unless hidden by an availability filter (below).
        Use × to permanently remove someone — historical reports keep their stored name.
      </div>

      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10}}>
        {roster.map((m) => (
          <span key={m.id} data-roster-active="1" data-roster-id={m.id} style={chip('#ecfdf5', '#065f46', '#a7f3d0')}>
            {editingId === m.id ? (
              <input
                autoFocus
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onRename(m.id);
                  if (e.key === 'Escape') {
                    setEditingId(null);
                    setEditValue('');
                  }
                }}
                onBlur={() => onRename(m.id)}
                disabled={busy}
                style={{
                  fontSize: 12,
                  padding: '0 4px',
                  border: '1px solid #6ee7b7',
                  borderRadius: 4,
                  fontFamily: 'inherit',
                  width: Math.max(80, (editValue.length + 2) * 8),
                }}
              />
            ) : (
              <>
                {m.name}
                <button
                  onClick={() => {
                    setEditingId(m.id);
                    setEditValue(m.name);
                  }}
                  disabled={busy}
                  title="Rename"
                  style={{...ico, color: '#065f46'}}
                >
                  ✏
                </button>
                <button
                  onClick={() => onDelete(m)}
                  disabled={busy}
                  title="Delete permanently"
                  data-roster-delete="1"
                  style={{...ico, color: '#b91c1c'}}
                >
                  ×
                </button>
              </>
            )}
          </span>
        ))}
        {roster.length === 0 && <span style={{fontSize: 12, color: '#9ca3af'}}>No team members yet.</span>}
      </div>

      <div style={{display: 'flex', gap: 6}}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onAdd();
          }}
          placeholder="Add team member…"
          disabled={busy}
          data-roster-add-input="1"
          style={{
            fontSize: 12,
            padding: '6px 10px',
            flex: 1,
            border: '1px solid #d1d5db',
            borderRadius: 6,
            fontFamily: 'inherit',
          }}
        />
        <button
          onClick={onAdd}
          disabled={busy || !newName.trim()}
          data-roster-add-button="1"
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            background: busy || !newName.trim() ? '#9ca3af' : '#085041',
            color: 'white',
            fontSize: 12,
            fontWeight: 600,
            cursor: busy || !newName.trim() ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Add
        </button>
      </div>

      {err && (
        <div
          style={{
            marginTop: 10,
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

// ── Team Availability per-form filters ───────────────────────────────────
// Sole writer of webform_config.team_availability. Every active roster
// member appears in every form by default; admin unchecks a member to hide
// them from a single form's dropdown without affecting others. Stable
// roster IDs are referenced — renames preserve hide state. New roster
// members default to visible everywhere.
//
// Read-fresh-then-merge inside saveAvailability mirrors the saveRoster
// pattern. Inactive entries (already filtered out by normalizeRoster) and
// orphan IDs (no longer in roster) are no-ops in availableNamesFor — the
// editor only needs to handle the live roster.
const FORM_LABELS = {
  'add-feed': 'Add Feed',
  'broiler-dailys': 'Broiler Daily Reports',
  'cattle-dailys': 'Cattle Daily Reports',
  'egg-dailys': 'Egg Daily Reports',
  'fuel-supply': 'Fuel Supply',
  'layer-dailys': 'Layer Daily Reports',
  'pig-dailys': 'Pig Daily Reports',
  'sheep-dailys': 'Sheep Daily Reports',
  'tasks-public': 'Public Tasks',
  'weigh-ins': 'Weigh-Ins',
};

function TeamAvailabilityEditor({loadUsers}) {
  const {wfRoster, wfAvailability, setWfAvailability} = useWebformsConfig();
  const {allUsers} = useAuth();

  // Hydrate allUsers when this editor mounts and the auth context's list
  // is empty. Mirrors AdminTasksView's hydration path for direct admin
  // /webforms loads (URL bar / bookmark / page reload bypasses the Header
  // → Users modal click that would otherwise populate allUsers). The
  // 'tasks-public' assignee section depends on allUsers being non-empty
  // to render any checkboxes; without this, a fresh /admin/Webforms hit
  // would show "No eligible planner users yet" until the admin clicks
  // the Header → Users option.
  React.useEffect(() => {
    if (typeof loadUsers !== 'function') return;
    if (Array.isArray(allUsers) && allUsers.length > 0) return;
    loadUsers();
    // Fire-once on mount; allUsers transitions from [] to populated once
    // the load resolves. eslint-disable to keep the deps array empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [openKey, setOpenKey] = React.useState(null);
  // Public-tasks assignee availability lives in a separate webform_config
  // key ('tasks_public_assignee_availability'). Stored shape:
  // {hiddenProfileIds: [<profile uuid>, ...]}. Roster IDs (gated above
  // via wfAvailability.forms['tasks-public'].hiddenIds) and profile UUIDs
  // (gated here) are kept in DIFFERENT keys per Codex's "do not mix" rule.
  const [publicAssigneeAv, setPublicAssigneeAv] = React.useState({hiddenProfileIds: []});

  React.useEffect(() => {
    if (wfAvailability && wfAvailability.forms && Object.keys(wfAvailability.forms).length > 0) return;
    let cancelled = false;
    loadAvailability(sb).then((a) => {
      if (!cancelled && a) setWfAvailability(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    loadPublicAssigneeAvailability(sb).then((av) => {
      if (!cancelled) setPublicAssigneeAv(av);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onToggle(formKey, id, hidden) {
    setBusy(true);
    setErr('');
    try {
      const next = setHidden(wfAvailability || {forms: {}}, formKey, id, hidden);
      const persisted = await saveAvailability(sb, next);
      setWfAvailability(persisted);
    } catch (e) {
      setErr(e?.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

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

  const roster = Array.isArray(wfRoster) ? wfRoster : [];
  const availability = wfAvailability && wfAvailability.forms ? wfAvailability : {forms: {}};

  const card = {
    background: 'white',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '14px 16px',
    marginBottom: 16,
  };
  const sectionBtn = {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 10px',
    background: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: 6,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    color: '#374151',
    marginBottom: 6,
  };
  const hiddenBadge = {
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    background: '#fef3c7',
    color: '#92400e',
  };
  const rowStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    fontSize: 12,
    color: '#374151',
    cursor: 'pointer',
  };

  return (
    <div style={card}>
      <div style={{fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 6}}>
        Team Member Availability
        <span style={{fontSize: 11, fontWeight: 400, color: '#9ca3af', marginLeft: 8}}>
          per-form filters · everyone visible by default
        </span>
      </div>
      <div style={{fontSize: 12, color: '#6b7280', marginBottom: 12, lineHeight: 1.5}}>
        Hide team members from individual form dropdowns. Master roster names and history are not changed. New members
        default to visible everywhere.
      </div>

      {TEAM_AVAILABILITY_FORM_KEYS.map((formKey) => {
        const hiddenIds = new Set(availability.forms[formKey]?.hiddenIds || []);
        const hiddenCount = hiddenIds.size;
        const isPublicTasks = formKey === 'tasks-public';
        const hiddenAssigneeIds = new Set(publicAssigneeAv.hiddenProfileIds || []);
        const hiddenAssigneeCount = isPublicTasks ? hiddenAssigneeIds.size : 0;
        const totalHiddenCount = hiddenCount + hiddenAssigneeCount;
        const isOpen = openKey === formKey;
        const eligibleProfiles = (Array.isArray(allUsers) ? allUsers : [])
          .filter((u) => u && u.id && u.role !== 'inactive')
          .slice()
          .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        return (
          <div key={formKey} data-availability-section={formKey}>
            <button
              type="button"
              onClick={() => setOpenKey(isOpen ? null : formKey)}
              data-availability-toggle={formKey}
              style={sectionBtn}
            >
              <span>
                {isOpen ? '▾' : '▸'} {FORM_LABELS[formKey]}
              </span>
              {totalHiddenCount > 0 && <span style={hiddenBadge}>{totalHiddenCount} hidden</span>}
            </button>
            {isOpen && (
              <div style={{padding: '6px 4px 12px'}}>
                {isPublicTasks && (
                  <>
                    <div
                      data-availability-default-copy="tasks-public"
                      style={{
                        fontSize: 11,
                        color: '#6b7280',
                        marginBottom: 8,
                        lineHeight: 1.5,
                        fontStyle: 'italic',
                      }}
                    >
                      New roster members and active planner users are included by default. Uncheck to hide.
                    </div>
                    <div style={{fontSize: 11, color: '#6b7280', marginBottom: 6, fontWeight: 600}}>
                      Submitted-by / Assignor (roster names)
                    </div>
                  </>
                )}
                <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
                  {roster.length === 0 ? (
                    <span style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>
                      No team members in roster yet.
                    </span>
                  ) : (
                    roster.map((m) => {
                      const isHidden = hiddenIds.has(m.id);
                      return (
                        <label
                          key={m.id}
                          data-availability-row={formKey}
                          data-availability-member={m.id}
                          data-availability-hidden={isHidden ? '1' : '0'}
                          style={rowStyle}
                        >
                          <input
                            type="checkbox"
                            checked={!isHidden}
                            disabled={busy}
                            onChange={(e) => onToggle(formKey, m.id, !e.target.checked)}
                            style={{margin: 0, accentColor: '#085041'}}
                          />
                          <span>{m.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
                {isPublicTasks && (
                  <>
                    <div style={{fontSize: 11, color: '#6b7280', margin: '12px 0 6px', fontWeight: 600}}>
                      Assignee (planner users)
                    </div>
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
                      {eligibleProfiles.length === 0 ? (
                        <span style={{fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}}>
                          No eligible planner users yet.
                        </span>
                      ) : (
                        eligibleProfiles.map((u) => {
                          const isHidden = hiddenAssigneeIds.has(u.id);
                          return (
                            <label
                              key={u.id}
                              data-availability-assignee-row="tasks-public"
                              data-availability-assignee-id={u.id}
                              data-availability-assignee-hidden={isHidden ? '1' : '0'}
                              style={rowStyle}
                            >
                              <input
                                type="checkbox"
                                checked={!isHidden}
                                disabled={busy}
                                onChange={(e) => onToggleAssignee(u.id, !e.target.checked)}
                                style={{margin: 0, accentColor: '#085041'}}
                              />
                              <span>{u.full_name || u.email || u.id.slice(0, 8)}</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}

      {err && (
        <div
          style={{
            marginTop: 10,
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
  // (5 pig-dailys-webform state props removed — that form now owns its own
  // state in src/webforms/PigDailysWebform.jsx)
  wfView,
  setWfView,
  editWfId,
  setEditWfId,
  editFieldId,
  setEditFieldId,
  wfFieldForm,
  setWfFieldForm,
  newTeamMember,
  setNewTeamMember,
  addingTo,
  setAddingTo,
  editFldLbl,
  setEditFldLbl,
  editFldVal,
  setEditFldVal,
  editSecIdx,
  setEditSecIdx,
  editSecVal,
  setEditSecVal,
  newOpt,
  setNewOpt,
}) {
  const {authState, showUsers, setShowUsers, allUsers, setAllUsers} = useAuth();
  const {webformsConfig, wfGroups, setWfGroups, wfTeamMembers, setWfTeamMembers} = useWebformsConfig();
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

  // Master team-member add/remove was retired 2026-04-29 in the team-member
  // master list cleanup. The TeamRosterEditor (rendered at the top of the
  // webforms tab) is the sole writer of the canonical roster + legacy
  // active-name mirror. webformsConfig.teamMembers is no longer read or
  // written from this view.
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
    if (!wfFieldForm.label.trim()) {
      alert('Enter a field label.');
      return;
    }
    if (wfFieldForm.type === 'button_toggle' && (!wfFieldForm.options || wfFieldForm.options.length < 2)) {
      alert('Add at least 2 button options.');
      return;
    }
    const nf = {id: 'c-' + Date.now(), ...wfFieldForm, system: false, enabled: true};
    updateSections(currentWf.sections.map((s, i) => (i !== si ? s : {...s, fields: [...s.fields, nf]})));
    setWfFieldForm({label: '', type: 'text', required: false, options: []});
    setWfView('list');
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
        ].map((t) => {
          const active = adminTab === t.id && !editWfId;
          return (
            <button
              key={t.id}
              onClick={() => {
                setAdminTab(t.id);
                setEditWfId(null);
                setWfView('list');
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
      <div
        style={{
          padding: '1rem',
          maxWidth: 720,
          margin: '0 auto',
          display: adminTab === 'equipment' || adminTab === 'fuellog' ? 'none' : 'block',
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
            {!editWfId && <TeamRosterEditor />}
            {!editWfId && <TeamAvailabilityEditor loadUsers={loadUsers} />}

            {/* ── WEIGH-INS EDITOR (per-species lists retired; no editor needed for v1) ── */}
            {editWfId && currentWf && currentWf.id === 'weighins-webform' && (
              <div>
                <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16}}>
                  <button
                    onClick={() => {
                      setEditWfId(null);
                      setWfView('list');
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
                      setWfView('list');
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
                          onClick={() => setAddingTo(addingTo === si ? null : si)}
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

                {webformsConfig.webforms.map((wf) => {
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
                            setWfView('list');
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
