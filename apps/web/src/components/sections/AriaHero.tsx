"use client";
import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import AriaHeroAnimator from './AriaHeroAnimator';
import AuditModal from './AuditModal';

export default function AriaHero() {
  const [openAudit, setOpenAudit] = useState(false);

  useEffect(() => {
    const btn = document.getElementById('open-audit');
    if (btn) btn.addEventListener('click', () => setOpenAudit(true));
    return () => { if (btn) btn.removeEventListener('click', () => setOpenAudit(true)); };
  }, []);

  return (
    <section dir="rtl" className="relative overflow-hidden border-b border-border/70 bg-[radial-gradient(circle_at_top_left,_rgba(107,93,241,0.06),_transparent_35%),linear-gradient(135deg,_rgba(15,23,42,0.02),_rgba(2,6,23,0.02))] py-12 sm:py-16 lg:py-20">
      <div className="container-shell">
        <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
          <div className="order-2 lg:order-1 text-right">
            <div className="eyebrow mb-4">پلتفرم هوش سازمانی</div>
            <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight text-foreground">
              سازمانتان را به هوشِ عمل‌گرا تبدیل کنید
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-7 text-muted-foreground">
              آریا لایه‌ای از دانش و اجراست که سیستم‌ها و داده‌های پراکنده را متحد می‌کند تا تصمیم‌ها قابل‌بازبینی، امن و قابل اجرا شوند.
            </p>

            <div className="mt-8 flex justify-end gap-4">
              <Link href="/request-demo" className="btn-primary">
                درخواست دموی سازمانی
              </Link>
              <Link href="/product" className="btn-secondary">
                مشاهدهٔ معماری
              </Link>
            </div>

            <div className="mt-6 flex justify-end gap-6 text-sm text-muted-foreground items-center">
              <div>حاکمیت · قابلیت بازبینی · کنترل نقش‌ها</div>
              <button id="open-audit" className="text-sm text-primary underline">نمونهٔ لاگ تصمیم</button>
            </div>
          </div>

          <div className="order-1 lg:order-2 flex justify-center lg:justify-start">
            <div className="relative">
              <Image
                src="/assets/aria-hero.svg"
                alt="تصویر پلتفرم آریا"
                unoptimized
                width={1600}
                height={900}
                className="w-full max-w-[720px] opacity-100"
              />
              <AriaHeroAnimator />
              <AuditModal open={openAudit} onClose={() => setOpenAudit(false)} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
