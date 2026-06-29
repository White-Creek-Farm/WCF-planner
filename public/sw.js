const CACHE_VERSION = '2026-06-23-mobile-load-hotfix-v1';
const SHELL_CACHE = `wcf-app-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `wcf-runtime-${CACHE_VERSION}`;
const CACHE_NAMES = new Set([SHELL_CACHE, RUNTIME_CACHE]);

const CORE_URLS = [
  '/',
  '/index.html',
  '/dailys',
  '/dailys.html',
  '/webforms',
  '/equipment',
  '/equipment.html',
  '/fueling',
  '/manifest.webmanifest',
  '/manifest-dailys.webmanifest',
  '/manifest-equipment.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/hanken-grotesk-latin.woff2',
];

const HTML_SHELL_BY_PATH = [
  {prefixes: ['/dailys', '/webforms'], shell: '/dailys.html'},
  {prefixes: ['/equipment', '/fueling'], shell: '/equipment.html'},
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(precacheAppShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => !CACHE_NAMES.has(name)).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const {request} = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (isFreshBuildAssetRequest(request, url)) {
    event.respondWith(networkFirstThenCache(request));
    return;
  }

  if (isCacheableAssetRequest(request, url)) {
    event.respondWith(cacheFirstThenNetwork(request));
  }
});

async function precacheAppShell() {
  const shellCache = await caches.open(SHELL_CACHE);
  await Promise.all(CORE_URLS.map((url) => putFresh(shellCache, url)));

  for (const shellUrl of ['/index.html', '/dailys.html', '/equipment.html']) {
    await cacheLinkedBuildAssets(shellCache, shellUrl);
  }
}

async function putFresh(cache, url) {
  try {
    const response = await fetch(new Request(url, {cache: 'reload'}));
    if (response && response.ok) {
      await cache.put(url, response.clone());
    }
    return response;
  } catch (_error) {
    return null;
  }
}

async function cacheLinkedBuildAssets(cache, shellUrl) {
  const response = (await putFresh(cache, shellUrl)) || (await cache.match(shellUrl));
  if (!response || !response.ok) return;

  let html = '';
  try {
    html = await response.clone().text();
  } catch (_error) {
    return;
  }

  const assetUrls = linkedAssetUrls(html);
  await Promise.all(assetUrls.map((url) => putFresh(cache, url)));
}

function linkedAssetUrls(html) {
  const urls = new Set();
  const attrPattern = /\b(?:src|href)=["']([^"']+)["']/g;
  let match;

  while ((match = attrPattern.exec(html))) {
    const value = match[1];
    if (!value || value.startsWith('http:') || value.startsWith('https:') || value.startsWith('data:')) continue;
    if (value.startsWith('/assets/') || value.startsWith('/src/') || value.startsWith('/fonts/') || value.startsWith('/icons/')) {
      urls.add(value);
    }
  }

  return [...urls];
}

async function handleNavigation(request) {
  const runtimeCache = await caches.open(RUNTIME_CACHE);

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await runtimeCache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    return cachedNavigationResponse(request);
  }
}

async function cachedNavigationResponse(request) {
  const url = new URL(request.url);
  const shellUrl = shellForPath(url.pathname);
  const shellCache = await caches.open(SHELL_CACHE);
  const runtimeCache = await caches.open(RUNTIME_CACHE);

  return (
    // An exact runtime-cached navigation must win before the generic SPA shell
    // fallback. A real static page like /pasture-map-field-guide.html is cached
    // under its own request on first online open; without this, shellForPath()
    // would mask it with /index.html and an offline open would show the app shell.
    // Normal app routes still fall through to their precached hub/index shell.
    (await runtimeCache.match(request)) ||
    (await shellCache.match(shellUrl)) ||
    (await shellCache.match('/index.html')) ||
    new Response('Offline app shell is not cached yet.', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {'Content-Type': 'text/plain; charset=utf-8'},
    })
  );
}

function shellForPath(pathname) {
  const match = HTML_SHELL_BY_PATH.find(({prefixes}) => prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)));
  return match ? match.shell : '/index.html';
}

async function cacheFirstThenNetwork(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstThenCache(request) {
  try {
    const response = await fetch(request, {cache: 'no-store'});
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (_error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw _error;
  }
}

function isFreshBuildAssetRequest(request, url) {
  if (request.destination === 'script' || request.destination === 'style') return true;
  return url.pathname.startsWith('/assets/') && /\.(?:js|css)$/.test(url.pathname);
}

function isCacheableAssetRequest(request, url) {
  if (['script', 'style', 'font', 'image', 'manifest'].includes(request.destination)) return true;
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/@vite/') ||
    url.pathname.startsWith('/node_modules/')
  );
}
