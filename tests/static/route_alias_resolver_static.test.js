import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const routesSrc = fs.readFileSync(path.join(ROOT, 'src/lib/routes.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8');

describe('route alias resolver cleanup', () => {
  it('routes.js owns the exact-then-prefix alias resolver', () => {
    expect(routesSrc).toContain('export function resolvePathAlias(pathname)');
    expect(routesSrc).toMatch(/const exactAlias = ALIASES_EXACT\[pathname\]/);
    expect(routesSrc).toMatch(/for \(const \[oldPrefix, newPrefix\] of ALIASES_PREFIX\)/);
  });

  it('main.jsx calls resolvePathAlias instead of duplicating alias matching', () => {
    expect(mainSrc).toContain('import {VIEW_TO_PATH, PATH_TO_VIEW, HASH_COMPAT, resolvePathAlias}');
    expect(mainSrc).toContain('const pathAlias = resolvePathAlias(location.pathname);');
    expect(mainSrc).toContain('navigate(pathAlias + location.search + location.hash, {replace: true});');
    expect(mainSrc).not.toContain('ALIASES_EXACT[location.pathname]');
    expect(mainSrc).not.toContain('for (const [oldPrefix, newPrefix] of ALIASES_PREFIX)');
  });

  it('routes.js is the only runtime source file that owns alias maps', () => {
    const srcRoot = path.join(ROOT, 'src');
    const offenders = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.isFile() || !/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
        const rel = path.relative(srcRoot, p).replace(/\\/g, '/');
        if (rel === 'lib/routes.js') continue;
        if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
        const src = fs
          .readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|\s)\/\/[^\n]*/g, '$1');
        if (/\bALIASES_EXACT\b|\bALIASES_PREFIX\b/.test(src)) offenders.push(rel);
      }
    }
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
