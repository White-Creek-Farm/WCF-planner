// Admin Monthly Newsletter workspace (/admin/newsletter, admin-only via the
// route-level UnauthorizedRedirect guard in main.jsx). One-pass editor over a
// single issue: structured block content, fact include/exclude + manual facts,
// the monthly Q&A intake, photo upload/approve/cover, preview link, and
// publish/unpublish. Every read/write goes through newsletterApi (the SECDEF
// RPCs); this view never touches the newsletter_* tables directly.
//
// Photo consent: uploads land in the PRIVATE staging bucket and show via a
// short-lived signed URL until the admin APPROVES, which copies bytes into the
// PUBLIC bucket. Only approved photos appear on the public page.

import React from 'react';
import {sb} from '../lib/supabase.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
import {NEWSLETTER_BLOCK_TYPES} from './NewsletterBlocks.jsx';
import {
  listNewsletterIssuesAdmin,
  getNewsletterIssueAdmin,
  createNewsletterIssue,
  saveNewsletterDraft,
  saveNewsletterIntake,
  setNewsletterFactIncluded,
  addNewsletterManualFact,
  registerNewsletterPhoto,
  updateNewsletterPhoto,
  setNewsletterCover,
  approveNewsletterPhoto,
  unapproveNewsletterPhoto,
  removeNewsletterPhoto,
  publishNewsletterIssue,
  unpublishNewsletterIssue,
  regenerateNewsletterPreviewToken,
  getNewsletterSettings,
  updateNewsletterSettings,
  uploadNewsletterStagingPhoto,
  getNewsletterStagingSignedUrl,
  newsletterPublicPhotoUrl,
  generateNewsletterPhotoToken,
  buildNewsletterIssuePath,
  buildNewsletterPreviewPath,
  formatYearMonth,
  currentYearMonth,
  friendlyNewsletterError,
} from '../lib/newsletterApi.js';
import './newsletterAdmin.css';

const {useState, useEffect, useCallback, useRef} = React;

// Fixed monthly intake questions (events the planner data may not capture).
const INTAKE_QUESTIONS = [
  {key: 'highlights', label: 'Standout moments this month (anything noteworthy the data might miss)?'},
  {key: 'milestones', label: 'Milestones or firsts (a new record, a finished project, a visit)?'},
  {key: 'people', label: 'People to recognize (first names are OK)?'},
  {key: 'photoIdeas', label: 'Photo ideas — what moments are worth showing?'},
  {key: 'avoid', label: 'Anything to keep OUT of this issue?'},
];

// Default skeleton for each block type the editor can add.
function defaultBlock(type) {
  switch (type) {
    case 'heading':
      return {type: 'heading', text: '', level: 2};
    case 'paragraph':
      return {type: 'paragraph', text: ''};
    case 'list':
      return {type: 'list', ordered: false, items: []};
    case 'stats':
      return {type: 'stats', items: []};
    case 'quote':
      return {type: 'quote', text: '', attribution: ''};
    case 'callout':
      return {type: 'callout', text: '', tone: 'good'};
    case 'photo':
      return {type: 'photo', photoId: ''};
    case 'gallery':
      return {type: 'gallery', photoIds: []};
    case 'divider':
      return {type: 'divider'};
    default:
      return {type: 'paragraph', text: ''};
  }
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StatusBadge({status}) {
  const cls = status === 'published' ? 'nla-badge nla-badge-pub' : 'nla-badge nla-badge-draft';
  return <span className={cls}>{status === 'published' ? 'Published' : 'Draft'}</span>;
}

// ── Block editor ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function BlockEditor({block, idx, count, approvedPhotos, onChange, onMove, onRemove}) {
  const set = (patch) => onChange(idx, {...block, ...patch});

  let fields = null;
  if (block.type === 'heading') {
    fields = (
      <div className="nla-row">
        <input
          className="nla-input"
          value={block.text || ''}
          placeholder="Heading text"
          onChange={(e) => set({text: e.target.value})}
        />
        <select className="nla-select" value={block.level || 2} onChange={(e) => set({level: Number(e.target.value)})}>
          <option value={2}>H2</option>
          <option value={3}>H3</option>
        </select>
      </div>
    );
  } else if (block.type === 'paragraph') {
    fields = (
      <textarea
        className="nla-textarea"
        rows={3}
        value={block.text || ''}
        placeholder="Paragraph text"
        onChange={(e) => set({text: e.target.value})}
      />
    );
  } else if (block.type === 'list') {
    fields = (
      <div>
        <label className="nla-check">
          <input type="checkbox" checked={!!block.ordered} onChange={(e) => set({ordered: e.target.checked})} />{' '}
          Numbered
        </label>
        <textarea
          className="nla-textarea"
          rows={4}
          value={(block.items || []).join('\n')}
          placeholder="One item per line"
          onChange={(e) =>
            set({
              items: e.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    );
  } else if (block.type === 'stats') {
    fields = (
      <textarea
        className="nla-textarea"
        rows={4}
        value={(block.items || []).map((it) => `${it.label || ''} | ${it.value || ''}`).join('\n')}
        placeholder="One per line:  Label | Value   (e.g.  Cattle on farm | 142)"
        onChange={(e) =>
          set({
            items: e.target.value
              .split('\n')
              .map((line) => {
                const [label, value] = line.split('|');
                return {label: (label || '').trim(), value: (value || '').trim()};
              })
              .filter((it) => it.value),
          })
        }
      />
    );
  } else if (block.type === 'quote') {
    fields = (
      <div>
        <textarea
          className="nla-textarea"
          rows={2}
          value={block.text || ''}
          placeholder="Quote"
          onChange={(e) => set({text: e.target.value})}
        />
        <input
          className="nla-input"
          value={block.attribution || ''}
          placeholder="Attribution (optional)"
          onChange={(e) => set({attribution: e.target.value})}
        />
      </div>
    );
  } else if (block.type === 'callout') {
    fields = (
      <div className="nla-row">
        <textarea
          className="nla-textarea"
          rows={2}
          value={block.text || ''}
          placeholder="Callout text"
          onChange={(e) => set({text: e.target.value})}
        />
        <select className="nla-select" value={block.tone || 'good'} onChange={(e) => set({tone: e.target.value})}>
          <option value="good">Good news</option>
          <option value="note">Note</option>
        </select>
      </div>
    );
  } else if (block.type === 'photo') {
    fields = (
      <select className="nla-select" value={block.photoId || ''} onChange={(e) => set({photoId: e.target.value})}>
        <option value="">— pick an approved photo —</option>
        {approvedPhotos.map((p) => (
          <option key={p.id} value={p.id}>
            {p.caption || p.altText || p.id}
          </option>
        ))}
      </select>
    );
  } else if (block.type === 'gallery') {
    fields = (
      <div className="nla-gallery-pick">
        {approvedPhotos.length === 0 && <span className="nla-muted">No approved photos yet.</span>}
        {approvedPhotos.map((p) => {
          const ids = block.photoIds || [];
          const on = ids.includes(p.id);
          return (
            <label key={p.id} className="nla-check">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => set({photoIds: e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)})}
              />{' '}
              {p.caption || p.altText || p.id}
            </label>
          );
        })}
      </div>
    );
  } else if (block.type === 'divider') {
    fields = <div className="nla-muted">Horizontal divider.</div>;
  }

  return (
    <div className="nla-block">
      <div className="nla-block-head">
        <span className="nla-block-type">{block.type}</span>
        <span className="nla-block-actions">
          <button
            type="button"
            className="nla-iconbtn"
            disabled={idx === 0}
            onClick={() => onMove(idx, -1)}
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className="nla-iconbtn"
            disabled={idx === count - 1}
            onClick={() => onMove(idx, 1)}
            title="Move down"
          >
            ↓
          </button>
          <button type="button" className="nla-iconbtn nla-danger" onClick={() => onRemove(idx)} title="Remove block">
            ✕
          </button>
        </span>
      </div>
      {fields}
    </div>
  );
}

// ── Photo card ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function PhotoCard({photo, thumbUrl, onApprove, onUnapprove, onCover, onRemove, onSaveMeta, busy}) {
  const [caption, setCaption] = useState(photo.caption || '');
  const [altText, setAltText] = useState(photo.altText || '');
  const [credit, setCredit] = useState(photo.creditFirstName || '');
  useEffect(() => {
    setCaption(photo.caption || '');
    setAltText(photo.altText || '');
    setCredit(photo.creditFirstName || '');
  }, [photo.id, photo.caption, photo.altText, photo.creditFirstName]);

  return (
    <div className="nla-photo-card">
      <div className="nla-photo-thumb">
        {thumbUrl ? <img src={thumbUrl} alt={altText || caption || 'photo'} /> : <span className="nla-muted">…</span>}
        <span className={`nla-badge ${photo.approved ? 'nla-badge-pub' : 'nla-badge-draft'}`}>
          {photo.approved ? 'Approved' : 'Staged'}
        </span>
        {photo.isCover && <span className="nla-badge nla-badge-cover">Cover</span>}
      </div>
      <input className="nla-input" value={caption} placeholder="Caption" onChange={(e) => setCaption(e.target.value)} />
      <input
        className="nla-input"
        value={altText}
        placeholder="Alt text"
        onChange={(e) => setAltText(e.target.value)}
      />
      <input
        className="nla-input"
        value={credit}
        placeholder="Photo credit (first name)"
        onChange={(e) => setCredit(e.target.value)}
      />
      <div className="nla-photo-actions">
        <button
          type="button"
          className="nla-btn-sm"
          disabled={busy}
          onClick={() => onSaveMeta(photo, {caption, altText, firstName: credit})}
        >
          Save
        </button>
        {photo.approved ? (
          <button type="button" className="nla-btn-sm" disabled={busy} onClick={() => onUnapprove(photo)}>
            Unapprove
          </button>
        ) : (
          <button type="button" className="nla-btn-sm nla-btn-primary" disabled={busy} onClick={() => onApprove(photo)}>
            Approve
          </button>
        )}
        <button
          type="button"
          className="nla-btn-sm"
          disabled={busy || !photo.approved || photo.isCover}
          onClick={() => onCover(photo)}
          title={photo.approved ? '' : 'Approve first'}
        >
          Set cover
        </button>
        <button type="button" className="nla-btn-sm nla-danger" disabled={busy} onClick={() => onRemove(photo)}>
          Remove
        </button>
      </div>
    </div>
  );
}

// ── Issue editor ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function IssueEditor({issueId, onBack}) {
  const [issue, setIssue] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [blocks, setBlocks] = useState([]);
  const [intake, setIntake] = useState({});
  const [manualTitle, setManualTitle] = useState('');
  const [thumbs, setThumbs] = useState({}); // photoId -> url
  const fileRef = useRef(null);

  const applyIssue = useCallback((data) => {
    setIssue(data);
    setBlocks(Array.isArray(data?.draftPayload?.blocks) ? data.draftPayload.blocks : []);
    setIntake(data?.intakeAnswers && typeof data.intakeAnswers === 'object' ? data.intakeAnswers : {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await getNewsletterIssueAdmin(sb, issueId);
      applyIssue(data);
    } catch (e) {
      setLoadError(friendlyNewsletterError(e));
    } finally {
      setLoading(false);
    }
  }, [issueId, applyIssue]);

  useEffect(() => {
    load();
  }, [load]);

  // Resolve thumbnails: public URL for approved, short-lived signed URL for staged.
  const photos = (issue && issue.photos) || [];
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      for (const p of photos) {
        try {
          next[p.id] = p.approved
            ? newsletterPublicPhotoUrl(sb, p.storagePath)
            : await getNewsletterStagingSignedUrl(sb, p.storagePath, 600);
        } catch (_e) {
          next[p.id] = '';
        }
      }
      if (!cancelled) setThumbs(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue]);

  const approvedPhotos = photos.filter((p) => p.approved);

  async function withBusy(fn, okMsg) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      if (okMsg) setNotice({kind: 'success', message: okMsg});
    } catch (e) {
      setNotice({kind: 'error', message: friendlyNewsletterError(e)});
    } finally {
      setBusy(false);
    }
  }

  // Blocks
  const addBlock = (type) => setBlocks((b) => [...b, defaultBlock(type)]);
  const changeBlock = (idx, next) => setBlocks((b) => b.map((x, i) => (i === idx ? next : x)));
  const moveBlock = (idx, dir) =>
    setBlocks((b) => {
      const j = idx + dir;
      if (j < 0 || j >= b.length) return b;
      const copy = b.slice();
      [copy[idx], copy[j]] = [copy[j], copy[idx]];
      return copy;
    });
  const removeBlock = (idx) => setBlocks((b) => b.filter((_, i) => i !== idx));
  const saveDraft = () =>
    withBusy(async () => {
      const data = await saveNewsletterDraft(sb, issueId, {...(issue.draftPayload || {}), blocks});
      applyIssue(data);
    }, 'Draft saved.');

  // Facts
  const toggleFact = (fact) =>
    withBusy(async () => {
      const data = await setNewsletterFactIncluded(sb, fact.id, !fact.included);
      applyIssue(data);
    });
  const addManual = () =>
    withBusy(async () => {
      if (!manualTitle.trim()) return;
      const data = await addNewsletterManualFact(sb, {issueId, title: manualTitle.trim()});
      setManualTitle('');
      applyIssue(data);
    }, 'Fact added.');

  // Intake
  const saveIntake = () =>
    withBusy(async () => {
      const data = await saveNewsletterIntake(sb, issueId, intake);
      applyIssue(data);
    }, 'Intake saved.');

  // Photos
  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    if (fileRef.current) fileRef.current.value = '';
    if (files.length === 0) return;
    withBusy(async () => {
      let data = issue;
      for (const file of files) {
        const token = generateNewsletterPhotoToken();
        const storagePath = await uploadNewsletterStagingPhoto(sb, issueId, file, {token});
        data = await registerNewsletterPhoto(sb, {issueId, storagePath});
      }
      applyIssue(data);
    }, 'Photo(s) uploaded to staging — approve to publish.');
  };
  const approve = (p) =>
    withBusy(async () => applyIssue(await approveNewsletterPhoto(sb, p)), 'Photo approved (copied to public).');
  const unapprove = (p) =>
    withBusy(async () => applyIssue(await unapproveNewsletterPhoto(sb, p)), 'Photo unapproved (public copy removed).');
  const cover = (p) => withBusy(async () => applyIssue(await setNewsletterCover(sb, issueId, p.id)), 'Cover set.');
  const removePhoto = (p) => withBusy(async () => applyIssue(await removeNewsletterPhoto(sb, p)), 'Photo removed.');
  const savePhotoMeta = (p, meta) =>
    withBusy(async () => applyIssue(await updateNewsletterPhoto(sb, {id: p.id, ...meta})), 'Photo details saved.');

  // Publish lifecycle
  const publish = () => withBusy(async () => applyIssue(await publishNewsletterIssue(sb, issueId)), 'Published.');
  const unpublish = () =>
    withBusy(async () => applyIssue(await unpublishNewsletterIssue(sb, issueId)), 'Unpublished — back to draft.');
  const regenPreview = () =>
    withBusy(async () => applyIssue(await regenerateNewsletterPreviewToken(sb, issueId)), 'Preview link regenerated.');

  if (loading) return <div className="nla-loading">Loading issue…</div>;
  if (loadError)
    return (
      <div className="nla-pad">
        <InlineNotice notice={{kind: 'error', message: loadError}} />
        <button type="button" className="nla-btn" onClick={load}>
          Retry
        </button>
        <button type="button" className="nla-btn" onClick={onBack}>
          Back
        </button>
      </div>
    );
  if (!issue) return null;

  const previewPath = buildNewsletterPreviewPath(issue.slug, issue.previewToken);
  const publishedPath = buildNewsletterIssuePath(issue.slug);

  return (
    <div className="nla-editor">
      <div className="nla-editor-bar">
        <button type="button" className="nla-btn" onClick={onBack}>
          ← Issues
        </button>
        <div className="nla-editor-title">
          <strong>{issue.title}</strong> <StatusBadge status={issue.status} />
          <span className="nla-muted"> · {formatYearMonth(issue.yearMonth)}</span>
        </div>
        <div className="nla-spacer" />
        {issue.status === 'published' ? (
          <>
            <a className="nla-btn" href={publishedPath} target="_blank" rel="noreferrer">
              View live
            </a>
            <button type="button" className="nla-btn nla-danger" disabled={busy} onClick={unpublish}>
              Unpublish
            </button>
          </>
        ) : (
          <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={publish}>
            Publish
          </button>
        )}
      </div>

      {notice && <InlineNotice notice={notice} />}

      <div className="nla-cols">
        <div className="nla-col-main">
          <section className="nla-section">
            <div className="nla-section-head">
              <h3>Content blocks</h3>
              <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={saveDraft}>
                Save draft
              </button>
            </div>
            {blocks.length === 0 && <p className="nla-muted">No blocks yet. Add one below.</p>}
            {blocks.map((block, idx) => (
              <BlockEditor
                key={idx}
                block={block}
                idx={idx}
                count={blocks.length}
                approvedPhotos={approvedPhotos}
                onChange={changeBlock}
                onMove={moveBlock}
                onRemove={removeBlock}
              />
            ))}
            <div className="nla-add-blocks">
              {NEWSLETTER_BLOCK_TYPES.map((t) => (
                <button key={t} type="button" className="nla-btn-sm" onClick={() => addBlock(t)}>
                  + {t}
                </button>
              ))}
            </div>
          </section>

          <section className="nla-section">
            <h3>Photos</h3>
            <p className="nla-muted">
              Uploads go to private staging. Approving copies the image to the public bucket — only approved photos
              appear on the live page. {photos.length}/12 used.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              onChange={onPickFiles}
              disabled={busy || photos.length >= 12}
            />
            <div className="nla-photos">
              {photos.map((p) => (
                <PhotoCard
                  key={p.id}
                  photo={p}
                  thumbUrl={thumbs[p.id]}
                  busy={busy}
                  onApprove={approve}
                  onUnapprove={unapprove}
                  onCover={cover}
                  onRemove={removePhoto}
                  onSaveMeta={savePhotoMeta}
                />
              ))}
            </div>
          </section>
        </div>

        <div className="nla-col-side">
          <section className="nla-section">
            <h3>Preview</h3>
            {issue.status === 'draft' ? (
              <>
                <p className="nla-muted">
                  Share an exact public preview before publishing. The link expires after 30 days and rotates/disables
                  on publish.
                </p>
                {issue.previewEnabled && (
                  <a className="nla-btn" href={previewPath} target="_blank" rel="noreferrer">
                    Open preview
                  </a>
                )}
                <button type="button" className="nla-btn" disabled={busy} onClick={regenPreview}>
                  Regenerate link
                </button>
              </>
            ) : (
              <p className="nla-muted">Preview is disabled while published. Unpublish to re-open a draft preview.</p>
            )}
          </section>

          <section className="nla-section">
            <h3>Facts</h3>
            <p className="nla-muted">
              Toggle which harvested facts inform the issue. No finances or mortalities are harvested.
            </p>
            {(issue.facts || []).length === 0 && <p className="nla-muted">No facts yet.</p>}
            <ul className="nla-facts">
              {(issue.facts || []).map((f) => (
                <li key={f.id} className="nla-fact">
                  <label className="nla-check">
                    <input type="checkbox" checked={!!f.included} disabled={busy} onChange={() => toggleFact(f)} />{' '}
                    <span>
                      <strong>{f.title}</strong>
                      {f.displayValue ? <span className="nla-muted"> · {f.displayValue}</span> : null}
                      {f.isManual ? <span className="nla-tag">manual</span> : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="nla-row">
              <input
                className="nla-input"
                value={manualTitle}
                placeholder="Add a manual fact"
                onChange={(e) => setManualTitle(e.target.value)}
              />
              <button type="button" className="nla-btn-sm" disabled={busy || !manualTitle.trim()} onClick={addManual}>
                Add
              </button>
            </div>
          </section>

          <section className="nla-section">
            <div className="nla-section-head">
              <h3>Monthly Q&amp;A</h3>
              <button type="button" className="nla-btn-sm" disabled={busy} onClick={saveIntake}>
                Save
              </button>
            </div>
            {INTAKE_QUESTIONS.map((q) => (
              <div key={q.key} className="nla-intake-q">
                <label className="nla-label">{q.label}</label>
                <textarea
                  className="nla-textarea"
                  rows={2}
                  value={intake[q.key] || ''}
                  onChange={(e) => setIntake((m) => ({...m, [q.key]: e.target.value}))}
                />
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Issue list + create ──────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function IssueList({onOpen}) {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ym, setYm] = useState(currentYearMonth());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIssues(await listNewsletterIssuesAdmin(sb));
    } catch (e) {
      setError(friendlyNewsletterError(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await createNewsletterIssue(sb, ym);
      onOpen(data.id);
    } catch (e) {
      setNotice({kind: 'error', message: friendlyNewsletterError(e)});
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nla-list">
      <div className="nla-create">
        <label className="nla-label">New issue for month</label>
        <div className="nla-row">
          <input className="nla-input" type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={create}>
            Create issue
          </button>
        </div>
        {notice && <InlineNotice notice={notice} />}
      </div>

      {loading ? (
        <div className="nla-loading">Loading…</div>
      ) : error ? (
        <div className="nla-pad">
          <InlineNotice notice={{kind: 'error', message: error}} />
          <button type="button" className="nla-btn" onClick={load}>
            Retry
          </button>
        </div>
      ) : issues.length === 0 ? (
        <p className="nla-muted">No issues yet. Create this month’s issue above.</p>
      ) : (
        <table className="nla-table">
          <thead>
            <tr>
              <th>Month</th>
              <th>Title</th>
              <th>Status</th>
              <th>Facts</th>
              <th>Photos</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {issues.map((it) => (
              <tr key={it.id}>
                <td>{formatYearMonth(it.yearMonth)}</td>
                <td>{it.title}</td>
                <td>
                  <StatusBadge status={it.status} />
                </td>
                <td>
                  {it.includedFactCount}/{it.factCount}
                </td>
                <td>{it.photoCount}</td>
                <td>
                  <button type="button" className="nla-btn-sm" onClick={() => onOpen(it.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!open || settings) return;
    (async () => {
      try {
        setSettings(await getNewsletterSettings(sb));
      } catch (e) {
        setNotice({kind: 'error', message: friendlyNewsletterError(e)});
      }
    })();
  }, [open, settings]);

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await updateNewsletterSettings(sb, {
        aiProvider: settings.aiProvider,
        aiModel: settings.aiModel,
        tone: settings.tone,
        draftGenDay: settings.draftGenDay,
        publishTargetDay: settings.publishTargetDay,
      });
      setSettings(data);
      setNotice({kind: 'success', message: 'Settings saved.'});
    } catch (e) {
      setNotice({kind: 'error', message: friendlyNewsletterError(e)});
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="nla-section">
      <button type="button" className="nla-btn" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} settings
      </button>
      {open && settings && (
        <div className="nla-settings">
          {notice && <InlineNotice notice={notice} />}
          <label className="nla-label">Tone</label>
          <input
            className="nla-input"
            value={settings.tone || ''}
            onChange={(e) => setSettings((s) => ({...s, tone: e.target.value}))}
          />
          <label className="nla-label">AI provider</label>
          <input
            className="nla-input"
            value={settings.aiProvider || ''}
            onChange={(e) => setSettings((s) => ({...s, aiProvider: e.target.value}))}
          />
          <label className="nla-label">AI model</label>
          <input
            className="nla-input"
            value={settings.aiModel || ''}
            onChange={(e) => setSettings((s) => ({...s, aiModel: e.target.value}))}
          />
          <div className="nla-row">
            <div>
              <label className="nla-label">Draft-gen day</label>
              <input
                className="nla-input"
                type="number"
                min={1}
                max={28}
                value={settings.draftGenDay || 1}
                onChange={(e) => setSettings((s) => ({...s, draftGenDay: Number(e.target.value)}))}
              />
            </div>
            <div>
              <label className="nla-label">Publish-target day</label>
              <input
                className="nla-input"
                type="number"
                min={1}
                max={28}
                value={settings.publishTargetDay || 5}
                onChange={(e) => setSettings((s) => ({...s, publishTargetDay: Number(e.target.value)}))}
              />
            </div>
          </div>
          <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={save}>
            Save settings
          </button>
        </div>
      )}
    </section>
  );
}

// ── Root view ────────────────────────────────────────────────────────────────

export default function NewsletterAdminView({Header}) {
  const [openId, setOpenId] = useState(null);

  return (
    <div>
      {Header ? <Header /> : null}
      <div className="nla-wrap">
        <div className="nla-header">
          <h2 className="nla-page-title">Monthly Newsletter</h2>
          {!openId && <SettingsPanel />}
        </div>
        {openId ? <IssueEditor issueId={openId} onBack={() => setOpenId(null)} /> : <IssueList onOpen={setOpenId} />}
      </div>
    </div>
  );
}
