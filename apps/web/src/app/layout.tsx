import type { Metadata, Viewport } from 'next';
import './globals.css';
// Self-hosted Vazirmatn (variable font, wght 100-900). Replaces the jsdelivr
// CDN import that was unreachable through the local proxy / docker build.
import '@fontsource-variable/vazirmatn';
import { AuthProvider } from '@/components/providers/AuthProvider';
import { PreferenceProvider } from '@/components/providers/PreferenceProvider';
import { ThemeProvider, ThemeScript } from '@/components/providers/ThemeProvider';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
};

export const metadata: Metadata = {
  title: {
    template: '%s | آریا',
    default: 'آریا | پلتفرم هوش سازمانی',
  },
  description:
    'آریا یک پلتفرم هوش سازمانی برای سازمان‌های مدرنی است که سیستم‌های موجود، جریان‌های کاری و داده‌ها را به تصمیم‌گیری قابل اعتماد تبدیل می‌کند.',
  keywords: [
    'ERP',
    'برنامه‌ریزی منابع سازمانی',
    'نرم‌افزار کسب‌وکار',
    'CRM',
    'حسابداری',
    'مدیریت موجودی',
  ],
  authors: [{ name: 'پلتفرم آریا' }],
  creator: 'پلتفرم آریا',
  publisher: 'پلتفرم آریا',
  formatDetection: {
    email: false,
    telephone: false,
  },
  openGraph: {
    type: 'website',
    locale: 'fa_IR',
    url: 'https://aria-platform.com',
    siteName: 'پلتفرم آریا',
    title: 'پلتفرم آریا - سیستم برنامه‌ریزی منابع سازمانی',
    description:
      'پلتفرم ERP درجه سازمانی برای کسب‌وکارهای مدرن. ساده‌سازی عملیات، کاهش هزینه‌ها و شتاب رشد.',
    images: [
      {
        url: 'https://aria-platform.com/og-image.png',
        width: 1200,
        height: 630,
        alt: 'پلتفرم آریا',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'پلتفرم آریا - سیستم برنامه‌ریزی منابع سازمانی',
    description:
      'پلتفرم ERP درجه سازمانی برای کسب‌وکارهای مدرن. ساده‌سازی عملیات، کاهش هزینه‌ها و شتاب رشد.',
    images: ['https://aria-platform.com/og-image.png'],
    creator: '@AriaERP',
  },
  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: false,
    },
  },
  alternates: {
    canonical: 'https://aria-platform.com',
    languages: {
      fa: 'https://aria-platform.com',
    },
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <ThemeScript />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
      </head>
      <body className="font-vazirmatn">
        <a href="#content" className="skip-link">پرش به محتوا</a>
        <div id="content">
          <ThemeProvider>
            <AuthProvider>
              {/*
                * Nesting is a dependency order, not a style choice:
                * `PreferenceProvider` calls `useAuth` (to know whether to fetch and
                * persist at all) and `useTheme` (to push the server's theme onto the
                * document), so it must sit inside both.
                */}
              <PreferenceProvider>{children}</PreferenceProvider>
            </AuthProvider>
          </ThemeProvider>
        </div>
      </body>
    </html>
  );
}
