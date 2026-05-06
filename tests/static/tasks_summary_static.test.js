import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Tasks Module v1 Phase F (C4) — weekly summary static lock
// ============================================================================
// Locks the contracts established by Codex C4 reviews:
//   1. Migration 046 lives self-contained: extensions, vault preflight on
//      THREE secrets (length(trim()) >= 1), task_summary_runs table +
//      admin-SELECT-only RLS, invoke_tasks_summary(p_probe boolean
//      DEFAULT false), 15s pg_net timeout, REVOKE/GRANT target the
//      boolean signature, cron schedule '0 13 * * 1'.
//   2. invoke_tasks_summary's posted body carries probe:p_probe so SQL
//      probes (`SELECT public.invoke_tasks_summary(true);`) reach the
//      Edge Function's probe shortcut without sending real mail (Codex
//      C4 BLOCKER 1).
//   3. The cron schedule body calls the helper BARE (defaulting probe=
//      false) so Mondays send real digests.
//   4. supabase/functions/tasks-summary mirrors tasks-cron's auth
//      boundary: cron-mode = bearer + x-cron-secret + body.mode='cron';
//      admin-mode = caller JWT + rpc('is_admin') strict-true; anything
//      else → 401 with no audit row.
//   5. test_to is rejected in cron mode (post-auth, 400, no audit row)
//      and passed through verbatim in admin mode.
//   6. Probe shortcut writes a tsr-probe-* row and returns; no
//      assignee work, no rapid-processor invoke.
//   7. Per-recipient failures are captured in the per_recipient_failures
//      jsonb; one bad recipient does NOT abort the loop (Codex Q8).
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const migSrc = fs.readFileSync(path.join(ROOT, 'supabase-migrations/046_tasks_weekly_summary.sql'), 'utf8');
const fnSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/tasks-summary/index.ts'), 'utf8');

// Strip TS comments before regex assertions on the function source.
// Anchor line-comment match to start-of-line so URLs like https://...
// inside string literals survive the strip.
const fnCode = fnSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');

describe('Mig 046 — required extensions + vault preflight', () => {
  it('declares pg_cron, pg_net, and pgcrypto as IF NOT EXISTS', () => {
    expect(migSrc).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_cron/);
    expect(migSrc).toMatch(/CREATE EXTENSION IF NOT EXISTS pg_net/);
    expect(migSrc).toMatch(/CREATE EXTENSION IF NOT EXISTS pgcrypto/);
  });

  it('vault preflight reads all THREE secrets and validates trimmed/non-empty', () => {
    expect(migSrc).toMatch(/TASKS_SUMMARY_FUNCTION_URL/);
    expect(migSrc).toMatch(/TASKS_CRON_SECRET/);
    expect(migSrc).toMatch(/TASKS_CRON_SERVICE_ROLE_KEY/);
    // Each secret gets a length(trim(...)) = 0 RAISE. Codex C4
    // amendment 2 required all three so a misconfigured project can't
    // ship a silently-broken schedule.
    const trimChecks = migSrc.match(/length\(trim\(v_(?:url|secret|jwt)\)\)/g) || [];
    expect(trimChecks.length).toBeGreaterThanOrEqual(3);
    expect(migSrc).toMatch(/RAISE EXCEPTION 'mig 046: TASKS_SUMMARY_FUNCTION_URL/);
    expect(migSrc).toMatch(/RAISE EXCEPTION 'mig 046: TASKS_CRON_SECRET/);
    expect(migSrc).toMatch(/RAISE EXCEPTION 'mig 046: TASKS_CRON_SERVICE_ROLE_KEY/);
  });
});

describe('Mig 046 — task_summary_runs table + RLS', () => {
  it('table exists with the locked column shape', () => {
    expect(migSrc).toMatch(/CREATE TABLE IF NOT EXISTS public\.task_summary_runs/);
    expect(migSrc).toMatch(/run_mode\s+text NOT NULL DEFAULT 'cron'/);
    expect(migSrc).toMatch(/CHECK \(run_mode IN \('cron','admin'\)\)/);
    expect(migSrc).toMatch(/recipients_sent\s+int\s+NOT NULL DEFAULT 0/);
    expect(migSrc).toMatch(/recipients_skipped\s+int\s+NOT NULL DEFAULT 0/);
    expect(migSrc).toMatch(/total_open_instances\s+int\s+NOT NULL DEFAULT 0/);
    expect(migSrc).toMatch(/per_recipient_failures\s+jsonb NOT NULL DEFAULT '\[\]'::jsonb/);
    expect(migSrc).toMatch(/error_message\s+text/);
  });

  it('RLS is enabled with admin-SELECT-only policy (no INSERT/UPDATE/DELETE)', () => {
    expect(migSrc).toMatch(/ALTER TABLE public\.task_summary_runs ENABLE ROW LEVEL SECURITY/);
    expect(migSrc).toMatch(
      /CREATE POLICY task_summary_runs_admin_select ON public\.task_summary_runs[\s\S]{0,300}?FOR SELECT TO authenticated[\s\S]{0,200}?USING \(public\.is_admin\(\)\)/,
    );
    // Defensive: no INSERT/UPDATE/DELETE policies. Service-role writes
    // bypass RLS.
    expect(migSrc).not.toMatch(/CREATE POLICY[^\n]*FOR INSERT/);
    expect(migSrc).not.toMatch(/CREATE POLICY[^\n]*FOR UPDATE/);
    expect(migSrc).not.toMatch(/CREATE POLICY[^\n]*FOR DELETE/);
  });
});

describe('Mig 046 — invoke_tasks_summary helper', () => {
  it('declares the boolean parameter with default false (Codex C4 BLOCKER 1)', () => {
    expect(migSrc).toMatch(/CREATE OR REPLACE FUNCTION public\.invoke_tasks_summary\(p_probe boolean DEFAULT false\)/);
  });

  it('is SECURITY DEFINER + SET search_path = public + RETURNS bigint', () => {
    expect(migSrc).toMatch(/SECURITY DEFINER[\s\S]{0,80}?SET search_path = public/);
    expect(migSrc).toMatch(/RETURNS bigint/);
  });

  it('posts probe:p_probe in the JSON body so the Edge Function probe shortcut works', () => {
    expect(migSrc).toMatch(/jsonb_build_object\(\s*'mode'\s*,\s*'cron'\s*,\s*'probe'\s*,\s*p_probe\s*\)/);
  });

  it('uses the 15s pg_net timeout (mig 045 lesson)', () => {
    expect(migSrc).toMatch(/timeout_milliseconds\s*:=\s*15000/);
  });

  it('REVOKE/GRANT target the (boolean) signature, not the unparameterized one', () => {
    expect(migSrc).toMatch(/REVOKE ALL ON FUNCTION public\.invoke_tasks_summary\(boolean\) FROM PUBLIC/);
    expect(migSrc).toMatch(/REVOKE ALL ON FUNCTION public\.invoke_tasks_summary\(boolean\) FROM anon/);
    expect(migSrc).toMatch(/REVOKE ALL ON FUNCTION public\.invoke_tasks_summary\(boolean\) FROM authenticated/);
    expect(migSrc).toMatch(/GRANT EXECUTE ON FUNCTION public\.invoke_tasks_summary\(boolean\) TO postgres/);
  });

  it('helper SELECTs trim(decrypted_secret) for all three secrets (Codex C4 re-review BLOCKER 4)', () => {
    // Preflight already trims; the helper must also trim so a Vault
    // value with leading/trailing whitespace doesn't pass preflight
    // and then break the HTTP call later.
    const fnMatch = migSrc.match(
      /CREATE OR REPLACE FUNCTION public\.invoke_tasks_summary\([\s\S]*?\$invoke_tasks_summary\$;/,
    );
    expect(fnMatch, 'expected invoke_tasks_summary function definition').not.toBeNull();
    const fnBody = fnMatch[0];
    const trimSelects = fnBody.match(/SELECT\s+trim\(decrypted_secret\)\s+INTO\s+v_(?:url|secret|jwt)/g) || [];
    expect(trimSelects.length).toBe(3);
  });
});

describe('Mig 046 — cron schedule', () => {
  it('schedules tasks-summary-weekly at Mon 13:00 UTC', () => {
    expect(migSrc).toMatch(/cron\.schedule\(\s*'tasks-summary-weekly',\s*'0 13 \* \* 1'/);
  });

  it('cron body calls invoke_tasks_summary BARE (defaulting probe=false)', () => {
    // Real schedule fires real digests — only SQL probes pass true.
    expect(migSrc).toMatch(/SELECT public\.invoke_tasks_summary\(\s*\)/);
    // Defensive: the cron body itself does NOT pass true.
    const cronBlock = migSrc.match(/cron\.schedule\([\s\S]*?\);/);
    expect(cronBlock, 'expected cron.schedule call').not.toBeNull();
    expect(cronBlock[0]).not.toMatch(/invoke_tasks_summary\(\s*true\s*\)/);
  });

  it('idempotent: unschedule-then-schedule pattern', () => {
    expect(migSrc).toMatch(/cron\.unschedule\(\s*'tasks-summary-weekly'\s*\)/);
  });
});

describe('Edge Function — auth boundary mirrors tasks-cron', () => {
  it('envTrim() loads all five secrets at module init', () => {
    expect(fnCode).toMatch(/envTrim\(\s*'SUPABASE_URL'\s*\)/);
    expect(fnCode).toMatch(/envTrim\(\s*'SUPABASE_ANON_KEY'\s*\)/);
    expect(fnCode).toMatch(/envTrim\(\s*'SUPABASE_SERVICE_ROLE_KEY'\s*\)/);
    expect(fnCode).toMatch(/envTrim\(\s*'TASKS_CRON_SECRET'\s*\)/);
    expect(fnCode).toMatch(/envTrim\(\s*'TASKS_CRON_SERVICE_ROLE_KEY'\s*\)/);
  });

  it('cron auth: bearer == TASKS_CRON_SERVICE_ROLE_KEY AND x-cron-secret == TASKS_CRON_SECRET', () => {
    expect(fnCode).toMatch(
      /safeEqual\(bearer,\s*TASKS_CRON_SERVICE_ROLE_KEY\)\s*&&\s*safeEqual\(cronSecret,\s*TASKS_CRON_SECRET\)/,
    );
  });

  it('admin auth: rpc("is_admin") with caller JWT must strict-equal true', () => {
    expect(fnCode).toMatch(/userClient\.rpc\(\s*'is_admin'\s*\)/);
    expect(fnCode).toMatch(/return\s+data\s*===\s*true/);
  });

  it('mode-mismatch / wrong secret returns 401 (no audit row)', () => {
    // Audit-row writer is not called on the unauthorized branch. The
    // 401 short-circuits before svc client is even built.
    expect(fnCode).toMatch(/'unauthorized'.*?401|401.*?'unauthorized'/s);
  });

  it("body.mode must be 'cron' or 'admin'; anything else returns 400", () => {
    expect(fnCode).toMatch(/mode\s+required:\s*cron\s*\|\s*admin/);
  });
});

describe('Edge Function — test_to gating', () => {
  it('cron mode rejects test_to with 400 post-auth (Codex C4 amendment 5)', () => {
    expect(fnCode).toMatch(
      /if\s*\(\s*mode\s*===\s*'cron'\s*&&\s*testTo\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,200}?'test_to is not allowed in cron mode'[\s\S]{0,80}?,\s*400\s*\)/,
    );
  });

  it('admin mode passes test_to through to rapid-processor verbatim', () => {
    // payload object construction adds top-level test_to only when set.
    expect(fnCode).toMatch(/if\s*\(\s*testTo\s*\)\s+payload\.test_to\s*=\s*testTo/);
  });
});

describe('Edge Function — probe shortcut', () => {
  it('probe=true writes a tsr-probe-* row and returns immediately', () => {
    expect(fnCode).toMatch(/'tsr-probe-'\s*\+\s*uuidLike\(\)/);
    expect(fnCode).toMatch(/error_message:\s*'probe-only invocation'/);
    expect(fnCode).toMatch(/probe:\s*true,\s*run_mode:\s*mode/);
  });

  it('probe path writes to task_summary_runs (not task_cron_runs)', () => {
    expect(fnCode).toMatch(/from\(\s*'task_summary_runs'\s*\)\.insert/);
    expect(fnCode).not.toMatch(/from\(\s*'task_cron_runs'\s*\)/);
  });
});

describe('Edge Function — algorithm', () => {
  it('reads open task_instances joined to profiles for email + full_name + role', () => {
    expect(fnCode).toMatch(/from\(\s*'task_instances'\s*\)/);
    expect(fnCode).toMatch(/profiles[\s\S]{0,120}?email[\s\S]{0,40}?full_name[\s\S]{0,40}?role/);
    expect(fnCode).toMatch(/\.eq\(\s*'status'\s*,\s*'open'\s*\)/);
  });

  it('groups by assignee_profile_id and sorts each group by due_date asc', () => {
    expect(fnCode).toMatch(/groups\.set\(\s*r\.assignee_profile_id/);
    expect(fnCode).toMatch(/tasks\.sort/);
  });

  it('writes ONE task_summary_runs audit row at the end', () => {
    // Two writes total in the source: probe-row write + final-row write.
    const inserts = fnCode.match(/writeAuditRow\(/g) || [];
    expect(inserts.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT touch task_cron_runs (Phase B "do not overload" rule)', () => {
    expect(fnCode).not.toMatch(/task_cron_runs/);
  });
});

describe('Edge Function — per-assignee accounting (Codex C4 re-review BLOCKER 3)', () => {
  // The grouping function must keep EVERY assignee bucket — including
  // inactive / no-email — so the main handler can account each bucket
  // explicitly.
  it('grouping retains buckets for inactive / no-email assignees', () => {
    // Negative lock: the silent skippedNoEmail-at-grouping pattern is
    // gone. Bucket type carries email|null + role.
    expect(fnCode).not.toMatch(/skippedNoEmail/);
    expect(fnCode).toMatch(/email:\s*string\s*\|\s*null/);
    expect(fnCode).toMatch(/role:\s*string;/);
  });

  it('inactive role: recipients_skipped += 1 + per_recipient_failures entry', () => {
    expect(fnCode).toMatch(
      /if\s*\(\s*bucket\.role\s*===\s*'inactive'\s*\)\s*\{[\s\S]{0,400}?recipients_skipped\s*\+=\s*1[\s\S]{0,300}?per_recipient_failures\.push/,
    );
  });

  it('no email: recipients_skipped += 1 + per_recipient_failures entry', () => {
    expect(fnCode).toMatch(
      /if\s*\(\s*!\s*bucket\.email\s*\)\s*\{[\s\S]{0,400}?recipients_skipped\s*\+=\s*1[\s\S]{0,300}?per_recipient_failures\.push/,
    );
  });

  it('rapid-processor non-2xx response: recipients_skipped += 1 + failure entry', () => {
    expect(fnCode).toMatch(
      /if\s*\(\s*!res\.ok\s*\)\s*\{[\s\S]{0,400}?recipients_skipped\s*\+=\s*1[\s\S]{0,300}?per_recipient_failures\.push/,
    );
  });

  it('rapid-processor exception: recipients_skipped += 1 + failure entry', () => {
    // Catch is inside the per-bucket loop, AND it increments
    // recipients_skipped before pushing the failure entry.
    expect(fnCode).toMatch(
      /for\s*\(\s*const\s+bucket\s+of\s+buckets\s*\)\s*\{[\s\S]{0,2500}?catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,400}?recipients_skipped\s*\+=\s*1[\s\S]{0,300}?per_recipient_failures\.push/,
    );
  });

  it('per-recipient failures captured in jsonb; loop continues (no early break)', () => {
    expect(fnCode).toMatch(/per_recipient_failures/);
    // No `break` inside the for loop body.
    const loopMatch = fnCode.match(/for\s*\(\s*const\s+bucket\s+of\s+buckets\s*\)\s*\{([\s\S]*?)\n\s{2}\}\s*\n/);
    expect(loopMatch, 'expected to find per-bucket loop').not.toBeNull();
    expect(loopMatch[1]).not.toMatch(/\bbreak\b/);
  });
});

describe('Edge Function — rapid-processor invocation', () => {
  it('invokes the rapid-processor function URL with service-role bearer', () => {
    expect(fnCode).toMatch(/\/functions\/v1\/rapid-processor/);
    expect(fnCode).toMatch(/Authorization:\s*`Bearer\s*\$\{SUPABASE_SERVICE_ROLE_KEY\}/);
  });

  it("posts type:'tasks_weekly_summary' with {email, full_name, tasks, count}", () => {
    expect(fnCode).toMatch(/type:\s*'tasks_weekly_summary'/);
    expect(fnCode).toMatch(/email:\s*bucket\.email/);
    expect(fnCode).toMatch(/full_name:\s*bucket\.full_name/);
    expect(fnCode).toMatch(/tasks:\s*bucket\.tasks/);
    expect(fnCode).toMatch(/count:\s*bucket\.tasks\.length/);
  });
});
