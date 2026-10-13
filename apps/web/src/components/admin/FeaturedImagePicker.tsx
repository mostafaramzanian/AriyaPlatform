'use client';

import * as React from 'react';
import Image from 'next/image';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CmsApiError, getMedia, uploadMedia } from '@/lib/cms-api';

export interface FeaturedImagePickerProps {
  value: string | null;
  onChange: (nextId: string | null) => void;
  label?: string;
}

export function FeaturedImagePicker({ value, onChange, label = 'تصویر شاخص' }: FeaturedImagePickerProps) {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Clearing the preview when the controlled `value` is removed is a prop→state
  // adjustment done during render (guarded by the previous value) — not in the
  // effect body (`react-hooks/set-state-in-effect`). The fetch for a non-null
  // value stays in the effect, which only settles.
  const [prevValue, setPrevValue] = React.useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (!value) setPreviewUrl(null);
  }

  React.useEffect(() => {
    if (!value) return;

    let cancelled = false;
    getMedia(value)
      .then((media) => {
        if (!cancelled) setPreviewUrl(media.url ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl(null);
          setError('پیش‌نمایش تصویر شاخص در دسترس نیست.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value]);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setError('فقط فایل‌های تصویری مجاز هستند.');
      event.target.value = '';
      return;
    }

    setError(null);
    setIsUploading(true);

    try {
      const media = await uploadMedia(file);
      setPreviewUrl(media.url ?? null);
      onChange(media.id ?? null);
    } catch (err) {
      setError(err instanceof CmsApiError ? err.message : 'آپلود تصویر شاخص ناموفق بود.');
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  }

  function handleRemove() {
    setError(null);
    setPreviewUrl(null);
    onChange(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <label className="text-sm font-medium text-foreground">{label}</label>
        {value && (
          <span className="text-xs text-muted-foreground">شناسه: {value.slice(0, 8)}...</span>
        )}
      </div>

      {error && <Alert type="error" message={error} />}

      {!previewUrl ? (
        <div className="flex min-h-32 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
          {isUploading ? 'در حال آپلود تصویر...' : 'هنوز تصویری انتخاب نشده است.'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-muted/10">
          {/* CMS media URLs are server-chosen and may live on any host, so the
              preview opts out of the image optimizer (no remote-host allowlist
              needed); CSS owns the box exactly as before. */}
          <Image
            src={previewUrl}
            alt={label}
            width={768}
            height={384}
            unoptimized
            className="h-48 w-full object-cover"
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => inputRef.current?.click()} disabled={isUploading}>
          {isUploading ? 'در حال آپلود...' : value ? 'تغییر تصویر' : 'انتخاب تصویر'}
        </Button>
        {value && (
          <Button
            type="button"
            className="bg-secondary text-secondary-foreground hover:bg-secondary/90"
            onClick={handleRemove}
            disabled={isUploading}
          >
            حذف تصویر
          </Button>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileChange}
        aria-label={label}
      />
    </div>
  );
}
