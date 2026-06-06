// CattleSendToProcessorModal — reworked for the Cattle Forecast lane.
// ---------------------------------------------------------------------------
// Pops up when a cattle finisher session is being completed and at least
// one entry has send_to_processor=true.
//
// New flow (mig 043 + Forecast):
//   - No batch picker. The Forecast helper computes the next virtual batch
//     name and the allowed tag set; the modal shows that name + count and
//     enforces the gate on submit.
//   - Hard forecast gate: every selected tag MUST be in the next virtual
//     batch's allowedTagSet. If any tag is outside, the WHOLE send is
//     blocked with explicit "adjust hide/unhide in Forecast first" copy
//     listing the blocked tags.
//   - Partial subset of the next virtual batch is allowed (sent subset
//     becomes the new active C-YY-NN; remaining unhidden cattle from that
//     virtual batch shift to the next virtual sequence number on next
//     forecast recompute).
//   - Real attach creates an ACTIVE batch (mig 043 retired the 'planned'
//     DB status). actual_process_date = weigh_in_sessions.date (NOT today).
// ---------------------------------------------------------------------------
import React from 'react';
import {createProcessingBatch, attachEntriesToBatch, promoteScheduledBatch} from '../lib/cattleProcessingBatch.js';
import {attachCattleToProcessingBatch} from '../lib/processingAttachApi.js';
import {buildForecast, checkProcessorGate} from '../lib/cattleForecast.js';
import {loadForecastSettings, loadHeiferIncludes, loadHidden} from '../lib/cattleForecastApi.js';

export default function CattleSendToProcessorModal({
  sb,
  session,
  flaggedEntries,
  cattleList,
  weighIns,
  teamMember,
  authState,
  useAttachRpc = false,
  onCancel,
  onConfirmed,
}) {
  const role = authState && authState.role;
  const canSend = role === 'admin' || role === 'management';
  const [loading, setLoading] = React.useState(true);
  const [forecast, setForecast] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [gateBlocked, setGateBlocked] = React.useState([]);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, includes, hidden, batchesR] = await Promise.all([
          loadForecastSettings(sb),
          loadHeiferIncludes(sb),
          loadHidden(sb),
          sb.from('cattle_processing_batches').select('*'),
        ]);
        if (cancelled) return;
        const allBatches = batchesR.data || [];
        const realBatches = allBatches.filter((b) => b.status === 'active' || b.status === 'complete');
        const scheduledBatches = allBatches.filter((b) => b.status === 'scheduled');
        const f = buildForecast({
          cattle: cattleList || [],
          weighIns: weighIns || [],
          settings,
          includes,
          hidden,
          realBatches,
          scheduledBatches,
          todayMs: Date.now(),
        });
        // Stash all batch rows on the forecast so the promote path can
        // grab the underlying scheduled row when promoting.
        setForecast({...f, _realBatches: realBatches, _scheduledBatches: scheduledBatches});
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setErr('Could not load forecast: ' + (e.message || e));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, cattleList, weighIns]);

  const totalWeight = flaggedEntries.reduce((s, e) => s + (parseFloat(e.weight) || 0), 0);
  const selectedTags = flaggedEntries.map((e) => e.tag).filter(Boolean);
  const next = forecast?.nextProcessorBatch || null;
  const sessionDate = (session && session.date) || new Date().toISOString().slice(0, 10);
  // Real batch name MUST match the displayed virtual batch name exactly —
  // this is the locked contract: "planned batch numbers need to match the
  // forecast number exactly." The Forecast tab and Batches tab both show
  // `next.name`; what gets saved must be the same string.
  const gate = next
    ? checkProcessorGate({selectedTags, nextProcessorBatch: next})
    : {ok: false, reason: 'no_next_batch', blockedTags: []};

  // Codex 2026-05-12 correction: outside-projection tags are a WARNING
  // when there's a valid next batch (scheduled or virtual). Ronnie can
  // intentionally send a cow not in the projection or skip a projected
  // cow; only the actually-sent entries move to processed via
  // attachEntriesToBatch. Hard-block is reserved for true no-batch cases.
  //
  // Codex 2026-05-12 (round 2): when next.source === 'scheduled', a
  // forecast that has zero projected animals for the scheduled month
  // is ALSO a warning, not a block. The scheduled row is a real
  // processor booking — actual sent cattle still override projection.
  // For a virtual next batch, empty_next_batch stays a hard block
  // (there's no row to attach to).
  const hasNextBatch = !!next;
  const isScheduledNext = hasNextBatch && next.source === 'scheduled';
  const isEmptyScheduled = isScheduledNext && !gate.ok && gate.reason === 'empty_next_batch';
  const outsideTagsWarning =
    hasNextBatch && !gate.ok && gate.reason === 'tags_outside_next_batch'
      ? gate.blockedTags
      : isEmptyScheduled
        ? selectedTags.slice()
        : [];
  const hardBlocked = !hasNextBatch || (!gate.ok && gate.reason !== 'tags_outside_next_batch' && !isEmptyScheduled);

  // Surface the outside-projection tags in real-time (no Submit needed).
  React.useEffect(() => {
    setGateBlocked(outsideTagsWarning);
  }, [outsideTagsWarning.join(',')]);

  async function go() {
    setErr('');
    if (!canSend) {
      setErr('Send-to-Processor is restricted to management/admin.');
      return;
    }
    if (hardBlocked) {
      setErr(
        gate.reason === 'no_next_batch'
          ? 'No next planned batch — there are no cattle eligible for processing yet.'
          : gate.reason === 'empty_next_batch'
            ? 'The next planned batch is empty.'
            : 'Cannot send: forecast has no valid next batch yet.',
      );
      return;
    }
    setBusy(true);
    try {
      // Promote-or-create: when nextProcessorBatch is sourced from a
      // scheduled DB row, UPDATE that row to active and inherit its id
      // + name + planned_process_date. The authenticated record-page path
      // routes through the RPC so batch state, cattle state, weigh-in stamps,
      // transfer rows, and Activity land atomically. Otherwise, keep the
      // legacy client helper path for shared modal callers that have not been
      // migrated yet.
      let batch;
      let attached;
      let skipped;
      if (useAttachRpc) {
        if (next.source === 'scheduled' && next.scheduledId) {
          const scheduledRow = (forecast?._scheduledBatches || []).find((b) => b.id === next.scheduledId);
          if (!scheduledRow) {
            throw new Error('Scheduled batch ' + next.scheduledId + ' missing from forecast.');
          }
        }
        const result = await attachCattleToProcessingBatch(sb, {
          sessionId: session && session.id,
          entryIds: flaggedEntries.map((e) => e.id).filter(Boolean),
          targetBatchId: next.source === 'scheduled' ? next.scheduledId : null,
          batchName: next.source === 'scheduled' ? null : next.name,
          processingDate: sessionDate,
          teamMember,
        });
        batch = result.batch;
        attached = result.attached || [];
        skipped = result.skipped || [];
      } else if (next.source === 'scheduled' && next.scheduledId) {
        const scheduledRow = (forecast?._scheduledBatches || []).find((b) => b.id === next.scheduledId);
        if (!scheduledRow) {
          throw new Error('Scheduled batch ' + next.scheduledId + ' missing from forecast.');
        }
        batch = await promoteScheduledBatch(sb, scheduledRow, {processingDate: sessionDate});
      } else {
        batch = await createProcessingBatch(sb, {
          name: next.name,
          processingDate: sessionDate,
        });
      }
      if (!useAttachRpc) {
        const result = await attachEntriesToBatch(sb, {
          batch,
          entries: flaggedEntries,
          cattleList,
          teamMember,
        });
        attached = result.attached;
        skipped = result.skipped;
      }
      onConfirmed({batch, attached, skipped});
    } catch (e) {
      setErr(e.message || 'Could not attach to batch.');
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      data-cattle-send-modal
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 540,
          width: '100%',
          padding: '18px 20px',
          boxShadow: '0 12px 40px rgba(0,0,0,.25)',
        }}
      >
        <div style={{fontSize: 15, fontWeight: 700, color: '#111827', marginBottom: 6}}>
          {'🚩 Send ' +
            flaggedEntries.length +
            ' finisher' +
            (flaggedEntries.length === 1 ? '' : 's') +
            ' to processor'}
        </div>
        <div style={{fontSize: 11, color: '#6b7280', marginBottom: 10}}>
          {'Total live weight: ' + Math.round(totalWeight).toLocaleString() + ' lb · session date ' + sessionDate}
        </div>

        {loading && (
          <div style={{padding: '20px 0', textAlign: 'center', color: '#9ca3af', fontSize: 12}}>
            Loading forecast{'…'}
          </div>
        )}

        {!loading && next && (
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid #fca5a5',
              borderLeft: '4px solid #991b1b',
              borderRadius: 8,
              background: '#fef2f2',
              marginBottom: 12,
            }}
            data-send-modal-next-batch
          >
            <div
              style={{fontSize: 11, color: '#991b1b', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5}}
            >
              Next forecast batch
            </div>
            <div style={{fontSize: 14, fontWeight: 700, color: '#111827', marginTop: 2}}>{next.name}</div>
            <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>
              {next.label} · {next.animalIds.length} {next.animalIds.length === 1 ? 'cow' : 'cows'} eligible
            </div>
          </div>
        )}

        {!loading && !next && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: '#fef2f2',
              border: '1px solid #fca5a5',
              color: '#991b1b',
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            No planned batch from the Forecast — no eligible cattle land in the display window. Add weights or DOB to
            bring cattle into the forecast first.
          </div>
        )}

        {!loading && gateBlocked.length > 0 && (
          <div
            data-send-modal-outside-tags
            data-send-modal-outside-reason={isEmptyScheduled ? 'empty_scheduled' : 'outside_projection'}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              background: '#fffbeb',
              border: '1px solid #fde68a',
              color: '#92400e',
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            <div style={{fontWeight: 700, marginBottom: 4}}>
              {isEmptyScheduled
                ? 'Heads up: no projected cattle for this scheduled batch'
                : 'Heads up: tags outside the projected cohort'}
            </div>
            <div style={{display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6}}>
              {gateBlocked.map((t) => (
                <span
                  key={t}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'white',
                    color: '#92400e',
                    border: '1px solid #fde68a',
                  }}
                >
                  #{t}
                </span>
              ))}
            </div>
            <div style={{fontSize: 11, color: '#78350f'}}>
              {isEmptyScheduled
                ? 'No cattle are currently projected for this scheduled batch. The actual cattle you send override the projection — only the selected entries move to processed.'
                : "These tags aren't in the next batch's projected cohort. The actual cattle you send override the projection — only the selected entries move to processed. Confirm if you intend to send them anyway."}
            </div>
          </div>
        )}

        {!loading && next && !hardBlocked && (
          <div style={{fontSize: 12, color: '#374151', marginBottom: 12}}>
            This will {next.source === 'scheduled' ? 'promote scheduled batch' : 'create active batch'}{' '}
            <strong>{next.name}</strong> and send <strong>{flaggedEntries.length}</strong>{' '}
            {flaggedEntries.length === 1 ? 'cow' : 'cattle'} to processor. Processing date will be set to{' '}
            <strong>{sessionDate}</strong>.
          </div>
        )}

        {err && (
          <div
            style={{
              color: '#b91c1c',
              fontSize: 12,
              marginBottom: 10,
              padding: '6px 10px',
              background: '#fef2f2',
              borderRadius: 6,
            }}
          >
            {err}
          </div>
        )}

        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: '8px 14px',
              borderRadius: 7,
              border: '1px solid #d1d5db',
              background: 'white',
              color: '#374151',
              fontWeight: 600,
              fontSize: 12,
              cursor: busy ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Cancel
          </button>
          <button
            onClick={go}
            disabled={busy || loading || hardBlocked || !canSend}
            data-send-modal-confirm
            style={{
              padding: '8px 16px',
              borderRadius: 7,
              border: 'none',
              background: busy || loading || hardBlocked || !canSend ? '#9ca3af' : '#991b1b',
              color: 'white',
              fontWeight: 700,
              fontSize: 12,
              cursor: busy || loading || hardBlocked || !canSend ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {busy ? 'Attaching…' : 'Send to processor'}
          </button>
        </div>
      </div>
    </div>
  );
}
