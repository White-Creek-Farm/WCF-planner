// Public, no-login newsletter surface. Mounted by main.jsx in a bypass block
// ABOVE the LoginScreen gate, so anonymous visitors reach it without a session.
// It is fully self-contained: it talks only to the three anon RPCs via
// newsletterApi and never imports AuthContext, the authed data contexts, admin
// auth, or service-role secrets (enforced by
// tests/static/newsletter_boundary_static.test.js).
//
// Routing (own pathname parsing, since this renders before the app's view
// adapter resolves):
//   /newsletter                       -> archive of published issues
//   /newsletter/latest                -> redirect to the newest published slug
//   /newsletter/<slug>                -> published issue page
//   /newsletter/<slug>?preview=<tok>  -> token-gated draft preview
//
// The whole surface is noindex (an invariant for the issue pages; applied to
// the archive too since these are intentionally unindexed).

import React from 'react';
import {useLocation, useNavigate} from 'react-router-dom';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import NewsletterArchive from './NewsletterArchive.jsx';
// eslint-disable-next-line no-unused-vars -- JSX-only use
import NewsletterIssuePage from './NewsletterIssuePage.jsx';
import {
  listPublishedNewsletters,
  getPublishedNewsletter,
  getNewsletterPreview,
  formatYearMonth,
} from '../lib/newsletterApi.js';
import './newsletter.css';

const {useState, useEffect, useRef} = React;

// Add a <meta name="robots" content="noindex"> for the lifetime of the public
// newsletter, then remove it on unmount so the authenticated app (which a
// logged-in admin returns to) is never left noindexed.
function useNoindex() {
  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"][data-nl="1"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'robots');
      meta.setAttribute('content', 'noindex, nofollow');
      meta.setAttribute('data-nl', '1');
      document.head.appendChild(meta);
    }
    return () => {
      const el = document.querySelector('meta[name="robots"][data-nl="1"]');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    };
  }, []);
}

function parseRoute(pathname, search) {
  const params = new URLSearchParams(search || '');
  const previewToken = params.get('preview');
  const m = pathname.match(/^\/newsletter\/([^/]+)\/?$/);
  const rawSlug = m ? decodeURIComponent(m[1]) : null;
  if (!rawSlug) return {mode: 'archive', slug: null, previewToken: null};
  if (rawSlug === 'latest') return {mode: 'latest', slug: null, previewToken: null};
  return {mode: previewToken ? 'preview' : 'issue', slug: rawSlug, previewToken: previewToken || null};
}

export default function NewsletterPublicApp({sb}) {
  const location = useLocation();
  const navigate = useNavigate();
  useNoindex();

  const route = parseRoute(location.pathname, location.search);
  const {mode, slug, previewToken} = route;

  const [status, setStatus] = useState('loading'); // loading | ready | notfound | error
  const [issues, setIssues] = useState(null);
  const [data, setData] = useState(null);
  const reqId = useRef(0);

  useEffect(() => {
    const myReq = ++reqId.current;
    let cancelled = false;
    setStatus('loading');
    setData(null);

    async function run() {
      try {
        if (mode === 'archive') {
          const list = await listPublishedNewsletters(sb);
          if (cancelled || myReq !== reqId.current) return;
          setIssues(list);
          setStatus('ready');
        } else if (mode === 'latest') {
          const list = await listPublishedNewsletters(sb);
          if (cancelled || myReq !== reqId.current) return;
          if (list.length > 0) {
            navigate(`/newsletter/${encodeURIComponent(list[0].slug)}`, {replace: true});
          } else {
            setIssues([]);
            setStatus('ready');
          }
        } else if (mode === 'preview') {
          const d = await getNewsletterPreview(sb, slug, previewToken);
          if (cancelled || myReq !== reqId.current) return;
          setData(d);
          setStatus(d ? 'ready' : 'notfound');
        } else {
          const d = await getPublishedNewsletter(sb, slug);
          if (cancelled || myReq !== reqId.current) return;
          setData(d);
          setStatus(d ? 'ready' : 'notfound');
        }
      } catch (_e) {
        if (cancelled || myReq !== reqId.current) return;
        setStatus('error');
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [mode, slug, previewToken, sb, navigate]);

  // Document title tracks the resolved surface.
  useEffect(() => {
    const base = 'White Creek Farm Monthly Review';
    if (status === 'ready' && data && data.title) document.title = `${data.title} · WCF`;
    else if (mode === 'issue' || mode === 'preview') document.title = `${formatYearMonth(slug)} · ${base}`;
    else document.title = base;
  }, [status, data, mode, slug]);

  let body;
  if (status === 'loading') {
    body = <div className="nl-loading">Loading…</div>;
  } else if (status === 'error') {
    body = (
      <div className="nl-message">
        <h1 className="nl-title">Something went wrong</h1>
        <p>We couldn’t load the newsletter right now. Please try again later.</p>
        <p>
          <a className="nl-back" href="/newsletter">
            ← All issues
          </a>
        </p>
      </div>
    );
  } else if (mode === 'archive' || mode === 'latest') {
    body = <NewsletterArchive sb={sb} issues={issues} />;
  } else if (status === 'notfound') {
    body = (
      <div className="nl-message">
        <h1 className="nl-title">Issue not found</h1>
        <p>
          {mode === 'preview' ? 'This preview link is invalid, disabled, or expired.' : 'That issue isn’t available.'}
        </p>
        <p>
          <a className="nl-back" href="/newsletter">
            ← All issues
          </a>
        </p>
      </div>
    );
  } else {
    body = <NewsletterIssuePage sb={sb} data={data} isPreview={mode === 'preview'} />;
  }

  return (
    <div className="nl-public">
      <main className="nl-container">{body}</main>
    </div>
  );
}
