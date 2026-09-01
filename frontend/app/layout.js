import './globals.css';

export const metadata = {
  title: 'Kaspi Orders Dashboard',
  description: 'Monitor Kaspi marketplace orders in real-time'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
