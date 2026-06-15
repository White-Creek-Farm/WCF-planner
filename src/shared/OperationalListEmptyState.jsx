const EMPTY_STATE_STYLE = {
  textAlign: 'center',
  padding: '3rem',
  color: 'var(--ink-faint)',
  fontSize: 13,
};

export default function OperationalListEmptyState({
  loading = false,
  loadError = false,
  totalCount,
  filteredCount,
  emptyLabel,
  filteredLabel = 'No records match the current filters',
  'data-empty-state': dataEmptyState,
}) {
  if (loading || loadError || filteredCount > 0) return null;
  const label = totalCount === 0 ? emptyLabel : filteredLabel;
  return (
    <div
      data-empty-state={dataEmptyState || (totalCount === 0 ? 'true-empty' : 'filtered-empty')}
      style={EMPTY_STATE_STYLE}
    >
      {label}
    </div>
  );
}
