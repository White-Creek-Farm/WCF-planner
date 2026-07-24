import {describe, it, expect, vi} from 'vitest';
import {
  deleteProcessingAttachment,
  safeAttachmentFilename,
  renameProcessingAttachment,
  validateAttachmentDisplayName,
  isThumbnailableImage,
  getProcessingAttachmentThumbUrl,
  MAX_ATTACHMENT_FILENAME_LENGTH,
} from './processingAttachmentsApi.js';

// Mock Supabase client for the two-phase delete contract. `plan` keys:
//   request  — result of request_processing_attachment_delete
//   remove   — result of storage.remove
//   signed   — result of createSignedUrl (the empty-remove existence probe)
//   finalize — result of finalize_processing_attachment_delete
function mockSb(plan) {
  const calls = {rpc: [], remove: [], signed: []};
  return {
    calls,
    rpc: vi.fn(async (fn, args) => {
      calls.rpc.push([fn, args]);
      if (fn === 'request_processing_attachment_delete') return plan.request;
      if (fn === 'finalize_processing_attachment_delete')
        return plan.finalize ?? {data: {status: 'deleted'}, error: null};
      return {data: null, error: {message: `unexpected rpc ${fn}`}};
    }),
    storage: {
      from: () => ({
        remove: vi.fn(async (paths) => {
          calls.remove.push(paths);
          return plan.remove;
        }),
        createSignedUrl: vi.fn(async (p) => {
          calls.signed.push(p);
          return plan.signed ?? {data: null, error: {message: 'Object not found'}};
        }),
      }),
    },
  };
}

const REQ_OK = {data: {id: 'pat-1', status: 'requested', storage_path: 'native/rec-1/pat-1-a.pdf'}, error: null};

describe('deleteProcessingAttachment — two-phase truthful delete', () => {
  it('happy path: request → remove → finalize(ok=true)', async () => {
    const sb = mockSb({
      request: REQ_OK,
      remove: {data: [{name: 'native/rec-1/pat-1-a.pdf'}], error: null},
      finalize: {data: {id: 'pat-1', status: 'deleted'}, error: null},
    });
    const out = await deleteProcessingAttachment(sb, {attachmentId: 'pat-1'});
    expect(out.status).toBe('deleted');
    const finalize = sb.calls.rpc.find(([fn]) => fn === 'finalize_processing_attachment_delete');
    expect(finalize[1]).toMatchObject({p_id: 'pat-1', p_ok: true, p_error: null});
  });

  it('already-deleted replay short-circuits without touching Storage', async () => {
    const sb = mockSb({request: {data: {id: 'pat-1', status: 'already_deleted', replayed: true}, error: null}});
    const out = await deleteProcessingAttachment(sb, {attachmentId: 'pat-1'});
    expect(out.status).toBe('already_deleted');
    expect(sb.calls.remove).toHaveLength(0);
    expect(sb.calls.rpc.map(([fn]) => fn)).toEqual(['request_processing_attachment_delete']);
  });

  it('BLOCKED removal (empty result, object still readable) finalizes ok=false and throws', async () => {
    const sb = mockSb({
      request: REQ_OK,
      remove: {data: [], error: null}, // RLS silently skipped the object
      signed: {data: {signedUrl: 'https://x/signed'}, error: null}, // still there
      finalize: {data: {id: 'pat-1', status: 'reopened'}, error: null},
    });
    await expect(deleteProcessingAttachment(sb, {attachmentId: 'pat-1'})).rejects.toThrow(/Could not delete/);
    const finalize = sb.calls.rpc.find(([fn]) => fn === 'finalize_processing_attachment_delete');
    expect(finalize[1].p_ok).toBe(false);
    expect(finalize[1].p_error).toBeTruthy();
  });

  it('crashed earlier attempt (object already gone) converges to success on retry', async () => {
    const sb = mockSb({
      request: REQ_OK,
      remove: {data: [], error: null},
      signed: {data: null, error: {message: 'Object not found'}}, // gone
      finalize: {data: {id: 'pat-1', status: 'deleted'}, error: null},
    });
    const out = await deleteProcessingAttachment(sb, {attachmentId: 'pat-1'});
    expect(out.status).toBe('deleted');
    const finalize = sb.calls.rpc.find(([fn]) => fn === 'finalize_processing_attachment_delete');
    expect(finalize[1].p_ok).toBe(true);
  });

  it('storage error finalizes ok=false with the reason and throws', async () => {
    const sb = mockSb({
      request: REQ_OK,
      remove: {data: null, error: {message: 'network boom'}},
      signed: {data: {signedUrl: 'https://x/still-there'}, error: null},
      finalize: {data: {id: 'pat-1', status: 'reopened'}, error: null},
    });
    await expect(deleteProcessingAttachment(sb, {attachmentId: 'pat-1'})).rejects.toThrow(/network boom/);
    const finalize = sb.calls.rpc.find(([fn]) => fn === 'finalize_processing_attachment_delete');
    expect(finalize[1]).toMatchObject({p_ok: false, p_error: 'network boom'});
  });

  it('request RPC failure throws before any Storage call', async () => {
    const sb = mockSb({
      request: {data: null, error: {message: 'PROCESSING_VALIDATION: caller role farm_team cannot delete attachments'}},
    });
    await expect(deleteProcessingAttachment(sb, {attachmentId: 'pat-1'})).rejects.toThrow(/cannot delete attachments/);
    expect(sb.calls.remove).toHaveLength(0);
  });

  it('requires attachmentId', async () => {
    await expect(deleteProcessingAttachment(mockSb({}), {})).rejects.toThrow(/attachmentId required/);
  });
});

describe('safeAttachmentFilename (regression)', () => {
  it('strips path separators and control chars, caps length', () => {
    expect(safeAttachmentFilename('a/b\\c.pdf')).toBe('a_b_c.pdf');
    expect(safeAttachmentFilename('')).toBe('file');
    expect(safeAttachmentFilename('x'.repeat(200))).toHaveLength(120);
  });
});

// Control characters and the backslash are built with String.fromCharCode so
// this source file stays pure ASCII (no literal control bytes / escape churn).
const CTRL_SOH = String.fromCharCode(1);
const CTRL_LF = String.fromCharCode(10);
const CTRL_DEL = String.fromCharCode(127);
const BACKSLASH = String.fromCharCode(92);

describe('validateAttachmentDisplayName', () => {
  it('trims and returns a valid name (extension allowed)', () => {
    expect(validateAttachmentDisplayName('  Kill Sheet 2026.pdf  ')).toBe('Kill Sheet 2026.pdf');
  });
  it('rejects empty / whitespace-only', () => {
    expect(() => validateAttachmentDisplayName('')).toThrow(/Enter a file name/);
    expect(() => validateAttachmentDisplayName('   ')).toThrow(/Enter a file name/);
    expect(() => validateAttachmentDisplayName(null)).toThrow(/Enter a file name/);
  });
  it('rejects names longer than the cap and accepts exactly the cap', () => {
    expect(() => validateAttachmentDisplayName('a'.repeat(MAX_ATTACHMENT_FILENAME_LENGTH + 1))).toThrow(/or fewer/);
    expect(validateAttachmentDisplayName('a'.repeat(MAX_ATTACHMENT_FILENAME_LENGTH))).toHaveLength(
      MAX_ATTACHMENT_FILENAME_LENGTH,
    );
  });
  it('rejects path separators (/ and \\)', () => {
    expect(() => validateAttachmentDisplayName('a/b.pdf')).toThrow(/\/ or/);
    expect(() => validateAttachmentDisplayName('a' + BACKSLASH + 'b.pdf')).toThrow(/\/ or/);
  });
  it('rejects control characters (SOH, LF, DEL)', () => {
    expect(() => validateAttachmentDisplayName('a' + CTRL_SOH + 'b')).toThrow(/control characters/);
    expect(() => validateAttachmentDisplayName('a' + CTRL_LF + 'b')).toThrow(/control characters/);
    expect(() => validateAttachmentDisplayName('a' + CTRL_DEL + 'b')).toThrow(/control characters/);
  });
});

describe('isThumbnailableImage — trusted content_type, safe extension fallback', () => {
  it('supported raster content types → true', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      expect(isThumbnailableImage({content_type: t, filename: 'x'})).toBe(true);
    }
  });
  it('non-raster / unsupported declared image types → false (type is trusted)', () => {
    expect(isThumbnailableImage({content_type: 'image/svg+xml', filename: 'evil.png'})).toBe(false);
    expect(isThumbnailableImage({content_type: 'image/heic', filename: 'p.heic'})).toBe(false);
    expect(isThumbnailableImage({content_type: 'application/pdf', filename: 'p.png'})).toBe(false);
  });
  it('missing/generic content_type → extension fallback (older imported rows)', () => {
    expect(isThumbnailableImage({content_type: '', filename: 'photo.JPG'})).toBe(true);
    expect(isThumbnailableImage({content_type: null, filename: 'a.webp'})).toBe(true);
    expect(isThumbnailableImage({content_type: 'application/octet-stream', filename: 'b.png'})).toBe(true);
    expect(isThumbnailableImage({content_type: 'application/octet-stream', filename: 'invoice.pdf'})).toBe(false);
    expect(isThumbnailableImage({content_type: '', filename: 'noext'})).toBe(false);
  });
  it('null-safe', () => {
    expect(isThumbnailableImage(null)).toBe(false);
    expect(isThumbnailableImage(undefined)).toBe(false);
  });
});

describe('getProcessingAttachmentThumbUrl', () => {
  function signer(result) {
    const createSignedUrl = vi.fn(async () => result);
    return {createSignedUrl, sb: {storage: {from: () => ({createSignedUrl})}}};
  }
  it('returns the signed url; no transform option when omitted', async () => {
    const {createSignedUrl, sb} = signer({data: {signedUrl: 'https://x/s'}, error: null});
    const url = await getProcessingAttachmentThumbUrl(sb, 'native/r/p-1.png');
    expect(url).toBe('https://x/s');
    expect(createSignedUrl).toHaveBeenCalledWith('native/r/p-1.png', 600, undefined);
  });
  it('passes a transform option through when provided', async () => {
    const {createSignedUrl, sb} = signer({data: {signedUrl: 'https://x/t'}, error: null});
    await getProcessingAttachmentThumbUrl(sb, 'native/r/p-1.png', {expiresIn: 120, transform: {width: 88, height: 88}});
    expect(createSignedUrl).toHaveBeenCalledWith('native/r/p-1.png', 120, {transform: {width: 88, height: 88}});
  });
  it('returns null on signing error or missing path', async () => {
    const {sb} = signer({data: null, error: {message: 'nope'}});
    expect(await getProcessingAttachmentThumbUrl(sb, 'native/r/p-1.png')).toBeNull();
    expect(await getProcessingAttachmentThumbUrl(sb, '')).toBeNull();
  });
});

describe('renameProcessingAttachment', () => {
  function mockRpc(result) {
    const rpc = vi.fn(async () => result);
    return {rpc, sb: {rpc}};
  }
  it('validates locally then calls the RPC with the trimmed name', async () => {
    const {rpc, sb} = mockRpc({data: {id: 'pat-1', status: 'renamed'}, error: null});
    const out = await renameProcessingAttachment(sb, {attachmentId: 'pat-1', filename: '  New Name.pdf '});
    expect(out.status).toBe('renamed');
    expect(rpc).toHaveBeenCalledWith('rename_processing_attachment', {p_id: 'pat-1', p_filename: 'New Name.pdf'});
  });
  it('requires attachmentId', async () => {
    const {rpc, sb} = mockRpc({data: null, error: null});
    await expect(renameProcessingAttachment(sb, {filename: 'a.pdf'})).rejects.toThrow(/attachmentId required/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects an invalid name BEFORE any RPC round trip', async () => {
    const {rpc, sb} = mockRpc({data: null, error: null});
    await expect(renameProcessingAttachment(sb, {attachmentId: 'pat-1', filename: 'a/b.pdf'})).rejects.toThrow(/\/ or/);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('surfaces a server error message', async () => {
    const {sb} = mockRpc({data: null, error: {message: 'PROCESSING_VALIDATION: attachment has a pending delete'}});
    await expect(renameProcessingAttachment(sb, {attachmentId: 'pat-1', filename: 'ok.pdf'})).rejects.toThrow(
      /pending delete/,
    );
  });
});
