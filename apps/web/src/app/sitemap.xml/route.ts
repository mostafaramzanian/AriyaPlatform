import { NextResponse } from 'next/server';

export async function GET() {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  const staticPages = [
    '',
    '/product',
    '/modules',
    '/pricing',
    '/roi-calculator',
    '/case-studies',
    '/partners',
    '/support',
    '/resources',
    '/blog',
    '/integration',
    '/about',
    '/contact',
    '/contact-sales',
    '/request-demo',
    '/book-meeting',
    '/legal',
    '/security',
    '/sla',
    '/status',
    '/docs',
    '/release-notes',
    '/careers',
    '/roadmap',
    '/privacy',
    '/terms'
  ];

  const urls = staticPages.map((path) => {
    const loc = `${baseUrl}${path}`;
    return `<url><loc>${loc}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'application/xml' },
  });
}
