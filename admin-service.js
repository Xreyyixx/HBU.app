// Админские операции записи (новости, конкурсы, профили артистов, номера, голосование, сброс).
// Вынесены из data-service.js, чтобы обычные посетители не скачивали этот код: подключается
// только админкой (admin.js). Общее состояние берётся из data-service.js.
import { db, auth, ensureFirebaseAuth, DEFAULT_PARTICIPANTS } from './config.js';
import { collection, doc, setDoc, deleteDoc, getDocs } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import {
    sanitizeFirestoreData,
    safeJsonStringify,
    currentState,
    notifyStateChanged,
    setLastLocalVotingStateUpdatedAt,
    deletedCalendarNoteIds,
    mergeCalendarNotes,
    sortNewsDescending
} from './data-service.js';

// -------------------------------------------------------------
// CRUD: NEWS
// -------------------------------------------------------------
export async function saveNewsArticle(article, notifySubscribers = false) {
    if (!article.id) article.id = 'news-' + Date.now();
    if (!article.createdAt) article.createdAt = Date.now();
    article.updatedAt = Date.now();
    const idx = (currentState.news || []).findIndex(n => n.id === article.id);
    const isNew = idx < 0;
    if (idx >= 0) {
        currentState.news[idx] = { ...currentState.news[idx], ...article };
    } else {
        currentState.news.push(article);
    }
    currentState.news = sortNewsDescending(currentState.news);
    notifyStateChanged(true);

    // Save to Firestore (Cross-device persistence)
    try {
        await setDoc(doc(db, "news", article.id), article, { merge: true });
    } catch (e) {
        console.warn('Firestore save news error:', e);
    }

    // Оповещение подписчиков через облачную очередь Firestore (только если чекбокс включен)
    if (notifySubscribers) {
        try {
            const fsUrl = `https://firestore.googleapis.com/v1/projects/voting-91412/databases/(default)/documents/artistAccounts/broadcast_queue?key=AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw`;
            fetch(fsUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        title: { stringValue: (isNew ? 'Новая новость HBU 📰: ' : 'Обновление новости: ') + (article.title || '') },
                        body: { stringValue: article.summary || article.title || 'В статью были внесены изменения. Читайте на портале!' },
                        url: { stringValue: '/#news' },
                        tag: { stringValue: 'news-notify-' + article.id + '-' + Date.now() },
                        createdAt: { integerValue: String(Date.now()) },
                        processed: { booleanValue: false }
                    }
                })
            }).catch(() => {});
        } catch (e) {}
    }

    // Save to REST API if available
    try {
        const res = await fetch('/api/news', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify({ ...article, notifySubscribers: Boolean(notifySubscribers) })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.news) {
                currentState.news = sortNewsDescending(data.news);
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.news;
}

export async function deleteNewsArticle(articleId) {
    currentState.news = sortNewsDescending((currentState.news || []).filter(n => n.id !== articleId));
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
                currentState.news = sortNewsDescending(data.news);
                notifyStateChanged(true);
            }
        }
    } catch (e) {}

    return currentState.news;
}

// -------------------------------------------------------------
// CRUD: CONTESTS
// -------------------------------------------------------------
export async function saveContest(contest, notifySubscribers = false) {
    if (!contest.id) contest.id = 'contest-' + Date.now();
    const idx = (currentState.contests || []).findIndex(c => c.id === contest.id);
    const isNew = idx < 0;
    if (idx >= 0) {
        currentState.contests[idx] = { ...currentState.contests[idx], ...contest };
    } else {
        currentState.contests.unshift(contest);
    }
    notifyStateChanged(true);

    // Save to Firestore directly in collection "contests"
    try {
        if (db) {
            await setDoc(doc(db, "contests", contest.id), contest, { merge: true });
        }
    } catch (e) {
        console.warn('Firestore save contest error:', e);
    }

    // Оповещение подписчиков через облачную очередь Firestore (только если чекбокс включен)
    if (notifySubscribers) {
        try {
            const fsUrl = `https://firestore.googleapis.com/v1/projects/voting-91412/databases/(default)/documents/artistAccounts/broadcast_queue?key=AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw`;
            fetch(fsUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        title: { stringValue: (isNew ? 'Новый сезон HariVision! 🏆: ' : 'Обновление сезона: ') + (contest.title || '') },
                        body: { stringValue: contest.slogan || (contest.hostCity ? `Город: ${contest.hostCity}` : 'Обновлена информация о конкурсе HariVision!') },
                        url: { stringValue: `/#contest/${contest.id}` },
                        tag: { stringValue: 'contest-notify-' + contest.id + '-' + Date.now() },
                        createdAt: { integerValue: String(Date.now()) },
                        processed: { booleanValue: false }
                    }
                })
            }).catch(() => {});
        } catch (e) {}
    }

    // Save to REST API if available
    try {
        const res = await fetch('/api/contests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify({ ...contest, notifySubscribers: Boolean(notifySubscribers) })
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

    // Delete directly from Firestore collection "contests"
    try {
        if (db) {
            await deleteDoc(doc(db, "contests", contestId));
        }
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
// CRUD: ARTIST PROFILES (архив карьеры артистов, раздел "Артисты")
// ВАЖНО: не путать с логин-аккаунтами исполнителей (currentState.artists,
// коллекция Firestore "artists") — это отдельная, независимая сущность.
// -------------------------------------------------------------
// Серверная сессия админа живёт в памяти/на диске Node-сервера; на бесплатном Render
// диск эфемерный, поэтому после каждого рестарта сервера сохранённый в браузере токен
// становится недействительным (HTTP 401), хотя сам админ по-прежнему вошёл в Firebase.
// Этот хелпер тихо получает свежий токен по ID-токену Firebase.
export async function refreshAdminServerSession() {
    if (!auth || !auth.currentUser || auth.currentUser.isAnonymous) return null;
    try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await fetch('/api/admin/register-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
            body: '{}'
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.success && data.token) {
            localStorage.setItem('harivision_admin_token', data.token);
            return data.token;
        }
    } catch (e) {}
    return null;
}

// Возвращает { ok, firestoreOk, serverOk, error }. Раньше результат сохранения молча
// проглатывался, и админка писала «профиль создан!» даже когда не сохранилось нигде
// (Firestore отклонял запись по правилам, а серверный токен протух).
export async function saveArtistProfile(artist) {
    if (!artist.id) artist.id = 'artist-profile-' + Date.now();
    if (!Array.isArray(currentState.artistProfiles)) currentState.artistProfiles = [];

    // Чистим undefined (Firestore их не принимает) и фиксируем «как было» для отката
    const clean = JSON.parse(safeJsonStringify(artist) || '{}');
    clean.id = artist.id;
    const snapshotBefore = JSON.parse(JSON.stringify(currentState.artistProfiles));

    const idx = currentState.artistProfiles.findIndex(a => a.id === clean.id);
    if (idx >= 0) {
        currentState.artistProfiles[idx] = clean;
    } else {
        currentState.artistProfiles.push(clean);
    }
    notifyStateChanged(true);

    // Оба канала идут параллельно: отказ Firestore может занимать секунды, и ждать его
    // перед запросом к серверу незачем.
    const firestorePart = (async () => {
        try {
            if (!db) return { ok: false, error: 'Firestore не инициализирован' };
            await ensureFirebaseAuth();
            // Профиль редактируется целиком — полная перезапись, а не merge (иначе удалённые
            // из формы диаграммы/таблицы остались бы в документе).
            await setDoc(doc(db, "artistProfiles", clean.id), clean);
            return { ok: true, error: '' };
        } catch (e) {
            console.warn('Firestore save artist profile error:', e);
            return { ok: false, error: (e && (e.code || e.message)) || String(e) };
        }
    })();
    const serverPart = (async () => {
        try {
            const post = () => fetch('/api/artist-profiles', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: safeJsonStringify(clean)
            });
            let res = await post();
            if (res.status === 401 && await refreshAdminServerSession()) {
                res = await post();
            }
            if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
            return { ok: true, error: '', data: await res.json() };
        } catch (e) {
            return { ok: false, error: (e && e.message) || String(e) };
        }
    })();
    const [fsResult, srvResult] = await Promise.all([firestorePart, serverPart]);
    const firestoreOk = fsResult.ok, firestoreError = fsResult.error;
    const serverOk = srvResult.ok, serverError = srvResult.error;
    // Если Firestore принял запись — его realtime-слушатель и так приведёт список к единому
    // виду; серверный список подменяет локальный только когда Firestore недоступен.
    if (serverOk && !firestoreOk && srvResult.data && srvResult.data.artistProfiles) {
        currentState.artistProfiles = srvResult.data.artistProfiles;
        notifyStateChanged(true);
    }

    if (!firestoreOk && !serverOk) {
        // Нигде не сохранилось — откатываем локальное «оптимистичное» изменение
        currentState.artistProfiles = snapshotBefore;
        notifyStateChanged(true);
    }

    return {
        ok: firestoreOk || serverOk,
        firestoreOk,
        serverOk,
        error: firestoreOk || serverOk ? '' : `Firestore: ${firestoreError || 'недоступен'}; сервер: ${serverError || 'недоступен'}`,
        firestoreError
    };
}

export async function deleteArtistProfile(artistId) {
    const snapshotBefore = JSON.parse(JSON.stringify(currentState.artistProfiles || []));
    currentState.artistProfiles = (currentState.artistProfiles || []).filter(a => a.id !== artistId);
    notifyStateChanged(true);

    // Оба канала идут параллельно (см. saveArtistProfile)
    const firestorePart = (async () => {
        try {
            if (!db) return false;
            await ensureFirebaseAuth();
            await deleteDoc(doc(db, "artistProfiles", artistId));
            return true;
        } catch (e) {
            console.warn('Firestore delete artist profile error:', e);
            return false;
        }
    })();
    const serverPart = (async () => {
        try {
            const del = () => fetch(`/api/artist-profiles/${artistId}`, { method: 'DELETE' });
            let res = await del();
            if (res.status === 401 && await refreshAdminServerSession()) {
                res = await del();
            }
            return res.ok ? await res.json() : null;
        } catch (e) {
            return null;
        }
    })();
    const [firestoreOk, serverData] = await Promise.all([firestorePart, serverPart]);
    const serverOk = Boolean(serverData);
    if (serverOk && !firestoreOk && serverData.artistProfiles) {
        currentState.artistProfiles = serverData.artistProfiles;
        notifyStateChanged(true);
    }

    if (!firestoreOk && !serverOk) {
        currentState.artistProfiles = snapshotBefore;
        notifyStateChanged(true);
    }
    return { ok: firestoreOk || serverOk, firestoreOk, serverOk };
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
    const updatedAt = Date.now();
    const cleanPayload = {
        status: stateUpdate.status || 'closed',
        endsAt: stateUpdate.status === 'closed' ? null : (stateUpdate.endsAt || null),
        sessionId: stateUpdate.sessionId || currentState.votingState.sessionId || ('session_' + Date.now()),
        openedAt: stateUpdate.openedAt || (stateUpdate.status === 'open' ? new Date().toISOString() : (currentState.votingState.openedAt || null)),
        updatedAt: updatedAt
    };

    currentState.votingState = { ...currentState.votingState, ...cleanPayload };
    setLastLocalVotingStateUpdatedAt(updatedAt);
    notifyStateChanged(true);

    try {
        await ensureFirebaseAuth();
        if (db) {
            await setDoc(doc(db, "system", "voting_state"), cleanPayload, { merge: true });
        }
    } catch (e) {
        console.warn('Firestore update voting state error:', e);
    }

    try {
        await fetch('/api/voting/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify(cleanPayload)
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
            body: safeJsonStringify({ manualThreshold: Number(threshold) || 0, revealMode: Boolean(revealMode) })
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
            body: safeJsonStringify({ recapVideoUrl: String(url || '') })
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
            body: safeJsonStringify({ featuredContestId: String(featuredContestId || 'auto') })
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

export async function verifyAdminSession() {
    const token = localStorage.getItem('harivision_admin_token');
    if (!token) return false;
    try {
        const res = await fetch('/api/admin/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data.revoked) {
            localStorage.removeItem('harivision_admin_token');
            return false;
        }
        return Boolean(data.valid);
    } catch (e) {
        return false;
    }
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

export async function syncAllToFirestore(localStateOverride = null) {
    let serverOk = false;
    let firestoreOk = false;
    let firestoreError = null;

    if (localStateOverride && typeof localStateOverride === 'object') {
        if (Array.isArray(localStateOverride.calendarNotes)) {
            currentState.calendarNotes = localStateOverride.calendarNotes
                .filter(n => n && n.id && !deletedCalendarNoteIds.has(String(n.id)) && !['cal-1', 'cal-2', 'cal-3', 'cal-4'].includes(String(n.id)))
                .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        }
        if (Array.isArray(localStateOverride.news) && localStateOverride.news.length > 0) {
            currentState.news = localStateOverride.news;
        }
        if (Array.isArray(localStateOverride.contests) && localStateOverride.contests.length > 0) {
            currentState.contests = localStateOverride.contests;
        }
        if (Array.isArray(localStateOverride.participants) && localStateOverride.participants.length > 0) {
            currentState.participants = localStateOverride.participants;
        }
    }

    try {
        await ensureFirebaseAuth();
    } catch (e) {}

    // Deep sanitize current state to guarantee clean serialization
    const cleanNews = (currentState.news || []).map(n => sanitizeFirestoreData(n)).filter(Boolean);
    const cleanContests = (currentState.contests || []).map(c => sanitizeFirestoreData(c)).filter(Boolean);
    const cleanParticipants = (currentState.participants || []).map(p => sanitizeFirestoreData(p)).filter(Boolean);
    const cleanVotingState = sanitizeFirestoreData(currentState.votingState) || {};
    const cleanVotes = (currentState.votes || []).map(v => sanitizeFirestoreData(v)).filter(Boolean);
    const cleanCalendarNotes = (currentState.calendarNotes || [])
        .filter(n => n && n.id && !deletedCalendarNoteIds.has(n.id) && !['cal-1', 'cal-2', 'cal-3', 'cal-4'].includes(n.id))
        .map(c => sanitizeFirestoreData(c)).filter(Boolean);

    // 1. Sync to Backend Server Database
    try {
        const payload = {
            news: cleanNews,
            contests: cleanContests,
            participants: cleanParticipants,
            calendarNotes: cleanCalendarNotes,
            settings: {
                recapVideoUrl: currentState.recapVideoUrl || '',
                featuredContestId: currentState.featuredContestId || 'auto',
                manualThreshold: Number(currentState.manualThreshold) || 0,
                revealMode: Boolean(currentState.revealMode)
            },
            votingState: cleanVotingState,
            votes: cleanVotes
        };
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: safeJsonStringify(payload)
        });
        if (res.ok) {
            serverOk = true;
            try {
                const srvData = await res.json();
                if (srvData && srvData.store && Array.isArray(srvData.store.calendarNotes)) {
                    currentState.calendarNotes = mergeCalendarNotes(currentState.calendarNotes, srvData.store.calendarNotes);
                }
            } catch (e) {}
        }
    } catch (e) {
        console.warn('Server sync error:', e);
    }

    // 2. Sync to Firestore Cloud Database
    if (db) {
        // News
        try {
            if (Array.isArray(cleanNews)) {
                for (const item of cleanNews) {
                    if (item && item.id) {
                        await setDoc(doc(db, "news", String(item.id)), item, { merge: true });
                    }
                }
                firestoreOk = true;
            }
        } catch (e) {
            console.warn('Firestore news sync note:', e);
        }

        // Calendar Notes Collection (Public Events synced across all devices)
        try {
            const notesToSave = (currentState.calendarNotes || [])
                .filter(n => n && n.id && !deletedCalendarNoteIds.has(n.id) && !['cal-1', 'cal-2', 'cal-3', 'cal-4'].includes(n.id));
            
            await setDoc(doc(db, "artistAccounts", "calendar_store"), {
                type: 'calendar_store',
                data: safeJsonStringify(notesToSave),
                updatedAt: Date.now()
            }, { merge: true });

            for (const note of notesToSave) {
                if (note && note.id) {
                    const clean = sanitizeFirestoreData(note);
                    setDoc(doc(db, "calendar", String(note.id)), {
                        ...clean,
                        updatedAt: Date.now()
                    }, { merge: true }).catch(() => {});
                    setDoc(doc(db, "artistAccounts", "cal_" + note.id), {
                        ...clean,
                        docType: 'calendar_event',
                        updatedAt: Date.now()
                    }, { merge: true }).catch(() => {});
                }
            }

            // Also clean up any deleted note documents from Firestore
            for (const delId of deletedCalendarNoteIds) {
                deleteDoc(doc(db, "calendar", String(delId))).catch(() => {});
                deleteDoc(doc(db, "artistAccounts", "cal_" + delId)).catch(() => {});
                deleteDoc(doc(db, "artistAccounts", "calendar_" + delId)).catch(() => {});
            }
            firestoreOk = true;
        } catch (e) {
            firestoreError = e.message || String(e);
            console.warn('Firestore calendar sync error:', e);
        }

        // Contests
        try {
            if (Array.isArray(cleanContests)) {
                for (const c of cleanContests) {
                    if (c && c.id) {
                        await setDoc(doc(db, "contests", String(c.id)), c, { merge: true });
                    }
                }
            }
        } catch (e) {
            console.warn('Firestore contests sync note:', e);
        }

        // Participants
        try {
            if (Array.isArray(cleanParticipants) && cleanParticipants.length > 0) {
                await setDoc(doc(db, "system", "participants"), {
                    list: cleanParticipants,
                    updatedAt: new Date().toISOString()
                }, { merge: true });
            }
        } catch (e) {
            console.warn('Firestore participants sync note:', e);
        }

        // Settings & Voting State
        try {
            await setDoc(doc(db, "system", "settings"), {
                recapVideoUrl: currentState.recapVideoUrl || '',
                featuredContestId: currentState.featuredContestId || 'auto',
                manualThreshold: Number(currentState.manualThreshold) || 0,
                revealMode: Boolean(currentState.revealMode)
            }, { merge: true });
            if (cleanVotingState && Object.keys(cleanVotingState).length > 0) {
                await setDoc(doc(db, "system", "voting_state"), cleanVotingState, { merge: true });
            }
        } catch (e) {
            console.warn('Firestore settings sync note:', e);
        }
    }

    return {
        success: serverOk || firestoreOk,
        server: serverOk,
        firestore: firestoreOk,
        firestoreError
    };
}
