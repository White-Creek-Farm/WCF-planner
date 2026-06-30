// Public newsletter archive: a grid of published issues with an optional cover
// thumbnail. Reads list_published_newsletters (anon RPC), which returns
// slug/yearMonth/title/publishedAt + an approved cover (if any). Cards are real
// anchors (so middle-click / open-in-new-tab work) with a hover-lift, matching
// the A6 openable affordance for a public links list.

// eslint-disable-next-line no-unused-vars -- JSX-only use (eslint flat config has no react/jsx-uses-vars rule)
import React from 'react';
import {newsletterPublicPhotoUrl, formatYearMonth, buildNewsletterIssuePath} from '../lib/newsletterApi.js';

export default function NewsletterArchive({sb, issues}) {
  const list = Array.isArray(issues) ? issues : [];

  return (
    <div className="nl-archive">
      <header className="nl-archive-header">
        <div className="nl-kicker">White Creek Farm</div>
        <h1 className="nl-title">Monthly Review</h1>
        <p className="nl-archive-sub">A look back at each month on the farm — animals, milestones, and good news.</p>
      </header>

      {list.length === 0 ? (
        <p className="nl-empty">No issues have been published yet. Check back soon.</p>
      ) : (
        <ul className="nl-archive-grid">
          {list.map((it) => {
            const coverUrl = it.cover && it.cover.storagePath ? newsletterPublicPhotoUrl(sb, it.cover.storagePath) : '';
            return (
              <li key={it.slug}>
                <a className="nl-archive-card" href={buildNewsletterIssuePath(it.slug)}>
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
      )}

      <p className="nl-foot-micro" style={{marginTop: 32}}>
        A public, no-login archive. Preview links shared before an issue is published expire after 30 days.
      </p>
    </div>
  );
}
