import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

// compressImage uses canvas/createImageBitmap — not available in the node
// test env. The mock is deterministic so blob bytes can be asserted.
vi.mock('./photoCompress.js', () => ({
  compressImage: vi.fn(async (file) => new Blob([`compressed:${file.name || 'blob'}`], {type: 'image/jpeg'})),
}));

import {
  CATTLE_LOG_SUBMIT_RPC,
  buildCattleLogAttachmentPath,
  listCattleLogQueue,
  queueCattleLogEntry,
  replayCattleLogQueue,
  sanitizeCattleLogFileName,
  toCattleLogQueueRecord,
} from './cattleLogOffline.js';
import {
  CATTLE_LOG_FORM_KIND,
  _resetDbForTests,
  deletePhotoBlobsByCsid,
  getSubmission,
  listPhotoBlobsByCsid,
  listQueued,
  setCattleLogOutcome,
} from './offlineQueue.js';

function freshIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('wcf-offline-queue');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  _resetDbForTests();
  await freshIndexedDB();
});

afterEach(() => {
  _resetDbForTests();
});

// Contract-faithful stand-in for classifyCattleLogError (cattleLogApi.js).
// Injected into every replay call so the unit tests have no dependency on
// the API module.
function classifyStub(err) {
  const msg = (err && err.message) || '';
  if (msg.includes('CATTLE_LOG_AMBIGUOUS_TAG')) return 'ambiguous_tag';
  if (msg.includes('CATTLE_LOG_MENTION_INVALID')) return 'mention_invalid';
  if (msg.includes('CATTLE_LOG_VALIDATION')) return 'validation';
  return 'transient';
}

function makeSb({upload, rpc} = {}) {
  const uploadMock = vi.fn(upload || (async () => ({data: {path: 'ok'}, error: null})));
  const rpcMock = vi.fn(rpc || (async () => ({data: {id: 'cl-x', replayed: false}, error: null})));
  const fromMock = vi.fn(() => ({upload: uploadMock}));
  return {sb: {storage: {from: fromMock}, rpc: rpcMock}, uploadMock, rpcMock, fromMock};
}

const ENTRY_ID = 'cl-m1abc-z9';

function payload(overrides = {}) {
  return {
    id: ENTRY_ID,
    body: 'Fence down near #123, calf limping',
    mentions: [],
    isIssue: true,
    calfNotes: {},
    ...overrides,
  };
}

function imageFile(name = 'photo one.jpg') {
  return new File(['raw image bytes'], name, {type: 'image/jpeg'});
}

function docFile(name = 'notes.pdf') {
  return new File(['pdf bytes'], name, {type: 'application/pdf'});
}

const KEY_0 = `cattle.log/cattle-log/${ENTRY_ID}/0-photo-one.jpg`;
const KEY_1 = `cattle.log/cattle-log/${ENTRY_ID}/1-notes.pdf`;

async function replay(sb) {
  return await replayCattleLogQueue(sb, {classifyError: classifyStub});
}

// ── Path helpers ────────────────────────────────────────────────────────────

describe('deterministic attachment paths', () => {
  it('sanitizes file names to a storage-safe basename', () => {
    expect(sanitizeCattleLogFileName('photo one.jpg')).toBe('photo-one.jpg');
    expect(sanitizeCattleLogFileName('dir/sub\\weird @#$.pdf')).toBe('weird-.pdf');
    expect(sanitizeCattleLogFileName('...')).toBe('attachment');
    expect(sanitizeCattleLogFileName('')).toBe('attachment');
  });

  it('builds the contract path prefix with a 0-based index', () => {
    expect(buildCattleLogAttachmentPath('cl-a-b', 0, 'cow.jpg')).toBe('cattle.log/cattle-log/cl-a-b/0-cow.jpg');
    expect(buildCattleLogAttachmentPath('cl-a-b', 4, 'a b.pdf')).toBe('cattle.log/cattle-log/cl-a-b/4-a-b.pdf');
  });
});

// ── queueCattleLogEntry ─────────────────────────────────────────────────────

describe('queueCattleLogEntry', () => {
  it('persists the submission row + attachment blobs and returns the contract record', async () => {
    const record = await queueCattleLogEntry(payload(), [imageFile(), docFile()]);

    expect(record.id).toBe(ENTRY_ID);
    expect(record.form).toBe(CATTLE_LOG_FORM_KIND);
    expect(record.status).toBe('queued');
    expect(record.errorClass).toBeNull();
    expect(record.uploadedPaths).toEqual([]);
    expect(record.payload.attachments.map((a) => a.key)).toEqual([KEY_0, KEY_1]);
    expect(record.payload.attachments[0]).toMatchObject({mime: 'image/jpeg', is_image: true, name: 'photo one.jpg'});
    expect(record.payload.attachments[1]).toMatchObject({mime: 'application/pdf', is_image: false, name: 'notes.pdf'});

    const row = await getSubmission(ENTRY_ID);
    expect(row).toMatchObject({csid: ENTRY_ID, form_kind: CATTLE_LOG_FORM_KIND, status: 'queued', record: null});

    const blobs = await listPhotoBlobsByCsid(ENTRY_ID);
    expect(blobs.map((b) => b.key)).toEqual([KEY_0, KEY_1]);
    // Image blob is the compressed JPEG, not the original bytes.
    expect(await blobs[0].blob.text()).toBe('compressed:photo one.jpg');
    expect(blobs[1].blob.type).toBe('application/pdf');
  });

  it('rejects bodies under 4 trimmed chars, too many attachments, and invalid ids', async () => {
    await expect(queueCattleLogEntry(payload({body: ' hi '}), [])).rejects.toThrow(/at least 4 characters/);
    await expect(
      queueCattleLogEntry(payload(), [imageFile(), imageFile(), imageFile(), imageFile(), imageFile(), imageFile()]),
    ).rejects.toThrow(/max 5 attachments/);
    await expect(queueCattleLogEntry(payload({id: 'clog-cl-a--c1'}), [])).rejects.toThrow(/invalid entry id/);
    await expect(queueCattleLogEntry(payload({id: 'cl-a--b'}), [])).rejects.toThrow(/invalid entry id/);
    await expect(queueCattleLogEntry(payload({id: null}), [])).rejects.toThrow(/payload\.id/);
  });

  it('rejects bodies over 4000 trimmed chars (server cap — replay could never succeed)', async () => {
    await expect(queueCattleLogEntry(payload({body: 'x'.repeat(4001)}), [])).rejects.toThrow(/at most 4000 characters/);
    // Trim happens before the cap, and exactly 4000 trimmed chars queues.
    const record = await queueCattleLogEntry(payload({body: '  ' + 'x'.repeat(4000) + '  '}), []);
    expect(record.status).toBe('queued');
  });

  it('keeps the IMAGE name forced to .jpg in the deterministic key', async () => {
    await queueCattleLogEntry(payload(), [imageFile('cow.HEIC.png')]);
    const blobs = await listPhotoBlobsByCsid(ENTRY_ID);
    expect(blobs[0].key).toBe(`cattle.log/cattle-log/${ENTRY_ID}/0-cow.HEIC.jpg`);
  });
});

// ── replayCattleLogQueue ────────────────────────────────────────────────────

describe('replayCattleLogQueue', () => {
  it('uploads every blob, submits the RPC, and clears the row + blobs on success', async () => {
    await queueCattleLogEntry(payload({mentions: ['11111111-1111-1111-1111-111111111111']}), [imageFile(), docFile()]);
    const {sb, uploadMock, rpcMock, fromMock} = makeSb();

    const results = await replay(sb);

    expect(results).toEqual([{id: ENTRY_ID, state: 'synced', data: {id: 'cl-x', replayed: false}}]);
    expect(fromMock).toHaveBeenCalledWith('comment-photos');
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(uploadMock.mock.calls[0][0]).toBe(KEY_0);
    expect(uploadMock.mock.calls[0][2]).toEqual({contentType: 'image/jpeg', upsert: false});
    expect(uploadMock.mock.calls[1][0]).toBe(KEY_1);

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [rpcName, args] = rpcMock.mock.calls[0];
    expect(rpcName).toBe(CATTLE_LOG_SUBMIT_RPC);
    expect(args.p_id).toBe(ENTRY_ID);
    expect(args.p_body).toMatch(/#123/);
    expect(args.p_mentions).toEqual(['11111111-1111-1111-1111-111111111111']);
    expect(args.p_is_issue).toBe(true);
    expect(args.p_calf_notes).toEqual({});
    expect(args.p_attachments).toEqual([
      {path: KEY_0, name: 'photo one.jpg', mime: 'image/jpeg', is_image: true, captured_at: expect.any(String)},
      {path: KEY_1, name: 'notes.pdf', mime: 'application/pdf', is_image: false, captured_at: expect.any(String)},
    ]);

    expect(await getSubmission(ENTRY_ID)).toBeNull();
    expect(await listPhotoBlobsByCsid(ENTRY_ID)).toEqual([]);
  });

  it('treats a duplicate-object upload error as success', async () => {
    await queueCattleLogEntry(payload(), [imageFile()]);
    const {sb, rpcMock} = makeSb({
      upload: async () => ({data: null, error: {message: 'The resource already exists', statusCode: '409'}}),
    });

    const results = await replay(sb);

    expect(results[0].state).toBe('synced');
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(await getSubmission(ENTRY_ID)).toBeNull();
  });

  it('partial replay: a failed upload stays queued with the finished path persisted; retry skips it', async () => {
    await queueCattleLogEntry(payload(), [imageFile(), docFile()]);
    const {sb, uploadMock, rpcMock} = makeSb({
      upload: async (path) =>
        path === KEY_1 ? {data: null, error: new TypeError('Failed to fetch')} : {data: {path}, error: null},
    });

    const first = await replay(sb);
    expect(first).toEqual([{id: ENTRY_ID, state: 'queued', errorClass: 'transient', errorMessage: 'Failed to fetch'}]);
    expect(rpcMock).not.toHaveBeenCalled();

    const row = await getSubmission(ENTRY_ID);
    expect(row.status).toBe('queued');
    expect(row.uploadedPaths).toEqual([KEY_0]);
    expect(row.errorClass).toBe('transient');

    // Network back: only the unfinished upload is re-sent.
    uploadMock.mockImplementation(async (path) => ({data: {path}, error: null}));
    uploadMock.mockClear();
    const second = await replay(sb);

    expect(second[0].state).toBe('synced');
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(uploadMock.mock.calls[0][0]).toBe(KEY_1);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(await getSubmission(ENTRY_ID)).toBeNull();
  });

  it('uploads done + transient RPC failure stays queued; the next replay skips ALL uploads', async () => {
    await queueCattleLogEntry(payload(), [imageFile(), docFile()]);
    const {sb, uploadMock, rpcMock} = makeSb({
      rpc: async () => ({data: null, error: {message: 'TypeError: Failed to fetch'}}),
    });

    const first = await replay(sb);
    expect(first[0]).toMatchObject({state: 'queued', errorClass: 'transient'});

    const row = await getSubmission(ENTRY_ID);
    expect(row.status).toBe('queued');
    expect(row.uploadedPaths).toEqual([KEY_0, KEY_1]);
    // Blobs are retained until the entry actually syncs.
    expect((await listPhotoBlobsByCsid(ENTRY_ID)).length).toBe(2);

    rpcMock.mockImplementation(async () => ({data: {id: ENTRY_ID, replayed: false}, error: null}));
    uploadMock.mockClear();
    const second = await replay(sb);

    expect(second[0].state).toBe('synced');
    expect(uploadMock).not.toHaveBeenCalled();
    expect(await getSubmission(ENTRY_ID)).toBeNull();
    expect(await listPhotoBlobsByCsid(ENTRY_ID)).toEqual([]);
  });

  it('ambiguous tag goes needs_attention and is NOT replayed until operator retry', async () => {
    await queueCattleLogEntry(payload(), []);
    const {sb, rpcMock} = makeSb({
      rpc: async () => ({data: null, error: {message: 'CATTLE_LOG_AMBIGUOUS_TAG: 123'}}),
    });

    const results = await replay(sb);
    expect(results).toEqual([
      {
        id: ENTRY_ID,
        state: 'needs_attention',
        errorClass: 'ambiguous_tag',
        errorMessage: 'CATTLE_LOG_AMBIGUOUS_TAG: 123',
      },
    ]);
    const row = await getSubmission(ENTRY_ID);
    expect(row.status).toBe('needs_attention');
    expect(row.errorClass).toBe('ambiguous_tag');
    expect(await listQueued(CATTLE_LOG_FORM_KIND)).toEqual([]);

    // A background pass leaves it alone.
    rpcMock.mockClear();
    expect(await replay(sb)).toEqual([]);
    expect(rpcMock).not.toHaveBeenCalled();

    // Operator retry re-queues it; the next pass picks it up again.
    await setCattleLogOutcome(ENTRY_ID, {status: 'queued'});
    rpcMock.mockImplementation(async () => ({data: {id: ENTRY_ID, replayed: false}, error: null}));
    const after = await replay(sb);
    expect(after[0].state).toBe('synced');
    expect(await getSubmission(ENTRY_ID)).toBeNull();
  });

  it('mention_invalid and validation errors also go needs_attention (never dropped)', async () => {
    await queueCattleLogEntry(payload(), []);
    const {sb} = makeSb({
      rpc: async () => ({data: null, error: {message: 'CATTLE_LOG_MENTION_INVALID: inactive profile'}}),
    });
    const results = await replay(sb);
    expect(results[0]).toMatchObject({state: 'needs_attention', errorClass: 'mention_invalid'});
    expect((await getSubmission(ENTRY_ID)).status).toBe('needs_attention');
  });

  it('missing attachment bytes goes needs_attention as validation (deterministic, no retry loop)', async () => {
    await queueCattleLogEntry(payload(), [imageFile()]);
    await deletePhotoBlobsByCsid(ENTRY_ID); // simulate evicted IDB bytes
    const {sb, uploadMock, rpcMock} = makeSb();

    const results = await replay(sb);

    expect(results[0]).toMatchObject({state: 'needs_attention', errorClass: 'validation'});
    expect(uploadMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
    expect((await getSubmission(ENTRY_ID)).errorMessage).toMatch(/attachment bytes missing/);
  });

  it('double replay is idempotent: a synced entry is gone, and {replayed:true} counts as success', async () => {
    await queueCattleLogEntry(payload(), []);
    const {sb, rpcMock} = makeSb({
      rpc: async () => ({data: {id: ENTRY_ID, replayed: true}, error: null}),
    });

    const first = await replay(sb);
    expect(first[0].state).toBe('synced');
    expect(first[0].data).toEqual({id: ENTRY_ID, replayed: true});

    const second = await replay(sb);
    expect(second).toEqual([]);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('replays oldest-first and routes each record independently', async () => {
    await queueCattleLogEntry(payload({id: 'cl-old-1', body: 'older entry body'}), []);
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at for the oldest-first sort
    await queueCattleLogEntry(payload({id: 'cl-new-2', body: 'newer entry body'}), []);
    const {sb} = makeSb({
      rpc: async (_name, args) =>
        args.p_id === 'cl-old-1'
          ? {data: null, error: {message: 'CATTLE_LOG_AMBIGUOUS_TAG: 7'}}
          : {data: {id: args.p_id, replayed: false}, error: null},
    });

    const results = await replay(sb);
    expect(results.map((r) => [r.id, r.state])).toEqual([
      ['cl-old-1', 'needs_attention'],
      ['cl-new-2', 'synced'],
    ]);
    expect((await getSubmission('cl-old-1')).status).toBe('needs_attention');
    expect(await getSubmission('cl-new-2')).toBeNull();
  });
});

// ── Queue listing for the page ──────────────────────────────────────────────

describe('listCattleLogQueue / toCattleLogQueueRecord', () => {
  it('returns contract-shaped records newest-first and maps syncing → queued', async () => {
    await queueCattleLogEntry(payload({id: 'cl-a-1', body: 'first body'}), []);
    await new Promise((r) => setTimeout(r, 5));
    await queueCattleLogEntry(payload({id: 'cl-b-2', body: 'second body'}), []);

    const list = await listCattleLogQueue();
    expect(list.map((e) => e.id)).toEqual(['cl-b-2', 'cl-a-1']);
    expect(list[0]).toMatchObject({form: CATTLE_LOG_FORM_KIND, status: 'queued', uploadedPaths: []});

    expect(toCattleLogQueueRecord({csid: 'x', status: 'syncing', created_at: 1})).toMatchObject({
      id: 'x',
      status: 'queued',
    });
    expect(toCattleLogQueueRecord(null)).toBeNull();
  });
});
