import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const LEGACY_ACTIVITY_RPC_NAMES = [
  'count_activity_for_entity',
  'post_activity_comment',
  'edit_activity_event',
  'delete_activity_event',
];
const RETIREMENT_MIGRATION = 'supabase-migrations/080_retire_legacy_activity_composer_rpcs.sql';
const LEGACY_ACTIVITY_HELPERS = [
  'countActivityForEntity',
  'postActivityComment',
  'editActivityEvent',
  'deleteActivityEvent',
];
const LEGACY_UI_TOKENS = [
  'ActivityPanel',
  'ActivityModal',
  'setActivityTarget',
  'wcf-entity-deep-link',
  '_wcfEntityDeepLink',
];

function stripComments(src) {
  return src.replace(/(^|\s)\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function listFiles(dir, re) {
  const out = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, re));
      continue;
    }
    if (entry.isFile() && re.test(entry.name)) out.push(full);
  }
  return out;
}

function runtimeSourceFiles() {
  return listFiles(path.join(ROOT, 'src'), /\.(jsx?|cjs|mjs)$/).filter(
    (file) => !/\.(test|spec)\.(jsx?|cjs|mjs)$/.test(file),
  );
}

describe('legacy Activity composer retirement', () => {
  it('keeps runtime source from calling retired Activity composer RPCs', () => {
    const offenders = [];
    const rpcRe = /\.rpc\(\s*(['"])(post_activity_comment|edit_activity_event|delete_activity_event)\1/;

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (rpcRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps retired Activity client helpers out of runtime source', () => {
    const offenders = [];

    for (const file of runtimeSourceFiles()) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const token of [...LEGACY_ACTIVITY_HELPERS, ...LEGACY_UI_TOKENS]) {
        if (code.includes(token)) offenders.push(`${rel}: ${token}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps activityApi limited to read-only list plus audit-event recording helpers', () => {
    const api = stripComments(fs.readFileSync(path.join(ROOT, 'src/lib/activityApi.js'), 'utf8'));

    expect(api).toContain("rpc('list_activity_events'");
    expect(api).toContain("rpc('record_activity_event'");
    for (const rpcName of LEGACY_ACTIVITY_RPC_NAMES) {
      expect(api).not.toContain(`rpc('${rpcName}'`);
    }
    for (const helper of LEGACY_ACTIVITY_HELPERS) {
      expect(api).not.toContain(`function ${helper}`);
      expect(api).not.toContain(`const ${helper}`);
    }
  });

  it('routes user discussion through commentsApi RPCs instead of Activity comment RPCs', () => {
    const commentsApi = stripComments(fs.readFileSync(path.join(ROOT, 'src/lib/commentsApi.js'), 'utf8'));

    for (const rpcName of ['post_comment', 'edit_comment', 'delete_comment', 'list_comments', 'count_comments']) {
      expect(commentsApi).toContain(`rpc('${rpcName}'`);
    }
    for (const rpcName of LEGACY_ACTIVITY_RPC_NAMES) {
      expect(commentsApi).not.toContain(rpcName);
    }
  });

  it('allows historical legacy function definitions only in the pre-comments Activity migrations', () => {
    const sqlFiles = listFiles(path.join(ROOT, 'supabase-migrations'), /\.sql$/);
    const legacyDefinitionOwners = [];
    const forbiddenNewerOwners = [];

    for (const file of sqlFiles) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const sql = fs.readFileSync(file, 'utf8');
      for (const rpcName of LEGACY_ACTIVITY_RPC_NAMES) {
        if (new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpcName}\\b`).test(sql)) {
          legacyDefinitionOwners.push(`${rel}: ${rpcName}`);
          if (!/^supabase-migrations\/0(58|60)_/.test(rel)) forbiddenNewerOwners.push(`${rel}: ${rpcName}`);
        }
      }
    }

    expect(legacyDefinitionOwners).toEqual([
      'supabase-migrations/058_activity_events.sql: count_activity_for_entity',
      'supabase-migrations/058_activity_events.sql: post_activity_comment',
      'supabase-migrations/058_activity_events.sql: edit_activity_event',
      'supabase-migrations/058_activity_events.sql: delete_activity_event',
      'supabase-migrations/060_activity_mention_contract.sql: post_activity_comment',
      'supabase-migrations/060_activity_mention_contract.sql: edit_activity_event',
    ]);
    expect(forbiddenNewerOwners).toEqual([]);
  });

  it('revokes client execute on retired legacy Activity composer/count RPCs without dropping them', () => {
    const sql = fs.readFileSync(path.join(ROOT, RETIREMENT_MIGRATION), 'utf8');

    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.count_activity_for_entity\(text,\s*text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_activity_comment\(text,\s*text,\s*text,\s*text,\s*uuid\[\]\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.edit_activity_event\(text,\s*text,\s*uuid\[\]\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.delete_activity_event\(text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
    expect(sql).not.toMatch(/DROP\s+FUNCTION/i);
  });

  it('keeps record-page Activity log audit-only while comments own discussion rendering', () => {
    const recordLog = stripComments(fs.readFileSync(path.join(ROOT, 'src/shared/RecordActivityLog.jsx'), 'utf8'));
    const collaboration = stripComments(
      fs.readFileSync(path.join(ROOT, 'src/shared/RecordCollaborationSection.jsx'), 'utf8'),
    );

    expect(recordLog).toContain("e.event_type !== 'comment.posted'");
    expect(collaboration).toContain('CommentsSection');
    expect(collaboration).toContain('RecordActivityLog');
  });
});
