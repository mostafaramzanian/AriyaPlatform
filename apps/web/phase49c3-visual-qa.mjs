// Phase 49C-3 FINAL BROWSER VISUAL QA GATE — sidebar navigation deduplication.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport and
// verifies that the personal destinations with dedicated access paths elsewhere
// (حساب من / اعلان‌ها / تقویم) are gone from the STATIC rail while:
//   - the header user menu still reaches حساب من,
//   - the header bell still reaches اعلان‌ها (badge/panel/footer link),
//   - the rail's own date chip still deep-links into تقویم,
//   - the three direct routes still render with their own titles,
//   - favourites/recents still resolve the hidden destinations,
//   - no empty group, no overflow, RTL intact, keyboard intact.
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
  [1280, 900, 'phase49c3-shots/qa-49c3-1280'],
  [1440, 900, 'phase49c3-shots/qa-49c3-1440'],
  [1920, 1080, 'phase49c3-shots/qa-49c3-1920'],
];
const MOBILES = [
  [360, 800, 'phase49c3-shots/qa-49c3-360'],
  [390, 844, 'phase49c3-shots/qa-49c3-390'],
  [430, 932, 'phase49c3-shots/qa-49c3-430'],
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

/**
 * Waits until the rail's personalization data has loaded (pinned groups render only
 * after `GET /me/preferences` settles), then resolves whether any pinned group exists.
 */
async function waitForPinnedGroups(page, timeoutMs = 20000) {
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="core-nav-group"]')].some((g) =>
          ['favorites', 'recent'].includes(g.getAttribute('data-group-id') ?? ''),
        ),
      { timeout: timeoutMs },
    )
    .catch(() => null);
}

async function openUserMenu(page) {
  const opener = await page.$('header [aria-haspopup="menu"]');
  if (!opener) return null;
  await opener.click();
  await page.waitForSelector('[role="menu"][aria-label="منوی کاربر"]', { timeout: 10000 });
  await sleep(400);
  return page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    const items = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => ({
      label: item.textContent.trim(),
      href: item.getAttribute('href'),
    }));
    const mr = menu.getBoundingClientRect();
    return {
      items,
      fitsViewport: mr.right <= innerWidth + 1 && mr.left >= -1 && mr.top >= -1,
    };
  });
}

/**
 * STATIC rail metrics. Pinned groups (favorites/recent) are measured SEPARATELY:
 * their rows deliberately still resolve the hidden destinations, so mixing them
 * into the static text would fake a failure.
 *
 * `scope` selects the INSTANCE: the shell always mounts TWO CoreSidebars — the
 * desktop rail (`[data-testid="core-sidebar"]`, CSS-hidden on mobile) and the
 * mobile drawer (`[data-testid="core-sidebar-drawer"]`, visibility-toggled). The
 * default measures the desktop rail; drawer checks must scope to the drawer.
 */
async function measureRail(page, scope = '[data-testid="core-sidebar"]') {
  return page.evaluate((scopeSelector) => {
    const doc = document.scrollingElement;
    const rail = document.querySelector(scopeSelector);
    if (!rail) return null;
    const pinnedIds = new Set(['favorites', 'recent']);
    const staticGroups = [...rail.querySelectorAll('[data-testid="core-nav-group"]')].filter(
      (g) => !pinnedIds.has(g.getAttribute('data-group-id')),
    );
    const staticLabels = staticGroups.flatMap((g) =>
      [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) => n.textContent.trim()),
    );
    const pinnedRowLabels = [...rail.querySelectorAll('[data-testid="core-nav-group"]')]
      .filter((g) => pinnedIds.has(g.getAttribute('data-group-id')))
      .flatMap((g) =>
        [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) => n.textContent.trim()),
      );
    const pinnedGroupIds = [...rail.querySelectorAll('[data-testid="core-nav-group"]')]
      .map((g) => g.getAttribute('data-group-id'))
      .filter((id) => pinnedIds.has(id));
    const chip = rail.querySelector('[data-testid="core-date-chip"]');
    const bell = document.querySelector('[data-testid="notification-bell"]');
    const activeIndicator = rail.querySelector('[data-testid="core-nav-active-indicator"]');
    return {
      dir: document.documentElement.getAttribute('dir'),
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      groupIds: staticGroups.map((g) => g.getAttribute('data-group-id')),
      staticLabels,
      pinnedGroupIds,
      pinnedRowLabels,
      chipPresent: Boolean(chip),
      chipAriaLabel: chip?.getAttribute('aria-label') ?? null,
      chipVisible: chip ? chip.getBoundingClientRect().width > 0 : false,
      bellPresent: Boolean(bell),
      bellAriaLabel: bell?.getAttribute('aria-label') ?? null,
      hasActiveIndicator: Boolean(activeIndicator),
      activeOnHome: activeIndicator
        ?.closest('[data-testid="core-nav-item"]')
        ?.textContent?.includes('خانه') ?? false,
    };
  }, scope);
}

/** True when EVERY drawer instance is visually closed (off-viewport or invisible). */
async function drawerFullyClosed(page) {
  return page.evaluate(() => {
    const drawers = [...document.querySelectorAll('[data-testid="core-sidebar-drawer"]')];
    return (
      drawers.length > 0 &&
      drawers.every((el) => {
        const r = el.getBoundingClientRect();
        const hiddenByClass = (() => {
          let node = el;
          while (node && node !== document.body) {
            if (node.classList?.contains('invisible')) return true;
            node = node.parentElement;
          }
          return false;
        })();
        return r.width === 0 || r.left >= innerWidth - 1 || r.right <= 1 || hiddenByClass;
      })
    );
  });
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    // Puppeteer 25's pinned download is absent from the local cache; drive the REAL
    // system Chrome (same engine) instead of downloading a second copy.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userDataDir: 'qa-49c3-profile',
  });
  const page = await browser.newPage();
  // Diagnostics: every preferences request, so a silently-swallowed recordVisit
  // failure is visible in the evidence log instead of a bare FAIL.
  page.on('response', (res) => {
    if (res.url().includes('/me/preferences')) {
      console.log(`PREFS ${res.request().method()} ${res.status()}`);
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('/me/preferences')) {
      console.log(`PREFS ${req.method()} FAILED ${req.failure()?.errorText ?? '?'}`);
    }
  });
  await page.setViewport({ width: 1440, height: 900 });
  await signIn(page);

  // ---------------------------------------------------------------------
  // DESKTOP — static rail is deduplicated at every desktop viewport.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of DESKTOPS) {
    await page.setViewport({ width: w, height: h });
    await gotoShell(page, '/admin');
    const m = await measureRail(page);

    check(m.dir === 'rtl', `${w}: RTL remains applied`, `dir=${m.dir}`);
    check(!m.horizontalOverflow, `${w}: no horizontal page overflow`);

    check(!m.staticLabels.some((l) => l.includes('حساب من')), `${w}: حساب من absent from static rail`);
    check(!m.staticLabels.some((l) => l.includes('اعلان‌ها')), `${w}: اعلان‌ها absent from static rail`);
    check(!m.staticLabels.some((l) => l.includes('تقویم')), `${w}: تقویم absent from static rail`);

    for (const keep of ['خانه', 'پیام‌ها', 'دفترچه سازمانی', 'وبلاگ', 'پشتیبانی', 'نظرسنجی‌ها']) {
      check(
        m.staticLabels.some((l) => l.includes(keep)),
        `${w}: ${keep} remains in the rail`,
      );
    }

    check(
      JSON.stringify(m.groupIds) === JSON.stringify(['overview', 'content', 'services']),
      `${w}: no empty group, groups intact`,
      JSON.stringify(m.groupIds),
    );
    check(m.chipPresent && m.chipVisible, `${w}: date chip (calendar entry) visible`, m.chipAriaLabel ?? '');
    check(
      (m.chipAriaLabel ?? '').startsWith('تقویم'),
      `${w}: date chip is labelled as the calendar entry`,
      m.chipAriaLabel ?? '',
    );
    check(m.bellPresent, `${w}: header bell present`, m.bellAriaLabel ?? '');
    check(m.activeOnHome, `${w}: active-route highlight still works on remaining rows`);

    await page.screenshot({ path: `${out}/01-sidebar.png`, fullPage: false });
  }

  // ---------------------------------------------------------------------
  // CALENDAR — the date chip is the real alternate entry point (1440).
  // ---------------------------------------------------------------------
  await page.setViewport({ width: 1440, height: 900 });
  await gotoShell(page, '/admin');
  await page.click('[data-testid="core-date-chip"]');
  await page.waitForSelector('[data-testid="core-date-chip-surface"]', { timeout: 10000 });
  await sleep(1500);
  check(true, 'calendar: date chip opens its picker surface');
  await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/02-datechip-surface.png' });
  await page.click('[data-testid="jalali-today-button"]');
  await sleep(4000);
  check(
    page.url().includes('/admin/calendar'),
    'calendar: chip today button deep-links into /admin/calendar',
    page.url(),
  );
  {
    const title = await page.evaluate(() => document.querySelector('header h1')?.textContent?.trim());
    const hasContent = await page.evaluate(() => Boolean(document.querySelector('main > *')));
    check(title === 'تقویم', 'calendar: /admin/calendar renders with its own title', title ?? '');
    check(hasContent, 'calendar: calendar view renders');
    await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/03-calendar-via-chip.png', fullPage: false });
  }

  // Direct URL still works.
  await gotoShell(page, '/admin/calendar');
  {
    const title = await page.evaluate(() => document.querySelector('header h1')?.textContent?.trim());
    const hasContent = await page.evaluate(() => Boolean(document.querySelector('main > *')));
    check(title === 'تقویم' && hasContent, 'calendar: direct URL /admin/calendar still valid', title ?? '');
  }

  // ---------------------------------------------------------------------
  // NOTIFICATIONS — the header bell remains the canonical entry (1440).
  // ---------------------------------------------------------------------
  await gotoShell(page, '/admin');
  await page.click('[data-testid="notification-bell"]');
  await page.waitForSelector('[data-testid="notification-panel"]', { timeout: 10000 });
  await sleep(1500);
  {
    const panel = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="notification-panel"]');
      const link = [...p.querySelectorAll('a')].find((a) =>
        a.getAttribute('href')?.startsWith('/admin/notifications'),
      );
      return {
        present: Boolean(p),
        footerHref: link?.getAttribute('href') ?? null,
        footerLabel: link?.textContent?.trim() ?? null,
      };
    });
    check(panel.present, 'notifications: bell opens the existing panel');
    check(
      panel.footerHref === '/admin/notifications',
      'notifications: panel footer links to the notifications page',
      `${panel.footerLabel} -> ${panel.footerHref}`,
    );
    await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/04-bell-panel.png' });

    await page.evaluate(() => {
      const p = document.querySelector('[data-testid="notification-panel"]');
      [...p.querySelectorAll('a')]
        .find((a) => a.getAttribute('href')?.startsWith('/admin/notifications'))
        .click();
    });
    await sleep(3500);
    check(
      page.url().includes('/admin/notifications'),
      'notifications: panel link navigates to /admin/notifications',
      page.url(),
    );
  }
  await gotoShell(page, '/admin/notifications');
  {
    const title = await page.evaluate(() => document.querySelector('header h1')?.textContent?.trim());
    const hasContent = await page.evaluate(() => Boolean(document.querySelector('main > *')));
    check(
      title === 'اعلان‌ها' && hasContent,
      'notifications: direct URL /admin/notifications still valid',
      title ?? '',
    );
    await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/05-notifications-direct.png', fullPage: false });
  }
  {
    const kb = await page.evaluate(() => {
      const bell = document.querySelector('[data-testid="notification-bell"]');
      bell.focus();
      const cs = getComputedStyle(bell);
      return { tag: bell.tagName, outline: cs.outlineStyle, shadow: cs.boxShadow !== 'none' };
    });
    check(
      kb.tag === 'BUTTON' && (kb.outline !== 'none' || kb.shadow),
      'notifications: bell is a keyboard-operable button with visible focus',
      JSON.stringify(kb),
    );
  }

  // ---------------------------------------------------------------------
  // HEADER ACCOUNT — the user menu remains the canonical entry (1440).
  // ---------------------------------------------------------------------
  await gotoShell(page, '/admin');
  {
    const menu = await openUserMenu(page);
    check(Boolean(menu), 'account: user chip opens the existing dropdown');
    check(menu?.items.some((i) => i.label.includes('حساب من')), 'account: dropdown حساب من unchanged');
    check(menu?.items.some((i) => i.label.includes('تنظیمات')), 'account: dropdown تنظیمات unchanged');
    check(menu?.items.some((i) => i.label.includes('خروج')), 'account: dropdown خروج unchanged');
    check(menu?.fitsViewport === true, 'account: dropdown fits the viewport');
    await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/06-user-menu.png' });

    await page.evaluate(() => {
      [...document.querySelectorAll('[role="menuitem"]')]
        .find((i) => i.textContent.includes('حساب من'))
        .click();
    });
    // Long dwell ON PURPOSE: `recordVisit` only attaches once the preferences GET
    // settles, and its PATCH must COMPLETE on this page for the server to store the
    // visit — a short dwell leaves the request aborted mid-flight by the next
    // navigation, which would fake a personalization regression below.
    await sleep(9000);
    check(
      page.url().includes('/admin/profile'),
      'account: menu حساب من navigates to /admin/profile',
      page.url(),
    );
  }
  await gotoShell(page, '/admin/profile', 9000);
  {
    const title = await page.evaluate(() => document.querySelector('header h1')?.textContent?.trim());
    const hasContent = await page.evaluate(() => Boolean(document.querySelector('main > *')));
    check(title === 'حساب من' && hasContent, 'account: direct URL /admin/profile still valid', title ?? '');
    await page.screenshot({ path: 'phase49c3-shots/qa-49c3-1440/07-profile-direct.png', fullPage: false });
  }

  /*
   * FAVOURITES / RECENTS — hiding a static row must not delete personalization.
   *
   * The rail RESOLVER is proven on a dedicated page whose preferences GET is
   * fulfilled with stored references to the rail-hidden destinations (the same
   * shape the real server returns — 49C-3 changed nothing about this contract).
   * A dedicated page keeps the main flow untouched.
   *
   * NOTE (pre-existing, OUT OF 49C-3 SCOPE): on a FULL page load the visit recorder
   * can fire before `GET /me/preferences` resolves and persist a clobbered
   * single-entry `navRecent` (PATCH 200s visible in the PREFS log above). That is
   * 49K provider behaviour, unchanged by this phase (`recordVisit` / `CoreShell`
   * are not part of the 49C-3 diff) and invisible in normal SPA navigation; it is
   * reported, not fixed, here. Favourites are unaffected (the clobbering PATCH
   * sends only `navRecent`).
   */
  {
    const probe = await browser.newPage();
    await probe.setViewport({ width: 1440, height: 900 });
    await probe.setRequestInterception(true);
    probe.on('request', (req) => {
      const isPrefsRead =
        req.url().includes('/me/preferences') &&
        (req.method() === 'GET' || req.method() === 'PATCH');
      if (!isPrefsRead) {
        req.continue();
        return;
      }
      // Fulfil the provider's GET (and PATCH-confirmed) responses with the REAL
      // server row + stored references to the rail-hidden destinations — exactly the
      // contract the resolver consumes, made deterministic against the visit
      // recorder's pre-load write.
      fetch(req.url(), {
        method: req.method(),
        headers: {
          Authorization: req.headers().authorization ?? '',
          'Content-Type': 'application/json',
        },
        body: req.method() === 'PATCH' ? req.postData() ?? undefined : undefined,
      })
        .then((r) => r.json())
        .then((body) => {
          const d = body.data ?? body;
          if (d) {
            d.navFavorites = ['/admin/calendar'];
            d.navRecent = ['/admin', '/admin/profile', '/admin/notifications'];
          }
          req.respond({
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              // The page's fetch is cross-origin (:3000 → :3001); without the API's
              // CORS headers the fulfilled response would be unreadable.
              'Access-Control-Allow-Origin': 'http://localhost:3000',
              'Access-Control-Allow-Credentials': 'true',
            },
            body: JSON.stringify(body),
          });
        })
        .catch(() => req.continue());
    });

    await probe.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await probe
      .waitForSelector('[data-testid="core-sidebar"]', { timeout: 60000 })
      .catch(() => {});
    await probe
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="core-nav-group"]')].some((g) =>
            ['favorites', 'recent'].includes(g.getAttribute('data-group-id') ?? ''),
          ),
        { timeout: 20000 },
      )
      .catch(() => {});

    const pinned = await probe.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      const pinnedIds = new Set(['favorites', 'recent']);
      const pinnedGroupIds = [...rail.querySelectorAll('[data-testid="core-nav-group"]')]
        .map((g) => g.getAttribute('data-group-id'))
        .filter((id) => pinnedIds.has(id));
      const pinnedRowLabels = [...rail.querySelectorAll('[data-testid="core-nav-group"]')]
        .filter((g) => pinnedIds.has(g.getAttribute('data-group-id')))
        .flatMap((g) =>
          [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) =>
            n.textContent.trim(),
          ),
        );
      const staticGroups = [...rail.querySelectorAll('[data-testid="core-nav-group"]')].filter(
        (g) => !pinnedIds.has(g.getAttribute('data-group-id')),
      );
      const staticLabels = staticGroups.flatMap((g) =>
        [...g.querySelectorAll('[data-testid="core-nav-item"]')].map((n) => n.textContent.trim()),
      );
      return { pinnedGroupIds, pinnedRowLabels, staticLabels };
    });

    check(
      pinned.pinnedRowLabels.includes('تقویم'),
      'personalization: pinned FAVOURITE تقویم still resolves without a static row',
      JSON.stringify({ groups: pinned.pinnedGroupIds, rows: pinned.pinnedRowLabels }),
    );
    check(
      pinned.pinnedRowLabels.includes('حساب من') && pinned.pinnedRowLabels.includes('اعلان‌ها'),
      'personalization: pinned RECENTS حساب من/اعلان‌ها still resolve without static rows',
      JSON.stringify({ rows: pinned.pinnedRowLabels }),
    );
    check(
      !pinned.staticLabels.some((l) => l.includes('حساب من') || l.includes('تقویم')),
      'personalization: static rail stays deduplicated while pinned rows resolve',
    );
    await probe.screenshot({
      path: 'phase49c3-shots/qa-49c3-1440/08-pinned-personal.png',
      fullPage: false,
    });
    await probe.close();
  }

  // ---------------------------------------------------------------------
  // ACCESSIBILITY SMOKE — rail keyboard + drawer semantics (1440).
  // ---------------------------------------------------------------------
  {
    const kb = await page.evaluate(() => {
      const first = document.querySelector('[data-testid="core-sidebar"] a[href]');
      first.focus();
      const cs = getComputedStyle(first);
      return {
        tag: first.tagName,
        label: first.textContent.trim(),
        outline: cs.outlineStyle,
        shadow: cs.boxShadow !== 'none',
      };
    });
    check(
      kb.tag === 'A' && (kb.outline !== 'none' || kb.shadow),
      'accessibility: rail link keyboard focus is visible',
      JSON.stringify(kb),
    );
  }

  // ---------------------------------------------------------------------
  // MOBILE — drawer variant carries the same deduplicated rail.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of MOBILES) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoShell(page, '/admin');

    const base = await page.evaluate(() => {
      const doc = document.scrollingElement;
      const bell = document.querySelector('[data-testid="notification-bell"]');
      return {
        overflow: doc.scrollWidth > doc.clientWidth + 1,
        bellVisible: bell ? bell.getBoundingClientRect().width > 0 : false,
      };
    });
    check(!base.overflow, `${w}: no horizontal page overflow (closed drawer)`);
    check(base.bellVisible, `${w}: header bell remains visible`);

    await page.click('header button[aria-label="نمایش منو"]');
    await page.waitForSelector('[data-testid="core-sidebar-drawer"]', { timeout: 10000 });
    await sleep(1500);

    // Measure the DRAWER instance: the shell keeps BOTH sidebars mounted (the
    // desktop rail is merely CSS-hidden on mobile), so unscoped queries would read
    // the hidden rail's zero-width chip instead of the drawer's real one.
    const drawer = await measureRail(page, '[data-testid="core-sidebar-drawer"]');
    // The calendar's alternate entry (date chip) lives INSIDE the drawer on mobile.
    check(
      drawer.chipPresent && drawer.chipVisible && (drawer.chipAriaLabel ?? '').startsWith('تقویم'),
      `${w}: drawer keeps the date chip (calendar alternate entry)`,
      drawer.chipAriaLabel ?? '',
    );
    check(
      !drawer.staticLabels.some((l) => l.includes('حساب من')),
      `${w}: drawer حساب من absent`,
    );
    check(!drawer.staticLabels.some((l) => l.includes('اعلان‌ها')), `${w}: drawer اعلان‌ها absent`);
    check(!drawer.staticLabels.some((l) => l.includes('تقویم')), `${w}: drawer تقویم absent`);
    check(drawer.staticLabels.some((l) => l.includes('خانه')), `${w}: drawer keeps خانه`);
    check(drawer.staticLabels.some((l) => l.includes('پشتیبانی')), `${w}: drawer keeps پشتیبانی`);
    check(
      JSON.stringify(drawer.groupIds) === JSON.stringify(['overview', 'content', 'services']),
      `${w}: drawer groups intact`,
      JSON.stringify(drawer.groupIds),
    );
    check(!drawer.horizontalOverflow, `${w}: no horizontal overflow (drawer open)`);
    await page.screenshot({ path: `${out}/01-drawer.png`, fullPage: false });

    /*
     * Escape closes the drawer (existing semantics preserved). The drawer wrapper is
     * ALWAYS mounted and hides via `invisible` + `translate-x-full` — so the closed
     * state is a VISIBILITY fact, never a removal. Poll the geometry/class state.
     */
    await page.keyboard.press('Escape');
    const drawerGone = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('[data-testid="core-sidebar-drawer"]')].every((el) => {
            const r = el.getBoundingClientRect();
            let node = el;
            let hiddenByClass = false;
            while (node && node !== document.body) {
              if (node.classList?.contains('invisible')) {
                hiddenByClass = true;
                break;
              }
              node = node.parentElement;
            }
            return r.width === 0 || r.left >= innerWidth - 1 || r.right <= 1 || hiddenByClass;
          }),
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    check(drawerGone, `${w}: Escape still closes the drawer`);
  }

  await browser.close();
}

let fatal = null;
try {
  for (const dir of ['qa-49c3-1280', 'qa-49c3-1440', 'qa-49c3-1920', 'qa-49c3-360', 'qa-49c3-390', 'qa-49c3-430']) {
    await mkdir(`phase49c3-shots/${dir}`, { recursive: true });
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
