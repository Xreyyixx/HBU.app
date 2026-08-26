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

        // 5. Contests (Single source of truth in Firestore: collection "contests" & doc "system/contests")
        try {
            let contestItems = [];
            
            // 5.1 Check system/contests document
            try {
                const sysContestSnap = await getDoc(doc(db, "system", "contests"));
                if (sysContestSnap.exists()) {
                    const sysCData = sanitizeFirestoreData(sysContestSnap.data());
                    if (sysCData && Array.isArray(sysCData.list) && sysCData.list.length > 0) {
                        contestItems = sysCData.list;
                    }
                }
            } catch (e) {}

            // 5.2 Check collection "contests"
            if (contestItems.length === 0) {
                const contestSnap = await getDocs(collection(db, "contests"));
                contestSnap.forEach(d => {
                    const cleaned = sanitizeFirestoreData(d.data());
                    contestItems.push({ id: d.id, ...(cleaned || {}) });
                });
            }

            if (contestItems.length > 0) {
                if (safeJsonStringify(currentState.contests) !== safeJsonStringify(contestItems)) {
                    currentState.contests = contestItems;
                    stateChanged = true;
                }
            } else if (currentState.contests && currentState.contests.length > 0) {
                // Seed to Firestore if empty
                setDoc(doc(db, "system", "contests"), { list: currentState.contests, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
                for (const c of currentState.contests) {
                    setDoc(doc(db, "contests", c.id), c, { merge: true }).catch(() => {});
                }
            }
        } catch (e) {
            console.warn('Contests fetch error:', e);
        }

function mergeVotes(current, incoming) {
    if (!Array.isArray(incoming)) return Array.isArray(current) ? current : [];
    if (!Array.isArray(current) || current.length === 0) return incoming;

    const map = new Map();
    current.forEach(v => {
        if (v && v.id) map.set(String(v.id), v);
    });
    incoming.forEach(v => {
        if (v && v.id) {
            const idKey = String(v.id);
            map.set(idKey, { ...(map.get(idKey) || {}), ...v });
        }
    });
    return Array.from(map.values());
}

        // 6. Votes Collection
        try {
            const votesSnap = await getDocs(collection(db, "votes"));
            const votesList = [];
            votesSnap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                votesList.push({ id: d.id, ...(cleaned || {}) });
            });
            if (votesList.length > 0) {
                const merged = mergeVotes(currentState.votes || [], votesList);
                if (safeJsonStringify(currentState.votes) !== safeJsonStringify(merged)) {
                    currentState.votes = merged;
                    stateChanged = true;
                }
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
                        const newData = parsed.data;
                        if (Array.isArray(newData.votes)) {
                            currentState.votes = newData.votes;
                        }
                        currentState = { ...currentState, ...newData };
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

    // E1. Contests Real-time Listener (System document "system/contests")
    try {
        onSnapshot(doc(db, "system", "contests"), (snap) => {
            if (snap.exists()) {
                const sysCData = sanitizeFirestoreData(snap.data());
                if (sysCData && Array.isArray(sysCData.list) && sysCData.list.length > 0) {
                    currentState.contests = sysCData.list;
                    notifyStateChanged(false);
                    syncCurrentUserArtistStatus();
                }
            }
        }, (err) => console.warn('Firestore system/contests error:', err));
    } catch (e) {}

    // E2. Contests Collection Real-time Listener
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
        }, (err) => console.warn('Firestore contests collection error:', err));
    } catch (e) {}

    // F. Votes Real-time Listener (Admin live tally)
    try {
        onSnapshot(collection(db, "votes"), (snap) => {
            const votesList = [];
            snap.forEach(d => {
                const cleaned = sanitizeFirestoreData(d.data());
                votesList.push({ id: d.id, ...(cleaned || {}) });
            });
            if (votesList.length > 0) {
                const merged = mergeVotes(currentState.votes || [], votesList);
                if (safeJsonStringify(currentState.votes) !== safeJsonStringify(merged)) {
                    currentState.votes = merged;
                    notifyStateChanged(false);
                }
            }
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
            if (data && typeof data === 'object') {
                let updated = false;

                // Sync votingState
                if (data.votingState && typeof data.votingState === 'object') {
                    if (safeJsonStringify(currentState.votingState) !== safeJsonStringify(data.votingState)) {
                        currentState.votingState = { ...currentState.votingState, ...data.votingState };
                        updated = true;
                    }
                }

                // Sync participants
                if (Array.isArray(data.participants) && data.participants.length > 0) {
                    if (safeJsonStringify(currentState.participants) !== safeJsonStringify(data.participants)) {
                        currentState.participants = data.participants;
                        updated = true;
                    }
                }

                // Sync news
                if (Array.isArray(data.news) && data.news.length > 0) {
                    if (safeJsonStringify(currentState.news) !== safeJsonStringify(data.news)) {
                        currentState.news = data.news;
                        updated = true;
                    }
                }

                // Sync contests
                if (Array.isArray(data.contests) && data.contests.length > 0) {
                    if (safeJsonStringify(currentState.contests) !== safeJsonStringify(data.contests)) {
                        currentState.contests = data.contests;
                        updated = true;
                    }
                }

                // Sync settings
                if (data.recapVideoUrl !== undefined && currentState.recapVideoUrl !== data.recapVideoUrl) {
                    currentState.recapVideoUrl = data.recapVideoUrl;
                    updated = true;
                }
                if (data.featuredContestId !== undefined && currentState.featuredContestId !== data.featuredContestId) {
                    currentState.featuredContestId = data.featuredContestId;
                    updated = true;
                }
                if (data.manualThreshold !== undefined && currentState.manualThreshold !== data.manualThreshold) {
                    currentState.manualThreshold = data.manualThreshold;
                    updated = true;
                }
                if (data.revealMode !== undefined && currentState.revealMode !== data.revealMode) {
                    currentState.revealMode = data.revealMode;
                    updated = true;
                }

                // Sync votes directly from server
                if (Array.isArray(data.votes)) {
                    if (safeJsonStringify(currentState.votes) !== safeJsonStringify(data.votes)) {
                        currentState.votes = data.votes;
                        updated = true;
                    }
                }

                if (updated || isInitial) {
                    notifyStateChanged(isInitial);
                }
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
            body: safeJsonStringify(article)
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

    // Save to Firestore (Single collection "contests" + system/contests document for instant multi-device sync)
    try {
        await Promise.all([
            setDoc(doc(db, "contests", contest.id), contest, { merge: true }),
            setDoc(doc(db, "system", "contests"), { list: currentState.contests, updatedAt: new Date().toISOString() }, { merge: true })
        ]);
    } catch (e) {
        console.warn('Firestore save contest error:', e);
    }

    // Save to REST API if available
    try {
        const res = await fetch('/api/contests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify(contest)
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

    // Delete from Firestore & update system/contests
    try {
        await Promise.all([
            deleteDoc(doc(db, "contests", contestId)),
            setDoc(doc(db, "system", "contests"), { list: currentState.contests, updatedAt: new Date().toISOString() }, { merge: true })
        ]);
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
            body: safeJsonStringify(participant)
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
            body: safeJsonStringify(stateUpdate)
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
    if (user) {
        try {
            const jsonStr = safeJsonStringify(user);
            currentAuthUser = jsonStr ? JSON.parse(jsonStr) : null;
        } catch (e) {
            currentAuthUser = {
                uid: String(user.uid || ''),
                email: String(user.email || ''),
                login: String(user.login || user.displayName || ''),
                displayName: String(user.displayName || user.login || ''),
                role: user.role || 'user',
                blockedParticipantIds: Array.isArray(user.blockedParticipantIds) ? user.blockedParticipantIds : []
            };
        }
    } else {
        currentAuthUser = null;
    }

    try {
        if (currentAuthUser) {
            localStorage.setItem(LOCAL_STORAGE_USER_KEY, safeJsonStringify(currentAuthUser));
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

function transliterateRuToEn(text) {
    if (!text) return '';
    const ruToEn = {
        'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh',
        'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
        'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'ts',
        'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya'
    };
    return String(text)
        .toLowerCase()
        .split('')
        .map(char => ruToEn[char] !== undefined ? ruToEn[char] : char)
        .join('');
}

function transliterateEnToRu(text) {
    if (!text) return '';
    const map = [
        ['sch', 'щ'], ['sh', 'ш'], ['ch', 'ч'], ['ts', 'ц'], ['zh', 'ж'],
        ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я'], ['ph', 'ф'], ['kh', 'х'],
        ['victoria', 'виктория'], ['viktoria', 'виктория'], ['rodion', 'родион'],
        ['anna', 'анна'], ['ornella', 'орнелла'], ['dmitry', 'дмитрий'],
        ['a', 'а'], ['b', 'б'], ['v', 'в'], ['w', 'в'], ['g', 'г'], ['d', 'д'],
        ['e', 'е'], ['z', 'з'], ['i', 'и'], ['j', 'й'], ['y', 'й'], ['k', 'к'],
        ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'],
        ['s', 'с'], ['t', 'т'], ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'],
        ['x', 'кс'], ['q', 'к']
    ];
    let res = String(text).toLowerCase();
    for (const [en, ru] of map) {
        res = res.replaceAll(en, ru);
    }
    return res;
}

function normalizeString(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9\s]/gi, ' ')
        .trim();
}

// Известные псевдонимы и транслитерации артистов
const KNOWN_ARTIST_ALIASES = {
    'rodion': ['родион', 'rodion', 'radion', 'родион в'],
    'родион': ['родион', 'rodion', 'radion', 'родион в'],
    'anna': ['анна', 'anna', 'anechka', 'анна м'],
    'анна': ['анна', 'anna', 'anechka', 'анна м'],
    'victoria': ['виктория', 'victoria', 'viktoria', 'viktoriya', 'викториа', 'виктория к'],
    'viktoria': ['виктория', 'victoria', 'viktoria', 'viktoriya', 'викториа', 'виктория к'],
    'виктория': ['виктория', 'victoria', 'viktoria', 'viktoriya', 'викториа', 'виктория к'],
    'ornella': ['орнелла', 'ornella', 'ornela', 'орнелла с'],
    'орнелла': ['орнелла', 'ornella', 'ornela', 'орнелла с']
};

function getNormalizedVariants(rawStr) {
    if (!rawStr) return [];
    const base = normalizeString(rawStr);
    const set = new Set();
    if (base) set.add(base);

    // Добавляем очищенные от пробелов
    const noSpace = base.replace(/\s+/g, '');
    if (noSpace) set.add(noSpace);

    // Прямые алиасы из словаря
    if (KNOWN_ARTIST_ALIASES[noSpace]) {
        KNOWN_ARTIST_ALIASES[noSpace].forEach(a => {
            set.add(a);
            set.add(normalizeString(a));
        });
    }

    // Транслитерация Ru -> En
    const enTrans = normalizeString(transliterateRuToEn(rawStr));
    if (enTrans) {
        set.add(enTrans);
        set.add(enTrans.replace(/\s+/g, ''));
        if (KNOWN_ARTIST_ALIASES[enTrans]) {
            KNOWN_ARTIST_ALIASES[enTrans].forEach(a => set.add(normalizeString(a)));
        }
    }

    // Транслитерация En -> Ru
    const ruTrans = normalizeString(transliterateEnToRu(rawStr));
    if (ruTrans) {
        set.add(ruTrans);
        set.add(ruTrans.replace(/\s+/g, ''));
        if (KNOWN_ARTIST_ALIASES[ruTrans]) {
            KNOWN_ARTIST_ALIASES[ruTrans].forEach(a => set.add(normalizeString(a)));
        }
    }

    return Array.from(set);
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
}// -------------------------------------------------------------
// ПРОВЕРКА РОЛИ АРТИСТА (УНИВЕРСАЛЬНАЯ)
// -------------------------------------------------------------
export function isUserArtist(data) {
    if (!data || typeof data !== 'object') return false;
    const roleStr = String(data.role || data.userType || data.type || '').trim().toLowerCase();
    if (roleStr === 'artist') return true;
    if (data.isArtist === true || data.artistRole === true || data.is_artist === true) return true;
    return false;
}

// -------------------------------------------------------------
// ПОЛУЧЕНИЕ СПИСКА ВСЕХ АРТИСТОВ ИЗ FIRESTORE (MULTI-SOURCE)
// -------------------------------------------------------------
export async function fetchArtistsFromFirestore() {
    const artists = [];
    const seenLogins = new Set();

    if (!db) return artists;

    // 1. Прямая коллекция "artists"
    try {
        const snap = await getDocs(collection(db, "artists"));
        snap.forEach(d => {
            const cleaned = sanitizeFirestoreData(d.data());
            const item = { id: d.id, role: 'artist', ...(cleaned || {}) };
            const lKey = String(item.login || item.username || item.id).toLowerCase();
            if (!seenLogins.has(lKey)) {
                artists.push(item);
                seenLogins.add(lKey);
            }
            if (item.email) seenLogins.add(String(item.email).toLowerCase());
        });
    } catch (e) {
        console.warn('Fetch artists collection warning:', e);
    }

    // 2. Коллекция пользователей "users" с признаком артиста
    try {
        const usersSnap = await getDocs(collection(db, "users"));
        usersSnap.forEach(d => {
            const data = sanitizeFirestoreData(d.data()) || {};
            const isArt = isUserArtist(data);
            const uLogin = String(data.login || data.username || data.displayName || d.id).toLowerCase();
            if (isArt || seenLogins.has(uLogin)) {
                if (!seenLogins.has(uLogin)) {
                    artists.push({ id: d.id, role: 'artist', ...data });
                    seenLogins.add(uLogin);
                }
            }
        });
    } catch (e) {}

    // 3. Документ "system/artists"
    try {
        const sysSnap = await getDoc(doc(db, "system", "artists"));
        if (sysSnap.exists()) {
            const sysData = sanitizeFirestoreData(sysSnap.data()) || {};
            const list = Array.isArray(sysData.list) ? sysData.list : (Array.isArray(sysData.artists) ? sysData.artists : []);
            list.forEach(a => {
                const aId = String(a.id || a.login || a.email || '').toLowerCase();
                if (aId && !seenLogins.has(aId)) {
                    artists.push({ ...a, role: 'artist' });
                    seenLogins.add(aId);
                }
            });
        }
    } catch (e) {}

    return artists;
}

// Получение профиля пользователя напрямую из Firestore (users/{uid}, artists/{uid}, etc.)
export async function getFullUserProfileFromFirestore(uid, email = '', login = '') {
    if (!db || !uid) return null;
    let docData = null;
    let isArtist = false;

    // 1. Читаем users/{uid}
    try {
        const userSnap = await getDoc(doc(db, "users", uid));
        if (userSnap.exists()) {
            docData = { ...sanitizeFirestoreData(userSnap.data()), id: uid };
            if (isUserArtist(docData)) {
                isArtist = true;
            }
        }
    } catch (e) {}

    // 2. Читаем artists/{uid} или artists/{login}
    try {
        const artistSnap = await getDoc(doc(db, "artists", uid));
        if (artistSnap.exists()) {
            const artData = sanitizeFirestoreData(artistSnap.data());
            docData = { ...(docData || {}), ...artData, id: uid, role: 'artist' };
            isArtist = true;
        } else if (login) {
            const artistSnapLogin = await getDoc(doc(db, "artists", login.toLowerCase()));
            if (artistSnapLogin.exists()) {
                const artData = sanitizeFirestoreData(artistSnapLogin.data());
                docData = { ...(docData || {}), ...artData, id: uid, role: 'artist' };
                isArtist = true;
            }
        }
    } catch (e) {}

    if (!docData) return null;

    return {
        ...docData,
        isArtist,
        role: isArtist ? 'artist' : 'user'
    };
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
    const rawLogin = String(artistData.login || artistData.username || artistData.artistLogin || artistData.id || '').trim();
    const artVariants = getNormalizedVariants(rawLogin);
    const artEmail = String(artistData.email || '').trim().toLowerCase();
    const artCleanEmail = normalizeString(artEmail.includes('@') ? artEmail.split('@')[0] : artEmail);
    if (artCleanEmail) artVariants.push(artCleanEmail);
    const artCountry = String(artistData.country || '').trim();
    const artArtist = normalizeString(artistData.artist || artistData.stageName || artistData.name || '');
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
            if (artVariants.includes(pLogin) || (artCleanEmail && pLogin === artCleanEmail)) {
                blocked.add(p.id);
            }
        }

        // Совпадение по стране (со всеми синонимами: "Германия", "Germany", "DE")
        if (artCountry && pCountry && countriesMatch(pCountry, artCountry)) {
            blocked.add(p.id);
        }
        if (artVariants.some(v => pCountry && countriesMatch(pCountry, v))) {
            blocked.add(p.id);
        }

        // Совпадение по имени артиста
        if (pArtist && pArtist.length >= 3 && !pArtist.startsWith('number') && !pArtist.startsWith('participant')) {
            if (artArtist && (artArtist === pArtist || isFuzzyMatch(artArtist, pArtist))) {
                blocked.add(p.id);
            }
            if (artVariants.some(v => v === pArtist || (v.length >= 3 && (v.startsWith(pArtist) || pArtist.startsWith(v))))) {
                blocked.add(p.id);
            }
        }
    });

    // Защита от ложного блокирования всех номеров:
    if (blocked.size >= list.length && list.length > 1) {
        const safeBlocked = new Set();
        list.forEach(p => {
            const pLogin = normalizeString(p.artistLogin || p.linkedArtistLogin || '');
            if (artVariants.includes(pLogin)) safeBlocked.add(p.id);
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

    // 1. Поиск артиста в коллекции Firestore (с учетом транслитерации и частичных совпадений)
    const loginVariants = getNormalizedVariants(cleanLogin);
    if (raw && !loginVariants.includes(normalizeString(raw))) {
        loginVariants.push(normalizeString(raw));
    }

    let matchedDoc = (artistsCollection || []).find(a => {
        const docId = String(a.id || '').trim().toLowerCase();
        const aLogin = normalizeString(a.login || a.username || '');
        const aEmail = String(a.email || '').trim().toLowerCase();
        const aArtist = normalizeString(a.artist || a.name || a.stageName || a.title || '');
        const aCountry = String(a.country || '').trim();

        // 1.1 Прямое совпадение по ID документа или логину
        if (docId === fullRaw || docId === cleanLogin || normalizeString(docId) === normLogin) return true;
        if (loginVariants.some(v => v === normalizeString(docId) || v === docId)) return true;
        if (aLogin && loginVariants.some(v => v === aLogin)) return true;
        if (aEmail && (aEmail === fullRaw || aEmail.startsWith(cleanLogin + '@') || aEmail.includes(cleanLogin))) return true;

        // 1.2 Совпадение по имени артиста (включая транслитерацию)
        if (aArtist) {
            const artistVariants = getNormalizedVariants(a.artist || a.name || a.stageName || a.title || '');
            if (loginVariants.some(lv => artistVariants.some(av => lv === av || (lv.length >= 3 && av.length >= 3 && (lv.startsWith(av) || av.startsWith(lv)))))) {
                return true;
            }
        }

        // 1.3 Совпадение по стране
        if (aCountry && countriesMatch(aCountry, cleanLogin)) return true;

        return false;
    });

    // 2. Поиск среди номеров участников
    const matchedParticipants = list.filter(p => {
        const pLogin = normalizeString(p.artistLogin || p.linkedArtistLogin || '');
        const pArtist = normalizeString(p.artist || '');
        const pCountry = String(p.country || '').trim();
        const pId = String(p.id || '').trim().toLowerCase();
        const pNum = String(p.number || '').trim();

        // Точный логин артиста, привязанный к номеру
        if (pLogin && (pLogin === normLogin || pLogin === fullRaw || loginVariants.includes(pLogin))) {
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
            if (pArtist && pArtist.length >= 3 && !pArtist.startsWith('number') && !pArtist.startsWith('participant')) {
                if (pArtist === normLogin || loginVariants.includes(pArtist)) {
                    return true;
                }
            }
        }
        return false;
    });

    // 3. Если найден документ артиста или привязанный номер участника
    if (matchedDoc || matchedParticipants.length > 0) {
        const primaryParticipant = matchedParticipants[0] || null;
        const effectiveArtistData = {
            id: matchedDoc?.id || cleanLogin,
            login: matchedDoc?.login || cleanLogin,
            name: matchedDoc?.name || matchedDoc?.artist || primaryParticipant?.artist || cleanLogin,
            artist: matchedDoc?.artist || primaryParticipant?.artist || cleanLogin,
            role: 'artist',
            ...(matchedDoc || {}),
            ...(primaryParticipant ? {
                id: matchedDoc?.id || primaryParticipant.id,
                number: primaryParticipant.number,
                artist: matchedDoc?.artist || primaryParticipant.artist || '',
                country: matchedDoc?.country || primaryParticipant.country,
                artistLogin: primaryParticipant.artistLogin || cleanLogin,
                flag: primaryParticipant.flag,
                blockedNumbers: matchedParticipants.map(p => p.number).filter(n => n !== undefined && n !== null)
            } : {})
        };

        const allBlockedIds = new Set();
        matchedParticipants.forEach(p => allBlockedIds.add(p.id));
        const calculatedBlocked = calculateBlockedIdsForArtist(effectiveArtistData, list);
        calculatedBlocked.forEach(id => allBlockedIds.add(id));

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
export async function syncCurrentUserArtistStatus() {
    if (!currentAuthUser) return;
    const cleanLogin = currentAuthUser.login || (currentAuthUser.email ? currentAuthUser.email.split('@')[0] : '');
    
    // 1. Проверяем профиль в Firestore
    let fsProfile = null;
    if (currentAuthUser.uid) {
        try {
            fsProfile = await getFullUserProfileFromFirestore(currentAuthUser.uid, currentAuthUser.email, cleanLogin);
        } catch (e) {}
    }

    const isArt = isUserArtist(currentAuthUser) || isUserArtist(fsProfile) || isUserArtist(currentAuthUser.artistData);
    const resolved = resolveArtistInfo(cleanLogin || currentAuthUser.email, currentState.participants);

    if (isArt || resolved) {
        let changed = false;
        if (currentAuthUser.role !== 'artist') {
            currentAuthUser.role = 'artist';
            changed = true;
        }

        const mergedArtistData = {
            login: cleanLogin,
            role: 'artist',
            ...(resolved?.artistData || {}),
            ...(fsProfile || {}),
            ...(currentAuthUser.artistData || {})
        };

        const blockedIds = Array.from(new Set([
            ...(resolved ? resolved.blockedParticipantIds : []),
            ...calculateBlockedIdsForArtist(mergedArtistData, currentState.participants)
        ]));

        if (safeJsonStringify(currentAuthUser.blockedParticipantIds) !== safeJsonStringify(blockedIds)) {
            currentAuthUser.blockedParticipantIds = blockedIds;
            changed = true;
        }
        if (!currentAuthUser.artistData || safeJsonStringify(currentAuthUser.artistData) !== safeJsonStringify(mergedArtistData)) {
            currentAuthUser.artistData = mergedArtistData;
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
    const cleanLogin = isEmail ? raw.split('@')[0].toLowerCase() : raw.toLowerCase();

    // 1. Проверяем статус артиста через наш универсальный резолвер
    let allArtists = [];
    try {
        allArtists = await fetchArtistsFromFirestore();
    } catch (e) {}

    const resolvedArtist = resolveArtistInfo(raw, currentState.participants, allArtists);

    // 2. Если в документе артиста в Firestore хранится явный пароль и он совпадает
    if (resolvedArtist && resolvedArtist.artistData && resolvedArtist.artistData.password && String(resolvedArtist.artistData.password).trim() === pass) {
        const userObj = {
            uid: resolvedArtist.artistData.id || 'artist_' + cleanLogin,
            email: resolvedArtist.artistData.email || `${cleanLogin}@harivision.app`,
            login: resolvedArtist.artistData.login || cleanLogin,
            displayName: resolvedArtist.displayName || cleanLogin,
            role: 'artist',
            artistData: resolvedArtist.artistData,
            blockedParticipantIds: resolvedArtist.blockedParticipantIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // 3. Пробуем найти реальный email пользователя в Firestore коллекции "users"
    let userFirestoreEmail = null;
    let userFirestoreRole = null;
    let userFirestoreDoc = null;
    try {
        if (db) {
            const usersSnap = await getDocs(collection(db, "users"));
            usersSnap.forEach(d => {
                const uData = d.data() || {};
                const uLogin = String(uData.login || uData.username || uData.displayName || '').trim().toLowerCase();
                const uEmail = String(uData.email || '').trim().toLowerCase();
                if (uLogin === cleanLogin || uEmail === raw.toLowerCase() || d.id.toLowerCase() === cleanLogin) {
                    userFirestoreDoc = { id: d.id, ...uData };
                    if (uData.email) userFirestoreEmail = uData.email;
                    if (uData.role) userFirestoreRole = uData.role;
                }
            });
        }
    } catch (e) {}

    // 4. Формируем список возможных email для Firebase Authentication
    const emailCandidates = [];
    if (isEmail) {
        emailCandidates.push(raw);
    }
    if (userFirestoreEmail && !emailCandidates.includes(userFirestoreEmail)) {
        emailCandidates.push(userFirestoreEmail);
    }
    if (resolvedArtist?.artistData?.email && !emailCandidates.includes(resolvedArtist.artistData.email)) {
        emailCandidates.push(resolvedArtist.artistData.email);
    }
    emailCandidates.push(`${cleanLogin}@harivision.app`);
    emailCandidates.push(`${cleanLogin}@harivision.org`);
    emailCandidates.push(`${cleanLogin}@gmail.com`);
    emailCandidates.push(`${cleanLogin}@mail.ru`);
    emailCandidates.push(`${cleanLogin}@yandex.ru`);

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

        // Читаем полный профиль из Firestore
        const userProfile = await getFullUserProfileFromFirestore(fbUser.uid, effectiveEmail, cleanLogin);

        // Повторная проверка артиста по effectiveEmail и cleanLogin
        const finalResolved = resolvedArtist || 
            resolveArtistInfo(effectiveEmail, currentState.participants, allArtists) || 
            resolveArtistInfo(cleanLogin, currentState.participants, allArtists);

        const isArtist = isUserArtist(userProfile) || isUserArtist(userFirestoreDoc) || Boolean(finalResolved) || String(userFirestoreRole || '').toLowerCase() === 'artist';

        const mergedArtistData = isArtist ? {
            id: fbUser.uid,
            login: cleanLogin,
            role: 'artist',
            ...(finalResolved?.artistData || {}),
            ...(userFirestoreDoc || {}),
            ...(userProfile || {})
        } : null;

        const blockedIds = isArtist ? Array.from(new Set([
            ...(finalResolved ? finalResolved.blockedParticipantIds : []),
            ...calculateBlockedIdsForArtist(mergedArtistData, currentState.participants)
        ])) : [];

        const displayName = cleanLogin;

        const userObj = {
            uid: fbUser.uid,
            email: effectiveEmail,
            login: cleanLogin,
            displayName: displayName,
            role: isArtist ? 'artist' : 'user',
            artistData: mergedArtistData,
            blockedParticipantIds: blockedIds
        };
        notifyAuthChanged(userObj);
        return userObj;
    }

    // 5. Если у артиста нет пароля в Firebase, но это известный артист из резолвера
    if (resolvedArtist) {
        const blockedIds = resolvedArtist.blockedParticipantIds;
        const userObj = {
            uid: resolvedArtist.artistData?.id || 'artist_' + cleanLogin,
            email: resolvedArtist.artistData?.email || `${cleanLogin}@harivision.app`,
            login: cleanLogin,
            displayName: resolvedArtist.displayName || cleanLogin,
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
    const cleanLogin = isEmail ? raw.split('@')[0].toLowerCase() : raw.toLowerCase();
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
            const cleanLogin = rawEmail.includes('@') ? rawEmail.split('@')[0].toLowerCase() : (fbUser.displayName || 'user').toLowerCase();
            
            // 1. Получаем профиль пользователя из Firestore
            const userProfile = await getFullUserProfileFromFirestore(fbUser.uid, rawEmail, cleanLogin);

            // 2. Проверяем статус артиста
            const allArtists = await fetchArtistsFromFirestore();
            const resolved = resolveArtistInfo(rawEmail, currentState.participants, allArtists) ||
                             resolveArtistInfo(cleanLogin, currentState.participants, allArtists);

            const isArtist = isUserArtist(userProfile) || Boolean(resolved);

            const mergedArtistData = isArtist ? {
                id: fbUser.uid,
                login: cleanLogin,
                role: 'artist',
                ...(resolved?.artistData || {}),
                ...(userProfile || {})
            } : null;

            const blockedIds = isArtist ? Array.from(new Set([
                ...(resolved ? resolved.blockedParticipantIds : []),
                ...calculateBlockedIdsForArtist(mergedArtistData, currentState.participants)
            ])) : [];

            const userObj = {
                uid: fbUser.uid,
                email: rawEmail,
                login: cleanLogin,
                displayName: cleanLogin,
                role: isArtist ? 'artist' : 'user',
                artistData: mergedArtistData,
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

    // 1. Optimistic local state update
    if (!currentState.votes) currentState.votes = [];
    const existIdx = currentState.votes.findIndex(v => v.id === voteId);
    if (existIdx >= 0) {
        currentState.votes[existIdx] = votePayload;
    } else {
        currentState.votes.push(votePayload);
    }
    notifyStateChanged(true);

    // 2. Save directly to Firestore for serverless / GitHub Pages compatibility
    try {
        if (db) {
            await setDoc(doc(db, "votes", voteId), votePayload);
        }
    } catch (e) {
        console.warn('Firestore direct vote submit error:', e);
    }

    // 3. Save to backend API
    try {
        const res = await fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify(votePayload)
        });
        if (res.ok) {
            const data = await res.json();
            if (data.votes && Array.isArray(data.votes)) {
                currentState.votes = data.votes;
                notifyStateChanged(true);
            }
            return data;
        }
    } catch (e) {
        console.warn('API vote submit warning:', e);
    }

    return { success: true, vote: votePayload };
}

export async function deleteVote(voteId) {
    currentState.votes = (currentState.votes || []).filter(v => String(v.id) !== String(voteId));
    notifyStateChanged(true);

    try {
        await deleteDoc(doc(db, "votes", String(voteId)));
    } catch (e) {
        console.warn('Firestore delete vote error:', e);
    }

    try {
        await fetch(`/api/votes/${voteId}`, { method: 'DELETE' });
    } catch (e) {}
}

export async function resetAllVotes() {
    currentState.votes = [];
    currentState.revealMode = false;
    notifyStateChanged(true);

    try {
        if (db) {
            const snap = await getDocs(collection(db, "votes"));
            const deletePromises = [];
            snap.forEach(d => deletePromises.push(deleteDoc(d.ref)));
            await Promise.all(deletePromises);
            await setDoc(doc(db, "system", "settings"), { revealMode: false }, { merge: true });
        }
    } catch (e) {
        console.warn('Firestore reset votes error:', e);
    }

    try {
        await fetch('/api/votes/reset-all', { method: 'POST' });
    } catch (e) {}
}

export async function syncAllToFirestore() {
    let serverOk = false;
    let firestoreOk = false;
    let firestoreError = null;

    // 1. Sync to Backend Server Database
    try {
        const payload = {
            news: currentState.news || [],
            contests: currentState.contests || [],
            participants: currentState.participants || [],
            settings: {
                recapVideoUrl: currentState.recapVideoUrl || '',
                featuredContestId: currentState.featuredContestId || 'auto',
                manualThreshold: Number(currentState.manualThreshold) || 0,
                revealMode: Boolean(currentState.revealMode)
            },
            votingState: currentState.votingState || {}
        };
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify(payload)
        });
        if (res.ok) {
            serverOk = true;
        }
    } catch (e) {
        console.warn('Server sync error:', e);
    }

    // 2. Sync to Firestore Cloud Database
    if (db) {
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
            firestoreOk = true;
            console.log('Successfully synced all data to Firestore Cloud');
        } catch (e) {
            firestoreError = e.message || String(e);
            console.warn('Sync all to Firestore note:', e);
        }
    }

    return {
        success: serverOk || firestoreOk,
        server: serverOk,
        firestore: firestoreOk,
        firestoreError
    };
}

export function getCurrentState() {
    return currentState;
}

