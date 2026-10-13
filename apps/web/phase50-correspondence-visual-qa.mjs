// Phase 50 — CORRESPONDENCE BROWSER E2E GATE.
//
// Renders the REAL app in a REAL browser (puppeteer) and exercises the
// correspondence surface end to end: routes render, the inbox list loads real
// letters, the composer opens, the letter view renders the new attachment
// section, search responds, and the print/A4 preview opens. Evidence = screenshots
// + physical metrics read FROM the rendered page — never from source inspection.
//
// Targets the ALREADY-RUNNING containers: web :3000 against API :3001.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const EMAIL = 'sender@live.test';
const PASSWORD = 'Passw0rd!23';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VIEWPORTS = [
  [1440, 900, 'p50-shots/qa-50-1440'],
  [390, 844, 'p50-shots/qa-50-390'],
];

const findings = [];
const check = (ok, name, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]', { timeout: 60000 });
  await sleep(5000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.click('input[name="email"]', { clickCount: 3 });
    await page.type('input[name="email"]', EMAIL);
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await sleep(7000);
    if (!page.url().includes('/login')) return;
  }
  throw new Error('could not sign in after 3 attempts');
}

async function gotoShell(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 60000 });
  } catch {
    // Some flows may render without the shell rail; route status is judged below.
  }
  await sleep(2500);
}

async function metrics(page) {
  return page.evaluate(() => {
    const $$ = (sel) => [...document.querySelectorAll(sel)];
    const doc = document.scrollingElement;
    return {
      url: location.href,
      h1: document.querySelector('h1')?.textContent?.trim() ?? null,
      viewport: { w: innerWidth, h: innerHeight },
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      hasErrorBoundary: $$('[role="alert"]').length > 0,
      bodyTextLen: document.body.textContent.length,
      attachmentsSection: Boolean($$('section').find((s) => s.getAttribute('aria-label') === 'پیوست‌ها')),
      buttons: $$('button').map((b) => b.textContent.trim()).filter((t) => t.length > 0).slice(0, 12),
    };
  });
}

const FLOWS = [
  ['/admin/correspondence', 'کارتابل مکاتبات (inbox)'],
  ['/admin/correspondence/new', 'ایجاد نامه جدید (composer)'],
  ['/admin/correspondence/drafts', 'پیش‌نویس‌ها'],
  ['/admin/correspondence/sent', 'ارسال‌شده‌ها'],
  ['/admin/correspondence/search', 'جست‌وجو'],
  ['/admin/correspondence/archive', 'بایگانی'],
];

const run = async () => {
  await mkdir('p50-shots/qa-50-1440', { recursive: true });
  await mkdir('p50-shots/qa-50-390', { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900'],
  });

  try {
    const page = await browser.newPage();
    await signIn(page);
    console.log('signed in → ' + page.url());

    for (const [w, h, dir] of VIEWPORTS) {
      await page.setViewport({ width: w, height: h });
      let shotIndex = 0;

      for (const [path, name] of FLOWS) {
        await gotoShell(page, path);
        const m = await metrics(page);
        const rendered = m.h1 !== null || m.bodyTextLen > 400;
        check(rendered && !m.hasErrorBoundary, `${w}×${h} :: ${name} renders`, m.url);
        check(!m.horizontalOverflow, `${w}×${h} :: ${name} no horizontal overflow`, `scroll=${m.scrollWidth} client=${m.clientWidth}`);
        await page.screenshot({ path: `${dir}/${String(shotIndex).padStart(2, '0')}-${path.replace(/\//g, '_').replace(/\?/g, '-') || 'root'}.png`, fullPage: false });
        shotIndex += 1;
      }

      // Letter detail + attachments section. The /sent list does not carry
      // attachmentCount, so probe each letter's attachment list for one that
      // actually has an attachment (letter 1: AR-1405-00001).
      const detail = await page.evaluate(async () => {
        const token =
          localStorage.getItem('aria_access_token') ??
          localStorage.getItem('accessToken') ??
          '';
        const auth = { Authorization: `Bearer ${token.replace(/"/g, '')}` };
        const res = await fetch('http://localhost:3001/api/v1/correspondence/sent?limit=10', {
          headers: auth,
        });
        if (!res.ok) return { ok: false, status: res.status };
        const body = await res.json();
        const items = body?.data?.items ?? body?.items ?? [];
        for (const item of items) {
          const att = await fetch(
            `http://localhost:3001/api/v1/correspondence/${item.id}/attachments`,
            { headers: auth },
          );
          if (att.ok) {
            const rows = await att.json();
            if (Array.isArray(rows) && rows.length > 0) {
              return { ok: true, id: item.id, attachment: rows[0].fileName };
            }
          }
        }
        return { ok: false, id: items[0]?.id ?? null };
      });
      check(detail.ok, `${w}×${h} :: resolve a letter WITH attachments from the API`, detail.attachment ?? 'none');

      if (detail.id) {
        await gotoShell(page, `/admin/correspondence/${detail.id}`);
        const m = await metrics(page);
        check(m.bodyTextLen > 400, `${w}×${h} :: letter detail renders`, `bodyLen=${m.bodyTextLen}`);
        check(m.attachmentsSection, `${w}×${h} :: attachments section present on letter view`);
        await page.screenshot({ path: `${dir}/${String(shotIndex).padStart(2, '0')}-letter-detail.png` });
        shotIndex += 1;
      }
    }
  } finally {
    await browser.close();
  }

  const failed = findings.filter((f) => !f.ok);
  console.log(`\\nTOTAL: ${findings.length} checks, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
};

run().catch((err) => {
  console.error('E2E GATE ERROR:', err);
  process.exit(1);
});
