// Task Center photo lightbox. Tasks v2 T6/T7.
//
// Lazy: signed URLs are fetched on first show of each photo, never
// eagerly per row. Photos come from task_instance_photos (canonical
// per Codex T6/T7 spec); legacy single-path columns surface only as
// display fallback when the sidecar is empty.
//
// Read-only viewer — close, prev, next. No deletion, no metadata
// editing. Pure imports from tasksCenterMutationsApi (signed-URL
// wrappers) and tasksCenterApi (sidecar loader).

import React from 'react';
import {loadTaskInstancePhotos} from '../lib/tasksCenterApi.js';
import {getCenterRequestPhotoSignedUrl, getCenterCompletionPhotoSignedUrl} from '../lib/tasksCenterMutationsApi.js';
import {imageAltText} from '../lib/imageAlt.js';

const OVERLAY = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.8)',
  zIndex: 300,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  padding: 16,
};
const PANEL = {
  background: 'white',
  borderRadius: 12,
  padding: 16,
  maxWidth: 'min(900px, 96vw)',
  maxHeight: '92vh',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const BTN = {
  padding: '6px 12px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: 'white',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
  fontFamily: 'inherit',
};
const KIND_LABEL = {creation: 'Request photo', completion: 'Completion photo'};

function fallbackPhotosFromRow(task) {
  if (!task) return [];
  const out = [];
  if (task.request_photo_path) {
    out.push({
      id: `legacy-creation-${task.id}`,
      instance_id: task.id,
      kind: 'creation',
      storage_path: task.request_photo_path,
      sort_order: 0,
      __legacy: true,
    });
  }
  if (task.completion_photo_path) {
    out.push({
      id: `legacy-completion-${task.id}`,
      instance_id: task.id,
      kind: 'completion',
      storage_path: task.completion_photo_path,
      sort_order: 0,
      __legacy: true,
    });
  }
  return out;
}

export default function TaskPhotoLightbox({sb, task, isOpen, onClose}) {
  const [photos, setPhotos] = React.useState([]);
  const [index, setIndex] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [signedUrlByPath, setSignedUrlByPath] = React.useState({});

  // Reset when the lightbox opens for a different task.
  React.useEffect(() => {
    if (!isOpen || !task || !sb) {
      setPhotos([]);
      setIndex(0);
      setErr('');
      setSignedUrlByPath({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr('');
    setIndex(0);
    setSignedUrlByPath({});
    (async () => {
      try {
        const sidecar = await loadTaskInstancePhotos(sb, task.id);
        if (cancelled) return;
        const list = sidecar && sidecar.length > 0 ? sidecar : fallbackPhotosFromRow(task);
        setPhotos(list);
      } catch (e) {
        if (!cancelled) {
          // Sidecar fetch failed: fall back to legacy single-path columns
          // so the lightbox stays useful even with a transient DB hiccup.
          setPhotos(fallbackPhotosFromRow(task));
          setErr(e && e.message ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sb, task]);

  // Lazy signed-URL fetch for the currently-shown photo + the next one
  // (small look-ahead so prev/next clicks feel snappy without paying
  // the eager cost up front).
  React.useEffect(() => {
    if (!isOpen || !sb || photos.length === 0) return;
    const wanted = [];
    if (photos[index]) wanted.push(photos[index]);
    if (photos[index + 1]) wanted.push(photos[index + 1]);
    let cancelled = false;
    (async () => {
      for (const p of wanted) {
        if (signedUrlByPath[p.storage_path] !== undefined) continue;
        try {
          const url =
            p.kind === 'creation'
              ? await getCenterRequestPhotoSignedUrl(sb, p.storage_path)
              : await getCenterCompletionPhotoSignedUrl(sb, p.storage_path);
          if (cancelled) return;
          setSignedUrlByPath((prev) => ({...prev, [p.storage_path]: url || ''}));
        } catch (_e) {
          if (cancelled) return;
          setSignedUrlByPath((prev) => ({...prev, [p.storage_path]: ''}));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, sb, photos, index, signedUrlByPath]);

  if (!isOpen) return null;

  const current = photos[index] || null;
  const url = current ? signedUrlByPath[current.storage_path] : undefined;
  const total = photos.length;

  function close() {
    if (onClose) onClose();
  }
  function prev() {
    setIndex((i) => (i - 1 + total) % Math.max(total, 1));
  }
  function next() {
    setIndex((i) => (i + 1) % Math.max(total, 1));
  }

  return (
    <div data-task-photo-lightbox="1" style={OVERLAY} onClick={close}>
      <div style={PANEL} onClick={(e) => e.stopPropagation()}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12}}>
          <div style={{fontSize: 13, color: '#374151', fontWeight: 600}}>
            {task && task.title ? task.title : 'Task photo'}
            {total > 0 && (
              <span data-lightbox-position={`${index + 1}/${total}`} style={{color: '#6b7280', marginLeft: 8}}>
                ({index + 1} / {total})
              </span>
            )}
          </div>
          <button type="button" data-lightbox-close="1" onClick={close} style={BTN}>
            Close
          </button>
        </div>

        {loading && <div style={{fontSize: 13, color: '#6b7280'}}>Loading photos…</div>}
        {!loading && total === 0 && (
          <div data-lightbox-empty="1" style={{fontSize: 13, color: '#6b7280'}}>
            No photos for this task.
          </div>
        )}

        {!loading && total > 0 && current && (
          <>
            <div
              data-lightbox-photo-kind={current.kind}
              style={{
                background: '#0b0b0b',
                borderRadius: 8,
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 240,
                maxHeight: '70vh',
              }}
            >
              {url === undefined ? (
                <div style={{color: '#d1d5db', fontSize: 13}}>Loading photo…</div>
              ) : url ? (
                <img
                  src={url}
                  alt={imageAltText('', {fallback: KIND_LABEL[current.kind] || 'Task photo', index, total})}
                  style={{maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain', display: 'block'}}
                />
              ) : (
                <div style={{color: '#fca5a5', fontSize: 13}}>Could not load photo.</div>
              )}
            </div>
            <div style={{fontSize: 12, color: '#6b7280'}}>
              {KIND_LABEL[current.kind] || current.kind} · slot {current.sort_order + 1}
              {current.__legacy && ' (legacy single-path fallback)'}
            </div>
          </>
        )}

        {err && (
          <div style={{fontSize: 12, color: '#991b1b', background: '#fef2f2', padding: '6px 10px', borderRadius: 6}}>
            {err}
          </div>
        )}

        {total > 1 && (
          <div style={{display: 'flex', justifyContent: 'space-between', gap: 8}}>
            <button type="button" data-lightbox-prev="1" onClick={prev} style={BTN}>
              ← Previous
            </button>
            <button type="button" data-lightbox-next="1" onClick={next} style={BTN}>
              Next →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
