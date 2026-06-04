-- ============================================================================
-- 091_report_ownership_rpcs.sql
-- ----------------------------------------------------------------------------
-- Lane 1 CP2 — STEP 3 of 4: ownership-enforced edit/delete RPCs (daily reports).
--
-- These RPCs become the ONLY write path once mig 092 revokes direct
-- UPDATE/DELETE. Until then both work. Enforcement model (Codex amendments):
--   - Light (role 'light'): may edit/delete ONLY rows it owns
--     (owner_profile_id = auth.uid()). NULL-owner legacy/anon rows are NOT
--     editable by Light.
--   - Privileged roles (admin/management/farm_team/equipment_tech): unchanged —
--     may edit/delete any non-deleted row, by role.
--   - inactive / anon: rejected.
-- Ownership is read from the server-stamped owner_profile_id (mig 089 trigger);
-- the client never supplies it.
--
-- update_daily_report:
--   - Server-side EXPLICIT positive column allowlist per daily table. Only the
--     listed editable columns can be patched; everything else (identity / audit
--     / ownership: id / owner_profile_id / client_submission_id /
--     daily_submission_id / deleted_at / deleted_by / submitted_at / source /
--     created_at / updated_at, and any future column) is blocked unless
--     deliberately added to the allowlist. Allowlists are the union of what the
--     record pages and the list-view inline editors write.
--   - Per-column type cast via information_schema (text/numeric/bool/date/jsonb).
--   - Server-side diff: the old/new change set is computed INSIDE the RPC (the
--     client never supplies authority for the Activity body) and logged as a
--     'field.updated' activity_events row in the same transaction, matching the
--     shape recordFieldChange produces (payload.changes = [{field,label,from,to,
--     old_present,new_present}]).
--
-- soft_delete_daily_report: re-created with the Light ownership branch added.
-- ============================================================================

-- ── update_daily_report ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_daily_report(
  p_entity_type  text,
  p_entity_id    text,
  p_patch        jsonb,
  p_entity_label text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller    uuid := auth.uid();
  v_role      text;
  v_table     text;
  v_owner     uuid;
  v_old       jsonb;
  v_allow     text[];
  v_set       text := '';
  v_changes   jsonb := '[]'::jsonb;
  v_body      text := '';
  k           text;
  v_type      text;
  v_oldtext   text;
  v_newtext   text;
  v_ae_id     text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_daily_report: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'update_daily_report: caller role % cannot edit', COALESCE(v_role, 'null');
  END IF;

  -- Resolve table + EXPLICIT editable-column allowlist per entity_type.
  CASE p_entity_type
    WHEN 'poultry.daily' THEN
      v_table := 'poultry_dailys';
      v_allow := ARRAY['date','team_member','batch_label','feed_type','feed_lbs','grit_lbs',
                       'mortality_count','mortality_reason','group_moved','waterer_checked','comments'];
    WHEN 'layer.daily' THEN
      v_table := 'layer_dailys';
      v_allow := ARRAY['date','team_member','batch_label','batch_id','feed_type','feed_lbs','grit_lbs',
                       'layer_count','mortality_count','mortality_reason','group_moved','waterer_checked','comments'];
    WHEN 'egg.daily' THEN
      v_table := 'egg_dailys';
      v_allow := ARRAY['date','team_member','group1_name','group1_count','group2_name','group2_count',
                       'group3_name','group3_count','group4_name','group4_count','dozens_on_hand',
                       'daily_dozen_count','comments'];
    WHEN 'pig.daily' THEN
      v_table := 'pig_dailys';
      v_allow := ARRAY['date','team_member','batch_label','batch_id','pig_count','feed_lbs','group_moved',
                       'nipple_drinker_moved','nipple_drinker_working','troughs_moved','fence_walked',
                       'fence_voltage','issues'];
    WHEN 'cattle.daily' THEN
      v_table := 'cattle_dailys';
      v_allow := ARRAY['date','team_member','herd','feeds','minerals','fence_voltage','water_checked',
                       'mortality_count','mortality_reason','issues'];
    WHEN 'sheep.daily' THEN
      v_table := 'sheep_dailys';
      v_allow := ARRAY['date','team_member','flock','feeds','minerals','fence_voltage_kv','waterers_working',
                       'mortality_count','comments'];
    ELSE
      RAISE EXCEPTION 'update_daily_report: unsupported entity_type %', p_entity_type;
  END CASE;

  -- Fetch the current row (as jsonb for the diff) + owner; must be live.
  EXECUTE format(
    'SELECT to_jsonb(t), t.owner_profile_id FROM public.%I t WHERE t.id = $1 AND t.deleted_at IS NULL',
    v_table
  ) INTO v_old, v_owner USING p_entity_id;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'update_daily_report: record not found or already deleted';
  END IF;

  -- Ownership gate: Light edits only its own rows. NULL owner = not editable.
  IF v_role = 'light' AND (v_owner IS NULL OR v_owner <> v_caller) THEN
    RAISE EXCEPTION 'update_daily_report: light users may only edit their own records';
  END IF;

  -- Build the SET clause + server-side diff over the allowlisted columns.
  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY(v_allow)) THEN CONTINUE; END IF;
    SELECT data_type INTO v_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = v_table AND column_name = k;
    IF v_type IS NULL OR v_type IN ('ARRAY', 'USER-DEFINED') THEN CONTINUE; END IF;

    v_oldtext := v_old ->> k;
    v_newtext := p_patch ->> k;
    IF v_oldtext IS DISTINCT FROM v_newtext THEN
      v_set := v_set || format('%I = ($1->>%L)::%s, ', k, k, v_type);
      v_changes := v_changes || jsonb_build_object(
        'field', k, 'label', k, 'from', v_oldtext, 'to', v_newtext,
        'old_present', v_oldtext IS NOT NULL, 'new_present', v_newtext IS NOT NULL
      );
      v_body := v_body || CASE
        WHEN v_newtext IS NULL THEN 'Cleared ' || k
        WHEN v_oldtext IS NULL THEN 'Set ' || k
        ELSE 'Updated ' || k || ': ' || left(v_newtext, 80)
      END || '; ';
    END IF;
  END LOOP;

  -- No real changes -> no-op (no write, no Activity).
  IF v_set = '' THEN
    RETURN jsonb_build_object('ok', true, 'changed', 0);
  END IF;

  v_set := left(v_set, length(v_set) - 2);
  EXECUTE format('UPDATE public.%I SET %s WHERE id = $2 AND deleted_at IS NULL', v_table, v_set)
    USING p_patch, p_entity_id;

  -- field.updated Activity in the same transaction (server-computed body).
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id, p_entity_type, p_entity_id, v_caller, 'field.updated',
    left(v_body, length(v_body) - 2),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id), 'changes', v_changes)
  );

  RETURN jsonb_build_object('ok', true, 'changed', jsonb_array_length(v_changes), 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.update_daily_report(text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_daily_report(text, text, jsonb, text) TO authenticated;

-- ── soft_delete_daily_report — add the Light ownership branch ────────────────
CREATE OR REPLACE FUNCTION public.soft_delete_daily_report(
  p_entity_type  text,
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
  v_table  text;
  v_owner  uuid;
  v_exists boolean;
  v_ae_id  text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'soft_delete_daily_report: authenticated caller required';
  END IF;

  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'soft_delete_daily_report: caller role % cannot delete', COALESCE(v_role, 'null');
  END IF;

  v_table := CASE p_entity_type
    WHEN 'poultry.daily' THEN 'poultry_dailys'
    WHEN 'layer.daily'   THEN 'layer_dailys'
    WHEN 'egg.daily'     THEN 'egg_dailys'
    WHEN 'pig.daily'     THEN 'pig_dailys'
    WHEN 'cattle.daily'  THEN 'cattle_dailys'
    WHEN 'sheep.daily'   THEN 'sheep_dailys'
    ELSE NULL
  END;
  IF v_table IS NULL THEN
    RAISE EXCEPTION 'soft_delete_daily_report: unsupported entity_type %', p_entity_type;
  END IF;

  -- Existence (live) + owner in one read.
  EXECUTE format(
    'SELECT (id IS NOT NULL), owner_profile_id FROM public.%I WHERE id = $1 AND deleted_at IS NULL',
    v_table
  ) INTO v_exists, v_owner USING p_entity_id;

  IF v_exists IS NULL OR NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_daily_report: record not found or already deleted';
  END IF;

  -- Light may delete only its own rows. NULL owner = not deletable by Light.
  IF v_role = 'light' AND (v_owner IS NULL OR v_owner <> v_caller) THEN
    RAISE EXCEPTION 'soft_delete_daily_report: light users may only delete their own records';
  END IF;

  EXECUTE format(
    'UPDATE public.%I SET deleted_at = now(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL',
    v_table
  ) USING v_caller, p_entity_id;

  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id, p_entity_type, p_entity_id, v_caller, 'record.deleted',
    'Deleted ' || replace(p_entity_type, '.', ' ') || ' report: ' || COALESCE(NULLIF(p_entity_label, ''), p_entity_id),
    jsonb_build_object('entity_label', COALESCE(NULLIF(p_entity_label, ''), p_entity_id))
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.soft_delete_daily_report(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_daily_report(text, text, text) TO authenticated;

-- ── equipment_fuelings + fuel_supplies ownership RPCs ───────────────────────
-- These are the enforcement point for the Light "My Submissions" surface.
-- Privileged roles keep editing via the existing /fleet + admin direct paths
-- (mig 092 RLS allows privileged direct writes; Light direct writes are denied,
-- forcing Light through these ownership-checked, column-allowlisted RPCs).
-- equipment_fuelings / fuel_supplies are NOT Activity entities, so no Activity
-- is logged (matches current behavior). Hard delete matches the current
-- direct .delete() paths (no soft-delete column on these tables).

CREATE OR REPLACE FUNCTION public._update_owned_simple(
  p_table text, p_allow text[], p_id text, p_patch jsonb, p_fn text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_owner  uuid;
  v_found  boolean;
  v_set    text := '';
  v_n      int := 0;
  v_old    jsonb;
  k text; v_type text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION '%: authenticated caller required', p_fn; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN RAISE EXCEPTION '%: role % cannot edit', p_fn, COALESCE(v_role,'null'); END IF;

  EXECUTE format('SELECT to_jsonb(t), (t.id IS NOT NULL), t.owner_profile_id FROM public.%I t WHERE t.id = $1', p_table)
    INTO v_old, v_found, v_owner USING p_id;
  IF v_found IS NULL OR NOT v_found THEN RAISE EXCEPTION '%: record not found', p_fn; END IF;

  IF v_role = 'light' AND (v_owner IS NULL OR v_owner <> v_caller) THEN
    RAISE EXCEPTION '%: light users may only edit their own records', p_fn;
  END IF;

  FOR k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (k = ANY(p_allow)) THEN CONTINUE; END IF;
    SELECT data_type INTO v_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name=p_table AND column_name=k;
    IF v_type IS NULL OR v_type IN ('ARRAY','USER-DEFINED') THEN CONTINUE; END IF;
    IF (v_old->>k) IS DISTINCT FROM (p_patch->>k) THEN
      v_set := v_set || format('%I = ($1->>%L)::%s, ', k, k, v_type);
      v_n := v_n + 1;
    END IF;
  END LOOP;

  IF v_set = '' THEN RETURN jsonb_build_object('ok', true, 'changed', 0); END IF;
  v_set := left(v_set, length(v_set) - 2);
  EXECUTE format('UPDATE public.%I SET %s WHERE id = $2', p_table, v_set) USING p_patch, p_id;
  RETURN jsonb_build_object('ok', true, 'changed', v_n);
END
$fn$;
REVOKE ALL ON FUNCTION public._update_owned_simple(text, text[], text, jsonb, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._delete_owned_simple(p_table text, p_id text, p_fn text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_caller uuid := auth.uid(); v_role text; v_owner uuid; v_found boolean;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION '%: authenticated caller required', p_fn; END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN RAISE EXCEPTION '%: role % cannot delete', p_fn, COALESCE(v_role,'null'); END IF;
  EXECUTE format('SELECT (id IS NOT NULL), owner_profile_id FROM public.%I WHERE id = $1', p_table)
    INTO v_found, v_owner USING p_id;
  IF v_found IS NULL OR NOT v_found THEN RAISE EXCEPTION '%: record not found', p_fn; END IF;
  IF v_role = 'light' AND (v_owner IS NULL OR v_owner <> v_caller) THEN
    RAISE EXCEPTION '%: light users may only delete their own records', p_fn;
  END IF;
  EXECUTE format('DELETE FROM public.%I WHERE id = $1', p_table) USING p_id;
  RETURN jsonb_build_object('ok', true);
END $fn$;
REVOKE ALL ON FUNCTION public._delete_owned_simple(text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.update_equipment_fueling(p_id text, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN public._update_owned_simple('equipment_fuelings',
    ARRAY['date','team_member','fuel_type','gallons','fuel_cost_per_gal','hours_reading','km_reading','comments'],
    p_id, p_patch, 'update_equipment_fueling');
END $fn$;
REVOKE ALL ON FUNCTION public.update_equipment_fueling(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_equipment_fueling(text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_equipment_fueling(p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN RETURN public._delete_owned_simple('equipment_fuelings', p_id, 'delete_equipment_fueling'); END $fn$;
REVOKE ALL ON FUNCTION public.delete_equipment_fueling(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_equipment_fueling(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_fuel_supply(p_id text, p_patch jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN public._update_owned_simple('fuel_supplies',
    ARRAY['date','gallons','fuel_type','supplier','cost_per_gal','total_cost','destination','team_member','notes'],
    p_id, p_patch, 'update_fuel_supply');
END $fn$;
REVOKE ALL ON FUNCTION public.update_fuel_supply(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_fuel_supply(text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_fuel_supply(p_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN RETURN public._delete_owned_simple('fuel_supplies', p_id, 'delete_fuel_supply'); END $fn$;
REVOKE ALL ON FUNCTION public.delete_fuel_supply(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fuel_supply(text) TO authenticated;

NOTIFY pgrst, 'reload schema';
