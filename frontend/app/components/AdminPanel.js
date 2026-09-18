'use client';

import { useState } from 'react';
import { WAREHOUSE_PATH } from '../lib/session';
import AdminView from './AdminView';
import CostingView from './CostingView';

// Единая админ-панель. Раньше настройки были раскиданы по трём разным местам: свои
// «Настройки» и «Себестоимость» здесь, «Изделия склада», «Учётные записи» и (до сих
// пор никак) «Склады и цехи» в соседнем приложении склада (/sklad). Каталог и
// себестоимость - тот же React-процесс, рендерим их компоненты напрямую. Экраны
// склада - отдельный Next-деплой на /sklad, но общий домен и общий токен (см.
// [[unified-login-one-domain]]) позволяют встроить их прямо сюда через iframe с
// ?embed=1 - параметр гасит их собственную шапку с дублирующей навигацией «назад».
const TABS = [
  { key: 'catalog', label: 'Товары и магазины' },
  { key: 'costing', label: 'Себестоимость' },
  { key: 'items', label: 'Изделия склада' },
  { key: 'users', label: 'Учётные записи' },
  { key: 'places', label: 'Склады и цехи' },
];

export default function AdminPanel({ isAdmin }) {
  const [tab, setTab] = useState('catalog');

  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <button key={t.key} className="chip" data-active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'catalog' && <AdminView />}
      {tab === 'costing' && <CostingView isAdmin={isAdmin} />}
      {tab === 'items' && <Embedded path="/admin/items" />}
      {tab === 'users' && <Embedded path="/admin/users" />}
      {tab === 'places' && <Embedded path="/admin/warehouses" />}
    </div>
  );
}

function Embedded({ path }) {
  return (
    <iframe
      key={path}
      src={`${WAREHOUSE_PATH}${path}?embed=1`}
      title={path}
      style={{ width: '100%', height: 'calc(100vh - 220px)', minHeight: 480, border: 'none', borderRadius: 12, background: 'var(--surface)' }}
    />
  );
}
