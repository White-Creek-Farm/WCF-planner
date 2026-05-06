import {serve} from 'https://deno.land/std@0.168.0/http/server.ts';
import {createClient} from 'https://esm.sh/@supabase/supabase-js@2';

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const FROM = 'WCF Planner <reports@wcfplanner.com>';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
      <span style="color:#999;font-size:11px;font-family:Arial,sans-serif;">Questions? Reply to this email.</span>
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
      <span style="color:#999;font-size:11px;font-family:Arial,sans-serif;">WCF Planner · Questions? Reply to this email.</span>
    </div>
  `;
  return brandedEmail({title: '🔑 Password Reset', subtitle: 'WCF Planner', bodyHtml, isTest});
}

// ─── Tasks weekly summary table — used by tasks_weekly_summary branch (C4) ───
// Simple due-date / title rows, with optional submitted-by + source
// subtext. Does NOT inline thumbnails or signed URLs (Codex Q4).
// `tasks` shape per row: {id, due_date, title, submission_source?,
// submitted_by_team_member?}.
//
// All user-controlled strings (title / submitted_by_team_member /
// submission_source / due_date) are HTML-escaped before interpolation
// (Codex C4 re-review BLOCKER 2). Title in particular can come from
// public webform submitters or admin-typed input.
function tasksWeeklyHtml(tasks: Array<Record<string, any>>): string {
  const rows = tasks
    .map((t) => {
      const due = escapeHtml(t.due_date || '');
      const title = escapeHtml(t.title || '(untitled)');
      const ctxParts: string[] = [];
      if (t.submission_source && t.submission_source !== 'generated') {
        ctxParts.push(`source: ${escapeHtml(t.submission_source)}`);
      }
      if (t.submitted_by_team_member) {
        ctxParts.push(`from ${escapeHtml(t.submitted_by_team_member)}`);
      }
      const ctx = ctxParts.length
        ? `<div style="color:#888;font-size:12px;font-family:Arial,sans-serif;margin-top:4px;">${ctxParts.join(' · ')}</div>`
        : '';
      return `
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Arial,sans-serif;font-size:13px;color:#566542;font-weight:700;white-space:nowrap;vertical-align:top;">${due}</td>
          <td style="padding:10px 12px;border-bottom:1px solid #efeae0;font-family:Georgia,serif;font-size:14px;color:#232323;vertical-align:top;">
            ${title}
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
    <p style="font-family:Georgia,serif;font-size:13px;color:#888;line-height:1.6;margin:0;">
      Open the planner to mark tasks complete: <a href="https://wcfplanner.com/my-tasks" style="color:#566542;text-decoration:underline;">wcfplanner.com/my-tasks</a>
    </p>
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
        from: FROM,
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
      if (!data.email) throw new Error('email required');
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const {data: linkData, error: linkError} = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: data.email,
        options: {redirectTo: 'https://wcfplanner.com'},
      });
      if (linkError) throw new Error(linkError.message);
      const resetLink = linkData.properties?.action_link || 'https://wcfplanner.com';

      const res = await sendEmail({
        from: FROM,
        to: test_to ? [test_to] : [data.email],
        subject: test_to ? `[TEST] Reset your WCF Planner password` : `Reset your WCF Planner password`,
        html: passwordResetHtml(data.name || '', resetLink, !!test_to),
      });
      const result = await res.json();
      return new Response(JSON.stringify({ok: true, result}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    // ─── USER DELETE — admin hard-deletes an auth account ───
    // Source restored to repo as part of C4 (was deploy-only artifact;
    // archive/SESSION_LOG.md:1397+1436+1539 confirm "Ronnie pasted that
    // block in mid-session, deployed it"). UsersModal.jsx:131-148 is
    // the live caller. NO email sent — this just frees the email so
    // it can be re-invited; the JS caller deletes the profiles row
    // afterward.
    //
    // Codex C4 re-review BLOCKER 1: rapid-processor is deployed with
    // --no-verify-jwt so the platform does NOT enforce authentication
    // for us. Verify the caller in-function via rpc('is_admin') with
    // the caller's bearer (anon-key client + Authorization header is
    // the standard Supabase pattern for resolving auth.uid() inside
    // SECURITY DEFINER helpers). 401 on no header / 403 on non-admin.
    if (type === 'user_delete') {
      if (!data.id) throw new Error('id required');
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
      const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const {error} = await admin.auth.admin.deleteUser(data.id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ok: true, deleted: data.email || null}), {
        headers: {...corsHeaders, 'Content-Type': 'application/json'},
      });
    }

    // ─── TASKS WEEKLY SUMMARY — branded list of one assignee's open tasks ───
    // Invoked by supabase/functions/tasks-summary/index.ts once per
    // assignee with at least one open task_instances row. Uses the
    // top-level test_to escape (not data.test_to) per Codex C4
    // amendment 5; the calling Edge Function gates cron-mode test_to
    // before this is reached.
    //
    // Codex C4 re-review BLOCKER 5: rapid-processor is deployed with
    // --no-verify-jwt so the platform does not enforce auth. Without
    // an in-function gate, anyone reaching this endpoint could trigger
    // arbitrary WCF-branded emails to attacker-controlled addresses.
    // Require the caller's bearer to byte-equal SUPABASE_SERVICE_ROLE_KEY
    // — only tasks-summary (running in this same project) sends that.
    // Constant-time-ish compare via safeEqual mirrors the tasks-cron
    // auth pattern.
    if (type === 'tasks_weekly_summary') {
      const bearer = extractBearer(req.headers.get('authorization'));
      if (!safeEqual(bearer, SUPABASE_SERVICE_ROLE_KEY)) {
        return new Response(JSON.stringify({error: 'unauthorized'}), {
          status: 401,
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const {email, full_name, tasks, count} = data || {};
      if (!email) throw new Error('email required');
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return new Response(JSON.stringify({ok: true, skipped: true, reason: 'no tasks'}), {
          headers: {...corsHeaders, 'Content-Type': 'application/json'},
        });
      }
      const taskCount = typeof count === 'number' ? count : tasks.length;
      const subjectBase = `WCF Planner - ${taskCount} open task${taskCount === 1 ? '' : 's'}`;
      const html = brandedEmail({
        title: 'Open Tasks',
        // brandedEmail interpolates subtitle directly into HTML; escape
        // here (Codex C4 re-review BLOCKER 2). full_name is profile data
        // but admins can self-edit so it's still untrusted.
        subtitle: escapeHtml(full_name || ''),
        bodyHtml: tasksWeeklyHtml(tasks),
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
