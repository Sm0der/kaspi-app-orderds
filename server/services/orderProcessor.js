// Бизнес ведётся по времени Алматы (UTC+5, круглый год, без перевода стрелок). "Сегодня" и
// календарный день любой даты нужно всегда считать по нему, а не по часовому поясу процесса -
// на Vercel это UTC. new Date().setHours(0,0,0,0) и подобное считают полночь по локальному
// поясу ПРОЦЕССА: примерно 5 часов в конце каждых суток по UTC (00:00-04:59 в Алматы) в
// Алматы уже наступил следующий день, а для UTC-процесса - ещё вчерашний. Проверено на
// реальных данных: заказ, оформленный в 00:00:14 5 августа по Алматы, был сохранён с
// order_date "2026-08-04 19:00" - то есть числился ЗАДНИМ ЧИСЛОМ, за 4 августа. Из 1300+
// заказов в такое окно попадает около 8% (109 штук) - фильтр "новые заказы: сегодня/вчера"
// показывал их не за тот день, а срочность (просрочено/сегодня/скоро) в это же окно каждый
// вечер съезжала на день для вообще всех заказов сразу.
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

// Календарный день (YYYY-MM-DD) в Алматы для произвольного момента - строкой, а не Date:
// дальше эта строка либо сравнивается как строка, либо идёт в БД как есть, поэтому её
// значение не зависит от того, как её потом будет форматировать чей-то часовой пояс.
function almatyDateString(epochMs) {
  const shifted = new Date(Number(epochMs) + ALMATY_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Классификация заказов по срочности в зависимости от даты доставки/передачи курьеру
function classifyByUrgency(deadlineEpochMs) {
  if (!deadlineEpochMs) return 'unknown';

  const todayStr = almatyDateString(Date.now());
  const deadlineStr = almatyDateString(deadlineEpochMs);

  const daysUntilDeadline = Math.round(
    (Date.parse(`${deadlineStr}T00:00:00Z`) - Date.parse(`${todayStr}T00:00:00Z`)) / (1000 * 60 * 60 * 24)
  );

  if (daysUntilDeadline < 0) {
    return 'overdue'; // Просрочено
  } else if (daysUntilDeadline === 0) {
    return 'today'; // Срочно сегодня
  } else if (daysUntilDeadline <= 2) {
    return 'soon'; // Скоро (1-2 дня)
  } else {
    return 'upcoming'; // Предстоит
  }
}

// Определить укрупнённый этап заказа по статусу и состоянию Kaspi.
// Kaspi не даёт отдельного "статуса отгрузки" - его нужно вывести из
// связки status/state + assembled (собран ли продавцом) +
// kaspiDelivery.courierTransmissionDate (забрал ли курьер).
function classifyByStage(status, state, assembled, courierTransmissionDate) {
  if (status === 'CANCELLED' || status === 'CANCELLING' || status === 'RETURNED' ||
      status === 'KASPI_DELIVERY_RETURN_REQUESTED') {
    return 'cancelled'; // Отменён / возврат
  }
  if (status === 'COMPLETED') {
    return 'completed'; // Доставлен / завершён
  }
  if (state === 'DELIVERY' || state === 'KASPI_DELIVERY' || state === 'PICKUP') {
    if (courierTransmissionDate) {
      return 'shipping'; // Передан курьеру, в пути
    }
    if (assembled) {
      return 'packed'; // Собран, ждёт курьера - ещё не отправлен
    }
    return 'accepted'; // Принят продавцом, но ещё не собран
  }
  if (status === 'APPROVED_BY_BANK' || state === 'NEW' || state === 'SIGN_REQUIRED') {
    return 'new'; // Новый, нужно принять
  }
  return 'accepted';
}

const STAGE_LABELS = {
  new: '🆕 Новые (нужно принять)',
  accepted: '📦 Принят (не собран)',
  packed: '📤 Собран (ждёт курьера)',
  shipping: '🚚 Передан курьеру / в пути',
  completed: '✅ Доставлено',
  cancelled: '❌ Отменено/Возврат'
};

// Получить заказы для сегодняшнего отгружения
function getTodaysOrders(orders) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return orders.filter(order => {
    if (!order.delivery_date) return false;
    const delivery = new Date(order.delivery_date);
    delivery.setHours(0, 0, 0, 0);
    return delivery.getTime() === today.getTime();
  });
}

// Получить срочные заказы
function getUrgentOrders(orders) {
  return orders.filter(order =>
    order.urgency === 'today' || order.urgency === 'overdue'
  );
}

// Получить статистику по заказам
function getOrderStats(orders, storeName = 'All') {
  const today = getTodaysOrders(orders);
  const urgent = getUrgentOrders(orders);
  const overdue = orders.filter(o => o.urgency === 'overdue');
  const upcoming = orders.filter(o => o.urgency === 'upcoming');

  return {
    store: storeName,
    totalOrders: orders.length,
    todaysOrders: today.length,
    urgentOrders: urgent.length,
    overdueOrders: overdue.length,
    upcomingOrders: upcoming.length,
    ordersWithoutDate: orders.filter(o => !o.delivery_date).length
  };
}

// Преобразовать ответ Kaspi API v2 в наш формат
function transformKaspiOrder(kaspiOrder, storeId) {
  // Kaspi API v2 использует JSON:API формат
  const attributes = kaspiOrder.attributes || kaspiOrder;

  const stage = classifyByStage(
    attributes.status,
    attributes.state,
    attributes.assembled,
    attributes.kaspiDelivery?.courierTransmissionDate
  );

  // Срочность считаем только для заказов, которые продавец ещё должен передать курьеру
  // ('new'/'accepted'/'packed'). После передачи курьеру (stage 'shipping') дедлайн продавца
  // уже выполнен - дальнейшие сроки зависят от Kaspi/курьера, а не от продавца, поэтому
  // такой заказ никогда не должен подсвечиваться как просроченный.
  // Пока заказ не передан курьеру, ориентируемся на дедлайн передачи курьеру
  // (courierTransmissionPlanningDate), а не на дату финальной доставки клиенту -
  // именно этот срок продавец может нарушить, и именно его иногда переносят вручную.
  const needsMerchantAction = ['new', 'accepted', 'packed'].includes(stage);
  const urgencyDeadline = attributes.kaspiDelivery?.courierTransmissionPlanningDate || attributes.plannedDeliveryDate;

  const order = {
    store_id: storeId,
    kaspi_order_id: kaspiOrder.id || attributes.code,
    order_code: attributes.code, // Видимый номер заказа, например "1018430867"
    status: attributes.status, // APPROVED_BY_BANK, ACCEPTED_BY_MERCHANT, COMPLETED, CANCELLED
    state: attributes.state, // NEW, SIGN_REQUIRED, PICKUP, DELIVERY, KASPI_DELIVERY, ARCHIVE
    stage,
    // Обе даты - строкой алматинского календарного дня (см. almatyDateString выше), а не
    // Date-объектом: Date для "timestamp without time zone" сериализуется по часовому поясу
    // процесса и воспроизводит ту же ошибку на день, которую этот код как раз чинит.
    delivery_date: attributes.plannedDeliveryDate ? almatyDateString(attributes.plannedDeliveryDate) : null,
    // Дата фактического создания заказа в Kaspi (когда клиент оформил) - для фильтра
    // "новые заказы за сегодня/вчера/месяц", в отличие от delivery_date (когда доставить).
    order_date: attributes.creationDate ? almatyDateString(attributes.creationDate) : null,
    urgency: needsMerchantAction ? classifyByUrgency(urgencyDeadline) : null,
    raw_data: kaspiOrder
  };

  return order;
}

// Преобразовать позиции заказа из Kaspi API v2 (устаревший формат items[])
function transformOrderItems(kaspiOrderItems = []) {
  return kaspiOrderItems.map(item => {
    const attributes = item.attributes || item;
    return {
      product_code: item.id || attributes.code || attributes.productCode,
      sku: attributes.sku || attributes.productSku || attributes.code,
      name: attributes.name || attributes.title,
      quantity: attributes.quantity || 1,
      image_url: attributes.image || attributes.imageUrl || null,
      raw_data: item
    };
  });
}

// Преобразовать позиции заказа из GET /orders/{id}/entries (реальный формат Kaspi API v2)
function transformOrderEntries(kaspiEntries = []) {
  return kaspiEntries.map(entry => {
    const attributes = entry.attributes || entry;
    const offer = attributes.offer || {};
    return {
      product_code: offer.code || entry.id,
      sku: offer.code,
      name: offer.name || attributes.category?.title || 'Товар',
      quantity: attributes.quantity || 1,
      image_url: null,
      raw_data: entry
    };
  });
}

module.exports = {
  classifyByUrgency,
  classifyByStage,
  STAGE_LABELS,
  getTodaysOrders,
  getUrgentOrders,
  getOrderStats,
  transformKaspiOrder,
  transformOrderItems,
  transformOrderEntries
};
