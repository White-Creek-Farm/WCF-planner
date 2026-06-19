import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const EXPECTED_WEBFORM_CONFIG_OWNERS = new Map([
  ['src/lib/tasksAdminApi.js', 3],
  ['src/lib/tasksCenterApi.js', 1],
  ['src/lib/tasksPublicApi.js', 1],
  ['src/main.jsx', 11],
  ['src/shared/AdminAddReportModal.jsx', 6],
  ['src/shared/AdminNewWeighInModal.jsx', 2],
  ['src/webforms/AddFeedWebform.jsx', 6],
  ['src/webforms/WebformHub.jsx', 6],
  ['src/webforms/WeighInsWebform.jsx', 3],
]);

const ALLOWED_LITERAL_KEYS = new Set([
  'active_groups',
  'broiler_batch_meta',
  'broiler_groups',
  'full_config',
  'housing_batch_map',
  'webform_settings',
]);

function stripComments(src) {
  return src.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function listRuntimeSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listRuntimeSourceFiles(full));
      continue;
    }
    if (!entry.isFile() || !/\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    if (/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

function runtimeSourceFiles() {
  return listRuntimeSourceFiles(path.join(ROOT, 'src'));
}

describe('webform_config boundary', () => {
  it('keeps runtime webform_config access in known owner modules', () => {
    const accessRe = /\.from\(\s*['"]webform_config['"]\s*\)/g;
    const seen = new Map();
    let total = 0;

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(accessRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      total += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_WEBFORM_CONFIG_OWNERS.has(rel));
    const missing = [...EXPECTED_WEBFORM_CONFIG_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_WEBFORM_CONFIG_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(total).toBe(39);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('keeps literal webform_config keys in the known config set', () => {
    const keyRe = /\.from\(\s*['"]webform_config['"]\s*\)[\s\S]{0,120}?\.eq\(\s*['"]key['"]\s*,\s*(['"])(.*?)\1\s*\)/g;
    const offenders = [];
    const keys = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(keyRe)) {
        keys.push(`${match[2]} @ ${rel}`);
        if (!ALLOWED_LITERAL_KEYS.has(match[2])) offenders.push(`${match[2]} @ ${rel}`);
      }
    }

    expect(keys).toHaveLength(24);
    expect(offenders).toEqual([]);
  });

  it('broiler batch persist refreshes the public webform mirrors (no broiler_groups/meta drift)', () => {
    // P2-1 guard: broiler batch create/edit/status/schooner/brooder changes go
    // through persist(nb). It must call syncWebformConfig with the new batch
    // list so broiler_groups / broiler_batch_meta / full_config cannot drift
    // from app_store.ppp-v4 (unlike the historical persist() that only saved).
    const mainSrc = stripComments(fs.readFileSync(path.join(ROOT, 'src/main.jsx'), 'utf8'));
    const persistBody = mainSrc.match(/function persist\(nb\)\s*\{[^}]*\}/);
    expect(persistBody, 'persist(nb) function body not found in main.jsx').not.toBeNull();
    expect(persistBody[0]).toMatch(/sbSave\(\s*['"]ppp-v4['"]\s*,\s*nb\s*\)/);
    expect(persistBody[0]).toMatch(/syncWebformConfig\(\s*null\s*,\s*null\s*,\s*nb\b/);
  });

  it('keeps the task/team config modules on named constants instead of stray string keys', () => {
    const tasksSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasks.js'), 'utf8');
    const tasksPublic = fs.readFileSync(path.join(ROOT, 'src/lib/tasksPublicApi.js'), 'utf8');
    const tasksAdmin = fs.readFileSync(path.join(ROOT, 'src/lib/tasksAdminApi.js'), 'utf8');

    expect(tasksSrc).toContain("TASKS_PUBLIC_ASSIGNEE_AVAILABILITY_KEY = 'tasks_public_assignee_availability'");
    expect(tasksPublic).toContain('TASKS_PUBLIC_ASSIGNEE_AVAILABILITY_KEY');
    expect(tasksAdmin).toContain('TASKS_PUBLIC_ASSIGNEE_AVAILABILITY_KEY');
  });
});
