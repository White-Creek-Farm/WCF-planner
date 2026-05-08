// Task Center — Recurring tab. Read-only in T4 of Tasks v2.
//
// Lists recurring task_templates (active first, alphabetical) as
// collapsible cards. Each card shows recurrence + interval + first
// due date + active/inactive state + open-instance count. Expanding
// a card reveals the open task_instances generated from that
// template (designation='recurring', status='open'). Orphan
// instances (designation='recurring' but template_id is NULL —
// possible after the parent template was deleted via the
// SET NULL FK in mig 050) are grouped at the bottom under
// "Orphaned recurring tasks".
//
// Pure read-only: imports only from tasksCenterApi (no admin/user
// modules), calls no v2 mutation RPCs, no .insert/.update/.delete
// on task_* tables, no storage uploads, no edit/delete affordances.
// Static lock asserts each.

import React from 'react';
import {
  loadRecurringTaskTemplates,
  loadOpenRecurringInstances,
  loadEligibleProfilesById,
  groupRecurringByTemplate,
} from '../lib/tasksCenterApi.js';
import {fmt} from '../lib/dateUtils.js';

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
      }}
    >
      <div style={{fontSize: 13, color: '#111827', fontWeight: 500}}>{ti.title}</div>
      <div style={{...SUB, whiteSpace: 'nowrap'}}>
        Due <span data-due-date={ti.due_date}>{fmt(ti.due_date)}</span>
      </div>
    </div>
  );
}

export default function RecurringTab({sb}) {
  const [templates, setTemplates] = React.useState([]);
  const [openInstances, setOpenInstances] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [expanded, setExpanded] = React.useState({});

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      try {
        const [tpls, opens, profMap] = await Promise.all([
          loadRecurringTaskTemplates(sb),
          loadOpenRecurringInstances(sb),
          loadEligibleProfilesById(sb),
        ]);
        if (!cancelled) {
          setTemplates(tpls);
          setOpenInstances(opens);
          setProfiles(profMap);
        }
      } catch (e) {
        if (!cancelled) setErr(e && e.message ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb]);

  const grouped = groupRecurringByTemplate(templates, openInstances);

  function toggle(key) {
    setExpanded((prev) => ({...prev, [key]: !prev[key]}));
  }

  return (
    <div data-tasks-tab="recurring">
      {err && (
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
      {loading ? (
        <div style={SUB}>Loading…</div>
      ) : (
        <>
          <div style={SECTION_HEADER}>Recurring templates ({grouped.templates.length})</div>
          {grouped.templates.length === 0 ? (
            <div style={CARD}>
              <div style={{fontSize: 13, color: '#374151'}}>No recurring templates configured.</div>
            </div>
          ) : (
            grouped.templates.map((b) => {
              const key = b.template.id;
              const isOpen = !!expanded[key];
              const assigneeName = nameFor(b.template.assignee_profile_id, profiles);
              return (
                <div key={key} data-recurring-template={key}>
                  <button type="button" onClick={() => toggle(key)} style={GROUP_HEADER}>
                    <div style={{display: 'flex', flexDirection: 'column', gap: 2, flex: 1}}>
                      <div style={{fontSize: 14, fontWeight: 600, color: '#111827'}}>
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
                      {b.instances.length === 0 ? (
                        <div style={{...SUB, padding: '4px 8px'}}>No open instances.</div>
                      ) : (
                        b.instances.map((ti) => <InstanceLine key={ti.id} ti={ti} />)
                      )}
                    </div>
                  )}
                </div>
              );
            })
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
    </div>
  );
}
