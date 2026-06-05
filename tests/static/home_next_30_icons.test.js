import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const homeSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/HomeDashboard.jsx'), 'utf8');
const homeAlertsSrc = fs.readFileSync(path.join(ROOT, 'src/dashboard/homeAlerts.js'), 'utf8');

describe('HomeDashboard NEXT 30 DAYS planner icons', () => {
  const weekEventsBlock = homeAlertsSrc.match(/export function buildNext30Events[\s\S]*?return weekEvents\.sort/);

  it('builds next-30-day events with planner icon keys, not emoji icon fields', () => {
    expect(weekEventsBlock, 'expected the next-30-day event builder block').not.toBeNull();
    expect(weekEventsBlock[0]).not.toMatch(/\bicon:\s*['"]/);

    for (const type of ['brooder-in', 'schooner-in', 'processing']) {
      expect(weekEventsBlock[0]).toMatch(
        new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*ANIMAL_ICON_KEYS\\.broiler`),
      );
    }

    for (const type of ['wt-4wk', 'wt-6wk']) {
      expect(weekEventsBlock[0]).toMatch(
        new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*PLANNER_ICON_KEYS\\.weighins`),
      );
    }

    for (const type of ['farrow-open', 'farrow-close', 'farrow-due', 'pig-age']) {
      expect(weekEventsBlock[0]).toMatch(new RegExp(`type:\\s*'${type}'[\\s\\S]*?iconKey:\\s*ANIMAL_ICON_KEYS\\.pig`));
    }
  });

  it('renders the next-30-day list with PlannerIcon', () => {
    expect(homeSrc).toMatch(/const weekEvents = buildNext30Events\(/);
    expect(homeSrc).toMatch(
      /weekEvents\.map\(\(e,\s*i\)\s*=>[\s\S]*?<PlannerIcon\s+iconKey=\{e\.iconKey\}\s+size=\{18\}\s*\/>/,
    );
    expect(homeSrc).not.toMatch(/<span style=\{\{fontSize:\s*18\}\}>\{e\.icon\}<\/span>/);
  });
});

describe('HomeDashboard NEXT 30 DAYS — farrow-due labels + active-window subline', () => {
  // Locate the farrow-due region in the shared builder. Anchor on the outer
  // window gate so the captured block includes the surrounding logic
  // (window overlap, pending filter, windowActive flag) plus the push itself —
  // these moved out of HomeDashboard into homeAlerts.js's buildNext30Events.
  const farrowDueBlock = homeAlertsSrc.match(
    /if \(tl\.farrowingStart <= in30 && tl\.farrowingEnd >= todayStr\)[\s\S]*?type: 'farrow-due'[\s\S]*?\}\);/,
  );
  it('block exists', () => {
    expect(farrowDueBlock, 'farrow-due push block expected').not.toBeNull();
  });

  it('reworded label uses "sow group farrowing window <active|opens>" — no "N sows due to farrow"', () => {
    // New phrasing: group-centric, count moves to subline.
    expect(farrowDueBlock[0]).toMatch(
      /label:\s*`\$\{lbl\} sow group farrowing window \$\{windowActive \? 'active' : 'opens'\}`/,
    );
    // Negative lock: the old "N sow(s) due to farrow (lbl)" phrasing is gone
    // from the source so a future refactor cannot quietly restore the
    // "3 individual sows scheduled" misread.
    expect(homeAlertsSrc).not.toMatch(/sow\$\{pending\.length > 1 \? 's' : ''\} due to farrow/);
  });

  it('windowActive flag distinguishes active from upcoming windows', () => {
    expect(farrowDueBlock[0]).toMatch(/const windowActive = tl\.farrowingStart <= todayStr/);
  });

  it('active windows render "Window MM/DD-MM/DD" subline without pending count', () => {
    expect(farrowDueBlock[0]).toMatch(
      /subline:\s*windowActive\s*\?[\s\S]*?`Window \$\{fmt\(tl\.farrowingStart\)\}-\$\{fmt\(tl\.farrowingEnd\)\}`[\s\S]*?:\s*`Opens \$\{fmt\(tl\.farrowingStart\)\}`/,
    );
    expect(farrowDueBlock[0]).not.toMatch(/subline:[\s\S]*?pending/);
  });

  it('renderer prefers event.subline over fmt(date) when present', () => {
    // Subline-aware renderer keeps fmt(date) as the fallback so events
    // without an explicit subline render their date as before.
    expect(homeSrc).toMatch(/\{e\.subline \|\| fmt\(e\.date\)\}/);
  });

  it('still keeps active windows visible while pending > 0', () => {
    // The outer gate has not changed: window overlap + pending > 0.
    expect(farrowDueBlock[0]).toMatch(/tl\.farrowingStart <= in30 && tl\.farrowingEnd >= todayStr/);
    expect(farrowDueBlock[0]).toMatch(/if \(pending\.length > 0\)/);
  });
});
