const CACHE_NAME = 'harivision-v' + Date.now();

// При установке немедленно активируем новый Service Worker
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Активация: немедленно удаляем ВСЕ старые кэши
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => caches.delete(name))
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Network First стратегия: всегда запрашивать свежий код из сети, кэш только при полном оффлайне
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    // Игнорируем внешние сервисы (Firebase, Google Fonts, CDN)
    if (url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        fetch(event.request, { cache: 'no-store' })
            .then((response) => {
                if (response && response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                // Если оффлайн, пытаемся отдать из кэша
                return caches.match(event.request);
            })
    );
});

// Обработка клика по системному уведомлению
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlToOpen = event.notification.data?.url || '/';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    if (client.url && 'navigate' in client && urlToOpen !== '/') {
                        client.navigate(urlToOpen);
                    }
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(urlToOpen);
            }
        })
    );
});

// Обработка фоновых push-сообщений (Web Push)
self.addEventListener('push', (event) => {
    let payload = {
        title: 'HariVision 2026',
        body: 'Новое уведомление от Haribo Broadcasting Union!',
        icon: '/icons/HBU_icon.png',
        badge: '/icons/HBU_icon.png',
        data: { url: '/' }
    };
    if (event.data) {
        try {
            payload = { ...payload, ...event.data.json() };
        } catch (e) {
            payload.body = event.data.text();
        }
    }
    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: payload.icon || '/icons/HBU_icon.png',
            badge: payload.badge || '/icons/HBU_icon.png',
            vibrate: [200, 100, 200],
            data: payload.data || { url: '/' }
        })
    );
});

