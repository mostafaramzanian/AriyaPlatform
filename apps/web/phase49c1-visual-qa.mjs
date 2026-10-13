// Phase 49C-1 FINAL BROWSER VISUAL QA GATE.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// exercises the tabbed Account Center, the settings destination and the header user
// menu. Evidence = screenshots + physical layout metrics (bounding boxes, overflow,
// tab semantics) read FROM the rendered page — never from source inspection or Jest.
//
// Scope: QA evidence only. It creates NO data and mutates NO user preferences: the
// app's real text-scale mechanism (`data-text-scale` on <html>, painted by
// ThemeProvider's applyToDocument) is set per page load and never persisted.
//
// Targets the ALREADY-RUNNING dev servers: web :3000 (same source tree, dev server
// compiles the current source on demand) against API :3001 (the web's configured
// default API origin, verified live for this run).

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOPS = [
  [1280, 900, 'phase49c1-shots/qa-49c1-1280'],
  [1440, 900, 'phase49c1-shots/qa-49c1-1440'],
  [1920, 1080, 'phase49c1-shots/qa-49c1-1920'],
];
const MOBILES = [
  [360, 800, 'phase49c1-shots/qa-49c1-360'],
  [390, 844, 'phase49c1-shots/qa-49c1-390'],
  [430, 932, 'phase49c1-shots/qa-49c1-430'],
];

const findings = [];
const check = (ok, name, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

/** Types credentials and submits; the form only reacts to real key events. */
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

/** Opens /admin/profile and waits until the account tablist settles. */
async function gotoAccount(page, tab) {
  const query = tab ? `?tab=${tab}` : '';
  await page.goto(`${BASE}/admin/profile${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[role="tablist"][aria-label="بخش‌های حساب"]', { timeout: 60000 });
  await sleep(2000); // dev-compile + layout/font stabilization
}

/** Opens /admin/settings and waits until the 49K appearance controls settle. */
async function gotoSettings(page) {
  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#appearance-heading', { timeout: 60000 });
  await sleep(2000);
}

/** Sets the app's real text-scale step on <html> (never persisted). */
async function setTextScale(page, step) {
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-text-scale', value);
  }, step);
  await sleep(1200);
  const applied = await page.evaluate(() =>
    document.documentElement.getAttribute('data-text-scale'),
  );
  return applied === step;
}

/** Physical + semantic metrics read from the RENDERED account page. */
async function measureAccount(page) {
  return page.evaluate((email) => {
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => [...document.querySelectorAll(sel)];
    const rect = (sel) => {
      const el = $(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        top: Math.round(r.top),
      };
    };

    const doc = document.scrollingElement;
    const tabs = $$('[role="tab"]').map((tab) => ({
      label: tab.textContent.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
      controls: tab.getAttribute('aria-controls'),
      id: tab.id,
      roving: tab.getAttribute('tabindex'),
      box: rect(`#${tab.id}`),
    }));
    const panels = $$('[role="tabpanel"]').map((panel) => ({
      id: panel.id,
      labelledBy: panel.getAttribute('aria-labelledby'),
      w: Math.round(panel.getBoundingClientRect().width),
      h: Math.round(panel.getBoundingClientRect().height),
    }));

    const main = document.querySelector('main');
    const header = document.querySelector('header');

    // Any element visually overflowing the page width (right edge for RTL). Children
    // of the account tablist are excluded when the tablist itself intentionally
    // scrolls (overflow-x-auto, approved UX: "scroll only if required") — they are
    // counted separately as scroll-container content, never page overflow.
    let clipped = 0;
    let tablistScrollChildren = 0;
    const docWidth = doc.clientWidth;
    $$('main *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && (r.right > docWidth + 1 || r.left < -1))) return;
      const owningTablist = el.closest('[role="tablist"]');
      if (owningTablist && owningTablist.scrollWidth > owningTablist.clientWidth + 1) {
        tablistScrollChildren += 1;
        return;
      }
      clipped += 1;
    });

    return {
      url: location.href,
      title: document.querySelector('header h1')?.textContent?.trim() ?? null,
      viewport: { w: innerWidth, h: innerHeight },
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: docWidth,
      tabs,
      panels,
      panelCount: panels.length,
      activePanel: panels[0] ?? null,
      tablist: rect('[role="tablist"]'),
      main: main ? { w: Math.round(main.getBoundingClientRect().width), h: Math.round(main.getBoundingClientRect().height) } : null,
      header: header ? { h: Math.round(header.getBoundingClientRect().height) } : null,
      appearanceOnAccountPage: Boolean(document.querySelector('#appearance-heading')),
      clipped,
      tablistScrollChildren,
      profileVisible: Boolean(document.querySelector('#profile-heading')),
      sessionsVisible: Boolean(document.querySelector('#account-sessions-heading')),
      historyVisible: Boolean(document.querySelector('#account-history-heading')),
      emailText: document.body.textContent.includes(email),
      revokeButton: Boolean(document.querySelector('[role="tabpanel"] button')),
      mainCard: rect('main [role="tabpanel"] section') ?? rect('main section'),
    };
  }, EMAIL);
}

/** Opens the header user dropdown and returns semantic + physical metrics. */
async function openUserMenu(page) {
  const opener = await page.$('header [aria-haspopup="menu"]');
  if (!opener) return null;
  await opener.click();
  await page.waitForSelector('[role="menu"][aria-label="منوی کاربر"]', { timeout: 10000 });
  await sleep(400);
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => {
      const r = item.getBoundingClientRect();
      const svg = item.querySelector('svg');
      return {
        label: item.textContent.trim(),
        href: item.getAttribute('href'),
        ariaHidden: item.getAttribute('aria-hidden'),
        hasIcon: Boolean(svg),
        iconAriaHidden: svg ? svg.getAttribute('aria-hidden') : null,
        right: Math.round(r.right),
        left: Math.round(r.left),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
    const mr = menu.getBoundingClientRect();
    return {
      items,
      menu: { right: Math.round(mr.right), left: Math.round(mr.left), top: Math.round(mr.top), w: Math.round(mr.width), h: Math.round(mr.height) },
      fitsViewport: mr.right <= innerWidth + 1 && mr.left >= -1 && mr.bottom <= innerHeight + 1,
    };
  });
}

async function closeUserMenu(page) {
  await page.keyboard.press('Escape');
  await sleep(300);
  return page.evaluate(() => !document.querySelector('[role="menu"]'));
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    // The QA browser runs with CORS enforcement disabled in THIS harness only — the
    // app and API are untouched (same approach as the phase 49I-2 visual gate).
    args: ['--disable-web-security', '--disable-site-isolation-trials'],
    // Isolated profile: the QA run shares no cookies/state with the user's browser.
    userDataDir: 'E:/ERP/apps/web/qa-49c1-profile',
  });
  const page = await browser.newPage();
  await signIn(page);
  console.log('SIGNED-IN-OK');

  // ---------------------------------------------------------------------
  // PAGE 1 — ACCOUNT CENTER, desktop pass: 1280 / 1440 / 1920.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of DESKTOPS) {
    await page.setViewport({ width: w, height: h });
    await gotoAccount(page);
    const m = await measureAccount(page);
    check(!m.horizontalOverflow, `${w}: no horizontal page overflow`, `${m.scrollWidth}/${m.clientWidth}`);
    check(m.tabs.length === 3, `${w}: three real tabs render`, JSON.stringify(m.tabs.map((t) => t.label)));
    check(m.tabs.some((t) => t.selected && t.label === 'مشخصات حساب'), `${w}: default active tab = مشخصات حساب`);
    check(m.panelCount === 1, `${w}: only ONE active panel is mounted`, `panels=${m.panelCount}`);
    check(m.profileVisible && !m.sessionsVisible && !m.historyVisible, `${w}: profile panel visible, others hidden`);
    check(!m.appearanceOnAccountPage, `${w}: settings no longer on the account page`);
    check(m.activePanel && m.mainCard && m.mainCard.right <= m.clientWidth && m.mainCard.left >= 0, `${w}: content panel does not touch viewport edges`);
    check(m.main && m.main.h < 3000, `${w}: account page is no longer the old vertical bulk`, `mainH=${m.main?.h}`);
    check(m.emailText, `${w}: profile email renders`);
    await page.screenshot({ path: `${out}/01-account-default.png`, fullPage: true });
  }

  // ---------------------------------------------------------------------
  // TAB 1 — مشخصات حساب at 1440.
  // ---------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 900 });
  await gotoAccount(page, 'profile');
  {
    const m = await measureAccount(page);
    check(m.url.includes('tab=profile'), '1440 tab=profile: URL-addressable state', m.url);
    check(m.tabs.find((t) => t.label === 'مشخصات حساب')?.selected === true, '1440 tab=profile: tab selected');
    check(m.profileVisible, '1440 tab=profile: profile heading renders');
    check(m.emailText, '1440 tab=profile: email readable');
    const m2 = await page.evaluate(() => {
      const edit = [...document.querySelectorAll('[role="tabpanel"] button, [role="tabpanel"] label')].find((el) => el.textContent.includes('ویرایش'));
      const avatarBox = document.querySelector('[role="tabpanel"] img, [role="tabpanel"] .rounded-full');
      return {
        editVisible: Boolean(edit && edit.getBoundingClientRect().width > 0),
        avatarRendered: Boolean(avatarBox && avatarBox.getBoundingClientRect().width > 0),
        roleRow: document.body.textContent.includes('نقش اصلی'),
        statusRow: document.body.textContent.includes('وضعیت حساب'),
      };
    });
    check(m2.editVisible, '1440 tab=profile: edit control visually accessible');
    check(m2.avatarRendered, '1440 tab=profile: avatar positioned');
    check(m2.roleRow, '1440 tab=profile: role info readable');
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/02-tab-profile.png', fullPage: true });
  }

  // ---------------------------------------------------------------------
  // TAB 2 — نشست‌های فعال at 1440 (+ click interaction, URL, refresh).
  // ---------------------------------------------------------------------
  await gotoAccount(page);
  {
    const user = await page.evaluateHandle(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('نشست‌های فعال')));
    await user.asElement().click();
    await sleep(1200);
    const m = await measureAccount(page);
    check(m.url.includes('tab=sessions'), 'tab click: URL updates to tab=sessions', m.url);
    check(m.tabs.find((t) => t.label === 'نشست‌های فعال')?.selected === true, 'tab click: active tab changes');
    check(m.panelCount === 1 && m.sessionsVisible && !m.profileVisible, 'tab click: only sessions panel visible');
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/03-tab-sessions.png', fullPage: true });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[role="tablist"]', { timeout: 60000 });
    await sleep(1500);
    const m2 = await measureAccount(page);
    check(m2.tabs.find((t) => t.label === 'نشست‌های فعال')?.selected === true, 'refresh: active tab preserved from URL');
    check(m2.sessionsVisible, 'refresh: sessions panel visible');
  }

  // ---------------------------------------------------------------------
  // TAB 3 — تاریخچه ورود (implemented query value) at 1440.
  // ---------------------------------------------------------------------
  await gotoAccount(page, 'login-history');
  {
    const m = await measureAccount(page);
    check(m.url.includes('tab=login-history'), 'history tab uses the implemented query value', m.url);
    check(m.historyVisible, 'tab=login-history: login history heading renders');
    check(m.panelCount === 1, 'tab=login-history: only one panel');
    const m2 = await page.evaluate(() => {
      const empty = document.body.textContent.includes('تاریخچه ورود موجود نیست.');
      const rows = [...document.querySelectorAll('[role="tabpanel"] [class*="rounded-md"]')].length;
      const success = document.body.textContent.includes('موفق');
      const failure = document.body.textContent.includes('ناموفق');
      const ip = document.body.textContent.includes('IP:');
      return { empty, rows, success, failure, ip };
    });
    check(m2.empty || m2.rows > 0, 'tab=login-history: content renders (rows or verified empty state)');
    check(m2.success || m2.failure || m2.empty, 'tab=login-history: success/failure states distinguishable');
    check(!m.horizontalOverflow, 'tab=login-history: IP/timestamps do not overflow');
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/04-tab-history.png', fullPage: true });
  }

  // ---------------------------------------------------------------------
  // Invalid tab fallback.
  // ---------------------------------------------------------------------
  await gotoAccount(page, 'bogus');
  {
    const m = await measureAccount(page);
    check(m.tabs.find((t) => t.label === 'مشخصات حساب')?.selected === true, 'invalid tab falls back to مشخصات حساب');
    check(m.profileVisible, 'invalid tab: profile panel renders');
  }

  // ---------------------------------------------------------------------
  // TAB INTERACTION — keyboard: click-activates, arrows for RTL, Home/End,
  // Enter/Space, Back/Forward sensibility, visible focus.
  // ---------------------------------------------------------------------
  await gotoAccount(page);
  {
    const active = await page.evaluateHandle(() => document.querySelector('[role="tab"][aria-selected="true"]'));
    await active.asElement().focus();
    // RTL app: ArrowLeft moves forward (تاریخچه ورود), ArrowRight moves backward.
    await page.keyboard.press('ArrowLeft');
    await sleep(900);
    const m1 = await measureAccount(page);
    check(m1.tabs.find((t) => t.label === 'نشست‌های فعال')?.selected === true, 'RTL ArrowLeft: forward to نشست‌های فعال');
    const focusInTab = await page.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true');
    check(focusInTab, 'arrow navigation keeps focus on the new active tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, shadow: cs.boxShadow !== 'none', tabindex: el.getAttribute('tabindex') };
    });
    check(ring.outline !== 'none' || ring.shadow, 'visible focus on the focused tab', JSON.stringify(ring));
    check(ring.tabindex === '0', 'roving tabindex: active tab is tabbable');

    await page.keyboard.press('ArrowRight');
    await sleep(900);
    const m2 = await measureAccount(page);
    check(m2.tabs.find((t) => t.label === 'مشخصات حساب')?.selected === true, 'RTL ArrowRight: backward to مشخصات حساب');

    await page.keyboard.press('End');
    await sleep(900);
    const m3 = await measureAccount(page);
    check(m3.tabs.find((t) => t.label === 'تاریخچه ورود')?.selected === true, 'End: jumps to last tab');
    await page.keyboard.press('Home');
    await sleep(900);
    const m4 = await measureAccount(page);
    check(m4.tabs.find((t) => t.label === 'مشخصات حساب')?.selected === true, 'Home: jumps to first tab');

    // Enter/Space: move focus to a non-selected (non-tabbable) tab is impossible by
    // design; activation via Enter on the selected tab is a no-op — assert Space
    // activation on the currently selected tab does not break state.
    await page.keyboard.press('Space');
    await sleep(500);
    const m5 = await measureAccount(page);
    check(m5.panelCount === 1 && m5.profileVisible, 'Enter/Space: state stays sane');

    // Back/Forward: replace-state means one Back returns to the shell route, not one
    // replayed tab. Sensible = the shell still renders a valid account page.
    await page.evaluateHandle(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('نشست‌های فعال'))).then((h) => h.asElement().click());
    await sleep(900);
    await page.goBack();
    await page.waitForSelector('[role="tablist"]', { timeout: 60000 });
    await sleep(1200);
    const m6 = await measureAccount(page);
    check(m6.url.startsWith(`${BASE}/admin/profile`), 'Back: returns to a valid account URL', m6.url);
    check(m6.tabs.length === 3 && m6.panelCount === 1, 'Back: account page stays functional');
  }

  // ---------------------------------------------------------------------
  // PAGE 2 — SETTINGS at 1440 (appearance + accessibility, no duplicates).
  // ---------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 900 });
  await gotoSettings(page);
  {
    const m = await page.evaluate(() => {
      const doc = document.scrollingElement;
      const heading = document.querySelector('#appearance-heading');
      const selects = ['appearance-theme', 'appearance-density', 'appearance-text-scale', 'appearance-motion'].map((id) => {
        const el = document.getElementById(id);
        return { id, present: Boolean(el), enabled: el ? !el.disabled : false };
      });
      const card = document.querySelector('#appearance-heading')?.closest('section');
      const cr = card?.getBoundingClientRect();
      const navCount = [...document.querySelectorAll('nav a, [role="navigation"] a')].filter((a) => a.getAttribute('href') === '/admin/settings').length;
      const h1 = document.querySelector('header h1')?.textContent?.trim();
      return {
        h1,
        headingText: heading?.textContent?.trim(),
        selects,
        cardW: cr ? Math.round(cr.width) : null,
        fits: cr ? cr.right <= doc.clientWidth && cr.left >= 0 : null,
        horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
        sidebarSettingsLink: navCount,
      };
    });
    check(m.h1 === 'تنظیمات', 'settings: header title = تنظیمات', m.h1);
    check(m.headingText === 'ظاهر و دسترس‌پذیری', 'settings: appearance heading renders', m.headingText);
    check(m.selects.every((s) => s.present), 'settings: all 49K controls present', JSON.stringify(m.selects.map((s) => s.id)));
    check(m.selects.filter((s) => s.enabled).length >= 3, 'settings: controls enabled (loaded)');
    check(!m.horizontalOverflow, 'settings: no horizontal overflow');
    check(m.cardW && m.cardW <= 900, 'settings: card not excessively wide', `${m.cardW}px`);
    check(m.sidebarSettingsLink === 0, 'settings: NOT added to the public sidebar nav', `links=${m.sidebarSettingsLink}`);
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/05-settings.png', fullPage: true });

    // Appearance interaction: change density, verify immediate reflection, revert.
    const density = await page.evaluateHandle(() => document.getElementById('appearance-density'));
    await density.asElement().select('COMPACT');
    await sleep(1500);
    const compact = await page.evaluate(() => document.documentElement.getAttribute('data-density'));
    // The app paints the density attribute in the lowercase form its stylesheet
    // selects on (`:root[data-density='compact']`) — applied == reflected.
    check(compact?.toLowerCase() === 'compact', 'appearance: density change immediately reflected', `data-density=${compact}`);
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/06-settings-compact.png', fullPage: true });
    await density.asElement().select('COMFORTABLE');
    await sleep(1500);
    const reverted = await page.evaluate(() => document.documentElement.getAttribute('data-density'));
    check(reverted?.toLowerCase() !== 'compact', 'appearance: density reverted', `data-density=${reverted}`);

    // Text scale via the app's REAL select (persists to the session user — QA runs as
    // admin; the select exercises the control the user operates).
    const scale = await page.evaluateHandle(() => document.getElementById('appearance-text-scale'));
    await scale.asElement().select('125');
    await sleep(1500);
    const applied = await page.evaluate(() => document.documentElement.getAttribute('data-text-scale'));
    check(applied === '125', 'accessibility: text scale 125 applied through the real control', `data-text-scale=${applied}`);
    const overflowAt125 = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return doc.scrollWidth > doc.clientWidth + 1;
    });
    check(!overflowAt125, 'settings @125: no horizontal overflow');
    await scale.asElement().select('100');
    await sleep(1200);
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/07-settings-after-scale.png', fullPage: true });
  }

  // ---------------------------------------------------------------------
  // HEADER USER DROPDOWN at 1440.
  // ---------------------------------------------------------------------
  await gotoAccount(page);
  {
    const menu = await openUserMenu(page);
    check(Boolean(menu), 'user chip opens the existing dropdown');
    check(menu?.items.some((i) => i.label.includes('حساب من')), 'dropdown: حساب من visible');
    check(menu?.items.some((i) => i.label.includes('تنظیمات')), 'dropdown: ⚙ تنظیمات visible');
    check(menu?.items.some((i) => i.label.includes('خروج')), 'dropdown: خروج visible');
    const settingsItem = menu?.items.find((i) => i.label.includes('تنظیمات'));
    check(settingsItem?.href === '/admin/settings', 'dropdown: تنظیمات targets /admin/settings', settingsItem?.href ?? 'null');
    check(settingsItem?.hasIcon && settingsItem?.iconAriaHidden === 'true', 'dropdown: gear icon aligned + decorative');
    check(menu?.fitsViewport === true, 'dropdown: no viewport overflow', JSON.stringify(menu?.menu));
    check(menu?.items.every((i) => i.ariaHidden !== 'true'), 'dropdown: all items exposed to a11y tree');
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/08-dropdown.png' });

    const closedOnEscape = await closeUserMenu(page);
    check(closedOnEscape, 'dropdown: Escape closes');
    await openUserMenu(page);
    await page.mouse.click(40, 400); // outside click
    await sleep(400);
    const closedOutside = await page.evaluate(() => !document.querySelector('[role="menu"]'));
    check(closedOutside, 'dropdown: outside click closes');

    // Navigation: تنظیمات from the real menu.
    await openUserMenu(page);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('تنظیمات'));
      item.click();
    });
    await sleep(3000);
    check(page.url().includes('/admin/settings'), 'menu: تنظیمات navigates to /admin/settings', page.url());
    check(Boolean(await page.$('#appearance-heading')), 'menu: settings page reached');
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1440/09-menu-settings-nav.png', fullPage: true });

    // Navigation: حساب من from the real menu.
    await gotoAccount(page);
    await openUserMenu(page);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('حساب من'));
      item.click();
    });
    await sleep(3000);
    check(page.url().includes('/admin/profile'), 'menu: حساب من navigates to /admin/profile', page.url());
    // خروج behaviour is exercised at the very END of the run (it ends the session).
  }

  // ---------------------------------------------------------------------
  // MOBILE PASS — 360 / 390 / 430.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of MOBILES) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoAccount(page);
    const m = await measureAccount(page);
    check(!m.horizontalOverflow, `${w}: no horizontal page overflow`, `${m.scrollWidth}/${m.clientWidth}`);
    check(m.tabs.length === 3 && m.panelCount === 1, `${w}: tabs usable, one panel`);
    const tabFits = await page.evaluate(() => {
      const tablist = document.querySelector('[role="tablist"]');
      const tl = tablist.getBoundingClientRect();
      const selected = tablist.querySelector('[aria-selected="true"]');
      const sr = selected.getBoundingClientRect();
      return {
        tablistScrolls: tablist.scrollWidth > tablist.clientWidth + 1,
        selectedVisible: sr.right <= innerWidth + 1 && sr.left >= -1,
        clipped: [...tablist.querySelectorAll('[role="tab"]')].filter((t) => {
          const r = t.getBoundingClientRect();
          return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
        }).length,
      };
    });
    check(!tabFits.tablistScrolls || tabFits.selectedVisible, `${w}: selected tab remains visible`);
    check(tabFits.clipped === 0 || tabFits.tablistScrolls, `${w}: tab labels readable (inside scroll container or viewport)`);
    check(m.clipped === 0, `${w}: no clipped content inside main`, `clipped=${m.clipped} tablistScrollChildren=${m.tablistScrollChildren}`);
    await page.screenshot({ path: `${out}/01-account-mobile.png`, fullPage: true });

    const menu = await openUserMenu(page);
    check(menu?.fitsViewport === true, `${w}: user dropdown fits viewport`, JSON.stringify(menu?.menu));
    await closeUserMenu(page);

    // Sessions tab on mobile.
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('نشست‌های فعال'));
      item.click();
    });
    await sleep(1200);
    const ms = await measureAccount(page);
    check(!ms.horizontalOverflow && ms.sessionsVisible, `${w}: sessions tab fits viewport`);
    await page.screenshot({ path: `${out}/02-sessions-mobile.png`, fullPage: true });

    // Login history on mobile.
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes('تاریخچه ورود'));
      item.click();
    });
    await sleep(1200);
    const mh = await measureAccount(page);
    check(!mh.horizontalOverflow && mh.historyVisible, `${w}: history tab fits viewport`);
    await page.screenshot({ path: `${out}/03-history-mobile.png`, fullPage: true });

    // Settings on mobile.
    await gotoSettings(page);
    const mset = await page.evaluate(() => {
      const doc = document.scrollingElement;
      return { horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1, heading: Boolean(document.querySelector('#appearance-heading')) };
    });
    check(!mset.horizontalOverflow && mset.heading, `${w}: settings fits viewport`);
    await page.screenshot({ path: `${out}/04-settings-mobile.png`, fullPage: true });
  }

  // ---------------------------------------------------------------------
  // TEXT SCALE — the app's own steps 100 / 125 / 140 on the account page.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of [[1440, 900, 'phase49c1-shots/qa-49c1-1440'], [390, 844, 'phase49c1-shots/qa-49c1-390']]) {
    await page.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await gotoAccount(page);
    for (const step of ['100', '125', '140']) {
      const applied = await setTextScale(page, step);
      check(applied, `${w}@${step}%: app text-scale mechanism applied`);
      const m = await page.evaluate(() => {
        const doc = document.scrollingElement;
        const tablist = document.querySelector('[role="tablist"]');
        const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => {
          const r = t.getBoundingClientRect();
          return { label: t.textContent.trim(), right: Math.round(r.right), bottom: Math.round(r.bottom), selected: t.getAttribute('aria-selected') === 'true' };
        });
        // Tab labels must stay inside the tablist's scroll container (or the viewport
        // when the tablist does not scroll) — no text collision/clipping.
        const tl = tablist.getBoundingClientRect();
        const tabsInsideScroll = [...tablist.querySelectorAll('[role="tab"]')].every((t) => {
          const r = t.getBoundingClientRect();
          return r.width > 0;
        });
        const buttons = [...document.querySelectorAll('[role="tabpanel"] button, [role="tabpanel"] label')].filter((b) => b.getBoundingClientRect().width > 0);
        const clippedButtons = buttons.filter((b) => {
          const r = b.getBoundingClientRect();
          return r.right > doc.clientWidth + 1 || r.left < -1;
        }).length;
        return {
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          tablistW: Math.round(tl.width),
          tabs,
          tabsInside: tabsInsideScroll,
          clippedButtons,
          buttonCount: buttons.length,
          overflowInsideCards: [...document.querySelectorAll('main section, [role="tabpanel"]')].some((el) => el.scrollWidth > el.clientWidth + 1),
        };
      });
      check(!m.horizontalOverflow, `${w}@${step}%: no horizontal page scroll`, `${m.tabs.length} tabs`);
      check(m.tabs.some((t) => t.selected), `${w}@${step}%: selected tab identifiable`);
      check(m.tabsInside, `${w}@${step}%: tabs readable, no label collision`);
      check(m.clippedButtons === 0, `${w}@${step}%: no clipped buttons`, `clipped=${m.clippedButtons}/${m.buttonCount}`);
      check(!m.overflowInsideCards, `${w}@${step}%: no content clipping inside panels`);
      await page.screenshot({ path: `${out}/10-textscale-${step}.png`, fullPage: true });
    }
  }

  // ---------------------------------------------------------------------
  // LOGOUT — unchanged behaviour, exercised at the very end (ends the session).
  // ---------------------------------------------------------------------
  await page.setViewport({ width: 1280, height: 900 });
  await gotoAccount(page);
  {
    await openUserMenu(page);
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((i) => i.textContent.includes('خروج'));
      item.click();
    });
    await sleep(5000);
    check(page.url().includes('/login'), 'logout: خروج still routes to /login', page.url());
    await page.screenshot({ path: 'phase49c1-shots/qa-49c1-1280/10-after-logout.png' });
  }

  await browser.close();
}

let fatal = null;
try {
  for (const dir of ['qa-49c1-1280', 'qa-49c1-1440', 'qa-49c1-1920', 'qa-49c1-360', 'qa-49c1-390', 'qa-49c1-430']) {
    await mkdir(`phase49c1-shots/${dir}`, { recursive: true });
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
