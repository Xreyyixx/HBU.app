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

function getAppBaseUrl() {
    // self.location is the URL of sw.js itself (e.g. "https://xreyyixx.github.io/HBU.app/sw.js")
    // new URL('./', self.location.href).href will ALWAYS yield the exact directory ("https://xreyyixx.github.io/HBU.app/")
    return new URL('./', self.location.href).href;
}

function resolveAppUrl(rawUrl) {
    const appBaseUrl = getAppBaseUrl();
    if (!rawUrl || rawUrl === '/' || rawUrl === './' || rawUrl === 'index.html' || rawUrl === '/index.html') {
        return appBaseUrl;
    }
    const str = String(rawUrl).trim();
    if (str.startsWith('http://') || str.startsWith('https://')) {
        return str;
    }
    // If it contains a hash (#voting, /#voting, index.html#voting, /index.html#voting, #news, etc.)
    if (str.includes('#')) {
        const hash = '#' + str.split('#')[1];
        return appBaseUrl + hash;
    }
    // Relative file (e.g. 'admin.html', '/admin.html')
    const rel = str.replace(/^\/+/, '');
    return new URL(rel, appBaseUrl).href;
}

// Обработка клика по системному уведомлению
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const appBaseUrl = getAppBaseUrl();
    const rawTarget = event.notification.data?.url || event.notification.data?.rawUrl || '/';
    const targetUrl = resolveAppUrl(rawTarget);
    const hashPart = targetUrl.includes('#') ? ('#' + targetUrl.split('#')[1]) : '';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
            const baseWithoutSlash = appBaseUrl.endsWith('/') ? appBaseUrl.slice(0, -1) : appBaseUrl;

            // Если уже есть открытая вкладка/окно PWA
            for (const client of clientList) {
                if (client.url && (client.url.startsWith(appBaseUrl) || client.url === baseWithoutSlash || client.url.startsWith(baseWithoutSlash + '?'))) {
                    if ('focus' in client) {
                        try {
                            await client.focus();
                        } catch (e) {}
                    }

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
    const appBaseUrl = getAppBaseUrl();
    let payload = {
        title: 'HariVision 2026',
        body: 'Новое уведомление от Haribo Broadcasting Union!',
        icon: 'icons/HBU_icon.png',
        badge: 'icons/HBU_icon.png',
        tag: 'hbu_push_' + Date.now(),
        url: '/#voting'
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

    const rawTarget = payload.url || payload.data?.url || '/#voting';
    const targetUrl = resolveAppUrl(rawTarget);

    let iconUrl;
    try {
        const iconPath = (payload.icon || 'icons/HBU_icon.png').replace(/^\/+/, '');
        iconUrl = new URL(iconPath, appBaseUrl).href;
    } catch (e) {
        iconUrl = undefined;
    }

    const notifOptions = {
        body: payload.body || '',
        data: {
            url: targetUrl,
            rawUrl: rawTarget,
            time: Date.now()
        }
    };
    if (iconUrl) {
        notifOptions.icon = iconUrl;
        notifOptions.badge = iconUrl;
    }
    if (payload.tag) {
        notifOptions.tag = String(payload.tag);
    }

    event.waitUntil(
        self.registration.showNotification(payload.title || 'HariVision 2026', notifOptions)
            .catch((err) => {
                console.warn('[SW Push] Fallback minimal notification:', err);
                return self.registration.showNotification(payload.title || 'HariVision 2026', {
                    body: payload.body || '',
                    data: { url: targetUrl }
                });
            })
    );
});

