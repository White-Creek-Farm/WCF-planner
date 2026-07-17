import React from 'react';
import './homeRedesign.css';
import {sb} from '../lib/supabase.js';
import {
  ANIMAL_HISTORY_SPECIES,
  animalHistoryScaleMax,
  buildAnimalHistoryRows,
  formatAnimalHistoryMonth,
} from '../lib/animalHistory.js';
import {fmt, todayISO} from '../lib/dateUtils.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import InlineNotice from '../shared/InlineNotice.jsx';

async function fetchAllRows(table, {orderBy = null, filterDeleted = false} = {}) {
  const PAGE = 1000;
  let from = 0;
  let all = [];
  while (true) {
    let query = sb.from(table).select('*');
    if (filterDeleted) query = query.is('deleted_at', null);
    if (orderBy) query = query.order(orderBy, {ascending: true});
    const {data, error} = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(table + ': ' + (error.message || error));
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function valueLabel(value) {
  return Math.round(value || 0).toLocaleString();
}

function linePath(points) {
  return points.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
}

// One compact trend chart for one species. Each chart owns its y-scale
// (animalHistoryScaleMax over that species' values only) so broiler flock
// size cannot flatten the cattle, sheep, pig, or layer trend. All charts
// share the same chronological month range on the x-axis.
function SpeciesTrendChart({species, chronological, freshness}) {
  const width = 320;
  const height = 150;
  const pad = {top: 10, right: 12, bottom: 26, left: 44};
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxValue = animalHistoryScaleMax(chronological.map((row) => row[species.key] || 0));
  const xFor = (idx) =>
    chronological.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (chronological.length - 1)) * plotW;
  const yFor = (value) => pad.top + plotH - ((value || 0) / maxValue) * plotH;
  const xStep = Math.max(1, Math.ceil(chronological.length / 3));
  const gridValues = [0, 0.5, 1].map((p) => Math.round(maxValue * p));
  const points = chronological.map((row, idx) => ({x: xFor(idx), y: yFor(row[species.key] || 0)}));
  const latest = chronological[chronological.length - 1];

  return (
    <div className="animal-history-multiple" data-animal-history-series={species.key}>
      <div className="animal-history-multiple-head">
        <span className="animal-history-multiple-name">
          <i style={{background: `var(${species.cssVar})`}} />
          {species.label}
        </span>
        <span className="animal-history-multiple-figure">
          <span className="animal-history-multiple-latest" data-animal-history-latest={species.key}>
            {valueLabel(latest ? latest[species.key] : 0)}
          </span>
          {freshness && freshness.oldestReported && (
            <span
              className="animal-history-multiple-asof"
              data-animal-history-oldest-reported={freshness.oldestReported}
            >
              oldest count reported {fmt(freshness.oldestReported)}
            </span>
          )}
          {freshness && freshness.hasUndatedCounts && (
            <span className="animal-history-multiple-asof" data-animal-history-has-undated="true">
              some counts have no reported date
            </span>
          )}
        </span>
      </div>
      <svg
        className="animal-history-multiple-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${species.label} monthly head count, on its own scale from 0 to ${valueLabel(maxValue)}`}
      >
        {gridValues.map((value) => {
          const y = yFor(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} className="animal-history-grid" />
              <text x={pad.left - 8} y={y + 3.5} className="animal-history-axis-label" textAnchor="end">
                {valueLabel(value)}
              </text>
            </g>
          );
        })}
        {chronological.map((row, idx) => {
          if (idx % xStep !== 0 && idx !== chronological.length - 1) return null;
          const anchor = idx === 0 ? 'start' : idx === chronological.length - 1 ? 'end' : 'middle';
          return (
            <text
              key={row.month}
              x={xFor(idx)}
              y={height - 8}
              className="animal-history-axis-label"
              textAnchor={anchor}
            >
              {formatAnimalHistoryMonth(row.month)}
            </text>
          );
        })}
        <polyline
          points={linePath(points)}
          fill="none"
          stroke={`var(${species.cssVar})`}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="animal-history-line"
        />
        {points.map((point, idx) => (
          <circle
            key={chronological[idx].month}
            cx={point.x}
            cy={point.y}
            r={2.4}
            fill={`var(${species.cssVar})`}
            className="animal-history-point"
          />
        ))}
      </svg>
    </div>
  );
}

function AnimalHistorySmallMultiples({rows}) {
  const chronological = React.useMemo(() => [...(rows || [])].reverse(), [rows]);
  if (chronological.length === 0) {
    return (
      <div className="animal-history-empty" data-animal-history-chart-empty="true">
        No animal history is available yet.
      </div>
    );
  }

  const latest = chronological[chronological.length - 1];
  const layersFreshness = latest
    ? {oldestReported: latest.layersOldestReported || null, hasUndatedCounts: !!latest.layersHasUndatedCounts}
    : null;
  return (
    <div className="animal-history-multiples" data-animal-history-chart="multiples">
      {ANIMAL_HISTORY_SPECIES.map((species) => (
        <SpeciesTrendChart
          key={species.key}
          species={species}
          chronological={chronological}
          freshness={species.key === 'layers' ? layersFreshness : null}
        />
      ))}
    </div>
  );
}

export default function AnimalHistoryPage({Header}) {
  const {authState} = useAuth();
  const {setView} = useUI();
  const {batches} = useBatches();
  const {broilerDailys, pigDailys} = useDailysRecent();
  const {layerBatches, layerHousings, allLayerDailys} = useLayer();
  const {feederGroups, breeders} = usePig();
  const [animalRows, setAnimalRows] = React.useState({cattle: [], sheep: [], cattleTransfers: [], sheepTransfers: []});
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);

  const loadAnimalRows = React.useCallback(
    (isCurrent = () => true) => {
      if (!authState) return;
      setLoading(true);
      setLoadError(null);
      Promise.all([
        fetchAllRows('cattle', {filterDeleted: true, orderBy: 'tag'}),
        fetchAllRows('sheep', {filterDeleted: true, orderBy: 'tag'}),
        fetchAllRows('cattle_transfers', {orderBy: 'transferred_at'}),
        fetchAllRows('sheep_transfers', {orderBy: 'transferred_at'}),
      ])
        .then(([cattle, sheep, cattleTransfers, sheepTransfers]) => {
          if (!isCurrent()) return;
          setAnimalRows({cattle, sheep, cattleTransfers, sheepTransfers});
        })
        .catch((error) => {
          if (!isCurrent()) return;
          setAnimalRows({cattle: [], sheep: [], cattleTransfers: [], sheepTransfers: []});
          setLoadError({
            kind: 'error',
            message: 'Could not load animal history: ' + (error && error.message ? error.message : String(error)),
          });
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    },
    [authState],
  );

  React.useEffect(() => {
    let cancelled = false;
    loadAnimalRows(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadAnimalRows]);

  const rows = React.useMemo(
    () =>
      buildAnimalHistoryRows(
        {
          batches,
          broilerDailys,
          layerBatches,
          layerHousings,
          layerDailys: allLayerDailys,
          feederGroups,
          breeders,
          pigDailys,
          cattle: animalRows.cattle,
          sheep: animalRows.sheep,
          cattleTransfers: animalRows.cattleTransfers,
          sheepTransfers: animalRows.sheepTransfers,
        },
        todayISO(),
      ),
    [
      batches,
      broilerDailys,
      layerBatches,
      layerHousings,
      allLayerDailys,
      feederGroups,
      breeders,
      pigDailys,
      animalRows,
    ],
  );

  const latest = rows[0] || null;
  const earliest = rows[rows.length - 1] || null;

  return (
    <div
      className="home theme-crisp animal-history"
      data-animal-history-page="true"
      data-animal-history-loaded={loading || loadError ? 'false' : 'true'}
    >
      <Header />
      <main className="home-col animal-history-col">
        <div className="animal-history-topline">
          <button type="button" className="btn-clear" onClick={() => setView('home')} data-animal-history-back="home">
            Back to Home
          </button>
          <div className="animal-history-range">
            {earliest && latest
              ? `${formatAnimalHistoryMonth(earliest.month)} - ${formatAnimalHistoryMonth(latest.month)}`
              : ''}
          </div>
        </div>

        <section className="animal-history-title">
          <div>
            <h1>Animals on Farm</h1>
            <p>
              Latest recorded month-end counts
              {latest?.isPartialMonth ? ` - current month as of ${fmt(latest.snapshotDate)}` : ''}
            </p>
            {(latest?.layersOldestReported || latest?.layersHasUndatedCounts) && (
              <p
                className="animal-history-freshness"
                data-animal-history-layers-oldest-reported={latest.layersOldestReported || ''}
                data-animal-history-layers-has-undated={latest.layersHasUndatedCounts ? 'true' : 'false'}
              >
                These are the latest recorded counts, not verified current counts.
                {latest.layersOldestReported
                  ? ` Oldest layer count used was reported ${fmt(latest.layersOldestReported)}.`
                  : ''}
                {latest.layersHasUndatedCounts ? ' Some layer counts used have no reported date.' : ''}
              </p>
            )}
          </div>
        </section>

        {loadError && (
          <div className="animal-history-error" data-animal-history-load-error="true">
            <InlineNotice notice={loadError} />
            <button type="button" className="btn-clear" onClick={() => loadAnimalRows()} data-animal-history-retry="1">
              Retry
            </button>
          </div>
        )}

        <section className="card animal-history-chart-card">
          <div className="stats-head">
            <div className="card-label">Monthly Trend by Species</div>
            {loading && <div className="animal-history-loading">Loading</div>}
          </div>
          <p className="animal-history-scale-note" data-animal-history-scale-note="true">
            Each species is drawn on its own count scale - compare shapes over time, not line heights between species.
          </p>
          <AnimalHistorySmallMultiples rows={rows} />
        </section>

        <section className="card animal-history-table-card">
          <div className="stats-head">
            <div className="card-label">Monthly Counts</div>
            <div className="animal-history-row-count">{rows.length.toLocaleString()} months</div>
          </div>
          <p className="animal-history-scale-note" data-animal-history-method-note="true">
            Each month shows the latest count recorded on or before that month&apos;s end (or the as-of date for the
            current month) - counts are as last reported, not verified live inventory.
          </p>
          <div className="animal-history-table-wrap">
            <table className="animal-history-table" data-animal-history-table="true">
              <thead>
                <tr>
                  <th>Month</th>
                  {ANIMAL_HISTORY_SPECIES.map((species) => (
                    <th key={species.key}>{species.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.month}>
                    <td>
                      <strong>{formatAnimalHistoryMonth(row.month)}</strong>
                      {row.isPartialMonth && (
                        <span className="animal-history-month-asof">As of {fmt(row.snapshotDate)}</span>
                      )}
                    </td>
                    {ANIMAL_HISTORY_SPECIES.map((species) => (
                      <td key={species.key}>{valueLabel(row[species.key])}</td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={ANIMAL_HISTORY_SPECIES.length + 1}>No animal history is available yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
