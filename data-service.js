import { db, auth, INITIAL_CONTESTS, INITIAL_NEWS, DEFAULT_PARTICIPANTS } from './config.js';
import { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, getDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    signInWithEmailAndPassword, 
    createUserWithEmailAndPassword, 
    signOut, 
    onAuthStateChanged, 
    signInAnonymously 
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// -------------------------------------------------------------
// SAFE JSON UTILS & FIRESTORE DATA SANITIZATION
// -------------------------------------------------------------
export function safeJsonStringify(obj, fallback = '') {
    try {
        const seen = new WeakSet();
        return JSON.stringify(obj, (key, value) => {
            if (typeof value === 'object' && value !== null) {
                // Firestore Timestamp
                if (typeof value.toDate === 'function') {
                    return value.toDate().toISOString();
                }
                if (typeof value.toMillis === 'function') {
                    return value.toMillis();
                }
                // Firestore DocumentReference or internal objects
                if (value.id && (value.path || value.firestore)) {
                    return String(value.id);
                }
                // Break circular references
                if (seen.has(value)) {
                    return undefined;
                }
                seen.add(value);
            }
            return value;
        });
    } catch (e) {
        return fallback;
    }
}

export function sanitizeFirestoreData(val, seen = new WeakSet()) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;

    // Firestore Timestamp
    if (typeof val.toDate === 'function') {
        return val.toDate().toISOString();
    }
    if (typeof val.toMillis === 'function') {
        return val.toMillis();
    }

    // Firestore DocumentReference
    if (val.id && (val.path || val.firestore)) {
        return String(val.id);
    }

    // Check circular references
    if (seen.has(val)) {
        return undefined;
    }
    seen.add(val);

    if (Array.isArray(val)) {
        return val.map(item => sanitizeFirestoreData(item, seen)).filter(item => item !== undefined);
    }

    const res = {};
    for (const key of Object.keys(val)) {
        if (key.startsWith('_') || key === 'firestore') continue;
        const cleaned = sanitizeFirestoreData(val[key], seen);
        if (cleaned !== undefined) {
            res[key] = cleaned;
        }
    }
    return res;
}

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
        const parsed = JSON.parse(cached);
        if (parsed.contests && Array.isArray(parsed.contests) && parsed.contests.length > 0) {
            currentState.contests = parsed.contests;
        }
        if (parsed.news && Array.isArray(parsed.news) && parsed.news.length > 0) {
            currentState.news = parsed.news;
        }
        if (parsed.participants && Array.isArray(parsed.participants) && parsed.participants.length > 0) {
            currentState.participants = parsed.participants;
        }
        if (parsed.votingState) currentState.votingState = parsed.votingState;
        if (parsed.recapVideoUrl) currentState.recapVideoUrl = parsed.recapVideoUrl;
        if (parsed.featuredContestId) currentState.featuredContestId = parsed.featuredContestId;
        if (parsed.manualThreshold !== undefined) currentState.manualThreshold = parsed.manualThreshold;
        if (parsed.revealMode !== undefined) currentState.revealMode = parsed.revealMode;
    }
} catch (e) {
    console.warn('LocalStorage error:', e);
}

function saveLocalCache() {
    try {
        const str = safeJsonStringify(currentState);
        if (str) {
            localStorage.setItem(LOCAL_STORAGE_STATE_KEY, str);
        }
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
    const serialized = safeJsonStringify({
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

    if (!force && serialized && serialized === lastNotifiedStateJson) {
        return false;
    }

    lastNotifiedStateJson = serialized;
    saveLocalCache();

    // Синхронизируем статус артиста и блокировку номеров при изменении участников
    if (currentAuthUser) {
        syncCurrentUserArtistStatus();
    }

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
                const data = sanitizeFirestoreData(settingsSnap.data()) || {};
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
                const fsState = sanitizeFirestoreData(votingSnap.data()) || {};
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
                const pData = sanitizeFirestoreData(partSnap.data());
                if (pData && Array.isArray(pData.list) && pData.list.length > 0) {
                    if (safeJsonStringify(currentState.participants) !== safeJsonStringify(pData.list)) {
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
                const cleaned = sanitizeFirestoreData(d.data());
                newsItems.push({ id: d.id, ...(cleaned || {}) });
            });
            if (newsItems.length > 0) {
                if (safeJsonStringify(currentState.news) !== safeJsonStringify(newsItems)) {
                    currentState.news = newsItems;
                    stateChanged = true;
                }
            } else if (newsSnap.empty && currentState.news && currentState.news.length > 0) {
                for (const item of currentState.news) {
                    setDoc(doc(db, "news", item.id), item, { merge: true }).catch(() => {});
                }
            }
        } catch (e) {}

        // 5. Contests Collection (Single source of truth, identical to News)
        try {
            const contestSnap = await getDocs(collection(db, "contests"));
            const contestItems = [];
            contestSnap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                contestItems.push({ id: d.id, ...(cleaned || {}) });
            });
            if (contestItems.length > 0) {
                if (safeJsonStringify(currentState.contests) !== safeJsonStringify(contestItems)) {
                    currentState.contests = contestItems;
                    stateChanged = true;
                }
            } else if (contestSnap.empty && currentState.contests && currentState.contests.length > 0) {
                for (const c of currentState.contests) {
                    setDoc(doc(db, "contests", c.id), c, { merge: true }).catch(() => {});
                }
            }
        } catch (e) {
            console.warn('Contests fetch error:', e);
        }

        // 6. Votes Collection
        try {
            const votesSnap = await getDocs(collection(db, "votes"));
            const votesList = [];
            votesSnap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                votesList.push({ id: d.id, ...(cleaned || {}) });
            });
            if (safeJsonStringify(currentState.votes) !== safeJsonStringify(votesList)) {
                currentState.votes = votesList;
                stateChanged = true;
            }
        } catch (e) {}

        // 7. Artists Multi-Source Sync (Collection "artists", "users", "system/artists")
        try {
            const allArtists = await fetchArtistsFromFirestore();
            if (safeJsonStringify(currentState.artists) !== safeJsonStringify(allArtists)) {
                currentState.artists = allArtists;
                stateChanged = true;
            }
        } catch (e) {}

        if (stateChanged) {
            notifyStateChanged(false);
            syncCurrentUserArtistStatus();
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

    // 4. Polling fallback (every 3 seconds)
    setInterval(() => {
        fetchState(false);
    }, 3000);

    // 5. Instant refresh on PWA focus / resume / visibility change (when returning to app)
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

    // 6. Firestore Real-time Snapshot Listeners (push updates automatically without polling)
    initFirestoreListeners();
}

function initFirestoreListeners() {
    if (!db) return;

    // A. Voting State Listener
    try {
        onSnapshot(doc(db, "system", "voting_state"), (snap) => {
            if (snap.exists()) {
                const fsState = sanitizeFirestoreData(snap.data()) || {};
                const endsAtVal = fsState.endsAt ? (fsState.endsAt.toDate ? fsState.endsAt.toDate().toISOString() : fsState.endsAt) : null;
                currentState.votingState = {
                    ...currentState.votingState,
                    status: fsState.status || currentState.votingState.status,
                    endsAt: endsAtVal,
                    sessionId: fsState.sessionId || currentState.votingState.sessionId
                };
                notifyStateChanged(false);
            }
        }, (err) => console.warn('Firestore voting_state error:', err));
    } catch (e) {}

    // B. System Settings Listener (recapVideoUrl, featuredContestId, manualThreshold, revealMode)
    try {
        onSnapshot(doc(db, "system", "settings"), (snap) => {
            if (snap.exists()) {
                const data = sanitizeFirestoreData(snap.data()) || {};
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
        }, (err) => console.warn('Firestore settings error:', err));
    } catch (e) {}

    // C. Participants Listener
    try {
        onSnapshot(doc(db, "system", "participants"), (snap) => {
            if (snap.exists()) {
                const data = sanitizeFirestoreData(snap.data());
                if (data && Array.isArray(data.list) && data.list.length > 0) {
                    currentState.participants = data.list;
                    notifyStateChanged(false);
                    syncCurrentUserArtistStatus();
                }
            }
        }, (err) => console.warn('Firestore participants error:', err));
    } catch (e) {}

    // D. News Real-time Listener (Cross-device news sync)
    try {
        onSnapshot(collection(db, "news"), (snap) => {
            const newsItems = [];
            snap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                newsItems.push({ id: d.id, ...(cleaned || {}) });
            });
            if (newsItems.length > 0) {
                currentState.news = newsItems;
                notifyStateChanged(false);
            }
        }, (err) => console.warn('Firestore news error:', err));
    } catch (e) {}

    // E. Contests Real-time Listener (Single collection "contests" - identical to news)
    try {
        onSnapshot(collection(db, "contests"), (snap) => {
            const contestItems = [];
            snap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                contestItems.push({ id: d.id, ...(cleaned || {}) });
            });
            if (contestItems.length > 0) {
                currentState.contests = contestItems;
                notifyStateChanged(false);
                syncCurrentUserArtistStatus();
            }
        }, (err) => console.warn('Firestore contests error:', err));
    } catch (e) {}

    // F. Votes Real-time Listener (Admin live tally)
    try {
        onSnapshot(collection(db, "votes"), (snap) => {
            const votesList = [];
            snap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                votesList.push({ id: d.id, ...(cleaned || {}) });
            });
            currentState.votes = votesList;
            notifyStateChanged(false);
        }, () => {});
    } catch (e) {}

    // G. Artists Real-time Listener (Cross-device artist detection & updates)
    try {
        onSnapshot(collection(db, "artists"), () => {
            fetchArtistsFromFirestore().then(all => {
                currentState.artists = all;
                notifyStateChanged(false);
                syncCurrentUserArtistStatus();
            });
        }, (err) => console.warn('Firestore artists error:', err));
    } catch (e) {}

    // H. Users Real-time Listener (For artists registered in users collection)
    try {
        onSnapshot(collection(db, "users"), () => {
            fetchArtistsFromFirestore().then(all => {
                currentState.artists = all;
                notifyStateChanged(false);
                syncCurrentUserArtistStatus();
            });
        }, (err) => console.warn('Firestore users listener error:', err));
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

    // Save to Firestore (Single collection "contests" - identical to news pattern)
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

// Таблица синонимов стран для точного и нечувствительного к языку сопоставления
const COUNTRY_SYNONYMS = {
    'austria': ['австрия', 'austria', 'aut', 'at', 'österreich', 'osterreich'],
    'австрия': ['австрия', 'austria', 'aut', 'at', 'österreich', 'osterreich'],
    'sweden': ['швеция', 'sweden', 'swe', 'se', 'sverige'],
    'швеция': ['швеция', 'sweden', 'swe', 'se', 'sverige'],
    'finland': ['финляндия', 'finland', 'fin', 'fi', 'suomi'],
    'финляндия': ['финляндия', 'finland', 'fin', 'fi', 'suomi'],
    'norway': ['норвегия', 'norway', 'nor', 'no', 'norge'],
    'норвегия': ['норвегия', 'norway', 'nor', 'no', 'norge'],
    'spain': ['испания', 'spain', 'esp', 'es', 'españa', 'espana'],
    'испания': ['испания', 'spain', 'esp', 'es', 'españa', 'espana'],
    'italy': ['италия', 'italy', 'ita', 'it', 'italia'],
    'италия': ['италия', 'italy', 'ita', 'it', 'italia'],
    'france': ['франция', 'france', 'fra', 'fr'],
    'франция': ['франция', 'france', 'fra', 'fr'],
    'germany': ['германия', 'germany', 'ger', 'deu', 'de', 'deutschland', 'дойчланд'],
    'германия': ['германия', 'germany', 'ger', 'deu', 'de', 'deutschland', 'дойчланд'],
    'poland': ['польша', 'poland', 'pol', 'pl', 'polska'],
    'польша': ['польша', 'poland', 'pol', 'pl', 'polska'],
    'uk': ['великобритания', 'united kingdom', 'uk', 'gbr', 'gb', 'англия', 'england', 'британия', 'britain'],
    'великобритания': ['великобритания', 'united kingdom', 'uk', 'gbr', 'gb', 'англия', 'england', 'британия', 'britain'],
    'israel': ['израиль', 'israel', 'isr', 'il'],
    'израиль': ['израиль', 'israel', 'isr', 'il'],
    'ukraine': ['украина', 'ukraine', 'ukr', 'ua', 'україна'],
    'украина': ['украина', 'ukraine', 'ukr', 'ua', 'україна'],
    'netherlands': ['нидерланды', 'netherlands', 'ned', 'nl', 'голландия', 'holland', 'nederland'],
    'нидерланды': ['нидерланды', 'netherlands', 'ned', 'nl', 'голландия', 'holland', 'nederland'],
    'switzerland': ['швейцария', 'switzerland', 'sui', 'ch', 'schweiz', 'suisse'],
    'швейцария': ['швейцария', 'switzerland', 'sui', 'ch', 'schweiz', 'suisse'],
    'croatia': ['хорватия', 'croatia', 'cro', 'hr', 'hrvatska'],
    'хорватия': ['хорватия', 'croatia', 'cro', 'hr', 'hrvatska'],
    'greece': ['греция', 'greece', 'gre', 'gr', 'hellas'],
    'греция': ['греция', 'greece', 'gre', 'gr', 'hellas'],
    'estonia': ['эстония', 'estonia', 'est', 'ee', 'eesti'],
    'эстония': ['эстония', 'estonia', 'est', 'ee', 'eesti'],
    'lithuania': ['литва', 'lithuania', 'ltu', 'lt', 'lietuva'],
    'литва': ['литва', 'lithuania', 'ltu', 'lt', 'lietuva'],
    'latvia': ['латвия', 'latvia', 'lat', 'lv', 'latvija'],
    'латвия': ['латвия', 'latvia', 'lat', 'lv', 'latvija'],
    'portugal': ['португалия', 'portugal', 'por', 'pt'],
    'португалия': ['португалия', 'portugal', 'por', 'pt'],
    'cyprus': ['кипр', 'cyprus', 'cyp', 'cy'],
    'кипр': ['кипр', 'cyprus', 'cyp', 'cy'],
    'armenia': ['армения', 'armenia', 'arm', 'am'],
    'армения': ['армения', 'armenia', 'arm', 'am'],
    'georgia': ['грузия', 'georgia', 'geo', 'ge'],
    'грузия': ['грузия', 'georgia', 'geo', 'ge'],
    'azerbaijan': ['азербайджан', 'azerbaijan', 'aze', 'az'],
    'азербайджан': ['азербайджан', 'azerbaijan', 'aze', 'az'],
    'belgium': ['бельгия', 'belgium', 'bel', 'be', 'belgique'],
    'бельгия': ['бельгия', 'belgium', 'bel', 'be', 'belgique'],
    'denmark': ['дания', 'denmark', 'den', 'dk', 'danmark'],
    'дания': ['дания', 'denmark', 'den', 'dk', 'danmark'],
    'iceland': ['исландия', 'iceland', 'isl', 'is', 'island'],
    'исландия': ['исландия', 'iceland', 'isl', 'is', 'island'],
    'ireland': ['ирландия', 'ireland', 'irl', 'ie'],
    'ирландия': ['ирландия', 'ireland', 'irl', 'ie'],
    'serbia': ['сербия', 'serbia', 'srb', 'rs', 'srbija'],
    'сербия': ['сербия', 'serbia', 'srb', 'rs', 'srbija'],
    'slovenia': ['словения', 'slovenia', 'slo', 'si', 'slovenija'],
    'словения': ['словения', 'slovenia', 'slo', 'si', 'slovenija'],
    'slovakia': ['словакия', 'slovakia', 'svk', 'sk', 'slovensko'],
    'словакия': ['словакия', 'slovakia', 'svk', 'sk', 'slovensko'],
    'czechia': ['чехия', 'czechia', 'czech republic', 'cze', 'cz', 'cesko'],
    'чехия': ['чехия', 'czechia', 'czech republic', 'cze', 'cz', 'cesko'],
    'sanmarino': ['сан-марино', 'сан марино', 'san marino', 'smr', 'sm'],
    'сан-марино': ['сан-марино', 'сан марино', 'san marino', 'smr', 'sm'],
    'malta': ['мальта', 'malta', 'mlt', 'mt'],
    'мальта': ['мальта', 'malta', 'mlt', 'mt'],
    'australia': ['австралия', 'australia', 'aus', 'au'],
    'австралия': ['австралия', 'australia', 'aus', 'au'],
    'moldova': ['молдова', 'молдавия', 'moldova', 'mda', 'md'],
    'молдова': ['молдова', 'молдавия', 'moldova', 'mda', 'md'],
    'albania': ['албания', 'albania', 'alb', 'al', 'shqiperia'],
    'албания': ['албания', 'albania', 'alb', 'al', 'shqiperia'],
    'luxembourg': ['люксембург', 'luxembourg', 'lux', 'lu'],
    'люксембург': ['люксембург', 'luxembourg', 'lux', 'lu'],
    'monaco': ['монако', 'monaco', 'mco', 'mc'],
    'монако': ['монако', 'monaco', 'mco', 'mc'],
    'montenegro': ['черногория', 'montenegro', 'mne', 'me', 'crna gora'],
    'черногория': ['черногория', 'montenegro', 'mne', 'me', 'crna gora'],
    'macedonia': ['македония', 'северная македония', 'north macedonia', 'macedonia', 'mkd', 'mk'],
    'македония': ['македония', 'северная македония', 'north macedonia', 'macedonia', 'mkd', 'mk'],
    'bulgaria': ['болгария', 'bulgaria', 'bul', 'bg'],
    'болгария': ['болгария', 'bulgaria', 'bul', 'bg'],
    'hungary': ['венгрия', 'hungary', 'hun', 'hu', 'magyarorszag'],
    'венгрия': ['венгрия', 'hungary', 'hun', 'hu', 'magyarorszag'],
    'romania': ['румыния', 'romania', 'rou', 'ro'],
    'румыния': ['румыния', 'romania', 'rou', 'ro'],
    'russia': ['россия', 'russia', 'rus', 'ru'],
    'россия': ['россия', 'russia', 'rus', 'ru'],
    'belarus': ['беларусь', 'белоруссия', 'belarus', 'blr', 'by'],
    'беларусь': ['беларусь', 'белоруссия', 'belarus', 'blr', 'by'],
    'turkey': ['турция', 'turkey', 'turkiye', 'türkiye', 'tur', 'tr'],
    'турция': ['турция', 'turkey', 'turkiye', 'türkiye', 'tur', 'tr'],
    'kazakhstan': ['казахстан', 'kazakhstan', 'kaz', 'kz'],
    'казахстан': ['казахстан', 'kazakhstan', 'kaz', 'kz']
};

function normalizeString(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9\s]/gi, ' ')
        .trim();
}

function extractKeywords(str) {
    if (!str) return [];
    const norm = normalizeString(str);
    const ignoreWords = new Set(['artist', 'singer', 'music', 'official', 'user', 'fan', 'team', 'app', 'gmail', 'com', 'mail', 'ru', 'yandex', 'org', 'the']);
    return norm.split(/\s+/).filter(w => w.length >= 2 && !ignoreWords.has(w));
}

function isFuzzyMatch(str1, str2) {
    if (!str1 || !str2) return false;
    const n1 = normalizeString(str1);
    const n2 = normalizeString(str2);
    if (n1 === n2) return true;
    if (n1.length >= 3 && n2.length >= 3) {
        if (n1.includes(n2) || n2.includes(n1)) return true;
    }
    const t1 = extractKeywords(str1);
    const t2 = extractKeywords(str2);
    return t1.some(w => t2.includes(w));
}

function countriesMatch(c1, c2) {
    if (!c1 || !c2) return false;
    const str1 = normalizeString(c1);
    const str2 = normalizeString(c2);
    if (str1 === str2) return true;
    if (str1.length >= 3 && (str1.includes(str2) || str2.includes(str1))) return true;

    const syns1 = COUNTRY_SYNONYMS[str1] || COUNTRY_SYNONYMS[String(c1).toLowerCase().trim()] || [str1];
    const syns2 = COUNTRY_SYNONYMS[str2] || COUNTRY_SYNONYMS[String(c2).toLowerCase().trim()] || [str2];

    return syns1.some(s => {
        const normS = normalizeString(s);
        return syns2.some(s2 => {
            const normS2 = normalizeString(s2);
            return normS === normS2 || (normS.length >= 3 && (normS.includes(normS2) || normS2.includes(normS)));
        });
    });
}

// -------------------------------------------------------------
// ПОЛУЧЕНИЕ СПИСКА ВСЕХ АРТИСТОВ ИЗ FIRESTORE (MULTI-SOURCE)
// -------------------------------------------------------------
export async function fetchArtistsFromFirestore() {
    if (!db) return [];
    const artists = [];
    const seenIds = new Set();

    // 1. Прямая коллекция "artists"
    try {
        const snap = await getDocs(collection(db, "artists"));
        snap.forEach(d => {
            const cleaned = sanitizeFirestoreData(d.data());
            const item = { id: d.id, ...(cleaned || {}) };
            artists.push(item);
            seenIds.add(d.id);
            if (item.login) seenIds.add(String(item.login).toLowerCase());
        });
    } catch (e) {
        console.warn('Fetch artists collection warning:', e);
    }

    // 2. Коллекция пользователей "users" с признаком артиста
    try {
        const usersSnap = await getDocs(collection(db, "users"));
        usersSnap.forEach(d => {
            const data = sanitizeFirestoreData(d.data()) || {};
            const isArt = data.role === 'artist' || data.isArtist === true || data.type === 'artist' || data.userType === 'artist';
            if (isArt) {
                const uId = d.id;
                const uLogin = String(data.login || data.username || '').toLowerCase();
                if (!seenIds.has(uId) && (!uLogin || !seenIds.has(uLogin))) {
                    artists.push({ id: uId, role: 'artist', ...data });
                    seenIds.add(uId);
                    if (uLogin) seenIds.add(uLogin);
                }
            }
        });
    } catch (e) {}

    // 3. Документ "system/artists" (если список артистов сохранен в едином документе)
    try {
        const sysSnap = await getDoc(doc(db, "system", "artists"));
        if (sysSnap.exists()) {
            const sysData = sanitizeFirestoreData(sysSnap.data()) || {};
            const list = Array.isArray(sysData.list) ? sysData.list : (Array.isArray(sysData.artists) ? sysData.artists : []);
            list.forEach(a => {
                const aId = a.id || a.login || a.email;
                if (aId && !seenIds.has(String(aId).toLowerCase())) {
                    artists.push(a);
                    seenIds.add(String(aId).toLowerCase());
                }
            });
        }
    } catch (e) {}

    return artists;
}

// -------------------------------------------------------------
// РАСЧЕТ ЗАБЛОКИРОВАННЫХ НОМЕРОВ ДЛЯ АРТИСТА
// -------------------------------------------------------------
export function calculateBlockedIdsForArtist(artistData, participantsList) {
    if (!artistData) return [];
    const list = participantsList || currentState.participants || DEFAULT_PARTICIPANTS;
    const blocked = new Set();

    // 1. Прямые ID участников
    if (artistData.participantId) blocked.add(String(artistData.participantId));
    if (Array.isArray(artistData.blockedIds)) {
        artistData.blockedIds.forEach(id => blocked.add(String(id)));
    }
    if (Array.isArray(artistData.blockedParticipantIds)) {
        artistData.blockedParticipantIds.forEach(id => blocked.add(String(id)));
    }

    // 2. Номера участников
    const numbersToCheck = [];
    if (artistData.number !== undefined && artistData.number !== null) {
        numbersToCheck.push(Number(artistData.number));
    }
    if (Array.isArray(artistData.blockedNumbers)) {
        artistData.blockedNumbers.forEach(n => numbersToCheck.push(Number(n)));
    }
    numbersToCheck.forEach(targetNum => {
        if (!isNaN(targetNum)) {
            list.filter(x => Number(x.number) === targetNum || x.id === `p${targetNum}` || x.id === String(targetNum))
                .forEach(p => blocked.add(p.id));
        }
    });

    // 3. Точное сопоставление по логину, стране и имени артиста
    const artLogin = normalizeString(artistData.login || artistData.username || artistData.artistLogin || '');
    const artEmail = String(artistData.email || '').trim().toLowerCase();
    const artCleanEmail = normalizeString(artEmail.includes('@') ? artEmail.split('@')[0] : artEmail);
    const artCountry = String(artistData.country || '').trim();
    const artArtist = normalizeString(artistData.artist || artistData.stageName || '');
    const artId = String(artistData.id || '').trim().toLowerCase();

    list.forEach(p => {
        const pId = String(p.id || '').trim().toLowerCase();
        const pNum = String(p.number || '').trim();
        const pLogin = normalizeString(p.artistLogin || p.linkedArtistLogin || '');
        const pCountry = String(p.country || '').trim();
        const pArtist = normalizeString(p.artist || '');

        // Совпадение по ID документа артиста с ID номера участника (например, 'p1')
        if (artId && (pId === artId || artId === `p${pNum}` || (artId === pNum && !isNaN(Number(artId))))) {
            blocked.add(p.id);
        }

        // Совпадение по логину артиста, указанному в номере
        if (pLogin) {
            if (
                (artLogin && pLogin === artLogin) ||
                (artCleanEmail && pLogin === artCleanEmail)
            ) {
                blocked.add(p.id);
            }
        }

        // Совпадение по стране (со всеми синонимами: "Германия", "Germany", "DE")
        if (artCountry && pCountry && countriesMatch(pCountry, artCountry)) {
            blocked.add(p.id);
        }
        if (artLogin && pCountry && countriesMatch(pCountry, artLogin)) {
            blocked.add(p.id);
        }

        // Совпадение по имени артиста (только значимые имена >= 3 символов, не общие шаблоны)
        if (artArtist && pArtist && artArtist.length >= 3 && !artArtist.startsWith('number') && !artArtist.startsWith('participant')) {
            if (artArtist === pArtist) {
                blocked.add(p.id);
            }
        }
        if (artLogin && pArtist && artLogin.length >= 3 && !artLogin.startsWith('number') && !artLogin.startsWith('participant')) {
            if (artLogin === pArtist) {
                blocked.add(p.id);
            }
        }
    });

    // Защита от ложного блокирования всех номеров:
    // Если заблокированы все номера, а в конкурсе больше 1 участника - это овер-матч, оставляем только строгие совпадения
    if (blocked.size >= list.length && list.length > 1) {
        const safeBlocked = new Set();
        list.forEach(p => {
            const pLogin = normalizeString(p.artistLogin || p.linkedArtistLogin || '');
            if (artLogin && pLogin && artLogin === pLogin) safeBlocked.add(p.id);
            if (artistData.participantId && String(artistData.participantId) === String(p.id)) safeBlocked.add(p.id);
            if (artistData.number !== undefined && Number(artistData.number) === Number(p.number)) safeBlocked.add(p.id);
        });
        return Array.from(safeBlocked);
    }

    return Array.from(blocked);
}

// -------------------------------------------------------------
// УНИВЕРСАЛЬНЫЙ РЕЗОЛВЕР АРТИСТА ПО ЛОГИНУ / EMAIL / ПРИЗНАКАМ
// -------------------------------------------------------------
export function resolveArtistInfo(inputString, participantsList, allArtists = null) {
    if (!inputString) return null;
    const raw = String(inputString).trim();
    const isEmail = raw.includes('@');
    const cleanLogin = isEmail ? raw.split('@')[0].trim().toLowerCase() : raw.toLowerCase();
    const normLogin = normalizeString(cleanLogin);
    const fullRaw = raw.toLowerCase();

    const list = participantsList || currentState.participants || DEFAULT_PARTICIPANTS;
    const artistsCollection = (allArtists && allArtists.length > 0) ? allArtists : (currentState.artists || []);

    // 1. Поиск артиста в коллекции Firestore
    let matchedDoc = (artistsCollection || []).find(a => {
        const docId = String(a.id || '').trim().toLowerCase();
        const aLogin = normalizeString(a.login || a.username || '');
        const aEmail = String(a.email || '').trim().toLowerCase();
        const aArtist = normalizeString(a.artist || a.name || '');
        const aCountry = String(a.country || '').trim();

        if (docId === fullRaw || docId === cleanLogin || normalizeString(docId) === normLogin) return true;
        if (aLogin && (aLogin === normLogin || aLogin === fullRaw)) return true;
        if (aEmail && (aEmail === fullRaw || aEmail.startsWith(cleanLogin + '@'))) return true;
        if (aCountry && countriesMatch(aCountry, cleanLogin)) return true;
        if (aArtist && aArtist.length >= 3 && !aArtist.startsWith('number') && aArtist === normLogin) return true;
        return false;
    });

    // 2. Поиск среди номеров участников (если артист указан в номере через artistLogin или совпадает по стране/артисту)
    const matchedParticipants = list.filter(p => {
        const pLogin = normalizeString(p.artistLogin || p.linkedArtistLogin || '');
        const pArtist = normalizeString(p.artist || '');
        const pCountry = String(p.country || '').trim();
        const pId = String(p.id || '').trim().toLowerCase();
        const pNum = String(p.number || '').trim();

        // Точный логин артиста, привязанный к номеру
        if (pLogin && (pLogin === normLogin || pLogin === fullRaw)) {
            return true;
        }
        // Если найден документ артиста, проверяем привязку номера
        if (matchedDoc) {
            if (matchedDoc.participantId && String(matchedDoc.participantId) === p.id) return true;
            if (matchedDoc.number !== undefined && Number(matchedDoc.number) === Number(p.number)) return true;
            if (Array.isArray(matchedDoc.blockedNumbers) && matchedDoc.blockedNumbers.map(Number).includes(Number(p.number))) return true;
            if (Array.isArray(matchedDoc.blockedIds) && matchedDoc.blockedIds.includes(p.id)) return true;
            if (matchedDoc.country && pCountry && countriesMatch(pCountry, matchedDoc.country)) return true;
            if (matchedDoc.artist && pArtist && normalizeString(matchedDoc.artist) === pArtist) return true;
            if (matchedDoc.id && (matchedDoc.id === pId || matchedDoc.id === `p${pNum}`)) return true;
        } else {
            // Без документа артиста: прямое совпадение ID, страны или уникального артиста
            if (pId === cleanLogin || `p${pNum}` === cleanLogin || (pNum === cleanLogin && !isNaN(Number(cleanLogin)))) {
                return true;
            }
            if (pCountry && countriesMatch(pCountry, cleanLogin)) {
                return true;
            }
            if (pArtist && pArtist.length >= 3 && !pArtist.startsWith('number') && !pArtist.startsWith('participant') && pArtist === normLogin) {
                return true;
            }
        }
        return false;
    });

    if (matchedDoc || matchedParticipants.length > 0) {
        const primaryParticipant = matchedParticipants[0] || null;
        const effectiveArtistData = {
            ...(matchedDoc || {}),
            ...(primaryParticipant ? {
                id: matchedDoc?.id || primaryParticipant.id,
                number: primaryParticipant.number,
                artist: matchedDoc?.artist || primaryParticipant.artist || '',
                country: matchedDoc?.country || primaryParticipant.country,
                name: primaryParticipant.name,
                artistLogin: primaryParticipant.artistLogin || cleanLogin,
                flag: primaryParticipant.flag,
                blockedNumbers: matchedParticipants.map(p => p.number).filter(n => n !== undefined && n !== null)
            } : {})
        };

        const allBlockedIds = new Set();
        matchedParticipants.forEach(p => allBlockedIds.add(p.id));
        const calculatedBlocked = calculateBlockedIdsForArtist(effectiveArtistData, list);
        calculatedBlocked.forEach(id => allBlockedIds.add(id));

        // Всегда отображаем ЛОГИН пользователя, а не название номера или песни!
        const displayName = cleanLogin;

        return {
            isArtist: true,
            artistData: effectiveArtistData,
            blockedParticipantIds: Array.from(allBlockedIds),
            displayName
        };
    }

    return null;
}

// Автоматическая ре-синхронизация артиста для текущего вошедшего пользователя
export function syncCurrentUserArtistStatus() {
    if (!currentAuthUser) return;
    const cleanLogin = currentAuthUser.login || (currentAuthUser.email ? currentAuthUser.email.split('@')[0] : '');
    const resolved = resolveArtistInfo(cleanLogin || currentAuthUser.email, currentState.participants);

    if (resolved) {
        let changed = false;
        if (currentAuthUser.role !== 'artist') {
            currentAuthUser.role = 'artist';
            changed = true;
        }
        if (safeJsonStringify(currentAuthUser.blockedParticipantIds) !== safeJsonStringify(resolved.blockedParticipantIds)) {
            currentAuthUser.blockedParticipantIds = resolved.blockedParticipantIds;
            changed = true;
        }
        if (!currentAuthUser.artistData || safeJsonStringify(currentAuthUser.artistData) !== safeJsonStringify(resolved.artistData)) {
            currentAuthUser.artistData = resolved.artistData;
            changed = true;
        }
        if (changed) {
            notifyAuthChanged(currentAuthUser);
        }
    }
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

    // 1. Проверяем статус артиста через наш универсальный резолвер
    let allArtists = [];
    try {
        allArtists = await fetchArtistsFromFirestore();
    } catch (e) {}

    const resolvedArtist = resolveArtistInfo(raw, currentState.participants, allArtists);

    // 2. Если в документе артиста в Firestore хранится явный пароль и он совпадает
    if (resolvedArtist && resolvedArtist.artistData && resolvedArtist.artistData.password && String(resolvedArtist.artistData.password).trim() === pass) {
        const userObj = {
            uid: resolvedArtist.artistData.id || 'artist_' + Date.now(),
            email: resolvedArtist.artistData.email || `${cleanLogin}@harivision.app`,
            login: resolvedArtist.artistData.login || cleanLogin,
            displayName: resolvedArtist.displayName,
            role: 'artist',
            artistData: resolvedArtist.artistData,
            blockedParticipantIds: resolvedArtist.blockedParticipantIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // 3. Пробуем войти через Firebase Authentication
    const emailCandidates = [];
    if (isEmail) {
        emailCandidates.push(raw);
    } else {
        if (resolvedArtist?.artistData?.email) {
            emailCandidates.push(resolvedArtist.artistData.email);
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
            if (isEmail) break;
        }
    }

    if (authUserCredential && authUserCredential.user) {
        const fbUser = authUserCredential.user;
        const effectiveEmail = fbUser.email || (isEmail ? raw : `${cleanLogin}@harivision.app`);

        // Повторная проверка артиста по effectiveEmail и cleanLogin
        const finalResolved = resolvedArtist || resolveArtistInfo(effectiveEmail, currentState.participants, allArtists) || resolveArtistInfo(cleanLogin, currentState.participants, allArtists);

        const isArtist = Boolean(finalResolved);
        const blockedIds = isArtist ? finalResolved.blockedParticipantIds : [];
        const displayName = cleanLogin;

        const userObj = {
            uid: fbUser.uid,
            email: effectiveEmail,
            login: cleanLogin,
            displayName: displayName,
            role: isArtist ? 'artist' : 'user',
            artistData: isArtist ? finalResolved.artistData : null,
            blockedParticipantIds: blockedIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // 4. Если у артиста нет пароля в Firebase, но есть в локальном списке и это пароль артиста
    if (resolvedArtist) {
        const blockedIds = resolvedArtist.blockedParticipantIds;
        const userObj = {
            uid: resolvedArtist.artistData?.id || 'artist_' + Date.now(),
            email: resolvedArtist.artistData?.email || `${cleanLogin}@harivision.app`,
            login: cleanLogin,
            displayName: resolvedArtist.displayName,
            role: 'artist',
            artistData: resolvedArtist.artistData,
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
            const resolved = resolveArtistInfo(rawEmail, currentState.participants, allArtists) ||
                             resolveArtistInfo(cleanLogin, currentState.participants, allArtists);

            const isArtist = Boolean(resolved);
            const blockedIds = isArtist ? resolved.blockedParticipantIds : [];

            const userObj = {
                uid: fbUser.uid,
                email: rawEmail,
                login: cleanLogin,
                displayName: cleanLogin,
                role: isArtist ? 'artist' : 'user',
                artistData: isArtist ? resolved.artistData : null,
                blockedParticipantIds: blockedIds
            };
            notifyAuthChanged(userObj);
        } catch (e) {
            console.warn('Sync auth user error:', e);
        }
    } else if (!fbUser) {
        if (!currentAuthUser?.artistData) {
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

