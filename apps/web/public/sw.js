const CACHE_NAME = 'opencut-ai-v1';
const OFFLINE_URL = '/';

const INITIAL_CACHED_RESOURCES = [
  '/',
  '/projects',
  '/manifest.json',
  '/favicon.svg',
  '/icons/favicon-32x32.png',
  '/icons/icon-192x192.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Setting {cache: 'reload'} forces network fetch and ignores browser cache
    await cache.addAll(INITIAL_CACHED_RESOURCES);
  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Enable navigation preload if it's supported.
    if ('navigationPreload' in self.registration) {
      await self.registration.navigationPreload.enable();
    }
    // Remove old caches
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames.map(cacheName => {
        if (cacheName !== CACHE_NAME) {
          return caches.delete(cacheName);
        }
      })
    );
  })());
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;
  // Don't intercept API calls
  if (event.request.url.includes('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    // Try to get response from network first (Network-First approach for fresh UI)
    try {
      const preloadResponse = await event.preloadResponse;
      if (preloadResponse) {
        return preloadResponse;
      }

      const networkResponse = await fetch(event.request);
      
      // Cache the successful network response for later offline use
      // Only cache requests from our origin or specific CDNs
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
        cache.put(event.request, networkResponse.clone());
      }
      return networkResponse;
      
    } catch (error) {
      // Network failed (offline), fallback to cache
      console.log('Fetch failed; returning offline page instead.', error);

      const cachedResponse = await cache.match(event.request);
      if (cachedResponse) {
        return cachedResponse;
      }

      // If it's a page navigation request, return the root shell/offline url
      if (event.request.mode === 'navigate') {
        const fallback = await cache.match(OFFLINE_URL);
        if (fallback) return fallback;
      }

      // If nothing found in cache, return an error (or 404/dummy asset)
      return new Response('Network error happened', {
        status: 408,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  })());
});
