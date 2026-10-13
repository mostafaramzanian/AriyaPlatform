import type { Metadata } from 'next';
import Link from 'next/link';
import { HeroSection, CTASection } from '@/components/sections/PageSections';
import { Blocks, BrainCircuit, ShieldCheck, Sparkles, Workflow, DatabaseZap } from 'lucide-react';

export const metadata: Metadata = {
  title: 'آریا | پلتفرم هوش سازمانی',
  description:
    'آریا یک پلتفرم هوش سازمانی است که برای اتصال سیستم‌های موجود، جریان‌های کاری و داده‌ها به خودکارسازی قابل اعتماد و پشتیبانی تصمیم‌گیری ساخته شده است.',
};

const platformPillars = [
  {
    icon: <Blocks className="h-6 w-6" />,
    title: 'با سیستم‌های شما کار می‌کند',
    description: 'پلتفرم آریا، CRM، جریان‌های کاری و داده‌ها را بدون اجبار به یک چرخه جایگزینی مختل‌کننده متصل می‌کند.',
  },
  {
    icon: <BrainCircuit className="h-6 w-6" />,
    title: 'عملیات را با هوش تبدیل می‌کند',
    description: 'عامل‌های عملیاتی و جریان‌های کاری هوش‌مند، فرایندهای پراکنده را به نتایجی هوشمند، قابل‌اندازه‌گیری تبدیل می‌کنند.',
  },
  {
    icon: <ShieldCheck className="h-6 w-6" />,
    title: 'برای اعتماد سازمانی ساخته شده',
    description: 'حاکمیت، قابلیت بازبینی و انعطاف‌پذیری استقرار، سازمان‌ها را کمک می‌کند با اطمینان حرکت کنند.',
  },
];

const capabilities = [
  {
    icon: <DatabaseZap className="h-6 w-6" />,
    title: 'لایه داده یکپارچه',
    description: 'ERP، اسناد و داده‌های عملیاتی را در یک لایه هوش منسجم جمع‌آوری کنید.',
  },
  {
    icon: <Workflow className="h-6 w-6" />,
    title: 'اجرای عامل‌محور',
    description: 'جریان‌های کاری، تصویب‌ها و عملیات‌های عملیاتی را با کنترل‌های شفاف ارکستر کنید.',
  },
  {
    icon: <Sparkles className="h-6 w-6" />,
    title: 'پشتیبانی تصمیم‌گیری',
    description: 'اطلاعات پیچیده را به راهنمایی واضح، قابل اجرا برای عملیات و رهبری تبدیل کنید.',
  },
];

export default function MarketingPage() {
  return (
    <>
      <HeroSection
        title="با هوش قابل اعتماد عملکرد کنید."
        description="آریا یک پلتفرم هوش سازمانی است که سیستم‌های موجود، داده‌ها و جریان‌های کاری را به یک مدل عملیاتی هوشمندتر متصل می‌کند."
      >
        <div className="flex flex-col justify-center gap-4 sm:flex-row">
          <Link href="/request-demo" className="btn-primary">
            رزرو دموی سازمانی
          </Link>
          <Link href="/product" className="btn-secondary">
            کاوش پلتفرم
          </Link>
        </div>
      </HeroSection>

      <section className="section-shell">
        <div className="container-shell">
          <div className="mx-auto max-w-3xl text-center">
            <div className="eyebrow mb-5">چرا آریا</div>
            <h2 className="section-title">یک لایه هوش جدید برای عملیات سازمانی</h2>
            <p className="mt-5 text-lg leading-8 text-muted-foreground">
              سیستم‌های ERP و جریان کاری سنتی هنوز جزیره‌ای هستند. آریا ساختار، هوش و اجرا را در یک لایه عملیاتی قابل اعتماد یکپارچه می‌کند.
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
              <div className="eyebrow mb-5">نمای کلی پلتفرم</div>
              <h2 className="section-title">ساخته شده برای پشتیبانی از سازمان، نه جایگزینی آن.</h2>
              <p className="mt-5 max-w-2xl text-lg leading-8 text-muted-foreground">
                آریا به سازمان‌ها یک مسیر عملی برای شتاب‌گیری عملیات با هوش می‌دهد در حالی که سیستم‌های موجود، کنترل‌ها و مسئولیت‌ها را دست نخورده نگاه می‌دارد.
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
            <h2 className="section-title">برای ارزیابی جدی و تصویب عملی طراحی شده</h2>
            <p className="mt-5 text-lg leading-8 text-muted-foreground">
              از وضوح معماری تا انعطاف‌پذیری استقرار، آریا به عنوان یک پلتفرم برای گفتگوهای سازمانی جدی موضع گرفته است.
            </p>
          </div>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {[
              ['معماری', 'ساختار پلتفرم شفاف برای ارزیابی فنی و برنامه‌ریزی.'],
              ['امنیت', 'حاکمیت، کنترل‌ها و الگوهای استقرار قابل اعتماد.'],
              ['یکپارچگی', 'اتصالات سیستم‌های سازمانی موجود و لایه‌ها.'],
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
        title="مشاهدهٔ نحوهٔ تناسب آریا با سازمان شما"
        description="یک دموی سفارشی درخواست کنید و یک گفتگوی عملی درباره معماری، عملیات و فعال‌سازی هوش شروع کنید."
        primaryButtonText="رزرو دموی سازمانی"
        primaryButtonHref="/request-demo"
        secondaryButtonText="تماس با تیم"
        secondaryButtonHref="/contact"
      />
    </>
  );
}
