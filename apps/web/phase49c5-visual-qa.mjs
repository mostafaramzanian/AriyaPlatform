// Phase 49C-5 CORRECTION BROWSER VISUAL QA GATE — support lives in the HEADER user menu.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// verifies the authoritative UX decision:
//   - «پشتیبانی» is gone from the STATIC sidebar rail while the services group
//     survives with «نظرسنجی‌ها» (no empty group),
//   - the Settings Center /admin/settings has NO support tab — exactly the five
//     pre-49C-5 domains remain, and the removed ?tab=support convention falls back
//     safely to the first visible tab,
//   - the EXISTING header user dropdown gains ONE menuitem «پشتیبانی» placed exactly
//     between «تنظیمات» and «خروج» with its life-buoy icon and href=/admin/support
//     (the ONLY support destination — no Settings query-string dependency),
//   - clicking it navigates to the EXISTING /admin/support page (title, ticket UI,
//     refresh, Back) while حساب من → /admin/profile and تنظیمات → /admin/settings
//     remain unchanged and Escape/outside-click still close the menu,
//   - no horizontal page overflow anywhere, RTL intact.
//
// Evidence = screenshots + physical metrics read FROM the rendered page. Scope: QA
// only — creates NO data and mutates NO persisted preferences.
//
// Targets the ALREADY-RUNNING dev servers: web :3000 against API :3001.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOPS = [
  [1280, 900, 'phase49c5-shots/qa-49c5-1280'],
  [1440, 900, 'phase49c5-shots/qa-49c5-1440'],
  [1920, 1080, 'phase49c5-shots/qa-49c5-1920'],
];
const MOBILES = [
  [360, 800, 'phase49c5-shots/qa-49c5-360'],
  [390, 844, 'phase49c5-shots/qa-49c5-390'],
  [430, 932, 'phase49c5-shots/qa-49c5-430'],
];

const findings = [];
const check = (ok, name, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

async function submitLogin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]');
  await sleep(7000);
  await page.click('input[name="email"]', { clickCount: 3 });
  await page.type('input[name="email"]', EMAIL);
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await sleep(9000);
}

async function signIn(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitLogin(page);
    if (!page.url().includes('/login')) return;
  }
  throw new Error('could not sign in after 3 attempts');
}

async function gotoShell(page, path = '/admin', dwellMs = 2500) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header', { timeout: 60000 });
  await sleep(dwellMs);
}
/** Static-rail metrics (pinned groups measured separately, 49C-3 convention). */
async function measureRail(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const rail = document.querySelector('[data-testid="core-sidebar"]');
    if (!rail) return null;
    const pinned = new Set(['favorites', 'recent']);
    const staticGroups = [...rail.querySelectorAll('[data-testid="core-nav-group"]')].filter(
      (g) => !pinned.has(g.getAttribute('data-group-id')),
    );
    return {
      groupIds: staticGroups.map((g) => g.getAttribute('data-group-id')),
      staticLabels: staticGroups.flatMap((g) =>
        [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) => n.textContent.trim()),
      ),
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
    };
  });
}

/**
 * Opens the EXISTING header user dropdown and reads its menuitems in DOM order.
 * The support entry must sit exactly between تنظیمات and خروج with the SAME visual
 * pattern as its siblings (icon aria-hidden, same row classes, same container).
 */
async function openUserMenu(page) {
  const opener = await page.$('header [aria-haspopup="menu"]');
  if (!opener) return null;
  // The chip toggles, so only click when the dropdown is actually closed — this makes
  // the helper idempotent for callers that leave the menu open (e.g. after a snapshot).
  const alreadyOpen = await page.$('[role="menu"][aria-label="منوی کاربر"]');
  if (!alreadyOpen) {
    await opener.click();
  }
  await page.waitForSelector('[role="menu"][aria-label="منوی کاربر"]', { timeout: 10000 });
  await sleep(400);
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => ({
      label: item.textContent.trim(),
      href: item.getAttribute('href'),
      hasIcon: Boolean(item.querySelector('svg')),
      iconAriaHidden: item.querySelector('svg')?.getAttribute('aria-hidden') ?? null,
      rowClass: item.getAttribute('class') ?? '',
    }));
    const mr = menu.getBoundingClientRect();
    return {
      items,
      fitsViewport: mr.right <= innerWidth + 1 && mr.left >= -1 && mr.top >= -1,
    };
  });
}

/** Settings Center metrics: exact tab set, no support tab, active panel, overflow. */
async function measureSettings(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const tablist = document.querySelector('[role="tablist"]');
    if (!tablist) return null;
    const tabs = [...tablist.querySelectorAll('[role="tab"]')].map((t) => ({
      label: t.textContent.trim(),
      selected: t.getAttribute('aria-selected'),
      controls: t.getAttribute('aria-controls'),
    }));
    const panel = document.querySelector('[role="tabpanel"]');
    const panelText = panel?.textContent ?? '';
    return {
      dir: document.documentElement.getAttribute('dir'),
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      tabs,
      hasSupportTab: tabs.some((t) => t.label === 'پشتیبانی'),
      captions: [...tablist.querySelectorAll('[role="presentation"]')].map((c) =>
        c.textContent.trim(),
      ),
      panelTextHasTicket: panelText.includes('تیکت'),
      panelHasNewTicketLink: Boolean(document.querySelector('a[href="/admin/support/new"]')),
      url: location.href,
    };
  });
}

/** Support page metrics: shell title + REAL ticket view fingerprints. */
async function measureSupport(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const h1 = document.querySelector('header h1')?.textContent?.trim() ?? '';
    const bodyText = document.body.textContent;
    return {
      title: h1,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      hasTicketWord: bodyText.includes('تیکت'),
      hasNewTicketLink: Boolean(document.querySelector('a[href="/admin/support/new"]')),
      hasTrackingInput: Boolean(document.querySelector('input')),
      url: location.href,
    };
  });
}
async function main() {
  await mkdir('phase49c5-shots', { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    // Drive the REAL system Chrome (same engine) instead of puppeteer's download.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userDataDir: 'qa-49c5-profile',
  });
  const page = await browser.newPage();
  let closingIntentionally = false;
  browser.on('disconnected', () => {
    if (!closingIntentionally) {
      console.error('HARNESS ERROR: browser disconnected');
      process.exit(1);
    }
  });
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(60000);

  console.log('== sign-in ==');
  await signIn(page);
  check(!page.url().includes('/login'), 'sign-in reaches the shell', page.url());

  // ========================================================================
  // SIDEBAR — support is out of the static rail, services group survives.
  // ========================================================================
  for (const [w, h, dir] of [...DESKTOPS, ...MOBILES]) {
    await mkdir(dir, { recursive: true });
    await page.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await gotoShell(page, '/admin');
    const rail = await measureRail(page);

    check(rail !== null, `shell ${w}: rail renders`);
    check(
      !rail.staticLabels.includes('پشتیبانی'),
      `shell ${w}: پشتیبانی absent from static rail`,
      rail.staticLabels.join(' | '),
    );
    check(rail.staticLabels.includes('نظرسنجی‌ها'), `shell ${w}: services group keeps نظرسنجی‌ها`);
    check(
      JSON.stringify(rail.groupIds) === JSON.stringify(['overview', 'content', 'services']),
      `shell ${w}: no empty group (overview/content/services intact)`,
      rail.groupIds.join(','),
    );
    check(!rail.horizontalOverflow, `shell ${w}: no horizontal page overflow`);
    await page.screenshot({ path: `${dir}/01-shell.png`, fullPage: false });
  }

  // ========================================================================
  // SETTINGS — the CORRECTED center has exactly five domains, no support tab.
  // ========================================================================
  await page.setViewport({ width: 1440, height: 900 });
  await mkdir('phase49c5-shots/qa-49c5-1440', { recursive: true });
  await gotoShell(page, '/admin/settings');
  {
    const m = await measureSettings(page);
    check(m !== null, 'settings 1440: tablist renders');
    check(m.tabs.length === 5, 'settings 1440: exactly five tabs', m.tabs.map((t) => t.label).join(' | '));
    check(!m.hasSupportTab, 'settings 1440: پشتیبانی tab is COMPLETELY absent');
    check(
      JSON.stringify(m.captions) === JSON.stringify(['شخصی', 'پلتفرم']),
      'settings 1440: two coherent group captions (no خدمات group)',
      m.captions.join(' | '),
    );
    const EXPECTED_FIVE = [
      'ظاهر و دسترس‌پذیری',
      'هوش مصنوعی',
      'اتوماسیون و یکپارچه‌سازی',
      'ماژول‌ها و سرویس‌های متصل',
      'لاگ‌ها و رخدادها',
    ].sort();
    check(
      JSON.stringify(m.tabs.map((t) => t.label).sort()) === JSON.stringify(EXPECTED_FIVE),
      'settings 1440: the pre-49C-5 five domains remain',
      m.tabs.map((t) => t.label).join(' | '),
    );
    check(
      m.tabs.every((t) => t.controls?.startsWith('settings-panel-')),
      'settings 1440: every tab wires aria-controls',
    );
    check(!m.panelTextHasTicket, 'settings 1440: appearance panel shows NO ticket UI');
    check(!m.horizontalOverflow, 'settings 1440: no horizontal page overflow');
    await page.screenshot({ path: 'phase49c5-shots/qa-49c5-1440/02-settings-five-tabs.png', fullPage: true });
  }

  // The removed ?tab=support convention falls back safely (no panel, no ticket read).
  await gotoShell(page, '/admin/settings?tab=support');
  {
    const m = await measureSettings(page);
    check(m.tabs[0]?.selected === 'true', 'settings 1440: ?tab=support falls back to the first visible tab', m.tabs[0]?.label ?? 'none');
    check(!m.hasSupportTab, 'settings 1440: no support tab from ?tab=support');
    check(!m.panelHasNewTicketLink, 'settings 1440: no support panel/link mounted from ?tab=support');
    check(!m.horizontalOverflow, 'settings 1440: no horizontal page overflow after fallback');
// ========================================================================
  // HEADER USER MENU — پشتیبانی sits exactly between تنظیمات and خروج (1440).
  // ========================================================================
  await gotoShell(page, '/admin');
  {
    const menu = await openUserMenu(page);
    check(menu !== null, 'header 1440: user dropdown opens on the user chip');
    check(
      JSON.stringify(menu.items.map((i) => i.label)) ===
        JSON.stringify(['حساب من', 'تنظیمات', 'پشتیبانی', 'خروج']),
      'header 1440: exact order — حساب من، تنظیمات، پشتیبانی، خروج',
      menu.items.map((i) => i.label).join(' | '),
    );
    const support = menu.items.find((i) => i.label === 'پشتیبانی');
    check(Boolean(support), 'header 1440: پشتیبانی menuitem exists');
    check(support?.href === '/admin/support', 'header 1440: پشتیبانی targets the existing /admin/support', support?.href ?? 'null');
    check(support?.hasIcon && support?.iconAriaHidden === 'true', 'header 1440: life-buoy icon present and decorative');
    check(
      menu.items.find((i) => i.label === 'حساب من')?.href === '/admin/profile',
      'header 1440: حساب من unchanged → /admin/profile',
    );
    check(
      menu.items.find((i) => i.label === 'تنظیمات')?.href === '/admin/settings',
      'header 1440: تنظیمات unchanged → /admin/settings',
    );
    check(menu.fitsViewport === true, 'header 1440: dropdown fits the viewport');
    await page.screenshot({ path: 'phase49c5-shots/qa-49c5-1440/03-user-menu-support.png', fullPage: false });
  }

  // Menu a11y: Escape still closes; outside click still closes.
  await openUserMenu(page);
  await page.keyboard.press('Escape');
  check(
    !(await page.$('[role="menu"][aria-label="منوی کاربر"]')),
    'header 1440: Escape closes the dropdown',
  );
  await openUserMenu(page);
  await page.mouse.click(5, 5);
  await sleep(400);
  check(
    !(await page.$('[role="menu"][aria-label="منوی کاربر"]')),
    'header 1440: outside click closes the dropdown',
  );

  // ========================================================================
  // HEADER → SUPPORT — the menu IS the canonical entry; direct route untouched.
  // ========================================================================
  await gotoShell(page, '/admin');
  await openUserMenu(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((i) => i.textContent.includes('پشتیبانی'))
      .click();
  });
  await sleep(2500);
  check(page.url().includes('/admin/support'), 'header 1440: clicking پشتیبانی navigates to /admin/support', page.url());
  {
    const s = await measureSupport(page);
    check(s.title === 'پشتیبانی', 'support 1440: page title = پشتیبانی', s.title);
    check(
      s.hasNewTicketLink && s.hasTrackingInput,
      'support 1440: real ticket view renders (new-ticket link + tracking input)',
    );
    check(s.hasTicketWord, 'support 1440: ticket list surface renders');
    check(!s.horizontalOverflow, 'support 1440: no horizontal page overflow');
    await page.screenshot({ path: 'phase49c5-shots/qa-49c5-1440/04-support-from-menu.png', fullPage: true });
  }
  // Refresh keeps the DIRECT route working (no Settings query-string dependency).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header', { timeout: 60000 });
  await sleep(2500);
  {
    const s = await measureSupport(page);
    check(page.url().includes('/admin/support'), 'support 1440: refresh keeps /admin/support', page.url());
    check(s.title === 'پشتیبانی', 'support 1440: title survives refresh');
    check(s.hasNewTicketLink, 'support 1440: real view survives refresh');
  }
  // Back returns to the origin page.
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await sleep(2500);
  check(!page.url().includes('/admin/support'), 'support 1440: Back leaves the support page', page.url());

  // حساب من and تنظیمات keep their untouched destinations.
  await openUserMenu(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((i) => i.textContent.includes('حساب من'))
      .click();
  });
  await sleep(2500);
  check(page.url().includes('/admin/profile'), 'shell 1440: حساب من still routes to /admin/profile', page.url());

  await openUserMenu(page);
  await page.evaluate(() => {
    [...document.querySelectorAll('[role="menuitem"]')]
      .find((i) => i.textContent.includes('تنظیمات'))
      .click();
  });
  await sleep(2500);
  check(page.url().includes('/admin/settings'), 'shell 1440: تنظیمات still routes to /admin/settings', page.url());
  }

  // Invalid tab still falls back safely (pre-existing convention).
  await gotoShell(page, '/admin/settings?tab=bogus');
  {
    const m = await measureSettings(page);
    check(m.tabs[0]?.selected === 'true', 'settings 1440: ?tab=bogus falls back to the first visible tab', m.tabs[0]?.label ?? 'none');
  }
// ========================================================================
  // EVERY VIEWPORT — header menu has support; mobile dropdown fits; no overflow.
  // ========================================================================
  for (const [w, h, dir] of [...DESKTOPS, ...MOBILES]) {
    await page.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await gotoShell(page, '/admin');
    const menu = await openUserMenu(page);
    check(
      menu?.items.some((i) => i.label === 'پشتیبانی'),
      `header ${w}: پشتیبانی menuitem visible`,
    );
    check(
      menu?.items.map((i) => i.label).indexOf('پشتیبانی') === 2,
      `header ${w}: پشتیبانی stays between تنظیمات and خروج`,
      menu?.items.map((i) => i.label).join(' | ') ?? 'null',
    );
    check(
      menu?.items.find((i) => i.label === 'پشتیبانی')?.href === '/admin/support',
      `header ${w}: پشتیبانی targets /admin/support`,
    );
    check(menu?.fitsViewport === true, `header ${w}: dropdown fits the viewport`);
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollWidth > doc.clientWidth + 1;
    });
    check(!overflow, `header ${w}: no horizontal page overflow`);
    await page.screenshot({ path: `${dir}/05-user-menu.png`, fullPage: false });
  }

  for (const [w, h, dir] of MOBILES) {
    // Settings tabs remain unchanged on mobile.
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoShell(page, '/admin/settings');
    const m = await measureSettings(page);
    check(m.tabs.length === 5, `settings ${w}: five tabs intact`, m.tabs.map((t) => t.label).join(' | '));
    check(!m.hasSupportTab, `settings ${w}: no support tab`);
    check(!m.horizontalOverflow, `settings ${w}: no horizontal page overflow`);
    await page.screenshot({ path: `${dir}/06-settings-five-tabs.png`, fullPage: true });

    // The support PAGE remains usable on mobile (unchanged behavior).
    await gotoShell(page, '/admin/support');
    const s = await measureSupport(page);
    check(s.title === 'پشتیبانی', `support ${w}: page title intact`);
    check(s.hasNewTicketLink, `support ${w}: real ticket view usable`);
    check(!s.horizontalOverflow, `support ${w}: no horizontal page overflow`);
    await page.screenshot({ path: `${dir}/04-support-direct.png`, fullPage: true });
  }

  closingIntentionally = true;
  await browser.close();

  const failed = findings.filter((f) => !f.ok);
  console.log('\n== SUMMARY ==');
  console.log(
    `total=${findings.length} pass=${findings.length - failed.length} fail=${failed.length}`,
  );
  if (failed.length > 0) {
    failed.forEach((f) => console.log(`FAILED :: ${f.name} :: ${f.detail}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});