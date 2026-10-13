'use client';

import Link from 'next/link';
import { Linkedin, Github } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-border/70 bg-surface-muted/60">
      <div className="container-shell py-16">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr]">
          <div>
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-sm font-semibold text-primary-foreground shadow-soft">
                              آ
              </div>
              <div>
                              <div className="text-sm font-semibold tracking-[0.24em] text-foreground">آریا</div>
                                <div className="text-xs text-muted-foreground">پلتفرم هوش سازمانی</div>
              </div>
            </div>
            <p className="max-w-sm text-sm leading-7 text-muted-foreground">
                          آریا سیستم‌ها، فرایندها و داده‌های سازمان را به یک لایهٔ قابل کنترل و قابل بازبینی تبدیل می‌کند.
            </p>
            <div className="mt-6 flex gap-3">
              <a href="https://linkedin.com" aria-label="لینکدین" className="rounded-full border border-border bg-surface p-2 text-muted-foreground transition hover:text-primary">
                <Linkedin className="h-4 w-4" />
              </a>
                            <a href="https://github.com" aria-label="گیت‌هاب" className="rounded-full border border-border bg-surface p-2 text-muted-foreground transition hover:text-primary">
                <Github className="h-4 w-4" />
              </a>
            </div>
          </div>

          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-foreground">محصول</h3>
            <ul className="space-y-3 text-sm text-muted-foreground">
                          <li><Link href="/product" className="transition hover:text-primary">نمای کلی</Link></li>
                          <li><Link href="/ai-platform" className="transition hover:text-primary">پلتفرم هوش</Link></li>
                          <li><Link href="/ai-agents" className="transition hover:text-primary">عامل‌ها</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-foreground">فناوری</h3>
            <ul className="space-y-3 text-sm text-muted-foreground">
                          <li><Link href="/architecture" className="transition hover:text-primary">معماری و امنیت</Link></li>
                          <li><Link href="/integrations" className="transition hover:text-primary">یکپارچگی</Link></li>
                          <li><Link href="/resources" className="transition hover:text-primary">منابع</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.24em] text-foreground">شرکت</h3>
            <ul className="space-y-3 text-sm text-muted-foreground">
                          <li><Link href="/about" className="transition hover:text-primary">درباره</Link></li>
                          <li><Link href="/contact" className="transition hover:text-primary">تماس</Link></li>
                          <li><Link href="/request-demo" className="transition hover:text-primary">درخواست دموی سازمانی</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-4 border-t border-border/80 pt-6 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
          <p>© {new Date().getFullYear()} آریا. تمامی حقوق محفوظ است.</p>
          <div className="flex flex-wrap gap-4">
                      <Link href="/contact" className="transition hover:text-primary">حریم خصوصی</Link>
                      <Link href="/contact" className="transition hover:text-primary">شرایط استفاده</Link>
                      <Link href="/request-demo" className="transition hover:text-primary">درخواست دموی سازمانی</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
