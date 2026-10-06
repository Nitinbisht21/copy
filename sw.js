/**
 * Virtual Fence Tracker - Service Worker
 * Enables PWA installability, standalone execution mode, and offline resilience.
 */

const CACHE_NAME = 'vf-tracker-v3';
const STATIC_ASSETS = [
  '/',
  '/track',
  '/track.html',
  '/index.html',
  '/css/style.css',
  '/js/user-tracker.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch((err) => {
        console.warn('[SW] Cache addAll warning:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass service worker cache for live GPS telemetry, database, and device APIs
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/telemetry') ||
      url.pathname.startsWith('/devices') ||
      url.pathname.startsWith('/geofences') ||
      event.request.method !== 'GET') {
    return;
  }

  // Network-first strategy with cache fallback for static app assets
  event.respondWith(
    fetch(event.request)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const resClone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkRes;
      })
      .catch(() => caches.match(event.request))
  );
});
