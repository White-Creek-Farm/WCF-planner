// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import './DataTable.css';
import {openableProps} from './openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from './InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import EmptyState from './EmptyState.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import SectionBand from './SectionBand.jsx';

// ============================================================================
// DataTable — the canonical table system · CP0 §A6 / §A7 / §A9
// ----------------------------------------------------------------------------
// Guard-aware by construction so it SATISFIES the locked contracts instead of
// fighting them:
//   • real <table>; sticky <thead>; numbers right-aligned + tabular-nums;
//     hairline rows; no zebra.
//   • each <tr> carries `.hoverable-row` and opens the record via onRowOpen
//     (no per-row Open button); keyboard-openable (Enter/Space).
//   • emits data-${surfaceKey}-loaded and gates rows + empty behind !loadError.
//   • loading -> skeleton rows; empty & loaded -> <EmptyState>; loadError ->
//     <InlineNotice> + Retry, stale rows cleared.
//   • optional leftmost select column; locked rows render disabled.
//   • optional Active/Complete section bands.
//   • mobile: rows collapse to stacked record-lines (DataTable.css), using each
//     column's label; columns with mobilePriority:false are hidden there.
//
// Props:
//   columns: [{ key, label, align?:'left'|'right', primary?, sortable?,
//               mobilePriority?:boolean, render?:(row)=>node }]
//   rows: object[]                          (flat list)            OR
//   sections: [{ key, label, count?, rows }] (banded list; takes precedence)
//   rowKey: string | (row)=>string          (default 'id')
//   density: 'comfortable' | 'compact'
//   onRowOpen?: (row) => void
//   rowDisabled?: (row) => boolean
//   selectable?: boolean
//   selectedIds?: Set|array
//   onToggleSelect?: (row) => void
//   sort?: { key, dir:'asc'|'desc' }, onSort?: (key) => void
//   loading?, loadError?: {message}|null, onRetry?, emptyMessage?, emptyAction?
//   surfaceKey: string                       (for data-<key>-loaded)
//   stickyTop?: number|string                (sticky header offset)
// ============================================================================

function keyFor(row, rowKey, i) {
  if (typeof rowKey === 'function') return rowKey(row);
  return row?.[rowKey] ?? i;
}

function cellClass(col) {
  const c = [];
  if (col.align === 'right') c.push('is-num');
  if (col.primary) c.push('is-primary');
  if (col.mobilePriority === false) c.push('mobile-hide');
  return c.join(' ');
}

export default function DataTable({
  columns = [],
  rows,
  sections,
  rowKey = 'id',
  density = 'comfortable',
  onRowOpen,
  rowDisabled,
  rowProps,
  rowStyle,
  selectable = false,
  selectedIds,
  onToggleSelect,
  showRowNumbers = false,
  sort,
  onSort,
  loading = false,
  loadError = null,
  onRetry,
  emptyMessage = 'Nothing here yet.',
  emptyAction,
  surfaceKey = 'data-table',
  stickyTop = 0,
}) {
  const isSelected = (k) => {
    if (!selectedIds) return false;
    if (selectedIds instanceof Set) return selectedIds.has(k);
    return Array.isArray(selectedIds) && selectedIds.includes(k);
  };

  // Leading columns (select / row-number) widen the colSpan for bands/skeletons.
  const leadCols = (selectable ? 1 : 0) + (showRowNumbers ? 1 : 0);
  const totalCols = columns.length + leadCols;

  const loaded = !loading && !loadError;
  const flatRows = sections ? sections.flatMap((s) => s.rows || []) : rows || [];
  const isEmpty = loaded && flatRows.length === 0;

  function openRow(row, disabled) {
    if (disabled || !onRowOpen) return;
    onRowOpen(row);
  }

  function renderBodyRow(row, i) {
    const k = keyFor(row, rowKey, i);
    const disabled = rowDisabled ? rowDisabled(row) : false;
    const openable = !!onRowOpen && !disabled;
    return (
      <tr
        key={k}
        className={`${openable ? 'hoverable-row' : ''}${disabled ? ' is-disabled' : ''}`}
        data-row-id={k}
        style={rowStyle ? rowStyle(row) : undefined}
        {...(rowProps ? rowProps(row) : {})}
        {...(openable ? openableProps(() => openRow(row, disabled)) : {})}
      >
        {selectable && (
          <td className="select-col" data-label="" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              aria-label="Select row"
              checked={isSelected(k)}
              disabled={disabled}
              onChange={() => onToggleSelect && onToggleSelect(row)}
            />
          </td>
        )}
        {showRowNumbers && (
          <td className="row-num" data-label="#">
            {i + 1}
          </td>
        )}
        {columns.map((col) => (
          <td key={col.key} className={cellClass(col)} data-label={col.label}>
            {col.render ? col.render(row) : row?.[col.key]}
          </td>
        ))}
      </tr>
    );
  }

  return (
    <div className="data-table-wrap" data-surface={surfaceKey} {...{[`data-${surfaceKey}-loaded`]: loaded ? '1' : '0'}}>
      {loadError && (
        <div data-datatable-error="1" style={{padding: '4px 0'}}>
          <InlineNotice notice={{kind: 'error', message: loadError.message || 'Failed to load.'}} />
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              style={{
                padding: '8px 14px',
                borderRadius: 10,
                border: '1px solid #b91c1c',
                background: '#b91c1c',
                color: 'white',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {!loadError && (
        <table
          className="data-table"
          data-density={density}
          style={{['--data-table-sticky-top']: typeof stickyTop === 'number' ? `${stickyTop}px` : stickyTop}}
        >
          <thead>
            <tr>
              {selectable && <th className="select-col" aria-label="Select" />}
              {showRowNumbers && <th className="row-num">#</th>}
              {columns.map((col) => {
                const sortable = !!col.sortable && !!onSort;
                const isActive = sort && sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    className={`${col.align === 'right' ? 'is-num' : ''}${sortable ? ' is-sortable' : ''}`}
                    onClick={sortable ? () => onSort(col.key) : undefined}
                    aria-sort={isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    {col.label}
                    {isActive && <span className="sort-caret">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({length: 5}).map((_, r) => (
                <tr key={`sk-${r}`}>
                  <td className="skeleton-cell" colSpan={totalCols}>
                    <div className="skeleton-bar" />
                  </td>
                </tr>
              ))}

            {!loading &&
              sections &&
              sections.map((s) => (
                <React.Fragment key={s.key || s.label}>
                  <SectionBand as="tr" span={totalCols} label={s.label} count={s.count ?? (s.rows || []).length} />
                  {(s.rows || []).map((row, i) => renderBodyRow(row, i))}
                </React.Fragment>
              ))}

            {!loading && !sections && (rows || []).map((row, i) => renderBodyRow(row, i))}
          </tbody>
        </table>
      )}

      {isEmpty && <EmptyState message={emptyMessage} action={emptyAction} />}
    </div>
  );
}
