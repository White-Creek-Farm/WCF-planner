import React from 'react';
import {getCenterCompletionPhotoSignedUrl, getCenterRequestPhotoSignedUrl} from '../lib/tasksCenterMutationsApi.js';

const signedUrlCache = new Map();
const SIGNED_URL_TTL_MS = 8 * 60 * 1000;

const BUTTON = {
  position: 'relative',
  width: 48,
  height: 38,
  borderRadius: 10,
  border: '1px solid var(--border-strong)',
  background: 'var(--divider)',
  padding: 0,
  overflow: 'hidden',
  cursor: 'pointer',
  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
};

const IMG = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  display: 'block',
};

const FALLBACK = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ink-muted)',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.2,
  background: 'linear-gradient(135deg, var(--surface-2), var(--border))',
};

const COUNT_BADGE = {
  position: 'absolute',
  right: 3,
  bottom: 3,
  minWidth: 17,
  height: 17,
  borderRadius: 999,
  background: 'rgba(17, 24, 39, 0.82)',
  color: 'white',
  fontSize: 10,
  fontWeight: 700,
  lineHeight: '17px',
  textAlign: 'center',
  padding: '0 4px',
};

function rowPhotoCount(task) {
  const paths = new Set();
  if (task?.request_photo_path) paths.add(task.request_photo_path);
  if (task?.completion_photo_path) paths.add(task.completion_photo_path);
  return paths.size;
}

function thumbnailPhotoForTask(task) {
  if (!task) return null;
  if (task.status === 'completed' && task.completion_photo_path) {
    return {kind: 'completion', storagePath: task.completion_photo_path};
  }
  if (task.request_photo_path) {
    return {kind: 'creation', storagePath: task.request_photo_path};
  }
  if (task.completion_photo_path) {
    return {kind: 'completion', storagePath: task.completion_photo_path};
  }
  return null;
}

async function signedUrlForPhoto(sb, photo) {
  if (!sb || !photo?.storagePath) return '';
  const cached = signedUrlCache.get(photo.storagePath);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  const url =
    photo.kind === 'creation'
      ? await getCenterRequestPhotoSignedUrl(sb, photo.storagePath)
      : await getCenterCompletionPhotoSignedUrl(sb, photo.storagePath);
  signedUrlCache.set(photo.storagePath, {url: url || '', expiresAt: Date.now() + SIGNED_URL_TTL_MS});
  return url || '';
}

export default function TaskPhotoThumbnailButton({sb, task, onClick}) {
  const photo = thumbnailPhotoForTask(task);
  const photoKind = photo?.kind || '';
  const photoStoragePath = photo?.storagePath || '';
  const count = rowPhotoCount(task);
  const [url, setUrl] = React.useState('');
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setUrl('');
    setLoaded(false);
    if (!photoKind || !photoStoragePath) return undefined;
    signedUrlForPhoto(sb, {kind: photoKind, storagePath: photoStoragePath})
      .then((nextUrl) => {
        if (!cancelled) setUrl(nextUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl('');
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sb, photoKind, photoStoragePath]);

  if (!photo || count <= 0) return null;

  const label = count === 1 ? '1 photo' : `${count} photos`;

  return (
    <button
      type="button"
      data-task-has-photo="1"
      data-task-photo-open="1"
      data-task-photo-thumbnail="1"
      data-task-photo-count={count}
      onClick={onClick}
      title={label}
      aria-label={label}
      style={BUTTON}
    >
      {url ? (
        <img src={url} alt="" aria-hidden="true" loading="lazy" style={IMG} />
      ) : (
        <span aria-hidden="true" style={FALLBACK}>
          {loaded ? 'Photo' : ''}
        </span>
      )}
      {count > 1 && (
        <span aria-hidden="true" style={COUNT_BADGE}>
          {count}
        </span>
      )}
    </button>
  );
}
