// Shared helpers for attaching sheep weigh-in entries to a processing batch.
// Mirrors src/lib/cattleProcessingBatch.js attach semantics. Detach is owned
// exclusively by migration 170's transactional SECDEF RPC wrapper.

import {recordActivityEvent} from './activityApi.js';

export function recomputeBatchTotals(rows) {
  const live = rows.reduce((s, r) => s + (parseFloat(r.live_weight) || 0), 0);
  const hang = rows.reduce((s, r) => s + (parseFloat(r.hanging_weight) || 0), 0);
  return {
    total_live_weight: live > 0 ? Math.round(live * 10) / 10 : null,
    total_hanging_weight: hang > 0 ? Math.round(hang * 10) / 10 : null,
  };
}

// Walk sheep.tag + old_tags the same way the webform and admin tab do when
// resolving prior-tag history. Excludes source='import' (selling-farm tags
// can collide with WCF's own numbering — same rule as cattle).
function findSheepByAnyTag(sheepList, tag) {
  if (!tag) return null;
  const t = String(tag).trim();
  const byCurrent = sheepList.find((s) => s.tag === t);
  if (byCurrent) return byCurrent;
  return (
    sheepList.find(
      (s) => Array.isArray(s.old_tags) && s.old_tags.some((ot) => ot && ot.tag === t && ot.source !== 'import'),
    ) || null
  );
}

// Create a new planned processing batch with the supplied name + date.
// Returns the inserted row. No sheep_detail yet — attachEntriesToBatch
// handles that in the next step.
export async function createProcessingBatch(sb, {name, plannedDate}) {
  const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    name: (name || '').trim(),
    planned_process_date: plannedDate || null,
    actual_process_date: null,
    processing_cost: null,
    notes: null,
    status: 'planned',
    sheep_detail: [],
    total_live_weight: null,
    total_hanging_weight: null,
  };
  const {error} = await sb.from('sheep_processing_batches').insert(rec);
  if (error) throw new Error('Could not create batch: ' + error.message);
  return rec;
}

// Attach a set of weigh-in entries to an existing processing batch:
//   * Append each entry's sheep to batch.sheep_detail with live_weight = entry.weight.
//   * Set sheep.flock='processed' + sheep.processing_batch_id=batch.id.
//   * Insert a sheep_transfers row per sheep (reason='processing_batch').
//   * Stamp weigh_ins.target_processing_batch_id + prior_herd_or_flock for audit.
//   * Batch status stays 'planned' — processing happens later at the processor.
//
// Returns {attached, skipped}. Skipped entries include the reason:
//   'no_sheep_for_tag' | 'already_in_batch' | 'tagless'
export async function attachEntriesToBatch(sb, {batch, entries, sheepList, teamMember}) {
  const attached = [];
  const skipped = [];
  const existingRows = Array.isArray(batch.sheep_detail) ? batch.sheep_detail.slice() : [];
  const existingIds = new Set(existingRows.map((r) => r.sheep_id));

  for (const e of entries) {
    if (!e.tag) {
      skipped.push({entry: e, reason: 'tagless'});
      continue;
    }
    const sheep = findSheepByAnyTag(sheepList, e.tag);
    if (!sheep) {
      skipped.push({entry: e, reason: 'no_sheep_for_tag'});
      continue;
    }
    if (existingIds.has(sheep.id)) {
      skipped.push({entry: e, reason: 'already_in_batch'});
      continue;
    }
    existingRows.push({
      sheep_id: sheep.id,
      tag: sheep.tag || e.tag || null,
      live_weight: parseFloat(e.weight) || null,
      hanging_weight: null,
    });
    existingIds.add(sheep.id);
    attached.push({entry: e, sheep});
  }

  const totals = recomputeBatchTotals(existingRows);
  const batchUpdate = await sb
    .from('sheep_processing_batches')
    .update({sheep_detail: existingRows, ...totals})
    .eq('id', batch.id);
  if (batchUpdate.error) throw new Error('Could not update batch: ' + batchUpdate.error.message);

  for (const {entry, sheep} of attached) {
    // Stamp the weigh_in's prior_herd_or_flock BEFORE moving the sheep to
    // 'processed', and ONLY when transitioning non-processed → processed
    // (mirrors the cattle Codex Edge Case #1 fix).
    const wiUpdate = {target_processing_batch_id: batch.id};
    if (sheep.flock && sheep.flock !== 'processed') wiUpdate.prior_herd_or_flock = sheep.flock;
    try {
      await sb.from('weigh_ins').update(wiUpdate).eq('id', entry.id);
    } catch (err) {
      /* columns only exist post-migrations 015 / 027 */
    }

    await sb.from('sheep').update({processing_batch_id: batch.id, flock: 'processed'}).eq('id', sheep.id);
    if (sheep.flock !== 'processed') {
      try {
        await sb.from('sheep_transfers').insert({
          id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
          sheep_id: sheep.id,
          from_flock: sheep.flock,
          to_flock: 'processed',
          reason: 'processing_batch',
          reference_id: batch.id,
          team_member: teamMember || null,
        });
      } catch (err) {
        /* sheep_transfers only exists post-migration-029 */
      }
    }
  }

  // Best-effort field.updated on the sheep.processing stream (batch.id) so the
  // login-gated webform attach is audited (the authenticated RPC path logs its
  // own event). Never blocks the attach.
  try {
    await recordActivityEvent(sb, {
      entityType: 'sheep.processing',
      entityId: batch.id,
      eventType: 'field.updated',
      entityLabel: batch.name || batch.id,
      body: 'Attached ' + attached.length + ' sheep to ' + (batch.name || 'batch') + ' (webform)',
      payload: {
        record: 'sheep.processing',
        field: 'sheep_detail',
        action: 'attach',
        attached: attached.length,
        skipped: skipped.length,
      },
    });
  } catch (_e) {
    /* best-effort audit trail */
  }

  return {attached, skipped};
}
