-- ============================================================================
-- 155_processing_calendar.sql
-- ----------------------------------------------------------------------------
-- Native WCF Processing Calendar domain + one-way Asana mirror foundation.
--
-- Standalone Processing domain (its own tables + SECDEF RPCs). Does NOT mutate
-- cattle/sheep/pig/broiler source tables; planner rows carry a read-only
-- (source_kind, source_id) link resolved app-side. Asana remains the temporary
-- source of truth until cutover: processing_asana_sync_settings.asana_sync_enabled
-- is the explicit source-mode flag. While enabled, imported/planner source-owned
-- fields are read-only and the importer (service_role) is the only writer of
-- imported provenance.
--
-- 1. Tables (deny-all RLS; service_role reaches them via BYPASSRLS):
--    processing_records, processing_subtasks, processing_attachments,
--    processing_templates, processing_import_exceptions,
--    processing_asana_sync_runs, processing_asana_sync_settings (singleton).
-- 2. Completion-gate helper _processing_completion_blockers(text) -> text[].
-- 3. Read RPCs (farm_team/management/admin; light denied):
--    list_processing_records, get_processing_record, get_processing_settings,
--    list_processing_templates.
-- 4. Operational write RPCs (farm_team/management/admin):
--    milestone CRUD, set_processing_processor/customer, mark_processing_complete
--    (enforces the completion gate), reopen_processing_record, subtask CRUD,
--    apply_current_template.
-- 5. Admin-only RPCs: upsert_processing_template, hard_delete_processing_record,
--    set_asana_sync_enabled.
-- 6. Importer RPCs (service_role): upsert_processing_from_asana,
--    upsert_processing_subtask_from_asana, record_processing_attachment,
--    record_processing_import_exception, start/finish_processing_sync_run.
-- 7. Activity: re-issue _activity_can_read (mig 154 body + processing.record
--    branch). Writes delegate through the existing _activity_can_write, so the
--    shared comments layer works for entity_type='processing.record' as-is.
--
-- Error classes: deterministic failures use the 'PROCESSING_VALIDATION:' prefix.
-- The bare 'authenticated caller required' message stays UNprefixed (mig 112
-- convention) so an expired offline session classifies transient.
--
-- NO BEGIN/COMMIT in this file: TEST applies via exec_sql (rejects them);
-- PROD applies with psql --single-transaction for atomicity.
-- Apply order: TEST first, PROD after lane approval.
-- Depends on: 058 (profile_role/profile_program_access), 037 (is_admin),
-- 087 (light role), 154 (latest _activity_can_read body).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── 1. processing_records ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_records (
  id                  text PRIMARY KEY,
  record_type         text NOT NULL
                        CHECK (record_type IN ('planner_batch','asana_historical','milestone','import_exception')),
  program             text NOT NULL
                        CHECK (program IN ('broiler','cattle','pig','sheep')),
  title               text NOT NULL,
  processing_date     date,
  status              text NOT NULL DEFAULT 'planned',
  completed_at        timestamptz,
  processor           text,
  number_processed    integer,
  customer            jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_kind         text CHECK (source_kind IS NULL OR source_kind IN ('broiler','cattle','pig','sheep')),
  source_id           text,
  archived            boolean NOT NULL DEFAULT false,
  -- provenance (internal; never shown in the normal drawer)
  asana_gid           text UNIQUE,
  asana_project_gid   text,
  asana_section_gid   text,
  asana_section_name  text,
  match_status        text NOT NULL DEFAULT 'native'
                        CHECK (match_status IN ('native','matched','review','unmatched')),
  match_confidence    text,
  match_evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  historical_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_asana_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  template_version    integer,
  fields              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at      timestamptz,
  sync_run_id         text,
  created_by          uuid NOT NULL REFERENCES public.profiles(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processing_records_program_date_idx
  ON public.processing_records (program, processing_date)
  WHERE archived = false;
CREATE INDEX IF NOT EXISTS processing_records_year_idx
  ON public.processing_records (date_part('year', processing_date))
  WHERE processing_date IS NOT NULL AND archived = false;
CREATE INDEX IF NOT EXISTS processing_records_source_idx
  ON public.processing_records (source_kind, source_id)
  WHERE source_kind IS NOT NULL;

REVOKE ALL ON TABLE public.processing_records FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_records_deny_all ON public.processing_records;
CREATE POLICY processing_records_deny_all ON public.processing_records FOR ALL USING (false);

-- ── 2. processing_subtasks ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_subtasks (
  id            text PRIMARY KEY,
  record_id     text NOT NULL REFERENCES public.processing_records(id) ON DELETE CASCADE,
  label         text NOT NULL,
  assignee      text,
  done          boolean NOT NULL DEFAULT false,
  completed_at  timestamptz,
  asana_gid     text UNIQUE,
  due_on        date,
  start_on      date,
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES public.profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_subtasks_record_idx
  ON public.processing_subtasks (record_id, sort_order);

REVOKE ALL ON TABLE public.processing_subtasks FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_subtasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_subtasks_deny_all ON public.processing_subtasks;
CREATE POLICY processing_subtasks_deny_all ON public.processing_subtasks FOR ALL USING (false);

-- ── 3. processing_attachments ───────────────────────────────────────────────
-- Record-level attachments. Asana attachment BYTES are copied into the private
-- 'processing-attachments' Storage bucket (created in a separate storage
-- migration, gated); we persist only the storage_path + provenance here.
CREATE TABLE IF NOT EXISTS public.processing_attachments (
  id                   text PRIMARY KEY,
  record_id            text NOT NULL REFERENCES public.processing_records(id) ON DELETE CASCADE,
  filename             text NOT NULL,
  content_type         text,
  size_bytes           bigint,
  storage_path         text NOT NULL,
  asana_attachment_gid text UNIQUE,
  source_url           text,
  original_created_at  timestamptz,
  created_by           uuid REFERENCES public.profiles(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_attachments_record_idx
  ON public.processing_attachments (record_id, created_at DESC);

REVOKE ALL ON TABLE public.processing_attachments FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_attachments_deny_all ON public.processing_attachments;
CREATE POLICY processing_attachments_deny_all ON public.processing_attachments FOR ALL USING (false);

-- ── 4. processing_templates (versioned per program) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_templates (
  id          text PRIMARY KEY,
  program     text NOT NULL CHECK (program IN ('broiler','cattle','pig','sheep')),
  version     integer NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  checklist   jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES public.profiles(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS processing_templates_active_idx
  ON public.processing_templates (program)
  WHERE is_active = true;

REVOKE ALL ON TABLE public.processing_templates FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_templates_deny_all ON public.processing_templates;
CREATE POLICY processing_templates_deny_all ON public.processing_templates FOR ALL USING (false);

-- ── 5. processing_import_exceptions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_import_exceptions (
  id          text PRIMARY KEY,
  asana_gid   text,
  program     text,
  title       text,
  reason      text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved    boolean NOT NULL DEFAULT false,
  sync_run_id text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_import_exceptions_open_idx
  ON public.processing_import_exceptions (created_at DESC)
  WHERE resolved = false;

REVOKE ALL ON TABLE public.processing_import_exceptions FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_import_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_import_exceptions_deny_all ON public.processing_import_exceptions;
CREATE POLICY processing_import_exceptions_deny_all ON public.processing_import_exceptions FOR ALL USING (false);

-- ── 6. processing_asana_sync_runs ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_asana_sync_runs (
  id          text PRIMARY KEY,
  action      text NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error')),
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  actor       uuid REFERENCES public.profiles(id)
);
CREATE INDEX IF NOT EXISTS processing_asana_sync_runs_recent_idx
  ON public.processing_asana_sync_runs (started_at DESC);

REVOKE ALL ON TABLE public.processing_asana_sync_runs FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_asana_sync_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_asana_sync_runs_deny_all ON public.processing_asana_sync_runs;
CREATE POLICY processing_asana_sync_runs_deny_all ON public.processing_asana_sync_runs FOR ALL USING (false);

-- ── 7. processing_asana_sync_settings (singleton) ───────────────────────────
CREATE TABLE IF NOT EXISTS public.processing_asana_sync_settings (
  id                    text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  asana_sync_enabled    boolean NOT NULL DEFAULT true,
  processor_options     jsonb NOT NULL DEFAULT '["Atlanta Poultry Processing"]'::jsonb,
  last_sync_at          timestamptz,
  last_sync_run_id      text,
  modified_since_cursor timestamptz,
  updated_by            uuid REFERENCES public.profiles(id),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.processing_asana_sync_settings (id) VALUES ('singleton')
  ON CONFLICT (id) DO NOTHING;

REVOKE ALL ON TABLE public.processing_asana_sync_settings FROM PUBLIC, anon, authenticated;
ALTER TABLE public.processing_asana_sync_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS processing_asana_sync_settings_deny_all ON public.processing_asana_sync_settings;
CREATE POLICY processing_asana_sync_settings_deny_all ON public.processing_asana_sync_settings FOR ALL USING (false);

-- ── 8. Shared internal guards ───────────────────────────────────────────────
-- Operational role gate: farm_team/management/admin allowed; light,
-- equipment_tech, inactive denied by omission. Returns the role or RAISEs.
CREATE OR REPLACE FUNCTION public._processing_require_operational()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'processing: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team','management','admin') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot use processing', COALESCE(v_role,'null');
  END IF;
  RETURN v_role;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_require_operational() FROM PUBLIC, anon, authenticated;

-- Completion-gate: returns the list of unmet requirements for marking Complete.
-- Empty array => the record MAY be completed.
CREATE OR REPLACE FUNCTION public._processing_completion_blockers(p_id text)
RETURNS text[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE
  v_rec       public.processing_records;
  v_blockers  text[] := ARRAY[]::text[];
  v_open_subs int;
BEGIN
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN ARRAY['record not found'];
  END IF;
  -- Milestones are planning placeholders and are not gated the same way; only a
  -- processing date is required to complete a milestone.
  IF v_rec.record_type = 'milestone' THEN
    IF v_rec.processing_date IS NULL THEN
      v_blockers := array_append(v_blockers, 'Processing Date is required');
    END IF;
    RETURN v_blockers;
  END IF;
  IF v_rec.processor IS NULL OR btrim(v_rec.processor) = '' THEN
    v_blockers := array_append(v_blockers, 'Processor is required');
  END IF;
  IF v_rec.processing_date IS NULL THEN
    v_blockers := array_append(v_blockers, 'Processing Date is required');
  END IF;
  -- Source-owned Number Processed must exist where the program supports it and
  -- the row is source-linked (planner_batch). Historical rows carry an imported
  -- snapshot number; if absent they are still blocked so bad data can't complete.
  IF v_rec.number_processed IS NULL AND v_rec.source_id IS NOT NULL THEN
    v_blockers := array_append(v_blockers, 'Number Processed (from the source batch) is required');
  END IF;
  SELECT count(*) INTO v_open_subs
    FROM public.processing_subtasks WHERE record_id = p_id AND done = false;
  IF v_open_subs > 0 THEN
    v_blockers := array_append(v_blockers, v_open_subs || ' subtask(s) still open');
  END IF;
  RETURN v_blockers;
END
$fn$;
REVOKE ALL ON FUNCTION public._processing_completion_blockers(text) FROM PUBLIC, anon, authenticated;

-- ── 9. Read RPCs ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_processing_records(
  p_year             int  DEFAULT NULL,
  p_program          text DEFAULT NULL,
  p_include_archived boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_out jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT COALESCE(jsonb_agg(row ORDER BY row->>'program', (row->>'processing_date')), '[]'::jsonb)
    INTO v_out
  FROM (
    SELECT jsonb_build_object(
      'id', r.id, 'record_type', r.record_type, 'program', r.program, 'title', r.title,
      'processing_date', r.processing_date, 'status', r.status, 'completed_at', r.completed_at,
      'processor', r.processor, 'number_processed', r.number_processed, 'customer', r.customer,
      'source_kind', r.source_kind, 'source_id', r.source_id, 'archived', r.archived,
      'fields', r.fields, 'historical_snapshot', r.historical_snapshot,
      'subtask_total', COALESCE(st.total, 0), 'subtask_done', COALESCE(st.done, 0)
    ) AS row
    FROM public.processing_records r
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE s.done) AS done
      FROM public.processing_subtasks s WHERE s.record_id = r.id
    ) st ON true
    WHERE (p_include_archived OR r.archived = false)
      AND r.record_type <> 'import_exception'
      AND (p_program IS NULL OR r.program = p_program)
      AND (p_year IS NULL OR date_part('year', r.processing_date) = p_year)
  ) q;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_processing_records(int, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_processing_records(int, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_rec jsonb; v_subs jsonb; v_atts jsonb; v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  SELECT to_jsonb(r) INTO v_rec FROM public.processing_records r WHERE r.id = p_id;
  IF v_rec IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.sort_order, s.created_at), '[]'::jsonb)
    INTO v_subs FROM public.processing_subtasks s WHERE s.record_id = p_id;
  SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC), '[]'::jsonb)
    INTO v_atts FROM public.processing_attachments a WHERE a.record_id = p_id;
  v_blockers := public._processing_completion_blockers(p_id);
  -- Nested shape: {record, subtasks, attachments, completion_blockers}. The
  -- drawer reads data.record; keeping the record under its own key avoids any
  -- collision with the sibling arrays and matches the client contract.
  RETURN jsonb_build_object('record', v_rec, 'subtasks', v_subs, 'attachments', v_atts,
                            'completion_blockers', to_jsonb(v_blockers));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_processing_record(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_processing_settings()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_out jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT to_jsonb(s) INTO v_out FROM public.processing_asana_sync_settings s WHERE s.id = 'singleton';
  RETURN COALESCE(v_out, '{}'::jsonb);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_processing_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_processing_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.list_processing_templates(p_program text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE
AS $fn$
DECLARE v_out jsonb;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.program, t.version DESC), '[]'::jsonb)
    INTO v_out FROM public.processing_templates t
   WHERE (p_program IS NULL OR t.program = p_program) AND t.is_active = true;
  RETURN v_out;
END
$fn$;
REVOKE ALL ON FUNCTION public.list_processing_templates(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_processing_templates(text) TO authenticated;

-- ── 10. Milestone CRUD (Processing-owned) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_processing_milestone(
  p_id              text,
  p_program         text,
  p_title           text,
  p_processing_date date DEFAULT NULL,
  p_processor       text DEFAULT NULL,
  p_customer        jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid();
BEGIN
  PERFORM public._processing_require_operational();
  IF EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RETURN jsonb_build_object('id', p_id, 'replayed', true);
  END IF;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid milestone id';
  END IF;
  IF p_program NOT IN ('broiler','cattle','pig','sheep') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid program %', COALESCE(p_program,'null');
  END IF;
  IF p_title IS NULL OR length(btrim(p_title)) < 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestone title is required';
  END IF;
  INSERT INTO public.processing_records
    (id, record_type, program, title, processing_date, status, processor, customer,
     match_status, created_by)
  VALUES
    (p_id, 'milestone', p_program, btrim(p_title), p_processing_date, 'planned', p_processor,
     COALESCE(p_customer, '[]'::jsonb), 'native', v_caller);
  RETURN jsonb_build_object('id', p_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.create_processing_milestone(text, text, text, date, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_processing_milestone(text, text, text, date, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_processing_milestone(
  p_id              text,
  p_title           text DEFAULT NULL,
  p_processing_date date DEFAULT NULL,
  p_status          text DEFAULT NULL,
  p_processor       text DEFAULT NULL,
  p_customer        jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_rec public.processing_records;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type <> 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: only milestones are editable this way';
  END IF;
  UPDATE public.processing_records SET
    title           = COALESCE(NULLIF(btrim(p_title), ''), title),
    processing_date = COALESCE(p_processing_date, processing_date),
    status          = COALESCE(p_status, status),
    processor       = COALESCE(p_processor, processor),
    customer        = COALESCE(p_customer, customer),
    updated_at      = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_processing_milestone(text, text, date, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_processing_milestone(text, text, date, text, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_processing_milestone(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_rec public.processing_records;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('id', p_id, 'ok', true, 'already_gone', true); END IF;
  IF v_rec.record_type <> 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: only milestones can be deleted from Processing';
  END IF;
  DELETE FROM public.processing_records WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_processing_milestone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_processing_milestone(text) TO authenticated;

-- ── 11. Processing-owned field edits (processor, customer) ──────────────────
-- These are the only fields editable on planner_batch / asana_historical rows.
-- Source-owned facts (title/date/number_processed/status) stay read-only here.
CREATE OR REPLACE FUNCTION public.set_processing_processor(p_id text, p_processor text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  UPDATE public.processing_records
     SET processor = NULLIF(btrim(p_processor), ''), updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_processor(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_processor(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_processing_customer(p_id text, p_customer jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_rec public.processing_records;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.program <> 'broiler' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: Customer is a Broiler-only field';
  END IF;
  IF jsonb_typeof(COALESCE(p_customer, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: customer must be a json array';
  END IF;
  UPDATE public.processing_records
     SET customer = COALESCE(p_customer, '[]'::jsonb), updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_customer(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_customer(text, jsonb) TO authenticated;

-- ── 12. Completion (manual, gated) + reopen ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_processing_complete(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_blockers text[];
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  v_blockers := public._processing_completion_blockers(p_id);
  IF array_length(v_blockers, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: cannot complete — %', array_to_string(v_blockers, '; ');
  END IF;
  UPDATE public.processing_records
     SET status = 'complete', completed_at = now(), updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'complete');
END
$fn$;
REVOKE ALL ON FUNCTION public.mark_processing_complete(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_processing_complete(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reopen_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found';
  END IF;
  UPDATE public.processing_records
     SET status = 'planned', completed_at = NULL, updated_at = now()
   WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'status', 'planned');
END
$fn$;
REVOKE ALL ON FUNCTION public.reopen_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reopen_processing_record(text) TO authenticated;

-- ── 13. Subtask CRUD ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.add_processing_subtask(
  p_id        text,
  p_record_id text,
  p_label     text,
  p_assignee  text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_next int;
BEGIN
  PERFORM public._processing_require_operational();
  IF EXISTS (SELECT 1 FROM public.processing_subtasks WHERE id = p_id) THEN
    RETURN jsonb_build_object('id', p_id, 'replayed', true);
  END IF;
  IF p_id IS NULL OR p_id !~ '^[A-Za-z0-9-]+$' OR length(p_id) > 100 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid subtask id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_record_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not found';
  END IF;
  IF p_label IS NULL OR length(btrim(p_label)) < 1 THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask label is required';
  END IF;
  SELECT COALESCE(max(sort_order), 0) + 1 INTO v_next
    FROM public.processing_subtasks WHERE record_id = p_record_id;
  INSERT INTO public.processing_subtasks (id, record_id, label, assignee, sort_order, created_by)
  VALUES (p_id, p_record_id, btrim(p_label), p_assignee, v_next, v_caller);
  RETURN jsonb_build_object('id', p_id, 'replayed', false);
END
$fn$;
REVOKE ALL ON FUNCTION public.add_processing_subtask(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_processing_subtask(text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_processing_subtask(
  p_id       text,
  p_label    text DEFAULT NULL,
  p_assignee text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_subtasks WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask not found';
  END IF;
  UPDATE public.processing_subtasks SET
    label    = COALESCE(NULLIF(btrim(p_label), ''), label),
    assignee = COALESCE(p_assignee, assignee),
    updated_at = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.update_processing_subtask(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_processing_subtask(text, text, text) TO authenticated;

-- Toggling a subtask NEVER auto-completes the parent (PROJECT.md override).
CREATE OR REPLACE FUNCTION public.set_processing_subtask_done(p_id text, p_done boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  IF NOT EXISTS (SELECT 1 FROM public.processing_subtasks WHERE id = p_id) THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask not found';
  END IF;
  UPDATE public.processing_subtasks SET
    done = COALESCE(p_done, false),
    completed_at = CASE WHEN COALESCE(p_done, false) THEN now() ELSE NULL END,
    updated_at = now()
  WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true, 'done', COALESCE(p_done, false));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_processing_subtask_done(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_processing_subtask_done(text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_processing_subtask(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  PERFORM public._processing_require_operational();
  DELETE FROM public.processing_subtasks WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.delete_processing_subtask(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_processing_subtask(text) TO authenticated;

-- ── 14. Apply current template (additive; never destructive) ────────────────
CREATE OR REPLACE FUNCTION public.apply_current_template(p_record_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_rec    public.processing_records;
  v_tpl    public.processing_templates;
  v_step   jsonb;
  v_added  int := 0;
  v_next   int;
  v_label  text;
BEGIN
  PERFORM public._processing_require_operational();
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROCESSING_VALIDATION: record not found'; END IF;
  IF v_rec.record_type = 'milestone' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: milestones do not take templates';
  END IF;
  SELECT * INTO v_tpl FROM public.processing_templates
   WHERE program = v_rec.program AND is_active = true;
  IF NOT FOUND THEN RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'added', 0); END IF;
  -- Add only checklist steps whose label is not already present (additive; keeps
  -- imported/custom/completed subtasks untouched; never auto-completes the record).
  SELECT COALESCE(max(sort_order), 0) INTO v_next
    FROM public.processing_subtasks WHERE record_id = p_record_id;
  FOR v_step IN SELECT * FROM jsonb_array_elements(v_tpl.checklist)
  LOOP
    v_label := btrim(COALESCE(v_step->>'label', ''));
    CONTINUE WHEN v_label = '';
    IF EXISTS (SELECT 1 FROM public.processing_subtasks
                WHERE record_id = p_record_id AND lower(label) = lower(v_label)) THEN
      CONTINUE;
    END IF;
    v_next := v_next + 1;
    INSERT INTO public.processing_subtasks (id, record_id, label, assignee, sort_order, created_by)
    VALUES ('pst-' || gen_random_uuid()::text, p_record_id, v_label, v_step->>'assignee', v_next, v_caller);
    v_added := v_added + 1;
  END LOOP;
  UPDATE public.processing_records SET template_version = v_tpl.version, updated_at = now()
   WHERE id = p_record_id;
  RETURN jsonb_build_object('id', p_record_id, 'ok', true, 'added', v_added);
END
$fn$;
REVOKE ALL ON FUNCTION public.apply_current_template(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_current_template(text) TO authenticated;

-- ── 15. Admin-only: templates, hard delete, cutover flag ────────────────────
CREATE OR REPLACE FUNCTION public.upsert_processing_template(
  p_program   text,
  p_fields    jsonb,
  p_checklist jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_caller uuid := auth.uid(); v_role text; v_next int; v_id text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'upsert_processing_template: authenticated caller required'; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot edit templates', COALESCE(v_role,'null');
  END IF;
  IF p_program NOT IN ('broiler','cattle','pig','sheep') THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: invalid program %', COALESCE(p_program,'null');
  END IF;
  IF jsonb_typeof(COALESCE(p_fields, '[]'::jsonb)) <> 'array'
     OR jsonb_typeof(COALESCE(p_checklist, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: fields and checklist must be json arrays';
  END IF;
  -- New version supersedes the prior active one (existing records keep their
  -- snapshot; templates apply to future records + explicit Apply only).
  SELECT COALESCE(max(version), 0) + 1 INTO v_next FROM public.processing_templates WHERE program = p_program;
  UPDATE public.processing_templates SET is_active = false WHERE program = p_program AND is_active = true;
  v_id := 'ptpl-' || gen_random_uuid()::text;
  INSERT INTO public.processing_templates (id, program, version, fields, checklist, is_active, created_by)
  VALUES (v_id, p_program, v_next, COALESCE(p_fields, '[]'::jsonb), COALESCE(p_checklist, '[]'::jsonb), true, v_caller);
  RETURN jsonb_build_object('id', v_id, 'program', p_program, 'version', v_next);
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_template(text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_processing_template(text, jsonb, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.hard_delete_processing_record(p_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_role text; v_rec public.processing_records;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'hard_delete_processing_record: authenticated caller required'; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot hard-delete', COALESCE(v_role,'null');
  END IF;
  SELECT * INTO v_rec FROM public.processing_records WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('id', p_id, 'ok', true, 'already_gone', true); END IF;
  IF v_rec.record_type = 'planner_batch' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: planner-owned records cannot be deleted';
  END IF;
  DELETE FROM public.processing_records WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.hard_delete_processing_record(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hard_delete_processing_record(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_asana_sync_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'set_asana_sync_enabled: authenticated caller required'; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role <> 'admin' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: caller role % cannot change sync mode', COALESCE(v_role,'null');
  END IF;
  UPDATE public.processing_asana_sync_settings
     SET asana_sync_enabled = COALESCE(p_enabled, false), updated_by = auth.uid(), updated_at = now()
   WHERE id = 'singleton';
  RETURN jsonb_build_object('ok', true, 'asana_sync_enabled', COALESCE(p_enabled, false));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_asana_sync_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_asana_sync_enabled(boolean) TO authenticated;

-- ── 16. Importer RPCs (service_role; called by the edge function) ───────────
-- Idempotent upsert keyed on asana_gid. Re-running never duplicates. Never
-- writes cattle/sheep/pig/broiler source tables. created_by falls back to a
-- resolvable admin when the importer has no auth.uid() (service_role context).
CREATE OR REPLACE FUNCTION public._processing_import_actor()
RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT COALESCE(auth.uid(), (SELECT id FROM public.profiles WHERE role = 'admin' ORDER BY created_at LIMIT 1))
$$;
REVOKE ALL ON FUNCTION public._processing_import_actor() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.upsert_processing_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid   text := p_row->>'asana_gid';
  v_id    text;
  v_exists boolean;
  v_action text;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: asana_gid required for import';
  END IF;
  SELECT id INTO v_id FROM public.processing_records WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF NOT v_exists THEN
    v_id := COALESCE(p_row->>'id', 'prc-' || gen_random_uuid()::text);
  END IF;

  IF v_exists THEN
    UPDATE public.processing_records SET
      record_type        = COALESCE(p_row->>'record_type', record_type),
      program            = COALESCE(p_row->>'program', program),
      title              = COALESCE(p_row->>'title', title),
      processing_date    = COALESCE((p_row->>'processing_date')::date, processing_date),
      status             = COALESCE(p_row->>'status', status),
      processor          = COALESCE(p_row->>'processor', processor),
      number_processed   = COALESCE((p_row->>'number_processed')::int, number_processed),
      customer           = COALESCE(p_row->'customer', customer),
      source_kind        = COALESCE(p_row->>'source_kind', source_kind),
      source_id          = COALESCE(p_row->>'source_id', source_id),
      asana_project_gid  = COALESCE(p_row->>'asana_project_gid', asana_project_gid),
      asana_section_gid  = COALESCE(p_row->>'asana_section_gid', asana_section_gid),
      asana_section_name = COALESCE(p_row->>'asana_section_name', asana_section_name),
      match_status       = COALESCE(p_row->>'match_status', match_status),
      match_confidence   = COALESCE(p_row->>'match_confidence', match_confidence),
      match_evidence     = COALESCE(p_row->'match_evidence', match_evidence),
      historical_snapshot= COALESCE(p_row->'historical_snapshot', historical_snapshot),
      raw_asana_snapshot = COALESCE(p_row->'raw_asana_snapshot', raw_asana_snapshot),
      last_synced_at     = now(),
      sync_run_id        = COALESCE(p_row->>'sync_run_id', sync_run_id),
      updated_at         = now()
    WHERE id = v_id;
    v_action := 'updated';
  ELSE
    INSERT INTO public.processing_records (
      id, record_type, program, title, processing_date, status, processor, number_processed,
      customer, source_kind, source_id, asana_gid, asana_project_gid, asana_section_gid,
      asana_section_name, match_status, match_confidence, match_evidence, historical_snapshot,
      raw_asana_snapshot, last_synced_at, sync_run_id, created_by
    ) VALUES (
      v_id,
      COALESCE(p_row->>'record_type', 'asana_historical'),
      COALESCE(p_row->>'program', 'broiler'),
      COALESCE(p_row->>'title', '(untitled)'),
      (p_row->>'processing_date')::date,
      COALESCE(p_row->>'status', 'planned'),
      p_row->>'processor',
      (p_row->>'number_processed')::int,
      COALESCE(p_row->'customer', '[]'::jsonb),
      p_row->>'source_kind',
      p_row->>'source_id',
      v_gid,
      p_row->>'asana_project_gid',
      p_row->>'asana_section_gid',
      p_row->>'asana_section_name',
      COALESCE(p_row->>'match_status', 'unmatched'),
      p_row->>'match_confidence',
      COALESCE(p_row->'match_evidence', '{}'::jsonb),
      COALESCE(p_row->'historical_snapshot', '{}'::jsonb),
      COALESCE(p_row->'raw_asana_snapshot', '{}'::jsonb),
      now(),
      p_row->>'sync_run_id',
      public._processing_import_actor()
    );
    v_action := 'inserted';
  END IF;
  RETURN jsonb_build_object('id', v_id, 'action', v_action, 'asana_gid', v_gid);
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_from_asana(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_processing_subtask_from_asana(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_gid    text := p_row->>'asana_gid';
  v_rec_id text;
  v_id     text;
  v_exists boolean;
BEGIN
  IF v_gid IS NULL OR btrim(v_gid) = '' THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: subtask asana_gid required';
  END IF;
  -- Resolve the parent processing record by the parent Asana task gid.
  SELECT id INTO v_rec_id FROM public.processing_records WHERE asana_gid = p_row->>'parent_asana_gid';
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not found for subtask';
  END IF;
  SELECT id INTO v_id FROM public.processing_subtasks WHERE asana_gid = v_gid;
  v_exists := FOUND;
  IF v_exists THEN
    UPDATE public.processing_subtasks SET
      record_id    = v_rec_id,
      label        = COALESCE(p_row->>'label', label),
      assignee     = COALESCE(p_row->>'assignee', assignee),
      done         = COALESCE((p_row->>'done')::boolean, done),
      completed_at = COALESCE((p_row->>'completed_at')::timestamptz, completed_at),
      due_on       = COALESCE((p_row->>'due_on')::date, due_on),
      start_on     = COALESCE((p_row->>'start_on')::date, start_on),
      sort_order   = COALESCE((p_row->>'sort_order')::int, sort_order),
      updated_at   = now()
    WHERE id = v_id;
    RETURN jsonb_build_object('id', v_id, 'action', 'updated');
  END IF;
  v_id := COALESCE(p_row->>'id', 'pst-' || gen_random_uuid()::text);
  INSERT INTO public.processing_subtasks
    (id, record_id, label, assignee, done, completed_at, asana_gid, due_on, start_on, sort_order, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'label', '(untitled)'), p_row->>'assignee',
    COALESCE((p_row->>'done')::boolean, false), (p_row->>'completed_at')::timestamptz, v_gid,
    (p_row->>'due_on')::date, (p_row->>'start_on')::date,
    COALESCE((p_row->>'sort_order')::int, 0), public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_processing_subtask_from_asana(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_processing_attachment(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_gid text := p_row->>'asana_attachment_gid'; v_rec_id text; v_id text;
BEGIN
  SELECT id INTO v_rec_id FROM public.processing_records WHERE asana_gid = p_row->>'parent_asana_gid';
  IF v_rec_id IS NULL THEN
    RAISE EXCEPTION 'PROCESSING_VALIDATION: parent record not found for attachment';
  END IF;
  IF v_gid IS NOT NULL AND EXISTS (SELECT 1 FROM public.processing_attachments WHERE asana_attachment_gid = v_gid) THEN
    RETURN jsonb_build_object('action', 'skipped', 'reason', 'already imported');
  END IF;
  v_id := COALESCE(p_row->>'id', 'pat-' || gen_random_uuid()::text);
  INSERT INTO public.processing_attachments
    (id, record_id, filename, content_type, size_bytes, storage_path, asana_attachment_gid,
     source_url, original_created_at, created_by)
  VALUES (
    v_id, v_rec_id, COALESCE(p_row->>'filename', 'attachment'), p_row->>'content_type',
    (p_row->>'size_bytes')::bigint, p_row->>'storage_path', v_gid, p_row->>'source_url',
    (p_row->>'original_created_at')::timestamptz, public._processing_import_actor()
  );
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_attachment(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_attachment(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_processing_import_exception(p_row jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_id text := COALESCE(p_row->>'id', 'pie-' || gen_random_uuid()::text);
BEGIN
  INSERT INTO public.processing_import_exceptions (id, asana_gid, program, title, reason, evidence, sync_run_id)
  VALUES (v_id, p_row->>'asana_gid', p_row->>'program', p_row->>'title',
          COALESCE(p_row->>'reason', 'unspecified'), COALESCE(p_row->'evidence', '{}'::jsonb),
          p_row->>'sync_run_id');
  RETURN jsonb_build_object('id', v_id, 'action', 'inserted');
END
$fn$;
REVOKE ALL ON FUNCTION public.record_processing_import_exception(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_processing_import_exception(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.start_processing_sync_run(p_action text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE v_id text := 'psr-' || gen_random_uuid()::text;
BEGIN
  INSERT INTO public.processing_asana_sync_runs (id, action, status, actor)
  VALUES (v_id, COALESCE(p_action, 'unknown'), 'running', auth.uid());
  RETURN jsonb_build_object('id', v_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.start_processing_sync_run(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_processing_sync_run(text) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_processing_sync_run(
  p_run_id text, p_status text, p_counts jsonb DEFAULT '{}'::jsonb, p_error text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  UPDATE public.processing_asana_sync_runs
     SET status = COALESCE(p_status, 'ok'), counts = COALESCE(p_counts, '{}'::jsonb),
         error = p_error, finished_at = now()
   WHERE id = p_run_id;
  UPDATE public.processing_asana_sync_settings
     SET last_sync_at = now(), last_sync_run_id = p_run_id, updated_at = now()
   WHERE id = 'singleton';
  RETURN jsonb_build_object('id', p_run_id, 'ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.finish_processing_sync_run(text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_processing_sync_run(text, text, jsonb, text) TO service_role;

-- ── 17. Activity resolver: re-issue _activity_can_read + processing.record ──
-- Full re-emit of the mig 154 body (all 25 branches preserved) plus the new
-- processing.record branch: existence-gated on processing_records, operational
-- roles only (light/equipment_tech/inactive denied). Writes delegate through
-- the existing _activity_can_write (not re-issued) so the shared comments layer
-- accepts entity_type='processing.record'.
CREATE OR REPLACE FUNCTION public._activity_can_read(
  p_entity_type text,
  p_entity_id   text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $can_read$
DECLARE
  v_role    text;
  v_access  text[];
  v_species text;
BEGIN
  IF p_entity_type IS NULL OR length(trim(p_entity_type)) = 0 THEN
    RETURN false;
  END IF;
  IF p_entity_id IS NULL OR length(trim(p_entity_id)) = 0 THEN
    RETURN false;
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL THEN
    RETURN false;
  END IF;
  IF v_role = 'inactive' THEN
    RETURN false;
  END IF;

  IF p_entity_type = 'task.instance' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_instances WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.template' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_templates WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'task.system_rule' THEN
    IF NOT EXISTS (SELECT 1 FROM public.task_system_rules WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN true;
  END IF;

  IF p_entity_type = 'broiler.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-v4'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('name', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.batch' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-feeders-v1'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('id', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.breeder' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.app_store
      WHERE key = 'ppp-breeders-v1'
        AND data::jsonb @> jsonb_build_array(jsonb_build_object('id', p_entity_id))
    ) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.batch' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.housing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_housings WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_processing_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.forecast' THEN
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.breeding' THEN
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.animal' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.processing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_processing_batches WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'equipment.item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.equipment WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'equipment' = ANY(v_access);
  END IF;

  IF p_entity_type = 'equipment.fuel_bill' THEN
    RETURN v_role = 'admin';
  END IF;

  -- Processing Calendar records: existence-gated, operational roles only.
  -- Cross-program surface (not program_access gated); light/equipment_tech/
  -- inactive are denied to match the /processing page role gate.
  IF p_entity_type = 'processing.record' THEN
    IF NOT EXISTS (SELECT 1 FROM public.processing_records WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN v_role IN ('farm_team','management','admin');
  END IF;

  IF p_entity_type = 'poultry.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.poultry_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'broiler' = ANY(v_access);
  END IF;

  IF p_entity_type = 'layer.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.layer_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'egg.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.egg_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'layer' = ANY(v_access);
  END IF;

  IF p_entity_type = 'pig.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.pig_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'pig' = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.cattle_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'cattle' = ANY(v_access);
  END IF;

  IF p_entity_type = 'sheep.daily' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sheep_dailys WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN 'sheep' = ANY(v_access);
  END IF;

  IF p_entity_type = 'weighin.session' THEN
    SELECT species INTO v_species
    FROM public.weigh_in_sessions
    WHERE id = p_entity_id;
    IF v_species IS NULL THEN
      RETURN false;
    END IF;
    IF v_species NOT IN ('cattle', 'sheep', 'pig', 'broiler') THEN
      RETURN false;
    END IF;
    IF v_role = 'admin' THEN RETURN true; END IF;
    v_access := public.profile_program_access();
    IF v_access IS NULL OR array_length(v_access, 1) IS NULL THEN RETURN true; END IF;
    RETURN v_species = ANY(v_access);
  END IF;

  IF p_entity_type = 'cattle.log' THEN
    RETURN v_role IN ('light', 'farm_team', 'management', 'admin');
  END IF;

  IF p_entity_type = 'todo.item' THEN
    IF NOT EXISTS (SELECT 1 FROM public.todo_items WHERE id = p_entity_id) THEN
      RETURN false;
    END IF;
    RETURN v_role IN ('light', 'farm_team', 'management', 'admin');
  END IF;

  RETURN false;
END
$can_read$;

REVOKE ALL ON FUNCTION public._activity_can_read(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._activity_can_read(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 155_processing_calendar.sql
-- ============================================================================
