// Phase 49L browser validation harness: the Core Settings integration surface.
//
// Exercises the REAL stack in a REAL browser: Chrome drives the Next app, which calls the
// Core API, which reads and writes Postgres. Nothing is stubbed. §41 asks for the
// integration list, the n8n configuration, enable/disable, the connection test, safe
// status, a masked secret and validation errors; each is checked below by what is
// RENDERED, not by what an API returned.
//
// It also asserts two absences, because both are boundaries rather than omissions:
//   - no workflow editor anywhere on the page (§41);
//   - no secret value in the DOM after a reload (§15).
//
// State it touches, and how it is put back:
//   - creates ONE `IntegrationConfig` row through the UI, deletes it through the UI at
//     the end, then verifies the table is empty;
//   - takes screenshots into phase49l-shots/.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BASE = process.env.L49L_WEB ?? 'http://localhost:3000';
const OUT = 'phase49l-shots';

const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

/** A public origin: the SSRF guard's private-target branch is not what this run tests. */
const ENDPOINT = 'https://automation.example.com';

const results = [];
const consoleErrors = [];
/** The one console error this run deliberately provokes; see below. */
const expectedErrors = [];
let step = 0;

/**
 * True for the ONE console error this run deliberately provokes.
 *
 * Check 9 submits an invalid endpoint on purpose, so the browser logs a failed 400
 * resource load. Filtering it by exact shape — rather than lowering the console-error
 * assertion to a count — keeps the assertion meaningful: any OTHER console error, and
 * any 500, still fails the run.
 */
const isExpectedValidationError = (message) =>
  message.includes('Failed to load resource') &&
  (message.includes('400') || message.includes('422'));

const check = (name, ok, detail = '') => {
  step += 1;
  results.push({ name: `${step}. ${name}`, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${step}. ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Sets a controlled input the way React observes it. */
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
}

const text = (page, selector) =>
  page.$eval(selector, (el) => el.textContent?.trim() ?? '').catch(() => null);

const exists = (page, selector) => page.$(selector).then(Boolean);

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2' });
  await setInput(page, 'input[type="email"], input[name="email"]', EMAIL);
  await setInput(page, 'input[type="password"], input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => undefined),
    page.click('button[type="submit"]'),
  ]);
  await sleep(1500);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    // The system Chrome, matching the 49I and 49K harnesses. Puppeteer's own cached
    // build is a different (older) version than this puppeteer expects, so resolving it
    // automatically fails; pinning the installed browser is what makes the run
    // reproducible on this machine.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;

    const text = message.text();
    if (isExpectedValidationError(text)) expectedErrors.push(text);
    else consoleErrors.push(text);
  });

  try {
    await login(page);

    await page.goto(`${BASE}/admin/integrations`, { waitUntil: 'networkidle2' });
    await sleep(2000);

    check('The integrations page rendered for an authorised admin', await exists(page, '[data-testid="integrations-view"]'));

    // §42: RTL and Persian.
    const dir = await page.$eval('html', (el) => el.getAttribute('dir'));
    check('The document is RTL', dir === 'rtl', `dir=${dir}`);

    const heading = await text(page, 'h1');
    check(
      'The heading is the Persian section name',
      heading === 'اتوماسیون و یکپارچه‌سازی',
      heading ?? '',
    );

    // §41: the empty state must say Aria works without an integration.
    const emptyCopy = await page.evaluate(() => document.body.innerText);
    check(
      'The empty state states Aria is functional without an integration',
      emptyCopy.includes('آریا بدون آن کامل کار می‌کند'),
    );

    check(
      'NO workflow editor is present anywhere on the page',
      !/گردش کار|workflow|canvas/i.test(emptyCopy),
    );

    await page.screenshot({ path: `${OUT}/01-empty.png` });

    // ── Create through the UI ────────────────────────────────────────────────
    await page.click('[data-testid="integration-create-toggle"]');
    await sleep(600);

    check('The create form opened', await exists(page, '[data-testid="integration-form"]'));

    const secretType = await page
      .$eval('[data-testid="integration-secret"]', (el) => el.getAttribute('type'))
      .catch(() => null);
    check('The secret field is a password input', secretType === 'password', secretType ?? '');

    const secretValueOnOpen = await page
      .$eval('[data-testid="integration-secret"]', (el) => el.value)
      .catch(() => null);
    check('The secret field opens EMPTY, with nothing to prefill it', secretValueOnOpen === '');

    // A deliberately invalid endpoint first: the server's validation message must surface.
    await setInput(page, '[data-testid="integration-baseUrl"]', 'not-a-url');
    await setInput(page, '[data-testid="integration-webhookPath"]', '/webhook/aria');
    await page.click('[data-testid="integration-save"]');
    await sleep(1800);

    const validationVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="alert"]')).some((el) =>
        (el.textContent ?? '').length > 0,
      ),
    );
    check('An invalid endpoint produced a visible validation error', validationVisible);
    await page.screenshot({ path: `${OUT}/02-validation.png` });

    // Now a valid one, created DISABLED.
    await setInput(page, '[data-testid="integration-baseUrl"]', ENDPOINT);
    await page.click('[data-testid="integration-save"]');
    await sleep(2200);

    check(
      'The integration was created and appears in the list',
      await exists(page, '[data-testid="integration-row-N8N"]'),
    );

    const createdStatus = await text(page, '[data-testid="integration-status-N8N"]');
    check(
      'A row created disabled reads "غیرفعال", not "connected"',
      createdStatus === 'غیرفعال',
      createdStatus ?? '',
    );

    const secretStatus = await text(page, '[data-testid="integration-secret-status-N8N"]');
    check(
      'The secret status reads "not stored" before one is generated',
      secretStatus === 'ذخیره نشده',
      secretStatus ?? '',
    );

    await page.screenshot({ path: `${OUT}/03-created-disabled.png` });

    // ── Secret generation: shown once, masked afterwards ─────────────────────
    await page.click('[data-testid="integration-rotate-N8N"]');
    await sleep(2200);

    const shownSecret = await text(page, '[data-testid="integration-secret-value"]');
    check(
      'A generated secret is shown ONCE, at full 64-hex length',
      Boolean(shownSecret) && /^[0-9a-f]{64}$/.test(shownSecret ?? ''),
      shownSecret ? `${shownSecret.length} chars` : 'absent',
    );

    const warningCopy = await text(page, '[data-testid="integration-secret-once"]');
    check(
      'The one-time warning tells the operator to copy it now',
      (warningCopy ?? '').includes('کپی کنید'),
    );

    await page.screenshot({ path: `${OUT}/04-secret-once.png` });

    // THE containment check: after a reload the value must be gone from the DOM.
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2000);

    const domAfterReload = await page.evaluate(() => document.documentElement.outerHTML);
    check(
      'After a reload the secret value is NOWHERE in the DOM',
      !domAfterReload.includes(shownSecret ?? '§never§'),
    );
    check(
      'No 64-hex value appears anywhere on the reloaded page',
      !/[0-9a-f]{64}/.test(await page.evaluate(() => document.body.innerText)),
    );

    const rotatedStatus = await text(page, '[data-testid="integration-secret-status-N8N"]');
    check(
      'The row now reports the secret as STORED with a rotation date',
      (rotatedStatus ?? '').startsWith('ذخیره شده') && (rotatedStatus ?? '').includes('آخرین تغییر'),
      rotatedStatus ?? '',
    );

    // Confirm at the DATABASE that only the envelope is stored.
    const stored = await psql(
      `SELECT coalesce("secretCiphertext",'-') || '|' || coalesce("secretIv",'-') || '|' ||
              coalesce("secretAuthTag",'-')
       FROM "IntegrationConfig" WHERE integration = 'N8N';`,
    );
    check(
      'The database holds a complete AES-GCM envelope, not a plaintext secret',
      stored.out.split('|').every((part) => part !== '-') &&
        !stored.out.includes(shownSecret ?? '§never§'),
      stored.out.slice(0, 40),
    );

    await page.screenshot({ path: `${OUT}/05-masked-after-reload.png` });

    // ── Enable, then test the connection against an unreachable endpoint ──────
    await page.click('[data-testid="integration-edit-N8N"]');
    await sleep(700);

    const secretOnEdit = await page
      .$eval('[data-testid="integration-secret"]', (el) => el.value)
      .catch(() => null);
    check(
      'Editing a row WITH a stored secret still opens the field EMPTY',
      secretOnEdit === '',
      `value=${JSON.stringify(secretOnEdit)}`,
    );

    const serviceDisabled = await page
      .$eval('[data-testid="integration-service"]', (el) => el.disabled)
      .catch(() => null);
    check('The service selector is locked while editing', serviceDisabled === true);

    await page.click('[data-testid="integration-enabled"]');
    await page.click('[data-testid="integration-save"]');
    await sleep(2200);

    const enabledStatus = await text(page, '[data-testid="integration-status-N8N"]');
    check(
      'Once enabled and with a secret, the status reads "فعال — آزمایش نشده"',
      enabledStatus === 'فعال — آزمایش نشده',
      enabledStatus ?? '',
    );

    await page.screenshot({ path: `${OUT}/06-enabled-untested.png` });

    // The endpoint is a public host that does not answer, so this must report FAILURE —
    // and it must report it as a MESSAGE, not as a broken page.
    await page.click('[data-testid="integration-test-N8N"]');
    await sleep(15000);

    const testMessage = await text(page, '[data-testid="integration-test-result-N8N"]');
    check(
      'A failed connection test renders a Persian message rather than an error page',
      Boolean(testMessage) && /نشد|خطا/.test(testMessage ?? ''),
      testMessage ?? 'absent',
    );
    check(
      'The failure message leaks no status code or upstream detail',
      !/\b[45]\d\d\b/.test(testMessage ?? '') && !/HTTP|TIMEOUT|ECONN/i.test(testMessage ?? ''),
    );

    const testedStatus = await text(page, '[data-testid="integration-status-N8N"]');
    check(
      'The row now distinguishes "اتصال برقرار نشد" from merely being disabled',
      testedStatus === 'اتصال برقرار نشد',
      testedStatus ?? '',
    );

    await page.screenshot({ path: `${OUT}/07-test-failed.png` });

    // ── Responsive: the settings surface at 390px ─────────────────────────────
    await page.setViewport({ width: 390, height: 844 });
    await sleep(1200);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    check(
      'No horizontal overflow at 390px',
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `${overflow.scrollWidth} vs ${overflow.clientWidth}`,
    );

    await page.screenshot({ path: `${OUT}/08-mobile-390.png` });
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(800);

    // ── Cleanup through the UI, then verify at the database ──────────────────
    await page.click('[data-testid="integration-delete-N8N"]');
    await sleep(2400);

    check(
      'The integration was deleted through the UI',
      !(await exists(page, '[data-testid="integration-row-N8N"]')),
    );

    const leftovers = await psql(`SELECT count(*) FROM "IntegrationConfig";`);
    check('No configuration row is left behind', leftovers.out === '0', leftovers.out);

    check(
      'No UNEXPECTED console errors during the run',
      consoleErrors.length === 0,
      consoleErrors.join(' | '),
    );
    check(
      'The deliberate validation failure was the only console error, and it was a 4xx',
      expectedErrors.length === 1,
      expectedErrors.join(' | '),
    );
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    const failed = results.filter((entry) => !entry.ok);
    console.log(`\nunexpected console errors: ${consoleErrors.length}`);
    console.log(`expected (deliberate 4xx) console errors: ${expectedErrors.length}`);
    console.log(`${results.length - failed.length} PASS / ${failed.length} FAIL`);
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

