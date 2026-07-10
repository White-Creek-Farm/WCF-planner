-- ============================================================================
-- 171_audited_user_management.sql
-- ----------------------------------------------------------------------------
-- Move authenticated user-management writes behind narrow admin-only RPCs.
--
-- The profiles row is an auth.users child (ON DELETE CASCADE), while many
-- operational tables intentionally retain profile references. Hard-delete is
-- therefore a two-system operation:
--
--   1. admin_prepare_user_delete validates the target and proves that no live
--      NO ACTION / RESTRICT profile FK would block the Auth cascade, then logs
--      immutable delete intent.
--   2. rapid-processor deletes auth.users through the service-role Auth API.
--      That single delete owns the profiles cascade.
--   3. admin_finalize_user_delete records success/failure without depending on
--      the target profile still existing.
--
-- Ordinary name/role/program-access mutations update profiles and append their
-- audit row in one database transaction. The audit ledger deliberately has no
-- profile FKs so actor/target evidence survives account deletion.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_management_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid,
  actor_profile_id    uuid NOT NULL,
  actor_email         text,
  actor_full_name     text,
  target_profile_id   uuid NOT NULL,
  target_email        text,
  target_full_name    text,
  event_type          text NOT NULL,
  changes             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_management_audit_event_type_check CHECK (
    event_type IN (
      'profile.name_changed',
      'profile.role_changed',
      'profile.deactivated',
      'profile.reactivated',
      'profile.program_access_changed',
      'profile.delete_requested',
      'profile.deleted',
      'profile.delete_failed'
    )
  ),
  CONSTRAINT user_management_audit_error_length_check CHECK (
    error_message IS NULL OR length(error_message) <= 1000
  )
);

CREATE INDEX IF NOT EXISTS user_management_audit_target_created_idx
  ON public.user_management_audit (target_profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_management_audit_request_idx
  ON public.user_management_audit (request_id, created_at)
  WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_management_audit_delete_terminal_uq
  ON public.user_management_audit (request_id)
  WHERE request_id IS NOT NULL
    AND event_type IN ('profile.deleted', 'profile.delete_failed');

ALTER TABLE public.user_management_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_management_audit FROM PUBLIC, anon, authenticated;

-- Private caller gate shared by the public RPCs below. It is not executable by
-- browser roles directly.
CREATE OR REPLACE FUNCTION public._require_user_management_admin()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_caller uuid := auth.uid();
  v_role   text;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user management: authenticated caller required';
  END IF;

  SELECT role INTO v_role
    FROM public.profiles
   WHERE id = v_caller;

  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user management: admin role required';
  END IF;

  RETURN v_caller;
END
$fn$;

REVOKE ALL ON FUNCTION public._require_user_management_admin() FROM PUBLIC, anon, authenticated;

-- Private immutable-ledger writer. Target snapshots may be supplied by the
-- delete-finalization path after the target profile has cascaded away.
CREATE OR REPLACE FUNCTION public._log_user_management_event(
  p_actor_profile_id  uuid,
  p_target_profile_id uuid,
  p_event_type        text,
  p_changes           jsonb DEFAULT '{}'::jsonb,
  p_request_id        uuid DEFAULT NULL,
  p_error_message     text DEFAULT NULL,
  p_target_email      text DEFAULT NULL,
  p_target_full_name  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id               uuid := gen_random_uuid();
  v_actor_email      text;
  v_actor_full_name  text;
  v_target_email     text := p_target_email;
  v_target_full_name text := p_target_full_name;
BEGIN
  SELECT email, full_name
    INTO v_actor_email, v_actor_full_name
    FROM public.profiles
   WHERE id = p_actor_profile_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user management audit: actor profile not found';
  END IF;

  IF v_target_email IS NULL AND v_target_full_name IS NULL THEN
    SELECT email, full_name
      INTO v_target_email, v_target_full_name
      FROM public.profiles
     WHERE id = p_target_profile_id;
  END IF;

  INSERT INTO public.user_management_audit (
    id,
    request_id,
    actor_profile_id,
    actor_email,
    actor_full_name,
    target_profile_id,
    target_email,
    target_full_name,
    event_type,
    changes,
    error_message
  ) VALUES (
    v_id,
    p_request_id,
    p_actor_profile_id,
    v_actor_email,
    v_actor_full_name,
    p_target_profile_id,
    v_target_email,
    v_target_full_name,
    p_event_type,
    COALESCE(p_changes, '{}'::jsonb),
    CASE
      WHEN p_error_message IS NULL THEN NULL
      ELSE left(p_error_message, 1000)
    END
  );

  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public._log_user_management_event(
  uuid, uuid, text, jsonb, uuid, text, text, text
) FROM PUBLIC, anon, authenticated;

-- Auth owns account deletion. profiles.id cascades from auth.users, so this
-- AFTER DELETE trigger runs inside the same database transaction as the Auth
-- delete and appends the success terminal before commit. If the audit insert
-- fails, the profile/Auth cascade rolls back too: successful hard delete can no
-- longer land without durable evidence even if Edge crashes before finalize.
CREATE OR REPLACE FUNCTION public._audit_profile_delete_from_auth_cascade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_request public.user_management_audit%ROWTYPE;
BEGIN
  SELECT requested.* INTO v_request
    FROM public.user_management_audit requested
   WHERE requested.event_type = 'profile.delete_requested'
     AND requested.target_profile_id = OLD.id
     AND NOT EXISTS (
       SELECT 1
         FROM public.user_management_audit terminal
        WHERE terminal.request_id = requested.id
          AND terminal.event_type IN ('profile.deleted', 'profile.delete_failed')
     )
   ORDER BY requested.created_at DESC
   LIMIT 1
   FOR UPDATE;

  -- During a real ON DELETE CASCADE from auth.users, PostgreSQL makes the
  -- deleted parent row invisible before this child AFTER DELETE trigger runs.
  -- If the parent is still present, this was a direct profiles delete. Refuse
  -- it while a coordinated request is pending so it cannot create split-brain
  -- state or falsely terminalize the Auth deletion request.
  IF FOUND AND EXISTS (
    SELECT 1 FROM auth.users WHERE id = OLD.id
  ) THEN
    RAISE EXCEPTION
      'profile delete with pending user-management request must originate from auth.users cascade'
      USING ERRCODE = '55000';
  END IF;

  IF FOUND THEN
    INSERT INTO public.user_management_audit (
      id,
      request_id,
      actor_profile_id,
      actor_email,
      actor_full_name,
      target_profile_id,
      target_email,
      target_full_name,
      event_type,
      changes,
      error_message
    ) VALUES (
      gen_random_uuid(),
      v_request.id,
      v_request.actor_profile_id,
      v_request.actor_email,
      v_request.actor_full_name,
      OLD.id,
      COALESCE(v_request.target_email, OLD.email),
      COALESCE(v_request.target_full_name, OLD.full_name),
      'profile.deleted',
      jsonb_build_object(
        'delete_request_id', v_request.id,
        'completed_by', 'profiles_delete_trigger'
      ),
      NULL
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN OLD;
END
$fn$;

REVOKE ALL ON FUNCTION public._audit_profile_delete_from_auth_cascade()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_audit_auth_delete ON public.profiles;
CREATE TRIGGER profiles_audit_auth_delete
AFTER DELETE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public._audit_profile_delete_from_auth_cascade();

-- A delete request stays "pending" until a terminal row references it. This
-- durable marker spans the database RPC / Auth API boundary. Pending targets
-- do not count as effective admins, which prevents two admins from preparing
-- deletion of one another and then both succeeding after their RPC locks end.
CREATE OR REPLACE FUNCTION public._user_management_delete_pending(
  p_profile_id   uuid,
  p_include_actor boolean DEFAULT false
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.user_management_audit requested
     WHERE requested.event_type = 'profile.delete_requested'
       AND (
         requested.target_profile_id = p_profile_id
         OR (p_include_actor AND requested.actor_profile_id = p_profile_id)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM public.user_management_audit terminal
          WHERE terminal.request_id = requested.id
            AND terminal.event_type IN ('profile.deleted', 'profile.delete_failed')
       )
  )
$fn$;

REVOKE ALL ON FUNCTION public._user_management_delete_pending(uuid, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._user_management_effective_admin_count()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $fn$
  SELECT count(*)
    FROM public.profiles p
   WHERE p.role = 'admin'
     AND NOT public._user_management_delete_pending(p.id, false)
$fn$;

REVOKE ALL ON FUNCTION public._user_management_effective_admin_count()
  FROM PUBLIC, anon, authenticated;

-- Global lock + fresh caller-row lock. Every public user-management RPC uses
-- this after an initial admin check and before target work, so queued calls
-- cannot continue with an admin role/pending state captured before the wait.
-- FOR SHARE conflicts with role UPDATE / profile DELETE while still allowing
-- concurrent read-only profile hydration outside this mutation boundary.
CREATE OR REPLACE FUNCTION public._lock_user_management_admin(
  p_caller        uuid,
  p_allow_pending boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $fn$
DECLARE
  v_role text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(171001);

  SELECT role INTO v_role
    FROM public.profiles
   WHERE id = p_caller
   FOR SHARE;

  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user management: admin role required after lock wait';
  END IF;

  IF NOT p_allow_pending
     AND public._user_management_delete_pending(p_caller, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user management: your account deletion is already in progress';
  END IF;

  RETURN p_caller;
END
$fn$;

REVOKE ALL ON FUNCTION public._lock_user_management_admin(uuid, boolean)
  FROM PUBLIC, anon, authenticated;

-- Mutation gate used by every public write/preflight except finalization. A
-- still-admin profile that is itself pending deletion must not start or mutate
-- another account: its bearer may disappear before it can finish the audit.
-- Finalization deliberately keeps the base admin gate so an in-flight actor
-- can append its terminal row.
CREATE OR REPLACE FUNCTION public._require_user_management_mutator()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $fn$
DECLARE
  v_caller uuid := public._require_user_management_admin();
BEGIN
  RETURN public._lock_user_management_admin(v_caller, false);
END
$fn$;

REVOKE ALL ON FUNCTION public._require_user_management_mutator()
  FROM PUBLIC, anon, authenticated;

-- Return the NO ACTION / RESTRICT references that would stop profiles' Auth
-- cascade. Catalog-derived table/column identifiers are quoted before use;
-- values remain parameterized. This avoids a destructive trial delete and any
-- trigger side effects during preflight.
CREATE OR REPLACE FUNCTION public._user_profile_delete_blockers(p_profile_id uuid)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $fn$
DECLARE
  v_fk       record;
  v_has_rows boolean;
  v_blockers text[] := '{}'::text[];
BEGIN
  FOR v_fk IN
    SELECT
      quote_ident(ns.nspname) || '.' || quote_ident(cls.relname) AS qualified_table,
      attr.attname AS column_name
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class cls
      ON cls.oid = con.conrelid
    JOIN pg_catalog.pg_namespace ns
      ON ns.oid = cls.relnamespace
    JOIN pg_catalog.pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.profiles'::regclass
      AND con.confdeltype IN ('a', 'r')
      AND cardinality(con.conkey) = 1
    ORDER BY ns.nspname, cls.relname, attr.attname
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)',
      v_fk.qualified_table,
      v_fk.column_name
    )
      INTO v_has_rows
      USING p_profile_id;

    IF v_has_rows THEN
      v_blockers := array_append(v_blockers, v_fk.qualified_table || '.' || quote_ident(v_fk.column_name));
    END IF;
  END LOOP;

  RETURN v_blockers;
END
$fn$;

REVOKE ALL ON FUNCTION public._user_profile_delete_blockers(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_user_name(
  p_profile_id uuid,
  p_full_name  text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := public._require_user_management_mutator();
  v_old_name text;
  v_new_name text := btrim(COALESCE(p_full_name, ''));
  v_row      public.profiles%ROWTYPE;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user name: profile id required';
  END IF;
  IF length(v_new_name) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user name: use 120 characters or fewer';
  END IF;

  SELECT * INTO v_row
    FROM public.profiles
   WHERE id = p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user name: profile not found';
  END IF;
  IF public._user_management_delete_pending(p_profile_id, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user name: account deletion is already in progress';
  END IF;

  v_old_name := COALESCE(v_row.full_name, '');
  IF v_old_name = v_new_name THEN
    RETURN jsonb_build_object(
      'ok', true, 'noop', true, 'id', v_row.id, 'full_name', v_new_name
    );
  END IF;

  UPDATE public.profiles
     SET full_name = v_new_name
   WHERE id = p_profile_id;

  PERFORM public._log_user_management_event(
    v_caller,
    p_profile_id,
    'profile.name_changed',
    jsonb_build_object(
      'full_name', jsonb_build_object('from', v_old_name, 'to', v_new_name)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'id', v_row.id, 'full_name', v_new_name
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_user_role(
  p_profile_id uuid,
  p_role       text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := public._require_user_management_mutator();
  v_new_role text := lower(btrim(COALESCE(p_role, '')));
  v_row      public.profiles%ROWTYPE;
  v_event    text;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user role: profile id required';
  END IF;
  IF v_new_role NOT IN ('admin', 'management', 'farm_team', 'equipment_tech', 'light', 'inactive') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user role: invalid role';
  END IF;

  SELECT * INTO v_row
    FROM public.profiles
   WHERE id = p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user role: profile not found';
  END IF;
  IF public._user_management_delete_pending(p_profile_id, true) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user role: account deletion is already in progress';
  END IF;

  IF v_row.role = v_new_role THEN
    RETURN jsonb_build_object(
      'ok', true, 'noop', true, 'id', v_row.id, 'role', v_new_role
    );
  END IF;

  IF p_profile_id = v_caller THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user role: you cannot change your own role';
  END IF;

  IF v_row.role = 'admin'
     AND v_new_role <> 'admin'
     AND public._user_management_effective_admin_count() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user role: cannot remove the last active admin';
  END IF;

  UPDATE public.profiles
     SET role = v_new_role
   WHERE id = p_profile_id;

  v_event := CASE
    WHEN v_new_role = 'inactive' THEN 'profile.deactivated'
    WHEN v_row.role = 'inactive' THEN 'profile.reactivated'
    ELSE 'profile.role_changed'
  END;

  PERFORM public._log_user_management_event(
    v_caller,
    p_profile_id,
    v_event,
    jsonb_build_object(
      'role', jsonb_build_object('from', v_row.role, 'to', v_new_role)
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'id', v_row.id, 'role', v_new_role
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_set_user_program_access(
  p_profile_id    uuid,
  p_program_access text[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := public._require_user_management_mutator();
  v_allowed  text[] := ARRAY['broiler', 'layer', 'pig', 'cattle', 'sheep', 'equipment'];
  v_clean    text[];
  v_row      public.profiles%ROWTYPE;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'program access: profile id required';
  END IF;

  IF p_program_access IS NULL OR cardinality(p_program_access) = 0 THEN
    v_clean := NULL;
  ELSE
    IF EXISTS (
      SELECT 1
        FROM unnest(p_program_access) AS item(value)
       WHERE value IS NULL
          OR lower(btrim(value)) <> ALL(v_allowed)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'program access: invalid program';
    END IF;

    SELECT array_agg(program ORDER BY array_position(v_allowed, program))
      INTO v_clean
      FROM (
        SELECT DISTINCT lower(btrim(value)) AS program
          FROM unnest(p_program_access) AS item(value)
      ) normalized;
  END IF;

  SELECT * INTO v_row
    FROM public.profiles
   WHERE id = p_profile_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'program access: profile not found';
  END IF;
  IF public._user_management_delete_pending(p_profile_id, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'program access: account deletion is already in progress';
  END IF;

  IF v_row.program_access IS NOT DISTINCT FROM v_clean THEN
    RETURN jsonb_build_object(
      'ok', true, 'noop', true, 'id', v_row.id, 'program_access', to_jsonb(v_clean)
    );
  END IF;

  UPDATE public.profiles
     SET program_access = v_clean
   WHERE id = p_profile_id;

  PERFORM public._log_user_management_event(
    v_caller,
    p_profile_id,
    'profile.program_access_changed',
    jsonb_build_object(
      'program_access', jsonb_build_object(
        'from', to_jsonb(v_row.program_access),
        'to', to_jsonb(v_clean)
      )
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'id', v_row.id, 'program_access', to_jsonb(v_clean)
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_prepare_user_delete(
  p_profile_id    uuid,
  p_expected_email text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller            uuid := public._require_user_management_mutator();
  v_row               public.profiles%ROWTYPE;
  v_auth_email        text;
  v_expected          text := lower(btrim(COALESCE(p_expected_email, '')));
  v_blockers          text[];
  v_request_id        uuid;
  v_pending           public.user_management_audit%ROWTYPE;
  v_completed_request public.user_management_audit%ROWTYPE;
  v_profile_found     boolean;
  v_auth_found        boolean;
  v_pending_found     boolean;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user delete: profile id required';
  END IF;
  IF v_expected = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user delete: expected email required';
  END IF;
  IF p_profile_id = v_caller THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user delete: you cannot delete your own account';
  END IF;

  -- _require_user_management_mutator already owns advisory lock 171001 and a
  -- fresh FOR SHARE lock on the caller. Target state is resolved below under
  -- that same serialized transaction.

  SELECT * INTO v_row
    FROM public.profiles
   WHERE id = p_profile_id
   FOR UPDATE;
  v_profile_found := FOUND;

  SELECT lower(email) INTO v_auth_email
    FROM auth.users
   WHERE id = p_profile_id;
  v_auth_found := FOUND;

  -- Resolve an unfinished request before requiring a live target. This is the
  -- recovery path for: prepare committed -> Auth delete succeeded -> Edge
  -- crashed before finalize. Matching target + email prevents an admin from
  -- claiming unrelated missing ids.
  SELECT requested.* INTO v_pending
    FROM public.user_management_audit requested
   WHERE requested.event_type = 'profile.delete_requested'
     AND requested.target_profile_id = p_profile_id
     AND lower(COALESCE(requested.target_email, '')) = v_expected
     AND NOT EXISTS (
       SELECT 1
         FROM public.user_management_audit terminal
        WHERE terminal.request_id = requested.id
          AND terminal.event_type IN ('profile.deleted', 'profile.delete_failed')
     )
   ORDER BY requested.created_at DESC
   LIMIT 1
   FOR UPDATE;
  v_pending_found := FOUND;

  IF NOT v_profile_found AND NOT v_auth_found THEN
    IF v_pending_found THEN
      PERFORM public._log_user_management_event(
        v_caller,
        v_pending.target_profile_id,
        'profile.deleted',
        jsonb_build_object(
          'delete_request_id', v_pending.id,
          'recovered_missing_terminal', true
        ),
        v_pending.id,
        NULL,
        v_pending.target_email,
        v_pending.target_full_name
      );

      RETURN jsonb_build_object(
        'ok', true,
        'already_deleted', true,
        'audit_recovered', true,
        'request_id', v_pending.id,
        'profile_id', p_profile_id,
        'email', v_pending.target_email
      );
    END IF;

    -- A retry after an already-finalized success is also idempotent and does
    -- not append duplicate terminal evidence.
    SELECT requested.* INTO v_completed_request
      FROM public.user_management_audit requested
      JOIN public.user_management_audit terminal
        ON terminal.request_id = requested.id
       AND terminal.event_type = 'profile.deleted'
     WHERE requested.event_type = 'profile.delete_requested'
       AND requested.target_profile_id = p_profile_id
       AND lower(COALESCE(requested.target_email, '')) = v_expected
     ORDER BY terminal.created_at DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'ok', true,
        'already_deleted', true,
        'audit_recovered', false,
        'request_id', v_completed_request.id,
        'profile_id', p_profile_id,
        'email', v_completed_request.target_email
      );
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user delete: profile and auth account are missing with no recoverable request';
  END IF;

  IF v_profile_found IS DISTINCT FROM v_auth_found THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user delete: auth/profile split-brain state requires repair';
  END IF;

  IF lower(COALESCE(v_row.email, '')) <> v_expected THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user delete: email no longer matches; reload users and try again';
  END IF;

  IF v_auth_email IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user delete: auth/profile email mismatch; reload users and contact support';
  END IF;

  -- A recent request may still be between preflight and Auth deletion; do not
  -- race it. A stale request with both profile and auth rows still present is
  -- proof that no irreversible delete landed, so close it as failed and return
  -- a structured retry signal. Edge runs the fresh preflight as a second RPC,
  -- keeping stale recovery committed even if new last-admin/FK checks fail.
  IF v_pending_found THEN
    IF v_pending.created_at > now() - interval '5 minutes' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'user delete: account deletion is already in progress; wait five minutes before retrying';
    END IF;

    PERFORM public._log_user_management_event(
      v_caller,
      v_pending.target_profile_id,
      'profile.delete_failed',
      jsonb_build_object('delete_request_id', v_pending.id, 'recovered_as_stale', true),
      v_pending.id,
      'Stale delete request recovered before Auth deletion',
      v_pending.target_email,
      v_pending.target_full_name
    );

    -- Commit stale-request recovery before any fresh last-admin/FK validation.
    -- rapid-processor performs one new prepare call after this structured
    -- result; a later blocker cannot roll this terminal row back.
    RETURN jsonb_build_object(
      'ok', true,
      'retry_required', true,
      'recovered_stale_request', true,
      'recovered_request_id', v_pending.id,
      'profile_id', v_row.id,
      'email', v_row.email
    );
  END IF;

  -- Do not mutate/delete an admin who is currently responsible for finishing
  -- a different account deletion. This keeps the original bearer able to
  -- append the terminal audit row.
  IF public._user_management_delete_pending(p_profile_id, true) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user delete: account deletion is already in progress';
  END IF;

  IF v_row.role = 'admin'
     AND public._user_management_effective_admin_count() <= 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user delete: cannot delete the last active admin';
  END IF;

  v_blockers := public._user_profile_delete_blockers(p_profile_id);
  IF cardinality(v_blockers) > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'user delete: account has retained farm records; deactivate it instead',
      DETAIL = array_to_string(v_blockers, ', ');
  END IF;

  v_request_id := public._log_user_management_event(
    v_caller,
    p_profile_id,
    'profile.delete_requested',
    jsonb_build_object('role', v_row.role),
    NULL,
    NULL,
    v_row.email,
    v_row.full_name
  );

  RETURN jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'profile_id', v_row.id,
    'email', v_row.email,
    'recovered_stale_request', false
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_finalize_user_delete(
  p_request_id   uuid,
  p_succeeded    boolean,
  p_error_message text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller   uuid := public._require_user_management_admin();
  v_request  public.user_management_audit%ROWTYPE;
  v_existing public.user_management_audit%ROWTYPE;
  v_event    text;
  v_id       uuid;
  v_profile_exists boolean;
  v_auth_exists    boolean;
  v_ambiguous_recovery boolean := false;
BEGIN
  -- Finalization is serialized and revalidates the caller after any lock wait,
  -- but intentionally permits a pending caller so the original request actor
  -- can append its terminal row.
  v_caller := public._lock_user_management_admin(v_caller, true);

  IF p_request_id IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user delete finalize: request and outcome required';
  END IF;

  SELECT * INTO v_request
    FROM public.user_management_audit
   WHERE id = p_request_id
     AND event_type = 'profile.delete_requested'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user delete finalize: request not found';
  END IF;
  IF v_request.actor_profile_id <> v_caller THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'user delete finalize: request belongs to another admin';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = v_request.target_profile_id
  ) INTO v_profile_exists;
  SELECT EXISTS (
    SELECT 1 FROM auth.users WHERE id = v_request.target_profile_id
  ) INTO v_auth_exists;

  IF v_profile_exists IS DISTINCT FROM v_auth_exists THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'user delete finalize: auth/profile split-brain state requires repair';
  END IF;

  IF p_succeeded THEN
    IF v_profile_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'user delete finalize: account still exists after reported success';
    END IF;
    v_event := 'profile.deleted';
  ELSIF NOT v_profile_exists THEN
    -- Auth APIs can return an ambiguous transport error after the remote delete
    -- committed. Both rows absent is authoritative success; preserve the error
    -- context in changes but never write a false delete_failed terminal.
    v_event := 'profile.deleted';
    v_ambiguous_recovery := true;
  ELSE
    v_event := 'profile.delete_failed';
  END IF;

  SELECT * INTO v_existing
    FROM public.user_management_audit
   WHERE request_id = p_request_id
     AND event_type IN ('profile.deleted', 'profile.delete_failed');
  IF FOUND THEN
    IF v_existing.event_type <> v_event THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'user delete finalize: request already has a different outcome';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'noop', true, 'event_id', v_existing.id, 'event_type', v_existing.event_type
    );
  END IF;

  v_id := public._log_user_management_event(
    v_caller,
    v_request.target_profile_id,
    v_event,
    jsonb_build_object(
      'delete_request_id', p_request_id,
      'reported_succeeded', p_succeeded,
      'recovered_ambiguous_auth_error', v_ambiguous_recovery,
      'reported_error', CASE
        WHEN v_ambiguous_recovery THEN left(COALESCE(p_error_message, ''), 1000)
        ELSE NULL
      END
    ),
    p_request_id,
    CASE
      WHEN v_event = 'profile.delete_failed'
        THEN COALESCE(NULLIF(btrim(p_error_message), ''), 'Auth delete failed')
      ELSE NULL
    END,
    v_request.target_email,
    v_request.target_full_name
  );

  RETURN jsonb_build_object(
    'ok', true, 'event_id', v_id, 'event_type', v_event
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_set_user_name(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_user_role(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_user_program_access(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_prepare_user_delete(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_finalize_user_delete(uuid, boolean, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_set_user_name(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_user_program_access(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_prepare_user_delete(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finalize_user_delete(uuid, boolean, text) TO authenticated;

-- Runtime inventory before this migration: UsersModal was the only browser
-- owner of profiles INSERT/UPDATE/DELETE; main.jsx owns two SELECT paths.
-- rapid-processor user_create uses service_role and is intentionally unaffected.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 171_audited_user_management.sql
-- ============================================================================
