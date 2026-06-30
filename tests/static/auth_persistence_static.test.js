import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('auth persistence', () => {
  const supabase = read('src/lib/supabase.js');
  const main = read('src/main.jsx');

  it('keeps Supabase sessions in durable browser storage with refresh enabled', () => {
    expect(supabase).toMatch(/storage:\s*window\.localStorage/);
    expect(supabase).toMatch(/storageKey:\s*'farm-planner-auth'/);
    expect(supabase).toMatch(/persistSession:\s*true/);
    expect(supabase).toMatch(/autoRefreshToken:\s*true/);
    expect(supabase).toMatch(/detectSessionInUrl:\s*false/);
  });

  it('hydrates the app from a stored session before falling back to the login screen', () => {
    expect(main).toMatch(/const AUTH_BOOT_TIMEOUT_MS = 15000/);
    expect(main).toMatch(/await sb\.auth\.getSession\(\)/);
    expect(main).toMatch(/if \(session\?\.user\) \{[\s\S]*?await loadUser\(session\.user\)/);
    expect(main).toMatch(/verifyStoredSession\(session\.user\)/);
  });

  it('preserves login state on transient auth refresh failures', () => {
    expect(main).toContain('Session verification failed; keeping stored session for retry.');
    expect(main).toContain('Session refresh failed; preserving current login for retry.');
    expect(main).toMatch(/\.refreshSession\(\)/);
    expect(main).not.toContain('Session expired, signing out');
    expect(main).not.toMatch(/getUser\(\)[\s\S]{0,260}signOut\(\)/);
  });

  it('treats refresh/update auth events as session-preserving events', () => {
    expect(main).toMatch(/\['INITIAL_SESSION', 'SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED'\]\.includes\(event\)/);
  });
});
