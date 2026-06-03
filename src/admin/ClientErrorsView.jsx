import React from 'react';
import {sb} from '../lib/supabase.js';
import {loadClientErrors} from '../lib/clientErrorsApi.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

// Runtime Observability Phase 2 — read-only admin review surface for the
// redacted client_error_events captured by clientErrorReporting. Reads through
// the admin-only list_client_errors RPC (never the table directly). Fails
// closed on read errors with a non-dismissible notice + Retry, matching the
// site-wide cold-boot readiness standard.

const PAGE = 100;

const cellStyle = {
  padding: '8px 10px',
  fontSize: 12,
  color: '#374151',
  borderBottom: '1px solid #f3f4f6',
  verticalAlign: 'top',
  textAlign: 'left',
};
const headStyle = {
  ...cellStyle,
  fontWeight: 700,
  color: '#6b7280',
  textTransform: 'uppercase',
  fontSize: 10,
  position: 'sticky',
  top: 0,
  background: '#f9fafb',
};

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('en-US', {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
}

export default function ClientErrorsView({Header}) {
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);
  const [appendError, setAppendError] = React.useState(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [reloadKey, setReloadKey] = React.useState(0);

  const load = React.useCallback(
    async (append) => {
      if (append) {
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
        const data = await loadClientErrors(sb, {limit: PAGE, before});
        if (append) setRows((prev) => [...prev, ...data]);
        else setRows(data);
        setHasMore(data.length === PAGE);
      } catch (e) {
        if (append) {
          setAppendError({kind: 'error', message: e.message || 'Failed to load more'});
        } else {
          setRows([]);
          setHasMore(false);
          setLoadError({kind: 'error', message: e.message || 'Failed to load client errors'});
        }
      }
      if (append) setLoadingMore(false);
      else setLoading(false);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [rows, loadingMore],
  );

  React.useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  return React.createElement(
    'div',
    {
      style: {minHeight: '100vh', background: '#f9fafb'},
      'data-view': 'client-errors',
      'data-client-errors-loaded': loading || loadError ? 'false' : 'true',
    },
    Header ? React.createElement(Header) : null,
    React.createElement(
      'div',
      {style: {maxWidth: 1000, margin: '0 auto', padding: '16px 18px'}},
      React.createElement('h1', {style: {fontSize: 20, margin: '0 0 4px', color: '#111827'}}, 'Client Errors'),
      React.createElement(
        'div',
        {style: {fontSize: 12, color: '#6b7280', marginBottom: 14}},
        'Redacted client/runtime errors captured from the app. Admin-only, read-only.',
      ),

      loadError &&
        React.createElement(
          'div',
          {'data-client-errors-load-error': 'true'},
          React.createElement(InlineNotice, {notice: loadError}),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: () => setReloadKey((k) => k + 1),
              'data-client-errors-retry': 'true',
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

      loading &&
        rows.length === 0 &&
        React.createElement(
          'div',
          {style: {color: '#9ca3af', fontSize: 13, padding: '2rem 0', textAlign: 'center'}},
          'Loading...',
        ),

      !loading &&
        rows.length === 0 &&
        !loadError &&
        React.createElement(
          'div',
          {style: {color: '#9ca3af', fontSize: 13, padding: '2rem 0', textAlign: 'center'}},
          'No client errors recorded.',
        ),

      !loadError &&
        rows.length > 0 &&
        React.createElement(
          'div',
          {style: {overflowX: 'auto', border: '1px solid #f3f4f6', borderRadius: 8, background: 'white'}},
          React.createElement(
            'table',
            {style: {width: '100%', borderCollapse: 'collapse'}, 'data-client-errors-table': '1'},
            React.createElement(
              'thead',
              null,
              React.createElement(
                'tr',
                null,
                ['When', 'Source', 'Kind', 'Message', 'Route', 'Version'].map((h) =>
                  React.createElement('th', {key: h, style: headStyle}, h),
                ),
              ),
            ),
            React.createElement(
              'tbody',
              null,
              rows.map((r) =>
                React.createElement(
                  'tr',
                  {key: r.id, 'data-client-error-row': r.id},
                  React.createElement('td', {style: {...cellStyle, whiteSpace: 'nowrap'}}, fmtWhen(r.created_at)),
                  React.createElement('td', {style: cellStyle}, r.source),
                  React.createElement('td', {style: cellStyle}, r.error_kind),
                  React.createElement('td', {style: {...cellStyle, maxWidth: 360, wordBreak: 'break-word'}}, r.message),
                  React.createElement('td', {style: {...cellStyle, color: '#6b7280'}}, r.route || '—'),
                  React.createElement('td', {style: {...cellStyle, color: '#6b7280'}}, r.app_version || '—'),
                ),
              ),
            ),
          ),
        ),

      !loadError &&
        rows.length > 0 &&
        React.createElement(
          'div',
          {style: {textAlign: 'center', padding: '12px 0'}},
          appendError &&
            React.createElement(
              'div',
              {'data-client-errors-append-error': 'true', style: {marginBottom: 8}},
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
                'data-client-errors-load-more': 'true',
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
