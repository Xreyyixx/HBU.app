# Push-воркер HariVision (Cloudflare Workers)

Отправляет Web Push вместо сервера на Render и хранит видео-повтор, загруженный из админки
(см. «Видео-повтор в R2» ниже). Раз в минуту забирает из Firestore
очередь `artistAccounts/broadcast_queue` и рассылает уведомление на все подписки
`artistAccounts/push_sub_*`. В эту очередь уже пишут админка (тестовый push, рассылка)
и публикация новостей и сезонов с галочкой «оповестить», поэтому сайт менять не нужно.

Бесплатный тариф Cloudflare Workers: 100 000 запросов в день, Cron Triggers включены.
Воркер делает около 3 запросов в минуту, то есть примерно 4 300 в день.

## Установка через сайт Cloudflare (без командной строки)

1. Зарегистрируйтесь на https://dash.cloudflare.com (бесплатно, карта не нужна).
2. **Workers & Pages → Create → Create Worker**. Назовите его `hbu-push` и нажмите **Deploy**.
3. **Edit code**: удалите всё в редакторе, вставьте содержимое `worker.js` из этой папки и нажмите **Deploy**.
4. **Settings → Variables and Secrets → Add**:
   - `FIREBASE_API_KEY` = `AIzaSyAZ_vp4IovHZBON0GxSd9lcWt5TFC2mOQw` (Text)
   - `FIREBASE_PROJECT_ID` = `voting-91412` (Text)
   - `VAPID_PUBLIC_KEY` (Secret): то же значение, что было в Render → Environment
   - `VAPID_PRIVATE_KEY` (Secret): то же значение, что было в Render → Environment

   Ключи должны быть **именно те же**, что на Render. Публичный ключ должен совпадать с
   `PERMANENT_VAPID_PUBLIC_KEY` в `notifications.js` (начинается с `BP4FuPYn`). С другими
   ключами Apple и Google отклонят отправку, и всем устройствам придётся подписываться заново.
5. **Settings → Triggers → Cron Triggers → Add**: `* * * * *` (каждую минуту).
6. Откройте адрес воркера (вида `https://hbu-push.<ваше-имя>.workers.dev/`). Там видно,
   сколько подписок он нашёл и что лежит в очереди. В строке `"ok": true` ключи на месте.

## Проверка

Заблокируйте телефон и нажмите в админке «Тестовый push». Админка не достучится до Render
и положит уведомление в очередь. В течение минуты воркер его отправит. Итог последней
отправки (сколько ушло, ответы Apple и Google) появится на странице воркера в `queue.lastResult`.

## Если опубликованы новые firestore.rules

По новым правилам список подписок может читать только админ. Тогда добавьте ещё два секрета:
`FIREBASE_SERVER_EMAIL` и `FIREBASE_SERVER_PASSWORD`. Это тот же служебный аккаунт, что был на Render.

## Через командную строку

```sh
cd push-worker
npx wrangler login
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler deploy
```

## Ключи и пароли: только в Secrets

Репозиторий публичный, поэтому в `wrangler.toml` нельзя писать ключи VAPID, пароль
служебного аккаунта и мастер-ключ. Всё это задаётся в **Settings → Variables and Secrets**
с типом **Secret**. Если значения уже попали на GitHub, их нужно сменить: пароль
`FIREBASE_SERVER_PASSWORD` в Firebase Console → Authentication, мастер-ключ на новый.
Секреты переживают любой деплой, а переменные из `[vars]` деплой перезаписывает.

## Видео-повтор в R2

Админка грузит файл повтора в бакет Cloudflare R2 через этот воркер, а сайт показывает его
обычным видеоплеером. Бесплатно: 10 ГБ хранения, исходящий трафик к зрителям не тарифицируется.
Воркер хранит два последних видео и удаляет более старые.

1. **R2 → Overview**: включите R2. Cloudflare попросит привязать карту, но в бесплатных
   лимитах ничего не списывает.
2. **R2 → Create bucket**, имя `hbu-recaps`.
3. Если воркер деплоится из GitHub, привязка уже описана в `wrangler.toml`.
   Если код вставлялся вручную: **Workers → hbu-push → Settings → Bindings → Add → R2 bucket**,
   Variable name `RECAPS`, бакет `hbu-recaps`.
4. Впишите адрес воркера в `PUSH_WORKER_URL` в `config.js` (или админка спросит его
   при первой загрузке и запомнит на этом устройстве).

В админке на вкладке голосования нажмите **«Загрузить видео»** и выберите файл. Он грузится
частями по 50 МБ с полосой прогресса, после загрузки ссылка сохраняется сама и зрители сразу
видят новое видео. Загружать может только вошедший админ (документ `admins/{uid}`).
