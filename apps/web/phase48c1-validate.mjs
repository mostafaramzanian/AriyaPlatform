// Phase 48C.1 browser validation harness for the four RTL navigation defects.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3000';
const OUT = 'phase48c1-shots';
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

const boxOf = (page, selector) =>
  page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
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

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.type('input[name="email"]', EMAIL);
  await page.type('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(1500);

  await page.goto(`${BASE}/admin/blog`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  try {
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 15000 });
  } catch {
    // Chrome occasionally drops the renderer on the first client-side transition
    // into the admin shell ("This page couldn't load"). One reload recovers it.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    try {
      await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 20000 });
    } catch {
      const diag = await page.evaluate(() => ({
        url: location.href,
        text: document.body.innerText.slice(0, 400),
      }));
      console.log('DIAG shell not rendered:', JSON.stringify(diag));
      throw new Error('core shell never rendered on /admin/blog');
    }
  }

  // ---- Bug A: active indicator on the visual right edge -------------------
  const railBox = await boxOf(page, '[data-testid="core-sidebar"]');
  check(
    '1. rail is on the right side of the viewport',
    railBox.right > 1400,
    `rail right=${railBox.right.toFixed(0)} of 1440`,
  );

  const activeItem = await page.$eval('[data-testid="core-nav-item"][data-active="true"]', (el) => {
    const r = el.getBoundingClientRect();
    const mr = el
      .querySelector('[data-testid="core-nav-active-indicator"]')
      ?.getBoundingClientRect();
    return {
      label: el.textContent?.trim(),
      itemLeft: r.left,
      itemRight: r.right,
      markerLeft: mr?.left,
      markerRight: mr?.right,
    };
  });
  check(
    '2. active indicator hugs the RIGHT edge of its item (expanded)',
    activeItem.markerRight !== undefined &&
      Math.abs(activeItem.markerRight - activeItem.itemRight) < 2,
    JSON.stringify(activeItem),
  );

  await page.screenshot({ path: `${OUT}/desktop-open.png` });

  // ---- Bug B: toggle only on expandable rows, never on leaves ------------
  const leafToggles = await page.$$eval('[data-testid="core-nav-toggle"]', (els) =>
    els.filter((el) => {
      const row = el.closest('[data-testid="core-nav-item"]');
      return row?.getAttribute('data-expandable') === 'false';
    }).length,
  );
  const expandableRows = await page.$$eval(
    '[data-testid="core-nav-item"][data-expandable="true"]',
    (rows) =>
      rows.map(
        (r) =>
          `${r.textContent?.trim()}=${Boolean(r.querySelector('[data-testid="core-nav-toggle"]'))}`,
      ),
  );
  check(
    '3. no toggle on leaf items',
    leafToggles === 0,
    `leafToggles=${leafToggles}`,
  );
  check(
    '3b. every expandable row carries its toggle',
    expandableRows.length > 0 && expandableRows.every((row) => row.endsWith('=true')),
    `expandables=${expandableRows.join(', ')}`,
  );


  // ---- Bug C: collapse control ------------------------------------------
  const toggleInfo = await page.$eval('[data-testid="core-collapse-toggle"]', (el) => ({
    action: el.dataset.action,
    label: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
  }));
  check(
    '4. expanded rail offers the COLLAPSE action',
    toggleInfo.action === 'collapse' && toggleInfo.label === 'بستن منو',
    JSON.stringify(toggleInfo),
  );

  await page.click('[data-testid="core-collapse-toggle"]');
  await sleep(600);

  const collapsedState = await page.$eval(
    '[data-testid="core-sidebar"]',
    (el) => el.dataset.collapsed,
  );
  const toggleAfter = await page.$eval('[data-testid="core-collapse-toggle"]', (el) => ({
    action: el.dataset.action,
    label: el.getAttribute('aria-label'),
    expanded: el.getAttribute('aria-expanded'),
  }));
  check('5. rail collapses', collapsedState === 'true', `data-collapsed=${collapsedState}`);
  check(
    '6. collapsed rail offers the EXPAND action',
    toggleAfter.action === 'expand' && toggleAfter.label === 'باز کردن منو',
    JSON.stringify(toggleAfter),
  );

  const collapsedMarker = await page.$eval(
    '[data-testid="core-nav-item"][data-active="true"]',
    (el) => {
      const r = el.getBoundingClientRect();
      const mr = el
        .querySelector('[data-testid="core-nav-active-indicator"]')
        ?.getBoundingClientRect();
      return { itemRight: r.right, markerRight: mr?.right };
    },
  );
  check(
    '7. active indicator stays on the RIGHT edge (collapsed)',
    collapsedMarker.markerRight !== undefined &&
      Math.abs(collapsedMarker.markerRight - collapsedMarker.itemRight) < 2,
    JSON.stringify(collapsedMarker),
  );

  const collapsedRail = await boxOf(page, '[data-testid="core-sidebar"]');
  check(
    '8. collapsed rail stays anchored right',
    collapsedRail.right > 1400 && collapsedRail.width < 100,
    `right=${collapsedRail.right.toFixed(0)} width=${collapsedRail.width.toFixed(0)}`,
  );
  await page.screenshot({ path: `${OUT}/desktop-collapsed.png` });

  await page.focus('[data-testid="core-collapse-toggle"]');
  await page.keyboard.press('Enter');
  await sleep(500);
  const afterEnter = await page.$eval('[data-testid="core-sidebar"]', (el) => el.dataset.collapsed);
  await page.focus('[data-testid="core-collapse-toggle"]');
  await page.keyboard.press('Space');
  await sleep(500);
  const afterSpace = await page.$eval('[data-testid="core-sidebar"]', (el) => el.dataset.collapsed);
  check(
    '9. Enter/Space toggle with no state drift',
    afterEnter === 'false' && afterSpace === 'true',
    `enter=${afterEnter} space=${afterSpace}`,
  );

  await page.click('[data-testid="core-collapse-toggle"]');
  await sleep(500);

  // ---- No horizontal overflow at desktop widths --------------------------
  for (const [w, h] of [
    [1440, 900],
    [1280, 800],
    [1024, 768],
  ]) {
    await page.setViewport({ width: w, height: h });
    await sleep(700);
    const state = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollWidth: document.documentElement.scrollWidth,
      inner: window.innerWidth,
      dir: document.documentElement.getAttribute('dir'),
      rails: document.querySelectorAll('[data-testid="core-sidebar"]').length,
      drawerState: document
        .querySelector('[data-testid="core-mobile-drawer"]')
        ?.getAttribute('data-state'),
    }));
    check(
      `10.${w}. RTL intact, no horizontal overflow, drawer inert`,
      !state.overflow && state.dir === 'rtl' && state.drawerState === 'closed',
      JSON.stringify(state),
    );
  }

  // ---- Bug D: mobile drawer ---------------------------------------------
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/admin/blog`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);

  const closedDrawer = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="core-mobile-drawer"]');
    const panel = document.querySelector('[data-testid="core-mobile-drawer-panel"]');
    const pr = panel.getBoundingClientRect();
    return {
      state: wrap.getAttribute('data-state'),
      visibility: getComputedStyle(wrap).visibility,
      pointerEvents: getComputedStyle(wrap).pointerEvents,
      panelLeft: pr.left,
      panelRight: pr.right,
      inner: window.innerWidth,
      railVisible: document.querySelector('[data-testid="core-sidebar"]')?.offsetParent !== null,
    };
  });
  check(
    '11. mobile: drawer closed, inert and parked off-screen right',
    closedDrawer.state === 'closed' &&
      closedDrawer.visibility === 'hidden' &&
      closedDrawer.pointerEvents === 'none' &&
      closedDrawer.panelLeft >= closedDrawer.inner - 1,
    JSON.stringify(closedDrawer),
  );
  check(
    '12. mobile: persistent rail is not rendered',
    closedDrawer.railVisible === false,
    `railVisible=${closedDrawer.railVisible}`,
  );

  const contentClickable = await page.evaluate(() => {
    const main = document.getElementById('content');
    const r = main.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(Math.max(r.top, 0) + 40),
    );
    return {
      hitTag: hit?.tagName,
      insideDrawer: !!hit?.closest('[data-testid="core-mobile-drawer"]'),
      insideMain: !!hit?.closest('#content'),
    };
  });
  check(
    '13. mobile: closed drawer does not intercept content clicks',
    contentClickable.insideDrawer === false && contentClickable.insideMain === true,
    JSON.stringify(contentClickable),
  );
  await page.screenshot({ path: `${OUT}/mobile-closed.png` });

  await page.click('button[aria-label="نمایش منو"]');
  await sleep(900);

  const openDrawer = await page.evaluate(() => {
    const wrap = document.querySelector('[data-testid="core-mobile-drawer"]');
    const pr = document
      .querySelector('[data-testid="core-mobile-drawer-panel"]')
      .getBoundingClientRect();
    const overlay = document.querySelector('[data-testid="core-mobile-overlay"]');
    return {
      state: wrap.getAttribute('data-state'),
      visibility: getComputedStyle(wrap).visibility,
      overlayOpacity: getComputedStyle(overlay).opacity,
      panelLeft: pr.left,
      panelRight: pr.right,
      inner: window.innerWidth,
      drawerNav: !!document.querySelector('[data-testid="core-sidebar-drawer"]'),
    };
  });
  check(
    '14. mobile: drawer opens FROM the right and touches the right edge',
    openDrawer.state === 'open' &&
      openDrawer.visibility === 'visible' &&
      Math.abs(openDrawer.panelRight - openDrawer.inner) < 2 &&
      openDrawer.panelLeft > 0 &&
      openDrawer.drawerNav,
    JSON.stringify(openDrawer),
  );
  check(
    '15. mobile: overlay is opaque while open',
    Number(openDrawer.overlayOpacity) > 0.9,
    `opacity=${openDrawer.overlayOpacity}`,
  );
  await page.screenshot({ path: `${OUT}/mobile-open.png` });

  // Overlay click closes it. The panel occupies the right side, so click left.
  await page.mouse.click(40, 400);
  await sleep(900);
  const afterOverlayClick = await page.$eval('[data-testid="core-mobile-drawer"]', (el) =>
    el.getAttribute('data-state'),
  );
  check(
    '16. mobile: overlay click closes the drawer',
    afterOverlayClick === 'closed',
    afterOverlayClick,
  );

  await page.click('button[aria-label="نمایش منو"]');
  await sleep(800);
  await page.click('[data-testid="core-drawer-close"]');
  await sleep(800);
  const afterCloseBtn = await page.$eval('[data-testid="core-mobile-drawer"]', (el) =>
    el.getAttribute('data-state'),
  );
  check('17. mobile: close control closes the drawer', afterCloseBtn === 'closed', afterCloseBtn);

  await page.click('button[aria-label="نمایش منو"]');
  await sleep(800);
  await page.evaluate(() => {
    document
      .querySelector('[data-testid="core-sidebar-drawer"]')
      .querySelector('a[href="/admin/profile"]')
      .click();
  });
  await sleep(1800);
  const afterNav = await page.evaluate(() => ({
    state: document
      .querySelector('[data-testid="core-mobile-drawer"]')
      ?.getAttribute('data-state'),
    url: location.pathname,
  }));
  check(
    '18. mobile: selecting a link navigates and closes the drawer',
    afterNav.state === 'closed' && afterNav.url === '/admin/profile',
    JSON.stringify(afterNav),
  );

  const reclosed = await page.evaluate(() => {
    const main = document.getElementById('content');
    const r = main.getBoundingClientRect();
    const hit = document.elementFromPoint(
      Math.round(r.left + r.width / 2),
      Math.round(Math.max(r.top, 0) + 40),
    );
    return {
      insideDrawer: !!hit?.closest('[data-testid="core-mobile-drawer"]'),
      blur: getComputedStyle(main).filter,
    };
  });
  check(
    '19. mobile: content interactive and unblurred after re-close',
    reclosed.insideDrawer === false && (reclosed.blur === 'none' || reclosed.blur === ''),
    JSON.stringify(reclosed),
  );

  const mobileOverflow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    dir: document.documentElement.getAttribute('dir'),
  }));
  check(
    '20. mobile: RTL intact, no horizontal overflow',
    !mobileOverflow.overflow && mobileOverflow.dir === 'rtl',
    JSON.stringify(mobileOverflow),
  );

  // ---- Resize in both directions ----------------------------------------
  await page.click('button[aria-label="نمایش منو"]');
  await sleep(700);
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(1000);
  const grown = await page.evaluate(() => ({
    drawer: document
      .querySelector('[data-testid="core-mobile-drawer"]')
      ?.getAttribute('data-state'),
    railVisible: document.querySelector('[data-testid="core-sidebar"]')?.offsetParent !== null,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check(
    '21. resize mobile -> desktop: drawer auto-closes, rail appears',
    grown.drawer === 'closed' && grown.railVisible === true && !grown.overflow,
    JSON.stringify(grown),
  );

  await page.setViewport({ width: 390, height: 844 });
  await sleep(1000);
  const shrunk = await page.evaluate(() => ({
    drawer: document
      .querySelector('[data-testid="core-mobile-drawer"]')
      ?.getAttribute('data-state'),
    railVisible: document.querySelector('[data-testid="core-sidebar"]')?.offsetParent !== null,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check(
    '22. resize desktop -> mobile: rail hides, drawer stays closed',
    shrunk.drawer === 'closed' && shrunk.railVisible === false && !shrunk.overflow,
    JSON.stringify(shrunk),
  );

  // ---- Accessibility spot-checks ----------------------------------------
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/admin/blog`, { waitUntil: 'domcontentloaded' });
  await sleep(1100);
  const a11y = await page.evaluate(() => {
    const toggle = document.querySelector('[data-testid="core-collapse-toggle"]');
    toggle.focus();
    const nav = document.querySelector('nav[aria-label]');
    const active = document.querySelector('[data-testid="core-nav-item"][data-active="true"]');
    const controls = toggle.getAttribute('aria-controls');
    return {
      toggleFocused: document.activeElement === toggle,
      navLabel: nav?.getAttribute('aria-label'),
      ariaCurrent: active?.getAttribute('aria-current'),
      controls,
      controlsExists: !!document.getElementById(controls),
      decorativeIconsHidden: [...document.querySelectorAll('nav svg')].every(
        (s) => s.getAttribute('aria-hidden') === 'true',
      ),
    };
  });
  check(
    '23. a11y: labelled nav, aria-current, wired aria-controls, hidden decorative icons',
    a11y.navLabel === 'ناوبری اصلی' &&
      a11y.ariaCurrent === 'page' &&
      a11y.controlsExists &&
      a11y.decorativeIconsHidden &&
      a11y.toggleFocused,
    JSON.stringify(a11y),
  );

  const benign =
    /manifest\.json|favicon\.ico|apple-touch-icon\.png|cdn\.jsdelivr\.net|\/api\/v1\/blog\/admin/;
  const realFailures = [...new Set(failedRequests)].filter((u) => !benign.test(u));
  check(
    '24. no unexpected failed requests',
    realFailures.length === 0,
    realFailures.slice(0, 5).join(' || '),
  );

  const appErrors = consoleMessages.filter(
    (m) =>
      m.startsWith('pageerror:') ||
      (m.startsWith('error:') && !/Failed to load resource|Manifest fetch/.test(m)),
  );
  check(
    '25. no application console errors',
    appErrors.length === 0,
    appErrors.slice(0, 4).join(' || '),
  );

  await browser.close();

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
