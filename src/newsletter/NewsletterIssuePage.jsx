// One published (or token-previewed) newsletter issue, rendered from the
// sanitized render payload returned by get_published_newsletter /
// get_newsletter_preview. Only approved photos and whitelisted blocks reach
// this component (the DB never exposes drafts/facts/intake/runs/settings or
// source_private_path to anon).

import React from 'react';
// eslint-disable-next-line no-unused-vars -- NewsletterBlocks is JSX-only use
import NewsletterBlocks, {renderNewsletterBlock} from './NewsletterBlocks.jsx';
import {newsletterPublicPhotoUrl, formatYearMonth} from '../lib/newsletterApi.js';

function formatPublishedDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
}

// Ids placed explicitly by photo/gallery blocks — so the trailing gallery only
// shows approved photos the editor didn't already position inline.
function collectReferencedPhotoIds(blocks) {
  const ids = new Set();
  if (!Array.isArray(blocks)) return ids;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'photo' && b.photoId) ids.add(b.photoId);
    if (b.type === 'gallery' && Array.isArray(b.photoIds)) b.photoIds.forEach((id) => ids.add(id));
  }
  return ids;
}

export default function NewsletterIssuePage({sb, data, isPreview = false}) {
  const urlFor = React.useCallback((storagePath) => newsletterPublicPhotoUrl(sb, storagePath), [sb]);

  const photos = React.useMemo(() => (Array.isArray(data && data.photos) ? data.photos : []), [data]);
  const blocks = React.useMemo(
    () => (data && data.payload && Array.isArray(data.payload.blocks) ? data.payload.blocks : []),
    [data],
  );
  const photosById = React.useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const cover = photos.find((p) => p.isCover) || null;
  const referenced = React.useMemo(() => collectReferencedPhotoIds(blocks), [blocks]);
  const trailing = photos.filter((p) => !p.isCover && !referenced.has(p.id));

  const monthLabel = formatYearMonth(data && data.yearMonth);
  const publishedLabel = formatPublishedDate(data && data.publishedAt);

  return (
    <article className="nl-issue">
      {isPreview && (
        <div className="nl-preview-banner" role="status">
          Preview — this issue is not published yet. The link rotates when the issue is published.
        </div>
      )}

      {cover && (
        <div className="nl-cover">
          {renderNewsletterBlock({type: 'photo', photoId: cover.id}, 'cover', {photosById, urlFor})}
        </div>
      )}

      <header className="nl-issue-header">
        <div className="nl-kicker">White Creek Farm{monthLabel ? ` · ${monthLabel}` : ''}</div>
        <h1 className="nl-title">{(data && data.title) || 'Farm Review'}</h1>
        {publishedLabel && <div className="nl-published">Published {publishedLabel}</div>}
      </header>

      <div className="nl-body">
        <NewsletterBlocks blocks={blocks} photosById={photosById} urlFor={urlFor} />
      </div>

      {trailing.length > 0 && (
        <section className="nl-more-photos">
          <h2 className="nl-h2">More from this month</h2>
          <div className="nl-gallery">
            {trailing.map((p) =>
              renderNewsletterBlock({type: 'photo', photoId: p.id}, `t-${p.id}`, {photosById, urlFor}),
            )}
          </div>
        </section>
      )}

      <footer className="nl-issue-footer">
        <a className="nl-back" href="/newsletter">
          ← All issues
        </a>
      </footer>
    </article>
  );
}
