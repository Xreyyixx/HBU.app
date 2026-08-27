import { db, DEFAULT_PARTICIPANTS, TOTAL_USER_VOTES, MAX_VOTES_PER_PARTICIPANT } from './config.js';
import { doc, onSnapshot, collection, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { 
    subscribeState, 
    submitVote as submitVoteToService, 
    toggleNewsReaction,
    subscribeAuth,
    loginUser,
    registerUser,
    logoutUser,
    getCurrentAuthUser,
    calculateBlockedIdsForArtist,
    safeJsonStringify
} from './data-service.js';

// Доступные эмодзи-реакции
const AVAILABLE_EMOJIS = ['❤️', '🔥', '👏', '🏆', '🤩', '⚡'];

// Состояние авторизованного пользователя
let currentAuthUser = null;
let pendingAuthAction = null; // 'voting' or null

// Состояние приложения
const isNational = window.location.href.toLowerCase().includes('national');
let currentPortalView = isNational ? 'voting' : 'home'; // 'home' | 'contests' | 'contest-detail' | 'news' | 'voting'
let selectedContestId = null;
let currentNewsFilter = 'all';
let activeModalNewsId = null;

// Данные портала
let contestsData = [];
let newsData = [];
let participantsData = DEFAULT_PARTICIPANTS;

// Состояние голосования
let selectedRepresentative = null;
let systemState = { status: 'closed', endsAt: null, sessionId: null, featuredContestId: 'auto' };
let currentVotingSubPage = 'home'; // 'home' | 'recap' | 'voting'
let userAllocations = {}; 
let userName = '';
let timerInterval = null;

// -------------------------------------------------------------
// РЕАКЦИИ ПОЛЬЗОВАТЕЛЕЙ (LOCAL STORAGE + СИНХРОНИЗАЦИЯ)
// -------------------------------------------------------------
function getUserReactionsMap() {
    try {
        const stored = localStorage.getItem('harivision_user_reactions');
        return stored ? JSON.parse(stored) : {};
    } catch (e) {
        return {};
    }
}

function hasUserReacted(newsId, emoji) {
    const map = getUserReactionsMap();
    return Boolean(map[newsId] && map[newsId][emoji]);
}

window.toggleNewsReactionUser = async function(newsId, emoji, event) {
    if (event) {
        event.stopPropagation();
    }
    const map = getUserReactionsMap();
    if (!map[newsId]) map[newsId] = {};
    const alreadyReacted = Boolean(map[newsId][emoji]);
    const action = alreadyReacted ? 'remove' : 'add';

    if (alreadyReacted) {
        delete map[newsId][emoji];
    } else {
        map[newsId][emoji] = true;
    }

    try {
        localStorage.setItem('harivision_user_reactions', safeJsonStringify(map, '{}'));
    } catch (e) {}

    // Оптимистичное локальное обновление
    const article = newsData.find(n => n.id === newsId);
    if (article) {
        if (!article.reactions) article.reactions = {};
        const curr = Number(article.reactions[emoji]) || 0;
        article.reactions[emoji] = action === 'remove' ? Math.max(0, curr - 1) : curr + 1;
    }

    // Мгновенное обновление DOM для модалки и карточек
    updateNewsReactionContainers(newsId);

    // Синхронизация с сервером (разошлет новое состояние всем пользователям сайта)
    try {
        await toggleNewsReaction(newsId, emoji, action);
    } catch (e) {
        console.warn('Sync reaction failed:', e);
    }
};

function updateNewsReactionContainers(newsId) {
    const article = newsData.find(n => n.id === newsId);
    if (!article) return;

    // 1. Модальное окно
    if (activeModalNewsId === newsId) {
        renderModalReactions(newsId);
    }

    // 2. Карточки в DOM
    const cardReactionsEls = document.querySelectorAll(`[id="news-card-reactions-${newsId}"]`);
    cardReactionsEls.forEach(el => {
        el.outerHTML = renderNewsCardReactionsHTML(article);
    });
}

function renderNewsCardReactionsHTML(article) {
    const reactions = article.reactions || {};
    return `
        <div id="news-card-reactions-${article.id}" class="flex flex-wrap items-center gap-1.5 mt-3 pt-3 border-t border-amber-500/10" onclick="event.stopPropagation()">
            ${AVAILABLE_EMOJIS.map(em => {
                const count = Number(reactions[em]) || 0;
                const active = hasUserReacted(article.id, em);
                return `
                    <button type="button" onclick="toggleNewsReactionUser('${article.id}', '${em}', event)" title="${active ? 'Снять реакцию' : 'Поставить ' + em}" class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border transition active:scale-95 cursor-pointer select-none ${
                        active 
                            ? 'bg-amber-500/25 border-amber-400 text-amber-300 font-bold shadow-sm' 
                            : 'bg-[#16070b] border-amber-500/20 text-slate-300 hover:border-amber-500/40 hover:text-white'
                    }">
                        <span>${em}</span>
                        <span class="font-mono text-[10px] ${count > 0 ? (active ? 'text-amber-300 font-bold' : 'text-slate-200') : 'text-slate-500'}">${count}</span>
                    </button>
                `;
            }).join('')}
        </div>
    `;
}

function renderModalReactions(newsId) {
    const container = document.getElementById('modal-news-reactions');
    if (!container) return;
    const article = newsData.find(n => n.id === newsId);
    if (!article) return;
    const reactions = article.reactions || {};

    container.innerHTML = `
        <div class="w-full flex flex-col gap-2.5">
            <div class="text-[10px] uppercase font-bold text-amber-400 tracking-widest flex items-center justify-between">
                <span>Реакции к новости:</span>
                <span class="text-[9px] text-slate-400 font-normal">Синхронизируются со всеми пользователями онлайн</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                ${AVAILABLE_EMOJIS.map(em => {
                    const count = Number(reactions[em]) || 0;
                    const active = hasUserReacted(article.id, em);
                    return `
                        <button type="button" onclick="toggleNewsReactionUser('${article.id}', '${em}', event)" class="flex items-center gap-1.5 px-3.5 py-2 rounded-2xl border transition active:scale-95 text-xs font-bold cursor-pointer select-none ${
                            active 
                                ? 'bg-amber-500/30 border-amber-400 text-amber-200 shadow-md ring-1 ring-amber-400/60' 
                                : 'bg-[#16070b] border-amber-500/25 text-slate-200 hover:border-amber-500/50 hover:bg-amber-500/10'
                        }">
                            <span class="text-base leading-none">${em}</span>
                            <span class="font-mono text-xs ${count > 0 ? (active ? 'text-amber-300 font-bold' : 'text-slate-200') : 'text-slate-500'}">${count}</span>
                        </button>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function resetAllocations() {
    userAllocations = {};
    (participantsData || DEFAULT_PARTICIPANTS).forEach(p => {
        userAllocations[p.id] = 0;
    });
}
resetAllocations();

// Фоновая анимация (Янтарные искры)
const canvas = document.getElementById('bg-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let embers = [];

function resizeCanvas() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

class AutumnEmber {
    constructor() {
        this.reset();
        this.y = Math.random() * (canvas ? canvas.height : 800);
    }
    reset() {
        if (!canvas) return;
        this.x = Math.random() * canvas.width;
        this.y = canvas.height + 20;
        this.size = Math.random() * 2.5 + 0.8;
        this.speedY = Math.random() * 0.6 + 0.2;
        this.speedX = (Math.random() - 0.5) * 0.4;
        this.alpha = Math.random() * 0.5 + 0.2;
        this.hue = Math.random() > 0.5 ? 28 : (Math.random() > 0.5 ? 345 : 12);
    }
    update() {
        this.y -= this.speedY;
        this.x += Math.sin(this.y * 0.01) * 0.3 + this.speedX;
        this.alpha -= 0.0015;
        if (this.y < -10 || this.alpha <= 0) this.reset();
    }
    draw() {
        if (!ctx) return;
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.alpha);
        ctx.fillStyle = `hsl(${this.hue}, 85%, 55%)`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = `hsl(${this.hue}, 90%, 50%)`;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

if (canvas && ctx) {
    for (let i = 0; i < 45; i++) embers.push(new AutumnEmber());
    function animateBg() {
        const grad = ctx.createRadialGradient(canvas.width/2, canvas.height/2, 50, canvas.width/2, canvas.height/2, canvas.width);
        grad.addColorStop(0, '#120408');
        grad.addColorStop(0.6, '#080204');
        grad.addColorStop(1, '#030102');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        embers.forEach(e => { e.update(); e.draw(); });
        requestAnimationFrame(animateBg);
    }
    animateBg();
}

// -------------------------------------------------------------
// АВТОРИЗАЦИЯ, ЛИЧНЫЙ КАБИНЕТ И СТАТУС АРТИСТА В ИНТЕРФЕЙСЕ
// -------------------------------------------------------------
function renderAuthHeaderAndDrawer() {
    const headerContainer = document.getElementById('header-auth-container');
    const drawerContainer = document.getElementById('side-menu-auth-container');

    // 1. Шапка сайта (правый верхний угол)
    if (headerContainer) {
        if (!currentAuthUser) {
            headerContainer.innerHTML = `
                <button onclick="openAuthModal()" class="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#16070b] hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 text-xs font-bold transition shadow-sm cursor-pointer select-none">
                    <span class="text-sm">👤</span>
                    <span class="hidden sm:inline">Войти</span>
                </button>
            `;
        } else if (currentAuthUser.role === 'artist') {
            headerContainer.innerHTML = `
                <div class="flex items-center gap-1.5 bg-[#16070b] border border-amber-500/35 px-2.5 sm:px-3 py-1 rounded-full shadow-sm">
                    <span class="text-xs">🎤</span>
                    <div class="flex flex-col text-left">
                        <span class="text-[11px] sm:text-xs font-black text-amber-300 max-w-[90px] sm:max-w-[120px] truncate leading-tight">${currentAuthUser.displayName}</span>
                        <span class="text-[7px] sm:text-[8px] text-amber-400 font-bold uppercase tracking-wider leading-tight">Артист</span>
                    </div>
                    <button onclick="handleLogout()" title="Выйти из аккаунта" class="ml-1 text-slate-400 hover:text-rose-400 text-xs font-bold p-0.5 transition cursor-pointer">✕</button>
                </div>
            `;
        } else {
            headerContainer.innerHTML = `
                <div class="flex items-center gap-1.5 bg-[#16070b] border border-amber-500/20 px-2.5 sm:px-3 py-1 rounded-full shadow-sm">
                    <span class="text-xs">👤</span>
                    <div class="flex flex-col text-left">
                        <span class="text-[11px] sm:text-xs font-bold text-amber-200 max-w-[90px] sm:max-w-[120px] truncate leading-tight">${currentAuthUser.displayName}</span>
                        <span class="text-[7px] sm:text-[8px] text-slate-400 font-bold uppercase tracking-wider leading-tight">Зритель</span>
                    </div>
                    <button onclick="handleLogout()" title="Выйти" class="ml-1 text-slate-400 hover:text-rose-400 text-xs font-bold p-0.5 transition cursor-pointer">✕</button>
                </div>
            `;
        }
    }

    // 2. Боковое меню (Side Drawer)
    if (drawerContainer) {
        if (!currentAuthUser) {
            drawerContainer.innerHTML = `
                <div class="bg-[#16070b] border border-amber-500/20 p-4 rounded-2xl flex flex-col gap-3">
                    <div class="flex items-center gap-2.5">
                        <div class="w-8 h-8 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-sm">👤</div>
                        <div>
                            <div class="text-xs font-bold text-white uppercase tracking-wider">Личный кабинет</div>
                            <div class="text-[10px] text-amber-400/80">Для зрителей и артистов</div>
                        </div>
                    </div>
                    <button onclick="toggleSideMenu(false); openAuthModal();" class="w-full py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs uppercase tracking-wider rounded-xl transition shadow-md">
                        Войти / Регистрация
                    </button>
                </div>
            `;
        } else if (currentAuthUser.role === 'artist') {
            drawerContainer.innerHTML = `
                <div class="bg-[#16070b] border border-amber-500/30 p-4 rounded-2xl flex flex-col gap-2.5">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2.5">
                            <div class="w-8 h-8 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-sm">🎤</div>
                            <div>
                                <div class="text-xs font-black text-white uppercase">${currentAuthUser.displayName}</div>
                                <div class="text-[10px] text-amber-400 font-bold uppercase tracking-wider">Аккаунт Артиста</div>
                            </div>
                        </div>
                        <span class="px-2 py-0.5 bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-black rounded-full uppercase">Artist</span>
                    </div>
                    <div class="text-[10px] text-amber-200/80 bg-[#0a0305] p-2.5 rounded-xl border border-amber-500/15 leading-relaxed">
                        <span class="text-amber-400 font-bold block mb-0.5">🛡️ Правило честного конкурса:</span>
                        Голосование за свой номер автоматически заблокировано.
                    </div>
                    <button onclick="handleLogout()" class="w-full py-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase tracking-wider rounded-xl transition">
                        Выйти из аккаунта
                    </button>
                </div>
            `;
        } else {
            drawerContainer.innerHTML = `
                <div class="bg-[#16070b] border border-amber-500/20 p-4 rounded-2xl flex flex-col gap-2.5">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2.5">
                            <div class="w-8 h-8 rounded-xl bg-slate-800 border border-amber-500/20 flex items-center justify-center text-sm">👤</div>
                            <div>
                                <div class="text-xs font-bold text-white uppercase">${currentAuthUser.displayName}</div>
                                <div class="text-[10px] text-slate-400 truncate max-w-[140px]">${currentAuthUser.email || 'Зритель HBU'}</div>
                            </div>
                        </div>
                        <span class="px-2 py-0.5 bg-slate-800 text-slate-300 text-[9px] font-bold rounded-full uppercase">Зритель</span>
                    </div>
                    <button onclick="handleLogout()" class="w-full py-2 bg-rose-950/40 hover:bg-rose-900/60 border border-rose-500/30 text-rose-300 font-bold text-xs uppercase tracking-wider rounded-xl transition">
                        Выйти из аккаунта
                    </button>
                </div>
            `;
        }
    }
}

// Управление модальным окном авторизации
window.openAuthModal = function(reason = '') {
    pendingAuthAction = reason;
    const modal = document.getElementById('auth-modal');
    const promptEl = document.getElementById('auth-modal-prompt');
    const errorEl = document.getElementById('auth-form-error');
    if (errorEl) errorEl.classList.add('hidden');

    if (promptEl) {
        if (reason === 'voting') {
            promptEl.innerText = 'Для участия в голосовании необходимо войти под логином артиста или зарегистрироваться как зритель.';
        } else {
            promptEl.innerText = 'Войдите под своим логином или зарегистрируйтесь для участия в жизни конкурса.';
        }
    }
    if (modal) modal.classList.remove('hidden');
};

window.closeAuthModal = function() {
    const modal = document.getElementById('auth-modal');
    if (modal) modal.classList.add('hidden');
};

window.switchAuthTab = function(tab) {
    const tabLogin = document.getElementById('auth-tab-login');
    const tabRegister = document.getElementById('auth-tab-register');
    const formLogin = document.getElementById('auth-login-form');
    const formRegister = document.getElementById('auth-register-form');
    const errorEl = document.getElementById('auth-form-error');
    if (errorEl) errorEl.classList.add('hidden');

    if (tab === 'login') {
        tabLogin.className = 'flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md transition';
        tabRegister.className = 'flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white transition';
        formLogin.classList.remove('hidden');
        formRegister.classList.add('hidden');
    } else {
        tabRegister.className = 'flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md transition';
        tabLogin.className = 'flex-1 py-2 rounded-xl text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white transition';
        formRegister.classList.remove('hidden');
        formLogin.classList.add('hidden');
    }
};

window.handleAuthLoginSubmit = async function(event) {
    event.preventDefault();
    const idEl = document.getElementById('auth-login-identifier');
    const passEl = document.getElementById('auth-login-password');
    const btnEl = document.getElementById('auth-login-submit-btn');
    const errorEl = document.getElementById('auth-form-error');
    if (errorEl) errorEl.classList.add('hidden');

    const originalText = btnEl ? btnEl.innerText : 'Войти';
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.innerText = 'Проверка данных...';
    }

    try {
        const user = await loginUser(idEl.value, passEl.value);
        closeAuthModal();
        if (pendingAuthAction === 'voting') {
            pendingAuthAction = null;
            navigateToView('voting');
        }
    } catch (err) {
        if (errorEl) {
            errorEl.innerText = err.message || 'Ошибка входа. Проверьте правильность логина и пароля.';
            errorEl.classList.remove('hidden');
        }
    } finally {
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.innerText = originalText;
        }
    }
};

window.handleAuthRegisterSubmit = async function(event) {
    event.preventDefault();
    const nameEl = document.getElementById('auth-register-name');
    const idEl = document.getElementById('auth-register-identifier');
    const passEl = document.getElementById('auth-register-password');
    const btnEl = document.getElementById('auth-register-submit-btn');
    const errorEl = document.getElementById('auth-form-error');
    if (errorEl) errorEl.classList.add('hidden');

    const originalText = btnEl ? btnEl.innerText : 'Зарегистрироваться';
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.innerText = 'Создание аккаунта...';
    }

    try {
        const user = await registerUser(idEl.value, passEl.value, nameEl ? nameEl.value : '');
        closeAuthModal();
        if (pendingAuthAction === 'voting') {
            pendingAuthAction = null;
            navigateToView('voting');
        }
    } catch (err) {
        if (errorEl) {
            errorEl.innerText = err.message || 'Ошибка регистрации';
            errorEl.classList.remove('hidden');
        }
    } finally {
        if (btnEl) {
            btnEl.disabled = false;
            btnEl.innerText = originalText;
        }
    }
};

window.handleLogout = async function() {
    if (confirm('Вы уверены, что хотите выйти из аккаунта?')) {
        await logoutUser();
        userName = '';
        renderVotingCard();
    }
};

// Подписка на изменение статуса авторизации
subscribeAuth((user) => {
    currentAuthUser = user;
    if (user && user.displayName) {
        userName = user.displayName;
    }
    renderAuthHeaderAndDrawer();
    if (currentPortalView === 'voting') {
        renderVotingCard();
    }
});

// -------------------------------------------------------------
// НАВИГАЦИЯ И БОКОВОЕ МЕНЮ
// -------------------------------------------------------------
window.toggleSideMenu = function(force) {
    const drawer = document.getElementById('side-menu-drawer');
    const overlay = document.getElementById('side-menu-overlay');
    if (!drawer || !overlay) return;

    const isOpen = !drawer.classList.contains('translate-x-full');
    const shouldOpen = force !== undefined ? force : !isOpen;

    if (shouldOpen) {
        overlay.classList.remove('hidden');
        setTimeout(() => drawer.classList.remove('translate-x-full'), 10);
    } else {
        drawer.classList.add('translate-x-full');
        setTimeout(() => overlay.classList.add('hidden'), 300);
    }
};

window.navigateToView = function(viewName, param) {
    currentPortalView = viewName;
    if (viewName === 'contest-detail' && param) {
        selectedContestId = param;
    }
    
    // Обновление кнопок шапки
    const navButtons = ['home', 'contests', 'news', 'voting'];
    navButtons.forEach(btn => {
        const el = document.getElementById(`nav-btn-${btn}`);
        if (el) {
            if (btn === viewName || (btn === 'contests' && viewName === 'contest-detail')) {
                el.className = 'px-3.5 py-1.5 rounded-full text-amber-300 bg-amber-500/15 font-bold uppercase transition';
            } else if (btn === 'voting') {
                el.className = 'px-4 py-1.5 rounded-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black shadow-md transition uppercase';
            } else {
                el.className = 'px-3.5 py-1.5 rounded-full text-slate-300 hover:text-amber-300 hover:bg-amber-500/10 uppercase transition';
            }
        }
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
    renderMainView();
};

window.filterNews = function(category) {
    currentNewsFilter = category;
    renderMainView();
};

window.openNewsModal = function(newsId) {
    const article = newsData.find(n => n.id === newsId);
    if (!article) return;

    activeModalNewsId = newsId;

    document.getElementById('modal-news-tag').innerText = article.category || article.tag || 'Новость';
    document.getElementById('modal-news-date').innerText = article.date;
    document.getElementById('modal-news-title').innerText = article.title;
    document.getElementById('modal-news-content').innerText = article.content;

    const mediaContainer = document.getElementById('modal-news-media');
    if (article.videoUrl) {
        mediaContainer.innerHTML = `<div class="aspect-video w-full"><iframe class="w-full h-full" src="${article.videoUrl}" frameborder="0" allowfullscreen></iframe></div>`;
        mediaContainer.classList.remove('hidden');
    } else if (article.coverImage) {
        mediaContainer.innerHTML = `<img src="${article.coverImage}" alt="${article.title}" class="w-full h-56 object-cover" />`;
        mediaContainer.classList.remove('hidden');
    } else {
        mediaContainer.classList.add('hidden');
    }

    renderModalReactions(newsId);

    document.getElementById('news-modal').classList.remove('hidden');
};

window.closeNewsModal = function() {
    activeModalNewsId = null;
    document.getElementById('news-modal').classList.add('hidden');
};

// -------------------------------------------------------------
// ФУНКЦИИ PUBLIC VOTE
// -------------------------------------------------------------
function getUsedVotesCount() {
    return Object.values(userAllocations).reduce((sum, val) => sum + val, 0);
}

function formatTimer() {
    if (!systemState.endsAt) return "";
    const now = Date.now();
    const endMs = typeof systemState.endsAt === 'string' ? new Date(systemState.endsAt).getTime() : (systemState.endsAt.toMillis ? systemState.endsAt.toMillis() : new Date(systemState.endsAt).getTime());
    const diff = endMs - now;
    if (diff <= 0) return "00:00";
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function startTimerLoop() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const el = document.getElementById('voting-timer');
        if (el) el.innerText = formatTimer();
    }, 1000);
}

window.updateUserName = function(val) { 
    userName = val; 
};

window.selectRepresentative = function(repName) {
    selectedRepresentative = repName;
    resetAllocations();
    renderVotingCard();
};

window.changeVote = function(participantId, delta) {
    // Если артист пытается голосовать за свой номер
    if (currentAuthUser && currentAuthUser.role === 'artist') {
        const blockedIds = currentAuthUser.blockedParticipantIds || calculateBlockedIdsForArtist(currentAuthUser.artistData, participantsData);
        if (blockedIds.includes(participantId)) {
            return;
        }
    }

    const current = userAllocations[participantId] || 0;
    const used = getUsedVotesCount();

    if (delta > 0) {
        if (used >= TOTAL_USER_VOTES) return;
        if (current >= MAX_VOTES_PER_PARTICIPANT) return;
        userAllocations[participantId] = current + 1;
    } else if (delta < 0) {
        if (current > 0) {
            userAllocations[participantId] = current - 1;
        }
    }
    
    // Плавное обновление счетчиков без пересоздания DOM инпута
    updateVoteUIOnly(participantId);
};

function updateVoteUIOnly(targetParticipantId) {
    const usedVotes = getUsedVotesCount();
    const remainingVotes = TOTAL_USER_VOTES - usedVotes;

    // Обновляем общий счетчик
    const remainEl = document.getElementById('remaining-votes-counter');
    if (remainEl) {
        remainEl.innerText = remainingVotes;
        remainEl.className = `text-2xl font-black font-mono ${remainingVotes === 0 ? 'text-amber-500/50' : 'text-amber-400'}`;
    }

    // Обновляем кнопку отправки
    const submitBtn = document.getElementById('submit-vote-btn');
    if (submitBtn) {
        submitBtn.innerText = `Отправить ${usedVotes} ${usedVotes === 1 ? 'голос' : (usedVotes < 5 ? 'голоса' : 'голосов')}`;
    }

    const participants = participantsData || DEFAULT_PARTICIPANTS;
    const artistBlockedIds = (currentAuthUser && currentAuthUser.role === 'artist') 
        ? (currentAuthUser.blockedParticipantIds || calculateBlockedIdsForArtist(currentAuthUser.artistData, participants))
        : [];

    participants.forEach(p => {
        if (artistBlockedIds.includes(p.id)) return;

        const count = userAllocations[p.id] || 0;
        const countEl = document.getElementById(`vote-count-${p.id}`);
        if (countEl) {
            countEl.innerText = count;
            countEl.className = `w-6 text-center font-mono font-black text-base ${count > 0 ? 'text-amber-400' : 'text-slate-500'}`;
        }
        const rowEl = document.getElementById(`vote-row-${p.id}`);
        if (rowEl) {
            if (count > 0) {
                rowEl.className = 'flex items-center justify-between bg-[#16070b] border border-amber-500/40 bg-amber-500/5 p-3 rounded-xl transition';
            } else {
                rowEl.className = 'flex items-center justify-between bg-[#16070b] border border-amber-500/15 p-3 rounded-xl transition';
            }
        }
        const plusBtn = document.getElementById(`vote-plus-${p.id}`);
        const minusBtn = document.getElementById(`vote-minus-${p.id}`);
        const canAdd = remainingVotes > 0 && count < MAX_VOTES_PER_PARTICIPANT;
        const canSub = count > 0;
        if (plusBtn) {
            plusBtn.className = `w-8 h-8 flex items-center justify-center bg-[#0a0305] border border-amber-500/20 text-amber-300 font-bold rounded-lg ${!canAdd ? 'opacity-30 cursor-not-allowed' : 'hover:bg-amber-500/20 active:scale-95'} transition`;
        }
        if (minusBtn) {
            minusBtn.className = `w-8 h-8 flex items-center justify-center bg-[#0a0305] border border-amber-500/20 text-amber-300 font-bold rounded-lg ${!canSub ? 'opacity-30 cursor-not-allowed' : 'hover:bg-amber-500/20 active:scale-95'} transition`;
        }
    });
}

window.navigateToVotingSubPage = function(subPage) {
    if ((subPage === 'recap' || subPage === 'voting') && !currentAuthUser) {
        if (typeof openAuthModal === 'function') {
            openAuthModal('voting');
        } else {
            alert("Пожалуйста, войдите в аккаунт или зарегистрируйтесь для участия в голосовании.");
        }
        return;
    }
    currentVotingSubPage = subPage;
    renderVotingCard();
};

window.submitVote = async function() {
    // 1. Обязательный вход для голосования
    if (!currentAuthUser) {
        alert("Для голосования необходимо войти в аккаунт или зарегистрироваться.");
        if (typeof openAuthModal === 'function') {
            openAuthModal('voting');
        }
        return;
    }

    const inputName = document.getElementById('voter-name-input');
    const nameValue = inputName ? inputName.value.trim() : (currentAuthUser.displayName || currentAuthUser.login || userName.trim());

    if (!nameValue) {
        alert("Пожалуйста, введите ваше имя перед отправкой голоса.");
        if (inputName) inputName.focus();
        return;
    }

    if (isNational && !selectedRepresentative) {
        alert("Пожалуйста, укажите представителя вашей страны.");
        return;
    }

    // 2. Блокировка собственных номеров для артиста
    if (currentAuthUser && currentAuthUser.role === 'artist') {
        const blockedIds = currentAuthUser.blockedParticipantIds || calculateBlockedIdsForArtist(currentAuthUser.artistData, participantsData);
        blockedIds.forEach(bid => {
            if (userAllocations[bid]) delete userAllocations[bid];
        });
    }

    const totalUsed = getUsedVotesCount();
    if (totalUsed === 0) {
        alert("Пожалуйста, отдайте хотя бы 1 голос перед отправкой.");
        return;
    }

    const submitBtn = document.getElementById('submit-vote-btn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Отправка голосов...';
    }

    try {
        const nowIso = new Date().toISOString();
        const voteId = 'vote_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        const votePayload = {
            id: voteId,
            voterName: nameValue,
            allocations: { ...userAllocations },
            totalVotesGiven: totalUsed,
            isNational: Boolean(isNational),
            representative: selectedRepresentative || null,
            sessionId: systemState.sessionId || null,
            userId: currentAuthUser ? currentAuthUser.uid : null,
            userEmail: currentAuthUser ? currentAuthUser.email : null,
            userRole: currentAuthUser ? currentAuthUser.role : 'user',
            artistName: (currentAuthUser && currentAuthUser.role === 'artist') ? currentAuthUser.displayName : null,
            createdAt: nowIso,
            timestamp: nowIso
        };

        // Отправка голоса через универсальный сервис (Firestore + REST API + локальное состояние)
        await submitVoteToService(votePayload);
        
        if (systemState.sessionId) {
            localStorage.setItem('harivision_voted_session', systemState.sessionId);
        }
        renderVotingCard();
    } catch (e) {
        console.error("Submit vote error:", e);
        alert("Ошибка при отправке голоса: " + (e.message || e));
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = `Отправить ${totalUsed} ${totalUsed === 1 ? 'голос' : (totalUsed < 5 ? 'голоса' : 'голосов')}`;
        }
    }
};

function getHeartSVG(extraClass = "w-10 h-10") {
    return `
        <svg class="${extraClass} inline-block heart-poly" viewBox="0 0 24 24" fill="none">
            <polygon points="12,6 7.5,3.5 3,7.5 12,12.5" fill="#f59e0b" opacity="0.9" />
            <polygon points="12,6 12,12.5 21,7.5 16.5,3.5" fill="#fbbf24" opacity="1.0" />
            <polygon points="3,7.5 12,21.5 12,12.5" fill="#d97706" opacity="0.75" />
            <polygon points="21,7.5 12,12.5 12,21.5" fill="#f59e0b" opacity="0.85" />
        </svg>
    `;
}

// -------------------------------------------------------------
// РЕНДЕР ГЛАВНОГО КОНТЕЙНЕРА И СТРАНИЦ
// -------------------------------------------------------------
function renderMainView() {
    const container = document.getElementById('portal-view-container');
    if (!container) {
        if (document.getElementById('app-card')) {
            renderVotingCard();
        }
        return;
    }

    updateSideMenuContests();

    if (currentPortalView === 'home') {
        container.innerHTML = getHomeHTML();
    } else if (currentPortalView === 'contests') {
        container.innerHTML = getContestsListHTML();
    } else if (currentPortalView === 'contest-detail') {
        container.innerHTML = getContestDetailHTML(selectedContestId);
    } else if (currentPortalView === 'news') {
        container.innerHTML = getNewsHTML();
    } else if (currentPortalView === 'voting') {
        container.innerHTML = getVotingPageHTML();
        renderVotingCard();
    }
}

function updateSideMenuContests() {
    const listEl = document.getElementById('side-menu-contests-list');
    if (!listEl) return;
    listEl.innerHTML = contestsData.map(c => `
        <button onclick="navigateToView('contest-detail', '${c.id}'); toggleSideMenu(false);" class="w-full text-left text-xs text-slate-300 hover:text-amber-300 py-1.5 px-3 rounded-lg hover:bg-amber-500/10 transition flex items-center justify-between">
            <span class="truncate">${c.title}</span>
            <span class="text-[9px] font-mono font-bold text-amber-500/80">${c.date || ''}</span>
        </button>
    `).join('');
}

// -------------------------------------------------------------
// ШАБЛОН ГЛАВНОЙ СТРАНИЦЫ (HOME)
// -------------------------------------------------------------
function getHomeHTML() {
    const fId = systemState.featuredContestId || 'auto';
    let featuredContest = null;

    if (fId === 'auto-live') {
        featuredContest = contestsData.find(c => c.status === 'live') || contestsData.find(c => c.status === 'completed') || contestsData[0] || {};
    } else if (fId !== 'auto') {
        featuredContest = contestsData.find(c => c.id === fId) || contestsData.find(c => c.status === 'completed') || contestsData[0] || {};
    } else {
        // По умолчанию: последний завершённый конкурс
        featuredContest = contestsData.find(c => c.status === 'completed') || contestsData[0] || {};
    }

    const completedContests = contestsData.filter(c => c.status === 'completed');
    const latestNews = newsData.slice(0, 3);
    const isLive = featuredContest.status === 'live';
    const isCompleted = featuredContest.status === 'completed';

    return `
        <div class="flex flex-col gap-10 page-fade">
            <!-- Главный интерактивный баннер выбранного сезона (по умолчанию: последний завершенный) -->
            <div class="relative rounded-3xl overflow-hidden border border-amber-500/30 bg-gradient-to-br from-[#1c080f] via-[#100307] to-[#060204] p-8 md:p-12 shadow-[0_10px_40px_rgba(245,158,11,0.15)] flex flex-col md:flex-row items-center justify-between gap-8">
                <div class="flex-1 flex flex-col items-start gap-4 z-10">
                    <div class="flex items-center gap-2">
                        <span class="px-3 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[10px] font-mono font-bold uppercase rounded-full tracking-widest flex items-center gap-1.5">
                            ${isLive ? `<span class="w-2 h-2 rounded-full bg-red-500 animate-ping"></span><span>Прямой эфир</span>` : 
                              (isCompleted ? `<span>🏆</span><span>${fId === 'auto' ? 'Последний завершённый конкурс' : 'Официальный сезон'}</span>` : `<span>⏳</span><span>Предстоящий выпуск</span>`)}
                        </span>
                        <span class="text-xs text-slate-400 font-mono">${featuredContest.date || '2026'}</span>
                    </div>

                    <h1 class="text-3xl md:text-5xl font-black text-white uppercase tracking-tight leading-tight">
                        ${featuredContest.title || 'HariVision Performance Contest'}
                    </h1>

                    <p class="text-amber-200/90 text-sm md:text-base font-medium max-w-xl leading-relaxed">
                        «${featuredContest.slogan || 'United in Harmony'}» — официальный музыкальный смотр Haribo Broadcasting Union.
                    </p>

                    ${featuredContest.winner ? `
                        <div class="flex items-center gap-3 bg-amber-500/10 border border-amber-500/25 px-4 py-2.5 rounded-2xl">
                            <span class="text-lg">🥇</span>
                            <div class="text-xs">
                                <span class="text-amber-400 font-bold uppercase tracking-wider">Победитель сезона:</span>
                                <span class="text-white font-bold ml-1">${featuredContest.winner.artist}</span>
                                <span class="text-slate-300 font-medium">(${featuredContest.winner.country} — «${featuredContest.winner.song}», ${featuredContest.winner.points} баллов)</span>
                            </div>
                        </div>
                    ` : ''}

                    <div class="flex flex-wrap items-center gap-3 pt-2">
                        ${isLive ? `
                            <button onclick="navigateToView('voting')" class="px-6 py-3.5 rounded-2xl bg-gradient-to-r from-amber-500 via-amber-400 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black text-xs uppercase tracking-widest shadow-xl hover:scale-105 transition flex items-center gap-2">
                                <span>🗳️</span>
                                <span>Перейти к голосованию</span>
                            </button>
                        ` : ''}
                        <button onclick="navigateToView('contest-detail', '${featuredContest.id}')" class="px-6 py-3.5 rounded-2xl ${isLive ? 'bg-[#16070b] hover:bg-amber-500/10 border border-amber-500/30 text-white font-bold' : 'bg-gradient-to-r from-amber-500 via-amber-400 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-black shadow-xl hover:scale-105'} text-xs uppercase tracking-widest transition">
                            Подробнее о сезоне
                        </button>
                        <button onclick="navigateToView('contests')" class="px-6 py-3.5 rounded-2xl bg-[#16070b] hover:bg-amber-500/10 border border-amber-500/30 text-white font-bold text-xs uppercase tracking-wider transition">
                            Все сезоны &rarr;
                        </button>
                    </div>
                </div>

                <div class="w-full md:w-80 flex flex-col items-center justify-center p-6 bg-[#0a0305]/80 border border-amber-500/20 rounded-2xl backdrop-blur-md text-center">
                    <div class="mb-4">${getHeartSVG("w-16 h-16")}</div>
                    <div class="text-xs font-bold text-amber-400 uppercase tracking-widest mb-1">Город проведения</div>
                    <div class="text-base font-black text-white uppercase mb-2">${featuredContest.hostCity || 'Гамбург, Германия'}</div>
                    <div class="text-[11px] text-slate-300 mb-3">Арена: ${featuredContest.venue || 'Haribo Grand Arena'}</div>
                    <span class="text-[10px] font-bold ${isLive ? 'text-green-400 bg-green-950/60 border-green-500/40' : 'text-amber-400/90 bg-amber-500/10 border-amber-500/20'} px-3 py-1 rounded-full border uppercase tracking-wider">
                        ${isLive ? '● Прямой эфир' : (isCompleted ? 'Сезон завершён' : 'Скоро в эфире')}
                    </span>
                </div>
            </div>

            <!-- Раздел: Новости и пресс-релизы -->
            <div class="flex flex-col gap-6">
                <div class="flex items-center justify-between border-b border-amber-500/20 pb-4">
                    <div>
                        <div class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Официальный вестник</div>
                        <h2 class="text-xl md:text-2xl font-black text-white uppercase tracking-wide">Последние новости</h2>
                    </div>
                    <button onclick="navigateToView('news')" class="text-xs font-bold uppercase tracking-wider text-amber-400 hover:text-white transition flex items-center gap-1">
                        <span>Все новости</span>
                        <span>&rarr;</span>
                    </button>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                    ${latestNews.map(n => `
                        <div onclick="openNewsModal('${n.id}')" class="bg-[#0d0408]/90 hover:bg-[#16070b] border border-amber-500/20 hover:border-amber-500/40 rounded-3xl overflow-hidden backdrop-blur-xl transition shadow-xl cursor-pointer flex flex-col justify-between group">
                            ${n.coverImage ? `
                                <div class="w-full h-44 overflow-hidden relative">
                                    <img src="${n.coverImage}" alt="${n.title}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
                                    <div class="absolute top-3 left-3 bg-[#0d0408]/80 backdrop-blur-md px-2.5 py-1 rounded-full border border-amber-500/30 text-[10px] font-bold text-amber-400 uppercase">
                                        ${n.category || n.tag || 'Новость'}
                                    </div>
                                </div>
                            ` : ''}

                            <div class="p-6 flex flex-col justify-between flex-grow">
                                <div>
                                    <div class="text-[10px] font-mono text-amber-400/80 mb-2">${n.date}</div>
                                    <h3 class="text-base font-bold text-white group-hover:text-amber-300 transition uppercase tracking-wide line-clamp-2 mb-2">${n.title}</h3>
                                    <p class="text-xs text-slate-300 font-normal leading-relaxed line-clamp-3">${n.summary}</p>
                                </div>

                                <div>
                                    ${renderNewsCardReactionsHTML(n)}
                                    <div class="pt-3 mt-3 border-t border-amber-500/15 flex items-center justify-between text-[10px] font-bold uppercase text-amber-400">
                                        <span>Читать</span>
                                        <span>&rarr;</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Раздел: Зал славы и победители прошлых сезонов -->
            ${completedContests.length > 0 ? `
                <div class="flex flex-col gap-6">
                    <div class="border-b border-amber-500/20 pb-4">
                        <div class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">История HariVision</div>
                        <h2 class="text-xl md:text-2xl font-black text-white uppercase tracking-wide">Победители прошлых сезонов</h2>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        ${completedContests.map(c => `
                            <div onclick="navigateToView('contest-detail', '${c.id}')" class="bg-[#0d0408]/90 border border-amber-500/20 hover:border-amber-500/40 p-6 md:p-8 rounded-3xl backdrop-blur-xl transition shadow-xl cursor-pointer flex flex-col justify-between">
                                <div class="flex items-center justify-between mb-4">
                                    <span class="text-xs font-mono font-bold text-amber-400 uppercase">${c.date}</span>
                                    <span class="text-[10px] font-bold px-2.5 py-1 bg-amber-500/10 text-amber-300 border border-amber-500/20 rounded-full uppercase">${c.hostCity}</span>
                                </div>

                                <h3 class="text-lg font-black text-white uppercase tracking-wide mb-1">${c.title}</h3>
                                <div class="text-xs text-amber-300/90 font-bold uppercase tracking-wider mb-4">«${c.slogan}»</div>

                                ${c.winner ? `
                                    <div class="bg-[#16070b] border border-amber-500/20 p-4 rounded-2xl flex items-center justify-between">
                                        <div>
                                            <div class="text-[10px] text-amber-500 font-bold uppercase">🏆 Победитель</div>
                                            <div class="text-sm font-bold text-white">${c.winner.country}: ${c.winner.artist}</div>
                                            <div class="text-xs text-slate-300 italic">«${c.winner.song}»</div>
                                        </div>
                                        <div class="text-right font-mono">
                                            <span class="text-lg font-black text-amber-400">${c.winner.points}</span>
                                            <span class="text-[10px] text-slate-400 block uppercase">Public Pts</span>
                                        </div>
                                    </div>
                                ` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        </div>
    `;
}

// -------------------------------------------------------------
// ШАБЛОН СПИСКА ВСЕХ СЕЗОНОВ (CONTESTS LIST)
// -------------------------------------------------------------
function getContestsListHTML() {
    return `
        <div class="flex flex-col gap-8 page-fade">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl">
                <div>
                    <div class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Летопись конкурса</div>
                    <h1 class="text-2xl md:text-3xl font-black text-white uppercase tracking-wide">Все сезоны HariVision</h1>
                </div>
                <div class="text-xs text-slate-300 font-medium">
                    Всего изданий: <strong class="text-amber-400">${contestsData.length}</strong>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                ${contestsData.map(c => `
                    <div onclick="navigateToView('contest-detail', '${c.id}')" class="bg-[#0d0408]/90 hover:bg-[#16070b] border border-amber-500/20 hover:border-amber-500/40 p-6 md:p-8 rounded-3xl backdrop-blur-xl transition shadow-xl cursor-pointer flex flex-col justify-between group">
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

                            <h2 class="text-xl font-black text-white group-hover:text-amber-300 uppercase tracking-wide transition mb-1">${c.title}</h2>
                            <div class="text-xs text-amber-300 font-bold uppercase tracking-wider mb-3">«${c.slogan}»</div>
                            <p class="text-xs text-slate-300 font-normal leading-relaxed line-clamp-3 mb-4">${c.description || ''}</p>
                        </div>

                        <div class="pt-4 border-t border-amber-500/15 flex items-center justify-between text-xs text-slate-400">
                            <div><strong>Город:</strong> ${c.hostCity || 'TBD'}</div>
                            <span class="font-bold text-amber-400 text-[11px] uppercase group-hover:translate-x-1 transition">Открыть &rarr;</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// -------------------------------------------------------------
// ШАБЛОН ДЕТАЛЬНОЙ СТРАНИЦЫ СЕЗОНА (CONTEST DETAIL)
// -------------------------------------------------------------
function getContestDetailHTML(contestId) {
    const c = contestsData.find(item => item.id === contestId) || contestsData[0];
    if (!c) return `<div class="text-center py-20 text-slate-400">Конкурс не найден</div>`;

    return `
        <div class="flex flex-col gap-8 page-fade">
            <!-- Шапка сезона -->
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl">
                <div>
                    <button onclick="navigateToView('contests')" class="text-xs font-bold text-amber-400 hover:text-white uppercase tracking-wider mb-2 flex items-center gap-1">
                        &larr; Все сезоны
                    </button>
                    <h1 class="text-2xl md:text-4xl font-black text-white uppercase tracking-wide">${c.title}</h1>
                    <div class="text-sm font-bold text-amber-300 uppercase tracking-wider mt-1">«${c.slogan}»</div>
                </div>

                <div class="flex flex-wrap gap-2">
                    <button onclick="navigateToView('voting')" class="px-5 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-slate-950 font-black text-xs uppercase tracking-widest shadow-lg">
                        Голосовать
                    </button>
                </div>
            </div>

            <!-- Основная информация и медиа -->
            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <!-- Описание и ведущие -->
                <div class="lg:col-span-2 bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl flex flex-col gap-6">
                    <div>
                        <h2 class="text-sm font-bold text-amber-400 uppercase tracking-widest mb-3">О событии</h2>
                        <p class="text-sm text-slate-200 leading-relaxed font-normal">${c.description || 'Информация о сезоне обновляется.'}</p>
                    </div>

                    ${c.videoUrl ? `
                        <div>
                            <h2 class="text-sm font-bold text-amber-400 uppercase tracking-widest mb-3">Официальная видеозапись / Рекап</h2>
                            <div class="relative w-full aspect-video bg-black rounded-2xl overflow-hidden border border-amber-500/20 shadow-xl">
                                <iframe class="w-full h-full" src="${c.videoUrl}" frameborder="0" allow="autoplay; encrypted-media" allowfullscreen></iframe>
                            </div>
                        </div>
                    ` : ''}

                    <!-- Факты "What do we know so far?" -->
                    ${c.knownDetails && c.knownDetails.length > 0 ? `
                        <div class="bg-[#16070b] border border-amber-500/20 p-6 rounded-2xl">
                            <h2 class="text-sm font-bold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                                <span>📋</span> What do we know so far?
                            </h2>
                            <ul class="space-y-2.5 text-xs text-slate-300">
                                ${c.knownDetails.map(detail => `
                                    <li class="flex items-start gap-2">
                                        <span class="text-amber-400 font-bold mt-0.5">•</span>
                                        <span>${detail}</span>
                                    </li>
                                `).join('')}
                            </ul>
                        </div>
                    ` : ''}
                </div>

                <!-- Метаданные (Город, Зал, Победитель) -->
                <div class="flex flex-col gap-6">
                    <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 rounded-3xl backdrop-blur-xl flex flex-col gap-4 text-xs">
                        <h2 class="text-sm font-bold text-amber-400 uppercase tracking-widest border-b border-amber-500/15 pb-2">Детали организации</h2>
                        
                        <div>
                            <span class="text-slate-400 block text-[10px] uppercase font-bold">Город и Страна</span>
                            <span class="text-white font-bold text-sm">${c.hostCity || 'TBD'}</span>
                        </div>

                        <div>
                            <span class="text-slate-400 block text-[10px] uppercase font-bold">Арена / Зал</span>
                            <span class="text-white font-bold">${c.venue || 'TBD'}</span>
                        </div>

                        <div>
                            <span class="text-slate-400 block text-[10px] uppercase font-bold">Ведущие</span>
                            <span class="text-white font-bold">${(c.hosts || []).join(', ') || 'TBD'}</span>
                        </div>

                        <div>
                            <span class="text-slate-400 block text-[10px] uppercase font-bold">Дата финала</span>
                            <span class="text-white font-bold font-mono">${c.date || 'TBD'}</span>
                        </div>
                    </div>

                    ${c.winner ? `
                        <div class="bg-gradient-to-br from-amber-500/15 to-[#16070b] border border-amber-500/30 p-6 rounded-3xl backdrop-blur-xl">
                            <div class="text-2xl mb-2">🏆</div>
                            <div class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Победитель сезона</div>
                            <div class="text-lg font-black text-white uppercase mt-1">${c.winner.country}</div>
                            <div class="text-sm font-bold text-amber-300">${c.winner.artist}</div>
                            <div class="text-xs text-slate-300 italic mb-3">«${c.winner.song}»</div>
                            <div class="text-xs font-mono text-amber-400 font-bold bg-amber-500/10 px-3 py-1.5 rounded-xl border border-amber-500/20 inline-block">
                                Итог: ${c.winner.points} Public Points
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>

            <!-- Участвующие страны и открытки -->
            <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl">
                <h2 class="text-lg font-bold text-white uppercase tracking-wider mb-6 flex items-center gap-2">
                    <span>🌍</span> Участвующие страны и презентации (Открытки)
                </h2>

                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    ${(c.countries || []).map((country, idx) => `
                        <div class="bg-[#16070b] border border-amber-500/15 p-4 rounded-2xl flex flex-col justify-between">
                            <div>
                                <div class="flex items-center justify-between mb-2">
                                    <span class="text-2xl">${country.flag || '🏳️'}</span>
                                    ${country.rank ? `<span class="text-xs font-mono font-bold text-amber-400 px-2 py-0.5 bg-amber-500/10 rounded-full border border-amber-500/20">${country.rank} место (${country.points}p)</span>` : `<span class="text-[10px] text-slate-500 font-mono">Номер ${idx + 1}</span>`}
                                </div>
                                <h3 class="text-sm font-bold text-white uppercase">${country.country}</h3>
                                <div class="text-xs text-amber-300 font-medium">${country.artist || 'TBD'}</div>
                                <div class="text-[11px] text-slate-400 italic mb-3">«${country.song || 'TBD'}»</div>
                            </div>
                            
                            ${country.postcard ? `
                                <div class="text-[10px] text-amber-500/80 bg-[#0a0305] p-2 rounded-xl border border-amber-500/10 mt-2">
                                    <span class="font-bold text-amber-400 block mb-0.5">Открытка:</span>
                                    ${country.postcard}
                                </div>
                            ` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

// -------------------------------------------------------------
// ШАБЛОН СТРАНИЦЫ НОВОСТЕЙ
// -------------------------------------------------------------
function getNewsHTML() {
    const categories = ['all', 'Конкурс', 'Анонс', 'Архив', 'Организация'];
    const filteredNews = currentNewsFilter === 'all' 
        ? newsData 
        : newsData.filter(n => (n.category === currentNewsFilter || n.tag === currentNewsFilter));

    return `
        <div class="flex flex-col gap-6 page-fade">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d0408]/90 border border-amber-500/20 p-6 rounded-3xl backdrop-blur-xl">
                <div>
                    <div class="text-[10px] font-bold text-amber-400 uppercase tracking-widest">Пресс-служба HBU</div>
                    <h1 class="text-2xl md:text-3xl font-black text-white uppercase tracking-wide">Новости и Анонсы</h1>
                </div>
                
                <div class="flex flex-wrap gap-1.5">
                    ${categories.map(cat => `
                        <button onclick="filterNews('${cat}')" class="text-xs font-bold uppercase tracking-wider px-3.5 py-1.5 rounded-xl transition ${
                            currentNewsFilter === cat 
                                ? 'bg-amber-500 text-slate-950 shadow-md' 
                                : 'bg-[#16070b] text-slate-300 hover:text-white border border-amber-500/20'
                        }">
                            ${cat === 'all' ? 'Все' : cat}
                        </button>
                    `).join('')}
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${filteredNews.map(n => `
                    <div onclick="openNewsModal('${n.id}')" class="bg-[#0d0408]/90 hover:bg-[#16070b] border border-amber-500/20 hover:border-amber-500/40 rounded-3xl overflow-hidden backdrop-blur-xl transition shadow-xl cursor-pointer flex flex-col justify-between group">
                        ${n.coverImage ? `
                            <div class="w-full h-48 overflow-hidden relative">
                                <img src="${n.coverImage}" alt="${n.title}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" />
                                <div class="absolute top-3 left-3 bg-[#0d0408]/80 backdrop-blur-md px-2.5 py-1 rounded-full border border-amber-500/30 text-[10px] font-bold text-amber-400 uppercase">
                                    ${n.category || n.tag || 'Новость'}
                                </div>
                            </div>
                        ` : ''}

                        <div class="p-6 flex flex-col justify-between flex-grow">
                            <div>
                                <div class="text-[10px] font-mono text-amber-400/80 mb-2">${n.date}</div>
                                <h2 class="text-base font-bold text-white group-hover:text-amber-300 transition uppercase tracking-wide line-clamp-2 mb-2">${n.title}</h2>
                                <p class="text-xs text-slate-300 font-normal leading-relaxed line-clamp-3">${n.summary}</p>
                            </div>

                            <div>
                                ${renderNewsCardReactionsHTML(n)}
                                <div class="pt-3 mt-3 border-t border-amber-500/15 flex items-center justify-between text-[10px] font-bold uppercase text-amber-400">
                                    <span>Читать новость</span>
                                    <span>&rarr;</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

// -------------------------------------------------------------
// ШАБЛОН СТРАНИЦЫ ГОЛОСОВАНИЯ
// -------------------------------------------------------------
function getVotingPageHTML() {
    return `
        <div class="w-full max-w-2xl mx-auto flex flex-col gap-4">
            <div id="app-card" class="w-full bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl shadow-2xl backdrop-blur-xl flex flex-col justify-between min-h-[480px]">
                <!-- Динамический контент карточки -->
            </div>
        </div>
    `;
}

// -------------------------------------------------------------
// РЕНДЕР КАРТОЧКИ PUBLIC VOTE
// -------------------------------------------------------------
function renderVotingCard() {
    const card = document.getElementById('app-card');
    if (!card) return;

    const endMs = systemState.endsAt ? (typeof systemState.endsAt === 'string' ? new Date(systemState.endsAt).getTime() : (systemState.endsAt.toMillis ? systemState.endsAt.toMillis() : new Date(systemState.endsAt).getTime())) : null;
    const isExpired = endMs && (endMs <= Date.now());
    const hasVotedInCurrentSession = localStorage.getItem('harivision_voted_session') === systemState.sessionId && systemState.sessionId;

    // 1. Экран завершения
    if (hasVotedInCurrentSession) {
        card.innerHTML = `
            <div class="flex flex-col items-center text-center my-auto py-8 page-fade">
                <div class="w-16 h-16 bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4 text-amber-400 shadow-[0_0_30px_rgba(245,158,11,0.2)] rounded-2xl">
                    <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                </div>
                <h2 class="text-xl md:text-2xl font-black text-white uppercase tracking-widest mb-1">Спасибо за ваш голос!</h2>
                <p class="text-xs text-amber-200/80 font-medium mb-6">Ваши голоса были успешно приняты.</p>
                <div class="border-t border-amber-500/15 pt-4 w-full max-w-sm">
                    <p class="text-xs text-slate-400 font-medium tracking-wide">Наслаждайтесь остальной частью HariVision Performance Contest.</p>
                </div>
            </div>
        `;
        return;
    }

    // 2. Голосование закрыто или в ожидании
    if (systemState.status === 'closed' || (systemState.status === 'open' && isExpired)) {
        if (systemState.status === 'open' && isExpired) {
            card.innerHTML = `
                <div class="flex flex-col items-center text-center my-auto py-10 page-fade">
                    <h1 class="text-2xl md:text-3xl font-extrabold text-white uppercase tracking-widest mb-4">Голосование закрыто.</h1>
                    <p class="text-sm text-amber-200/80 font-medium mb-2">Спасибо за поддержку HariVision Performance Contest.</p>
                </div>
            `;
        } else {
            card.innerHTML = `
                <div class="flex flex-col items-center text-center my-auto py-10 page-fade">
                    <div class="mb-6 animate-pulse">${getHeartSVG()}</div>
                    <h1 class="text-3xl md:text-4xl font-extrabold text-white uppercase tracking-widest mb-3">Пожалуйста, подождите…</h1>
                    <p class="text-xs md:text-sm font-bold text-amber-400 uppercase tracking-widest">Голосование начнется через несколько минут.</p>
                </div>
            `;
        }
        return;
    }

    startTimerLoop();

    // 3. Главный экран голосования
    if (currentVotingSubPage === 'home') {
        card.innerHTML = `
            <div class="flex flex-col items-center text-center my-auto py-8 page-fade">
                <div class="mb-6 scale-125">${getHeartSVG()}</div>
                <h1 class="text-2xl md:text-4xl font-extrabold uppercase tracking-widest text-white mb-2">HariVision</h1>
                <div class="text-xs md:text-sm font-bold text-amber-400 uppercase tracking-widest mb-8">${isNational ? 'Национальное голосование участников' : 'Public Voting | August 2026'}</div>
                <div class="w-full max-w-md bg-[#16070b]/90 border border-amber-500/20 p-8 rounded-2xl">
                    <h2 class="text-lg font-bold text-white uppercase tracking-wider mb-2">${isNational ? 'Голосование жителей стран' : 'Голосование зрителей'}</h2>
                    <p class="text-xs text-slate-300 font-medium mb-6 leading-relaxed">Вам доступно 10 голосов. Распределите их между номерами (до 5 голосов одному выступлению).</p>
                    
                    ${!currentAuthUser ? `
                        <div class="mb-5 p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-left flex items-center justify-between">
                            <div>
                                <div class="text-xs font-bold text-amber-300 mb-0.5">🔒 Вход обязателен</div>
                                <div class="text-[11px] text-slate-300">Войдите или зарегистрируйтесь для голосования.</div>
                            </div>
                            <button onclick="openAuthModal('voting')" class="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black text-xs uppercase rounded-lg shadow transition cursor-pointer">Войти</button>
                        </div>
                    ` : (currentAuthUser.role === 'artist' ? `
                        <div class="mb-5 p-3 rounded-xl bg-amber-500/15 border border-amber-500/35 text-left flex items-center justify-between">
                            <div>
                                <div class="text-xs font-black text-amber-300 uppercase">🎤 ${currentAuthUser.displayName}</div>
                                <div class="text-[10px] text-amber-400/90 font-medium">Аккаунт Артиста: свой номер заблокирован</div>
                            </div>
                            <button onclick="handleLogout()" class="text-[10px] text-slate-400 hover:text-rose-400 uppercase font-bold transition">Сменить</button>
                        </div>
                    ` : `
                        <div class="mb-5 p-3 rounded-xl bg-[#0a0305] border border-amber-500/20 text-left flex items-center justify-between">
                            <div>
                                <div class="text-xs font-bold text-white uppercase">👤 ${currentAuthUser.displayName}</div>
                                <div class="text-[10px] text-slate-400">Аккаунт Зрителя: доступны все номера</div>
                            </div>
                            <button onclick="handleLogout()" class="text-[10px] text-slate-400 hover:text-rose-400 uppercase font-bold transition">Сменить</button>
                        </div>
                    `)}

                    <button onclick="navigateToVotingSubPage('recap')" class="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-extrabold text-xs uppercase tracking-widest py-4 transition shadow-lg rounded-xl cursor-pointer">
                        Начать голосование
                    </button>
                </div>
            </div>
        `;
    } 
    // 4. Экран Recap
    else if (currentVotingSubPage === 'recap') {
        const recapUrl = systemState.recapVideoUrl || 'https://rutube.ru/play/embed/268273f0bf0a34f67bb27790b936619d/?p=NPhZUzeuVzQFYISUpH_dtA';
        card.innerHTML = `
            <div class="flex flex-col h-full justify-between gap-6 page-fade">
                <div class="flex items-center justify-between border-b border-amber-500/15 pb-4">
                    <h2 class="text-xl font-bold text-white uppercase tracking-wider">Повтор выступлений</h2>
                    <span class="text-[10px] font-bold uppercase tracking-widest text-amber-400">Длительность: ~02:00</span>
                </div>
                <div class="relative w-full aspect-video bg-[#0a0305] border border-amber-500/20 rounded-2xl overflow-hidden shadow-2xl">
                    <iframe class="w-full h-full" src="${recapUrl}" frameborder="0" allow="clipboard-write; autoplay" webkitAllowFullScreen mozallowfullscreen allowfullscreen></iframe>
                </div>
                <div class="flex flex-col md:flex-row gap-4 pt-2">
                    <button onclick="navigateToVotingSubPage('voting')" class="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-extrabold text-xs uppercase tracking-widest py-4 transition shadow-lg rounded-xl cursor-pointer">
                        Перейти к голосованию &rarr;
                    </button>
                </div>
            </div>
        `;
    } 
    // 5. Экран выбора номеров и распределения
    else if (currentVotingSubPage === 'voting') {
        if (!currentAuthUser) {
            card.innerHTML = `
                <div class="flex flex-col items-center text-center my-auto py-10 page-fade">
                    <div class="w-16 h-16 bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4 text-amber-400 rounded-2xl shadow-[0_0_25px_rgba(245,158,11,0.2)]">
                        <span class="text-3xl">🔒</span>
                    </div>
                    <h2 class="text-xl font-black text-white uppercase tracking-wider mb-2">Требуется авторизация</h2>
                    <p class="text-xs text-slate-300 font-medium mb-6 max-w-sm leading-relaxed">Для участия в официальном голосовании HariVision необходимо войти в аккаунт зрителя или артиста.</p>
                    <button onclick="openAuthModal('voting')" class="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-extrabold text-xs uppercase tracking-widest px-8 py-4 transition shadow-lg rounded-xl cursor-pointer">
                        Войти / Зарегистрироваться
                    </button>
                </div>
            `;
            return;
        }

        const participants = participantsData || DEFAULT_PARTICIPANTS;

        if (isNational && !selectedRepresentative) {
            const uniqueCountries = [];
            const seen = new Set();
            participants.forEach(p => {
                const cName = p.country || p.name || `Номер ${p.number || p.id}`;
                if (!seen.has(cName)) {
                    seen.add(cName);
                    uniqueCountries.push({ country: cName, flag: p.flag || '🏳️', participantId: p.id, artist: p.artist || '' });
                }
            });

            card.innerHTML = `
                <div class="flex flex-col gap-6 page-fade">
                    <div class="border-b border-amber-500/15 pb-4">
                        <h2 class="text-xl font-bold text-white uppercase tracking-wider">Выберите страну представительства</h2>
                        <p class="text-xs text-amber-200/70 mt-1">В национальном голосовании голос за свою страну исключается автоматически.</p>
                    </div>
                    <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                        ${uniqueCountries.map(item => `
                            <button onclick="selectRepresentative('${item.country.replace(/'/g, "\\'")}')" class="bg-[#16070b] hover:bg-amber-500/10 border border-amber-500/20 hover:border-amber-500/40 p-4 text-left transition rounded-2xl flex items-center gap-3">
                                <span class="text-2xl">${item.flag}</span>
                                <div class="truncate">
                                    <div class="text-sm font-bold text-white uppercase truncate">${item.country}</div>
                                    ${item.artist ? `<div class="text-[10px] text-amber-400 truncate">${item.artist}</div>` : `<div class="text-[10px] text-slate-400">Исключается номер страны</div>`}
                                </div>
                            </button>
                        `).join('')}
                    </div>
                </div>
            `;
            return;
        }

        let blockedIds = [];

        if (isNational && selectedRepresentative) {
            blockedIds = participants
                .filter(p => (p.country && p.country.toLowerCase() === selectedRepresentative.toLowerCase()) || p.id === selectedRepresentative || p.name === selectedRepresentative)
                .map(p => p.id);
        } else if (currentAuthUser && currentAuthUser.role === 'artist') {
            blockedIds = currentAuthUser.blockedParticipantIds || calculateBlockedIdsForArtist(currentAuthUser.artistData, participants);
        }

        const usedVotes = getUsedVotesCount();
        const remainingVotes = TOTAL_USER_VOTES - usedVotes;

        card.innerHTML = `
            <div class="flex flex-col gap-5 page-fade">
                <div class="flex items-center justify-between border-b border-amber-500/15 pb-3">
                    <div>
                        <h2 class="text-xl font-bold text-white uppercase tracking-wider">Public Vote</h2>
                        <div class="text-[10px] text-amber-400/80 font-medium">Максимум 5 голосов на одно выступление</div>
                    </div>
                    <div class="flex items-center gap-3">
                        <span class="text-xs font-mono font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1 rounded-full"><span id="voting-timer">${formatTimer()}</span></span>
                        <button onclick="navigateToVotingSubPage('recap')" class="text-[10px] font-bold uppercase tracking-widest text-amber-400 hover:text-white transition">↺ Повтор</button>
                    </div>
                </div>

                ${isNational ? `
                    <div class="flex items-center justify-between bg-amber-500/10 border border-amber-500/20 p-3 text-xs text-amber-200 rounded-xl">
                        <span>Страна: <strong>${selectedRepresentative}</strong></span>
                        <button onclick="selectRepresentative(null)" class="text-[10px] uppercase font-bold text-amber-400 hover:underline">Сменить</button>
                    </div>
                ` : (currentAuthUser ? (currentAuthUser.role === 'artist' ? `
                    <div class="flex items-center justify-between bg-amber-500/15 border border-amber-500/35 p-3 rounded-xl">
                        <div class="flex items-center gap-2">
                            <span class="text-base">🎤</span>
                            <div>
                                <div class="text-xs font-black text-amber-300 uppercase">${currentAuthUser.displayName} <span class="text-[9px] bg-amber-500 text-slate-950 font-black px-1.5 py-0.2 rounded uppercase ml-1">Артист</span></div>
                                <div class="text-[10px] text-amber-400/90">Ваш номер отмечен значком 🚫 и заблокирован</div>
                            </div>
                        </div>
                        <button onclick="handleLogout()" class="text-[10px] uppercase font-bold text-slate-400 hover:text-rose-400 transition">Сменить</button>
                    </div>
                ` : `
                    <div class="flex items-center justify-between bg-[#16070b] border border-amber-500/20 p-3 rounded-xl">
                        <div class="flex items-center gap-2">
                            <span class="text-base">👤</span>
                            <div>
                                <div class="text-xs font-bold text-white uppercase">${currentAuthUser.displayName} <span class="text-[9px] bg-slate-800 text-slate-300 font-bold px-1.5 py-0.2 rounded uppercase ml-1">Зритель</span></div>
                                <div class="text-[10px] text-slate-400">Доступно голосование за любые номера</div>
                            </div>
                        </div>
                        <button onclick="handleLogout()" class="text-[10px] uppercase font-bold text-slate-400 hover:text-rose-400 transition">Сменить</button>
                    </div>
                `) : `
                    <div class="flex items-center justify-between bg-[#16070b] border border-amber-500/20 p-2.5 rounded-xl text-xs">
                        <span class="text-slate-300 flex items-center gap-1.5 font-medium"><span>👤</span> Голосование зрителя</span>
                        <button onclick="openAuthModal('voting')" class="text-[11px] font-bold text-amber-400 hover:text-amber-300 uppercase underline">Войти как артист</button>
                    </div>
                `)}

                <div class="bg-[#16070b] border border-amber-500/20 p-3.5 rounded-xl">
                    <label class="block text-[10px] font-bold text-amber-400 uppercase tracking-widest mb-1.5">Ваше имя / Псевдоним</label>
                    <input type="text" id="voter-name-input" value="${currentAuthUser ? currentAuthUser.displayName : userName}" oninput="updateUserName(this.value)" placeholder="Введите ваше имя..." class="w-full bg-[#0a0305] border border-amber-500/20 px-3.5 py-2 text-xs text-white focus:outline-none focus:border-amber-400 rounded-lg" />
                </div>

                <div class="bg-[#16070b] border border-amber-500/20 p-3.5 rounded-xl flex items-center justify-between">
                    <span class="text-xs font-bold uppercase tracking-wider text-amber-200">Доступно голосов:</span>
                    <div class="flex items-center gap-2">
                        <span id="remaining-votes-counter" class="text-2xl font-black font-mono ${remainingVotes === 0 ? 'text-amber-500/50' : 'text-amber-400'}">${remainingVotes}</span>
                        <span class="text-xs text-amber-500/60 font-mono">/ 10</span>
                    </div>
                </div>

                <div class="space-y-2 max-h-[290px] overflow-y-auto pr-1">
                    ${participants.map((p, idx) => {
                        const isBlocked = blockedIds.includes(p.id);
                        const displayNumber = p.number || (idx + 1);
                        const displayName = p.name || `Number ${displayNumber}`;

                        if (isBlocked) {
                            return `
                                <div id="vote-row-${p.id}" class="flex items-center justify-between bg-[#120408]/80 border border-rose-500/25 p-3 rounded-xl opacity-75">
                                    <div class="flex items-center gap-3 truncate min-w-0 pr-2">
                                        <span class="text-xs font-mono font-bold text-slate-500 px-2 py-0.5 bg-slate-900 rounded border border-slate-800">#${displayNumber}</span>
                                        ${p.flag ? `<span class="text-base opacity-70">${p.flag}</span>` : ''}
                                        <div class="truncate">
                                            <div class="text-sm font-bold text-slate-300 truncate">${displayName}</div>
                                            ${p.song ? `<div class="text-[11px] text-slate-400 italic truncate">«${p.song}» ${p.artist ? '— ' + p.artist : ''}</div>` : ''}
                                        </div>
                                    </div>
                                    
                                    <div class="flex items-center gap-2 shrink-0">
                                        <span class="text-[10px] font-bold text-rose-300 bg-rose-950/70 border border-rose-500/30 px-2.5 py-1 rounded-lg">🚫 Свой номер</span>
                                    </div>
                                </div>
                            `;
                        }

                        const count = userAllocations[p.id] || 0;
                        const canAdd = remainingVotes > 0 && count < MAX_VOTES_PER_PARTICIPANT;
                        const canSub = count > 0;

                        return `
                            <div id="vote-row-${p.id}" class="flex items-center justify-between bg-[#16070b] border ${count > 0 ? 'border-amber-500/40 bg-amber-500/5' : 'border-amber-500/15'} p-3 rounded-xl transition">
                                <div class="flex items-center gap-3 truncate min-w-0 pr-2">
                                    <span class="text-xs font-mono font-black text-amber-400 px-2 py-0.5 bg-amber-500/10 rounded border border-amber-500/20">#${displayNumber}</span>
                                    ${p.flag ? `<span class="text-base">${p.flag}</span>` : ''}
                                    <div class="truncate">
                                        <div class="text-sm font-bold text-slate-100 truncate">${displayName}</div>
                                        ${p.song ? `<div class="text-[11px] text-amber-300/80 italic truncate">«${p.song}» ${p.artist ? '— ' + p.artist : ''}</div>` : ''}
                                    </div>
                                </div>
                                
                                <div class="flex items-center gap-3 shrink-0">
                                    <button id="vote-minus-${p.id}" onclick="changeVote('${p.id}', -1)" class="w-8 h-8 flex items-center justify-center bg-[#0a0305] border border-amber-500/20 text-amber-300 font-bold rounded-lg ${!canSub ? 'opacity-30 cursor-not-allowed' : 'hover:bg-amber-500/20 active:scale-95'} transition">-</button>
                                    <span id="vote-count-${p.id}" class="w-6 text-center font-mono font-black text-base ${count > 0 ? 'text-amber-400' : 'text-slate-500'}">${count}</span>
                                    <button id="vote-plus-${p.id}" onclick="changeVote('${p.id}', 1)" class="w-8 h-8 flex items-center justify-center bg-[#0a0305] border border-amber-500/20 text-amber-300 font-bold rounded-lg ${!canAdd ? 'opacity-30 cursor-not-allowed' : 'hover:bg-amber-500/20 active:scale-95'} transition">+</button>
                                </div>
                            </div>
                        `;
                    }).join('')}
                </div>

                <div class="pt-2 border-t border-amber-500/15">
                    <button id="submit-vote-btn" onclick="submitVote()" class="w-full bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 font-extrabold text-xs uppercase tracking-widest py-3.5 transition shadow-lg rounded-xl cursor-pointer">
                        Отправить ${usedVotes} ${usedVotes === 1 ? 'голос' : (usedVotes < 5 ? 'голоса' : 'голосов')}
                    </button>
                </div>
            </div>
        `;
    }
}

// -------------------------------------------------------------
// ИНИЦИАЛИЗАЦИЯ И ПОДПИСКА НА СОСТОЯНИЕ (БЕЗ МЕРЦАНИЯ)
// -------------------------------------------------------------
let lastRenderedContentHash = '';

subscribeState((state) => {
    const prevStatus = systemState.status;
    const prevSession = systemState.sessionId;

    contestsData = state.contests || [];
    newsData = state.news || [];
    participantsData = state.participants || DEFAULT_PARTICIPANTS;
    
    const newVotingState = state.votingState || { status: 'closed', endsAt: null, sessionId: null };
    const savedSession = localStorage.getItem('harivision_voted_session');

    if (newVotingState.sessionId && savedSession && savedSession !== newVotingState.sessionId) {
        localStorage.removeItem('harivision_voted_session');
        resetAllocations();
        userName = '';
        selectedRepresentative = null;
    }

    systemState = { ...newVotingState, recapVideoUrl: state.recapVideoUrl, featuredContestId: state.featuredContestId || 'auto' };

    // Если открыто модальное окно новости, обновляем его реакции
    if (activeModalNewsId) {
        renderModalReactions(activeModalNewsId);
    }

    // Обновляем реакции на всех видимых карточках новостей
    (state.news || []).forEach(art => {
        const cardReactionsEls = document.querySelectorAll(`[id="news-card-reactions-${art.id}"]`);
        cardReactionsEls.forEach(el => {
            el.outerHTML = renderNewsCardReactionsHTML(art);
        });
    });

    // Обновляем бейдж в шапке
    const badge = document.getElementById('header-vote-badge');
    if (badge) {
        const endMs = systemState.endsAt ? (typeof systemState.endsAt === 'string' ? new Date(systemState.endsAt).getTime() : (systemState.endsAt.toMillis ? systemState.endsAt.toMillis() : new Date(systemState.endsAt).getTime())) : null;
        const isLive = systemState.status === 'open' && (!endMs || endMs > Date.now());
        if (isLive) {
            badge.className = "flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-green-400 uppercase bg-green-950/40 px-3 py-1.5 rounded-full border border-green-500/30";
            badge.innerHTML = `<span class="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span><span>Голосование открыто</span>`;
        } else {
            badge.className = "hidden sm:flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-amber-500/60 uppercase bg-amber-500/5 px-3 py-1.5 rounded-full border border-amber-500/10";
            badge.innerHTML = `<span>Public Vote</span>`;
        }
    }

    // Проверяем, изменился ли контент (новости, конкурсы, баннер, участники)
    const currentContentHash = safeJsonStringify({
        contests: contestsData,
        news: newsData,
        participants: participantsData,
        recapUrl: systemState.recapVideoUrl,
        featuredId: systemState.featuredContestId,
        voteStatus: systemState.status
    });

    if (currentContentHash !== lastRenderedContentHash) {
        lastRenderedContentHash = currentContentHash;
        if (currentPortalView === 'voting' || isNational) {
            renderVotingCard();
        } else {
            renderMainView();
        }
    } else if (currentPortalView === 'voting' || isNational) {
        if (prevStatus !== systemState.status || prevSession !== systemState.sessionId) {
            renderVotingCard();
        }
    }
});

// Первоначальный рендер
renderMainView();
if (isNational || currentPortalView === 'voting') {
    renderVotingCard();
}
