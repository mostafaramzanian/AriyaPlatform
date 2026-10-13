import type { Metadata } from 'next';
import { Header } from '@/components/common/Header';
import { Footer } from '@/components/common/Footer';
import { CTASection } from '@/components/sections/PageSections';
import AriaHero from '@/components/sections/AriaHero';
import { Blocks, BrainCircuit, ShieldCheck, Sparkles, Workflow, DatabaseZap } from 'lucide-react';

export const metadata: Metadata = {
  title: 'آریا | پلتفرم هوش سازمانی',
  description:
    'آریا یک پلتفرم هوش سازمانی است که برای اتصال سیستم‌های موجود، جریان‌های کاری و داده‌ها به خودکارسازی قابل اعتماد و پشتیبانی تصمیم‌گیری ساخته شده است.',
};

const platformPillars = [
  {
    icon: <Blocks className="h-6 w-6" />,
    title: 'یکپارچه‌سازی سیستم‌ها',
    description: 'پلتفرم آریا، CRM و داده‌های سازمان را بدون نیاز به جایگزینی گسترده یکپارچه می‌کند.',
  },
  {
    icon: <BrainCircuit className="h-6 w-6" />,
    title: 'خودکارسازیِ فرایندها',
    description: 'عامل‌های عملیاتی فرایندها را اجرا و نتایج را قابل بازبینی می‌کنند.',
  },
  {
    icon: <ShieldCheck className="h-6 w-6" />,
    title: 'حاکمیت سازمانی',
    description: 'قابلیت بازبینی، کنترل نقش‌ها و الگوهای استقرارِ متناسب با نیازهای سازمان.',
  },
];

const capabilities = [
  {
    icon: <DatabaseZap className="h-6 w-6" />,
    title: 'لایهٔ یکپارچهٔ داده',
    description: 'ERP، اسناد و داده‌های عملیاتی را در یک لایهٔ قابل پرس‌وجو قرار می‌دهد.',
  },
  {
    icon: <Workflow className="h-6 w-6" />,
    title: 'اجرای مبتنی بر عامل',
    description: 'عامل‌ها فرایندها را اجرا می‌کنند در حالی که کنترل و گزارش‌پذیری حفظ می‌شود.',
  },
  {
    icon: <Sparkles className="h-6 w-6" />,
    title: 'پشتیبانی تصمیم',
    description: 'اطلاعات پیچیده را به راهنمایی‌های عملی برای عملیات و رهبری تبدیل می‌کند.',
  },
];

export default function Home() {
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-1">
        <>
          <AriaHero />

          <section className="section-shell">
            <div className="container-shell">
              <div className="mx-auto max-w-3xl text-center">
                              <div className="eyebrow mb-5">چرا آریا</div>
                              <h2 className="section-title">یک لایهٔ عملیاتی برای سازمان‌ها</h2>
                <p className="mt-5 text-lg leading-8 text-muted-foreground">
                                بسیاری از سیستم‌ها پراکنده‌اند. آریا داده، دانش و اجرا را در یک مسیر عملیاتی می‌نشاند.
                </p>
              </div>
              <div className="mt-12 grid gap-6 lg:grid-cols-3">
                {platformPillars.map((pillar) => (
                  <div key={pillar.title} className="card-panel p-8">
                    <div className="mb-5 inline-flex rounded-2xl bg-surface-muted p-3 text-primary">{pillar.icon}</div>
                    <h3 className="text-lg font-semibold text-foreground">{pillar.title}</h3>
                    <p className="mt-3 text-sm leading-7 text-muted-foreground">{pillar.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="section-shell border-y border-border/70 bg-surface-muted/60">
            <div className="container-shell">
              <div className="grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
                <div>
                  <div className="eyebrow mb-5">معرفی پلتفرم</div>
                                    <h2 className="section-title">پشتیبان سازمان، نه جایگزین آن</h2>
                  <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                                      آریا راهی عملی برای شتاب‌بخشی به عملیات فراهم می‌کند در حالی که سیستم‌ها و کنترل‌های موجود حفظ می‌شود.
                  </p>
                </div>
                <div className="card-panel p-8 md:p-10">
                  <div className="grid gap-4 md:grid-cols-2">
                    {capabilities.map((capability) => (
                      <div key={capability.title} className="rounded-2xl border border-border/70 bg-surface p-5">
                        <div className="mb-3 inline-flex rounded-2xl bg-surface-muted p-3 text-primary">{capability.icon}</div>
                        <h3 className="text-base font-semibold text-foreground">{capability.title}</h3>
                        <p className="mt-2 text-sm leading-7 text-muted-foreground">{capability.description}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="section-shell">
            <div className="container-shell">
              <div className="mx-auto max-w-3xl text-center">
                              <div className="eyebrow mb-5">آمادگی سازمانی</div>
                              <h2 className="section-title">قابل بررسی و مناسب مقیاس سازمانی</h2>
                <p className="mt-5 text-lg leading-8 text-muted-foreground">
                                از شفافیت معماری تا گزینه‌های استقرار؛ آریا برای گفتگوهای جدیِ سازمانی طراحی شده است.
                </p>
              </div>
              <div className="mt-12 grid gap-6 md:grid-cols-3">
                {[
                                  ['معماری', 'ساختار شفاف پلتفرم برای ارزیابی فنی و برنامه‌ریزی.'],
                                  ['امنیت', 'حاکمیت، کنترل‌ها و الگوهای استقرار مطمئن.'],
                                  ['یکپارچگی', 'ارتباط و هم‌آهنگی با سیستم‌های موجود سازمان.'],
                ].map(([title, description]) => (
                  <div key={title} className="card-panel p-8">
                    <h3 className="text-lg font-semibold text-foreground">{title}</h3>
                    <p className="mt-3 text-sm leading-7 text-muted-foreground">{description}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <CTASection
                      title="مشاهدهٔ تناسب آریا با سازمان شما"
                      description="درخواست یک دموی سازمانیِ سفارشی و آغاز گفتگو دربارهٔ معماری، عملیات و آماده‌سازی فنی."
                      primaryButtonText="درخواست دموی سازمانی"
            primaryButtonHref="/request-demo"
                      secondaryButtonText="تماس با تیم"
            secondaryButtonHref="/contact"
          />
        </>
      </main>
      <Footer />
    </div>
  );
}
