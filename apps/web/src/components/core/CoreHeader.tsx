'use client';

import * as React from 'react';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import Link from 'next/link';
import { LifeBuoy, LogOut, Menu, Settings, UserCircle } from 'lucide-react';
import { cn, getInitials } from '@/lib/utils';
import { CoreNotificationBell } from './CoreNotificationBell';
import { CoreGlobalSearch } from './CoreGlobalSearch';
import { ThemeToggle } from './ThemeToggle';

/**
 * Phase 49B: Core header — page title and user menu.
 * Phase 48C: converged with the approved reference — 72px frosted bar, avatar
 * chip with identity block, and the light/dark switch.
 * Phase 49E: the notification bell (unread badge + panel) sits beside the theme
 * switch. It owns its own data and failure handling, so a failed unread-count
 * read can never break this header.
 * Phase 49J: the global search box sits before the bell — first in the actions
 * cluster because it is the only one that is an input rather than an icon, and it
 * needs the horizontal room. Like the bell it owns its own data and failure
 * handling, so a failed search can never break this header.
 *
 * Still no second auth mechanism. The user menu is a lightweight disclosure so no
 * new dependency is added. The brand block lives in the sidebar rail, matching the
 * reference, so it is not duplicated here.
 */

interface CoreHeaderProps {
  title: string;
  email?: string | null;
  onLogout: () => void;
  onOpenMobileNav: () => void;
}

export function CoreHeader({ title, email, onLogout, onOpenMobileNav }: CoreHeaderProps) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const initials = email ? getInitials(email.replace(/[@._-]+/g, ' ')) : '؟';

  return (
    <header className="glass sticky top-0 z-40 w-full border-b border-border">
      {/*
        Phase 49K: `h-core-header` resolves to `--core-header-h`, which the
        stylesheet re-declares under `:root[data-density='compact']`. The
        COMFORTABLE value is the 4.5rem/72px the 48C reference specifies, so the
        default bar is byte-for-byte the same height it was before density existed.
      */}
      <div className="flex h-core-header items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onOpenMobileNav}
            aria-label="نمایش منو"
            /*
             * `shrink-0` is a touch-target guarantee, not a layout preference. `h-10 w-10`
             * is a rem box, so at a 140% text scale it grows to 56px — but as a shrinkable
             * flex item next to the title it was squeezed to 28px WIDE while staying 56px
             * tall, i.e. exactly the large-text, narrow-screen combination that needs the
             * target most made it fail WCAG 2.5.8. The title beside it carries
             * `min-w-0 truncate`, so it is the element that should absorb the squeeze.
             */
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>

          <h1 className="min-w-0 truncate text-base font-semibold tracking-tight text-foreground md:text-lg">
            {title}
          </h1>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <CoreGlobalSearch />

          <CoreNotificationBell />

          <ThemeToggle />

          <span className="mx-1 hidden h-6 w-px bg-border sm:block" aria-hidden="true" />

          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={cn(
                'flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm text-foreground transition',
                'hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <span
                aria-hidden="true"
                className="gradient-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl text-xs font-bold text-primary-foreground"
              >
                {initials}
              </span>
              <span className="hidden max-w-[180px] truncate leading-tight sm:block">
                {email ?? 'کاربر'}
              </span>
            </button>

            <DropdownPanel
              open={menuOpen}
              role="menu"
              aria-label="منوی کاربر"
              className="absolute end-0 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-elevated"
            >
                {email && (
                  <div className="truncate border-b border-border px-4 py-3 text-xs text-muted-foreground">
                    {email}
                  </div>
                )}
                <Link
                  href="/admin/profile"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-4 py-3 text-sm transition hover:bg-secondary hover:text-foreground"
                >
                  <UserCircle className="h-4 w-4" aria-hidden="true" />
                  حساب من
                </Link>
                {/*
                  Phase 49C-1: entry point to the settings destination. The appearance and
                  accessibility controls MOVED OUT of the account page, which is now a pure
                  account surface; this existing disclosure is the only shell entry they
                  need. The gear icon matches the menu's existing icon pattern and the item
                  reuses the same navigation primitive as the link above — no new menu
                  machinery, no second dropdown, no redesign of this menu.
                */}
                <Link
                  href="/admin/settings"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-4 py-3 text-sm transition hover:bg-secondary hover:text-foreground"
                >
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  تنظیمات
                </Link>
                {/*
                  Phase 49C-5 (CORRECTED): the support destination belongs to the
                  personal/service access actions in THIS user menu — between the
                  settings entry above and the logout separator below — NOT inside
                  the platform Settings Center. The life-buoy icon matches the
                  menu's existing icon pattern, the item reuses the same navigation
                  primitive as its siblings (no new menu machinery), and the direct
                  route /admin/support remains the ONLY support destination, so the
                  server-side authorization of that route is untouched.
                */}
                <Link
                  href="/admin/support"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-4 py-3 text-sm transition hover:bg-secondary hover:text-foreground"
                >
                  <LifeBuoy className="h-4 w-4" aria-hidden="true" />
                  پشتیبانی
                </Link>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onLogout();
                  }}
                  className="flex w-full items-center gap-2 border-t border-border px-4 py-3 text-sm text-destructive transition hover:bg-destructive/10"
                >
                  <LogOut className="h-4 w-4" aria-hidden="true" />
                  خروج
                </button>
            </DropdownPanel>
          </div>
        </div>
      </div>
    </header>
  );
}
