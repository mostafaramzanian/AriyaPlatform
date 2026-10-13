import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, FeatureGrid, CTASection } from '@/components/sections/PageSections';
import {
  DatabaseZap,
  Workflow,
  BarChart3,
  Lock,
  Zap,
  Brain,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'پلتفرم هوش مصنوعی | آریا',
  description:
    'پلتفرم عملیاتی هوش مصنوعی یکپارچه برای عملیات سازمانی. سیستم‌ها را متصل کنید، عوامل را اجرا کنید، تصمیمات را بگیرید.',
};

const platformFeatures = [
  {
    icon: <DatabaseZap className="h-6 w-6" />,
    title: 'لایه داده یکپارچه',
    description:
      'ERP، CRM، اسناد و داده‌های عملیاتی را به یک پلتفرم هوشمند متصل کنید.',
  },
  {
    icon: <Workflow className="h-6 w-6" />,
    title: 'تنظیم عامل',
    description:
      'عوامل خودمختار را که جریان‌های کاری را اجرا می‌کنند و تصمیمات را کنترل می‌کنند، بسازید، استقرار کنید و مدیریت کنید.',
  },
  {
    icon: <BarChart3 className="h-6 w-6" />,
    title: 'هوش تصمیم‌گیری',
    description:
      'داده‌های پیچیده را به توصیه‌های واضح و قابل‌عمل برای عملیات و رهبری تبدیل کنید.',
  },
  {
    icon: <Lock className="h-6 w-6" />,
    title: 'امنیت سازمانی',
    description:
      'حکمرانی، قابل‌بازرسی‌بودن و انطباق درون‌ساخت برای سازمان‌های تنظیم‌شده.',
  },
  {
    icon: <Zap className="h-6 w-6" />,
    title: 'اجرای بلادرنگ',
    description:
      'جریان‌های کاری، تأیید‌ها و اقدامات عملیاتی را با کنترل‌های شفاف پردازش کنید.',
  },
  {
    icon: <Brain className="h-6 w-6" />,
    title: 'یادگیری متناسب',
    description:
      'عملیات را با حلقه‌های بازخورد و نظارت عملکرد مداوم بهبود بخشید.',
  },
];

const capabilities = [
  {
    title: 'عوامل عملیاتی',
    items: [
      'اجرای جریان کاری خودمختار',
      'مسیریابی تأیید هوشمند',
      'خودکارسازی فرآیند',
      'کنترل استثنایی',
    ],
  },
  {
    title: 'یکپارچگی داده‌ها',
    items: [
      'اتصال چند‌سیستمی',
      'همگام‌سازی داده‌های بلادرنگ',
      'اطمینان از کیفیت داده‌ها',
      'تجزیه‌وتحلیل حفاظت‌شده از حریم خصوصی',
    ],
  },
  {
    title: 'پشتیبانی تصمیم‌گیری',
    items: [
      'تجزیه‌وتحلیل پیش‌بینی‌کننده',
      'مدل‌سازی سناریو',
      'ارزیابی ریسک',
      'داشبورد‌های عملکرد',
    ],
  },
  {
    title: 'حکمرانی',
    items: [
      'سیاق‌های بازرسی',
      'اعمال سیاست',
      'خودکارسازی انطباق',
      'مدیریت تغییر',
    ],
  },
];

export default function AIPlatformPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="پلتفرم هوش مصنوعی"
        description="پلتفرم عملیاتی یکپارچه برای هوش مصنوعی سازمانی. سیستم‌ها را متصل کنید، عوامل را اجرا کنید، تصمیمات را رهبری کنید."
      >
        <Link href="/request-demo" className="btn-primary">
          آن را در عمل ببینید
        </Link>
        <Link href="/architecture" className="btn-secondary">
          معماری را بیاموزید
        </Link>
      </HeroSection>

      {/* Core Capabilities */}
      <section className="section-shell">
        <div className="container-shell">
          <div className="mb-14 max-w-3xl">
            <h2 className="section-title">توانایی‌های اصلی</h2>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">
              یک پلتفرم کامل برای ساخت، استقرار و مدیریت سیستم‌های هوش مصنوعی سازمانی بدون جایگزینی زیرساخت موجود.
            </p>
          </div>
          <FeatureGrid features={platformFeatures} />
        </div>
      </section>

      {/* Capability Deep Dive */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14">آنچه شما می‌توانید بسازید</h2>
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
            {capabilities.map((capability, index) => (
              <div key={index} className="card-panel p-6">
                <h3 className="font-semibold text-foreground">{capability.title}</h3>
                <ul className="mt-5 space-y-3">
                  {capability.items.map((item, i) => (
                    <li key={i} className="flex gap-3 text-sm text-muted-foreground">
                      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent flex-shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">ساخت با آریا</h2>
          <div className="mx-auto max-w-4xl">
            <div className="space-y-8">
              {[
                {
                  step: '۱',
                  title: 'عملیات خود را تعریف کنید',
                  description:
                    'فرآیندهای تجاری و سیستم‌های مورد نظر برای بهبود یا خودکارسازی را نقشه‌کشی کنید.',
                },
                {
                  step: '۲',
                  title: 'سیستم‌ها را متصل کنید',
                  description:
                    'آریا را با سیستم‌های ERP، CRM و عملیاتی موجود خود یکپارچه کنید.',
                },
                {
                  step: '۳',
                  title: 'جریان‌های کاری و عوامل را طراحی کنید',
                  description:
                    'منطق عملیاتی، قوانین و رفتار خودمختار مورد نظر را تعریف کنید.',
                },
                {
                  step: '۴',
                  title: 'با حکمرانی استقرار کنید',
                  description:
                    'توانایی‌ها را با سیاق‌های بازرسی، تأیید‌ها و کنترل‌های موجود استقرار کنید.',
                },
              ].map((step) => (
                <div key={step.step} className="flex gap-6 md:gap-8">
                  <div className="flex-shrink-0">
                    <span className="inline-flex items-center justify-center w-16 h-16 rounded-lg bg-accent/10 text-lg font-bold text-accent">
                      {step.step}
                    </span>
                  </div>
                  <div className="flex-1 pt-2">
                    <h3 className="text-lg font-semibold text-foreground">{step.title}</h3>
                    <p className="mt-2 text-muted-foreground">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">موارد استفاده معمول</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: 'خودکارسازی سفارش تا پرداخت',
                description:
                  'پردازش سفارش، بررسی‌های اعتباری و جمع‌آوری پرداخت را در سراسر سیستم‌ها خودکار کنید.',
              },
              {
                title: 'هوش خریداری',
                description:
                  'ارزیابی هوشمند تأمین‌کننده، مسیریابی تأیید و انطباق قرارداد.',
              },
              {
                title: 'خودکارسازی بسته‌بندی مالی',
                description:
                  'تطبیق خودمختار، محاسبه تعهدات و گزارش‌گری انطباق.',
              },
              {
                title: 'عملیات مشتری',
                description:
                  'پلتفرم داده‌های متوحد مشتری با جریان‌های کاری پشتیبانی و فروش اضافی خودکار.',
              },
              {
                title: 'بهینه‌سازی زنجیره تأمین',
                description:
                  'پیش‌بینی تقاضا، مدیریت موجودی و هماهنگی تأمین‌کننده.',
              },
              {
                title: 'ریسک و انطباق',
                description:
                  'نظارت مداوم، اعمال سیاست و خودکارسازی سیاق‌های بازرسی.',
              },
            ].map((useCase, index) => (
              <div key={index} className="card-panel p-6">
                <h3 className="font-semibold text-foreground">{useCase.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{useCase.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <CTASection
        title="برای تبدیل عملیات خود آماده؟"
        description="کاوش کنید که چگونه آریا می‌تواند سازمان شما را هوشمندانه‌تر کند."
        primaryButtonText="رزرو دموی محصول"
        primaryButtonHref="/request-demo"
        secondaryButtonText="نمایش معماری"
        secondaryButtonHref="/architecture"
      />
    </PublicLayout>
  );
}
