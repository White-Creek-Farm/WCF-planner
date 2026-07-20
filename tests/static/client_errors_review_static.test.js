import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig077 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/077_list_client_errors_rpc.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/clientErrorsApi.js'), 'utf8');
const viewSrc = fs.readFileSync(path.join(ROOT, 'src/admin/ClientErrorsView.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');
const wfaSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/WebformsAdminView.jsx'), 'utf8');

describe('Route /admin/client-errors', () => {
  it('maps clientErrors view to /admin/client-errors', () => {
    expect(VIEW_TO_PATH.clientErrors).toBe('/admin/client-errors');
    expect(PATH_TO_VIEW['/admin/client-errors']).toBe('clientErrors');
  });
  it('main.jsx includes clientErrors in VALID_VIEWS and renders admin-gated', () => {
    expect(mainSrc).toContain("'clientErrors'");
    expect(mainSrc).toContain('import ClientErrorsView');
    expect(mainSrc).toMatch(
      /view === 'clientErrors'[\s\S]*?requireAdmin: true[\s\S]*?React\.createElement\(ClientErrorsView/,
    );
  });
  it('Header hamburger no longer exposes a Client Errors item (moved to the Admin tab row)', () => {
    // Client Errors was relocated from the hamburger into the Admin tab row.
    expect(headerSrc).not.toContain('data-header-menu-item="client-errors"');
    // The neighbouring admin menu entries stay untouched.
    expect(headerSrc).toContain('data-header-menu-item="admin"');
    expect(headerSrc).toContain('data-header-menu-item="users"');
    expect(headerSrc).toContain('data-header-menu-item="newsletter"');
  });
});

describe('Admin tab row — Client Errors tab (relocated from the hamburger)', () => {
  it('imports only the reusable ClientErrorsPanel, never the default Header-bearing page view', () => {
    // Reuse the extracted panel; do NOT duplicate the table logic and do NOT
    // pull in the default ClientErrorsView (which frames the global Header),
    // so the Admin content never mounts a second Header.
    expect(wfaSrc).toMatch(/import\s+\{ClientErrorsPanel\}\s+from\s+['"]\.\.\/admin\/ClientErrorsView\.jsx['"]/);
    expect(wfaSrc).not.toMatch(/import\s+ClientErrorsView\b/);
  });

  it('adds a Client Errors tab after Deleted (a future Site & Recovery tab will slot between them)', () => {
    const deletedIdx = wfaSrc.indexOf("{id: 'deleted', label: 'Deleted'}");
    const clientErrorsIdx = wfaSrc.indexOf("{id: 'clientErrors', label: 'Client Errors'}");
    expect(deletedIdx).toBeGreaterThan(-1);
    expect(clientErrorsIdx).toBeGreaterThan(deletedIdx);
  });

  it('keeps the existing admin tabs and their order intact', () => {
    let prev = -1;
    for (const id of ['webforms', 'equipment', 'fuellog', 'feedcosts', 'costsbymonth', 'deleted', 'clientErrors']) {
      const idx = wfaSrc.indexOf(`{id: '${id}',`);
      expect(idx, `tab ${id} present`).toBeGreaterThan(-1);
      expect(idx, `tab ${id} in order`).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it('renders the panel only when the Client Errors tab is active', () => {
    expect(wfaSrc).toMatch(/adminTab === 'clientErrors'[\s\S]*?<ClientErrorsPanel\s*\/>/);
  });
});

describe('mig 077 — list_client_errors RPC', () => {
  it('is admin-only SECURITY DEFINER with pinned search_path', () => {
    expect(mig077).toMatch(/CREATE OR REPLACE FUNCTION public\.list_client_errors[\s\S]*?SECURITY DEFINER/);
    expect(mig077).toMatch(/SET search_path = public/);
    expect(mig077).toMatch(/admin role required/);
    expect(mig077).toMatch(/authenticated caller required/);
  });
  it('returns rows ordered desc, paginated, capped, read-only (no write)', () => {
    expect(mig077).toMatch(/RETURNS SETOF public\.client_error_events/);
    expect(mig077).toMatch(/ORDER BY created_at DESC/);
    expect(mig077).toMatch(/created_at < p_before/);
    expect(mig077).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });
  it('REVOKEs anon and GRANTs authenticated; reloads PostgREST', () => {
    expect(mig077).toMatch(/REVOKE ALL ON FUNCTION public\.list_client_errors\(int, timestamptz\) FROM PUBLIC, anon/);
    expect(mig077).toMatch(/GRANT EXECUTE ON FUNCTION public\.list_client_errors\(int, timestamptz\) TO authenticated/);
    expect(mig077).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});

describe('clientErrorsApi + ClientErrorsView', () => {
  it('loadClientErrors reads through the list_client_errors RPC', () => {
    expect(apiSrc).toMatch(/export async function loadClientErrors/);
    expect(apiSrc).toContain("sb.rpc('list_client_errors'");
  });
  it('the review surface never touches the client_error_events table directly', () => {
    // Boundary-locked: reads go through loadClientErrors / the RPC only.
    expect(viewSrc).not.toMatch(/\.from\(\s*['"]client_error_events['"]\s*\)/);
    expect(apiSrc).not.toMatch(/\.from\(\s*['"]client_error_events['"]\s*\)/);
    expect(viewSrc).toContain('loadClientErrors');
  });
  it('fails closed on read errors with a stable readiness marker + Retry', () => {
    expect(viewSrc).toContain("data-client-errors-loaded': loading || loadError ? 'false' : 'true'");
    expect(viewSrc).toContain("'data-client-errors-load-error': 'true'");
    expect(viewSrc).toContain("'data-client-errors-retry': 'true'");
    expect(viewSrc).toMatch(/catch \(e\)[\s\S]*?else \{[\s\S]*?setRows\(\[\]\);[\s\S]*?setLoadError\(/);
  });
  it('renders captured error fields INERTLY — never as raw HTML (stored-XSS guard)', () => {
    // record_client_error accepts fully client-supplied message/stack/route, so
    // the admin review surface must render them as escaped React text children,
    // never via dangerouslySetInnerHTML / innerHTML.
    expect(viewSrc).not.toMatch(/dangerouslySetInnerHTML/);
    expect(viewSrc).not.toMatch(/\.innerHTML\b/);
    // The message cell is a plain React text child (auto-escaped).
    expect(viewSrc).toMatch(/cellStyle[\s\S]*?\}\s*,\s*r\.message\)/);
  });
});
