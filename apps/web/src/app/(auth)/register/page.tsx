import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';

export const metadata: Metadata = {
  title: 'ثبت‌نام',
  description: 'ایجاد یک حساب جدید پلتفرم آریا.',
};

export default function RegisterPage() {
  return (
    <PublicLayout>
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">ایجاد حساب</h1>
            <p className="text-muted-foreground">همین امروز با پلتفرم آریا شروع کنید</p>
          </div>

          <form className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">نام</label>
                <input
                  type="text"
                  required
                  className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="نام"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">نام خانوادگی</label>
                <input
                  type="text"
                  required
                  className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="نام خانوادگی"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">ایمیل</label>
              <input
                type="email"
                required
                className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder="ایمیل شما"
              />
            </div>

            <div>
            <label className="block text-sm font-medium mb-2">شرکت</label>
            <input
              type="text"
              required
              className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="نام شرکت"
            />
            </div>

            <div>
            <label className="block text-sm font-medium mb-2">رمز عبور</label>
            <input
              type="password"
              required
              className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="••••••••"
            />
            </div>

            <div>
            <label className="block text-sm font-medium mb-2">تأیید رمز عبور</label>
            <input
              type="password"
              required
              className="w-full rounded-md border border-border bg-background px-4 py-2 focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="••••••••"
            />
            </div>

            <label className="flex items-start space-x-2">
            <input type="checkbox" required className="rounded border border-border mt-1" />
            <span className="text-sm">
              با <Link href="/terms" className="text-primary hover:underline">شرایط استفاده</Link> و <Link href="/privacy" className="text-primary hover:underline">حریم خصوصی</Link> موافقم.
            </span>
            </label>

            <button
            type="submit"
            className="w-full rounded-md bg-primary text-primary-foreground px-4 py-2 font-medium hover:bg-primary/90"
            >
             ایجاد حساب
            </button>
          </form>

          <div className="mt-6 text-center text-sm">
            قبلاً حساب ساخته‌اید؟{' '}
            <Link href="/login" className="text-primary hover:underline">
              ورود
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
