// Thumbnail grid rendered inside the edit/detail modal of each daily-report
// view. Lazy-fetches signed URLs for the photo paths on mount (10-min
// expiry, matches the fuel-bills bucket pattern). Click → fresh signed URL
// in a new tab so it never expires while the modal sat open.
//
// Read-only in v1 — no add/remove. The daily-photos bucket grants anon
// INSERT + authenticated SELECT only; admin add/remove is a future build
// (would need mig 032 daily_photos_auth_insert policy + a delete path).

import React from 'react';
import {sb} from '../lib/supabase.js';
import {imageAltText} from '../lib/imageAlt.js';
// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import InlineNotice from './InlineNotice.jsx';

export default function DailyPhotoThumbnails({photos}) {
  const list = Array.isArray(photos) ? photos : [];
  const [urls, setUrls] = React.useState({}); // path → signedUrl
  const [errs, setErrs] = React.useState({}); // path → message
  // Click-open failure is surfaced inline beneath the thumbnail grid so the
  // host modal doesn't need to thread a notice setter through; cleared on
  // each new open attempt.
  const [openNotice, setOpenNotice] = React.useState(null);

  React.useEffect(() => {
    let cancelled = false;
    if (list.length === 0) return undefined;
    (async () => {
      const next = {};
      const errsNext = {};
      for (const p of list) {
        if (!p || !p.path) continue;
        const {data, error} = await sb.storage.from('daily-photos').createSignedUrl(p.path, 600);
        if (error) errsNext[p.path] = error.message || 'signed-url failed';
        else if (data?.signedUrl) next[p.path] = data.signedUrl;
      }
      if (!cancelled) {
        setUrls(next);
        setErrs(errsNext);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [JSON.stringify(list.map((p) => p && p.path))]); // eslint-disable-line react-hooks/exhaustive-deps

  async function openFull(path) {
    setOpenNotice(null);
    // Re-fetch the signed URL on click — the modal may have been open longer
    // than the original 10-min expiry window.
    const {data, error} = await sb.storage.from('daily-photos').createSignedUrl(path, 600);
    if (error) {
      setOpenNotice({kind: 'error', message: 'Cannot open photo: ' + error.message});
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  }

  if (list.length === 0) return null;

  return (
    <div data-photo-thumbnails="1" style={{marginTop: 8}}>
      <div style={{fontSize: 11, fontWeight: 700, color: '#4b5563', marginBottom: 6, textTransform: 'uppercase'}}>
        Photos ({list.length})
      </div>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 6}}>
        {list.map((p, i) => {
          if (!p || !p.path) return null;
          const url = urls[p.path];
          const err = errs[p.path];
          return (
            <button
              key={p.path + i}
              data-photo-thumb={p.path}
              type="button"
              onClick={() => openFull(p.path)}
              title={p.name || p.path}
              style={{
                width: 80,
                height: 80,
                border: '1px solid #d1d5db',
                borderRadius: 6,
                overflow: 'hidden',
                padding: 0,
                background: '#f3f4f6',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              {url ? (
                <img
                  src={url}
                  alt={imageAltText(p.name, {fallback: 'Daily report photo', index: i, total: list.length})}
                  style={{width: '100%', height: '100%', objectFit: 'cover'}}
                />
              ) : err ? (
                <span style={{fontSize: 10, color: '#b91c1c'}}>?</span>
              ) : (
                <span style={{fontSize: 10, color: '#9ca3af'}}>…</span>
              )}
            </button>
          );
        })}
      </div>
      {openNotice && (
        <div style={{marginTop: 8}}>
          <InlineNotice notice={openNotice} onDismiss={() => setOpenNotice(null)} />
        </div>
      )}
    </div>
  );
}
