# Kaspi Orders Monitoring App

Приложение для мониторинга заказов маркетплейса Kaspi.kz для магазинов ART ROOM HOME и КухниKZ.

## 🎯 Задача

Сократить время на проверку заказов к отгрузке: вместо ручного входа в личный кабинет Kaspi — один экран с актуальными заказами, фото товаров и статусом срочности.

## 🏗️ Архитектура

```
kaspi-orders-app/
├── server/              # Node.js + Express backend
│   ├── services/        # Kaspi API wrapper, order classification
│   ├── routes/          # REST endpoints
│   ├── db/              # PostgreSQL schema
│   └── index.js         # Server entry point
├── frontend/            # Next.js PWA
│   ├── app/             # Pages and layouts
│   └── globals.css      # Styles
├── scripts/             # Utilities (API testing, etc)
└── package.json         # Root package
```

## 🚀 Запуск

### Prerequisites
- Node.js 18+
- PostgreSQL 12+ (или используйте Neon для облака)

### Setup

1. **Клонируйте и установите зависимости:**
```bash
cd kaspi-orders-app
npm install
cd server && npm install && cd ..
cd frontend && npm install && cd ..
```

2. **Создайте `.env` файл в корне (`server/.env`):**
```bash
cp server/.env.example server/.env
```

3. **Заполните переменные окружения:**
```env
KASPI_API_TOKEN_1=WOG5c0tinMjxjeT8DhNU/HOZAfCg7Xvc9Av9rQ4jUCM=
DATABASE_URL=postgresql://user:password@localhost:5432/kaspi_orders
```

4. **Запустите оба сервера одновременно:**
```bash
npm run dev
```

Или отдельно:
- **Backend**: `cd server && npm run dev` → http://localhost:3001
- **Frontend**: `cd frontend && npm run dev` → http://localhost:3000

## 📋 API Endpoints

- `GET /api/orders/summary` — Сводка заказов (общее количество, срочные, по магазинам)
- `GET /api/orders` — Список заказов с фильтром (urgency, storeId)
- `GET /api/orders/:orderId` — Детали одного заказа
- `POST /api/orders/sync` — Синхронизировать с Kaspi (по расписанию или по кнопке)

## 🔍 Тестирование Kaspi API

Перед полной разработкой закройте критические вопросы:

```bash
# Протестировать подключение к Kaspi API и получить фото товаров
node scripts/test-kaspi-api.js
```

Скрипт проверит:
1. ✅ Валидность токена
2. ✅ Структуру ответа заказов
3. ✅ Наличие URL изображений в ответе
4. ✅ Альтернативные способы получения фото

## 📝 Требуемые уточнения (из ТЗ п. 9)

- [ ] **Фото товара**: проверить наличие в Kaspi API (скрипт выше)
- [ ] **Пользователи**: только вы или еще кладовщики? (для авторизации)
- [ ] **Мобильное приложение**: PWA достаточно или нужно нативное?
- [ ] **Push-уведомления**: нужны в приложении или Telegram-бот закрывает?
- [ ] **Статусы заказа**: уточнить названия в Kaspi API

## 🔄 Синхронизация

### Текущий статус: **✋ Ручная** (по кнопке)

### План:
- [ ] Добавить сервис синхронизации (cron job каждые 15 мин)
- [ ] Сохранять заказы в PostgreSQL
- [ ] Классифицировать по срочности (overdue/today/soon/upcoming)
- [ ] Кэшировать фото

## 📱 Функциональность

### MVP (текущий этап)
- ✅ Список заказов с фильтром по срочности
- ✅ Статистика по магазинам
- ✅ Визуальное выделение срочных заказов

### Phase 2 (next)
- [ ] Синхронизация с Kaspi API
- [ ] Сохранение истории заказов
- [ ] Фотографии товаров
- [ ] Простая авторизация

### Phase 3 (nice to have)
- [ ] Telegram-бот с ежедневной сводкой
- [ ] Отметка "упаковано"
- [ ] Экспорт в PDF

## 🛠️ Stack

- **Backend**: Node.js, Express, PostgreSQL
- **Frontend**: Next.js 14, React 18
- **Deploy**: Render.com (как текущие сервисы)
- **DB**: Neon (если облачная Postgres)

## 📞 Контакты

Заказчик: ТОО "Арт Рум Казахстан"  
API: Kaspi Marketplace API (v1)

---

**Status**: v0.1 (skeleton, готов для интеграции с Kaspi API)
