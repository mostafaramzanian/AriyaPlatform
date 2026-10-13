import type { Metadata } from 'next';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, CTASection } from '@/components/sections/PageSections';

export const metadata: Metadata = {
  title: 'درباره آریا',
  description: 'آشنایی با مأموریت، تیم و جهت‌گیری محصول پشت پلتفرم هوش سازمانی آریا.',
};

export default function AboutPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="مأموریتی متمرکز برای هوش سازمانی."
        description="آریا در خدمت سازمان‌ها برای به‌روز‌رسانی عملیات با هوش قابل اعتماد است، در حالی که سیستم‌ها، کنترل‌ها و مسئولیت‌های موجود حفظ می‌شوند."
      />

      <section className="section-shell">
        <div className="container-shell grid gap-8 lg:grid-cols-[1fr_0.95fr]">
          <div className="card-panel p-8 md:p-10">
            <div className="eyebrow mb-5">ماموریت</div>
            <h2 className="section-title">ساخت لایهٔ عملیاتی برای سازمان‌های هوشمند</h2>
            <p className="mt-5 text-lg leading-8 text-muted-foreground">
              باور داریم نرم‌افزار سازمانی آینده کمتر به ماژول‌های منفرد و بیشتر به هوشِ متصل وابسته خواهد بود. آریا با وضوح، حاکمیت و انعطاف‌پذیری برای این نیاز طراحی شده است.
            </p>
          </div>
          <div className="card-panel p-8 md:p-10">
            <div className="eyebrow mb-5">جهت‌گیری</div>
            <div className="space-y-4 text-sm leading-8 text-muted-foreground">
              <div>
                <div className="font-semibold text-foreground">اولویت سازمانی</div>
                <p>تمرکز بر واقعیت‌های سازمانی، نه وعده‌های کلیِ هوش مصنوعی.</p>
              </div>
              <div>
                <div className="font-semibold text-foreground">خودکارسازی کاربردی</div>
                <p>طراحی‌شده برای گردش کارهای واقعی، تصویب‌ها و محدودیت‌های عملیاتی.</p>
              </div>
              <div>
                <div className="font-semibold text-foreground">پذیرش قابل اعتماد</div>
                <p>ساخته‌شده تا به‌صورت قابل ارزیابی، تحت حاکمیت و با مسئولیت یکپارچه شود.</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <CTASection
        title="نحوهٔ تناسب آریا با سازمان شما را ببینید"
        description="با یک گفتگوی متمرکز دربارهٔ تناسب محصول، معماری و اولویت‌های پیاده‌سازی شروع کنید."
        primaryButtonText="رزرو دموی سازمانی"
        primaryButtonHref="/request-demo"
        secondaryButtonText="تماس با تیم"
        secondaryButtonHref="/contact"
      />
    </PublicLayout>
  );
}
