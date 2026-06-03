-- ============================================================================
-- 075_animal_transfer_activity_rpcs.sql
-- ----------------------------------------------------------------------------
-- Audit-grade transactional manual transfer RPCs for cattle.animal and
-- sheep.animal. Each RPC updates the source row, inserts the transfer audit
-- row, and inserts one status.changed Activity event in a SINGLE transaction.
-- If the audit row or Activity insert fails, the whole move rolls back — the
-- old client "moved but audit failed" warning state goes away for these paths.
--
-- Permission shape (unchanged from the prior client path): transfers are
-- OPERATIONAL, not admin-only. Require an authenticated, active (non-inactive)
-- caller and a non-deleted source row — the same shape the cattle/sheep
-- auth UPDATE RLS policies already enforce. SECURITY DEFINER is used so the
-- multi-table write is atomic, NOT to broaden who may transfer.
--
-- Business behavior preserved:
--   - no-op when destination = current herd/flock (returns ok+noop, writes
--     no transfer row and no Activity event)
--   - set death_date when moving to deceased and missing
--   - set sale_date when moving to sold and missing
--   - reject missing/deleted source records
--   - validate destination against the known herds/flocks incl. outcome states
--
-- Apply order: TEST first, PROD after lane approval.
-- ============================================================================

-- ── transfer_cattle_animal ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transfer_cattle_animal(
  p_entity_id   text,
  p_to_herd     text,
  p_team_member text DEFAULT NULL,
  p_reason      text DEFAULT 'manual'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := auth.uid();
  v_role     text;
  v_from     text;
  v_tag      text;
  v_death    date;
  v_sale     date;
  v_label    text;
  v_tr_id    text;
  v_ae_id    text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'transfer_cattle_animal: authenticated caller required';
  END IF;

  -- 2. Active caller (operational, not admin-only)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'transfer_cattle_animal: caller role % cannot transfer', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate destination herd (active + outcome states)
  IF p_to_herd IS NULL OR p_to_herd NOT IN
    ('mommas','backgrounders','finishers','bulls','processed','deceased','sold') THEN
    RAISE EXCEPTION 'transfer_cattle_animal: invalid destination herd %', COALESCE(p_to_herd, 'null');
  END IF;

  -- 4. Load source row (must exist and not be soft-deleted)
  SELECT c.herd, c.tag, c.death_date, c.sale_date
    INTO v_from, v_tag, v_death, v_sale
    FROM public.cattle c
    WHERE c.id = p_entity_id AND c.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_cattle_animal: record not found or deleted';
  END IF;

  v_label := COALESCE(NULLIF(v_tag, ''), p_entity_id);

  -- 5. No-op when destination equals current herd
  IF v_from = p_to_herd THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  -- 6. Update source row (+ outcome dates when missing)
  UPDATE public.cattle
    SET herd = p_to_herd,
        death_date = CASE WHEN p_to_herd = 'deceased' AND death_date IS NULL THEN current_date ELSE death_date END,
        sale_date  = CASE WHEN p_to_herd = 'sold'     AND sale_date  IS NULL THEN current_date ELSE sale_date  END
    WHERE id = p_entity_id;

  -- 7. Transfer audit row (same transaction)
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.cattle_transfers (id, cattle_id, from_herd, to_herd, reason, team_member)
    VALUES (v_tr_id, p_entity_id, v_from, p_to_herd, COALESCE(NULLIF(p_reason, ''), 'manual'), p_team_member);

  -- 8. status.changed Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'cattle.animal',
    p_entity_id,
    v_caller,
    'status.changed',
    'Moved ' || v_label || ' from ' || COALESCE(v_from, '(none)') || ' to ' || p_to_herd,
    jsonb_build_object(
      'entity_label', v_label,
      'field', 'herd',
      'from', v_from,
      'to', p_to_herd,
      'reason', COALESCE(NULLIF(p_reason, ''), 'manual'),
      'transfer_id', v_tr_id
    )
  );

  RETURN jsonb_build_object('ok', true, 'noop', false, 'transfer_id', v_tr_id, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.transfer_cattle_animal(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_cattle_animal(text, text, text, text) TO authenticated;

-- ── transfer_sheep_animal ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.transfer_sheep_animal(
  p_entity_id   text,
  p_to_flock    text,
  p_team_member text DEFAULT NULL,
  p_reason      text DEFAULT 'manual'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
  v_from   text;
  v_tag    text;
  v_death  date;
  v_sale   date;
  v_label  text;
  v_tr_id  text;
  v_ae_id  text;
BEGIN
  -- 1. Authenticate
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'transfer_sheep_animal: authenticated caller required';
  END IF;

  -- 2. Active caller (operational, not admin-only)
  v_role := public.profile_role();
  IF v_role IS NULL OR v_role = 'inactive' THEN
    RAISE EXCEPTION 'transfer_sheep_animal: caller role % cannot transfer', COALESCE(v_role, 'null');
  END IF;

  -- 3. Validate destination flock (active + outcome states)
  IF p_to_flock IS NULL OR p_to_flock NOT IN
    ('rams','ewes','feeders','processed','deceased','sold') THEN
    RAISE EXCEPTION 'transfer_sheep_animal: invalid destination flock %', COALESCE(p_to_flock, 'null');
  END IF;

  -- 4. Load source row (must exist and not be soft-deleted)
  SELECT s.flock, s.tag, s.death_date, s.sale_date
    INTO v_from, v_tag, v_death, v_sale
    FROM public.sheep s
    WHERE s.id = p_entity_id AND s.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_sheep_animal: record not found or deleted';
  END IF;

  v_label := COALESCE(NULLIF(v_tag, ''), p_entity_id);

  -- 5. No-op when destination equals current flock
  IF v_from = p_to_flock THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  -- 6. Update source row (+ outcome dates when missing)
  UPDATE public.sheep
    SET flock = p_to_flock,
        death_date = CASE WHEN p_to_flock = 'deceased' AND death_date IS NULL THEN current_date ELSE death_date END,
        sale_date  = CASE WHEN p_to_flock = 'sold'     AND sale_date  IS NULL THEN current_date ELSE sale_date  END
    WHERE id = p_entity_id;

  -- 7. Transfer audit row (same transaction)
  v_tr_id := 'tr-' || gen_random_uuid()::text;
  INSERT INTO public.sheep_transfers (id, sheep_id, from_flock, to_flock, reason, team_member)
    VALUES (v_tr_id, p_entity_id, v_from, p_to_flock, COALESCE(NULLIF(p_reason, ''), 'manual'), p_team_member);

  -- 8. status.changed Activity event (same transaction)
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'sheep.animal',
    p_entity_id,
    v_caller,
    'status.changed',
    'Moved ' || v_label || ' from ' || COALESCE(v_from, '(none)') || ' to ' || p_to_flock,
    jsonb_build_object(
      'entity_label', v_label,
      'field', 'flock',
      'from', v_from,
      'to', p_to_flock,
      'reason', COALESCE(NULLIF(p_reason, ''), 'manual'),
      'transfer_id', v_tr_id
    )
  );

  RETURN jsonb_build_object('ok', true, 'noop', false, 'transfer_id', v_tr_id, 'event_id', v_ae_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.transfer_sheep_animal(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_sheep_animal(text, text, text, text) TO authenticated;

-- ── Reload PostgREST schema cache ───────────────────────────────────────

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 075_animal_transfer_activity_rpcs.sql
-- ============================================================================
