import React from 'react';
import './homeRedesign.css';
import {sb} from '../lib/supabase.js';
import {ANIMAL_HISTORY_SPECIES, buildAnimalHistoryRows, formatAnimalHistoryMonth} from '../lib/animalHistory.js';
import {todayISO} from '../lib/dateUtils.js';
import {useAuth} from '../contexts/AuthContext.jsx';
import {useBatches} from '../contexts/BatchesContext.jsx';
import {useDailysRecent} from '../contexts/DailysRecentContext.jsx';
import {useLayer} from '../contexts/LayerContext.jsx';
import {usePig} from '../contexts/PigContext.jsx';
import {useUI} from '../contexts/UIContext.jsx';
import InlineNotice from '../shared/InlineNotice.jsx';

const CHART_SERIES = Object.freeze([...ANIMAL_HISTORY_SPECIES, {key: 'total', label: 'Total', cssVar: '--brand'}]);

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

function AnimalHistoryLineChart({rows}) {
  const chronological = React.useMemo(() => [...(rows || [])].reverse(), [rows]);
  if (chronological.length === 0) {
    return (
      <div className="animal-history-empty" data-animal-history-chart-empty="true">
        No animal history is available yet.
      </div>
    );
  }

  const width = 920;
  const height = 320;
  const pad = {top: 18, right: 26, bottom: 52, left: 58};
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const rawMax = Math.max(1, ...chronological.flatMap((row) => CHART_SERIES.map((series) => row[series.key] || 0)));
  const stepBase = rawMax > 1000 ? 500 : rawMax > 250 ? 100 : rawMax > 100 ? 50 : rawMax > 50 ? 25 : 10;
  const maxValue = Math.max(stepBase, Math.ceil(rawMax / stepBase) * stepBase);
  const xFor = (idx) =>
    chronological.length === 1 ? pad.left + plotW / 2 : pad.left + (idx / (chronological.length - 1)) * plotW;
  const yFor = (value) => pad.top + plotH - ((value || 0) / maxValue) * plotH;
  const xStep = Math.max(1, Math.ceil(chronological.length / 6));
  const gridValues = [0, 0.25, 0.5, 0.75, 1].map((p) => Math.round(maxValue * p));

  return (
    <div className="animal-history-chart-scroll" data-animal-history-chart="line">
      <svg
        className="animal-history-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Animals on Farm monthly line chart"
      >
        {gridValues.map((value) => {
          const y = yFor(value);
          return (
            <g key={value}>
              <line x1={pad.left} y1={y} x2={width - pad.right} y2={y} className="animal-history-grid" />
              <text x={pad.left - 10} y={y + 4} className="animal-history-axis-label" textAnchor="end">
                {valueLabel(value)}
              </text>
            </g>
          );
        })}
        {chronological.map((row, idx) => {
          if (idx % xStep !== 0 && idx !== chronological.length - 1) return null;
          const x = xFor(idx);
          return (
            <g key={row.month}>
              <line x1={x} y1={pad.top} x2={x} y2={height - pad.bottom} className="animal-history-grid x" />
              <text x={x} y={height - 24} className="animal-history-axis-label" textAnchor="middle">
                {formatAnimalHistoryMonth(row.month)}
              </text>
            </g>
          );
        })}
        {CHART_SERIES.map((series) => {
          const points = chronological.map((row, idx) => ({x: xFor(idx), y: yFor(row[series.key] || 0)}));
          return (
            <g key={series.key} data-animal-history-series={series.key}>
              <polyline
                points={linePath(points)}
                fill="none"
                stroke={`var(${series.cssVar})`}
                strokeWidth={series.key === 'total' ? 3 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                className={series.key === 'total' ? 'animal-history-line is-total' : 'animal-history-line'}
              />
              {points.map((point, idx) => (
                <circle
                  key={chronological[idx].month}
                  cx={point.x}
                  cy={point.y}
                  r={series.key === 'total' ? 3.3 : 2.7}
                  fill={`var(${series.cssVar})`}
                  className="animal-history-point"
                />
              ))}
            </g>
          );
        })}
      </svg>
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
            <p>Month-end head count</p>
          </div>
          <div className="animal-history-latest" data-animal-history-latest-total>
            <span>{latest ? valueLabel(latest.total) : '-'}</span>
            <strong>Total</strong>
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
            <div className="card-label">Monthly Trend</div>
            {loading && <div className="animal-history-loading">Loading</div>}
          </div>
          <AnimalHistoryLineChart rows={rows} />
          <div className="animal-history-legend">
            {CHART_SERIES.map((series) => (
              <span key={series.key}>
                <i style={{background: `var(${series.cssVar})`}} />
                {series.label}
              </span>
            ))}
          </div>
        </section>

        <section className="card animal-history-table-card">
          <div className="stats-head">
            <div className="card-label">Monthly Counts</div>
            <div className="animal-history-row-count">{rows.length.toLocaleString()} months</div>
          </div>
          <div className="animal-history-table-wrap">
            <table className="animal-history-table" data-animal-history-table="true">
              <thead>
                <tr>
                  <th>Month</th>
                  {ANIMAL_HISTORY_SPECIES.map((species) => (
                    <th key={species.key}>{species.label}</th>
                  ))}
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.month}>
                    <td>
                      <strong>{formatAnimalHistoryMonth(row.month)}</strong>
                      <span>{row.snapshotDate}</span>
                    </td>
                    {ANIMAL_HISTORY_SPECIES.map((species) => (
                      <td key={species.key}>{valueLabel(row[species.key])}</td>
                    ))}
                    <td className="animal-history-total-cell">{valueLabel(row.total)}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={ANIMAL_HISTORY_SPECIES.length + 2}>No animal history is available yet.</td>
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
