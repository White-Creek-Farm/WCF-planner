-- ============================================================================
-- 175_processing_planner_foundation.sql
-- Processing planner integration — checkpoint 1 of 3 (additive foundation).
--
-- Build Queue item 3 makes Processing the authoritative final-stage workflow
-- while each native planner stays authoritative for source facts. This first
-- migration is purely additive metadata + read plumbing; lifecycle/reconcile
-- behavior changes land in 176 and workflow integration/corrections in 177.
--
-- 1. processing_records columns:
--    • source_phase        — pig rows only: 'planned' | 'actual'. Existing pig
--                            planner rows are all actual trips (the reconciler
--                            has only ever enumerated processingTrips), so they
--                            backfill to 'actual'. Non-pig rows stay NULL.
--    • trip_ordinal        — deterministic per-pig-group "Trip n" ordinal that
--                            survives planned-to-actual promotion. Assigned
--                            max+1 per group at record creation (176) and never
--                            reused, including by archived rows.
--    • source_removed_at   — dormant marker: a worked planner row whose source
--                            disappeared is archived + stamped here, and
--                            restores (un-archives, clears stamp) when the
--                            source returns with the same identity.
--    • lineage             — append-only jsonb log of identity events (pig
--                            under/over-send splits, promotion, restore) so
--                            planned/actual lineage is traceable on the record.
--    • removed_template_steps — tombstoned template checklist step ids. A
--                            template-linked subtask the user deletes must not
--                            be re-added by "apply latest template" (177).
--    • completed_by        — audit column stamped by mark_processing_complete.
--    • workflow_touched_at — belt-and-braces "worked" stamp maintained by the
--                            Processing-owned mutation RPCs reissued in 176/177.
-- 2. processing_subtasks.template_step_id — stable link from a seeded subtask
--    to its template checklist step. Backfilled by case-insensitive label match
--    against the program's ACTIVE template (the same match rule the previous
--    apply_current_template used), which protects "apply latest" from
--    duplicating steps that already exist under their original labels.
-- 3. Active template checklist steps gain stable ids ('stp-<uuid>') in place.
--    Inactive/historical template versions stay byte-immutable.
-- 4. Broiler identity rekey: ppp-v4 batch.id is the immutable identity; the
--    batch NAME (today's source_id) is mutable display text. Every
--    source_kind='broiler' planner row is rekeyed name -> batch.id, preserving
--    processing_records.id and all local workflow data. FAIL CLOSED: a name
--    that cannot be resolved to exactly one live batch aborts the whole
--    migration (no partial rekey).
-- 5. Processor/Customer option lists convert from plain string arrays to
--    stable-option objects [{id,label,active}] and set_processing_option_list
--    is reissued with add/rename/deactivate semantics (options can never be
--    hard-deleted; stored record labels are never rewritten).
-- 6. New caller-scoped read RPC list_my_processing_subtasks() for the My Tasks
--    "Processing work" section (link-only; no task_instances involvement).
-- 7. _processing_record_worked(): live "has local work" predicate used by the
--    176 sweep to decide empty-remove vs worked-archive. Automatically seeded
--    template steps alone do NOT make a record worked.
--
-- Deny-all RLS posture is unchanged; every new function is SECURITY DEFINER
-- SET search_path = public with narrow grants. Idempotent: IF NOT EXISTS /
-- CREATE OR REPLACE / guarded backfills. NOTIFY pgrst at the end because the
-- exposed RPC surface changes.
-- ============================================================================

-- ── 1. processing_records: planner-integration metadata ─────────────────────
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS source_phase text
    CHECK (source_phase IS NULL OR source_phase IN ('planned', 'actual'));
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS trip_ordinal integer;
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS source_removed_at timestamptz;
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS lineage jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS removed_template_steps jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.processing_records
  ADD COLUMN IF NOT EXISTS workflow_touched_at timestamptz;

-- Existing pig planner rows were enumerated from actual processingTrips only.
UPDATE public.processing_records
   SET source_phase = 'actual'
 WHERE source_kind = 'pig'
   AND record_type = 'planner_batch'
   AND source_phase IS NULL;

-- Deterministic ordinal backfill for existing pig rows: per group (the prefix
-- of the composite source_id), ordered by processing_date then source_id so a
-- re-run on identical data assigns identical numbers. Includes archived rows so
-- ordinals are never reused later.
WITH pig_rows AS (
  SELECT id,
         split_part(source_id, ':', 1) AS group_id,
         row_number() OVER (
           PARTITION BY split_part(source_id, ':', 1)
           ORDER BY processing_date ASC NULLS LAST, source_id ASC
         ) AS rn
    FROM public.processing_records
   WHERE source_kind = 'pig'
     AND record_type = 'planner_batch'
     AND source_id LIKE '%:%'
     AND trip_ordinal IS NULL
)
UPDATE public.processing_records r
   SET trip_ordinal = pig_rows.rn
  FROM pig_rows
 WHERE r.id = pig_rows.id
   -- Only when the group has no ordinals yet: a partially-numbered group must
   -- not be renumbered from 1 (re-run safety once 176 starts assigning max+1).
   AND NOT EXISTS (
     SELECT 1 FROM public.processing_records x
      WHERE x.source_kind = 'pig'
        AND x.source_id LIKE pig_rows.group_id || ':%'
        AND x.trip_ordinal IS NOT NULL
   );

-- ── 2. processing_subtasks: stable template-step linkage ────────────────────
ALTER TABLE public.processing_subtasks
  ADD COLUMN IF NOT EXISTS template_step_id text;

-- My Tasks read path: open assigned subtasks by profile.
CREATE INDEX IF NOT EXISTS processing_subtasks_assignee_open_idx
  ON public.processing_subtasks (assignee_profile_id)
  WHERE assignee_profile_id IS NOT NULL AND done = false;

-- ── 3. Stable step ids on ACTIVE template checklists (in place) ─────────────
-- Historical (inactive) template versions are immutable and intentionally left
-- without ids. Idempotent: only steps missing an id gain one.
DO $mig$
DECLARE
  v_tpl RECORD;
  v_new jsonb;
BEGIN
  FOR v_tpl IN
    SELECT id, checklist FROM public.processing_templates WHERE is_active = true
  LOOP
    SELECT COALESCE(jsonb_agg(
             CASE
               WHEN COALESCE(btrim(step->>'id'), '') <> '' THEN step
               ELSE step || jsonb_build_object('id', 'stp-' || gen_random_uuid()::text)
             END
             ORDER BY ord), '[]'::jsonb)
      INTO v_new
      FROM jsonb_array_elements(COALESCE(v_tpl.checklist, '[]'::jsonb))
             WITH ORDINALITY AS t(step, ord);
    IF v_new IS DISTINCT FROM v_tpl.checklist THEN
      UPDATE public.processing_templates SET checklist = v_new WHERE id = v_tpl.id;
    END IF;
  END LOOP;
END
$mig$;

-- Backfill subtask -> template-step links by the same case-insensitive label
-- rule apply_current_template has always used. Only fills NULLs; ambiguous
-- (duplicate-label) template steps link to the first occurrence.
WITH active_steps AS (
  SELECT t.program,
         step->>'id'                       AS step_id,
         lower(btrim(step->>'label'))      AS label_key,
         row_number() OVER (
           PARTITION BY t.program, lower(btrim(step->>'label'))
           ORDER BY ord
         ) AS dup_rank
    FROM public.processing_templates t,
         jsonb_array_elements(COALESCE(t.checklist, '[]'::jsonb))
           WITH ORDINALITY AS s(step, ord)
   WHERE t.is_active = true
     AND COALESCE(btrim(step->>'id'), '') <> ''
     AND COALESCE(btrim(step->>'label'), '') <> ''
)
UPDATE public.processing_subtasks st
   SET template_step_id = a.step_id
  FROM public.processing_records r, active_steps a
 WHERE st.record_id = r.id
   AND st.template_step_id IS NULL
   AND a.program = r.program
   AND a.dup_rank = 1
   AND lower(btrim(st.label)) = a.label_key;

-- ── 4. Broiler identity rekey: source_id name -> ppp-v4 batch.id ────────────
-- FAIL CLOSED for LIVE rows: an active broiler planner row whose current
-- source_id is neither an existing batch id (already rekeyed) nor exactly one
-- batch's name aborts the whole transaction. ARCHIVED rows are dormant
-- tombstones whose source batch may have been deleted or renamed long ago —
-- they rekey when uniquely resolvable (so a returning source restores the same
-- record) and are otherwise left as-is instead of blocking the migration on
-- unfixable history. The (source_kind, source_id) partial-unique index
-- additionally refuses two rows collapsing onto one batch id.
DO $mig$
DECLARE
  v_batches jsonb;
  v_rec     RECORD;
  v_by_id   int;
  v_by_name int;
  v_new_id  text;
BEGIN
  v_batches := COALESCE((SELECT data::jsonb FROM public.app_store WHERE key = 'ppp-v4'), '[]'::jsonb);

  FOR v_rec IN
    SELECT id, source_id, archived FROM public.processing_records
     WHERE source_kind = 'broiler' AND record_type = 'planner_batch'
       AND source_id IS NOT NULL
     ORDER BY id
  LOOP
    SELECT count(*) INTO v_by_id
      FROM jsonb_array_elements(v_batches) AS b
     WHERE COALESCE(btrim(b.value->>'id'), '') = v_rec.source_id;
    IF v_by_id = 1 THEN
      CONTINUE; -- already keyed by immutable batch id (idempotent re-run)
    END IF;

    SELECT count(*) INTO v_by_name
      FROM jsonb_array_elements(v_batches) AS b
     WHERE COALESCE(btrim(b.value->>'name'), '') = v_rec.source_id;
    IF v_by_name <> 1 THEN
      IF v_rec.archived THEN
        CONTINUE; -- dormant tombstone with no unique live source: leave as-is
      END IF;
      RAISE EXCEPTION 'PROCESSING_VALIDATION: broiler rekey failed closed — record % source_id % resolves to % batches by name (need exactly 1)',
        v_rec.id, v_rec.source_id, v_by_name;
    END IF;

    SELECT COALESCE(btrim(b.value->>'id'), '') INTO v_new_id
      FROM jsonb_array_elements(v_batches) AS b
     WHERE COALESCE(btrim(b.value->>'name'), '') = v_rec.source_id
     LIMIT 1;
    IF v_new_id = '' THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: broiler rekey failed closed — batch named % has no id in ppp-v4',
        v_rec.source_id;
    END IF;

    UPDATE public.processing_records
       SET source_id = v_new_id, updated_at = now()
     WHERE id = v_rec.id;
  END LOOP;
END
$mig$;

-- ── 5. Option lists: stable ids + add/rename/deactivate semantics ───────────
-- Convert legacy plain-string arrays to [{id,label,active}] objects in place.
-- Already-converted entries pass through untouched (idempotent).
DO $mig$
DECLARE
  v_row RECORD;
  v_processor jsonb;
  v_customer jsonb;
BEGIN
  SELECT processor_options, customer_options INTO v_row
    FROM public.processing_asana_sync_settings WHERE id = 'singleton';
  IF NOT FOUND THEN RETURN; END IF;

  SELECT COALESCE(jsonb_agg(
           CASE WHEN jsonb_typeof(elem) = 'string'
                THEN jsonb_build_object('id', 'opt-' || gen_random_uuid()::text,
                                        'label', elem #>> '{}', 'active', true)
                ELSE elem END ORDER BY ord), '[]'::jsonb)
    INTO v_processor
    FROM jsonb_array_elements(COALESCE(v_row.processor_options, '[]'::jsonb))
           WITH ORDINALITY AS t(elem, ord);

  SELECT COALESCE(jsonb_agg(
           CASE WHEN jsonb_typeof(elem) = 'string'
                THEN jsonb_build_object('id', 'opt-' || gen_random_uuid()::text,
                                        'label', elem #>> '{}', 'active', true)
                ELSE elem END ORDER BY ord), '[]'::jsonb)
    INTO v_customer
    FROM jsonb_array_elements(COALESCE(v_row.customer_options, '[]'::jsonb))
           WITH ORDINALITY AS t(elem, ord);

  UPDATE public.processing_asana_sync_settings
     SET processor_options = v_processor, customer_options = v_customer
   WHERE id = 'singleton'
     AND (processor_options IS DISTINCT FROM v_processor
       OR customer_options IS DISTINCT FROM v_customer);
END
$mig$;

-- Reissue (162): full-list replace becomes add/rename/deactivate. Incoming
-- entries are {id?,label,active?} objects (bare strings are accepted as new
-- options for compatibility). Every existing option id must be present in the
-- incoming list — options are deactivated, never deleted — and stored record
-- labels are never validated against or rewritten from these lists.
CREATE OR REPLACE FUNCTION public.set_processing_option_list(p_kind text, p_options jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_role     text;
  v_existing jsonb;
  v_clean    jsonb := '[]'::jsonb;
  v_elem     jsonb;
  v_id       text;
  v_label    text;
  v_active   boolean;
  v_seen_ids text[] := ARRAY[]::text[];
  v_seen_lbl text[] := ARRAY[]::text[];
  v_missing  text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'set_processing_option_list: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot edit option lists', COALESCE(v_role, 'null');
  END IF;
  IF p_kind NOT IN ('processor', 'customer') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid option kind %', COALESCE(p_kind, 'null');
  END IF;
  IF jsonb_typeof(COALESCE(p_options, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: options must be a json array';
  END IF;

  SELECT CASE WHEN p_kind = 'processor' THEN processor_options ELSE customer_options END
    INTO v_existing
    FROM public.processing_asana_sync_settings WHERE id = 'singleton';
  v_existing := COALESCE(v_existing, '[]'::jsonb);

  FOR v_elem IN SELECT value FROM jsonb_array_elements(COALESCE(p_options, '[]'::jsonb)) LOOP
    IF jsonb_typeof(v_elem) = 'string' THEN
      v_id := NULL;
      v_label := btrim(v_elem #>> '{}');
      v_active := true;
    ELSIF jsonb_typeof(v_elem) = 'object' THEN
      v_id := NULLIF(btrim(COALESCE(v_elem->>'id', '')), '');
      v_label := btrim(COALESCE(v_elem->>'label', ''));
      v_active := COALESCE((v_elem->>'active')::boolean, true);
    ELSE
      RAISE EXCEPTION 'PROCESSING_VALIDATION: option entries must be strings or objects';
    END IF;

    IF v_label = '' THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: option labels cannot be blank';
    END IF;
    IF v_id IS NOT NULL AND v_id = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: duplicate option id %', v_id;
    END IF;
    IF lower(v_label) = ANY(v_seen_lbl) THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: duplicate option label %', v_label;
    END IF;
    -- An incoming id must belong to this list (no cross-list/id invention).
    IF v_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_existing) e WHERE e.value->>'id' = v_id
    ) THEN
      RAISE EXCEPTION 'PROCESSING_VALIDATION: unknown option id %', v_id;
    END IF;

    IF v_id IS NULL THEN
      v_id := 'opt-' || gen_random_uuid()::text;
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_id);
    v_seen_lbl := array_append(v_seen_lbl, lower(v_label));
    v_clean := v_clean || jsonb_build_array(
      jsonb_build_object('id', v_id, 'label', v_label, 'active', v_active));
  END LOOP;

  -- Options can be deactivated but never deleted: every stored id must survive.
  SELECT e.value->>'id' INTO v_missing
    FROM jsonb_array_elements(v_existing) e
   WHERE e.value->>'id' IS NOT NULL
     AND NOT (e.value->>'id' = ANY(v_seen_ids))
   LIMIT 1;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: option % cannot be deleted — deactivate it instead', v_missing;
  END IF;

  IF p_kind = 'processor' THEN
    UPDATE public.processing_asana_sync_settings
       SET processor_options = v_clean, updated_by = auth.uid(), updated_at = now()
     WHERE id = 'singleton';
  ELSE
    UPDATE public.processing_asana_sync_settings
       SET customer_options = v_clean, updated_by = auth.uid(), updated_at = now()
     WHERE id = 'singleton';
  END IF;

  RETURN jsonb_build_object('ok', true, 'kind', p_kind, 'options', v_clean);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_option_list(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_option_list(text, jsonb) TO authenticated;

-- ── 6. Worked-record predicate (drives 176's empty-remove vs worked-archive) ─
-- "Worked" = any human workflow investment: processor/customer chosen, local
-- field values, completion, a done or manually-added subtask, a removed
-- template step, an attachment, or a live comment. Automatically seeded
-- template steps (source='native' WITH template_step_id) alone do not count.
CREATE OR REPLACE FUNCTION public._processing_record_worked(p_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_rec public.processing_records;
BEGIN
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF COALESCE(btrim(v_rec.processor), '') <> '' THEN RETURN true; END IF;
  IF jsonb_array_length(COALESCE(v_rec.customer, '[]'::jsonb)) > 0 THEN RETURN true; END IF;
  IF v_rec.completed_at IS NOT NULL THEN RETURN true; END IF;
  IF COALESCE(v_rec.fields, '{}'::jsonb) <> '{}'::jsonb THEN RETURN true; END IF;
  IF jsonb_array_length(COALESCE(v_rec.removed_template_steps, '[]'::jsonb)) > 0 THEN RETURN true; END IF;
  IF v_rec.workflow_touched_at IS NOT NULL THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.processing_subtasks s
              WHERE s.record_id = p_id AND s.done = true) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.processing_subtasks s
              WHERE s.record_id = p_id AND s.source = 'native'
                AND s.template_step_id IS NULL) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.processing_attachments a
              WHERE a.record_id = p_id) THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.comments c
              WHERE c.entity_type = 'processing.record' AND c.entity_id = p_id
                AND c.deleted_at IS NULL) THEN RETURN true; END IF;
  RETURN false;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_record_worked(text) FROM PUBLIC, anon, authenticated;

-- ── 7. Caller-scoped My Tasks read ───────────────────────────────────────────
-- The current user's open Processing subtasks, for the no-due-date "Processing
-- work" section in My Tasks. Link-only display data; NOT task_instances.
-- Non-operational roles get an empty array (My Tasks renders for everyone).
CREATE OR REPLACE FUNCTION public.list_my_processing_subtasks()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_role text; v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'list_my_processing_subtasks: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin') THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'subtask_id',      s.id,
           'label',           s.label,
           'sort_order',      s.sort_order,
           'record_id',       r.id,
           'record_title',    r.title,
           'program',         r.program,
           'processing_date', r.processing_date,
           'record_type',     r.record_type
         ) ORDER BY r.processing_date ASC NULLS LAST, r.title ASC, s.sort_order ASC), '[]'::jsonb)
    INTO v_out
    FROM public.processing_subtasks s
    JOIN public.processing_records r ON r.id = s.record_id
   WHERE s.assignee_profile_id = auth.uid()
     AND s.done = false
     AND r.archived = false
     AND r.record_type <> 'import_exception';
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_my_processing_subtasks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_processing_subtasks() TO authenticated;

NOTIFY pgrst, 'reload schema';
