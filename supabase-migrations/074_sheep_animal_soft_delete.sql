-- ============================================================================
-- 074_sheep_animal_soft_delete.sql
-- ----------------------------------------------------------------------------
-- Soft-delete for sheep.animal records (public.sheep table). Phase A only.
-- Mirrors 069_cattle_animal_soft_delete.sql.
--
-- 1. Add deleted_at / deleted_by columns.
-- 2. Replace the active tag uniqueness index — drop legacy idx_sheep_tag_unique
--    and recreate idx_sheep_tag_active_unique scoped to active flocks and
--    non-deleted rows so a deleted sheep frees its tag for reuse.
-- 3. Add partial index on (flock) WHERE deleted_at IS NULL for efficient
--    active-record queries.
-- 4. Replace RLS policies, mirroring cattle 069 exactly: drop the legacy anon
--    SELECT + single authenticated FOR ALL policy and create six scoped
--    replacements (anon select/insert/update, auth select/insert/update). No
--    DELETE policy. Deleted rows are hidden from anon and non-admin auth reads
--    (admins can still read them); inserts/updates cannot create or retain a
--    deleted row.
-- 5. SECDEF RPC soft_delete_sheep_animal: admin-only, sets deleted_at/deleted_by,
--    inserts record.deleted activity event.
-- 6. SECDEF RPC restore_sheep_animal: admin-only, clears deleted_at/deleted_by,
--    checks active tag conflict before restore, inserts record.restored event.
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

-- ── 1. Soft-delete columns ──────────────────────────────────────────────

ALTER TABLE public.sheep
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

-- ── 2. Replace tag uniqueness index ─────────────────────────────────────

DROP INDEX IF EXISTS idx_sheep_tag_unique;
DROP INDEX IF EXISTS idx_sheep_tag_active_unique;

CREATE UNIQUE INDEX idx_sheep_tag_active_unique
  ON public.sheep(tag)
  WHERE tag IS NOT NULL
    AND deleted_at IS NULL
    AND flock IN ('rams','ewes','feeders');

-- ── 3. Active lookup index ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS sheep_active_idx
  ON public.sheep(flock) WHERE deleted_at IS NULL;

-- ── 4. Replace RLS policies ─────────────────────────────────────────────

DROP POLICY IF EXISTS sheep_anon_select ON public.sheep;
DROP POLICY IF EXISTS sheep_auth_all    ON public.sheep;

CREATE POLICY sheep_anon_select ON public.sheep FOR SELECT
  TO anon
  USING (deleted_at IS NULL);

CREATE POLICY sheep_anon_insert ON public.sheep FOR INSERT
  TO anon
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY sheep_anon_update ON public.sheep FOR UPDATE
  TO anon
  USING (deleted_at IS NULL)
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY sheep_auth_select ON public.sheep FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL OR public.profile_role() = 'admin');

CREATE POLICY sheep_auth_insert ON public.sheep FOR INSERT
  TO authenticated
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY sheep_auth_update ON public.sheep FOR UPDATE
  TO authenticated
  USING (deleted_at IS NULL)
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

-- ── 5. SECDEF RPC: soft_delete_sheep_animal ─────────────────────────────

CREATE OR REPLACE FUNCTION public.soft_delete_sheep_animal(
  p_entity_id    text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_exists boolean;
  v_ae_id  text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'soft_delete_sheep_animal: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'soft_delete_sheep_animal: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'soft_delete_sheep_animal: admin role required';
  END IF;

  -- 3. Check record exists and is not already deleted
  SELECT EXISTS(
    SELECT 1 FROM public.sheep WHERE id = p_entity_id AND deleted_at IS NULL
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_sheep_animal: record not found or already deleted';
  END IF;

  -- 4. Soft-delete
  UPDATE public.sheep
    SET deleted_at = now(), deleted_by = v_caller
    WHERE id = p_entity_id AND deleted_at IS NULL;

  -- 5. Insert record.deleted Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    'sheep.animal',
    p_entity_id,
    v_caller,
    'record.deleted',
    'Deleted sheep animal: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.soft_delete_sheep_animal(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_sheep_animal(text, text) TO authenticated;

-- ── 6. SECDEF RPC: restore_sheep_animal ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.restore_sheep_animal(
  p_entity_id    text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_exists   boolean;
  v_tag      text;
  v_flock    text;
  v_conflict boolean;
  v_ae_id    text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'restore_sheep_animal: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'restore_sheep_animal: caller role % cannot restore', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'restore_sheep_animal: admin role required';
  END IF;

  -- 3. Check record exists and IS deleted
  SELECT EXISTS(
    SELECT 1 FROM public.sheep WHERE id = p_entity_id AND deleted_at IS NOT NULL
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'restore_sheep_animal: record not found or not deleted';
  END IF;

  -- 4. Read tag and flock from the row
  SELECT s.tag, s.flock INTO v_tag, v_flock
    FROM public.sheep s
    WHERE s.id = p_entity_id;

  -- 5. Active tag conflict check (flock + tag + deleted_at IS NULL semantics)
  IF v_tag IS NOT NULL AND v_flock IN ('rams','ewes','feeders') THEN
    SELECT EXISTS(
      SELECT 1 FROM public.sheep
        WHERE tag = v_tag
          AND id <> p_entity_id
          AND deleted_at IS NULL
          AND flock IN ('rams','ewes','feeders')
    ) INTO v_conflict;

    IF v_conflict THEN
      RAISE EXCEPTION 'restore_sheep_animal: tag % already in use by an active animal', v_tag;
    END IF;
  END IF;

  -- 6. Restore
  UPDATE public.sheep
    SET deleted_at = NULL, deleted_by = NULL
    WHERE id = p_entity_id;

  -- 7. Insert record.restored Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    'sheep.animal',
    p_entity_id,
    v_caller,
    'record.restored',
    'Restored sheep animal: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.restore_sheep_animal(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_sheep_animal(text, text) TO authenticated;

-- ── 7. Reload PostgREST schema cache ────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 074_sheep_animal_soft_delete.sql
-- ============================================================================
