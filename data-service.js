import { db, auth, INITIAL_CONTESTS, INITIAL_NEWS, DEFAULT_PARTICIPANTS } from './config.js';
import { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged, 
    signInAnonymously 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Локальное кэширование
const LOCAL_STORAGE_STATE_KEY = 'harivision_cached_state';
const LOCAL_STORAGE_USER_KEY = 'harivision_auth_user';

let currentAuthUser = null;
try {
    const cachedUser = localStorage.getItem(LOCAL_STORAGE_USER_KEY);
    if (cachedUser) {
        currentAuthUser = JSON.parse(cachedUser);
    }
} catch (e) {
    console.warn('User cache read error:', e);
}

let currentState = {
    contests: INITIAL_CONTESTS,
    news: INITIAL_NEWS,
    participants: DEFAULT_PARTICIPANTS,
    votingState: { status: 'closed', endsAt: null, sessionId: null },
    recapVideoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
    featuredContestId: 'auto',
    votes: [],
    manualThreshold: 0,
    revealMode: false
};

let lastNotifiedStateJson = '';
let isFirestoreInitialized = false;

// Загрузка локального кэша
try {
    const cached = localStorage.getItem(LOCAL_STORAGE_STATE_KEY);
    if (cached) {
        currentState = { ...currentState, ...JSON.parse(cached) };
    }
} catch (e) {
    console.warn('LocalStorage error:', e);
}

function saveLocalCache() {
    try {
        localStorage.setItem(LOCAL_STORAGE_STATE_KEY, JSON.stringify(currentState));
    } catch (e) {
        console.warn('LocalStorage save error:', e);
    }
}

// Список подписчиков
const stateListeners = new Set();

export function subscribeState(callback) {
    stateListeners.add(callback);
    // Initial call
    try {
        callback(currentState);
    } catch (e) {
        console.error('Initial subscriber error:', e);
    }

    return () => {
        stateListeners.delete(callback);
    };
}

function notifyStateChanged(force = false) {
    const serialized = JSON.stringify({
        contests: currentState.contests,
        news: currentState.news,
        participants: currentState.participants,
        votingState: currentState.votingState,
        recapVideoUrl: currentState.recapVideoUrl,
        featuredContestId: currentState.featuredContestId,
        votesCount: (currentState.votes || []).length,
        manualThreshold: currentState.manualThreshold,
        revealMode: currentState.revealMode,
        votes: currentState.votes
    });

    if (!force && serialized === lastNotifiedStateJson) {
        return false;
    }

    lastNotifiedStateJson = serialized;
    saveLocalCache();

    stateListeners.forEach(cb => {
        try {
            cb(currentState);
        } catch (e) {
            console.error('Listener callback error:', e);
        }
    });
    return true;
}

// -------------------------------------------------------------
// REAL-TIME SYNC (FIRESTORE CLOUD REALTIME + REST/SSE FALLBACK)
// -------------------------------------------------------------
let sseSource = null;

let isDirectSyncRunning = false;

export async function fetchFirestoreStateDirectly() {
    if (!db || isDirectSyncRunning) return;
    isDirectSyncRunning = true;
    try {
        let stateChanged = false;

        // 1. Settings (Banner, recap URL, threshold, reveal)
        try {
            const settingsSnap = await getDoc(doc(db, "system", "settings"));
            if (settingsSnap.exists()) {
                const data = settingsSnap.data();
                if (data.recapVideoUrl !== undefined && currentState.recapVideoUrl !== data.recapVideoUrl) {
                    currentState.recapVideoUrl = data.recapVideoUrl;
                    stateChanged = true;
                }
                if (data.featuredContestId !== undefined && currentState.featuredContestId !== data.featuredContestId) {
                    currentState.featuredContestId = data.featuredContestId;
                    stateChanged = true;
                }
                if (data.manualThreshold !== undefined && currentState.manualThreshold !== data.manualThreshold) {
                    currentState.manualThreshold = data.manualThreshold;
                    stateChanged = true;
                }
                if (data.revealMode !== undefined && currentState.revealMode !== data.revealMode) {
                    currentState.revealMode = data.revealMode;
                    stateChanged = true;
                }
            }
        } catch (e) {}

        // 2. Voting State
        try {
            const votingSnap = await getDoc(doc(db, "system", "voting_state"));
            if (votingSnap.exists()) {
                const fsState = votingSnap.data();
                const endsAtVal = fsState.endsAt ? (fsState.endsAt.toDate ? fsState.endsAt.toDate().toISOString() : fsState.endsAt) : null;
                if (
                    currentState.votingState.status !== fsState.status ||
                    currentState.votingState.endsAt !== endsAtVal ||
                    currentState.votingState.sessionId !== fsState.sessionId
                ) {
                    currentState.votingState = {
                        ...currentState.votingState,
                        status: fsState.status || currentState.votingState.status,
                        endsAt: endsAtVal,
                        sessionId: fsState.sessionId || currentState.votingState.sessionId
                    };
                    stateChanged = true;
                }
            }
        } catch (e) {}

        // 3. Participants
        try {
            const partSnap = await getDoc(doc(db, "system", "participants"));
            if (partSnap.exists()) {
                const pData = partSnap.data();
                if (pData && Array.isArray(pData.list) && pData.list.length > 0) {
                    if (JSON.stringify(currentState.participants) !== JSON.stringify(pData.list)) {
                        currentState.participants = pData.list;
                        stateChanged = true;
                    }
                }
            }
        } catch (e) {}

        // 4. News Collection
        try {
            const newsSnap = await getDocs(collection(db, "news"));
            const newsItems = [];
            newsSnap.forEach(d => {
                newsItems.push({ id: d.id, ...d.data() });
            });
            if (newsItems.length > 0 || newsSnap.size === 0) {
                if (JSON.stringify(currentState.news) !== JSON.stringify(newsItems)) {
                    currentState.news = newsItems;
                    stateChanged = true;
                }
            }
        } catch (e) {}

        // 5. Contests Collection
        try {
            const contestSnap = await getDocs(collection(db, "contests"));
            const contestItems = [];
            contestSnap.forEach(d => {
                contestItems.push({ id: d.id, ...d.data() });
            });
            if (contestItems.length > 0 || contestSnap.size === 0) {
                if (JSON.stringify(currentState.contests) !== JSON.stringify(contestItems)) {
                    currentState.contests = contestItems;
                    stateChanged = true;
                }
            }
        } catch (e) {}

        // 6. Votes Collection
        try {
            const votesSnap = await getDocs(collection(db, "votes"));
            const votesList = [];
            votesSnap.forEach(d => {
                votesList.push({ id: d.id, ...d.data() });
            });
            if (JSON.stringify(currentState.votes) !== JSON.stringify(votesList)) {
                currentState.votes = votesList;
                stateChanged = true;
            }
        } catch (e) {}

        if (stateChanged) {
            notifyStateChanged(false);
        }
    } catch (err) {
        console.warn('Direct Firestore fetch error:', err);
    } finally {
        isDirectSyncRunning = false;
    }
}

function initRealtimeSync() {
    // 1. Initial REST Fetch
    fetchState(true);

    // 2. Immediate Direct Firestore pull
    fetchFirestoreStateDirectly();

    // 3. Server-Sent Events for local development
    if (typeof EventSource !== 'undefined') {
        try {
            sseSource = new EventSource('/api/events');
            sseSource.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed && parsed.data) {
                        currentState = { ...currentState, ...parsed.data };
                        notifyStateChanged(false);
                    }
                } catch (err) {}
            };
        } catch (e) {}
    }

    // 4. Instant refresh on PWA focus / resume / visibility change (when returning to app)
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                fetchFirestoreStateDirectly();
                fetchState(false);
            }
        });
        window.addEventListener('focus', () => {
            fetchFirestoreStateDirectly();
            fetchState(false);
        });
        window.addEventListener('online', () => {
            fetchFirestoreStateDirectly();
        });
    }

    // 5. Firestore Real-time Snapshot Listeners (push updates automatically without polling)
    initFirestoreListeners();
}

function initFirestoreListeners() {
    if (!db) return;

    // A. Voting State Listener
    try {
        onSnapshot(doc(db, "system", "voting_state"), (snap) => {
            if (snap.exists()) {
                const fsState = snap.data();
                if (fsState) {
                    const endsAtVal = fsState.endsAt ? (fsState.endsAt.toDate ? fsState.endsAt.toDate().toISOString() : fsState.endsAt) : null;
                    currentState.votingState = {
                        ...currentState.votingState,
                        status: fsState.status || currentState.votingState.status,
                        endsAt: endsAtVal,
                        sessionId: fsState.sessionId || currentState.votingState.sessionId
                    };
                    notifyStateChanged(false);
                }
            }
        }, (err) => console.warn('Firestore voting_state error:', err));
    } catch (e) {}

    // B. System Settings Listener (recapVideoUrl, featuredContestId, manualThreshold, revealMode)
    try {
        onSnapshot(doc(db, "system", "settings"), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                if (data) {
                    let changed = false;
                    if (data.recapVideoUrl !== undefined && currentState.recapVideoUrl !== data.recapVideoUrl) {
                        currentState.recapVideoUrl = data.recapVideoUrl;
                        changed = true;
                    }
                    if (data.featuredContestId !== undefined && currentState.featuredContestId !== data.featuredContestId) {
                        currentState.featuredContestId = data.featuredContestId;
                        changed = true;
                    }
                    if (data.manualThreshold !== undefined && currentState.manualThreshold !== data.manualThreshold) {
                        currentState.manualThreshold = data.manualThreshold;
                        changed = true;
                    }
                    if (data.revealMode !== undefined && currentState.revealMode !== data.revealMode) {
                        currentState.revealMode = data.revealMode;
                        changed = true;
                    }
                    if (changed) notifyStateChanged(false);
                }
            }
        }, (err) => console.warn('Firestore settings error:', err));
    } catch (e) {}

    // C. Participants Listener
    try {
        onSnapshot(doc(db, "system", "participants"), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                if (data && Array.isArray(data.list) && data.list.length > 0) {
                    currentState.participants = data.list;
                    notifyStateChanged(false);
                }
            }
        }, (err) => console.warn('Firestore participants error:', err));
    } catch (e) {}

    // D. News Real-time Listener (Cross-device news sync)
    try {
        onSnapshot(collection(db, "news"), (snap) => {
            const newsItems = [];
            snap.forEach(d => {
                newsItems.push({ id: d.id, ...d.data() });
            });
            currentState.news = newsItems;
            notifyStateChanged(false);
        }, (err) => console.warn('Firestore news error:', err));
    } catch (e) {}

    // E. Contests Real-time Listener (Cross-device contests sync)
    try {
        onSnapshot(collection(db, "contests"), (snap) => {
            const contestItems = [];
            snap.forEach(d => {
                contestItems.push({ id: d.id, ...d.data() });
            });
            currentState.contests = contestItems;
            notifyStateChanged(false);
        }, (err) => console.warn('Firestore contests error:', err));
    } catch (e) {}

    // F. Votes Real-time Listener (Admin live tally)
    try {
        onSnapshot(collection(db, "votes"), (snap) => {
            const votesList = [];
            snap.forEach(d => {
                votesList.push({ id: d.id, ...d.data() });
            });
            currentState.votes = votesList;
            notifyStateChanged(false);
        }, () => {});
    } catch (e) {}
}

async function fetchState(isInitial = false) {
    try {
        const res = await fetch('/api/state');
        if (res.ok) {
            const data = await res.json();
            if (data) {
                currentState = { ...currentState, ...data };
                notifyStateChanged(isInitial);
            }
        }
    } catch (e) {
        // Offline or static hosting
    }
}

// Запуск синхронизации
initRealtimeSync();

// -------------------------------------------------------------
// СУБ-ПОДПИСКИ ДЛЯ УДОБСТВА
// -------------------------------------------------------------
export function subscribeContests(callback) {
    return subscribeState(state => callback(state.contests || []));
}

export function subscribeNews(callback) {
    return subscribeState(state => callback(state.news || []));
}

export function subscribeParticipants(callback) {
    return subscribeState(state => callback(state.participants || []));
}

export function subscribeVotingState(callback) {
    return subscribeState(state => callback(state.votingState || { status: 'closed' }));
}

export function subscribeVotes(callback) {
    return subscribeState(state => callback(state.votes || []));
}

// -------------------------------------------------------------
// CRUD: NEWS
// -------------------------------------------------------------
export async function saveNewsArticle(article) {
    if (!article.id) article.id = 'news-' + Date.now();
    const idx = (currentState.news || []).findIndex(n => n.id === article.id);
    if (idx >= 0) {
        currentState.news[idx] = { ...currentState.news[idx], ...article };
    } else {
        currentState.news.unshift(article);
    }
    notifyStateChanged(true);

    // Save to Firestore (Cross-device persistence)
    try {
        await setDoc(doc(db, "news", article.id), article, { merge: true });
    } catch (e) {
        console.warn('Firestore save news error:', e);
    }

    // Save to REST API if available
    try {
        const res = await fetch('/api/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(article)
        });
        if (res.ok) {
            const data = await res.json();
            if (data.news) {
                currentState.news = data.news;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.news;
}

export async function deleteNewsArticle(articleId) {
    currentState.news = (currentState.news || []).filter(n => n.id !== articleId);
    notifyStateChanged(true);

    // Delete from Firestore
    try {
        await deleteDoc(doc(db, "news", articleId));
    } catch (e) {
        console.warn('Firestore delete news error:', e);
    }

    // Delete from REST API if available
    try {
        const res = await fetch(`/api/news/${articleId}`, { method: 'DELETE' });
        if (res.ok) {
            const data = await res.json();
            if (data.news) {
                currentState.news = data.news;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.news;
}

// -------------------------------------------------------------
// CRUD: CONTESTS
// -------------------------------------------------------------
export async function saveContest(contest) {
    if (!contest.id) contest.id = 'contest-' + Date.now();
    const idx = (currentState.contests || []).findIndex(c => c.id === contest.id);
    if (idx >= 0) {
        currentState.contests[idx] = { ...currentState.contests[idx], ...contest };
    } else {
        currentState.contests.unshift(contest);
    }
    notifyStateChanged(true);

    // Save to Firestore (Cross-device persistence)
    try {
        await setDoc(doc(db, "contests", contest.id), contest, { merge: true });
    } catch (e) {
        console.warn('Firestore save contest error:', e);
    }

    // Save to REST API if available
    try {
        const res = await fetch('/api/contests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(contest)
        });
        if (res.ok) {
            const data = await res.json();
            if (data.contests) {
                currentState.contests = data.contests;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.contests;
}

export async function deleteContest(contestId) {
    currentState.contests = (currentState.contests || []).filter(c => c.id !== contestId);
    notifyStateChanged(true);

    // Delete from Firestore
    try {
        await deleteDoc(doc(db, "contests", contestId));
    } catch (e) {
        console.warn('Firestore delete contest error:', e);
    }

    // Delete from REST API if available
    try {
        const res = await fetch(`/api/contests/${contestId}`, { method: 'DELETE' });
        if (res.ok) {
            const data = await res.json();
            if (data.contests) {
                currentState.contests = data.contests;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.contests;
}

// -------------------------------------------------------------
// CRUD: PARTICIPANTS (Номера для голосования)
// -------------------------------------------------------------
export async function saveParticipant(participant) {
    if (!participant.id) participant.id = 'p' + Date.now();
    if (!currentState.participants) currentState.participants = [];
    
    const idx = currentState.participants.findIndex(p => p.id === participant.id);
    if (idx >= 0) {
        currentState.participants[idx] = { ...currentState.participants[idx], ...participant };
    } else {
        currentState.participants.push(participant);
    }
    notifyStateChanged(true);

    // Save to Firestore system/participants
    try {
        await setDoc(doc(db, "system", "participants"), {
            list: currentState.participants,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) {
        console.warn('Firestore save participant error:', e);
    }

    try {
        const res = await fetch('/api/participants', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(participant)
        });
        if (res.ok) {
            const data = await res.json();
            if (data.participants) {
                currentState.participants = data.participants;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.participants;
}

export async function deleteParticipant(participantId) {
    if (!currentState.participants) currentState.participants = [];
    currentState.participants = currentState.participants.filter(p => p.id !== participantId);
    notifyStateChanged(true);

    // Save updated list to Firestore
    try {
        await setDoc(doc(db, "system", "participants"), {
            list: currentState.participants,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) {
        console.warn('Firestore delete participant error:', e);
    }

    try {
        const res = await fetch(`/api/participants/${participantId}`, { method: 'DELETE' });
        if (res.ok) {
            const data = await res.json();
            if (data.participants) {
                currentState.participants = data.participants;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.participants;
}

export async function resetParticipantsToDefault() {
    currentState.participants = [...DEFAULT_PARTICIPANTS];
    notifyStateChanged(true);

    try {
        await setDoc(doc(db, "system", "participants"), {
            list: DEFAULT_PARTICIPANTS,
            updatedAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) {}

    try {
        const res = await fetch('/api/participants/reset', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            if (data.participants) {
                currentState.participants = data.participants;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}
    return currentState.participants;
}

// -------------------------------------------------------------
// VOTING SYSTEM CONTROLS
// -------------------------------------------------------------
export async function updateVotingState(stateUpdate) {
    currentState.votingState = { ...currentState.votingState, ...stateUpdate };
    notifyStateChanged(true);

    try {
        await setDoc(doc(db, "system", "voting_state"), stateUpdate, { merge: true });
    } catch (e) {
        console.warn('Firestore update voting state error:', e);
    }

    try {
        await fetch('/api/voting/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stateUpdate)
        });
    } catch (e) {}
}

export async function updateVotingThreshold(threshold, revealMode) {
    currentState.manualThreshold = Number(threshold) || 0;
    if (revealMode !== undefined) currentState.revealMode = Boolean(revealMode);
    notifyStateChanged(true);

    try {
        await setDoc(doc(db, "system", "settings"), {
            manualThreshold: Number(threshold) || 0,
            revealMode: Boolean(revealMode)
        }, { merge: true });
    } catch (e) {}

    try {
        await fetch('/api/voting/threshold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ manualThreshold: threshold, revealMode })
        });
    } catch (e) {}
}

export async function saveRecapVideoUrl(url) {
    currentState.recapVideoUrl = url || '';
    notifyStateChanged(true);

    try {
        await setDoc(doc(db, "system", "settings"), {
            recapVideoUrl: url || ''
        }, { merge: true });
    } catch (e) {
        console.warn('Firestore save recap url error:', e);
    }

    try {
        const res = await fetch('/api/voting/recap-url', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recapVideoUrl: url })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.recapVideoUrl !== undefined) {
                currentState.recapVideoUrl = data.recapVideoUrl;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}
}

export async function saveFeaturedBanner(featuredContestId) {
    currentState.featuredContestId = featuredContestId || 'auto';
    notifyStateChanged(true);

    try {
        await setDoc(doc(db, "system", "settings"), {
            featuredContestId: featuredContestId || 'auto'
        }, { merge: true });
    } catch (e) {
        console.warn('Firestore save featured banner error:', e);
    }

    try {
        const res = await fetch('/api/settings/featured-contest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ featuredContestId })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.featuredContestId !== undefined) {
                currentState.featuredContestId = data.featuredContestId;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}
}

export async function toggleNewsReaction(newsId, emoji, action = 'add') {
    const article = (currentState.news || []).find(n => n.id === newsId);
    if (article) {
        if (!article.reactions) article.reactions = {};
        const curr = Number(article.reactions[emoji]) || 0;
        if (action === 'remove') {
            article.reactions[emoji] = Math.max(0, curr - 1);
        } else {
            article.reactions[emoji] = curr + 1;
        }
        notifyStateChanged(true);

        try {
            await setDoc(doc(db, "news", newsId), { reactions: article.reactions }, { merge: true });
        } catch (e) {}
    }

    try {
        const res = await fetch(`/api/news/${newsId}/react`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emoji, action })
        });
        if (res.ok) {
            const data = await res.json();
            if (article && data.reactions) {
                article.reactions = data.reactions;
                notifyStateChanged(true);
            }
        }
    } catch (e) {}
}

// -------------------------------------------------------------
// ПОЛЬЗОВАТЕЛЬСКАЯ АВТОРИЗАЦИЯ, РЕГИСТРАЦИЯ И СТАТУС АРТИСТА
// -------------------------------------------------------------
const authListeners = new Set();

export function subscribeAuth(callback) {
    authListeners.add(callback);
    try {
        callback(currentAuthUser);
    } catch (e) {
        console.warn('Auth callback err:', e);
    }
    return () => {
        authListeners.delete(callback);
    };
}

function notifyAuthChanged(user) {
    currentAuthUser = user;
    try {
        if (user) {
            localStorage.setItem(LOCAL_STORAGE_USER_KEY, JSON.stringify(user));
        } else {
            localStorage.removeItem(LOCAL_STORAGE_USER_KEY);
        }
    } catch (e) {}
    authListeners.forEach(cb => {
        try {
            cb(currentAuthUser);
        } catch (e) {
            console.error('Auth listener error:', e);
        }
    });
}

export function getCurrentAuthUser() {
    return currentAuthUser;
}

// Поиск совпадений артиста по номеру, стране, названию, логину или привязанному логину
export function calculateBlockedIdsForArtist(artistData, participantsList) {
    const blocked = new Set();
    const list = participantsList || currentState.participants || DEFAULT_PARTICIPANTS;
    
    if (!artistData) return [];

    const artLogin = String(artistData.login || artistData.username || artistData.id || '').trim().toLowerCase();
    const artEmail = String(artistData.email || '').trim().toLowerCase();
    const artCleanEmail = artEmail.split('@')[0];

    // 0. Прямая привязка логина на уровне участника из админки (p.artistLogin / p.linkedArtistLogin)
    list.forEach(p => {
        const pLogin = String(p.artistLogin || p.linkedArtistLogin || '').trim().toLowerCase();
        if (pLogin) {
            if (pLogin === artLogin || pLogin === artEmail || (artCleanEmail && pLogin === artCleanEmail)) {
                blocked.add(p.id);
            }
        }
    });

    // 1. Прямые ID
    if (artistData.participantId) blocked.add(String(artistData.participantId));
    if (Array.isArray(artistData.blockedIds)) {
        artistData.blockedIds.forEach(id => blocked.add(String(id)));
    }
    
    // 2. Номера участников (number: 1..99)
    if (artistData.number !== undefined && artistData.number !== null) {
        const targetNum = Number(artistData.number);
        const p = list.find(x => Number(x.number) === targetNum || x.id === `p${targetNum}`);
        if (p) blocked.add(p.id);
    }
    if (Array.isArray(artistData.blockedNumbers)) {
        artistData.blockedNumbers.forEach(n => {
            const targetNum = Number(n);
            const p = list.find(x => Number(x.number) === targetNum || x.id === `p${targetNum}`);
            if (p) blocked.add(p.id);
        });
    }

    // 3. Страна (country)
    if (artistData.country) {
        const cLow = String(artistData.country).trim().toLowerCase();
        const p = list.find(x => x.country && x.country.trim().toLowerCase() === cLow);
        if (p) blocked.add(p.id);
    }

    // 4. Имя артиста (artist)
    if (artistData.artist) {
        const aLow = String(artistData.artist).trim().toLowerCase();
        const p = list.find(x => (x.artist && x.artist.trim().toLowerCase() === aLow) || (x.name && x.name.trim().toLowerCase() === aLow));
        if (p) blocked.add(p.id);
    }

    // 5. Имя участника (name)
    if (artistData.name) {
        const nLow = String(artistData.name).trim().toLowerCase();
        const p = list.find(x => (x.name && x.name.trim().toLowerCase() === nLow) || (x.artist && x.artist.trim().toLowerCase() === nLow));
        if (p) blocked.add(p.id);
    }

    // 6. Если doc.id сам по себе 'p1'..'p8'
    if (artistData.id && /^p\d+$/i.test(artistData.id)) {
        blocked.add(artistData.id);
    }

    return Array.from(blocked);
}

// Получение списка всех артистов из коллекции Firestore
export async function fetchArtistsFromFirestore() {
    if (!db) return [];
    const artists = [];
    try {
        const snap = await getDocs(collection(db, "artists"));
        snap.forEach(d => {
            artists.push({ id: d.id, ...d.data() });
        });
    } catch (e) {
        console.warn('Fetch artists collection warning:', e);
    }
    return artists;
}

// Авторизация пользователя или артиста
export async function loginUser(emailOrLogin, password) {
    const raw = (emailOrLogin || '').trim();
    const pass = (password || '').trim();

    if (!raw || !pass) {
        throw new Error('Пожалуйста, введите логин/email и пароль');
    }

    const isEmail = raw.includes('@');
    const cleanLogin = isEmail ? raw.split('@')[0] : raw;

    // 1. Проверяем коллекцию artists в Firestore
    let matchedArtistDoc = null;
    try {
        const allArtists = await fetchArtistsFromFirestore();
        matchedArtistDoc = allArtists.find(a => {
            const docId = String(a.id || '').trim().toLowerCase();
            const aLogin = String(a.login || a.username || '').trim().toLowerCase();
            const aEmail = String(a.email || '').trim().toLowerCase();
            const aArtist = String(a.artist || a.name || '').trim().toLowerCase();
            const aCountry = String(a.country || '').trim().toLowerCase();

            const target = raw.toLowerCase();
            const targetClean = cleanLogin.toLowerCase();

            return (
                docId === target || 
                docId === targetClean ||
                aLogin === target || 
                aLogin === targetClean ||
                aEmail === target ||
                (aEmail && aEmail.startsWith(targetClean + '@')) ||
                aArtist === target ||
                aCountry === target
            );
        });

        // Также проверяем список участников, настроенный в админке (currentState.participants)
        if (!matchedArtistDoc && currentState.participants) {
            const matchedP = currentState.participants.find(p => {
                const pLogin = String(p.artistLogin || p.linkedArtistLogin || '').trim().toLowerCase();
                const pArtist = String(p.artist || '').trim().toLowerCase();
                const pCountry = String(p.country || '').trim().toLowerCase();
                const pName = String(p.name || '').trim().toLowerCase();
                const targetClean = cleanLogin.toLowerCase();
                const target = raw.toLowerCase();

                return (
                    (pLogin && (pLogin === targetClean || pLogin === target)) ||
                    (pArtist && (pArtist === targetClean || pArtist === target)) ||
                    (pCountry && (pCountry === targetClean || pCountry === target)) ||
                    (pName && (pName === targetClean || pName === target))
                );
            });

            if (matchedP) {
                matchedArtistDoc = {
                    id: matchedP.id,
                    number: matchedP.number,
                    artist: matchedP.artist || matchedP.name,
                    country: matchedP.country,
                    name: matchedP.name,
                    artistLogin: matchedP.artistLogin,
                    blockedIds: [matchedP.id],
                    email: `${cleanLogin}@harivision.app`
                };
            }
        }
    } catch (e) {
        console.warn('Check artists error:', e);
    }

    // 2. Если в документе артиста в Firestore хранится пароль и он совпадает
    if (matchedArtistDoc && matchedArtistDoc.password && String(matchedArtistDoc.password).trim() === pass) {
        const blockedIds = calculateBlockedIdsForArtist(matchedArtistDoc, currentState.participants);
        const userObj = {
            uid: matchedArtistDoc.id || 'artist_' + Date.now(),
            email: matchedArtistDoc.email || `${cleanLogin}@harivision.app`,
            login: matchedArtistDoc.login || cleanLogin,
            displayName: matchedArtistDoc.artist || matchedArtistDoc.name || matchedArtistDoc.country || cleanLogin,
            role: 'artist',
            artistData: matchedArtistDoc,
            blockedParticipantIds: blockedIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // 3. Пробуем войти через Firebase Authentication
    // Формируем список кандидатов на email (если ввели без @)
    const emailCandidates = [];
    if (isEmail) {
        emailCandidates.push(raw);
    } else {
        if (matchedArtistDoc && matchedArtistDoc.email) {
            emailCandidates.push(matchedArtistDoc.email);
        }
        emailCandidates.push(`${cleanLogin}@harivision.app`);
        emailCandidates.push(`${cleanLogin}@harivision.org`);
        emailCandidates.push(`${cleanLogin}@gmail.com`);
    }

    let authUserCredential = null;
    let lastAuthError = null;

    for (const emailTry of emailCandidates) {
        try {
            authUserCredential = await signInWithEmailAndPassword(auth, emailTry, pass);
            if (authUserCredential && authUserCredential.user) break;
        } catch (err) {
            lastAuthError = err;
            if (isEmail) break; // если юзер явно ввел email с @, не перебираем домены
        }
    }

    if (authUserCredential && authUserCredential.user) {
        const fbUser = authUserCredential.user;
        const effectiveEmail = fbUser.email || (isEmail ? raw : `${cleanLogin}@harivision.app`);

        // Проверяем, является ли пользователь артистом
        let isArtist = Boolean(matchedArtistDoc);
        if (!matchedArtistDoc) {
            try {
                const allArtists = await fetchArtistsFromFirestore();
                matchedArtistDoc = allArtists.find(a => 
                    (a.email && a.email.toLowerCase() === effectiveEmail.toLowerCase()) ||
                    (a.login && a.login.toLowerCase() === cleanLogin.toLowerCase()) ||
                    (a.id && a.id.toLowerCase() === cleanLogin.toLowerCase())
                );
                if (matchedArtistDoc) isArtist = true;
            } catch (e) {}
        }

        const blockedIds = isArtist ? calculateBlockedIdsForArtist(matchedArtistDoc, currentState.participants) : [];
        const userObj = {
            uid: fbUser.uid,
            email: effectiveEmail,
            login: cleanLogin,
            displayName: fbUser.displayName || (matchedArtistDoc ? (matchedArtistDoc.artist || matchedArtistDoc.name) : cleanLogin),
            role: isArtist ? 'artist' : 'user',
            artistData: isArtist ? matchedArtistDoc : null,
            blockedParticipantIds: blockedIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // Если ничего не подошло
    let errMsg = 'Неверный логин или пароль';
    if (lastAuthError) {
        if (lastAuthError.code === 'auth/wrong-password' || lastAuthError.code === 'auth/invalid-credential') {
            errMsg = 'Неверный пароль или email';
        } else if (lastAuthError.code === 'auth/user-not-found') {
            errMsg = 'Пользователь с таким логином не найден. Зарегистрируйтесь, если у вас еще нет аккаунта.';
        } else if (lastAuthError.code === 'auth/too-many-requests') {
            errMsg = 'Слишком много попыток входа. Попробуйте позже.';
        }
    }
    throw new Error(errMsg);
}

// Регистрация нового зрителя
export async function registerUser(emailOrLogin, password, displayName = '') {
    const raw = (emailOrLogin || '').trim();
    const pass = (password || '').trim();
    const name = (displayName || '').trim();

    if (!raw || !pass) {
        throw new Error('Пожалуйста, заполните все обязательные поля');
    }
    if (pass.length < 6) {
        throw new Error('Пароль должен содержать не менее 6 символов');
    }

    const isEmail = raw.includes('@');
    const cleanLogin = isEmail ? raw.split('@')[0] : raw;
    const finalEmail = isEmail ? raw : `${cleanLogin}@harivision.app`;
    const finalName = name || cleanLogin;

    try {
        const cred = await createUserWithEmailAndPassword(auth, finalEmail, pass);
        const fbUser = cred.user;

        // Сохраняем профиль в Firestore collection "users"
        try {
            await setDoc(doc(db, "users", fbUser.uid), {
                uid: fbUser.uid,
                email: finalEmail,
                login: cleanLogin,
                displayName: finalName,
                role: 'user',
                createdAt: new Date().toISOString()
            }, { merge: true });
        } catch (e) {}

        const userObj = {
            uid: fbUser.uid,
            email: finalEmail,
            login: cleanLogin,
            displayName: finalName,
            role: 'user',
            artistData: null,
            blockedParticipantIds: []
        };
        notifyAuthChanged(userObj);
        return userObj;
    } catch (err) {
        console.error('Registration error:', err);
        let msg = 'Ошибка регистрации';
        if (err.code === 'auth/email-already-in-use') {
            msg = 'Пользователь с таким логином или почтой уже существует. Пожалуйста, войдите.';
        } else if (err.code === 'auth/weak-password') {
            msg = 'Слишком простой пароль. Используйте минимум 6 символов.';
        } else if (err.code === 'auth/invalid-email') {
            msg = 'Некорректный формат email.';
        }
        throw new Error(msg);
    }
}

// Выход из аккаунта
export async function logoutUser() {
    try {
        await signOut(auth);
        await signInAnonymously(auth);
    } catch (e) {}
    notifyAuthChanged(null);
}

// Автоматическая синхронизация сессии Firebase Auth
onAuthStateChanged(auth, async (fbUser) => {
    if (fbUser && !fbUser.isAnonymous) {
        try {
            const rawEmail = fbUser.email || '';
            const cleanLogin = rawEmail.includes('@') ? rawEmail.split('@')[0] : (fbUser.displayName || 'user');
            
            // Проверяем статус артиста
            const allArtists = await fetchArtistsFromFirestore();
            const matchedArtistDoc = allArtists.find(a => {
                const docId = String(a.id || '').trim().toLowerCase();
                const aLogin = String(a.login || a.username || '').trim().toLowerCase();
                const aEmail = String(a.email || '').trim().toLowerCase();
                const targetClean = cleanLogin.toLowerCase();
                const targetEmail = rawEmail.toLowerCase();
                return (
                    docId === targetClean ||
                    aLogin === targetClean ||
                    aEmail === targetEmail ||
                    (aEmail && aEmail.startsWith(targetClean + '@'))
                );
            });

            const isArtist = Boolean(matchedArtistDoc);
            const blockedIds = isArtist ? calculateBlockedIdsForArtist(matchedArtistDoc, currentState.participants) : [];

            const userObj = {
                uid: fbUser.uid,
                email: rawEmail,
                login: cleanLogin,
                displayName: fbUser.displayName || (matchedArtistDoc ? (matchedArtistDoc.artist || matchedArtistDoc.name) : cleanLogin),
                role: isArtist ? 'artist' : 'user',
                artistData: isArtist ? matchedArtistDoc : null,
                blockedParticipantIds: blockedIds
            };
            notifyAuthChanged(userObj);
        } catch (e) {
            console.warn('Sync auth user error:', e);
        }
    } else if (!fbUser) {
        if (!currentAuthUser?.artistData?.password) {
            notifyAuthChanged(null);
        }
    }
});

export async function loginAdminServer(emailOrUsername, password) {
    const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: emailOrUsername,
            username: emailOrUsername,
            password
        })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
        throw new Error(data.error || 'Ошибка авторизации администратора');
    }
    return data;
}

export async function verifyAdminSession() {
    const token = localStorage.getItem('harivision_admin_token');
    if (!token) return false;
    try {
        const res = await fetch('/api/admin/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        return Boolean(data.valid);
    } catch (e) {
        return false;
    }
}

// -------------------------------------------------------------
// VOTES SUBMISSION & MANAGEMENT
// -------------------------------------------------------------
export async function submitVote(voteData) {
    const voteId = voteData.id || ('vote_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6));
    const votePayload = { ...voteData, id: voteId, createdAt: voteData.createdAt || new Date().toISOString() };

    // Save directly to Firestore for serverless / GitHub Pages compatibility
    try {
        await setDoc(doc(db, "votes", voteId), votePayload);
    } catch (e) {
        console.warn('Firestore direct vote submit error:', e);
    }

    try {
        const res = await fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(votePayload)
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to submit vote');
        }
        return await res.json();
    } catch (e) {
        // If API fails (e.g. static hosting), but Firestore succeeded, return votePayload
        return { success: true, vote: votePayload };
    }
}

export async function deleteVote(voteId) {
    currentState.votes = (currentState.votes || []).filter(v => v.id !== voteId);
    notifyStateChanged(true);

    try {
        await deleteDoc(doc(db, "votes", voteId));
    } catch (e) {
        console.warn('Firestore delete vote error:', e);
    }

    try {
        await fetch(`/api/votes/${voteId}`, { method: 'DELETE' });
    } catch (e) {}
}

export async function resetAllVotes() {
    currentState.votes = [];
    notifyStateChanged(true);

    try {
        const snap = await getDocs(collection(db, "votes"));
        const deletePromises = [];
        snap.forEach(d => deletePromises.push(deleteDoc(d.ref)));
        await Promise.all(deletePromises);
    } catch (e) {
        console.warn('Firestore reset votes error:', e);
    }

    try {
        await fetch('/api/votes/reset-all', { method: 'POST' });
    } catch (e) {}
}

export async function syncAllToFirestore() {
    if (!db) return;
    try {
        // News
        if (Array.isArray(currentState.news)) {
            for (const item of currentState.news) {
                if (item && item.id) {
                    await setDoc(doc(db, "news", item.id), item, { merge: true });
                }
            }
        }
        // Contests
        if (Array.isArray(currentState.contests)) {
            for (const c of currentState.contests) {
                if (c && c.id) {
                    await setDoc(doc(db, "contests", c.id), c, { merge: true });
                }
            }
        }
        // Participants
        if (Array.isArray(currentState.participants) && currentState.participants.length > 0) {
            await setDoc(doc(db, "system", "participants"), {
                list: currentState.participants,
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }
        // Settings
        await setDoc(doc(db, "system", "settings"), {
            recapVideoUrl: currentState.recapVideoUrl || '',
            featuredContestId: currentState.featuredContestId || 'auto',
            manualThreshold: Number(currentState.manualThreshold) || 0,
            revealMode: Boolean(currentState.revealMode)
        }, { merge: true });
        // Voting State
        if (currentState.votingState) {
            await setDoc(doc(db, "system", "voting_state"), currentState.votingState, { merge: true });
        }
        console.log('Successfully synced all data to Firestore Cloud');
        return true;
    } catch (e) {
        console.warn('Sync all to Firestore error:', e);
        return false;
    }
}

export function getCurrentState() {
    return currentState;
}

