import { auth, PUBLIC_POINTS_SCALE, DEFAULT_PARTICIPANTS, db } from './config.js';
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
    mergeVotes,
    sanitizeFirestoreData,
    safeJsonStringify 
} from './data-service.js';

let appState = {
    contests: [],
    news: [],
    participants: [],
    votingState: { status: 'closed', endsAt: null, sessionId: null },
    recapVideoUrl: 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA',
    featuredContestId: 'auto',
    votes: [],
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
        const result = await syncAllToFirestore();
        try {
            await fetchFirestoreStateDirectly();
        } catch (e) {}

        if (btn) {
            btn.innerHTML = `<span>☁️</span><span>Синхронизировать с облаком</span>`;
            btn.disabled = false;
        }

        if (result && (result.firestore || result.server || result.success)) {
            showToast('✓ Все данные и голоса успешно синхронизированы!');
        } else {
            showToast('✓ Локальное состояние и сервер обновлены');
        }
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
        updateBannerSelectUI();
    } else {
        authPanel.classList.remove('hidden');
        dashboard.classList.add('hidden');
    }
}

// Проверка сохраненной сессии при старте
(async function initAdminAuthSession() {
    const hasServerSession = await verifyAdminSession();
    if (hasServerSession) {
        setAdminAuthenticated(true);
        try {
            await fetchFirestoreStateDirectly();
        } catch (e) {}
        return;
    }

    // Отслеживание сессии Firebase Auth
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            setAdminAuthenticated(true);
            try {
                await fetchFirestoreStateDirectly();
            } catch (e) {}
        } else {
            const token = localStorage.getItem('harivision_admin_token');
            if (!token) {
                setAdminAuthenticated(false);
            }
        }
    });
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

    let authSuccess = false;

    // 1. Попытка входа через серверный API
    try {
        const srvRes = await loginAdminServer(loginInput, password);
        if (srvRes && srvRes.token) {
            localStorage.setItem('harivision_admin_token', srvRes.token);
            setAdminAuthenticated(true);
            showToast('Вход в панель администратора выполнен');
            authSuccess = true;
        }
    } catch (srvErr) {}

    // 2. Если серверный вход не сработал, пробуем Firebase Auth
    if (!authSuccess) {
        try {
            const firebaseEmail = loginInput.includes('@') ? loginInput : `${loginInput}@harivision.org`;
            await signInWithEmailAndPassword(auth, firebaseEmail, password);
            showToast('Вход через Firebase Auth выполнен');
            authSuccess = true;
        } catch (firebaseErr) {
            console.error('Firebase Auth Error:', firebaseErr);
            let msg = "Неверный логин или пароль администратора";
            if (firebaseErr.code === 'auth/invalid-credential' || firebaseErr.code === 'auth/wrong-password' || firebaseErr.code === 'auth/user-not-found') {
                msg = "Неверный логин или пароль (по умолчанию: admin / admin)";
            } else if (firebaseErr.code === 'auth/invalid-email') {
                msg = "Некорректный формат email";
            } else if (firebaseErr.code === 'auth/too-many-requests') {
                msg = "Слишком много неудачных попыток входа. Попробуйте позже.";
            } else if (firebaseErr.message) {
                msg = firebaseErr.message;
            }
            if (errEl) {
                errEl.innerText = msg;
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
    try {
        await signOut(auth);
    } catch (e) {}
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
    const tabs = ['voting', 'news', 'contests'];

    tabs.forEach(tab => {
        const btn = document.getElementById(`tab-btn-${tab}`);
        const sec = document.getElementById(`section-${tab}`);

        if (tab === tabName) {
            btn.className = "px-5 py-2.5 rounded-2xl font-black text-xs uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md transition flex items-center gap-2";
            sec.classList.remove('hidden');
        } else {
            btn.className = "px-5 py-2.5 rounded-2xl font-bold text-xs uppercase tracking-wider bg-[#16070b] text-slate-300 hover:text-amber-300 border border-amber-500/20 transition flex items-center gap-2";
            sec.classList.add('hidden');
        }
    });
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
    updateVotingThreshold(appState.manualThreshold, true);
    showToast('Public Points раскрыты!');
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
                const name = participant ? `${participant.flag || '🏳️'} #${pNumber} ${participant.name || ('Number ' + pNumber)}` : `Номер ${pId}`;
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
            showToast(`Голос ${voterLabel} аннулирован`);
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

    // Начисление Public Points
    let currentRank = 1;
    results.forEach((item) => {
        if (item.passed) {
            item.rank = currentRank;
            item.points = PUBLIC_POINTS_SCALE[currentRank - 1] !== undefined ? PUBLIC_POINTS_SCALE[currentRank - 1] : 0;
            currentRank++;
        } else {
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
                        <span class="truncate max-w-[120px] font-bold">${roleBadge}${v.voterName || 'Зритель'}</span>
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
                    roleBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">⭐ Артист (${v.artistName || v.voterName})</span>`;
                } else if (isNational) {
                    roleBadgeHtml = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">🌍 Национальное (${v.representative || 'Жюри'})</span>`;
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
                                <span class="text-slate-100">${v.voterName || 'Анонимный зритель'}</span>
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

    const list = appState.news || [];
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
        }
    } else {
        titleEl.innerText = "Создание новой публикации";
        document.getElementById('news-edit-id').value = '';
        document.getElementById('news-input-date').value = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        window.updateNewsImagePreview('');
    }

    modal.classList.remove('hidden');
};

window.closeNewsEditorModal = function() {
    document.getElementById('news-editor-modal').classList.add('hidden');
    window.updateNewsImagePreview('');
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

    const articleData = {
        id: id || ('news-' + Date.now()),
        title,
        category,
        tag: category,
        date,
        coverImage: coverImage || 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=1200&auto=format&fit=crop',
        videoUrl,
        summary,
        content
    };

    await saveNewsArticle(articleData);
    closeNewsEditorModal();
    showToast('Новость успешно сохранена и опубликована!');
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

    container.innerHTML = currentEditingContestParticipants.map((p, idx) => `
        <div class="bg-[#0a0305] border border-amber-500/20 hover:border-amber-500/40 p-3.5 rounded-xl flex flex-col gap-2.5 transition shadow-sm">
            <div class="flex items-center justify-between gap-2 border-b border-amber-500/10 pb-2">
                <div class="flex items-center gap-2">
                    <span class="text-xs font-mono font-black text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">#${idx + 1}</span>
                    <span class="text-xs font-bold text-white uppercase">${p.country || 'Новая страна'}</span>
                </div>
                <div class="flex items-center gap-1.5">
                    <button type="button" onclick="moveContestParticipantUp(${idx})" class="text-[10px] px-2 py-0.5 bg-[#16070b] hover:bg-amber-500/20 text-slate-300 rounded border border-amber-500/20 ${idx === 0 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === 0 ? 'disabled' : ''}>▲</button>
                    <button type="button" onclick="moveContestParticipantDown(${idx})" class="text-[10px] px-2 py-0.5 bg-[#16070b] hover:bg-amber-500/20 text-slate-300 rounded border border-amber-500/20 ${idx === currentEditingContestParticipants.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === currentEditingContestParticipants.length - 1 ? 'disabled' : ''}>▼</button>
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
                    <input type="text" value="${p.country || ''}" placeholder="Германия" oninput="updateContestParticipantField(${idx}, 'country', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Место / Ранг</label>
                    <input type="number" value="${p.rank !== undefined && p.rank !== null ? p.rank : ''}" placeholder="1" oninput="updateContestParticipantField(${idx}, 'rank', this.value ? parseInt(this.value, 10) : null)" class="w-full bg-[#16070b] border border-amber-500/25 px-2 py-1.5 text-xs text-white rounded-lg font-mono text-center" />
                </div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Исполнитель</label>
                    <input type="text" value="${p.artist || ''}" placeholder="Elena & The Echoes" oninput="updateContestParticipantField(${idx}, 'artist', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Песня</label>
                    <input type="text" value="${p.song || ''}" placeholder="Neon Heartbeat" oninput="updateContestParticipantField(${idx}, 'song', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Баллы (Public Pts)</label>
                    <input type="number" value="${p.points !== undefined && p.points !== null ? p.points : ''}" placeholder="240" oninput="updateContestParticipantField(${idx}, 'points', this.value ? parseInt(this.value, 10) : null)" class="w-full bg-[#16070b] border border-amber-500/25 px-2 py-1.5 text-xs text-white rounded-lg font-mono text-center" />
                </div>
            </div>

            <div>
                <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Презентация / Открытка (Postcard)</label>
                <input type="text" value="${p.postcard || ''}" placeholder="Открытка: Гамбургский порт на рассвете" oninput="updateContestParticipantField(${idx}, 'postcard', this.value)" class="w-full bg-[#16070b] border border-amber-500/25 px-2.5 py-1 text-[11px] text-slate-300 rounded-lg" />
            </div>
        </div>
    `).join('');
}

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
        postcard: ''
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
        postcard: p.postcard || ''
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
            currentEditingContestParticipants = JSON.parse(safeJsonStringify(c.countries || c.participants || [], '[]'));
        }
    } else {
        titleEl.innerText = "Создание нового сезона";
        document.getElementById('contest-edit-id').value = '';
        currentEditingContestParticipants = [];
    }

    renderContestModalParticipants();
    modal.classList.remove('hidden');
};

window.closeContestEditorModal = function() {
    document.getElementById('contest-editor-modal').classList.add('hidden');
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
        rank: p.rank !== undefined && p.rank !== null ? Number(p.rank) : null,
        points: p.points !== undefined && p.points !== null ? Number(p.points) : null,
        postcard: p.postcard || ''
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

    await saveContest(contestData);
    closeContestEditorModal();
    showToast('Информация о конкурсе успешно сохранена!');
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
