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
  it('Header exposes the client-errors item only inside the admin block', () => {
    expect(headerSrc).toContain('data-header-menu-item="client-errors"');
    expect(headerSrc).toMatch(/isAdmin &&[\s\S]*?data-header-menu-item="client-errors"[\s\S]*?<\/>/);
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
