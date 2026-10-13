// Phase 49C-2 FINAL BROWSER VISUAL QA GATE.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// exercises the Unified Settings Center: sidebar cleanup, tab semantics, permission
// surface (as the admin user), URL tab state, keyboard behaviour, and the existing
// header user dropdown. Evidence = screenshots + physical metrics read FROM the
// rendered page — never from source inspection or Jest.
//
// Scope: QA evidence only. It creates NO data and mutates NO user preferences: the
// app's real text-scale mechanism (`data-text-scale` on <html>) is set per page load
// and never persisted.
//
// Targets the ALREADY-RUNNING dev servers: web :3000 against API :3001.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOPS = [
  [1280, 900, 'phase49c2-shots/qa-49c2-1280'],
  [1440, 900, 'phase49c2-shots/qa-49c2-1440'],
  [1920, 1080, 'phase49c2-shots/qa-49c2-1920'],
];
const MOBILES = [
  [360, 800, 'phase49c2-shots/qa-49c2-360'],
  [390, 844, 'phase49c2-shots/qa-49c2-390'],
  [430, 932, 'phase49c2-shots/qa-49c2-430'],
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

/** Opens /admin/settings and waits until the settings tablist settles. */
async function gotoSettings(page, tab) {
  const query = tab ? `?tab=${tab}` : '';
  await page.goto(`${BASE}/admin/settings${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role="tablist"][aria-label="بخش‌های تنظیمات"]', { timeout: 60000 });
  await sleep(2000);
}

/** Opens /admin (any page) and waits for the shell rail. */
async function gotoShell(page, path = '/admin') {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 60000 });
  await sleep(2000);
}

/** Sets the app's real text-scale step on <html> (never persisted). */
async function setTextScale(page, step) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-text-scale', value);
  }, step);
  await sleep(1200);
  return page.evaluate(() => document.documentElement.getAttribute('data-text-scale'));
}

/** Physical + semantic metrics read from the RENDERED settings page. */
async function measureSettings(page) {
  return page.evaluate(() => {
    const $$ = (sel) => [...document.querySelectorAll(sel)];
    const doc = document.scrollingElement;
    const tabs = $$('[role="tab"]').map((tab) => ({
      label: tab.textContent.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
      controls: tab.getAttribute('aria-controls'),
      id: tab.id,
      roving: tab.getAttribute('tabindex'),
    }));
    const panels = $$('[role="tabpanel"]').map((panel) => ({
      id: panel.id,
      h: Math.round(panel.getBoundingClientRect().height),
      childCount: panel.children.length,
      hasSkeleton: Boolean(panel.querySelector('[role="status"]')),
    }));
    const railGroups = $$('[data-testid="core-nav-group"]').map((g) => g.getAttribute('data-group-id'));
    const rail = document.querySelector('[data-testid="core-sidebar"]');
    const railText = rail?.textContent ?? '';
    return {
      url: location.href,
      headerTitle: document.querySelector('header h1')?.textContent?.trim() ?? null,
      inPageTitle: document.body.textContent.includes('مدیریت تنظیمات شخصی و پلتفرم'),
      viewport: { w: innerWidth, h: innerHeight },
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      tabs,
      panels,
      panelCount: panels.length,
      captions: $$('[role="tablist"] [role="presentation"]').map((s) => s.textContent.trim()),
      railGroups,
      railHasPlatformGroup: railText.includes('تنظیمات پلتفرم'),
    };
  });
}

async function measureSidebar(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="core-sidebar"]');
    const railText = rail?.textContent ?? '';
    const groupLabels = [...rail.querySelectorAll('[data-testid="core-nav-group"] > div:first-child')]
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    const groupIds = [...rail.querySelectorAll('[data-testid="core-nav-group"]')].map((g) => g.getAttribute('data-group-id'));
    return {
      groupLabels,
      groupIds,
      hasPlatformGroup: railText.includes('تنظیمات پلتفرم'),
      hasAI: railText.includes('هوش مصنوعی'),
      hasIntegrations: railText.includes('اتوماسیون و یکپارچه‌سازی'),
      hasModules: railText.includes('ماژول‌ها'),
      hasObservability: railText.includes('لاگ‌ها'),
      hasCalendar: railText.includes('تقویم'),
      hasBlog: railText.includes('وبلاگ'),
      hasAccount: railText.includes('حساب من'),
    };
  });
}

async function openUserMenu(page) {
  const opener = await page.$('header [aria-haspopup="menu"]');
  if (!opener) return null;
  await opener.click();
  await page.waitForSelector('[role="menu"][aria-label="منوی کاربر"]', { timeout: 10000 });
  await sleep(300);
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    const r = menu.getBoundingClientRect();
    return {
      items: [...menu.querySelectorAll('[role="menuitem"]')].map((i) => ({
        label: i.textContent.trim(),
        href: i.getAttribute('href'),
      })),
      fitsViewport: r.right <= innerWidth + 1 && r.left >= -1,
    };
  });
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--disable-web-security', '--disable-site-isolation-trials'],
    userDataDir: 'E:/ERP/apps/web/qa-49c2-profile',
  });
  const page = await browser.newPage();
  await signIn(page);
  console.log('SIGNED-IN-OK');

  // ---------------------------------------------------------------------
  // SIDEBAR CLEANUP — the platform settings group is gone from the rail.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of DESKTOPS) {
    await page.setViewport({ width: w, height: h });
    await gotoShell(page);
    const side = await measureSidebar(page);
    check(!side.hasPlatformGroup, `${w} sidebar: «تنظیمات پلتفرم» group removed`);
    check(!side.hasAI && !side.hasIntegrations && !side.hasModules && !side.hasObservability, `${w} sidebar: platform children removed`);
    check(side.groupLabels.includes('عمومی') && side.groupLabels.includes('مدیریت محتوا') && side.groupLabels.includes('خدمات'), `${w} sidebar: primary groups intact`, side.groupLabels.join(','));
    check(side.hasCalendar && side.hasBlog && side.hasAccount, `${w} sidebar: existing primary entries preserved`);
    check(side.groupLabels.length === 3, `${w} sidebar: exactly 3 group labels`, side.groupLabels.join(','));
    await page.screenshot({ path: `${out}/01-sidebar.png` });
  }

  // ---------------------------------------------------------------------
  // SETTINGS CENTER — default state + semantics at 1440.
  // ---------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 900 });
  await gotoSettings(page);
  {
    const m = await measureSettings(page);
    check(m.headerTitle === 'تنظیمات', 'settings: header title = تنظیمات', m.headerTitle);
    check(m.inPageTitle, 'settings: in-page hierarchy title/description present');
    check(m.tabs.length === 5, 'settings: 5 tabs for the authorized admin', JSON.stringify(m.tabs.map((t) => t.label)));
    check(m.tabs[0].selected === true && m.tabs[0].label === 'ظاهر و دسترس‌پذیری', 'settings: default tab = personal');
    check(m.tabs.every((t) => t.controls === t.id.replace('settings-tab-', 'settings-panel-')), 'settings: aria-controls wired on every tab', JSON.stringify(m.tabs.map((t) => `${t.id}->${t.controls}`)));
    check(m.panelCount === 1, 'settings: only ONE panel mounted', `panels=${m.panelCount}`);
    check(JSON.stringify(m.captions) === JSON.stringify(['شخصی', 'پلتفرم']), 'settings: grouped captions', JSON.stringify(m.captions));
    check(!m.horizontalOverflow, 'settings: no horizontal page overflow', `${m.scrollWidth}/${m.clientWidth}`);
    await page.screenshot({ path: 'phase49c2-shots/qa-49c2-1440/02-settings-appearance.png', fullPage: true });
  }

  // ---------------------------------------------------------------------
  // PLATFORM TABS — click each, verify the EXISTING view mounts.
  // ---------------------------------------------------------------------
  const platformTabs = [
    ['هوش مصنوعی', 'ai'],
    ['اتوماسیون و یکپارچه‌سازی', 'integrations'],
    ['ماژول‌ها و سرویس‌های متصل', 'modules'],
    ['لاگ‌ها و رخدادها', 'observability'],
  ];
  let shotIndex = 3;
  for (const [label, id] of platformTabs) {
    await gotoSettings(page);
    const user = await page.evaluateHandle(
      (lbl) => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(lbl)),
      label,
    );
    await user.asElement().click();
    await sleep(2500);
    const m = await measureSettings(page);
    const active = m.tabs.find((t) => t.label.includes(label));
    check(active?.selected === true, `tab ${id}: click activates and selects`);
    check(m.url.includes(`tab=${id}`), `tab ${id}: URL updates`, m.url);
    check(m.panelCount === 1, `tab ${id}: only one panel mounted`);
    const panelOk = await page.evaluate(() => {
      const panel = document.querySelector('[role="tabpanel"]');
      return { children: panel.children.length, h: Math.round(panel.getBoundingClientRect().height) };
    });
    check(panelOk.children > 0 && panelOk.h > 0, `tab ${id}: existing view actually rendered`, JSON.stringify(panelOk));
    check(!m.horizontalOverflow, `tab ${id}: no horizontal page overflow`);
    await page.screenshot({ path: `phase49c2-shots/qa-49c2-1440/${String(shotIndex).padStart(2, '0')}-tab-${id}.png`, fullPage: true });
    shotIndex += 1;
  }

  // ---------------------------------------------------------------------
  // URL STATE — direct deep link, invalid fallback, refresh restore.
  // ---------------------------------------------------------------------
  await gotoSettings(page, 'modules');
  {
    const m = await measureSettings(page);
    check(m.tabs.find((t) => t.label.includes('ماژول‌ها'))?.selected === true, 'deep link ?tab=modules restores the tab');
  }
  await gotoSettings(page, 'bogus');
  {
    const m = await measureSettings(page);
    check(m.tabs.find((t) => t.label === 'ظاهر و دسترس‌پذیری')?.selected === true, 'invalid ?tab=bogus falls back to the personal tab');
  }
  await gotoSettings(page, 'observability');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role="tablist"][aria-label="بخش‌های تنظیمات"]', { timeout: 60000 });
  await sleep(1500);
  {
    const m = await measureSettings(page);
    check(m.tabs.find((t) => t.label.includes('لاگ‌ها'))?.selected === true, 'refresh preserves the active tab');
  }

  // ---------------------------------------------------------------------
  // KEYBOARD — arrows (RTL), Home/End, roving tabindex, visible focus.
  // ---------------------------------------------------------------------
  await gotoSettings(page);
  {
    await page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.focus());
    // RTL: ArrowLeft is forward.
    await page.keyboard.press('ArrowLeft');
    await sleep(1000);
    const m1 = await measureSettings(page);
    check(m1.tabs.find((t) => t.label.includes('هوش مصنوعی'))?.selected === true, 'RTL ArrowLeft: forward to هوش مصنوعی');
    const focusRing = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, shadow: cs.boxShadow !== 'none', tab: el.getAttribute('role'), roving: el.getAttribute('tabindex') };
    });
    check(focusRing.tab === 'tab' && focusRing.roving === '0' && (focusRing.outline !== 'none' || focusRing.shadow), 'focus stays on the active tab with a visible ring', JSON.stringify(focusRing));
    await page.keyboard.press('End');
    await sleep(900);
    const m2 = await measureSettings(page);
    check(m2.tabs.find((t) => t.label.includes('لاگ‌ها'))?.selected === true, 'End: jumps to the last tab');
    await page.keyboard.press('Home');
    await sleep(900);
    const m3 = await measureSettings(page);
    check(m3.tabs.find((t) => t.label === 'ظاهر و دسترس‌پذیری')?.selected === true, 'Home: jumps to the first tab');
  }

  // ---------------------------------------------------------------------
  // HEADER DROPDOWN — the ONLY entry point for settings.
  // ---------------------------------------------------------------------
  await gotoShell(page, '/admin/settings');
  {
    const menu = await openUserMenu(page);
    check(Boolean(menu), 'user chip opens the existing dropdown');
    const settings = menu?.items.find((i) => i.label.includes('تنظیمات'));
    check(settings?.href === '/admin/settings', 'dropdown: تنظیمات targets /admin/settings');
    check(menu?.items.some((i) => i.label.includes('حساب من')), 'dropdown: حساب من unchanged');
    check(menu?.items.some((i) => i.label.includes('خروج')), 'dropdown: خروج unchanged');
    check(menu?.fitsViewport === true, 'dropdown: no viewport overflow');
    await page.screenshot({ path: 'phase49c2-shots/qa-49c2-1440/09-dropdown.png' });

    // Navigate through the REAL menu item.
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('تنظیمات'));
      item.click();
    });
    await sleep(3000);
    check(page.url().includes('/admin/settings'), 'menu: تنظیمات navigates to the Settings Center', page.url());
    check(Boolean(await page.$('[role="tablist"][aria-label="بخش‌های تنظیمات"]')), 'menu: Settings Center renders');
    await page.keyboard.press('Escape');
  }

  // ---------------------------------------------------------------------
  // MOBILE — 360 / 390 / 430.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of MOBILES) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoSettings(page);
    const m = await measureSettings(page);
    check(!m.horizontalOverflow, `${w}: no horizontal page overflow`, `${m.scrollWidth}/${m.clientWidth}`);
    check(m.tabs.length === 5 && m.panelCount === 1, `${w}: tabs usable, one panel`);
    const tabFits = await page.evaluate(() => {
      const tablist = document.querySelector('[role="tablist"][aria-label="بخش‌های تنظیمات"]');
      const selected = tablist.querySelector('[aria-selected="true"]');
      const sr = selected.getBoundingClientRect();
      return {
        tablistScrolls: tablist.scrollWidth > tablist.clientWidth + 1,
        selectedVisible: sr.right <= innerWidth + 1 && sr.left >= -1,
        pageScrolled: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth + 1,
      };
    });
    check(tabFits.selectedVisible, `${w}: active tab remains visible`);
    check(!tabFits.pageScrolled, `${w}: page itself never scrolls horizontally (only the tablist may)`);
    await page.screenshot({ path: `${out}/01-settings-mobile.png`, fullPage: true });

    const menu = await openUserMenu(page);
    check(menu?.fitsViewport === true, `${w}: user dropdown fits viewport`);
    await page.keyboard.press('Escape');

    // Platform tab on mobile.
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('هوش مصنوعی'));
      item.scrollIntoView({ block: 'nearest', inline: 'center' });
      item.click();
    });
    await sleep(2000);
    const m2 = await measureSettings(page);
    check(!m2.horizontalOverflow && m2.panelCount === 1, `${w}: AI platform tab usable`);
    await page.screenshot({ path: `${out}/02-settings-ai-mobile.png`, fullPage: true });
  }

  // ---------------------------------------------------------------------
  // TEXT SCALE — the app's own steps 100 / 125 / 140 on the Settings Center.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of [[1440, 900, 'phase49c2-shots/qa-49c2-1440'], [390, 844, 'phase49c2-shots/qa-49c2-390']]) {
    await page.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await gotoSettings(page);
    for (const step of ['100', '125', '140']) {
      const applied = await setTextScale(page, step);
      check(applied === step, `${w}@${step}%: app text-scale mechanism applied`);
      const m = await page.evaluate(() => {
        const doc = document.scrollingElement;
        const tablist = document.querySelector('[role="tablist"][aria-label="بخش‌های تنظیمات"]');
        const selected = tablist.querySelector('[aria-selected="true"]');
        const sr = selected.getBoundingClientRect();
        const clippedButtons = [...document.querySelectorAll('[role="tabpanel"] button, [role="tabpanel"] label, [role="tabpanel"] select')].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && (r.right > doc.clientWidth + 1 || r.left < -1);
        }).length;
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          selectedVisible: sr.right <= innerWidth + 1 && sr.left >= -1,
          clippedButtons,
        };
      });
      check(!m.horizontalOverflow, `${w}@${step}%: no horizontal page scroll`);
      check(m.selectedVisible, `${w}@${step}%: active tab readable and visible`);
      check(m.clippedButtons === 0, `${w}@${step}%: no clipped controls`, `clipped=${m.clippedButtons}`);
      await page.screenshot({ path: `${out}/10-textscale-${step}.png`, fullPage: true });
    }
  }

  // ---------------------------------------------------------------------
  // DIRECT ROUTES — the old platform routes still work as direct URLs.
  // ---------------------------------------------------------------------
  for (const path of ['/admin/ai', '/admin/integrations', '/admin/modules', '/admin/observability']) {
    await page.setViewport({ width: 1440, height: 900 });
    await gotoShell(page, path);
    const title = await page.evaluate(() => document.querySelector('header h1')?.textContent?.trim());
    const hasContent = await page.evaluate(() => Boolean(document.querySelector('main > *')));
    check(Boolean(title) && title !== 'پنل مدیریت', `direct route ${path}: still reachable with its own title`, title);
    check(hasContent, `direct route ${path}: still renders its view`);
  }

  await browser.close();
}

let fatal = null;
try {
  for (const dir of ['qa-49c2-1280', 'qa-49c2-1440', 'qa-49c2-1920', 'qa-49c2-360', 'qa-49c2-390', 'qa-49c2-430']) {
    await mkdir(`phase49c2-shots/${dir}`, { recursive: true });
  }
  await main();
} catch (error) {
  fatal = error;
  check(false, 'harness completed', error?.stack ?? String(error));
}

const failed = findings.filter((f) => !f.ok);
console.log(`\nTOTAL=${findings.length} PASSED=${findings.length - failed.length} FAILED=${failed.length}`);
if (fatal) console.error(fatal);
process.exit(failed.length > 0 ? 1 : 0);
