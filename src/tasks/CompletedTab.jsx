// Task Center — Completed tab. Read-only in Tasks v2.
//
// Layout (Codex 2026-05-13 Operator Clarity remaining-tabs pass):
//   Filter chip bar:   All / Recurring / System / With photos / With notes.
//                      Pure client-side filter on the loaded list. No data
//                      shape change. Counts in the section header reflect
//                      the active chip.
//
//   Date buckets:      Today / Last 7 days / Older — grouped by
//                      completed_at against today's Central date so
//                      operators can scan recent activity without
//                      counting back through dates manually. Empty
//                      buckets are skipped at render time so the page
//                      stays calm when, e.g., nothing was completed
//                      today yet.
//
// Pure read-only: imports only from tasksCenterApi, calls no v2
// mutation RPCs, no .insert/.update/.delete on task_* tables, no
// storage uploads. Static lock asserts each.

import React from 'react';
import {useNavigate} from 'react-router-dom';
import {recordSeqNavOptions, labeledSeqItems} from '../lib/recordSequence.js';
import {
  loadCompletedTaskInstances,
  loadEligibleProfilesById,
  attributionFor,
  photoPresenceFor,
} from '../lib/tasksCenterApi.js';
import {TASK_CHANGE_EVENT} from '../lib/tasksCenterMutationsApi.js';
import {fmt, fmtCentralDateTime, todayCentralISO, centralISOFor} from '../lib/dateUtils.js';
import TaskPhotoLightbox from './TaskPhotoLightbox.jsx';

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
const BUCKET_HEADER = {
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
const BUCKET_DOT_TODAY = {
  display: 'inline-block',
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#10b981',
};
const BUCKET_DOT_WEEK = {...BUCKET_DOT_TODAY, background: '#3b82f6'};
const BUCKET_DOT_OLDER = {...BUCKET_DOT_TODAY, background: '#9ca3af'};
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

const FILTER_BAR = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 6,
};
const FILTER_CHIP_BASE = {
  padding: '5px 12px',
  borderRadius: 999,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#4b5563',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const FILTER_CHIP_ACTIVE = {
  ...FILTER_CHIP_BASE,
  background: '#085041',
  border: '1px solid #085041',
  color: 'white',
};

const FILTERS = [
  {key: 'all', label: 'All'},
  {key: 'recurring', label: 'Recurring'},
  {key: 'system', label: 'System'},
  {key: 'photos', label: 'With photos'},
  {key: 'notes', label: 'With notes'},
];

function nameFor(profileId, profilesById) {
  if (!profileId) return null;
  const p = profilesById[profileId];
  return p && p.full_name ? p.full_name : 'Unknown user';
}

// Filter predicate. Mirrors MyTasksTab's pattern so the two tabs feel
// consistent. Each predicate inspects the loaded row only; no DB roundtrip.
function matchesCompletedFilter(ti, filter) {
  if (filter === 'all') return true;
  if (filter === 'recurring') return ti.designation === 'recurring';
  if (filter === 'system') return ti.designation === 'system';
  if (filter === 'photos') {
    const p = photoPresenceFor(ti);
    return p.hasRequest || p.hasCompletion;
  }
  if (filter === 'notes') return !!(ti.completion_note && String(ti.completion_note).trim());
  return true;
}

// Bucket by completed_at against today's Central date. "Today" is the
// calendar day in America/Chicago; "Last 7 days" is the prior six full
// Central calendar days; everything older falls into "Older". Rows
// missing completed_at land in "Older" (rare — completed rows should
// always carry it, but the lock is defensive).
//
// Codex 2026-05-14 hotfix: every comparison runs against the Central
// YYYY-MM-DD of the row's timestamp via `centralISOFor`, not the raw
// UTC slice. A 9:00 PM Central completion is 2:00 UTC the next
// calendar day; UTC-slicing would silently push it into the next
// bucket and contradict the section labels which are Central.
function bucketByCompletedAt(rows, todayStr) {
  const today = [];
  const lastWeek = [];
  const older = [];
  if (!todayStr) return {today, lastWeek, older};
  // Six prior Central calendar dates. Anchor on the Central YMD itself
  // (treated as UTC noon for arithmetic — the noon anchor avoids
  // any DST-flip edge case and the integer-day arithmetic is exact).
  const anchor = new Date(todayStr + 'T12:00:00Z');
  const sixDaysAgoYMD = new Date(anchor.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const ti of rows || []) {
    if (!ti.completed_at) {
      older.push(ti);
      continue;
    }
    const atYMD = centralISOFor(ti.completed_at);
    if (!atYMD) {
      older.push(ti);
      continue;
    }
    if (atYMD === todayStr) today.push(ti);
    else if (atYMD >= sixDaysAgoYMD && atYMD < todayStr) lastWeek.push(ti);
    else older.push(ti);
  }
  return {today, lastWeek, older};
}

const PHOTO_LINK_BTN = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontSize: 36,
  lineHeight: 1,
  color: '#6b7280',
  fontFamily: 'inherit',
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

// eslint-disable-next-line no-unused-vars -- referenced via JSX <CompletedRow .../> below
function CompletedRow({ti, profilesById, onOpenPhotos, onNavigate}) {
  const photo = photoPresenceFor(ti);
  const attribution = attributionFor(ti);
  const assigneeName = nameFor(ti.assignee_profile_id, profilesById);
  const completedByName = nameFor(ti.completed_by_profile_id, profilesById);
  return (
    <div data-task-row={ti.id} data-task-designation={ti.designation || ''} data-task-status="completed" style={CARD}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: '#111827',
            flex: '1 1 200px',
            minWidth: 0,
            wordBreak: 'break-word',
          }}
        >
          <span
            role="link"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              if (onNavigate) onNavigate(ti);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onNavigate) onNavigate(ti);
            }}
            style={{cursor: 'pointer', color: '#1d4ed8', textDecoration: 'none'}}
          >
            {ti.title}
          </span>
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
      {attribution && (
        <div style={{...SUB, marginTop: 4}} data-task-attribution-label={attribution.label}>
          {attribution.label}: <span style={{color: '#374151'}}>{attribution.name}</span>
        </div>
      )}
      {(photo.hasRequest || photo.hasCompletion) && (
        <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 6}}>
          <button
            type="button"
            data-task-has-photo="1"
            data-task-photo-open="1"
            onClick={() => onOpenPhotos && onOpenPhotos(ti)}
            title="Task has at least one photo"
            aria-label="Task has at least one photo"
            style={PHOTO_LINK_BTN}
          >
            📎
          </button>
        </div>
      )}
    </div>
  );
}

export default function CompletedTab({sb, authState}) {
  const navigate = useNavigate();
  const [rows, setRows] = React.useState([]);
  const [profiles, setProfiles] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [filter, setFilter] = React.useState('all');
  const [photoTaskTarget, setPhotoTaskTarget] = React.useState(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setErr('');
      setLoading(true);
      try {
        const [list, profMap] = await Promise.all([loadCompletedTaskInstances(sb), loadEligibleProfilesById(sb)]);
        if (!cancelled) {
          setRows(list);
          setProfiles(profMap);
        }
      } catch (e) {
        if (!cancelled) {
          setRows([]);
          setProfiles({});
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

  // A completion in MyTasksTab fires TASK_CHANGE_EVENT; refresh so the
  // newly-completed row appears at the top of this tab without waiting
  // for navigation.
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

  const todayStr = todayCentralISO();
  const visibleRows = React.useMemo(() => rows.filter((ti) => matchesCompletedFilter(ti, filter)), [rows, filter]);
  const buckets = React.useMemo(() => bucketByCompletedAt(visibleRows, todayStr), [visibleRows, todayStr]);
  // Combined visible/rendered order for record sequence nav (today → last 7 → older).
  const taskSeqRows = [...(buckets.today || []), ...(buckets.lastWeek || []), ...(buckets.older || [])];

  function renderBucket(bucketKey, label, dotStyle, bucketRows) {
    if (!bucketRows || bucketRows.length === 0) return null;
    return (
      <div data-tasks-completed-bucket={bucketKey} data-tasks-completed-bucket-count={bucketRows.length}>
        <div style={BUCKET_HEADER}>
          <span style={dotStyle} aria-hidden="true" />
          {label} ({bucketRows.length})
        </div>
        {bucketRows.map((ti) => (
          <CompletedRow
            key={ti.id}
            ti={ti}
            profilesById={profiles}
            onOpenPhotos={setPhotoTaskTarget}
            onNavigate={(t) => navigate('/tasks/' + t.id, recordSeqNavOptions(labeledSeqItems(taskSeqRows, 'title')))}
          />
        ))}
      </div>
    );
  }

  const loadFailed = !!err;

  return (
    <div data-tasks-tab="completed" data-tasks-completed-loaded={loading || loadFailed ? 'false' : 'true'}>
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
          data-tasks-load-retry="completed"
          onClick={() => setReloadKey((k) => k + 1)}
          style={LOAD_RETRY_BTN}
        >
          Retry
        </button>
      )}
      {loading ? (
        <div style={SUB}>Loading…</div>
      ) : loadFailed ? null : (
        <>
          {/* Pressable toggle group — not a tablist. role="group" matches the
              segmented filter pattern locked in MyTasksTab. */}
          <div data-tasks-filter-bar="1" style={FILTER_BAR} role="group" aria-label="Completed filter">
            {FILTERS.map((f) => {
              const active = filter === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  data-tasks-filter-chip={f.key}
                  data-tasks-filter-active={active ? '1' : '0'}
                  aria-pressed={active}
                  onClick={() => setFilter(f.key)}
                  style={active ? FILTER_CHIP_ACTIVE : FILTER_CHIP_BASE}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <div style={SECTION_HEADER}>Completed tasks ({visibleRows.length})</div>
          {visibleRows.length === 0 ? (
            <div style={CARD}>
              <div style={{fontSize: 13, color: '#374151'}}>
                {filter === 'all'
                  ? 'No completed tasks yet.'
                  : 'No matches for the active filter. Try the All chip to see every completed task.'}
              </div>
            </div>
          ) : (
            <>
              {renderBucket('today', 'Today', BUCKET_DOT_TODAY, buckets.today)}
              {renderBucket('last-7-days', 'Last 7 days', BUCKET_DOT_WEEK, buckets.lastWeek)}
              {renderBucket('older', 'Older', BUCKET_DOT_OLDER, buckets.older)}
            </>
          )}
        </>
      )}
      {React.createElement(TaskPhotoLightbox, {
        sb,
        task: photoTaskTarget,
        isOpen: !!photoTaskTarget,
        onClose: () => setPhotoTaskTarget(null),
      })}
    </div>
  );
}
