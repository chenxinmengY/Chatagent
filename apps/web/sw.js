const CACHE = 'chatagent-shell-v30';
const ASSETS = ['/chats','/chats.js','/chats.css','/chat-scope.js','/', '/app.js', '/bubble-arrival.js', '/course.js', '/outbox.js', '/message-presentation.js', '/style.css', '/desktop.css', '/shell.js', '/appearance.js', '/appearance-values.js', '/customize.css', '/customize.js', '/settings', '/plugins', '/plugins.js', '/capability-cards.js', '/chat-settings.js', '/chat-settings.css', '/tool-catalog.js', '/plugin-detail.js', '/plugin-detail.css', '/plugin-records.js', '/whale.svg', '/overview', '/overview.js', '/archive', '/archive.js', '/devices', '/devices.js', '/manage', '/manage.js', '/manage.css', '/models', '/models.js', '/profiles', '/profiles.js', '/profiles.css', '/profile-chat.js', '/regions.json', '/region-picker.js'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key.startsWith('chatagent-shell-') && key !== CACHE).map(key => caches.delete(key)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
      return response;
    } catch (error) {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      throw error;
    }
  })());
});

