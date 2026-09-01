'use client';

import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// Экран входа. Аккаунт (email + пароль) создаётся вручную в Supabase Dashboard
// (Authentication -> Users -> Add user) - публичной регистрации здесь нет специально,
// чтобы попасть в приложение мог только тот, кому вы сами выдали доступ.
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError('Неверный логин или пароль');
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f5f5f5'
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff',
          padding: '32px',
          borderRadius: '8px',
          boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
          width: '100%',
          maxWidth: '340px'
        }}
      >
        <h1 style={{ fontSize: '20px', marginBottom: '20px', textAlign: 'center' }}>
          📦 Kaspi Orders Dashboard
        </h1>

        <label style={{ display: 'block', marginBottom: '12px' }}>
          <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: '#555' }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: '16px' }}>
          <span style={{ display: 'block', marginBottom: '4px', fontSize: '13px', color: '#555' }}>Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{ width: '100%', padding: '8px', border: '1px solid #ccc', borderRadius: '4px' }}
          />
        </label>

        {error && (
          <div style={{ color: '#c62828', fontSize: '13px', marginBottom: '12px' }}>{error}</div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px',
            background: '#1a73e8',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            fontWeight: 'bold',
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? 'Входим...' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
