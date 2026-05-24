import React from 'react';
import {sb} from '../lib/supabase.js';
import {loadGlobalActivity} from '../lib/globalActivityApi.js';
import {getActivityEntityMeta} from '../lib/activityRegistry.js';
import {useAuth} from '../contexts/AuthContext.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ActivityModal from '../shared/ActivityModal.jsx';

const ENTITY_TYPE_LABELS = {
  'task.instance': 'Task',
  'broiler.batch': 'Broiler',
  'pig.batch': 'Pig Batch',
  'layer.batch': 'Layer Batch',
  'layer.housing': 'Layer Housing',
  'cattle.animal': 'Cattle',
  'cattle.processing': 'Cattle Batch',
  'sheep.animal': 'Sheep',
  'sheep.processing': 'Sheep Batch',
  'equipment.item': 'Equipment',
};

const EVENT_TYPE_LABELS = {
  'comment.posted': 'Comment',
  'task.completed': 'Completed',
};

const ENTITY_FILTERS = [
  {value: '', label: 'All types'},
  {value: 'task.instance', label: 'Tasks'},
  {value: 'broiler.batch', label: 'Broiler'},
  {value: 'pig.batch', label: 'Pig'},
  {value: 'layer.batch', label: 'Layer Batch'},
  {value: 'layer.housing', label: 'Layer Housing'},
  {value: 'cattle.animal', label: 'Cattle'},
  {value: 'cattle.processing', label: 'Cattle Processing'},
  {value: 'sheep.animal', label: 'Sheep'},
  {value: 'sheep.processing', label: 'Sheep Processing'},
  {value: 'equipment.item', label: 'Equipment'},
];

export default function ActivityLogView({Header}) {
  const {authState} = useAuth();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [entityFilter, setEntityFilter] = React.useState('');
  const [activityTarget, setActivityTarget] = React.useState(null);
  const [hasMore, setHasMore] = React.useState(false);

  const load = React.useCallback(
    async (append) => {
      if (!append) setLoading(true);
      setErr('');
      try {
        const before = append && rows.length > 0 ? rows[rows.length - 1].created_at : undefined;
        const data = await loadGlobalActivity(sb, {
          limit: 50,
          before,
          entityType: entityFilter || undefined,
          search: search.trim() || undefined,
        });
        if (append) {
          setRows((prev) => [...prev, ...data]);
        } else {
          setRows(data);
        }
        setHasMore(data.length === 50);
      } catch (e) {
        setErr(e.message || 'Failed to load activity');
      }
      setLoading(false);
    },
    [entityFilter, search, rows],
  );

  React.useEffect(() => {
    load(false);
  }, [entityFilter]);

  function handleSearch(e) {
    e.preventDefault();
    load(false);
  }

  function handleRowClick(row) {
    const meta = getActivityEntityMeta(row.entity_type);
    if (meta) {
      setActivityTarget({
        entityType: row.entity_type,
        entityId: row.entity_id,
        entityLabel: row.entity_label || row.entity_id,
      });
    }
  }

  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now - d;
    if (diffMs < 60000) return 'just now';
    if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
    if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
    if (diffMs < 604800000) return Math.floor(diffMs / 86400000) + 'd ago';
    return d.toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
  };

  const inputStyle = {
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    fontSize: 12,
    fontFamily: 'inherit',
    background: 'white',
  };

  return React.createElement(
    'div',
    {style: {minHeight: '100vh', background: '#f9fafb'}, 'data-view': 'activity-log'},
    Header ? React.createElement(Header) : null,
    React.createElement(
      'div',
      {style: {maxWidth: 880, margin: '0 auto', padding: '16px 18px'}},
      React.createElement('h1', {style: {fontSize: 20, margin: '0 0 4px', color: '#111827'}}, 'Activity Log'),
      React.createElement(
        'div',
        {style: {fontSize: 12, color: '#6b7280', marginBottom: 14}},
        'Farm-wide activity timeline. Shows comments, completions, and events you have access to.',
      ),

      // Filters
      React.createElement(
        'form',
        {
          onSubmit: handleSearch,
          style: {display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center'},
        },
        React.createElement('input', {
          type: 'text',
          value: search,
          onChange: (e) => setSearch(e.target.value),
          placeholder: 'Search activity...',
          style: {...inputStyle, flex: 1, minWidth: 160},
        }),
        React.createElement(
          'select',
          {value: entityFilter, onChange: (e) => setEntityFilter(e.target.value), style: inputStyle},
          ENTITY_FILTERS.map((f) => React.createElement('option', {key: f.value, value: f.value}, f.label)),
        ),
        React.createElement(
          'button',
          {
            type: 'submit',
            style: {
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid #085041',
              background: '#085041',
              color: 'white',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          },
          'Search',
        ),
      ),

      // Error
      err && React.createElement('div', {style: {color: '#b91c1c', fontSize: 13, marginBottom: 12}}, err),

      // Loading
      loading &&
        rows.length === 0 &&
        React.createElement(
          'div',
          {style: {color: '#9ca3af', fontSize: 13, padding: '2rem 0', textAlign: 'center'}},
          'Loading...',
        ),

      // Empty
      !loading &&
        rows.length === 0 &&
        !err &&
        React.createElement(
          'div',
          {style: {color: '#9ca3af', fontSize: 13, padding: '2rem 0', textAlign: 'center'}},
          'No activity found.',
        ),

      // Timeline rows
      rows.length > 0 &&
        React.createElement(
          'div',
          {style: {display: 'flex', flexDirection: 'column', gap: 2}},
          rows.map((r) =>
            React.createElement(
              'div',
              {
                key: r.id,
                onClick: () => handleRowClick(r),
                style: {
                  padding: '10px 14px',
                  background: r.deleted_at ? '#fafafa' : 'white',
                  border: '1px solid #f3f4f6',
                  borderRadius: 6,
                  cursor: 'pointer',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  fontSize: 13,
                  opacity: r.deleted_at ? 0.5 : 1,
                },
                'data-activity-log-row': r.id,
              },
              // Left: actor + time
              React.createElement(
                'div',
                {style: {minWidth: 100, flexShrink: 0}},
                React.createElement(
                  'div',
                  {style: {fontWeight: 600, color: '#111827', fontSize: 12}},
                  r.actor_display_name,
                ),
                React.createElement('div', {style: {fontSize: 11, color: '#9ca3af'}}, fmtTime(r.created_at)),
              ),
              // Center: event + entity + body
              React.createElement(
                'div',
                {style: {flex: 1, minWidth: 0}},
                React.createElement(
                  'div',
                  {style: {display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2}},
                  React.createElement(
                    'span',
                    {
                      style: {
                        fontSize: 10,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: '#ecfdf5',
                        color: '#065f46',
                        textTransform: 'uppercase',
                      },
                    },
                    EVENT_TYPE_LABELS[r.event_type] || r.event_type,
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 11, color: '#6b7280'}},
                    ENTITY_TYPE_LABELS[r.entity_type] || r.entity_type,
                  ),
                  React.createElement(
                    'span',
                    {style: {fontSize: 12, fontWeight: 600, color: '#374151'}},
                    r.entity_label || r.entity_id,
                  ),
                ),
                r.body &&
                  React.createElement(
                    'div',
                    {style: {fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word'}},
                    r.body.length > 200 ? r.body.slice(0, 200) + '...' : r.body,
                  ),
                r.mentioned_profile_names &&
                  r.mentioned_profile_names.length > 0 &&
                  React.createElement(
                    'div',
                    {style: {fontSize: 11, color: '#2563eb', marginTop: 2}},
                    '@' + r.mentioned_profile_names.filter(Boolean).join(' @'),
                  ),
              ),
            ),
          ),
        ),

      // Load more
      hasMore &&
        !loading &&
        React.createElement(
          'div',
          {style: {textAlign: 'center', padding: '12px 0'}},
          React.createElement(
            'button',
            {
              onClick: () => load(true),
              style: {
                padding: '6px 18px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: 'white',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            },
            'Load more',
          ),
        ),
    ),
    React.createElement(ActivityModal, {
      sb,
      authState,
      target: activityTarget,
      onClose: () => setActivityTarget(null),
    }),
  );
}
