// Phase 48C temporary browser validation harness. Deleted after the run.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const OUT = 'phase48c-shots';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const results = [];
const consoleMessages = [];
const failedRequests = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Counts ON-SCREEN persistent rails. This only ever matches the DESKTOP instance:
 * `CoreSidebar` renders `data-testid="core-sidebar-drawer"` in its drawer variant,
 * so the mobile drawer is deliberately not counted here.
 */
const visibleRails = (page) =>
  page.$$eval('[data-testid="core-sidebar"]', (els) =>
    els.filter((el) => el.offsetParent !== null).length,
  );

/**
 * Reads the mobile drawer's ACTUAL state.
 *
 * PRE-EXISTING HARNESS DEFECT, fixed in Phase 49K: checks 13/14 used `visibleRails`,
 * which cannot see the drawer at all — the drawer nav's test id is
 * `core-sidebar-drawer`, not `core-sidebar`, and has been since this harness was
 * written. Check 13 could therefore never pass and check 14 passed vacuously.
 *
 * `offsetParent` is also the wrong signal for the drawer: the closed layer is hidden
 * with `invisible` (`visibility: hidden`), which keeps the element in the layout tree,
 * so `offsetParent` is non-null in BOTH states. The honest signals are the layer's own
 * `data-state`/`aria-hidden` and the panel's measured position — the closed panel is
 * translated a full width off-screen.
 */
const drawerState = (page) =>
  page.evaluate(() => {
    const layer = document.querySelector('[data-testid="core-mobile-drawer"]');
    const panel = document.querySelector('[data-testid="core-mobile-drawer-panel"]');
    const nav = document.querySelector('[data-testid="core-sidebar-drawer"]');
    const rect = panel?.getBoundingClientRect();
    return {
      state: layer?.getAttribute('data-state') ?? null,
      ariaHidden: layer?.getAttribute('aria-hidden') ?? null,
      onScreen: rect ? Math.round(rect.left) < window.innerWidth : false,
      left: rect ? Math.round(rect.left) : null,
      right: rect ? Math.round(rect.right) : null,
      links: nav ? nav.querySelectorAll('a[href]').length : 0,
    };
  });

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
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });
  page.on('requestfailed', (r) => {
    failedRequests.push(`FAILED ${r.url()} (${r.failure()?.errorText ?? 'unknown'})`);
  });

  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await page.type('input[name="email"]', EMAIL);
  await page.type('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(1200);

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
  await sleep(900);

  check('1. sidebar renders on /admin', !!(await page.$('[data-testid="core-sidebar"]')));
  check(
    '2. real identity from session',
    await page.evaluate(() => document.body.innerText.includes('admin@localhost')),
  );

  await page.screenshot({ path: `${OUT}/desktop-1440-light.png` });

  await page.click('[data-testid="theme-toggle"]');
  await sleep(600);
  const darkOn = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('dark'),
    attr: document.documentElement.getAttribute('data-theme'),
    ls: localStorage.getItem('aria-theme'),
  }));
  check('3. toggle switches to dark', darkOn.cls && darkOn.attr === 'dark', JSON.stringify(darkOn));
  await page.screenshot({ path: `${OUT}/desktop-1440-dark.png` });

  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(800);
  const persisted = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('dark'),
    ls: localStorage.getItem('aria-theme'),
  }));
  check(
    '4. theme persists across refresh',
    persisted.cls && persisted.ls === 'dark',
    JSON.stringify(persisted),
  );

  const collapseBtn = await page.$('button[aria-label="بستن منو"]');
  check('5. collapse control present', !!collapseBtn);
  if (collapseBtn) {
    await collapseBtn.click();
    await sleep(500);
    const c = await page.$eval('[data-testid="core-sidebar"]', (el) => el.dataset.collapsed);
    check('6. sidebar collapses', c === 'true', `data-collapsed=${c}`);
    const expandBtn = await page.$('button[aria-label="باز کردن منو"]');
    check('7. expand control present when collapsed', !!expandBtn);
    if (expandBtn) {
      await expandBtn.click();
      await sleep(500);
    }
    const r = await page.$eval('[data-testid="core-sidebar"]', (el) => el.dataset.collapsed);
    check('8. sidebar re-expands', r === 'false', `data-collapsed=${r}`);
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  const fake = ['درآمد', 'فروش ماه', 'نمودار', 'رشد ماهانه'].filter((m) => bodyText.includes(m));
  check('9. no fabricated KPI copy', fake.length === 0, fake.join(', '));

  await page.goto(`${BASE}/admin/blog`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  const blogTitle = await page.$eval('h1', (el) => el.textContent?.trim() ?? '').catch(() => '');
  check('10. /admin/blog renders', blogTitle.length > 0, blogTitle);
  await page.screenshot({ path: `${OUT}/desktop-1440-blog-dark.png` });

  for (const [w, h] of [
    [1280, 800],
    [1024, 768],
  ]) {
    await page.setViewport({ width: w, height: h });
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
    await sleep(800);
    await page.screenshot({ path: `${OUT}/desktop-${w}x${h}-dark.png` });
  }

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
  await sleep(900);
  await page.screenshot({ path: `${OUT}/mobile-390-dark.png` });

  const rails = await visibleRails(page);
  check('11. mobile hides persistent rail', rails === 0, `visible=${rails}`);

  const burger = await page.$('button[aria-label="نمایش منو"]');
  check('12. mobile menu trigger present', !!burger);
  if (burger) {
    await burger.click();
    await sleep(700);
    const opened = await drawerState(page);
    check(
      '13. mobile drawer opens',
      opened.state === 'open' && opened.ariaHidden === 'false' && opened.onScreen && opened.links > 0,
      JSON.stringify(opened),
    );
    await page.screenshot({ path: `${OUT}/mobile-390-drawer-dark.png` });
    /*
     * The panel is anchored `start-0`, which under <html dir="rtl"> is the RIGHT edge,
     * and it is 280px wide in a 390px viewport — measured left=110, right=390. The
     * exposed backdrop strip is therefore the 110px on the LEFT, not the right. The
     * previous x=360 landed ON the panel, so this click tested nothing.
     */
    await page.mouse.click(50, 400);
    await sleep(700);
    const closed = await drawerState(page);
    check(
      '14. mobile drawer closes on backdrop click',
      closed.state === 'closed' && closed.ariaHidden === 'true' && !closed.onScreen,
      JSON.stringify(closed),
    );
  }

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
  await sleep(800);
  await page.click('[data-testid="theme-toggle"]');
  await sleep(700);
  const light = await page.evaluate(() => localStorage.getItem('aria-theme'));
  check('15. toggle returns to light', light === 'light', String(light));
  await page.screenshot({ path: `${OUT}/mobile-390-light.png` });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/admin/profile`, { waitUntil: 'networkidle2' });
  await sleep(1200);
  check(
    '16. /admin/profile renders account data',
    await page.evaluate(() => document.body.innerText.includes('اطلاعات حساب')),
  );
  await page.screenshot({ path: `${OUT}/desktop-1440-profile-light.png` });

  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle2' });
  await sleep(900);
  await page.screenshot({ path: `${OUT}/desktop-1440-light-final.png` });

  const avatarBtn = await page.$('button[aria-haspopup="menu"]');
  check('17. user menu trigger present', !!avatarBtn);
  if (avatarBtn) {
    await avatarBtn.click();
    await sleep(500);
    const items = await page.$$eval('[role="menuitem"]', (els) =>
      els.map((e) => e.textContent?.trim()),
    );
    check('18. user menu has 2 items', items.length === 2, items.join(' | '));
    const menuItems = await page.$$('[role="menuitem"]');
    await menuItems[menuItems.length - 1].click();
    await sleep(2500);
    check('19. logout redirects to /login', page.url().includes('/login'), page.url());
  }

  const jwt = consoleMessages.filter((m) => /eyJ[A-Za-z0-9_-]{8,}\./.test(m));
  check('20. no JWT in console', jwt.length === 0, jwt.slice(0, 2).join(' || '));

  // Known-benign / pre-existing, all outside the Phase 48C frontend-styling scope:
  //  - layout.tsx links /manifest.json, /favicon.ico and /apple-touch-icon.png but
  //    apps/web/public only ships assets/ + robots.txt.
  //  - the jsdelivr Vazirmatn font CSS is unreachable through the local proxy
  //    (same block that fails `docker compose build web`).
  //  - GET /api/v1/blog/admin 500 is the known blog-api issue seen during next build.
  const benign =
    /manifest\.json|favicon\.ico|apple-touch-icon\.png|cdn\.jsdelivr\.net|\/api\/v1\/blog\/admin/;
  const realFailures = [...new Set(failedRequests)].filter((u) => !benign.test(u));
  check(
    '21. no unexpected failed requests',
    realFailures.length === 0,
    realFailures.slice(0, 5).join(' || '),
  );

  const appErrors = consoleMessages.filter(
    (m) => m.startsWith('pageerror:') || (m.startsWith('error:') && !/Failed to load resource|Manifest fetch/.test(m)),
  );
  check('22. no application console errors', appErrors.length === 0, appErrors.slice(0, 4).join(' || '));

  await browser.close();

  console.log('\n=== SUMMARY ===');
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  for (const f of results.filter((r) => !r.ok)) {
    console.log(` FAILED: ${f.name} :: ${f.detail}`);
  }
  console.log('\n=== CONSOLE TAIL ===');
  console.log(consoleMessages.slice(-20).join('\n'));
}

main().catch((e) => {
  console.error('HARNESS ERROR', e);
  process.exit(1);
});
