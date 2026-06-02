// Static lock for Notifications Center foundation (mig 057 +
// src/lib/notificationsApi.js + Header bell wire-up).
//
// What we lock:
//   * Migration 057 ships the table, RLS policies, indexes, the
//     'task_completed' CHECK, the grants pattern (REVOKE INSERT/DELETE
//     + GRANT SELECT/UPDATE for authenticated), and the modified
//     complete_task_instance v2 with the notification insert wrapped
//     in BEGIN/EXCEPTION so a notification failure doesn't roll back
//     the completion.
//   * notificationsApi.js exposes the four helpers the Header relies on
//     (count, list, mark-one, mark-all) and the NOTIFICATIONS_CHANGE_EVENT
//     custom-event name.
//   * Header.jsx flips NOTIFICATIONS_CENTER_ENABLED true, gates the bell
//     button on real data (no placeholder onClick), and includes the
//     data-* hooks the Playwright spec uses.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const mig057 = fs.readFileSync(path.join(ROOT, 'supabase-migrations/057_notifications.sql'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/notificationsApi.js'), 'utf8');
const headerSrc = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('mig 057 — notifications table + RLS', () => {
  it('creates the notifications table with the expected columns', () => {
    expect(mig057).toMatch(/CREATE TABLE IF NOT EXISTS public\.notifications/);
    for (const col of [
      'id\\s+text PRIMARY KEY',
      'recipient_profile_id\\s+uuid NOT NULL',
      'actor_profile_id\\s+uuid',
      'type\\s+text NOT NULL',
      'task_instance_id\\s+text',
      'title\\s+text NOT NULL',
      'body\\s+text',
      'read_at\\s+timestamptz',
      'created_at\\s+timestamptz NOT NULL DEFAULT now\\(\\)',
    ]) {
      expect(mig057, `column shape missing: ${col}`).toMatch(new RegExp(col));
    }
  });

  it("locks the 'task_completed' type via CHECK constraint", () => {
    expect(mig057).toMatch(/CONSTRAINT notifications_type_check CHECK \(type IN \('task_completed'\)\)/);
  });

  it('FK targets ON DELETE CASCADE for recipient + ON DELETE SET NULL for actor', () => {
    expect(mig057).toMatch(/recipient_profile_id\s+uuid NOT NULL REFERENCES public\.profiles\(id\) ON DELETE CASCADE/);
    expect(mig057).toMatch(/actor_profile_id\s+uuid REFERENCES public\.profiles\(id\) ON DELETE SET NULL/);
    expect(mig057).toMatch(/task_instance_id\s+text REFERENCES public\.task_instances\(id\) ON DELETE CASCADE/);
  });

  it('creates the recipient_created and partial unread indexes', () => {
    expect(mig057).toMatch(/CREATE INDEX IF NOT EXISTS notifications_recipient_created_idx/);
    expect(mig057).toMatch(
      /CREATE INDEX IF NOT EXISTS notifications_recipient_unread_idx[\s\S]*?WHERE read_at IS NULL/,
    );
  });

  it('enables RLS and adds recipient-only SELECT + UPDATE policies', () => {
    expect(mig057).toMatch(/ALTER TABLE public\.notifications ENABLE ROW LEVEL SECURITY/);
    expect(mig057).toMatch(
      /CREATE POLICY notifications_recipient_select[\s\S]*?USING \(recipient_profile_id = auth\.uid\(\)\)/,
    );
    expect(mig057).toMatch(
      /CREATE POLICY notifications_recipient_update_read[\s\S]*?WITH CHECK \(recipient_profile_id = auth\.uid\(\)\)/,
    );
  });

  it('does NOT add INSERT or DELETE policies (only SECDEF + service_role write)', () => {
    expect(mig057).not.toMatch(/CREATE POLICY[^;]*FOR INSERT[^;]*ON public\.notifications/);
    expect(mig057).not.toMatch(/CREATE POLICY[^;]*FOR DELETE[^;]*ON public\.notifications/);
  });

  it('grants are tight: REVOKE ALL + GRANT SELECT + GRANT UPDATE (read_at) only', () => {
    // REVOKE ALL clears any pre-existing grants (this migration is the
    // canonical grant authority for the table); SELECT goes broad-open
    // under recipient RLS; UPDATE is column-scoped to read_at so a
    // logged-in recipient can mark-read but cannot rewrite their own
    // notification's title/body/type/task linkage.
    expect(mig057).toMatch(/REVOKE ALL ON public\.notifications FROM PUBLIC, anon, authenticated/);
    expect(mig057).toMatch(/GRANT SELECT ON public\.notifications TO authenticated/);
    expect(mig057).toMatch(/GRANT UPDATE \(read_at\) ON public\.notifications TO authenticated/);
    // Lock out the previous over-broad shape that would have allowed a
    // client to UPDATE arbitrary columns (caught by Codex pre-commit).
    expect(mig057).not.toMatch(/GRANT SELECT, UPDATE ON public\.notifications TO authenticated/);
    expect(mig057).not.toMatch(/GRANT ALL ON public\.notifications TO authenticated/);
  });
});

describe('mig 057 — complete_task_instance v2 inserts notification', () => {
  it('replaces the v2 (text, text, text[]) overload', () => {
    expect(mig057).toMatch(
      /CREATE OR REPLACE FUNCTION public\.complete_task_instance\([\s\S]*?p_instance_id text[\s\S]*?p_completion_note text[\s\S]*?p_completion_photo_paths text\[\][\s\S]*?\) RETURNS jsonb/,
    );
  });

  it('reads created_by_profile_id + title on the existing row select', () => {
    expect(mig057).toMatch(/SELECT id, assignee_profile_id, status, completed_at, created_by_profile_id, title/);
  });

  it('skips notification on self-completion AND on no-creator', () => {
    // Both conditions are required: created_by NOT NULL AND created_by != caller.
    expect(mig057).toMatch(
      /v_row\.created_by_profile_id IS NOT NULL[\s\S]*?AND v_row\.created_by_profile_id IS DISTINCT FROM v_caller/,
    );
  });

  it('wraps the notification insert in BEGIN/EXCEPTION so failure cannot roll back the completion', () => {
    expect(mig057).toMatch(
      /BEGIN[\s\S]*?INSERT INTO public\.notifications[\s\S]*?EXCEPTION WHEN OTHERS THEN[\s\S]*?RAISE NOTICE/,
    );
  });

  it("inserts a 'task_completed' notification with recipient + actor + task linkage", () => {
    // Column list mentions recipient_profile_id / actor_profile_id /
    // task_instance_id; VALUES uses the 'task_completed' literal +
    // p_instance_id linkage. Match the column list first, then the
    // values literal.
    expect(mig057).toMatch(
      /INSERT INTO public\.notifications\s*\(\s*id,\s*recipient_profile_id,\s*actor_profile_id,\s*type,\s*task_instance_id[\s\S]*?VALUES[\s\S]*?'task_completed'[\s\S]*?p_instance_id/,
    );
  });
});

describe('src/lib/notificationsApi.js — read + mutation helpers', () => {
  it('exports the four header-facing helpers + the custom-event name', () => {
    expect(apiSrc).toMatch(/export async function countUnreadNotifications/);
    expect(apiSrc).toMatch(/export async function loadRecentNotifications/);
    expect(apiSrc).toMatch(/export async function markNotificationRead/);
    expect(apiSrc).toMatch(/export async function markAllNotificationsRead/);
    expect(apiSrc).toMatch(/export const NOTIFICATIONS_CHANGE_EVENT = 'wcf-notifications-change'/);
  });

  it('count helper filters by recipient_profile_id AND unread (head:true)', () => {
    expect(apiSrc).toMatch(
      /from\('notifications'\)[\s\S]*?\.select\('id', \{count: 'exact', head: true\}\)[\s\S]*?\.eq\('recipient_profile_id', recipientId\)[\s\S]*?\.is\('read_at', null\)/,
    );
  });

  it('mark-one is idempotent — filters .is(read_at, null) so re-marking is a no-op', () => {
    expect(apiSrc).toMatch(
      /update\(\{read_at: new Date\(\)\.toISOString\(\)\}\)[\s\S]*?\.eq\('id', id\)[\s\S]*?\.is\('read_at', null\)/,
    );
  });

  it('mark-one and mark-all both fire NOTIFICATIONS_CHANGE_EVENT', () => {
    const oneBlock = apiSrc.match(/export async function markNotificationRead[\s\S]*?\n\}/);
    const allBlock = apiSrc.match(/export async function markAllNotificationsRead[\s\S]*?\n\}/);
    expect(oneBlock?.[0] || '').toMatch(/fireNotificationsChangeEvent\(\)/);
    expect(allBlock?.[0] || '').toMatch(/fireNotificationsChangeEvent\(\)/);
  });

  it('does NOT call any write paths to insert notifications from the client', () => {
    expect(apiSrc).not.toMatch(/from\('notifications'\)\.insert/);
    expect(apiSrc).not.toMatch(/from\('notifications'\)\.delete/);
  });
});

describe('src/shared/Header.jsx — notifications bell + dropdown', () => {
  it('flips NOTIFICATIONS_CENTER_ENABLED to true', () => {
    expect(headerSrc).toMatch(/const NOTIFICATIONS_CENTER_ENABLED\s*=\s*true/);
  });

  it('imports the four notifications helpers + the change-event name', () => {
    expect(headerSrc).toMatch(
      /import\s*\{[^}]*countUnreadNotifications[^}]*\}\s*from\s*'\.\.\/lib\/notificationsApi\.js'/,
    );
    expect(headerSrc).toMatch(/loadRecentNotifications/);
    expect(headerSrc).toMatch(/markNotificationRead/);
    expect(headerSrc).toMatch(/markAllNotificationsRead/);
    expect(headerSrc).toMatch(/NOTIFICATIONS_CHANGE_EVENT/);
  });

  it('renders the bell only when NOTIFICATIONS_CENTER_ENABLED && authState?.user', () => {
    expect(headerSrc).toMatch(
      /\{NOTIFICATIONS_CENTER_ENABLED && authState\?\.user && \(\s*<div style=\{\{position: 'relative'\}\}>[\s\S]*?data-notifications-header-link="1"/,
    );
  });

  it('badge reads from real unread count (no fake/zero placeholder)', () => {
    expect(headerSrc).toMatch(/data-notifications-unread-badge=\{notifUnread\}/);
    expect(headerSrc).toMatch(/\{notifUnread > 0 && \(/);
  });

  it('panel has the data hooks the Playwright spec asserts on', () => {
    for (const hook of [
      'data-notifications-header-link="1"',
      'data-notifications-panel="1"',
      'data-notifications-panel-loaded=',
      'data-notifications-panel-list="1"',
      'data-notifications-mark-all-read="1"',
      'data-notifications-load-error="1"',
      'data-notifications-retry="1"',
      'data-notifications-loading="1"',
      'data-notifications-row=',
      'data-notifications-row-unread=',
      'data-notifications-empty="1"',
    ]) {
      expect(headerSrc, `missing hook ${hook}`).toContain(hook);
    }
  });

  it('distinguishes notification load failures from a genuinely empty list', () => {
    expect(headerSrc).toContain("import InlineNotice from './InlineNotice.jsx'");
    expect(headerSrc).toContain('const [notifLoading, setNotifLoading] = React.useState(false)');
    expect(headerSrc).toContain('const [notifLoadError, setNotifLoadError] = React.useState(null)');
    expect(headerSrc).toContain('const [notifReloadKey, setNotifReloadKey] = React.useState(0)');
    expect(headerSrc).toContain("data-notifications-panel-loaded={!notifLoading && !notifLoadError ? '1' : '0'}");
    expect(headerSrc).toMatch(/catch \(e\)[\s\S]*?setNotifRecent\(\[\]\)[\s\S]*?setNotifLoadError\(/);
    expect(headerSrc).toContain('<InlineNotice notice={notifLoadError} />');
    expect(headerSrc).toContain('onClick={() => setNotifReloadKey((k) => k + 1)}');
    expect(headerSrc).toMatch(/!\s*notifLoadError\s*&&\s*!\s*notifLoading\s*&&\s*notifRecent\.length === 0/);
    expect(headerSrc).toMatch(/!\s*notifLoadError\s*&&\s*notifRecent\.map/);
  });

  it('keeps mark-all disabled while notification list freshness is unknown', () => {
    expect(headerSrc).toContain('disabled={notifUnread === 0 || !!notifLoadError}');
    expect(headerSrc).toContain("color: notifUnread === 0 || notifLoadError ? '#9ca3af' : '#085041'");
    expect(headerSrc).toContain("cursor: notifUnread === 0 || notifLoadError ? 'default' : 'pointer'");
  });

  it('row click marks-read then routes via resolveNotificationRoute', () => {
    expect(headerSrc).toMatch(/if \(unread\) await markNotificationRead\(sb, n\.id\)/);
    expect(headerSrc).toContain('resolveNotificationRoute(');
    expect(headerSrc).toContain('routeToView');
  });

  it('does NOT keep the old placeholder onClick (no-op stub gone)', () => {
    expect(headerSrc).not.toMatch(/Notifications Center not yet implemented/);
    expect(headerSrc).not.toMatch(/data-notifications-placeholder="1"/);
  });
});
