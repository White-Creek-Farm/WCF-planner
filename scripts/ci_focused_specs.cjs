#!/usr/bin/env node
// ============================================================================
// scripts/ci_focused_specs.cjs — fail-closed spec validation for the manually
// dispatched focused TEST-project Playwright runner
// (.github/workflows/ci-focused-project.yml).
// ============================================================================
// The focused runner lets an operator run one or more EXISTING root Playwright
// spec files against ONE explicitly assigned isolated TEST project (A/B/C/D)
// without launching the two-shard full suite. The operator supplies the spec
// list as `specs_json`, a JSON array string. That string is fully attacker-
// shaped input, so it is parsed and validated HERE (never with eval, never
// interpolated into a shell), and only the validated, quoted paths are handed
// to Playwright as an argument array.
//
// This module owns the SAFETY-CRITICAL parse + guard. It is CI/tooling code
// only; it is never imported by src/ (the browser bundle).
//
// Fail-closed contract (every rule rejects, nothing is silently dropped):
//   - `specs_json` must be a JSON array of one or more UNIQUE non-empty
//     strings. Non-array, empty, non-string, duplicate, or unparseable input
//     is refused.
//   - Each entry must match EXACTLY `tests/<safe-name>.spec.js`, where
//     <safe-name> is `[A-Za-z0-9][A-Za-z0-9_-]*` (letters/digits/underscore/
//     hyphen only). This alone rejects path traversal (`..`), absolute paths,
//     nested files (`tests/setup/...`, `tests/helpers/...`, scenario files),
//     config paths, globs (`*`), flags (`--workers`, `-g`), directories, and
//     any shell fragment (`;`, spaces, `$(...)`, backticks, redirects).
//   - Screenshot/UX-audit/mobile-audit capture utilities and Pasture Map specs
//     are refused by name. They are not the regression floor and/or require the
//     isolated pasture config; mirrors playwright.config.js rootRunUtilityIgnores
//     and scripts/ci_playwright_plan.cjs discoverRootSpecs.
//   - Each validated entry must ALSO be an existing top-level file under
//     `tests/`. A requested spec that does not exist on disk is refused (no
//     empty/no-op run is ever produced).
//
// The pure parse layer (parseSpecsJson) needs no filesystem so hostile inputs
// are exhaustively unit-tested without I/O; validateFocusedSpecs adds the
// existence check against the checked-out repo.
// ============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// EXACT allowed shape: a root-level tests/<safe-name>.spec.js and nothing else.
const SPEC_RE = /^tests\/[A-Za-z0-9][A-Za-z0-9_-]*\.spec\.js$/;

// Capture/audit utilities and Pasture Map specs are never eligible even though
// their names satisfy SPEC_RE. Kept in lockstep (by intent) with
// playwright.config.js rootRunUtilityIgnores + ci_playwright_plan.cjs excludes.
const EXCLUDED_RE = /^tests\/pasture_map_|(?:screenshots|ux_audit|mobile_audit)\.spec\.js$/;

class SpecValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpecValidationError';
  }
}

// Short, safe representation of an offending value for error logs. Never
// executed, and truncated so a hostile blob cannot spam the run log.
function repr(value) {
  let s;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== 'string') s = String(s);
  s = s.replace(/[\r\n\t]+/g, ' ');
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

// PURE syntactic validation. Parses the raw JSON string and returns a sorted,
// de-duplicated array of safe spec paths, or throws SpecValidationError. No
// filesystem access, so it is exhaustively unit-testable on hostile inputs.
function parseSpecsJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SpecValidationError('specs_json is required and must be a non-empty JSON array string.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw); // JSON.parse only — never eval / Function.
  } catch (err) {
    throw new SpecValidationError(`specs_json is not valid JSON: ${repr(err && err.message)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new SpecValidationError(`specs_json must be a JSON array; got ${repr(parsed)}.`);
  }
  if (parsed.length === 0) {
    throw new SpecValidationError('specs_json must contain at least one spec path (empty list refused).');
  }

  const seen = new Set();
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new SpecValidationError(`Every specs_json entry must be a string; got ${repr(entry)}.`);
    }
    if (!SPEC_RE.test(entry)) {
      throw new SpecValidationError(
        `Rejected spec "${repr(entry)}": only existing root files matching tests/<safe-name>.spec.js are allowed ` +
          '(no paths, traversal, nesting, globs, flags, or shell fragments).',
      );
    }
    if (EXCLUDED_RE.test(entry)) {
      throw new SpecValidationError(
        `Rejected spec "${repr(entry)}": screenshot/audit capture utilities and Pasture Map specs are not eligible ` +
          'for the focused runner.',
      );
    }
    if (seen.has(entry)) {
      throw new SpecValidationError(`Duplicate spec "${repr(entry)}" in specs_json; entries must be unique.`);
    }
    seen.add(entry);
  }

  return [...seen].sort();
}

// The set of legitimate, existing top-level root specs on disk. Mirrors the
// exclusion intent of scripts/ci_playwright_plan.cjs discoverRootSpecs but also
// drops the audit/mobile utilities. readdir of the tests/ ROOT only (files),
// so nested directories are never enumerated.
function discoverExistingRootSpecs(rootDir) {
  const testsDir = path.join(rootDir, 'tests');
  if (!fs.existsSync(testsDir)) return new Set();
  const specs = fs
    .readdirSync(testsDir, {withFileTypes: true})
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.js'))
    .map((entry) => `tests/${entry.name}`)
    .filter((rel) => SPEC_RE.test(rel) && !EXCLUDED_RE.test(rel));
  return new Set(specs);
}

// Full validation: syntactic parse THEN existence membership. Returns the
// validated, sorted, unique array of spec paths. Throws on any violation.
function validateFocusedSpecs(raw, {rootDir = process.cwd()} = {}) {
  const requested = parseSpecsJson(raw);
  const existing = discoverExistingRootSpecs(rootDir);
  const missing = requested.filter((spec) => !existing.has(spec));
  if (missing.length > 0) {
    throw new SpecValidationError(
      `Rejected: ${missing.length} requested spec(s) are not existing eligible root specs: ` +
        `${missing.map(repr).join(', ')}.`,
    );
  }
  return requested;
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    result[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : 'true';
  }
  return result;
}

// CLI: read specs_json from the environment (NEVER a CLI arg / shell arg, so it
// cannot be interpolated into a command line), validate, and write the newline-
// delimited validated paths to the --out file for the workflow to consume as a
// bash array. Any failure exits non-zero BEFORE Playwright / any DB reset runs.
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const outFile = typeof args.out === 'string' && args.out !== 'true' ? args.out : 'validated-specs.txt';
  const rootDir = typeof args.root === 'string' && args.root !== 'true' ? args.root : process.cwd();
  try {
    const specs = validateFocusedSpecs(process.env.SPECS_JSON, {rootDir});
    // path.resolve so a relative --out lands under rootDir and an absolute one
    // is honored as-is (path.join would corrupt an absolute path).
    fs.writeFileSync(path.resolve(rootDir, outFile), `${specs.join('\n')}\n`, 'utf8');
    // Safe summary only: count + validated canonical names (never the raw input).
    process.stdout.write(`Validated ${specs.length} focused spec(s):\n`);
    for (const spec of specs) process.stdout.write(`  ${spec}\n`);
  } catch (err) {
    const message =
      err instanceof SpecValidationError ? err.message : `Unexpected validation failure: ${repr(err && err.message)}`;
    process.stderr.write(`Focused spec validation FAILED (fail closed): ${message}\n`);
    process.exit(1);
  }
}

module.exports = {
  SPEC_RE,
  EXCLUDED_RE,
  SpecValidationError,
  parseSpecsJson,
  discoverExistingRootSpecs,
  validateFocusedSpecs,
};
