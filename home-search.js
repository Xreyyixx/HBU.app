// =====================================================================
// Поиск на главной: сезоны, выступления, артисты, новости, события календаря
// и разделы сайта. Ищет по словам, понимает «ё/е», регистр, транслит
// (rodion ↔ родион) и одну опечатку в длинных словах.
//
// Модуль не хранит данные сам: всё приходит через getData(), а переходы —
// через колбэки, поэтому разметку главной можно перерисовывать как угодно,
// поиск переживёт это (значение и фокус восстанавливаются в restore()).
// =====================================================================
import { esc } from './artist-views.js';
import { transliterateRuToEn, transliterateEnToRu } from './data-service.js';
import { stripRichText } from './rich-text.js';

const GROUP_LIMIT = 5;

const SECTIONS = [
    { title: 'Голосование', icon: '🗳️', view: 'voting', words: 'голосование голосовать голос vote voting бюллетень баллы' },
    { title: 'Архив конкурсов', icon: '🏆', view: 'contests', words: 'архив конкурсы сезоны сезон летопись contests archive' },
    { title: 'Новости', icon: '📰', view: 'news', words: 'новости анонсы пресс news' },
    { title: 'Артисты', icon: '🎤', view: 'artists', words: 'артисты исполнители певцы участники artists' },
    { title: 'Календарь', icon: '📅', view: 'calendar', words: 'календарь события даты расписание calendar' }
];

function normalize(value) {
    return String(value === undefined || value === null ? '' : value)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[^a-zа-я0-9]+/gi, ' ')
        .trim();
}

function stripHtml(value) {
    return stripRichText(String(value || '')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Расстояние Левенштейна не больше 1 (одна опечатка: замена, пропуск или лишняя буква).
function withinOneEdit(a, b) {
    if (a === b) return true;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < la && j < lb) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (la > lb) i++;
        else if (lb > la) j++;
        else { i++; j++; }
    }
    return edits + (la - i) + (lb - j) <= 1;
}

// Варианты слова запроса: как есть + транслит в обе стороны.
function tokenVariants(token) {
    const set = new Set([token]);
    const en = normalize(transliterateRuToEn(token));
    const ru = normalize(transliterateEnToRu(token)).replace(/ё/g, 'е');
    if (en) set.add(en);
    if (ru) set.add(ru);
    return [...set];
}

// Насколько хорошо слово запроса подходит к тексту: 0 — не подходит.
function tokenScore(variants, text, words) {
    let best = 0;
    for (const v of variants) {
        if (!v) continue;
        if (words.some(w => w.startsWith(v))) best = Math.max(best, 3);
        else if (text.includes(v)) best = Math.max(best, 2);
        else if (v.length >= 4 && words.some(w => withinOneEdit(v, w.slice(0, v.length + 1)) || withinOneEdit(v, w))) best = Math.max(best, 1);
    }
    return best;
}

function highlight(raw, tokens) {
    const text = String(raw || '');
    const parts = tokens.filter(t => t.length > 0)
        .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/е/g, '[её]'));
    if (!parts.length) return esc(text);
    const re = new RegExp(`(${parts.join('|')})`, 'gi');
    return text.split(re).map((piece, i) => (i % 2 === 1 ? `<mark>${esc(piece)}</mark>` : esc(piece))).join('');
}

function excerpt(raw, tokens, size = 90) {
    const text = stripHtml(raw);
    if (text.length <= size) return text;
    const lower = text.toLowerCase().replace(/ё/g, 'е');
    let pos = -1;
    for (const t of tokens) {
        pos = lower.indexOf(t);
        if (pos >= 0) break;
    }
    if (pos < 0) return text.slice(0, size) + '…';
    const start = Math.max(0, pos - 30);
    return (start > 0 ? '…' : '') + text.slice(start, start + size) + (start + size < text.length ? '…' : '');
}

export function createHomeSearch({ getData, navigate, openNews, openCalendarDay }) {
    let query = '';
    let focused = false;
    let open = false;
    let activeIndex = -1;
    let actions = [];

    // ---------------- Индекс ----------------
    function buildEntries() {
        const { contests = [], news = [], artists = [], calendar = [] } = getData();
        const entries = [];

        contests.forEach(c => {
            if (!c || !c.id) return;
            const winner = c.winner ? `${c.winner.artist || ''} ${c.winner.song || ''} ${c.winner.country || ''}` : '';
            entries.push({
                group: 'Сезоны',
                title: c.title || 'Сезон',
                meta: [c.date, c.hostCity, c.slogan ? `«${c.slogan}»` : ''].filter(Boolean).join(' · '),
                icon: c.status === 'live' ? '🔴' : '🏆',
                primary: `${c.title || ''} ${c.slogan || ''}`,
                secondary: `${c.date || ''} ${c.hostCity || ''} ${winner} ${stripHtml(c.description)}`,
                weight: 5,
                run: () => navigate('contest-detail', c.id)
            });
            (c.participants || c.countries || []).forEach(p => {
                if (!p || (!p.artist && !p.song)) return;
                entries.push({
                    group: 'Выступления',
                    title: [p.artist, p.song ? `«${p.song}»` : ''].filter(Boolean).join(' — '),
                    meta: [p.country, c.title].filter(Boolean).join(' · '),
                    icon: p.flag && String(p.flag).length <= 8 ? p.flag : '🎶',
                    primary: `${p.artist || ''} ${p.song || ''}`,
                    secondary: `${p.country || ''} ${c.title || ''}`,
                    weight: 1,
                    run: () => navigate('contest-detail', c.id)
                });
            });
        });

        artists.forEach(a => {
            if (!a || !a.id) return;
            entries.push({
                group: 'Артисты',
                title: a.name || 'Артист',
                meta: [a.country, excerpt(a.bio, [], 60)].filter(Boolean).join(' · '),
                image: a.photo || '',
                round: true,
                icon: '🎤',
                primary: `${a.name || ''}`,
                secondary: `${a.country || ''} ${stripHtml(a.bio)}`,
                weight: 6,
                run: () => navigate('artist-detail', a.id)
            });
        });

        news.forEach(n => {
            if (!n || !n.id) return;
            const body = stripHtml(n.content || n.text || n.excerpt || '');
            entries.push({
                group: 'Новости',
                title: n.title || 'Новость',
                meta: [n.date, n.category || n.tag].filter(Boolean).join(' · '),
                body,
                image: n.coverImage || '',
                icon: '📰',
                primary: `${n.title || ''}`,
                secondary: `${n.category || ''} ${n.tag || ''} ${n.date || ''} ${body}`,
                weight: 2,
                run: () => openNews(n.id)
            });
        });

        calendar.forEach(note => {
            if (!note || !note.date || !(note.title || note.text)) return;
            entries.push({
                group: 'Календарь',
                title: note.title || stripHtml(note.text).slice(0, 60),
                meta: note.date,
                body: stripHtml(note.text),
                icon: '📅',
                primary: `${note.title || ''}`,
                secondary: `${stripHtml(note.text)} ${note.date}`,
                weight: 1,
                run: () => openCalendarDay(note.date)
            });
        });

        SECTIONS.forEach(s => entries.push({
            group: 'Разделы',
            title: s.title,
            meta: 'Открыть раздел',
            icon: s.icon,
            primary: s.title,
            secondary: s.words,
            weight: 1,
            run: () => navigate(s.view)
        }));

        return entries;
    }

    function search(q) {
        const tokens = normalize(q).split(' ').filter(Boolean);
        if (!tokens.length) return { tokens, groups: [] };
        const variants = tokens.map(tokenVariants);
        const fullVariants = tokenVariants(tokens.join(' '));

        const scored = [];
        buildEntries().forEach(entry => {
            const p = normalize(entry.primary);
            const sAll = normalize(entry.secondary);
            const pWords = p.split(' ');
            const sWords = sAll.split(' ');
            let score = 0;
            for (const v of variants) {
                const inPrimary = tokenScore(v, p, pWords);
                const inSecondary = inPrimary ? 0 : tokenScore(v, sAll, sWords);
                if (!inPrimary && !inSecondary) return; // каждое слово запроса должно найтись
                score += inPrimary ? inPrimary * 10 : inSecondary * 2;
            }
            if (fullVariants.some(v => p.startsWith(v))) score += 25;
            score += entry.weight;
            scored.push({ entry, score });
        });

        scored.sort((a, b) => b.score - a.score);
        const order = [];
        const byGroup = new Map();
        scored.forEach(({ entry }) => {
            if (!byGroup.has(entry.group)) { byGroup.set(entry.group, []); order.push(entry.group); }
            const list = byGroup.get(entry.group);
            // Одно и то же выступление может быть в нескольких сезонах-копиях — не дублируем.
            if (list.length < GROUP_LIMIT && !list.some(e => e.title === entry.title && e.meta === entry.meta)) list.push(entry);
        });
        return { tokens, groups: order.map(name => ({ name, items: byGroup.get(name) })) };
    }

    // ---------------- Разметка ----------------
    function suggestions() {
        const { contests = [], artists = [], news = [] } = getData();
        const list = [];
        const latest = contests.find(c => c.status === 'completed') || contests[0];
        if (latest && latest.title) list.push(latest.title);
        if (latest && latest.winner && latest.winner.artist) list.push(latest.winner.artist);
        artists.slice(0, 6).forEach(a => { if (a && a.name && list.length < 4) list.push(a.name); });
        const cat = news.find(n => n && (n.category || n.tag));
        if (cat) list.push(cat.category || cat.tag);
        return [...new Set(list.map(s => String(s).trim()).filter(Boolean))].slice(0, 5);
    }

    function html() {
        const chips = suggestions();
        return `
            <div id="home-search" class="hbu-search${query ? ' has-query' : ''}">
                <div class="hbu-search-anchor">
                <label class="hbu-search-box" for="home-search-input">
                    <svg class="hbu-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
                    <input id="home-search-input" class="hbu-search-input" type="search" enterkeyhint="search" autocomplete="off" spellcheck="false"
                        placeholder="Найти сезон, новость, артиста, песню…" aria-label="Поиск по сайту"
                        aria-controls="home-search-results" aria-expanded="false" value="${esc(query)}">
                    <button type="button" class="hbu-search-clear" data-search-clear aria-label="Очистить">✕</button>
                    <span class="hbu-search-kbd" aria-hidden="true">/</span>
                </label>
                <div id="home-search-results" class="hbu-search-results" role="listbox"></div>
                </div>
                ${chips.length ? `
                    <div class="hbu-search-chips">
                        ${chips.map(c => `<button type="button" class="hbu-search-chip" data-search-chip="${esc(c)}">${esc(c)}</button>`).join('')}
                    </div>` : ''}
            </div>
        `;
    }

    function itemHTML(entry, tokens, index) {
        const thumb = entry.image
            ? `<span class="hbu-search-thumb${entry.round ? ' round' : ''}" style="background-image:url(&quot;${esc(entry.image)}&quot;)"></span>`
            : `<span class="hbu-search-thumb${entry.round ? ' round' : ''}">${esc(entry.icon)}</span>`;
        const meta = entry.body && !normalize(entry.primary).includes(tokens[0] || '')
            ? excerpt(entry.body, tokens)
            : entry.meta;
        return `
            <button type="button" class="hbu-search-item${index === activeIndex ? ' is-active' : ''}" role="option" data-search-idx="${index}">
                ${thumb}
                <span class="hbu-search-text">
                    <span class="hbu-search-title" style="display:block">${highlight(entry.title, tokens)}</span>
                    ${meta ? `<span class="hbu-search-meta" style="display:block">${highlight(meta, tokens)}</span>` : ''}
                </span>
                <span class="hbu-search-arrow">→</span>
            </button>
        `;
    }

    function renderResults() {
        const root = document.getElementById('home-search');
        const box = document.getElementById('home-search-results');
        const input = document.getElementById('home-search-input');
        if (!root || !box) return;
        root.classList.toggle('has-query', Boolean(query));

        const show = open && query.trim().length > 0;
        root.classList.toggle('is-open', show);
        if (input) input.setAttribute('aria-expanded', show ? 'true' : 'false');
        if (!show) { box.innerHTML = ''; actions = []; return; }

        const { tokens, groups } = search(query);
        actions = [];
        if (!groups.length) {
            box.innerHTML = `<div class="hbu-search-empty"><b>🔍</b>По запросу «${esc(query)}» ничего не нашлось.<br>Попробуйте имя артиста, название песни или месяц сезона.</div>`;
            return;
        }
        let idx = 0;
        box.innerHTML = groups.map(g => `
            <div class="hbu-search-group">${esc(g.name)}</div>
            ${g.items.map(entry => { actions.push(entry.run); return itemHTML(entry, tokens, idx++); }).join('')}
        `).join('');
        if (activeIndex >= actions.length) activeIndex = actions.length - 1;
    }

    function setActive(next) {
        if (!actions.length) return;
        activeIndex = (next + actions.length) % actions.length;
        document.querySelectorAll('#home-search-results .hbu-search-item').forEach(el => {
            const on = Number(el.dataset.searchIdx) === activeIndex;
            el.classList.toggle('is-active', on);
            if (on) el.scrollIntoView({ block: 'nearest' });
        });
    }

    function choose(index) {
        const run = actions[index];
        if (!run) return;
        open = false;
        focused = false;
        renderResults();
        const input = document.getElementById('home-search-input');
        if (input) input.blur();
        run();
    }

    function setQuery(value, keepFocus = true) {
        query = value;
        activeIndex = query ? 0 : -1;
        open = true;
        const input = document.getElementById('home-search-input');
        if (input && input.value !== value) input.value = value;
        if (keepFocus && input) { input.focus(); focused = true; }
        renderResults();
    }

    // ---------------- События (делегированные, переживают перерисовку) ----------------
    document.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'home-search-input') {
            query = e.target.value;
            activeIndex = query ? 0 : -1;
            open = true;
            renderResults();
        }
    });

    document.addEventListener('focusin', (e) => {
        if (e.target && e.target.id === 'home-search-input') {
            focused = true;
            open = true;
            renderResults();
        }
    });

    document.addEventListener('focusout', (e) => {
        if (e.target && e.target.id === 'home-search-input') focused = false;
    });

    document.addEventListener('keydown', (e) => {
        const input = document.getElementById('home-search-input');
        if (!input) return;
        if (e.target === input) {
            if (e.key === 'ArrowDown') { e.preventDefault(); open = true; if (!actions.length) renderResults(); setActive(activeIndex + 1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(activeIndex < 0 ? 0 : activeIndex); }
            else if (e.key === 'Escape') {
                if (query) setQuery('');
                else { open = false; renderResults(); input.blur(); }
            }
            return;
        }
        // «/» — быстрый переход к поиску, если пользователь не печатает в другом поле
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            input.focus();
            input.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    });

    // pointerdown, а не click: срабатывает раньше, чем поле потеряет фокус
    document.addEventListener('pointerdown', (e) => {
        const root = document.getElementById('home-search');
        if (!root) return;
        const item = e.target.closest && e.target.closest('[data-search-idx]');
        if (item && root.contains(item)) {
            e.preventDefault();
            choose(Number(item.dataset.searchIdx));
            return;
        }
        const chip = e.target.closest && e.target.closest('[data-search-chip]');
        if (chip && root.contains(chip)) {
            e.preventDefault();
            setQuery(chip.dataset.searchChip);
            return;
        }
        if (e.target.closest && e.target.closest('[data-search-clear]')) {
            e.preventDefault();
            setQuery('');
            return;
        }
        if (!root.contains(e.target) && open) {
            open = false;
            renderResults();
        }
    });

    document.addEventListener('mouseover', (e) => {
        const item = e.target.closest && e.target.closest('#home-search-results [data-search-idx]');
        if (item) setActive(Number(item.dataset.searchIdx));
    });

    // Главная перерисовывается целиком при каждом обновлении данных — запоминаем
    // фокус и курсор до перерисовки и возвращаем после, чтобы набор не прерывался.
    function snapshot() {
        const input = document.getElementById('home-search-input');
        if (!input) return null;
        return { focused: document.activeElement === input, caret: [input.selectionStart, input.selectionEnd] };
    }

    function restore(snap) {
        const input = document.getElementById('home-search-input');
        if (!input) return;
        if (snap && snap.focused) {
            focused = true;
            input.focus({ preventScroll: true });
            try { input.setSelectionRange(snap.caret[0], snap.caret[1]); } catch (err) {}
        }
        renderResults();
    }

    return { html, snapshot, restore };
}
