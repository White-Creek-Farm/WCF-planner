import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ============================================================================
// <Header/> must keep ONE component identity across App re-renders.
//
// React reconciles by component-function identity: when App defined
// `const Header = () => ...` inline, every App state change produced a new
// function, so React unmounted and remounted HeaderBase at every background
// render — silently discarding Header-local overlay state (an open
// notifications panel or burger menu vanished mid-interaction; CI saw the
// notifications panel close between the bell click and the panel assertion).
// The stable wrapper is created exactly once per App instance and reads the
// current App props from a ref, so background renders re-render HeaderBase
// in place instead of remounting it.
// ============================================================================

describe('App-bound Header component identity', () => {
  const main = read('src/main.jsx');

  it('creates the header wrapper component exactly once per App instance', () => {
    expect(main).toMatch(/const stableHeaderRef = React\.useRef\(null\)/);
    expect(main).toMatch(/if \(!stableHeaderRef\.current\) \{/);
    expect(main).toMatch(/stableHeaderRef\.current = function AppBoundHeader\(\)/);
    expect(main).toMatch(/React\.createElement\(HeaderBase, ref\.current\)/);
  });

  it('threads current App props through the ref, not a per-render closure', () => {
    expect(main).toMatch(
      /headerPropsRef\.current = \{\s*sb,\s*signOut,\s*loadUsers,\s*DeleteConfirmModal,\s*ConfirmActionModal,\s*\}/,
    );
    // The per-render arrow-function Header must not come back.
    expect(main).not.toMatch(/const Header = \(\) =>\s*React\.createElement\(HeaderBase/);
  });
});
