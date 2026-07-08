// ============================================================================
// src/processing/ProcessingReconciliationModal.jsx  —  Planner ⇄ Processing
// reconciliation workbench (Asana crosswalk, admin tool)
// ----------------------------------------------------------------------------
// MANAGEMENT + ADMIN only (opened from an admin-only control on the calendar).
// Planner is senior. This surface (a) bridges the live Planner into Processing
// (reconcile_planner_to_processing → planner_batch rows), (b) populates the
// review queue from Asana without importing artifacts (sync_review_queue: records
// + links only, no subtasks/comments/attachments/Storage), and (c) is a fast
// one-item-at-a-time WORKBENCH over the list_processing_reconciliation buckets:
//   • Ambiguous       — an Asana task with >=2 Planner candidates / a Name↔Batch
//                        disagreement. Manual crosswalk: assign the right record.
//   • Import exception — an unmatched Asana row (>=2024, no candidate). Assign it
//                        to a Planner batch, or triage it (milestone / historical
//                        / dismiss = not-a-batch).
//   • Pig             — pig ambiguous/exception rows (pig never auto-matches);
//                        assign each to its Planner trip.
//   • Duplicates      — >=2 Asana tasks sharing a program+code. Keep one canonical,
//                        block the rest (supersede; provenance preserved).
//   • Drift           — a matched link whose Asana snapshot disagrees with the
//                        senior Planner. Informational; acknowledge to clear.
// Every action writes through a narrow SECDEF RPC (deny-all RLS; RPC-only). The
// Asana import (Dry run / Sync now) stays on the calendar toolbar.
//
// Fail-closed loading: data-processing-reconciliation-loaded flips to '1' only
// when both reads land; a load error clears data and offers Retry.
// ============================================================================
import React from 'react';
import {sb} from '../lib/supabase.js';
import {
  listProcessingReconciliation,
  reconcilePlannerToProcessing,
  resolveProcessingAsanaLink,
  acknowledgeProcessingDrift,
  triageProcessingAsanaRecord,
  supersedeProcessingAsanaDuplicate,
  invokeProcessingAsanaSync,
  listProcessingRecords,
  friendlyProcessingError,
} from '../lib/processingApi.js';
import {programDotStyle} from '../lib/programColors.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';

const RECON_ROLES = ['admin', 'management'];

const T = {
  card: '#fff',
  border: '#E6E8EB',
  rowBorder: '#ECEEF0',
  tint: '#FAFBFB',
  ink: '#222933',
  muted: '#6B7280',
  label: '#7A828D',
  faint: '#9AA1AB',
  green: '#1C8A5F',
  chipBg: '#F1F3F4',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : null;
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The Asana snapshot shape is importer-defined; read a few likely key spellings
// so a title/date/count always renders when present.
function snapName(snap, link) {
  return (snap && (snap.name || snap.title)) || link.asana_batch_code || `Asana task ${link.asana_gid}`;
}
function snapDate(snap) {
  if (!snap) return null;
  return snap.date || snap.due_on || snap.processing_date || snap.processingDate || null;
}
function snapCount(snap) {
  if (!snap) return null;
  const c = snap.count ?? snap.number ?? snap.pigCount ?? snap.number_processed ?? snap.totalToProcessor;
  return c === undefined || c === null || c === '' ? null : c;
}

function hasDrift(drift) {
  return !!drift && typeof drift === 'object' && !Array.isArray(drift) && Object.keys(drift).length > 0;
}
// Normalize a drift jsonb into rows of {field, asana, planner}. Each field's
// value is usually a {asana, planner} pair; a scalar renders on the Asana side.
function driftEntries(drift) {
  if (!hasDrift(drift)) return [];
  return Object.keys(drift).map((field) => {
    const v = drift[field];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const asana = v.asana ?? v.from ?? v.a ?? v.imported ?? null;
      const planner = v.planner ?? v.to ?? v.b ?? v.record ?? null;
      return {field, asana, planner};
    }
    return {field, asana: v, planner: undefined};
  });
}

function matchStatusVariant(status) {
  switch (status) {
    case 'matched':
      return 'ok';
    case 'needs_review':
      return 'warn';
    case 'duplicate_blocked':
      return 'danger';
    case 'milestone':
      return 'info';
    default:
      return 'neutral';
  }
}

function recordLabel(rec, id) {
  if (!rec) return id;
  const prog = rec.program || rec.source_kind || '';
  const date = formatDate(rec.processing_date);
  const parts = [rec.title || id];
  if (prog) parts.push(prog);
  if (date) parts.push(date);
  return parts.join(' · ');
}

// Candidate list for a link: prefer the server-resolved objects; fall back to raw
// ids (older payloads) resolved against recordsById.
function linkCandidates(link, recordsById) {
  if (Array.isArray(link.candidates) && link.candidates.length) return link.candidates;
  const ids = Array.isArray(link.candidate_record_ids) ? link.candidate_record_ids : [];
  return ids.map((id) => recordsById.get(id) || {id, title: id});
}

// Facts for the Asana side of a link (snapshot first, linked record as backup).
function asanaFacts(link) {
  const snap = link.raw_asana_snapshot || {};
  const rec = link.record || null;
  return {
    name: snapName(snap, link),
    code: link.asana_batch_code || null,
    program: link.program || (rec && rec.program) || null,
    date: formatDate(snapDate(snap)) || (rec && formatDate(rec.processing_date)) || null,
    count: snapCount(snap) ?? (rec ? rec.number_processed : null),
    section: snap.asana_section_name || snap.section || null,
  };
}

const BUCKET_TABS = [
  {key: 'ambiguous', label: 'Ambiguous', hint: 'Two+ Planner candidates — pick the right batch.'},
  {
    key: 'import_exception',
    label: 'Exceptions',
    hint: 'Unmatched Asana rows — assign, or triage as milestone/historical/dismiss.',
  },
  {key: 'pig', label: 'Pig', hint: 'Pig tasks never auto-match — crosswalk each to its Planner trip.'},
  {key: 'duplicates', label: 'Duplicates', hint: 'Multiple Asana tasks share a code — keep one, block the rest.'},
  {
    key: 'drift',
    label: 'Drift',
    hint: 'Asana disagrees with the senior Planner — informational; acknowledge to clear.',
  },
];

export default function ProcessingReconciliationModal({authState, onClose}) {
  // Guard: management + admin only. Anyone else gets a small dismissible notice.
  if (!RECON_ROLES.includes(authState?.role)) {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 7000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
        data-processing-reconciliation-modal="1"
        data-processing-reconciliation-loaded="1"
      >
        <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
        <div
          style={{
            position: 'relative',
            background: '#fff',
            borderRadius: 14,
            padding: '20px 22px',
            maxWidth: 380,
            boxShadow: '0 24px 60px rgba(20,30,40,.28)',
          }}
        >
          <InlineNotice
            notice={{kind: 'warning', message: 'Reconciliation is available to management and admins only.'}}
          />
          <div style={{textAlign: 'right'}}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: T.green,
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return <ReconciliationPanel onClose={onClose} />;
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function ReconciliationPanel({onClose}) {
  const {useState, useEffect, useCallback, useMemo} = React;
  const [summary, setSummary] = useState(null);
  const [records, setRecords] = useState([]);
  const [recordsById, setRecordsById] = useState(() => new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(() => new Set());
  const [tab, setTab] = useState('ambiguous');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [recon, recs] = await Promise.all([
        listProcessingReconciliation(sb),
        listProcessingRecords(sb, {includeArchived: false}),
      ]);
      setSummary(recon || {});
      const list = Array.isArray(recs) ? recs : [];
      setRecords(list);
      setRecordsById(new Map(list.map((r) => [r.id, r])));
    } catch (e) {
      setSummary(null); // fail-closed: clear stale data on error
      setRecords([]);
      setRecordsById(new Map());
      setLoadError({message: `Could not load reconciliation data. Please retry. (${(e && e.message) || e})`});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const s = summary || {};
  const links = useMemo(() => (Array.isArray(summary?.links) ? summary.links : []), [summary]);
  const duplicateGroups = useMemo(
    () => (Array.isArray(summary?.duplicate_groups) ? summary.duplicate_groups : []),
    [summary],
  );
  const plannerRecords = useMemo(
    () => records.filter((r) => r.record_type === 'planner_batch' && !r.archived),
    [records],
  );

  // Bucketed, skip-filtered queues derived from the enriched links. The Pig tab is
  // EXCLUSIVE: pig review rows appear only there, so Ambiguous + Exceptions filter
  // program='pig' out (pig never auto-matches and needs its own crosswalk flow).
  const buckets = useMemo(() => {
    const notSkipped = (l) => !skipped.has(l.asana_gid);
    const ambiguous = links.filter((l) => l.bucket === 'ambiguous' && l.program !== 'pig' && notSkipped(l));
    const exceptions = links.filter((l) => l.bucket === 'import_exception' && l.program !== 'pig' && notSkipped(l));
    const pig = links.filter(
      (l) => (l.bucket === 'ambiguous' || l.bucket === 'import_exception') && l.program === 'pig' && notSkipped(l),
    );
    const drift = links.filter((l) => l.drift_open && notSkipped(l));
    return {ambiguous, import_exception: exceptions, pig, duplicates: duplicateGroups, drift};
  }, [links, duplicateGroups, skipped]);

  const bucketCount = (key) => (Array.isArray(buckets[key]) ? buckets[key].length : 0);

  const runMutation = useCallback(
    async (fn, successMsg) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fn();
        if (successMsg) {
          setNotice({kind: 'success', message: typeof successMsg === 'function' ? successMsg(res) : successMsg});
        }
        await load();
        return true;
      } catch (e) {
        setNotice({kind: 'error', message: friendlyProcessingError(e)});
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const runReconcile = () =>
    runMutation(
      () => reconcilePlannerToProcessing(sb),
      (r) =>
        `Planner bridged — ${num(r && r.cattle)} cattle, ${num(r && r.sheep)} sheep, ${num(
          r && r.broiler,
        )} broiler, ${num(r && r.pig)} pig.`,
    );
  const populateQueue = () =>
    runMutation(
      () => invokeProcessingAsanaSync(sb, {action: 'sync_review_queue'}),
      (r) => {
        const c = (r && r.counts) || {};
        return `Review queue populated — ${num(c.tasks)} tasks: ${num(c.matched)} matched, ${num(
          c.exceptions,
        )} exceptions, ${num(c.needsReview)} needs review, ${num(c.milestones)} milestones (no artifacts imported).`;
      },
    );
  const resolveLink = (asanaGid, recordId) =>
    runMutation(() => resolveProcessingAsanaLink(sb, asanaGid, recordId || null), 'Assigned to the Planner record.');
  const triageRecord = (recordId, action) =>
    runMutation(() => triageProcessingAsanaRecord(sb, recordId, action), `Marked ${action}.`);
  const supersedeDuplicate = (asanaGid, canonicalId) =>
    runMutation(() => supersedeProcessingAsanaDuplicate(sb, asanaGid, canonicalId || null), 'Blocked as duplicate.');
  const ackDrift = (asanaGid) => runMutation(() => acknowledgeProcessingDrift(sb, asanaGid), 'Drift acknowledged.');
  const skipNext = (asanaGid) => setSkipped((prev) => new Set(prev).add(asanaGid));

  const loaded = !loading && !loadError;
  const hasAnyLink = links.length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 7000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      data-processing-reconciliation-modal="1"
      data-processing-reconciliation-loaded={loaded ? '1' : '0'}
    >
      <style>{`@keyframes wcfProcModalIn{from{transform:translateY(10px) scale(.985);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}`}</style>
      <div onClick={onClose} style={{position: 'absolute', inset: 0, background: 'rgba(20,28,24,.34)'}} />
      <div
        data-reconciliation-workbench="1"
        style={{
          position: 'relative',
          width: 900,
          maxWidth: '96vw',
          maxHeight: '92vh',
          background: T.card,
          borderRadius: 18,
          boxShadow: '0 24px 60px rgba(20,30,40,.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'wcfProcModalIn .18s ease',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            padding: '16px 20px',
            borderBottom: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontSize: 16, fontWeight: 800, letterSpacing: '-.01em', color: T.ink}}>
              Reconciliation workbench
            </div>
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              Bridge the senior Planner, populate the review queue, then crosswalk &amp; triage Asana tasks
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              background: '#fff',
              color: T.muted,
              cursor: 'pointer',
              fontSize: 15,
              flex: 'none',
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{flex: 1, overflow: 'auto', padding: '16px 20px 12px'}}>
          <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

          {loading && <div style={{color: T.faint, fontSize: 13, fontWeight: 600}}>Loading reconciliation…</div>}

          {loadError && (
            <div data-processing-reconciliation-error="1">
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
                  fontWeight: 700,
                  fontFamily: 'inherit',
                }}
              >
                Retry
              </button>
            </div>
          )}

          {loaded && (
            <>
              {/* Summary buckets */}
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14}}>
                <StatChip label="Matched" value={num(s.matched_count)} accent={T.green} />
                <StatChip label="Ambiguous" value={num(s.needs_review_count)} accent="#8A6A1E" />
                <StatChip label="Exceptions" value={num(s.import_exception_count)} accent="#8A6A1E" />
                <StatChip label="Duplicates" value={duplicateGroups.length} accent="#B4373A" />
                <StatChip label="Historical" value={num(s.historical_count)} accent={T.faint} />
                <StatChip label="Drift" value={num(s.drift_count)} accent="#B4373A" />
              </div>

              {/* Bridge + populate */}
              <div
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 14,
                  padding: '13px 16px',
                  marginBottom: 16,
                  background: T.tint,
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                  alignItems: 'center',
                }}
              >
                <div style={{flex: 1, minWidth: 200}}>
                  <div style={{fontSize: 13.5, fontWeight: 800, color: T.ink}}>Prepare the queue</div>
                  <div style={{fontSize: 12, color: T.muted, fontWeight: 600, marginTop: 3, lineHeight: 1.45}}>
                    Bridge the live Planner first, then populate the review queue from Asana (records + links only — no
                    subtasks, comments, or attachments).
                  </div>
                </div>
                <button
                  type="button"
                  onClick={runReconcile}
                  disabled={busy}
                  data-processing-reconcile-btn="1"
                  style={secondaryBtn(busy)}
                >
                  {busy ? 'Working…' : 'Reconcile planner'}
                </button>
                <button
                  type="button"
                  onClick={populateQueue}
                  disabled={busy}
                  data-reconciliation-populate-btn="1"
                  style={primaryBtn(busy)}
                >
                  {busy ? 'Working…' : 'Populate review queue'}
                </button>
              </div>

              {!hasAnyLink ? (
                <div
                  data-reconciliation-empty="1"
                  style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '10px 0 16px', lineHeight: 1.5}}
                >
                  No Asana links yet. Run “Populate review queue” to fetch the SF Processing Calendar and stage the
                  review items here — nothing is imported until you crosswalk it.
                </div>
              ) : (
                <>
                  {/* Bucket tabs */}
                  <div style={{display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 6}}>
                    {BUCKET_TABS.map((b) => {
                      const count = bucketCount(b.key);
                      const active = tab === b.key;
                      return (
                        <button
                          key={b.key}
                          type="button"
                          data-reconciliation-bucket-tab={b.key}
                          aria-pressed={active}
                          onClick={() => setTab(b.key)}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 7,
                            fontSize: 12.5,
                            fontWeight: 700,
                            borderRadius: 999,
                            padding: '6px 13px',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            border: `1px solid ${active ? '#000' : T.border}`,
                            background: active ? '#000' : '#fff',
                            color: active ? '#fff' : T.muted,
                          }}
                        >
                          {b.label}
                          <span
                            style={{
                              fontVariantNumeric: 'tabular-nums',
                              background: active ? 'rgba(255,255,255,.2)' : T.chipBg,
                              borderRadius: 999,
                              padding: '1px 7px',
                              color: active ? '#fff' : T.label,
                            }}
                          >
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginBottom: 12}}>
                    {BUCKET_TABS.find((b) => b.key === tab)?.hint}
                  </div>

                  {/* Active bucket */}
                  {tab === 'duplicates' ? (
                    <DuplicateBucket
                      groups={buckets.duplicates}
                      links={links}
                      plannerRecords={plannerRecords}
                      busy={busy}
                      onSupersede={supersedeDuplicate}
                    />
                  ) : tab === 'drift' ? (
                    <DriftBucket items={buckets.drift} recordsById={recordsById} busy={busy} onAck={ackDrift} />
                  ) : (
                    <ReviewBucket
                      bucketKey={tab}
                      items={buckets[tab]}
                      plannerRecords={plannerRecords}
                      recordsById={recordsById}
                      busy={busy}
                      onResolve={resolveLink}
                      onTriage={triageRecord}
                      onSkip={skipNext}
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 10,
            padding: '14px 20px',
            borderTop: `1px solid #ECEEF0`,
            flex: 'none',
          }}
        >
          <button type="button" onClick={onClose} style={secondaryBtn(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function primaryBtn(disabled) {
  return {
    background: disabled ? '#EAECEF' : T.green,
    color: disabled ? '#9AA1AB' : '#fff',
    border: 'none',
    borderRadius: 10,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flex: 'none',
  };
}
function secondaryBtn(disabled) {
  return {
    background: '#fff',
    border: `1px solid ${T.border}`,
    color: T.muted,
    borderRadius: 10,
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flex: 'none',
  };
}

// One-at-a-time review queue for the crosswalk/triage buckets.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function ReviewBucket({bucketKey, items, plannerRecords, recordsById, busy, onResolve, onTriage, onSkip}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return (
      <div
        data-reconciliation-bucket-empty={bucketKey}
        style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '6px 0 12px'}}
      >
        Nothing in this bucket — all clear.
      </div>
    );
  }
  const active = list[0];
  return (
    <div>
      <div style={{fontSize: 11.5, color: T.label, fontWeight: 700, marginBottom: 8}}>
        {list.length} remaining — reviewing one at a time
      </div>
      <WorkbenchItem
        key={active.asana_gid}
        link={active}
        plannerRecords={plannerRecords}
        recordsById={recordsById}
        busy={busy}
        onResolve={onResolve}
        onTriage={onTriage}
        onSkip={onSkip}
      />
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function WorkbenchItem({link, plannerRecords, recordsById, busy, onResolve, onTriage, onSkip}) {
  const {useState, useMemo} = React;
  const [search, setSearch] = useState('');
  const facts = asanaFacts(link);
  const candidates = linkCandidates(link, recordsById);
  const rec = link.record || null;
  // Triage applies to an Asana-owned placeholder record (import_exception here).
  const canTriage = !!rec && rec.record_type !== 'planner_batch';

  const results = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return plannerRecords
      .filter((r) => `${r.title || ''} ${r.source_id || ''} ${r.program || ''}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [search, plannerRecords]);

  const metaBits = [
    facts.program,
    facts.date,
    facts.count != null ? `${Number(facts.count).toLocaleString()} head` : null,
  ]
    .concat(facts.code && facts.code !== facts.name ? [facts.code] : [])
    .filter(Boolean);

  return (
    <div
      data-reconciliation-item={link.asana_gid}
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        padding: '14px 16px',
        background: T.card,
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)',
        gap: 16,
      }}
    >
      {/* LEFT — the Asana task */}
      <div style={{minWidth: 0, borderRight: `1px solid ${T.rowBorder}`, paddingRight: 14}}>
        <div
          style={{fontSize: 10.5, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: T.label}}
        >
          Asana task
        </div>
        <div style={{display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, minWidth: 0}}>
          {facts.program && <span style={programDotStyle(facts.program)} />}
          <span
            style={{fontSize: 14.5, fontWeight: 800, color: T.ink, minWidth: 0, wordBreak: 'break-word'}}
            title={facts.name}
          >
            {facts.name}
          </span>
        </div>
        {metaBits.length > 0 && (
          <div style={{fontSize: 12, color: T.muted, fontWeight: 600, marginTop: 5}}>{metaBits.join(' · ')}</div>
        )}
        {facts.section && (
          <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 4}}>{facts.section}</div>
        )}
        <div style={{marginTop: 8}}>
          <Badge variant={matchStatusVariant(link.match_status)}>
            {String(link.bucket || link.match_status || 'needs_review').replace(/_/g, ' ')}
          </Badge>
        </div>
      </div>

      {/* RIGHT — assign / triage */}
      <div style={{minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10}}>
        {candidates.length > 0 && (
          <div>
            <div style={sectionLabel}>Suggested Planner records</div>
            <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve(link.asana_gid, c.id)}
                  data-reconciliation-candidate={c.id}
                  title={recordLabel(c, c.id)}
                  style={candidateBtn(busy)}
                >
                  {c.title || c.id}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={sectionLabel}>Search a Planner batch</div>
          <input
            type="text"
            value={search}
            disabled={busy}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Type a code, title, or source id…"
            data-reconciliation-search="1"
            style={{
              width: '100%',
              border: `1px solid #D2D6DB`,
              borderRadius: 10,
              padding: '8px 10px',
              fontSize: 12.5,
              fontWeight: 600,
              color: T.ink,
              fontFamily: 'inherit',
              background: '#fff',
            }}
          />
          {results.length > 0 && (
            <div style={{display: 'grid', gap: 5, marginTop: 6}}>
              {results.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve(link.asana_gid, r.id)}
                  data-reconciliation-search-assign={r.id}
                  style={{
                    textAlign: 'left',
                    border: `1px solid ${T.border}`,
                    background: '#fff',
                    borderRadius: 10,
                    padding: '7px 10px',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: T.ink,
                    cursor: busy ? 'default' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {recordLabel(r, r.id)}
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 2}}>
          {canTriage && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onTriage(rec.id, 'milestone')}
                data-reconciliation-triage-milestone="1"
                style={pillBtn(busy)}
              >
                Mark milestone
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onTriage(rec.id, 'historical')}
                data-reconciliation-triage-historical="1"
                style={pillBtn(busy)}
              >
                Mark historical
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onTriage(rec.id, 'dismiss')}
                data-reconciliation-triage-dismiss="1"
                style={pillBtn(busy)}
              >
                Dismiss (not a batch)
              </button>
            </>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => onSkip(link.asana_gid)}
            data-reconciliation-skip="1"
            style={pillBtn(busy)}
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}

// Duplicate-group bucket: keep one canonical, block the rest.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function DuplicateBucket({groups, links, plannerRecords, busy, onSupersede}) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) {
    return (
      <div
        data-reconciliation-bucket-empty="duplicates"
        style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '6px 0 12px'}}
      >
        No duplicate Asana codes.
      </div>
    );
  }
  return (
    <div style={{display: 'grid', gap: 12}}>
      {list.map((g) => (
        <DuplicateGroupCard
          key={`${g.program}:${g.code}`}
          group={g}
          links={links}
          plannerRecords={plannerRecords}
          busy={busy}
          onSupersede={onSupersede}
        />
      ))}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function DuplicateGroupCard({group, links, plannerRecords, busy, onSupersede}) {
  const {useState, useMemo} = React;
  const members = useMemo(
    () => links.filter((l) => Array.isArray(group.asana_gids) && group.asana_gids.includes(l.asana_gid)),
    [links, group],
  );
  // Canonical candidates: the records these members already point at (matched),
  // plus any planner_batch by search. Default to the first matched member's record.
  const memberRecords = members.map((m) => m.record).filter((r) => r && r.record_type === 'planner_batch');
  const [canonical, setCanonical] = useState(memberRecords[0]?.id || '');

  return (
    <div
      data-reconciliation-duplicate-group={group.code}
      style={{border: `1px solid ${T.border}`, borderRadius: 14, padding: '13px 15px', background: T.card}}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap'}}>
        {group.program && <span style={programDotStyle(group.program)} />}
        <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>{group.code}</span>
        <span style={{fontSize: 12, color: T.muted, fontWeight: 600}}>
          {group.program} · {num(group.count)} Asana tasks
        </span>
      </div>

      <div style={{marginBottom: 10}}>
        <div style={sectionLabel}>Keep as canonical</div>
        <select
          value={canonical}
          disabled={busy}
          onChange={(e) => setCanonical(e.target.value)}
          data-reconciliation-canonical="1"
          style={{
            width: '100%',
            border: `1px solid #D2D6DB`,
            borderRadius: 10,
            padding: '7px 9px',
            fontSize: 12.5,
            fontWeight: 600,
            color: T.ink,
            fontFamily: 'inherit',
            background: '#fff',
          }}
        >
          <option value="">No canonical (just block the duplicate)</option>
          {plannerRecords.map((r) => (
            <option key={r.id} value={r.id}>
              {recordLabel(r, r.id)}
            </option>
          ))}
        </select>
      </div>

      <div style={{display: 'grid', gap: 7}}>
        {members.map((m) => {
          const facts = asanaFacts(m);
          const blocked = m.match_status === 'duplicate_blocked';
          return (
            <div
              key={m.asana_gid}
              data-reconciliation-duplicate-member={m.asana_gid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                borderTop: `1px solid ${T.rowBorder}`,
                paddingTop: 7,
              }}
            >
              <div style={{minWidth: 0, flex: 1}}>
                <div style={{fontSize: 12.5, fontWeight: 700, color: T.ink, wordBreak: 'break-word'}}>{facts.name}</div>
                <div style={{fontSize: 11.5, color: T.muted, fontWeight: 600}}>
                  {[facts.date, facts.count != null ? `${Number(facts.count).toLocaleString()} head` : null, m.bucket]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {blocked ? (
                <Badge variant="danger">blocked</Badge>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSupersede(m.asana_gid, canonical)}
                  data-reconciliation-supersede={m.asana_gid}
                  style={pillBtn(busy)}
                >
                  Block as duplicate
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Drift bucket: informational; acknowledge to clear.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function DriftBucket({items, recordsById, busy, onAck}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return (
      <div
        data-reconciliation-bucket-empty="drift"
        style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '6px 0 12px'}}
      >
        No unacknowledged drift.
      </div>
    );
  }
  return (
    <div>
      {list.map((link) => (
        <DriftRow key={link.asana_gid} link={link} recordsById={recordsById} busy={busy} onAck={onAck} />
      ))}
    </div>
  );
}

const sectionLabel = {
  fontSize: 11,
  fontWeight: 700,
  color: T.label,
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 5,
};
function candidateBtn(disabled) {
  return {
    fontSize: 11.5,
    fontWeight: 700,
    borderRadius: 999,
    padding: '5px 12px',
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    border: `1px solid ${T.green}`,
    background: '#E6F4EC',
    color: '#1F7A4D',
    maxWidth: 260,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };
}
function pillBtn(disabled) {
  return {
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 10,
    padding: '7px 12px',
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'inherit',
    border: `1px solid ${T.border}`,
    background: '#fff',
    color: T.muted,
    flex: 'none',
  };
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StatChip({label, value, accent}) {
  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: '9px 14px',
        minWidth: 92,
        background: T.card,
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 800,
          letterSpacing: '-.02em',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          color: accent || T.ink,
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: T.label,
          marginTop: 6,
        }}
      >
        {label}
      </div>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function DriftRow({link, recordsById, busy, onAck}) {
  const rec = link.record || (link.processing_record_id ? recordsById.get(link.processing_record_id) : null);
  const entries = driftEntries(link.drift);
  const title = (rec && rec.title) || link.processing_record_id || snapName(link.raw_asana_snapshot || {}, link);

  return (
    <div
      data-reconciliation-drift-row={link.asana_gid}
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: '11px 13px',
        marginBottom: 9,
        background: T.card,
      }}
    >
      <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
        {link.program && <span style={programDotStyle(link.program)} />}
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            color: T.ink,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={title}
        >
          {title}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => onAck(link.asana_gid)}
          data-reconciliation-ack="1"
          style={{
            marginLeft: 'auto',
            background: '#fff',
            border: `1px solid ${T.border}`,
            color: T.muted,
            borderRadius: 10,
            padding: '7px 13px',
            fontSize: 12.5,
            fontWeight: 700,
            cursor: busy ? 'default' : 'pointer',
            fontFamily: 'inherit',
            flex: 'none',
          }}
        >
          Acknowledge
        </button>
      </div>

      {entries.length > 0 ? (
        <div style={{marginTop: 9, display: 'grid', gap: 5}}>
          {entries.map((d) => (
            <div
              key={d.field}
              style={{
                display: 'grid',
                gridTemplateColumns: '110px 1fr',
                gap: 10,
                alignItems: 'baseline',
                fontSize: 12,
                borderTop: `1px solid ${T.rowBorder}`,
                paddingTop: 5,
              }}
            >
              <span style={{fontWeight: 700, color: T.label, textTransform: 'capitalize'}}>
                {String(d.field).replace(/_/g, ' ')}
              </span>
              <span style={{color: T.ink, fontWeight: 600, minWidth: 0}}>
                <span style={{color: '#B4373A'}}>Asana: {formatDriftValue(d.asana)}</span>
                {d.planner !== undefined && (
                  <>
                    <span style={{color: T.faint, margin: '0 7px'}}>→</span>
                    <span style={{color: T.green}}>Planner: {formatDriftValue(d.planner)}</span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 6}}>Drift details unavailable.</div>
      )}
    </div>
  );
}

function formatDriftValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
