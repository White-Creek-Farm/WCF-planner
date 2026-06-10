// Apply mig 093 to TEST via exec_sql. exec_sql rejects BEGIN/COMMIT, so the
// outer transaction wrapper is stripped (093 is fully idempotent: DROP IF
// EXISTS / CREATE OR REPLACE / ADD COLUMN IF NOT EXISTS / unschedule-then-
// schedule). Hard PROD-ref guard. Smokes the new SQL objects after apply.
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
const file = path.join(
  __dirname,
  '..',
  'supabase-migrations',
  '093_tasks_summary_sunday_chicago_completion_digest.sql',
);
let sql = fs.readFileSync(file, 'utf8');
// Strip the transaction-control statements (exec_sql forbids them). Only the
// standalone `BEGIN;` / `COMMIT;` lines match — PL/pgSQL block `BEGIN`/`END`
// keywords inside DO blocks and function bodies have no trailing semicolon on
// their own line, so they are untouched.
const body = sql.replace(/^[ \t]*BEGIN;[ \t]*$/gim, '').replace(/^[ \t]*COMMIT;[ \t]*$/gim, '');
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const sb = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});
(async () => {
  console.log(`TEST url=${url}`);
  console.log(`applying 093 body (${body.length} bytes, BEGIN/COMMIT stripped)`);
  const {error} = await sb.rpc('exec_sql', {sql: body});
  if (error) {
    console.error('exec_sql APPLY failed:', error.message || error);
    process.exit(1);
  }
  console.log('apply OK');
  // Smoke: gate no-op path (today is not Sunday -> RETURN NULL, no http_post)
  // and the window helper math. exec_sql returns void; a SQL error would
  // surface here, so no-error == the new objects parse and execute.
  const smokes = [
    {label: 'invoke_tasks_summary(false,true) gate no-op', sql: 'SELECT public.invoke_tasks_summary(false, true);'},
    {label: 'tasks_summary_window_start()', sql: 'SELECT public.tasks_summary_window_start();'},
    {label: 'probe path still works', sql: 'SELECT public.invoke_tasks_summary(true);'},
  ];
  for (const s of smokes) {
    const {error: e2} = await sb.rpc('exec_sql', {sql: s.sql});
    console.log(`  smoke ${s.label}: ${e2 ? 'ERROR ' + (e2.message || e2) : 'no-error OK'}`);
  }
  console.log('done');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
