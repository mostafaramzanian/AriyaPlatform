'use client';

import { useRouter } from 'next/navigation';
import { Eye, Trash2, FileCheck2, Paperclip } from 'lucide-react';
import {
  corrUserName,
  formatCorrTime,
  REFERRAL_LEVEL_LABELS,
  type InboxItem,
} from '@/lib/correspondence-api';
import { CorrUrgencyBadge, RecipientStateBadge, ReferralStatusBadge } from './CorrBadges';

/**
 * Phase 50: the visible stamp of one inbox row — actions are real server
 * mutations (مشاهده، اقدام، حذف از صندوق), performed only on the caller's own rows.
 */
export function InboxStamp({
  item,
  onViewed,
  onActed,
  onRemove,
}: {
  item: InboxItem;
  onViewed: () => void;
  onActed: () => void;
  onRemove: () => void;
}) {
  const router = useRouter();
  const open = () => {
    router.push(`/admin/correspondence/${item.letter.id}`);
  };

  return (
    <li className="rounded-2xl border border-border bg-card p-4 shadow-card transition hover:border-primary/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full truncate text-right text-sm font-semibold text-foreground hover:text-primary"
            onClick={open}
          >
            {item.letter.subject}
          </button>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {item.source === 'REFERRAL' && item.referral
              ? `ارجاع از ${corrUserName(item.referral.from)} — سطح ${REFERRAL_LEVEL_LABELS[item.referral.level]}`
              : `از ${corrUserName(item.letter.sender)}`}
            {item.letter.letterNumber ? ` — ${item.letter.letterNumber}` : ''}
          </p>
          {item.source === 'REFERRAL' && item.referral?.instruction && (
            <p className="mt-1.5 rounded-lg bg-secondary/50 px-3 py-2 text-[11px] leading-6 text-foreground/80">
              {item.referral.instruction}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <CorrUrgencyBadge urgency={item.letter.urgency} />
            {item.myState && <RecipientStateBadge state={item.myState} />}
            {item.source === 'REFERRAL' && item.referral && (
              <ReferralStatusBadge status={item.referral.status} />
            )}
            {item.attachmentCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[10.5px] text-muted-foreground">
                <Paperclip className="size-3" aria-hidden="true" />
                {item.attachmentCount.toLocaleString('fa-IR')} پیوست
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {formatCorrTime(
              item.source === 'REFERRAL' && item.referral
                ? item.referral.createdAt
                : item.letter.sentAt,
            )}
          </span>
          <div className="flex gap-1">
            <button
              type="button"
              aria-label={`مشاهده ${item.letter.subject}`}
              className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              onClick={open}
            >
              <Eye className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`ثبت مشاهده ${item.letter.subject}`}
              className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              onClick={onViewed}
            >
              <Eye className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label={`ثبت اقدام برای ${item.letter.subject}`}
              className="grid size-8 place-items-center rounded-lg border border-emerald-400/30 bg-emerald-500/10 text-emerald-700 transition hover:bg-emerald-500/15 dark:text-emerald-300"
              onClick={onActed}
            >
              <FileCheck2 className="size-3.5" aria-hidden="true" />
            </button>
            {item.source === 'RECIPIENT' && (
              <button
                type="button"
                aria-label={`حذف از صندوق: ${item.letter.subject}`}
                className="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                onClick={onRemove}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}