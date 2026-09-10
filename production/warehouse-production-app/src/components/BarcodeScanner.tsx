'use client';

import { useEffect, useRef, useState } from 'react';
import {
  BrowserMultiFormatReader,
  IScannerControls,
} from '@zxing/browser';
import { DecodeHintType, BarcodeFormat } from '@zxing/library';

interface BarcodeScannerProps {
  /** Called once per distinct scanned value (debounced against rapid repeats). */
  onScan: (value: string) => void;
  onClose: () => void;
}

// Formats actually used in a warehouse/retail context: 1D product barcodes
// (EAN/UPC/Code128/Code39) plus QR, in case Kaspi labels or internal tags
// switch to QR later. Restricting the format set (vs. "try everything")
// noticeably speeds up decoding per frame.
const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.QR_CODE,
]);

export default function BarcodeScanner({ onScan, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ value: string; time: number }>({ value: '', time: 0 });
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const reader = new BrowserMultiFormatReader(HINTS);
    let cancelled = false;

    reader
      .decodeFromConstraints(
        {
          video: {
            facingMode: { ideal: 'environment' }, // rear camera on phones/tablets
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current!,
        (result) => {
          if (cancelled || !result) return;

          const value = result.getText();
          const now = Date.now();
          // Debounce: the reader fires on nearly every frame while the code
          // stays in view, so ignore repeats of the same value within 2s.
          if (lastScanRef.current.value === value && now - lastScanRef.current.time < 2000) {
            return;
          }
          lastScanRef.current = { value, time: now };
          onScan(value);
        }
      )
      .then((controls) => {
        if (cancelled) {
          controls.stop();
          return;
        }
        controlsRef.current = controls;
        setReady(true);
      })
      .catch((err) => {
        console.error('Camera error:', err);
        if (!cancelled) {
          setError(
            err?.name === 'NotAllowedError'
              ? 'Доступ к камере запрещён. Разрешите доступ в настройках браузера.'
              : err?.name === 'NotFoundError'
                ? 'Камера не найдена на этом устройстве.'
                : 'Не удалось запустить камеру.'
          );
        }
      });

    return () => {
      cancelled = true;
      controlsRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Чёрный фон под видео - в обеих темах: это окно камеры, а не поверхность интерфейса
    <div className="rounded-lg border-2 border-line-strong bg-black p-2">
      {error ? (
        <div className="p-4 text-center text-danger text-sm">{error}</div>
      ) : (
        <div className="relative">
          <video
            ref={videoRef}
            muted
            playsInline
            className="w-full rounded max-h-80 object-cover"
          />
          {!ready && (
            <div className="absolute inset-0 flex items-center justify-center text-on-brass text-sm">
              Запуск камеры...
            </div>
          )}
          {ready && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="w-2/3 h-1/3 border-2 border-ok rounded-lg" />
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        className="mt-2 w-full rounded-lg border border-line py-2 font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
      >
        Закрыть камеру
      </button>
    </div>
  );
}
