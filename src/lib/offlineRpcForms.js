// Form-kind registry for the parent-aware RPC offline submission queue.
//
// Distinct from src/lib/offlineForms.js (the flat table-insert registry):
//   - Flat path: queue worker calls sb.from(table).insert(record). 23505 on
//     *_client_submission_id_uq is treated as success (replay landed).
//   - RPC path: queue worker calls sb.rpc(record.rpc, record.args). The RPC
//     function owns idempotency internally — it returns {idempotent_replay:
//     true} on a replay rather than raising 23505. A 23505 from this path
//     means the function body itself raised one (a bug), not idempotency.
//     The companion hook useOfflineRpcSubmit treats those as schema-class
//     errors and surfaces them via the stuck modal.
//
// Why a separate registry: forms that produce N child rows from one operator
// submission (e.g. /addfeed broiler 3 batches) cannot use the flat-insert
// model — atomicity + photo attribution both break. They submit via a
// SECURITY DEFINER RPC that wraps parent + children in one transaction.
// The hook needs to know it's calling .rpc() not .from().insert(), and the
// queued record shape differs.
//
// Phase 1C-A ships the AddFeed entry. Future RPC-based forms (e.g. a
// weigh-in batch RPC that needs prior-tag side effects) drop in here as
// additional entries.
//
// Locked decisions:
//   - Child IDs are deterministic from parentId + index ('${parentId}-c${i}').
//     Retry produces byte-identical RPC args without persisting separate
//     child-id state. csid + parentId are minted once at submit() entry by
//     the hook and persisted in the queued record.
//   - Children DO NOT carry client_submission_id (parent owns dedup —
//     mig 030 unique index on each child table's csid would 23505 on
//     insert #2 of any multi-child submission if the parent's csid bled
//     through). Locked by the add_feed_parent_submission spec.
//   - broiler payload routes to poultry_dailys via the program key inside
//     the RPC; we just pass program='broiler'.
//   - pig children OMIT feed_type (pig_dailys has no such column).
//
// buildArgs is pure: same (payload, csid, parentId) → same args. This is
// critical for replay determinism.

const REGISTRY = Object.freeze({
  // -----------------------------------------------------------------------
  // Phase 1C-D — WeighIns fresh-draft session creation (pig + broiler only)
  // -----------------------------------------------------------------------
  // Wraps mig 035's submit_weigh_in_session_batch(parent_in jsonb, entries_in
  // jsonb). Creates one weigh_in_sessions parent + N weigh_ins children
  // atomically. v1 species allowlist: pig | broiler. v1 status allowlist:
  // 'draft' only. Completion stays online-direct via finalizeSession (and
  // for broiler, writeBroilerBatchAvg).
  //
  // Determinism contract (Codex review v2):
  //   - parentId is minted by useOfflineRpcSubmit at submit() entry; reused
  //     for parent_in.id and as the prefix for child IDs ${parentId}-c${i}.
  //     So buildArgs is purely positional over payload.entries — local UI
  //     IDs (e.g. 'local-3') never reach the RPC.
  //   - started_at / entered_at are PASS-THROUGH fields on the payload.
  //     The CALLER stamps them (startNewSession for started_at; addEntry /
  //     pre-saveBatch for entered_at) so byte-identical args are produced
  //     on every buildRpcRequest(payload, ids) call. If a caller omits a
  //     timestamp, the RPC defaults the column to now() at INSERT time —
  //     acceptable, but breaks replay-stable timing.
  //   - Children carry NO client_submission_id (parent owns dedup; mig 030
  //     unique index would 23505 on entry #2 if csid bled through).
  //   - NO side-effect columns: send_to_processor, target_processing_batch_id,
  //     sent_to_trip_id, transferred_to_breeding, transfer_breeder_id,
  //     feed_allocation_lbs, prior_herd_or_flock, reconcile_intent. All are
  //     runtime-only concerns deferred to a future RPC.
  //   - broiler_week omitted from parent_in when species='pig' (RPC coerces
  //     to NULL anyway; we keep the queued record clean).
  weigh_in_session_batch: Object.freeze({
    rpc: 'submit_weigh_in_session_batch',
    /**
     * @param {object} payload
     *   {species: 'pig' | 'broiler',
     *    date, team_member,
     *    batch_id?, broiler_week?,            // broiler_week only for broiler
     *    started_at?,                          // ISO timestamptz, stamped by caller
     *    notes?,
     *    entries: [{weight, tag?, note?, new_tag_flag?, entered_at?}, ...]}
     * @param {{csid: string, parentId: string}} ids
     * @returns {{rpc: string, args: {parent_in: object, entries_in: object[]}}}
     */
    buildArgs(payload, {csid, parentId}) {
      const parent_in = {
        id: parentId,
        client_submission_id: csid,
        species: payload.species,
        status: 'draft',
        date: payload.date,
        team_member: payload.team_member,
        batch_id: payload.batch_id ?? null,
      };
      // broiler_week is required for broiler; omitted entirely for pig so
      // the queued record stays honest with the v1 RPC contract.
      if (payload.species === 'broiler') {
        parent_in.broiler_week = payload.broiler_week;
      }
      // started_at / notes optional pass-through.
      if (payload.started_at) parent_in.started_at = payload.started_at;
      if (payload.notes != null) parent_in.notes = payload.notes;

      const entries_in = (payload.entries ?? []).map((e, i) => {
        const child = {
          id: `${parentId}-c${i}`,
          weight: e.weight,
          tag: e.tag ?? null,
          note: e.note ?? null,
          new_tag_flag: !!e.new_tag_flag,
        };
        if (e.entered_at) child.entered_at = e.entered_at;
        return child;
      });

      return {
        rpc: 'submit_weigh_in_session_batch',
        args: {parent_in, entries_in},
      };
    },
  }),
  // -----------------------------------------------------------------------
  // C3 — Public Tasks webform submit
  // -----------------------------------------------------------------------
  // Wraps mig 041's submit_task_instance(parent_in jsonb). Anon-callable
  // SECDEF function: validates submitted_by against the visible-roster
  // filter for 'tasks-public', validates assignee against eligible profiles
  // minus tasks_public_assignee_availability.hiddenProfileIds, and inserts
  // one task_instances row idempotent-by-csid.
  //
  // TasksWebform passes opts.parentId = 'ti-' + crypto.randomUUID() so the
  // queued record's parent.id matches the task_instances PK convention. If
  // the caller forgot, useOfflineRpcSubmit defaults parentId to
  // ${formKind}-<ts>-<rand>, which would PASS but break the conventional
  // 'ti-...' shape.
  //
  // Idempotency: the RPC handles the 23505 path internally and returns
  // {idempotent_replay: true} on replay. Callers see no error.
  task_submit: Object.freeze({
    rpc: 'submit_task_instance',
    // C3.1b opt-in: useOfflineRpcSubmit's hasPhoto branch fires only for
    // entries that carry this flag. Other registry entries
    // (weigh_in_session_batch, add_feed_batch) keep their existing
    // no-photo path verbatim — no opts.photo, no blob persistence,
    // no replay re-upload.
    hasPhoto: true,
    /**
     * @param {object} payload
     *   {title, description, due_date,
     *    assignee_profile_id, submitted_by_team_member}
     * @param {{csid: string, parentId: string, requestPhotoDbPath?: string}} ids
     *   `requestPhotoDbPath` is the bucket-prefixed storage path the
     *   task-request-photos bucket holds; the hook only sets it after
     *   a successful upload, otherwise it stays null/undefined and the
     *   field is omitted from parent_in.
     * @returns {{rpc: string, args: {parent_in: object}}}
     */
    buildArgs(payload, {csid, parentId, requestPhotoDbPath}) {
      const parent_in = {
        id: parentId,
        client_submission_id: csid,
        title: payload.title,
        description: payload.description ?? null,
        due_date: payload.due_date,
        assignee_profile_id: payload.assignee_profile_id,
        submitted_by_team_member: payload.submitted_by_team_member,
      };
      if (requestPhotoDbPath) {
        parent_in.request_photo_path = requestPhotoDbPath;
      }
      return {
        rpc: 'submit_task_instance',
        args: {parent_in},
      };
    },
  }),
  // -----------------------------------------------------------------------
  // Lane H — Equipment fueling offline RPC submit
  // -----------------------------------------------------------------------
  // Wraps mig 047's submit_equipment_fueling(parent_in jsonb). SECDEF,
  // anon+authenticated EXECUTE. INSERTs one equipment_fuelings row AND bumps
  // equipment.current_<unit> via GREATEST in one transaction. Idempotent by
  // client_submission_id (ON CONFLICT DO NOTHING + fallback SELECT) — no
  // 23505 ever surfaces; the hook treats any 23xxx/P0001 as schema-class.
  //
  // Single parent, no children (mirrors task_submit's shape, not
  // add_feed_batch's). buildArgs is a thin shaper: it stamps the hook-minted
  // parentId/csid onto the otherwise pre-computed payload. ALL field math
  // (service_intervals_completed divisor rule, every_fillup_check, attachment
  // completions, photo URLs) is done in the form's submit() and arrives in
  // `payload` already shaped — so buildArgs stays pure and replay-stable.
  //
  // Photos: NOT a hasPhoto entry. The form uploads photos synchronously to
  // the equipment-maintenance-docs bucket on file-input change (existing
  // model, unchanged this lane). Whatever photo descriptors already landed
  // are carried through `payload.photos` as plain data — the queued RPC
  // replay re-sends the same URLs; no photo-blob offline queue is added.
  //
  // tracking_unit contract: the RPC requires hours_reading>0 for
  // tracking_unit=hours (km_reading nulled) and the mirror for km. The form
  // sets exactly one of the two on the payload by the piece's tracking_unit,
  // so buildArgs passes both through verbatim (one is always null).
  equipment_fueling: Object.freeze({
    rpc: 'submit_equipment_fueling',
    /**
     * @param {object} payload — fully-computed fueling record minus identity.
     *   {equipment_id, date, team_member, fuel_type,
     *    gallons, def_gallons, fuel_cost_per_gal,
     *    hours_reading, km_reading,
     *    every_fillup_check, service_intervals_completed,
     *    photos, comments, source, podio_source_app}
     * @param {{csid: string, parentId: string}} ids
     * @returns {{rpc: string, args: {parent_in: object}}}
     */
    buildArgs(payload, {csid, parentId}) {
      const parent_in = {
        id: parentId,
        client_submission_id: csid,
        equipment_id: payload.equipment_id,
        date: payload.date,
        team_member: payload.team_member,
        fuel_type: payload.fuel_type ?? null,
        gallons: payload.gallons,
        def_gallons: payload.def_gallons ?? null,
        fuel_cost_per_gal: payload.fuel_cost_per_gal ?? null,
        hours_reading: payload.hours_reading ?? null,
        km_reading: payload.km_reading ?? null,
        every_fillup_check: payload.every_fillup_check ?? [],
        service_intervals_completed: payload.service_intervals_completed ?? [],
        photos: payload.photos ?? [],
        comments: payload.comments ?? null,
        source: payload.source ?? 'fuel_log_webform',
        podio_source_app: payload.podio_source_app ?? null,
      };
      return {
        rpc: 'submit_equipment_fueling',
        args: {parent_in},
      };
    },
  }),
  add_feed_batch: Object.freeze({
    rpc: 'submit_add_feed_batch',
    /**
     * @param {object} payload — normalized AddFeed form state.
     *   {program, date, team_member,
     *    // multi-row (broiler/pig/layer):
     *    batchLabel?, feedType?, feedLbs?, extraGroups?,
     *    // cattle:
     *    cattleHerd?, cattleFeedsJ?,
     *    // sheep:
     *    sheepFlock?, sheepFeedsJ?}
     * @param {object} ids
     * @param {string} ids.csid — client_submission_id (stable across retries)
     * @param {string} ids.parentId — daily_submissions.id (stable)
     * @returns {{rpc: string, args: {parent_in: object, children_in: object[]}}}
     */
    buildArgs(payload, {csid, parentId}) {
      const submittedAt = new Date().toISOString();
      const date = payload.date;
      const teamMember = payload.team_member ?? null;

      let children;
      let parentPayload;

      if (payload.program === 'cattle') {
        children = [
          {
            id: `${parentId}-c0`,
            submitted_at: submittedAt,
            date,
            team_member: teamMember,
            herd: payload.cattleHerd,
            feeds: payload.cattleFeedsJ ?? [],
            minerals: [],
            mortality_count: 0,
            source: 'add_feed_webform',
          },
        ];
        parentPayload = {herd: payload.cattleHerd, feeds: payload.cattleFeedsJ ?? []};
      } else if (payload.program === 'sheep') {
        children = [
          {
            id: `${parentId}-c0`,
            submitted_at: submittedAt,
            date,
            team_member: teamMember,
            flock: payload.sheepFlock,
            feeds: payload.sheepFeedsJ ?? [],
            minerals: [],
            mortality_count: 0,
            source: 'add_feed_webform',
          },
        ];
        parentPayload = {flock: payload.sheepFlock, feeds: payload.sheepFeedsJ ?? []};
      } else {
        // broiler / pig / layer — multi-row form. Each group carries
        // batchLabel + feedType + feedLbs; layer additionally carries a
        // caller-resolved batchId (from AddFeedWebform's layerBatchIdMap
        // lookup). pig derives batch_id from the slug; broiler has no
        // batch_id column.
        const main = {
          batchLabel: payload.batchLabel,
          feedType: payload.feedType ?? null,
          feedLbs: payload.feedLbs,
          batchId: payload.batchId ?? null,
        };
        const extras = (payload.extraGroups ?? []).filter((g) => g && g.batchLabel);
        const all = [main, ...extras];
        children = all.map((g, i) =>
          buildMultiRowChild(payload.program, g, parentId, i, submittedAt, date, teamMember),
        );
        parentPayload = {
          batchLabel: payload.batchLabel,
          feedType: payload.feedType ?? null,
          feedLbs: payload.feedLbs,
          extraGroups: extras,
        };
      }

      return {
        rpc: 'submit_add_feed_batch',
        args: {
          parent_in: {
            id: parentId,
            client_submission_id: csid,
            submitted_at: submittedAt,
            program: payload.program,
            source: 'add_feed_webform',
            team_member: teamMember,
            date,
            payload: parentPayload,
          },
          children_in: children,
        },
      };
    },
  }),
});

function buildMultiRowChild(program, group, parentId, index, submittedAt, date, teamMember) {
  const lbs = parseFloat(group.feedLbs);
  const base = {
    id: `${parentId}-c${index}`,
    submitted_at: submittedAt,
    date,
    team_member: teamMember,
    batch_label: group.batchLabel,
    feed_lbs: Number.isFinite(lbs) ? lbs : 0,
    source: 'add_feed_webform',
  };
  if (program === 'pig') {
    // pig_dailys has no feed_type column — RPC's pig branch ignores any
    // feed_type that arrives anyway, but we don't put it in children_in
    // either to keep the queued record honest.
    return {
      ...base,
      batch_id: (group.batchLabel || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    };
  }
  if (program === 'layer') {
    return {
      ...base,
      // batch_id for layer is resolved client-side from the layer batch map;
      // the RPC accepts whatever we send. The synchronous AddFeedWebform
      // built batch_id from layerBatchIdMap[bl] — that mapping is part of
      // the `payload` that the caller (AddFeedWebform) prepares before
      // calling submit(). Here we just pass through what was prepared.
      batch_id: group.batchId ?? null,
      feed_type: group.feedType ?? null,
    };
  }
  // broiler
  return {
    ...base,
    feed_type: group.feedType ?? null,
  };
}

export const RPC_FORM_KINDS = Object.freeze(Object.keys(REGISTRY));

export function getRpcFormConfig(formKind) {
  const entry = REGISTRY[formKind];
  if (!entry) {
    throw new Error(`offlineRpcForms: unknown form_kind ${JSON.stringify(formKind)}`);
  }
  return entry;
}

export function buildRpcRequest(formKind, payload, ids) {
  return getRpcFormConfig(formKind).buildArgs(payload, ids);
}

// Test-only export.
export const _REGISTRY = REGISTRY;
