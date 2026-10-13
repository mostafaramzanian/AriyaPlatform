'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Mail, Phone } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { directoryFullName, fetchDirectoryMember, type DirectoryMember } from '@/lib/directory-api';
import { useReloadToken } from '@/hooks/use-reload-token';
import { CoreError, CoreForbidden, CoreLoading } from './CoreStates';
import { DirectoryAvatar } from './DirectoryAvatar';

/**
 * Phase 49D-1: Organization Directory member detail.
 *
 * Renders only the approved directory projection from
 * `GET /users/directory/:id`. Cross-tenant and unknown ids are both 404 on the
 * backend, so this view shows one identical not-found state for either — it
 * cannot be used to probe whether a foreign user exists.
 */

const STATUS_LABELS: Record<string, string> = {
  EMPLOYEE: 'کارمند',
  VISITOR: 'بازدیدکننده',
  LEAD: 'سرنخ',
  CUSTOMER: 'مشتری',
  PARTNER: 'همکار',
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function CoreDirectoryMemberView({ memberId }: { memberId: string }) {
  const [member, setMember] = React.useState<DirectoryMember | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Loading/error arming lives in the retry handler (same commit as the token
  // bump) and in the memberId-change reset below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles. First mount
  // is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [prevMemberId, setPrevMemberId] = React.useState(memberId);
  if (prevMemberId !== memberId) {
    setPrevMemberId(memberId);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let cancelled = false;

    fetchDirectoryMember(memberId)
      .then((data) => {
        if (cancelled) return;
        setMember(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMember(null);
        setError({
          message: err instanceof Error ? err.message : 'دریافت اطلاعات همکار با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [memberId, reloadToken]);

  const backLink = (
    <Link
      href="/admin/directory"
      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowRight aria-hidden="true" className="h-4 w-4" />
      بازگشت به دفترچه سازمانی
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <div className="core-card p-core-card">
          <CoreLoading label="در حال بارگذاری اطلاعات همکار..." lines={5} />
        </div>
      </div>
    );
  }

  if (error?.status === 403) {
    return (
      <div className="space-y-6">
        {backLink}
        <CoreForbidden message="شما به دفترچه سازمانی دسترسی ندارید." />
      </div>
    );
  }

  if (error?.status === 404) {
    return (
      <div className="space-y-6">
        {backLink}
        <div
          className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center"
          data-testid="directory-not-found"
        >
          <h1 className="text-base font-semibold text-foreground">همکار یافت نشد</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            این همکار در دفترچه سازمانی شما وجود ندارد.
          </p>
        </div>
      </div>
    );
  }

  if (error || !member) {
    return (
      <div className="space-y-6">
        {backLink}
        <CoreError
          message={error?.message ?? 'اطلاعات همکار یافت نشد.'}
          onRetry={error?.status === 401 ? undefined : reload}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {backLink}
      <DirectoryMemberCard member={member} />
    </div>
  );
}

function DirectoryMemberCard({ member }: { member: DirectoryMember }) {
  const name = directoryFullName(member) ?? member.email;
  const managerName = member.manager ? directoryFullName(member.manager) : null;

  return (
    <section
      className="core-card p-core-card md:p-core-card-lg"
      aria-labelledby="directory-member-heading"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <DirectoryAvatar member={member} size="lg" />
        <div className="min-w-0">
          <h1 id="directory-member-heading" className="text-xl font-semibold text-foreground">
            {name}
          </h1>
          {member.jobTitle && (
            <p className="mt-1 text-sm text-muted-foreground">{member.jobTitle}</p>
          )}
          {member.department && (
            <p className="mt-0.5 text-xs text-muted-foreground">{member.department}</p>
          )}
        </div>
      </div>

      <dl className="mt-6">
        <DetailRow label="ایمیل سازمانی">
          <a
            href={`mailto:${member.email}`}
            className="inline-flex items-center gap-1.5 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Mail aria-hidden="true" className="h-4 w-4" />
            {member.email}
          </a>
        </DetailRow>

        <DetailRow label="تلفن">
          {member.phone ? (
            <a
              href={`tel:${member.phone}`}
              className="inline-flex items-center gap-1.5 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Phone aria-hidden="true" className="h-4 w-4" />
              {member.phone}
            </a>
          ) : (
            '—'
          )}
        </DetailRow>

        <DetailRow label="شماره داخلی">{member.extension || '—'}</DetailRow>
        <DetailRow label="واحد سازمانی">{member.department || '—'}</DetailRow>
        <DetailRow label="سمت">{member.jobTitle || '—'}</DetailRow>

        <DetailRow label="مدیر">
          {member.manager ? (
            <Link
              href={`/admin/directory/${member.manager.id}`}
              className="inline-flex items-center gap-2 text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <DirectoryAvatar member={member.manager} size="sm" />
              <span>
                {managerName ?? 'مدیر'}
                {member.manager.jobTitle ? ` — ${member.manager.jobTitle}` : ''}
              </span>
            </Link>
          ) : (
            '—'
          )}
        </DetailRow>

        {member.status && (
          <DetailRow label="وضعیت">{STATUS_LABELS[member.status] ?? member.status}</DetailRow>
        )}
      </dl>
    </section>
  );
}
