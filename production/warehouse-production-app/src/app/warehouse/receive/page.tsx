'use client';

import { useEffect, useState, useRef } from 'react';
import { apiUrl } from '@/lib/session';
import { useRouter } from 'next/navigation';
import BarcodeScanner from '@/components/BarcodeScanner';

interface Movement {
  movementId: string;
  barcode: string;
  item: {
    id: string;
    sku: string;
    name: string;
  };
  timestamp: Date;
}

export default function ReceivePage() {
  const router = useRouter();
  const [barcodeInput, setBarcodeInput] = useState('');
  const [movements, setMovements] = useState<Movement[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
    }
  }, [router]);

  useEffect(() => {
    if (!showCamera) {
      inputRef.current?.focus();
    }
  }, [showCamera]);

  const submitBarcode = async (value: string) => {
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(apiUrl('/api/warehouse/receive/scan-barcode'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ barcodeValue: value }),
      });

      const data = await response.json();

      if (!data.success) {
        setError(data.error || 'Не удалось отсканировать штрихкод');
        return;
      }

      setSuccess(`Принято: ${data.data.item.name}`);
      setMovements((prev) => [
        {
          movementId: data.data.movementId,
          barcode: data.data.barcode,
          item: data.data.item,
          timestamp: new Date(),
        },
        ...prev,
      ]);
      setBarcodeInput('');
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (err) {
      setError('Произошла ошибка. Попробуйте ещё раз.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleScan = (e: React.FormEvent) => {
    e.preventDefault();
    if (barcodeInput) submitBarcode(barcodeInput);
  };

  const handleCameraScan = (value: string) => {
    submitBarcode(value);
  };

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-ink">Приём товара</h1>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 rounded border border-line text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            Назад
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-surface rounded-lg shadow-card p-6 mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold">Сканирование штрихкода</h2>
            <button
              type="button"
              onClick={() => setShowCamera((v) => !v)}
              className="px-4 py-2 border border-line text-muted text-sm font-medium rounded-lg flex items-center gap-2 transition-colors hover:bg-raised hover:text-ink"
            >
              📷 {showCamera ? 'Скрыть камеру' : 'Сканировать камерой'}
            </button>
          </div>
          <p className="text-muted mb-4">
            Используйте камеру телефона/планшета или подключённый USB/Bluetooth-сканер
            (сработает прямо в поле ввода ниже).
          </p>

          {error && (
            <div className="mb-4 p-4 bg-danger/10 border border-danger text-danger rounded">
              {error}
            </div>
          )}

          {success && (
            <div className="mb-4 p-4 bg-ok/10 border border-ok text-ok rounded">
              ✓ {success}
            </div>
          )}

          {showCamera && (
            <div className="mb-4">
              <BarcodeScanner onScan={handleCameraScan} onClose={() => setShowCamera(false)} />
            </div>
          )}

          <form onSubmit={handleScan} className="space-y-4">
            <div>
              <label htmlFor="barcode" className="block text-sm font-medium text-muted mb-2">
                Штрихкод
              </label>
              <input
                ref={inputRef}
                id="barcode"
                type="text"
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                className="w-full px-4 py-3 border-2 border-line rounded-lg focus:outline-none focus:border-brass focus:ring-2 focus:ring-brass-wash"
                placeholder="Отсканируйте штрихкод..."
                disabled={loading}
                autoComplete="off"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !barcodeInput}
              className="w-full bg-brass hover:bg-brass-bright text-on-brass font-bold py-3 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Обработка...' : 'Подтвердить'}
            </button>
          </form>
        </div>

        <div className="bg-surface rounded-lg shadow-card p-6">
          <h2 className="text-xl font-bold mb-4">Недавние приёмки ({movements.length})</h2>

          {movements.length === 0 ? (
            <p className="text-muted">Пока ничего не принято.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-canvas">
                  <tr>
                    <th className="px-4 py-2 text-left">Время</th>
                    <th className="px-4 py-2 text-left">Штрихкод</th>
                    <th className="px-4 py-2 text-left">Артикул</th>
                    <th className="px-4 py-2 text-left">Наименование</th>
                  </tr>
                </thead>
                <tbody>
                  {movements.map((movement) => (
                    <tr key={movement.movementId} className="border-b hover:bg-raised">
                      <td className="px-4 py-2 text-sm">
                        {movement.timestamp.toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2 text-sm font-mono">{movement.barcode}</td>
                      <td className="px-4 py-2 text-sm">{movement.item.sku}</td>
                      <td className="px-4 py-2 text-sm">{movement.item.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
