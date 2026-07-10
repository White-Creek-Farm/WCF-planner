// Apply mig 174 (template suite v2 — UI simplification) to TEST via exec_sql,
// then verify the Codex-gated contract:
//   1. from a pristine v1 seed (mig 172), all four programs upgrade to ACTIVE
//      v2 templates: broiler 11 fields / cattle,pig,sheep 10; the six retired
//      ids are gone; Customer is a broiler-only SINGLE select sourced from
//      settings.customer_options; v1 rows remain, inactive (never deleted);
//   2. reapplication is a byte-for-byte no-op (idempotent);
//   3. an admin-customized CHECKLIST on default-v1 fields is PRESERVED verbatim
//      through the upgrade;
//   4. an admin-customized FIELDS layout FAILS CLOSED (raise, and — the DO
//      block being atomic — NO program changes, not even uncustomized ones);
//   5. processing_records are never touched (stored field values kept);
//   6. the authed list_processing_templates RPC surfaces the new active v2.
// The TEST table is snapshotted first and restored EXACTLY in finally.
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
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPassword = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !serviceKey || !anonKey || !adminEmail || !adminPassword) {
  console.error('missing TEST env');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

function die(msg) {
  throw new Error(msg);
}
// Canonical (key-sorted) stringify — Postgres jsonb reorders object keys.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canon(v[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

const PROGRAMS = ['broiler', 'cattle', 'pig', 'sheep'];
const RETIRED = ['farm', 'procPlanned', 'actualTOF', 'plannedTOF', 'timeRemaining', 'productPickup'];
const mig172 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '172_processing_template_suite.sql'),
  'utf8',
);
const mig174 = fs.readFileSync(
  path.join(__dirname, '..', 'supabase-migrations', '174_processing_template_suite_v2.sql'),
  'utf8',
);

async function execSql(sql, label) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (error) die(`exec_sql ${label} failed: ` + (error.message || error));
}
async function execSqlExpectError(sql, label, needle) {
  const {error} = await service.rpc('exec_sql', {sql});
  if (!error) die(`exec_sql ${label}: expected a raise, got success`);
  const msg = String(error.message || error);
  if (!msg.includes(needle)) die(`exec_sql ${label}: wrong error: ${msg}`);
  return msg;
}
async function readTemplates() {
  const {data, error} = await service.from('processing_templates').select('*').order('program').order('version');
  if (error) die('read templates failed: ' + error.message);
  return data || [];
}
async function wipeTemplates() {
  const {error} = await service.from('processing_templates').delete().neq('id', '');
  if (error) die('wipe templates failed: ' + error.message);
}
async function seedV1() {
  await wipeTemplates();
  await execSql(mig172, 'reapply 172 (v1 seed)');
}

async function main() {
  // ── snapshots for full restore ─────────────────────────────────────────────
  const originalRows = await readTemplates();
  const {data: recSample, error: recErr} = await service
    .from('processing_records')
    .select('id, fields, customer')
    .order('id')
    .limit(25);
  if (recErr) die('records snapshot failed: ' + recErr.message);
  const recBefore = canon(recSample);
  const {count: recCountBefore} = await service.from('processing_records').select('id', {count: 'exact', head: true});

  try {
    // ── 1. pristine v1 → v2 upgrade ──────────────────────────────────────────
    await seedV1();
    const v1Rows = await readTemplates();
    const v1Checklist = Object.fromEntries(v1Rows.map((r) => [r.program, canon(r.checklist)]));
    await execSql(mig174, 'APPLY 174');
    let rows = await readTemplates();
    for (const p of PROGRAMS) {
      const actives = rows.filter((r) => r.program === p && r.is_active);
      if (actives.length !== 1) die(`${p}: expected exactly 1 active template, got ${actives.length}`);
      const a = actives[0];
      if (a.id !== `ptpl-default-${p}-v2`) die(`${p}: active id ${a.id}`);
      if (a.version !== 2) die(`${p}: active version ${a.version}`);
      const ids = a.fields.map((f) => f.id);
      const expected = p === 'broiler' ? 11 : 10;
      if (ids.length !== expected) die(`${p}: ${ids.length} fields, expected ${expected}`);
      for (const gone of RETIRED) if (ids.includes(gone)) die(`${p}: retired field ${gone} survived`);
      const customer = a.fields.find((f) => f.id === 'customer');
      if (p === 'broiler') {
        if (!customer) die('broiler: customer missing');
        if (customer.type !== 'single') die(`broiler: customer type ${customer.type}`);
        if (customer.optionsSource !== 'settings.customer_options') die('broiler: customer optionsSource wrong');
        if (customer.options) die('broiler: customer must carry no baked options');
      } else if (customer) {
        die(`${p}: customer must be broiler-only`);
      }
      if (canon(a.checklist) !== v1Checklist[p]) die(`${p}: checklist not preserved verbatim`);
      const v1Row = rows.find((r) => r.id === `ptpl-default-${p}`);
      if (!v1Row) die(`${p}: v1 row was deleted`);
      if (v1Row.is_active) die(`${p}: v1 row still active`);
    }
    console.log('CHECK 1 ok — pristine v1 upgraded to active v2 (11/10/10/10, retired ids gone, v1 kept inactive)');

    // ── 2. idempotent reapplication ─────────────────────────────────────────
    const before = canon(rows);
    await execSql(mig174, 'REAPPLY 174 (idempotency)');
    const after = canon(await readTemplates());
    if (before !== after) die('reapplication changed the table');
    console.log('CHECK 2 ok — reapplication is a no-op');

    // ── 3. customized CHECKLIST on default v1 fields is preserved ───────────
    await seedV1();
    const customChecklist = [
      {label: 'Custom step A', assignee: null, assignee_profile_id: null},
      {label: 'Custom step B', assignee: 'Ronnie Jones', assignee_profile_id: null},
    ];
    await execSql(
      `UPDATE public.processing_templates SET checklist = '${JSON.stringify(customChecklist)}'::jsonb
        WHERE program = 'broiler' AND is_active = true;`,
      'customize broiler checklist',
    );
    await execSql(mig174, 'APPLY 174 (checklist preservation)');
    rows = await readTemplates();
    const broilerActive = rows.find((r) => r.program === 'broiler' && r.is_active);
    if (canon(broilerActive.checklist) !== canon(customChecklist)) {
      die('customized checklist was not preserved through the upgrade');
    }
    if (broilerActive.fields.length !== 11) die('checklist-preserve path still upgrades fields');
    console.log('CHECK 3 ok — admin-customized checklist rides into v2 verbatim');

    // ── 4. customized FIELDS fail closed, atomically ─────────────────────────
    await seedV1();
    await execSql(
      `UPDATE public.processing_templates
          SET fields = fields || '[{"id":"fld-custom-kill-sheet","name":"Kill Sheet #","type":"text"}]'::jsonb
        WHERE program = 'pig' AND is_active = true;`,
      'customize pig fields',
    );
    const preRefusal = canon(await readTemplates());
    const msg = await execSqlExpectError(mig174, 'APPLY 174 (must refuse)', 'administrator-customized');
    if (!msg.includes('pig')) die('refusal did not name the customized program: ' + msg);
    const postRefusal = canon(await readTemplates());
    if (preRefusal !== postRefusal) {
      die('fail-closed apply mutated the table (atomicity broken — uncustomized programs must roll back too)');
    }
    console.log('CHECK 4 ok — customized fields refuse the upgrade; DO block rolled back atomically');

    // ── 5. processing_records untouched ──────────────────────────────────────
    const {data: recSampleAfter, error: recErr2} = await service
      .from('processing_records')
      .select('id, fields, customer')
      .order('id')
      .limit(25);
    if (recErr2) die('records re-read failed: ' + recErr2.message);
    const {count: recCountAfter} = await service.from('processing_records').select('id', {count: 'exact', head: true});
    if (canon(recSampleAfter) !== recBefore || recCountAfter !== recCountBefore) {
      die('processing_records changed during the migration runs');
    }
    console.log('CHECK 5 ok — stored record field values untouched');

    // ── 6. authed RPC surfaces the active v2 ─────────────────────────────────
    await seedV1();
    await execSql(mig174, 'APPLY 174 (RPC surface)');
    const {error: signInErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPassword});
    if (signInErr) die('admin sign-in failed: ' + signInErr.message);
    try {
      const {data: tpls, error: listErr} = await authed.rpc('list_processing_templates', {p_program: 'broiler'});
      if (listErr) die('list_processing_templates failed: ' + listErr.message);
      const active = (tpls || []).find((t) => t.is_active);
      if (!active || active.version !== 2 || active.fields.length !== 11) {
        die('authed RPC does not surface the active v2 broiler template');
      }
    } finally {
      await authed.auth.signOut();
    }
    console.log('CHECK 6 ok — list_processing_templates serves the active v2');
  } finally {
    // ── restore the EXACT pre-run TEST state ─────────────────────────────────
    await wipeTemplates();
    if (originalRows.length) {
      const {error: insErr} = await service.from('processing_templates').insert(originalRows);
      if (insErr) {
        console.error('RESTORE FAILED — original rows follow for manual recovery:');
        console.error(JSON.stringify(originalRows));
        // A failed restore is the highest-priority outcome: surface it even if
        // an earlier proof step also failed, because TEST may need recovery.
        // eslint-disable-next-line no-unsafe-finally
        throw new Error('restore failed: ' + insErr.message);
      }
    }
    const restored = await readTemplates();
    if (canon(restored) !== canon(originalRows)) {
      console.error('RESTORE MISMATCH — original rows follow for manual recovery:');
      console.error(JSON.stringify(originalRows));
      // See above: never hide a failed state restore behind a proof failure.
      // eslint-disable-next-line no-unsafe-finally
      throw new Error('restore mismatch');
    }
    console.log(`restore ok — processing_templates back to the pre-run baseline (${originalRows.length} rows)`);
  }
  console.log('ALL CHECKS PASSED');
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
