import {S} from '../lib/styles.js';

// Shared column template for the unified Pig Batches inspection grid. The hub
// header row (PigBatchesView) and every batch row (this component) consume the
// SAME template so the columns stay aligned, Podio-style. Tracks:
//   Batch | Status | Started | Current | Feed/started | Sub-batches·Gilts/Boars | Open
export const PIG_BATCH_GRID_COLUMNS = 'minmax(140px, 1.6fr) 88px 72px 72px 108px minmax(150px, 1.8fr) 60px';

// Presentational nav-only hub ROW for one pig feeder batch (CP6 extraction from
// PigBatchesView; redesigned from a stacked card into one aligned grid row so
// all visible batches read as a single vertical inspection table). Render-only:
// the caller computes ledger/feed metrics because those need breeders + dailys;
// this component just displays them in fixed columns and routes on click.
export default function PigBatchHubTile({
  group,
  current,
  started,
  feedPerStarted,
  subSummaries = [],
  statusColor,
  onOpen,
}) {
  const feedLabel =
    feedPerStarted != null && isFinite(feedPerStarted) ? Math.round(feedPerStarted).toLocaleString() + ' lb' : null;
  const gilt = parseInt(group.giltCount) || 0;
  const boar = parseInt(group.boarCount) || 0;

  return (
    <div
      data-pig-batch-tile={group.id}
      onClick={onOpen}
      className="hoverable-tile"
      style={{
        display: 'grid',
        gridTemplateColumns: PIG_BATCH_GRID_COLUMNS,
        gap: 10,
        alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid #f3f4f6',
        cursor: 'pointer',
        background: group.status === 'processed' ? '#fafafa' : 'white',
      }}
    >
      {/* Batch */}
      <span
        style={{
          fontWeight: 700,
          fontSize: 13,
          color: '#111827',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {group.batchName}
      </span>

      {/* Status */}
      <span style={{justifySelf: 'start'}}>
        <span style={S.badge(statusColor.bg, statusColor.tx)}>{group.status}</span>
      </span>

      {/* Started */}
      <span style={{fontSize: 12, color: '#374151', fontVariantNumeric: 'tabular-nums'}}>
        {started > 0 ? <strong>{started}</strong> : '—'}
      </span>

      {/* Current */}
      <span style={{fontSize: 12, color: '#374151', fontVariantNumeric: 'tabular-nums'}}>
        {current !== null ? <strong>{current}</strong> : '—'}
      </span>

      {/* Feed/started */}
      <span style={{fontSize: 12, color: feedLabel ? '#78350f' : '#9ca3af'}}>
        {feedLabel ? <strong>{feedLabel}</strong> : '—'}
      </span>

      {/* Sub-batch / gilt-boar summary */}
      {subSummaries.length > 0 ? (
        <span data-pig-batch-sub-batches={group.id} style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
          {subSummaries.map((s) => {
            const subFeed =
              s.feedPerStarted != null && isFinite(s.feedPerStarted)
                ? Math.round(s.feedPerStarted).toLocaleString() + ' lb/feed-started'
                : null;
            return (
              <span
                key={s.id || s.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  flexWrap: 'wrap',
                  fontSize: 11,
                  color: s.status === 'processed' ? '#6b7280' : '#374151',
                  background: s.status === 'processed' ? '#f3f4f6' : '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  padding: '3px 7px',
                }}
              >
                <strong style={{color: '#111827'}}>{s.name}</strong>
                {s.started > 0 && <span>{'S ' + s.started}</span>}
                {s.current !== null && <span>{'C ' + s.current}</span>}
                {subFeed && <span style={{color: '#78350f'}}>{subFeed}</span>}
              </span>
            );
          })}
        </span>
      ) : (
        <span style={{fontSize: 11, color: '#6b7280', display: 'flex', gap: 8, flexWrap: 'wrap'}}>
          {gilt > 0 && <span>{'Gilts ' + gilt}</span>}
          {boar > 0 && <span>{'Boars ' + boar}</span>}
          {gilt === 0 && boar === 0 && <span style={{color: '#9ca3af'}}>—</span>}
        </span>
      )}

      {/* Open */}
      <span style={{fontSize: 12, color: '#085041', fontWeight: 600, textAlign: 'right'}}>{'Open ->'}</span>
    </div>
  );
}
