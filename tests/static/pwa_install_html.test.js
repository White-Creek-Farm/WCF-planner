import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// PWA install — static HTML + Netlify _redirects lock (2026-05-06 hotfix)
// ============================================================================
// Real-device testing showed that swapping link[rel="manifest"] href in JS
// after React mounts is too late for iOS Safari / Android Chrome to read
// the right start_url when the user taps Add to Home Screen. Browsers
// snapshot the manifest at HTML parse time, before our applyManifestHref()
// helper runs.
//
// Fix: serve a separate equipment.html with the equipment manifest baked
// into the <link> tag, and have Netlify route /equipment* + /fueling* to
// that HTML before the SPA fallback. Both HTMLs boot the same React app
// from /src/main.jsx — only the install manifest differs. The dynamic
// applyManifestHref() helper stays as defensive runtime sync but is no
// longer the install path.
//
// This static test locks: (a) each HTML's manifest <link>, (b) the
// _redirects rule order, and (c) the multi-page Vite build inputs. A
// deploy spec asserts the deployed build serves /equipment.html with the
// equipment manifest at HTML level.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const equipmentHtml = fs.readFileSync(path.join(ROOT, 'equipment.html'), 'utf8');
const redirects = fs.readFileSync(path.join(ROOT, 'public/_redirects'), 'utf8');
const viteConfig = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');

function manifestHref(html) {
  const m = html.match(/<link\s+rel="manifest"\s+href="([^"]+)"\s*\/?>/);
  return m ? m[1] : null;
}

describe('Manifest <link> in HTML entries', () => {
  it('index.html links to /manifest.webmanifest', () => {
    expect(manifestHref(indexHtml)).toBe('/manifest.webmanifest');
  });

  it('equipment.html links to /manifest-equipment.webmanifest', () => {
    expect(manifestHref(equipmentHtml)).toBe('/manifest-equipment.webmanifest');
  });

  it('both HTMLs boot the same React app from /src/main.jsx', () => {
    expect(indexHtml).toMatch(/<script\s+type="module"\s+src="\/src\/main\.jsx">/);
    expect(equipmentHtml).toMatch(/<script\s+type="module"\s+src="\/src\/main\.jsx">/);
  });

  it('both HTMLs include the boot-loader so anti-flash UX matches', () => {
    expect(indexHtml).toMatch(/id="wcf-boot-loader"/);
    expect(equipmentHtml).toMatch(/id="wcf-boot-loader"/);
  });
});

describe('Netlify public/_redirects rule order', () => {
  // Netlify processes _redirects top-to-bottom and the first match wins.
  // The equipment-install routes MUST come before the /* SPA fallback,
  // otherwise /equipment* would resolve to /index.html with the wrong
  // manifest at HTML parse time.
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
    // Equipment lines must appear before the catch-all.
    const lines = redirects.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    const catchAllIdx = lines.findIndex((l) => /^\/\*\s+\/index\.html/.test(l));
    expect(catchAllIdx, 'expected /* /index.html catch-all line').toBeGreaterThan(-1);
    expect(catchAllIdx).toBe(lines.length - 1); // it's last among non-comment lines
    const equipmentLineIdxs = lines.map((l, i) => (/equipment\.html/.test(l) ? i : -1)).filter((i) => i !== -1);
    expect(equipmentLineIdxs.length).toBe(4);
    for (const i of equipmentLineIdxs) {
      expect(i).toBeLessThan(catchAllIdx);
    }
  });
});

describe('vite.config.js multi-page build inputs', () => {
  it('declares both index.html and equipment.html as rollup inputs', () => {
    expect(viteConfig).toMatch(/main:\s*resolve\(__dirname,\s*'index\.html'\)/);
    expect(viteConfig).toMatch(/equipment:\s*resolve\(__dirname,\s*'equipment\.html'\)/);
  });

  it('imports resolve from node:path so the inputs use absolute paths', () => {
    expect(viteConfig).toMatch(/import\s*\{[^}]*\bresolve\b[^}]*\}\s*from\s*'node:path'/);
  });
});
