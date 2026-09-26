import { auth, PUBLIC_POINTS_SCALE, DEFAULT_PARTICIPANTS, db } from './config.js';
import { syncPushSubscription } from './notifications.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { onSnapshot, collection } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    subscribeState, 
    saveNewsArticle, 
    deleteNewsArticle, 
    saveContest, 
    deleteContest, 
    saveParticipant, 
    deleteParticipant, 
    resetParticipantsToDefault, 
    updateVotingState, 
    updateVotingThreshold, 
    saveRecapVideoUrl,
    saveFeaturedBanner,
    syncAllToFirestore,
    fetchFirestoreStateDirectly,
    loginAdminServer,
    verifyAdminSession,
    deleteVote as deleteVoteFromService, 
    resetAllVotes,
    saveAdminCalendarNote,
    deleteAdminCalendarNote,
    mergeVotes,
    sanitizeFirestoreData,
    safeJsonStringify,
    renderVideoPlayerHTML,
    sortNewsDescending,
    checkIsAdmin 
} from './data-service.js';

let appState = {
    contests: [],
    news: [],
    participants: [],
    votingState: { status: 'closed', endsAt: null, sessionId: null },
    recapVideoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
    featuredContestId: 'auto',
    votes: [],
    calendarNotes: [],
    manualThreshold: 0,
    revealMode: false
};

let activeModalVoteId = null;
let activeAdminTab = 'voting';
let timerInterval = null;

// -------------------------------------------------------------
// РУЧНАЯ И АВТОМАТИЧЕСКАЯ ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ
// -------------------------------------------------------------
window.manualCloudSync = async function() {
    const btn = document.getElementById('cloud-sync-btn');
    if (btn) {
        btn.innerHTML = `<span>⏳</span><span>Синхронизация...</span>`;
        btn.disabled = true;
    }
    try {
        const result = await syncAllToFirestore(appState);
        try {
            await fetchFirestoreStateDirectly();
        } catch (e) {}

        renderAdminCalendar();

        if (btn) {
            btn.innerHTML = `<span>☁️</span><span>Синхронизировать с облаком</span>`;
            btn.disabled = false;
        }

        const count = Array.isArray(appState.calendarNotes) ? appState.calendarNotes.length : 0;
        showToast(`✓ Синхронизировано: ${count} событий календаря и все данные!`);
    } catch (err) {
        if (btn) {
            btn.innerHTML = `<span>☁️</span><span>Синхронизировать с облаком</span>`;
            btn.disabled = false;
        }
        showToast('✓ Данные обновлены');
    }
};

// -------------------------------------------------------------
// АУТЕНТИФИКАЦИЯ (FIREBASE AUTH + SERVER ADMIN SESSION)
// -------------------------------------------------------------
let isAuthenticated = false;

// Экранирование пользовательских строк перед вставкой в HTML (защита от XSS)
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Получение серверной сессии админа (нужна только для функций сервера: push-рассылки, список сессий).
// Сервер сам проверяет ID-токен Firebase и права администратора и выдаёт случайный токен сессии.
async function registerCurrentAdminSession() {
    if (!auth || !auth.currentUser || auth.currentUser.isAnonymous) return null;
    try {
        const idToken = await auth.currentUser.getIdToken();
        const res = await fetch('/api/admin/register-session', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({})
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.success && data.token) {
            localStorage.setItem('harivision_admin_token', data.token);
            return data.token;
        }
    } catch (e) {
        // Сервер недоступен (например, статический хостинг) — работаем только через Firestore
    }
    return null;
}

function handleSessionRevokedNotice() {
    localStorage.removeItem('harivision_admin_token');
    if (auth) {
        try { signOut(auth); } catch (e) {}
    }
    setAdminAuthenticated(false);
    const errEl = document.getElementById('auth-error');
    if (errEl) {
        errEl.innerHTML = `<div class="font-bold text-rose-300">Доступ к панели администратора был отозван.</div><div class="text-[11px] text-slate-300 mt-1">Ваша сессия завершена администратором. Для повторного входа пройдите авторизацию заново.</div>`;
        errEl.classList.remove('hidden');
    }
    showToast('Доступ к панели управления был отозван', true);
}

function setAdminAuthenticated(authenticated) {
    isAuthenticated = authenticated;
    const authPanel = document.getElementById('auth-panel');
    const dashboard = document.getElementById('dashboard');
    if (!authPanel || !dashboard) return;

    if (authenticated) {
        authPanel.classList.add('hidden');
        dashboard.classList.remove('hidden');
        renderAdminParticipants();
        calculateAndRenderPublicPoints();
        updateVotingSessionUI();
        renderAdminNews();
        renderAdminContests();
        renderAdminCalendar();
        updateBannerSelectUI();
        if (activeAdminTab === 'admins') {
            loadAdminSessions();
        }
    } else {
        authPanel.classList.remove('hidden');
        dashboard.classList.add('hidden');
    }
}

// Периодическая проверка статуса сессии (выявление отзыва доступа)
setInterval(async () => {
    if (!isAuthenticated) return;
    if (!auth || !auth.currentUser || auth.currentUser.isAnonymous) {
        setAdminAuthenticated(false);
        return;
    }
    const token = localStorage.getItem('harivision_admin_token');
    if (!token) return;
    try {
        const res = await fetch('/api/admin/verify', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (data && data.revoked) {
            handleSessionRevokedNotice();
        } else if (!res.ok || !data.valid) {
            localStorage.removeItem('harivision_admin_token');
        }
    } catch (e) {
        // network transient error, ignore
    }
}, 15000);

// Проверка сохраненной сессии при старте
(async function initAdminAuthSession() {
    const token = localStorage.getItem('harivision_admin_token');
    if (token) {
        try {
            const res = await fetch('/api/admin/verify', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json();
            if (data && data.revoked) {
                handleSessionRevokedNotice();
                return;
            }
            if (!data || !data.valid) {
                localStorage.removeItem('harivision_admin_token');
            }
        } catch (e) {}
    }

    // Доступ к панели только для вошедшего пользователя Firebase, у которого есть документ admins/{uid}.
    // Анонимные зрители и обычные пользователи панель не получают.
    if (auth) {
        onAuthStateChanged(auth, async (user) => {
            if (user && !user.isAnonymous && await checkIsAdmin(user)) {
                setAdminAuthenticated(true);
                if (!localStorage.getItem('harivision_admin_token')) {
                    await registerCurrentAdminSession();
                }
                try {
                    await fetchFirestoreStateDirectly();
                } catch (e) {}
            } else {
                setAdminAuthenticated(false);
            }
        });
    }
})();

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const loginInput = (document.getElementById('email')?.value || '').trim();
    const password = (document.getElementById('password')?.value || '').trim();
    const errEl = document.getElementById('auth-error');
    const submitBtn = document.getElementById('login-submit-btn');
    if (errEl) errEl.classList.add('hidden');

    if (!loginInput || !password) {
        if (errEl) {
            errEl.innerText = "Пожалуйста, заполните все поля";
            errEl.classList.remove('hidden');
        }
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-70');
    }

    // Вход только через Firebase Authentication + проверка прав (документ admins/{uid}).
    // Именно эти права проверяют правила Firestore при записи данных.
    if (!auth) {
        if (errEl) {
            errEl.innerHTML = `<div class="font-bold text-rose-300">Firebase не инициализирован. Вход невозможен.</div>`;
            errEl.classList.remove('hidden');
        }
    } else {
        try {
            const firebaseEmail = loginInput.includes('@') ? loginInput : `${loginInput}@harivision.org`;
            const userCred = await signInWithEmailAndPassword(auth, firebaseEmail, password);
            const isAdmin = await checkIsAdmin(userCred.user);
            if (!isAdmin) {
                try { await signOut(auth); } catch (e) {}
                if (errEl) {
                    errEl.innerHTML = `<div class="font-bold text-rose-300">У этого аккаунта нет прав администратора.</div>`;
                    errEl.classList.remove('hidden');
                }
            } else {
                setAdminAuthenticated(true);
                showToast('Вход в панель администратора выполнен');
                await registerCurrentAdminSession();
            }
        } catch (firebaseErr) {
            console.error('Firebase Auth Error:', firebaseErr);
            let msg = "Неверный логин или пароль администратора";
            if (firebaseErr.code === 'auth/invalid-credential' || firebaseErr.code === 'auth/wrong-password' || firebaseErr.code === 'auth/user-not-found') {
                msg = "Неверный email или пароль. Проверьте правильность введенных данных.";
            } else if (firebaseErr.code === 'auth/invalid-email') {
                msg = "Некорректный формат email";
            } else if (firebaseErr.code === 'auth/too-many-requests') {
                msg = "Слишком много неудачных попыток входа. Попробуйте позже.";
            }
            if (errEl) {
                errEl.innerHTML = `<div class="font-bold text-rose-300">${escapeHtml(msg)}</div>`;
                errEl.classList.remove('hidden');
            }
        }
    }

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('opacity-70');
    }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
    localStorage.removeItem('harivision_admin_token');
    if (auth) {
        try {
            await signOut(auth);
        } catch (e) {}
    }
    setAdminAuthenticated(false);
    showToast('Вы вышли из панели администратора');
});

// -------------------------------------------------------------
// МОДАЛЬНОЕ ОКНО БЕЗОПАСНОГО ПОДТВЕРЖДЕНИЯ (БЕЗ WINDOW.CONFIRM)
// -------------------------------------------------------------
let activeAdminConfirmCallback = null;

function openAdminConfirmModal({ title = 'Подтверждение действия', message = 'Вы уверены, что хотите выполнить это действие?', confirmText = 'Удалить', onConfirm }) {
    const modal = document.getElementById('admin-confirm-modal');
    const titleEl = document.getElementById('admin-confirm-title');
    const msgEl = document.getElementById('admin-confirm-message');
    const submitBtn = document.getElementById('admin-confirm-submit-btn');

    if (!modal) {
        if (typeof onConfirm === 'function') onConfirm();
        return;
    }

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = message;
    if (submitBtn) submitBtn.innerText = confirmText;

    activeAdminConfirmCallback = onConfirm;
    modal.classList.remove('hidden');
}

window.closeAdminConfirmModal = function() {
    const modal = document.getElementById('admin-confirm-modal');
    if (modal) modal.classList.add('hidden');
    activeAdminConfirmCallback = null;
};

const confirmSubmitBtn = document.getElementById('admin-confirm-submit-btn');
if (confirmSubmitBtn) {
    confirmSubmitBtn.addEventListener('click', async () => {
        const callback = activeAdminConfirmCallback;
        window.closeAdminConfirmModal();
        if (typeof callback === 'function') {
            await callback();
        }
    });
}

// -------------------------------------------------------------
// УВЕДОМЛЕНИЯ (TOAST)
// -------------------------------------------------------------
function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    container.innerHTML = `
        <div class="text-[11px] font-bold px-3 py-1 rounded-lg ${isError ? 'bg-rose-950/80 text-rose-300 border border-rose-500/30' : 'bg-green-950/80 text-green-300 border border-green-500/30'} flex items-center gap-1.5 animate-bounce">
            <span>${isError ? '⚠️' : '✓'}</span>
            <span>${message}</span>
        </div>
    `;
    setTimeout(() => {
        if (container.innerHTML.includes(message)) container.innerHTML = '';
    }, 4000);
}

// -------------------------------------------------------------
// НАВИГАЦИЯ ПО ВКЛАДКАМ АДМИНКИ
// -------------------------------------------------------------
window.switchAdminTab = function(tabName) {
    activeAdminTab = tabName;
    const tabs = ['voting', 'news', 'contests', 'calendar', 'notifications', 'admins'];

    tabs.forEach(tab => {
        const btn = document.getElementById(`tab-btn-${tab}`);
        const sec = document.getElementById(`section-${tab}`);

        if (tab === tabName) {
            if (btn) btn.className = "px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md transition flex items-center gap-2";
            if (sec) sec.classList.remove('hidden');
        } else {
            if (btn) btn.className = "px-5 py-2.5 rounded-2xl font-bold text-xs uppercase tracking-wider bg-[#16070b] text-slate-300 hover:text-amber-300 border border-amber-500/20 transition flex items-center gap-2";
            if (sec) sec.classList.add('hidden');
        }
    });

    if (tabName === 'calendar') {
        renderAdminCalendar();
    } else if (tabName === 'admins') {
        loadAdminSessions();
    }
};

// -------------------------------------------------------------
// РАЗДЕЛ 1: VOTING (СЕССИЯ, УЧАСТНИКИ, ПОДСЧЕТ)
// -------------------------------------------------------------
window.openVoting = async function(minutes) {
    const newSessionId = 'session_' + Date.now();
    const endsAt = minutes > 0 ? new Date(Date.now() + minutes * 60000).toISOString() : null;
    
    // Обнуляем все голоса и скрываем результаты предыдущего голосования
    await resetAllVotes();

    await updateVotingState({
        status: 'open',
        endsAt: endsAt,
        sessionId: newSessionId,
        openedAt: new Date().toISOString(),
        updatedAt: Date.now()
    });
    showToast(`Голосование открыто ${minutes > 0 ? 'на ' + minutes + ' мин' : 'без ограничения времени'}`);
};

window.closeVoting = async function() {
    await updateVotingState({
        status: 'closed',
        endsAt: null,
        sessionId: appState.votingState.sessionId || ('session_' + Date.now()),
        updatedAt: Date.now()
    });
    showToast('Голосование закрыто');
};

window.updateManualThreshold = function(val) {
    const num = parseFloat(val) || 0;
    updateVotingThreshold(num, appState.revealMode);
};

window.revealResults = function() {
    const nextReveal = !appState.revealMode;
    updateVotingThreshold(appState.manualThreshold || 0, nextReveal);
    showToast(nextReveal ? 'Public Points раскрыты!' : 'Public Points скрыты');
};

window.saveRecapUrlFromInput = async function() {
    const input = document.getElementById('recap-video-url-input');
    const statusEl = document.getElementById('recap-save-status');
    if (!input) return;
    const url = input.value.trim();
    await saveRecapVideoUrl(url);
    if (statusEl) {
        statusEl.innerText = '✓ Ссылка на повтор успешно сохранена и обновлена!';
        statusEl.classList.remove('hidden');
        setTimeout(() => {
            statusEl.classList.add('hidden');
        }, 4000);
    }
    showToast('Ссылка на повтор сохранена');
};

window.confirmResetAllVotes = function() {
    openAdminConfirmModal({
        title: 'Очистка всех голосов',
        message: 'Вы уверены, что хотите полностью очистить все голоса зрителей текущей сессии? Это действие необратимо.',
        confirmText: 'Очистить голоса',
        onConfirm: async () => {
            await resetAllVotes();
            showToast('Все голоса успешно удалены');
        }
    });
};

window.closeVoteModal = function() {
    document.getElementById('vote-modal').classList.add('hidden');
    activeModalVoteId = null;
};

window.inspectVote = function(voteId) {
    const vote = (appState.votes || []).find(v => String(v.id) === String(voteId));
    if (!vote) {
        showToast('Голос не найден', true);
        return;
    }

    activeModalVoteId = vote.id;
    const isArtist = vote.userRole === 'artist';
    const isNational = Boolean(vote.isNational);
    const badgeText = isArtist ? ` [⭐ Артист: ${vote.artistName || vote.voterName}]` : (isNational ? ` [🌍 Национальное: ${vote.representative || 'Представитель'}]` : ' [👤 Зритель]');
    
    const modalTitleEl = document.getElementById('modal-voter-name');
    if (modalTitleEl) {
        modalTitleEl.innerText = `Голос: ${vote.voterName || 'Аноним'}${badgeText}`;
    }
    
    const allocEl = document.getElementById('modal-allocations');
    const participants = appState.participants || [];

    if (allocEl) {
        const entries = Object.entries(vote.allocations || {}).filter(([_, count]) => (Number(count) || 0) > 0);
        if (entries.length === 0) {
            allocEl.innerHTML = '<div class="text-xs text-slate-400 text-center py-4">Нет распределенных голосов</div>';
        } else {
            allocEl.innerHTML = entries.map(([pId, count]) => {
                const num = Number(count) || 0;
                const participant = participants.find((p, idx) => {
                    const numVal = p.number !== undefined ? Number(p.number) : (idx + 1);
                    return String(p.id).toLowerCase() === String(pId).toLowerCase() ||
                           String(numVal) === String(pId) ||
                           `p${numVal}`.toLowerCase() === String(pId).toLowerCase() ||
                           `p${idx + 1}`.toLowerCase() === String(pId).toLowerCase() ||
                           (p.name && p.name.toLowerCase() === String(pId).toLowerCase());
                });

                const pNumber = participant ? (participant.number !== undefined ? participant.number : '') : '';
                const name = participant ? `${participant.flag || '🏳️'} #${pNumber} ${participant.name || ('Number ' + pNumber)}` : `Номер ${escapeHtml(pId)}`;
                const countryArtist = participant ? `${participant.country ? participant.country + ' • ' : ''}${participant.artist || ''}` : '';
                const songInfo = participant && participant.song ? ` «${participant.song}»` : '';

                return `
                    <div class="flex justify-between items-center bg-[#16070b] border border-amber-500/20 p-3 rounded-2xl text-xs">
                        <div class="flex flex-col">
                            <span class="font-bold text-slate-100">${name}</span>
                            <span class="text-[10px] text-slate-400">${countryArtist}${songInfo}</span>
                        </div>
                        <span class="font-mono font-black text-amber-400 px-3 py-1 bg-amber-500/10 rounded-xl border border-amber-500/25 text-xs">${num} ${num === 1 ? 'голос' : (num < 5 ? 'голоса' : 'голосов')}</span>
                    </div>
                `;
            }).join('');
        }
    }

    const modal = document.getElementById('vote-modal');
    if (modal) modal.classList.remove('hidden');
};

document.getElementById('reset-vote-btn').addEventListener('click', async () => {
    if (!activeModalVoteId) return;
    await deleteVoteFromService(activeModalVoteId);
    closeVoteModal();
    showToast('Голос аннулирован');
});

window.deleteVote = function(voteId) {
    const vote = (appState.votes || []).find(v => String(v.id) === String(voteId));
    const voterLabel = vote ? (vote.voterName || `Голос #${voteId}`) : `Голос #${voteId}`;
    openAdminConfirmModal({
        title: 'Аннулирование голоса',
        message: `Вы действительно хотите аннулировать голос "${voterLabel}"?`,
        confirmText: 'Аннулировать голос',
        onConfirm: async () => {
            await deleteVoteFromService(voteId);
            showToast(`Голос ${escapeHtml(voterLabel)} аннулирован`);
        }
    });
};

// -------------------------------------------------------------
// УПРАВЛЕНИЕ УЧАСТНИКАМИ (PARTICIPANTS / SONGS)
// -------------------------------------------------------------
function renderAdminParticipants() {
    const container = document.getElementById('admin-participants-list');
    if (!container) return;

    const list = (Array.isArray(appState.participants) && appState.participants.length > 0) ? appState.participants : DEFAULT_PARTICIPANTS;
    if (list.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-6 text-xs text-slate-400">Нет добавленных участников. Нажмите "+ Добавить номер" или "Сбросить".</div>`;
        return;
    }

    container.innerHTML = list.map((p, idx) => `
        <div class="bg-[#16070b] border border-amber-500/20 hover:border-amber-500/40 p-4 rounded-2xl flex flex-col justify-between transition shadow-sm">
            <div>
                <div class="flex items-center justify-between mb-2">
                    <div class="flex items-center gap-2">
                        <span class="text-xs font-mono font-black px-2 py-0.5 bg-amber-500/15 text-amber-400 rounded-lg border border-amber-500/25">#${p.number || (idx + 1)}</span>
                        <span class="text-lg">${p.flag || '🏳️'}</span>
                    </div>
                    <span class="text-[10px] font-mono text-slate-400">${p.id}</span>
                </div>
                
                <h3 class="text-sm font-bold text-white uppercase truncate">${p.name || `Number ${p.number}`}</h3>
                <div class="text-xs text-amber-300 font-medium truncate">${p.country || 'Без страны'} • ${p.artist || 'Артист не указан'}</div>
                <div class="text-[11px] text-slate-400 italic truncate mb-1">«${p.song || 'Песня не указана'}»</div>
                ${p.artistLogin ? `<div class="text-[9px] text-amber-400/90 font-mono bg-[#0a0305] px-2 py-0.5 rounded border border-amber-500/20 truncate">🔑 Логин: ${p.artistLogin}</div>` : ''}
            </div>

            <div class="pt-3 border-t border-amber-500/15 flex items-center justify-between gap-2 mt-2">
                <button onclick="openParticipantEditorModal('${p.id}')" class="flex-1 bg-[#0a0305] hover:bg-amber-500/20 border border-amber-500/20 text-amber-300 text-[10px] font-bold uppercase py-1.5 rounded-lg transition">
                    ✎ Изменить
                </button>
                <button onclick="deleteAdminParticipant('${p.id}')" class="px-2.5 py-1.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 text-[10px] font-bold rounded-lg transition">
                    ✕
                </button>
            </div>
        </div>
    `).join('');
}

window.openParticipantEditorModal = function(participantId) {
    const modal = document.getElementById('participant-editor-modal');
    const titleEl = document.getElementById('participant-editor-title');
    const form = document.getElementById('participant-form');
    form.reset();

    if (participantId) {
        const p = (appState.participants || []).find(item => item.id === participantId);
        if (p) {
            titleEl.innerText = `Редактировать номер #${p.number || ''}`;
            document.getElementById('participant-edit-id').value = p.id;
            document.getElementById('participant-input-number').value = p.number || '';
            document.getElementById('participant-input-name').value = p.name || '';
            document.getElementById('participant-input-country').value = p.country || '';
            document.getElementById('participant-input-flag').value = p.flag || '';
            document.getElementById('participant-input-artist').value = p.artist || '';
            document.getElementById('participant-input-song').value = p.song || '';
            document.getElementById('participant-input-artist-login').value = p.artistLogin || p.linkedArtistLogin || '';
            document.getElementById('participant-input-postcard-video').value = p.postcardVideo || '';
            document.getElementById('participant-input-performance-video').value = p.performanceVideo || '';
            document.getElementById('participant-input-video').value = p.videoUrl || '';
            document.getElementById('participant-input-postcard').value = p.postcard || '';
        }
    } else {
        const nextNum = (appState.participants || []).length + 1;
        titleEl.innerText = "Добавить новый номер для голосования";
        document.getElementById('participant-edit-id').value = '';
        document.getElementById('participant-input-number').value = nextNum;
        document.getElementById('participant-input-name').value = `Number ${nextNum}`;
        document.getElementById('participant-input-artist-login').value = '';
        document.getElementById('participant-input-postcard-video').value = '';
        document.getElementById('participant-input-performance-video').value = '';
    }

    modal.classList.remove('hidden');
};

window.closeParticipantEditorModal = function() {
    document.getElementById('participant-editor-modal').classList.add('hidden');
};

document.getElementById('participant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('participant-edit-id').value;
    const number = parseInt(document.getElementById('participant-input-number').value, 10) || 1;
    const name = document.getElementById('participant-input-name').value.trim();
    const country = document.getElementById('participant-input-country').value.trim();
    const flag = document.getElementById('participant-input-flag').value.trim() || '🏳️';
    const artist = document.getElementById('participant-input-artist').value.trim();
    const song = document.getElementById('participant-input-song').value.trim();
    const artistLogin = document.getElementById('participant-input-artist-login').value.trim();
    const postcardVideo = document.getElementById('participant-input-postcard-video').value.trim();
    const performanceVideo = document.getElementById('participant-input-performance-video').value.trim();
    const videoUrl = document.getElementById('participant-input-video').value.trim();
    const postcard = document.getElementById('participant-input-postcard').value.trim();

    const participantData = {
        id: id || ('p' + Date.now()),
        number,
        name: name || `Number ${number}`,
        country: country || '',
        flag,
        artist: artist || '',
        song: song || '',
        artistLogin: artistLogin || '',
        postcardVideo: postcardVideo || '',
        performanceVideo: performanceVideo || '',
        videoUrl: videoUrl || `videos/thank_you_${id || 'p' + number}.mp4`,
        postcard
    };

    await saveParticipant(participantData);
    closeParticipantEditorModal();
    showToast(`Номер #${number} успешно сохранён`);
});

window.deleteAdminParticipant = function(id) {
    const p = (appState.participants || []).find(item => item.id === id);
    const label = p ? (p.name || `#${p.number}`) : id;
    openAdminConfirmModal({
        title: 'Удаление номера участника',
        message: `Удалить номер "${label}" из системы голосования?`,
        confirmText: 'Удалить номер',
        onConfirm: async () => {
            await deleteParticipant(id);
            showToast(`Участник ${label} удалён`);
        }
    });
};

window.resetParticipantsDefaults = function() {
    openAdminConfirmModal({
        title: 'Сброс участников',
        message: 'Сбросить список участников к стандартным 8 номерам HariVision?',
        confirmText: 'Сбросить к исходным',
        onConfirm: async () => {
            await resetParticipantsToDefault();
            showToast('Список номеров сброшен к исходным 8 участникам');
        }
    });
};

// -------------------------------------------------------------
// РАСЧЕТ И ОТОБРАЖЕНИЕ PUBLIC POINTS И ДЕТАЛИЗАЦИИ ГОЛОСОВАНИЯ
// -------------------------------------------------------------
function calculateAndRenderPublicPoints() {
    // Получаем все голоса
    const votes = Array.isArray(appState.votes) ? appState.votes : [];
    const participants = (Array.isArray(appState.participants) && appState.participants.length > 0) ? appState.participants : DEFAULT_PARTICIPANTS;
    const manualThreshold = Number(appState.manualThreshold) || 0;
    const revealMode = Boolean(appState.revealMode);

    // Подготовка быстрого поиска и начальных сумм
    const totals = {};
    const participantMap = new Map();
    participants.forEach((p, idx) => {
        const numVal = p.number !== undefined ? Number(p.number) : (idx + 1);
        totals[p.id] = 0;
        totals[String(numVal)] = 0;
        participantMap.set(String(p.id).toLowerCase().trim(), p);
        participantMap.set(String(numVal), p);
        participantMap.set(`p${numVal}`.toLowerCase(), p);
        participantMap.set(`p${idx + 1}`.toLowerCase(), p);
        if (p.name) participantMap.set(p.name.toLowerCase().trim(), p);
        if (p.artist) participantMap.set(p.artist.toLowerCase().trim(), p);
    });

    let totalVotesCast = 0;

    votes.forEach(v => {
        if (!v || !v.allocations || typeof v.allocations !== 'object') return;
        Object.entries(v.allocations).forEach(([allocKey, count]) => {
            const num = Number(count) || 0;
            if (num <= 0) return;
            totalVotesCast += num;

            // Ищем соответствующего участника
            const matched = participantMap.get(String(allocKey).toLowerCase().trim()) || participants.find((p, idx) => {
                const numVal = p.number !== undefined ? Number(p.number) : (idx + 1);
                return String(p.id).toLowerCase() === String(allocKey).toLowerCase() ||
                       String(numVal) === String(allocKey) ||
                       `p${numVal}`.toLowerCase() === String(allocKey).toLowerCase() ||
                       `p${idx + 1}`.toLowerCase() === String(allocKey).toLowerCase() ||
                       (p.name && p.name.toLowerCase().trim() === String(allocKey).toLowerCase().trim());
            });

            if (matched) {
                totals[matched.id] = (totals[matched.id] || 0) + num;
            } else {
                totals[allocKey] = (totals[allocKey] || 0) + num;
            }
        });
    });

    // Формирование списка для ранжирования
    const results = participants.map((p, idx) => {
        const numVal = p.number !== undefined ? Number(p.number) : (idx + 1);
        const count = totals[p.id] || 0;
        const passed = count >= manualThreshold;
        const percent = totalVotesCast > 0 ? ((count / totalVotesCast) * 100).toFixed(1) : '0.0';
        return {
            id: p.id,
            number: numVal,
            name: p.name || `Number ${numVal}`,
            country: p.country || '',
            flag: p.flag || '🏳️',
            artist: p.artist || '',
            song: p.song || '',
            count,
            percent,
            passed
        };
    });

    // Сортировка: сначала прошедшие порог по убыванию голосов, затем не прошедшие
    results.sort((a, b) => {
        if (a.passed && !b.passed) return -1;
        if (!a.passed && b.passed) return 1;
        if (b.count !== a.count) return b.count - a.count;
        return a.number - b.number;
    });

    // Начисление Public Points с плотной нумерацией мест (Dense Ranking):
    // Участники с одинаковым количеством голосов делят одно и то же место и получают одинаковые баллы.
    // Следующий за ними участник получает следующее по порядку место (без пропуска номеров мест).
    // Например: (3 голоса -> 1 место / 100 pts), (2 голоса -> 2 место / 90 pts), (1 голос -> 3 место / 80 pts).
    let denseRank = 0;
    let lastVotesCount = null;
    let lastAssignedRank = null;
    let lastAssignedPoints = null;

    results.forEach((item) => {
        if (item.passed && item.count > 0) {
            if (lastVotesCount !== null && item.count === lastVotesCount) {
                // Ничья: делят то же самое место и получают те же баллы
                item.rank = lastAssignedRank;
                item.points = lastAssignedPoints;
            } else {
                // Следующее порядковое место (плотный ранг)
                denseRank++;
                const assignedPoints = PUBLIC_POINTS_SCALE[denseRank - 1] !== undefined ? PUBLIC_POINTS_SCALE[denseRank - 1] : 0;
                
                item.rank = denseRank;
                item.points = assignedPoints;
                
                lastVotesCount = item.count;
                lastAssignedRank = denseRank;
                lastAssignedPoints = assignedPoints;
            }
        } else {
            // Номера с 0 голосов или не прошедшие порог получают 0 баллов
            item.rank = '-';
            item.points = 0;
        }
    });

    // 1. Рендер таблицы Public Points
    const tbody = document.getElementById('public-table-body');
    if (tbody) {
        if (results.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-500 font-mono">Нет зарегистрированных номеров</td></tr>`;
        } else {
            tbody.innerHTML = results.map(item => `
                <tr class="hover:bg-amber-500/5 transition">
                    <td class="py-3 font-bold text-white flex items-center gap-2">
                        <span class="text-amber-400 font-mono font-black">#${item.number}</span>
                        <span class="text-base">${item.flag}</span>
                        <div class="flex flex-col">
                            <span class="truncate max-w-[200px] text-slate-100">${item.name}</span>
                            ${item.song || item.artist ? `<span class="text-[10px] text-slate-400 font-normal truncate max-w-[200px]">${item.artist ? item.artist + ' – ' : ''}«${item.song || 'Песня'}»</span>` : ''}
                        </div>
                    </td>
                    <td class="py-3">
                        <div class="flex items-center gap-2">
                            <span class="font-bold ${item.count > 0 ? 'text-amber-300' : 'text-slate-500'} font-mono text-sm">${item.count}</span>
                            <span class="text-[10px] text-slate-500 font-mono">(${item.percent}%)</span>
                        </div>
                    </td>
                    <td class="py-3">
                        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${item.passed ? 'bg-green-950/60 text-green-400 border border-green-500/30' : 'bg-rose-950/40 text-rose-400 border border-rose-500/20'}">
                            ${item.passed ? '✓ Пройден' : '✗ Ниже порога'}
                        </span>
                    </td>
                    <td class="py-3 font-bold text-slate-300 font-mono">${item.rank}</td>
                    <td class="py-3 font-black text-sm ${revealMode ? 'text-amber-400 font-mono text-base' : 'text-slate-600'}">
                        ${revealMode ? `${item.points} pts` : '🔒 Скрыто'}
                    </td>
                </tr>
            `).join('');
        }
    }

    // 2. Обновление счетчиков в карточке статистики
    const votersCountEl = document.getElementById('voters-count');
    if (votersCountEl) votersCountEl.innerText = votes.length;

    const votersTotalPointsCastEl = document.getElementById('voters-total-points-cast');
    if (votersTotalPointsCastEl) {
        votersTotalPointsCastEl.innerText = `Всего отдано голосов: ${totalVotesCast}`;
    }

    // 3. Рендер быстрых чипов зрителей
    const votersListEl = document.getElementById('voters-list');
    if (votersListEl) {
        if (votes.length === 0) {
            votersListEl.innerHTML = `<span class="text-xs text-slate-500 italic">Пока никто не проголосовал</span>`;
        } else {
            votersListEl.innerHTML = votes.map(v => {
                const totalGiven = v.totalVotesGiven || Object.values(v.allocations || {}).reduce((s, x) => s + (Number(x) || 0), 0);
                const roleIcon = v.userRole === 'artist' ? '⭐' : (v.isNational ? '🌍' : '👤');
                const roleBadge = v.userRole === 'artist' ? '⭐ ' : (v.isNational ? '🌍 ' : '');
                return `
                    <button onclick="inspectVote('${v.id}')" class="bg-[#16070b] hover:bg-amber-500/20 border border-amber-500/20 text-slate-200 text-[11px] font-medium px-2.5 py-1.5 rounded-xl transition flex items-center gap-1.5 cursor-pointer">
                        <span>${roleIcon}</span>
                        <span class="truncate max-w-[120px] font-bold">${roleBadge}${escapeHtml(v.voterName || 'Зритель')}</span>
                        <span class="text-[10px] font-mono text-amber-400 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded-lg">(${totalGiven})</span>
                    </button>
                `;
            }).join('');
        }
    }

    // 4. Рендер детальной таблицы всех голосов
    const detailedBadgeEl = document.getElementById('detailed-votes-badge');
    if (detailedBadgeEl) {
        detailedBadgeEl.innerText = `Всего голосов: ${votes.length} (отдано: ${totalVotesCast})`;
    }

    const detailedTableBody = document.getElementById('detailed-votes-table-body');
    if (detailedTableBody) {
        if (votes.length === 0) {
            detailedTableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="py-8 text-center text-slate-500 font-mono text-xs">
                        Пока не поступило ни одного голоса в текущей сессии
                    </td>
                </tr>
            `;
        } else {
            detailedTableBody.innerHTML = votes.map((v, idx) => {
                const totalGiven = v.totalVotesGiven || Object.values(v.allocations || {}).reduce((s, x) => s + (Number(x) || 0), 0);
                const isArtist = v.userRole === 'artist';
                const isNational = Boolean(v.isNational);

                let roleBadgeHtml = '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">👤 Зритель</span>';
                if (isArtist) {
                    roleBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">⭐ Артист (${escapeHtml(v.artistName || v.voterName)})</span>`;
                } else if (isNational) {
                    roleBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">🌍 Национальное (${escapeHtml(v.representative || 'Жюри')})</span>`;
                }

                // Форматирование распределения
                const allocItems = Object.entries(v.allocations || {})
                    .filter(([_, count]) => (Number(count) || 0) > 0)
                    .map(([allocKey, count]) => {
                        const num = Number(count) || 0;
                        const p = participantMap.get(String(allocKey).toLowerCase().trim()) || participants.find((item, pIdx) => {
                            const n = item.number !== undefined ? Number(item.number) : (pIdx + 1);
                            return String(item.id).toLowerCase() === String(allocKey).toLowerCase() ||
                                   String(n) === String(allocKey) ||
                                   `p${n}`.toLowerCase() === String(allocKey).toLowerCase() ||
                                   `p${pIdx + 1}`.toLowerCase() === String(allocKey).toLowerCase() ||
                                   (item.name && item.name.toLowerCase().trim() === String(allocKey).toLowerCase().trim());
                        });
                        const flag = p ? (p.flag || '🏳️') : '';
                        const pNumber = p ? (p.number !== undefined ? p.number : '') : '';
                        const numVal = pNumber !== '' ? `#${pNumber}` : allocKey;
                        const label = p ? (p.name || numVal) : numVal;
                        return `<span class="inline-flex items-center gap-1 bg-[#16070b] border border-amber-500/20 px-2 py-0.5 rounded-lg text-[11px] font-mono"><span class="text-xs">${flag}</span><span class="font-bold text-slate-200">${label}:</span> <span class="text-amber-400 font-bold">${num}</span></span>`;
                    }).join(' ');

                return `
                    <tr class="hover:bg-amber-500/5 transition">
                        <td class="py-3 font-mono text-slate-500">#${idx + 1}</td>
                        <td class="py-3 font-bold text-white">
                            <div class="flex flex-col">
                                <span class="text-slate-100">${escapeHtml(v.voterName || 'Анонимный зритель')}</span>
                                ${v.voterEmail ? `<span class="text-[10px] font-mono text-slate-500">${v.voterEmail}</span>` : ''}
                            </div>
                        </td>
                        <td class="py-3">${roleBadgeHtml}</td>
                        <td class="py-3">
                            <div class="flex flex-wrap gap-1 max-w-md">
                                ${allocItems || '<span class="text-slate-500 italic text-xs">Нет распределения</span>'}
                            </div>
                        </td>
                        <td class="py-3 font-mono font-black text-amber-400 text-sm">
                            ${totalGiven} <span class="text-[10px] text-slate-400 font-normal">гол.</span>
                        </td>
                        <td class="py-3 text-right">
                            <div class="flex items-center justify-end gap-2">
                                <button onclick="inspectVote('${v.id}')" class="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 rounded-lg border border-amber-500/20 text-[11px] font-bold transition">
                                    Подробнее
                                </button>
                                <button onclick="deleteVote('${v.id}')" class="px-2.5 py-1 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 rounded-lg border border-rose-500/20 text-[11px] font-bold transition">
                                    Аннулировать
                                </button>
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }

    // 5. Кнопка раскрытия результатов
    const revealBtn = document.getElementById('reveal-btn');
    if (revealBtn) {
        if (revealMode) {
            revealBtn.className = "w-full bg-green-700/80 hover:bg-green-600 text-white font-extrabold text-xs uppercase tracking-widest py-4 transition rounded-xl shadow-lg mt-4";
            revealBtn.innerText = "✓ Public Points раскрыты для всех";
        } else {
            revealBtn.className = "w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-slate-950 font-extrabold text-xs uppercase tracking-widest py-4 transition rounded-xl shadow-lg mt-4";
            revealBtn.innerText = "Раскрыть Public Points";
        }
    }
}

// -------------------------------------------------------------
// ТАЙМЕР И СТАТУС ГОЛОСОВАНИЯ В АДМИНКЕ
// -------------------------------------------------------------
function updateVotingSessionUI() {
    const vState = appState.votingState || { status: 'closed' };
    const isOpen = vState.status === 'open';
    const endsAtMs = (isOpen && vState.endsAt) ? new Date(vState.endsAt).getTime() : null;
    const isExpired = endsAtMs ? endsAtMs <= Date.now() : false;

    const indicator = document.getElementById('live-indicator');
    const openControls = document.getElementById('open-controls');
    const closeControls = document.getElementById('close-controls');
    const timerDisplay = document.getElementById('timer-display');

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    if (isOpen && !isExpired) {
        if (indicator) {
            indicator.className = "flex items-center gap-2 text-xs font-bold uppercase tracking-widest px-3 py-1 bg-green-950/60 text-green-400 border border-green-500/40 rounded-full";
            indicator.innerHTML = `<span class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Прямой эфир (Открыто)`;
        }
        if (openControls) openControls.classList.add('hidden');
        if (closeControls) closeControls.classList.remove('hidden');

        const updateTimerText = () => {
            if (!endsAtMs) {
                if (timerDisplay) timerDisplay.innerText = "Голосование открыто без лимита времени";
                return;
            }
            const diff = endsAtMs - Date.now();
            if (diff <= 0) {
                if (timerInterval) clearInterval(timerInterval);
                if (timerDisplay) timerDisplay.innerText = "Время голосования истекло";
                updateVotingSessionUI();
            } else {
                const mins = Math.floor(diff / 60000);
                const secs = Math.floor((diff % 60000) / 1000);
                if (timerDisplay) timerDisplay.innerText = `Голосование завершится через: ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            }
        };

        updateTimerText();
        timerInterval = setInterval(updateTimerText, 1000);
    } else {
        if (indicator) {
            indicator.className = "flex items-center gap-2 text-xs font-bold uppercase tracking-widest px-3 py-1 bg-rose-950/40 text-rose-400 border border-rose-500/30 rounded-full";
            indicator.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500"></span> ${isExpired ? 'Время истекло' : 'Закрыто'}`;
        }
        if (openControls) openControls.classList.remove('hidden');
        if (closeControls) closeControls.classList.add('hidden');
        if (timerDisplay) timerDisplay.innerText = isExpired ? "Время голосования истекло" : "Голосование не активно";
    }
}

// -------------------------------------------------------------
// РАЗДЕЛ 2: УПРАВЛЕНИЕ НОВОСТЯМИ (NEWS CRUD)
// -------------------------------------------------------------
function renderAdminNews() {
    const container = document.getElementById('admin-news-list');
    if (!container) return;

    const list = sortNewsDescending(appState.news || []);
    if (list.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-10 text-xs text-slate-400">Список новостей пуст. Создайте первую публикацию!</div>`;
        return;
    }

    container.innerHTML = list.map(n => `
        <div class="bg-[#0d0408]/90 border border-amber-500/20 p-5 rounded-3xl backdrop-blur-xl flex flex-col justify-between shadow-lg">
            <div>
                <div class="flex items-center justify-between text-[10px] font-mono text-amber-400 mb-2">
                    <span class="px-2 py-0.5 bg-amber-500/10 rounded-full border border-amber-500/20">${n.category || n.tag || 'Новость'}</span>
                    <span>${n.date}</span>
                </div>
                <h3 class="text-sm font-bold text-white uppercase tracking-wide line-clamp-2 mb-2">${n.title}</h3>
                <p class="text-xs text-slate-300 line-clamp-3 leading-relaxed font-normal">${n.summary}</p>
                <div class="flex items-center gap-1.5 mt-2.5">
                    ${n.coverImage ? '<span class="text-[9px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">📷 Фото</span>' : ''}
                    ${n.videoUrl ? '<span class="text-[9px] font-bold bg-red-950/60 text-red-300 border border-red-500/40 px-2 py-0.5 rounded-full">🎬 Плеер</span>' : ''}
                </div>
            </div>

            <div class="pt-4 mt-4 border-t border-amber-500/15 flex items-center justify-between gap-3">
                <button onclick="openNewsEditorModal('${n.id}')" class="flex-1 bg-[#16070b] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs uppercase py-2.5 rounded-xl transition text-center">
                    Редактировать
                </button>
                <button onclick="deleteAdminNews('${n.id}')" class="px-4 py-2.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase rounded-xl transition">
                    Удалить
                </button>
            </div>
        </div>
    `).join('');
}

// -------------------------------------------------------------
// ОБРАБОТКА ИЗОБРАЖЕНИЙ НОВОСТЕЙ (ГАЛЕРЕЯ, DRAG & DROP, PREVIEW)
// -------------------------------------------------------------
window.updateNewsImagePreview = function(urlOrData) {
    const previewEl = document.getElementById('news-image-preview');
    const placeholderEl = document.getElementById('news-image-placeholder');
    const removeBtn = document.getElementById('news-image-remove-btn');
    const input = document.getElementById('news-input-image');

    if (!previewEl || !placeholderEl) return;

    const val = (urlOrData !== undefined ? urlOrData : (input ? input.value : '')).trim();
    if (val) {
        previewEl.src = val;
        previewEl.classList.remove('hidden');
        placeholderEl.classList.add('hidden');
        if (removeBtn) removeBtn.classList.remove('hidden');
    } else {
        previewEl.src = '';
        previewEl.classList.add('hidden');
        placeholderEl.classList.remove('hidden');
        if (removeBtn) removeBtn.classList.add('hidden');
    }
};

window.clearNewsImage = function() {
    const input = document.getElementById('news-input-image');
    const fileInput = document.getElementById('news-input-file');
    if (input) input.value = '';
    if (fileInput) fileInput.value = '';
    window.updateNewsImagePreview('');
};

function processImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
        showToast('Пожалуйста, выберите файл изображения (JPG, PNG, WebP)', true);
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
            // Оптимизация и сжатие через HTML5 Canvas для быстрой загрузки
            const MAX_WIDTH = 1280;
            const MAX_HEIGHT = 1280;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > MAX_WIDTH) {
                    height = Math.round((height * MAX_WIDTH) / width);
                    width = MAX_WIDTH;
                }
            } else {
                if (height > MAX_HEIGHT) {
                    width = Math.round((width * MAX_HEIGHT) / height);
                    height = MAX_HEIGHT;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
            const input = document.getElementById('news-input-image');
            if (input) {
                input.value = compressedDataUrl;
            }
            window.updateNewsImagePreview(compressedDataUrl);
            showToast('Изображение из галереи успешно загружено');
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
}

window.handleNewsImageFileUpload = function(event) {
    const file = event.target.files && event.target.files[0];
    if (file) {
        processImageFile(file);
    }
};

window.handleNewsImageDragOver = function(e) {
    e.preventDefault();
    const zone = document.getElementById('news-image-dropzone');
    if (zone) {
        zone.classList.add('border-amber-400', 'bg-amber-500/10');
    }
};

window.handleNewsImageDragLeave = function(e) {
    e.preventDefault();
    const zone = document.getElementById('news-image-dropzone');
    if (zone) {
        zone.classList.remove('border-amber-400', 'bg-amber-500/10');
    }
};

window.handleNewsImageDrop = function(e) {
    e.preventDefault();
    const zone = document.getElementById('news-image-dropzone');
    if (zone) {
        zone.classList.remove('border-amber-400', 'bg-amber-500/10');
    }
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        processImageFile(e.dataTransfer.files[0]);
    }
};

window.updateNewsVideoPreview = function(url) {
    const container = document.getElementById('news-video-preview-container');
    const playerEl = document.getElementById('news-video-preview-player');
    const input = document.getElementById('news-input-video');
    if (!container || !playerEl) return;

    const val = (url !== undefined ? url : (input ? input.value : '')).trim();
    if (val) {
        const playerHtml = renderVideoPlayerHTML(val, 'Тест плеера');
        if (playerHtml) {
            playerEl.innerHTML = playerHtml;
            container.classList.remove('hidden');
            return;
        }
    }
    playerEl.innerHTML = '';
    container.classList.add('hidden');
};

window.clearNewsVideo = function() {
    const input = document.getElementById('news-input-video');
    if (input) input.value = '';
    window.updateNewsVideoPreview('');
};

window.openNewsEditorModal = function(newsId) {
    const modal = document.getElementById('news-editor-modal');
    const titleEl = document.getElementById('news-editor-title');
    const form = document.getElementById('news-form');
    form.reset();

    if (newsId) {
        const article = (appState.news || []).find(n => n.id === newsId);
        if (article) {
            titleEl.innerText = "Редактирование новости";
            document.getElementById('news-edit-id').value = article.id;
            document.getElementById('news-input-title').value = article.title || '';
            document.getElementById('news-input-category').value = article.category || 'Конкурс';
            document.getElementById('news-input-date').value = article.date || '';
            document.getElementById('news-input-image').value = article.coverImage || '';
            document.getElementById('news-input-video').value = article.videoUrl || '';
            document.getElementById('news-input-summary').value = article.summary || '';
            document.getElementById('news-input-content').value = article.content || '';
            window.updateNewsImagePreview(article.coverImage || '');
            window.updateNewsVideoPreview(article.videoUrl || '');
        }
    } else {
        titleEl.innerText = "Создание новой публикации";
        document.getElementById('news-edit-id').value = '';
        document.getElementById('news-input-date').value = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        window.updateNewsImagePreview('');
        window.updateNewsVideoPreview('');
    }

    const notifyNewsCb = document.getElementById('news-notify-subscribers');
    if (notifyNewsCb) notifyNewsCb.checked = false;

    modal.classList.remove('hidden');
};

window.closeNewsEditorModal = function() {
    document.getElementById('news-editor-modal').classList.add('hidden');
    const notifyNewsCb = document.getElementById('news-notify-subscribers');
    if (notifyNewsCb) notifyNewsCb.checked = false;
    window.updateNewsImagePreview('');
    window.updateNewsVideoPreview(''); // stops background player audio
};

document.getElementById('news-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('news-edit-id').value;
    const title = document.getElementById('news-input-title').value.trim();
    const category = document.getElementById('news-input-category').value;
    const date = document.getElementById('news-input-date').value.trim();
    const coverImage = document.getElementById('news-input-image').value.trim();
    const videoUrl = document.getElementById('news-input-video').value.trim();
    const summary = document.getElementById('news-input-summary').value.trim();
    const content = document.getElementById('news-input-content').value.trim();
    const notifySubscribers = Boolean(document.getElementById('news-notify-subscribers')?.checked);

    const articleData = {
        id: id || ('news-' + Date.now()),
        title,
        category,
        tag: category,
        date,
        coverImage: coverImage || (videoUrl ? '' : 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=1200&auto=format&fit=crop'),
        videoUrl: videoUrl || '',
        summary,
        content
    };

    await saveNewsArticle(articleData, notifySubscribers);
    closeNewsEditorModal();
    showToast(notifySubscribers ? 'Новость сохранена, подписчикам отправлен Push!' : 'Новость успешно сохранена и опубликована!');
});

window.deleteAdminNews = function(id) {
    const article = (appState.news || []).find(n => n.id === id);
    const title = article ? article.title : id;
    openAdminConfirmModal({
        title: 'Удаление новости',
        message: `Вы действительно хотите удалить новость "${title}"? Она будет удалена с портала.`,
        confirmText: 'Удалить новость',
        onConfirm: async () => {
            await deleteNewsArticle(id);
            showToast('Новость успешно удалена');
        }
    });
};

// -------------------------------------------------------------
// РАЗДЕЛ 3: УПРАВЛЕНИЕ КОНКУРСАМИ (CONTESTS CRUD) + УЧАСТНИКИ СЕЗОНА
// -------------------------------------------------------------
let currentEditingContestParticipants = [];

function renderContestModalParticipants() {
    const container = document.getElementById('contest-participants-editor-list');
    if (!container) return;

    if (currentEditingContestParticipants.length === 0) {
        container.innerHTML = `
            <div class="text-center py-5 text-xs text-slate-400 border border-dashed border-amber-500/20 rounded-xl bg-[#0a0305]/50">
                В этом сезоне пока нет добавленных участников.<br>
                Нажмите <strong class="text-amber-400">«+ Добавить страну»</strong> или <strong class="text-amber-400">«📥 Импорт из финалистов»</strong>.
            </div>
        `;
        return;
    }

    container.innerHTML = currentEditingContestParticipants.map((p, idx) => {
        const hasPostcardVid = Boolean(p.postcardVideo && p.postcardVideo.trim());
        const hasPerfVid = Boolean(p.performanceVideo && p.performanceVideo.trim());

        return `
        <div class="bg-[#0a0305] border border-amber-500/20 hover:border-amber-500/40 p-4 rounded-2xl flex flex-col gap-3 transition shadow-sm">
            <div class="flex items-center justify-between gap-2 border-b border-amber-500/10 pb-2">
                <div class="flex items-center gap-2">
                    <span class="text-xs font-mono font-black text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">#${idx + 1}</span>
                    <span class="text-xs font-bold text-white uppercase">${p.country || 'Новая страна'}</span>
                    ${p.artist ? `<span class="text-xs text-amber-300 font-medium">(${p.artist})</span>` : ''}
                </div>
                <div class="flex items-center gap-1.5">
                    <button type="button" onclick="moveContestParticipantUp(${idx})" title="Переместить выше" class="text-[10px] px-2 py-0.5 bg-[#16070b] hover:bg-amber-500/20 text-slate-300 rounded border border-amber-500/20 ${idx === 0 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" onclick="moveContestParticipantDown(${idx})" title="Переместить ниже" class="text-[10px] px-2 py-0.5 bg-[#16070b] hover:bg-amber-500/20 text-slate-300 rounded border border-amber-500/20 ${idx === currentEditingContestParticipants.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === currentEditingContestParticipants.length - 1 ? 'disabled' : ''}>▼</button>
                    <button type="button" onclick="removeParticipantFromCurrentContest(${idx})" class="text-[10px] px-2.5 py-0.5 bg-rose-950/60 hover:bg-rose-900 text-rose-300 font-bold rounded border border-rose-500/30 transition">✕ Удалить</button>
                </div>
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Флаг</label>
                    <input type="text" value="${p.flag || '🏳️'}" oninput="updateContestParticipantField(${idx}, 'flag', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2 py-1.5 text-xs text-white rounded-lg text-center" />
                </div>
                <div class="sm:col-span-2">
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Страна</label>
                    <input type="text" value="${p.country || ''}" placeholder="Страна" oninput="updateContestParticipantField(${idx}, 'country', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Место / Ранг</label>
                    <input type="number" value="${p.rank !== undefined && p.rank !== null ? p.rank : ''}" placeholder="1" oninput="updateContestParticipantField(${idx}, 'rank', this.value ? parseInt(this.value, 10) : null)" class="w-full bg-[#16070b] border border-amber-500/25 px-2 py-1.5 text-xs text-white rounded-lg font-mono text-center" />
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Исполнитель</label>
                    <input type="text" value="${p.artist || ''}" placeholder="Имя исполнителя" oninput="updateContestParticipantField(${idx}, 'artist', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Песня</label>
                    <input type="text" value="${p.song || ''}" placeholder="Название песни" oninput="updateContestParticipantField(${idx}, 'song', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Баллы (Public Pts)</label>
                    <input type="number" value="${p.points !== undefined && p.points !== null ? p.points : ''}" placeholder="0" oninput="updateContestParticipantField(${idx}, 'points', this.value ? parseInt(this.value, 10) : null)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg font-mono text-center" />
                </div>
            </div>

            <!-- ВИДЕО-ОТКРЫТКА АРТИСТА (POSTCARD VIDEO) -->
            <div class="bg-[#16070b] border border-amber-500/20 p-2.5 rounded-xl">
                <div class="flex items-center justify-between mb-1.5">
                    <label class="text-[10px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                        <span>🎬</span> Видео-открытка артиста (Postcard Video Player)
                    </label>
                    <div class="flex items-center gap-2">
                        ${hasPostcardVid ? `<span class="text-[9px] font-bold text-green-400 bg-green-950/60 border border-green-500/30 px-2 py-0.5 rounded-full">● Видео подключено</span>` : `<span class="text-[9px] text-slate-500">Не загружено</span>`}
                        ${hasPostcardVid ? `
                            <button type="button" onclick="clearContestParticipantVideo(${idx}, 'postcardVideo')" class="text-[9px] text-rose-400 hover:text-rose-300 font-bold uppercase underline">
                                Убрать видео
                            </button>
                        ` : ''}
                    </div>
                </div>
                <input type="text" value="${p.postcardVideo || ''}" placeholder="Ссылка на плеер открытки: https://rutube.ru/play/embed/... или YouTube / VK" oninput="updateContestParticipantField(${idx}, 'postcardVideo', this.value)" class="w-full bg-[#0a0305] border border-amber-500/25 px-3 py-1.5 text-xs text-white rounded-lg focus:outline-none focus:border-amber-400 font-mono" />
            </div>

            <!-- ВИДЕО ПОЛНОГО ВЫСТУПЛЕНИЯ (PERFORMANCE VIDEO) -->
            <div class="bg-[#16070b] border border-amber-500/20 p-2.5 rounded-xl">
                <div class="flex items-center justify-between mb-1.5">
                    <label class="text-[10px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1">
                        <span>🎤</span> Видео полного выступления (Full Performance Video Player)
                    </label>
                    <div class="flex items-center gap-2">
                        ${hasPerfVid ? `<span class="text-[9px] font-bold text-green-400 bg-green-950/60 border border-green-500/30 px-2 py-0.5 rounded-full">● Запись подключена</span>` : `<span class="text-[9px] text-slate-500">Не загружено</span>`}
                        ${hasPerfVid ? `
                            <button type="button" onclick="clearContestParticipantVideo(${idx}, 'performanceVideo')" class="text-[9px] text-rose-400 hover:text-rose-300 font-bold uppercase underline">
                                Убрать видео
                            </button>
                        ` : ''}
                    </div>
                </div>
                <input type="text" value="${p.performanceVideo || ''}" placeholder="Ссылка на плеер выступления: https://rutube.ru/play/embed/... или YouTube / VK" oninput="updateContestParticipantField(${idx}, 'performanceVideo', this.value)" class="w-full bg-[#0a0305] border border-amber-500/25 px-3 py-1.5 text-xs text-white rounded-lg focus:outline-none focus:border-amber-400 font-mono" />
            </div>

            <div>
                <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Описание открытки (текст, опционально)</label>
                <input type="text" value="${p.postcard || ''}" placeholder="Тематика открытки: Дворец Шёнбрунн и симфония огней" oninput="updateContestParticipantField(${idx}, 'postcard', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1 text-[11px] text-slate-300 rounded-lg" />
            </div>
        </div>
    `}).join('');
}

window.clearContestParticipantVideo = function(index, field) {
    if (currentEditingContestParticipants[index]) {
        currentEditingContestParticipants[index][field] = '';
        renderContestModalParticipants();
    }
};

window.updateContestParticipantField = function(index, field, value) {
    if (currentEditingContestParticipants[index]) {
        currentEditingContestParticipants[index][field] = value;
    }
};

window.addParticipantToCurrentContest = function() {
    const num = currentEditingContestParticipants.length + 1;
    currentEditingContestParticipants.push({
        id: 'c-part-' + Date.now() + '-' + num,
        country: `Страна ${num}`,
        flag: '🏳️',
        artist: '',
        song: '',
        rank: null,
        points: null,
        postcard: '',
        postcardVideo: '',
        performanceVideo: ''
    });
    renderContestModalParticipants();
};

window.removeParticipantFromCurrentContest = function(index) {
    currentEditingContestParticipants.splice(index, 1);
    renderContestModalParticipants();
};

window.moveContestParticipantUp = function(index) {
    if (index <= 0) return;
    const item = currentEditingContestParticipants.splice(index, 1)[0];
    currentEditingContestParticipants.splice(index - 1, 0, item);
    renderContestModalParticipants();
};

window.moveContestParticipantDown = function(index) {
    if (index >= currentEditingContestParticipants.length - 1) return;
    const item = currentEditingContestParticipants.splice(index, 1)[0];
    currentEditingContestParticipants.splice(index + 1, 0, item);
    renderContestModalParticipants();
};

window.importActiveParticipantsToCurrentContest = function() {
    const parts = appState.participants || [];
    if (parts.length === 0) {
        showToast('В системе нет активных участников для импорта', true);
        return;
    }
    currentEditingContestParticipants = parts.map((p, idx) => ({
        id: p.id || ('part-' + (idx + 1)),
        country: p.country || (p.name || `Участник ${p.number}`),
        flag: p.flag || '🏳️',
        artist: p.artist || p.name || '',
        song: p.song || '',
        rank: null,
        points: null,
        postcard: p.postcard || '',
        postcardVideo: p.postcardVideo || '',
        performanceVideo: p.performanceVideo || p.videoUrl || ''
    }));
    renderContestModalParticipants();
    showToast(`Импортировано ${parts.length} участников`);
};

function renderAdminContests() {
    const container = document.getElementById('admin-contests-list');
    if (!container) return;

    const list = appState.contests || [];
    if (list.length === 0) {
        container.innerHTML = `<div class="col-span-full text-center py-10 text-xs text-slate-400">Список сезонов пуст. Создайте новый конкурс!</div>`;
        return;
    }

    container.innerHTML = list.map(c => {
        const participantCount = (c.countries || c.participants || []).length;
        return `
        <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 rounded-3xl backdrop-blur-xl flex flex-col justify-between shadow-lg">
            <div>
                <div class="flex items-center justify-between mb-3">
                    <span class="text-xs font-mono font-bold text-amber-400">${c.date || '2026'}</span>
                    <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full ${
                        c.status === 'live' ? 'bg-green-950/60 text-green-400 border border-green-500/30' :
                        (c.status === 'completed' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-slate-900 text-slate-400 border border-slate-700')
                    }">
                        ${c.status === 'live' ? '● Прямой эфир' : (c.status === 'completed' ? '✓ Завершён' : 'Предстоящий')}
                    </span>
                </div>

                <h3 class="text-lg font-black text-white uppercase tracking-wide mb-1">${c.title}</h3>
                <div class="text-xs text-amber-300 font-bold uppercase tracking-wider mb-3">«${c.slogan || 'Heart of Performance'}»</div>
                <p class="text-xs text-slate-300 line-clamp-3 leading-relaxed font-normal mb-3">${c.description || ''}</p>

                <div class="text-xs text-slate-400 space-y-1.5 pt-2 border-t border-amber-500/15">
                    <div><strong>Город:</strong> ${c.hostCity || 'TBD'}</div>
                    <div><strong>Участников:</strong> <span class="text-amber-400 font-bold font-mono">${participantCount}</span> стран</div>
                    ${c.winner ? `<div class="text-amber-300 font-bold">🏆 <strong>Победитель:</strong> ${c.winner.country} (${c.winner.artist})</div>` : ''}
                </div>
            </div>

            <div class="pt-4 mt-4 border-t border-amber-500/15 flex items-center justify-between gap-3">
                <button onclick="openContestEditorModal('${c.id}')" class="flex-1 bg-[#16070b] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs uppercase py-2.5 rounded-xl transition text-center">
                    Редактировать
                </button>
                <button onclick="deleteAdminContest('${c.id}')" class="px-4 py-2.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase rounded-xl transition">
                    Удалить
                </button>
            </div>
        </div>
    `}).join('');
}

window.openContestEditorModal = function(contestId) {
    const modal = document.getElementById('contest-editor-modal');
    const titleEl = document.getElementById('contest-editor-title');
    const form = document.getElementById('contest-form');
    form.reset();

    if (contestId) {
        const c = (appState.contests || []).find(item => item.id === contestId);
        if (c) {
            titleEl.innerText = "Редактирование сезона";
            document.getElementById('contest-edit-id').value = c.id;
            document.getElementById('contest-input-title').value = c.title || '';
            document.getElementById('contest-input-status').value = c.status || 'upcoming';
            document.getElementById('contest-input-slogan').value = c.slogan || '';
            document.getElementById('contest-input-date').value = c.date || '';
            document.getElementById('contest-input-city').value = c.hostCity || '';
            document.getElementById('contest-input-venue').value = c.venue || '';
            document.getElementById('contest-input-hosts').value = (c.hosts || []).join(', ');
            document.getElementById('contest-input-desc').value = c.description || '';
            document.getElementById('contest-input-video').value = c.videoUrl || '';
            
            if (c.winner) {
                document.getElementById('contest-winner-country').value = c.winner.country || '';
                document.getElementById('contest-winner-artist').value = c.winner.artist || '';
                document.getElementById('contest-winner-song').value = c.winner.song || '';
                document.getElementById('contest-winner-points').value = c.winner.points || '';
            }

            document.getElementById('contest-input-details').value = (c.knownDetails || []).join('\n');

            // Загружаем список участников сезона
            currentEditingContestParticipants = JSON.parse(safeJsonStringify(c.countries || c.participants || [], '[]')).map(p => ({
                ...p,
                postcardVideo: p.postcardVideo || '',
                performanceVideo: p.performanceVideo || ''
            }));
        }
    } else {
        titleEl.innerText = "Создание нового сезона";
        document.getElementById('contest-edit-id').value = '';
        currentEditingContestParticipants = [];
    }

    const notifyContestCb = document.getElementById('contest-notify-subscribers');
    if (notifyContestCb) notifyContestCb.checked = false;

    renderContestModalParticipants();
    modal.classList.remove('hidden');
};

window.closeContestEditorModal = function() {
    document.getElementById('contest-editor-modal').classList.add('hidden');
    const notifyContestCb = document.getElementById('contest-notify-subscribers');
    if (notifyContestCb) notifyContestCb.checked = false;
    currentEditingContestParticipants = [];
};

document.getElementById('contest-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('contest-edit-id').value;
    const title = document.getElementById('contest-input-title').value.trim();
    const status = document.getElementById('contest-input-status').value;
    const slogan = document.getElementById('contest-input-slogan').value.trim();
    const date = document.getElementById('contest-input-date').value.trim();
    const hostCity = document.getElementById('contest-input-city').value.trim();
    const venue = document.getElementById('contest-input-venue').value.trim();
    const hosts = document.getElementById('contest-input-hosts').value.split(',').map(s => s.trim()).filter(Boolean);
    const description = document.getElementById('contest-input-desc').value.trim();
    const videoUrl = document.getElementById('contest-input-video').value.trim();
    const notifySubscribers = Boolean(document.getElementById('contest-notify-subscribers')?.checked);

    const wCountry = document.getElementById('contest-winner-country').value.trim();
    const wArtist = document.getElementById('contest-winner-artist').value.trim();
    const wSong = document.getElementById('contest-winner-song').value.trim();
    const wPoints = parseInt(document.getElementById('contest-winner-points').value, 10);

    let winner = null;
    if (wCountry || wArtist) {
        winner = {
            country: wCountry,
            artist: wArtist,
            song: wSong,
            points: wPoints || 0
        };
    }

    const knownDetails = document.getElementById('contest-input-details').value
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

    // Участники конкурса из списка
    const countries = currentEditingContestParticipants.map((p, idx) => ({
        id: p.id || ('part-' + (idx + 1)),
        country: p.country || `Страна ${idx + 1}`,
        flag: p.flag || '🏳️',
        artist: p.artist || '',
        song: p.song || '',
        rank: p.rank !== undefined && p.rank !== null && p.rank !== '' ? Number(p.rank) : null,
        points: p.points !== undefined && p.points !== null && p.points !== '' ? Number(p.points) : null,
        postcard: p.postcard || '',
        postcardVideo: (p.postcardVideo || '').trim(),
        performanceVideo: (p.performanceVideo || '').trim()
    }));

    const contestData = {
        id: id || ('contest-' + Date.now()),
        title,
        status,
        slogan,
        date,
        hostCity,
        venue,
        hosts,
        description,
        videoUrl,
        recapUrl: videoUrl,
        winner,
        countries,
        participants: countries,
        knownDetails
    };

    await saveContest(contestData, notifySubscribers);
    closeContestEditorModal();
    showToast(notifySubscribers ? 'Сезон сохранен, подписчикам отправлен Push!' : 'Информация о конкурсе успешно сохранена!');
});

window.deleteAdminContest = function(id) {
    const contest = (appState.contests || []).find(c => c.id === id);
    const title = contest ? contest.title : id;
    openAdminConfirmModal({
        title: 'Удаление сезона',
        message: `Вы уверены, что хотите удалить сезон "${title}"? Все связанные данные сезона будут удалены.`,
        confirmText: 'Удалить сезон',
        onConfirm: async () => {
            await deleteContest(id);
            showToast('Конкурс удален');
        }
    });
};

// -------------------------------------------------------------
// ВЫБОР БАННЕРА НА ГЛАВНОМ МЕНЮ
// -------------------------------------------------------------
function updateBannerSelectUI() {
    const select = document.getElementById('banner-contest-select');
    const badge = document.getElementById('current-banner-badge');
    if (!select) return;

    const currentChoice = appState.featuredContestId || 'auto';
    const contests = appState.contests || [];

    let optionsHTML = `
        <option value="auto">🌟 Автоматически: Последний завершённый сезон</option>
        <option value="auto-live">🔴 Автоматически: Текущий активный (Live)</option>
    `;

    contests.forEach(c => {
        const statusLabel = c.status === 'live' ? '● В эфире' : (c.status === 'completed' ? '✓ Завершён' : '⏳ Скоро');
        optionsHTML += `
            <option value="${c.id}">[${statusLabel}] ${c.title || c.id} (${c.date || ''})</option>
        `;
    });

    select.innerHTML = optionsHTML;
    select.value = currentChoice;

    if (badge) {
        if (currentChoice === 'auto') {
            badge.innerText = 'Авто: Последний завершённый';
        } else if (currentChoice === 'auto-live') {
            badge.innerText = 'Авто: Текущий Live';
        } else {
            const found = contests.find(c => c.id === currentChoice);
            badge.innerText = found ? `Выбран: ${found.title}` : `ID: ${currentChoice}`;
        }
    }
}

window.saveFeaturedBannerFromSelect = async function() {
    const select = document.getElementById('banner-contest-select');
    const statusEl = document.getElementById('banner-save-status');
    if (!select) return;

    const chosenId = select.value;
    await saveFeaturedBanner(chosenId);

    if (statusEl) {
        statusEl.innerText = '✓ Настройка главного баннера успешно сохранена и применена!';
        statusEl.classList.remove('hidden');
        setTimeout(() => {
            statusEl.classList.add('hidden');
        }, 4000);
    }
    showToast('Баннер главного меню обновлен');
};

// -------------------------------------------------------------
// ГЛАВНЫЙ СЛУШАТЕЛЬ СОСТОЯНИЯ
// -------------------------------------------------------------
subscribeState((newState) => {
    appState = newState;

    // Синхронизация инпута порога
    const thresholdInput = document.getElementById('manual-threshold-input');
    if (thresholdInput && document.activeElement !== thresholdInput) {
        thresholdInput.value = appState.manualThreshold || 0;
    }

    // Синхронизация инпута ссылки на повтор
    const recapInput = document.getElementById('recap-video-url-input');
    if (recapInput && document.activeElement !== recapInput) {
        recapInput.value = appState.recapVideoUrl || '';
    }

    // Рендер всех секций
    renderAdminParticipants();
    calculateAndRenderPublicPoints();
    updateVotingSessionUI();
    renderAdminNews();
    renderAdminContests();
    renderAdminCalendar();
    updateBannerSelectUI();
});

// Прямой real-time слушатель коллекции votes из Firestore
if (db) {
    try {
        onSnapshot(collection(db, "votes"), (snapshot) => {
            if (!snapshot.empty) {
                const votesList = [];
                snapshot.forEach(docSnap => {
                    const raw = docSnap.data() || {};
                    const cleaned = sanitizeFirestoreData(raw) || {};
                    votesList.push({ id: docSnap.id, ...cleaned });
                });
                appState.votes = mergeVotes(appState.votes || [], votesList);
                calculateAndRenderPublicPoints();
            }
        }, (err) => {
            console.warn("Direct votes snapshot listener warning:", err);
        });
    } catch (e) {
        console.warn("Votes listener init error:", e);
    }
}

// -------------------------------------------------------------
// РАЗДЕЛ 4: NOTIFICATIONS & BROADCAST
// -------------------------------------------------------------
function showAdminNotification(message, type = 'info') {
    const isError = type === 'error';
    if (typeof showToast === 'function') {
        showToast(message, isError);
    } else {
        console.log(`[Admin Notification] [${type}]`, message);
    }
}
window.showAdminNotification = showAdminNotification;

window.testAdminNotification = async function() {
    if (!('Notification' in window)) {
        showAdminNotification('Уведомления не поддерживаются вашим браузером', 'error');
        return;
    }

    try {
        let perm = Notification.permission;
        if (perm === 'default') {
            perm = await Notification.requestPermission();
        }

        const iconUrl = new URL('icons/HBU_icon.png', window.location.href).href;
        const targetUrl = new URL('admin.html', window.location.href).href;

        if (perm === 'granted') {
            if ('serviceWorker' in navigator) {
                try {
                    const reg = await navigator.serviceWorker.ready;
                    await reg.showNotification('HariVision 2026 🔔 (Тест)', {
                        body: 'Это тестовое уведомление из панели управления администратора!',
                        icon: iconUrl,
                        badge: iconUrl,
                        data: { url: targetUrl }
                    });
                    showAdminNotification('Тестовое уведомление успешно отправлено!', 'success');
                    return;
                } catch (e) {}
            }
            new Notification('HariVision 2026 🔔 (Тест)', {
                body: 'Это тестовое уведомление из панели управления администратора!',
                icon: iconUrl
            });
            showAdminNotification('Тестовое уведомление успешно отправлено!', 'success');
        } else {
            showAdminNotification('Уведомления заблокированы в настройках браузера', 'error');
        }
    } catch (e) {
        showAdminNotification('Ошибка отправки уведомления: ' + e.message, 'error');
    }
};

window.refreshAdminPushSubscribers = async function() {
    try {
        let count = 0;
        try {
            const res = await fetch('/api/push/subscribers-count');
            if (res.ok) {
                const data = await res.json();
                count = data.count !== undefined ? data.count : 0;
            }
        } catch (e) {}

        if (count === 0) {
            // Правила Firestore разрешают листинг artistAccounts (где лежат push_sub_*)
            // только администратору — без ID-токена этот запрос всегда вернёт 0 / 403,
            // поэтому обязательно прикладываем Bearer-токен текущего вошедшего админа.
            try {
                if (auth && auth.currentUser && !auth.currentUser.isAnonymous) {
                    const idToken = await auth.currentUser.getIdToken();
                    const fsRes = await fetch('https://firestore.googleapis.com/v1/projects/voting-91412/databases/(default)/documents/artistAccounts?key=AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw&pageSize=300', {
                        headers: { 'Authorization': `Bearer ${idToken}` }
                    });
                    if (fsRes.ok) {
                        const fsData = await fsRes.json();
                        const subs = (fsData.documents || []).filter(d => d.fields?.type?.stringValue === 'push_sub');
                        if (subs.length > 0) count = subs.length;
                    } else {
                        console.warn('[Push] Firestore fallback listing denied:', fsRes.status);
                    }
                }
            } catch (e2) {
                console.warn('[Push] Firestore fallback error:', e2);
            }
        }

        const badge = document.getElementById('admin-push-subscribers-badge');
        if (badge) {
            badge.innerText = count;
        }
    } catch (e) {
        console.warn('Error refreshing subscribers count:', e);
    }
};

window.testAdminPushNotification = async function() {
    let token = localStorage.getItem('harivision_admin_token') || await registerCurrentAdminSession() || '';
    try {
        showAdminNotification('Отправка тестового Web Push...', 'info');
        let pushed = false;
        try {
            const res = await fetch('/api/admin/push-test', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });
            const data = await res.json();
            if (res.ok && data.success) {
                pushed = true;
                if (data.total === 0) {
                    showAdminNotification(`Внимание: 0 подписанных устройств в базе. Нажмите колокольчик 🔔 на сайте, чтобы подписать это устройство!`, 'info');
                } else {
                    showAdminNotification(`Web Push успешно отправлен на ${data.sent} из ${data.total} подписанных устройств!`, 'success');
                }
                window.refreshAdminPushSubscribers();
                return;
            }
        } catch (e) {}

        if (!pushed) {
            const fsUrl = `https://firestore.googleapis.com/v1/projects/voting-91412/databases/(default)/documents/artistAccounts/broadcast_queue?key=AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw`;
            const testTag = 'test-push-' + Date.now();
            await fetch(fsUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        title: { stringValue: '🧪 Тестовый Push HariVision 2026' },
                        body: { stringValue: 'Проверка фонового канала Web Push! Доставка при закрытом сайте работает!' },
                        url: { stringValue: '/#voting' },
                        tag: { stringValue: testTag },
                        createdAt: { integerValue: String(Date.now()) },
                        processed: { booleanValue: false }
                    }
                })
            });
            showAdminNotification('Запрос на тестовый Web Push отправлен в облачную очередь сервера!', 'success');
            window.refreshAdminPushSubscribers();
        }
    } catch (e) {
        showAdminNotification('Ошибка тестового Push: ' + e.message, 'error');
    }
};

window.subscribeCurrentAdminDevice = async function() {
    if (typeof window === 'undefined') return;

    if (!('Notification' in window)) {
        showAdminNotification('Уведомления не поддерживаются данным браузером', 'error');
        return;
    }

    if (!('serviceWorker' in navigator)) {
        showAdminNotification('Service Worker не поддерживается данным браузером', 'error');
        return;
    }

    try {
        let perm = Notification.permission;
        if (perm === 'default') {
            if (window.self !== window.top) {
                // Внутри iframe браузер блокирует модальное окно разрешения уведомлений
                showAdminNotification('Открываем панель в отдельной вкладке для подтверждения разрешения браузера...', 'info');
                try {
                    const win = window.open(window.location.origin + '/admin.html?autoSubscribe=1', '_blank');
                    if (win) return;
                } catch (e) {}
                showAdminNotification('⚠️ Откройте сайт в отдельной вкладке (кнопка ↗ вверху), где браузер разрешает Push-уведомления.', 'error');
                return;
            }
            try {
                perm = await Notification.requestPermission();
            } catch (pErr) {
                showAdminNotification('Ошибка вызова разрешения: ' + pErr.message, 'error');
                return;
            }
        }

        if (perm !== 'granted') {
            showAdminNotification('Разрешение не предоставлено: ' + perm + '. Включите уведомления в настройках сайта в браузере.', 'error');
            return;
        }

        showAdminNotification('Регистрация устройства в Web Push...', 'info');

        const result = await syncPushSubscription();
        if (result && result.success) {
            showAdminNotification('✅ Устройство успешно подписано на Web Push!', 'success');
            if (typeof window.refreshAdminPushSubscribers === 'function') {
                window.refreshAdminPushSubscribers();
            }
        } else {
            showAdminNotification('Ошибка подписки: ' + (result?.error || result?.reason || 'Неизвестная ошибка'), 'error');
        }
    } catch (e) {
        showAdminNotification('Ошибка подписки: ' + e.message, 'error');
    }
};

// Авто-подписка при переходе по ссылке из iframe
if (typeof window !== 'undefined' && window.location.search.includes('autoSubscribe=1') && window.self === window.top) {
    window.addEventListener('load', () => {
        setTimeout(() => {
            if (typeof window.subscribeCurrentAdminDevice === 'function') {
                window.subscribeCurrentAdminDevice();
            }
        }, 600);
    });
}

// Загружаем число подписчиков при инициализации
setTimeout(() => {
    if (typeof window.refreshAdminPushSubscribers === 'function') {
        window.refreshAdminPushSubscribers();
    }
}, 1000);

window.handleAdminBroadcastSubmit = async function(event) {
    if (event) event.preventDefault();

    const titleEl = document.getElementById('admin-broadcast-title');
    const bodyEl = document.getElementById('admin-broadcast-body');
    const urlEl = document.getElementById('admin-broadcast-url');
    const submitBtn = document.getElementById('admin-broadcast-submit-btn');
    const resultMsg = document.getElementById('broadcast-result-msg');

    const title = titleEl ? titleEl.value.trim() : '';
    const message = bodyEl ? bodyEl.value.trim() : '';
    const url = urlEl ? urlEl.value.trim() : '/';

    if (!title || !message) {
        showAdminNotification('Пожалуйста, заполните заголовок и текст', 'error');
        return;
    }

    let token = localStorage.getItem('harivision_admin_token') || await registerCurrentAdminSession() || '';

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Отправка...';
    }

    try {
        let sentDirectly = false;
        let data = null;
        try {
            const res = await fetch('/api/admin/broadcast-notification', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ title, message, url })
            });
            if (res.ok) {
                data = await res.json();
                if (data.success) {
                    sentDirectly = true;
                }
            }
        } catch (apiErr) {}

        // Резервное сохранение в облачную очередь Firestore (для надежной доставки, в т.ч. на GitHub Pages)
        try {
            const bcastTag = 'bcast_' + Date.now();
            const payloadFields = {
                title: { stringValue: title },
                body: { stringValue: message },
                url: { stringValue: url },
                tag: { stringValue: bcastTag },
                createdAt: { integerValue: String(Date.now()) },
                processed: { booleanValue: sentDirectly }
            };

            const fsUrl = `https://firestore.googleapis.com/v1/projects/voting-91412/databases/(default)/documents/artistAccounts/broadcast_queue?key=AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw`;
            await fetch(fsUrl, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fields: payloadFields })
            });
        } catch (fsErr) {
            console.warn('Firestore broadcast queue note:', fsErr);
        }

        if (sentDirectly && data) {
            const pushInfo = data.pushSubscribers ? ` и на ${data.pushSent || 0} устр. (Push)` : '';
            showAdminNotification(`Уведомление разослано! Онлайн: ${data.sentToClients}${pushInfo}`, 'success');
            if (resultMsg) {
                resultMsg.className = 'text-xs font-bold text-green-400 block';
                resultMsg.innerText = `✓ Уведомление успешно отправлено (${data.sentToClients} онлайн-вкладок, ${data.pushSent || 0} из ${data.pushSubscribers || 0} push-устройств).`;
                setTimeout(() => { resultMsg.className = 'hidden'; }, 5000);
            }
            if (bodyEl) bodyEl.value = '';
        } else {
            showAdminNotification('Уведомление отправлено в облачную очередь сервера! Web Push будет доставлен на все подписанные устройства.', 'success');
            if (resultMsg) {
                resultMsg.className = 'text-xs font-bold text-green-400 block';
                resultMsg.innerText = '✓ Уведомление успешно поставлено в очередь фонового сервера.';
                setTimeout(() => { resultMsg.className = 'hidden'; }, 5000);
            }
            if (bodyEl) bodyEl.value = '';
        }
    } catch (e) {
        showAdminNotification('Ошибка отправки: ' + e.message, 'error');
        if (resultMsg) {
            resultMsg.className = 'text-xs font-bold text-rose-400 block';
            resultMsg.innerText = `✕ ${e.message}`;
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>🚀</span><span>Отправить всем пользователям</span>';
        }
    }
};

// -------------------------------------------------------------
// РАЗДЕЛ 5: УПРАВЛЕНИЕ КАЛЕНДАРЕМ (СОБЫТИЯ, АНОНСЫ, МЕДИА)
// -------------------------------------------------------------
let adminCalendarFilter = 'all';

window.setAdminCalendarFilter = function(filter) {
    adminCalendarFilter = filter;
    const filterButtons = ['all', 'announcement', 'contest', 'event', 'holiday'];
    filterButtons.forEach(f => {
        const btn = document.getElementById(`admin-cal-filter-${f}`);
        if (!btn) return;
        if (f === filter) {
            btn.className = "px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-amber-500 text-slate-950 transition";
        } else {
            const colors = {
                announcement: 'text-sky-400 border-sky-500/20',
                contest: 'text-amber-300 border-amber-500/20',
                event: 'text-emerald-400 border-emerald-500/20',
                holiday: 'text-rose-400 border-rose-500/20',
                all: 'text-slate-300 border-amber-500/20'
            };
            btn.className = `px-3.5 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider bg-[#16070b] ${colors[f] || 'text-slate-300'} hover:bg-amber-500/10 border transition`;
        }
    });
    renderAdminCalendar();
};

const CALENDAR_TYPE_CONFIG = {
    announcement: {
        label: 'Анонс',
        icon: '📢',
        colorClass: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
        badgeBorder: 'border-sky-500/30'
    },
    contest: {
        label: 'Конкурс / Шоу',
        icon: '🏆',
        colorClass: 'bg-amber-500/20 text-amber-300 border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.2)]',
        badgeBorder: 'border-amber-400/50'
    },
    event: {
        label: 'Ивент',
        icon: '🎪',
        colorClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
        badgeBorder: 'border-emerald-500/30'
    },
    holiday: {
        label: 'Праздник',
        icon: '🎉',
        colorClass: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
        badgeBorder: 'border-rose-500/30'
    }
};

const RUSSIAN_MONTH_NAMES = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];

let adminCalendarYear = 2026;
let adminCalendarMonth = 8; // Сентябрь 2026
let adminSelectedDate = '2026-09-25';
let adminQuickFormOpen = false;

window.selectAdminCalendarDate = function(dateStr) {
    adminSelectedDate = dateStr;
    adminQuickFormOpen = false;
    renderAdminCalendarGrid();
    renderAdminSelectedDateCard();
};

window.prevAdminCalendarMonth = function() {
    adminCalendarMonth--;
    if (adminCalendarMonth < 0) {
        adminCalendarMonth = 11;
        adminCalendarYear--;
    }
    renderAdminCalendarGrid();
    renderAdminSelectedDateCard();
};

window.nextAdminCalendarMonth = function() {
    adminCalendarMonth++;
    if (adminCalendarMonth > 11) {
        adminCalendarMonth = 0;
        adminCalendarYear++;
    }
    renderAdminCalendarGrid();
    renderAdminSelectedDateCard();
};

window.goToTodayAdminCalendar = function() {
    const today = new Date();
    adminCalendarYear = today.getFullYear();
    adminCalendarMonth = today.getMonth();
    adminSelectedDate = today.toISOString().split('T')[0];
    adminQuickFormOpen = false;
    renderAdminCalendarGrid();
    renderAdminSelectedDateCard();
};

window.toggleAdminQuickNoteForm = function(forceState = null) {
    adminQuickFormOpen = (forceState !== null) ? forceState : !adminQuickFormOpen;
    renderAdminSelectedDateCard();
    if (adminQuickFormOpen) {
        setTimeout(() => {
            const titleInp = document.getElementById('admin-quick-note-title');
            if (titleInp) titleInp.focus();
        }, 50);
    }
};

window.renderAdminCalendarGrid = function() {
    const gridEl = document.getElementById('admin-calendar-grid');
    const monthTitleEl = document.getElementById('admin-calendar-month-title');
    if (!gridEl) return;

    if (monthTitleEl) {
        monthTitleEl.innerText = `${RUSSIAN_MONTH_NAMES[adminCalendarMonth]} ${adminCalendarYear}`;
    }

    const notes = Array.isArray(appState.calendarNotes) ? appState.calendarNotes : [];
    const todayStr = new Date().toISOString().split('T')[0];

    // Если дата не выбрана, выберем сегодня или первую дату с событием
    if (!adminSelectedDate) {
        const firstInMonth = notes.find(n => n.date && n.date.startsWith(`${adminCalendarYear}-${String(adminCalendarMonth + 1).padStart(2, '0')}`));
        adminSelectedDate = firstInMonth ? firstInMonth.date : todayStr;
    }

    const firstDay = new Date(adminCalendarYear, adminCalendarMonth, 1);
    const startDayOffset = (firstDay.getDay() + 6) % 7; // Понедельник = 0
    const daysInMonth = new Date(adminCalendarYear, adminCalendarMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(adminCalendarYear, adminCalendarMonth, 0).getDate();

    let cellsHtml = '';

    // Дни предыдущего месяца (приглушенные)
    for (let i = startDayOffset - 1; i >= 0; i--) {
        const prevDayNum = daysInPrevMonth - i;
        const prevMonthNum = adminCalendarMonth === 0 ? 12 : adminCalendarMonth;
        const prevYearNum = adminCalendarMonth === 0 ? adminCalendarYear - 1 : adminCalendarYear;
        const prevDateStr = `${prevYearNum}-${String(prevMonthNum).padStart(2, '0')}-${String(prevDayNum).padStart(2, '0')}`;
        cellsHtml += `
            <div onclick="selectAdminCalendarDate('${prevDateStr}')" class="min-h-[68px] sm:min-h-[82px] p-2 rounded-xl bg-[#0e0407]/40 border border-white/5 opacity-35 hover:opacity-75 transition cursor-pointer flex flex-col justify-between">
                <span class="text-[11px] font-mono font-bold text-slate-500">${prevDayNum}</span>
            </div>
        `;
    }

    // Дни текущего месяца
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${adminCalendarYear}-${String(adminCalendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const dayEvents = notes.filter(n => n.date === dateStr);
        const isSelected = (dateStr === adminSelectedDate);
        const isToday = (dateStr === todayStr);

        let cellClass = 'bg-[#16070b]/80 border-amber-500/15 hover:border-amber-400/60 hover:bg-[#200a11]';
        if (isSelected) {
            cellClass = 'bg-amber-500/20 border-amber-400 shadow-[0_0_15px_rgba(245,158,11,0.35)] ring-2 ring-amber-400/80';
        } else if (dayEvents.length > 0) {
            cellClass = 'bg-[#220a11] border-amber-500/40 hover:border-amber-400';
        }

        cellsHtml += `
            <div onclick="selectAdminCalendarDate('${dateStr}')" class="min-h-[68px] sm:min-h-[82px] p-2 rounded-xl border ${cellClass} transition cursor-pointer flex flex-col justify-between gap-1 group">
                <div class="flex items-center justify-between">
                    <span class="text-xs font-mono font-black ${isSelected ? 'text-amber-300 scale-110' : (isToday ? 'text-amber-400' : 'text-slate-200')} transition-transform">
                        ${d}
                    </span>
                    ${isToday ? `
                        <span class="text-[9px] font-black uppercase px-1.5 py-0.2 rounded bg-amber-500 text-slate-950">Сегодня</span>
                    ` : (dayEvents.length > 0 ? `
                        <span class="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.8)]"></span>
                    ` : '')}
                </div>

                <div class="flex flex-col gap-1 overflow-hidden">
                    ${dayEvents.slice(0, 2).map(ev => {
                        const cfg = CALENDAR_TYPE_CONFIG[ev.type] || CALENDAR_TYPE_CONFIG.announcement;
                        return `
                            <div class="text-[9px] font-bold px-1.5 py-0.5 rounded truncate border ${cfg.colorClass}">
                                ${cfg.icon} ${ev.title || 'Событие'}
                            </div>
                        `;
                    }).join('')}
                    ${dayEvents.length > 2 ? `
                        <span class="text-[8px] font-black text-amber-400/80 text-right">+${dayEvents.length - 2} ещё</span>
                    ` : ''}
                </div>
            </div>
        `;
    }

    // Дни следующего месяца для завершения сетки
    const totalFilled = startDayOffset + daysInMonth;
    const remainingCells = (totalFilled % 7 === 0) ? 0 : (7 - (totalFilled % 7));
    for (let nextD = 1; nextD <= remainingCells; nextD++) {
        const nextMonthNum = adminCalendarMonth === 11 ? 1 : adminCalendarMonth + 2;
        const nextYearNum = adminCalendarMonth === 11 ? adminCalendarYear + 1 : adminCalendarYear;
        const nextDateStr = `${nextYearNum}-${String(nextMonthNum).padStart(2, '0')}-${String(nextD).padStart(2, '0')}`;
        cellsHtml += `
            <div onclick="selectAdminCalendarDate('${nextDateStr}')" class="min-h-[68px] sm:min-h-[82px] p-2 rounded-xl bg-[#0e0407]/40 border border-white/5 opacity-35 hover:opacity-75 transition cursor-pointer flex flex-col justify-between">
                <span class="text-[11px] font-mono font-bold text-slate-500">${nextD}</span>
            </div>
        `;
    }

    gridEl.innerHTML = cellsHtml;
};

window.renderAdminSelectedDateCard = function() {
    const cardEl = document.getElementById('admin-selected-date-card');
    if (!cardEl) return;

    const notes = Array.isArray(appState.calendarNotes) ? appState.calendarNotes : [];
    const selectedDate = adminSelectedDate || new Date().toISOString().split('T')[0];

    // Форматирование даты
    let formattedDate = selectedDate;
    try {
        const p = selectedDate.split('-');
        if (p.length === 3) {
            const d = new Date(parseInt(p[0]), parseInt(p[1]) - 1, parseInt(p[2]));
            formattedDate = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
        }
    } catch (e) {}

    const dayNotes = notes.filter(n => n.date === selectedDate);
    const countLabel = dayNotes.length === 1 ? '1 событие' : (dayNotes.length > 1 && dayNotes.length < 5 ? `${dayNotes.length} события` : `${dayNotes.length} событий`);

    cardEl.innerHTML = `
        <!-- Заголовок выбранной даты -->
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-amber-500/20 pb-3">
            <div class="flex items-center gap-3">
                <span class="text-2xl">📅</span>
                <div>
                    <div class="flex items-center gap-2 flex-wrap">
                        <h4 class="text-sm sm:text-base font-black text-amber-300 uppercase tracking-wide capitalize">
                            ${formattedDate}
                        </h4>
                        <span class="text-[10px] font-mono font-bold px-2 py-0.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                            ${selectedDate}
                        </span>
                    </div>
                    <p class="text-xs text-slate-400 mt-0.5">
                        ${dayNotes.length > 0 ? `Запланировано: ${countLabel}` : 'На эту дату пока нет запланированных заметок или событий'}
                    </p>
                </div>
            </div>

            <div class="flex items-center gap-2 flex-wrap">
                <button type="button" onclick="toggleAdminQuickNoteForm()" class="px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-lg flex items-center gap-1.5">
                    <span>${adminQuickFormOpen ? '✕' : '＋'}</span>
                    <span>${adminQuickFormOpen ? 'Скрыть форму' : 'Добавить заметку'}</span>
                </button>
                <button type="button" onclick="openCalendarEditorModal(null, '${selectedDate}')" class="px-3.5 py-2 bg-[#0a0305] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs uppercase rounded-xl transition flex items-center gap-1.5" title="Добавить фото, видео и настроить Web Push">
                    <span>🎨</span>
                    <span class="hidden sm:inline">Расширенный редактор</span>
                </button>
            </div>
        </div>

        <!-- Форма быстрого добавления заметки на выбранную дату -->
        ${(adminQuickFormOpen || dayNotes.length === 0) ? `
            <div class="bg-[#120509] border border-amber-500/40 p-4 sm:p-5 rounded-2xl flex flex-col gap-3.5 shadow-inner animate-fade-in">
                <div class="flex items-center justify-between border-b border-amber-500/20 pb-2">
                    <span class="text-xs font-black text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                        <span>✍️</span>
                        <span>Быстрая заметка на ${selectedDate}</span>
                    </span>
                    <span class="text-[10px] text-emerald-400 flex items-center gap-1">
                        <span>🌐</span>
                        <span>Сохраняется для всех пользователей и устройств</span>
                    </span>
                </div>

                <form onsubmit="quickSaveAdminCalendarNote(event)" class="flex flex-col gap-3">
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div class="sm:col-span-2">
                            <label class="text-[10px] font-bold text-amber-400 uppercase tracking-widest block mb-1">Заголовок заметки / события *</label>
                            <input type="text" id="admin-quick-note-title" required placeholder="Например: Старт голосования полуфинала" class="w-full bg-[#0a0305] border border-amber-500/25 px-3.5 py-2 text-xs text-white rounded-xl focus:outline-none focus:border-amber-400" />
                        </div>
                        <div>
                            <label class="text-[10px] font-bold text-amber-400 uppercase tracking-widest block mb-1">Вид события *</label>
                            <select id="admin-quick-note-type" required class="w-full bg-[#0a0305] border border-amber-500/25 px-3 py-2 text-xs text-white rounded-xl focus:outline-none focus:border-amber-400">
                                <option value="announcement">📢 Анонс</option>
                                <option value="contest">🏆 Конкурс / Шоу</option>
                                <option value="event">🎪 Ивент / Встреча</option>
                                <option value="holiday">🎉 Праздник</option>
                            </select>
                        </div>
                    </div>

                    <div>
                        <label class="text-[10px] font-bold text-amber-400 uppercase tracking-widest block mb-1">Текст заметки / Подробности события *</label>
                        <textarea id="admin-quick-note-text" rows="2" required placeholder="Напишите текст заметки, который увидят пользователи..." class="w-full bg-[#0a0305] border border-amber-500/25 p-3 text-xs text-white rounded-xl focus:outline-none focus:border-amber-400 leading-relaxed"></textarea>
                    </div>

                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                        <label class="flex items-center gap-2 cursor-pointer select-none">
                            <input type="checkbox" id="admin-quick-note-notify" class="w-4 h-4 rounded text-amber-500 focus:ring-amber-400 bg-black border-amber-500/40 cursor-pointer" />
                            <span class="text-xs text-slate-300">Отправить Push-уведомление подписчикам</span>
                        </label>

                        <div class="flex items-center gap-2">
                            ${dayNotes.length > 0 ? `
                                <button type="button" onclick="toggleAdminQuickNoteForm(false)" class="px-3 py-2 bg-[#16070b] text-slate-400 hover:text-white text-xs font-bold uppercase rounded-xl border border-white/10 transition">
                                    Отмена
                                </button>
                            ` : ''}
                            <button type="submit" id="admin-quick-note-submit-btn" class="px-5 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl shadow-lg transition flex items-center gap-1.5">
                                <span>💾</span>
                                <span>Опубликовать заметку</span>
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        ` : ''}

        <!-- Список заметок и событий на выбранную дату -->
        ${dayNotes.length > 0 ? `
            <div class="flex flex-col gap-3 pt-1">
                <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">
                    События на эту дату (${dayNotes.length}):
                </span>
                <div class="grid grid-cols-1 gap-3">
                    ${dayNotes.map(note => {
                        const typeCfg = CALENDAR_TYPE_CONFIG[note.type] || CALENDAR_TYPE_CONFIG.announcement;
                        const hasPhoto = Boolean(note.photoUrl);
                        const hasVideo = Boolean(note.videoUrl);
                        return `
                            <div class="bg-[#120509] border ${typeCfg.badgeBorder} p-4 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-3 hover:border-amber-400/50 transition shadow">
                                <div class="flex items-start gap-3 flex-1 min-w-0">
                                    <div class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${typeCfg.colorClass}">
                                        <span class="text-base">${typeCfg.icon}</span>
                                    </div>
                                    <div class="flex-1 min-w-0">
                                        <div class="flex items-center gap-2 flex-wrap mb-1">
                                            <span class="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-full border ${typeCfg.colorClass}">
                                                ${typeCfg.icon} ${typeCfg.label}
                                            </span>
                                            ${hasPhoto ? `<span class="text-[10px] font-bold text-slate-300 bg-black/40 px-2 py-0.5 rounded border border-white/10">📷 Фото</span>` : ''}
                                            ${hasVideo ? `<span class="text-[10px] font-bold text-amber-300 bg-amber-500/15 px-2 py-0.5 rounded border border-amber-500/30">🎬 Видео</span>` : ''}
                                        </div>
                                        <h5 class="text-sm font-black text-white uppercase tracking-wide truncate mb-1">
                                            ${note.title || 'Без названия'}
                                        </h5>
                                        <p class="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                                            ${note.text || ''}
                                        </p>
                                    </div>
                                </div>

                                <div class="flex items-center gap-2 self-end md:self-center shrink-0">
                                    <button type="button" onclick="openCalendarEditorModal('${note.id}')" class="px-3 py-1.5 bg-[#0a0305] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs uppercase rounded-xl transition flex items-center gap-1">
                                        <span>✏️</span>
                                        <span>Изменить</span>
                                    </button>
                                    <button type="button" onclick="deleteCalendarNoteFromAdmin('${note.id}')" class="px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase rounded-xl transition flex items-center gap-1">
                                        <span>🗑️</span>
                                        <span>Удалить</span>
                                    </button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        ` : ''}
    `;
};

window.quickSaveAdminCalendarNote = async function(event) {
    if (event) event.preventDefault();

    const titleInput = document.getElementById('admin-quick-note-title');
    const typeSelect = document.getElementById('admin-quick-note-type');
    const textInput = document.getElementById('admin-quick-note-text');
    const notifyInput = document.getElementById('admin-quick-note-notify');
    const submitBtn = document.getElementById('admin-quick-note-submit-btn');

    const title = (titleInput?.value || '').trim();
    const type = typeSelect?.value || 'announcement';
    const text = (textInput?.value || '').trim();
    const notifySubscribers = Boolean(notifyInput?.checked);
    const date = adminSelectedDate || new Date().toISOString().split('T')[0];

    if (!title) {
        showToast('Пожалуйста, укажите заголовок заметки');
        return;
    }
    if (!text) {
        showToast('Пожалуйста, напишите текст заметки');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span>⏳</span><span>Сохранение...</span>';
    }

    try {
        const noteData = {
            id: 'cal-' + Date.now(),
            date,
            type,
            title,
            text,
            photoUrl: '',
            videoUrl: '',
            notifySubscribers
        };

        await saveAdminCalendarNote(noteData);
        if (!Array.isArray(appState.calendarNotes)) appState.calendarNotes = [];
        const idx = appState.calendarNotes.findIndex(n => n.id === noteData.id);
        if (idx >= 0) appState.calendarNotes[idx] = { ...noteData };
        else appState.calendarNotes.push({ ...noteData });
        appState.calendarNotes.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        showToast('✓ Заметка успешно сохранена и опубликована на всех устройствах!');
        adminQuickFormOpen = false;
        renderAdminCalendar();
    } catch (err) {
        console.error('Error saving quick calendar note:', err);
        showToast('✕ Ошибка: ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>💾</span><span>Опубликовать заметку</span>';
        }
    }
};

window.renderAdminCalendar = function() {
    // 1. Рендерим интерактивный календарь-сетку и панель выбранной даты
    renderAdminCalendarGrid();
    renderAdminSelectedDateCard();

    const listEl = document.getElementById('admin-calendar-list');
    if (!listEl) return;

    const notes = Array.isArray(appState.calendarNotes) ? appState.calendarNotes : [];

    // Обновление счетчиков статистики
    const totalEl = document.getElementById('admin-cal-total-count');
    const annEl = document.getElementById('admin-cal-announcements-count');
    const conEl = document.getElementById('admin-cal-contests-count');
    const eveEl = document.getElementById('admin-cal-events-count');
    const holEl = document.getElementById('admin-cal-holidays-count');

    if (totalEl) totalEl.innerText = notes.length;
    if (annEl) annEl.innerText = notes.filter(n => n.type === 'announcement').length;
    if (conEl) conEl.innerText = notes.filter(n => n.type === 'contest').length;
    if (eveEl) eveEl.innerText = notes.filter(n => n.type === 'event').length;
    if (holEl) holEl.innerText = notes.filter(n => n.type === 'holiday').length;

    const searchInput = document.getElementById('admin-cal-search-input');
    const searchTerm = (searchInput ? searchInput.value : '').trim().toLowerCase();

    // Фильтрация
    let filtered = notes.filter(n => {
        if (adminCalendarFilter !== 'all' && n.type !== adminCalendarFilter) return false;
        if (searchTerm) {
            const inDate = (n.date || '').toLowerCase().includes(searchTerm);
            const inTitle = (n.title || '').toLowerCase().includes(searchTerm);
            const inText = (n.text || '').toLowerCase().includes(searchTerm);
            if (!inDate && !inTitle && !inText) return false;
        }
        return true;
    });

    // Сортировка по дате по возрастанию
    filtered.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    if (filtered.length === 0) {
        listEl.innerHTML = `
            <div class="p-8 text-center bg-[#16070b] border border-dashed border-amber-500/20 rounded-2xl">
                <span class="text-3xl block mb-2">📅</span>
                <p class="text-xs text-slate-400 font-bold uppercase tracking-wider">
                    ${searchTerm ? 'Ничего не найдено по вашему запросу' : 'События в календаре еще не добавлены'}
                </p>
                <button type="button" onclick="openCalendarEditorModal(null, '${adminSelectedDate || ''}')" class="mt-4 px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-bold text-xs uppercase rounded-xl border border-amber-500/30 transition">
                    + Добавить первое событие
                </button>
            </div>
        `;
        return;
    }

    listEl.innerHTML = filtered.map(note => {
        const typeCfg = CALENDAR_TYPE_CONFIG[note.type] || CALENDAR_TYPE_CONFIG.announcement;
        const hasPhoto = Boolean(note.photoUrl);
        const hasVideo = Boolean(note.videoUrl);

        // Парсинг читаемой даты
        let formattedDate = note.date;
        try {
            const parts = note.date.split('-');
            if (parts.length === 3) {
                const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
                formattedDate = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'short' });
            }
        } catch (e) {}

        return `
            <div class="bg-[#16070b] border ${typeCfg.badgeBorder} p-4 sm:p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4 transition hover:border-amber-400/50">
                <div class="flex items-start gap-3.5 flex-1 min-w-0">
                    <div class="w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 border ${typeCfg.colorClass}">
                        <span class="text-lg">${typeCfg.icon}</span>
                    </div>

                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap mb-1">
                            <span class="text-[10px] font-black uppercase tracking-wider px-2.5 py-0.5 rounded-full border ${typeCfg.colorClass}">
                                ${typeCfg.icon} ${typeCfg.label}
                            </span>
                            <span class="text-xs font-mono font-bold text-amber-400 bg-amber-500/10 px-2.5 py-0.5 rounded-lg border border-amber-500/20">
                                🗓️ ${formattedDate}
                            </span>
                            ${hasPhoto ? `<span class="text-[10px] font-bold text-slate-300 bg-black/40 px-2 py-0.5 rounded border border-white/10">📷 Фото</span>` : ''}
                            ${hasVideo ? `<span class="text-[10px] font-bold text-amber-300 bg-amber-500/15 px-2 py-0.5 rounded border border-amber-500/30">🎬 Видео</span>` : ''}
                        </div>

                        <h4 class="text-sm font-black text-white uppercase tracking-wide truncate mb-1">
                            ${note.title || 'Без названия'}
                        </h4>

                        <p class="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                            ${note.text || ''}
                        </p>
                    </div>
                </div>

                <div class="flex items-center gap-2 self-end md:self-center shrink-0">
                    <button type="button" onclick="openCalendarEditorModal('${note.id}')" class="px-3.5 py-2 bg-[#0a0305] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-xs uppercase rounded-xl transition flex items-center gap-1.5">
                        <span>✏️</span>
                        <span>Изменить</span>
                    </button>
                    <button type="button" onclick="deleteCalendarNoteFromAdmin('${note.id}')" class="px-3.5 py-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase rounded-xl transition flex items-center gap-1.5">
                        <span>🗑️</span>
                        <span>Удалить</span>
                    </button>
                </div>
            </div>
        `;
    }).join('');
};

window.openCalendarEditorModal = function(id = null, prefillDate = null) {
    const modal = document.getElementById('calendar-editor-modal');
    const form = document.getElementById('calendar-note-form');
    if (!modal || !form) return;

    form.reset();
    clearCalendarPhoto();

    const titleEl = document.getElementById('calendar-editor-title');
    const editIdInput = document.getElementById('calendar-edit-id');
    const dateInput = document.getElementById('calendar-input-date');
    const typeInput = document.getElementById('calendar-input-type');
    const titleInput = document.getElementById('calendar-input-title');
    const textInput = document.getElementById('calendar-input-text');
    const photoUrlInput = document.getElementById('calendar-input-photo-url');
    const videoUrlInput = document.getElementById('calendar-input-video-url');
    const notifyInput = document.getElementById('calendar-input-notify');

    if (id) {
        const notes = Array.isArray(appState.calendarNotes) ? appState.calendarNotes : [];
        const note = notes.find(n => n.id === id);
        if (note) {
            if (titleEl) titleEl.innerHTML = '<span>✏️</span><span>Редактирование события</span>';
            if (editIdInput) editIdInput.value = note.id;
            if (dateInput) dateInput.value = note.date || '';
            if (typeInput) typeInput.value = note.type || 'announcement';
            if (titleInput) titleInput.value = note.title || '';
            if (textInput) textInput.value = note.text || '';
            if (photoUrlInput) photoUrlInput.value = note.photoUrl || '';
            if (videoUrlInput) videoUrlInput.value = note.videoUrl || '';
            if (notifyInput) notifyInput.checked = false;

            if (note.photoUrl) {
                const previewContainer = document.getElementById('calendar-photo-preview-container');
                const previewImg = document.getElementById('calendar-photo-preview-img');
                if (previewContainer && previewImg) {
                    previewImg.src = note.photoUrl;
                    previewContainer.classList.remove('hidden');
                }
            }
        }
    } else {
        if (titleEl) titleEl.innerHTML = '<span>＋</span><span>Добавить событие в календарь</span>';
        if (editIdInput) editIdInput.value = '';
        // Установка даты по умолчанию (prefillDate, adminSelectedDate или сегодня в формате YYYY-MM-DD)
        const defaultDate = prefillDate || adminSelectedDate || (new Date().toISOString().split('T')[0]);
        if (dateInput) dateInput.value = defaultDate;
        if (typeInput) typeInput.value = 'announcement';
        if (notifyInput) notifyInput.checked = false;
    }

    modal.classList.remove('hidden');
};

window.closeCalendarEditorModal = function() {
    const modal = document.getElementById('calendar-editor-modal');
    if (modal) modal.classList.add('hidden');
};

window.handleCalendarImageFileUpload = function(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Пожалуйста, выберите файл изображения');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const base64 = e.target.result;
        const photoUrlInput = document.getElementById('calendar-input-photo-url');
        if (photoUrlInput) photoUrlInput.value = base64;

        const previewContainer = document.getElementById('calendar-photo-preview-container');
        const previewImg = document.getElementById('calendar-photo-preview-img');
        if (previewContainer && previewImg) {
            previewImg.src = base64;
            previewContainer.classList.remove('hidden');
        }
    };
    reader.readAsDataURL(file);
};

window.updateCalendarPhotoPreview = function() {
    const photoUrlInput = document.getElementById('calendar-input-photo-url');
    const previewContainer = document.getElementById('calendar-photo-preview-container');
    const previewImg = document.getElementById('calendar-photo-preview-img');
    if (!photoUrlInput || !previewContainer || !previewImg) return;

    const url = photoUrlInput.value.trim();
    if (url) {
        previewImg.src = url;
        previewContainer.classList.remove('hidden');
    } else {
        previewContainer.classList.add('hidden');
        previewImg.src = '';
    }
};

window.clearCalendarPhoto = function() {
    const fileInput = document.getElementById('calendar-input-file');
    const photoUrlInput = document.getElementById('calendar-input-photo-url');
    const previewContainer = document.getElementById('calendar-photo-preview-container');
    const previewImg = document.getElementById('calendar-photo-preview-img');

    if (fileInput) fileInput.value = '';
    if (photoUrlInput) photoUrlInput.value = '';
    if (previewContainer) previewContainer.classList.add('hidden');
    if (previewImg) previewImg.src = '';
};

window.saveCalendarNoteFromAdmin = async function(event) {
    if (event) event.preventDefault();

    const submitBtn = document.getElementById('calendar-submit-btn');
    const editId = (document.getElementById('calendar-edit-id')?.value || '').trim();
    const date = (document.getElementById('calendar-input-date')?.value || '').trim();
    const type = document.getElementById('calendar-input-type')?.value || 'announcement';
    const title = (document.getElementById('calendar-input-title')?.value || '').trim();
    const text = (document.getElementById('calendar-input-text')?.value || '').trim();
    const photoUrl = (document.getElementById('calendar-input-photo-url')?.value || '').trim();
    const videoUrl = (document.getElementById('calendar-input-video-url')?.value || '').trim();
    const notifySubscribers = Boolean(document.getElementById('calendar-input-notify')?.checked);

    if (!date) {
        showToast('Пожалуйста, выберите дату');
        return;
    }
    if (!title) {
        showToast('Пожалуйста, укажите заголовок события');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span>⏳</span><span>Сохранение...</span>';
    }

    try {
        const noteData = {
            id: editId || ('cal-' + Date.now()),
            date,
            type,
            title,
            text,
            photoUrl,
            videoUrl,
            notifySubscribers
        };

        await saveAdminCalendarNote(noteData);
        if (!Array.isArray(appState.calendarNotes)) appState.calendarNotes = [];
        const idx = appState.calendarNotes.findIndex(n => n.id === noteData.id);
        if (idx >= 0) appState.calendarNotes[idx] = { ...noteData };
        else appState.calendarNotes.push({ ...noteData });
        appState.calendarNotes.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        // Фокусируемся на сохраненной дате
        adminSelectedDate = noteData.date;
        try {
            const dp = noteData.date.split('-');
            if (dp.length === 3) {
                adminCalendarYear = parseInt(dp[0]);
                adminCalendarMonth = parseInt(dp[1]) - 1;
            }
        } catch (e) {}

        showToast(editId ? '✓ Событие в календаре успешно обновлено' : '✓ Событие успешно добавлено в календарь');
        closeCalendarEditorModal();
        renderAdminCalendar();
    } catch (err) {
        console.error('Error saving calendar note:', err);
        showToast('✕ Ошибка: ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<span>💾</span><span>Сохранить событие</span>';
        }
    }
};

window.deleteCalendarNoteFromAdmin = async function(id) {
    if (!confirm('Вы уверены, что хотите удалить это событие из календаря?')) {
        return;
    }
    try {
        await deleteAdminCalendarNote(id);
        if (Array.isArray(appState.calendarNotes)) {
            appState.calendarNotes = appState.calendarNotes.filter(n => n.id !== id);
        }
        showToast('✓ Событие удалено из календаря');
        renderAdminCalendar();
    } catch (err) {
        showToast('✕ Ошибка при удалении: ' + err.message);
    }
};

// -------------------------------------------------------------
// РАЗДЕЛ 6: ADMINS & SESSIONS (РЕЕСТР АДМИНИСТРАТОРОВ И ОТЗЫВ ДОСТУПА)
// -------------------------------------------------------------
let targetRevokeSessionId = null;

function parseUserAgentDevice(ua) {
    if (!ua) return 'Неизвестный браузер';
    let os = 'Неизвестная ОС';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
    else if (ua.includes('iPhone')) os = 'iOS (iPhone)';
    else if (ua.includes('iPad')) os = 'iOS (iPad)';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('Linux')) os = 'Linux';

    let browser = 'Браузер';
    if (ua.includes('Edg/')) browser = 'Microsoft Edge';
    else if (ua.includes('Chrome/')) browser = 'Google Chrome';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Apple Safari';
    else if (ua.includes('Firefox/')) browser = 'Mozilla Firefox';
    else if (ua.includes('OPR/') || ua.includes('Opera/')) browser = 'Opera';

    return `${browser} (${os})`;
}

function formatSessionDate(isoStr) {
    if (!isoStr) return '—';
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        return d.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    } catch (e) {
        return isoStr;
    }
}

window.loadAdminSessions = async function() {
    const listEl = document.getElementById('admin-sessions-list');
    const totalCountEl = document.getElementById('sessions-total-count');
    const activeCountEl = document.getElementById('sessions-active-count');
    const currentInfoEl = document.getElementById('sessions-current-info');
    if (!listEl) return;

    const token = localStorage.getItem('harivision_admin_token');
    if (!token) {
        listEl.innerHTML = '<div class="p-8 text-center text-xs text-rose-400">Требуется повторная авторизация в панели администратора</div>';
        return;
    }

    try {
        listEl.innerHTML = '<div class="p-8 text-center text-xs text-slate-400">Загрузка активных сессий администраторов...</div>';
        const res = await fetch('/api/admin/sessions', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (res.status === 401) {
            handleSessionRevokedNotice();
            return;
        }

        if (!res.ok) {
            throw new Error(`Ошибка загрузки: статус ${res.status}`);
        }

        const data = await res.json();
        const sessions = Array.isArray(data.sessions) ? data.sessions : [];
        const currentSessionId = data.currentSessionId;

        if (totalCountEl) totalCountEl.textContent = sessions.length;
        const activeSessions = sessions.filter(s => s.status === 'active');
        if (activeCountEl) activeCountEl.textContent = activeSessions.length;

        const currentSession = sessions.find(s => s.id === currentSessionId || s.isCurrent);
        if (currentInfoEl) {
            if (currentSession) {
                currentInfoEl.textContent = `${currentSession.ip || 'Localhost'} • ${parseUserAgentDevice(currentSession.userAgent)}`;
                currentInfoEl.title = currentSession.userAgent || '';
            } else {
                currentInfoEl.textContent = 'Текущий браузер';
            }
        }

        if (sessions.length === 0) {
            listEl.innerHTML = `
                <div class="p-8 text-center bg-[#16070b] border border-amber-500/20 rounded-2xl">
                    <p class="text-xs text-slate-400">Нет активных записей в реестре сессий.</p>
                </div>
            `;
            return;
        }

        listEl.innerHTML = sessions.map(session => {
            const isCurrent = Boolean(session.isCurrent || (session.id && session.id === currentSessionId));
            const isRevoked = session.status === 'revoked';
            const deviceFormatted = parseUserAgentDevice(session.userAgent);
            const userIdentifier = session.email || session.username || 'Администратор';
            const escapedIdentifier = userIdentifier.replace(/'/g, "\\'");

            let borderClass = 'border-amber-500/15 bg-[#120509]';
            if (isRevoked) {
                borderClass = 'border-rose-500/20 bg-[#0a0205] opacity-60';
            } else if (isCurrent) {
                borderClass = 'border-amber-500/40 bg-[#19090e] shadow-lg shadow-amber-500/5';
            }

            let statusBadge = '';
            if (isRevoked) {
                statusBadge = '<span class="px-2.5 py-1 text-[10px] uppercase font-bold rounded-lg bg-rose-500/20 text-rose-300 border border-rose-500/30">Отозвана</span>';
            } else if (isCurrent) {
                statusBadge = '<span class="px-2.5 py-1 text-[10px] uppercase font-bold rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40">Ваше устройство</span>';
            } else {
                statusBadge = '<span class="px-2.5 py-1 text-[10px] uppercase font-bold rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">Активна</span>';
            }

            let actionButton = '';
            if (isRevoked) {
                actionButton = '<span class="text-[11px] text-rose-400 font-bold uppercase tracking-wider py-2 px-3">Доступ заблокирован</span>';
            } else if (isCurrent) {
                actionButton = '<span class="text-[11px] text-amber-400/80 font-bold uppercase tracking-wider py-2 px-3">Текущая сессия</span>';
            } else {
                actionButton = `
                    <button onclick="openRevokeSessionModal('${session.id}', '${escapedIdentifier}')" class="px-4 py-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 hover:text-white font-bold text-xs uppercase tracking-wider rounded-xl transition cursor-pointer flex items-center gap-1.5 shrink-0">
                        <span>🚫</span>
                        <span>Отозвать доступ</span>
                    </button>
                `;
            }

            return `
                <div class="border ${borderClass} p-4 sm:p-5 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4 transition">
                    <div class="flex items-start gap-3.5">
                        <div class="w-10 h-10 rounded-xl ${isRevoked ? 'bg-rose-950/40 border border-rose-500/20 text-rose-400' : isCurrent ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300' : 'bg-[#16070b] border border-amber-500/20 text-slate-300'} flex items-center justify-center text-lg shrink-0 mt-0.5">
                            ${session.userAgent && (session.userAgent.includes('Mobile') || session.userAgent.includes('iPhone') || session.userAgent.includes('Android')) ? '📱' : '💻'}
                        </div>
                        <div class="flex flex-col gap-1.5">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="font-bold text-sm text-white">${userIdentifier}</span>
                                ${statusBadge}
                                <span class="text-[10px] text-slate-400 font-mono bg-white/5 px-2 py-0.5 rounded">ID: ${session.id ? session.id.slice(-8) : '—'}</span>
                            </div>
                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-300 pt-1">
                                <div><span class="text-slate-500">Устройство:</span> <span class="font-medium text-slate-200">${deviceFormatted}</span></div>
                                <div><span class="text-slate-500">IP адрес:</span> <span class="font-mono text-amber-300/90">${session.ip || 'Localhost'}</span></div>
                                <div><span class="text-slate-500">Вход:</span> <span class="text-slate-300">${formatSessionDate(session.loginAt)}</span></div>
                                <div><span class="text-slate-500">Активность:</span> <span class="text-slate-300">${formatSessionDate(session.lastActiveAt)}</span></div>
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center justify-end md:self-center pt-2 md:pt-0 border-t md:border-t-0 border-amber-500/10">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error('Error loading admin sessions:', err);
        listEl.innerHTML = `<div class="p-8 text-center text-xs text-rose-400 bg-rose-950/20 border border-rose-500/30 rounded-2xl">Не удалось загрузить реестр сессий: ${err.message}</div>`;
    }
};

window.openRevokeSessionModal = function(sessionId, desc) {
    targetRevokeSessionId = sessionId;
    const modal = document.getElementById('revoke-session-modal');
    const descEl = document.getElementById('revoke-modal-target-desc');
    const keyInput = document.getElementById('revoke-modal-key-input');
    const errorEl = document.getElementById('revoke-modal-error');
    const titleEl = document.getElementById('revoke-modal-title');

    if (titleEl) titleEl.textContent = 'Подтверждение безопасности';
    if (descEl) {
        descEl.textContent = desc ? `${desc} (Сессия: ${sessionId})` : `Сессия ID: ${sessionId}`;
    }
    if (keyInput) keyInput.value = '';
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
    if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => keyInput && keyInput.focus(), 50);
    }
};

window.openRevokeAllSessionsModal = function() {
    targetRevokeSessionId = '__ALL__';
    const modal = document.getElementById('revoke-session-modal');
    const descEl = document.getElementById('revoke-modal-target-desc');
    const keyInput = document.getElementById('revoke-modal-key-input');
    const errorEl = document.getElementById('revoke-modal-error');
    const titleEl = document.getElementById('revoke-modal-title');

    if (titleEl) titleEl.textContent = 'Завершить все остальные сессии';
    if (descEl) {
        descEl.textContent = 'Все другие активные сессии администраторов на всех устройствах (ваша текущая сессия останется активной)';
    }
    if (keyInput) keyInput.value = '';
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.classList.add('hidden');
    }
    if (modal) {
        modal.classList.remove('hidden');
        setTimeout(() => keyInput && keyInput.focus(), 50);
    }
};

window.closeRevokeSessionModal = function() {
    const modal = document.getElementById('revoke-session-modal');
    if (modal) modal.classList.add('hidden');
    targetRevokeSessionId = null;
};

window.submitRevokeSession = async function() {
    const keyInput = document.getElementById('revoke-modal-key-input');
    const errorEl = document.getElementById('revoke-modal-error');
    const submitBtn = document.getElementById('revoke-modal-submit-btn');
    const key = keyInput ? keyInput.value.trim() : '';

    if (!key) {
        if (errorEl) {
            errorEl.textContent = 'Введите ключ безопасности для подтверждения операции';
            errorEl.classList.remove('hidden');
        }
        return;
    }

    const token = localStorage.getItem('harivision_admin_token');
    if (!token) {
        if (errorEl) {
            errorEl.textContent = 'Требуется авторизация в панели администратора';
            errorEl.classList.remove('hidden');
        }
        return;
    }

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.classList.add('opacity-70');
        }

        const endpoint = targetRevokeSessionId === '__ALL__' ? '/api/admin/revoke-all-sessions' : '/api/admin/revoke-session';
        const bodyPayload = targetRevokeSessionId === '__ALL__' ? { masterKey: key } : { sessionId: targetRevokeSessionId, masterKey: key };

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(bodyPayload)
        });

        const data = await res.json();

        if (!res.ok) {
            if (errorEl) {
                errorEl.textContent = data.error || 'Ошибка проверки ключа безопасности';
                errorEl.classList.remove('hidden');
            }
            return;
        }

        closeRevokeSessionModal();
        showToast(data.message || '✓ Доступ успешно отозван');
        await loadAdminSessions();
    } catch (err) {
        if (errorEl) {
            errorEl.textContent = 'Ошибка выполнения запроса: ' + err.message;
            errorEl.classList.remove('hidden');
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.classList.remove('opacity-70');
        }
    }
};
