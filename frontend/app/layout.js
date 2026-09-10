import { Golos_Text, IBM_Plex_Mono, Unbounded } from 'next/font/google';
import './globals.css';
import { THEME_BOOTSTRAP } from './lib/theme';

// Golos Text - гротеск, спроектированный под кириллицу, поэтому русский текст в интерфейсе
// выглядит ровно, а не как латиница с дорисованными буквами.
const golos = Golos_Text({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap'
});

// Моноширинный - для всего, что читают как данные: номера заказов, артикулы, количества,
// суммы. Цифры одной ширины не "прыгают" при обновлении и колонки в таблицах не пляшут.
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap'
});

// Акцидентный - только для логотипа, одним начертанием, чтобы не тянуть лишний вес.
const unbounded = Unbounded({
  subsets: ['cyrillic', 'latin'],
  weight: ['600'],
  variable: '--font-display',
  display: 'swap'
});

export const metadata = {
  title: 'ARTROOM/OPS — заказы и склад',
  description: 'Отгрузки Kaspi, накладные, склад и производство'
};

// Цвет строки браузера на телефоне - под каждую тему свой, иначе в светлой теме
// сверху остаётся чёрная полоса от тёмной
export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F2EDE3' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0A08' }
  ]
};

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning - ровно из-за скрипта ниже: он дописывает <html>
    // атрибут data-theme до гидратации, и React считает это расхождением с сервером.
    // Подавление стоит на <html> и дальше не наследуется, разметку страниц оно не глушит.
    <html
      lang="ru"
      suppressHydrationWarning
      className={`${golos.variable} ${plexMono.variable} ${unbounded.variable}`}
    >
      <head>
        {/* До первой отрисовки: иначе выбравший светлую тему при системной тёмной
            увидит вспышку тёмного фона */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
