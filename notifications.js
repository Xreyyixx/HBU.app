// =============================================================
// HARIVISION NOTIFICATIONS SERVICE
// Web Notifications API & Service Worker Push Integration
// =============================================================

const STORAGE_KEY = 'harivision_notifications_enabled';
export const PERMANENT_VAPID_PUBLIC_KEY = 'BPZuY8-gjysoqNyqec1Rqdz2iPd1gNRiwiP0kSOnAxWaSuVGsRvKafnY75wGl5vSsExJGAnC3RPkmzjhMo42wRw';

export function isNotificationSupported() {
    return typeof window !== 'undefined' && (
        'Notification' in window || 
        ('serviceWorker' in navigator && 'PushManager' in window)
    );
}

export function getNotificationPermission() {
    if (!isNotificationSupported()) return 'unsupported';
    if ('Notification' in window) {
        return Notification.permission;
    }
    return 'default';
}

export function isNotificationsEnabled() {
    if (!isNotificationSupported()) return false;
    const pref = localStorage.getItem(STORAGE_KEY);
    const perm = getNotificationPermission();
    return perm === 'granted' && pref !== 'false';
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function arrayBufferToBase64Url(buffer) {
    if (!buffer) return '';
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

// Регистрация подписки Web Push на сервере для доставки в фоне и при закрытом сайте
export async function syncPushSubscription() {
    if (typeof window === 'undefined') {
        return { success: false, reason: 'Window is not defined' };
    }
    if (!('serviceWorker' in navigator)) {
        return { success: false, reason: 'Service worker не поддерживается браузером' };
    }
    if (!('PushManager' in window)) {
        return { success: false, reason: 'PushManager недоступен (на iPhone запустите сайт с домашнего экрана Домой)' };
    }
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        return { success: false, reason: 'Разрешение на уведомления не предоставлено (' + Notification.permission + ')' };
    }

    try {
        console.log('[WebPush] Starting registration...');

        // 1. Получаем регистрацию Service Worker
        let reg = await navigator.serviceWorker.getRegistration('/');
        if (!reg) {
            reg = await navigator.serviceWorker.getRegistration();
        }
        if (!reg) {
            reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        }

        // Если pushManager еще не доступен на reg, проверяем ready с надежным таймаутом
        let pm = reg ? reg.pushManager : null;
        if (!pm && 'ready' in navigator.serviceWorker) {
            try {
                const readyReg = await Promise.race([
                    navigator.serviceWorker.ready,
                    new Promise((_, r) => setTimeout(() => r(null), 4000))
                ]);
                if (readyReg && readyReg.pushManager) {
                    reg = readyReg;
                    pm = readyReg.pushManager;
                }
            } catch (e) {
                pm = reg ? reg.pushManager : null;
            }
        }

        if (!pm) {
            return { success: false, reason: 'PushManager недоступен в Service Worker' };
        }

        // 2. VAPID ключ: используем постоянный ключ без сетевых задержек (сохраняет контекст жеста пользователя на iOS)
        const targetKeyBytes = urlBase64ToUint8Array(PERMANENT_VAPID_PUBLIC_KEY);

        // 3. Проверяем текущую подписку PushManager
        let sub = await pm.getSubscription();

        if (sub) {
            // Проверяем соответствие VAPID ключа
            let keyMatches = true;
            if (sub.options && sub.options.applicationServerKey) {
                try {
                    const rawKey = sub.options.applicationServerKey;
                    const cur = rawKey instanceof ArrayBuffer ? new Uint8Array(rawKey) : new Uint8Array(rawKey.buffer || rawKey);
                    if (cur.length > 0 && cur.length === targetKeyBytes.length) {
                        for (let i = 0; i < cur.length; i++) {
                            if (cur[i] !== targetKeyBytes[i]) {
                                keyMatches = false;
                                break;
                            }
                        }
                    }
                } catch (cmpErr) {
                    console.warn('[WebPush] Error comparing VAPID keys, keeping current subscription:', cmpErr);
                    keyMatches = true;
                }
            }

            if (!keyMatches) {
                console.log('[WebPush] VAPID ключ подписки изменился, обновляем подписку...');
                try {
                    await sub.unsubscribe();
                    sub = null;
                } catch (e) {
                    console.warn('[WebPush] Ошибка отписки от старого ключа:', e);
                }
            } else {
                console.log('[WebPush] Найдена существующая валидная подписка браузера');
            }
        }

        // 4. Если подписки нет — создаем новую через PushManager
        if (!sub) {
            console.log('[WebPush] Создание новой подписки pushManager.subscribe...');
            sub = await pm.subscribe({
                userVisibleOnly: true,
                applicationServerKey: targetKeyBytes
            });
            console.log('[WebPush] Подписка в браузере успешно создана!');
        }

        // 5. Сериализуем данные подписки с поддержкой WebKit / Safari iOS
        const jsonSub = (typeof sub.toJSON === 'function') ? sub.toJSON() : {};
        let p256dh = jsonSub.keys?.p256dh || '';
        let auth = jsonSub.keys?.auth || '';

        if ((!p256dh || !auth) && typeof sub.getKey === 'function') {
            try {
                if (!p256dh) {
                    const rawP = sub.getKey('p256dh');
                    if (rawP) p256dh = arrayBufferToBase64Url(rawP);
                }
                if (!auth) {
                    const rawA = sub.getKey('auth');
                    if (rawA) auth = arrayBufferToBase64Url(rawA);
                }
            } catch (kErr) {
                console.warn('[WebPush] Fallback getKey error:', kErr);
            }
        }

        if (!p256dh || !auth) {
            throw new Error('Браузер не предоставил криптоключи p256dh / auth.');
        }

        const subData = {
            endpoint: sub.endpoint,
            expirationTime: sub.expirationTime || null,
            keys: { p256dh, auth }
        };

        // 6. Сохраняем на сервере
        const subRes = await fetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: subData })
        });
        const subResult = await subRes.json();
        if (!subRes.ok || !subResult.success) {
            throw new Error(subResult.error || `Ошибка сервера HTTP ${subRes.status}`);
        }

        console.log('[WebPush] Устройство успешно зарегистрировано на сервере! Всего подписчиков:', subResult.subscribersCount);
        return { success: true, subscribersCount: subResult.subscribersCount };
    } catch (e) {
        console.error('[WebPush Subscription Error]', e);
        return { success: false, error: e.message || String(e) };
    }
}

// Отписка от Web Push
export async function unsubscribePush() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
            const endpoint = sub.endpoint;
            await sub.unsubscribe();
            await fetch('/api/push/unsubscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint })
            });
        }
    } catch (e) {
        console.warn('Web Push unsubscribe error:', e);
    }
}

// Запрос разрешения на показ системных уведомлений
export async function requestNotificationPermission() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isStandalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    if (isIOS && !isStandalone) {
        if (typeof window.showToast === 'function') {
            window.showToast('📱 На iPhone для фоновых Push добавьте сайт на экран «Домой»: Поделиться → «На экран Домой»', 7000);
        }
    }

    if (!isNotificationSupported()) {
        if (typeof window.showToast === 'function') {
            window.showToast('Уведомления не поддерживаются вашим браузером');
        }
        return false;
    }

    const isInIframe = window.self !== window.top;
    if (isInIframe && Notification.permission !== 'granted') {
        try {
            const win = window.open(window.location.origin + '/?autoSubscribe=1', '_blank');
            if (win) {
                if (typeof window.showToast === 'function') {
                    window.showToast('Открываем сайт в отдельной вкладке для подтверждения разрешения браузера...', 5000);
                }
                return false;
            }
        } catch (e) {}
        if (typeof window.showToast === 'function') {
            window.showToast('⚠️ Браузер блокирует запрос разрешений во фрейме. Откройте сайт в отдельной вкладке (кнопка ↗ вверху).', 7000);
        }
        return false;
    }

    try {
        let permission = Notification.permission;
        if (permission === 'default') {
            permission = await Notification.requestPermission();
        }
        if (permission === 'granted') {
            localStorage.setItem(STORAGE_KEY, 'true');
            updateNotificationUI();
            const pushResult = await syncPushSubscription();
            if (typeof window.showToast === 'function') {
                if (pushResult && pushResult.success) {
                    window.showToast(`✅ Уведомления включены! Устройство подписано на Web Push (${pushResult.subscribersCount} в сети) 🔔`, 6000);
                } else {
                    window.showToast(`⚠️ Разрешение дано, но Web Push не зарегистрирован: ${pushResult.error || pushResult.reason}`, 7000);
                }
            }
            // Отправляем приветственное тестовое уведомление
            sendSystemNotification(
                'HariVision 2026 🔔',
                'Уведомления включены! Теперь вы будете первыми узнавать о старте голосования и новостях конкурса.',
                '#voting',
                'welcome-notif'
            );
            return true;
        } else if (permission === 'denied') {
            localStorage.setItem(STORAGE_KEY, 'false');
            updateNotificationUI();
            await unsubscribePush();
            if (typeof window.showToast === 'function') {
                window.showToast('Уведомления заблокированы в настройках браузера. Разрешите их в настройках сайта.');
            }
            return false;
        } else {
            return false;
        }
    } catch (err) {
        console.warn('Error requesting notification permission:', err);
        return false;
    }
}

// Переключение состояния уведомлений
export async function toggleNotifications() {
    if (!isNotificationSupported()) {
        if (typeof window.showToast === 'function') {
            window.showToast('Уведомления не поддерживаются данным браузером');
        }
        return;
    }

    const currentPerm = Notification.permission;

    if (currentPerm === 'default') {
        await requestNotificationPermission();
    } else if (currentPerm === 'granted') {
        const currentlyEnabled = isNotificationsEnabled();
        if (currentlyEnabled) {
            localStorage.setItem(STORAGE_KEY, 'false');
            updateNotificationUI();
            await unsubscribePush();
            if (typeof window.showToast === 'function') {
                window.showToast('Уведомления приостановлены 🔕');
            }
        } else {
            localStorage.setItem(STORAGE_KEY, 'true');
            updateNotificationUI();
            const pushResult = await syncPushSubscription();
            if (typeof window.showToast === 'function') {
                if (pushResult && pushResult.success) {
                    window.showToast(`✅ Уведомления возобновлены! Web Push активен (${pushResult.subscribersCount} в сети) 🔔`, 6000);
                } else {
                    window.showToast(`⚠️ Ошибка подключения Web Push: ${pushResult.error || pushResult.reason}`, 7000);
                }
            }
            sendSystemNotification(
                'HariVision 2026 🔔',
                'Уведомления снова активны. Вы не пропустите старт голосования!',
                '#voting',
                'resumed-notif'
            );
        }
    } else if (currentPerm === 'denied') {
        if (typeof window.showToast === 'function') {
            window.showToast('Разрешение отклонено в браузере. Разрешите уведомления в настройках сайта.');
        }
    }
}

// Отправка системного браузерного уведомления
export async function sendSystemNotification(title, body, url = '/', tag = null) {
    if (!isNotificationsEnabled()) {
        return;
    }

    // Очищаем URL от index.html для чистой навигации
    let cleanUrl = url || '/';
    if (cleanUrl.startsWith('index.html')) {
        cleanUrl = cleanUrl.replace(/^index\.html/, '') || '/';
    }

    const options = {
        body,
        icon: '/icons/HBU_icon.png',
        badge: '/icons/HBU_icon.png',
        tag: tag || ('hbu_' + Date.now()),
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url: cleanUrl }
    };

    // 1. Пытаемся отправить через Service Worker (работает в фоновых вкладках)
    if ('serviceWorker' in navigator) {
        try {
            const reg = await navigator.serviceWorker.ready;
            if (reg && typeof reg.showNotification === 'function') {
                await reg.showNotification(title, options);
                return;
            }
        } catch (e) {
            console.warn('SW notification error, falling back to Notification constructor:', e);
        }
    }

    // 2. Fallback через стандартный конструктор Notification
    try {
        const notif = new Notification(title, {
            body: options.body,
            icon: options.icon,
            tag: options.tag
        });
        notif.onclick = () => {
            window.focus();
            if (cleanUrl) {
                if (cleanUrl.startsWith('#')) {
                    window.location.hash = cleanUrl;
                } else if (cleanUrl.includes('#')) {
                    const hashPart = cleanUrl.split('#')[1];
                    if (hashPart) window.location.hash = hashPart;
                } else if (cleanUrl !== '/' && cleanUrl !== '') {
                    window.location.href = cleanUrl;
                }
            }
            notif.close();
        };
    } catch (e) {
        console.warn('Notification constructor error:', e);
    }
}

// Обновление иконки колокольчика и статуса в UI
export function updateNotificationUI() {
    const enabled = isNotificationsEnabled();
    const perm = getNotificationPermission();

    // Кнопка в десктопной шапке
    const headerBtn = document.getElementById('header-notification-btn');
    const headerIndicator = document.getElementById('header-notif-indicator');
    if (headerBtn) {
        if (enabled) {
            headerBtn.classList.remove('text-slate-300', 'text-rose-400');
            headerBtn.classList.add('text-amber-400', 'border-amber-500/40', 'bg-amber-500/15');
            headerBtn.title = 'Уведомления активны (нажмите для отключения)';
            if (headerIndicator) headerIndicator.classList.remove('hidden');
        } else if (perm === 'denied') {
            headerBtn.classList.remove('text-amber-400', 'bg-amber-500/15');
            headerBtn.classList.add('text-slate-400', 'border-amber-500/10');
            headerBtn.title = 'Уведомления заблокированы в браузере';
            if (headerIndicator) headerIndicator.classList.add('hidden');
        } else {
            headerBtn.classList.remove('text-amber-400', 'bg-amber-500/15');
            headerBtn.classList.add('text-slate-300', 'border-amber-500/20');
            headerBtn.title = 'Включить системные уведомления';
            if (headerIndicator) headerIndicator.classList.add('hidden');
        }
    }

    // Переключатель в боковом меню мобильной версии
    const drawerStatus = document.getElementById('drawer-notif-status');
    const drawerBtn = document.getElementById('drawer-notif-btn');
    if (drawerStatus && drawerBtn) {
        if (enabled) {
            drawerStatus.innerText = 'Включены';
            drawerStatus.className = 'text-[10px] text-green-400 font-semibold';
            drawerBtn.innerText = 'Отключить';
            drawerBtn.className = 'px-3 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 text-slate-300 text-xs font-bold uppercase transition';
        } else if (perm === 'denied') {
            drawerStatus.innerText = 'Заблокированы в браузере';
            drawerStatus.className = 'text-[10px] text-rose-400 font-semibold';
            drawerBtn.innerText = 'Настройки';
            drawerBtn.className = 'px-3 py-1.5 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/25 text-rose-300 text-xs font-bold uppercase transition';
        } else {
            drawerStatus.innerText = 'Выключены';
            drawerStatus.className = 'text-[10px] text-amber-500/70';
            drawerBtn.innerText = 'Включить';
            drawerBtn.className = 'px-3 py-1.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/25 text-amber-300 text-xs font-bold uppercase transition';
        }
    }
}

// Экспорт обработчика и утилит в глобальную область видимости
if (typeof window !== 'undefined') {
    window.handleNotificationToggle = toggleNotifications;
    window.syncPushSubscription = syncPushSubscription;
    window.debugWebPush = async function() {
        const report = {
            isSecureContext: window.isSecureContext,
            serviceWorkerSupported: 'serviceWorker' in navigator,
            pushManagerSupported: 'PushManager' in window,
            notificationSupported: 'Notification' in window,
            permission: typeof Notification !== 'undefined' ? Notification.permission : 'n/a',
            localStoragePref: localStorage.getItem(STORAGE_KEY),
            activeServiceWorker: null,
            subscription: null
        };
        try {
            if ('serviceWorker' in navigator) {
                const reg = await navigator.serviceWorker.getRegistration('/');
                report.activeServiceWorker = reg ? { scope: reg.scope, active: Boolean(reg.active) } : null;
                if (reg && reg.pushManager) {
                    const sub = await reg.pushManager.getSubscription();
                    report.subscription = sub ? { endpoint: sub.endpoint.slice(0, 45) + '...' } : null;
                }
            }
        } catch (e) {
            report.error = e.message;
        }
        console.table(report);
        return report;
    };

    // Авто-активация уведомлений при переходе по ссылке из iframe
    if (window.location.search.includes('autoSubscribe=1') && window.self === window.top) {
        window.addEventListener('load', () => {
            setTimeout(() => {
                requestNotificationPermission();
            }, 600);
        });
    }
}
