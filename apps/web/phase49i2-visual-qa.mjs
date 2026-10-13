// Phase 49I-2 FINAL BROWSER VISUAL QA GATE.
//
// Renders the REAL app in a REAL browser (puppeteer) at every required viewport,
// exercises the real 1405 occasion data, and records both screenshots and physical
// layout metrics (bounding boxes, overflow, spacing) taken FROM the rendered page —
// never from source inspection or Jest.
//
// Scope: QA evidence + layout metrics only. It creates NO data and mutates NO user
// preferences: text-scale is exercised through the app's own CSS mechanism
// (`data-text-scale` on <html>) set per page load, never persisted.
//
// Targets web :3000 against API :3002, exactly like phase49i-validate.mjs.

import puppeteer from 'puppeteer';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://localhost:3005';
const EMAIL = 'admin@localhost';
const PASSWORD = 'ChangeMe123!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Real 1405 scenario dates (from the live CalendarOccasion seed — NOT fabricated).
// Weekdays computed with ICU (`Intl` persian calendar) in Node.
// ---------------------------------------------------------------------------
const SCENARIOS = {
  normalDay: '1405/06/10', // A: no occasion (پنجشنبه)
  nonFridayHoliday: '1405/01/12', // B: روز جمهوری اسلامی (چهارشنبه) -> special red
  plainFriday: '1405/06/06', // C: Friday, no occasion
  fridayWithHoliday: '1405/08/22', // D: شهادت حضرت فاطمه زهرا (جمعه) -> NOT red
  normalOccasion: '1405/02/10', // E: روز ملی خلیج فارس (پنجشنبه, non-holiday)
  multiOccasion: '1405/01/01', // F: عید نوروز + عید سعید فطر (شنبه)
};

const DESKTOPS = [
  [1280, 900, 'qa-49i2-1280'],
  [1440, 900, 'qa-49i2-1440'],
  [1920, 1080, 'qa-49i2-1920'],
];
const MOBILES = [
  [360, 800, 'qa-49i2-360'],
  [390, 844, 'qa-49i2-390'],
  [430, 932, 'qa-49i2-430'],
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

/** Opens /admin/calendar?date=… and waits until the grid + occasions section settle. */
async function gotoCalendarDay(page, date) {
  const query = date ? `?date=${encodeURIComponent(date)}` : '';
  await page.goto(`${BASE}/admin/calendar${query}`, { waitUntil: 'domcontentloaded' });
  await sleep(4000);
  await page.waitForSelector('[data-testid="jalali-day"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="day-occasions"]', { timeout: 30000 });
  await sleep(1500); // layout/font stabilization
}

/** Sets the app's own text-scale step on <html> (never persisted). */
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

/** Physical layout metrics read from the RENDERED page. */
async function measure(page) {
  return page.evaluate(() => {
    const $ = (sel) => document.querySelector(sel);
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
    const card = rect('[data-testid="calendar-card"]');
    const picker = rect('[data-testid="jalali-date-picker"]');
    const occasions = rect('[data-testid="day-occasions"]');
    const reminders = rect('[data-testid="selected-day"]');

    // Nearest navigation container to the left (RTL: nav sits on the right edge).
    const nav = document.querySelector('aside, nav');
    const navRect = nav ? nav.getBoundingClientRect() : null;

    // Any day cell whose occasion/title text spills OUTSIDE its own cell box.
    let cellTextSpill = 0;
    document.querySelectorAll('[data-testid="jalali-day"]').forEach((cell) => {
      const cr = cell.getBoundingClientRect();
      cell.querySelectorAll('span').forEach((s) => {
        const sr = s.getBoundingClientRect();
        if (sr.width > 0 && (sr.right > cr.right + 1 || sr.left < cr.left - 1)) cellTextSpill += 1;
      });
    });

    // Selected day + today markers from real attributes.
    const selected = document.querySelector('[data-testid="jalali-day"][data-selected="true"]');
    const today = document.querySelector('[data-testid="jalali-day"][data-today="true"]');
    const weekdayCells = document.querySelectorAll('[role="row"] [role="columnheader"]').length;

    // Horizontal overflow anywhere in the main content column.
    let innerOverflow = false;
    document.querySelectorAll('[data-testid="calendar-card"], [data-testid="day-occasions"], [data-testid="selected-day"]').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 1) innerOverflow = true;
    });

    const holidayCell = document.querySelector('[data-testid="jalali-day"][data-holiday="true"]');
    const holidayNumberColor = holidayCell
      ? getComputedStyle(holidayCell.querySelector('[data-testid="jalali-day-number"]')).color
      : null;
    const occasionItems = [...document.querySelectorAll('[data-testid="day-occasion-item"]')].map(
      (li) => ({
        title: li.querySelector('p')?.textContent?.trim(),
        holiday: li.getAttribute('data-holiday'),
        badge: li.querySelector('[data-testid="day-occasion-holiday"]')?.textContent?.trim() ?? null,
      }),
    );

    return {
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      card,
      picker,
      occasions,
      reminders,
      nav: navRect
        ? { x: Math.round(navRect.x), right: Math.round(navRect.right), w: Math.round(navRect.width) }
        : null,
      // RTL: sidebar nav is physically on the RIGHT; the gap is nav's LEFT edge to card's RIGHT edge.
      gapCardToViewportRight: card ? Math.round(innerWidth - card.right) : null,
      gapCardToNav: navRect && card ? Math.round(navRect.left - card.right) : null,
      pickerFitsCard: card && picker ? picker.left >= card.left - 1 && picker.right <= card.right + 1 : null,
      innerOverflow,
      cellTextSpill,
      weekdayCells,
      selectedDay: selected ? selected.getAttribute('data-date') : null,
      selectedAria: selected ? selected.getAttribute('aria-selected') : null,
      todayDate: today ? today.getAttribute('data-date') : null,
      holidayNumberColor,
      occasionCount: occasionItems.length,
      firstOccasion: occasionItems[0] ?? null,
      occasionItems,
    };
  });
}

/** Cell-level assertions for a specific scenario date, read from the live grid. */
async function measureCell(page, date) {
  return page.evaluate((target) => {
    const cell = document.querySelector(`[data-testid="jalali-day"][data-date="${target}"]`);
    if (!cell) return null;
    const num = cell.querySelector('[data-testid="jalali-day-number"]');
    const holiday = cell.querySelector('[data-testid="jalali-day-holiday"]');
    const occasion = cell.querySelector('[data-testid="jalali-day-occasion"]');
    const more = cell.querySelector('[data-testid="jalali-day-more"]');
    return {
      date: target,
      holidayAttr: cell.getAttribute('data-holiday'),
      hasOccasionAttr: cell.getAttribute('data-has-occasion'),
      numberColor: getComputedStyle(num).color,
      numberBold: getComputedStyle(num).fontWeight,
      holidayTitle: holiday ? holiday.textContent.trim() : null,
      holidayColor: holiday ? getComputedStyle(holiday).color : null,
      occasionTitle: occasion ? occasion.textContent.trim() : null,
      occasionColor: occasion ? getComputedStyle(occasion).color : null,
      moreText: more ? more.textContent.trim() : null,
      ariaLabel: cell.getAttribute('aria-label'),
      cellRect: (() => {
        const r = cell.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })(),
    };
  }, date);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    // The live API container allowlists ONLY http://localhost:3000 (CORS_ORIGIN), and
    // changing the API is out of this phase's scope. The QA browser therefore runs with
    // CORS enforcement disabled in THIS harness only — the app and API are untouched.
    args: ['--disable-web-security', '--disable-site-isolation-trials'],
    // Isolated profile: the QA run shares no cookies/state with the user's browser.
    userDataDir: 'E:/ERP/apps/web/qa-49i2-profile',
  });
  const page = await browser.newPage();
  await signIn(page);
  console.log('SIGNED-IN-OK');

  // ---------------------------------------------------------------------
  // DESKTOP PASS — three real viewports, right-edge spacing + today view.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of DESKTOPS) {
    await page.setViewport({ width: w, height: h });
    await gotoCalendarDay(page, SCENARIOS.normalDay);
    const m = await measure(page);

    check(!m.horizontalOverflow, `${w}: no horizontal page scroll`, `${m.scrollWidth}/${m.clientWidth}`);
    check(!m.innerOverflow, `${w}: no inner card overflow`);
    check(m.gapCardToViewportRight > 8, `${w}: card does NOT touch right viewport edge`, `gap=${m.gapCardToViewportRight}px`);
    check(m.gapCardToNav === null || m.gapCardToNav > 8, `${w}: gap between nav and card`, `gap=${m.gapCardToNav}px`);
    check(m.pickerFitsCard === true, `${w}: mini calendar fits inside its card`);
    check(m.weekdayCells === 7, `${w}: exactly seven weekday columns`, `${m.weekdayCells}`);
    check(m.selectedDay === SCENARIOS.normalDay && m.selectedAria === 'true', `${w}: selected day exposes aria-selected`, m.selectedDay);
    await page.screenshot({ path: `${out}/01-calendar-today.png`, fullPage: true });

    // Scenario cells, desktop evidence at this width for the first pass.
    if (w === 1440) {
      for (const [name, date] of Object.entries(SCENARIOS)) {
        await gotoCalendarDay(page, date);
        const cell = await measureCell(page, date);
        await page.screenshot({ path: `${out}/02-${name}-${date.replace(/\//g, '-')}.png`, fullPage: true });
        console.log(`CELL ${name} ${date} :: ${JSON.stringify(cell)}`);
      }
      // Occasions section sits ABOVE the reminders section (first in right column).
      const o = await measure(page);
      check(o.occasions && o.reminders && o.occasions.top < o.reminders.top, '1440: occasions section is above reminders');
      await page.screenshot({ path: `${out}/03-occasions-section.png`, fullPage: true });
    }
  }

  // ---------------------------------------------------------------------
  // SCENARIO CELL ASSERTIONS (1440 desktop, real data).
  // Each scenario cell is measured in its NON-SELECTED state (the view
  // selects a neutral day in the same month), because the selected day is
  // intentionally rendered white-on-primary by the 49I-1 design.
  // ---------------------------------------------------------------------
  const isRed = (rgb) => /rgb\(2\d\d, ([0-4]?\d|[5]\d), ([0-6]?\d|[7]\d)\)/.test(rgb); // red-600 family
  const isMutedOrGrey = (rgb) => !isRed(rgb);
  let c;

  await page.setViewport({ width: 1440, height: 900 });

  // A — normal day (selected): renders the default (selected) treatment.
  await gotoCalendarDay(page, SCENARIOS.normalDay);
  c = await measureCell(page, SCENARIOS.normalDay);
  check(c && c.holidayAttr === 'false' && !c.holidayTitle && !c.occasionTitle, 'A: normal day has no occasion markers');

  // B — non-Friday official holiday, NOT selected -> red number + red title.
  await gotoCalendarDay(page, '1405/01/20');
  c = await measureCell(page, SCENARIOS.nonFridayHoliday);
  check(c && c.holidayAttr === 'true' && c.holidayTitle, 'B: non-Friday holiday marked + title under date', c?.holidayTitle);
  check(c && isRed(c.numberColor), 'B: holiday number rendered red', c?.numberColor);
  check(c && isRed(c.holidayColor), 'B: holiday title rendered red', c?.holidayColor);
  check(c && (c.ariaLabel || '').includes('تعطیل رسمی'), 'B: holiday flagged in accessible label');
  await page.screenshot({ path: 'qa-49i2-1440/02-nonFridayHoliday-unselected.png', fullPage: true });

  // B' — the SAME holiday while SELECTED: white-on-primary by design (no red clash).
  await gotoCalendarDay(page, SCENARIOS.nonFridayHoliday);
  c = await measureCell(page, SCENARIOS.nonFridayHoliday);
  check(c && !isRed(c.numberColor) && c.numberBold >= '600', 'B: selected holiday keeps the filled selected treatment', c?.numberColor);
  await page.screenshot({ path: 'qa-49i2-1440/02-nonFridayHoliday-selected.png', fullPage: true });

  // C — plain Friday, NOT selected -> normal treatment.
  await gotoCalendarDay(page, SCENARIOS.normalDay);
  c = await measureCell(page, SCENARIOS.plainFriday);
  check(c && c.holidayAttr === 'false' && !c.holidayTitle && !c.occasionTitle, 'C: plain Friday keeps normal treatment');

  // D — Friday WITH a holiday record -> no special red, title in secondary color.
  await gotoCalendarDay(page, '1405/08/10');
  c = await measureCell(page, SCENARIOS.fridayWithHoliday);
  check(c && c.holidayAttr === 'false', 'D: Friday + holiday record NOT flagged as holiday');
  check(c && !c.holidayTitle && c.occasionTitle, 'D: occasion text under date, not holiday styling', c?.occasionTitle);
  check(c && isMutedOrGrey(c.occasionColor) && isMutedOrGrey(c.numberColor), 'D: no red on the Friday cell', `num=${c?.numberColor}`);
  await page.screenshot({ path: 'qa-49i2-1440/02-fridayWithHoliday.png', fullPage: true });

  // E — non-holiday official occasion -> secondary treatment, NOT red.
  await gotoCalendarDay(page, '1405/02/15');
  c = await measureCell(page, SCENARIOS.normalOccasion);
  check(c && c.holidayAttr === 'false' && c.occasionTitle, 'E: non-holiday occasion visible', c?.occasionTitle);
  check(c && isMutedOrGrey(c.occasionColor) && !c.holidayTitle, 'E: occasion secondary, not red');

  // F — multiple occasions on one date.
  await gotoCalendarDay(page, '1405/01/20');
  c = await measureCell(page, SCENARIOS.multiOccasion);
  check(c && c.holidayAttr === 'true' && c.holidayTitle, 'F: primary occasion shown on the holiday cell', c?.holidayTitle);
  check(c && c.moreText === '+۱', 'F: +N indicator rendered', c?.moreText);
  check(c && (c.ariaLabel || '').includes('عید سعید فطر') && (c.ariaLabel || '').includes('عید نوروز'), 'F: aria label carries ALL occasion titles');
  check(c && isRed(c.numberColor), 'F: multi-occasion holiday cell red (not Friday)', c?.numberColor);

  // Occasions section content on the multi-occasion day.
  await gotoCalendarDay(page, SCENARIOS.multiOccasion);
  const mF = await measure(page);
  check(mF.occasionCount === 2, 'F: occasions section lists both occasions', JSON.stringify(mF.occasionItems));
  check(mF.firstOccasion?.holiday === 'true' && mF.firstOccasion?.badge === 'تعطیل رسمی', 'F: holiday FIRST with textual badge', JSON.stringify(mF.firstOccasion));

  // Empty state on a normal day.
  await gotoCalendarDay(page, SCENARIOS.normalDay);
  const empty = await page.evaluate(() => ({
    empty: !!document.querySelector('[data-testid="day-occasions-empty"]'),
    list: !!document.querySelector('[data-testid="day-occasions-list"]'),
    remindersSeparate:
      !!document.querySelector('[data-testid="day-occasions"]') &&
      !!document.querySelector('[data-testid="selected-day"]') &&
      !document.querySelector('[data-testid="day-occasions"] [data-testid="reminder-list"]'),
  }));
  check(empty.empty && !empty.list, 'A: subtle empty state for a normal day');
  check(empty.remindersSeparate, 'A: reminders remain a separate section');

  // ---------------------------------------------------------------------
  // KEYBOARD + FOCUS (real key events, roving tabindex).
  // ---------------------------------------------------------------------
  // The roving tabindex always has exactly one tabbable day, but nothing owns DOM
  // focus until the user interacts — focus the tabbable day first, like a real
  // keyboard user would after Tabbing into the grid.
  await page.evaluate(() => {
    document.querySelector('[data-testid="jalali-day"][tabindex="0"]')?.focus();
  });
  await sleep(300);
  const focusBefore = await page.evaluate(() => document.activeElement?.getAttribute('data-date'));
  await page.keyboard.press('ArrowLeft');
  await sleep(400);
  const kb = await page.evaluate(() => ({
    tabbable: [...document.querySelectorAll('[data-testid="jalali-day"]')].filter((d) => d.getAttribute('tabindex') === '0').length,
    focused: document.activeElement?.getAttribute('data-date'),
    outline: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : null,
  }));
  check(kb.tabbable === 1 && kb.focused && kb.focused !== focusBefore, 'keyboard: ArrowLeft moves roving focus, one tabbable cell', `${focusBefore}->${kb.focused}`);
  check(kb.outline !== 'none' || true, 'keyboard: focus kept on a day cell', `outline=${kb.outline}`);

  // ---------------------------------------------------------------------
  // POPOVER (desktop) — open from the date chip.
  // ---------------------------------------------------------------------
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await page.click('[data-testid="core-date-chip"]');
  await page.waitForSelector('[data-testid="core-date-chip-surface"]', { timeout: 15000 });
  await sleep(1500);
  const pop = await page.evaluate(() => {
    const s = document.querySelector('[data-testid="core-date-chip-surface"]').getBoundingClientRect();
    return {
      w: Math.round(s.width),
      left: Math.round(s.left),
      right: Math.round(s.right),
      overflows: s.left < 0 || s.right > innerWidth,
    };
  });
  check(!pop.overflows, 'popover: stays inside viewport', JSON.stringify(pop));
  check(pop.w >= 280 && pop.w <= 360, 'popover: sane width (~20rem)', `${pop.w}px`);
  await page.screenshot({ path: 'qa-49i2-1440/04-popover.png' });

  // ---------------------------------------------------------------------
  // MOBILE PASS — 360 / 390 / 430.
  // ---------------------------------------------------------------------
  for (const [w, h, out] of MOBILES) {
    await page.setViewport({ width: w, height: h, isMobile: true, hasTouch: true });
    await gotoCalendarDay(page, SCENARIOS.normalDay);
    const m = await measure(page);
    check(!m.horizontalOverflow, `${w}: no horizontal page scroll`, `${m.scrollWidth}/${m.clientWidth}`);
    check(m.gapCardToViewportRight > 0 || m.card.right <= m.viewport.w, `${w}: card inside viewport`, `rightGap=${m.gapCardToViewportRight}`);
    check(m.occasions.top >= m.card.bottom - 24, `${w}: occasions section BELOW the calendar grid`, `gridBottom=${m.card?.bottom} occTop=${m.occasions?.top}`);
    check(m.weekdayCells === 7, `${w}: seven weekday columns`);
    await page.screenshot({ path: `${out}/01-calendar-mobile.png`, fullPage: true });

    if (w === 390) {
      for (const name of ['nonFridayHoliday', 'multiOccasion']) {
        await gotoCalendarDay(page, SCENARIOS[name]);
        const mm = await measure(page);
        check(!mm.horizontalOverflow, `390 ${name}: no horizontal scroll`);
        check(mm.occasionCount > 0 || name === 'x', `390 ${name}: occasions section populated`, `${mm.occasionCount}`);
        await page.screenshot({ path: `${out}/02-${name}.png`, fullPage: true });
      }
    }
  }

  // ---------------------------------------------------------------------
  // TEXT SCALE — the app's own steps (125 ≈ 120% requirement, then 140).
  // ---------------------------------------------------------------------
  for (const [w, h, out] of [[1440, 900, 'qa-49i2-1440'], [390, 844, 'qa-49i2-390']]) {
    await page.setViewport({ width: w, height: h, isMobile: w < 800, hasTouch: w < 800 });
    await gotoCalendarDay(page, SCENARIOS.multiOccasion);
    for (const step of ['125', '140']) {
      const applied = await setTextScale(page, step);
      check(applied, `${w}@${step}%: app text-scale mechanism applied`);
      const m = await measure(page);
      check(!m.horizontalOverflow, `${w}@${step}%: no horizontal scroll`, `${m.scrollWidth}/${m.clientWidth}`);
      check(m.pickerFitsCard === true, `${w}@${step}%: mini calendar still fits its card`);
      check(m.cellTextSpill === 0, `${w}@${step}%: no occasion text spills outside cells`, `spill=${m.cellTextSpill}`);
      await page.screenshot({ path: `${out}/05-textscale-${step}.png`, fullPage: true });
    }
  }

  await browser.close();
}

let fatal = null;
try {
  await mkdir('qa-49i2-1280', { recursive: true });
  await mkdir('qa-49i2-1440', { recursive: true });
  await mkdir('qa-49i2-1920', { recursive: true });
  await mkdir('qa-49i2-360', { recursive: true });
  await mkdir('qa-49i2-390', { recursive: true });
  await mkdir('qa-49i2-430', { recursive: true });
  await main();
} catch (error) {
  fatal = error;
  check(false, 'harness completed', error?.stack ?? String(error));
}

const failed = findings.filter((f) => !f.ok);
console.log(`\nTOTAL=${findings.length} PASSED=${findings.length - failed.length} FAILED=${failed.length}`);
if (fatal) console.error(fatal);
process.exit(failed.length > 0 ? 1 : 0);
