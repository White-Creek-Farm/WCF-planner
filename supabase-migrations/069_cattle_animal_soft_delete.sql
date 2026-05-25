-- ============================================================================
-- 069_cattle_animal_soft_delete.sql
-- ----------------------------------------------------------------------------
-- Soft-delete for cattle.animal records (public.cattle table).
--
-- 1. Add deleted_at / deleted_by columns.
-- 2. Replace tag uniqueness index — drop legacy idx_cattle_tag_unique and
--    recreate idx_cattle_tag_active_unique scoped to active herds and
--    non-deleted rows.
-- 3. Add partial index on (herd) WHERE deleted_at IS NULL for efficient
--    active-record queries.
-- 4. Replace RLS policies — drop all four existing and create six scoped
--    replacements (anon select/insert/update, auth select/insert/update).
--    No DELETE policy.
-- 5. SECDEF RPC soft_delete_cattle_animal: admin-only, sets
--    deleted_at/deleted_by, inserts record.deleted activity event.
-- 6. SECDEF RPC restore_cattle_animal: admin-only, clears
--    deleted_at/deleted_by, checks tag conflict before restore, inserts
--    record.restored activity event.
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

-- ── 1. Soft-delete columns ──────────────────────────────────────────────

ALTER TABLE public.cattle
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.profiles(id);

-- ── 2. Replace tag uniqueness index ─────────────────────────────────────

DROP INDEX IF EXISTS idx_cattle_tag_unique;
DROP INDEX IF EXISTS idx_cattle_tag_active_unique;

CREATE UNIQUE INDEX idx_cattle_tag_active_unique
  ON public.cattle(tag)
  WHERE tag IS NOT NULL
    AND deleted_at IS NULL
    AND herd IN ('mommas','backgrounders','finishers','bulls');

-- ── 3. Active lookup index ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS cattle_active_idx
  ON public.cattle(herd) WHERE deleted_at IS NULL;

-- ── 4. Replace RLS policies ─────────────────────────────────────────────

DROP POLICY IF EXISTS cattle_anon_select ON public.cattle;
DROP POLICY IF EXISTS cattle_anon_insert ON public.cattle;
DROP POLICY IF EXISTS cattle_anon_update ON public.cattle;
DROP POLICY IF EXISTS cattle_auth_all    ON public.cattle;

CREATE POLICY cattle_anon_select ON public.cattle FOR SELECT
  TO anon
  USING (deleted_at IS NULL);

CREATE POLICY cattle_anon_insert ON public.cattle FOR INSERT
  TO anon
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY cattle_anon_update ON public.cattle FOR UPDATE
  TO anon
  USING (deleted_at IS NULL)
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY cattle_auth_select ON public.cattle FOR SELECT
  TO authenticated
  USING (deleted_at IS NULL OR public.profile_role() = 'admin');

CREATE POLICY cattle_auth_insert ON public.cattle FOR INSERT
  TO authenticated
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

CREATE POLICY cattle_auth_update ON public.cattle FOR UPDATE
  TO authenticated
  USING (deleted_at IS NULL)
  WITH CHECK (deleted_at IS NULL AND deleted_by IS NULL);

-- ── 5. SECDEF RPC: soft_delete_cattle_animal ────────────────────────────

CREATE OR REPLACE FUNCTION public.soft_delete_cattle_animal(
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
    RAISE EXCEPTION 'soft_delete_cattle_animal: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'soft_delete_cattle_animal: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'soft_delete_cattle_animal: admin role required';
  END IF;

  -- 3. Check record exists and is not already deleted
  SELECT EXISTS(
    SELECT 1 FROM public.cattle WHERE id = p_entity_id AND deleted_at IS NULL
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_cattle_animal: record not found or already deleted';
  END IF;

  -- 4. Soft-delete
  UPDATE public.cattle
    SET deleted_at = now(), deleted_by = v_caller
    WHERE id = p_entity_id AND deleted_at IS NULL;

  -- 5. Insert record.deleted Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    'cattle.animal',
    p_entity_id,
    v_caller,
    'record.deleted',
    'Deleted cattle animal: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.soft_delete_cattle_animal(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_cattle_animal(text, text) TO authenticated;

-- ── 6. SECDEF RPC: restore_cattle_animal ────────────────────────────────

CREATE OR REPLACE FUNCTION public.restore_cattle_animal(
  p_entity_id    text,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller  uuid := auth.uid();
  v_role    text;
  v_exists  boolean;
  v_tag     text;
  v_herd    text;
  v_conflict boolean;
  v_ae_id   text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'restore_cattle_animal: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'restore_cattle_animal: caller role % cannot restore', COALESCE(v_role, 'null');
  END IF;

  -- 2. Admin-only
  IF v_role <> 'admin' THEN
    RAISE EXCEPTION 'restore_cattle_animal: admin role required';
  END IF;

  -- 3. Check record exists and IS deleted
  SELECT EXISTS(
    SELECT 1 FROM public.cattle WHERE id = p_entity_id AND deleted_at IS NOT NULL
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'restore_cattle_animal: record not found or not deleted';
  END IF;

  -- 4. Read tag and herd from the row
  SELECT c.tag, c.herd INTO v_tag, v_herd
    FROM public.cattle c
    WHERE c.id = p_entity_id;

  -- 5. Tag conflict check
  IF v_tag IS NOT NULL AND v_herd IN ('mommas','backgrounders','finishers','bulls') THEN
    SELECT EXISTS(
      SELECT 1 FROM public.cattle
        WHERE tag = v_tag
          AND id <> p_entity_id
          AND deleted_at IS NULL
          AND herd IN ('mommas','backgrounders','finishers','bulls')
    ) INTO v_conflict;

    IF v_conflict THEN
      RAISE EXCEPTION 'restore_cattle_animal: tag % already in use by an active animal', v_tag;
    END IF;
  END IF;

  -- 6. Restore
  UPDATE public.cattle
    SET deleted_at = NULL, deleted_by = NULL
    WHERE id = p_entity_id;

  -- 7. Insert record.restored Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id,
    event_type, body, payload
  ) VALUES (
    v_ae_id,
    'cattle.animal',
    p_entity_id,
    v_caller,
    'record.restored',
    'Restored cattle animal: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.restore_cattle_animal(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_cattle_animal(text, text) TO authenticated;

-- ── 7. Reload PostgREST schema cache ────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 069_cattle_animal_soft_delete.sql
-- ============================================================================
