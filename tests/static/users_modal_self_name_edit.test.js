import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/auth/UsersModal.jsx'), 'utf8');

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const code = stripComments(src);

describe('UsersModal self name editing', () => {
  it('creates new users through the admin edge function, not public auth.signUp', () => {
    const createUserBody =
      code.match(/async function createUser[\s\S]*?\n\s*async function sendPasswordReset/)?.[0] || '';

    expect(createUserBody).toMatch(/type:\s*'user_create'/);
    expect(createUserBody).not.toMatch(/auth\.signUp/);
    expect(createUserBody).not.toMatch(/type:\s*'user_welcome'/);
  });

  it('uses AuthContext so self name edits refresh the signed-in header name', () => {
    expect(code).toMatch(/from '\.\.\/contexts\/AuthContext\.jsx'/);
    expect(code).toMatch(/useAuth\(\)/);
    expect(code).toMatch(/setAuthState/);
  });

  it('updates authState when updateName saves the current user', () => {
    const updateNameBody = code.match(/async function updateName[\s\S]*?setEditingUser\(null\);\s*\n\s*}/)?.[0] || '';

    expect(updateNameBody).toMatch(/userId\s*===\s*authState\?\.user\?\.id/);
    expect(updateNameBody).toMatch(
      /profile:\s*prev\.profile\s*\?\s*{\s*\.\.\.prev\.profile,\s*full_name:\s*savedName\s*}/,
    );
    expect(updateNameBody).toMatch(/name:\s*savedName\s*\|\|\s*prev\.user\?\.email/);
  });

  it('renders the edit-name button without excluding the current user', () => {
    const nameRow =
      code.match(/<div style={{display: 'flex', alignItems: 'center', gap: 4[\s\S]*?<\/button>/)?.[0] || '';

    expect(nameRow).toMatch(/aria-label={`Edit name for/);
    expect(nameRow).toMatch(/setEditingUser\({id:\s*u\.id,\s*full_name:\s*u\.full_name\s*\|\|\s*''}\)/);
    expect(nameRow).not.toMatch(/u\.id\s*!==\s*authState\?\.user\?\.id[\s\S]{0,160}<button/);
  });

  it('keeps self role changes disabled', () => {
    expect(code).toMatch(/disabled={u\.id\s*===\s*authState\?\.user\?\.id\s*\|\|\s*userMutationBusy}/);
    expect(code).toMatch(
      /cursor:\s*u\.id\s*===\s*authState\?\.user\?\.id\s*\|\|\s*userMutationBusy\s*\?\s*'not-allowed'/,
    );
  });

  it('keeps self program access and destructive account actions hidden', () => {
    expect(code).toMatch(/u\.id\s*!==\s*authState\?\.user\?\.id\s*&&\s*u\.role\s*!==\s*'admin'/);
    expect(code).toMatch(/u\.id\s*!==\s*authState\?\.user\?\.id\s*&&\s*\(/);
    expect(code).toMatch(/sendPasswordReset\(u\.id,\s*u\.email,\s*u\.full_name\)/);
    expect(code).toMatch(/deactivateUser\(u\.id,\s*u\.email\)/);
    expect(code).toMatch(/deleteUser\(u\.id,\s*u\.email\)/);
  });
});
