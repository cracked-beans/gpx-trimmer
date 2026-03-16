const CACHE     = 'gpx-trimmer-v2';
const SHARE_KEY = 'gpx-trimmer-shared-files';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Barlow:wght@300;400;500;600&display=swap'
];

// ── Install: pre-cache static assets ─────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: purge old caches ────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: handle share-target POST + normal cache-first ─────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Intercept the share-target POST from Android's share sheet
  if (url.pathname.endsWith('/share-target') && event.request.method === 'POST') {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  // Normal cache-first for everything else
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// ── Share target handler ──────────────────────────────────────────────────────
async function handleShareTarget(request) {
  const formData = await request.formData();
  const files = formData.getAll('gpx');   // field name from manifest share_target

  if (files.length) {
    // Serialize files to transferable objects and store in a special cache entry
    const fileDataArray = await Promise.all(
      files.map(async file => ({
        name: file.name,
        type: file.type || 'application/gpx+xml',
        data: await file.arrayBuffer()
      }))
    );

    // Open a dedicated cache bucket for the pending shared files
    const shareCache = await caches.open(SHARE_KEY);
    await shareCache.put(
      './pending-share',
      new Response(JSON.stringify(
        fileDataArray.map(f => ({
          name: f.name,
          type: f.type,
          // base64-encode the binary so it survives JSON serialization
          data: bufferToBase64(f.data)
        }))
      ), { headers: { 'Content-Type': 'application/json' } })
    );

    // Tell all open windows to reload/check for pending files
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'SHARE_RECEIVED' });
    }
  }

  // Redirect back to the app (302 so browser navigates to the main page)
  return Response.redirect('./index.html', 302);
}

// ── Utility: ArrayBuffer → base64 string ─────────────────────────────────────
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── Message handler: page asks SW for pending shared files ───────────────────
self.addEventListener('message', async event => {
  if (event.data?.type === 'GET_SHARED_FILES') {
    const shareCache = await caches.open(SHARE_KEY);
    const response   = await shareCache.match('./pending-share');

    if (response) {
      const files = await response.json();
      await shareCache.delete('./pending-share');   // consume once
      event.source.postMessage({ type: 'SHARED_FILES', files });
    } else {
      event.source.postMessage({ type: 'SHARED_FILES', files: [] });
    }
  }
});
