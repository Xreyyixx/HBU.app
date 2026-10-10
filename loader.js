// =====================================================================
// Экраны ожидания HBU (обычный скрипт, не модуль: должен сработать ДО того,
// как загрузятся Firebase и app.js, чтобы вместо пустой страницы сразу
// было что-то живое).
//
//   HBULoader.finishBoot()        — убрать стартовый экран
//   HBULoader.viewHTML(view)      — разметка «загружаем раздел» со скелетоном
//   HBULoader.track(promise, txt) — показать «занят» на время запроса к базе
//
// Подключение: <script src="loader.js" data-boot="on"></script> сразу после <body>.
// data-boot="off" — без стартового экрана (только помощники).
// =====================================================================
(function () {
    if (window.HBULoader) return;

    var script = document.currentScript;
    var bootEnabled = !script || script.getAttribute('data-boot') !== 'off';

    var HEART_SVG =
        '<svg class="hbu-ld-heart" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<polygon points="12,6 7.5,3.5 3,7.5 12,12.5" fill="#f59e0b" opacity="0.9"/>' +
        '<polygon points="12,6 12,12.5 21,7.5 16.5,3.5" fill="#fbbf24"/>' +
        '<polygon points="3,7.5 12,21.5 12,12.5" fill="#d97706" opacity="0.75"/>' +
        '<polygon points="21,7.5 12,12.5 12,21.5" fill="#f59e0b" opacity="0.85"/>' +
        '</svg>';

    var EQ_HTML = '<div class="hbu-ld-eq" data-hbu-tap aria-hidden="true"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>';

    var PHRASES = [
        'Настраиваем микрофоны…',
        'Полируем хрустальное сердце…',
        'Зажигаем софиты…',
        'Подсчитываем баллы жюри…',
        'Разогреваем зал…',
        'Раскладываем блёстки по сцене…',
        'Сверяем часы с HBU…',
        'Будим ведущих…',
        'Проверяем, все ли флаги на месте…',
        'Репетируем «Douze points»…',
        'Распутываем провода за кулисами…',
        'United by cringe…'
    ];

    // ---------------------------------------------------------------
    // Сменяющиеся фразы: один общий таймер на все экраны ожидания
    // ---------------------------------------------------------------
    var phraseIdx = Math.floor(Math.random() * PHRASES.length);
    function nextPhrase() {
        phraseIdx = (phraseIdx + 1) % PHRASES.length;
        return PHRASES[phraseIdx];
    }
    setInterval(function () {
        var els = document.querySelectorAll('[data-hbu-phrase]');
        if (!els.length) return;
        var text = nextPhrase();
        els.forEach(function (el) {
            el.classList.add('is-swapping');
            setTimeout(function () {
                el.textContent = text;
                el.classList.remove('is-swapping');
            }, 300);
        });
    }, 2200);

    // ---------------------------------------------------------------
    // Интерактив: касание сердца/эквалайзера — искры и счётчик
    // ---------------------------------------------------------------
    var SPARKS = ['✦', '✧', '★', '💛', '✨', '❤️', '🎤', '🏆'];
    var MILESTONES = {
        5: 'Зал аплодирует 👏',
        12: 'Douze points! ✨',
        25: 'Это уже фан-клуб 💛',
        50: 'Вы официальный талисман HBU 🏆',
        100: 'Сердце HBU бьётся для вас ❤️'
    };
    var taps = 0;

    function burst(x, y, count) {
        var n = count || 10;
        for (var i = 0; i < n; i++) {
            var s = document.createElement('span');
            s.className = 'hbu-ld-spark';
            s.textContent = SPARKS[Math.floor(Math.random() * SPARKS.length)];
            var angle = (Math.PI * 2 * i) / n + Math.random() * 0.6;
            var dist = 50 + Math.random() * 70;
            s.style.left = x + 'px';
            s.style.top = y + 'px';
            s.style.fontSize = (10 + Math.random() * 12) + 'px';
            s.style.color = Math.random() > 0.5 ? '#fbbf24' : '#f59e0b';
            s.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
            s.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
            s.style.setProperty('--rot', (Math.random() * 360 - 180) + 'deg');
            document.body.appendChild(s);
            setTimeout(function (el) { el.remove(); }, 950, s);
        }
    }

    function registerTap(x, y, root) {
        taps++;
        burst(x, y, MILESTONES[taps] ? 22 : 9);
        var label = MILESTONES[taps] || ('❤ × ' + taps);
        document.querySelectorAll('[data-hbu-score]').forEach(function (el) {
            el.textContent = label;
            el.classList.add('is-bump');
            setTimeout(function () { el.classList.remove('is-bump'); }, 180);
        });
        var eq = root && root.querySelector('.hbu-ld-eq');
        if (eq) {
            eq.classList.add('is-hyped');
            clearTimeout(eq._hype);
            eq._hype = setTimeout(function () { eq.classList.remove('is-hyped'); }, 900);
        }
    }

    document.addEventListener('pointerdown', function (e) {
        var target = e.target && e.target.closest ? e.target.closest('[data-hbu-tap]') : null;
        if (!target) return;
        registerTap(e.clientX, e.clientY, target.closest('#hbu-boot, .hbu-view-loader, #hbu-busy'));
    });

    function scoreHTML() {
        return '<div class="hbu-ld-score" data-hbu-score>' + (taps ? ('❤ × ' + taps) : '') + '</div>';
    }

    // ---------------------------------------------------------------
    // 1. Стартовый экран
    // ---------------------------------------------------------------
    var bootEl = null;
    var bootTimers = [];

    function createBoot() {
        if (document.getElementById('hbu-boot') || !document.body) return;
        bootEl = document.createElement('div');
        bootEl.id = 'hbu-boot';
        bootEl.setAttribute('role', 'status');
        bootEl.setAttribute('aria-live', 'polite');

        var floats = '';
        var FLOATERS = ['✦', '💛', '✧', '🎤', '★', '✨', '🎶', '✦', '💫', '🎵'];
        for (var i = 0; i < FLOATERS.length; i++) {
            floats += '<span class="hbu-boot-float" style="left:' + (5 + Math.random() * 90).toFixed(1) +
                '%;animation-duration:' + (7 + Math.random() * 7).toFixed(1) + 's;animation-delay:-' +
                (Math.random() * 10).toFixed(1) + 's;font-size:' + (10 + Math.random() * 12).toFixed(0) + 'px">' +
                FLOATERS[i] + '</span>';
        }

        bootEl.innerHTML =
            floats +
            '<div class="hbu-boot-stage" data-hbu-tap title="Нажмите на сердце">' +
                '<div class="hbu-boot-orbit"><i></i><i></i><i></i></div>' +
                '<div class="hbu-boot-ring"></div><div class="hbu-boot-ring r2"></div>' +
                '<div class="hbu-boot-heart">' + HEART_SVG + '</div>' +
            '</div>' +
            '<div class="hbu-boot-title">HARIVISION</div>' +
            '<div class="hbu-boot-sub">Haribo Broadcasting Union</div>' +
            '<div class="hbu-ld-bar"></div>' +
            '<div class="hbu-ld-phrase" data-hbu-phrase>' + PHRASES[phraseIdx] + '</div>' +
            scoreHTML() +
            '<div class="hbu-ld-hint">Пока грузится — потыкайте в сердце</div>' +
            '<div class="hbu-boot-slow">Связь с базой сегодня неторопливая. Ещё секунду…' +
                '<br><button type="button" data-hbu-skip>Показать сайт сейчас</button></div>';

        document.body.appendChild(bootEl);

        // Сердце слегка «смотрит» за пальцем/курсором
        var stage = bootEl.querySelector('.hbu-boot-stage');
        bootEl.addEventListener('pointermove', function (e) {
            var dx = (e.clientX / window.innerWidth - 0.5) * 22;
            var dy = (e.clientY / window.innerHeight - 0.5) * 22;
            stage.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) rotateX(' + (-dy).toFixed(1) + 'deg) rotateY(' + dx.toFixed(1) + 'deg)';
        });

        bootEl.querySelector('[data-hbu-skip]').addEventListener('click', finishBoot);
        bootTimers.push(setTimeout(function () {
            var slow = bootEl && bootEl.querySelector('.hbu-boot-slow');
            if (slow) slow.classList.add('is-visible');
        }, 9000));
        // Страховка: даже если что-то сломалось при загрузке, не держим экран вечно.
        bootTimers.push(setTimeout(finishBoot, 25000));
    }

    function finishBoot() {
        bootTimers.forEach(clearTimeout);
        bootTimers = [];
        var el = bootEl || document.getElementById('hbu-boot');
        if (!el || el.classList.contains('is-done')) return;
        el.classList.add('is-done');
        setTimeout(function () { el.remove(); }, 650);
        bootEl = null;
    }

    // ---------------------------------------------------------------
    // 2. Загрузка раздела: заголовок с эквалайзером + скелетон
    // ---------------------------------------------------------------
    var VIEW_TITLES = {
        home: 'Готовим главную сцену',
        contests: 'Листаем архив сезонов',
        'contest-detail': 'Открываем сезон',
        news: 'Свежие новости уже в пути',
        artists: 'Собираем артистов за кулисами',
        'artist-detail': 'Открываем карточку артиста',
        calendar: 'Раскладываем календарь',
        voting: 'Готовим бюллетени',
        admin: 'Загружаем панель управления'
    };

    function skelCard(withMedia) {
        return '<div class="hbu-skel-card">' +
            (withMedia ? '<div class="hbu-skel media"></div>' : '') +
            '<div class="hbu-skel line sm"></div>' +
            '<div class="hbu-skel line lg"></div>' +
            '<div class="hbu-skel line"></div>' +
            '<div class="hbu-skel line" style="width:85%"></div>' +
            '</div>';
    }

    function artistSkel() {
        return '<div class="hbu-skel-card" style="flex-direction:row;align-items:center">' +
            '<div class="hbu-skel avatar"></div>' +
            '<div style="flex:1;display:flex;flex-direction:column;gap:10px">' +
            '<div class="hbu-skel line lg"></div><div class="hbu-skel line sm"></div></div></div>';
    }

    function skeletonFor(view) {
        var i, html = '';
        if (view === 'news') {
            for (i = 0; i < 3; i++) html += skelCard(true);
            return '<div class="hbu-skel-grid cols-3">' + html + '</div>';
        }
        if (view === 'artists') {
            for (i = 0; i < 4; i++) html += artistSkel();
            return '<div class="hbu-skel-grid">' + html + '</div>';
        }
        if (view === 'calendar') {
            for (i = 0; i < 14; i++) html += '<div class="hbu-skel" style="height:54px;border-radius:14px"></div>';
            return '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:8px">' + html + '</div>';
        }
        if (view === 'voting') {
            for (i = 0; i < 4; i++) html += artistSkel();
            return '<div class="hbu-skel-grid">' + html + '</div>';
        }
        if (view === 'home') {
            return '<div class="hbu-skel-grid cols-3">' + skelCard(true) + skelCard(true) + skelCard(true) + '</div>';
        }
        return '<div class="hbu-skel-grid">' + skelCard(false) + skelCard(false) + skelCard(false) + skelCard(false) + '</div>';
    }

    function viewHTML(view) {
        return '<div class="hbu-view-loader" role="status" aria-live="polite">' +
            '<div class="hbu-view-loader-head">' +
                '<div class="hbu-view-loader-heart" data-hbu-tap title="Нажмите">' + HEART_SVG + '</div>' +
                '<div class="hbu-view-loader-title">' + (VIEW_TITLES[view] || 'Загружаем') + '</div>' +
                EQ_HTML +
                '<div class="hbu-ld-phrase" data-hbu-phrase>' + PHRASES[phraseIdx] + '</div>' +
                scoreHTML() +
            '</div>' +
            skeletonFor(view) +
        '</div>';
    }

    // ---------------------------------------------------------------
    // 3. «Занят»: вход, голос, сохранение. Появляется только если запрос
    //    длится дольше ~0.2 с, чтобы быстрые операции не мигали.
    // ---------------------------------------------------------------
    var busyEl = null;
    var busyCount = 0;
    var busyTimer = null;

    function ensureBusyEl() {
        if (busyEl) return busyEl;
        busyEl = document.createElement('div');
        busyEl.id = 'hbu-busy';
        busyEl.setAttribute('role', 'status');
        busyEl.setAttribute('aria-live', 'polite');
        busyEl.innerHTML =
            '<div class="hbu-busy-card">' +
                '<div class="hbu-busy-stage" data-hbu-tap>' +
                    '<div class="hbu-boot-ring"></div>' + HEART_SVG +
                '</div>' +
                '<div class="hbu-busy-label"></div>' +
                '<div class="hbu-ld-bar" style="width:140px"></div>' +
                '<div class="hbu-ld-phrase" data-hbu-phrase style="font-size:11px">' + PHRASES[phraseIdx] + '</div>' +
            '</div>';
        document.body.appendChild(busyEl);
        return busyEl;
    }

    function busy(label) {
        busyCount++;
        var el = ensureBusyEl();
        el.querySelector('.hbu-busy-label').textContent = label || 'Связываемся с базой…';
        if (!busyTimer && !el.classList.contains('is-on')) {
            busyTimer = setTimeout(function () {
                busyTimer = null;
                if (busyCount > 0) el.classList.add('is-on');
            }, 180);
        }
    }

    function done() {
        busyCount = Math.max(0, busyCount - 1);
        if (busyCount > 0) return;
        if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
        if (busyEl) busyEl.classList.remove('is-on');
    }

    function track(promise, label) {
        busy(label);
        return Promise.resolve(promise).finally(done);
    }

    window.HBULoader = {
        finishBoot: finishBoot,
        viewHTML: viewHTML,
        busy: busy,
        done: done,
        track: track,
        burst: burst
    };

    if (bootEnabled) createBoot();
})();
