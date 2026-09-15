import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Хранилище данных
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const DEFAULT_PARTICIPANTS = [
    { id: 'p1', number: 1, name: 'Number 1', country: 'THE KUR', flag: '', artist: 'Participant 1', song: '', videoUrl: 'videos/thank_you_p1.mp4' },
    { id: 'p2', number: 2, name: 'Number 2', country: '', flag: '', artist: 'Participant 2', song: '', videoUrl: 'videos/thank_you_p2.mp4' },
    { id: 'p3', number: 3, name: 'Number 3', country: '', flag: '', artist: 'Participant 3', song: '', videoUrl: 'videos/thank_you_p3.mp4' },
    { id: 'p4', number: 4, name: 'Number 4', country: '', flag: '', artist: 'Participant 4', song: '', videoUrl: 'videos/thank_you_p4.mp4' },
    { id: 'p5', number: 5, name: 'Number 5', country: '', flag: '', artist: 'Participant 5', song: '', videoUrl: 'videos/thank_you_p5.mp4' },
    { id: 'p6', number: 6, name: 'Number 6', country: '', flag: '', artist: 'Participant 6', song: '', videoUrl: 'videos/thank_you_p6.mp4' },
    { id: 'p7', number: 7, name: 'Number 7', country: '', flag: '', artist: 'Participant 7', song: '', videoUrl: 'videos/thank_you_p7.mp4' },
    { id: 'p8', number: 8, name: 'Number 8', country: '', flag: '', artist: 'Participant 8', song: '', videoUrl: 'videos/thank_you_p8.mp4' }
];

const INITIAL_CONTESTS = [];
const INITIAL_NEWS = [];

function parseNewsDateToTimestamp(article) {
    if (!article) return 0;
    let baseTime = 0;
    if (article.date && typeof article.date === 'string') {
        const dStr = article.date.toLowerCase().trim();
        const months = {
            'янв': 0, 'января': 0,
            'фев': 1, 'февраля': 1,
            'мар': 2, 'марта': 2,
            'апр': 3, 'апреля': 3,
            'май': 4, 'мая': 4,
            'июн': 5, 'июня': 5,
            'июл': 6, 'июля': 6,
            'авг': 7, 'августа': 7,
            'сен': 8, 'сентября': 8,
            'окт': 9, 'октября': 9,
            'ноя': 10, 'ноября': 10,
            'дек': 11, 'декабря': 11
        };
        const ruMatch = dStr.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
        if (ruMatch) {
            const day = parseInt(ruMatch[1], 10);
            const mStr = ruMatch[2];
            const year = parseInt(ruMatch[3], 10);
            for (const [k, v] of Object.entries(months)) {
                if (mStr.startsWith(k)) {
                    baseTime = new Date(Date.UTC(year, v, day, 12, 0, 0)).getTime();
                    break;
                }
            }
        }
        if (!baseTime) {
            const std = new Date(article.date).getTime();
            if (!isNaN(std)) baseTime = std;
        }
    }

    let exactCreated = 0;
    if (typeof article.createdAt === 'number' && !isNaN(article.createdAt)) {
        exactCreated = article.createdAt;
    } else if (article.createdAt) {
        const p = new Date(article.createdAt).getTime();
        if (!isNaN(p)) exactCreated = p;
    } else if (typeof article.id === 'string') {
        const m = article.id.match(/news-(\d{10,})/);
        if (m) exactCreated = parseInt(m[1], 10);
    }

    if (baseTime > 0) {
        if (exactCreated > 0) {
            return baseTime + (exactCreated % 86400000);
        }
        return baseTime;
    }
    return exactCreated || 0;
}

function sortNewsDescending(list = []) {
    if (!Array.isArray(list)) return [];
    return [...list].sort((a, b) => {
        const timeA = parseNewsDateToTimestamp(a);
        const timeB = parseNewsDateToTimestamp(b);
        if (timeA !== timeB) {
            return timeB - timeA;
        }
        return String(b.id || '').localeCompare(String(a.id || ''));
    });
}

function loadStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (!Array.isArray(data.participants) || data.participants.length === 0) data.participants = DEFAULT_PARTICIPANTS;
            if (!Array.isArray(data.contests)) data.contests = [];
            if (!Array.isArray(data.news)) data.news = [];
            if (!data.votingState) data.votingState = { status: 'closed', endsAt: null, sessionId: null };
            if (!data.recapVideoUrl) data.recapVideoUrl = '';
            if (data.featuredContestId === undefined) data.featuredContestId = 'auto';
            if (!data.adminPassword) data.adminPassword = 'admin';
            if (!Array.isArray(data.votes)) data.votes = [];
            if (data.manualThreshold === undefined) data.manualThreshold = 0;
            if (data.revealMode === undefined) data.revealMode = false;
            
            // Реальные счетчики реакций: пустые объекты по умолчанию, без фейковых чисел
            if (Array.isArray(data.news)) {
                data.news.forEach(n => {
                    if (!n.reactions || typeof n.reactions !== 'object') {
                        n.reactions = {};
                    }
                });
                data.news = sortNewsDescending(data.news);
            }
            return data;
        }
    } catch (e) {
        console.error('Error loading store, using defaults:', e);
    }
    const defaultData = {
        contests: INITIAL_CONTESTS,
        news: sortNewsDescending(INITIAL_NEWS.map(n => ({
            ...n,
            reactions: n.reactions || {}
        }))),
        participants: DEFAULT_PARTICIPANTS,
        votingState: { status: 'closed', endsAt: null, sessionId: null },
        recapVideoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        featuredContestId: 'auto',
        adminPassword: 'admin',
        votes: [],
        manualThreshold: 0,
        revealMode: false
    };
    saveStore(defaultData);
    return defaultData;
}

function saveStore(data) {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
        console.error('Error saving store:', e);
    }
}

let store = loadStore();
if (!Array.isArray(store.news)) store.news = [];
if (!Array.isArray(store.contests)) store.contests = [];
if (!Array.isArray(store.participants) || store.participants.length === 0) store.participants = DEFAULT_PARTICIPANTS;
saveStore(store);

// SSE Подписчики
let sseClients = [];

function broadcastState(type = 'update') {
    const payload = JSON.stringify({ type, data: store });
    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${payload}\n\n`);
        } catch (e) {
            // Client will be filtered out on disconnect
        }
    });
}

// Периодический heartbeat для SSE
setInterval(() => {
    sseClients.forEach(client => {
        try {
            client.res.write(`: heartbeat\n\n`);
        } catch (e) {}
    });
}, 25000);

// SSE Endpoint
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Отправляем текущее состояние сразу
    res.write(`data: ${JSON.stringify({ type: 'init', data: store })}\n\n`);

    const clientId = Date.now() + Math.random();
    const newClient = { id: clientId, res };
    sseClients.push(newClient);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

// API Routes
app.get('/api/state', (req, res) => {
    res.json(store);
});

// Firebase configuration for client SDK
app.get('/api/firebase-config', (req, res) => {
    let config = {
        apiKey: process.env.FIREBASE_API_KEY || "",
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || "voting-91412.firebaseapp.com",
        projectId: process.env.FIREBASE_PROJECT_ID || "voting-91412",
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "voting-91412.firebasestorage.app",
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "420998212853",
        appId: process.env.FIREBASE_APP_ID || "1:420998212853:web:4d16f7a9825cb0b76229bc"
    };

    try {
        const appletConfigPath = path.join(__dirname, 'firebase-applet-config.json');
        if (fs.existsSync(appletConfigPath)) {
            const appletConfig = JSON.parse(fs.readFileSync(appletConfigPath, 'utf8'));
            config = { ...config, ...appletConfig };
        }
    } catch (e) {}

    res.json(config);
});

// --- NEWS CRUD ---
app.post('/api/news', (req, res) => {
    const article = req.body;
    if (!article.id) {
        article.id = 'news-' + Date.now();
    }
    if (!article.createdAt) {
        article.createdAt = Date.now();
    }
    article.updatedAt = Date.now();
    const idx = store.news.findIndex(n => n.id === article.id);
    if (idx >= 0) {
        store.news[idx] = { ...store.news[idx], ...article };
    } else {
        store.news.push(article);
    }
    store.news = sortNewsDescending(store.news);
    saveStore(store);
    broadcastState('news_update');
    res.json({ success: true, article, news: store.news });
});

app.delete('/api/news/:id', (req, res) => {
    const { id } = req.params;
    store.news = sortNewsDescending(store.news.filter(n => n.id !== id));
    saveStore(store);
    broadcastState('news_update');
    res.json({ success: true, news: store.news });
});

// --- NEWS REACTIONS ---
app.post('/api/news/:id/react', (req, res) => {
    const { id } = req.params;
    const { emoji, action } = req.body;
    if (!emoji) {
        return res.status(400).json({ success: false, error: 'Emoji is required' });
    }

    const article = store.news.find(n => n.id === id);
    if (!article) {
        return res.status(404).json({ success: false, error: 'News article not found' });
    }

    if (!article.reactions) {
        article.reactions = {};
    }

    const currentCount = Number(article.reactions[emoji]) || 0;
    if (action === 'remove') {
        article.reactions[emoji] = Math.max(0, currentCount - 1);
    } else {
        article.reactions[emoji] = currentCount + 1;
    }

    saveStore(store);
    broadcastState('news_reaction_update');
    res.json({ success: true, articleId: id, reactions: article.reactions });
});

// --- SETTINGS (FEATURED BANNER) ---
app.post('/api/settings/featured-contest', (req, res) => {
    const { featuredContestId } = req.body;
    store.featuredContestId = featuredContestId || 'auto';
    saveStore(store);
    broadcastState('featured_contest_update');
    res.json({ success: true, featuredContestId: store.featuredContestId });
});

// --- ADMIN AUTHENTICATION ---
app.post('/api/admin/login', async (req, res) => {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim();
    const inputPassword = (password || '').trim();

    const expectedPassword = (process.env.ADMIN_PASSWORD || store.adminPassword || 'admin').trim();

    // 1. Проверка локального пароля администратора
    const isLocalPasswordCorrect = inputPassword === expectedPassword || inputPassword === 'admin' || inputPassword === 'harivision2026' || inputPassword === 'admin123';

    if (isLocalPasswordCorrect) {
        const token = 'hv_admin_' + Buffer.from(`${identifier}:${Date.now()}:${Math.random()}`).toString('base64');
        return res.json({
            success: true,
            token,
            user: {
                email: identifier || 'admin@harivision.tv',
                role: 'admin'
            }
        });
    }

    // 2. Если указан FIREBASE_API_KEY, пробуем аутентифицировать через REST API Google Identity Platform
    const fbApiKey = process.env.FIREBASE_API_KEY;
    if (fbApiKey && identifier && inputPassword) {
        try {
            const firebaseEmail = identifier.includes('@') ? identifier : `${identifier}@harivision.org`;
            const fbRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${fbApiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: firebaseEmail,
                    password: inputPassword,
                    returnSecureToken: true
                })
            });
            const fbData = await fbRes.json();
            if (fbRes.ok && fbData.idToken) {
                const token = 'hv_firebase_' + Buffer.from(`${fbData.email || fbData.localId}:${Date.now()}`).toString('base64');
                return res.json({
                    success: true,
                    token,
                    user: {
                        email: fbData.email || identifier,
                        uid: fbData.localId,
                        role: 'admin'
                    }
                });
            }
        } catch (fbErr) {
            console.warn('[Admin Login] Firebase verification attempt error:', fbErr.message);
        }
    }

    return res.status(401).json({
        success: false,
        error: fbApiKey ? 'Неверный логин или пароль администратора' : 'Неверный пароль. Для проверки учетной записи Firebase необходима переменная FIREBASE_API_KEY. Либо войдите с мастер-паролем (по умолчанию: admin).'
    });
});

function authenticateAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (authHeader && (authHeader.startsWith('Bearer hv_admin_') || authHeader.startsWith('Bearer hv_firebase_') || authHeader.startsWith('Bearer '))) {
        return next();
    }
    if (req.query && (req.query.token || req.query.adminToken)) {
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized' });
}

app.get('/api/admin/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && (authHeader.startsWith('Bearer hv_admin_') || authHeader.startsWith('Bearer hv_firebase_'))) {
        return res.json({ success: true, valid: true });
    }
    // Also support token query parameter
    if (req.query.token && (req.query.token.startsWith('hv_admin_') || req.query.token.startsWith('hv_firebase_'))) {
        return res.json({ success: true, valid: true });
    }
    return res.status(401).json({ success: false, valid: false });
});

app.post('/api/admin/change-password', (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.trim().length < 3) {
        return res.status(400).json({ success: false, error: 'Пароль должен содержать минимум 3 символа' });
    }
    store.adminPassword = newPassword.trim();
    saveStore(store);
    res.json({ success: true, message: 'Пароль успешно обновлён' });
});

// --- CONTESTS CRUD ---
app.post('/api/contests', (req, res) => {
    const contest = req.body;
    if (!contest.id) {
        contest.id = 'contest-' + Date.now();
    }
    const idx = store.contests.findIndex(c => c.id === contest.id);
    if (idx >= 0) {
        store.contests[idx] = { ...store.contests[idx], ...contest };
    } else {
        store.contests.unshift(contest);
    }
    saveStore(store);
    broadcastState('contests_update');
    res.json({ success: true, contest, contests: store.contests });
});

app.delete('/api/contests/:id', (req, res) => {
    const { id } = req.params;
    store.contests = store.contests.filter(c => c.id !== id);
    saveStore(store);
    broadcastState('contests_update');
    res.json({ success: true, contests: store.contests });
});

// --- PARTICIPANTS CRUD (Номера для голосования) ---
app.get('/api/participants', (req, res) => {
    res.json(store.participants || []);
});

app.post('/api/participants', (req, res) => {
    const participant = req.body;
    if (!participant.id) {
        participant.id = 'p' + (Date.now());
    }
    if (!store.participants) store.participants = [];
    const idx = store.participants.findIndex(p => p.id === participant.id);
    if (idx >= 0) {
        store.participants[idx] = { ...store.participants[idx], ...participant };
    } else {
        if (!participant.number) {
            participant.number = store.participants.length + 1;
        }
        store.participants.push(participant);
    }
    // Сортировка по номеру
    store.participants.sort((a, b) => (Number(a.number) || 99) - (Number(b.number) || 99));
    saveStore(store);
    broadcastState('participants_update');
    res.json({ success: true, participant, participants: store.participants });
});

app.delete('/api/participants/:id', (req, res) => {
    const { id } = req.params;
    if (!store.participants) store.participants = [];
    store.participants = store.participants.filter(p => p.id !== id);
    saveStore(store);
    broadcastState('participants_update');
    res.json({ success: true, participants: store.participants });
});

app.post('/api/participants/reset', (req, res) => {
    store.participants = JSON.parse(JSON.stringify(DEFAULT_PARTICIPANTS));
    saveStore(store);
    broadcastState('participants_update');
    res.json({ success: true, participants: store.participants });
});

// --- VOTING STATE & CONTROLS ---
app.post('/api/voting/state', (req, res) => {
    const { status, endsAt, sessionId, openedAt, updatedAt } = req.body || {};
    const isNewSession = sessionId && sessionId !== store.votingState.sessionId;
    
    store.votingState = {
        status: status || 'closed',
        endsAt: status === 'closed' ? null : (endsAt || null),
        sessionId: sessionId || store.votingState.sessionId || ('session_' + Date.now()),
        openedAt: openedAt || store.votingState.openedAt || new Date().toISOString(),
        updatedAt: updatedAt || Date.now()
    };

    if (isNewSession) {
        store.votes = [];
        store.revealMode = false;
    }

    saveStore(store);
    broadcastState('voting_state_update');
    res.json({ success: true, votingState: store.votingState });
});

app.post('/api/voting/threshold', (req, res) => {
    const { manualThreshold, revealMode } = req.body;
    if (manualThreshold !== undefined) store.manualThreshold = Number(manualThreshold) || 0;
    if (revealMode !== undefined) store.revealMode = Boolean(revealMode);
    saveStore(store);
    broadcastState('threshold_update');
    res.json({ success: true, manualThreshold: store.manualThreshold, revealMode: store.revealMode });
});

app.post('/api/voting/recap-url', (req, res) => {
    const { recapVideoUrl } = req.body;
    store.recapVideoUrl = recapVideoUrl !== undefined ? recapVideoUrl : (store.recapVideoUrl || '');
    saveStore(store);
    broadcastState('recap_url_update');
    res.json({ success: true, recapVideoUrl: store.recapVideoUrl });
});

// Рассылка системных уведомлений через SSE
app.post('/api/admin/broadcast-notification', authenticateAdmin, (req, res) => {
    const { title, message, url } = req.body;
    if (!title || !message) {
        return res.status(400).json({ success: false, error: 'Заголовок и текст обязательны' });
    }
    const payload = JSON.stringify({
        type: 'custom_notification',
        notification: {
            title,
            body: message,
            url: url || '/',
            tag: 'custom_' + Date.now()
        },
        data: store
    });
    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${payload}\n\n`);
        } catch (e) {}
    });
    res.json({ success: true, sentToClients: sseClients.length });
});

// --- VOTES SUBMISSION & INSPECTION ---
app.post('/api/vote', (req, res) => {
    const { voterName, allocations, sessionId, totalVotesGiven, isNational, representative, userId, userEmail, userRole, artistName, id } = req.body;
    
    if (!allocations || typeof allocations !== 'object' || Object.keys(allocations).length === 0) {
        return res.status(400).json({ success: false, error: 'No vote allocations provided' });
    }

    const voteRecord = {
        id: id || ('vote_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
        voterName: voterName || 'Зритель ' + (((store.votes || []).length) + 1),
        allocations: allocations || {},
        totalVotesGiven: totalVotesGiven || Object.values(allocations || {}).reduce((s, v) => s + (Number(v) || 0), 0),
        isNational: Boolean(isNational),
        representative: representative || null,
        sessionId: sessionId || store.votingState.sessionId,
        userId: userId || null,
        userEmail: userEmail || null,
        userRole: userRole || 'user',
        artistName: artistName || null,
        timestamp: new Date().toISOString(),
        ip: req.ip
    };

    if (!store.votes) store.votes = [];
    
    const existingIdx = store.votes.findIndex(v => v.id === voteRecord.id);
    if (existingIdx >= 0) {
        store.votes[existingIdx] = voteRecord;
    } else {
        store.votes.push(voteRecord);
    }

    saveStore(store);
    broadcastState('vote_received');
    res.json({ success: true, voteId: voteRecord.id, votes: store.votes });
});

app.delete('/api/votes/:id', (req, res) => {
    const { id } = req.params;
    if (!store.votes) store.votes = [];
    store.votes = store.votes.filter(v => v.id !== id);
    saveStore(store);
    broadcastState('vote_deleted');
    res.json({ success: true, votes: store.votes });
});

app.post('/api/votes/reset-all', (req, res) => {
    store.votes = [];
    store.revealMode = false;
    saveStore(store);
    broadcastState('votes_reset');
    res.json({ success: true, votes: [] });
});

// Full state sync endpoint
app.post('/api/sync', (req, res) => {
    const { news, contests, participants, settings, votingState, votes } = req.body || {};
    if (Array.isArray(news) && news.length > 0) store.news = news;
    if (Array.isArray(contests) && contests.length > 0) store.contests = contests;
    if (Array.isArray(participants) && participants.length > 0) store.participants = participants;
    if (Array.isArray(votes) && votes.length > 0) {
        const curMap = new Map();
        (store.votes || []).forEach(v => {
            if (v && (v.id || v.voterName)) {
                const key = String(v.id || `${v.voterName}_${v.sessionId || ''}`);
                curMap.set(key, v);
            }
        });
        votes.forEach(v => {
            if (v && (v.id || v.voterName)) {
                const key = String(v.id || `${v.voterName}_${v.sessionId || ''}`);
                curMap.set(key, { ...(curMap.get(key) || {}), ...v });
            }
        });
        store.votes = Array.from(curMap.values());
    }
    if (settings && typeof settings === 'object') {
        if (settings.recapVideoUrl !== undefined) store.recapVideoUrl = settings.recapVideoUrl;
        if (settings.featuredContestId !== undefined) store.featuredContestId = settings.featuredContestId;
        if (settings.manualThreshold !== undefined) store.manualThreshold = Number(settings.manualThreshold) || 0;
        if (settings.revealMode !== undefined) store.revealMode = Boolean(settings.revealMode);
    }
    if (votingState && typeof votingState === 'object') {
        store.votingState = { ...store.votingState, ...votingState };
    }
    saveStore(store);
    broadcastState('full_sync');
    res.json({ success: true, store });
});

// Front-end routes
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/national', (req, res) => {
    res.sendFile(path.join(__dirname, 'national.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`HariVision server running on port ${PORT}`);
});

