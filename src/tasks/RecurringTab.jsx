// Task Center — Recurring tab. Tasks v2.
//
// Lists recurring task_templates as collapsible cards. Each card shows
// recurrence + interval + first due date + active/inactive state +
// open-instance count. Expanding a card reveals the open
// task_instances generated from that template (designation='recurring',
// status='open'). Orphan instances (designation='recurring' but
// template_id is NULL — possible after the parent template was deleted
// via the SET NULL FK in mig 050) are grouped at the bottom under
// "Orphaned recurring tasks".
//
// Layout (Codex 2026-05-13 Operator Clarity remaining-tabs pass):
//
//   Active templates (N): templates with active=true. Conservative
//                         pre-expand — templates with ≥1 open instance
//                         expand by default so operators see what's
//                         outstanding without an extra click. Templates
//                         with zero opens stay collapsed.
//
//   Inactive templates (N): templates with active=false. The entire
//                           sub-section collapses by default behind a
//                           toggle; clicking the toggle reveals the
//                           inactive list. Per-template expand state
//                           still follows the same conservative
//                           pre-expand rule once the sub-section is open.
//
//   Orphaned recurring tasks (N): unchanged. Surfaces only when present.
//
// Reads stay open to every authenticated user (transparency RLS);
// admin write controls are gated by isAdmin:
//   - + New Template button (T9) — admin-only.
//   - Edit / Delete buttons inside each expanded template card — admin-only.
//   - Template delete uses an inline typed-confirmation modal (no
//     window.confirm, per Codex T9 lock). Existing instances stay
//     alive via mig 050's ON DELETE SET NULL and surface in the
//     Orphaned recurring tasks group.
//
// All DB writes route through tasksCenterMutationsApi wrappers; the
// component never calls .insert/.update/.delete on task_* tables
// directly. Static lock asserts admin-gating + wrapper boundary.

import React from 'react';
import {
  loadRecurringTaskTemplates,
  loadOpenRecurringInstances,
  loadEligibleProfilesById,
  loadTaskAssignableProfilesById,
  groupRecurringByTemplate,
} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT, fireTaskChangeEvent, deleteRecurringTaskTemplate} from '../lib/tasksCenterMutationsApi.js';
import {fmt} from '../lib/dateUtils.js';
import RecurringTemplateModal from './RecurringTemplateModal.jsx';

const CARD = {
  background: 'white',
  borderRadius: 10,
  padding: '12px 14px',
  marginBottom: 10,
  boxShadow: '0 1px 3px rgba(0,0,0,.06)',
  border: '1px solid #e5e7eb',
};
const SUB = {fontSize: 12, color: '#6b7280'};
const SECTION_HEADER = {
  fontSize: 13,
  fontWeight: 700,
  color: '#374151',
  margin: '14px 0 8px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const SUBSECTION_HEADER = {
  fontSize: 12,
  fontWeight: 700,
  color: '#4b5563',
  margin: '10px 0 6px',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const SUBSECTION_DOT_ACTIVE = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#10b981',
};
const INACTIVE_TOGGLE_BTN = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 10px',
  borderRadius: 8,
  border: '1px solid #e5e7eb',
  background: '#f9fafb',
  color: '#374151',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 700,
  textAlign: 'left',
  marginTop: 6,
  marginBottom: 6,
};
const LOAD_RETRY_BTN = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #991b1b',
  background: 'white',
  color: '#991b1b',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
  fontFamily: 'inherit',
  marginBottom: 12,
};
const GROUP_HEADER = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: '8px 12px',
  marginBottom: 8,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontFamily: 'inherit',
  width: '100%',
  textAlign: 'left',
};
const PILL_BASE = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const PILL_ACTIVE = {...PILL_BASE, background: '#ecfdf5', color: '#047857'};
const PILL_INACTIVE = {...PILL_BASE, background: '#f3f4f6', color: '#374151'};

function nameFor(profileId, profilesById) {
  if (!profileId) return null;
  const p = profilesById[profileId];
  return p && p.full_name ? p.full_name : 'Unknown user';
}

function recurrenceLabel(template) {
  const r = template && template.recurrence;
  const n = template && template.recurrence_interval ? template.recurrence_interval : 1;
  if (!r) return '—';
  if (r === 'once') return 'Once';
  if (r === 'daily') return n === 1 ? 'Daily' : `Every ${n} days`;
  if (r === 'weekly') return n === 1 ? 'Weekly' : `Every ${n} weeks`;
  if (r === 'biweekly') return 'Every 2 weeks';
  if (r === 'monthly') return n === 1 ? 'Monthly' : `Every ${n} months`;
  return r;
}

// eslint-disable-next-line no-unused-vars -- referenced via JSX <InstanceLine .../> below
function InstanceLine({ti}) {
  return (
    <div
      data-task-row={ti.id}
      data-task-designation={ti.designation || ''}
      style={{
        background: '#f9fafb',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        padding: '8px 12px',
        marginBottom: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <div style={{fontSize: 13, color: '#111827', fontWeight: 500, flex: '1 1 200px', minWidth: 0}}>{ti.title}</div>
      <div style={{...SUB, whiteSpace: 'nowrap'}}>
        Due <span data-due-date={ti.due_date}>{fmt(ti.due_date)}</span>
      </div>
    </div>
  );
}

// T9: typed-confirmation modal for template delete. Inline because the
// task-instance DeleteTaskModal targets task_instances; templates use a
// different wrapper. No window.confirm — Codex T9 lock.
function DeleteTemplateConfirm({sb, template, isOpen, onClose, onDeleted}) {
  const [typed, setTyped] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState('');
  React.useEffect(() => {
    if (!isOpen) {
      setTyped('');
      setSaving(false);
      setErr('');
    }
  }, [isOpen]);
  if (!isOpen || !template) return null;
  const confirmed = typed.trim().toUpperCase() === 'DELETE';
  async function go() {
    if (saving || !confirmed) return;
    setSaving(true);
    try {
      await deleteRecurringTaskTemplate(sb, template.id);
      if (onDeleted) onDeleted(template.id);
      if (onClose) onClose();
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
      setSaving(false);
    }
  }
  return (
    <div
      data-delete-template-modal="1"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.5)',
        zIndex: 250,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={() => onClose && onClose()}
    >
      <div
        style={{background: 'white', borderRadius: 12, padding: 18, width: 'min(480px, 96vw)', fontFamily: 'inherit'}}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{fontSize: 18, margin: 0, color: '#111827', marginBottom: 8}}>Delete Recurring Template</h2>
        <div style={{fontSize: 13, color: '#374151', marginBottom: 12}}>
          This deletes the template <span style={{fontWeight: 600, color: '#111827'}}>{template.title}</span>. Existing
          instances stay alive — they move to the Orphaned recurring tasks group.
        </div>
        <label style={{fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4, display: 'block'}}>
          Type DELETE to confirm
        </label>
        <input
          data-delete-template-field="confirm"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          style={{
            width: '100%',
            padding: '8px 10px',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 14,
            fontFamily: 'inherit',
            boxSizing: 'border-box',
          }}
        />
        {err && (
          <div
            data-delete-template-error="1"
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              color: '#991b1b',
              padding: '8px 12px',
              borderRadius: 8,
              marginTop: 12,
              fontSize: 13,
            }}
          >
            {err}
          </div>
        )}
        <div style={{display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14}}>
          <button
            type="button"
            onClick={() => onClose && onClose()}
            disabled={saving}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 500,
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            data-delete-template-save="1"
            onClick={go}
            disabled={saving || !confirmed}
            style={{
              padding: '8px 14px',
              borderRadius: 8,
              border: '1px solid #b91c1c',
              background: '#b91c1c',
              color: 'white',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            {saving ? 'Deleting…' : 'Delete Permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RecurringTab({sb, authState}) {
  const isAdmin = authState && authState.role === 'admin';
  const [templates, setTemplates] = React.useState([]);
  const [openInstances, setOpenInstances] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [assignableProfiles, setAssignableProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  // Manual per-template expand overrides. Empty by default; falls back to
  // the openCount-based auto-expand rule below.
  const [expandedOverride, setExpandedOverride] = React.useState({});
  // Whole inactive sub-section toggle. Collapsed by default — inactive
  // templates rarely need scanning and shouldn't dominate the page.
  const [showInactive, setShowInactive] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState(null); // null | template | 'new'
  const [deleteTarget, setDeleteTarget] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      setLoading(true);
      try {
        const [tpls, opens, profMap, assignableMap] = await Promise.all([
          loadRecurringTaskTemplates(sb),
          loadOpenRecurringInstances(sb),
          loadEligibleProfilesById(sb),
          loadTaskAssignableProfilesById(sb),
        ]);
        if (!cancelled) {
          setTemplates(tpls);
          setOpenInstances(opens);
          setProfiles(profMap);
          setAssignableProfiles(assignableMap);
        }
      } catch (e) {
        if (!cancelled) {
          setTemplates([]);
          setOpenInstances([]);
          setProfiles({});
          setAssignableProfiles({});
          setExpandedOverride({});
          setShowInactive(false);
          setErr(e && e.message ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, reloadKey]);

  React.useEffect(() => {
    function onChange() {
      setReloadKey((k) => k + 1);
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener(TASK_CHANGE_EVENT, onChange);
    }
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener(TASK_CHANGE_EVENT, onChange);
      }
    };
  }, []);

  const loadFailed = !!err;
  const grouped = groupRecurringByTemplate(templates, openInstances);
  const activeBuckets = grouped.templates.filter((b) => b.template.active);
  const inactiveBuckets = grouped.templates.filter((b) => !b.template.active);

  // Conservative pre-expand: templates with ≥1 open instance expand by
  // default so operators see what's outstanding. Templates with zero
  // opens stay collapsed (no work to scan). Manual toggle in
  // expandedOverride wins over the default.
  function isTemplateOpen(b) {
    const key = b.template.id;
    if (Object.prototype.hasOwnProperty.call(expandedOverride, key)) return !!expandedOverride[key];
    return b.openCount >= 1;
  }
  function toggle(b) {
    const key = b.template.id;
    const current = isTemplateOpen(b);
    setExpandedOverride((prev) => ({...prev, [key]: !current}));
  }
  function startNew() {
    setEditTarget('new');
  }
  function startEdit(tpl) {
    setEditTarget(tpl);
  }
  function startDelete(tpl) {
    setDeleteTarget(tpl);
  }

  function renderTemplateCard(b) {
    const key = b.template.id;
    const isOpen = isTemplateOpen(b);
    const assigneeName = nameFor(b.template.assignee_profile_id, profiles);
    return (
      <div key={key} data-recurring-template={key}>
        <button type="button" onClick={() => toggle(b)} style={GROUP_HEADER}>
          <div style={{display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0}}>
            <div style={{fontSize: 14, fontWeight: 600, color: '#111827', wordBreak: 'break-word'}}>
              {b.template.title}
              {b.template.active ? (
                <span data-template-state="active" style={PILL_ACTIVE}>
                  Active
                </span>
              ) : (
                <span data-template-state="inactive" style={PILL_INACTIVE}>
                  Inactive
                </span>
              )}
            </div>
            <div style={SUB}>
              {recurrenceLabel(b.template)}
              {assigneeName && <> · {assigneeName}</>}
              {b.template.first_due_date && <> · First due {fmt(b.template.first_due_date)}</>}
              {' · '}
              <span data-template-open-count={b.openCount}>{b.openCount}</span> open
            </div>
          </div>
          <span
            data-tasks-group-state={isOpen ? 'expanded' : 'collapsed'}
            style={{fontSize: 13, color: '#6b7280', marginLeft: 8}}
          >
            {isOpen ? '▾' : '▸'}
          </span>
        </button>
        {isOpen && (
          <div data-recurring-template-body={key} style={{paddingLeft: 8, marginBottom: 8}}>
            {isAdmin && (
              <div style={{display: 'flex', gap: 6, padding: '4px 8px 8px'}}>
                <button
                  type="button"
                  data-recurring-edit-button={key}
                  onClick={() => startEdit(b.template)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid #d1d5db',
                    background: 'white',
                    color: '#374151',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 500,
                    fontFamily: 'inherit',
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  data-recurring-delete-button={key}
                  onClick={() => startDelete(b.template)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: '1px solid #b91c1c',
                    background: 'white',
                    color: '#b91c1c',
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'inherit',
                  }}
                >
                  Delete
                </button>
              </div>
            )}
            {b.instances.length === 0 ? (
              <div style={{...SUB, padding: '4px 8px'}}>No open instances.</div>
            ) : (
              b.instances.map((ti) => <InstanceLine key={ti.id} ti={ti} />)
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div data-tasks-tab="recurring" data-tasks-recurring-loaded={loading || loadFailed ? 'false' : 'true'}>
      {loadFailed && (
        <div
          data-tasks-error="1"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            color: '#991b1b',
            padding: '8px 12px',
            borderRadius: 8,
            marginBottom: 12,
            fontSize: 13,
          }}
        >
          {err}
        </div>
      )}
      {loadFailed && (
        <button
          type="button"
          data-tasks-load-retry="recurring"
          onClick={() => setReloadKey((k) => k + 1)}
          style={LOAD_RETRY_BTN}
        >
          Retry
        </button>
      )}
      {isAdmin && !loadFailed && (
        <div style={{display: 'flex', justifyContent: 'flex-end', marginBottom: 6}}>
          <button
            type="button"
            data-recurring-new-button="1"
            onClick={startNew}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid #085041',
              background: '#085041',
              color: 'white',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              fontFamily: 'inherit',
            }}
          >
            + New Template
          </button>
        </div>
      )}

      {loading ? (
        <div style={SUB}>Loading…</div>
      ) : loadFailed ? null : (
        <>
          <div style={SECTION_HEADER}>Recurring templates ({grouped.templates.length})</div>

          {grouped.templates.length === 0 ? (
            <div style={CARD}>
              <div style={{fontSize: 13, color: '#374151'}}>No recurring templates configured.</div>
            </div>
          ) : (
            <>
              <div data-recurring-section="active">
                <div style={SUBSECTION_HEADER}>
                  <span style={SUBSECTION_DOT_ACTIVE} aria-hidden="true" />
                  Active templates ({activeBuckets.length})
                </div>
                {activeBuckets.length === 0 ? (
                  <div style={CARD}>
                    <div style={{fontSize: 13, color: '#374151'}}>No active templates.</div>
                  </div>
                ) : (
                  activeBuckets.map(renderTemplateCard)
                )}
              </div>

              {inactiveBuckets.length > 0 && (
                <div data-recurring-section="inactive">
                  <button
                    type="button"
                    data-recurring-inactive-toggle="1"
                    data-recurring-inactive-state={showInactive ? 'expanded' : 'collapsed'}
                    onClick={() => setShowInactive((v) => !v)}
                    style={INACTIVE_TOGGLE_BTN}
                  >
                    <span style={{fontSize: 13, color: '#6b7280'}}>{showInactive ? '▾' : '▸'}</span>
                    Inactive templates ({inactiveBuckets.length})
                  </button>
                  {showInactive && <div style={{marginTop: 8}}>{inactiveBuckets.map(renderTemplateCard)}</div>}
                </div>
              )}
            </>
          )}

          {grouped.orphans.length > 0 && (
            <div data-recurring-orphans="1" style={{marginTop: 18}}>
              <div style={SECTION_HEADER}>Orphaned recurring tasks ({grouped.orphans.length})</div>
              <div style={CARD}>
                <div style={{...SUB, marginBottom: 8}}>
                  These recurring instances exist but their parent template has been deleted. They remain assignable and
                  completable through the My Tasks tab.
                </div>
                {grouped.orphans.map((ti) => (
                  <InstanceLine key={ti.id} ti={ti} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {React.createElement(RecurringTemplateModal, {
        sb,
        isOpen: editTarget !== null,
        template: editTarget && editTarget !== 'new' ? editTarget : null,
        authState,
        // Recurring template assignee dropdown uses the filtered map.
        profilesById: assignableProfiles,
        onClose: () => setEditTarget(null),
        onSaved: () => {
          setEditTarget(null);
          fireTaskChangeEvent();
          setReloadKey((k) => k + 1);
        },
      })}
      {React.createElement(DeleteTemplateConfirm, {
        sb,
        template: deleteTarget,
        isOpen: !!deleteTarget,
        onClose: () => setDeleteTarget(null),
        onDeleted: () => {
          setDeleteTarget(null);
          fireTaskChangeEvent();
          setReloadKey((k) => k + 1);
        },
      })}
    </div>
  );
}
