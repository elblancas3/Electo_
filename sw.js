// =====================================================
//  SERVICE WORKER - Levantamiento NL PWA
//  Estrategia: Cache First para assets, Network First para API
// =====================================================

const CACHE_NAME = 'levantamiento-nl-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap'
];

// ===================== INSTALL =====================
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ===================== ACTIVATE =====================
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ===================== FETCH =====================
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Supabase API → Network First con fallback a cola offline
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(networkFirstWithQueue(event.request));
    return;
  }

  // Assets estáticos → Cache First
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback: devolver index.html para navegación SPA
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ===================== NETWORK FIRST =====================
async function networkFirstWithQueue(request) {
  try {
    const response = await fetch(request.clone());
    // Cachear respuestas GET exitosas
    if (request.method === 'GET' && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Sin red: devolver caché si existe
    const cached = await caches.match(request);
    if (cached) return cached;

    // Para POSTs (visitas): encolar para sync posterior
    if (request.method === 'POST' || request.method === 'PATCH') {
      await queueForSync(request);
      return new Response(JSON.stringify({ queued: true, offline: true }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Sin conexión' }), {
      status: 503, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ===================== BACKGROUND SYNC =====================
const SYNC_QUEUE_KEY = 'sync-queue';

async function queueForSync(request) {
  const body = await request.clone().text();
  const queue = await getQueue();
  queue.push({
    url:     request.url,
    method:  request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body,
    timestamp: Date.now()
  });
  // Guardar en Cache Storage como fallback (sin IndexedDB en SW)
  const cache = await caches.open(CACHE_NAME + '-queue');
  await cache.put(
    new Request(SYNC_QUEUE_KEY),
    new Response(JSON.stringify(queue))
  );
}

async function getQueue() {
  try {
    const cache = await caches.open(CACHE_NAME + '-queue');
    const res   = await cache.match(new Request(SYNC_QUEUE_KEY));
    return res ? await res.json() : [];
  } catch { return []; }
}

// Background sync cuando regresa la conexión
self.addEventListener('sync', event => {
  if (event.tag === 'sync-visitas') {
    event.waitUntil(processSyncQueue());
  }
});

async function processSyncQueue() {
  const queue = await getQueue();
  if (!queue.length) return;

  const failed = [];
  for (const item of queue) {
    try {
      const response = await fetch(item.url, {
        method:  item.method,
        headers: item.headers,
        body:    item.body
      });
      if (!response.ok) failed.push(item);
    } catch {
      failed.push(item);
    }
  }

  // Guardar solo los que fallaron
  const cache = await caches.open(CACHE_NAME + '-queue');
  await cache.put(
    new Request(SYNC_QUEUE_KEY),
    new Response(JSON.stringify(failed))
  );

  // Notificar a la app
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage({
    type: 'sync-complete',
    synced: queue.length - failed.length,
    pending: failed.length
  }));
}
