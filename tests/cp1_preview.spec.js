// CP1 primitives showcase capture (scratch). Screenshots /cp1-preview.html
// (the isolated showcase) at desktop + mobile into .tmp-screens/cp1-after/.
import {test} from '@playwright/test';
import path from 'node:path';

const OUT = path.resolve('.tmp-screens/cp1-after');
const VIEWPORTS = {desktop: {width: 1280, height: 900}, mobile: {width: 390, height: 844}};

test('shot cp1-preview', async ({page}) => {
  for (const [vp, size] of Object.entries(VIEWPORTS)) {
    await page.setViewportSize(size);
    await page.goto('/cp1-preview.html', {waitUntil: 'networkidle'}).catch(() => {});
    await page.waitForTimeout(1000);
    await page.screenshot({path: path.join(OUT, `${vp}-zz-primitives-preview.png`), fullPage: true});
  }
});
