// ============================================================================
// TEST admin identity — resolved once per worker, profile restored per reset.
// ============================================================================
// Every scenario seed needs the test admin's auth.users id to stamp ownership
// and to keep a profiles row present. Two facts drive the design:
//
//   1. The admin's auth.users identity (id, email) is IMMUTABLE within a run —
//      the account is created once, out of band. Resolving it via
//      auth.admin.listUsers() on EVERY seed was ~67ms of pure repeat work per
//      test (measured), so it is cached once per worker/module lifetime.
//
//   2. The profiles row is NOT truncated by resetTestDatabase (see reset.js
//      "NOT truncated" list), so the row survives resets — BUT a test can
//      mutate the admin's role, and profiles is not reset, so the role would
//      leak into the next test. The idempotent profile upsert therefore still
//      runs after each reset as a role-restore guard. Only the IDENTITY lookup
//      is cached; the profile write is not.
//
// The cache holds ONLY {id, email} — never a session, token, or scenario row.
// ============================================================================

let cachedIdentity = null;

// Test-only: clear the module cache so unit tests can exercise resolution
// repeatedly within one process. Not used by seeds.
export function __resetTestAdminIdentityCache() {
  cachedIdentity = null;
}

const normalizeEmail = (value) =>
  String(value || '')
    .trim()
    .toLowerCase();

// Resolve the immutable TEST admin identity, cached once per worker. Because
// the result is cached for the whole worker, a COMPLETE scan is cheap and
// safer than stopping at the first hit: it pages through ALL users (GoTrue
// defaults to 50/page; the admin could sit past it once the project grows),
// collects every normalized-email match, and returns only when exactly one
// exists. Zero matches or more than one match — on the same OR different pages —
// fails loudly (GoTrue enforces unique email, so a duplicate signals a corrupt
// fixture). Only {id, email} is ever retained.
export async function resolveTestAdminIdentity(client) {
  if (cachedIdentity) return cachedIdentity;
  const email = process.env.VITE_TEST_ADMIN_EMAIL;
  if (!email) {
    throw new Error('resolveTestAdminIdentity: VITE_TEST_ADMIN_EMAIL must be set in .env.test.local.');
  }
  const wanted = normalizeEmail(email);
  const perPage = 200;
  const matches = [];
  for (let page = 1; ; page++) {
    const {data, error} = await client.auth.admin.listUsers({page, perPage});
    if (error) {
      throw new Error(`resolveTestAdminIdentity [listUsers page ${page}]: ${error.message}`);
    }
    const users = data?.users || [];
    for (const u of users) {
      if (normalizeEmail(u.email) === wanted) matches.push({id: u.id, email: u.email});
    }
    if (users.length < perPage) break; // short/empty final page → done
  }
  if (matches.length === 0) {
    throw new Error(
      `resolveTestAdminIdentity: test admin "${email}" not found in auth.users. ` +
        'Re-create it via the Supabase Auth dashboard.',
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `resolveTestAdminIdentity: admin email "${email}" is ambiguous — ` +
        `${matches.length} auth.users rows match across all pages.`,
    );
  }
  cachedIdentity = {id: matches[0].id, email: matches[0].email};
  return cachedIdentity;
}

// Resolve the cached identity, then run the idempotent profile upsert. The
// upsert runs on every call (not cached) because a test can mutate the admin's
// role and profiles is not reset. Throws on upsert failure so seed setup fails
// immediately. Returns the identity {id, email}.
export async function ensureTestAdminProfile(client) {
  const identity = await resolveTestAdminIdentity(client);
  const {error} = await client
    .from('profiles')
    .upsert({id: identity.id, email: identity.email, role: 'admin'}, {onConflict: 'id'});
  if (error) {
    throw new Error(`ensureTestAdminProfile [profiles upsert]: ${error.message}`);
  }
  return identity;
}
