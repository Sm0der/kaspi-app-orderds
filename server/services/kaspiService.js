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

  // Получить список заказов с повторными попытками при ошибках
  async getOrders(pageNumber = 0, pageSize = 50) {
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        // Kaspi API требует фильтр по дате создания (макс 14 дней!)
        const today = new Date();
        const fourteenDaysAgo = new Date(today.getTime() - 14 * 24 * 60 * 60 * 1000);

        // Kaspi API использует объединённый фильтр для всех активных заказов
        const params = {
          'page[number]': pageNumber,
          'page[size]': pageSize,
          'filter[orders][creationDate][$ge]': fourteenDaysAgo.getTime(),
          'filter[orders][creationDate][$le]': today.getTime(),
          'include[orders]': 'user'
        };

        console.log('📍 Kaspi API запрос (getOrders):', { params, baseURL: this.client.defaults.baseURL });

        const response = await this.client.get('/orders', { params });

        // Kaspi возвращает данные в формате JSON:API
        return {
          orders: response.data.data || [],
          meta: response.data.meta || {},
          included: response.data.included || []
        };
      } catch (error) {
        attempt++;

        if (error.response?.status === 429) {
          // Rate limit - подождать и повторить
          const delay = RETRY_DELAY * attempt;
          console.warn(`⚠️  Rate limit (429). Waiting ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else if (error.response?.status >= 500) {
          // Server error - повторить
          const delay = RETRY_DELAY * attempt;
          console.warn(`⚠️  Server error ${error.response.status}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Other error - не повторять
          throw error;
        }
      }
    }

    throw new Error(`Failed to fetch orders after ${MAX_RETRIES} attempts`);
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
    try {
      const response = await this.client.get(`/orders/${orderId}/entries`);
      return response.data.data || [];
    } catch (error) {
      console.error(`Error fetching entries for order ${orderId}:`, error.message);
      throw error;
    }
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
