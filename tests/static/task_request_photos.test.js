import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, it, expect} from 'vitest';
import {_REGISTRY as RPC_REGISTRY} from '../../src/lib/offlineRpcForms.js';

// ============================================================================
// Task request photos — C3.1b static-shape lock
// ============================================================================
// Locks:
//   1. Mig 042: column add, bucket creation, explicit anon + auth INSERT
//      policies, authenticated SELECT, NO anon SELECT, NO UPDATE/DELETE,
//      submit_task_instance request_photo_path validation (prefix match
//      + non-empty filename + no '/' or chr(92)).
//   2. offlineRpcForms task_submit registry: hasPhoto:true; buildArgs
//      threads requestPhotoDbPath into parent_in only when present;
//      OTHER registry entries (weigh_in_session_batch, add_feed_batch)
//      do NOT carry hasPhoto.
//   3. useOfflineRpcSubmit: hasPhoto branch is opt-in via cfg.hasPhoto;
//      photo prep + upload + atomic enqueue with blob; replay re-uploads
//      with upsert:true and rebuilds parent_in.request_photo_path.
//   4. Public TasksWebform: optional photo input wired through
//      submit(payload, {parentId, photo}).
//   5. AdminTasksView: photo input on one-time tasks only (hidden when
//      recurring); synchronous upload before createOneTimeTaskInstance;
//      Open Tasks list shows lazy 📎 Photo link via getRequestPhotoSignedUrl.
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const migSrc = fs.readFileSync(path.join(ROOT, 'supabase-migrations/042_task_request_photos.sql'), 'utf8');
const tasksSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasks.js'), 'utf8');
const rpcSrc = fs.readFileSync(path.join(ROOT, 'src/lib/offlineRpcForms.js'), 'utf8');
const hookSrc = fs.readFileSync(path.join(ROOT, 'src/lib/useOfflineRpcSubmit.js'), 'utf8');
const adminApiSrc = fs.readFileSync(path.join(ROOT, 'src/lib/tasksAdminApi.js'), 'utf8');
// Legacy AdminTasksView source removed by T11 — its photo-wiring
// describe block was dropped alongside the source file.
const webformSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/TasksWebform.jsx'), 'utf8');
const dailyPhotoCaptureSrc = fs.readFileSync(path.join(ROOT, 'src/webforms/DailyPhotoCapture.jsx'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
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

describe('Mig 042 — column + bucket + storage policies', () => {
  it('adds task_instances.request_photo_path (nullable, IF NOT EXISTS)', () => {
    expect(migSrc).toMatch(/ALTER TABLE public\.task_instances\s+ADD COLUMN IF NOT EXISTS request_photo_path text/i);
  });

  it('creates the task-request-photos bucket private (public:false) with ON CONFLICT DO NOTHING', () => {
    expect(migSrc).toMatch(/INSERT INTO storage\.buckets[\s\S]{0,200}?'task-request-photos'[\s\S]{0,100}?false/);
    expect(migSrc).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it('explicit anon INSERT policy on task-request-photos', () => {
    expect(migSrc).toMatch(
      /CREATE POLICY task_request_photos_anon_insert ON storage\.objects\s+FOR INSERT TO anon\s+WITH CHECK \(bucket_id = 'task-request-photos'\)/,
    );
  });

  it('explicit authenticated INSERT policy on task-request-photos (NOT inheriting anon)', () => {
    expect(migSrc).toMatch(
      /CREATE POLICY task_request_photos_auth_insert ON storage\.objects\s+FOR INSERT TO authenticated\s+WITH CHECK \(bucket_id = 'task-request-photos'\)/,
    );
  });

  it('authenticated SELECT policy on task-request-photos (signed-URL admin reads)', () => {
    expect(migSrc).toMatch(
      /CREATE POLICY task_request_photos_auth_select ON storage\.objects\s+FOR SELECT TO authenticated\s+USING \(bucket_id = 'task-request-photos'\)/,
    );
  });

  it('NO anon SELECT and NO UPDATE/DELETE policies on the bucket', () => {
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]{0,100}?TO anon[\s\S]{0,100}?FOR SELECT/);
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]{0,200}?task-request-photos[\s\S]{0,200}?FOR UPDATE/);
    expect(migSrc).not.toMatch(/CREATE POLICY[\s\S]{0,200}?task-request-photos[\s\S]{0,200}?FOR DELETE/);
  });
});

describe('Mig 042 — submit_task_instance request_photo_path validation', () => {
  // Restrict the search window to the submit_task_instance function
  // body so unrelated SQL doesn't false-match.
  const fn = migSrc.match(
    /CREATE OR REPLACE FUNCTION public\.submit_task_instance\(parent_in jsonb\)[\s\S]*?\$submit_task_instance\$;/,
  );
  const body = fn ? fn[0] : '';

  it('the function body locates the optional request_photo_path field on parent_in', () => {
    expect(body).toMatch(/v_request_photo_path\s*:=\s*nullif\(parent_in\s*->>\s*'request_photo_path',\s*''\)/);
  });

  it('uses left(path, length(prefix)) = prefix (NOT LIKE — _/% are wildcards)', () => {
    expect(body).toMatch(/left\(v_request_photo_path,\s*length\(v_expected_prefix\)\)\s*<>\s*v_expected_prefix/);
    expect(body).toMatch(/RAISE EXCEPTION 'submit_task_instance: request_photo_path prefix mismatch'/);
  });

  it('rejects empty filename', () => {
    expect(body).toMatch(/RAISE EXCEPTION 'submit_task_instance: request_photo_path filename empty'/);
  });

  it("rejects '/' or backslash via position(chr(92) IN ...)", () => {
    expect(body).toMatch(/position\('\/' IN v_filename\)\s*>\s*0/);
    expect(body).toMatch(/position\(chr\(92\) IN v_filename\)\s*>\s*0/);
    expect(body).toMatch(/RAISE EXCEPTION 'submit_task_instance: request_photo_path filename invalid'/);
  });

  it('INSERT statement writes request_photo_path column', () => {
    expect(body).toMatch(/INSERT INTO public\.task_instances\b[\s\S]*?request_photo_path[\s\S]*?VALUES/);
    expect(body).toMatch(/v_request_photo_path[\s\S]{0,30}?\)/);
  });
});

describe('offlineRpcForms task_submit registry has hasPhoto:true (opt-in)', () => {
  it('task_submit carries hasPhoto:true', () => {
    expect(RPC_REGISTRY.task_submit.hasPhoto).toBe(true);
  });

  it('weigh_in_session_batch + add_feed_batch do NOT carry hasPhoto (opt-in only)', () => {
    expect(RPC_REGISTRY.weigh_in_session_batch.hasPhoto).toBeFalsy();
    expect(RPC_REGISTRY.add_feed_batch.hasPhoto).toBeFalsy();
  });

  it('buildArgs threads requestPhotoDbPath into parent_in only when truthy', () => {
    const withPhoto = RPC_REGISTRY.task_submit.buildArgs(
      {
        title: 'Refill mineral',
        description: 'East pasture',
        due_date: '2026-05-10',
        assignee_profile_id: 'u',
        submitted_by_team_member: 'A',
      },
      {csid: 'c', parentId: 'ti-x', requestPhotoDbPath: 'task-request-photos/ti-x/photo-1.jpg'},
    );
    expect(withPhoto.args.parent_in.request_photo_path).toBe('task-request-photos/ti-x/photo-1.jpg');

    const withoutPhoto = RPC_REGISTRY.task_submit.buildArgs(
      {title: 'x', due_date: '2026-05-10', assignee_profile_id: 'u', submitted_by_team_member: 'A'},
      {csid: 'c', parentId: 'ti-x'},
    );
    expect(withoutPhoto.args.parent_in).not.toHaveProperty('request_photo_path');
  });
});

describe('useOfflineRpcSubmit hasPhoto branch wiring', () => {
  it('imports the bucket constant + path helpers from tasks.js', () => {
    expect(hookSrc).toMatch(/from\s+'\.\/tasks\.js'/);
    expect(hookSrc).toMatch(/TASK_REQUEST_PHOTOS_BUCKET/);
    expect(hookSrc).toMatch(/buildTaskRequestPhotoStoragePath/);
    expect(hookSrc).toMatch(/buildTaskRequestPhotoDbPath/);
  });

  it('imports compressImage + the queue photo APIs', () => {
    expect(hookSrc).toMatch(/from\s+'\.\/photoCompress\.js'/);
    expect(hookSrc).toMatch(/enqueueSubmissionWithPhotos/);
    expect(hookSrc).toMatch(/listPhotoBlobsByCsid/);
  });

  it('the submit-time photo branch is gated on cfg.hasPhoto && opts.photo', () => {
    expect(hookSrc).toMatch(/if\s*\(cfg\.hasPhoto\s*&&\s*opts\.photo\)/);
  });

  it('the upload helper uses upsert:false + duplicate-as-success (Codex C2 review)', () => {
    // The local helper in useOfflineRpcSubmit.js is the single
    // upload path used by both submit-time AND replay; both go
    // through upsert:false. Storage Duplicate errors are caught
    // via isStorageDuplicateError. Same retry-safety as before
    // without needing a storage UPDATE policy.
    const fnMatch = hookSrc.match(/async function uploadTaskRequestPhoto\([\s\S]*?\n\}\s*\n/);
    expect(fnMatch, 'expected local uploadTaskRequestPhoto helper').not.toBeNull();
    expect(fnMatch[0]).toMatch(/upsert:\s*false/);
    expect(fnMatch[0]).not.toMatch(/upsert:\s*true/);
    expect(fnMatch[0]).toMatch(/isStorageDuplicateError\(error\)/);
  });

  it('replay rebuilds parent_in.request_photo_path on the in-memory record (no IDB mutation)', () => {
    // Lock the spread-rebuild pattern that produces a fresh record vs.
    // mutating entry.record in place (some browsers freeze cursor results).
    expect(hookSrc).toMatch(/recordToSend\s*=\s*\{[\s\S]{0,200}?args:\s*\{[\s\S]{0,200}?parent_in:\s*\{/);
    expect(hookSrc).toMatch(/request_photo_path:\s*dbPath/);
  });

  it('rejects opts.photo arrays (one-photo-max contract)', () => {
    expect(hookSrc).toMatch(/Array\.isArray\(blobOrFile\)/);
    expect(hookSrc).toMatch(/must be a single Blob\/File, not an array/);
  });
});

describe('Public TasksWebform photo wiring', () => {
  it('has a photoFile state', () => {
    expect(webformSrc).toMatch(/const \[photoFile, setPhotoFile\] = React\.useState\(null\)/);
  });

  it('passes opts.photo to submit()', () => {
    expect(webformSrc).toMatch(
      /submit\(payload,\s*\{\s*parentId:\s*mintTiInstanceId\(\),\s*photo:\s*photoFile\s*\|\|\s*null\s*\}\)/,
    );
  });

  it('renders an optional file input with image/* and NO capture attribute (mobile must allow library pick)', () => {
    expect(webformSrc).toMatch(/type="file"[\s\S]{0,200}?accept="image\/\*"/);
    // Negative lookbehind avoids matching `data-...-capture="..."` data attributes.
    expect(webformSrc).not.toMatch(/(?<!-)capture=/);
  });

  it('clears photoFile in resetForm (and on Remove)', () => {
    expect(webformSrc).toMatch(/setPhotoFile\(null\)/);
  });
});

describe('tasksAdminApi photo helpers', () => {
  it('uploadTaskRequestPhoto compresses + uploads to the bucket and returns the dbPath', () => {
    expect(adminApiSrc).toMatch(/export async function uploadTaskRequestPhoto\(sb,\s*instanceId,\s*blobOrFile\)/);
    expect(adminApiSrc).toMatch(/compressImage\(blobOrFile\)/);
    expect(adminApiSrc).toMatch(/sb\.storage[\s\S]{0,200}?\.upload\(storagePath/);
    // dbPath is precomputed via buildTaskRequestPhotoDbPath then
    // returned (so the duplicate-as-success branch can return the
    // same canonical path without re-computing).
    expect(adminApiSrc).toMatch(/buildTaskRequestPhotoDbPath\(instanceId,\s*filename\)/);
    expect(adminApiSrc).toMatch(/return dbPath/);
  });

  it('uploadTaskRequestPhoto is retry-safe via upsert:false + duplicate-as-success (Codex C2 review)', () => {
    // Codex C2 review supersedes the C3.1b upsert:true approach:
    // the bucket is append-only (no UPDATE policy), so upsert:true
    // would fail at the policy layer. Keep upsert:false and treat
    // Duplicate / 409 / "already exists" as idempotent success.
    const fnMatch = adminApiSrc.match(/export async function uploadTaskRequestPhoto\([\s\S]*?\n\}\s*\n/);
    expect(fnMatch, 'expected uploadTaskRequestPhoto function body').not.toBeNull();
    expect(fnMatch[0]).toMatch(/upsert:\s*false/);
    expect(fnMatch[0]).not.toMatch(/upsert:\s*true/);
    expect(fnMatch[0]).toMatch(/isStorageDuplicateError\(error\)/);
  });

  it('getRequestPhotoSignedUrl is no longer exported from tasksAdminApi.js (relocated to tasksUserApi.js per Codex C2 amendment 3)', () => {
    expect(adminApiSrc).not.toMatch(/export async function getRequestPhotoSignedUrl/);
    // The actual helper is locked separately by tests/static/my_tasks_static.test.js
    // under "tasksUserApi.js — assignee/admin completion + signed URLs".
  });
});

describe('task-request-photos source-wide append-only storage contract', () => {
  it('all task-request-photos upload paths use upsert:false', () => {
    const uploadRe =
      /\.from\(\s*(?:TASK_REQUEST_PHOTOS_BUCKET|['"]task-request-photos['"])\s*\)[\s\S]{0,500}?\.upload\([\s\S]*?\);/g;
    const offenders = [];
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      for (const match of code.matchAll(uploadRe)) {
        const chunk = match[0];
        if (/upsert:\s*true/.test(chunk) || !/upsert:\s*false/.test(chunk)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('tasks.js path-shape constants exist (pure)', () => {
  it('exports the bucket name + filename + path helpers', () => {
    expect(tasksSrc).toMatch(/export const TASK_REQUEST_PHOTOS_BUCKET\s*=\s*'task-request-photos'/);
    expect(tasksSrc).toMatch(/export const TASK_REQUEST_PHOTO_DEFAULT_FILENAME\s*=\s*'photo-1\.jpg'/);
    expect(tasksSrc).toMatch(/export function buildTaskRequestPhotoStoragePath/);
    expect(tasksSrc).toMatch(/export function buildTaskRequestPhotoDbPath/);
    expect(tasksSrc).toMatch(/export function stripTaskRequestPhotoBucket/);
  });
});

describe('DailyPhotoCapture file input (daily report photos)', () => {
  it('renders type="file" + accept="image/*" + multiple, with NO capture attribute (mobile must allow library pick)', () => {
    expect(dailyPhotoCaptureSrc).toMatch(/type="file"/);
    expect(dailyPhotoCaptureSrc).toMatch(/accept="image\/\*"/);
    expect(dailyPhotoCaptureSrc).toMatch(/\bmultiple\b/);
    // Negative lookbehind avoids matching the `data-daily-photo-capture="1"` selector marker.
    expect(dailyPhotoCaptureSrc).not.toMatch(/(?<!-)capture=/);
  });
});

// Exercise the same import path the source uses so a broken import surfaces here.
void rpcSrc;
