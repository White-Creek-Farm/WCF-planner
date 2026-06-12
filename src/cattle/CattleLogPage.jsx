// CattleLogPage — /cattle/log (view 'cattlelog').
//
// Singleton log of cattle comments (entity 'cattle.log' / 'cattle-log').
// Composer at top (MentionTextarea + attachments + Issue checkbox + paper-
// airplane submit), Issues/All filter (Issues default), server-side search,
// keyset "Load more" pagination, per-row Issue toggle (management/admin),
// author edit, management/admin delete, offline create-only queue rows.
//
// Tag flow: '#<digits>' references are previewed client-side against the
// loaded active cattle (current tag first, then non-import old_tags) — the
// server is authoritative. Unmatched tags require a calf-note panel before
// an ONLINE submit; ambiguous tags block submit outright. Offline submits
// skip the calf-note requirement (replay goes needs-attention if the server
// rejects).
//
// All data via the cattle-log RPC family (src/lib/cattleLogApi.js) — no
// direct .from() on comments/cattle_log tables. The only direct read here is
// the active-cattle preview list (same pattern as WeighInsWebform).
import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
import {fmtCentralDateTime} from '../lib/dateUtils.js';
import {renderMentionSegments} from '../lib/activityApi.js';
import {
  uploadCommentAttachment,
  getAttachmentSignedUrl,
  MAX_COMMENT_ATTACHMENTS,
  MAX_DOCUMENT_BYTES,
} from '../lib/commentAttachments.js';
import {imageAltText} from '../lib/imageAlt.js';
import {CATTLE_HERDS, CATTLE_HERD_LABELS} from '../lib/cattle.js';
import {
  submitCattleLogEntry,
  editCattleLogEntry,
  deleteCattleLogEntry,
  setCattleLogIssue,
  listCattleLogEntries,
  loadCattleLogMentionableProfiles,
  classifyCattleLogError,
  generateCattleLogEntryId,
} from '../lib/cattleLogApi.js';
import {parseCattleLogTags, buildCattleLogBodySegments, matchTagToCattle} from '../lib/cattleLogTags.js';
import {useCattleLogQueue} from '../lib/cattleLogOffline.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import MentionTextarea from '../shared/MentionTextarea.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import InlineNotice from '../shared/InlineNotice.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import DeleteModal from '../shared/DeleteModal.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import CattleLogHowTo from './CattleLogHowTo.jsx';

const ALLOWED_ROLES = ['light', 'farm_team', 'management', 'admin'];
const MANAGER_ROLES = ['management', 'admin'];
const SEX_OPTIONS = [
  ['cow', 'Cow'],
  ['heifer', 'Heifer'],
  ['bull', 'Bull'],
  ['steer', 'Steer'],
];
const PAGE_SIZE = 200;
const MIN_BODY_LEN = 4;
// Server cap (submit/edit RPCs reject longer bodies). Enforced client-side
// too so an oversized OFFLINE submit can't dead-end as a needs-attention row
// whose Retry can never succeed.
const MAX_BODY_LEN = 4000;

const EMPTY_CALF_NOTE = {
  calf_herd: '',
  calf_dob: '',
  calf_sex: '',
  calf_origin: '',
  calf_dam_tag: '',
  calf_breed: '',
  calf_note: '',
};

// ── responsive table-like grid (inline styles can't carry @media) ──────────
const CLOG_CSS_ID = 'wcf-cattle-log-css';
if (typeof document !== 'undefined' && !document.getElementById(CLOG_CSS_ID)) {
  const el = document.createElement('style');
  el.id = CLOG_CSS_ID;
  el.textContent =
    '.wcf-clog-grid{display:grid;grid-template-columns:140px 130px minmax(0,1fr) 96px;column-gap:12px;align-items:start;}' +
    '.wcf-clog-mobile-label{display:none;}' +
    '@media (max-width:700px){' +
    '.wcf-clog-grid{display:block;}' +
    '.wcf-clog-head{display:none !important;}' +
    '.wcf-clog-cell{margin-bottom:6px;}' +
    '.wcf-clog-mobile-label{display:inline-block;font-size:10px;font-weight:600;color:#9ca3af;' +
    'text-transform:uppercase;letter-spacing:.4px;margin-right:6px;}' +
    '}';
  document.head.appendChild(el);
}

// ── shared style tokens ─────────────────────────────────────────────────────
const CARD = {background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, fontFamily: 'inherit'};
const CONTROL = {
  fontSize: 13,
  padding: '7px 10px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontFamily: 'inherit',
  width: '100%',
  boxSizing: 'border-box',
  background: 'white',
};
const LBL = {fontSize: 11, color: '#6b7280', display: 'block', marginBottom: 3, fontWeight: 500};
const PRIMARY_BTN = {
  padding: '10px 16px',
  borderRadius: 6,
  border: '1px solid #085041',
  background: '#085041',
  color: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};
const PRIMARY_BTN_DISABLED = {...PRIMARY_BTN, background: '#9ca3af', borderColor: '#9ca3af', cursor: 'not-allowed'};
const SMALL_BTN = {
  padding: '4px 10px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: 'white',
  color: '#374151',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const SMALL_GREEN_BTN = {...SMALL_BTN, border: '1px solid #085041', background: '#085041', color: 'white'};
const SMALL_RED_BTN = {...SMALL_BTN, color: '#b91c1c'};
const LINK_BTN = {
  background: 'none',
  border: 'none',
  padding: 0,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};
const MENTION_CHIP = {background: '#fef3c7', color: '#92400e', borderRadius: 4, padding: '0 4px', fontWeight: 600};
const TAG_CHIP_RESOLVED = {
  background: '#ecfdf5',
  border: '1px solid #a7f3d0',
  color: '#065f46',
  borderRadius: 4,
  padding: '0 4px',
  fontWeight: 600,
};
const TAG_CHIP_UNRESOLVED = {
  background: '#fffbeb',
  border: '1px solid #fde68a',
  color: '#92400e',
  borderRadius: 4,
  padding: '0 4px',
  fontWeight: 600,
};
const TAG_CHIP_AMBIGUOUS = {
  background: '#fef2f2',
  border: '1px solid #fca5a5',
  color: '#b91c1c',
  borderRadius: 4,
  padding: '0 4px',
  fontWeight: 600,
};
const filterBtn = (active) => ({
  padding: '7px 16px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
  border: active ? '2px solid #085041' : '1px solid #d1d5db',
  background: active ? '#085041' : 'white',
  color: active ? 'white' : '#374151',
});

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function PaperAirplaneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22 11 13 2 9 22 2z" />
    </svg>
  );
}

function calfNoteComplete(note) {
  return !!(note && note.calf_herd && note.calf_dob && note.calf_sex && note.calf_origin);
}

// Build the p_calf_notes payload for the given unmatched tags: required
// fields as-is, optional fields only when non-empty.
function buildCalfNotesPayload(unmatchedTags, calfNotes) {
  const out = {};
  for (const tag of unmatchedTags) {
    const n = calfNotes[tag];
    if (!n) continue;
    const cleaned = {};
    if (n.calf_herd) cleaned.calf_herd = n.calf_herd;
    if (n.calf_dob) cleaned.calf_dob = n.calf_dob;
    if (n.calf_sex) cleaned.calf_sex = n.calf_sex;
    if (n.calf_origin) cleaned.calf_origin = n.calf_origin;
    if (n.calf_dam_tag && n.calf_dam_tag.trim()) cleaned.calf_dam_tag = n.calf_dam_tag.trim();
    if (n.calf_breed) cleaned.calf_breed = n.calf_breed;
    if (n.calf_note && n.calf_note.trim()) cleaned.calf_note = n.calf_note.trim();
    if (Object.keys(cleaned).length > 0) out[tag] = cleaned;
  }
  return out;
}

// Field-facing labels for needs-attention queue rows (raw classifier classes
// are machine vocabulary; operators get plain words + friendlyLogError copy).
const QUEUE_ERROR_LABELS = {
  ambiguous_tag: 'Tag matches multiple animals',
  mention_invalid: 'Mention problem',
  validation: 'Needs correction',
  transient: 'Connection problem',
};

function friendlyLogError(err, kind) {
  const msg = err && err.message ? String(err.message) : String(err || 'Unknown error');
  if (kind === 'ambiguous_tag') {
    const m = msg.match(/CATTLE_LOG_AMBIGUOUS_TAG:\s*(\S+)/);
    const tag = m ? m[1] : null;
    return (
      'Tag ' +
      (tag ? '#' + tag.replace(/^#/, '') : '(unknown)') +
      ' matches more than one animal — fix the tag before submitting.'
    );
  }
  if (kind === 'mention_invalid') {
    return 'Mention problem: ' + msg.replace(/^.*CATTLE_LOG_MENTION_INVALID:\s*/, '');
  }
  if (kind === 'validation') {
    return msg.replace(/^.*CATTLE_LOG_VALIDATION:\s*/, '');
  }
  return msg;
}

// ── small render components ─────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function CattleLogAttachmentThumb({sb, att, signedUrls, setSignedUrls}) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att.path]);

  if (!isImage) {
    return (
      <a
        href={url || '#'}
        target="_blank"
        rel="noopener noreferrer"
        data-cattle-log-attachment={att.path}
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
      data-cattle-log-attachment={att.path}
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
          alt={imageAltText(att.name, {fallback: 'Cattle log attachment image'})}
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

// Body renderer: @mention chips (renderMentionSegments over the server's
// mentioned_profile_names) and #tag chips (buildCattleLogBodySegments inside
// the plain-text segments). Resolved tags click through to the cow page.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function EntryBody({body, mentionedNames, tagLinks, onOpenCow}) {
  const segs = renderMentionSegments(body || '', mentionedNames || [], []);
  const out = [];
  let k = 0;
  for (const s of segs) {
    if (s.type === 'mention') {
      out.push(
        <span key={'seg-' + k++} style={MENTION_CHIP}>
          @{s.display}
        </span>,
      );
      continue;
    }
    const parts = buildCattleLogBodySegments(s.text || '');
    for (const p of parts) {
      if (p.type === 'tag') {
        const digits = String(p.value || '').replace(/^#/, '');
        const link = (tagLinks || []).find((l) => String(l.tag) === digits) || null;
        const resolved = !!(link && link.cattle_id);
        if (resolved && onOpenCow) {
          out.push(
            <span
              key={'seg-' + k++}
              role="link"
              tabIndex={0}
              title="Open cow page"
              onClick={() => onOpenCow(link.cattle_id)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') onOpenCow(link.cattle_id);
              }}
              style={{...TAG_CHIP_RESOLVED, cursor: 'pointer'}}
            >
              #{digits}
            </span>,
          );
        } else {
          out.push(
            <span
              key={'seg-' + k++}
              title={resolved ? undefined : 'Not linked to a cow yet'}
              style={resolved ? TAG_CHIP_RESOLVED : TAG_CHIP_UNRESOLVED}
            >
              #{digits}
            </span>,
          );
        }
      } else {
        out.push(
          <span key={'seg-' + k++} style={{whiteSpace: 'pre-wrap'}}>
            {p.value}
          </span>,
        );
      }
    }
  }
  return <div style={{fontSize: 13, color: '#111827', lineHeight: 1.5, overflowWrap: 'anywhere'}}>{out}</div>;
}

// Per-unmatched-tag calf-note panel. Required: herd, DOB (+ estimated flag),
// sex, origin. Optional: dam tag (must match an active current tag when
// provided), breed, extra note.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function CalfNotePanel({tag, note, onChange, originOptions, breedOptions, damTagInvalid}) {
  const n = note || EMPTY_CALF_NOTE;
  const set = (patch) => onChange({...n, ...patch});
  return (
    <div
      data-cattle-log-calf-panel={tag}
      style={{border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 6, padding: '10px 12px', marginTop: 8}}
    >
      <div style={{fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8}}>
        #{tag} doesn't match an active cow — add calf details
      </div>
      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8}}>
        <div>
          <label style={LBL}>Herd *</label>
          <select value={n.calf_herd} onChange={(e) => set({calf_herd: e.target.value})} style={CONTROL}>
            <option value="">{'— select —'}</option>
            {CATTLE_HERDS.map((h) => (
              <option key={h} value={h}>
                {CATTLE_HERD_LABELS[h] || h}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={LBL}>Date of birth *</label>
          <input type="date" value={n.calf_dob} onChange={(e) => set({calf_dob: e.target.value})} style={CONTROL} />
        </div>
        <div>
          <label style={LBL}>Sex *</label>
          <select value={n.calf_sex} onChange={(e) => set({calf_sex: e.target.value})} style={CONTROL}>
            <option value="">{'— select —'}</option>
            {SEX_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={LBL}>Origin *</label>
          <select value={n.calf_origin} onChange={(e) => set({calf_origin: e.target.value})} style={CONTROL}>
            <option value="">{'— select —'}</option>
            {originOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={LBL}>Dam tag (optional)</label>
          <input
            value={n.calf_dam_tag}
            onChange={(e) => set({calf_dam_tag: e.target.value})}
            placeholder="Momma's tag"
            style={CONTROL}
          />
        </div>
        <div>
          <label style={LBL}>Breed (optional)</label>
          <select value={n.calf_breed} onChange={(e) => set({calf_breed: e.target.value})} style={CONTROL}>
            <option value="">{'— select —'}</option>
            {breedOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={LBL}>Note (optional)</label>
          <input
            value={n.calf_note}
            onChange={(e) => set({calf_note: e.target.value})}
            placeholder="Anything else"
            style={CONTROL}
          />
        </div>
      </div>
      {damTagInvalid && (
        <div style={{fontSize: 11, color: '#b91c1c', marginTop: 6}}>
          Dam tag must exactly match an active cow's current tag.
        </div>
      )}
    </div>
  );
}

// Inline preview chips for the composer/editor: where each parsed tag lands.
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
function TagPreviewRow({previews}) {
  if (!previews || previews.length === 0) return null;
  return (
    <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, fontSize: 12}}>
      {previews.map((p) => {
        if (p.status === 'matched') {
          const cow = p.cattle && p.cattle[0];
          return (
            <span key={p.tag} style={TAG_CHIP_RESOLVED}>
              #{p.tag} → {cow ? (cow.tag || cow.id) + ' · ' + (CATTLE_HERD_LABELS[cow.herd] || cow.herd) : 'matched'}
            </span>
          );
        }
        if (p.status === 'ambiguous') {
          return (
            <span key={p.tag} style={TAG_CHIP_AMBIGUOUS}>
              #{p.tag} — matches multiple animals
            </span>
          );
        }
        return (
          <span key={p.tag} style={TAG_CHIP_UNRESOLVED}>
            #{p.tag} — no active cow (calf details below)
          </span>
        );
      })}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────

export default function CattleLogPage({sb, authState, Header}) {
  const {useState, useEffect, useMemo, useCallback, useRef} = React;
  const location = useLocation();
  const navigate = useNavigate();

  const role = authState && authState !== false ? authState.role : null;
  const myProfileId = authState && authState !== false && authState.user ? authState.user.id : null;
  const allowed = ALLOWED_ROLES.includes(role);
  const canManage = MANAGER_ROLES.includes(role);

  // ── connectivity ──
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // ── offline queue (create-only) ──
  const queue = useCattleLogQueue(sb);
  const queueRows = queue && Array.isArray(queue.entries) ? queue.entries : [];
  const queuedRows = queueRows.filter((r) => r.status === 'queued');
  const attentionRows = queueRows.filter((r) => r.status === 'needs_attention');

  // ── list state (fail-closed: loading → loadError → content) ──
  const [entries, setEntries] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('issues');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [pageNotice, setPageNotice] = useState(null);
  const [signedUrls, setSignedUrls] = useState({});
  const [issueBusy, setIssueBusy] = useState({});
  const [deleteTargetId, setDeleteTargetId] = useState(null);
  const [showHowTo, setShowHowTo] = useState(false);
  // Query generation — bumped whenever a fresh first-page query starts
  // (filter switch, search change, reload). Any response whose captured
  // generation no longer matches is stale (e.g. a slow 'Load more' from a
  // previous filter/search state) and must be discarded, never merged.
  const queryGenRef = useRef(0);
  // Keyset cursor captured from the last RAW fetched row at fetch time —
  // independent of optimistic issue-clears/deletes, which can empty the
  // visible list without exhausting the server's history.
  const loadMoreCursorRef = useRef(null);

  // Debounced server-side search (~300ms).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    const gen = ++queryGenRef.current;
    setLoading(true);
    setLoadError(null);
    setEntries([]);
    setHasMore(false);
    loadMoreCursorRef.current = null;
    (async () => {
      try {
        const res = await listCattleLogEntries(sb, {filter, search: search || null, limit: PAGE_SIZE});
        if (gen !== queryGenRef.current) return;
        if (cancelled) return;
        const list = Array.isArray(res && res.entries) ? res.entries : [];
        const lastRaw = list[list.length - 1];
        loadMoreCursorRef.current = lastRaw ? {created_at: lastRaw.created_at, id: lastRaw.id} : null;
        setEntries(list);
        setHasMore(!!(res && res.has_more));
        setLoading(false);
      } catch (e) {
        if (gen !== queryGenRef.current) return;
        if (cancelled) return;
        setEntries([]);
        setHasMore(false);
        setLoadError({kind: 'error', message: 'Could not load the Cattle Log. (' + (e.message || e) + ')'});
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, filter, search, reloadKey, allowed]);

  const loadMore = useCallback(async () => {
    // Cursor comes from the last RAW fetched row (captured at fetch time),
    // so pagination survives optimistic removals that empty the visible list.
    const before = loadMoreCursorRef.current;
    if (loadingMore || !before) return;
    // Capture the generation: a filter/search/reload landing while this
    // request is in flight makes the response stale — drop it on arrival.
    const gen = queryGenRef.current;
    setLoadingMore(true);
    try {
      const res = await listCattleLogEntries(sb, {filter, search: search || null, limit: PAGE_SIZE, before});
      if (gen !== queryGenRef.current) return;
      const next = Array.isArray(res && res.entries) ? res.entries : [];
      const lastRaw = next[next.length - 1];
      if (lastRaw) loadMoreCursorRef.current = {created_at: lastRaw.created_at, id: lastRaw.id};
      setEntries((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...next.filter((x) => !seen.has(x.id))];
      });
      setHasMore(!!(res && res.has_more));
    } catch (e) {
      if (gen !== queryGenRef.current) return;
      setPageNotice({kind: 'error', message: 'Could not load more entries. (' + (e.message || e) + ')'});
    } finally {
      setLoadingMore(false);
    }
  }, [sb, filter, search, loadingMore]);

  // When the offline queue drains (a queued row synced), refresh the list so
  // the replayed entry shows in its real position.
  const prevQueuedCountRef = useRef(queuedRows.length);
  useEffect(() => {
    if (queuedRows.length < prevQueuedCountRef.current) setReloadKey((k) => k + 1);
    prevQueuedCountRef.current = queuedRows.length;
  }, [queuedRows.length]);

  // Mention deep-link: scroll to #comment-<id> once content is up. If the
  // anchor isn't in the loaded rows (non-issue entry hidden by the default
  // Issues filter, or beyond the first page), widen to 'All' ONCE and let
  // the reload re-run this effect; if it's still absent, point at search
  // instead of silently showing nothing. Both refs fire at most once so the
  // fallback can never loop.
  const anchorFallbackTriedRef = useRef(false);
  const anchorNoticeShownRef = useRef(false);
  useEffect(() => {
    if (loading || loadError) return;
    const h = location.hash || '';
    if (!h.startsWith('#comment-')) return;
    const el = document.getElementById(h.slice(1));
    if (el) {
      if (el.scrollIntoView) el.scrollIntoView({block: 'center'});
      return;
    }
    if (!anchorFallbackTriedRef.current) {
      anchorFallbackTriedRef.current = true;
      if (filter === 'issues') {
        setFilter('all');
        return;
      }
    }
    if (!anchorNoticeShownRef.current) {
      anchorNoticeShownRef.current = true;
      setPageNotice({kind: 'info', message: 'Entry not in the most recent entries — try search.'});
    }
  }, [loading, loadError, entries.length, location.hash, filter]);

  // ── active-cattle preview list (tag matching is server-authoritative;
  //    this is the client preview per the contract) ──
  const [cattleRows, setCattleRows] = useState(null);
  const [cattleStatus, setCattleStatus] = useState('loading'); // loading | loaded | error
  const [cattleReload, setCattleReload] = useState(0);
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setCattleStatus('loading');
    sb.from('cattle')
      .select('id, tag, old_tags, herd, sex, birth_date, origin, breed')
      .is('deleted_at', null)
      .in('herd', CATTLE_HERDS)
      .then(({data, error}) => {
        if (cancelled) return;
        if (error) {
          setCattleRows(null);
          setCattleStatus('error');
        } else {
          setCattleRows(data || []);
          setCattleStatus('loaded');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sb, cattleReload, allowed]);

  const previewReady = cattleStatus === 'loaded';
  const originOptions = useMemo(
    () =>
      [...new Set((cattleRows || []).map((c) => c.origin).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    [cattleRows],
  );
  const breedOptions = useMemo(
    () =>
      [...new Set((cattleRows || []).map((c) => c.breed).filter(Boolean))].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    [cattleRows],
  );
  const activeTagSet = useMemo(
    () => new Set((cattleRows || []).map((c) => String(c.tag || '')).filter(Boolean)),
    [cattleRows],
  );

  // ── mentionable profiles (cattle-log-specific RPC; cached promise) ──
  const mentionablesPromiseRef = useRef(null);
  const [mentionables, setMentionables] = useState([]);
  const ensureMentionables = useCallback(() => {
    if (!mentionablesPromiseRef.current) {
      mentionablesPromiseRef.current = loadCattleLogMentionableProfiles(sb)
        .then((list) => {
          const arr = Array.isArray(list) ? list : [];
          setMentionables(arr);
          return arr;
        })
        .catch(() => {
          mentionablesPromiseRef.current = null;
          return [];
        });
    }
    return mentionablesPromiseRef.current;
  }, [sb]);
  useEffect(() => {
    if (allowed) ensureMentionables();
  }, [allowed, ensureMentionables]);
  const mentionLoader = useCallback(async () => {
    const list = await ensureMentionables();
    return list.filter((p) => p.id !== myProfileId);
  }, [ensureMentionables, myProfileId]);

  // Best-effort name → uuid recovery for edit prefill (the list RPC returns
  // mentioned_profile_names, not uuids).
  const mentionIdsForNames = useCallback(
    (names) => {
      const out = [];
      (names || []).forEach((n) => {
        const p = mentionables.find((x) => x.full_name === n);
        if (p && !out.includes(p.id)) out.push(p.id);
      });
      return out;
    },
    [mentionables],
  );

  // ── composer state ──
  const [draft, setDraft] = useState({body: '', mentions: []});
  const [draftFiles, setDraftFiles] = useState([]);
  const [composerIssue, setComposerIssue] = useState(true);
  const [calfNotes, setCalfNotes] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [composerNotice, setComposerNotice] = useState(null);
  const fileInputRef = useRef(null);

  const parsedTags = useMemo(() => parseCattleLogTags(draft.body), [draft.body]);
  const tagPreviews = useMemo(() => {
    if (!previewReady || parsedTags.length === 0) return [];
    return parsedTags.map((tag) => ({tag, ...matchTagToCattle(tag, cattleRows || [])}));
  }, [parsedTags, cattleRows, previewReady]);
  const unmatchedTags = useMemo(
    () => tagPreviews.filter((p) => p.status === 'unmatched').map((p) => p.tag),
    [tagPreviews],
  );
  const ambiguousTags = useMemo(
    () => tagPreviews.filter((p) => p.status === 'ambiguous').map((p) => p.tag),
    [tagPreviews],
  );

  const damTagInvalidFor = useCallback(
    (tag) => {
      const v = ((calfNotes[tag] && calfNotes[tag].calf_dam_tag) || '').trim();
      return !!v && !activeTagSet.has(v);
    },
    [calfNotes, activeTagSet],
  );

  const incompleteCalfTags = unmatchedTags.filter((t) => !calfNoteComplete(calfNotes[t]) || damTagInvalidFor(t));
  const forceIssue = unmatchedTags.length > 0;
  const composerIssueChecked = forceIssue ? true : composerIssue;
  const trimmedLen = draft.body.trim().length;

  // Online submits gate on the tag preview; offline submits only need body
  // length (calf notes are not required offline per the contract).
  const tagGateActive = online && parsedTags.length > 0;
  const submitBlockReason = !allowed
    ? 'No access'
    : trimmedLen < MIN_BODY_LEN
      ? 'Write at least ' + MIN_BODY_LEN + ' characters.'
      : trimmedLen > MAX_BODY_LEN
        ? 'Entry is too long — max ' + MAX_BODY_LEN + ' characters (currently ' + trimmedLen + ').'
        : tagGateActive && !previewReady
          ? cattleStatus === 'error'
            ? 'Cattle list failed to load — retry below to enable #tag checks.'
            : 'Checking tags against the herd list…'
          : tagGateActive && ambiguousTags.length > 0
            ? 'Tag ' +
              ambiguousTags.map((t) => '#' + t).join(', ') +
              ' matches more than one animal — fix before submitting.'
            : tagGateActive && incompleteCalfTags.length > 0
              ? 'Complete calf details for ' + incompleteCalfTags.map((t) => '#' + t).join(', ') + '.'
              : null;
  const canSubmit = !submitting && !submitBlockReason;

  function resetComposer() {
    setDraft({body: '', mentions: []});
    setDraftFiles([]);
    setCalfNotes({});
    setComposerIssue(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function onPickFiles(e, currentCount, setter, noticeSetter) {
    const setNotice = noticeSetter || setComposerNotice;
    const incoming = Array.from(e.target.files || []);
    const room = MAX_COMMENT_ATTACHMENTS - currentCount;
    const tooBig = incoming.find((f) => !/^image\//.test(f.type || '') && f.size > MAX_DOCUMENT_BYTES);
    if (tooBig) {
      setNotice({
        kind: 'error',
        message: 'Photo too large: ' + tooBig.name + ' (max ' + Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024) + 'MB).',
      });
      return;
    }
    if (incoming.length > room) {
      setNotice({kind: 'warning', message: 'Max ' + MAX_COMMENT_ATTACHMENTS + ' attachments per entry.'});
    }
    setter(incoming.slice(0, Math.max(room, 0)));
  }

  async function uploadFiles(entryId, files, keyPrefix) {
    const metas = [];
    for (let i = 0; i < files.length; i++) {
      const meta = await uploadCommentAttachment(sb, 'cattle.log', 'cattle-log', keyPrefix + '-' + (i + 1), files[i]);
      metas.push(meta);
    }
    return metas;
  }

  async function enqueueDraft(entryId, calfPayload) {
    if (!queue || typeof queue.enqueue !== 'function') {
      setComposerNotice({kind: 'error', message: 'Offline queue unavailable — try again with a connection.'});
      return false;
    }
    await queue.enqueue(
      {
        id: entryId,
        body: draft.body,
        mentions: draft.mentions,
        isIssue: composerIssueChecked,
        calfNotes: calfPayload,
      },
      draftFiles,
    );
    resetComposer();
    setComposerNotice({
      kind: 'info',
      message: 'Saved on this device — the entry will send automatically when you reconnect.',
    });
    return true;
  }

  async function onSubmit() {
    setComposerNotice(null);
    if (trimmedLen < MIN_BODY_LEN) {
      setComposerNotice({kind: 'error', message: 'Write at least ' + MIN_BODY_LEN + ' characters.'});
      return;
    }
    // Checked here (not only via submitBlockReason) because the OFFLINE path
    // below bypasses the block-reason gate — an over-cap body must never
    // reach the queue, where replay would dead-end as needs-attention.
    if (trimmedLen > MAX_BODY_LEN) {
      setComposerNotice({
        kind: 'error',
        message: 'Entry is too long — max ' + MAX_BODY_LEN + ' characters (currently ' + trimmedLen + ').',
      });
      return;
    }
    const entryId = generateCattleLogEntryId();
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const calfPayload = buildCalfNotesPayload(unmatchedTags, calfNotes);

    if (isOffline) {
      setSubmitting(true);
      try {
        await enqueueDraft(entryId, calfPayload);
      } catch (e) {
        setComposerNotice({kind: 'error', message: 'Could not queue the entry. (' + (e.message || e) + ')'});
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (submitBlockReason) {
      setComposerNotice({kind: 'error', message: submitBlockReason});
      return;
    }

    setSubmitting(true);
    try {
      const attachments = await uploadFiles(entryId, draftFiles, entryId);
      await submitCattleLogEntry(sb, {
        id: entryId,
        body: draft.body,
        mentions: draft.mentions,
        attachments,
        isIssue: composerIssueChecked,
        calfNotes: calfPayload,
      });
      resetComposer();
      setComposerNotice({kind: 'success', message: 'Log entry submitted.'});
      setReloadKey((k) => k + 1);
    } catch (err) {
      const kind = classifyCattleLogError(err);
      if (kind === 'transient') {
        try {
          await enqueueDraft(entryId, calfPayload);
        } catch (e2) {
          setComposerNotice({
            kind: 'error',
            message: 'Submit failed and the entry could not be queued. (' + (e2.message || e2) + ')',
          });
        }
      } else {
        setComposerNotice({kind: 'error', message: friendlyLogError(err, kind)});
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ── edit state (author-only, online-only) ──
  const [editing, setEditing] = useState(null);
  // editing = {id, body, mentions, keptAttachments, newFiles, calfNotes, busy, notice}
  const editFileInputRef = useRef(null);

  const editParsedTags = useMemo(() => (editing ? parseCattleLogTags(editing.body) : []), [editing]);
  // Tags that already have a link row on the entry being edited (resolved OR
  // unresolved — read from the entry's tags array) are exempt from preview
  // matching: the server preserves existing links across edits and discards
  // client calf notes for them, so demanding calf details for a cow that has
  // since left the active herd would trap the author. Only tags NEWLY ADDED
  // by this edit go through preview matching / calf-note collection.
  const editNewTags = useMemo(() => {
    if (!editing) return [];
    const existing = new Set(editing.existingTags || []);
    return editParsedTags.filter((tag) => !existing.has(tag));
  }, [editing, editParsedTags]);
  const editTagPreviews = useMemo(() => {
    if (!editing || !previewReady || editNewTags.length === 0) return [];
    return editNewTags.map((tag) => ({tag, ...matchTagToCattle(tag, cattleRows || [])}));
  }, [editing, editNewTags, cattleRows, previewReady]);
  const editUnmatched = useMemo(
    () => editTagPreviews.filter((p) => p.status === 'unmatched').map((p) => p.tag),
    [editTagPreviews],
  );
  const editAmbiguous = useMemo(
    () => editTagPreviews.filter((p) => p.status === 'ambiguous').map((p) => p.tag),
    [editTagPreviews],
  );
  const editDamInvalidFor = useCallback(
    (tag) => {
      const v = ((editing && editing.calfNotes[tag] && editing.calfNotes[tag].calf_dam_tag) || '').trim();
      return !!v && !activeTagSet.has(v);
    },
    [editing, activeTagSet],
  );
  const editIncompleteCalf = editing
    ? editUnmatched.filter((t) => !calfNoteComplete(editing.calfNotes[t]) || editDamInvalidFor(t))
    : [];
  const editTrimmedLen = editing ? editing.body.trim().length : 0;
  const editBlockReason = !editing
    ? null
    : !online
      ? 'Editing requires a connection.'
      : editTrimmedLen < MIN_BODY_LEN
        ? 'Write at least ' + MIN_BODY_LEN + ' characters.'
        : editNewTags.length > 0 && !previewReady
          ? cattleStatus === 'error'
            ? 'Cattle list failed to load — retry to enable #tag checks.'
            : 'Checking tags against the herd list…'
          : editAmbiguous.length > 0
            ? 'Tag ' + editAmbiguous.map((t) => '#' + t).join(', ') + ' matches more than one animal.'
            : editIncompleteCalf.length > 0
              ? 'Complete calf details for ' + editIncompleteCalf.map((t) => '#' + t).join(', ') + '.'
              : null;

  function startEdit(entry) {
    setEditing({
      id: entry.id,
      body: entry.body || '',
      mentions: mentionIdsForNames(entry.mentioned_profile_names),
      // Tags with an existing link row on this entry (resolved or
      // unresolved) — exempt from the calf-note requirement and ambiguity
      // blocking above (the server keeps those links regardless of the
      // cow's current herd state, and discards client calf notes for them).
      existingTags: (entry.tags || []).map((l) => String(l.tag)),
      // Mention baseline for saveEdit: the names mentioned today plus a
      // touch flag, so an untouched edit can preserve mentions server-side
      // (p_mentions null) instead of round-tripping a possibly-lossy array.
      originalMentionNames: Array.isArray(entry.mentioned_profile_names) ? entry.mentioned_profile_names : [],
      mentionsTouched: false,
      keptAttachments: Array.isArray(entry.attachments) ? entry.attachments : [],
      newFiles: [],
      calfNotes: {},
      busy: false,
      notice: null,
    });
  }

  // Mention param for the edit RPC. edit_cattle_log_entry treats p_mentions
  // NULL as 'preserve existing mentions; no new notifications' (an empty
  // array still clears). Send null when this edit did not deliberately
  // change mentions (displayed names match the entry's
  // mentioned_profile_names and the picker was never used), or when the
  // name → uuid mapping can't vouch for every mention still displayed in
  // the body — the list RPC returns names, not uuids, so a partial mapping
  // would silently drop mentions on save.
  function editMentionsParam() {
    if (!editing) return null;
    const originalNames = [...new Set(editing.originalMentionNames || [])];
    const knownNames = [...new Set([...originalNames, ...mentionables.map((p) => p.full_name).filter(Boolean)])];
    const displayedNames = [
      ...new Set(
        renderMentionSegments(editing.body || '', knownNames, [])
          .filter((s) => s.type === 'mention')
          .map((s) => s.display),
      ),
    ];
    const namesUnchanged =
      displayedNames.length === originalNames.length && displayedNames.every((n) => originalNames.includes(n));
    if (!editing.mentionsTouched && namesUnchanged) return null;
    const resolvesAll = displayedNames.every((n) => mentionables.some((p) => p.full_name === n));
    if (!resolvesAll) return null;
    return editing.mentions;
  }

  async function saveEdit() {
    if (!editing || editing.busy) return;
    if (editBlockReason) {
      setEditing((prev) => (prev ? {...prev, notice: {kind: 'error', message: editBlockReason}} : prev));
      return;
    }
    setEditing((prev) => (prev ? {...prev, busy: true, notice: null} : prev));
    try {
      const newMetas = await uploadFiles(editing.id, editing.newFiles, editing.id + '-e' + Date.now().toString(36));
      const attachments = [...editing.keptAttachments, ...newMetas];
      await editCattleLogEntry(sb, {
        id: editing.id,
        body: editing.body,
        mentions: editMentionsParam(),
        attachments,
        calfNotes: buildCalfNotesPayload(editUnmatched, editing.calfNotes),
      });
      setEditing(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      const kind = classifyCattleLogError(err);
      const message =
        kind === 'transient'
          ? 'Connection problem — your changes were not saved. Try again.'
          : friendlyLogError(err, kind);
      setEditing((prev) => (prev ? {...prev, busy: false, notice: {kind: 'error', message}} : prev));
    }
  }

  // ── issue toggle (management/admin; optimistic with revert) ──
  async function toggleIssue(entry, next) {
    if (!canManage || issueBusy[entry.id]) return;
    setIssueBusy((prev) => ({...prev, [entry.id]: true}));
    setEntries((prev) => prev.map((e) => (e.id === entry.id ? {...e, is_issue: next} : e)));
    try {
      await setCattleLogIssue(sb, entry.id, next);
      if (filter === 'issues' && !next) {
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      }
    } catch (err) {
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? {...e, is_issue: entry.is_issue} : e)));
      setPageNotice({kind: 'error', message: 'Could not update the issue state. (' + (err.message || err) + ')'});
    } finally {
      setIssueBusy((prev) => {
        const n = {...prev};
        delete n[entry.id];
        return n;
      });
    }
  }

  async function confirmDelete() {
    const id = deleteTargetId;
    if (!id) return;
    try {
      await deleteCattleLogEntry(sb, id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setPageNotice({kind: 'error', message: 'Delete failed. (' + (err.message || err) + ')'});
    }
  }

  const openCow = useCallback((cattleId) => navigate('/cattle/herds/' + cattleId), [navigate]);
  // Light users can't reach /cattle/herds/<id> (program containment bounces
  // them to the portal), so their resolved #tag chips render as plain,
  // non-clickable chips (EntryBody only adds link semantics when onOpenCow
  // is provided). Every other role keeps the click-through to the cow page.
  const tagChipOpenCow = role === 'light' ? null : openCow;

  // ── render ──
  if (!allowed) {
    return (
      <div style={{minHeight: '100vh', background: '#f1f3f2'}} data-cattle-log-error="1">
        {typeof Header === 'function' ? <Header /> : null}
        <div style={{padding: '1.25rem', maxWidth: 720, margin: '0 auto'}}>
          <InlineNotice notice={{kind: 'error', message: 'You do not have access to the Cattle Log.'}} />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{minHeight: '100vh', background: '#f1f3f2'}}
      data-cattle-log-loaded={!loading && !loadError ? '1' : undefined}
      data-cattle-log-error={loadError ? '1' : undefined}
    >
      {typeof Header === 'function' ? <Header /> : null}
      {showHowTo && <CattleLogHowTo onClose={() => setShowHowTo(false)} canManageIssues={canManage} />}
      {deleteTargetId && (
        <DeleteModal
          msg="This permanently removes the log entry from the Cattle Log and from every linked cow page."
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTargetId(null)}
        />
      )}
      <div
        style={{
          padding: '1.25rem',
          maxWidth: 1100,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {/* Title row */}
        <div style={{display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap'}}>
          <div style={{fontSize: 20, fontWeight: 700, color: '#111827'}}>Cattle Log</div>
          <span style={{flex: 1}} />
          <button
            data-cattle-log-howto="1"
            onClick={() => setShowHowTo(true)}
            style={{
              background: 'white',
              border: '1px solid #cfe6d8',
              borderRadius: 999,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 600,
              color: '#085041',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            📖 How to use
          </button>
        </div>

        {!online && (
          <InlineNotice
            notice={{
              kind: 'info',
              message: 'You appear to be offline. New entries are saved on this device and send automatically.',
            }}
          />
        )}
        <InlineNotice notice={pageNotice} onDismiss={() => setPageNotice(null)} />

        {/* ── Composer ── */}
        <div style={CARD} data-cattle-log-composer="1">
          <MentionTextarea
            sb={sb}
            value={draft.body}
            mentions={draft.mentions}
            onChange={(next) => setDraft(next)}
            placeholder="Log a note… use #123 to link a cow, @ to mention a teammate"
            disabled={submitting}
            loadProfiles={mentionLoader}
          />
          {online && parsedTags.length > 0 && cattleStatus === 'error' && (
            <div style={{marginTop: 6, display: 'flex', alignItems: 'center', gap: 8}}>
              <InlineNotice notice={{kind: 'error', message: 'Could not load the cattle list for #tag checks.'}} />
              <button style={SMALL_BTN} onClick={() => setCattleReload((k) => k + 1)}>
                Retry
              </button>
            </div>
          )}
          <TagPreviewRow previews={tagPreviews} />
          {online &&
            unmatchedTags.map((tag) => (
              <CalfNotePanel
                key={tag}
                tag={tag}
                note={calfNotes[tag]}
                onChange={(next) => setCalfNotes((prev) => ({...prev, [tag]: next}))}
                originOptions={originOptions}
                breedOptions={breedOptions}
                damTagInvalid={damTagInvalidFor(tag)}
              />
            ))}
          <div style={{marginTop: 8}}>
            <InlineNotice notice={composerNotice} onDismiss={() => setComposerNotice(null)} />
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 8,
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <div style={{display: 'flex', alignItems: 'center', gap: 12, fontSize: 12, color: '#6b7280'}}>
              <label style={{cursor: 'pointer', color: '#2563eb', fontSize: 12}}>
                📎 Add photos
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
                  multiple
                  style={{display: 'none'}}
                  onChange={(e) => onPickFiles(e, 0, setDraftFiles)}
                />
              </label>
              {draftFiles.length > 0 && (
                <span>
                  {draftFiles.length} photo{draftFiles.length > 1 ? 's' : ''} selected
                </span>
              )}
              <label
                style={{display: 'flex', alignItems: 'center', gap: 5, cursor: forceIssue ? 'default' : 'pointer'}}
              >
                <input
                  type="checkbox"
                  checked={composerIssueChecked}
                  disabled={forceIssue || submitting}
                  onChange={(e) => setComposerIssue(e.target.checked)}
                />
                <span style={{fontWeight: 600, color: '#374151'}}>Issue</span>
                {forceIssue && <span style={{fontSize: 11, whiteSpace: 'nowrap'}}>(required for unknown tags)</span>}
              </label>
            </div>
            <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
              {submitBlockReason && trimmedLen >= MIN_BODY_LEN && (
                <span style={{fontSize: 11, color: '#9a3412'}}>{submitBlockReason}</span>
              )}
              <button
                type="button"
                data-cattle-log-submit="1"
                aria-label="Submit log entry"
                title="Submit log entry"
                onClick={onSubmit}
                disabled={submitting || (!canSubmit && online)}
                style={submitting || (!canSubmit && online) ? PRIMARY_BTN_DISABLED : PRIMARY_BTN}
              >
                <PaperAirplaneIcon />
                {submitting ? 'Sending…' : 'Submit'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Filters + search ── */}
        <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
          <button
            data-cattle-log-filter-issues="1"
            onClick={() => setFilter('issues')}
            style={filterBtn(filter === 'issues')}
          >
            Issues
          </button>
          <button data-cattle-log-filter-all="1" onClick={() => setFilter('all')} style={filterBtn(filter === 'all')}>
            All
          </button>
          <input
            data-cattle-log-search="1"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search text, author, or #tag…"
            style={{...CONTROL, maxWidth: 280}}
          />
        </div>

        {/* ── Offline queue rows (top of the list) ── */}
        {(queuedRows.length > 0 || attentionRows.length > 0) && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 8}}>
            {attentionRows.map((r) => (
              <div
                key={r.id}
                data-cattle-log-needs-attention-row={r.id}
                style={{
                  border: '1px solid #fca5a5',
                  background: '#fef2f2',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: '#7f1d1d',
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4}}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      background: '#b91c1c',
                      color: 'white',
                      borderRadius: 999,
                      padding: '1px 8px',
                    }}
                  >
                    NEEDS ATTENTION
                  </span>
                  <span style={{fontWeight: 600}}>{QUEUE_ERROR_LABELS[r.errorClass] || 'Error'}</span>
                  <span style={{color: '#9ca3af'}}>{fmtCentralDateTime(r.createdAt)}</span>
                </div>
                <div style={{color: '#111827', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBottom: 4}}>
                  {(r.payload && r.payload.body) || ''}
                </div>
                {r.errorMessage && (
                  <div style={{marginBottom: 6, color: '#b91c1c'}}>
                    {friendlyLogError({message: r.errorMessage}, r.errorClass)}
                  </div>
                )}
                <div style={{display: 'flex', gap: 8}}>
                  <button
                    style={SMALL_GREEN_BTN}
                    data-cattle-log-queue-retry={r.id}
                    onClick={() => queue && queue.retry && queue.retry(r.id)}
                  >
                    Retry
                  </button>
                  <button
                    style={SMALL_RED_BTN}
                    data-cattle-log-queue-discard={r.id}
                    onClick={() => queue && queue.discard && queue.discard(r.id)}
                  >
                    Discard
                  </button>
                </div>
              </div>
            ))}
            {queuedRows.map((r) => (
              <div
                key={r.id}
                data-cattle-log-queued-row={r.id}
                style={{
                  border: '1px solid #fde68a',
                  background: '#fffbeb',
                  borderRadius: 8,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: '#78716c',
                }}
              >
                <div style={{display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4}}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      background: '#d97706',
                      color: 'white',
                      borderRadius: 999,
                      padding: '1px 8px',
                    }}
                  >
                    QUEUED
                  </span>
                  <span>will send when reconnected</span>
                  <span style={{color: '#9ca3af'}}>{fmtCentralDateTime(r.createdAt)}</span>
                </div>
                <div style={{color: '#111827', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'}}>
                  {(r.payload && r.payload.body) || ''}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── List (fail-closed) ── */}
        {loading ? (
          <div style={{...CARD, color: '#6b7280', fontSize: 13}}>Loading…</div>
        ) : loadError ? (
          <div style={CARD}>
            <InlineNotice notice={loadError} />
            <button style={{...SMALL_BTN, marginTop: 8}} onClick={() => setReloadKey((k) => k + 1)}>
              Retry
            </button>
          </div>
        ) : (
          <div style={{...CARD, paddingTop: 6, paddingBottom: 6}}>
            <div
              className="wcf-clog-grid wcf-clog-head"
              style={{
                padding: '8px 0',
                borderBottom: '1px solid #e5e7eb',
                fontSize: 11,
                fontWeight: 600,
                color: '#6b7280',
                textTransform: 'uppercase',
                letterSpacing: 0.4,
              }}
            >
              <div>When</div>
              <div>Author</div>
              <div>Comment</div>
              <div>Issue</div>
            </div>
            {entries.length === 0 && (
              <div style={{padding: '14px 0', fontSize: 13, color: '#6b7280'}}>
                {filter === 'issues' ? 'No open issues.' : 'No log entries yet.'}
              </div>
            )}
            {entries.map((e) => {
              const isAuthor = e.author_profile_id === myProfileId;
              const isEditing = editing && editing.id === e.id;
              const unresolvedLinks = (e.tags || []).filter((l) => !l.cattle_id);
              return (
                <div
                  key={e.id}
                  id={'comment-' + e.id}
                  data-cattle-log-row={e.id}
                  className="wcf-clog-grid"
                  style={{padding: '10px 0', borderBottom: '1px solid #f3f4f6'}}
                >
                  <div className="wcf-clog-cell" style={{fontSize: 12, color: '#6b7280'}}>
                    {fmtCentralDateTime(e.created_at)}
                  </div>
                  <div className="wcf-clog-cell" style={{fontSize: 13, fontWeight: 600, color: '#111827'}}>
                    {e.author_name || 'Unknown user'}
                  </div>
                  <div className="wcf-clog-cell" style={{minWidth: 0}}>
                    {isEditing ? (
                      <div>
                        <MentionTextarea
                          sb={sb}
                          value={editing.body}
                          mentions={editing.mentions}
                          onChange={(next) =>
                            setEditing((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    body: next.body,
                                    mentions: next.mentions,
                                    // The picker is the only mutator of
                                    // mentions[] (typing passes the array
                                    // through) — a new reference means a pick.
                                    mentionsTouched: prev.mentionsTouched || next.mentions !== prev.mentions,
                                  }
                                : prev,
                            )
                          }
                          disabled={editing.busy}
                          loadProfiles={mentionLoader}
                        />
                        <TagPreviewRow previews={editTagPreviews} />
                        {editUnmatched.map((tag) => (
                          <CalfNotePanel
                            key={tag}
                            tag={tag}
                            note={editing.calfNotes[tag]}
                            onChange={(next) =>
                              setEditing((prev) =>
                                prev ? {...prev, calfNotes: {...prev.calfNotes, [tag]: next}} : prev,
                              )
                            }
                            originOptions={originOptions}
                            breedOptions={breedOptions}
                            damTagInvalid={editDamInvalidFor(tag)}
                          />
                        ))}
                        {(editing.keptAttachments.length > 0 || editing.newFiles.length > 0) && (
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, fontSize: 11}}>
                            {editing.keptAttachments.map((a) => (
                              <span
                                key={a.path}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  padding: '3px 8px',
                                  borderRadius: 6,
                                  border: '1px solid #e5e7eb',
                                  background: '#f3f4f6',
                                  color: '#374151',
                                }}
                              >
                                {a.name || 'photo'}
                                <button
                                  type="button"
                                  aria-label={'Remove attachment ' + (a.name || '')}
                                  onClick={() =>
                                    setEditing((prev) =>
                                      prev
                                        ? {
                                            ...prev,
                                            keptAttachments: prev.keptAttachments.filter((x) => x.path !== a.path),
                                          }
                                        : prev,
                                    )
                                  }
                                  style={{...LINK_BTN, color: '#b91c1c'}}
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            {editing.newFiles.map((f, i) => (
                              <span key={'new-' + i} style={{color: '#6b7280'}}>
                                + {f.name}
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{marginTop: 6}}>
                          <InlineNotice
                            notice={editing.notice}
                            onDismiss={() => setEditing((prev) => (prev ? {...prev, notice: null} : prev))}
                          />
                        </div>
                        <div style={{display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap'}}>
                          <label style={{cursor: 'pointer', color: '#2563eb', fontSize: 12}}>
                            📎 Add photos
                            <input
                              ref={editFileInputRef}
                              type="file"
                              accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
                              multiple
                              style={{display: 'none'}}
                              onChange={(ev) =>
                                onPickFiles(
                                  ev,
                                  editing.keptAttachments.length,
                                  (files) => setEditing((prev) => (prev ? {...prev, newFiles: files} : prev)),
                                  (notice) => setEditing((prev) => (prev ? {...prev, notice} : prev)),
                                )
                              }
                            />
                          </label>
                          <span style={{flex: 1}} />
                          {editBlockReason && editTrimmedLen >= MIN_BODY_LEN && (
                            <span style={{fontSize: 11, color: '#9a3412'}}>{editBlockReason}</span>
                          )}
                          <button
                            style={SMALL_BTN}
                            disabled={editing.busy}
                            onClick={() => setEditing(null)}
                            data-cattle-log-edit-cancel="1"
                          >
                            Cancel
                          </button>
                          <button
                            style={
                              editing.busy || editBlockReason ? {...SMALL_GREEN_BTN, opacity: 0.6} : SMALL_GREEN_BTN
                            }
                            disabled={editing.busy || !!editBlockReason}
                            onClick={saveEdit}
                            data-cattle-log-edit-save="1"
                          >
                            {editing.busy ? 'Saving…' : 'Save'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <EntryBody
                          body={e.body}
                          mentionedNames={e.mentioned_profile_names}
                          tagLinks={e.tags}
                          onOpenCow={tagChipOpenCow}
                        />
                        {Array.isArray(e.attachments) && e.attachments.length > 0 && (
                          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6}}>
                            {e.attachments.map((att, i) => (
                              <CattleLogAttachmentThumb
                                key={att.path || i}
                                sb={sb}
                                att={att}
                                signedUrls={signedUrls}
                                setSignedUrls={setSignedUrls}
                              />
                            ))}
                          </div>
                        )}
                        {unresolvedLinks.length > 0 && (
                          <div
                            data-cattle-log-unresolved-note="1"
                            style={{
                              marginTop: 6,
                              fontSize: 12,
                              color: '#92400e',
                              background: '#fffbeb',
                              border: '1px solid #fde68a',
                              borderRadius: 6,
                              padding: '6px 8px',
                            }}
                          >
                            <div>
                              {unresolvedLinks.map((l) => '#' + l.tag).join(', ')}{' '}
                              {unresolvedLinks.length === 1 ? 'is' : 'are'} not linked to a cow yet — this entry links
                              automatically when a matching tag is added.
                            </div>
                            {unresolvedLinks
                              .filter((l) => l.calf_herd || l.calf_dob || l.calf_sex || l.calf_origin)
                              .map((l) => (
                                <div key={l.tag} style={{marginTop: 2, fontSize: 11, color: '#9a3412'}}>
                                  #{l.tag} calf details: {CATTLE_HERD_LABELS[l.calf_herd] || l.calf_herd || '—'}
                                  {l.calf_dob ? ' · DOB ' + l.calf_dob : ''}
                                  {l.calf_sex ? ' · ' + l.calf_sex : ''}
                                  {l.calf_origin ? ' · ' + l.calf_origin : ''}
                                  {l.calf_dam_tag ? ' · dam ' + l.calf_dam_tag : ''}
                                  {l.calf_breed ? ' · ' + l.calf_breed : ''}
                                  {l.calf_note ? ' · ' + l.calf_note : ''}
                                </div>
                              ))}
                          </div>
                        )}
                        <div style={{display: 'flex', alignItems: 'center', gap: 10, marginTop: 4}}>
                          {e.edited_at && <span style={{fontSize: 11, color: '#6b7280'}}>edited</span>}
                          {isAuthor && (
                            <button
                              style={{...LINK_BTN, color: '#2563eb'}}
                              data-cattle-log-edit={e.id}
                              onClick={() => startEdit(e)}
                            >
                              Edit
                            </button>
                          )}
                          {canManage && (
                            <button
                              style={{...LINK_BTN, color: '#b91c1c'}}
                              data-cattle-log-delete={e.id}
                              onClick={() => setDeleteTargetId(e.id)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  <div className="wcf-clog-cell" style={{display: 'flex', alignItems: 'center', gap: 6}}>
                    <span className="wcf-clog-mobile-label">Issue</span>
                    <input
                      type="checkbox"
                      data-cattle-log-issue-toggle={e.id}
                      aria-label={'Issue state for entry ' + e.id}
                      checked={!!e.is_issue}
                      disabled={!canManage || !!issueBusy[e.id]}
                      onChange={(ev) => toggleIssue(e, ev.target.checked)}
                      style={{width: 16, height: 16, cursor: canManage ? 'pointer' : 'default'}}
                    />
                  </div>
                </div>
              );
            })}
            {hasMore && (
              <div style={{padding: '12px 0 8px', textAlign: 'center'}}>
                <button data-cattle-log-load-more="1" style={SMALL_BTN} disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
