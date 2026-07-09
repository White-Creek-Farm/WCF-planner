// Apply mig 160 (broiler Time-on-Farm in list/get RPCs) to TEST via exec_sql,
// then behaviorally verify a broiler planner_batch row gets server-derived
// time_on_farm_days = processingDate − hatchDate (whole days) from app_store
// 'ppp-v4'. Temporarily appends ONE synthetic broiler batch to ppp-v4 and ALWAYS
// restores it (try/finally + restore verification). Cleans up the synthetic row.
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

const BATCH = 'TOF-TEST-B-99';
const REC = 'prc-mig160-tof';
const EXPECTED_DAYS = 63; // 2026-01-01 → 2026-03-05 (non-leap): 31 + 28 + 4

// Throw (do NOT process.exit) so the try/finally ppp-v4 restore always runs.
function die(msg) {
  throw new Error(msg);
}

(async () => {
  console.log(`TEST url=${url}`);
  const {data: signIn, error: signErr} = await authed.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signErr) die('admin signIn failed: ' + (signErr.message || signErr));
  const uid = signIn.user.id;

  // Apply the migration.
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '160_processing_broiler_tof.sql'),
    'utf8',
  );
  console.log(`applying 160_processing_broiler_tof.sql (${body.length} bytes)`);
  const {error: applyErr} = await service.rpc('exec_sql', {sql: body});
  if (applyErr) die('exec_sql APPLY failed: ' + (applyErr.message || applyErr));
  await new Promise((r) => setTimeout(r, 2000));

  // Snapshot ppp-v4 so we can restore it verbatim.
  const {data: rows, error: readErr} = await service.from('app_store').select('data').eq('key', 'ppp-v4');
  if (readErr) die('read ppp-v4 failed: ' + (readErr.message || readErr));
  const existed = Array.isArray(rows) && rows.length > 0;
  const original = existed ? rows[0].data : undefined;
  const asString = existed && typeof original === 'string';
  const arr = existed ? (asString ? JSON.parse(original || '[]') : Array.isArray(original) ? original : []) : [];
  const synthetic = {name: BATCH, hatchDate: '2026-01-01', processingDate: '2026-03-05', status: 'processed'};
  const appended = arr.concat([synthetic]);
  const writeVal = asString ? JSON.stringify(appended) : appended;

  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    await service.from('processing_records').delete().eq('id', REC);
    if (existed) {
      await service.from('app_store').update({data: original}).eq('key', 'ppp-v4');
    } else {
      await service.from('app_store').delete().eq('key', 'ppp-v4');
    }
  };

  try {
    if (existed) {
      const {error} = await service.from('app_store').update({data: writeVal}).eq('key', 'ppp-v4');
      if (error) die('ppp-v4 append failed: ' + (error.message || error));
    } else {
      const {error} = await service.from('app_store').insert([{key: 'ppp-v4', data: writeVal}]);
      if (error) die('ppp-v4 insert failed: ' + (error.message || error));
    }

    const {error: recErr} = await service.from('processing_records').insert([
      {
        id: REC,
        record_type: 'planner_batch',
        program: 'broiler',
        title: 'TOF test batch',
        source_kind: 'broiler',
        source_id: BATCH,
        processing_date: '2026-03-05',
        match_status: 'native',
        created_by: uid,
      },
    ]);
    if (recErr) die('record seed failed: ' + (recErr.message || recErr));

    // list_processing_records returns time_on_farm_days per row.
    const {data: listData, error: lErr} = await authed.rpc('list_processing_records', {p_include_archived: false});
    if (lErr) die('list_processing_records failed: ' + (lErr.message || lErr));
    const listRow = (Array.isArray(listData) ? listData : []).find((r) => r.id === REC);
    if (!listRow) die('list: seeded broiler record not found');
    if (Number(listRow.time_on_farm_days) !== EXPECTED_DAYS) {
      die(`list: time_on_farm_days should be ${EXPECTED_DAYS}, got ${listRow.time_on_farm_days}`);
    }
    console.log(`  [ok] list_processing_records → time_on_farm_days = ${listRow.time_on_farm_days} (9w 0d)`);

    // get_processing_record returns it on the record object.
    const {data: getData, error: gErr} = await authed.rpc('get_processing_record', {p_id: REC});
    if (gErr) die('get_processing_record failed: ' + (gErr.message || gErr));
    if (!getData || !getData.record) die('get: record missing');
    if (Number(getData.record.time_on_farm_days) !== EXPECTED_DAYS) {
      die(`get: time_on_farm_days should be ${EXPECTED_DAYS}, got ${getData.record.time_on_farm_days}`);
    }
    console.log(`  [ok] get_processing_record → time_on_farm_days = ${getData.record.time_on_farm_days}`);
  } finally {
    await restore();
  }

  // Verify the restore left ppp-v4 exactly as we found it.
  const {data: after} = await service.from('app_store').select('data').eq('key', 'ppp-v4');
  const afterExisted = Array.isArray(after) && after.length > 0;
  if (existed) {
    if (!afterExisted) die('restore: ppp-v4 row disappeared');
    if (JSON.stringify(after[0].data) !== JSON.stringify(original)) die('restore: ppp-v4 not restored verbatim');
  } else if (afterExisted) {
    die('restore: synthetic ppp-v4 row was not removed');
  }
  console.log('  [ok] ppp-v4 restored verbatim; synthetic row removed');
  console.log('mig160 verify: ALL CHECKS PASSED');
  process.exit(0);
})().catch(async (e) => {
  try {
    await service.from('processing_records').delete().eq('id', REC);
  } catch {
    /* best effort */
  }
  console.error('FAIL (exception):', e && (e.message || e));
  process.exit(1);
});
