// TEST proof: seed all four programs, run reconcile_planner_to_processing, and
// assert the Planner->Processing enumeration + anti-duplicate + N-Asana->1-trip
// linking. Restores app_store (ppp-v4 / ppp-feeders-v1) to its original value.
// Hard PROD-ref guard. Assumes migration 157 is already applied to TEST.
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
const PROD_REF = 'pzfujbjtayhkdlxiblwe';
if (!url || !serviceKey) {
  console.error('missing TEST env');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}
const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const svc = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});

const S = Date.now();
const CAT_ID = 'cpb-proof-' + S;
const BROIL_DATED = 'BPROOF-D-' + S;
const BROIL_UNDATED = 'BPROOF-U-' + S;
const PIG_GROUP = 'gproof-' + S;
const TRIP1 = 't1-' + S,
  TRIP2 = 't2-' + S;
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};

// Read an app_store array key; returns {existed, arr}.
async function readStore(key) {
  const {data} = await svc.from('app_store').select('data').eq('key', key).maybeSingle();
  if (!data) return {existed: false, arr: []};
  return {existed: true, arr: Array.isArray(data.data) ? data.data : []};
}
async function writeStore(key, arr) {
  await svc.from('app_store').upsert({key, data: arr}, {onConflict: 'key'});
}

(async () => {
  console.log(`TEST url=${url}`);
  // ── snapshot app_store so we can restore ──
  const v4 = await readStore('ppp-v4');
  const feeders = await readStore('ppp-feeders-v1');

  try {
    // ── seed cattle (real table row: 2 cows, actual date) ──
    await svc.from('cattle_processing_batches').upsert(
      {
        id: CAT_ID,
        name: 'WCF-C-26-PROOF',
        status: 'complete',
        actual_process_date: '2026-05-01',
        planned_process_date: '2026-04-15',
        cows_detail: [
          {cattle_id: 'x1', tag: '1'},
          {cattle_id: 'x2', tag: '2'},
        ],
      },
      {onConflict: 'id'},
    );

    // ── seed broiler: one WITH processingDate, one WITHOUT (gate proof) ──
    await writeStore('ppp-v4', [
      ...v4.arr,
      {name: BROIL_DATED, processingDate: '2026-06-10', totalToProcessor: 695, status: 'processed'},
      {name: BROIL_UNDATED, totalToProcessor: 0, status: 'planned'}, // no processingDate -> no row
    ]);

    // ── seed pig: one group, two actual processing trips ──
    await writeStore('ppp-feeders-v1', [
      ...feeders.arr,
      {
        id: PIG_GROUP,
        batchName: 'WCF-P-26-PROOF',
        processingTrips: [
          {id: TRIP1, date: '2026-03-03', pigCount: 5, subAttributions: [{subBatchName: 'A', sex: 'Gilts', count: 5}]},
          {
            id: TRIP2,
            date: '2026-04-07',
            pigCount: 10,
            subAttributions: [{subBatchName: 'B', sex: 'Boars', count: 10}],
          },
        ],
      },
    ]);

    // ── run the reconciler ──
    const {data: rec, error: rErr} = await svc.rpc('reconcile_planner_to_processing');
    if (rErr) {
      bad('reconcile threw', rErr.message);
    } else {
      ok('reconcile ran: ' + JSON.stringify(rec));
    }

    // ── assert planner rows ──
    const rowFor = async (kind, sid) => {
      const {data} = await svc
        .from('processing_records')
        .select('id,record_type,processing_date,number_processed,status,sub_batch_attribution')
        .eq('source_kind', kind)
        .eq('source_id', sid)
        .maybeSingle();
      return data;
    };

    const cat = await rowFor('cattle', CAT_ID);
    cat &&
    cat.record_type === 'planner_batch' &&
    cat.number_processed === 2 &&
    String(cat.processing_date) === '2026-05-01'
      ? ok('cattle -> one planner_batch row (count 2, actual date)')
      : bad('cattle row wrong', cat);

    const bd = await rowFor('broiler', BROIL_DATED);
    bd && bd.number_processed === 695 ? ok('broiler(dated) -> row (695)') : bad('broiler dated row wrong', bd);
    const bu = await rowFor('broiler', BROIL_UNDATED);
    bu === null
      ? ok('broiler(undated) -> NO row (processingDate gate)')
      : bad('undated broiler wrongly created a row', bu);

    const p1 = await rowFor('pig', PIG_GROUP + ':' + TRIP1);
    const p2 = await rowFor('pig', PIG_GROUP + ':' + TRIP2);
    p1 && p1.number_processed === 5 && p2 && p2.number_processed === 10
      ? ok('pig -> ONE row PER TRIP (5 and 10), sub-batch attribution carried')
      : bad('pig per-trip rows wrong', {p1, p2});
    p1 && Array.isArray(p1.sub_batch_attribution) && p1.sub_batch_attribution.length === 1
      ? ok('pig trip1 sub_batch_attribution present')
      : bad('pig attribution missing', p1 && p1.sub_batch_attribution);

    // ── idempotency: reconcile again, assert no duplicate rows for our keys ──
    await svc.rpc('reconcile_planner_to_processing');
    const dupCheck = async (kind, sid) => {
      const {data} = await svc.from('processing_records').select('id').eq('source_kind', kind).eq('source_id', sid);
      return (data || []).length;
    };
    const counts = [
      await dupCheck('cattle', CAT_ID),
      await dupCheck('broiler', BROIL_DATED),
      await dupCheck('pig', PIG_GROUP + ':' + TRIP1),
      await dupCheck('pig', PIG_GROUP + ':' + TRIP2),
    ];
    counts.every((c) => c === 1)
      ? ok('idempotent: re-reconcile created 0 duplicates (all keys still 1 row)')
      : bad('duplicate rows after re-reconcile', counts);

    // ── N Asana rows -> ONE pig trip (many-to-one link) ──
    if (p1) {
      await svc.rpc('link_asana_to_processing', {
        p_row: {asana_gid: 'am1-' + S, processing_record_id: p1.id, program: 'pig', match_status: 'matched'},
      });
      await svc.rpc('link_asana_to_processing', {
        p_row: {asana_gid: 'am2-' + S, processing_record_id: p1.id, program: 'pig', match_status: 'matched'},
      });
      const {data: links} = await svc
        .from('processing_asana_links')
        .select('asana_gid,processing_record_id')
        .eq('processing_record_id', p1.id);
      (links || []).length === 2
        ? ok('N-Asana->1-pig-trip: 2 Asana links attached to ONE Processing row')
        : bad('many-to-one link failed', links);
    }
  } finally {
    // ── restore + cleanup ──
    if (v4.existed) await writeStore('ppp-v4', v4.arr);
    else await svc.from('app_store').delete().eq('key', 'ppp-v4');
    if (feeders.existed) await writeStore('ppp-feeders-v1', feeders.arr);
    else await svc.from('app_store').delete().eq('key', 'ppp-feeders-v1');
    await svc.from('cattle_processing_batches').delete().eq('id', CAT_ID);
    await svc.rpc('exec_sql', {
      sql: `DELETE FROM public.processing_asana_links WHERE asana_gid LIKE 'am_-${S}';
            DELETE FROM public.processing_records WHERE record_type='planner_batch';`,
    });
    ok('cleanup: app_store restored, seeds + planner rows removed');
  }

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('proof threw:', e.message || e);
  process.exit(1);
});
