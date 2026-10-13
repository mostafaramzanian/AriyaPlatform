// Phase 49I browser validation harness: the Jalali date chip, the Jalali date picker,
// the /admin/calendar surface, personal reminders, and exactly-once in-app notification
// delivery.
//
// Exercises the real stack rather than mocks: it logs in, compares the chip against the
// server's own `GET /calendar/today`, walks the picker, creates a reminder two minutes
// ahead in Asia/Tehran, waits for the RUNNING dispatcher's real 30s tick, and then
// asserts that exactly one Notification row exists for it — counted in the database, not
// inferred from the UI. Every row it creates is removed at the end.
//
// Targets web :3000 against API :3002 (the locally built API; the docker image is stale
// and predates the calendar module).
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BASE = 'http://localhost:3000';
const API = 'http://localhost:3002/api/v1';
const OUT = 'phase49i-shots';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

/** Title of the reminder this harness creates. Used for lookups and for teardown. */
const FIXTURE_TITLE = 'یادآوری اعتبارسنجی ۴۹آی';
/** Rows left behind by earlier validation attempts, removed at the end. */
const STALE_TITLES = ['جلسه اعتبارسنجی 49I'];

// The API validates reminder ids with ParseUUIDPipe({ version: '4' }), so the
// cross-user fixture must be a syntactically valid v4 UUID. A non-UUID id gets
// rejected with 400 before the ownership check runs, which would test nothing.
const FOREIGN_ID = '49100000-0000-4000-8000-000000000049';


const results = [];
const consoleMessages = [];
const failedRequests = [];
const calendarRequests = [];

// The authorization probes deliberately provoke 401s and 404s. Those are the
// assertion, not a defect, so console/network recording is suspended while they
// run — the browser logs a bare "Failed to load resource" with no URL attached,
// which cannot be filtered after the fact.
let probing = false;


let step = 0;
const check = (name, ok, detail = '') => {
  step += 1;
  results.push({ name: `${step}. ${name}`, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}. ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs SQL in the Core database. Used for delivery counting and for teardown. */
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

/** Asia/Tehran wall clock — the zone reminders are entered and stored against. */
function tehranClockPlus(minutes) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tehran',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const total = ((get('hour') % 24) * 60 + get('minute') + minutes) % 1440;

  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Sets a controlled input's value the way React observes it. */
async function setInput(page, selector, value) {
  await page.$eval(
    selector,
    (el, v) => {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    value,
  );
}

/**
 * Clicks one of a reminder row's action buttons.
 *
 * The row buttons are disabled while a mutation is in flight and can sit below the
 * fold, so a bare page.click() is unreliable: scroll it in, wait for it to be
 * enabled, then click and give React a beat to fire the request.
 */
async function clickReminderAction(page, reminderId, testId) {
  const selector = `[data-reminder-id="${reminderId}"] [data-testid="${testId}"]`;
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && !el.disabled;
    },
    { timeout: 15000 },
    selector,
  );
  await page.$eval(selector, (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await page.click(selector);
}

/** Reads the on-screen mutation error, if the surface is showing one. */
async function readActionError(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="reminder-action-error"]');
    return el ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) : null;
  });
}

/** Types credentials and submits; the form only reacts to real key events. */
async function submitLogin(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]');
  await sleep(7000); // hydration: the submit handler is client-side only
  await page.click('input[name="email"]', { clickCount: 3 });
  await page.type('input[name="email"]', EMAIL);
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await sleep(9000); // login round-trip (~2s) plus the client-side router.push
}

/**
 * Signs in, retrying because hydration timing makes a single submit flaky.
 * NOTE: never wait for networkidle on this app — the messaging WebSocket holds a
 * connection open, so networkidle2 never settles.
 */
async function signIn(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await submitLogin(page);
    if (!page.url().includes('/login')) return;
  }
}

/** Navigates inside /admin, tolerating one hydration miss. */
async function gotoAdmin(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await page.waitForSelector('[data-testid="core-date-chip"]', { timeout: 20000 });
      return;
    } catch {
      // A bounce back to /login means the session was not picked up yet; sign in
      // again rather than reloading a page that will keep redirecting.
      if (page.url().includes('/login')) {
        await signIn(page);
        await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      await sleep(4000);
    }
  }
  // Final attempt: surface where we actually ended up, which makes a redirect or
  // an error page obvious instead of reporting a bare selector timeout.
  try {
    await page.waitForSelector('[data-testid="core-date-chip"]', { timeout: 25000 });
  } catch (err) {
    const diag = await page
      .evaluate(() => ({
        url: location.href,
        token: Boolean(window.localStorage.getItem('aria_access_token')),
        body: document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 200),
      }))
      .catch(() => null);
    throw new Error(`${err.message} :: ${JSON.stringify(diag)}`);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Start from a clean slate. An earlier aborted run can leave a delivered-reminder
  // notification behind, and the notification-panel assertion counts matching items
  // by title — a stale row would make it see two.
  await purgeFixtures();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (!probing) consoleMessages.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (!probing) consoleMessages.push(`pageerror: ${e.message}`);
  });
  page.on('request', (r) => {
    if (r.url().includes('/calendar')) {
      calendarRequests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`.trim());
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && !probing) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  await page.setViewport({ width: 1440, height: 900 });

  await signIn(page);
  check('login succeeded', !page.url().includes('/login'), page.url());

  // ---- The sidebar chip ---------------------------------------------------
  await gotoAdmin(page, '/admin');
  await sleep(800);
  await page.screenshot({ path: `${OUT}/01-chip.png` });

  const chip = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="core-date-chip"]');
    const label = document.querySelector('[data-testid="core-date-chip-label"]');
    const box = el.getBoundingClientRect();
    return {
      date: el.getAttribute('data-date'),
      collapsed: el.getAttribute('data-collapsed'),
      ariaLabel: el.getAttribute('aria-label'),
      haspopup: el.getAttribute('aria-haspopup'),
      label: label?.textContent.trim() ?? null,
      height: Math.round(box.height),
      tag: el.tagName,
    };
  });
  check('the sidebar renders the date chip', !!chip.date, JSON.stringify(chip));

  // The chip must agree with the SERVER's today, not with the browser clock.
  const serverToday = await page.evaluate(async (api) => {
    const token = window.localStorage.getItem('aria_access_token');
    const res = await fetch(`${api}/calendar/today`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return body.data ?? body;
  }, API);
  check(
    'chip date equals the server-authoritative Jalali today',
    chip.date === serverToday.date,
    `chip=${chip.date} server=${serverToday.date}`,
  );

  const PERSIAN_DIGITS = /[\u06F0-\u06F9]/;
  check(
    'the chip label is Jalali, in Persian digits, with a Persian month name',
    !!chip.label && PERSIAN_DIGITS.test(chip.label) && !/[0-9]/.test(chip.label),
    `label=${chip.label}`,
  );
  check(
    'the accessible name carries the full date including the weekday',
    !!chip.ariaLabel && chip.ariaLabel.includes(serverToday.weekdayName),
    `aria-label=${chip.ariaLabel}`,
  );
  check(
    'the chip is a real button with a popup role and a 32px+ hit area',
    chip.tag === 'BUTTON' && chip.haspopup === 'dialog' && chip.height >= 32,
    JSON.stringify({ tag: chip.tag, haspopup: chip.haspopup, height: chip.height }),
  );

  // ---- The picker, opened from the chip -----------------------------------
  await page.click('[data-testid="core-date-chip"]');
  await page.waitForSelector('[data-testid="jalali-date-picker"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="jalali-day"]', { timeout: 15000 });
  await sleep(700);
  await page.screenshot({ path: `${OUT}/02-picker.png` });

  const picker = await page.evaluate(() => {
    const surface = document.querySelector('[data-testid="core-date-chip-surface"]');
    const days = [...document.querySelectorAll('[data-testid="jalali-day"]')];
    const today = days.find((d) => d.getAttribute('data-today') === 'true');
    return {
      role: surface?.getAttribute('role'),
      expanded: document
        .querySelector('[data-testid="core-date-chip"]')
        .getAttribute('aria-expanded'),
      dayCount: days.length,
      hasYear: !!document.querySelector('[data-testid="jalali-year-select"]'),
      hasMonth: !!document.querySelector('[data-testid="jalali-month-select"]'),
      hasToday: !!document.querySelector('[data-testid="jalali-today-button"]'),
      hasPrev: !!document.querySelector('[data-testid="jalali-prev-month"]'),
      hasNext: !!document.querySelector('[data-testid="jalali-next-month"]'),
      todayDate: today?.getAttribute('data-date') ?? null,
      tabbable: days.filter((d) => d.getAttribute('tabindex') === '0').length,
      gridLabel: document.querySelector('[role="grid"]')?.getAttribute('aria-label') ?? null,
      cells: document.querySelectorAll('[role="gridcell"]').length,
    };
  });
  check(
    'the picker opens as a dialog with year, month, prev/next and today controls',
    picker.role === 'dialog' &&
      picker.hasYear &&
      picker.hasMonth &&
      picker.hasToday &&
      picker.hasPrev &&
      picker.hasNext,
    JSON.stringify(picker),
  );
  check(
    'the grid is a real ARIA grid of gridcells',
    !!picker.gridLabel && picker.cells === picker.dayCount,
    `label=${picker.gridLabel} cells=${picker.cells} days=${picker.dayCount}`,
  );
  check(
    'the month grid holds a valid Jalali month length',
    picker.dayCount >= 29 && picker.dayCount <= 31,
    `days=${picker.dayCount}`,
  );
  check(
    'today is marked in the grid and matches the server',
    picker.todayDate === serverToday.date,
    `grid=${picker.todayDate} server=${serverToday.date}`,
  );
  check(
    'a roving tabindex exposes exactly one tabbable day',
    picker.tabbable === 1,
    `tabbable=${picker.tabbable}`,
  );
  check(
    'the chip reports its expanded state while open',
    picker.expanded === 'true',
    `aria-expanded=${picker.expanded}`,
  );

  // Year and month selectors must drive a server refetch of the month.
  const beforeYear = calendarRequests.length;
  const nextYear = await page.$eval('[data-testid="jalali-year-select"]', (el) => {
    const options = [...el.options].map((o) => o.value);
    return options.find((v) => v !== el.value) ?? el.value;
  });
  await setInput(page, '[data-testid="jalali-year-select"]', nextYear);
  await sleep(1800);
  const yearFetch = calendarRequests
    .slice(beforeYear)
    .filter((r) => r.includes('/calendar/month') && r.includes(`jy=${nextYear}`));
  check(
    'the year selector refetches that year from the server',
    yearFetch.length >= 1,
    yearFetch[0] ?? 'no /calendar/month?jy= request observed',
  );

  const beforeMonth = calendarRequests.length;
  const otherMonth = await page.$eval('[data-testid="jalali-month-select"]', (el) => {
    const options = [...el.options].map((o) => o.value);
    return options.find((v) => v !== el.value) ?? el.value;
  });
  await setInput(page, '[data-testid="jalali-month-select"]', otherMonth);
  await sleep(1800);
  const monthFetch = calendarRequests
    .slice(beforeMonth)
    .filter((r) => r.includes('/calendar/month') && r.includes(`jm=${otherMonth}`));
  const monthLen = await page.evaluate(
    () => document.querySelectorAll('[data-testid="jalali-day"]').length,
  );
  check(
    'the month selector refetches that month and its real length',
    monthFetch.length >= 1 && monthLen >= 29 && monthLen <= 31,
    `${monthFetch[0] ?? 'no request'} days=${monthLen}`,
  );

  // Keyboard: arrow keys move the roving focus; Escape closes and restores focus.
  await page.focus('[data-testid="jalali-day"][tabindex="0"]');
  const focusedBefore = await page.evaluate(
    () => document.activeElement?.getAttribute('data-date') ?? null,
  );
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  const afterArrow = await page.evaluate(() => ({
    testid: document.activeElement?.getAttribute('data-testid') ?? null,
    date: document.activeElement?.getAttribute('data-date') ?? null,
    tabbable: [...document.querySelectorAll('[data-testid="jalali-day"]')].filter(
      (d) => d.getAttribute('tabindex') === '0',
    ).length,
  }));
  check(
    'ArrowLeft moves the roving focus to another day and keeps one tabbable cell',
    afterArrow.testid === 'jalali-day' &&
      afterArrow.date !== focusedBefore &&
      afterArrow.tabbable === 1,
    `${focusedBefore} -> ${JSON.stringify(afterArrow)}`,
  );

  // Selecting a day from the chip must deep link into the calendar surface.
  await page.click('[data-testid="jalali-today-button"]');
  await sleep(3000);
  check(
    'the today button selects today and deep links into /admin/calendar',
    page.url().includes('/admin/calendar') &&
      decodeURIComponent(page.url()).includes(serverToday.date),
    page.url(),
  );

  // Escape closes the picker and returns focus to the chip.
  await gotoAdmin(page, '/admin');
  await page.click('[data-testid="core-date-chip"]');
  await page.waitForSelector('[data-testid="jalali-date-picker"]', { timeout: 10000 });
  await sleep(600);
  await page.keyboard.press('Escape');
  await sleep(500);
  const afterEscape = await page.evaluate(() => ({
    pickerGone: !document.querySelector('[data-testid="jalali-date-picker"]'),
    focusOnChip:
      document.activeElement?.getAttribute('data-testid') === 'core-date-chip',
    expanded: document
      .querySelector('[data-testid="core-date-chip"]')
      .getAttribute('aria-expanded'),
  }));
  check(
    'Escape closes the picker and returns focus to the chip',
    afterEscape.pickerGone && afterEscape.focusOnChip && afterEscape.expanded === 'false',
    JSON.stringify(afterEscape),
  );

  // ---- The calendar surface ------------------------------------------------
  await gotoAdmin(page, '/admin/calendar');
  await page.waitForSelector('[data-testid="selected-day"]', { timeout: 20000 });
  await page.waitForSelector('[data-testid="jalali-day"]', { timeout: 20000 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/03-calendar.png`, fullPage: true });

  const surface = await page.evaluate(() => ({
    heading: document.querySelector('[data-testid="selected-day"]')?.textContent.trim() ?? null,
    days: document.querySelectorAll('[data-testid="jalali-day"]').length,
    hasCreate: !!document.querySelector('[data-testid="reminder-create-toggle"]'),
    hasUpcoming: [...document.querySelectorAll('h2')].some((h) =>
      h.textContent.includes('پیش رو'),
    ),
    todayInGrid:
      document
        .querySelector('[data-testid="jalali-day"][data-today="true"]')
        ?.getAttribute('data-date') ?? null,
  }));
  check(
    '/admin/calendar renders the month grid, the selected day and the create control',
    surface.days >= 29 && !!surface.heading && surface.hasCreate,
    JSON.stringify(surface),
  );
  check(
    'the surface exposes a bounded upcoming region',
    surface.hasUpcoming,
    `upcoming=${surface.hasUpcoming}`,
  );

  // Month navigation on the surface is server-driven too.
  const beforeNav = calendarRequests.length;
  await page.click('[data-testid="jalali-next-month"]');
  await sleep(2000);
  const navFetch = calendarRequests
    .slice(beforeNav)
    .filter((r) => r.includes('/calendar/month'));
  check(
    'month navigation on the surface refetches the month from the server',
    navFetch.length >= 1,
    navFetch[0] ?? 'no /calendar/month request observed',
  );

  await page.click('[data-testid="jalali-today-button"]');
  await sleep(2500);
  const backToToday = await page
    .$eval('[data-testid="jalali-day"][data-today="true"]', (el) => el.getAttribute('data-date'))
    .catch(() => null);
  check(
    'the today button returns the surface grid to the current month',
    backToToday === serverToday.date,
    `grid=${backToToday} server=${serverToday.date}`,
  );

  // ---- Create → persist → reload ------------------------------------------
  // Two minutes ahead on the Tehran wall clock, so the RUNNING dispatcher's real 30s
  // tick can pick it up inside this run without racing the create.
  const dueClock = tehranClockPlus(2);

  await page.click('[data-testid="reminder-create-toggle"]');
  await page.waitForSelector('[data-testid="reminder-form"]', { timeout: 10000 });
  await sleep(600);

  const formDate = await page.$eval('[data-testid="reminder-form-date"]', (el) =>
    el.getAttribute('data-date'),
  );
  check(
    'the form pins the date to the selected day rather than letting the client retype it',
    formDate === serverToday.date,
    `form=${formDate} selected=${serverToday.date}`,
  );

  await setInput(page, '[data-testid="reminder-title-input"]', FIXTURE_TITLE);
  await setInput(page, '[data-testid="reminder-time-input"]', dueClock);
  await setInput(page, '[data-testid="reminder-note-input"]', 'ایجادشده توسط اعتبارسنجی فاز ۴۹آی');
  await sleep(400);
  await page.screenshot({ path: `${OUT}/04-form.png` });

  const createBefore = calendarRequests.length;
  await page.click('[data-testid="reminder-submit"]');
  await page.waitForSelector('[data-testid="reminder-notice"]', { timeout: 15000 });
  await sleep(1800);
  await page.screenshot({ path: `${OUT}/05-created.png` });

  const createPosts = calendarRequests
    .slice(createBefore)
    .filter((r) => r.startsWith('POST') && r.includes('/calendar/reminders'));
  check(
    'creating a reminder issues exactly one POST /calendar/reminders',
    createPosts.length === 1,
    `posts=${createPosts.length}`,
  );

  // The write payload must not carry identity: the server derives it from the token.
  const payload = createPosts[0]?.slice(createPosts[0].indexOf('{')) ?? '';
  check(
    'the create payload carries no client-supplied userId or tenantId',
    !!payload && !/["']?(userId|tenantId)["']?\s*:/.test(payload),
    payload || 'no payload captured',
  );

  const created = await page.evaluate((title) => {
    const items = [...document.querySelectorAll('[data-testid="reminder-item"]')];
    const mine = items.filter((el) => el.textContent.includes(title));
    return {
      total: items.length,
      mine: mine.length,
      id: mine[0]?.getAttribute('data-reminder-id') ?? null,
      time: mine[0]?.querySelector('[data-testid="reminder-time"]')?.textContent.trim() ?? null,
      enabled: mine[0]?.getAttribute('data-enabled') ?? null,
      delivered: mine[0]?.getAttribute('data-delivered') ?? null,
    };
  }, FIXTURE_TITLE);
  check(
    'the new reminder appears in the selected day list',
    created.mine === 1 && !!created.id,
    JSON.stringify(created),
  );

  const reminderId = created.id;

  check(
    'its time renders in Persian digits, not Latin ones',
    !!created.time && /[\u06F0-\u06F9]/.test(created.time) && !/[0-9]/.test(created.time),
    `time=${created.time}`,
  );

  const dbRow = await psql(
    `SELECT "userId" || '|' || enabled || '|' || ("deliveredAt" IS NULL) || '|' || to_char("dueAt", 'YYYY-MM-DD HH24:MI') FROM "Reminder" WHERE id = '${reminderId}';`,
  );
  check(
    'the reminder is persisted server-side and owned by the caller',
    dbRow.ok && dbRow.out.startsWith('super-admin-user|'),
    dbRow.out || dbRow.err,
  );

  // Reload must re-read it from the server rather than from client state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(3500);
  await page.waitForSelector('[data-testid="reminder-item"]', { timeout: 20000 });
  const survived = await page.evaluate(
    (id) => !!document.querySelector(`[data-reminder-id="${id}"]`),
    reminderId,
  );
  check('the reminder survives a full reload', survived, `id=${reminderId}`);

  // ---- Exactly-once delivery ----------------------------------------------
  // Counted in the database, so the assertion is about rows rather than about whatever
  // the UI happens to render. Polls for up to ~5 minutes: the dispatcher ticks every 30s
  // and the fixture is due two minutes out.
  let deliveredRows = -1;
  let notifRows = -1;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const res = await psql(
      `SELECT (SELECT count(*) FROM "Reminder" WHERE id = '${reminderId}' AND "deliveredAt" IS NOT NULL) || '|' || (SELECT count(*) FROM "Notification" WHERE "sourceType" = 'calendar.reminder' AND "sourceId" = '${reminderId}');`,
    );
    const [d, n] = res.out.split('|').map(Number);
    deliveredRows = d;
    notifRows = n;
    if (d === 1 && n === 1) break;
    await sleep(10000);
  }
  check(
    'the dispatcher claimed the reminder exactly once',
    deliveredRows === 1,
    `deliveredAt set on ${deliveredRows} row(s)`,
  );
  check(
    'exactly one notification was created for it',
    notifRows === 1,
    `notifications=${notifRows}`,
  );

  // Two further ticks must not re-deliver: this is the exactly-once assertion.
  await sleep(70000);
  const afterTicks = await psql(
    `SELECT count(*) FROM "Notification" WHERE "sourceType" = 'calendar.reminder' AND "sourceId" = '${reminderId}';`,
  );
  check(
    'later ticks do not re-deliver: still exactly one notification',
    Number(afterTicks.out) === 1,
    `notifications=${afterTicks.out}`,
  );

  // The bell must surface it, and the row must show as delivered.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await page.waitForSelector('[data-testid="notification-bell"]', { timeout: 20000 });
  await page.click('[data-testid="notification-bell"]');
  await page.waitForSelector('[data-testid="notification-panel"]', { timeout: 10000 });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/06-notification.png` });

  const bell = await page.evaluate((title) => {
    const items = [...document.querySelectorAll('[data-testid="notification-item"]')];
    return {
      total: items.length,
      matching: items.filter((el) => el.textContent.includes(title)).length,
      firstText: items[0]?.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) ?? null,
    };
  }, FIXTURE_TITLE);
  check(
    'the delivered reminder appears exactly once in the notification panel',
    bell.matching === 1,
    JSON.stringify(bell),
  );

  await page.keyboard.press('Escape');
  await sleep(600);

  const deliveredLabel = await page.evaluate((id) => {
    const row = document.querySelector(`[data-reminder-id="${id}"]`);
    return {
      delivered: row?.getAttribute('data-delivered') ?? null,
      hasLabel: !!row?.querySelector('[data-testid="reminder-delivered-label"]'),
    };
  }, reminderId);
  check(
    'the reminder row reports itself as delivered instead of vanishing',
    deliveredLabel.delivered === 'true' && deliveredLabel.hasLabel,
    JSON.stringify(deliveredLabel),
  );

  // ---- Edit, disable, delete ----------------------------------------------
  const editBefore = calendarRequests.length;
  await clickReminderAction(page, reminderId, 'reminder-toggle');
  await sleep(3000);
  const patches = calendarRequests
    .slice(editBefore)
    .filter((r) => r.startsWith('PATCH') && r.includes(`/calendar/reminders/${reminderId}`));
  const disabledState = await page.evaluate((id) => {
    const row = document.querySelector(`[data-reminder-id="${id}"]`);
    return {
      enabled: row?.getAttribute('data-enabled') ?? null,
      hasLabel: !!row?.querySelector('[data-testid="reminder-disabled-label"]'),
    };
  }, reminderId);
  check(
    'disabling a reminder issues one PATCH and marks the row disabled',
    patches.length === 1 && disabledState.enabled === 'false' && disabledState.hasLabel,
    `${patches.length} patch(es) ${JSON.stringify(disabledState)} err=${await readActionError(page)}`,
  );

  const dbDisabled = await psql(`SELECT enabled FROM "Reminder" WHERE id = '${reminderId}';`);
  check('the disable is persisted server-side', dbDisabled.out === 'f', `enabled=${dbDisabled.out}`);

  // Re-enabling must not resurrect delivery: the claim stands.
  await clickReminderAction(page, reminderId, 'reminder-toggle');
  await sleep(3000);
  const reenabled = await psql(
    `SELECT enabled::int || '|' || ("deliveredAt" IS NOT NULL)::int || '|' || (SELECT count(*) FROM "Notification" WHERE "sourceType" = 'calendar.reminder' AND "sourceId" = '${reminderId}') FROM "Reminder" WHERE id = '${reminderId}';`,
  );
  check(
    're-enabling an already-delivered reminder does not re-notify',
    reenabled.out === '1|1|1',
    `enabled|delivered|notifications = ${reenabled.out}`,
  );

  const deleteBefore = calendarRequests.length;
  await clickReminderAction(page, reminderId, 'reminder-delete');
  await sleep(3000);
  const deletes = calendarRequests
    .slice(deleteBefore)
    .filter((r) => r.startsWith('DELETE') && r.includes(`/calendar/reminders/${reminderId}`));
  const goneFromDom = await page.evaluate(
    (id) => !document.querySelector(`[data-reminder-id="${id}"]`),
    reminderId,
  );
  const goneFromDb = await psql(`SELECT count(*) FROM "Reminder" WHERE id = '${reminderId}';`);
  check(
    'deleting a reminder issues one DELETE and removes it from the list and the database',
    deletes.length === 1 && goneFromDom && goneFromDb.out === '0',
    `${deletes.length} delete(s) dom_gone=${goneFromDom} rows=${goneFromDb.out} err=${await readActionError(page)}`,
  );
  await page.screenshot({ path: `${OUT}/07-after-delete.png`, fullPage: true });

  // ---- Authorization ------------------------------------------------------
  // Everything below deliberately provokes 401/404 responses, so stop recording
  // console errors and failed requests until the probes are done.
  probing = true;
  const unauth = await page.evaluate(async (api) => {
    const paths = ['/calendar/today', '/calendar/month?jy=1405&jm=8', '/calendar/reminders'];
    const out = [];
    for (const p of paths) {
      const res = await fetch(`${api}${p}`);
      out.push(`${p}=${res.status}`);
    }
    const post = await fetch(`${api}/calendar/reminders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'unauthorized', date: '1405/08/18', time: '10:00' }),
    });
    out.push(`POST=${post.status}`);
    return out;
  }, API);
  check(
    'every calendar endpoint rejects an unauthenticated caller',
    unauth.every((r) => r.endsWith('=401')),
    unauth.join(' '),
  );

  // A reminder belonging to somebody else must be invisible to this caller.
  const foreign = await psql(
    `INSERT INTO "Reminder" (id, "userId", title, "dueAt", "allDay", enabled, "createdAt", "updatedAt") SELECT '${FOREIGN_ID}', id, 'مال کاربر دیگر', now() + interval '10 years', false, true, now(), now() FROM "User" WHERE id <> 'super-admin-user' LIMIT 1 ON CONFLICT (id) DO NOTHING; SELECT count(*) FROM "Reminder" WHERE id = '${FOREIGN_ID}';`,
  );

  if (foreign.ok && foreign.out.trim().endsWith('1')) {
    const crossUser = await page.evaluate(
      async (api, foreignId) => {
        const token = window.localStorage.getItem('aria_access_token');
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const patch = await fetch(`${api}/calendar/reminders/${foreignId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ enabled: false }),
        });
        const del = await fetch(`${api}/calendar/reminders/${foreignId}`, {
          method: 'DELETE',
          headers,
        });
        return { patch: patch.status, delete: del.status };
      },
      API,
      FOREIGN_ID,
    );
    const survivedForeign = await psql(
      `SELECT count(*) || '|' || bool_and(enabled)::int FROM "Reminder" WHERE id = '${FOREIGN_ID}';`,
    );
    check(
      "another user's reminder cannot be edited or deleted",
      crossUser.patch === 404 && crossUser.delete === 404 && survivedForeign.out === '1|1',
      `${JSON.stringify(crossUser)} row=${survivedForeign.out}`,
    );
  } else {
    check(
      "another user's reminder cannot be edited or deleted",
      false,
      `SKIPPED / no second user available to own the fixture: ${foreign.err || foreign.out}`,
    );
  }

  // A malformed id must be rejected by validation, not treated as a lookup miss.
  const malformed = await page.evaluate(async (api) => {
    const token = window.localStorage.getItem('aria_access_token');
    const res = await fetch(`${api}/calendar/reminders/not-a-uuid`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.status;
  }, API);
  check(
    'a malformed reminder id is rejected as a bad request',
    malformed === 400,
    `status=${malformed}`,
  );

  probing = false;

  // Identity must never travel in a query string either.
  const leaky = calendarRequests.filter((r) => /[?&](userId|tenantId)=/i.test(r));
  check(
    'no calendar request carries a userId or tenantId',
    leaky.length === 0,
    leaky.slice(0, 3).join(' || ') || 'none',
  );

  // ---- Dark mode ----------------------------------------------------------
  await gotoAdmin(page, '/admin/calendar');
  await page.waitForSelector('[data-testid="jalali-day"]', { timeout: 20000 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await sleep(1000);
  await page.screenshot({ path: `${OUT}/08-dark.png`, fullPage: true });
  const dark = await page.evaluate(() => {
    const bg = getComputedStyle(document.body).backgroundColor;
    const chip = document.querySelector('[data-testid="core-date-chip"]');
    const day = document.querySelector('[data-testid="jalali-day"]');
    return {
      bg,
      chipFg: chip ? getComputedStyle(chip).color : null,
      dayFg: day ? getComputedStyle(day).color : null,
    };
  });
  check(
    'dark mode keeps the chip and the grid legible against the background',
    !!dark.chipFg && dark.chipFg !== dark.bg && !!dark.dayFg && dark.dayFg !== dark.bg,
    JSON.stringify(dark),
  );
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await sleep(400);

  // ---- Mobile 390x844 -----------------------------------------------------
  await page.setViewport({ width: 390, height: 844 });
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/09-mobile.png`, fullPage: true });
  const mobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  check(
    'the calendar surface has no horizontal overflow at 390x844',
    !mobile.overflow,
    JSON.stringify(mobile),
  );

  // The picker must fit inside that viewport too. Below `lg` the rail is hidden and
  // the chip only exists inside the mobile drawer, so the drawer has to be opened
  // first — clicking the hidden copy measures a zero-sized, invisible surface.
  await page.click('button[aria-label="نمایش منو"]');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="core-mobile-drawer"]')?.getAttribute('data-state') ===
      'open',
    { timeout: 10000 },
  );
  await sleep(900);
  const drawerChip = await page.$(
    '[data-testid="core-sidebar-drawer"] [data-testid="core-date-chip"]',
  );
  if (drawerChip) {
    await drawerChip.click();
    await page.waitForSelector(
      '[data-testid="core-sidebar-drawer"] [data-testid="jalali-date-picker"]',
      { timeout: 10000 },
    );
    await sleep(1200);
    const pickerMobile = await page.evaluate(() => {
      // Two chips exist in the DOM (hidden desktop rail + drawer), so the surface has
      // to be resolved inside the drawer rather than document-wide.
      const drawer = document.querySelector('[data-testid="core-sidebar-drawer"]');
      const el = drawer?.querySelector('[data-testid="jalali-date-picker"]');
      const surface = drawer?.querySelector('[data-testid="core-date-chip-surface"]');
      if (!el || !surface) return { present: false };
      const box = el.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      return {
        present: true,
        variant: surface.getAttribute('data-variant'),
        width: Math.round(box.width),
        left: Math.round(box.left),
        surfaceWidth: Math.round(surfaceBox.width),
        visible: box.width > 0 && box.height > 0,
        fits:
          box.left >= -1 &&
          box.right <= window.innerWidth + 1 &&
          surfaceBox.left >= -1 &&
          surfaceBox.right <= window.innerWidth + 1,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    check(
      'the picker fits inside a 390px viewport without overflow',
      pickerMobile.present &&
        pickerMobile.visible &&
        pickerMobile.fits &&
        !pickerMobile.overflow &&
        pickerMobile.variant === 'drawer',
      JSON.stringify(pickerMobile),
    );
    await page.screenshot({ path: `${OUT}/10-mobile-picker.png` });
    await page.keyboard.press('Escape');
    await sleep(400);
    await page.keyboard.press('Escape');
  } else {
    check(
      'the picker fits inside a 390px viewport without overflow',
      false,
      'the chip is not reachable inside the mobile drawer at 390px',
    );
  }
  await page.setViewport({ width: 1440, height: 900 });
  await sleep(500);

  // ---- Console and network hygiene ----------------------------------------
  const errors = consoleMessages.filter(
    (m) =>
      (m.startsWith('error:') || m.startsWith('pageerror:')) &&
      !m.includes('favicon') &&
      !m.includes('Download the React DevTools'),
  );
  check(
    'the run produced no console errors',
    errors.length === 0,
    errors.slice(0, 4).join(' || ') || 'none',
  );
  const unexpectedFailures = failedRequests.filter(
    (r) => !r.includes('favicon') && !r.startsWith('401'),
  );
  check(
    'no unexpected failed requests (401s from the authorization probes excluded)',
    unexpectedFailures.length === 0,
    unexpectedFailures.slice(0, 4).join(' || ') || 'none',
  );

  await browser.close();
}

/**
 * Deletes every row this harness (or an earlier attempt) created.
 *
 * Notifications are matched on their body text as well as through "Reminder": the
 * delete assertion removes its own reminder row mid-run, which orphans the
 * notification, so a purely `sourceId`-based join silently missed it. The surviving
 * orphan then made the notification-panel assertion count two matching items on the
 * next run.
 */
function fixtureTitles() {
  return [FIXTURE_TITLE, ...STALE_TITLES];
}

async function purgeFixtures() {
  const titles = fixtureTitles().map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  const bodyMatch = fixtureTitles()
    .map((t) => `n.body LIKE '%${t.replace(/'/g, "''")}%'`)
    .join(' OR ');
  const orphanPredicate = `n."sourceType" = 'calendar.reminder' AND (n."sourceId" = '${FOREIGN_ID}' OR ${bodyMatch})`;

  return psql(
    `DELETE FROM "Notification" AS n
     WHERE ${orphanPredicate}
        OR (n."sourceType" = 'calendar.reminder'
            AND n."sourceId" IN (SELECT id FROM "Reminder" WHERE title IN (${titles})));
     DELETE FROM "Reminder" WHERE title IN (${titles}) OR id = '${FOREIGN_ID}';
     SELECT (SELECT count(*) FROM "Reminder" WHERE title IN (${titles}) OR id = '${FOREIGN_ID}')
            || '|'
            || (SELECT count(*) FROM "Notification" AS n WHERE ${orphanPredicate});`,
  );
}

/** Removes every row this harness (or an earlier attempt) created. */
async function teardown() {
  const res = await purgeFixtures();
  const leftovers = res.out.split('\n').pop()?.trim() ?? '';
  check(
    'teardown removed every fixture row this harness created',
    res.ok && leftovers === '0|0',
    res.ok ? `remaining reminders|notifications = ${leftovers}` : res.err,
  );
}

function summarize() {
  const failed = results.filter((r) => !r.ok);
  console.log('\n================ PHASE 49I VALIDATION SUMMARY ================');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail ? ` :: ${r.detail}` : ''}`);
  }
  console.log('-------------------------------------------------------------');
  console.log(`total=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
  console.log('holidays: DEFERRED / SOURCE REQUIRED — no authoritative dataset available.');
  console.log('=============================================================');
  return failed.length;
}

let fatal = null;
try {
  await main();
} catch (error) {
  fatal = error;
  check('the harness ran to completion', false, `${error?.stack ?? error}`);
}

// Teardown runs even after a fatal error, so a failed run leaves no rows behind.
try {
  await teardown();
} catch (error) {
  check('teardown removed every fixture row this harness created', false, `${error?.message ?? error}`);
}

const failures = summarize();
if (fatal) console.error(fatal);
process.exit(failures > 0 ? 1 : 0);


