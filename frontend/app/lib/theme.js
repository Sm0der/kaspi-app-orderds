'use client';

// Выбор темы. Три состояния, а не два: «как в системе» - это отдельный ответ, а не
// синоним светлой, и человек, у которого телефон сам темнеет вечером, ждёт того же
// от рабочей панели.
//
// Ключ тот же, что у склада, и домен общий - выбрав тему в заказах, человек находит
// её же на складе. Поэтому значение хранится в localStorage, а не в состоянии React.
export const THEME_KEY = 'artroom:theme';

export const THEMES = [
  { value: 'system', label: 'Как в системе' },
  { value: 'light', label: 'Светлая' },
  { value: 'dark', label: 'Тёмная' }
];

export function readTheme() {
  if (typeof window === 'undefined') return 'system';
  const saved = window.localStorage.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export function applyTheme(theme) {
  const root = document.documentElement;
  // Атрибут снимаем, а не выставляем в 'system': его отсутствие и означает
  // «решает color-scheme: light dark», то есть системная настройка
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;

  window.localStorage.setItem(THEME_KEY, theme);
}

/**
 * Скрипт, который должен отработать до первой отрисовки, иначе выбравший светлую тему
 * при системной тёмной увидит вспышку тёмного фона. Поэтому он не в компоненте, а
 * строкой в <head> - до гидратации и даже до загрузки бандла.
 */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}})()`;
