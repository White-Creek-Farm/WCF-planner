import React from 'react';
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
  buildProductionSummary,
  buildProductionLedger,
  buildProductionAuditView,
  formatEventQuantity,
  formatProductionDelta,
  formatProductionNumber,
  totalsForYear,
} from '../lib/production.js';

const TABS = [
  {key: 'summary', label: 'Summary'},
  {key: 'counted', label: 'Counted Events'},
  {key: 'reconcile', label: 'Reconciliation'},
];

const SOURCE_LABEL = {planner: 'Planner', legacy: 'Legacy spreadsheet'};

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

function SummaryTable({rows}) {
  return (
    <div className="production-table-wrap">
      <table className="production-table production-summary-table">
        <thead>
          <tr>
            <th>Program</th>
            <th>Counted</th>
            <th>Planner</th>
            <th>Legacy backfill</th>
            <th>Held out</th>
            <th>Conflict</th>
            <th>YoY</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.programKey} style={{'--row-accent': row.accent}}>
              <td className="prod-program-cell">
                <ProgramDot programKey={row.programKey} />
                {programLabel(row.programKey)}
              </td>
              <td className="prod-counted-col">{num(row.programKey, row.counted)}</td>
              <td>{num(row.programKey, row.plannerCounted)}</td>
              <td>{row.legacyCounted ? num(row.programKey, row.legacyCounted) : '--'}</td>
              <td>{row.heldOut ? num(row.programKey, row.heldOut) : '--'}</td>
              <td className={row.conflict ? 'is-down' : undefined}>
                {row.conflict ? num(row.programKey, row.conflict) : '--'}
              </td>
              <td className={row.yoy > 0 ? 'is-up' : row.yoy < 0 ? 'is-down' : undefined}>
                {row.yoy === null || row.yoy === undefined ? '--' : formatProductionDelta(row.programKey, row.yoy)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
            <th>Source</th>
            <th>Counted</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan="8" className="production-empty-cell">
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
                <td>{row.batchName || '--'}</td>
                <td>{formatEventQuantity(row.event)}</td>
                <td>{SOURCE_LABEL[row.source] || row.source}</td>
                <td>
                  <span className={`badge-soft ${row.counted ? 'badge-ok' : 'badge-warn'}`}>
                    {row.counted ? 'Counted' : 'Held out'}
                  </span>
                </td>
                <td>
                  <span className={`badge-soft badge-${row.tone}`}>{row.statusLabel}</span>
                </td>
                <td className="prod-reason-cell">{row.reason}</td>
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
        <span>Source</span>
        <select value={filters.source} onChange={(e) => update({source: e.target.value})}>
          <option value="all">All</option>
          <option value="planner">Planner</option>
          <option value="legacy">Legacy spreadsheet</option>
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
    if (filters.source !== 'all' && row.source !== filters.source) return false;
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (search && !(row.batchName || '').toLowerCase().includes(search)) return false;
    return true;
  });
}

const SUMMARY_COLUMNS = [
  {key: 'label', header: 'Program', value: (r) => programLabel(r.programKey)},
  {key: 'counted', header: 'Counted', value: (r) => num(r.programKey, r.counted)},
  {key: 'plannerCounted', header: 'Planner', value: (r) => num(r.programKey, r.plannerCounted)},
  {key: 'legacyCounted', header: 'Legacy backfill', value: (r) => num(r.programKey, r.legacyCounted)},
  {key: 'heldOut', header: 'Held out', value: (r) => num(r.programKey, r.heldOut)},
  {key: 'conflict', header: 'Conflict', value: (r) => num(r.programKey, r.conflict)},
  {
    key: 'yoy',
    header: 'YoY',
    value: (r) => (r.yoy === null || r.yoy === undefined ? '' : formatProductionDelta(r.programKey, r.yoy)),
  },
];

const LEDGER_COLUMNS = [
  {key: 'date', header: 'Date'},
  {key: 'program', header: 'Program', value: (r) => programLabel(r.program)},
  {key: 'batchName', header: 'Batch / Event', value: (r) => r.batchName || ''},
  {key: 'quantity', header: 'Quantity', value: (r) => num(r.program, r.quantity)},
  {key: 'source', header: 'Source', value: (r) => SOURCE_LABEL[r.source] || r.source},
  {key: 'counted', header: 'Counted', value: (r) => (r.counted ? 'Yes' : 'No')},
  {key: 'status', header: 'Status', value: (r) => r.statusLabel},
  {key: 'reason', header: 'Reason'},
];

export default function ProductionPage({Header, setView}) {
  const currentYear = String(new Date().getFullYear());
  const [sources, setSources] = React.useState(null);
  const [selectedYear, setSelectedYear] = React.useState(currentYear);
  const [tab, setTab] = React.useState('summary');
  const [filters, setFilters] = React.useState({program: 'all', source: 'all', status: 'all', search: ''});
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
  const years = React.useMemo(() => {
    const all = new Set(model.years);
    all.add(currentYear);
    return [...all].sort();
  }, [model.years, currentYear]);

  const selectedTotals = totalsForYear(model.events, selectedYear);
  const yearEvents = model.events.filter((event) => event.year === selectedYear);
  const processingCount = yearEvents.filter((event) => event.program !== 'egg').length;
  const eggDayCount = yearEvents.filter((event) => event.program === 'egg').length;
  const summaryRows = React.useMemo(() => buildProductionSummary(model, selectedYear), [model, selectedYear]);
  const ledgerRows = React.useMemo(() => buildProductionLedger(model, selectedYear), [model, selectedYear]);
  const auditRows = React.useMemo(() => buildProductionAuditView(model, selectedYear), [model, selectedYear]);

  const activeRows = tab === 'reconcile' ? auditRows : ledgerRows;
  const statusOptions = React.useMemo(() => {
    const seen = new Map();
    for (const row of activeRows) if (!seen.has(row.status)) seen.set(row.status, row.statusLabel);
    return [...seen.entries()].map(([status, statusLabel]) => ({status, statusLabel}));
  }, [activeRows]);
  const filteredRows = React.useMemo(() => applyFilters(activeRows, filters), [activeRows, filters]);

  const exportCsv = React.useCallback(() => {
    const isSummary = tab === 'summary';
    const columns = isSummary ? SUMMARY_COLUMNS : LEDGER_COLUMNS;
    const data = isSummary ? summaryRows : filteredRows;
    const csv = rowsToCsv(columns, data);
    downloadCsv(csvFilename(`production-${tab}-${selectedYear}`), csv);
  }, [tab, summaryRows, filteredRows, selectedYear]);

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
              : `${processingCount.toLocaleString()} processing event${processingCount === 1 ? '' : 's'} · ` +
                `${eggDayCount.toLocaleString()} egg-day record${eggDayCount === 1 ? '' : 's'} (${selectedYear})`}
          </span>
        </div>

        <section className="production-title">
          <div>
            <h1>Production</h1>
          </div>
          <label className="production-year-picker">
            <span>Year</span>
            <select
              value={selectedYear}
              onChange={(event) => {
                setSelectedYear(event.target.value);
                // A status only valid for the old year (e.g. conflict) must not
                // persist and silently empty the new year's table.
                setFilters((prev) => ({...prev, status: 'all'}));
              }}
            >
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>
        </section>

        <InlineNotice notice={loadError} onDismiss={() => setLoadError(null)} />

        <section className="card stats production-year-card">
          <div className="stats-head">
            <div className="card-label">Production - {selectedYear}</div>
            <button type="button" className="btn-clear" data-production-retry="1" onClick={load} disabled={loading}>
              {loadError ? 'Retry' : 'Refresh'}
            </button>
          </div>
          <div className="stat-row" data-home-grid="production">
            {['broiler', 'egg', 'pig', 'cattle', 'sheep'].map((programKey) => (
              <div className="stat" key={programKey}>
                <div className="stat-n">
                  {selectedTotals.has(programKey)
                    ? formatProductionNumber(programKey, selectedTotals.get(programKey))
                    : '--'}
                </div>
                <div className="stat-l">
                  <span className={`sdot sdot-${programKey === 'egg' ? 'layer' : programKey}`} />
                  {programLabel(programKey)}
                </div>
              </div>
            ))}
          </div>
        </section>

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
                  // Status options are per-tab; carrying one over can leave an
                  // invalid filter that blanks the table. Program/source/search
                  // stay since they are valid across tabs.
                  setFilters((prev) => ({...prev, status: 'all'}));
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn-clear production-export"
            onClick={exportCsv}
            disabled={loading || (tab !== 'summary' && filteredRows.length === 0)}
          >
            Export CSV
          </button>
        </div>

        {tab === 'summary' ? (
          <section className="card production-panel-card">
            <div className="stats-head">
              <div className="card-label">Program Totals - {selectedYear}</div>
            </div>
            <p className="production-help">
              Counted = Planner records plus legacy backfill for years before Planner tracked a program. Where Planner
              has records, Planner wins and the legacy rows are held out (Conflict is a subset of Held out, not an extra
              bucket). YoY is within each program. Eggs come from the Planner daily counts.
            </p>
            <SummaryTable rows={summaryRows} />
          </section>
        ) : (
          <section className="card production-panel-card">
            <div className="stats-head">
              <div className="card-label">
                {tab === 'counted' ? 'Counted Events' : 'Reconciliation / Audit'} - {selectedYear}
              </div>
              <span className="production-rowcount">{filteredRows.length.toLocaleString()} rows</span>
            </div>
            <p className="production-help">
              {tab === 'counted'
                ? 'Every event that contributes to the per-program totals above, with its reconciliation status.'
                : 'Every legacy backfill row and whether it counted or was held out so Planner wins, with the reason.'}
            </p>
            <FilterBar filters={filters} setFilters={setFilters} statusOptions={statusOptions} />
            <LedgerTable rows={filteredRows} />
          </section>
        )}
      </main>
    </div>
  );
}
