import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, CTASection } from '@/components/sections/PageSections';
import { Blocks, Workflow, DatabaseZap, ShieldCheck, Sparkles } from 'lucide-react';

export const metadata: Metadata = {
  title: 'پلتفرم',
  description: 'آریا را کشف کنید، پلتفرم عملیاتی هوش مصنوعی سازمانی برای سازمان های مدرن.',
};

const capabilities = [
  {
    icon: <Blocks className="h-6 w-6" />,
    title: 'لایه سازمانی متصل',
    description: 'یکپارچه کردن ERP، اسناد و جریان کار بدون جایگزینی سیستم‌های مورد اعتماد.',
  },
  {
    icon: <Workflow className="h-6 w-6" />,
    title: 'خودکارسازی عملیاتی',
    description: 'هماهنگی انتقال‌ها، تصویب‌ها و اقدامات از طریق جریان کار هدایت‌شده و قابل کنترل.',
  },
  {
    icon: <DatabaseZap className="h-6 w-6" />,
    title: 'هوش بر روی داده‌ها',
    description: 'ایجاد یک لایه عملیاتی قابل اعتماد برای برنامه‌ریزی، بینش و تصمیم‌گیری سریع‌تر.',
  },
  {
    icon: <ShieldCheck className="h-6 w-6" />,
    title: 'حکمرانی توسط طراحی',
    description: 'امنیت، کنترل‌ها و قابل‌بازرسی‌بودن بخشی از بنیاد پلتفرم است.',
  },
  {
    icon: <Sparkles className="h-6 w-6" />,
    title: 'بهره‌وری رهبری‌شده توسط هوش',
    description: 'پشتیبانی عملی هوش مصنوعی برای تغییر عملیاتی، نه تنها نوآوری.',
  },
];

export default function ProductPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="پلتفرمی برای هوش تجاری سازمانی."
        description="آریا سازمان‌ها را قادر می‌سازد تا سیستم‌های موجود را متصل کنند، عملیات تجاری را خودکار کنند و بیشترین استفاده از هوش مصنوعی را داشته باشند بدون اختلال در آنچه که در حال حاضر کار می‌کند."
      >
        <div className="flex justify-center">
          <Link href="/request-demo" className="btn-primary">
            درخواست بررسی فنی
          </Link>
        </div>
      </HeroSection>

      <section className="section-shell">
        <div className="container-shell">
          <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
            <div>
              <div className="eyebrow mb-5">اصول پلتفرم</div>
              <h2 className="section-title">هوشی که با واقعیت سازمانی تطابق دارد</h2>
              <p className="mt-5 text-lg leading-8 text-muted-foreground">
                آریا برای پشتیبانی از نحوه‌ی عملکرد سازمان‌های بزرگ طراحی‌شده است: لایه‌ای، حاکم‌شده و متصل به فرآیندهای موجود.
              </p>
            </div>
            <div className="card-panel p-8 md:p-10">
              <div className="grid gap-4 md:grid-cols-2">
                {capabilities.map((item) => (
                  <div key={item.title} className="rounded-2xl border border-border/70 bg-surface p-5">
                    <div className="mb-3 inline-flex rounded-2xl bg-surface-muted p-3 text-primary">{item.icon}</div>
                    <h3 className="text-base font-semibold text-foreground">{item.title}</h3>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">{item.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-shell border-y border-border/70 bg-surface-muted/60">
        <div className="container-shell">
          <div className="card-panel p-8 md:p-12">
            <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr] lg:items-center">
              <div>
                <div className="eyebrow mb-5">برای سازمان‌های مدرن</div>
                <h2 className="section-title">ساخته‌شده برای پذیرش عملی</h2>
                <p className="mt-5 text-lg leading-8 text-muted-foreground">
                  چه هدف خودکارسازی فرآیند، دید‌پذیری داده‌ها یا پشتیبانی بهتر تصمیم باشد، آریا به‌عنوان پلتفرمی موضع‌گیری شده است که می‌تواند به‌طور مسئولانه ارزیابی، آزمایش و مقیاس شود.
                </p>
              </div>
              <div className="rounded-[1.5rem] border border-border/70 bg-surface p-8">
                <ul className="space-y-4 text-sm text-muted-foreground">
                  <li className="flex items-start gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /> سیستم‌های سازمانی موجود را بدون اجبار به بازنشانی کامل پلتفرم متصل کنید.</li>
                  <li className="flex items-start gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /> پشتیبانی هوش مصنوعی را در جایی که پیچیدگی عملیاتی بالا است، معرفی کنید.</li>
                  <li className="flex items-start gap-3"><span className="mt-1 h-2.5 w-2.5 rounded-full bg-primary" /> یک مسیر فنی و حکمرانی ایجاد کنید که با نیازهای سازمانی مطابقت دارد.</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Related Pages */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">کاوش بیشتر</h2>
          <div className="grid gap-6 md:grid-cols-3">
            {[
              {
                title: 'پلتفرم هوش مصنوعی',
                description: 'پلتفرم عملیاتی یکپارچه با عوامل، جریان‌های کاری و هوش.',
                href: '/ai-platform',
              },
              {
                title: 'عوامل هوش مصنوعی',
                description: 'عوامل خودمختار که تجارت شما را درک می‌کنند و تصمیمات را اجرا می‌کنند.',
                href: '/ai-agents',
              },
              {
                title: 'معماری و امنیت',
                description: 'طراحی سطح سازمانی برای حکمرانی و انطباق.',
                href: '/architecture',
              },
            ].map((item, index) => (
              <Link key={index} href={item.href} className="card-panel p-6 group transition hover:shadow-soft hover:-translate-y-1">
                <h3 className="text-lg font-semibold text-foreground group-hover:text-accent">{item.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>
                <div className="mt-4 text-accent font-medium text-sm">← بیشتر بیاموزید</div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <CTASection
        title="درک کنید که چگونه آریا می‌تواند با محیط شما تطابق داشته باشد."
        description="با یک گفتگوی متمرکز شروع کنید تا معماری، یکپارچگی و اولویت‌های عملیاتی را بررسی کنید."
        primaryButtonText="رزرو دموی محصول"
        primaryButtonHref="/request-demo"
        secondaryButtonText="تماس با تیم"
        secondaryButtonHref="/contact"
      />
    </PublicLayout>
  );
}
