/* HydroElec Track — service worker (mode hors-ligne du web / PWA).
 *
 *  - Navigation (index.html)  : réseau d'abord (3 s max) puis cache -> l'appli s'ouvre toujours, même sans réseau.
 *  - Fichiers de l'appli       : cache d'abord + mise à jour en arrière-plan (les fichiers Vite sont versionnés par hash).
 *  - Tuiles de carte OSM       : cache d'abord, plafonné (les zones déjà consultées restent visibles hors-ligne).
 *  - /api/* et autres domaines : JAMAIS interceptés (la synchronisation gère elle-même le hors-ligne).
 *
 * Changer VERSION force le renouvellement du cache de l'appli.
 */
const VERSION = 'v2';
const APP_CACHE = `hydroelec-app-${VERSION}`;
const TILE_CACHE = `hydroelec-tiles-${VERSION}`;
const MAX_TILES = 400;
const SHELL = ['./', './index.html', './manifest.json', './logo.svg', './favicon.ico', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
      // un fichier manquant ne doit pas faire échouer toute l'installation
      Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([APP_CACHE, TILE_CACHE]);
      for (const name of await caches.keys()) {
        if (name.startsWith('hydroelec-') && !keep.has(name)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// La page envoie la liste des fichiers chargés lors de la 1re visite (non interceptés car pas encore contrôlée).
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'CACHE_URLS' || !Array.isArray(msg.urls)) return;
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
      Promise.all(
        msg.urls
          .filter((u) => typeof u === 'string' && u.startsWith(self.location.origin))
          .map((u) => cache.add(u).catch(() => {})),
      ),
    ),
  );
});

const isTile = (url) => /(^|\.)tile\.openstreetmap\.org$/.test(url.hostname);

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // les plus anciennes d'abord
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILE_CACHE);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok) {
            cache.put(req, res.clone());
            trimCache(TILE_CACHE, MAX_TILES);
          }
          return res;
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        // Le téléchargement continue même si on répond depuis le cache après 3 s : sur un réseau lent, la nouvelle
        // version (un seul gros index.html) finit quand même par arriver et sera servie au lancement suivant.
        const network = fetch(req).then((res) => {
          if (res.ok) cache.put('./index.html', res.clone());
          return res;
        });
        event.waitUntil(network.catch(() => {}));
        try {
          return await withTimeout(network, 3000);
        } catch {
          return (await cache.match('./index.html')) || (await cache.match('./')) || network.catch(() => Response.error());
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(refresh); // mise à jour silencieuse en arrière-plan (le SW reste en vie jusqu'à la fin)
        return hit;
      }
      return (await refresh) || Response.error();
    })(),
  );
});

// --- Notifications Web Push --------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'HydroElec Track', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'HydroElec Track', {
      body: data.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'het-assignment',
      renotify: true,
      data: { url: data.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of all) {
        if ('focus' in c) {
          await c.focus();
          if ('navigate' in c) await c.navigate(target).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
