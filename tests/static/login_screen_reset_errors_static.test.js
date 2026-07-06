import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/auth/LoginScreen.jsx'), 'utf8');

describe('LoginScreen forgot-password error handling', () => {
  it('turns invalid sign-in credentials into an account-email hint', () => {
    expect(src).toMatch(/function\s+signInErrorMessage\(message\)/);
    expect(src).toMatch(/Invalid email or password\. Use the email your WCF Planner account was created with\./);
    expect(src).toMatch(/setError\(signInErrorMessage\(error\.message\)\)/);
  });

  it('unwraps rapid-processor non-2xx responses instead of showing the generic Supabase wrapper message', () => {
    expect(src).toMatch(/import\s+\{unwrapEdgeFunctionError\}\s+from\s+['"]\.\.\/lib\/edgeErrors\.js['"]/);
    expect(src).toMatch(/const\s+msg\s*=\s*await\s+unwrapEdgeFunctionError\(err\)/);
    expect(src).toMatch(/setError\(msg\s*\|\|\s*['"]Could not send reset email\. Please try again\.['"]\)/);
  });

  it('trims email before sign-in and password reset calls', () => {
    expect(src).toMatch(/signInWithPassword\(\s*\{\s*email:\s*email\.trim\(\),\s*password\s*\}/);
    expect(src).toMatch(/data:\s*\{\s*email:\s*email\.trim\(\)\s*\}/);
  });

  it('clears stale reset errors when switching between login and reset modes', () => {
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*setError\(''\);\s*setResetSent\(false\);\s*setMode\('reset'\);/);
    expect(src).toMatch(/onClick=\{\(\)\s*=>\s*\{\s*setError\(''\);\s*setMode\('login'\);\s*setResetSent\(false\);/);
  });
});
