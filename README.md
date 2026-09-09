# Design Alias

Онлайн Alias для дизайнеров.

- Админ: `/admin` — создаёт игру, ведёт ходы, смотрит отчёт
- Игроки: `/join/GameN` — ссылка после создания

## Стек

- Клиент: Vite + React + `@moysklad/uikit` + ALS Hauss
- Сервер: Node + Hono + WebSocket
- БД: PGlite (файловый Postgres, без Docker для локальной разработки)

## Локальный запуск

```bash
npm install
npm install --prefix server
npm run dev
```

- UI: http://localhost:5180/admin
- API: http://localhost:3001

Проверки:

```bash
npx tsx scripts/smoke-e2e.ts
npx tsx scripts/smoke-e2e-extended.ts
npx tsx scripts/smoke-correction.ts
npx tsx scripts/smoke-autofinish.ts
npx tsx scripts/smoke-restore.ts
npx tsx scripts/smoke-disconnect.ts
```

## Публичный деплой (самый простой)

**Railway** одним сервисом:

1. Создайте проект из этого репозитория
2. Builder: Dockerfile
3. Добавьте Volume на `/data`
4. Откройте публичный URL → `/admin`

Переменные:

- `PORT` — Railway задаёт сам
- `PGLITE_DATA_DIR=/data/pglite`
- `HOST=0.0.0.0`

Продакшен-команда уже в Dockerfile: `tsx src/index.ts` (отдаёт API + собранный `dist`).
