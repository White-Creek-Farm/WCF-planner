// Apply mig 112 (Cattle Log: sidecar tables, RPC family, resolver trigger,
// mirror guards, cattle.log activity branches) to TEST via exec_sql. Hard
// PROD-ref guard. exec_sql returns void, so every smoke is a DO $$ block that
// RAISEs on a wrong state. Smokes: tables + RLS + no direct grants; six RPCs
// SECDEF with authenticated-only EXECUTE; mirror-guard clause present in the
// re-issued edit_comment/delete_comment; cattle.log branch present in both
// activity gates; resolver trigger present; then a behavioral resolver
// round-trip (seed unresolved link -> insert matching cow -> link + mirror
// created, issue untouched -> cleanup inside the block).
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
const file = path.join(__dirname, '..', 'supabase-migrations', '112_cattle_log.sql');
const body = fs.readFileSync(file, 'utf8');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 112 body (${body.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');

  const smokes = [
    {
      label: 'sidecar tables exist, RLS enabled, no direct anon/authenticated grants',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relname='cattle_log_issue_state' AND c.relrowsecurity)
        THEN RAISE EXCEPTION 'cattle_log_issue_state missing or RLS off'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relname='cattle_log_tag_links' AND c.relrowsecurity)
        THEN RAISE EXCEPTION 'cattle_log_tag_links missing or RLS off'; END IF;
        IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE table_schema='public'
                          AND table_name IN ('cattle_log_issue_state','cattle_log_tag_links')
                          AND grantee IN ('anon','authenticated'))
        THEN RAISE EXCEPTION 'unexpected direct table grants on cattle_log sidecars'; END IF;
      END $$;`,
    },
    {
      label: 'six client RPCs are SECURITY DEFINER with authenticated-only EXECUTE',
      sql: `DO $$ DECLARE fn text; BEGIN
        FOREACH fn IN ARRAY ARRAY['submit_cattle_log_entry','edit_cattle_log_entry','delete_cattle_log_entry',
                                  'set_cattle_log_issue','list_cattle_log_entries','list_cattle_log_mentionable_profiles'] LOOP
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
      label: 'mirror guard present in re-issued edit_comment/delete_comment',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='edit_comment' AND p.prosrc LIKE '%clog-%')
        THEN RAISE EXCEPTION 'edit_comment mirror guard missing'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='delete_comment' AND p.prosrc LIKE '%clog-%')
        THEN RAISE EXCEPTION 'delete_comment mirror guard missing'; END IF;
      END $$;`,
    },
    {
      label: 'cattle.log branch present in _activity_can_read and _activity_can_write',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='_activity_can_read' AND p.prosrc LIKE '%cattle.log%')
        THEN RAISE EXCEPTION '_activity_can_read lacks cattle.log branch'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='_activity_can_write' AND p.prosrc LIKE '%cattle.log%')
        THEN RAISE EXCEPTION '_activity_can_write lacks cattle.log branch'; END IF;
      END $$;`,
    },
    {
      label: 'resolver trigger present on cattle',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                        WHERE c.relname='cattle' AND NOT t.tgisinternal AND t.tgname LIKE '%cattle_log%')
        THEN RAISE EXCEPTION 'cattle_log resolver trigger missing on cattle'; END IF;
      END $$;`,
    },
    {
      label: 'behavioral: resolver links + mirrors an unresolved tag on cow insert (with cleanup)',
      sql: `DO $$
      DECLARE v_link public.cattle_log_tag_links%ROWTYPE;
      BEGIN
        -- defensive cleanup of any prior smoke leftovers
        DELETE FROM public.comments WHERE id LIKE 'clog-mig112smoke--%';
        DELETE FROM public.comments WHERE id = 'mig112smoke';
        DELETE FROM public.cattle WHERE id = 'mig112-smoke-cow';

        INSERT INTO public.comments (id, entity_type, entity_id, body)
        VALUES ('mig112smoke', 'cattle.log', 'cattle-log', 'mig112 smoke #99887');
        INSERT INTO public.cattle_log_issue_state (comment_id) VALUES ('mig112smoke');
        INSERT INTO public.cattle_log_tag_links (id, comment_id, tag)
        VALUES ('mig112smoke-link', 'mig112smoke', '99887');

        INSERT INTO public.cattle (id, tag, herd, sex, old_tags)
        VALUES ('mig112-smoke-cow', '99887', 'mommas', 'cow', '[]'::jsonb);

        SELECT * INTO v_link FROM public.cattle_log_tag_links WHERE id = 'mig112smoke-link';
        IF v_link.cattle_id IS DISTINCT FROM 'mig112-smoke-cow'
        THEN RAISE EXCEPTION 'resolver did not link cow (cattle_id=%)', v_link.cattle_id; END IF;
        IF v_link.mirror_comment_id IS NULL
        THEN RAISE EXCEPTION 'resolver did not create a mirror'; END IF;
        IF NOT EXISTS (SELECT 1 FROM public.comments
                        WHERE id = v_link.mirror_comment_id AND entity_type='cattle.animal'
                              AND entity_id='mig112-smoke-cow' AND body='mig112 smoke #99887')
        THEN RAISE EXCEPTION 'mirror comment missing or wrong shape'; END IF;
        IF NOT EXISTS (SELECT 1 FROM public.cattle_log_issue_state
                        WHERE comment_id='mig112smoke' AND is_issue)
        THEN RAISE EXCEPTION 'resolver touched the issue flag'; END IF;

        -- cleanup (issue_state + tag_links cascade off the comments delete)
        DELETE FROM public.comments WHERE id = v_link.mirror_comment_id;
        DELETE FROM public.comments WHERE id = 'mig112smoke';
        DELETE FROM public.cattle WHERE id = 'mig112-smoke-cow';
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
