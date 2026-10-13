import type { Metadata } from 'next';
import { PublicLayout } from '@/components/common/PublicLayout';
import { HeroSection } from '@/components/sections/PageSections';

export const metadata: Metadata = {
  title: 'تعرفه‌ها',
  description: 'طرح‌های قیمت‌گذاری ساده و شفاف برای هر اندازه کسب‌وکار.',
};

export default function PricingPage() {
  return (
    <PublicLayout>
      <HeroSection
        title="قیمت‌گذاری ساده و شفاف"
        description="طرح مناسب کسب‌وکار خود را انتخاب کنید و در صورت نیاز مقیاس دهید."
      />

      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              {
              name: 'پایه',
                price: 99,
              description: 'مناسب تیم‌های کوچک',
              features: ['تا ۱۰ کاربر', 'ماژول‌های اصلی', 'پشتیبانی ایمیلی', 'دسترسی API'],
              },
              {
              name: 'حرفه‌ای',
                price: 299,
              description: 'برای کسب‌وکارهای در حال رشد',
                features: [
                'تا ۵۰ کاربر',
                'تمام ماژول‌ها',
                'پشتیبانی اولویت‌دار',
                'دسترسی پیشرفته API',
                'گردش‌های کاری سفارشی',
                ],
                highlighted: true,
              },
              {
              name: 'سازمانی',
                price: null,
              description: 'برای سازمان‌های بزرگ',
                features: [
                'کاربران نامحدود',
                'تمام قابلیت‌ها',
                'پشتیبانی اختصاصی',
                'یکپارچگی‌های سفارشی',
                'تضمین SLA',
                ],
              },
            ].map((plan, index) => (
              <div
                key={index}
                className={`rounded-lg p-8 ${
                  plan.highlighted
                    ? 'border border-primary bg-primary/5 relative'
                    : 'border border-border bg-background'
                }`}
              >
                {plan.highlighted && (
                  <div className="absolute -top-3 left-4 bg-primary text-primary-foreground px-3 py-1 rounded text-xs font-medium">
                    محبوب
                  </div>
                )}
                <h3 className="text-xl font-semibold mb-2">{plan.name}</h3>
                <p className="text-muted-foreground text-sm mb-6">{plan.description}</p>
                <div className="mb-6">
                  {plan.price !== null ? (
                    <>
                      <span className="text-4xl font-bold">${plan.price}</span>
                      <span className="text-muted-foreground">/month</span>
                    </>
                  ) : (
                    <span className="text-2xl font-bold">Custom pricing</span>
                  )}
                </div>
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature, featureIndex) => (
                    <li key={featureIndex} className="flex items-center space-x-2 text-sm">
                      <span className="text-primary">✓</span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <button
                  className={`w-full rounded-md px-4 py-2 font-medium ${
                    plan.highlighted
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                      : 'border border-primary text-primary hover:bg-primary/5'
                  }`}
                >
                  {plan.price !== null ? 'شروع کنید' : 'تماس با فروش'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 md:py-32 bg-muted/50">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">Frequently Asked Questions</h2>
          <div className="max-w-3xl mx-auto space-y-6">
            {[
              {
                q: 'Can I change my plan anytime?',
                a: 'Yes, you can upgrade or downgrade your plan at any time. Changes take effect at the next billing cycle.',
              },
              {
                q: 'Do you offer discounts for annual billing?',
                a: 'Yes, we offer 20% discount when you choose annual billing instead of monthly.',
              },
              {
                q: 'Is there a free trial?',
                a: 'Yes, you get 14 days free trial with full access to all features.',
              },
              {
                q: 'What payment methods do you accept?',
                a: 'We accept all major credit cards, bank transfers, and wire transfers for enterprise plans.',
              },
            ].map((faq, index) => (
              <div key={index} className="p-6 rounded-lg border border-border bg-background">
                <h3 className="font-semibold mb-2">{faq.q}</h3>
                <p className="text-muted-foreground text-sm">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
