// Admin Monthly Newsletter workspace (/admin/newsletter, admin-only via the
// route-level UnauthorizedRedirect guard in main.jsx). Redesign (direction-first):
//   - Issue list: a "this month" spotlight + a section-banded (Draft / Published)
//     list of openable hover-lift tiles (the A6 affordance; whole tile opens the
//     editor, keyboard-accessible via openableProps).
//   - Editor: a 7-step tracker (Facts · Steer · Draft · Revise · Photos · Review ·
//     Publish) over a main column of step cards + a 312px utility rail (this issue,
//     recent runs, guardrails). The draft is AI-OWNED — read-only structured
//     blocks, revise-in-place, guarded rewrite. No manual block editor.
//   - Settings: a dedicated in-view sub-surface of grouped setting cards.
// Every read/write still goes through newsletterApi (the SECDEF RPCs); this view
// never touches the newsletter_* tables directly, creates no Supabase client,
// and renders only structured blocks (no raw HTML).
//
// Photo consent: uploads land in the PRIVATE staging bucket and show via a
// short-lived signed URL until the admin APPROVES, which copies bytes into the
// PUBLIC bucket. Only approved photos appear on the public page. A suggested
// photo subject is not consent — approval is.

import React from 'react';
import {sb} from '../lib/supabase.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import Badge from '../shared/Badge.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import StatusText from '../shared/StatusText.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import SectionBand from '../shared/SectionBand.jsx';
import {openableProps} from '../shared/openable.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import NewsletterBlocks from './NewsletterBlocks.jsx';
import {NEWSLETTER_TONE_PRESETS, NEWSLETTER_LENGTH_PRESETS} from '../lib/newsletterDraft.js';
import {assembleNewsletterBrief} from '../lib/newsletterBrief.js';
import {placePlannedPhotos, pendingPlacementCount} from '../lib/newsletterPhotoPlan.js';
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
  gatherNewsletterFacts,
  regenerateNewsletterDraft,
  setNewsletterPhotoPlanSlot,
  getNewsletterRecentPublishedAdmin,
  probeNewsletterAi,
  listNewsletterRunsAdmin,
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

const {useState, useEffect, useCallback, useRef, useMemo} = React;

// Fixed monthly intake questions (events the planner data may not capture).
const INTAKE_QUESTIONS = [
  {key: 'highlights', label: 'Standout moments this month (anything noteworthy the data might miss)?'},
  {key: 'milestones', label: 'Milestones or firsts (a new record, a finished project, a visit)?'},
  {key: 'people', label: 'People to recognize (first names are OK)?'},
  {key: 'photoIdeas', label: 'Photo ideas — what moments are worth showing?'},
  {key: 'avoid', label: 'Anything to keep OUT of this issue?'},
];

// Supported AI models (the Edge Function defaults to Opus 4.8 when unset).
const AI_MODELS = [
  {value: 'claude-opus-4-8', label: 'Claude Opus 4.8 — most capable'},
  {value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 — balanced'},
  {value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — fast'},
];
const TONE_PRESET_LABELS = {
  warm_credible: 'Warm & credible',
  concise_professional: 'Concise & professional',
  celebratory: 'Celebratory',
  folksy: 'Folksy & personal',
};
const LENGTH_LABELS = {
  brief: 'Brief (~1 page)',
  standard: 'Standard (~2 pages)',
  detailed: 'Detailed (2–3 pages)',
};
const COVERAGE_STATUS_LABEL = {
  scanned: 'scanned',
  empty: 'empty',
  unavailable: 'unavailable',
  error: 'error',
};

// The 7 direction-first steps, in order. `doneOf` reads derived editor state.
const STEP_DEFS = [
  {key: 'facts', label: 'Facts', sub: 'Gathered'},
  {key: 'steer', label: 'Steer', sub: 'Your direction'},
  {key: 'draft', label: 'Draft', sub: 'AI writes'},
  {key: 'revise', label: 'Revise', sub: 'In place'},
  {key: 'photos', label: 'Photos', sub: 'Approved'},
  {key: 'review', label: 'Review', sub: 'Checks'},
  {key: 'publish', label: 'Publish', sub: 'Manual'},
];

// ── Status badge (closed Badge set, neutral lifecycle) ───────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StatusBadge({status}) {
  return status === 'published' ? <Badge variant="ok">Published</Badge> : <Badge variant="neutral">Draft</Badge>;
}

// ── Step tracker ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StepTracker({steps, activeKey}) {
  return (
    <div className="nla-tracker" role="list" aria-label="Newsletter progress">
      {steps.map((s, i) => {
        const state = s.done ? 'done' : s.key === activeKey ? 'active' : 'todo';
        return (
          <React.Fragment key={s.key}>
            {i > 0 && <span className={`nla-rail ${steps[i - 1].done ? 'is-done' : ''}`} aria-hidden="true" />}
            <div className={`nla-node nla-node-${state}`} role="listitem">
              <span className="nla-node-dot">{s.done ? '✓' : i + 1}</span>
              <span className="nla-node-label">{s.label}</span>
              <span className="nla-node-sub">{s.sub}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ── Step card shell ──────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function StepCard({n, title, desc, action, emphasized, children}) {
  return (
    <section className={`nla-step ${emphasized ? 'nla-step-active' : ''}`}>
      <div className="nla-step-head">
        <span className="nla-step-num">{n}</span>
        <div className="nla-step-titles">
          <h3 className="nla-step-title">{title}</h3>
          {desc ? <p className="nla-step-desc">{desc}</p> : null}
        </div>
        {action ? <div className="nla-step-action">{action}</div> : null}
      </div>
      {children}
    </section>
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
        {thumbUrl ? <img src={thumbUrl} alt={altText || caption || 'photo'} /> : <span className="nla-faint">…</span>}
        {photo.isCover && <span className="nla-cover-flag">★ Cover</span>}
      </div>
      <div className="nla-photo-status">
        <StatusText tone={photo.approved ? 'info' : 'warn'}>{photo.approved ? 'Approved' : 'Staged'}</StatusText>
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

// ── Coverage summary ─────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function CoverageBar({coverage}) {
  const scanned = coverage.filter((c) => c.status === 'scanned');
  const empty = coverage.filter((c) => c.status === 'empty');
  const issues = coverage.filter((c) => c.status === 'unavailable' || c.status === 'error');
  return (
    <div className="nla-coverage-bar">
      <span className="nla-cov-dot" aria-hidden="true" />
      <span>
        Scanned {scanned.length} source{scanned.length === 1 ? '' : 's'}
        {empty.length ? ` · ${empty.length} returned no activity` : ''}
        {issues.length ? ` · ${issues.length} unavailable` : ''}.
      </span>
    </div>
  );
}

// ── Fact row ─────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function FactRow({fact, busy, onToggle}) {
  return (
    <li className={`nla-fact-row ${fact.included ? '' : 'is-excluded'}`}>
      <label className="nla-fact-check">
        <input type="checkbox" checked={fact.included} disabled={busy} onChange={() => onToggle(fact)} />
      </label>
      <div className="nla-fact-body">
        <div className="nla-fact-line">
          <span className="nla-fact-name">{fact.title}</span>
          {fact.displayValue ? <span className="nla-fact-value">{fact.displayValue}</span> : null}
          {fact.confidence ? <span className="nla-chip">{String(fact.confidence).toUpperCase()}</span> : null}
          {fact.isManual ? <span className="nla-chip">MANUAL</span> : null}
        </div>
        {fact.why ? <div className="nla-fact-why">{fact.why}</div> : null}
        {fact.summary ? <div className="nla-fact-source">{fact.summary}</div> : null}
      </div>
    </li>
  );
}

// ── Issue editor ─────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function IssueEditor({issueId, onBack}) {
  const [issue, setIssue] = useState(null);
  const [settings, setSettings] = useState(null);
  const [recentPublished, setRecentPublished] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  const [blocks, setBlocks] = useState([]);
  const [intake, setIntake] = useState({});
  const [manualTitle, setManualTitle] = useState('');
  const [revisionNotes, setRevisionNotes] = useState('');
  // Two-step guard: a blank-note Write/Rewrite discards the current draft (and
  // any placed photos). When a draft already exists we arm an inline confirm
  // first. No window.confirm — house rule (Codex T9 lock).
  const [confirmRewrite, setConfirmRewrite] = useState(false);
  const [thumbs, setThumbs] = useState({}); // photoId -> url
  const [runs, setRuns] = useState([]);
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
      const [data, st, recent] = await Promise.all([
        getNewsletterIssueAdmin(sb, issueId),
        getNewsletterSettings(sb).catch(() => ({})),
        getNewsletterRecentPublishedAdmin(sb, {limit: 3, excludeId: issueId}).catch(() => []),
      ]);
      applyIssue(data);
      setSettings(st || {});
      setRecentPublished(recent || []);
      setRuns(await listNewsletterRunsAdmin(sb, issueId).catch(() => []));
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

  // The editorial brief is derived from the loaded issue + settings + recent
  // published issues. Recomputes whenever any of those change.
  const brief = useMemo(
    () => assembleNewsletterBrief({issue: issue || {}, settings: settings || {}, recentPublished}),
    [issue, settings, recentPublished],
  );
  const photoPlan = (issue && issue.photoPlan) || [];
  const pendingPlacement = pendingPlacementCount(blocks, photoPlan);

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

  // Draft is AI-owned: no manual block editing. The read-only preview reuses the
  // public block renderer (NewsletterBlocks). photosById/urlFor mirror
  // NewsletterIssuePage so placed (approved) photos resolve to their public URL.
  const photosById = useMemo(() => new Map(((issue && issue.photos) || []).map((p) => [p.id, p])), [issue]);
  const urlFor = useCallback((storagePath) => newsletterPublicPhotoUrl(sb, storagePath), []);

  // Facts (brief highlight toggles + manual add)
  const toggleFact = (fact) =>
    withBusy(async () => {
      const data = await setNewsletterFactIncluded(sb, fact.factId || fact.id, !fact.included);
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

  const reloadAfterRun = async () => {
    applyIssue(await getNewsletterIssueAdmin(sb, issueId));
    setRuns(await listNewsletterRunsAdmin(sb, issueId).catch(() => []));
  };
  // Direction-first: GATHER facts only (no AI draft). Scans the planner so you
  // can curate facts + add your Q&A/tone BEFORE the AI writes. "Write draft"
  // (below) is the AI step, run after you've steered.
  const gather = () =>
    withBusy(async () => {
      await gatherNewsletterFacts(sb, {issueId});
      await reloadAfterRun();
    }, 'Facts gathered — curate them, add your Q&A and tone, then write the draft.');
  // Regenerate the draft only (no re-harvest). With revision notes the AI revises
  // the CURRENT draft in place; without notes it regenerates from the facts.
  const regenerateDraft = () =>
    withBusy(
      async () => {
        await regenerateNewsletterDraft(sb, {issueId, revisionNotes});
        await reloadAfterRun();
      },
      revisionNotes.trim() ? 'Draft revised per your notes.' : 'Draft written from your facts and Q&A.',
    );

  // Revise (note present) preserves the current draft; a blank-note Write/Rewrite
  // replaces it. Guard the destructive path with an inline confirm when a draft
  // already exists. Placed photos are the highest-value manual work to flag.
  const isReviseMode = revisionNotes.trim().length > 0;
  const placedPhotoCount = blocks.filter((b) => b && b.type === 'photo' && b.photoId).length;
  const overwriteRisk = !isReviseMode && blocks.length > 0;
  const onWriteClick = () => {
    if (overwriteRisk && !confirmRewrite) {
      setConfirmRewrite(true);
      return;
    }
    setConfirmRewrite(false);
    regenerateDraft();
  };

  // Photo plan: assign an approved photo to a shot-list slot, then weave the
  // fulfilled slots into the draft as photo blocks at their planned section.
  const assignSlot = (slotId, photoId) =>
    withBusy(
      async () => applyIssue(await setNewsletterPhotoPlanSlot(sb, {issueId, slotId, photoId})),
      photoId ? 'Photo assigned to the plan.' : 'Slot cleared.',
    );
  const placePhotos = () =>
    withBusy(async () => {
      const next = placePlannedPhotos(blocks, (issue && issue.photoPlan) || []);
      const data = await saveNewsletterDraft(sb, issueId, {...(issue.draftPayload || {}), blocks: next});
      applyIssue(data);
    }, 'Planned photos placed in the draft.');

  if (loading) return <div className="nla-loading">Loading issue…</div>;
  if (loadError)
    return (
      <div className="nla-pad">
        <InlineNotice notice={{kind: 'error', message: loadError}} />
        <div className="nla-row-tight">
          <button type="button" className="nla-btn" onClick={load}>
            Retry
          </button>
          <button type="button" className="nla-btn" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  if (!issue) return null;

  const previewPath = buildNewsletterPreviewPath(issue.slug, issue.previewToken);
  const publishedPath = buildNewsletterIssuePath(issue.slug);
  const isPublished = issue.status === 'published';

  // Derived step state for the tracker (truthful — read from real editor state).
  const factsGathered = (issue.facts || []).length > 0;
  const hasDirection =
    Object.values(intake || {}).some((v) => String(v || '').trim()) || (issue.manualFactCount || 0) > 0;
  const hasDraft = blocks.length > 0;
  const hasRevision = runs.some((r) => r.runType === 'ai_revise');
  const photosTarget = Number(settings?.photoTarget ?? 6);
  const photosMin = Number(settings?.photoMin ?? 3);
  const photosOk = approvedPhotos.length >= photosMin;
  const reviewOk = !!brief.readiness.publishable;
  const stepDone = {
    facts: factsGathered,
    steer: hasDirection,
    draft: hasDraft,
    revise: hasRevision,
    photos: photosOk,
    review: reviewOk,
    publish: isPublished,
  };
  const steps = STEP_DEFS.map((s) => ({...s, done: !!stepDone[s.key]}));
  const activeKey = (steps.find((s) => !s.done) || steps[steps.length - 1]).key;

  const includedFactCount = (issue.facts || []).filter((f) => f.included).length;
  const factCount = (issue.facts || []).length;
  const checksRemaining = brief.readiness.items.filter((it) => it.blocking && !it.ok).length;
  const lastHarvestRun = runs.find((r) => r.runType === 'harvest');
  const toneLabel = settings?.tone || TONE_PRESET_LABELS[settings?.tonePreset] || 'Warm & credible';
  const lengthLabel = LENGTH_LABELS[settings?.lengthDetail] || 'Standard';
  const reviseRuns = runs.filter((r) => r.runType === 'ai_revise');

  return (
    <div className="nla-editor">
      {/* Issue header */}
      <div className="nla-editor-bar">
        <button type="button" className="nla-btn" onClick={onBack}>
          ← Issues
        </button>
        <div className="nla-editor-title">
          <strong>{issue.title}</strong> <StatusBadge status={issue.status} />
          <span className="nla-faint"> · {formatYearMonth(issue.yearMonth)}</span>
        </div>
        <div className="nla-spacer" />
        {isPublished ? (
          <>
            <a className="nla-btn" href={publishedPath} target="_blank" rel="noreferrer">
              View live
            </a>
            <button type="button" className="nla-btn nla-danger" disabled={busy} onClick={unpublish}>
              Unpublish
            </button>
          </>
        ) : (
          <>
            {issue.previewEnabled && (
              <a className="nla-btn" href={previewPath} target="_blank" rel="noreferrer">
                Open preview
              </a>
            )}
            <button
              type="button"
              className="nla-btn nla-btn-primary"
              disabled={busy || !brief.readiness.publishable}
              onClick={publish}
              title={brief.readiness.publishable ? '' : 'Resolve the blocking readiness items first'}
            >
              Publish
            </button>
          </>
        )}
      </div>

      {notice && <InlineNotice notice={notice} />}

      {/* Step tracker */}
      <div className="nla-tracker-card">
        <StepTracker steps={steps} activeKey={activeKey} />
      </div>

      <div className="nla-cols">
        <div className="nla-col-main">
          {/* 1 · Facts */}
          <StepCard
            n={1}
            title="This month’s facts"
            desc="Harvested from the planner — no AI. Toggle which inform the issue."
            action={
              <span className="nla-step-count">
                <strong>
                  {includedFactCount} / {factCount}
                </strong>{' '}
                included
                <button type="button" className="nla-btn-sm" disabled={busy} onClick={gather}>
                  {factsGathered ? 'Re-gather facts' : 'Gather facts'}
                </button>
              </span>
            }
          >
            {brief.coverage.length > 0 && <CoverageBar coverage={brief.coverage} />}
            {brief.highlights.length === 0 ? (
              <p className="nla-muted">No facts yet. Click “Gather facts” to scan this month’s planner data.</p>
            ) : (
              <ul className="nla-fact-list">
                {brief.highlights.map((h) => (
                  <FactRow key={h.factId} fact={h} busy={busy} onToggle={toggleFact} />
                ))}
              </ul>
            )}
            {brief.repetition.length > 0 && (
              <div className="nla-repetition">
                {brief.repetition.map((r) => (
                  <p key={r.detectorKey}>
                    <StatusText tone={r.sameValue ? 'danger' : 'muted'}>
                      <strong>{r.title}</strong> — {r.note}
                    </StatusText>
                  </p>
                ))}
              </div>
            )}
          </StepCard>

          {/* 2 · Steer */}
          <StepCard
            n={2}
            title="Your direction"
            desc="Optional context the data can’t see. Steers the AI before it writes."
          >
            <div className="nla-qa">
              {INTAKE_QUESTIONS.map((q) => (
                <div key={q.key} className="nla-qa-row">
                  <label className="nla-qa-label" htmlFor={`nla-q-${q.key}`}>
                    {q.label}
                  </label>
                  <textarea
                    id={`nla-q-${q.key}`}
                    className="nla-textarea"
                    rows={2}
                    value={intake[q.key] || ''}
                    onChange={(e) => setIntake((m) => ({...m, [q.key]: e.target.value}))}
                  />
                </div>
              ))}
            </div>
            <div className="nla-subblock">
              <div className="nla-subblock-label">Manual facts</div>
              <div className="nla-row">
                <input
                  className="nla-input"
                  value={manualTitle}
                  placeholder="e.g. Hosted the county 4-H tour"
                  onChange={(e) => setManualTitle(e.target.value)}
                />
                <button type="button" className="nla-btn-sm" disabled={busy || !manualTitle.trim()} onClick={addManual}>
                  Add
                </button>
              </div>
              <p className="nla-faint">For something the planner data can’t see. No finances or mortalities.</p>
            </div>
            <div className="nla-subblock">
              <div className="nla-subblock-label">Tone &amp; length</div>
              <div className="nla-chips">
                <span className="nla-chip">{toneLabel}</span>
                <span className="nla-chip">{lengthLabel}</span>
              </div>
            </div>
            <div className="nla-step-foot">
              <button type="button" className="nla-btn-sm" disabled={busy} onClick={saveIntake}>
                Save direction
              </button>
            </div>
          </StepCard>

          {/* 3 · Draft (read-only, AI-owned) */}
          <StepCard
            n={3}
            title="The draft"
            desc="The AI owns the content. Read-only here — use Revise below to change it."
            action={<Badge variant="neutral">Read-only</Badge>}
          >
            {blocks.length === 0 ? (
              <p className="nla-muted">No draft yet. Curate the facts + direction above, then “Write draft” below.</p>
            ) : (
              <div className="nla-draft-preview" aria-label="Draft preview (read-only)">
                <NewsletterBlocks blocks={blocks} photosById={photosById} urlFor={urlFor} />
              </div>
            )}
          </StepCard>

          {/* 4 · Revise — emphasized only when it's the actual active step. */}
          <StepCard
            n={4}
            title="Revise"
            desc="Tell the AI what to change — it edits the current draft in place."
            emphasized={activeKey === 'revise'}
            action={activeKey === 'revise' ? <span className="nla-here">You’re here</span> : null}
          >
            {/* The AI owns the content structure — there is no manual block
                building. Blank box = write/rewrite from your curated facts + Q&A;
                with a note = revise the current draft in place. */}
            <div className="nla-revise">
              <textarea
                id="nla-revision-notes"
                className="nla-textarea"
                rows={2}
                value={revisionNotes}
                placeholder="Optional — tell the AI what to change (e.g. “warmer tone”, “shorten the cattle section”). Leave blank to write/rewrite from your facts + Q&A."
                onChange={(e) => {
                  setRevisionNotes(e.target.value);
                  if (confirmRewrite) setConfirmRewrite(false);
                }}
              />
              <button
                type="button"
                className="nla-btn nla-btn-primary"
                disabled={busy}
                onClick={onWriteClick}
                title="Write the draft from your facts + Q&A; with a note, the AI revises the current draft in place"
              >
                {revisionNotes.trim() ? 'Revise draft' : blocks.length === 0 ? 'Write draft' : 'Rewrite draft'}
              </button>
            </div>
            <p className="nla-warn-note">
              Rewrite redraws everything and drops placed photos (you’ll confirm first). Revise keeps them.
            </p>
            {confirmRewrite && (
              <div className="nla-rewrite-confirm" role="alert">
                <span>
                  Rewriting replaces the current draft
                  {placedPhotoCount > 0
                    ? ` and removes ${placedPhotoCount} placed photo${placedPhotoCount === 1 ? '' : 's'}`
                    : ''}
                  . Add a note above and use Revise to keep the current draft.
                </span>
                <span className="nla-rewrite-confirm-actions">
                  <button type="button" className="nla-btn nla-danger" disabled={busy} onClick={onWriteClick}>
                    Replace draft
                  </button>
                  <button type="button" className="nla-btn" disabled={busy} onClick={() => setConfirmRewrite(false)}>
                    Keep current
                  </button>
                </span>
              </div>
            )}
            {reviseRuns.length > 0 && (
              <div className="nla-subblock">
                <div className="nla-subblock-label">Revision history</div>
                <ul className="nla-runs">
                  {reviseRuns.slice(0, 5).map((r) => (
                    <li key={r.id} className="nla-run">
                      <span>Revised</span>
                      <StatusText tone={r.status === 'error' ? 'danger' : 'ok'}>{r.status}</StatusText>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </StepCard>

          {/* 5 · Photos */}
          <StepCard
            n={5}
            title="Photos"
            desc="Uploads land in private staging — approve to copy into the public bucket."
            action={
              <span className="nla-step-count">
                <strong>
                  {placedPhotoCount} of {photosTarget}
                </strong>{' '}
                placed
              </span>
            }
          >
            {photoPlan.length > 0 && (
              <div className="nla-subblock">
                <div className="nla-subblock-label nla-plan-head">
                  <span>Photo plan — shots to get this month</span>
                  {pendingPlacement > 0 && (
                    <button type="button" className="nla-btn-sm nla-btn-primary" disabled={busy} onClick={placePhotos}>
                      Place {pendingPlacement} planned photo{pendingPlacement === 1 ? '' : 's'}
                    </button>
                  )}
                </div>
                <ul className="nla-plan-list">
                  {photoPlan.map((slot) => (
                    <li key={slot.id} className="nla-plan-slot">
                      <div>
                        <strong>{slot.idea}</strong>
                        {slot.section ? <span className="nla-faint"> · {slot.section}</span> : null}
                        {slot.photoId ? <span className="nla-chip">assigned</span> : null}
                      </div>
                      <select
                        className="nla-select"
                        value={slot.photoId || ''}
                        disabled={busy}
                        onChange={(e) => assignSlot(slot.id, e.target.value || null)}
                      >
                        <option value="">
                          {approvedPhotos.length ? '— assign an approved photo —' : '— approve a photo first —'}
                        </option>
                        {approvedPhotos.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.caption || p.altText || p.id}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="nla-photo-upload">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={onPickFiles}
                disabled={busy || photos.length >= 12}
              />
              <span className="nla-faint">→ land in private staging, not public. {photos.length}/12 used.</span>
            </div>
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
          </StepCard>

          <StepCard n={6} title="Review &amp; check" desc="Confirm the issue is ready and share a private preview.">
            <div className="nla-review">
              <div className="nla-review-pane">
                <div className="nla-subblock-label">Readiness</div>
                <ul className="nla-readiness">
                  {brief.readiness.items.map((it) => (
                    <li key={it.key} className="nla-ready">
                      <span className={`nla-ready-mark nla-ready-${it.ok ? 'ok' : it.blocking ? 'bad' : 'warn'}`}>
                        {it.ok ? '✓' : it.blocking ? '✕' : '!'}
                      </span>
                      <span className="nla-ready-label">{it.label}</span>
                    </li>
                  ))}
                </ul>
                {!brief.readiness.publishable && (
                  <p className="nla-faint">Resolve the ✕ items before publishing. ! items are recommended.</p>
                )}
              </div>
              <div className="nla-review-pane">
                <div className="nla-subblock-label">Private preview</div>
                {isPublished ? (
                  <p className="nla-muted">
                    Preview is disabled while published. Unpublish to re-open a draft preview.
                  </p>
                ) : (
                  <>
                    <p className="nla-faint">
                      Share an exact public preview before publishing. The link expires after 30 days and rotates on
                      publish.
                    </p>
                    {issue.previewEnabled && <div className="nla-preview-url">{previewPath}</div>}
                    <div className="nla-row-tight">
                      {issue.previewEnabled && (
                        <a className="nla-btn-sm" href={previewPath} target="_blank" rel="noreferrer">
                          Open preview
                        </a>
                      )}
                      <button type="button" className="nla-btn-sm" disabled={busy} onClick={regenPreview}>
                        Regenerate link
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </StepCard>

          <StepCard n={7} title="Publish" desc="Snapshots the draft to the public archive. Nothing publishes itself.">
            <div className="nla-publish-row">
              <span className="nla-faint">
                {isPublished
                  ? 'This issue is live.'
                  : checksRemaining > 0
                    ? `${checksRemaining} check${checksRemaining === 1 ? '' : 's'} remaining`
                    : 'All checks clear.'}
              </span>
              {isPublished ? (
                <button type="button" className="nla-btn nla-danger" disabled={busy} onClick={unpublish}>
                  Unpublish
                </button>
              ) : (
                <button
                  type="button"
                  className="nla-btn nla-btn-primary"
                  disabled={busy || !brief.readiness.publishable}
                  onClick={publish}
                  title={brief.readiness.publishable ? '' : 'Resolve the blocking readiness items first'}
                >
                  Publish issue
                </button>
              )}
            </div>
          </StepCard>
        </div>

        <aside className="nla-col-side">
          <section className="nla-rail-card">
            <h3 className="nla-rail-title">This issue</h3>
            <dl className="nla-lv">
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={issue.status} />
                </dd>
              </div>
              <div>
                <dt>Facts</dt>
                <dd className="nla-num">
                  {includedFactCount} / {factCount}
                </dd>
              </div>
              <div>
                <dt>Photos</dt>
                <dd className="nla-num">
                  <StatusText tone={photosOk ? 'ok' : 'warn'}>
                    {approvedPhotos.length} / {photosTarget}
                  </StatusText>
                </dd>
              </div>
              <div>
                <dt>Tone</dt>
                <dd>{toneLabel}</dd>
              </div>
              <div>
                <dt>Length</dt>
                <dd>{lengthLabel}</dd>
              </div>
              <div>
                <dt>Last harvest</dt>
                <dd>{lastHarvestRun ? (lastHarvestRun.status === 'ok' ? 'Done' : lastHarvestRun.status) : '—'}</dd>
              </div>
            </dl>
            <button type="button" className="nla-btn-sm" disabled={busy} onClick={gather}>
              {factsGathered ? 'Re-gather facts' : 'Gather facts'}
            </button>
          </section>

          {runs.length > 0 && (
            <section className="nla-rail-card">
              <h3 className="nla-rail-title">Recent runs</h3>
              <ul className="nla-runs">
                {runs.slice(0, 6).map((r) => (
                  <li key={r.id} className="nla-run">
                    <span>
                      {r.runType}
                      {r.provider ? <span className="nla-faint"> · {r.provider}</span> : null}
                    </span>
                    <StatusText tone={r.status === 'error' ? 'danger' : 'ok'}>
                      {r.status === 'error' ? 'error' : 'OK'}
                    </StatusText>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="nla-rail-card">
            <div className="nla-rail-head">
              <h3 className="nla-rail-title">Guardrails</h3>
              <Badge variant="ok">Always on</Badge>
            </div>
            <ul className="nla-guardrails">
              <li>No finances or mortalities</li>
              <li>Approved photos only on the public page</li>
              <li>Photo consent gate before publishing</li>
              <li>Server-only AI key — never in the browser</li>
              <li>Safe structured blocks — no raw HTML</li>
              <li>Monthly auto-start OFF</li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

// ── This-month spotlight ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function ThisMonthSpotlight({issues, onOpen, onNotice}) {
  const ym = currentYearMonth();
  const current = issues.find((it) => it.yearMonth === ym) || null;
  const [busy, setBusy] = useState(false);

  const gatherThisMonth = async () => {
    setBusy(true);
    try {
      let id = current && current.id;
      if (!id) {
        const data = await createNewsletterIssue(sb, ym);
        id = data.id;
      }
      // Direction-first: create (if needed) + GATHER facts only, then open to the
      // editor so you curate + add direction before writing the draft.
      await gatherNewsletterFacts(sb, {issueId: id});
      onOpen(id);
    } catch (e) {
      onNotice({kind: 'error', message: friendlyNewsletterError(e)});
      setBusy(false);
    }
  };

  return (
    <section className="nla-spotlight">
      <div className="nla-spotlight-main">
        <div className="nla-eyebrow">This month</div>
        <div className="nla-spotlight-head">
          <span className="nla-spotlight-month">{formatYearMonth(ym)}</span>
          {current && <StatusBadge status={current.status} />}
        </div>
        {current ? (
          <>
            <div className="nla-spotlight-title">{current.title}</div>
            <div className="nla-spotlight-progress">
              {current.includedFactCount}/{current.factCount} facts · {current.photoCount} photos
            </div>
          </>
        ) : (
          <div className="nla-spotlight-progress nla-muted">No issue for this month yet.</div>
        )}
      </div>
      <div className="nla-spotlight-actions">
        {current && (
          <button type="button" className="nla-btn" disabled={busy} onClick={() => onOpen(current.id)}>
            Open
          </button>
        )}
        <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={gatherThisMonth}>
          {busy ? 'Gathering…' : current ? 'Re-gather facts' : 'Gather this month’s facts'}
        </button>
      </div>
    </section>
  );
}

// ── Issue list ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function IssueTile({issue, onOpen}) {
  return (
    <div className="nla-tile hoverable-tile" {...openableProps(() => onOpen(issue.id))}>
      <span className="nla-tile-month">{formatYearMonth(issue.yearMonth)}</span>
      <span className="nla-tile-title">{issue.title}</span>
      <span className="nla-tile-status">
        {issue.status === 'published' ? (
          <StatusText tone="ok">● Published</StatusText>
        ) : (
          <StatusText tone="muted">● Draft</StatusText>
        )}
      </span>
      <span className="nla-tile-num">
        {issue.includedFactCount}/{issue.factCount}
      </span>
      <span className="nla-tile-num">{issue.photoCount}</span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </div>
  );
}

// eslint-disable-next-line no-unused-vars -- JSX-only use
function IssueList({onOpen, onSettings}) {
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ym, setYm] = useState(currentYearMonth());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

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

  const drafts = issues.filter((it) => it.status !== 'published');
  const published = issues.filter((it) => it.status === 'published');

  return (
    <div className="nla-list">
      <div className="nla-list-head">
        <div>
          <h2 className="nla-page-title">Monthly Newsletter</h2>
          <p className="nla-faint">Gather facts, steer the AI, place photos, and publish the monthly review.</p>
        </div>
        <div className="nla-row-tight">
          <button type="button" className="nla-btn" onClick={onSettings}>
            Settings
          </button>
          <button type="button" className="nla-btn nla-btn-primary" onClick={() => setShowCreate((s) => !s)}>
            + New issue
          </button>
        </div>
      </div>

      {showCreate && (
        <div className="nla-create">
          <label className="nla-label" htmlFor="nla-new-month">
            New issue month
          </label>
          <div className="nla-row">
            <input
              id="nla-new-month"
              className="nla-input"
              type="month"
              value={ym}
              onChange={(e) => setYm(e.target.value)}
            />
            <button type="button" className="nla-btn" disabled={busy} onClick={create}>
              Create issue
            </button>
          </div>
        </div>
      )}

      {notice && <InlineNotice notice={notice} />}

      {!loading && !error && <ThisMonthSpotlight issues={issues} onOpen={onOpen} onNotice={setNotice} />}

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
        <p className="nla-muted">No issues yet. Use “Gather this month’s facts” above to start.</p>
      ) : (
        <div className="nla-tile-table">
          <div className="nla-tile-colhead">
            <span>Month</span>
            <span>Title</span>
            <span>Status</span>
            <span className="nla-tile-num">Facts</span>
            <span className="nla-tile-num">Photos</span>
            <span aria-hidden="true" />
          </div>
          {drafts.length > 0 && (
            <>
              <SectionBand as="div" label={`Draft · ${drafts.length} issue${drafts.length === 1 ? '' : 's'}`} />
              {drafts.map((it) => (
                <IssueTile key={it.id} issue={it} onOpen={onOpen} />
              ))}
            </>
          )}
          {published.length > 0 && (
            <>
              <SectionBand
                as="div"
                label={`Published · ${published.length} issue${published.length === 1 ? '' : 's'}`}
              />
              {published.map((it) => (
                <IssueTile key={it.id} issue={it} onOpen={onOpen} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Settings (in-view sub-surface) ───────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use
function SettingsView({onBack}) {
  const [settings, setSettings] = useState(null);
  const [aiConfigured, setAiConfigured] = useState(null); // null = unknown
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await getNewsletterSettings(sb));
      const probe = await probeNewsletterAi(sb).catch(() => ({ok: false}));
      setAiConfigured(probe.ok ? probe.aiConfigured : null);
    } catch (e) {
      setLoadError(friendlyNewsletterError(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const set = (patch) => setSettings((s) => ({...s, ...patch}));

  const save = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const data = await updateNewsletterSettings(sb, {
        aiProvider: settings.aiProvider,
        aiModel: settings.aiModel,
        tone: settings.tone,
        tonePreset: settings.tonePreset,
        lengthDetail: settings.lengthDetail,
        photoMin: Number(settings.photoMin),
        photoTarget: Number(settings.photoTarget),
        pastIssueContextCount: Number(settings.pastIssueContextCount),
        draftGenDay: Number(settings.draftGenDay),
        publishTargetDay: Number(settings.publishTargetDay),
      });
      setSettings(data);
      setNotice({kind: 'success', message: 'Settings saved.'});
    } catch (e) {
      setNotice({kind: 'error', message: friendlyNewsletterError(e)});
    } finally {
      setBusy(false);
    }
  };

  const anthropicLabel =
    aiConfigured === true
      ? 'Anthropic (server key configured)'
      : aiConfigured === false
        ? 'Anthropic (needs server key — falls back to template)'
        : 'Anthropic';

  return (
    <div className="nla-settings-view">
      <div className="nla-list-head">
        <div>
          <h2 className="nla-page-title">Newsletter settings</h2>
          <p className="nla-faint">Defaults applied to every new issue.</p>
        </div>
        <button type="button" className="nla-btn" onClick={onBack}>
          ‹ Back to issues
        </button>
      </div>

      {notice && <InlineNotice notice={notice} />}
      {loadError && (
        <div className="nla-pad">
          <InlineNotice notice={{kind: 'error', message: loadError}} />
          <button type="button" className="nla-btn" onClick={load}>
            Retry
          </button>
        </div>
      )}

      {settings && (
        <div className="nla-settings-grid">
          <section className="nla-set-card">
            <div className="nla-set-card-head">
              <h3>AI</h3>
              <span className="nla-faint">The AI key lives on the server — never in the browser.</span>
            </div>
            <div className="nla-set-fields">
              <div className="nla-field">
                <label className="nla-label">AI provider</label>
                <select
                  className="nla-select nla-select-full"
                  value={settings.aiProvider || 'template'}
                  onChange={(e) => set({aiProvider: e.target.value})}
                >
                  <option value="template">Template (offline, no key)</option>
                  <option value="anthropic">{anthropicLabel}</option>
                </select>
              </div>
              <div className="nla-field">
                <label className="nla-label">AI model</label>
                <select
                  className="nla-select nla-select-full"
                  value={settings.aiModel || ''}
                  onChange={(e) => set({aiModel: e.target.value})}
                >
                  <option value="">— default (Opus 4.8) —</option>
                  {AI_MODELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="nla-set-card">
            <div className="nla-set-card-head">
              <h3>Tone &amp; length</h3>
            </div>
            <div className="nla-set-fields">
              <div className="nla-field">
                <label className="nla-label">Tone preset</label>
                <select
                  className="nla-select nla-select-full"
                  value={settings.tonePreset || 'warm_credible'}
                  onChange={(e) => set({tonePreset: e.target.value})}
                >
                  {Object.keys(NEWSLETTER_TONE_PRESETS).map((k) => (
                    <option key={k} value={k}>
                      {TONE_PRESET_LABELS[k] || k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="nla-field">
                <label className="nla-label">Length / detail</label>
                <select
                  className="nla-select nla-select-full"
                  value={settings.lengthDetail || 'standard'}
                  onChange={(e) => set({lengthDetail: e.target.value})}
                >
                  {Object.keys(NEWSLETTER_LENGTH_PRESETS).map((k) => (
                    <option key={k} value={k}>
                      {LENGTH_LABELS[k] || k}
                    </option>
                  ))}
                </select>
              </div>
              <div className="nla-field nla-field-full">
                <label className="nla-label">Custom tone override (optional)</label>
                <input
                  className="nla-input"
                  value={settings.tone || ''}
                  placeholder="e.g. warm but credible, like a proud owner"
                  onChange={(e) => set({tone: e.target.value})}
                />
              </div>
            </div>
          </section>

          <section className="nla-set-card">
            <div className="nla-set-card-head">
              <h3>Photos &amp; context</h3>
            </div>
            <div className="nla-set-fields">
              <div className="nla-field">
                <label className="nla-label">Photos — minimum</label>
                <input
                  className="nla-input"
                  type="number"
                  min={0}
                  max={12}
                  value={settings.photoMin ?? 3}
                  onChange={(e) => set({photoMin: e.target.value})}
                />
              </div>
              <div className="nla-field">
                <label className="nla-label">Photos — target</label>
                <input
                  className="nla-input"
                  type="number"
                  min={0}
                  max={12}
                  value={settings.photoTarget ?? 6}
                  onChange={(e) => set({photoTarget: e.target.value})}
                />
              </div>
              <div className="nla-field">
                <label className="nla-label">Past issues for context</label>
                <input
                  className="nla-input"
                  type="number"
                  min={0}
                  max={12}
                  value={settings.pastIssueContextCount ?? 3}
                  onChange={(e) => set({pastIssueContextCount: e.target.value})}
                />
              </div>
            </div>
          </section>

          <section className="nla-set-card">
            <div className="nla-set-card-head">
              <h3>Schedule</h3>
            </div>
            <div className="nla-set-fields">
              <div className="nla-field">
                <label className="nla-label">Draft-gen day</label>
                <input
                  className="nla-input"
                  type="number"
                  min={1}
                  max={28}
                  value={settings.draftGenDay || 1}
                  onChange={(e) => set({draftGenDay: e.target.value})}
                />
              </div>
              <div className="nla-field">
                <label className="nla-label">Publish-target day</label>
                <input
                  className="nla-input"
                  type="number"
                  min={1}
                  max={28}
                  value={settings.publishTargetDay || 5}
                  onChange={(e) => set({publishTargetDay: e.target.value})}
                />
              </div>
              <div className="nla-field nla-field-full">
                <label className="nla-label">Automatic monthly start</label>
                <div className="nla-toggle-row">
                  <Badge variant="neutral">Off</Badge>
                  <span className="nla-faint">
                    Pre-drafts but never clobbers your edits. Stays off until explicitly approved.
                  </span>
                </div>
              </div>
            </div>
          </section>

          <div className="nla-settings-foot">
            <button type="button" className="nla-btn nla-btn-primary" disabled={busy} onClick={save}>
              Save settings
            </button>
            <span className="nla-faint">Changes apply to the next draft you generate.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Root view ────────────────────────────────────────────────────────────────

export default function NewsletterAdminView({Header}) {
  // Client-side sub-views (no new route alias — same pattern as list↔editor):
  //   list | editor | settings
  const [view, setView] = useState('list');
  const [openId, setOpenId] = useState(null);

  const openEditor = (id) => {
    setOpenId(id);
    setView('editor');
  };
  const backToList = () => {
    setOpenId(null);
    setView('list');
  };

  return (
    <div>
      {Header ? <Header /> : null}
      <div className="nla-wrap">
        {view === 'settings' ? (
          <SettingsView onBack={() => setView('list')} />
        ) : view === 'editor' && openId ? (
          <IssueEditor issueId={openId} onBack={backToList} />
        ) : (
          <IssueList onOpen={openEditor} onSettings={() => setView('settings')} />
        )}
      </div>
    </div>
  );
}
