import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

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

function webformSourceFiles() {
  return listRuntimeSourceFiles(path.join(ROOT, 'src/webforms')).filter(
    (file) => path.relative(ROOT, file).replace(/\\/g, '/') !== 'src/webforms/WebformsAdminView.jsx',
  );
}

describe('public webforms boundary', () => {
  it('keeps webforms away from profile/app_store/activity/notification tables', () => {
    const forbiddenTableRe =
      /\.from\(\s*['"](?:activity_events|activity_mentions|app_store|client_error_events|notifications|profiles|storage\.objects)['"]\s*\)/;
    const offenders = [];

    for (const file of webformSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (forbiddenTableRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps webforms from creating ad hoc Supabase clients or using admin auth', () => {
    const forbiddenRe = /@supabase\/supabase-js|\bcreateClient\s*\(|\bauth\.admin\b/;
    const offenders = [];

    for (const file of webformSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (forbiddenRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps server-only secrets and test/prod execution hooks out of webforms', () => {
    const forbiddenRe =
      /\b(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|PROD_DB_URL|DATABASE_URL|exec_sql|VITE_TEST_ADMIN_EMAIL|VITE_TEST_ADMIN_PASSWORD|RESEND_API_KEY|TASKS_CRON_SECRET)\b/i;
    const offenders = [];

    for (const file of webformSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (forbiddenRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps webforms independent of authenticated-app context hooks', () => {
    const offenders = [];

    for (const file of webformSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/useAuth\s*\(|AuthContext/.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
