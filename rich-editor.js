// =====================================================================
// Панель форматирования для полей админки (новости, сезоны).
// Добавляет над <textarea> кнопки разметки (см. rich-text.js) и под ним —
// переключатель «Предпросмотр», который показывает текст так, как его
// увидят на сайте. Само поле остаётся обычным textarea, поэтому сохранение
// и загрузка значений в admin.js не меняются.
// =====================================================================
import { renderRichText } from './rich-text.js';

const TOOLS = [
    { id: 'bold', label: '<b>B</b>', title: 'Жирный (Ctrl+B)', wrap: ['**', '**'], placeholder: 'жирный текст', key: 'b' },
    { id: 'italic', label: '<i>I</i>', title: 'Курсив (Ctrl+I)', wrap: ['*', '*'], placeholder: 'курсив', key: 'i' },
    { id: 'underline', label: '<u>U</u>', title: 'Подчёркнутый (Ctrl+U)', wrap: ['__', '__'], placeholder: 'подчёркнутый', key: 'u' },
    { id: 'strike', label: '<s>S</s>', title: 'Зачёркнутый', wrap: ['~~', '~~'], placeholder: 'зачёркнутый' },
    { id: 'mark', label: '<span class="hbu-rt-mark">A</span>', title: 'Выделение маркером', wrap: ['==', '=='], placeholder: 'важное' },
    { id: 'spoiler', label: '🙈', title: 'Спойлер (скрыт, пока не нажмут)', wrap: ['||', '||'], placeholder: 'спойлер' },
    { sep: true },
    { id: 'h1', label: 'H1', title: 'Заголовок', line: '# ' },
    { id: 'h2', label: 'H2', title: 'Подзаголовок', line: '## ' },
    { id: 'ul', label: '•&nbsp;Список', title: 'Маркированный список', line: '- ' },
    { id: 'ol', label: '1.&nbsp;Список', title: 'Нумерованный список', line: 'n. ' },
    { id: 'quote', label: '❝', title: 'Цитата', line: '> ' },
    { sep: true },
    { id: 'link', label: '🔗', title: 'Ссылка', link: true }
];

function fireInput(textarea) {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function wrapSelection(textarea, [before, after], placeholder) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end);
    // Повторное нажатие снимает форматирование с уже обёрнутого текста
    if (value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after) {
        textarea.setRangeText(selected, start - before.length, end + after.length, 'select');
    } else {
        const inner = selected || placeholder;
        textarea.setRangeText(before + inner + after, start, end, 'end');
        textarea.setSelectionRange(start + before.length, start + before.length + inner.length);
    }
    textarea.focus();
    fireInput(textarea);
}

const LINE_PREFIX_RE = /^(#{1,2}\s|>\s?|[-•*]\s|\d+[.)]\s)/;

function prefixLines(textarea, prefix) {
    const { value } = textarea;
    const lineStart = value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
    let lineEnd = value.indexOf('\n', textarea.selectionEnd);
    if (lineEnd === -1) lineEnd = value.length;
    const lines = value.slice(lineStart, lineEnd).split('\n');
    const numbered = prefix === 'n. ';
    const matches = (l) => (numbered ? /^\d+[.)]\s/.test(l) : l.startsWith(prefix));
    const allHave = lines.every(l => !l.trim() || matches(l));
    let n = 0;
    const next = lines.map(l => {
        if (!l.trim()) return l;
        if (allHave) return l.replace(LINE_PREFIX_RE, '');
        n++;
        return (numbered ? `${n}. ` : prefix) + l.replace(LINE_PREFIX_RE, '');
    }).join('\n');
    textarea.setRangeText(next, lineStart, lineEnd, 'select');
    textarea.focus();
    fireInput(textarea);
}

function insertLink(textarea) {
    const url = window.prompt('Адрес ссылки (https://…)', 'https://');
    if (!url || !/^(https?:\/\/|mailto:)\S+$/i.test(url.trim())) return;
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const text = value.slice(start, end) || 'текст ссылки';
    textarea.setRangeText(`[${text}](${url.trim()})`, start, end, 'end');
    textarea.focus();
    fireInput(textarea);
}

function applyTool(textarea, tool) {
    if (tool.wrap) wrapSelection(textarea, tool.wrap, tool.placeholder);
    else if (tool.line) prefixLines(textarea, tool.line);
    else if (tool.link) insertLink(textarea);
}

export function enhanceRichTextarea(textarea) {
    if (!textarea || textarea.dataset.richEnhanced) return;
    textarea.dataset.richEnhanced = '1';

    const bar = document.createElement('div');
    bar.className = 'hbu-rt-toolbar';
    bar.innerHTML = TOOLS.map(t => t.sep
        ? '<span class="hbu-rt-sep"></span>'
        : `<button type="button" class="hbu-rt-btn" data-tool="${t.id}" title="${t.title}">${t.label}</button>`
    ).join('') + '<button type="button" class="hbu-rt-btn hbu-rt-preview-btn" data-preview title="Как это будет выглядеть на сайте">👁 Предпросмотр</button>';

    const preview = document.createElement('div');
    preview.className = 'hbu-rt-preview hidden';

    const hint = document.createElement('div');
    hint.className = 'hbu-rt-hint';
    hint.textContent = 'Выделите текст и нажмите кнопку. Пустая строка начинает новый абзац.';

    textarea.parentNode.insertBefore(bar, textarea);
    textarea.after(hint);
    hint.after(preview);

    const refresh = () => {
        if (preview.classList.contains('hidden')) return;
        preview.innerHTML = textarea.value.trim()
            ? renderRichText(textarea.value)
            : '<span class="hbu-rt-empty">Здесь появится предпросмотр</span>';
    };

    // mousedown + preventDefault: выделение в поле не теряется при нажатии кнопки
    bar.addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        if (btn.hasAttribute('data-preview')) {
            preview.classList.toggle('hidden');
            btn.classList.toggle('is-on', !preview.classList.contains('hidden'));
            refresh();
            return;
        }
        const tool = TOOLS.find(t => t.id === btn.dataset.tool);
        if (tool) applyTool(textarea, tool);
    });

    textarea.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const tool = TOOLS.find(t => t.key && t.key === e.key.toLowerCase());
        if (!tool) return;
        e.preventDefault();
        applyTool(textarea, tool);
    });

    textarea.addEventListener('input', refresh);
    // admin.js заполняет поле через .value при открытии записи, без события input,
    // поэтому открытый предпросмотр сверяется с полем сам.
    let lastValue = textarea.value;
    setInterval(() => {
        if (textarea.value !== lastValue) {
            lastValue = textarea.value;
            refresh();
        }
    }, 400);
}
