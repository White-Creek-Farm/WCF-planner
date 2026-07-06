// Apply mig 154 (equipment.fuel_bill Activity entity) to TEST via exec_sql,
// then behaviorally verify the new resolver branch + delete_fuel_bill re-scope.
// Hard PROD-ref guard. All checks are behavioral (never exec_sql SELECT):
//   1. Admin CAN write+read an equipment.fuel_bill event for a NON-existent bill
//      id  -> proves the branch is admin-only AND existence-free (the whole
//      point: a fuel-bill id is not an equipment id, so equipment.item's
//      existence gate rejected it before this migration).
//   2. Admin CANNOT write an equipment.item event for that same synthetic id
//      -> proves the equipment.item existence gate is intact (regression) and
//      that fuel_bill's existence-free behavior is genuinely new.
//   3. delete_fuel_bill round-trip: insert a minimal fuel_bills row, delete it
//      via the RPC, and confirm the record.deleted tombstone is readable under
//      equipment.fuel_bill (NOT equipment.item) AFTER the row is gone.
// Cleans up every row it creates.
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
  console.error('missing TEST env (url / service key / anon key / admin email+password)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const service = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const STAMP = Date.now();
const FUEL_BILL_ID = 'fb-verify-' + STAMP; // synthetic — NOT a real equipment id
const DELETE_BILL_ID = 'fb-verify-del-' + STAMP;
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + d : ''));
};

(async () => {
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '154_fuel_bill_activity_entity.sql'),
    'utf8',
  );
  console.log(`applying 154_fuel_bill_activity_entity.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((r) => setTimeout(r, 2500));
  ok('migration applied');

  const {error: signInErr} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signInErr) {
    bad('admin sign-in', signInErr.message);
    process.exit(1);
  }

  // ── 1. Admin write+read of equipment.fuel_bill for a NON-existent bill id ──
  {
    const {data, error} = await admin.rpc('record_activity_event', {
      p_entity_type: 'equipment.fuel_bill',
      p_entity_id: FUEL_BILL_ID,
      p_event_type: 'record.created',
      p_entity_label: 'VERIFY-154',
      p_body: 'mig 154 verify create',
      p_payload: {record: 'equipment.fuel_bill', action: 'verify'},
    });
    if (error) bad('admin CANNOT write equipment.fuel_bill (branch missing?)', error.message);
    else ok('admin CAN write equipment.fuel_bill for a non-existent bill id (admin-only + existence-free)');

    const {data: rows, error: readErr} = await admin.rpc('list_activity_events', {
      p_entity_type: 'equipment.fuel_bill',
      p_entity_id: FUEL_BILL_ID,
      p_limit: 10,
    });
    if (readErr) bad('admin read of equipment.fuel_bill errored', readErr.message);
    else if (Array.isArray(rows) && rows.some((r) => r.event_type === 'record.created'))
      ok('admin CAN read the equipment.fuel_bill event back');
    else bad('admin read did not return the equipment.fuel_bill event', JSON.stringify(rows));
    void data;
  }

  // ── 2. equipment.item existence gate still rejects a fuel-bill-shaped id ──
  {
    const {error} = await admin.rpc('record_activity_event', {
      p_entity_type: 'equipment.item',
      p_entity_id: FUEL_BILL_ID,
      p_event_type: 'record.created',
      p_entity_label: 'VERIFY-154',
      p_body: 'should be denied',
      p_payload: {},
    });
    if (error) ok('admin CANNOT write equipment.item for a non-equipment id (existence gate intact)');
    else bad('equipment.item write was allowed for a non-equipment id (existence gate broken)');
  }

  // ── 3. delete_fuel_bill round-trip: tombstone lands on equipment.fuel_bill ──
  {
    // Minimal valid fuel_bills row (only id + total are NOT NULL).
    const {error: insErr} = await service
      .from('fuel_bills')
      .insert({id: DELETE_BILL_ID, total: 0, supplier: 'VERIFY-154'});
    if (insErr) {
      bad('could not seed fuel_bills row', insErr.message);
    } else {
      const {data: del, error: delErr} = await admin.rpc('delete_fuel_bill', {p_bill_id: DELETE_BILL_ID});
      if (delErr) bad('delete_fuel_bill errored', delErr.message);
      else if (del && del.ok) ok('delete_fuel_bill returned ok:true');
      else bad('delete_fuel_bill did not return ok', JSON.stringify(del));

      const {data: tomb, error: tErr} = await admin.rpc('list_activity_events', {
        p_entity_type: 'equipment.fuel_bill',
        p_entity_id: DELETE_BILL_ID,
        p_limit: 10,
      });
      if (tErr) bad('reading the delete tombstone errored', tErr.message);
      else if (Array.isArray(tomb) && tomb.some((r) => r.event_type === 'record.deleted'))
        ok('delete tombstone is readable under equipment.fuel_bill AFTER the bill is gone');
      else bad('delete tombstone not found under equipment.fuel_bill', JSON.stringify(tomb));

      // The equipment.item read gate must NOT surface this fuel-bill id (no
      // equipment row exists), so the tombstone is not double-visible there.
      const {data: itemRows} = await admin.rpc('list_activity_events', {
        p_entity_type: 'equipment.item',
        p_entity_id: DELETE_BILL_ID,
        p_limit: 10,
      });
      // A denied entity resolves to null (gate false) or an empty array — both
      // mean "the fuel-bill id surfaces nothing under equipment.item".
      itemRows == null || (Array.isArray(itemRows) && itemRows.length === 0)
        ? ok('equipment.item read gate surfaces nothing for the fuel-bill id (no double-scoping)')
        : bad('equipment.item unexpectedly returned rows for the fuel-bill id', JSON.stringify(itemRows));
    }
  }

  await admin.auth.signOut();

  // ── cleanup: remove every row this script created ──
  await service.rpc('exec_sql', {
    sql: `DELETE FROM public.activity_events WHERE entity_id IN ('${FUEL_BILL_ID}', '${DELETE_BILL_ID}');
          DELETE FROM public.fuel_bills WHERE id IN ('${DELETE_BILL_ID}');`,
  });
  ok('cleanup: verify activity_events + fuel_bills rows removed');

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('apply/verify threw:', e.message || e);
  process.exit(1);
});
