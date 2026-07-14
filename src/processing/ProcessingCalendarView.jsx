// ============================================================================
// src/processing/ProcessingCalendarView.jsx  —  Processing Calendar main page
// ----------------------------------------------------------------------------
// The native "Processing" page. Every processing batch (Broiler / Cattle /
// Pig / Lamb) grouped by program section, opening a right-side record drawer.
//
// Planner-integration lane: the generic configurable column grid is replaced
// by FIXED program-specific tables. Source facts render from each row's
// `record.source` LIVE planner projection (mig 176) with record-column
// fallback; status is the server-derived `effective_status`; every missing
// source value renders the canonical 'Not recorded' (never estimated).
//   • Columns per program (no Farm arrival column anywhere; the count column
//     is labelled 'Count' — 'Number' never appears):
//       broiler  Batch · Status · Hatch date · Processing date · Processor ·
//                Count · Customer
//       cattle   Batch · Status · Processing date · Processor · Count · Age
//       sheep    (as cattle; section labelled 'Lamb')
//       pig      Trip · Batch · Status · Processing date · Processor · Count ·
//                Age
//   • Status is the closed <Badge> set via processingStatusDisplay; pig
//     PLANNED rows add the soft pigPlanSignal ('Auto-planned' / 'Processor
//     scheduled') as muted <StatusText> under the badge — never a Badge.
//   • Processor renders as an outlined neutral pill, Customer (broiler-only)
//     as a soft gray-filled pill — neither is a Badge, neither takes program
//     accent color.
//   • Default order inside each section: processing_date ascending regardless
//     of status, so completed rows stay in their schedule slot — sortProcessingRecordsForDisplay.
//   • Search filters on the server-provided record.search_text (batch / trip /
//     tags / processor / customer), falling back to the title.
//   • Deep links (contract shared with src/lib/processingNav.js):
//     ?record=<id> opens that drawer after the first successful load;
//     ?source=<kind>:<sourceId> (pig source ids contain ':') opens the matching
//     record; the 'wcf-processing-open-record' CustomEvent opens a drawer
//     without a remount. Opening/closing the drawer history.replaceState's the
//     ?record param on/off (pathname + other params intact);
//     data-processing-deeplink-ready="1" is set once param handling has run.
//
// Kept from the previous surface: page shell, data-processing-loaded marker,
// InlineNotice + Retry fail-closed load (stale rows cleared on error),
// ensureProcessingFreshness BEFORE list, program sections ('WCF <X> Processing'
// titles, collapsible, sheep labelled 'Lamb'), admin Templates button, Add
// milestone (global), program filter chips, year select, search,
// stat cards, openableProps row-open + drawer mount pattern, sticky Batch
// column inside the horizontal scroller.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {listProcessingRecords, getProcessingSettings, ensureProcessingFreshness} from '../lib/processingApi.js';
import {loadEligibleProfilesById} from '../lib/tasksCenterApi.js';
import {recordAgeText, displayOrNotRecorded, pigPlanSignal, NOT_RECORDED} from '../lib/processingSourceLink.js';
import {
  processingStatusLabel,
  processingStatusVariantFromLabel,
  PROCESSING_STATUS_DISPLAY,
} from '../lib/processingStatusDisplay.js';
import {sortProcessingRecordsForDisplay} from '../lib/processingDisplaySort.js';
import {PROCESSING_OPEN_RECORD_EVENT} from '../lib/processingNav.js';
import {programDotStyle, getProgramColor} from '../lib/programColors.js';
import {openableProps} from '../shared/openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import StatusText from '../shared/StatusText.jsx';
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
  return p ? `${MONTHS[p.mo - 1]} ${p.d}` : null;
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

// ── Fixed per-program tables ─────────────────────────────────────────────────
// One column vocabulary, composed per program. Sticky columns pin during
// horizontal scroll: the 20px completion-check pins at left:0; each sticky
// column's left offset accumulates fixed widths + the 16px column gap (only
// fixed-px columns may precede another sticky column). The LAST sticky column
// carries the divider shadow.
const COLS = {
  trip: {key: 'trip', label: 'Trip', width: '64px', sticky: true},
  batch: {key: 'batch', label: 'Batch', width: 'minmax(190px,1fr)', sticky: true},
  status: {key: 'status', label: 'Status', width: '112px'},
  hatch: {key: 'hatch', label: 'Hatch date', width: '92px'},
  processing: {key: 'processing', label: 'Processing date', width: '96px'},
  processor: {key: 'processor', label: 'Processor', width: '140px'},
  count: {key: 'count', label: 'Count', width: '64px', align: 'right'},
  customer: {key: 'customer', label: 'Customer', width: '150px'},
  age: {key: 'age', label: 'Age', width: '140px'},
};

const PROGRAM_TABLES = (() => {
  const layouts = {
    broiler: ['batch', 'status', 'hatch', 'processing', 'processor', 'count', 'customer'],
    cattle: ['batch', 'status', 'processing', 'processor', 'count', 'age'],
    pig: ['trip', 'batch', 'status', 'processing', 'processor', 'count', 'age'],
    sheep: ['batch', 'status', 'processing', 'processor', 'count', 'age'],
  };
  const out = {};
  for (const [program, keys] of Object.entries(layouts)) {
    let left = 36; // 20px check column + 16px column gap
    const columns = keys.map((k) => {
      const col = {...COLS[k]};
      if (col.sticky) {
        col.left = left;
        const px = /^\d+(\.\d+)?px$/.test(col.width) ? parseFloat(col.width) : null;
        if (px != null) left += px + 16;
      }
      return col;
    });
    for (let i = columns.length - 1; i >= 0; i--) {
      if (columns[i].sticky) {
        columns[i].lastSticky = true;
        break;
      }
    }
    out[program] = {columns, grid: `20px ${columns.map((c) => c.width).join(' ')} 20px`};
  }
  return out;
})();

function stickyCellStyle(left, background, lastSticky) {
  return {
    position: 'sticky',
    left,
    zIndex: 2,
    background,
    ...(lastSticky ? {paddingRight: 12, boxShadow: `1px 0 0 ${T.rowBorder}`} : {}),
  };
}

// ── cell renderers (module-level; every missing batch value = 'Not recorded') ─
// eslint-disable-next-line no-unused-vars -- JSX-only use
function NotRecordedText() {
  return <span style={{fontSize: 12, color: T.faint, fontWeight: 600}}>{NOT_RECORDED}</span>;
}
// eslint-disable-next-line no-unused-vars -- JSX-only use
function DashText() {
  return <span style={{color: T.faint}}>—</span>;
}

function renderDateCell(value, {milestone = false, strong = false} = {}) {
  const text = formatDate(value);
  if (!text) return milestone ? <DashText /> : <NotRecordedText />;
  return (
    <span
      style={{
        fontSize: strong ? 13.5 : 13,
        fontWeight: strong ? 700 : 600,
        color: strong ? T.ink : T.muted,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {text}
    </span>
  );
}

// Processor: outlined neutral pill (NOT a Badge, no program accent).
function renderProcessorCell(rec) {
  if (!rec.processor) return rec._isMilestone ? <DashText /> : <NotRecordedText />;
  return (
    <span
      title={String(rec.processor)}
      style={{
        display: 'inline-block',
        fontSize: 11,
        fontWeight: 600,
        color: T.muted,
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 10,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}
    >
      {rec.processor}
    </span>
  );
}

// Customer (broiler-only): soft gray-filled pills (NOT a Badge, no accent).
function renderCustomerCell(rec) {
  const list = Array.isArray(rec.customer) ? rec.customer : [];
  if (list.length === 0) return rec._isMilestone ? <DashText /> : <NotRecordedText />;
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
            padding: '2px 8px',
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

function renderStatusCell(rec) {
  const signal = rec._isMilestone ? null : pigPlanSignal(rec);
  return (
    <span style={{minWidth: 0}}>
      <Badge variant={rec._statusVariant}>{rec._statusLabel}</Badge>
      {signal && (
        <span data-processing-pig-signal={rec.id} style={{display: 'block', marginTop: 3}}>
          <StatusText tone="muted" style={{fontSize: 11}}>
            {signal}
          </StatusText>
        </span>
      )}
    </span>
  );
}

function renderTripCell(rec) {
  if (rec._isMilestone) return <DashText />;
  if (rec.trip_ordinal == null) return <NotRecordedText />;
  return (
    <span
      style={{fontSize: 13, fontWeight: 700, color: T.ink, whiteSpace: 'nowrap'}}
    >{`Trip ${rec.trip_ordinal}`}</span>
  );
}

function renderCountCell(rec) {
  if (rec._isMilestone) return <DashText />;
  const n = num(rec._count);
  if (n == null) return <NotRecordedText />;
  return (
    <span style={{fontSize: 13, color: T.ink, fontWeight: 600, fontVariantNumeric: 'tabular-nums'}}>
      {n.toLocaleString()}
    </span>
  );
}

function renderAgeCell(rec) {
  if (rec._isMilestone) return <DashText />;
  const text = recordAgeText(rec);
  if (!text) return <NotRecordedText />;
  return (
    <span
      title={text}
      style={{
        display: 'inline-block',
        fontSize: 13,
        color: T.ink,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}
    >
      {text}
    </span>
  );
}

function renderBatchCell(rec) {
  const isMilestone = rec._isMilestone;
  const name = isMilestone ? rec.title || '(untitled)' : displayOrNotRecorded(rec._src?.batch_name ?? rec.title);
  const checklistMeta =
    !isMilestone && rec.subtask_total > 0
      ? `${rec.subtask_total}-step checklist · ${rec.subtask_done}/${rec.subtask_total}`
      : null;
  return (
    <>
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
            color: isMilestone ? '#4B3FA8' : rec._isComplete ? T.faint : T.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {name}
        </span>
      </div>
      {(isMilestone || checklistMeta) && (
        <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 3}}>
          {isMilestone ? 'Milestone' : checklistMeta}
        </div>
      )}
    </>
  );
}

function renderCell(col, rec) {
  switch (col.key) {
    case 'trip':
      return renderTripCell(rec);
    case 'batch':
      return renderBatchCell(rec);
    case 'status':
      return renderStatusCell(rec);
    case 'hatch':
      return renderDateCell(rec._isMilestone ? null : rec._src?.hatch_date, {milestone: rec._isMilestone});
    case 'processing':
      return renderDateCell(
        rec._isMilestone ? rec.processing_date : (rec._src?.processing_date ?? rec.processing_date),
        {
          milestone: rec._isMilestone,
          strong: true,
        },
      );
    case 'processor':
      return renderProcessorCell(rec);
    case 'count':
      return renderCountCell(rec);
    case 'customer':
      return renderCustomerCell(rec);
    case 'age':
      return renderAgeCell(rec);
    default:
      return <DashText />;
  }
}

// ── deep-link param reader (?record=<id> / ?source=<kind>:<sourceId>) ────────
// The source value splits on the FIRST colon only — pig source ids themselves
// contain a colon (groupId:tripId).
function readDeepLinkParams() {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const record = params.get('record');
    if (record) return {recordId: record};
    const source = params.get('source') || '';
    const sep = source.indexOf(':');
    if (sep > 0 && sep < source.length - 1) {
      return {sourceKind: source.slice(0, sep), sourceId: source.slice(sep + 1)};
    }
  } catch (_e) {
    /* malformed URL — treated as no deep link */
  }
  return null;
}

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
  const {useState, useEffect, useMemo, useCallback, useRef} = React;
  const role = authState?.role;
  const isAdmin = role === 'admin';
  const canOperate = OPERATIONAL_ROLES.includes(role);

  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [programFilter, setProgramFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState({});
  const [hoveredId, setHoveredId] = useState(null);

  const [openRecordId, setOpenRecordId] = useState(null);
  const [showAddMilestone, setShowAddMilestone] = useState(false);
  const [addMilestoneProgram, setAddMilestoneProgram] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  // Server-backed Customer/Processor picker choices — stable {id,label,active}
  // objects (mig 175). Passed RAW to the drawer + modals; each consumer reads
  // them through the shape-tolerant helpers in processingFields.js.
  const [optionLists, setOptionLists] = useState({processor: [], customer: []});
  // Deep-link params are captured ONCE, synchronously on first render (before
  // any load resolves), then consumed by the first successful load.
  const pendingDeepLink = useRef(undefined);
  if (pendingDeepLink.current === undefined) pendingDeepLink.current = readDeepLinkParams();
  const [deeplinkReady, setDeeplinkReady] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Automatic planner freshness (mig 164/176): reconcile the four planner
      // programs when stale so new/changed/removed planner batches appear
      // without any admin maintenance. Debounced + advisory-locked server-side;
      // a failure here must NEVER block the list (last reconciled state shows).
      try {
        await ensureProcessingFreshness(sb);
      } catch (_e) {
        /* tolerated — the list still renders from the last reconciled state */
      }
      const rows = await listProcessingRecords(sb, {year: null, includeArchived: false});
      const list = Array.isArray(rows) ? rows : [];
      setRecords(list);
      // Apply the one-shot deep link after the FIRST successful load. A
      // ?record id opens directly (the drawer fetches by id); a ?source link
      // must resolve to a loaded record's id.
      const pending = pendingDeepLink.current;
      if (pending) {
        pendingDeepLink.current = null;
        if (pending.recordId) {
          setOpenRecordId(pending.recordId);
        } else {
          const match = list.find(
            (r) => r.source_kind === pending.sourceKind && String(r.source_id) === pending.sourceId,
          );
          if (match) setOpenRecordId(match.id);
        }
      }
      setDeeplinkReady(true);
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

  // Narrow checklist patch from the drawer: update ONE row's subtask counts in
  // place. A checkbox toggle must never reload the schedule or flip
  // data-processing-loaded back to its loading state — the full load() stays
  // reserved for mutations that change enumeration (add/complete/archive/…).
  const patchRecordSubtaskCounts = useCallback((recordId, counts) => {
    setRecords((rows) =>
      rows.map((r) => (r.id === recordId ? {...r, subtask_done: counts.done, subtask_total: counts.total} : r)),
    );
  }, []);

  // Drawer-open deep links from an already-mounted view (Header notification
  // rows, My Tasks, native batch pages — see src/lib/processingNav.js).
  useEffect(() => {
    const onOpen = (e) => {
      const id = e && e.detail && e.detail.recordId;
      if (id) setOpenRecordId(String(id));
    };
    window.addEventListener(PROCESSING_OPEN_RECORD_EVENT, onOpen);
    return () => window.removeEventListener(PROCESSING_OPEN_RECORD_EVENT, onOpen);
  }, []);

  // Mirror the open drawer into the ?record param (replaceState — no history
  // spam) once the inbound params have been consumed. Pathname and unrelated
  // params stay intact; the one-shot ?source inbound param is retired here.
  useEffect(() => {
    if (!deeplinkReady) return;
    const url = new URL(window.location.href);
    if (openRecordId) url.searchParams.set('record', String(openRecordId));
    else url.searchParams.delete('record');
    url.searchParams.delete('source');
    const qs = url.searchParams.toString();
    const next = url.pathname + (qs ? `?${qs}` : '') + url.hash;
    const current = window.location.pathname + window.location.search + window.location.hash;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [openRecordId, deeplinkReady]);

  // Profile directory for the drawer/milestone people pickers (checklist
  // assignees; list_eligible_assignees: id + full_name only). Best-effort:
  // names degrade to the imported display-name fallback when unavailable.
  const [profilesById, setProfilesById] = useState({});
  useEffect(() => {
    if (!canOperate) return;
    let cancelled = false;
    loadEligibleProfilesById(sb)
      .then((map) => {
        if (!cancelled) setProfilesById(map || {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [canOperate]);

  // Customer/Processor picker choices come from settings (mig 175). Available
  // to every operational role (get_processing_settings is operational-gated).
  const refreshOptionLists = useCallback(
    async (cancelledRef = {current: false}) => {
      if (!canOperate) return;
      try {
        const settings = await getProcessingSettings(sb);
        if (cancelledRef.current) return;
        setOptionLists({
          processor: Array.isArray(settings?.processor_options) ? settings.processor_options : [],
          customer: Array.isArray(settings?.customer_options) ? settings.customer_options : [],
        });
      } catch (_e) {
        /* leave defaults; pickers fall back to seeded constants */
      }
    },
    [canOperate],
  );
  useEffect(() => {
    const cancelledRef = {current: false};
    refreshOptionLists(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [refreshOptionLists]);

  // Decorate every record with its resolved display facts once. `_src` is the
  // LIVE planner projection when it matched; a matched:false projection (the
  // source row vanished) renders record-column fallbacks like an unlinked row.
  const decorated = useMemo(() => {
    return records.map((rec) => {
      const src = rec.source && rec.source.matched !== false ? rec.source : null;
      const statusLabel = processingStatusLabel(rec.effective_status);
      return {
        ...rec,
        _src: src,
        _statusLabel: statusLabel,
        _statusVariant: processingStatusVariantFromLabel(statusLabel),
        _count: rec.live_count ?? rec.number_processed,
        _displayDate: src?.processing_date ?? rec.processing_date,
        _year: yearOf(src?.processing_date ?? rec.processing_date),
        _isMilestone: rec.record_type === 'milestone',
        _isBatch: rec.record_type !== 'milestone',
        _isComplete: rec.completed_at != null || rec.effective_status === 'complete',
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

  // Apply the non-program filters (status / processor / search) — program is
  // applied per-section so the chip counts stay honest. Search runs against
  // the server-built search_text (title / batch / trip / tags / processor /
  // customer, lowercased) with a title fallback.
  const passesCommon = useCallback(
    (r) => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay =
          typeof r.search_text === 'string' && r.search_text ? r.search_text : String(r.title || '').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    },
    [search],
  );

  const commonRows = useMemo(() => yearRows.filter(passesCommon), [yearRows, passesCommon]);

  // Per-program section rows in the locked display order: processing_date
  // ascending regardless of status.
  const sections = useMemo(() => {
    return PROGRAMS.map((p) => {
      const rows = sortProcessingRecordsForDisplay(commonRows.filter((r) => (r.program || r.source_kind) === p.key));
      return {...p, rows, table: PROGRAM_TABLES[p.key]};
    });
  }, [commonRows]);

  // Program chip counts (respect the common filters, ignore the program filter).
  const programCounts = useMemo(() => {
    const counts = {all: commonRows.length};
    for (const p of PROGRAMS) counts[p.key] = commonRows.filter((r) => (r.program || r.source_kind) === p.key).length;
    return counts;
  }, [commonRows]);

  // Stat cards (whole selected year, before the interactive filters narrow it).
  // BATCH rows only — milestones are planning placeholders and never count as
  // a scheduled batch or contribute head count.
  const stats = useMemo(() => {
    const batchRows = yearRows.filter((r) => r._isBatch);
    const scheduled = batchRows.length;
    const completed = batchRows.filter((r) => r._statusLabel === PROCESSING_STATUS_DISPLAY.complete).length;
    const t0 = todayISO();
    const t14 = addDaysISO(t0, 14);
    const dueSoon = batchRows.filter((r) => {
      const iso = ymd(r._displayDate)?.iso;
      if (!iso) return false;
      if (r._statusLabel === PROCESSING_STATUS_DISPLAY.complete) return false;
      return iso >= t0 && iso <= t14;
    }).length;
    const head = batchRows.reduce((s, r) => s + (num(r._count) || 0), 0);
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

  // ── row renderer (per-program fixed columns) ───────────────────────────────
  function renderRow(rec, table) {
    const active = hoveredId === rec.id || openRecordId === rec.id;
    const isMilestone = rec._isMilestone;
    const rowBg = active ? (isMilestone ? '#F3F1FB' : T.hover) : T.card;
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
          gridTemplateColumns: table.grid,
          alignItems: 'center',
          columnGap: 16,
          padding: '12px 16px',
          cursor: 'pointer',
          outline: 'none',
          position: 'relative',
          borderTop: `1px solid ${T.rowBorder}`,
          borderRadius: active ? 10 : 0,
          background: rowBg,
          transform: active ? 'translateY(-2px)' : 'translateY(0)',
          boxShadow: active ? '0 6px 18px rgba(20,40,30,.12)' : 'none',
          zIndex: active ? 3 : 0,
          transition: 'transform .16s ease, box-shadow .16s ease, background .16s ease',
        }}
      >
        {/* Completion indicator (read-only; completion itself stays gated in the drawer) */}
        <span style={stickyCellStyle(0, rowBg)}>
          <span
            aria-hidden="true"
            data-processing-row-check={rec._isComplete ? 'done' : 'open'}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              border: rec._isComplete || isMilestone ? 'none' : `1.6px solid #CDD2D8`,
              background: rec._isComplete ? T.green : 'transparent',
              color: '#fff',
              fontSize: 11,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              visibility: isMilestone ? 'hidden' : 'visible',
            }}
          >
            {rec._isComplete ? '✓' : ''}
          </span>
        </span>
        {table.columns.map((col) => (
          <div
            key={col.key}
            style={{
              minWidth: 0,
              ...(col.sticky ? stickyCellStyle(col.left, rowBg, col.lastSticky) : {}),
              ...(col.align === 'right' ? {textAlign: 'right'} : {}),
            }}
          >
            {renderCell(col, rec)}
          </div>
        ))}
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
        data-processing-deeplink-ready={deeplinkReady ? '1' : '0'}
        style={{maxWidth: 1180, margin: '0 auto', padding: '26px 24px 70px'}}
      >
        {/* Title row */}
        <div style={{display: 'flex', alignItems: 'center', gap: 16, marginBottom: 22, flexWrap: 'wrap'}}>
          <h1 style={{flex: 1, minWidth: 200, fontSize: 24, fontWeight: 800, letterSpacing: '-.02em', color: T.ink}}>
            Processing schedule
          </h1>
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
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search batch, trip, tag, processor…"
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
              minWidth: 260,
              flex: '1 1 320px',
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
                minWidth: 1080,
                background: T.card,
                border: `1px solid ${T.border}`,
                borderRadius: 16,
                boxShadow: '0 1px 2px rgba(20,30,40,.05)',
                overflow: 'hidden',
              }}
            >
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
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 10,
                            position: 'sticky',
                            left: 16,
                            zIndex: 2,
                            background: T.tint,
                          }}
                        >
                          <span style={programDotStyle(sec.key, 10)} />
                          <span style={{fontSize: 13.5, fontWeight: 800, color: T.ink, letterSpacing: '.005em'}}>
                            {sec.section}
                          </span>
                          <span style={{fontSize: 12, color: T.label, fontWeight: 600}}>
                            {sec.rows.length} {sec.rows.length === 1 ? 'batch' : 'batches'}
                          </span>
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
                      {/* Per-program fixed column header */}
                      {!isCollapsed && (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: sec.table.grid,
                            columnGap: 16,
                            padding: '10px 16px',
                            background: T.tint,
                            borderTop: `1px solid ${T.rowBorder}`,
                          }}
                        >
                          <span style={stickyCellStyle(0, T.tint)} aria-hidden="true" />
                          {sec.table.columns.map((col) => (
                            <span
                              key={col.key}
                              style={{
                                ...headerCellStyle,
                                ...(col.sticky ? stickyCellStyle(col.left, T.tint, col.lastSticky) : {}),
                                ...(col.align === 'right' ? {textAlign: 'right'} : {}),
                              }}
                            >
                              {col.label}
                            </span>
                          ))}
                          <span />
                        </div>
                      )}
                      {!isCollapsed && sec.rows.map((rec) => renderRow(rec, sec.table))}
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
          onSubtaskCountsChanged={patchRecordSubtaskCounts}
          customerOptions={optionLists.customer}
          processorOptions={optionLists.processor}
          profilesById={profilesById}
        />
      )}
      {showAddMilestone && (
        <AddMilestoneModal
          initialProgram={addMilestoneProgram}
          onClose={() => setShowAddMilestone(false)}
          customerOptions={optionLists.customer}
          processorOptions={optionLists.processor}
          onCreated={(id) => {
            setShowAddMilestone(false);
            load();
            if (id) setOpenRecordId(id);
          }}
        />
      )}
      {showTemplates && (
        <ProcessingTemplatesModal
          authState={authState}
          onClose={() => setShowTemplates(false)}
          customerOptions={optionLists.customer}
          processorOptions={optionLists.processor}
          onOptionsSaved={refreshOptionLists}
        />
      )}
    </div>
  );
}
