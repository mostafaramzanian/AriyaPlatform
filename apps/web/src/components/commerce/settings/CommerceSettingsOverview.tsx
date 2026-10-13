'use client';

import { CoreEmpty } from '@/components/core/CoreStates';

/**
 * PHASE UI-4: «نمای کلی» — the domain's landing panel.
 *
 * WHAT IT IS: an explanation of what an administrator can configure here, plus the two
 * real next steps. WHAT IT IS DELIBERATELY NOT (the brief says so twice): a KPI
 * dashboard. There is no count on this panel, because the only honest numbers would be
 * list totals the overview does not read — and a card that fabricated one would be the
 * lying dashboard UI-0 §7.3 forbids.
 *
 * THE «مسیردهی اقلام» BRANCH IS ABSENT, NOT DISABLED. Line-routing configuration has no
 * HTTP surface in the current backend (`workflow-line-routing*.ts` has no controller —
 * UI-0 GAP-2, re-verified for this phase), so a card for it would promise a save that
 * cannot exist. The branch appears here the day the route does.
 */

export function CommerceSettingsOverview({
  onNavigate,
}: {
  onNavigate: (view: 'workflows' | 'commercial' | 'completion') => void;
}) {
  return (
    <div className="space-y-core-gap">
      <p className="text-sm text-muted-foreground">
        فرآیند ثبت، بررسی و رسیدگی به درخواست‌های خرید سازمان را از این بخش مدیریت کنید. کارهای
        زیرمجموعهٔ این بخش از درخواست‌های جدید پشتیبانی می‌کنند؛ برای تغییر هر پیکربندی، وضعیت
        پیش‌نویس یا منتشرشدهٔ آن را در نظر بگیرید.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => onNavigate('workflows')}
          data-testid="commerce-settings-card-workflows"
          className="rounded-2xl border border-border bg-card p-4 text-start transition hover:border-primary/40"
        >
          <p className="text-sm font-medium text-foreground">فرآیندهای خرید</p>
          <p className="mt-1 text-xs text-muted-foreground">
            مشخص کنید درخواست‌ها چه مراحلی را طی کنند، هر مرحله بر عهدهٔ چه کسی باشد و چه زمانی
            منتشر شود.
          </p>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('commercial')}
          data-testid="commerce-settings-card-commercial"
          className="rounded-2xl border border-border bg-card p-4 text-start transition hover:border-primary/40"
        >
          <p className="text-sm font-medium text-foreground">تنظیمات بازرگانی</p>
          <p className="mt-1 text-xs text-muted-foreground">
            گروه‌ها و پیکربندی رسیدگی بازرگانی به ردیف‌های خرید را مدیریت کنید.
          </p>
        </button>

        {/* PHASE C4-R (GAP-3): the completion rule, beside the two branches above. */}
        <button
          type="button"
          onClick={() => onNavigate('completion')}
          data-testid="commerce-settings-card-completion"
          className="rounded-2xl border border-border bg-card p-4 text-start transition hover:border-primary/40"
        >
          <p className="text-sm font-medium text-foreground">تکمیل خرید</p>
          <p className="mt-1 text-xs text-muted-foreground">
            تعیین کنید سند درخواست خرید در چه وضعیت‌هایی «تکمیل‌شده» محسوب می‌شود.
          </p>
        </button>
      </div>

      <CoreEmpty message="برای شروع، یکی از بخش‌های بالا را انتخاب کنید." />
    </div>
  );
}
