// One published (or token-previewed) newsletter issue, rendered from the
// sanitized render payload returned by get_published_newsletter /
// get_newsletter_preview. Only approved photos and whitelisted blocks reach
// this component (the DB never exposes drafts/facts/intake/runs/settings or
// source_private_path to anon).

import React from 'react';
// eslint-disable-next-line no-unused-vars -- NewsletterBlocks is JSX-only use
import NewsletterBlocks, {renderNewsletterBlock} from './NewsletterBlocks.jsx';
import {newsletterPublicPhotoUrl, formatYearMonth, buildNewsletterIssuePath} from '../lib/newsletterApi.js';

function formatPublishedDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'});
}

// Honest reading-time estimate from the rendered text blocks (~200 wpm, floor 1).
function estimateReadMinutes(blocks) {
  if (!Array.isArray(blocks)) return 0;
  let words = 0;
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const parts = [];
    if (typeof b.text === 'string') parts.push(b.text);
    if (Array.isArray(b.items)) {
      for (const it of b.items) {
        if (typeof it === 'string') parts.push(it);
        else if (it && typeof it === 'object') parts.push(`${it.label || ''} ${it.value || ''}`);
      }
    }
    const text = parts.join(' ').trim();
    if (text) words += text.split(/\s+/).length;
  }
  return words > 0 ? Math.max(1, Math.round(words / 200)) : 0;
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

export default function NewsletterIssuePage({sb, data, isPreview = false, moreIssues = []}) {
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
  const readMin = React.useMemo(() => estimateReadMinutes(blocks), [blocks]);
  const more = Array.isArray(moreIssues) ? moreIssues.slice(0, 3) : [];

  const monthLabel = formatYearMonth(data && data.yearMonth);
  const publishedLabel = formatPublishedDate(data && data.publishedAt);
  const metaBits = [publishedLabel ? `Published ${publishedLabel}` : '', readMin ? `~${readMin} min read` : '']
    .filter(Boolean)
    .join(' · ');

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

      <header className="nl-issue-header nl-measure">
        <div className="nl-eyebrow">White Creek Farm{monthLabel ? ` · ${monthLabel}` : ''} · Monthly Review</div>
        <h1 className="nl-title">{(data && data.title) || 'Farm Review'}</h1>
        {metaBits && <div className="nl-published">{metaBits}</div>}
      </header>

      <div className="nl-body nl-measure">
        <NewsletterBlocks blocks={blocks} photosById={photosById} urlFor={urlFor} />
        <p className="nl-signoff">— Ronnie &amp; the White Creek Farm team</p>
      </div>

      {trailing.length > 0 && (
        <section className="nl-more-photos">
          <h2 className="nl-h2 nl-measure">More from this month</h2>
          <div className="nl-gallery">
            {trailing.map((p) =>
              renderNewsletterBlock({type: 'photo', photoId: p.id}, `t-${p.id}`, {photosById, urlFor}),
            )}
          </div>
        </section>
      )}

      {more.length > 0 && (
        <section className="nl-more">
          <h2 className="nl-h2">More issues</h2>
          <ul className="nl-more-grid">
            {more.map((it) => {
              const coverUrl =
                it.cover && it.cover.storagePath ? newsletterPublicPhotoUrl(sb, it.cover.storagePath) : '';
              return (
                <li key={it.slug}>
                  <a className="nl-archive-card nl-more-card" href={buildNewsletterIssuePath(it.slug)}>
                    {coverUrl ? (
                      <span className="nl-archive-thumb">
                        <img src={coverUrl} alt={(it.cover && it.cover.altText) || ''} loading="lazy" />
                      </span>
                    ) : (
                      <span className="nl-archive-thumb nl-archive-thumb-empty" aria-hidden="true" />
                    )}
                    <span className="nl-archive-body">
                      <span className="nl-archive-month">{formatYearMonth(it.yearMonth)}</span>
                      <span className="nl-archive-title">{it.title}</span>
                      <span className="nl-archive-read">Read ›</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <footer className="nl-issue-footer">
        <a className="nl-back" href="/newsletter">
          ← All issues
        </a>
        <span className="nl-foot-micro">Public, no-login archive · White Creek Farm</span>
      </footer>
    </article>
  );
}
