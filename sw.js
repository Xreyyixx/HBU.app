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

    // КРИТИЧНО: Никогда не перехватывать и не кэшировать API запросы и стримы SSE!
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    event.respondWith(
        fetch(event.request, { cache: 'no-store' })
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    }).catch(() => {});
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
    let urlToOpen = event.notification.data?.url || 'index.html';
    if (urlToOpen === '/') urlToOpen = 'index.html';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    if (client.url && 'navigate' in client && urlToOpen !== 'index.html') {
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

// Обработка фоновых push-сообщений (Web Push даже при закрытом приложении)
self.addEventListener('push', (event) => {
    let payload = {
        title: 'HariVision 2026',
        body: 'Новое уведомление от Haribo Broadcasting Union!',
        icon: './icons/HBU_icon.png',
        badge: './icons/HBU_icon.png',
        tag: 'hbu_push_' + Date.now(),
        data: { url: 'index.html' }
    };
    if (event.data) {
        try {
            const parsed = event.data.json();
            payload = { ...payload, ...parsed };
        } catch (e) {
            payload.body = event.data.text();
        }
    }

    const notifOptions = {
        body: payload.body || '',
        icon: new URL(payload.icon || '/icons/HBU_icon.png', self.location.origin).href,
        badge: new URL(payload.badge || '/icons/HBU_icon.png', self.location.origin).href,
        tag: payload.tag || ('hbu_push_' + Date.now()),
        renotify: true,
        data: payload.data || { url: '/' }
    };

    if (Array.isArray(payload.vibrate)) {
        notifOptions.vibrate = payload.vibrate;
    }

    event.waitUntil(
        self.registration.showNotification(payload.title || 'HariVision 2026', notifOptions)
    );
});

