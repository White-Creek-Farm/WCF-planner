import React from 'react';
import {listActivityEvents, ACTIVITY_CHANGE_EVENT} from '../lib/activityApi.js';

export default function RecordActivityLog({sb, entityType, entityId, limit = 50, eventFilter = null}) {
  const [expanded, setExpanded] = React.useState(false);
  const [events, setEvents] = React.useState([]);
  const [count, setCount] = React.useState(0);
  const filterEvents = React.useCallback(
    (rows) => {
      const auditOnly = (rows || []).filter((e) => e.event_type !== 'comment.posted');
      if (typeof eventFilter !== 'function') return auditOnly;
      return auditOnly.filter((e) => {
        try {
          return eventFilter(e);
        } catch (_e) {
          return false;
        }
      });
    },
    [eventFilter],
  );

  React.useEffect(() => {
    if (!expanded || !entityType || !entityId) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listActivityEvents(sb, entityType, entityId, {limit});
        if (cancelled) return;
        const filtered = filterEvents(rows);
        setEvents(filtered);
        setCount(filtered.filter((e) => !e.deleted_at).length);
      } catch (_e) {
        /* soft-fail */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, entityType, entityId, limit, sb, filterEvents]);

  React.useEffect(() => {
    if (!entityType || !entityId) return;
    listActivityEvents(sb, entityType, entityId, {limit}).then((rows) => {
      const filtered = filterEvents(rows);
      setCount(filtered.filter((e) => !e.deleted_at).length);
    });
  }, [entityType, entityId, limit, sb, filterEvents]);

  React.useEffect(() => {
    function onActivityChange() {
      if (!entityType || !entityId || !expanded) return;
      listActivityEvents(sb, entityType, entityId, {limit}).then((rows) => {
        const filtered = filterEvents(rows);
        setEvents(filtered);
        setCount(filtered.filter((e) => !e.deleted_at).length);
      });
    }
    window.addEventListener(ACTIVITY_CHANGE_EVENT, onActivityChange);
    return () => window.removeEventListener(ACTIVITY_CHANGE_EVENT, onActivityChange);
  }, [entityType, entityId, expanded, limit, sb, filterEvents]);

  if (!entityType || !entityId) return null;

  return (
    <div>
      <button
        type="button"
        data-activity-log-toggle="1"
        onClick={() => setExpanded((p) => !p)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          background: 'white',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
          padding: '10px 14px',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
          color: '#374151',
          fontFamily: 'inherit',
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span style={{fontSize: 10}}>{expanded ? '▼' : '▶'}</span>
        Activity log ({count})
      </button>
      {expanded && (
        <div
          data-activity-audit-log="1"
          style={{
            background: 'white',
            border: '1px solid #e5e7eb',
            borderTop: 'none',
            borderRadius: '0 0 10px 10px',
            padding: 14,
          }}
        >
          {events.length === 0 && <div style={{fontSize: 13, color: '#6b7280'}}>No audit events yet.</div>}
          {events.map((ev) => (
            <div key={ev.id} style={{padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 12}}>
              <span style={{fontWeight: 700, color: '#111827', fontSize: 13}}>
                {ev.actor_display_name || (ev.actor_profile_id ? 'Unknown user' : 'System')}
              </span>{' '}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: '#e0f2fe',
                  color: '#075985',
                }}
              >
                {ev.event_type.replace('.', ' ')}
              </span>
              {' · '}
              <span style={{color: '#6b7280'}}>
                {(() => {
                  try {
                    const d = new Date(ev.created_at);
                    const diff = (Date.now() - d.getTime()) / 1000;
                    if (diff < 60) return 'just now';
                    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
                    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
                    return d.toLocaleString();
                  } catch (_e) {
                    return ev.created_at;
                  }
                })()}
              </span>
              {ev.body && <div style={{color: '#374151', marginTop: 2}}>{ev.body}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
