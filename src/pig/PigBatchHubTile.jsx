import {S} from '../lib/styles.js';

// Shared column template for the unified Pig Batches inspection grid. The hub
// header row (PigBatchesView) and every batch row (this component) consume the
// SAME template so the columns stay aligned, Podio-style.
export const PIG_BATCH_GRID_COLUMNS = 'minmax(140px, 1.6fr) 88px repeat(12, minmax(82px, 0.8fr))';

export const PIG_BATCH_GRID_HEADERS = Object.freeze([
  'Batch',
  'Status',
  'Started Head',
  'Current Head',
  'Total Feed',
  'Feed / Pig',
  'Gilts Started',
  'Gilts Current',
  'Gilts Total Feed',
  'Gilts Feed / Pig',
  'Boars Started',
  'Boars Current',
  'Boars Total Feed',
  'Boars Feed / Pig',
]);

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const EMPTY_CELL = '—'; // em dash, app convention for not-recorded values

function formatHead(value) {
  const n = finiteNumber(value);
  return n == null ? EMPTY_CELL : Math.round(n).toLocaleString();
}

function formatFeed(value) {
  const n = finiteNumber(value);
  return n != null && n > 0 ? Math.round(n).toLocaleString() + ' lb' : EMPTY_CELL;
}

const ESTIMATED_HINT = 'Estimated from started-head split';

function MetricCell({value, kind = 'head', tone = 'default', estimated = false}) {
  const display = kind === 'feed' ? formatFeed(value) : formatHead(value);
  const empty = display === EMPTY_CELL;
  const color = empty ? '#9ca3af' : tone === 'feed' ? '#78350f' : '#374151';
  // '~' marks proportional started-head estimates (source records carried no
  // sex attribution); exact single-sex values render unmarked.
  const marked = estimated && !empty;
  return (
    <span
      title={marked ? ESTIMATED_HINT : undefined}
      aria-label={marked ? ESTIMATED_HINT + ': ' + display : undefined}
      style={{
        fontSize: 12,
        color,
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        whiteSpace: 'nowrap',
      }}
    >
      {empty ? display : <strong>{(marked ? '~' : '') + display}</strong>}
    </span>
  );
}

// Presentational nav-only hub row. The caller computes ledger/feed metrics
// because those need breeders + dailys; this component displays fixed columns
// and routes on click/keyboard activation.
export default function PigBatchHubTile({group, metrics, statusColor, onOpen}) {
  const rowMetrics = metrics || {};
  const gilts = rowMetrics.gilts || {};
  const boars = rowMetrics.boars || {};
  function handleKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (typeof onOpen === 'function') onOpen();
  }

  return (
    <div
      data-pig-batch-tile={group.id}
      data-pig-batch-openable-row="1"
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      className="hoverable-tile"
      role="button"
      tabIndex={0}
      aria-label={'Open pig batch ' + (group.batchName || group.id || '')}
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

      <span style={{justifySelf: 'start'}}>
        <span style={S.badge(statusColor.bg, statusColor.tx)}>{group.status}</span>
      </span>

      <MetricCell value={rowMetrics.started} />
      <MetricCell value={rowMetrics.current} />
      <MetricCell value={rowMetrics.totalFeedLbs} kind="feed" tone="feed" />
      <MetricCell value={rowMetrics.feedPerPig} kind="feed" tone="feed" />
      <MetricCell value={gilts.started} />
      <MetricCell value={gilts.current} estimated={gilts.currentEstimated} />
      <MetricCell value={gilts.totalFeedLbs} kind="feed" tone="feed" estimated={gilts.feedEstimated} />
      <MetricCell value={gilts.feedPerPig} kind="feed" tone="feed" estimated={gilts.feedEstimated} />
      <MetricCell value={boars.started} />
      <MetricCell value={boars.current} estimated={boars.currentEstimated} />
      <MetricCell value={boars.totalFeedLbs} kind="feed" tone="feed" estimated={boars.feedEstimated} />
      <MetricCell value={boars.feedPerPig} kind="feed" tone="feed" estimated={boars.feedEstimated} />
    </div>
  );
}
