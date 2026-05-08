// Task Center — Completed tab. Read-only in T4 of Tasks v2.
//
// Shows the most recent completed task_instances rows (capped at 200
// by the loader). Per row: title + designation badge, due_date,
// completed_at (Central time), assignee name, completed-by name,
// completion_note when present, and a paperclip if either single-path
// photo column is populated. Lightbox + signed-URL photo viewing is
// deferred to T7.
//
// Pure read-only: imports only from tasksCenterApi (no admin/user
// modules), calls no v2 mutation RPCs, no .insert/.update/.delete on
// task_* tables, no storage uploads. Static lock asserts each.

import React from 'react';
import {
  loadCompletedTaskInstances,
  loadEligibleProfilesById,
  attributionFor,
  photoPresenceFor,
} from '../lib/tasksCenterApi.js';
import {fmt, fmtCentralDateTime} from '../lib/dateUtils.js';

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
  margin: '4px 0 8px',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};
const BADGE_BASE = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  marginLeft: 6,
};
const BADGE_RECURRING = {...BADGE_BASE, background: '#eef2ff', color: '#3730a3'};
const BADGE_SYSTEM = {...BADGE_BASE, background: '#ecfdf5', color: '#047857'};

function nameFor(profileId, profilesById) {
  if (!profileId) return null;
  const p = profilesById[profileId];
  return p && p.full_name ? p.full_name : 'Unknown user';
}

// eslint-disable-next-line no-unused-vars -- referenced via JSX <CompletedRow .../> below
function CompletedRow({ti, profilesById}) {
  const photo = photoPresenceFor(ti);
  const attribution = attributionFor(ti);
  const assigneeName = nameFor(ti.assignee_profile_id, profilesById);
  const completedByName = nameFor(ti.completed_by_profile_id, profilesById);
  return (
    <div data-task-row={ti.id} data-task-designation={ti.designation || ''} data-task-status="completed" style={CARD}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10}}>
        <div style={{fontSize: 15, fontWeight: 600, color: '#111827', flex: 1}}>
          {ti.title}
          {ti.designation === 'recurring' && (
            <span data-task-badge="recurring" style={BADGE_RECURRING}>
              Recurring
            </span>
          )}
          {ti.designation === 'system' && (
            <span data-task-badge="system" style={BADGE_SYSTEM}>
              System
            </span>
          )}
        </div>
        <div style={{...SUB, whiteSpace: 'nowrap'}}>
          Completed:{' '}
          <span data-completed-at={ti.completed_at || ''} style={{color: '#374151'}}>
            {fmtCentralDateTime(ti.completed_at)}
          </span>
        </div>
      </div>
      <div style={{...SUB, marginTop: 4}}>
        Due <span data-due-date={ti.due_date}>{fmt(ti.due_date)}</span>
        {assigneeName && (
          <>
            {' · Assigned to '}
            <span style={{color: '#374151'}}>{assigneeName}</span>
          </>
        )}
        {completedByName && (
          <>
            {' · By '}
            <span data-completed-by-name={completedByName} style={{color: '#374151'}}>
              {completedByName}
            </span>
          </>
        )}
      </div>
      {ti.completion_note && (
        <div data-completion-note="1" style={{fontSize: 13, color: '#374151', marginTop: 6, whiteSpace: 'pre-wrap'}}>
          {ti.completion_note}
        </div>
      )}
      <div style={{display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 6}}>
        {attribution && (
          <span style={SUB} data-task-attribution-label={attribution.label}>
            {attribution.label}: <span style={{color: '#374151'}}>{attribution.name}</span>
          </span>
        )}
        {(photo.hasRequest || photo.hasCompletion) && (
          <span
            style={SUB}
            data-task-has-photo="1"
            title="Task has at least one photo"
            aria-label="Task has at least one photo"
          >
            📎
          </span>
        )}
      </div>
    </div>
  );
}

export default function CompletedTab({sb}) {
  const [rows, setRows] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      try {
        const [list, profMap] = await Promise.all([loadCompletedTaskInstances(sb), loadEligibleProfilesById(sb)]);
        if (!cancelled) {
          setRows(list);
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

  return (
    <div data-tasks-tab="completed">
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
          <div style={SECTION_HEADER}>Completed tasks ({rows.length})</div>
          {rows.length === 0 ? (
            <div style={CARD}>
              <div style={{fontSize: 13, color: '#374151'}}>No completed tasks yet.</div>
            </div>
          ) : (
            rows.map((ti) => <CompletedRow key={ti.id} ti={ti} profilesById={profiles} />)
          )}
        </>
      )}
    </div>
  );
}
