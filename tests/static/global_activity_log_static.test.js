import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {VIEW_TO_PATH, PATH_TO_VIEW} from '../../src/lib/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig065 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/065_global_activity_log.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/globalActivityApi.js'), 'utf8');
const viewSrc = fs.readFileSync(path.join(ROOT, 'src/activity/ActivityLogView.jsx'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');

describe('Route /activity', () => {
  it('maps activity view to /activity', () => {
    expect(VIEW_TO_PATH.activity).toBe('/activity');
    expect(PATH_TO_VIEW['/activity']).toBe('activity');
  });

  it('main.jsx includes activity in VALID_VIEWS', () => {
    expect(mainSrc).toContain("'activity'");
  });

  it('main.jsx renders ActivityLogView for activity view', () => {
    expect(mainSrc).toContain('ActivityLogView');
  });
});

describe('Migration 065 — list_global_activity RPC', () => {
  it('creates SECURITY DEFINER RPC', () => {
    expect(mig065).toContain('list_global_activity');
    expect(mig065).toContain('SECURITY DEFINER');
  });

  it('requires auth and rejects inactive', () => {
    expect(mig065).toContain('profile_role()');
    expect(mig065).toContain('inactive');
  });

  it('calls _activity_can_read for per-row filtering', () => {
    expect(mig065).toContain('_activity_can_read(ae.entity_type, ae.entity_id)');
  });

  it('supports entity_type and search filters', () => {
    expect(mig065).toContain('p_entity_type');
    expect(mig065).toContain('p_search');
    expect(mig065).toContain('p_before');
  });

  it('returns actor name and mention resolution', () => {
    expect(mig065).toContain('actor_display_name');
    expect(mig065).toContain('mentioned_profile_ids');
    expect(mig065).toContain('mentioned_profile_names');
  });

  it('grants to authenticated only', () => {
    expect(mig065).toMatch(/GRANT EXECUTE.*TO authenticated/);
    expect(mig065).toMatch(/REVOKE ALL.*FROM PUBLIC, anon/);
  });
});

describe('globalActivityApi', () => {
  it('calls list_global_activity RPC', () => {
    expect(apiSrc).toContain("'list_global_activity'");
  });

  it('does not query activity_events or activity_mentions directly', () => {
    expect(apiSrc).not.toContain("from('activity_events')");
    expect(apiSrc).not.toContain("from('activity_mentions')");
  });
});

describe('ActivityLogView', () => {
  it('does not query activity tables directly', () => {
    expect(viewSrc).not.toContain("from('activity_events')");
    expect(viewSrc).not.toContain("from('activity_mentions')");
  });

  it('has search and entity type filter', () => {
    expect(viewSrc).toContain('search');
    expect(viewSrc).toContain('entityFilter');
  });

  it('has load more pagination', () => {
    expect(viewSrc).toContain('Load more');
    expect(viewSrc).toContain('hasMore');
  });

  it('navigates to the entity record page on row click (no legacy modal)', () => {
    // Global Activity Log is read-only audit history. Rows route to the
    // entity's dedicated record page via the registry; the legacy
    // ActivityModal/ActivityPanel composer is gone.
    expect(viewSrc).not.toContain('ActivityModal');
    expect(viewSrc).not.toContain('setActivityTarget');
    expect(viewSrc).toContain('useNavigate');
    expect(viewSrc).toContain('getActivityEntityMeta');
    expect(viewSrc).toMatch(/navigate\(meta\.route\(/);
  });

  it('marks non-routable rows inert (no pointer cursor, no onClick)', () => {
    expect(viewSrc).toContain('data-activity-log-routable');
    expect(viewSrc).toMatch(/routable \? 'pointer' : 'default'/);
    expect(viewSrc).toMatch(/routable \? \(\) => handleRowClick\(r\) : undefined/);
  });

  it('shows empty/loading/error states', () => {
    expect(viewSrc).toContain('Loading');
    expect(viewSrc).toContain('No activity found');
    expect(viewSrc).toContain('const [loadError, setLoadError] = React.useState(null)');
    expect(viewSrc).toContain('React.createElement(InlineNotice, {notice: loadError})');
  });

  it('fails closed on initial activity load errors with a stable readiness marker', () => {
    expect(viewSrc).toContain("data-activity-log-loaded': loading || loadError ? 'false' : 'true'");
    expect(viewSrc).toContain("'data-activity-log-load-error': 'true'");
    // The initial/search/filter load branch clears stale rows, blocks
    // pagination, and sets the main loadError so the timeline fails closed.
    expect(viewSrc).toMatch(
      /catch \(e\)[\s\S]*?else \{[\s\S]*?setRows\(\[\]\);[\s\S]*?setHasMore\(false\);[\s\S]*?setLoadError\(/,
    );
    expect(viewSrc).toMatch(/!\s*loadError\s*&&\s*rows\.length > 0/);
    // Readiness marker must not depend on appendError — already-loaded
    // permission-filtered rows stay valid to display after an append failure.
    expect(viewSrc).not.toMatch(/data-activity-log-loaded[^\n]*appendError/);
  });

  it('keeps loaded rows visible when a Load more append fails (does not fail closed)', () => {
    expect(viewSrc).toContain('const [appendError, setAppendError] = React.useState(null)');
    expect(viewSrc).toContain('const [loadingMore, setLoadingMore] = React.useState(false)');
    // Append failure sets the separate appendError, NOT the main loadError,
    // and does not clear rows or hasMore.
    expect(viewSrc).toMatch(/catch \(e\)[\s\S]*?if \(append\) \{[\s\S]*?setAppendError\(/);
    // Duplicate concurrent appends are blocked while a page is in flight.
    expect(viewSrc).toMatch(/if \(loadingMore\) return/);
    // A user-visible append error + retry control sits near the Load more
    // button; the timeline gate (!loadError && rows.length > 0) keeps rows.
    expect(viewSrc).toContain("'data-activity-log-append-error': 'true'");
    expect(viewSrc).toContain('disabled: loadingMore');
    expect(viewSrc).toContain('Retry loading more');
    expect(viewSrc).toMatch(/!\s*loadError\s*&&\s*rows\.length > 0[\s\S]*?hasMore\s*&&[\s\S]*?!loading/);
  });

  it('exposes a user-gated retry that re-runs the existing initial load path', () => {
    expect(viewSrc).toContain('const [reloadKey, setReloadKey] = React.useState(0)');
    expect(viewSrc).toContain('onClick: () => setReloadKey((k) => k + 1)');
    expect(viewSrc).toContain("'data-activity-log-retry': 'true'");
    expect(viewSrc).toMatch(
      /React\.useEffect\(\(\) => \{[\s\S]*?load\(false\);[\s\S]*?\}, \[entityFilter, reloadKey\]\)/,
    );
    expect(viewSrc).not.toContain('<InlineNotice notice={loadError} onDismiss');
  });

  it('shows "(comment deleted)" for soft-deleted events instead of body', () => {
    expect(viewSrc).toContain('(comment deleted)');
    expect(viewSrc).toContain('r.deleted_at');
  });

  it('suppresses mentions on deleted comments', () => {
    expect(viewSrc).toMatch(/!r\.deleted_at\s*&&\s*r\.mentioned_profile_names/);
  });

  it('has no unused imports', () => {
    expect(viewSrc).not.toContain('routeToView');
    expect(viewSrc).not.toContain('weatherIcon');
    expect(viewSrc).not.toContain('useUI');
  });
});

describe('Header hamburger menu', () => {
  it('includes Activity under Home', () => {
    expect(headerSrc).toContain('data-header-menu-item="activity"');
  });

  it('includes Dailys under Webforms', () => {
    expect(headerSrc).toContain('data-header-menu-item="dailys"');
  });

  it('includes Equipment under Webforms', () => {
    expect(headerSrc).toContain('data-header-menu-item="equipment"');
  });

  it('does NOT include Add Feed', () => {
    expect(headerSrc).not.toContain('data-header-menu-item="addfeed"');
  });

  it('does NOT include Weigh-Ins in hamburger', () => {
    expect(headerSrc).not.toContain('data-header-menu-item="weighins"');
  });

  it('does NOT include Fuel Supply', () => {
    expect(headerSrc).not.toContain('data-header-menu-item="fuel-supply"');
  });

  it('does NOT include Submit a Task', () => {
    expect(headerSrc).not.toContain('data-header-menu-item="submit-task"');
  });
});
