# Push-воркер HariVision (Cloudflare Workers)

Отправляет Web Push вместо сервера на Render. Раз в минуту забирает из Firestore
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
