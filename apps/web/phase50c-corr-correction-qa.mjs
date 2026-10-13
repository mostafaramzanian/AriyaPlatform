// Phase 50-CORRECTION browser QA: encoding + collapsible sidebar + authorization.
// Targets the ALREADY-RUNNING containers: web :3000 against API :3001.
import puppeteer from 'puppeteer';

const BASE = 'http://localhost:3000';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const findings = [];
const check = (ok, name, detail = '') => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} :: ${name}${detail ? ' :: ' + detail : ''}`);
};

async function signIn(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[type="submit"]', { timeout: 60000 });
  await sleep(5000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.click('input[name="email"]', { clickCount: 3 });
    await page.type('input[name="email"]', EMAIL);
    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await sleep(7000);
    if (!page.url().includes('/login')) return;
  }
  throw new Error('could not sign in after 3 attempts');
}

const run = async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  try {
    await signIn(page);
    console.log('signed in → ' + page.url());

    // ISSUE A: Persian text in correspondence pages.
    await page.goto(`${BASE}/admin/correspondence`, { waitUntil: 'domcontentloaded' });
    await sleep(4000);

    const text = await page.evaluate(() => document.body.textContent);
    const hasMojibake = /[ÃÂ]{1,}/.test(text);
    check(!hasMojibake, 'ISSUE A: page text has NO mojibake');

    check(
      text.includes('کارتابل') || text.includes('شما به این بخش'),
      'ISSUE A: Persian title renders correctly',
      text.includes('کارتابل') ? 'کارتابل' : 'unauthorized state (expected for no-tenant admin)',
    );

    // ISSUE B: collapsible sidebar parent (Phase 50-LOVABLE-PARITY).
    // The correspondence parent is a single toggle BUTTON spanning the row — clicking
    // it (anywhere) opens/closes the sub-tree; the chevron is a decorative icon inside.
    // The «کارتابل» child was removed: the sub-tree holds exactly the five Lovable
    // items and carries NO href to /admin/correspondence itself.
    await page.setViewport({ width: 1440, height: 900 });
    await sleep(1500);
    const sidebar = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      if (!rail) return { present: false };
      const toggle = [...rail.querySelectorAll('[data-testid="core-nav-toggle"]')].find((el) =>
        el.textContent?.includes('مکاتبات'),
      );
      const corrLinks = [...rail.querySelectorAll('a[href^="/admin/correspondence"]')].map((a) =>
        a.getAttribute('href'),
      );
      // ISSUE B6 guard: the parent row's label must hug the icon like every leaf. A
      // `<button>` computes `text-align: center` from the UA sheet, so without the
      // explicit `text-start` class the label floats MID-ROW while each leaf `<Link>`
      // stays start-aligned. Assert the real computed style, not the class list.
      const leaf = [...rail.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/admin');
      return {
        present: true,
        togglePresent: Boolean(toggle),
        toggleIsButton: toggle?.tagName === 'BUTTON',
        toggleType: toggle?.getAttribute('type'),
        ariaExpanded: toggle?.getAttribute('aria-expanded'),
        toggleTextAlign: toggle ? getComputedStyle(toggle).textAlign : null,
        leafTextAlign: leaf ? getComputedStyle(leaf).textAlign : null,
        corrLinks,
        hasCartableChild: corrLinks.includes('/admin/correspondence'),
      };
    });
    check(sidebar.present, 'ISSUE B: sidebar present');
    check(sidebar.togglePresent, 'ISSUE B: مکاتبات parent toggle found');
    check(
      sidebar.toggleIsButton && sidebar.toggleType === 'button',
      'ISSUE B: toggle is a real BUTTON (keyboard accessible)',
    );
    check(
      sidebar.ariaExpanded !== null,
      'ISSUE B: aria-expanded present',
      String(sidebar.ariaExpanded),
    );
    check(
      !sidebar.hasCartableChild,
      'ISSUE B2: cartable row removed from the sub-tree',
      String(sidebar.corrLinks.length),
    );
    check(
      sidebar.corrLinks.length === 5,
      'ISSUE B2: exactly the five Lovable child links exist',
      sidebar.corrLinks.join(', '),
    );
    check(
      sidebar.toggleTextAlign === 'start' && sidebar.toggleTextAlign === sidebar.leafTextAlign,
      'ISSUE B6: parent label is start-aligned like every leaf row (not centered)',
      `toggle=${sidebar.toggleTextAlign}, leaf=${sidebar.leafTextAlign}`,
    );

    // The parent must open by default when a child is active — and only the active
    // child carries the selected state (the parent toggle row itself does not).
    await page.goto(`${BASE}/admin/correspondence/drafts`, { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    const expandedState = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      const toggle = [...rail.querySelectorAll('[data-testid="core-nav-toggle"]')].find((el) =>
        el.textContent?.includes('مکاتبات'),
      );
      const toggleRow = toggle?.closest('[data-testid="core-nav-item"]');
      const activeRows = [
        ...rail.querySelectorAll('[data-testid="core-nav-item"][data-active="true"]'),
      ];
      const draftsLink = [...rail.querySelectorAll('a')].find(
        (a) => a.getAttribute('href') === '/admin/correspondence/drafts',
      );
      return {
        ariaExpanded: toggle?.getAttribute('aria-expanded'),
        childVisible: draftsLink ? Boolean(draftsLink.offsetParent) : false,
        parentActive: toggleRow?.getAttribute('data-active'),
        activeCount: activeRows.length,
        activeHrefs: activeRows.map(
          (row) => row.querySelector('a')?.getAttribute('href') ?? null,
        ),
      };
    });
    check(expandedState.ariaExpanded === 'true', 'ISSUE B3: parent stays expanded on child route', String(expandedState.ariaExpanded));
    check(expandedState.childVisible, 'ISSUE B3: active child visible');
    check(
      expandedState.activeCount === 1 &&
        expandedState.activeHrefs[0] === '/admin/correspondence/drafts' &&
        expandedState.parentActive === 'false',
      'ISSUE B4: ONLY the selected child row lights up (parent toggle is not)',
      JSON.stringify(expandedState),
    );

    // Clicking the PARENT ROW itself must toggle the sub-tree — no separate chevron.
    const clickToggle = async () => {
      await page.evaluate(() => {
        const rail = document.querySelector('[data-testid="core-sidebar"]');
        const toggle = [...rail.querySelectorAll('[data-testid="core-nav-toggle"]')].find((el) =>
          el.textContent?.includes('مکاتبات'),
        );
        toggle?.click();
      });
      await sleep(800);
    };
    await clickToggle();
    const collapsed = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      const toggle = [...rail.querySelectorAll('[data-testid="core-nav-toggle"]')].find((el) =>
        el.textContent?.includes('مکاتبات'),
      );
      return {
        ariaExpanded: toggle?.getAttribute('aria-expanded'),
        corrLinksAfter: [...rail.querySelectorAll('a[href^="/admin/correspondence"]')].map((a) =>
          a.getAttribute('href'),
        ),
      };
    });
    check(
      collapsed.ariaExpanded === 'false' && collapsed.corrLinksAfter.length === 0,
      'ISSUE B5: clicking the parent row collapses the sub-tree',
      JSON.stringify(collapsed),
    );
    await clickToggle();
    const reopened = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="core-sidebar"]');
      const toggle = [...rail.querySelectorAll('[data-testid="core-nav-toggle"]')].find((el) =>
        el.textContent?.includes('مکاتبات'),
      );
      const draftsLink = [...rail.querySelectorAll('a')].find(
        (a) => a.getAttribute('href') === '/admin/correspondence/drafts',
      );
      return {
        ariaExpanded: toggle?.getAttribute('aria-expanded'),
        childBack: draftsLink !== null && Boolean(draftsLink.offsetParent),
      };
    });
    check(
      reopened.ariaExpanded === 'true' && reopened.childBack,
      'ISSUE B5: clicking the parent row re-opens the sub-tree',
      JSON.stringify(reopened),
    );

    await page.screenshot({ path: 'p50-shots/corr-fix-1440.png' });

    // Viewport sweep for overflow.
    for (const [w, h] of [[360, 844], [390, 844], [430, 932], [1280, 900], [1440, 900], [1920, 1080]]) {
      await page.setViewport({ width: w, height: h });
      await sleep(1200);
      const overflow = await page.evaluate(() => {
        const doc = document.scrollingElement;
        return doc.scrollWidth > doc.clientWidth + 1;
      });
      check(!overflow, `viewport ${w}×${h} no horizontal overflow`);
    }
  } finally {
    await browser.close();
  }

  const failed = findings.filter((f) => !f.ok).length;
  console.log(`\nTOTAL: ${findings.length} checks, ${failed} failed`);
  if (failed > 0) process.exit(1);
};

run().catch((err) => {
  console.error('QA ERROR:', err);
  process.exit(1);
});
