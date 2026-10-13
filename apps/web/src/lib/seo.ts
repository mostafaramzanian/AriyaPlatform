export type MetaOptions = {
  title: string;
  description: string;
  canonical?: string;
  image?: string;
  type?: 'website' | 'article' | 'software' | string;
  publishedTime?: string;
  modifiedTime?: string;
};

export function buildMeta(options: MetaOptions) {
  const { title, description, canonical, image, type = 'website', publishedTime, modifiedTime } = options;

  const meta: Record<string, any> = {
    title,
    description,
    applicationName: 'پلتفرم آریا', 
    keywords: ['ERP', 'برنامه‌ریزی منابع سازمانی', 'نرم‌افزار کسب‌وکار', 'CRM', 'حسابداری', 'مدیریت موجودی'],
    openGraph: {
      title,
      description,
      url: canonical || (process.env.NEXT_PUBLIC_APP_URL ?? 'https://aria-platform.com'),
      siteName: 'پلتفرم آریا',
      images: image ? [{ url: image, width: 1200, height: 630 }] : [],
      type,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: image ? [image] : [],
    },
    alternates: {
      canonical: canonical || (process.env.NEXT_PUBLIC_APP_URL ?? 'https://aria-platform.com'),
    },
  };

  if (publishedTime) {
    meta.openGraph = { ...meta.openGraph, publishedTime, modifiedTime };
  }

  return meta;
}

export function organizationJsonLd() {
  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'پلتفرم آریا',
    url: process.env.NEXT_PUBLIC_APP_URL || 'https://aria-platform.com',
    logo: `${process.env.NEXT_PUBLIC_APP_URL || 'https://aria-platform.com'}/og-image.png`,
    sameAs: [
      'https://www.linkedin.com/company/aria-erp',
      'https://twitter.com/AriaERP',
    ],
  };

  return org;
}

export function softwareApplicationJsonLd() {
  const site = process.env.NEXT_PUBLIC_APP_URL || 'https://aria-platform.com';
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'پلتفرم آریا',
    operatingSystem: 'Web',
    applicationCategory: 'BusinessApplication',
    url: site,
    softwareVersion: '1.0.0',
    description: 'سیستم برنامه‌ریزی منابع سازمانی برای کسب‌وکارهای مدرن.',
  };
}
