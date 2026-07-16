-- ============================================================================
-- 183_user_management_audit_expansion.sql
-- ----------------------------------------------------------------------------
-- Build Queue item 3 decisions (approved 2026-07-16), revised after Codex
-- review:
--
--   1. Account creation joins the immutable ledger. admin_create_user_profile
--      is INSERT-ONLY: rapid-processor's user_create branch has just minted a
--      new Auth account, so the profile row does not yet exist. The RPC binds
--      the profile to that real, email-matched Auth account, inserts the row,
--      and appends profile.created in ONE transaction with the REAL acting
--      admin (caller bearer) as actor. An already-present profile is refused
--      unchanged: this RPC is not a name/role editor and must never relabel a
--      mutation of an established account as "creation". (There is no
--      auth.users -> profiles auto-create trigger in this schema; the only
--      profiles trigger is mig 171's AFTER DELETE audit, so a fresh insert is
--      the correct and only ordinary path.)
--
--   2. Admin-triggered password resets are evidenced with the delete-style
--      request/terminal pattern: admin_log_reset_request appends
--      profile.reset_requested BEFORE any send, and admin_log_reset_outcome
--      appends exactly one profile.reset_send_succeeded / _failed terminal per
--      request. A crash between the two leaves request-without-outcome: an
--      honest unknown, never a false "sent". Public resets are not ledger
--      events (no admin actor; unknown emails have no target profile).
--
--   3. Public forgot-password abuse protection: password_reset_throttle is a
--      service-role-only sliding-window log of ALLOWED reset ATTEMPTS only,
--      keyed by a domain-separated HMAC identifier (email_key). The gate runs
--      before account/config/provider work, so a stored row is a rate-limited
--      allowed attempt; it does not prove an email was sent or that the account
--      exists. The HMAC key is a server-only secret held in the Edge function
--      (SUPABASE_SERVICE_ROLE_KEY); this table never stores a raw email, a
--      dictionary-reversible plain email hash, or a raw IP. Rotating that secret
--      harmlessly resets at most the 2-day throttle window. _password_reset_gate
--      atomically counts + records and returns an allowed verdict; BLOCKED
--      requests insert nothing, so the 100/day global ceiling also bounds
--      retained rows during an attack.
--      Limits: 3/hour + 6/day per email_key, 100/day global.
--
--      IP dimension: the Supabase Edge platform does not expose a
--      provably-spoof-resistant client IP to function code (the number of
--      trusted proxy hops in x-forwarded-for is not guaranteed, so a caller can
--      inject entries). Rather than store or enforce an attacker-controllable
--      identifier as a security identity, the IP dimension is intentionally
--      omitted; enforcement relies on per-email and global limits.
--
-- Re-runnable + reconciling: this file was already TEST-applied in an earlier
-- (email_hash/ip/allowed) shape. It drops the throttle function/table and the
-- prior 2-arg gate signature before recreating them, so a re-apply converges an
-- existing TEST database to the current definition and a fresh PROD apply is a
-- clean create. No BEGIN/COMMIT here: the psql --single-transaction apply owns
-- the transaction boundary.
-- ============================================================================

-- ── 1. Widen the immutable-ledger event vocabulary ─────────────────────────

ALTER TABLE public.user_management_audit
  DROP CONSTRAINT IF EXISTS user_management_audit_event_type_check;

ALTER TABLE public.user_management_audit
  ADD CONSTRAINT user_management_audit_event_type_check CHECK (
    event_type IN (
      'profile.created',
      'profile.name_changed',
      'profile.role_changed',
      'profile.deactivated',
      'profile.reactivated',
      'profile.program_access_changed',
      'profile.delete_requested',
      'profile.deleted',
      'profile.delete_failed',
      'profile.reset_requested',
      'profile.reset_send_succeeded',
      'profile.reset_send_failed'
    )
  );

-- One terminal per reset request, mirroring the delete-terminal uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS user_management_audit_reset_terminal_uq
  ON public.user_management_audit (request_id)
  WHERE request_id IS NOT NULL
    AND event_type IN ('profile.reset_send_succeeded', 'profile.reset_send_failed');

-- ── 2. Audited profile creation (actor = real admin, INSERT-ONLY) ──────────

CREATE OR REPLACE FUNCTION public.admin_create_user_profile(
  p_profile_id    uuid,
  p_email         text,
  p_full_name     text,
  p_role          text,
  p_invite_method text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller     uuid := public._require_user_management_mutator();
  v_email      text := btrim(COALESCE(p_email, ''));
  v_name       text := btrim(COALESCE(p_full_name, ''));
  v_role       text := lower(btrim(COALESCE(p_role, '')));
  v_invite     text := lower(btrim(COALESCE(p_invite_method, '')));
  v_auth_email text;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: profile id required';
  END IF;
  IF v_email = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: email required';
  END IF;
  IF length(v_name) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: use 120 characters or fewer for the name';
  END IF;
  IF v_role NOT IN ('admin', 'management', 'farm_team', 'equipment_tech', 'light') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: invalid assignable role';
  END IF;
  IF v_invite NOT IN ('welcome_email', 'manual_password') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: invalid invite method';
  END IF;

  -- The profile row may only be minted for a real Auth account whose email
  -- matches; this RPC cannot fabricate identities the Auth API never issued.
  SELECT lower(email) INTO v_auth_email
    FROM auth.users
   WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'user create: auth account not found for profile id';
  END IF;
  IF v_auth_email IS DISTINCT FROM lower(v_email) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'user create: auth/profile email mismatch';
  END IF;

  -- INSERT-ONLY. An existing profile is not an ordinary retry of the just-
  -- failed profile-write step; converging one here would let this RPC bypass
  -- the audited name/role mutation RPCs and mislabel an account mutation as
  -- creation. Refuse it unchanged. Established-account repair, if ever needed,
  -- belongs in a separately named, accurately audited recovery RPC.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_profile_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'user create: a profile already exists for this account; do not retry create';
  END IF;

  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (p_profile_id, v_email, v_name, v_role);

  PERFORM public._log_user_management_event(
    v_caller,
    p_profile_id,
    'profile.created',
    jsonb_build_object(
      'role', v_role,
      'invite_method', v_invite
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'id', p_profile_id, 'email', v_email
  );
END
$fn$;

-- ── 3. Admin password-reset request / terminal evidence ────────────────────

CREATE OR REPLACE FUNCTION public.admin_log_reset_request(
  p_profile_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_caller     uuid := public._require_user_management_mutator();
  v_row        public.profiles%ROWTYPE;
  v_request_id uuid;
BEGIN
  IF p_profile_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reset request: profile id required';
  END IF;

  SELECT * INTO v_row
    FROM public.profiles
   WHERE id = p_profile_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reset request: profile not found';
  END IF;

  v_request_id := public._log_user_management_event(
    v_caller,
    p_profile_id,
    'profile.reset_requested',
    '{}'::jsonb,
    NULL,
    NULL,
    v_row.email,
    v_row.full_name
  );

  RETURN jsonb_build_object('ok', true, 'request_id', v_request_id);
END
$fn$;

CREATE OR REPLACE FUNCTION public.admin_log_reset_outcome(
  p_request_id    uuid,
  p_succeeded     boolean,
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
BEGIN
  -- Mirrors admin_finalize_user_delete: serialized, revalidated after any
  -- lock wait, and a pending caller may still append its terminal row.
  v_caller := public._lock_user_management_admin(v_caller, true);

  IF p_request_id IS NULL OR p_succeeded IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'reset outcome: request and outcome required';
  END IF;

  SELECT * INTO v_request
    FROM public.user_management_audit
   WHERE id = p_request_id
     AND event_type = 'profile.reset_requested'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'reset outcome: request not found';
  END IF;
  IF v_request.actor_profile_id <> v_caller THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'reset outcome: request belongs to another admin';
  END IF;

  v_event := CASE WHEN p_succeeded THEN 'profile.reset_send_succeeded' ELSE 'profile.reset_send_failed' END;

  SELECT * INTO v_existing
    FROM public.user_management_audit
   WHERE request_id = p_request_id
     AND event_type IN ('profile.reset_send_succeeded', 'profile.reset_send_failed');
  IF FOUND THEN
    IF v_existing.event_type <> v_event THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'reset outcome: request already has a different outcome';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'noop', true, 'event_id', v_existing.id, 'event_type', v_existing.event_type
    );
  END IF;

  v_id := public._log_user_management_event(
    v_caller,
    v_request.target_profile_id,
    v_event,
    jsonb_build_object('reset_request_id', p_request_id),
    p_request_id,
    CASE
      WHEN p_succeeded THEN NULL
      ELSE COALESCE(NULLIF(btrim(p_error_message), ''), 'Reset email send failed')
    END,
    v_request.target_email,
    v_request.target_full_name
  );

  RETURN jsonb_build_object('ok', true, 'event_id', v_id, 'event_type', v_event);
END
$fn$;

-- ── 4. Public forgot-password throttle (keyed + bounded) ────────────────────

-- Reconcile any earlier (email_hash / ip / allowed) definition before recreate.
DROP FUNCTION IF EXISTS public._password_reset_gate(text, text);
DROP FUNCTION IF EXISTS public._password_reset_gate(text);
DROP TABLE IF EXISTS public.password_reset_throttle;

-- Stores ALLOWED reset ATTEMPTS only (a row is a rate-limited allowed attempt
-- recorded before account/config/provider work, not proof of a send or that an
-- account exists). email_key is a domain-separated HMAC computed in the Edge
-- (never a raw email or a reversible plain hash). No raw IP is stored.
CREATE TABLE public.password_reset_throttle (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_key    text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT password_reset_throttle_email_key_check CHECK (
    length(email_key) BETWEEN 32 AND 128
  )
);

CREATE INDEX password_reset_throttle_email_idx
  ON public.password_reset_throttle (email_key, requested_at DESC);
CREATE INDEX password_reset_throttle_requested_idx
  ON public.password_reset_throttle (requested_at DESC);

ALTER TABLE public.password_reset_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.password_reset_throttle FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.password_reset_throttle TO service_role;

CREATE FUNCTION public._password_reset_gate(
  p_email_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $fn$
DECLARE
  v_key     text := lower(btrim(COALESCE(p_email_key, '')));
  v_allowed boolean := true;
  v_reason  text := NULL;
BEGIN
  -- Serialize gate decisions so concurrent requests cannot both pass a
  -- boundary count. Public resets are rare; contention is negligible.
  PERFORM pg_catalog.pg_advisory_xact_lock(183001);

  -- Opportunistic cleanup keeps the table tiny with no cron dependency.
  DELETE FROM public.password_reset_throttle
   WHERE requested_at < now() - interval '2 days';

  -- Malformed caller input fails closed and is not recorded.
  IF length(v_key) < 32 THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'invalid_key');
  END IF;

  -- Only ALLOWED attempts are stored, so these counts are over allowed reset
  -- attempts and a blocked flood cannot grow the table or extend a real user's
  -- window.
  IF (SELECT count(*) FROM public.password_reset_throttle
       WHERE email_key = v_key
         AND requested_at > now() - interval '1 hour') >= 3 THEN
    v_allowed := false; v_reason := 'email_hourly';
  ELSIF (SELECT count(*) FROM public.password_reset_throttle
          WHERE email_key = v_key
            AND requested_at > now() - interval '1 day') >= 6 THEN
    v_allowed := false; v_reason := 'email_daily';
  ELSIF (SELECT count(*) FROM public.password_reset_throttle
          WHERE requested_at > now() - interval '1 day') >= 100 THEN
    v_allowed := false; v_reason := 'global_daily';
  END IF;

  -- Blocked requests insert NOTHING: the 100/day global ceiling therefore also
  -- bounds retained rows during an attack.
  IF v_allowed THEN
    INSERT INTO public.password_reset_throttle (email_key) VALUES (v_key);
  END IF;

  RETURN jsonb_build_object('allowed', v_allowed, 'reason', v_reason);
END
$fn$;

-- ── 5. Grants ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.admin_create_user_profile(uuid, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_log_reset_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_log_reset_outcome(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user_profile(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_log_reset_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_log_reset_outcome(uuid, boolean, text) TO authenticated;

-- The throttle gate is service-role only: browsers must never observe or
-- influence throttle decisions directly.
REVOKE ALL ON FUNCTION public._password_reset_gate(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._password_reset_gate(text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- End of 183_user_management_audit_expansion.sql
-- ============================================================================
