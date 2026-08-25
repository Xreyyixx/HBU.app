const CACHE_NAME = 'harivision-static';

const STATIC_ASSETS = [
    './',
    './index.html',
    './admin.html',
    './national.html',
    './config.js',
    './app.js',
    './admin.js',
    './manifest.json'
];

// Установка Service Worker
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .catch((error) => {
                console.log('Cache installation error:', error);
            })
    );

    // Новая версия Service Worker не ждёт закрытия старой
    self.skipWaiting();
});

// Активация и очистка старых кэшей
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        }).then(() => {
            return self.clients.claim();
        })
    );
});

// Обработка запросов
self.addEventListener('fetch', (event) => {
    // Только GET-запросы
    if (event.request.method !== 'GET') return;

    // Firebase, Google Fonts, Tailwind CDN, Rutube и прочее
    // не пытаемся обслуживать нашим кэшем
    const url = new URL(event.request.url);

    if (url.origin !== self.location.origin) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Если получили нормальный ответ из сети —
                // сохраняем свежую версию в кэш
                if (response && response.status === 200) {
                    const responseClone = response.clone();

                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, responseClone);
                    });
                }

                return response;
            })
            .catch(() => {
                // Если сети нет — используем сохранённую версию
                return caches.match(event.request);
            })
    );
});
