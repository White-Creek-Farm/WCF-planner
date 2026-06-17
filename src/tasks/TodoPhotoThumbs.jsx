// To Do photo thumbnail strip + built-in viewer overlay.
//
// Renders every photo on a To Do item as a small signed-URL thumbnail
// (task-photos bucket, todo/<id>/ prefix); clicking opens a lightbox-style
// viewer with prev/next. Signed URLs are cached module-wide for 8 minutes
// (TaskPhotoThumbnailButton pattern) so list re-renders don't re-sign.

import React from 'react';
import {getTodoPhotoSignedUrl} from '../lib/todoApi.js';
import {imageAltText} from '../lib/imageAlt.js';
import {
  taskPhotoLightboxOverlay,
  taskPhotoLightboxPanel,
  taskPhotoLightboxButton,
  taskPhotoLightboxFrame,
} from './taskModalStyles.js';

const signedUrlCache = new Map();
const SIGNED_URL_TTL_MS = 8 * 60 * 1000;

async function signedUrlForPath(sb, dbPath) {
  const cached = signedUrlCache.get(dbPath);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  let url = '';
  try {
    url = await getTodoPhotoSignedUrl(sb, dbPath, 600);
  } catch (_e) {
    url = '';
  }
  // Cache successes only (TaskPhotoThumbnailButton pattern): a transient
  // signing failure must retry on the next effect run, not pin a blank
  // thumbnail for the full TTL.
  if (url) {
    signedUrlCache.set(dbPath, {url, expiresAt: Date.now() + SIGNED_URL_TTL_MS});
  }
  return url;
}

function kindLabel(kind) {
  return kind === 'completion' ? 'Completion photo' : 'Origination photo';
}

function Thumb({sb, photo, index, total, onOpen}) {
  const [url, setUrl] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const u = await signedUrlForPath(sb, photo.storage_path);
      if (!cancelled) setUrl(u);
    })();
    return () => {
      cancelled = true;
    };
  }, [sb, photo.storage_path]);

  return (
    <button
      type="button"
      data-todo-photo-thumb={photo.id || String(index)}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(index);
      }}
      title={kindLabel(photo.kind)}
      aria-label={kindLabel(photo.kind)}
      style={{
        width: 44,
        height: 36,
        padding: 0,
        border: '1px solid #d1d5db',
        borderRadius: 10,
        overflow: 'hidden',
        cursor: 'pointer',
        background: 'linear-gradient(135deg, #e5e7eb, #f3f4f6)',
        flexShrink: 0,
      }}
    >
      {url ? (
        <img
          src={url}
          alt={imageAltText(kindLabel(photo.kind), {index, total})}
          style={{width: '100%', height: '100%', objectFit: 'cover', display: 'block'}}
        />
      ) : null}
    </button>
  );
}

export default function TodoPhotoThumbs({sb, photos}) {
  const list = Array.isArray(photos) ? photos.filter((p) => p && p.storage_path) : [];
  const [viewerIndex, setViewerIndex] = React.useState(null);
  const [viewerUrl, setViewerUrl] = React.useState('');
  // 'loading' | 'done' — distinguishes in-flight from a settled-empty lookup
  // so a failed signing renders "Photo unavailable", not an eternal Loading…
  const [viewerState, setViewerState] = React.useState('loading');

  React.useEffect(() => {
    if (viewerIndex === null || !list[viewerIndex]) return undefined;
    let cancelled = false;
    setViewerUrl('');
    setViewerState('loading');
    (async () => {
      const u = await signedUrlForPath(sb, list[viewerIndex].storage_path);
      if (!cancelled) {
        setViewerUrl(u);
        setViewerState('done');
      }
    })();
    return () => {
      cancelled = true;
    };
    // list identity changes per render; key off the stable storage_path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sb, viewerIndex, list[viewerIndex] && list[viewerIndex].storage_path]);

  if (list.length === 0) return null;

  const current = viewerIndex !== null ? list[viewerIndex] : null;

  return (
    <>
      <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center'}} data-todo-photo-strip="1">
        {list.map((p, i) => (
          <Thumb key={p.id || p.storage_path} sb={sb} photo={p} index={i} total={list.length} onOpen={setViewerIndex} />
        ))}
      </div>
      {current ? (
        <div
          style={taskPhotoLightboxOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="To do photos"
          data-todo-photo-viewer="1"
          onClick={() => setViewerIndex(null)}
        >
          <div style={taskPhotoLightboxPanel} onClick={(e) => e.stopPropagation()}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12}}>
              <div style={{fontSize: 13, fontWeight: 600, color: 'var(--ink)'}}>
                {kindLabel(current.kind)} ({viewerIndex + 1} / {list.length})
              </div>
              <button type="button" style={taskPhotoLightboxButton} onClick={() => setViewerIndex(null)}>
                Close
              </button>
            </div>
            <div style={taskPhotoLightboxFrame}>
              {viewerUrl ? (
                <img
                  src={viewerUrl}
                  alt={imageAltText(kindLabel(current.kind), {index: viewerIndex, total: list.length})}
                  style={{maxWidth: '100%', maxHeight: '66vh', objectFit: 'contain'}}
                />
              ) : viewerState === 'loading' ? (
                <div style={{color: 'var(--ink-faint)', fontSize: 13}}>Loading…</div>
              ) : (
                <div style={{color: 'var(--ink-faint)', fontSize: 13}}>Photo unavailable — close and retry.</div>
              )}
            </div>
            {list.length > 1 ? (
              <div style={{display: 'flex', justifyContent: 'space-between'}}>
                <button
                  type="button"
                  style={taskPhotoLightboxButton}
                  onClick={() => setViewerIndex((viewerIndex - 1 + list.length) % list.length)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  style={taskPhotoLightboxButton}
                  onClick={() => setViewerIndex((viewerIndex + 1) % list.length)}
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
