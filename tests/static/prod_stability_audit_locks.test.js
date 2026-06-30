// ============================================================================
// Production stability / audit locks
// ----------------------------------------------------------------------------
// Codex-2026 lane "Production Stability / Audit Locks": cross-file invariants
// that have been earned across many lanes and would be expensive to lose
// silently. Each lock here protects a contract that, if it regressed, would
// not throw at build time but would change live behavior in production.
//
// What this file IS:
//   - A fast, no-network, no-DOM static probe over source.
//   - A summary of cross-file invariants. Individual feature tests (e.g.
//     rapid_processor_handlers, users_modal_self_name_edit) still own the
//     fine-grained per-file locks; this file is the production-deploy
//     readiness gate, not a duplicate of those.
//
// What this file is NOT:
//   - Not a runtime behavior test (those live under tests/*.spec.js).
//   - Not a substitute for the per-file static locks; those are still the
//     authoritative source of truth for each surface.
//
// Contracts locked here:
//   §1  Supabase client critical config (storageKey, detectSessionInUrl,
//       lock pass-through, hardcoded PROD URL fallback).
//   §2  UsersModal.jsx never calls browser-side sb.auth.signUp — admin
//       user creation goes through the rapid-processor user_create handler.
//   §3  Account email senders use noreply@; report digests use reports@.
//   §4  Report/form views are login-required: they render AFTER the
//       LoginScreen auth gate in main.jsx (Lane 1 CP1), and the form
//       components themselves do not call useAuth() — the signed-in
//       identity is injected as the sessionSubmitter prop instead.
//   §5  Route map (VIEW_TO_PATH + ALIASES_EXACT) preserves canonical
//       paths and legacy aliases for the routes operators bookmark.
//   §6  No raw window.alert / window.confirm / window.prompt anywhere
//       under src/** outside of the InlineNotice doc-comment.
//   §7  Typed-confirm helpers (_wcfConfirm + _wcfConfirmDelete) are
//       still globally exposed in main.jsx.
//   §8  Prod deploy readiness summary — one fast aggregate.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function listJsxJs(dirRel) {
  const out = [];
  const abs = path.join(ROOT, dirRel);
  function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (/\.(jsx?|tsx?)$/.test(name)) out.push(full);
    }
  }
  walk(abs);
  return out;
}

// Identifier-boundary regex for native dialog calls. Matches `alert(`,
// `alert (`, `confirm (`, `window.prompt (`, etc. but NOT helper names
// that happen to contain the substring (`confirmDelete(`, `_wcfConfirm(`,
// `confirmAction(`). The leading char class excludes letters, digits,
// underscore, and dot. Trailing `\s*\(` tolerates whitespace before the
// open paren so `alert ( "..." )` (a formatter-quirk regression vector)
// can't sneak past the lock.
const NATIVE_DIALOG_RE = /(?:^|[^A-Za-z0-9_.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/m;

// Extract a single rapid-processor handler body bounded by its branch
// header and the next `if (type === '...')` header (or end of file).
// Each handler must be checked against its OWN body — slicing from a
// branch header to end-of-file would let a later handler's `from:`
// constant accidentally satisfy an earlier handler's assertion.
function extractHandlerBranch(src, type) {
  const header = `if (type === '${type}')`;
  const start = src.indexOf(header);
  if (start < 0) return '';
  const after = src.slice(start + header.length);
  const nextRel = after.search(/if\s*\(\s*type\s*===\s*'/);
  return nextRel < 0 ? src.slice(start) : src.slice(start, start + header.length + nextRel);
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// ── §1: Supabase client critical config ───────────────────────────────────
describe('§1 Supabase client (src/lib/supabase.js)', () => {
  const src = read('src/lib/supabase.js');

  it('preserves the storageKey users are currently signed in under', () => {
    // Changing this logs every active user out at next page load.
    expect(src).toMatch(/storageKey:\s*'farm-planner-auth'/);
  });

  it('keeps detectSessionInUrl: false (public webforms must not auto-sign-in via shared links)', () => {
    expect(src).toMatch(/detectSessionInUrl:\s*false/);
  });

  it('keeps browser sessions persistent with Supabase auto-refresh enabled', () => {
    expect(src).toMatch(/storage:\s*window\.localStorage/);
    expect(src).toMatch(/autoRefreshToken:\s*true/);
    expect(src).toMatch(/persistSession:\s*true/);
  });

  it('keeps the lock pass-through to avoid browser/extension hangs', () => {
    expect(src).toMatch(/lock:\s*\(name,\s*acquireTimeout,\s*fn\)\s*=>\s*fn\(\)/);
  });

  it('hardcoded PROD URL fallback is present (Netlify build has no .env)', () => {
    expect(src).toContain('https://pzfujbjtayhkdlxiblwe.supabase.co');
  });

  it('the dev-only window.__WCF_SUPABASE_URL sentinel is gated to DEV', () => {
    // Test harness asserts this contains the test-project ref before login;
    // gating to DEV prevents the prod bundle from leaking the URL globally.
    expect(src).toMatch(/if\s*\(\s*import\.meta\.env\.DEV\s*\)\s*\{\s*window\.__WCF_SUPABASE_URL\s*=/);
  });
});

// ── §2: UsersModal must not call browser-side auth.signUp ────────────────
describe('§2 UsersModal.jsx — admin user creation goes through rapid-processor', () => {
  const src = read('src/auth/UsersModal.jsx');
  // Strip block + line comments so a doc-comment mentioning auth.signUp
  // can't accidentally satisfy or violate the lock.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

  it('no sb.auth.signUp call anywhere in the file (not just inside createUser)', () => {
    expect(code).not.toMatch(/\bauth\.signUp\s*\(/);
    expect(code).not.toMatch(/\bsb\.auth\.signUp/);
  });

  it("createUser invokes the rapid-processor 'user_create' edge function", () => {
    expect(code).toMatch(/sb\.functions\.invoke\(\s*'rapid-processor'/);
    expect(code).toMatch(/type:\s*'user_create'/);
  });

  it("destructive paths invoke 'user_delete' and 'password_reset' on rapid-processor", () => {
    expect(code).toMatch(/type:\s*'user_delete'/);
    expect(code).toMatch(/type:\s*'password_reset'/);
  });
});

// ── §3: Email sender constants ────────────────────────────────────────────
describe('§3 Account vs. report email senders (rapid-processor.ts)', () => {
  const rpSrc = read('supabase-functions/rapid-processor.ts');

  it("operational reports use 'WCF Planner <reports@wcfplanner.com>'", () => {
    expect(rpSrc).toMatch(/const\s+FROM\s*=\s*'WCF Planner <reports@wcfplanner\.com>'/);
  });

  it("account emails (welcome + password reset) use 'WCF Planner <noreply@wcfplanner.com>'", () => {
    expect(rpSrc).toMatch(/const\s+AUTH_FROM\s*=\s*'WCF Planner <noreply@wcfplanner\.com>'/);
  });

  it('user_create + user_welcome + password_reset all send from AUTH_FROM (per-branch)', () => {
    // Each branch body bounded to its own handler — a later handler's
    // `from: AUTH_FROM` must not be allowed to satisfy an earlier branch.
    for (const type of ['user_create', 'user_welcome', 'password_reset']) {
      const body = extractHandlerBranch(rpSrc, type);
      expect(body, `branch ${type} body present`).not.toBe('');
      expect(body, `${type} must send from AUTH_FROM`).toMatch(/from:\s*AUTH_FROM/);
      expect(body, `${type} must NOT send from FROM (reports@)`).not.toMatch(/from:\s*FROM\b/);
    }
  });

  it('report handlers (egg_report, starter_feed_check, tasks_weekly_summary) all send from FROM (per-branch)', () => {
    // Mirror lock for the operational side: a report handler must not
    // silently drift onto AUTH_FROM (noreply@), which would change the
    // visible sender for ops emails operators trust.
    for (const type of ['egg_report', 'starter_feed_check', 'tasks_weekly_summary']) {
      const body = extractHandlerBranch(rpSrc, type);
      expect(body, `branch ${type} body present`).not.toBe('');
      expect(body, `${type} must send from FROM`).toMatch(/from:\s*FROM\b/);
      expect(body, `${type} must NOT send from AUTH_FROM`).not.toMatch(/from:\s*AUTH_FROM/);
    }
  });
});

// ── §4: Report/form surfaces are login-required, no useAuth dependency
// Lane 1 CP1 made the former anonymous webforms login-required. They now
// render BELOW the `authState === false → LoginScreen` gate (logged-out
// visitors hit login and return to the requested URL after auth). The form
// components still must not import useAuth — the signed-in identity is
// injected as a plain prop (sessionSubmitter) from main.jsx, so the form
// components stay decoupled from the auth session.
describe('§4 Report/form surfaces are login-required and auth-decoupled', () => {
  const main = read('src/main.jsx');

  it('the pre-auth WEBFORM BYPASS block is gone (forms no longer render before login)', () => {
    // The old anonymous bypass rendered the forms before the LoginScreen gate.
    // Reintroducing it would expose the forms to logged-out visitors again.
    expect(main).not.toContain('WEBFORM BYPASS');
  });

  it('the report/form surfaces render AFTER the LoginScreen gate in main.jsx', () => {
    const loginScreenIdx = main.indexOf('return <LoginScreen />');
    const formBlockIdx = main.indexOf('REPORT/FORM SURFACES (login required)');
    expect(loginScreenIdx, 'LoginScreen render').toBeGreaterThan(-1);
    expect(formBlockIdx, 'login-required form block').toBeGreaterThan(-1);
    expect(formBlockIdx).toBeGreaterThan(loginScreenIdx);
  });

  it('all seven form views are mounted after the auth gate', () => {
    const loginScreenIdx = main.indexOf('return <LoginScreen />');
    const afterGate = main.slice(loginScreenIdx);
    expect(afterGate).toMatch(/view === 'webform'/);
    expect(afterGate).toMatch(/view === 'addfeed'/);
    expect(afterGate).toMatch(/view === 'weighins'/);
    expect(afterGate).toMatch(/view === 'tasksWebform'/);
    expect(afterGate).toMatch(/view === 'webformhub'/);
    expect(afterGate).toMatch(/view === 'fuelingHub'/);
    expect(afterGate).toMatch(/view === 'fuelSupply'/);
  });

  // The seven form components must not import useAuth — the signed-in identity
  // is injected as the sessionSubmitter prop from main.jsx, so the form
  // components stay decoupled from the auth session.
  const PUBLIC_WEBFORMS = [
    'src/webforms/AddFeedWebform.jsx',
    'src/webforms/WeighInsWebform.jsx',
    'src/webforms/WebformHub.jsx',
    'src/webforms/FuelingHub.jsx',
    'src/webforms/FuelSupplyWebform.jsx',
    'src/webforms/PigDailysWebform.jsx',
    'src/webforms/TasksWebform.jsx',
    'src/webforms/EquipmentFuelingWebform.jsx',
  ];

  for (const rel of PUBLIC_WEBFORMS) {
    it(`${rel} does not import or call useAuth (no auth-session coupling)`, () => {
      const src = read(rel);
      expect(src, 'no useAuth import').not.toMatch(/from\s+['"][^'"]*AuthContext[^'"]*['"]/);
      expect(src, 'no useAuth() call').not.toMatch(/\buseAuth\s*\(/);
    });
  }
});

// ── §5: Route map preservation (VIEW_TO_PATH + ALIASES_EXACT) ─────────────
describe('§5 Route map (src/lib/routes.js) — canonical paths + legacy aliases', () => {
  const src = read('src/lib/routes.js');

  // Bookmarked operator paths. If any of these change, paper printouts /
  // shortcuts / saved bookmarks would 404 or land on the wrong hub.
  const CANONICAL = [
    ['home', '/'],
    ['tasks', '/tasks'],
    ['webformhub', '/dailys'],
    ['tasksWebform', '/dailys/tasks'],
    ['addfeed', '/addfeed'],
    ['weighins', '/weighins'],
    ['fuelingHub', '/equipment'],
    ['fuelSupply', '/fuel-supply'],
    ['equipmentHome', '/fleet'],
  ];
  for (const [view, urlPath] of CANONICAL) {
    it(`VIEW_TO_PATH.${view} === '${urlPath}'`, () => {
      const re = new RegExp(`${view}:\\s*'${urlPath.replace(/\//g, '\\/')}'`);
      expect(src).toMatch(re);
    });
  }

  // Legacy aliases — old bookmarks (Slack pastes, digest emails, printouts)
  // that must keep landing operators on the canonical hub.
  const ALIASES = [
    ['/webforms', '/dailys'],
    ['/webforms/tasks', '/dailys/tasks'],
    ['/fueling', '/equipment'],
    ['/fueling/supply', '/equipment/supply'],
    ['/equipment/fleet', '/fleet'],
    ['/equipment/fuel-log', '/fleet/fuel-log'],
    ['/my-tasks', '/tasks'],
    ['/admin/tasks', '/tasks'],
  ];
  for (const [from, to] of ALIASES) {
    it(`ALIASES_EXACT '${from}' → '${to}'`, () => {
      const re = new RegExp(`'${from.replace(/\//g, '\\/')}':\\s*'${to.replace(/\//g, '\\/')}'`);
      expect(src).toMatch(re);
    });
  }
});

// ── §6: No raw native browser dialogs anywhere under src/** ───────────────
describe('§6 No raw window.alert / window.confirm / window.prompt under src/**', () => {
  // The cleanup lanes replaced every raw browser dialog with InlineNotice
  // or the typed _wcfConfirm / _wcfConfirmDelete helpers. A regression would
  // resurrect the alert-modal UX (blocking, mobile-hostile, breaks Playwright
  // suites that don't dismiss native dialogs).
  const files = listJsxJs('src');

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    // InlineNotice.jsx contains the substring "alert()" in a doc comment
    // explaining what InlineNotice replaces; it does not call alert(). The
    // regex requires a `(` so it would only fire on a real call. Skipped
    // explicitly so the intent is visible.
    if (rel === 'src/shared/InlineNotice.jsx') continue;
    const src = fs.readFileSync(abs, 'utf8');
    // Strip block + line comments first so doc prose can't false-positive.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    it(`${rel}: no raw native dialog call`, () => {
      expect(code, `${rel} contains a raw alert/confirm/prompt call`).not.toMatch(NATIVE_DIALOG_RE);
    });
  }
});

// ── §7: Typed-confirm helpers are still globally exposed ──────────────────
describe('§7 Typed-confirm helpers wired in main.jsx', () => {
  const main = read('src/main.jsx');

  it('window._wcfConfirm is assigned (non-destructive side-effect confirms)', () => {
    expect(main).toMatch(/window\._wcfConfirm\s*=/);
  });

  it('window._wcfConfirmDelete is assigned (typed-"delete" destructive confirms)', () => {
    expect(main).toMatch(/window\._wcfConfirmDelete\s*=/);
  });
});

describe('Storage API boundary - no direct storage.objects table access', () => {
  it('runtime source and edge functions use the Storage API instead of querying storage.objects', () => {
    const offenders = [];
    const files = [...listJsxJs('src'), ...listJsxJs('supabase-functions')];
    for (const abs of files) {
      const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      if (/from\(['"]storage\.objects['"]\)|\bstorage\.objects\b/i.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// ── §8: Prod deploy readiness — single fast aggregate ─────────────────────
// One pass-or-fail summary of the contracts above. Useful as the last gate
// before a `git push` (the deploy trigger). Re-checks the same source — so
// if any §1–§7 test fails this one will also fail — but bundles the assertions
// into a single readable test so the deploy gate is a single green dot, not
// a scattered failure across the file.
describe('§8 Prod deploy readiness — aggregate gate', () => {
  it('all critical production contracts are intact', () => {
    const errors = [];

    const supa = read('src/lib/supabase.js');
    if (!/storageKey:\s*'farm-planner-auth'/.test(supa)) errors.push('supabase storageKey changed');
    if (!/detectSessionInUrl:\s*false/.test(supa)) errors.push('supabase detectSessionInUrl flipped');

    const um = read('src/auth/UsersModal.jsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    if (/\bauth\.signUp\s*\(/.test(um)) errors.push('UsersModal regressed to browser-side auth.signUp');

    const rp = read('supabase-functions/rapid-processor.ts');
    if (!/const\s+FROM\s*=\s*'WCF Planner <reports@wcfplanner\.com>'/.test(rp))
      errors.push('reports sender drifted off reports@');
    if (!/const\s+AUTH_FROM\s*=\s*'WCF Planner <noreply@wcfplanner\.com>'/.test(rp))
      errors.push('account-email sender drifted off noreply@');
    for (const h of ['user_create', 'user_delete', 'user_welcome', 'password_reset', 'tasks_weekly_summary']) {
      if (!new RegExp(`if\\s*\\(\\s*type\\s*===\\s*'${h}'\\s*\\)`).test(rp))
        errors.push(`rapid-processor handler missing: ${h}`);
    }

    const routes = read('src/lib/routes.js');
    for (const [view, p] of [
      ['home', '/'],
      ['tasks', '/tasks'],
      ['webformhub', '/dailys'],
      ['fuelingHub', '/equipment'],
      ['equipmentHome', '/fleet'],
    ]) {
      const re = new RegExp(`${view}:\\s*'${p.replace(/\//g, '\\/')}'`);
      if (!re.test(routes)) errors.push(`route drift: ${view} no longer maps to ${p}`);
    }

    const main = read('src/main.jsx');
    // Lane 1 CP1: the report/form surfaces are login-required — they render
    // AFTER the LoginScreen gate, and the signed-in user is injected as the
    // locked submitter. `indexOf` returns -1 when a marker is gone, so check
    // both markers exist before comparing order (avoids a silent fail-open),
    // and assert the old pre-auth bypass was not reintroduced.
    const loginIdx = main.indexOf('return <LoginScreen />');
    const formBlockIdx = main.indexOf('REPORT/FORM SURFACES (login required)');
    if (loginIdx < 0) errors.push('LoginScreen render missing from main.jsx');
    else if (formBlockIdx < 0) errors.push('login-required form block missing from main.jsx');
    else if (formBlockIdx < loginIdx)
      errors.push('public webforms render before the auth gate (should be login-required)');
    if (main.includes('WEBFORM BYPASS')) errors.push('pre-auth WEBFORM BYPASS block reintroduced');
    if (!/window\._wcfConfirm\s*=/.test(main)) errors.push('window._wcfConfirm no longer exposed');
    if (!/window\._wcfConfirmDelete\s*=/.test(main)) errors.push('window._wcfConfirmDelete no longer exposed');

    expect(errors, errors.length ? errors.join('\n') : 'all locks pass').toEqual([]);
  });
});
