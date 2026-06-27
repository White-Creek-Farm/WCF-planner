// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import Badge from '../shared/Badge.jsx';
import {pigBatchProcessingStatusLabel, pigBatchProcessingStatusVariant} from '../lib/processingStatusDisplay.js';

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

function MetricCell({value, kind = 'head', estimated = false}) {
  const display = kind === 'feed' ? formatFeed(value) : formatHead(value);
  const empty = display === EMPTY_CELL;
  // CP0 WI-2a: feed/head metrics are raw numbers → black (no amber tint).
  const color = empty ? 'var(--ink-faint)' : 'var(--text-primary)';
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
  const statusLabel = pigBatchProcessingStatusLabel(group, rowMetrics);
  const statusVariant = pigBatchProcessingStatusVariant(group, rowMetrics);
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
        borderBottom: '1px solid var(--divider)',
        cursor: 'pointer',
        background: group.status === 'processed' ? '#fafafa' : 'white',
      }}
    >
      <span
        style={{
          fontWeight: 700,
          fontSize: 13,
          color: 'var(--ink)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {group.batchName}
      </span>

      <span style={{justifySelf: 'start'}}>
        <Badge variant={statusVariant}>{statusLabel}</Badge>
      </span>

      <MetricCell value={rowMetrics.started} />
      <MetricCell value={rowMetrics.current} />
      <MetricCell value={rowMetrics.totalFeedLbs} kind="feed" />
      <MetricCell value={rowMetrics.feedPerPig} kind="feed" />
      <MetricCell value={gilts.started} />
      <MetricCell value={gilts.current} estimated={gilts.currentEstimated} />
      <MetricCell value={gilts.totalFeedLbs} kind="feed" estimated={gilts.feedEstimated} />
      <MetricCell value={gilts.feedPerPig} kind="feed" estimated={gilts.feedEstimated} />
      <MetricCell value={boars.started} />
      <MetricCell value={boars.current} estimated={boars.currentEstimated} />
      <MetricCell value={boars.totalFeedLbs} kind="feed" estimated={boars.feedEstimated} />
      <MetricCell value={boars.feedPerPig} kind="feed" estimated={boars.feedEstimated} />
    </div>
  );
}
