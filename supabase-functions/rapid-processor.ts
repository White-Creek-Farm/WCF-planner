import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';

// Defensive trim on every secret read. Mirrors tasks-cron / tasks-summary.
// Paste-deploy of secrets (Dashboard / `supabase secrets set`) often picks up
// a trailing newline or space; safeEqual is exact-byte so we normalize at load
// time. Critical for the tasks_weekly_summary bearer gate below: tasks-summary
// already sends an envTrim'd value, so rapid-processor MUST trim too or the
// byte-equal comparison silently rejects matched secrets.
function envTrim(name: string): string {
  return (Deno.env.get(name) ?? '').replace(/^\s+|\s+$/g, '');
}

const RESEND_API_KEY = envTrim('RESEND_API_KEY');
const SUPABASE_URL = envTrim('SUPABASE_URL');
const SUPABASE_ANON_KEY = envTrim('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = envTrim('SUPABASE_SERVICE_ROLE_KEY');
// Shared digest secret. tasks-summary's invokeRapidProcessor sends this
// in an x-tasks-summary-secret header; the tasks_weekly_summary branch
// below verifies it via safeEqual. Same Vault entry used by tasks-cron
// auth, both functions read it via envTrim so byte-equal compare aligns.
const TASKS_CRON_SECRET = envTrim('TASKS_CRON_SECRET');
const FROM = 'WCF Planner <reports@wcfplanner.com>';
const AUTH_FROM = 'WCF Planner <noreply@wcfplanner.com>';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-tasks-summary-secret',
};

async function sendEmail(payload: object): Promise<Response> {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(payload),
  });
}

// HTML-escape user-controlled strings before interpolating into email
// templates. Codex C4 re-review BLOCKER 2: tasksWeeklyHtml renders task
// titles + submitted_by_team_member + submission_source + due_date and
// branded subtitle (full_name) directly into HTML; these strings can
// originate from public webform submitters or admin-typed input.
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Bearer parser tolerant of leading "Bearer " prefix. Used by the
// tasks_weekly_summary service-role gate (Codex C4 re-review BLOCKER 5).
function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const trimmed = authHeader.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) return trimmed.slice(7).trim();
  return trimmed;
}

// Length-first then byte compare. Mirrors the tasks-cron pattern. Hides
// length-leak signal; the service-role JWT is long enough that brute-
// forcing per-request is infeasible.
function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ═══════════════════════════════════════════════════════════════════
// SHARED BRANDED TEMPLATE — all emails use this wrapper
// ═══════════════════════════════════════════════════════════════════
function brandedEmail(opts: {title: string; subtitle?: string; bodyHtml: string; isTest?: boolean}): string {
  const testBanner = opts.isTest
    ? '<div style="background:#c46904;color:white;text-align:center;padding:8px;font-family:sans-serif;font-size:12px;font-weight:700;letter-spacing:1px;">TEST EMAIL - NOT SENT TO REAL RECIPIENTS</div>'
    : '';
  const subtitle = opts.subtitle
    ? `<div style="color:rgba(255,255,255,0.8);font-size:13px;font-family:Arial,sans-serif;">${opts.subtitle}</div>`
    : '';
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Georgia,serif;">
  ${testBanner}
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f0;padding:32px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header Banner -->
        <tr><td style="background:#566542;border-radius:8px 8px 0 0;padding:28px 36px;text-align:center;">
          <div style="color:#ffffff;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;font-family:Arial,sans-serif;">White Creek Farm</div>
          <div style="color:#ffffff;font-size:22px;font-weight:700;font-family:Georgia,serif;margin-bottom:4px;">${opts.title}</div>
          ${subtitle}
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:36px;">
          ${opts.bodyHtml}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#566542;border-radius:0 0 8px 8px;padding:16px 36px;text-align:center;">
          <div style="color:rgba(255,255,255,0.7);font-size:11px;font-family:Arial,sans-serif;letter-spacing:0.5px;">White Creek Farm · wcfplanner.com</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════════
// EGG REPORT — uses the shared template
// ═══════════════════════════════════════════════════════════════════
function eggEmailHtml(data: any, isTest: boolean) {
  const date = new Date(data.date + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const bodyHtml = `
    <!-- Stats -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr>
        <td width="48%" style="background:#f8f6f0;border-radius:8px;padding:20px 16px;text-align:center;border:1px solid #e8e4dc;">
          <div style="color:#566542;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px;">Dozens on Hand</div>
          <div style="color:#566542;font-size:13px;font-style:italic;font-family:Georgia,serif;margin-bottom:6px;">(&lt;2 weeks old)</div>
          <div style="color:#232323;font-size:36px;font-weight:700;font-family:Georgia,serif;line-height:1;">${data.dozens_on_hand != null ? data.dozens_on_hand : '—'}</div>
          <div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">dozen</div>
        </td>
        <td width="4%"></td>
        <td width="48%" style="background:#f8f6f0;border-radius:8px;padding:20px 16px;text-align:center;border:1px solid #e8e4dc;">
          <div style="color:#566542;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px;">Collected Today</div>
          <div style="color:#566542;font-size:13px;font-style:italic;font-family:Georgia,serif;margin-bottom:6px;">&nbsp;</div>
          <div style="color:#232323;font-size:36px;font-weight:700;font-family:Georgia,serif;line-height:1;">${data.daily_dozen_count ?? 0}</div>
          <div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">dozen</div>
        </td>
      </tr>
    </table>

    <!-- Submitted by -->
    <div style="border-top:1px solid #e8e4dc;padding-top:16px;text-align:center;">
      <span style="color:#999;font-size:12px;font-family:Arial,sans-serif;">Submitted by <strong style="color:#566542;">${data.team_member || 'Farm Team'}</strong> · WCF Planner</span>
    </div>
  `;
  return brandedEmail({title: '🥚 Egg Report', subtitle: date, bodyHtml, isTest});
}

// ═══════════════════════════════════════════════════════════════════
// STARTER FEED ALERT — upgraded to use shared template
// ═══════════════════════════════════════════════════════════════════
function starterFeedHtml(batchLabel: string, totalLbs: number, isTest: boolean) {
  const bodyHtml = `
    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;margin:0 0 16px 0;">Dear Supreme Chicken Raiser,</p>

    <!-- Alert box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#fffbeb;border:2px solid #fde68a;border-radius:8px;padding:20px;text-align:center;">
        <div style="color:#92400e;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:8px;">Starter Feed Total</div>
        <div style="color:#232323;font-size:36px;font-weight:700;font-family:Georgia,serif;line-height:1;margin-bottom:4px;">${totalLbs.toLocaleString()} lbs</div>
        <div style="color:#92400e;font-size:13px;font-family:Arial,sans-serif;">of 1,500 lbs maximum</div>
      </td></tr>
    </table>

    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;line-height:1.6;margin:0 0 16px 0;">The starter feed for <strong style="color:#566542;">${batchLabel}</strong> has reached <strong>${totalLbs.toLocaleString()} lbs</strong>. The max for each batch is 1,500 lbs. Your attention to this matter is greatly appreciated.</p>

    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;margin:24px 0 0 0;">Best,<br>White Creek Farm</p>

    <!-- Footer note -->
    <div style="border-top:1px solid #e8e4dc;padding-top:16px;margin-top:24px;text-align:center;">
      <span style="color:#999;font-size:11px;font-family:Arial,sans-serif;">WCF Planner automated alert</span>
    </div>
  `;
  return brandedEmail({title: '⚠ Starter Feed Alert', subtitle: batchLabel, bodyHtml, isTest});
}

// ═══════════════════════════════════════════════════════════════════
// USER WELCOME — new user created
// ═══════════════════════════════════════════════════════════════════
function welcomeEmailHtml(name: string, email: string, role: string, resetLink: string, isTest: boolean) {
  const roleLabels: Record<string, string> = {
    admin: '👑 Admin — Full access to all features',
    management: '🔑 Management — Edit anything, delete daily reports',
    farm_team: '🌾 Farm Team — Edit & delete your daily reports',
    light: '📋 Light — Field portal: daily/feed/equipment/weigh-in forms + Tasks',
  };
  const roleDescription = roleLabels[role] || role;

  const bodyHtml = `
    <p style="font-family:Georgia,serif;font-size:16px;color:#232323;margin:0 0 16px 0;">Welcome, <strong style="color:#566542;">${name || email}</strong>!</p>

    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;line-height:1.6;margin:0 0 20px 0;">Your account has been created for the White Creek Farm planner. This is the system we use to track all animal programs on the farm.</p>

    <!-- Role card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="background:#f8f6f0;border:1px solid #e8e4dc;border-radius:8px;padding:18px 20px;">
        <div style="color:#566542;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:6px;">Your Role</div>
        <div style="color:#232323;font-size:15px;font-family:Georgia,serif;">${roleDescription}</div>
      </td></tr>
    </table>

    <!-- Next steps -->
    <div style="color:#566542;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:10px;">Next Steps</div>
    <ol style="font-family:Georgia,serif;font-size:15px;color:#232323;line-height:1.7;margin:0 0 24px 0;padding-left:22px;">
      <li>Click the button below to set your password</li>
      <li>Log in at <a href="https://wcfplanner.com" style="color:#566542;">wcfplanner.com</a></li>
      <li>Start using the planner on any device — desktop or mobile</li>
    </ol>

    <!-- CTA button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${resetLink}" style="display:inline-block;background:#566542;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.5px;">Set Your Password</a>
      </td></tr>
    </table>

    <p style="font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.6;margin:0 0 16px 0;text-align:center;">This link is valid for 24 hours. If you need a new one, visit <a href="https://wcfplanner.com" style="color:#566542;">wcfplanner.com</a> and click "Forgot password?"</p>

    <!-- Footer note -->
    <div style="border-top:1px solid #e8e4dc;padding-top:16px;text-align:center;">
      <span style="color:#999;font-size:11px;font-family:Arial,sans-serif;">Questions? Contact White Creek Farm management.</span>
    </div>
  `;
  return brandedEmail({title: '🌾 Welcome to WCF Planner', subtitle: 'Your account is ready', bodyHtml, isTest});
}

// ═══════════════════════════════════════════════════════════════════
// PASSWORD RESET — user requested or admin triggered
// ═══════════════════════════════════════════════════════════════════
function passwordResetHtml(name: string, resetLink: string, isTest: boolean) {
  const bodyHtml = `
    <p style="font-family:Georgia,serif;font-size:16px;color:#232323;margin:0 0 16px 0;">Hi <strong style="color:#566542;">${name || 'there'}</strong>,</p>

    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;line-height:1.6;margin:0 0 24px 0;">A password reset was requested for your WCF Planner account. Click the button below to set a new password.</p>

    <!-- CTA button -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td align="center">
        <a href="${resetLink}" style="display:inline-block;background:#566542;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:8px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.5px;">Reset Password</a>
      </td></tr>
    </table>

    <!-- Info box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">
      <tr><td style="background:#f8f6f0;border:1px solid #e8e4dc;border-radius:8px;padding:16px 20px;">
        <div style="color:#566542;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-family:Arial,sans-serif;margin-bottom:6px;">What to expect</div>
        <ul style="font-family:Georgia,serif;font-size:14px;color:#232323;line-height:1.6;margin:0;padding-left:20px;">
          <li>Link is valid for 24 hours</li>
          <li>Password must be at least 6 characters</li>
          <li>You'll be logged in automatically after setting it</li>
        </ul>
      </td></tr>
    </table>

    <p style="font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.6;margin:0 0 16px 0;">Didn't request this? You can safely ignore this email — your password won't change unless you click the link.</p>

    <!-- Footer note -->
    <div style="border-top:1px solid #e8e4dc;padding-top:16px;text-align:center;">
      <span style="color:#999;font-size:11px;font-family:Arial,sans-serif;">WCF Planner · This mailbox is not monitored.</span>
    </div>
  `;
  return brandedEmail({title: '🔑 Password Reset', subtitle: 'WCF Planner', bodyHtml, isTest});
}

// ─── Tasks weekly summary table — Tasks v2 (T10) ─────────────────────────
// Due-date / title rows with v2 context: designation badge (Recurring /
// System), optional description, attribution (submitted-by for
// public-webform rows; created-by for logged-in admin-created rows),
// and a paperclip when the row carries any photo path. Does NOT inline
// thumbnails or signed URLs — operators open /tasks to view.
//
// All user-controlled strings (title / description / submitted_by /
// created_by_display_name / due_date) are HTML-escaped before
// interpolation. Title and description in particular can come from
// public webform submitters or admin-typed input.
//
// `tasks` shape per row: {
//   id, due_date, title,
//   description?, submission_source?, submitted_by_team_member?,
//   designation? ('recurring'|'system'|null), created_by_display_name?,
//   has_photo?
// }.
function tasksWeeklyHtml(tasks: Array<Record<string, any>>): string {
  const rows = tasks
    .map((t) => {
      const due = escapeHtml(t.due_date || '');
      const title = escapeHtml(t.title || '(untitled)');
      const description = t.description ? escapeHtml(t.description) : '';
      let badge = '';
      if (t.designation === 'recurring') {
        badge = `<span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-family:Arial,sans-serif;font-size:11px;font-weight:600;">Recurring</span>`;
      } else if (t.designation === 'system') {
        badge = `<span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:#ecfdf5;color:#047857;font-family:Arial,sans-serif;font-size:11px;font-weight:600;">System</span>`;
      }
      const photoMark = t.has_photo
        ? `<span title="Has photo" style="margin-left:6px;color:#888;font-size:12px;">📎</span>`
        : '';
      const ctxParts: string[] = [];
      if (t.submission_source === 'public_webform' && t.submitted_by_team_member) {
        ctxParts.push(`Submitted by ${escapeHtml(t.submitted_by_team_member)}`);
      } else if (t.created_by_display_name) {
        ctxParts.push(`Created by ${escapeHtml(t.created_by_display_name)}`);
      } else if (t.submission_source && t.submission_source !== 'generated') {
        ctxParts.push(`source: ${escapeHtml(t.submission_source)}`);
      }
      const ctx = ctxParts.length
        ? `<div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">${ctxParts.join(' · ')}</div>`
        : '';
      const desc = description
        ? `<div style="color:#444;font-size:13px;font-family:Georgia,serif;margin-top:4px;white-space:pre-wrap;">${description}</div>`
        : '';
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Arial,sans-serif;font-size:13px;color:#566542;font-weight:700;white-space:nowrap;vertical-align:top;">${due}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Georgia,serif;font-size:14px;color:#232323;vertical-align:top;">
            ${title}${badge}${photoMark}
            ${desc}
            ${ctx}
          </td>
        </tr>`;
    })
    .join('');
  return `
    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;margin:0 0 16px 0;line-height:1.6;">
      You have ${tasks.length} open task${tasks.length === 1 ? '' : 's'} on the WCF Planner.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e4dc;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#f8f6f0;">
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">Due</th>
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">Task</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Completed-assigned-task section (mig 093). Lists tasks the recipient
// created/assigned that were completed during the weekly window. Every
// user-controlled value (title, completer name) is escaped; the completed
// timestamp is formatted in America/Chicago and the task link is built from
// a sanitized id so a crafted id can't break out of the href.
function fmtCompletedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch (_e) {
    return iso;
  }
}

function tasksWeeklyCompletedHtml(completed: Array<Record<string, any>>): string {
  const rows = completed
    .map((t) => {
      const title = escapeHtml(t.title || '(untitled)');
      const when = escapeHtml(fmtCompletedAt(String(t.completed_at || '')));
      const by = t.completed_by ? escapeHtml(t.completed_by) : '';
      const byLine = by
        ? `<div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">Completed by ${by}</div>`
        : '';
      // Only build a deep link for an id that is plainly safe in a URL path.
      const rawId = String(t.task_instance_id || '');
      const safeId = /^[A-Za-z0-9._-]+$/.test(rawId) ? rawId : '';
      const titleCell = safeId
        ? `<a href="https://wcfplanner.com/tasks/${safeId}" style="color:#232323;text-decoration:underline;">${title}</a>`
        : title;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Arial,sans-serif;font-size:13px;color:#566542;font-weight:700;white-space:nowrap;vertical-align:top;">${when}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Georgia,serif;font-size:14px;color:#232323;vertical-align:top;">
            ${titleCell}
            ${byLine}
          </td>
        </tr>`;
    })
    .join('');
  return `
    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;margin:24px 0 16px 0;line-height:1.6;">
      ${completed.length} task${completed.length === 1 ? '' : 's'} you assigned ${completed.length === 1 ? 'was' : 'were'} completed this week.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e4dc;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#f8f6f0;">
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">Completed</th>
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">Task</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// Shared To Do List section (mig 115). One communal section listing every
// open/pending To Do item — the same list goes to every To Do-eligible
// recipient (tasks-summary applies the role filter upstream). Every
// user-controlled value (title, section label, creator name) is escaped.
//
// `todos` shape per row: {
//   id, title, section_label, status ('open'|'pending_approval'),
//   due_date?, days_listed, created_by_name
// }.
function tasksWeeklyTodoHtml(todos: Array<Record<string, any>>): string {
  const rows = todos
    .map((t) => {
      const title = escapeHtml(t.title || '(untitled)');
      const section = escapeHtml(t.section_label || 'General');
      const pendingBadge =
        t.status === 'pending_approval'
          ? `<span style="display:inline-block;margin-left:6px;padding:1px 8px;border-radius:999px;background:#fef3c7;color:#92400e;font-family:Arial,sans-serif;font-size:11px;font-weight:600;">Awaiting approval</span>`
          : '';
      const days = Number.isFinite(Number(t.days_listed)) ? Number(t.days_listed) : 0;
      const listed = days <= 0 ? 'listed today' : days === 1 ? 'listed 1 day ago' : `listed ${days} days ago`;
      const ctxParts: string[] = [];
      if (t.created_by_name) ctxParts.push(`Added by ${escapeHtml(String(t.created_by_name))}`);
      ctxParts.push(escapeHtml(listed));
      if (t.due_date) ctxParts.push(`due ${escapeHtml(String(t.due_date))}`);
      const ctx = `<div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">${ctxParts.join(' · ')}</div>`;
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Arial,sans-serif;font-size:13px;color:#566542;font-weight:700;white-space:nowrap;vertical-align:top;">${section}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Georgia,serif;font-size:14px;color:#232323;vertical-align:top;">
            ${title}${pendingBadge}
            ${ctx}
          </td>
        </tr>`;
    })
    .join('');
  return `
    <p style="font-family:Georgia,serif;font-size:15px;color:#232323;margin:24px 0 16px 0;line-height:1.6;">
      ${todos.length} item${todos.length === 1 ? '' : 's'} on the shared To Do List — anyone can pick one up.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e4dc;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <thead>
        <tr style="background:#f8f6f0;">
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">Section</th>
          <th align="left" style="padding:8px 12px;font-family:Arial,sans-serif;font-size:11px;color:#566542;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;border-bottom:1px solid #e8e4dc;">To Do</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', {headers: corsHeaders});

  try {
    const {type, data, test_to} = await req.json();

    // ─── EGG REPORT ───
    if (type === 'egg_report') {
      const res = await sendEmail({
        from: FROM,
        to: test_to ? [test_to] : ['isabel@sonnysfarm.com'],
        ...(test_to
          ? {}
          : {cc: ['brian@sonnysfarm.com', 'jessica@marbellagroup.com'], bcc: ['ronnie@whitecreek.farm']}),
        subject: test_to
          ? `[TEST] Egg Report - ${new Date(data.date + 'T12:00:00').toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric'})}`
          : `Egg Report - ${new Date(data.date + 'T12:00:00').toLocaleDateString('en-GB', {day: 'numeric', month: 'long', year: 'numeric'})}`,
        html: eggEmailHtml(data, !!test_to),
      });
      const result = await res.json();
      return new Response(JSON.stringify({ok: true, result}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    // ─── STARTER FEED ALERT ───
    if (type === 'starter_feed_check') {
      if (!data.batch_label || !data.feed_lbs || parseFloat(data.feed_lbs) <= 0) {
        return new Response(JSON.stringify({ok: true, skipped: true}), {
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const {data: records, error: queryError} = await admin
        .from('poultry_dailys')
        .select('feed_lbs')
        .eq('batch_label', data.batch_label)
        .eq('feed_type', 'STARTER');
      if (queryError) throw new Error(queryError.message);
      const total = records?.reduce((s, r) => s + (parseFloat(r.feed_lbs) || 0), 0) ?? 0;
      const prevTotal = total - (parseFloat(data.feed_lbs) || 0);
      if (test_to || (total >= 1400 && prevTotal < 1400)) {
        const displayTotal = test_to ? 1432 : Math.round(total);
        const res = await sendEmail({
          from: FROM,
          to: test_to ? [test_to] : ['Simon.rosa3@gmail.com'],
          ...(test_to ? {} : {cc: ['mak@whitecreek.farm']}),
          subject: test_to
            ? `[TEST] STARTER FEED LIMIT - NEAR CUTOFF FOR ${data.batch_label}`
            : `STARTER FEED LIMIT - NEAR CUTOFF FOR ${data.batch_label}`,
          html: starterFeedHtml(data.batch_label, displayTotal, !!test_to),
        });
        const result = await res.json();
        return new Response(JSON.stringify({ok: true, alert_sent: true, total: displayTotal, result}), {
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      return new Response(JSON.stringify({ok: true, alert_sent: false, total: Math.round(total)}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    // ─── USER CREATE — admin creates auth account + sends welcome ───
    //
    // Each step (createUser, profileUpsert, generateLink, sendEmail) is
    // wrapped in its own try so the response body identifies WHICH step
    // failed and includes a "partial" hint when prior steps already
    // mutated state. The client unwrapEdgeFunctionError helper surfaces
    // the labeled message verbatim so admins know whether to retry,
    // repair, or just resend the welcome email manually.
    //
    // sendEmail is non-fatal: if Resend rejects after the auth account
    // is already created, we return ok:true with welcomeEmailDelivered:
    // false + emailError so UsersModal can render a warning instead of
    // a false "Invite sent" success.
    if (type === 'user_create') {
      const authHeader = req.headers.get('authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({error: 'unauthorized', step: 'auth'}), {
          status: 401,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {persistSession: false, autoRefreshToken: false},
        global: {headers: {Authorization: authHeader}},
      });
      const {data: isAdminData, error: isAdminErr} = await userClient.rpc('is_admin');
      if (isAdminErr || isAdminData !== true) {
        return new Response(JSON.stringify({error: 'forbidden', step: 'is_admin'}), {
          status: 403,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      // Config preflight — fail fast with a clear message if a secret
      // didn't load. Only the NAMES of missing vars are returned; values
      // are never logged or echoed.
      const manualPassword = typeof data?.initialPassword === 'string' ? data.initialPassword : '';
      const useManualPassword = manualPassword.length > 0;

      const missingEnv: string[] = [];
      if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
      if (!SUPABASE_ANON_KEY) missingEnv.push('SUPABASE_ANON_KEY');
      if (!SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
      if (!useManualPassword && !RESEND_API_KEY) missingEnv.push('RESEND_API_KEY');
      if (missingEnv.length > 0) {
        return new Response(JSON.stringify({error: `config: missing env ${missingEnv.join(', ')}`, step: 'config'}), {
          status: 500,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      const email = String(data?.email || '').trim();
      const name = String(data?.name || '').trim();
      const role = String(data?.role || 'farm_team')
        .trim()
        .toLowerCase();
      if (!email) {
        return new Response(JSON.stringify({error: 'email required', step: 'input'}), {
          status: 400,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      if (!['admin', 'management', 'farm_team', 'equipment_tech', 'light'].includes(role)) {
        return new Response(JSON.stringify({error: 'invalid assignable role', step: 'input'}), {
          status: 400,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      if (useManualPassword) {
        const manualPasswordBytes = new TextEncoder().encode(manualPassword).length;
        if (manualPassword.length < 6 || manualPasswordBytes > 72) {
          return new Response(JSON.stringify({error: 'initial password must be 6-72 bytes', step: 'input'}), {
            status: 400,
            headers: {...corsHeaders, 'Content-Type': 'application/json'},
          });
        }
      }

      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      // bcrypt has a hard 72-byte input limit and GoTrue's bcrypt call
      // PANICS rather than truncates when exceeded — surfacing as a
      // generic 500 "Internal Server Error" with no actionable message.
      // The previous `wcf_<uuid>_<uuid>` shape was 77 bytes and broke
      // every user_create attempt since rapid-processor c4c6e9d landed.
      // One UUIDv4 = ~122 bits of entropy, which is far above any
      // reasonable brute-force threshold for a throwaway password the
      // user resets on first login via the recovery link below.
      const tempPw = `wcf_${crypto.randomUUID()}`;

      // Step 1: createUser. Failure here is the cleanest case — no
      // mutation happened, so the admin can fix inputs and retry.
      let createdUserId: string;
      try {
        const r = await admin.auth.admin.createUser({
          email,
          password: useManualPassword ? manualPassword : tempPw,
          email_confirm: true,
          user_metadata: {full_name: name},
        });
        if (r.error) throw new Error(r.error.message || String(r.error));
        if (!r.data?.user?.id) throw new Error('createUser returned no user id');
        createdUserId = r.data.user.id;
      } catch (e) {
        return new Response(
          JSON.stringify({error: `createUser: ${e instanceof Error ? e.message : String(e)}`, step: 'createUser'}),
          {status: 500, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      // Step 2: profileUpsert. If this fails the auth account exists but
      // is orphaned from profiles — admin must NOT retry blindly because
      // that would either succeed-with-collision (duplicate auth) or just
      // re-fail. Surface that explicitly.
      try {
        const r = await admin
          .from('profiles')
          .upsert({id: createdUserId, email, full_name: name, role}, {onConflict: 'id'});
        if (r.error) throw new Error(r.error.message || String(r.error));
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: `profileUpsert: ${e instanceof Error ? e.message : String(e)}`,
            step: 'profileUpsert',
            partial: {authUserId: createdUserId, email, profileCreated: false},
            hint: 'Auth account exists but profile row failed; do NOT retry Add User. Ask CC to repair the profiles row OR remove the orphan auth user.',
          }),
          {status: 500, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      if (useManualPassword) {
        return new Response(
          JSON.stringify({
            ok: true,
            user: {id: createdUserId, email},
            manualPasswordSet: true,
          }),
          {headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      // Step 3: generateLink. Both auth + profile exist by now; if this
      // step fails, the user can still set a password via manual reset.
      let resetLink = 'https://wcfplanner.com';
      try {
        const r = await admin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: {redirectTo: 'https://wcfplanner.com'},
        });
        if (r.error) throw new Error(r.error.message || String(r.error));
        resetLink = r.data?.properties?.action_link || resetLink;
      } catch (e) {
        return new Response(
          JSON.stringify({
            error: `generateLink: ${e instanceof Error ? e.message : String(e)}`,
            step: 'generateLink',
            partial: {authUserId: createdUserId, email, profileCreated: true, recoveryLinkCreated: false},
            hint: 'Auth + profile exist but the recovery link failed; do NOT retry Add User. Use Send Password Reset on the user row instead.',
          }),
          {status: 500, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      // Step 4: sendEmail. NON-FATAL — auth account is already usable.
      // Return ok:true with welcomeEmailDelivered:false so UsersModal can
      // render a warning instead of a false success.
      //
      // Hardening (Codex revision 4): AbortController 10s timeout so a
      // hung Resend cannot exhaust the function budget; res.text() then
      // defensive JSON.parse so a non-JSON body still surfaces the real
      // error; res.ok gate so a structured error body is not treated as
      // success.
      let welcomeEmailDelivered = true;
      let emailError: string | null = null;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({
            from: AUTH_FROM,
            to: test_to ? [test_to] : [email],
            ...(test_to ? {} : {bcc: ['ronnie@whitecreek.farm']}),
            subject: test_to ? `[TEST] Welcome to WCF Planner` : `Welcome to WCF Planner`,
            html: welcomeEmailHtml(name, email, role, resetLink, !!test_to),
          }),
          signal: controller.signal,
        });
        const bodyText = await res.text();
        let bodyJson: Record<string, unknown> | null = null;
        try {
          bodyJson = bodyText ? JSON.parse(bodyText) : null;
        } catch (_jsonErr) {
          bodyJson = null;
        }
        if (!res.ok) {
          welcomeEmailDelivered = false;
          const parsedMsg =
            (bodyJson && typeof bodyJson.message === 'string' && bodyJson.message) ||
            (bodyJson && typeof bodyJson.error === 'string' && bodyJson.error) ||
            bodyText ||
            `HTTP ${res.status}`;
          emailError = `Resend ${res.status}: ${parsedMsg}`;
        }
      } catch (e) {
        welcomeEmailDelivered = false;
        const isAbort = e instanceof Error && e.name === 'AbortError';
        emailError = isAbort
          ? 'Resend timed out after 10s'
          : `Resend fetch failed: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        clearTimeout(timeoutId);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          user: {id: createdUserId, email},
          welcomeEmailDelivered,
          ...(welcomeEmailDelivered ? {} : {emailError: `sendEmail: ${emailError}`, step: 'sendEmail'}),
        }),
        {headers: {...corsHeaders, 'Content-Type': 'application/json'}},
      );
    }

    // ─── USER WELCOME — sent when admin creates a new user ───
    if (type === 'user_welcome') {
      if (!data.email) throw new Error('email required');
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      // Generate a magic recovery link so they can set their password
      const {data: linkData, error: linkError} = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: data.email,
        options: {redirectTo: 'https://wcfplanner.com'},
      });
      if (linkError) throw new Error(linkError.message);
      const resetLink = linkData.properties?.action_link || 'https://wcfplanner.com';

      const res = await sendEmail({
        from: AUTH_FROM,
        to: test_to ? [test_to] : [data.email],
        ...(test_to ? {} : {bcc: ['ronnie@whitecreek.farm']}),
        subject: test_to ? `[TEST] Welcome to WCF Planner` : `Welcome to WCF Planner`,
        html: welcomeEmailHtml(data.name || '', data.email, data.role || 'farm_team', resetLink, !!test_to),
      });
      const result = await res.json();
      return new Response(JSON.stringify({ok: true, result}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    // ─── PASSWORD RESET — admin triggered or user forgot ───
    if (type === 'password_reset') {
      const missingEnv: string[] = [];
      if (!SUPABASE_URL) missingEnv.push('SUPABASE_URL');
      if (!SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
      if (!RESEND_API_KEY) missingEnv.push('RESEND_API_KEY');
      if (missingEnv.length > 0) {
        return new Response(JSON.stringify({error: `config: missing env ${missingEnv.join(', ')}`, step: 'config'}), {
          status: 500,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      const email = String(data?.email || '')
        .trim()
        .toLowerCase();
      const name = String(data?.name || '').trim();
      if (!email) {
        return new Response(JSON.stringify({error: 'email required', step: 'input'}), {
          status: 400,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      let resetLink = 'https://wcfplanner.com';
      try {
        const {data: linkData, error: linkError} = await admin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: {redirectTo: 'https://wcfplanner.com'},
        });
        if (linkError) throw new Error(linkError.message || String(linkError));
        resetLink = linkData.properties?.action_link || resetLink;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const lower = msg.toLowerCase();
        const missingAccount =
          lower.includes('user not found') || lower.includes('not found') || lower.includes('does not exist');
        return new Response(
          JSON.stringify({
            error: missingAccount
              ? 'No WCF Planner account was found for that email. Use the email your account was created with, or ask an admin to send a reset.'
              : `generateLink: ${msg}`,
            step: 'generateLink',
          }),
          {status: missingAccount ? 404 : 500, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({
            from: AUTH_FROM,
            to: test_to ? [test_to] : [email],
            subject: test_to ? `[TEST] Reset your WCF Planner password` : `Reset your WCF Planner password`,
            html: passwordResetHtml(name, resetLink, !!test_to),
          }),
          signal: controller.signal,
        });
        const bodyText = await res.text();
        let result: Record<string, unknown> | string | null = null;
        try {
          result = bodyText ? JSON.parse(bodyText) : null;
        } catch (_jsonErr) {
          result = bodyText;
        }
        if (!res.ok) {
          const parsedMsg =
            (result && typeof result === 'object' && typeof result.message === 'string' && result.message) ||
            (result && typeof result === 'object' && typeof result.error === 'string' && result.error) ||
            (typeof result === 'string' && result) ||
            `HTTP ${res.status}`;
          return new Response(
            JSON.stringify({error: `sendEmail: Resend ${res.status}: ${parsedMsg}`, step: 'sendEmail'}),
            {
              status: 502,
              headers: {...corsHeaders, 'Content-Type': 'application/json'},
            },
          );
        }
        return new Response(JSON.stringify({ok: true, result}), {
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      } catch (e) {
        const isAbort = e instanceof Error && e.name === 'AbortError';
        const msg = isAbort
          ? 'Resend timed out after 10s'
          : `Resend fetch failed: ${e instanceof Error ? e.message : String(e)}`;
        return new Response(JSON.stringify({error: `sendEmail: ${msg}`, step: 'sendEmail'}), {
          status: 502,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      } finally {
        clearTimeout(timeoutId);
      }
    }

    // ─── USER DELETE — admin hard-deletes an auth account ───
    // Migration 171 owns the profile-side boundary. Preflight proves that the
    // auth.users -> profiles cascade will not be blocked by retained farm
    // records and writes immutable intent. Auth deletion is then the ONLY
    // delete; the browser must not issue a second profiles.delete(). A terminal
    // audit row records success/failure after the cross-service call.
    //
    // Codex C4 re-review BLOCKER 1: rapid-processor is deployed with
    // --no-verify-jwt so the platform does NOT enforce authentication
    // for us. Verify the caller in-function via rpc('is_admin') with
    // the caller's bearer (anon-key client + Authorization header is
    // the standard Supabase pattern for resolving auth.uid() inside
    // SECURITY DEFINER helpers). 401 on no header / 403 on non-admin.
    if (type === 'user_delete') {
      const authHeader = req.headers.get('authorization');
      if (!authHeader) {
        return new Response(JSON.stringify({error: 'unauthorized'}), {
          status: 401,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {persistSession: false, autoRefreshToken: false},
        global: {headers: {Authorization: authHeader}},
      });
      const {data: isAdminData, error: isAdminErr} = await userClient.rpc('is_admin');
      if (isAdminErr || isAdminData !== true) {
        return new Response(JSON.stringify({error: 'forbidden'}), {
          status: 403,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      const profileId = String(data?.id || '').trim();
      const expectedEmail = String(data?.email || '')
        .trim()
        .toLowerCase();
      if (!profileId || !expectedEmail) {
        return new Response(JSON.stringify({error: 'id and email required', step: 'input'}), {
          status: 400,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }

      let {data: prepareData, error: prepareError} = await userClient.rpc('admin_prepare_user_delete', {
        p_profile_id: profileId,
        p_expected_email: expectedEmail,
      });

      // A stale preflight is terminalized in its own database transaction.
      // Retry prepare exactly once so any fresh last-admin/FK failure cannot
      // roll that recovery row back.
      if (!prepareError && prepareData?.retry_required === true) {
        const retried = await userClient.rpc('admin_prepare_user_delete', {
          p_profile_id: profileId,
          p_expected_email: expectedEmail,
        });
        prepareData = retried.data;
        prepareError = retried.error;
      }

      if (prepareError || !prepareData?.request_id) {
        return new Response(
          JSON.stringify({
            error: prepareError?.message || 'delete preflight returned no request id',
            step: 'deletePreflight',
          }),
          {status: 409, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      // Idempotent recovery: Auth + profile are already absent and the RPC
      // either appended the missing success terminal or found an existing one.
      // Do not issue a second Auth delete.
      if (prepareData.already_deleted === true) {
        return new Response(
          JSON.stringify({
            ok: true,
            deleted: expectedEmail,
            alreadyDeleted: true,
            auditFinalized: true,
            auditRecovered: prepareData.audit_recovered === true,
          }),
          {headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      const requestId = prepareData.request_id;
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const {error: deleteError} = await admin.auth.admin.deleteUser(profileId);
      if (deleteError) {
        const {data: auditData, error: auditError} = await userClient.rpc('admin_finalize_user_delete', {
          p_request_id: requestId,
          p_succeeded: false,
          p_error_message: deleteError.message || String(deleteError),
        });

        // The Auth API can surface an ambiguous transport error after its
        // remote delete committed. Finalize checks both auth + profile; when
        // both are absent it records authoritative success instead of a false
        // failure terminal.
        if (!auditError && auditData?.event_type === 'profile.deleted') {
          return new Response(
            JSON.stringify({
              ok: true,
              deleted: expectedEmail,
              alreadyDeleted: true,
              auditFinalized: true,
              auditRecovered: true,
            }),
            {headers: {...corsHeaders, 'Content-Type': 'application/json'}},
          );
        }

        return new Response(
          JSON.stringify({
            error: `deleteUser: ${deleteError.message || String(deleteError)}`,
            step: 'deleteUser',
            auditFinalized: !auditError,
          }),
          {status: 409, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }

      const {error: auditError} = await userClient.rpc('admin_finalize_user_delete', {
        p_request_id: requestId,
        p_succeeded: true,
        p_error_message: null,
      });

      // If finalization itself failed after Auth success, immediately invoke
      // prepare's missing-target reconciliation path before returning. This
      // keeps recovery reachable even though the UI correctly removes the now-
      // deleted row after a successful response.
      let reconciliationError = auditError;
      let auditRecovered = false;
      if (auditError) {
        const reconciled = await userClient.rpc('admin_prepare_user_delete', {
          p_profile_id: profileId,
          p_expected_email: expectedEmail,
        });
        if (!reconciled.error && reconciled.data?.already_deleted === true) {
          reconciliationError = null;
          auditRecovered = reconciled.data.audit_recovered === true;
        } else if (reconciled.error) {
          reconciliationError = reconciled.error;
        }
      }
      if (reconciliationError) {
        return new Response(
          JSON.stringify({
            error: `deleteAudit: ${reconciliationError.message || String(reconciliationError)}`,
            step: 'deleteAudit',
            auditFinalized: false,
          }),
          {status: 409, headers: {...corsHeaders, 'Content-Type': 'application/json'}},
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          deleted: expectedEmail,
          auditFinalized: true,
          auditRecovered,
        }),
        {headers: {...corsHeaders, 'Content-Type': 'application/json'}},
      );
    }

    // ─── TASKS WEEKLY SUMMARY — branded list of one assignee's open tasks ───
    // Invoked by supabase/functions/tasks-summary/index.ts once per
    // assignee with at least one open task_instances row. Uses the
    // top-level test_to escape (not data.test_to) per Codex C4
    // amendment 5; the calling Edge Function gates cron-mode test_to
    // before this is reached.
    //
    // rapid-processor is deployed with --no-verify-jwt so the platform
    // does not enforce auth. Without an in-function gate, anyone reaching
    // this endpoint could trigger arbitrary WCF-branded emails to
    // attacker-controlled addresses. We gate on a custom shared-secret
    // header — both functions read TASKS_CRON_SECRET via envTrim from
    // the same Vault entry (the same one tasks-cron auth uses), so the
    // safeEqual byte-compare aligns reliably across the platform's
    // current key/env injection rules. Earlier iterations attempted to
    // gate via SUPABASE_SERVICE_ROLE_KEY in the Authorization header,
    // but that path proved brittle on Supabase's current platform
    // configuration; the custom header is independent of project key
    // shapes and apikey/Authorization gateway rules.
    if (type === 'tasks_weekly_summary') {
      const summarySecret = (req.headers.get('x-tasks-summary-secret') ?? '').trim();
      if (!safeEqual(summarySecret, TASKS_CRON_SECRET)) {
        return new Response(JSON.stringify({error: 'unauthorized'}), {
          status: 401,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const {email, full_name, tasks, count, completed, completed_count, todos, todos_count} = data || {};
      if (!email) throw new Error('email required');
      const openTasks = Array.isArray(tasks) ? tasks : [];
      const completedTasks = Array.isArray(completed) ? completed : [];
      const todoItems = Array.isArray(todos) ? todos : [];
      // Skip the send only when EVERY section is empty (mig 093 + mig 115).
      // A recipient with only completed-assigned tasks, or only the shared
      // To Do List, still gets an email.
      if (openTasks.length === 0 && completedTasks.length === 0 && todoItems.length === 0) {
        return new Response(JSON.stringify({ok: true, skipped: true, reason: 'no tasks'}), {
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const taskCount = typeof count === 'number' ? count : openTasks.length;
      const completedCount = typeof completed_count === 'number' ? completed_count : completedTasks.length;
      const todoCount = typeof todos_count === 'number' ? todos_count : todoItems.length;
      // Subject reflects whichever sections are present.
      const subjectParts: string[] = [];
      if (taskCount > 0) subjectParts.push(`${taskCount} open task${taskCount === 1 ? '' : 's'}`);
      if (completedCount > 0) subjectParts.push(`${completedCount} completed this week`);
      if (todoCount > 0) subjectParts.push(`${todoCount} on the to do list`);
      const subjectBase = `WCF Planner - ${subjectParts.join(', ')}`;
      // Render whichever sections have content; all renderers escape all
      // user-controlled strings.
      const bodyHtml =
        (openTasks.length > 0 ? tasksWeeklyHtml(openTasks) : '') +
        (completedTasks.length > 0 ? tasksWeeklyCompletedHtml(completedTasks) : '') +
        (todoItems.length > 0 ? tasksWeeklyTodoHtml(todoItems) : '');
      const html = brandedEmail({
        title: taskCount > 0 ? 'Open Tasks' : completedCount > 0 ? 'Completed This Week' : 'Shared To Do List',
        // brandedEmail interpolates subtitle directly into HTML; escape
        // here (Codex C4 re-review BLOCKER 2). full_name is profile data
        // but admins can self-edit so it's still untrusted.
        subtitle: escapeHtml(full_name || ''),
        bodyHtml,
        isTest: !!test_to,
      });
      const res = await sendEmail({
        from: FROM,
        to: test_to ? [test_to] : [email],
        subject: test_to ? `[TEST] ${subjectBase}` : subjectBase,
        html,
      });
      const result = await res.json();
      return new Response(JSON.stringify({ok: true, result}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    return new Response(JSON.stringify({error: 'Unknown type'}), {
      status: 400,
      headers: {...corsHeaders, 'Content-Type': 'application/json'},
    });
  } catch (err) {
    return new Response(JSON.stringify({error: err.message}), {
      status: 500,
      headers: {...corsHeaders, 'Content-Type': 'application/json'},
    });
  }
});
