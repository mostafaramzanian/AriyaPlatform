'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  deleteDraft,
  listDrafts,
  sendLetter,
  newCorrKey,
  type CorrLetter,
} from '@/lib/correspondence-api';
import { CorrLetterList } from './CorrLetterList';

/**
 * Phase 50: پیش‌نویس‌ها page. Real data, real actions: delete is a server call
 * (hard delete of MY DRAFT only), send goes through the idempotent send endpoint
 * (a double click cannot send twice — the server's unique key arbitrates).
 */
export function CorrDraftsView() {
  const router = useRouter();
  const [items, setItems] = React.useState<CorrLetter[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the fetch effect below needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  React.useEffect(() => {
    let active = true;
    listDrafts({ limit: 50 })
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'دریافت پیش‌نویس‌ها ناموفق بود.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const handleDelete = async (letter: CorrLetter) => {
    setActionError(null);
    try {
      await deleteDraft(letter.id);
      setItems((prev) => prev.filter((item) => item.id !== letter.id));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'حذف پیش‌نویس ناموفق بود.');
    }
  };

  const handleSend = async (letter: CorrLetter) => {
    setActionError(null);
    try {
      const sendKey = newCorrKey();
      await sendLetter(letter.id, sendKey);
      setItems((prev) => prev.filter((item) => item.id !== letter.id));
      router.push('/admin/correspondence/sent');
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ارسال نامه ناموفق بود.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {actionError}
        </div>
      )}
      <CorrLetterList
        title="پیش‌نویس‌ها"
        subtitle="نامه‌های در حال تهیه — هر پیش‌نویس فقط برای خودتان نمایان است"
        mode="drafts"
        items={items}
        isLoading={isLoading}
        error={error}
        emptyLabel="پیش‌نویسی یافت نشد"
        emptyActionLabel="ایجاد نامه جدید"
        onCreate={() => router.push('/admin/correspondence/new')}
        onRetry={reload}
        onOpen={(letter) => router.push(`/admin/correspondence/${letter.id}`)}
        onSend={handleSend}
        onDelete={handleDelete}
        deleteLabel="حذف پیش‌نویس"
        deleteConfirmTitle="حذف پیش‌نویس"
        deleteConfirmBody={(letter) =>
          `آیا از حذف پیش‌نویس «${letter.subject}» مطمئن هستید؟ این عمل قابل بازگشت نیست.`
        }
        searchPlaceholder="جستجو در موضوع، گیرنده یا شناسه…"
      />
    </div>
  );
}