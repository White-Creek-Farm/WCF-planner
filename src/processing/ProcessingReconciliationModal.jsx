// ============================================================================
// src/processing/ProcessingReconciliationModal.jsx  —  Planner ⇄ Processing
// reconciliation / Asana crosswalk (admin tool)
// ----------------------------------------------------------------------------
// MANAGEMENT + ADMIN only (opened from an admin-only control on the calendar).
// Planner is senior: this surface (a) bridges the live Planner into Processing
// (reconcile_planner_to_processing → planner_batch rows), and (b) triages the
// processing_asana_links buckets from list_processing_reconciliation:
//   • Needs-review — an Asana task with no confident Planner match. The admin
//     performs a MANUAL CROSSWALK: candidate_record_ids are suggestions, but any
//     Planner record may be chosen (many Asana rows may map to one record).
//     resolve_processing_asana_link(gid, record_id) attaches it; a row can also
//     be skipped (kept in review) locally.
//   • Drift — a matched link whose Asana snapshot disagrees with the senior
//     Planner record (date/count/status). Drift is INFORMATIONAL; the admin can
//     acknowledge it (acknowledge_processing_drift) to clear it from the bucket.
//     Drift is never surfaced on the normal record drawer — it lives only here.
// The Asana import itself (Dry run / Sync now) stays on the calendar toolbar;
// this modal is about the Planner bridge + the crosswalk that follows it.
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

  const links = useMemo(() => (Array.isArray(summary?.links) ? summary.links : []), [summary]);
  const reviewLinks = useMemo(
    () => links.filter((l) => l.match_status === 'needs_review' && !skipped.has(l.asana_gid)),
    [links, skipped],
  );
  const driftLinks = useMemo(() => links.filter((l) => hasDrift(l.drift) && !l.drift_acknowledged_at), [links]);

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

  function runReconcile() {
    runMutation(
      () => reconcilePlannerToProcessing(sb),
      (r) =>
        `Reconcile complete — planner rows synced: ${num(r && r.cattle)} cattle, ${num(r && r.sheep)} sheep, ${num(
          r && r.broiler,
        )} broiler, ${num(r && r.pig)} pig.`,
    );
  }
  function resolveLink(asanaGid, recordId) {
    runMutation(() => resolveProcessingAsanaLink(sb, asanaGid, recordId || null), 'Link updated.');
  }
  function ackDrift(asanaGid) {
    runMutation(() => acknowledgeProcessingDrift(sb, asanaGid), 'Drift acknowledged.');
  }
  function skipReview(asanaGid) {
    setSkipped((s) => new Set(s).add(asanaGid));
  }

  const s = summary || {};
  const loaded = !loading && !loadError;

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
        style={{
          position: 'relative',
          width: 720,
          maxWidth: '96vw',
          maxHeight: '90vh',
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
              Planner ⇄ Processing reconciliation
            </div>
            <div style={{fontSize: 12, color: T.faint, fontWeight: 600, marginTop: 2}}>
              Bridge the senior Planner, then crosswalk Asana tasks &amp; acknowledge drift
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
                <StatChip label="Planner-only" value={num(s.planner_only_count)} accent={T.muted} />
                <StatChip label="Needs review" value={num(s.needs_review_count)} accent="#8A6A1E" />
                <StatChip label="Historical" value={num(s.historical_count)} accent={T.faint} />
                <StatChip label="Drift" value={num(s.drift_count)} accent="#B4373A" />
              </div>

              {/* Reconcile planner */}
              <div
                style={{
                  border: `1px solid ${T.border}`,
                  borderRadius: 14,
                  padding: '14px 16px',
                  marginBottom: 18,
                  background: T.tint,
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap'}}>
                  <div style={{flex: 1, minWidth: 220}}>
                    <div style={{fontSize: 13.5, fontWeight: 800, color: T.ink}}>Reconcile planner</div>
                    <div style={{fontSize: 12, color: T.muted, fontWeight: 600, marginTop: 3, lineHeight: 1.45}}>
                      Sync every live Planner batch &amp; pig trip into Processing (idempotent). Run this before
                      crosswalking so candidate records exist.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={runReconcile}
                    disabled={busy}
                    data-processing-reconcile-btn="1"
                    style={{
                      background: busy ? '#EAECEF' : T.green,
                      color: busy ? '#9AA1AB' : '#fff',
                      border: 'none',
                      borderRadius: 10,
                      padding: '10px 18px',
                      fontSize: 13.5,
                      fontWeight: 700,
                      cursor: busy ? 'default' : 'pointer',
                      fontFamily: 'inherit',
                      whiteSpace: 'nowrap',
                      flex: 'none',
                    }}
                  >
                    {busy ? 'Working…' : 'Reconcile planner'}
                  </button>
                </div>
                <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 10}}>
                  The Asana import (Dry run / Sync now) runs from the calendar toolbar. Reconcile here bridges the
                  Planner; the sync then matches Asana tasks onto these rows.
                </div>
              </div>

              {/* Needs review */}
              <SectionHead
                title="Needs review"
                count={reviewLinks.length}
                hint="Manual crosswalk — pick the Planner record this Asana task belongs to."
              />
              {reviewLinks.length === 0 ? (
                <div
                  data-reconciliation-review-empty="1"
                  style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '4px 0 16px'}}
                >
                  Nothing awaiting review.
                </div>
              ) : (
                <div style={{marginBottom: 16}}>
                  {reviewLinks.map((link) => (
                    <ReviewRow
                      key={link.asana_gid}
                      link={link}
                      records={records}
                      recordsById={recordsById}
                      busy={busy}
                      onResolve={resolveLink}
                      onSkip={skipReview}
                    />
                  ))}
                </div>
              )}

              {/* Drift */}
              <SectionHead
                title="Drift"
                count={driftLinks.length}
                hint="Asana disagrees with the senior Planner on a matched row. Informational — acknowledge to clear."
              />
              {driftLinks.length === 0 ? (
                <div
                  data-reconciliation-drift-empty="1"
                  style={{fontSize: 12.5, color: T.faint, fontWeight: 600, padding: '4px 0 8px'}}
                >
                  No unacknowledged drift.
                </div>
              ) : (
                <div>
                  {driftLinks.map((link) => (
                    <DriftRow key={link.asana_gid} link={link} recordsById={recordsById} busy={busy} onAck={ackDrift} />
                  ))}
                </div>
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
          <button
            type="button"
            onClick={onClose}
            style={{
              background: '#fff',
              border: `1px solid #D2D6DB`,
              color: '#3F4650',
              borderRadius: 10,
              padding: '10px 18px',
              fontSize: 13.5,
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

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StatChip({label, value, accent}) {
  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: '9px 14px',
        minWidth: 96,
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
function SectionHead({title, count, hint}) {
  return (
    <div style={{marginBottom: 8}}>
      <div style={{display: 'flex', alignItems: 'baseline', gap: 9}}>
        <span style={{fontSize: 14, fontWeight: 800, color: T.ink}}>{title}</span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: T.label,
            background: T.chipBg,
            borderRadius: 999,
            padding: '2px 9px',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {count}
        </span>
      </div>
      {hint && <div style={{fontSize: 11.5, color: T.faint, fontWeight: 600, marginTop: 3}}>{hint}</div>}
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function ReviewRow({link, records, recordsById, busy, onResolve, onSkip}) {
  const {useState} = React;
  const [choice, setChoice] = useState('');
  const snap = link.raw_asana_snapshot || {};
  const name = snapName(snap, link);
  const date = formatDate(snapDate(snap));
  const count = snapCount(snap);
  const candidates = Array.isArray(link.candidate_record_ids) ? link.candidate_record_ids : [];

  const metaBits = [];
  if (link.program) metaBits.push(link.program);
  if (date) metaBits.push(date);
  if (count != null) metaBits.push(`${Number(count).toLocaleString()} head`);
  if (link.asana_batch_code && link.asana_batch_code !== name) metaBits.push(link.asana_batch_code);

  return (
    <div
      data-reconciliation-review-row={link.asana_gid}
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        padding: '11px 13px',
        marginBottom: 9,
        background: T.card,
      }}
    >
      {/* Asana task */}
      <div style={{display: 'flex', alignItems: 'center', gap: 8, minWidth: 0}}>
        {link.program && <span style={programDotStyle(link.program)} />}
        <span
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            color: T.ink,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minWidth: 0,
          }}
          title={name}
        >
          {name}
        </span>
        <Badge variant={matchStatusVariant(link.match_status)} style={{flex: 'none'}}>
          {String(link.match_status || 'needs_review').replace(/_/g, ' ')}
        </Badge>
      </div>
      {metaBits.length > 0 && (
        <div style={{fontSize: 11.5, color: T.muted, fontWeight: 600, marginTop: 3}}>{metaBits.join(' · ')}</div>
      )}

      {/* Candidate suggestions */}
      {candidates.length > 0 && (
        <div style={{marginTop: 9}}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: T.label,
              textTransform: 'uppercase',
              letterSpacing: '.06em',
              marginBottom: 5,
            }}
          >
            Suggestions
          </div>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
            {candidates.map((id) => (
              <button
                key={id}
                type="button"
                disabled={busy}
                onClick={() => onResolve(link.asana_gid, id)}
                data-reconciliation-candidate={id}
                title={recordLabel(recordsById.get(id), id)}
                style={{
                  fontSize: 11.5,
                  fontWeight: 700,
                  borderRadius: 999,
                  padding: '4px 11px',
                  cursor: busy ? 'default' : 'pointer',
                  fontFamily: 'inherit',
                  border: `1px solid ${T.green}`,
                  background: '#E6F4EC',
                  color: '#1F7A4D',
                  maxWidth: 260,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {recordsById.get(id)?.title || id}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Full picker + skip */}
      <div style={{display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap'}}>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={busy}
          aria-label="Choose a Planner record"
          style={{
            flex: 1,
            minWidth: 200,
            border: `1px solid #D2D6DB`,
            borderRadius: 10,
            padding: '7px 9px',
            fontSize: 12.5,
            fontWeight: 600,
            color: T.ink,
            fontFamily: 'inherit',
            background: '#fff',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          <option value="">Choose a Planner record…</option>
          {records.map((r) => (
            <option key={r.id} value={r.id}>
              {recordLabel(r, r.id)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !choice}
          onClick={() => onResolve(link.asana_gid, choice)}
          data-reconciliation-resolve="1"
          style={{
            background: busy || !choice ? '#EAECEF' : T.green,
            color: busy || !choice ? '#9AA1AB' : '#fff',
            border: 'none',
            borderRadius: 10,
            padding: '8px 15px',
            fontSize: 12.5,
            fontWeight: 700,
            cursor: busy || !choice ? 'default' : 'pointer',
            fontFamily: 'inherit',
            flex: 'none',
          }}
        >
          Assign
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSkip(link.asana_gid)}
          data-reconciliation-skip="1"
          style={{
            background: '#fff',
            border: `1px solid ${T.border}`,
            color: T.muted,
            borderRadius: 10,
            padding: '8px 13px',
            fontSize: 12.5,
            fontWeight: 700,
            cursor: busy ? 'default' : 'pointer',
            fontFamily: 'inherit',
            flex: 'none',
          }}
        >
          Keep in review
        </button>
      </div>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function DriftRow({link, recordsById, busy, onAck}) {
  const rec = link.processing_record_id ? recordsById.get(link.processing_record_id) : null;
  const entries = driftEntries(link.drift);
  const title = rec?.title || link.processing_record_id || snapName(link.raw_asana_snapshot || {}, link);

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
