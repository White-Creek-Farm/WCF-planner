import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const ALLOWED_IMPORT_META_ENV = new Set(['DEV', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_URL']);

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

describe('browser secret boundary', () => {
  it('keeps service-role, database, test-admin, and server-only secret names out of src runtime', () => {
    const forbiddenRe =
      /\b(?:SUPABASE_SERVICE_ROLE_KEY|SERVICE_ROLE|PROD_DB_URL|DATABASE_URL|exec_sql|VITE_TEST_ADMIN_EMAIL|VITE_TEST_ADMIN_PASSWORD|TEST_ADMIN_PASSWORD|RESEND_API_KEY|TASKS_CRON_SECRET|TOMORROW_API_KEY|OPENAI_API_KEY)\b/i;
    const offenders = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (forbiddenRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps browser code on import.meta.env instead of process.env', () => {
    const offenders = [];
    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\bprocess\.env\b/.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps import.meta.env reads to the approved browser-safe keys', () => {
    const envRe = /import\.meta\.env\.([A-Z0-9_]+)/g;
    const seen = [];
    const offenders = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(envRe)) {
        seen.push(`${match[1]} @ ${rel}`);
        if (!ALLOWED_IMPORT_META_ENV.has(match[1])) offenders.push(`${match[1]} @ ${rel}`);
      }
    }

    expect(seen).toEqual([
      'VITE_SUPABASE_URL @ src/lib/supabase.js',
      'VITE_SUPABASE_ANON_KEY @ src/lib/supabase.js',
      'DEV @ src/lib/supabase.js',
      'DEV @ src/main.jsx',
    ]);
    expect(offenders).toEqual([]);
  });
});
