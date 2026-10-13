// Phase 49K browser validation harness: personalization (theme, density, text scale,
// motion), the settings surface, navigation favourites, drawer focus management, RTL,
// responsive overflow, and preference isolation between two real accounts.
//
// Exercises the real stack rather than mocks: it signs in, drives the actual selects on
// /admin/profile, reloads to prove the values came back from `GET /me/preferences` and not
// from the pre-paint cache, measures the RENDERED effect of each setting (row height, root
// font-size, transition duration) instead of trusting the attribute alone, then signs out
// and signs in as a second account to prove nothing carried over.
//
// Targets web :3000 against API :3001 (the API the web app is configured to use — see
// `src/lib/constants.ts`).
//
// State it touches, and how it is put back:
//   - the admin's `UserPreference` row is restored to its pre-run values at the end;
//   - a FIXED second account is created on first run and reused afterwards, so repeated
//     runs do not accumulate users;
//   - the stale favourite planted for the permission test is deleted at the end.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3001/api/v1';
const OUT = 'phase49k-shots';

const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';
const ADMIN_ID = 'super-admin-user';

const SECOND_EMAIL = 'k49k-isolation@example.com';
const SECOND_PASSWORD = 'ChangeMe123!';

/** The favourite this harness pins and then removes. A real nav row, never a raw URL. */
const FIXTURE_FAVORITE = '/admin/calendar';
/** A real nav target gated behind `admin:users:read`, which a VISITOR does not hold. */
const FORBIDDEN_FAVORITE = '/admin/directory';

const results = [];
const consoleMessages = [];

let step = 0;
const check = (name, ok, detail = '') => {
  step += 1;
  results.push({ name: `${step}. ${name}`, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}. ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs SQL in the Core database. Used to observe stored rows and to restore them. */
function psql(sql) {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      [
        'exec', '-i', 'aria-erp-postgres',
        'psql', '-U', 'aria_user', '-d', 'core_db',
        '-t', '-A', '-v', 'ON_ERROR_STOP=1',
      ],
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: `${stdout}`.trim(), err: `${stderr}`.trim() });
      },
    );
    child.stdin.end(sql);
  });
}

/** Sets a controlled `<select>`/`<input>` the way React observes it. */
async function setInput(page, selector, value) {
  await page.$eval(
    selector,
    (el, v) => {
      const proto =
        el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value,
  );
  // The provider applies optimistically and PATCHes; give the request a beat to land so a
  // later reload reads the persisted row rather than racing it.
  await sleep(1200);
}

/** The appearance state as `<html>` currently carries it, plus what it measures to. */
function readAppearance(page) {
  return page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    dark: document.documentElement.classList.contains('dark'),
    density: document.documentElement.getAttribute('data-density'),
    textScale: document.documentElement.getAttribute('data-text-scale'),
    motion: document.documentElement.getAttribute('data-motion'),
    dir: document.documentElement.getAttribute('dir'),
    rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize),
    owner: window.localStorage.getItem('aria-pref-owner'),
  }));
}

/** Horizontal overflow of the document: what a user feels as a sideways scroll. */
function overflowOf(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Height of the first sidebar nav row — the most density-sensitive dimension there is. */
function rowHeight(page) {
  return page.evaluate(() => {
    const row = document.querySelector(
      '[data-testid="core-sidebar"] [data-testid="core-nav-item"]',
    );
    return row ? Math.round(row.getBoundingClientRect().height) : null;
  });
}

/** Transition duration the rail actually resolves to. */
function railTransition(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('[data-testid="core-sidebar"]');
    return rail ? getComputedStyle(rail).transitionDuration : null;
  });
}

/** Types credentials and submits; the form only reacts to real key events. */
async function submitLogin(page, email, password) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]');
  await sleep(7000); // hydration: the submit handler is client-side only
  await page.click('input[name="email"]', { clickCount: 3 });
  await page.type('input[name="email"]', email);
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await sleep(9000); // login round-trip plus the client-side router.push
}

/**
 * Signs in, retrying because hydration timing makes a single submit flaky.
 * NOTE: never wait for networkidle on this app — the messaging WebSocket holds a
 * connection open, so networkidle2 never settles.
 */
async function signIn(page, email = EMAIL, password = PASSWORD) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitLogin(page, email, password);
    if (!page.url().includes('/login')) return true;
  }
  return false;
}

/** Navigates inside /admin and waits for the shell, tolerating a hydration miss. */
async function gotoAdmin(page, path, email = EMAIL, password = PASSWORD) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.waitForSelector('[data-testid="core-mobile-drawer"]', { timeout: 20000 });
      await sleep(2500); // let the preference read settle and paint
      return;
    } catch {
      if (page.url().includes('/login')) {
        await signIn(page, email, password);
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      await sleep(4000);
    }
  }
  throw new Error(`shell never mounted at ${path} :: ${page.url()}`);
}

/** Signs out through the header menu, i.e. the way a user does it. */
async function signOut(page) {
  await page.click('button[aria-haspopup="menu"]');
  await sleep(800);
  await page.click('[role="menu"] button[role="menuitem"]');
  await sleep(8000);
}

/** Creates the second account if it does not exist yet. Idempotent across runs. */
async function ensureSecondAccount() {
  try {
    const response = await fetch(`${API}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: SECOND_EMAIL,
        password: SECOND_PASSWORD,
        firstName: 'K49K',
        lastName: 'Isolation',
      }),
    });
    // 409 means it already exists, which is the expected state from the second run on.
    return { ok: response.ok || response.status === 409, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, detail: String(error) };
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // The admin's row as it is BEFORE the run, so the harness can put it back exactly.
  const before = await psql(
    `select theme || '|' || density || '|' || "textScale" || '|' || motion || '|' ||
            "sidebarCollapsed" || '|' || array_to_string("navFavorites", ',')
       from "UserPreference" where "userId" = '${ADMIN_ID}';`,
  );
  console.log(`pre-run admin row :: ${before.out || '(none)'}`);

  const registration = await ensureSecondAccount();
  console.log(`second account :: status ${registration.status}`);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleMessages.push(`pageerror: ${e.message}`));
  await page.setViewport({ width: 1440, height: 900 });

  try {
    check('second account exists or was created', registration.ok, `status=${registration.status}`);

    /* ---------------------------- RTL and the skip link ---------------------------- */

    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);

    const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
    check('document direction is RTL', dir === 'rtl', `dir=${dir}`);

    // X1: the first Tab must reveal the skip link on the LEADING (right) side under RTL.
    await page.keyboard.press('Tab');
    await sleep(300);
    const skip = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        cls: el.className,
        text: el.textContent.trim(),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        viewport: window.innerWidth,
        outline: getComputedStyle(el).outlineWidth,
      };
    });
    check(
      'first Tab focuses the skip link and reveals it',
      Boolean(skip && skip.cls.includes('skip-link') && skip.width > 20),
      JSON.stringify(skip),
    );
    check(
      'skip link is revealed on the RTL leading (right) side',
      Boolean(skip && skip.right > skip.viewport * 0.6),
      skip ? `right=${skip.right} of ${skip.viewport}` : 'no focus',
    );
    await page.screenshot({ path: `${OUT}/01-skip-link.png` });

    /* -------------------------------- appearance -------------------------------- */

    const signedIn = await signIn(page);
    check('signed in as the primary account', signedIn, page.url());

    await gotoAdmin(page, '/admin/profile');
    await page.waitForSelector('[data-testid="appearance-theme"]', { timeout: 20000 });

    const comfortableRow = await rowHeight(page);
    const baseFont = (await readAppearance(page)).rootFontPx;
    const fullMotion = await railTransition(page);

    // Density is measured BEFORE the text scale changes. Row height is a rem token
    // (`--core-row-h`), so 140% text would grow the row and hide the compact shrink —
    // measuring both at once would produce a green check for the wrong reason.
    await setInput(page, '[data-testid="appearance-density"]', 'COMPACT');
    await sleep(600);
    const compactRow = await rowHeight(page);
    check(
      'density changes the rendered row height, not just the attribute',
      Boolean(comfortableRow && compactRow && compactRow < comfortableRow),
      `comfortable=${comfortableRow}px compact=${compactRow}px`,
    );

    await setInput(page, '[data-testid="appearance-theme"]', 'DARK');
    await setInput(page, '[data-testid="appearance-text-scale"]', '140');
    await setInput(page, '[data-testid="appearance-motion"]', 'REDUCED');
    await sleep(1500);

    const applied = await readAppearance(page);
    check(
      'all four settings apply immediately',
      applied.theme === 'dark' &&
        applied.dark &&
        applied.density === 'compact' &&
        applied.textScale === '140' &&
        applied.motion === 'reduced',
      JSON.stringify(applied),
    );

    check(
      'text scale changes the root font size by the stated factor',
      Math.abs(applied.rootFontPx / baseFont - 1.4) < 0.02,
      `${baseFont}px -> ${applied.rootFontPx}px`,
    );

    const reducedMotion = await railTransition(page);
    check(
      'reduced motion collapses transitions to a near-zero duration',
      Boolean(reducedMotion && parseFloat(reducedMotion) < 0.01) &&
        Boolean(fullMotion && parseFloat(fullMotion) > 0.05),
      `full=${fullMotion} reduced=${reducedMotion}`,
    );
    await page.screenshot({ path: `${OUT}/02-dark-compact-140.png` });


    /* --------------------- persistence across a full reload --------------------- */

    // The pre-paint cache would show the same appearance even if nothing had been saved,
    // so the reload is followed by a direct read of the stored row.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(6000);
    const reloaded = await readAppearance(page);
    check(
      'appearance survives a reload',
      reloaded.theme === 'dark' &&
        reloaded.density === 'compact' &&
        reloaded.textScale === '140' &&
        reloaded.motion === 'reduced',
      JSON.stringify(reloaded),
    );

    const stored = await psql(
      `select theme || '|' || density || '|' || "textScale" || '|' || motion
         from "UserPreference" where "userId" = '${ADMIN_ID}';`,
    );
    check(
      'the stored row holds the change, not just the browser',
      stored.out === 'DARK|COMPACT|140|REDUCED',
      `row=${stored.out || '(none)'}`,
    );
    check(
      'the appearance cache is attributed to the signed-in account',
      reloaded.owner === ADMIN_ID,
      `owner=${reloaded.owner}`,
    );

    /* ------------------------- overflow at 140% text ------------------------- */

    const profileOverflow = await overflowOf(page);
    check(
      'no horizontal overflow on settings at COMPACT + 140%',
      profileOverflow <= 1,
      `overflow=${profileOverflow}px`,
    );

    await gotoAdmin(page, '/admin');
    const dashboardOverflow = await overflowOf(page);
    const widgetCount = await page.evaluate(
      () => document.querySelectorAll('[data-testid="core-widget"]').length,
    );
    check(
      'dashboard renders its widgets at COMPACT + 140% without overflow',
      dashboardOverflow <= 1 && widgetCount > 0,
      `overflow=${dashboardOverflow}px widgets=${widgetCount}`,
    );
    await page.screenshot({ path: `${OUT}/03-dashboard-compact-140.png`, fullPage: true });

    /* ------------------------------- favourites ------------------------------- */

    const starClicked = await page.evaluate((href) => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="core-sidebar"] [data-testid="core-nav-item"]'),
      );
      const row = rows.find((node) => {
        const link = node.querySelector('a[href]');
        return link && new URL(link.href).pathname === href;
      });
      const star = row && row.querySelector('[data-testid="core-nav-favorite"]');
      if (!star) return false;
      star.click();
      return true;
    }, FIXTURE_FAVORITE);
    await sleep(2500);
    check('the rail offers a star on a real nav row', starClicked, FIXTURE_FAVORITE);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(6000);
    const pinned = await page.evaluate(() => {
      const groups = Array.from(
        document.querySelectorAll('[data-testid="core-sidebar"] [data-testid="core-nav-group"]'),
      );
      const first = groups[0];
      return {
        firstGroup: first ? first.getAttribute('data-group-id') : null,
        rows: first
          ? Array.from(first.querySelectorAll('[data-testid="core-nav-item"] a[href]')).map(
              (n) => new URL(n.href).pathname,
            )
          : [],
      };
    });
    check(
      'the favourite is pinned above the static navigation after a reload',
      pinned.firstGroup === 'favorites' && pinned.rows.join(',') === FIXTURE_FAVORITE,
      JSON.stringify(pinned),
    );

    await gotoAdmin(page, '/admin/profile');
    const inSettings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="favorite-entry"]')).map((n) =>
        n.textContent.trim(),
      ),
    );
    check(
      'settings lists the same favourite the rail pinned',
      inSettings.length === 1,
      JSON.stringify(inSettings),
    );
    await page.screenshot({ path: `${OUT}/04-settings-navigation.png`, fullPage: true });

    await page.click('[data-testid="favorite-remove"]');
    await sleep(2500);
    const afterRemoval = await page.evaluate(() => ({
      entries: document.querySelectorAll('[data-testid="favorite-entry"]').length,
      groups: Array.from(
        document.querySelectorAll('[data-testid="core-sidebar"] [data-testid="core-nav-group"]'),
      ).map((n) => n.getAttribute('data-group-id')),
    }));
    check(
      'removing it from settings unpins it from the rail',
      afterRemoval.entries === 0 && !afterRemoval.groups.includes('favorites'),
      JSON.stringify(afterRemoval),
    );


    /* ------------------- sidebar collapse as a saved preference ------------------- */

    // N1 in the audit: this was React state, so it reset on every reload.
    await page.click('[data-testid="core-collapse-toggle"]');
    await sleep(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(6000);
    const collapsedAfterReload = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      return {
        collapsed: rail ? rail.getAttribute('data-collapsed') : null,
        width: rail ? Math.round(rail.getBoundingClientRect().width) : null,
      };
    });
    check(
      'a collapsed rail stays collapsed across a reload',
      collapsedAfterReload.collapsed === 'true' && collapsedAfterReload.width < 140,
      JSON.stringify(collapsedAfterReload),
    );
    await page.screenshot({ path: `${OUT}/05-rail-collapsed.png` });

    // Put the rail back so the remaining measurements see the normal layout.
    await page.click('[data-testid="core-collapse-toggle"]');
    await sleep(2000);

    /* ------------------------ focus visibility (keyboard) ------------------------ */

    const focusRing = await page.evaluate(() => {
      const link = document.querySelector('[data-testid="core-nav-link"]');
      if (!link) return null;
      link.focus();
      const style = getComputedStyle(link);
      return {
        focused: document.activeElement === link,
        outline: style.outlineWidth,
        shadow: style.boxShadow,
      };
    });
    check(
      'a focused nav row shows a visible focus indicator',
      Boolean(
        focusRing &&
          focusRing.focused &&
          (parseFloat(focusRing.outline) > 0 || (focusRing.shadow && focusRing.shadow !== 'none')),
      ),
      JSON.stringify(focusRing),
    );

    /* ------------------ prefers-reduced-motion, in both directions ------------------ */

    // SYSTEM must follow the OS setting, and FULL must be able to override it. Emulating
    // the media feature is the only honest way to test the first half.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await gotoAdmin(page, '/admin/profile');
    await setInput(page, '[data-testid="appearance-motion"]', 'SYSTEM');
    await sleep(1200);
    const systemUnderOsReduce = await railTransition(page);
    check(
      'motion=SYSTEM honours the OS reduced-motion setting',
      Boolean(systemUnderOsReduce && parseFloat(systemUnderOsReduce) < 0.01),
      `transition=${systemUnderOsReduce}`,
    );

    await setInput(page, '[data-testid="appearance-motion"]', 'FULL');
    await sleep(1200);
    const fullUnderOsReduce = await railTransition(page);
    check(
      'motion=FULL overrides the OS setting, as the control promises',
      Boolean(fullUnderOsReduce && parseFloat(fullUnderOsReduce) > 0.05),
      `transition=${fullUnderOsReduce}`,
    );
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);


    /* --------------------------- mobile: drawer and touch --------------------------- */

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await gotoAdmin(page, '/admin');
    await sleep(1500);

    const mobileOverflow = await overflowOf(page);
    check(
      'no horizontal overflow on the dashboard at 390px',
      mobileOverflow <= 1,
      `overflow=${mobileOverflow}px`,
    );

    const hamburger = await page.evaluate(() => {
      const button = document.querySelector('button[aria-label="نمایش منو"]');
      if (!button) return null;
      const rect = button.getBoundingClientRect();
      return { w: Math.round(rect.width), h: Math.round(rect.height) };
    });
    check(
      'the mobile nav trigger meets a usable touch target size',
      Boolean(hamburger && hamburger.w >= 40 && hamburger.h >= 40),
      JSON.stringify(hamburger),
    );

    // X6: focus must move INTO the drawer on open, not stay on the hamburger behind the
    // overlay, and Escape must close it and hand focus back.
    await page.focus('button[aria-label="نمایش منو"]');
    await page.keyboard.press('Enter');
    await sleep(900);
    const drawerFocus = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="core-mobile-drawer-panel"]');
      const layer = document.querySelector('[data-testid="core-mobile-drawer"]');
      const active = document.activeElement;
      return {
        state: layer ? layer.getAttribute('data-state') : null,
        inside: Boolean(panel && active && panel.contains(active)),
        tag: active ? active.tagName : null,
      };
    });
    check(
      'opening the drawer moves focus inside it',
      drawerFocus.state === 'open' && drawerFocus.inside,
      JSON.stringify(drawerFocus),
    );
    await page.screenshot({ path: `${OUT}/06-mobile-drawer.png` });

    // Tab must not escape the open drawer.
    for (let i = 0; i < 25; i += 1) await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="core-mobile-drawer-panel"]');
      return Boolean(panel && document.activeElement && panel.contains(document.activeElement));
    });
    check('Tab stays within the open drawer', stillInside, `after 25 tabs inside=${stillInside}`);

    await page.keyboard.press('Escape');
    await sleep(900);
    const afterEscape = await page.evaluate(() => {
      const layer = document.querySelector('[data-testid="core-mobile-drawer"]');
      const opener = document.querySelector('button[aria-label="نمایش منو"]');
      return {
        state: layer ? layer.getAttribute('data-state') : null,
        restored: Boolean(opener) && document.activeElement === opener,
      };
    });
    check(
      'Escape closes the drawer and restores focus to the trigger',
      afterEscape.state === 'closed' && afterEscape.restored,
      JSON.stringify(afterEscape),
    );

    await gotoAdmin(page, '/admin/profile');
    const mobileSettingsOverflow = await overflowOf(page);
    check(
      'no horizontal overflow on settings at 390px',
      mobileSettingsOverflow <= 1,
      `overflow=${mobileSettingsOverflow}px`,
    );
    await page.screenshot({ path: `${OUT}/07-mobile-settings.png`, fullPage: true });

    // Tablet, the third breakpoint the layout switches at.
    await page.setViewport({ width: 768, height: 1024 });
    await gotoAdmin(page, '/admin');
    const tabletOverflow = await overflowOf(page);
    check(
      'no horizontal overflow on the dashboard at 768px',
      tabletOverflow <= 1,
      `overflow=${tabletOverflow}px`,
    );
    await page.screenshot({ path: `${OUT}/08-tablet-dashboard.png`, fullPage: true });
    await page.setViewport({ width: 1440, height: 900 });


    /* --------------------- isolation between two real accounts --------------------- */

    // Re-apply a distinctive appearance, then sign out and in as a DIFFERENT account.
    // The second account must never see the first one's appearance, not even for one
    // frame from the pre-paint cache.
    await gotoAdmin(page, '/admin/profile');
    await setInput(page, '[data-testid="appearance-theme"]', 'DARK');
    await setInput(page, '[data-testid="appearance-density"]', 'COMPACT');
    await setInput(page, '[data-testid="appearance-text-scale"]', '140');
    await sleep(1200);
    const ownerBeforeSwitch = (await readAppearance(page)).owner;

    await signOut(page);
    const afterSignOut = await readAppearance(page);
    check(
      'signing out drops the previous account appearance',
      afterSignOut.theme !== 'dark' && afterSignOut.owner === null,
      JSON.stringify({ theme: afterSignOut.theme, owner: afterSignOut.owner }),
    );

    const secondSignedIn = await signIn(page, SECOND_EMAIL, SECOND_PASSWORD);
    check('signed in as the second account', secondSignedIn, page.url());

    await gotoAdmin(page, '/admin', SECOND_EMAIL, SECOND_PASSWORD);
    const secondAppearance = await readAppearance(page);
    check(
      'the second account gets defaults, not the first account appearance',
      secondAppearance.density === 'comfortable' &&
        secondAppearance.textScale === '100' &&
        secondAppearance.motion === 'system',
      JSON.stringify(secondAppearance),
    );
    check(
      'the appearance cache is re-attributed to the new account',
      Boolean(secondAppearance.owner) && secondAppearance.owner !== ownerBeforeSwitch,
      `before=${ownerBeforeSwitch} after=${secondAppearance.owner}`,
    );

    const secondFavorites = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll('[data-testid="core-sidebar"] [data-testid="core-nav-group"]'),
      ).map((n) => n.getAttribute('data-group-id')),
    );
    check(
      'the second account has no favourites pinned',
      !secondFavorites.includes('favorites'),
      JSON.stringify(secondFavorites),
    );
    await page.screenshot({ path: `${OUT}/09-second-account-defaults.png` });

    /* ------------------- RBAC filtering of a stored favourite ------------------- */

    // A favourite the account may no longer open must disappear from the read, not 500 and
    // not render a row that leads to a permission error. Planted directly in the row the
    // second account owns, because the UI cannot pin what the rail never shows.
    const secondId = await psql(
      `select id from "User" where email = '${SECOND_EMAIL}';`,
    );
    const targetId = secondId.out.split('\n')[0].trim();
    const planted = await psql(
      `insert into "UserPreference" ("id", "userId", "navFavorites", "createdAt", "updatedAt")
       values (gen_random_uuid(), '${targetId}', ARRAY['${FORBIDDEN_FAVORITE}'], now(), now())
       on conflict ("userId")
       do update set "navFavorites" = ARRAY['${FORBIDDEN_FAVORITE}'], "updatedAt" = now()
       returning "userId";`,
    );

    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(6000);
    const forbidden = await page.evaluate(() => ({
      groups: Array.from(
        document.querySelectorAll('[data-testid="core-sidebar"] [data-testid="core-nav-group"]'),
      ).map((n) => n.getAttribute('data-group-id')),
      entries: document.querySelectorAll('[data-testid="favorite-entry"]').length,
      shellAlive: Boolean(document.querySelector('[data-testid="core-mobile-drawer"]')),
    }));
    check(
      'a favourite the account lacks permission for is filtered out of the read',
      planted.ok && forbidden.shellAlive && !forbidden.groups.includes('favorites'),
      `planted=${planted.ok} ${JSON.stringify(forbidden)}`,
    );


    /* ------------------------------ console hygiene ------------------------------ */

    // Hydration mismatches are the specific risk of a pre-paint script that writes to
    // `<html>` before React renders, so a clean console is part of the feature working.
    const errors = consoleMessages.filter(
      (m) =>
        (m.startsWith('error:') || m.startsWith('pageerror:')) &&
        // Not our concern: dev-server noise and expected 401s on the pre-login page.
        !m.includes('Failed to load resource') &&
        !m.includes('401') &&
        !m.includes('favicon'),
    );
    check(
      'no page errors or console errors during the run',
      errors.length === 0,
      errors.slice(0, 4).join(' :: ') || 'clean',
    );

    const hydration = consoleMessages.filter(
      (m) => m.toLowerCase().includes('hydrat') || m.includes('did not match'),
    );
    check(
      'no hydration mismatch from the pre-paint appearance script',
      hydration.length === 0,
      hydration.slice(0, 3).join(' :: ') || 'clean',
    );
  } catch (error) {
    check('harness ran to completion', false, String(error && error.message ? error.message : error));
    try {
      await page.screenshot({ path: `${OUT}/99-failure.png`, fullPage: true });
    } catch {
      /* a screenshot of a dead page is not worth failing over */
    }
  } finally {
    await browser.close();
  }

  /* ------------------------------- restore state ------------------------------- */

  // The planted favourite is test data, not a user choice: remove it either way.
  const cleaned = await psql(
    `update "UserPreference" set "navFavorites" = '{}'
       where "userId" in (select id from "User" where email = '${SECOND_EMAIL}');`,
  );

  // Put the admin row back to the values captured before the run, so a validated
  // environment is not left carrying the harness's dark/compact/140 settings.
  let restored = { ok: false, out: 'not attempted' };
  const snapshot = before.out.split('\n')[0].trim();
  if (snapshot) {
    const [theme, density, textScale, motion, collapsed, favorites] = snapshot.split('|');
    // `before` builds the snapshot by concatenating the boolean into text, so psql renders it
    // as `true`/`false`, not the `t`/`f` a bare boolean column returns. Accept both, or a
    // pre-run collapsed rail would be silently restored as expanded.
    const wasCollapsed = collapsed === 't' || collapsed === 'true';
    const favoriteArray = favorites
      ? `ARRAY[${favorites
          .split(',')
          .filter(Boolean)
          .map((href) => `'${href}'`)
          .join(',')}]::text[]`
      : `'{}'::text[]`;
    restored = await psql(
      `update "UserPreference"
          set theme = '${theme}', density = '${density}', "textScale" = ${Number(textScale)},
              motion = '${motion}', "sidebarCollapsed" = ${wasCollapsed},
              "navFavorites" = ${favoriteArray}, "updatedAt" = now()
        where "userId" = '${ADMIN_ID}'
        returning theme || '|' || density || '|' || "textScale" || '|' || motion;`,
    );
  } else {
    // No row before the run means the account had never customised anything; the honest
    // restore is to delete the row the harness caused to be created.
    restored = await psql(`delete from "UserPreference" where "userId" = '${ADMIN_ID}';`);
  }
  check(
    'admin preferences restored to their pre-run state',
    restored.ok,
    `${restored.out || restored.err || 'ok'}${cleaned.ok ? '' : ' (favourite cleanup failed)'}`,
  );

  /* ---------------------------------- summary ---------------------------------- */

  const failed = results.filter((r) => !r.ok);
  console.log('\n================ PHASE 49K VALIDATION ================');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log('------------------------------------------------------');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  console.log(`screenshots: ${OUT}/`);
  if (failed.length) {
    console.log('\nfailures:');
    for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
  }
  console.log('======================================================');

  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('harness crashed:', error);
  process.exit(1);
});

