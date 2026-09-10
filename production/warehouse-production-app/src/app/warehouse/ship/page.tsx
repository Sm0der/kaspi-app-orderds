'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { apiUrl } from '@/lib/session';
import BarcodeScanner from '@/components/BarcodeScanner';

import type { OrderForPicking, PickingLine } from '@/types';

type Order = OrderForPicking;

export default function ShipPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [scanHistory, setScanHistory] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [showCamera, setShowCamera] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    fetchOrders();
  }, [router]);

  useEffect(() => {
    if (!showCamera) {
      inputRef.current?.focus();
    }
  }, [showCamera, selectedOrder]);

  const fetchOrders = async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(apiUrl('/api/warehouse/ship/orders'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (data.success) {
        setOrders(data.data);
      }
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setInitialLoading(false);
    }
  };

  const startOrder = async (orderId: number) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(apiUrl(`/api/warehouse/ship/orders/${orderId}/start`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (data.success) {
        const order = data.data;
        setSelectedOrder(order);
        setScanHistory([]);
        setError('');
      } else {
        setError(data.error || 'Не удалось начать сборку заказа');
        fetchOrders();
      }
    } catch (err) {
      setError('Произошла ошибка');
      console.error(err);
    }
  };

  const submitBarcode = async (value: string) => {
    setError('');
    setSuccess('');
    setLoading(true);

    if (!selectedOrder) {
      setError('Заказ не выбран');
      setLoading(false);
      return;
    }

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `/api/warehouse/ship/orders/${selectedOrder.id}/scan-barcode`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ barcodeValue: value }),
        }
      );

      const data = await response.json();

      if (!data.success) {
        setError(data.error || 'Не удалось отсканировать штрихкод');
        return;
      }

      setSuccess(`${data.data.item.name} (${data.data.picked}/${data.data.required})`);

      setScanHistory((prev) => [
        {
          barcode: value,
          item: data.data.item,
          picked: data.data.picked,
          required: data.data.required,
          timestamp: new Date(),
        },
        ...prev,
      ]);

      // Refresh the selected order's picked quantities so the checklist UI updates
      setSelectedOrder((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          lines: prev.lines.map((line: PickingLine) =>
            line.warehouseItemId === data.data.item.id
              ? { ...line, quantityPicked: data.data.picked }
              : line
          ),
        };
      });

      if (data.data.orderComplete) {
        setSuccess(data.data.message);
        setShowCamera(false);
        setTimeout(() => {
          setSelectedOrder(null);
          setScanHistory([]);
          fetchOrders();
        }, 2000);
      }

      setBarcodeInput('');
      setTimeout(() => inputRef.current?.focus(), 100);
    } catch (err) {
      setError('Произошла ошибка');
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

  const completeOrder = async () => {
    if (!selectedOrder) return;

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `/api/warehouse/ship/orders/${selectedOrder.id}/complete`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      const data = await response.json();

      if (data.success) {
        setSuccess('Заказ успешно отгружен!');
        setSelectedOrder(null);
        setScanHistory([]);
        fetchOrders();
      } else {
        setError(data.error || 'Не удалось завершить отгрузку');
      }
    } catch (err) {
      setError('Произошла ошибка');
      console.error(err);
    }
  };

  if (initialLoading) {
    return <div className="flex items-center justify-center min-h-screen">Загрузка...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">Отгрузка заказов</h1>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            Назад
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Orders List */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-xl font-bold mb-4">Доступные заказы</h2>

              {orders.length === 0 ? (
                <p className="text-gray-600">Нет заказов для отгрузки.</p>
              ) : (
                <div className="space-y-2">
                  {orders.map((order) => (
                    <button
                      key={order.id}
                      onClick={() => startOrder(order.id)}
                      disabled={selectedOrder?.id === order.id}
                      className={`w-full text-left p-4 rounded border-2 transition ${
                        selectedOrder?.id === order.id
                          ? 'border-green-500 bg-green-50'
                          : 'border-gray-200 hover:border-blue-500'
                      } disabled:opacity-50`}
                    >
                      <div className="font-semibold text-sm">
                        {order.orderCode || order.kaspiOrderId}
                      </div>
                      <div className="text-xs text-gray-600">{order.storeName}</div>
                      <div className="text-xs font-mono text-gray-500 mt-1">
                        {order.lines.length} позиций
                        {order.unmapped.length > 0 && (
                          <span className="text-red-600"> · {order.unmapped.length} без изделия</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scanning Area */}
          <div className="lg:col-span-2">
            {selectedOrder ? (
              <>
                <div className="bg-white rounded-lg shadow-md p-6 mb-8">
                  <div className="flex items-center justify-between mb-4">
                    <h2 className="text-xl font-bold">
                      Заказ: {selectedOrder.orderCode || selectedOrder.kaspiOrderId}
                    </h2>
                    <button
                      type="button"
                      onClick={() => setShowCamera((v) => !v)}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg flex items-center gap-2"
                    >
                      📷 {showCamera ? 'Скрыть камеру' : 'Сканировать камерой'}
                    </button>
                  </div>

                  {error && (
                    <div className="mb-4 p-4 bg-red-100 border border-red-400 text-red-700 rounded">
                      {error}
                    </div>
                  )}

                  {success && (
                    <div className="mb-4 p-4 bg-green-100 border border-green-400 text-green-700 rounded">
                      ✓ {success}
                    </div>
                  )}

                  {showCamera && (
                    <div className="mb-4">
                      <BarcodeScanner
                        onScan={handleCameraScan}
                        onClose={() => setShowCamera(false)}
                      />
                    </div>
                  )}

                  <form onSubmit={handleScan} className="space-y-4 mb-6">
                    <div>
                      <label htmlFor="barcode" className="block text-sm font-medium text-gray-700 mb-2">
                        Сканировать товар (USB/BT-сканер работает прямо здесь)
                      </label>
                      <input
                        ref={inputRef}
                        id="barcode"
                        type="text"
                        value={barcodeInput}
                        onChange={(e) => setBarcodeInput(e.target.value)}
                        className="w-full px-4 py-3 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-blue-500"
                        placeholder="Отсканируйте штрихкод..."
                        disabled={loading}
                        autoComplete="off"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={loading || !barcodeInput}
                      className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg disabled:opacity-50"
                    >
                      {loading ? 'Обработка...' : 'Подтвердить'}
                    </button>
                  </form>

                  {/* Items to Pick */}
                  <div className="mb-6">
                    <h3 className="font-semibold mb-3">Позиции для сборки:</h3>
                    <div className="space-y-2">
                      {selectedOrder.lines.map((line: PickingLine) => (
                        <div
                          key={line.orderItemId}
                          className={`p-3 rounded border-2 ${
                            !line.warehouseItemId
                              ? 'border-red-400 bg-red-50'
                              : line.quantityPicked >= line.quantityRequired
                              ? 'border-green-500 bg-green-50'
                              : 'border-yellow-400 bg-yellow-50'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <div>
                              <div className="font-semibold">{line.warehouseItemName || line.name}</div>
                              <div className="text-xs text-gray-600">
                                {line.sku}
                                {!line.warehouseItemId && ' — артикул не привязан к изделию'}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold">
                                {line.quantityPicked}/{line.quantityRequired}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 h-2 bg-gray-200 rounded-full">
                            <div
                              className="h-full bg-green-500 rounded-full transition-all"
                              style={{
                                width: `${(line.quantityPicked / line.quantityRequired) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <button
                    onClick={completeOrder}
                    disabled={
                      selectedOrder.lines.some(
                        (line: PickingLine) => line.quantityPicked < line.quantityRequired
                      )
                    }
                    className="w-full bg-green-600 hover:bg-green-700 text-white font-bold py-3 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Завершить и отгрузить заказ
                  </button>
                </div>

                {/* Scan History */}
                {scanHistory.length > 0 && (
                  <div className="bg-white rounded-lg shadow-md p-6">
                    <h3 className="text-lg font-bold mb-3">История сканирования</h3>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {scanHistory.map((scan, idx) => (
                        <div key={idx} className="p-3 bg-gray-50 rounded border border-gray-200">
                          <div className="flex justify-between">
                            <div>
                              <div className="font-semibold text-sm">{scan.item.name}</div>
                              <div className="text-xs text-gray-600 font-mono">
                                {scan.barcode}
                              </div>
                            </div>
                            <div className="text-right text-sm">
                              {scan.picked}/{scan.required}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="bg-white rounded-lg shadow-md p-12 text-center">
                <p className="text-gray-600 text-lg">Выберите заказ, чтобы начать сборку</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
