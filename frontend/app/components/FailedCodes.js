'use client';

import { useState } from 'react';

// Заказы, которые Kaspi не дал собрать через API, доделывают в кабинете вручную. Чтобы не
// переписывать номера с экрана глазами - отдаём их одним списком в буфер обмена.
export default function FailedCodes({ results }) {
  const [copied, setCopied] = useState(false);
  const failed = results.results.filter((r) => !r.success).map((r) => r.order_code);
  if (failed.length === 0) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(failed.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
      <button className="btn btn-sm" onClick={copy}>
        {copied ? 'Скопировано' : `Скопировать номера с ошибкой (${failed.length})`}
      </button>
      <span className="t-dim" style={{ fontSize: 12.5 }}>
        Эти заказы формируются в кабинете Kaspi — вставьте номера в его поиск
      </span>
    </div>
  );
}
