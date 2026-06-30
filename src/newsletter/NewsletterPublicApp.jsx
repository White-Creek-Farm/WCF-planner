// Public, no-login newsletter surface. Mounted by main.jsx in a bypass block
// ABOVE the LoginScreen gate, so anonymous visitors reach it without a session.
// It is fully self-contained: it talks only to the three anon RPCs via
// newsletterApi and never imports AuthContext, the authed data contexts, admin
// auth, or service-role secrets (enforced by
// tests/static/newsletter_boundary_static.test.js).
//
// Routing (own pathname parsing, since this renders before the app's view
// adapter resolves):
//   /newsletter?key=<k>               -> archive of published issues (gated)
//   /newsletter/latest?key=<k>        -> redirect to the newest published slug
//   /newsletter/<slug>?key=<k>        -> published issue page (gated)
//   /newsletter/<slug>?preview=<tok>  -> token-gated draft preview (separate path)
//
// ACCESS: the published archive is gated by a rotating access key (mig 153). A
// missing/invalid/expired key renders the LOCKED screen; the key is threaded
// through every link so archive -> issue -> back keeps working. The draft
// preview path uses its own token and does not require the archive key.
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
  withNewsletterKey,
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
  const accessKey = params.get('key');
  const m = pathname.match(/^\/newsletter\/([^/]+)\/?$/);
  const rawSlug = m ? decodeURIComponent(m[1]) : null;
  if (!rawSlug) return {mode: 'archive', slug: null, previewToken: null, accessKey};
  if (rawSlug === 'latest') return {mode: 'latest', slug: null, previewToken: null, accessKey};
  return {
    mode: previewToken ? 'preview' : 'issue',
    slug: rawSlug,
    previewToken: previewToken || null,
    accessKey,
  };
}

// Editorial masthead shared by every public surface (no admin chrome): a green
// brand dot + the farm name as type, with Latest / Archive nav. Nav links keep
// the access key so they stay unlocked.
// eslint-disable-next-line no-unused-vars -- JSX-only use
function Masthead({mode, accessKey}) {
  return (
    <header className="nl-masthead">
      <div className="nl-masthead-inner">
        <a className="nl-brand" href={withNewsletterKey('/newsletter', accessKey)}>
          <span className="nl-brand-dot" aria-hidden="true" />
          <span className="nl-brand-word">White Creek Farm</span>
        </a>
        <nav className="nl-nav" aria-label="Newsletter">
          <a
            className={`nl-nav-link${mode === 'issue' || mode === 'preview' ? ' is-current' : ''}`}
            href={withNewsletterKey('/newsletter/latest', accessKey)}
          >
            Latest
          </a>
          <a
            className={`nl-nav-link${mode === 'archive' || mode === 'latest' ? ' is-current' : ''}`}
            href={withNewsletterKey('/newsletter', accessKey)}
          >
            Archive
          </a>
        </nav>
      </div>
    </header>
  );
}

export default function NewsletterPublicApp({sb}) {
  const location = useLocation();
  const navigate = useNavigate();
  useNoindex();

  const route = parseRoute(location.pathname, location.search);
  const {mode, slug, previewToken, accessKey} = route;

  const [status, setStatus] = useState('loading'); // loading | ready | notfound | locked | error
  const [issues, setIssues] = useState(null);
  const [data, setData] = useState(null);
  const [moreIssues, setMoreIssues] = useState([]); // other published issues for the issue-page footer
  const reqId = useRef(0);

  useEffect(() => {
    const myReq = ++reqId.current;
    let cancelled = false;
    setStatus('loading');
    setData(null);

    async function run() {
      try {
        if (mode === 'archive') {
          const list = await listPublishedNewsletters(sb, accessKey);
          if (cancelled || myReq !== reqId.current) return;
          if (list === null) {
            setStatus('locked'); // missing/invalid/expired key
            return;
          }
          setIssues(list);
          setStatus('ready');
        } else if (mode === 'latest') {
          const list = await listPublishedNewsletters(sb, accessKey);
          if (cancelled || myReq !== reqId.current) return;
          if (list === null) {
            setStatus('locked');
            return;
          }
          if (list.length > 0) {
            navigate(withNewsletterKey(`/newsletter/${encodeURIComponent(list[0].slug)}`, accessKey), {replace: true});
          } else {
            setIssues([]);
            setStatus('ready');
          }
        } else if (mode === 'preview') {
          // Draft preview uses its own token; the archive key is not required.
          const d = await getNewsletterPreview(sb, slug, previewToken);
          if (cancelled || myReq !== reqId.current) return;
          setData(d);
          setStatus(d ? 'ready' : 'notfound');
        } else {
          // Published issue page — gated by the archive key.
          if (!accessKey) {
            setStatus('locked');
            return;
          }
          const d = await getPublishedNewsletter(sb, slug, accessKey);
          if (cancelled || myReq !== reqId.current) return;
          setData(d);
          setStatus(d ? 'ready' : 'notfound');
        }
        // Best-effort: on a real issue/preview WITH a key, fetch other published
        // issues for the "More issues" footer. Failure is non-fatal — it hides.
        if ((mode === 'issue' || mode === 'preview') && accessKey) {
          const list = await listPublishedNewsletters(sb, accessKey).catch(() => null);
          if (cancelled || myReq !== reqId.current) return;
          setMoreIssues(Array.isArray(list) ? list.filter((it) => it.slug !== slug) : []);
        } else {
          setMoreIssues([]);
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
  }, [mode, slug, previewToken, accessKey, sb, navigate]);

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
  } else if (status === 'locked') {
    body = (
      <div className="nl-message nl-locked">
        <div className="nl-kicker">White Creek Farm</div>
        <h1 className="nl-title">This link has expired</h1>
        <p>
          Access to the Monthly Review is by a private link that refreshes each month. This one is no longer active —
          please ask for the current link to read the latest issue and the archive.
        </p>
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="nl-message">
        <h1 className="nl-title">Something went wrong</h1>
        <p>We couldn’t load the newsletter right now. Please try again later.</p>
      </div>
    );
  } else if (mode === 'archive' || mode === 'latest') {
    body = <NewsletterArchive sb={sb} issues={issues} accessKey={accessKey} />;
  } else if (status === 'notfound') {
    body = (
      <div className="nl-message">
        <h1 className="nl-title">{mode === 'preview' ? 'Preview not available' : 'Issue not available'}</h1>
        <p>
          {mode === 'preview'
            ? 'This preview link is invalid, disabled, or expired.'
            : 'That issue isn’t available, or your link may have expired. Please ask for the current link.'}
        </p>
        {mode !== 'preview' && accessKey && (
          <p>
            <a className="nl-back" href={withNewsletterKey('/newsletter', accessKey)}>
              ← All issues
            </a>
          </p>
        )}
      </div>
    );
  } else {
    body = (
      <NewsletterIssuePage
        sb={sb}
        data={data}
        isPreview={mode === 'preview'}
        moreIssues={moreIssues}
        accessKey={accessKey}
      />
    );
  }

  return (
    <div className="nl-public">
      <Masthead mode={mode} accessKey={accessKey} />
      <main className="nl-container">{body}</main>
    </div>
  );
}
