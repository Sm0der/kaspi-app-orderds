# 🚀 Setup Guide - Kaspi Orders App

## Prerequisites

- **Node.js** 18+
- **PostgreSQL** 12+ (для локальной разработки)
- **npm** или **yarn**

## 📋 Пошаговая установка

### 1️⃣ Установить PostgreSQL локально

**Windows:**
```bash
# Через chocolatey
choco install postgresql

# Или скачать установщик с https://www.postgresql.org/download/windows/
```

**macOS:**
```bash
brew install postgresql@15
brew services start postgresql@15
```

**Linux:**
```bash
sudo apt-get install postgresql postgresql-contrib
sudo systemctl start postgresql
```

### 2️⃣ Создать БД и пользователя

```bash
# Подключиться к PostgreSQL
psql -U postgres

# Создать БД
CREATE DATABASE kaspi_orders;

# Создать пользователя
CREATE USER kaspi_user WITH PASSWORD 'your_secure_password';

# Дать права
ALTER ROLE kaspi_user CREATEDB;
GRANT ALL PRIVILEGES ON DATABASE kaspi_orders TO kaspi_user;

# Выйти
\q
```

### 3️⃣ Клонировать и установить зависимости

```bash
cd kaspi-orders-app
npm install
cd server && npm install && cd ..
cd frontend && npm install && cd ..
```

### 4️⃣ Создать `.env` файл в `server/`

```bash
cp server/.env.example server/.env
```

**Заполнить переменные:**

```env
# === KASPI API ===
# Вставить ваш токен (первый магазин)
KASPI_API_TOKEN_1=WOG5c0tinMjxjeT8DhNU/HOZAfCg7Xvc9Av9rQ4jUCM=

# Второй токен (если есть два магазина)
# KASPI_API_TOKEN_2=your_second_store_token

# === DATABASE ===
# Формат: postgresql://user:password@host:port/database
DATABASE_URL=postgresql://kaspi_user:your_secure_password@localhost:5432/kaspi_orders

# === SERVER ===
PORT=3001
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# === NOTIFICATIONS ===
# VAPID публичный ключ для Web Push API (опционально)
# Сгенерировать: npm install -g web-push && web-push generate-vapid-keys
VAPID_PUBLIC_KEY=your_vapid_public_key
VAPID_PRIVATE_KEY=your_vapid_private_key

# === SYNC ===
# Интервал синхронизации в минутах (по умолчанию 15)
SYNC_INTERVAL_MINUTES=15
```

### 5️⃣ Инициализировать БД

При первом запуске сервера БД будет инициализирована автоматически. Если нужно сделать это вручную:

```bash
cd server
node -e "require('./db/init').initDB().then(() => process.exit(0))"
```

### 6️⃣ Запустить приложение

```bash
# Из корня проекта
npm run dev

# Или отдельно:
# Terminal 1 - Backend
cd server && npm run dev

# Terminal 2 - Frontend
cd frontend && npm run dev
```

**URLs:**
- 🖥️ **Frontend**: http://localhost:3000
- 🔙 **Backend API**: http://localhost:3001
- 📊 **API Health**: http://localhost:3001/api/health

## 🧪 Тестирование

### Проверить подключение к Kaspi API

```bash
# Тест API и получение фото товаров
node scripts/test-kaspi-api.js
```

### Проверить БД

```bash
# Подключиться к БД
psql -U kaspi_user -d kaspi_orders

# Посмотреть таблицы
\dt

# Посмотреть заказы
SELECT * FROM orders;

# Выйти
\q
```

### Синхронизировать заказы вручную

```bash
# Из браузера - нажать кнопку "Синхронизировать" на дашборде
# Или через API:
curl -X POST http://localhost:3001/api/orders/sync
```

## 🐛 Troubleshooting

### ❌ Ошибка подключения к БД

```
error: connect ECONNREFUSED 127.0.0.1:5432
```

**Решение:**
- PostgreSQL не запущен. Запустить:
  ```bash
  # Windows (в PowerShell от администратора)
  net start postgresql-x64-15
  
  # macOS
  brew services start postgresql@15
  
  # Linux
  sudo systemctl start postgresql
  ```

### ❌ Ошибка аутентификации БД

```
error: password authentication failed for user "kaspi_user"
```

**Решение:**
- Проверить пароль в `.env` файле (должен совпадать с тем, что задан при создании пользователя)
- Пересоздать пользователя:
  ```bash
  psql -U postgres
  DROP USER IF EXISTS kaspi_user;
  CREATE USER kaspi_user WITH PASSWORD 'new_password';
  ```

### ❌ Port уже занят

```
Error: listen EADDRINUSE: address already in use :::3001
```

**Решение:**
- Изменить PORT в `.env`:
  ```env
  PORT=3002
  ```

### ❌ Service Worker не регистрируется

**Решение:**
- Service Worker работает только на HTTPS или localhost
- Проверить, что `public/sw.js` существует
- Очистить кэш браузера (DevTools → Application → Clear storage)

## 📊 Мониторинг

### Посмотреть логи синхронизации

```bash
psql -U kaspi_user -d kaspi_orders
SELECT * FROM sync_history ORDER BY created_at DESC LIMIT 10;
```

### Посмотреть статистику заказов

```bash
SELECT 
  s.name as store,
  COUNT(o.id) as total_orders,
  COUNT(CASE WHEN o.urgency = 'today' THEN 1 END) as today_orders,
  COUNT(CASE WHEN o.urgency = 'overdue' THEN 1 END) as overdue_orders
FROM orders o
LEFT JOIN stores s ON o.store_id = s.id
GROUP BY s.name;
```

## 🔐 Production Deploy

Для развертывания на Render/Heroku:

1. **Создать PostgreSQL инстанс** (Render Postgres или Heroku Postgres)
2. **Обновить DATABASE_URL** на production значение
3. **Установить VAPID ключи:**
   ```bash
   npm install -g web-push
   web-push generate-vapid-keys
   ```
4. **Обновить environment variables** в хостинге
5. **Deploy:**
   ```bash
   git push render main
   # или
   git push heroku main
   ```

## 📞 Полезные команды

```bash
# Очистить node_modules и переустановить
rm -rf node_modules && npm install

# Сброс БД (осторожно!)
psql -U kaspi_user -d kaspi_orders -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# Запустить в режиме продакшена
NODE_ENV=production npm run backend:start
```

---

**Status:** ✅ Ready for local development
