# Настройка безопасности HariVision

Порядок важен: сначала аккаунты и ключи, потом правила Firestore.

## 1. Администраторы (Firebase Console)
1. **Authentication → Sign-in method**: включены «Email/Password» и «Anonymous».
2. **Authentication → Users → Add user**: создайте аккаунт каждому админу
   (например `admin@harivision.org`) с надёжным паролем.
3. **Authentication → Users → Add user**: отдельный служебный аккаунт для сервера
   (например `server@harivision.org`).
4. **Firestore → Data**: создайте коллекцию `admins`. Для каждого админа и для
   служебного аккаунта добавьте документ, **ID документа = UID пользователя**
   (UID видно в списке Authentication → Users). Поля любые, например `name: "Admin"`.

## 2. Перенос паролей артистов
До публикации новых правил пароли артистов всё ещё видны всем, поэтому сделайте это сразу:
```
DRY_RUN=1 ADMIN_EMAIL=admin@harivision.org ADMIN_PASSWORD=... node tools/migrate-artist-passwords.mjs
ADMIN_EMAIL=admin@harivision.org ADMIN_PASSWORD=... node tools/migrate-artist-passwords.mjs
```
Скрипт создаёт артистам аккаунты Firebase Auth с их прежними паролями и удаляет поле `password`.

## 3. Правила Firestore
Firebase Console → Firestore → Rules → вставить содержимое `firestore.rules` → Publish.

## 4. Новые секреты (старые утекли через публичный репозиторий)
1. `npx web-push generate-vapid-keys` → записать в `.env` сервера (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`)
   и вставить новый публичный ключ в `notifications.js` (`PERMANENT_VAPID_PUBLIC_KEY`).
   Старые push-подписки перестанут работать — пользователям нужно заново нажать 🔔.
2. `ADMIN_MASTER_KEY` — новая длинная случайная строка (старый мастер-пароль больше не действует).
3. `FIREBASE_SERVER_EMAIL` / `FIREBASE_SERVER_PASSWORD` — служебный аккаунт из шага 1.3.

## 5. Репозиторий
* `.env` и `data/` не коммитить (добавлены в `.gitignore`).
* Удалите из репозитория `data/store.json` (в нём старые ключи и токены).
  Старые секреты остаются в истории git — поэтому их обязательно нужно заменить (шаг 4).
