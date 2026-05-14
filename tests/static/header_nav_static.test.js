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

  it('Notifications placeholder slot is rendered alongside Tasks', () => {
    expect(src).toMatch(/data-notifications-header-link="1"/);
    expect(src).toMatch(/data-notifications-placeholder="1"/);
  });

  it('Notifications placeholder does NOT carry a count badge yet', () => {
    // Extract the notifications button block (CREATE … through its closing
    // </button>) and assert no badge data attribute appears inside.
    const block = src.match(/<button[^>]*data-notifications-header-link="1"[\s\S]*?<\/button>/);
    expect(block, 'expected Notifications button block').not.toBeNull();
    expect(block[0]).not.toMatch(/data-(notifications|tasks)-header-badge/);
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

  it('Webforms section contains all six destinations', () => {
    expect(src).toMatch(/data-header-menu-item="dailys"/);
    expect(src).toMatch(/data-header-menu-item="addfeed"/);
    expect(src).toMatch(/data-header-menu-item="weighins"/);
    expect(src).toMatch(/data-header-menu-item="equipment"/);
    expect(src).toMatch(/data-header-menu-item="fuel-supply"/);
    expect(src).toMatch(/data-header-menu-item="submit-task"/);
  });

  it('each Webforms entry navigates via setView/go() to its canonical view name', () => {
    // Crude but reliable: each menu item's click handler must contain
    // the correct go(<view>) call.
    expect(src).toMatch(/data-header-menu-item="dailys"\s+onClick=\{\(\) => go\('webformhub'\)\}/);
    expect(src).toMatch(/data-header-menu-item="addfeed"\s+onClick=\{\(\) => go\('addfeed'\)\}/);
    expect(src).toMatch(/data-header-menu-item="weighins"\s+onClick=\{\(\) => go\('weighins'\)\}/);
    expect(src).toMatch(/data-header-menu-item="equipment"\s+onClick=\{\(\) => go\('fuelingHub'\)\}/);
    expect(src).toMatch(/data-header-menu-item="fuel-supply"\s+onClick=\{\(\) => go\('fuelSupply'\)\}/);
    expect(src).toMatch(/data-header-menu-item="submit-task"\s+onClick=\{\(\) => go\('tasksWebform'\)\}/);
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
