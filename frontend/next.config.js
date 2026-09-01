/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://kaspi-app-orderds-api.vercel.app',
    // Supabase URL и anon-ключ безопасно иметь как дефолт в коде - anon-ключ специально
    // предназначен светиться в браузере, реальный доступ к данным проверяется на бэкенде
    // (server/middleware/requireAuth.js). Это позволяет не настраивать Environment Variables
    // в Vercel вручную - см. также .env.example, если нужно указать другой проект Supabase.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://aiatnvqgghdkzrbuqcmw.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFpYXRudnFnZ2hka3pyYnVxY213Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNTAwMTEsImV4cCI6MjEwMzgyNjAxMX0.UEE2eYd2WX4pLwFe2r0qSiIuhFr47_OO3Gw-HG-PJ6k'
  }
};

module.exports = nextConfig;
