import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, FeatureGrid, CTASection } from '@/components/sections/PageSections';
import {
  Plug,
  Code2,
  BookOpen,
  Zap,
  GitBranch,
  Users,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'یکپارچه‌سازی‌ها و توسعه‌دهندگان | آریا',
  description: 'اتصال به اکوسیستم شرکت شما: APIها، کانکتورها و ابزارهای توسعه برای یکپارچه‌سازی آسان.',
};

const integrationFeatures = [
  {
    icon: <Plug className="h-6 w-6" />,
    title: 'کانکتورهای آماده',
    description:
      'کانکتورهای آماده برای ERP، CRM، مالی و سیستم‌های گردش‌کار که در چند دقیقه مستقر می‌شوند.',
  },
  {
    icon: <Code2 className="h-6 w-6" />,
    title: 'APIهای REST و GraphQL',
    description:
      'APIهای جامع برای ساخت یکپارچه‌سازی‌های سفارشی و توسعهٔ قابلیت‌های آریا.',
  },
  {
    icon: <GitBranch className="h-6 w-6" />,
    title: 'پشتیبانی وبهوک',
    description:
      'رویدادهای بلادرنگ با تحویل قابل اطمینان، منطق تکرار و صف‌های خطا.',
  },
  {
    icon: <Zap className="h-6 w-6" />,
    title: 'کانکتورهای سفارشی',
    description:
      'با SDK کانکتور ما می‌توانید کانکتورهای سفارشی برای هر سیستم یا منبع داده بسازید.',
  },
  {
    icon: <BookOpen className="h-6 w-6" />,
    title: 'پرتال توسعه‌دهندگان',
    description:
      'مستندات کامل، کاوشگر API، نمونه‌های کد و SDKها برای زبان‌های اصلی.',
  },
  {
    icon: <Users className="h-6 w-6" />,
    title: 'جامعه توسعه‌دهندگان',
    description:
      'انجمن و منابع حمایتی برای کمک به توسعه‌دهندگان در ساخت روی آریا.',
  },
];

const systemConnectors = [
  { name: 'سیستم‌های ERP سازمانی', type: 'معماری' },
  { name: 'پلتفرم‌های CRM', type: 'معماری' },
  { name: 'سیستم‌های مالی و حسابداری', type: 'معماری' },
  { name: 'موتورهای گردش کار', type: 'معماری' },
  { name: 'انبارهای داده', type: 'معماری' },
  { name: 'پلتفرم‌های ارتباطی', type: 'معماری' },
  { name: 'ابزارهای مدیریت پروژه', type: 'معماری' },
  { name: 'سیستم‌های HCM و حقوق و دستمزد', type: 'معماری' },
  { name: 'پایگاه‌های داده و ذخیره‌سازها', type: 'معماری' },
  { name: 'برنامه‌های سفارشی', type: 'معماری' },
  { name: 'APIهای REST و GraphQL', type: 'معماری' },
  { name: 'سیستم‌های وبهوک و رویداد', type: 'معماری' },
];

const useCase = [
  {
    title: 'Webhook integrations',
    description:
      'Listen to events from Aria and trigger actions in external systems. Build reactive workflows.',
    examples: ['When an order is created, trigger fulfillment', 'When an agent makes a decision, log it to your data warehouse'],
  },
  {
    title: 'Custom API calls',
    description:
      'Call external APIs from within workflows. Fetch data, enrich records, trigger actions.',
    examples: ['Fetch credit data from third-party providers', 'Send notifications to custom systems'],
  },
  {
    title: 'Data synchronization',
    description:
      'Keep data synchronized between Aria and external systems. Scheduled or event-driven.',
    examples: ['Sync customer data from Salesforce to Aria daily', 'Keep inventory synchronized in real-time'],
  },
  {
    title: 'Agent orchestration',
    description:
      'Build agents that coordinate actions across multiple systems. No code required.',
    examples: ['Create order → Allocate inventory → Send notification', 'Update customer → Sync to CRM → Trigger marketing'],
  },
];

export default function IntegrationsPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="یکپارچه‌سازی‌ها و توسعه‌دهندگان"
        description="با کانکتورهای از پیش‌ساخته و APIهای کامل، به کل اکوسیستم کسب‌وکار خود متصل شوید."
      >
        <Link href="/request-demo" className="btn-primary">
          کاوش یکپارچه‌سازی‌ها
        </Link>
        <a href="#developer-section" className="btn-secondary">
          منابع توسعه‌دهندگان
        </a>
      </HeroSection>

      {/* Integration Features */}
      <section className="section-shell">
        <div className="container-shell">
          <div className="mb-14 max-w-3xl">
            <h2 className="section-title">قابلیت‌های یکپارچه‌سازی</h2>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">
              APIها، کانکتورها و ابزارهای توسعه‌ای که برای یکپارچه‌سازی بدون درز با سیستم‌های موجود طراحی شده‌اند.
            </p>
          </div>
          <FeatureGrid features={integrationFeatures} />
        </div>
      </section>

      {/* System Connectors */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14">معماری یکپارچه‌سازی</h2>
          <p className="mx-auto mb-14 max-w-3xl text-center text-muted-foreground">
            آریا برای اتصال به مجموعه‌ای گسترده از سیستم‌های سازمانی طراحی شده است. پلتفرم از هر سیستمی که از طریق API، وبهوک یا کانکتورهای سفارشی در دسترس باشد پشتیبانی می‌کند.
          </p>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {systemConnectors.map((system, index) => (
              <div key={index} className="card-panel p-4 flex items-center justify-between">
                <span className="font-medium text-foreground">{system.name}</span>
                <span className="text-xs font-semibold text-accent uppercase">{system.type}</span>
              </div>
            ))}
          </div>
          <div className="mt-12 text-center">
            <p className="text-muted-foreground">نیاز به یکپارچه‌سازی سفارشی دارید؟</p>
            <Link href="/request-demo" className="mt-3 inline-block text-accent hover:underline">
              معماری خود را بررسی کنید →
            </Link>
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">Integration patterns</h2>
          <div className="space-y-8">
            {useCase.map((pattern, index) => (
              <div key={index} className="card-panel p-8">
                <div className="flex items-start gap-6">
                  <span className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-accent/10 font-semibold text-accent flex-shrink-0">
                    {index + 1}
                  </span>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold text-foreground">{pattern.title}</h3>
                    <p className="mt-2 text-muted-foreground">{pattern.description}</p>
                    <ul className="mt-4 space-y-2">
                      {pattern.examples.map((example, i) => (
                        <li key={i} className="flex gap-3 text-sm text-muted-foreground">
                          <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent flex-shrink-0" />
                          {example}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Developer Resources */}
      <section id="developer-section" className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">منابع توسعه‌دهندگان</h2>
          <div className="grid gap-6 md:grid-cols-2">
            {[
              {
                title: 'مستندات API',
                description: 'مستندات کامل REST API با مثال‌های تعاملی و نمونه‌های کد.',
                link: '#',
              },
              {
                title: 'SDK و کتابخانه‌ها',
                description:
                  'SDKهای رسمی برای JavaScript، Python، Go، Java و .NET و کتابخانه‌های جامعه.',
                link: '#',
              },
              {
                title: 'Connector SDK',
                description:
                  'چارچوبی برای ساخت کانکتورهای سفارشی با قالب‌ها، مثال‌ها و ابزارهای تست.',
                link: '#',
              },
              {
                title: 'نمونه‌های کد',
                description:
                  'نمونه‌های واقعی از الگوهای یکپارچه‌سازی متداول؛ قابل دانلود و سفارشی‌سازی.',
                link: '#',
              },
              {
                title: 'بلاگ و آموزش‌ها',
                description:
                  'راهنماهای عمیق دربارهٔ الگوهای یکپارچه‌سازی، بهترین‌روش‌ها و تکنیک‌های پیشرفته.',
                link: '#',
              },
              {
                title: 'انجمن',
                description:
                  'کمک و راهنمایی از تیم فنی و جامعه توسعه‌دهندگان؛ پرسش و اشتراک‌گذاری راه‌حل‌ها.',
                link: '#',
              },
            ].map((resource, index) => (
              <a key={index} href={resource.link} className="card-panel p-6 group transition hover:shadow-soft hover:-translate-y-1">
                <h3 className="font-semibold text-foreground group-hover:text-accent">{resource.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{resource.description}</p>
                <div className="mt-4 text-accent font-medium text-sm">مشاهده</div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section className="section-shell">
        <div className="container-shell">
          <div className="mx-auto max-w-4xl">
            <div className="card-panel p-8 md:p-12 bg-gradient-to-r from-accent/5 to-transparent border border-accent/20">
              <h2 className="text-2xl font-semibold text-foreground">شروع در ۵ دقیقه</h2>
              <p className="mt-3 text-muted-foreground">
                راهنمای شروع سریع را دنبال کنید تا اولین سیستم خود را یکپارچه یا اولین وبهوک را بسازید.
              </p>
              <ol className="mt-8 space-y-4">
                {[
                  'ثبت‌نام برای حساب توسعه‌دهنده',
                  'ایجاد کلید API در کنسول توسعه‌دهنده',
                  'انتخاب یک کانکتور یا الگوی یکپارچه‌سازی',
                  'دنبال کردن راهنمای قدم‌به‌قدم راه‌اندازی',
                  'آزمایش در محیط آزمایشی و استقرار در تولید',
                ].map((step, index) => (
                  <li key={index} className="flex gap-4">
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-accent/20 text-accent font-semibold text-sm flex-shrink-0">
                      {index + 1}
                    </span>
                    <span className="text-muted-foreground pt-1">{step}</span>
                  </li>
                ))}
              </ol>
              <Link href="/request-demo" className="btn-primary mt-8">
                شروع به توسعه
              </Link>
            </div>
          </div>
        </div>
      </section>

      <CTASection
        title="برای یکپارچه‌سازی آماده‌اید؟"
        description="دسترسی API دریافت کنید و ساخت روی آریا را آغاز کنید."
        primaryButtonText="درخواست دسترسی توسعه‌دهنده"
        primaryButtonHref="/request-demo"
        secondaryButtonText="مطالعهٔ مستندات"
        secondaryButtonHref="/resources"
      />
    </PublicLayout>
  );
}
