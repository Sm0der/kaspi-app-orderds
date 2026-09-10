'use client';

import { useEffect, useState } from 'react';
import { THEMES, Theme, applyTheme, readTheme } from '@/lib/theme';

// Список, а не тумблер «солнце/луна»: состояний три, и «как в системе» тумблером
// не показать - человек не поймёт, в каком положении он должен стоять.
export default function ThemePicker() {
  const [theme, setTheme] = useState<Theme>('system');

  // После монтирования: на сервере localStorage нет, иначе разметка не сошлась бы
  useEffect(() => setTheme(readTheme()), []);

  return (
    <select
      aria-label="Тема оформления"
      value={theme}
      onChange={(e) => {
        const next = e.target.value as Theme;
        setTheme(next);
        applyTheme(next);
      }}
      className="rounded border border-line bg-surface px-2 py-1 text-xs text-muted transition-colors hover:text-ink"
    >
      {THEMES.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
