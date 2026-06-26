// Apply migs 144 (newsletter engine) + 145 (newsletter storage buckets) to TEST
// via exec_sql, then behaviorally verify the security boundary.
//
// Hard PROD-ref guard. Verifications (all behavioral, never exec_sql SELECT):
//   - deny-all RLS: anon cannot read newsletter_issues directly.
//   - anon RPC surface: list/get/preview reachable + safe-empty; admin RPCs
//     (create/save/publish) are NOT anon-executable.
//   - admin flow: create draft -> save blocks -> token preview works, wrong
//     token denied -> register photo with a private source path -> approve as
//     cover -> publish -> anon published payload exposes the approved photo's
//     public path but NEVER source_private_path, and noindex is locked true.
//   - publish rotates/disables the preview token (old token stops working).
//   - storage: both buckets exist with the right public flags.
// Creates a throwaway issue for year-month 2099-12 and deletes it (service
// role) at the end so the shared TEST DB is left clean.
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
const anon = createClient(url, anonKey, {auth: {autoRefreshToken: false, persistSession: false}});

const YM = '2099-12';
const ISSUE_ID = 'nli-' + YM;
const SECRET_PRIVATE_PATH = 'daily-photos/secret-source/should-never-be-public.jpg';
const PUBLIC_PATH = 'newsletter/' + ISSUE_ID + '/cover.jpg';

let failures = 0;
function ok(label) {
  console.log('  ok  ' + label);
}
function bad(label, detail) {
  failures++;
  console.error('  FAIL ' + label + (detail ? ' :: ' + detail : ''));
}

async function applyFile(name) {
  const body = fs.readFileSync(path.join(__dirname, '..', 'supabase-migrations', name), 'utf8');
  console.log(`applying ${name} (${body.length} bytes)`);
  const {error} = await service.rpc('exec_sql', {sql: body});
  if (error) {
    console.error(`exec_sql APPLY failed for ${name}:`, error.message || error);
    process.exit(1);
  }
}

(async () => {
  console.log(`TEST url=${url}`);

  // Clean any prior run leftovers first (service role bypasses RLS).
  await service.from('newsletter_issues').delete().eq('id', ISSUE_ID);

  await applyFile('144_newsletter_engine.sql');
  await applyFile('145_newsletter_public_bucket.sql');
  await service.rpc('exec_sql', {sql: "NOTIFY pgrst, 'reload schema';"});
  await new Promise((r) => setTimeout(r, 2500));

  // ── anon surface ──
  console.log('verifying anon read surface...');
  {
    const {data, error} = await anon.rpc('list_published_newsletters');
    if (error) bad('anon list_published_newsletters reachable', error.message);
    else if (!Array.isArray(data)) bad('anon list returns array', JSON.stringify(data));
    else ok('anon list_published_newsletters -> array');
  }
  {
    const {data, error} = await anon.rpc('get_published_newsletter', {p_slug: 'no-such-slug-xyz'});
    if (error) bad('anon get_published_newsletter reachable', error.message);
    else if (data !== null) bad('anon get missing slug -> null', JSON.stringify(data));
    else ok('anon get_published_newsletter(missing) -> null');
  }
  {
    const {data, error} = await anon.rpc('get_newsletter_preview', {p_slug: 'x', p_token: 'y'});
    if (error) bad('anon get_newsletter_preview reachable', error.message);
    else if (data !== null) bad('anon preview bad token -> null', JSON.stringify(data));
    else ok('anon get_newsletter_preview(bad) -> null');
  }

  // ── anon must NOT reach admin RPCs or raw tables ──
  console.log('verifying anon denial of admin surface...');
  {
    const {error} = await anon.rpc('create_newsletter_issue', {p_year_month: '2099-01'});
    if (!error) bad('anon create_newsletter_issue denied', 'unexpected success');
    else ok('anon create_newsletter_issue denied -> ' + (error.message || error.code));
  }
  {
    const {error} = await anon.rpc('list_newsletter_issues_admin');
    if (!error) bad('anon list_newsletter_issues_admin denied', 'unexpected success');
    else ok('anon list_newsletter_issues_admin denied -> ' + (error.message || error.code));
  }
  {
    const {data, error} = await anon.from('newsletter_issues').select('id').limit(1);
    // deny-all RLS + REVOKE: either a permission error or an empty set is acceptable
    if (error) ok('anon direct table read denied -> ' + (error.message || error.code));
    else if (Array.isArray(data) && data.length === 0) ok('anon direct table read -> empty (RLS)');
    else bad('anon direct newsletter_issues read blocked', JSON.stringify(data));
  }

  // ── admin flow ──
  console.log('signing in admin...');
  {
    const {error} = await admin.auth.signInWithPassword({email: adminEmail, password: adminPassword});
    if (error) {
      console.error('admin signIn failed:', error.message || error);
      process.exit(1);
    }
  }

  let previewToken = null;
  let slug = null;
  {
    const {data, error} = await admin.rpc('create_newsletter_issue', {p_year_month: YM, p_title: null});
    if (error) bad('admin create_newsletter_issue', error.message);
    else {
      previewToken = data.previewToken;
      slug = data.slug;
      if (data.id !== ISSUE_ID) bad('issue id shape', data.id);
      else if (data.title !== 'White Creek Farm December 2099 Review') bad('default title', data.title);
      else if (data.status !== 'draft') bad('new issue is draft', data.status);
      else if (!data.previewExpiresAt)
        bad('new issue has a real preview expiry', JSON.stringify(data.previewExpiresAt));
      else ok('admin create -> ' + data.id + ' "' + data.title + '" (preview expiry set)');
    }
  }
  {
    const {error} = await admin.rpc('save_newsletter_draft', {
      p_id: ISSUE_ID,
      p_draft_payload: {
        blocks: [
          {type: 'heading', text: 'December on the Farm'},
          {type: 'paragraph', text: 'A good month.'},
        ],
      },
    });
    if (error) bad('admin save_newsletter_draft', error.message);
    else ok('admin save_newsletter_draft (blocks)');
  }
  // token preview: correct token works, wrong token denied
  {
    const {data, error} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: previewToken});
    if (error) bad('anon preview with good token', error.message);
    else if (!data || data.mode !== 'preview') bad('preview returns preview payload', JSON.stringify(data));
    else if (data.noindex !== true) bad('preview noindex locked true', JSON.stringify(data.noindex));
    else ok('anon preview(good token) -> preview payload, noindex=true');
  }
  {
    const {data} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: previewToken + 'X'});
    if (data !== null) bad('anon preview wrong-length token -> null', JSON.stringify(data));
    else ok('anon preview(wrong token) -> null');
  }
  const futureExpiry = () => new Date(Date.now() + 30 * 86400000).toISOString();
  // expired window: even the correct token must be denied once expired
  {
    await service.from('newsletter_issues').update({preview_expires_at: '2000-01-01T00:00:00Z'}).eq('id', ISSUE_ID);
    const {data} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: previewToken});
    if (data !== null) bad('anon preview(expired window) -> null', JSON.stringify(data));
    else ok('anon preview(expired window) -> null');
    await service.from('newsletter_issues').update({preview_expires_at: futureExpiry()}).eq('id', ISSUE_ID);
  }
  // null expiry must fail closed (nullable-pass regression guard)
  {
    await service.from('newsletter_issues').update({preview_expires_at: null}).eq('id', ISSUE_ID);
    const {data} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: previewToken});
    if (data !== null) bad('anon preview(null expiry) -> null', JSON.stringify(data));
    else ok('anon preview(null expiry) -> null');
    await service.from('newsletter_issues').update({preview_expires_at: futureExpiry()}).eq('id', ISSUE_ID);
  }
  // photo: register with a private source path, set cover, approve
  {
    const {error} = await admin.rpc('register_newsletter_photo', {
      p_issue_id: ISSUE_ID,
      p_storage_path: PUBLIC_PATH,
      p_source_private_path: SECRET_PRIVATE_PATH,
      p_caption: 'Cover',
      p_alt_text: 'Cattle at sunrise',
      p_first_name: 'Sam',
    });
    if (error) bad('admin register_newsletter_photo', error.message);
    else ok('admin register_newsletter_photo (with private source)');
  }
  let photoId = null;
  {
    const {data, error} = await admin.rpc('get_newsletter_issue_admin', {p_id: ISSUE_ID});
    if (error) bad('admin get_newsletter_issue_admin', error.message);
    else {
      photoId = data.photos && data.photos[0] && data.photos[0].id;
      // admin summary DOES carry sourcePrivatePath (admins may inspect provenance)
      if (data.photos[0].sourcePrivatePath !== SECRET_PRIVATE_PATH)
        bad('admin sees source path', JSON.stringify(data.photos[0]));
      else ok('admin issue summary includes sourcePrivatePath (admin-only)');
    }
  }
  {
    const {error} = await admin.rpc('set_newsletter_cover', {p_issue_id: ISSUE_ID, p_photo_id: photoId});
    if (error) bad('admin set_newsletter_cover', error.message);
    else ok('admin set_newsletter_cover');
  }
  {
    const {error} = await admin.rpc('set_newsletter_photo_approved', {p_id: photoId, p_approved: true});
    if (error) bad('admin set_newsletter_photo_approved', error.message);
    else ok('admin set_newsletter_photo_approved(true)');
  }
  // publish
  {
    const {data, error} = await admin.rpc('publish_newsletter_issue', {p_id: ISSUE_ID});
    if (error) bad('admin publish_newsletter_issue', error.message);
    else if (data.status !== 'published') bad('issue published', data.status);
    else ok('admin publish_newsletter_issue -> published');
  }
  // anon published payload: exposes approved public path, NEVER the private source
  {
    const {data, error} = await anon.rpc('get_published_newsletter', {p_slug: slug});
    const blob = JSON.stringify(data || {});
    if (error) bad('anon get_published_newsletter', error.message);
    else if (!data) bad('anon published payload present', 'null');
    else if (data.noindex !== true) bad('published noindex locked true', JSON.stringify(data.noindex));
    else if (!Array.isArray(data.photos) || data.photos.length !== 1) bad('published exposes 1 approved photo', blob);
    else if (data.photos[0].storagePath !== PUBLIC_PATH) bad('published photo public path', blob);
    else if (blob.includes(SECRET_PRIVATE_PATH)) bad('published payload leaks private source path', blob);
    else if (blob.includes('sourcePrivatePath') || blob.includes('source_private_path'))
      bad('published payload has source-path key', blob);
    else ok('anon published payload: approved public path only, no private source path, noindex=true');
  }
  // publish rotated/disabled preview: old token now denied
  {
    const {data} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: previewToken});
    if (data !== null) bad('publish disables old preview token', JSON.stringify(data));
    else ok('old preview token denied after publish');
  }
  // regenerate is rejected for a published issue (preview is draft-only)...
  {
    const {error} = await admin.rpc('regenerate_newsletter_preview_token', {p_id: ISSUE_ID});
    if (!error) bad('regenerate on published rejected', 'unexpected success');
    else if (!/draft/i.test(error.message || '')) bad('regenerate published error mentions draft', error.message);
    else ok('regenerate on published rejected -> ' + error.message);
  }
  // ...and a published issue stays unreachable via preview even after the attempt
  {
    const {data} = await service.from('newsletter_issues').select('preview_token').eq('id', ISSUE_ID).single();
    const tok = data && data.preview_token;
    const {data: prev} = await anon.rpc('get_newsletter_preview', {p_slug: slug, p_token: tok});
    if (prev !== null) bad('published issue preview stays disabled', JSON.stringify(prev));
    else ok('published issue preview stays disabled (draft-only)');
  }
  // anon still cannot see this issue's fact/intake/runs via any anon RPC (no such RPC exists) -
  // confirm published list now contains it (sanity)
  {
    const {data, error} = await anon.rpc('list_published_newsletters');
    if (error) bad('anon list after publish', error.message);
    else if (!data.find((x) => x.slug === slug)) bad('published issue in anon list', JSON.stringify(data));
    else ok('published issue appears in anon list_published_newsletters');
  }

  // ── storage buckets ──
  console.log('verifying storage buckets...');
  {
    const {data, error} = await service.storage.listBuckets();
    if (error) bad('listBuckets', error.message);
    else {
      const staging = data.find((b) => b.id === 'newsletter-staging');
      const pub = data.find((b) => b.id === 'newsletter-public');
      if (!staging) bad('newsletter-staging exists');
      else if (staging.public !== false) bad('newsletter-staging is private', JSON.stringify(staging.public));
      else ok('newsletter-staging exists (private)');
      if (!pub) bad('newsletter-public exists');
      else if (pub.public !== true) bad('newsletter-public is public', JSON.stringify(pub.public));
      else ok('newsletter-public exists (public)');
    }
  }

  // ── cleanup ──
  await admin.auth.signOut();
  await service.from('newsletter_issues').delete().eq('id', ISSUE_ID);
  console.log('cleanup: removed throwaway issue ' + ISSUE_ID);

  if (failures > 0) {
    console.error(`\n${failures} verification(s) FAILED`);
    process.exit(1);
  }
  console.log('\nmig 144 + 145 TEST apply + boundary verification: all checks passed');
})().catch((e) => {
  console.error('unexpected error:', e && e.message ? e.message : e);
  process.exit(1);
});
