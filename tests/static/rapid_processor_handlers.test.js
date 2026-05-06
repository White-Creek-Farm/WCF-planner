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
//       all six handlers so a future deploy can't silently drop one again.
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

describe('rapid-processor.ts — six handler branches present', () => {
  const handlers = [
    'egg_report',
    'starter_feed_check',
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

describe('rapid-processor.ts — user_delete admin gate (Codex C4 re-review BLOCKER 1)', () => {
  // rapid-processor is deployed with --no-verify-jwt so the platform
  // does NOT enforce auth for us. user_delete MUST verify the caller
  // is admin in-function before calling admin.auth.admin.deleteUser.
  const branchIdx = code.indexOf("if (type === 'user_delete')");
  const branchSlice = branchIdx >= 0 ? code.slice(branchIdx, branchIdx + 3000) : '';

  it('admin.auth.admin.deleteUser(data.id) is the live call', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchSlice).toMatch(/admin\.auth\.admin\.deleteUser\(\s*data\.id\s*\)/);
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

  it('uses tasksWeeklyHtml() for the body content', () => {
    expect(branchSlice).toMatch(/bodyHtml:\s*tasksWeeklyHtml\(\s*tasks\s*\)/);
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

  it('skips with {ok:true, skipped:true} when tasks is empty', () => {
    expect(branchSlice).toMatch(/Array\.isArray\(\s*tasks\s*\)/);
    expect(branchSlice).toMatch(/skipped:\s*true/);
  });

  it('throws when email is missing', () => {
    expect(branchSlice).toMatch(/if\s*\(\s*!email\s*\)\s*throw\s+new\s+Error\(\s*'email required'\s*\)/);
  });

  it("the to: address is test_to when set, otherwise the recipient's email", () => {
    expect(branchSlice).toMatch(/to:\s*test_to\s*\?\s*\[\s*test_to\s*\]\s*:\s*\[\s*email\s*\]/);
  });
});

describe('rapid-processor.ts — tasks_weekly_summary service-role gate (Codex C4 re-review BLOCKER 5)', () => {
  // rapid-processor is deployed with --no-verify-jwt. tasks_weekly_summary
  // accepts data.email + top-level test_to and would otherwise let any
  // anonymous caller send arbitrary WCF-branded mail. Require caller's
  // bearer to byte-equal SUPABASE_SERVICE_ROLE_KEY (only tasks-summary
  // sends that within this project) before any send work.
  const branchIdx = code.indexOf("if (type === 'tasks_weekly_summary')");
  const branchSlice = branchIdx >= 0 ? code.slice(branchIdx, branchIdx + 3500) : '';

  it('reads the Authorization header at branch entry', () => {
    expect(branchIdx).toBeGreaterThan(-1);
    expect(branchSlice).toMatch(/req\.headers\.get\(\s*'authorization'\s*\)/);
  });

  it('compares bearer to SUPABASE_SERVICE_ROLE_KEY via safeEqual', () => {
    expect(branchSlice).toMatch(/extractBearer\(\s*req\.headers\.get\(\s*'authorization'\s*\)\s*\)/);
    expect(branchSlice).toMatch(/safeEqual\(\s*bearer\s*,\s*SUPABASE_SERVICE_ROLE_KEY\s*\)/);
  });

  it('returns 401 / unauthorized when bearer does not match', () => {
    expect(branchSlice).toMatch(/status:\s*401/);
    expect(branchSlice).toMatch(/'unauthorized'/);
  });

  it('auth check runs BEFORE any sendEmail() call (no leak path)', () => {
    const safeEqualIdx = branchSlice.indexOf('safeEqual(bearer');
    const sendEmailIdx = branchSlice.indexOf('sendEmail(');
    expect(safeEqualIdx).toBeGreaterThan(-1);
    expect(sendEmailIdx).toBeGreaterThan(-1);
    expect(safeEqualIdx).toBeLessThan(sendEmailIdx);
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

  it('points users to /my-tasks for completion', () => {
    // Footer link in the email body — keeps the assignee on the
    // completion-flow page, not the public webform.
    expect(code).toMatch(/wcfplanner\.com\/my-tasks/);
  });

  it('renders one table row per task with due_date + title columns', () => {
    expect(code).toMatch(/t\.due_date/);
    expect(code).toMatch(/t\.title/);
  });
});
