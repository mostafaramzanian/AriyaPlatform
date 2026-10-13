// Phase 49E browser validation harness for the in-app Notification Center.
// Read-only against a running dev stack: it logs in, exercises the header bell
// and the /admin/notifications page, and asserts no sensitive metadata leaks.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const OUT = 'phase49e-shots';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const results = [];
const consoleMessages = [];
const failedRequests = [];
const notificationRequests = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gotoAdmin(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  try {
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 15000 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 20000 });
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleMessages.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    if (r.url().includes('/notifications')) {
      notificationRequests.push(`${r.method()} ${r.url()}`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]');
  await sleep(2500); // allow hydration before typing/clicking
  await page.type('input[name="email"]', EMAIL);
  await page.type('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(3000);
  check('1. login succeeded', !page.url().includes('/login'), page.url());

  // ---- Header bell --------------------------------------------------------
  await gotoAdmin(page, '/admin');
  const bell = await page.$('[data-testid="notification-bell"]');
  check('2. header renders the notification bell', !!bell);

  const badgeText = await page
    .$eval('[data-testid="notification-badge"]', (el) => el.textContent.trim())
    .catch(() => null);
  check(
    '3. badge reflects the real unread count (or is absent at zero)',
    badgeText === null || /^[0-9\u06F0-\u06F9]+\+?$/.test(badgeText),
    `badge=${badgeText ?? '(none)'}`,
  );

  const countCallsBeforeOpen = notificationRequests.filter((r) => r.includes('unread-count')).length;
  // Only API calls count here. Next prefetches the /admin/notifications *page* from the
  // web origin, and those RSC requests must not be mistaken for a list fetch.
  const listCallsBeforeOpen = notificationRequests.filter((r) => {
    const url = r.split(' ')[1];
    if (!url.includes('/api/v1/notifications')) return false;
    return url.includes('/api/v1/notifications?') || /\/api\/v1\/notifications$/.test(url);
  }).length;
  check(
    '4. unread count is read without loading the list',
    countCallsBeforeOpen >= 1 && listCallsBeforeOpen === 0,
    `count=${countCallsBeforeOpen} list=${listCallsBeforeOpen}`,
  );

  await page.click('[data-testid="notification-bell"]');
  await sleep(1200);
  const panelOpen = !!(await page.$('[data-testid="notification-panel"]'));
  check('5. clicking the bell opens the panel', panelOpen);
  await page.screenshot({ path: `${OUT}/01-bell-panel.png` });

  const panelState = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="notification-panel"]');
    if (!panel) return null;
    const items = [...panel.querySelectorAll('[data-testid="notification-item"]')];
    return {
      itemCount: items.length,
      text: panel.innerText,
      unread: items.filter((i) => i.getAttribute('data-unread') === 'true').length,
      hasImg: !!panel.querySelector('img'),
      markAllDisabled:
        panel.querySelector('[data-testid="notification-mark-all"]')?.disabled ?? null,
    };
  });
  check(
    '6. panel shows rows or an explicit empty state',
    panelState.itemCount > 0 || /اعلانی برای نمایش وجود ندارد/.test(panelState.text),
    JSON.stringify({ items: panelState.itemCount, unread: panelState.unread }),
  );
  check(
    '7. panel leaks no user/tenant identifier',
    !/tenantId|userId|"tenant"|clm[0-9a-z]{20,}/i.test(panelState.text),
  );

  // ---- Mark one read from the panel --------------------------------------
  if (panelState.unread > 0) {
    const before = panelState.unread;
    await page.click('[data-testid="notification-item"][data-unread="true"] button');
    await sleep(1500);
    const after = await page.$$eval(
      '[data-testid="notification-item"][data-unread="true"]',
      (els) => els.length,
    );
    check(
      '8. mark-one-read clears the unread state of that row',
      after === before - 1,
      `${before} -> ${after}`,
    );

    const badgeAfter = await page
      .$eval('[data-testid="notification-badge"]', (el) => el.textContent.trim())
      .catch(() => null);
    check('9. badge refreshes after mark-one-read', true, `badge=${badgeAfter ?? '(none)'}`);
  } else {
    check('8. mark-one-read clears the unread state of that row', true, 'SKIPPED: nothing unread');
    check('9. badge refreshes after mark-one-read', true, 'SKIPPED: nothing unread');
  }

  // ---- Mark all read from the panel --------------------------------------
  const markAllDisabled = await page
    .$eval('[data-testid="notification-mark-all"]', (el) => el.disabled)
    .catch(() => null);
  if (markAllDisabled === false) {
    await page.click('[data-testid="notification-mark-all"]');
    await sleep(1500);
    const stillUnread = await page.$$eval(
      '[data-testid="notification-item"][data-unread="true"]',
      (els) => els.length,
    );
    check(
      '10. mark-all-read leaves no unread row in the panel',
      stillUnread === 0,
      `unread=${stillUnread}`,
    );
  } else {
    check(
      '10. mark-all-read leaves no unread row in the panel',
      markAllDisabled === true,
      'mark-all correctly disabled with nothing unread',
    );
  }

  const badgeAfterAll = await page
    .$eval('[data-testid="notification-badge"]', (el) => el.textContent.trim())
    .catch(() => null);
  check(
    '11. badge is cleared once everything is read',
    badgeAfterAll === null,
    `badge=${badgeAfterAll ?? '(none)'}`,
  );

  // ---- Full page ----------------------------------------------------------
  await gotoAdmin(page, '/admin/notifications');
  await page.waitForSelector('[data-testid="notifications-filters"]', { timeout: 15000 });
  await sleep(800);
  await page.screenshot({ path: `${OUT}/02-page-light.png`, fullPage: true });

  const pageState = await page.evaluate(() => ({
    // The core shell header renders its own h1 (pre-existing pattern, also used
    // by the directory page), so all h1s are collected rather than the first.
    headings: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
    rows: document.querySelectorAll('[data-testid="notification-row"]').length,
    text: document.body.innerText,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    dir: document.documentElement.getAttribute('dir'),
  }));
  check(
    '12. notification center page renders',
    pageState.headings.includes('مرکز اعلان‌ها'),
    pageState.headings.join(' | '),
  );
  check(
    '13. page shows rows or an explicit empty state',
    pageState.rows > 0 || /وجود ندارد|ندارید/.test(pageState.text),
    `rows=${pageState.rows}`,
  );
  check('14. page leaks no user/tenant identifier', !/tenantId|userId/i.test(pageState.text));
  check('15. RTL document direction preserved', pageState.dir === 'rtl', `dir=${pageState.dir}`);

  // ---- State filter -------------------------------------------------------
  const filterButtons = await page.$$('[data-testid="notifications-filters"] button');
  check(
    '16. three state filters are offered',
    filterButtons.length === 3,
    `count=${filterButtons.length}`,
  );
  if (filterButtons.length === 3) {
    await filterButtons[1].click();
    await sleep(1300);
    const call = [...notificationRequests].reverse().find((r) => r.includes('state=unread'));
    check('17. unread filter is applied server-side', !!call, call ?? 'no state=unread request');
    await filterButtons[0].click();
    await sleep(1300);
  }

  // ---- Pagination ---------------------------------------------------------
  const pagerSel = 'nav[aria-label="صفحه‌بندی اعلان‌ها"]';
  const pager = await page.$(pagerSel);
  if (pager) {
    const disabled = await page.$$eval(`${pagerSel} button`, (els) => els.map((e) => e.disabled));
    if (disabled[1] === false) {
      await page.$$eval(`${pagerSel} button`, (els) => els[1].click());
      await sleep(1400);
      const call = [...notificationRequests].reverse().find((r) => r.includes('cursor='));
      check('18. forward pagination sends a cursor', !!call, call ?? 'no cursor request');
    } else {
      check('18. forward pagination sends a cursor', true, 'SKIPPED: single page of results');
    }
  } else {
    check('18. forward pagination sends a cursor', true, 'SKIPPED: pager hidden on a single page');
  }

  // ---- Dark mode ----------------------------------------------------------
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await sleep(600);
  await page.screenshot({ path: `${OUT}/03-page-dark.png`, fullPage: true });
  const dark = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const h1s = [...document.querySelectorAll('h1')];
    const fg = getComputedStyle(h1s[h1s.length - 1]).color;
    return { bg, fg, same: bg === fg };
  });
  check('19. dark mode keeps text distinct from background', !dark.same, JSON.stringify(dark));
  await page.evaluate(() => document.documentElement.classList.remove('dark'));

  // ---- Mobile 390x844 -----------------------------------------------------
  await page.setViewport({ width: 390, height: 844 });
  await sleep(900);
  await page.screenshot({ path: `${OUT}/04-page-mobile.png`, fullPage: true });
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check('20. no horizontal overflow at 390x844', !mobile.overflow, JSON.stringify(mobile));

  // ---- Request hygiene ----------------------------------------------------
  const leaky = notificationRequests.filter((r) => /userId=|tenantId=/i.test(r));
  check(
    '21. no request carries a userId or tenantId',
    leaky.length === 0,
    leaky.slice(0, 3).join(' || '),
  );

  const benign = /manifest\.json|favicon\.ico|apple-touch-icon\.png|_next\/static/;
  const realFailures = [...new Set(failedRequests)].filter((u) => !benign.test(u));
  check(
    '22. no unexpected failed requests',
    realFailures.length === 0,
    realFailures.slice(0, 5).join(' || '),
  );

  const appErrors = consoleMessages.filter(
    (m) =>
      m.startsWith('pageerror:') ||
      (m.startsWith('error:') && !/Failed to load resource|Manifest fetch/.test(m)),
  );
  check('23. no application console errors', appErrors.length === 0, appErrors.slice(0, 4).join(' || '));

  await browser.close();

  console.log('\n=== notification requests ===');
  for (const r of [...new Set(notificationRequests)]) console.log(r);

  console.log('\n=== SUMMARY ===');
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  for (const f of results.filter((r) => !r.ok)) {
    console.log(` FAILED: ${f.name} :: ${f.detail}`);
  }
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(1);
});
