// ============================================================================
// src/processing/ProcessingCalendarView.jsx  —  Processing Calendar main page
// ----------------------------------------------------------------------------
// The native "Processing" page (Asana → WCF Planner). Every processing batch
// (Broiler / Cattle / Pig / Lamb) grouped by program section, sorted by planned
// processing date, opening a right-side record drawer. CP0-locked decisions
// override the HTML prototype where they conflict:
//   • Status is EXACTLY Planned / In Process / Complete via processingStatusDisplay,
//     rendered with the closed-set <Badge> (Planned→warn, In Process→ok,
//     Complete→neutral) — never the prototype's per-status hex chips.
//   • Programs are SECTIONS (no program dropdown); default sort processing_date
//     asc within each section; default view = current year; completed rows show.
//   • NO inline table editing — a row opens the drawer.
//   • Template editing is ADMIN ONLY; Add milestone is any operational role.
//   • Fail-closed loading: data-processing-loaded marker; rows/empty gated behind
//     !loadError; InlineNotice + Retry on failure; stale rows cleared on error.
//
// Data loads via listProcessingRecords (all years, one read) so the year dropdown
// can be DERIVED FROM the data and year switching is instant client-side; the
// selected year defaults to the current calendar year. Source-owned display
// (live status / number processed / age / time-on-farm) is resolved app-side via
// resolveSourceForRecord + deriveDisplayStatus; the live source collections are
// not loaded here (out of scope for the calendar), so resolution falls back to
// each row's stored columns + historical_snapshot — which is exactly what
// list_processing_records already returns.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {listProcessingRecords, getProcessingSettings, invokeProcessingAsanaSync} from '../lib/processingApi.js';
import {resolveSourceForRecord, deriveDisplayStatus} from '../lib/processingSourceLink.js';
import {processingStatusVariantFromLabel, PROCESSING_STATUS_DISPLAY} from '../lib/processingStatusDisplay.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
import {openableProps} from '../shared/openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ProcessingDrawer from './ProcessingDrawer.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import AddMilestoneModal from './AddMilestoneModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import ProcessingTemplatesModal from './ProcessingTemplatesModal.jsx';

// Program sections, in display order. `key` is the stored program string; note
// the Lamb section maps to the 'sheep' program (Lamb == sheep, CP0).
const PROGRAMS = [
  {key: 'broiler', label: 'Broiler', section: 'WCF Broiler Processing'},
  {key: 'cattle', label: 'Cattle', section: 'WCF Cattle Processing'},
  {key: 'pig', label: 'Pig', section: 'WCF Pig Processing'},
  {key: 'sheep', label: 'Lamb', section: 'WCF Lamb Processing'},
];
const OPERATIONAL_ROLES = ['admin', 'management', 'farm_team'];

// Prototype "Crisp" palette (design is high-fidelity / final).
const T = {
  page: '#F6F7F8',
  card: '#fff',
  border: '#E6E8EB',
  rowBorder: '#ECEEF0',
  tint: '#FAFBFB',
  hover: '#F4F9F7',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
  chipBg: '#F1F3F4',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function ymd(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? {y: +m[1], mo: +m[2], d: +m[3], iso: `${m[1]}-${m[2]}-${m[3]}`} : null;
}
function formatDate(value) {
  const p = ymd(value);
  return p ? `${MONTHS[p.mo - 1]} ${p.d}` : '—';
}
function yearOf(value) {
  const p = ymd(value);
  return p ? p.y : null;
}
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDaysISO(iso, days) {
  const [y, mo, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Unified grid: one global header + per-program rows keep the same columns.
// Customer is populated for broiler only; the Age/TOF column shows time-on-farm
// for broiler and age for the mammals (CP0).
const GRID = 'minmax(180px,1fr) 104px 96px 150px 84px 150px 108px 74px 20px';

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StatCard({label, value, sub, color}) {
  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: '15px 18px',
        boxShadow: '0 1px 2px rgba(20,30,40,.045)',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '.1em',
          textTransform: 'uppercase',
          color: T.label,
          marginBottom: 7,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 800,
          letterSpacing: '-.025em',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          color: color || T.ink,
        }}
      >
        {value}
      </div>
      {sub && <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 6}}>{sub}</div>}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- Header is a JSX-only prop component
export default function ProcessingCalendarView({Header, authState}) {
  const {useState, useEffect, useMemo, useCallback} = React;
  const role = authState?.role;
  const isAdmin = role === 'admin';
  const canOperate = OPERATIONAL_ROLES.includes(role);

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [programFilter, setProgramFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [processorFilter, setProcessorFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showCompleted, setShowCompleted] = useState(true);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [hoveredId, setHoveredId] = useState(null);

  const [openRecordId, setOpenRecordId] = useState(null);
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [addMilestoneProgram, setAddMilestoneProgram] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);

  // Admin-only, read-only sync-status pill (no live sync trigger from the UI).
  const [asanaSyncEnabled, setAsanaSyncEnabled] = useState(null);
  const [asanaConfigured, setAsanaConfigured] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await listProcessingRecords(sb, {year: null, includeArchived: false});
      setRecords(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setRecords([]); // clear stale rows on error (fail-closed)
      setLoadError({message: `Could not load the processing schedule. Please retry. (${(e && e.message) || e})`});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Best-effort admin sync-status probe. Never blocks or breaks the page.
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const settings = await getProcessingSettings(sb);
        if (!cancelled) setAsanaSyncEnabled(!!(settings && settings.asana_sync_enabled));
      } catch (_e) {
        /* leave unknown */
      }
      try {
        const probe = await invokeProcessingAsanaSync(sb, {probe: true});
        if (!cancelled) {
          const configured = probe && (probe.asanaConfigured ?? probe.configured ?? probe.ok);
          setAsanaConfigured(!!configured);
        }
      } catch (_e) {
        if (!cancelled) setAsanaConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Decorate every record with its resolved display facts once.
  const decorated = useMemo(() => {
    return records.map((rec) => {
      const sourceInfo = resolveSourceForRecord(rec, {}); // no live collections → snapshot fallback
      const statusLabel = deriveDisplayStatus(rec, sourceInfo);
      return {
        ...rec,
        _statusLabel: statusLabel,
        _statusVariant: processingStatusVariantFromLabel(statusLabel),
        _numberProcessed: sourceInfo.numberProcessed,
        _ageText: sourceInfo.ageText,
        _timeOnFarmText: sourceInfo.timeOnFarmText,
        _year: yearOf(rec.processing_date),
      };
    });
  }, [records]);

  // Year options derived from the data (undated rows ignored), plus the current
  // year so the default is always selectable even on an empty schedule.
  const yearOptions = useMemo(() => {
    const set = new Set([currentYear]);
    for (const r of decorated) if (r._year != null) set.add(r._year);
    return [...set].sort((a, b) => b - a);
  }, [decorated, currentYear]);

  // Rows for the selected year (undated rows show under any selected year so
  // they never vanish). This is the base set for the stat cards.
  const yearRows = useMemo(() => decorated.filter((r) => r._year == null || r._year === year), [decorated, year]);

  const processorOptions = useMemo(() => {
    const set = new Set();
    for (const r of yearRows) if (r.processor) set.add(r.processor);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [yearRows]);

  const typeOptions = useMemo(() => {
    const set = new Set();
    for (const r of yearRows) if (r.record_type) set.add(r.record_type);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [yearRows]);

  // Apply the non-program filters (status / processor / type / completed /
  // search) — program is applied per-section so the chip counts stay honest.
  const passesCommon = useCallback(
    (r) => {
      if (statusFilter !== 'all' && r._statusLabel !== statusFilter) return false;
      if (!showCompleted && r._statusLabel === PROCESSING_STATUS_DISPLAY.complete) return false;
      if (processorFilter !== 'all' && (r.processor || '') !== processorFilter) return false;
      if (typeFilter !== 'all' && r.record_type !== typeFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (
          !String(r.title || '')
            .toLowerCase()
            .includes(q)
        )
          return false;
      }
      return true;
    },
    [statusFilter, showCompleted, processorFilter, typeFilter, search],
  );

  const commonRows = useMemo(() => yearRows.filter(passesCommon), [yearRows, passesCommon]);

  // Per-program section buckets (sorted processing_date asc; undated last).
  const sections = useMemo(() => {
    return PROGRAMS.map((p) => {
      const rows = commonRows
        .filter((r) => (r.program || r.source_kind) === p.key)
        .sort((a, b) => {
          const ai = ymd(a.processing_date)?.iso || '9999-99-99';
          const bi = ymd(b.processing_date)?.iso || '9999-99-99';
          return ai.localeCompare(bi);
        });
      return {...p, rows};
    });
  }, [commonRows]);

  // Program chip counts (respect the common filters, ignore the program filter).
  const programCounts = useMemo(() => {
    const counts = {all: commonRows.length};
    for (const p of PROGRAMS) counts[p.key] = commonRows.filter((r) => (r.program || r.source_kind) === p.key).length;
    return counts;
  }, [commonRows]);

  // Stat cards (whole selected year, before the interactive filters narrow it).
  const stats = useMemo(() => {
    const scheduled = yearRows.length;
    const completed = yearRows.filter((r) => r._statusLabel === PROCESSING_STATUS_DISPLAY.complete).length;
    const t0 = todayISO();
    const t14 = addDaysISO(t0, 14);
    const dueSoon = yearRows.filter((r) => {
      const iso = ymd(r.processing_date)?.iso;
      if (!iso) return false;
      if (r._statusLabel === PROCESSING_STATUS_DISPLAY.complete) return false;
      return iso >= t0 && iso <= t14;
    }).length;
    const head = yearRows.reduce((s, r) => s + (num(r._numberProcessed) || 0), 0);
    return {scheduled, completed, dueSoon, head};
  }, [yearRows]);

  const visibleSections = programFilter === 'all' ? sections : sections.filter((s) => s.key === programFilter);
  const totalVisibleRows = visibleSections.reduce((s, sec) => s + sec.rows.length, 0);
  const loaded = !loading && !loadError;

  function toggleSection(key) {
    setCollapsed((c) => ({...c, [key]: !c[key]}));
  }
  function openAddMilestone(program) {
    setAddMilestoneProgram(program || null);
    setShowAddMilestone(true);
  }

  // ── row + cell renderers ────────────────────────────────────────────────────
  function customerChips(rec) {
    const list = Array.isArray(rec.customer) ? rec.customer : [];
    if (list.length === 0) return <span style={{color: T.faint}}>—</span>;
    return (
      <div style={{display: 'flex', gap: 5, minWidth: 0, overflow: 'hidden'}}>
        {list.map((c, i) => (
          <span
            key={i}
            title={String(c)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: T.muted,
              background: T.chipBg,
              borderRadius: 10,
              padding: '2px 7px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 140,
            }}
          >
            {String(c).split(' - ')[0]}
          </span>
        ))}
      </div>
    );
  }

  function renderRow(rec) {
    const active = hoveredId === rec.id || openRecordId === rec.id;
    const isMilestone = rec.record_type === 'milestone';
    const isBroiler = (rec.program || rec.source_kind) === 'broiler';
    const ageTof = isBroiler ? rec._timeOnFarmText : rec._ageText;
    const subTotal = rec.subtask_total ?? 0;
    const subDone = rec.subtask_done ?? 0;
    const numText = num(rec._numberProcessed) != null ? Number(rec._numberProcessed).toLocaleString() : '—';
    return (
      <div
        key={rec.id}
        data-processing-row={rec.id}
        {...openableProps(() => setOpenRecordId(rec.id))}
        onMouseEnter={() => setHoveredId(rec.id)}
        onMouseLeave={() => setHoveredId((h) => (h === rec.id ? null : h))}
        onFocus={() => setHoveredId(rec.id)}
        onBlur={() => setHoveredId((h) => (h === rec.id ? null : h))}
        style={{
          display: 'grid',
          gridTemplateColumns: GRID,
          alignItems: 'center',
          columnGap: 16,
          padding: '12px 16px',
          cursor: 'pointer',
          outline: 'none',
          position: 'relative',
          borderTop: `1px solid ${T.rowBorder}`,
          borderRadius: active ? 10 : 0,
          background: active ? (isMilestone ? '#F3F1FB' : T.hover) : T.card,
          transform: active ? 'translateY(-2px)' : 'translateY(0)',
          boxShadow: active ? '0 6px 18px rgba(20,40,30,.12)' : 'none',
          zIndex: active ? 3 : 0,
          transition: 'transform .16s ease, box-shadow .16s ease, background .16s ease',
        }}
      >
        {/* Batch / title */}
        <div style={{minWidth: 0}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
            {isMilestone && (
              <span
                aria-hidden="true"
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: 3 /* radius-allow: milestone diamond marker */,
                  background: '#6B5BD0',
                  transform: 'rotate(45deg)',
                  flex: 'none',
                }}
              />
            )}
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: isMilestone ? '#4B3FA8' : T.ink,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {rec.title || '(untitled)'}
            </span>
          </div>
          {isMilestone && <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 3}}>Milestone</div>}
        </div>
        {/* Status */}
        <span>
          <Badge variant={rec._statusVariant}>{rec._statusLabel}</Badge>
        </span>
        {/* Processing date */}
        <span style={{fontSize: 13.5, fontWeight: 700, color: T.ink, fontVariantNumeric: 'tabular-nums'}}>
          {formatDate(rec.processing_date)}
        </span>
        {/* Processor */}
        <span
          style={{
            fontSize: 13,
            color: rec.processor ? T.ink : T.faint,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {rec.processor || '—'}
        </span>
        {/* Number processed */}
        <span
          style={{
            fontSize: 13,
            color: numText === '—' ? T.faint : T.ink,
            fontWeight: 600,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {numText}
        </span>
        {/* Customer (broiler only) */}
        <span style={{minWidth: 0}}>{isBroiler ? customerChips(rec) : <span style={{color: T.faint}}>—</span>}</span>
        {/* Age / Time on farm */}
        <span style={{fontSize: 13, color: ageTof ? T.ink : T.faint, fontWeight: 600, whiteSpace: 'nowrap'}}>
          {ageTof || '—'}
        </span>
        {/* Subtask count */}
        <span
          style={{
            fontSize: 12.5,
            color: T.muted,
            fontWeight: 700,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {subTotal > 0 ? `${subDone}/${subTotal}` : '—'}
        </span>
        {/* Chevron (reveal on hover) */}
        <span
          aria-hidden="true"
          style={{
            color: T.faint,
            fontSize: 20,
            lineHeight: 1,
            fontWeight: 700,
            justifySelf: 'center',
            opacity: active ? 1 : 0,
            transform: active ? 'translateX(0)' : 'translateX(-5px)',
            transition: 'opacity .16s ease, transform .16s ease',
          }}
        >
          {'›'}
        </span>
      </div>
    );
  }

  const headerCellStyle = {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: T.faint,
  };

  const chipStyle = (selected, accent) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 12px',
    borderRadius: 999,
    fontSize: 12.5,
    fontWeight: selected ? 700 : 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    border: `1px solid ${selected ? accent : T.border}`,
    background: selected ? `${accent}14` : T.card,
    color: selected ? accent : T.muted,
  });

  const selectStyle = {
    fontSize: 12.5,
    fontWeight: 600,
    padding: '6px 10px',
    borderRadius: 10,
    border: `1px solid ${T.border}`,
    background: T.card,
    color: T.ink,
    fontFamily: 'inherit',
    cursor: 'pointer',
  };

  return (
    <div style={{minHeight: '100vh', background: T.page}}>
      <Header />
      <main
        data-surface="processing.calendar"
        data-processing-loaded={loaded ? '1' : '0'}
        style={{maxWidth: 1180, margin: '0 auto', padding: '26px 24px 70px'}}
      >
        {/* Title row */}
        <div style={{display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22, flexWrap: 'wrap'}}>
          <h1 style={{flex: 1, minWidth: 200, fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', color: T.ink}}>
            Processing schedule
          </h1>
          {isAdmin && (asanaSyncEnabled !== null || asanaConfigured !== null) && (
            <span
              data-processing-sync-status="1"
              title="Asana sync status (read-only)"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                fontWeight: 700,
                color: T.muted,
                background: T.tint,
                border: `1px solid ${T.border}`,
                borderRadius: 999,
                padding: '5px 12px',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: asanaSyncEnabled ? T.green : '#C8CDD3',
                  flex: 'none',
                }}
              />
              Asana sync {asanaSyncEnabled ? 'on' : 'off'}
              {asanaConfigured === false && ' · not configured'}
            </span>
          )}
          {isAdmin && (
            <button
              type="button"
              data-processing-templates-btn="1"
              onClick={() => setShowTemplates(true)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: T.card,
                color: T.muted,
                border: `1px solid ${T.border}`,
                borderRadius: 10,
                padding: '9px 14px',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Templates
            </button>
          )}
          {canOperate && (
            <button
              type="button"
              data-processing-add-milestone-btn="1"
              onClick={() => openAddMilestone(null)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: T.green,
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '10px 16px',
                fontSize: 13.5,
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                boxShadow: '0 1px 2px rgba(20,30,40,.12)',
                fontFamily: 'inherit',
              }}
            >
              + Add milestone
            </button>
          )}
        </div>

        {/* Stat cards */}
        <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 22}}>
          <StatCard label="Batches scheduled" value={stats.scheduled} sub={`in ${year}`} />
          <StatCard label="Completed" value={stats.completed} sub="processed & inventoried" color="#3F7A5B" />
          <StatCard label="Due in 14 days" value={stats.dueSoon} sub="nearing kill date" color="#8A6A1E" />
          <StatCard label="Head count" value={stats.head.toLocaleString()} sub="animals processed" />
        </div>

        {/* Program filter chips */}
        <div style={{display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12, flexWrap: 'wrap'}}>
          <button
            type="button"
            onClick={() => setProgramFilter('all')}
            style={chipStyle(programFilter === 'all', T.green)}
          >
            <span>All</span>
            <span style={{fontSize: 11, opacity: 0.85}}>{programCounts.all}</span>
          </button>
          {PROGRAMS.map((p) => (
            <button
              key={p.key}
              type="button"
              data-processing-program-chip={p.key}
              onClick={() => setProgramFilter(p.key)}
              style={chipStyle(programFilter === p.key, getProgramColor(p.key))}
            >
              <span style={programDotStyle(p.key)} />
              <span>{p.label}</span>
              <span style={{fontSize: 11, opacity: 0.85}}>{programCounts[p.key]}</span>
            </button>
          ))}
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 12.5,
              color: T.faint,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            Sorted by planned processing date
          </span>
        </div>

        {/* Secondary filter row */}
        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap'}}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: T.label,
              fontWeight: 600,
            }}
          >
            Year
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              style={selectStyle}
              data-processing-year
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={selectStyle}
            data-processing-status-filter
          >
            <option value="all">All statuses</option>
            <option value={PROCESSING_STATUS_DISPLAY.planned}>Planned</option>
            <option value={PROCESSING_STATUS_DISPLAY.inProcess}>In Process</option>
            <option value={PROCESSING_STATUS_DISPLAY.complete}>Complete</option>
          </select>
          <select
            value={processorFilter}
            onChange={(e) => setProcessorFilter(e.target.value)}
            style={selectStyle}
            data-processing-processor-filter
          >
            <option value="all">All processors</option>
            {processorOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          {typeOptions.length > 1 && (
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              style={selectStyle}
              data-processing-type-filter
            >
              <option value="all">All record types</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          )}
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12.5,
              color: T.muted,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              data-processing-show-completed
            />
            Show completed
          </label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title…"
            data-processing-search
            style={{
              marginLeft: 'auto',
              fontSize: 12.5,
              padding: '7px 11px',
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: T.card,
              color: T.ink,
              fontFamily: 'inherit',
              minWidth: 180,
            }}
          />
        </div>

        {/* Load error (fail-closed) */}
        {loadError && (
          <div data-processing-load-error="1">
            <InlineNotice notice={{kind: 'error', message: loadError.message}} />
            <button
              type="button"
              onClick={load}
              style={{
                padding: '8px 14px',
                borderRadius: 10,
                border: '1px solid #b91c1c',
                background: '#b91c1c',
                color: '#fff',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* List card */}
        {!loadError && (
          <div style={{overflowX: 'auto'}}>
            <div
              style={{
                minWidth: 980,
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 16,
                boxShadow: '0 1px 2px rgba(20,30,40,.05)',
                overflow: 'hidden',
              }}
            >
              {/* Column header */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  columnGap: 16,
                  padding: '12px 16px',
                  background: T.tint,
                  borderBottom: `1px solid ${T.border}`,
                }}
              >
                <span style={headerCellStyle}>Batch</span>
                <span style={headerCellStyle}>Status</span>
                <span style={headerCellStyle}>Processing</span>
                <span style={headerCellStyle}>Processor</span>
                <span style={{...headerCellStyle, textAlign: 'right'}}>Number</span>
                <span style={headerCellStyle}>Customer</span>
                <span style={headerCellStyle}>Age / TOF</span>
                <span style={{...headerCellStyle, textAlign: 'right'}}>Subtasks</span>
                <span />
              </div>

              {loading && (
                <div style={{padding: '28px 16px', textAlign: 'center', color: T.faint, fontSize: 13, fontWeight: 600}}>
                  Loading the processing schedule…
                </div>
              )}

              {loaded && totalVisibleRows === 0 && (
                <div
                  data-processing-empty="1"
                  style={{padding: '40px 16px', textAlign: 'center', color: T.faint, fontSize: 14, fontWeight: 600}}
                >
                  No processing records match the current filters.
                </div>
              )}

              {loaded &&
                visibleSections.map((sec) => {
                  if (sec.rows.length === 0 && programFilter === 'all') return null;
                  const isCollapsed = !!collapsed[sec.key];
                  return (
                    <div key={sec.key} data-processing-section={sec.key}>
                      <div
                        {...openableProps(() => toggleSection(sec.key))}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '11px 16px',
                          background: T.tint,
                          borderTop: `1px solid ${T.border}`,
                          cursor: 'pointer',
                          outline: 'none',
                        }}
                      >
                        <span style={programDotStyle(sec.key, 10)} />
                        <span style={{fontSize: 13.5, fontWeight: 800, color: T.ink, letterSpacing: '.005em'}}>
                          {sec.section}
                        </span>
                        <span style={{fontSize: 12, color: T.label, fontWeight: 600}}>
                          {sec.rows.length} {sec.rows.length === 1 ? 'batch' : 'batches'}
                        </span>
                        <span
                          aria-hidden="true"
                          style={{
                            marginLeft: 'auto',
                            color: T.faint,
                            fontSize: 14,
                            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                            transition: 'transform .16s ease',
                          }}
                        >
                          {'▾'}
                        </span>
                      </div>
                      {!isCollapsed && sec.rows.map((rec) => renderRow(rec))}
                      {!isCollapsed && canOperate && (
                        <div
                          {...openableProps(() => openAddMilestone(sec.key))}
                          data-processing-section-add={sec.key}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 9,
                            padding: '11px 16px',
                            borderTop: `1px solid ${T.rowBorder}`,
                            cursor: 'pointer',
                            color: T.faint,
                            fontSize: 13,
                            fontWeight: 600,
                            outline: 'none',
                          }}
                        >
                          + Add milestone…
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
      </main>

      {openRecordId && (
        <ProcessingDrawer
          sb={sb}
          authState={authState}
          recordId={openRecordId}
          onClose={() => setOpenRecordId(null)}
          onChanged={load}
        />
      )}
      {showAddMilestone && (
        <AddMilestoneModal
          initialProgram={addMilestoneProgram}
          onClose={() => setShowAddMilestone(false)}
          onCreated={(id) => {
            setShowAddMilestone(false);
            load();
            if (id) setOpenRecordId(id);
          }}
        />
      )}
      {showTemplates && <ProcessingTemplatesModal authState={authState} onClose={() => setShowTemplates(false)} />}
    </div>
  );
}
