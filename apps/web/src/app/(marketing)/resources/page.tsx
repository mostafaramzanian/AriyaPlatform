import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, CTASection } from '@/components/sections/PageSections';
import {
  FileText,
  BookOpen,
  Video,
  Code2,
  Download,
  Users,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'منابع | آریا',
  description:
    'مستندات، راهنماها، مطالعات موردی و وبینارها برای کمک به شما در استفادهٔ کامل از آریا.',
};

const resourceCategories = [
  {
    icon: <FileText className="h-6 w-6" />,
    title: 'مستندات',
    description: 'راهنماهای پلتفرم و مستندات مرجع فنی.',
    count: 'به‌زودی',
    link: '#',
  },
  {
    icon: <BookOpen className="h-6 w-6" />,
    title: 'راهنماها',
    description: 'راهنماهای گام‌به‌گام برای پیاده‌سازی و یکپارچه‌سازی.',
    count: 'به‌زودی',
    link: '#',
  },
  {
    icon: <Video className="h-6 w-6" />,
    title: 'وبینارها',
    description: 'نشست‌های زنده دربارهٔ استفاده از پلتفرم و بهترین روش‌ها.',
    count: 'به‌زودی',
    link: '#',
  },
  {
    icon: <Code2 className="h-6 w-6" />,
    title: 'مرجع API',
    description: 'مستندات REST API کامل و مثال‌های کد.',
    count: 'به‌زودی',
    link: '#',
  },
  {
    icon: <Download className="h-6 w-6" />,
    title: 'راهنمای معماری',
    description: 'بررسی عمیق معماری آریا و گزینه‌های استقرار.',
    count: 'به‌زودی',
    link: '#',
  },
  {
    icon: <Users className="h-6 w-6" />,
    title: 'پشتیبانی',
    description: 'دسترسی مستقیم به تیم آریا برای سوالات فنی.',
    count: 'فعال',
    link: '#',
  },
];

const featuredResources = [
  {
    type: 'شروع سریع',
    title: 'نمای کلی پلتفرم آریا',
    description: 'معماری آریا و نحوه شروع کار را درک کنید.',
    tags: ['پلتفرم', 'مقدمه'],
  },
  {
    type: 'فنی',
    title: 'احراز هویت API',
    description: 'الگوهای امنیتی و احراز هویت برای API آریا.',
    tags: ['API', 'امنیت'],
  },
  {
    type: 'راهنما',
    title: 'الگوهای یکپارچه‌سازی',
    description: 'الگوهای رایج برای اتصال سیستم‌های سازمانی.',
    tags: ['یکپارچگی', 'معماری'],
  },
  {
    type: 'مرجع',
    title: 'گزینه‌های استقرار',
    description: 'Cloud SaaS، فضای ابری خصوصی، و استقرار محلی.',
    tags: ['استقرار', 'زیرساخت'],
  },
  {
    type: 'مفاهیم',
    title: 'عامل‌ها و جریان‌های کاری',
    description: 'طراحی و استقرار عامل‌های خودکار در آریا.',
    tags: ['عامل‌ها', 'معماری'],
  },
  {
    type: 'بهترین روش‌ها',
    title: 'حاکمیت سازمانی',
    description: 'الگوهای حاکمیت برای استقرار هوش سازمانی.',
    tags: ['حاکمیت', 'امنیت'],
  },
];

const learningPaths = [
  {
    title: 'مبانی پلتفرم',
    duration: 'خودگردان',
    level: 'مبتدی',
    modules: [
      'آریا چیست؟',
      'معماری اصلی',
      'مفاهیم یکپارچه‌سازی',
      'مدل حاکمیت',
    ],
  },
  {
    title: 'ساخت با آریا',
    duration: 'خودگردان',
    level: 'متوسط',
    modules: [
      'طراحی عامل',
      'تعریف جریان کاری',
      'یکپارچه‌سازی سیستم',
      'الگوهای استقرار',
    ],
  },
  {
    title: 'استقرار سازمانی',
    duration: 'خودگردان',
    level: 'پیشرفته',
    modules: [
      'گزینه‌های معماری',
      'پیکربندی امنیت',
      'چارچوب انطباق',
      'برتری عملیاتی',
    ],
  },
];

export default function ResourcesPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="منابع و آموزش"
        description="هر آنچه برای تسلط بر آریا نیاز دارید: مستندات، آموزش‌ها، وبینارها و پشتیبانی جامعهٔ کاربری."
      >
        <Link href="/request-demo" className="btn-primary">
          درخواست دسترسی
        </Link>
        <a href="#categories" className="btn-secondary">
          مرور منابع
        </a>
      </HeroSection>

      {/* Resource Categories */}
      <section id="categories" className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14">مرور منابع</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {resourceCategories.map((category, index) => (
              <a key={index} href={category.link} className="card-panel p-6 group transition hover:shadow-soft hover:-translate-y-1">
                <div className="inline-flex rounded-lg bg-accent/10 p-3 text-accent mb-4">
                  {category.icon}
                </div>
                <h3 className="text-lg font-semibold text-foreground group-hover:text-accent">{category.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{category.description}</p>
                <div className="mt-4 flex items-center justify-between">
                  <span className="text-xs font-semibold text-accent">{category.count}</span>
                  <span className="text-accent group-hover:translate-x-1 transition">→</span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Learning Paths */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">Structured learning paths</h2>
          <p className="mx-auto mb-14 max-w-3xl text-center text-muted-foreground">
            Choose your path: from platform fundamentals to advanced enterprise deployment.
          </p>
          <div className="grid gap-6 md:grid-cols-3">
            {learningPaths.map((path, index) => (
              <div key={index} className="card-panel p-8">
                <div className="flex items-start justify-between mb-4">
                  <h3 className="text-lg font-semibold text-foreground flex-1">{path.title}</h3>
                  <span className="text-xs font-semibold text-accent bg-accent/10 px-2 py-1 rounded">
                    {path.level}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mb-4">{path.duration}</p>
                <ol className="space-y-3">
                  {path.modules.map((module, i) => (
                    <li key={i} className="flex gap-3 text-sm">
                      <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-accent/10 text-accent text-xs font-semibold flex-shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-muted-foreground pt-0.5">{module}</span>
                    </li>
                  ))}
                </ol>
                <button className="btn-secondary w-full mt-8">شروع آموزش</button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Resources */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14">منابع برجسته</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {featuredResources.map((resource, index) => (
              <a
                key={index}
                href="#"
                className="card-panel p-6 group transition hover:shadow-soft hover:-translate-y-1 flex flex-col"
              >
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-xs font-semibold text-accent uppercase">{resource.type}</span>
                </div>
                <h3 className="text-lg font-semibold text-foreground group-hover:text-accent mb-2">
                  {resource.title}
                </h3>
                <p className="text-sm text-muted-foreground flex-1">{resource.description}</p>
                <div className="flex gap-2 mt-6 flex-wrap">
                  {resource.tags.map((tag, i) => (
                    <span key={i} className="text-xs px-2 py-1 rounded bg-surface text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">Frequently asked questions</h2>
          <div className="mx-auto max-w-3xl space-y-4">
            {[
              {
                q: 'استقرار آریا چقدر طول می‌کشد؟',
                a: 'استقرار معمولی بسته به زیرساخت و نیازهای سفارشی‌سازی شما ۲ تا ۴ هفته طول می‌کشد. ما یک رویکرد استقرار مرحله‌ای ارائه می‌دهیم.',
              },
              {
                q: 'آریا با چه سیستم‌هایی قابل یکپارچه‌سازی است؟',
                a: 'ما بیش از ۵۰ اتصال از پیش‌ساخته داریم و از یکپارچه‌سازی‌های سفارشی از طریق API پشتیبانی می‌کنیم. برای سازگاری خاص سیستم با ما تماس بگیرید.',
              },
              {
                q: 'آیا آریا با مقررات ما سازگار است؟',
                a: 'آریا از چارچوب‌هایی مانند SOC2، HIPAA، GDPR، FedRAMP و دیگرها پشتیبانی می‌کند. ما می‌توانیم به شما در ارزیابی انطباق کمک کنیم.',
              },
              {
                q: 'آیا می‌توانیم آریا را در محل اجرا کنیم؟',
                a: 'بله. آریا از استقرار به‌صورت Cloud SaaS، فضای ابری خصوصی و استقرار محلی پشتیبانی می‌کند تا با نیازهای زیرساخت شما سازگار باشد.',
              },
              {
                q: 'چه آموزش‌هایی ارائه می‌دهید؟',
                a: 'ما آموزش‌های راه‌اندازی، پشتیبانی فنی مستمر و منابع یادگیری جامعه را برای همه مشتریان ارائه می‌کنیم.',
              },
            ].map((faq, index) => (
              <details key={index} className="card-panel p-6 group">
                <summary className="font-semibold cursor-pointer flex justify-between items-center text-foreground">
                  {faq.q}
                  <span className="group-open:rotate-180 transition-transform duration-200">→</span>
                </summary>
                <p className="mt-4 text-muted-foreground text-sm">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Support Section */}
      <section className="section-shell">
        <div className="container-shell">
          <div className="mx-auto max-w-4xl">
            <div className="card-panel p-8 md:p-12">
              <h2 className="text-2xl font-semibold text-foreground">Need more help?</h2>
              <p className="mt-3 text-muted-foreground">
                Our support team is here to help. Choose the option that works best for you.
              </p>
              <div className="mt-8 grid gap-6 md:grid-cols-3">
                {[
                  {
                      title: 'مستندات',
                      description: 'مرور مستندات کامل ما',
                    icon: '📚',
                  },
                  {
                      title: 'پشتیبانی ایمیلی',
                    description: 'support@aria.ai',
                    icon: '✉️',
                  },
                  {
                      title: 'گفتگو با فروش',
                      description: 'صحبت با یکی از اعضای تیم',
                    icon: '💬',
                  },
                ].map((option, index) => (
                  <div key={index} className="text-center">
                    <div className="text-3xl mb-3">{option.icon}</div>
                    <h3 className="font-semibold text-foreground">{option.title}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{option.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <CTASection
        title="آماده برای کسب اطلاعات بیشتر؟"
        description="به کتابخانهٔ کامل منابع ما دسترسی پیدا کنید و با آریا شروع کنید."
        primaryButtonText="شروع کنید"
        primaryButtonHref="/request-demo"
        secondaryButtonText="مشاهدهٔ مستندات"
        secondaryButtonHref="#"
      />
    </PublicLayout>
  );
}
