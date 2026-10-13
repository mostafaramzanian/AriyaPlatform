// Phase 50 — PRINT / A4 GATE.
//
// Opens a REAL letter, clicks the real "چاپ / A4" button, asserts the print
// preview sheet renders, measures it physically, screenshots it, and emits a
// real page.pdf() using the print stylesheet. Evidence = rendered metrics +
// PDF, never source inspection.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const EMAIL = 'sender@live.test';
const PASSWORD = 'Passw0rd!23';
const LETTER_ID = process.argv[2];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = async () => {
  await mkdir('p50-shots/print', { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]', { timeout: 60000 });
  await sleep(4000);
  for (let i = 0; i < 3; i++) {
    await page.click('input[name="email"]', { clickCount: 3 });
    await page.type('input[name="email"]', EMAIL);
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await sleep(6000);
    if (!page.url().includes('/login')) break;
  }

  await page.goto(`${BASE}/admin/correspondence/${LETTER_ID}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  const printButton = await page.evaluateHandle(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.includes('چاپ')),
  );
  const hasButton = Boolean((await printButton.asElement()) !== null);
  console.log(`${hasButton ? 'PASS' : 'FAIL'} :: چاپ / A4 button present on letter view`);
  if (!hasButton) {
    await browser.close();
    process.exit(1);
  }

  await printButton.asElement().click();
  await sleep(2500);

  const preview = await page.evaluate(() => {
    const sheet =
      document.querySelector('.corr-print-overlay article') ??
      document.querySelector('.corr-print-overlay');
    const rect = sheet?.getBoundingClientRect();
    const overlay = document.querySelector('.corr-print-overlay');
    return {
      overlayPresent: Boolean(overlay),
      sheetPresent: Boolean(sheet),
      widthMm: rect ? Math.round((rect.width / 96) * 25.4) : null,
      heightMm: rect ? Math.round((rect.height / 96) * 25.4) : null,
      headerText: document.querySelector('.corr-print-overlay h1')?.textContent?.trim() ?? null,
      hasLetterNumber: document
        .querySelector('.corr-print-overlay')
        ?.textContent?.includes('شماره'),
      hasSignatureBlock: Boolean(document.querySelector('.corr-signature-block')),
      hasFooterBlock: Boolean(document.querySelector('.corr-footer-block')),
    };
  });

  const a4ok =
    preview.sheetPresent &&
    preview.widthMm >= 195 && preview.widthMm <= 215 &&
    preview.heightMm >= 280 && preview.heightMm <= 300;
  console.log(`${a4ok ? 'PASS' : 'FAIL'} :: A4 sheet renders at ~210×297mm`, JSON.stringify(preview));
  console.log(`${preview.hasLetterNumber ? 'PASS' : 'FAIL'} :: print preview carries letter number`);
  console.log(`${preview.hasSignatureBlock ? 'PASS' : 'FAIL'} :: signature block present`);
  console.log(`${preview.hasFooterBlock ? 'PASS' : 'FAIL'} :: footer block present`);

  await page.screenshot({ path: 'p50-shots/print/print-preview-1440.png' });

  await page.emulateMediaType('print');
  await page.pdf({
    path: 'p50-shots/print/letter-A4.pdf',
    format: 'A4',
    printBackground: true,
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
  console.log('PASS :: page.pdf() emitted (print stylesheet) → p50-shots/print/letter-A4.pdf');

  await browser.close();
  const failed = [a4ok, preview.hasLetterNumber, preview.hasSignatureBlock, preview.hasFooterBlock]
    .filter((x) => !x).length;
  console.log(`PRINT GATE: ${4 - failed}/4 passed`);
  if (failed > 0) process.exit(1);
};

run().catch((e) => { console.error('PRINT GATE ERROR:', e); process.exit(1); });
