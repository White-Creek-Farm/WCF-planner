import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static lock for the user_create branch in supabase-functions/rapid-processor.ts
// and the matching UsersModal handling. Pinned by Codex 2026-05-14 hardening
// after Brian's Add User attempt failed with generic "Internal Server Error".
//
// The migration goals these locks enforce:
//   1. Per-step error labeling (createUser / profileCreate / generateLink / sendEmail)
//      so the response body identifies WHERE the failure happened.
//   2. Config preflight returns named missing-env list (no secret values).
//   3. sendEmail uses AbortController timeout + res.text + defensive JSON
//      parse + res.ok gate; never let res.json() swallow the real error.
//   4. Non-fatal sendEmail: auth account succeeded → return ok:true with
//      welcomeEmailDelivered:false + emailError + step:'sendEmail'.
//   5. profileCreate / generateLink failures return structured 500 with
//      `partial` so admins know not to retry blindly.
//   6. UsersModal renders a WARNING (not a green success) when
//      welcomeEmailDelivered === false.
//   7. Admins may set an initial password and bypass email delivery entirely.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const fnSrc = fs.readFileSync(path.join(ROOT, 'supabase-functions/rapid-processor.ts'), 'utf8');
const modalSrc = fs.readFileSync(path.join(ROOT, 'src/auth/UsersModal.jsx'), 'utf8');

// Extract just the user_create branch body so policy assertions don't get
// confused by similar patterns elsewhere in the file (user_delete also has
// an is_admin gate, for example).
const userCreateBlock = (() => {
  const start = fnSrc.indexOf("if (type === 'user_create')");
  if (start === -1) return '';
  // Scan forward for the matching close-brace of the if block by counting
  // braces. Crude but reliable on a hand-written function.
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < fnSrc.length; i += 1) {
    const ch = fnSrc[i];
    if (ch === '{') {
      depth += 1;
      seenOpen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seenOpen && depth === 0) return fnSrc.slice(start, i + 1);
    }
  }
  return '';
})();

describe('rapid-processor user_create — per-step error labeling', () => {
  it('user_create branch is present', () => {
    expect(userCreateBlock.length).toBeGreaterThan(500);
  });

  it('config preflight checks all 4 required env vars and names them in the error', () => {
    expect(userCreateBlock).toMatch(/missingEnv[\s\S]*?SUPABASE_URL/);
    expect(userCreateBlock).toMatch(/missingEnv[\s\S]*?SUPABASE_ANON_KEY/);
    expect(userCreateBlock).toMatch(/missingEnv[\s\S]*?SUPABASE_SERVICE_ROLE_KEY/);
    expect(userCreateBlock).toMatch(/missingEnv[\s\S]*?RESEND_API_KEY/);
    expect(userCreateBlock).toMatch(/step:\s*'config'/);
  });

  it('does not echo secret VALUES (only NAMES) in the config error response', () => {
    // The config-missing branch must reference the missingEnv array by
    // value, never substitute in process.env or the actual secret.
    expect(userCreateBlock).toMatch(/missing env \$\{missingEnv\.join\(', '\)\}/);
    expect(userCreateBlock).not.toMatch(/JSON\.stringify\([^)]*SUPABASE_SERVICE_ROLE_KEY/);
    expect(userCreateBlock).not.toMatch(/JSON\.stringify\([^)]*RESEND_API_KEY/);
  });

  it('createUser is wrapped in its own try/catch with a labeled error', () => {
    expect(userCreateBlock).toMatch(/step:\s*'createUser'/);
    expect(userCreateBlock).toMatch(/`createUser: \$\{/);
  });

  it('profileCreate is wrapped with labeled error + partial hint', () => {
    expect(userCreateBlock).toMatch(/step:\s*'profileCreate'/);
    expect(userCreateBlock).toMatch(/`profileCreate: \$\{/);
    expect(userCreateBlock).toMatch(/authUserId: createdUserId/);
    expect(userCreateBlock).toMatch(/do NOT retry/i);
    // Insert-only: the mig-183 RPC refuses an existing profile, so this step
    // no longer performs an upsert.
    expect(userCreateBlock).toMatch(/admin_create_user_profile/);
    expect(userCreateBlock).not.toMatch(/profileUpsert/);
  });

  it('generateLink is wrapped with labeled error + partial hint', () => {
    expect(userCreateBlock).toMatch(/step:\s*'generateLink'/);
    expect(userCreateBlock).toMatch(/`generateLink: \$\{/);
    expect(userCreateBlock).toMatch(/recoveryLinkCreated: false/);
    expect(userCreateBlock).toMatch(/Send Password Reset/);
  });

  it('sendEmail uses an AbortController timeout', () => {
    expect(userCreateBlock).toMatch(/new AbortController\(\)/);
    expect(userCreateBlock).toMatch(/setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
    expect(userCreateBlock).toMatch(/signal: controller\.signal/);
    expect(userCreateBlock).toMatch(/clearTimeout\(timeoutId\)/);
  });

  it('sendEmail reads body via text + defensive JSON.parse + res.ok gate', () => {
    expect(userCreateBlock).toMatch(/await res\.text\(\)/);
    expect(userCreateBlock).toMatch(/try \{[\s\S]*?JSON\.parse\(bodyText\)/);
    expect(userCreateBlock).toMatch(/if \(!res\.ok\)/);
    // Never call res.json() directly in the new path — that's the bug
    // we're undoing (it would swallow a non-JSON Resend response).
    expect(userCreateBlock).not.toMatch(/await res\.json\(\)/);
  });

  it('sendEmail failure is NON-fatal: return ok:true with welcomeEmailDelivered:false + emailError', () => {
    expect(userCreateBlock).toMatch(/welcomeEmailDelivered\s*=\s*false/);
    expect(userCreateBlock).toMatch(/welcomeEmailDelivered\s*=\s*true/);
    expect(userCreateBlock).toMatch(/ok:\s*true,\s*\n\s*user:[\s\S]*?welcomeEmailDelivered/);
    expect(userCreateBlock).toMatch(/emailError: `sendEmail: \$\{emailError\}`/);
    expect(userCreateBlock).toMatch(/step:\s*'sendEmail'/);
    expect(userCreateBlock).toMatch(/Resend timed out after 10s/);
  });

  it('partial=true cases still return 500 and include the auth user id so admins can repair', () => {
    expect(userCreateBlock).toMatch(/partial: \{authUserId: createdUserId,[^}]*profileCreated: false\}/);
    expect(userCreateBlock).toMatch(
      /partial: \{authUserId: createdUserId,[^}]*profileCreated: true,[^}]*recoveryLinkCreated: false\}/,
    );
  });

  it('auth + is_admin gates still labeled with step keys', () => {
    expect(userCreateBlock).toMatch(/step:\s*'auth'/);
    expect(userCreateBlock).toMatch(/step:\s*'is_admin'/);
  });

  it('input validation still labeled with step="input"', () => {
    expect(userCreateBlock).toMatch(/email required[\s\S]{0,80}step:\s*'input'/);
  });

  it('manual password path validates length and bypasses Resend/recovery email', () => {
    expect(userCreateBlock).toMatch(/initialPassword/);
    expect(userCreateBlock).toMatch(/useManualPassword/);
    expect(userCreateBlock).toMatch(/manualPasswordBytes/);
    expect(userCreateBlock).toMatch(/initial password must be 6-72 bytes/);
    expect(userCreateBlock).toMatch(/password:\s*useManualPassword\s*\?\s*manualPassword\s*:\s*tempPw/);
    expect(userCreateBlock).toMatch(/manualPasswordSet:\s*true/);
    expect(userCreateBlock).toMatch(/if\s*\(\s*useManualPassword\s*\)[\s\S]*?return new Response/);
  });

  // ────────────────────────────────────────────────────────────────────
  // Regression lock: GoTrue's bcrypt has a hard 72-byte input limit and
  // PANICS rather than truncates when exceeded. The original
  // `wcf_${uuid}_${uuid}` shape was 4 + 36 + 1 + 36 = 77 bytes and
  // every user_create attempt failed with "500: Internal Server Error".
  // Lock the template so any future "make passwords stronger" edit that
  // adds a second UUID (or any other concatenation that pushes the
  // worst-case length over 72) trips this test.
  // ────────────────────────────────────────────────────────────────────

  it('tempPw template fits inside bcrypt 72-byte limit (worst-case)', () => {
    const m = userCreateBlock.match(/const tempPw = `([^`]+)`/);
    expect(m, 'expected const tempPw = `...` template literal').not.toBeNull();
    const template = m[1];
    // Replace every ${...} placeholder with its worst-case byte length:
    //   crypto.randomUUID() → 36 bytes (UUIDv4 canonical form)
    //   any other interpolation we don't recognize → fail loudly so a
    //   future edit can't silently add a long substitution.
    const placeholders = [...template.matchAll(/\$\{([^}]+)\}/g)];
    for (const p of placeholders) {
      expect(p[1].trim(), `unknown tempPw interpolation: ${p[1]}`).toBe('crypto.randomUUID()');
    }
    const literalBytes = template.replace(/\$\{[^}]+\}/g, '').length;
    const worstCaseBytes = literalBytes + placeholders.length * 36;
    expect(worstCaseBytes).toBeLessThanOrEqual(72);
  });

  it('tempPw uses exactly one randomUUID (lock against the 77-byte two-UUID regression)', () => {
    const pwLine = userCreateBlock.match(/const tempPw = `[^`]+`/)[0];
    const uuidCount = (pwLine.match(/crypto\.randomUUID\(\)/g) || []).length;
    expect(uuidCount).toBe(1);
  });
});

describe('UsersModal.createUser — honors welcomeEmailDelivered:false', () => {
  it('captures both data and error from sb.functions.invoke', () => {
    expect(modalSrc).toMatch(/const \{data: fnData, error\} = await sb\.functions\.invoke\('rapid-processor'/);
  });

  it('renders a warning (umErr, not umMsg) when welcomeEmailDelivered === false', () => {
    expect(modalSrc).toMatch(/fnData && fnData\.welcomeEmailDelivered === false/);
    expect(modalSrc).toMatch(/Account created for[\s\S]*?welcome email failed/);
    expect(modalSrc).toMatch(/Use Send Password Reset/);
  });

  it('still shows the green "Invite sent" success on welcomeEmailDelivered:true', () => {
    // Source escapes the check-mark as ✅ per the project's JSX
    // escape convention; match the escape, not the literal glyph.
    expect(modalSrc).toMatch(/\\u2705 Invite sent to[\s\S]*?set their password/);
  });

  it('supports creating a user with an admin-set password and no email send', () => {
    expect(modalSrc).toMatch(/addPassword/);
    expect(modalSrc).toMatch(/addPasswordConfirm/);
    expect(modalSrc).toMatch(/payload\.initialPassword\s*=\s*addPassword/);
    expect(modalSrc).toMatch(/manualPasswordSet/);
    expect(modalSrc).toMatch(/No email was sent/);
    expect(modalSrc).toMatch(/Create User with Password/);
  });

  it('error path continues to use unwrapEdgeFunctionError', () => {
    expect(modalSrc).toMatch(/const msg = await unwrapEdgeFunctionError\(e\)/);
  });
});
