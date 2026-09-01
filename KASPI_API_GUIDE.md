# Kaspi API Guide

## 🔐 Аутентификация

**Header:**
```
X-Auth-Token: <ваш_токен>
Content-Type: application/vnd.api+json
```

## 📍 Base URL

```
https://kaspi.kz/shop/api/v2
```

## 📦 Операции с заказами

### 1. Получить список всех заказов

**Endpoint:**
```
GET /orders
```

**Параметры:**
```
page[number]=0              # Номер страницы (начиная с 0)
page[size]=50               # Кол-во заказов на странице (макс 100)
filter[orders][state]=...   # Фильтр по состоянию
include[orders]=user        # Включить информацию о пользователе
```

**Состояния заказов (state):**
- `NEW` - Новый
- `SIGN_REQUIRED` - Нужна подпись
- `PICKUP` - Самовывоз
- `DELIVERY` - Ваша доставка
- `KASPI_DELIVERY` - Kaspi Доставка
- `ARCHIVE` - Архивный

**Пример запроса:**
```bash
curl -X GET "https://kaspi.kz/shop/api/v2/orders?page[number]=0&page[size]=50&filter[orders][state]=NEW,DELIVERY&include[orders]=user" \
  -H "X-Auth-Token: YOUR_TOKEN" \
  -H "Content-Type: application/vnd.api+json"
```

### 2. Получить заказы по статусу

**Endpoint:**
```
GET /orders
```

**Статусы заказов (status):**
- `APPROVED_BY_BANK` - Одобрен банком, ждет принятия продавцом
- `ACCEPTED_BY_MERCHANT` - Принят продавцом ✅
- `COMPLETED` - Завершён
- `CANCELLED` - Отменён
- `CANCELLING` - В процессе отмены
- `KASPI_DELIVERY_RETURN_REQUESTED` - Запрошен возврат
- `RETURNED` - Возвращён

**Пример:**
```bash
# Получить только принятые заказы
curl -X GET "https://kaspi.kz/shop/api/v2/orders?filter[orders][status]=ACCEPTED_BY_MERCHANT" \
  -H "X-Auth-Token: YOUR_TOKEN" \
  -H "Content-Type: application/vnd.api+json"
```

### 3. Получить детали конкретного заказа

**Endpoint:**
```
GET /orders/{orderId}
```

**Пример:**
```bash
curl -X GET "https://kaspi.kz/shop/api/v2/orders/12345" \
  -H "X-Auth-Token: YOUR_TOKEN"
```

### 4. Принять заказ (изменить статус)

**Endpoint:**
```
PATCH /orders/{orderId}
```

**Body:**
```json
{
  "data": {
    "status": "ACCEPTED_BY_MERCHANT"
  }
}
```

**Пример:**
```bash
curl -X PATCH "https://kaspi.kz/shop/api/v2/orders/12345" \
  -H "X-Auth-Token: YOUR_TOKEN" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{
    "data": {
      "status": "ACCEPTED_BY_MERCHANT"
    }
  }'
```

## 📊 Поля ответа (Order)

```javascript
{
  "id": "order123",
  "attributes": {
    "code": "KZ2026081901",              // Номер заказа (видимый)
    "status": "APPROVED_BY_BANK",       // Статус
    "state": "NEW",                     // Состояние
    "plannedDeliveryDate": "2026-08-19T00:00:00Z",  // КЛЮЧЕВОЕ ПОЛЕ!
    "creationDate": "2026-08-19T10:30:00Z",
    "approvedByBankDate": "2026-08-19T10:30:00Z",
    "totalPrice": 45000,                // Общая сумма в теңге
    "customer": {
      "name": "Иван Иванов",
      "phone": "+77771234567"
    },
    "deliveryMode": "DELIVERY_LOCAL",   // Способ доставки
    "deliveryAddress": "г. Алматы, ул. Абдулова 123",
    "paymentMode": "PAY_WITH_CREDIT",   // Способ оплаты
    "signatureRequired": false,
    "creditTerm": 12,                   // Месяцы кредита
    "preOrder": false,
    "entries": [                        // Товары в заказе
      {
        "id": "entry123",
        "attributes": {
          "sku": "SKU-001",
          "name": "Товар 1",
          "quantity": 2,
          "price": 20000
        }
      }
    ],
    "waybill": "https://kaspi.kz/shop/order/123/waybill",  // Накладная
    "isImeiRequired": false
  },
  "relationships": {
    "user": {
      "data": {
        "id": "user123",
        "type": "user"
      }
    }
  }
}
```

## 🎯 Ключевые поля для нашего приложения

| Поле | Назначение | Пример |
|------|-----------|--------|
| `id` | Уникальный ID заказа | "order123" |
| `code` | Номер заказа (видимый) | "KZ2026081901" |
| `status` | Статус заказа | "ACCEPTED_BY_MERCHANT" |
| `state` | Состояние | "DELIVERY" |
| `plannedDeliveryDate` | **Плановая дата доставки** (для срочности) | "2026-08-19" |
| `totalPrice` | Сумма заказа | 45000 |
| `customer` | ФИО и телефон | {name, phone} |
| `deliveryMode` | Способ доставки | "DELIVERY_LOCAL" |
| `deliveryAddress` | Адрес доставки | "г. Алматы, ул. Абдулова 123" |
| `entries` | Товары в заказе | [{sku, name, quantity}] |
| `waybill` | Ссылка на накладную | URL |

## 🔍 Примеры запросов для нашего приложения

### Получить все заказы к отгрузке сегодня

```bash
# Получить заказы, которые нужно отгрузить (ACCEPTED_BY_MERCHANT)
curl -X GET "https://kaspi.kz/shop/api/v2/orders?filter[orders][status]=ACCEPTED_BY_MERCHANT&page[size]=100" \
  -H "X-Auth-Token: YOUR_TOKEN"
```

### Фильтровать по дате доставки

Kaspi API не поддерживает прямой фильтр по `plannedDeliveryDate` в запросе, поэтому:
1. Получаем все заказы со статусом ACCEPTED_BY_MERCHANT
2. Фильтруем по `plannedDeliveryDate` на стороне приложения (уже реализовано в `orderProcessor.js`)

## ⚠️ Ограничения API

- **Rate Limiting**: ~100 запросов/минуту
- **Размер страницы**: максимум 100 заказов на странице
- **Формат**: JSON:API (JSON API specification)
- **Аутентификация**: Token-based (X-Auth-Token header)

## 📝 Обработка ошибок

```
200 OK - Успешный запрос
400 Bad Request - Неверные параметры
401 Unauthorized - Неверный токен
403 Forbidden - Нет доступа к ресурсу
404 Not Found - Заказ/ресурс не найден
429 Too Many Requests - Превышен лимит запросов
500 Internal Server Error - Ошибка сервера
```

## 🚀 Интеграция в приложение

Код интеграции находится в `server/services/kaspiService.js`:
- `getOrders()` - Получить список заказов
- `getOrdersByStatus()` - Получить заказы по статусу
- `getOrderDetails()` - Получить детали заказа
- `acceptOrder()` - Принять заказ

---

**Документация Kaspi:**
https://guide.kaspi.kz/partner/ru/shop/api/orders

**Дата последнего обновления:** 2026-08-19
