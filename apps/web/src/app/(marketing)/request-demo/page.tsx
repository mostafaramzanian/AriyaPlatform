import type { Metadata } from 'next';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection } from '@/components/sections/PageSections';

export const metadata: Metadata = {
  title: 'درخواست دموی سازمانی',
  description: 'درخواستی برای دموی سفارشی با تیم آریا جهت ارزیابی پلتفرم در زمینهٔ سازمان شما ثبت کنید.',
};

export default function RequestDemoPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="درخواست دموی سفارشی"
        description="چند جزئیات دربارهٔ سازمان خود ارائه دهید تا گفتگویی متمرکز دربارهٔ معماری، گردش کارها و فعال‌سازی هوش برنامه‌ریزی کنیم."
      />

      <section className="section-shell">
        <div className="container-shell max-w-4xl">
          <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="card-panel p-8">
              <div className="eyebrow mb-5">انتظارات</div>
              <h2 className="text-2xl font-semibold text-foreground">ارزیابی متمرکز، نه معرفی کلی</h2>
              <p className="mt-4 text-sm leading-8 text-muted-foreground">
                دربارهٔ تناسب پلتفرم آریا با زمینهٔ کسب‌وکار شما، ملاحظات استقرار، مسیرهای یکپارچه‌سازی و نتایج عملیاتی کلیدی گفتگو خواهیم کرد.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-muted-foreground">
                <li>• یک بررسی ساختارمند ۳۰–۴۵ دقیقه‌ای</li>
                <li>• بررسی سیستم‌ها و محدودیت‌های فعلی سازمان شما</li>
                <li>• توصیهٔ عملی برای گام بعدی</li>
              </ul>
            </div>

            <form className="card-panel p-8 md:p-10">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">نام و نام خانوادگی</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="نام و نام خانوادگی" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">ایمیل کاری</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="ایمیل کاری" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">شرکت</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="نام شرکت" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">نقش</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="CTO / CIO / مدیر تحول دیجیتال" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">صنعت</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="تولید / لجستیک / انرژی" />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">مورد استفاده اولویت‌دار</label>
                  <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="اتوماسیون گردش‌کار / یکپارچه‌سازی داده" />
                </div>
              </div>
              <div className="mt-5">
                <label className="mb-2 block text-sm font-medium text-foreground">اطلاعات بیشتر</label>
                <textarea rows={4} className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="دربارهٔ چالشی که ارزیابی می‌کنید و نتایجی که می‌خواهید بهبود یابند بنویسید." />
              </div>
              <button type="submit" className="btn-primary mt-6 w-full">ثبت درخواست</button>
            </form>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
