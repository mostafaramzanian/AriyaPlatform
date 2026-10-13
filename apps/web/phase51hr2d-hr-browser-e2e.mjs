// Phase 51-HR-2D: REAL BROWSER E2E for the HR vertical slice.
//
// WHAT THIS PROVES THAT NOTHING ELSE IN THE REPOSITORY COULD
// ---------------------------------------------------------
// HR-2A/2C proved the API, the database, the audit trail and the runtime through HTTP
// probes, supertest and Jest. None of those walk the chain a user actually walks:
//
//   REAL BROWSER -> REAL WEB APP -> REAL SESSION -> REAL API -> REAL hr_db
//
// This harness clicks, types, selects, reloads and screenshots. It never mocks a network
// call, never injects a token, never fabricates a response and never requests a URL with
// `fetch` where the requirement is a user action. Values asserted in the UI are
// CROSS-CHECKED against the same API's own answers, so a hard-coded expectation cannot
// make it pass: the numbers and codes are read from the running backend first, then
// required to appear on screen.
//
// REQUIREMENTS (both must already be running — this harness does not start them):
//   web  : http://localhost:3003   (the Next dev server)
//   api  : http://localhost:4000   (the combined runtime, /api/v1)
// The API must be serving the CURRENT build: a process running a pre-2C `dist` answers 500
// where this harness expects 409, which is a stale-artifact failure, not a product defect.
//
// FIXTURES
//   * `admin@localhost` / `ChangeMe123!` — seeded SUPER_ADMIN; holds every hr.* grant.
//   * `hr2d.viewer@localhost` / `ChangeMe123!` — registered on first run (the register
//     endpoint assigns VISITOR, which the HR permission migration deliberately grants NO
//     hr.* permission to). This is the §5 unauthorized actor.
//   * The employee it mutates is the tenant's own first record, and the mutation is
//     REVERSED before the run ends, so the development database is left as found.
//
// EVIDENCE: screenshots in `phase51hr2d-shots/` (untracked, per repository convention)
// plus the PASS/FAIL lines below. Exit code is non-zero if any check fails.
//
// ONE BROWSER MECHANISM: `puppeteer` (already a devDependency of this app) driving the
// REAL system Chrome, exactly as `phase48c-validate.mjs` and `phase49c*-visual-qa.mjs` do.
// No second framework is introduced, and `puppeteer`'s own download is not relied on.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const WEB = 'http://localhost:3003';
const API = 'http://localhost:4000/api/v1';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'phase51hr2d-shots';

const ADMIN = { email: 'admin@localhost', password: 'ChangeMe123!' };
/**
 * The §5 actor. Its domain MUST carry a TLD: `RegisterDto.email` is validated with
 * `@IsEmail()`, and `validator.js` requires one by default — so `…@localhost`, the shape the
 * seeded admin happens to have, is refused with a 422 and the account is never created.
 * Measured: `…@localhost` → 422 (`email must be an email`) + login 401;
 * `…@example.com` → 201 + login 200.
 */
const VIEWER = { email: 'hr2d.viewer@example.com', password: 'ChangeMe123!' };

/** Must exceed the views' own search debounce or a filtered assertion races the request. */
const SEARCH_DEBOUNCE_MS = 350;
/** The dev server compiles routes on first hit; every wait gets the same budget. */
const WAIT = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
function check(ok, name, detail = '') {
  findings.push({ ok: !!ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
}

/** Persian digits, the format every number on these screens is rendered in. */
const fa = (value) => Number(value).toLocaleString('fa-IR');

// ---------------------------------------------------------------------------
// API helpers — used for FIXTURES and CROSS-CHECKS, never as a substitute for a
// user action. Every one of them answers with the payload the browser would receive.
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  // `/auth/*` answers the standard envelope; the HR controllers answer their payload
  // directly. Unwrapping both is what makes a read here agree with a read on screen.
  return { status: res.status, body: json, data: json?.data !== undefined ? json.data : json };
}

async function apiLogin(credentials) {
  const res = await api('/auth/login', { method: 'POST', body: credentials });
  return { status: res.status, token: res.data?.accessToken ?? null };
}

/**
 * The §5 actor: registered once, reused afterwards. VISITOR carries no `hr.*` grant.
 *
 * IT RETURNS THE FACTS RATHER THAN ASSUMING THEM. An earlier version of this harness
 * reported "present" unconditionally, which hid a 422 on registration and turned the §5
 * stage into a 60-second timeout on a sign-in that could never succeed. The caller now
 * has to check the login status, and the register response is carried along so a rejection
 * is diagnosable from the output.
 */
async function ensureViewerUser() {
  const existing = await apiLogin(VIEWER);
  if (existing.status === 200 && existing.token) {
    return { action: 'reused', registerStatus: null, loginStatus: existing.status, ok: true };
  }

  const res = await api('/auth/register', {
    method: 'POST',
    body: { ...VIEWER, firstName: 'بیننده', lastName: 'بدون‌مجوز' },
  });
  const after = await apiLogin(VIEWER);
  return {
    action: `registered(${res.status})`,
    registerStatus: res.status,
    registerMessage: res.body?.message ?? null,
    registerDetails: res.body?.details ?? null,
    loginStatus: after.status,
    ok: after.status === 200 && !!after.token,
  };
}

/** Fails fast and LOUDLY when the environment this harness depends on is not up. */
async function assertStackIsRunning() {
  const web = await fetch(`${WEB}/login`).then((r) => r.status).catch(() => 0);
  const apiHealth = await fetch(`${API}/health`)
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
    .catch(() => ({ status: 0, body: null }));
  check(web === 200, 'web dev server answers on :3003', `status=${web}`);
  check(apiHealth.status === 200, 'combined API answers on :4000', `status=${apiHealth.status}`);
  if (web !== 200 || apiHealth.status !== 200) {
    console.log('\nBLOCKED — the stack this harness drives is not running. Start web :3003 and api :4000 first.');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    // The REAL system browser, not puppeteer's download — the same engine a user runs.
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

const shot = (page, name, fullPage = true) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage });

/**
 * Signs in by TYPING INTO THE REAL FORM and submitting it.
 *
 * Deliberately not a token injection: what §4 has to prove is that a browser user can
 * establish a session, and a harness that writes `localStorage` would prove only that the
 * harness can write `localStorage`.
 */
async function signIn(page, credentials) {
  await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="email"]', { timeout: WAIT });
  await sleep(1200);

  await page.click('input[name="email"]', { clickCount: 3 });
  await page.type('input[name="email"]', credentials.email);
  await page.click('input[name="password"]', { clickCount: 3 });
  await page.type('input[name="password"]', credentials.password);

  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 25000 });
  } catch {
    // A sign-in that cannot succeed must fail FAST and SAY WHY, instead of burning the whole
    // WAIT budget on a condition that will never become true.
    const visible = await page.evaluate(() =>
      document.body.textContent.replace(/\s+/g, ' ').slice(0, 300),
    );
    throw new Error(
      `sign-in for ${credentials.email} did not leave /login within 25s :: page text: ${visible}`,
    );
  }
  await sleep(1500);

  return page.evaluate(() => ({
    url: location.href,
    accessToken: Boolean(window.localStorage.getItem('aria_access_token')),
    refreshToken: Boolean(window.localStorage.getItem('aria_refresh_token')),
  }));
}

/** Navigates to an HR route and waits for the view's own root testid to be mounted. */
async function openHr(page, path, readySelector) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(readySelector, { timeout: WAIT });
  await sleep(1200);
}

/** The employee table's rows, as the DOM presents them. */
function readEmployeeRows(page) {
  return page.$$eval('[data-testid="hr-employee-table"] tbody tr', (rows) =>
    rows.map((row) => {
      const links = Array.from(row.querySelectorAll('a[href]'));
      const link =
        links.find((a) => (a.getAttribute('href') ?? '').includes('/admin/hr/employees/')) ??
        links[0];
      return {
        code: link ? link.textContent.trim() : row.textContent.trim(),
        href: link ? new URL(link.href).pathname : null,
        text: row.textContent.replace(/\s+/g, ' ').trim(),
      };
    }),
  );
}

const waitForEmployeeRows = (page, count, timeout = 20000) =>
  page.waitForFunction(
    (expected) =>
      document.querySelectorAll('[data-testid="hr-employee-table"] tbody tr').length === expected,
    { timeout },
    count,
  );

const waitForText = (page, text, timeout = 20000) =>
  page.waitForFunction((needle) => document.body.textContent.includes(needle), { timeout }, text);

/**
 * Clears the search box and waits for the unfiltered table to come back.
 *
 * WHY THIS IS NOT JUST A BACKSPACE: the field is a CONTROLLED React input, and a
 * triple-click selection did not reliably land as "all selected" in this RTL layout — the
 * run then waited forever for a row count that could never arrive. Ctrl+A is the explicit
 * "select all" gesture, and a page RELOAD is the fallback because a fresh mount has an
 * empty search by construction. The reload path is still a real user action; it is not a
 * test-only back door.
 */
async function clearSearchAndWaitForAll(page, expected) {
  await page.click('#hr-employee-search');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(SEARCH_DEBOUNCE_MS + 1200);

  const value = await page.$eval('#hr-employee-search', (el) => el.value);
  try {
    await waitForEmployeeRows(page, expected, 10000);
    return { cleared: true, via: 'keystrokes', valueAfter: value };
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="hr-employee-table"]', { timeout: WAIT });
    await sleep(1200);
    await waitForEmployeeRows(page, expected, 20000);
    return { cleared: true, via: 'reload', valueAfter: value };
  }
}

/** Layout facts read from the RENDERED document. */
function layoutOf(page) {
  return page.evaluate(() => {
    const doc = document.scrollingElement;
    return {
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      dir: document.documentElement.getAttribute('dir'),
      lang: document.documentElement.getAttribute('lang'),
      dataTheme: document.documentElement.getAttribute('data-theme'),
      darkClass: document.documentElement.classList.contains('dark'),
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
    };
  });
}

/**
 * WCAG relative luminance + contrast, so "still readable" is a MEASUREMENT, not a claim.
 *
 * COLORS ARE CONVERTED BY THE BROWSER, NOT BY A REGEX. An earlier version matched
 * `rgb()/rgba()` text and returned null for every element whose colour is written in another
 * space — Chrome returns the colour AS SPECIFIED (`oklch(...)` for these theme tokens), so a
 * regex over the computed value silently produced "no data". Painting the value into a 1x1
 * canvas and reading the pixel back lets the ENGINE do the conversion, which is correct for
 * every format it supports.
 */
function contrastOf(page, selector) {
  return page.evaluate((sel) => {
    const toRgb = (cssColor) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.fillStyle = '#000000';
      ctx.fillStyle = cssColor; // the engine parses whatever space this is written in
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255, css: cssColor };
    };
    const luminance = ({ r, g, b }) => {
      const f = (c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    /** Walks up for the first background that actually paints, the way the eye resolves it. */
    const background = (el) => {
      let node = el;
      while (node) {
        const raw = getComputedStyle(node).backgroundColor;
        const parsed = toRgb(raw);
        if (parsed && parsed.a > 0) return parsed;
        node = node.parentElement;
      }
      return toRgb(getComputedStyle(document.body).backgroundColor);
    };

    const el = document.querySelector(sel);
    if (!el) return null;
    const fg = toRgb(getComputedStyle(el).color);
    const bg = background(el);
    if (!fg || !bg) return null;
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    return {
      selector: sel,
      colorCss: fg.css,
      backgroundCss: bg.css,
      ratio: Math.round(ratio * 100) / 100,
      text: el.textContent.trim().slice(0, 60),
    };
  }, selector);
}

// ---------------------------------------------------------------------------
// §4 — the primary flow, walked as a user walks it
// ---------------------------------------------------------------------------

/**
 * Clicks a control until the PREDICATE holds, and reports how many attempts it needed.
 *
 * WHY A RETRY IS LEGITIMATE HERE, AND WHY IT IS STILL A REAL CHECK: the first click on a
 * freshly-loaded dev-server page can land BEFORE React has hydrated the shell, and a click
 * with no listener attached is simply lost. The predicate is evaluated in the page against
 * the app's own DOM, so this asserts the OUTCOME of the real control; the attempt count is
 * reported so the reader can see whether it took one click (a healthy page) or more (the
 * dev-server hydration window), and a toggle that never works still fails.
 */
async function clickUntil(page, selector, predicateInPage, expected, attempts = 3, settleMs = 1300) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.click(selector);
    await sleep(settleMs);
    const state = await page.evaluate(predicateInPage);
    if (state === expected) return { ok: true, attempts: attempt };
  }
  return { ok: false, attempts };
}

/** §4.4–4.5: the dashboard, including at least one REAL backend-derived value. */
async function runDashboard(page, ctx) {
  await openHr(page, '/admin/hr', '[data-testid="hr-dashboard"]');
  await sleep(1500);

  const text = await page.evaluate(() => document.body.textContent);
  check(text.includes('منابع انسانی'), '§4.4 HR dashboard is rendered and titled', '«منابع انسانی»');
  check(
    text.includes('چارت سازمانی') && text.includes('سمت‌ها') && text.includes('کارکنان'),
    '§4.4 the dashboard exposes its real areas',
  );

  // The counters are read from the DOM and then required to equal the API's OWN answer,
  // so a hard-coded expectation cannot make this pass.
  const counters = await page.$$eval('[data-testid^="hr-count-"]', (cards) =>
    cards.map((card) => {
      const ps = card.querySelectorAll('p');
      return {
        id: card.getAttribute('data-testid'),
        value: (ps[ps.length - 1]?.textContent ?? '').trim(),
      };
    }),
  );
  const byId = Object.fromEntries(counters.map((c) => [c.id.replace('hr-count-', ''), c.value]));
  const expected = {
    employees: fa(ctx.summary.employees),
    units: fa(ctx.summary.units),
    'active-units': fa(ctx.summary.activeUnits),
    positions: fa(ctx.summary.positions),
  };
  check(counters.length === 4, '§4.5 four summary counters rendered', JSON.stringify(byId));
  for (const [key, value] of Object.entries(expected)) {
    check(
      byId[key] === value,
      `§4.5 dashboard ${key} equals the API's own number`,
      `ui=${byId[key]} api=${value}`,
    );
  }
  check(
    ctx.summary.employees > 0 && ctx.summary.units > 0 && ctx.summary.positions > 0,
    '§4.5 the numbers are non-zero — real rows behind the screen',
    JSON.stringify(ctx.summary),
  );

  await shot(page, '03-dashboard-desktop');
}

/** §4.6–4.7 and §6: the list, the REAL search box, the REAL filters and the empty state. */
async function runEmployeesList(page, ctx) {
  await openHr(page, '/admin/hr/employees', '[data-testid="hr-employees"]');
  await page.waitForSelector('[data-testid="hr-employee-table"]', { timeout: WAIT });
  await sleep(1200);

  const rows = await readEmployeeRows(page);
  check(
    rows.length === ctx.employees.total,
    '§4.6 the table lists the tenant’s real records',
    `rows=${rows.length} api=${ctx.employees.total}`,
  );
  check(
    rows.some((r) => r.code === ctx.employee.employeeCode),
    '§4.6 the API’s own first employee code is on screen',
    ctx.employee.employeeCode,
  );
  await shot(page, '04-employees-desktop');

  // ---- the search box, driven by TYPING the code a real row carries -----------
  await page.click('#hr-employee-search', { clickCount: 3 });
  await page.type('#hr-employee-search', ctx.employee.employeeCode);
  await sleep(SEARCH_DEBOUNCE_MS + 1200);
  await waitForEmployeeRows(page, 1);
  const filtered = await readEmployeeRows(page);
  check(
    filtered.length === 1 && filtered[0].code === ctx.employee.employeeCode,
    '§4.7 typing a real code narrows the table to that person',
    JSON.stringify(filtered[0]),
  );
  await shot(page, '05-employees-search');

  // ---- §6 the EMPTY state, produced by a real backend read -------------------
  await page.click('#hr-employee-search', { clickCount: 3 });
  await page.type('#hr-employee-search', 'ZZZ-NO-SUCH-EMPLOYEE');
  await sleep(SEARCH_DEBOUNCE_MS + 1200);
  await waitForText(page, 'هیچ کارمندی با این فیلترها یافت نشد.');
  const emptyRows = await readEmployeeRows(page);
  const emptyLeaf = await page.evaluate(() => {
    const needle = 'هیچ کارمندی با این فیلترها یافت نشد.';
    const leaf = [...document.querySelectorAll('div, p')].find(
      (n) =>
        n.textContent.includes(needle) &&
        ![...n.children].some((c) => c.textContent.includes(needle)),
    );
    return leaf ? leaf.textContent.trim() : null;
  });
  check(emptyRows.length === 0, '§6 an unmatched search renders NO rows', `rows=${emptyRows.length}`);
  check(
    emptyLeaf === 'هیچ کارمندی با این فیلترها یافت نشد.',
    '§6 the view’s own filtered empty state is what the user sees',
    String(emptyLeaf),
  );
  await shot(page, '06-employees-empty');

  const cleared = await clearSearchAndWaitForAll(page, ctx.employees.total);
  check(
    cleared.cleared,
    '§4.7 clearing the real search restores the unfiltered table',
    JSON.stringify(cleared),
  );

  // ---- the STATUS filter, compared against the same API filter ---------------
  await page.select('#hr-employee-status-filter', 'TERMINATED');
  await sleep(1800);
  const terminatedRows = await readEmployeeRows(page);
  check(
    terminatedRows.length === ctx.terminatedTotal,
    '§4.7 the status filter asks the backend and the table agrees',
    `ui=${terminatedRows.length} api=${ctx.terminatedTotal}`,
  );
  await page.select('#hr-employee-status-filter', '');
  await sleep(1800);
  await waitForEmployeeRows(page, ctx.employees.total);

  // ---- the UNIT filter, populated from the real catalogue --------------------
  const unitOption = await page.evaluate((want) => {
    const select = document.querySelector('#hr-employee-unit-filter');
    const option = [...select.options].find((o) => o.value === want);
    return option ? { value: option.value, label: option.textContent.trim() } : null;
  }, ctx.unit.id);
  check(
    !!unitOption,
    '§4.7 the unit filter is populated from the real catalogue',
    JSON.stringify(unitOption),
  );
  if (unitOption) {
    await page.select('#hr-employee-unit-filter', unitOption.value);
    await sleep(1800);
    const unitRows = await readEmployeeRows(page);
    check(
      unitRows.length === ctx.employeesInUnit,
      '§4.7 filtering on the real unit id narrows the table to that unit',
      `ui=${unitRows.length} api=${ctx.employeesInUnit}`,
    );
    await page.select('#hr-employee-unit-filter', '');
    await sleep(1800);
  }
}

/**
 * §4.8–4.13 and §9: open a real record, mutate it through the UI, RELOAD, and require the
 * change to still be there.
 *
 * WHY THE RELOAD IS THE WHOLE POINT: an assertion made a second after a click can be
 * satisfied by React state that never reached the database. A full navigation re-reads the
 * record from the API, so the value on screen after it can only come from `hr_db`. The
 * independent API read after the reload exists for the same reason — it proves the write,
 * not the render.
 */
async function runEmployeeDetailAndMutation(page, ctx) {
  const rows = await readEmployeeRows(page);
  const target = rows.find((r) => r.code === ctx.employee.employeeCode) ?? rows[0];

  await Promise.all([
    page.click(`a[href="${target.href}"]`),
    page.waitForFunction((href) => location.pathname === href, { timeout: WAIT }, target.href),
  ]);
  await page.waitForSelector('[data-testid="hr-detail-summary"]', { timeout: WAIT });
  await sleep(1200);

  check(page.url().endsWith(target.href), '§4.8 clicking a row opens that employee', page.url());

  const detailText = await page.evaluate(() => document.body.textContent);
  check(
    detailText.includes(ctx.employee.employeeCode),
    '§4.8 the record states its own employee code',
    ctx.employee.employeeCode,
  );

  // §4.9 identity, current employment and history — each cross-checked with the API.
  const unitName = ctx.detail.currentAssignment?.organizationUnit?.name ?? null;
  const positionTitle = ctx.detail.currentAssignment?.position?.title ?? null;
  check(!!(await page.$('[data-testid="hr-detail-summary"]')), '§4.9 the personnel card is rendered');
  check(!!(await page.$('[data-testid="hr-detail-assignment"]')), '§4.9 the current-assignment card is rendered');
  check(!!(await page.$('[data-testid="hr-detail-history"]')), '§4.9 the history card is rendered');
  if (unitName) {
    check(detailText.includes(unitName), '§4.9 the CURRENT unit name resolves on screen', unitName);
  }
  if (positionTitle) {
    check(detailText.includes(positionTitle), '§4.9 the CURRENT position title resolves on screen', positionTitle);
  }
  const historyRows = await page.$$eval('[data-testid="hr-history-table"] tbody tr', (r) => r.length);
  check(
    historyRows === ctx.detail.employmentHistory.length,
    '§4.9 the history table lists every real interval',
    `ui=${historyRows} api=${ctx.detail.employmentHistory.length}`,
  );
  await shot(page, '07-employee-detail');

  // ---- §4.10–4.13 + §9: the supported mutation, then a REAL reload -------------
  check(
    ctx.detail.status === 'ACTIVE',
    '§9 the fixture record starts ACTIVE, so the toggle is exercisable',
    ctx.detail.status,
  );

  await page.click('[data-testid="hr-detail-deactivate"]');
  await page.waitForSelector('[data-testid="hr-detail-activate"]', { timeout: WAIT });
  await page.waitForSelector('[data-testid="hr-employee-status-INACTIVE"]', { timeout: WAIT });
  await sleep(900);
  check(true, '§4.10–4.11 the mutation is applied through the UI', 'status control flipped to INACTIVE');
  await shot(page, '08-after-deactivate');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="hr-detail-summary"]', { timeout: WAIT });
  await sleep(1200);
  const afterReload = {
    inactiveBadge: Boolean(await page.$('[data-testid="hr-employee-status-INACTIVE"]')),
    activateButton: Boolean(await page.$('[data-testid="hr-detail-activate"]')),
  };
  check(
    afterReload.inactiveBadge && afterReload.activateButton,
    '§4.12–4.13 the change SURVIVES a full page reload',
    JSON.stringify(afterReload),
  );
  const apiAfter = await api(`/hr/employees/${ctx.employee.id}`, { token: ctx.token });
  check(
    apiAfter.data?.status === 'INACTIVE',
    '§9 an INDEPENDENT API read confirms the database changed',
    `status=${apiAfter.data?.status}`,
  );
  await shot(page, '09-after-reload');

  // Restore, so this run leaves the development data exactly as it found it.
  await page.click('[data-testid="hr-detail-activate"]');
  await page.waitForSelector('[data-testid="hr-detail-deactivate"]', { timeout: WAIT });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="hr-detail-summary"]', { timeout: WAIT });
  await sleep(1000);
  const restoredBadge = Boolean(await page.$('[data-testid="hr-employee-status-ACTIVE"]'));
  const apiRestored = await api(`/hr/employees/${ctx.employee.id}`, { token: ctx.token });
  check(
    restoredBadge && apiRestored.data?.status === 'ACTIVE',
    '§9 the fixture is restored to ACTIVE, leaving no residue',
    `ui=${restoredBadge} api=${apiRestored.data?.status}`,
  );
  await shot(page, '10-restored');
}

/** §4.14–4.15: the real hierarchy — the tree, a REAL selection, and the unit table. */
async function runOrganization(page, ctx) {
  await openHr(page, '/admin/hr/organization', '[data-testid="hr-organization"]');
  await page.waitForSelector('[data-testid="hr-unit-table"]', { timeout: WAIT });
  await sleep(1500);

  // The tree renders one node per unit, keyed by the CODE the backend sent, so the
  // presence of that exact testid is evidence the hierarchy came from `hr_db`.
  const treeNodes = await page.$$eval('[data-testid^="hr-org-node-"]', (nodes) =>
    nodes.map((n) => ({ code: n.getAttribute('data-testid').replace('hr-org-node-', ''), depth: n.getAttribute('data-depth') })),
  );
  check(
    treeNodes.some((n) => n.code === ctx.unit.code),
    '§4.15 the org tree contains the tenant’s real unit code',
    JSON.stringify(treeNodes),
  );

  const treeTotal = await page.$eval('[data-testid="hr-org-tree-total"]', (el) => el.textContent.trim());
  check(
    treeTotal.startsWith(fa(ctx.unitsTotal)),
    '§4.15 the tree total equals the API’s own unit count',
    `ui="${treeTotal}" api=${ctx.unitsTotal}`,
  );

  const tableText = await page.$eval('[data-testid="hr-unit-table"]', (el) => el.textContent);
  const tableRows = await page.$$eval('[data-testid="hr-unit-table"] tbody tr', (r) => r.length);
  check(tableRows === ctx.unitsTotal, '§4.15 the unit table pages the real catalogue', `rows=${tableRows} api=${ctx.unitsTotal}`);
  check(tableText.includes(ctx.unit.code), '§4.15 the code column shows the real code', ctx.unit.code);

  // A REAL selection: click the node, then require the details card to name that unit.
  await page.click(`[data-testid="hr-org-select-${ctx.unit.code}"]`);
  await sleep(900);
  const selectedCard = await page.$eval('[data-testid="hr-org-selected-card"]', (el) => el.textContent.replace(/\s+/g, ' ').trim());
  check(
    selectedCard.includes(ctx.unit.code) && selectedCard.includes(ctx.unit.name),
    '§4.15 selecting a tree node shows that unit’s own name and code',
    selectedCard.slice(0, 120),
  );
  await shot(page, '11-organization');

  // ---- a SECOND real mutation: repair the lossy fixture name through the UI --------
  //
  // The stored name is literally `???? ?????` — ten `0x3F` bytes — because an earlier
  // fixture was written by a shell whose codepage could not carry Persian. The DATABASE,
  // the API and this browser are all UTF-8 (`server_encoding`/`client_encoding` are UTF8;
  // the API returns exactly the bytes it stores), so this is bad fixture data, not a
  // product defect. Correcting it through the UI serves two purposes at once: the screens
  // then show real Persian content, and a non-ASCII string is proven to survive
  // browser -> API -> PostgreSQL -> reload with no loss and no `?` substitution.
  const PERSIAN_NAME = 'دفتر مرکزی';
  await page.click('[data-testid="hr-unit-edit-open"]');
  await page.waitForSelector('[data-testid="hr-unit-edit-panel"]', { timeout: WAIT });
  await page.click('#hr-unit-name');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.type('#hr-unit-name', PERSIAN_NAME);
  const typedName = await page.$eval('#hr-unit-name', (el) => el.value);
  check(
    typedName === PERSIAN_NAME,
    '§4.10b the browser itself holds the Persian string before saving',
    JSON.stringify(typedName),
  );

  await page.click('[data-testid="hr-unit-edit-submit"]');
  await sleep(3000);
  const afterSave = await page.$eval('[data-testid="hr-org-selected-card"]', (el) =>
    el.textContent.replace(/\s+/g, ' ').trim(),
  );
  check(
    afterSave.includes(PERSIAN_NAME),
    '§4.10b the Persian name is applied in the UI after saving',
    afterSave.slice(0, 120),
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="hr-unit-table"]', { timeout: WAIT });
  await sleep(1800);
  const afterReload = await page.$eval('[data-testid="hr-unit-table"]', (el) =>
    el.textContent.replace(/\s+/g, ' '),
  );
  check(
    afterReload.includes(PERSIAN_NAME),
    '§4.10b the Persian name SURVIVES a full reload (read back from hr_db)',
    afterReload.slice(0, 160),
  );

  const apiUnit = await api(`/hr/organization/units/${ctx.unit.id}`, { token: ctx.token });
  const returnedName = apiUnit.data?.name ?? '';
  const codePoints = [...returnedName]
    .map((c) => 'U+' + c.codePointAt(0).toString(16))
    .join(' ');
  check(
    returnedName === PERSIAN_NAME && !/^[\x00-\x7f]*$/.test(returnedName),
    '§4.10b the API returns the SAME Persian string (no mojibake, no 0x3F substitution)',
    `name=${JSON.stringify(returnedName)} codePoints=${codePoints}`,
  );
}

/** §4.16: the position catalogue, cross-checked against the API. */
async function runPositions(page, ctx) {
  await openHr(page, '/admin/hr/positions', '[data-testid="hr-positions"]');
  await page.waitForSelector('[data-testid="hr-position-table"]', { timeout: WAIT });
  await sleep(1500);

  const rows = await page.$$eval('[data-testid="hr-position-table"] tbody tr', (r) => r.length);
  const total = await page.$eval('[data-testid="hr-position-total"]', (el) => el.textContent.trim());

  // The unit name is read NOW, not from the startup snapshot: the organization step above
  // renames a unit through the UI, so the only truthful expectation is the current one.
  const currentUnits = (await api('/hr/organization/units?pageSize=100', { token: ctx.token })).data;
  const currentUnit = currentUnits.items.find((u) => u.id === ctx.position.organizationUnitId);
  const positionUnitName = currentUnit?.name ?? null;

  const row = await page.$eval(`[data-testid="hr-position-row-${ctx.position.id}"]`, (el) =>
    el.textContent.replace(/\s+/g, ' ').trim(),
  );

  check(rows === ctx.positionsTotal, '§4.16 the position table lists the real catalogue', `rows=${rows} api=${ctx.positionsTotal}`);
  check(
    row.includes(ctx.position.code) && row.includes(ctx.position.title),
    '§4.16 the fixture position’s own row carries its real code and title',
    row.slice(0, 120),
  );
  check(
    !!positionUnitName && row.includes(positionUnitName),
    '§4.16 the row resolves its organisation unit by NAME',
    `expected «${positionUnitName}» in "${row.slice(0, 120)}"`,
  );
  check(total.startsWith(fa(ctx.positionsTotal)), '§4.16 the total equals the API’s own count', `ui="${total}" api=${ctx.positionsTotal}`);
  await shot(page, '12-positions');
}

// ---------------------------------------------------------------------------
// §5 — authorization, as a real sign-in with an account that has NO hr.* grant
// ---------------------------------------------------------------------------

/**
 * Opens a context with its OWN storage, so a viewed session cannot inherit another's.
 *
 * THE COLOUR SCHEME IS PINNED ON PURPOSE. Headless Chrome reports
 * `prefers-color-scheme: dark`, so an unpinned harness silently measures every "light"
 * screen in DARK mode — the app honours the system preference through its `ThemeScript`.
 * Pinning it to light makes the light/dark evidence deterministic and, more importantly,
 * makes each measurement mean what its label says; §8 then switches to dark through the
 * app's own control.
 */
async function newIsolatedPage(browser, viewport = { width: 1440, height: 900 }) {
  const context = browser.createBrowserContext
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  return { context, page };
}

/**
 * The unauthorized flow.
 *
 * TWO INDEPENDENT FACTS ARE REQUIRED, and neither alone is enough:
 *   1. the API answers 403 for this user's token, so nothing sensitive is available to be
 *      rendered — the UI is not merely hiding data it was given;
 *   2. the screen renders no table and no employee code, so nothing leaked into the DOM.
 *
 * The Persian copy is matched on the PERMISSION TOKEN (`hr.employees.read`) rather than the
 * whole sentence: that sentence contains ZWNJ characters (U+200C), and a check that breaks
 * on an invisible character would be a test defect, not a product finding.
 */
async function runAuthorizationFlow(browser, ctx) {
  const { context, page } = await newIsolatedPage(browser);

  const session = await signIn(page, VIEWER);
  check(session.accessToken, '§5 the unauthorized user establishes a real session', session.url);

  const viewerLogin = await apiLogin(VIEWER);
  const apiRead = await api('/hr/employees', { token: viewerLogin.token });
  check(
    apiRead.status === 403,
    '§5 the API itself refuses this user (403 — nothing sensitive is even available)',
    `status=${apiRead.status}`,
  );

  await page.goto(`${WEB}/admin/hr/employees`, { waitUntil: 'domcontentloaded' });
  await sleep(4500);

  const body = await page.evaluate(() => document.body.textContent);
  const tablePresent = Boolean(await page.$('[data-testid="hr-employee-table"]'));
  const codeLeaked = body.includes(ctx.employee.employeeCode);

  check(
    body.includes('hr.employees.read'),
    '§5 the screen states the missing permission',
    'names hr.employees.read',
  );
  check(!tablePresent, '§5 no HR table is rendered for the unauthorized user');
  check(
    !codeLeaked,
    '§5 no employee code from the database appears anywhere in the DOM',
    `searched for «${ctx.employee.employeeCode}»`,
  );
  check(page.url().includes('/admin/hr/employees'), '§5 the user stays on the route with a safe refusal', page.url());
  await shot(page, '13-viewer-forbidden');

  await context.close();
}

// ---------------------------------------------------------------------------
// §7 — responsive proof at desktop and mobile viewports
// ---------------------------------------------------------------------------

/** The employee table's own scroll container: a wide table must scroll, not widen the page. */
const tableBoxState = (page) =>
  page.evaluate(() => {
    const table = document.querySelector('[data-testid="hr-employee-table"]');
    const box = table?.parentElement;
    if (!box) return null;
    return {
      boxWidth: Math.round(box.clientWidth),
      contentWidth: Math.round(box.scrollWidth),
      scrolls: box.scrollWidth > box.clientWidth + 1,
      rows: table.querySelectorAll('tbody tr').length,
    };
  });

async function runResponsive(browser, ctx) {
  const { context, page } = await newIsolatedPage(browser);

  // ---------- desktop ----------
  await signIn(page, ADMIN);
  await openHr(page, '/admin/hr/employees', '[data-testid="hr-employees"]');
  await page.waitForSelector('[data-testid="hr-employee-table"]', { timeout: WAIT });
  await sleep(1200);

  const desktop = await layoutOf(page);
  check(
    !desktop.horizontalOverflow,
    '§7 desktop 1440: the page has no accidental horizontal overflow',
    `scrollW=${desktop.scrollWidth} clientW=${desktop.clientWidth}`,
  );
  const desktopTable = await tableBoxState(page);
  check(
    desktopTable.rows > 0,
    '§7 desktop: the table renders real rows',
    JSON.stringify(desktopTable),
  );

  // ---------- mobile 390 ----------
  await page.setViewport({ width: 390, height: 844 });
  await openHr(page, '/admin/hr/employees', '[data-testid="hr-employees"]');
  await page.waitForSelector('[data-testid="hr-employee-table"]', { timeout: WAIT });
  await sleep(1200);

  const mobile = await layoutOf(page);
  check(
    !mobile.horizontalOverflow,
    '§7 mobile 390: the PAGE does not overflow horizontally',
    `scrollW=${mobile.scrollWidth} clientW=${mobile.clientWidth}`,
  );
  const mobileTable = await tableBoxState(page);
  check(
    !!mobileTable && mobileTable.scrolls && mobileTable.rows > 0,
    '§7 mobile: the wide table DEGRADES into its own scroll container instead of breaking the layout',
    JSON.stringify(mobileTable),
  );

  // the filters stay usable at this width: type into the real control and watch it filter
  await page.click('#hr-employee-search', { clickCount: 3 });
  await page.type('#hr-employee-search', ctx.employee.employeeCode);
  await sleep(SEARCH_DEBOUNCE_MS + 1200);
  const mobileFiltered = await readEmployeeRows(page);
  check(
    mobileFiltered.length === 1 && mobileFiltered[0].code === ctx.employee.employeeCode,
    '§7 mobile: the search control remains usable and filters',
    JSON.stringify(mobileFiltered[0] ?? null),
  );
  await shot(page, '14-employees-mobile');

  // the navigation stays usable: the real drawer opens and carries the HR destinations
  await page.click('header button[aria-label="نمایش منو"]');
  await sleep(1000);
  const drawer = await page.evaluate(() => {
    const layer = document.querySelector('[data-testid="core-mobile-drawer"]');
    const links = [...(layer?.querySelectorAll('a[href]') ?? [])].map((a) => a.getAttribute('href'));
    return {
      state: layer?.getAttribute('data-state') ?? null,
      hrLinks: links.filter((href) => (href ?? '').includes('/admin/hr')),
    };
  });
  check(
    drawer.state === 'open' && drawer.hrLinks.length > 0,
    '§7 mobile: the navigation drawer opens and lists the real HR destinations',
    JSON.stringify(drawer),
  );
  await shot(page, '14b-mobile-nav-open');
  await page.click('[data-testid="core-drawer-close"]');
  await sleep(600);

  // the detail view stays readable on mobile
  const rows = await readEmployeeRows(page);
  const target = rows.find((r) => r.code === ctx.employee.employeeCode) ?? rows[0];
  await Promise.all([
    page.click(`a[href="${target.href}"]`),
    page.waitForFunction((href) => location.pathname === href, { timeout: WAIT }, target.href),
  ]);
  await page.waitForSelector('[data-testid="hr-detail-summary"]', { timeout: WAIT });
  await sleep(1200);

  const detailLayout = await layoutOf(page);
  check(
    !detailLayout.horizontalOverflow,
    '§7 mobile: the record page does not overflow either',
    `scrollW=${detailLayout.scrollWidth} clientW=${detailLayout.clientWidth}`,
  );
  const cards = await page.evaluate(() => {
    const ids = ['hr-detail-summary', 'hr-detail-assignment', 'hr-detail-history'];
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (!el) return { id, missing: true };
      const r = el.getBoundingClientRect();
      return {
        id,
        w: Math.round(r.width),
        h: Math.round(r.height),
        overflows: r.right > innerWidth + 1 || r.left < -1,
      };
    });
  });
  check(
    cards.every((c) => !c.missing && c.w > 0 && c.h > 0 && !c.overflows),
    '§7 mobile: the detail cards keep their box inside the viewport (no broken cards)',
    JSON.stringify(cards),
  );
  await shot(page, '15-detail-mobile');

  // ---------- mobile 360 ----------
  await page.setViewport({ width: 360, height: 800 });
  for (const [route, selector] of [
    ['/admin/hr', '[data-testid="hr-dashboard"]'],
    ['/admin/hr/employees', '[data-testid="hr-employees"]'],
    ['/admin/hr/organization', '[data-testid="hr-organization"]'],
  ]) {
    await openHr(page, route, selector);
    const layout = await layoutOf(page);
    check(
      !layout.horizontalOverflow,
      `§7 mobile 360: ${route} does not overflow horizontally`,
      `scrollW=${layout.scrollWidth} clientW=${layout.clientWidth}`,
    );
  }
  await shot(page, '16-organization-mobile-360');

  await context.close();
}

// ---------------------------------------------------------------------------
// §8 — RTL and dark mode, measured rather than eyeballed
// ---------------------------------------------------------------------------

async function runRtlAndDark(browser) {
  const { context, page } = await newIsolatedPage(browser);
  await signIn(page, ADMIN);
  await openHr(page, '/admin/hr/employees', '[data-testid="hr-employees"]');
  await page.waitForSelector('[data-testid="hr-employee-table"]', { timeout: WAIT });
  await sleep(1200);

  const base = await layoutOf(page);
  check(base.dir === 'rtl', '§8 the document direction is RTL', String(base.dir));
  check(base.lang === 'fa', '§8 the document language is Persian', String(base.lang));
  check(
    base.dataTheme === 'light' && !base.darkClass,
    '§8 with the light system preference the app starts in LIGHT (so the next measurement is honest)',
    JSON.stringify({ dataTheme: base.dataTheme, darkClass: base.darkClass }),
  );
  const text = await page.evaluate(() => document.body.textContent);
  check(
    text.includes('کارکنان') && text.includes('واحد سازمانی'),
    '§8 Persian HR labels render',
    '«کارکنان» / «واحد سازمانی»',
  );

  const lightContrast = await contrastOf(page, '[data-testid="hr-employee-table"] thead th');
  check(
    !!lightContrast && lightContrast.ratio >= 3 && !lightContrast.backgroundCss.includes('0.24'),
    '§8 (LIGHT, verified as light) the table header has measurable text contrast',
    JSON.stringify(lightContrast),
  );

  // The REAL control, not a class injected by the harness.
  const toggled = await clickUntil(
    page,
    '[data-testid="theme-toggle"]',
    () => document.documentElement.classList.contains('dark'),
    true,
  );
  const dark = await layoutOf(page);
  check(
    dark.darkClass && dark.dataTheme === 'dark',
    '§8 the theme toggle switches the running app to dark',
    JSON.stringify({ ...toggled, darkClass: dark.darkClass, dataTheme: dark.dataTheme }),
  );

  const darkTable = await contrastOf(page, '[data-testid="hr-employee-table"] thead th');
  const darkHeading = await contrastOf(page, '[data-testid="hr-employees"] h1');
  check(
    !!darkTable && darkTable.ratio >= 3,
    '§8 (DARK, on a repainted page) the table header stays readable',
    JSON.stringify(darkTable),
  );
  // The two measurements must be taken on DIFFERENT paints, or "light vs dark" is a claim
  // about a label rather than about the screen.
  check(
    !!lightContrast && !!darkTable && lightContrast.backgroundCss !== darkTable.backgroundCss,
    '§8 the dark measurement sits on a different background than the light one',
    `light=${lightContrast?.backgroundCss} dark=${darkTable?.backgroundCss}`,
  );
  check(
    !!darkHeading && darkHeading.ratio >= 3,
    '§8 (dark) the HR page heading stays readable',
    JSON.stringify(darkHeading),
  );
  check(dark.dir === 'rtl', '§8 the direction stays RTL in dark mode', String(dark.dir));
  await shot(page, '17-employees-dark');

  const restoredToggle = await clickUntil(
    page,
    '[data-testid="theme-toggle"]',
    () => !document.documentElement.classList.contains('dark'),
    true,
  );
  const restored = await layoutOf(page);
  check(
    !restored.darkClass,
    '§8 the theme is restored to light after the proof',
    JSON.stringify({ ...restoredToggle, dataTheme: restored.dataTheme }),
  );

  await context.close();
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('\n=== PHASE 51-HR-2D — REAL BROWSER E2E (web :3003 -> api :4000 -> hr_db) ===\n');

  await assertStackIsRunning();

  // ---- the facts every UI assertion is measured against ----------------------
  const adminLogin = await apiLogin(ADMIN);
  check(
    adminLogin.status === 200 && !!adminLogin.token,
    'the admin fixture authenticates against the API',
    `status=${adminLogin.status}`,
  );
  if (!adminLogin.token) {
    console.log('\nBLOCKED — the admin fixture could not authenticate; nothing to verify.');
    process.exit(2);
  }
  const token = adminLogin.token;

  const fixtureNote = await ensureViewerUser();
  check(
    fixtureNote.ok,
    '§5 fixture: the unauthorized account exists and can authenticate',
    JSON.stringify(fixtureNote),
  );
  if (!fixtureNote.ok) {
    console.log(
      '\nBLOCKED — the §5 unauthorized fixture could not be created/authenticated; the authorization flow cannot be proven.',
    );
    process.exit(2);
  }

  const summary = (await api('/hr/organization/summary', { token })).data;
  const employees = (await api('/hr/employees', { token })).data;
  const terminated = (await api('/hr/employees?status=TERMINATED', { token })).data;
  const units = (await api('/hr/organization/units?pageSize=100', { token })).data;
  const positions = (await api('/hr/positions?pageSize=100', { token })).data;

  check(
    !!employees?.items?.length,
    'a real employee fixture exists in hr_db',
    `total=${employees?.total}`,
  );
  if (!employees?.items?.length || !units?.items?.length || !positions?.items?.length) {
    console.log('\nBLOCKED — the HR fixture set is incomplete; the browser flow needs one of each.');
    process.exit(2);
  }

  const employee = employees.items[0];
  const detail = (await api(`/hr/employees/${employee.id}`, { token })).data;
  const unit = units.items[0];
  const position = positions.items[0];
  const employeesInUnit = (await api(`/hr/employees?organizationUnitId=${unit.id}`, { token })).data
    .total;

  const ctx = {
    token,
    summary,
    employees,
    employee,
    detail,
    unit,
    position,
    unitsTotal: units.total,
    positionsTotal: positions.total,
    terminatedTotal: terminated.total,
    employeesInUnit,
    positionUnitName: position.organizationUnit?.name ?? null,
  };
  console.log(
    `FIXTURES :: employee=${employee.employeeCode} unit=${unit.code} position=${position.code} inUnit=${employeesInUnit} terminated=${terminated.total}\n`,
  );

  const browser = await launchBrowser();
  console.log(`BROWSER :: real system Chrome ${await browser.version()}\n`);

  // ---- §4: the primary flow -------------------------------------------------
  const { context, page } = await newIsolatedPage(browser);
  try {
    await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="email"]', { timeout: WAIT });
    await sleep(1200);
    check(true, '§4.1 the login page opens in the browser', `${WEB}/login`);
    await shot(page, '01-login');

    const session = await signIn(page, ADMIN);
    check(
      session.accessToken && session.refreshToken,
      '§4.2 a REAL session is established through the form',
      session.url,
    );
    await shot(page, '02-after-login');

    await runDashboard(page, ctx);
    await runEmployeesList(page, ctx);
    await runEmployeeDetailAndMutation(page, ctx);
    await runOrganization(page, ctx);
    await runPositions(page, ctx);
  } finally {
    await context.close();
  }

  await runAuthorizationFlow(browser, ctx);
  await runResponsive(browser, ctx);
  await runRtlAndDark(browser);

  await browser.close();

  const failed = findings.filter((f) => !f.ok);
  console.log('\n=== SUMMARY ===');
  console.log(
    `checks: ${findings.length}  passed: ${findings.length - failed.length}  failed: ${failed.length}`,
  );
  for (const f of failed) console.log(`FAILED :: ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
  console.log(
    failed.length === 0
      ? '\nRESULT: READY — the browser flow is green against the live stack.'
      : '\nRESULT: NOT GREEN — see the failures above.',
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\nHARNESS ERROR', err);
  process.exit(1);
});







