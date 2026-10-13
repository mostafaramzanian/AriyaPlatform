import type { Metadata } from 'next';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, CTASection } from '@/components/sections/PageSections';

export const metadata: Metadata = {
  title: 'تماس با ما',
  description: 'برای گفتگو دربارهٔ هوش سازمانی، تناسب محصول و برنامه‌ریزی پیاده‌سازی با تیم آریا تماس بگیرید.',
};

export default function ContactPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="در مورد مدل عملیاتی خود گفتگو کنیم."
        description="چه در حال ارزیابی آمادگی هوش، تناسب پلتفرم یا یکپارچه‌سازی فنی باشید، تیم آریا آماده است تا گام بعدی را با شما بررسی کند."
      />

      <section className="section-shell">
        <div className="container-shell grid gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="card-panel p-8 md:p-10">
            <div className="eyebrow mb-5">تماس</div>
            <h2 className="text-2xl font-semibold text-foreground">ارسال پیام به تیم آریا</h2>
            <form className="mt-6 space-y-5">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <label htmlFor="contact-name" className="mb-2 block text-sm font-medium text-foreground">نام</label>
                  <input id="contact-name" name="name" className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="نام شما" />
                </div>
                <div>
                  <label htmlFor="contact-email" className="mb-2 block text-sm font-medium text-foreground">ایمیل</label>
                  <input id="contact-email" name="email" type="email" className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="ایمیل شما" />
                </div>
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">شرکت</label>
                <input className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="شرکت شما" />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-foreground">پیام</label>
                <textarea rows={5} className="w-full rounded-2xl border border-border bg-surface px-4 py-3 text-sm outline-none ring-0 focus:border-primary" placeholder="درباره چالشی که ارزیابی می‌کنید برای ما بگویید." />
              </div>
              <button type="submit" className="btn-primary w-full">ارسال پیام</button>
            </form>
          </div>

          <div className="card-panel p-8 md:p-10">
            <div className="eyebrow mb-5">اطلاعات تماس</div>
            <h2 className="text-2xl font-semibold text-foreground">یک گام عملی اول</h2>
            <div className="mt-6 space-y-5 text-sm text-muted-foreground">
              <div>
                <div className="font-semibold text-foreground">ایمیل</div>
                <a href="mailto:hello@aria.ai" className="mt-1 inline-block text-primary transition hover:underline">hello@aria.ai</a>
              </div>
              <div>
                <div className="font-semibold text-foreground">تلفن</div>
                <a href="tel:+1234567890" className="mt-1 inline-block text-primary transition hover:underline">+1 (234) 567-890</a>
              </div>
              <div>
                <div className="font-semibold text-foreground">ساعت کاری</div>
                <p className="mt-1 leading-7">دوشنبه تا جمعه · ۹:۰۰–۱۸:۰۰</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <CTASection
        title="برای گفتگوی تخصصی آماده‌اید؟"
        description="با یک دموی سفارشی شروع کنید و آریا را در برابر محیط عملیاتی خود ارزیابی کنید."
        primaryButtonText="رزرو دموی سازمانی"
        primaryButtonHref="/request-demo"
        secondaryButtonText="کاوش پلتفرم"
        secondaryButtonHref="/product"
      />
    </PublicLayout>
  );
}
