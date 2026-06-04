import {S} from '../lib/styles.js';

// Presentational nav-only hub tile for one pig feeder batch (CP6 extraction
// from PigBatchesView). Render-only: the caller computes ledger/feed metrics
// because those need breeders + dailys; this component just displays them and
// routes on click.
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

  return (
    <div
      data-pig-batch-tile={group.id}
      onClick={onOpen}
      style={{
        background: 'white',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        padding: '12px 16px',
        marginBottom: 10,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        flexWrap: 'wrap',
        gap: 8,
      }}
    >
      <div style={{display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center'}}>
        <strong style={{fontSize: 14, color: '#111827'}}>{group.batchName}</strong>
        <span style={S.badge(statusColor.bg, statusColor.tx)}>{group.status}</span>
        <span style={{marginLeft: 'auto', fontSize: 12, color: '#085041', fontWeight: 600}}>{'Open ->'}</span>
      </div>

      <div style={{display: 'flex', flexWrap: 'wrap', gap: '6px 14px', alignItems: 'center'}}>
        {started > 0 && (
          <span style={{fontSize: 12, color: '#374151'}}>
            Started: <strong>{started}</strong>
          </span>
        )}
        {current !== null && (
          <span style={{fontSize: 12, color: '#374151'}}>
            Current: <strong>{current}</strong>
          </span>
        )}
        {feedLabel && (
          <span style={{fontSize: 12, color: '#78350f'}}>
            Feed/started: <strong>{feedLabel}</strong>
          </span>
        )}
      </div>

      {subSummaries.length > 0 && (
        <div data-pig-batch-sub-batches={group.id} style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
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
        </div>
      )}
    </div>
  );
}
