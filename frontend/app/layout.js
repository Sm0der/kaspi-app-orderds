import { Golos_Text, IBM_Plex_Mono, Unbounded } from 'next/font/google';
import './globals.css';

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
  title: 'Kaspi Orders — панель отгрузок',
  description: 'Мониторинг и сборка заказов Kaspi'
};

export const viewport = {
  themeColor: '#0B0A08'
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru" className={`${golos.variable} ${plexMono.variable} ${unbounded.variable}`}>
      <body>
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
