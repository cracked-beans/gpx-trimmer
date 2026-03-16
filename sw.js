const CACHE     = 'gpx-trimmer-v3';
const SHARE_KEY = 'gpx-trimmer-share';

const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Barlow:wght@300;400;500;600&display=swap'
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// ── Activate: drop old caches ─────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== SHARE_KEY).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Intercept share-target POST — the manifest action points to ./index.html
  // so the POST lands on index.html with the share data in the form body.
  // We detect it by the presence of the multipart POST body.
  if (req.method === 'POST' && url.pathname.includes('index.html')) {
    event.respondWith(handleShareTarget(req));
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});

// ── Share Target handler ──────────────────────────────────────────────────────
async function handleShareTarget(request) {
  try {
    const formData = await request.formData();

    // Collect any files shared (field name matches manifest "name": "gpx")
    const rawFiles = formData.getAll('gpx');

    // Also try generic "file" / "files" fields some apps use
    const extra = [...formData.getAll('file'), ...formData.getAll('files')];
    const allFiles = [...rawFiles, ...extra].filter(f => f instanceof File && f.size > 0);

    if (allFiles.length > 0) {
      // Serialize to base64 so it survives the cache round-trip
      const serialised = await Promise.all(allFiles.map(async file => ({
        name: file.name || 'shared.gpx',
        type: file.type || 'application/gpx+xml',
        data: bufferToBase64(await file.arrayBuffer())
      })));

      const shareCache = await caches.open(SHARE_KEY);
      await shareCache.put('./pending',
        new Response(JSON.stringify(serialised),
          { headers: { 'Content-Type': 'application/json' } })
      );

      // Notify any open tabs
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'SHARE_RECEIVED' });
      }
    }
  } catch (e) {
    console.error('[SW] share-target error:', e);
  }

  // Always redirect to the app page after handling
  return Response.redirect('./index.html', 303);
}

// ── Message from page: deliver pending shared files ───────────────────────────
self.addEventListener('message', async event => {
  if (event.data?.type !== 'GET_SHARED_FILES') return;

  const shareCache = await caches.open(SHARE_KEY);
  const response   = await shareCache.match('./pending');

  if (response) {
    const files = await response.json();
    await shareCache.delete('./pending');          // consume once
    event.source.postMessage({ type: 'SHARED_FILES', files });
  } else {
    event.source.postMessage({ type: 'SHARED_FILES', files: [] });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
