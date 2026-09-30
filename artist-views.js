// =====================================================================
// Раздел «Артисты» (публичная часть): список, карточка карьеры, диаграммы и таблицы.
//
// Модуль намеренно не зависит от DOM/Firebase на уровне импорта: все данные приходят
// параметрами, видеоплеер — через фабрику. Так его можно проверять в Node на примерах.
//
// ВАЖНО: это профили-карточки КАРЬЕРЫ (artistProfiles). Не путать с логин-аккаунтами
// исполнителей (Firestore-коллекция "artists", роль artist) — другая сущность.
//
// Откуда берутся выступления (НЕ дублируются в профиле):
//   1) contest.participants[] — записи, привязанные через artistId (или, для старых
//      ещё не привязанных, совпавшие по имени);
//   2) profile.manualPerformances[] — то, что админ добавил вручную (гостевые номера,
//      сезоны, которых нет в базе конкурсов, ссылки на плееры).
// =====================================================================

// Категорийная палитра для колец: порядок подобран и проверен validate_palette.js
// на тёмной поверхности сайта (#0d0408): все проверки PASS, предупреждений нет.
export const CHART_PALETTE = ['#c98500', '#d55181', '#9085e9', '#008300', '#3987e5', '#e66767', '#199e70', '#d95926'];

const RU_MONTHS = { 'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3, 'мая': 4, 'май': 4, 'июн': 5, 'июл': 6, 'авг': 7, 'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11 };

export function esc(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeId(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[^\w-]/g, '');
}

function toNum(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(String(value).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

export function fmtNumber(n) {
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// «8 июля 2026» → UTC-таймстамп. Поле date у сезона — свободный текст, поэтому сравнивать
// его как строку нельзя ("5 августа" < "8 июля" по символам, хотя август позже).
export function parseRuDate(str) {
    const m = String(str || '').toLowerCase().match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})/);
    if (!m) return 0;
    const month = RU_MONTHS[m[2].slice(0, 3)];
    if (month === undefined) return 0;
    return Date.UTC(Number(m[3]), month, Number(m[1]));
}

// Запасной ключ хронологии — timestamp в id сезона ("contest-<Date.now()>").
function idTimestamp(id) {
    const m = String(id || '').match(/(\d{10,})/);
    return m ? parseInt(m[1], 10) : 0;
}

function contestChrono(contest) {
    return parseRuDate(contest && contest.date) || idTimestamp(contest && contest.id);
}

// ---------------------------------------------------------------------
// Выступления и статистика
// ---------------------------------------------------------------------
export function getArtistPerformances(artist, contests) {
    const list = [];
    const contestList = Array.isArray(contests) ? contests : [];
    const byId = new Map(contestList.map(c => [c.id, c]));

    contestList.forEach(c => {
        (c.participants || c.countries || []).forEach((p, idx) => {
            const linkedById = artist.id && p.artistId && p.artistId === artist.id;
            const linkedByName = !p.artistId && artist.name && p.artist &&
                String(p.artist).trim().toLowerCase() === String(artist.name).trim().toLowerCase();
            if (!linkedById && !linkedByName) return;
            list.push({
                ...p,
                key: `c-${safeId(c.id)}-${safeId(p.id || idx)}`,
                source: 'contest',
                contestId: c.id,
                contestKnown: true,
                contestTitle: c.title,
                contestDate: c.date,
                _chrono: contestChrono(c),
                _order: idx
            });
        });
    });

    (Array.isArray(artist.manualPerformances) ? artist.manualPerformances : []).forEach((m, idx) => {
        if (!m) return;
        const contest = m.contestId ? byId.get(m.contestId) : null;
        const songNorm = String(m.song || '').trim().toLowerCase();
        // Защита от двойного учёта: ручная запись, дублирующая уже найденное в сезоне
        // выступление (тот же сезон и та же песня), не считается второй раз.
        if (contest && songNorm && list.some(p => p.source === 'contest' && p.contestId === contest.id &&
            String(p.song || '').trim().toLowerCase() === songNorm)) return;
        list.push({
            ...m,
            key: `m-${safeId(m.id || idx)}`,
            source: 'manual',
            contestId: contest ? contest.id : '',
            contestKnown: Boolean(contest),
            contestTitle: contest ? contest.title : (m.contestLabel || ''),
            contestDate: m.date || (contest ? contest.date : ''),
            _chrono: parseRuDate(m.date) || (contest ? contestChrono(contest) : 0) || Number(m.createdAt) || 0,
            _order: 1000 + idx
        });
    });
    return list;
}

function rankOf(p) {
    const n = toNum(p.rank);
    return n !== null && n > 0 ? n : null;
}

function sortedChrono(perfs, direction) {
    const dir = direction === 'desc' ? -1 : 1;
    return [...perfs].sort((a, b) => {
        if (a._chrono !== b._chrono) return (a._chrono - b._chrono) * dir;
        const ra = rankOf(a), rb = rankOf(b);
        if (ra !== rb) return (ra === null ? 1e9 : ra) - (rb === null ? 1e9 : rb);
        return a._order - b._order;
    });
}

export function computeArtistStats(artist, contests) {
    const performances = getArtistPerformances(artist, contests);
    const ranks = performances.map(rankOf).filter(r => r !== null);
    const wins = ranks.filter(r => r === 1).length;
    const podium = ranks.filter(r => r <= 3).length;
    const best = ranks.length ? Math.min(...ranks) : null;
    const avgRank = ranks.length > 1 ? Math.round((ranks.reduce((s, r) => s + r, 0) / ranks.length) * 10) / 10 : null;
    return { performances, participations: performances.length, wins, podium, best, avgRank };
}

// ---------------------------------------------------------------------
// Мелкие SVG-элементы
// ---------------------------------------------------------------------
function heartSVG(extraClass = 'w-10 h-10') {
    return `
        <svg class="${extraClass} inline-block heart-poly" viewBox="0 0 24 24" fill="none">
            <polygon points="12,6 7.5,3.5 3,7.5 12,12.5" fill="#f59e0b" opacity="0.9" />
            <polygon points="12,6 12,12.5 21,7.5 16.5,3.5" fill="#fbbf24" opacity="1.0" />
            <polygon points="3,7.5 12,21.5 12,12.5" fill="#d97706" opacity="0.75" />
            <polygon points="21,7.5 12,12.5 12,21.5" fill="#f59e0b" opacity="0.85" />
        </svg>`;
}

function sparkleSVG() {
    return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2 L13.6 9.2 L21 12 L13.6 14.8 L12 22 L10.4 14.8 L3 12 L10.4 9.2 Z" fill="currentColor" opacity="0.55" /></svg>`;
}

// ---------------------------------------------------------------------
// Диаграммы, которые админ собирает сам (подписи + значения), сайт только рисует
// ---------------------------------------------------------------------
function cleanChartItems(chart) {
    return (Array.isArray(chart && chart.items) ? chart.items : [])
        .map(it => ({ label: String((it && it.label) || '').trim(), value: toNum(it && it.value) }))
        .filter(it => it.value !== null && it.value > 0);
}

function renderBarsChart(items) {
    const max = Math.max(...items.map(i => i.value));
    return `
        <div class="flex flex-col gap-2.5">
            ${items.map(it => {
                const pct = Math.max(3, Math.round((it.value / max) * 100));
                return `
                <div>
                    <div class="flex items-baseline justify-between gap-3 text-[11px] mb-1">
                        <span class="text-slate-200 font-medium truncate">${esc(it.label || '—')}</span>
                        <span class="text-amber-300 font-mono font-bold whitespace-nowrap">${fmtNumber(it.value)}</span>
                    </div>
                    <div class="h-2.5 rounded-full bg-[#16070b] border border-amber-500/10 overflow-hidden">
                        <div class="h-full rounded-full bg-gradient-to-r from-amber-500 to-yellow-300" style="width:${pct}%"></div>
                    </div>
                </div>`;
            }).join('')}
        </div>`;
}

function renderDonutChart(items, title) {
    const total = items.reduce((s, i) => s + i.value, 0);
    const R = 44, C = 2 * Math.PI * R, gap = items.length > 1 ? 1.6 : 0;
    let acc = 0;
    const segs = items.map((it, i) => {
        const len = (it.value / total) * C;
        const dash = Math.max(0.5, len - gap);
        const seg = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${CHART_PALETTE[i % CHART_PALETTE.length]}" stroke-width="16"
            stroke-dasharray="${dash.toFixed(2)} ${(C - dash).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 60 60)">
            <title>${esc(it.label)}: ${fmtNumber(it.value)} (${Math.round((it.value / total) * 100)}%)</title></circle>`;
        acc += len;
        return seg;
    }).join('');
    return `
        <div class="flex flex-col sm:flex-row items-center gap-5">
            <svg viewBox="0 0 120 120" class="w-36 h-36 flex-shrink-0" role="img" aria-label="${esc(title || 'Диаграмма')}">
                <circle cx="60" cy="60" r="${R}" fill="none" stroke="rgba(148,163,184,0.12)" stroke-width="16" />
                ${segs}
                <text x="60" y="58" text-anchor="middle" font-size="15" font-weight="700" fill="#ffffff" font-family="'Playfair Display', serif">${fmtNumber(total)}</text>
                <text x="60" y="72" text-anchor="middle" font-size="7" fill="#94a3b8" font-family="Inter, sans-serif" letter-spacing="1">ВСЕГО</text>
            </svg>
            <ul class="flex flex-col gap-1.5 w-full min-w-0">
                ${items.map((it, i) => `
                    <li class="flex items-center gap-2 text-[11px]">
                        <span class="w-2.5 h-2.5 rounded-sm flex-shrink-0" style="background:${CHART_PALETTE[i % CHART_PALETTE.length]}"></span>
                        <span class="text-slate-200 font-medium truncate flex-1">${esc(it.label || '—')}</span>
                        <span class="text-amber-300 font-mono font-bold">${fmtNumber(it.value)}</span>
                        <span class="text-slate-500 font-mono w-9 text-right">${Math.round((it.value / total) * 100)}%</span>
                    </li>`).join('')}
            </ul>
        </div>`;
}

export function renderCustomChartCard(chart) {
    const items = cleanChartItems(chart);
    return `
        <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 rounded-3xl backdrop-blur-xl flex flex-col gap-4">
            <h3 class="hbu-display text-lg text-white">${esc(chart.title || 'Диаграмма')}</h3>
            ${items.length === 0
                ? `<div class="text-[11px] text-slate-500 italic">Нет данных для построения.</div>`
                : (chart.type === 'donut' ? renderDonutChart(items, chart.title) : renderBarsChart(items))}
        </div>`;
}

// ---------------------------------------------------------------------
// Таблицы, которые админ заполняет по клику в ячейки
// ---------------------------------------------------------------------
export function renderCustomTableCard(table) {
    const columns = Array.isArray(table.columns) ? table.columns : [];
    const rows = (Array.isArray(table.rows) ? table.rows : []).map(r => (r && Array.isArray(r.cells)) ? r.cells : []);
    return `
        <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 rounded-3xl backdrop-blur-xl flex flex-col gap-4">
            <h3 class="hbu-display text-lg text-white">${esc(table.title || 'Таблица')}</h3>
            <div class="overflow-x-auto rounded-2xl border border-amber-500/15">
                <table class="w-full text-left text-xs border-collapse">
                    <thead>
                        <tr class="bg-amber-500/10">
                            ${columns.map(c => `<th class="px-4 py-2.5 text-[10px] font-bold text-amber-400 uppercase tracking-wider whitespace-nowrap">${esc(c)}</th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((cells, ri) => `
                            <tr class="${ri % 2 ? 'bg-[#16070b]/60' : 'bg-transparent'} border-t border-amber-500/10">
                                ${columns.map((_, ci) => `<td class="px-4 py-2.5 ${ci === 0 ? 'text-white font-semibold' : 'text-slate-300'}">${esc(cells[ci] || '')}</td>`).join('')}
                            </tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
}

// ---------------------------------------------------------------------
// Автоматическая диаграмма «История мест»
// Цвет статуса (победа/призовое/прочее) всегда продублирован числом под баром,
// поэтому смысл не держится только на цвете; нативный <title> даёт hover-подсказку.
// ---------------------------------------------------------------------
export function getArtistRankChartSVG(chronoPerformances) {
    if (!chronoPerformances.length) return '';
    const ranked = chronoPerformances.map(rankOf).filter(r => r !== null);
    const maxRank = Math.max(8, ...(ranked.length ? ranked : [8]));
    const barW = 34, gap = 14, h = 108;
    const totalW = chronoPerformances.length * (barW + gap) - gap;
    const bars = chronoPerformances.map((p, i) => {
        const rank = rankOf(p);
        const barH = rank ? Math.max(10, h * (1 - (rank - 1) / maxRank)) : 6;
        const x = i * (barW + gap), y = h - barH;
        const fill = !rank ? 'rgba(148,163,184,0.3)' : (rank === 1 ? 'url(#hbuArtistGoldBar)' : (rank <= 3 ? '#f59e0b' : '#7c2d3a'));
        const label = rank ? '#' + rank : '—';
        const tip = `${p.contestTitle || p.contestDate || 'Сезон'}${p.song ? ' — «' + p.song + '»' : ''}: ${rank ? rank + ' место' : 'без результата'}`;
        return `
            <g>
                <title>${esc(tip)}</title>
                <rect x="${x}" y="${y}" width="${barW}" height="${barH}" rx="7" fill="${fill}" />
                <text x="${x + barW / 2}" y="${h + 17}" text-anchor="middle" font-size="10" fill="#fbbf24" font-family="Inter, sans-serif" font-weight="700">${label}</text>
            </g>`;
    }).join('');
    return `
        <svg viewBox="0 0 ${totalW} ${h + 26}" class="w-full" style="height:110px;min-width:${Math.min(totalW, 600)}px" preserveAspectRatio="xMinYMax meet" role="img" aria-label="История мест по сезонам">
            <defs>
                <linearGradient id="hbuArtistGoldBar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#fde68a" />
                    <stop offset="100%" stop-color="#f59e0b" />
                </linearGradient>
            </defs>
            ${bars}
        </svg>`;
}

// ---------------------------------------------------------------------
// Фабрика страниц
// ---------------------------------------------------------------------
export function createArtistViews({ renderVideoPlayerHTML }) {
    const renderVideo = typeof renderVideoPlayerHTML === 'function'
        ? renderVideoPlayerHTML
        : (url) => `<a href="${esc(url)}" target="_blank" rel="noopener" class="text-amber-400 underline">${esc(url)}</a>`;

    const PLAYER_CLASS = 'w-full aspect-video rounded-2xl overflow-hidden border border-amber-500/20 bg-black';

    function statusBadge(p) {
        const rank = rankOf(p);
        if (p.status && String(p.status).trim()) {
            return `<span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30">${esc(p.status)}</span>`;
        }
        if (rank === 1) return `<span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">🏆 Победитель</span>`;
        if (rank && rank <= 3) return `<span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">Призёр · #${rank}</span>`;
        if (rank) return `<span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full bg-slate-900 text-slate-400 border border-slate-700">Финалист · #${rank}</span>`;
        return '';
    }

    function mediaBlock(p) {
        const perf = String(p.performanceVideo || '').trim();
        const post = String(p.postcardVideo || '').trim();
        const title = p.contestTitle || '';
        if (perf && post) {
            return `
                <div class="flex items-center gap-1.5 p-1 bg-[#0a0305] border border-amber-500/20 rounded-xl">
                    <button type="button" id="ap-tab-perf-${p.key}" onclick="switchArtistPerfMedia('${p.key}','perf')" class="flex-1 py-1.5 px-2 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-amber-500 text-slate-950 shadow-md transition">🎤 Выступление</button>
                    <button type="button" id="ap-tab-post-${p.key}" onclick="switchArtistPerfMedia('${p.key}','post')" class="flex-1 py-1.5 px-2 rounded-lg text-[11px] font-bold uppercase tracking-wider bg-[#16070b] text-slate-300 border border-amber-500/20 transition">🎬 Открытка</button>
                </div>
                <div id="ap-perf-${p.key}">${renderVideo(perf, 'Выступление: ' + title, PLAYER_CLASS)}</div>
                <div id="ap-post-${p.key}" class="hidden">${renderVideo(post, 'Видео-открытка: ' + title, PLAYER_CLASS)}</div>`;
        }
        if (perf) return `<div class="text-[11px] font-bold text-amber-400 uppercase tracking-wider">🎤 Полное выступление</div>${renderVideo(perf, 'Выступление: ' + title, PLAYER_CLASS)}`;
        if (post) return `<div class="text-[11px] font-bold text-amber-400 uppercase tracking-wider">🎬 Видео-открытка</div>${renderVideo(post, 'Видео-открытка: ' + title, PLAYER_CLASS)}`;
        return `<div class="py-5 px-4 rounded-2xl bg-[#0a0305]/70 border border-dashed border-amber-500/20 text-center"><span class="text-[11px] text-slate-500 font-medium">Видео пока не добавлено</span></div>`;
    }

    function photosBlock(p) {
        const photos = (Array.isArray(p.photos) ? p.photos : []).filter(Boolean);
        if (!photos.length) return '';
        return `
            <div class="grid grid-cols-3 gap-2">
                ${photos.map(src => `<img src="${esc(src)}" alt="" loading="lazy" onclick="openArtistPhoto(this.src)" class="w-full aspect-square object-cover rounded-xl border border-amber-500/15 cursor-zoom-in hover:border-amber-500/50 transition" />`).join('')}
            </div>`;
    }

    function performanceCard(p) {
        const titleInner = `
            <div class="text-[10px] font-mono text-amber-400/80">${esc(p.contestDate || '')}</div>
            <div class="text-xs font-bold text-white uppercase tracking-wide">${esc(p.contestTitle || 'Сезон HariVision')}</div>`;
        const titleHtml = p.contestKnown && p.contestId
            ? `<div onclick="navigateToView('contest-detail','${safeId(p.contestId)}')" class="cursor-pointer hover:text-amber-300 transition" title="Открыть страницу сезона">${titleInner}</div>`
            : `<div>${titleInner}</div>`;
        return `
            <div class="bg-[#16070b]/95 border border-amber-500/20 hover:border-amber-500/40 p-5 rounded-3xl flex flex-col gap-3 transition shadow-xl">
                <div class="flex items-start justify-between gap-2 border-b border-amber-500/10 pb-3">
                    ${titleHtml}
                    ${statusBadge(p)}
                </div>
                ${p.song ? `<div class="text-xs text-slate-300 italic flex items-center gap-1.5 bg-[#0a0305]/60 px-3 py-1.5 rounded-xl border border-amber-500/10"><span class="text-amber-400">🎵</span><span class="font-medium text-white">«${esc(p.song)}»</span>${toNum(p.points) !== null ? `<span class="ml-auto text-[10px] font-mono text-slate-400 not-italic">${fmtNumber(toNum(p.points))} pts</span>` : ''}</div>` : ''}
                ${(p.country || p.flag) ? `<div class="text-[11px] text-amber-300/80 font-bold uppercase tracking-wider">${esc(p.flag || '')} ${esc(p.country || '')}</div>` : ''}
                ${mediaBlock(p)}
                ${p.postcard ? `<div class="text-[11px] text-slate-400 italic">${esc(p.postcard)}</div>` : ''}
                ${p.description ? `<p class="text-xs text-slate-300 leading-relaxed whitespace-pre-line">${esc(p.description)}</p>` : ''}
                ${photosBlock(p)}
            </div>`;
    }

    function getArtistsListHTML(artists, contests) {
        const list = Array.isArray(artists) ? artists : [];
        return `
        <div class="flex flex-col gap-8 page-fade">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl">
                <div>
                    <div class="hbu-eyebrow text-[10px] font-bold text-amber-400 uppercase">Архив карьеры</div>
                    <h1 class="hbu-display text-2xl md:text-3xl text-white uppercase">Артисты HariVision</h1>
                </div>
                <div class="text-xs text-slate-300 font-medium">Всего профилей: <strong class="text-amber-400">${list.length}</strong></div>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                ${list.length === 0 ? `
                    <div class="col-span-full text-center py-16 bg-[#0d0408]/60 border border-amber-500/15 rounded-3xl p-8">
                        <span class="text-4xl block mb-3">🎤</span>
                        <div class="text-base font-bold text-white uppercase tracking-wider">Профили артистов ещё не добавлены</div>
                        <p class="text-xs text-slate-400 mt-2 max-w-md mx-auto">Администратор может создать профили через панель управления.</p>
                    </div>
                ` : list.map(a => {
                    const s = computeArtistStats(a, contests);
                    return `
                    <div onclick="navigateToView('artist-detail','${safeId(a.id)}')" class="hbu-aurora relative bg-[#0d0408]/90 hover:bg-[#16070b] border border-amber-500/20 hover:border-amber-500/40 rounded-3xl backdrop-blur-xl transition shadow-xl cursor-pointer overflow-hidden group flex flex-col">
                        <div class="w-full h-48 overflow-hidden bg-[#16070b] relative">
                            ${a.photo ? `<img src="${esc(a.photo)}" alt="${esc(a.name)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-500" />` : `<div class="w-full h-full flex items-center justify-center">${heartSVG('w-14 h-14 opacity-40')}</div>`}
                            <div class="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-[#0d0408] to-transparent"></div>
                        </div>
                        <div class="p-5 flex flex-col gap-3 flex-grow">
                            <div>
                                <h2 class="text-lg font-black text-white group-hover:text-amber-300 uppercase tracking-wide transition">${esc(a.name)}</h2>
                                ${a.country ? `<div class="text-xs text-amber-300 font-bold uppercase tracking-wider">${esc(a.country)}</div>` : ''}
                            </div>
                            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-slate-300 pt-2 border-t border-amber-500/10 mt-auto">
                                <span>${s.participations} ${s.participations === 1 ? 'участие' : 'участий'}</span>
                                <span class="text-amber-500/40">·</span>
                                <span class="text-amber-400 font-bold">${s.wins} ${s.wins === 1 ? 'победа' : 'побед'}</span>
                                <span class="text-amber-500/40">·</span>
                                <span>${s.podium} призовых</span>
                            </div>
                        </div>
                    </div>`; }).join('')}
            </div>
        </div>`;
    }

    function statTile(value, label, accent) {
        return accent
            ? `<div class="text-center px-5 py-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl"><div class="hbu-display hbu-gold-text text-2xl leading-none">${value}</div><div class="text-[9px] text-amber-400/80 uppercase tracking-widest mt-1">${label}</div></div>`
            : `<div class="text-center px-5 py-3 bg-[#0a0305]/80 border border-amber-500/20 rounded-2xl"><div class="hbu-display text-2xl text-white leading-none">${value}</div><div class="text-[9px] text-slate-400 uppercase tracking-widest mt-1">${label}</div></div>`;
    }

    function getArtistDetailHTML(artistId, artists, contests, opts = {}) {
        const artist = (Array.isArray(artists) ? artists : []).find(a => a.id === artistId);
        if (!artist) {
            return `
            <div class="text-center py-20 bg-[#0d0408]/60 border border-amber-500/15 rounded-3xl">
                <span class="text-4xl block mb-3">🎤</span>
                <div class="text-base font-bold text-white uppercase tracking-wider">Профиль не найден</div>
                <button onclick="navigateToView('artists')" class="mt-4 text-xs font-bold text-amber-400 hover:text-white uppercase tracking-wider">&larr; Вернуться к списку артистов</button>
            </div>`;
        }
        const order = opts.order === 'desc' ? 'desc' : 'asc';
        const stats = computeArtistStats(artist, contests);
        const history = sortedChrono(stats.performances, order);
        const chronoForChart = sortedChrono(stats.performances, 'asc');
        const charts = (Array.isArray(artist.charts) ? artist.charts : []).filter(Boolean);
        const tables = (Array.isArray(artist.tables) ? artist.tables : []).filter(Boolean);
        const seasons = new Set(stats.performances.map(p => p.contestId).filter(Boolean)).size;

        return `
        <div class="flex flex-col gap-10 page-fade">
            <button onclick="navigateToView('artists')" class="self-start text-xs font-bold text-amber-400 hover:text-white uppercase tracking-wider flex items-center gap-1.5 transition"><span>&larr;</span><span>Все артисты</span></button>

            <div class="hbu-aurora relative rounded-3xl overflow-hidden border border-amber-500/30 bg-gradient-to-br from-[#1c080f] via-[#100307] to-[#060204] p-8 md:p-12 shadow-[0_10px_40px_rgba(245,158,11,0.15)] flex flex-col md:flex-row items-center gap-8">
                <div class="hbu-corner top-4 left-4 text-amber-400">${sparkleSVG()}</div>
                <div class="w-40 h-40 md:w-48 md:h-48 rounded-full overflow-hidden border-2 border-amber-500/40 bg-[#16070b] flex-shrink-0 shadow-2xl">
                    ${artist.photo ? `<img src="${esc(artist.photo)}" alt="${esc(artist.name)}" class="w-full h-full object-cover" />` : `<div class="w-full h-full flex items-center justify-center">${heartSVG('w-16 h-16 opacity-40')}</div>`}
                </div>
                <div class="flex-1 flex flex-col items-center md:items-start gap-3 text-center md:text-left min-w-0">
                    ${artist.country ? `<span class="hbu-eyebrow text-[10px] font-bold text-amber-400 uppercase">${esc(artist.country)}</span>` : ''}
                    <h1 class="hbu-display hbu-gold-text text-4xl md:text-5xl leading-tight break-words max-w-full">${esc(artist.name)}</h1>
                    ${artist.bio ? `<p class="text-sm text-slate-300 leading-relaxed max-w-2xl whitespace-pre-line">${esc(artist.bio)}</p>` : ''}
                    <div class="flex flex-wrap items-center justify-center md:justify-start gap-3 pt-2">
                        ${statTile(stats.participations, stats.participations === 1 ? 'Участие' : 'Участий', false)}
                        ${statTile(stats.wins, stats.wins === 1 ? 'Победа' : 'Побед', true)}
                        ${statTile(stats.podium, 'Призовых', false)}
                        ${stats.best ? statTile('#' + stats.best, 'Лучший результат', false) : ''}
                        ${stats.avgRank ? statTile(fmtNumber(stats.avgRank), 'Среднее место', false) : ''}
                        ${seasons > 1 ? statTile(seasons, 'Сезонов', false) : ''}
                    </div>
                </div>
            </div>

            ${charts.length ? `
            <div class="flex flex-col gap-6">
                <div class="border-b border-amber-500/20 pb-4">
                    <div class="hbu-eyebrow text-[10px] font-bold text-amber-400 uppercase">Аналитика</div>
                    <h2 class="hbu-display text-2xl text-white">Статистика артиста</h2>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">${charts.map(renderCustomChartCard).join('')}</div>
            </div>` : ''}

            ${tables.length ? `
            <div class="flex flex-col gap-6">
                ${tables.map(renderCustomTableCard).join('')}
            </div>` : ''}

            ${chronoForChart.some(p => rankOf(p)) ? `
            <div class="bg-[#0d0408]/90 border border-amber-500/20 p-6 md:p-8 rounded-3xl backdrop-blur-xl">
                <h2 class="hbu-display text-xl text-white mb-1">История мест</h2>
                <p class="text-[11px] text-slate-400 mb-4">Результаты по порядку — от первых выступлений к последним. Наведите на бар для подробностей.</p>
                <div class="overflow-x-auto">${getArtistRankChartSVG(chronoForChart)}</div>
            </div>` : ''}

            <div class="flex flex-col gap-6">
                <div class="border-b border-amber-500/20 pb-4 flex items-end justify-between gap-3">
                    <div>
                        <div class="hbu-eyebrow text-[10px] font-bold text-amber-400 uppercase">Летопись</div>
                        <h2 class="hbu-display text-2xl text-white">История выступлений</h2>
                    </div>
                    ${history.length > 1 ? `<button type="button" onclick="toggleArtistHistoryOrder()" class="text-[10px] font-bold text-amber-400 hover:text-white uppercase tracking-wider border border-amber-500/30 rounded-full px-3 py-1.5 transition">⇅ ${order === 'asc' ? 'Порядок: старые → новые' : 'Порядок: новые → старые'}</button>` : ''}
                </div>
                ${history.length === 0 ? `
                    <div class="text-center py-12 bg-[#0d0408]/60 border border-amber-500/15 rounded-3xl">
                        <span class="text-3xl block mb-2">🎤</span>
                        <div class="text-sm font-bold text-slate-300 uppercase tracking-wider">Выступления пока не добавлены</div>
                        <div class="text-xs text-slate-500 mt-1">Администратор может привязать записи из сезонов или добавить выступления вручную.</div>
                    </div>
                ` : `<div class="grid grid-cols-1 md:grid-cols-2 gap-6">${history.map(performanceCard).join('')}</div>`}
            </div>
        </div>`;
    }

    // Глобальные обработчики для inline-атрибутов разметки
    if (typeof window !== 'undefined') {
        window.switchArtistPerfMedia = function (key, which) {
            const perf = document.getElementById('ap-perf-' + key);
            const post = document.getElementById('ap-post-' + key);
            const bPerf = document.getElementById('ap-tab-perf-' + key);
            const bPost = document.getElementById('ap-tab-post-' + key);
            if (!perf || !post) return;
            const showPerf = which === 'perf';
            perf.classList.toggle('hidden', !showPerf);
            post.classList.toggle('hidden', showPerf);
            const on = ['bg-amber-500', 'text-slate-950', 'shadow-md'];
            const off = ['bg-[#16070b]', 'text-slate-300', 'border', 'border-amber-500/20'];
            [[bPerf, showPerf], [bPost, !showPerf]].forEach(([btn, active]) => {
                if (!btn) return;
                on.forEach(c => btn.classList.toggle(c, active));
                off.forEach(c => btn.classList.toggle(c, !active));
            });
        };
        window.openArtistPhoto = function (src) {
            if (!src) return;
            const overlay = document.createElement('div');
            overlay.className = 'fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 cursor-zoom-out';
            overlay.onclick = () => overlay.remove();
            const img = document.createElement('img');
            img.src = src;
            img.className = 'max-w-full max-h-full rounded-2xl border border-amber-500/30 shadow-2xl';
            overlay.appendChild(img);
            document.body.appendChild(overlay);
        };
    }

    return { getArtistsListHTML, getArtistDetailHTML, computeArtistStats: (a, c) => computeArtistStats(a, c) };
}
