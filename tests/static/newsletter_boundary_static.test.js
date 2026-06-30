import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Boundary guards for the Monthly Newsletter lane (migs 144/145).
//   1. The PUBLIC newsletter surface (src/newsletter, minus the admin view) must
//      stay decoupled from auth/admin/secrets and never render raw HTML.
//   2. No newsletter source file may use dangerouslySetInnerHTML (the renderer
//      whitelists structured blocks; raw AI/markup never reaches the DOM).
//   3. main.jsx must mount the public archive ABOVE the LoginScreen gate and the
//      admin workspace behind a requireAdmin route guard.
//   4. Migration 144 exposes EXACTLY three anon RPCs and never leaks
//      source_private_path through the anon render payload; all five tables are
//      deny-all RLS.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(jsx?|cjs|mjs)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

const NEWSLETTER_DIR = path.join(ROOT, 'src/newsletter');
const ADMIN_VIEW = 'src/newsletter/NewsletterAdminView.jsx';

describe('newsletter public surface boundary', () => {
  const publicFiles = listFiles(NEWSLETTER_DIR).filter(
    (f) => path.relative(ROOT, f).replace(/\\/g, '/') !== ADMIN_VIEW,
  );

  it('public newsletter components never import AuthContext or useAuth', () => {
    const offenders = [];
    for (const f of publicFiles) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/useAuth\s*\(|AuthContext/.test(code)) offenders.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
    expect(offenders).toEqual([]);
  });

  it('no newsletter source file creates a Supabase client or uses admin auth', () => {
    const offenders = [];
    for (const f of listFiles(NEWSLETTER_DIR)) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (/@supabase\/supabase-js|\bcreateClient\s*\(|\bauth\.admin\b/.test(code)) {
        offenders.push(path.relative(ROOT, f).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps server-only secrets/exec hooks out of newsletter source', () => {
    const forbidden =
      /\b(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|PROD_DB_URL|DATABASE_URL|exec_sql|VITE_TEST_ADMIN_)\b/i;
    const offenders = [];
    for (const f of listFiles(NEWSLETTER_DIR)) {
      const code = stripComments(fs.readFileSync(f, 'utf8'));
      if (forbidden.test(code)) offenders.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
    expect(offenders).toEqual([]);
  });

  it('never renders raw HTML anywhere in the newsletter surface', () => {
    const offenders = [];
    for (const f of listFiles(NEWSLETTER_DIR)) {
      // Strip comments first so a prose mention ("no dangerouslySetInnerHTML
      // here") in a file header isn't treated as a real usage.
      if (/dangerouslySetInnerHTML/.test(stripComments(fs.readFileSync(f, 'utf8')))) {
        offenders.push(path.relative(ROOT, f).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('newsletter routing wiring (main.jsx)', () => {
  const main = read('src/main.jsx');

  it('mounts the public archive ABOVE the LoginScreen auth gate', () => {
    const bypassIdx = main.indexOf('NewsletterPublicApp');
    const loginIdx = main.indexOf('return <LoginScreen');
    expect(bypassIdx).toBeGreaterThan(-1);
    expect(loginIdx).toBeGreaterThan(-1);
    expect(bypassIdx).toBeLessThan(loginIdx);
  });

  it('keys the public bypass on the /newsletter pathname', () => {
    expect(main).toMatch(/location\.pathname\.startsWith\('\/newsletter\/'\)/);
  });

  it('gates the admin workspace behind requireAdmin', () => {
    const adminIdx = main.indexOf("view === 'newsletterAdmin'");
    expect(adminIdx).toBeGreaterThan(-1);
    const window = main.slice(adminIdx, adminIdx + 400);
    expect(window).toContain('UnauthorizedRedirect');
    expect(window).toContain('requireAdmin: true');
    expect(window).toContain('NewsletterAdminView');
  });
});

describe('migration 144 anon surface', () => {
  const sql = read('supabase-migrations/144_newsletter_engine.sql');

  it('grants EXACTLY the three intended anon RPCs', () => {
    const anonGrants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\)\s+TO\s+anon/g)].map(
      (m) => m[1],
    );
    expect(new Set(anonGrants)).toEqual(
      new Set(['list_published_newsletters', 'get_published_newsletter', 'get_newsletter_preview']),
    );
  });

  it('enables deny-all RLS on all five newsletter tables', () => {
    for (const t of [
      'newsletter_issues',
      'newsletter_fact_candidates',
      'newsletter_photos',
      'newsletter_runs',
      'newsletter_settings',
    ]) {
      expect(sql).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toMatch(new RegExp(`CREATE POLICY ${t}_deny_all[\\s\\S]*?FOR ALL USING \\(false\\)`));
    }
  });

  it('the anon render payload never selects source_private_path', () => {
    const fnStart = sql.indexOf('FUNCTION public._newsletter_render_payload');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = sql.indexOf('$fn$;', fnStart);
    const body = sql.slice(fnStart, fnEnd);
    expect(body).not.toContain('source_private_path');
  });

  it('schema-qualifies pgcrypto so the SECDEF search_path=public resolves it', () => {
    expect(sql).toMatch(/extensions\.gen_random_bytes\(/);
    expect(sql).toMatch(/extensions\.hmac\(/);
    // No UNqualified pgcrypto calls remain.
    expect(sql).not.toMatch(/(?<!extensions\.)gen_random_bytes\(/);
    expect(sql).not.toMatch(/(?<!extensions\.)hmac\(/);
  });
});

describe('migration 144 preview hardening', () => {
  const sql = read('supabase-migrations/144_newsletter_engine.sql');

  function fnBody(name) {
    const start = sql.indexOf(`FUNCTION public.${name}(`);
    expect(start, `${name} present`).toBeGreaterThan(-1);
    const end = sql.indexOf('$fn$;', start);
    return sql.slice(start, end);
  }

  it('create + unpublish + regenerate all set a real 30-day preview expiry', () => {
    expect(fnBody('create_newsletter_issue')).toMatch(/preview_expires_at[\s\S]*?interval '30 days'/);
    expect(fnBody('unpublish_newsletter_issue')).toMatch(/preview_expires_at\s*=\s*now\(\)\s*\+\s*interval '30 days'/);
    expect(fnBody('regenerate_newsletter_preview_token')).toMatch(
      /preview_expires_at\s*=\s*now\(\)\s*\+\s*interval '30 days'/,
    );
  });

  it('get_newsletter_preview is draft-only and rejects a NULL/expired expiry (no nullable-pass)', () => {
    const body = fnBody('get_newsletter_preview');
    expect(body).toMatch(/WHERE slug = p_slug AND status = 'draft'/);
    expect(body).toMatch(/v_expires IS NULL OR now\(\) > v_expires/);
    // The old nullable-pass form must be gone.
    expect(body).not.toMatch(/v_expires IS NOT NULL AND now\(\) > v_expires/);
  });

  it('regenerate_newsletter_preview_token rejects non-draft (published) issues', () => {
    const body = fnBody('regenerate_newsletter_preview_token');
    expect(body).toMatch(/v_status <> 'draft'/);
    expect(body).toMatch(/NEWSLETTER_VALIDATION: preview is only available for draft issues/);
  });
});

describe('migration 146 automation boundary', () => {
  const sql = read('supabase-migrations/146_newsletter_automation.sql');

  it('grants NOTHING to anon (the anon surface stays mig 144s three RPCs)', () => {
    expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION[^;]*\bTO\b[^;]*\banon\b/);
  });

  it('keeps the Edge-Function ingest RPCs service_role-only', () => {
    for (const fn of [
      'ensure_newsletter_issue',
      'replace_newsletter_harvest_facts',
      'get_newsletter_generation_input',
      'apply_newsletter_ai_draft',
      'log_newsletter_run',
      'create_newsletter_reminder_task',
    ]) {
      expect(sql, `${fn} granted to service_role`).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role`),
      );
      // ...and explicitly revoked from anon + authenticated.
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)[\\s\\S]*?authenticated`));
    }
  });

  it('leaves the monthly cron schedule GATED (not executed at apply time)', () => {
    // The only cron.schedule reference must live inside a SQL comment block; no
    // executable top-level `SELECT cron.schedule(` may run on TEST/PROD apply.
    expect(sql).not.toMatch(/^\s*SELECT\s+cron\.schedule\(/m);
    expect(sql).toMatch(/--[\s\S]*cron\.schedule\('newsletter-monthly'/);
  });

  it('does not add an apply-time Vault preflight (TEST apply must not need secrets)', () => {
    // invoke_newsletter_cron reads Vault at CALL time inside its body only.
    const preflightDoBlocks = sql.match(/DO \$preflight\$/g) || [];
    expect(preflightDoBlocks).toHaveLength(0);
  });
});

describe('newsletter draft overwrite guard (admin view)', () => {
  const view = read(ADMIN_VIEW);

  it('uses an inline confirm, never window.confirm (Codex T9 lock)', () => {
    expect(stripComments(view)).not.toMatch(/window\.confirm\s*\(/);
  });

  it('arms a two-step confirm before a blank-note Write/Rewrite replaces an existing draft', () => {
    // Revise (note present) preserves the draft; a blank-note Write/Rewrite with
    // existing blocks is the destructive path and must confirm first.
    expect(view).toMatch(/overwriteRisk\s*=\s*!isReviseMode\s*&&\s*blocks\.length\s*>\s*0/);
    expect(view).toMatch(/if\s*\(overwriteRisk\s*&&\s*!confirmRewrite\)/);
    expect(view).toContain('nla-rewrite-confirm');
  });

  it('counts and warns about placed photos that the overwrite would remove', () => {
    expect(view).toMatch(/placedPhotoCount\s*=\s*blocks\.filter/);
    expect(view).toMatch(/b\.type === 'photo' && b\.photoId/);
  });
});

describe('migration 153 archive-link gating', () => {
  const sql = read('supabase-migrations/153_newsletter_archive_link.sql');

  function fnBody(name) {
    const start = sql.indexOf(`FUNCTION public.${name}(`);
    expect(start, `${name} present`).toBeGreaterThan(-1);
    const end = sql.indexOf('$fn$;', start);
    return sql.slice(start, end);
  }

  it('the two published-archive anon RPCs require the archive key and lock otherwise', () => {
    for (const fn of ['list_published_newsletters', 'get_published_newsletter']) {
      const body = fnBody(fn);
      expect(body, `${fn} gates on the key`).toMatch(
        /IF NOT public\._newsletter_archive_key_ok\(p_key\) THEN[\s\S]*?RETURN NULL/,
      );
    }
  });

  it('the key helper does a real expiry + constant-time check and is NOT anon-callable', () => {
    const body = fnBody('_newsletter_archive_key_ok');
    expect(body).toMatch(/now\(\) > v_expires/);
    expect(body).toMatch(/extensions\.hmac\(/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\._newsletter_archive_key_ok\(text\)[\s\S]*?anon/);
  });

  it('publish mints a fresh 7-day archive key', () => {
    const body = fnBody('publish_newsletter_issue');
    expect(body).toMatch(/archive_access_token\s*=\s*encode\(extensions\.gen_random_bytes/);
    expect(body).toMatch(/archive_access_expires_at\s*=\s*now\(\)\s*\+\s*interval '7 days'/);
  });

  it('the admin regenerate RPC is admin-gated and never granted to anon', () => {
    const body = fnBody('regenerate_newsletter_archive_link');
    expect(body).toMatch(/_newsletter_assert_admin\(\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.regenerate_newsletter_archive_link\(int\) TO authenticated/);
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.regenerate_newsletter_archive_link\([^)]*\)[^;]*\banon\b/,
    );
  });

  it('grants the re-signatured published reads to anon, and adds NO other anon grant', () => {
    const anonGrants = [...sql.matchAll(/GRANT EXECUTE ON FUNCTION public\.(\w+)\([^)]*\)\s+TO\s+([^;]*)/g)]
      .filter((m) => /\banon\b/.test(m[2]))
      .map((m) => m[1]);
    expect(new Set(anonGrants)).toEqual(new Set(['list_published_newsletters', 'get_published_newsletter']));
  });
});
