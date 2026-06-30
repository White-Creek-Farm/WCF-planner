import {describe, it, expect} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

// ============================================================================
// Newsletter shared-module parity lock (CP-B).
// ----------------------------------------------------------------------------
// The fact detectors and draft composer each exist in two copies:
//   - src/lib/newsletterFacts.js  / supabase/functions/_shared/newsletterFacts.js
//   - src/lib/newsletterDraft.js  / supabase/functions/_shared/newsletterDraft.js
// The vitest source-of-truth lives under src/lib; the newsletter-harvest Edge
// Function imports the _shared copy via Deno's relative ESM resolution (the
// Supabase CLI bundler can't reach across the project root). They MUST be
// byte-identical, pure ESM with zero imports, and free of Node-only APIs.
// ============================================================================

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PAIRS = [
  ['src/lib/newsletterFacts.js', 'supabase/functions/_shared/newsletterFacts.js'],
  ['src/lib/newsletterDraft.js', 'supabase/functions/_shared/newsletterDraft.js'],
  ['src/lib/newsletterHarvestShape.js', 'supabase/functions/_shared/newsletterHarvestShape.js'],
  ['src/lib/newsletterCronAuth.js', 'supabase/functions/_shared/newsletterCronAuth.js'],
  ['src/lib/newsletterProductionYoy.js', 'supabase/functions/_shared/newsletterProductionYoy.js'],
];

function readNormalized(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

describe('newsletter shared-module parity', () => {
  for (const [src, shared] of PAIRS) {
    it(`${src} and ${shared} are byte-identical (CRLF normalized)`, () => {
      expect(readNormalized(shared)).toBe(readNormalized(src));
    });
  }

  it('both shared copies are pure ESM with zero import statements', () => {
    for (const [, shared] of PAIRS) {
      const lines = readNormalized(shared)
        .split('\n')
        .filter((l) => /^\s*import\s/.test(l));
      expect(lines, `${shared} has unexpected import statements`).toEqual([]);
    }
  });

  it('neither shared copy references Node-only APIs', () => {
    const banned = ['require(', 'process.', 'Buffer.', '__dirname', '__filename', 'fs.', 'path.', 'url.', 'Deno.'];
    for (const [, shared] of PAIRS) {
      const text = readNormalized(shared);
      for (const tok of banned) {
        expect(text.includes(tok), `${shared} must not reference ${tok}`).toBe(false);
      }
    }
  });
});
