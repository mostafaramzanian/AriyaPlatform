import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection, FeatureGrid, CTASection } from '@/components/sections/PageSections';
import {
  Lock,
  Shield,
  Eye,
  FileText,
  Network,
  CheckCircle2,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'معماری و امنیت | آریا',
  description:
    'معماری سطح سازمانی ساخته‌شده برای امنیت، انطباق و کنترل عملیاتی.',
};

const architectureFeatures = [
  {
    icon: <Network className="h-6 w-6" />,
    title: 'معماری توزیع‌شده',
    description:
      'طراحی خدمات ریز فعال می‌سازد مقیاس‌گذاری افقی، ایزولاسیون خرابی و استقرار مستقل.',
  },
  {
    icon: <Lock className="h-6 w-6" />,
    title: 'امنیت بدون اعتماد',
    description:
      'هر درخواست تأیید‌شده است، هر دسترسی ثبت‌شده است. بدون اعتماد ضمنی درون یا میان سیستم‌ها.',
  },
  {
    icon: <Shield className="h-6 w-6" />,
    title: 'ایزولاسیون داده‌ها',
    description:
      'معماری چند‌سازمانی با تضمین‌های ایزولاسیون قوی برای حریم خصوصی و انطباق.',
  },
  {
    icon: <Eye className="h-6 w-6" />,
    title: 'قابل‌بازرسی‌بودن کامل',
    description:
      'هر اقدام با متن‌ثبت‌شده است، تمکین‌دهندگی، تحقیقات و مسئولیت‌پذیری را فعال می‌سازد.',
  },
  {
    icon: <FileText className="h-6 w-6" />,
    title: 'انطباق درون‌ساخت',
    description:
      'پشتیبانی برای SOC2، HIPAA، GDPR و دیگر چارچوب‌های نظارتی از صندوق.',
  },
  {
    icon: <CheckCircle2 className="h-6 w-6" />,
    title: 'چارچوب حکمرانی',
    description:
      'اعمال سیاست، دسترسی بر‌مبنای نقش و دروازه‌های تأیید یکپارچه‌شده است.',
  },
];

const securityLayers = [
  {
    title: 'امنیت برنامه‌ها',
    items: [
      'اعتبارسنجی و پاک‌سازی ورودی',
      'جلوگیری از تزریق SQL',
      'حفاظت از Cross-site scripting (XSS)',
      'حفاظت CSRF',
      'محدود‌کننده نرخ و کاهش DDoS',
    ],
  },
  {
    title: 'امنیت داده‌ها',
    items: [
      'رمزگذاری در حالت سکون (AES-256)',
      'رمزگذاری در حالت انتقال (TLS 1.3)',
      'رمزگذاری سطح فیلد',
      'مدیریت امن کلید',
      'سیاست‌های نگهداری و حذف داده‌ها',
    ],
  },
  {
    title: 'کنترل دسترسی',
    items: [
      'یکپارچگی OAuth 2.0 و SAML',
      'احراز هویت چندعاملی',
      'کنترل دسترسی بر‌مبنای نقش (RBAC)',
      'کنترل دسترسی بر‌مبنای ویژگی (ABAC)',
      'ارتقای امتیاز در زمان مناسب',
    ],
  },
  {
    title: 'بازرسی و انطباق',
    items: [
      'سیاق‌های بازرسی تغییر‌ناپذیر',
      'داشبورد‌های انطباق',
      'بازرسی خودکار انطباق',
      'ابزارهای تحلیل کاوشی',
      'صادرات برای SOC2، HIPAA، GDPR',
    ],
  },
];

const deploymentOptions = [
  {
    title: 'Cloud SaaS',
    description: 'پلتفرم ابری چند‌سازمانی مدیریت‌شده',
    benefits: ['استقرار سریع', 'بروزرسانی خودکار', 'بدون مدیریت زیرساخت'],
  },
  {
    title: 'ابر خصوصی',
    description: 'محیط ابر اختصاصی در فراهم‌دهنده ابر شما',
    benefits: ['ایزولاسیون افزوده', 'شبکه‌سازی سفارشی', 'یکپارچگی VPC'],
  },
  {
    title: 'داخل‌سازمان',
    description: 'کنترل کامل بر داده‌ها و زیرساخت',
    benefits: ['کنترل حداکثری', 'استقرار بدون اتصال', 'یکپارچگی سیستم قدیمی'],
  },
];

export default function ArchitecturePage() {
  return (
    <PublicLayout>
      <HeroSection
        title="معماری و امنیت"
        description="طراحی سطح سازمانی از ابتدا برای امنیت، انطباق و کنترل عملیاتی."
      >
        <Link href="/request-demo" className="btn-primary">
          رزرو بررسی امنیتی
        </Link>
        <Link href="#architecture-section" className="btn-secondary">
          بیشتر بیاموزید
        </Link>
      </HeroSection>

       <section className="section-shell">
        <div className="container-shell">
          <div className="mb-14 max-w-3xl">
            <h2 className="section-title">اصول معماری</h2>
            <p className="mt-4 text-lg leading-8 text-muted-foreground">
              هر تصمیم‌گیری طراحی اولویت‌های سازمانی را ترجیح می‌دهد: امنیت، انطباق، مقیاس‌پذیری و کنترل عملیاتی.
            </p>
          </div>
          <FeatureGrid features={architectureFeatures} />
        </div>
      </section>

      {/* Security Layers */}
      <section id="architecture-section" className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14">رویکرد امنیت لایه‌ای</h2>
          <div className="grid gap-8 md:grid-cols-2">
            {securityLayers.map((layer, index) => (
              <div key={index} className="card-panel p-8">
                <h3 className="font-semibold text-foreground">{layer.title}</h3>
                <ul className="mt-6 space-y-4">
                  {layer.items.map((item, i) => (
                    <li key={i} className="flex gap-3 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-4 w-4 text-accent flex-shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Deployment Options */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">انعطاف‌پذیری استقرار</h2>
          <p className="mx-auto mb-14 max-w-3xl text-center text-lg leading-8 text-muted-foreground">
            چه نیاز به سادگی SaaS، ایزولاسیون ابر خصوصی یا کنترل داخل‌سازمان داشته باشید، آریا متناسب با زیرساخت و نیازهای حکمرانی شما است.
          </p>
          <div className="grid gap-6 md:grid-cols-3">
            {deploymentOptions.map((option, index) => (
              <div key={index} className="card-panel p-8 flex flex-col">
                <h3 className="text-lg font-semibold text-foreground">{option.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{option.description}</p>
                <ul className="mt-6 flex-1 space-y-3">
                  {option.benefits.map((benefit, i) => (
                    <li key={i} className="flex gap-3 text-xs text-muted-foreground">
                      <span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-accent flex-shrink-0" />
                      {benefit}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* API & Integration */}
      <section className="section-shell bg-surface/50">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">یکپارچگی API-first</h2>
          <div className="mx-auto max-w-4xl space-y-8">
            <div className="card-panel p-8">
              <h3 className="font-semibold text-foreground">API RESTful</h3>
              <p className="mt-2 text-muted-foreground">
                API کامل REST برای یکپارچگی با برنامه‌های شما. مستندات جامع، SDK‌های برای زبان‌های اصلی و پشتیبانی webhook.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>• مشخصه OpenAPI 3.0</li>
                <li>• محدود‌کردن نرخ و خفیف‌کردن</li>
                <li>• تحویل webhook با منطق تکرار</li>
                <li>• احراز هویت کلید API و OAuth</li>
              </ul>
            </div>

            <div className="card-panel p-8">
              <h3 className="font-semibold text-foreground">اتصالات سیستم</h3>
              <p className="mt-2 text-muted-foreground">
                اتصالات آماده برای سیستم‌های سازمانی. اتصال به ERP، CRM، حسابداری و برنامه‌های سفارشی بدون توسعه سفارشی.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>• اتصالات آماده برای SAP، NetSuite، Salesforce و غیره</li>
                <li>• چارچوب اتصال سفارشی</li>
                <li>• تبدیل و نقشه‌کشی داده‌ها</li>
                <li>• مدیریت خرابی و استراتژی‌های تکرار</li>
              </ul>
            </div>

            <div className="card-panel p-8">
              <h3 className="font-semibold text-foreground">تنظیم جریان کاری</h3>
              <p className="mt-2 text-muted-foreground">
                جریان‌های کاری پیچیده چند‌مرحله‌ای را تعریف کنید که اقدامات را در سیستم‌ها هماهنگ می‌کند. ویرایشگر جریان کاری بصری و تعریف‌بر‌مبنای کد.
              </p>
              <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                <li>• طراح جریان کاری بصری</li>
                <li>• تعریف جریان کاری YAML/JSON</li>
                <li>• انشعاب و مدیریت خرابی مشروط</li>
                <li>• دروازه‌های تأیید و جریان‌های کاری انسانی</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Governance Framework */}
      <section className="section-shell">
        <div className="container-shell">
          <h2 className="section-title mb-14 text-center">حکمرانی سازمانی درون‌ساخت</h2>
          <div className="mx-auto max-w-3xl">
            <div className="card-panel p-8 md:p-12">
              <p className="text-muted-foreground mb-6">
                آریا برای پشتیبانی از الزامات انطباق در سراسر صنایع معماری‌شده است. پلتفرم شامل است:
              </p>
              <ul className="space-y-4">
                {[
                  'کنترل دسترسی بر‌مبنای نقش و مدیریت امتیازات',
                  'ثبت کامل بازرسی تمام عملیات',
                  'رمزگذاری داده‌ها در حالت سکون و انتقال',
                  'ایزولاسیون و تقسیم داده‌های چند‌سازمانی',
                  'اعمال سیاست و جریان‌های کاری تأیید',
                  'توانایی‌های صادرات برای گزارش‌های انطباق',
                ].map((item, i) => (
                  <li key={i} className="flex gap-3 text-muted-foreground">
                    <CheckCircle2 className="h-5 w-5 text-accent flex-shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-sm text-muted-foreground border-t border-border/50 pt-6">
                سازمان‌ها می‌توانند با تیم آریا کار کنند تا الزامات انطباق برای مورد استفاده خاص و مقررات خود را ارزیابی کنند.
              </p>
            </div>
          </div>
        </div>
      </section>

      <CTASection
        title="آماده برای ارزیابی آریا؟"
        description="بررسی فنی با تیم امنیت و معماری ما را برنامه‌ریزی کنید."
        primaryButtonText="برنامه‌ریزی بررسی"
        primaryButtonHref="/request-demo"
        secondaryButtonText="دانلود خلاصه امنیتی"
        secondaryButtonHref="/resources"
      />
    </PublicLayout>
  );
}
