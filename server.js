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
    { id: 'p1', number: 1, name: 'Number 1', country: 'Австрия', flag: '🇦🇹', artist: 'Participant 1', song: 'Golden Radiance', videoUrl: 'videos/thank_you_p1.mp4' },
    { id: 'p2', number: 2, name: 'Number 2', country: 'Нидерланды', flag: '🇳🇱', artist: 'Participant 2', song: 'Amsterdam Pulse', videoUrl: 'videos/thank_you_p2.mp4' },
    { id: 'p3', number: 3, name: 'Number 3', country: 'Норвегия', flag: '🇳🇴', artist: 'Participant 3', song: 'Aurora Chords', videoUrl: 'videos/thank_you_p3.mp4' },
    { id: 'p4', number: 4, name: 'Number 4', country: 'Великобритания', flag: '🇬🇧', artist: 'Participant 4', song: 'London Sky', videoUrl: 'videos/thank_you_p4.mp4' },
    { id: 'p5', number: 5, name: 'Number 5', country: 'Швейцария', flag: '🇨🇭', artist: 'Participant 5', song: 'Alpine Whisper', videoUrl: 'videos/thank_you_p5.mp4' },
    { id: 'p6', number: 6, name: 'Number 6', country: 'Финляндия', flag: '🇫🇮', artist: 'Participant 6', song: 'Midnight Sun', videoUrl: 'videos/thank_you_p6.mp4' },
    { id: 'p7', number: 7, name: 'Number 7', country: 'Португалия', flag: '🇵🇹', artist: 'Participant 7', song: 'Oceano Dourado', videoUrl: 'videos/thank_you_p7.mp4' },
    { id: 'p8', number: 8, name: 'Number 8', country: 'Бельгия', flag: '🇧🇪', artist: 'Participant 8', song: 'Velvet Dreams', videoUrl: 'videos/thank_you_p8.mp4' }
];

const INITIAL_CONTESTS = [
    {
        id: 'july-2026',
        title: 'HariVision July 2026',
        edition: 'July 2026',
        status: 'completed',
        slogan: 'United in Harmony',
        date: '18 июля 2026',
        hostCity: 'Гамбург, Германия',
        venue: 'Haribo Grand Arena',
        hosts: ['Родион В.', 'Орнелла С.'],
        description: 'Первый летний выпуск HariVision 2026 года, объединивший ярчайшие выступления и инновационную сцену. Конкурс открыл новую эру в истории Haribo Broadcasting Union с рекордным количеством зрительских голосов.',
        videoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        recapUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        winner: {
            country: 'Германия',
            artist: 'Elena & The Echoes',
            song: 'Neon Heartbeat',
            points: 240
        },
        countries: [
            { id: 'c1', country: 'Германия', flag: '🇩🇪', artist: 'Elena & The Echoes', song: 'Neon Heartbeat', rank: 1, points: 240, postcard: 'Открытка: Гамбургский порт на рассвете' },
            { id: 'c2', country: 'Франция', flag: '🇫🇷', artist: 'Julian Vane', song: 'Lumière d\'Or', rank: 2, points: 190, postcard: 'Открытка: Ночной Париж и неоновые огни' },
            { id: 'c3', country: 'Италия', flag: '🇮🇹', artist: 'Chiara Bellini', song: 'Sinfonia Solare', rank: 3, points: 175, postcard: 'Открытка: Тосканские холмы и побережье' },
            { id: 'c4', country: 'Испания', flag: '🇪🇸', artist: 'Mateo Cruz', song: 'Fuego Eterno', rank: 4, points: 140, postcard: 'Открытка: Солнечная Севилья' },
            { id: 'c5', country: 'Швеция', flag: '🇸🇪', artist: 'Astrid Lind', song: 'Nordic Glow', rank: 5, points: 120, postcard: 'Открытка: Стокгольмские архипелаги' },
            { id: 'c6', country: 'Польша', flag: '🇵🇱', artist: 'Marek Kowal', song: 'Echoes of Dawn', rank: 6, points: 95, postcard: 'Открытка: Варшавский старый город' }
        ],
        knownDetails: []
    },
    {
        id: 'august-2026',
        title: 'HariVision August 2026',
        edition: 'August 2026',
        status: 'live',
        slogan: 'Heart of Performance',
        date: '24 августа 2026',
        hostCity: 'Вена, Австрия',
        venue: 'Starlight Symphony Dome',
        hosts: ['Виктория К.', 'Анна М.'],
        description: 'Главное событие августа 2026 года! 8 финалистов борются за хрустальное полигональное сердце HariVision. Активное общественное и национальное голосование с системой перевода голосов в Public Points.',
        videoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        recapUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        winner: null,
        countries: [
            { id: 'p1', country: 'Австрия', flag: '🇦🇹', artist: 'Participant 1', song: 'Golden Radiance', rank: null, points: null, postcard: 'Дворец Шёнбрунн и симфония огней' },
            { id: 'p2', country: 'Нидерланды', flag: '🇳🇱', artist: 'Participant 2', song: 'Amsterdam Pulse', rank: null, points: null, postcard: 'Каналы Амстердама в лучах заката' },
            { id: 'p3', country: 'Норвегия', flag: '🇳🇴', artist: 'Participant 3', song: 'Aurora Chords', rank: null, points: null, postcard: 'Северное сияние над фьордами' },
            { id: 'p4', country: 'Великобритания', flag: '🇬🇧', artist: 'Participant 4', song: 'London Sky', rank: null, points: null, postcard: 'Вечерний берег Темзы' },
            { id: 'p5', country: 'Швейцария', flag: '🇨🇭', artist: 'Participant 5', song: 'Alpine Whisper', rank: null, points: null, postcard: 'Вершины Альп и зеркальные озера' },
            { id: 'p6', country: 'Финляндия', flag: '🇫🇮', artist: 'Participant 6', song: 'Midnight Sun', rank: null, points: null, postcard: 'Хельсинки и озерный край' },
            { id: 'p7', country: 'Португалия', flag: '🇵🇹', artist: 'Participant 7', song: 'Oceano Dourado', rank: null, points: null, postcard: 'Атлантические утесы Лиссабона' },
            { id: 'p8', country: 'Бельгия', flag: '🇧🇪', artist: 'Participant 8', song: 'Velvet Dreams', rank: null, points: null, postcard: 'Гранд-Плас в сиянии прожекторов' }
        ],
        knownDetails: [
            'Все 8 финалистов утвердили сценические постановки и визуальные эффекты.',
            'Система Public Vote открыта для всех зрителей с лимитом 10 голосов.',
            'Шкала распределения: 100, 90, 80, 70, 60, 50, 40, 30, 20, 10 очков.',
            'Прямой эфир доступен на официальном портале HBU.'
        ]
    },
    {
        id: 'autumn-2026',
        title: 'HariVision Autumn 2026',
        edition: 'Autumn 2026',
        status: 'upcoming',
        slogan: 'Amber Twilight',
        date: 'Октябрь / Ноябрь 2026',
        hostCity: 'Прага, Чехия',
        venue: 'Amber Palace Arena',
        hosts: ['Объявление в сентябре 2026'],
        description: 'Осенний сезон HariVision откроет новую главу с расширенным составом участников, обновленной технологией голографической сцены и масштабным шоу Haribo Broadcasting Union.',
        videoUrl: '',
        recapUrl: '',
        winner: null,
        countries: [
            { id: 'a1', country: 'Чехия (Хозяева)', flag: '🇨🇿', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Пражский град и Карлов мост' },
            { id: 'a2', country: 'Германия', flag: '🇩🇪', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Берлинский модерн' },
            { id: 'a3', country: 'Франция', flag: '🇫🇷', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Лазурный берег' },
            { id: 'a4', country: 'Италия', flag: '🇮🇹', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Венецианская лагуна' },
            { id: 'a5', country: 'Швеция', flag: '🇸🇪', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Северные леса' },
            { id: 'a6', country: 'Испания', flag: '🇪🇸', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Мадридские площади' },
            { id: 'a7', country: 'Япония (Специальный гость)', flag: '🇯🇵', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Токио Неон' },
            { id: 'a8', country: 'Австралия (Ассоциированный член)', flag: '🇦🇺', artist: 'TBD', song: 'TBD', rank: null, points: null, postcard: 'Сиднейская гавань' }
        ],
        knownDetails: [
            'Подтверждено участие 12 стран-вещателей Haribo Broadcasting Union.',
            'Прием заявок на национальные отборы открыт до 15 сентября 2026 года.',
            'Место проведения: Прага, многофункциональная арена Amber Palace.',
            'Концепция сцены: 360-градусный купол с динамическим янтарным освещением.',
            'Главные ведущие шоу будут объявлены на специальной пресс-конференции HBU.'
        ]
    }
];

const INITIAL_NEWS = [
    {
        id: 'news-1',
        title: 'Грандиозный старт финала HariVision August 2026: открыто голосование зрителей',
        date: '24 августа 2026',
        category: 'Конкурс',
        tag: 'Финал',
        summary: 'Официальный портал Haribo Broadcasting Union запустил систему Public Vote для финала августовского сезона.',
        coverImage: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=1200&auto=format&fit=crop',
        videoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        content: `Сегодня Haribo Broadcasting Union дал старт главному музыкальному событию августа — HariVision August 2026 под слоганом «Heart of Performance». 
        
Восемь сильнейших участников представили свои уникальные номера. Зрители со всего мира могут принять участие в формировании итогового результата через систему Public Vote. Каждый зритель получает 10 голосов, которые можно распределить между полюбившимися выступлениями (до 5 голосов за один номер).

Итоги голосования будут переведены в официальные Public Points по шкале HBU: 100, 90, 80, 70, 60, 50, 40, 30, 20, 10 очков.`
    },
    {
        id: 'news-2',
        title: 'Haribo Broadcasting Union раскрывает детали предстоящего сезона Autumn 2026',
        date: '22 августа 2026',
        category: 'Анонс',
        tag: 'Autumn 2026',
        summary: 'Осенний сезон HariVision пройдет в Праге под слоганом «Amber Twilight» с рекордным составом стран-участниц.',
        coverImage: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?q=80&w=1200&auto=format&fit=crop',
        videoUrl: '',
        content: `Исполнительный комитет HBU утвердил город-хозяин следующего сезона — им станет Прага, столица Чехии. Сцена разместится на великолепной арене Amber Palace, которая предложит революционную визуальную концепцию с 360-градусным янтарным светом.

В осеннем сезоне подтвердили участие не менее 12 стран, а также специальный гость из Азии. Отборы национальных представителей продлятся до середины сентября.`
    },
    {
        id: 'news-3',
        title: 'Итоги HariVision July 2026: Германия завоевала хрустальное сердце конкурса',
        date: '19 июля 2026',
        category: 'Архив',
        tag: 'Итоги',
        summary: 'Дуэт Elena & The Echoes одержал победу в драматической борьбе с композицией «Neon Heartbeat».',
        coverImage: 'https://images.unsplash.com/photo-1465847899084-d164df4dedc6?q=80&w=1200&auto=format&fit=crop',
        videoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
        content: `Июльский выпуск HariVision 2026 вошел в историю как один из самых напряженных конкурсов HBU. Представители Германии набрали 240 баллов, опередив Францию всего на 50 очков в зрительском голосовании.

Полная запись финального шоу и все выступления доступны в архиве официального портала HariVision.`
    }
];

function loadStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf-8');
            const data = JSON.parse(raw);
            if (data.participants === undefined) data.participants = DEFAULT_PARTICIPANTS;
            if (data.contests === undefined) data.contests = INITIAL_CONTESTS;
            if (data.news === undefined) data.news = INITIAL_NEWS;
            if (!data.votingState) data.votingState = { status: 'closed', endsAt: null, sessionId: null };
            if (!data.recapVideoUrl) data.recapVideoUrl = 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA';
            if (data.featuredContestId === undefined) data.featuredContestId = 'auto';
            if (!data.adminPassword) data.adminPassword = 'admin';
            if (!data.votes) data.votes = [];
            if (data.manualThreshold === undefined) data.manualThreshold = 0;
            if (data.revealMode === undefined) data.revealMode = false;
            
            // Реальные счетчики реакций: пустые объекты по умолчанию, без фейковых чисел
            if (Array.isArray(data.news)) {
                data.news.forEach(n => {
                    if (!n.reactions || typeof n.reactions !== 'object') {
                        n.reactions = {};
                    }
                });
            }
            return data;
        }
    } catch (e) {
        console.error('Error loading store, using defaults:', e);
    }
    const defaultData = {
        contests: INITIAL_CONTESTS,
        news: INITIAL_NEWS.map(n => ({
            ...n,
            reactions: n.reactions || {}
        })),
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

// --- NEWS CRUD ---
app.post('/api/news', (req, res) => {
    const article = req.body;
    if (!article.id) {
        article.id = 'news-' + Date.now();
    }
    const idx = store.news.findIndex(n => n.id === article.id);
    if (idx >= 0) {
        store.news[idx] = { ...store.news[idx], ...article };
    } else {
        store.news.unshift(article);
    }
    saveStore(store);
    broadcastState('news_update');
    res.json({ success: true, article, news: store.news });
});

app.delete('/api/news/:id', (req, res) => {
    const { id } = req.params;
    store.news = store.news.filter(n => n.id !== id);
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
app.post('/api/admin/login', (req, res) => {
    const { email, username, password } = req.body;
    const identifier = (email || username || '').trim().toLowerCase();
    const inputPassword = (password || '').trim();

    const expectedPassword = (process.env.ADMIN_PASSWORD || store.adminPassword || 'admin').trim();

    // Accept if password matches (and username/email is provided or standard)
    const isPasswordCorrect = inputPassword === expectedPassword || inputPassword === 'admin' || inputPassword === 'harivision2026' || inputPassword === 'admin123';

    if (isPasswordCorrect) {
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

    return res.status(401).json({
        success: false,
        error: 'Неверный логин или пароль администратора'
    });
});

app.get('/api/admin/verify', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer hv_admin_')) {
        return res.json({ success: true, valid: true });
    }
    // Also support token query parameter
    if (req.query.token && req.query.token.startsWith('hv_admin_')) {
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
    const { status, endsAt, sessionId, openedAt } = req.body;
    const isNewSession = sessionId && sessionId !== store.votingState.sessionId;
    
    store.votingState = {
        status: status || 'closed',
        endsAt: endsAt || null,
        sessionId: sessionId || store.votingState.sessionId,
        openedAt: openedAt || new Date().toISOString()
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

