import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

// ============================================================================
// Production security headers (2026-06-22 audit, P2 lane)
// ============================================================================
// Locks the netlify.toml [[headers]] block so the production security headers
// can't silently regress. CSP ships REPORT-ONLY first (reports, never blocks)
// so we can discover any missed origin before enforcing.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');

// Pull the value of a single header key from the toml (line: `Key = "value"`).
function headerValue(key) {
  const re = new RegExp(`^\\s*${key.replace(/[-]/g, '\\-')}\\s*=\\s*"([^"]*)"`, 'm');
  const m = toml.match(re);
  return m ? m[1] : null;
}
const csp = headerValue('Content-Security-Policy-Report-Only') || '';

describe('netlify.toml — [[headers]] block for /*', () => {
  it('declares a [[headers]] block scoped to /*', () => {
    expect(toml).toMatch(/\[\[headers\]\]/);
    expect(toml).toMatch(/for\s*=\s*"\/\*"/);
  });

  it('exposes the required header values table', () => {
    expect(toml).toMatch(/\[headers\.values\]/);
  });
});

describe('all required security headers are present', () => {
  for (const key of [
    'Content-Security-Policy-Report-Only',
    'Strict-Transport-Security',
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
  ]) {
    it(`has ${key}`, () => {
      expect(headerValue(key)).toBeTruthy();
    });
  }

  it('X-Frame-Options denies framing and X-Content-Type-Options is nosniff', () => {
    expect(headerValue('X-Frame-Options')).toBe('DENY');
    expect(headerValue('X-Content-Type-Options')).toBe('nosniff');
  });

  it('Referrer-Policy is a privacy-preserving value', () => {
    expect(headerValue('Referrer-Policy')).toMatch(/strict-origin-when-cross-origin|no-referrer/);
  });
});

describe('CSP is Report-Only, not enforced (first rollout)', () => {
  it('uses Content-Security-Policy-Report-Only', () => {
    expect(csp.length).toBeGreaterThan(0);
  });

  it('does NOT ship an enforced Content-Security-Policy header', () => {
    // The Report-Only line contains the substring "Content-Security-Policy";
    // the negative lookahead ensures we only fail on a bare enforced header.
    expect(toml).not.toMatch(/Content-Security-Policy(?!-Report-Only)\s*=/);
  });

  it('locks the safe baseline directives', () => {
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/form-action 'self'/);
    expect(csp).toMatch(/upgrade-insecure-requests/);
  });
});

describe('CSP allows the origins the app actually uses', () => {
  it('Supabase REST over https and realtime over wss', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/pzfujbjtayhkdlxiblwe\.supabase\.co/);
    expect(csp).toMatch(/connect-src[^;]*wss:\/\/pzfujbjtayhkdlxiblwe\.supabase\.co/);
  });

  it('ESRI World Imagery tiles (Pasture Map)', () => {
    expect(csp).toMatch(/img-src[^;]*https:\/\/server\.arcgisonline\.com/);
  });

  it('YouTube thumbnails (img only)', () => {
    expect(csp).toMatch(/img-src[^;]*https:\/\/img\.youtube\.com/);
  });

  it('NWS weather radar', () => {
    expect(csp).toMatch(/connect-src[^;]*https:\/\/radar\.weather\.gov/);
  });

  it('blob: workers (pdfjs / xlsx / Leaflet)', () => {
    expect(csp).toMatch(/worker-src 'self' blob:/);
  });

  it('data: and blob: images', () => {
    expect(csp).toMatch(/img-src 'self' data: blob:/);
  });

  it('self-hosted fonts only', () => {
    expect(csp).toMatch(/font-src 'self'/);
  });

  it('inline styles permitted (JSX inline styles + Leaflet runtime)', () => {
    expect(csp).toMatch(/style-src 'self' 'unsafe-inline'/);
  });
});

describe('CSP does NOT trust stale CDNs as script sources', () => {
  it('script-src is self-only — no unpkg / jsdelivr', () => {
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).not.toMatch(/unpkg/);
    expect(csp).not.toMatch(/jsdelivr/);
  });
});

describe('HSTS is cautious (present, no preload yet)', () => {
  const hsts = headerValue('Strict-Transport-Security') || '';
  it('sets a max-age', () => {
    expect(hsts).toMatch(/max-age=\d+/);
  });
  it('does NOT include preload on first rollout', () => {
    expect(hsts).not.toMatch(/preload/);
  });
});

describe('Permissions-Policy keeps field hardware available to self', () => {
  const pp = headerValue('Permissions-Policy') || '';
  it('allows camera and geolocation for self (field use)', () => {
    expect(pp).toMatch(/camera=\(self\)/);
    expect(pp).toMatch(/geolocation=\(self\)/);
  });
  it('blocks hardware/APIs the app does not use', () => {
    expect(pp).toMatch(/microphone=\(\)/);
    expect(pp).toMatch(/payment=\(\)/);
    expect(pp).toMatch(/usb=\(\)/);
  });
});
