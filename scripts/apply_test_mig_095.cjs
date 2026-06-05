// Apply mig 095 (app_saved_views) to TEST via exec_sql. The migration is
// BEGIN/COMMIT-free and idempotent, so no transaction-wrapper stripping is
// needed. Hard PROD-ref guard. Smokes the new table + RLS objects after apply.
const fs = require('fs');
const path = require('path');
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !key) {
  console.error('missing TEST env');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}
const file = path.join(__dirname, '..', 'supabase-migrations', '095_app_saved_views.sql');
const body = fs.readFileSync(file, 'utf8');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});
(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 095 body (${body.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');
  // Smoke: exec_sql returns void, so assertions must RAISE to surface a wrong
  // state as an error. Each guard throws if the expected shape is missing.
  const smokes = [
    {
      label: 'table exists',
      sql: "DO $$ BEGIN IF to_regclass('public.app_saved_views') IS NULL THEN RAISE EXCEPTION 'table missing'; END IF; END $$;",
    },
    {
      label: 'rls enabled',
      sql: "DO $$ BEGIN IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.app_saved_views'::regclass) THEN RAISE EXCEPTION 'rls disabled'; END IF; END $$;",
    },
    {
      label: '4 policies',
      sql: "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM pg_policies WHERE schemaname='public' AND tablename='app_saved_views'; IF n <> 4 THEN RAISE EXCEPTION 'expected 4 policies, got %', n; END IF; END $$;",
    },
    {
      label: '2 triggers',
      sql: "DO $$ DECLARE n int; BEGIN SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid='public.app_saved_views'::regclass AND NOT tgisinternal; IF n <> 2 THEN RAISE EXCEPTION 'expected 2 triggers, got %', n; END IF; END $$;",
    },
  ];
  // Round-trip behavior is verified via an auth-claim-simulated DO block:
  // owner-stamp = auth.uid(), CHECK rejects bad visibility, owner freezes on
  // update. A plain service-role insert can't be used because the owner trigger
  // forces owner_profile_id = auth.uid() (NULL under service role -> NOT NULL
  // violation, by design — only authenticated users own views).
  smokes.push({
    label: 'round-trip (owner-stamp/CHECK/owner-freeze)',
    sql: `DO $$
DECLARE v_pid uuid; v_id uuid; v_owner uuid;
BEGIN
  SELECT id INTO v_pid FROM public.profiles LIMIT 1;
  IF v_pid IS NULL THEN RAISE NOTICE 'no profile to own a view; round-trip skipped'; RETURN; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pid::text)::text, true);
  INSERT INTO public.app_saved_views(surface_key,name,visibility,view_state)
    VALUES('cattle.herds','__mig095_probe__','public','{"viewMode":"flat"}'::jsonb)
    RETURNING id, owner_profile_id INTO v_id, v_owner;
  IF v_owner IS DISTINCT FROM v_pid THEN RAISE EXCEPTION 'owner not stamped to auth.uid()'; END IF;
  BEGIN INSERT INTO public.app_saved_views(surface_key,name,visibility) VALUES('cattle.herds','__bad__','sideways');
    RAISE EXCEPTION 'CHECK did not reject bad visibility'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE public.app_saved_views SET name='b', owner_profile_id=gen_random_uuid() WHERE id=v_id RETURNING owner_profile_id INTO v_owner;
  IF v_owner IS DISTINCT FROM v_pid THEN RAISE EXCEPTION 'owner freeze failed on update'; END IF;
  DELETE FROM public.app_saved_views WHERE id=v_id;
END $$;`,
  });
  let allOk = true;
  for (const s of smokes) {
    const {error: e2} = await sb.rpc('exec_sql', {sql: s.sql});
    if (e2) allOk = false;
    console.log(`  smoke ${s.label}: ${e2 ? 'ERROR ' + (e2.message || e2) : 'OK'}`);
  }
  console.log(allOk ? 'done OK' : 'done WITH ERRORS');
  if (!allOk) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
