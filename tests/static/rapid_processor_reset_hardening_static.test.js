import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// CC#8 takeover hotfix — password_reset / user_welcome hardening lock
// ============================================================================
// rapid-processor is deployed --no-verify-jwt, so every branch that can mint a
// recovery link or send an account email must gate itself. The audit found two
// unauthenticated recovery-link generators (password_reset and the legacy
// user_welcome) that honored a caller-supplied test_to, letting an anonymous
// caller have a victim's real recovery link delivered to an attacker-controlled
// inbox (account takeover), plus an account-enumeration oracle on the public
// forgot-password path.
//
// This static suite locks the fix in source so a redeploy from the flat-file
// path (supabase-functions/<name>.ts) cannot regress it:
//   - password_reset never honors test_to (no redirect, no [TEST] subject);
//   - the recipient is always the Auth-resolved email, and the branch fails
//     closed when no account email resolves;
//   - admin vs public behavior is decided from verified identity (is_admin on
//     the caller bearer), never a caller-supplied mode;
//   - the public path returns one fixed body for unknown/failure/success;
//   - the admin path keeps truthful reporting;
//   - user_welcome is gone and cannot generate a link or email;
//   - user_create stays admin-gated with its approved test_to behavior intact.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'supabase-functions/rapid-processor.ts'), 'utf8');
const login = fs.readFileSync(path.join(ROOT, 'src/auth/LoginScreen.jsx'), 'utf8');

// Strip comments so prose that mentions test_to / user_welcome can't satisfy a
// regex. Anchor line-comment stripping to start-of-line so template-literal
// URLs survive.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

// Branch order after the hotfix: egg_report, starter_feed_check, user_create,
// password_reset, user_delete, tasks_weekly_summary.
function branch(type, nextType) {
  const start = code.indexOf(`if (type === '${type}')`);
  if (start === -1) return '';
  const end = nextType ? code.indexOf(`if (type === '${nextType}')`, start + 1) : -1;
  return code.slice(start, end < 0 ? code.length : end);
}

const resetBranch = branch('password_reset', 'user_delete');
const createBranch = branch('user_create', 'password_reset');

describe('password_reset — never honors test_to (F1)', () => {
  it('branch exists', () => {
    expect(resetBranch.length).toBeGreaterThan(500);
  });

  it('contains no test_to recipient or subject behavior at all', () => {
    expect(resetBranch).not.toMatch(/test_to/);
  });

  it('emits no [TEST] subject and no test banner (isTest is a literal false)', () => {
    expect(resetBranch).not.toMatch(/\[TEST\]/);
    expect(resetBranch).toMatch(/passwordResetHtml\(\s*name\s*,\s*resetLink\s*,\s*false\s*\)/);
  });

  it('sends only to the Auth-resolved email, never the request input', () => {
    expect(resetBranch).toMatch(/resolvedEmail\s*=\s*linkData\?\.user\?\.email/);
    expect(resetBranch).toMatch(/to:\s*\[\s*resolvedEmail\s*\]/);
    // The raw request `email` must not be a Resend recipient.
    expect(resetBranch).not.toMatch(/to:\s*\[\s*email\s*\]/);
  });

  it('fails closed when generateLink yields no resolved account email', () => {
    expect(resetBranch).toMatch(/if\s*\(\s*!resetLink\s*\|\|\s*!resolvedEmail\s*\)/);
  });
});

describe('password_reset — admin vs public decided by verified identity (F1/F3)', () => {
  it('resolves admin status from the caller bearer via is_admin, not a caller flag', () => {
    expect(resetBranch).toMatch(/req\.headers\.get\(\s*'authorization'\s*\)/);
    expect(resetBranch).toMatch(/createClient\(\s*SUPABASE_URL\s*,\s*SUPABASE_ANON_KEY/);
    expect(resetBranch).toMatch(/global:\s*\{\s*headers:\s*\{\s*Authorization:\s*authHeader/);
    expect(resetBranch).toMatch(/userClient\.rpc\(\s*'is_admin'\s*\)/);
    expect(resetBranch).toMatch(/isAdmin\s*=\s*isAdminData\s*===\s*true/);
    // No caller-supplied "mode"/"admin" switch decides trust level.
    expect(resetBranch).not.toMatch(/data\?\.(mode|isAdmin|admin)\b/);
  });

  it('public path returns one fixed acknowledgement for every outcome', () => {
    // The generic body is exactly {ok, message} — no step/error/provider field.
    expect(resetBranch).toMatch(
      /PUBLIC_ACCEPTED\s*=\s*\{\s*ok:\s*true,\s*message:\s*'If an account exists, a reset link has been sent\.'\s*\}/,
    );
    // Every non-admin decision point short-circuits to the same response
    // (config, empty email, unknown account, fail-closed, send failure,
    // send timeout, and success) — one shared helper, many call sites.
    const publicReturns = (resetBranch.match(/if\s*\(\s*!isAdmin\s*\)\s*return\s*publicResponse\(\);/g) || []).length;
    expect(publicReturns).toBeGreaterThanOrEqual(6);
  });

  it('public unknown-account and public send-failure use the SAME generic response', () => {
    // Unknown account: generateLink throws → public short-circuit.
    const genLinkCatch = resetBranch.indexOf('const missingAccount');
    const preCatch = resetBranch.lastIndexOf('if (!isAdmin) return publicResponse();', genLinkCatch);
    expect(preCatch).toBeGreaterThan(-1);
    // Provider failure (!res.ok) and network/timeout also short-circuit public.
    expect(resetBranch).toMatch(
      /if\s*\(\s*!res\.ok\s*\)\s*\{\s*if\s*\(\s*!isAdmin\s*\)\s*return\s*publicResponse\(\);/,
    );
  });

  it('admin path keeps truthful unknown-account and delivery-failure reporting', () => {
    expect(resetBranch).toMatch(/No WCF Planner account was found for that email/);
    expect(resetBranch).toMatch(/status:\s*missingAccount\s*\?\s*404\s*:\s*500/);
    expect(resetBranch).toMatch(/step:\s*'generateLink'/);
    expect(resetBranch).toMatch(/step:\s*'sendEmail'/);
    expect(resetBranch).toMatch(/status:\s*502/);
    expect(resetBranch).toMatch(/Resend timed out after 10s/);
  });
});

describe('every recovery-link-generating branch is gated (F2 / no-verify-jwt contract)', () => {
  it('user_welcome is removed and cannot generate a link or email', () => {
    expect(code).not.toMatch(/if\s*\(\s*type\s*===\s*'user_welcome'\s*\)/);
  });

  it('generateLink appears only in the admin-gated user_create and the hardened password_reset', () => {
    const total = (code.match(/admin\.auth\.admin\.generateLink\(/g) || []).length;
    expect(total).toBe(2);
    // user_create resolves is_admin before generating a link.
    const createGate = createBranch.indexOf("rpc('is_admin')");
    const createLink = createBranch.indexOf('admin.auth.admin.generateLink(');
    expect(createGate).toBeGreaterThan(-1);
    expect(createLink).toBeGreaterThan(createGate);
    // password_reset resolves is_admin before generating a link.
    const resetGate = resetBranch.indexOf("rpc('is_admin')");
    const resetLink = resetBranch.indexOf('admin.auth.admin.generateLink(');
    expect(resetGate).toBeGreaterThan(-1);
    expect(resetLink).toBeGreaterThan(resetGate);
  });
});

describe('user_create remains admin-gated with its approved test_to unchanged', () => {
  it('is_admin gate precedes createUser', () => {
    const gate = createBranch.indexOf("rpc('is_admin')");
    const create = createBranch.indexOf('admin.auth.admin.createUser');
    expect(gate).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(gate);
  });

  it('keeps its approved welcome-email test_to redirect (admin-only branch)', () => {
    expect(createBranch).toMatch(/to:\s*test_to\s*\?\s*\[\s*test_to\s*\]\s*:\s*\[\s*email\s*\]/);
  });
});

describe('LoginScreen — delivery-agnostic public copy (F3/F6)', () => {
  it('confirmation and prompt no longer assert delivery, and do not leak account existence', () => {
    expect(login).toMatch(/If an account exists, a reset link has been sent/);
    expect(login).not.toMatch(/Check your email for a password reset link\./);
  });
});

// ============================================================================
// Mig 183 — public throttle gate + admin reset ledger evidence
// ============================================================================

describe('password_reset — public throttle gate (mig 183)', () => {
  it('calls the service-role gate with a domain-separated HMAC email key and no raw IP', () => {
    expect(resetBranch).toMatch(/rpc\(\s*'_password_reset_gate'\s*,/);
    expect(resetBranch).toMatch(/p_email_key:\s*await\s+hmacKey\(\s*'email'\s*,\s*email\s*\)/);
    // The key is an HMAC over a server-only secret, not a reversible plain hash.
    expect(code).toMatch(/async function\s+hmacKey\(/);
    expect(code).toMatch(/name:\s*'HMAC',\s*hash:\s*'SHA-256'/);
    expect(code).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(code).toMatch(/`\$\{domain\}:\$\{value\}`/);
    // No IP is passed or read: the spoofable Edge client IP is not a security id.
    expect(resetBranch).not.toMatch(/p_ip:/);
    expect(resetBranch).not.toMatch(/x-forwarded-for/);
    // The retired plain-SHA-256 helper is gone.
    expect(code).not.toMatch(/function\s+sha256Hex\(/);
  });

  it('runs the gate before the config preflight and before generateLink', () => {
    const gateIdx = resetBranch.indexOf('_password_reset_gate');
    const preflightIdx = resetBranch.indexOf("missingEnv.push('SUPABASE_URL')");
    const genLinkIdx = resetBranch.indexOf('admin.auth.admin.generateLink(');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(preflightIdx);
    expect(gateIdx).toBeLessThan(genLinkIdx);
  });

  it('blocked and gate-error outcomes both return the uniform public body (fail-closed-silent)', () => {
    expect(resetBranch).toMatch(
      /if\s*\(\s*gateError\s*\|\|\s*gateData\?\.allowed\s*!==\s*true\s*\)\s*return\s*publicResponse\(\);/,
    );
    // The whole gate is public-only: admins bypass it.
    const gateIdx = resetBranch.indexOf('_password_reset_gate');
    const bypassIdx = resetBranch.lastIndexOf('if (!isAdmin) {', gateIdx);
    expect(bypassIdx).toBeGreaterThan(-1);
  });
});

describe('password_reset — admin ledger evidence (mig 183)', () => {
  it('writes profile.reset_requested after fail-closed resolution and BEFORE any send', () => {
    const failClosedIdx = resetBranch.indexOf('if (!resetLink || !resolvedEmail)');
    const requestLogIdx = resetBranch.indexOf("rpc('admin_log_reset_request'");
    const sendIdx = resetBranch.indexOf('api.resend.com/emails');
    expect(requestLogIdx).toBeGreaterThan(-1);
    expect(requestLogIdx).toBeGreaterThan(failClosedIdx);
    expect(requestLogIdx).toBeLessThan(sendIdx);
    // Request logging is admin-only; a failed request write aborts the send.
    const guardIdx = resetBranch.lastIndexOf('if (isAdmin) {', requestLogIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(resetBranch).toMatch(/step:\s*'auditRequest'/);
  });

  it('writes the success terminal only after a Resend 2xx and failure terminals otherwise', () => {
    const sendIdx = resetBranch.indexOf('api.resend.com/emails');
    const successIdx = resetBranch.indexOf('logResetOutcome(true, null)');
    expect(successIdx).toBeGreaterThan(sendIdx);
    expect(resetBranch).toMatch(/rpc\(\s*'admin_log_reset_outcome'\s*,/);
    // Both the !res.ok branch and the fetch/timeout catch record failure.
    expect((resetBranch.match(/logResetOutcome\(false,/g) || []).length).toBeGreaterThanOrEqual(2);
    // Responses report ledger acceptance truthfully.
    expect((resetBranch.match(/auditFinalized/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  it('public callers write no ledger rows: outcome writer is admin-gated', () => {
    expect(resetBranch).toMatch(/if\s*\(!isAdmin\s*\|\|\s*!adminCaller\s*\|\|\s*!resetRequestId\)\s*return\s*true;/);
  });
});
