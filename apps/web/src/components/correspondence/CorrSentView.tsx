'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Eye, Send } from 'lucide-react';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  archiveLetter,
  listSent,
  newCorrKey,
  removeSentFromList,
  sendLetter,
  type CorrLetter,
} from '@/lib/correspondence-api';
import { CorrLetterList } from './CorrLetterList';

/**
 * Phase 50: نامه‌های ارسالی page. The reference's delivery status is served from
 * REAL recipient states: «تحویل شده» when every addressed recipient has the letter,
 * «مشاهده شده» when at least one has VIEWED/READ, «در حال بررسی» otherwise.
 *
 * «حذف از لیست» is the soft per-sender stamp — the canonical letter stays.
 */
export function CorrSentView() {
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
    listSent({ limit: 50 })
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'دریافت نامه‌های ارسالی ناموفق بود.');
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
      await removeSentFromList(letter.id);
      setItems((prev) => prev.filter((item) => item.id !== letter.id));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'حذف از لیست ناموفق بود.');
    }
  };

  const handleArchive = async (letter: CorrLetter) => {
    setActionError(null);
    try {
      await archiveLetter(letter.id, null);
      setItems((prev) => prev.filter((item) => item.id !== letter.id));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'بایگانی ناموفق بود.');
    }
  };

  const handleResend = async (letter: CorrLetter) => {
    setActionError(null);
    try {
      // ارسال مجدد of a SENT letter is refused by the state machine (409);
      // the surface exists so the user sees the truth instead of silence.
      await sendLetter(letter.id, newCorrKey());
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : 'ارسال مجدد ممکن نیست — نامه قبلاً ارسال شده است.',
      );
    }
  };

  const deliveryStatusFor = (letter: CorrLetter): { label: string; cls: string; Icon: typeof Eye } => {
    const states = (letter.recipients ?? []).map((recipient) => recipient.state);
    if (states.length === 0) {
      return { label: 'بدون گیرنده', cls: 'bg-secondary/60 text-muted-foreground border-border', Icon: Send };
    }
    if (states.some((state) => state === 'VIEWED' || state === 'READ' || state === 'ACTED')) {
      return {
        label: 'مشاهده شده',
        cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/25',
        Icon: Eye,
      };
    }
    if (states.every((state) => state !== 'DELIVERED')) {
      return {
        label: 'در حال بررسی',
        cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/25',
        Icon: Send,
      };
    }
    return {
      label: 'تحویل شده',
      cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-400/25',
      Icon: Send,
    };
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
        title="نامه‌های ارسالی"
        icon={Send}
        subtitle="مکاتبات خروجی شما — حذف از لیست، نامه را از سامانه حذف نمی‌کند"
        items={items}
        isLoading={isLoading}
        error={error}
        emptyLabel="نامه ارسالی یافت نشد"
        emptyActionLabel="ایجاد نامه جدید"
        onCreate={() => router.push('/admin/correspondence/new')}
        onRetry={reload}
        onOpen={(letter) => router.push(`/admin/correspondence/${letter.id}`)}
        onSend={handleResend}
        onArchive={handleArchive}
        onDelete={handleDelete}
        deleteLabel="حذف از لیست"
        deleteConfirmTitle="حذف از لیست"
        deleteConfirmBody={(letter) =>
          `آیا از حذف نامه «${letter.subject}» از این لیست مطمئن هستید؟ نامه ارسال‌شده در سامانه باقی می‌ماند.`
        }
        searchPlaceholder="جستجو در موضوع یا شماره نامه…"
        renderExtra={(letter) => {
          const { label, cls, Icon } = deliveryStatusFor(letter);
          return (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${cls}`}
            >
              <Icon className="size-3" aria-hidden="true" />
              {label}
            </span>
          );
        }}
      />
    </div>
  );
}