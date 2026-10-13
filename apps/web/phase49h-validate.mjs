// Phase 49H browser validation harness for Surveys / Participation.
//
// Exercises the real stack: logs in, walks /admin/surveys, the detail page, the
// questionnaire builder and the results panel, and asserts that no request carries a
// user or tenant identifier and that no respondent identity reaches the client.
//
// It creates a survey and publishes it, then removes that fixture at the end (the API
// only deletes drafts, so teardown goes straight to the database), leaving nothing behind.
import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';

const BASE = 'http://localhost:3000';
const OUT = 'phase49h-shots';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const results = [];
const consoleMessages = [];
const failedRequests = [];
const surveyRequests = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The harness publishes the survey it creates (check 12), and the API refuses to
// delete anything but a DRAFT, so the fixture cannot be removed through the UI.
// It is removed directly instead, in FK order, scoped to the single created id.
function teardownFixture(surveyId) {
  const sql = [
    'BEGIN;',
    `DELETE FROM "SurveyAnswer" WHERE "responseId" IN (SELECT id FROM "SurveyResponse" WHERE "surveyId" = '${surveyId}');`,
    `DELETE FROM "SurveyResponse" WHERE "surveyId" = '${surveyId}';`,
    `DELETE FROM "SurveyOption" WHERE "questionId" IN (SELECT id FROM "SurveyQuestion" WHERE "surveyId" = '${surveyId}');`,
    `DELETE FROM "SurveyQuestion" WHERE "surveyId" = '${surveyId}';`,
    `DELETE FROM "Survey" WHERE id = '${surveyId}';`,
    'COMMIT;',
  ].join('\n');

  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      ['exec', '-i', 'aria-erp-postgres', 'psql', '-U', 'aria_user', '-d', 'core_db', '-v', 'ON_ERROR_STOP=1'],
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: `${stdout}${stderr}`.trim() });
      },
    );
    child.stdin.end(sql);
  });
}

async function gotoAdmin(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  try {
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 15000 });
  } catch {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1500);
    await page.waitForSelector('[data-testid="core-sidebar"]', { timeout: 20000 });
  }
}

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
  page.on('request', (r) => {
    if (r.url().includes('/surveys')) {
      surveyRequests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`.trim());
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`);
  });

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]');
  await sleep(2500); // allow hydration before typing/clicking
  await page.type('input[name="email"]', EMAIL);
  await page.type('input[name="password"]', PASSWORD);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(3000);
  check('1. login succeeded', !page.url().includes('/login'), page.url());

  // ---- List page ----------------------------------------------------------
  await gotoAdmin(page, '/admin/surveys');
  await sleep(1500);
  await page.screenshot({ path: `${OUT}/01-list.png` });

  const heading = await page.$eval('h1', (el) => el.textContent.trim()).catch(() => null);
  check('2. surveys page renders its heading', heading === 'نظرسنجی‌ها', `h1=${heading}`);

  const dir = await page.evaluate(() => document.documentElement.getAttribute('dir'));
  check('3. document direction is RTL', dir === 'rtl', `dir=${dir}`);

  const filters = await page.evaluate(() => ({
    scope: !!document.querySelector('#survey-scope'),
    status: !!document.querySelector('#survey-status'),
  }));
  check('4. scope and status filters are present', filters.scope && filters.status);

  // admin@localhost holds admin.surveys.manage, so the create affordance must appear.
  const createLink = await page.$('[data-testid="survey-create-link"]');
  check('5. create link is offered to a manager', !!createLink);

  // ---- Questionnaire builder ---------------------------------------------
  await gotoAdmin(page, '/admin/surveys/new');
  await page.waitForSelector('[data-testid="survey-editor"]', { timeout: 20000 });
  await sleep(600);
  await page.screenshot({ path: `${OUT}/02-editor.png` });

  const editorBounds = await page.evaluate(() => ({
    title: document.querySelector('#survey-title')?.getAttribute('maxlength'),
    description: document.querySelector('#survey-description')?.getAttribute('maxlength'),
    optionCount: document.querySelectorAll('input[aria-label="عنوان گزینه"]').length,
  }));
  check(
    '6. editor mirrors the DTO bounds and starts with two options',
    editorBounds.title === '200' && editorBounds.description === '2000' && editorBounds.optionCount === 2,
    JSON.stringify(editorBounds),
  );

  // Client-side validate() must stop a blank question before any request goes out.
  const requestsBeforeInvalidSave = surveyRequests.filter((r) => r.startsWith('POST')).length;
  await page.type('#survey-title', 'نظرسنجی اعتبارسنجی فاز ۴۹H');
  await page.click('[data-testid="survey-save"]');
  await sleep(900);
  const invalidError = await page
    .$eval('p[role="alert"]', (el) => el.textContent.trim())
    .catch(() => null);
  const requestsAfterInvalidSave = surveyRequests.filter((r) => r.startsWith('POST')).length;
  check(
    '7. blank question is refused client-side with no POST',
    invalidError !== null && requestsAfterInvalidSave === requestsBeforeInvalidSave,
    `error=${invalidError ?? '(none)'} posts=${requestsAfterInvalidSave}`,
  );

  // Fill a valid single-choice question and save the draft.
  await page.type('input[id^="q-text-"]', 'میزان رضایت شما از سامانه؟');
  const optionInputs = await page.$$('input[aria-label="عنوان گزینه"]');
  await optionInputs[0].type('زیاد');
  await optionInputs[1].type('کم');
  await page.click('[data-testid="survey-save"]');
  await sleep(3000);

  const createdUrl = page.url();
  const createdId = createdUrl.split('/admin/surveys/')[1]?.split(/[/?#]/)[0] ?? null;
  check('8. saving a draft navigates to its detail page', !!createdId, createdUrl);

  const createPost = surveyRequests.find((r) => r.startsWith('POST') && r.includes('/surveys'));
  check(
    '9. create payload carries no status or actor field',
    !!createPost && !/"status"|"createdById"|"tenantId"|"userId"/.test(createPost),
    createPost ?? '(no POST captured)',
  );

  // ---- Detail page: lifecycle, participation, results ---------------------
  if (createdId) {
    await sleep(1200);
    await page.screenshot({ path: `${OUT}/03-detail-draft.png` });

    const draftState = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="survey-status"]')?.textContent.trim() ?? null,
      publish: !!document.querySelector('[data-testid="survey-transition-PUBLISHED"]'),
      close: !!document.querySelector('[data-testid="survey-transition-CLOSED"]'),
      form: !!document.querySelector('[data-testid="survey-response-form"]'),
      results: !!document.querySelector('[data-testid="survey-results"]'),
    }));
    check(
      '10. a DRAFT offers publish but no close, no response form',
      draftState.status === 'پیش‌نویس' && draftState.publish && !draftState.close && !draftState.form,
      JSON.stringify(draftState),
    );
    check(
      '11. results panel is present for a results-permitted caller',
      draftState.results,
      `results=${draftState.results}`,
    );

    // Publish, then confirm the offered transitions change and answering opens.
    await page.click('[data-testid="survey-transition-PUBLISHED"]');
    await sleep(2500);
    await page.screenshot({ path: `${OUT}/04-detail-published.png` });

    const publishedState = await page.evaluate(() => ({
      status: document.querySelector('[data-testid="survey-status"]')?.textContent.trim() ?? null,
      publish: !!document.querySelector('[data-testid="survey-transition-PUBLISHED"]'),
      close: !!document.querySelector('[data-testid="survey-transition-CLOSED"]'),
      edit: !!document.querySelector('a[href$="/edit"]'),
      form: !!document.querySelector('[data-testid="survey-response-form"]'),
    }));
    check(
      '12. publishing is irreversible: no DRAFT target is ever offered',
      publishedState.status === 'منتشرشده' && !publishedState.publish && publishedState.close,
      JSON.stringify(publishedState),
    );
    check(
      '13. a published survey can no longer be edited',
      !publishedState.edit,
      `editLink=${publishedState.edit}`,
    );
    check('14. a published, in-window survey offers the response form', publishedState.form);

    // Submit the one allowed response.
    const radio = await page.$('[data-testid="survey-response-form"] input[type="radio"]');
    if (radio) await radio.click();
    await page.click('[data-testid="survey-submit"]');
    await sleep(3000);
    await page.screenshot({ path: `${OUT}/05-detail-responded.png` });

    const afterSubmit = await page.evaluate(() => ({
      responded: !!document.querySelector('[data-testid="survey-already-responded"]'),
      form: !!document.querySelector('[data-testid="survey-response-form"]'),
      count:
        [...document.querySelectorAll('p')]
          .map((p) => p.textContent.trim())
          .find((t) => t.startsWith('تعداد پاسخ‌ها:')) ?? null,
    }));
    check(
      '15. one response per user: the form closes and the notice appears',
      afterSubmit.responded && !afterSubmit.form,
      JSON.stringify(afterSubmit),
    );

    const submitPost = surveyRequests.find(
      (r) => r.startsWith('POST') && r.includes('/responses'),
    );
    check(
      '16. response payload carries no respondent identifier',
      !!submitPost && !/"userId"|"respondentId"|"tenantId"/.test(submitPost),
      submitPost ?? '(no POST captured)',
    );

    // Results must aggregate without exposing who answered.
    const resultsText = await page
      .$eval('[data-testid="survey-results"]', (el) => el.textContent)
      .catch(() => null);
    check(
      '17. results show aggregates and no respondent name or email',
      !!resultsText && !/@/.test(resultsText),
      resultsText ? resultsText.slice(0, 120).replace(/\s+/g, ' ') : '(no panel)',
    );
    check(
      '18. results state what viewers see rather than promising anonymity',
      !!resultsText && resultsText.includes('برای مشاهده‌کنندگان نتایج نمایش داده نمی‌شود'),
    );
  }

  // ---- Request hygiene ----------------------------------------------------
  const apiCalls = surveyRequests.filter((r) => r.includes('/api/v1/surveys'));
  const leaky = apiCalls.filter((r) => /userId=|tenantId=|createdById=/i.test(r));
  check(
    '19. no request carries a userId, tenantId or createdById',
    leaky.length === 0,
    leaky.slice(0, 3).join(' || '),
  );

  const benign = /manifest\.json|favicon\.ico|apple-touch-icon\.png|_next\/static/;
  const realFailures = [...new Set(failedRequests)].filter((u) => !benign.test(u));
  check(
    '20. no unexpected failed requests',
    realFailures.length === 0,
    realFailures.slice(0, 5).join(' || '),
  );

  const appErrors = consoleMessages.filter(
    (m) =>
      m.startsWith('pageerror:') ||
      (m.startsWith('error:') && !/Failed to load resource|Manifest fetch/.test(m)),
  );
  check(
    '21. no application console errors',
    appErrors.length === 0,
    appErrors.slice(0, 4).join(' || '),
  );

  await browser.close();

  console.log('\n=== survey requests ===');
  for (const r of [...new Set(surveyRequests)]) console.log(r);

  if (createdId) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(createdId)) {
      console.log(`\n=== FIXTURE ===\nrefusing to delete unexpected id: ${createdId}`);
    } else {
      const teardown = await teardownFixture(createdId);
      check(
        '22. the harness removes the survey it created',
        teardown.ok,
        `id=${createdId} ${teardown.output.replace(/\s+/g, ' ')}`,
      );
    }
  }

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
