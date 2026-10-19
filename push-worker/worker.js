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
//   /recap/...    — загрузка видео-повтора из админки в KV и его раздача (см. ниже)
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
            ? {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
                'Access-Control-Expose-Headers': 'ETag, Content-Range, Accept-Ranges, Content-Length',
                'Access-Control-Max-Age': '600',
                'Vary': 'Origin'
            }
            : {};
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

        if (url.pathname.startsWith('/recap/')) {
            return handleRecap(request, env, url, cors).catch(e => json({ error: String(e && e.message || e) }, cors, 500));
        }

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
function json(data, headers = {}, status = 200) {
    return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

// ---------------------------------------------------------------------
// Видео-повтор в Cloudflare KV
// ---------------------------------------------------------------------
// KV есть на бесплатном тарифе без карты: 1 ГБ, 1000 записей и 100 000 чтений в день.
// Файл хранится кусками по 5 МБ (recap:<id>:<n>) плюс описание recap:<id>:meta.
// Админка шлёт куски отдельными запросами, зрителям воркер отдаёт видео с Range,
// по одному куску на ответ (браузер сам дозапрашивает следующий).
//   POST   /recap/upload                          {name, type, size} → {key, chunkSize}
//   PUT    /recap/upload/<key>?part=N              тело — кусок №N (с 0) → {part}
//   POST   /recap/upload/<key>/complete            → {url}
//   DELETE /recap/upload/<key>                     отмена
//   GET    /recap/<key>                            раздача видео зрителям
// Всё, кроме GET, требует ID-токен Firebase админа (Authorization: Bearer ...).
// Namespace подключается в wrangler.toml как RECAPS.

const RECAP_CHUNK = 5 * 1024 * 1024;
const RECAP_MAX_SIZE = 900 * 1024 * 1024; // в бесплатный 1 ГБ должно влезать одно видео
const adminTokenCache = new Map(); // idToken → время, до которого он проверен

async function handleRecap(request, env, url, cors) {
    if (!env.RECAPS) return json({ error: 'Хранилище KV не подключено к воркеру (binding RECAPS)' }, cors, 503);
    const rest = url.pathname.slice('/recap/'.length);

    if (!rest.startsWith('upload')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: cors });
        return serveRecap(request, env, decodeURIComponent(rest), cors);
    }

    if (!await isAdminRequest(request, env)) return json({ error: 'Нужен вход администратора' }, cors, 401);

    if (rest === 'upload' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const size = Number(body.size) || 0;
        if (size <= 0 || size > RECAP_MAX_SIZE) return json({ error: 'Файл должен быть не больше 900 МБ' }, cors, 400);
        const ext = (String(body.name || '').match(/\.([a-z0-9]{2,5})$/i) || [, 'mp4'])[1].toLowerCase();
        const key = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        const type = /^video\/[\w.+-]+$/.test(body.type || '') ? body.type : 'video/mp4';
        await env.RECAPS.put(`upload:${key}`, JSON.stringify({ size, type }), { expirationTtl: 24 * 3600 });
        return json({ key, chunkSize: RECAP_CHUNK }, cors);
    }

    const m = rest.match(/^upload\/([\w.-]+)(\/complete)?$/);
    if (!m) return json({ error: 'Неверный адрес загрузки' }, cors, 400);
    const key = m[1];
    const pending = await env.RECAPS.get(`upload:${key}`, 'json');
    if (!pending) return json({ error: 'Загрузка не найдена или устарела' }, cors, 404);
    const chunks = Math.ceil(pending.size / RECAP_CHUNK);

    if (!m[2] && request.method === 'PUT') {
        const part = Number(url.searchParams.get('part'));
        if (!Number.isInteger(part) || part < 0 || part >= chunks) return json({ error: 'Неверный номер куска' }, cors, 400);
        const data = await request.arrayBuffer();
        const expected = part === chunks - 1 ? pending.size - part * RECAP_CHUNK : RECAP_CHUNK;
        if (data.byteLength !== expected) return json({ error: `Кусок ${part}: ${data.byteLength} байт вместо ${expected}` }, cors, 400);
        await env.RECAPS.put(`recap:${key}:${part}`, data);
        return json({ part }, cors);
    }
    if (m[2] && request.method === 'POST') {
        const stored = await listKeys(env, `recap:${key}:`);
        const missing = [];
        for (let i = 0; i < chunks; i++) if (!stored.includes(`recap:${key}:${i}`)) missing.push(i);
        if (missing.length) return json({ error: 'Не хватает кусков', missing }, cors, 409);
        await env.RECAPS.put(`recap:${key}:meta`, JSON.stringify({ size: pending.size, type: pending.type, chunks, uploadedAt: Date.now() }));
        await env.RECAPS.delete(`upload:${key}`);
        await pruneOldRecaps(env, key).catch(e => console.warn('[recap] prune', e));
        return json({ url: `${url.origin}/recap/${key}` }, cors);
    }
    if (!m[2] && request.method === 'DELETE') {
        await deleteRecap(env, key);
        await env.RECAPS.delete(`upload:${key}`);
        return json({ aborted: true }, cors);
    }
    return new Response('Method not allowed', { status: 405, headers: cors });
}

async function serveRecap(request, env, key, cors) {
    const meta = /^[\w.-]+$/.test(key) ? await env.RECAPS.get(`recap:${key}:meta`, { type: 'json', cacheTtl: 3600 }) : null;
    if (!meta) return new Response('Not found', { status: 404, headers: cors });

    const headers = new Headers(cors);
    headers.set('Content-Type', meta.type);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('ETag', `"${key}"`);
    if (request.method === 'HEAD') {
        headers.set('Content-Length', String(meta.size));
        return new Response(null, { status: 200, headers });
    }

    // Отдаём не больше одного куска за ответ: это разрешено для Range (206 с меньшим
    // диапазоном), а Safari и Chrome сами запрашивают продолжение.
    const range = parseRange(request.headers.get('Range'), meta.size);
    if (range === null) {
        headers.set('Content-Range', `bytes */${meta.size}`);
        return new Response(null, { status: 416, headers });
    }
    const start = range ? range.start : 0;
    const part = Math.floor(start / RECAP_CHUNK);
    const chunk = await env.RECAPS.get(`recap:${key}:${part}`, { type: 'arrayBuffer', cacheTtl: 3600 });
    if (!chunk) return new Response('Not found', { status: 404, headers: cors });

    if (!range) {
        // Запрос без Range (редко, например скачивание): склеиваем куски потоком
        headers.set('Content-Length', String(meta.size));
        let i = 0;
        const stream = new ReadableStream({
            async pull(controller) {
                const buf = i === 0 ? chunk : await env.RECAPS.get(`recap:${key}:${i}`, { type: 'arrayBuffer', cacheTtl: 3600 });
                if (!buf) { controller.error(new Error('missing chunk ' + i)); return; }
                controller.enqueue(new Uint8Array(buf));
                if (++i >= meta.chunks) controller.close();
            }
        });
        return new Response(stream, { status: 200, headers });
    }
    const chunkStart = part * RECAP_CHUNK;
    const end = Math.min(range.end, chunkStart + chunk.byteLength - 1);
    const body = chunk.slice(start - chunkStart, end - chunkStart + 1);
    headers.set('Content-Range', `bytes ${start}-${end}/${meta.size}`);
    headers.set('Content-Length', String(body.byteLength));
    return new Response(body, { status: 206, headers });
}

// undefined — заголовка нет; null — диапазон за пределами файла
function parseRange(header, size) {
    if (!header) return undefined;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (m[1] === '' && m[2] === '')) return undefined;
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (start >= size || start > end) return null;
    return { start, end };
}

async function listKeys(env, prefix) {
    const names = [];
    let cursor;
    do {
        const page = await env.RECAPS.list({ prefix, cursor });
        names.push(...page.keys.map(k => k.name));
        cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return names;
}

async function deleteRecap(env, key) {
    for (const name of await listKeys(env, `recap:${key}:`)) await env.RECAPS.delete(name);
}

// Бесплатный KV — 1 ГБ, поэтому храним только последнее видео
async function pruneOldRecaps(env, keepKey) {
    const ids = new Set((await listKeys(env, 'recap:')).map(n => n.split(':')[1]));
    for (const id of ids) if (id !== keepKey) await deleteRecap(env, id);
}

// Админ = пользователь Firebase с документом admins/{uid} (как в server.js).
// Документ читаем токеном самого пользователя: правила дают читать только свой.
async function isAdminRequest(request, env) {
    const idToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return false;
    const cachedUntil = adminTokenCache.get(idToken);
    if (cachedUntil && cachedUntil > Date.now()) return true;

    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
    });
    const data = await r.json().catch(() => ({}));
    const user = r.ok && Array.isArray(data.users) ? data.users[0] : null;
    if (!user || !user.localId) return false;
    const adminRes = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/admins/${encodeURIComponent(user.localId)}`, {
        headers: { Authorization: 'Bearer ' + idToken }
    });
    if (!adminRes.ok) return false;
    if (adminTokenCache.size > 50) adminTokenCache.clear();
    adminTokenCache.set(idToken, Date.now() + 5 * 60 * 1000);
    return true;
}
