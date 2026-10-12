// =====================================================================
// HariVision push worker (Cloudflare Workers, бесплатный тариф).
//
// Заменяет Render в том, что касается Web Push. Раз в минуту (Cron Trigger)
// забирает из Firestore очередь рассылки artistAccounts/broadcast_queue —
// туда пишут админка (тестовый push, рассылка) и публикация новостей/сезонов
// с галочкой «оповестить», — и отправляет уведомление на все подписки
// artistAccounts/push_sub_* напрямую в push-сервисы Apple / Google / Mozilla.
//
// Без зависимостей: шифрование (RFC 8291, aes128gcm) и подпись VAPID (RFC 8292)
// сделаны на WebCrypto, который есть в Workers.
//
// Переменные (Settings → Variables and Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY — те же, что были на Render (секреты)
//   VAPID_SUBJECT          — необязательно, по умолчанию mailto:support@harivision.org
//   FIREBASE_API_KEY, FIREBASE_PROJECT_ID — заданы в wrangler.toml
//   FIREBASE_SERVER_EMAIL, FIREBASE_SERVER_PASSWORD — необязательно; нужны, когда
//     опубликованы новые firestore.rules (список подписок там читает только админ)
//
// Адреса:
//   GET  /        — состояние очереди и итог последней попытки (без секретов)
//   POST /run     — разобрать очередь прямо сейчас, не дожидаясь минуты
// =====================================================================

const QUEUE_MAX_AGE_MS = 10 * 60 * 1000;
const ALLOWED_ORIGINS = ['https://xreyyixx.github.io', 'http://localhost:8765', 'http://localhost:3000'];

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(processQueue(env).catch(e => console.error('[push-worker]', e)));
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        const origin = request.headers.get('Origin') || '';
        const cors = ALLOWED_ORIGINS.includes(origin)
            ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' }
            : {};
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

        if (url.pathname === '/run' && request.method === 'POST') {
            const result = await processQueue(env).catch(e => ({ error: String(e && e.message || e) }));
            return json(result, cors);
        }
        if (url.pathname === '/' && request.method === 'GET') {
            const fs = firestore(env);
            const queue = await fs.get('artistAccounts/broadcast_queue').catch(e => ({ error: String(e.message || e) }));
            const subs = await fs.pushSubscriptions().catch(() => null);
            return json({
                ok: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
                subscribers: subs ? subs.length : null,
                pushHosts: subs ? countBy(subs.map(s => hostOf(s.endpoint))) : null,
                queue: queue && queue.fields ? {
                    title: queue.fields.title,
                    processed: queue.fields.processed,
                    createdAt: queue.fields.createdAt,
                    lastResult: queue.fields.lastResult || null
                } : queue
            }, cors);
        }
        return new Response('Not found', { status: 404, headers: cors });
    }
};

// ---------------------------------------------------------------------
// Очередь
// ---------------------------------------------------------------------
async function processQueue(env) {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { skipped: 'VAPID keys are not set' };
    const fs = firestore(env);
    const doc = await fs.get('artistAccounts/broadcast_queue');
    const item = doc && doc.fields;
    if (!item || !item.title) return { skipped: 'queue is empty' };
    if (item.processed) return { skipped: 'already processed' };
    if (Date.now() - (Number(item.createdAt) || 0) > QUEUE_MAX_AGE_MS) return { skipped: 'queue item is older than 10 minutes' };

    // Забираем запись атомарно (precondition по updateTime): если cron и /run, или старый
    // сервер на Render, сработают одновременно, отправит только тот, кто успел первым.
    const claimed = await fs.patch('artistAccounts/broadcast_queue',
        { processed: true, processedAt: Date.now(), processedBy: 'push-worker' },
        { updateTime: doc.updateTime });
    if (!claimed) return { skipped: 'claimed by another sender' };

    const subs = await fs.pushSubscriptions();
    const payload = JSON.stringify({
        title: item.title,
        body: item.body || item.message || '',
        icon: 'icons/HBU_icon_192.png',
        badge: 'icons/HBU_icon_192.png',
        tag: item.tag || ('broadcast_' + (item.createdAt || Date.now())),
        url: item.url || '/',
        data: { url: item.url || '/', time: Date.now() }
    });

    const results = await Promise.all(subs.map(async sub => {
        try {
            const res = await sendWebPush(sub, payload, env);
            if (res.status === 404 || res.status === 410) {
                await fs.delete('artistAccounts/' + sub.docId).catch(() => {});
                return { host: hostOf(sub.endpoint), status: res.status, pruned: true };
            }
            const ok = res.status >= 200 && res.status < 300;
            return { host: hostOf(sub.endpoint), status: res.status, ok, error: ok ? undefined : (await res.text()).slice(0, 160) };
        } catch (e) {
            return { host: hostOf(sub.endpoint), status: 0, error: String(e && e.message || e).slice(0, 160) };
        }
    }));

    const sent = results.filter(r => r.ok).length;
    const summary = {
        at: Date.now(),
        total: subs.length,
        sent,
        pruned: results.filter(r => r.pruned).length,
        errors: results.filter(r => r.error).slice(0, 5).map(r => `${r.host}: HTTP ${r.status} ${r.error}`)
    };
    // Если не ушло ни одного уведомления (а подписки есть), возвращаем запись в очередь:
    // следующая минута попробует снова, пока записи меньше 10 минут.
    await fs.patch('artistAccounts/broadcast_queue', {
        lastResult: JSON.stringify(summary),
        ...(sent === 0 && subs.length > summary.pruned ? { processed: false } : {})
    }).catch(() => {});
    console.log('[push-worker]', item.title, summary);
    return summary;
}

// ---------------------------------------------------------------------
// Firestore REST
// ---------------------------------------------------------------------
function firestore(env) {
    const projectId = env.FIREBASE_PROJECT_ID;
    const key = env.FIREBASE_API_KEY;
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    let tokenPromise = null;

    async function authHeaders() {
        if (!env.FIREBASE_SERVER_EMAIL || !env.FIREBASE_SERVER_PASSWORD) return {};
        if (!tokenPromise) {
            tokenPromise = fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: env.FIREBASE_SERVER_EMAIL, password: env.FIREBASE_SERVER_PASSWORD, returnSecureToken: true })
            }).then(r => r.json()).then(d => d.idToken || null).catch(() => null);
        }
        const token = await tokenPromise;
        return token ? { Authorization: 'Bearer ' + token } : {};
    }

    async function call(path, init = {}) {
        const sep = path.startsWith(':') ? '' : '/'; // documents:runQuery — без слэша
        const res = await fetch(`${base}${sep}${path}${path.includes('?') ? '&' : '?'}key=${key}`, {
            ...init,
            headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers || {}) }
        });
        return res;
    }

    return {
        async get(path) {
            const res = await call(path);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`Firestore GET ${path}: HTTP ${res.status}`);
            const d = await res.json();
            return { fields: fromFields(d.fields), updateTime: d.updateTime };
        },
        // Возвращает true, если запись прошла (false — если не выполнилось условие updateTime)
        async patch(path, data, precondition) {
            const mask = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
            const pre = precondition && precondition.updateTime ? '&currentDocument.updateTime=' + encodeURIComponent(precondition.updateTime) : '';
            const res = await call(`${path}?${mask}${pre}`, { method: 'PATCH', body: JSON.stringify({ fields: toFields(data) }) });
            if (res.status === 400 || res.status === 409 || res.status === 412) return false;
            if (!res.ok) throw new Error(`Firestore PATCH ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
            return true;
        },
        async delete(path) {
            await call(path, { method: 'DELETE' });
        },
        // Запрос, а не чтение всей коллекции: REST-листинг отдаёт документы страницами
        async pushSubscriptions() {
            const res = await call(':runQuery', {
                method: 'POST',
                body: JSON.stringify({ structuredQuery: {
                    from: [{ collectionId: 'artistAccounts' }],
                    where: { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'push_sub' } } }
                } })
            });
            if (!res.ok) throw new Error(`Firestore runQuery: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
            const rows = await res.json();
            return rows.filter(r => r.document).map(r => {
                const f = fromFields(r.document.fields);
                return { docId: r.document.name.split('/').pop(), endpoint: f.endpoint, keys: f.keys || {} };
            }).filter(s => typeof s.endpoint === 'string' && s.endpoint.startsWith('https://') && s.keys.p256dh && s.keys.auth);
        }
    };
}

function fromFields(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) out[k] = fromValue(v);
    return out;
}
function fromValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('timestampValue' in v) return v.timestampValue;
    if ('mapValue' in v) return fromFields(v.mapValue.fields);
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
    return null;
}
function toFields(data) {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'boolean') out[k] = { booleanValue: v };
        else if (typeof v === 'number') out[k] = { integerValue: String(Math.round(v)) };
        else out[k] = { stringValue: String(v) };
    }
    return out;
}

// ---------------------------------------------------------------------
// Web Push: шифрование RFC 8291 (aes128gcm) и подпись VAPID RFC 8292
// ---------------------------------------------------------------------
const enc = new TextEncoder();

export async function sendWebPush(sub, payload, env) {
    const body = await encryptPayload(enc.encode(payload), b64urlDecode(sub.keys.p256dh), b64urlDecode(sub.keys.auth));
    const jwt = await vapidJwt(new URL(sub.endpoint).origin, env);
    return fetch(sub.endpoint, {
        method: 'POST',
        headers: {
            'Authorization': `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'TTL': '86400',
            'Urgency': 'high'
        },
        body
    });
}

export async function encryptPayload(plaintext, uaPublic, authSecret, fixed = {}) {
    const asKeys = fixed.asKeys || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
    const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

    const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
    const salt = fixed.salt || crypto.getRandomValues(new Uint8Array(16));
    const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
    const record = concat(plaintext, new Uint8Array([2])); // 0x02 — последняя запись
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, record));

    const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
    header.set(salt, 0);
    new DataView(header.buffer).setUint32(16, 4096);
    header[20] = asPublic.length;
    header.set(asPublic, 21);
    return concat(header, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export async function vapidJwt(audience, env) {
    const pub = b64urlDecode(env.VAPID_PUBLIC_KEY);
    const jwk = {
        kty: 'EC', crv: 'P-256',
        x: b64urlEncode(pub.slice(1, 33)),
        y: b64urlEncode(pub.slice(33, 65)),
        d: env.VAPID_PRIVATE_KEY,
        ext: true
    };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64urlEncode(enc.encode(JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: env.VAPID_SUBJECT || 'mailto:support@harivision.org'
    })));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
    return `${header}.${claims}.${b64urlEncode(signature)}`;
}

// ---------------------------------------------------------------------
// Мелочи
// ---------------------------------------------------------------------
function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
}
function b64urlDecode(s) {
    const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4);
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function b64urlEncode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hostOf(endpoint) {
    try { return new URL(endpoint).host; } catch (e) { return '?'; }
}
function countBy(list) {
    return list.reduce((acc, k) => { acc[k] = (acc[k] || 0) + 1; return acc; }, {});
}
function json(data, headers = {}) {
    return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
