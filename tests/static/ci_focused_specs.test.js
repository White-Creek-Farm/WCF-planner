import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';

// ============================================================================
// Fail-closed spec validation for the focused TEST-project runner
// (scripts/ci_focused_specs.cjs). The pure parser is exercised exhaustively on
// hostile specs_json without any filesystem; the full validator is checked
// against the real checked-out tests/ directory.
// ============================================================================

const require = createRequire(import.meta.url);
const {
  parseSpecsJson,
  validateFocusedSpecs,
  discoverExistingRootSpecs,
  SpecValidationError,
} = require('../../scripts/ci_focused_specs.cjs');

const ROOT = process.cwd();
const existing = [...discoverExistingRootSpecs(ROOT)].sort();

describe('parseSpecsJson — accepts only well-formed unique root spec lists', () => {
  it('accepts a single valid root spec', () => {
    expect(parseSpecsJson('["tests/sheep_send_to_processor.spec.js"]')).toEqual([
      'tests/sheep_send_to_processor.spec.js',
    ]);
  });

  it('accepts multiple valid specs and returns them sorted + unique', () => {
    expect(parseSpecsJson('["tests/broiler_batches.spec.js", "tests/animal_history_page.spec.js"]')).toEqual([
      'tests/animal_history_page.spec.js',
      'tests/broiler_batches.spec.js',
    ]);
  });

  it('accepts hyphen/underscore/digit safe names', () => {
    expect(parseSpecsJson('["tests/a1_b-c.spec.js"]')).toEqual(['tests/a1_b-c.spec.js']);
  });
});

describe('parseSpecsJson — rejects malformed containers (fail closed)', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
    ['null value', null],
    ['non-string arg (number)', 123],
    ['not JSON', 'tests/x.spec.js'],
    ['trailing garbage JSON', '["tests/x.spec.js"] rm -rf /'],
    ['a JSON object', '{}'],
    ['a JSON string, not array', '"tests/x.spec.js"'],
    ['a JSON number', '123'],
    ['a JSON boolean', 'true'],
    ['a JSON null', 'null'],
    ['an empty array', '[]'],
    ['nested array', '[["tests/x.spec.js"]]'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpecsJson(input)).toThrow(SpecValidationError);
  });
});

describe('parseSpecsJson — rejects hostile / non-string entries', () => {
  it.each([
    ['a number entry', '[123]'],
    ['a null entry', '[null]'],
    ['an object entry', '[{}]'],
    ['an array entry', '[[]]'],
    ['a boolean entry', '[true]'],
    ['an empty string entry', '[""]'],
    ['a duplicate entry', '["tests/x.spec.js", "tests/x.spec.js"]'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpecsJson(input)).toThrow(SpecValidationError);
  });
});

describe('parseSpecsJson — rejects path traversal, absolute paths, nesting', () => {
  it.each([
    ['parent traversal inside tests', '["tests/../secret.spec.js"]'],
    ['parent traversal prefix', '["../tests/x.spec.js"]'],
    ['deep traversal', '["tests/../../etc/x.spec.js"]'],
    ['posix absolute path', '["/etc/passwd"]'],
    ['posix absolute spec', '["/tests/x.spec.js"]'],
    ['windows absolute path', '["C:\\\\Windows\\\\x.spec.js"]'],
    ['nested setup file', '["tests/setup/reset.js"]'],
    ['nested helper file', '["tests/helpers/appReady.js"]'],
    ['nested scenario spec', '["tests/scenarios/thing.spec.js"]'],
    ['nested subdir spec', '["tests/sub/thing.spec.js"]'],
    ['dot-prefixed hidden', '["tests/.env.spec.js"]'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpecsJson(input)).toThrow(SpecValidationError);
  });
});

describe('parseSpecsJson — rejects non-spec targets, globs, flags, shell fragments', () => {
  it.each([
    ['wrong extension .js', '["tests/x.js"]'],
    ['wrong extension .ts', '["tests/x.spec.ts"]'],
    ['config path', '["playwright.config.js"]'],
    ['script path outside tests', '["scripts/ci_focused_specs.cjs"]'],
    ['bare directory', '["tests"]'],
    ['directory slash', '["tests/"]'],
    ['star glob', '["tests/*.spec.js"]'],
    ['double-star glob', '["tests/**/*.spec.js"]'],
    ['brace glob', '["tests/{a,b}.spec.js"]'],
    ['long flag', '["--workers=4"]'],
    ['short flag', '["-g"]'],
    ['config flag', '["--config=evil.js"]'],
    ['embedded flag (space)', '["tests/x.spec.js --workers=4"]'],
    ['semicolon command', '["tests/x.spec.js; rm -rf /"]'],
    ['pipe command', '["tests/x.spec.js|cat /etc/passwd"]'],
    ['command substitution', '["tests/$(whoami).spec.js"]'],
    ['backtick substitution', '["tests/`id`.spec.js"]'],
    ['ampersand', '["tests/x.spec.js & sleep 1"]'],
    ['redirect', '["tests/x.spec.js > out"]'],
    ['newline injection', '["tests/x.spec.js\\nrm -rf /"]'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpecsJson(input)).toThrow(SpecValidationError);
  });
});

describe('parseSpecsJson — rejects ineligible utility + pasture specs by name', () => {
  it.each([
    ['pasture map spec', '["tests/pasture_map_import.spec.js"]'],
    ['screenshot packet', '["tests/cattle_log_screenshots.spec.js"]'],
    ['redesign screenshots', '["tests/daily_redesign_screenshots.spec.js"]'],
    ['ux audit', '["tests/ux_audit.spec.js"]'],
    ['mobile audit', '["tests/mobile_audit.spec.js"]'],
  ])('rejects %s', (_label, input) => {
    expect(() => parseSpecsJson(input)).toThrow(SpecValidationError);
  });
});

describe('validateFocusedSpecs — existence membership against the real tests/ dir', () => {
  it('the repo exposes eligible root specs to run', () => {
    expect(existing.length).toBeGreaterThan(0);
    // Excluded families are never in the eligible set.
    expect(existing.some((s) => s.startsWith('tests/pasture_map_'))).toBe(false);
    expect(existing.some((s) => /(?:screenshots|ux_audit|mobile_audit)\.spec\.js$/.test(s))).toBe(false);
  });

  it('accepts real existing specs and returns them sorted', () => {
    const sample = existing.slice(0, Math.min(2, existing.length));
    const json = JSON.stringify([...sample].reverse());
    expect(validateFocusedSpecs(json, {rootDir: ROOT})).toEqual([...sample].sort());
  });

  it('rejects a syntactically valid but non-existent spec', () => {
    expect(() => validateFocusedSpecs('["tests/definitely_not_a_real_spec_zzz.spec.js"]', {rootDir: ROOT})).toThrow(
      SpecValidationError,
    );
  });

  it('rejects the whole batch if any one spec is missing', () => {
    const good = existing[0];
    const json = JSON.stringify([good, 'tests/definitely_not_a_real_spec_zzz.spec.js']);
    expect(() => validateFocusedSpecs(json, {rootDir: ROOT})).toThrow(SpecValidationError);
  });
});
