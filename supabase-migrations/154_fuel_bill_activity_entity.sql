-- ============================================================================
-- 154_fuel_bill_activity_entity.sql
-- ----------------------------------------------------------------------------
-- Adds a dedicated equipment.fuel_bill Activity entity so fuel-bill create +
-- delete audit events stop borrowing the equipment.item entity.
--
-- WHY A NEW ENTITY (pushback resolved): migration 107 logs the fuel-bill
-- record.deleted against equipment.item with entity_id = the fuel bill's text
-- id. But _activity_can_read's equipment.item branch gates on
-- `EXISTS (SELECT 1 FROM public.equipment WHERE id = p_entity_id)`. A fuel-bill
-- id (e.g. 'fb-1718000000000-ab12cd') is NOT an equipment id, so that read
-- branch returns false for every fuel-bill event and the rows are invisible in
-- the global Activity log. Rather than pile more equipment.item fuel-bill
-- events onto a mismatched read gate, this migration introduces
-- equipment.fuel_bill with its own resolver branch and re-scopes delete_fuel_bill
-- onto it.
--
-- READ/WRITE MODEL — admin-only, NO row-existence requirement:
--   * The Bills tab (FuelBillsView) is admin-gated (mounted inside the admin
--     WebformsAdmin surface; see archive/026_fuel_bills.sql). So both the
--     create emit (record_activity_event -> _activity_can_write ->
--     _activity_can_read) and the read gate on the global log are admin-only.
--   * The branch intentionally does NOT check for a fuel_bills row. A deleted
--     bill has no remaining source row, but its record.deleted tombstone must
--     stay readable in the global Activity log. Requiring row existence would
--     hide every delete event the instant the bill is gone. Admin-only read
--     without an existence gate keeps the tombstone visible to admins only.
--
-- _activity_can_write is NOT re-issued: it already delegates to
-- _activity_can_read by name (mig 126), so replacing _activity_can_read below
-- gives write the new branch for free. equipment.fuel_bill is not cattle.log,
-- so it takes the default write path (delegate to read = admin-only), which is
-- exactly what the admin create emit needs.
--
-- FULL-REPLACE of _activity_can_read: this re-issues the entire mig-126 body
-- verbatim (task/broiler/pig.batch/pig.breeder/layer/cattle/cattle.processing/
-- cattle.forecast/cattle.breeding/sheep/equipment.item/*.daily/weighin.session/
-- cattle.log/todo.item) and appends the equipment.fuel_bill branch. Nothing is
-- dropped.
--
-- Apply order: TEST first (this lane), PROD after explicit lane approval.
-- ============================================================================

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

  -- Fuel bills are admin-only financial documents (the Bills tab lives inside
  -- the admin WebformsAdmin surface). Read is admin-gated and intentionally does
  -- NOT require a fuel_bills row to exist so a deleted bill's record.deleted
  -- tombstone stays readable in the global Activity log after the row is gone.
  -- entity_id is the fuel bill's text id (e.g. 'fb-...'), NOT an equipment id.
  IF p_entity_type = 'equipment.fuel_bill' THEN
    RETURN v_role = 'admin';
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

-- ----------------------------------------------------------------------------
-- Re-scope delete_fuel_bill onto the new equipment.fuel_bill entity.
-- Identical to migration 107 except the record.deleted event's entity_type is
-- now 'equipment.fuel_bill' (entity_id remains the fuel bill's text id) so the
-- tombstone resolves through the admin-only fuel_bill read branch above instead
-- of the mismatched equipment.item existence gate.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_fuel_bill(
  p_bill_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller        uuid := auth.uid();
  v_invoice       text;
  v_supplier      text;
  v_delivery      date;
  v_total         numeric;
  v_lines_count   int := 0;
  v_label         text;
  v_ae_id         text;
BEGIN
  -- 1. Authenticate.
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'delete_fuel_bill: authenticated caller required';
  END IF;

  -- 2. Authorize: admin only (the Bills tab is admin-gated; mig 037 is_admin()).
  --    SECURITY DEFINER is for atomicity, not to broaden who may delete.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'delete_fuel_bill: caller is not admin';
  END IF;

  -- 3. Validate args.
  IF p_bill_id IS NULL OR p_bill_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_args');
  END IF;

  -- 4. Load + LOCK the bill (need invoice/supplier/delivery/total for the audit
  --    body + label). FOR UPDATE makes read+audit+delete idempotent under
  --    concurrency: a second concurrent call blocks here until the first commits,
  --    then finds the row gone and returns no_bill with no duplicate audit
  --    (rather than re-auditing + a false ok on a 0-row delete). Existence-gate
  --    so a stale UI delete of an already-gone bill returns no_bill.
  SELECT b.invoice_number, b.supplier, b.delivery_date, b.total
    INTO v_invoice, v_supplier, v_delivery, v_total
    FROM public.fuel_bills b
    WHERE b.id = p_bill_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_bill', 'bill_id', p_bill_id);
  END IF;

  -- 5. Count the child lines BEFORE the delete so the audit payload reports how
  --    many lines the FK cascade will remove. The lines themselves are NOT
  --    deleted here — fuel_bill_lines.bill_id has ON DELETE CASCADE, so deleting
  --    the root (step 7) clears them automatically.
  SELECT count(*)::int INTO v_lines_count
    FROM public.fuel_bill_lines l
    WHERE l.bill_id = p_bill_id;

  v_label := COALESCE(
    NULLIF(trim(COALESCE(v_invoice, '')), ''),
    NULLIF(trim(COALESCE(v_supplier, '')), ''),
    p_bill_id
  );

  -- 6. Audit BEFORE the row is gone (record.deleted on the equipment.fuel_bill
  --    entity; entity_id = the fuel bill id). The equipment.fuel_bill read gate
  --    is admin-only and existence-free, so this tombstone stays visible in the
  --    global Activity log after the bill + lines are cascaded away.
  v_ae_id := 'ae-' || gen_random_uuid()::text;
  INSERT INTO public.activity_events (
    id, entity_type, entity_id, actor_profile_id, event_type, body, payload
  ) VALUES (
    v_ae_id,
    'equipment.fuel_bill',
    p_bill_id,
    v_caller,
    'record.deleted',
    'Deleted fuel bill ' || v_label
      || COALESCE(' · ' || v_delivery::text, '')
      || ' (' || v_lines_count::text || ' line'
      || CASE WHEN v_lines_count = 1 THEN '' ELSE 's' END || ')',
    jsonb_build_object(
      'entity_label', v_label,
      'action', 'delete_fuel_bill',
      'bill_id', p_bill_id,
      'invoice_number', v_invoice,
      'supplier', v_supplier,
      'delivery_date', v_delivery,
      'total', v_total,
      'lines_deleted', v_lines_count
    )
  );

  -- 7. Delete the bill root (same transaction). fuel_bill_lines cascade away.
  DELETE FROM public.fuel_bills WHERE id = p_bill_id;

  RETURN jsonb_build_object(
    'ok', true,
    'reason', 'deleted',
    'bill_id', p_bill_id,
    'lines_deleted', v_lines_count,
    'event_id', v_ae_id
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.delete_fuel_bill(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fuel_bill(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 154_fuel_bill_activity_entity.sql
-- ============================================================================
