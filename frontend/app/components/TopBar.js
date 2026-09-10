'use client';

import ThemePicker from './ThemePicker';

export default function TopBar({
  mode,
  onModeChange,
  stores,
  storeId,
  onStoreChange,
  syncing,
  lastSyncAt,
  onSync,
  onLogout,
  isAdmin
}) {
  return (
    <header className="topbar">
      <div className="brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="mark-img" src="/brand/mark.webp" alt="" />
        ARTROOM<span>/</span>OPS
      </div>

      {stores.length > 0 && (
        <div className="chip-row">
          <button
            className="chip"
            data-active={!storeId}
            onClick={() => onStoreChange(null)}
          >
            Все магазины
          </button>
          {stores.map((store) => (
            <button
              key={store.id}
              className="chip"
              data-active={storeId === store.id}
              onClick={() => onStoreChange(store.id)}
            >
              {store.name}
            </button>
          ))}
        </div>
      )}

      <div className="topbar-spacer" />

      <div className="segmented">
        <button data-active={mode === 'shipping'} onClick={() => onModeChange('shipping')}>
          Отгрузка
        </button>
        <button data-active={mode === 'crm'} onClick={() => onModeChange('crm')}>
          CRM
        </button>
        <button data-active={mode === 'archive'} onClick={() => onModeChange('archive')}>
          Архив
        </button>
      </div>

      <button className="btn" onClick={onSync} disabled={syncing} title="Забрать свежие данные из Kaspi">
        {syncing ? <span className="spinner" /> : <span aria-hidden="true">⟳</span>}
        {syncing ? 'Синхронизация' : 'Обновить'}
      </button>

      {lastSyncAt && (
        <span className="eyebrow" title="Время последней синхронизации">
          {lastSyncAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}

      <ThemePicker />

      {/* Склад - соседнее приложение в разделе /sklad того же домена. Обычная ссылка,
          а не переключатель режима: это другой деплой, но для человека тот же сайт,
          и вход общий - повторно логиниться не придётся. */}
      <a className="btn btn-quiet" href="/sklad/dashboard" title="Этикетки, приёмка, отгрузка">
        Склад
      </a>

      {isAdmin && (
        <a className="btn btn-quiet btn-icon" href="/sklad/admin/users" title="Сотрудники и доступы">
          <span aria-hidden="true">⚙</span>
        </a>
      )}

      <button className="btn btn-quiet btn-icon" onClick={onLogout} title="Выйти">
        <span aria-hidden="true">⏻</span>
      </button>
    </header>
  );
}
