// READ-ONLY environment preflight for the Brett Post / Isabel Hermann
// imported-assignee correction (mig 177's correct_processing_imported_assignee
// takes a preflight-verified email; this script produces that verification).
//
// STRICTLY READ-ONLY: PostgREST .select() reads only. It NEVER calls exec_sql
// (which must never run against PROD anyway), never writes, never prints full
// emails or full UUIDs from the database.
//
// Usage:
//   node scripts/preflight_processing_profile_correction.cjs [--env=test|prod]
//        [--brett-email=<email>] [--isabel-email=<email>]
//
//   Mode A (no email flags): DISCOVERY — lists candidate profiles (id prefix,
//     full_name, role, MASKED email) whose full_name matches brett/post/
//     isabel/hermann/account, and counts name-only 'Brett Post' /
//     'Isabel Hermann' assignments on processing_subtasks (profile NULL),
//     processing_records.assignee_name, and ACTIVE template checklists.
//     Counts only — no row contents.
//   Mode B (email flags given): VERIFY — each email must resolve to EXACTLY
//     one profile by lower(email), and that profile must hold an operational
//     role (farm_team/management/admin). Exit 1 when any assertion fails.
//
// Environments:
//   --env=test (default): .env.test/.env.test.local (VITE_SUPABASE_URL +
//     SUPABASE_SERVICE_ROLE_KEY); refuses a URL containing the PROD ref.
//   --env=prod: .env.prod.local must provide PROD_SERVICE_ROLE_JWT (the
//     script exits 2 if absent); connects to the PROD URL with that key for
//     PostgREST READS ONLY.
//
// Running this preflight is read-only and safe; the CORRECTION itself (mig 177
// apply + RPC call) stays gated on Ronnie's explicit approval.
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

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z-]+)=(.*)$/);
  if (m) args[m[1]] = m[2];
  else if (a === '--prod') args.env = 'prod'; // convenience
}
const ENV = (args.env || 'test').toLowerCase();
const BRETT_EMAIL = (args['brett-email'] || '').trim();
const ISABEL_EMAIL = (args['isabel-email'] || '').trim();
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

let url;
let key;
if (ENV === 'prod') {
  // PROD: .env.prod.local's service key ONLY IF present; PostgREST reads only.
  loadDotEnv(path.join(__dirname, '..', '.env.prod.local'));
  loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.prod.local'));
  url = `https://${PROD_REF}.supabase.co`;
  key = process.env.PROD_SERVICE_ROLE_JWT;
  if (!key) {
    console.error('PROD_SERVICE_ROLE_JWT not present in .env.prod.local — refusing to guess. Nothing was read.');
    process.exit(2);
  }
} else if (ENV === 'test') {
  loadDotEnv(path.join(__dirname, '..', '.env.test'));
  loadDotEnv(path.join(__dirname, '..', '.env.test.local'));
  loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test'));
  loadDotEnv(path.join(__dirname, '..', '..', 'WCF-planner', '.env.test.local'));
  url = process.env.VITE_SUPABASE_URL;
  key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && url.includes(PROD_REF)) {
    console.error('test env points at PROD; aborting');
    process.exit(2);
  }
} else {
  console.error("--env must be 'test' or 'prod'");
  process.exit(2);
}
if (!url || !key) {
  console.error(`missing url/service key for ${ENV}`);
  process.exit(2);
}

function requireSupabase() {
  const candidates = [
    path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'),
    path.join(__dirname, '..', '..', 'WCF-planner', 'node_modules', '@supabase', 'supabase-js'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch (e) {
      /* try next */
    }
  }
  return require('@supabase/supabase-js');
}
const {createClient} = requireSupabase();
const svc = createClient(url, key, {auth: {autoRefreshToken: false, persistSession: false}});

const OPERATIONAL = ['farm_team', 'management', 'admin'];
const NAMES = ['Brett Post', 'Isabel Hermann'];
let failures = 0;
const fail = (l) => {
  failures++;
  console.error('  FAIL ' + l);
};

function maskEmail(email) {
  const e = String(email || '');
  const at = e.indexOf('@');
  if (at < 0) return e ? e.slice(0, 2) + '***' : '(none)';
  const local = e.slice(0, at);
  return (local.slice(0, 2) || '*') + '***' + e.slice(at);
}
function idPrefix(id) {
  return String(id || '').slice(0, 8);
}

async function discovery() {
  console.log('MODE A — DISCOVERY (no email flags given)');
  console.log('\ncandidate profiles (full_name ~ brett/post/isabel/hermann/account):');
  const {data: profiles, error} = await svc
    .from('profiles')
    .select('id, full_name, role, email')
    .or(
      'full_name.ilike.%brett%,full_name.ilike.%post%,full_name.ilike.%isabel%,full_name.ilike.%hermann%,full_name.ilike.%account%',
    )
    .order('full_name');
  if (error) {
    fail('profiles discovery query: ' + error.message);
    return;
  }
  if (!profiles || profiles.length === 0) {
    console.log('  (no matching profiles)');
  } else {
    for (const p of profiles) {
      console.log(
        `  id=${idPrefix(p.id)}…  full_name=${JSON.stringify(p.full_name)}  role=${p.role}  email=${maskEmail(p.email)}`,
      );
    }
  }

  console.log('\nname-only assignment counts (assignee_profile_id IS NULL):');
  for (const name of NAMES) {
    const {count: subCount, error: e1} = await svc
      .from('processing_subtasks')
      .select('id', {count: 'exact', head: true})
      .is('assignee_profile_id', null)
      .ilike('assignee', name);
    if (e1) fail(`subtask count for ${name}: ` + e1.message);
    const {count: recCount, error: e2} = await svc
      .from('processing_records')
      .select('id', {count: 'exact', head: true})
      .is('assignee_profile_id', null)
      .ilike('assignee_name', name);
    if (e2) fail(`record count for ${name}: ` + e2.message);
    console.log(
      `  ${name}: processing_subtasks.assignee=${e1 ? '?' : subCount || 0}  processing_records.assignee_name=${e2 ? '?' : recCount || 0}`,
    );
  }

  console.log('\nACTIVE template checklist occurrences (name-only steps):');
  const {data: templates, error: tErr} = await svc
    .from('processing_templates')
    .select('program, version, checklist')
    .eq('is_active', true)
    .order('program');
  if (tErr) {
    fail('active templates read: ' + tErr.message);
    return;
  }
  for (const name of NAMES) {
    let total = 0;
    const perProgram = [];
    for (const t of templates || []) {
      const steps = Array.isArray(t.checklist) ? t.checklist : [];
      const n = steps.filter(
        (s) =>
          s &&
          !String(s.assignee_profile_id || '').trim() &&
          String(s.assignee || '')
            .trim()
            .toLowerCase() === name.toLowerCase(),
      ).length;
      if (n > 0) perProgram.push(`${t.program} v${t.version}: ${n}`);
      total += n;
    }
    console.log(`  ${name}: ${total}${perProgram.length ? '  (' + perProgram.join(', ') + ')' : ''}`);
  }
}

async function verifyEmail(who, email) {
  // ilike gives case-insensitive matching; re-filter in JS for EXACT
  // lower(email) equality so ilike's '_' wildcard cannot over-match.
  const {data, error} = await svc.from('profiles').select('id, full_name, role, email').ilike('email', email);
  if (error) {
    fail(`${who}: profiles query errored: ${error.message}`);
    return;
  }
  const matches = (data || []).filter(
    (p) =>
      String(p.email || '')
        .trim()
        .toLowerCase() === email.trim().toLowerCase(),
  );
  if (matches.length !== 1) {
    fail(`${who}: email ${maskEmail(email)} resolves to ${matches.length} profiles (need exactly 1)`);
    return;
  }
  const p = matches[0];
  const operational = OPERATIONAL.includes(p.role);
  console.log(
    `  ${who}: id=${idPrefix(p.id)}…  full_name=${JSON.stringify(p.full_name)}  email=${maskEmail(p.email)}  role=${p.role}  operational=${operational ? 'YES' : 'NO'}`,
  );
  if (!operational) {
    fail(`${who}: role '${p.role}' is not operational (farm_team/management/admin required for Processing)`);
  }
}

(async () => {
  console.log(`preflight_processing_profile_correction — ENV=${ENV.toUpperCase()} url=${url} (READ-ONLY)`);
  if (!BRETT_EMAIL && !ISABEL_EMAIL) {
    await discovery();
  } else {
    console.log('MODE B — VERIFY (candidate emails supplied via flags; emails are never echoed unmasked)');
    if (BRETT_EMAIL) await verifyEmail('Brett Post', BRETT_EMAIL);
    else console.log('  Brett Post: no --brett-email flag given, skipped');
    if (ISABEL_EMAIL) await verifyEmail('Isabel Hermann', ISABEL_EMAIL);
    else console.log('  Isabel Hermann: no --isabel-email flag given, skipped');
  }
  console.log(failures ? `\nPREFLIGHT FAILED (${failures} problem(s))` : '\nPREFLIGHT OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.message || e);
  process.exit(1);
});
