// =============================================================
// HARIVISION NOTIFICATIONS SERVICE
// Web Notifications API & Service Worker Push Integration
// =============================================================

const STORAGE_KEY = 'harivision_notifications_enabled';

export function isNotificationSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotificationPermission() {
    if (!isNotificationSupported()) return 'unsupported';
    return Notification.permission;
}

export function isNotificationsEnabled() {
    if (!isNotificationSupported()) return false;
    const pref = localStorage.getItem(STORAGE_KEY);
    return Notification.permission === 'granted' && pref !== 'false';
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

// Регистрация подписки Web Push на сервере для доставки в фоне и при закрытом сайте
export async function syncPushSubscription() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        return;
    }
    if (!isNotificationsEnabled()) {
        return;
    }
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const keyRes = await fetch('/api/push/vapid-public-key');
            if (!keyRes.ok) return;
            const data = await keyRes.json();
            if (!data || !data.publicKey) return;
            const applicationServerKey = urlBase64ToUint8Array(data.publicKey);
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey
            });
        }
        if (sub) {
            await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: sub })
            });
        }
    } catch (e) {
        console.warn('Web Push subscription error:', e);
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
    if (!isNotificationSupported()) {
        if (typeof window.showToast === 'function') {
            window.showToast('Уведомления не поддерживаются вашим браузером');
        }
        return false;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            localStorage.setItem(STORAGE_KEY, 'true');
            updateNotificationUI();
            await syncPushSubscription();
            if (typeof window.showToast === 'function') {
                window.showToast('Уведомления успешно включены! 🔔');
            }
            // Отправляем приветственное тестовое уведомление
            sendSystemNotification(
                'HariVision 2026 🔔',
                'Уведомления включены! Теперь вы будете первыми узнавать о старте голосования и новостях конкурса.',
                '/',
                'welcome-notif'
            );
            return true;
        } else if (permission === 'denied') {
            localStorage.setItem(STORAGE_KEY, 'false');
            updateNotificationUI();
            await unsubscribePush();
            if (typeof window.showToast === 'function') {
                window.showToast('Уведомления заблокированы в настройках браузера');
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
            await syncPushSubscription();
            if (typeof window.showToast === 'function') {
                window.showToast('Уведомления возобновлены 🔔');
            }
            sendSystemNotification(
                'HariVision 2026 🔔',
                'Уведомления снова активны. Вы не пропустите старт голосования!',
                '/',
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

    const options = {
        body,
        icon: '/icons/HBU_icon.png',
        badge: '/icons/HBU_icon.png',
        tag: tag || ('hbu_' + Date.now()),
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url }
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
            if (url && url !== '/') {
                window.location.hash = url.replace(/^\//, '');
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

// Экспорт обработчика в глобальную область видимости для кнопок в HTML
if (typeof window !== 'undefined') {
    window.handleNotificationToggle = toggleNotifications;
}
