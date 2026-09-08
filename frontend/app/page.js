'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from './lib/api';
import { supabase } from './lib/supabaseClient';
import Login from './components/Login';
import TopBar from './components/TopBar';
import ShippingView from './components/ShippingView';
import CrmBoard from './components/CrmBoard';
import ArchiveView from './components/ArchiveView';
import AccessPanel from './components/AccessPanel';

const EMPTY_FILTERS = { product: '', dateFrom: '', dateTo: '', createdPreset: 'all' };

const toISO = (date) => date.toISOString().slice(0, 10);

// Пресеты «новых заказов» считаются по дате создания заказа в Kaspi (order_date),
// а не по дате доставки — это разные вещи, и фильтры для них тоже разные.
function createdRange(preset) {
  const today = new Date();

  if (preset === 'today') return [toISO(today), toISO(today)];
  if (preset === 'yesterday') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return [toISO(yesterday), toISO(yesterday)];
  }
  if (preset === 'month') {
    return [toISO(new Date(today.getFullYear(), today.getMonth(), 1)), toISO(today)];
  }
  return [null, null];
}

export default function Home() {
  const [session, setSession] = useState(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingAuth(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  if (checkingAuth) {
    return (
      <main className="auth">
        <div className="spinner" />
      </main>
    );
  }

  if (!session) return <Login />;

  return <Workspace onLogout={() => supabase.auth.signOut()} />;
}

function Workspace({ onLogout }) {
  const [mode, setMode] = useState('shipping');
  const [stores, setStores] = useState([]);
  const [storeId, setStoreId] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);

  const [orders, setOrders] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  // Роль решает, показывать ли настройки: правила упаковки, статусы воронки, доступы
  const [me, setMe] = useState(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const isAdmin = me?.role !== 'manager';

  // Режим запоминаем: человек, работающий в CRM, не должен каждое утро переключаться вручную
  useEffect(() => {
    const saved = window.localStorage.getItem('kaspi:mode');
    if (['shipping', 'crm', 'archive'].includes(saved)) setMode(saved);
  }, []);

  const changeMode = (next) => {
    setMode(next);
    window.localStorage.setItem('kaspi:mode', next);
  };

  useEffect(() => {
    api.get('/api/users/me')
      .then(({ data }) => setMe(data))
      .catch(() => setMe({ role: 'admin' }));

    api.get('/api/stores')
      .then(({ data }) => setStores(data.data || []))
      .catch(() => setStores([]));
  }, []);

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = {};
      if (storeId) params.storeId = storeId;
      if (filters.product) params.product = filters.product;
      if (filters.dateFrom) params.dateFrom = filters.dateFrom;
      if (filters.dateTo) params.dateTo = filters.dateTo;

      const [createdFrom, createdTo] = createdRange(filters.createdPreset);
      if (createdFrom) params.orderDateFrom = createdFrom;
      if (createdTo) params.orderDateTo = createdTo;

      const { data } = await api.get('/api/orders/summary', { params });
      setSummary(data);
      setOrders(data.orders || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить заказы'));
    } finally {
      setLoading(false);
    }
  }, [storeId, filters]);

  useEffect(() => {
    fetchOrders();
    const timer = setInterval(fetchOrders, 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [fetchOrders]);

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      await api.post('/api/orders/sync');
      setLastSyncAt(new Date());
      await fetchOrders();
    } catch (err) {
      setError(errorText(err, 'Синхронизация не удалась'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <main>
      <TopBar
        mode={mode}
        onModeChange={changeMode}
        stores={stores}
        storeId={storeId}
        onStoreChange={setStoreId}
        syncing={syncing}
        lastSyncAt={lastSyncAt}
        onSync={runSync}
        onLogout={onLogout}
        isAdmin={isAdmin}
        onOpenAccess={() => setAccessOpen((open) => !open)}
      />

      <div className="shell">
        {error && <div className="alert alert-error">{error}</div>}

        {accessOpen && isAdmin && (
          <AccessPanel myEmail={me?.email} onClose={() => setAccessOpen(false)} />
        )}

        {mode === 'archive' ? (
          <ArchiveView />
        ) : mode === 'shipping' ? (
          <ShippingView
            orders={orders}
            summary={summary}
            loading={loading}
            filters={filters}
            setFilters={setFilters}
            storeId={storeId}
            onRefetch={fetchOrders}
            isAdmin={isAdmin}
          />
        ) : (
          <CrmBoard orders={orders} loading={loading} onOrdersChange={setOrders} isAdmin={isAdmin} />
        )}
      </div>
    </main>
  );
}
