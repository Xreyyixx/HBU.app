// =====================================================================
// Админка раздела «Артисты» (профили карьеры).
//
// ВАЖНО: это artistProfiles. Не путать с логин-аккаунтами исполнителей (Firestore-коллекция
// "artists", роль artist) — у них нет отдельной вкладки, они живут в Firebase напрямую.
//
// Принцип данных: сами выступления НЕ копируются в профиль.
//   • выступления из сезонов остаются в contest.participants[] — профиль лишь связан с ними
//     через participant.artistId (эту связь ставит привязка / импорт по имени);
//   • всё, чего нет в сезонах (гостевые номера, прошлые сезоны, плееры, фото), хранится в
//     profile.manualPerformances[];
//   • диаграммы (profile.charts[]) и таблицы (profile.tables[]) собирает админ сам.
// Статистику считает публичная страница (artist-views.js) из этих данных — при правке
// результата в сезоне или в ручной записи она обновляется автоматически.
// =====================================================================
import { renderCustomChartCard, renderCustomTableCard } from './artist-views.js';

// Фрагмент правил, которого может не хватать в опубликованных правилах Firestore
export const ARTIST_RULES_SNIPPET = `match /artistProfiles/{docId} {
  allow read: if true;
  allow write: if request.auth != null
    && exists(/databases/$(database)/documents/admins/$(request.auth.uid));
}`;

const MAX_DOC_BYTES = 900000; // лимит документа Firestore ~1 МиБ, оставляем запас
const AVATAR_MAX_SIDE = 640;
const AVATAR_QUALITY = 0.82;
const GALLERY_MAX_SIDE = 960;
const GALLERY_QUALITY = 0.76;

function deepClone(v) { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
function uid(prefix) { return prefix + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function safeId(v) { return String(v === undefined || v === null ? '' : v).replace(/[^\w-]/g, ''); }
function norm(v) { return String(v || '').trim().toLowerCase(); }
function $(id) { return document.getElementById(id); }

function compressImage(file, maxSide, quality) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('Выберите файл изображения (JPG, PNG, WebP)'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = () => reject(new Error('Не удалось открыть изображение'));
            img.onload = () => {
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#0d0408'; // прозрачный PNG не должен превращаться в чёрный квадрат без фона
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

export function initArtistAdmin(deps) {
    const { getState, saveContest, saveArtistProfile, deleteArtistProfile, showToast, openAdminConfirmModal, escapeHtml } = deps;
    const esc = escapeHtml;

    let editing = null; // { id, photo, manual[], charts[], tables[], pane }
    let importCandidates = [];

    const artists = () => (getState().artistProfiles || []);
    const contests = () => (getState().contests || []);
    const contestById = (id) => contests().find(c => c.id === id);
    const participantsOf = (c) => (c && (c.participants || c.countries)) || [];

    // ------------------------------------------------------------------
    // Список профилей
    // ------------------------------------------------------------------
    function linkedPerformances(artistId) {
        const res = [];
        contests().forEach(c => participantsOf(c).forEach((p, idx) => {
            if (p.artistId === artistId) res.push({ p, idx, contest: c });
        }));
        return res;
    }

    function renderAdminArtists() {
        const container = $('admin-artists-list');
        if (!container) return;
        const list = artists();
        if (list.length === 0) {
            container.innerHTML = `<div class="col-span-full text-center py-10 text-xs text-slate-400">Профилей артистов пока нет. Добавьте первый!</div>`;
            return;
        }
        container.innerHTML = list.map(a => {
            const linked = linkedPerformances(a.id).length;
            const manual = (a.manualPerformances || []).length;
            const extras = [
                (a.charts || []).length ? `${(a.charts || []).length} диагр.` : '',
                (a.tables || []).length ? `${(a.tables || []).length} табл.` : ''
            ].filter(Boolean).join(' · ');
            return `
            <div class="bg-[#0d0408]/90 border border-amber-500/20 p-5 rounded-3xl backdrop-blur-xl flex items-center gap-4 shadow-lg">
                <div class="w-16 h-16 rounded-2xl overflow-hidden bg-[#16070b] border border-amber-500/20 flex-shrink-0">
                    ${a.photo ? `<img src="${esc(a.photo)}" alt="" class="w-full h-full object-cover" />` : `<div class="w-full h-full flex items-center justify-center text-lg">🎤</div>`}
                </div>
                <div class="flex-1 min-w-0">
                    <h3 class="text-sm font-black text-white uppercase tracking-wide truncate">${esc(a.name || '')}</h3>
                    ${a.country ? `<div class="text-[11px] text-amber-300 font-bold uppercase tracking-wider truncate">${esc(a.country)}</div>` : ''}
                    <div class="text-[10px] text-slate-400 font-mono mt-1">${linked} из сезонов · ${manual} вручную${extras ? ' · ' + extras : ''}</div>
                </div>
                <div class="flex flex-col gap-1.5 flex-shrink-0">
                    <button onclick="openArtistEditorModal('${safeId(a.id)}')" class="px-3 py-1.5 bg-[#16070b] hover:bg-amber-500/20 border border-amber-500/30 text-amber-300 font-bold text-[10px] uppercase rounded-lg transition">Редактировать</button>
                    <button onclick="deleteAdminArtist('${safeId(a.id)}')" class="px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-bold text-[10px] uppercase rounded-lg transition">Удалить</button>
                </div>
            </div>`;
        }).join('');
    }

    // ------------------------------------------------------------------
    // Предупреждение про правила Firestore
    // ------------------------------------------------------------------
    function showRulesWarning(errorCode) {
        const box = $('artist-rules-warning');
        if (!box) return;
        $('artist-rules-snippet').textContent = ARTIST_RULES_SNIPPET;
        box.classList.remove('hidden');
        console.warn('[Artists] Firestore отклонил запись профиля:', errorCode);
    }
    function hideRulesWarning() {
        const box = $('artist-rules-warning');
        if (box) box.classList.add('hidden');
    }
    window.copyArtistRulesSnippet = async function () {
        try {
            await navigator.clipboard.writeText(ARTIST_RULES_SNIPPET);
            showToast('Фрагмент скопирован');
        } catch (e) {
            showToast('Не удалось скопировать — выделите текст вручную', true);
        }
    };

    // ------------------------------------------------------------------
    // Открытие / закрытие модалки, вкладки
    // ------------------------------------------------------------------
    const TAB_ON = 'flex-1 whitespace-nowrap py-2 px-3 rounded-xl text-[11px] font-bold uppercase tracking-wider transition bg-amber-500 text-slate-950 shadow-md';
    const TAB_OFF = 'flex-1 whitespace-nowrap py-2 px-3 rounded-xl text-[11px] font-bold uppercase tracking-wider transition text-slate-300 hover:text-amber-300';

    window.switchArtistPane = function (pane) {
        if (!editing) return;
        editing.pane = pane;
        ['profile', 'performances', 'charts', 'tables'].forEach(p => {
            const el = $('artist-pane-' + p);
            if (el) el.classList.toggle('hidden', p !== pane);
        });
        document.querySelectorAll('#artist-tabs [data-pane]').forEach(btn => {
            btn.className = btn.dataset.pane === pane ? TAB_ON : TAB_OFF;
        });
        if (pane === 'performances') renderPerformancesPane();
        if (pane === 'charts') renderChartsList();
        if (pane === 'tables') renderTablesList();
    };

    window.openArtistEditorModal = function (artistId, pane) {
        const a = artistId ? artists().find(x => x.id === artistId) : null;
        if (artistId && !a) {
            showToast('Профиль не найден — возможно, он ещё не синхронизировался. Обновите страницу.', true);
            return;
        }
        editing = {
            id: a ? a.id : null,
            photo: a ? (a.photo || '') : '',
            manual: a ? deepClone(a.manualPerformances || []) : [],
            charts: a ? deepClone(a.charts || []) : [],
            tables: a ? deepClone(a.tables || []) : [],
            pane: 'profile'
        };
        editing.manual.forEach(m => { if (!m.id) m.id = uid('mp'); if (!Array.isArray(m.photos)) m.photos = []; });
        editing.charts.forEach(c => { if (!c.id) c.id = uid('ch'); if (!Array.isArray(c.items)) c.items = []; });
        editing.tables.forEach(t => {
            if (!t.id) t.id = uid('tb');
            if (!Array.isArray(t.columns) || !t.columns.length) t.columns = ['Колонка 1'];
            if (!Array.isArray(t.rows)) t.rows = [];
            t.rows = t.rows.map(r => ({ cells: Array.isArray(r && r.cells) ? r.cells.map(String) : [] }));
        });
        importCandidates = [];

        $('artist-edit-id').value = editing.id || '';
        $('artist-editor-title').innerText = a ? 'Редактирование профиля артиста' : 'Новый профиль артиста';
        $('artist-input-name').value = a ? (a.name || '') : '';
        $('artist-input-country').value = a ? (a.country || '') : '';
        $('artist-input-bio').value = a ? (a.bio || '') : '';
        $('artist-photo-file').value = '';
        refreshPhotoUi();
        $('artist-delete-btn').classList.toggle('hidden', !editing.id);
        $('artist-import-result').classList.add('hidden');
        $('artist-import-result').innerHTML = '';

        $('artist-editor-modal').classList.remove('hidden');
        window.switchArtistPane(pane || 'profile');
    };

    window.closeArtistEditorModal = function () {
        $('artist-editor-modal').classList.add('hidden');
        editing = null;
        importCandidates = [];
    };

    // ------------------------------------------------------------------
    // Фото профиля (файл / ссылка)
    // ------------------------------------------------------------------
    function refreshPhotoUi() {
        const photo = editing ? editing.photo : '';
        const img = $('artist-photo-preview');
        const hasPhoto = Boolean(photo);
        img.src = hasPhoto ? photo : '';
        img.classList.toggle('hidden', !hasPhoto);
        $('artist-photo-placeholder').classList.toggle('hidden', hasPhoto);
        $('artist-photo-remove').classList.toggle('hidden', !hasPhoto);
        // В поле ссылки показываем только настоящие URL; загруженный файл (data:) туда не выводим
        $('artist-input-photo').value = hasPhoto && !photo.startsWith('data:') ? photo : '';
    }

    window.updateArtistPhotoPreview = function (url) {
        if (!editing) return;
        if (url && url.trim()) {
            editing.photo = url.trim();
            const img = $('artist-photo-preview');
            img.src = editing.photo;
            img.classList.remove('hidden');
            $('artist-photo-placeholder').classList.add('hidden');
            $('artist-photo-remove').classList.remove('hidden');
        }
    };

    window.clearArtistPhoto = function () {
        if (!editing) return;
        editing.photo = '';
        $('artist-photo-file').value = '';
        refreshPhotoUi();
    };

    async function applyAvatarFile(file) {
        if (!editing || !file) return;
        try {
            editing.photo = await compressImage(file, AVATAR_MAX_SIDE, AVATAR_QUALITY);
            refreshPhotoUi();
            showToast('Фото загружено');
        } catch (e) {
            showToast(e.message || 'Не удалось загрузить фото', true);
        }
    }
    window.handleArtistPhotoFile = function (event) {
        applyAvatarFile(event.target.files && event.target.files[0]);
    };
    window.handleArtistPhotoDrop = function (event) {
        event.preventDefault();
        event.currentTarget.classList.remove('border-amber-400');
        applyAvatarFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
    };

    // ------------------------------------------------------------------
    // ВЫСТУПЛЕНИЯ: привязка к сезонам
    // ------------------------------------------------------------------
    function renderPerformancesPane() {
        $('artist-unsaved-note').classList.toggle('hidden', Boolean(editing.id));
        $('artist-linked-section').classList.toggle('hidden', !editing.id);
        $('artist-link-section').classList.toggle('hidden', !editing.id);
        if (editing.id) {
            renderLinkedList();
            renderArtistLinkContestOptions();
        }
        renderManualList();
    }

    function renderLinkedList() {
        const el = $('artist-linked-performances-list');
        if (!el || !editing || !editing.id) return;
        const items = linkedPerformances(editing.id);
        if (items.length === 0) {
            el.innerHTML = `<div class="text-[11px] text-slate-500 italic">Пока ничего не привязано. Нажмите «Найти по имени в сезонах» или выберите запись вручную.</div>`;
            return;
        }
        el.innerHTML = items.map(({ p, idx, contest }) => {
            const k = `${safeId(contest.id)}-${idx}`;
            return `
            <div class="bg-[#16070b] border border-amber-500/15 rounded-xl p-3 flex flex-col gap-2">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                    <div class="text-[11px] text-slate-200">
                        <span class="text-amber-400 font-mono">${esc(contest.date || '')}</span>
                        <span class="mx-1">·</span><span class="font-bold">${esc(contest.title || contest.id)}</span>
                        ${p.country ? `<span class="text-slate-400"> · ${esc(p.country)}</span>` : ''}
                    </div>
                    <div class="flex items-center gap-3">
                        <button type="button" onclick="closeArtistEditorModal(); openContestEditorModal('${safeId(contest.id)}')" class="text-[10px] font-bold text-amber-400 hover:text-white uppercase">✏️ Сезон целиком</button>
                        <button type="button" onclick="unlinkArtistPerformance('${safeId(contest.id)}', ${idx})" class="text-[10px] font-bold text-rose-400 hover:text-rose-300 uppercase">✕ Отвязать</button>
                    </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-4 gap-2">
                    <div class="sm:col-span-3">
                        <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Песня / номер</label>
                        <input id="lp-${k}-song" type="text" value="${esc(p.song || '')}" class="w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg" />
                    </div>
                    <div>
                        <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Место</label>
                        <input id="lp-${k}-rank" type="number" min="1" value="${p.rank !== undefined && p.rank !== null ? esc(p.rank) : ''}" class="w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg font-mono text-center" />
                    </div>
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">🎤 Ссылка на плеер: полное выступление</label>
                    <input id="lp-${k}-perf" type="text" value="${esc(p.performanceVideo || '')}" placeholder="https://rutube.ru/play/embed/… · YouTube · VK · .mp4" class="w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg font-mono" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">🎬 Ссылка на плеер: видео-открытка</label>
                    <input id="lp-${k}-post" type="text" value="${esc(p.postcardVideo || '')}" placeholder="https://rutube.ru/play/embed/…" class="w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg font-mono" />
                </div>
                <div class="flex justify-end">
                    <button type="button" onclick="saveLinkedArtistPerformance('${safeId(contest.id)}', ${idx})" class="px-3.5 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-bold text-[10px] uppercase rounded-lg transition">💾 Сохранить в сезоне</button>
                </div>
            </div>`;
        }).join('');
    }

    // Запись идёт ПРЯМО в запись сезона (источник истины) — копий в профиле нет
    async function mutateContestParticipants(contestId, mutator) {
        const contest = contestById(contestId);
        if (!contest) { showToast('Сезон не найден', true); return false; }
        const participants = participantsOf(contest).map(p => ({ ...p }));
        mutator(participants);
        await saveContest({ ...contest, participants, countries: participants }, false);
        return true;
    }

    window.saveLinkedArtistPerformance = async function (contestId, idx) {
        const k = `${safeId(contestId)}-${idx}`;
        const rankRaw = $(`lp-${k}-rank`).value.trim();
        const ok = await mutateContestParticipants(contestId, (participants) => {
            if (!participants[idx]) return;
            participants[idx] = {
                ...participants[idx],
                song: $(`lp-${k}-song`).value.trim(),
                rank: rankRaw === '' ? null : Number(rankRaw),
                performanceVideo: $(`lp-${k}-perf`).value.trim(),
                postcardVideo: $(`lp-${k}-post`).value.trim()
            };
        });
        if (ok) showToast('Выступление обновлено в сезоне');
    };

    window.unlinkArtistPerformance = async function (contestId, idx) {
        const ok = await mutateContestParticipants(contestId, (participants) => {
            if (!participants[idx]) return;
            const { artistId, ...rest } = participants[idx];
            participants[idx] = rest;
        });
        if (ok) { showToast('Связь снята'); renderLinkedList(); renderAdminArtists(); }
    };

    // Импорт: найти в сезонах записи с таким же именем артиста и привязать пачкой
    window.scanArtistImportCandidates = function () {
        if (!editing || !editing.id) { showToast('Сначала сохраните профиль (кнопка «Применить»)', true); return; }
        const nm = norm($('artist-input-name').value);
        if (!nm) { showToast('Сначала укажите имя артиста на вкладке «Профиль»', true); return; }
        importCandidates = [];
        contests().forEach(c => participantsOf(c).forEach((p, idx) => {
            if (p.artistId) return; // уже привязано (к этому или другому профилю)
            const pn = norm(p.artist);
            if (!pn) return;
            const exact = pn === nm;
            const partial = !exact && nm.length >= 3 && (pn.includes(nm) || nm.includes(pn));
            if (exact || partial) importCandidates.push({ contestId: c.id, idx, exact, c, p });
        }));
        const box = $('artist-import-result');
        box.classList.remove('hidden');
        if (importCandidates.length === 0) {
            box.innerHTML = `<div class="text-[11px] text-slate-400 bg-[#16070b] border border-amber-500/15 rounded-xl px-3 py-2.5">Новых записей с именем «${esc($('artist-input-name').value.trim())}» в сезонах не найдено (уже привязанные не показываются).</div>`;
            return;
        }
        box.innerHTML = `
            <div class="text-[11px] text-slate-300">Найдено записей: <b class="text-amber-400">${importCandidates.length}</b>. Точные совпадения отмечены заранее; частичные (имя входит в другое) проверьте глазами.</div>
            <div class="flex flex-col gap-1.5">
                ${importCandidates.map((it, i) => `
                    <label class="flex items-center gap-2.5 bg-[#16070b] border border-amber-500/15 rounded-xl px-3 py-2 cursor-pointer hover:border-amber-500/40 transition">
                        <input type="checkbox" data-import-idx="${i}" ${it.exact ? 'checked' : ''} class="w-4 h-4 accent-amber-500" />
                        <span class="text-[11px] text-slate-200 flex-1 min-w-0">
                            <span class="text-amber-400 font-mono">${esc(it.c.date || '')}</span> · <b>${esc(it.c.title || it.c.id)}</b>
                            ${it.p.song ? ` · «${esc(it.p.song)}»` : ''}${it.p.rank ? ` · #${esc(it.p.rank)}` : ''}
                            <span class="text-slate-500"> (в сезоне записан как «${esc(it.p.artist)}»${it.exact ? '' : ', частичное совпадение'})</span>
                        </span>
                    </label>`).join('')}
            </div>
            <div class="flex justify-end"><button type="button" onclick="applyArtistImport()" class="px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-slate-950 font-black text-[11px] uppercase rounded-xl shadow">Привязать выбранные</button></div>`;
    };

    window.applyArtistImport = async function () {
        if (!editing || !editing.id) return;
        const chosen = [...document.querySelectorAll('#artist-import-result input[data-import-idx]:checked')]
            .map(cb => importCandidates[Number(cb.dataset.importIdx)]).filter(Boolean);
        if (chosen.length === 0) { showToast('Отметьте хотя бы одну запись', true); return; }
        const byContest = new Map();
        chosen.forEach(it => {
            if (!byContest.has(it.contestId)) byContest.set(it.contestId, []);
            byContest.get(it.contestId).push(it.idx);
        });
        for (const [contestId, indexes] of byContest) {
            await mutateContestParticipants(contestId, (participants) => {
                indexes.forEach(i => { if (participants[i]) participants[i] = { ...participants[i], artistId: editing.id }; });
            });
        }
        showToast(`Привязано выступлений: ${chosen.length}`);
        $('artist-import-result').classList.add('hidden');
        importCandidates = [];
        renderLinkedList();
        renderAdminArtists();
    };

    // Ручная привязка одной записи
    function renderArtistLinkContestOptions() {
        const select = $('artist-link-contest-select');
        if (!select) return;
        select.innerHTML = `<option value="">— выберите сезон —</option>` +
            contests().map(c => `<option value="${esc(c.id)}">${esc(c.title || c.id)} (${esc(c.date || '')})</option>`).join('');
        $('artist-link-participant-select').innerHTML = `<option value="">— сначала выберите сезон —</option>`;
    }

    window.renderArtistLinkParticipantOptions = function () {
        const contestId = $('artist-link-contest-select').value;
        const sel = $('artist-link-participant-select');
        if (!contestId) { sel.innerHTML = `<option value="">— сначала выберите сезон —</option>`; return; }
        const participants = participantsOf(contestById(contestId));
        if (participants.length === 0) { sel.innerHTML = `<option value="">В этом сезоне нет участников</option>`; return; }
        sel.innerHTML = `<option value="">— выберите запись —</option>` + participants.map((p, idx) =>
            `<option value="${idx}">${esc(p.country || ('Запись ' + (idx + 1)))} — ${esc(p.artist || 'без имени')}${p.song ? ' · ' + esc(p.song) : ''}${p.artistId ? ' (уже привязано)' : ''}</option>`).join('');
    };

    window.linkSelectedArtistPerformance = async function () {
        if (!editing || !editing.id) { showToast('Сначала сохраните профиль', true); return; }
        const contestId = $('artist-link-contest-select').value;
        const idxStr = $('artist-link-participant-select').value;
        if (!contestId || idxStr === '') { showToast('Выберите сезон и запись участника', true); return; }
        const idx = parseInt(idxStr, 10);
        const ok = await mutateContestParticipants(contestId, (participants) => {
            if (participants[idx]) participants[idx] = { ...participants[idx], artistId: editing.id };
        });
        if (ok) {
            showToast('Выступление привязано');
            renderLinkedList();
            window.renderArtistLinkParticipantOptions();
            renderAdminArtists();
        }
    };

    // ------------------------------------------------------------------
    // ВЫСТУПЛЕНИЯ: ручные записи
    // ------------------------------------------------------------------
    function manualCard(m, i) {
        const inp = 'w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg focus:outline-none focus:border-amber-400';
        const lbl = 'text-[9px] text-slate-400 uppercase font-bold block mb-0.5';
        return `
        <div class="bg-[#16070b] border border-amber-500/20 rounded-2xl p-4 flex flex-col gap-3">
            <div class="flex items-center justify-between">
                <span class="text-[10px] font-mono font-black text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">Ручная запись #${i + 1}</span>
                <button type="button" onclick="removeArtistManualPerformance(${i})" class="text-[10px] font-bold text-rose-400 hover:text-rose-300 uppercase">✕ Удалить</button>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div class="sm:col-span-2">
                    <label class="${lbl}">Конкурс / сезон (ссылка на страницу сезона)</label>
                    <select onchange="artistManualContest(${i}, this.value)" class="${inp}">
                        <option value="">— вне базы конкурсов —</option>
                        ${contests().map(c => `<option value="${esc(c.id)}" ${m.contestId === c.id ? 'selected' : ''}>${esc(c.title || c.id)} (${esc(c.date || '')})</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label class="${lbl}">Дата (текстом)</label>
                    <input type="text" value="${esc(m.date || '')}" placeholder="8 июля 2026" oninput="artistManualField(${i},'date',this.value)" class="${inp}" />
                </div>
            </div>
            ${m.contestId ? '' : `
            <div>
                <label class="${lbl}">Название мероприятия</label>
                <input type="text" value="${esc(m.contestLabel || '')}" placeholder="HariVision Special, гостевое выступление…" oninput="artistManualField(${i},'contestLabel',this.value)" class="${inp}" />
            </div>`}

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div class="col-span-2">
                    <label class="${lbl}">Песня / номер</label>
                    <input type="text" value="${esc(m.song || '')}" oninput="artistManualField(${i},'song',this.value)" class="${inp}" />
                </div>
                <div>
                    <label class="${lbl}">Место</label>
                    <input type="number" min="1" value="${m.rank !== undefined && m.rank !== null ? esc(m.rank) : ''}" oninput="artistManualField(${i},'rank',this.value)" class="${inp} font-mono text-center" />
                </div>
                <div>
                    <label class="${lbl}">Статус (необяз.)</label>
                    <input type="text" value="${esc(m.status || '')}" placeholder="Гость вечера" oninput="artistManualField(${i},'status',this.value)" class="${inp}" />
                </div>
            </div>

            <div class="grid grid-cols-3 gap-2">
                <div class="col-span-2">
                    <label class="${lbl}">Страна / делегация</label>
                    <input type="text" value="${esc(m.country || '')}" oninput="artistManualField(${i},'country',this.value)" class="${inp}" />
                </div>
                <div>
                    <label class="${lbl}">Флаг</label>
                    <input type="text" value="${esc(m.flag || '')}" placeholder="🏳️" oninput="artistManualField(${i},'flag',this.value)" class="${inp} text-center" />
                </div>
            </div>

            <div>
                <label class="${lbl}">🎤 Ссылка на плеер: полное выступление</label>
                <input type="text" value="${esc(m.performanceVideo || '')}" placeholder="https://rutube.ru/play/embed/… · YouTube · VK · .mp4" oninput="artistManualField(${i},'performanceVideo',this.value)" class="${inp} font-mono" />
            </div>
            <div>
                <label class="${lbl}">🎬 Ссылка на плеер: видео-открытка</label>
                <input type="text" value="${esc(m.postcardVideo || '')}" placeholder="https://rutube.ru/play/embed/…" oninput="artistManualField(${i},'postcardVideo',this.value)" class="${inp} font-mono" />
            </div>
            <div>
                <label class="${lbl}">Текст открытки (необяз.)</label>
                <input type="text" value="${esc(m.postcard || '')}" placeholder="#THEKUR" oninput="artistManualField(${i},'postcard',this.value)" class="${inp}" />
            </div>
            <div>
                <label class="${lbl}">Описание постановки / номера</label>
                <textarea rows="3" oninput="artistManualField(${i},'description',this.value)" class="${inp}">${esc(m.description || '')}</textarea>
            </div>

            <div>
                <label class="${lbl}">Фотографии</label>
                <div class="flex flex-wrap gap-2">
                    ${(m.photos || []).map((src, j) => `
                        <div class="relative w-20 h-20">
                            <img src="${esc(src)}" alt="" class="w-full h-full object-cover rounded-xl border border-amber-500/20" />
                            <button type="button" onclick="removeArtistManualPhoto(${i},${j})" class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-rose-900 border border-rose-500/50 text-rose-200 text-[10px] leading-none">✕</button>
                        </div>`).join('')}
                    <label class="w-20 h-20 rounded-xl border border-dashed border-amber-500/40 hover:border-amber-400 flex flex-col items-center justify-center text-amber-400 cursor-pointer transition text-center">
                        <span class="text-lg leading-none">＋</span><span class="text-[9px] mt-1">файл</span>
                        <input type="file" accept="image/*" multiple class="hidden" onchange="addArtistManualPhotos(${i}, event)" />
                    </label>
                </div>
                <div class="flex gap-2 mt-2">
                    <input id="am-photo-url-${i}" type="text" placeholder="или ссылка на фото https://…" class="${inp} font-mono" />
                    <button type="button" onclick="addArtistManualPhotoUrl(${i})" class="px-3 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-bold text-[10px] uppercase rounded-lg whitespace-nowrap">+ URL</button>
                </div>
            </div>
        </div>`;
    }

    function renderManualList() {
        const el = $('artist-manual-list');
        if (!el || !editing) return;
        el.innerHTML = editing.manual.length
            ? editing.manual.map(manualCard).join('')
            : `<div class="text-[11px] text-slate-500 italic bg-[#16070b]/60 border border-dashed border-amber-500/15 rounded-xl px-3 py-4 text-center">Ручных записей нет.</div>`;
    }

    window.addArtistManualPerformance = function () {
        if (!editing) return;
        editing.manual.push({ id: uid('mp'), contestId: '', contestLabel: '', date: '', song: '', rank: '', status: '', country: '', flag: '', performanceVideo: '', postcardVideo: '', postcard: '', description: '', photos: [], createdAt: Date.now() });
        renderManualList();
    };
    window.removeArtistManualPerformance = function (i) {
        if (!editing) return;
        editing.manual.splice(i, 1);
        renderManualList();
    };
    window.artistManualField = function (i, field, value) {
        if (editing && editing.manual[i]) editing.manual[i][field] = value;
    };
    window.artistManualContest = function (i, contestId) {
        if (!editing || !editing.manual[i]) return;
        const m = editing.manual[i];
        m.contestId = contestId || '';
        const c = contestId ? contestById(contestId) : null;
        if (c) {
            m.contestLabel = c.title || '';
            if (!String(m.date || '').trim()) m.date = c.date || '';
        }
        renderManualList();
    };
    window.addArtistManualPhotos = async function (i, event) {
        if (!editing || !editing.manual[i]) return;
        const files = [...(event.target.files || [])];
        for (const file of files) {
            try {
                editing.manual[i].photos.push(await compressImage(file, GALLERY_MAX_SIDE, GALLERY_QUALITY));
            } catch (e) {
                showToast(e.message || 'Не удалось загрузить фото', true);
            }
        }
        renderManualList();
    };
    window.addArtistManualPhotoUrl = function (i) {
        if (!editing || !editing.manual[i]) return;
        const input = $('am-photo-url-' + i);
        const url = input ? input.value.trim() : '';
        if (!url) return;
        editing.manual[i].photos.push(url);
        renderManualList();
    };
    window.removeArtistManualPhoto = function (i, j) {
        if (!editing || !editing.manual[i]) return;
        editing.manual[i].photos.splice(j, 1);
        renderManualList();
    };

    // ------------------------------------------------------------------
    // ДИАГРАММЫ
    // ------------------------------------------------------------------
    function chartCard(ch, i) {
        const inp = 'w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg focus:outline-none focus:border-amber-400';
        return `
        <div class="bg-[#16070b] border border-amber-500/20 rounded-2xl p-4 flex flex-col gap-3">
            <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div class="flex-1">
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Заголовок диаграммы</label>
                    <input type="text" value="${esc(ch.title || '')}" placeholder="Например: Жанры в творчестве" oninput="artistChartField(${i},'title',this.value)" class="${inp}" />
                </div>
                <div>
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Вид</label>
                    <select onchange="artistChartField(${i},'type',this.value)" class="${inp}">
                        <option value="bars" ${ch.type !== 'donut' ? 'selected' : ''}>Столбцы</option>
                        <option value="donut" ${ch.type === 'donut' ? 'selected' : ''}>Кольцо (доли)</option>
                    </select>
                </div>
                <button type="button" onclick="removeArtistChart(${i})" class="px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-bold text-[10px] uppercase rounded-lg transition">Удалить</button>
            </div>

            <div class="flex flex-col gap-1.5">
                <div class="grid grid-cols-[1fr_6rem_1.75rem] gap-2 text-[9px] text-slate-500 uppercase font-bold"><span>Подпись</span><span>Значение</span><span></span></div>
                ${(ch.items || []).map((it, j) => `
                    <div class="grid grid-cols-[1fr_6rem_1.75rem] gap-2">
                        <input type="text" value="${esc(it.label || '')}" placeholder="Подпись" oninput="artistChartItem(${i},${j},'label',this.value)" class="${inp}" />
                        <input type="text" inputmode="decimal" value="${esc(it.value === undefined || it.value === null ? '' : it.value)}" placeholder="0" oninput="artistChartItem(${i},${j},'value',this.value)" class="${inp} font-mono text-center" />
                        <button type="button" onclick="removeArtistChartItem(${i},${j})" class="text-rose-400 hover:text-rose-300 text-xs" title="Убрать строку">✕</button>
                    </div>`).join('')}
                <button type="button" onclick="addArtistChartItem(${i})" class="self-start mt-1 text-[10px] font-bold text-amber-400 hover:text-white uppercase">+ строка</button>
            </div>

            <div>
                <div class="text-[9px] text-slate-500 uppercase font-bold mb-1.5">Так это увидят на сайте</div>
                <div id="artist-chart-preview-${i}">${renderCustomChartCard(ch)}</div>
            </div>
        </div>`;
    }

    function renderChartsList() {
        const el = $('artist-charts-list');
        if (!el || !editing) return;
        el.innerHTML = editing.charts.length
            ? editing.charts.map(chartCard).join('')
            : `<div class="text-[11px] text-slate-500 italic bg-[#16070b]/60 border border-dashed border-amber-500/15 rounded-xl px-3 py-6 text-center">Диаграмм пока нет. Нажмите «+ Диаграмма».</div>`;
    }
    function refreshChartPreview(i) {
        const box = $('artist-chart-preview-' + i);
        if (box && editing && editing.charts[i]) box.innerHTML = renderCustomChartCard(editing.charts[i]);
    }

    window.addArtistChart = function () {
        if (!editing) return;
        editing.charts.push({ id: uid('ch'), title: '', type: 'bars', items: [{ label: '', value: '' }, { label: '', value: '' }] });
        renderChartsList();
    };
    window.removeArtistChart = function (i) {
        if (!editing) return;
        editing.charts.splice(i, 1);
        renderChartsList();
    };
    window.artistChartField = function (i, field, value) {
        if (!editing || !editing.charts[i]) return;
        editing.charts[i][field] = value;
        refreshChartPreview(i);
    };
    window.artistChartItem = function (i, j, field, value) {
        if (!editing || !editing.charts[i] || !editing.charts[i].items[j]) return;
        editing.charts[i].items[j][field] = value;
        refreshChartPreview(i);
    };
    window.addArtistChartItem = function (i) {
        if (!editing || !editing.charts[i]) return;
        editing.charts[i].items.push({ label: '', value: '' });
        renderChartsList();
    };
    window.removeArtistChartItem = function (i, j) {
        if (!editing || !editing.charts[i]) return;
        editing.charts[i].items.splice(j, 1);
        renderChartsList();
    };

    // ------------------------------------------------------------------
    // ТАБЛИЦЫ (ячейки заполняются по клику; поддерживается вставка из Excel)
    // ------------------------------------------------------------------
    function tableCard(t, i) {
        const cell = 'w-full min-w-[7rem] bg-[#0a0305] border border-amber-500/15 hover:border-amber-500/40 focus:border-amber-400 px-2 py-1.5 text-xs text-white focus:outline-none transition';
        return `
        <div class="bg-[#16070b] border border-amber-500/20 rounded-2xl p-4 flex flex-col gap-3">
            <div class="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div class="flex-1">
                    <label class="text-[9px] text-slate-400 uppercase font-bold block mb-0.5">Заголовок таблицы</label>
                    <input type="text" value="${esc(t.title || '')}" placeholder="Например: Сравнение сезонов" oninput="artistTableField(${i},'title',this.value)" class="w-full bg-[#0a0305] border border-amber-500/20 px-2.5 py-1.5 text-xs text-white rounded-lg focus:outline-none focus:border-amber-400" />
                </div>
                <div class="flex gap-1.5 flex-wrap">
                    <button type="button" onclick="addArtistTableRow(${i})" class="px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-bold text-[10px] uppercase rounded-lg transition">+ строка</button>
                    <button type="button" onclick="addArtistTableCol(${i})" class="px-3 py-1.5 bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300 font-bold text-[10px] uppercase rounded-lg transition">+ столбец</button>
                    <button type="button" onclick="removeArtistTable(${i})" class="px-3 py-1.5 bg-rose-950/40 hover:bg-rose-900 border border-rose-500/30 text-rose-300 font-bold text-[10px] uppercase rounded-lg transition">Удалить</button>
                </div>
            </div>

            <div class="overflow-x-auto rounded-xl border border-amber-500/15">
                <table class="border-collapse">
                    <thead>
                        <tr>
                            ${t.columns.map((c, ci) => `
                                <th class="p-0 align-top">
                                    <div class="flex items-stretch">
                                        <input type="text" value="${esc(c)}" placeholder="Заголовок" oninput="artistTableHeader(${i},${ci},this.value)" onpaste="artistTablePaste(event,${i},-1,${ci})" class="${cell} font-bold text-amber-300 bg-amber-500/10" />
                                        ${t.columns.length > 1 ? `<button type="button" onclick="removeArtistTableCol(${i},${ci})" class="px-1.5 text-rose-400 hover:text-rose-300 text-[10px] bg-[#0a0305] border border-amber-500/15" title="Убрать столбец">✕</button>` : ''}
                                    </div>
                                </th>`).join('')}
                            <th class="w-8"></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${t.rows.map((r, ri) => `
                            <tr>
                                ${t.columns.map((_, ci) => `<td class="p-0"><input type="text" value="${esc(r.cells[ci] || '')}" oninput="artistTableCell(${i},${ri},${ci},this.value)" onpaste="artistTablePaste(event,${i},${ri},${ci})" class="${cell}" /></td>`).join('')}
                                <td class="p-0 text-center"><button type="button" onclick="removeArtistTableRow(${i},${ri})" class="px-2 text-rose-400 hover:text-rose-300 text-[10px]" title="Убрать строку">✕</button></td>
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>

            <div>
                <div class="text-[9px] text-slate-500 uppercase font-bold mb-1.5">Так это увидят на сайте</div>
                <div id="artist-table-preview-${i}">${renderCustomTableCard(t)}</div>
            </div>
        </div>`;
    }

    function renderTablesList() {
        const el = $('artist-tables-list');
        if (!el || !editing) return;
        el.innerHTML = editing.tables.length
            ? editing.tables.map(tableCard).join('')
            : `<div class="text-[11px] text-slate-500 italic bg-[#16070b]/60 border border-dashed border-amber-500/15 rounded-xl px-3 py-6 text-center">Таблиц пока нет. Нажмите «+ Таблица».</div>`;
    }
    function refreshTablePreview(i) {
        const box = $('artist-table-preview-' + i);
        if (box && editing && editing.tables[i]) box.innerHTML = renderCustomTableCard(editing.tables[i]);
    }
    function ensureCell(t, ri, ci) {
        while (t.rows.length <= ri) t.rows.push({ cells: [] });
        while (t.columns.length <= ci) t.columns.push('Колонка ' + (t.columns.length + 1));
    }

    window.addArtistTable = function () {
        if (!editing) return;
        editing.tables.push({
            id: uid('tb'), title: '',
            columns: ['Показатель', 'Значение', 'Комментарий'],
            rows: [{ cells: ['', '', ''] }, { cells: ['', '', ''] }, { cells: ['', '', ''] }]
        });
        renderTablesList();
    };
    window.removeArtistTable = function (i) {
        if (!editing) return;
        editing.tables.splice(i, 1);
        renderTablesList();
    };
    window.artistTableField = function (i, field, value) {
        if (!editing || !editing.tables[i]) return;
        editing.tables[i][field] = value;
        refreshTablePreview(i);
    };
    window.artistTableHeader = function (i, ci, value) {
        if (!editing || !editing.tables[i]) return;
        editing.tables[i].columns[ci] = value;
        refreshTablePreview(i);
    };
    window.artistTableCell = function (i, ri, ci, value) {
        if (!editing || !editing.tables[i]) return;
        const t = editing.tables[i];
        ensureCell(t, ri, ci);
        t.rows[ri].cells[ci] = value;
        refreshTablePreview(i);
    };
    window.addArtistTableRow = function (i) {
        if (!editing || !editing.tables[i]) return;
        editing.tables[i].rows.push({ cells: editing.tables[i].columns.map(() => '') });
        renderTablesList();
    };
    window.addArtistTableCol = function (i) {
        if (!editing || !editing.tables[i]) return;
        const t = editing.tables[i];
        t.columns.push('Колонка ' + (t.columns.length + 1));
        t.rows.forEach(r => r.cells.push(''));
        renderTablesList();
    };
    window.removeArtistTableRow = function (i, ri) {
        if (!editing || !editing.tables[i]) return;
        editing.tables[i].rows.splice(ri, 1);
        renderTablesList();
    };
    window.removeArtistTableCol = function (i, ci) {
        if (!editing || !editing.tables[i] || editing.tables[i].columns.length <= 1) return;
        const t = editing.tables[i];
        t.columns.splice(ci, 1);
        t.rows.forEach(r => r.cells.splice(ci, 1));
        renderTablesList();
    };
    // Вставка табличных данных (TSV из Excel / Google Таблиц) начиная с выбранной ячейки
    window.artistTablePaste = function (event, i, ri, ci) {
        if (!editing || !editing.tables[i]) return;
        const text = (event.clipboardData || window.clipboardData).getData('text');
        if (!text || !/[\t\n]/.test(text.replace(/\n$/, ''))) return; // обычный текст — пусть вставляется как есть
        event.preventDefault();
        const t = editing.tables[i];
        const rows = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
        // ri === -1 — вставка из ячейки заголовка: первая строка буфера становится заголовками,
        // остальные — строками таблицы сверху вниз
        rows.forEach((cells, dr) => cells.forEach((value, dc) => {
            const bodyRow = ri === -1 ? dr - 1 : ri + dr;
            if (bodyRow < 0) {
                ensureCell(t, 0, ci + dc);
                t.columns[ci + dc] = value.trim();
            } else {
                ensureCell(t, bodyRow, ci + dc);
                t.rows.forEach(r => { while (r.cells.length < t.columns.length) r.cells.push(''); });
                t.rows[bodyRow].cells[ci + dc] = value.trim();
            }
        }));
        renderTablesList();
        showToast(`Вставлено ячеек: ${rows.reduce((s, r) => s + r.length, 0)}`);
    };

    // ------------------------------------------------------------------
    // Сохранение
    // ------------------------------------------------------------------
    function buildArtistFromForm() {
        const manual = editing.manual.map(m => {
            const rankNum = m.rank === '' || m.rank === null || m.rank === undefined ? null : Number(String(m.rank).replace(',', '.'));
            return {
                id: m.id,
                contestId: m.contestId || '',
                contestLabel: String(m.contestLabel || '').trim(),
                date: String(m.date || '').trim(),
                song: String(m.song || '').trim(),
                rank: rankNum !== null && Number.isFinite(rankNum) && rankNum > 0 ? rankNum : null,
                status: String(m.status || '').trim(),
                country: String(m.country || '').trim(),
                flag: String(m.flag || '').trim(),
                performanceVideo: String(m.performanceVideo || '').trim(),
                postcardVideo: String(m.postcardVideo || '').trim(),
                postcard: String(m.postcard || '').trim(),
                description: String(m.description || '').trim(),
                photos: (m.photos || []).filter(Boolean),
                createdAt: m.createdAt || Date.now()
            };
        }).filter(m => m.song || m.contestId || m.contestLabel || m.performanceVideo || m.postcardVideo || m.description || m.photos.length);

        const charts = editing.charts.map(ch => ({
            id: ch.id,
            title: String(ch.title || '').trim(),
            type: ch.type === 'donut' ? 'donut' : 'bars',
            items: (ch.items || [])
                .map(it => ({ label: String(it.label || '').trim(), value: String(it.value === undefined || it.value === null ? '' : it.value).trim() }))
                .filter(it => it.label || it.value)
        })).filter(ch => ch.title || ch.items.length);

        const tables = editing.tables.map(t => {
            const columns = t.columns.map(c => String(c || '').trim());
            let rows = t.rows.map(r => ({ cells: columns.map((_, ci) => String((r.cells && r.cells[ci]) || '').trim()) }));
            while (rows.length && rows[rows.length - 1].cells.every(c => c === '')) rows.pop();
            return { id: t.id, title: String(t.title || '').trim(), columns, rows };
        }).filter(t => t.title || t.rows.length || t.columns.some(c => c));

        return {
            id: editing.id || undefined,
            name: $('artist-input-name').value.trim(),
            country: $('artist-input-country').value.trim(),
            photo: editing.photo || '',
            bio: $('artist-input-bio').value.trim(),
            manualPerformances: manual,
            charts,
            tables
        };
    }

    window.submitArtistForm = async function (keepOpen) {
        if (!editing) return;
        const artist = buildArtistFromForm();
        if (!artist.name) {
            window.switchArtistPane('profile');
            showToast('Укажите имя артиста', true);
            $('artist-input-name').focus();
            return;
        }
        const existing = editing.id ? artists().find(a => a.id === editing.id) : null;
        if (existing && existing.createdAt) artist.createdAt = existing.createdAt;

        const bytes = new Blob([JSON.stringify(artist)]).size;
        if (bytes > MAX_DOC_BYTES) {
            showToast(`Профиль слишком большой (${(bytes / 1048576).toFixed(2)} МБ из ~0.9 МБ допустимых): уберите часть фото или замените загруженные файлы ссылками.`, true);
            return;
        }

        const saveBtn = $('artist-save-btn'), applyBtn = $('artist-apply-btn');
        const prevSave = saveBtn.innerText, prevApply = applyBtn.innerText;
        saveBtn.disabled = applyBtn.disabled = true;
        (keepOpen ? applyBtn : saveBtn).innerText = 'Сохранение…';
        let res;
        try {
            res = await saveArtistProfile(artist);
        } catch (e) {
            res = { ok: false, error: (e && e.message) || String(e) };
        } finally {
            saveBtn.disabled = applyBtn.disabled = false;
            saveBtn.innerText = prevSave;
            applyBtn.innerText = prevApply;
        }

        if (!res.ok) {
            showToast('Не удалось сохранить профиль. ' + (res.error || ''), true);
            showRulesWarning(res.error);
            return;
        }
        if (!res.firestoreOk) {
            showToast('Профиль сохранён только на сервере: Firestore отклонил запись (' + (res.firestoreError || 'нет доступа') + '). Инструкция — на вкладке «Артисты». Без неё данные пропадут при перезапуске сервера.', true);
            showRulesWarning(res.firestoreError);
        } else {
            hideRulesWarning();
            showToast(editing.id ? 'Профиль сохранён' : 'Профиль создан');
        }

        const wasNew = !editing.id;
        editing.id = artist.id;
        renderAdminArtists();
        if (keepOpen) {
            $('artist-edit-id').value = editing.id;
            $('artist-editor-title').innerText = 'Редактирование профиля артиста';
            $('artist-delete-btn').classList.remove('hidden');
            if (wasNew) window.switchArtistPane(editing.pane === 'profile' ? 'performances' : editing.pane);
            else window.switchArtistPane(editing.pane);
        } else {
            window.closeArtistEditorModal();
        }
    };

    window.deleteAdminArtist = function (artistId) {
        const id = artistId || (editing && editing.id);
        if (!id) return;
        const artist = artists().find(a => a.id === id);
        openAdminConfirmModal({
            title: 'Удаление профиля артиста',
            message: `Удалить профиль «${artist ? artist.name : id}»? Сами выступления в сезонах останутся, но связь с профилем будет потеряна, а ручные записи, диаграммы и таблицы удалятся вместе с профилем.`,
            confirmText: 'Удалить профиль',
            onConfirm: async () => {
                const res = await deleteArtistProfile(id);
                if (res && res.ok === false) {
                    showToast('Не удалось удалить профиль: нет связи ни с Firestore, ни с сервером', true);
                    return;
                }
                showToast('Профиль артиста удалён');
                window.closeArtistEditorModal();
                renderAdminArtists();
            }
        });
    };

    // Вызывается при любом обновлении общего состояния (админка подписана на него)
    function onStateChanged() {
        renderAdminArtists();
        if (editing && editing.pane === 'performances' && editing.id) renderLinkedList();
    }

    return { renderAdminArtists, onStateChanged };
}
