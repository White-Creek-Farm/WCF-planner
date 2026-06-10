import React from 'react';
import {
  listComments,
  countComments,
  postComment,
  editComment,
  deleteComment,
  listCommentEdits,
  loadMentionableProfiles,
  COMMENT_CHANGE_EVENT,
} from '../lib/commentsApi.js';
import {renderMentionSegments} from '../lib/activityApi.js';
import {uploadCommentAttachment, getAttachmentSignedUrl, MAX_COMMENT_ATTACHMENTS} from '../lib/commentAttachments.js';
import {imageAltText} from '../lib/imageAlt.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import MentionTextarea from './MentionTextarea.jsx';

const SECTION = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 10,
  padding: 14,
  fontFamily: 'inherit',
};
const HEADER = {
  fontSize: 14,
  fontWeight: 700,
  color: '#111827',
  marginBottom: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
const COUNT_BADGE = {
  fontSize: 11,
  fontWeight: 600,
  color: '#6b7280',
  background: '#f3f4f6',
  borderRadius: 999,
  padding: '1px 7px',
};
const POST_BTN = {
  padding: '10px 16px',
  borderRadius: 6,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};
const POST_BTN_DISABLED = {
  ...POST_BTN,
  background: '#9ca3af',
  borderColor: '#9ca3af',
  cursor: 'not-allowed',
};
const COMMENT_ROW = {
  padding: '10px 0',
  borderBottom: '1px solid #f3f4f6',
};
const COMMENT_HEAD = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  fontSize: 12,
  color: '#6b7280',
  flexWrap: 'wrap',
};
const AUTHOR = {
  fontSize: 13,
  fontWeight: 700,
  color: '#111827',
};
const BODY = {
  fontSize: 13,
  color: '#111827',
  marginTop: 4,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.45,
};
const MENTION_CHIP = {
  display: 'inline-block',
  padding: '0 4px',
  borderRadius: 4,
  background: '#fef3c7',
  color: '#92400e',
  fontWeight: 600,
};
const DELETED_PLACEHOLDER = {
  padding: '8px 0',
  borderBottom: '1px solid #f3f4f6',
  fontSize: 13,
  color: '#9ca3af',
  fontStyle: 'italic',
};
const LINK_BTN = {
  background: 'none',
  border: 'none',
  color: '#6b7280',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
  padding: 0,
  textDecoration: 'underline',
};
const ACTION_BTN = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11,
  fontFamily: 'inherit',
  padding: 0,
};
const EDIT_HISTORY = {
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 6,
  padding: 10,
  marginTop: 6,
  fontSize: 12,
  maxHeight: 200,
  overflowY: 'auto',
};

function fmtRelative(iso) {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleString();
  } catch (_e) {
    return iso || '';
  }
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function renderCommentBody(body, mentions, mentionedProfileNames) {
  if (!body) return null;
  const mentionNames = mentionedProfileNames || (mentions || []).map(() => '');
  const mentionIds = mentions || [];
  const segs = renderMentionSegments(body, mentionNames, mentionIds);
  const result = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.type === 'mention') {
      result.push(
        <span key={i} style={MENTION_CHIP}>
          @{s.display}
        </span>,
      );
    } else {
      const parts = (s.text || '').split(URL_RE);
      for (let j = 0; j < parts.length; j++) {
        if (URL_RE.test(parts[j])) {
          URL_RE.lastIndex = 0;
          result.push(
            <a key={`${i}-${j}`} href={parts[j]} target="_blank" rel="noopener noreferrer" style={{color: '#2563eb'}}>
              {parts[j]}
            </a>,
          );
        } else {
          result.push(<span key={`${i}-${j}`}>{parts[j]}</span>);
        }
      }
    }
  }
  return result;
}

export default function CommentsSection({sb, authState, entityType, entityId, entityLabel}) {
  const callerProfileId = authState && authState.user ? authState.user.id : null;
  const callerRole = authState?.role;
  const isAdmin = callerRole === 'admin';

  const [comments, setComments] = React.useState([]);
  const [count, setCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [posting, setPosting] = React.useState(false);
  const [draft, setDraft] = React.useState({body: '', mentions: []});
  const [notice, setNotice] = React.useState(null);
  const [editingId, setEditingId] = React.useState(null);
  const [editDraft, setEditDraft] = React.useState({body: '', mentions: []});
  const [editHistoryId, setEditHistoryId] = React.useState(null);
  const [editHistory, setEditHistory] = React.useState([]);
  const [expandDeletedId, setExpandDeletedId] = React.useState(null);
  const [draftFiles, setDraftFiles] = React.useState([]);
  const [editFiles, setEditFiles] = React.useState([]);
  const [signedUrls, setSignedUrls] = React.useState({});
  const fileInputRef = React.useRef(null);

  const mentionLoader = React.useCallback(
    async (s) => {
      const profiles = await loadMentionableProfiles(s);
      return profiles.filter((p) => p.id !== callerProfileId);
    },
    [callerProfileId],
  );

  const refresh = React.useCallback(async () => {
    if (!sb || !entityType || !entityId) return;
    setLoading(true);
    try {
      const rows = await listComments(sb, entityType, entityId, {limit: 100});
      setComments(rows);
      setCount(rows.filter((c) => !c.deleted_at).length);
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('CommentsSection: load failed', e?.message || e);
    } finally {
      setLoading(false);
    }
  }, [sb, entityType, entityId]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  React.useEffect(() => {
    function onCommentChange() {
      refresh();
    }
    window.addEventListener(COMMENT_CHANGE_EVENT, onCommentChange);
    return () => window.removeEventListener(COMMENT_CHANGE_EVENT, onCommentChange);
  }, [refresh]);

  async function onPost() {
    if (!draft.body.trim() || posting) return;
    setPosting(true);
    setNotice(null);
    try {
      const attachments = [];
      for (let i = 0; i < draftFiles.length; i++) {
        const meta = await uploadCommentAttachment(
          sb,
          entityType,
          entityId,
          'cmt-' + Date.now() + '-' + (i + 1),
          draftFiles[i],
        );
        attachments.push(meta);
      }
      await postComment(sb, {
        entityType,
        entityId,
        body: draft.body,
        entityLabel: entityLabel || entityId,
        mentions: draft.mentions,
        attachments,
      });
      setDraft({body: '', mentions: []});
      setDraftFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await refresh();
    } catch (e) {
      setNotice('Could not post. ' + (e?.message || ''));
    } finally {
      setPosting(false);
    }
  }

  function startEdit(c) {
    setEditingId(c.id);
    setEditDraft({body: c.body, mentions: c.mentions || [], attachments: c.attachments || []});
    setEditFiles([]);
  }

  async function saveEdit() {
    if (!editDraft.body.trim()) return;
    try {
      const existingAtts = editDraft.attachments || [];
      const newAtts = [];
      for (let i = 0; i < editFiles.length; i++) {
        if (existingAtts.length + newAtts.length >= MAX_COMMENT_ATTACHMENTS) break;
        const meta = await uploadCommentAttachment(
          sb,
          entityType,
          entityId,
          'cmt-edit-' + Date.now() + '-' + (i + 1),
          editFiles[i],
        );
        newAtts.push(meta);
      }
      await editComment(sb, {
        commentId: editingId,
        body: editDraft.body,
        mentions: editDraft.mentions,
        attachments: [...existingAtts, ...newAtts],
      });
      setEditingId(null);
      setEditFiles([]);
      await refresh();
    } catch (e) {
      setNotice('Could not save edit. ' + (e?.message || ''));
    }
  }

  async function onDelete(commentId) {
    try {
      await deleteComment(sb, commentId);
      await refresh();
    } catch (e) {
      setNotice('Could not delete. ' + (e?.message || ''));
    }
  }

  async function toggleEditHistory(commentId) {
    if (editHistoryId === commentId) {
      setEditHistoryId(null);
      return;
    }
    try {
      const edits = await listCommentEdits(sb, commentId);
      setEditHistory(edits);
      setEditHistoryId(commentId);
    } catch (_e) {
      setEditHistoryId(null);
    }
  }

  if (!entityType || !entityId) return null;

  return (
    <div
      data-comments-section="1"
      data-comments-entity-type={entityType}
      data-comments-entity-id={entityId}
      style={SECTION}
    >
      <div style={HEADER}>
        <span>Comments</span>
        <span style={COUNT_BADGE}>{count}</span>
      </div>

      {notice && (
        <div
          style={{
            background: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            color: '#b91c1c',
            marginBottom: 8,
          }}
        >
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            style={{...ACTION_BTN, color: '#b91c1c', marginLeft: 8}}
          >
            ×
          </button>
        </div>
      )}

      <div data-comments-compose="1" style={{marginBottom: 12}}>
        <MentionTextarea
          sb={sb}
          value={draft.body}
          mentions={draft.mentions}
          onChange={(next) => setDraft(next)}
          placeholder="Add a comment, or @ to mention…"
          disabled={posting}
          loadProfiles={mentionLoader}
        />
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6, gap: 8}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6b7280'}}>
            <label style={{cursor: 'pointer', color: '#2563eb', fontSize: 12}}>
              📎 Attach
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
                multiple
                style={{display: 'none'}}
                onChange={(e) => {
                  const files = Array.from(e.target.files || []).slice(0, MAX_COMMENT_ATTACHMENTS);
                  setDraftFiles(files);
                }}
              />
            </label>
            {draftFiles.length > 0 && (
              <span>
                {draftFiles.length} photo{draftFiles.length > 1 ? 's' : ''} selected
              </span>
            )}
          </div>
          <button
            type="button"
            data-comments-post-button="1"
            onClick={onPost}
            disabled={posting || !draft.body.trim()}
            style={posting || !draft.body.trim() ? POST_BTN_DISABLED : POST_BTN}
          >
            {posting ? 'Posting…' : 'Post'}
          </button>
        </div>
      </div>

      <div data-comments-list="1">
        {loading && comments.length === 0 && (
          <div style={{fontSize: 12, color: '#6b7280', padding: '8px 0'}}>Loading…</div>
        )}
        {!loading && comments.length === 0 && (
          <div data-comments-empty="1" style={{fontSize: 13, color: '#6b7280', padding: '8px 0'}}>
            No comments yet.
          </div>
        )}
        {comments.map((c) => {
          const isDeleted = !!c.deleted_at;
          const isAuthor = c.author_profile_id === callerProfileId;
          const isEditing = editingId === c.id;

          if (isDeleted && !isAdmin) {
            return (
              <div
                key={c.id}
                id={'comment-' + c.id}
                data-comment-id={c.id}
                data-comment-deleted="1"
                style={DELETED_PLACEHOLDER}
              >
                (Comment deleted)
              </div>
            );
          }

          if (isDeleted && isAdmin) {
            const expanded = expandDeletedId === c.id;
            return (
              <div
                key={c.id}
                id={'comment-' + c.id}
                data-comment-id={c.id}
                data-comment-deleted="1"
                style={DELETED_PLACEHOLDER}
              >
                (Comment deleted)
                <button
                  type="button"
                  onClick={() => setExpandDeletedId(expanded ? null : c.id)}
                  style={{...LINK_BTN, marginLeft: 8}}
                >
                  {expanded ? 'hide' : 'view'}
                </button>
                {expanded && (
                  <div style={{marginTop: 6, color: '#6b7280', fontStyle: 'normal'}}>
                    <div style={{fontSize: 11, marginBottom: 2}}>
                      by {c.author_display_name || 'Unknown'} · deleted {fmtRelative(c.deleted_at)}
                    </div>
                    <div style={{...BODY, color: '#6b7280'}}>{c.body}</div>
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={c.id} id={'comment-' + c.id} data-comment-id={c.id} data-comment-deleted="0" style={COMMENT_ROW}>
              <div style={COMMENT_HEAD}>
                <span style={AUTHOR}>{c.redacted ? '(redacted)' : c.author_display_name || 'Unknown user'}</span>
                <span>· {fmtRelative(c.created_at)}</span>
                {c.edited_at && (
                  <button type="button" onClick={() => toggleEditHistory(c.id)} style={LINK_BTN}>
                    edited
                  </button>
                )}
                {!isDeleted && isAuthor && !isEditing && (
                  <>
                    <button type="button" onClick={() => startEdit(c)} style={{...ACTION_BTN, color: '#2563eb'}}>
                      Edit
                    </button>
                    <button type="button" onClick={() => onDelete(c.id)} style={{...ACTION_BTN, color: '#b91c1c'}}>
                      Delete
                    </button>
                  </>
                )}
                {!isDeleted && isAdmin && !isAuthor && (
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    style={{...ACTION_BTN, color: '#b91c1c', marginLeft: 'auto'}}
                  >
                    Delete
                  </button>
                )}
              </div>

              {isEditing ? (
                <div style={{marginTop: 6}}>
                  <MentionTextarea
                    sb={sb}
                    value={editDraft.body}
                    mentions={editDraft.mentions}
                    onChange={(next) => setEditDraft((prev) => ({...prev, body: next.body, mentions: next.mentions}))}
                    placeholder="Edit comment…"
                    loadProfiles={mentionLoader}
                  />
                  {Array.isArray(editDraft.attachments) && editDraft.attachments.length > 0 && (
                    <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6}}>
                      {editDraft.attachments.map((att, ai) => (
                        <span
                          key={ai}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '2px 8px',
                            borderRadius: 6,
                            border: '1px solid #e5e7eb',
                            background: '#f3f4f6',
                            fontSize: 11,
                          }}
                        >
                          {att.is_image ? '📷' : '📄'} {att.name || 'file'}
                          <button
                            type="button"
                            onClick={() =>
                              setEditDraft((prev) => ({
                                ...prev,
                                attachments: prev.attachments.filter((_, i) => i !== ai),
                              }))
                            }
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#b91c1c',
                              cursor: 'pointer',
                              fontSize: 11,
                              padding: 0,
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{display: 'flex', gap: 6, marginTop: 6, alignItems: 'center'}}>
                    <button type="button" onClick={saveEdit} style={POST_BTN}>
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      style={{...POST_BTN, background: 'white', color: '#374151', borderColor: '#d1d5db'}}
                    >
                      Cancel
                    </button>
                    <label style={{cursor: 'pointer', color: '#2563eb', fontSize: 12, marginLeft: 'auto'}}>
                      📎 Add
                      <input
                        type="file"
                        accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
                        multiple
                        style={{display: 'none'}}
                        onChange={(e) =>
                          setEditFiles(Array.from(e.target.files || []).slice(0, MAX_COMMENT_ATTACHMENTS))
                        }
                      />
                    </label>
                    {editFiles.length > 0 && (
                      <span style={{fontSize: 11, color: '#6b7280'}}>
                        {editFiles.length} new file{editFiles.length > 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <div style={BODY}>{renderCommentBody(c.body, c.mentions, c.mentioned_profile_names)}</div>
                  {Array.isArray(c.attachments) && c.attachments.length > 0 && (
                    <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6}}>
                      {c.attachments.map((att, ai) => (
                        <CommentAttachmentThumb
                          key={ai}
                          sb={sb}
                          att={att}
                          signedUrls={signedUrls}
                          setSignedUrls={setSignedUrls}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {editHistoryId === c.id && editHistory.length > 0 && (
                <div style={EDIT_HISTORY}>
                  <div style={{fontWeight: 600, marginBottom: 4, fontSize: 11, color: '#374151'}}>Edit history</div>
                  {editHistory.map((e) => (
                    <div key={e.id} style={{padding: '4px 0', borderBottom: '1px solid #e5e7eb'}}>
                      <div style={{fontSize: 11, color: '#6b7280'}}>
                        {e.editor_display_name || 'Unknown'} · {fmtRelative(e.edited_at)}
                      </div>
                      <div style={{fontSize: 12, color: '#374151', whiteSpace: 'pre-wrap', marginTop: 2}}>
                        {e.previous_body}
                      </div>
                      {Array.isArray(e.previous_attachments) && e.previous_attachments.length > 0 && (
                        <div style={{fontSize: 11, color: '#6b7280', marginTop: 2}}>
                          Attachments: {e.previous_attachments.map((a) => a.name || 'file').join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CommentAttachmentThumb({sb, att, signedUrls, setSignedUrls}) {
  const [url, setUrl] = React.useState(signedUrls[att.path] || null);
  const isImage = att.is_image || /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(att.path || '');

  React.useEffect(() => {
    if (url || !att.path) return;
    let cancelled = false;
    getAttachmentSignedUrl(sb, att.path, 600).then((signed) => {
      if (cancelled || !signed) return;
      setUrl(signed);
      setSignedUrls((prev) => ({...prev, [att.path]: signed}));
    });
    return () => {
      cancelled = true;
    };
  }, [att.path]);

  if (!isImage) {
    return (
      <a
        href={url || '#'}
        target="_blank"
        rel="noopener noreferrer"
        data-comment-attachment={att.path}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          borderRadius: 6,
          border: '1px solid #e5e7eb',
          background: '#f3f4f6',
          fontSize: 11,
          color: '#2563eb',
          textDecoration: 'none',
        }}
      >
        📄 {att.name || 'document'}
      </a>
    );
  }

  return (
    <a
      href={url || '#'}
      target="_blank"
      rel="noopener noreferrer"
      data-comment-attachment={att.path}
      style={{
        display: 'block',
        width: 60,
        height: 60,
        borderRadius: 6,
        overflow: 'hidden',
        border: '1px solid #e5e7eb',
        background: '#f3f4f6',
        flexShrink: 0,
      }}
    >
      {url ? (
        <img
          src={url}
          alt={imageAltText(att.name, {fallback: 'Comment attachment image'})}
          style={{width: '100%', height: '100%', objectFit: 'cover'}}
        />
      ) : (
        <span
          style={{
            fontSize: 10,
            color: '#9ca3af',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
          }}
        >
          📷
        </span>
      )}
    </a>
  );
}
