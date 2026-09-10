'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiUrl } from '@/lib/session';
import JsBarcode from 'jsbarcode';

// Печать этикеток на коробки. Смысл страницы: у изделия одно имя, а на Kaspi оно
// продаётся под несколькими («шкаф Monaco» и «шкаф Alico» - одно и то же), поэтому
// упаковщик не может опознать коробку. На этикетку выносим ОБА: крупно внутреннее
// имя и фото, мелко - все названия с Kaspi, чтобы совпало с любым заказом.

type Alias = { storeName: string; sku: string };

type Item = {
  id: string;
  code: string;
  name: string;
  imageUrl: string | null;
  boxesPerUnit: number;
  quantityOnHand: number;
  aliases: Alias[];
};

type Label = { barcodeValue: string; boxNumber: number; boxesTotal: number };

type Sheet = { item: Item; labels: Label[] };

export default function LabelsPage() {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [units, setUnits] = useState(1);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/login');
      return;
    }
    fetch(apiUrl('/api/warehouse/labels/items'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) setItems(data.data);
        else setError(data.error || 'Не удалось загрузить изделия');
      })
      .catch(() => setError('Не удалось загрузить изделия'));
  }, [router]);

  // Ищем и по внутреннему имени, и по названиям с Kaspi, и по артикулу: упаковщик
  // приходит с тем именем, которое написано в заказе, а не с нашим.
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items.slice(0, 40);
    return items
      .filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.code.toLowerCase().includes(needle) ||
          item.aliases.some((alias) => alias.sku.toLowerCase().includes(needle))
      )
      .slice(0, 40);
  }, [items, query]);

  const generate = async () => {
    if (!selected) return;
    setLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(apiUrl('/api/warehouse/labels'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ warehouseItemId: selected.id, units }),
      });
      const data = await response.json();
      if (!data.success) {
        setError(data.error || 'Не удалось создать этикетки');
        return;
      }
      setSheet({ item: data.data.item, labels: data.data.labels });
    } catch {
      setError('Произошла ошибка');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen">
      <nav className="sticky top-0 z-40 border-b border-line bg-[var(--topbar-bg)] backdrop-blur-md no-print">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <h1 className="text-2xl font-bold text-ink">Этикетки на коробки</h1>
          <button
            onClick={() => router.push('/dashboard')}
            className="px-4 py-2 rounded border border-line text-muted transition-colors hover:bg-raised hover:text-ink"
          >
            Назад
          </button>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 py-8 no-print">
        {error && (
          <div className="mb-4 p-4 bg-danger/10 border border-danger text-danger rounded">{error}</div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="bg-surface rounded-lg shadow-card p-6">
            <h2 className="text-xl font-bold mb-4">1. Выберите изделие</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Имя, артикул или название с Kaspi"
              className="w-full px-4 py-3 border-2 border-line rounded-lg mb-4 focus:outline-none focus:border-brass"
            />
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {found.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelected(item)}
                  className={`w-full text-left p-3 rounded border-2 transition flex gap-3 items-center ${
                    selected?.id === item.id ? 'border-ok bg-ok/10' : 'border-line hover:border-brass'
                  }`}
                >
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.imageUrl} alt="" className="w-12 h-12 object-cover rounded" />
                  ) : (
                    <span className="w-12 h-12 grid place-items-center bg-canvas rounded text-xl">📦</span>
                  )}
                  <span className="min-w-0">
                    <span className="block font-semibold text-sm truncate">{item.name}</span>
                    <span className="block text-xs text-faint font-mono">
                      {item.code}
                      {item.aliases.length > 1 && ` · ${item.aliases.length} назв. на Kaspi`}
                      {item.boxesPerUnit > 1 && ` · ${item.boxesPerUnit} места`}
                    </span>
                  </span>
                </button>
              ))}
              {found.length === 0 && <p className="text-faint text-sm">Ничего не найдено</p>}
            </div>
          </div>

          <div className="bg-surface rounded-lg shadow-card p-6">
            <h2 className="text-xl font-bold mb-4">2. Сколько штук</h2>
            {!selected ? (
              <p className="text-faint">Сначала выберите изделие слева.</p>
            ) : (
              <>
                <p className="font-semibold mb-1">{selected.name}</p>
                <p className="text-sm text-muted mb-4">
                  На Kaspi: {selected.aliases.map((a) => `${a.sku} (${a.storeName})`).join(', ') || '—'}
                </p>

                <input
                  type="number"
                  min={1}
                  max={200}
                  value={units}
                  onChange={(e) => setUnits(Math.max(1, Math.min(200, Number(e.target.value) || 1)))}
                  className="w-32 px-4 py-3 border-2 border-line rounded-lg mb-2"
                />
                <p className="text-sm text-muted mb-4">
                  {selected.boxesPerUnit > 1
                    ? `Будет ${units * selected.boxesPerUnit} этикеток: ${selected.boxesPerUnit} коробки на штуку`
                    : `Будет ${units} этикеток`}
                </p>

                <button
                  onClick={generate}
                  disabled={loading}
                  className="w-full bg-brass hover:bg-brass-bright text-on-brass font-bold py-3 rounded-lg disabled:opacity-50"
                >
                  {loading ? 'Создаём...' : 'Создать штрихкоды'}
                </button>
                <p className="text-xs text-faint mt-2">
                  Штрихкоды сразу становятся остатком на складе — печатайте столько, сколько коробок реально готово.
                </p>
              </>
            )}

            {sheet && (
              <div className="mt-6 pt-6 border-t">
                <p className="mb-3 text-sm">
                  Готово: {sheet.labels.length} этикеток. Проверьте на экране и печатайте.
                </p>
                <button
                  onClick={() => window.print()}
                  className="w-full bg-ok text-canvas transition-opacity hover:opacity-90 font-bold py-3 rounded-lg"
                >
                  Печать
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {sheet && <LabelSheet sheet={sheet} />}

      <style jsx global>{`
        .label-sheet {
          display: none;
        }
        @media print {
          .no-print {
            display: none !important;
          }
          .label-sheet {
            display: block;
          }
          @page {
            size: 75mm 120mm;
            margin: 0;
          }
          /* Этикетка печатается чёрным по белому в любой теме: у термопринтера нет
             ни цвета, ни серого, а фоновый градиент и сетка страницы к бумаге
             отношения не имеют. Сама этикетка ниже тоже задана в #000/#fff. */
          body {
            background: #fff none;
            color: #000;
          }
        }
      `}</style>
    </div>
  );
}

function LabelSheet({ sheet }: { sheet: Sheet }) {
  return (
    <div className="label-sheet">
      {sheet.labels.map((label, index) => (
        <LabelCard key={index} item={sheet.item} label={label} />
      ))}
    </div>
  );
}

function LabelCard({ item, label }: { item: Item; label: Label }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    // Code128: печатается узко, читается любым сканером, берёт буквы и дефис
    JsBarcode(svg, label.barcodeValue, {
      format: 'CODE128',
      width: 1.6,
      height: 44,
      displayValue: true,
      fontSize: 13,
      margin: 0,
      textMargin: 1,
    });

    // JsBarcode проставляет ширину в пикселях по числу штрихов, и она легко выходит
    // за 75 мм этикетки - обрезанный на печати штрихкод не сканируется вообще.
    // Переводим сгенерированный размер в viewBox и растягиваем по ширине этикетки.
    const width = Number(svg.getAttribute('width'));
    const height = Number(svg.getAttribute('height'));
    if (width && height) {
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.removeAttribute('width');
      svg.removeAttribute('height');
    }
    // Размеры задаём только здесь: JsBarcode переписывает style элемента, поэтому
    // всё, что стояло в разметке до генерации, к этому моменту уже потеряно.
    svg.style.width = '100%';
    svg.style.height = '18mm';
    svg.style.display = 'block';
  }, [label.barcodeValue]);

  return (
    <div
      style={{
        width: '75mm',
        height: '120mm',
        boxSizing: 'border-box',
        padding: '3mm',
        pageBreakAfter: 'always',
        breakAfter: 'page',
        display: 'flex',
        flexDirection: 'column',
        gap: '2mm',
        color: '#000',
        background: '#fff',
        fontFamily: 'Arial, Helvetica, sans-serif',
      }}
    >
      {/* Имя изделия - самое крупное на этикетке: именно его упаковщик читает через цех */}
      <div style={{ fontSize: '5.2mm', fontWeight: 800, lineHeight: 1.15, textTransform: 'uppercase' }}>
        {item.name}
      </div>

      <div style={{ fontSize: '3.4mm', fontFamily: 'monospace' }}>{item.code}</div>

      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.imageUrl}
          alt=""
          style={{
            width: '100%',
            flex: '1 1 auto',
            minHeight: 0,
            objectFit: 'contain',
            // Термопечать всё равно чёрно-белая: поднимаем контраст, чтобы силуэт
            // не расплылся в серое пятно
            filter: 'grayscale(1) contrast(1.35)',
          }}
        />
      )}

      {label.boxesTotal > 1 && (
        <div
          style={{
            fontSize: '6mm',
            fontWeight: 800,
            textAlign: 'center',
            border: '0.6mm solid #000',
            padding: '1mm',
          }}
        >
          КОРОБКА {label.boxNumber} ИЗ {label.boxesTotal}
        </div>
      )}

      {/* Поля по бокам - это «тихая зона» Code128. Без неё сканер часто не берёт код:
          штрихам нужен чистый белый запас слева и справа, а мы растягиваем рисунок
          на всю ширину этикетки. */}
      <div style={{ marginTop: 'auto', padding: '0 5mm', boxSizing: 'border-box' }}>
        <svg ref={svgRef} style={{ width: '100%', height: '18mm', display: 'block' }} />
      </div>

      {/* Названия с Kaspi мелким шрифтом: в заказе может стоять любое из них,
          и упаковщик должен найти совпадение прямо на коробке */}
      <div style={{ fontSize: '2.7mm', lineHeight: 1.25, borderTop: '0.3mm solid #000', paddingTop: '1mm' }}>
        <strong>На Kaspi:</strong>{' '}
        {item.aliases.map((alias) => `${alias.sku} · ${alias.storeName}`).join(' | ') || '—'}
      </div>
    </div>
  );
}
