// Unit tests for the conversation-fidelity mapping layer: html_text inline
// attachment refs, the per-task conversation plan (classification, idempotent
// baselines, explicit ambiguity), and the RPC row mapper. Fixtures mirror the
// live Asana payload shapes (redacted): comment stories with/without inline
// attachment anchors, attachment_added system stories, and raw attachments.
import {describe, expect, it} from 'vitest';
import {
  parseHtmlTextAttachmentGids,
  buildConversationPlan,
  conversationItemToCommentMediaRow,
} from '../supabase/functions/_shared/processingAsanaShape.js';

const pathFor = (gid, filename) => `1211760432273073/${gid}-${filename}`;

// B-26-04-shaped fixture: one Ronnie text comment (already imported), two
// Brian Naide file-only JPG posts (comment stories whose html_text carries the
// inline attachment ref and whose plain text is empty).
const B2604_STORIES = [
  {
    gid: '1213168591204606',
    type: 'comment',
    resource_subtype: 'comment_added',
    text: 'https://app.asana.com/1/272582742612016/profile/273134884526',
    html_text: '<body><a data-asana-gid="273134884526" data-asana-type="user">@Brian</a></body>',
    created_at: '2026-02-07T14:48:22.831Z',
    created_by: {gid: '273134884526001', name: 'Ronnie Jones'},
  },
  {
    gid: 'story-jpg-1',
    type: 'comment',
    resource_subtype: 'comment_added',
    text: '',
    html_text:
      '<body><a data-asana-gid="att-jpg-1" data-asana-type="attachment" data-asana-ref="x">kill-sheet-1.jpg</a></body>',
    created_at: '2026-07-08T15:01:00.000Z',
    created_by: {gid: 'brian-gid', name: 'Brian Naide'},
  },
  {
    gid: 'story-jpg-2',
    type: 'comment',
    resource_subtype: 'comment_added',
    text: '',
    html_text: '<body><a data-asana-type="attachment" data-asana-gid="att-jpg-2">kill-sheet-2.jpg</a></body>',
    created_at: '2026-07-08T15:02:00.000Z',
    created_by: {gid: 'brian-gid', name: 'Brian Naide'},
  },
  // System stories Asana adds alongside media posts — must not double-claim.
  {
    gid: 'sys-att-1',
    type: 'system',
    resource_subtype: 'attachment_added',
    text: 'attached kill-sheet-1.jpg',
    created_at: '2026-07-08T15:01:00.000Z',
    created_by: {gid: 'brian-gid', name: 'Brian Naide'},
  },
];
const B2604_ATTACHMENTS = [
  {
    gid: 'att-jpg-1',
    name: 'kill-sheet-1.jpg',
    size: 240001,
    created_at: '2026-07-08T15:01:00.000Z',
    download_url: 'https://x/1',
  },
  {
    gid: 'att-jpg-2',
    name: 'kill-sheet-2.jpg',
    size: 250002,
    created_at: '2026-07-08T15:02:00.000Z',
    download_url: 'https://x/2',
  },
];

describe('parseHtmlTextAttachmentGids', () => {
  it('extracts only attachment-typed anchors, tolerating attribute order, de-duplicated', () => {
    const html =
      '<body>look <a data-asana-gid="111" data-asana-type="attachment">a.jpg</a>' +
      '<a data-asana-type="attachment" data-asana-gid="222">b.pdf</a>' +
      '<a data-asana-gid="111" data-asana-type="attachment">a again</a>' +
      '<a data-asana-gid="999" data-asana-type="user">@user</a></body>';
    expect(parseHtmlTextAttachmentGids(html)).toEqual(['111', '222']);
  });
  it('handles empty/absent html', () => {
    expect(parseHtmlTextAttachmentGids(null)).toEqual([]);
    expect(parseHtmlTextAttachmentGids('plain text')).toEqual([]);
  });
});

describe('buildConversationPlan — B-26-04 acceptance shape', () => {
  it('classifies the Ronnie text comment + the two Brian file-only JPG posts exactly', () => {
    const plan = buildConversationPlan({
      stories: B2604_STORIES,
      attachments: B2604_ATTACHMENTS,
      importedCommentGids: ['1213168591204606'], // Ronnie already imported
      storedAttachmentGids: [],
    });
    expect(plan.counts).toEqual({
      textComments: 1,
      mediaComments: 0,
      fileOnlyPosts: 2,
      taskAttachments: 0,
      alreadyImported: 1,
      missingComments: 2,
      newMediaBytes: 2,
      ambiguous: 0,
    });
    const posts = plan.items.filter((i) => i.kind === 'file_only_post');
    expect(posts.map((p) => p.author)).toEqual(['Brian Naide', 'Brian Naide']);
    expect(posts.map((p) => p.created_at)).toEqual(['2026-07-08T15:01:00.000Z', '2026-07-08T15:02:00.000Z']);
    expect(posts.map((p) => p.attachmentGids)).toEqual([['att-jpg-1'], ['att-jpg-2']]);
    expect(posts.every((p) => p.association === 'html_ref')).toBe(true);
    expect(posts.every((p) => !p.alreadyImportedComment)).toBe(true);
  });

  it('is idempotent: after import, the same payload reports zero actionable work', () => {
    const plan = buildConversationPlan({
      stories: B2604_STORIES,
      attachments: B2604_ATTACHMENTS,
      importedCommentGids: ['1213168591204606', 'story-jpg-1', 'story-jpg-2'],
      storedAttachmentGids: ['att-jpg-1', 'att-jpg-2'],
    });
    expect(plan.counts.missingComments).toBe(0);
    expect(plan.counts.newMediaBytes).toBe(0);
    expect(plan.counts.alreadyImported).toBe(3);
  });

  it('a comment with text AND media classifies media_comment', () => {
    const plan = buildConversationPlan({
      stories: [
        {
          gid: 's1',
          type: 'comment',
          text: 'here is the sheet',
          html_text: '<body>here is the sheet <a data-asana-gid="a1" data-asana-type="attachment">f.pdf</a></body>',
          created_at: '2026-07-01T10:00:00Z',
          created_by: {gid: 'u1', name: 'Isabel Hermann'},
        },
      ],
      attachments: [{gid: 'a1', name: 'f.pdf', size: 100, created_at: '2026-07-01T10:00:00Z'}],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    expect(plan.counts.mediaComments).toBe(1);
    expect(plan.items[0].body).toBe('here is the sheet');
  });
});

describe('buildConversationPlan — association + ambiguity rules', () => {
  const bareAttachment = {gid: 'a9', name: 'photo.png', size: 5, created_at: '2026-07-02T09:00:00Z'};

  it('an unreferenced attachment with exactly ONE attachment_added story becomes a file-only post via attachment_story', () => {
    const plan = buildConversationPlan({
      stories: [
        {
          gid: 'sys1',
          type: 'system',
          resource_subtype: 'attachment_added',
          text: 'attached photo.png',
          created_at: '2026-07-02T09:00:00Z',
          created_by: {gid: 'u2', name: 'Brett Post'},
        },
      ],
      attachments: [bareAttachment],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    const post = plan.items.find((i) => i.kind === 'file_only_post');
    expect(post.association).toBe('attachment_story');
    expect(post.author).toBe('Brett Post');
    expect(plan.counts.ambiguous).toBe(0);
  });

  it('MULTIPLE matching attachment stories are reported ambiguous, never guessed by timestamp', () => {
    const plan = buildConversationPlan({
      stories: [
        {
          gid: 'sysA',
          type: 'system',
          resource_subtype: 'attachment_added',
          text: 'attached photo.png',
          created_at: '2026-07-02T09:00:00Z',
          created_by: {name: 'A'},
        },
        {
          gid: 'sysB',
          type: 'system',
          resource_subtype: 'attachment_added',
          text: 're-attached photo.png',
          created_at: '2026-07-02T09:05:00Z',
          created_by: {name: 'B'},
        },
      ],
      attachments: [bareAttachment],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    expect(plan.counts.ambiguous).toBe(1);
    expect(plan.ambiguous[0].attachmentGid).toBe('a9');
    expect(plan.ambiguous[0].storyGids).toEqual(['sysA', 'sysB']);
    // classified safely as a context-less task attachment
    expect(plan.counts.taskAttachments).toBe(1);
    expect(plan.counts.fileOnlyPosts).toBe(0);
  });

  it('the same attachment referenced by multiple comments is explicit ambiguity, never first-story-wins', () => {
    const plan = buildConversationPlan({
      stories: [
        {
          gid: 'comment-a',
          type: 'comment',
          text: '',
          html_text: '<a data-asana-type="attachment" data-asana-gid="a9">photo.png</a>',
        },
        {
          gid: 'comment-b',
          type: 'comment',
          text: '',
          html_text: '<a data-asana-type="attachment" data-asana-gid="a9">photo.png</a>',
        },
      ],
      attachments: [bareAttachment],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    expect(plan.counts.ambiguous).toBe(1);
    expect(plan.ambiguous[0].storyGids).toEqual(['comment-a', 'comment-b']);
    expect(plan.counts.mediaComments).toBe(0);
    expect(plan.counts.fileOnlyPosts).toBe(0);
    expect(plan.counts.taskAttachments).toBe(1);
  });

  it('one attachment story matching multiple same-name files is ambiguous, never duplicated into one comment gid', () => {
    const plan = buildConversationPlan({
      stories: [
        {
          gid: 'sys-one',
          type: 'system',
          resource_subtype: 'attachment_added',
          text: 'attached photo.png',
          created_by: {name: 'Brett Post'},
        },
      ],
      attachments: [bareAttachment, {...bareAttachment, gid: 'a10'}],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    expect(plan.counts.ambiguous).toBe(2);
    expect(plan.counts.fileOnlyPosts).toBe(0);
    expect(plan.counts.taskAttachments).toBe(2);
  });

  it('an attachment with NO story context is a task_attachment (attachments index only)', () => {
    const plan = buildConversationPlan({
      stories: [],
      attachments: [bareAttachment],
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    expect(plan.counts.taskAttachments).toBe(1);
    expect(plan.counts.missingComments).toBe(0);
  });
});

describe('conversationItemToCommentMediaRow', () => {
  it('builds the RPC row with stable paths, original author/timestamp, and empty body for file-only posts', () => {
    const plan = buildConversationPlan({
      stories: B2604_STORIES,
      attachments: B2604_ATTACHMENTS,
      importedCommentGids: [],
      storedAttachmentGids: [],
    });
    const post = plan.items.find((i) => i.storyGid === 'story-jpg-1');
    const attsByGid = new Map(B2604_ATTACHMENTS.map((a) => [a.gid, a]));
    const row = conversationItemToCommentMediaRow(post, '1211760432273073', attsByGid, pathFor, ['uuid-1']);
    expect(row).toEqual({
      parent_asana_gid: '1211760432273073',
      asana_comment_gid: 'story-jpg-1',
      body: '',
      original_author_name: 'Brian Naide',
      created_at: '2026-07-08T15:01:00.000Z',
      mentions: ['uuid-1'],
      attachments: [
        {
          asana_attachment_gid: 'att-jpg-1',
          filename: 'kill-sheet-1.jpg',
          content_type: null,
          size_bytes: 240001,
          storage_path: '1211760432273073/att-jpg-1-kill-sheet-1.jpg',
          original_created_at: '2026-07-08T15:01:00.000Z',
        },
      ],
    });
  });
});
