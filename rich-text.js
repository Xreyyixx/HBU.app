// =====================================================================
// Форматированный текст новостей и сезонов.
//
// Текст хранится как обычная строка с простой разметкой, поэтому старые
// тексты без разметки выглядят как раньше, а HTML из базы никогда не
// попадает на страницу как есть (сначала всё экранируется):
//
//   **жирный**   *курсив*   __подчёркнутый__   ~~зачёркнутый~~
//   ==выделение==   ||спойлер||   [текст ссылки](https://...)
//   # Заголовок   ## Подзаголовок   - пункт списка   1. пункт   > цитата
// =====================================================================

function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Строчная разметка. Получает уже экранированную строку.
function renderInline(escaped) {
    let s = escaped;
    // Ссылки: только http(s) и mailto, чтобы нельзя было вставить javascript:
    s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
        (m, text, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="hbu-rt-link">${text}</a>`);
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<u>$1</u>');
    s = s.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
    s = s.replace(/==([^=\n]+?)==/g, '<mark class="hbu-rt-mark">$1</mark>');
    s = s.replace(/\|\|([^|\n]+?)\|\|/g, '<span class="hbu-rt-spoiler" tabindex="0" title="Нажмите, чтобы открыть" onclick="event.stopPropagation();this.classList.add(\'is-open\')">$1</span>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
    return s;
}

const BLOCK_RULES = [
    { type: 'h2', re: /^##\s+(.+)$/ },
    { type: 'h1', re: /^#\s+(.+)$/ },
    { type: 'quote', re: /^>\s?(.*)$/ },
    { type: 'ul', re: /^\s*[-•*]\s+(.+)$/ },
    { type: 'ol', re: /^\s*\d+[.)]\s+(.+)$/ }
];

// Полный текст: заголовки, списки, цитаты, абзацы.
export function renderRichText(text) {
    const lines = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [];
    let list = null; // { tag, items }
    let quote = [];

    const flushPara = () => {
        if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
        para = [];
    };
    const flushList = () => {
        if (list) out.push(`<${list.tag} class="hbu-rt-list">${list.items.map(i => `<li>${i}</li>`).join('')}</${list.tag}>`);
        list = null;
    };
    const flushQuote = () => {
        if (quote.length) out.push(`<blockquote class="hbu-rt-quote">${quote.join('<br>')}</blockquote>`);
        quote = [];
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (const raw of lines) {
        if (!raw.trim()) { flushAll(); continue; }
        const rule = BLOCK_RULES.find(r => r.re.test(raw));
        const content = rule ? raw.match(rule.re)[1] : raw;
        const html = renderInline(escapeHtml(content));

        if (!rule) { flushList(); flushQuote(); para.push(html); continue; }
        if (rule.type === 'h1' || rule.type === 'h2') {
            flushAll();
            out.push(`<h3 class="hbu-rt-${rule.type}">${html}</h3>`);
        } else if (rule.type === 'quote') {
            flushPara(); flushList();
            quote.push(html);
        } else {
            const tag = rule.type;
            flushPara(); flushQuote();
            if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
            list.items.push(html);
        }
    }
    flushAll();
    return `<div class="hbu-rt">${out.join('')}</div>`;
}

// Короткий текст для карточек: только строчная разметка, переносы — пробелы.
export function renderRichInline(text) {
    const flat = String(text === undefined || text === null ? '' : text)
        .split(/\r?\n/)
        .map(l => {
            const rule = BLOCK_RULES.find(r => r.re.test(l));
            return rule ? l.match(rule.re)[1] : l;
        })
        .join(' ');
    return renderInline(escapeHtml(flat));
}

// Текст без разметки — для поиска, превью и уведомлений.
export function stripRichText(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__|~~|==|\|\|/g, '')
        .replace(/(^|\s)\*(\S)/g, '$1$2').replace(/(\S)\*(\s|$)/g, '$1$2')
        .replace(/^\s*(#{1,2}|>|[-•*]|\d+[.)])\s+/gm, '');
}
