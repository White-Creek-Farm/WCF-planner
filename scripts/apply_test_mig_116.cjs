// Apply mig 116 (Pasture Map CP1: pasture_import_batches + land_areas +
// land_area_geometry_versions, 6 SECDEF RPCs, PostGIS in the extensions schema)
// to TEST via exec_sql. Hard PROD-ref guard. exec_sql carries no auth context,
// so the RPCs (which gate on auth.uid()/profile_role()) are proven structurally
// (SECDEF + authenticated-only EXECUTE); DB-level behavior (PostGIS resolution,
// geodesic acres, unclassified default, version append, validity gate) is proven
// with DO blocks that RAISE on a wrong state, then clean up.
//
// .env.test lives only in the MAIN worktree (gitignored); load it from the
// sibling WCF-planner dir, then any local copy in this worktree.
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
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
loadDotEnv(path.join(__dirname, '..', '.env.test'));
loadDotEnv(path.join(__dirname, '..', '.env.test.local'));

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !key) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}
const file = path.join(__dirname, '..', 'supabase-migrations', '116_pasture_map_land_areas.sql');
const body = fs.readFileSync(file, 'utf8');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 116 body (${body.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');

  const SQUARE =
    '{"type":"Polygon","coordinates":[[[-86.44,30.84],[-86.43,30.84],[-86.43,30.85],[-86.44,30.85],[-86.44,30.84]]]}';
  const BOWTIE = '{"type":"Polygon","coordinates":[[[0,0],[1,1],[1,0],[0,1],[0,0]]]}';

  const smokes = [
    {
      label: 'postgis extension installed',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='postgis')
        THEN RAISE EXCEPTION 'postgis extension not installed'; END IF;
      END $$;`,
    },
    {
      label: 'three tables exist, RLS enabled, no anon/authenticated grants',
      sql: `DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['land_areas','land_area_geometry_versions','pasture_import_batches'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                          WHERE n.nspname='public' AND c.relname=t AND c.relrowsecurity)
          THEN RAISE EXCEPTION '% missing or RLS off', t; END IF;
        END LOOP;
        IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE table_schema='public'
                          AND table_name IN ('land_areas','land_area_geometry_versions','pasture_import_batches')
                          AND grantee IN ('anon','authenticated'))
        THEN RAISE EXCEPTION 'unexpected direct table grants on land tables'; END IF;
      END $$;`,
    },
    {
      label: 'five client RPCs are SECURITY DEFINER, authenticated-only EXECUTE',
      sql: `DO $$ DECLARE fn text; BEGIN
        FOREACH fn IN ARRAY ARRAY['import_land_area_batch','list_land_areas','update_land_area',
                                  'close_land_area_outline','delete_land_area'] LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                          WHERE n.nspname='public' AND p.proname=fn AND p.prosecdef)
          THEN RAISE EXCEPTION '% missing or not SECURITY DEFINER', fn; END IF;
          IF NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
                          WHERE routine_schema='public' AND routine_name=fn
                                AND grantee='authenticated' AND privilege_type='EXECUTE')
          THEN RAISE EXCEPTION '% missing authenticated EXECUTE', fn; END IF;
          IF EXISTS (SELECT 1 FROM information_schema.routine_privileges
                      WHERE routine_schema='public' AND routine_name=fn AND grantee IN ('anon','PUBLIC'))
          THEN RAISE EXCEPTION '% leaks EXECUTE to anon/PUBLIC', fn; END IF;
        END LOOP;
      END $$;`,
    },
    {
      label: "land_areas.kind CHECK includes 'unclassified'",
      sql: `DO $$ DECLARE def text; BEGIN
        SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
         WHERE conrelid='public.land_areas'::regclass AND contype='c'
               AND pg_get_constraintdef(oid) LIKE '%kind%';
        IF def IS NULL OR def NOT LIKE '%unclassified%'
        THEN RAISE EXCEPTION 'land_areas.kind CHECK missing unclassified: %', COALESCE(def,'(none)'); END IF;
      END $$;`,
    },
    {
      label: 'geodesic acres helper returns a sane positive number for a ~1km square',
      sql: `DO $$ DECLARE a numeric; BEGIN
        a := public._land_area_acres(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE}'), 4326));
        IF a IS NULL OR a < 100 OR a > 500
        THEN RAISE EXCEPTION 'unexpected acres for 1km square: %', a; END IF;
      END $$;`,
    },
    {
      label: 'self-intersecting polygon is detected invalid (no auto-fix)',
      sql: `DO $$ BEGIN
        IF extensions.ST_IsValid(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${BOWTIE}'), 4326))
        THEN RAISE EXCEPTION 'bowtie polygon reported valid'; END IF;
      END $$;`,
    },
    {
      label:
        'behavioral: new land_area defaults to unclassified+baseline; add_version writes a version + acres + valid',
      sql: `DO $$
      DECLARE v_profile uuid; v_kind text; v_base boolean; v_ver int; v_acres numeric; v_gstatus text;
      BEGIN
        SELECT id INTO v_profile FROM public.profiles LIMIT 1;

        DELETE FROM public.land_areas WHERE id = 'mig116-smoke-area';
        INSERT INTO public.land_areas (id, name, created_by)
        VALUES ('mig116-smoke-area', 'mig116 smoke', v_profile);

        SELECT kind, baseline_no_history INTO v_kind, v_base
          FROM public.land_areas WHERE id = 'mig116-smoke-area';
        IF v_kind <> 'unclassified' THEN RAISE EXCEPTION 'default kind not unclassified: %', v_kind; END IF;
        IF v_base IS NOT TRUE THEN RAISE EXCEPTION 'baseline_no_history default not true'; END IF;

        PERFORM public._land_area_add_version(
          'mig116-smoke-area',
          extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON('${SQUARE}'), 4326),
          'manual', '{}'::jsonb, v_profile);

        SELECT count(*) INTO v_ver FROM public.land_area_geometry_versions
          WHERE land_area_id = 'mig116-smoke-area';
        IF v_ver <> 1 THEN RAISE EXCEPTION 'expected 1 version, got %', v_ver; END IF;

        SELECT computed_acres, geometry_status INTO v_acres, v_gstatus
          FROM public.land_areas WHERE id = 'mig116-smoke-area';
        IF v_acres IS NULL OR v_acres < 100 OR v_acres > 500
        THEN RAISE EXCEPTION 'computed_acres not refreshed sanely: %', v_acres; END IF;
        IF v_gstatus <> 'valid' THEN RAISE EXCEPTION 'geometry_status not valid: %', v_gstatus; END IF;

        DELETE FROM public.land_areas WHERE id = 'mig116-smoke-area';
      END $$;`,
    },
    {
      label: 'behavioral: parent-cycle guard rejects A>B then B>A, allows a non-cyclic parent',
      sql: `DO $$
      DECLARE v_profile uuid; v_cycle boolean; v_ok boolean;
      BEGIN
        SELECT id INTO v_profile FROM public.profiles LIMIT 1;
        DELETE FROM public.land_areas WHERE id IN ('mig116-cyc-a','mig116-cyc-b','mig116-cyc-c');
        -- A is parent of B (A > B): B.parent_id = A.
        INSERT INTO public.land_areas (id, name, created_by) VALUES ('mig116-cyc-a','A',v_profile);
        INSERT INTO public.land_areas (id, name, parent_id, created_by) VALUES ('mig116-cyc-b','B','mig116-cyc-a',v_profile);
        INSERT INTO public.land_areas (id, name, created_by) VALUES ('mig116-cyc-c','C',v_profile);

        -- The exact guard query from update_land_area: would setting
        -- A.parent_id = B (B > A) create a cycle? Walk ancestors UP from B.
        v_cycle := EXISTS (
          WITH RECURSIVE ancestors(id, parent_id, depth) AS (
            SELECT la.id, la.parent_id, 1 FROM public.land_areas la WHERE la.id = 'mig116-cyc-b'
            UNION ALL
            SELECT la.id, la.parent_id, a.depth + 1
              FROM public.land_areas la JOIN ancestors a ON la.id = a.parent_id WHERE a.depth < 1000
          ) SELECT 1 FROM ancestors WHERE id = 'mig116-cyc-a');
        IF NOT v_cycle THEN RAISE EXCEPTION 'cycle guard FAILED to detect B>A cycle'; END IF;

        -- A non-cyclic assignment (A.parent_id = C) must NOT be flagged.
        v_ok := EXISTS (
          WITH RECURSIVE ancestors(id, parent_id, depth) AS (
            SELECT la.id, la.parent_id, 1 FROM public.land_areas la WHERE la.id = 'mig116-cyc-c'
            UNION ALL
            SELECT la.id, la.parent_id, a.depth + 1
              FROM public.land_areas la JOIN ancestors a ON la.id = a.parent_id WHERE a.depth < 1000
          ) SELECT 1 FROM ancestors WHERE id = 'mig116-cyc-a');
        IF v_ok THEN RAISE EXCEPTION 'cycle guard false-positive on a valid parent'; END IF;

        DELETE FROM public.land_areas WHERE id IN ('mig116-cyc-a','mig116-cyc-b','mig116-cyc-c');
      END $$;`,
    },
  ];

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
