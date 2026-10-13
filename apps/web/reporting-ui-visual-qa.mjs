// Phase REPORTING-UI: REAL BROWSER VISUAL/BEHAVIORAL QA for the Reporting landing page.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// verifies what the phase brief makes contractual:
//
//   - identity   : one h1 (the shell, titled «گزارش‌گیری» through the non-nav alias),
//                  page h2, empty-state h3 — hierarchy intact, no «پنل مدیریت» fallback;
//   - truth      : exact Persian copy inside the workspace, NO Latin/technical text,
//                  NO digits/fabricated figures, NO interactive element anywhere in the
//                  workspace (no false affordances), no loading/error theater;
//   - navigation : the rail carries NO row for /admin/reporting (a nav row is a
//                  platform-navigation decision — Production/Financial precedent);
//                  direct load, refresh, back/forward and the protected-route
//                  redirect to /login all behave;
//   - RTL        : <html dir="rtl">, the rail on the RIGHT of the content, no
//                  horizontal overflow at desktop/laptop/tablet/mobile widths, the
//                  mobile drawer opens over the page without breaking layout;
//   - polish     : keyboard entry lands on the skip link first, the theme toggle
//                  survives both themes, and the browser console stays clean.
//
// Evidence = screenshots in `reporting-ui-qa-shots/` (untracked, per repository
// convention) + PASS/FAIL lines below. Exit code is non-zero if any check fails.
//
// REQUIREMENTS (this harness starts neither):
//   web : http://localhost:3003  (Next dev server serving the CURRENT source)
//   api : http://localhost:3001  (the combined runtime behind NEXT_PUBLIC_API_URL)
//
// ONE BROWSER MECHANISM: `puppeteer` (already a devDependency) driving the REAL system
// Chrome — exactly `phase49c3-visual-qa.mjs` and `phase51hr2d-hr-browser-e2e.mjs` do.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3003';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'reporting-ui-qa-shots';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

/** The dev server compiles the route on first hit; every wait gets the same budget. */
const WAIT = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
function check(ok, name, detail = '') {
  findings.push({ ok: !!ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
}

/** Everything a user can READ on the page — used for the Persian/no-digits truth rules. */
const workspaceText = (page) =>
  page.$eval('[data-testid="reporting-view"]', (el) => el.textContent || '');

/** Physical metrics read FROM the rendered page — never inferred from intent. */
const metrics = (page) =>
  page.evaluate(() => ({
    dir: document.documentElement.getAttribute('dir'),
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    h1s: [...document.querySelectorAll('h1')].map((h) => (h.textContent || '').trim()),
    h2s: [...document.querySelectorAll('h2')].map((h) => (h.textContent || '').trim()),
    h3s: [...document.querySelectorAll('h3')].map((h) => (h.textContent || '').trim()),
    headerTitle: (document.querySelector('header h1')?.textContent || '').trim(),
    workspaceInteractive: document.querySelectorAll(
      '[data-testid="reporting-workspace"] a, [data-testid="reporting-workspace"] button, [data-testid="reporting-workspace"] input, [data-testid="reporting-workspace"] select, [data-testid="reporting-workspace"] textarea, [data-testid="reporting-workspace"] [tabindex]'
    ).length,
    railReportingLinks: [...document.querySelectorAll('a[href="/admin/reporting"]')].length,
    contentTop: document.querySelector('#content')?.getBoundingClientRect().top ?? null,
    railRight: (() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      if (!rail) return null;
      const rect = rail.getBoundingClientRect();
      return rect.width > 0 ? rect.right : null;
    })(),
    railLeft: (() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      if (!rail) return null;
      const rect = rail.getBoundingClientRect();
      return rect.width > 0 ? rect.left : null;
    })(),
    contentLeft: document.querySelector('#content')?.getBoundingClientRect().left ?? null,
    activeElementTag: document.activeElement?.tagName ?? null,
    activeElementClass: document.activeElement?.className ?? '',
  }));

async function submitLogin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForSelector('button[type="submit"]', { timeout: WAIT });
  await sleep(3000);
  await page.click('input[name="email"]', { clickCount: 3 });
  await page.type('input[name="email"]', EMAIL);
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await sleep(6000);
}

async function signIn(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitLogin(page);
    if (!page.url().includes('/login')) return;
  }
  throw new Error('could not sign in after 3 attempts');
}

/** Opens the Reporting route and waits for the shell + view to settle. */
async function gotoReporting(page, dwellMs = 2500) {
  await page.goto(`${BASE}/admin/reporting`, { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForSelector('[data-testid="reporting-view"]', { timeout: WAIT });
  await sleep(dwellMs);
}

/** The truth rules, asserted on the METRICS of one rendered visit. */
async function assertReportingTruth(page, label) {
  const m = await metrics(page);
  const text = await workspaceText(page);

  check(m.dir === 'rtl', `${label}: document is RTL (dir=rtl)`, `dir=${m.dir}`);
  check(m.h1s.length === 1, `${label}: exactly ONE h1 in the document`, JSON.stringify(m.h1s));
  check(
    m.headerTitle === 'گزارش‌گیری',
    `${label}: shell header title resolves through the alias (never «پنل مدیریت»)`,
    `header=${m.headerTitle}`
  );
  check(m.h1s[0] === 'گزارش‌گیری', `${label}: the h1 reads «گزارش‌گیری»`, m.h1s[0]);
  check(
    m.h2s.includes('گزارش‌گیری'),
    `${label}: page h2 reads «گزارش‌گیری»`,
    JSON.stringify(m.h2s)
  );
  check(
    m.h3s.includes('در حال حاضر گزارشی وجود ندارد'),
    `${label}: empty-state h3 is the calm sentence`,
    JSON.stringify(m.h3s)
  );
  check(
    text.includes('فضای کاری گزارش‌های سازمان شما') &&
      text.includes('گزارش‌های موردنیاز شما در این بخش در دسترس قرار خواهند گرفت.'),
    `${label}: both Persian sentences render verbatim`
  );
  check(
    !/[A-Za-z]/.test(text),
    `${label}: workspace text carries NO Latin/technical vocabulary`,
    JSON.stringify(text.slice(0, 120))
  );
  check(!/[0-9۰-۹]/.test(text), `${label}: workspace text carries NO fabricated digits/figures`);
  check(
    m.workspaceInteractive === 0,
    `${label}: workspace offers NO affordance (links/buttons/inputs/tabindex = 0)`,
    `found=${m.workspaceInteractive}`
  );
  check(
    m.railReportingLinks === 0,
    `${label}: NO navigation row points at /admin/reporting (platform-nav decision)`,
    `found=${m.railReportingLinks}`
  );
  check(
    m.scrollWidth <= m.innerWidth + 1,
    `${label}: no horizontal overflow`,
    `scrollWidth=${m.scrollWidth} innerWidth=${m.innerWidth}`
  );
  return m;
}

/** Console/page errors collected across the whole run. Favicon noise and the dev-only
 *  HMR socket dying on a back-forward-cache restore are infrastructure, not the app:
 *  production serves no `webpack-hmr` endpoint at all. */
const consoleErrors = [];
const watchConsole = (page, label) => {
  page.on('pageerror', (err) => consoleErrors.push(`${label} :: pageerror :: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon/i.test(text)) return;
    if (/webpack-hmr|Back-Forward Cache/i.test(text)) return;
    consoleErrors.push(`${label} :: console :: ${text}`);
  });
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=1'],
  });

  // ---------------------------------------------------------------------
  // 1. AUTHENTICATED SESSION — desktop truth pass.
  // ---------------------------------------------------------------------
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  watchConsole(page, 'session');
  await signIn(page);

  await gotoReporting(page);
  const desktop = await assertReportingTruth(page, 'desktop-1440');

  // RTL structure: the rail is anchored to the RIGHT edge under dir=rtl, and the
  // content sits to its LEFT — measured, not assumed.
  check(
    desktop.railRight !== null && desktop.railRight >= desktop.innerWidth - 8,
    'desktop-1440: sidebar rail hugs the RIGHT edge (native RTL, not mirrored)',
    `railRight=${desktop.railRight} innerWidth=${desktop.innerWidth}`
  );
  check(
    desktop.railLeft !== null &&
      desktop.contentLeft !== null &&
      desktop.railLeft > desktop.contentLeft,
    'desktop-1440: content sits LEFT of the rail (reading order flows right-to-left)',
    `railLeft=${desktop.railLeft} contentLeft=${desktop.contentLeft}`
  );
  await page.screenshot({ path: `${OUT}/desktop-1440-reporting.png` });

  // Sibling reference: the Reporting page beside a mature screen — same product, same
  // chrome, same density (phase brief §2: never designed in isolation).
  await page.goto(`${BASE}/admin/hr`, { waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForSelector('[data-testid="hr-dashboard"]', { timeout: WAIT });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/desktop-1440-reference-hr.png` });

  // ---------------------------------------------------------------------
  // 2. ROUTE BEHAVIOR — refresh, back/forward, protected redirect.
  // ---------------------------------------------------------------------
  await gotoReporting(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForSelector('[data-testid="reporting-view"]', { timeout: WAIT });
  check(
    (await page.$('h2')) !== null,
    'refresh: the page survives a hard reload with its identity intact'
  );

  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: WAIT });
  await sleep(2500);
  await gotoReporting(page, 1500);
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: WAIT });
  await sleep(2500);
  check(
    !page.url().includes('/admin/reporting'),
    'back navigation: leaves the Reporting route normally',
    page.url()
  );
  await page.goForward({ waitUntil: 'domcontentloaded', timeout: WAIT });
  await page.waitForSelector('[data-testid="reporting-view"]', { timeout: WAIT });
  check(true, 'forward navigation: returns to the Reporting route and renders it');

  // ---------------------------------------------------------------------
  // 3. KEYBOARD & THEME — skip link first, focus visible, both themes clean.
  // ---------------------------------------------------------------------
  await gotoReporting(page, 1500);
  await page.keyboard.press('Tab');
  const firstStop = await page.evaluate(() => ({
    cls: document.activeElement?.className ?? '',
    text: (document.activeElement?.textContent ?? '').trim(),
  }));
  check(
    firstStop.cls.includes('skip-link'),
    'keyboard: the FIRST tab stop is the skip link (accessible entry)',
    JSON.stringify(firstStop)
  );

  const focusWalk = [];
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    focusWalk.push(await page.evaluate(() => document.activeElement?.tagName ?? 'null'));
  }
  check(
    focusWalk.every((tag) => tag && tag !== 'BODY' && tag !== 'null'),
    'keyboard: focus keeps moving through real controls, never stalling on <body>',
    JSON.stringify(focusWalk)
  );

  // Theme: flip-based, because the painted starting theme is whatever the OS reports
  // (headless Chrome prefers dark), so "one click → dark" would be a direction-blind
  // assertion. The invariant that matters (48C): one click FLIPS `data-theme`, the
  // `.dark` class agrees with it, and a second click restores the original state —
  // and the empty state must read calm in BOTH themes (§15).
  const themeSnap = () =>
    page.evaluate(() => ({
      attr: document.documentElement.getAttribute('data-theme'),
      dark: document.documentElement.classList.contains('dark'),
    }));
  const themeA = await themeSnap();
  await page.click('[data-testid="theme-toggle"]');
  await sleep(1200);
  const themeB = await themeSnap();
  check(
    themeA.attr !== themeB.attr,
    'theme: one click FLIPS the painted theme',
    `${themeA.attr} -> ${themeB.attr}`
  );
  check(
    themeB.dark === (themeB.attr === 'dark'),
    'theme: the .dark class and data-theme always agree',
    JSON.stringify(themeB)
  );
  // Note: viewport-only screenshots (no fullPage). Puppeteer's fullPage capture
  // rewrites the document viewport during capture; on an RTL layout the capture
  // canvas is offset (a capture-pipeline artifact proven by pixel probe: the live
  // DOM reports card rect left=24/right=744 while the fullPage capture renders the
  // same card shifted ~+217px). Viewport-only capture reads the exact pixels the
  // user sees, so it is the correct evidence mode for this harness.
  await page.screenshot({ path: `${OUT}/desktop-1440-reporting-theme-b.png` });
  await page.click('[data-testid="theme-toggle"]');
  await sleep(1200);
  const themeA2 = await themeSnap();
  check(
    themeA2.attr === themeA.attr,
    'theme: a second click restores the original theme',
    `${themeA.attr} <- ${themeA2.attr}`
  );

  // ---------------------------------------------------------------------
  // 4. RESPONSIVE — laptop / tablet / mobile: no overflow, hierarchy intact.
  // ---------------------------------------------------------------------
  const VIEWPORTS = [
    [1280, 900, 'laptop-1280'],
    [768, 1024, 'tablet-768'],
    [390, 844, 'mobile-390'],
    [360, 800, 'mobile-360'],
  ];
  for (const [width, height, label] of VIEWPORTS) {
    await page.setViewport({ width, height });
    await gotoReporting(page, 1800);
    const m = await assertReportingTruth(page, label);
    check(
      m.h2s.length >= 1 && m.h3s.length >= 1,
      `${label}: hierarchy survives the width (h2 + h3 still render)`
    );
    await page.screenshot({ path: `${OUT}/${label}-reporting.png` });
  }

  // Mobile drawer: the established shell navigation opens over the page without
  // creating overflow, and closes cleanly (§19: consistent shell behavior).
  await page.setViewport({ width: 390, height: 844 });
  await gotoReporting(page, 1500);
  await page.click('button[aria-label="نمایش منو"]');
  await sleep(900);
  const drawer = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="core-mobile-drawer"]');
    return {
      state: el?.getAttribute('data-state') ?? 'absent',
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  check(drawer.state === 'open', 'mobile: the shell drawer opens from the header', drawer.state);
  check(
    drawer.scrollWidth <= drawer.innerWidth + 1,
    'mobile: no horizontal overflow while the drawer is open',
    `scrollWidth=${drawer.scrollWidth} innerWidth=${drawer.innerWidth}`
  );
  await page.screenshot({ path: `${OUT}/mobile-390-drawer.png` });
  await page.click('[data-testid="core-mobile-overlay"]');
  await sleep(900);

  // ---------------------------------------------------------------------
  // 5. PROTECTED ROUTE — a signed-out visitor is sent to /login, never shown a
  //    half-rendered shell (the inherited CoreShell redirect, exercised here).
  //    The visitor gets an ISOLATED browser context: puppeteer pages share
  //    localStorage by default, so a "new page" in the session context would
  //    carry the admin's token and prove nothing.
  // ---------------------------------------------------------------------
  const anonCtx = await browser.createBrowserContext();
  const anon = await anonCtx.newPage();
  await anon.setViewport({ width: 1280, height: 900 });
  watchConsole(anon, 'anon');
  await anon.goto(`${BASE}/admin/reporting`, { waitUntil: 'domcontentloaded', timeout: WAIT });
  let redirected = false;
  try {
    await anon.waitForFunction(() => location.pathname === '/login', { timeout: 20000 });
    redirected = true;
  } catch {
    redirected = false;
  }
  check(
    redirected,
    'protected route: a signed-out visitor lands on /login, not on the page',
    anon.url()
  );
  await anonCtx.close();

  // ---------------------------------------------------------------------
  // 6. CONSOLE HYGIENE + SUMMARY.
  // ---------------------------------------------------------------------
  check(
    consoleErrors.length === 0,
    'console: zero page errors / console errors across the whole run',
    consoleErrors.slice(0, 5).join(' | ')
  );

  await browser.close();

  const failed = findings.filter((f) => !f.ok);
  console.log('');
  console.log(`REPORTING UI QA :: ${findings.length - failed.length}/${findings.length} passed`);
  if (failed.length > 0) {
    console.log('FAILED CHECKS:');
    for (const f of failed) console.log(`  - ${f.name} :: ${f.detail}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('QA HARNESS ERROR ::', err);
  process.exit(1);
});
