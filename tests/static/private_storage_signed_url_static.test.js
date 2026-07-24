import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// `safeBucket` is the allowlist-coerced comment-attachment bucket variable
// (see src/lib/commentAttachments.js); a dedicated test below pins it to the
// closed ALLOWED_COMMENT_ATTACHMENT_BUCKETS coercion.
const PRIVATE_BUCKET =
  '(?:DAILY_BUCKET|COMMENT_ATTACHMENT_BUCKET|TASK_PHOTOS_BUCKET|TASK_REQUEST_PHOTOS_BUCKET|PROCESSING_ATTACHMENT_BUCKET|safeBucket|[\'"]daily-photos[\'"]|[\'"]fuel-bills[\'"]|[\'"]comment-photos[\'"]|[\'"]task-photos[\'"]|[\'"]task-request-photos[\'"]|[\'"]processing-attachments[\'"])';

const EXPECTED_SIGNED_URL_OWNERS = new Map([
  ['src/admin/FuelBillsView.jsx', 1],
  ['src/lib/commentAttachments.js', 1],
  // Processing attachments (migs 163/166/185): private processing-attachments
  // bucket; short-lived signed open/download for the record drawer, the
  // mig-185 delete-flow existence probe (an empty storage.remove result is
  // verified via a signed-URL mint before success/failure is decided), AND the
  // image-thumbnail signer (getProcessingAttachmentThumbUrl).
  ['src/lib/processingAttachmentsApi.js', 3],
  ['src/lib/tasksCenterMutationsApi.js', 2],
  ['src/lib/tasksUserApi.js', 2],
  // To Do photos (mig 115): private task-photos bucket, todo/<id>/ prefix.
  ['src/lib/todoApi.js', 1],
  ['src/shared/DailyPhotoThumbnails.jsx', 2],
]);

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

describe('Private storage buckets use signed URLs only', () => {
  it('never exposes private bucket paths via getPublicUrl', () => {
    const publicUrlRe = new RegExp(`\\.from\\(\\s*${PRIVATE_BUCKET}\\s*\\)[\\s\\S]{0,180}?\\.getPublicUrl\\s*\\(`, 'g');
    const offenders = [];

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (publicUrlRe.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('keeps private bucket signed URL reads in known owner modules', () => {
    const signedUrlRe = new RegExp(
      `\\.from\\(\\s*${PRIVATE_BUCKET}\\s*\\)[\\s\\S]{0,180}?\\.createSignedUrl\\s*\\(`,
      'g',
    );
    const seen = new Map();
    let signedUrlCount = 0;

    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      const count = [...code.matchAll(signedUrlRe)].length;
      if (!count) continue;
      seen.set(rel, count);
      signedUrlCount += count;
    }

    const unexpected = [...seen.keys()].filter((rel) => !EXPECTED_SIGNED_URL_OWNERS.has(rel));
    const missing = [...EXPECTED_SIGNED_URL_OWNERS.keys()].filter((rel) => !seen.has(rel));
    const wrongCounts = [...EXPECTED_SIGNED_URL_OWNERS.entries()]
      .filter(([rel, count]) => seen.get(rel) !== count)
      .map(([rel, count]) => `${rel}: expected ${count}, saw ${seen.get(rel) ?? 0}`);

    expect(signedUrlCount).toBe(12);
    expect(unexpected).toEqual([]);
    expect(missing).toEqual([]);
    expect(wrongCounts).toEqual([]);
  });

  it('the coerced safeBucket variable exists ONLY as the closed-allowlist coercion', () => {
    const users = [];
    for (const file of listRuntimeSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (!/\bsafeBucket\b/.test(code)) continue;
      users.push(rel);
      // Every module that names safeBucket must define it as the coercion —
      // client-owned metadata can never steer .from() to an arbitrary bucket.
      expect(code, `${rel} coerces safeBucket via the allowlist`).toMatch(
        /safeBucket = ALLOWED_COMMENT_ATTACHMENT_BUCKETS\.includes\(bucket\) \? bucket : COMMENT_ATTACHMENT_BUCKET/,
      );
    }
    expect(users).toEqual(['src/lib/commentAttachments.js']);
  });
});
