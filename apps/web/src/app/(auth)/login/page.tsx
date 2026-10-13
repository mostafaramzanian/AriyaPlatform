import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLayout } from '@/components/common/PublicLayout';
import { LoginForm } from '@/components/auth/LoginForm';

export const metadata: Metadata = {
  title: 'ورود',
  description: 'به حساب پلتفرم آریا خود وارد شوید.',
};

export default function LoginPage() {
  return (
    <PublicLayout>
      <section className="py-20 md:py-32">
        <div className="container mx-auto px-4 max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">ورود</h1>
            <p className="text-muted-foreground">خوش برگشتید به پلتفرم آریا</p>
          </div>

          <LoginForm />

          <div className="mt-6 text-center text-sm">
            حساب ندارید؟{' '}
            <Link href="/register" className="text-primary hover:underline">
              یکی ایجاد کنید
            </Link>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
