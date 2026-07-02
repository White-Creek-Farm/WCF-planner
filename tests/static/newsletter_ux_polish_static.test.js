import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

// Guards for the Newsletter UX polish lane:
//   1. "Your direction" autosaves with a debounce and a background issue refresh
//      never clobbers unsaved direction text (the reported data-loss defect).
//   2. The admin editor makes the AI/fact sequence obvious (AI status chip +
//      plain-language run labels) without exposing the server key.
//   3. The public reader is branded to the WCF email family via a named local
//      token set, and the public surface stays decoupled from auth + raw HTML.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const ADMIN_VIEW = 'src/newsletter/NewsletterAdminView.jsx';
const PUBLIC_CSS = 'src/newsletter/newsletter.css';

describe('direction autosave + data-loss protection', () => {
  const view = read(ADMIN_VIEW);

  it('debounces the direction save (700–1000ms band) as the admin types', () => {
    expect(view).toContain('DIRECTION_DEBOUNCE_MS');
    expect(view).toMatch(/setTimeout\(flushDirection, DIRECTION_DEBOUNCE_MS\)/);
    // The debounce constant itself is enforced in newsletterDirection.test.js.
  });

  it('routes the Steer textareas through the debounced handler, not a raw setIntake', () => {
    expect(view).toMatch(/onChange=\{\(e\) => onDirectionChange\(q\.key, e\.target\.value\)\}/);
    // The old clobbering inline handler must be gone.
    expect(view).not.toMatch(/setIntake\(\(m\)\s*=>/);
  });

  it('never adopts server intake while there are unsaved local edits', () => {
    // applyIssue only overwrites the textareas when the local draft is clean.
    expect(view).toMatch(/if \(!directionDirtyRef\.current\)/);
  });

  it('force-flushes pending direction before the AI writes, gather, and publish', () => {
    expect(view).toMatch(/await flushDirection\(\{required: true\}\);[^\n]*\n\s*await regenerateNewsletterDraft/);
    expect(view).toMatch(/await flushDirection\(\{required: true\}\);[^\n]*\n\s*await gatherNewsletterFacts/);
    expect(view).toMatch(
      /await flushDirection\(\{required: true\}\);[^\n]*\n\s*applyIssue\(await publishNewsletterIssue/,
    );
  });

  it('ABORTS a forced action when the required direction save fails (no run against stale direction)', () => {
    // The required path throws so the caller's withBusy catch stops the action;
    // the background/debounced path stays friendly (preserve local text, no throw).
    expect(view).toMatch(/flushDirection = useCallback\(\s*async \(\{required = false\} = \{\}\)/);
    expect(view).toMatch(/if \(required\)\s*\{[\s\S]{0,120}throw new Error\(/);
  });

  it('keeps local text and surfaces an error state when a save fails', () => {
    expect(view).toContain("setDirectionSave('error')");
    expect(view).toMatch(/directionDirtyRef\.current = true/);
  });

  it('shows a calm save-state indicator near the direction section', () => {
    expect(view).toContain('DirectionSaveState');
    expect(view).toContain('nla-save-state');
  });
});

describe('AI / fact workflow clarity (admin editor)', () => {
  const view = read(ADMIN_VIEW);

  it('probes AI availability in the editor (boolean-only) and shows a status chip', () => {
    // Two probe sites now: the editor and Settings.
    expect((view.match(/probeNewsletterAi\(sb\)/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(view).toContain('AiStatusChip');
    expect(view).toMatch(/AI ready|Template draft|AI status unknown/);
  });

  it('labels recent runs in plain language (facts vs draft vs provider)', () => {
    expect(view).toContain('describeNewsletterRun');
  });

  it('never leaks the AI key — only a boolean/label reaches the UI', () => {
    expect(stripComments(view)).not.toMatch(/NEWSLETTER_AI_API_KEY|SERVICE_ROLE/);
  });
});

describe('public reader branding (WCF email family)', () => {
  const css = read(PUBLIC_CSS);

  it('defines a named local token set on .nl-public', () => {
    expect(css).toContain('.nl-public');
    expect(css).toContain('--nlc-green: #566542');
    expect(css).toMatch(/--nlc-serif:/);
  });

  it('uses the WCF branded-email palette (green / warm page / warm fill / border / ink)', () => {
    for (const hex of ['#566542', '#f5f5f0', '#f8f6f0', '#e8e4dc', '#232323']) {
      expect(css, `newsletter.css should use ${hex}`).toContain(hex);
    }
  });

  it('paints the page + article on the warm/branded surface, not plain black/white', () => {
    expect(css).toMatch(/background:\s*var\(--nlc-page\)/);
    expect(css).toMatch(/\.nl-issue\s*\{[\s\S]*?background:\s*var\(--nlc-surface\)/);
  });
});

describe('public surface stays decoupled (re-assert for this lane)', () => {
  const files = [
    'src/newsletter/NewsletterPublicApp.jsx',
    'src/newsletter/NewsletterIssuePage.jsx',
    'src/newsletter/NewsletterArchive.jsx',
    'src/newsletter/NewsletterBlocks.jsx',
  ];

  it('no public newsletter component imports auth or renders raw HTML', () => {
    for (const rel of files) {
      const code = stripComments(read(rel));
      expect(/useAuth\s*\(|AuthContext/.test(code), `${rel} must not use auth`).toBe(false);
      expect(/dangerouslySetInnerHTML/.test(code), `${rel} must not render raw HTML`).toBe(false);
    }
  });
});
