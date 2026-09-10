'use client';

// Копия выбора темы из дашборда заказов (frontend/app/lib/theme.js). Ключ обязан
// совпадать: домен один, localStorage общий, поэтому выбранная в заказах тема
// применяется и здесь без второго переключения.
export const THEME_KEY = 'artroom:theme';

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Как в системе' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' },
];

export function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // Отсутствие атрибута и означает «решает система» - см. color-scheme в globals.css
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;

  window.localStorage.setItem(THEME_KEY, theme);
}

/** Отрабатывает до первой отрисовки, иначе видна вспышка чужой темы */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
