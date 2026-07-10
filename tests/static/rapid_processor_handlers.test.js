import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// supabase-functions/rapid-processor.ts — handler shape lock
// ============================================================================
// Codex C4 surfaced two truths about this file:
//   (a) It's the only Edge Function the legacy flat-file deploy path
//       (`supabase-functions/<name>.ts`) still owns. Every change ships via
//       a temp canonical-staging copy; the source must stay accurate so a
//       fresh redeploy doesn't drop a handler.
//   (b) `user_delete` was previously deploy-only — Ronnie pasted that
//       block live, then it survived only because no one redeployed.
//       Codex C4 BLOCKER 0 forced restoration to source. This file locks
//       all handlers so a future deploy can't silently drop one again.
//
// Every handler must:
//   - Match its `if (type === '<name>')` branch.
//   - Return JSON via the shared corsHeaders shape.
//
// tasks_weekly_summary specifics:
//   - Reads test_to from the TOP-LEVEL request body (Codex C4 amendment 5),
//     NOT data.test_to. The calling Edge Function gates cron-mode test_to
//     before it reaches this handler.
//   - Uses brandedEmail() for the wrapped HTML.
//   - Uses tasksWeeklyHtml() for the per-row table.
//   - Skips when tasks is empty (no email send).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'supabase-functions/rapid-processor.ts'), 'utf8');

// Strip block + line comments so doc-prose can't false-positive a regex
// (e.g., a comment that mentions a handler name shouldn't satisfy the
// "branch present" lock). Anchor line-comment match to start-of-line so
// URLs like `https://wcfplanner.com/...` inside template literals
// survive the strip.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

describe('rapid-processor.ts — seven handler branches present', () => {
  const handlers = [
    'egg_report',
    'starter_feed_check',
    'user_create',
    'user_welcome',
    'password_reset',
    'user_delete',
    'tasks_weekly_summary',
  ];
  for (const h of handlers) {
    it(`branch: type === '${h}'`, () => {
      const re = new RegExp(`if\\s*\\(\\s*type\\s*===\\s*'${h}'\\s*\\)`);
      expect(code).toMatch(re);
    });
  }
});

describe('rapid-processor.ts — account emails use noreply and admin-created users skip Supabase signup mail', () => {
  const userCreateIdx = code.indexOf("if (type === 'user_create')");
  // Widened from 4500 to 9000 chars: the hardening pass split createUser /
  // profileUpsert / generateLink / sendEmail into their own try blocks
  // with labeled errors + partial-state hints, which roughly doubled the
  // branch length. The downstream from:AUTH_FROM / Resend assertions
  // still need to fall inside the slice.
  const userCreateSlice = userCreateIdx >= 0 ? code.slice(userCreateIdx, userCreateIdx + 9000) : '';
  const userWelcomeIdx = code.indexOf("if (type === 'user_welcome')");
  const userWelcomeSlice = userWelcomeIdx >= 0 ? code.slice(userWelcomeIdx, userWelcomeIdx + 1600) : '';
  const passwordResetIdx = code.indexOf("if (type === 'password_reset')");
  const passwordResetSlice = passwordResetIdx >= 0 ? code.slice(passwordResetIdx, passwordResetIdx + 5200) : '';
  const eggReportIdx = code.indexOf("if (type === 'egg_report')");
  const eggReportSlice = eggReportIdx >= 0 ? code.slice(eggReportIdx, eggReportIdx + 1200) : '';
  const starterFeedIdx = code.indexOf("if (type === 'starter_feed_check')");
  const starterFeedSlice = starterFeedIdx >= 0 ? code.slice(starterFeedIdx, starterFeedIdx + 3000) : '';
  const tasksSummaryIdx = code.indexOf("if (type === 'tasks_weekly_summary')");
  const tasksSummarySlice = tasksSummaryIdx >= 0 ? code.slice(tasksSummaryIdx, tasksSummaryIdx + 3500) : '';

  it('defines separate sender constants for reports and account emails', () => {
    expect(code).toMatch(/const\s+FROM\s*=\s*'WCF Planner <reports@wcfplanner\.com>'/);
    expect(code).toMatch(/const\s+AUTH_FROM\s*=\s*'WCF Planner <noreply@wcfplanner\.com>'/);
  });

  it('user_create uses admin.createUser with email_confirm true, not public signup email', () => {
    expect(userCreateIdx).toBeGreaterThan(-1);
    expect(userCreateSlice).toMatch(/admin\.auth\.admin\.createUser\(/);
    expect(userCreateSlice).toMatch(/email_confirm:\s*true/);
    expect(userCreateSlice).not.toMatch(/signUp\(/);
  });

  it('user_create is admin-gated before createUser or the Resend email send', () => {
    const isAdminIdx = userCreateSlice.indexOf("rpc('is_admin')");
    const createUserIdx = userCreateSlice.indexOf('admin.auth.admin.createUser');
    // Hardening pass inlined the Resend fetch (instead of sendEmail()
    // helper) so the call timeout + defensive body parse can be applied
    // per-call. Anchor the ordering check to the Resend URL literal,
    // which is unique to the email step.
    const sendEmailIdx = userCreateSlice.indexOf('api.resend.com/emails');
    expect(isAdminIdx).toBeGreaterThan(-1);
    expect(createUserIdx).toBeGreaterThan(-1);
    expect(sendEmailIdx).toBeGreaterThan(-1);
    expect(isAdminIdx).toBeLessThan(createUserIdx);
    expect(isAdminIdx).toBeLessThan(sendEmailIdx);
  });

  it('welcome and password reset emails send from AUTH_FROM', () => {
    expect(userCreateSlice).toMatch(/from:\s*AUTH_FROM/);
    expect(userWelcomeSlice).toMatch(/from:\s*AUTH_FROM/);
    expect(passwordResetSlice).toMatch(/from:\s*AUTH_FROM/);
  });

  it('password_reset labels account/config/send failures instead of throwing a generic 500', () => {
    expect(passwordResetSlice).toMatch(/missingEnv\.push\('SUPABASE_URL'\)/);
    expect(passwordResetSlice).toMatch(/missingEnv\.push\('SUPABASE_SERVICE_ROLE_KEY'\)/);
    expect(passwordResetSlice).toMatch(/missingEnv\.push\('RESEND_API_KEY'\)/);
    expect(passwordResetSlice).toMatch(
      /const email = String\(data\?\.email \|\| ''\)[\s\S]*?\.trim\(\)[\s\S]*?\.toLowerCase\(\)/,
    );
    expect(passwordResetSlice).toMatch(/No WCF Planner account was found for that email/);
    expect(passwordResetSlice).toMatch(/step:\s*'generateLink'/);
    expect(passwordResetSlice).toMatch(/step:\s*'sendEmail'/);
    expect(passwordResetSlice).toMatch(/Resend timed out after 10s/);
  });

  it('operational report emails stay on reports@', () => {
    expect(eggReportSlice).toMatch(/from:\s*FROM/);
    expect(starterFeedSlice).toMatch(/from:\s*FROM/);
    expect(tasksSummarySlice).toMatch(/from:\s*FROM/);
  });
});

describe('rapid-processor.ts — user_delete admin gate (Codex C4 re-review BLOCKER 1)', () => {
  // rapid-processor is deployed with --no-verify-jwt so the platform
  // does NOT enforce auth for us. user_delete MUST verify the caller
  // is admin in-function before calling admin.auth.admin.deleteUser.
  const branchIdx = code.indexOf("if (type === 'user_delete')");
  const branchEnd = code.indexOf("if (type === 'tasks_weekly_summary')", branchIdx + 1);
  const branchSlice = branchIdx >= 0 ? code.slice(branchIdx, branchEnd) : '';

  it('admin.auth.admin.deleteUser(profileId) is the live call', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchSlice).toMatch(/admin\.auth\.admin\.deleteUser\(\s*profileId\s*\)/);
  });

  it('returns 401 (unauthorized) when no Authorization header is present', () => {
    expect(branchSlice).toMatch(/req\.headers\.get\(\s*'authorization'\s*\)/);
    expect(branchSlice).toMatch(/status:\s*401/);
    expect(branchSlice).toMatch(/'unauthorized'/);
  });

  it("calls rpc('is_admin') with the caller's bearer and requires strict-true", () => {
    expect(branchSlice).toMatch(/createClient\(\s*SUPABASE_URL\s*,\s*SUPABASE_ANON_KEY/);
    expect(branchSlice).toMatch(/global:\s*\{\s*headers:\s*\{\s*Authorization:\s*authHeader/);
    expect(branchSlice).toMatch(/userClient\.rpc\(\s*'is_admin'\s*\)/);
    expect(branchSlice).toMatch(/isAdminData\s*!==\s*true/);
  });

  it('returns 403 (forbidden) when caller is not admin', () => {
    expect(branchSlice).toMatch(/status:\s*403/);
    expect(branchSlice).toMatch(/'forbidden'/);
  });

  it('admin gate runs BEFORE the deleteUser call (no leak path)', () => {
    const isAdminIdx = branchSlice.indexOf("rpc('is_admin')");
    const deleteIdx = branchSlice.indexOf('admin.auth.admin.deleteUser');
    expect(isAdminIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(isAdminIdx).toBeLessThan(deleteIdx);
  });

  it('returns {ok: true, deleted: ...} on success', () => {
    expect(branchSlice).toMatch(/ok:\s*true,\s*deleted:/);
  });
});

describe('rapid-processor.ts — escapeHtml (Codex C4 re-review BLOCKER 2)', () => {
  it('escapeHtml helper is defined and escapes the standard 5 chars', () => {
    expect(code).toMatch(/function\s+escapeHtml\(/);
    // & < > " ' coverage.
    expect(code).toMatch(/&\s*amp;/);
    expect(code).toMatch(/&\s*lt;/);
    expect(code).toMatch(/&\s*gt;/);
    expect(code).toMatch(/&\s*quot;/);
    expect(code).toMatch(/&#39;/);
  });

  it('tasksWeeklyHtml uses escapeHtml on title, submission_source, submitted_by_team_member, due_date', () => {
    const fnMatch = code.match(/function\s+tasksWeeklyHtml\([\s\S]*?\n\}\s*\n/);
    expect(fnMatch, 'expected tasksWeeklyHtml body').not.toBeNull();
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.due_date/);
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.title/);
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.submission_source/);
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.submitted_by_team_member/);
  });

  it('tasks_weekly_summary handler escapes full_name before brandedEmail subtitle', () => {
    const branchIdx = code.indexOf("if (type === 'tasks_weekly_summary')");
    const branchSlice = code.slice(branchIdx, branchIdx + 3000);
    expect(branchSlice).toMatch(/subtitle:\s*escapeHtml\(\s*full_name\s*\|\|\s*''\s*\)/);
  });
});

describe('rapid-processor.ts — tasks_weekly_summary handler shape (C4)', () => {
  const branchIdx = code.indexOf("if (type === 'tasks_weekly_summary')");
  const branchSlice = branchIdx >= 0 ? code.slice(branchIdx, branchIdx + 3500) : '';

  it('handler branch exists', () => {
    expect(branchIdx).toBeGreaterThan(-1);
  });

  it('uses brandedEmail() for the wrapped HTML', () => {
    expect(branchSlice).toMatch(/brandedEmail\s*\(/);
  });

  it('composes the body from the open + completed section renderers (mig 093)', () => {
    // bodyHtml is now a composed const: open section via tasksWeeklyHtml,
    // completed section via tasksWeeklyCompletedHtml, each guarded by a
    // non-empty check, then passed to brandedEmail as bodyHtml.
    expect(branchSlice).toMatch(/tasksWeeklyHtml\(\s*openTasks\s*\)/);
    expect(branchSlice).toMatch(/tasksWeeklyCompletedHtml\(\s*completedTasks\s*\)/);
    expect(branchSlice).toMatch(/bodyHtml,/);
  });

  it('reads test_to from the TOP-LEVEL body, not data.test_to', () => {
    // Top-level destructure shows up in the outer try/await: const
    // {type, data, test_to} = await req.json();
    expect(code).toMatch(/const\s*\{\s*type,\s*data,\s*test_to\s*\}\s*=\s*await\s+req\.json\(\)/);
    // Inside the branch the test_to symbol must reference the outer var
    // rather than data.test_to.
    expect(branchSlice).not.toMatch(/data\.test_to/);
    expect(branchSlice).toMatch(/test_to\s*\?/);
  });

  it('emits [TEST] subject prefix when test_to is set', () => {
    expect(branchSlice).toMatch(/test_to\s*\?\s*`\[TEST\]/);
  });

  it('skips with {ok:true, skipped:true} only when BOTH open and completed are empty (mig 093)', () => {
    expect(branchSlice).toMatch(/Array\.isArray\(\s*tasks\s*\)/);
    expect(branchSlice).toMatch(/Array\.isArray\(\s*completed\s*\)/);
    expect(branchSlice).toMatch(/openTasks\.length\s*===\s*0\s*&&\s*completedTasks\.length\s*===\s*0/);
    expect(branchSlice).toMatch(/skipped:\s*true/);
  });

  it('reads completed/completed_count and todos/todos_count from data alongside tasks/count (mig 093 + 115)', () => {
    expect(branchSlice).toMatch(
      /const\s*\{\s*email,\s*full_name,\s*tasks,\s*count,\s*completed,\s*completed_count,\s*todos,\s*todos_count\s*\}\s*=\s*data/,
    );
  });

  it('subject reflects open and/or completed counts (mig 093)', () => {
    expect(branchSlice).toMatch(/open task/);
    expect(branchSlice).toMatch(/completed this week/);
  });

  it('throws when email is missing', () => {
    expect(branchSlice).toMatch(/if\s*\(\s*!email\s*\)\s*throw\s+new\s+Error\(\s*'email required'\s*\)/);
  });

  it("the to: address is test_to when set, otherwise the recipient's email", () => {
    expect(branchSlice).toMatch(/to:\s*test_to\s*\?\s*\[\s*test_to\s*\]\s*:\s*\[\s*email\s*\]/);
  });
});

describe('rapid-processor.ts — tasks_weekly_summary shared-secret gate', () => {
  // rapid-processor is deployed with --no-verify-jwt. tasks_weekly_summary
  // accepts data.email + top-level test_to and would otherwise let any
  // anonymous caller send arbitrary WCF-branded mail. Require the caller's
  // x-tasks-summary-secret header to byte-equal TASKS_CRON_SECRET (only
  // tasks-summary running in this same project sends that header) before
  // any send work.
  //
  // The earlier SUPABASE_SERVICE_ROLE_KEY-as-bearer gate proved brittle on
  // Supabase's current platform key/env injection rules — even with both
  // functions envTrim-aligned on the same secret name, the byte-equal
  // compare kept rejecting in PROD. The custom header is independent of
  // project key shapes and apikey/Authorization gateway rules.
  const branchIdx = code.indexOf("if (type === 'tasks_weekly_summary')");
  const branchSlice = branchIdx >= 0 ? code.slice(branchIdx, branchIdx + 3500) : '';

  it('reads the x-tasks-summary-secret header at branch entry', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchSlice).toMatch(/req\.headers\.get\(\s*'x-tasks-summary-secret'\s*\)/);
  });

  it('compares the header to TASKS_CRON_SECRET via safeEqual', () => {
    expect(branchSlice).toMatch(/safeEqual\(\s*summarySecret\s*,\s*TASKS_CRON_SECRET\s*\)/);
  });

  it('returns 401 / unauthorized when the header is missing or wrong', () => {
    expect(branchSlice).toMatch(/status:\s*401/);
    expect(branchSlice).toMatch(/'unauthorized'/);
  });

  it('auth check runs BEFORE any sendEmail() call (no leak path)', () => {
    const safeEqualIdx = branchSlice.indexOf('safeEqual(summarySecret');
    const sendEmailIdx = branchSlice.indexOf('sendEmail(');
    expect(safeEqualIdx).toBeGreaterThan(-1);
    expect(sendEmailIdx).toBeGreaterThan(-1);
    expect(safeEqualIdx).toBeLessThan(sendEmailIdx);
  });

  it('does NOT gate on Authorization Bearer SUPABASE_SERVICE_ROLE_KEY (retired path)', () => {
    expect(branchSlice).not.toMatch(/safeEqual\(\s*bearer\s*,\s*SUPABASE_SERVICE_ROLE_KEY\s*\)/);
  });
});

describe('rapid-processor.ts — env secrets are envTrim-normalized (digest gate hotfix)', () => {
  // Background: tasks-summary's invokeRapidProcessor sends an envTrim'd
  // service-role bearer; rapid-processor's bearer gate compares against
  // SUPABASE_SERVICE_ROLE_KEY. If rapid-processor reads the env value raw
  // (unstripped), any trailing whitespace / newline picked up by the
  // platform's secret store causes a silent byte-equal mismatch and a
  // mysterious {"error":"unauthorized"} for every digest send. Lock that
  // every project-level secret read goes through the envTrim helper.
  it('defines an envTrim helper that strips leading/trailing whitespace', () => {
    expect(code).toMatch(
      /function\s+envTrim\([^)]*\)\s*:\s*string\s*\{[\s\S]*?Deno\.env\.get\([\s\S]*?\.replace\(\/\^\\s\+\|\\s\+\$\/g/,
    );
  });

  it('SUPABASE_SERVICE_ROLE_KEY is read via envTrim, not raw Deno.env.get', () => {
    expect(code).toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*envTrim\(\s*'SUPABASE_SERVICE_ROLE_KEY'\s*\)/);
    expect(code).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)!/);
  });

  it('SUPABASE_URL / SUPABASE_ANON_KEY / RESEND_API_KEY are also envTrim-normalized', () => {
    expect(code).toMatch(/SUPABASE_URL\s*=\s*envTrim\(\s*'SUPABASE_URL'\s*\)/);
    expect(code).toMatch(/SUPABASE_ANON_KEY\s*=\s*envTrim\(\s*'SUPABASE_ANON_KEY'\s*\)/);
    expect(code).toMatch(/RESEND_API_KEY\s*=\s*envTrim\(\s*'RESEND_API_KEY'\s*\)/);
  });

  it('TASKS_CRON_SECRET is read via envTrim (used by tasks_weekly_summary digest gate)', () => {
    expect(code).toMatch(/TASKS_CRON_SECRET\s*=\s*envTrim\(\s*'TASKS_CRON_SECRET'\s*\)/);
  });
});

describe('rapid-processor.ts — bearer auth helpers', () => {
  it('extractBearer + safeEqual helpers are defined', () => {
    expect(code).toMatch(/function\s+extractBearer\(/);
    expect(code).toMatch(/function\s+safeEqual\(/);
  });
});

describe('rapid-processor.ts — tasksWeeklyHtml helper', () => {
  it('exists with the locked signature', () => {
    expect(code).toMatch(/function\s+tasksWeeklyHtml\(\s*tasks/);
  });

  it('points users to /tasks for completion (T10/T11 — /my-tasks retired)', () => {
    // Footer link in the email body — Tasks v2 canonical destination.
    // /my-tasks redirects to /tasks via the URL adapter aliases, but
    // the email itself must show the canonical URL.
    expect(code).toMatch(/wcfplanner\.com\/tasks/);
    expect(code).not.toMatch(/wcfplanner\.com\/my-tasks/);
  });

  it('renders one table row per task with due_date + title columns', () => {
    expect(code).toMatch(/t\.due_date/);
    expect(code).toMatch(/t\.title/);
  });
});

describe('rapid-processor.ts — tasksWeeklyCompletedHtml helper (mig 093)', () => {
  const fnMatch = code.match(/function\s+tasksWeeklyCompletedHtml\([\s\S]*?\n\}\s*\n/);

  it('exists', () => {
    expect(code).toMatch(/function\s+tasksWeeklyCompletedHtml\(\s*completed/);
  });

  it('escapes title and completer name', () => {
    expect(fnMatch, 'expected tasksWeeklyCompletedHtml body').not.toBeNull();
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.title/);
    expect(fnMatch[0]).toMatch(/escapeHtml\(t\.completed_by/);
  });

  it('only builds a /tasks/<id> deep link from a path-safe id', () => {
    expect(fnMatch[0]).toMatch(/\/\^\[A-Za-z0-9\._-\]\+\$\/\.test\(rawId\)/);
    expect(fnMatch[0]).toMatch(/wcfplanner\.com\/tasks\/\$\{safeId\}/);
    // No /my-tasks anywhere.
    expect(fnMatch[0]).not.toMatch(/my-tasks/);
  });

  it('formats the completion time in America/Chicago', () => {
    expect(code).toMatch(/function\s+fmtCompletedAt\(/);
    expect(code).toMatch(/timeZone:\s*'America\/Chicago'/);
  });
});
