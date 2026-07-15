// ============================================================================
// PigSendToTripModal — planned-trip-driven send confirmation
// ============================================================================
// Lane: pig planned processing trips. Codex's spec retires the old
// "Existing trip / New trip" arbitrary picker as the primary processor
// send. The modal now resolves the source sub-batch from the session
// (via pigSlug), looks up the next planned trip in the (subBatchId, sex)
// chain, and previews reconcilePlannedTripsForSend before committing.
//
// Inline error paths (no DB writes when any of these surface):
//   - Cannot resolve source sub-batch from session (mixed-session edge).
//   - No planned trip exists for the (subBatchId, sex) chain.
//   - Selected count > total chain plannedCount (over-pull exhausted).
//
// Under-pull with no next trip does NOT block. The preview helper surfaces
// remainderStayedOnTarget=true for that branch, but the authoritative
// server reconcile (mig 176 pig_send_to_trip) PROMOTES the target planned
// trip's id into the actual trip and moves the remainder onto a NEW
// planned trip — so the copy for this branch must say the remainder moves
// to a new planned trip, never that it stays on the original one.
//
// onConfirm receives {groupId, sourceSubId, sourceSubSex, sendCount}.
// The parent (LivestockWeighInsView) re-runs reconcilePlannedTripsForSend
// for the actual mutation so the helper is the single source of truth.

import React from 'react';
import {fmt, todayCentralISO} from '../lib/dateUtils.js';
import {pigSlug} from '../lib/pig.js';
import {reconcilePlannedTripsForSend} from '../lib/pigForecast.js';
import {recordSaveButton, recordSecondaryButton} from '../shared/recordPageControls.jsx';

function resolveSourceSub(session, feederGroups) {
  if (!session || !session.batch_id) return null;
  const s = pigSlug(session.batch_id);
  for (const g of feederGroups || []) {
    for (const sb of g.subBatches || []) {
      if (pigSlug(sb.name) === s) {
        return {group: g, sub: sb};
      }
    }
  }
  return null;
}

function inferSex(sub) {
  if (!sub) return null;
  const gilt = parseInt(sub.giltCount) || 0;
  const boar = parseInt(sub.boarCount) || 0;
  if (gilt > 0 && boar === 0) return 'gilt';
  if (boar > 0 && gilt === 0) return 'boar';
  return null; // mixed-sex sub — cannot send through planned-trip flow
}

function describeReconciliation(sendCount, targetCount, pushedRemainder, remainderStayedOnTarget) {
  if (sendCount === targetCount) {
    return `Sending ${sendCount} pigs will fulfill the planned trip exactly.`;
  }
  if (sendCount < targetCount) {
    if (remainderStayedOnTarget) {
      return `Sending ${sendCount} of the planned ${targetCount}; the remaining ${pushedRemainder} pigs will move to a new planned trip for a later send.`;
    }
    return `Sending ${sendCount} of the planned ${targetCount}; the remaining ${pushedRemainder} pigs will push forward to the next planned trip.`;
  }
  return `Sending ${sendCount} pigs (${sendCount - targetCount} more than the planned ${targetCount}); the extra will be pulled from later planned trips in chain order.`;
}

const PigSendToTripModal = ({session, selectedEntries, feederGroups, onClose, onConfirm}) => {
  const {useState, useMemo} = React;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const totalWeight = (selectedEntries || []).reduce((s, e) => s + (parseFloat(e.weight) || 0), 0);
  const sendCount = (selectedEntries || []).length;

  const {group, sub, sex, recon, blockerError} = useMemo(() => {
    const resolved = resolveSourceSub(session, feederGroups);
    if (!resolved) {
      return {
        group: null,
        sub: null,
        sex: null,
        recon: null,
        blockerError:
          'Cannot resolve the source sub-batch from this weigh-in session. Open /pig/batches to confirm the sub-batch name matches.',
      };
    }
    const inferred = inferSex(resolved.sub);
    if (!inferred) {
      return {
        group: resolved.group,
        sub: resolved.sub,
        sex: null,
        recon: null,
        blockerError:
          'Source sub-batch is mixed-sex. Split into separate gilt/boar subgroups on /pig/batches before sending to processor.',
      };
    }
    if (sendCount <= 0) {
      return {group: resolved.group, sub: resolved.sub, sex: inferred, recon: null, blockerError: ''};
    }
    const r = reconcilePlannedTripsForSend(resolved.group.plannedProcessingTrips || [], {
      subBatchId: resolved.sub.id,
      sex: inferred,
      sendCount,
      today: todayCentralISO(),
    });
    return {
      group: resolved.group,
      sub: resolved.sub,
      sex: inferred,
      recon: r.error ? null : r,
      blockerError: r.error || '',
    };
  }, [session, feederGroups, sendCount]);

  async function go() {
    if (busy) return;
    setErr('');
    if (blockerError) {
      setErr(blockerError);
      return;
    }
    if (!group || !sub || !sex) {
      setErr('Cannot send — source resolution failed.');
      return;
    }
    setBusy(true);
    try {
      await onConfirm({
        groupId: group.id,
        sourceSubId: sub.id,
        sourceSubSex: sex,
        sendCount,
      });
    } catch (e) {
      setErr((e && e.message) || 'Failed');
      setBusy(false);
    }
  }

  const lblS = {display: 'block', fontSize: 12, color: 'var(--ink)', marginBottom: 4, fontWeight: 600};

  // Find the planned target trip for the preview (recon already verified it).
  const targetTrip = recon ? (group.plannedProcessingTrips || []).find((t) => t.id === recon.targetTripId) : null;

  return (
    <div
      data-pig-send-modal="1"
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
    >
      <div
        style={{
          background: 'white',
          borderRadius: 12,
          maxWidth: 460,
          width: '100%',
          padding: '18px 20px',
          boxShadow: '0 12px 40px rgba(0,0,0,.25)',
        }}
      >
        <div style={{fontSize: 15, fontWeight: 700, color: 'var(--ink)', marginBottom: 10}}>
          {'🚚 Send ' + sendCount + ' weigh-ins to next planned trip'}
        </div>
        <div style={{fontSize: 11, color: 'var(--ink-muted)', marginBottom: 14}}>
          {'Total live weight: ' + totalWeight.toFixed(1) + ' lb'}
        </div>

        {sub && sex && (
          <div style={{...lblS}}>
            <span style={{fontWeight: 700, color: 'var(--ink)'}}>{sub.name}</span>{' '}
            <span style={{color: 'var(--ink-muted)'}}>({sex})</span>
          </div>
        )}

        {recon && targetTrip && (
          <div data-pig-send-target="1" style={{marginBottom: 12}}>
            <div style={{fontSize: 11, color: 'var(--ink)'}}>
              Target planned trip: <strong>{fmt(recon.targetTripDate)}</strong> · planned{' '}
              <strong>{targetTrip.plannedCount}</strong> pigs
            </div>
            <div
              data-pig-send-summary="1"
              style={{
                fontSize: 11,
                color: 'var(--info)',
                background: 'var(--info-soft)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '6px 10px',
                marginTop: 6,
              }}
            >
              {describeReconciliation(
                sendCount,
                targetTrip.plannedCount,
                recon.pushedRemainder,
                !!recon.remainderStayedOnTarget,
              )}
            </div>
          </div>
        )}

        {(blockerError || err) && (
          <div
            data-pig-send-error="1"
            style={{
              color: '#b91c1c',
              fontSize: 12,
              marginBottom: 10,
              padding: '6px 10px',
              background: '#fef2f2',
              borderRadius: 10,
            }}
          >
            {blockerError || err}
          </div>
        )}

        <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end'}}>
          <button
            data-pig-send-cancel="1"
            onClick={onClose}
            disabled={busy}
            style={{
              ...recordSecondaryButton,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            data-pig-send-confirm="1"
            onClick={go}
            disabled={busy || !!blockerError || !recon}
            style={{
              ...recordSaveButton,
              border: 'none',
              background: busy || !!blockerError || !recon ? '#9ca3af' : '#047857',
              fontWeight: 700,
              cursor: busy || !!blockerError || !recon ? 'not-allowed' : 'pointer',
            }}
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PigSendToTripModal;
