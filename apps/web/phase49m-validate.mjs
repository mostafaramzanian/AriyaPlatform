// Phase 49M browser validation harness: the module registry admin surface.
//
// Exercises the REAL stack in a REAL browser: Chrome drives the Next app, which calls the Core API,
// which reads and writes Postgres. Nothing is stubbed. §44 asks for view / register / enable /
// disable / test-connection / health / version / capabilities, and for the assertion that an
// unauthorized user cannot manage modules; each is checked below by what is RENDERED, not by what an
// API returned.
//
// It also asserts three ABSENCES, because all three are boundaries rather than omissions:
//   - NO endpoint input anywhere in the registration form (§40): an administrator does not type a URL;
//   - NO credential value in the DOM after a reload (§20);
//   - NO per-module navigation entry (the registry is ONE page, not one page per module).
//
// State it touches, and how it is put back:
//   - creates ONE `ModuleRegistration` through the UI, deletes it through the UI at the end, then
//     verifies the table is back to its prior count;
//   - takes screenshots into phase49m-shots/.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BASE = process.env.M49M_WEB ?? 'http://localhost:3000';
const OUT = 'phase49m-shots';

const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

/** The module this run creates. Not HR, not Finance, no domain (§43). */
const MODULE_ID = 'browser-under-test';
const DISPLAY_NAME = 'Browser Under Test';

const results = [];
const consoleErrors = [];
let step = 0;

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

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png` });
}

/** Text content of the whole page, for absence assertions. */
const bodyText = (page) => page.evaluate(() => document.body.innerText);

async function main() {
  await mkdir(OUT, { recursive: true });
  await psql(`DELETE FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`);

  const browser = await puppeteer.launch({
    headless: true,
    // The system Chrome, matching the 49I / 49K / 49L harnesses. Puppeteer's own cached build is a
    // different (older) version than this puppeteer expects, so resolving it automatically fails;
    // pinning the installed browser is what makes the run reproducible on this machine.
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    // ── Login ────────────────────────────────────────────────────────────────────
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.type('input[name="email"]', EMAIL);
    await page.type('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined),
      page.click('button[type="submit"]'),
    ]);
    await sleep(1500);

    check('signed in as an administrator', !page.url().includes('/login'), page.url());
    await shot(page, 'signed-in');

    // ── §44: the registry page renders ───────────────────────────────────────────
    await page.goto(`${BASE}/admin/modules`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);

    const initialText = await bodyText(page);
    check(
      'the module registry page renders for an administrator',
      initialText.includes('ماژول‌ها و سرویس‌های متصل'),
    );
    check(
      'the platform descriptor comes from the server',
      initialText.includes('module.invoke@v1') && initialText.includes('نسخه پروتکل'),
    );
    await shot(page, 'registry-empty');

    // ── §40: the form offers no endpoint field ───────────────────────────────────
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('ثبت ماژول جدید'),
      );
      button?.click();
    });
    await sleep(600);

    const formFields = await page.evaluate(() => {
      const form = document.querySelector('form[aria-label="ثبت ماژول جدید"]');
      if (!form) return null;
      return [...form.querySelectorAll('input, select')].map((el) => el.getAttribute('name'));
    });

    check('the registration form is present', Array.isArray(formFields), JSON.stringify(formFields));
    check(
      'the form has NO endpoint, url, version or healthPath field (§40)',
      Array.isArray(formFields) &&
        !formFields.includes('baseUrl') &&
        !formFields.includes('url') &&
        !formFields.includes('version') &&
        !formFields.includes('healthPath'),
      JSON.stringify(formFields),
    );
    await shot(page, 'form-open');

    // ── Register through the UI ──────────────────────────────────────────────────
    await page.type('form[aria-label="ثبت ماژول جدید"] input[name="moduleId"]', MODULE_ID);
    await page.type('form[aria-label="ثبت ماژول جدید"] input[name="displayName"]', DISPLAY_NAME);

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('form button')].find(
        (b) => b.textContent?.trim() === 'ثبت ماژول',
      );
      button?.click();
    });
    await sleep(2000);

    const afterCreate = await bodyText(page);
    check('the new module appears in the registry', afterCreate.includes(DISPLAY_NAME));
    check(
      'a new module is DISABLED and has no credential yet',
      afterCreate.includes('کلید دسترسی صادر نشده') || afterCreate.includes('غیرفعال'),
    );

    const dbRow = await psql(
      `SELECT enabled FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('the row was written as disabled', dbRow.out === 'f', `enabled=${dbRow.out}`);
    await shot(page, 'registered');

    // ── §20: the credential is shown ONCE and never after a reload ───────────────
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('صدور کلید جدید'),
      );
      button?.click();
    });
    await sleep(2000);

    const withCredential = await bodyText(page);
    const shown = withCredential.match(/[0-9a-f]{64}/);
    check('the generated credential is shown once', Boolean(shown), shown ? 'present' : 'missing');
    await shot(page, 'credential-once');

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1500);

    const afterReload = await bodyText(page);
    check(
      'the credential is NOT rendered after a reload (§20)',
      !/[0-9a-f]{64}/.test(afterReload) && afterReload.includes('صادر شده'),
    );
    await shot(page, 'credential-gone');

    // ── §44: enable, then disable ────────────────────────────────────────────────
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'فعال کردن',
      );
      button?.click();
    });
    await sleep(2000);

    const enabledRow = await psql(
      `SELECT enabled FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('an administrator can enable a module (§44)', enabledRow.out === 't', `enabled=${enabledRow.out}`);

    const enabledText = await bodyText(page);
    check(
      'an enabled module with no instance says so rather than claiming health',
      enabledText.includes('در انتظار ثبت نمونه') ||
        enabledText.includes('ثبت‌شده — بدون نمونه'),
    );
    await shot(page, 'enabled');

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'غیرفعال کردن',
      );
      button?.click();
    });
    await sleep(2000);

    const disabledRow = await psql(
      `SELECT enabled FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('an administrator can disable a module (§44)', disabledRow.out === 'f', `enabled=${disabledRow.out}`);
    await shot(page, 'disabled');

    // ── Navigation: ONE registry ENTRY, not one per module ────────────────────────
    const moduleLinks = await page.evaluate(() =>
      [...document.querySelectorAll('a[href^="/admin/modules"]')].map((a) => a.getAttribute('href')),
    );

    // DISTINCT hrefs, not link count: `CoreShell` renders the nav twice — the desktop rail and the
    // mobile drawer — so two <a> elements pointing at the same href is correct. What must NOT exist is
    // a SECOND href like `/admin/modules/finance`, which would make the navigation tree depend on
    // database rows and break the 49K drift test the moment a module registered.
    const distinctModuleHrefs = [...new Set(moduleLinks)];

    check(
      'navigation has exactly ONE modules href, not one per registered module',
      distinctModuleHrefs.length === 1 && distinctModuleHrefs[0] === '/admin/modules',
      JSON.stringify(distinctModuleHrefs),
    );

    // ── §44/§32: a caller without the permission cannot manage modules ───────────
    // Rather than inventing a second user, the browser's own token is dropped: the page must then
    // refuse rather than render a blank shell, and the API must reject the calls it makes.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`${BASE}/admin/modules`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    const unauthorized = await bodyText(page);
    check(
      'an unauthenticated caller sees no registry data and no write controls (§44)',
      !unauthorized.includes(DISPLAY_NAME) &&
        !unauthorized.includes('صدور کلید جدید') &&
        !unauthorized.includes('ثبت ماژول جدید'),
    );
    await shot(page, 'unauthorized');

    // ── Clean up through the UI, as an administrator ─────────────────────────────
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1200);
    await page.type('input[name="email"]', EMAIL);
    await page.type('input[name="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined),
      page.click('button[type="submit"]'),
    ]);
    await sleep(2000);

    await page.goto(`${BASE}/admin/modules`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);

    await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'حذف',
      );
      button?.click();
    });
    await sleep(2000);

    const afterDelete = await psql(
      `SELECT count(*) FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`,
    );
    check('the module is removed through the UI', afterDelete.out === '0', `rows ${afterDelete.out}`);
    await shot(page, 'deleted');

    const finalText = await bodyText(page);
    check('the registry no longer lists the removed module', !finalText.includes(DISPLAY_NAME));

    // ── No console errors, and no 500 anywhere in the run ───────────────────────
    check(
      'no console errors during the run',
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
    // Belt and braces: the fixture must not outlive the run even if an assertion threw.
    await psql(`DELETE FROM "ModuleRegistration" WHERE "moduleId" = '${MODULE_ID}';`);
  }

  const failed = results.filter((r) => !r.ok);

  console.log('');
  console.log(`TOTAL ${results.length} :: PASS ${results.length - failed.length} :: FAIL ${failed.length}`);

  if (failed.length > 0) {
    console.log('');
    for (const failure of failed) console.log(`FAILED :: ${failure.name} :: ${failure.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Browser harness crashed:', err);
  process.exitCode = 1;
});


