'use client';

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileCheck2,
  FileEdit,
  Flame,
  Lock,
  Send,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  CLASSIFICATION_LABELS,
  RECIPIENT_STATE_LABELS,
  REFERRAL_STATUS_LABELS,
  STATUS_LABELS,
  URGENCY_LABELS,
  type LetterClassification,
  type LetterStatus,
  type LetterUrgency,
  type ReferralStatus,
} from '@/lib/correspondence-api';

/**
 * Phase 50: compact metadata badges.
 *
 * ACCESSIBILITY CONTRACT: status is never conveyed by colour alone — every badge
 * pairs a tinted pill with a distinct icon AND a text label, so greyscale renders,
 * 125–140% text scales and screen readers all resolve the state identically.
 */

const URGENCY_STYLES: Record<LetterUrgency, { cls: string; dot: string; Icon: typeof Flame }> = {
  NORMAL: {
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/25',
    dot: 'bg-emerald-500',
    Icon: CheckCircle2,
  },
  IMPORTANT: {
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/25',
    dot: 'bg-amber-500',
    Icon: Clock,
  },
  URGENT: {
    cls: 'bg-orange-500/10 text-orange-700 dark:text-orange-300 border-orange-400/25',
    dot: 'bg-orange-500',
    Icon: AlertTriangle,
  },
  CRITICAL: {
    cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-400/25',
    dot: 'bg-rose-500',
    Icon: Flame,
  },
};

export function UrgencyBadge({ urgency, className }: { urgency: LetterUrgency; className?: string }) {
  const { cls, dot, Icon } = URGENCY_STYLES[urgency] ?? URGENCY_STYLES.NORMAL;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        cls,
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', dot)} />
      <Icon aria-hidden="true" className="size-3" />
      {URGENCY_LABELS[urgency] ?? urgency}
    </span>
  );
}

const CLASSIFICATION_STYLES: Record<
  LetterClassification,
  { cls: string; Icon: typeof Lock }
> = {
  NORMAL: {
    cls: 'bg-secondary/60 text-muted-foreground border-border',
    Icon: ShieldCheck,
  },
  CONFIDENTIAL: {
    cls: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/25',
    Icon: Lock,
  },
  SECRET: {
    cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-400/25',
    Icon: ShieldAlert,
  },
};

export function ClassificationBadge({
  classification,
  className,
}: {
  classification: LetterClassification;
  className?: string;
}) {
  const { cls, Icon } = CLASSIFICATION_STYLES[classification] ?? CLASSIFICATION_STYLES.NORMAL;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        cls,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {CLASSIFICATION_LABELS[classification] ?? classification}
    </span>
  );
}

const STATUS_STYLES: Record<LetterStatus, { cls: string; Icon: typeof Send }> = {
  DRAFT: { cls: 'bg-secondary/60 text-muted-foreground border-border', Icon: FileEdit },
  READY_TO_SEND: {
    cls: 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-400/25',
    Icon: Clock,
  },
  SENT: {
    cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/25',
    Icon: Send,
  },
  CANCELLED: {
    cls: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-400/25',
    Icon: AlertTriangle,
  },
};

export function LetterStatusBadge({
  status,
  className,
}: {
  status: LetterStatus;
  className?: string;
}) {
  const { cls, Icon } = STATUS_STYLES[status] ?? STATUS_STYLES.DRAFT;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        cls,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

const RECIPIENT_STATE_ICONS: Record<string, typeof Eye> = {
  DELIVERED: Send,
  VIEWED: Eye,
  READ: CheckCircle2,
  ACTION_REQUIRED: AlertTriangle,
  REFERRED: FileCheck2,
  ACTED: FileCheck2,
};

export function RecipientStateBadge({ state, className }: { state: string; className?: string }) {
  const Icon = RECIPIENT_STATE_ICONS[state] ?? Clock;
  const tone =
    state === 'ACTED' || state === 'READ'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/25'
      : state === 'DELIVERED'
        ? 'bg-secondary/60 text-muted-foreground border-border'
        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/25';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {RECIPIENT_STATE_LABELS[state] ?? state}
    </span>
  );
}

export function ReferralStatusBadge({
  status,
  className,
}: {
  status: ReferralStatus;
  className?: string;
}) {
  const tone =
    status === 'ACTED'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-400/25'
      : status === 'VIEWED'
        ? 'bg-cyan-500/10 text-cyan-700 dark:text-cyan-300 border-cyan-400/25'
        : 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-400/25';

  const Icon = status === 'ACTED' ? FileCheck2 : status === 'VIEWED' ? Eye : Clock;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium',
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {REFERRAL_STATUS_LABELS[status] ?? status}
    </span>
  );
}
// Aliases used by the list/stamp surfaces.
export const CorrUrgencyBadge = UrgencyBadge;
export const CorrClassificationBadge = ClassificationBadge;
export const CorrStatusBadge = LetterStatusBadge;
