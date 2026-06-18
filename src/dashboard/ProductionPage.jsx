import React from 'react';
import {Link} from 'react-router-dom';
import './homeRedesign.css';
import InlineNotice from '../shared/InlineNotice.jsx';
import {sb} from '../lib/supabase.js';
import {loadProductionSources} from '../lib/productionApi.js';
import {rowsToCsv, csvFilename, downloadCsv} from '../lib/csvExport.js';
import {
  PROGRAM_ACCENT_VAR,
  PROGRAM_BY_KEY,
  PAGE_PRODUCTION_PROGRAMS,
  buildProductionModel,
  buildProductionMatrix,
  buildProductionEventsView,
  formatEventQuantity,
  formatProductionNumber,
} from '../lib/production.js';

const TABS = [
  {key: 'summary', label: 'Summary'},
  {key: 'counted', label: 'Production Events'},
];

const EXTENDED_LIST_CONTROLS_ENABLED = false;

function programLabel(programKey) {
  return PROGRAM_BY_KEY[programKey]?.label.replace('/doz', '') || programKey;
}

function formatDate(date) {
  if (!date) return '--';
  const [y, m, d] = date.split('-');
  return `${m}/${d}/${y.slice(2)}`;
}

function num(programKey, quantity) {
  return quantity === null || quantity === undefined ? '--' : formatProductionNumber(programKey, quantity);
}

function ProgramDot({programKey}) {
  return <span className="prod-dot" style={{background: PROGRAM_ACCENT_VAR[programKey]}} aria-hidden="true" />;
}

function ProductionMatrix({matrix}) {
  const {years, rows} = matrix;
  return (
    <div className="production-matrix-wrap">
      <div className="production-matrix" role="table" aria-label="Production totals by program and year">
        <div className="pm-row pm-head" role="row">
          <span className="pm-program-head" role="columnheader">
            Program
          </span>
          {years.map((year) => (
            <span
              key={year}
              className={`pm-year-head tnum${year === matrix.latest ? ' is-latest' : ''}`}
              role="columnheader"
            >
              {year}
            </span>
          ))}
        </div>
        {rows.map((row) => (
          <div key={row.programKey} className="pm-row" role="row">
            <span className="pm-program" role="rowheader">
              <span className="prod-dot" style={{background: row.accent}} aria-hidden="true" />
              <span className="pm-program-name">{row.label}</span>
            </span>
            {row.cells.map((cell) => (
              <span key={cell.year} className={`pm-cell${cell.isLatest ? ' is-latest' : ''}`} role="cell">
                <span className={`pm-total tnum${cell.isLatest ? ' is-latest' : ''}`}>{cell.totalText}</span>
                <span className={`pm-delta pm-delta-${cell.deltaKind} tnum`}>{cell.deltaText}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <p className="production-matrix-foot">
        Eggs in dozens · YoY compares each program to its previous recorded year · “—” = no prior / not recorded that
        year
      </p>
    </div>
  );
}

function LedgerTable({rows}) {
  return (
    <div className="production-table-wrap">
      <table className="production-table production-ledger-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Program</th>
            <th>Batch / Event</th>
            <th>Quantity</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan="4" className="production-empty-cell">
                No records
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.id} style={{'--row-accent': PROGRAM_ACCENT_VAR[row.program]}}>
                <td>{formatDate(row.date)}</td>
                <td className="prod-program-cell">
                  <ProgramDot programKey={row.program} />
                  {programLabel(row.program)}
                </td>
                <td>
                  {row.recordPath ? (
                    <Link className="production-batch-link" to={row.recordPath} data-production-event-record-link="1">
                      {row.batchName || 'Open record'}
                    </Link>
                  ) : (
                    row.batchName || '--'
                  )}
                </td>
                <td>{formatEventQuantity(row.event)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function FilterBar({filters, setFilters, statusOptions}) {
  const update = (patch) => setFilters((prev) => ({...prev, ...patch}));
  return (
    <div className="production-filters">
      <label>
        <span>Program</span>
        <select value={filters.program} onChange={(e) => update({program: e.target.value})}>
          <option value="all">All</option>
          {PAGE_PRODUCTION_PROGRAMS.map((programKey) => (
            <option key={programKey} value={programKey}>
              {programLabel(programKey)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Status</span>
        <select value={filters.status} onChange={(e) => update({status: e.target.value})}>
          <option value="all">All</option>
          {statusOptions.map((opt) => (
            <option key={opt.status} value={opt.status}>
              {opt.statusLabel}
            </option>
          ))}
        </select>
      </label>
      <label className="production-filter-search">
        <span>Search</span>
        <input
          type="search"
          value={filters.search}
          placeholder="Batch or event"
          onChange={(e) => update({search: e.target.value})}
        />
      </label>
    </div>
  );
}

function applyFilters(rows, filters) {
  const search = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.program !== 'all' && row.program !== filters.program) return false;
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (search && !(row.batchName || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

const LEDGER_COLUMNS = [
  {key: 'date', header: 'Date'},
  {key: 'program', header: 'Program', value: (r) => programLabel(r.program)},
  {key: 'batchName', header: 'Batch / Event', value: (r) => r.batchName || ''},
  {key: 'quantity', header: 'Quantity', value: (r) => num(r.program, r.quantity)},
];

export default function ProductionPage({Header, setView}) {
  const [sources, setSources] = React.useState(null);
  const [tab, setTab] = React.useState('summary');
  const [filters, setFilters] = React.useState({program: 'all', status: 'all', search: ''});
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await loadProductionSources(sb);
      setSources(loaded);
    } catch (error) {
      setSources(null);
      setLoadError({
        kind: 'error',
        message:
          'Could not load production data. Please refresh the page. (' + ((error && error.message) || error) + ')',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const model = React.useMemo(() => buildProductionModel(sources || {}), [sources]);
  const matrix = React.useMemo(() => buildProductionMatrix(model), [model]);
  const eventRows = React.useMemo(() => buildProductionEventsView(model), [model]);

  const activeRows = eventRows;
  const statusOptions = React.useMemo(() => {
    const seen = new Map();
    for (const row of activeRows) if (row.status && !seen.has(row.status)) seen.set(row.status, row.statusLabel);
    return [...seen.entries()].map(([status, statusLabel]) => ({status, statusLabel}));
  }, [activeRows]);
  const effectiveFilters = EXTENDED_LIST_CONTROLS_ENABLED
    ? filters
    : {program: 'all', source: 'all', status: 'all', search: ''};
  const filteredRows = React.useMemo(() => applyFilters(activeRows, effectiveFilters), [activeRows, effectiveFilters]);

  const exportCsv = React.useCallback(() => {
    if (tab === 'summary') {
      const columns = [
        {key: 'program', header: 'Program', value: (r) => r.label},
        ...matrix.years.map((year) => ({
          key: year,
          header: year,
          value: (r) => r.cells.find((cell) => cell.year === year)?.totalText ?? '--',
        })),
      ];
      downloadCsv(csvFilename('production-summary'), rowsToCsv(columns, matrix.rows));
      return;
    }
    downloadCsv(csvFilename('production-events'), rowsToCsv(LEDGER_COLUMNS, filteredRows));
  }, [tab, matrix, filteredRows]);

  return (
    <div className="home theme-crisp production-page" data-production-loaded={loading ? 'false' : 'true'}>
      <Header />
      <main className="home-col production-col">
        <div className="production-topline">
          <button type="button" className="btn-clear" onClick={() => setView('home')}>
            Back to Home
          </button>
          <span>
            {loading
              ? 'Loading'
              : `${eventRows.length.toLocaleString()} processing event${eventRows.length === 1 ? '' : 's'}`}
          </span>
        </div>

        <section className="production-title">
          <div>
            <h1>Production</h1>
          </div>
          <button type="button" className="btn-clear" data-production-retry="1" onClick={load} disabled={loading}>
            {loadError ? 'Retry' : 'Refresh'}
          </button>
        </section>

        <InlineNotice notice={loadError} onDismiss={() => setLoadError(null)} />

        <div className="production-toolbar">
          <div className="production-tabs" role="tablist" aria-label="Production view">
            {TABS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                role="tab"
                aria-selected={tab === entry.key}
                className={`production-tab${tab === entry.key ? ' is-active' : ''}`}
                onClick={() => {
                  setTab(entry.key);
                  setFilters((prev) => ({...prev, status: 'all'}));
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          {EXTENDED_LIST_CONTROLS_ENABLED && (
            <button
              type="button"
              className="btn-clear production-export"
              onClick={exportCsv}
              disabled={loading || (tab !== 'summary' && filteredRows.length === 0)}
            >
              Export CSV
            </button>
          )}
        </div>

        {tab === 'summary' ? (
          <section className="card production-panel-card">
            <div className="stats-head">
              <div className="card-label">Program Totals</div>
              <span className="production-rowcount">all recorded years</span>
            </div>
            <ProductionMatrix matrix={matrix} />
          </section>
        ) : (
          <section className="card production-panel-card">
            <div className="stats-head">
              <div className="card-label">Production Events</div>
              <span className="production-rowcount">{filteredRows.length.toLocaleString()} rows</span>
            </div>
            <p className="production-help">Every processing event recorded across all years.</p>
            {EXTENDED_LIST_CONTROLS_ENABLED && (
              <FilterBar filters={filters} setFilters={setFilters} statusOptions={statusOptions} />
            )}
            <LedgerTable rows={filteredRows} />
          </section>
        )}
      </main>
    </div>
  );
}
