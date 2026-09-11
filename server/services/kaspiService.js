const axios = require('axios');

// Kaspi API v2 endpoints
const KASPI_API_BASE = 'https://kaspi.kz/shop/api/v2';
const RETRY_DELAY = 1000;
const MAX_RETRIES = 3;

class KaspiService {
  constructor(apiToken) {
    this.apiToken = apiToken;
    this.client = axios.create({
      baseURL: KASPI_API_BASE,
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'X-Auth-Token': apiToken
      }
    });
  }

  // Выполнить GET с повторными попытками при 429 (лимит запросов) и 5xx.
  // Общий для всех чтений: синхронизация ходит в Kaspi параллельно, и 429 здесь -
  // обычное дело, его нельзя просто пробрасывать наверх (иначе заказ теряет данные
  // до следующего запуска синхронизации).
  async getWithRetry(url, params, label) {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await this.client.get(url, params ? { params } : undefined);
        return response.data;
      } catch (error) {
        attempt++;
        const status = error.response?.status;
        // Ответа может не быть вовсе: Kaspi иногда рвёт соединение (ECONNRESET) или
        // не отвечает вовремя. Это ровно тот случай, когда повтор и нужен, а раньше
        // такая ошибка проходила мимо ретраев и роняла синхронизацию всего магазина.
        const networkFailure = !error.response;
        const retriable = networkFailure || status === 429 || status >= 500;

        if (!retriable || attempt >= MAX_RETRIES) {
          throw error;
        }

        const delay = RETRY_DELAY * attempt;
        const reason = networkFailure ? (error.code || 'сеть') : status === 429 ? 'rate limit (429)' : `server error ${status}`;
        console.warn(`⚠️  ${label}: ${reason}. Retry in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error(`${label}: failed after ${MAX_RETRIES} attempts`);
  }

  // Получить список заказов с повторными попытками при ошибках
  async getOrders(pageNumber = 0, pageSize = 50) {
    // Kaspi API требует фильтр по дате создания (макс 14 дней!)
    const today = new Date();
    const fourteenDaysAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);

    // include[orders]=user не запрашиваем: связанные данные (included) мы нигде не читаем,
    // нужные поля клиента и так лежат в attributes.customer, а запрос с include медленнее.
    const data = await this.getWithRetry('/orders', {
      'page[number]': pageNumber,
      'page[size]': pageSize,
      'filter[orders][creationDate][$ge]': fourteenDaysAgo.getTime(),
      'filter[orders][creationDate][$le]': today.getTime()
    }, `getOrders(page ${pageNumber})`);

    // Kaspi возвращает данные в формате JSON:API
    return {
      orders: data.data || [],
      meta: data.meta || {},
      included: data.included || []
    };
  }

  // Получить заказы с фильтром по статусу (APPROVED_BY_BANK = нужно принять, ACCEPTED_BY_MERCHANT = принят)
  async getOrdersByStatus(status = 'APPROVED_BY_BANK', pageNumber = 0, pageSize = 50) {
    try {
      // Kaspi API требует фильтр по дате создания (макс 14 дней!)
      const today = new Date();
      const fourteenDaysAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);

      const response = await this.client.get('/orders', {
        params: {
          'page[number]': pageNumber,
          'page[size]': pageSize,
          'filter[orders][status]': status,
          'filter[orders][creationDate][$ge]': fourteenDaysAgo.getTime(),
          'filter[orders][creationDate][$le]': today.getTime(),
          'include[orders]': 'user'
        }
      });

      return {
        orders: response.data.data || [],
        meta: response.data.meta || []
      };
    } catch (error) {
      console.error(`Error fetching orders with status ${status}:`, error.message);
      throw error;
    }
  }

  // Получить детали конкретного заказа
  async getOrderDetails(orderId) {
    try {
      const response = await this.client.get(`/orders/${orderId}`, {
        params: {
          'include[orders]': 'user'
        }
      });
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching order ${orderId}:`, error.message);
      throw error;
    }
  }

  // Получить товары в заказе
  async getOrderEntries(orderId) {
    const data = await this.getWithRetry(`/orders/${orderId}/entries`, null, `getOrderEntries(${orderId})`);
    return data.data || [];
  }

  // Изменить статус заказа. По документации Kaspi это POST на /orders (не PATCH /orders/{id}),
  // с телом в формате JSON:API: {data: {type: "orders", id, attributes: {...}}}
  async changeOrderStatus(orderId, attributes) {
    try {
      const response = await this.client.post('/orders', {
        data: {
          type: 'orders',
          id: orderId,
          attributes
        }
      });
      return response.data;
    } catch (error) {
      console.error(`Error changing status for order ${orderId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  // Принять заказ (изменить статус с APPROVED_BY_BANK на ACCEPTED_BY_MERCHANT)
  async acceptOrder(orderId) {
    return this.changeOrderStatus(orderId, { status: 'ACCEPTED_BY_MERCHANT' });
  }

  // Отметить, что товар по ПРЕДЗАКАЗУ поступил на склад (ARRIVED).
  // Только для заказов с preOrder=true в статусе ACCEPTED_BY_MERCHANT: без этого шага
  // Kaspi отклоняет ASSEMBLE предзаказа с "The current order status does not allow this action".
  // ВАЖНО: это заявление Kaspi, что товар физически есть, - вызывать только по факту наличия.
  async markArrived(orderId) {
    return this.changeOrderStatus(orderId, { status: 'ARRIVED' });
  }

  // Сформировать накладную (перевести заказ в статус ASSEMBLE).
  // Доступно только для заказов в статусе ACCEPTED_BY_MERCHANT.
  // numberOfSpace - количество накладных/мест (упаковок) для заказа.
  async assembleOrder(orderId, numberOfSpace = 1) {
    return this.changeOrderStatus(orderId, {
      status: 'ASSEMBLE',
      numberOfSpace: String(numberOfSpace)
    });
  }

  // Получить информацию о магазине
  async getShopInfo() {
    try {
      const response = await this.client.get('/shop');
      return response.data.data;
    } catch (error) {
      console.error('Error fetching shop info:', error.message);
      throw error;
    }
  }
}

module.exports = KaspiService;
