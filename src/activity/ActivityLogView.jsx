import React from 'react';
import {useNavigate} from 'react-router-dom';
import {sb} from '../lib/supabase.js';
import {loadGlobalActivity} from '../lib/globalActivityApi.js';
import {getActivityEntityMeta} from '../lib/activityRegistry.js';
import InlineNotice from '../shared/InlineNotice.jsx';

const ENTITY_TYPE_LABELS = {
  'task.instance': 'Task',
  'broiler.batch': 'Broiler',
  'pig.batch': 'Pig Batch',
  'layer.batch': 'Layer Batch',
  'layer.housing': 'Layer Housing',
  'cattle.animal': 'Cattle',
  'cattle.processing': 'Cattle Batch',
  'cattle.forecast': 'Cattle Forecast',
  'sheep.animal': 'Sheep',
  'sheep.processing': 'Sheep Batch',
  'equipment.item': 'Equipment',
  'poultry.daily': 'Broiler Daily',
  'layer.daily': 'Layer Daily',
  'egg.daily': 'Egg Daily',
  'pig.daily': 'Pig Daily',
  'cattle.daily': 'Cattle Daily',
  'sheep.daily': 'Sheep Daily',
  'weighin.session': 'Weigh-In Session',
};

const EVENT_TYPE_LABELS = {
  'comment.posted': 'Comment',
  'task.completed': 'Completed',
  'field.updated': 'Updated',
  'status.changed': 'Status',
  'record.created': 'Created',
  'record.deleted': 'Deleted',
  'record.restored': 'Restored',
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
  {value: 'cattle.forecast', label: 'Cattle Forecast'},
  {value: 'sheep.animal', label: 'Sheep'},
  {value: 'sheep.processing', label: 'Sheep Processing'},
  {value: 'equipment.item', label: 'Equipment'},
  {value: 'poultry.daily', label: 'Broiler Daily'},
  {value: 'layer.daily', label: 'Layer Daily'},
  {value: 'egg.daily', label: 'Egg Daily'},
  {value: 'pig.daily', label: 'Pig Daily'},
  {value: 'cattle.daily', label: 'Cattle Daily'},
  {value: 'sheep.daily', label: 'Sheep Daily'},
  {value: 'weighin.session', label: 'Weigh-In Sessions'},
];

export default function ActivityLogView({Header}) {
  const navigate = useNavigate();
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  // appendError is separate from loadError on purpose: a failed "Load more"
  // append must NOT trip the main fail-closed gate, hide already-loaded rows,
  // or flip data-activity-log-loaded. Only initial/search/filter loads fail
  // closed via loadError.
  const [appendError, setAppendError] = React.useState(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [entityFilter, setEntityFilter] = React.useState('');
  const [hasMore, setHasMore] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const load = React.useCallback(
    async (append) => {
      if (append) {
        // Guard against duplicate concurrent appends from repeated clicks.
        if (loadingMore) return;
        setLoadingMore(true);
        setAppendError(null);
      } else {
        setLoading(true);
        setLoadError(null);
        setAppendError(null);
      }
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
        if (append) {
          // Keep existing rows and hasMore so the user can retry the same page
          // without changing filters or reloading the whole timeline.
          setAppendError({kind: 'error', message: e.message || 'Failed to load more activity'});
        } else {
          setRows([]);
          setHasMore(false);
          setLoadError({kind: 'error', message: e.message || 'Failed to load activity'});
        }
      }
      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [entityFilter, search, rows, loadingMore],
  );

  React.useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityFilter, reloadKey]);

  function handleSearch(e) {
    e.preventDefault();
    load(false);
  }

  // Global Activity Log is read-only audit history. A row click navigates to
  // the entity's dedicated record page (where Comments + the scoped Activity
  // log live) instead of opening a legacy composer. Rows whose entity_type has
  // no registered route are inert.
  function handleRowClick(row) {
    const meta = getActivityEntityMeta(row.entity_type);
    if (!meta || typeof meta.route !== 'function') return;
    try {
      navigate(meta.route(row.entity_id));
    } catch (_e) {
      /* malformed id — leave the row inert rather than crashing the view */
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
    {
      style: {minHeight: '100vh', background: '#f9fafb'},
      'data-view': 'activity-log',
      'data-activity-log-loaded': loading || loadError ? 'false' : 'true',
    },
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
      loadError &&
        React.createElement(
          'div',
          {'data-activity-log-load-error': 'true'},
          React.createElement(InlineNotice, {notice: loadError}),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setReloadKey((k) => k + 1),
              'data-activity-log-retry': 'true',
              style: {
                marginBottom: 12,
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid #b91c1c',
                background: '#b91c1c',
                color: 'white',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              },
            },
            'Retry',
          ),
        ),

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
        !loadError &&
        React.createElement(
          'div',
          {style: {color: '#9ca3af', fontSize: 13, padding: '2rem 0', textAlign: 'center'}},
          'No activity found.',
        ),

      // Timeline rows
      !loadError &&
        rows.length > 0 &&
        React.createElement(
          'div',
          {style: {display: 'flex', flexDirection: 'column', gap: 2}},
          rows.map((r) => {
            const routeMeta = getActivityEntityMeta(r.entity_type);
            const routable = !!(routeMeta && typeof routeMeta.route === 'function');
            return React.createElement(
              'div',
              {
                key: r.id,
                onClick: routable ? () => handleRowClick(r) : undefined,
                style: {
                  padding: '10px 14px',
                  background: r.deleted_at ? '#fafafa' : 'white',
                  border: '1px solid #f3f4f6',
                  borderRadius: 6,
                  cursor: routable ? 'pointer' : 'default',
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  fontSize: 13,
                  opacity: r.deleted_at ? 0.5 : 1,
                },
                'data-activity-log-row': r.id,
                'data-activity-log-routable': routable ? '1' : '0',
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
                r.deleted_at
                  ? React.createElement(
                      'div',
                      {style: {fontSize: 12, color: '#9ca3af', fontStyle: 'italic'}},
                      '(comment deleted)',
                    )
                  : r.body &&
                      React.createElement(
                        'div',
                        {style: {fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', wordBreak: 'break-word'}},
                        r.body.length > 200 ? r.body.slice(0, 200) + '...' : r.body,
                      ),
                !r.deleted_at &&
                  r.mentioned_profile_names &&
                  r.mentioned_profile_names.length > 0 &&
                  React.createElement(
                    'div',
                    {style: {fontSize: 11, color: '#2563eb', marginTop: 2}},
                    '@' + r.mentioned_profile_names.filter(Boolean).join(' @'),
                  ),
              ),
            );
          }),
        ),

      // Load more + append/pagination error. Gated on the main timeline being
      // visible (no loadError, rows present), NOT on appendError — a failed
      // append keeps the loaded rows AND the retry control on screen.
      !loadError &&
        rows.length > 0 &&
        React.createElement(
          'div',
          {style: {textAlign: 'center', padding: '12px 0'}},
          appendError &&
            React.createElement(
              'div',
              {'data-activity-log-append-error': 'true', style: {marginBottom: 8}},
              React.createElement(InlineNotice, {notice: appendError}),
            ),
          hasMore &&
            !loading &&
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => load(true),
                disabled: loadingMore,
                'data-activity-log-load-more': 'true',
                style: {
                  padding: '6px 18px',
                  borderRadius: 6,
                  border: '1px solid #d1d5db',
                  background: 'white',
                  fontSize: 12,
                  cursor: loadingMore ? 'default' : 'pointer',
                  opacity: loadingMore ? 0.6 : 1,
                  fontFamily: 'inherit',
                },
              },
              loadingMore ? 'Loading…' : appendError ? 'Retry loading more' : 'Load more',
            ),
        ),
    ),
  );
}
