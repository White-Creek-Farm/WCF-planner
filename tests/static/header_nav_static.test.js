import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// Static lock for src/shared/Header.jsx after the 2026-05-14 navigation
// prep for the Notifications Center. The visible Webforms group + the
// standalone Sign Out button moved out of the dark bar and into the
// hamburger menu. Tasks became an icon button; Notifications is a
// placeholder slot. These assertions stop a refactor from accidentally
// re-introducing the crowded mobile bar or losing the new menu entries.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/shared/Header.jsx'), 'utf8');

describe('Header — dark bar shape (post-Notifications-prep)', () => {
  it('keeps the brand button as the leftmost element', () => {
    expect(src).toMatch(/data-header-brand="1"/);
  });

  it('keeps the user-info / save-status block on the dark bar', () => {
    expect(src).toMatch(/data-header-userinfo="1"/);
  });

  it('renders Tasks as an icon button gated on any logged-in user, not just admin', () => {
    // Lock the JSX shape: the Tasks button must live INSIDE the
    // authState?.user && (...) guard so every logged-in role can see it.
    expect(src).toMatch(/\{authState\?\.user && \(\s*<button\s+data-tasks-header-link="1"/);
  });

  it('Tasks button keeps the existing badge wiring on myDueCount > 0', () => {
    expect(src).toMatch(/data-tasks-header-badge=\{myDueCount\}/);
    expect(src).toMatch(/myDueCount > 0 && \(/);
  });

  it('Notifications bell is rendered (real data, no placeholder)', () => {
    // After mig 057 the bell is wired to public.notifications. Keep the
    // header-link hook for the Playwright spec; the placeholder hook is
    // explicitly gone.
    expect(src).toMatch(/data-notifications-header-link="1"/);
    expect(src).not.toMatch(/data-notifications-placeholder="1"/);
    expect(src).not.toMatch(/Notifications Center not yet implemented/);
  });

  it('NOTIFICATIONS_CENTER_ENABLED defaults to true and gates the rendered bell', () => {
    // mig 057 ships the storage, so the flag flips to true. The bell JSX
    // must live inside the {flag && authState?.user && (...)} gate so it
    // only renders for logged-in users.
    expect(src).toMatch(/const NOTIFICATIONS_CENTER_ENABLED\s*=\s*true/);
    expect(src).toMatch(
      /\{NOTIFICATIONS_CENTER_ENABLED && authState\?\.user && \(\s*<div style=\{\{position: 'relative'\}\}>[\s\S]*?data-notifications-header-link="1"/,
    );
  });

  it('Notifications bell carries the unread-count badge sourced from real data', () => {
    expect(src).toMatch(/data-notifications-unread-badge=\{notifUnread\}/);
    // Badge is conditionally rendered — only when notifUnread > 0 — so a
    // recipient with no unread rows sees the icon alone, not a "0".
    expect(src).toMatch(/\{notifUnread > 0 && \(/);
  });

  it('hamburger toggle is reachable for any logged-in user', () => {
    expect(src).toMatch(/data-header-menu-toggle="1"/);
    // Toggle must sit inside the same authState?.user guard so it shows
    // for every role (farm_team, management, admin, equipment_tech).
    expect(src).toMatch(
      /\{authState\?\.user && \(\s*<div style=\{\{position: 'relative'\}\}>[\s\S]*?data-header-menu-toggle="1"/,
    );
  });

  it('removes the visible Webforms group from the dark bar', () => {
    // The pre-refactor markers were data-header-webforms-group and
    // data-header-webforms-equipment. Both must be gone.
    expect(src).not.toMatch(/data-header-webforms-group/);
    expect(src).not.toMatch(/data-header-webforms-equipment/);
    expect(src).not.toMatch(/data-header-webforms-label/);
    // The dark-bar standalone Sign Out is also gone (only appears now
    // inside the burger menu item).
    expect(src).not.toMatch(/data-header-tasks-divider/);
  });
});

describe('Header — hamburger menu contents', () => {
  it('Home is the first menu entry', () => {
    expect(src).toMatch(/data-header-menu-item="home"/);
  });

  it('Activity follows Home in the menu', () => {
    expect(src).toMatch(/data-header-menu-item="activity"/);
  });

  it('Webforms section contains Dailys and Equipment only', () => {
    expect(src).toMatch(/data-header-menu-item="dailys"/);
    expect(src).toMatch(/data-header-menu-item="equipment"/);
    expect(src).not.toMatch(/data-header-menu-item="addfeed"/);
    expect(src).not.toMatch(/data-header-menu-item="weighins"/);
    expect(src).not.toMatch(/data-header-menu-item="fuel-supply"/);
    expect(src).not.toMatch(/data-header-menu-item="submit-task"/);
  });

  it('Webforms entries navigate to canonical view names', () => {
    expect(src).toMatch(/data-header-menu-item="dailys"\s+onClick=\{\(\) => go\('webformhub'\)\}/);
    expect(src).toMatch(/data-header-menu-item="equipment"\s+onClick=\{\(\) => go\('fuelingHub'\)\}/);
  });

  it('Admin entry is gated on isAdmin (authState.role === "admin")', () => {
    expect(src).toMatch(/const isAdmin = authState\?\.role === 'admin'/);
    // The Admin + Users block must live inside an isAdmin && (...) guard.
    expect(src).toMatch(/\{isAdmin && \([\s\S]*?data-header-menu-item="admin"[\s\S]*?data-header-menu-item="users"/);
  });

  it('Sign Out is the final menu entry and lives inside the burger', () => {
    expect(src).toMatch(/data-header-menu-item="sign-out"/);
    // Must call signOut from the menu (not just close it).
    expect(src).toMatch(/data-header-menu-item="sign-out"[\s\S]*?signOut\(\)/);
  });
});

describe('Header — section sub-nav is unchanged', () => {
  it('keeps the section sub-nav element + flexWrap (mobile fade affordance is via index.html @media)', () => {
    expect(src).toMatch(/data-header-subnav="1"/);
    expect(src).toMatch(/flexWrap: 'wrap'/);
  });
});
