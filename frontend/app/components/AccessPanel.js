'use client';

import { useEffect, useState } from 'react';
import { api, errorText } from '../lib/api';

const ROLE_LABEL = { admin: 'Администратор', manager: 'Менеджер' };

// Панель доступов. Аккаунт (почта и пароль) заводится в панели Supabase, здесь
// назначаются права: администратор владеет настройками, менеджер работает с заказами.
export default function AccessPanel({ myEmail, onClose }) {
  const [users, setUsers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('manager');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { data } = await api.get('/api/users');
      setUsers(data.data || []);
    } catch (err) {
      setError(errorText(err, 'Не удалось загрузить список'));
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/users', { email, role, note });
      setEmail('');
      setNote('');
      await load();
    } catch (err) {
      setError(errorText(err, 'Не удалось сохранить'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (user) => {
    if (!window.confirm(`Убрать доступ для ${user.email}?`)) return;
    try {
      await api.delete(`/api/users/${user.id}`);
      await load();
    } catch (err) {
      setError(errorText(err, 'Не удалось удалить'));
    }
  };

  return (
    <section className="panel rise" style={{ marginBottom: 22 }}>
      <div className="panel-head">
        <h2>Доступ сотрудников</h2>
        <div className="topbar-spacer" />
        <button className="btn btn-quiet btn-sm" onClick={onClose}>Закрыть</button>
      </div>

      <div className="panel-body">
        <p className="panel-note" style={{ marginBottom: 18 }}>
          Менеджер видит заказы, формирует накладные и двигает карточки на доске.
          Настройки — правила упаковки, статусы воронки и этот список — остаются за
          администратором. Сам аккаунт заводится в Supabase: Authentication → Users → Add user,
          а здесь указывается его почта.
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={save} style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 20 }}>
          <div className="field" style={{ flex: '1 1 220px' }}>
            <label>Почта сотрудника</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="manager@example.com"
              required
            />
          </div>
          <div className="field" style={{ flex: '0 1 170px' }}>
            <label>Роль</label>
            <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="manager">Менеджер</option>
              <option value="admin">Администратор</option>
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label>Пометка</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: склад Тараз" />
          </div>
          <button className="btn btn-primary" disabled={busy || !email.trim()}>
            {busy && <span className="spinner" />} Сохранить
          </button>
        </form>

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Почта</th>
                <th>Роль</th>
                <th>Пометка</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td colSpan={4} className="t-faint">Пока никого не добавляли — все входящие считаются администраторами</td></tr>
              ) : users.map((user) => (
                <tr key={user.id}>
                  <td className="mono">{user.email}</td>
                  <td>
                    <span className="badge" style={{
                      background: user.role === 'admin' ? 'var(--brass-wash)' : 'var(--ink-700)',
                      borderColor: user.role === 'admin' ? 'var(--brass-line)' : 'var(--line)',
                      color: user.role === 'admin' ? 'var(--brass-bright)' : 'var(--text-dim)'
                    }}>
                      {ROLE_LABEL[user.role]}
                    </span>
                  </td>
                  <td className="t-dim">{user.note || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {user.email.toLowerCase() !== (myEmail || '').toLowerCase() && (
                      <button className="btn btn-quiet btn-sm btn-danger" onClick={() => remove(user)}>Убрать</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
