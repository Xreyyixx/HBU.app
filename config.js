// Safe JSON patch to protect against circular structures (e.g. Firebase internal Q$1 <-> Sa)
if (typeof JSON !== 'undefined' && typeof JSON.stringify === 'function' && !JSON.stringify.__isCircularSafe) {
    const _origStringify = JSON.stringify;
    const _safeStringify = function(value, replacer, space) {
        try {
            return _origStringify.call(JSON, value, replacer, space);
        } catch (err) {
            if (err instanceof TypeError && (err.message.includes('circular') || err.message.includes('cyclic'))) {
                try {
                    const seen = new WeakSet();
                    const safeReplacer = function(k, v) {
                        if (typeof v === 'object' && v !== null) {
                            if (v.i && typeof v.i === 'object' && v.i.src === v) return undefined;
                            if (v.src && typeof v.src === 'object' && v.src.i === v) return undefined;
                            const cn = v.constructor?.name;
                            if (cn && (cn === 'Q$1' || cn === 'Sa' || cn === 'B$1' || cn.startsWith('Q$') || cn.includes('$') || cn === 'FirebaseApp' || cn === 'Firestore' || cn === 'AuthImpl')) return undefined;
                            if (seen.has(v)) return undefined;
                            seen.add(v);
                        }
                        if (typeof replacer === 'function') return replacer.call(this, k, v);
                        return v;
                    };
                    return _origStringify.call(JSON, value, safeReplacer, space) || '{}';
                } catch (e2) {
                    return '{}';
                }
            }
            throw err;
        }
    };
    _safeStringify.__isCircularSafe = true;
    JSON.stringify = _safeStringify;
}

// Firebase Web SDK v10 (Modular)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// Fetch Firebase config from server or window fallback (no hardcoded production credentials)
let remoteConfig = null;
try {
    const res = await fetch('/api/firebase-config');
    if (res.ok) {
        remoteConfig = await res.json();
    }
} catch (e) {
    // Offline or server unavailable
}

const firebaseConfig = {
    apiKey: remoteConfig?.apiKey || (typeof window !== 'undefined' && window.__FIREBASE_CONFIG__?.apiKey) || "AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw",
    authDomain: remoteConfig?.authDomain || "voting-91412.firebaseapp.com",
    projectId: remoteConfig?.projectId || "voting-91412",
    storageBucket: remoteConfig?.storageBucket || "voting-91412.firebasestorage.app",
    messagingSenderId: remoteConfig?.messagingSenderId || "420998212853",
    appId: remoteConfig?.appId || "1:420998212853:web:4d16f7a9825cb0b76229bc"
};

let app = null;
let db = null;
let auth = null;

if (firebaseConfig.apiKey) {
    try {
        app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);
    } catch (e) {
        console.warn('Firebase initialization note:', e);
    }
}

export { db, auth };

// Анонимная авторизация для обычных зрителей и PWA ярлыков
export async function ensureFirebaseAuth() {
    try {
        if (auth && !auth.currentUser) {
            await signInAnonymously(auth);
        }
    } catch (e) {
        console.warn('Anonymous auth note:', e);
    }
}
if (auth) {
    ensureFirebaseAuth();
}

export const TOTAL_USER_VOTES = 10;
export const MAX_VOTES_PER_PARTICIPANT = 5;

// Шкала перевода мест в Public Points
export const PUBLIC_POINTS_SCALE = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10];

export const DEFAULT_PARTICIPANTS = [
    { id: 'p1', number: 1, name: 'Number 1', country: 'THE KUR', artist: 'Participant 1', videoUrl: 'videos/thank_you_p1.mp4' },
    { id: 'p2', number: 2, name: 'Number 2', country: '', artist: 'Participant 2', videoUrl: 'videos/thank_you_p2.mp4' },
    { id: 'p3', number: 3, name: 'Number 3', country: '', artist: 'Participant 3', videoUrl: 'videos/thank_you_p3.mp4' },
    { id: 'p4', number: 4, name: 'Number 4', country: '', artist: 'Participant 4', videoUrl: 'videos/thank_you_p4.mp4' },
    { id: 'p5', number: 5, name: 'Number 5', country: '', artist: 'Participant 5', videoUrl: 'videos/thank_you_p5.mp4' },
    { id: 'p6', number: 6, name: 'Number 6', country: '', artist: 'Participant 6', videoUrl: 'videos/thank_you_p6.mp4' },
    { id: 'p7', number: 7, name: 'Number 7', country: '', artist: 'Participant 7', videoUrl: 'videos/thank_you_p7.mp4' },
    { id: 'p8', number: 8, name: 'Number 8', country: '', artist: 'Participant 8', videoUrl: 'videos/thank_you_p8.mp4' }
];

export const INITIAL_CONTESTS = [];

export const INITIAL_NEWS = [];
