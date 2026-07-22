import {beforeEach, describe, expect, it, vi} from 'vitest';
import {__resetTestAdminIdentityCache, ensureTestAdminProfile, resolveTestAdminIdentity} from './testAdminIdentity.js';

const ADMIN_EMAIL = 'admin@wcfplanner.test';

// Minimal fake: auth.admin.listUsers({page, perPage}) served from a page map,
// plus a from().upsert() spy. Records every listUsers call for cache assertions.
function makeClient({pages, upsertResult = {error: null}} = {}) {
  const listUsers = vi.fn(async ({page}) => {
    if (pages instanceof Error) throw pages;
    return {data: {users: pages[page] || []}, error: null};
  });
  const upsert = vi.fn(async () => upsertResult);
  return {
    auth: {admin: {listUsers}},
    from: vi.fn(() => ({upsert})),
    _listUsers: listUsers,
    _upsert: upsert,
  };
}

function dummies(n) {
  return Array.from({length: n}, (_, i) => ({id: `u-${i}`, email: `user${i}@wcfplanner.test`}));
}

beforeEach(() => {
  __resetTestAdminIdentityCache();
  process.env.VITE_TEST_ADMIN_EMAIL = ADMIN_EMAIL;
});

describe('resolveTestAdminIdentity', () => {
  it('resolves the admin on the first page', async () => {
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    const id = await resolveTestAdminIdentity(client);
    expect(id).toEqual({id: 'admin-1', email: ADMIN_EMAIL});
    expect(client._listUsers).toHaveBeenCalledTimes(1);
  });

  it('paginates past a full first page to find an admin beyond it', async () => {
    // Page 1 is full (200 non-matching), so resolution must fetch page 2.
    const client = makeClient({
      pages: {1: dummies(200), 2: [{id: 'admin-2', email: ADMIN_EMAIL}]},
    });
    const id = await resolveTestAdminIdentity(client);
    expect(id).toEqual({id: 'admin-2', email: ADMIN_EMAIL});
    expect(client._listUsers).toHaveBeenCalledTimes(2);
  });

  it('caches the identity — a second call does not hit listUsers again', async () => {
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    const first = await resolveTestAdminIdentity(client);
    const second = await resolveTestAdminIdentity(client);
    expect(second).toBe(first); // same frozen reference
    expect(client._listUsers).toHaveBeenCalledTimes(1);
  });

  it('caches nothing but {id, email} — no session, token, or extra user fields', async () => {
    const client = makeClient({
      pages: {
        1: [{id: 'admin-1', email: ADMIN_EMAIL, role: 'authenticated', access_token: 'SECRET', app_metadata: {}}],
      },
    });
    const id = await resolveTestAdminIdentity(client);
    expect(Object.keys(id).sort()).toEqual(['email', 'id']);
  });

  it('fails loudly when the admin is absent across all pages', async () => {
    const client = makeClient({pages: {1: dummies(3)}});
    await expect(resolveTestAdminIdentity(client)).rejects.toThrow(/not found in auth\.users/);
  });

  it('fails loudly when the admin email is duplicated on a page (ambiguous)', async () => {
    const client = makeClient({
      pages: {
        1: [
          {id: 'admin-a', email: ADMIN_EMAIL},
          {id: 'admin-b', email: ADMIN_EMAIL},
        ],
      },
    });
    await expect(resolveTestAdminIdentity(client)).rejects.toThrow(/ambiguous/);
  });

  it('fails loudly on a duplicate that appears on a LATER page (full-scan ambiguity)', async () => {
    // Page 1 is full and already contains the admin; the duplicate hides on
    // page 2. A stop-at-first-match scan would miss it — a full scan catches it.
    const client = makeClient({
      pages: {
        1: [...dummies(199), {id: 'admin-a', email: ADMIN_EMAIL}],
        2: [{id: 'admin-b', email: ADMIN_EMAIL}],
      },
    });
    await expect(resolveTestAdminIdentity(client)).rejects.toThrow(/ambiguous/);
    expect(client._listUsers).toHaveBeenCalledTimes(2); // it did scan past page 1
  });

  it('matches the admin by normalized email (case/whitespace-insensitive)', async () => {
    process.env.VITE_TEST_ADMIN_EMAIL = `  ${ADMIN_EMAIL.toUpperCase()}  `;
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    const id = await resolveTestAdminIdentity(client);
    expect(id).toEqual({id: 'admin-1', email: ADMIN_EMAIL});
  });

  it('fails when VITE_TEST_ADMIN_EMAIL is unset', async () => {
    delete process.env.VITE_TEST_ADMIN_EMAIL;
    const client = makeClient({pages: {1: []}});
    await expect(resolveTestAdminIdentity(client)).rejects.toThrow(/VITE_TEST_ADMIN_EMAIL/);
  });

  it('surfaces a listUsers error rather than swallowing it', async () => {
    const client = makeClient({pages: {}});
    client.auth.admin.listUsers = vi.fn(async () => ({data: null, error: {message: 'boom'}}));
    await expect(resolveTestAdminIdentity(client)).rejects.toThrow(/boom/);
  });

  it('__resetTestAdminIdentityCache forces a fresh lookup', async () => {
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    await resolveTestAdminIdentity(client);
    __resetTestAdminIdentityCache();
    await resolveTestAdminIdentity(client);
    expect(client._listUsers).toHaveBeenCalledTimes(2);
  });
});

describe('ensureTestAdminProfile', () => {
  it('resolves then upserts the profile with role admin', async () => {
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    const id = await ensureTestAdminProfile(client);
    expect(id).toEqual({id: 'admin-1', email: ADMIN_EMAIL});
    expect(client.from).toHaveBeenCalledWith('profiles');
    expect(client._upsert).toHaveBeenCalledWith({id: 'admin-1', email: ADMIN_EMAIL, role: 'admin'}, {onConflict: 'id'});
  });

  it('runs the profile upsert on every call (role-restore guard, not cached)', async () => {
    const client = makeClient({pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]}});
    await ensureTestAdminProfile(client);
    await ensureTestAdminProfile(client);
    expect(client._upsert).toHaveBeenCalledTimes(2); // upsert repeats
    expect(client._listUsers).toHaveBeenCalledTimes(1); // identity cached
  });

  it('throws when the profile upsert fails', async () => {
    const client = makeClient({
      pages: {1: [{id: 'admin-1', email: ADMIN_EMAIL}]},
      upsertResult: {error: {message: 'rls denied'}},
    });
    await expect(ensureTestAdminProfile(client)).rejects.toThrow(/rls denied/);
  });
});
