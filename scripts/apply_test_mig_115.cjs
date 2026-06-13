// Apply mig 115 (To Do List: todo_items + todo_item_photos tables, 5-total
// photo cap trigger, ten-RPC SECDEF family, todo notification types,
// todo.item activity branches, task_summary_runs.total_todo_items) to TEST
// via exec_sql. Hard PROD-ref guard. exec_sql returns void, so every smoke is
// a DO $$ block that RAISEs on a wrong state. Smokes: tables + RLS + no
// direct grants; ten RPCs SECDEF with authenticated-only EXECUTE; cap trigger
// present; notifications CHECK carries the three todo types; todo.item branch
// present in _activity_can_read AND the mig 112 cattle.log branches survived
// the re-issue; total_todo_items column present; then a behavioral cap
// round-trip (seed item -> 5 photos ok -> 6th raises -> cleanup inside the
// block).
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
const file = path.join(__dirname, '..', 'supabase-migrations', '115_todo_items.sql');
const body = fs.readFileSync(file, 'utf8');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 115 body (${body.length} bytes)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');

  const smokes = [
    {
      label: 'todo tables exist, RLS enabled, no direct anon/authenticated grants',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relname='todo_items' AND c.relrowsecurity)
        THEN RAISE EXCEPTION 'todo_items missing or RLS off'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                        WHERE n.nspname='public' AND c.relname='todo_item_photos' AND c.relrowsecurity)
        THEN RAISE EXCEPTION 'todo_item_photos missing or RLS off'; END IF;
        IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
                    WHERE table_schema='public'
                          AND table_name IN ('todo_items','todo_item_photos')
                          AND grantee IN ('anon','authenticated'))
        THEN RAISE EXCEPTION 'unexpected direct table grants on todo tables'; END IF;
      END $$;`,
    },
    {
      label: 'ten client RPCs are SECURITY DEFINER with authenticated-only EXECUTE',
      sql: `DO $$ DECLARE fn text; BEGIN
        FOREACH fn IN ARRAY ARRAY['create_todo_item','list_todo_items','update_todo_item',
                                  'submit_todo_completion','approve_todo_completion','reject_todo_completion',
                                  'reorder_todo_items','move_todo_item','convert_todo_item','remove_todo_item'] LOOP
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
      label: 'photo cap trigger present on todo_item_photos',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
                        WHERE c.relname='todo_item_photos' AND NOT t.tgisinternal
                              AND t.tgname='todo_item_photos_max_5_total')
        THEN RAISE EXCEPTION 'todo_item_photos_max_5_total trigger missing'; END IF;
      END $$;`,
    },
    {
      label: 'notifications_type_check includes the three todo types and the legacy three',
      sql: `DO $$ DECLARE def text; BEGIN
        SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
         WHERE conname='notifications_type_check' AND conrelid='public.notifications'::regclass;
        IF def IS NULL THEN RAISE EXCEPTION 'notifications_type_check missing'; END IF;
        IF def NOT LIKE '%todo_completion_approved%' OR def NOT LIKE '%todo_completion_rejected%'
           OR def NOT LIKE '%todo_converted%' OR def NOT LIKE '%task_completed%'
           OR def NOT LIKE '%comment_mention%'
        THEN RAISE EXCEPTION 'notifications_type_check wrong shape: %', def; END IF;
      END $$;`,
    },
    {
      label: 'todo.item branch present in _activity_can_read; cattle.log branches survived in both gates',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='_activity_can_read' AND p.prosrc LIKE '%todo.item%')
        THEN RAISE EXCEPTION '_activity_can_read lacks todo.item branch'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='_activity_can_read' AND p.prosrc LIKE '%cattle.log%')
        THEN RAISE EXCEPTION '_activity_can_read LOST the cattle.log branch'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='_activity_can_write' AND p.prosrc LIKE '%cattle.log%')
        THEN RAISE EXCEPTION '_activity_can_write LOST the cattle.log branch'; END IF;
      END $$;`,
    },
    {
      label: 'task_summary_runs.total_todo_items column present',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='task_summary_runs'
                              AND column_name='total_todo_items')
        THEN RAISE EXCEPTION 'task_summary_runs.total_todo_items missing'; END IF;
      END $$;`,
    },
    {
      label: 'list_todo_mentionable_profiles is SECDEF, authenticated-only, participant-scoped',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='list_todo_mentionable_profiles' AND p.prosecdef
                              AND p.prosrc LIKE '%light%farm_team%management%admin%')
        THEN RAISE EXCEPTION 'list_todo_mentionable_profiles missing/not SECDEF/not role-scoped'; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.routine_privileges
                        WHERE routine_schema='public' AND routine_name='list_todo_mentionable_profiles'
                              AND grantee='authenticated' AND privilege_type='EXECUTE')
        THEN RAISE EXCEPTION 'list_todo_mentionable_profiles missing authenticated EXECUTE'; END IF;
        IF EXISTS (SELECT 1 FROM information_schema.routine_privileges
                    WHERE routine_schema='public' AND routine_name='list_todo_mentionable_profiles'
                          AND grantee IN ('anon','PUBLIC'))
        THEN RAISE EXCEPTION 'list_todo_mentionable_profiles leaks EXECUTE to anon/PUBLIC'; END IF;
      END $$;`,
    },
    {
      label: 'post_comment + edit_comment carry the todo.item participant mention guard',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='post_comment'
                              AND p.prosrc LIKE '%is not a To Do participant%')
        THEN RAISE EXCEPTION 'post_comment lacks todo.item participant mention guard'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='edit_comment'
                              AND p.prosrc LIKE '%is not a To Do participant%')
        THEN RAISE EXCEPTION 'edit_comment lacks todo.item participant mention guard'; END IF;
      END $$;`,
    },
    {
      label: 'edit_comment re-issue preserved the mig 112 cattle.log guards',
      sql: `DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='edit_comment' AND p.prosrc LIKE '%clog-%')
        THEN RAISE EXCEPTION 'edit_comment LOST the cattle.log mirror guard'; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                        WHERE n.nspname='public' AND p.proname='edit_comment'
                              AND p.prosrc LIKE '%cattle log entries are managed by the Cattle Log RPCs%')
        THEN RAISE EXCEPTION 'edit_comment LOST the cattle.log originals guard'; END IF;
      END $$;`,
    },
    {
      label: 'list_todo_mentionable_profiles role filter excludes equipment_tech/inactive in its query',
      sql: `DO $$ BEGIN
        -- The function body selects only the four participant roles; assert
        -- it does NOT name equipment_tech (a behavioral authed proof of the
        -- picker + post_comment rejection lives in the Playwright suite).
        IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                    WHERE n.nspname='public' AND p.proname='list_todo_mentionable_profiles'
                          AND p.prosrc LIKE '%equipment_tech%')
        THEN RAISE EXCEPTION 'list_todo_mentionable_profiles unexpectedly references equipment_tech'; END IF;
      END $$;`,
    },
    {
      label: 'behavioral: 5-total photo cap raises on the 6th photo (with cleanup)',
      sql: `DO $$
      DECLARE v_profile uuid;
      BEGIN
        SELECT id INTO v_profile FROM public.profiles LIMIT 1;
        IF v_profile IS NULL THEN RAISE EXCEPTION 'no profile available for smoke'; END IF;

        DELETE FROM public.todo_items WHERE id = 'mig115-smoke-item';
        INSERT INTO public.todo_items (id, title, section, created_by)
        VALUES ('mig115-smoke-item', 'mig115 smoke', 'general', v_profile);

        INSERT INTO public.todo_item_photos (id, todo_id, kind, storage_path, sort_order) VALUES
          ('mig115-p1','mig115-smoke-item','origination','task-photos/todo/mig115-smoke-item/origination-1.jpg',0),
          ('mig115-p2','mig115-smoke-item','origination','task-photos/todo/mig115-smoke-item/origination-2.jpg',1),
          ('mig115-p3','mig115-smoke-item','origination','task-photos/todo/mig115-smoke-item/origination-3.jpg',2),
          ('mig115-p4','mig115-smoke-item','completion','task-photos/todo/mig115-smoke-item/completion-1.jpg',0),
          ('mig115-p5','mig115-smoke-item','completion','task-photos/todo/mig115-smoke-item/completion-2.jpg',1);

        BEGIN
          INSERT INTO public.todo_item_photos (id, todo_id, kind, storage_path, sort_order) VALUES
            ('mig115-p6','mig115-smoke-item','completion','task-photos/todo/mig115-smoke-item/completion-3.jpg',2);
          RAISE EXCEPTION 'sixth photo was accepted; cap trigger not enforcing';
        EXCEPTION WHEN others THEN
          IF SQLERRM NOT LIKE '%max 5 photos per to do item%' THEN
            RAISE;
          END IF;
        END;

        DELETE FROM public.todo_items WHERE id = 'mig115-smoke-item';
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
