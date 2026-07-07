// TEST proof for the five Codex blocker fixes on migration 157. Assumes 157 is
// already applied to TEST. Hard PROD-ref guard. Cleans up everything it creates.
//   B1. delete_comment preserves BOTH mig-112 cattle-log guards (clog-* id,
//       cattle_log_tag_links mirror, cattle.log entity) AND the new imported-
//       Asana read-only guard.
//   B2. upsert_processing_from_asana coerces the record match_status to the 156
//       domain (historical/milestone -> unmatched, needs_review -> review) while
//       the LINK keeps the detailed bucket.
//   B3. A manual crosswalk is durable: a later automated link with a null (or
//       different) record must NOT overwrite the human resolution.
//   B4. reconcile retires stale Planner rows (cleared broiler date / removed pig
//       trip -> archived) and un-archives when the source becomes eligible again.
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
const svc = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const admin = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const S = Date.now();
let failures = 0;
const ok = (l) => console.log('  ok  ' + l);
const bad = (l, d) => {
  failures++;
  console.error('  FAIL ' + l + (d ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)) : ''));
};
const isValidation = (e) => !!e && /CATTLE_LOG_VALIDATION/.test(e.message || '');

// ids we create (for cleanup)
const CLOG_ID = 'clog-blk-' + S;
const CLOGENT_ID = 'cmt-clogent-' + S;
const SRC_ID = 'cmt-src-' + S;
const MIR_ID = 'cmt-mir-' + S;
const ASANA_ID = 'cmt-asana-' + S;
const TAGLINK_ID = 'tl-blk-' + S;
const GH = 'gblk-hist-' + S;
const GE = 'gblk-exc-' + S;
const GM = 'gblk-mile-' + S;
const R_CAT = 'catblk-' + S; // synthetic planner source id for the manual-crosswalk record
const GX = 'gblk-xwalk-' + S;
const OTHER_GID = 'gblk-other-' + S;
const BN = 'BLKBROIL-' + S; // broiler name (retire/unarchive)
const PIG_GROUP = 'gblkpig-' + S;
const PT1 = 'pt1-' + S,
  PT2 = 'pt2-' + S;

async function readStore(key) {
  const {data} = await svc.from('app_store').select('data').eq('key', key).maybeSingle();
  if (!data) return {existed: false, arr: []};
  return {existed: true, arr: Array.isArray(data.data) ? data.data : []};
}
async function writeStore(key, arr) {
  await svc.from('app_store').upsert({key, data: arr}, {onConflict: 'key'});
}
async function recBySource(kind, sid) {
  const {data} = await svc
    .from('processing_records')
    .select('id,archived,record_type')
    .eq('source_kind', kind)
    .eq('source_id', sid)
    .maybeSingle();
  return data;
}

(async () => {
  console.log(`TEST url=${url}`);
  const {error: signInErr} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
  if (signInErr) {
    bad('admin sign-in', signInErr.message);
    process.exit(1);
  }
  const v4 = await readStore('ppp-v4');
  const feeders = await readStore('ppp-feeders-v1');
  let R_ID = null,
    OTHER_ID = null,
    HIST_ID = null;

  try {
    // ── B1: cattle-log delete guards preserved + imported guard ──────────────
    // clog-% id
    await svc.from('comments').insert({id: CLOG_ID, entity_type: 'processing.record', entity_id: 'x', body: 'x'});
    {
      const {error} = await admin.rpc('delete_comment', {p_comment_id: CLOG_ID});
      isValidation(error) ? ok('B1 clog-% id guard preserved') : bad('B1 clog-% guard missing', error);
    }
    // cattle.log entity_type
    await svc.from('comments').insert({id: CLOGENT_ID, entity_type: 'cattle.log', entity_id: 'x', body: 'x'});
    {
      const {error} = await admin.rpc('delete_comment', {p_comment_id: CLOGENT_ID});
      isValidation(error) ? ok('B1 cattle.log entity guard preserved') : bad('B1 cattle.log guard missing', error);
    }
    // cattle_log_tag_links mirror guard
    await svc.from('comments').insert({id: SRC_ID, entity_type: 'cattle.log', entity_id: 'x', body: 'src'});
    await svc.from('comments').insert({id: MIR_ID, entity_type: 'processing.record', entity_id: 'x', body: 'mir'});
    await svc
      .from('cattle_log_tag_links')
      .insert({id: TAGLINK_ID, comment_id: SRC_ID, tag: 'blk', mirror_comment_id: MIR_ID});
    {
      const {error} = await admin.rpc('delete_comment', {p_comment_id: MIR_ID});
      isValidation(error)
        ? ok('B1 cattle_log_tag_links mirror guard preserved')
        : bad('B1 mirror guard missing', error);
    }
    // imported-Asana read-only guard (native comment CAN be deleted; asana CANNOT)
    await svc.from('comments').insert({
      id: ASANA_ID,
      entity_type: 'processing.record',
      entity_id: 'x',
      body: 'imp',
      source: 'asana',
      is_imported: true,
    });
    {
      const {error} = await admin.rpc('delete_comment', {p_comment_id: ASANA_ID});
      error && /read-only/.test(error.message || '')
        ? ok('B1 imported-Asana comment read-only')
        : bad('B1 imported guard missing', error);
    }

    // ── B2: record match_status coercion; link keeps detail ──────────────────
    const seedAsana = async (gid, type, ms) =>
      svc.rpc('upsert_processing_from_asana', {
        p_row: {asana_gid: gid, record_type: type, match_status: ms, program: 'broiler', title: 'blk ' + type},
      });
    {
      const {data, error} = await seedAsana(GH, 'asana_historical', 'historical');
      HIST_ID = (data && data.id) || null;
      if (error) bad('B2 historical insert threw (CHECK violation?)', error.message);
      else {
        const r = await svc.from('processing_records').select('match_status').eq('asana_gid', GH).maybeSingle();
        r.data && r.data.match_status === 'unmatched'
          ? ok("B2 historical -> record match_status coerced to 'unmatched'")
          : bad('B2 historical coercion wrong', r.data);
      }
    }
    {
      const {error} = await seedAsana(GE, 'import_exception', 'needs_review');
      if (error) bad('B2 import_exception insert threw', error.message);
      else {
        const r = await svc.from('processing_records').select('match_status').eq('asana_gid', GE).maybeSingle();
        r.data && r.data.match_status === 'review'
          ? ok("B2 needs_review -> record match_status coerced to 'review'")
          : bad('B2 needs_review coercion wrong', r.data);
      }
    }
    {
      const {error} = await seedAsana(GM, 'milestone', 'milestone');
      if (error) bad('B2 milestone insert threw', error.message);
      else {
        const r = await svc.from('processing_records').select('match_status').eq('asana_gid', GM).maybeSingle();
        r.data && r.data.match_status === 'unmatched'
          ? ok("B2 milestone -> record match_status coerced to 'unmatched'")
          : bad('B2 milestone coercion wrong', r.data);
      }
    }
    // link keeps the DETAILED bucket ('historical' is link-CHECK-valid)
    if (HIST_ID) {
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: GH,
          processing_record_id: HIST_ID,
          program: 'broiler',
          match_status: 'historical',
          match_method: 'historical',
        },
      });
      const l = await svc.from('processing_asana_links').select('match_status').eq('asana_gid', GH).maybeSingle();
      l.data && l.data.match_status === 'historical'
        ? ok("B2 link keeps detailed bucket ('historical')")
        : bad('B2 link detail lost', l.data);
    }

    // ── B3: durable manual crosswalk ─────────────────────────────────────────
    {
      const {data: r} = await svc.rpc('upsert_processing_from_planner', {
        p_row: {
          source_kind: 'cattle',
          source_id: R_CAT,
          program: 'cattle',
          title: 'xwalk target',
          status: 'complete',
          number_processed: 1,
        },
      });
      R_ID = r && r.id;
      const {data: o} = await svc.rpc('upsert_processing_from_planner', {
        p_row: {
          source_kind: 'cattle',
          source_id: R_CAT + '-other',
          program: 'cattle',
          title: 'other',
          status: 'complete',
          number_processed: 1,
        },
      });
      OTHER_ID = o && o.id;
      // sync sees ambiguity -> needs_review link, null record
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: GX,
          processing_record_id: null,
          program: 'cattle',
          match_status: 'needs_review',
          match_method: 'none',
        },
      });
      // human resolves -> manual_crosswalk
      const {error: rErr} = await admin.rpc('resolve_processing_asana_link', {p_asana_gid: GX, p_record_id: R_ID});
      if (rErr) bad('B3 resolve threw', rErr.message);
      // later sync, matcher ambiguous again -> null record. Must NOT clear.
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: GX,
          processing_record_id: null,
          program: 'cattle',
          match_status: 'needs_review',
          match_method: 'none',
        },
      });
      let l = await svc
        .from('processing_asana_links')
        .select('processing_record_id,match_status,match_method')
        .eq('asana_gid', GX)
        .maybeSingle();
      l.data &&
      l.data.processing_record_id === R_ID &&
      l.data.match_method === 'manual_crosswalk' &&
      l.data.match_status === 'matched'
        ? ok('B3 manual crosswalk survived a null-record re-sync')
        : bad('B3 manual crosswalk cleared by re-sync', l.data);
      // later sync auto-matches to a DIFFERENT record -> manual still wins.
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: GX,
          processing_record_id: OTHER_ID,
          program: 'cattle',
          match_status: 'matched',
          match_method: 'auto_exact',
        },
      });
      l = await svc
        .from('processing_asana_links')
        .select('processing_record_id,match_method')
        .eq('asana_gid', GX)
        .maybeSingle();
      l.data && l.data.processing_record_id === R_ID && l.data.match_method === 'manual_crosswalk'
        ? ok('B3 manual crosswalk not repointed by a later auto-match')
        : bad('B3 auto-match overrode manual crosswalk', l.data);
    }

    // ── B3b: a non-manual auto link is preserved against a null re-sync ───────
    {
      const AGID = 'gblk-auto-' + S;
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: AGID,
          processing_record_id: R_ID,
          program: 'cattle',
          match_status: 'matched',
          match_method: 'auto_exact',
        },
      });
      // later sync sees ambiguity -> null record; artifacts must not be orphaned
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: AGID,
          processing_record_id: null,
          program: 'cattle',
          match_status: 'needs_review',
          match_method: 'none',
        },
      });
      let l = await svc
        .from('processing_asana_links')
        .select('processing_record_id,match_status')
        .eq('asana_gid', AGID)
        .maybeSingle();
      l.data && l.data.processing_record_id === R_ID && l.data.match_status === 'matched'
        ? ok('B3b non-manual auto link preserved against null re-sync (not orphaned)')
        : bad('B3b auto link nulled by ambiguous re-sync', l.data);
      // a FRESH non-null auto-match may still repoint a non-manual link
      await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: AGID,
          processing_record_id: OTHER_ID,
          program: 'cattle',
          match_status: 'matched',
          match_method: 'auto_exact',
        },
      });
      l = await svc.from('processing_asana_links').select('processing_record_id').eq('asana_gid', AGID).maybeSingle();
      l.data && l.data.processing_record_id === OTHER_ID
        ? ok('B3b fresh non-null auto-match repoints a non-manual link')
        : bad('B3b non-manual link not repointed by fresh auto-match', l.data);
      await svc.from('processing_asana_links').delete().eq('asana_gid', AGID);
    }

    // ── B4: stale Planner retirement + un-archive ────────────────────────────
    await writeStore('ppp-v4', [
      ...v4.arr,
      {name: BN, processingDate: '2026-06-10', totalToProcessor: 100, status: 'processed'},
    ]);
    await writeStore('ppp-feeders-v1', [
      ...feeders.arr,
      {
        id: PIG_GROUP,
        batchName: 'WCF-P-26-BLK',
        processingTrips: [
          {id: PT1, date: '2026-03-03', pigCount: 5},
          {id: PT2, date: '2026-04-07', pigCount: 10},
        ],
      },
    ]);
    await svc.rpc('reconcile_planner_to_processing');
    {
      const b = await recBySource('broiler', BN);
      b && b.archived === false ? ok('B4 broiler row live after reconcile') : bad('B4 broiler not live', b);
    }
    // clear the broiler processingDate -> source no longer eligible
    await writeStore('ppp-v4', [...v4.arr, {name: BN, totalToProcessor: 100, status: 'planned'}]);
    // remove pig trip 2
    await writeStore('ppp-feeders-v1', [
      ...feeders.arr,
      {id: PIG_GROUP, batchName: 'WCF-P-26-BLK', processingTrips: [{id: PT1, date: '2026-03-03', pigCount: 5}]},
    ]);
    const {data: rec2} = await svc.rpc('reconcile_planner_to_processing');
    {
      const b = await recBySource('broiler', BN);
      b && b.archived === true
        ? ok('B4 cleared broiler date -> row archived (retired)')
        : bad('B4 broiler not retired', b);
      const t2 = await recBySource('pig', PIG_GROUP + ':' + PT2);
      t2 && t2.archived === true ? ok('B4 removed pig trip -> row archived') : bad('B4 pig trip not retired', t2);
      const t1 = await recBySource('pig', PIG_GROUP + ':' + PT1);
      t1 && t1.archived === false
        ? ok('B4 surviving pig trip stays live')
        : bad('B4 surviving pig trip wrongly archived', t1);
      typeof rec2.retired === 'number' && rec2.retired >= 2
        ? ok('B4 reconcile reported retired>=2 (' + rec2.retired + ')')
        : bad('B4 retired count wrong', rec2);
    }
    // restore the broiler date -> un-archive
    await writeStore('ppp-v4', [
      ...v4.arr,
      {name: BN, processingDate: '2026-06-10', totalToProcessor: 100, status: 'processed'},
    ]);
    await svc.rpc('reconcile_planner_to_processing');
    {
      const b = await recBySource('broiler', BN);
      b && b.archived === false
        ? ok('B4 restored broiler date -> row un-archived')
        : bad('B4 broiler not un-archived', b);
    }

    // ── Bug 1 (re-review): seed follows the EFFECTIVE record, never a rejected one ──
    {
      const GZ = 'gblk-seed-' + S;
      const {data: a} = await svc.rpc('upsert_processing_from_planner', {
        p_row: {
          source_kind: 'cattle',
          source_id: 'seedA-' + S,
          program: 'cattle',
          title: 'seed A',
          status: 'complete',
          number_processed: 1,
        },
      });
      const A_ID = a && a.id;
      const {data: bb} = await svc.rpc('upsert_processing_from_planner', {
        p_row: {
          source_kind: 'cattle',
          source_id: 'seedB-' + S,
          program: 'cattle',
          title: 'seed B',
          status: 'complete',
          number_processed: 1,
        },
      });
      const B_ID = bb && bb.id;
      // human manual-crosswalks the link to A
      await svc.rpc('link_asana_to_processing', {
        p_row: {asana_gid: GZ, processing_record_id: null, program: 'cattle', match_status: 'needs_review'},
      });
      await admin.rpc('resolve_processing_asana_link', {p_asana_gid: GZ, p_record_id: A_ID});
      // later sync proposes B WITH seeds; manual keeps A -> B must NOT be seeded
      const {data: linkRes} = await svc.rpc('link_asana_to_processing', {
        p_row: {
          asana_gid: GZ,
          processing_record_id: B_ID,
          program: 'cattle',
          match_status: 'matched',
          match_method: 'auto_exact',
          seed_processor: 'SEEDLEAK',
          seed_customer: [{name: 'X'}],
        },
      });
      const link = await svc
        .from('processing_asana_links')
        .select('processing_record_id')
        .eq('asana_gid', GZ)
        .maybeSingle();
      link.data && link.data.processing_record_id === A_ID && linkRes && linkRes.record_id === A_ID
        ? ok('Bug1 link stayed on A + returned record_id=A (effective, not proposed B)')
        : bad('Bug1 link/return repointed to B', {link: link.data, ret: linkRes});
      const bRec = await svc.from('processing_records').select('processor,customer').eq('id', B_ID).maybeSingle();
      bRec.data && !bRec.data.processor && (bRec.data.customer || []).length === 0
        ? ok('Bug1 rejected record B was NOT seeded (no wrong-record seed leak)')
        : bad('Bug1 seed leaked onto rejected record B', bRec.data);
      const aRec = await svc.from('processing_records').select('processor').eq('id', A_ID).maybeSingle();
      aRec.data && !aRec.data.processor
        ? ok('Bug1 kept record A not re-seeded by the B proposal')
        : bad('Bug1 A wrongly seeded', aRec.data);
    }

    // ── Bug 2 (re-review): archived planner row is not a candidate + not counted ──
    {
      const {data: r} = await svc.rpc('upsert_processing_from_planner', {
        p_row: {
          source_kind: 'cattle',
          source_id: 'arch-' + S,
          program: 'cattle',
          title: 'arch',
          status: 'complete',
          number_processed: 1,
        },
      });
      const R_ARCH = r && r.id;
      const {data: cnt1} = await admin.rpc('list_processing_reconciliation');
      await svc.rpc('exec_sql', {sql: `UPDATE public.processing_records SET archived=true WHERE id='${R_ARCH}';`});
      const {data: cnt2} = await admin.rpc('list_processing_reconciliation');
      cnt1 && cnt2 && cnt2.planner_only_count === cnt1.planner_only_count - 1
        ? ok('Bug2 archived planner row drops out of planner_only_count')
        : bad('Bug2 archived row still counted', {
            before: cnt1 && cnt1.planner_only_count,
            after: cnt2 && cnt2.planner_only_count,
          });
      // loadPlannerRows-equivalent (the edge matcher's candidate query): archived=false only
      const {data: active} = await svc
        .from('processing_records')
        .select('id')
        .eq('record_type', 'planner_batch')
        .eq('archived', false);
      const {data: all} = await svc.from('processing_records').select('id').eq('record_type', 'planner_batch');
      const inActive = (active || []).some((x) => x.id === R_ARCH);
      const inAll = (all || []).some((x) => x.id === R_ARCH);
      !inActive && inAll
        ? ok('Bug2 archived planner row excluded from matcher candidates (archived=false)')
        : bad('Bug2 archived row still a match candidate', {inActive, inAll});
    }
  } finally {
    // ── cleanup ──
    if (v4.existed) await writeStore('ppp-v4', v4.arr);
    else await svc.from('app_store').delete().eq('key', 'ppp-v4');
    if (feeders.existed) await writeStore('ppp-feeders-v1', feeders.arr);
    else await svc.from('app_store').delete().eq('key', 'ppp-feeders-v1');
    await svc.from('cattle_log_tag_links').delete().eq('id', TAGLINK_ID);
    await svc.rpc('exec_sql', {
      sql: `DELETE FROM public.comments WHERE id IN ('${CLOG_ID}','${CLOGENT_ID}','${SRC_ID}','${MIR_ID}','${ASANA_ID}');
            DELETE FROM public.processing_asana_links WHERE asana_gid LIKE '%${S}';
            DELETE FROM public.processing_records WHERE record_type='planner_batch';
            DELETE FROM public.processing_records WHERE asana_gid IN ('${GH}','${GE}','${GM}');`,
    });
    await admin.auth.signOut();
    ok('cleanup done');
  }

  console.log(failures ? `\nDONE with ${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('blocker proof threw:', e.message || e);
  process.exit(1);
});
