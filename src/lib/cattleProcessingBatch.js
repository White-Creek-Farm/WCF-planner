// Shared helpers for attaching cattle weigh-in entries to a processing batch.
// Called from both the webform (WeighInsWebform) and the admin tab
// (CattleWeighInsView) so the two surfaces land identical DB state when a
// cattle finisher session is completed with send-to-processor entries.

export function recomputeBatchTotals(rows) {
  const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  return {
    total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
    total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
  };
}

// Walk cattle.tag + old_tags the same way the webform and admin tab do when
// resolving prior-tag history. Excludes source='import' (selling-farm tags
// can collide with WCF's own numbering).
function findCowByAnyTag(cattleList, tag) {
  if (!tag) return null;
  const t = String(tag).trim();
  const byCurrent = cattleList.find((c) => c.tag === t);
  if (byCurrent) return byCurrent;
  return (
    cattleList.find(
      (c) => Array.isArray(c.old_tags) && c.old_tags.some((ot) => ot && ot.tag === t && ot.source !== 'import'),
    ) || null
  );
}

// Promote an existing SCHEDULED row to ACTIVE. Used by Send-to-Processor
// when the next forecast batch already has a status='scheduled' row
// (the operator booked a date with the processor ahead of time). Sets
// status='active' and actual_process_date to the weigh-in session date,
// then returns the updated row so attachEntriesToBatch can append
// cows_detail to it. cows_detail starts as whatever was on the
// scheduled row (normally '[]'), preserving any prior shape.
export async function promoteScheduledBatch(sb, scheduledRow, {processingDate}) {
  if (!scheduledRow || !scheduledRow.id) {
    throw new Error('promoteScheduledBatch: missing scheduled row');
  }
  if (scheduledRow.status && scheduledRow.status !== 'scheduled') {
    throw new Error('promoteScheduledBatch: row is not in scheduled state');
  }
  const update = {
    status: 'active',
    actual_process_date: processingDate || null,
  };
  const {error} = await sb.from('cattle_processing_batches').update(update).eq('id', scheduledRow.id);
  if (error) throw new Error('Could not promote scheduled batch: ' + error.message);
  return {...scheduledRow, ...update};
}

// Create a new ACTIVE processing batch from a Send-to-Processor flow when
// no matching scheduled row exists. Mig 054 added 'scheduled' as a valid
// status alongside 'active' and 'complete'; planned batches stay virtual.
// Send-to-Processor either PROMOTES a scheduled row (via
// promoteScheduledBatch above) or CREATES a fresh active row here. The
// processing date is the weigh_in_sessions.date, NOT the system date.
// Returns the inserted row. No cows_detail yet -- attachEntriesToBatch
// handles that in the next step.
export async function createProcessingBatch(sb, {name, processingDate}) {
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    name: (name || '').trim(),
    planned_process_date: processingDate || null,
    actual_process_date: processingDate || null,
    processing_cost: null,
    notes: null,
    status: 'active',
    cows_detail: [],
    total_live_weight: null,
    total_hanging_weight: null,
  };
  const {error} = await sb.from('cattle_processing_batches').insert(rec);
  if (error) throw new Error('Could not create batch: ' + error.message);
  return rec;
}

// Attach a set of weigh-in entries to an existing processing batch:
//   * Append each entry's cow to batch.cows_detail with live_weight = entry.weight.
//   * Set cattle.herd='processed' + cattle.processing_batch_id=batch.id.
//   * Insert a cattle_transfers row per cow (reason='processing_batch').
//   * Stamp weigh_ins.target_processing_batch_id for audit.
//   * Batch status stays 'planned' -- processing happens later at the processor.
//
// Returns {attached, skipped}. Skipped entries include the reason:
//   'no_cow_for_tag' | 'already_in_batch' | 'tagless'
export async function attachEntriesToBatch(sb, {batch, entries, cattleList, teamMember}) {
  const attached = [];
  const skipped = [];
  const existingRows = Array.isArray(batch.cows_detail) ? batch.cows_detail.slice() : [];
  const existingCowIds = new Set(existingRows.map((r) => r.cattle_id));

  for (const e of entries) {
    if (!e.tag) {
      skipped.push({entry: e, reason: 'tagless'});
      continue;
    }
    const cow = findCowByAnyTag(cattleList, e.tag);
    if (!cow) {
      skipped.push({entry: e, reason: 'no_cow_for_tag'});
      continue;
    }
    if (existingCowIds.has(cow.id)) {
      skipped.push({entry: e, reason: 'already_in_batch'});
      continue;
    }
    existingRows.push({
      cattle_id: cow.id,
      tag: cow.tag || e.tag || null,
      live_weight: parseFloat(e.weight) || null,
      hanging_weight: null,
    });
    existingCowIds.add(cow.id);
    attached.push({entry: e, cow});
  }

  const totals = recomputeBatchTotals(existingRows);
  const batchUpdate = await sb
    .from('cattle_processing_batches')
    .update({cows_detail: existingRows, ...totals})
    .eq('id', batch.id);
  if (batchUpdate.error) throw new Error('Could not update batch: ' + batchUpdate.error.message);

  for (const {entry, cow} of attached) {
    // Stamp the weigh_in's prior_herd_or_flock BEFORE moving the cow to
    // 'processed', and ONLY when transitioning non-processed → processed
    // (Codex Edge Case #1: don't capture 'processed' as the prior state if
    // a cow gets re-attached to a different batch). The detach helper reads
    // this column first when reverting.
    const wiUpdate = {target_processing_batch_id: batch.id};
    if (cow.herd && cow.herd !== 'processed') wiUpdate.prior_herd_or_flock = cow.herd;
    try {
      await sb.from('weigh_ins').update(wiUpdate).eq('id', entry.id);
    } catch (err) {
      /* columns only exist post-migrations 015 / 027 */
    }

    await sb.from('cattle').update({processing_batch_id: batch.id, herd: 'processed'}).eq('id', cow.id);
    if (cow.herd !== 'processed') {
      try {
        await sb.from('cattle_transfers').insert({
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          cattle_id: cow.id,
          from_herd: cow.herd,
          to_herd: 'processed',
          reason: 'processing_batch',
          reference_id: batch.id,
          team_member: teamMember || null,
        });
      } catch (err) {
        /* cattle_transfers RLS may block on legacy roles */
      }
    }
  }

  return {attached, skipped};
}

// Detach a cow from her processing batch. Reverses the attach side effects
// in the safest auditable order:
//
//   1. Resolve the prior herd via the fallback hierarchy:
//        a. weigh_ins.prior_herd_or_flock for the entry that attached her
//        b. latest cattle_transfers row WHERE cattle_id = cow.id AND
//           reason='processing_batch' AND reference_id=batchId, use from_herd
//        c. neither available → return {ok:false, reason:'no_prior_herd'}
//      Never silently default. Caller decides how to surface the failure.
//
//   2. Remove the cow's row from batch.cows_detail and recompute totals.
//   3. Set cattle.herd = priorHerd, cattle.processing_batch_id = null.
//   4. Insert a cattle_transfers row with reason='processing_batch_undo'.
//   5. Clear weigh_ins.target_processing_batch_id (and optionally
//      send_to_processor) on every weigh-in that targeted this batch for
//      this cow's tag, so a subsequent flag-clear doesn't double-fire.
//
// Returns {ok, reason, cow, priorHerd, batchId, weighInIdsCleared}.
// reason values:
//   'detached'        — happy path
//   'no_cow'          — cowId resolves to no row
//   'no_batch'        — batchId resolves to no row
//   'not_in_batch'    — cow.processing_batch_id !== batchId
//   'no_prior_herd'   — neither weigh_ins.prior_herd_or_flock nor an audit row found
export async function detachCowFromBatch(sb, cowId, batchId, opts = {}) {
  if (!cowId || !batchId) return {ok: false, reason: 'bad_args'};
  const teamMember = opts.teamMember || null;

  const cowR = await sb.from('cattle').select('*').eq('id', cowId).maybeSingle();
  if (cowR.error || !cowR.data) return {ok: false, reason: 'no_cow', cowId};
  const cow = cowR.data;
  if (cow.processing_batch_id !== batchId) {
    return {ok: false, reason: 'not_in_batch', cow, batchId};
  }

  const batchR = await sb.from('cattle_processing_batches').select('*').eq('id', batchId).maybeSingle();
  if (batchR.error || !batchR.data) return {ok: false, reason: 'no_batch', cow, batchId};
  const batch = batchR.data;

  // Step 1a: read prior_herd_or_flock from any weigh_in that attached this
  // cow to this batch. There may be more than one (multi-session); prefer
  // the most recent (entered_at desc).
  const wisR = await sb
    .from('weigh_ins')
    .select('id, prior_herd_or_flock, entered_at, send_to_processor, target_processing_batch_id, tag')
    .eq('target_processing_batch_id', batchId)
    .eq('tag', cow.tag || '')
    .order('entered_at', {ascending: false});
  const wis = wisR.data || [];
  let priorHerd = null;
  for (const w of wis) {
    if (w.prior_herd_or_flock) {
      priorHerd = w.prior_herd_or_flock;
      break;
    }
  }

  // Step 1b: fall back to most recent matching audit row.
  if (!priorHerd) {
    const trfR = await sb
      .from('cattle_transfers')
      .select('from_herd, transferred_at')
      .eq('cattle_id', cow.id)
      .eq('reason', 'processing_batch')
      .eq('reference_id', batchId)
      .order('transferred_at', {ascending: false})
      .limit(1);
    if (trfR.data && trfR.data.length > 0 && trfR.data[0].from_herd) {
      priorHerd = trfR.data[0].from_herd;
    }
  }

  // Step 1c: nothing found — block with reason rather than guess.
  if (!priorHerd) {
    return {ok: false, reason: 'no_prior_herd', cow, batchId};
  }

  // Step 2: remove this cow from batch.cows_detail, recompute totals.
  const newDetail = (Array.isArray(batch.cows_detail) ? batch.cows_detail : []).filter((r) => r.cattle_id !== cow.id);
  const totals = recomputeBatchTotals(newDetail);
  const batchUpd = await sb
    .from('cattle_processing_batches')
    .update({cows_detail: newDetail, ...totals})
    .eq('id', batchId);
  if (batchUpd.error) return {ok: false, reason: 'batch_update_failed', error: batchUpd.error.message, cow, batchId};

  // Step 3: revert cow.
  const cowUpd = await sb.from('cattle').update({herd: priorHerd, processing_batch_id: null}).eq('id', cow.id);
  if (cowUpd.error) return {ok: false, reason: 'cow_update_failed', error: cowUpd.error.message, cow, batchId};

  // Step 4: audit row.
  try {
    await sb.from('cattle_transfers').insert({
      id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
      cattle_id: cow.id,
      from_herd: 'processed',
      to_herd: priorHerd,
      reason: 'processing_batch_undo',
      reference_id: batchId,
      team_member: teamMember,
    });
  } catch (err) {
    /* audit log nice-to-have */
  }

  // Step 5: clear the matching weigh_ins. We unset BOTH target_processing_
  // batch_id (the link to this batch) AND send_to_processor (the flag that
  // would otherwise still render as a red "✓ Processor" chip on the
  // weigh-in row). Setting send_to_processor=false twice when this detach
  // was triggered FROM a flag-clear is harmless (idempotent — both writes
  // land the same value).
  const cleared = [];
  for (const w of wis) {
    try {
      await sb
        .from('weigh_ins')
        .update({
          target_processing_batch_id: null,
          send_to_processor: false,
        })
        .eq('id', w.id);
      cleared.push(w.id);
    } catch (err) {
      /* tolerated */
    }
  }

  return {ok: true, reason: 'detached', cow, priorHerd, batchId, weighInIdsCleared: cleared};
}
