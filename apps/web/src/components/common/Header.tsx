'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import { useAuth } from '@/components/providers/AuthProvider';
import { Button } from '@/components/ui/button';

type NavItem = 
  | { label: string; href: string; submenu?: never }
  | { label: string; href: string; submenu: Array<{ label: string; href: string }> };

function HeaderAuth() {
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  if (isLoading) {
    return <span className="text-sm text-muted-foreground">...</span>;
  }

  if (isAuthenticated && user) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground truncate max-w-[120px]">{user.email}</span>
        <Button
          type="button"
          onClick={() => { logout().catch(() => undefined); }}
          className="text-sm text-primary hover:underline"
        >
          خروج
        </Button>
      </div>
    );
  }

  return (
    <Link href="/login" className="text-sm font-medium text-foreground transition hover:text-primary">
      ورود
    </Link>
  );
}

const navigation: NavItem[] = [
  {
    label: 'محصول',
    href: '/product',
    submenu: [
      { label: 'نمای کلی', href: '/product' },
      { label: 'پلتفرم هوش', href: '/ai-platform' },
      { label: 'عامل‌ها', href: '/ai-agents' },
    ],
  },
  {
    label: 'فناوری',
    href: '/architecture',
    submenu: [
      { label: 'معماری و امنیت', href: '/architecture' },
      { label: 'یکپارچگی و توسعه‌دهندگان', href: '/integrations' },
    ],
  },
  { label: 'منابع', href: '/resources' },
  { label: 'وبلاگ', href: '/blog' },
  { label: 'درباره', href: '/about' },
];

export function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/85 backdrop-blur-xl">
      <div className="container-shell flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary text-sm font-semibold text-primary-foreground shadow-soft">
                      آ
          </div>
          <div className="leading-tight">
                      <div className="text-sm font-semibold tracking-[0.24em] text-foreground">آریا</div>
                      <div className="text-xs text-muted-foreground">پلتفرم هوش سازمانی</div>
          </div>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {navigation.map((item) => (
            <div key={item.label} className="relative group">
              <Link
                href={item.href}
                className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-primary"
              >
                {item.label}
                {item.submenu && (
                  <ChevronDown className="h-4 w-4 opacity-50 transition-transform duration-200 group-hover:rotate-180" />
                )}
              </Link>
              {item.submenu && (
                <div className="absolute top-full right-0 hidden group-hover:block bg-background border border-border/70 rounded-lg shadow-lg py-2 w-56">
                  {item.submenu.map((subitem) => (
                    <Link
                      key={subitem.label}
                      href={subitem.href}
                      className="block px-4 py-2 text-sm text-muted-foreground hover:text-primary hover:bg-surface/50"
                    >
                      {subitem.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link href="/contact" className="text-sm font-medium text-muted-foreground transition hover:text-primary">
                      تماس
          </Link>
          <Link href="/request-demo" className="btn-primary">
                      درخواست دموی سازمانی
          </Link>
          <HeaderAuth />
        </div>

        <button
          className="rounded-full p-2 text-foreground transition hover:bg-surface-muted md:hidden"
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          aria-label="باز کردن منو"
        >
          {isMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {isMenuOpen && (
        <div className="border-t border-border/80 bg-background/95 md:hidden">
          <nav className="container-shell flex flex-col gap-1 px-6 py-5">
            {navigation.map((item) => (
              <div key={item.label}>
                <button
                  onClick={() => setOpenSubmenu(openSubmenu === item.label ? null : item.label)}
                  className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-muted-foreground hover:text-primary transition"
                >
                  <span>{item.label}</span>
                  {item.submenu && (
                    <ChevronDown
                      className={`h-4 w-4 transition-transform duration-200 ${openSubmenu === item.label ? 'rotate-180' : ''}`}
                    />
                  )}
                </button>
                {item.submenu && openSubmenu === item.label && (
                <div className="pr-4 space-y-2">
                    {item.submenu.map((subitem) => (
                      <Link
                        key={subitem.label}
                        href={subitem.href}
                        onClick={() => setIsMenuOpen(false)}
                        className="block px-3 py-2 text-sm text-muted-foreground hover:text-primary"
                      >
                        {subitem.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <Link href="/contact" className="px-3 py-2 text-sm font-medium text-muted-foreground transition hover:text-primary">
                          تماس
            </Link>
            <Link href="/request-demo" className="btn-primary w-full mt-2">
                          درخواست دموی سازمانی
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}
