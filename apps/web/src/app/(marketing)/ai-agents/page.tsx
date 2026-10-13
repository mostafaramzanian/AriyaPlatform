import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, FeatureGrid, CTASection } from '@/components/sections/PageSections';
import {
  Zap,
  Shield,
  Gauge,
  MessageSquare,
  GitBranch,
  BarChart3,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'عامل‌های هوشمند | آریا',
  description: 'عامل‌های خودکار که منطق کسب‌وکار شما را درک می‌کنند، گردش کار را اجرا می‌کنند و از نتایج می‌آموزند.',
};

const agentCapabilities = [
  {
    icon: <Zap className="h-6 w-6" />,
    title: 'Autonomous execution',
    description:
      'Agents operate independently, handling workflows without manual intervention or human approval at each step.',
  },
  {
    icon: <Shield className="h-6 w-6" />,
    title: 'Business logic embedded',
    description:
      'Encode your policies, rules, and decision frameworks directly into agent behavior.',
  },
  {
    icon: <Gauge className="h-6 w-6" />,
    title: 'Measurable outcomes',
    description:
      'Track agent performance, cost savings, and operational improvements with built-in analytics.',
  },
  {
    icon: <MessageSquare className="h-6 w-6" />,
    title: 'Transparent reasoning',
    description:
      'Understand why agents make decisions with audit trails and explainability built-in.',
  },
  {
    icon: <GitBranch className="h-6 w-6" />,
    title: 'Multi-system orchestration',
    description:
      'Coordinate actions across ERP, CRM, workflow engines, and custom applications.',
  },
  {
    icon: <BarChart3 className="h-6 w-6" />,
    title: 'Continuous learning',
    description:
      'Improve agent performance through feedback loops and outcome analysis.',
  },
];

const agentTypes = [
  {
    title: 'عامل‌های گردش کار',
    description: 'خودکارسازی فرایندهای تکراری در سراسر سیستم‌ها',
    capabilities: [
      'مسیر‌دهی درخواست و مدیریت استثنا',
      'ارکستراسیون چندمرحله‌ای',
      'مدیریت استثناها',
      'مدیریت SLA',
    ],
  },
  {
    title: 'عامل‌های تصمیم‌گیر',
    description: 'تصمیم‌گیری مبتنی بر داده و سیاست‌ها',
    capabilities: [
      'ارزیابی مبتنی بر قوانین',
      'امتیازدهی ریسک',
      'مسیر‌دهی تصویب',
      'تولید پیشنهاد',
    ],
  },
  {
    title: 'عامل‌های تحلیلی',
    description: 'استخراج بینش و تولید گزارش',
    capabilities: [
      'تجمیع داده',
      'کشف الگوها',
      'شناسایی ناهنجاری',
      'تولید گزارش',
    ],
  },
  {
    title: 'عامل‌های یکپارچه‌سازی',
    description: 'همگام‌سازی سیستم‌ها و حفظ کیفیت داده',
    capabilities: [
      'همگام‌سازی بلادرنگ',
      'اعتبارسنجی داده',
      'حل تعارض داده',
      'تطبیق و آشتی',
    ],
  },
];

export default function AIAgentsPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="عامل‌های هوشمند"
        description="عامل‌های خودکار که گردش کار را اجرا کرده، تصمیم‌ها را مطابق سیاست‌ها می‌سازند و به‌صورت پیوسته بهبود می‌یابند."
      >
        <Link href="/request-demo" className="btn-primary">
          مشاهده در عمل
        </Link>
        <Link href="/ai-platform" className="btn-secondary">
          کاوش پلتفرم
        </Link>
      </HeroSection>

      {/* What are agents */}
      <section className="section-shell">
        <div className="container-shell">
          <div className="mx-auto max-w-4xl">
            <div className="card-panel p-8 md:p-12">
              <h2 className="text-2xl font-semibold text-foreground">عامل‌های آریا چه هستند؟</h2>
              <p className="mt-4 text-muted-foreground">
                عامل‌ها موجودیت‌های نرم‌افزاری خودکار هستند که در پلتفرم آریا اجرا می‌شوند تا گردش کارهای کسب‌وکار را اجرا کنند، تصمیم‌گیری نمایند و اقدامات را در سیستم‌های مختلف هماهنگ کنند. آن‌ها منطق کسب‌وکار شما را می‌آموزند و در چارچوب حاکمیت سازمانی عمل می‌کنند.
              </p>
              <p className="mt-4 text-muted-foreground">
                در مقایسه با ربات‌های سنتی یا RPA، عامل‌های آریا هوشمند، قابل تطبیق و مناسب مدیریت فرایندهای پیچیده چندمرحله‌ای با نیاز به قضاوت انسانی می‌باشند.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <div className="mb-14 max-w-3xl">
            <h2 className="section-title">توانایی‌های عامل‌ها</h2>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">
              هر عامل بر پایهٔ خودمختاری هوشمند، شفافیت و نتایج قابل اندازه‌گیری ساخته شده است.
            </p>
          </div>
          <FeatureGrid features={agentCapabilities} />
        </div>
      </section>

      {/* Types of Agents */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14">انواع عامل‌ها</h2>
          <div className="grid gap-6 md:grid-cols-2">
            {agentTypes.map((agent, index) => (
              <div key={index} className="card-panel p-8">
                <h3 className="text-lg font-semibold text-foreground">{agent.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{agent.description}</p>
                <ul className="mt-6 space-y-3">
                  {agent.capabilities.map((cap, i) => (
                    <li key={i} className="flex gap-3 text-sm text-muted-foreground">
                      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent flex-shrink-0" />
                      {cap}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agent Lifecycle */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">Agent lifecycle</h2>
          <div className="mx-auto max-w-4xl">
            <div className="space-y-8">
              {[
                {
                  step: 'طراحی',
                  description:
                    'رفتار عامل، قوانین و منطق تصمیم‌گیری را تعریف کنید و با داده‌های تاریخی تست کنید.',
                },
                {
                  step: 'استقرار',
                  description:
                    'عامل‌ها را با کنترل‌های حاکمیتی، دروازه‌های تصویب و ثبت لاگ وارد محیط تولید کنید.',
                },
                {
                  step: 'نظارت',
                  description:
                    'عملکرد عامل، تأثیر هزینه و نتایج عملیاتی را در زمان واقعی پیگیری کنید.',
                },
                {
                  step: 'یادگیری',
                  description:
                    'بازخورد جمع‌آوری کنید، خطاها را تحلیل کنید و رفتار عامل را پیوسته بهبود دهید.',
                },
              ].map((phase, index) => (
                <div key={index} className="flex gap-6">
                  <div className="flex-shrink-0">
                    <span className="inline-flex items-center justify-center w-12 h-12 rounded-lg bg-accent/10 font-semibold text-accent">
                      {index + 1}
                    </span>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-foreground">{phase.step}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{phase.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Use Cases */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">What agents can do for you</h2>
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[
              {
                title: 'Automate approval chains',
                description:
                  'Route requests intelligently, validate against policies, and execute approvals at scale.',
              },
              {
                title: 'Process orders end-to-end',
                description:
                  'From order receipt through fulfillment, manage the entire order lifecycle autonomously.',
              },
              {
                title: 'Manage exceptions',
                description:
                  'Identify, escalate, and resolve unusual cases without manual intervention.',
              },
              {
                title: 'Keep data clean',
                description:
                  'Validate, deduplicate, and synchronize data across systems continuously.',
              },
              {
                title: 'Generate recommendations',
                description:
                  'Analyze data and provide actionable guidance to operations and leadership.',
              },
              {
                title: 'Enforce compliance',
                description:
                  'Continuously monitor operations against policies, regulations, and internal controls.',
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
        title="استقرار اولین عامل"
        description="با یک گردش کار شروع کنید و با مشاهده نتایج به تدریج گسترش دهید."
        primaryButtonText="رزرو دموی سازمانی"
        primaryButtonHref="/request-demo"
        secondaryButtonText="مشاهدهٔ مستندات"
        secondaryButtonHref="/resources"
      />
    </PublicLayout>
  );
}
