-- 138_drop_dead_anon_write_policies.sql
-- =====================================================================
-- CANDIDATE MIGRATION — REVIEW ONLY. NOT APPLIED TO PROD.
-- Security lane: DB/RLS legacy write-boundary, Tier 1 (dead anon/public
-- write policies). Mirrors the reasoning of migration 109
-- (drop_daily_photos_anon_insert).
-- =====================================================================
--
-- WHAT THIS DROPS
-- The archive-era policies named "*_anon_*" on cattle_dailys, sheep_dailys,
-- weigh_ins, weigh_in_sessions, and sheep_comments. Despite the name, these
-- policies were created WITHOUT a `TO role` clause, so they are PUBLIC-role
-- permissive policies (they apply to anon AND authenticated).
--
-- WHY THIS IS SAFE (provably dead for anon, redundant for authenticated):
--   1. Single shared authenticated Supabase client: src/lib/supabase.js is the
--      only createClient (locked by supabase_client_owner_static.test.js). There
--      is no anon-only client. This is the same basis migration 109 used.
--   2. Login-gated render: src/main.jsx returns <LoginScreen/> when
--      authState === false BEFORE the view switch that mounts the weigh-in /
--      daily / webform write surfaces (WeighInsWebform, Cattle/SheepDailysView,
--      WeighInSessionPage, bulk imports). No unauthenticated session ever
--      reaches a write to these tables.
--   3. Every authenticated write remains covered by the `*_auth_all` policy
--      (FOR ALL TO authenticated USING (true) WITH CHECK (true)), which this
--      migration does NOT touch. So the signed-in app is unaffected.
--   4. cattle_dailys / sheep_dailys UPDATE+DELETE were already GRANT-revoked
--      from anon+authenticated by migration 092; edits/deletes go through the
--      ownership RPCs. This migration only removes the dead public policies.
--
-- WHAT THIS DOES NOT DO (deferred to Tier 2, separate gated lane):
--   - It does NOT alter the broad `*_auth_all` policies. Constraining
--     "any authenticated user can write any row" to role/owner-scoped RPCs is a
--     larger refactor (load-bearing for delete RPCs 101/103/111 and ~40 direct
--     write call sites) and is designed but NOT implemented here.
--   - It does NOT REVOKE table GRANTs (dropping the permissive policy already
--     denies anon under RLS regardless of GRANT). Optional GRANT tidy-up can
--     follow once live state is confirmed.
--
-- PRE-APPLY VERIFICATION (run read-only against the target DB FIRST):
--   SELECT schemaname, tablename, policyname, roles, cmd
--   FROM pg_policies
--   WHERE tablename IN ('cattle_dailys','sheep_dailys','weigh_ins',
--                       'weigh_in_sessions','sheep_comments')
--   ORDER BY tablename, policyname;
--   -- Confirm the *_anon_* policies exist with roles = {public} and that a
--   -- *_auth_all policy with roles = {authenticated} remains for each table.
--
-- APPLY ORDER: TEST first (psql --single-transaction or exec_sql), run the
-- weigh-in + daily e2e proof, THEN request the Ronnie PROD gate. Idempotent:
-- DROP POLICY IF EXISTS is natively idempotent.
-- =====================================================================

-- cattle_dailys (public INSERT policy; UPDATE/DELETE already revoked by 092)
DROP POLICY IF EXISTS cattle_dailys_anon_insert ON public.cattle_dailys;

-- sheep_dailys (public INSERT + SELECT)
DROP POLICY IF EXISTS sheep_dailys_anon_insert ON public.sheep_dailys;
DROP POLICY IF EXISTS sheep_dailys_anon_select ON public.sheep_dailys;

-- weigh_ins (public INSERT + SELECT + UPDATE)
DROP POLICY IF EXISTS weigh_ins_anon_insert ON public.weigh_ins;
DROP POLICY IF EXISTS weigh_ins_anon_select ON public.weigh_ins;
DROP POLICY IF EXISTS weigh_ins_anon_update ON public.weigh_ins;

-- weigh_in_sessions (public INSERT + UPDATE + SELECT; legacy combined _anon_rw too)
DROP POLICY IF EXISTS weigh_in_sessions_anon_rw ON public.weigh_in_sessions;
DROP POLICY IF EXISTS weigh_in_sessions_anon_insert ON public.weigh_in_sessions;
DROP POLICY IF EXISTS weigh_in_sessions_anon_update ON public.weigh_in_sessions;
DROP POLICY IF EXISTS weigh_in_sessions_anon_select ON public.weigh_in_sessions;

-- sheep_comments (public INSERT + SELECT)
DROP POLICY IF EXISTS sheep_comments_anon_insert ON public.sheep_comments;
DROP POLICY IF EXISTS sheep_comments_anon_select ON public.sheep_comments;

-- Refresh PostgREST (policies don't change the schema cache, but harmless and
-- matches repo convention for RLS-touching migrations).
NOTIFY pgrst, 'reload schema';

-- POST-APPLY VERIFICATION (read-only):
--   SELECT tablename, policyname, roles, cmd FROM pg_policies
--   WHERE tablename IN ('cattle_dailys','sheep_dailys','weigh_ins',
--                       'weigh_in_sessions','sheep_comments')
--   ORDER BY tablename, policyname;
--   -- Expect: no *_anon_* rows remain; each table still has its *_auth_all
--   -- policy (roles = {authenticated}).
-- End of 138_drop_dead_anon_write_policies.sql
