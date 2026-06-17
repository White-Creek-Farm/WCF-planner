// CP1 cleanup — "after" screenshot capture (scratch; not part of the suite's
// intent, safe to delete after review). Mirrors the routes Codex captured in
// .tmp-screens/sitewide-audit/ so before/after pairs line up by slug.
//
//   before: .tmp-screens/sitewide-audit/<vp>-<slug>.png   (pre-cleanup, main)
//   after:  .tmp-screens/cp1-after/<vp>-<slug>.png         (this branch)
//
// Limit with CP1_SHOTS="home,production,cattle-herds" (comma-separated slugs).
import {test} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const AUDIT = path.resolve('.tmp-screens/sitewide-audit/metrics.json');
const OUT = path.resolve('.tmp-screens/cp1-after');
fs.mkdirSync(OUT, {recursive: true});

const metrics = JSON.parse(fs.readFileSync(AUDIT, 'utf8'));
// unique slug -> route from the desktop entries (each slug appears per vp)
const routeBySlug = new Map();
for (const m of metrics) {
  if (m.vp === 'desktop' && m.slug && m.route && !routeBySlug.has(m.slug)) {
    routeBySlug.set(m.slug, m.route);
  }
}
const only = (process.env.CP1_SHOTS || '').split(',').map((s) => s.trim()).filter(Boolean);
let slugs = [...routeBySlug.keys()];
if (only.length) slugs = slugs.filter((s) => only.includes(s));

const VIEWPORTS = {desktop: {width: 1280, height: 900}, mobile: {width: 390, height: 844}};

test.describe.configure({mode: 'serial'});

for (const slug of slugs) {
  const route = routeBySlug.get(slug);
  test(`shot ${slug}`, async ({page}) => {
    for (const [vp, size] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(size);
      await page.goto(route, {waitUntil: 'networkidle'}).catch(() => {});
      await page.waitForTimeout(1200);
      await page
        .screenshot({path: path.join(OUT, `${vp}-${slug}.png`), fullPage: true})
        .catch((e) => console.warn(`shot failed ${vp}-${slug}: ${e.message}`));
    }
  });
}
