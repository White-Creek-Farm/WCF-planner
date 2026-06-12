-- ============================================================================
-- 113_light_daily_report_edit_window.sql
-- ----------------------------------------------------------------------------
-- Light users may view all daily report logs, but may edit/delete only their
-- own daily reports for 3 days after the server submission timestamp.
-- Privileged roles keep the existing behavior from migration 091.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._assert_light_daily_report_mutation_window(
  p_role         text,
  p_owner        uuid,
  p_caller       uuid,
  p_submitted_at timestamptz,
  p_fn           text,
  p_action       text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_role <> 'light' THEN
    RETURN;
  END IF;

  IF p_owner IS NULL OR p_owner <> p_caller THEN
    RAISE EXCEPTION '%: light users may only % their own records', p_fn, p_action;
  END IF;

  IF p_submitted_at IS NULL OR now() > p_submitted_at + interval '3 days' THEN
    RAISE EXCEPTION '%: light users may only % their own records within 3 days of submission', p_fn, p_action;
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public._assert_light_daily_report_mutation_window(text, uuid, uuid, timestamptz, text, text)
  FROM PUBLIC, anon, authenticated;

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
  v_caller       uuid := auth.uid();
  v_role         text;
  v_table        text;
  v_owner        uuid;
  v_submitted_at timestamptz;
  v_old          jsonb;
  v_allow        text[];
  v_set          text := '';
  v_changes      jsonb := '[]'::jsonb;
  v_body         text := '';
  k              text;
  v_type         text;
  v_oldtext      text;
  v_newtext      text;
  v_ae_id        text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'update_daily_report: authenticated caller required';
  END IF;
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'update_daily_report: caller role % cannot edit', COALESCE(v_role, 'null');
  END IF;

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

  EXECUTE format(
    'SELECT to_jsonb(t), t.owner_profile_id, t.submitted_at FROM public.%I t WHERE t.id = $1 AND t.deleted_at IS NULL',
    v_table
  ) INTO v_old, v_owner, v_submitted_at USING p_entity_id;
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'update_daily_report: record not found or already deleted';
  END IF;

  PERFORM public._assert_light_daily_report_mutation_window(
    v_role, v_owner, v_caller, v_submitted_at, 'update_daily_report', 'edit'
  );

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

  IF v_set = '' THEN
    RETURN jsonb_build_object('ok', true, 'changed', 0);
  END IF;

  v_set := left(v_set, length(v_set) - 2);
  EXECUTE format('UPDATE public.%I SET %s WHERE id = $2 AND deleted_at IS NULL', v_table, v_set)
    USING p_patch, p_entity_id;

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
  v_caller       uuid := auth.uid();
  v_role         text;
  v_table        text;
  v_owner        uuid;
  v_submitted_at timestamptz;
  v_exists       boolean;
  v_ae_id        text;
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

  EXECUTE format(
    'SELECT (id IS NOT NULL), owner_profile_id, submitted_at FROM public.%I WHERE id = $1 AND deleted_at IS NULL',
    v_table
  ) INTO v_exists, v_owner, v_submitted_at USING p_entity_id;

  IF v_exists IS NULL OR NOT v_exists THEN
    RAISE EXCEPTION 'soft_delete_daily_report: record not found or already deleted';
  END IF;

  PERFORM public._assert_light_daily_report_mutation_window(
    v_role, v_owner, v_caller, v_submitted_at, 'soft_delete_daily_report', 'delete'
  );

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

NOTIFY pgrst, 'reload schema';
