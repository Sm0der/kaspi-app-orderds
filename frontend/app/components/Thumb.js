'use client';

// Маленькая картинка товара с аккуратной заглушкой, если её ещё не подтянули
// (см. кнопку «Подтянуть картинки» в разделе отгрузки) или Kaspi её не отдал.
export default function Thumb({ src, alt, size = 'md' }) {
  if (!src) {
    return (
      <span className={`thumb thumb-placeholder ${size === 'sm' ? 'thumb-sm' : ''}`} title={alt}>
        📦
      </span>
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      className={`thumb ${size === 'sm' ? 'thumb-sm' : ''}`}
      src={src}
      alt={alt || ''}
      loading="lazy"
      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
    />
  );
}
