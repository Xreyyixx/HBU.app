// =============================================================
// Перенос паролей артистов из Firestore в Firebase Authentication
// -------------------------------------------------------------
// Раньше пароли артистов лежали в документах Firestore открытым текстом.
// Скрипт для каждого артиста с полем `password`:
//   1) создаёт аккаунт Firebase Auth (email = поле email или <login>@harivision.app);
//   2) записывает email в документ артиста (если его не было);
//   3) УДАЛЯЕТ поле password из документа.
// После этого артист входит на сайте с тем же логином и паролем, что и раньше.
//
// Запуск (Node 18+), из корня проекта:
//   ADMIN_EMAIL=admin@harivision.org ADMIN_PASSWORD=... node tools/migrate-artist-passwords.mjs
// Пробный прогон без изменений:
//   DRY_RUN=1 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tools/migrate-artist-passwords.mjs
//
// Аккаунт ADMIN_EMAIL должен иметь документ admins/{uid} (см. SECURITY_SETUP.md).
// =============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, '..', 'firebase-applet-config.json');
const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
const API_KEY = process.env.FIREBASE_API_KEY || cfg.apiKey;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || cfg.projectId;
const DRY_RUN = process.env.DRY_RUN === '1';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

if (!API_KEY || !PROJECT_ID || !process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.error('Нужны переменные ADMIN_EMAIL и ADMIN_PASSWORD (и firebase-applet-config.json рядом с проектом).');
    process.exit(1);
}

async function signIn(email, password) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    const d = await r.json();
    if (!r.ok) throw new Error('Вход админа не удался: ' + (d.error?.message || r.status));
    return d.idToken;
}

async function createAuthUser(email, password) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: false })
    });
    const d = await r.json();
    if (r.ok) return 'created';
    const msg = d.error?.message || String(r.status);
    if (msg.startsWith('EMAIL_EXISTS')) return 'exists';
    throw new Error(msg);
}

const token = await signIn(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

function str(field) {
    return field && typeof field.stringValue === 'string' ? field.stringValue : '';
}

function artistEmail(fields, fallbackId) {
    const email = str(fields.email).trim();
    if (email.includes('@')) return email.toLowerCase();
    const login = (str(fields.login) || str(fields.username) || str(fields.artistLogin) || fallbackId).trim().toLowerCase();
    return `${login}@harivision.app`;
}

async function migrateAccount(label, fields, fallbackId) {
    const password = str(fields.password);
    const email = artistEmail(fields, fallbackId);
    if (password.length < 6) {
        console.warn(`  ⚠ ${label}: пароль короче 6 символов — Firebase такой не принимает. Задайте артисту новый пароль вручную (email ${email}).`);
        return { email, ok: false };
    }
    if (DRY_RUN) {
        console.log(`  [dry-run] ${label}: будет создан аккаунт ${email}`);
        return { email, ok: true };
    }
    const result = await createAuthUser(email, password);
    if (result === 'exists') {
        console.warn(`  ⚠ ${label}: аккаунт ${email} уже существует — пароль в нём мог отличаться от старого.`);
    } else {
        console.log(`  ✓ ${label}: создан аккаунт ${email}`);
    }
    return { email, ok: true };
}

// 1. Коллекция artists
let pageToken = '';
let total = 0;
do {
    const r = await fetch(`${BASE}/artists?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`, { headers: authHeaders });
    const d = await r.json();
    if (!r.ok) throw new Error('Чтение artists: ' + (d.error?.message || r.status));
    for (const docItem of d.documents || []) {
        const id = docItem.name.split('/').pop();
        const fields = docItem.fields || {};
        if (!fields.password) continue;
        total++;
        const { email, ok } = await migrateAccount(`artists/${id}`, fields, id);
        if (!ok || DRY_RUN) continue;
        // Записываем email (если не было) и удаляем password
        const mask = ['password'];
        const body = { fields: {} };
        if (!str(fields.email)) {
            mask.push('email');
            body.fields.email = { stringValue: email };
        }
        const qs = mask.map(f => 'updateMask.fieldPaths=' + f).join('&');
        const u = await fetch(`${BASE}/artists/${encodeURIComponent(id)}?${qs}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify(body) });
        if (!u.ok) console.warn(`  ⚠ artists/${id}: не удалось обновить документ (${u.status})`);
    }
    pageToken = d.nextPageToken || '';
} while (pageToken);

// 2. Документ system/artists (список артистов внутри одного документа)
{
    const r = await fetch(`${BASE}/system/artists`, { headers: authHeaders });
    if (r.ok) {
        const d = await r.json();
        const fields = d.fields || {};
        for (const key of ['list', 'artists']) {
            const values = fields[key]?.arrayValue?.values;
            if (!Array.isArray(values)) continue;
            let changed = false;
            for (let i = 0; i < values.length; i++) {
                const itemFields = values[i]?.mapValue?.fields;
                if (!itemFields || !itemFields.password) continue;
                total++;
                const fallback = str(itemFields.id) || str(itemFields.login) || `artist_${i}`;
                const { email, ok } = await migrateAccount(`system/artists.${key}[${i}]`, itemFields, fallback);
                if (!ok || DRY_RUN) continue;
                delete itemFields.password;
                if (!str(itemFields.email)) itemFields.email = { stringValue: email };
                changed = true;
            }
            if (changed) {
                const u = await fetch(`${BASE}/system/artists?updateMask.fieldPaths=${key}`, {
                    method: 'PATCH', headers: authHeaders,
                    body: JSON.stringify({ fields: { [key]: fields[key] } })
                });
                if (!u.ok) console.warn(`  ⚠ system/artists: не удалось обновить поле ${key} (${u.status})`);
            }
        }
    }
}

console.log(total === 0
    ? 'Документов с паролями не найдено — переносить нечего.'
    : `Готово. Обработано записей с паролями: ${total}${DRY_RUN ? ' (пробный прогон, ничего не изменено)' : ''}.`);
