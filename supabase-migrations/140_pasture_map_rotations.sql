-- ============================================================================
-- 140_pasture_map_rotations.sql
-- Pasture Map V1 reset: shared, persisted MANUAL rotations.
--
-- Until now a group's planned rotation (its ordered list of destination areas)
-- lived only in client state, so it was per-device and could not be shared or
-- shown to other users. The V1 reset makes rotations a first-class, server-side,
-- USER-CONTROLLED record: one ordered path per planner group identity
-- (animal_type + group_key). No route is generated server-side; the array is
-- exactly what a user built.
--
-- Access mirrors the other farm_team-level pasture write surfaces (record moves,
-- temp paddocks, tracks): farm_team / management / admin / light may read and
-- edit. equipment_tech / inactive have no access. All access is through
-- SECURITY DEFINER RPCs; the table itself is deny-all.
--
-- area_ids is stored verbatim as a JSON array of land_area id strings (the same
-- ids minted client-side). It is NOT FK-validated against land_areas: archived /
-- deleted destinations are filtered out client-side on render, exactly like the
-- pre-existing client rotation array did. The path is a plan, never proof of
-- placement (current location still comes only from the move ledger).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pasture_rotations (
  animal_type text NOT NULL
    CHECK (animal_type IN ('cattle_herd', 'sheep_flock', 'breeder_pigs', 'feeder_pigs')),
  group_key text NOT NULL,
  area_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by uuid REFERENCES public.profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (animal_type, group_key)
);

ALTER TABLE public.pasture_rotations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pasture_rotations FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'pasture_rotations' AND policyname = 'pasture_rotations_deny_all'
  ) THEN
    CREATE POLICY pasture_rotations_deny_all ON public.pasture_rotations FOR ALL USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- list_pasture_rotations() -> { rotations: [ {animal_type, group_key, area_ids, updated_at} ] }
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_pasture_rotations()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_rows jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'list_pasture_rotations: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot read pasture rotations', coalesce(v_role, '(none)');
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'animal_type', r.animal_type,
        'group_key', r.group_key,
        'area_ids', r.area_ids,
        'updated_at', r.updated_at
      )
      ORDER BY r.animal_type, r.group_key
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.pasture_rotations r;

  RETURN jsonb_build_object('rotations', v_rows);
END
$fn$;

-- ---------------------------------------------------------------------------
-- upsert_pasture_rotation(animal_type, group_key, area_ids jsonb)
-- Stores the user's ordered path for one group identity. area_ids must be a JSON
-- array; each element is coerced to text. An empty array is allowed (it clears
-- the path while keeping the row); callers that want the row gone use clear_*.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_pasture_rotation(p_animal_type text, p_group_key text, p_area_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
  v_clean jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'upsert_pasture_rotation: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot edit pasture rotations', coalesce(v_role, '(none)');
  END IF;
  IF p_animal_type IS NULL OR p_animal_type NOT IN ('cattle_herd', 'sheep_flock', 'breeder_pigs', 'feeder_pigs') THEN
    RAISE 'PM_VALIDATION: invalid animal_type %', coalesce(p_animal_type, '(null)');
  END IF;
  IF p_group_key IS NULL OR length(p_group_key) = 0 THEN
    RAISE 'PM_VALIDATION: group_key required';
  END IF;
  IF p_area_ids IS NULL OR jsonb_typeof(p_area_ids) <> 'array' THEN
    RAISE 'PM_VALIDATION: area_ids must be a JSON array';
  END IF;

  -- Re-build the array as a clean array of text ids (drops nulls). The explicit
  -- ORDER BY elem.ord is REQUIRED: jsonb_agg without an ORDER BY does not guarantee
  -- input order, and the rotation path is a manually-ordered sequence of stops.
  SELECT coalesce(jsonb_agg(elem.value ORDER BY elem.ord), '[]'::jsonb)
  INTO v_clean
  FROM jsonb_array_elements_text(p_area_ids) WITH ORDINALITY AS elem(value, ord)
  WHERE elem.value IS NOT NULL AND length(elem.value) > 0;

  INSERT INTO public.pasture_rotations (animal_type, group_key, area_ids, updated_by, updated_at)
  VALUES (p_animal_type, p_group_key, v_clean, v_caller, now())
  ON CONFLICT (animal_type, group_key)
  DO UPDATE SET area_ids = EXCLUDED.area_ids, updated_by = v_caller, updated_at = now();

  RETURN jsonb_build_object('animal_type', p_animal_type, 'group_key', p_group_key, 'area_ids', v_clean);
END
$fn$;

-- ---------------------------------------------------------------------------
-- clear_pasture_rotation(animal_type, group_key) -> deletes the row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.clear_pasture_rotation(p_animal_type text, p_group_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE 'clear_pasture_rotation: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role NOT IN ('farm_team', 'management', 'admin', 'light') THEN
    RAISE 'PM_VALIDATION: caller role % cannot edit pasture rotations', coalesce(v_role, '(none)');
  END IF;

  DELETE FROM public.pasture_rotations
  WHERE animal_type = p_animal_type AND group_key = p_group_key;

  RETURN jsonb_build_object('cleared', true);
END
$fn$;

REVOKE ALL ON FUNCTION public.list_pasture_rotations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_pasture_rotation(text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_pasture_rotation(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pasture_rotations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pasture_rotation(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_pasture_rotation(text, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
