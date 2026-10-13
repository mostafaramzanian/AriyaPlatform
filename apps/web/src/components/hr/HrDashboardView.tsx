'use client';

import * as React from 'react';
import Link from 'next/link';
import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  fetchHrEmployees,
  fetchHrOrganizationSummary,
  hrDisplayName,
  type HrEmployee,
  type HrOrganizationSummary,
} from '@/lib/hr-api';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from '@/components/core/CoreStates';
import { HrCard, HrEmployeeStatusBadge, HrPageHeading } from './hr-ui';

/**
 * Phase 51-HR-2: the HR landing page — `/admin/hr`.
 *
 * IT SHOWS NOTHING IT DID NOT READ. Every number on this page is a count the SERVER
 * computed inside the caller's tenant (`GET /hr/organization/summary`), and the sample
 * rows come from the same list route the employee screen uses. There is no placeholder
 * figure and no client-side arithmetic over a partial page, which is how a dashboard
 * starts lying ("۲۴ کارمند" from a 20-row page).
 */

const AREAS = [
  { href: '/admin/hr/employees', label: 'کارکنان', hint: 'پرونده پرسنلی و سوابق استخدام' },
  { href: '/admin/hr/organization', label: 'چارت سازمانی', hint: 'واحدها و سلسله‌مراتب' },
  { href: '/admin/hr/positions', label: 'سمت‌ها', hint: 'فهرست جایگاه‌های شغلی' },
  { href: '/admin/hr/attendance', label: 'حضور و غیاب', hint: 'دفتر پانچ روزهای کاری' },
  // Phase 51-HR-3A: leave is a real area of the module, so the home page links to it like the
  // other four — a page reachable only by typing a URL would not be navigation. The card is a
  // LINK and not a permission gate: the register's own read answers at the route.
  { href: '/admin/hr/leave', label: 'مرخصی‌ها', hint: 'دفتر درخواست‌های مرخصی و انواع آن' },
];

export function HrDashboardView() {
  const [summary, setSummary] = React.useState<HrOrganizationSummary | null>(null);
  const [employees, setEmployees] = React.useState<HrEmployee[]>([]);
  const [isLoading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<number | null>(null);
  // Re-arms loading/cleared/error-status in the retry handler (same commit as
  // the token bump) and derives the mount skeleton from the cold
  // `summary: null`, so the register effect needs no in-effect setter resets.
  const { token: reloadToken, reload: reloadList } = useReloadToken(setLoading, setError);
  const reload = () => {
    reloadList();
    setStatus(null);
  };
  const busy = isLoading || (summary === null && error === null);

  React.useEffect(() => {
    let active = true;

    // ONE round of parallel reads: the summary and the first page of the list.
    Promise.all([fetchHrOrganizationSummary(), fetchHrEmployees({ pageSize: 5 })])
      .then(([counts, page]) => {
        if (!active) return;
        setSummary(counts);
        setEmployees(page.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setEmployees([]);
        setError(err instanceof Error ? err.message : 'دریافت اطلاعات با خطا مواجه شد.');
        setStatus(err instanceof CoreApiError ? err.status : null);
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadToken]);

  if (isLoading || busy) return <CoreLoading lines={5} />;

  // 403 is an authorization answer, not a failure: it is rendered as such.
  if (status === 403) return <CoreForbidden />;

  if (error) {
    return <CoreError message={error} onRetry={reload} />;
  }

  const counters = [
    { key: 'employees', label: 'کارکنان', value: summary?.employees ?? 0, testId: 'hr-count-employees' },
    { key: 'units', label: 'واحدهای سازمانی', value: summary?.units ?? 0, testId: 'hr-count-units' },
    { key: 'activeUnits', label: 'واحدهای فعال', value: summary?.activeUnits ?? 0, testId: 'hr-count-active-units' },
    { key: 'positions', label: 'سمت‌ها', value: summary?.positions ?? 0, testId: 'hr-count-positions' },
  ];

  return (
    <div data-testid="hr-dashboard">
      <HrPageHeading
        title="منابع انسانی"
        description="نمای کلی پرونده‌های پرسنلی، چارت سازمانی و سمت‌ها"
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {counters.map((counter) => (
          <div
            key={counter.key}
            data-testid={counter.testId}
            className="rounded-2xl border border-border bg-card p-4"
          >
            <p className="text-xs text-muted-foreground">{counter.label}</p>
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {counter.value.toLocaleString('fa-IR')}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {AREAS.map((area) => (
          <Link
            key={area.href}
            href={area.href}
            data-testid={`hr-area-${area.href.split('/').pop()}`}
            className="rounded-2xl border border-border bg-card p-4 transition hover:border-primary/40"
          >
            <p className="text-sm font-medium text-foreground">{area.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{area.hint}</p>
          </Link>
        ))}
      </div>

      <HrCard title="تازه‌ترین پرونده‌ها">
        {employees.length === 0 ? (
          <CoreEmpty message="هنوز پرونده پرسنلی ثبت نشده است." />
        ) : (
          <ul className="divide-y divide-border" data-testid="hr-dashboard-employees">
            {employees.map((employee) => (
              <li key={employee.id} className="flex items-center justify-between gap-3 py-3">
                <Link
                  href={`/admin/hr/employees/${employee.id}`}
                  className="text-sm text-foreground hover:text-primary"
                  data-testid={`hr-dashboard-employee-${employee.employeeCode}`}
                >
                  <span className="font-medium">{employee.employeeCode}</span>
                  <span className="mx-2 text-muted-foreground">—</span>
                  <span>{hrDisplayName(employee.identity, 'بدون حساب کاربری')}</span>
                </Link>
                <HrEmployeeStatusBadge status={employee.status} />
              </li>
            ))}
          </ul>
        )}
      </HrCard>
    </div>
  );
}
