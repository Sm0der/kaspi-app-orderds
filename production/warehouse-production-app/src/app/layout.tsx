import type { Metadata, Viewport } from 'next';
import { Golos_Text, IBM_Plex_Mono, Unbounded } from 'next/font/google';
import './globals.css';
import { THEME_BOOTSTRAP } from '@/lib/theme';

// Шрифты те же, что у заказов. Geist из заготовки create-next-app кириллицу не
// покрывает - русский текст в нём собирался из подставленного системного шрифта,
// и склад визуально отваливался от остальной системы.
const golos = Golos_Text({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-golos',
  display: 'swap',
});

// Для всего, что читают как данные: артикулы, количества, штрихкоды
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const unbounded = Unbounded({
  subsets: ['cyrillic', 'latin'],
  weight: ['600'],
  variable: '--font-unbounded',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ARTROOM/OPS — склад и производство',
  description: 'Этикетки, приёмка, отгрузка и цеха',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F2EDE3' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0A08' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
        {/* До первой отрисовки, иначе видна вспышка чужой темы */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
