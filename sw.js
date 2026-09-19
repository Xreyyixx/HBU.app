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

    let rawUrl = event.notification.data?.url || '/';
    // Очищаем от устаревших путей index.html: "index.html#voting" -> "/#voting", "index.html" -> "/"
    let cleanPath = String(rawUrl || '/');
    if (cleanPath.startsWith('index.html')) {
        cleanPath = cleanPath.replace(/^index\.html/, '') || '/';
    }
    if (!cleanPath.startsWith('/') && !cleanPath.startsWith('#') && !cleanPath.startsWith('http://') && !cleanPath.startsWith('https://')) {
        cleanPath = '/' + cleanPath;
    }
    if (cleanPath === '') cleanPath = '/';

    // Формируем абсолютный URL с текущего origin
    let targetUrl;
    try {
        targetUrl = new URL(cleanPath, self.location.origin).href;
    } catch (e) {
        targetUrl = self.location.origin + '/';
    }

    const hashPart = cleanPath.startsWith('#') ? cleanPath : (targetUrl.includes('#') ? '#' + targetUrl.split('#')[1] : '');

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
            // Если уже есть открытая вкладка/окно PWA
            for (const client of clientList) {
                if ('focus' in client) {
                    try {
                        await client.focus();
                    } catch (e) {}

                    if ('navigate' in client && client.url !== targetUrl) {
                        try {
                            await client.navigate(targetUrl);
                        } catch (e) {}
                    }
                    if (client.postMessage) {
                        client.postMessage({
                            type: 'NOTIFICATION_CLICK',
                            url: targetUrl,
                            hash: hashPart
                        });
                    }
                    return;
                }
            }
            // Если открытых окон нет — открываем целевой чистый URL
            if (self.clients.openWindow) {
                return self.clients.openWindow(targetUrl);
            }
        })
    );
});

// Обработка фоновых push-сообщений (Web Push даже при закрытом приложении)
self.addEventListener('push', (event) => {
    let payload = {
        title: 'HariVision 2026',
        body: 'Новое уведомление от Haribo Broadcasting Union!',
        icon: '/icons/HBU_icon.png',
        badge: '/icons/HBU_icon.png',
        tag: 'hbu_push_' + Date.now(),
        data: { url: '/#voting' }
    };
    if (event.data) {
        try {
            const parsed = event.data.json();
            payload = { ...payload, ...parsed };
        } catch (e) {
            try {
                payload.body = event.data.text();
            } catch (e2) {}
        }
    }

    let iconUrl = '/icons/HBU_icon.png';
    let badgeUrl = '/icons/HBU_icon.png';
    try {
        iconUrl = new URL(payload.icon || '/icons/HBU_icon.png', self.location.origin).href;
        badgeUrl = new URL(payload.badge || '/icons/HBU_icon.png', self.location.origin).href;
    } catch (e) {}

    const notifOptions = {
        body: payload.body || '',
        icon: iconUrl,
        badge: badgeUrl,
        tag: payload.tag || ('hbu_push_' + Date.now()),
        renotify: true,
        data: payload.data || { url: '/#voting' }
    };

    if (Array.isArray(payload.vibrate)) {
        notifOptions.vibrate = payload.vibrate;
    }

    event.waitUntil(
        self.registration.showNotification(payload.title || 'HariVision 2026', notifOptions)
            .catch((err) => {
                console.warn('[SW Push] Fallback minimal notification:', err);
                return self.registration.showNotification(payload.title || 'HariVision 2026', {
                    body: payload.body || '',
                    data: payload.data || { url: '/#voting' }
                });
            })
    );
});

