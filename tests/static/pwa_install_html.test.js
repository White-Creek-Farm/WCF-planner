import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// PWA install — static HTML + Netlify _redirects lock
// ============================================================================
// Real-device testing showed that swapping link[rel="manifest"] href in JS
// after React mounts is too late for iOS Safari / Android Chrome to read
// the right start_url when the user taps Add to Home Screen. Browsers
// snapshot the manifest at HTML parse time, before our applyManifestHref()
// helper runs.
//
// Fix: serve dedicated per-hub HTMLs (dailys.html, equipment.html) with
// the hub-specific manifest baked into the <link> tag, and have Netlify
// route /dailys*, /equipment*, and the legacy /fueling* to those HTMLs
// before the SPA fallback. The root index.html links the root manifest
// with start_url "/" so installing from wcfplanner.com opens the app
// root, not the public daily-reports hub. All HTMLs boot the same React
// app from /src/main.jsx — only the install manifest differs. The
// dynamic applyManifestHref() helper stays as defensive runtime sync
// but is no longer the install path.
//
// This static test locks: (a) each HTML's manifest <link>, (b) the
// _redirects rule order, and (c) the multi-page Vite build inputs. A
// deploy spec asserts the deployed build serves each HTML with the
// correct manifest at HTML level.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const dailysHtml = fs.readFileSync(path.join(ROOT, 'dailys.html'), 'utf8');
const equipmentHtml = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
const redirects = fs.readFileSync(path.join(ROOT, 'public/_redirects'), 'utf8');
const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
const rootManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.webmanifest'), 'utf8'));
const dailysManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest-dailys.webmanifest'), 'utf8'));
const equipmentManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest-equipment.webmanifest'), 'utf8'));

function manifestHref(html) {
  const m = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"\s*\/?>/);
  return m ? m[1] : null;
}

describe('Manifest start_url values', () => {
  it('root manifest start_url is "/" so installing from wcfplanner.com opens the app root', () => {
    expect(rootManifest.start_url).toBe('/');
    expect(rootManifest.scope).toBe('/');
  });

  it('dailys manifest start_url is "/dailys"', () => {
    expect(dailysManifest.start_url).toBe('/dailys');
    expect(dailysManifest.scope).toBe('/');
  });

  it('equipment manifest start_url is "/equipment"', () => {
    expect(equipmentManifest.start_url).toBe('/equipment');
    expect(equipmentManifest.scope).toBe('/');
  });
});

describe('Manifest <link> in HTML entries', () => {
  it('index.html links to /manifest.webmanifest', () => {
    expect(manifestHref(indexHtml)).toBe('/manifest.webmanifest');
  });

  it('dailys.html links to /manifest-dailys.webmanifest', () => {
    expect(manifestHref(dailysHtml)).toBe('/manifest-dailys.webmanifest');
  });

  it('equipment.html links to /manifest-equipment.webmanifest', () => {
    expect(manifestHref(equipmentHtml)).toBe('/manifest-equipment.webmanifest');
  });

  it('all three HTMLs boot the same React app from /src/main.jsx', () => {
    expect(indexHtml).toMatch(/<script\s+type="module"\s+src="\/src\/main\.jsx">/);
    expect(dailysHtml).toMatch(/<script\s+type="module"\s+src="\/src\/main\.jsx">/);
    expect(equipmentHtml).toMatch(/<script\s+type="module"\s+src="\/src\/main\.jsx">/);
  });

  it('all three HTMLs include the boot-loader so anti-flash UX matches', () => {
    expect(indexHtml).toMatch(/id="wcf-boot-loader"/);
    expect(dailysHtml).toMatch(/id="wcf-boot-loader"/);
    expect(equipmentHtml).toMatch(/id="wcf-boot-loader"/);
  });
});

describe('Netlify public/_redirects rule order', () => {
  // Netlify processes _redirects top-to-bottom and the first match wins.
  // The hub-install routes MUST come before the /* SPA fallback,
  // otherwise /dailys* or /equipment* would resolve to /index.html with
  // the wrong manifest at HTML parse time.
  it('routes /dailys to /dailys.html', () => {
    expect(redirects).toMatch(/^\/dailys\s+\/dailys\.html\s+200\s*$/m);
  });

  it('routes /dailys/* to /dailys.html', () => {
    expect(redirects).toMatch(/^\/dailys\/\*\s+\/dailys\.html\s+200\s*$/m);
  });

  it('routes legacy /webforms to /dailys.html (alias hub)', () => {
    expect(redirects).toMatch(/^\/webforms\s+\/dailys\.html\s+200\s*$/m);
  });

  it('routes legacy /webforms/* to /dailys.html (alias hub)', () => {
    expect(redirects).toMatch(/^\/webforms\/\*\s+\/dailys\.html\s+200\s*$/m);
  });

  it('routes /equipment to /equipment.html', () => {
    expect(redirects).toMatch(/^\/equipment\s+\/equipment\.html\s+200\s*$/m);
  });

  it('routes /equipment/* to /equipment.html', () => {
    expect(redirects).toMatch(/^\/equipment\/\*\s+\/equipment\.html\s+200\s*$/m);
  });

  it('routes legacy /fueling to /equipment.html (alias hub)', () => {
    expect(redirects).toMatch(/^\/fueling\s+\/equipment\.html\s+200\s*$/m);
  });

  it('routes legacy /fueling/* to /equipment.html (alias hub)', () => {
    expect(redirects).toMatch(/^\/fueling\/\*\s+\/equipment\.html\s+200\s*$/m);
  });

  it('the /* catch-all to /index.html is the last redirect rule', () => {
    expect(redirects).toMatch(/\/\*\s+\/index\.html\s+200\s*$/);
    // All hub lines must appear before the catch-all.
    const lines = redirects.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const catchAllIdx = lines.findIndex((l) => /^\/\*\s+\/index\.html/.test(l));
    expect(catchAllIdx, 'expected /* /index.html catch-all line').toBeGreaterThan(-1);
    expect(catchAllIdx).toBe(lines.length - 1); // it's last among non-comment lines
    const dailysLineIdxs = lines.map((l, i) => (/dailys\.html/.test(l) ? i : -1)).filter((i) => i !== -1);
    expect(dailysLineIdxs.length).toBe(4); // /dailys, /dailys/*, /webforms, /webforms/*
    for (const i of dailysLineIdxs) {
      expect(i).toBeLessThan(catchAllIdx);
    }
    const equipmentLineIdxs = lines.map((l, i) => (/equipment\.html/.test(l) ? i : -1)).filter((i) => i !== -1);
    expect(equipmentLineIdxs.length).toBe(4);
    for (const i of equipmentLineIdxs) {
      expect(i).toBeLessThan(catchAllIdx);
    }
  });
});

describe('vite.config.js multi-page build inputs', () => {
  it('declares index.html, dailys.html, and equipment.html as rollup inputs', () => {
    expect(viteConfig).toMatch(/main:\s*resolve\(__dirname,\s*'index\.html'\)/);
    expect(viteConfig).toMatch(/dailys:\s*resolve\(__dirname,\s*'dailys\.html'\)/);
    expect(viteConfig).toMatch(/equipment:\s*resolve\(__dirname,\s*'equipment\.html'\)/);
  });

  it('imports resolve from node:path so the inputs use absolute paths', () => {
    expect(viteConfig).toMatch(/import\s*\{[^}]*\bresolve\b[^}]*\}\s*from\s*'node:path'/);
  });
});
