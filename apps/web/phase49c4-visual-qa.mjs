// Phase 49C-4 BROWSER VISUAL QA GATE — account module access + home UX cleanup.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// verifies that:
//   - the Home dashboard no longer renders «دسترسی سریع» or «ماژول‌های در دسترس»,
//     with the remaining four widgets reflowing and no page overflow,
//   - «حساب من» (/admin/profile) has a fourth tab «ماژول‌های در دسترس» that is
//     URL-addressable (?tab=modules), keyboard-operable (RTL arrows, Home/End),
//     and renders ONLY modules the signed-in admin can actually open,
//   - the sidebar, header user menu, and settings stay untouched.
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
  [1280, 900, 'phase49c4-shots/qa-49c4-1280'],
  [1440, 900, 'phase49c4-shots/qa-49c4-1440'],
  [1920, 1080, 'phase49c4-shots/qa-49c4-1920'],
];
const MOBILES = [
  [360, 800, 'phase49c4-shots/qa-49c4-360'],
  [390, 844, 'phase49c4-shots/qa-49c4-390'],
  [430, 932, 'phase49c4-shots/qa-49c4-430'],
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

/** Opens any /admin path and waits for the shell chrome to settle. */
async function gotoShell(page, path = '/admin', dwellMs = 2500) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header', { timeout: 60000 });
  await sleep(dwellMs);
}

/** Physical dashboard metrics read from the rendered home page. */
async function measureHome(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const widgets = [...document.querySelectorAll('[data-testid="core-widget"]')].map((w) =>
      w.getAttribute('data-widget-id'),
    );
    const headings = [...document.querySelectorAll('[data-testid="core-widget"] h2')].map((h) =>
      h.textContent.trim(),
    );
    return {
      dir: document.documentElement.getAttribute('dir'),
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      widgets,
      headings,
      hasQuickAccessTestid: Boolean(
        document.querySelector('[data-testid="core-widget-quick-actions"]'),
      ),
      hasModulesTestid: Boolean(document.querySelector('[data-testid="core-widget-modules"]')),
      widgetCount: widgets.length,
    };
  });
}

/** Physical account-page metrics for the modules tab. */
async function measureAccountModules(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => ({
      label: t.textContent.trim(),
      selected: t.getAttribute('aria-selected'),
      controls: t.getAttribute('aria-controls'),
      tabindex: t.getAttribute('tabindex'),
    }));
    const modulesTab = tabs.find((t) => t.label === 'ماژول‌های در دسترس');
    const panel = document.getElementById('account-panel-modules');
    const list = document.querySelector('[data-testid="core-modules-list"]');
    const pills = list
      ? [...list.querySelectorAll('[data-testid="core-widget-link"]')].map((a) => ({
          label: a.textContent.trim(),
          href: a.getAttribute('href'),
          width: a.getBoundingClientRect().width,
        }))
      : [];
    const tablist = document.querySelector('[role="tablist"]');
    const tablistRect = tablist?.getBoundingClientRect();
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const activeRect = activeTab?.getBoundingClientRect();
    return {
      dir: document.documentElement.getAttribute('dir'),
      viewportWidth: innerWidth,
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      tabs,
      modulesTab,
      panelId: panel?.id ?? null,
      panelVisible: panel ? panel.getBoundingClientRect().height > 0 : false,
      pillCount: pills.length,
      pills,
      heading: document.getElementById('account-modules-heading')?.textContent?.trim() ?? null,
      tablistScrollable: tablistRect ? tablist.scrollWidth > tablist.clientWidth + 1 : null,
      tablistOverflowContained: tablistRect ? tablistRect.right <= innerWidth + 1 : null,
      activeTabVisible: activeRect
        ? activeRect.right > 0 && activeRect.left < innerWidth && activeRect.width > 0
        : false,
      url: location.href,
    };
  });
}

async function main() {
  await mkdir('phase49c4-shots', { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    // Puppeteer 25's pinned download is absent from the local cache; drive the REAL
    // system Chrome (same engine) instead of downloading a second copy.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userDataDir: 'qa-49c4-profile',
  });
  const page = await browser.newPage();
  // An UNEXPECTED browser death must fail the gate loudly; an intentional
  // browser.close() at the end must not. The flag separates the two.
  let closingIntentionally = false;
  browser.on('disconnected', () => {
    if (!closingIntentionally) {
      console.error('HARNESS ERROR: browser disconnected');
      process.exit(1);
    }
  });
  page.setDefaultTimeout(45000);
  page.setDefaultNavigationTimeout(60000);
  page.on('requestfailed', (req) => {
    console.log(`REQFAIL ${req.resourceType()} ${req.url()}`);
  });

  console.log('== sign-in ==');
  await signIn(page);
  check(!page.url().includes('/login'), 'sign-in reaches the shell', page.url());

  // ========================================================================
  // HOME — quick access and modules cards are gone, the rest reflows.
  // ========================================================================
  for (const [w, h, dir] of [...DESKTOPS, ...MOBILES]) {
    await mkdir(dir, { recursive: true });
    await page.setViewport({ width: w, height: h });
    await gotoShell(page, '/admin');
    const m = await measureHome(page);

    check(!m.hasQuickAccessTestid, `home ${w}: no quick-actions widget testid`);
    check(!m.hasModulesTestid, `home ${w}: no modules widget testid`);
    check(
      !m.headings.includes('دسترسی سریع') && !m.headings.includes('ماژول‌های در دسترس'),
      `home ${w}: neither card heading renders`,
      m.headings.join(' | '),
    );
    check(
      m.widgetCount === 4 && m.widgets.join(',') === 'identity,access,notifications,reminders',
      `home ${w}: exactly the four remaining widgets in registry order`,
      m.widgets.join(','),
    );
    check(!m.horizontalOverflow, `home ${w}: no horizontal page overflow`);
    await page.screenshot({ path: `${dir}/01-home.png`, fullPage: true });
  }

  // Home still contains the hero and the widgets grid (reflow, not a blank page).
  {
    await mkdir('phase49c4-shots/qa-49c4-1440', { recursive: true });
    await page.setViewport({ width: 1440, height: 900 });
    await gotoShell(page, '/admin');
    const hero = await page.evaluate(() =>
      Boolean([...document.querySelectorAll('h2')].find((h) => h.textContent.includes('خوش آمدید'))),
    );
    check(hero, 'home 1440: hero panel still present');
    await page.screenshot({ path: 'phase49c4-shots/qa-49c4-1440/02-home-viewport.png' });
  }

  // ========================================================================
  // ACCOUNT — the new modules tab (desktop deep-dive at 1440).
  // ========================================================================
  await page.setViewport({ width: 1440, height: 900 });

  // URL-addressable direct navigation.
  await gotoShell(page, '/admin/profile?tab=modules');
  {
    const m = await measureAccountModules(page);
    check(m.url.includes('tab=modules'), 'account 1440: direct URL lands on ?tab=modules', m.url);
    check(m.modulesTab?.selected === 'true', 'account 1440: modules tab aria-selected');
    check(m.panelId === 'account-panel-modules' && m.panelVisible, 'account 1440: modules panel visible');
    check(m.heading === 'ماژول‌های در دسترس', 'account 1440: panel heading correct', m.heading ?? '');
    check(
      m.tabs.every((t) => t.controls?.startsWith('account-panel-')),
      'account 1440: every tab wires aria-controls',
    );
    check(m.pillCount > 0, 'account 1440: module pills render for the admin', String(m.pillCount));
    check(
      m.pills.every((p) => p.href?.startsWith('/admin')),
      'account 1440: every pill is an /admin target',
      m.pills.map((p) => p.href).join(','),
    );
    // The three rail-deduplicated personal destinations are STILL legitimate module
    // rows here (visibleNavGroups, not railNavGroups) — hiding from the rail was
    // never unauthorizing.
    const labels = m.pills.map((p) => p.label);
    check(
      labels.includes('حساب من') && labels.includes('اعلان‌ها') && labels.includes('تقویم'),
      'account 1440: personal destinations still resolve as modules',
      labels.join(' | '),
    );
    check(
      m.pills.every((p) => p.width > 0 && p.width <= m.viewportWidth),
      'account 1440: no over-wide pill',
    );
    check(!m.horizontalOverflow, 'account 1440: no horizontal page overflow');
    await page.screenshot({ path: 'phase49c4-shots/qa-49c4-1440/03-account-modules.png', fullPage: true });
  }

  // Click path: tabs → modules, URL updates.
  await gotoShell(page, '/admin/profile');
  {
    await page.evaluate(() => {
      [...document.querySelectorAll('[role="tab"]')]
        .find((t) => t.textContent.includes('ماژول‌های در دسترس'))
        .click();
    });
    await sleep(1500);
    const m = await measureAccountModules(page);
    check(m.url.includes('tab=modules'), 'account 1440: tab click updates the URL', m.url);
    check(m.modulesTab?.selected === 'true' && m.panelVisible, 'account 1440: tab click shows the panel');
  }

  // Refresh preserves the URL state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('header', { timeout: 60000 });
  await sleep(2500);
  {
    const m = await measureAccountModules(page);
    check(m.modulesTab?.selected === 'true', 'account 1440: refresh preserves ?tab=modules');
  }

  // Invalid tab falls back safely to the profile tab.
  await gotoShell(page, '/admin/profile?tab=bogus');
  {
    const m = await page.evaluate(() => {
      const selected = document.querySelector('[role="tab"][aria-selected="true"]');
      return { label: selected?.textContent.trim(), url: location.href };
    });
    check(m.label === 'مشخصات حساب', 'account 1440: invalid tab falls back to profile', m.label ?? '');
  }

  // Keyboard: RTL arrows, Home/End, roving tabindex, focus follows selection.
  await gotoShell(page, '/admin/profile');
  {
    const press = async (key) => {
      await page.keyboard.press(key);
      await sleep(700);
      return page.evaluate(() => ({
        selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim(),
        focused: document.activeElement?.textContent.trim(),
        focusedSelected: document.activeElement?.getAttribute('aria-selected'),
        tabindexes: [...document.querySelectorAll('[role="tab"]')]
          .map((t) => t.getAttribute('tabindex'))
          .join(','),
      }));
    };

    await page.evaluate(() => {
      document.querySelector('[role="tab"][aria-selected="true"]')?.focus();
    });
    let s = await press('ArrowLeft');
    check(
      s.selected === 'نشست‌های فعال' && s.focusedSelected === 'true',
      'account 1440: RTL ArrowLeft moves forward',
      `${s.selected} / focus=${s.focused}`,
    );
    s = await press('ArrowLeft');
    s = await press('ArrowLeft');
    check(s.selected === 'ماژول‌های در دسترس', 'account 1440: RTL arrows reach the new fourth tab', s.selected);
    check(s.tabindexes === '-1,-1,-1,0', 'account 1440: roving tabindex follows selection', s.tabindexes);
    s = await press('End');
    check(s.selected === 'ماژول‌های در دسترس', 'account 1440: End stays on the last tab', s.selected);
    s = await press('Home');
    check(s.selected === 'مشخصات حساب', 'account 1440: Home returns to the first tab', s.selected);
    await page.screenshot({ path: 'phase49c4-shots/qa-49c4-1440/04-account-profile.png' });
  }

  // Sidebar unaffected (49C-3 contract still holds) + user menu still works.
  {
    const rail = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="core-sidebar"]');
      const pinned = new Set(['favorites', 'recent']);
      return [...r.querySelectorAll('[data-testid="core-nav-group"]')]
        .filter((g) => !pinned.has(g.getAttribute('data-group-id')))
        .flatMap((g) =>
          [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) => n.textContent.trim()),
        );
    });
    check(
      !rail.includes('حساب من') && !rail.includes('اعلان‌ها') && !rail.includes('تقویم'),
      'shell 1440: sidebar static rail still deduplicated (49C-3 intact)',
      rail.join(' | '),
    );
    await page.click('header [aria-haspopup="menu"]');
    await page.waitForSelector('[role="menu"]', { timeout: 10000 });
    await sleep(400);
    const menu = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent.trim()),
    );
    check(
      menu.some((t) => t.includes('حساب من')) && menu.some((t) => t.includes('تنظیمات')),
      'shell 1440: header user menu still offers حساب من and تنظیمات',
      menu.join(' | '),
    );
    await page.keyboard.press('Escape');
  }

  // Settings unaffected.
  await gotoShell(page, '/admin/settings');
  {
    const title = await page.evaluate(() =>
      document.querySelector('header h1')?.textContent?.trim(),
    );
    check(title === 'تنظیمات', 'shell 1440: settings page still renders', title ?? '');
    await page.screenshot({ path: 'phase49c4-shots/qa-49c4-1440/05-settings.png' });
  }

  // ========================================================================
  // MOBILE — tablist usable, only the tablist may scroll, no page overflow.
  // ========================================================================
  for (const [w, h, dir] of MOBILES) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoShell(page, '/admin/profile?tab=modules');
    const m = await measureAccountModules(page);
    check(m.modulesTab?.selected === 'true', `account ${w}: modules tab active from URL`);
    check(m.activeTabVisible, `account ${w}: active tab visible within the viewport`);
    check(!m.horizontalOverflow, `account ${w}: no horizontal PAGE overflow`);
    check(
      m.tablistScrollable === false || m.tablistOverflowContained === true,
      `account ${w}: any tablist scroll is contained (only the tablist scrolls)`,
      `scrollable=${m.tablistScrollable}`,
    );
    check(m.pillCount > 0, `account ${w}: module pills render`, String(m.pillCount));
    check(m.pills.every((p) => p.width <= w), `account ${w}: no pill overflows the viewport`);
    await page.screenshot({ path: `${dir}/01-account-modules.png`, fullPage: true });

    await gotoShell(page, '/admin');
    const home = await measureHome(page);
    check(!home.horizontalOverflow, `home ${w}: no horizontal page overflow`);
    check(home.widgetCount === 4, `home ${w}: four widgets`, home.widgets.join(','));
    await page.screenshot({ path: `${dir}/02-home.png`, fullPage: true });
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





