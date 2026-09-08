'use client';

import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// Экран входа. Аккаунт заводится вручную в панели Supabase (Authentication → Users),
// публичной регистрации здесь нет специально: внутрь попадает только тот, кому выдали доступ.
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) setError('Неверная почта или пароль');

    setBusy(false);
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
