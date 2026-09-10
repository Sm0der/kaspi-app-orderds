'use client';

import { useState } from 'react';
import { LOGIN_ENDPOINT, WAREHOUSE_PATH, saveSession } from '../lib/session';

// Экран входа - один на всю систему. Проверяет пароль приложение склада (раздел /sklad
// того же домена), учётки заводит администратор там же, публичной регистрации нет.
export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const response = await fetch(LOGIN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const body = await response.json();

      if (!body?.success) {
        setError(body?.error || 'Неверная почта или пароль');
        return;
      }

      saveSession(body.data.token, body.data.user);

      // Пароль, выданный администратором, меняют до начала работы - форма смены живёт
      // на складе, отдельной такой же на дашборде заводить незачем
      if (body.data.user.mustChangePassword) {
        window.location.href = `${WAREHOUSE_PATH}/profile/password`;
        return;
      }

      onSignedIn(body.data.user);
    } catch {
      setError('Не удалось связаться с сервером');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form className="panel auth-card rise" onSubmit={submit}>
        <div className="auth-mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="mark-img" src="/brand/mark.webp" alt="" />
          ARTROOM<span>/</span>OPS
        </div>
        <p className="eyebrow" style={{ marginBottom: 26 }}>Панель отгрузок Kaspi</p>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>Почта</label>
          <input
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="username"
          />
        </div>

        <div className="field" style={{ marginBottom: 22 }}>
          <label>Пароль</label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy && <span className="spinner" />}
          {busy ? 'Проверяем' : 'Войти'}
        </button>
      </form>
    </main>
  );
}
