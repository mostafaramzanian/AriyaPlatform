import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';

export default function NotFound() {
  return (
    <PublicLayout>
      <section className="section-shell">
        <div className="container-shell">
          <div className="card-panel mx-auto max-w-3xl px-8 py-16 text-center md:px-12">
            <div className="eyebrow mb-5">404</div>
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">صفحه یافت نشد</h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
              صفحه‌ای که درخواست کردید یافت نشد. لطفاً به تجربه اصلی بازگردید یا با تیم آریا یک گفتگو شروع کنید.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-4 sm:flex-row">
              <Link href="/" className="btn-primary">
                بازگشت به صفحه اصلی
              </Link>
              <Link href="/request-demo" className="btn-secondary">
                رزرو دموی سازمانی
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
