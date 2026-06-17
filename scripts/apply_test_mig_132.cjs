// Apply mig 132 (Pasture Map line patterns + defaults) to TEST via exec_sql.
// Hard PROD-ref guard. Smokes the authenticated style RPC and field-track
// defaults so PostgREST schema cache/grants are proven before Playwright.
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
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const adminEmail = process.env.VITE_TEST_ADMIN_EMAIL;
const adminPass = process.env.VITE_TEST_ADMIN_PASSWORD;
const PROD_REF = 'pzfujbjtayhkdlxiblwe';

if (!url || !serviceKey) {
  console.error('missing TEST env (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  process.exit(2);
}
if (url.includes(PROD_REF)) {
  console.error('refusing to run against PROD url');
  process.exit(2);
}

const {createClient} = require(path.join(__dirname, '..', 'node_modules', '@supabase', 'supabase-js'));
const admin = createClient(url, serviceKey, {auth: {autoRefreshToken: false, persistSession: false}});
const authed = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const TRACK = {
  type: 'LineString',
  coordinates: [
    [-86.44, 30.84],
    [-86.439, 30.84],
    [-86.439, 30.841],
  ],
};

(async () => {
  if (!anonKey || !adminEmail || !adminPass) {
    console.error('missing TEST auth env (anon key / admin email / admin password)');
    process.exit(2);
  }
  console.log(`TEST url=${url}`);
  const body = fs.readFileSync(
    path.join(__dirname, '..', 'supabase-migrations', '132_pasture_map_line_patterns_and_defaults.sql'),
    'utf8',
  );
  console.log(`applying 132_pasture_map_line_patterns_and_defaults.sql (${body.length} bytes)`);
  const {error: applyErr} = await admin.rpc('exec_sql', {sql: body});
  if (applyErr) {
    console.error('exec_sql APPLY failed:', applyErr.message || applyErr);
    process.exit(1);
  }
  await admin.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const styleId = 'style132-smoke-' + Date.now();
  const trackId = 'track132-smoke-' + Date.now();
  const {error: seedErr} = await admin.rpc('exec_sql', {
    sql: `
      DELETE FROM public.land_areas WHERE id LIKE 'style132-smoke-%' OR id LIKE 'track132-smoke-%';
      INSERT INTO public.land_areas
        (id, kind, name, status, review_status, geometry_status, baseline_no_history, source)
      VALUES
        ('${styleId}', 'paddock', 'Style 132 Smoke', 'active', 'reviewed', 'none', true, 'drawn');
    `,
  });
  if (seedErr) {
    console.error('seed failed:', seedErr.message || seedErr);
    process.exit(1);
  }

  const {error: signErr} = await authed.auth.signInWithPassword({email: adminEmail, password: adminPass});
  if (signErr) {
    console.error('signIn failed:', signErr.message || signErr);
    process.exit(1);
  }

  const {data: styleData, error: styleErr} = await authed.rpc('update_land_area_line_style', {
    p_id: styleId,
    p_line_color: '#2563eb',
    p_line_weight: 6,
    p_line_pattern: 'dashed',
    p_clear: false,
  });
  if (styleErr) {
    console.error('update_land_area_line_style failed:', styleErr.message || styleErr);
    process.exit(1);
  }
  if (
    !styleData ||
    styleData.line_color !== '#2563eb' ||
    styleData.line_weight !== 6 ||
    styleData.line_pattern !== 'dashed'
  ) {
    console.error('unexpected style response:', JSON.stringify(styleData, null, 2));
    process.exit(1);
  }

  const {data: trackData, error: trackErr} = await authed.rpc('create_land_area_track', {
    p_id: trackId,
    p_name: 'Track 132 Smoke',
    p_line_geojson: TRACK,
    p_source: 'drawn',
  });
  if (trackErr) {
    console.error('create_land_area_track failed:', trackErr.message || trackErr);
    process.exit(1);
  }
  if (
    !trackData ||
    trackData.kind !== 'outline_candidate' ||
    trackData.line_color !== '#ffffff' ||
    trackData.line_weight !== 5 ||
    trackData.line_pattern !== 'dashed'
  ) {
    console.error('unexpected track response:', JSON.stringify(trackData, null, 2));
    process.exit(1);
  }
  console.log(
    'line pattern smoke ok:',
    styleData.id,
    styleData.line_color,
    styleData.line_weight,
    styleData.line_pattern,
    '| track',
    trackData.line_color,
    trackData.line_weight,
    trackData.line_pattern,
  );
})();
