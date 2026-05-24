// ActivityPanel — the one reusable activity + comment + @mention UI for
// every operational record across WCF.
//
// Modes:
//   "compact"  → a chip + count for dense list rows. Click opens the
//                full panel in a modal (caller passes onCompactClick to
//                wire that — keeps the panel itself layout-agnostic).
//   "full"     → comment box on top, chronological event list below.
//                Use inside detail surfaces, modals, drawers.
//
// Props:
//   sb               supabase client
//   authState        from useAuth() — caller passes through
//   entityType       e.g. 'task.instance' (must be a key in
//                    activityRegistry; renders a clear empty state on
//                    unknown types)
//   entityId         the entity's stable id
//   entityLabel      human label used in notification titles + panel
//                    header. Defaults to entityId if absent.
//   entityCtx        optional bag passed to registry.displayLabel
//   entityRoute      optional route override for compact-mode click
//   mode             "compact" | "full"   (default "full")
//   onCompactClick   compact-mode caller-supplied click handler (e.g. to
//                    open a modal containing <ActivityPanel mode="full">)
//   refreshKey       bump to force reload after parent mutates the entity
//
// SECURITY NOTE: every read + write goes through SECDEF RPCs from
// mig 058. Direct table SELECT/INSERT is unreachable (REVOKE ALL from
// authenticated). The static lock asserts no .from('activity_events')
// or .from('activity_mentions') appears anywhere in src/.
import React from 'react';
import {
  listActivityEvents,
  countActivityForEntity,
  postActivityComment,
  deleteActivityEvent,
  renderMentionSegments,
  ACTIVITY_CHANGE_EVENT,
} from '../lib/activityApi.js';
import {getActivityEntityMeta} from '../lib/activityRegistry.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import MentionTextarea from './MentionTextarea.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from './InlineNotice.jsx';

const PANEL_WRAP = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: 14,
  fontFamily: 'inherit',
};
const PANEL_HEADER = {
  fontSize: 11,
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const COMPACT_CHIP = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  fontSize: 11,
  fontWeight: 600,
  color: '#4b5563',
  background: '#f3f4f6',
  border: '1px solid #e5e7eb',
  borderRadius: 999,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const COMPACT_CHIP_HOT = {
  ...COMPACT_CHIP,
  background: '#ecfdf5',
  color: '#085041',
  borderColor: '#a7f3d0',
};

const POST_BTN = {
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const POST_BTN_DISABLED = {
  ...POST_BTN,
  background: '#9ca3af',
  borderColor: '#9ca3af',
  cursor: 'not-allowed',
};

const EVENT_ROW = {
  padding: '10px 0',
  borderBottom: '1px solid #f3f4f6',
};
const EVENT_HEAD = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  fontSize: 12,
  color: '#6b7280',
};
const EVENT_ACTOR = {
  fontSize: 12.5,
  fontWeight: 700,
  color: '#111827',
};
const EVENT_BODY = {
  fontSize: 13,
  color: '#111827',
  marginTop: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.45,
};
const EVENT_SYSTEM_BADGE = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '1px 6px',
  borderRadius: 4,
  background: '#e0f2fe',
  color: '#075985',
};
const MENTION_CHIP = {
  display: 'inline-block',
  padding: '0 4px',
  borderRadius: 4,
  background: '#fef3c7',
  color: '#92400e',
  fontWeight: 600,
};

function fmtRelative(iso) {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleString();
  } catch (_e) {
    return iso || '';
  }
}

function renderEventBody(body, mentionedProfileNames, mentionedProfileIds) {
  const segs = renderMentionSegments(body || '', mentionedProfileNames || [], mentionedProfileIds || []);
  if (segs.length === 0) return null;
  return segs.map((s, i) =>
    s.type === 'mention' ? (
      <span key={i} data-mention-profile-id={s.profileId || ''} style={MENTION_CHIP}>
        @{s.display}
      </span>
    ) : (
      <span key={i}>{s.text}</span>
    ),
  );
}

function eventTypeLabel(t) {
  if (t === 'comment.posted') return null; // bare comment, no badge
  if (t === 'task.completed') return 'COMPLETED';
  return t.toUpperCase();
}

export default function ActivityPanel({
  sb,
  authState,
  entityType,
  entityId,
  entityLabel,
  entityCtx,
  entityRoute,
  mode = 'full',
  onCompactClick,
  refreshKey,
}) {
  const meta = getActivityEntityMeta(entityType);
  const resolvedLabel = (() => {
    if (entityLabel) return entityLabel;
    if (meta && typeof meta.displayLabel === 'function') {
      try {
        return meta.displayLabel(entityId, entityCtx);
      } catch (_e) {
        /* fall through */
      }
    }
    return entityId;
  })();
  const callerProfileId = authState && authState.user ? authState.user.id : null;

  const [events, setEvents] = React.useState([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [notice, setNotice] = React.useState(null);
  const [draft, setDraft] = React.useState({body: '', mentions: []});

  const canUse = !!meta && !!entityId && !!sb;

  const refresh = React.useCallback(async () => {
    if (!canUse) {
      setEvents([]);
      setCount(0);
      return;
    }
    setLoading(true);
    try {
      if (mode === 'compact') {
        // Lazy: compact mode only needs the count, not the list.
        const n = await countActivityForEntity(sb, entityType, entityId);
        setCount(n);
      } else {
        const rows = await listActivityEvents(sb, entityType, entityId, {limit: 50});
        setEvents(rows);
        setCount(rows.filter((r) => !r.deleted_at).length);
      }
    } catch (e) {
      // Soft-fail: log + show inline notice. Never throw out of Activity.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('ActivityPanel: load failed', e && e.message ? e.message : e);
      }
      if (mode !== 'compact') {
        setNotice({kind: 'error', message: 'Could not load activity. ' + (e?.message || '')});
      }
    } finally {
      setLoading(false);
    }
  }, [canUse, sb, entityType, entityId, mode]);

  React.useEffect(() => {
    refresh();
    function onChange(e) {
      const d = e && e.detail;
      if (!d || (d.entityType === entityType && d.entityId === entityId) || (!d.entityType && !d.entityId)) {
        refresh();
      }
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener(ACTIVITY_CHANGE_EVENT, onChange);
    }
    return () => {
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener(ACTIVITY_CHANGE_EVENT, onChange);
      }
    };
  }, [refresh, refreshKey, entityType, entityId]);

  async function onPost() {
    if (!canUse) return;
    if (!draft.body || !draft.body.trim()) return;
    setPosting(true);
    setNotice(null);
    try {
      await postActivityComment(sb, {
        entityType,
        entityId,
        body: draft.body,
        entityLabel: resolvedLabel,
        mentions: draft.mentions,
      });
      setDraft({body: '', mentions: []});
      await refresh();
    } catch (e) {
      setNotice({kind: 'error', message: 'Could not post comment. ' + (e?.message || '')});
    } finally {
      setPosting(false);
    }
  }

  async function onDelete(eventId) {
    setNotice(null);
    try {
      await deleteActivityEvent(sb, eventId);
      await refresh();
    } catch (e) {
      setNotice({kind: 'error', message: 'Could not delete. ' + (e?.message || '')});
    }
  }

  // ---- compact mode -----------------------------------------------------
  if (mode === 'compact') {
    if (!canUse) return null;
    const hot = count > 0;
    return (
      <button
        type="button"
        data-activity-compact-chip="1"
        data-activity-entity-type={entityType}
        data-activity-entity-id={entityId}
        data-activity-count={count}
        onClick={(e) => {
          e.stopPropagation();
          if (typeof onCompactClick === 'function') {
            onCompactClick({entityType, entityId, entityLabel: resolvedLabel, entityCtx, entityRoute});
          }
        }}
        style={hot ? COMPACT_CHIP_HOT : COMPACT_CHIP}
        title={count === 1 ? '1 activity event' : `${count} activity events`}
      >
        💬 {count > 0 ? count : ''}
      </button>
    );
  }

  // ---- full mode --------------------------------------------------------
  if (!canUse) {
    return (
      <div data-activity-panel="1" data-activity-mode="full" style={PANEL_WRAP}>
        <div style={PANEL_HEADER}>
          <span>Activity</span>
        </div>
        <div style={{fontSize: 13, color: '#6b7280'}}>Activity is not available for this entity type.</div>
      </div>
    );
  }

  return (
    <div
      data-activity-panel="1"
      data-activity-mode="full"
      data-activity-entity-type={entityType}
      data-activity-entity-id={entityId}
      style={PANEL_WRAP}
    >
      <div style={PANEL_HEADER}>
        <span>Activity · {resolvedLabel}</span>
        <span data-activity-count={count} style={{fontFamily: 'inherit'}}>
          {count}
        </span>
      </div>
      {notice && <InlineNotice kind={notice.kind} message={notice.message} onDismiss={() => setNotice(null)} />}
      <div data-activity-compose="1" style={{marginBottom: 10}}>
        <MentionTextarea
          sb={sb}
          value={draft.body}
          mentions={draft.mentions}
          onChange={(next) => setDraft(next)}
          placeholder="Comment, or @ to mention…"
          disabled={posting}
        />
        <div style={{display: 'flex', justifyContent: 'flex-end', marginTop: 6}}>
          <button
            type="button"
            data-activity-post-button="1"
            onClick={onPost}
            disabled={posting || !draft.body.trim()}
            style={posting || !draft.body.trim() ? POST_BTN_DISABLED : POST_BTN}
          >
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
      </div>

      <div data-activity-list="1">
        {loading && events.length === 0 && (
          <div style={{fontSize: 12, color: '#6b7280', padding: '8px 0'}}>Loading…</div>
        )}
        {!loading && events.length === 0 && (
          <div data-activity-empty="1" style={{fontSize: 12.5, color: '#6b7280', padding: '8px 0'}}>
            No activity yet. Post the first comment.
          </div>
        )}
        {events.map((ev) => {
          const isDeleted = !!ev.deleted_at;
          const isComment = ev.event_type === 'comment.posted';
          const isAuthor = ev.actor_profile_id && ev.actor_profile_id === callerProfileId;
          const eventBadge = eventTypeLabel(ev.event_type);
          return (
            <div
              key={ev.id}
              data-activity-event-row={ev.id}
              data-activity-event-type={ev.event_type}
              data-activity-deleted={isDeleted ? '1' : '0'}
              style={EVENT_ROW}
            >
              <div style={EVENT_HEAD}>
                <span data-activity-event-actor={ev.actor_profile_id || ''} style={EVENT_ACTOR}>
                  {/* Actor name resolution order:
                      1. deleted comments show "(deleted)" instead of the actor.
                      2. actor_display_name from the RPC (server joins profiles).
                      3. If the actor profile was deleted (FK SET NULL),
                         actor_display_name is NULL — fall back to "System"
                         for trigger-emitted system events (no actor),
                         else "Unknown user" for human-authored rows whose
                         profile is gone. */}
                  {isDeleted ? '(deleted)' : ev.actor_display_name || (ev.actor_profile_id ? 'Unknown user' : 'System')}
                </span>
                {eventBadge && <span style={EVENT_SYSTEM_BADGE}>{eventBadge}</span>}
                <span>· {fmtRelative(ev.created_at)}</span>
                {ev.edited_at && <span>· edited</span>}
                {isComment && !isDeleted && isAuthor && (
                  <button
                    type="button"
                    data-activity-delete-button={ev.id}
                    onClick={() => onDelete(ev.id)}
                    style={{
                      marginLeft: 'auto',
                      background: 'none',
                      border: 'none',
                      color: '#b91c1c',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: 'inherit',
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
              <div style={EVENT_BODY}>
                {isDeleted ? (
                  <em style={{color: '#9ca3af'}}>(comment deleted)</em>
                ) : (
                  renderEventBody(ev.body, ev.mentioned_profile_names, ev.mentioned_profile_ids)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
