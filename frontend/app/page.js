'use client';

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  registerServiceWorker,
  subscribeToPushNotifications,
  isPushSubscribed,
  sendTestNotification
} from './utils/pushNotifications';
import { supabase } from './lib/supabaseClient';
import Login from './components/Login';

const API_URL = process.env.NEXT_PUBLIC_API_URL;

// Прикладываем токен текущей сессии Supabase к каждому запросу к нашему API - интерсептор,
// а не useEffect, чтобы не зависеть от порядка эффектов (иначе самый первый запрос при
// монтировании дашборда мог бы уйти без заголовка, до того как эффект успеет его выставить).
axios.interceptors.request.use(async (config) => {
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) {
    config.headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  return config;
});

function Dashboard({ onLogout }) {
  const [summary, setSummary] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [selectedUrgency, setSelectedUrgency] = useState(null);
  const [selectedStage, setSelectedStage] = useState(null);
  const ordersListRef = useRef(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(true);
  const [lastSyncTime, setLastSyncTime] = useState(null);

  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(null); // null = все магазины
  const [productQuery, setProductQuery] = useState('');
  const [productQueryInput, setProductQueryInput] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Фильтр по дате СОЗДАНИЯ заказа в Kaspi ("сколько новых заказов сегодня/вчера/за месяц"),
  // отдельно от фильтра "Доставить с/по" (delivery_date) выше.
  const [createdPreset, setCreatedPreset] = useState('all'); // 'all' | 'today' | 'yesterday' | 'month' | 'custom'
  const [createdFromCustom, setCreatedFromCustom] = useState('');
  const [createdToCustom, setCreatedToCustom] = useState('');

  const toISODate = (d) => d.toISOString().slice(0, 10);

  // Вычислить [from, to] по выбранному пресету. 'all' -> нет фильтра (null, null).
  const getCreatedRange = () => {
    const today = new Date();
    if (createdPreset === 'today') {
      const iso = toISODate(today);
      return [iso, iso];
    }
    if (createdPreset === 'yesterday') {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      const iso = toISODate(y);
      return [iso, iso];
    }
    if (createdPreset === 'month') {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return [toISODate(first), toISODate(today)];
    }
    if (createdPreset === 'custom') {
      return [createdFromCustom || null, createdToCustom || null];
    }
    return [null, null];
  };

  const [productSuggestions, setProductSuggestions] = useState([]);
  const [showProductDropdown, setShowProductDropdown] = useState(false);

  const [assembleInput, setAssembleInput] = useState('');
  const [assembling, setAssembling] = useState(false);
  const [assembleResults, setAssembleResults] = useState(null);
  const [assemblePreview, setAssemblePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [skuInput, setSkuInput] = useState('');
  // Правило упаковки можно задать в двух направлениях:
  // 'unitsPerSpace' - несколько мелких штук помещаются в 1 место (например 10 шт в 1 месте)
  // 'spacesPerUnit' - 1 крупная/громоздкая штука занимает несколько мест (например 4 места на 1 шт)
  const [packingMode, setPackingMode] = useState('unitsPerSpace');
  const [packingValueInput, setPackingValueInput] = useState(1);
  const [skuSearching, setSkuSearching] = useState(false);
  const [skuSearchInfo, setSkuSearchInfo] = useState(null);

  const getOrderCodesFromInput = () =>
    assembleInput.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

  const handleFindOrdersBySku = async () => {
    const sku = skuInput.trim();
    if (!sku) {
      setError('Введите SKU (артикул) товара');
      return;
    }

    try {
      setSkuSearching(true);
      setError(null);
      setSkuSearchInfo(null);
      setAssemblePreview(null);
      setAssembleResults(null);

      // Сохраняем правило упаковки для этого SKU, переводя его в единый формат
      // "мест на 1 шт": для мелких товаров (штук в 1 месте) это 1/значение,
      // для крупных (мест на 1 шт) - само значение.
      const value = Number(packingValueInput);
      if (value && value > 0) {
        const spacesPerUnit = packingMode === 'unitsPerSpace' ? 1 / value : value;
        try {
          await axios.put(`${API_URL}/api/orders/products/packing`, {
            sku,
            spacesPerUnit,
            storeId: selectedStoreId || undefined
          });
        } catch (err) {
          // Товар может быть не найден в каталоге - не блокируем поиск заказов из-за этого
          console.warn('Packing rule not saved:', err.response?.data?.error || err.message);
        }
      }

      const response = await axios.get(`${API_URL}/api/orders/by-sku`, {
        params: { sku, storeId: selectedStoreId || undefined }
      });

      const codes = response.data.orders.map(o => o.order_code);
      setSkuSearchInfo({ sku, count: codes.length });

      if (codes.length === 0) {
        setError(`Не найдено ни одного неотправленного заказа с артикулом "${sku}"`);
        return;
      }

      setAssembleInput(codes.join('\n'));
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Не удалось найти заказы по SKU');
    } finally {
      setSkuSearching(false);
    }
  };

  const handlePreviewAssemble = async () => {
    const orderCodes = getOrderCodesFromInput();
    if (orderCodes.length === 0) {
      setError('Введите хотя бы один номер заказа');
      return;
    }

    try {
      setPreviewLoading(true);
      setError(null);
      setAssembleResults(null);

      const response = await axios.get(`${API_URL}/api/orders/assemble-preview`, {
        params: { orderCodes: orderCodes.join(',') }
      });
      setAssemblePreview(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Не удалось построить предпросмотр');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleAssembleBatch = async () => {
    const orderCodes = getOrderCodesFromInput();
    if (orderCodes.length === 0) {
      setError('Введите хотя бы один номер заказа');
      return;
    }

    try {
      setAssembling(true);
      setError(null);

      const response = await axios.post(`${API_URL}/api/orders/assemble-batch`, { orderCodes });

      setAssembleResults(response.data);
      setAssemblePreview(null);
      setTimeout(fetchData, 1500);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Не удалось сформировать накладные');
    } finally {
      setAssembling(false);
    }
  };

  const fetchStores = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/stores`);
      setStores(response.data.data || []);
    } catch (err) {
      console.error('Failed to fetch stores:', err);
    }
  };

  const fetchProductSuggestions = async (q) => {
    try {
      const params = {};
      if (q) params.q = q;
      if (selectedStoreId) params.storeId = selectedStoreId;

      const response = await axios.get(`${API_URL}/api/orders/products/suggest`, { params });
      setProductSuggestions(response.data.data || []);
    } catch (err) {
      console.error('Failed to fetch product suggestions:', err);
    }
  };

  const fetchData = async () => {
    try {
      setLoading(true);
      setError(null);

      const params = {};
      if (selectedStoreId) params.storeId = selectedStoreId;
      if (productQuery) params.product = productQuery;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;

      const [createdFrom, createdTo] = getCreatedRange();
      if (createdFrom) params.orderDateFrom = createdFrom;
      if (createdTo) params.orderDateTo = createdTo;

      const response = await axios.get(`${API_URL}/api/orders/summary`, { params });
      setSummary(response.data);
      setOrders(response.data.orders || []);
    } catch (err) {
      setError(err.message || 'Failed to fetch orders');
      console.error('API Error:', err);
    } finally {
      setLoading(false);
    }
  };

  // Debounce поиска по товару + загрузка подсказок для выпадающего списка
  useEffect(() => {
    const timeout = setTimeout(() => {
      setProductQuery(productQueryInput);
      fetchProductSuggestions(productQueryInput);
    }, 300);
    return () => clearTimeout(timeout);
  }, [productQueryInput, selectedStoreId]);

  const handleSync = async () => {
    try {
      setSyncing(true);
      setError(null);

      const response = await axios.post(`${API_URL}/api/orders/sync`);

      setLastSyncTime(new Date());
      console.log('✓ Sync completed:', response.data);

      // Обновить данные после синхронизации
      setTimeout(fetchData, 1000);
    } catch (err) {
      setError(err.message || 'Sync failed');
      console.error('Sync error:', err);
    } finally {
      setSyncing(false);
    }
  };

  const handleTogglePush = async () => {
    try {
      if (pushEnabled) {
        // Отписать
        const { unsubscribeFromPushNotifications } = await import('./utils/pushNotifications');
        await unsubscribeFromPushNotifications();
        setPushEnabled(false);
      } else {
        // Подписать (временно без VAPID ключа для демо)
        await subscribeToPushNotifications(
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || 'BGEw8zpxcsrt2K87KHgKyR4DhpjCo-xc9LjSKw0dITA'
        );
        setPushEnabled(true);
      }
    } catch (err) {
      setError(err.message || 'Failed to toggle push notifications');
      console.error('Push notification error:', err);
    }
  };

  const handleTestNotification = async () => {
    const sent = await sendTestNotification();
    if (sent) {
      console.log('Test notification sent');
    }
  };

  // Initialize service worker and check push subscription status
  useEffect(() => {
    const initPush = async () => {
      try {
        await registerServiceWorker();
        const isSubscribed = await isPushSubscribed();
        setPushEnabled(isSubscribed);
      } catch (err) {
        console.error('Push initialization error:', err);
      } finally {
        setPushLoading(false);
      }
    };

    initPush();
  }, []);

  // Загрузить список магазинов один раз
  useEffect(() => {
    fetchStores();
  }, []);

  // Перезапрашивать данные при смене фильтров (магазин/товар/даты)
  // и обновлять каждые 5 минут
  useEffect(() => {
    fetchData();

    const interval = setInterval(fetchData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [selectedStoreId, productQuery, dateFrom, dateTo, createdPreset, createdFromCustom, createdToCustom]);

  const getUrgencyColor = (urgency) => {
    switch (urgency) {
      case 'overdue': return '#f44336';
      case 'today': return '#ff9800';
      case 'soon': return '#2196f3';
      default: return '#ccc';
    }
  };

  const getUrgencyLabel = (urgency) => {
    switch (urgency) {
      case 'overdue': return 'Просрочено';
      case 'today': return 'Сегодня';
      case 'soon': return 'Скоро';
      case 'upcoming': return 'Предстоит';
      default: return 'Неизвестно';
    }
  };

  const getStageColor = (stage) => {
    switch (stage) {
      case 'new': return '#9c27b0';
      case 'accepted': return '#ff5722';
      case 'packed': return '#ff9800';
      case 'shipping': return '#2196f3';
      case 'completed': return '#4caf50';
      case 'cancelled': return '#757575';
      default: return '#ccc';
    }
  };

  const getStageLabel = (stage) => {
    switch (stage) {
      case 'new': return '🆕 Новый';
      case 'accepted': return '📦 Принят (не собран)';
      case 'packed': return '📤 Собран (ждёт курьера)';
      case 'shipping': return '🚚 Передан курьеру';
      case 'completed': return '✅ Доставлено';
      case 'cancelled': return '❌ Отменён';
      default: return 'Неизвестно';
    }
  };

  const filteredOrders = orders
    .filter(o => {
      if (!selectedUrgency) return true;
      if (selectedUrgency === 'urgent') return o.urgency === 'today' || o.urgency === 'overdue';
      return o.urgency === selectedUrgency;
    })
    .filter(o => !selectedStage || o.stage === selectedStage);

  // Сводка товаров по текущему отфильтрованному списку заказов - сколько штук каждого
  // товара суммарно (например, чтобы свериться с тем, что реально лежит в собранных
  // коробках, когда выбран фильтр "Собран (ждёт курьера)").
  const productsSummary = (() => {
    const map = new Map();
    for (const order of filteredOrders) {
      for (const item of order.items || []) {
        const key = item.sku || item.name;
        const qty = Number(item.quantity) || 1;
        if (!map.has(key)) {
          map.set(key, { name: item.name, sku: item.sku, quantity: 0, ordersCount: 0 });
        }
        const entry = map.get(key);
        entry.quantity += qty;
        entry.ordersCount += 1;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.quantity - a.quantity);
  })();

  // Клик по карточке статистики - переключает фильтр (повторный клик снимает его)
  // и прокручивает к списку заказов
  const toggleUrgencyFilter = (value) => {
    setSelectedUrgency(prev => (prev === value ? null : value));
    ordersListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const toggleStageFilter = (value) => {
    setSelectedStage(prev => (prev === value ? null : value));
    ordersListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const clearAllFilters = () => {
    setSelectedUrgency(null);
    setSelectedStage(null);
    ordersListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const statBoxStyle = (isActive, borderColor) => ({
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'transform 0.12s ease, box-shadow 0.12s ease',
    ...(borderColor ? { borderTop: `4px solid ${borderColor}` } : {}),
    ...(isActive ? {
      boxShadow: '0 0 0 2px ' + (borderColor || '#007bff') + ' inset',
      transform: 'translateY(-2px)'
    } : {})
  });

  return (
    <main>
      <div className="container">
        {/* Заголовок */}
        <div style={{ padding: '24px 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>📦 Kaspi Orders Dashboard</h1>
            <p style={{ color: 'var(--text-dim)', marginTop: '8px' }}>
              Мониторинг заказов для отгрузки сегодня
            </p>
            {lastSyncTime && (
              <p style={{ fontSize: '12px', color: 'var(--text-dimmer)', marginTop: '4px' }}>
                Последняя синхронизация: {lastSyncTime.toLocaleTimeString('ru-RU')}
              </p>
            )}
          </div>
          <button
            onClick={onLogout}
            style={{
              padding: '6px 12px',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'var(--text-dim)'
            }}
          >
            🚪 Выйти
          </button>
        </div>

        {/* Переключатель магазинов */}
        {stores.length > 0 && (
          <div style={{
            margin: '20px 0 0',
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap'
          }}>
            <button
              onClick={() => setSelectedStoreId(null)}
              className="btn-primary"
              style={{ background: !selectedStoreId ? '#007bff' : '#ccc', color: '#fff' }}
            >
              Все магазины
            </button>
            {stores.map(store => (
              <button
                key={store.id}
                onClick={() => setSelectedStoreId(store.id)}
                className="btn-primary"
                style={{ background: selectedStoreId === store.id ? '#007bff' : '#ccc', color: '#fff' }}
              >
                {store.name}
              </button>
            ))}
          </div>
        )}

        {/* Фильтры: товар и даты доставки */}
        <div style={{
          margin: '16px 0 0',
          display: 'flex',
          gap: '12px',
          flexWrap: 'wrap',
          alignItems: 'flex-end'
        }}>
          <div style={{ position: 'relative' }}>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
              Поиск по товару
            </label>
            <input
              type="text"
              value={productQueryInput}
              onChange={(e) => setProductQueryInput(e.target.value)}
              onFocus={() => setShowProductDropdown(true)}
              onBlur={() => setTimeout(() => setShowProductDropdown(false), 150)}
              placeholder="Например: шкаф"
              autoComplete="off"
              style={{
                padding: '8px 12px',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                minWidth: '220px'
              }}
            />
            {showProductDropdown && productSuggestions.length > 0 && (
              <ul style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                marginTop: '4px',
                background: 'var(--panel-solid)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                maxHeight: '260px',
                overflowY: 'auto',
                listStyle: 'none',
                padding: '4px 0',
                zIndex: 10,
                boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
              }}>
                {productSuggestions.map((name, idx) => (
                  <li
                    key={idx}
                    onMouseDown={() => {
                      setProductQueryInput(name);
                      setProductQuery(name);
                      setShowProductDropdown(false);
                    }}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      fontSize: '14px'
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(125, 211, 252, 0.12)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                  >
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
              Доставить с
            </label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
              Доставить по
            </label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
            />
          </div>
          {(productQueryInput || dateFrom || dateTo) && (
            <button
              className="btn-primary"
              style={{ background: '#ccc', color: '#333' }}
              onClick={() => {
                setProductQueryInput('');
                setDateFrom('');
                setDateTo('');
              }}
            >
              ✕ Сбросить фильтры
            </button>
          )}
        </div>

        {/* Фильтр по дате СОЗДАНИЯ заказа - "сколько новых заказов сегодня/вчера/за месяц" */}
        <div style={{
          margin: '16px 0 0',
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          alignItems: 'flex-end'
        }}>
          <div style={{ marginRight: '4px', alignSelf: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-dim)' }}>🆕 Новые заказы:</span>
          </div>
          {[
            ['all', 'Свободная дата'],
            ['today', 'Сегодня'],
            ['yesterday', 'Вчера'],
            ['month', 'Месяц']
          ].map(([value, label]) => (
            <button
              key={value}
              className="btn-primary"
              onClick={() => setCreatedPreset(value)}
              style={{ background: createdPreset === value ? 'var(--accent)' : '#ccc', color: createdPreset === value ? '#04050f' : '#333' }}
            >
              {label}
            </button>
          ))}
          {createdPreset === 'custom' || createdPreset === 'all' ? null : null}
          {createdPreset !== 'today' && createdPreset !== 'yesterday' && createdPreset !== 'month' && (
            <>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
                  Создан с
                </label>
                <input
                  type="date"
                  value={createdFromCustom}
                  onChange={(e) => { setCreatedFromCustom(e.target.value); setCreatedPreset('custom'); }}
                  style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
                  Создан по
                </label>
                <input
                  type="date"
                  value={createdToCustom}
                  onChange={(e) => { setCreatedToCustom(e.target.value); setCreatedPreset('custom'); }}
                  style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
                />
              </div>
            </>
          )}
          {createdPreset !== 'all' && (
            <button
              className="btn-primary"
              style={{ background: '#ccc', color: '#333' }}
              onClick={() => { setCreatedPreset('all'); setCreatedFromCustom(''); setCreatedToCustom(''); }}
            >
              ✕ Сбросить
            </button>
          )}
          {createdPreset !== 'all' && !loading && (
            <span style={{ fontSize: '13px', color: 'var(--accent)', alignSelf: 'center', marginLeft: '4px' }}>
              Найдено новых заказов: {orders.length}
            </span>
          )}
        </div>

        {/* Панель управления */}
        <div style={{
          margin: '24px 0',
          display: 'flex',
          gap: '12px',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              className="btn-primary"
              onClick={handleSync}
              disabled={syncing || loading}
            >
              {syncing ? '⏳ Синхронизация...' : '🔄 Синхронизировать'}
            </button>
            <button
              className={pushEnabled ? 'btn-success' : 'btn-primary'}
              onClick={handleTogglePush}
              disabled={pushLoading}
              style={{
                background: pushEnabled ? '#28a745' : '#ccc',
                color: 'white'
              }}
            >
              {pushLoading ? '⏳' : (pushEnabled ? '🔔 Push включены' : '🔕 Push отключены')}
            </button>
            {pushEnabled && (
              <button
                className="btn-primary"
                onClick={handleTestNotification}
                style={{ background: '#6c757d' }}
              >
                🧪 Test
              </button>
            )}
          </div>

          <button
            className="btn-primary"
            onClick={fetchData}
            disabled={loading}
            title="Обновить из кэша (без синхронизации с Kaspi)"
          >
            {loading ? '⏳' : '↻'}
          </button>
        </div>

        {/* Поиск заказов по SKU */}
        <div className="card" style={{ margin: '0 0 24px' }}>
          <h2 style={{ marginBottom: '12px' }}>🔍 Найти заказы по артикулу (SKU)</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: '14px', marginBottom: '12px' }}>
            Укажите артикул товара и правило упаковки: сколько штук помещается в одно место (для мелких
            товаров) или сколько мест занимает одна штука (для крупных/громоздких товаров).
            Система найдёт все ещё не отправленные заказы с этим товаром, отсортирует по срочности/дате
            и подставит номера в поле ниже — формирование по-прежнему потребует вашего подтверждения.
          </p>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
                SKU / артикул
              </label>
              <input
                type="text"
                value={skuInput}
                onChange={(e) => setSkuInput(e.target.value)}
                placeholder="Например: 108268540"
                style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px', minWidth: '200px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
                Правило упаковки
              </label>
              <select
                value={packingMode}
                onChange={(e) => setPackingMode(e.target.value)}
                style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
              >
                <option value="unitsPerSpace">Штук в 1 месте (мелкий товар)</option>
                <option value="spacesPerUnit">Мест на 1 шт (крупный товар)</option>
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-dim)', marginBottom: '4px' }}>
                {packingMode === 'unitsPerSpace' ? 'Штук в 1 месте' : 'Мест на 1 шт'}
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={packingValueInput}
                onChange={(e) => setPackingValueInput(Math.max(1, parseInt(e.target.value) || 1))}
                style={{ width: '80px', padding: '8px 12px', border: '1px solid var(--border)', borderRadius: '4px' }}
              />
            </div>
            <button
              className="btn-primary"
              onClick={handleFindOrdersBySku}
              disabled={skuSearching || !skuInput.trim()}
              style={{ background: '#007bff', color: '#fff' }}
            >
              {skuSearching ? '⏳ Ищу...' : '🔍 Найти и отсортировать заказы'}
            </button>
          </div>
          {skuSearchInfo && (
            <p style={{ marginTop: '10px', fontSize: '14px', color: '#4ade80' }}>
              ✅ Найдено {skuSearchInfo.count} заказ(ов) с артикулом «{skuSearchInfo.sku}» — номера подставлены в поле ниже.
            </p>
          )}
        </div>

        {/* Пакетное формирование накладных */}
        <div className="card" style={{ margin: '0 0 24px' }}>
          <h2 style={{ marginBottom: '12px' }}>📋 Сформировать накладные по списку</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: '14px', marginBottom: '12px' }}>
            Вставьте номера заказов вручную (через пробел, запятую или с новой строки) — или заполните
            поле, найдя заказы по SKU выше. Система обработает их в порядке приоритета
            (просрочено → сегодня → скоро → остальные), а количество мест (коробок) для каждой
            накладной посчитает сама — по позициям, количеству товара и правилам упаковки.
          </p>
          <textarea
            value={assembleInput}
            onChange={(e) => { setAssembleInput(e.target.value); setAssemblePreview(null); setAssembleResults(null); }}
            placeholder={'Например:\n1035993906\n1040537571, 1032519407'}
            rows={3}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              fontFamily: 'inherit',
              fontSize: '14px',
              resize: 'vertical',
              marginBottom: '12px'
            }}
          />
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn-primary"
              onClick={handlePreviewAssemble}
              disabled={previewLoading || assembling || !assembleInput.trim()}
              style={{ background: '#ccc', color: '#333' }}
            >
              {previewLoading ? '⏳ Считаю...' : '👁 Предпросмотр'}
            </button>
            {assemblePreview && (
              <button
                className="btn-primary"
                onClick={handleAssembleBatch}
                disabled={assembling || assemblePreview.orders.length === 0}
                style={{ background: '#28a745', color: '#fff' }}
              >
                {assembling ? '⏳ Формирую накладные...' : `📦 Подтвердить и сформировать (${assemblePreview.orders.length})`}
              </button>
            )}
          </div>

          {assemblePreview && (
            <div style={{ marginTop: '16px', fontSize: '14px', overflowX: 'auto' }}>
              {assemblePreview.notFound.length > 0 && (
                <div style={{ color: '#ff6b81', marginBottom: '8px' }}>
                  ⚠️ Не найдены в базе: {assemblePreview.notFound.join(', ')}
                </div>
              )}
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
                    <th style={{ padding: '6px 8px' }}>#</th>
                    <th style={{ padding: '6px 8px' }}>Заказ</th>
                    <th style={{ padding: '6px 8px' }}>Срочность</th>
                    <th style={{ padding: '6px 8px' }}>Позиций</th>
                    <th style={{ padding: '6px 8px' }}>Товаров, шт.</th>
                    <th style={{ padding: '6px 8px' }}>Мест в накладной</th>
                    <th style={{ padding: '6px 8px' }}>Товары</th>
                  </tr>
                </thead>
                <tbody>
                  {assemblePreview.orders.map((o, idx) => (
                    <tr key={o.order_code} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text-dimmer)' }}>{idx + 1}</td>
                      <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>#{o.order_code}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <span className="badge" style={{ background: getUrgencyColor(o.urgency), color: '#fff', fontSize: '12px' }}>
                          {getUrgencyLabel(o.urgency)}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px' }}>{o.positionsCount}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {o.items.reduce((sum, i) => sum + (Number(i.quantity) || 1), 0)}
                      </td>
                      <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>{o.numberOfSpace}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>
                        {o.items.map(i => `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ') || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {assembleResults && (
            <div style={{ marginTop: '16px', fontSize: '14px' }}>
              <div style={{ marginBottom: '8px', fontWeight: 'bold' }}>
                Готово: {assembleResults.succeeded} успешно, {assembleResults.failed} с ошибкой (из {assembleResults.total})
              </div>
              {assembleResults.succeeded > 0 && (
                <a
                  href={`${API_URL}/api/orders/manifest?orderCodes=${assembleResults.results
                    .filter(r => r.success)
                    .map(r => r.order_code)
                    .join(',')}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-block',
                    marginBottom: '12px',
                    padding: '8px 16px',
                    background: '#2e7d32',
                    color: '#fff',
                    borderRadius: '4px',
                    textDecoration: 'none',
                    fontWeight: 'bold'
                  }}
                >
                  📄 Скачать сводный PDF по собранным заказам ({assembleResults.succeeded})
                </a>
              )}
              <ul style={{ margin: 0, paddingLeft: '20px' }}>
                {assembleResults.results.map((r, idx) => (
                  <li key={idx} style={{ color: r.success ? '#4ade80' : '#ff6b81', marginBottom: '4px' }}>
                    {r.success ? '✅' : '❌'} #{r.order_code}
                    {r.success
                      ? ` — ${r.numberOfSpace} мест${r.urgency ? `, ${getUrgencyLabel(r.urgency)}` : ''}`
                      : ` — ${r.error}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {error && (
          <div style={{
            background: 'rgba(220, 53, 69, 0.15)',
            color: '#ff6b81',
            padding: '16px',
            borderRadius: '4px',
            marginBottom: '16px'
          }}>
            ❌ {error}
          </div>
        )}

        {!loading && summary && (
          <>
            {/* Статистика */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: '16px',
              marginBottom: '32px'
            }}>
              <div
                className="stat-box"
                onClick={clearAllFilters}
                style={statBoxStyle(!selectedUrgency && !selectedStage, '#007bff')}
                title="Показать все заказы"
              >
                <div className="stat-number">{summary.total.total}</div>
                <div className="stat-label">Всего заказов на отгрузку</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleUrgencyFilter('today')}
                style={statBoxStyle(selectedUrgency === 'today', '#ff9800')}
                title="Показать заказы на сегодня"
              >
                <div className="stat-number" style={{ color: '#ff9800' }}>
                  {summary.total.today}
                </div>
                <div className="stat-label">Сегодня</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleUrgencyFilter('urgent')}
                style={statBoxStyle(selectedUrgency === 'urgent', '#f44336')}
                title="Показать срочные заказы (сегодня + просроченные)"
              >
                <div className="stat-number" style={{ color: '#f44336' }}>
                  {summary.total.urgent}
                </div>
                <div className="stat-label">Срочных</div>
              </div>
              {summary.total.overdue > 0 && (
                <div
                  className="stat-box"
                  onClick={() => toggleUrgencyFilter('overdue')}
                  style={statBoxStyle(selectedUrgency === 'overdue', '#d32f2f')}
                  title="Показать просроченные заказы"
                >
                  <div className="stat-number" style={{ color: '#d32f2f' }}>
                    {summary.total.overdue}
                  </div>
                  <div className="stat-label">Просрочено ⚠️</div>
                </div>
              )}
            </div>

            {/* Статистика по этапам заказа */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: '16px',
              marginBottom: '32px'
            }}>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('new')}
                style={statBoxStyle(selectedStage === 'new', '#9c27b0')}
                title="Показать новые заказы"
              >
                <div className="stat-number" style={{ color: '#9c27b0' }}>
                  {summary.total.new || 0}
                </div>
                <div className="stat-label">🆕 Новые (нужно принять)</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('accepted')}
                style={statBoxStyle(selectedStage === 'accepted', '#ff5722')}
                title="Показать принятые, но не собранные заказы"
              >
                <div className="stat-number" style={{ color: '#ff5722' }}>
                  {summary.total.accepted || 0}
                </div>
                <div className="stat-label">📦 Принят (не собран)</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('packed')}
                style={statBoxStyle(selectedStage === 'packed', '#ff9800')}
                title="Показать собранные заказы, ожидающие курьера"
              >
                <div className="stat-number" style={{ color: '#ff9800' }}>
                  {summary.total.packed || 0}
                </div>
                <div className="stat-label">📤 Собран (ждёт курьера)</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('shipping')}
                style={statBoxStyle(selectedStage === 'shipping', '#2196f3')}
                title="Показать заказы в пути"
              >
                <div className="stat-number" style={{ color: '#2196f3' }}>
                  {summary.total.shipping || 0}
                </div>
                <div className="stat-label">🚚 Передан курьеру / в пути</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('completed')}
                style={statBoxStyle(selectedStage === 'completed', '#4caf50')}
                title="Показать доставленные заказы"
              >
                <div className="stat-number" style={{ color: '#4caf50' }}>
                  {summary.total.completed || 0}
                </div>
                <div className="stat-label">✅ Доставлено (14 дн.)</div>
              </div>
              <div
                className="stat-box"
                onClick={() => toggleStageFilter('cancelled')}
                style={statBoxStyle(selectedStage === 'cancelled', '#757575')}
                title="Показать отменённые заказы и возвраты"
              >
                <div className="stat-number" style={{ color: '#757575' }}>
                  {summary.total.cancelled || 0}
                </div>
                <div className="stat-label">❌ Отменено/Возврат</div>
              </div>
            </div>

            {/* Статистика по магазинам */}
            {summary.byStore && Object.keys(summary.byStore).length > 0 && (
              <div className="card" style={{ marginBottom: '32px' }}>
                <h2 style={{ marginBottom: '16px' }}>По магазинам:</h2>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: '12px'
                }}>
                  {Object.entries(summary.byStore).map(([store, stats]) => (
                    <div
                      key={store}
                      style={{
                        padding: '12px',
                        background: 'rgba(255, 255, 255, 0.05)',
                        borderRadius: '4px',
                        fontSize: '14px'
                      }}
                    >
                      <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>{store}</div>
                      <div>Всего: {stats.total}</div>
                      <div>Сегодня: <span style={{ color: '#ff9800' }}>{stats.today}</span></div>
                      <div>Срочных: <span style={{ color: '#f44336' }}>{stats.urgent}</span></div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Фильтр по этапу заказа */}
            <div style={{
              marginBottom: '12px',
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap'
            }}>
              <button
                onClick={() => setSelectedStage(null)}
                className="btn-primary"
                style={{ background: !selectedStage ? '#007bff' : '#ccc', color: '#fff' }}
              >
                Все этапы ({orders.length})
              </button>
              <button
                onClick={() => setSelectedStage('new')}
                className="btn-primary"
                style={{ background: selectedStage === 'new' ? '#9c27b0' : '#ccc', color: '#fff' }}
              >
                🆕 Новые ({orders.filter(o => o.stage === 'new').length})
              </button>
              <button
                onClick={() => setSelectedStage('accepted')}
                className="btn-primary"
                style={{ background: selectedStage === 'accepted' ? '#ff5722' : '#ccc', color: '#fff' }}
              >
                📦 Принят ({orders.filter(o => o.stage === 'accepted').length})
              </button>
              <button
                onClick={() => setSelectedStage('packed')}
                className="btn-primary"
                style={{ background: selectedStage === 'packed' ? '#ff9800' : '#ccc', color: '#fff' }}
              >
                📤 Собран ({orders.filter(o => o.stage === 'packed').length})
              </button>
              <button
                onClick={() => setSelectedStage('shipping')}
                className="btn-primary"
                style={{ background: selectedStage === 'shipping' ? '#2196f3' : '#ccc', color: '#fff' }}
              >
                🚚 В пути ({orders.filter(o => o.stage === 'shipping').length})
              </button>
              <button
                onClick={() => setSelectedStage('completed')}
                className="btn-primary"
                style={{ background: selectedStage === 'completed' ? '#4caf50' : '#ccc', color: '#fff' }}
              >
                ✅ Доставлено ({orders.filter(o => o.stage === 'completed').length})
              </button>
              <button
                onClick={() => setSelectedStage('cancelled')}
                className="btn-primary"
                style={{ background: selectedStage === 'cancelled' ? '#757575' : '#ccc', color: '#fff' }}
              >
                ❌ Отменено ({orders.filter(o => o.stage === 'cancelled').length})
              </button>
            </div>

            {/* Фильтр по срочности */}
            <div style={{
              marginBottom: '24px',
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap'
            }}>
              <button
                onClick={() => setSelectedUrgency(null)}
                className={!selectedUrgency ? 'btn-primary' : 'btn-primary'}
                style={{
                  background: !selectedUrgency ? '#007bff' : '#ccc',
                  color: '#fff'
                }}
              >
                Все ({orders.length})
              </button>
              <button
                onClick={() => setSelectedUrgency('today')}
                className="btn-primary"
                style={{
                  background: selectedUrgency === 'today' ? '#ff9800' : '#ccc',
                  color: '#fff'
                }}
              >
                Сегодня ({orders.filter(o => o.urgency === 'today').length})
              </button>
              <button
                onClick={() => setSelectedUrgency('overdue')}
                className="btn-primary"
                style={{
                  background: selectedUrgency === 'overdue' ? '#f44336' : '#ccc',
                  color: '#fff'
                }}
              >
                Просрочено ({orders.filter(o => o.urgency === 'overdue').length})
              </button>
            </div>

            {/* Сводка товаров по текущему фильтру - удобно, когда выбран этап
                "Собран (ждёт курьера)": видно, что и сколько реально должно лежать в коробках */}
            <div ref={ordersListRef}>
            {productsSummary.length > 0 && (
              <div className="card">
                <h2 style={{ marginBottom: '12px' }}>
                  📦 Товары в выбранных заказах
                  {selectedStage ? ` — ${getStageLabel(selectedStage).replace(/^[^\s]+\s/, '')}` : ''}
                  {' '}({filteredOrders.length} {filteredOrders.length === 1 ? 'заказ' : 'заказов'})
                </h2>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
                        <th style={{ padding: '6px 8px' }}>Товар</th>
                        <th style={{ padding: '6px 8px' }}>Артикул</th>
                        <th style={{ padding: '6px 8px' }}>Кол-во, шт.</th>
                        <th style={{ padding: '6px 8px' }}>В заказах</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productsSummary.map((p, idx) => (
                        <tr key={p.sku || p.name || idx} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '6px 8px' }}>{p.name || '—'}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>{p.sku || '—'}</td>
                          <td style={{ padding: '6px 8px', fontWeight: 'bold' }}>{p.quantity}</td>
                          <td style={{ padding: '6px 8px', color: 'var(--text-dim)' }}>{p.ordersCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            </div>

            {/* Список заказов */}
            <div>
              <h2 style={{ marginBottom: '16px' }}>Заказы ({filteredOrders.length})</h2>
              {filteredOrders.length === 0 ? (
                <div className="card">
                  <p>Заказов не найдено</p>
                </div>
              ) : (
                filteredOrders.map((order) => (
                  <div key={order.id} className="card">
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'start',
                      marginBottom: '12px'
                    }}>
                      <div>
                        <h3>Заказ #{order.order_code || order.kaspi_order_id}</h3>
                        <p style={{ color: 'var(--text-dim)', marginTop: '4px' }}>
                          Магазин: {order.store_name}
                        </p>
                      </div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <span
                          className="badge"
                          style={{
                            background: getStageColor(order.stage),
                            color: 'white'
                          }}
                        >
                          {getStageLabel(order.stage)}
                        </span>
                        {['new', 'accepted', 'packed'].includes(order.stage) && order.urgency && (
                          <span
                            className="badge"
                            style={{
                              background: getUrgencyColor(order.urgency),
                              color: 'white'
                            }}
                          >
                            {getUrgencyLabel(order.urgency)}
                          </span>
                        )}
                      </div>
                    </div>

                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                      gap: '12px',
                      fontSize: '14px'
                    }}>
                      <div>
                        <span style={{ color: 'var(--text-dim)' }}>Статус Kaspi:</span>
                        <div>{order.status} {order.state ? `/ ${order.state}` : ''}</div>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-dim)' }}>Дата доставки:</span>
                        <div>
                          {order.delivery_date
                            ? new Date(order.delivery_date).toLocaleDateString('ru-RU')
                            : 'Не указана'}
                        </div>
                      </div>
                      <div>
                        <span style={{ color: 'var(--text-dim)' }}>Товаров (шт.):</span>
                        <div>
                          {(order.items || []).reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)}
                        </div>
                      </div>
                    </div>

                    {order.items && order.items.length > 0 && (
                      <div style={{
                        marginTop: '12px',
                        paddingTop: '12px',
                        borderTop: '1px solid var(--border)',
                        fontSize: '14px'
                      }}>
                        <span style={{ color: 'var(--text-dim)' }}>Товары:</span>
                        <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                          {order.items.map((item, idx) => (
                            <li key={idx}>
                              {item.name}{item.quantity > 1 ? ` × ${item.quantity}` : ''}
                              {item.sku ? ` (арт. ${item.sku})` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {loading && (
          <div className="loading">
            <div className="spinner"></div>
            <p style={{ marginTop: '16px', color: 'var(--text-dim)' }}>Загрузка заказов...</p>
          </div>
        )}
      </div>
    </main>
  );
}

// Обёртка с авторизацией: пока не подтверждена активная сессия Supabase, дашборд
// (со всеми заказами и товарами) не рендерится и не запрашивает данные с бэкенда.
// Аккаунт создаётся вручную в Supabase Dashboard - см. components/Login.js.
export default function Home() {
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  if (authLoading) {
    return (
      <main style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-dim)' }}>Загрузка...</p>
      </main>
    );
  }

  if (!session) {
    return <Login />;
  }

  return <Dashboard onLogout={() => supabase.auth.signOut()} />;
}
