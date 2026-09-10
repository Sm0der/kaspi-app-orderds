'use client';

import { useEffect, useState } from 'react';
import { THEMES, applyTheme, readTheme } from '../lib/theme';

// Выпадающий список, а не привычный тумблер «солнце/луна»: состояний три, и тумблер
// не умеет показать «как в системе» - выбравший его человек не понимает, в каком
// положении переключатель должен стоять.
export default function ThemePicker() {
  const [theme, setTheme] = useState('system');

  // Читаем уже после монтирования: на сервере localStorage нет, и отрисуй мы
  // сохранённое значение сразу, разметка не сошлась бы с серверной
  useEffect(() => setTheme(readTheme()), []);

  const change = (value) => {
    setTheme(value);
    applyTheme(value);
  };

  return (
    <label className="theme-picker" title="Тема оформления">
      <span className="eyebrow">Тема</span>
      <select className="select select-sm" value={theme} onChange={(e) => change(e.target.value)}>
        {THEMES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
